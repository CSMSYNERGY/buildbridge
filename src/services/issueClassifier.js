// ─── Which integration problems are CURRENT, and what to tell the tenant ──────
//
// Deliberately import-free, like qbSyncLogic.js: errorLogService.js can only be loaded inside
// a Worker (it pulls in `cloudflare:workers` via the db client), and this logic decides whether
// somebody finds out their invoices stopped — so it has to be unit-testable on its own.
//
// The problem this solves: the tenant-facing card used to list every error_events row that had
// no `resolved_at`, regardless of age. A client who reconnected QuickBooks still saw the
// failures that made them reconnect, presented as live problems (reported 2026-07-29, five
// stale entries from 0.4h to 24h old). "Unresolved" is a triage state; "current" is a different
// question, and this file answers only the second one.

// Failures that NOTHING will retry. A milestone whose status is 'failed' is never re-selected
// by the invoicer, and a contact the sync skipped is passed over as the cursor advances. The
// error_events row is the only durable trace that a customer went unbilled or unsynced, so
// these must never expire on a timer and must never be cleared by an unrelated success.
export const TERMINAL_KINDS = new Set([
  'milestone_invoice_failed',
  'qbo_contact_sync_failed',
]);

// How long a self-retrying problem may go without recurring before it stops being current.
// The cron runs every 15 minutes, so anything live re-fires well inside this; three cycles of
// grace means one skipped or slow tick never makes a real problem vanish.
export const ISSUE_STALE_AFTER_MS = 45 * 60 * 1000;

// Tolerance when comparing a Worker-clock timestamp (last_ok_at, a JS Date) with a Postgres
// now() one (last_seen_at). Also absorbs a success stamped moments before a later part of the
// same cron pass fails — without it, a read at 10:00:41 would bury a write that failed at
// 10:00:18 in the same tick.
export const CLOCK_MARGIN_MS = 2 * 60 * 1000;

/**
 * Classify a row into the four kinds of "is it fixed?" question.
 *
 *   'credential' — cannot reach QuickBooks / it rejects our authorisation. Reconnecting
 *                  genuinely disproves these, and only these.
 *   'terminal'   — one record failed and nothing will retry it.
 *   'sync'       — a scheduled pass failed; a later COMPLETED pass disproves it.
 *   'other'      — GoHighLevel, our own database, or unclassified.
 *
 * There is no permissive default, on purpose. An earlier version treated anything it did not
 * recognise as "a QuickBooks success disproves this", which meant a successful QuickBooks READ
 * erased a failed invoice WRITE from the same cron tick about twenty seconds after it was
 * recorded — and being terminal, nothing ever reported it again.
 */
export function issueClass(row) {
  const kind = row?.kind ?? '';
  const upstream = row?.upstream ?? '';
  const status = Number(row?.upstream_status) || 0;
  const message = String(row?.message ?? '');

  if (TERMINAL_KINDS.has(kind)) return 'terminal';

  // Other systems first. Checked by message as well as by `upstream`, because ghlService
  // throws its token failure before that metadata is attached (it arrives as upstream=null).
  if (upstream === 'ghl' || /\bGHL\b|GoHighLevel/i.test(message)) return 'other';
  if (upstream === 'db' || /^(Failed query:|db-proxy:)|DB_WORKER/i.test(message)) return 'other';

  // Reachability and authorisation ONLY. A 400/403/404/422 is QuickBooks refusing one
  // particular operation — a malformed invoice, a missing permission — which a successful read
  // does not disprove, so those fall through to 'sync'/'other' instead of being cleared.
  if (/token refresh (failed|rejected)/i.test(message)) return 'credential';
  if (upstream === 'qbo' && (status === 401 || status === 429 || status >= 500)) return 'credential';

  if (kind === 'qbo_sync_failed' || kind === 'cron_job_failed') return 'sync';
  return 'other';
}

/**
 * Is this problem still happening?
 *
 * `lastOkAt` is the credential's last proven-good moment; `lastSyncAt` is qb_sync_state's
 * cursor, written only as the final statement of a fully successful pass.
 *
 * Note what is NOT treated as a blanket all-clear: `lastOkAt`. It proves the token works, and
 * it is stamped by any successful call — including a read, and including the tenant pressing
 * "Test connection", which is their natural reaction to seeing a problem. Letting it clear
 * everything would make the button that investigates a problem the button that hides it.
 */
export function isIssueCurrent(row, { now = Date.now(), lastOkAt = null, lastSyncAt = null } = {}) {
  const seen = row?.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (!seen || Number.isNaN(seen)) return false;

  const cls = issueClass(row);

  // Nothing will retry it, so time cannot fix it. Stays up until a human resolves it — the one
  // class where ageing out would quietly lose money.
  if (cls === 'terminal') return true;

  // Everything else has to have recurred recently to count as live.
  if (now - seen > ISSUE_STALE_AFTER_MS) return false;

  const okMs = lastOkAt ? new Date(lastOkAt).getTime() : NaN;
  if (cls === 'credential' && Number.isFinite(okMs) && seen < okMs - CLOCK_MARGIN_MS) return false;

  const syncMs = lastSyncAt ? new Date(lastSyncAt).getTime() : NaN;
  if (cls === 'sync' && Number.isFinite(syncMs) && seen < syncMs - CLOCK_MARGIN_MS) return false;

  return true;
}

/**
 * The tenant-facing sentence, as `{ code, text }`.
 *
 * The CODE is what dedupe keys on, so prose can be reworded without changing which problems
 * merge. The stored `message` must NEVER reach a browser — it can carry an upstream response
 * body, a request path, a SQL statement or an intuit_tid — so it is used here only to choose
 * between fixed sentences, never interpolated into one.
 *
 * Each sentence must name the system at fault and say what, if anything, the tenant should do.
 * Getting the system wrong is not cosmetic: a GoHighLevel authorisation failure that reads
 * "reconnect QuickBooks" sends someone round a loop of a remedy that cannot work.
 */
export function summarizeIssue(row) {
  const kind = row?.kind ?? '';
  const upstream = row?.upstream ?? '';
  const status = Number(row?.upstream_status) || 0;
  const message = String(row?.message ?? '');

  // Ours, not theirs.
  if (upstream === 'db' || /^(Failed query:|db-proxy:)|DB_WORKER/i.test(message)) {
    return {
      code: 'db',
      text: 'BuildBridge’s own database was briefly unavailable, so this run could not finish. QuickBooks is not the problem and there is nothing for you to do.',
    };
  }

  // GoHighLevel — before QuickBooks, and by message as well as `upstream`.
  if (upstream === 'ghl' || /\bGHL\b|GoHighLevel/i.test(message)) {
    if (status === 401 || status === 403 || /token refresh/i.test(message)) {
      return {
        code: 'ghl_auth',
        text: 'BuildBridge’s authorisation for this Synergy location was rejected, so records are not moving in or out. Reconnecting QuickBooks will not fix this — contact CSM Synergy support.',
      };
    }
    if (status === 400 || status === 422) {
      return {
        code: 'ghl_rejected',
        text: 'Synergy rejected some record updates from BuildBridge, so those records are not moving. Support can see which ones.',
      };
    }
    if (status === 429) {
      return { code: 'ghl_throttled', text: 'Synergy is rate-limiting BuildBridge, so records are delayed rather than lost.' };
    }
    return { code: 'ghl_unreachable', text: 'BuildBridge could not reach Synergy for this location, so records are not moving.' };
  }

  // QuickBooks — split by status, because the remedy differs completely.
  if (/token refresh (failed|rejected)/i.test(message)
      || (upstream === 'qbo' && (status === 401 || status === 403))) {
    return { code: 'qbo_auth', text: 'QuickBooks is no longer accepting BuildBridge’s authorisation — reconnect below to fix it.' };
  }
  if (upstream === 'qbo' && status === 429) {
    return { code: 'qbo_throttled', text: 'QuickBooks is rate-limiting BuildBridge, so records are delayed rather than lost. This normally clears itself.' };
  }
  if (upstream === 'qbo' && (status === 400 || status === 422 || status === 404)) {
    return { code: 'qbo_rejected', text: 'QuickBooks rejected some requests as invalid, so those records did not go through — usually a mapped field or item QuickBooks will not accept.' };
  }
  if (upstream === 'qbo' && status >= 500) {
    return { code: 'qbo_server', text: 'QuickBooks returned a server error. BuildBridge will keep retrying.' };
  }

  if (kind === 'milestone_invoice_failed') {
    return { code: 'milestone_failed', text: 'A milestone invoice could not be created in QuickBooks and will NOT be retried automatically — that customer has not been billed.' };
  }
  if (kind === 'qbo_contact_sync_failed') {
    return { code: 'contact_skipped', text: 'Some customers could not be copied into Synergy and were skipped, so they are missing rather than delayed.' };
  }
  if (kind === 'qbo_sync_failed') return { code: 'sync_failed', text: 'A scheduled QuickBooks sync did not finish.' };
  if (kind === 'cron_job_failed') return { code: 'cron_failed', text: 'A scheduled background job did not finish.' };
  return { code: 'unknown', text: 'A background task for this integration failed.' };
}

// Ranking for the card: what matters most, not merely what happened most recently. Sorting on
// recency alone let a trivial one-off from ten minutes ago push an unbilled invoice off the end.
export const CLASS_RANK = { terminal: 0, credential: 1, sync: 2, other: 3 };
