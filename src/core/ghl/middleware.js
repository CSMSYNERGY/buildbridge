import crypto from 'crypto';
import { db } from '../db/client.js';
import { subscriptions, plans } from '../db/schema.js';
import { and, eq, or, gt, isNull } from 'drizzle-orm';
import { env } from '../env.js';
import { createError } from '../middleware/errorHandler.js';

// Apps covered by the Suite plan
const SUITE_APPS = ['smartbuild', 'idearoom', 'quickbooks', 'monday'];

// Constant-time string compare so a leaked timing side-channel can't be used to
// guess a shared secret byte-by-byte.
export function safeKeyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Validate the internal X-API-Key header.
 * Used to secure internal service-to-service calls.
 */
export function verifyApiKey(req, _res, next) {
  const key = req.headers['x-api-key'];
  if (!safeKeyEqual(key, env.X_API_KEY)) {
    return next(createError(401, 'Invalid or missing API key'));
  }
  next();
}

/**
 * Factory: returns middleware that checks whether the authenticated location
 * has an active subscription covering the given appSlug.
 *
 * Usage: router.use(checkSubscription('idearoom'))
 */
export function checkSubscription(appSlug) {
  return async (req, _res, next) => {
    try {
      const locationId = req.user?.locationId;
      if (!locationId) {
        throw createError(401, 'Authentication required');
      }

      // Find active subscriptions for this location
      const activeSubs = await db
        .select({ planAppSlug: plans.appSlug })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(
          and(
            eq(subscriptions.locationId, locationId),
            eq(subscriptions.status, 'active'),
            // Don't grant access on an "active" row past its period end (missed
            // cancel/expiry webhook backstop).
            or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, new Date())),
          ),
        );

      const appSlugs = activeSubs.map((s) => s.planAppSlug);

      const hasAccess =
        appSlugs.includes(appSlug) ||
        (appSlugs.includes('suite') && SUITE_APPS.includes(appSlug));

      if (!hasAccess) {
        throw createError(403, `Active subscription required for ${appSlug}`);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
