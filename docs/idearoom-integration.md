# IdeaRoom Integration — Design Doc

> Status: **Proposed.** This is the kickoff design for the IdeaRoom portion of BuildBridge, written
> the same way the [QuickBooks doc](./quickbooks-integration.md) was: capture the requirement, map it
> onto infrastructure BuildBridge already has, and name the open questions honestly. Unlike
> QuickBooks, **no code exists yet** beyond the scaffolded `idearoom` slug (subscription plans, the
> `SUITE_APPS` list, and the Mapper/Subscription UI).

## 1. Context & Goals

IdeaRoom is a 3D building configurator (sheds, carports, barns, etc.) that shed/post-frame builders
embed on their websites. When a customer designs a building, that is a **high-intent lead**. The goal
of this integration is to **sync IdeaRoom leads directly into GoHighLevel** ("Synergy" / "the CRM") —
creating a contact and an opportunity, complete with the configured design specs and pricing, so the
client's sales team can follow up fast.

The trigger for building this now: new client **BuiltRight** signed up for IdeaRoom and granted CSM
Synergy **admin access** to their IdeaRoom account — the access we'd been waiting on to build the
integration and offer it to other clients. The client's own framing in the kickoff was "what email
address do we use to send leads to Synergy?" — the honest answer is that a real integration is better
than email parsing, and IdeaRoom supports one.

### Naming notes
- **"Synergy" / "the CRM"** in meetings = **GoHighLevel (GHL)**.
- **BuiltRight** is the first IdeaRoom client (the one providing admin access).
- The Yoder Barnes / Rockwood names belong to the **QuickBooks** work, not this one.

### Source
- 2026-06-25 kickoff — "New client BuiltRight signed up for IdeaRoom… Goal: Sync IdeaRoom leads
  directly into Synergy. Ahsan will research the IdeaRoom API":
  <https://fathom.video/calls/722596636>

## 2. How IdeaRoom exposes data (research findings)

Per IdeaRoom's [API & Integrations page](https://www.idearoom.com/api), IdeaRoom offers three ways in
— we should build on the **webhook**, which is IdeaRoom's own recommended CRM-integration mechanism
(it's how their built-in HubSpot integration works).

### 2.1 Webhook (primary — event-based push, IdeaRoom → us)
IdeaRoom pushes a JSON payload to a target URL when a user acts on a design. Five events:

| Event | Fires when |
|---|---|
| **Created** | User submits a new configuration via save, quote, or checkout |
| **Updated** | User re-opens a design from its link and re-submits to the same email |
| **Visited** | User re-loads a previously saved design via its link |
| **Checkout Opened** | User starts the checkout process |
| **Payment Prepared** | User submits the first checkout step (payment method selected) |

For lead capture we care primarily about **Created** (and **Updated** to refresh an existing lead).

**Confirmed payload shape** (from IdeaRoom's official sample payloads — see fixtures below).
Top-level keys: `schema`, `eventType` (`"created"` | `"updated"` | …), `clientId`, `url`, `order`,
`visits`, `updates`, `checkoutOpened`, `hash`, `environment`. The interesting data is under `order`:

| Payload path | Use in GHL |
|---|---|
| `order.customer` = `{ email, firstName, lastName, phone }` | Contact (dedupe by email/phone) |
| `order.billingAddress` = `{ address1, city, state, zip, sameAsShipping }` | Contact address |
| `order.totalPrice`, `subtotalPrice`, `buildingPrice`, `depositAmount`, `totalTax` | Opportunity monetary value |
| `order.status` (e.g. `"quote"`) | Opportunity stage hint |
| `order.lineItems[]` = `{ optionKey, optionType, description, productCategory, section, price, quantity, … }` | Design spec / BOM → opportunity notes or custom field (the sample has 32 line items) |
| `order.dealer`, `order.salesAccount` | Optional routing / owner assignment |
| `url` (design link, ends in `#<hash>`) + `hash` | Clickable link back to the design; **`hash` is the idempotency key** |
| `clientId` (e.g. `carportview-built-rite-buildings`) | **Tenant routing** → map to GHL locationId |

**Fixtures** saved for building/testing `normalizeLead`:
- `docs/fixtures/idearoom-carports-webhook-sample.json` (BRB is a **CarportView** site — this is the one)
- `docs/fixtures/idearoom-sheds-webhook-sample.json`
- Source: IdeaRoom [API page](https://www.idearoom.com/api) → "JSON Examples of Webhook Payload".

### 2.2 REST API (secondary — on-demand GET) — CONFIRMED
An on-demand GET that returns the **same payload** as the webhook. Fully documented in
[Swagger](https://app.swaggerhub.com/apis-docs/idearoom/idearoom-api-public/1.0.0):

- **Base URL:** `https://api.idearoominc.com` (production).
- **Endpoint:** `GET /v1/orders/{hash}` — `hash` is the design/order identifier that also arrives in
  the webhook payload and the design `url`.
- **Auth (headers):** `x-api-key` (issued by IdeaRoom) **+** `client-id` in the form
  `{shedview|carportview}-{vendorKey}` — for BRB: **`carportview-built-rite-buildings`**.
- **No OAuth.** Just the two headers. This is our **backfill / reconciliation** path (re-pull a design
  if a webhook was missed), and — since it needs only an API key, not a support-provisioned webhook —
  a possible **interim** path to pull leads while the push webhook is being set up.

### 2.3 Built-in integrations (the model to mirror)
IdeaRoom ships out-of-the-box integrations including **HubSpot**, **Shed Suite**, RTO National's DMS,
CAL, ZipTax, and ad tracking. The **HubSpot** one is our template: IdeaRoom's own web service
consumes the webhook and creates a HubSpot **contact** (customer info) + **deal** (design summary).
Our BuildBridge integration does the same thing into GHL: **contact + opportunity**.

### 2.4 Also available: Zapier
Zapier is included in all IdeaRoom plans. It's a viable no-code fallback, but a first-party
BuildBridge webhook receiver is the product we're selling — Zapier is the "if you must" escape hatch,
not the build target.

## 3. Direction of data flow — the key difference from QuickBooks

QuickBooks (Yoder Barnes) is **outbound**: a GHL event pushes data *out* to QBO. IdeaRoom is the
**mirror image** — it is **inbound**: IdeaRoom pushes a webhook *in*, and we create a GHL lead.

**Consequence:** the primary path needs **no OAuth to IdeaRoom at all.** IdeaRoom authenticates to
*us* (via a shared secret / signature on the inbound webhook); we write to GHL using the GHL token we
already store per location. An IdeaRoom API credential is only needed for the optional REST backfill
path (§5.6).

## 4. Current State — what already exists to build on

| Concern | Exists today | Reuse for IdeaRoom |
|---|---|---|
| Inbound webhook route + idempotency + audit | `/webhooks/ghl` → `handleGhlWebhook`; `webhookEvents` table + `eventLog.js` (`src/routes/webhookRoutes.js:37`, `src/controllers/ghlWebhookController.js`) | Clone as `/webhooks/idearoom`; log with `source='idearoom'` |
| Handler registry / dispatch | `registerGhlHandler` + `dispatchGhlEvent` (`src/core/webhooks/ghlDispatcher.js`) | Same pattern, keyed by IdeaRoom event type (`created`, `updated`, …) |
| Integration module registration | `src/integrations/yoderBarnes.js` registers handlers at import time; imported in `src/index.js:15` | Add `src/integrations/idearoom.js`, import it in `index.js` |
| Writing contacts/opportunities into GHL | `ghlService.js` (`makeGhlRequest`, auto-refreshing OAuth) | Reuse as-is to create the contact + opportunity |
| Encrypted per-app credential store | `integrationCredentials`, keyed by `(locationId, appSlug)` (`src/core/db/schema.js:87`) | Store the inbound webhook secret (and optional REST API key) under `appSlug='idearoom'`. **No schema migration.** |
| Inbound API-key auth on a webhook | `verifyApiKey` middleware (`src/routes/webhookRoutes.js:37`) | Starting point for authenticating IdeaRoom's inbound calls (see Open Questions on IdeaRoom's actual scheme) |
| Subscription gating | `checkSubscription('idearoom')` — slug already in `SUITE_APPS`; plans seeded `idearoom_monthly` / `idearoom_annual` (`src/core/db/seed.js:8`) | Works as-is |
| Field mapping | Generic Mapper system; `idearoom` already in `APP_SLUGS` (`frontend/src/pages/Mapper.jsx:13`) | Define IdeaRoom `mapperType`s (§5.5) |
| Per-app config UI + API | `SmartBuild.jsx` + config endpoints in `webApiController.js` | Clone as an IdeaRoom config page |

### Gaps requiring new code
- **No `/webhooks/idearoom` route or controller.**
- **No `src/services/idearoomService.js`** (payload normalization + optional REST client).
- **No `src/integrations/idearoom.js`** (handler registration: webhook → GHL lead).
- **No `frontend/src/pages/IdeaRoom.jsx`** config page or nav item.
- **No IdeaRoom `mapperType`s defined.**
- **Inbound auth/signature verification** for IdeaRoom is unconfirmed (Open Questions §9).

## 5. Component Design

### 5.1 Inbound webhook route + controller
- `POST /webhooks/idearoom` in `webhookRoutes.js`, guarded by an auth/signature middleware
  (§9 — likely a shared secret in a header or query token; confirm with IdeaRoom).
- `handleIdearoomWebhook` mirrors `handleGhlWebhook`: derive an idempotency key from the payload
  (the design's unique hash + event type), log to `webhookEvents` (`source='idearoom'`), dispatch,
  mark processed/failed. Reuse `eventLog.js` verbatim.
- **Location resolution:** the payload won't contain a GHL `locationId`. Map IdeaRoom → location by
  the target URL (e.g. `/webhooks/idearoom/:locationId` or a per-location token in the URL/secret)
  so each client's IdeaRoom account routes to their own GHL sub-account.

### 5.2 IdeaRoom dispatcher / handler registry
- Either add an IdeaRoom-specific `registerIdearoomHandler`/`dispatchIdearoomEvent` (cleanest), or
  generalize the existing GHL dispatcher to be source-agnostic. Recommend a small IdeaRoom dispatcher
  mirroring `ghlDispatcher.js` to avoid destabilizing the QuickBooks path.

### 5.3 `src/services/idearoomService.js`
- `normalizeLead(payload)` — map IdeaRoom's Customer Contact + Order Summary + Product Design Details
  + image URLs into a flat, GHL-ready shape (name, email, phone, price, product type, design link,
  spec summary, image URLs).
- (Optional) `fetchDesign(hash)` — REST GET for backfill/reconciliation (§5.6), using a stored
  IdeaRoom API key.

### 5.4 `src/integrations/idearoom.js` — the lead flow
Registers handlers at import time (import from `index.js`, like `yoderBarnes.js`). On **Created**
(and **Updated**):
1. `normalizeLead(payload)`.
2. Upsert a **GHL contact** (dedupe by email/phone) via `ghlService`.
3. Create/update a **GHL opportunity** in the mapped pipeline + stage, attach design summary, price,
   design link, and image URLs (via notes/custom fields), and apply configured tags.
4. Idempotent: never create duplicate opportunities for the same design hash (track via the
   idempotency key / a sync-link row — see §6).

### 5.5 Config UI + API
- `frontend/src/pages/IdeaRoom.jsx` + nav item in `AppLayout.jsx`, cloned from `SmartBuild.jsx`.
- Shows the client the **exact webhook URL** to paste into IdeaRoom's webhook settings, plus the
  shared secret to configure. **Difference from SmartBuild:** there's no username/password to
  IdeaRoom for the primary path — the client pastes *our* URL into *IdeaRoom*, not the reverse.
- Config endpoints cloned from the SmartBuild set in `webApiController.js` (get/save/delete/test).

### 5.6 REST backfill (optional, later)
A small on-demand path to re-pull a design by hash when a webhook is missed, and/or a periodic
reconciliation job (reuse `scheduler.js` via `registerJob`). Requires storing an IdeaRoom API key.

### 5.9 Mapper values (reference)
`handleIdearoomLead` reads two mapper types (appSlug `idearoom`). Configure them on the Mappers page
— the pipeline/stage pickers there list the location's real GHL pipelines and stages by name.

| mapperType | externalKey | ghlValue | Required | Purpose |
|---|---|---|---|---|
| `pipeline` | `default` | GHL pipeline id | ✅ | Pipeline for IdeaRoom lead opportunities. Missing → contact created, no opportunity. |
| `opportunity_stage` | `default` | GHL stage id | ⭐ | Fallback stage for a new lead. Missing → pipeline's first stage. |
| `opportunity_stage` | `save` / `quote` / `deposit` / `deposit-later` / `deposit-now-token` / `deposit-now-paying` / `deposit-now-charged` | GHL stage id | optional | Stage per IdeaRoom `order.status` (the `OrderState` enum). Overrides `default` when the design's status matches. |
| `contact_tag` | `default` | tag name | optional | Tag applied to every IdeaRoom lead. When none configured, a fixed `idearoom-lead` tag is applied. |
| `contact_tag` | `save` / `quote` / `deposit` / … | tag name | optional | Extra tag applied when the design's `order.status` matches. |

Minimum to go live: one `pipeline/default` + one `opportunity_stage/default`. `contact_tag` is
optional — with no tag mapper the handler falls back to a fixed `idearoom-lead` tag.

## 6. Data & Credentials
- Inbound webhook secret (and optional REST API key) stored as an AES-256-GCM-encrypted JSON blob in
  `integrationCredentials` with `appSlug='idearoom'`. **No DB migration required** for credentials.
- **Dedupe/idempotency:** the IdeaRoom design hash + event is the idempotency key. A
  `webhookEvents` row already gives us audit + replay. If we need a durable IdeaRoom-design→GHL-entity
  link (to update rather than duplicate on the **Updated** event), add a small `idearoomLeads`
  table (design hash → GHL contactId/opportunityId) — the one **potential** schema addition; confirm
  during build whether `webhookEvents` alone is sufficient.

## 7. Env / Config Additions
Wire into `src/core/env.js` (envalid) and the fail-fast checks in `src/start.js`:
- `IDEAROOM_API_BASE_URL` — default `https://api.idearoominc.com`.
- `IDEAROOM_API_KEY` — the `x-api-key` issued by IdeaRoom (for the REST pull path).
- The per-location `client-id` (e.g. `carportview-built-rite-buildings`) is stored per location in
  `integrationCredentials` (`appSlug='idearoom'`), not env.
- `IDEAROOM_WEBHOOK_SECRET` (or per-location secret in `integrationCredentials`) — **pending**
  confirmation of how IdeaRoom's outbound webhook authenticates (§9).

## 8. Phased Roadmap
1. ⏳ **Confirm the integration contract** — payload shape ✅ and REST auth ✅ confirmed (§2). Still
   need IdeaRoom support to issue the `x-api-key` and enable/authenticate the push webhook
   (see [idearoom-support-request.md](./idearoom-support-request.md)).
2. ✅ **Foundation** — `POST /webhooks/idearoom/:locationId` (`idearoomWebhookController.js`) +
   `idearoomDispatcher.js` + `webhookEvents` logging + provisional `verifyIdearoomWebhook`.
3. ✅ **Lead flow** — `idearoomNormalize.normalizeLead` (unit-tested against both fixtures) +
   `idearoomService.handleIdearoomLead` + `integrations/idearoom.js`: Created → GHL contact +
   opportunity with specs/price/images; Updated refreshes the contact only.
4. ✅ **Config UI** — `frontend/src/pages/IdeaRoom.jsx` (webhook URL display + copy, client-id + REST
   key, test), nav item, and config API (`/api/idearoom/config` + `/test`).
   *Remaining:* seed IdeaRoom `mapperType`s in the UI (pipeline, opportunity_stage, tags).
5. ⏳ **Validate with BuiltRight** — real design in IdeaRoom → lead lands in their GHL sub-account.
   Gated on step 1 (webhook enabled + API key). The GHL write path is unit-shaped but not yet run
   against a live location.
6. ⬜ **(Optional) REST backfill + reconciliation job** — `idearoomService.fetchOrder` exists; wire a
   scheduled pull if we want leads before the push webhook is provisioned.

## 9. Open Questions

**Resolved during research (2026-07-14, via BuiltRight's SalesView + IdeaRoom's public API docs):**
- ✅ **Payload shape** — confirmed from official sample payloads (§2.1); fixtures saved.
- ✅ **REST API auth** — `x-api-key` + `client-id` headers, base `https://api.idearoominc.com`,
  `GET /v1/orders/{hash}` (§2.2). No OAuth.
- ✅ **Tenant routing** — `clientId` / `client-id` (`carportview-built-rite-buildings`) identifies the
  site; map it to a GHL locationId.
- ✅ **No self-service webhook UI** — SalesView's Integrations page offers only Payments + Analytics
  (and SmartBuild, already connected). The push webhook must be **provisioned by IdeaRoom support.**

**Still open:**
- **Webhook (push) auth/signing:** how does IdeaRoom's *outbound* webhook authenticate to us — a
  header secret, HMAC signature, or nothing (rely on the URL being secret)? Not in the public docs;
  capture it from a real request or ask support. Determines the verify middleware.
- **Webhook URL provisioning:** confirm with IdeaRoom support how the target URL is registered and
  whether we can use a per-location URL (`/webhooks/idearoom/:locationId`) for tenant routing.
- **Which events create leads:** Created only, or also Checkout Opened / Payment Prepared as
  higher-intent stage transitions? (Could map events → pipeline stages.)
- **Lead vs. update semantics:** on **Updated**, refresh the existing opportunity or create a new
  one? (Drives whether we need the `idearoomLeads` link table in §6.)
- **Interim REST-pull option:** because the REST API needs only an `x-api-key` (no support-provisioned
  webhook), should we ship a first version that *pulls* recent orders on a schedule while the push
  webhook is being set up? (Trade-off: polling latency vs. faster time-to-first-lead.)
