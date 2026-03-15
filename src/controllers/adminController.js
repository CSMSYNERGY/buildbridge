import { db } from '../core/db/client.js';
import { locations, subscriptions, plans, webhookEvents } from '../core/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { reprocessEventPayload } from './webhookController.js';
import { markEventFailed } from '../core/webhooks/eventLog.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * GET /admin/locations
 * Returns all locations with their active subscription plan (if any).
 */
export async function getLocations(_req, res, next) {
  try {
    const rows = await db
      .select({
        locationId: locations.id,
        companyId: locations.companyId,
        name: locations.name,
        email: locations.email,
        createdAt: locations.createdAt,
        subscriptionId: subscriptions.id,
        subscriptionStatus: subscriptions.status,
        planId: plans.id,
        planName: plans.name,
        appSlug: plans.appSlug,
      })
      .from(locations)
      .leftJoin(subscriptions, eq(subscriptions.locationId, locations.id))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .orderBy(desc(locations.createdAt));

    res.json({ locations: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/webhook-events
 * Returns the 50 most recent webhook events.
 */
export async function getWebhookEvents(_req, res, next) {
  try {
    const rows = await db
      .select()
      .from(webhookEvents)
      .orderBy(desc(webhookEvents.createdAt))
      .limit(50);

    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/webhook-events/:eventId/replay
 * Re-fetches a stored event and re-runs it through the subscription processor.
 */
export async function replayWebhookEvent(req, res, next) {
  try {
    const { eventId } = req.params;

    const [event] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
      .limit(1);

    if (!event) throw createError(404, `Webhook event ${eventId} not found`);

    try {
      await reprocessEventPayload(event.id, event.payload);
    } catch (err) {
      await markEventFailed(event.id, err).catch(() => {});
      throw err;
    }

    res.json({ success: true, eventId });
  } catch (err) {
    next(err);
  }
}
