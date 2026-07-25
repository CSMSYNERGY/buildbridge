import { sql } from 'drizzle-orm';
import { db } from '../core/db/client.js';

// ─── Durable error log ────────────────────────────────────────────────────────
// Records every failure (backend, cron, webhook, and browser-side) into the
// error_events table so issues survive past a `wrangler tail` session and can be
// triaged later. See migrations/0004_error_events.sql.
//
// HARD RULES for everything in this file:
//   1. NEVER throw. Error logging must not turn a handled 500 into a crash, and
//      must not mask the original error.
//   2. NEVER recurse. This is guaranteed structurally: recordError catches its
//      OWN failures and reports them to console only, so a DB outage while
//      logging can never re-enter the logger. (Deliberately NOT a module-level
//      "in flight" boolean — that would also drop the second of two errors
//      happening concurrently, losing exactly the data this table exists for.)
//   3. NEVER persist secrets. Values are redacted before they reach the row.

// Field caps — an error log must never be the reason a query is huge.
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;
const MAX_CONTEXT_CHARS = 4000;

// Keys whose values are never stored, at any depth.
const SECRET_KEY_RE = /(token|secret|password|passwd|authorization|apikey|api_key|client_secret|refresh|bearer|cookie|signature|encryption|key)/i;
// Values that look like credentials even under an innocuous key.
const SECRET_VALUE_RE = /(eyJ[A-Za-z0-9_-]{10,}\.)|(sk-[A-Za-z0-9]{16,})|(Bearer\s+[A-Za-z0-9._-]{16,})/;

function truncate(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/** Deep-clone `value` dropping secret-looking keys/values. Depth- and size-bounded. */
function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[depth-limit]';

  if (typeof value === 'string') {
    return SECRET_VALUE_RE.test(value) ? '[redacted]' : truncate(value, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return undefined; // functions, symbols
}

// Strip the volatile parts of a message so the same underlying failure
// fingerprints identically across occurrences (ids, timestamps, uuids, numbers).
function normalizeForFingerprint(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<ts>')
    .replace(/\b[a-z0-9]{20,}\b/g, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
}

// Small, dependency-free stable hash (FNV-1a, hex). Only needs to be stable and
// well-distributed — not cryptographic.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function buildFingerprint(e) {
  return hash([
    e.source ?? '',
    e.kind ?? '',
    e.upstream ?? '',
    e.upstreamStatus ?? '',
    e.httpStatus ?? '',
    // Route pattern, not the concrete path: /contacts/abc123 → /contacts/<id>
    normalizeForFingerprint(e.path ?? ''),
    normalizeForFingerprint(e.message ?? ''),
  ].join('|'));
}

function randomId() {
  // crypto.randomUUID is available on Workers; keep a fallback for safety.
  try {
    return crypto.randomUUID();
  } catch {
    return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Record an error. Fire-and-forget: callers may await it, but failures here are
 * swallowed by design — see HARD RULES above.
 *
 * @param {object} e
 * @param {string} e.source          'backend' | 'frontend' | 'cron' | 'webhook'
 * @param {string} e.message         human-readable summary (required)
 * @param {string} [e.severity]      'warn' | 'error' | 'fatal' (default 'error')
 * @param {string} [e.kind]          short machine code, e.g. 'ghl_api_error'
 * @param {string} [e.locationId]    tenant
 * @param {string} [e.appSlug]       'quickbooks' | 'smartbuild' | ...
 * @param {number} [e.httpStatus]    status we returned
 * @param {string} [e.httpMethod]
 * @param {string} [e.path]
 * @param {string} [e.upstream]      'ghl' | 'qbo' | 'nmi' | 'smartbuild' | 'db'
 * @param {number} [e.upstreamStatus]
 * @param {string} [e.upstreamRef]   intuit_tid / upstream request id
 * @param {string} [e.stack]
 * @param {object} [e.context]       extra detail (redacted before storage)
 * @param {string} [e.userAgent]
 */
export async function recordError(e) {
  if (!e || !e.message) return;

  try {
    const fingerprint = buildFingerprint(e);
    let contextJson = null;
    if (e.context !== undefined && e.context !== null) {
      try {
        contextJson = truncate(JSON.stringify(redact(e.context)), MAX_CONTEXT_CHARS);
      } catch {
        contextJson = null; // unserializable (cycles) — not worth failing over
      }
    }

    // Upsert against the partial unique index over UNRESOLVED rows: a repeat of
    // an open issue bumps counters; a repeat of a RESOLVED one opens a new row.
    await db.execute(sql`
      INSERT INTO error_events (
        id, fingerprint, source, severity, location_id, app_slug, kind, message,
        http_status, http_method, path, upstream, upstream_status, upstream_ref,
        stack, context, user_agent
      ) VALUES (
        ${randomId()}, ${fingerprint}, ${e.source ?? 'backend'}, ${e.severity ?? 'error'},
        ${e.locationId ?? null}, ${e.appSlug ?? null}, ${e.kind ?? null},
        ${truncate(String(e.message), MAX_MESSAGE)},
        ${e.httpStatus ?? null}, ${e.httpMethod ?? null}, ${e.path ?? null},
        ${e.upstream ?? null}, ${e.upstreamStatus ?? null}, ${e.upstreamRef ?? null},
        ${e.stack ? truncate(String(e.stack), MAX_STACK) : null},
        ${contextJson}::jsonb, ${e.userAgent ? truncate(String(e.userAgent), 300) : null}
      )
      ON CONFLICT (fingerprint) WHERE resolved_at IS NULL DO UPDATE SET
        occurrence_count = error_events.occurrence_count + 1,
        last_seen_at     = now(),
        message          = EXCLUDED.message,
        severity         = EXCLUDED.severity,
        http_status      = COALESCE(EXCLUDED.http_status, error_events.http_status),
        upstream_status  = COALESCE(EXCLUDED.upstream_status, error_events.upstream_status),
        upstream_ref     = COALESCE(EXCLUDED.upstream_ref, error_events.upstream_ref),
        stack            = COALESCE(EXCLUDED.stack, error_events.stack),
        context          = COALESCE(EXCLUDED.context, error_events.context)
    `);
  } catch (logErr) {
    // Console only — this is rule 2's structural guarantee: the logger's own
    // failure is never fed back into the logger.
    console.error('[errorLog] failed to record error:', logErr?.message);
  }
}

/**
 * Convenience wrapper for a thrown Error/unknown value.
 * Pulls status/upstream metadata off the error when the throw site attached it
 * (see ghlService/quickbooksService, which set err.upstream/upstreamStatus/tid).
 */
export function recordThrown(err, extra = {}) {
  const message = err?.message ?? String(err ?? 'unknown error');
  return recordError({
    message,
    stack: err?.stack,
    kind: extra.kind ?? err?.kind,
    upstream: extra.upstream ?? err?.upstream,
    upstreamStatus: extra.upstreamStatus ?? err?.upstreamStatus,
    upstreamRef: extra.upstreamRef ?? err?.intuitTid ?? err?.tid,
    httpStatus: extra.httpStatus ?? err?.status,
    ...extra,
  });
}
