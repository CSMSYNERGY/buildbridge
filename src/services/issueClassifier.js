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
// Problems where BuildBridge reached everything successfully and simply has not been told
// enough to finish the job. These are keyed on `kind` and MUST be answered before the
// `upstream` branches below.
//
// WHY, because this cost a client two days of the wrong diagnosis: these rows carry an
// `upstream` tag naming the system the data came FROM, not a system that failed.
// `qbo_rep_target_missing` is tagged 'ghl' because the value was headed for GoHighLevel — and
// with no HTTP status it fell through the GHL branch to its catch-all, so a tenant with a
// perfectly healthy integration was told "BuildBridge could not reach Synergy for this
// location, so records are not moving" on a card whose very next line read "last completed
// sync 11 minutes ago" (Rockwood, 225 occurrences, 08-03 → 08-05). Both halves were false:
// that same pass had read 53 customers out of QuickBooks and listed the location's custom
// fields out of GoHighLevel.
//
// A setup gap and an outage need opposite reactions — one is a dropdown the tenant sets in
// thirty seconds, the other is a support call — so guessing wrong does not merely misinform,
// it sends them to the wrong place and manufactures a support ticket for self-serve config.
export const SETUP_GAP_TEXT = {
  qbo_rep_target_missing:
    'BuildBridge is reading the salesperson out of QuickBooks, but no Synergy field has been chosen to copy it into, so that value is being discarded. Everything else is syncing normally. Choose the field in BuildBridge → QuickBooks.',
  qbo_rep_field_not_found:
    'BuildBridge is set to read the salesperson from a QuickBooks field that no recent estimate or invoice actually carries, so no salesperson is being read at all. Check the field name in BuildBridge → QuickBooks.',
  qbo_rep_unmapped:
    'Some QuickBooks salesperson names are not matched to a Synergy user, so those contacts were left unassigned rather than assigned to the wrong person. Map them in BuildBridge → QuickBooks.',
  qbo_item_mapping_missing:
    'No QuickBooks item is set for billing these deals, so their estimates cannot be created — QuickBooks requires an item and an estimate has no default to fall back on. Set one in BuildBridge → QuickBooks; skipped deals are picked up again automatically once it is.',
  ghl_phone_duplicate:
    'A phone number from QuickBooks was not copied because another Synergy contact already holds that number and this location blocks duplicate contacts. Everything else synced normally. Merge or correct the two contacts in Synergy — or allow duplicate contacts in location settings — and the number will copy on the customer’s next change.',
};

// Problems that are BuildBridge's to fix, where telling the tenant to check a setting would
// send them looking for one that does not exist.
export const OURS_TEXT = {
  qbo_rep_value_unreadable:
    'BuildBridge can see the QuickBooks salesperson field but cannot yet read the kind of value stored in it, so no salesperson is being copied. This is a BuildBridge limitation, not a setting — contact CSM Synergy support.',
  qbo_sync_cursor_stalled:
    'The QuickBooks sync has stopped moving forward and keeps re-reading the same window, so recent changes may be delayed. Nothing is lost and there is nothing for you to change — contact CSM Synergy support.',
  ensure_location_failed:
    'BuildBridge could not record this location in its own database, so parts of the integration may not run. QuickBooks is not the problem and there is nothing for you to do.',
  idearoom_unparsable_body:
    'A lead arrived from IdeaRoom in a format BuildBridge could not read, so it was stored raw rather than created. Support can see it — contact CSM Synergy.',
  idearoom_unmappable_lead:
    'A lead arrived from IdeaRoom with no email address and no phone number, so it could not be created in Synergy. Check the field mapping in IdeaRoom.',
  idearoom_token_lookup_failed:
    'BuildBridge could not identify which location an IdeaRoom lead belongs to, so it was not created. Contact CSM Synergy support.',
  idearoom_capture_failed:
    'BuildBridge could not record an inbound IdeaRoom lead in its own database, so that lead may be missing. Contact CSM Synergy support.',
  idearoom_push_failed:
    'A lead from IdeaRoom was received but could not be created in Synergy, so it is missing rather than delayed. Contact CSM Synergy support.',
  idearoom_processing_error:
    'BuildBridge failed while processing a lead from IdeaRoom, so that lead may be missing. Contact CSM Synergy support.',
  // Somebody could not get IN. On 2026-07-27 a 400 "Invalid or expired OAuth state" blocked
  // every marketplace install for days, so this one is about access, not about syncing.
  entry_blocked:
    'Someone could not finish installing or signing in to BuildBridge, so this location may not be connected yet. Try the install link again from the start; if it keeps failing, contact CSM Synergy support.',
  // The browser ingest endpoint also accepts a client-supplied kind, so an arbitrary string can
  // reach the table and the generic sentence stays reachable by design. This is only the
  // default the server picks when the browser sent no kind of its own.
  client_error:
    'Something went wrong in the BuildBridge screen you were using. Reloading usually clears it; if it keeps happening, contact CSM Synergy support.',
};

// Individual records that did not make it across. Naming the direction correctly here needs
// care, because THE KIND PREFIX NAMES THE SOURCE OF THE DATA, NOT THE SYSTEM THAT FAILED:
// `ghl_contact_push_failed` is raised inside `syncGhlContactsToQb`, so the write that failed
// was to QuickBooks, not to Synergy. Reading those prefixes as "GoHighLevel broke" would
// produce exactly the inverted sentence this file exists to prevent — verified against the
// enclosing function and the call it wraps, not the name.
export const PER_RECORD_TEXT = {
  ghl_contact_push_failed:
    'Some Synergy contacts could not be written into QuickBooks, so those customers are missing or out of date in QuickBooks. Support can see which ones.',
  ghl_estimate_push_failed:
    'Some deals could not have their estimate created in QuickBooks, so those estimates are missing there. Support can see which ones.',
  qbo_status_reflect_failed:
    'The status of a QuickBooks estimate or invoice could not be copied back into Synergy, so a deal may show an out-of-date status there. Support can see which ones.',
};

export function summarizeIssue(row) {
  const kind = row?.kind ?? '';
  const upstream = row?.upstream ?? '';
  const status = Number(row?.upstream_status) || 0;
  const message = String(row?.message ?? '');

  // Kind-keyed sentences first — before any `upstream` tag can pick one. For every kind in
  // these three tables the tag names which system the DATA came from, so letting it choose
  // is what produced "could not reach Synergy" for an unset dropdown.
  if (SETUP_GAP_TEXT[kind]) return { code: kind, text: SETUP_GAP_TEXT[kind] };
  if (OURS_TEXT[kind]) return { code: kind, text: OURS_TEXT[kind] };
  if (PER_RECORD_TEXT[kind]) return { code: kind, text: PER_RECORD_TEXT[kind] };

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
    // "Could not reach" is a CLAIM ABOUT THE NETWORK, so it now requires evidence of one:
    // a server-class status or a transport error. It used to be the blind fallthrough for
    // every ghl-tagged row, which is how a config gap with no status at all came to be
    // reported as an outage. Anything else gets a sentence that describes what is known
    // and stops there — vague is recoverable, confidently wrong is not.
    if (status >= 500 || /timeout|timed out|network|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return { code: 'ghl_unreachable', text: 'BuildBridge could not reach Synergy for this location, so records are not moving.' };
    }
    return { code: 'ghl_other', text: 'A BuildBridge task involving Synergy did not complete. Support can see the detail.' };
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

  // A qbo-tagged row with no status that matched nothing above. Deliberately AFTER the
  // kind-specific sentences, so it can never shadow "that customer has not been billed" —
  // the whole point of those is that they say more than this does.
  if (upstream === 'qbo') {
    return { code: 'qbo_other', text: 'A BuildBridge task involving QuickBooks did not complete. Support can see the detail.' };
  }
  return { code: 'unknown', text: 'A background task for this integration failed.' };
}

// Ranking for the card: what matters most, not merely what happened most recently. Sorting on
// recency alone let a trivial one-off from ten minutes ago push an unbilled invoice off the end.
export const CLASS_RANK = { terminal: 0, credential: 1, sync: 2, other: 3 };
