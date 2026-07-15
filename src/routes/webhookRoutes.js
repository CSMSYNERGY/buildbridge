import { Router } from 'express';
import { deposytSignatureVerify } from '../middleware/deposytWebhook.js';
import { isDuplicateEvent } from '../core/webhooks/eventLog.js';
import { handleSubscriptionWebhook } from '../controllers/webhookController.js';
import { handleGhlWebhook } from '../controllers/ghlWebhookController.js';
import {
  handleIdearoomWebhook,
  verifyIdearoomWebhook,
} from '../controllers/idearoomWebhookController.js';
import { verifyApiKey } from '../core/ghl/middleware.js';

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

// POST /webhooks/ghl — inbound GHL events (workflow custom webhook w/ x-api-key)
router.post('/ghl', verifyApiKey, handleGhlWebhook);

// POST /webhooks/idearoom/:locationId — inbound IdeaRoom configurator events
router.post('/idearoom/:locationId', verifyIdearoomWebhook, handleIdearoomWebhook);

export default router;
