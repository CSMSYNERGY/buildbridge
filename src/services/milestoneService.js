import { db } from '../core/db/client.js';
import { qbMilestones } from '../core/db/schema.js';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getMappings } from './mapperService.js';
import { findOrCreateCustomer, createInvoice } from './quickbooksService.js';
import { hasAccess } from './subscriptionService.js';

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
      if (hit !== undefined) return hit.value ?? hit.field_value;
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
  const name =
    c.name ??
    payload.full_name ??
    payload.contact_name ??
    [payload.first_name, payload.last_name].filter(Boolean).join(' ') ??
    null;
  return {
    name: name || null,
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

  for (const m of due) {
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

      console.log(`[yoder] invoiced milestone ${m.milestoneType} for opportunity ${m.opportunityId} (QB invoice ${invoice.Id})`);
    } catch (err) {
      await db
        .update(qbMilestones)
        .set({ status: 'failed', error: err.message, updatedAt: new Date() })
        .where(eq(qbMilestones.id, m.id));
      console.error(`[yoder] failed to invoice milestone ${m.id}:`, err.message);
    }
  }

  return due.length;
}
