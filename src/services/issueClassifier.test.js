import { describe, it, expect } from 'vitest';
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
    // A forgotten sentence should fail the build rather than quietly reach a tenant as
    // "A background task for this integration failed."
    const kindsInUse = [
      'ghl_api_error', 'qbo_api_error', 'qbo_sync_failed', 'qbo_contact_sync_failed',
      'milestone_invoice_failed', 'cron_job_failed',
    ];
    for (const kind of kindsInUse) {
      // Supply the upstream each is actually recorded with.
      const upstream = kind.startsWith('ghl') ? 'ghl' : (kind.startsWith('qbo_api') ? 'qbo' : null);
      const status = upstream ? 400 : 0;
      const { code } = summarizeIssue(row({ kind, upstream, upstream_status: status }));
      expect(code, `${kind} fell through to the generic sentence`).not.toBe('unknown');
    }
  });
});
