// src/db/seed-block-port-labels.ts — write the seeded global blocks' port labels
// (blocks/seeded-port-labels.ts) into `content_translations` as entity_type `block_port`.
//
// ⛔ INSERT-IF-MISSING, NEVER UPSERTED. `content_translations` records no provenance — a seeded cell
// and one a translator corrected look the same — so `DO UPDATE` would silently revert every human
// correction on each boot of each replica (the seed-flow-templates.ts rule, and the 2026-08-07
// seeder incident). A corrected seed label therefore ships as a migration, not as an edit here.
//
// Runs at EVERY boot (server.ts), independent of SEED_DEMO_DATA (false in prod): the labels are
// product copy for platform blocks, like the starter flow templates. Rows need no block row (the
// table has no FK), so the order relative to the block seeders does not matter. Global blocks only;
// tenant-authored blocks' labels are the tenant's, never the platform's.
import { contentTranslations, db as defaultDb } from './client';
import { SUPPORTED_LOCALES } from '../utils/locale';
import { SEEDED_PORT_LABELS } from '../blocks/seeded-port-labels';
import { BLOCK_PORT_I18N, portField } from '../blocks/port-labels';

type Db = typeof defaultDb;

export function seededPortLabelCells(): (typeof contentTranslations.$inferInsert)[] {
  const cells: (typeof contentTranslations.$inferInsert)[] = [];
  for (const [slug, ports] of Object.entries(SEEDED_PORT_LABELS)) {
    for (const [dir, map] of [['in', ports.inputs], ['out', ports.outputs]] as const) {
      for (const [key, tuple] of Object.entries(map)) {
        SUPPORTED_LOCALES.forEach((locale, i) => {
          cells.push({ entity_type: BLOCK_PORT_I18N, entity_id: slug, locale, field: portField(dir, key), value: tuple[i]! });
        });
      }
    }
  }
  return cells;
}

/** Returns how many cells were newly inserted (0 on every boot after the first). */
export async function seedBlockPortLabels(db: Db = defaultDb): Promise<{ total: number; inserted: number }> {
  const cells = seededPortLabelCells();
  let inserted = 0;
  // Chunked: ~800 cells x 5 params stays far under Postgres' 65535 bind-parameter limit either way,
  // but a fixed chunk keeps that true as the catalogue grows.
  for (let i = 0; i < cells.length; i += 500) {
    const rows = await db
      .insert(contentTranslations)
      .values(cells.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ field: contentTranslations.field });
    inserted += rows.length;
  }
  return { total: cells.length, inserted };
}
