import { ZodError } from 'zod';
import { recordThrown } from '../../services/errorLogService.js';

/**
 * Create a structured HTTP error.
 */
export function createError(status, message, details = undefined) {
  const err = new Error(message);
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Express 5 global error handler.
 * Must have exactly 4 parameters to be recognised by Express as an error handler.
 *
 * Async because failures are persisted to error_events before the response is
 * sent: on Workers the request's I/O context is torn down once the response goes
 * out, so a fire-and-forget insert would never land (same constraint the DB-pool
 * cleanup in src/index.js documents). Only error paths pay this latency.
 */
// eslint-disable-next-line no-unused-vars
export async function errorHandler(err, req, res, _next) {
  // Zod validation errors → 422
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: 'Validation error',
      issues: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }

  const status = err.status ?? 500;
  const message = status === 500 ? 'Internal server error' : err.message;

  if (status === 500) {
    console.error('[error]', err);
  }

  // Persist anything that is a real failure. 4xx caused by the caller (400/401/403/
  // 404/409/422) is normal traffic and would only add noise; upstream-attributed
  // 4xx (a GHL/QBO 401 etc.) IS recorded because it means the integration is broken.
  //
  // EXCEPTION — install/sign-in paths: a 4xx on /auth/* or /api/sso/* is never
  // "normal caller traffic", it is a tenant who could not get in. On 2026-07-27 a
  // 400 "Invalid or expired OAuth state" blocked EVERY marketplace install for days
  // and error_events stayed empty the whole time, because of the >=500 gate above.
  // Recorded as 'warn' and deduped by fingerprint, so a scanner poking /auth/callback
  // costs one row with a rising occurrence_count, not a flood.
  const isUpstream = Boolean(err.upstream);
  const isEntryPath = req.path?.startsWith('/auth') || req.path?.startsWith('/api/sso');
  const isEntryFailure = status >= 400 && status < 500 && isEntryPath;
  if (status >= 500 || isUpstream || isEntryFailure) {
    // Awaited so the write happens before the Workers runtime tears down the
    // request's I/O context (and before the res.end DB-pool cleanup runs).
    // recordThrown never throws — see errorLogService HARD RULES.
    await recordThrown(err, {
      source: 'backend',
      severity: status >= 500 ? 'error' : 'warn',
      // Tag entry-path failures so they're greppable in triage — these are the ones
      // that mean "a tenant is locked out", not "an integration is misbehaving".
      kind: err.kind ?? (isEntryFailure ? 'entry_blocked' : undefined),
      httpStatus: status,
      httpMethod: req.method,
      path: req.path,
      locationId: req.user?.locationId,
      userAgent: req.get?.('user-agent'),
      context: { ghlPath: err.ghlPath, details: err.details },
    });
  }

  res.status(status).json({
    error: message,
    ...(err.details ? { details: err.details } : {}),
  });
}
