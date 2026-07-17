import { db } from '../core/db/client.js';
import { qbMilestones, qbSyncState, integrationCredentials } from '../core/db/schema.js';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getMappings } from './mapperService.js';
import { findOrCreateCustomer, createInvoice } from './quickbooksService.js';
import { makeGhlRequest } from './ghlService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';

// Milestone types in invoicing order. 'deposit' has no date — it is invoiced
// immediately once the opportunity is won.
export const MILESTONE_TYPES = [
  'deposit',
  'materials_delivery',
  'roof_completion',
  'project_completion',
];

const MILESTONE_LABELS = {
  deposit: 'Deposit',
  materials_delivery: 'Materials Delivery',
  roof_completion: 'Roof Completion',
  project_completion: 'Project Completion',
};

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
 * GHL "opportunity Won" handler (Yoder Barnes model).
 * 1. Creates/finds the QBO customer for the opportunity's contact.
 * 2. Reads milestone amounts + dates from the payload using this location's
 *    mappers (appSlug 'quickbooks', types 'milestone_amount'/'milestone_date').
 * 3. Persists qb_milestones rows; the scheduler invoices them when due.
 */
export async function handleOpportunityWon({ locationId, payload }) {
  // Only act for locations subscribed to QuickBooks (or Suite).
  if (!(await hasAccess(locationId, 'quickbooks'))) {
    console.log(`[yoder] location ${locationId} has no quickbooks access — skipping`);
    return;
  }

  // Only act for locations that have opted into milestone invoicing (Yoder
  // model). A Rockwood-only tenant should never get milestone invoices.
  const settings = await getLocationSettings(locationId);
  if (!settings.qboMilestoneInvoicing) {
    console.log(`[yoder] location ${locationId} milestone invoicing disabled — skipping`);
    return;
  }

  // If the event carries a stage/status, only act on Won.
  const status = (payload.status ?? payload.opportunity?.status ?? '').toString().toLowerCase();
  if (status && status !== 'won' && status !== 'open won') {
    return;
  }

  const opportunityId =
    payload.opportunityId ?? payload.opportunity_id ?? payload.opportunity?.id;
  if (!opportunityId) throw new Error('Missing opportunity id in Won payload');

  const contact = extractContact(payload);
  const customer = await findOrCreateCustomer(locationId, contact);

  const amountFields = await getMappings(locationId, 'quickbooks', 'milestone_amount');
  const dateFields = await getMappings(locationId, 'quickbooks', 'milestone_date');

  const rows = [];
  for (const type of MILESTONE_TYPES) {
    const amountCents = parseAmountCents(getPayloadField(payload, amountFields[type]));
    if (amountCents == null) continue; // milestone not configured or empty for this deal

    rows.push({
      id: randomUUID(),
      locationId,
      opportunityId: String(opportunityId),
      contactId: payload.contactId ?? payload.contact?.id ?? null,
      qbCustomerId: String(customer.Id),
      milestoneType: type,
      amountCents,
      milestoneDate: parseDate(getPayloadField(payload, dateFields[type])),
      invoiceLeadDays: settings.qboInvoiceLeadDays,
    });
  }

  if (!rows.length) {
    console.warn(`[yoder] opportunity ${opportunityId}: no milestone amounts found in payload`);
    return;
  }

  // Idempotent per (location, opportunity, milestoneType) — re-delivered Won
  // events don't duplicate milestones.
  await db.insert(qbMilestones).values(rows).onConflictDoNothing();
  console.log(`[yoder] opportunity ${opportunityId}: stored ${rows.length} milestone(s), QB customer ${customer.Id}`);
}

/**
 * Scheduler job: invoice pending milestones that are due.
 * A milestone is due when it has no date (deposit — invoice immediately) or
 * when now >= milestoneDate - invoiceLeadDays.
 */
export async function invoiceDueMilestones() {
  const due = await db
    .select()
    .from(qbMilestones)
    .where(
      and(
        eq(qbMilestones.status, 'pending'),
        or(
          isNull(qbMilestones.milestoneDate),
          sql`${qbMilestones.milestoneDate} - make_interval(days => ${qbMilestones.invoiceLeadDays}) <= now()`,
        ),
      ),
    );

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

  let invoiced = 0;
  for (const m of due) {
    if (!(await invoicingEnabled(m.locationId))) continue;
    try {
      const invoice = await createInvoice(m.locationId, {
        qbCustomerId: m.qbCustomerId,
        amountCents: m.amountCents,
        description: `${MILESTONE_LABELS[m.milestoneType] ?? m.milestoneType} — opportunity ${m.opportunityId}`,
        dueDate: m.milestoneDate ? m.milestoneDate.toISOString().slice(0, 10) : undefined,
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
      console.log(`[yoder] invoiced milestone ${m.milestoneType} for opportunity ${m.opportunityId} (QB invoice ${invoice.Id})`);
    } catch (err) {
      await db
        .update(qbMilestones)
        .set({ status: 'failed', error: err.message, updatedAt: new Date() })
        .where(eq(qbMilestones.id, m.id));
      console.error(`[yoder] failed to invoice milestone ${m.id}:`, err.message);
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
      console.error(`[yoder] won-poll failed for ${locationId}:`, err.message);
    }
  }

  return processed;
}
