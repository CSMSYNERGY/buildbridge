import { db } from '../core/db/client.js';
import { integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../core/middleware/encrypt.js';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';
import { getMappings } from './mapperService.js';
import { makeGhlRequest } from './ghlService.js';
import { hasAccess } from './subscriptionService.js';
import { normalizeLead } from './idearoomNormalize.js';

export const IDEAROOM_SLUG = 'idearoom';

// normalizeLead lives in a dependency-free module so it can be unit-tested
// against the fixtures without app env / a database. Re-exported for callers.
export { normalizeLead };

/**
 * Load decrypted IdeaRoom credentials for a location: `{ clientId, apiKey? }`.
 * clientId is the IdeaRoom `client-id` (e.g. 'carportview-built-rite-buildings').
 * Returns `{}` when nothing is stored.
 */
export async function getCredentials(locationId) {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.locationId, locationId),
        eq(integrationCredentials.appSlug, IDEAROOM_SLUG),
      ),
    )
    .limit(1);

  if (!row) return {};
  try {
    return JSON.parse(decrypt(row.encryptedPayload));
  } catch {
    return {};
  }
}

/**
 * Pull a single order/design from IdeaRoom's REST API on demand (backfill /
 * reconciliation). GET /v1/orders/{hash} with x-api-key + client-id headers.
 * Returns the same payload shape the webhook pushes. See Swagger:
 * https://app.swaggerhub.com/apis-docs/idearoom/idearoom-api-public/1.0.0
 */
export async function fetchOrder(locationId, hash) {
  if (!env.IDEAROOM_API_BASE_URL) throw createError(503, 'IdeaRoom API base URL not configured');

  const creds = await getCredentials(locationId);
  const apiKey = creds.apiKey || env.IDEAROOM_API_KEY;
  const clientId = creds.clientId;
  if (!apiKey) throw createError(503, 'IdeaRoom API key not configured');
  if (!clientId) throw createError(400, `IdeaRoom client-id not configured for location ${locationId}`);

  const res = await fetch(`${env.IDEAROOM_API_BASE_URL}/v1/orders/${encodeURIComponent(hash)}`, {
    headers: {
      'x-api-key': apiKey,
      'client-id': clientId,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw createError(res.status, `IdeaRoom API error [GET /v1/orders/${hash}]: ${body}`);
  }

  return res.json();
}

/**
 * Handle an IdeaRoom configurator event: push the design into GHL as a lead.
 * Registered for the 'created' and 'updated' events (src/integrations/idearoom.js).
 *
 * - Upserts a contact (deduped by email/phone) and attaches the design details
 *   (spec, quote total, design link, renders) as a note.
 * - On 'created', also opens an opportunity in the location's mapped pipeline.
 *   'updated' events refresh the contact only — creating a second opportunity is
 *   deferred until a design→opportunity link table exists
 *   (docs/idearoom-integration.md §6).
 */
export async function handleIdearoomLead({ locationId, payload }) {
  if (!(await hasAccess(locationId, IDEAROOM_SLUG))) {
    console.log(`[idearoom] location ${locationId} has no idearoom access — skipping`);
    return;
  }

  const lead = normalizeLead(payload);
  if (!lead.contact.email && !lead.contact.phone) {
    console.warn(`[idearoom] design ${lead.hash}: no email or phone — skipping lead`);
    return;
  }

  // Tags — driven by `contact_tag` mappers: the `default` tag always applies, and
  // a tag whose externalKey matches the design's status applies too. Falls back to
  // a fixed 'idearoom-lead' tag when none are configured, so leads stay identifiable.
  const tagMap = await getMappings(locationId, IDEAROOM_SLUG, 'contact_tag');
  const mappedTags = Object.entries(tagMap)
    .filter(([key]) => key === 'default' || key === lead.status)
    .map(([, tag]) => tag)
    .filter(Boolean);
  const tags = mappedTags.length ? mappedTags : ['idearoom-lead'];

  // 1. Upsert the contact (GHL dedupes by email/phone within the location).
  const contactRes = await makeGhlRequest(locationId, 'POST', '/contacts/upsert', {
    locationId,
    firstName: lead.contact.firstName ?? undefined,
    lastName: lead.contact.lastName ?? undefined,
    name: lead.contact.name ?? undefined,
    email: lead.contact.email ?? undefined,
    phone: lead.contact.phone ?? undefined,
    address1: lead.contact.address1 ?? undefined,
    city: lead.contact.city ?? undefined,
    state: lead.contact.state ?? undefined,
    postalCode: lead.contact.postalCode ?? undefined,
    source: 'IdeaRoom',
    tags,
  });
  const contactId = contactRes?.contact?.id ?? contactRes?.id;
  if (!contactId) throw new Error(`[idearoom] contact upsert returned no id for design ${lead.hash}`);

  // Attach the design details as a contact note (best-effort).
  const noteBody = [
    `IdeaRoom design: ${lead.productSummary}`,
    lead.monetaryValue != null ? `Quote total: $${lead.monetaryValue.toLocaleString('en-US')}` : null,
    lead.designUrl ? `Design link: ${lead.designUrl}` : null,
    lead.specSummary ? `\nConfiguration:\n${lead.specSummary}` : null,
    lead.images.length ? `\nRenders:\n${lead.images.join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  await makeGhlRequest(locationId, 'POST', `/contacts/${contactId}/notes`, { body: noteBody }).catch(
    (err) => console.warn(`[idearoom] note create failed for contact ${contactId}: ${err.message}`),
  );

  // 2. Opportunity — only on 'created' (avoid duplicates on 'updated'; see §6).
  if (lead.eventType && lead.eventType !== 'created') {
    console.log(`[idearoom] design ${lead.hash}: ${lead.eventType} event — refreshed contact ${contactId}, no new opportunity`);
    return;
  }

  const pipelineMap = await getMappings(locationId, IDEAROOM_SLUG, 'pipeline');
  const pipelineId = pipelineMap.default;
  if (!pipelineId) {
    console.warn(`[idearoom] design ${lead.hash}: no pipeline mapper (idearoom/pipeline/default) — contact ${contactId} created without opportunity`);
    return;
  }

  const stageMap = await getMappings(locationId, IDEAROOM_SLUG, 'opportunity_stage');
  const mappedStage = (lead.status && stageMap[lead.status]) ?? stageMap.default;

  const oppRes = await makeGhlRequest(locationId, 'POST', '/opportunities/', {
    locationId,
    pipelineId,
    contactId,
    name: lead.productSummary,
    status: 'open',
    ...(lead.monetaryValue != null ? { monetaryValue: lead.monetaryValue } : {}),
    ...(mappedStage ? { pipelineStageId: mappedStage } : {}),
  });
  const opportunityId = oppRes?.opportunity?.id ?? oppRes?.id;
  console.log(`[idearoom] design ${lead.hash}: created contact ${contactId} + opportunity ${opportunityId ?? '(no id)'}`);
}
