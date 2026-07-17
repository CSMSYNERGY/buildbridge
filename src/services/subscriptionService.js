import { db } from '../core/db/client.js';
import { subscriptions, plans } from '../core/db/schema.js';
import { eq, and, or, gt, isNull, inArray } from 'drizzle-orm';
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
  const id = deposytSubId ?? randomUUID();
  const [row] = await db
    .insert(subscriptions)
    .values({
      id,
      locationId,
      planId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;

  // Conflict (subscription already exists): re-select so callers never get
  // undefined (which surfaced as a 201 { subscription: undefined } to clients).
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .limit(1);
  return existing ?? null;
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
        // Backstop a missed cancel/expiry webhook: an "active" row past its
        // period end no longer grants access.
        or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, new Date())),
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
