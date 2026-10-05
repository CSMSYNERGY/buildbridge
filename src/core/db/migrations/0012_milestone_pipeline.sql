-- 0012_milestone_pipeline: a milestone can be limited to one GHL pipeline.
--
-- WHY: a client can sell two kinds of job from one Synergy account and bill only one of them
-- in stages. The case that prompted it sells sheds through one pipeline (paid in full) and
-- post-frame buildings through another (deposit, materials delivery, roof, completion). Until
-- now a milestone definition applied to every Won deal in every pipeline, so the moment that
-- client configured its post-frame milestones, a shed sale with a matching field filled in
-- would have been billed in stages too.
--
-- NULL means "any pipeline", which is exactly how every milestone behaved before this column
-- existed. Applying this therefore changes nothing for any location until someone picks a
-- pipeline on a milestone in BuildBridge → QuickBooks. (Verified 2026-10-05: no location has
-- a single qb_milestone_definitions row, so there is nothing to backfill either way.)
--
-- Shipped together with the code changes that make the engine safe to configure: the
-- QuickBooks customer is now created only after a deal is known to be owed a milestone,
-- the won-deal poller reads past its first 100 deals, and a milestone invoice with no
-- QuickBooks item chosen waits instead of being billed as item 1.
--
-- DEPLOY ORDER: apply this BEFORE deploying the code. The Worker selects every column of
-- qb_milestone_definitions, so code that knows about pipeline_id fails against a table that
-- does not have it yet — the milestone editor would 500 and the won-poll would error for
-- every location with milestone invoicing switched on. Applied by hand in the Supabase SQL
-- editor like 0004 onwards; `wrangler deploy` ships code only and runs no migrations.
--
-- Re-runnable: `if not exists`, and the comment is a plain overwrite.

alter table qb_milestone_definitions
  -- GHL pipeline id, as /opportunities/pipelines returns it. An id, not a name: pipelines can
  -- be renamed in Synergy, and both the webhook payload (pipelineId / pipeline_id) and the
  -- opportunity record carry the id.
  add column if not exists pipeline_id text;

comment on column qb_milestone_definitions.pipeline_id is
  'GHL pipeline this milestone bills. NULL = any pipeline (behaviour before 0012). A Won deal in another pipeline gets no row for this milestone and creates no QuickBooks customer on its account.';

-- RLS: unchanged. 0011 already enabled and forced RLS on this table; a new column inherits it.

-- Read-back after applying (expect one row: pipeline_id | text | YES):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'qb_milestone_definitions'
--      and column_name = 'pipeline_id';

-- Rollback, in this order (the deploy order above in reverse: code that selects pipeline_id
-- breaks once the column is gone, so the column goes last):
--   1. Put the previous code back live: `npx wrangler rollback` to the version before this
--      change, or land a revert on main and `npm run deploy`. Do NOT check out an older commit
--      and deploy it: the predeploy guard refuses anything that is not main on GitHub, and a
--      bare `npx wrangler deploy` from an old tree is exactly how the wrong code went live in
--      September.
--   2. Only then: alter table qb_milestone_definitions drop column if exists pipeline_id;
