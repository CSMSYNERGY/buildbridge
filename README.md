# BuildBridge

> GoHighLevel marketplace app that bridges HighLevel with the tools construction &
> home-services businesses already run on: **SmartBuild**, **IdeaRoom**, **QuickBooks
> Online**, and **Monday.com**.

BuildBridge installs into a GoHighLevel (GHL) sub-account, authenticates users via GHL
SSO, and exposes both a self-serve web UI and a set of GHL **workflow actions**. Access
to each integration is gated by a per-location subscription billed through **Deposyt**.

> **History:** BuildBridge was originally built as **`smartbuild-v2`** ("SmartBuild v2 –
> GoHighLevel marketplace app platform"). The npm package name is still `smartbuild-v2`;
> the product was renamed to BuildBridge. You'll see both names in the codebase.

- **Org:** CSMSYNERGY · **Repo:** https://github.com/CSMSYNERGY/buildbridge
- **Deploy target:** Railway (Docker) · **Database:** Supabase Postgres (Session Pooler)

---

## Architecture

```
GoHighLevel  ──SSO──►  BuildBridge API (Express 5)  ──►  Deposyt (billing)
   │                        │      │                       QuickBooks Online
   │  workflow actions      │      ├── Drizzle ORM ──► Postgres (Supabase)
   └──────────────────────► │      └── React SPA (/buildbridge)
                            webhooks: Deposyt · GHL · IdeaRoom
```

- **Backend** — Node 20+, Express 5, Drizzle ORM over `postgres` (Supabase). Served with
  Helmet, CORS, rate limiting, and morgan request logging.
- **Frontend** — React 19 + Vite + Tailwind (shadcn-style UI in `frontend/src/components/ui`).
  Built to `frontend/dist` and served by the API under `/buildbridge`.
- **Auth** — GHL SSO decrypts the embedded session (`/api/sso/decrypt`), issues an app JWT
  as a cookie; protected routes use `requireAuth`.
- **Billing** — Deposyt creates/cancels subscriptions; a `checkSubscription(appSlug)`
  middleware gates workflow actions on an active plan for that app.

---

## Subscriptions

The billing surface has three layers:

1. **Frontend** — [`frontend/src/pages/Subscription.jsx`](frontend/src/pages/Subscription.jsx):
   pricing page with a Monthly/Annual toggle (annual ≈ 17% saving), plan cards grouped by
   app, and a **Suite** bundle covering all apps.
2. **Service** — [`src/services/subscriptionService.js`](src/services/subscriptionService.js):
   create / update / cancel / pause, `getActiveSubscriptions`, and `hasAccess(locationId,
   appSlug)` (Suite subscribers get all four apps).
3. **Payments** — [`src/services/deposytService.js`](src/services/deposytService.js):
   calls the Deposyt API (`api.deposyt.com/v1`) to create/cancel/fetch subscriptions.
   Deposyt webhooks keep the local `subscriptions` table in sync.

### Seeded plans (`npm run seed`)

| App          | Monthly | Annual  |
|--------------|--------:|--------:|
| SmartBuild   | $150    | $1,500  |
| IdeaRoom     | $49     | $490    |
| QuickBooks   | $69     | $690    |
| Monday.com   | $59     | $590    |
| **Suite**    | $250    | $2,500  |

Prices are stored in **cents** (`plans.price_usd`). Suite covers `smartbuild`, `idearoom`,
`quickbooks`, and `monday`.

---

## Integrations

Registered at startup (`src/integrations/*`); each hooks the scheduler and/or webhooks:

- **Yoder Barnes** — QuickBooks milestone invoicing (deposit → materials → roof →
  completion) for won opportunities.
- **Rockwood** — Two-way GHL ↔ QuickBooks sync (contacts, estimates) with per-location
  sync cursors.
- **IdeaRoom** — Inbound configurator lead capture via per-location webhook.

See [`docs/quickbooks-integration.md`](docs/quickbooks-integration.md) and
[`docs/idearoom-integration.md`](docs/idearoom-integration.md).

---

## Database schema

Drizzle schema in [`src/core/db/schema.js`](src/core/db/schema.js); migrations under
`src/core/db/migrations/`.

| Table                      | Purpose |
|----------------------------|---------|
| `plans`                    | Subscription plans (per app + interval, price in cents) |
| `locations`                | GHL sub-accounts + stored GHL OAuth tokens |
| `subscriptions`            | Active/cancelled subscriptions (Deposyt id = PK) |
| `webhook_events`           | Inbound event log for idempotency + replay |
| `mappers`                  | GHL ↔ external value mappings (stages, tags, etc.) |
| `integration_credentials`  | AES-256-GCM encrypted per-app credentials |
| `qb_milestones`            | QuickBooks milestone invoices (Yoder Barnes) |
| `qb_sync_links`            | GHL ↔ QBO entity links (Rockwood) |
| `qb_sync_state`            | Per-location two-way sync cursor (Rockwood) |

---

## API surface

**Public**
- `GET|POST /api/sso/decrypt` — GHL SSO entry (issues JWT cookie)
- `GET /health` — health check

**Protected** (`requireAuth`, JWT cookie) — under `/api`
- `GET /me`
- `GET /subscription/plans` · `POST /subscription/create` · `DELETE /subscription/cancel`
- `GET /ghl/fields`
- `GET|POST|PUT|DELETE /mappers`
- `GET|POST|DELETE /smartbuild/config` · `POST /smartbuild/test`
- `GET|DELETE /quickbooks/config`

**GHL workflow actions** (`x-api-key` + auth + subscription gate) — under `/actions`
- `POST /quickbooks-sync` (requires QuickBooks plan)
- `POST /retrieve-smartbuild-job` · `POST /create-or-edit-smartbuild-job` ·
  `POST /update-opportunity` · `GET /get-mappers` (require SmartBuild plan)

**Webhooks** — under `/webhooks`
- `POST /subscription` (Deposyt, signature-verified, idempotent)
- `POST /ghl` (`x-api-key`)
- `POST /idearoom/:locationId` (signature-verified)

**Admin** (`x-admin-key` header) — under `/admin`
- `GET /locations` · `GET /webhook-events` · `POST /webhook-events/:eventId/replay`

QuickBooks OAuth connect/callback live under `/auth/quickbooks`.

---

## Local development

**Prerequisites:** Node ≥ 20, a Postgres database (local, or a Supabase Session Pooler URL).

```bash
# 1. Backend deps
npm install

# 2. Configure environment
cp .env.example .env      # then fill in real values (see below)

# 3. Database
npm run migrate           # apply Drizzle migrations
npm run seed              # insert the 10 default plans

# 4. Frontend (built output is served by the API at /buildbridge)
cd frontend && npm install && npm run build && cd ..

# 5. Run
npm run dev               # node --watch src/index.js  (http://localhost:3000)
```

Frontend hot-reload during UI work: `cd frontend && npm run dev` (Vite dev server).

**Tests:** Vitest + Supertest are configured (`npm test`) but no test files exist yet.

### Required environment variables

See [`.env.example`](.env.example) for the full list. Key ones:

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Postgres/Supabase; append `?sslmode=require` for Supabase, `?sslmode=disable` for local |
| `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` / `GHL_SCOPES` / `GHL_SHARED_SECRET` | GoHighLevel marketplace app |
| `REDIRECT_URI` | GHL OAuth callback |
| `APP_JWT_SECRET` | ≥ 32 chars |
| `ENCRYPTION_KEY` | 64 hex chars (32-byte AES-256 key) |
| `X_API_KEY` | Shared key for workflow-action + admin auth |
| `DEPOSYT_PRIVATE_API_KEY` / `DEPOSYT_WEBHOOK_SIGNING_KEY` | Billing |
| `SMARTBUILD_BASE_URL` | Public app URL (CORS origin) |
| `INTUIT_*` / `QBO_*` | QuickBooks Online (optional — blank disables) |
| `IDEAROOM_*` | IdeaRoom (optional — blank disables) |
| `ENABLE_SCHEDULER` | `false` when running multiple instances to avoid duplicate jobs |

---

## Deployment

Containerized (`Dockerfile`) and deployed on **Railway**. The API trusts one proxy hop
(`trust proxy = 1`) for correct client IPs and rate limiting, sets CSP/iframe headers so
the app can be embedded inside the GHL UI, and serves the built React SPA at `/buildbridge`.
