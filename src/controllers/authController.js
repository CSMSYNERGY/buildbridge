import { db } from '../core/db/client.js';
import { locations } from '../core/db/schema.js';
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
  let step = 'init';
  try {
    const { code, error } = req.query;

    if (error) throw createError(400, `GHL OAuth error: ${error}`);
    if (!code) throw createError(400, 'Missing authorization code');

    console.log('[auth/callback] Received auth code:', String(code).slice(0, 8));

    step = 'token_exchange';
    console.log('[auth/callback] Exchanging code for tokens...');
    const tokenData = await exchangeCodeForTokens(code);

    const {
      access_token,
      refresh_token,
      expires_in,
      locationId,
      companyId,
    } = tokenData;

    console.log('[auth/callback] Tokens received. locationId:', locationId, '| companyId:', companyId ?? 'none');

    if (!locationId) throw createError(502, 'GHL did not return a locationId');

    const expiresAt = new Date(Date.now() + expires_in * 1000);

    step = 'db_save';
    console.log('[auth/callback] Tokens received, saving to database...');
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

    step = 'redirect';
    console.log('[auth/callback] Location saved, redirecting to app...');
    res.redirect('/buildbridge');
  } catch (err) {
    console.error(`[auth/callback] ERROR at step "${step}":`, err.message);
    console.error('[auth/callback] Stack:', err.stack);
    next(err);
  }
}
