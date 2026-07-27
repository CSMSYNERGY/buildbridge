-- 0005_idearoom_webhook: inbound IdeaRoom lead webhook, one secret URL per location.
--
-- IdeaRoom's team is handed a single URL per client and cannot be relied on to send custom
-- auth headers, so the URL itself carries the credential: /webhooks/idearoom/<token>. The
-- token is per-location, unguessable, indexed for an O(1) reverse lookup, and rotatable
-- (rotating invalidates the old URL immediately).
--
-- No new payload table: inbound bodies are stored in the existing `webhook_events`
-- (source='idearoom', payload jsonb, status pending/processed/failed) so raw traffic is
-- captured BEFORE any parsing, which is what lets us map IdeaRoom's real field names once
-- we have seen live requests. Field mappings then live in the existing `mappers` table
-- (app_slug='idearoom') with no further schema change.

alter table location_settings
  add column if not exists idearoom_webhook_token text,
  -- Where an IdeaRoom lead's opportunity should land. Both null → contact only, no
  -- opportunity (a GHL opportunity cannot exist without a pipeline stage).
  add column if not exists idearoom_pipeline_id text,
  add column if not exists idearoom_stage_id text,
  -- Tag applied to every contact created/updated from IdeaRoom, so the source is visible
  -- in GHL and can drive workflows.
  add column if not exists idearoom_tag text not null default 'idearoom-lead',
  -- Off by default: a token existing is not consent to process. Enabled from the UI.
  add column if not exists idearoom_enabled boolean not null default false;

-- Reverse lookup (token → location) must be unique and fast. Partial: many locations will
-- have no token, and NULLs must not collide.
create unique index if not exists location_settings_idearoom_token_uidx
  on location_settings (idearoom_webhook_token)
  where idearoom_webhook_token is not null;

-- Rollback:
--   drop index if exists location_settings_idearoom_token_uidx;
--   alter table location_settings
--     drop column if exists idearoom_webhook_token,
--     drop column if exists idearoom_pipeline_id,
--     drop column if exists idearoom_stage_id,
--     drop column if exists idearoom_tag,
--     drop column if exists idearoom_enabled;
