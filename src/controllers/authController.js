import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../core/db/client.js';
import { locations } from '../core/db/schema.js';
import { encrypt } from '../core/middleware/encrypt.js';
import { setAuthCookie } from '../core/auth/jwt.js';
import { exchangeCodeForTokens } from '../services/ghlService.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

// CSRF for the login flow. This flow has no pre-existing session to bind to, so
// a bare signed nonce isn't enough (an attacker could mint one). We double-submit:
// a signed nonce in `state` must match an httpOnly nonce cookie set on the same
// browser at /auth — which an attacker cannot set on the victim.
const STATE_COOKIE = 'ghl_oauth_state';
const STATE_PURPOSE = 'ghl_oauth';
const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax', // sent on the top-level callback navigation, not cross-site subresources
  maxAge: 10 * 60 * 1000,
  path: '/',
};

/**
 * GET /auth
 * Redirect the browser to GHL's OAuth authorization page.
 */
export function redirectToGHL(req, res) {
  const nonce = crypto.randomUUID();
  const state = jwt.sign({ nonce, purpose: STATE_PURPOSE }, env.APP_JWT_SECRET, { expiresIn: '10m' });
  res.cookie(STATE_COOKIE, nonce, STATE_COOKIE_OPTIONS);

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: env.REDIRECT_URI,
    client_id: env.GHL_CLIENT_ID,
    scope: env.GHL_SCOPES,
    state,
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
    const { code, state, error } = req.query;

    if (error) throw createError(400, `GHL OAuth error: ${error}`);
    if (!code) throw createError(400, 'Missing authorization code');

    // CSRF check: the signed state nonce must match the cookie set at /auth on
    // this same browser. Blocks login-CSRF / cross-tenant session fixation.
    step = 'state_verify';
    const stateCookie = req.cookies?.[STATE_COOKIE];
    let stateOk = false;
    try {
      const decoded = jwt.verify(String(state ?? ''), env.APP_JWT_SECRET);
      stateOk = decoded.purpose === STATE_PURPOSE && !!decoded.nonce && decoded.nonce === stateCookie;
    } catch {
      stateOk = false;
    }
    if (!stateOk) throw createError(400, 'Invalid or expired OAuth state');
    res.clearCookie(STATE_COOKIE, { path: '/' });

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
      userId,
    } = tokenData;

    console.log('[auth/callback] Tokens received. locationId:', locationId, '| companyId:', companyId ?? 'none');

    if (!locationId) throw createError(502, 'GHL did not return a locationId');

    const expiresAt = new Date(Date.now() + expires_in * 1000);

    // Fetch the user's name from GHL
    step = 'fetch_user';
    let userName = null;
    let userEmail = null;
    if (userId) {
      try {
        const userRes = await fetch(`${env.GHL_BASE_URL}/users/${userId}`, {
          headers: {
            Authorization: `Bearer ${access_token}`,
            Version: env.GHL_DEFAULT_API_VERSION,
          },
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          const fullName = `${userData.firstName ?? ''} ${userData.lastName ?? ''}`.trim();
          userName = userData.name ?? (fullName || null);
          userEmail = userData.email ?? null;
        }
      } catch {
        // Non-fatal — fall back to showing locationId
      }
    }

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

    setAuthCookie(res, { locationId, companyId, userId, name: userName, email: userEmail });

    step = 'redirect';
    console.log('[auth/callback] Location saved, redirecting to GHL sub-account...');
    res.redirect(`https://app.gohighlevel.com/v2/location/${locationId}/dashboard`);
  } catch (err) {
    console.error(`[auth/callback] ERROR at step "${step}":`, err.message);
    console.error('[auth/callback] Stack:', err.stack);
    next(err);
  }
}
