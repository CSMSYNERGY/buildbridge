import { Router } from 'express';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';
import { getLocations, getWebhookEvents } from '../controllers/adminController.js';

const router = Router();

/**
 * Validate the x-admin-key header for internal admin access.
 */
function requireAdminKey(req, _res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== env.X_API_KEY) {
    return next(createError(401, 'Invalid or missing admin key'));
  }
  next();
}

router.use(requireAdminKey);

// GET /admin/locations — all locations with subscription status
router.get('/locations', getLocations);

// GET /admin/webhook-events — recent 50 events
router.get('/webhook-events', getWebhookEvents);

export default router;
