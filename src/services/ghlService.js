import { db } from '../core/db/client.js';
import { locations } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '../core/middleware/encrypt.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

const GHL_BASE = env.GHL_BASE_URL;
const API_VERSION = env.GHL_DEFAULT_API_VERSION;

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Returns the raw token response from GHL.
 */
export async function exchangeCodeForTokens(code) {
  const tokenUrl = `${GHL_BASE}/oauth/token`;
  console.log('[ghlService] exchangeCodeForTokens — POST', tokenUrl);
  console.log('[ghlService] client_id:', env.GHL_CLIENT_ID);
  console.log('[ghlService] redirect_uri:', env.REDIRECT_URI);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GHL_CLIENT_ID,
      client_secret: env.GHL_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[ghlService] GHL token exchange failed — HTTP', res.status);
    console.error('[ghlService] GHL error response body:', body);
    throw createError(502, `GHL token exchange failed (HTTP ${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Refresh the access token for a location using the stored encrypted refresh token.
 * Updates the locations table with the new tokens and returns the new access token.
 */
export async function refreshAccessToken(locationId) {
  const [loc] = await db
    .select({
      ghlRefreshToken: locations.ghlRefreshToken,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);

  if (!loc?.ghlRefreshToken) {
    throw createError(400, `No refresh token found for location ${locationId}`);
  }

  const refreshToken = decrypt(loc.ghlRefreshToken);

  const res = await fetch(`${GHL_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GHL_CLIENT_ID,
      client_secret: env.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw createError(502, `GHL token refresh failed: ${body}`);
  }

  const data = await res.json();
  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await db
    .update(locations)
    .set({
      ghlAccessToken: encrypt(data.access_token),
      // GHL rotates refresh tokens; keep the existing (already-encrypted) one if
      // none is returned, so we never encrypt(undefined) and crash.
      ghlRefreshToken: data.refresh_token ? encrypt(data.refresh_token) : loc.ghlRefreshToken,
      ghlTokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(locations.id, locationId));

  return data.access_token;
}

/**
 * Make an authenticated GHL API request on behalf of a location.
 * Automatically refreshes the access token if it is expired.
 */
export async function makeGhlRequest(locationId, method, path, body = undefined) {
  const [loc] = await db
    .select({
      ghlAccessToken: locations.ghlAccessToken,
      ghlTokenExpiresAt: locations.ghlTokenExpiresAt,
    })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);

  if (!loc?.ghlAccessToken) {
    throw createError(400, `No access token found for location ${locationId}`);
  }

  // Refresh if expired or within 60 seconds of expiry
  let accessToken;
  const bufferMs = 60 * 1000;
  if (!loc.ghlTokenExpiresAt || loc.ghlTokenExpiresAt.getTime() - Date.now() < bufferMs) {
    accessToken = await refreshAccessToken(locationId);
  } else {
    accessToken = decrypt(loc.ghlAccessToken);
  }

  const url = `${GHL_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Version: API_VERSION,
    'Content-Type': 'application/json',
  };

  let res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // A 401 can mean the token was revoked/rotated out-of-band — refresh once and retry.
  if (res.status === 401) {
    const newToken = await refreshAccessToken(locationId).catch(() => null);
    if (newToken) {
      res = await fetch(url, {
        method,
        headers: { ...headers, Authorization: `Bearer ${newToken}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }
  }

  if (!res.ok) {
    // Keep the upstream body server-side only; don't leak it to API clients.
    const errBody = await res.text();
    console.error(`[ghlService] GHL API error [${method} ${path}] HTTP ${res.status}:`, errBody);
    throw createError(res.status, `GHL API request failed (${res.status})`);
  }

  return res.json();
}
