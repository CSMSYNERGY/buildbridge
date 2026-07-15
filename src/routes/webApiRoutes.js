import { Router } from 'express';
import { requireAuth } from '../core/auth/jwt.js';
import { ghlSsoController } from '../core/auth/sso.js';
import { authLimiter, actionLimiter } from '../core/middleware/rateLimiter.js';
import {
  getMe,
  getPlans,
  getMySubscriptions,
  createSubscriptionHandler,
  cancelSubscriptionHandler,
  getGhlFields,
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
} from '../controllers/quickbooksController.js';

const router = Router();

// ─── Public (no auth) ─────────────────────────────────────────────────────────

// GET|POST /api/sso/decrypt — GHL SSO entry point (issues cookie, redirects to /buildbridge)
router.get('/sso/decrypt', authLimiter, ghlSsoController);
router.post('/sso/decrypt', authLimiter, ghlSsoController);

// Plans are public pricing info, so the Subscription page renders standalone
// (e.g. opened directly, outside the GHL SSO iframe). Subscribing still requires auth.
router.get('/subscription/plans', getPlans);

// ─── Protected ────────────────────────────────────────────────────────────────

router.use(requireAuth);

router.get('/me', getMe);
router.get('/subscription/mine', getMySubscriptions);
router.post('/subscription/create', actionLimiter, createSubscriptionHandler);
router.delete('/subscription/cancel', actionLimiter, cancelSubscriptionHandler);

// GHL fields
router.get('/ghl/fields', getGhlFields);

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

export default router;
