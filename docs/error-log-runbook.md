# Error log runbook (`error_events`)

Every failure BuildBridge produces is written to the `error_events` table in
Supabase (`akiszbinlwxuekncdyze`). Before this existed, errors went only to
`console.error` → `wrangler tail`, which is ephemeral: close the tail and the
evidence was gone, so anything a customer hit overnight left no trace.

## What gets recorded

| source     | what it covers                                                              |
|------------|-----------------------------------------------------------------------------|
| `backend`  | any request that returns 5xx, **plus** any 4xx attributable to an upstream (a GHL/QBO 401 means the integration is broken, not that the caller misbehaved) |
| `frontend` | React render crashes (ErrorBoundary), `window.onerror`, unhandled promise rejections — what the customer actually sees |
| `cron`     | per-tenant sync/milestone failures **and** a backstop for any job that throws out of its own handling |
| `webhook`  | reserved for webhook processing failures                                     |

Deliberately NOT recorded: ordinary caller-error 4xx (400/401/403/404/409/422)
with no upstream attribution. Those are normal traffic and would bury the signal.

## Deduplication — why the table stays small

Rows are deduped on a `fingerprint` (hash of source + kind + upstream + status +
normalized path + normalized message, with ids/timestamps/numbers masked out).
A unique partial index over **unresolved** rows means:

- The same failure repeating (e.g. a cron job 401ing every 15 min for 8 hours)
  increments `occurrence_count` and moves `last_seen_at` on ONE row.
- Marking a row resolved **frees its fingerprint**, so a regression opens a NEW
  row instead of quietly reviving the old one. That is what makes "fix
  everything in the table" verifiable rather than a guess.

## Triage

Fastest path (no admin key needed) — Supabase SQL editor:

```sql
-- What is broken right now, worst first
SELECT kind, source, upstream, upstream_status, http_status,
       occurrence_count, last_seen_at, location_id, message
  FROM error_events
 WHERE resolved_at IS NULL
 ORDER BY occurrence_count DESC, last_seen_at DESC;

-- One issue in full (stack + redacted context)
SELECT * FROM error_events WHERE id = '<id>';

-- Mark fixed (frees the fingerprint so a recurrence opens a fresh row)
UPDATE error_events
   SET resolved_at = now(), resolution_note = 'what was changed'
 WHERE id = '<id>';
```

HTTP API (needs the `x-admin-key` header — `ADMIN_API_KEY`, else `X_API_KEY`):

```
GET  /admin/errors/summary                 open issues grouped by source/upstream/kind
GET  /admin/errors?status=open&limit=50    triage list, newest activity first
GET  /admin/errors?status=all&source=cron  filters: status, source, locationId, limit
POST /admin/errors/:id/resolve  {"note":"…"}
```

## Secrets and customer data

`recordError` redacts before writing: any key matching
token/secret/password/authorization/apikey/refresh/cookie/signature/key, plus
values that look like JWTs or bearer tokens, become `[redacted]`. Upstream
response BODIES are never attached (they can carry QuickBooks customer data —
an Intuit requirement); only status + path + `intuit_tid` are kept, which is
exactly what Intuit support asks for.

## Invariants to preserve when touching this

- `recordError` must never throw and never re-enter itself. It swallows its own
  failures to console — that is the structural guarantee against a logging loop.
  Do NOT "fix" this with a module-level in-flight boolean: that also drops the
  second of two concurrent errors, losing the data the table exists for.
- Row-reading queries use the drizzle **query builder**, not `db.execute()`. On
  this pg-proxy stack (see `core/db/client.js`) `db.execute()` resolves to a bare
  array, so `const { rows } = await db.execute(...)` silently yields `undefined`.
- The error handler awaits the write before sending the response: on Workers the
  request's I/O context is torn down once the response goes out, so
  fire-and-forget inserts never land.
