import { db } from '../core/db/client.js';
import { locationSettings } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';

// Per-tenant QuickBooks feature configuration. Both models default OFF so
// connecting QuickBooks never silently starts syncing before the tenant opts in
// (Carolyn 2026-07-15: "can't they be merged and they can use whichever aspects
// they want?"). A missing row is treated as all-defaults.
const DEFAULTS = {
  qboTwoWaySync: false,
  qboMilestoneInvoicing: false,
  qboContactSyncPipelineId: null,
  qboInvoiceLeadDays: 3,
};

/**
 * Read a location's QuickBooks settings. Returns DEFAULTS (merged onto the
 * locationId) when no row exists — callers can always read the flags safely.
 */
export async function getLocationSettings(locationId) {
  const [row] = await db
    .select()
    .from(locationSettings)
    .where(eq(locationSettings.locationId, locationId))
    .limit(1);
  return row ?? { locationId, ...DEFAULTS };
}

/**
 * Create or update a location's QuickBooks settings. Only the fields present in
 * `fields` are changed; everything else keeps its stored (or default) value.
 */
export async function upsertLocationSettings(locationId, fields = {}) {
  const set = {};
  if (fields.qboTwoWaySync !== undefined) set.qboTwoWaySync = !!fields.qboTwoWaySync;
  if (fields.qboMilestoneInvoicing !== undefined) {
    set.qboMilestoneInvoicing = !!fields.qboMilestoneInvoicing;
  }
  if (fields.qboContactSyncPipelineId !== undefined) {
    const v = fields.qboContactSyncPipelineId;
    set.qboContactSyncPipelineId = v ? String(v) : null;
  }
  if (fields.qboInvoiceLeadDays !== undefined) {
    const n = Number(fields.qboInvoiceLeadDays);
    set.qboInvoiceLeadDays = Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULTS.qboInvoiceLeadDays;
  }

  const [row] = await db
    .insert(locationSettings)
    .values({ locationId, ...DEFAULTS, ...set })
    .onConflictDoUpdate({
      target: locationSettings.locationId,
      set: { ...set, updatedAt: new Date() },
    })
    .returning();

  return row;
}
