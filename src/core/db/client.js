import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { connect } from 'cloudflare:sockets';
import { env as cfEnv } from 'cloudflare:workers';
import { env } from '../env.js';
import * as schema from './schema.js';

// Per-request store. Established by Express middleware (src/index.js) and by the cron
// handler (src/worker.js) so that ONE pool is created per request and reused across
// that request's queries, then closed when the request ends. Set inside Express (not
// at the Worker level), so it stays within Express's own async context and does not
// depend on ALS propagating through the cloudflare:node httpServerHandler bridge.
export const dbContext = new AsyncLocalStorage();

// ─── Why this file looks the way it does ────────────────────────────────────────
// This app runs Express on Cloudflare Workers via the `cloudflare:node`
// httpServerHandler bridge. Under that bridge, BOTH Postgres socket paths that the
// popular drivers use hang forever on connect:
//   • postgres.js uses `node:net`, whose nodejs_compat polyfill hangs under the bridge.
//   • node-postgres's bundled `pg-cloudflare` socket does a *dynamic*
//     `await import('cloudflare:sockets')` inside connect(), which also hangs there.
// A hung connect never resolves, so the request rides out to the ~30s runtime
// hang-cancel and returns an opaque Error 1101.
//
// What DOES work reliably (verified against the live worker): a STATICALLY-imported
// `cloudflare:sockets` connect(), talking PLAINTEXT to the Hyperdrive local endpoint
// (Hyperdrive terminates origin TLS itself, so we avoid the Workers-native client-TLS
// handshake, which is flaky against the Supabase pooler). So we drive node-postgres
// with a thin static-import socket adapter (CFStream) pointed at Hyperdrive.

/**
 * pg-compatible socket built on the statically-imported cloudflare:sockets connect().
 * Mirrors node-postgres's expected stream surface (connect/write/end + connect/data/
 * close/error events). Plaintext only — the Hyperdrive local endpoint is plaintext.
 */
class CFStream extends EventEmitter {
  constructor() {
    super();
    this.writable = false;
    this.destroyed = false;
    this._sock = null;
    this._w = null;
    this._r = null;
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }

  async connect(port, host, cb) {
    try {
      if (cb) this.once('connect', cb);
      this._sock = connect(`${host}:${port}`);
      this._w = this._sock.writable.getWriter();
      this._sock.closed.then(() => { this._sock = null; this.emit('close'); }).catch((e) => this.emit('error', e));
      this._r = this._sock.readable.getReader();
      this._read();
      await this._w.ready;
      this.writable = true;
      this.emit('connect');
    } catch (e) {
      this.emit('error', e);
    }
    return this;
  }

  async _read() {
    try {
      for (;;) {
        const { done, value } = await this._r.read();
        if (done) { this.emit('close'); break; }
        this.emit('data', Buffer.from(value));
      }
    } catch (e) {
      this.emit('error', e);
    }
  }

  write(data, enc = 'utf8', cb = () => {}) {
    if (!data || data.length === 0) return cb();
    if (typeof data === 'string') data = Buffer.from(data, enc);
    this._w.write(data).then(() => cb(), (err) => cb(err));
    return true;
  }

  end(data = Buffer.alloc(0), enc = 'utf8', cb = () => {}) {
    this.write(data, enc, () => { try { this._sock && this._sock.close(); } catch { /* ignore */ } if (cb) cb(); });
    return this;
  }

  destroy() { this.destroyed = true; return this.end(); }
}

/**
 * Create a fresh pg CLIENT (with the CFStream socket on Workers) and start connecting
 * immediately. A plain Client is used deliberately instead of pg.Pool: pg-pool's
 * acquire machinery relies on internal timers/queues that are starved under the
 * httpServerHandler bridge (observed live: acquires that never settle and a 6s
 * connect-timeout firing at 15s), while a bare Client connects reliably. node-postgres
 * queues queries issued while the connection is still being established, so callers
 * can use the client right away.
 */
function createClient() {
  const hyperConnectionString = cfEnv.HYPERDRIVE?.connectionString;
  const client = hyperConnectionString
    ? new pg.Client({
        connectionString: hyperConnectionString,
        ssl: false, // Hyperdrive's local endpoint is plaintext; it terminates origin TLS
        stream: () => new CFStream(), // static-import socket adapter (see note above)
      })
    : // Fallback for local Node tooling with no Hyperdrive binding (direct Supabase).
      new pg.Client({
        connectionString: env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });

  // Swallow connection-level errors so they never bubble up as an unhandled rejection
  // (which on Workers would crash the isolate → Error 1101). Query-level errors still
  // reject their own promises and are handled by callers.
  client.on('error', (err) => console.error('[db client] connection error:', err?.message));

  // Kick off the connect; queries issued meanwhile are queued by node-postgres and
  // flushed once connected. A connect failure rejects the queued queries too, so the
  // error surfaces through the normal caller path.
  client.connect().catch((err) => console.error('[db client] connect failed:', err?.message));
  return client;
}

/**
 * Resolve the drizzle instance for the current request. If a request store is active
 * (Express/cron established it), the pool is created once per request and reused; the
 * store's owner closes it when the request ends. Without a store (should not happen for
 * normal traffic), fall back to an ephemeral pool.
 */
function getDb() {
  const store = dbContext.getStore();
  if (store) {
    if (!store.drizzle) {
      store.pool = createClient();
      store.drizzle = drizzle(store.pool, { schema });
    }
    return store.drizzle;
  }
  return drizzle(createClient(), { schema });
}

/**
 * Close the per-request client held in a store. Idempotent. Call from the request owner
 * (Express res.end patch / 'finish'/'close', or the cron handler's finally).
 */
export async function closeRequestDb(store) {
  if (store && store.pool && !store.closed) {
    store.closed = true;
    try { await store.pool.end(); } catch { /* already closing/closed */ }
  }
}

// The app-wide db handle. Each top-level access resolves the current request's drizzle
// instance (see getDb): one pool per request, reused across the request's queries, and
// never shared across requests (Workers forbids cross-request socket I/O).
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
