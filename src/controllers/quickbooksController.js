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
} from '../services/quickbooksService.js';
import {
  getLocationSettings,
  upsertLocationSettings,
} from '../services/locationSettingsService.js';

const QUICKBOOKS_SLUG = 'quickbooks';
const STATE_PURPOSE = 'qbo_oauth';

// Where to send the browser back to after the OAuth round-trip.
const RETURN_PATH = '/buildbridge/quickbooks';

/**
 * GET /auth/quickbooks/connect
 * Authenticated (requireAuth). Starts the Intuit OAuth flow, carrying the
 * caller's locationId in a short-lived signed `state` for CSRF-safe association.
 */
export function connectQuickBooks(req, res, next) {
  try {
    const { locationId } = req.user;
    if (!locationId) throw createError(401, 'Authentication required');

    const state = jwt.sign(
      { locationId, purpose: STATE_PURPOSE },
      env.APP_JWT_SECRET,
      { expiresIn: '10m' },
    );

    res.redirect(getAuthorizeUrl(state));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /auth/quickbooks/callback
 * Intuit redirects here with `code`, `realmId`, and our signed `state`.
 * Not behind requireAuth — trust is established by verifying the state token.
 */
export async function handleQuickBooksCallback(req, res, next) {
  try {
    const { code, realmId, state, error } = req.query;

    if (error) return res.redirect(`${RETURN_PATH}?error=${encodeURIComponent(String(error))}`);
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

    res.redirect(`${RETURN_PATH}?connected=1`);
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
