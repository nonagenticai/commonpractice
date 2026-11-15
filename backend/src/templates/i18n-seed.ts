// src/templates/i18n-seed.ts — turn `src/templates/seed/i18n/<locale>.json` into
// `content_translations` rows. ONE builder, TWO consumers:
//
//   * `scripts/gen-template-i18n.ts` → regenerates `migrations/0079_template_i18n.sql`, which is
//     what repairs PRODUCTION (where 20 templates exist and zero template translations do);
//   * `db/seed-templates.ts` → writes the same rows on a fresh developer / CI database, where the
//     migration ran against an EMPTY `block_templates` and the seeder is what creates the rows.
//
// ⛔ THE TWO MUST NOT BE TWO IMPLEMENTATIONS. 0073 is the precedent for what happens otherwise: a
// set of translations that existed only as prod row-state, so CI and every developer database
// silently degraded to the English base columns and nobody could see it. Here the migration and
// the seeder are generated from the same function over the same JSON, so a developer database and
// prod are the same rows by construction rather than by discipline.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderLocalizedDocs } from './i18n-docs';
import { templateNaturalKey, TEMPLATE_I18N, joinTags } from './i18n-key';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type Locale } from '../utils/locale';
import type { TemplateStep } from '../db/schema';

/** One template's prose in one locale — the schema of every `seed/i18n/<locale>.json` entry. */
export interface LocalizedTemplate {
  label: string;
  description: string;
  tags: string[];
  preconditions: string[];
  postconditions: string[];
  steps: TemplateStep[];
}

export interface LocaleFile {
  locale: string;
  /** Keyed by the NATURAL key `${category}/${domain ?? ''}/${name}` — never the row uuid. */
  templates: Record<string, LocalizedTemplate>;
}

/** One `content_translations` cell. */
export interface TranslationRow {
  entityType: string;
  entityId: string;
  locale: string;
  field: 'label' | 'description' | 'tags' | 'docs_md';
  value: string;
}

/** The 7 authored locales — `SUPPORTED_LOCALES` minus `en`, derived rather than re-listed so a
 *  9th edition cannot be added to the app and silently skipped here. Mirrors
 *  `TARGET_LOCALES` in host/translation-service.ts; NOT imported from it, because that module
 *  pulls in the LLM broker and the seed path must not. */
export const TEMPLATE_LOCALES: Locale[] = SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE);

const I18N_DIR = path.join(import.meta.dir, 'seed', 'i18n');

export function i18nFilePath(locale: string): string {
  return path.join(I18N_DIR, `${locale}.json`);
}

/** Read one locale file, or `null` when it has not been authored yet. */
export function readLocaleFile(locale: string): LocaleFile | null {
  try {
    return JSON.parse(readFileSync(i18nFilePath(locale), 'utf8')) as LocaleFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * The four cells for one template in one locale.
 *
 * ⛔ `docs_md` IS RENDERED, NOT AUTHORED. The translator supplies only the prose — label,
 * description, tags, and the three formal lists — and the document is assembled here through the
 * same `renderDocsWithHeadings` shape the English base column uses (templates/i18n-docs.ts), with
 * the `##` headings localized too. Authoring 7 finished markdown blobs instead would make the
 * change unreviewable (a heading-level or numbering difference between locales is invisible in a
 * blob diff) and would fork the document's structure per language the first time anyone edited it.
 */
export function rowsForTemplate(
  naturalKey: string,
  locale: Locale,
  t: LocalizedTemplate,
): TranslationRow[] {
  const docs = renderLocalizedDocs(
    {
      label: t.label,
      description: t.description,
      preconditions: t.preconditions,
      postconditions: t.postconditions,
      steps: t.steps,
    },
    locale,
  );
  return [
    { entityType: TEMPLATE_I18N, entityId: naturalKey, locale, field: 'label', value: t.label },
    { entityType: TEMPLATE_I18N, entityId: naturalKey, locale, field: 'description', value: t.description },
    // Newline-joined: content_translations is a flat field→TEXT table with no array support.
    // Split back on read by `splitTags` (templates/i18n-key.ts).
    { entityType: TEMPLATE_I18N, entityId: naturalKey, locale, field: 'tags', value: joinTags(t.tags) },
    { entityType: TEMPLATE_I18N, entityId: naturalKey, locale, field: 'docs_md', value: docs },
  ];
}

/**
 * Every curated cell for the SHIPPED (global) catalog, across every authored locale.
 *
 * `expectedKeys` is the set of natural keys the seed catalog actually holds. Passing it turns a
 * RENAMED OR REMOVED template — the failure this whole natural-key scheme is exposed to — into a
 * loud throw instead of 28 rows that key to nothing. It is optional only so a caller that has not
 * loaded the base catalog (the migration generator loads it; a test may not) can still build rows.
 *
 * ⛔ NO `en` ROWS, EVER. `getTranslationsBatch` short-circuits `en` to an empty map
 * (db/translations.ts:118-121), so an `en` row is unreachable by every reader — dead weight whose
 * only possible future is to drift out of sync with the `block_templates` base column it shadows
 * and to make a coverage count lie. `TEMPLATE_LOCALES` excludes it structurally.
 */
export function buildTemplateI18nRows(
  expectedKeys?: ReadonlySet<string>,
  /**
   * ⛔ THE GENERATOR PASSES `true`, AND THAT IS NOT A STYLE CHOICE. A migration generated while
   * only some of the locale files existed is the failure that actually happened here: 0079 was
   * first generated from 3 of 7 files and produced a perfectly well-formed, perfectly reviewable,
   * 240-row artifact that was silently missing four languages. Nothing about the output says so.
   * The generator therefore REFUSES to emit unless every supported non-en locale has a file.
   *
   * The SEED path passes `false` on purpose: a missing content file must not take down every
   * developer database's `bun run seed`, and the consequence there is only that those readers fall
   * back to English — the pre-existing behaviour. The gate for completeness is
   * tests/template-i18n.test.ts, which derives its expected counts from `SUPPORTED_LOCALES` and
   * the live catalog rather than from a typed literal.
   */
  requireAllLocales = false,
): TranslationRow[] {
  const out: TranslationRow[] = [];
  const missingFiles: string[] = [];
  for (const locale of TEMPLATE_LOCALES) {
    const file = readLocaleFile(locale);
    if (!file) {
      missingFiles.push(locale);
      continue;
    }
    if (file.locale !== locale) {
      throw new Error(`seed/i18n/${locale}.json declares locale '${file.locale}'`);
    }
    for (const [key, t] of Object.entries(file.templates)) {
      if (expectedKeys && !expectedKeys.has(key)) {
        throw new Error(
          `seed/i18n/${locale}.json has key '${key}', which matches no seeded template. ` +
            `A translation keyed to a template that does not exist is invisible — rename the key ` +
            `or remove it. (Known keys: ${[...expectedKeys].sort().join(', ')})`,
        );
      }
      out.push(...rowsForTemplate(key, locale, t));
    }
    if (expectedKeys) {
      const missing = [...expectedKeys].filter((k) => !(k in file.templates));
      if (missing.length) {
        throw new Error(
          `seed/i18n/${locale}.json is missing ${missing.length} template(s): ${missing.sort().join(', ')}`,
        );
      }
    }
  }
  if (requireAllLocales && missingFiles.length) {
    throw new Error(
      `src/templates/seed/i18n/ is missing ${missingFiles.length} of ${TEMPLATE_LOCALES.length} ` +
        `locale file(s): ${missingFiles.join(', ')}. Generating the migration now would ship an ` +
        `artifact that silently serves English to those readers.`,
    );
  }
  return out;
}

/** The natural keys of the shipped catalog, read from the same `seed/*.json` the seeder loads. */
export function seedNaturalKeys(
  files: { category: string; domain?: string; templates: { name: string; domain?: string }[] }[],
): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const t of f.templates) {
      out.add(templateNaturalKey({ category: f.category, domain: t.domain ?? f.domain ?? null, name: t.name }));
    }
  }
  return out;
}
