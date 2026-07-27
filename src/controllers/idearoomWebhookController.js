import { claimWebhookEvent, markEventProcessed, markEventFailed } from '../core/webhooks/eventLog.js';
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

/**
 * Interpret the raw body. The route takes bytes (see the express.raw mount in index.js),
 * so parsing happens here where a failure can still be CAPTURED rather than rejected by
 * body-parser with a 400 before the handler ever runs.
 *
 * Order: JSON (what IdeaRoom sends) → form-encoded → keep the bytes verbatim. The last
 * branch is the point of doing this at all: a body we cannot parse is still stored, so a
 * truncated or double-encoded delivery is diagnosable instead of vanishing.
 */
function parseInbound(body) {
  if (Buffer.isBuffer(body)) {
    const raw = body.toString('utf8');
    const trimmed = raw.trim();
    if (!trimmed) return { payload: {}, note: 'empty_body' };
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return { payload: parsed };
      } catch {
        // fall through — keep the bytes below rather than 400ing the sender
      }
    }
    if (trimmed.includes('=')) {
      try {
        const obj = {};
        for (const [k, v] of new URLSearchParams(trimmed)) obj[k] = v;
        if (Object.keys(obj).length) return { payload: obj, note: 'form_encoded' };
      } catch { /* fall through */ }
    }
    // Truncate defensively: the column is jsonb, and an unbounded blob is not worth
    // storing in full to diagnose a malformed sender.
    return { payload: { _raw: raw.slice(0, 100000) }, note: 'unparsed_body' };
  }
  // Already an object (another parser won the route, or a direct internal call).
  if (body && typeof body === 'object') return { payload: body };
  return { payload: { _raw: String(body ?? '') }, note: 'unparsed_body' };
}

export async function handleIdearoomWebhook(req, res) {
  const token = req.params?.token;

  // The token lookup is INSIDE the try: it is a DB call, and a transient failure here
  // must return the same retryable 503 as a capture failure. Left outside, the rejection
  // reached Express's error handler as a 500 — a different signal to a sender's retry
  // policy, for the same underlying cause.
  let settings;
  try {
    settings = await resolveByToken(token);
  } catch (err) {
    await recordError({
      source: 'idearoom-webhook', kind: 'idearoom_token_lookup_failed', appSlug: 'idearoom',
      severity: 'fatal', httpStatus: 503, httpMethod: 'POST', path: '/webhooks/idearoom',
      message: `Could not resolve IdeaRoom webhook token: ${err?.message ?? err}`,
      stack: err?.stack, upstream: 'db', context: { stage: 'token_lookup' },
    }).catch(() => {});
    return res.status(503).json({ error: 'Temporarily unable to accept the lead — please retry.' });
  }

  if (!settings) {
    // Deliberately indistinguishable from a wrong path.
    return res.status(404).json({ error: 'Not found' });
  }
  const locationId = settings.locationId;
  const { payload, note } = parseInbound(req.body);

  let eventId;
  try {
    eventId = await eventIdFor(locationId, payload);

    // 1. Capture and claim in one round trip — before we try to understand anything.
    // Record IdeaRoom's own eventType (created/updated/visited/checkout-opened/
    // payment-prepared) so an operator can see which of their triggers point at us.
    const eventType = String(payload?.eventType ?? '').toLowerCase().slice(0, 60) || 'lead';
    const { claimed, alreadyProcessed } = await claimWebhookEvent({
      id: eventId, source: 'idearoom', eventType, locationId, payload,
    });
    if (alreadyProcessed) return res.json({ received: true, duplicate: true });
    // Not claimed and not processed → an earlier attempt left it pending/failed, so this
    // delivery reprocesses it. The raw body is already stored from that attempt.
    void claimed;

    // A body we could not parse is stored (that is the point) but it is still a fault
    // someone has to see — otherwise it looks like a normal unmappable lead forever.
    if (note === 'unparsed_body') {
      await recordError({
        source: 'idearoom-webhook', kind: 'idearoom_unparsable_body', appSlug: 'idearoom',
        severity: 'warn', locationId, httpMethod: 'POST', path: '/webhooks/idearoom',
        message: 'IdeaRoom sent a body that is neither JSON nor form-encoded — stored raw for inspection',
        context: { eventId, contentType: String(req.get('content-type') ?? '(none)').slice(0, 120) },
      }).catch(() => {});
    }
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
