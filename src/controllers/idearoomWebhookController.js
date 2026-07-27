import { logWebhookEvent, isDuplicateEvent, markEventProcessed, markEventFailed } from '../core/webhooks/eventLog.js';
import { resolveByToken, extractLead, isActionable, pushLeadToGhl, eventKeyFor } from '../services/idearoomService.js';
import { recordError } from '../services/errorLogService.js';

// POST /webhooks/idearoom/:token — inbound IdeaRoom lead.
//
// Contract we owe a third-party sender:
//   * Bad/unknown token → 404. Nothing else leaks (no hint that a token nearly matched).
//   * Anything else → 2xx. A webhook sender retries on 5xx, so returning 500 because OUR
//     field mapping failed would have IdeaRoom hammer us for a bug they cannot fix. The
//     failure is instead recorded on the webhook_events row and in error_events for an
//     operator, and the row stays replayable (a 'failed' row is not treated as a duplicate).
//   * The RAW body is persisted BEFORE any parsing, so even a payload we understand nothing
//     about is captured — that stored traffic is how we learn IdeaRoom's real field names.

/**
 * Stable idempotency key: IdeaRoom's design hash + event + counters when present (see
 * eventKeyFor — their payload carries no timestamp, and the hash alone is stable across
 * created/updated/visited), else a hash of the raw body.
 */
async function eventIdFor(locationId, payload) {
  const key = eventKeyFor(payload);
  if (key) return `idearoom:${locationId}:${key}`;
  const json = JSON.stringify(payload ?? {});
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `idearoom:${locationId}:sha:${hex}`;
}

export async function handleIdearoomWebhook(req, res) {
  const token = req.params?.token;
  const settings = await resolveByToken(token);
  if (!settings) {
    // Deliberately indistinguishable from a wrong path.
    return res.status(404).json({ error: 'Not found' });
  }
  const locationId = settings.locationId;
  const payload = (req.body && typeof req.body === 'object') ? req.body : { _raw: String(req.body ?? '') };

  let eventId;
  try {
    eventId = await eventIdFor(locationId, payload);

    if (await isDuplicateEvent(eventId)) {
      return res.json({ received: true, duplicate: true });
    }

    // 1. Capture first — before we try to understand anything. Record IdeaRoom's own
    // eventType (created/updated/visited/checkout-opened/payment-prepared) so an operator
    // can see which of their five triggers are actually pointed at us.
    const eventType = String(payload?.eventType ?? '').toLowerCase().slice(0, 60) || 'lead';
    await logWebhookEvent({ id: eventId, source: 'idearoom', eventType, locationId, payload });
  } catch (err) {
    // Even the capture failed (DB down). This one IS worth a retry from IdeaRoom.
    await recordError({
      source: 'idearoom-webhook', kind: 'idearoom_capture_failed', appSlug: 'idearoom',
      severity: 'fatal', locationId, httpStatus: 503, httpMethod: 'POST', path: '/webhooks/idearoom',
      message: `Could not record inbound IdeaRoom lead: ${err?.message ?? err}`,
      stack: err?.stack, upstream: 'db', context: { stage: 'capture' },
    }).catch(() => {});
    return res.status(503).json({ error: 'Temporarily unable to accept the lead — please retry.' });
  }

  // 2. Not enabled yet: the lead is safely stored, just not pushed anywhere.
  if (!settings.idearoomEnabled) {
    await markEventFailed(eventId, 'idearoom integration disabled for this location').catch(() => {});
    return res.json({ received: true, stored: true, processed: false, reason: 'integration_disabled' });
  }

  // 3. Push to GHL. Any failure here is recorded, never bounced back as a 5xx.
  try {
    const lead = extractLead(payload);
    if (!isActionable(lead)) {
      await markEventFailed(eventId, 'no email or phone found in payload').catch(() => {});
      await recordError({
        source: 'idearoom-webhook', kind: 'idearoom_unmappable_lead', appSlug: 'idearoom',
        severity: 'warn', locationId, httpMethod: 'POST', path: '/webhooks/idearoom',
        message: 'IdeaRoom lead had no email or phone — check the field mapping',
        // payloadKeys (not values) is what an operator needs to fix the aliases, and it
        // keeps customer data out of the error log.
        context: { eventId, extractedKeys: Object.keys(lead), payloadKeys: Object.keys(payload).slice(0, 40) },
      }).catch(() => {});
      return res.json({ received: true, stored: true, processed: false, reason: 'no_contact_details' });
    }

    const result = await pushLeadToGhl(locationId, payload, settings);
    if (!result.ok) {
      await markEventFailed(eventId, result.reason).catch(() => {});
      await recordError({
        source: 'idearoom-webhook', kind: 'idearoom_push_failed', appSlug: 'idearoom',
        locationId, httpMethod: 'POST', path: '/webhooks/idearoom', upstream: 'ghl',
        message: `IdeaRoom lead not pushed to Synergy: ${result.reason}`,
        context: { eventId, reason: result.reason },
      }).catch(() => {});
      return res.json({ received: true, stored: true, processed: false, reason: result.reason });
    }

    await markEventProcessed(eventId);
    return res.json({
      received: true,
      stored: true,
      processed: true,
      contactId: result.contactId,
      opportunityId: result.opportunityId,
    });
  } catch (err) {
    await markEventFailed(eventId, String(err?.message ?? err).slice(0, 500)).catch(() => {});
    await recordError({
      source: 'idearoom-webhook', kind: 'idearoom_processing_error', appSlug: 'idearoom',
      locationId, httpMethod: 'POST', path: '/webhooks/idearoom', upstream: 'ghl',
      message: `IdeaRoom lead processing failed: ${err?.message ?? err}`,
      stack: err?.stack, context: { eventId },
    }).catch(() => {});
    // Stored + replayable; do not make IdeaRoom retry our bug.
    return res.json({ received: true, stored: true, processed: false, reason: 'processing_error' });
  }
}
