import { db } from '../core/db/client.js';
import { locations, subscriptions, plans, webhookEvents } from '../core/db/schema.js';
import { eq, desc } from 'drizzle-orm';

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
