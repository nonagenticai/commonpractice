#!/usr/bin/env bun
// scripts/gen-template-i18n.ts — regenerate migrations/0079_template_i18n.sql from
// src/templates/seed/i18n/*.json.
//
// ⛔ THE MIGRATION IS GENERATED, NOT HAND-TYPED, AND THAT IS THE POINT. 560 dollar-quoted rows of
// prose in 7 languages (4 of which this reviewer cannot read, 2 of which are RTL) is exactly the
// artifact where a hand edit goes wrong invisibly: a `docs_md` blob pasted with the wrong heading
// level, a key typo'd from `ui//kpi-card` to `ui//kpi_card`, one locale silently short by a
// template. Every one of those is a row that keys to nothing and degrades to English for one
// reader in one language — the failure mode that has no symptom.
//
// Regenerating from the JSON makes the SQL a DERIVED artifact: correcting a translation means
// editing the JSON and re-running this, and the diff of the SQL is then reviewable as a
// consequence rather than as the source. `buildTemplateI18nRows` cross-checks every key against
// the natural keys of the actual seed catalog, so a renamed or removed template fails HERE with a
// message naming the key, instead of shipping orphans.
//
//   bun run scripts/gen-template-i18n.ts            # write the migration
//   bun run scripts/gen-template-i18n.ts --check    # verify it is up to date (CI-shaped)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTemplateI18nRows, seedNaturalKeys, TEMPLATE_LOCALES } from '../src/templates/i18n-seed';
import { TEMPLATE_I18N } from '../src/templates/i18n-key';

const SEED_FILES = ['logic-generic.json', 'ui-generic.json', 'ai-generic.json'];
const SEED_DIR = path.join(import.meta.dir, '..', 'src', 'templates', 'seed');
const OUT = path.join(import.meta.dir, '..', 'migrations', '0079_template_i18n.sql');

interface SeedFile {
  category: string;
  domain?: string;
  templates: { name: string; domain?: string }[];
}

function loadSeed(): SeedFile[] {
  return SEED_FILES.map((f) => JSON.parse(readFileSync(path.join(SEED_DIR, f), 'utf8')) as SeedFile);
}

/**
 * Dollar-quote a value, choosing a tag that does not occur inside it.
 *
 * ⛔ NOT `'…'` WITH DOUBLED QUOTES. Every value here is markdown prose in 7 languages: it contains
 * apostrophes, literal newlines and backticks, and `docs_md` contains all three at once. 0073 uses
 * `$t$…$t$` for the same reason. The tag is verified absent rather than assumed — a value that
 * happened to contain `$t$` would otherwise terminate its own literal and produce a syntactically
 * valid migration that inserts garbage.
 */
function dollarQuote(value: string): string {
  for (const tag of ['$t$', '$tx$', '$txt$', '$val$']) {
    if (!value.includes(tag)) return `${tag}${value}${tag}`;
  }
  throw new Error(`no safe dollar-quote tag for value: ${value.slice(0, 80)}…`);
}

const HEADER = `-- 0079_template_i18n.sql — the 20 shipped block-template starter scaffolds, in the 7 non-en
-- editions (§5B). GENERATED — do not hand-edit; see scripts/gen-template-i18n.ts.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- \`/block-edit\` → "From template" renders the 20 seeded starter templates. In PRODUCTION
-- \`block_templates\` holds 20 rows and \`content_translations\` holds ZERO rows for any of them, and
-- routes/templates.ts had no locale handling at all — so a Dutch author was shown English cards
-- titled \`validate-record\`, \`route-by-rule\`, \`approve-reject\`. Worse than a cosmetic miss:
-- picking a template COPIES its label into the new block's name, its description into the
-- description, its docs into the docs, and derives the slug from the English label
-- (frontend/src/routes/block-edit/+page.svelte \`applyTemplate\`). Choosing a starter therefore
-- wrote English permanently into the Dutch author's own block. This file is the content half; the
-- overlay that reads it is templates/templates-service.ts.
--
-- ⛔ THE KEY IS THE NATURAL KEY, NOT THE ROW id.
-- \`entity_id\` is \`\${category}/\${domain ?? ''}/\${name}\` (templates/i18n-key.ts), mirroring the
-- unique index \`block_templates_natural_uq (category, coalesce(domain,''), name,
-- coalesce(tenant_id, zero-uuid))\` at 0043_block_templates.sql:48-53. It is NOT
-- \`block_templates.id\`, which is \`DEFAULT uuidv7()\` (0043:19) and therefore a DIFFERENT value in
-- prod, in CI, and in every developer database for the same shipped template. \`content_translations\`
-- has no foreign key, so a uuid-keyed row is not an error anywhere — it is simply a row that matches
-- nothing, in every database but the one it was exported from. All 20 templates have a NULL domain,
-- so every key below reads \`ai//x\`, \`logic//x\` or \`ui//x\`; \`domain ?? ''\` matches the index's
-- \`coalesce(domain,'')\` exactly so NULL and '' cannot become two spellings of one key.
--
-- TRANSLATION PROVENANCE — READ THIS BEFORE TRUSTING A STRING
-- ----------------------------------------------------------
-- \`nl\` is the DEMO locale and had the closest review. The other six (de, fr, es, pl, ar, he) are
-- MACHINE-PRODUCED AND UNREVIEWED. They are shipped anyway because the measured alternative is
-- worse — the English identifier \`validate-record\` as a card title — but no claim is made that
-- they are good, and the \`he\`/\`ar\` RTL editions in particular have had no native-reader pass.
-- 0073's audit of the block \`name\` translations is the cautionary precedent: the pipeline there
-- produced a mix of untranslated slugs, identifier-mangled hybrids (\`ai-samenvatten\`) and
-- semantically wrong readings, at a measured 11-14 bad cells out of 24 per locale. Assume the same
-- rate here until someone measures otherwise.
--
-- \`docs_md\` is RENDERED, not authored: the localized label / description / preconditions / steps /
-- postconditions are assembled through the same renderer that produces the English base column
-- (templates/i18n-docs.ts \`renderDocsWithHeadings\`), with the three \`##\` headings localized from
-- the already-reviewed frontend catalog keys \`blockedit_savetpl_{pre,steps,post}_label\`. So the
-- document has the SAME SHAPE in every language and a heading-level or numbering change cannot
-- diverge per locale.
--
-- \`tags\` is a \`string[]\` column but \`content_translations\` is a flat (entity, locale, field) → TEXT
-- table, so the localized tag list is stored NEWLINE-JOINED in the single \`tags\` cell and split
-- back on read (templates/i18n-key.ts \`splitTags\`).
--
-- SCOPE
-- -----
-- GLOBAL (shipped) templates only: \`entity_type='block_template'\`. TENANT-authored templates live
-- under \`block_template_tenant\` with \`\${tenant_id}:\${natural}\` and are DELIBERATELY UNTOUCHED —
-- their prose is not ours to write, and the LLM pipeline handles them (host/translation-service.ts,
-- backfill branch \`WHERE tenant_id IS NOT NULL\`). That filter exists because \`processPendingBatch\`
-- UPSERTs with NO curated-row guard: a backfill that included the globals would silently overwrite
-- every row below with machine output and leave this file in git claiming otherwise.
--
-- ⛔ NO \`en\` ROWS. \`getTranslationsBatch\` short-circuits \`en\` to an empty map
-- (src/db/translations.ts:118-121), so an \`en\` row is unreachable by every reader — dead weight
-- whose only future is to drift from the \`block_templates\` base column it shadows.
--
-- IDEMPOTENT. \`ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE\` on the primary key,
-- matching 0010_book_translations.sql and 0073_block_display_names_and_i18n.sql. The runner applies
-- each file once (\`_migrations\`), so on prod this runs once.
--
-- FRESH DATABASES. \`bun run migrate\` runs BEFORE \`bun run seed\`, so on a new cluster this executes
-- against an EMPTY \`block_templates\`. The rows still land (no FK), and \`seedTemplateTranslations()\`
-- in src/db/seed-templates.ts writes the identical set from the identical JSON — neither half is
-- redundant, and they cannot drift because both call \`buildTemplateI18nRows()\`.
--
-- DEFERRED, WITH THE SCHEME ALREADY CHOSEN — \`descriptor.inputs[].description\` /
-- \`descriptor.outputs[].description\`
-- ------------------------------------------------------------------------------------------------
-- The per-PORT help text inside \`block_templates.descriptor\` (JSONB) is NOT translated by this
-- file and still renders English in every locale. It is deferred, not overlooked, and the next
-- session should NOT redesign it:
--   * KEY: one \`content_translations\` row PER PORT, field \`descriptor.inputs.<port>.description\`
--     (and \`descriptor.outputs.<port>.description\`), under the SAME \`entity_type\` + natural
--     \`entity_id\` as the four fields here. A per-port field keeps the flat table flat — no JSON in
--     a \`value\` cell — and lets one port be re-reviewed without touching the others.
--   * READ: a JSON MERGE in \`localize()\` (templates/templates-service.ts), not a whole-descriptor
--     replacement. The descriptor is a SCHEMA — types, required flags, defaults — and only
--     \`.description\` is prose. Overlaying the whole object would let a translation change a port's
--     TYPE, which the block editor would then copy into a real block.
--   * COST: 20 templates × ~4 ports × 7 locales ≈ 560 more rows, i.e. this file again.
-- Do it when someone can review the port help; shipping it machine-produced doubles the unreviewed
-- surface for text most authors never read.

`;

function main(): void {
  const check = process.argv.includes('--check');
  const keys = seedNaturalKeys(loadSeed());
  const rows = buildTemplateI18nRows(keys, /* requireAllLocales */ true);

  if (rows.length === 0) {
    console.error(
      `no locale files found under src/templates/seed/i18n/ (expected ${TEMPLATE_LOCALES.join(', ')}.json) — nothing to generate`,
    );
    process.exit(1);
  }
  // ⛔ A GUARD, NOT A COMMENT. `en` is unreadable by the overlay; a stray `en` file would produce
  // 80 rows that no reader can ever reach and inflate every coverage count that follows.
  const enRows = rows.filter((r) => r.locale === 'en');
  if (enRows.length) throw new Error(`${enRows.length} 'en' rows produced — see the ⛔ in i18n-seed.ts`);

  const byLocale = new Map<string, typeof rows>();
  for (const r of rows) byLocale.set(r.locale, [...(byLocale.get(r.locale) ?? []), r]);

  const parts: string[] = [HEADER];
  parts.push(
    `-- ${rows.length} rows: ${keys.size} templates × ${byLocale.size} locales × 4 fields ` +
      `(label, description, tags, docs_md).\n`,
  );
  parts.push(`INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES`);
  const values: string[] = [];
  for (const locale of TEMPLATE_LOCALES) {
    const localeRows = byLocale.get(locale);
    if (!localeRows) continue;
    for (const r of localeRows) {
      values.push(
        `  ('${TEMPLATE_I18N}', '${r.entityId}', '${r.locale}', '${r.field}', ${dollarQuote(r.value)})`,
      );
    }
  }
  parts.push(values.join(',\n'));
  parts.push(
    `\nON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE\n` +
      `  SET value = EXCLUDED.value, updated_at = now();\n`,
  );
  const sql = parts.join('\n');

  if (check) {
    const current = (() => {
      try {
        return readFileSync(OUT, 'utf8');
      } catch {
        return '';
      }
    })();
    if (current !== sql) {
      console.error(`${OUT} is stale — re-run: bun run scripts/gen-template-i18n.ts`);
      process.exit(1);
    }
    console.log(`0079_template_i18n.sql is up to date (${rows.length} rows).`);
    return;
  }

  writeFileSync(OUT, sql, 'utf8');
  const counts = [...byLocale.entries()].map(([l, r]) => `${l}=${r.length}`).join(' ');
  console.log(`wrote ${OUT}\n  ${rows.length} rows (${counts})`);
}

main();
