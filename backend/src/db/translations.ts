// src/db/translations.ts — §5B localized-content lookup over content_translations
// (PK entity_type, entity_id, locale, field). Read with an `en` fallback so a
// missing translation degrades gracefully to the base edition. Broad per-entity
// wiring is incremental; this session wires the book/doc resource only.
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, contentTranslations } from './client';
import { DEFAULT_LOCALE } from '../utils/locale';

type Db = typeof defaultDb;

/**
 * Upsert one localized (entityType, entityId, locale, field) cell — the write side of the
 * §5B overlay. Idempotent on the (entity_type, entity_id, locale, field) unique key. Used by
 * the ontology i18n seed and the tenant-entity translation write API (3.7).
 */
export async function upsertTranslation(
  entityType: string,
  entityId: string,
  locale: string,
  field: string,
  value: string,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .insert(contentTranslations)
    .values({ entity_type: entityType, entity_id: entityId, locale, field, value })
    .onConflictDoUpdate({
      target: [
        contentTranslations.entity_type,
        contentTranslations.entity_id,
        contentTranslations.locale,
        contentTranslations.field,
      ],
      set: { value, updated_at: new Date() },
    });
}

/** Delete one localized cell (a blanked field falls back to the en base column). */
export async function deleteTranslation(
  entityType: string,
  entityId: string,
  locale: string,
  field: string,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .delete(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, entityType),
        eq(contentTranslations.entity_id, entityId),
        eq(contentTranslations.locale, locale),
        eq(contentTranslations.field, field),
      ),
    );
}

/** All localized cells for one (entityType, entityId), across every locale + field — the
 *  read side of the tenant-entity translation editor (3.7). */
export async function listTranslations(
  entityType: string,
  entityId: string,
  db: Db = defaultDb,
): Promise<{ locale: string; field: string; value: string }[]> {
  return db
    .select({
      locale: contentTranslations.locale,
      field: contentTranslations.field,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, entityType),
        eq(contentTranslations.entity_id, entityId),
      ),
    );
}

/**
 * Return the localized value for (entityType, entityId, field) in `locale`,
 * falling back to the default-locale row, else `null` when neither exists.
 */
export async function getTranslation(
  entityType: string,
  entityId: string,
  locale: string,
  field: string,
  db: Db = defaultDb,
): Promise<string | null> {
  const pick = async (loc: string): Promise<string | null> => {
    const [row] = await db
      .select({ value: contentTranslations.value })
      .from(contentTranslations)
      .where(
        and(
          eq(contentTranslations.entity_type, entityType),
          eq(contentTranslations.entity_id, entityId),
          eq(contentTranslations.locale, loc),
          eq(contentTranslations.field, field),
        ),
      )
      .limit(1);
    return row?.value ?? null;
  };
  return (await pick(locale)) ?? (locale === DEFAULT_LOCALE ? null : await pick(DEFAULT_LOCALE));
}

/**
 * Batched localized-field lookup for overlaying list/detail rows. Returns a map
 * `entityId → { field: value }` for the requested `locale` only (one query for the
 * whole set). For the default locale — or an empty id/field set — returns an empty
 * map: the base columns are already the `en` edition, so the caller keeps them.
 * Missing (entity, field) translations are simply absent → caller falls back to the
 * base column. This is the read side of the UGC i18n overlay (§5B).
 */
export async function getTranslationsBatch(
  entityType: string,
  entityIds: string[],
  locale: string,
  fields: string[],
  db: Db = defaultDb,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (locale === DEFAULT_LOCALE || entityIds.length === 0 || fields.length === 0) {
    return out;
  }
  const rows = await db
    .select({
      entity_id: contentTranslations.entity_id,
      field: contentTranslations.field,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, entityType),
        inArray(contentTranslations.entity_id, entityIds),
        eq(contentTranslations.locale, locale),
        inArray(contentTranslations.field, fields),
      ),
    );
  for (const r of rows) {
    const m = out.get(r.entity_id) ?? {};
    m[r.field] = r.value;
    out.set(r.entity_id, m);
  }
  return out;
}
