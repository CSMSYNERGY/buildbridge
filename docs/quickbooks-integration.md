# QuickBooks Integration — Design Doc

> Status: **Proposal / design only.** This document contains no product code. It captures the
> requirements gathered from three recent client meetings and a concrete implementation design for
> adding QuickBooks Online (QBO) support to BuildBridge.

## 1. Context & Goals

QuickBooks integration was defined as a high-priority requirement for two BuildBridge clients across
three meetings (2026-06-25, 2026-07-01, 2026-07-02). Today QuickBooks is only **scaffolded** in the
codebase — the `quickbooks` slug exists in subscription plans, the `SUITE_APPS` list, and the
Mapper/Subscription UI — but there is **no** QuickBooks service, OAuth flow, controller, or sync
logic. This doc proposes how to build it on top of the patterns BuildBridge already uses.

Two distinct integration models are required, each serving a different client workflow. The
Yoder Barnes one-way model is intended to become the **standard for future clients**.

### Naming notes
- **"Carolyn"** in the meetings is Carolyn Miller (product counterpart).
- **"Wealdridge"** heard in conversation is a mis-transcription of **BuildBridge** — the project name
  itself, not a client. The two QuickBooks clients are **Rockwood (Sheds)** and **Yoder Barnes**.
- **GHL / GoHighLevel** is referred to as "Synergy" / "the CRM" in meetings.

## 2. Requirements (from meetings)

### Rockwood — two-way sync
- Bidirectional sync of **contacts + estimates** between QuickBooks and GHL.
- Rockwood is a **legacy QuickBooks user**; QuickBooks is effectively their source of truth, so
  Synergy (GHL) must reflect changes made in QuickBooks and vice-versa.
- Source: [Jul 2](https://fathom.video/calls/732981007), [Jul 1](https://fathom.video/calls/731773675).

### Yoder Barnes — one-way push + milestone auto-invoicing
Their team never logs into QuickBooks. The flow:
1. **GHL opportunity marked "Won"** → create a **contact in QuickBooks**.
2. Populate **4 monetary custom fields** (with milestone dates) sourced from SmartBuild:
   - `Deposit`
   - `Materials Delivery`
   - `Roof Completion`
   - `Project Completion`
3. **Auto-generate one invoice per milestone**, scheduled relative to each date
   (e.g. ~3 days before the Material Delivery date).
- Source: [Jul 2](https://fathom.video/calls/732981007).

> **The Yoder Barnes one-way model is the intended standard for future clients.**

## 3. Current State — what already exists to build on

BuildBridge is a GoHighLevel marketplace app (internally still `smartbuild-v2`) — multi-tenant
middleware that installs into GHL sub-accounts ("locations") and sells add-on integrations billed
through Deposyt. The following are already in place and should be **reused**:

| Concern | Exists today | Reuse for QuickBooks |
|---|---|---|
| Encrypted per-app credential store | `integrationCredentials`, keyed by `(locationId, appSlug)` — `src/core/db/schema.js:87-96` | Store QB OAuth tokens under `appSlug='quickbooks'`. **No schema migration.** |
| Credential encryption | AES-256-GCM — `src/core/middleware/encrypt.js` | Encrypt the QB token blob |
| OAuth + auto-refresh pattern | `src/services/ghlService.js:98-140` (`makeGhlRequest` refreshes when expired / within 60s) | Clone for Intuit |
| OAuth route/controller pattern | `src/controllers/authController.js` + `src/routes/authRoutes.js` | Clone for `/auth/quickbooks[/callback]` |
| Per-app config UI + API | `src/services/smartbuildService.js` + `webApiController.js:199-309` + `frontend/src/pages/SmartBuild.jsx` | Clone as QB config page |
| Subscription gating | `checkSubscription('quickbooks')` — slug already in `SUITE_APPS` (`src/core/ghl/middleware.js:8`, `src/services/subscriptionService.js:7`); plans seeded (`src/core/db/seed.js:10-11`) | Works as-is |
| Field mapping | Generic Mapper system, `quickbooks` already in `APP_SLUGS` (`frontend/src/pages/Mapper.jsx:13`) | Define QB `mapperType`s |
| Webhook idempotency + audit | `webhookEvents` + `src/core/webhooks/eventLog.js` | Reuse for inbound GHL webhook |

### Gaps requiring new infrastructure
- **No inbound GHL webhook handler.** `/webhooks` today only handles Deposyt billing events.
- **No scheduler.** Milestone invoicing needs a time-based worker; none exists yet.
- **Mapper runtime consumption is a stub** — `actionsController.getMappers` returns a placeholder, so
  mappers created in the UI are stored but not yet applied at runtime.

## 4. Architecture — separate branches per client

Per the Jul 2 decision, Rockwood and Yoder Barnes are developed on **separate branches**:

- **Base / shared foundation** (landed first): Intuit OAuth flow, `quickbooksService`, QB config UI,
  env wiring, and QB mapper types. Both client branches build on this.
- **`client/rockwood`** — the two-way contacts + estimates reconciler.
- **`client/yoder-barnes`** — Won→contact creation, the milestone engine, and the invoice scheduler.

**Trade-off (documented honestly):** separate branches give per-client isolation and let each client
ship/roll back independently, but they diverge over time and increase maintenance cost (fixes to the
shared foundation must be merged into both). If maintenance overhead becomes painful, the branches
can later be unified behind a per-location `syncMode` config flag, since BuildBridge is already
multi-tenant.

## 5. Component Design

### 5.1 QuickBooks service — `src/services/quickbooksService.js`
Modeled on `ghlService.js`:
- `exchangeCodeForTokens(code, realmId)` — Intuit OAuth2 authorization-code exchange; persist
  `access_token`, `refresh_token`, `realmId`, and expiry as an encrypted JSON blob in
  `integrationCredentials` (`appSlug='quickbooks'`).
- `refreshAccessToken(locationId)` — refresh-token flow; re-encrypt and store.
- `makeQuickBooksRequest(locationId, method, path, body)` — loads creds, auto-refreshes when the
  access token is expired or within ~60s of expiry (QBO access tokens last ~60 min; refresh tokens
  ~100 days), then calls the QBO API for the stored `realmId`. Wraps the Customer, Invoice, and
  Estimate endpoints.

### 5.2 OAuth routes/controller — `src/routes/quickbooksRoutes.js` + controller
- `GET /auth/quickbooks` → redirect to Intuit's authorize URL with `state`.
- `GET /auth/quickbooks/callback` → capture `code` + `realmId`, exchange for tokens, store creds,
  redirect back into the app. Mirrors `authController.js`.

### 5.3 Config UI + API
- Clone the SmartBuild config endpoints (`getSmartBuildConfig` / `save` / `delete` / `test`,
  `webApiController.js:199-309`) into QuickBooks equivalents.
- Add `frontend/src/pages/QuickBooks.jsx` and a nav item in `frontend/src/layouts/AppLayout.jsx`.
- **Difference from SmartBuild:** QuickBooks uses OAuth, not username/password — the "Connect" button
  kicks off the OAuth redirect (`/auth/quickbooks`) rather than storing a password.

### 5.4 Inbound GHL "opportunity Won" webhook
- Add a handler under `/webhooks` for GHL opportunity stage-change events.
- Reuse `webhookEvents` + `eventLog.js` for idempotency and audit.
- On "Won", trigger the Yoder Barnes flow (contact creation + milestone setup).

### 5.5 Milestone engine (Yoder Barnes)
- On "Won", pull the SmartBuild job data via the existing `retrieveSmartBuildJob` action.
- Compute the 4 milestone amounts and dates (`Deposit`, `Materials Delivery`, `Roof Completion`,
  `Project Completion`).
- Persist milestones and enqueue scheduled invoices.

### 5.6 Scheduler (new)
- A lightweight daily worker that finds milestones whose scheduled date is due (e.g. ~3 days before
  Material Delivery) and creates the corresponding QBO invoice via `makeQuickBooksRequest`.
- Idempotent: never double-invoice a milestone (track invoice state per milestone).

### 5.7 Rockwood two-way sync
- A periodic (and/or webhook-driven) reconciler for contacts + estimates between QBO and GHL.
- Requires a change-detection strategy and conflict handling (see Open Questions).

### 5.8 Mappers
- Define QuickBooks `mapperType`s (e.g. `qb_item`, `milestone_field`, `customer_field`).
- Implement the currently-stubbed `actionsController.getMappers` so mappings are consumed at runtime.

## 6. Data & Credentials
- QuickBooks OAuth tokens (`access_token`, `refresh_token`, `realmId`, expiry) are stored as an
  AES-256-GCM-encrypted JSON blob in `integrationCredentials` with `appSlug='quickbooks'`.
- **No database migration is required** — the generic per-app credential store already supports this.

## 7. Env / Config Additions
Add and wire into `src/core/env.js` (envalid schema) and the fail-fast checks in `src/start.js:17-22`:
- `INTUIT_CLIENT_ID`
- `INTUIT_CLIENT_SECRET`
- `QBO_REDIRECT_URI`
- QBO API base URL (sandbox vs production)

## 8. Phased Roadmap
1. **Foundation** — Intuit OAuth + `quickbooksService` + QB config UI + env wiring. *(Connect a
   sandbox QuickBooks company end-to-end.)*
2. **Yoder Barnes: Won → contact** — inbound GHL webhook + QB contact creation.
3. **Milestone invoicing** — scheduler + the 4 auto-invoices. **Ship to Yoder Barnes first** (future
   standard).
4. **Rockwood: two-way sync** — contacts + estimates reconciler.
5. **Mapper consumption** — implement the `getMappers` runtime + QB mapper types.

## 9. Open Questions
- **Sandbox vs production realm:** which QBO environment do we target first, and how do we manage the
  base URL per environment?
- **Two-way conflict strategy (Rockwood):** last-write-wins, timestamp-based, or field-level merge?
  What happens on simultaneous edits in QB and GHL?
- **GHL "Won" detection:** which GHL webhook events/fields reliably signal an opportunity moving to
  Won, and are agency-vs-subaccount webhook subscriptions available?

## Meeting sources
- 2026-06-25 — BuildBridge kickoff (Idea Room + QuickBooks): <https://fathom.video/calls/724993251>
- 2026-07-01 — Prioritization, two clients, build on Rockwood work: <https://fathom.video/calls/731773675>
- 2026-07-02 — QuickBooks requirements defined (the two models): <https://fathom.video/calls/732981007>
