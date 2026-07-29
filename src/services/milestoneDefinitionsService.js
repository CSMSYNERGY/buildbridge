import { db } from '../core/db/client.js';
import { qbMilestoneDefinitions } from '../core/db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { createError } from '../core/middleware/errorHandler.js';
import { normalizeMilestoneInput } from './qbSyncLogic.js';

// ─── Per-client milestone configuration (migration 0007) ──────────────────────
// A milestone is not a name we choose — it is a pair of the CLIENT's own GHL opportunity
// fields ("materials delivered dollar amount" + "materials delivered date") plus the label
// that prints on the QuickBooks invoice line. Replaces the four hard-coded types, because
// every client names these differently.
//
// Every function here is location-scoped. There is no cross-location read or write: the id
// alone is never enough to touch a row, which is what keeps one tenant's configuration
// unreachable from another's session.

/** All milestone definitions for a location, in invoicing/display order. */
export async function listMilestoneDefinitions(locationId) {
  return db
    .select()
    .from(qbMilestoneDefinitions)
    .where(eq(qbMilestoneDefinitions.locationId, locationId))
    .orderBy(asc(qbMilestoneDefinitions.sortOrder), asc(qbMilestoneDefinitions.createdAt));
}

/** Shape a row for the API/UI. */
export function serializeDefinition(d) {
  return {
    id: d.id,
    label: d.label,
    amountField: d.amountField,
    dateField: d.dateField ?? null,
    sortOrder: d.sortOrder,
  };
}

// Validation shared by create and update. The rules themselves live in qbSyncLogic's
// pure normalizeMilestoneInput (import-free, unit-tested); this just turns a rejection
// into the HTTP error the client sees.
function normalizeInput(input) {
  const result = normalizeMilestoneInput(input);
  if (!result.ok) throw createError(400, result.error);
  return result.value;
}

export async function createMilestoneDefinition(locationId, input) {
  const values = normalizeInput(input);
  const [row] = await db
    .insert(qbMilestoneDefinitions)
    .values({ id: randomUUID(), locationId, ...values })
    .returning();
  return row;
}

/**
 * Update one definition. Location-scoped, so a definition belonging to another tenant is
 * a 404 rather than a silent no-op — a no-op would report success while changing nothing.
 */
export async function updateMilestoneDefinition(locationId, id, input) {
  const values = normalizeInput(input);
  const [row] = await db
    .update(qbMilestoneDefinitions)
    .set({ ...values, updatedAt: new Date() })
    .where(and(
      eq(qbMilestoneDefinitions.id, id),
      eq(qbMilestoneDefinitions.locationId, locationId),
    ))
    .returning();
  if (!row) throw createError(404, 'Milestone not found.');
  return row;
}

/**
 * Delete one definition.
 *
 * Deliberately leaves existing qb_milestones rows alone. They carry their own `label` and
 * `awaits_date` snapshots (0007) precisely so that removing a definition stops FUTURE
 * scheduling without disturbing milestones already scheduled or invoiced — deleting a
 * config row must never rewrite billing history.
 */
export async function deleteMilestoneDefinition(locationId, id) {
  const [row] = await db
    .delete(qbMilestoneDefinitions)
    .where(and(
      eq(qbMilestoneDefinitions.id, id),
      eq(qbMilestoneDefinitions.locationId, locationId),
    ))
    .returning();
  if (!row) throw createError(404, 'Milestone not found.');
  return row;
}
