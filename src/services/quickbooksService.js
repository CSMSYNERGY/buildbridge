import { db } from '../core/db/client.js';
import { integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { encrypt, decrypt } from '../core/middleware/encrypt.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';
import { ensureLocation } from './locationService.js';
import { summarizeQboFault, collectTxnCustomFieldNames } from './qbSyncLogic.js';

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
//
// VERIFIED 2026-07-26: the BuildBridge app's Permissions page offers ONLY
// `com.intuit.quickbooks.accounting` and `com.intuit.quickbooks.payment` — the
// App Foundations scope is not selectable, so it cannot be granted today and the
// GraphQL call 403s. It is therefore requested ONLY when
// QBO_ENABLE_CUSTOM_FIELDS_API is on, so the working Connect flow never carries a
// scope Intuit does not recognize for this app.
const BASE_SCOPE = 'com.intuit.quickbooks.accounting';
const CUSTOM_FIELDS_SCOPE = 'app-foundations.custom-field-definitions.read';
const SCOPE = env.QBO_ENABLE_CUSTOM_FIELDS_API
  ? `${BASE_SCOPE} ${CUSTOM_FIELDS_SCOPE}`
  : BASE_SCOPE;

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

// Stored failures carry a machine tag so we know WHAT a later success actually disproves.
// Internal only — describeCredentialFailure in the controller maps to plain language and
// the raw text never reaches a browser.
const ERR_REFRESH = 'refresh'; // Intuit rejected our refresh token
const ERR_API = 'api';         // Intuit rejected an API call made with a valid-looking token

/** Does a successful token refresh disprove this stored error? Only a refresh error. */
function refreshClears(lastError) {
  return typeof lastError === 'string' && lastError.startsWith(`${ERR_REFRESH}:`);
}

/**
 * Persist QuickBooks credentials for a location as an encrypted JSON blob in
 * integration_credentials (appSlug='quickbooks'). No dedicated columns needed.
 *
 * Health stamping (0006) rides along here because this row is already being written, so
 * the happy path costs ZERO extra queries — which matters when every query is main worker
 * → DB_WORKER → sql-exec → Postgres at ~2.5s.
 *
 * `verified` is the load-bearing argument, and it is FALSE for the OAuth callback. That
 * callback writes the row before a single QuickBooks API call has been attempted, so
 * stamping last_ok_at there would make the card say "verified just now" about a connection
 * that may not be able to read anything at all — a new, quieter version of the same lie.
 * A token REFRESH is a real Intuit round-trip, so it does count.
 */
export async function saveCredentials(
  locationId,
  { accessToken, refreshToken, realmId, expiresAt },
  { verified = false, clearError = true } = {},
) {
  const payload = JSON.stringify({
    accessToken,
    refreshToken,
    realmId,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
  });
  const encryptedPayload = encrypt(payload);
  const now = new Date();

  // integration_credentials.location_id is FK → locations.id. The Intuit callback is
  // its own top-level request (no SSO ran in it), so for a tenant that only ever
  // arrived via SSO the row may still be missing — which used to surface as a bare
  // 500 on /auth/quickbooks/callback. Belt-and-braces with the SSO-side guarantee.
  await ensureLocation(locationId);

  const [row] = await db
    .insert(integrationCredentials)
    .values({
      id: randomUUID(),
      locationId,
      appSlug: QUICKBOOKS_SLUG,
      encryptedPayload,
      lastOkAt: verified ? now : null,
    })
    .onConflictDoUpdate({
      target: [integrationCredentials.locationId, integrationCredentials.appSlug],
      set: {
        encryptedPayload,
        updatedAt: now,
        ...(verified ? { lastOkAt: now } : {}),
        // Conditional, NOT unconditional. Clearing on every refresh meant a 403 that a
        // refresh cannot possibly fix (a scope problem, revoked API access) showed red for
        // at most an hour and then flipped back to green on the next hourly refresh — so
        // "green" would have degraded to meaning "Intuit's token endpoint accepted us",
        // which is not the question the card claims to answer.
        ...(clearError ? { lastError: null, lastErrorAt: null } : {}),
      },
    })
    .returning();

  return row;
}

/**
 * Store the connected QuickBooks company's name, e.g. "Rockwood Sheds LLC".
 *
 * NEVER THROWS — the name is a nicety; failing to save it must not break a connect flow or
 * a connection test that otherwise succeeded.
 *
 * Only writes when the value actually changes, so the routine "still the same company"
 * case costs nothing. That matters because callers sit on paths that run often, and every
 * query is ~2.5s through DB_WORKER → sql-exec.
 */
export async function setCredentialDisplayName(locationId, name, current = undefined) {
  const clean = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null;
  if (!clean) return;                       // never overwrite a good name with nothing
  if (current !== undefined && current === clean) return;
  try {
    await db
      .update(integrationCredentials)
      .set({ displayName: clean })
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, QUICKBOOKS_SLUG),
        ),
      );
  } catch (err) {
    console.error('[quickbooksService] could not record company name:', err?.message);
  }
}

/**
 * Record PROOF the credential works (a successful QuickBooks API call), clearing any
 * recorded failure.
 *
 * NEVER THROWS — same rule as markCredentialBroken. A bookkeeping failure must not turn a
 * request that actually SUCCEEDED into an error for the caller.
 */
export async function markCredentialVerified(locationId) {
  try {
    await db
      .update(integrationCredentials)
      .set({ lastError: null, lastErrorAt: null, lastOkAt: new Date() })
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, QUICKBOOKS_SLUG),
        ),
      );
  } catch (err) {
    console.error('[quickbooksService] could not record credential health:', err?.message);
  }
}

// How stale `last_ok_at` may get before an ordinary successful call refreshes it.
//
// This is the compromise that keeps "verified N minutes ago" honest WITHOUT paying a write
// on every request (each query is ~2.5s through DB_WORKER → sql-exec). A location with
// steady traffic writes at most twice an hour; an idle one is refreshed by the hourly token
// refresh. Writing on every success would be unaffordable; writing only when an error
// needed clearing — the first version of this — left a healthy-but-never-probed connection
// stuck on "not verified yet" permanently, including right after a successful Test.
const VERIFY_TTL_MS = 30 * 60 * 1000;

function verifyStale(lastOkAt) {
  if (!lastOkAt) return true;
  const t = new Date(lastOkAt).getTime();
  return Number.isNaN(t) || Date.now() - t > VERIFY_TTL_MS;
}

// How much of a failure message is worth keeping. Long enough to identify the cause
// (`invalid_grant`, `Incorrect or invalid refresh token`), short enough that the column
// never becomes a dumping ground.
const MAX_HEALTH_ERROR = 400;

/**
 * Mark this location's QuickBooks credential as failing, for the UI.
 *
 * NEVER THROWS. Health recording is observability — if it fails it must not convert an
 * already-failing QuickBooks call into a second, different error, and must not mask the
 * original cause. Same rule as errorLogService, for the same reason.
 *
 * Note this is the ONLY write on the unhappy path; the happy path rides along with
 * saveCredentials. Failures are rare, so one extra query is affordable here.
 */
export async function markCredentialBroken(locationId, kind, message) {
  try {
    await db
      .update(integrationCredentials)
      .set({
        lastError: `${kind}: ${String(message ?? 'unknown error')}`.slice(0, MAX_HEALTH_ERROR),
        lastErrorAt: new Date(),
        // lastOkAt deliberately NOT cleared — "last worked at 09:31, broke at 10:14" is
        // far more useful for diagnosis than just "broken".
      })
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, QUICKBOOKS_SLUG),
        ),
      );
  } catch (err) {
    console.error('[quickbooksService] could not record credential health:', err?.message);
  }
}

/**
 * Load the credential ROW plus decrypted blob: { creds, health } — or null if the
 * location has never connected.
 *
 * Exists because "is there a row?" and "does the credential work?" are different
 * questions, and the config endpoint needs both. Conflating them is precisely the bug
 * this pair of functions was added to fix.
 */
export async function getCredentialRecord(locationId) {
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
  return {
    creds: JSON.parse(decrypt(row.encryptedPayload)),
    // The QuickBooks company name (0007). Sits alongside health rather than inside `creds`
    // because it is a plain column, not part of the encrypted blob — see the schema comment.
    displayName: row.displayName ?? null,
    health: {
      lastOkAt: row.lastOkAt ?? null,
      lastError: row.lastError ?? null,
      lastErrorAt: row.lastErrorAt ?? null,
      connectedAt: row.createdAt ?? null,
    },
  };
}

/**
 * Load decrypted QuickBooks credentials for a location, or null if not connected.
 */
export async function getCredentialsOrNull(locationId) {
  const record = await getCredentialRecord(locationId);
  return record ? record.creds : null;
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
  // The RECORD, not just the creds: the stored error's tag decides whether this refresh
  // succeeding is allowed to clear it. Costs nothing — this read already happened.
  const record = await getCredentialRecord(locationId);
  if (!record) throw createError(400, 'QuickBooks is not connected for this location');
  const { creds, health } = record;

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
    // A rejected refresh is TERMINAL — Intuit will not accept this refresh token again,
    // so the connection is dead until a human re-authorizes. This is the exact failure
    // that ran silently for 20+ hours behind a green "Connected" badge on 2026-07-28.
    // Recorded WITHOUT the intuit_tid: that id is per-request, so including it would make
    // the stored text churn on every retry for no diagnostic gain (the tid is already in
    // error_events, and see errorLogService's fingerprint normaliser for the same trap).
    await markCredentialBroken(locationId, ERR_REFRESH, `Token refresh rejected by Intuit (HTTP ${res.status}): ${body}`);
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

  // verified: a refresh IS a real Intuit round-trip, so it proves the refresh leg works.
  // clearError: only if the stored failure was itself a refresh rejection. An API-level
  // rejection (403 scope, revoked API access) survives, because nothing here disproves it.
  await saveCredentials(locationId, updated, {
    verified: true,
    clearError: refreshClears(health?.lastError),
  });
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
 * Resolve credentials, refreshing the access token if expired or near expiry.
 *
 * Returns { creds, needsHealthWrite } — computed from the row we ALREADY read, so the
 * success path can decide whether health needs updating without a second query.
 */
async function getFreshCredentials(locationId) {
  const record = await getCredentialRecord(locationId);
  if (!record) throw createError(400, 'QuickBooks is not connected for this location');
  let creds = record.creds;
  // True when there is an error to clear, OR when `last_ok_at` is missing/stale. Both mean
  // "a success here is worth persisting"; anything else means the row is already accurate.
  const needsHealthWrite = !!record.health?.lastError || verifyStale(record.health?.lastOkAt);
  const bufferMs = 60 * 1000;
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < bufferMs) {
    creds = await refreshAccessToken(locationId);
  }
  return { creds, needsHealthWrite };
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
  // Gated off by default: without the App Foundations scope (not grantable on this
  // Intuit app today) every call is a guaranteed 403, which would add a wasted
  // round-trip and an error log line to every mapper page load.
  if (!env.QBO_ENABLE_CUSTOM_FIELDS_API) return [];

  assertConfigured();
  const { creds } = await getFreshCredentials(locationId);

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
    //
    // DELIBERATELY does NOT call markCredentialBroken, unlike makeQuickBooksRequest: this
    // endpoint 403s for a scope/tier reason on connections that are otherwise perfectly
    // healthy (which is why QBO_ENABLE_CUSTOM_FIELDS_API is off by default). Recording it
    // as credential death would paint working connections red on every mapper page load.
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
 * Custom-field NAMES discovered from the company's own recent transactions.
 *
 * This exists because neither definition source works on a real company: REST
 * `Preferences` carries only the three legacy sales-form slots, and the modern
 * Custom fields manager needs the App Foundations scope, which 403s behind a paid
 * Intuit tier. So the picker came back empty and the mapping could never be
 * configured — "the custom field is not popping up".
 *
 * The values, though, ride along on the documents themselves. Rockwood's estimate
 * carries `Rep` (= "Cody", marked hidden), `Siding Color`, `Trim Color` and
 * `Roofing Color`. Reading their own estimates and invoices therefore tells us
 * exactly which fields the company uses, needs no scope beyond what the sync
 * already has, and works for legacy and modern fields alike.
 *
 * Never throws: a failure here must degrade the picker, not break the page.
 *
 * @returns {Promise<Array<{name:string, definitionId:string|null, seenOn:string[]}>>}
 */
export async function getRecentSalesDocs(locationId, sample = 50) {
  assertConfigured();
  const n = Math.min(Math.max(Number(sample) || 50, 1), 100);
  // `include=enhancedAllCustomFields` is the whole ballgame. Without it the response
  // carries ONLY the three legacy sales-form slots — and Intuit maps those
  // immutably, so they come back even when marked inactive, which is exactly the
  // misleading result we got on Rockwood ("SIDING COLOR -1 (inactive)",
  // "TRIM COLOR (inactive)") while the four fields on their actual form stayed
  // invisible. With it, the modern ("enhanced") fields are returned too — including
  // List/dropdown ones, which legacy slots cannot even represent.
  // Ref: Intuit docs, "API response not showing existing custom field".
  //
  // Newest first, because the rep we want is whatever the latest document says.
  const q = (entity) =>
    makeQuickBooksRequest(
      locationId,
      'GET',
      `/query?minorversion=75&include=enhancedAllCustomFields&query=${encodeURIComponent(
        `select * from ${entity} orderby MetaData.LastUpdatedTime desc maxresults ${n}`,
      )}`,
    )
      .then((d) => d?.QueryResponse?.[entity] ?? [])
      .catch((err) => {
        console.error(`[quickbooksService] ${entity} enhanced-field read failed:`, err?.message);
        return [];
      });

  const [estimates, invoices] = await Promise.all([q('Estimate'), q('Invoice')]);
  return { estimates, invoices };
}

/** Field NAMES present on recent documents. Thin wrapper — see getRecentSalesDocs. */
export async function getTransactionCustomFieldNames(locationId, sample = 50) {
  const { estimates, invoices } = await getRecentSalesDocs(locationId, sample);
  return collectTxnCustomFieldNames(estimates, invoices);
}

/**
 * Enable one of the three LEGACY sales-form custom fields by sparse-updating the
 * Preferences entity (SalesFormsPrefs.CustomField: SalesCustomName<slot> +
 * UseSalesCustom<slot>).
 *
 * Why: QBO's UI no longer offers legacy sales-form custom fields on companies
 * migrated to the unified Custom fields manager, and the modern fields are
 * invisible to the REST API without the App Foundations scope (tier-gated,
 * $300/mo — see docs/ + work log 2026-07-26). The legacy REST WRITE path was
 * never documented as removed; if Intuit still honors it, the field appears on
 * sales forms and flows through Estimate/Invoice.CustomField on every plan with
 * no extra scope — which is exactly what the salesperson mapping needs.
 *
 * Intuit's docs show two spellings of the entry names ("SalesFormsPrefs.
 * UseSalesCustom1" vs bare "UseSalesCustom1"), so both are attempted; the
 * SyncToken is re-read between attempts (Preferences updates are optimistic-
 * locked). Throws with both upstream messages if neither shape is accepted —
 * the caller surfaces that verbatim, which IS the experiment's result.
 */
export async function enableLegacySalesCustomField(locationId, fieldName, slot = 1) {
  assertConfigured();
  if (!fieldName || typeof fieldName !== 'string') {
    throw createError(400, 'fieldName is required');
  }
  if (![1, 2, 3].includes(slot)) throw createError(400, 'slot must be 1, 2, or 3');

  let prefs = await makeQuickBooksRequest(locationId, 'GET', '/preferences');
  let p = prefs?.Preferences;
  if (!p?.Id) throw createError(502, 'Could not read QuickBooks preferences');

  const entriesFor = (variant) => {
    const prefix = variant === 'prefixed' ? 'SalesFormsPrefs.' : '';
    return [
      { Name: `${prefix}SalesCustomName${slot}`, Type: 'StringType', StringValue: fieldName },
      { Name: `${prefix}UseSalesCustom${slot}`, Type: 'BooleanType', BooleanValue: true },
    ];
  };

  const errors = [];
  for (const variant of ['prefixed', 'bare']) {
    const body = {
      Id: p.Id,
      SyncToken: p.SyncToken,
      sparse: true,
      SalesFormsPrefs: { CustomField: [{ CustomField: entriesFor(variant) }] },
    };
    try {
      const res = await makeQuickBooksRequest(locationId, 'POST', '/preferences', body);
      return { variant, preferences: res?.Preferences ?? null };
    } catch (err) {
      errors.push(`${variant}: ${err.message}`);
      // Refresh the SyncToken — a failed optimistic update may still consume it.
      try {
        prefs = await makeQuickBooksRequest(locationId, 'GET', '/preferences');
        p = prefs?.Preferences ?? p;
      } catch { /* keep the stale token; next attempt will report accurately */ }
    }
  }
  throw createError(
    502,
    `QuickBooks rejected the legacy custom-field update — ${errors.join(' || ')}`,
  );
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
  const { creds, needsHealthWrite } = await getFreshCredentials(locationId);

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
    // The RAW response body can contain QuickBooks company data → logged only in dev.
    // What survives into the durable log is summarizeQboFault's scrubbed code+Message+
    // Detail — without it a 400 was undiagnosable in production (only status +
    // intuit_tid reached error_events, and Intuit's Fault names the offending field).
    const errBody = await res.text().catch(() => '');
    if (env.NODE_ENV !== 'production') {
      console.error(`[quickbooksService] QBO error body [${method} ${path}]:`, errBody);
    }
    const reason = summarizeQboFault(errBody);
    // Auth-shaped failures mean the credential itself is no longer accepted, so they
    // belong on the connection card. Everything else (a 400 validation error, a 429, a
    // 5xx at Intuit) is a per-request problem and must NOT mark a working connection
    // broken — that would flap the badge red on any bad payload we send.
    if (res.status === 401 || res.status === 403) {
      await markCredentialBroken(locationId, ERR_API, `QuickBooks rejected the stored credential (HTTP ${res.status}) on ${method} ${path.split('?')[0]}`);
    }
    // The fault reason goes in the MESSAGE, not just metadata — same reasoning as
    // ghlService: visible in any triage query, and it participates in the
    // error_events fingerprint so two different validation failures stop
    // collapsing into one row. Numeric fault codes normalise to <n>, so dedup
    // across occurrences of the SAME fault still holds.
    const err = createError(res.status, `QuickBooks API error (${res.status}) [${method} ${path}]${reason ? `: ${reason}` : ''} intuit_tid=${tid || 'none'}`);
    // Metadata for the durable error log (errorLogService.recordThrown). The
    // intuit_tid is what Intuit support asks for, so it rides along explicitly.
    err.upstream = 'qbo';
    err.upstreamStatus = res.status;
    err.kind = 'qbo_api_error';
    err.intuitTid = tid || null;
    err.qboFault = reason;
    throw err;
  }

  // A successful API call is the STRONGEST proof available — stronger than a refresh, which
  // only shows Intuit's token endpoint accepted us. So this is the one place allowed to
  // clear an API-level failure, and the one that keeps "verified" meaningful.
  //
  // Gated so the steady state costs zero extra queries: a write happens only when there is
  // an error to clear or last_ok_at has gone stale (see VERIFY_TTL_MS). Await it rather
  // than firing and forgetting — on Workers an un-awaited promise can be cut off when the
  // response returns, which would drop the write silently and leave a working connection
  // reading "not verified yet" forever.
  if (needsHealthWrite) await markCredentialVerified(locationId);

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
 * The connected company's display name, e.g. "Rockwood Sheds LLC".
 *
 * Doubles as the cheapest possible liveness probe: CompanyInfo always exists, is tiny,
 * and goes through makeQuickBooksRequest — so it exercises the stored token (refreshing
 * it if near expiry) and therefore updates credential health as a side effect.
 *
 * Deliberately used INSTEAD of forcing a token refresh to test the connection: Intuit
 * rotates refresh tokens, so a probe that always refreshed would invalidate the previous
 * token on every click — the same mechanic that broke these two locations in the first
 * place when one company was connected twice.
 */
export async function getCompanyName(locationId) {
  const q = await queryQuickBooks(locationId, 'SELECT * FROM CompanyInfo');
  const info = (q.CompanyInfo ?? [])[0];
  return info?.CompanyName ?? info?.LegalName ?? null;
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
export async function findOrCreateCustomer(locationId, { name, firstName, lastName, email, phone, billAddr }) {
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
    ...(billAddr ? { BillAddr: billAddr } : {}),
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
        // ⚠️ ItemRef "1" is NOT guaranteed to exist — QBO item ids are per-company
        // (Rockwood has none, and this exact fallback 400'd its estimate sync,
        // 2026-07-31). Kept here only because the milestone-invoice flow's tenants
        // haven't hit it; prefer the tenant's mapper (appSlug 'quickbooks', type
        // 'qb_item') resolved to `itemRef` before the call, like upsertEstimate
        // now requires.
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
  qbEstimateId, syncToken, qbCustomerId, amountCents, description, itemRef, customFields,
}) {
  // No fallback item: the old `itemRef || '1'` guessed at the client's chart of
  // items, and any company without an item Id 1 rejects the write with
  // [2500] Invalid Reference Id (Rockwood, 2026-07-31). The caller resolves the
  // item from the tenant's mapping (or the estimate's existing line) and skips
  // the record when it can't — nothing arbitrary may be billed into a client's
  // books from here.
  if (!itemRef) throw createError(400, 'itemRef is required — no QuickBooks item to bill');
  const amount = Math.round(amountCents) / 100;
  const body = {
    ...(qbEstimateId ? { Id: String(qbEstimateId), SyncToken: String(syncToken), sparse: true } : {}),
    CustomerRef: { value: String(qbCustomerId) },
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: description ?? undefined,
        SalesItemLineDetail: { ItemRef: { value: String(itemRef) } },
      },
    ],
    // Legacy sales-form custom fields — today this carries the salesperson (0008).
    // OMITTED entirely when empty rather than sent as []: on a sparse update an
    // empty array would blank whatever the document already had, which is exactly
    // the field a location that hasn't configured this feature still fills in by
    // hand inside QuickBooks. The caller merges before passing (mergeQboCustomFields).
    ...(Array.isArray(customFields) && customFields.length ? { CustomField: customFields } : {}),
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
