import { db } from '../core/db/client.js';
import { locations } from '../core/db/schema.js';
import { recordError } from './errorLogService.js';

/**
 * Guarantee a `locations` row exists for this locationId.
 *
 * WHY THIS EXISTS (2026-07-28 root cause):
 * Almost every table is foreign-keyed to locations.id — integration_credentials,
 * location_settings, mappers, subscriptions, qb_milestones, qb_sync_links. But the
 * row was only ever created by the GHL OAuth install callback
 * (controllers/authController.js). A tenant who reaches the app through **SSO**
 * (the normal path when the app is installed at agency level, so the custom page
 * renders inside any sub-account) got a perfectly valid session carrying a
 * locationId with NO row behind it — so the first feature that wrote anything
 * blew up on a foreign-key violation and surfaced as a bare
 * `{"error":"Internal server error"}`.
 *
 * That is why the QuickBooks callback kept failing for new sub-accounts even
 * after per-location fixes: the fix has to happen where the session is minted,
 * not in each feature.
 *
 * onConflictDoNothing is deliberate: when the row already exists it must be left
 * completely alone, because the OAuth path owns the GHL tokens/companyId and this
 * must never downgrade them to null.
 *
 * Never throws — a failure here must not block sign-in. It is recorded to
 * error_events so it is visible rather than silent.
 *
 * @param {string} locationId
 * @param {{companyId?: string|null, name?: string|null, email?: string|null}} [info]
 * @returns {Promise<boolean>} true when the row is present afterwards (best effort)
 */
export async function ensureLocation(locationId, info = {}) {
  if (!locationId) return false;
  try {
    await db
      .insert(locations)
      .values({
        id: locationId,
        companyId: info.companyId ?? null,
        name: info.name ?? null,
        email: info.email ?? null,
      })
      .onConflictDoNothing({ target: locations.id });
    return true;
  } catch (err) {
    await recordError({
      source: 'backend',
      severity: 'error',
      kind: 'ensure_location_failed',
      locationId,
      message: `Could not ensure locations row: ${err?.message ?? 'unknown error'}`,
      stack: err?.stack,
    });
    return false;
  }
}
