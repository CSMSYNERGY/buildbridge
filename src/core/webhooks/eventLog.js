import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Idempotency guard: an event is a duplicate ONLY once it has been fully
 * processed. A 'pending' row (handler interrupted before it could mark the
 * event processed/failed — e.g. isolate eviction or the worker's response
 * timeout) or a 'failed' row must be reprocessable on redelivery, otherwise a
 * paid event could be silently lost forever.
 */
export async function isDuplicateEvent(eventId) {
  const [existing] = await db
    .select({ status: webhookEvents.status })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, eventId))
    .limit(1);

  return existing?.status === 'processed';
}

/**
 * Insert a new webhook event record with status 'pending'. Idempotent: a
 * redelivery whose row already exists (from an interrupted first attempt) is a
 * no-op here so reprocessing can proceed instead of throwing on the PK.
 */
export async function logWebhookEvent({ id, source, eventType, locationId, payload }) {
  await db
    .insert(webhookEvents)
    .values({
      id,
      source,
      eventType,
      locationId: locationId ?? null,
      payload,
      status: 'pending',
    })
    .onConflictDoNothing();
}

/**
 * Capture-and-claim in ONE database round trip: insert the event, and report whether we
 * are the first to claim it.
 *
 * Why this exists alongside isDuplicateEvent + logWebhookEvent: on this deployment every
 * query is a service-binding hop to a Supabase edge function (~3s), so a separate
 * duplicate-check SELECT is not a rounding error — it is seconds of latency a webhook
 * sender may time out on. It also closes a race the two-call version has: two concurrent
 * identical deliveries can both pass isDuplicateEvent before either inserts, and both then
 * push the same lead. Here the primary key decides a single winner.
 *
 * Returns { claimed, alreadyProcessed }. `claimed` false + `alreadyProcessed` false means a
 * previous attempt left the row pending/failed and this delivery may reprocess it — the
 * same replayable semantics isDuplicateEvent provides.
 */
export async function claimWebhookEvent({ id, source, eventType, locationId, payload }) {
  const inserted = await db
    .insert(webhookEvents)
    .values({ id, source, eventType, locationId: locationId ?? null, payload, status: 'pending' })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  // The overwhelmingly common case: a brand-new event, claimed in a single round trip.
  if (inserted.length) return { claimed: true, alreadyProcessed: false };

  // Row already present — only now pay for a second query to see whether it finished.
  const [existing] = await db
    .select({ status: webhookEvents.status })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .limit(1);
  return { claimed: false, alreadyProcessed: existing?.status === 'processed' };
}

/**
 * Mark a previously logged event as successfully processed.
 */
export async function markEventProcessed(eventId) {
  await db
    .update(webhookEvents)
    .set({ status: 'processed', processedAt: new Date() })
    .where(eq(webhookEvents.id, eventId));
}

/**
 * Mark a previously logged event as failed, storing the error message.
 */
export async function markEventFailed(eventId, error) {
  await db
    .update(webhookEvents)
    .set({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    .where(eq(webhookEvents.id, eventId));
}
