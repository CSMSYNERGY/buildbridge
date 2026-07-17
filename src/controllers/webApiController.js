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
import * as deposytService from '../services/deposytService.js';
import * as subscriptionService from '../services/subscriptionService.js';
import { makeGhlRequest } from '../services/ghlService.js';

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

    res.json({ plans: rows, grouped });
  } catch (err) {
    next(err);
  }
}

// ─── Current location's active subscriptions ──────────────────────────────────

export async function getMySubscriptions(req, res, next) {
  try {
    const { locationId } = req.user;
    const subscriptions = await subscriptionService.getActiveSubscriptions(locationId);
    res.json({ subscriptions });
  } catch (err) {
    next(err);
  }
}

// ─── Subscription create / cancel ─────────────────────────────────────────────

export async function createSubscriptionHandler(req, res, next) {
  try {
    const { locationId } = req.user;
    const { planId, name, email } = req.body;

    if (!planId) throw createError(400, 'planId is required');

    // Guard against duplicate subscriptions from a double-click / retry: don't
    // create a second Deposyt subscription for a plan this location already has.
    const existing = await subscriptionService.getActiveSubscriptions(locationId);
    if (existing.some((s) => s.planId === planId)) {
      throw createError(409, 'An active subscription for this plan already exists');
    }

    // Create the subscription in Deposyt first
    const deposytSub = await deposytService.createSubscription(planId, {
      name,
      email,
      locationId,
    });

    // Persist locally
    const sub = await subscriptionService.createSubscription(
      locationId,
      deposytSub.id,
      planId,
      deposytSub.current_period_end
        ? new Date(deposytSub.current_period_end * 1000)
        : null,
    );

    res.status(201).json({ subscription: sub });
  } catch (err) {
    next(err);
  }
}

export async function cancelSubscriptionHandler(req, res, next) {
  try {
    const { locationId } = req.user;
    const { deposytSubId } = req.body;

    if (!deposytSubId) throw createError(400, 'deposytSubId is required');

    // Ownership check FIRST — the subscription must belong to the caller's
    // location. Without this, any tenant could cancel another tenant's
    // subscription (and their Deposyt billing) by supplying its id (IDOR).
    const [owned] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, deposytSubId), eq(subscriptions.locationId, locationId)))
      .limit(1);
    if (!owned) throw createError(404, 'Subscription not found');

    // Cancel in Deposyt
    await deposytService.cancelSubscription(deposytSubId);

    // Update local record
    const sub = await subscriptionService.cancelSubscription(deposytSubId);

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

    const data = await makeGhlRequest(locationId, 'GET', '/contacts/custom-fields');

    // GHL returns { customFields: [{ id, name, fieldKey, dataType, ... }] }
    const fields = (data?.customFields ?? []).map((f) => ({
      key: f.fieldKey ?? f.id,
      id: f.id,
      label: f.name ?? f.fieldKey ?? f.id, // never null → frontend filter won't crash
    }));

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
