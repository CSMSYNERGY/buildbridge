import { db } from '../core/db/client.js';
import {
  plans,
  mappers,
  integrationCredentials,
} from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../core/middleware/encrypt.js';
import { createError } from '../core/middleware/errorHandler.js';
import { randomUUID } from 'crypto';
import * as deposytService from '../services/deposytService.js';
import * as subscriptionService from '../services/subscriptionService.js';

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

// ─── Subscription create / cancel ─────────────────────────────────────────────

export async function createSubscriptionHandler(req, res, next) {
  try {
    const { locationId } = req.user;
    const { planId, name, email } = req.body;

    if (!planId) throw createError(400, 'planId is required');

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

export async function createMapper(req, res, next) {
  try {
    const { locationId } = req.user;
    const { appSlug, mapperType, externalKey, ghlValue } = req.body;

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

    res.json({ config: JSON.parse(decrypt(row.encryptedPayload)) });
  } catch (err) {
    next(err);
  }
}

export async function saveSmartBuildConfig(req, res, next) {
  try {
    const { locationId } = req.user;
    const config = req.body;

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
