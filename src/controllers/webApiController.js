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
    res.json({ plans: rows });
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
