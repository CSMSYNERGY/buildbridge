import crypto from 'crypto';
import { db } from '../core/db/client.js';
import { subscriptions } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';
import {
  logWebhookEvent,
  markEventProcessed,
  markEventFailed,
} from '../core/webhooks/eventLog.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * Verify Deposyt HMAC-SHA256 webhook signature.
 * Expects header: x-deposyt-signature: sha256=<hex>
 */
function verifyDeposytSignature(req) {
  const sigHeader = req.headers['x-deposyt-signature'];
  if (!sigHeader) throw createError(401, 'Missing Deposyt signature');

  const [, receivedHex] = sigHeader.split('=');
  const rawBody = req.rawBody; // set by express.json verify option

  const expected = crypto
    .createHmac('sha256', env.DEPOSYT_WEBHOOK_SIGNING_KEY)
    .update(rawBody)
    .digest('hex');

  const valid = crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(receivedHex ?? '', 'hex'),
  );

  if (!valid) throw createError(401, 'Invalid Deposyt signature');
}

/**
 * POST /webhooks/subscription
 * Handles Deposyt subscription lifecycle events.
 */
export async function handleDeposytWebhook(req, res, next) {
  try {
    verifyDeposytSignature(req);

    const payload = req.body;
    const eventId = payload?.id ?? payload?.event_id;
    const eventType = payload?.type ?? payload?.event_type;

    if (!eventId || !eventType) {
      throw createError(400, 'Missing event id or type in Deposyt payload');
    }

    await logWebhookEvent({
      id: eventId,
      source: 'deposyt',
      eventType,
      locationId: payload?.metadata?.locationId ?? null,
      payload,
    });

    try {
      await processDeposytEvent(eventType, payload);
      await markEventProcessed(eventId);
    } catch (processingErr) {
      await markEventFailed(eventId, processingErr);
      throw processingErr;
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

async function processDeposytEvent(eventType, payload) {
  const sub = payload?.data?.subscription ?? payload?.subscription;
  if (!sub) throw new Error('No subscription object in payload');

  const {
    id: subscriptionId,
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
      await db
        .insert(subscriptions)
        .values({
          id: subscriptionId,
          locationId,
          planId,
          status: status ?? 'active',
          currentPeriodStart: current_period_start ? new Date(current_period_start * 1000) : null,
          currentPeriodEnd: current_period_end ? new Date(current_period_end * 1000) : null,
        })
        .onConflictDoNothing();
      break;

    case 'recurring.subscription.update':
      await db
        .update(subscriptions)
        .set({
          status: status ?? 'active',
          planId,
          currentPeriodStart: current_period_start ? new Date(current_period_start * 1000) : null,
          currentPeriodEnd: current_period_end ? new Date(current_period_end * 1000) : null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, subscriptionId));
      break;

    case 'recurring.subscription.delete':
      await db
        .update(subscriptions)
        .set({
          status: 'canceled',
          canceledAt: canceled_at ? new Date(canceled_at * 1000) : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, subscriptionId));
      break;

    default:
      console.warn(`[deposyt] Unhandled event type: ${eventType}`);
  }
}
