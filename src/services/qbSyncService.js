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
  getRecentSalesDocs,
  getCustomersByIds,
  listItems,
} from './quickbooksService.js';
import { getMappings, listMappers } from './mapperService.js';
import { hasAccess } from './subscriptionService.js';
import { getLocationSettings } from './locationSettingsService.js';
// Invocation-level spend guard — see core/subrequestBudget.js.
import { beginBudget, endBudget, budgetExhausted, subrequestsUsed } from '../core/subrequestBudget.js';
import { recordThrown, recordError } from './errorLogService.js';
import {
  syncFlags,
  estimateStatus,
  shouldUpgradeStatus,
  readQbCustomerField,
  deriveContactName,
  nameSyncDecision,
  qbCustomerChanges,
  qbAddressToGhl,
  ghlAddressToQb,
  mergeCustomFields,
  qbCustomFieldEntries,
  repByCustomer,
  collectTxnCustomFieldNames,
  findQbCustomField,
  describeQbCustomField,
  resolveAssignee,
  samePhone,
  customersWithNews,
  resolveItemRef,
  resolveSalesperson,
  salespersonCustomField,
  mergeQboCustomFields,
} from './qbSyncLogic.js';
import {
  latestDocByCustomer,
  extractDocFields,
  docFieldWrites,
  optionLabel,
  customFieldName,
  optionsByField,
  renderTemplate,
} from './qbDocFields.js';

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

// How many contacts the sales-doc/rep loop may visit per pass.
//
// This loop used to run for the handful of customers whose sales-doc STATUS changed;
// carrying the rep made it iterate every customer holding one — 53 on Rockwood — and
// each visit is a GHL GET plus, on change, a PUT and a link touch. A time budget is
// the wrong instrument for that: it cannot stop the loop from eating the whole pass,
// and an invocation has finite subrequests and wall-clock regardless of what the clock
// says. 10 is a few seconds of I/O in any weather, leaves the later halves their slice,
// and drains a 53-customer backlog in ~6 passes (~90 minutes) — where the alternative
// was a pass that never finished at all.
const REP_VISITS_PER_PASS = 10;

// A location needs roughly this much of the invocation's budget left to be worth
// starting: the cursor read, the change feed, the two document queries and a write
// or two. Below it, the location is deferred whole rather than started and killed
// part-way — which leaves no cursor advance and a credential write half-done.
const MIN_BUDGET_TO_START_LOCATION = 6;

// A SEPARATE, larger budget for contacts that actually have news this pass.
//
// The 10 above bounds routine work — customers who merely hold a rep, re-derived
// every pass and losing nothing by waiting. News is not like that: the cursor moves
// on at the end of the pass, so a contact with a new estimate that queues past the
// cap does not get assigned later, it never gets assigned. Ordering fresh contacts
// first (see byCustomer) fixes which ten, not how many, and after any backlog there
// are more than ten. These visits are rare in steady state — a handful of documents a
// day — so the budget can be much larger without threatening the invocation.
const FRESH_VISITS_PER_PASS = 25;

// How stale a cursor may be and still count as evidence of new activity.
//
// `hasCursor` alone is not enough: a first sync drains its backlog over several
// passes, and a deferred pass persists a cursor derived from the synthetic 30-day
// window. From then on the row exists, so a row-existence test says "assign away"
// while `since` is still weeks old and every document in that window looks new. Six
// hours covers a deploy, a token blip or an outage; a backfill window does not fit
// inside it. Withholding costs a missed assignment, which is recoverable; the
// alternative reassigns contacts the client already owned, which is not.
const ASSIGN_MAX_CURSOR_AGE_MS = 6 * 60 * 60 * 1000;

async function getSyncSince(locationId) {
  const [state] = await db
    .select()
    .from(qbSyncState)
    .where(eq(qbSyncState.locationId, locationId))
    .limit(1);
  // Normalize: the row travels through sql-exec, so lastSyncAt can arrive as a string.
  //
  // `hasCursor` says whether that Date is a real high-water mark or the synthetic
  // 30-day first-sync window. Callers that merely READ from QuickBooks cannot tell
  // the difference and do not need to; the rep→assigned-user route does, because a
  // month of pre-existing history is not "new activity" and reassigning on it is the
  // one thing the tenant asked never to happen.
  const cursor = state?.lastSyncAt ? new Date(state.lastSyncAt) : null;
  return {
    since: cursor ?? new Date(Date.now() - FIRST_SYNC_WINDOW_MS),
    hasCursor: !!cursor,
  };
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

// ── Link index ────────────────────────────────────────────────────────────────
// ALL of a location's links, loaded in ONE query per pass and looked up in
// memory. This is not (only) the latency fix the 07-29 entry asked for — it is
// a correctness fix: every db.* call is a subrequest (service binding → DB
// worker), and the per-record getLink pattern pushed a backlogged tick past the
// invocation's subrequest limit, after which EVERY fetch fails instantly —
// including the error-log INSERTs (so nothing was recorded) and the final
// qb_sync_state write (so the cursor pinned). Observed via dual wrangler tail
// on 2026-07-31: the DB worker's request stream just stops mid-pass while the
// main worker keeps erroring. A pass is bounded (100-item GHL pages + CDC), so
// the index stays small; writes still go to the DB per record, and the index is
// updated alongside them so same-pass reads (echo suppression across halves)
// see what was just written.

function indexLink(index, row) {
  if (!row) return;
  index.set(`${row.entityType}:ghl:${row.ghlId}`, row);
  index.set(`${row.entityType}:qb:${row.qbId}`, row);
}

async function loadLinkIndex(locationId) {
  const rows = await db
    .select()
    .from(qbSyncLinks)
    .where(eq(qbSyncLinks.locationId, locationId));
  const index = new Map();
  for (const row of rows) indexLink(index, row);
  return index;
}

// `lastSyncedAt` for every link as it stood BEFORE this pass touched anything.
//
// The index rows are mutated in place by touchLink, which is deliberate — the halves
// need to see each other's writes. But one question must be asked against the
// pre-pass value: "is this QuickBooks change just our own write echoing back?" The
// contacts half runs first and touches the link of every contact it creates or
// updates, so by the time the rep half asks, a customer QuickBooks created five
// minutes ago carries a link stamped seconds ago and looks exactly like an echo.
// That customer is the primary case for assigning a rep, not one to skip.
function snapshotLinkTimes(index) {
  const times = new Map();
  for (const row of index.values()) {
    if (row?.id && !times.has(row.id)) times.set(row.id, row.lastSyncedAt ?? null);
  }
  return times;
}

function lookupLink(index, entityType, { ghlId, qbId }) {
  const key = ghlId != null
    ? `${entityType}:ghl:${String(ghlId)}`
    : `${entityType}:qb:${String(qbId)}`;
  return index.get(key) ?? null;
}

// Writes one link row AND records it in the pass's link index, so records later
// in the same pass (e.g. the opportunities loop looking up a contact link the
// contacts loop just created) see it without a re-query.
// `lastPushedName` is the name baseline (migration 0010) — only written when the
// caller has one to record, so a link created by the QB→GHL half (an adoption)
// keeps its NULL and is treated as "do not rename this customer" until a pass has
// seen what GHL says.
async function upsertLink(linkIndex, locationId, entityType, ghlId, qbId, lastPushedName = null) {
  const [row] = await db
    .insert(qbSyncLinks)
    .values({
      id: randomUUID(),
      locationId,
      entityType,
      ghlId: String(ghlId),
      qbId: String(qbId),
      lastSyncedAt: new Date(),
      ...(lastPushedName ? { lastPushedName } : {}),
    })
    .onConflictDoUpdate({
      target: [qbSyncLinks.locationId, qbSyncLinks.entityType, qbSyncLinks.ghlId],
      set: {
        qbId: String(qbId),
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
        ...(lastPushedName ? { lastPushedName } : {}),
      },
    })
    .returning();
  indexLink(linkIndex, row);
  return row;
}

// Forget a link whose Synergy side no longer exists. A link is BuildBridge's only
// notion of "this customer has a contact", so a contact deleted by hand in Synergy
// leaves a pointer to nothing: every read 404s, every visit skips, and the customer
// can never be re-created because having a link is what routes away from the create
// path. Observed 2026-08-20 when Ahsan deleted both Carolyn Miller contacts to clear
// a duplicate phone — the sync then reported "cannot see any contact" forever.
async function deleteLink(linkIndex, link) {
  await db.delete(qbSyncLinks).where(eq(qbSyncLinks.id, link.id));
  linkIndex.delete(`${link.entityType}:ghl:${link.ghlId}`);
  linkIndex.delete(`${link.entityType}:qb:${link.qbId}`);
}

// Advances the link's echo-suppression cursor. Mutating the row object also
// updates the pass's link index (it holds the same reference), so a write in
// one half is not re-detected as a fresh change by the other half.
//
// `baseline` (optional) records the name we just pushed — or, for a link that had
// none, the name GHL currently holds. Same write, so remembering it is free.
async function touchLink(link, baseline = null) {
  const now = new Date();
  await db
    .update(qbSyncLinks)
    .set({ lastSyncedAt: now, updatedAt: now, ...(baseline ? { lastPushedName: baseline } : {}) })
    .where(eq(qbSyncLinks.id, link.id));
  link.lastSyncedAt = now;
  if (baseline) link.lastPushedName = baseline;
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
    // All three phone slots, not just the primary. QuickBooks puts a number wherever
    // the person entering it clicked, and reading only PrimaryPhone is why customers
    // with a mobile on file reached Synergy with no phone at all — a contact nobody
    // can call, and (for a customer with no email either) one we refuse to create.
    phone: customer.PrimaryPhone?.FreeFormNumber
      ?? customer.Mobile?.FreeFormNumber
      ?? customer.AlternatePhone?.FreeFormNumber
      ?? undefined,
    // Address (billing preferred, else shipping) → GHL address fields.
    ...qbAddressToGhl(addr, customer.DisplayName),
  };
}

async function syncQbCustomersToGhl(locationId, customers, stats, cfg, deadlineAt, linkIndex) {
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
      (budgetExhausted() || (deadlineAt && Date.now() >= deadlineAt)) &&

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
      await syncOneQbCustomerToGhl(locationId, customer, stats, { contactCustomFields, linkIndex });
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
async function syncOneQbCustomerToGhl(locationId, customer, stats, { contactCustomFields, linkIndex }) {
  const qbUpdatedAt = customer.MetaData?.LastUpdatedTime;
  let link = lookupLink(linkIndex, 'contact', { qbId: customer.Id });

  if (isEcho(qbUpdatedAt, link)) return;

  const cfEntries = contactCustomFields(customer);
  const base = qbCustomerToGhlContact(customer);

  // Fetch GHL side for the LWW comparison. A 404 means the contact was DELETED in
  // Synergy: forget the link and fall through to the create path below, as if this
  // customer had never been synced — because as far as Synergy is concerned, they
  // haven't. Any other failure keeps the old behaviour (a transient read must not
  // tear down a valid link).
  let existing = null;
  if (link) {
    try {
      existing = await makeGhlRequest(locationId, 'GET', `/contacts/${link.ghlId}`);
    } catch (err) {
      const status = err.upstreamStatus ?? err.status;
      if (status === 404 || /not\s*found/i.test(err.ghlReason ?? err.message ?? '')) {
        await deleteLink(linkIndex, link);
        link = null;
        stats.qbContactsRelinked += 1;
        console.log(`[rockwood] contact for QB customer ${customer.Id} was deleted in Synergy — recreating`);
      } else {
        console.warn(`[rockwood] contact read failed for QB customer ${customer.Id}: HTTP ${status ?? '?'} — ${err.ghlReason ?? err.message}`);
      }
    }
  }

  if (link) {
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
    await touchLink(link);
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

      // ADOPT AND UPDATE. Ahsan, 2026-08-20: "you have to update the contact if it
      // is already created."
      //
      // This resolves a question the code had deliberately left open: adoption used
      // to link the matched contact and write NOTHING to it, because Synergy matched
      // it on a PHONE and a phone is not an identity — shed businesses share a
      // household or office line, so the match could be a different person. That
      // caution left a real cost, though: a customer QuickBooks knows about sat in
      // Synergy with none of their QuickBooks values, forever, because the one pass
      // that would have written them declined to.
      //
      // The phone is excluded from the update for the same reason it caused the
      // rejection: Synergy already has it on someone. Everything else — name, email,
      // address, mapped custom fields — is what QuickBooks knows about this customer,
      // and QuickBooks is the source of truth for it.
      try {
        const { phone, ...safeBase } = base;
        await makeGhlRequest(locationId, 'PUT', `/contacts/${ghlId}`, {
          ...safeBase,
          ...(cfEntries.length ? { customFields: cfEntries } : {}),
        });
        stats.qbToGhlContactsUpdated++;
      } catch (updateErr) {
        // Never fatal: the link is what the rest of the sync needs, and it is already
        // established by the time this runs.
        console.warn(`[rockwood] adopted contact ${ghlId} but could not update it: ${updateErr.message}`);
      }
    }
  }

  if (!ghlId) {
    console.warn(`[rockwood] GHL contact write returned no id for QB customer ${customer.Id}`);
    return;
  }
  await upsertLink(linkIndex, locationId, 'contact', ghlId, customer.Id);
  // An adopted contact was already counted; it was linked, not created.
  if (!adopted) stats.qbToGhlContactsCreated++;
}

// The opportunity to reflect a QuickBooks document onto — an EXISTING one only.
//
// Ahsan, 2026-08-19: "just the opportunity fields, no create". The GHL workflow this
// replaces had a Create Opportunity branch; BuildBridge deliberately does not. A deal
// that does not exist in Synergy is not a deal, and creating one here would also hand
// the GHL→QuickBooks half a brand-new "changed" opportunity to push straight back into
// the client's books as a second estimate.
//
// Preference order: the configured contact-sync pipeline, then an open deal, then the
// most recently updated. Returns null when the contact has no opportunity at all.
async function findContactOpportunity(locationId, contactId, pipelineId) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}`
      + `&contact_id=${encodeURIComponent(contactId)}&limit=20`,
  ).catch(() => null);
  // Filtered again on our side. If GHL ever ignores `contact_id` this returns the
  // location's first 20 opportunities, and writing this customer's estimate onto
  // somebody else's deal is not a failure mode worth risking on a query parameter.
  const list = (data?.opportunities ?? []).filter(
    (o) => o?.id && String(o?.contactId ?? '') === String(contactId),
  );
  if (list.length === 0) return null;
  const updated = (o) => Date.parse(o?.updatedAt ?? o?.dateUpdated ?? '') || 0;
  const score = (o) => (pipelineId && String(o.pipelineId ?? '') === String(pipelineId) ? 4 : 0)
    + (String(o.status ?? '').toLowerCase() === 'open' ? 2 : 0);
  return [...list].sort((a, b) => score(b) - score(a) || updated(b) - updated(a))[0];
}

// Write the mapped document values onto that opportunity's custom fields.
//
// Opportunity custom fields take `{id, field_value}` on the way in (contacts take
// `{id, value}`) — the two GHL endpoints genuinely differ. Nothing else about the
// opportunity is touched: no stage, no name, no monetary value, no status.
async function reflectDocFieldsToOpportunity(
  locationId, contactId, values, oppFieldMaps, cfg, linkIndex, stats, since,
  { nameTemplate = null, valueSource = null } = {},
) {
  const opp = await findContactOpportunity(locationId, contactId, cfg?.qboContactSyncPipelineId ?? null);
  if (!opp) {
    stats.qbOppNotFound += 1;
    return;
  }
  const writes = docFieldWrites(values, oppFieldMaps, opp.customFields ?? []);

  // The deal's NAME and VALUE, from tenant configuration — the "Update opportunity"
  // step of the workflow this replaces named the deal "{first name} {first line}".
  // Sent only when they actually CHANGE: a same-value write still bumps the deal's
  // updatedAt, which the echo machinery then has to explain away every pass.
  const renderedName = renderTemplate(nameTemplate, values);
  const nameWrite = renderedName && renderedName !== String(opp.name ?? '').trim() ? renderedName : null;
  const renderedValue = valueSource != null ? Number(values?.[valueSource]) : NaN;
  const valueWrite = Number.isFinite(renderedValue) && renderedValue !== Number(opp.monetaryValue ?? NaN)
    ? renderedValue
    : null;

  if (writes.length === 0 && !nameWrite && valueWrite == null) return;

  // What Synergy said BEFORE we touched it. Read first, because the write below
  // overwrites the only evidence of whether this deal already had an unpushed edit.
  const updatedBefore = opp.updatedAt ?? opp.dateUpdated;

  // Write what Synergy will take, and name what it will not. A Synergy field with a
  // fixed option list (a picklist) rejects free text with `Invalid Custom Field
  // Value "…" for "<fieldId>"` — and the 400 takes every OTHER field in the PUT down
  // with it, so one mis-mapped field silently cost the whole write on every pass
  // (observed live 2026-08-20, first-line description → picklist y5HdUniQsCE8…).
  // Same rule as the duplicate phone: drop the part Synergy refuses, keep the rest,
  // and put the refusal where the tenant can see it — only they can re-map it.
  // Name and value ride in every attempt — a picklist rejection can only name a
  // custom field, so peeling custom fields never strips them.
  const topLevel = {
    ...(nameWrite ? { name: nameWrite } : {}),
    ...(valueWrite != null ? { monetaryValue: valueWrite } : {}),
  };
  let pending = writes;
  const rejected = [];
  let attempted = false;
  while (pending.length || (!attempted && Object.keys(topLevel).length)) {
    attempted = true;
    try {
      await makeGhlRequest(locationId, 'PUT', `/opportunities/${opp.id}`, {
        ...topLevel,
        ...(pending.length ? { customFields: pending.map((w) => ({ id: w.id, field_value: w.value })) } : {}),
      });
      break;
    } catch (err) {
      const status = err.upstreamStatus ?? err.status;
      const m = /Invalid Custom Field Value[\s\S]*for\s+"?([A-Za-z0-9]{8,})"?\s*$/i
        .exec(err.ghlReason ?? err.message ?? '');
      const bad = status === 400 && m ? pending.find((w) => w.id === m[1]) : null;
      if (!bad) throw err; // not the invalid-value shape — the caller's catch reports it
      rejected.push(bad);
      pending = pending.filter((w) => w.id !== bad.id);
    }
  }
  stats.qbOppFieldsUpdated += pending.length;
  if (nameWrite) stats.qbOppNameSet += 1;
  if (valueWrite != null) stats.qbOppValueSet += 1;
  if (rejected.length) {
    stats.qbOppFieldsInvalid += rejected.length;
    // Which QuickBooks field feeds each rejected target, so the fix is a re-map,
    // not a hunt. Field ids and catalog keys only.
    const detail = rejected.map((w) => {
      const map = oppFieldMaps.find((x) => x.ghlValue === w.id);
      return `${map?.externalKey ?? '(unknown)'} → ${w.id}`;
    }).join('; ');
    await recordError({
      source: 'cron',
      kind: 'ghl_opportunity_field_invalid',
      appSlug: 'quickbooks',
      locationId,
      upstream: 'ghl',
      message: `Synergy rejected ${rejected.length} opportunity field value(s) because the target field only accepts values from its own option list (mappings: ${detail}). The other fields were still written. Map that QuickBooks value to a TEXT-type Synergy field instead, or make the option list match — in BuildBridge → QuickBooks, Estimate & invoice fields.`,
      context: { job: 'rockwood-quickbooks-sync', ghlOpportunityId: String(opp.id), mappings: detail },
    });
  }
  // Nothing landed ⇒ nothing to echo-suppress; the next pass retries the same way.
  if (pending.length === 0 && !nameWrite && valueWrite == null) return;

  // Echo marker, not an identity mapping — hence ghlId === qbId === the opportunity
  // id, which also means the two unique indexes on this table can never disagree
  // about which row to update. The GHL→QuickBooks half consults it before pushing:
  // without it, our own write looks like a Synergy edit next pass and gets sent back
  // as an estimate update (or, for an unlinked deal, a brand-new estimate).
  //
  // NOT written when the deal already carried an edit newer than the cursor. The
  // marker suppresses by timestamp, and our write and a human's edit from ten minutes
  // ago are indistinguishable once it lands — so on a deal with genuine pending
  // changes we stay out of the way and let the push half do its job. The cost is that
  // our own field write also reaches QuickBooks as an estimate update, which is the
  // documented behaviour for a changed opportunity anyway.
  // "Newer than the cursor" alone would be true of OUR OWN write from the previous
  // pass — which lands mid-pass, after that pass's cursor — so the marker would be
  // skipped on every pass forever and every field write would travel back into
  // QuickBooks as an estimate update. The existing marker answers it: a stamp at or
  // before our last write is ours, not a pending client edit.
  const marker = lookupLink(linkIndex, 'opportunity_field', { ghlId: opp.id });
  const oursAlready = !!updatedBefore && isEcho(new Date(updatedBefore), marker ?? {});
  const hadPendingEdit = since && updatedBefore
    && new Date(updatedBefore) > new Date(since)
    && !oursAlready;
  if (hadPendingEdit) {
    stats.qbOppEchoMarkerSkipped += 1;
    return;
  }
  await upsertLink(linkIndex, locationId, 'opportunity_field', opp.id, opp.id);
}

// QuickBooks sales-doc status → a GHL contact custom field (read-only QB→GHL).
// Highest status reached wins so we never downgrade (e.g. a re-sent estimate
// after invoicing won't overwrite "Invoiced"). Status/rank logic lives in
// qbSyncLogic.js (pure + unit-tested).
async function reflectSalesDocStatus(
  locationId, estimates, invoices, stats, cfg, linkIndex, deadlineAt,
  { since = null, changedCustomers = [], canAssign = false, linkTimes = new Map() } = {},
) {
  const targetField = cfg?.qboStatusGhlField ?? null;
  // Salesperson/rep, carried off the TRANSACTION. Carolyn, 2026-07-31: "it's hidden
  // on the invoice and the estimate, but they're using it for tracking. So we would
  // have to bring this, whatever field is in here, and they map it to their GHL
  // field." On Rockwood that field is `Rep` (value "Cody"), sitting beside Siding /
  // Trim / Roofing Color. This pair of settings already existed — it was simply
  // reading `Customer.CustomField`, where the value has never been.
  const repSource = cfg?.qboAssignedUserField ?? null;
  const repTarget = cfg?.qboAssignedUserGhlField ?? null;
  // Assigning the Synergy USER from the rep — the route that needs no new field in
  // the client's CRM. Mappings are read only when the toggle is on, so adding rows
  // to look around cannot start reassigning anyone's leads.
  const toAssignee = !!cfg?.qboRepToAssignee;
  // ONE read for every mapper this pass might consult, filtered in memory. Three
  // separate queries would be three subrequests, and this function already runs
  // inside the budget the 07-31 subrequest exhaustion taught us to respect.
  const qbMappers = await listMappers(locationId, 'quickbooks');
  // Still gated on the toggle, deliberately: reading these rows is what starts
  // reassigning leads, so adding a row to look around must stay harmless.
  const repUserMaps = toAssignee && repSource
    ? qbMappers.filter((m) => m.mapperType === 'qb_rep_user')
    : [];
  // Estimate/invoice fields the tenant chose to copy into Synergy — the BuildBridge
  // replacement for the code node behind Rockwood's Zapier webhooks. Empty list =
  // nothing configured = none of the work below happens.
  const docFieldMaps = qbMappers.filter((m) => m.mapperType === 'qb_doc_field');
  // The same catalog, aimed at the linked OPPORTUNITY instead of the contact — the
  // "Update opportunity" step of the GHL workflow this replaces. Update-only.
  const oppFieldMaps = qbMappers.filter((m) => m.mapperType === 'qb_doc_field_opp');
  // Dropdown option → the name this company calls it, for ANY custom field, keyed
  // `<field>::<value>`. Used for the `repName` field, for the rep custom field below
  // (which otherwise writes "2"), and for every mapped custom field — a client's
  // "Siding Color" reaches Synergy as "4" without it.
  const optionLabelMaps = qbMappers.filter((m) => m.mapperType === 'qb_option_label');
  // The opportunity's NAME and monetary VALUE, as tenant configuration. The legacy
  // GHL workflow hardcoded "first name + first line description"; the template makes
  // that a per-tenant choice ("{customerFirstName} {line1Description}") and the
  // value source picks any catalog key (typically subtotal). Config rows, not
  // columns — same as every other setting this integration has grown.
  const oppNameTemplate = qbMappers.find((m) => m.mapperType === 'qb_opp_name_template')?.ghlValue ?? null;
  const oppValueSource = qbMappers.find((m) => m.mapperType === 'qb_opp_value')?.ghlValue ?? null;
  // Synergy fields already spoken for by the QuickBooks-customer field mappings
  // (the "Field mappings" card). A document field must not write into one of those.
  const customerFieldTargets = qbMappers
    .filter((m) => m.mapperType === 'custom_field' && m.ghlValue)
    .map((m) => m.ghlValue);
  const wantOppWrite = oppFieldMaps.length > 0 || !!oppNameTemplate || !!oppValueSource;
  const wantDocFields = docFieldMaps.length > 0 || wantOppWrite;
  // Resolved whenever a SOURCE is named, even with no target yet — the result is the
  // diagnostic below, and it answers the one question nobody can answer from outside:
  // does this QuickBooks company actually expose that field through REST? If the four
  // fields on their forms turn out to be App Foundations fields, the values never
  // reach us and no amount of configuration helps. Silence here used to look
  // identical to success.
  // ⚠️ NOT the CDC documents. The `estimates`/`invoices` passed in come from Change
  // Data Capture, which does not carry `include=enhancedAllCustomFields`, so a modern
  // dropdown field is simply absent from them. The rep is therefore read from a
  // dedicated recent-documents fetch that DOES request enhanced fields. Two extra
  // reads per pass, only when a rep source is configured, and "latest document per
  // customer" is the right window anyway.
  let reps = new Map();
  let repDocs = null;
  // The same fetch feeds the document-field mapping, so it also runs when a tenant
  // has mapped fields but configured no rep. `links` asks QuickBooks for the
  // shareable document URL and is requested ONLY when someone mapped it — see
  // getRecentSalesDocs for why that include is treated as optional.
  if (repSource || wantDocFields) {
    try {
      repDocs = await getRecentSalesDocs(locationId, 50, {
        // Both destinations count — a link mapped only to an opportunity field is
        // still a link somebody asked for.
        links: [...docFieldMaps, ...oppFieldMaps].some((m) => m.externalKey === 'pdfLink'),
      });
      if (repSource) reps = repByCustomer(repDocs.estimates, repDocs.invoices, repSource);
    } catch (err) {
      console.warn(`[rockwood] enhanced custom-field read failed: ${err.message}`);
    }
  }
  if (repSource) {
    if (reps.size === 0) {
      // This pass carried no rep — but that is ambiguous, because the estimates and
      // invoices here come from Change Data Capture, so a quiet pass legitimately sees
      // nothing at all. Resolve the ambiguity with ONE read-only probe of recent
      // documents: if the configured field exists there, this is a quiet pass and
      // there is nothing to report; if it does not, the configuration is genuinely
      // broken and we say so, naming the fields that DO exist so the fix is obvious.
      const names = repDocs
        ? collectTxnCustomFieldNames(repDocs.estimates, repDocs.invoices)
        : [];
      const present = names.some((f) => f.name.toLowerCase() === repSource.toLowerCase());
      // The field is THERE but produced no value ⇒ we can see it and cannot read it.
      // That is the dropdown/List case, and the only way to learn its real JSON is to
      // report the KEYS a live entry carries. Keys only — a rep's name is customer data.
      if (present) {
        const shapes = new Set();
        for (const txn of [...(repDocs?.estimates ?? []), ...(repDocs?.invoices ?? [])]) {
          const cf = findQbCustomField(txn, repSource);
          const shape = describeQbCustomField(cf);
          if (shape) shapes.add(shape);
        }
        await recordError({
          source: 'cron',
          kind: 'qbo_rep_value_unreadable',
          appSlug: 'quickbooks',
          locationId,
          upstream: 'qbo',
          message: `QuickBooks field "${repSource}" IS present on recent documents, but no value could be read from it — most likely a dropdown (List) type whose JSON shape this reader does not yet handle. Entry shapes seen: ${[...shapes].join(' ; ') || '(none)'}. Send this line to whoever maintains BuildBridge; the fix is a one-line addition to qbCustomFieldValue.`,
          context: { job: 'rockwood-quickbooks-sync', field: repSource, shapes: [...shapes] },
        });
      } else if (names.length > 0) {
        // Field NAMES and counts only — never a rep's name, which is customer data.
        await recordError({
          source: 'cron',
          kind: 'qbo_rep_field_not_found',
          appSlug: 'quickbooks',
          locationId,
          upstream: 'qbo',
          message: `Configured to read the salesperson from QuickBooks field "${repSource}", but no recent estimate or invoice carries a custom field by that name. The fields actually present are: ${names.map((f) => f.name).join(', ')}. Open BuildBridge → QuickBooks and pick one of those.`,
          context: { job: 'rockwood-quickbooks-sync', field: repSource, found: names.map((f) => f.name) },
        });
      }
    } else if (reps.size > 0 && toAssignee
               && [...new Set(reps.values())].some((v) => !resolveAssignee(repUserMaps, v))) {
      // Assignee route is ON but some rep value points at nobody. Actionable, and it
      // stays useful long after setup: a NEW rep added in QuickBooks lands here
      // instead of being silently skipped. Lists the Synergy users so the fix is a
      // choice, not a hunt — the rep values are option ids, so no one can guess.
      const distinct = [...new Set(reps.values())];
      const unmapped = distinct.filter((v) => !resolveAssignee(repUserMaps, v));
      let roster = [];
      try {
        const u = await makeGhlRequest(
          locationId, 'GET', `/users/?locationId=${encodeURIComponent(locationId)}`,
        );
        roster = (u?.users ?? []).filter((x) => x?.id).map((x) => `${
          x.name || [x.firstName, x.lastName].filter(Boolean).join(' ') || x.email || '(unnamed)'
        } [${x.id}]`);
      } catch (err) {
        console.warn(`[rockwood] could not list Synergy users: ${err.message}`);
      }
      await recordError({
        source: 'cron',
        kind: 'qbo_rep_unmapped',
        appSlug: 'quickbooks',
        locationId,
        upstream: 'ghl',
        message: `${unmapped.length} of ${distinct.length} QuickBooks rep value(s) are not mapped to a Synergy user, so those contacts were left unassigned. Unmapped: ${unmapped.join(', ')}. Map them in BuildBridge → QuickBooks. Synergy users: ${roster.join(' | ') || '(could not list them)'}`,
        context: {
          job: 'rockwood-quickbooks-sync', field: repSource,
          unmapped, mapped: distinct.length - unmapped.length, users: roster,
        },
      });
    } else if (reps.size > 0 && !repTarget && !toAssignee) {
      // Name the CANDIDATES rather than just saying "go set a field". Whoever reads
      // this row is being asked to choose a destination, and the choice matters —
      // pick the wrong field and every synced contact has that field overwritten. So
      // the row carries the location's contact custom fields (id + label). Field
      // labels are the tenant's own configuration, not customer data.
      let candidates = [];
      try {
        const d = await makeGhlRequest(
          locationId, 'GET', `/locations/${encodeURIComponent(locationId)}/customFields?model=contact`,
        );
        candidates = (d?.customFields ?? [])
          .filter((f) => f?.id)
          .map((f) => `${f.name ?? f.fieldKey ?? '(unnamed)'} [${f.id}]`);
      } catch (err) {
        console.warn(`[rockwood] could not list GHL custom fields: ${err.message}`);
      }

      // ── DRY RUN: could we set the ASSIGNED USER instead of a custom field? ──
      // Carolyn asked for exactly this and was talked out of it (07-31, 54:32:
      // "Can we not do it with the regular fields … the owner" → "assignee"; and
      // 56:38, rejecting a custom field because "then we would have to go create an
      // app workflow"). It needs NO new field in the client's CRM — which matters
      // now that their 12 contact fields turn out to hold nothing rep-shaped.
      // Reports the match only. Reassigning a contact changes lead ownership and
      // notifications, so it is not something to start doing off an inference.
      let assigneeReport = null;
      try {
        const u = await makeGhlRequest(
          locationId, 'GET', `/users/?locationId=${encodeURIComponent(locationId)}`,
        );
        const users = (u?.users ?? []).filter((x) => x?.id);
        const norm = (v) => String(v ?? '').trim().toLowerCase();
        const index = new Map();
        for (const x of users) {
          for (const k of [x.name, x.email, [x.firstName, x.lastName].filter(Boolean).join(' ')]) {
            if (norm(k)) index.set(norm(k), x);
          }
        }
        const distinct = [...new Set(reps.values())];
        const matched = [], unmatched = [];
        for (const rep of distinct) {
          const hit = index.get(norm(rep))
            // A bare first name is the realistic case ("Cody"), so fall back to a
            // first-name match — but ONLY when exactly one user matches, because
            // two Codys means we must not guess which.
            ?? (users.filter((x) => norm(x.firstName) === norm(rep)).length === 1
              ? users.find((x) => norm(x.firstName) === norm(rep))
              : null);
          (hit ? matched : unmatched).push(hit ? `${rep} -> ${hit.id}` : rep);
        }
        assigneeReport = { users: users.length, distinctReps: distinct.length, matched, unmatched };
      } catch (err) {
        console.warn(`[rockwood] assignee dry-run failed: ${err.message}`);
      }
      await recordError({
        source: 'cron',
        kind: 'qbo_rep_target_missing',
        appSlug: 'quickbooks',
        locationId,
        upstream: 'ghl',
        message: `Read the salesperson from QuickBooks field "${repSource}" for ${reps.size} customer(s), but no Synergy field is chosen to copy it into, so nothing was written. Available contact fields: ${candidates.join(' | ') || '(could not list them)'}. ASSIGNEE DRY RUN (nothing assigned): ${
          assigneeReport
            ? `${assigneeReport.users} Synergy user(s); ${assigneeReport.distinctReps} distinct rep name(s); matched ${assigneeReport.matched.length} [${assigneeReport.matched.join(', ')}]; unmatched ${assigneeReport.unmatched.length} [${assigneeReport.unmatched.join(', ')}]`
            : '(could not run)'
        }`,
        context: {
          job: 'rockwood-quickbooks-sync', field: repSource, customers: reps.size,
          candidates, assignee: assigneeReport,
        },
      });
    }
  }
  // Who has news this pass. ONLY these contacts can have their assigned user
  // changed — see customersWithNews. A quiet contact keeps its owner forever, which
  // is the difference between "route new work to the rep" and "reassign the client's
  // whole customer list the moment someone ticks a box".
  //
  // Two filters on top of the raw answer, each closing a way a quiet contact could
  // still be reassigned:
  //
  //   canAssign — a pass with no stored cursor is NOT evidence of new activity.
  //   getSyncSince defaults a missing cursor to 30 days back, so the first completed
  //   pass would otherwise call a month of history "new" and reassign everyone in it.
  //
  //   isEcho — our OWN write to QuickBooks bumps that customer's LastUpdatedTime and
  //   comes back through Change Data Capture next pass looking exactly like a client
  //   edit. On a two-way tenant that means: someone reassigns a lead by hand in
  //   Synergy, BuildBridge mirrors some unrelated field change to QuickBooks, and the
  //   echo hands ownership straight back to the mapped rep. The contact half has
  //   suppressed this since it was written; the assignee route has to as well.
  // Who has news this pass, before any assignment-specific filtering. Pure and
  // cheap, and it is what makes the document work EVENT-DRIVEN: a customer whose
  // documents have not changed cannot have different field values, so visiting them
  // is a contact read, an opportunity search and a link touch spent to discover that
  // nothing happened. Rockwood has ~64 customers in the document window and a handful
  // of documents a day; the difference is the whole pass budget.
  const allNews = customersWithNews({
    changedCustomers,
    changedEstimates: estimates,
    changedInvoices: invoices,
    recentDocs: repDocs,
    since,
  });
  const hasNews = (customerId) => allNews.has(String(customerId));

  // What the salesperson field ACTUALLY contains on the documents that just changed.
  //
  // A dropdown sends an option NUMBER and QuickBooks exposes no way to ask which name
  // that number belongs to — and the numbers are not positions: an option deleted
  // years ago keeps its number, so four visible names can be 1, 2, 4, 5. Rockwood's
  // "Jadon" turned out not to be 3. The only way to learn a number is to set the field
  // on a document and see what arrives, so this prints exactly that, per customer, and
  // makes what was an afternoon of inference a single line in the log.
  //
  // Ids and option numbers only — no names, nothing about the customer.
  // The whole custom-field inventory this company's documents carry: every field,
  // every distinct option number, how often each appears, and the name if one is set.
  //
  // Free — it reads the documents the pass already fetched — and it is the answer to
  // the question that cost most of 2026-08-19: "what numbers does this dropdown
  // actually use?" QuickBooks will not say, its definitions API is tier-gated, and
  // the config page can only be read by someone logged in. A line in the log can be
  // read by whoever is debugging, which on that day was the difference between
  // knowing and inferring.
  //
  // Option NUMBERS and field names only. A rep's name appears only if the tenant
  // typed it here themselves.
  if (repDocs) {
    for (const f of optionsByField(repDocs.estimates, repDocs.invoices, optionLabelMaps)) {
      const inventory = f.values
        .map((v) => `${v.value}${v.label ? `=${v.label}` : ''} ×${v.count}`)
        .join(', ');
      console.log(`[rockwood] field "${f.field}" values in use — ${inventory}`);
    }
  }

  if (repSource && allNews.size) {
    const seen = [...allNews.keys()].filter((id) => reps.has(id)).map((id) => `${id}:${reps.get(id)}`);
    if (seen.length) {
      console.log(`[rockwood] "${repSource}" on documents with news (qbCustomer:value) — ${seen.join(', ')}`);
    }
  }
  const rawNews = canAssign ? allNews : new Map();
  const freshCustomers = new Set();
  for (const [qbCustomerId, news] of rawNews) {
    // Compared against the PRE-PASS stamp (see snapshotLinkTimes): the contacts half
    // has already run and touched the link of everything it wrote, so the live value
    // would call a customer QuickBooks created minutes ago "our own echo" and skip
    // the very assignment this feature exists to make.
    const prePass = (link) => (link ? (linkTimes.get(link.id) ?? null) : null);
    const contactBaseline = prePass(lookupLink(linkIndex, 'contact', { qbId: qbCustomerId }));
    // The DOCUMENT's own link, too. BuildBridge pushes Synergy opportunities into
    // QuickBooks as estimates, and that write bumps the estimate's LastUpdatedTime —
    // which arrives next pass as a changed document indistinguishable from one the
    // client edited. Watching only the customer link misses it entirely, so a lead
    // somebody deliberately reassigned gets handed back to the mapped rep.
    const docBaseline = news.docId
      ? prePass(lookupLink(linkIndex, 'estimate', { qbId: news.docId }))
      : null;
    const isOurs = (baseline) => baseline && isEcho(new Date(news.when), { lastSyncedAt: baseline });

    // MATCH THE LINK TO WHAT CHANGED. A document that changed is only ever our own
    // echo if WE wrote that document, so it is judged against the document's link.
    // Judging it against the CONTACT's link was wrong in a way that looked careful:
    // that link is touched by every write we make INTO Synergy — a status, a phone,
    // an opportunity field — none of which can change anything in QuickBooks. So a
    // contact we had just written to made the client's next genuine estimate edit
    // read as our echo, and the assignment they were testing never fired.
    // Observed 2026-08-19: estimate 1743 edited, Rep set to Jadon, and the pass
    // reported `qbRepAssignSkippedEcho: 2` instead of assigning anyone.
    //
    // News from the CUSTOMER RECORD still uses the contact link, and there the
    // reasoning holds: pushing a Synergy contact into QuickBooks is exactly what
    // bumps that record, and it touches that link as it goes.
    const echoed = news.docId ? isOurs(docBaseline) : isOurs(contactBaseline);
    // A stamp of 0 means the entity carried no usable timestamp, so we cannot tell an
    // echo from real activity. The answer that never reassigns wins.
    if (!news.when || echoed) {
      stats.qbRepAssignSkippedEcho += 1;
      continue;
    }
    freshCustomers.add(qbCustomerId);
  }

  // ── Estimate / invoice fields → the Synergy fields the tenant picked ──────────
  // One document per customer — the newest, same rule as the rep. This is what the
  // GHL code node did per webhook; polling means the latest document wins instead of
  // every document firing, which is the behaviour a CRM field wants anyway (the
  // contact shows their current estimate, not a history).
  //
  // ONLY for customers with news. The window holds up to a hundred documents and
  // sixty-odd customers; the ones that matter on any given pass are the handful whose
  // documents just changed. Reading all of them was not merely wasteful — the
  // 64-customer QuickBooks query and the parse behind it sat directly in front of the
  // first Synergy call, and that call is where Rockwood's pass died on 2026-08-19,
  // every fifteen minutes, for three and a half hours.
  const docValues = new Map(); // qb customer id → extracted values
  const newsCustomers = new Map(); // qb customer id → the QuickBooks Customer record
  if ((wantDocFields || repSource) && repDocs) {
    const latest = latestDocByCustomer(repDocs.estimates, repDocs.invoices);
    const newsIds = [...latest.keys()].filter(hasNews);
    if (newsIds.length) {
      // Only the company's own custom fields that someone actually mapped — reading
      // the rest off every document would be work nobody asked for.
      const mappedCustomFields = [...docFieldMaps, ...oppFieldMaps]
        .map((m) => customFieldName(m.externalKey))
        .filter(Boolean);
      // The customer RECORDS, in ONE query, for those few. A sales document carries
      // the name and the billing email but never a PHONE, so without this the phone
      // is permanently blank.
      const customers = await getCustomersByIds(locationId, newsIds);
      // Kept for the visit loop: a customer with news but no linked contact can be
      // adopted there, and adoption needs the record itself.
      for (const [id, c] of customers) newsCustomers.set(String(id), c);
      for (const customerId of newsIds) {
        const { doc, type } = latest.get(customerId);
        docValues.set(customerId, extractDocFields(doc, {
          type,
          repField: repSource,
          optionLabels: optionLabelMaps,
          customFieldNames: mappedCustomFields,
          customer: customers.get(customerId),
        }));
      }
    }
  }

  // Nothing to write ⇒ stop here. The rep half needs a resolved value AND a
  // destination — either a custom field or the assignee route; the diagnostics above
  // have already explained whichever is missing.
  const repHasDestination = (repTarget || (toAssignee && repUserMaps.length > 0)) && reps.size > 0;
  const docHasWork = wantDocFields && [...docValues.keys()].some(hasNews);
  if (!targetField && !repHasDestination && !docHasWork) return;

  // Best status per QB customer this run (invoices outrank estimates).
  //
  // ORDER MATTERS AS MUCH AS MEMBERSHIP. This loop visits at most
  // REP_VISITS_PER_PASS contacts and the cursor advances regardless, so a customer
  // that queues behind ten quiet ones does not get "done next time" — its news is
  // past the cursor by then and it is never assigned at all. The map is therefore
  // seeded with the customers who HAVE news, before anyone else: the rep window is
  // ordered by document recency across estimates and invoices separately, which puts
  // every invoice-only customer behind up to fifty estimate customers.
  // Precisely the customers an assignment could fire for: news this pass, a rep on
  // their latest document, and the route switched on. Anyone else is ordinary work
  // and can wait for a later pass without losing anything.
  const byCustomer = new Map();
  if (toAssignee && repUserMaps.length > 0) {
    for (const customerId of reps.keys()) {
      if (freshCustomers.has(customerId)) byCustomer.set(customerId, null);
    }
  }
  const consider = (customerId, status) => {
    if (!customerId) return;
    if (shouldUpgradeStatus(byCustomer.get(customerId), status)) {
      byCustomer.set(customerId, status);
    }
  };
  if (targetField) {
    for (const est of estimates) consider(est.CustomerRef?.value, estimateStatus(est));
    for (const inv of invoices) consider(inv.CustomerRef?.value, 'Invoiced');
  }
  // A customer whose only news is a rep still needs visiting — but only when there is
  // somewhere to put it. Without a destination these would be pointless GHL reads.
  if (repHasDestination) {
    for (const customerId of reps.keys()) {
      // A quiet customer is only worth a visit when there is a FIELD to write. The
      // assignee route acts on news alone, so queueing everyone who merely HOLDS a
      // rep spends a Synergy read per contact to discover there is nothing to do —
      // 8 visits and 44 deferrals on Rockwood's first healthy pass, all of them
      // "skipped: quiet", while the budget they consumed left the next location
      // failing mid-flight.
      if (!repTarget && !freshCustomers.has(customerId)) continue;
      if (!byCustomer.has(customerId)) byCustomer.set(customerId, null);
    }
  }
  // Same for a customer whose only news is a MAPPED document field.
  //
  // Gated on there being a mapping, and that gate is load-bearing. `docValues` is now
  // populated for any tenant with a rep source, so without it every customer in the
  // 50-document window joined the visit queue on every pass — for Rockwood that took
  // a pass which had been returning immediately (nothing mapped, no rep destination)
  // and gave it a contact-by-contact loop plus both downstream halves. The pass
  // stopped reaching setSyncState at 08:31 UTC on 2026-08-19 and the cursor sat for
  // two and a half hours: the same silent-termination signature as 07-30 and 08-03,
  // where the work is done and the invocation dies before the cursor write.
  //
  // The phone still reaches a contact this loop visits for any other reason.
  if (wantDocFields) {
    for (const customerId of docValues.keys()) {
      if (hasNews(customerId) && !byCustomer.has(customerId)) byCustomer.set(customerId, null);
    }
  }

  let visited = 0;      // routine work — bounded by REP_VISITS_PER_PASS
  let freshVisited = 0; // contacts with news — bounded by FRESH_VISITS_PER_PASS
  for (const [customerId, status] of byCustomer) {
    // ── Budget guard ──────────────────────────────────────────────────────────
    // This loop had NO guard, which was survivable while it only ran for the
    // handful of customers whose sales-doc status had changed. The rep work made it
    // iterate every customer carrying a rep — 53 on Rockwood — each costing a GHL
    // GET even when nothing needs writing. That ate the pass budget before the
    // GHL→QuickBooks half ran, so that half deferred, and a deferred half rewinds
    // the shared cursor to `since`: observed 2026-08-03, the cursor sat at 07:15 for
    // over an hour while passes kept running. Same deadlock shape as 07-30/07-31.
    //
    // Stopping early is safe here in a way it is not elsewhere: this loop derives
    // everything from the CURRENT QuickBooks documents and writes only on change, so
    // an unvisited customer is simply picked up next tick. Nothing is lost, and it
    // does not touch `processedThrough`, so it cannot move the cursor past unhandled
    // work either.
    // A HARD CAP, not just a deadline. The deadline guard alone was not enough and the
    // reason matters: guarding *at* `passDeadline` lets this loop legitimately consume
    // the entire 60s budget and still exit "cleanly", starving every later stage — and
    // 60s is itself longer than this pass can safely run, since each visit costs a GHL
    // subrequest and the invocation has finite subrequests and wall-clock. Observed
    // 2026-08-03: passes did work, then vanished — no cursor write, no alarm, no error
    // row, which is what a platform-level termination looks like (a thrown error would
    // have been recorded).
    //
    // A count is predictable where a timeout is not: ~10 contacts is a few seconds of
    // I/O whatever the network is doing, so the later halves always get budget and the
    // invocation always reaches setSyncState. The remainder is picked up next tick —
    // safe here because every value is re-derived from the current QuickBooks documents
    // and written only on change.
    //
    // A contact WITH NEWS draws on its own, larger budget (FRESH_VISITS_PER_PASS).
    // The paragraph above is true of routine work and false of news: "picked up next
    // tick" assumes the value is re-derived, and by next tick the cursor has moved
    // past the document that made this customer fresh, so a deferred assignment is a
    // lost one. Two budgets rather than one big one, because the reason to bound
    // routine visits has not changed.
    const isFresh = freshCustomers.has(String(customerId));
    const overBudget = isFresh
      ? freshVisited >= FRESH_VISITS_PER_PASS
      : visited >= REP_VISITS_PER_PASS;
    if (overBudget || budgetExhausted() || (deadlineAt && visited + freshVisited > 0 && Date.now() >= deadlineAt)) {
      stats.qbRepDeferred = (stats.qbRepDeferred ?? 0) + 1;
      if (isFresh) stats.qbRepFreshDeferred += 1;
      continue; // count the rest rather than break, so the stat is the true remainder
    }
    // Same per-record isolation as the contact loop above. The GET below was already
    // guarded but the PUT was not, so one contact GHL rejected here aborted the whole
    // pass — after the contacts had synced and before setSyncState, which is the worst
    // possible place to die: work done, cursor not advanced, so it all runs again.
    try {
      let link = lookupLink(linkIndex, 'contact', { qbId: customerId });
      if (!link && newsCustomers.has(String(customerId))) {
        // ADOPT, don't skip. Links are only ever written by the customer half, which
        // runs off Change Data Capture on the CUSTOMER record — so a customer whose
        // ESTIMATE changed while their record sat untouched has no link, and never
        // gets one, and therefore never receives a status, a rep, a phone or a
        // document field. Not an edge case: it is every established customer, which
        // is exactly what QuickBooks customer 2390 turned out to be when Ahsan's test
        // estimate reported `skipped: 1` and no assignment on 2026-08-19.
        //
        // Only for customers with news (their record is in hand), and it goes through
        // the same create-or-adopt path the customer half uses, so the duplicate
        // handling and the phone-only rules are not reimplemented here.
        try {
          await syncOneQbCustomerToGhl(locationId, newsCustomers.get(String(customerId)), stats, {
            contactCustomFields: () => [],
            linkIndex,
          });
          link = lookupLink(linkIndex, 'contact', { qbId: customerId });
          if (link) stats.qbContactsAdoptedForNews += 1;
        } catch (err) {
          console.warn(`[rockwood] could not link QB customer ${customerId} to a contact: ${err.message}`);
        }
      }
      if (!link) {
        // Still nothing to write to: no email and no phone to match on, or GHL
        // refused. Counted, and picked up again on the customer's next change.
        stats.skipped++;
        continue;
      }

      if (isFresh) freshVisited += 1; else visited += 1;
      // Don't downgrade: read the contact's current status value first.
      let deletedInSynergy = false;
      // "Gone" is detected by the reason as well as the status: GHL is not
      // consistent about which 4xx a deleted contact earns, and a missed detection
      // here recreates the 2026-08-20 hole — a dead link silently skipped forever.
      // Anything else is LOGGED with its status and reason, because a swallowed
      // `.catch(() => null)` is why that hole took a day to see.
      const readContact = () => makeGhlRequest(locationId, 'GET', `/contacts/${link.ghlId}`)
        .catch((err) => {
          const status = err.upstreamStatus ?? err.status;
          if (status === 404 || /not\s*found/i.test(err.ghlReason ?? err.message ?? '')) {
            deletedInSynergy = true;
          } else {
            console.warn(`[rockwood] contact read failed for ${link.ghlId}: HTTP ${status ?? '?'} — ${err.ghlReason ?? err.message}`);
          }
          return null;
        });
      let existing = await readContact();
      // One retry, and only for a contact with news. A rate-limited read costs this
      // contact its assignment for good (the cursor moves past the document that made
      // it fresh), so one extra request is cheap insurance against a 429 that the
      // routine path can simply shrug off and redo next pass.
      if (!existing && isFresh && !deletedInSynergy) {
        existing = await readContact();
      }
      // 404 is not a failed read — it is Synergy saying the contact is GONE, deleted
      // by hand. The link is the only reason this loop believed one existed, so drop
      // it and rebuild from the QuickBooks record (in hand for any customer with
      // news) through the same create-or-adopt path as always. Without this, a
      // deleted contact is a permanent hole: every pass reads a dead id, skips, and
      // never creates, precisely because the link routes away from the create path.
      if (deletedInSynergy) {
        await deleteLink(linkIndex, link);
        const record = newsCustomers.get(String(customerId));
        if (record) {
          try {
            await syncOneQbCustomerToGhl(locationId, record, stats, {
              contactCustomFields: () => [],
              linkIndex,
            });
            link = lookupLink(linkIndex, 'contact', { qbId: customerId });
            if (link) {
              stats.qbContactsRelinked += 1;
              console.log(`[rockwood] recreated the Synergy contact for QB customer ${customerId}`);
              deletedInSynergy = false;
              existing = await readContact();
            }
          } catch (err) {
            console.warn(`[rockwood] could not recreate the contact for QB customer ${customerId}: ${err.message}`);
          }
        }
      }
      // A failed read is NOT an empty contact. Every decision below is a comparison
      // against what Synergy currently holds — don't downgrade the status, don't
      // rewrite the rep, only fill an EMPTY phone, skip a custom field that already
      // matches — and a null `existing` answers all four with "it holds nothing".
      // A rate-limited GET would then reassign an owner, overwrite a phone someone
      // corrected, and PUT a customFields array built from no baseline. Skipping
      // costs one pass; the contact is re-derived from the same documents next tick.
      // Keyed on the REQUEST failing (the catch above is the only thing that makes
      // this null), not on the body's shape — a 200 with an unexpected shape keeps
      // the behaviour it has always had rather than gaining a new way to stall.
      if (!existing) {
        stats.qbContactReadFailed += 1;
        continue;
      }
      const readField = (id) => {
        const f = (existing?.contact?.customFields ?? []).find(
          (x) => x.id === id || x.fieldKey === id,
        );
        return f?.value ?? f?.fieldValue;
      };

      // QuickBooks is the source of truth for the phone, full stop. Ahsan,
      // 2026-08-19: "we are not using synergy for number because all the leads come
      // from quickbooks… if there is no number in quickbooks then we leave them, but
      // if the contact have a phone then we update it in synergy."
      //
      // So this is an UPDATE, not the fill-only backfill it started as: a number in
      // QuickBooks replaces a different number in Synergy. No phone in QuickBooks
      // leaves Synergy exactly as it is — we never invent one from the CRM side, and
      // the mapped "Customer phone" field shows QuickBooks or nothing.
      const qbPhone = docValues.get(customerId)?.customerPhone ?? null;

      // Two independent writes into one PUT. Each decides for itself whether it has
      // anything to say, because they move on different rules: status only ever
      // climbs, while the rep is simply the latest value and may legitimately change
      // to a different name.
      const writes = [];
      if (targetField && status && shouldUpgradeStatus(readField(targetField), status)) {
        writes.push({ id: targetField, value: status });
      }
      const rep = reps.get(customerId);
      // Written as the NAME when the tenant has told us what the option id means.
      // Without a rep-name row this is the raw value exactly as before — a dropdown
      // sends "2", and "2" in a Synergy field is what the rep-name list exists to fix.
      const repOut = rep ? optionLabel(optionLabelMaps, repSource, rep) : null;
      if (repTarget && repOut && String(readField(repTarget) ?? '') !== repOut) {
        writes.push({ id: repTarget, value: repOut });
      }
      // The mapped estimate/invoice fields. Added last and never over a target one of
      // the settings above already claimed: those are explicit single-purpose
      // settings, and two writers on one field would flip its value every pass.
      // Excluded against the CONFIGURED targets, not against the writes this pass
      // happened to produce: the status write only appears when the status climbed
      // and the rep write only when the value changed, so comparing against `writes`
      // would let a document field take over the status field on every quiet pass
      // and fight it on the noisy ones.
      // Every OTHER writer into this contact's custom fields: the two single-purpose
      // settings, and the "Field mappings" card, which copies QuickBooks CUSTOMER
      // fields into Synergy on a different schedule. Two writers on one field do not
      // merge, they alternate — whichever ran last wins, every fifteen minutes.
      const claimed = new Set([
        targetField,
        repTarget,
        ...customerFieldTargets,
      ].filter(Boolean));
      const docWrites = docValues.has(customerId)
        ? docFieldWrites(
          docValues.get(customerId),
          docFieldMaps,
          existing?.contact?.customFields ?? [],
        ).filter((w) => !claimed.has(w.id) && !writes.some((x) => x.id === w.id))
        : [];
      writes.push(...docWrites);
      // The assignee route: the rep's mapped Synergy user becomes the contact's owner.
      // Only when it CHANGES — reassigning re-fires notifications, so a no-op write is
      // not harmless here the way a repeated field write would be.
      // Every way this can decline to assign is now counted, because "it did not
      // assign" had four possible causes and the stats could not tell them apart —
      // a contact was visited on real news and nothing happened, and answering why
      // meant reading source and guessing. Each branch below is a different fix.
      let assignTo = null;
      if (toAssignee) {
        if (!rep) {
          // The customer's newest document carries no value in the salesperson
          // field. Nothing to map — the fix is in QuickBooks, not here.
          stats.qbRepNoValue += 1;
        } else if (!freshCustomers.has(String(customerId))) {
          // Quiet contact: the rep is known, the mapping exists, and we still leave
          // the owner alone. Working as intended.
          stats.qbRepAssignSkippedQuiet += 1;
        } else {
          const mapped = resolveAssignee(repUserMaps, rep);
          if (!mapped) {
            // A rep value nobody has pointed at a Synergy user — the fix is a row in
            // the rep mapping.
            stats.qbRepUnmapped += 1;
          } else if (String(existing?.contact?.assignedTo ?? '') === mapped) {
            // Already owned by the right person. Nothing to do, and NOT a failure —
            // this is what a working assignment looks like on the second pass.
            stats.qbRepAlreadyAssigned += 1;
          } else {
            assignTo = mapped;
          }
        }
      }

      // The contact's own phone field, from the QuickBooks customer record.
      // FILL-ONLY: written when Synergy holds no phone, never over one it has. The
      // customer sync is what keeps a phone up to date (digit-compared, so formatting
      // is not churned); this is the backfill for contacts that were created before
      // the number existed in QuickBooks, or whose number sits in a slot the old
      // reader ignored. A contact nobody can call is the thing being fixed — quietly
      // replacing a number someone corrected in Synergy is not.
      // Digit comparison and nothing else. QuickBooks' "(330) 555-0142" and Synergy's
      // "+13305550142" are the same number, and a byte comparison would trade them
      // back and forth forever, one write per pass each.
      //
      // NO last-write-wins here, deliberately, and this is the second attempt at this
      // line. The first added the same `targetIsNewer` guard the contact half uses —
      // which reads correctly and is wrong here, because the two paths are fed
      // differently. The contact half runs on Change Data Capture, so its QuickBooks
      // timestamp is fresh by construction and the guard only ever settles a genuine
      // race. This path is driven by recent DOCUMENTS, so the customer record's stamp
      // can be months old while the Synergy contact's moves on any activity at all —
      // a tag, an inbound text, our own write earlier in this pass. The comparison
      // therefore said "Synergy is newer" permanently, the update never fired, and the
      // push half then sent the stale CRM number into QuickBooks: the client's rule,
      // exactly inverted. QuickBooks is the source; when it has a number, it wins.
      const phoneWrite = qbPhone && !samePhone(qbPhone, existing?.contact?.phone)
        ? qbPhone
        : null;

      // Nothing changed ⇒ no PUT. Skipping the request also skips touchLink, which is
      // correct: an unchanged contact should not have its echo cursor moved.
      if (writes.length || assignTo || phoneWrite) {
        // Merge into existing custom fields so a write never wipes the other's field.
        let customFields = existing?.contact?.customFields;
        for (const w of writes) customFields = mergeCustomFields(customFields, w);
        const payload = {
          ...(writes.length ? { customFields } : {}),
          ...(assignTo ? { assignedTo: assignTo } : {}),
          ...(phoneWrite ? { phone: phoneWrite } : {}),
        };
        // The PHONE is the only part of this that Synergy can refuse.
        //
        // A location with duplicate-blocking on rejects an update whose phone already
        // belongs to a different contact — "This location does not allow duplicated
        // contacts", HTTP 400. That is a fair refusal, but it takes the WHOLE PUT
        // down with it, so a rep assignment and a set of document fields were being
        // lost over a phone number: 4 rejections on Rockwood's test contact between
        // 2026-08-19 17:15 and 2026-08-20 11:30, and no owner ever changed.
        //
        // Retried once without it. The phone is the optional half — the fields and
        // the owner are what someone configured — and a number Synergy already holds
        // on another contact is one it does not need from us.
        let phoneRefused = false;
        let duplicateHolderId = null;
        try {
          await makeGhlRequest(locationId, 'PUT', `/contacts/${link.ghlId}`, payload);
        } catch (err) {
          const duplicate = err.ghlDuplicateContactId
            || /duplicated contacts/i.test(err.ghlReason ?? err.message ?? '');
          if (!phoneWrite || !duplicate) throw err;
          phoneRefused = true;
          duplicateHolderId = err.ghlDuplicateContactId ?? null;
          delete payload.phone;
          if (Object.keys(payload).length === 0) throw err;
          await makeGhlRequest(locationId, 'PUT', `/contacts/${link.ghlId}`, payload);
        }
        if (phoneRefused) {
          stats.qbPhoneRefusedAsDuplicate += 1;
          const holder = duplicateHolderId ? ` (held by contact ${duplicateHolderId})` : '';
          console.warn(`[rockwood] Synergy refused the phone for contact ${link.ghlId} as a duplicate${holder} — wrote everything else`);
          // Durable and tenant-visible, because only the tenant can resolve it: two
          // contacts claim one number and BuildBridge cannot know which is right.
          // Ids only — the NUMBER is customer data and stays out of the log.
          await recordError({
            source: 'cron',
            kind: 'ghl_phone_duplicate',
            appSlug: 'quickbooks',
            locationId,
            upstream: 'ghl',
            message: `Synergy refused the QuickBooks phone number for contact ${link.ghlId} because another contact already holds that number${holder} and this location blocks duplicates. The owner and fields were still written. To let the number through: merge or correct the two contacts in Synergy, or allow duplicate contacts in location settings; it will copy on the customer's next change.`,
            context: {
              job: 'rockwood-quickbooks-sync',
              ghlContactId: String(link.ghlId),
              holderContactId: duplicateHolderId ?? null,
              qbCustomerId: String(customerId),
            },
          });
        }
        if (phoneWrite && !phoneRefused) stats.qbPhoneBackfilled += 1;
        if (assignTo) stats.qbRepAssigned = (stats.qbRepAssigned ?? 0) + 1;
        if (writes.some((w) => w.id === repTarget)) stats.qbRepUpdated = (stats.qbRepUpdated ?? 0) + 1;
        if (docWrites.length) {
          stats.qbDocFieldsUpdated += docWrites.length;
          stats.qbDocFieldContacts += 1;
        }
        // Advance the link cursor so this GHL write isn't re-detected as a
        // GHL-origin change and pushed back to QBO next cycle (echo suppression).
        await touchLink(link);
        if (writes.some((w) => w.id === targetField)) stats.qbStatusUpdated++;
      }

      // The opportunity half, gated on someone having mapped a field to one. Its own
      // request, after the contact write rather than instead of it: the two are
      // different records in Synergy and a client can map to either or both.
      // Only for a customer with news. Each call is an opportunity SEARCH plus, on a
      // change, a PUT and a link write — and every one of those carries a database
      // read for the Synergy token. Running it for every customer in the document
      // window is what exhausted the invocation's subrequests on 2026-08-19: the
      // pass died mid-flight, silently, and the cursor stopped moving for hours.
      if (wantOppWrite && docValues.has(customerId) && hasNews(customerId)) {
        // Isolated from the contact write above so a rejection here is reported as
        // itself. GHL takes opportunity custom fields in a different shape from
        // contact ones, and "opportunity update refused" must not surface as a status
        // failure on a contact that in fact updated cleanly.
        try {
          await reflectDocFieldsToOpportunity(
            locationId, link.ghlId, docValues.get(customerId), oppFieldMaps, cfg, linkIndex, stats,
            since, { nameTemplate: oppNameTemplate, valueSource: oppValueSource },
          );
        } catch (err) {
          stats.qbOppFieldsFailed += 1;
          console.error(`[rockwood] opportunity field write failed for contact ${link.ghlId}:`, err.message);
          await recordThrown(err, {
            source: 'cron',
            kind: 'qbo_opportunity_field_write_failed',
            appSlug: 'quickbooks',
            locationId,
            upstream: 'ghl',
            context: { job: 'rockwood-quickbooks-sync', ghlContactId: String(link.ghlId ?? '') },
          });
        }
      }
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
  if (!pipelineId) return null; // not configured → no gating (see the caller)
  // Deliberately NOT caught here. This used to fail OPEN — a transient GHL error
  // returned null, which the caller reads as "no gating", i.e. push EVERY changed
  // contact into the client's accounting system. That is the opposite polarity to
  // the one this repo uses for accounting writes everywhere else, and it would
  // strike precisely when a location is newly connected and its whole contact list
  // is inside the first-sync window. The caller now skips creates for the pass and
  // reports it; an empty pipeline still correctly gates everything.
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=100`,
  );

  const set = new Set();
  for (const opp of data.opportunities ?? []) {
    const cid = opp.contactId ?? opp.contact?.id;
    if (cid) set.add(String(cid));
  }
  return set;
}

async function syncGhlContactsToQb(locationId, since, stats, settings, deadlineAt, linkIndex) {
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
  let pipelineGate = null;
  try {
    pipelineGate = await contactIdsInPipeline(locationId, settings?.qboContactSyncPipelineId);
  } catch (err) {
    // Configured but unreadable ⇒ DEFER THE WHOLE HALF, and do it before the loop.
    //
    // Failing closed on the creates alone was wrong in a way that took an adversarial
    // review to see: `handled`/`processedThrough` advance for every contact the loop
    // walks, so skipped creates would have left deferred === 0, the cursor would have
    // been written to the run start, and the next pass's `<= since` filter would have
    // dropped those contacts for good — a transient GHL blip losing customers
    // permanently. Fail-closed has to mean "retry", not "skip".
    //
    // Returning deferred = the whole page (with no high-water mark) holds the cursor at
    // `since`, so this pass is simply re-run next tick. Updates to already-linked
    // contacts wait one tick too; they are idempotent and cost nothing.
    await recordThrown(err, {
      source: 'cron',
      kind: 'qbo_contact_gate_unavailable',
      appSlug: 'quickbooks',
      locationId,
      upstream: 'ghl',
      // recordThrown lifts upstreamStatus/stack/path off the error — which keeps a 401
      // (support must fix it) distinguishable from a 502 (it will pass), and keeps the
      // fingerprint from collapsing every status into one row.
      context: { job: 'rockwood-quickbooks-sync', pipelineId: String(settings?.qboContactSyncPipelineId ?? '') },
    });
    return { processedThrough: 0, deferred: contacts.length };
  }

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
      (budgetExhausted() || (deadlineAt && Date.now() >= deadlineAt)) &&

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
      const link = lookupLink(linkIndex, 'contact', { ghlId: contact.id });
      if (isEcho(ghlUpdatedAt, link)) continue;

      const firstName = contact.firstName ?? undefined;
      const lastName = contact.lastName ?? undefined;
      const name = deriveContactName(contact);
      const billAddr = ghlAddressToQb(contact);

      if (link) {
        // Read the QB side for SyncToken + LWW comparison
        const current = await makeQuickBooksRequest(
          locationId, 'GET', `/customer/${link.qbId}?minorversion=75`,
        ).catch(() => null);
        const customer = current?.Customer;
        if (!customer) continue;
        if (targetIsNewer(ghlUpdatedAt, customer.MetaData?.LastUpdatedTime)) continue; // QB wins

        // The NAME is sent only when it CHANGED in Synergy since our last push —
        // not merely because QuickBooks holds something different. QuickBooks is the
        // client's ledger and legitimately spells a customer differently (a
        // convention, a business name, or a correction they typed by hand); pushing
        // on difference re-imposes GHL's spelling on every pass that looks newer,
        // which is why a manual fix "will soon be switched back". A link with no
        // baseline yet — every pre-0010 link, and every customer we adopted rather
        // than created — is seeded here and left alone.
        const nameDecision = nameSyncDecision(name, link.lastPushedName);

        // Then: only fields that actually differ. A case-only difference is never a
        // change (see qbCustomerChanges), and a no-op write would still bump the
        // customer's QuickBooks LastUpdatedTime, which is an input to the LWW
        // comparison above. BillAddr stays whole-object: sent or not sent.
        //
        // firstName/lastName are passed UNCONDITIONALLY, unlike the display name.
        // Gating them on the display-name baseline looked tidy and was a real defect:
        // the derived display name is often the `contactName` blob, which is
        // independent of the parts, so a client fixing "Jon" → "John" on a contact
        // named "Acme Sheds" would never have reached QuickBooks again. They need no
        // baseline of their own because qbCustomerChanges already compares them
        // case-insensitively against the live customer, which is the only protection
        // the incident actually required — and it pins DisplayName when it emits a
        // component, so QuickBooks cannot regenerate the name from them.
        const changes = qbCustomerChanges(
          {
            ...(nameDecision.push ? { name } : {}),
            firstName,
            lastName,
            email: contact.email,
            // PHONE IS DELIBERATELY NOT SENT on an update. Ahsan, 2026-08-19:
            // "we are not using synergy for number… we use quickbooks as our primary
            // source". Sending it made Synergy the winner in practice, not in theory:
            // a QuickBooks customer record edited months ago always loses the
            // last-write-wins comparison to a contact that Synergy touched yesterday
            // for any reason at all, so the stale CRM number was pushed into the
            // ledger and the ledger's correct one was overwritten. A number typed in
            // Synergy now stays in Synergy until QuickBooks says otherwise.
            //
            // Creating a customer is different and still sends it (findOrCreateCustomer
            // below): a brand-new customer has no number for QuickBooks to be right
            // about, and a contact QuickBooks has never seen is not QuickBooks
            // disagreeing — it is QuickBooks not knowing.
            billAddr,
          },
          customer,
        );
        if (Object.keys(changes).length === 0) {
          // Nothing to say to QuickBooks. Still advance the echo cursor, or this
          // contact is re-examined on every pass for as long as it stays changed.
          await touchLink(link, nameDecision.baseline);
          stats.ghlToQbContactsUnchanged++;
          continue;
        }

        await makeQuickBooksRequest(locationId, 'POST', '/customer?minorversion=75', {
          Id: customer.Id,
          SyncToken: customer.SyncToken,
          sparse: true,
          ...changes,
        });
        // Baseline is recorded only after QuickBooks accepted the write, so a failed
        // push is retried next pass instead of being remembered as done.
        await touchLink(link, nameDecision.baseline);
        // Counted only when the body carried a DisplayName that DIFFERS from what
        // QuickBooks held — not from the decision to try, and not from the pinned copy
        // qbCustomerChanges adds when it emits a name component. This stat is the
        // tripwire for this incident returning, so it must count actual renames only.
        if (changes.DisplayName && changes.DisplayName !== String(customer.DisplayName ?? '').trim()) {
          stats.ghlToQbNamesUpdated++;
        }
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
          billAddr,
        });
        // Record the name baseline at link time. Right whether findOrCreateCustomer
        // CREATED this customer (it is the name we sent) or MATCHED an existing one
        // (it is what GHL said when we linked, so a later GHL rename still pushes
        // while today's ledger spelling is left alone).
        //
        // Falls back to the email because that is what findOrCreateCustomer used as the
        // DisplayName when GHL had no name at all (`name ?? email`). Leaving the
        // baseline NULL there would mean the customer stays named after an email
        // address forever: the first pass where GHL finally has a name would hit the
        // null-baseline branch and seed instead of pushing.
        await upsertLink(linkIndex, locationId, 'contact', contact.id, customer.Id, name ?? contact.email ?? null);
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

async function syncGhlOpportunitiesToQb(locationId, since, stats, deadlineAt, linkIndex, cfg) {
  const data = await makeGhlRequest(
    locationId,
    'GET',
    `/opportunities/search?location_id=${encodeURIComponent(locationId)}&limit=100`,
  );
  // Oldest change first, same reason as both contact halves: this loop shares the
  // single timestamp cursor, so a pass that can't finish may only advance it to
  // the last record it actually handled.
  const opportunities = [...(data?.opportunities ?? [])].sort(
    (a, b) => ghlUpdatedMs(a) - ghlUpdatedMs(b),
  );

  // The location's QBO item mapping (mapperType 'qb_item') → the line item to
  // bill. Resolved once per pass. There is deliberately NO fallback item: the
  // old hardcoded ItemRef '1' was a guess about the client's chart of items,
  // and QBO rejects it with [2500] Invalid Reference Id in any company that
  // has no item with that Id (Rockwood, 2026-07-31 — the estimate 400 that
  // blocked this tenant since 07-30).
  const itemMaps = await listMappers(locationId, 'quickbooks', 'qb_item');

  // ── Salesperson (migration 0008) ──
  // QuickBooks' API never says who is logged in, so the salesperson has to be
  // carried over from GHL and stamped on the document as a legacy sales-form
  // custom field. Entirely opt-in: with no field name configured, none of this
  // runs and not a single extra API call is made.
  const salespersonField = cfg?.qboSalespersonQbField ?? null;
  let salespersonMaps = [];
  let ghlUsersById = new Map();
  if (salespersonField) {
    salespersonMaps = await listMappers(locationId, 'quickbooks', 'qb_salesperson');
    // The opportunity carries `assignedTo` (a user id) and nothing else about the
    // person, so the roster is fetched ONCE per pass — not per deal — and only
    // when a mapping actually exists to consume it. A failure here is non-fatal:
    // the per-deal override still works, and losing the salesperson must never
    // stop estimates syncing.
    if (salespersonMaps.length > 0) {
      try {
        const users = await makeGhlRequest(
          locationId, 'GET', `/users/?locationId=${encodeURIComponent(locationId)}`,
        );
        for (const u of users?.users ?? []) {
          if (u?.id) ghlUsersById.set(String(u.id), u);
        }
      } catch (err) {
        console.warn(`[rockwood] salesperson: could not load GHL users: ${err.message}`);
      }
    }
  }

  let processedThrough = 0;
  let handled = 0;
  // Opportunities skipped because no QBO item could be determined for them.
  // Reported once per pass, not once per record — it is one config problem.
  let unmapped = 0;

  for (const opp of opportunities) {
    // The QBO item to bill for THIS deal, resolved from the deal's own GHL
    // custom-field values (so a 2+ item mapping picks the item the deal's
    // selecting field points at; null → no usable mapping, handled below).
    const oppFieldValues = oppGhlFieldValues(opp);
    const itemRef = resolveItemRef(itemMaps, oppFieldValues);
    // Who to credit on the QuickBooks document. Null when unconfigured or
    // unmatched — and then nothing is written, rather than a guessed name.
    const salesperson = salespersonField
      ? resolveSalesperson({
        mappings: salespersonMaps,
        ghlFieldValues: oppFieldValues,
        ghlFieldId: cfg?.qboSalespersonGhlField ?? null,
        user: ghlUsersById.get(String(opp.assignedTo ?? '')) ?? null,
      })
      : null;
    const spFields = salespersonCustomField(salespersonField, cfg?.qboSalespersonSlot ?? 1, salesperson);
    const ghlUpdatedAt = opp.updatedAt ?? opp.dateUpdated;
    if (ghlUpdatedAt && new Date(ghlUpdatedAt) <= since) {
      handled++; // already covered by the cursor — not deferred work
      continue;
    }
    // Echo suppression for the QuickBooks→Synergy opportunity write (2026-08-19).
    // That write bumps the opportunity's updatedAt, which this loop would otherwise
    // read as a Synergy edit and push back — rewriting the QuickBooks estimate the
    // values came FROM, or creating a second one for a deal that has no link. The
    // marker row is written only by that half, so this suppresses our own writes and
    // nothing else: a real Synergy edit after it is newer and still pushes.
    const oppEchoLink = lookupLink(linkIndex, 'opportunity_field', { ghlId: opp.id });
    if (oppEchoLink && isEcho(ghlUpdatedAt, oppEchoLink)) {
      handled++;
      continue;
    }

    // Budget guard — see syncQbCustomersToGhl. This loop was the one half with no
    // deadline: each opportunity costs a link lookup (~2.5s through DB_WORKER), so
    // a backlog of them outran the whole scheduled invocation and died silently
    // AFTER the contact halves — cursor never written, nothing recorded (the
    // 07-31 stuck-cursor incident, same mechanism as 07-30's).
    if (
      (budgetExhausted() || (deadlineAt && Date.now() >= deadlineAt)) &&

      processedThrough &&
      ghlUpdatedMs(opp) !== processedThrough
    ) {
      break;
    }
    handled++;
    const oppTs = ghlUpdatedMs(opp);
    if (oppTs) processedThrough = oppTs;

    // Per-record isolation, same polarity as both contact loops. Without it, one
    // estimate QuickBooks rejects throws out of syncLocation before setSyncState,
    // so the cursor never advances and the whole tenant re-runs forever — the
    // exact deadlock the contact loops were cured of on 07-29/30.
    try {
      const link = lookupLink(linkIndex, 'estimate', { ghlId: opp.id });
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

        // No mapping? Reuse the item already on the estimate — an amount update
        // must not require config it didn't need to create the line, and writing
        // back the estimate's own item can't corrupt the client's books.
        const currentItemRef = (estimate.Line ?? []).find(
          (l) => l?.DetailType === 'SalesItemLineDetail',
        )?.SalesItemLineDetail?.ItemRef?.value;
        const effectiveItemRef = itemRef ?? currentItemRef;
        if (!effectiveItemRef) {
          unmapped++;
          continue;
        }

        await upsertEstimate(locationId, {
          qbEstimateId: estimate.Id,
          syncToken: estimate.SyncToken,
          qbCustomerId: estimate.CustomerRef?.value,
          amountCents,
          description: opp.name,
          itemRef: effectiveItemRef,
          // Merged against what the estimate already carries: a sparse update
          // REPLACES the CustomField array, so sending only our slot would blank
          // the other two — fields this location may well fill in by hand.
          customFields: mergeQboCustomFields(estimate.CustomField, spFields),
        });
        await touchLink(link);
        stats.ghlToQbEstimatesUpdated++;
      } else {
        const contactLink = opp.contactId
          ? lookupLink(linkIndex, 'contact', { ghlId: opp.contactId })
          : null;
        if (!contactLink) {
          console.warn(`[rockwood] skipping GHL opportunity ${opp.id}: no QB customer link for contact ${opp.contactId ?? '(none)'}`);
          stats.skipped++;
          continue;
        }

        // Creating a line requires knowing which item to bill; without a mapping
        // there is nothing safe to send (fail closed — this writes into a
        // client's accounting system). Reported once per pass below.
        if (!itemRef) {
          unmapped++;
          continue;
        }

        const estimate = await upsertEstimate(locationId, {
          qbCustomerId: contactLink.qbId,
          amountCents,
          description: opp.name,
          itemRef,
          // Nothing exists to merge with on a create.
          customFields: spFields,
        });
        await upsertLink(linkIndex, locationId, 'estimate', opp.id, estimate.Id);
        stats.ghlToQbEstimatesCreated++;
      }
    } catch (err) {
      stats.ghlToQbEstimatesFailed++;
      console.error(`[rockwood] estimate push failed for GHL opportunity ${opp.id}:`, err.message);
      await recordThrown(err, {
        source: 'cron',
        kind: err.kind ?? 'ghl_estimate_push_failed',
        appSlug: 'quickbooks',
        locationId,
        context: {
          job: 'rockwood-quickbooks-sync',
          ghlOpportunityId: String(opp.id ?? ''),
          ghlContactId: String(opp.contactId ?? ''),
        },
      });
    }
  }

  if (unmapped > 0) stats.ghlToQbEstimatesUnmapped = unmapped;

  // TWO different problems, and they were conflated behind `unmapped > 0`:
  //
  //  (a) NO mapping configured at all. That is broken *now*, whether or not a deal
  //      happened to change this pass — every estimate this location ever pushes will
  //      be refused. Gating it on traffic meant a quiet stretch looked healthy, and it
  //      is why Rockwood sat unbilled since 07-31 without a current row to look at.
  //  (b) Mappings exist but none matched THESE deals. That genuinely is per-deal, so it
  //      still only makes sense when something was skipped.
  //
  // (a) also carries the company's item list, so the fix is a choice rather than a trip
  // into QuickBooks to look up the catalogue. One QBO query, only while misconfigured,
  // and it stops the moment a mapping exists. Names and ids only — a product name is the
  // tenant's own catalogue, not customer data.
  if (itemMaps.length === 0) {
    // Report a USEFUL subset, not the catalogue. errorLogService caps any array at 20
    // and the message at 2000 chars — correct caps, an error row must not carry an
    // unbounded product list — so a raw dump silently truncated alphabetically and hid
    // everything after "b" on Rockwood's 100+ SKUs.
    //
    // What matters for this setting is the GENERIC line, because upsertEstimate sets the
    // line Amount from the opportunity's value: the item's own price is irrelevant, it
    // just has to represent "a building". Size-coded SKUs (ac10x12, b10x14 …) are the
    // wrong shape — one of them as the location default would bill every deal as that
    // size. So: the total, then priceless/generic items first, then name matches.
    let available = [];
    let totalItems = null;
    try {
      const items = await listItems(locationId);
      totalItems = items.length;
      const generic = items.filter((i) => i.unitPrice == null);
      const named = items.filter((i) => i.unitPrice != null && /shed|building|barn|garage|cabin/i.test(i.name));
      available = [...generic, ...named]
        .map((i) => `${i.name} [${i.id}]${i.unitPrice != null ? ` $${i.unitPrice}` : ' (no fixed price)'}`);
    } catch (err) {
      console.warn(`[rockwood] could not list QuickBooks items: ${err.message}`);
    }
    await recordError({
      source: 'cron',
      kind: 'qbo_item_mapping_missing',
      appSlug: 'quickbooks',
      locationId,
      upstream: 'qbo',
      message: `No QuickBooks item is configured for this location, so EVERY estimate push is refused — an estimate has no default item to fall back on. ${unmapped} opportunity(ies) skipped this pass. Pick one in BuildBridge → QuickBooks under "Bill invoices and estimates as"; a skipped opportunity syncs again the next time it changes in GHL. This company has ${totalItems ?? '?'} item(s); the ones suited to being the single default (no fixed price, or named like a building) are: ${available.join(' | ') || '(could not list them)'}`,
      context: {
        job: 'rockwood-quickbooks-sync', skippedOpportunities: unmapped,
        configuredMappings: 0, totalItems, candidateItems: available,
      },
    });
  } else if (unmapped > 0) {
    // One durable, actionable row per pass — this is a single configuration problem,
    // not `unmapped` separate failures. Fingerprint stays stable across passes (digits
    // normalise to <n>), so occurrences accumulate on one row.
    await recordError({
      source: 'cron',
      kind: 'qbo_item_mapping_missing',
      appSlug: 'quickbooks',
      locationId,
      upstream: 'qbo',
      message: `Cannot push ${unmapped} opportunity(ies) to QuickBooks: ${itemMaps.length} item mappings exist but none matched these deals' fields, so there is no QuickBooks item to bill. Check the Item mappings in BuildBridge → QuickBooks Config; a skipped opportunity syncs again the next time it changes in GHL.`,
      context: {
        job: 'rockwood-quickbooks-sync', skippedOpportunities: unmapped,
        configuredMappings: itemMaps.length,
      },
    });
  }

  return { processedThrough, deferred: opportunities.length - handled };
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

  const { since, hasCursor } = await getSyncSince(locationId);
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
    // Estimate/invoice values copied into the Synergy fields the tenant mapped, and
    // how many contacts they landed on. Zero with mappings configured means every
    // contact already held the current values — a quiet pass, not a broken one.
    qbDocFieldsUpdated: 0,
    qbDocFieldContacts: 0,
    // Contacts that had no phone in Synergy and got the one QuickBooks holds.
    qbPhoneBackfilled: 0,
    // Phones Synergy refused because another contact already holds that number. The
    // rest of the write still went through — see the retry in the visit loop.
    qbPhoneRefusedAsDuplicate: 0,
    // Existing opportunities updated with mapped estimate/invoice values. BuildBridge
    // never CREATES one from QuickBooks (Ahsan, 2026-08-19) — a deal that does not
    // exist in Synergy is not a deal, and creating one would also hand the GHL→QB half
    // a brand-new "changed" opportunity to push straight back.
    qbOppFieldsUpdated: 0,
    // Customers whose QuickBooks document had mapped opportunity fields but whose
    // Synergy contact has no opportunity to put them on. Expected, not an error —
    // BuildBridge does not create deals.
    qbOppNotFound: 0,
    qbOppFieldsFailed: 0,
    // Values Synergy refused because the target field only accepts its own options.
    qbOppFieldsInvalid: 0,
    // Deal name / monetary value set from the tenant template and value source.
    qbOppNameSet: 0,
    qbOppValueSet: 0,
    // Contacts whose rep is known and mapped but who had no news this pass, so their
    // Synergy owner was deliberately left alone. Expected to be large on the first
    // passes after the toggle goes on — that is the backfill NOT happening.
    qbRepAssignSkippedQuiet: 0,
    // The salesperson field is empty on this customer's newest document.
    qbRepNoValue: 0,
    // A rep value with no Synergy user mapped to it.
    qbRepUnmapped: 0,
    // Already owned by the mapped user — a working assignment, seen again.
    qbRepAlreadyAssigned: 0,
    // Contacts linked on the spot because a document changed for a customer the
    // customer half had never seen change. Without this they are invisible forever.
    qbContactsAdoptedForNews: 0,
    // Links dropped because their Synergy contact was deleted by hand, then rebuilt
    // through the ordinary create-or-adopt path.
    qbContactsRelinked: 0,
    // Contacts WITH news that still ran out of budget. Unlike the routine deferral
    // above this one loses work: the cursor moves past the document that made them
    // fresh. Non-zero means FRESH_VISITS_PER_PASS is too small for this tenant.
    qbRepFreshDeferred: 0,
    // News that turned out to be our own write to QuickBooks coming back through
    // Change Data Capture. Non-zero is healthy on a two-way tenant.
    qbRepAssignSkippedEcho: 0,
    // Contacts skipped because Synergy would not tell us what they currently hold.
    // Every write in this loop is a comparison, so a failed read is not a blank slate.
    qbContactReadFailed: 0,
    // Opportunity writes made without leaving an echo marker, because the deal
    // already carried a Synergy edit the push half still needs to see.
    qbOppEchoMarkerSkipped: 0,
    ghlToQbContactsCreated: 0,
    ghlToQbContactsUpdated: 0,
    // Linked contacts whose GHL side changed but whose QuickBooks customer already
    // matched — no write sent. Case-only name differences land here (see
    // qbCustomerChanges), which is what stops the sync overwriting the
    // capitalisation a client fixes by hand in their own books.
    ghlToQbContactsUnchanged: 0,
    // Customer names actually rewritten. Should be RARE — only a genuine rename in
    // Synergy since our last push (see nameSyncDecision). A number that tracks
    // ghlToQbContactsUpdated means something is pushing names on difference again,
    // which is the 2026-08-05 incident coming back.
    ghlToQbNamesUpdated: 0,
    ghlToQbContactsFailed: 0,
    ghlToQbContactsDeferred: 0,
    ghlToQbEstimatesCreated: 0,
    ghlToQbEstimatesUpdated: 0,
    // Estimates QuickBooks rejected, recorded per record and skipped so the pass
    // still reaches setSyncState (see the isolation note in the loop).
    ghlToQbEstimatesFailed: 0,
    // Opportunities with no resolvable QBO item to bill (no/unmatched item
    // mapping) — deliberately not pushed; one config error recorded per pass.
    ghlToQbEstimatesUnmapped: 0,
    // Opportunities this tick ran out of budget before reaching — normal while a
    // backlog drains; the cursor holds at the loop's high-water mark.
    ghlToQbEstimatesDeferred: 0,
    skipped: 0,
  };

  // Where the cursor lands when this pass finishes everything. A pass that runs out
  // of budget replaces this with the last record it actually handled.
  let cursorAt = runStartedAt;

  // All of this location's links, once. Every loop below reads from this index
  // instead of paying one DB round-trip (= one subrequest) per record.
  const linkIndex = await loadLinkIndex(locationId);
  // Taken before either half runs — the rep→assignee echo check needs to know what
  // the links said BEFORE this pass started writing to them.
  const linkTimes = snapshotLinkTimes(linkIndex);

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
      linkIndex,
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
      await reflectSalesDocStatus(
        locationId, estimates, invoices, stats, cfg, linkIndex, passDeadline,
        // The cursor and the changed customers, so the assignee route can tell a
        // contact with news from one that has simply always had a rep. `canAssign`
        // withholds the route entirely on a pass with no real cursor, where "since"
        // is a 30-day backfill window rather than evidence of anything.
        {
          since,
          changedCustomers: customers,
          // A real cursor AND a recent one — see ASSIGN_MAX_CURSOR_AGE_MS.
          canAssign: hasCursor && (Date.now() - since.getTime()) <= ASSIGN_MAX_CURSOR_AGE_MS,
          linkTimes,
        },
      );
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
      linkIndex,
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
      const est = await syncGhlOpportunitiesToQb(locationId, since, stats, passDeadline, linkIndex, cfg);
      stats.ghlToQbEstimatesDeferred = est.deferred;

      if (est.deferred > 0) {
        // Same single-cursor rule as the halves above: move it no further than
        // this loop's high-water mark, or its deferred opportunities are skipped
        // for good. The other halves redo a little work next tick — safe, every
        // operation is an upsert or a link touch.
        const estMark = est.processedThrough
          ? new Date(Math.max(est.processedThrough, since.getTime()))
          : since;
        if (estMark < cursorAt) cursorAt = estMark;
      }
    }
  }

  // ── Cursor-stall alarm ────────────────────────────────────────────────────────
  // The cursor not advancing is this integration's signature failure — three
  // incidents now (07-30, 07-31, 08-03) — and it has been INVISIBLE every time:
  // passes keep running, contacts keep syncing, and nothing anywhere says the window
  // stopped moving. Meanwhile the same QuickBooks changeset is re-read every 15
  // minutes and never shrinks, so it cannot recover on its own.
  //
  // Fires only on the actual deadlock condition — a completed pass that left the
  // cursor no further forward than it found it — and names which half deferred, so
  // the cause is in the row instead of requiring a live `wrangler tail`.
  if (cursorAt.getTime() <= since.getTime()) {
    await recordError({
      source: 'cron',
      kind: 'qbo_sync_cursor_stalled',
      appSlug: 'quickbooks',
      locationId,
      message: `Sync cursor did not advance (still ${since.toISOString()}), so the same QuickBooks window will be re-read next pass and cannot shrink. Deferred counts — QB→GHL contacts: ${stats.qbToGhlContactsDeferred}, GHL→QB contacts: ${stats.ghlToQbContactsDeferred}, GHL→QB estimates: ${stats.ghlToQbEstimatesDeferred}, rep/status loop: ${stats.qbRepDeferred ?? 0}. Whichever is non-zero is the half that ran out of budget; it needs a smaller slice or a cheaper inner loop.`,
      context: {
        job: 'rockwood-quickbooks-sync',
        since: since.toISOString(),
        deferred: {
          qbToGhlContacts: stats.qbToGhlContactsDeferred,
          ghlToQbContacts: stats.ghlToQbContactsDeferred,
          ghlToQbEstimates: stats.ghlToQbEstimatesDeferred,
          repLoop: stats.qbRepDeferred ?? 0,
        },
        skipped: stats.skipped,
      },
    });
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

  // Armed ONCE for the whole run: the ceiling belongs to the invocation, and every
  // location in this loop spends from the same one. See core/subrequestBudget.js.
  beginBudget();

  let ran = 0;
  for (const { locationId } of rows) {
    try {
      // Out of budget ⇒ stop starting locations. The ones already synced wrote their
      // cursors; the rest are untouched and go first-ish next tick. Continuing would
      // not sync them, it would fail every call they make — including the writes that
      // record what happened, which is how this failure mode stays invisible.
      // A RESERVE, not just "not yet exhausted". Starting a location with two calls
      // left does not sync it — it gets far enough to refresh a token and then dies
      // on the write, which is what happened to the second location on 2026-08-19
      // while the first was still draining its backlog. Better to defer it whole.
      if (budgetExhausted() || subrequestsUsed() > MIN_BUDGET_TO_START_LOCATION) {
        console.warn(`[rockwood] subrequest budget spent (${subrequestsUsed()}) — ${locationId} deferred to the next tick`);
        continue;
      }
      if (!(await hasAccess(locationId, 'quickbooks'))) continue;
      const settings = await getLocationSettings(locationId);
      const direction = settings.qboSyncDirection ?? 'off';
      if (direction === 'off') continue; // sync not enabled for this tenant
      await syncLocation(locationId, settings);
      ran++;
    } catch (err) {
      // `err.message` on a database failure is the SQL, not the reason — drizzle
      // wraps the driver error and the useful half hides in `cause`. Three and a half
      // hours of the 2026-08-19 outage went into inferring what one line of this
      // would have said outright, so both halves are logged now.
      console.error(
        `[rockwood] sync failed for ${locationId}:`, err.message,
        '| cause:', err?.cause?.message ?? err?.cause ?? '(none)',
        '| code:', err?.cause?.code ?? err?.code ?? '(none)',
      );
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
  // Disarm: web traffic shares this isolate, and a budget left armed would make
  // ordinary requests trip a guard meant for a scheduled run.
  console.log(`[rockwood] run complete — ${ran} location(s), ${subrequestsUsed()} outbound call(s)`);
  endBudget();
  return ran;
}
