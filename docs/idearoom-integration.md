# IdeaRoom Integration — Design Doc

> Status: **Proposed / in build.** Kickoff design for the IdeaRoom portion of BuildBridge, written the
> same way the [QuickBooks doc](./quickbooks-integration.md) was: capture the requirement, map it onto
> infrastructure BuildBridge already has, and name the open questions honestly.

## 1. Context & Goals

IdeaRoom is a 3D building configurator (sheds, carports, barns, etc.) that shed/post-frame builders
embed on their websites. When a customer designs a building, that is a **high-intent lead**. The goal
of this integration is to **sync IdeaRoom leads directly into GoHighLevel** ("Synergy" / "the CRM") —
creating a contact and an opportunity, complete with the configured design specs and pricing, so the
client's sales team can follow up fast.

The trigger for building this now: new client **BuiltRight / Built-Rite Buildings** signed up for
IdeaRoom and granted CSM Synergy **admin access** to their IdeaRoom (SalesView) account.

### Naming notes
- **"Synergy" / "the CRM"** in meetings = **GoHighLevel (GHL)**.
- **Built-Rite Buildings** is the first IdeaRoom client (CarportView; `carportview-built-rite-buildings`).

### Source
- 2026-06-25 kickoff — "New client signed up for IdeaRoom… Goal: Sync IdeaRoom leads directly into
  Synergy": <https://fathom.video/calls/722596636>

## 2. How IdeaRoom exposes data (research findings)

Per IdeaRoom's [API & Integrations page](https://www.idearoom.com/api), IdeaRoom offers a **webhook**
(its recommended CRM-integration mechanism — it's how the built-in HubSpot integration works), plus a
REST API and Zapier.

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
Top-level keys: `schema`, `eventType`, `clientId`, `url`, `order`, `visits`, `updates`,
`checkoutOpened`, `hash`, `environment`. The interesting data is under `order`:

| Payload path | Use in GHL |
|---|---|
| `order.customer` = `{ email, firstName, lastName, phone }` | Contact (dedupe by email/phone) |
| `order.billingAddress` = `{ address1, city, state, zip, sameAsShipping }` | Contact address |
| `order.totalPrice`, `subtotalPrice`, `buildingPrice`, `depositAmount`, `totalTax` | Opportunity monetary value |
| `order.status` (e.g. `"quote"`) | Opportunity stage hint |
| `order.lineItems[]` = `{ optionKey, optionType, description, productCategory, section, price, quantity, … }` | Design spec / BOM → opportunity note or custom field |
| `order.integrationProperties` = `{ buildingStyle, buildingSize:{width,length} }` | Product summary (Carports) |
| `order.sharePost.description` | Product summary fallback (Sheds) |
| `order.images` = `{ isoSrc, frontSrc, … }` | Render image URLs |
| `url` (ends in `#<hash>`) + `hash` | Design link; **`hash` is the idempotency key** |
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
- **No OAuth.** Just the two headers. Our **backfill / reconciliation** path, and — since it needs only
  an API key, not a support-provisioned webhook — a possible **interim** lead-pull path.

### 2.3 Built-in integrations (the model to mirror)
IdeaRoom ships HubSpot, Shed Suite, RTO National DMS, CAL, ZipTax, ad tracking. The **HubSpot** one is
our template: IdeaRoom's web service consumes the webhook and creates a HubSpot **contact** + **deal**.
Our BuildBridge integration does the same into GHL: **contact + opportunity**.

### 2.4 Also available: Zapier
Included on all IdeaRoom plans — a no-code fallback, not the build target.

## 3. Direction of data flow — the key difference from QuickBooks

QuickBooks (Yoder Barnes) is **outbound**: a GHL event pushes data *out* to QBO. IdeaRoom is the
**mirror image** — **inbound**: IdeaRoom pushes a webhook *in*, and we create a GHL lead.

**Consequence:** the primary path needs **no OAuth to IdeaRoom.** IdeaRoom authenticates to *us*; we
write to GHL using the GHL token we already store per location. An IdeaRoom API credential is only
needed for the optional REST path (§2.2 / §5.6).

## 4. Current State — what already exists to build on

| Concern | Exists today | Reuse for IdeaRoom |
|---|---|---|
| Inbound webhook route + idempotency + audit | `/webhooks/ghl`; `webhookEvents` + `eventLog.js` | Clone as `/webhooks/idearoom`; `source='idearoom'` |
| Handler registry / dispatch | `ghlDispatcher.js` | Mirror as `idearoomDispatcher.js` |
| Integration module registration | `integrations/yoderBarnes.js`, imported in `src/index.js` | Add `integrations/idearoom.js`, import in `index.js` |
| Writing contacts/opportunities into GHL | `ghlService.makeGhlRequest` | Reuse as-is |
| Encrypted per-app credential store | `integrationCredentials` keyed by `(locationId, appSlug)` | Store client-id + optional API key under `appSlug='idearoom'`. **No migration.** |
| Subscription gating | `checkSubscription('idearoom')`; plans seeded | Works as-is |
| Field mapping | Generic Mapper; `idearoom` in `APP_SLUGS` | Define IdeaRoom `mapperType`s (§5.9) |
| Per-app config UI + API | `SmartBuild.jsx` + config endpoints | Clone as the IdeaRoom config page |

## 5. Component Design

### 5.1 Inbound webhook route + controller
`POST /webhooks/idearoom/:locationId` (`idearoomWebhookController.js`), guarded by a provisional auth
middleware (§9). Derives an idempotency key from `hash` + eventType, logs to `webhookEvents`, dispatches.
Location comes from the URL (payload has only `clientId`, no GHL locationId).

### 5.2 IdeaRoom dispatcher — `idearoomDispatcher.js`
Mirrors `ghlDispatcher.js` (`registerIdearoomHandler` / `dispatchIdearoomEvent`), keeping the GHL path
untouched.

### 5.3 `idearoomService.js` (+ pure `idearoomNormalize.js`)
`normalizeLead(payload)` (pure, unit-tested against fixtures) → flat GHL-ready lead; `getCredentials`,
`fetchOrder` (REST), and `handleIdearoomLead` (the side-effectful handler).

### 5.4 `integrations/idearoom.js` — the lead flow
On **Created**/**Updated**: upsert a GHL contact (dedupe by email/phone), attach design summary +
price + link + renders as a note, apply tags, and on **Created** open an opportunity in the mapped
pipeline/stage.

### 5.5 Config UI + API
`frontend/src/pages/IdeaRoom.jsx` + nav item, cloned from `SmartBuild.jsx`. Shows the **webhook URL**
to paste into IdeaRoom + stores `client-id`/API key. Endpoints: `/api/idearoom/config` (+ `/test`).

### 5.6 REST backfill (optional, later)
`fetchOrder` re-pulls a design by hash when a webhook is missed; a scheduled reconciliation job can be
added via `scheduler.js`.

### 5.9 Mapper values (reference)
`handleIdearoomLead` reads mappers (appSlug `idearoom`). Configure them on the Mappers page — the
pipeline/stage pickers list the location's real GHL pipelines and stages by name.

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
- Inbound webhook secret (and optional REST API key + client-id) stored AES-256-GCM-encrypted in
  `integrationCredentials` (`appSlug='idearoom'`). **No DB migration required** for credentials.
- **Idempotency:** the IdeaRoom design `hash` + event is the key; `webhookEvents` gives audit + replay.
  To update (rather than duplicate) on the **Updated** event, add a small `idearoomLeads` table
  (design hash → GHL contactId/opportunityId) — the one potential schema addition; confirm during build.

## 7. Env / Config Additions
Wire into `src/core/env.js` (envalid):
- `IDEAROOM_API_BASE_URL` — default `https://api.idearoominc.com`.
- `IDEAROOM_API_KEY` — the `x-api-key` issued by IdeaRoom (for the REST pull path).
- The per-location `client-id` (e.g. `carportview-built-rite-buildings`) is stored per location in
  `integrationCredentials` (`appSlug='idearoom'`), not env.
- `IDEAROOM_WEBHOOK_SECRET` (or per-location secret) — **pending** confirmation of how IdeaRoom's
  outbound webhook authenticates (§9).

All optional (safe defaults), so the Worker boots without new secrets.

## 8. Phased Roadmap
1. ⏳ **Confirm the integration contract** — payload shape ✅ and REST auth ✅ confirmed (§2). Still
   need IdeaRoom support to issue the `x-api-key` and enable/authenticate the push webhook
   (see [idearoom-support-request.md](./idearoom-support-request.md)).
2. ✅ **Foundation** — `POST /webhooks/idearoom/:locationId` + `idearoomDispatcher.js` +
   `webhookEvents` logging + provisional `verifyIdearoomWebhook`.
3. ✅ **Lead flow** — `idearoomNormalize.normalizeLead` (unit-tested) + `idearoomService.handleIdearoomLead`
   + `integrations/idearoom.js`: Created → GHL contact + opportunity + note + tags; Updated refreshes
   the contact only.
4. ✅ **Config UI** — `frontend/src/pages/IdeaRoom.jsx` + nav + config API (`/api/idearoom/config` + `/test`),
   plus the Mapper pipeline/stage picker and IdeaRoom `mapperType` values (§5.9).
5. ⏳ **Validate with BuiltRight** — real design in IdeaRoom → lead lands in their GHL sub-account.
   Gated on step 1. The GHL write path is unit-shaped but not yet run against a live location.
6. ⬜ **(Optional) REST backfill + reconciliation job** — `idearoomService.fetchOrder` exists.

## 9. Open Questions

**Resolved during research (2026-07-16, via BuiltRight's SalesView + IdeaRoom's public API docs):**
- ✅ **Payload shape** — confirmed from official sample payloads (§2.1); fixtures saved.
- ✅ **REST API auth** — `x-api-key` + `client-id`, base `https://api.idearoominc.com`,
  `GET /v1/orders/{hash}` (§2.2). No OAuth.
- ✅ **Tenant routing** — `clientId` / `client-id` identifies the site → map to a GHL locationId.
- ✅ **No self-service webhook UI** — SalesView's Integrations page offers only Payments + Analytics
  (and SmartBuild). The push webhook must be **provisioned by IdeaRoom support.**

**Still open:**
- **Webhook (push) auth/signing:** how IdeaRoom's outbound webhook authenticates to us — header secret,
  HMAC, or none? Not in the public docs; determines `verifyIdearoomWebhook`.
- **Webhook URL provisioning:** confirm how the target URL is registered and whether a per-location
  URL (`/webhooks/idearoom/:locationId`) is acceptable for tenant routing.
- **Which events create leads:** Created only, or also Checkout Opened / Payment Prepared?
- **Lead vs. update semantics:** on **Updated**, refresh the opportunity or create a new one?
  (Drives the `idearoomLeads` link table in §6.)
- **Interim REST-pull option:** ship a scheduled pull while the push webhook is being set up?
