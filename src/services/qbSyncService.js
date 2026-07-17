import { db } from '../core/db/client.js';
import { qbSyncLinks, qbSyncState, integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { makeGhlRequest } from './ghlService.js';
import {
  getChangedEntities,
  findOrCreateCustomer,
  makeQuickBooksRequest,
  upsertEstimate,
} from './quickbooksService.js';
import { getMappings } from './mapperService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';

// QBO Change Data Capture only reaches back 30 days; first sync starts there.
const FIRST_SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Sync state / links ───────────────────────────────────────────────────────

async function getSyncSince(locationId) {
  const [state] = await db
    .select()
    .from(qbSyncState)
    .where(eq(qbSyncState.locationId, locationId))
    .limit(1);
  return state?.lastSyncAt ?? new Date(Date.now() - FIRST_SYNC_WINDOW_MS);
}

async function setSyncState(locationId, lastSyncAt) {
  await db
    .insert(qbSyncState)
    .values({ locationId, lastSyncAt })
    .onConflictDoUpdate({
      target: qbSyncState.locationId,
      set: { lastSyncAt, updatedAt: new Date() },
    });
}

async function getLink(locationId, entityType, { ghlId, qbId }) {
  const conditions = [
    eq(qbSyncLinks.locationId, locationId),
    eq(qbSyncLinks.entityType, entityType),
  ];
  if (ghlId) conditions.push(eq(qbSyncLinks.ghlId, String(ghlId)));
  if (qbId) conditions.push(eq(qbSyncLinks.qbId, String(qbId)));

  const [link] = await db.select().from(qbSyncLinks).where(and(...conditions)).limit(1);
  return link ?? null;
}

async function upsertLink(locationId, entityType, ghlId, qbId) {
  const [row] = await db
    .insert(qbSyncLinks)
    .values({
      id: randomUUID(),
      locationId,
      entityType,
      ghlId: String(ghlId),
      qbId: String(qbId),
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [qbSyncLinks.locationId, qbSyncLinks.entityType, qbSyncLinks.ghlId],
      set: { qbId: String(qbId), lastSyncedAt: new Date(), updatedAt: new Date() },
    })
    .returning();
  return row;
}

async function touchLink(linkId) {
  await db
    .update(qbSyncLinks)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(qbSyncLinks.id, linkId));
}

// Skip changes we made ourselves during the previous pass (echo suppression):
// a source update older than the link's lastSyncedAt was either already synced
// or produced by our own write.
function isEcho(sourceUpdatedAt, link) {
  if (!link?.lastSyncedAt || !sourceUpdatedAt) return false;
  return new Date(sourceUpdatedAt).getTime() <= link.lastSyncedAt.getTime();
}

// Last-write-wins: skip applying the source change when the target side is newer.
function targetIsNewer(sourceUpdatedAt, targetUpdatedAt) {
  if (!sourceUpdatedAt || !targetUpdatedAt) return false;
  return new Date(targetUpdatedAt).getTime() > new Date(sourceUpdatedAt).getTime();
}

// ─── QB → GHL ─────────────────────────────────────────────────────────────────

function qbCustomerToGhlContact(customer) {
  return {
    name: customer.DisplayName ?? undefined,
    email: customer.PrimaryEmailAddr?.Address ?? undefined,
    phone: customer.PrimaryPhone?.FreeFormNumber ?? undefined,
  };
}

async function syncQbCustomersToGhl(locationId, customers, stats) {
  // Assigned-user (salesperson) mapping, QB → GHL. Rockwood stores the
  // salesperson in a QuickBooks Customer custom field; GHL's `assignedTo` needs
  // a GHL user id, not a name — so two optional mappers drive this (no mapping
  // configured → this is a no-op and contact sync is unchanged):
  //   quickbooks / qbo_assigned_user_field : { name: '<QBO custom field name>' }
  //   quickbooks / assigned_user           : { '<QBO field value>': '<GHL user id>' }
  const assignedFieldMap = await getMappings(locationId, 'quickbooks', 'qbo_assigned_user_field');
  const assignedFieldName = assignedFieldMap.name ?? assignedFieldMap.assigned_user ?? null;
  const assignedUserMap = assignedFieldName
    ? await getMappings(locationId, 'quickbooks', 'assigned_user')
    : {};

  // Read the salesperson custom field off a QBO Customer and translate it to the
  // matching GHL user id (undefined when unset/unmapped so we never clobber it).
  function resolveAssignedTo(customer) {
    if (!assignedFieldName) return undefined;
    const cf = (customer.CustomField ?? []).find(
      (f) => (f.Name ?? '').toLowerCase() === assignedFieldName.toLowerCase(),
    );
    const value = cf?.StringValue?.trim();
    return value ? assignedUserMap[value] || undefined : undefined;
  }

  for (const customer of customers) {
    const qbUpdatedAt = customer.MetaData?.LastUpdatedTime;
    const link = await getLink(locationId, 'contact', { qbId: customer.Id });

    if (isEcho(qbUpdatedAt, link)) continue;

    const assignedTo = resolveAssignedTo(customer);
    const ghlContact = {
      ...qbCustomerToGhlContact(customer),
      ...(assignedTo ? { assignedTo } : {}),
    };

    if (link) {
      // Fetch GHL side for the LWW comparison
      const existing = await makeGhlRequest(locationId, 'GET', `/contacts/${link.ghlId}`)
        .catch(() => null);
      const ghlUpdatedAt = existing?.contact?.dateUpdated ?? existing?.contact?.updatedAt;
      if (targetIsNewer(qbUpdatedAt, ghlUpdatedAt)) continue; // GHL wins; other pass pushes it

      await makeGhlRequest(locationId, 'PUT', `/contacts/${link.ghlId}`, ghlContact);
      await touchLink(link.id);
      stats.qbToGhlContactsUpdated++;
    } else {
      const created = await makeGhlRequest(locationId, 'POST', '/contacts/', {
        locationId,
        ...ghlContact,
      });
      const ghlId = created?.contact?.id ?? created?.id;
      if (!ghlId) {
        console.warn(`[rockwood] GHL contact create returned no id for QB customer ${customer.Id}`);
        continue;
      }
      await upsertLink(locationId, 'contact', ghlId, customer.Id);
      stats.qbToGhlContactsCreated++;
    }
  }
}

async function syncQbEstimatesToGhl(locationId, estimates, stats) {
  const stageMap = await getMappings(locationId, 'quickbooks', 'opportunity_stage');
  const pipelineMap = await getMappings(locationId, 'quickbooks', 'pipeline');

  for (const estimate of estimates) {
    const qbUpdatedAt = estimate.MetaData?.LastUpdatedTime;
    const link = await getLink(locationId, 'estimate', { qbId: estimate.Id });

    if (isEcho(qbUpdatedAt, link)) continue;

    const monetaryValue = estimate.TotalAmt;
    const mappedStage = stageMap[estimate.TxnStatus]; // e.g. 'Accepted' → GHL stage id

    if (link) {
      await makeGhlRequest(locationId, 'PUT', `/opportunities/${link.ghlId}`, {
        ...(monetaryValue != null ? { monetaryValue } : {}),
        ...(mappedStage ? { pipelineStageId: mappedStage } : {}),
      });
      await touchLink(link.id);
      stats.qbToGhlEstimatesUpdated++;
    } else {
      // Creating a GHL opportunity requires a pipeline and a contact.
      const pipelineId = pipelineMap.default;
      const customerId = estimate.CustomerRef?.value;
      const contactLink = customerId
        ? await getLink(locationId, 'contact', { qbId: customerId })
        : null;

      if (!pipelineId || !contactLink) {
        console.warn(`[rockwood] skipping QB estimate ${estimate.Id}: ${!pipelineId ? 'no pipeline mapper (quickbooks/pipeline/default)' : `no contact link for QB customer ${customerId}`}`);
        stats.skipped++;
        continue;
      }

      const created = await makeGhlRequest(locationId, 'POST', '/opportunities/', {
        locationId,
        pipelineId,
        contactId: contactLink.ghlId,
        name: `QB Estimate ${estimate.DocNumber ?? estimate.Id}`,
        ...(monetaryValue != null ? { monetaryValue } : {}),
        ...(mappedStage ? { pipelineStageId: mappedStage } : {}),
      });
      const ghlId = created?.opportunity?.id ?? created?.id;
      if (!ghlId) {
        console.warn(`[rockwood] GHL opportunity create returned no id for QB estimate ${estimate.Id}`);
        continue;
      }
      await upsertLink(locationId, 'estimate', ghlId, estimate.Id);
      stats.qbToGhlEstimatesCreated++;
    }
  }
}

// ─── GHL → QB ─────────────────────────────────────────────────────────────────

// Build the set of GHL contact ids that have an opportunity in `pipelineId`.
// Used to gate contact CREATE (Carolyn: push a contact to QuickBooks when the
// lead moves into the "Buildings" pipeline). Returns null when no pipeline is
// configured → no gating (push all changed contacts).
async function contactIdsInPipeline(locationId, pipelineId) {
  if (!pipelineId) return null;
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=100`,
  ).catch(() => null);

  // Fail open: if the lookup errored, don't gate (a transient GHL error must not
  // silently stop all contact creation). An empty pipeline correctly gates all.
  if (!data) return null;

  const set = new Set();
  for (const opp of data.opportunities ?? []) {
    const cid = opp.contactId ?? opp.contact?.id;
    if (cid) set.add(String(cid));
  }
  return set;
}

async function syncGhlContactsToQb(locationId, since, stats, settings) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`,
  );
  const contacts = data?.contacts ?? [];

  // Contact-push gating: when a pipeline is configured, only CREATE contacts
  // that have an opportunity in it. Existing linked contacts still update.
  const pipelineGate = await contactIdsInPipeline(locationId, settings?.qboContactSyncPipelineId);

  for (const contact of contacts) {
    const ghlUpdatedAt = contact.dateUpdated ?? contact.updatedAt;
    if (ghlUpdatedAt && new Date(ghlUpdatedAt) <= since) continue; // unchanged

    const link = await getLink(locationId, 'contact', { ghlId: contact.id });
    if (isEcho(ghlUpdatedAt, link)) continue;

    const name = contact.contactName
      ?? [contact.firstName, contact.lastName].filter(Boolean).join(' ')
      ?? null;

    if (link) {
      // Read the QB side for SyncToken + LWW comparison
      const current = await makeQuickBooksRequest(
        locationId, 'GET', `/customer/${link.qbId}?minorversion=75`,
      ).catch(() => null);
      const customer = current?.Customer;
      if (!customer) continue;
      if (targetIsNewer(ghlUpdatedAt, customer.MetaData?.LastUpdatedTime)) continue; // QB wins

      await makeQuickBooksRequest(locationId, 'POST', '/customer?minorversion=75', {
        Id: customer.Id,
        SyncToken: customer.SyncToken,
        sparse: true,
        ...(name ? { DisplayName: name } : {}),
        ...(contact.email ? { PrimaryEmailAddr: { Address: contact.email } } : {}),
        ...(contact.phone ? { PrimaryPhone: { FreeFormNumber: contact.phone } } : {}),
      });
      await touchLink(link.id);
      stats.ghlToQbContactsUpdated++;
    } else {
      // Not yet in QuickBooks → only push if it clears the pipeline gate.
      if (pipelineGate && !pipelineGate.has(String(contact.id))) {
        stats.skipped++;
        continue;
      }
      const customer = await findOrCreateCustomer(locationId, {
        name,
        email: contact.email,
        phone: contact.phone,
      });
      await upsertLink(locationId, 'contact', contact.id, customer.Id);
      stats.ghlToQbContactsCreated++;
    }
  }
}

async function syncGhlOpportunitiesToQb(locationId, since, stats) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}&limit=100`,
  );
  const opportunities = data?.opportunities ?? [];

  for (const opp of opportunities) {
    const ghlUpdatedAt = opp.updatedAt ?? opp.dateUpdated;
    if (ghlUpdatedAt && new Date(ghlUpdatedAt) <= since) continue;

    const link = await getLink(locationId, 'estimate', { ghlId: opp.id });
    if (isEcho(ghlUpdatedAt, link)) continue;

    const amountCents = Math.round((opp.monetaryValue ?? 0) * 100);
    if (amountCents <= 0) continue;

    if (link) {
      const current = await makeQuickBooksRequest(
        locationId, 'GET', `/estimate/${link.qbId}?minorversion=75`,
      ).catch(() => null);
      const estimate = current?.Estimate;
      if (!estimate) continue;
      if (targetIsNewer(ghlUpdatedAt, estimate.MetaData?.LastUpdatedTime)) continue;

      await upsertEstimate(locationId, {
        qbEstimateId: estimate.Id,
        syncToken: estimate.SyncToken,
        qbCustomerId: estimate.CustomerRef?.value,
        amountCents,
        description: opp.name,
      });
      await touchLink(link.id);
      stats.ghlToQbEstimatesUpdated++;
    } else {
      const contactLink = opp.contactId
        ? await getLink(locationId, 'contact', { ghlId: opp.contactId })
        : null;
      if (!contactLink) {
        console.warn(`[rockwood] skipping GHL opportunity ${opp.id}: no QB customer link for contact ${opp.contactId ?? '(none)'}`);
        stats.skipped++;
        continue;
      }

      const estimate = await upsertEstimate(locationId, {
        qbCustomerId: contactLink.qbId,
        amountCents,
        description: opp.name,
      });
      await upsertLink(locationId, 'estimate', opp.id, estimate.Id);
      stats.ghlToQbEstimatesCreated++;
    }
  }
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Run one two-way sync pass for a location (Rockwood model):
 * contacts + estimates, QB→GHL then GHL→QB, last-write-wins on conflicts.
 * Returns per-direction stats.
 */
export async function syncLocation(locationId, settings) {
  const cfg = settings ?? (await getLocationSettings(locationId));
  const since = await getSyncSince(locationId);
  const runStartedAt = new Date();

  const stats = {
    qbToGhlContactsCreated: 0,
    qbToGhlContactsUpdated: 0,
    qbToGhlEstimatesCreated: 0,
    qbToGhlEstimatesUpdated: 0,
    ghlToQbContactsCreated: 0,
    ghlToQbContactsUpdated: 0,
    ghlToQbEstimatesCreated: 0,
    ghlToQbEstimatesUpdated: 0,
    skipped: 0,
  };

  // QB → GHL (Change Data Capture)
  const cdc = await getChangedEntities(locationId, ['Customer', 'Estimate'], since);
  const responses = cdc?.CDCResponse?.flatMap((r) => r.QueryResponse ?? []) ?? [];
  const customers = responses.flatMap((q) => q.Customer ?? []);
  const estimates = responses.flatMap((q) => q.Estimate ?? []);

  await syncQbCustomersToGhl(locationId, customers, stats);
  await syncQbEstimatesToGhl(locationId, estimates, stats);

  // GHL → QB
  await syncGhlContactsToQb(locationId, since, stats, cfg);
  await syncGhlOpportunitiesToQb(locationId, since, stats);

  await setSyncState(locationId, runStartedAt);
  console.log(`[rockwood] sync ${locationId}:`, JSON.stringify(stats));
  return stats;
}

/**
 * Scheduler job: run the two-way sync for every location that has QuickBooks
 * connected, an active QuickBooks (or Suite) subscription, AND has opted into
 * the two-way sync (Rockwood model) in its settings. Locations that only use
 * milestone invoicing (Yoder model) are skipped here.
 */
export async function syncAllLocations() {
  const rows = await db
    .select({ locationId: integrationCredentials.locationId })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.appSlug, 'quickbooks'));

  let ran = 0;
  for (const { locationId } of rows) {
    try {
      if (!(await hasAccess(locationId, 'quickbooks'))) continue;
      const settings = await getLocationSettings(locationId);
      if (!settings.qboTwoWaySync) continue; // two-way sync not enabled for this tenant
      await syncLocation(locationId, settings);
      ran++;
    } catch (err) {
      console.error(`[rockwood] sync failed for ${locationId}:`, err.message);
    }
  }
  return ran;
}
