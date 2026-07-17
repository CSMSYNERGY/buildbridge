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
  source: text('source').notNull(),                     // 'ghl' | 'deposyt'
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('integration_credentials_location_app_uidx').on(t.locationId, t.appSlug),
]);

// ─── QuickBooks Milestones ────────────────────────────────────────────────────
// One row per milestone invoice for a won opportunity (Yoder Barnes model).
export const qbMilestones = pgTable('qb_milestones', {
  id: text('id').primaryKey(),
  locationId: text('location_id').notNull().references(() => locations.id),
  opportunityId: text('opportunity_id').notNull(),      // GHL opportunity id
  contactId: text('contact_id'),                        // GHL contact id
  qbCustomerId: text('qb_customer_id'),                 // QBO Customer.Id
  milestoneType: text('milestone_type').notNull(),      // 'deposit' | 'materials_delivery' | 'roof_completion' | 'project_completion'
  amountCents: integer('amount_cents').notNull(),
  milestoneDate: timestamp('milestone_date', { withTimezone: true }), // null → invoice immediately (deposit)
  invoiceLeadDays: integer('invoice_lead_days').notNull().default(3),
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
  // Default days before a milestone's date to raise its invoice (deposit is
  // always immediate). Copied onto each qb_milestones row at creation time.
  qboInvoiceLeadDays: integer('qbo_invoice_lead_days').notNull().default(3),
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
