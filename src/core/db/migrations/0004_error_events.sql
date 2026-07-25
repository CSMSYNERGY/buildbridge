-- Persistent error log.
--
-- Until now every failure went only to console.error → `wrangler tail`, which is
-- ephemeral: close the tail and the evidence is gone, so a customer-facing bug
-- that happened overnight left no trace. This table is the durable record.
--
-- Deduplicated by `fingerprint`: a repeating failure (e.g. a cron job 401ing
-- every 15 minutes for hours) collapses into ONE open row whose
-- occurrence_count/last_seen_at climb, instead of thousands of rows. Marking a
-- row resolved frees the fingerprint, so a regression opens a fresh row and
-- keeps the fixed one as history.

CREATE TABLE IF NOT EXISTS error_events (
  id                text        PRIMARY KEY,
  fingerprint       text        NOT NULL,
  source            text        NOT NULL,                       -- 'backend' | 'frontend' | 'cron' | 'webhook'
  severity          text        NOT NULL DEFAULT 'error',        -- 'warn' | 'error' | 'fatal'
  location_id       text,                                       -- tenant, when known
  app_slug          text,                                       -- 'quickbooks' | 'smartbuild' | ...
  kind              text,                                       -- short machine code, e.g. 'ghl_api_error'
  message           text        NOT NULL,
  http_status       integer,                                    -- status WE returned
  http_method       text,
  path              text,
  upstream          text,                                       -- 'ghl' | 'qbo' | 'nmi' | 'smartbuild' | 'db'
  upstream_status   integer,                                    -- status the THIRD PARTY returned
  upstream_ref      text,                                       -- intuit_tid / request id for support tickets
  stack             text,
  context           jsonb,                                      -- extra structured detail (redacted)
  user_agent        text,
  occurrence_count  integer     NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolution_note   text
);

-- At most one OPEN row per fingerprint (the dedupe target). Resolved rows are
-- excluded so history is retained and a recurrence opens a new row.
CREATE UNIQUE INDEX IF NOT EXISTS error_events_open_fingerprint_idx
  ON error_events (fingerprint) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS error_events_last_seen_idx  ON error_events (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS error_events_location_idx   ON error_events (location_id);
CREATE INDEX IF NOT EXISTS error_events_unresolved_idx ON error_events (resolved_at) WHERE resolved_at IS NULL;
