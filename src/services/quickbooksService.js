import { db } from '../core/db/client.js';
import { integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { encrypt, decrypt } from '../core/middleware/encrypt.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

const QUICKBOOKS_SLUG = 'quickbooks';

// Intuit OAuth2 endpoints are the same for sandbox and production; only the
// API base URL differs by environment.
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';

function apiBase() {
  return env.QBO_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/**
 * Throw a clear error if the Intuit app credentials are not configured.
 * QuickBooks env vars are optional so the app can boot without them.
 */
export function assertConfigured() {
  if (!env.INTUIT_CLIENT_ID || !env.INTUIT_CLIENT_SECRET || !env.QBO_REDIRECT_URI) {
    throw createError(
      503,
      'QuickBooks integration is not configured. Set INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET, and QBO_REDIRECT_URI.',
    );
  }
}

function basicAuthHeader() {
  const creds = `${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

/**
 * Build the Intuit OAuth2 authorization URL. `state` is echoed back on the
 * callback and is used to carry (and verify) the initiating locationId.
 */
export function getAuthorizeUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.INTUIT_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: env.QBO_REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Returns the raw token response from Intuit.
 */
export async function exchangeCodeForTokens(code) {
  assertConfigured();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.QBO_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw createError(502, `QuickBooks token exchange failed (HTTP ${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Persist QuickBooks credentials for a location as an encrypted JSON blob in
 * integration_credentials (appSlug='quickbooks'). No dedicated columns needed.
 */
export async function saveCredentials(locationId, { accessToken, refreshToken, realmId, expiresAt }) {
  const payload = JSON.stringify({
    accessToken,
    refreshToken,
    realmId,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
  });
  const encryptedPayload = encrypt(payload);

  const [row] = await db
    .insert(integrationCredentials)
    .values({
      id: randomUUID(),
      locationId,
      appSlug: QUICKBOOKS_SLUG,
      encryptedPayload,
    })
    .onConflictDoUpdate({
      target: [integrationCredentials.locationId, integrationCredentials.appSlug],
      set: { encryptedPayload, updatedAt: new Date() },
    })
    .returning();

  return row;
}

/**
 * Load decrypted QuickBooks credentials for a location, or null if not connected.
 */
export async function getCredentialsOrNull(locationId) {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.locationId, locationId),
        eq(integrationCredentials.appSlug, QUICKBOOKS_SLUG),
      ),
    )
    .limit(1);

  if (!row) return null;
  return JSON.parse(decrypt(row.encryptedPayload));
}

/**
 * Load decrypted QuickBooks credentials, throwing if the location is not connected.
 */
export async function getCredentials(locationId) {
  const creds = await getCredentialsOrNull(locationId);
  if (!creds) throw createError(400, 'QuickBooks is not connected for this location');
  return creds;
}

/**
 * Refresh the access token for a location using the stored refresh token.
 * Updates the stored blob (Intuit rotates refresh tokens) and returns the
 * refreshed credentials.
 */
export async function refreshAccessToken(locationId) {
  assertConfigured();
  const creds = await getCredentials(locationId);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw createError(502, `QuickBooks token refresh failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  const updated = {
    accessToken: data.access_token,
    // Intuit rotates refresh tokens; fall back to the existing one if absent.
    refreshToken: data.refresh_token ?? creds.refreshToken,
    realmId: creds.realmId,
    expiresAt,
  };

  await saveCredentials(locationId, updated);
  return updated;
}

/**
 * Best-effort revoke of the stored refresh token at Intuit. Non-fatal.
 */
export async function revokeToken(locationId) {
  const creds = await getCredentialsOrNull(locationId);
  if (!creds?.refreshToken) return;

  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: creds.refreshToken }),
    });
  } catch {
    // Non-fatal — the local credential row is deleted regardless.
  }
}

/**
 * Make an authenticated QuickBooks Online API request on behalf of a location.
 * Automatically refreshes the access token if it is expired or near expiry.
 *
 * @param {string} locationId
 * @param {string} method  - HTTP method
 * @param {string} path    - API path relative to the company, e.g. '/query?query=...'
 * @param {any}    [body]  - Request body (JSON-serialized)
 */
export async function makeQuickBooksRequest(locationId, method, path, body = undefined) {
  assertConfigured();
  let creds = await getCredentials(locationId);

  // Refresh if expired or within 60 seconds of expiry.
  const bufferMs = 60 * 1000;
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < bufferMs) {
    creds = await refreshAccessToken(locationId);
  }

  const url = `${apiBase()}/v3/company/${creds.realmId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw createError(res.status, `QuickBooks API error [${method} ${path}]: ${errBody}`);
  }

  return res.json();
}
