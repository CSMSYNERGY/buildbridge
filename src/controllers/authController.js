import { db } from '../core/db/client.js';
import { locations } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';
import { encrypt } from '../core/middleware/encrypt.js';
import { setAuthCookie } from '../core/auth/jwt.js';
import { exchangeCodeForTokens } from '../services/ghlService.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * GET /auth
 * Redirect the browser to GHL's OAuth authorization page.
 */
export function redirectToGHL(req, res) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: env.REDIRECT_URI,
    client_id: env.GHL_CLIENT_ID,
    scope: env.GHL_SCOPES,
  });

  res.redirect(`https://marketplace.gohighlevel.com/oauth/chooselocation?${params}`);
}

/**
 * GET /auth/callback
 * Exchange authorization code for tokens, upsert location, issue session cookie.
 */
export async function handleCallback(req, res, next) {
  try {
    const { code, error } = req.query;

    if (error) throw createError(400, `GHL OAuth error: ${error}`);
    if (!code) throw createError(400, 'Missing authorization code');

    const tokenData = await exchangeCodeForTokens(code);

    const {
      access_token,
      refresh_token,
      expires_in,
      locationId,
      companyId,
    } = tokenData;

    if (!locationId) throw createError(502, 'GHL did not return a locationId');

    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await db
      .insert(locations)
      .values({
        id: locationId,
        companyId: companyId ?? null,
        ghlAccessToken: encrypt(access_token),
        ghlRefreshToken: encrypt(refresh_token),
        ghlTokenExpiresAt: expiresAt,
      })
      .onConflictDoUpdate({
        target: locations.id,
        set: {
          companyId: companyId ?? null,
          ghlAccessToken: encrypt(access_token),
          ghlRefreshToken: encrypt(refresh_token),
          ghlTokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      });

    setAuthCookie(res, { locationId, companyId });

    res.redirect('/app');
  } catch (err) {
    next(err);
  }
}
