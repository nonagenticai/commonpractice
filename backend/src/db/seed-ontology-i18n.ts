// src/db/seed-ontology-i18n.ts — write the curated ontology entity/attribute/relation
// translations on a FRESH developer / CI database.
//
// ⛔ THIS IS THE HALF THAT DOES **NOT** REACH PRODUCTION, AND KNOWING THAT IS THE POINT.
// The live Deployment sets `SEED_DEMO_DATA=false` and `src/server.ts` only calls `seedAll()` when
// that flag is true, so this function has never run against prod. For four phases the ontology
// translations existed only here, and the Dutch `/ontology` graph rendered English edge labels the
// whole time. The artifact that actually lands is `migrations/0080_ontology_i18n.sql`
// (`applyMigrations()` runs on EVERY boot) — GENERATED from the same builder this calls, so the
// two halves are the same rows by construction rather than by discipline.
//
// Neither half is redundant: `bun run migrate` runs BEFORE `bun run seed`, so on a new cluster
// 0080 executes against an EMPTY `ontology_entities` (the rows still land — content_translations
// has no foreign key) and this seeder then writes the identical set.
//
// The CONTENT and the builder live in src/ontology/i18n-seed.ts. Nothing is authored here.
import { sql } from 'drizzle-orm';
import { db, contentTranslations } from './client';
import { buildOntologyI18nRows } from '../ontology/i18n-seed';

/**
 * Idempotently seed ontology entity/attribute/relation translations. Returns the number of
 * (entity, locale, field) rows written.
 *
 * One bulk upsert on `content_translations_pk`, mirroring seedTemplateTranslations() — the
 * previous shape issued one `upsertTranslation` round trip PER CELL (385 of them), which is also
 * why tests/ontology-i18n.test.ts needs an explicit 30s hook timeout.
 *
 * ⛔ GLOBAL rows only. Tenant-authored ontology prose lives under the `*_tenant` entity types and
 * is the LLM pipeline's job, not ours.
 */
export async function seedOntologyI18n(): Promise<{ rows: number }> {
  const rows = buildOntologyI18nRows();
  if (!rows.length) return { rows: 0 };
  await db
    .insert(contentTranslations)
    .values(
      rows.map((r) => ({
        entity_type: r.entityType,
        entity_id: r.entityId,
        locale: r.locale,
        field: r.field,
        value: r.value,
      })),
    )
    .onConflictDoUpdate({
      target: [
        contentTranslations.entity_type,
        contentTranslations.entity_id,
        contentTranslations.locale,
        contentTranslations.field,
      ],
      set: { value: sql`excluded.value`, updated_at: sql`now()` },
    });
  return { rows: rows.length };
}
