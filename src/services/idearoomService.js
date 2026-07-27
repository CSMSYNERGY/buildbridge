import { db } from '../core/db/client.js';
import { locationSettings, mappers } from '../core/db/schema.js';
import { and, eq, isNotNull } from 'drizzle-orm';
import { makeGhlRequest } from './ghlService.js';
import { getLocationSettings, upsertLocationSettings } from './locationSettingsService.js';

// ─── IdeaRoom inbound lead webhook ────────────────────────────────────────────
// IdeaRoom is a 3D building configurator embedded on a dealer's site. When a shopper
// submits a configured building, IdeaRoom POSTs the lead to a URL we give their team:
//
//   POST https://buildbridge.csmsynergy.com/webhooks/idearoom/<token>
//
// The token IS the credential (their team cannot be relied on to send custom headers), so
// it is per-location, unguessable and rotatable — see migration 0005.
//
// IMPORTANT — why this is written defensively: IdeaRoom's exact payload field names are NOT
// publicly documented, so we do not assume them. The controller stores the RAW body first,
// and `extractLead` below tries a superset of plausible aliases. Once real traffic has been
// captured we can read it out of webhook_events and either tighten the aliases or configure
// per-tenant field mappings in the `mappers` table (app_slug='idearoom') with no code change.

const TOKEN_BYTES = 24;                    // 32 base64url chars
const WEBHOOK_BASE = 'https://buildbridge.csmsynergy.com/webhooks/idearoom';

function randomToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function webhookUrlFor(token) {
  return token ? `${WEBHOOK_BASE}/${token}` : null;
}

/**
 * Issue (or rotate) this location's IdeaRoom webhook token. Rotating invalidates the old
 * URL immediately, which is the remedy if a URL leaks.
 */
export async function issueWebhookToken(locationId, { rotate = false } = {}) {
  const current = await getLocationSettings(locationId);
  if (current?.idearoomWebhookToken && !rotate) {
    return { token: current.idearoomWebhookToken, url: webhookUrlFor(current.idearoomWebhookToken), rotated: false };
  }
  const token = randomToken();
  await upsertLocationSettings(locationId, { idearoomWebhookToken: token });
  return { token, url: webhookUrlFor(token), rotated: Boolean(current?.idearoomWebhookToken) };
}

/**
 * token → location settings row, or null. Constant-shape failure: an unknown token must
 * look identical to a token for a location that has since been removed.
 */
export async function resolveByToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const [row] = await db
    .select()
    .from(locationSettings)
    .where(and(eq(locationSettings.idearoomWebhookToken, token), isNotNull(locationSettings.idearoomWebhookToken)))
    .limit(1);
  return row ?? null;
}

// ─── Field extraction ─────────────────────────────────────────────────────────
// IdeaRoom's real payload shape IS published: they host full sample webhook bodies for
// Sheds and Carports (linked from idearoominc.com/api), and the envelope is identical
// across both products:
//
//   { schema, eventType, clientId, url, hash, environment, visits, updates,
//     checkoutOpened, order: { customer:{email,firstName,lastName,phone},
//     shippingAddress:{address1,city,state,zip}, totalPrice, building|buildingStructure,
//     "contact-me", versionedEmailId, ... } }
//
// So the DOCUMENTED paths are listed first and are what real traffic hits. The looser
// aliases after them are kept only as a fallback for a re-shaped/flattened body (e.g. if
// IdeaRoom's team routes us through a middleman) — they cost nothing and mean an
// unexpected shape still yields a reachable contact instead of a dropped lead.
//
// Anything genuinely undocumented (UTM/ad params, whether `integrationProperties` is
// enabled for a given client) is deliberately NOT guessed here — those get configured
// per-tenant in the `mappers` table once we have seen the client's real traffic.
const ALIASES = {
  // `hash` is IdeaRoom's design identifier: it appears top-level, is the fragment of
  // `url`, and is the key their pull API re-fetches by. NOT used alone for idempotency —
  // it is stable across created/updated/visited for one design (see eventKeyFor).
  designHash: ['hash', 'order.hash'],
  // Human-facing quote number ("IR Estimate Number" in their HubSpot connector).
  quoteNumber: ['order.versionedEmailId', 'order.emailId', 'versionedEmailId'],
  firstName:  ['order.customer.firstName', 'order.shippingAddress.firstName', 'firstName', 'first_name', 'givenName', 'contact.firstName', 'customer.firstName'],
  lastName:   ['order.customer.lastName', 'order.shippingAddress.lastName', 'lastName', 'last_name', 'familyName', 'surname', 'contact.lastName', 'customer.lastName'],
  fullName:   ['name', 'fullName', 'full_name', 'customerName', 'contactName', 'contact.name', 'customer.name'],
  email:      ['order.customer.email', 'email', 'emailAddress', 'email_address', 'contact.email', 'customer.email'],
  phone:      ['order.customer.phone', 'order.shippingAddress.phone', 'order.secondaryPhone', 'phone', 'phoneNumber', 'phone_number', 'telephone', 'mobile', 'contact.phone', 'customer.phone'],
  address1:   ['order.shippingAddress.address1', 'order.billingAddress.address1', 'address', 'address1', 'street', 'streetAddress', 'contact.address1'],
  city:       ['order.shippingAddress.city', 'order.billingAddress.city', 'city', 'contact.city'],
  state:      ['order.shippingAddress.state', 'order.billingAddress.state', 'state', 'province', 'region', 'contact.state'],
  postalCode: ['order.shippingAddress.zip', 'order.billingAddress.zip', 'zip', 'zipCode', 'zip_code', 'postalCode', 'postal_code'],
  // 3 decimal places are real in their samples (46855.875) — never assume 2dp currency.
  price:      ['order.totalPrice', 'order.subtotalPrice', 'price', 'total', 'totalPrice', 'amount', 'grandTotal'],
  // Sheds: order.building.* option objects. Carports: order.buildingStructure.* slugs.
  // `integrationProperties` is IdeaRoom's own pre-flattened CRM summary — present for
  // Carports, absent for Sheds — so it is preferred when sent.
  buildingName: ['order.integrationProperties.buildingStyle', 'order.building.style.description', 'order.buildingStructure.buildingStyle', 'buildingName', 'model', 'style', 'product'],
  size:       ['order.building.size.description', 'size', 'dimensions', 'buildingSize'],
  width:      ['order.integrationProperties.buildingSize.width', 'width', 'dimensions.width'],
  length:     ['order.integrationProperties.buildingSize.length', 'length', 'depth', 'dimensions.length'],
  // There is NO quote PDF in the payload. Top-level `url` is the deep link back into the
  // configurator and is the best "view this design" link for a GHL contact.
  designUrl:  ['url', 'quoteUrl', 'quote_url', 'link', 'designUrl', 'shareUrl', 'permalink'],
  // No dealer id exists in the payload — only a name/contact block, empty in both
  // samples. clientId + supplier are the only tenant-ish discriminators.
  dealer:     ['clientId', 'order.supplier', 'order.dealer.name', 'dealer', 'dealerId', 'siteId'],
  salesRep:   ['order.salesRep.name'],
  notes:      ['order.notes', 'notes', 'comments', 'message', 'note'],
};

// Hyphenated key — needs bracket access, not dot access. Observed values include
// "save-contact-me-now" and "save-do-not-contact"; the full enum is undocumented, so we
// treat only an explicit do-not-contact as suppression and let anything else through.
function contactPreference(payload) {
  const v = payload?.order?.['contact-me'] ?? payload?.['contact-me'];
  return typeof v === 'string' ? v : undefined;
}

/** True when the shopper explicitly asked NOT to be contacted. */
export function isDoNotContact(payload) {
  const pref = contactPreference(payload);
  return typeof pref === 'string' && pref.includes('do-not-contact');
}

function pluck(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  if (cur == null) return undefined;
  if (typeof cur === 'object') return undefined;          // never coerce an object into a field
  const s = String(cur).trim();
  return s === '' ? undefined : s;
}

function firstMatch(payload, paths) {
  for (const p of paths) {
    const v = pluck(payload, p);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Best-effort structured view of an IdeaRoom payload. Never throws: anything it cannot
 * find is simply absent, and the caller decides whether what it got is usable.
 */
export function extractLead(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const out = {};
  for (const [key, paths] of Object.entries(ALIASES)) {
    const v = firstMatch(p, paths);
    if (v !== undefined) out[key] = v;
  }
  // Split a single full name when first/last weren't sent separately.
  if (!out.firstName && out.fullName) {
    const parts = out.fullName.split(/\s+/);
    out.firstName = parts.shift();
    if (parts.length && !out.lastName) out.lastName = parts.join(' ');
  }
  // A building description for the opportunity title / notes, from whatever we have.
  const sizeText = out.size || (out.width && out.length ? `${out.width}x${out.length}` : undefined);
  out.buildingSummary = [out.buildingName, sizeText].filter(Boolean).join(' ') || undefined;
  out.eventType = String(p.eventType ?? '').toLowerCase() || undefined;
  out.doNotContact = isDoNotContact(p);
  return out;
}

/**
 * Idempotency key for one delivery.
 *
 * IdeaRoom sends NO timestamp of any kind, and `hash` is stable across the whole life of
 * a design (created → updated → visited). So hash alone would collapse a legitimate
 * re-submission into the original and we'd silently drop the update. Their three counters
 * (visits/updates/checkoutOpened) are the only ordering signal that exists, so the key is
 * hash + eventType + counters: a genuine re-delivery of the same event dedupes, while a
 * real update or checkout advances a counter and comes through as new.
 *
 * Falls back to null when there's no hash — the caller then hashes the body.
 */
export function eventKeyFor(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const hash = pluck(p, 'hash');
  if (!hash) return null;
  const evt = String(p.eventType ?? 'unknown').toLowerCase();
  const counters = [p.visits, p.updates, p.checkoutOpened]
    .map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0))
    .join('.');
  return `${hash}:${evt}:${counters}`;
}

/**
 * A 'visited' event is just someone re-opening their saved design link — no new intent
 * and no new submission, so it must refresh the contact without opening another
 * opportunity (otherwise one design spawns an opportunity per page view).
 */
export function isPassiveEvent(payload) {
  return String(payload?.eventType ?? '').toLowerCase() === 'visited';
}

/** A lead is only actionable if we can reach the person. */
export function isActionable(lead) {
  return Boolean(lead.email || lead.phone);
}

// ─── GHL push ─────────────────────────────────────────────────────────────────

/**
 * Per-tenant IdeaRoom→GHL custom-field mappings, reusing the existing mappers table:
 *   app_slug='idearoom', mapper_type='custom_field', external_key=<IdeaRoom field or path>,
 *   ghl_value=<GHL custom field id>
 * Configured per client once we know their real payload — no code change needed.
 */
async function customFieldEntries(locationId, payload) {
  const rows = await db
    .select({ externalKey: mappers.externalKey, ghlValue: mappers.ghlValue })
    .from(mappers)
    .where(and(
      eq(mappers.locationId, locationId),
      eq(mappers.appSlug, 'idearoom'),
      eq(mappers.mapperType, 'custom_field'),
    ));
  const entries = [];
  for (const r of rows) {
    const v = pluck(payload, r.externalKey);
    if (v !== undefined) entries.push({ id: r.ghlValue, value: v });
  }
  return entries;
}

/**
 * Create or update the GHL contact for this lead and, when a pipeline+stage is configured,
 * open an opportunity. Returns a summary for the webhook_events record.
 *
 * Uses POST /contacts/upsert so a returning shopper updates their existing contact instead
 * of creating a duplicate (GHL matches on email/phone within the location).
 */
export async function pushLeadToGhl(locationId, payload, settings) {
  const lead = extractLead(payload);
  if (!isActionable(lead)) {
    return { ok: false, reason: 'no_contact_details', lead };
  }

  const tag = settings?.idearoomTag || 'idearoom-lead';
  // IdeaRoom's shoppers can explicitly opt out via order['contact-me'] =
  // "save-do-not-contact". We still record the lead — the dealer wants the design — but
  // we set GHL's own DND flag so no workflow can text or email them, and tag it so the
  // choice is visible in the UI rather than buried in the raw payload.
  const dnc = lead.doNotContact === true;
  const contactBody = {
    locationId,
    ...(lead.firstName ? { firstName: lead.firstName } : {}),
    ...(lead.lastName ? { lastName: lead.lastName } : {}),
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.phone ? { phone: lead.phone } : {}),
    ...(lead.address1 ? { address1: lead.address1 } : {}),
    ...(lead.city ? { city: lead.city } : {}),
    ...(lead.state ? { state: lead.state } : {}),
    ...(lead.postalCode ? { postalCode: lead.postalCode } : {}),
    source: 'IdeaRoom',
    tags: dnc ? [tag, 'idearoom-do-not-contact'] : [tag],
    ...(dnc ? { dnd: true } : {}),
  };
  const cf = await customFieldEntries(locationId, payload);
  if (cf.length) contactBody.customFields = cf;

  const upserted = await makeGhlRequest(locationId, 'POST', '/contacts/upsert', contactBody);
  const contactId = upserted?.contact?.id ?? upserted?.id ?? null;
  if (!contactId) return { ok: false, reason: 'ghl_no_contact_id', lead };

  const result = { ok: true, contactId, lead, opportunityId: null };

  // Opportunity only when the tenant has told us where it belongs — and never for a
  // passive 'visited' event, which is just the shopper reopening their own design link
  // and would otherwise create a fresh opportunity on every page view.
  const pipelineId = settings?.idearoomPipelineId;
  const stageId = settings?.idearoomStageId;
  if (isPassiveEvent(payload)) {
    result.skippedOpportunity = 'passive_event';
  } else if (pipelineId && stageId) {
    const title = lead.buildingSummary
      ? `IdeaRoom — ${lead.buildingSummary}`
      : `IdeaRoom lead${lead.fullName ? ` — ${lead.fullName}` : ''}`;
    const monetary = lead.price ? Number(String(lead.price).replace(/[^0-9.]/g, '')) : undefined;
    const opp = await makeGhlRequest(locationId, 'POST', '/opportunities/', {
      locationId,
      pipelineId,
      pipelineStageId: stageId,
      contactId,
      name: title,
      status: 'open',
      ...(Number.isFinite(monetary) && monetary > 0 ? { monetaryValue: monetary } : {}),
    });
    result.opportunityId = opp?.opportunity?.id ?? opp?.id ?? null;
  }

  return result;
}
