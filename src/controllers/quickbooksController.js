import jwt from 'jsonwebtoken';
import { db } from '../core/db/client.js';
import { integrationCredentials } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { env } from '../core/env.js';
import { createError } from '../core/middleware/errorHandler.js';
import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  saveCredentials,
  getCredentialsOrNull,
  revokeToken,
  makeQuickBooksRequest,
  getCustomFieldDefinitions,
  listItems,
} from '../services/quickbooksService.js';
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
    const [prefs, definitions] = await Promise.all([
      makeQuickBooksRequest(locationId, 'GET', '/preferences?minorversion=75')
        .then((d) => parseQboCustomFields(d?.Preferences))
        .catch((err) => {
          console.error('[quickbooks] legacy preferences fields failed:', err?.message);
          return [];
        }),
      getCustomFieldDefinitions(locationId).catch((err) => {
        console.error('[quickbooks] custom field definitions failed:', err?.message);
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

    res.json({ fields: [...byName.values()] });
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

    const items = await listItems(locationId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/quickbooks/config
 * Returns the connection status for the current location (no secrets).
 */
export async function getQuickBooksConfig(req, res, next) {
  try {
    const { locationId } = req.user;
    const creds = await getCredentialsOrNull(locationId);

    if (!creds) return res.json({ config: null });

    res.json({
      config: {
        realmId: creds.realmId,
        environment: env.QBO_ENVIRONMENT,
      },
    });
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
      qboInvoiceLeadDays,
    } = req.body;

    const row = await upsertLocationSettings(locationId, {
      qboSyncDirection,
      qboMilestoneInvoicing,
      qboContactSyncPipelineId,
      qboAssignedUserField,
      qboAssignedUserGhlField,
      qboStatusGhlField,
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
