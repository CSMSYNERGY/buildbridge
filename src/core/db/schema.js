import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Plans ───────────────────────────────────────────────────────────────────
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),                          // e.g. 'smartbuild_monthly'
  name: text('name').notNull(),
  appSlug: text('app_slug').notNull(),                  // 'smartbuild' | 'idearoom' | etc.
  billingInterval: text('billing_interval').notNull(),  // 'monthly' | 'annual'
  priceUsd: integer('price_usd').notNull(),             // cents
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Locations ────────────────────────────────────────────────────────────────
export const locations = pgTable('locations', {
  id: text('id').primaryKey(),                          // GHL locationId
  companyId: text('company_id'),
  name: text('name'),
  email: text('email'),
  ghlAccessToken: text('ghl_access_token'),
  ghlRefreshToken: text('ghl_refresh_token'),
  ghlTokenExpiresAt: timestamp('ghl_token_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Subscriptions ────────────────────────────────────────────────────────────
export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey(),                          // Deposyt subscription id
  locationId: text('location_id').notNull().references(() => locations.id),
  planId: text('plan_id').notNull().references(() => plans.id),
  status: text('status').notNull(),                     // 'active' | 'canceled' | 'past_due'
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('subscriptions_location_id_idx').on(t.locationId),
  index('subscriptions_plan_id_idx').on(t.planId),
]);

// ─── Webhook Events ───────────────────────────────────────────────────────────
export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),                          // idempotency key
  source: text('source').notNull(),                     // 'ghl' | 'deposyt' | 'idearoom'
  eventType: text('event_type').notNull(),
  locationId: text('location_id'),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'processed' | 'failed'
  error: text('error'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('webhook_events_location_id_idx').on(t.locationId),
  index('webhook_events_status_idx').on(t.status),
]);

// ─── Error Events ─────────────────────────────────────────────────────────────
// Durable error log (see migrations/0004_error_events.sql). Deduplicated on
// `fingerprint` via a unique partial index over unresolved rows, so a repeating
// failure increments occurrence_count instead of adding rows.
// NOTE: intentionally NOT foreign-keyed to locations — an error must be
// recordable even when it happened for an unknown/unsaved location.
export const errorEvents = pgTable('error_events', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  source: text('source').notNull(),                     // 'backend' | 'frontend' | 'cron' | 'webhook'
  severity: text('severity').notNull().default('error'),
  locationId: text('location_id'),
  appSlug: text('app_slug'),
  kind: text('kind'),
  message: text('message').notNull(),
  httpStatus: integer('http_status'),
  httpMethod: text('http_method'),
  path: text('path'),
  upstream: text('upstream'),
  upstreamStatus: integer('upstream_status'),
  upstreamRef: text('upstream_ref'),
  stack: text('stack'),
  context: jsonb('context'),
  userAgent: text('user_agent'),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
}, (t) => [
  index('error_events_last_seen_idx').on(t.lastSeenAt),
  index('error_events_location_idx').on(t.locationId),
]);

// ─── Mappers ──────────────────────────────────────────────────────────────────
export const mappers = pgTable('mappers', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  appSlug: text('app_slug').notNull(),
  mapperType: text('mapper_type').notNull(),            // e.g. 'opportunity_stage', 'contact_tag'
  externalKey: text('external_key').notNull(),
  ghlValue: text('ghl_value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('mappers_location_app_type_key_uidx').on(
    t.locationId, t.appSlug, t.mapperType, t.externalKey,
  ),
]);

// ─── Integration Credentials ──────────────────────────────────────────────────
export const integrationCredentials = pgTable('integration_credentials', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  appSlug: text('app_slug').notNull(),
  encryptedPayload: text('encrypted_payload').notNull(), // AES-256-GCM JSON blob
  // ── Credential health (0006) ──
  // A credential row EXISTING never meant it still worked; the UI used to conflate the
  // two and showed a green "Connected" through hours of total sync failure. These three
  // carry the answer to "does this actually work?" so a dead connection is visible in the
  // app instead of only in error_events. All nullable: null last_ok_at = never verified.
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastError: text('last_error'),          // non-null ⇒ needs attention; cleared on success
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  // The connected account's human-readable name, e.g. "Rockwood Sheds LLC" (0007). A
  // plain column, NOT part of encrypted_payload: that blob is rebuilt from a fixed set of
  // keys on every token refresh, so a name stored there would silently vanish within the
  // hour. It is not a secret, and keeping it here lets the config endpoint stay one query.
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('integration_credentials_location_app_uidx').on(t.locationId, t.appSlug),
]);

// ─── QuickBooks Milestone Definitions (migration 0007) ────────────────────────
// Per-client milestone CONFIGURATION: what milestones this location bills, and which of
// their own GHL opportunity fields hold each one's amount and date. Replaces the four
// hard-coded types — clients name these differently and each is a PAIR of GHL fields.
export const qbMilestoneDefinitions = pgTable('qb_milestone_definitions', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  // Prints on the QuickBooks invoice line. Derived from the chosen amount field's label
  // in the UI so the normal path involves no typing, but stored and editable.
  label: text('label').notNull(),
  // GHL custom-field IDs (not fieldKeys — GHL returns customFields as [{id, value}] on
  // the poller path, so a fieldKey would silently never match).
  amountField: text('amount_field').notNull(),
  // NULL = no date field = invoice as soon as the opportunity is Won (the old 'deposit'
  // behaviour, now explicit configuration instead of an implicit frontend omission).
  dateField: text('date_field'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('qb_milestone_definitions_location_idx').on(t.locationId, t.sortOrder),
]);

// ─── QuickBooks Milestones ────────────────────────────────────────────────────
// One row per milestone invoice for a won opportunity (Yoder Barnes model).
export const qbMilestones = pgTable('qb_milestones', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  opportunityId: text('opportunity_id').notNull(),      // GHL opportunity id
  contactId: text('contact_id'),                        // GHL contact id
  qbCustomerId: text('qb_customer_id'),                 // QBO Customer.Id
  // The qb_milestone_definitions.id this milestone came from. Still the idempotency key
  // via the unique index below, which is why definitions use stable ids and mutable
  // labels — renaming a milestone must not create a duplicate for an in-flight deal.
  milestoneType: text('milestone_type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  milestoneDate: timestamp('milestone_date', { withTimezone: true }),
  invoiceLeadDays: integer('invoice_lead_days').notNull().default(3),
  // ── Snapshots from the definition (0007) ──
  // Taken at scheduling time. Definitions are editable and deletable; an invoice already
  // sent must not change its description retroactively, and the due rule must stay
  // stable per milestone even if the definition later gains or loses its date field.
  label: text('label'),
  awaitsDate: boolean('awaits_date').notNull().default(false),
  qbInvoiceId: text('qb_invoice_id'),                   // QBO Invoice.Id once created
  status: text('status').notNull().default('pending'),  // 'pending' | 'invoiced' | 'failed'
  error: text('error'),
  invoicedAt: timestamp('invoiced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('qb_milestones_location_opp_type_uidx').on(
    t.locationId, t.opportunityId, t.milestoneType,
  ),
  index('qb_milestones_status_idx').on(t.status),
]);

// ─── QuickBooks Sync Links ────────────────────────────────────────────────────
// Maps a GHL entity to its QBO counterpart for two-way sync (Rockwood model).
export const qbSyncLinks = pgTable('qb_sync_links', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  entityType: text('entity_type').notNull(),            // 'contact' | 'estimate'
  ghlId: text('ghl_id').notNull(),
  qbId: text('qb_id').notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('qb_sync_links_location_type_ghl_uidx').on(t.locationId, t.entityType, t.ghlId),
  uniqueIndex('qb_sync_links_location_type_qb_uidx').on(t.locationId, t.entityType, t.qbId),
]);

// ─── QuickBooks Sync State ────────────────────────────────────────────────────
// Per-location cursors for QuickBooks background work:
//   lastSyncAt      → Rockwood two-way sync (CDC + GHL-changed-since window)
//   lastWonPollAt   → Yoder Won-opportunity poller (see milestoneService)
export const qbSyncState = pgTable('qb_sync_state', {
  locationId: text('location_id').primaryKey().references(() => locations.id),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastWonPollAt: timestamp('last_won_poll_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Location Settings ────────────────────────────────────────────────────────
// Per-tenant QuickBooks feature configuration. One app, opt-in aspects: a
// location chooses a contact/estimate sync direction (Rockwood model) and/or
// milestone auto-invoicing (Yoder model) independently. Everything defaults OFF
// so connecting QuickBooks never silently starts syncing before configuration.
export const locationSettings = pgTable('location_settings', {
  locationId: text('location_id').primaryKey().references(() => locations.id),
  // Contact + estimate sync direction (Rockwood model):
  //   'off'        → no sync
  //   'qb_to_ghl'  → read-only from QuickBooks; never writes to QBO (Rockwood)
  //   'ghl_to_qb'  → push GHL contacts/opportunities into QuickBooks
  //   'two_way'    → reconcile both directions (last-write-wins)
  qboSyncDirection: text('qbo_sync_direction').notNull().default('off'),
  // Yoder: opportunity Won → QBO customer + milestone rows → scheduled invoices.
  qboMilestoneInvoicing: boolean('qbo_milestone_invoicing').notNull().default(false),
  // When set, GHL→QBO contact CREATE is limited to contacts that have an
  // opportunity in this pipeline (Carolyn's "push to QuickBooks when the lead
  // moves into the Buildings pipeline"). Null → push all changed contacts.
  // Only relevant for directions that write to QBO ('ghl_to_qb' / 'two_way').
  qboContactSyncPipelineId: text('qbo_contact_sync_pipeline_id'),
  // Name of the QuickBooks Customer custom field that holds the salesperson /
  // assigned user (read-only QB→GHL). Entered in Settings; blank = disabled.
  qboAssignedUserField: text('qbo_assigned_user_field'),
  // GHL contact custom-field id that the salesperson value is copied into
  // (QB→GHL). Picked in Settings; blank = don't copy the salesperson.
  qboAssignedUserGhlField: text('qbo_assigned_user_ghl_field'),
  // GHL contact custom-field id that reflects QuickBooks sales-doc status
  // (Estimate created/sent, Accepted, Invoiced). Picked in Settings; blank =
  // don't reflect status.
  qboStatusGhlField: text('qbo_status_ghl_field'),
  // ── Salesperson → QuickBooks sales document (migration 0008, GHL→QBO) ──
  // Distinct from qboAssignedUserField above, which reads a salesperson OUT of
  // QuickBooks into GHL. This writes one IN, onto the estimate/invoice, because
  // QBO's API never reveals who is logged in.
  //
  // Name of the LEGACY sales-form custom field to write, e.g. "Salesperson".
  // Blank/null = feature off.
  qboSalespersonQbField: text('qbo_salesperson_qb_field'),
  // Which legacy slot (1-3) that field occupies — QuickBooks addresses it on a
  // transaction by DefinitionId, and the slot IS the DefinitionId.
  qboSalespersonSlot: integer('qbo_salesperson_slot').notNull().default(1),
  // Optional GHL opportunity custom-field id naming the salesperson directly.
  // Set and non-empty on a deal ⇒ wins over the assigned-user mapping.
  qboSalespersonGhlField: text('qbo_salesperson_ghl_field'),
  // Default days before a milestone's date to raise its invoice (deposit is
  // always immediate). Copied onto each qb_milestones row at creation time.
  qboInvoiceLeadDays: integer('qbo_invoice_lead_days').notNull().default(3),
  // ── IdeaRoom inbound lead webhook (migration 0005) ──
  // The secret in the URL we hand IdeaRoom: POST /webhooks/idearoom/<token>. Per location,
  // unguessable, uniquely indexed for reverse lookup, and rotatable (rotation instantly
  // invalidates the old URL). Null → no webhook issued for this location yet.
  idearoomWebhookToken: text('idearoom_webhook_token'),
  // Where an IdeaRoom lead's opportunity lands. Both null → create/update the contact only
  // (GHL has no opportunity without a pipeline stage).
  idearoomPipelineId: text('idearoom_pipeline_id'),
  idearoomStageId: text('idearoom_stage_id'),
  // Tag stamped on every contact from IdeaRoom so the source is visible + workflow-able.
  idearoomTag: text('idearoom_tag').notNull().default('idearoom-lead'),
  // Holding a token is not consent to process: leads are stored but not pushed to GHL
  // until an operator turns this on.
  idearoomEnabled: boolean('idearoom_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Relations ────────────────────────────────────────────────────────────────
export const locationsRelations = relations(locations, ({ one, many }) => ({
  subscriptions: many(subscriptions),
  mappers: many(mappers),
  integrationCredentials: many(integrationCredentials),
  qbMilestones: many(qbMilestones),
  qbSyncLinks: many(qbSyncLinks),
  locationSettings: one(locationSettings, {
    fields: [locations.id],
    references: [locationSettings.locationId],
  }),
}));

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  location: one(locations, { fields: [subscriptions.locationId], references: [locations.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
}));

export const mappersRelations = relations(mappers, ({ one }) => ({
  location: one(locations, { fields: [mappers.locationId], references: [locations.id] }),
}));

export const integrationCredentialsRelations = relations(integrationCredentials, ({ one }) => ({
  location: one(locations, {
    fields: [integrationCredentials.locationId],
    references: [locations.id],
  }),
}));

export const qbMilestonesRelations = relations(qbMilestones, ({ one }) => ({
  location: one(locations, { fields: [qbMilestones.locationId], references: [locations.id] }),
}));

export const qbSyncLinksRelations = relations(qbSyncLinks, ({ one }) => ({
  location: one(locations, { fields: [qbSyncLinks.locationId], references: [locations.id] }),
}));

export const locationSettingsRelations = relations(locationSettings, ({ one }) => ({
  location: one(locations, { fields: [locationSettings.locationId], references: [locations.id] }),
}));
