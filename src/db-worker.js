// buildbridge-db — dedicated database worker.
//
// WHY THIS EXISTS: the main worker runs Express via the `cloudflare:node`
// httpServerHandler bridge, and under that bridge raw Postgres sockets are
// unreliable no matter the driver or adapter. This worker exists to own DB access
// away from the bridge; the main worker reaches it through a SERVICE BINDING
// (env.DB_WORKER) with drizzle's pg-proxy protocol: { sql, params, method }.
//
// TRANSPORT (hard-won, all verified live against this exact stack):
//   PRIMARY — the `sql-exec` Supabase edge function over HTTPS fetch. It runs
//   inside Supabase's own infrastructure (local DB connection), and fetch from
//   Workers never fails. Auth: Supabase anon JWT (transport) + proof-of-secret
//   (the DATABASE_URL password, forwarded by the main worker; the function
//   compares it against its own SUPABASE_DB_URL).
//   FALLBACK — node-postgres over Hyperdrive. Works when Hyperdrive's shared
//   origin pool is healthy, but the pool wedges for long periods once poisoned
//   by aborted queries — which is why it is no longer primary.
//   NOT VIABLE — postgres.js (parameterized queries hang through Hyperdrive→
//   Supavisor with any prepare setting; its node:tls also fails direct);
//   direct Workers→Supavisor TLS (native handshake fails, incl. via pg).
//
// SECURITY: this worker has NO routes and workers_dev=false — it is unreachable
// from the internet and can only be invoked via the service binding.
import pg from 'pg';

const SQL_EXEC_URL = 'https://akiszbinlwxuekncdyze.supabase.co/functions/v1/sql-exec';
// Supabase anon key — public by design (transport-level JWT for the edge function;
// the real gate is the DATABASE_URL password proof).
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFraXN6YmlubHd4dWVrbmNkeXplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MzcwMDMsImV4cCI6MjA4OTExMzAwM30.Px6gcZ5zZgeVb99Wh9zDL2Ik_6146QKrDS-y2mtFW_4';

const EDGE_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 6000;
const CONNECT_ATTEMPT_MS = 3000;
const CONNECT_ATTEMPTS = 2;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Primary path: the sql-exec edge function inside Supabase. */
async function runViaEdge({ sql, params, method, connectionString }) {
  const res = await withTimeout(
    fetch(SQL_EXEC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ sql, params, method, connectionString }),
    }),
    EDGE_TIMEOUT_MS,
    `edge sql-exec timeout (${EDGE_TIMEOUT_MS}ms)`,
  );

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`edge sql-exec: invalid response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`edge sql-exec: ${data?.error ?? `HTTP ${res.status}`}`);
  return data.rows;
}

/** Fallback path: node-postgres over Hyperdrive (healthy-pool days only). */
async function runViaHyperdrive(env, { sql, params, method }, clients) {
  let client;
  let lastErr;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    const candidate = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    clients.push(candidate);
    try {
      await withTimeout(candidate.connect(), CONNECT_ATTEMPT_MS, `connect attempt ${attempt} timeout`);
      client = candidate;
      break;
    } catch (err) {
      lastErr = err;
      candidate.end().catch(() => {});
    }
  }
  if (!client) throw lastErr ?? new Error('db connect failed');

  const result = await withTimeout(
    client.query(
      method === 'all'
        ? { text: sql, values: params ?? [], rowMode: 'array' }
        : { text: sql, values: params ?? [] },
    ),
    QUERY_TIMEOUT_MS,
    `db query timeout (${QUERY_TIMEOUT_MS}ms)`,
  );
  return result.rows;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'POST only' }, { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const { sql, params, method, connectionString } = body ?? {};
    if (typeof sql !== 'string' || !sql.length) {
      return Response.json({ error: 'missing sql' }, { status: 400 });
    }

    const clients = [];
    try {
      let rows;
      if (connectionString) {
        try {
          rows = await runViaEdge({ sql, params, method, connectionString });
        } catch (edgeErr) {
          // Edge unavailable → try Hyperdrive. SELECT-only there? The edge attempt
          // sent no query on failure paths that matter (timeouts are edge-side
          // transport); a duplicated WRITE is possible only if the edge executed
          // and the response was lost — accept that narrow risk for availability.
          console.error('[db-worker] edge path failed, falling back to Hyperdrive:', edgeErr?.message);
          rows = await runViaHyperdrive(env, { sql, params, method }, clients);
        }
      } else {
        rows = await runViaHyperdrive(env, { sql, params, method }, clients);
      }

      return Response.json({ rows });
    } catch (err) {
      console.error('[db-worker] query failed:', err?.message);
      return Response.json({ error: err?.message ?? 'query failed' }, { status: 500 });
    } finally {
      ctx.waitUntil(Promise.allSettled(clients.map((c) => c.end())));
    }
  },
};
