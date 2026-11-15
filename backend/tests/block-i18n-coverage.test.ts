// tests/block-i18n-coverage.test.ts — the guard for migration 0073.
//
// WHAT WENT WRONG, AND WHAT THIS PINS
// -----------------------------------
// The block catalogue's non-`en` `name`/`description`/`docs_md` existed ONLY as production
// row-state: 504 `content_translations` rows written straight into prod by the LLM translation
// pipeline on 2026-08-08, never committed. CI and every developer database had ZERO of them, so
// nothing in the repo could observe them and nothing did. Migration 0073 promotes them into git.
//
// The `name` half arrived broken in every locale, in three distinguishable ways, and each
// assertion below reds a specific one against the 2026-08-08 data:
//   1. UNTRANSLATED — the raw English slug served on a localized card (`load-dataset` in all 7
//      locales, `compare-docs` in 5, `if-else` in 7). Caught by the `!== <en base>` assertion,
//      which alone reds 11 of the 24 nl names as they stood.
//   2. IDENTIFIER-MANGLED — a translated word forced back into slug shape: nl `ai-samenvatten`,
//      `velden-extraheren`, `classificeren`; fr `résumé-ia`, `signaler-anomalies`; es
//      `formato-salida`; he `סיכום-ai`. Caught by the SHAPE rule.
//   3. SEMANTICALLY WRONG — `policy` read as governance rather than insurance. NOT machine-
//      checkable; it is fixed in 0073 by hand and reviewed there, not asserted here. Saying so
//      explicitly matters: a green run here does NOT mean the prose is right, only that it exists,
//      is localized, and is not an identifier.
//
// ⛔ NO ABSOLUTE ROW COUNTS. A developer database is dirty by construction — this one carries two
// `nl-*-proef` probe blocks from an earlier session, and any test that authored a global block
// would add more. Every assertion below is keyed on a slug from SEEDED_GLOBAL_BLOCK_SLUGS, or is a
// direction-of-containment check, so extra rows can never make it pass OR fail spuriously.
//
// ⛔ `block_tenant` IS OUT OF SCOPE, DELIBERATELY. Migration 0060 keys tenant-authored blocks under
// `entity_type = 'block_tenant'` with `entity_id = tenantId||':'||slug`. Their prose is written by
// the tenant's own publish → translate pipeline, not by any platform migration, so there is no
// coverage for this file to assert and asserting an absence there would red the day a tenant
// publishes. Every query below filters `entity_type = 'block'`.
//
// ⛔ AND NO `en` ROWS ARE EXPECTED. `en` is served from the base columns (`building_blocks.name`,
// `.description`, `block_versions.docs_md`); `getTranslationsBatch` short-circuits `en` to an empty
// map (db/translations.ts) and `enqueueTranslations` only ever mints SUPPORTED_LOCALES minus `en`.
//
// REQUIRES a migrated + seeded database — the CI shape (`bun run migrate` then `bun run seed` then
// `bun run test`, .github/workflows/ci-cd.yaml). The slug list is composed from the seed literals
// themselves (src/blocks/seeded-global-blocks.ts), so adding a block to any seeder widens this
// guard automatically instead of silently leaving the new block uncovered.
import { test, expect } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, buildingBlocks, blockVersions, contentTranslations } from '../src/db/client';
import { SEEDED_GLOBAL_BLOCK_SLUGS } from '../src/blocks/seeded-global-blocks';
import { SUPPORTED_LOCALES } from '../src/utils/locale';

/** The locales a block translation is minted for: everything except the base edition. */
const TARGET_LOCALES = SUPPORTED_LOCALES.filter((l) => l !== 'en');
const FIELDS = ['name', 'description', 'docs_md'] as const;

// ⛔ NON-VACUITY ON THE LOOP BOUNDS THEMSELVES. Every coverage assertion below iterates
// SEEDED_GLOBAL_BLOCK_SLUGS x TARGET_LOCALES x FIELDS, so if either list were ever emptied — a
// rename in utils/locale.ts, a refactor that drops a seed export — the whole file would pass over
// nothing and report green. Measured: an empty slug set already reds, but an empty locale list did
// NOT. These three lines are the floor under the floor.
test('the guard iterates a non-empty space — an empty bound would pass over nothing', () => {
  expect(TARGET_LOCALES).toHaveLength(SUPPORTED_LOCALES.length - 1);
  expect(TARGET_LOCALES.length).toBeGreaterThanOrEqual(7);
  expect(TARGET_LOCALES).not.toContain('en');
  expect(SEEDED_GLOBAL_BLOCK_SLUGS.length).toBeGreaterThanOrEqual(24);
  expect(FIELDS).toHaveLength(3);
});

/**
 * An identifier, not a display name: all-lowercase ASCII words joined by hyphens (`load-dataset`,
 * `ai-samenvatten`, `résumé-ia` normalises to neither — it keeps its accent, so the rule is
 * deliberately written over the ASCII slug alphabet the pipeline actually emitted). This is the
 * shape a slug has, and no human-facing display string in any of the 7 locales legitimately has it:
 * a real one carries a capital, a space, or non-ASCII script. `OCR-scan` and `שורות ל-CSV` both
 * contain a hyphen and both correctly fail to match.
 */
const IDENTIFIER_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** The `en` base prose a localized value must not merely echo. */
async function loadEnglishBases(): Promise<Map<string, Record<string, string>>> {
  const rows = await db
    .select({
      slug: buildingBlocks.slug,
      name: buildingBlocks.name,
      description: buildingBlocks.description,
      docs_md: blockVersions.docs_md,
    })
    .from(buildingBlocks)
    .leftJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(
      and(
        isNull(buildingBlocks.tenant_id),
        inArray(buildingBlocks.slug, [...SEEDED_GLOBAL_BLOCK_SLUGS]),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.slug,
      { name: r.name ?? '', description: r.description ?? '', docs_md: r.docs_md ?? '' },
    ]),
  );
}

async function loadBlockTranslations(): Promise<Map<string, string>> {
  const rows = await db
    .select({
      entity_id: contentTranslations.entity_id,
      locale: contentTranslations.locale,
      field: contentTranslations.field,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_type, 'block'));
  const byCell = new Map<string, string>();
  for (const r of rows) byCell.set(`${r.entity_id}\u0000${r.locale}\u0000${r.field}`, r.value);
  return byCell;
}

test('the seeded global blocks exist in the database (the guard is not vacuous)', async () => {
  const bases = await loadEnglishBases();
  const missing = SEEDED_GLOBAL_BLOCK_SLUGS.filter((s) => !bases.has(s));
  expect(
    missing,
    missing.length
      ? `seeded global block(s) absent from building_blocks: ${JSON.stringify(missing)}. ` +
          `Every assertion in this file is keyed on these slugs, so an empty set would make the ` +
          `whole file pass while checking nothing. Run 'bun run seed'.`
      : undefined,
  ).toEqual([]);
  expect(SEEDED_GLOBAL_BLOCK_SLUGS.length).toBeGreaterThanOrEqual(24);
  // No duplicate slugs across the three seeders — a dup would silently halve the coverage below.
  expect(new Set(SEEDED_GLOBAL_BLOCK_SLUGS).size).toBe(SEEDED_GLOBAL_BLOCK_SLUGS.length);
});

test('⛔ the en base display name is never the slug itself', async () => {
  // The card title IS the block name. 13 of the 24 blocks shipped with `name === slug`, so the
  // catalogue rendered identifiers at people. Fixed in the seed literals (src/db/seed.ts,
  // src/db/seed-datasets.ts) AND, for the rows that already exist in prod, by migration 0073 —
  // `upsertGlobalBlock` skips a slug that already exists and would never overwrite the bad name.
  const bases = await loadEnglishBases();
  const offenders: string[] = [];
  for (const slug of SEEDED_GLOBAL_BLOCK_SLUGS) {
    const base = bases.get(slug);
    if (!base) continue; // reported by the vacuity test above
    const name = base.name ?? '';
    if (name === slug || IDENTIFIER_SHAPE.test(name)) offenders.push(`${slug}=${name}`);
  }
  expect(
    offenders,
    offenders.length
      ? `building_blocks.name is an identifier, not a display name: ${JSON.stringify(offenders)}`
      : undefined,
  ).toEqual([]);
});

test('⛔ every seeded global block is fully translated in all 7 non-en locales', async () => {
  const bases = await loadEnglishBases();
  const cells = await loadBlockTranslations();

  const missing: string[] = [];
  const blank: string[] = [];
  const echoesEnglish: string[] = [];

  for (const slug of SEEDED_GLOBAL_BLOCK_SLUGS) {
    const base = bases.get(slug);
    if (!base) continue;
    for (const locale of TARGET_LOCALES) {
      for (const field of FIELDS) {
        const value = cells.get(`${slug}\u0000${locale}\u0000${field}`);
        if (value === undefined) {
          missing.push(`${slug}/${locale}/${field}`);
          continue;
        }
        if (value.trim().length === 0) blank.push(`${slug}/${locale}/${field}`);
        // The base prose served verbatim on a localized screen is an UNTRANSLATED cell wearing a
        // translation row. Empty bases (a block with no docs_md) cannot be compared.
        const en = base[field] ?? '';
        if (en.trim().length > 0 && value === en) echoesEnglish.push(`${slug}/${locale}/${field}`);
      }
    }
  }

  expect(missing, missing.length ? `no translation row: ${JSON.stringify(missing)}` : undefined).toEqual([]);
  expect(blank, blank.length ? `blank translation: ${JSON.stringify(blank)}` : undefined).toEqual([]);
  expect(
    echoesEnglish,
    echoesEnglish.length
      ? `translation is byte-identical to the en base — untranslated: ${JSON.stringify(echoesEnglish)}`
      : undefined,
  ).toEqual([]);
});

test('⛔ no localized block name is identifier-shaped', async () => {
  // The single highest-signal assertion in this file: it is what reds `ai-samenvatten`,
  // `velden-extraheren`, `résumé-ia`, `formato-salida`, `panel-de-revisión`, `סיכום-ai` and every
  // untranslated `load-dataset`/`if-else`/`compare-docs`, in one rule, for every locale at once.
  // Scoped to `name` on purpose — `docs_md` legitimately contains slugs in prose and code fences.
  const rows = await db
    .select({
      entity_id: contentTranslations.entity_id,
      locale: contentTranslations.locale,
      value: contentTranslations.value,
    })
    .from(contentTranslations)
    .where(
      and(eq(contentTranslations.entity_type, 'block'), eq(contentTranslations.field, 'name')),
    );
  const seeded = new Set(SEEDED_GLOBAL_BLOCK_SLUGS);
  const mangled = rows
    .filter((r) => seeded.has(r.entity_id) && IDENTIFIER_SHAPE.test(r.value))
    .map((r) => `${r.entity_id}/${r.locale}=${r.value}`)
    .sort();
  expect(
    mangled,
    mangled.length
      ? `localized block name is an identifier, not a display name: ${JSON.stringify(mangled)}. ` +
          `These are card titles; write them in the target language's normal orthography.`
      : undefined,
  ).toEqual([]);
  // Non-vacuity: the rule must have been applied to something.
  expect(rows.length).toBeGreaterThan(0);
});

test('⛔ every block translation resolves to an existing global block (no orphans)', async () => {
  // The other direction. 0060 already deletes orphans once, but nothing keeps them deleted: a block
  // that is renamed or hard-deleted leaves its prose behind, and the NEXT block to take that slug
  // silently inherits a stranger's document. Checked over the whole `block` keyspace, not just the
  // seeded slugs, because an orphan is by definition not in any list we hold.
  const ids = await db
    .selectDistinct({ entity_id: contentTranslations.entity_id })
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_type, 'block'));
  const globals = await db
    .select({ slug: buildingBlocks.slug })
    .from(buildingBlocks)
    .where(isNull(buildingBlocks.tenant_id));
  const known = new Set(globals.map((g) => g.slug));
  const orphans = ids.map((r) => r.entity_id).filter((id) => !known.has(id)).sort();
  expect(
    orphans,
    orphans.length
      ? `content_translations entity_type='block' rows whose slug has no global building_blocks ` +
          `row: ${JSON.stringify(orphans)}. Either the block was deleted and its prose was not, or ` +
          `a tenant block was written under the global key (it belongs under 'block_tenant', 0060).`
      : undefined,
  ).toEqual([]);
  expect(ids.length).toBeGreaterThan(0); // non-vacuity
});
