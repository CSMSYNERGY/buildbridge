import { Router } from 'express';
import { deposytSignatureVerify } from '../middleware/deposytWebhook.js';
import { isDuplicateEvent } from '../core/webhooks/eventLog.js';
import { handleSubscriptionWebhook } from '../controllers/webhookController.js';

const router = Router();

/**
 * Idempotency middleware — short-circuits already-processed events.
 */
async function idempotencyCheck(req, res, next) {
  try {
    const eventId = req.body?.id ?? req.body?.event_id;
    if (!eventId) return next();

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
router.post(
  '/subscription',
  deposytSignatureVerify,
  idempotencyCheck,
  handleSubscriptionWebhook,
);

export default router;
