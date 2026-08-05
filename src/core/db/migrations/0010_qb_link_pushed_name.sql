-- 0010_qb_link_pushed_name: remember the name we last pushed, so the sync pushes
-- CHANGES instead of DIFFERENCES.
--
-- WHY (client report, 2026-08-05): "since we connected QuickBooks up the other day, my
-- customers in QBO keep getting their names switched to all lower case. I can go in and
-- switch it back to first letter upper case but it will soon be switched back. Makes no
-- sense as they are not lower case in GHL."
--
-- The immediate cause was field selection (GHL's single-blob name field can hold a
-- lowercased copy of a name whose firstName/lastName are properly capitalised, and
-- deriveContactName preferred the blob). But the reason a HUMAN CORRECTION COULD NOT
-- SURVIVE is structural and would outlive that fix: the push half compared GHL's current
-- name against the QuickBooks customer's current name and wrote whenever they DIFFERED.
-- A difference is not a change. On every pass where GHL's side looked newer — and any
-- touch of a contact in the CRM makes it look newer: a tag, a note, an automation, the
-- rep field write — the client's edit was overwritten again.
--
-- With a baseline, the question becomes the right one: "has the name changed in Synergy
-- since we last pushed it?" If it has not, we say nothing, and their ledger keeps whatever
-- they typed. A real rename still flows.
--
-- NULL means "no baseline yet", which covers every link that exists today plus every
-- customer we ADOPTED rather than created. Those are exactly the records whose name we
-- have least right to overwrite, so the code seeds the baseline from GHL's current value
-- and writes nothing to QuickBooks that pass — self-healing, and a later genuine rename
-- still propagates.

alter table qb_sync_links
  add column if not exists last_pushed_name text;

comment on column qb_sync_links.last_pushed_name is
  'GHL-derived contact name as of our last push to QuickBooks. NULL = no baseline yet (legacy or adopted link): seed it, do not overwrite the customer name.';

-- Rollback:
--   alter table qb_sync_links drop column if exists last_pushed_name;
