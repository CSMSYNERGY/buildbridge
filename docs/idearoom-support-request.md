# IdeaRoom support request — API key + webhook (draft)

> Draft message to send IdeaRoom support (via the SalesView chat bubble or support email)
> to unblock the BuildBridge ↔ IdeaRoom lead integration for Built-Rite Buildings.
> Fill the two placeholders (**‹BuildBridge host›** and **‹GHL locationId›**) before sending.

---

**Subject:** API key + webhook setup for Built-Rite Buildings (CarportView) → CRM integration

Hi IdeaRoom team,

I'm with CSM Synergy — we're building the CRM integration for our client **Built-Rite Buildings**
(CarportView, `client-id: carportview-built-rite-buildings`). We have admin access to their SalesView
account. We've reviewed the [API & Integrations page](https://www.idearoom.com/api) and the
[Swagger docs](https://app.swaggerhub.com/apis-docs/idearoom/idearoom-api-public/1.0.0), and we want
to push configurator leads into their CRM (GoHighLevel). Could you help us with the following:

1. **REST API key** — please issue the `x-api-key` for the Built-Rite account so we can call
   `GET /v1/orders/{hash}` at `https://api.idearoominc.com` with `client-id: carportview-built-rite-buildings`.

2. **Webhook** — please enable a webhook that POSTs the **Created** (and **Updated**) events to our endpoint:
   `https://‹BuildBridge host›/webhooks/idearoom/‹GHL locationId›`

3. **Webhook authentication** — how does the outbound webhook authenticate to our endpoint? Is there a
   shared secret / signing header (and what header name), an HMAC signature scheme, or should we rely
   on the URL being private? We want to verify inbound requests correctly on our side.

4. **Confirmations** — is a per-site target URL like the above fine for routing, and is there anything
   else we need to configure on the SalesView side (or is webhook setup handled entirely by your team)?

Thanks very much!
CSM Synergy

---

## What each answer unblocks (internal notes — do not send)

- **#1 API key** → set `IDEAROOM_API_KEY` (or store per-location in `integrationCredentials`); enables
  the REST pull path (`idearoomService.fetchOrder`) and an interim pull-based lead sync if we want one.
- **#2 webhook** → the primary push path (`POST /webhooks/idearoom/:locationId`), already built.
- **#3 auth scheme** → finalizes `verifyIdearoomWebhook` (currently provisional; see
  [idearoom-integration.md](./idearoom-integration.md) §9) and sets `IDEAROOM_WEBHOOK_SECRET` if applicable.
- **#4** → confirms per-location URL tenant routing.
