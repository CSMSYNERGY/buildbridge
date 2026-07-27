import { Router } from 'express';
import { deposytSignatureVerify } from '../middleware/deposytWebhook.js';
import { isDuplicateEvent } from '../core/webhooks/eventLog.js';
import { handleSubscriptionWebhook } from '../controllers/webhookController.js';
import { handleGhlWebhook } from '../controllers/ghlWebhookController.js';
import { handleIdearoomWebhook } from '../controllers/idearoomWebhookController.js';
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

// POST /webhooks/idearoom/:token — inbound IdeaRoom lead.
// No verifyApiKey: the per-location token IN THE PATH is the credential, because the URL is
// all IdeaRoom's team is given (they cannot be relied on to send a custom header). The
// handler resolves the token to a location, stores the raw body, then pushes to GHL.
// Own idempotency (keyed on IdeaRoom's lead id, else a body hash), so the generic
// idempotencyCheck above — which keys on body.id — is deliberately not used here.
router.post('/idearoom/:token', handleIdearoomWebhook);

export default router;
