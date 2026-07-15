# BuildBridge — Deploy Runbook

Deploys the Cloudflare Worker `buildbridge` (serves `https://buildbridge.csmsynergy.com`).
Source of truth: branch **`reconstruct/cloudflare-worker`**. Deploys are manual via Wrangler
(the Worker is **not** Git-connected).

> Deploy from a clean checkout of `reconstruct/cloudflare-worker`. Never `wrangler deploy`
> straight to production — use the staged **versions** flow below so you test before promoting.

---

## 0. One-time prerequisites

1. **Auth:** `wrangler login` → sign in to the **CSM Synergy** Cloudflare account.
2. **⚠️ Reconcile `wrangler.jsonc` with the LIVE Worker before first deploy.** The committed
   file came from the migration branch and may have a stale **Hyperdrive ID**. In the dashboard
   (Workers → `buildbridge` → **Bindings** / **Settings**) confirm these match the file:
   - `hyperdrive[0].id` → the real Hyperdrive binding ID (points at the Supabase pooler)
   - `account_id` → `7e50b16eb8fa53548348c37dbd71df00`
   - `routes` → `buildbridge.csmsynergy.com` (custom domain)
   - `compatibility_date` / `compatibility_flags: ["nodejs_compat"]`

   If the Hyperdrive ID is wrong, the deploy builds fine but the DB breaks. Fix the file first.
3. **Set NMI secrets** (needed for the new billing; values from the Deposyt gateway
   Developer / Security-Keys section — not the placeholders):
   ```bash
   wrangler secret put NMI_SECURITY_KEY       # private, server-side
   wrangler secret put NMI_TOKENIZATION_KEY   # public Collect.js key
   ```
   (All other secrets — GHL_*, APP_JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, DEPOSYT_* — are
   already set on the live Worker and are reused.)

---

## 1. Deploy (staged — test before promoting)

```bash
git checkout reconstruct/cloudflare-worker
git pull                       # if pushed to GitHub

npm run build:frontend         # builds frontend/dist/buildbridge (the ASSETS)

wrangler versions upload       # uploads a NEW version, prints a PREVIEW URL.
                               # Production keeps serving the old version.
```

**Smoke-test the preview URL** (checklist below). Only if clean:

```bash
wrangler versions deploy       # promote the tested version to 100% production
```

---

## 2. Smoke-test checklist

On the **preview URL** first, then re-confirm on `buildbridge.csmsynergy.com` after promoting:

- [ ] `GET /health` → 200
- [ ] `GET /buildbridge/` and a deep link (`/buildbridge/subscription`) → app loads
- [ ] `GET /api/subscription/plans` → **200** with plan cards + `checkout` config (public)
- [ ] `GET /api/subscription/mine` (no auth) → 401
- [ ] `GET /auth/quickbooks/connect` → not 404 (QuickBooks intact — the whole point)
- [ ] **Open the app through GoHighLevel** (so SSO runs): plans render, QuickBooks connects
- [ ] **Billing (do once, then cancel):** subscribe to a plan with a real card via the Collect.js
      popup → confirm a subscription appears in the gateway (Recurring) and in the app's
      "active subscriptions", then **Cancel** it.

> ⚠️ The preview uses the **real database and real NMI keys** — any test subscription is a real
> charge. Cancel it right after.

---

## 3. Rollback

If a promoted version misbehaves:

```bash
wrangler rollback              # revert to the previously-deployed version
```

or `wrangler versions deploy` an earlier version ID from `wrangler deployments list`.

---

## 4. After a clean production deploy

- **Railway** (`buildbridge-production.up.railway.app`) is now redundant for web traffic.
  Before deleting it: confirm no Deposyt / GHL / IdeaRoom webhooks still point at the
  `*.up.railway.app` URL (repoint them to `buildbridge.csmsynergy.com`). Deleting Railway also
  stops the every-15-min `qb_milestones` scheduler errors.
- The QB milestone/sync **scheduler does not run on the Worker** (no Cron Trigger). If those
  jobs are needed post-Railway, add a Cloudflare Cron Trigger + apply the QB migration
  (`qb_milestones` etc.) to the DB.

---

## Known limitations of this build

- The reconstruction was verified **behaviorally** (routes/boot match live), not diffed against
  the exact deployed bundle — hence the staged preview test above.
- The subscription **webhook handler still expects Deposyt-style events**; wire it to NMI
  recurring webhooks so gateway-side changes (failed rebills, cancellations) sync back.
