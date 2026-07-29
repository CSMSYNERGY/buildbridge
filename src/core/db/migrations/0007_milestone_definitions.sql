-- 0007_milestone_definitions: milestones become per-client configuration, not source code.
--
-- WHY: the four milestone types (deposit, materials_delivery, roof_completion,
-- project_completion) were hard-coded in milestoneService.js and again in the frontend.
-- Every client names these differently — Carolyn cited Built Right — and Yoder Barnes'
-- own opportunity stores each one as a PAIR of GHL fields ("materials delivered dollar
-- amount" + "materials delivered date"). So a milestone is not a name we choose, it is a
-- (amount field, date field) pair the client picks from their own opportunity fields, and
-- its name comes from the field they picked. Requirement from the 2026-07-28 sync:
-- "This will have to come from an opportunity field... they don't all have this naming."
--
-- Safe to replace outright rather than migrate: verified live before writing this that
-- production holds ZERO qb_milestones rows and ZERO milestone_amount/milestone_date
-- mapper rows — milestone invoicing has never been configured for a real location.

create table if not exists qb_milestone_definitions (
  id text primary key,
  location_id text not null references locations(id),
  -- Client-facing name, e.g. "Materials Delivered". Derived from the chosen amount
  -- field's label in the UI (so the normal path involves no typing) but stored and
  -- editable, because it is what prints on the QuickBooks invoice line.
  label text not null,
  -- GHL custom-field IDs. Ids, not fieldKeys: every other mapping in this app stores ids,
  -- and GHL's /opportunities/{id} response returns customFields as [{id, value}] with no
  -- fieldKey — so a fieldKey-shaped value silently never matches on the poller path.
  amount_field text not null,
  -- NULL is meaningful: "no date field" = invoice as soon as the opportunity is Won
  -- (the old hard-coded 'deposit' behaviour, now explicit configuration rather than an
  -- implicit consequence of the frontend not rendering a date dropdown).
  date_field text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The only read pattern: every definition for one location, in display/invoicing order.
create index if not exists qb_milestone_definitions_location_idx
  on qb_milestone_definitions (location_id, sort_order);

alter table qb_milestones
  -- SNAPSHOTS taken when the milestone is scheduled. Definitions are editable and
  -- deletable; an invoice that has already gone out must not change its description
  -- retroactively, and a deleted definition must not orphan an in-flight milestone.
  add column if not exists label text,
  -- Whether this milestone waits for its date field to be filled. Persisted rather than
  -- re-derived from the definition for the same reason: the definition may change after
  -- the milestone is scheduled, and the due-date rule must stay stable per milestone.
  add column if not exists awaits_date boolean not null default false;

alter table integration_credentials
  -- The connected QuickBooks company's name, e.g. "Rockwood Sheds LLC". Requirement from
  -- the same sync: "Get it to name it what company it is instead of just company realm."
  --
  -- A plain column, deliberately NOT inside encrypted_payload: that blob is rebuilt from
  -- exactly four keys on every token refresh (roughly hourly), so a name stored there
  -- would silently disappear. It is also not a secret. Keeping it on the row means
  -- getQuickBooksConfig stays a SINGLE query, which matters because the connect flow
  -- polls that endpoint every 3 seconds.
  add column if not exists display_name text;

-- Rollback:
--   alter table integration_credentials drop column if exists display_name;
--   alter table qb_milestones
--     drop column if exists label,
--     drop column if exists awaits_date;
--   drop index if exists qb_milestone_definitions_location_idx;
--   drop table if exists qb_milestone_definitions;
