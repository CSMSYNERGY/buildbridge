import { db } from '../core/db/client.js';
import { qbMilestones, qbSyncState, integrationCredentials } from '../core/db/schema.js';
import { eq, and, or, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { listMappers } from './mapperService.js';
import { resolveItemRef, milestoneIsDue } from './qbSyncLogic.js';
import { findOrCreateCustomer, createInvoice } from './quickbooksService.js';
import { makeGhlRequest } from './ghlService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';
import { listMilestoneDefinitions } from './milestoneDefinitionsService.js';
import { recordThrown } from './errorLogService.js';

/**
 * Read a value out of a GHL webhook payload. Supports:
 *  - dot-paths into the payload ('opportunity.deposit_amount')
 *  - customFields as an object map ({ field_key: value })
 *  - customFields as an array ([{ key|fieldKey|id, value }])
 */
export function getPayloadField(payload, fieldKey) {
  if (!fieldKey) return undefined;

  const cf = payload.customFields ?? payload.custom_fields;
  if (cf) {
    if (Array.isArray(cf)) {
      const hit = cf.find(
        (f) => f.key === fieldKey || f.fieldKey === fieldKey || f.id === fieldKey,
      );
      if (hit !== undefined) return hit.value ?? hit.fieldValue ?? hit.field_value;
    } else if (typeof cf === 'object' && cf[fieldKey] !== undefined) {
      return cf[fieldKey];
    }
  }

  // Dot-path fallback
  let node = payload;
  for (const part of fieldKey.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/** Parse "$12,500.00" / "12500" / 12500.5 → integer cents (null if unparseable). */
export function parseAmountCents(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

/** Parse a date-ish value → Date (null if unparseable). */
export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

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
 * 1. Creates/finds the QBO customer for the opportunity's contact.
 * 2. Reads each configured milestone's amount + date from the payload, using this
 *    location's own milestone definitions (qb_milestone_definitions, migration 0007).
 * 3. Persists qb_milestones rows; the scheduler invoices each one when it comes due.
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

  const contact = extractContact(payload);
  const customer = await findOrCreateCustomer(locationId, contact);

  const rows = [];
  for (const def of definitions) {
    const amountCents = parseAmountCents(getPayloadField(payload, def.amountField));
    // No amount on THIS deal → this milestone doesn't apply to it. Normal and expected:
    // a client bills a roof milestone only on jobs that have a roof.
    if (amountCents == null) continue;

    rows.push({
      id: randomUUID(),
      locationId,
      opportunityId: String(opportunityId),
      contactId: payload.contactId ?? payload.contact?.id ?? null,
      qbCustomerId: String(customer.Id),
      // The definition id, not a slug: labels are editable, and the unique index below is
      // the idempotency key, so renaming a milestone must not fork it into a new row.
      milestoneType: String(def.id),
      amountCents,
      // Snapshots — the definition may be edited or deleted after this point, and neither
      // the invoice description nor the due rule may change retroactively.
      label: def.label,
      awaitsDate: !!def.dateField,
      milestoneDate: def.dateField ? parseDate(getPayloadField(payload, def.dateField)) : null,
      invoiceLeadDays: settings.qboInvoiceLeadDays,
    });
  }

  if (!rows.length) {
    console.warn(`[milestone] opportunity ${opportunityId}: no milestone amounts found in payload`);
    return;
  }

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
  // Milestone invoicing has no per-deal GHL field context, so this resolves to
  // the tenant's single mapped item as the line item (or null → QBO default '1').
  const itemRefByLocation = new Map();
  async function itemRefFor(locId) {
    if (!itemRefByLocation.has(locId)) {
      const maps = await listMappers(locId, 'quickbooks', 'qb_item');
      const ref = resolveItemRef(maps);
      // Milestone invoicing has no per-deal GHL field context, so item selection
      // only works with a SINGLE mapped item. If a location mapped 2+ items,
      // resolveItemRef returns null and we'd silently bill QBO's default item —
      // warn loudly instead of failing silently (see also the estimate path,
      // which DOES resolve per-deal).
      if (ref === null && maps.length > 1) {
        console.warn(
          `[milestone] location ${locId} has ${maps.length} qb_item mappings but milestone invoicing ` +
          `can't pick per-deal — invoices will use QBO's default item. Map exactly one item for milestone invoicing.`,
        );
      }
      itemRefByLocation.set(locId, ref);
    }
    return itemRefByLocation.get(locId);
  }

  let invoiced = 0;
  for (const m of due) {
    if (!(await invoicingEnabled(m.locationId))) continue;
    try {
      const invoice = await createInvoice(m.locationId, {
        qbCustomerId: m.qbCustomerId,
        amountCents: m.amountCents,
        // The label snapshotted when this milestone was scheduled, so the invoice reads the
        // way the client named it. Falls back to the definition id only for rows written
        // before 0007 added the column (none in production, but cheap insurance).
        description: `${m.label || m.milestoneType} — opportunity ${m.opportunityId}`,
        dueDate: m.milestoneDate ? m.milestoneDate.toISOString().slice(0, 10) : undefined,
        itemRef: await itemRefFor(m.locationId),
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

  return invoiced;
}

// ─── Won polling (webhook-free alternative) ───────────────────────────────────
// So a reseller client doesn't have to build a GHL workflow → custom-webhook to
// fire opportunity.won: poll GHL for recently-won opportunities and feed each
// through handleOpportunityWon (idempotent per location+opportunity+milestone).

const WON_POLL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // first poll looks back 7 days

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

      const data = await makeGhlRequest(
        locationId,
        'GET',
        `/opportunities/search?location_id=${encodeURIComponent(locationId)}&status=won&limit=100`,
      );
      const opps = data?.opportunities ?? [];

      for (const opp of opps) {
        const updatedAt = opp.updatedAt ?? opp.dateUpdated;
        if (updatedAt && new Date(updatedAt) <= since) continue; // already seen

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

      await setWonPollState(locationId, startedAt);
    } catch (err) {
      console.error(`[milestone] won-poll failed for ${locationId}:`, err.message);
    }
  }

  return processed;
}
