// error_events dedupe: which failures share one open row.
//
// The table keeps ONE unresolved row per fingerprint (0004's partial unique index), and the
// tenant's QuickBooks page reads rows by location_id. So the fingerprint decides both "is this
// the same problem again?" and "whose problem is it?". These tests pin the second half: a
// failure at one location must never land on another location's row.
//
// Hermetic: the db client is replaced, so nothing here can reach a database. Location ids are
// synthetic 20-character strings, the same shape as real ones, because that shape is exactly
// what the message normalizer collapses to <id>.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/db/client.js', () => ({ db: { execute: vi.fn() } }));

import { buildFingerprint } from './errorLogService.js';

const LOC_A = 'locAAAAAAAAAAAAAAAAA';
const LOC_B = 'locBBBBBBBBBBBBBBBBB';

// Shaped like the milestone run's "waiting for an item" row, which is recorded once per location.
const waiting = (locationId, n) => ({
  source: 'cron',
  kind: 'qbo_milestone_item_missing',
  appSlug: 'quickbooks',
  upstream: 'qbo',
  locationId,
  message: `${n} milestone invoice(s) are due but were not created: no QuickBooks item is chosen for this location.`,
});

describe('buildFingerprint', () => {
  it('keeps the same failure at two locations apart', () => {
    expect(buildFingerprint(waiting(LOC_A, 3))).not.toBe(buildFingerprint(waiting(LOC_B, 1)));
    // Same counts too, so only the location differs.
    expect(buildFingerprint(waiting(LOC_A, 2))).not.toBe(buildFingerprint(waiting(LOC_B, 2)));
  });

  it('still merges repeats at one location when only the counts change', () => {
    expect(buildFingerprint(waiting(LOC_A, 3))).toBe(buildFingerprint(waiting(LOC_A, 7)));
  });

  it('does not rely on the message: a location id inside it is normalized away', () => {
    // Why the location is hashed raw rather than written into the message or path: both of
    // those are normalized, and a 20-character id becomes <id> for every location.
    const inPath = (locationId) => ({ ...waiting(undefined, 1), path: `milestones/${locationId}` });
    expect(buildFingerprint(inPath(LOC_A))).toBe(buildFingerprint(inPath(LOC_B)));
  });

  it('leaves rows with no location exactly as they were fingerprinted before', () => {
    const e = { source: 'backend', kind: 'client_error', message: 'Something broke on /x' };
    expect(buildFingerprint(e)).toBe(buildFingerprint({ ...e, locationId: null }));
    expect(buildFingerprint(e)).toBe(buildFingerprint({ ...e, locationId: '' }));
    expect(buildFingerprint(e)).not.toBe(buildFingerprint({ ...e, locationId: LOC_A }));
  });
});
