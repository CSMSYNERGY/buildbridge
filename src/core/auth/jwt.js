import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { createError } from '../middleware/errorHandler.js';

const COOKIE_NAME = 'sb_token';
// Shared attributes so set and clear can't drift. A cookie is only deleted when
// the clearing Set-Cookie carries the SAME secure/sameSite/partitioned/path —
// otherwise the embedded-iframe (CHIPS) cookie survives logout.
const COOKIE_BASE = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'none',
  // CHIPS: lets the cookie work when the app is embedded in GHL's iframe on
  // browsers that block unpartitioned third-party cookies (the cookie is scoped
  // per top-level site). Browsers that don't support it ignore the attribute.
  partitioned: env.NODE_ENV === 'production',
  path: '/',
};
const COOKIE_OPTIONS = { ...COOKIE_BASE, maxAge: 60 * 60 * 24 * 7 * 1000 }; // 7 days in ms

export function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, env.APP_JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  return token;
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_BASE);
}

/**
 * Resolve the session token from the cookie or, as a fallback, from an
 * Authorization: Bearer header. The header path exists for the embedded-in-GHL
 * iframe, where some browsers refuse third-party cookies entirely — the SPA then
 * holds the token from /api/sso/decrypt in memory and sends it per-request.
 */
function extractToken(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const auth = req.headers?.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  return null;
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return next(createError(401, 'Authentication required'));
  }

  try {
    req.user = jwt.verify(token, env.APP_JWT_SECRET);
    next();
  } catch {
    clearAuthCookie(res);
    next(createError(401, 'Invalid or expired session'));
  }
}
