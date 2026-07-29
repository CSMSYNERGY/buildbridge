import { sql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import {
  issueClass,
  isIssueCurrent,
  summarizeIssue,
  CLASS_RANK,
} from './issueClassifier.js';

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
    // Named trace ids we embed in messages ourselves. These are per-REQUEST, so leaving
    // them in defeats the whole point of the fingerprint: QuickBooks' refresh failure
    // wrote a NEW error_events row every 15 minutes (8 rows in two hours, ~96/day)
    // instead of incrementing one. Collapsed by name so this covers any trace id we add,
    // and so it can't accidentally match ordinary prose.
    .replace(/\b(intuit_tid|request_?id|trace_?id|correlation_?id|x-request-id)=[^\s,;)\]}]+/gi, '$1=<id>')
    // Multi-segment hex ids (e.g. Intuit's 1-6a69037e-76009f15…). The <id> rule below
    // needs a single 20+ char run, so a hyphenated id slips past it and then `\d+`
    // mangles each segment into a DIFFERENT shape per occurrence — which is exactly how
    // the QuickBooks rows escaped dedup. Requires 4+ hex chars per segment and 2+
    // segments, so real words and dotted versions are untouched.
    .replace(/\b[0-9a-f]{4,}(?:-[0-9a-f]{4,})+\b/g, '<id>')
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
 * CURRENT problems for one location's app, summarized for the tenant UI.
 *
 * Returns `{ issues, totalDistinct }` — the second value lets the caller say "5 of 7 shown"
 * instead of truncating in silence.
 *
 * Currency is decided by issueClassifier.isIssueCurrent, which is import-free and unit-tested
 * because it is the thing standing between a tenant and never learning their invoices stopped.
 *
 * WHY READ error_events RATHER THAN ADD PER-FAILURE INSTRUMENTATION: this table already
 * captures every failure kind durably, deduplicated, with counts and timestamps. Credential
 * health answers "is the token good?" — this answers "is the integration actually working?",
 * which is a strictly larger question. On 2026-07-29 Rockwood's QuickBooks token was
 * refreshing perfectly while its sync was failing 28 times on a GoHighLevel 400; a status
 * built only on token health would have shown a confident green check for it.
 *
 * Never throws — callers render a status page, and a failure to LIST problems must not
 * become a problem of its own.
 */
export async function listOpenIssues(locationId, appSlug, limit = 5, opts = {}) {
  if (!locationId) return { issues: [], totalDistinct: 0 };
  const { lastOkAt = null, lastSyncAt = null } = opts;
  try {
    // Pull a generous window, then decide currency in JS — the "is this still happening?"
    // rule has three parts and belongs in one readable, testable place rather than smeared
    // across a WHERE clause. `message` is selected only to pick a truthful summary; it is
    // never returned to the caller.
    const rows = await db.execute(sql`
      SELECT kind, upstream, upstream_status, occurrence_count, first_seen_at, last_seen_at, message
      FROM error_events
      WHERE location_id = ${locationId}
        AND resolved_at IS NULL
        AND (app_slug = ${appSlug} OR upstream = 'qbo')
        AND last_seen_at > now() - interval '24 hours'
      ORDER BY last_seen_at DESC
      LIMIT 50
    `);

    // db.execute shape differs between drivers (rows vs array); tolerate both rather
    // than couple this to one of them.
    const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);

    // ── Is this problem CURRENT? ──────────────────────────────────────────────
    // The card answers "is something wrong right now", so a problem that has stopped
    // happening must drop off it. Before this, the only filter was `resolved_at IS NULL`,
    // which meant a tenant who fixed their connection still saw yesterday's failures listed
    // as live problems — reported 2026-07-29 after a reconnect, with five stale entries
    // (0.4h to 24h old) still on the card.
    //
    // Each class needs its own proof of recovery. In particular, note what is NOT used as a
    // blanket all-clear: `last_ok_at` only proves the credential works, and it is stamped by
    // any successful call — including a read, and including the tenant pressing "Test
    // connection", which is their natural reaction to seeing a problem. Letting it clear
    // everything would mean the button that investigates a problem is the button that hides it.
    const now = Date.now();
    const current = list.filter((r) => isIssueCurrent(r, { now, lastOkAt, lastSyncAt }));

    // Keyed on the summary CODE, not the rendered sentence. Keying on prose would make
    // editing a sentence silently change which problems merge, and would fuse two genuinely
    // different failures the moment their wording happened to match.
    const byCode = new Map();
    for (const r of current) {
      const { code, text } = summarizeIssue(r);
      const seen = new Date(r.last_seen_at).getTime();
      const prev = byCode.get(code);
      if (!prev) {
        byCode.set(code, {
          // Machine codes for support. A merged line carries ALL of them: reporting one
          // arbitrary code would send support to investigate the wrong failure, and a
          // plausible-but-wrong code is worse than none because it gets trusted.
          kinds: r.kind ? [r.kind] : [],
          summary: text,
          count: Number(r.occurrence_count ?? 1),
          mergedFrom: 1,
          firstSeenAt: r.first_seen_at ?? null,
          lastSeenAt: r.last_seen_at ?? null,
          _seen: seen,
          _class: issueClass(r),
        });
        continue;
      }
      prev.count += Number(r.occurrence_count ?? 1);
      prev.mergedFrom += 1;
      if (r.kind && !prev.kinds.includes(r.kind)) prev.kinds.push(r.kind);
      if (seen > prev._seen) { prev._seen = seen; prev.lastSeenAt = r.last_seen_at; }
      // Guarded: a null firstSeenAt must not win the comparison and erase a real one.
      if (r.first_seen_at && (!prev.firstSeenAt || new Date(r.first_seen_at) < new Date(prev.firstSeenAt))) {
        prev.firstSeenAt = r.first_seen_at;
      }
    }

    // Rank by how much it matters, THEN by recency. Sorting on recency alone let a trivial
    // one-off from ten minutes ago push an unbilled invoice off the end of the list.
    const ordered = [...byCode.values()].sort((a, b) => (
      (CLASS_RANK[a._class] ?? 9) - (CLASS_RANK[b._class] ?? 9) || b._seen - a._seen
    ));

    const issues = ordered.slice(0, limit).map(({ _seen, _class, ...issue }) => issue);
    // So the caller can say "5 of 7 shown" instead of silently truncating.
    return { issues, totalDistinct: ordered.length };
  } catch (err) {
    console.error('[errorLog] failed to list open issues:', err?.message);
    return { issues: [], totalDistinct: 0 };
  }
}

// ─── Why there is no auto-resolve here ────────────────────────────────────────
// A version of this file briefly auto-set `resolved_at` on issues a later success appeared to
// disprove, to keep the ops query tidy. That was removed before shipping, and deliberately so:
//
//   • For self-retrying failures it is redundant — the currency filter above already hides
//     them, so the write bought nothing.
//   • For TERMINAL failures it is destructive. A milestone invoice that failed is never
//     retried, so there is no recurrence to re-create the row: resolving it permanently
//     deletes the only durable record that a customer went unbilled, and removes it from the
//     `resolved_at IS NULL` triage this repo's runbook depends on.
//
// `resolved_at` stays a human judgement. Display currency and resolution are different
// questions, and conflating them is how a billing failure disappears quietly.

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
    // The UPSTREAM route that failed, e.g. "POST /contacts/". ghlService has always
    // computed this (err.ghlPath) and it was silently dropped here, which is why a GHL 400
    // repeating every 15 minutes stored a null `path` and could not be diagnosed without a
    // redeploy. `path` is otherwise our own inbound route, and a cron failure has none —
    // so for cron-sourced upstream errors this column was simply unused.
    path: extra.path ?? err?.ghlPath ?? err?.upstreamPath ?? undefined,
    ...extra,
  });
}
