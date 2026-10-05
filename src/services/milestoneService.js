import { db } from '../core/db/client.js';
import { qbMilestones, qbSyncState, integrationCredentials } from '../core/db/schema.js';
import { eq, and, or, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { listMappers } from './mapperService.js';
import {
  resolveItemRef,
  milestoneIsDue,
  buildMilestoneRows,
  definitionAppliesToPipeline,
  opportunityPipelineId,
  wonSearchPath,
  nextWonSearchCursor,
  sameWonSearchCursor,
  wonPollPage,
} from './qbSyncLogic.js';
import { findOrCreateCustomer, createInvoice } from './quickbooksService.js';
import { makeGhlRequest } from './ghlService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';
import { listMilestoneDefinitions } from './milestoneDefinitionsService.js';
import { recordThrown, recordError } from './errorLogService.js';

// The payload readers moved to qbSyncLogic.js (import-free, unit-tested) with
// buildMilestoneRows. Re-exported so nothing that imported them from here breaks.
export { getPayloadField, parseAmountCents, parseDate } from './qbSyncLogic.js';

function extractContact(payload) {
  const c = payload.contact ?? {};
  const firstName = c.firstName ?? payload.first_name ?? null;
  const lastName = c.lastName ?? payload.last_name ?? null;
  const name =
    c.name ??
    payload.full_name ??
    payload.contact_name ??
    ([firstName, lastName].filter(Boolean).join(' ') || null);
  return {
    name: name || null,
    firstName: firstName || null,
    lastName: lastName || null,
    email: c.email ?? payload.email ?? null,
    phone: c.phone ?? payload.phone ?? null,
  };
}

/**
 * GHL "opportunity Won" handler — schedules this deal's milestone invoices.
 *
 * 1. Works out which milestones this deal is owed: this location's own definitions
 *    (qb_milestone_definitions, migration 0007), limited to the deal's pipeline (0012), and
 *    only those whose amount field is filled on this deal. See buildMilestoneRows.
 * 2. ONLY IF that leaves something to bill, creates/finds the QBO customer for the contact.
 * 3. Persists qb_milestones rows; the scheduler invoices each one when it comes due.
 *
 * The order of 1 and 2 is load-bearing. It used to be the other way round, so once a location
 * had any definition at all, every Won deal in every pipeline created a QuickBooks customer —
 * a shed sale in a client who bills only post-frame jobs in stages, or a deal with no
 * milestone amounts on it, still wrote a customer into the client's books.
 *
 * Won is the GATE, not the whole trigger. A milestone with a date field is scheduled here
 * but stays `pending` until that date field is filled and its lead time arrives — see
 * milestoneIsDue. Re-running this for the same opportunity UPDATES pending milestones, so
 * a date filled in after the deal was Won is picked up (see the upsert below).
 */
export async function handleOpportunityWon({ eventType, locationId, payload }) {
  // Only act for locations subscribed to QuickBooks (or Suite).
  if (!(await hasAccess(locationId, 'quickbooks'))) {
    console.log(`[milestone] location ${locationId} has no quickbooks access — skipping`);
    return;
  }

  // Only act for locations that have opted into milestone invoicing (Yoder
  // model). A Rockwood-only tenant should never get milestone invoices.
  const settings = await getLocationSettings(locationId);
  if (!settings.qboMilestoneInvoicing) {
    console.log(`[milestone] location ${locationId} milestone invoicing disabled — skipping`);
    return;
  }

  // Require an actual Won. The explicit 'opportunity.won' event is Won by
  // definition; a generic 'opportunity.stage_change' must carry status=Won —
  // otherwise a move to ANY stage would wrongly create milestones.
  const status = (payload.status ?? payload.opportunity?.status ?? '').toString().toLowerCase();
  const isWon = eventType === 'opportunity.won' || status === 'won' || status === 'open won';
  if (!isWon) {
    return;
  }

  const opportunityId =
    payload.opportunityId ?? payload.opportunity_id ?? payload.opportunity?.id;
  if (!opportunityId) throw new Error('Missing opportunity id in Won payload');

  // This location's own milestone configuration. No definitions = nothing to schedule;
  // bail before touching QuickBooks so an unconfigured tenant never creates a customer.
  const definitions = await listMilestoneDefinitions(locationId);
  if (!definitions.length) {
    console.log(`[milestone] location ${locationId} has no milestones configured — skipping`);
    return;
  }

  // Decide what this deal is owed BEFORE QuickBooks is touched. Pure: no customer, no
  // request, no row unless at least one milestone in this deal's pipeline has an amount.
  const planned = buildMilestoneRows(definitions, payload, settings);
  if (!planned.length) {
    const pipelineId = opportunityPipelineId(payload);
    const inPipeline = definitions.filter((d) => definitionAppliesToPipeline(d, pipelineId)).length;
    console.log(
      inPipeline
        ? `[milestone] opportunity ${opportunityId}: no milestone amounts found in payload — nothing to bill`
        : `[milestone] opportunity ${opportunityId}: no milestone applies to pipeline ${pipelineId ?? '(unknown)'} — nothing to bill`,
    );
    return;
  }

  const contact = extractContact(payload);
  const customer = await findOrCreateCustomer(locationId, contact);

  const rows = planned.map((m) => ({
    id: randomUUID(),
    locationId,
    opportunityId: String(opportunityId),
    contactId: payload.contactId ?? payload.contact?.id ?? null,
    qbCustomerId: String(customer.Id),
    ...m,
  }));

  // Idempotent per (location, opportunity, milestone) — a re-delivered Won event does not
  // duplicate milestones.
  //
  // But it is an UPDATE, not a no-op, and that is the mechanism behind "filling the date
  // field is what creates the invoice". A date typed in after the deal was Won arrives
  // here on the next webhook or poller pass, and this updates the still-pending row.
  // Previously this was onConflictDoNothing, so a late-filled date was silently discarded
  // and the milestone kept whatever (usually empty) date it had at Won time.
  //
  // `setWhere` confines that to PENDING rows: an already-invoiced or failed milestone is
  // billing history and must never be rewritten by a later edit upstream.
  await db
    .insert(qbMilestones)
    .values(rows)
    .onConflictDoUpdate({
      target: [qbMilestones.locationId, qbMilestones.opportunityId, qbMilestones.milestoneType],
      set: {
        amountCents: sql`excluded.amount_cents`,
        milestoneDate: sql`excluded.milestone_date`,
        label: sql`excluded.label`,
        awaitsDate: sql`excluded.awaits_date`,
        updatedAt: new Date(),
      },
      setWhere: eq(qbMilestones.status, 'pending'),
    });
  console.log(`[milestone] opportunity ${opportunityId}: scheduled ${rows.length} milestone(s), QB customer ${customer.Id}`);
}

/**
 * Scheduler job: invoice pending milestones that are due.
 *
 * Due means (see milestoneIsDue in qbSyncLogic.js, which is the single authority):
 *   - no date field configured  → due as soon as the deal is Won
 *   - date field configured     → due `invoiceLeadDays` before that date, and NOT due at
 *                                 all until the date has actually been filled in
 *
 * The SQL below narrows; `milestoneIsDue` decides. Note the difference from before: a
 * milestone awaiting a date that has not been filled is no longer swept up by the
 * `milestone_date IS NULL` branch and billed immediately.
 */
export async function invoiceDueMilestones() {
  // Deliberately a broad SUPERSET, not the exact rule: pending, and either it doesn't wait
  // for a date or its date is now known. The precise lead-time arithmetic is applied by
  // milestoneIsDue below. Keeping the rule in one tested JS function instead of duplicating
  // it in SQL means the two can never drift into disagreeing about whether to bill someone.
  const candidates = await db
    .select()
    .from(qbMilestones)
    .where(
      and(
        eq(qbMilestones.status, 'pending'),
        or(
          eq(qbMilestones.awaitsDate, false),
          isNotNull(qbMilestones.milestoneDate),
        ),
      ),
    );

  // Re-check in JS so the rule lives in exactly one tested place, and so a SQL/JS
  // disagreement can only ever be conservative (skip), never an unwanted invoice.
  const now = new Date();
  const due = candidates.filter((m) => milestoneIsDue(m, now));

  // Respect the per-tenant toggle: don't invoice milestones for a location that
  // has since disabled milestone invoicing (cached per location for this run).
  const enabledByLocation = new Map();
  async function invoicingEnabled(locId) {
    if (!enabledByLocation.has(locId)) {
      const s = await getLocationSettings(locId);
      enabledByLocation.set(locId, s.qboMilestoneInvoicing);
    }
    return enabledByLocation.get(locId);
  }

  // Per-location QBO item mapping (mapperType 'qb_item'), cached for this run.
  // Milestone invoicing has no per-deal GHL field context, so this resolves to the
  // tenant's single mapped item as the line item, or null when there is none to use.
  const itemByLocation = new Map();
  async function itemRefFor(locId) {
    if (!itemByLocation.has(locId)) {
      const maps = await listMappers(locId, 'quickbooks', 'qb_item');
      // Item selection here only works with a SINGLE mapped item. With 2+ (left over from
      // the older Item Mappings card) resolveItemRef returns null, exactly as with none.
      itemByLocation.set(locId, { ref: resolveItemRef(maps), mappings: maps.length });
    }
    return itemByLocation.get(locId);
  }

  // Locations whose due milestones are WAITING for an item to be chosen: locationId →
  // { waiting, mappings }. Reported once per location below, not once per milestone.
  const waitingForItem = new Map();

  let invoiced = 0;
  for (const m of due) {
    if (!(await invoicingEnabled(m.locationId))) continue;

    // No item ⇒ the milestone stays 'pending' and is NOT attempted. It used to go out billed
    // as QuickBooks item '1' — whatever that happens to be in this company, or a 400 where
    // there is no item 1 — and a 400 here marks the milestone 'failed', which is terminal:
    // nothing ever retries it. Waiting instead means it bills on the first run after the
    // client picks an item, with no one having to find and re-queue it.
    //
    // Deliberately OUTSIDE the try below. If the mapping lookup itself fails (our database,
    // not QuickBooks), the run throws to the scheduler and is recorded as cron_job_failed with
    // every milestone still pending. Inside the try it would mark this milestone 'failed'.
    const item = await itemRefFor(m.locationId);
    if (!item.ref) {
      const w = waitingForItem.get(m.locationId) ?? { waiting: 0, mappings: item.mappings };
      w.waiting += 1;
      waitingForItem.set(m.locationId, w);
      continue;
    }

    try {
      const invoice = await createInvoice(m.locationId, {
        qbCustomerId: m.qbCustomerId,
        amountCents: m.amountCents,
        // The label snapshotted when this milestone was scheduled, so the invoice reads the
        // way the client named it. Falls back to the definition id only for rows written
        // before 0007 added the column (none in production, but cheap insurance).
        description: `${m.label || m.milestoneType} — opportunity ${m.opportunityId}`,
        dueDate: m.milestoneDate ? m.milestoneDate.toISOString().slice(0, 10) : undefined,
        itemRef: item.ref,
      });

      await db
        .update(qbMilestones)
        .set({
          status: 'invoiced',
          qbInvoiceId: String(invoice.Id),
          invoicedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(qbMilestones.id, m.id));

      invoiced++;
      console.log(`[milestone] invoiced "${m.label || m.milestoneType}" for opportunity ${m.opportunityId} (QB invoice ${invoice.Id})`);
    } catch (err) {
      await db
        .update(qbMilestones)
        .set({ status: 'failed', error: err.message, updatedAt: new Date() })
        .where(eq(qbMilestones.id, m.id));
      console.error(`[milestone] failed to invoice milestone ${m.id}:`, err.message);
      // Also record durably. A failed milestone means a client did not get billed, and
      // `status='failed'` is terminal — nothing retries it. Previously the only trace was
      // this console line plus the row's `error` column, so once the tail closed the
      // failure was invisible; now it surfaces in error_events and therefore in the
      // QuickBooks page's open-problems list.
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'milestone_invoice_failed',
        appSlug: 'quickbooks',
        locationId: m.locationId,
        context: {
          job: 'yoder-invoice-due-milestones',
          milestoneId: m.id,
          opportunityId: m.opportunityId,
          milestone: m.label || m.milestoneType,
        },
      });
    }
  }

  // One durable, actionable row per location per run: this is a single configuration gap, not
  // N separate failures. Re-recorded every run while anything waits, so it stays current on the
  // QuickBooks page until an item is picked, and stops by itself once the milestones bill.
  //
  // Per location only because error_events fingerprints include the location id. Before that,
  // the same gap at a second location merged into the first location's open row, and the second
  // location's page never showed it.
  //
  // Its own kind, not the estimate sync's qbo_item_mapping_missing: the two read as different
  // sentences, so a location that only syncs estimates is never told about milestone invoices.
  for (const [locId, w] of waitingForItem) {
    const why = w.mappings > 1
      ? `${w.mappings} QuickBooks items are saved for this location from the older setup, and a milestone invoice cannot choose between them per deal`
      : 'no QuickBooks item is chosen for this location';
    console.warn(`[milestone] location ${locId}: ${w.waiting} due milestone(s) waiting — ${why}`);
    await recordError({
      source: 'cron',
      kind: 'qbo_milestone_item_missing',
      appSlug: 'quickbooks',
      locationId: locId,
      upstream: 'qbo',
      message: `${w.waiting} milestone invoice(s) are due but were not created: ${why}, and QuickBooks needs an item to bill. They are waiting, not failed. Pick one in BuildBridge → QuickBooks under "Bill milestone invoices as"; they are created on the next run after that.`,
      context: {
        job: 'yoder-invoice-due-milestones',
        waitingMilestones: w.waiting,
        configuredMappings: w.mappings,
      },
    });
  }

  return invoiced;
}

// ─── Won polling (webhook-free alternative) ───────────────────────────────────
// So a reseller client doesn't have to build a GHL workflow → custom-webhook to
// fire opportunity.won: poll GHL for recently-won opportunities and feed each
// through handleOpportunityWon (idempotent per location+opportunity+milestone).

const WON_POLL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // first poll looks back 7 days

// How many pages of won deals (100 each) one pass may read for a location. The walk normally
// ends well before this: at GHL's last page, or at the first page that is entirely older than
// the cursor (see wonPollPage). The cap is there so a response that never says "last page"
// cannot keep a cron invocation looping, and hitting it is recorded rather than silent.
const MAX_WON_POLL_PAGES = 20;

async function getWonPollSince(locationId) {
  const [state] = await db
    .select()
    .from(qbSyncState)
    .where(eq(qbSyncState.locationId, locationId))
    .limit(1);
  return state?.lastWonPollAt ?? new Date(Date.now() - WON_POLL_WINDOW_MS);
}

async function setWonPollState(locationId, when) {
  await db
    .insert(qbSyncState)
    .values({ locationId, lastWonPollAt: when })
    .onConflictDoUpdate({
      target: qbSyncState.locationId,
      set: { lastWonPollAt: when, updatedAt: new Date() },
    });
}

// Collect custom fields from an object whether GHL returns them as an array
// ([{id|key|fieldKey, value}]) or an object map, into one array getPayloadField
// understands. Merges opportunity + contact fields so a milestone field resolves
// regardless of which entity SmartBuild wrote it to.
function collectCustomFields(...sources) {
  const out = [];
  for (const cf of sources) {
    if (!cf) continue;
    if (Array.isArray(cf)) out.push(...cf);
    else if (typeof cf === 'object') {
      for (const [key, value] of Object.entries(cf)) out.push({ key, value });
    }
  }
  return out;
}

/**
 * Scheduler job: for every QuickBooks-connected location with milestone
 * invoicing enabled, poll GHL for opportunities won since the last poll and
 * process each as a Won event. Best-effort and idempotent — safe to run
 * alongside the inbound webhook (both paths converge on handleOpportunityWon).
 */
export async function pollWonOpportunities() {
  const rows = await db
    .select({ locationId: integrationCredentials.locationId })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.appSlug, 'quickbooks'));

  let processed = 0;
  for (const { locationId } of rows) {
    try {
      if (!(await hasAccess(locationId, 'quickbooks'))) continue;
      const settings = await getLocationSettings(locationId);
      if (!settings.qboMilestoneInvoicing) continue;

      // Bail BEFORE touching GoHighLevel if this location has nothing configured to bill.
      // handleOpportunityWon checks this too, but by then the damage is done: the poller has
      // already fetched every won opportunity and then made ~3 more GHL calls PER opportunity
      // (detail + contact) before the handler discovers there is nothing to do.
      //
      // Observed in production 2026-07-29: enabling the milestone toggle on a location with
      // zero definitions made every tick fetch 7 opportunities and discard all of them, and
      // partway through the run every database query in the whole cron invocation began
      // failing — including error_events INSERTs, so the failures were not even recorded.
      // A tick has a finite budget of outbound subrequests; spending it on work that is
      // guaranteed to be thrown away starved the two jobs that had real work to do.
      const definitions = await listMilestoneDefinitions(locationId);
      if (!definitions.length) continue;

      const since = await getWonPollSince(locationId);
      const startedAt = new Date();

      // Walk GHL's won-deal list a page at a time. Until 0012 this read only the first 100,
      // so at a location with more won deals than that, a deal further down the list never
      // had its milestones scheduled, and nothing said so.
      const seen = new Set();
      let cursor = null;
      let pages = 0;
      let truncated = false;
      for (;;) {
        const data = await makeGhlRequest(locationId, 'GET', wonSearchPath(locationId, cursor));
        pages += 1;
        const opps = data?.opportunities ?? [];
        const { fresh, caughtUp } = wonPollPage(opps, since);

        for (const opp of fresh) {
          const oppId = String(opp.id);
          if (seen.has(oppId)) continue;
          seen.add(oppId);

          // A deal in a pipeline that no milestone bills is skipped here, before two more GHL
          // calls are spent on it. If the search result does not say which pipeline, fetch the
          // deal anyway and let handleOpportunityWon decide from the full record.
          if (opp.pipelineId && !definitions.some((d) => definitionAppliesToPipeline(d, opp.pipelineId))) {
            continue;
          }

          // Fetch the full opportunity + contact so milestone custom fields are
          // present (search results are typically sparse).
          const detail = await makeGhlRequest(locationId, 'GET', `/opportunities/${opp.id}`).catch(() => null);
          const full = detail?.opportunity ?? opp;
          const contactId = full.contactId ?? full.contact?.id ?? opp.contactId ?? null;

          let contactObj = full.contact ?? null;
          if (contactId) {
            const cRes = await makeGhlRequest(locationId, 'GET', `/contacts/${contactId}`).catch(() => null);
            contactObj = cRes?.contact ?? contactObj;
          }

          const payload = {
            opportunityId: full.id ?? opp.id,
            contactId,
            // Carried so handleOpportunityWon can apply each milestone's pipeline (0012).
            // Without it a pipeline-scoped milestone would never match a polled deal.
            pipelineId: full.pipelineId ?? opp.pipelineId ?? null,
            status: 'won',
            customFields: collectCustomFields(
              full.customFields, full.custom_fields,
              contactObj?.customFields, contactObj?.custom_fields,
            ),
            contact: contactObj ?? undefined,
          };

          await handleOpportunityWon({ locationId, payload });
          processed++;
        }

        if (!opps.length || caughtUp) break;
        const next = nextWonSearchCursor(data?.meta);
        if (!next || sameWonSearchCursor(next, cursor)) break;
        if (pages >= MAX_WON_POLL_PAGES) {
          truncated = true;
          break;
        }
        cursor = next;
      }

      if (truncated) {
        // The cursor still advances below: holding it back would make every later pass re-read
        // the same ever-growing window and spend more each time. Recorded instead, so a
        // location this size is noticed and the cap raised, rather than deals quietly missed.
        console.warn(`[milestone] won-poll for ${locationId} stopped at the ${MAX_WON_POLL_PAGES}-page cap`);
        await recordError({
          source: 'cron',
          kind: 'milestone_won_poll_truncated',
          appSlug: 'quickbooks',
          locationId,
          message: `Won-deal poll read ${pages} pages (up to ${pages * 100} won opportunities) and stopped at the cap without reaching deals older than the last poll. A deal further down GoHighLevel's list may not have had its milestones scheduled this pass.`,
          context: { job: 'yoder-poll-won', pages, cap: MAX_WON_POLL_PAGES },
        });
      }

      await setWonPollState(locationId, startedAt);
    } catch (err) {
      console.error(`[milestone] won-poll failed for ${locationId}:`, err.message);
    }
  }

  return processed;
}
