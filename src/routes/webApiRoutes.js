import { Router } from 'express';
import { requireAuth, clearAuthCookie } from '../core/auth/jwt.js';
import { createError } from '../core/middleware/errorHandler.js';
import { ghlSsoController } from '../core/auth/sso.js';
import { authLimiter, actionLimiter } from '../core/middleware/rateLimiter.js';
import {
  getMe,
  getPlans,
  getMySubscriptions,
  createSubscriptionHandler,
  cancelSubscriptionHandler,
  getGhlFields,
  getGhlPipelines,
  getGhlUsers,
  getMappers,
  createMapper,
  updateMapper,
  deleteMapper,
  getSmartBuildConfig,
  saveSmartBuildConfig,
  deleteSmartBuildConfig,
  testSmartBuildConnection,
} from '../controllers/webApiController.js';
import { ingestClientError } from '../controllers/errorLogController.js';
import { ensureLocation } from '../services/locationService.js';
import {
  getQuickBooksConfig,
  getQuickBooksHealth,
  testQuickBooksConnection,
  getMilestoneDefinitions,
  addMilestoneDefinition,
  editMilestoneDefinition,
  removeMilestoneDefinition,
  getQuickBooksConnectUrl,
  disconnectQuickBooks,
  getQuickBooksSettings,
  saveQuickBooksSettings,
  getQuickBooksFields,
  getQuickBooksDocFields,
  getQuickBooksRepValues,
  getQuickBooksItems,
  createSalespersonField,
} from '../controllers/quickbooksController.js';
import {
  getIdearoomSettings,
  saveIdearoomSettings,
  issueIdearoomWebhook,
  getIdearoomLeads,
} from '../controllers/idearoomController.js';

const router = Router();

// ─── Public (no auth) ─────────────────────────────────────────────────────────

// GET|POST /api/sso/decrypt — GHL SSO entry point (issues cookie; GET redirects to
// /buildbridge, POST responds JSON {user, token} for the embedded-iframe handshake)
router.get('/sso/decrypt', authLimiter, ghlSsoController);
router.post('/sso/decrypt', authLimiter, ghlSsoController);

// POST /api/logout — clear the session cookie (the SPA also drops its Bearer token)
router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// Plans are public pricing info, so the Subscription page renders standalone
// (e.g. opened directly, outside the GHL SSO iframe). Subscribing still requires auth.
router.get('/subscription/plans', getPlans);

// POST /api/client-errors — browser-side error ingest. Unauthenticated on purpose:
// crashes during the SSO handshake happen before a session exists, and those are
// the ones most worth seeing. Bounded by the rate limiter + server-side dedupe,
// and `source` is forced to 'frontend' so backend/cron rows can't be forged.
router.post('/client-errors', ingestClientError);

// ─── Protected ────────────────────────────────────────────────────────────────

router.use(requireAuth);

// Every route below is tenant-scoped (uses req.user.locationId). Reject a
// session that carries only a companyId (locationId null) up front rather than
// letting controllers run location-scoped queries against a null id.
router.use((req, _res, next) => {
  if (!req.user?.locationId) {
    return next(createError(400, 'This session has no associated location'));
  }
  next();
});

// Guarantee the tenant's `locations` row exists before any WRITE. The SSO handler
// already does this when a session is minted, but a session issued before that fix
// (or a long-lived cookie) never re-runs SSO — and nearly every table is FK'd to
// locations.id, so the write would 500 on a foreign-key violation. Writes only:
// reads cannot violate the FK, and this costs a DB round-trip.
router.use(async (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  await ensureLocation(req.user.locationId, { companyId: req.user.companyId ?? null });
  next();
});

router.get('/me', getMe);
router.get('/subscription/mine', getMySubscriptions);
router.post('/subscription/create', actionLimiter, createSubscriptionHandler);
router.delete('/subscription/cancel', actionLimiter, cancelSubscriptionHandler);

// GHL fields + pipelines
router.get('/ghl/fields', getGhlFields);
router.get('/ghl/pipelines', getGhlPipelines);
router.get('/ghl/users', getGhlUsers);

// Mappers CRUD
router.get('/mappers', getMappers);
router.post('/mappers', actionLimiter, createMapper);
router.put('/mappers/:id', actionLimiter, updateMapper);
router.delete('/mappers/:id', actionLimiter, deleteMapper);

// IdeaRoom inbound lead webhook: issue/rotate the URL, configure where leads land, and
// inspect raw inbound leads (the webhook itself is public-by-design at /webhooks/idearoom/:token)
router.get('/idearoom/settings', getIdearoomSettings);
router.put('/idearoom/settings', actionLimiter, saveIdearoomSettings);
router.post('/idearoom/webhook', actionLimiter, issueIdearoomWebhook);
router.get('/idearoom/leads', getIdearoomLeads);

// SmartBuild integration config
router.get('/smartbuild/config', getSmartBuildConfig);
router.post('/smartbuild/config', actionLimiter, saveSmartBuildConfig);
router.delete('/smartbuild/config', actionLimiter, deleteSmartBuildConfig);
router.post('/smartbuild/test', actionLimiter, testSmartBuildConnection);

// QuickBooks integration config (OAuth connect/callback live under /auth/quickbooks)
router.get('/quickbooks/config', getQuickBooksConfig);
// Intuit authorize URL for the SPA to open in a new top-level tab (the embedded
// iframe can't navigate itself into OAuth: no Bearer on navigations + Intuit
// refuses framing)
router.get('/quickbooks/connect-url', getQuickBooksConnectUrl);
router.delete('/quickbooks/config', actionLimiter, disconnectQuickBooks);
// Last successful sync + open problems. Split out from /config on purpose: /config is
// polled every 3s during the connect flow and must stay a single query, while this one
// reads qb_sync_state + error_events.
router.get('/quickbooks/health', getQuickBooksHealth);
// On-demand "does this connection actually work right now?" — a real QBO round-trip, so
// it is rate-limited like the other write-ish actions (matches /smartbuild/test above).
router.post('/quickbooks/test', actionLimiter, testQuickBooksConnection);

// QuickBooks per-tenant feature settings (two-way sync / milestone invoicing)
router.get('/quickbooks/settings', getQuickBooksSettings);
router.put('/quickbooks/settings', actionLimiter, saveQuickBooksSettings);
// QuickBooks company custom fields (for the field-mapper dropdown)
router.get('/quickbooks/fields', getQuickBooksFields);
// Estimate/invoice fields the tenant can map, each with a value taken from their own
// most recent documents (replaces the code node behind the Zapier→GHL webhooks)
router.get('/quickbooks/doc-fields', getQuickBooksDocFields);
// Distinct rep values on the company's own documents — the left dropdown of the
// rep → Synergy-user mapping. Frequently option IDs ("1", "2"), which is why the
// mapping exists at all.
router.get('/quickbooks/rep-values', getQuickBooksRepValues);
// Create/enable the legacy "Salesperson" sales-form custom field (QBO's UI no
// longer offers legacy fields; the REST write path is the only way to get an
// API-readable custom field without the tier-gated App Foundations scope)
router.post('/quickbooks/salesperson-field', actionLimiter, createSalespersonField);
// QuickBooks company items / products & services (for the item-mapper dropdown)
router.get('/quickbooks/items', getQuickBooksItems);

// Per-client milestone configuration (migration 0007) — replaces the four hard-coded
// milestone types. Each definition is the client's own (amount field, optional date field)
// pair plus the label that prints on the invoice line.
router.get('/quickbooks/milestones', getMilestoneDefinitions);
router.post('/quickbooks/milestones', actionLimiter, addMilestoneDefinition);
router.put('/quickbooks/milestones/:id', actionLimiter, editMilestoneDefinition);
router.delete('/quickbooks/milestones/:id', actionLimiter, removeMilestoneDefinition);

export default router;
