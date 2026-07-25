import { sql, eq, and, isNull, isNotNull, desc } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { errorEvents } from '../core/db/schema.js';
import { recordError } from '../services/errorLogService.js';

const ALLOWED_SEVERITY = new Set(['warn', 'error', 'fatal']);

// Row-reading queries use the drizzle QUERY BUILDER, not db.execute(): on the
// pg-proxy driver (see core/db/client.js) db.execute() sends method 'execute' and
// resolves to a BARE ARRAY whose row shape depends on the DB worker's transport,
// while the builder sends 'all' with field metadata and maps rows into named
// objects — the path every other query in this app already relies on.

/**
 * POST /api/client-errors
 * Browser-side error ingest (see frontend/src/lib/reportError.js).
 *
 * Deliberately NOT behind requireAuth: a crash during the SSO handshake — exactly
 * the kind we most need to see — happens before a session exists. It is instead
 * bounded by: the general rate limiter, express.json's body cap, a fixed severity
 * whitelist, server-side fingerprint dedupe, and `source` being forced to
 * 'frontend' so a caller cannot forge backend/cron rows.
 */
export async function ingestClientError(req, res, next) {
  try {
    const { message, kind, severity, stack, path, context } = req.body ?? {};

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    await recordError({
      source: 'frontend',                                   // forced — never client-supplied
      severity: ALLOWED_SEVERITY.has(severity) ? severity : 'error',
      kind: typeof kind === 'string' ? kind.slice(0, 60) : 'client_error',
      message: message.slice(0, 2000),
      stack: typeof stack === 'string' ? stack : undefined,
      path: typeof path === 'string' ? path.slice(0, 300) : undefined,
      locationId: req.user?.locationId,                     // set only if a valid session cookie rode along
      userAgent: req.get('user-agent'),
      context: typeof context === 'object' && context !== null ? context : undefined,
    });

    // 204: the browser has nothing to do with the result.
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/errors?status=open|resolved|all&limit=&source=&locationId=
 * Triage list, newest activity first. Admin-key protected (see adminRoutes).
 */
export async function listErrors(req, res, next) {
  try {
    const status = req.query.status ?? 'open';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const filters = [];
    if (status === 'open') filters.push(isNull(errorEvents.resolvedAt));
    if (status === 'resolved') filters.push(isNotNull(errorEvents.resolvedAt));
    if (req.query.source) filters.push(eq(errorEvents.source, String(req.query.source)));
    if (req.query.locationId) filters.push(eq(errorEvents.locationId, String(req.query.locationId)));

    let q = db.select({
      id: errorEvents.id,
      source: errorEvents.source,
      severity: errorEvents.severity,
      locationId: errorEvents.locationId,
      appSlug: errorEvents.appSlug,
      kind: errorEvents.kind,
      message: errorEvents.message,
      httpStatus: errorEvents.httpStatus,
      httpMethod: errorEvents.httpMethod,
      path: errorEvents.path,
      upstream: errorEvents.upstream,
      upstreamStatus: errorEvents.upstreamStatus,
      upstreamRef: errorEvents.upstreamRef,
      occurrenceCount: errorEvents.occurrenceCount,
      firstSeenAt: errorEvents.firstSeenAt,
      lastSeenAt: errorEvents.lastSeenAt,
      resolvedAt: errorEvents.resolvedAt,
      resolutionNote: errorEvents.resolutionNote,
      stack: errorEvents.stack,
      context: errorEvents.context,
    }).from(errorEvents);

    if (filters.length) q = q.where(filters.length === 1 ? filters[0] : and(...filters));

    const errors = await q.orderBy(desc(errorEvents.lastSeenAt)).limit(limit);
    res.json({ errors });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/errors/:id/resolve  { note? }
 * Marks one row resolved, which also frees its fingerprint — so if the same
 * failure happens again it opens a NEW row instead of silently reviving this one.
 * That is what makes "fix everything in the table" verifiable.
 */
export async function resolveError(req, res, next) {
  try {
    const { id } = req.params;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null;

    const updated = await db
      .update(errorEvents)
      .set({ resolvedAt: new Date(), resolutionNote: note })
      .where(and(eq(errorEvents.id, id), isNull(errorEvents.resolvedAt)))
      .returning({ id: errorEvents.id });

    if (!updated.length) return res.status(404).json({ error: 'No open error with that id' });
    res.json({ success: true, id });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/errors/summary
 * One-glance triage: open issues grouped by source/upstream/kind.
 */
export async function errorSummary(_req, res, next) {
  try {
    const summary = await db
      .select({
        source: errorEvents.source,
        upstream: errorEvents.upstream,
        kind: errorEvents.kind,
        severity: errorEvents.severity,
        issues: sql`count(*)::int`.as('issues'),
        occurrences: sql`sum(${errorEvents.occurrenceCount})::int`.as('occurrences'),
        lastSeenAt: sql`max(${errorEvents.lastSeenAt})`.as('last_seen_at'),
      })
      .from(errorEvents)
      .where(isNull(errorEvents.resolvedAt))
      .groupBy(errorEvents.source, errorEvents.upstream, errorEvents.kind, errorEvents.severity);

    res.json({ summary });
  } catch (err) {
    next(err);
  }
}
