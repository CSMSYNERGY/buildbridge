import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env as cfEnv } from 'cloudflare:workers';
import { env } from '../env.js';
import * as schema from './schema.js';

// The postgres.js client performs disallowed operations (timers/random) in its
// constructor, which Workers forbids in global scope. So we build the drizzle
// instance lazily on first use — which always happens inside a request handler —
// and memoize it. Callers keep importing `db` and using it exactly as before.
let _db;

function initDb() {
  // On Workers we connect through the Hyperdrive binding, which pools connections
  // near the origin and terminates TLS to Supabase itself — so the driver talks
  // to Hyperdrive's local endpoint (no client-side SSL). Fall back to DATABASE_URL
  // for local Node tooling (e.g. the migrate script) where no binding is present.
  const connectionString = cfEnv.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  const viaHyperdrive = Boolean(cfEnv.HYPERDRIVE?.connectionString);

  const client = postgres(connectionString, {
    // Workers cap concurrent external connections per request; Hyperdrive pools
    // the rest, so keep the local pool small.
    max: 5,
    // No array types in the schema — skip the extra type-introspection round-trip.
    fetch_types: false,
    // Supabase's transaction pooler (port 6543, PgBouncer transaction mode) does
    // not support session-level prepared statements — disable them.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    // Hyperdrive handles origin TLS; connecting directly still needs SSL.
    ssl: viaHyperdrive ? false : { rejectUnauthorized: false },
  });

  return drizzle(client, { schema });
}

function getDb() {
  if (!_db) _db = initDb();
  return _db;
}

// Lazy proxy: constructing the real client is deferred until the first property
// access (e.g. db.select(...), db.query.plans, db.transaction(...)), which occurs
// within a request handler rather than at module load.
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
