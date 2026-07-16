import { randomUUID } from 'crypto';
import {
  logWebhookEvent,
  markEventProcessed,
  markEventFailed,
  isDuplicateEvent,
} from '../core/webhooks/eventLog.js';
import { dispatchIdearoomEvent } from '../core/webhooks/idearoomDispatcher.js';
import { createError } from '../core/middleware/errorHandler.js';
import { env } from '../core/env.js';

/**
 * PROVISIONAL webhook authentication. IdeaRoom's outbound webhook signing scheme
 * is not documented publicly (see docs/idearoom-integration.md §9) — confirm it
 * with IdeaRoom support / a captured request, then tighten this to match.
 *
 * Behavior for now:
 *  - If IDEAROOM_WEBHOOK_SECRET is set, require it via the `x-idearoom-secret`
 *    header or a `?token=` query param, and reject mismatches.
 *  - If unset, allow through with a warning so we can validate against real
 *    payloads before the scheme is finalized.
 */
export function verifyIdearoomWebhook(req, _res, next) {
  const configured = env.IDEAROOM_WEBHOOK_SECRET;
  if (!configured) {
    console.warn('[webhook/idearoom] IDEAROOM_WEBHOOK_SECRET not set — accepting unverified webhook (provisional)');
    return next();
  }
  const provided = req.get('x-idearoom-secret') ?? req.query.token;
  if (provided !== configured) return next(createError(401, 'Invalid IdeaRoom webhook secret'));
  next();
}

/**
 * POST /webhooks/idearoom/:locationId
 * Inbound IdeaRoom configurator events. The GHL locationId comes from the URL
 * (each client's IdeaRoom account is pointed at its own per-location URL), since
 * the IdeaRoom payload has no GHL locationId — only a `clientId`.
 *
 * Idempotency key = idearoom_<locationId>_<hash>_<eventType>. Re-delivery of the
 * same design+event short-circuits; different events (created → updated) still
 * process. Falls back to a random id when no hash is present (no dedup possible).
 */
export async function handleIdearoomWebhook(req, res, next) {
  const locationId = req.params.locationId;
  const payload = req.body ?? {};
  const eventType = (payload.eventType ?? payload.event_type ?? '').toString().toLowerCase();

  if (!locationId) return next(createError(400, 'Missing locationId in IdeaRoom webhook URL'));
  if (!eventType) return next(createError(400, 'Missing eventType in IdeaRoom payload'));

  const hash = payload.hash ?? payload.order?.uuid ?? null;
  const eventId = hash ? `idearoom_${locationId}_${hash}_${eventType}` : randomUUID();

  if (hash) {
    const duplicate = await isDuplicateEvent(eventId);
    if (duplicate) return res.json({ received: true, duplicate: true });
  }

  try {
    await logWebhookEvent({ id: eventId, source: 'idearoom', eventType, locationId, payload });
  } catch (logErr) {
    console.warn('[webhook/idearoom] logWebhookEvent error:', logErr.message);
  }

  try {
    const handled = await dispatchIdearoomEvent(eventType, { locationId, payload });
    await markEventProcessed(eventId);
    res.json({ received: true, handled });
  } catch (err) {
    await markEventFailed(eventId, err).catch(() => {});
    next(err);
  }
}
