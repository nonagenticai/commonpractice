#!/usr/bin/env bun
// scripts/gen-ontology-i18n.ts — regenerate migrations/0080_ontology_i18n.sql from the curated
// content in src/ontology/i18n-seed.ts.
//
// ⛔ THE MIGRATION IS GENERATED, NOT HAND-TYPED, AND THAT IS THE POINT. It is hundreds of
// dollar-quoted rows of prose in 7 languages, 4 of which this reviewer cannot read and 2 of which
// are RTL, keyed by composite natural keys (`industry_dept:insurance:Claims:Claim`,
// `insurance:Claim->Policy:under`). Every failure mode there is invisible: a key typo'd by one
// character, a locale column shifted by one, one industry silently short an edge. Each is a row
// that matches nothing and degrades to English for one reader in one language — the failure that
// has no symptom, because falling back to English is exactly what a MISSING row does too.
//
// Regenerating makes the SQL a DERIVED artifact: correcting a translation means editing the TS and
// re-running this, and the SQL diff is reviewable as a consequence rather than as the source.
// `buildOntologyI18nRows` cross-checks every key against the canonical key set computed from
// src/ontology/seed/*.json, so a renamed entity fails HERE, naming the key, instead of shipping
// orphans. tests/gen-ontology-i18n-drift.test.ts runs `--check` on the `bun test` gate the backend
// job already has, so a stale migration cannot merge.
//
//   bun run scripts/gen-ontology-i18n.ts            # write the migration
//   bun run scripts/gen-ontology-i18n.ts --check    # verify it is up to date (CI-shaped)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildOntologyI18nRows,
  canonicalOntologyKeys,
  ONTOLOGY_LOCALES,
} from '../src/ontology/i18n-seed';

const OUT = path.join(import.meta.dir, '..', 'migrations', '0080_ontology_i18n.sql');

/**
 * Dollar-quote a value, choosing a tag that does not occur inside it.
 *
 * ⛔ NOT `'…'` WITH DOUBLED QUOTES. Every value here is prose in 7 languages: it contains
 * apostrophes (`Un contrat d'assurance…`) and RTL text. 0073 and 0079 use `$t$…$t$` for the same
 * reason. The tag is VERIFIED ABSENT rather than assumed — a value that happened to contain `$t$`
 * would otherwise terminate its own literal and produce a syntactically valid migration that
 * inserts garbage.
 */
function dollarQuote(value: string): string {
  for (const tag of ['$t$', '$tx$', '$txt$', '$val$']) {
    if (!value.includes(tag)) return `${tag}${value}${tag}`;
  }
  throw new Error(`no safe dollar-quote tag for value: ${value.slice(0, 80)}…`);
}

const HEADER = `-- 0080_ontology_i18n.sql — the shipped GLOBAL ontology's entity labels, entity descriptions,
-- attribute descriptions and relation labels in the 7 non-en editions (§5B). GENERATED — do not
-- hand-edit; see scripts/gen-ontology-i18n.ts.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The \`/ontology\` screen renders the compiled (industry × department) graph. On the Dutch screen
-- the graph rendered ENGLISH EDGE LABELS. Measured in production: \`ontology_relations\` holds 30
-- global rows and only 6 carry an \`nl\` label. Counted as LOOKUP KEYS — which is the unit that
-- matters, because a generic edge is keyed once per industry (see below) — the insurance vertical
-- has 23 (15 generic + 8 insurance), 6 of them translated, so 17 rendered English.
-- ⛔ 23 IS A KEY COUNT, NOT A CELL SIZE. No single (industry × department) cell has 23 edges; the
-- largest is insurance/Marketing at 12 (measured). An earlier framing of this as "23 edges in the
-- insurance cell" was wrong and is corrected here so it does not get repeated.
-- \`ontology_entities\` holds 38 global rows with an \`nl\` description on only 9.
--
-- ⛔ THE CONTENT EXISTED. IT JUST NEVER REACHED PRODUCTION. Those translations have been in
-- \`src/db/seed-ontology-i18n.ts\` since Phase 3.5, and the reason the screen is English anyway is
-- that THE SEED DOES NOT RUN IN PRODUCTION: the live Deployment sets \`SEED_DEMO_DATA=false\`, and
-- \`src/server.ts\` only calls \`seedAll()\` when that flag is true. \`applyMigrations()\` runs on EVERY
-- boot. So for four phases the seed file was a code path production never executed, and editing it
-- shipped nothing — which is precisely the shape of 0073's failure (i18n that lived only as prod
-- row-state) inverted: i18n that lived only as repo state.
--
-- This file is therefore the half that LANDS, and it is generated from the same builder the seeder
-- calls (\`buildOntologyI18nRows()\` in src/ontology/i18n-seed.ts) so the two cannot drift. Neither
-- half is redundant: \`bun run migrate\` runs BEFORE \`bun run seed\`, so on a fresh cluster this file
-- executes against an EMPTY \`ontology_entities\` — the rows still land (content_translations has no
-- foreign key) and the seeder then writes the identical set.
--
-- THE KEY FORMATS — ALL THREE ARE NATURAL KEYS, NEVER ROW uuids
-- -------------------------------------------------------------
-- \`ontology_entities.id\` / \`_attributes.id\` / \`_relations.id\` are uuidv7 defaults: a DIFFERENT
-- value in prod, in CI and in every developer database for the same shipped row. A uuid-keyed
-- translation is not an error anywhere — there is no FK — it is simply a row that matches nothing
-- in every database but the one it was exported from. So:
--
--   entity_type='ontology_entity'    entity_id = entityKey()
--                                    = "\${scope}:\${industry ?? ''}:\${department ?? ''}:\${name}"
--                                      e.g. 'generic::Marketing:Campaign',
--                                           'industry:insurance::Policy',
--                                           'industry_dept:insurance:Claims:Claim'
--   entity_type='ontology_attribute' entity_id = attrKey(entityKey, name) = "\${entityKey}#\${name}"
--   entity_type='ontology_relation'  entity_id = relKey(industry, from, to, predicate)
--                                    = "\${industry}:\${from}->\${to}:\${predicate}"
--
-- Names are not globally unique (\`Lead\` recurs in Marketing and Sales, \`Claim\` in insurance and
-- healthcare), which is why scope+industry+department qualify the entity key.
--
-- ⛔ A RELATION KEY CARRIES THE *COMPILE* INDUSTRY, NOT THE EDGE'S OWN LAYER
-- --------------------------------------------------------------------------
-- \`compileEffective\` compiles ONE (industry, department) cell and looks its edges up as
-- \`relKey(industry, r.from, r.to, r.predicate)\` — with the industry OF THE CELL, never the layer
-- the edge came from (src/ontology/ontology-service.ts). Generic-layer entities are in the layered
-- set of every cell, so the generic edge \`Campaign -runsOn-> Channel\` is looked up as
-- \`insurance:Campaign->Channel:runsOn\` on the insurance graph and \`banking:…\` on the banking one.
--
-- ONE generic edge therefore needs ONE ROW PER INDUSTRY. Measured from the seed: 30 global
-- relations (15 generic + 4 banking + 3 healthcare + 8 insurance) expand to 60 canonical keys.
-- The expansion is done in the BUILDER, in a loop over the industry axis derived exactly the way
-- \`listMatrix\` derives it — never by hand-listing tuples, which is how a translation ends up
-- working on the demo vertical and silently serving English on the other two.
--
-- ⛔ DO NOT "FIX" relKey TO USE THE EDGE'S OWN INDUSTRY. The reader is correct: the same
-- (from, to, predicate) name-tuple means different things in two verticals, and collapsing the key
-- would let one vertical's wording leak into another's graph. The cost is rows; rows are cheap.
--
-- TRANSLATION PROVENANCE — READ THIS BEFORE TRUSTING A STRING. IT IS MIXED.
-- -------------------------------------------------------------------------
-- TWO GENERATIONS OF CONTENT SIT IN THIS FILE AND THEY ARE NOT EQUALLY GOOD.
--
--   * The Phase 3.5/3.7 originals — all 38 entity labels, 9 insurance entity descriptions, 2
--     attribute descriptions, 6 insurance relation labels — are MACHINE-PRODUCED. \`nl\` had the
--     closest look because it is the demo locale; the other six were not reviewed at all.
--   * The 29 entity descriptions and 24 relation-label entries added to close the coverage gap
--     went through an adversarial \`nl\` review that found 5 outright WRONG strings and 12
--     questionable ones, all corrected, plus 7 further defects found by checking whether the same
--     calque had been made in the other six locales. Mechanically validated too: all 7 locales
--     present and non-empty, no \`en\` key, no English passthrough, no trailing period on a relation
--     label, no Latin characters inside an \`ar\`/\`he\` string.
--
-- ⛔ THAT REVIEW DOES NOT EXTEND BACKWARDS. A reviewer who finds a bad string here should assume
-- the ORIGINALS are the likelier source of it. 0073's audit of the block \`name\` translations is
-- the cautionary precedent for unreviewed machine output: a measured 11-14 bad cells out of 24 per
-- locale. The \`ar\`/\`he\` RTL editions have had no native-reader pass in either generation.
--
-- The locale-keyed record shape (src/ontology/i18n-seed.ts) exists for exactly this: one bad cell
-- is DELETABLE — drop that locale's key from the entry and the reader falls back to the English
-- base column, which is legible. Do not replace a bad translation with a placeholder.
--
-- COVERAGE IS COMPLETE, AND A GATE HOLDS IT THAT WAY
-- --------------------------------------------------
-- Entity LABELS:          38 of 38 shipped entities × 7 locales = 266 rows.
-- Entity DESCRIPTIONS:    38 of 38 × 7 = 266 rows. (Was 9 of 38 — insurance only.)
-- ATTRIBUTE descriptions: 2 of 2 × 7 = 14 rows — i.e. 100%, NOT a shortfall. Of the 133 seeded
--                         attributes exactly TWO carry an \`en\` description at all
--                         (\`Claim.adjuster_notes\`, \`Claim.fraud_score\`); the other 131 have no
--                         base prose, so a translation would be non-en-only text invented here.
--                         ⛔ Do not read "2 of 133" as a gap — 133 is not the translatable set.
-- RELATION labels:        60 of 60 canonical keys × 7 = 420 rows. (Was 6 of 60.)
-- TOTAL: 966.
--
-- \`buildOntologyI18nRows()\` now runs its \`requireAllLocales\` gate BY DEFAULT: every canonical
-- relation key must carry a label in all 7 non-en locales or the generator throws and names the
-- gaps. So adding a 61st edge to src/ontology/seed/*.json without translating it FAILS THE BUILD.
-- ⛔ The fix for that failure is to author the label. It is never to pass \`requireAllLocales:
-- false\`, and never to delete the edge from the seed to satisfy the count.
--
-- Predicates and attribute NAMES stay canonical \`en\` (agent concept stability) — only display
-- prose moves. Entity \`name\` likewise: the compiled \`name\` is the identity the 3.3 dataset-mapping
-- bridge and the 3.4 agent key against, and \`label\` is the only thing a human reads.
--
-- SCOPE — GLOBAL ONLY
-- -------------------
-- \`entity_type\` is the GLOBAL family ('ontology_entity' / '_attribute' / '_relation'). TENANT-
-- authored entities live under 'ontology_entity_tenant' with \`\${tenant_id}:\${naturalKey}\` and are
-- DELIBERATELY UNTOUCHED — their prose is not ours to write, and the LLM pipeline owns them.
--
-- ⛔ AND ONBOARDING THESE GLOBALS TO THAT PIPELINE REQUIRES AN \`is_curated\` COLUMN FIRST, NOT A
-- WIDENED SELECT. \`processPendingBatch\` in src/host/translation-service.ts UPSERTs its LLM output
-- into content_translations with NO curated-row guard (\`ON CONFLICT … DO UPDATE SET value\`). Its
-- backfill switch has no \`ontology_*\` branch today, and THAT ABSENCE IS THE ONLY THING PROTECTING
-- EVERY ROW BELOW. Adding one would silently overwrite this hand-reviewed content with machine
-- output on the next backfill tick and leave this file in git claiming otherwise — the same shape
-- as 0079's tenant-only filter, and for the same reason. The correct order is: add \`is_curated\`,
-- have the upsert skip curated rows, THEN widen the backfill.
--
-- ⛔ NO \`en\` ROWS. \`getTranslationsBatch\` short-circuits \`en\` to an empty map
-- (src/db/translations.ts:117-135), so an \`en\` row is unreachable by every reader — dead weight
-- whose only future is to drift from the base column it shadows and to make a coverage count lie.
--
-- IDEMPOTENT. \`ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE\` on the primary key
-- \`content_translations_pk\` (src/db/schema.ts), matching 0010_book_translations.sql,
-- 0073_block_display_names_and_i18n.sql and 0079_template_i18n.sql. The runner applies each file
-- once (\`_migrations\`), so on prod this runs once.

`;

function main(): void {
  const check = process.argv.includes('--check');
  const canonical = canonicalOntologyKeys();
  // ⛔ THE COVERAGE GATE IS ON (it defaults to on; not passing it is the point). If a seeded edge
  // has no label in all 7 locales this THROWS instead of emitting a migration that renders an
  // English predicate in the middle of a Dutch graph. Do not pass `requireAllLocales: false` to
  // get an artifact out — the artifact would be the bug.
  const rows = buildOntologyI18nRows({ canonical });

  if (rows.length === 0) {
    console.error('buildOntologyI18nRows() produced no rows — nothing to generate');
    process.exit(1);
  }
  // ⛔ A GUARD, NOT A COMMENT. `en` is unreadable by the overlay; an `en` row would be dead weight
  // that no reader can reach and would inflate every coverage count that follows.
  const enRows = rows.filter((r) => r.locale === 'en');
  if (enRows.length) throw new Error(`${enRows.length} 'en' rows produced — see the ⛔ in i18n-seed.ts`);

  const byLocale = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const r of rows) {
    byLocale.set(r.locale, (byLocale.get(r.locale) ?? 0) + 1);
    byType.set(`${r.entityType}.${r.field}`, (byType.get(`${r.entityType}.${r.field}`) ?? 0) + 1);
  }

  const parts: string[] = [HEADER];
  parts.push(
    `-- ${rows.length} rows across ${byLocale.size} locales (${ONTOLOGY_LOCALES.join(', ')}):\n` +
      [...byType.entries()].map(([k, n]) => `--   ${k}: ${n}`).join('\n') +
      `\n-- Canonical key sets from src/ontology/seed/*.json: ${canonical.entities.size} entities, ` +
      `${canonical.attributes.size} attributes, ${canonical.relations.size} relation keys\n` +
      `-- (${canonical.industries.length} industries × the compile-industry expansion).\n`,
  );
  parts.push(`INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES`);
  const values = rows.map(
    (r) => `  ('${r.entityType}', '${r.entityId}', '${r.locale}', '${r.field}', ${dollarQuote(r.value)})`,
  );
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
      console.error(`${OUT} is stale — re-run: bun run scripts/gen-ontology-i18n.ts`);
      process.exit(1);
    }
    console.log(`0080_ontology_i18n.sql is up to date (${rows.length} rows).`);
    return;
  }

  writeFileSync(OUT, sql, 'utf8');
  const counts = [...byLocale.entries()].map(([l, n]) => `${l}=${n}`).join(' ');
  console.log(`wrote ${OUT}\n  ${rows.length} rows (${counts})`);
}

main();
