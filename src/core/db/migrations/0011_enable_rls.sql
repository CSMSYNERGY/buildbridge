-- Bring every table in `public` under Row Level Security.
--
-- WHY: Supabase publishes the `public` schema as a PostgREST API, and its default
-- privileges grant anon/authenticated full access to every new table created by
-- `postgres`. RLS is the only gate on that endpoint. BuildBridge treats this
-- project as a plain Postgres box (Worker → sql-exec / Hyperdrive) and never
-- issues a PostgREST request, so nothing in the app ever exercised that path and
-- migrations 0003, 0004 and 0007 created their tables with no RLS — which the
-- Supabase security advisor flagged (rls_disabled_in_public) on 2026-08-09.
--
-- An earlier hardening pass had already covered locations, subscriptions,
-- webhook_events, mappers and integration_credentials with ENABLE + FORCE + a
-- `<table>_service_role_all` policy. This migration extends that same pattern to
-- the six tables it missed, and closes the one deliberate hole (see plans below).
--
-- WHY THIS DOES NOT BREAK THE APP: `postgres` has rolbypassrls = true (verified
-- live), and both DB paths — the sql-exec edge function via SUPABASE_DB_URL, and
-- the Hyperdrive/node-postgres fallback via DATABASE_URL — connect as `postgres`.
-- BYPASSRLS outranks FORCE, so application queries are untouched. `service_role`
-- also has rolbypassrls = true; the explicit policies below are belt-and-braces
-- so headless PostgREST admin access keeps working on its own merits.

ALTER TABLE public.error_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_events             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.location_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_settings        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.qb_sync_links            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qb_sync_links            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.qb_sync_state            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qb_sync_state            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.qb_milestones            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qb_milestones            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.qb_milestone_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qb_milestone_definitions FORCE  ROW LEVEL SECURITY;

-- Idempotent repeats: already true in the live DB, kept so this file is a
-- complete statement of intent if the database is ever rebuilt from migrations.
ALTER TABLE public.plans                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.locations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations                FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events           FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.mappers                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mappers                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.integration_credentials  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_credentials  FORCE  ROW LEVEL SECURITY;

-- Same `<table>_service_role_all` policy the earlier pass used, for the six
-- tables that never got one. DROP-then-CREATE because Postgres has no
-- CREATE POLICY IF NOT EXISTS, and this migration must stay re-runnable.
DROP POLICY IF EXISTS error_events_service_role_all             ON public.error_events;
CREATE POLICY        error_events_service_role_all             ON public.error_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS location_settings_service_role_all        ON public.location_settings;
CREATE POLICY        location_settings_service_role_all        ON public.location_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS qb_sync_links_service_role_all            ON public.qb_sync_links;
CREATE POLICY        qb_sync_links_service_role_all            ON public.qb_sync_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS qb_sync_state_service_role_all            ON public.qb_sync_state;
CREATE POLICY        qb_sync_state_service_role_all            ON public.qb_sync_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS qb_milestones_service_role_all            ON public.qb_milestones;
CREATE POLICY        qb_milestones_service_role_all            ON public.qb_milestones
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS qb_milestone_definitions_service_role_all ON public.qb_milestone_definitions;
CREATE POLICY        qb_milestone_definitions_service_role_all ON public.qb_milestone_definitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Idempotent repeats of the policies the earlier pass already created, so a
-- database rebuilt from migrations alone ends up in exactly the live state.
DROP POLICY IF EXISTS locations_service_role_all               ON public.locations;
CREATE POLICY        locations_service_role_all               ON public.locations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS subscriptions_service_role_all           ON public.subscriptions;
CREATE POLICY        subscriptions_service_role_all           ON public.subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS webhook_events_service_role_all          ON public.webhook_events;
CREATE POLICY        webhook_events_service_role_all          ON public.webhook_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mappers_service_role_all                 ON public.mappers;
CREATE POLICY        mappers_service_role_all                 ON public.mappers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS integration_credentials_service_role_all ON public.integration_credentials;
CREATE POLICY        integration_credentials_service_role_all ON public.integration_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- `plans` was the odd one out: RLS was already enabled, but a `plans_public_read`
-- policy granted SELECT to anon/authenticated with USING (true), so enabling RLS
-- alone would have been a no-op here. Nothing consumes it — the SPA reads plans
-- through the Worker's /api routes, and no frontend file imports supabase-js or
-- references *.supabase.co. Drop it.
DROP POLICY IF EXISTS plans_public_read ON public.plans;
DROP POLICY IF EXISTS plans_service_role_all ON public.plans;
CREATE POLICY        plans_service_role_all ON public.plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Belt and braces. RLS is the real gate, but the API roles have no business
-- holding privileges here at all — BuildBridge never issues a request as anon or
-- authenticated. With the grants gone, even a future mistakenly-permissive
-- policy cannot expose a row.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- And stop the hole reopening by itself: Supabase's default privileges grant
-- anon/authenticated full access to every NEW table created by `postgres`, which
-- is exactly how 0003/0004/0007 shipped exposed. Revoking the default means the
-- next CREATE TABLE is closed the moment it exists, even if whoever writes it
-- forgets the ALTER TABLE above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
