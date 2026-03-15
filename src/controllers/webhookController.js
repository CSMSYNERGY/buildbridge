import {
  logWebhookEvent,
  markEventProcessed,
  markEventFailed,
} from '../core/webhooks/eventLog.js';
import {
  createSubscription,
  updateSubscription,
  cancelSubscription,
  pauseSubscription,
} from '../services/subscriptionService.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * POST /webhooks/subscription
 * Entry point after deposytSignatureVerify → idempotencyCheck middleware.
 */
export async function handleSubscriptionWebhook(req, res, next) {
  const payload = req.body;
  const eventId = payload?.id ?? payload?.event_id;
  const eventType = payload?.type ?? payload?.event_type;

  if (!eventId || !eventType) {
    return next(createError(400, 'Missing event id or type in Deposyt payload'));
  }

  const locationId = extractLocationId(payload);

  try {
    await logWebhookEvent({
      id: eventId,
      source: 'deposyt',
      eventType,
      locationId,
      payload,
    });
  } catch (logErr) {
    // If logging fails due to a duplicate key the idempotency check should have caught it;
    // log a warning but continue so we return 200 and don't prompt Deposyt to retry.
    console.warn('[webhook] logWebhookEvent error:', logErr.message);
  }

  try {
    await processSubscriptionEvent(eventType, payload);
    await markEventProcessed(eventId);
  } catch (err) {
    await markEventFailed(eventId, err).catch(() => {});
    return next(err);
  }

  res.json({ received: true });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function extractLocationId(payload) {
  return (
    payload?.data?.subscription?.metadata?.locationId ??
    payload?.subscription?.metadata?.locationId ??
    payload?.metadata?.locationId ??
    null
  );
}

function extractSub(payload) {
  const sub = payload?.data?.subscription ?? payload?.subscription;
  if (!sub) throw new Error('No subscription object in Deposyt payload');
  return sub;
}

async function processSubscriptionEvent(eventType, payload) {
  const sub = extractSub(payload);

  const {
    id: deposytSubId,
    plan_id: planId,
    status,
    current_period_start,
    current_period_end,
    canceled_at,
    metadata,
  } = sub;

  const locationId = metadata?.locationId;

  switch (eventType) {
    case 'recurring.subscription.add':
      await createSubscription(
        locationId,
        deposytSubId,
        planId,
        current_period_end ? new Date(current_period_end * 1000) : null,
      );
      break;

    case 'recurring.subscription.update':
      await updateSubscription(deposytSubId, {
        status: status ?? 'active',
        planId,
        currentPeriodStart: current_period_start ? new Date(current_period_start * 1000) : undefined,
        currentPeriodEnd: current_period_end ? new Date(current_period_end * 1000) : undefined,
      });
      break;

    case 'recurring.subscription.delete':
      await cancelSubscription(deposytSubId);
      break;

    case 'recurring.subscription.pause':
      await pauseSubscription(deposytSubId);
      break;

    default:
      console.warn(`[deposyt] Unhandled event type: ${eventType}`);
  }
}

/**
 * Re-process a stored webhook event payload.
 * Used by the admin replay endpoint.
 */
export async function reprocessEventPayload(eventId, payload) {
  const eventType = payload?.type ?? payload?.event_type;
  if (!eventType) throw new Error('Cannot determine event type from stored payload');

  await processSubscriptionEvent(eventType, payload);
  await markEventProcessed(eventId);
}
