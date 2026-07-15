// buildbridge-db — dedicated database worker.
//
// WHY THIS EXISTS: the main worker runs Express via the `cloudflare:node`
// httpServerHandler bridge, and under that bridge raw Postgres sockets are
// unreliable no matter the driver or adapter (connects intermittently hang, and
// each killed mid-connect socket parks a dirty Hyperdrive origin connection until
// the pool wedges). The ONLY documented-working Postgres pattern on Workers is a
// plain `export default { fetch }` worker — which is exactly what this is.
//
// The main worker reaches this one through a SERVICE BINDING (env.DB_WORKER) and
// drizzle's pg-proxy driver: it POSTs { sql, params, method } here, we execute over
// Hyperdrive in a normal Workers context, and return the rows. Plain `fetch` from
// the bridge is rock-solid, so the main worker never touches a database socket.
//
// DRIVER CHOICE (hard-won, all verified live against this exact stack):
//   • node-postgres (`pg`) — WORKS. This is the driver Cloudflare's Hyperdrive
//     get-started uses; in a plain worker its pg-cloudflare socket works fine.
//   • postgres.js — its no-param queries work, but parameterized queries hang
//     through the Hyperdrive→Supavisor(transaction-mode) chain with prepare:true
//     AND prepare:false. Do not switch back.
//   • Direct worker→Supavisor TLS (bypassing Hyperdrive) — native TLS handshake
//     fails from Workers (0/20). Hyperdrive must stay in the path; it terminates
//     origin TLS from its own infrastructure.
//
// SECURITY: this worker has NO routes and workers_dev=false — it is unreachable
// from the internet and can only be invoked via the service binding.
import pg from 'pg';

const QUERY_TIMEOUT_MS = 6000;
const CONNECT_ATTEMPT_MS = 3000;
const CONNECT_ATTEMPTS = 2;
// SELECTs may be retried once on a fresh client (reads are side-effect-free).
// In Hyperdrive's transaction pooling the origin connection is assigned per QUERY,
// so a retry draws a different pooled connection — dodging a dirty one.
const SELECT_RETRIES = 1;

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

    const { sql, params, method } = body ?? {};
    if (typeof sql !== 'string' || !sql.length) {
      return Response.json({ error: 'missing sql' }, { status: 400 });
    }

    // Cloudflare's canonical Hyperdrive pattern: a pg Client created inside the
    // handler. Hyperdrive pools the real origin connections, so per-request
    // connects are cheap (~200ms) and Hyperdrive terminates origin TLS itself.
    // CONNECT-PHASE RETRY: a connect occasionally hangs when it draws a dirty
    // pooled origin connection (leftovers from past mid-query aborts). Retrying a
    // connect is always safe — no query has been sent yet — so hang → abandon the
    // client → fresh client. Queries themselves are NOT retried (a timed-out
    // write may have actually applied; retrying could double-apply).
    const clients = [];
    async function connectWithRetry() {
      let lastErr;
      for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
        const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
        clients.push(client);
        try {
          await Promise.race([
            client.connect(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`connect attempt ${attempt} timeout (${CONNECT_ATTEMPT_MS}ms)`)), CONNECT_ATTEMPT_MS),
            ),
          ]);
          return client;
        } catch (err) {
          lastErr = err;
          console.error(`[db-worker] connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed:`, err?.message);
          client.end().catch(() => {});
        }
      }
      throw lastErr ?? new Error('db connect failed');
    }

    // drizzle pg-proxy contract: method 'all' expects rows as ARRAYS (rowMode
    // array); anything else ('execute') expects row OBJECTS.
    const queryConfig =
      method === 'all'
        ? { text: sql, values: params ?? [], rowMode: 'array' }
        : { text: sql, values: params ?? [] };

    async function runOnce() {
      const client = await connectWithRetry();
      const result = await Promise.race([
        client.query(queryConfig),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`db query timeout (${QUERY_TIMEOUT_MS}ms)`)), QUERY_TIMEOUT_MS),
        ),
      ]);
      return result.rows;
    }

    const isSelect = /^\s*select\b/i.test(sql);

    try {
      let rows;
      try {
        rows = await runOnce();
      } catch (firstErr) {
        // Only reads are retried: a timed-out WRITE may have actually applied
        // server-side (observed live), so re-running it could double-apply.
        if (!isSelect || SELECT_RETRIES < 1) throw firstErr;
        console.error('[db-worker] retrying SELECT after:', firstErr?.message);
        rows = await runOnce();
      }

      return Response.json({ rows });
    } catch (err) {
      console.error('[db-worker] query failed:', err?.message);
      return Response.json({ error: err?.message ?? 'query failed' }, { status: 500 });
    } finally {
      // Dispose all clients without delaying the response; Hyperdrive keeps the
      // origin connections pooled.
      ctx.waitUntil(Promise.allSettled(clients.map((c) => c.end())));
    }
  },
};
