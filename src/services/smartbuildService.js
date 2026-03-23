import { db } from '../core/db/client.js';
import { integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../core/middleware/encrypt.js';
import { createError } from '../core/middleware/errorHandler.js';

const SMARTBUILD_SLUG = 'smartbuild';

/**
 * Load decrypted SmartBuild credentials for a location.
 */
export async function getCredentials(locationId) {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.locationId, locationId),
        eq(integrationCredentials.appSlug, SMARTBUILD_SLUG),
      ),
    )
    .limit(1);

  if (!row) throw createError(400, 'SmartBuild credentials not configured for this location');

  return JSON.parse(decrypt(row.encryptedPayload));
}

/**
 * Authenticate with SmartBuild and return a session token.
 */
export async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw createError(401, `SmartBuild login failed (${res.status}): ${body}`);
  }

  // API returns the token as a plain string
  return res.text();
}

/**
 * Make an authenticated request to the SmartBuild API.
 * Loads credentials from DB, logs in, then makes the request.
 *
 * @param {string} locationId
 * @param {string} method  - HTTP method
 * @param {string} path    - API path, e.g. '/GetJobData'
 * @param {object} [options]
 * @param {object} [options.query]  - Query string params
 * @param {any}    [options.body]   - Request body (will be JSON-serialized)
 */
export async function makeSmartBuildRequest(locationId, method, path, { query, body } = {}) {
  const { baseUrl, username, password } = await getCredentials(locationId);
  const token = await login(baseUrl, username, password);

  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw createError(res.status, `SmartBuild API error [${method} ${path}]: ${errBody}`);
  }

  return res.json();
}
