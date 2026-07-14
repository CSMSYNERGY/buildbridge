// Cloudflare Workers entry point.
//
// Runs the existing Express app unchanged on the Workers runtime via the
// Node.js HTTP server compatibility layer (`httpServerHandler` from
// `cloudflare:node`). Requires `nodejs_compat` + compatibility_date >= 2025-09-01
// (see wrangler.jsonc).
//
// Import order matters: the env bridge must run before ./index.js is evaluated,
// because index.js -> core/env.js runs envalid against process.env at import time.
import './core/cf-env-bridge.js';

import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import app from './index.js';
import { runDueJobs } from './core/scheduler.js';
import { dbContext, closeRequestDb } from './core/db/client.js';

// Express `app` is a standard (req, res) handler, so it plugs straight into a
// Node HTTP server. The port is internal to the Worker sandbox — the runtime
// routes incoming fetch events to this listener; it is not a real bound socket.
const PORT = 3000;
const server = createServer(app);
server.listen(PORT);

const nodeHandler = httpServerHandler({ port: PORT });

// Safety net: never let a hung handler (e.g. a stalled DB connection) ride out to
// the runtime's ~30s hang-cancel, which surfaces to users as an opaque Error 1101.
// If the app hasn't produced a response within this budget, return a fast, observable
// 503 instead. Comfortably under the runtime cancel, comfortably over any real request.
const RESPONSE_TIMEOUT_MS = 20000;

export default {
  // HTTP traffic → the Express app, via the Node compatibility layer.
  fetch(request, env, ctx) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[worker] Response timeout after ${RESPONSE_TIMEOUT_MS}ms: ${request.method} ${request.url}`);
        resolve(
          new Response(JSON.stringify({ error: 'Upstream timeout' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }, RESPONSE_TIMEOUT_MS);
    });

    return Promise.race([nodeHandler.fetch(request, env, ctx), timeout]).finally(() =>
      clearTimeout(timer),
    );
  },

  // Cron Trigger (wrangler.jsonc `triggers.crons`) → run the QBO jobs that the
  // integration modules registered at import time (through ./index.js). This
  // replaces the in-process setInterval scheduler, which the Workers runtime
  // forbids. waitUntil keeps the isolate alive until the jobs settle.
  async scheduled(_event, _env, ctx) {
    // Establish a per-run DB store (like the Express middleware) so the cron jobs get a
    // single pooled connection that is closed when the run finishes.
    const store = {};
    ctx.waitUntil(
      dbContext.run(store, async () => {
        try {
          await runDueJobs();
        } finally {
          await closeRequestDb(store);
        }
      }),
    );
  },
};
