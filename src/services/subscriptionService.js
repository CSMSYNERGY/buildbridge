import { db } from '../core/db/client.js';
import { subscriptions, plans } from '../core/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// Apps covered by the Suite plan
const SUITE_APPS = ['smartbuild', 'idearoom', 'quickbooks', 'monday'];

/**
 * Create a new subscription record.
 */
export async function createSubscription(
  locationId,
  deposytSubId,
  planId,
  periodEnd = null,
) {
  const [row] = await db
    .insert(subscriptions)
    .values({
      id: deposytSubId ?? randomUUID(),
      locationId,
      planId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    })
    .onConflictDoNothing()
    .returning();

  return row;
}

/**
 * Update arbitrary fields on a subscription by Deposyt subscription id.
 */
export async function updateSubscription(deposytSubId, fields) {
  const [row] = await db
    .update(subscriptions)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(subscriptions.id, deposytSubId))
    .returning();

  return row;
}

/**
 * Mark a subscription as cancelled.
 */
export async function cancelSubscription(deposytSubId) {
  return updateSubscription(deposytSubId, {
    status: 'cancelled',
    canceledAt: new Date(),
  });
}

/**
 * Mark a subscription as paused.
 */
export async function pauseSubscription(deposytSubId) {
  return updateSubscription(deposytSubId, { status: 'paused' });
}

/**
 * Return all active subscriptions for a location, joined with plan details.
 */
export async function getActiveSubscriptions(locationId) {
  return db
    .select({
      subscriptionId: subscriptions.id,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      planId: plans.id,
      planName: plans.name,
      appSlug: plans.appSlug,
      billingInterval: plans.billingInterval,
      priceUsd: plans.priceUsd,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.locationId, locationId),
        eq(subscriptions.status, 'active'),
      ),
    );
}

/**
 * Check whether a location has access to a given appSlug.
 * Suite subscribers have access to all SUITE_APPS.
 */
export async function hasAccess(locationId, appSlug) {
  const activeSubs = await getActiveSubscriptions(locationId);
  const slugs = activeSubs.map((s) => s.appSlug);

  return (
    slugs.includes(appSlug) ||
    (slugs.includes('suite') && SUITE_APPS.includes(appSlug))
  );
}
