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
  const res = await fetch(`${GHL_BASE}/oauth/token`, {
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
    throw createError(502, `GHL token exchange failed: ${body}`);
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
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(locations)
    .set({
      ghlAccessToken: encrypt(data.access_token),
      ghlRefreshToken: encrypt(data.refresh_token),
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

  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw createError(res.status, `GHL API error [${method} ${path}]: ${errBody}`);
  }

  return res.json();
}
