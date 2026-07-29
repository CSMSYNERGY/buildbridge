-- 0006_credential_health: make a dead integration credential visible in the UI.
--
-- WHY: the QuickBooks card rendered "Connected" purely because an
-- integration_credentials row existed. It never asked whether the stored refresh token
-- still works. On 2026-07-28 both CSM Synergy and Rockwood showed a green "Connected"
-- for hours while EVERY sync failed (`invalid_grant` on one, "No access token found" on
-- the other) — the only evidence was error_events, which no client will ever read. A
-- status that cannot go red is not a status.
--
-- Deliberately on integration_credentials, not a quickbooks-specific table: the same
-- blind spot exists for every app that stores an OAuth blob here (smartbuild, and
-- whatever comes next), and the failure shape — "we hold a credential, it stopped
-- working, nobody noticed" — is identical for all of them.
--
-- Nullable with no default and no backfill, ON PURPOSE. `last_ok_at IS NULL` means
-- "never verified since this column shipped", which is the honest state for every
-- existing row — inventing now() would assert health we have not observed, i.e. exactly
-- the lie this migration exists to remove. The UI renders that third state as
-- "not verified yet" rather than as either healthy or broken.

alter table integration_credentials
  -- Last time this credential was PROVEN to work (successful token refresh, or a
  -- successful API call made with it). The freshness signal behind "last verified".
  add column if not exists last_ok_at timestamptz,
  -- Set when the credential fails in an auth-shaped way (refresh rejected, 401/403).
  -- Non-null is the single source of truth for "show this as needing attention".
  -- Cleared on the next success, so recovery needs no manual intervention.
  add column if not exists last_error text,
  add column if not exists last_error_at timestamptz;

-- "Which tenants have a broken integration right now?" — the ops sweep this whole
-- migration exists to make possible. Partial: healthy rows are the overwhelming
-- majority and must not bloat the index.
create index if not exists integration_credentials_broken_idx
  on integration_credentials (app_slug, last_error_at desc)
  where last_error is not null;

-- Rollback:
--   drop index if exists integration_credentials_broken_idx;
--   alter table integration_credentials
--     drop column if exists last_ok_at,
--     drop column if exists last_error,
--     drop column if exists last_error_at;
