# BuildBridge Monitor

An independent Cloudflare Worker (`buildbridge-monitor`) that checks
`buildbridge.csmsynergy.com` every 5 minutes and **emails on state change**
(down → recovered). It runs the same asset-integrity check as the
self-verifying deploy, so it catches the blank-page failure mode (assets
serving the HTML fallback), not just hard 500s.

It's a **separate** worker from BuildBridge on purpose: if a BuildBridge deploy
breaks the main worker, the monitor is unaffected and still alerts you.

## Status (as of 2026-07-20)

- ✅ **Deployed and running.** The `*/5 * * * *` cron is live and checking the
  site (verified: it detects healthy on its own).
- ✅ **Check logic verified** against the live site (worker liveness + SPA shell
  + every hashed asset serves real JS/CSS, not the HTML fallback).
- ✅ **Email pipeline wired and verified** — the only thing left is onboarding
  (below). A forced test send returned the expected, precise error:
  `could not find account config of sending domain`, i.e. the code is correct
  and just needs `csmsynergy.com` onboarded to Email Sending.
- ✅ **Live status page:** `https://buildbridge-monitor.csm-synergy.workers.dev/`
  (read-only last-known status JSON).
- ✅ Endpoint hardened: the email-triggering test path is gated by a
  `CHECK_TOKEN` secret, so the public URL can't be used to email you.
- ✅ KV namespace `MONITOR_STATE` (`12fd5622fa08489aa1db2708ef71c352`) created.

## The one remaining step (Cloudflare dashboard — you must do this)

Email sending is the only thing that needs your account, and **it does NOT
touch your real `@csmsynergy.com` inbox** — Email Sending only adds records on a
`cf-bounce.` subdomain plus a DKIM/DMARC TXT; your root MX is left alone.

1. **Onboard the sending domain.**
   Dashboard → **Compute → Email Service → Email Sending → Onboard Domain** →
   choose **csmsynergy.com** → **Done**. Because your DNS is on Cloudflare it
   adds the `cf-bounce.*` MX/SPF/DKIM + `_dmarc` TXT records automatically
   (propagates in ~5–15 min). Keep any existing `_dmarc` record you already have.

2. **Confirm the plan.** Sending to an arbitrary address needs **Workers Paid**
   ($5/mo). Free alternative: add `ahsan@csmsynergy.com` as a **verified
   destination address** under *Email Routing → Destination Addresses* — sends to
   a verified destination are free on any plan.

3. **Tell me it's done** and I'll fire a test alert to confirm the email lands.

## Verify email after onboarding

Force one real alert with the authenticated test endpoint (the `CHECK_TOKEN`
value is stored as a Worker secret — I have it; ask if you need it):

```bash
curl "https://buildbridge-monitor.csm-synergy.workers.dev/check?key=<CHECK_TOKEN>&simulate=down"
```

- `alert.ok: true` in the response → the email was accepted; check your inbox
  for "🔴 BuildBridge is DOWN". The next cron tick (or another authed call
  without `simulate`) sends the "🟢 recovered" email and resets state.
- `alert.error: "..."` → onboarding isn't complete yet; the message says why.

Unauthenticated calls (`/check` with no/incorrect `key`) run a read-only check
and never send email — safe to hit anytime.

## Deploy / redeploy

```bash
cd "Main Apps/buildbridge/monitor"
npx wrangler deploy
```

## Notes

- Alerts are **edge-triggered**: one email when it goes down, one when it
  recovers — no spam every 5 minutes during an outage.
- The `send_email` binding is locked to `destination_address:
  ahsan@csmsynergy.com`, so this worker can only ever email that one address.
- A broken email path fails gracefully — it's logged and never crashes the
  check or corrupts the stored state (verified).
- To change recipient / frequency: edit `vars.ALERT_TO` /
  `send_email[].destination_address` / `triggers.crons` in `wrangler.jsonc`.
- Logs: `npx wrangler tail buildbridge-monitor`.
