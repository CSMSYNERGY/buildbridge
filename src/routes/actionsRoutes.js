import { Router } from 'express';
import { verifyApiKey, checkSubscription } from '../core/ghl/middleware.js';
import { requireAuth } from '../core/auth/jwt.js';
import { actionLimiter } from '../core/middleware/rateLimiter.js';
import {
  retrieveSmartBuildJob,
  createOrEditSmartBuildJob,
  updateOpportunity,
  getMappers,
  triggerQuickBooksSync,
} from '../controllers/actionsController.js';

const router = Router();

// QuickBooks sync trigger — gated by a QuickBooks (not SmartBuild) subscription,
// so it is mounted before the router-level SmartBuild gate below.
router.post(
  '/quickbooks-sync',
  verifyApiKey,
  requireAuth,
  checkSubscription('quickbooks'),
  actionLimiter,
  triggerQuickBooksSync,
);

// All remaining action routes require a valid API key and an active SmartBuild subscription
router.use(verifyApiKey, requireAuth, checkSubscription('smartbuild'), actionLimiter);

router.post('/retrieve-smartbuild-job', retrieveSmartBuildJob);
router.post('/create-or-edit-smartbuild-job', createOrEditSmartBuildJob);
router.post('/update-opportunity', updateOpportunity);
router.get('/get-mappers', getMappers);

export default router;
