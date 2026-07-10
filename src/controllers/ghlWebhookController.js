import { randomUUID } from 'crypto';
import {
  logWebhookEvent,
  markEventProcessed,
  markEventFailed,
  isDuplicateEvent,
} from '../core/webhooks/eventLog.js';
import { dispatchGhlEvent } from '../core/webhooks/ghlDispatcher.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * POST /webhooks/ghl
 * Inbound GHL events (typically sent from a GHL workflow "custom webhook"
 * action configured with our x-api-key header). Expected body:
 *   { eventId?, eventType, locationId, ...payload }
 *
 * eventType examples: 'opportunity.stage_change'
 * If eventId is provided it is used for idempotency; otherwise a UUID is
 * generated (no dedup possible without a stable id).
 */
export async function handleGhlWebhook(req, res, next) {
  const payload = req.body ?? {};
  const eventType = payload.eventType ?? payload.type;
  const locationId = payload.locationId ?? payload.location_id;

  if (!eventType) return next(createError(400, 'Missing eventType in GHL payload'));
  if (!locationId) return next(createError(400, 'Missing locationId in GHL payload'));

  const eventId = payload.eventId ?? payload.event_id ?? randomUUID();

  if (payload.eventId ?? payload.event_id) {
    const duplicate = await isDuplicateEvent(eventId);
    if (duplicate) return res.json({ received: true, duplicate: true });
  }

  try {
    await logWebhookEvent({
      id: eventId,
      source: 'ghl',
      eventType,
      locationId,
      payload,
    });
  } catch (logErr) {
    console.warn('[webhook/ghl] logWebhookEvent error:', logErr.message);
  }

  try {
    const handled = await dispatchGhlEvent(eventType, { locationId, payload });
    await markEventProcessed(eventId);
    res.json({ received: true, handled });
  } catch (err) {
    await markEventFailed(eventId, err).catch(() => {});
    next(err);
  }
}
