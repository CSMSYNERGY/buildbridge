// Orchestration tests for milestoneService: the ORDER of things, which the pure tests in
// qbSyncLogic.test.js cannot see. Does a deal with nothing to bill reach QuickBooks at all?
// Does a milestone with no item wait or fail? Does the poller read past page one?
//
// Hermetic: every module that would touch the database, GoHighLevel or QuickBooks is replaced
// below, so nothing here can make a network call or write a row. The fake db only records.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selectResults: new Map(),
  inserts: [],
  updates: [],
}));

vi.mock('../core/db/client.js', () => {
  function chain(result) {
    const p = Promise.resolve(result);
    return {
      where: () => chain(result),
      limit: () => chain(result),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
  }
  return {
    db: {
      select: () => ({ from: (table) => chain(h.selectResults.get(table) ?? []) }),
      insert: (table) => ({
        values: (rows) => {
          const rec = { table, rows, conflict: null };
          h.inserts.push(rec);
          const p = Promise.resolve();
          return {
            onConflictDoUpdate: (cfg) => { rec.conflict = cfg; return Promise.resolve(); },
            then: p.then.bind(p),
          };
        },
      }),
      update: (table) => ({
        set: (values) => ({
          where: () => { h.updates.push({ table, values }); return Promise.resolve(); },
        }),
      }),
    },
  };
});
vi.mock('./quickbooksService.js', () => ({ findOrCreateCustomer: vi.fn(), createInvoice: vi.fn() }));
vi.mock('./ghlService.js', () => ({ makeGhlRequest: vi.fn() }));
vi.mock('./subscriptionService.js', () => ({ hasAccess: vi.fn() }));
vi.mock('./locationSettingsService.js', () => ({ getLocationSettings: vi.fn() }));
vi.mock('./milestoneDefinitionsService.js', () => ({ listMilestoneDefinitions: vi.fn() }));
vi.mock('./mapperService.js', () => ({ listMappers: vi.fn() }));
vi.mock('./errorLogService.js', () => ({ recordThrown: vi.fn(), recordError: vi.fn() }));

import { qbMilestones, qbSyncState, integrationCredentials } from '../core/db/schema.js';
import { findOrCreateCustomer, createInvoice } from './quickbooksService.js';
import { makeGhlRequest } from './ghlService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';
import { listMilestoneDefinitions } from './milestoneDefinitionsService.js';
import { listMappers } from './mapperService.js';
import { recordError, recordThrown } from './errorLogService.js';
import {
  handleOpportunityWon,
  invoiceDueMilestones,
  pollWonOpportunities,
  getPayloadField,
  parseAmountCents,
  parseDate,
} from './milestoneService.js';

const LOC = 'loc-test';
const POST_FRAME = 'pipe-post-frame';
const SHEDS = 'pipe-sheds';

// Two post-frame-only milestones, as a client that sells sheds and post-frame from one account
// would configure them.
const DEFS = [
  { id: 'def-deposit', label: 'Deposit', amountField: 'f_dep', dateField: null, pipelineId: POST_FRAME },
  { id: 'def-roof', label: 'Roof Complete', amountField: 'f_roof', dateField: 'f_roof_date', pipelineId: POST_FRAME },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResults.clear();
  h.inserts.length = 0;
  h.updates.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  hasAccess.mockResolvedValue(true);
  getLocationSettings.mockResolvedValue({ qboMilestoneInvoicing: true, qboInvoiceLeadDays: 0 });
  listMilestoneDefinitions.mockResolvedValue(DEFS);
  findOrCreateCustomer.mockResolvedValue({ Id: '58' });
});

const wonPayload = (over = {}) => ({
  opportunityId: 'opp-1',
  contactId: 'c-1',
  status: 'won',
  pipelineId: POST_FRAME,
  contact: { name: 'Test Customer' },
  customFields: [
    { id: 'f_dep', value: '2500' },
    { id: 'f_roof', value: '9000' },
  ],
  ...over,
});

describe('handleOpportunityWon — QuickBooks is touched only when the deal is owed something', () => {
  it('re-exports the payload readers it used to own', () => {
    expect(getPayloadField({ customFields: { a: 1 } }, 'a')).toBe(1);
    expect(parseAmountCents('10')).toBe(1000);
    expect(parseDate('nope')).toBeNull();
  });

  it('creates NO QuickBooks customer for a Won deal with no milestone amounts', async () => {
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload({ customFields: [] }) });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it('creates NO QuickBooks customer for a Won deal in a pipeline no milestone bills (the shed sale)', async () => {
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload({ pipelineId: SHEDS }) });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });

  it('creates NO customer when the payload does not say which pipeline and every milestone is scoped', async () => {
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload({ pipelineId: undefined }) });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('schedules the milestones, then finds the customer once, for a deal in the right pipeline', async () => {
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload() });
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
    expect(h.inserts).toHaveLength(1);
    const { table, rows, conflict } = h.inserts[0];
    expect(table).toBe(qbMilestones);
    expect(rows.map((r) => r.milestoneType)).toEqual(['def-deposit', 'def-roof']);
    for (const r of rows) {
      expect(r).toMatchObject({ locationId: LOC, opportunityId: 'opp-1', contactId: 'c-1', qbCustomerId: '58' });
      expect(typeof r.id).toBe('string');
    }
    expect(rows[1]).toMatchObject({ awaitsDate: true, milestoneDate: null, amountCents: 900000 });
    // Only pending rows may be rewritten by a later Won/poll pass.
    expect(conflict?.setWhere).toBeDefined();
  });

  it('keeps today\'s behaviour for any-pipeline milestones: every pipeline schedules', async () => {
    listMilestoneDefinitions.mockResolvedValue(DEFS.map((d) => ({ ...d, pipelineId: null })));
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload({ pipelineId: SHEDS }) });
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
    expect(h.inserts[0].rows).toHaveLength(2);
  });

  it('still does nothing for a location with no definitions, or with the toggle off', async () => {
    listMilestoneDefinitions.mockResolvedValue([]);
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload() });
    getLocationSettings.mockResolvedValue({ qboMilestoneInvoicing: false });
    listMilestoneDefinitions.mockResolvedValue(DEFS);
    await handleOpportunityWon({ locationId: LOC, payload: wonPayload() });
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });
});

describe('invoiceDueMilestones — no item means the milestone waits, never fails', () => {
  const due = (id, locationId = LOC) => ({
    id,
    locationId,
    opportunityId: `opp-${id}`,
    qbCustomerId: '58',
    milestoneType: 'def-deposit',
    label: 'Deposit',
    amountCents: 250000,
    awaitsDate: false,
    milestoneDate: null,
    invoiceLeadDays: 0,
    status: 'pending',
  });

  it('with NO item chosen: no invoice, no status change, one qbo_milestone_item_missing row per location', async () => {
    h.selectResults.set(qbMilestones, [due('m1'), due('m2'), due('m3', 'loc-other')]);
    listMappers.mockResolvedValue([]);

    const invoiced = await invoiceDueMilestones();

    expect(invoiced).toBe(0);
    expect(createInvoice).not.toHaveBeenCalled();
    // Above all: nothing was marked 'failed' — that status is terminal and nothing retries it.
    expect(h.updates).toHaveLength(0);
    expect(recordThrown).not.toHaveBeenCalled();

    expect(recordError).toHaveBeenCalledTimes(2);
    const byLoc = Object.fromEntries(recordError.mock.calls.map(([e]) => [e.locationId, e]));
    expect(byLoc[LOC]).toMatchObject({
      kind: 'qbo_milestone_item_missing',
      appSlug: 'quickbooks',
      upstream: 'qbo',
      context: { waitingMilestones: 2, configuredMappings: 0 },
    });
    expect(byLoc[LOC].message).toMatch(/waiting, not failed/);
    expect(byLoc['loc-other'].context.waitingMilestones).toBe(1);

    // Two calls are not two ROWS unless error_events tells them apart: it keeps one open row
    // per fingerprint, and the tenant's page reads rows by location. recordError is mocked
    // above, so ask the real fingerprint whether these two land on separate rows.
    const { buildFingerprint } = await vi.importActual('./errorLogService.js');
    expect(buildFingerprint(byLoc[LOC])).not.toBe(buildFingerprint(byLoc['loc-other']));
  });

  it('with TWO items left over from the old setup: waits the same way, and says why', async () => {
    h.selectResults.set(qbMilestones, [due('m1')]);
    listMappers.mockResolvedValue([
      { externalKey: '49', ghlValue: '49' },
      { externalKey: '50', ghlValue: '50' },
    ]);

    await invoiceDueMilestones();

    expect(createInvoice).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError.mock.calls[0][0].context.configuredMappings).toBe(2);
    expect(recordError.mock.calls[0][0].message).toMatch(/2 QuickBooks items/);
  });

  it('with ONE item chosen: bills exactly that item and marks the milestone invoiced', async () => {
    h.selectResults.set(qbMilestones, [due('m1')]);
    listMappers.mockResolvedValue([{ externalKey: '49', ghlValue: '49' }]);
    createInvoice.mockResolvedValue({ Id: '1001' });

    const invoiced = await invoiceDueMilestones();

    expect(invoiced).toBe(1);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0][1]).toMatchObject({ itemRef: '49', qbCustomerId: '58', amountCents: 250000 });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].values).toMatchObject({ status: 'invoiced', qbInvoiceId: '1001' });
    expect(recordError).not.toHaveBeenCalled();
  });

  it('a milestone that waited bills on the first run after an item is picked', async () => {
    h.selectResults.set(qbMilestones, [due('m1')]);
    listMappers.mockResolvedValue([]);
    await invoiceDueMilestones();
    expect(createInvoice).not.toHaveBeenCalled();

    // Same pending row next run (nothing changed it), now with an item.
    listMappers.mockResolvedValue([{ externalKey: '49', ghlValue: '49' }]);
    createInvoice.mockResolvedValue({ Id: '1002' });
    expect(await invoiceDueMilestones()).toBe(1);
    expect(createInvoice.mock.calls[0][1].itemRef).toBe('49');
  });
});

describe('pollWonOpportunities — reads every page it needs, carries the pipeline', () => {
  const oppAt = (id, pipelineId, iso, created = iso) => ({
    id, status: 'won', pipelineId, contactId: `c-${id}`, updatedAt: iso, createdAt: created,
  });

  function stubGhl(pages) {
    const searches = [];
    makeGhlRequest.mockImplementation(async (_loc, _method, path) => {
      if (path.startsWith('/opportunities/search')) {
        searches.push(path);
        return pages[searches.length - 1] ?? { opportunities: [], meta: { nextPageUrl: null } };
      }
      if (path.startsWith('/opportunities/')) {
        const id = path.split('/')[2];
        const all = pages.flatMap((p) => p.opportunities ?? []);
        const o = all.find((x) => x.id === id);
        return {
          opportunity: {
            ...o,
            customFields: [{ id: 'f_dep', value: '2500' }],
          },
        };
      }
      if (path.startsWith('/contacts/')) return { contact: { id: path.split('/')[2], name: 'Test Customer' } };
      throw new Error(`unexpected GHL path ${path}`);
    });
    return searches;
  }

  beforeEach(() => {
    h.selectResults.set(integrationCredentials, [{ locationId: LOC }]);
    h.selectResults.set(qbSyncState, [{ locationId: LOC, lastWonPollAt: new Date('2026-10-01T00:00:00Z') }]);
  });

  it('follows the cursor to page 2 and schedules a deal it would have missed on page 1 alone', async () => {
    const searches = stubGhl([
      {
        opportunities: [oppAt('o1', POST_FRAME, '2026-10-04T00:00:00Z')],
        meta: { nextPageUrl: 'https://services.leadconnectorhq.com/opportunities/search?x=1', startAfter: 1, startAfterId: 'o1' },
      },
      {
        opportunities: [oppAt('o2', POST_FRAME, '2026-10-03T00:00:00Z')],
        meta: { nextPageUrl: null },
      },
    ]);

    const processed = await pollWonOpportunities();

    expect(searches).toHaveLength(2);
    for (const p of searches) expect(p).toMatch(/status=won/);
    expect(searches[1]).toMatch(/startAfterId=o1/);
    expect(processed).toBe(2);
    // Both deals scheduled, each carrying its pipeline through to the handler.
    expect(h.inserts.filter((i) => i.table === qbMilestones).map((i) => i.rows[0].opportunityId)).toEqual(['o1', 'o2']);
    // Cursor advanced after a clean walk.
    expect(h.inserts.some((i) => i.table === qbSyncState)).toBe(true);
  });

  it('skips a deal in an unbilled pipeline before spending GHL calls on it', async () => {
    stubGhl([{
      opportunities: [oppAt('o-shed', SHEDS, '2026-10-04T00:00:00Z'), oppAt('o-pf', POST_FRAME, '2026-10-04T00:00:00Z')],
      meta: { nextPageUrl: null },
    }]);

    await pollWonOpportunities();

    const paths = makeGhlRequest.mock.calls.map((c) => c[2]);
    expect(paths).not.toContain('/opportunities/o-shed');
    expect(paths).toContain('/opportunities/o-pf');
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
  });

  it('stops at the first page that is entirely older than the last poll, in update order', async () => {
    const searches = stubGhl([
      {
        opportunities: [oppAt('o1', POST_FRAME, '2026-10-04T00:00:00Z')],
        meta: { startAfter: 1, startAfterId: 'o1' },
      },
      {
        // Update times fall and creation times go both ways: provably update order.
        opportunities: [
          oppAt('old1', POST_FRAME, '2026-09-30T00:00:00Z', '2026-06-01T00:00:00Z'),
          oppAt('old2', POST_FRAME, '2026-09-25T00:00:00Z', '2026-08-01T00:00:00Z'),
          oppAt('old3', POST_FRAME, '2026-09-20T00:00:00Z', '2026-07-01T00:00:00Z'),
        ],
        meta: { startAfter: 2, startAfterId: 'old3' },
      },
      { opportunities: [oppAt('never', POST_FRAME, '2026-10-05T00:00:00Z')], meta: { nextPageUrl: null } },
    ]);

    await pollWonOpportunities();

    expect(searches).toHaveLength(2);
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(1);
  });

  it('stops at the page cap, records it, and still advances the cursor', async () => {
    let n = 0;
    makeGhlRequest.mockImplementation(async (_loc, _method, path) => {
      if (path.startsWith('/opportunities/search')) {
        n += 1;
        // Old deals in creation order: never "caught up", always another page.
        return {
          opportunities: [oppAt(`a${n}`, SHEDS, '2026-09-01T00:00:00Z'), oppAt(`b${n}`, SHEDS, '2026-09-02T00:00:00Z')],
          meta: { startAfter: n, startAfterId: `b${n}` },
        };
      }
      throw new Error(`unexpected GHL path ${path}`);
    });

    await pollWonOpportunities();

    expect(n).toBe(20);
    const truncated = recordError.mock.calls.map(([e]) => e).filter((e) => e.kind === 'milestone_won_poll_truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0].locationId).toBe(LOC);
    expect(h.inserts.some((i) => i.table === qbSyncState)).toBe(true);
  });

  it('does not touch GoHighLevel for a location with no definitions', async () => {
    listMilestoneDefinitions.mockResolvedValue([]);
    await pollWonOpportunities();
    expect(makeGhlRequest).not.toHaveBeenCalled();
  });
});
