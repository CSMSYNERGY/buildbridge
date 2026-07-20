import { db } from '../core/db/client.js';
import {
  plans,
  mappers,
  integrationCredentials,
  subscriptions,
} from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../core/middleware/encrypt.js';
import { createError } from '../core/middleware/errorHandler.js';
import { randomUUID } from 'crypto';
import * as nmiService from '../services/nmiService.js';
import * as subscriptionService from '../services/subscriptionService.js';
import { makeGhlRequest } from '../services/ghlService.js';
import { env } from '../core/env.js';

// ─── Me ──────────────────────────────────────────────────────────────────────

export function getMe(req, res) {
  res.json({ user: req.user });
}

// ─── Plans ───────────────────────────────────────────────────────────────────

export async function getPlans(_req, res, next) {
  try {
    const rows = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true));

    // Group by appSlug for convenient frontend consumption
    const grouped = rows.reduce((acc, plan) => {
      if (!acc[plan.appSlug]) acc[plan.appSlug] = [];
      acc[plan.appSlug].push(plan);
      return acc;
    }, {});

    res.json({
      plans: rows,
      grouped,
      // Public checkout config for Collect.js. The tokenization key is a public
      // client-side key (safe to expose); the private security key stays server-side.
      checkout: {
        tokenizationKey: env.NMI_TOKENIZATION_KEY,
        collectJsUrl: `${env.NMI_GATEWAY_URL.replace(/\/+$/, '')}/token/Collect.js`,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Subscription create / cancel ─────────────────────────────────────────────

export async function createSubscriptionHandler(req, res, next) {
  try {
    const { locationId } = req.user;
    const { planId, paymentToken, name, email } = req.body;

    if (!planId) throw createError(400, 'planId is required');
    if (!paymentToken) throw createError(400, 'paymentToken is required');

    // Validate the plan exists and is active.
    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.isActive, true)))
      .limit(1);
    if (!plan) throw createError(404, `Unknown or inactive plan: ${planId}`);

    const nameParts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ');

    // Start the recurring subscription in the NMI/Deposyt gateway with the
    // Collect.js token, against the mapped gateway plan.
    const nmiSub = await nmiService.createSubscription({
      appPlanId: planId,
      paymentToken,
      firstName,
      lastName,
      email,
      locationId,
    });

    // Estimate the current period end from the plan's billing interval; a gateway
    // webhook can refine it later.
    const days = plan.billingInterval === 'annual' ? 365 : 30;
    const periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const sub = await subscriptionService.createSubscription(
      locationId,
      nmiSub.subscriptionId,
      planId,
      periodEnd,
    );

    res.status(201).json({ subscription: sub });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/subscription/mine — active subscriptions for the caller's location,
 * joined with plan details (powers the "current plan" UI).
 */
export async function getMySubscriptions(req, res, next) {
  try {
    const { locationId } = req.user;
    const rows = await subscriptionService.getActiveSubscriptions(locationId);
    res.json({ subscriptions: rows });
  } catch (err) {
    next(err);
  }
}

export async function cancelSubscriptionHandler(req, res, next) {
  try {
    const { locationId } = req.user;
    const { subscriptionId } = req.body;

    if (!subscriptionId) throw createError(400, 'subscriptionId is required');

    // Verify the subscription belongs to this location before cancelling it.
    const [owned] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.locationId, locationId)))
      .limit(1);
    if (!owned) throw createError(404, 'Subscription not found');

    // Cancel in the gateway, then mark the local record cancelled.
    await nmiService.cancelSubscription(subscriptionId);
    const sub = await subscriptionService.cancelSubscription(subscriptionId);

    res.json({ success: true, subscription: sub });
  } catch (err) {
    next(err);
  }
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export async function getMappers(req, res, next) {
  try {
    const { locationId } = req.user;
    const { appSlug } = req.query;

    const rows = await db
      .select()
      .from(mappers)
      .where(
        appSlug
          ? and(eq(mappers.locationId, locationId), eq(mappers.appSlug, appSlug))
          : eq(mappers.locationId, locationId),
      );

    res.json({ mappers: rows });
  } catch (err) {
    next(err);
  }
}

// ─── GHL Fields ──────────────────────────────────────────────────────────────

export async function getGhlFields(req, res, next) {
  try {
    const { locationId } = req.user;

    // Never null → the frontend mapper dropdown won't crash on a missing label.
    // Opportunity fields are suffixed so they're distinguishable from a contact
    // field with the same name in the dropdown.
    const mapField = (f, model) => ({
      key: f.fieldKey ?? f.id,
      id: f.id,
      model,
      label: `${f.name ?? f.fieldKey ?? f.id}${model === 'opportunity' ? ' (opportunity)' : ''}`,
    });

    // Contact custom fields — the primary set most mappings use.
    // GHL returns { customFields: [{ id, name, fieldKey, dataType, ... }] }
    const contactData = await makeGhlRequest(locationId, 'GET', '/contacts/custom-fields');
    const fields = (contactData?.customFields ?? []).map((f) => mapField(f, 'contact'));

    // Opportunity custom fields — best-effort. The GHL v2 endpoint/shape can vary
    // by account, so a failure here must NOT break the (working) contact list.
    try {
      const oppData = await makeGhlRequest(
        locationId,
        'GET',
        `/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`,
      );
      const seen = new Set(fields.map((f) => f.id));
      for (const f of oppData?.customFields ?? []) {
        if (f?.id && !seen.has(f.id)) {
          seen.add(f.id);
          fields.push(mapField(f, 'opportunity'));
        }
      }
    } catch (e) {
      console.warn(`[ghl] opportunity custom-fields fetch failed for ${locationId}: ${e?.message || e}`);
    }

    res.json({ fields });
  } catch (err) {
    next(err);
  }
}

// ─── GHL Pipelines ─────────────────────────────────────────────────────────

export async function getGhlPipelines(req, res, next) {
  try {
    const { locationId } = req.user;

    const data = await makeGhlRequest(
      locationId,
      'GET',
      `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    );

    // GHL returns { pipelines: [{ id, name, stages: [{ id, name }] }] }
    const pipelines = (data?.pipelines ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })),
    }));

    res.json({ pipelines });
  } catch (err) {
    next(err);
  }
}

export async function createMapper(req, res, next) {
  try {
    const { locationId } = req.user;
    const { appSlug, mapperType, externalKey, ghlValue } = req.body;

    if (!appSlug || !mapperType || !externalKey || !ghlValue) {
      throw createError(400, 'appSlug, mapperType, externalKey, and ghlValue are required');
    }

    // Upsert on the (location, app, type, externalKey) unique index so a repeat
    // save updates the value instead of surfacing a unique-violation as a 500.
    const [row] = await db
      .insert(mappers)
      .values({
        id: randomUUID(),
        locationId,
        appSlug,
        mapperType,
        externalKey,
        ghlValue,
      })
      .onConflictDoUpdate({
        target: [mappers.locationId, mappers.appSlug, mappers.mapperType, mappers.externalKey],
        set: { ghlValue, updatedAt: new Date() },
      })
      .returning();

    res.status(201).json({ mapper: row });
  } catch (err) {
    next(err);
  }
}

export async function updateMapper(req, res, next) {
  try {
    const { locationId } = req.user;
    const { id } = req.params;
    const { ghlValue } = req.body;

    const [row] = await db
      .update(mappers)
      .set({ ghlValue, updatedAt: new Date() })
      .where(and(eq(mappers.id, id), eq(mappers.locationId, locationId)))
      .returning();

    if (!row) throw createError(404, 'Mapper not found');
    res.json({ mapper: row });
  } catch (err) {
    next(err);
  }
}

export async function deleteMapper(req, res, next) {
  try {
    const { locationId } = req.user;
    const { id } = req.params;

    const [row] = await db
      .delete(mappers)
      .where(and(eq(mappers.id, id), eq(mappers.locationId, locationId)))
      .returning();

    if (!row) throw createError(404, 'Mapper not found');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ─── SmartBuild Config (integration_credentials) ─────────────────────────────

const SMARTBUILD_SLUG = 'smartbuild';

export async function getSmartBuildConfig(req, res, next) {
  try {
    const { locationId } = req.user;

    const [row] = await db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, SMARTBUILD_SLUG),
        ),
      )
      .limit(1);

    if (!row) return res.json({ config: null });

    const { username, baseUrl } = JSON.parse(decrypt(row.encryptedPayload));
    res.json({ config: { username, baseUrl } });
  } catch (err) {
    next(err);
  }
}

export async function testSmartBuildConnection(req, res, next) {
  try {
    const { baseUrl, username, password } = req.body;
    if (!baseUrl || !username || !password) {
      throw createError(400, 'baseUrl, username, and password are required');
    }

    const { login } = await import('../services/smartbuildService.js');
    await login(baseUrl, username, password);

    res.json({ success: true });
  } catch (err) {
    // Return a friendly error rather than a 5xx so the frontend can display it
    if (err.status === 401 || err.status === 400) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    next(err);
  }
}

export async function deleteSmartBuildConfig(req, res, next) {
  try {
    const { locationId } = req.user;

    await db
      .delete(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.locationId, locationId),
          eq(integrationCredentials.appSlug, SMARTBUILD_SLUG),
        ),
      );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function saveSmartBuildConfig(req, res, next) {
  try {
    const { locationId } = req.user;
    const { username, password, baseUrl } = req.body;

    if (!username || !baseUrl) {
      throw createError(400, 'username and baseUrl are required');
    }

    // If no password provided, keep the existing one
    let resolvedPassword = password;
    if (!resolvedPassword) {
      const [existing] = await db
        .select()
        .from(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.locationId, locationId),
            eq(integrationCredentials.appSlug, SMARTBUILD_SLUG),
          ),
        )
        .limit(1);
      if (!existing) throw createError(400, 'password is required for new connections');
      resolvedPassword = JSON.parse(decrypt(existing.encryptedPayload)).password;
    }

    const config = { username, password: resolvedPassword, baseUrl };
    const encryptedPayload = encrypt(JSON.stringify(config));

    const [row] = await db
      .insert(integrationCredentials)
      .values({
        id: randomUUID(),
        locationId,
        appSlug: SMARTBUILD_SLUG,
        encryptedPayload,
      })
      .onConflictDoUpdate({
        target: [integrationCredentials.locationId, integrationCredentials.appSlug],
        set: { encryptedPayload, updatedAt: new Date() },
      })
      .returning();

    res.json({ success: true, id: row.id });
  } catch (err) {
    next(err);
  }
}
