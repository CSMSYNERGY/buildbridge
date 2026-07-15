import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { connect } from 'cloudflare:sockets';
import { env as cfEnv } from 'cloudflare:workers';
import { env } from '../env.js';
import * as schema from './schema.js';

// Per-request store. Established by Express middleware (src/index.js) and by the cron
// handler (src/worker.js) so that ONE client is created per request and reused across
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
// What DOES work (verified against the live worker): a STATICALLY-imported
// `cloudflare:sockets` connect(), talking PLAINTEXT to the Hyperdrive local endpoint
// (Hyperdrive terminates origin TLS itself, so we avoid the Workers-native client-TLS
// handshake, which is flaky against the Supabase pooler). So we drive node-postgres
// with a thin static-import socket adapter (CFStream) pointed at Hyperdrive.
//
// Additionally, CONCURRENT connects in one isolate are unreliable (observed live: with
// several near-simultaneous connects, a random victim's socket events are never
// delivered and its connect hangs; the others succeed). Mitigations, both below:
//   1. staggerConnect() spaces connect attempts per isolate.
//   2. ManagedClient retries a timed-out connect on a brand-new socket (race victims
//      recover in ~3s instead of erroring at the watchdog deadline).

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

  // Immediate, unconditional socket teardown (no write flush). Used by the watchdogs:
  // closing the raw socket resolves its `closed` promise → 'close' is emitted → pg
  // rejects any in-flight query with "Connection terminated unexpectedly", turning a
  // would-be infinite hang into a caught error.
  hardClose() {
    this.destroyed = true;
    try { this._sock && this._sock.close(); } catch { /* ignore */ }
  }
}

// Overall per-query deadline. Failing fast matters beyond UX: a query that hangs until
// the Workers runtime cancels the request (~20-30s) vanishes mid-query, leaving
// Hyperdrive's checked-out origin connection dirty. Enough of those and Hyperdrive's
// origin pool (limit 20) wedges — every subsequent query then waits/timeouts ("Timed
// out while waiting for an open slot in the pool"). An orderly early socket close
// avoids creating dirty checkouts.
const QUERY_WATCHDOG_MS = 8000;
// Per-attempt connect deadline (healthy connects are ~200-700ms incl. stagger).
const CONNECT_ATTEMPT_MS = 2500;
const CONNECT_ATTEMPTS = 3;

function destroyRaw(rawClient) {
  try { rawClient?._streamRef?.s?.hardClose(); } catch { /* ignore */ }
}

// Concurrent Postgres connects within one isolate race and hang. Space them out.
// Deliberately a plain module-scope TIMESTAMP, not a shared promise/mutex — awaiting a
// promise that resolves in another request's I/O context is itself a hang on Workers.
let lastConnectAt = 0;
const CONNECT_SPACING_MS = 350;
async function staggerConnect() {
  for (;;) {
    const wait = CONNECT_SPACING_MS - (Date.now() - lastConnectAt);
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 50)));
  }
  lastConnectAt = Date.now();
}

/**
 * Build a raw pg.Client wired to CFStream (Hyperdrive) — not yet connected.
 * A plain Client is used deliberately instead of pg.Pool: pg-pool's acquire machinery
 * relies on internal timers/queues that are starved under the httpServerHandler bridge
 * (observed live: acquires that never settle and a 6s connect-timeout firing at 15s),
 * while a bare Client behaves.
 */
function createRawClient() {
  const hyperConnectionString = cfEnv.HYPERDRIVE?.connectionString;
  // Holds the live CFStream so the watchdogs can hard-close it. A ref object (not a
  // property on `client`) because pg.Client's constructor invokes the stream factory
  // synchronously — before the `client` variable is even assigned.
  const streamRef = { s: null };
  const client = hyperConnectionString
    ? new pg.Client({
        connectionString: hyperConnectionString,
        ssl: false, // Hyperdrive's local endpoint is plaintext; it terminates origin TLS
        stream: () => (streamRef.s = new CFStream()),
      })
    : // Fallback for local Node tooling with no Hyperdrive binding (direct Supabase).
      new pg.Client({
        connectionString: env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
  client._streamRef = streamRef;

  // Swallow connection-level errors so they never bubble up as an unhandled rejection
  // (which on Workers would crash the isolate → Error 1101). Query-level errors still
  // reject their own promises and are handled by callers.
  client.on('error', (err) => console.error('[db client] connection error:', err?.message));
  return client;
}

/**
 * Facade handed to drizzle. Exposes query()/end() like a pg.Client, but resolves its
 * underlying connection lazily with per-attempt timeouts and retries (fresh socket per
 * attempt). All queries — including transaction sequences — run on the ONE client the
 * connect phase settles on, so transaction semantics are preserved: retries only ever
 * happen while connecting, before any query has run.
 */
class ManagedClient {
  constructor() {
    this._current = null; // latest raw client (watchdog/destroy target)
    this._ended = false;
    this._ready = this._connectWithRetry();
    // The rejection is consumed by each query()/end() caller; this guard just prevents
    // an unhandled-rejection crash when a request never runs a query.
    this._ready.catch(() => {});
  }

  async _connectWithRetry() {
    let lastErr;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      if (this._ended) throw new Error('db client ended');
      const raw = createRawClient();
      this._current = raw;
      await staggerConnect();
      let timer;
      try {
        await Promise.race([
          raw.connect(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              destroyRaw(raw);
              reject(new Error(`db connect attempt ${attempt} timeout (${CONNECT_ATTEMPT_MS}ms)`));
            }, CONNECT_ATTEMPT_MS);
          }),
        ]);
        clearTimeout(timer);
        return raw;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        console.error(`[db client] connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed:`, err?.message);
        destroyRaw(raw);
        raw.end().catch(() => {});
      }
    }
    throw lastErr ?? new Error('db connect failed');
  }

  query(...args) {
    // Callback style (unused by drizzle, kept for safety).
    if (typeof args[args.length - 1] === 'function') {
      const cb = args[args.length - 1];
      this._ready.then(
        (raw) => raw.query(...args),
        (err) => cb(err),
      );
      return undefined;
    }
    // Promise style with an overall watchdog: connect (with retries) + execution must
    // finish inside the deadline, else kill the socket and reject — fast, catchable.
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        console.error(`[db client] query watchdog (${QUERY_WATCHDOG_MS}ms) — destroying connection`);
        destroyRaw(this._current);
        reject(new Error(`db query timeout (${QUERY_WATCHDOG_MS}ms)`));
      }, QUERY_WATCHDOG_MS);
    });
    const run = this._ready.then((raw) => raw.query(...args));
    return Promise.race([run, watchdog]).finally(() => clearTimeout(timer));
  }

  async end() {
    this._ended = true;
    try {
      const raw = await Promise.race([
        this._ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (raw) {
        await Promise.race([
          raw.end(),
          new Promise((resolve) => setTimeout(() => { destroyRaw(raw); resolve(); }, 1500)),
        ]);
      } else {
        destroyRaw(this._current);
      }
    } catch {
      destroyRaw(this._current);
    }
  }
}

/**
 * Resolve the drizzle instance for the current request. If a request store is active
 * (Express/cron established it), the client is created once per request and reused; the
 * store's owner closes it when the request ends. Without a store (should not happen for
 * normal traffic), fall back to an ephemeral client.
 */
function getDb() {
  const store = dbContext.getStore();
  if (store) {
    if (!store.drizzle) {
      store.pool = new ManagedClient();
      store.drizzle = drizzle(store.pool, { schema });
    }
    return store.drizzle;
  }
  return drizzle(new ManagedClient(), { schema });
}

/**
 * Close the per-request client held in a store. Idempotent. Call from the request owner
 * (Express res.end patch / 'close' backup, or the cron handler's finally). Bounded
 * internally (ManagedClient.end races a hard destroy), so awaiting it before sending
 * the response adds at most ~3s in the worst case and typically ~1ms.
 */
export async function closeRequestDb(store) {
  if (store && store.pool && !store.closed) {
    store.closed = true;
    try { await store.pool.end(); } catch { /* already closing/closed */ }
  }
}

// The app-wide db handle. Each top-level access resolves the current request's drizzle
// instance (see getDb): one client per request, reused across the request's queries,
// and never shared across requests (Workers forbids cross-request socket I/O).
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
