import { Router } from 'express';
import { requireAuth } from '../core/auth/jwt.js';
import { ghlSsoController } from '../core/auth/sso.js';
import { authLimiter, actionLimiter } from '../core/middleware/rateLimiter.js';
import {
  getMe,
  getPlans,
  createSubscriptionHandler,
  cancelSubscriptionHandler,
  getGhlFields,
  getMappers,
  createMapper,
  updateMapper,
  deleteMapper,
  getSmartBuildConfig,
  saveSmartBuildConfig,
  testSmartBuildConnection,
} from '../controllers/webApiController.js';

const router = Router();

// ─── Public (no auth) ─────────────────────────────────────────────────────────

// GET|POST /api/sso/decrypt — GHL SSO entry point (issues cookie, redirects to /buildbridge)
router.get('/sso/decrypt', authLimiter, ghlSsoController);
router.post('/sso/decrypt', authLimiter, ghlSsoController);

// ─── Protected ────────────────────────────────────────────────────────────────

router.use(requireAuth);

router.get('/me', getMe);
router.get('/subscription/plans', getPlans);
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
router.post('/smartbuild/test', actionLimiter, testSmartBuildConnection);

export default router;
