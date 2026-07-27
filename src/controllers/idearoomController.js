import { issueWebhookToken, webhookUrlFor } from '../services/idearoomService.js';
import { getLocationSettings, upsertLocationSettings } from '../services/locationSettingsService.js';

// Authed (JWT) endpoints for the IdeaRoom integration's own settings. The webhook itself is
// unauthenticated-by-design and lives at /webhooks/idearoom/:token — see
// controllers/idearoomWebhookController.js.

// GET /api/idearoom/settings — current config + the URL to hand IdeaRoom.
export async function getIdearoomSettings(req, res, next) {
  try {
    const { locationId } = req.user;
    const s = await getLocationSettings(locationId);
    res.json({
      settings: {
        enabled: Boolean(s?.idearoomEnabled),
        pipelineId: s?.idearoomPipelineId ?? null,
        stageId: s?.idearoomStageId ?? null,
        tag: s?.idearoomTag ?? 'idearoom-lead',
        // The token is only useful as the full URL, and the operator must be able to copy
        // it — so unlike the GHL/QBO secrets this one is returned in full, deliberately.
        webhookUrl: webhookUrlFor(s?.idearoomWebhookToken ?? null),
        hasWebhook: Boolean(s?.idearoomWebhookToken),
      },
    });
  } catch (err) { next(err); }
}

// POST /api/idearoom/webhook — issue the URL, or rotate it ({ rotate: true }).
// Rotation invalidates the old URL immediately: use it if a URL leaks, and remember
// IdeaRoom must be given the new one.
export async function issueIdearoomWebhook(req, res, next) {
  try {
    const { locationId } = req.user;
    const rotate = req.body?.rotate === true;
    const { url, rotated } = await issueWebhookToken(locationId, { rotate });
    res.json({ webhookUrl: url, rotated });
  } catch (err) { next(err); }
}

// PUT /api/idearoom/settings — enable/disable + where the opportunity lands.
export async function saveIdearoomSettings(req, res, next) {
  try {
    const { locationId } = req.user;
    const { enabled, pipelineId, stageId, tag } = req.body ?? {};
    const fields = {};
    if (enabled !== undefined) fields.idearoomEnabled = Boolean(enabled);
    if (pipelineId !== undefined) fields.idearoomPipelineId = pipelineId || null;
    if (stageId !== undefined) fields.idearoomStageId = stageId || null;
    if (tag !== undefined) {
      const t = String(tag ?? '').trim();
      fields.idearoomTag = t || 'idearoom-lead';
    }
    // A stage without its pipeline (or vice versa) would silently skip opportunity
    // creation; reject it so the operator sees the problem now.
    const nextPipeline = fields.idearoomPipelineId ?? (await getLocationSettings(locationId))?.idearoomPipelineId ?? null;
    const nextStage = fields.idearoomStageId !== undefined ? fields.idearoomStageId : undefined;
    if (nextStage && !nextPipeline) {
      return res.status(400).json({ error: 'Pick a pipeline as well as a stage — an opportunity needs both.' });
    }
    await upsertLocationSettings(locationId, fields);
    const s = await getLocationSettings(locationId);
    res.json({
      settings: {
        enabled: Boolean(s?.idearoomEnabled),
        pipelineId: s?.idearoomPipelineId ?? null,
        stageId: s?.idearoomStageId ?? null,
        tag: s?.idearoomTag ?? 'idearoom-lead',
        webhookUrl: webhookUrlFor(s?.idearoomWebhookToken ?? null),
        hasWebhook: Boolean(s?.idearoomWebhookToken),
      },
    });
  } catch (err) { next(err); }
}

// GET /api/idearoom/leads?limit=20 — recent inbound leads (raw payload included) so an
// operator can SEE what IdeaRoom actually sent and fix field mappings from real traffic.
export async function getIdearoomLeads(req, res, next) {
  try {
    const { locationId } = req.user;
    const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 100);
    const { db } = await import('../core/db/client.js');
    const { webhookEvents } = await import('../core/db/schema.js');
    const { and, eq, desc } = await import('drizzle-orm');
    const rows = await db
      .select({
        id: webhookEvents.id,
        status: webhookEvents.status,
        error: webhookEvents.error,
        payload: webhookEvents.payload,
        createdAt: webhookEvents.createdAt,
        processedAt: webhookEvents.processedAt,
      })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.locationId, locationId), eq(webhookEvents.source, 'idearoom')))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(limit);
    res.json({ leads: rows });
  } catch (err) { next(err); }
}
