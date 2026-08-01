-- 0009_qbo_rep_assignee: map a QuickBooks rep to a Synergy USER, and assign them.
--
-- WHY, in Ahsan's words (2026-08-01): "if I get a drop down here from QuickBooks rep and a
-- drop down ... I should be able to click a drop down for assigned users in Synergy and
-- select Cody in there." Two dropdowns, one mapping row, and the contact's ASSIGNED USER
-- gets set — not a custom field.
--
-- This is what Carolyn asked for on the 07-31 call (54:32 "Can we not do it with the regular
-- fields ... the owner" -> "assignee") and it is the only route that needs NOTHING from the
-- client: Rockwood's 12 contact custom fields hold no rep-shaped field, and they will not
-- change how they use QuickBooks.
--
-- WHY A MAPPING IS REQUIRED RATHER THAN NAME-MATCHING: proven empirically. A dry run over
-- Rockwood's live data found 2 distinct rep values and they are "1" and "2" — QuickBooks
-- returns the dropdown's OPTION ID, not the label. Nothing can be inferred from that; only a
-- human who knows their own QuickBooks can say which id is which person. So the mapping is
-- the feature, not a fallback for when matching fails.
--
-- The mapper rows live in the existing `mappers` table under mapper_type 'qb_rep_user':
--   external_key = the QuickBooks rep value as it arrives (e.g. "1")
--   ghl_value    = the Synergy user id to assign
-- A DISTINCT type from 'qb_salesperson' on purpose: that one is the reverse direction
-- (Synergy user -> QuickBooks name) and reusing it would make two opposite features fight
-- over the same rows.

alter table location_settings
  -- Off by default, and deliberately explicit rather than inferred from "mappings exist".
  -- Assigning a contact moves lead OWNERSHIP and fires notifications in Synergy, so it must
  -- never switch on as a side effect of someone adding a mapping row to look around.
  add column if not exists qbo_rep_to_assignee boolean not null default false;

-- Rollback:
--   alter table location_settings drop column if exists qbo_rep_to_assignee;
--   delete from mappers where mapper_type = 'qb_rep_user';
