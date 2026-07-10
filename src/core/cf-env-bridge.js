// Cloudflare Workers → process.env bridge.
//
// On Workers, plain vars and secrets are exposed via `env` imported from
// `cloudflare:workers`, not necessarily on `process.env`. The rest of the app
// (envalid in core/env.js, dotenv-style access) reads `process.env`, so we copy
// every string-valued entry across BEFORE any other module evaluates.
//
// This module MUST be imported first in the Worker entry (src/worker.js) so its
// top-level code runs before core/env.js executes envalid's cleanEnv().
//
// Object bindings (Hyperdrive, ASSETS, KV, ...) are intentionally skipped — they
// are not strings and are consumed directly from `cloudflare:workers` env where
// needed (see core/db/client.js).
import { env as cfEnv } from 'cloudflare:workers';

try {
  for (const [key, value] of Object.entries(cfEnv)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
} catch {
  // If enumeration is unavailable in some runtime mode, individual bindings are
  // still reachable via `cfEnv`; the app's required vars are set explicitly in
  // wrangler.jsonc (vars) and via `wrangler secret put`.
}
