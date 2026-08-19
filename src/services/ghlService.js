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

// ─── Failure reason extraction ────────────────────────────────────────────────
// Pull the WHY out of a GHL error body without carrying customer data with it.
//
// GHL returns validation failures as {message: "..."} or {message: ["...", "..."]}. Those
// strings are about the request shape, which is what makes them worth keeping — but GHL
// will sometimes echo the offending value ("email must be an email: bob@x.com"), so every
// email address and long digit run is stripped before the text is allowed anywhere durable.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// 7+ consecutive digits, optionally separated — phone numbers and account numbers. Short
// runs are left alone so genuinely useful numbers (field limits, HTTP codes) survive.
const PHONEISH_RE = /\+?[\d][\d\s().-]{6,}\d/g;
const MAX_REASON = 300;

function summarizeGhlError(rawBody) {
  if (!rawBody) return null;
  let text;
  try {
    const parsed = JSON.parse(rawBody);
    const msg = parsed?.message ?? parsed?.error ?? parsed?.msg;
    text = Array.isArray(msg) ? msg.join('; ') : (typeof msg === 'string' ? msg : null);
    // Unrecognised JSON shape: keep the KEYS only. Enough to identify the shape next time,
    // and structurally incapable of leaking a value.
    if (!text && parsed && typeof parsed === 'object') text = `(keys: ${Object.keys(parsed).join(',')})`;
  } catch {
    text = null; // not JSON (an HTML error page, a gateway message) — do not store it
  }
  if (!text) return null;
  return text.replace(EMAIL_RE, '<email>').replace(PHONEISH_RE, '<number>').slice(0, MAX_REASON);
}

// GHL answers a rejected duplicate CREATE with the id of the contact it matched:
// {"message":"This location does not allow duplicated contacts.",
//  "meta":{"contactId":"…","matchingField":"phone"}}
// That id is the one thing that makes the rejection recoverable — it tells us the
// person is already in the CRM, so we can link to them instead of retrying a create
// that can never succeed. An id is an opaque handle, not customer data.
function duplicateContactIdFrom(rawBody) {
  if (!rawBody) return null;
  try {
    const meta = JSON.parse(rawBody)?.meta;
    const id = meta?.contactId ?? meta?.contactID ?? null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Make an authenticated GHL API request on behalf of a location.
 * Automatically refreshes the access token if it is expired.
 */
export async function makeGhlRequest(locationId, method, path, body = undefined) {
  // Counted before anything is sent, because the pair below — this credential read
  // and the fetch that follows — is what a scheduled run actually spends its
  // subrequest ceiling on. See core/subrequestBudget.js.
  spendSubrequest();
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
    const errBody = await res.text();
    // Never log the raw upstream body in production — it can carry customer data
    // (Intuit/GHL requirement: don't log QuickBooks/customer data). Status + path
    // only in prod; full body only in dev for debugging.
    if (env.NODE_ENV === 'production') {
      console.error(`[ghlService] GHL API error [${method} ${path}] HTTP ${res.status}`);
    } else {
      console.error(`[ghlService] GHL API error [${method} ${path}] HTTP ${res.status}:`, errBody);
    }
    // The REASON, scrubbed of customer data. Previously nothing about WHY a call failed
    // survived the throw, so a 400 repeating every 15 minutes was undebuggable from the
    // durable log — you got "GHL API request failed (400)" and a stack, with no path and no
    // cause (Rockwood's sync, 2026-07-29). A validation message describes the REQUEST shape
    // ("phone must be a valid phone number", "does not allow duplicated contacts"), which is
    // exactly what is needed and is not itself customer data — but GHL does sometimes echo
    // the offending value back, so it goes through the redactor first.
    const reason = summarizeGhlError(errBody);
    // Path and reason go in the MESSAGE, not just in metadata, for two reasons: they are
    // visible in any triage query without joining anything, and they participate in the
    // error_events fingerprint — so two genuinely different validation failures stop
    // collapsing into one row with a climbing count. The per-contact id in a path like
    // PUT /contacts/<24-char-id> is normalised to <id> by the fingerprinter's 20+ char rule,
    // so dedup across contacts still holds.
    const err = createError(
      res.status,
      `GHL API request failed (${res.status}) [${method} ${path}]${reason ? `: ${reason}` : ''}`,
    );
    err.upstream = 'ghl';
    err.upstreamStatus = res.status;
    err.kind = 'ghl_api_error';
    err.ghlPath = `${method} ${path}`;
    err.ghlReason = reason;
    err.ghlDuplicateContactId = duplicateContactIdFrom(errBody);
    throw err;
  }

  return res.json();
}
