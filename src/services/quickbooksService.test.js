// createInvoice refuses to bill without an item, BEFORE it reaches anything outside the process.
//
// The body rules are unit-tested as buildInvoiceBody in qbSyncLogic.test.js. This file proves
// the wiring: that the real createInvoice consults them first. Hermetic — the database client,
// env and location service are replaced, and the fake database THROWS if anything reads it, so
// "it never got as far as loading QuickBooks credentials" is something the test observes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/db/client.js', () => {
  const touched = () => { throw new Error('database touched'); };
  return { db: { select: touched, insert: touched, update: touched, delete: touched, execute: touched } };
});
vi.mock('../core/env.js', () => ({
  env: {
    INTUIT_CLIENT_ID: 'test-client',
    INTUIT_CLIENT_SECRET: 'test-secret',
    QBO_REDIRECT_URI: 'https://example.invalid/callback',
    QBO_ENVIRONMENT: 'sandbox',
  },
}));
vi.mock('./locationService.js', () => ({ ensureLocation: vi.fn() }));
vi.mock('./errorLogService.js', () => ({ recordThrown: vi.fn(), recordError: vi.fn() }));

import { createInvoice } from './quickbooksService.js';

const ok = { qbCustomerId: '58', amountCents: 250000, description: 'Deposit', itemRef: '49' };

describe('createInvoice — no item, no request', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network touched');
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it('throws a 400 without an itemRef and never loads credentials or calls QuickBooks', async () => {
    for (const itemRef of [undefined, null, '']) {
      const err = await createInvoice('loc-test', { ...ok, itemRef }).catch((e) => e);
      expect(err, `itemRef=${JSON.stringify(itemRef)}`).toBeInstanceOf(Error);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/itemRef is required/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with an itemRef it proceeds to load credentials (so the refusal above is what stopped it)', async () => {
    const err = await createInvoice('loc-test', ok).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('database touched');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
