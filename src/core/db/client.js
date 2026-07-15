import { drizzle } from 'drizzle-orm/pg-proxy';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env as cfEnv } from 'cloudflare:workers';
import * as schema from './schema.js';

// Per-request store. Established by Express middleware (src/index.js) and by the cron
// handler (src/worker.js). With the pg-proxy driver there is no socket or pool to
// manage in THIS worker, so the store only memoizes the drizzle instance per request;
// closeRequestDb is retained as a no-op so the request-owner call sites stay intact.
export const dbContext = new AsyncLocalStorage();

// ─── Why this file looks the way it does ────────────────────────────────────────
// This app runs Express on Cloudflare Workers via the `cloudflare:node`
// httpServerHandler bridge. Under that bridge, RAW POSTGRES SOCKETS ARE UNRELIABLE
// no matter the driver or adapter — verified exhaustively against the live worker
// (2026-07-15):
//   • postgres.js hangs on connect (its node:net polyfill starves under the bridge).
//   • node-postgres + pg-cloudflare hangs (dynamic import('cloudflare:sockets')).
//   • A custom static-import cloudflare:sockets adapter mostly worked, but connects
//     raced under concurrency and intermittently hung; every killed mid-connect
//     socket parked a dirty Hyperdrive origin connection until the origin pool
//     (limit 20) wedged and ALL queries timed out for minutes.
// What has never failed under the bridge: plain fetch().
//
// So the database lives behind a SERVICE BINDING: drizzle's pg-proxy driver POSTs
// { sql, params, method } to the dedicated `buildbridge-db` worker (src/db-worker.js
// + wrangler.db.jsonc), which is a plain `export default { fetch }` worker — the one
// documented-working Postgres pattern on Workers — running postgres.js over
// Hyperdrive. Every db.* call site in this app is unchanged.
//
// NOTE: db.transaction() is NOT supported over the stateless proxy (nothing in the
// app uses it today). If transactions become necessary, add a dedicated /transaction
// endpoint on the DB worker that runs the whole unit of work server-side.

async function queryViaDbWorker(sqlText, params, method) {
  const binding = cfEnv.DB_WORKER;
  if (!binding) {
    throw new Error(
      'DB_WORKER service binding missing — deploy buildbridge-db (wrangler.db.jsonc) and bind it in wrangler.jsonc',
    );
  }

  // The URL is arbitrary (service bindings route by binding, not host); the path is
  // kept meaningful for logs. DATABASE_URL is forwarded so the DB worker can connect
  // DIRECT to the Supabase pooler with native TLS (bypassing Hyperdrive's poisoned
  // origin pool); the binding call never leaves Cloudflare's network.
  const res = await binding.fetch('https://buildbridge-db.internal/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: sqlText, params, method, connectionString: cfEnv.DATABASE_URL }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`db-proxy: invalid response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`db-proxy: ${data?.error ?? `HTTP ${res.status}`}`);
  }
  return { rows: data.rows };
}

function buildDb() {
  return drizzle(queryViaDbWorker, { schema });
}

/**
 * Resolve the drizzle instance for the current request (memoized in the request store
 * when one is active). The proxy driver is stateless, so an ephemeral instance is
 * also fine when no store exists.
 */
function getDb() {
  const store = dbContext.getStore();
  if (store) {
    if (!store.drizzle) store.drizzle = buildDb();
    return store.drizzle;
  }
  return buildDb();
}

/**
 * No-op under the pg-proxy driver (no socket/pool lives in this worker). Kept so the
 * request owners (Express res.end patch, cron handler) don't need to change and so a
 * future stateful driver can reintroduce real cleanup here.
 */
export async function closeRequestDb(store) {
  if (store) store.closed = true;
}

// The app-wide db handle. Each top-level access resolves the current request's drizzle
// instance (see getDb). All queries go over the DB_WORKER service binding via fetch.
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const real = getDb();
      const value = real[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  },
);
