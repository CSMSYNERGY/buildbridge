-- 0008_qbo_salesperson: write the deal's salesperson onto the QuickBooks sales document.
--
-- WHY: QuickBooks' API does not expose "who is logged in", so a document pushed from
-- BuildBridge carries no salesperson at all — the attribution the client actually runs their
-- commissions off. Carolyn, 2026-07-31: map a GHL user to QuickBooks' hidden "Salesperson"
-- field, and let the client define that relationship themselves.
--
-- WHICH QuickBooks field: the LEGACY sales-form custom fields (Preferences.SalesFormsPrefs →
-- SalesCustomName<slot> / UseSalesCustom<slot>), surfaced on transactions as
-- Estimate.CustomField[] {DefinitionId, Name, StringValue}. That is the only custom-field
-- mechanism REST can both WRITE and READ on every QBO plan with no extra OAuth scope — the
-- modern "Custom fields" manager needs the App Foundations scope, which is gated behind
-- Intuit's App Partner Program at $300/mo and returns 403 for this app (work log 2026-07-26).
--
-- The value SOURCE is deliberately two-pronged, because a client can reasonably want either:
--   1. a GHL custom field on the opportunity naming the salesperson outright, or
--   2. the deal's assigned GHL user, translated through a `qb_salesperson` mapper row.
-- Nothing is written when neither resolves — an unmapped guess in a client's books is the
-- failure mode the hardcoded ItemRef '1' already taught us (0007 era, Rockwood's estimate 400).
--
-- Everything defaults NULL/off, so applying this changes no behaviour for any location until
-- someone configures it.

alter table location_settings
  -- The NAME of the QuickBooks legacy sales-form custom field to write, e.g. "Salesperson".
  -- NULL/blank = the whole feature is off. Stored as the name rather than a boolean because
  -- QuickBooks matches these by name on the transaction and the client chooses what it is
  -- called when the slot is enabled.
  add column if not exists qbo_salesperson_qb_field text,
  -- Which of the three legacy slots that field occupies (1-3). QuickBooks identifies the
  -- field on a transaction by DefinitionId, and the slot IS the DefinitionId.
  add column if not exists qbo_salesperson_slot integer not null default 1,
  -- OPTIONAL GHL opportunity custom-field id holding the salesperson name directly. When set
  -- and non-empty on a deal it WINS over the assigned-user mapping — it is the per-deal
  -- override, and a value someone typed on the deal is more specific than a location rule.
  -- An id, not a fieldKey: every other mapping in this app stores ids, and GHL's opportunity
  -- payload returns customFields without fieldKey, so a fieldKey never matches on this path.
  add column if not exists qbo_salesperson_ghl_field text;

-- Slot is a DefinitionId, not a free integer: reject anything QuickBooks cannot address
-- rather than discovering it as a 400 on the client's estimate push.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'location_settings_qbo_salesperson_slot_ck'
  ) then
    alter table location_settings
      add constraint location_settings_qbo_salesperson_slot_ck
      check (qbo_salesperson_slot between 1 and 3);
  end if;
end $$;

-- Rollback:
--   alter table location_settings drop constraint if exists location_settings_qbo_salesperson_slot_ck;
--   alter table location_settings
--     drop column if exists qbo_salesperson_ghl_field,
--     drop column if exists qbo_salesperson_slot,
--     drop column if exists qbo_salesperson_qb_field;
