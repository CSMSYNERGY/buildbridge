# BuildBridge Monitor — setup

An independent Cloudflare Worker (`buildbridge-monitor`) that checks
`buildbridge.csmsynergy.com` every 5 minutes and **emails on state change**
(down → recovered). It runs the same asset-integrity check as the
self-verifying deploy, so it catches the blank-page failure mode (assets
serving the HTML fallback), not just hard 500s.

It's a **separate** worker from BuildBridge on purpose: if a BuildBridge deploy
breaks the main worker, the monitor is unaffected and still alerts you.

## What's already done (in this repo)

- `monitor/worker.js` — the check + edge-triggered email logic.
- `monitor/wrangler.jsonc` — cron `*/5 * * * *`, `send_email` binding, KV binding.
- KV namespace `MONITOR_STATE` created (`12fd5622fa08489aa1db2708ef71c352`).

## One-time setup you need to do (Cloudflare dashboard)

Email sending is the only thing that needs your account. **This does NOT touch
your real `@csmsynergy.com` inbox** — Email Sending only adds records on a
`cf-bounce.` subdomain plus a DKIM/DMARC TXT; your root MX (Google Workspace,
etc.) is left alone.

1. **Onboard the sending domain.**
   Dashboard → **Compute → Email Service → Email Sending → Onboard Domain** →
   choose **csmsynergy.com** → **Done**. Because your DNS is on Cloudflare, it
   adds the `cf-bounce.*` MX/SPF/DKIM + `_dmarc` TXT records automatically
   (propagates in ~5–15 min). If you already have a `_dmarc` record, keep yours.

2. **Confirm the plan.**
   Sending to an arbitrary address needs **Workers Paid** ($5/mo). If the
   account is still on Free, either upgrade, or (free alternative) add
   `ahsan@csmsynergy.com` as a **verified destination address** under
   *Email Routing → Destination Addresses* — sends to a verified destination are
   free on any plan.

3. **Tell me it's done** and I'll deploy + send you a test alert to confirm the
   email actually lands. (Or deploy it yourself — step below.)

## Deploy (after step 1–2)

```bash
cd "Main Apps/buildbridge/monitor"
npx wrangler deploy
```

## Verify it works

- **Status endpoint:** the worker exposes its last-known state.
  `curl https://buildbridge-monitor.<your-subdomain>.workers.dev/` → JSON `{status:"healthy",...}`
  (or hit `/check` to force a fresh check right now).
- **Test the down path:** temporarily point `TARGET_BASE_URL` (in
  `wrangler.jsonc` `vars`) at a URL that returns a broken/blank asset, redeploy,
  wait one cron tick (or hit `/check`), confirm the "🔴 BuildBridge is DOWN"
  email arrives, then revert.
- **Logs:** `npx wrangler tail buildbridge-monitor`.

## Notes

- Alerts are **edge-triggered**: one email when it goes down, one when it
  recovers — no spam every 5 minutes during an outage.
- The `send_email` binding is locked to `destination_address:
  ahsan@csmsynergy.com`, so this worker can only ever email that one address.
- To change the recipient or check frequency, edit `vars.ALERT_TO` /
  `send_email[].destination_address` / `triggers.crons` in `wrangler.jsonc`.
