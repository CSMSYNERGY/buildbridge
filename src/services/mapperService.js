import { db } from '../core/db/client.js';
import { mappers } from '../core/db/schema.js';
import { eq, and } from 'drizzle-orm';

/**
 * Load mappers for a location as a lookup map: externalKey → ghlValue.
 * Optionally scoped by appSlug and mapperType.
 */
export async function getMappings(locationId, appSlug, mapperType) {
  const conditions = [eq(mappers.locationId, locationId)];
  if (appSlug) conditions.push(eq(mappers.appSlug, appSlug));
  if (mapperType) conditions.push(eq(mappers.mapperType, mapperType));

  const rows = await db
    .select()
    .from(mappers)
    .where(and(...conditions));

  const map = {};
  for (const row of rows) map[row.externalKey] = row.ghlValue;
  return map;
}

/**
 * Reverse lookup map: ghlValue → externalKey. Useful when translating from
 * GHL back to the external system (e.g. GHL stage → QBO status).
 */
export async function getReverseMappings(locationId, appSlug, mapperType) {
  const forward = await getMappings(locationId, appSlug, mapperType);
  const reverse = {};
  for (const [externalKey, ghlValue] of Object.entries(forward)) {
    reverse[ghlValue] = externalKey;
  }
  return reverse;
}

/**
 * List raw mapper rows for a location (optionally by appSlug/mapperType).
 */
export async function listMappers(locationId, appSlug, mapperType) {
  const conditions = [eq(mappers.locationId, locationId)];
  if (appSlug) conditions.push(eq(mappers.appSlug, appSlug));
  if (mapperType) conditions.push(eq(mappers.mapperType, mapperType));

  return db.select().from(mappers).where(and(...conditions));
}
