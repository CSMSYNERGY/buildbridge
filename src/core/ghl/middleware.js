import crypto from 'crypto';
import { env } from '../env.js';
import { createError } from '../middleware/errorHandler.js';

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
 * Factory: returns middleware guarding the routes for a given appSlug.
 *
 * Every integration is **included with the GHL install** (decision 2026-07-27:
 * BuildBridge is plug-and-play — install the marketplace app and it works), so
 * this no longer consults `subscriptions`. What it still enforces is that the
 * caller is authenticated AND tenant-scoped: the routes below it all read
 * `req.user.locationId`, and a company-only session must not reach them.
 *
 * Deliberately kept as a factory instead of being deleted from its call sites, so
 * per-app paid gating can be restored by reinstating the lookup (the `plans` /
 * `subscriptions` tables, the NMI checkout, and `getActiveSubscriptions` are all
 * untouched and still serve legacy paid tenants).
 *
 * Usage: router.use(checkSubscription('idearoom'))
 */
export function checkSubscription(_appSlug) {
  return (req, _res, next) => {
    if (!req.user?.locationId) {
      return next(createError(401, 'Authentication required'));
    }
    next();
  };
}
