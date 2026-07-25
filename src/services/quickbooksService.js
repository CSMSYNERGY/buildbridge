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
// `com.intuit.quickbooks.accounting` — the REST v3 API (customers, estimates, invoices).
// `app-foundations.custom-field-definitions.read` — REQUIRED to read the modern
//   "Custom fields" definitions (QBO Settings → Custom fields) over the App
//   Foundations GraphQL API. The legacy REST Preferences payload only exposes the
//   first three STRING *sales-form* custom fields, so Customer-associated fields and
//   fields 4-10 are invisible without this scope.
// The Intuit app must ALSO have this scope enabled in the developer portal, and an
// already-connected company must re-authorize before its token carries it.
const SCOPE = 'com.intuit.quickbooks.accounting app-foundations.custom-field-definitions.read';

// App Foundations GraphQL endpoint. PRODUCTION ONLY — Intuit does not expose this
// API in sandbox, so custom-field definitions simply come back empty there (the
// caller degrades to the legacy Preferences list rather than failing).
const GRAPHQL_URL = 'https://qb.api.intuit.com/graphql';

// Read query, matching Intuit's own sample app (IntuitDeveloper/Sampleapp-Customfields-Nodejs).
// Only the fields we actually consume are requested.
const CUSTOM_FIELD_DEFINITIONS_QUERY = `
query GetCustomFieldDefinitions {
  appFoundationsCustomFieldDefinitions {
    edges {
      node {
        id
        legacyIDV2
        label
        dataType
        active
        associations {
          associatedEntity
          active
        }
      }
    }
  }
}`;

function apiBase() {
  if (env.QBO_API_BASE_URL) return env.QBO_API_BASE_URL; // explicit override (testing/mocks)
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
 * Capture + log the Intuit transaction id (`intuit_tid`) from a QBO / OAuth response.
 * Intuit's go-live requirements mandate logging this id for every response so it can be
 * handed to Intuit support when troubleshooting. It carries NO QuickBooks company data, so
 * it is safe to log in ALL environments (unlike response bodies, which stay dev-only).
 * Returns the tid so callers can also attach it to thrown errors.
 */
function captureTid(context, res) {
  let tid = '';
  try { tid = res.headers.get('intuit_tid') || ''; } catch { /* headers unavailable */ }
  const line = `[quickbooksService] ${context} → HTTP ${res.status} intuit_tid=${tid || 'none'}`;
  if (res.ok) console.log(line); else console.error(line);
  return tid;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() to Intuit with automatic retry of TRANSIENT failures — Intuit's go-live
 * requirement to retry failed authorization/authentication/API requests. Retries only on a
 * thrown network error or HTTP 429/500/502/503/504, with exponential backoff (honoring
 * Retry-After, capped). Non-retryable 4xx (400/401/403 = bad grant/credentials) are NOT
 * retried — a retry can't fix them. Bounded (maxRetries) with small, capped waits so the
 * whole call stays within the Worker's ~20s request budget; on persistent failure it
 * returns the last response so the caller throws with the intuit_tid attached.
 */
async function fetchIntuit(context, url, options, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      const wait = Math.min(500 * 2 ** attempt, 4000);
      console.warn(`[quickbooksService] ${context} network error — retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${e.message}`);
      await sleep(wait);
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const ra = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(500 * 2 ** attempt, 4000);
      console.warn(`[quickbooksService] ${context} → HTTP ${res.status} — retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Returns the raw token response from Intuit.
 */
export async function exchangeCodeForTokens(code) {
  assertConfigured();

  const res = await fetchIntuit('OAuth token exchange', TOKEN_URL, {
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

  const tid = captureTid('OAuth token exchange', res);
  if (!res.ok) {
    const body = await res.text();
    throw createError(502, `QuickBooks token exchange failed (HTTP ${res.status}, intuit_tid=${tid || 'none'}): ${body}`);
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

  const res = await fetchIntuit('OAuth token refresh', TOKEN_URL, {
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

  const tid = captureTid('OAuth token refresh', res);
  if (!res.ok) {
    const body = await res.text();
    throw createError(502, `QuickBooks token refresh failed (HTTP ${res.status}, intuit_tid=${tid || 'none'}): ${body}`);
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

/** Resolve credentials, refreshing the access token if expired or near expiry. */
async function getFreshCredentials(locationId) {
  let creds = await getCredentials(locationId);
  const bufferMs = 60 * 1000;
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < bufferMs) {
    creds = await refreshAccessToken(locationId);
  }
  return creds;
}

/**
 * Read the company's modern custom-field DEFINITIONS via the App Foundations
 * GraphQL API (QBO Settings → Custom fields).
 *
 * Why this exists: the REST Preferences payload only carries the first three STRING
 * *sales-form* custom fields, so anything created in the newer Custom fields manager
 * — including Customer-associated fields, which is what the QuickBooks→Synergy
 * salesperson mapping needs — is invisible to REST.
 *
 * Returns [] instead of throwing when the API is unavailable for this company
 * (sandbox, non-Advanced tier, or the scope not yet granted). Callers merge the
 * result with the legacy list, so an empty return simply means "nothing extra".
 *
 * @param {string} locationId
 * @returns {Promise<Array<{id:string,name:string,dataType:string,entities:string[],legacyId:string|null}>>}
 */
export async function getCustomFieldDefinitions(locationId) {
  assertConfigured();
  const creds = await getFreshCredentials(locationId);

  const res = await fetchIntuit('QBO GraphQL customFieldDefinitions', GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // Required by App Foundations — the realm is NOT in the URL for GraphQL.
      'intuit-realm-id': creds.realmId,
    },
    body: JSON.stringify({ query: CUSTOM_FIELD_DEFINITIONS_QUERY }),
  });

  const tid = captureTid('QBO GraphQL customFieldDefinitions', res);

  if (!res.ok) {
    // 401/403 here almost always means the token predates the
    // app-foundations.custom-field-definitions.read scope (company must
    // re-authorize) or the company is not on a tier that exposes the API.
    console.error(
      `[quickbooksService] custom-field definitions unavailable (HTTP ${res.status}, intuit_tid=${tid || 'none'}) — token may predate the app-foundations scope, or the tier does not expose this API`,
    );
    return [];
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error('[quickbooksService] custom-field definitions: non-JSON response');
    return [];
  }

  // GraphQL reports failures in a 200 with an `errors` array.
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    // Messages describe schema/authz problems, not company data — safe to log.
    console.error(
      '[quickbooksService] custom-field definitions GraphQL errors:',
      payload.errors.map((e) => e?.message).filter(Boolean).join(' | ').slice(0, 500),
    );
    return [];
  }

  const edges = payload?.data?.appFoundationsCustomFieldDefinitions?.edges ?? [];
  return edges
    .map((e) => e?.node)
    .filter((n) => n && n.active !== false && n.label)
    .map((n) => ({
      id: n.label,                 // keyed by label: entity CustomField[].Name matches the label
      name: n.label,
      dataType: n.dataType ?? null,
      legacyId: n.legacyIDV2 ?? null,
      entities: (n.associations ?? [])
        .filter((a) => a && a.active !== false && a.associatedEntity)
        .map((a) => a.associatedEntity),
    }));
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
  const creds = await getFreshCredentials(locationId);

  const url = `${apiBase()}/v3/company/${creds.realmId}${path}`;
  const res = await fetchIntuit(`QBO ${method} ${path}`, url, {
    method,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // Log the Intuit transaction id for EVERY response (success + error), in all envs —
  // Intuit's go-live troubleshooting requirement. It carries no QuickBooks company data.
  const tid = captureTid(`QBO ${method} ${path}`, res);

  if (!res.ok) {
    // The response BODY can contain QuickBooks company data → logged only in dev. The
    // intuit_tid + status are already logged above (prod-safe) and are attached to the
    // thrown error so downstream handlers keep the troubleshooting id.
    if (env.NODE_ENV !== 'production') {
      const errBody = await res.text();
      console.error(`[quickbooksService] QBO error body [${method} ${path}]:`, errBody);
    }
    const err = createError(res.status, `QuickBooks API error (${res.status}) [${method} ${path}] intuit_tid=${tid || 'none'}`);
    // Metadata for the durable error log (errorLogService.recordThrown). The
    // intuit_tid is what Intuit support asks for, so it rides along explicitly.
    err.upstream = 'qbo';
    err.upstreamStatus = res.status;
    err.kind = 'qbo_api_error';
    err.intuitTid = tid || null;
    throw err;
  }

  return res.json();
}

// ─── Entity helpers ───────────────────────────────────────────────────────────

/**
 * Run a QBO SQL-ish query, e.g. "SELECT * FROM Customer WHERE ...".
 * Returns the QueryResponse object.
 */
export async function queryQuickBooks(locationId, query) {
  const data = await makeQuickBooksRequest(
    locationId,
    'GET',
    `/query?query=${encodeURIComponent(query)}&minorversion=75`,
  );
  return data.QueryResponse ?? {};
}

/**
 * List the connected company's active Items (Products & Services), for the
 * item-mapper dropdown. Yoder Barnes has <30 items, so a single page (1000 max)
 * is plenty. Returns [{ id, name, type, unitPrice, description }].
 */
export async function listItems(locationId) {
  const q = await queryQuickBooks(
    locationId,
    'SELECT * FROM Item WHERE Active = true MAXRESULTS 1000',
  );
  const items = q.Item ?? [];
  return items.map((it) => ({
    id: String(it.Id),
    name: it.Name ?? it.FullyQualifiedName ?? String(it.Id),
    type: it.Type ?? null,
    unitPrice: typeof it.UnitPrice === 'number' ? it.UnitPrice : null,
    description: it.Description ?? null,
  }));
}

/** Escape a single-quoted string literal for a QBO query. */
function qboEscape(value) {
  // Escape backslashes first (so the escape char itself is neutralized), then quotes.
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Find a QBO Customer by email (then by display name), creating one if absent.
 * Returns the Customer object.
 */
export async function findOrCreateCustomer(locationId, { name, firstName, lastName, email, phone }) {
  if (!name && !email) throw createError(400, 'Customer name or email is required');

  if (email) {
    const byEmail = await queryQuickBooks(
      locationId,
      `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${qboEscape(email)}' MAXRESULTS 1`,
    );
    if (byEmail.Customer?.length) return byEmail.Customer[0];
  }

  if (name) {
    const byName = await queryQuickBooks(
      locationId,
      `SELECT * FROM Customer WHERE DisplayName = '${qboEscape(name)}' MAXRESULTS 1`,
    );
    if (byName.Customer?.length) return byName.Customer[0];
  }

  const created = await makeQuickBooksRequest(locationId, 'POST', '/customer?minorversion=75', {
    DisplayName: name ?? email,
    ...(firstName ? { GivenName: firstName } : {}),
    ...(lastName ? { FamilyName: lastName } : {}),
    ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(phone ? { PrimaryPhone: { FreeFormNumber: phone } } : {}),
  });
  return created.Customer;
}

/**
 * Create a QBO Invoice for a customer with a single line item.
 * amountCents is an integer; description labels the line.
 */
export async function createInvoice(locationId, { qbCustomerId, amountCents, description, dueDate, itemRef }) {
  if (!qbCustomerId) throw createError(400, 'qbCustomerId is required');
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw createError(400, 'amountCents must be a positive number');
  }

  const amount = Math.round(amountCents) / 100;
  const body = {
    CustomerRef: { value: String(qbCustomerId) },
    ...(dueDate ? { DueDate: dueDate } : {}),
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: description ?? undefined,
        // ItemRef "1" is QBO's default Services item; the caller can override it
        // with the tenant's real item via a mapper (appSlug 'quickbooks', type
        // 'qb_item') — resolved to `itemRef` before the call.
        SalesItemLineDetail: { ItemRef: { value: String(itemRef || '1') } },
      },
    ],
  };

  const created = await makeQuickBooksRequest(locationId, 'POST', '/invoice?minorversion=75', body);
  return created.Invoice;
}

/**
 * Create or update a QBO Estimate with a single line item.
 * Pass qbEstimateId + syncToken to update (QBO requires sparse update with SyncToken).
 */
export async function upsertEstimate(locationId, {
  qbEstimateId, syncToken, qbCustomerId, amountCents, description, itemRef,
}) {
  const amount = Math.round(amountCents) / 100;
  const body = {
    ...(qbEstimateId ? { Id: String(qbEstimateId), SyncToken: String(syncToken), sparse: true } : {}),
    CustomerRef: { value: String(qbCustomerId) },
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: description ?? undefined,
        SalesItemLineDetail: { ItemRef: { value: String(itemRef || '1') } },
      },
    ],
  };

  const result = await makeQuickBooksRequest(locationId, 'POST', '/estimate?minorversion=75', body);
  return result.Estimate;
}

/**
 * Change Data Capture — entities changed in QBO since `changedSince` (Date).
 * entityList e.g. ['Customer', 'Estimate']. Returns the raw CDC response.
 */
export async function getChangedEntities(locationId, entityList, changedSince) {
  const entities = entityList.join(',');
  const since = (changedSince instanceof Date ? changedSince : new Date(changedSince)).toISOString();
  return makeQuickBooksRequest(
    locationId,
    'GET',
    `/cdc?entities=${encodeURIComponent(entities)}&changedSince=${encodeURIComponent(since)}&minorversion=75`,
  );
}
