import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env as cfEnv } from 'cloudflare:workers';
import { requestLogger } from './core/middleware/logger.js';
import { generalLimiter } from './core/middleware/rateLimiter.js';
import { errorHandler } from './core/middleware/errorHandler.js';
import { env } from './core/env.js';
import { eq } from 'drizzle-orm';
import { db, dbContext, closeRequestDb } from './core/db/client.js';
import { integrationCredentials } from './core/db/schema.js';

// Integrations (register webhook handlers + scheduler jobs at import time)
import './integrations/yoderBarnes.js';
import './integrations/rockwood.js';

// Routes
import authRoutes from './routes/authRoutes.js';
import quickbooksRoutes from './routes/quickbooksRoutes.js';
import actionsRoutes from './routes/actionsRoutes.js';
import webApiRoutes from './routes/webApiRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import adminRoutes from './routes/adminRoutes.js';

console.log('[index] All imports resolved. Configuring Express...');
const app = express();

// Trust the Cloudflare proxy (needed for rate limiting and correct IP detection).
// On Workers the real client IP arrives in the CF-Connecting-IP header.
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Monday.com WorkForms embedded by the feedback widget (without this,
      // frame-src falls back to default-src 'self' and the iframe is blocked)
      frameSrc: ['https://forms.monday.com', 'https://*.monday.com'],
      // Allow GHL to embed in an iframe (removes the default 'self' restriction)
      frameAncestors: null,
    },
  },
  // Also disable X-Frame-Options header for iframe embedding
  frameguard: false,
}));

// CORS
app.use(cors({
  origin: env.SMARTBUILD_BASE_URL,
  credentials: true,
}));

// Body parsing — capture rawBody for webhook signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Per-request DB store: one pooled connection per request, created lazily on first DB
// access and closed when the response is sent. Established here (inside Express) so it
// lives in Express's own async context. Must precede any route that touches the DB.
//
// IMPORTANT: cleanup is hooked into res.end (the final step of every send path) rather
// than relying on the 'finish'/'close' events — under the cloudflare:node
// httpServerHandler bridge those events are not guaranteed to fire, and a pool that
// never closes leaks its connection into Hyperdrive's origin pool (limit 20) until the
// pool saturates and every DB request times out. finish/close stay as backups.
app.use((req, res, next) => {
  const store = {};
  const origEnd = res.end.bind(res);
  res.end = function patchedEnd(...args) {
    // Close the request's DB client BEFORE the response goes out. Ordering is load-
    // bearing: once the response is sent, the Workers runtime tears down the request's
    // I/O context, and an in-flight async close never completes — Hyperdrive then sees
    // an abrupt half-closed connection instead of a clean Terminate and parks the
    // dirty origin connection for minutes. Enough of those exhausts its origin pool
    // (limit 20) and every subsequent query in every request times out.
    if (store.pool && !store.closed) {
      console.log('[dbstore] closing request client before response');
      closeRequestDb(store).catch(() => {}).finally(() => origEnd(...args));
      return res;
    }
    return origEnd(...args);
  };
  // Backup for paths that never reach res.end (aborted requests).
  res.once('close', () => closeRequestDb(store));
  dbContext.run(store, () => next());
});

// API responses must never be cached: Express emits ETags and (without an explicit
// Cache-Control) browsers heuristically cache JSON bodies — observed live as a stale
// {config:null} being replayed inside the GHL iframe long after the backend was fixed.
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Logging
app.use(requestLogger);

// Rate limiting
app.use(generalLimiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Deep health check — actually exercises the Postgres/Hyperdrive connection with a
// trivial round-trip, so DB connectivity can be verified without an authenticated
// request. Returns fast on success or failure (never hangs — see the response
// timeout in src/worker.js).
app.get('/health/db', async (_req, res) => {
  const started = Date.now();
  try {
    // One representative probe: parameterized builder select ('all' method) against
    // a real table — the same shape the app's endpoints use.
    const rows = await db.select({ id: integrationCredentials.id })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.appSlug, 'quickbooks'))
      .limit(1);
    res.json({ db: 'ok', ms: Date.now() - started, rows: rows.length });
  } catch (err) {
    console.error('[health/db] DB check failed:', err?.message);
    res.status(500).json({ db: 'error', ms: Date.now() - started, message: err.message });
  }
});

// (Temporary DB-hang diagnostics removed 2026-07-15 — root cause found: socket-based
// PG drivers hang under the cloudflare:node httpServerHandler bridge; fixed in
// core/db/client.js with a static-import cloudflare:sockets adapter over Hyperdrive.)

// API Routes
app.use('/auth', authRoutes);
app.use('/auth/quickbooks', quickbooksRoutes);
app.use('/actions', actionsRoutes);
app.use('/api', webApiRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/admin', adminRoutes);

// Redirect the bare root to the SPA base path, so buildbridge.csmsynergy.com
// opens the app instead of returning a 404 (the SPA is served under /buildbridge).
app.get('/', (_req, res) => res.redirect(302, '/buildbridge/'));

// Serve the React SPA under /buildbridge.
//
// Real static files (the built index.html and /buildbridge/assets/*) are served
// directly by the Workers Static Assets layer (asset-first routing) before this
// Worker runs — see the `assets` binding in wrangler.jsonc. This handler is only
// reached for client-side routes with no matching asset file (e.g. deep links
// like /buildbridge/mappers), where it returns the SPA shell so React Router can
// take over.
async function serveSpaShell(_req, res, next) {
  try {
    const shellUrl = new URL('/buildbridge/index.html', 'https://assets.local');
    const assetRes = await cfEnv.ASSETS.fetch(new Request(shellUrl));
    if (!assetRes.ok) return next();
    const html = await assetRes.text();
    res.status(200).type('html').send(html);
  } catch (err) {
    next(err);
  }
}
app.get('/buildbridge', serveSpaShell);
app.get('/buildbridge/*splat', serveSpaShell);

// Global error handler (must be last)
app.use(errorHandler);

// Note: no app.listen() here — the Workers entry (src/worker.js) wraps this
// exported app in a Node HTTP server via httpServerHandler.
// Background QBO jobs run via a Cloudflare Cron Trigger — see the `scheduled`
// handler in src/worker.js — rather than an in-process setInterval scheduler
// (setInterval at module scope is disallowed on the Workers runtime).
export default app;
