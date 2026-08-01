import { db } from '../core/db/client.js';
import { locationSettings } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';

// Per-tenant integration configuration (QuickBooks + IdeaRoom). Everything defaults
// OFF so connecting an integration never silently starts syncing before the tenant
// opts in (Carolyn 2026-07-15: "can't they be merged and they can use whichever
// aspects they want?"). A missing row is treated as all-defaults.
//
// NOTE for anyone adding a field here: `upsertLocationSettings` writes an explicit
// whitelist, so a new column MUST be given both a DEFAULTS entry and its own branch
// below. Miss the branch and writes silently no-op — the caller sees a success
// response and the value never lands.
export const SYNC_DIRECTIONS = ['off', 'qb_to_ghl', 'ghl_to_qb', 'two_way'];

const DEFAULTS = {
  qboSyncDirection: 'off',
  qboMilestoneInvoicing: false,
  qboContactSyncPipelineId: null,
  qboAssignedUserField: null,
  qboAssignedUserGhlField: null,
  qboStatusGhlField: null,
  qboSalespersonQbField: null,
  qboSalespersonSlot: 1,
  qboSalespersonGhlField: null,
  qboInvoiceLeadDays: 3,
  idearoomWebhookToken: null,
  idearoomPipelineId: null,
  idearoomStageId: null,
  idearoomTag: 'idearoom-lead',
  idearoomEnabled: false,
};

/**
 * Read a location's settings. Returns DEFAULTS (merged onto the locationId) when no
 * row exists — callers can always read the flags safely.
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
  if (fields.qboSyncDirection !== undefined) {
    set.qboSyncDirection = SYNC_DIRECTIONS.includes(fields.qboSyncDirection)
      ? fields.qboSyncDirection
      : DEFAULTS.qboSyncDirection;
  }
  if (fields.qboMilestoneInvoicing !== undefined) {
    set.qboMilestoneInvoicing = !!fields.qboMilestoneInvoicing;
  }
  if (fields.qboContactSyncPipelineId !== undefined) {
    const v = fields.qboContactSyncPipelineId;
    set.qboContactSyncPipelineId = v ? String(v) : null;
  }
  if (fields.qboAssignedUserField !== undefined) {
    const v = fields.qboAssignedUserField;
    set.qboAssignedUserField = v ? String(v).trim() : null;
  }
  if (fields.qboAssignedUserGhlField !== undefined) {
    const v = fields.qboAssignedUserGhlField;
    set.qboAssignedUserGhlField = v ? String(v) : null;
  }
  if (fields.qboStatusGhlField !== undefined) {
    const v = fields.qboStatusGhlField;
    set.qboStatusGhlField = v ? String(v) : null;
  }
  if (fields.qboSalespersonQbField !== undefined) {
    const v = fields.qboSalespersonQbField;
    set.qboSalespersonQbField = v ? String(v).trim() : null;
  }
  if (fields.qboSalespersonSlot !== undefined) {
    // Clamped rather than rejected, and to the same 1-3 the DB check enforces:
    // an out-of-range slot is a DefinitionId QuickBooks cannot address, and
    // discovering that as a 400 on a client's estimate push is far worse than
    // landing on slot 1 here.
    const n = Number(fields.qboSalespersonSlot);
    set.qboSalespersonSlot = [1, 2, 3].includes(n) ? n : DEFAULTS.qboSalespersonSlot;
  }
  if (fields.qboSalespersonGhlField !== undefined) {
    const v = fields.qboSalespersonGhlField;
    set.qboSalespersonGhlField = v ? String(v) : null;
  }
  if (fields.qboInvoiceLeadDays !== undefined) {
    const n = Number(fields.qboInvoiceLeadDays);
    set.qboInvoiceLeadDays = Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULTS.qboInvoiceLeadDays;
  }
  if (fields.idearoomWebhookToken !== undefined) {
    const v = fields.idearoomWebhookToken;
    set.idearoomWebhookToken = v ? String(v) : null;
  }
  if (fields.idearoomPipelineId !== undefined) {
    const v = fields.idearoomPipelineId;
    set.idearoomPipelineId = v ? String(v) : null;
  }
  if (fields.idearoomStageId !== undefined) {
    const v = fields.idearoomStageId;
    set.idearoomStageId = v ? String(v) : null;
  }
  if (fields.idearoomTag !== undefined) {
    const v = String(fields.idearoomTag ?? '').trim();
    set.idearoomTag = v || DEFAULTS.idearoomTag;
  }
  if (fields.idearoomEnabled !== undefined) {
    set.idearoomEnabled = !!fields.idearoomEnabled;
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
