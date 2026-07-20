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
  getMappers,
  createMapper,
  updateMapper,
  deleteMapper,
  getSmartBuildConfig,
  saveSmartBuildConfig,
  deleteSmartBuildConfig,
  testSmartBuildConnection,
} from '../controllers/webApiController.js';
import {
  getQuickBooksConfig,
  disconnectQuickBooks,
  getQuickBooksSettings,
  saveQuickBooksSettings,
  getQuickBooksFields,
  getQuickBooksItems,
} from '../controllers/quickbooksController.js';

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

router.get('/me', getMe);
router.get('/subscription/mine', getMySubscriptions);
router.post('/subscription/create', actionLimiter, createSubscriptionHandler);
router.delete('/subscription/cancel', actionLimiter, cancelSubscriptionHandler);

// GHL fields + pipelines
router.get('/ghl/fields', getGhlFields);
router.get('/ghl/pipelines', getGhlPipelines);

// Mappers CRUD
router.get('/mappers', getMappers);
router.post('/mappers', actionLimiter, createMapper);
router.put('/mappers/:id', actionLimiter, updateMapper);
router.delete('/mappers/:id', actionLimiter, deleteMapper);

// SmartBuild integration config
router.get('/smartbuild/config', getSmartBuildConfig);
router.post('/smartbuild/config', actionLimiter, saveSmartBuildConfig);
router.delete('/smartbuild/config', actionLimiter, deleteSmartBuildConfig);
router.post('/smartbuild/test', actionLimiter, testSmartBuildConnection);

// QuickBooks integration config (OAuth connect/callback live under /auth/quickbooks)
router.get('/quickbooks/config', getQuickBooksConfig);
router.delete('/quickbooks/config', actionLimiter, disconnectQuickBooks);

// QuickBooks per-tenant feature settings (two-way sync / milestone invoicing)
router.get('/quickbooks/settings', getQuickBooksSettings);
router.put('/quickbooks/settings', actionLimiter, saveQuickBooksSettings);
// QuickBooks company custom fields (for the field-mapper dropdown)
router.get('/quickbooks/fields', getQuickBooksFields);
// QuickBooks company items / products & services (for the item-mapper dropdown)
router.get('/quickbooks/items', getQuickBooksItems);

export default router;
