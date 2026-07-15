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
// drizzle's pg-proxy driver: it POSTs { sql, params, method } here, we execute via
// postgres.js over Hyperdrive in a normal Workers context, and return the rows.
// Plain `fetch` from the bridge is rock-solid, so the main worker never touches a
// database socket again.
//
// SECURITY: this worker has NO routes and workers_dev=false — it is unreachable
// from the internet and can only be invoked via the service binding.
import postgres from 'postgres';

const QUERY_TIMEOUT_MS = 8000;

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

    // postgres.js over Hyperdrive, created inside the handler (never module scope).
    // Hyperdrive terminates origin TLS from its own infrastructure — REQUIRED here,
    // because a direct Workers→Supavisor connection fails at the native TLS
    // handshake (verified live: 0/20 with ssl:'require' direct, while Hyperdrive
    // round-trips at ~220ms when its pool is healthy).
    // prepare:false is REQUIRED too: the Hyperdrive origin is Supavisor in
    // transaction mode (port 6543), which does not support prepared statements —
    // with prepare:true, parameterized queries hang while no-param queries work.
    const client = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
      prepare: false,
      connect_timeout: 6,
    });

    try {
      // drizzle pg-proxy contract: method 'all' expects rows as ARRAYS (rowMode
      // array); anything else ('execute') expects row OBJECTS.
      const exec =
        method === 'all'
          ? client.unsafe(sql, params ?? []).values()
          : client.unsafe(sql, params ?? []);

      const rows = await Promise.race([
        exec,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`db query timeout (${QUERY_TIMEOUT_MS}ms)`)), QUERY_TIMEOUT_MS),
        ),
      ]);

      return Response.json({ rows });
    } catch (err) {
      console.error('[db-worker] query failed:', err?.message);
      return Response.json({ error: err?.message ?? 'query failed' }, { status: 500 });
    } finally {
      // Dispose without delaying the response; Hyperdrive keeps the origin pooled.
      ctx.waitUntil(client.end({ timeout: 5 }).catch(() => {}));
    }
  },
};
