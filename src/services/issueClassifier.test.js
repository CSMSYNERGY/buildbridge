import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  issueClass,
  isIssueCurrent,
  summarizeIssue,
  ISSUE_STALE_AFTER_MS,
} from './issueClassifier.js';

// A fixed "now" so every case reads as an absolute timeline.
const NOW = new Date('2026-07-29T15:00:00Z').getTime();
const mins = (n) => new Date(NOW + n * 60_000).toISOString();
const row = (over = {}) => ({ last_seen_at: mins(-1), ...over });

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Two kinds are recorded inside a conditional rather than as a plain property:
//   kind: err.kind ?? (isEntryFailure ? 'entry_blocked' : undefined)
//   kind: typeof kind === 'string' ? kind.slice(0, 60) : 'client_error'
// Matching a ternary mechanically means either missing these or dragging in the neighbouring
// `typeof x === 'string'` and `appSlug: 'idearoom'` literals as if they were kinds — a guard
// that invents kinds is as bad as one that misses them. So these two are named, WITH the
// reason. If that idiom spreads, extend this list; the count assertion below is what stops
// the derived half from silently shrinking in the meantime.
const CONDITIONALLY_RECORDED_KINDS = [['entry_blocked', null], ['client_error', null]];

/**
 * Every `kind` this app records, paired with the `upstream` it is recorded with —
 * read out of `src/` rather than hand-listed, so the completeness check cannot drift.
 *
 * Hermetic: local file reads only, no network and no database, same as the rest of this file.
 * Test files are skipped so fixture kinds invented by tests are not mistaken for real ones.
 *
 * Note `client_error`: the browser ingest endpoint accepts a client-supplied kind (sliced to
 * 60 chars), so the set of kinds in the table is genuinely open and the `unknown` sentence
 * stays reachable by design. This guard covers what the SERVER chooses to record.
 */
function recordedKinds() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(p);
    }
  })(SRC_DIR);

  // Plain `kind: 'x'`, and the `kind: err.kind ?? 'x'` default used by the three wrappers that
  // let a thrown error name its own kind. Both anchored so `text('kind')` in the Drizzle
  // schema and `appSlug:` on the same line cannot masquerade as a kind.
  const patterns = [/kind:\s*'([a-z0-9_]+)'/g, /kind:\s*[^,\n]*?\?\?\s*'([a-z0-9_]+)'/g];

  const found = new Map(CONDITIONALLY_RECORDED_KINDS);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        // `upstream` belongs to the same recordError/recordThrown object literal, which may sit
        // either side of the `kind` line — so look in a window around it rather than after it.
        const around = text.slice(Math.max(0, m.index - 400), m.index + 400);
        const up = /upstream:\s*'([a-z]+)'/.exec(around);
        if (!found.has(m[1])) found.set(m[1], up ? up[1] : null);
      }
    }
  }
  return [...found];
}

describe('issueClass — deny-by-default, so nothing is cleared by an unrelated success', () => {
  it('classifies a token-refresh rejection as a credential problem', () => {
    expect(issueClass(row({ message: 'QuickBooks token refresh failed (HTTP 400): invalid_grant' }))).toBe('credential');
  });

  it('classifies QBO 401 / 429 / 5xx as credential (reachability + authorisation)', () => {
    expect(issueClass(row({ upstream: 'qbo', upstream_status: 401 }))).toBe('credential');
    expect(issueClass(row({ upstream: 'qbo', upstream_status: 429 }))).toBe('credential');
    expect(issueClass(row({ upstream: 'qbo', upstream_status: 503 }))).toBe('credential');
  });

  it('does NOT classify an operation-level QBO refusal as credential', () => {
    // A 400/403/422 means QuickBooks refused THIS request. A successful read elsewhere does
    // not disprove it, so it must not be eligible for credential supersession.
    for (const status of [400, 403, 404, 422]) {
      expect(issueClass(row({ upstream: 'qbo', upstream_status: status }))).not.toBe('credential');
    }
  });

  it('classifies GoHighLevel failures as other, even when upstream is not tagged', () => {
    expect(issueClass(row({ upstream: 'ghl', upstream_status: 400 }))).toBe('other');
    // ghlService throws its token failure before upstream is attached.
    expect(issueClass(row({ upstream: null, message: 'GHL token refresh failed: invalid_grant' }))).toBe('other');
  });

  it('classifies our own database failures as other, in all three shapes we throw', () => {
    expect(issueClass(row({ upstream: 'db' }))).toBe('other');
    expect(issueClass(row({ kind: 'qbo_sync_failed', message: 'Failed query: select "location_id" from ...' }))).toBe('other');
    expect(issueClass(row({ message: 'db-proxy: 500' }))).toBe('other');
    expect(issueClass(row({ message: 'DB_WORKER service binding missing' }))).toBe('other');
  });

  it('classifies never-retried record failures as terminal', () => {
    expect(issueClass(row({ kind: 'milestone_invoice_failed', upstream: 'qbo', upstream_status: 400 }))).toBe('terminal');
    expect(issueClass(row({ kind: 'qbo_contact_sync_failed' }))).toBe('terminal');
  });

  it('falls back to other — never to something supersedable — for an unrecognised row', () => {
    expect(issueClass(row({}))).toBe('other');
    expect(issueClass(row({ kind: 'something_new_someone_added' }))).toBe('other');
    expect(issueClass(null)).toBe('other');
  });
});

describe('isIssueCurrent — the complaint: past problems must not be shown', () => {
  it('hides a credential failure once QuickBooks has been reached since', () => {
    // The reported case: reconnected at 15:07, failures last seen 14:46.
    const r = row({ last_seen_at: mins(-14), message: 'QuickBooks token refresh failed (HTTP 400)' });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-1) })).toBe(false);
  });

  it('still shows a credential failure that is NEWER than the last success', () => {
    const r = row({ last_seen_at: mins(-1), message: 'QuickBooks token refresh failed (HTTP 400)' });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-14) })).toBe(true);
  });

  it('hides anything that simply stopped recurring', () => {
    const old = row({ last_seen_at: new Date(NOW - ISSUE_STALE_AFTER_MS - 60_000).toISOString(), upstream: 'ghl' });
    expect(isIssueCurrent(old, { now: NOW })).toBe(false);
  });

  it('KEEPS a GoHighLevel problem that a QuickBooks success does not disprove', () => {
    // Rockwood, 2026-07-29: QBO token refreshing perfectly while the sync failed on a GHL 400
    // every 15 minutes. A blanket all-clear here would have hidden a dead integration.
    const r = row({ last_seen_at: mins(-14), upstream: 'ghl', upstream_status: 400 });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-1) })).toBe(true);
  });

  it('KEEPS a failed milestone invoice forever — nothing retries it, so time cannot fix it', () => {
    const ancient = row({
      kind: 'milestone_invoice_failed',
      upstream: 'qbo',
      upstream_status: 400,
      last_seen_at: new Date(NOW - 30 * 24 * 3600_000).toISOString(),
    });
    expect(isIssueCurrent(ancient, { now: NOW, lastOkAt: mins(-1), lastSyncAt: mins(-1) })).toBe(true);
  });

  it('KEEPS a QuickBooks write refusal that only a read has "disproved"', () => {
    // The intra-tick inversion: invoice POST 403 at 10:00:18, CDC GET 200 at 10:00:41.
    const r = row({ upstream: 'qbo', upstream_status: 403, last_seen_at: mins(-10) });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-9) })).toBe(true);
  });

  it('hides a failed sync pass only once a LATER pass completed', () => {
    const r = row({ kind: 'qbo_sync_failed', last_seen_at: mins(-20) });
    expect(isIssueCurrent(r, { now: NOW, lastSyncAt: mins(-5) })).toBe(false);  // a pass finished after it
    expect(isIssueCurrent(r, { now: NOW, lastSyncAt: mins(-30) })).toBe(true);  // last completion predates it
    expect(isIssueCurrent(r, { now: NOW, lastSyncAt: null })).toBe(true);       // never completed
  });

  it('does not let a credential success stand in for a completed sync pass', () => {
    const r = row({ kind: 'qbo_sync_failed', last_seen_at: mins(-20) });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-1) })).toBe(true);
  });

  it('applies a clock margin, so a success stamped seconds later cannot bury a failure', () => {
    // last_seen_at is Postgres now(); last_ok_at is a Worker JS Date. Without the margin a
    // sub-minute ordering difference — or a mid-pass stamp — would hide a live problem.
    const r = row({ last_seen_at: mins(-10), message: 'QuickBooks token refresh failed' });
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-9.5) })).toBe(true);   // inside margin
    expect(isIssueCurrent(r, { now: NOW, lastOkAt: mins(-5) })).toBe(false);    // clearly after
  });

  it('ignores a row with no or unparseable timestamp rather than showing it forever', () => {
    expect(isIssueCurrent(row({ last_seen_at: null }), { now: NOW })).toBe(false);
    expect(isIssueCurrent(row({ last_seen_at: 'not a date' }), { now: NOW })).toBe(false);
  });
});

describe('summarizeIssue — name the right system and the right remedy', () => {
  it('never tells someone to reconnect QuickBooks for a GoHighLevel problem', () => {
    const s = summarizeIssue(row({ upstream: 'ghl', upstream_status: 401 }));
    expect(s.code).toBe('ghl_auth');
    expect(s.text).toMatch(/Reconnecting QuickBooks will not fix this/i);
    // And the GHL token-refresh shape, which arrives untagged.
    expect(summarizeIssue(row({ message: 'GHL token refresh failed: invalid_grant' })).code).toBe('ghl_auth');
  });

  it('tells the tenant our database problem is not theirs to fix', () => {
    const s = summarizeIssue(row({ message: 'Failed query: select "location_id" from "qb_sync_state"' }));
    expect(s.code).toBe('db');
    expect(s.text).toMatch(/nothing for you to do/i);
    expect(s.text).toMatch(/QuickBooks is not the problem/i);
  });

  it('separates QuickBooks remedies that are genuinely different', () => {
    expect(summarizeIssue(row({ upstream: 'qbo', upstream_status: 401 })).code).toBe('qbo_auth');
    expect(summarizeIssue(row({ upstream: 'qbo', upstream_status: 429 })).code).toBe('qbo_throttled');
    expect(summarizeIssue(row({ upstream: 'qbo', upstream_status: 400 })).code).toBe('qbo_rejected');
    expect(summarizeIssue(row({ upstream: 'qbo', upstream_status: 500 })).code).toBe('qbo_server');
    // Distinct codes mean these never merge into one line on the card.
    const codes = [401, 429, 400, 500].map((s) => summarizeIssue(row({ upstream: 'qbo', upstream_status: s })).code);
    expect(new Set(codes).size).toBe(4);
  });

  it('says plainly that a failed milestone means the customer was not billed', () => {
    const s = summarizeIssue(row({ kind: 'milestone_invoice_failed' }));
    expect(s.text).toMatch(/not been billed/i);
    expect(s.text).toMatch(/NOT be retried/i);
  });

  it('never leaks the stored message into tenant-visible text', () => {
    const leaky = row({
      kind: 'qbo_sync_failed',
      message: 'Failed query: select * from clients where email = \'bob@example.com\' -- intuit_tid=1-abc',
    });
    const { text } = summarizeIssue(leaky);
    expect(text).not.toMatch(/bob@example\.com/);
    expect(text).not.toMatch(/intuit_tid/);
    expect(text).not.toMatch(/select \*/i);
  });

  it('every kind this app actually records classifies to a real sentence, not the fallback', () => {
    // DERIVED FROM SOURCE, not hand-listed. The hand-written version of this test named six
    // kinds while `src/` recorded eighteen, so the twelve it never mentioned went unchecked —
    // including `qbo_rep_target_missing`, which reached a real tenant as "BuildBridge could
    // not reach Synergy" for two days. A guard whose coverage is a literal drifts the moment
    // someone adds a kind, and drifts silently, which is the worst property a guard can have.
    // Reading the tree keeps it honest: a new `kind:` with no sentence fails right here.
    for (const [kind, upstream] of recordedKinds()) {
      const { code } = summarizeIssue(row({ kind, upstream, upstream_status: null }));
      expect(code, `${kind} (upstream=${upstream ?? 'none'}) fell through to the generic sentence`).not.toBe('unknown');
    }
  });

  it('finds a meaningful number of kinds, so the derivation cannot pass by finding none', () => {
    // Without this, a broken regex would make the test above vacuous and silently green —
    // which is precisely how the hand-listed version failed. 23 at the time of writing
    // (21 derived + 2 conditional); the floor only has to be high enough that a regex
    // returning nothing, or a recordError site disappearing, fails loudly.
    expect(recordedKinds().length).toBeGreaterThanOrEqual(23);
  });

  it('never reports a setup gap as an outage — the Rockwood regression', () => {
    // 2026-08-05: `qbo_rep_target_missing` is tagged upstream='ghl' (that is where the value
    // was HEADED) and carries no HTTP status, so it fell through the GHL branch to its
    // catch-all and produced "BuildBridge could not reach Synergy for this location, so
    // records are not moving" — on a card that simultaneously said the last sync completed 11
    // minutes ago. 225 occurrences. Nothing was unreachable; a dropdown was unset.
    const s = summarizeIssue(row({ kind: 'qbo_rep_target_missing', upstream: 'ghl', upstream_status: null }));
    expect(s.code).not.toBe('ghl_unreachable');
    expect(s.text).not.toMatch(/could not reach/i);
    expect(s.text).not.toMatch(/records are not moving/i);
    // And it must say what to actually do.
    expect(s.text).toMatch(/BuildBridge → QuickBooks/);

    // Same shape, same trap, for the other setup gaps.
    for (const kind of ['qbo_rep_field_not_found', 'qbo_rep_unmapped', 'qbo_item_mapping_missing']) {
      const t = summarizeIssue(row({ kind, upstream: kind === 'qbo_rep_unmapped' ? 'ghl' : 'qbo' }));
      expect(t.text, `${kind} claims unreachability`).not.toMatch(/could not reach/i);
      expect(t.text, `${kind} gives the tenant nowhere to go`).toMatch(/BuildBridge → QuickBooks|IdeaRoom/);
    }
  });

  it('only claims Synergy is unreachable when there is evidence of it', () => {
    // A network claim needs a network symptom: a server-class status or a transport error.
    expect(summarizeIssue(row({ upstream: 'ghl', upstream_status: 502 })).code).toBe('ghl_unreachable');
    expect(summarizeIssue(row({ upstream: 'ghl', message: 'fetch failed' })).code).toBe('ghl_unreachable');
    // No status and no symptom: say what is known and stop.
    const vague = summarizeIssue(row({ kind: 'some_unmapped_ghl_thing', upstream: 'ghl' }));
    expect(vague.code).toBe('ghl_other');
    expect(vague.text).not.toMatch(/could not reach/i);
  });

  it('a generic catch-all never shadows a sentence that says more', () => {
    // qbo_other sits after the kind-specific sentences on purpose: "that customer has not
    // been billed" must survive, because it is the one that changes what someone does.
    expect(summarizeIssue(row({ kind: 'milestone_invoice_failed', upstream: 'qbo' })).code).toBe('milestone_failed');
    expect(summarizeIssue(row({ kind: 'qbo_contact_sync_failed', upstream: 'qbo' })).code).toBe('contact_skipped');
  });
});
