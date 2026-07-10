import { rateLimit } from 'express-rate-limit';

/**
 * Rate-limit key derived from Cloudflare's CF-Connecting-IP header (the real
 * client IP on Workers). Falls back to Express's req.ip for local/non-CF runs.
 *
 * NOTE: the default in-memory store is per-isolate on Workers, so limits are
 * enforced per instance rather than globally. Acceptable for the initial
 * migration; a shared store (Durable Object / KV) is a tracked follow-up.
 */
const clientIpKey = (req) => req.headers['cf-connecting-ip'] || req.ip || 'unknown';

/**
 * Build a limiter lazily.
 *
 * express-rate-limit's MemoryStore starts a `setInterval` the moment `rateLimit()`
 * is called. On Workers, timers/I/O are forbidden in global scope, so constructing
 * the limiter at module load throws. Instead we defer construction to the first
 * request (a valid handler context) and memoize the instance.
 */
function lazyLimiter(options) {
  let limiter;
  return (req, res, next) => {
    if (!limiter) {
      limiter = rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIpKey,
        ...options,
      });
    }
    return limiter(req, res, next);
  };
}

/**
 * General-purpose limiter applied to all routes.
 * 200 requests per minute per IP.
 */
export const generalLimiter = lazyLimiter({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * Stricter limiter for auth endpoints.
 * 20 requests per 15 minutes per IP.
 */
export const authLimiter = lazyLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

/**
 * Action limiter for write/mutation endpoints.
 * 60 requests per minute per IP.
 */
export const actionLimiter = lazyLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Rate limit exceeded, please slow down.' },
});
