import jwt from 'jsonwebtoken';
import { db } from '../core/db/client.js';
import { integrationCredentials, qbSyncState } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';
import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  saveCredentials,
  getCredentialsOrNull,
  getCredentialRecord,
  revokeToken,
  makeQuickBooksRequest,
  getCustomFieldDefinitions,
  getTransactionCustomFieldNames,
  enableLegacySalesCustomField,
  listItems,
  getCompanyName,
  setCredentialDisplayName,
} from '../services/quickbooksService.js';
import { listOpenIssues } from '../services/errorLogService.js';
import {
  listMilestoneDefinitions,
  serializeDefinition,
  createMilestoneDefinition,
  updateMilestoneDefinition,
  deleteMilestoneDefinition,
} from '../services/milestoneDefinitionsService.js';
import {
  getLocationSettings,
  upsertLocationSettings,
} from '../services/locationSettingsService.js';

const QUICKBOOKS_SLUG = 'quickbooks';
const STATE_PURPOSE = 'qbo_oauth';

// Where the OAuth round-trip lands. This is a session-less static page (see
// quickBooksDone) rather than the SPA: the round-trip now happens in its own
// top-level tab (the GHL iframe can't host Intuit's login — X-Frame-Options),
// and that tab has no app session to render the SPA with.
const DONE_PATH = '/auth/quickbooks/done';

function signOauthState(locationId) {
  return jwt.sign(
    { locationId, purpose: STATE_PURPOSE },
    env.APP_JWT_SECRET,
    { expiresIn: '10m' },
  );
}

/**
 * GET /auth/quickbooks/connect
 * Authenticated (requireAuth). Starts the Intuit OAuth flow, carrying the
 * caller's locationId in a short-lived signed `state` for CSRF-safe association.
 * Cookie-session (standalone/top-level) entry point — a plain navigation can't
 * carry the Bearer token, so the embedded SPA uses /api/quickbooks/connect-url.
 */
export function connectQuickBooks(req, res, next) {
  try {
    const { locationId } = req.user;
    if (!locationId) throw createError(401, 'Authentication required');

    res.redirect(getAuthorizeUrl(signOauthState(locationId)));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/quickbooks/connect-url
 * Authenticated (requireAuth — works with the Bearer token the embedded SPA
 * holds). Returns { url } so the SPA can open Intuit's OAuth in a NEW top-level
 * tab: inside the GHL iframe a same-window navigation dead-ends — the request
 * carries no Bearer header (401) and Intuit refuses to render framed anyway.
 */
export function getQuickBooksConnectUrl(req, res, next) {
  try {
    const { locationId } = req.user;
    if (!locationId) throw createError(401, 'Authentication required');

    res.json({ url: getAuthorizeUrl(signOauthState(locationId)) });
  } catch (err) {
    next(err);
  }
}

// Minimal HTML-escape for the one place we echo a query param into HTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * GET /auth/quickbooks/done?connected=1 | ?error=...
 * Session-less landing page for the OAuth tab. Static HTML only — the app's CSP
 * has no 'unsafe-inline' for scripts, so no inline JS here (inline styles are
 * allowed). The SPA (still open in the GHL iframe) polls /api/quickbooks/config
 * and flips to Connected on its own.
 */
export function quickBooksDone(req, res) {
  const ok = req.query.connected === '1';
  const errText = ok ? '' : escapeHtml(req.query.error || 'The connection was not completed.');
  const title = ok ? 'QuickBooks connected' : 'QuickBooks connection failed';
  const body = ok
    ? 'You can close this tab and return to Synergy — the QuickBooks page updates automatically.'
    : `${errText} — you can close this tab and try again from the QuickBooks page.`;
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6fb;color:#3d3672">
  <div style="max-width:26rem;padding:2.5rem;border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(61,54,114,.12);text-align:center">
    <div style="font-size:2.5rem;line-height:1">${ok ? '&#10004;' : '&#10060;'}</div>
    <h1 style="font-size:1.25rem;margin:.75rem 0 .5rem">${title}</h1>
    <p style="margin:0;color:#666">${body}</p>
    <p style="margin-top:1.5rem"><a href="/buildbridge/quickbooks${ok ? '?connected=1' : ''}" style="color:#1b7895">Open BuildBridge</a></p>
  </div>
</body></html>`);
}

/**
 * GET /auth/quickbooks/callback
 * Intuit redirects here with `code`, `realmId`, and our signed `state`.
 * Not behind requireAuth — trust is established by verifying the state token.
 */
export async function handleQuickBooksCallback(req, res, next) {
  try {
    const { code, realmId, state, error } = req.query;

    if (error) return res.redirect(`${DONE_PATH}?error=${encodeURIComponent(String(error))}`);
    if (!code || !realmId || !state) throw createError(400, 'Missing code, realmId, or state');

    let locationId;
    try {
      const decoded = jwt.verify(String(state), env.APP_JWT_SECRET);
      if (decoded.purpose !== STATE_PURPOSE || !decoded.locationId) {
        throw new Error('bad state');
      }
      locationId = decoded.locationId;
    } catch {
      throw createError(400, 'Invalid or expired OAuth state');
    }

    const tokenData = await exchangeCodeForTokens(code);
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    await saveCredentials(locationId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      realmId: String(realmId),
      expiresAt,
    });

    // Fetch and store the company name straight away, so the connection card can name the
    // business instead of showing a bare realm id from the very first load. Showing only the
    // realm id is why the same QuickBooks company sat connected to two sub-accounts
    // unnoticed (2026-07-28).
    //
    // Doubles as the first real API call with this credential, so it also stamps
    // `last_ok_at` via makeQuickBooksRequest — the connect flow becomes genuinely verified
    // rather than merely "a row exists". Non-fatal: a failure here must not fail a
    // connection that actually succeeded, so the redirect is unconditional.
    try {
      await setCredentialDisplayName(locationId, await getCompanyName(locationId));
    } catch (err) {
      console.warn('[quickbooks] could not read the company name after connect:', err?.message);
    }

    res.redirect(`${DONE_PATH}?connected=1`);
  } catch (err) {
    next(err);
  }
}

// Parse QuickBooks-defined custom fields out of the QBO Preferences payload.
// QBO exposes sales-form custom fields as paired entries under
// SalesFormsPrefs.CustomField: UseSalesCustom<N> (enabled?) + SalesCustomName<N>
// (the label). We return the enabled ones as { id, name }.
// NOTE: the exact QBO Preferences shape can vary by tier — this is defensive and
// needs live validation once a real QuickBooks company is connected.
function parseQboCustomFields(preferences) {
  const groups = preferences?.SalesFormsPrefs?.CustomField ?? [];
  const flat = [];
  for (const g of groups) {
    if (Array.isArray(g?.CustomField)) flat.push(...g.CustomField);
    else if (g) flat.push(g);
  }
  const enabled = {};
  const labels = {};
  for (const f of flat) {
    const name = f?.Name ?? '';
    let m = name.match(/UseSalesCustom(\d+)/i);
    if (m) enabled[m[1]] = f.BooleanValue === true || f.Value === 'true' || f.StringValue === 'true';
    m = name.match(/SalesCustomName(\d+)/i);
    if (m) labels[m[1]] = f.StringValue ?? f.Value ?? '';
  }
  const out = [];
  for (const n of Object.keys(labels)) {
    if (labels[n] && enabled[n] !== false) {
      // Key by the field's label/Name — that's what the customer's CustomField
      // entries expose (CustomField[].Name), so the sync can match on it.
      out.push({ id: labels[n], name: labels[n] });
    }
  }
  return out;
}

/**
 * GET /api/quickbooks/fields
 * The connected QuickBooks company's custom fields, for the mapper dropdown.
 * Returns { fields: [{ id, name }] }; empty list when QuickBooks isn't connected.
 */
export async function getQuickBooksFields(req, res, next) {
  try {
    const { locationId } = req.user;
    const creds = await getCredentialsOrNull(locationId);
    if (!creds) return res.json({ fields: [] }); // not connected yet

    // TWO sources, because QuickBooks has two custom-field systems:
    //   1. Legacy sales-form fields  → REST Preferences (max 3, String, sales forms only)
    //   2. Modern "Custom fields"    → App Foundations GraphQL (incl. Customer-associated,
    //                                   which is what the salesperson mapping needs)
    // Both are queried; a failure in either still returns the other (the GraphQL
    // reader returns [] rather than throwing when the API/scope is unavailable).
    // `failed` is tracked per source so the caller can tell "this company has no custom
    // fields" apart from "we could not ask". Without it the UI printed "No QuickBooks
    // custom fields found yet — make sure custom fields are set up in the QuickBooks
    // company", i.e. it blamed the client's QuickBooks setup for OUR dead token. That is
    // the same lie as the green Connected badge, one card lower down.
    // THIRD source, added 2026-08-01 and in practice the only one that answers on a
    // real company: the names carried on the company's own recent transactions.
    // Rockwood has four sales-form custom fields — `Rep` (the salesperson, value
    // "Cody", marked hidden), `Siding Color`, `Trim Color`, `Roofing Color` — and
    // NEITHER definition source above returns them: Preferences exposes only the
    // three legacy slots, and the App Foundations reader is disabled by default
    // because its scope is gated behind a paid Intuit tier. That is precisely why
    // the picker came up empty and the salesperson mapping could never be set.
    let prefsFailed = false;
    let definitionsFailed = false;
    let txnFailed = false;
    const [prefs, definitions, txnFields] = await Promise.all([
      makeQuickBooksRequest(locationId, 'GET', '/preferences?minorversion=75')
        .then((d) => parseQboCustomFields(d?.Preferences))
        .catch((err) => {
          console.error('[quickbooks] legacy preferences fields failed:', err?.message);
          prefsFailed = true;
          return [];
        }),
      getCustomFieldDefinitions(locationId).catch((err) => {
        console.error('[quickbooks] custom field definitions failed:', err?.message);
        definitionsFailed = true;
        return [];
      }),
      getTransactionCustomFieldNames(locationId).catch((err) => {
        console.error('[quickbooks] transaction custom-field probe failed:', err?.message);
        txnFailed = true;
        return [];
      }),
    ]);

    // Merge, de-duplicated by name (a field can legitimately appear in both when a
    // legacy sales-form slot was migrated into the new manager). `source` lets the UI
    // explain provenance later without another round-trip.
    const byName = new Map();
    for (const f of prefs) byName.set(f.name, { ...f, source: 'sales_form' });
    for (const d of definitions) {
      byName.set(d.name, { ...(byName.get(d.name) ?? {}), ...d, source: 'custom_fields' });
    }
    // Transactions go LAST so a name only they know still lands, but they do not
    // overwrite a definition source's richer metadata (dataType, entity associations).
    for (const t of txnFields) {
      const prev = byName.get(t.name);
      byName.set(t.name, {
        id: t.name, name: t.name,
        ...(prev ?? {}),
        definitionId: prev?.definitionId ?? t.definitionId ?? null,
        seenOn: t.seenOn,
        source: prev?.source ?? 'transaction',
      });
    }

    // `unavailable` means NO source could answer — so an empty list must NOT be read as
    // "this company has no custom fields".
    //
    // This was originally written as `prefsFailed && definitionsFailed`, which could never
    // be true and so made the frontend's whole "we could not read them" branch dead code —
    // the page went on blaming the client's QuickBooks setup for our own dead token, which
    // is the exact bug the flag exists to fix. Reason: getCustomFieldDefinitions returns []
    // on its FIRST line when QBO_ENABLE_CUSTOM_FIELDS_API is off (the default, because the
    // App Foundations scope is not grantable on this Intuit app), and it also swallows
    // 403/non-JSON into []. It therefore almost never throws, so `definitionsFailed` stayed
    // false and ANDing against it pinned the result to false.
    //
    // Phrased as "did any source actually vouch for the connection" instead. A disabled
    // GraphQL reader vouches for nothing, so with the flag off this correctly reduces to
    // `prefsFailed` — Preferences is then the only real source.
    const definitionsAnswered = env.QBO_ENABLE_CUSTOM_FIELDS_API && !definitionsFailed;
    res.json({
      fields: [...byName.values()],
      unavailable: prefsFailed && !definitionsAnswered && txnFailed,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/quickbooks/salesperson-field   { name?: string }
 * Creates/enables a LEGACY sales-form custom field (default name "Salesperson")
 * by sparse-updating QBO Preferences — the one custom-field mechanism the REST
 * API can both write AND read back on every plan without the tier-gated App
 * Foundations scope. The QBO UI no longer exposes these fields, so the app
 * provides the button instead. Returns the refreshed mapper field list so the
 * caller can confirm visibility in one round-trip.
 */
export async function createSalespersonField(req, res, next) {
  try {
    const { locationId } = req.user;
    const creds = await getCredentialsOrNull(locationId);
    if (!creds) return res.status(400).json({ error: 'QuickBooks is not connected' });

    const raw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = (raw || 'Salesperson').slice(0, 31); // QBO's custom-field label cap

    const result = await enableLegacySalesCustomField(locationId, name);

    // Confirm through the same parser the mapper dropdown uses.
    const data = await makeQuickBooksRequest(locationId, 'GET', '/preferences?minorversion=75');
    const fields = parseQboCustomFields(data?.Preferences);

    res.json({
      success: true,
      variant: result.variant,
      visibleToApi: fields.some((f) => f.name === name),
      fields,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/quickbooks/items
 * The connected QuickBooks company's active items (Products & Services), for the
 * item-mapper dropdown. Returns { items: [{ id, name, type, unitPrice, description }] };
 * empty list when QuickBooks isn't connected.
 */
export async function getQuickBooksItems(req, res, next) {
  try {
    const { locationId } = req.user;
    const creds = await getCredentialsOrNull(locationId);
    if (!creds) return res.json({ items: [] }); // not connected yet

    // Caught rather than propagated: this used to 5xx on a dead token, and the frontend
    // turned `!r.ok` into an empty array — which rendered as "No QuickBooks items found
    // yet. Make sure Products & Services exist in the QuickBooks company". A 200 carrying
    // an explicit `unavailable` flag is the only shape the UI can tell the truth from.
    // The failure is still recorded: makeQuickBooksRequest tags it and marks the
    // credential broken before throwing.
    try {
      const items = await listItems(locationId);
      return res.json({ items });
    } catch (err) {
      console.error('[quickbooks] item list failed:', err?.message);
      return res.json({ items: [], unavailable: true });
    }
  } catch (err) {
    next(err);
  }
}

// Turn a stored credential failure into something a shed-business owner can act on.
//
// The raw text is NEVER sent to the browser. It can carry Intuit's response body, a
// request path, or an intuit_tid — internal detail that means nothing to a client and
// invites them to paste it into a support chat instead of just reconnecting. Each branch
// says what happened AND what to do about it, because "QuickBooks error" with no next
// step is barely better than the green check it replaces.
function describeCredentialFailure(raw) {
  const text = String(raw ?? '');
  if (/invalid_grant|refresh token/i.test(text)) {
    return 'QuickBooks no longer accepts the saved connection — this happens if access was removed in QuickBooks, or if the same QuickBooks company was connected somewhere else. Reconnect below to fix it.';
  }
  if (/HTTP 40[13]|rejected the stored credential/i.test(text)) {
    return 'QuickBooks rejected the saved connection. Reconnect below to fix it.';
  }
  return 'The last attempt to reach QuickBooks failed. Reconnect below, or contact CSM Synergy support if it keeps happening.';
}

/**
 * Derive the three-state connection health from the stored row.
 *
 * Three states, not two, and the third one is the point: `unverified` means a credential
 * exists but we have not yet observed it working (a brand-new connection, or a row that
 * predates the 0006 health columns). Collapsing that into either "ok" or "broken" is how
 * you get back to a badge that asserts more than it knows.
 */
function credentialHealth(health) {
  if (health?.lastError) {
    return {
      state: 'broken',
      message: describeCredentialFailure(health.lastError),
      lastOkAt: health.lastOkAt ?? null,
      lastErrorAt: health.lastErrorAt ?? null,
    };
  }
  if (health?.lastOkAt) {
    return { state: 'ok', message: null, lastOkAt: health.lastOkAt, lastErrorAt: null };
  }
  return { state: 'unverified', message: null, lastOkAt: null, lastErrorAt: null };
}

/**
 * GET /api/quickbooks/config
 * Returns the connection status for the current location (no secrets).
 *
 * "Connected" used to mean nothing more than "a row exists", which is why both live
 * locations showed a green check for 20+ hours while every sync failed (2026-07-28). The
 * row now carries health, so this endpoint answers the question the UI actually asks —
 * and it stays a SINGLE query, because the health lives on the row it already reads.
 * That matters: the connect flow polls this endpoint every 3s.
 */
export async function getQuickBooksConfig(req, res, next) {
  try {
    const { locationId } = req.user;
    const record = await getCredentialRecord(locationId);

    if (!record) return res.json({ config: null });

    res.json({
      config: {
        realmId: record.creds.realmId,
        // The company name, persisted (0007) rather than held in frontend state after a
        // Test click — so it survives a page reload, which is the whole point.
        companyName: record.displayName,
        environment: env.QBO_ENVIRONMENT,
        connectedAt: record.health.connectedAt,
      },
      health: credentialHealth(record.health),
    });
  } catch (err) {
    next(err);
  }
}

// ─── Milestone definitions (per-client milestone configuration, migration 0007) ──
// Replaces the four hard-coded milestone types. A milestone is the client's own pair of
// GHL opportunity fields (amount + optional date) plus the label that prints on the
// QuickBooks invoice line. All four handlers are location-scoped by req.user.locationId —
// an id from another tenant 404s rather than being silently ignored.

/** GET /api/quickbooks/milestones */
export async function getMilestoneDefinitions(req, res, next) {
  try {
    const rows = await listMilestoneDefinitions(req.user.locationId);
    res.json({ definitions: rows.map(serializeDefinition) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/quickbooks/milestones */
export async function addMilestoneDefinition(req, res, next) {
  try {
    const row = await createMilestoneDefinition(req.user.locationId, req.body ?? {});
    res.status(201).json({ definition: serializeDefinition(row) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/quickbooks/milestones/:id */
export async function editMilestoneDefinition(req, res, next) {
  try {
    const row = await updateMilestoneDefinition(req.user.locationId, req.params.id, req.body ?? {});
    res.json({ definition: serializeDefinition(row) });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/quickbooks/milestones/:id */
export async function removeMilestoneDefinition(req, res, next) {
  try {
    await deleteMilestoneDefinition(req.user.locationId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/quickbooks/health
 * The expensive half of the status picture, deliberately kept OUT of /config so the
 * 3-second connect poller stays a single query: last successful sync, plus any open
 * problems for this location.
 *
 * Reading error_events rather than instrumenting each failure site is intentional — that
 * table already durably records EVERY failure kind with dedupe and counts, including ones
 * that have nothing to do with the QuickBooks token (Rockwood's real breakage on
 * 2026-07-29 was a GoHighLevel 400). A card that only knew about credential health would
 * have gone green for Rockwood while its sync was still completely broken: the same lie,
 * one layer further out.
 */
export async function getQuickBooksHealth(req, res, next) {
  try {
    const { locationId } = req.user;
    // The credential's last proven-good moment. Needed so a problem that stopped happening
    // BEFORE QuickBooks last worked drops off the card immediately — otherwise reconnecting
    // leaves the tenant staring at the failures that made them reconnect.
    const record = await getCredentialRecord(locationId).catch(() => null);
    const lastOkAt = record?.health?.lastOkAt ?? null;

    // qb_sync_state read inline rather than via qbSyncService: setSyncState/getSyncSince
    // are module-private there, and importing that module into a controller would pull the
    // entire sync chain (GHL + QBO services) in behind one timestamp.
    const state = await db.select().from(qbSyncState)
      .where(eq(qbSyncState.locationId, locationId)).limit(1)
      .then((r) => r[0] ?? null)
      .catch(() => null);

    // Sequential, not parallel, because the issue filter NEEDS the sync cursor: a failed
    // scheduled pass is only disproved by a pass that completed, and that cursor is the only
    // timestamp meaning exactly that. Costs no extra query — this row was already being read.
    const { issues, totalDistinct } = await listOpenIssues(locationId, QUICKBOOKS_SLUG, 5, {
      lastOkAt,
      lastSyncAt: state?.lastSyncAt ?? null,
    });

    res.json({
      // NOTE: this is the sync CURSOR (qbSyncService writes it as the last statement of a
      // pass, so a throw anywhere earlier leaves it untouched). That makes it a fair
      // "last fully successful sync" for display, but it is null for a location that has
      // never completed one — which is Rockwood's actual current state, and must render
      // as "never", not as "just now".
      lastSyncAt: state?.lastSyncAt ?? null,
      issues,
      // So the card can say "5 of 7 shown" rather than truncating in silence.
      totalIssues: totalDistinct,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/quickbooks/test
 * On-demand "is this actually working?" probe, so nobody has to wait up to 15 minutes for
 * the cron to reveal a dead connection.
 *
 * Uses CompanyInfo rather than forcing a token refresh: Intuit ROTATES refresh tokens, so
 * a probe that always refreshed would invalidate the prior token on every press — the
 * exact mechanic that killed these credentials when one company was connected to two
 * locations. CompanyInfo exercises the stored token (refreshing only if genuinely near
 * expiry), so health updates as a side effect via makeQuickBooksRequest/saveCredentials.
 *
 * Returns the company NAME, which is the other half of the 2026-07-28 confusion: the card
 * showed only a bare realm id, so two locations pointing at the same QuickBooks company
 * looked completely normal.
 */
export async function testQuickBooksConnection(req, res, next) {
  try {
    const { locationId } = req.user;
    const record = await getCredentialRecord(locationId);
    if (!record) return res.status(400).json({ error: 'QuickBooks is not connected' });
    const creds = record.creds;

    try {
      const companyName = await getCompanyName(locationId);
      // Refresh the stored name on every successful test, so it self-heals for connections
      // made before 0007 and follows a company rename. Passing the current value keeps this
      // a no-op in the common case where nothing changed.
      await setCredentialDisplayName(locationId, companyName, record.displayName);
      return res.json({ ok: true, companyName, realmId: creds.realmId, checkedAt: new Date().toISOString() });
    } catch (err) {
      // A failed probe is a SUCCESSFUL test — it answered the question. Returning 200
      // with ok:false keeps it distinguishable from "the test itself broke", which the
      // frontend must not render as a dead QuickBooks connection.
      return res.json({
        ok: false,
        message: describeCredentialFailure(err?.message),
        checkedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    next(err);
  }
}

// Shape the settings row into the public JSON the frontend consumes.
function serializeSettings(s) {
  return {
    qboSyncDirection: s.qboSyncDirection ?? 'off',
    qboMilestoneInvoicing: s.qboMilestoneInvoicing,
    qboContactSyncPipelineId: s.qboContactSyncPipelineId ?? null,
    qboAssignedUserField: s.qboAssignedUserField ?? null,
    qboAssignedUserGhlField: s.qboAssignedUserGhlField ?? null,
    qboStatusGhlField: s.qboStatusGhlField ?? null,
    qboSalespersonQbField: s.qboSalespersonQbField ?? null,
    qboSalespersonSlot: s.qboSalespersonSlot ?? 1,
    qboSalespersonGhlField: s.qboSalespersonGhlField ?? null,
    qboInvoiceLeadDays: s.qboInvoiceLeadDays,
  };
}

/**
 * GET /api/quickbooks/settings
 * Per-tenant QuickBooks feature configuration for the current location.
 */
export async function getQuickBooksSettings(req, res, next) {
  try {
    const { locationId } = req.user;
    const settings = await getLocationSettings(locationId);
    res.json({ settings: serializeSettings(settings) });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/quickbooks/settings
 * Update the current location's QuickBooks feature toggles / config.
 */
export async function saveQuickBooksSettings(req, res, next) {
  try {
    const { locationId } = req.user;
    const {
      qboSyncDirection,
      qboMilestoneInvoicing,
      qboContactSyncPipelineId,
      qboAssignedUserField,
      qboAssignedUserGhlField,
      qboStatusGhlField,
      qboSalespersonQbField,
      qboSalespersonSlot,
      qboSalespersonGhlField,
      qboInvoiceLeadDays,
    } = req.body;

    const row = await upsertLocationSettings(locationId, {
      qboSyncDirection,
      qboMilestoneInvoicing,
      qboContactSyncPipelineId,
      qboAssignedUserField,
      qboAssignedUserGhlField,
      qboStatusGhlField,
      qboSalespersonQbField,
      qboSalespersonSlot,
      qboSalespersonGhlField,
      qboInvoiceLeadDays,
    });

    res.json({ settings: serializeSettings(row) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/quickbooks/config
 * Disconnects QuickBooks: best-effort token revoke at Intuit, then removes the
 * stored credential row for this location.
 */
export async function disconnectQuickBooks(req, res, next) {
  try {
    const { locationId } = req.user;

    await revokeToken(locationId);

    await db
      .delete(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, QUICKBOOKS_SLUG),
        ),
      );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
