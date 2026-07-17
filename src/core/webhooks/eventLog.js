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
