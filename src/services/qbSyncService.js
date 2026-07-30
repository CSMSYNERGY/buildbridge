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
import { getMappings, listMappers } from './mapperService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';
import { recordThrown } from './errorLogService.js';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
  deriveContactName,
  qbAddressToGhl,
  mergeCustomFields,
  qbCustomFieldEntries,
  resolveItemRef,
} from './qbSyncLogic.js';

// QBO Change Data Capture only reaches back 30 days; first sync starts there.
const FIRST_SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Sync state / links ───────────────────────────────────────────────────────

// How long one pass may spend on records before it stops and hands the rest to the
// next tick. A scheduled Worker invocation has a finite budget and every DB round-trip
// here goes through DB_WORKER (~2.5s), so a large changeset cannot finish inside one.
//
// ONE deadline for the whole pass, shared by both directions rather than one each:
// both halves run in the SAME invocation, so per-half budgets would add up and it is
// the total that has to fit. Whatever the first half leaves unspent, the second gets.
//
// Without this cap a first sync deadlocks permanently: the pass never reaches
// setSyncState, so `since` stays at the 30-day FIRST_SYNC_WINDOW_MS default, so the
// next tick re-fetches the SAME full changeset, runs out of road in the same place,
// and never gets smaller. The tenant shows "no sync has completed yet" forever while
// the same handful of records fail every 15 minutes. Observed in production 2026-07-30.
const SYNC_PASS_BUDGET_MS = 60_000;

async function getSyncSince(locationId) {
  const [state] = await db
    .select()
    .from(qbSyncState)
    .where(eq(qbSyncState.locationId, locationId))
    .limit(1);
  // Normalize: the row travels through sql-exec, so lastSyncAt can arrive as a string.
  return state?.lastSyncAt
    ? new Date(state.lastSyncAt)
    : new Date(Date.now() - FIRST_SYNC_WINDOW_MS);
}

// QuickBooks' own last-modified stamp for a CDC record, as epoch ms. 0 when absent
// or unparseable — callers must never advance the cursor to a 0.
function qbUpdatedMs(entity) {
  const t = Date.parse(entity?.MetaData?.LastUpdatedTime ?? '');
  return Number.isFinite(t) ? t : 0;
}

// Same, for a GHL contact. 0 when absent or unparseable.
function ghlUpdatedMs(contact) {
  const t = Date.parse(contact?.dateUpdated ?? contact?.updatedAt ?? '');
  return Number.isFinite(t) ? t : 0;
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
  const addr = customer.BillAddr ?? customer.ShipAddr;
  return {
    // Map structured name parts so GHL shows a proper first/last, not one blob.
    firstName: customer.GivenName ?? undefined,
    lastName: customer.FamilyName ?? undefined,
    name: customer.DisplayName ?? undefined,
    ...(customer.CompanyName ? { companyName: customer.CompanyName } : {}),
    email: customer.PrimaryEmailAddr?.Address ?? undefined,
    phone: customer.PrimaryPhone?.FreeFormNumber ?? undefined,
    // Address (billing preferred, else shipping) → GHL address fields.
    ...qbAddressToGhl(addr, customer.DisplayName),
  };
}

async function syncQbCustomersToGhl(locationId, customers, stats, cfg, deadlineAt) {
  // Salesperson copy, QB → GHL. Rockwood stores the salesperson in a QuickBooks
  // Customer custom field (its NAME is set in Settings as qboAssignedUserField);
  // its value is copied verbatim into a GHL contact custom field
  // (qboAssignedUserGhlField). Both must be set, else this is a no-op and the
  // name/email/phone contact sync is unchanged. Pure text copy — no GHL user
  // lookup needed.
  const legacyFieldMap = await getMappings(locationId, 'quickbooks', 'qbo_assigned_user_field');
  const sourceField = cfg?.qboAssignedUserField ?? legacyFieldMap.name ?? null;
  const targetField = cfg?.qboAssignedUserGhlField ?? null;
  // User-defined QuickBooks-field → Synergy-field mappings (the mapper UI).
  const customFieldMap = await getMappings(locationId, 'quickbooks', 'custom_field');

  // All GHL custom-field entries {id,value} to write for a customer: the
  // salesperson (if configured) plus every user-defined field mapping. Skips
  // fields with no value on this customer.
  function contactCustomFields(customer) {
    const entries = [];
    if (sourceField && targetField) {
      const value = readQbCustomerField(customer, sourceField);
      if (value) entries.push({ id: targetField, value });
    }
    entries.push(...qbCustomFieldEntries(customer, customFieldMap));
    return entries;
  }

  // Oldest change first. The sync cursor is a single timestamp, so the only way a
  // partial pass can advance it without skipping anyone is to drain the backlog in
  // LastUpdatedTime order and stop at a clean boundary.
  const queue = [...customers].sort((a, b) => qbUpdatedMs(a) - qbUpdatedMs(b));
  let processedThrough = 0; // epoch ms of the last customer this tick handled
  let handled = 0;

  for (const customer of queue) {
    // ── Budget guard ──────────────────────────────────────────────────────────
    // Stop once this invocation's slice is spent so the pass still reaches
    // setSyncState and the next tick starts from a smaller window. Never stop
    // mid-timestamp, though: leaving a customer behind that shares the last
    // handled LastUpdatedTime would either strand it forever (the cursor can't
    // advance past its own value) or skip it (the cursor moves past unhandled
    // work). Drain the tie, then break.
    if (
      deadlineAt &&
      Date.now() >= deadlineAt &&
      processedThrough &&
      qbUpdatedMs(customer) !== processedThrough
    ) {
      break;
    }
    handled++;

    // ── Per-customer isolation ────────────────────────────────────────────────
    // One unsyncable record must not take the whole pass down with it. Before this,
    // a single customer GHL rejected aborted everything after it — the rest of the
    // customers, the sales-doc status pass, the entire GHL→QuickBooks direction — AND
    // skipped setSyncState, so the cursor never advanced and the SAME record was retried
    // every 15 minutes forever. That is why Rockwood had never completed a single pass
    // and its error count climbed all day (2026-07-29).
    //
    // Failures are recorded, not swallowed: each one lands in error_events (and therefore
    // in the connection card's "open problems"), so a record we cannot sync stays visible
    // instead of quietly disappearing. Same polarity as syncAllLocations, which already
    // records-and-continues when one LOCATION fails rather than abandoning the rest.
    try {
      await syncOneQbCustomerToGhl(locationId, customer, stats, { contactCustomFields });
    } catch (err) {
      stats.qbToGhlContactsFailed++;
      console.error(`[rockwood] contact sync failed for QB customer ${customer.Id}:`, err.message);
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'qbo_contact_sync_failed',
        appSlug: 'quickbooks',
        locationId,
        // The QuickBooks customer id is the handle a human needs to go and fix the record.
        // It is an internal identifier, not customer data.
        context: { job: 'rockwood-quickbooks-sync', qbCustomerId: String(customer.Id ?? '') },
      });
    }

    // Advance past this record whether it synced or failed. A record GHL will never
    // accept must not pin the cursor, or one bad record generates an identical error
    // every 15 minutes indefinitely. The failure is still in error_events, so it stays
    // visible on the connection card; it just stops being retried until the record
    // actually changes in QuickBooks.
    const ts = qbUpdatedMs(customer);
    if (ts) processedThrough = ts;
  }

  return { processedThrough, deferred: queue.length - handled };
}

/**
 * Sync ONE QuickBooks customer into GHL. Extracted from the loop so a failure can be
 * contained per record — see the try/catch at the call site.
 */
async function syncOneQbCustomerToGhl(locationId, customer, stats, { contactCustomFields }) {
  const qbUpdatedAt = customer.MetaData?.LastUpdatedTime;
  const link = await getLink(locationId, 'contact', { qbId: customer.Id });

  if (isEcho(qbUpdatedAt, link)) return;

  const cfEntries = contactCustomFields(customer);
  const base = qbCustomerToGhlContact(customer);

  if (link) {
    // Fetch GHL side for the LWW comparison
    const existing = await makeGhlRequest(locationId, 'GET', `/contacts/${link.ghlId}`)
      .catch(() => null);
    const ghlUpdatedAt = existing?.contact?.dateUpdated ?? existing?.contact?.updatedAt;
    if (targetIsNewer(qbUpdatedAt, ghlUpdatedAt)) return; // GHL wins; other pass pushes it

    // Merge our fields into the contact's existing custom fields so this PUT
    // can't wipe fields set by the sales-doc-status pass (or vice versa).
    const payload = cfEntries.length
      ? {
          ...base,
          customFields: cfEntries.reduce(
            (acc, f) => mergeCustomFields(acc, f),
            existing?.contact?.customFields ?? [],
          ),
        }
      : base;
    await makeGhlRequest(locationId, 'PUT', `/contacts/${link.ghlId}`, payload);
    await touchLink(link.id);
    stats.qbToGhlContactsUpdated++;
    return;
  }

  // ── No link yet: this customer has never been synced BY US ──────────────────
  // That does NOT mean they are absent from GHL. qb_sync_links only ever gets rows from
  // our own writes, so every contact the client already had in GHL looks new to us — and
  // `POST /contacts/` rejects an existing email/phone outright:
  //
  //   400 "This location does not allow duplicated contacts."
  //
  // That is Rockwood's entire breakage (2026-07-29): 8-9 customers per run, every run,
  // forever, because a rejected create never produces a link so the next run tries the
  // exact same create again. The client's QuickBooks customers were of course already in
  // their CRM.
  //
  // No email and no phone → GHL has nothing to match on and nothing to reach the person
  // with. Skip rather than create an unreachable stub. Mirrors idearoomService's
  // isActionable(), which is the same judgement for inbound leads.
  if (!base.email && !base.phone) {
    stats.qbToGhlContactsSkipped++;
    return;
  }

  let ghlId;
  let adopted = false;
  if (base.email) {
    // Email present → upsert. GHL matches on email FIRST, which is a precise identity, and
    // it returns the existing contact when there is one — so this both fixes the 400 and
    // ADOPTS the client's existing contact into qb_sync_links, turning every later run into
    // a cheap update. Same endpoint and reasoning as idearoomService's lead push.
    const upserted = await makeGhlRequest(locationId, 'POST', '/contacts/upsert', {
      locationId,
      ...base,
      ...(cfEntries.length ? { customFields: cfEntries } : {}),
    });
    ghlId = upserted?.contact?.id ?? upserted?.id;
  } else {
    // Phone-only → deliberately still a CREATE, not an upsert.
    //
    // GHL's upsert matches on phone when there is no email, and it OVERWRITES the matched
    // contact's fields. A phone is not an identity: shed businesses routinely have a shared
    // household or business line, so a phone-only upsert can rewrite the name and details of
    // a DIFFERENT person already in the client's CRM. Losing a sync is recoverable; silently
    // corrupting a client's contact record is not.
    //
    // If this 400s as a duplicate the person is ALREADY in the CRM, so we adopt that
    // contact — record the link and write nothing to them. Adoption is not the upsert
    // question: it makes no change to the matched contact, so it cannot overwrite a
    // shared household or business line. Whether to go further and push our field values
    // onto a phone-matched contact is still Carolyn's call, not ours.
    //
    // Without this the create is retried every 15 minutes forever against a contact that
    // can never be created. Adoption also fixes the real consequence of leaving it
    // unlinked: sales-doc status reflection is keyed on the link, so an unlinked customer
    // silently gets no status updates at all.
    try {
      const created = await makeGhlRequest(locationId, 'POST', '/contacts/', {
        locationId,
        ...base,
        ...(cfEntries.length ? { customFields: cfEntries } : {}),
      });
      ghlId = created?.contact?.id ?? created?.id;
    } catch (err) {
      if (!err.ghlDuplicateContactId) throw err;
      ghlId = err.ghlDuplicateContactId;
      adopted = true;
      stats.qbToGhlContactsAdopted++;
      console.log(`[rockwood] adopted existing GHL contact for QB customer ${customer.Id}`);
    }
  }

  if (!ghlId) {
    console.warn(`[rockwood] GHL contact write returned no id for QB customer ${customer.Id}`);
    return;
  }
  await upsertLink(locationId, 'contact', ghlId, customer.Id);
  // An adopted contact was already counted; it was linked, not created.
  if (!adopted) stats.qbToGhlContactsCreated++;
}

// QuickBooks sales-doc status → a GHL contact custom field (read-only QB→GHL).
// Highest status reached wins so we never downgrade (e.g. a re-sent estimate
// after invoicing won't overwrite "Invoiced"). Status/rank logic lives in
// qbSyncLogic.js (pure + unit-tested).
async function reflectSalesDocStatus(locationId, estimates, invoices, stats, cfg) {
  const targetField = cfg?.qboStatusGhlField ?? null;
  if (!targetField) return; // status reflection not configured

  // Best status per QB customer this run (invoices outrank estimates).
  const byCustomer = new Map();
  const consider = (customerId, status) => {
    if (!customerId) return;
    if (shouldUpgradeStatus(byCustomer.get(customerId), status)) {
      byCustomer.set(customerId, status);
    }
  };
  for (const est of estimates) consider(est.CustomerRef?.value, estimateStatus(est));
  for (const inv of invoices) consider(inv.CustomerRef?.value, 'Invoiced');

  for (const [customerId, status] of byCustomer) {
    // Same per-record isolation as the contact loop above. The GET below was already
    // guarded but the PUT was not, so one contact GHL rejected here aborted the whole
    // pass — after the contacts had synced and before setSyncState, which is the worst
    // possible place to die: work done, cursor not advanced, so it all runs again.
    try {
      const link = await getLink(locationId, 'contact', { qbId: customerId });
      if (!link) {
        // No GHL contact linked yet (contacts sync in the same pass may create it
        // next run); nothing to update this round.
        stats.skipped++;
        continue;
      }

      // Don't downgrade: read the contact's current status value first.
      const existing = await makeGhlRequest(locationId, 'GET', `/contacts/${link.ghlId}`)
        .catch(() => null);
      const current = (existing?.contact?.customFields ?? []).find(
        (f) => f.id === targetField || f.fieldKey === targetField,
      );
      const currentVal = current?.value ?? current?.fieldValue;
      if (!shouldUpgradeStatus(currentVal, status)) continue;

      // Merge into existing custom fields so we never wipe the salesperson field.
      const customFields = mergeCustomFields(existing?.contact?.customFields, {
        id: targetField,
        value: status,
      });
      await makeGhlRequest(locationId, 'PUT', `/contacts/${link.ghlId}`, { customFields });
      // Advance the link cursor so this GHL write isn't re-detected as a
      // GHL-origin change and pushed back to QBO next cycle (echo suppression).
      await touchLink(link.id);
      stats.qbStatusUpdated++;
    } catch (err) {
      stats.qbStatusFailed++;
      console.error(`[rockwood] status reflect failed for QB customer ${customerId}:`, err.message);
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'qbo_status_reflect_failed',
        appSlug: 'quickbooks',
        locationId,
        context: { job: 'rockwood-quickbooks-sync', qbCustomerId: String(customerId ?? '') },
      });
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

async function syncGhlContactsToQb(locationId, since, stats, settings, deadlineAt) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`,
  );
  // Oldest change first, for the same reason as the QB→GHL half: the sync cursor is a
  // single timestamp, so a pass that can't finish may only advance it to the last
  // record it handled. (Ordering is imposed here rather than requested from GHL — the
  // page is already in memory and its API order is not contractual.)
  const contacts = [...(data?.contacts ?? [])].sort(
    (a, b) => ghlUpdatedMs(a) - ghlUpdatedMs(b),
  );

  // Contact-push gating: when a pipeline is configured, only CREATE contacts
  // that have an opportunity in it. Existing linked contacts still update.
  const pipelineGate = await contactIdsInPipeline(locationId, settings?.qboContactSyncPipelineId);

  let processedThrough = 0;
  let handled = 0;

  for (const contact of contacts) {
    const ghlUpdatedAt = contact.dateUpdated ?? contact.updatedAt;
    if (ghlUpdatedAt && new Date(ghlUpdatedAt) <= since) {
      handled++; // already covered by the cursor — not deferred work
      continue;
    }

    // Budget guard — see syncQbCustomersToGhl. This half is the expensive one on a
    // first sync: with a 30-day window every contact on the page clears the date
    // filter, and each one costs a link lookup plus two QuickBooks round-trips.
    if (
      deadlineAt &&
      Date.now() >= deadlineAt &&
      processedThrough &&
      ghlUpdatedMs(contact) !== processedThrough
    ) {
      break;
    }
    handled++;
    const contactTs = ghlUpdatedMs(contact);
    if (contactTs) processedThrough = contactTs;

    // Per-record isolation, same polarity as the QB→GHL half. One contact QuickBooks
    // rejects must not abort the pass: aborting means the cursor is never written, so
    // every contact on this page gets re-pushed on the next tick, forever.
    try {
      const link = await getLink(locationId, 'contact', { ghlId: contact.id });
      if (isEcho(ghlUpdatedAt, link)) continue;

      const firstName = contact.firstName ?? undefined;
      const lastName = contact.lastName ?? undefined;
      const name = deriveContactName(contact);

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
          ...(firstName ? { GivenName: firstName } : {}),
          ...(lastName ? { FamilyName: lastName } : {}),
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
          firstName,
          lastName,
          email: contact.email,
          phone: contact.phone,
        });
        await upsertLink(locationId, 'contact', contact.id, customer.Id);
        stats.ghlToQbContactsCreated++;
      }
    } catch (err) {
      stats.ghlToQbContactsFailed++;
      console.error(`[rockwood] contact push failed for GHL contact ${contact.id}:`, err.message);
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'ghl_contact_push_failed',
        appSlug: 'quickbooks',
        locationId,
        context: { job: 'rockwood-quickbooks-sync', ghlContactId: String(contact.id ?? '') },
      });
    }
  }

  return { processedThrough, deferred: contacts.length - handled };
}

// Flatten a GHL opportunity's custom fields into { <fieldId>: value } so the
// qb_item mapper (whose ghlValue is the GHL custom-field id) can select an item.
// GHL has used a few shapes over API versions; handle them defensively.
function oppGhlFieldValues(opp) {
  const out = {};
  const cfs = Array.isArray(opp?.customFields) ? opp.customFields : [];
  for (const cf of cfs) {
    const key = cf?.id ?? cf?.key ?? cf?.fieldKey;
    if (!key) continue;
    const val = cf?.fieldValue ?? cf?.value ?? cf?.fieldValueString ?? cf?.fieldValueArray ?? cf?.selectedOptions;
    if (val !== undefined && val !== null && val !== '') out[key] = val;
  }
  return out;
}

async function syncGhlOpportunitiesToQb(locationId, since, stats) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}&limit=100`,
  );
  const opportunities = data?.opportunities ?? [];

  // The location's QBO item mapping (mapperType 'qb_item') → the line item to
  // bill; null falls back to QBO's default item. Resolved once per pass.
  const itemMaps = await listMappers(locationId, 'quickbooks', 'qb_item');

  for (const opp of opportunities) {
    // The QBO item to bill for THIS deal, resolved from the deal's own GHL
    // custom-field values (so a 2+ item mapping picks the item the deal's
    // selecting field points at; null → QBO's default item).
    const itemRef = resolveItemRef(itemMaps, oppGhlFieldValues(opp));
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
        itemRef,
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
        itemRef,
      });
      await upsertLink(locationId, 'estimate', opp.id, estimate.Id);
      stats.ghlToQbEstimatesCreated++;
    }
  }
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Run one sync pass for a location (Rockwood model). The location's
 * qboSyncDirection decides which halves run:
 *   'qb_to_ghl' → QB→GHL only (read-only against QuickBooks; never writes QBO)
 *   'ghl_to_qb' → GHL→QB only (push contacts + opportunities into QuickBooks)
 *   'two_way'   → both, last-write-wins on conflicts
 * Returns per-direction stats.
 */
export async function syncLocation(locationId, settings) {
  const cfg = settings ?? (await getLocationSettings(locationId));
  const direction = cfg.qboSyncDirection ?? 'off';
  const { pullFromQb, pushToQb } = syncFlags(direction);

  const since = await getSyncSince(locationId);
  const runStartedAt = new Date();
  const passDeadline = Date.now() + SYNC_PASS_BUDGET_MS;

  const stats = {
    direction,
    qbToGhlContactsCreated: 0,
    qbToGhlContactsUpdated: 0,
    // Records GHL refused that we skipped rather than aborting the pass on. Non-zero here
    // means "the sync ran, but this many customers did not make it" — a state that used to
    // be indistinguishable from a total failure because the first one killed the run.
    qbToGhlContactsFailed: 0,
    // QuickBooks customers with neither an email nor a phone: nothing for GHL to match on
    // and no way to reach the person, so deliberately not created.
    qbToGhlContactsSkipped: 0,
    // Phone-only customers GHL refused as duplicates, linked to the contact it matched
    // instead of being retried forever. No write is made to the matched contact.
    qbToGhlContactsAdopted: 0,
    // Customers this tick ran out of budget before reaching. Non-zero is normal while
    // a backlog drains — the next tick picks up exactly where this one stopped.
    qbToGhlContactsDeferred: 0,
    qbStatusUpdated: 0,
    qbStatusFailed: 0,
    ghlToQbContactsCreated: 0,
    ghlToQbContactsUpdated: 0,
    ghlToQbContactsFailed: 0,
    ghlToQbContactsDeferred: 0,
    ghlToQbEstimatesCreated: 0,
    ghlToQbEstimatesUpdated: 0,
    skipped: 0,
  };

  // Where the cursor lands when this pass finishes everything. A pass that runs out
  // of budget replaces this with the last record it actually handled.
  let cursorAt = runStartedAt;

  // QB → GHL (Change Data Capture). Skipped entirely for a push-only tenant so
  // we don't even read QuickBooks needlessly. Reads only — never writes QBO.
  if (pullFromQb) {
    const cdc = await getChangedEntities(locationId, ['Customer', 'Estimate', 'Invoice'], since);
    const responses = cdc?.CDCResponse?.flatMap((r) => r.QueryResponse ?? []) ?? [];
    const customers = responses.flatMap((q) => q.Customer ?? []);
    const estimates = responses.flatMap((q) => q.Estimate ?? []);
    const invoices = responses.flatMap((q) => q.Invoice ?? []);

    const pull = await syncQbCustomersToGhl(
      locationId,
      customers,
      stats,
      cfg,
      passDeadline,
    );
    stats.qbToGhlContactsDeferred = pull.deferred;

    if (pull.deferred > 0) {
      // Partial pass. Move the cursor only as far as the last customer we handled,
      // so the deferred ones are re-fetched next tick instead of being skipped —
      // and never backwards, so a record with no usable LastUpdatedTime can't undo
      // progress. The remaining stages are left for the next tick; this invocation
      // is already out of budget and adding to it risks losing the cursor write.
      cursorAt = pull.processedThrough
        ? new Date(Math.max(pull.processedThrough, since.getTime()))
        : since;
    } else {
      await reflectSalesDocStatus(locationId, estimates, invoices, stats, cfg);
    }
  }

  // GHL → QB. Skipped for a read-only ('qb_to_ghl') tenant, so BuildBridge makes no
  // writes to that tenant's QuickBooks. Also skipped when the pull half deferred work:
  // the cursor is being rewound to the pull high-water mark, and this half reads from
  // the same cursor, so running it now would re-push on the next tick anyway.
  if (pushToQb && stats.qbToGhlContactsDeferred === 0) {
    const push = await syncGhlContactsToQb(
      locationId,
      since,
      stats,
      cfg,
      passDeadline,
    );
    stats.ghlToQbContactsDeferred = push.deferred;

    if (push.deferred > 0) {
      // Both directions read from this one cursor, so it may only move as far as the
      // EARLIER of the two high-water marks — past that and the slower half's deferred
      // records are skipped for good. The faster half redoes a little work next tick,
      // which is safe: every operation here is an upsert or a link touch.
      const pushMark = push.processedThrough
        ? new Date(Math.max(push.processedThrough, since.getTime()))
        : since;
      if (pushMark < cursorAt) cursorAt = pushMark;
    } else {
      await syncGhlOpportunitiesToQb(locationId, since, stats);
    }
  }

  await setSyncState(locationId, cursorAt);
  console.log(`[rockwood] sync ${locationId} (${direction}):`, JSON.stringify(stats));
  return stats;
}

/**
 * Scheduler job: run the contact/estimate sync for every location that has
 * QuickBooks connected, an active QuickBooks (or Suite) subscription, AND a
 * sync direction other than 'off'. Locations that only use milestone invoicing
 * (Yoder model) leave the direction 'off' and are skipped here.
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
      const direction = settings.qboSyncDirection ?? 'off';
      if (direction === 'off') continue; // sync not enabled for this tenant
      await syncLocation(locationId, settings);
      ran++;
    } catch (err) {
      console.error(`[rockwood] sync failed for ${locationId}:`, err.message);
      // Durable record — this loop previously failed silently every 15 min (the
      // only trace was an open `wrangler tail`). See errorLogService.
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'qbo_sync_failed',
        appSlug: 'quickbooks',
        locationId,
        context: { job: 'rockwood-quickbooks-sync' },
      });
    }
  }
  return ran;
}
