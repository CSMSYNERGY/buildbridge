import { Router } from 'express';
import { isDuplicateEvent } from '../core/webhooks/eventLog.js';
import { handleDeposytWebhook } from '../controllers/webhookController.js';
import { createError } from '../core/middleware/errorHandler.js';

const router = Router();

/**
 * Idempotency middleware — rejects already-processed events.
 */
async function idempotencyCheck(req, res, next) {
  try {
    const eventId = req.body?.id ?? req.body?.event_id;
    if (!eventId) return next(); // let controller validate

    const duplicate = await isDuplicateEvent(eventId);
    if (duplicate) {
      return res.json({ received: true, duplicate: true });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// POST /webhooks/subscription
router.post('/subscription', idempotencyCheck, handleDeposytWebhook);

export default router;
