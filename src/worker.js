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

// Express `app` is a standard (req, res) handler, so it plugs straight into a
// Node HTTP server. The port is internal to the Worker sandbox — the runtime
// routes incoming fetch events to this listener; it is not a real bound socket.
const PORT = 3000;
const server = createServer(app);
server.listen(PORT);

const nodeHandler = httpServerHandler({ port: PORT });

export default {
  // HTTP traffic → the Express app, via the Node compatibility layer.
  fetch(request, env, ctx) {
    return nodeHandler.fetch(request, env, ctx);
  },

  // Cron Trigger (wrangler.jsonc `triggers.crons`) → run the QBO jobs that the
  // integration modules registered at import time (through ./index.js). This
  // replaces the in-process setInterval scheduler, which the Workers runtime
  // forbids. waitUntil keeps the isolate alive until the jobs settle.
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(runDueJobs());
  },
};
