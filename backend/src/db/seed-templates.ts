// src/db/seed-templates.ts — load the native-JSON block-template catalog (src/templates/seed/*.json)
// into block_templates. Mirrors seed-ontology.ts: declarative JSON in, idempotent upsert by natural
// key (category, domain, name, tenant=NULL), all seeded rows GLOBAL (tenant_id NULL).
//
// Templates are STARTER SCAFFOLDS for new blocks. Like data-block-compiler renders a block's source
// from a declarative ontology entity, here the runnable `source_ts` + `docs_md` are RENDERED from the
// template's descriptor + formal structure (preconditions / postconditions / steps) — so no code is
// embedded in the JSON. A template may still override `source_ts` / `docs_md` explicitly.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, blockTemplates, contentTranslations } from './client';
import { requireScannedSource } from '../blocks/source-gate';
import { renderDocsWithHeadings, DOCS_HEADINGS } from '../templates/i18n-docs';
import { buildTemplateI18nRows, seedNaturalKeys } from '../templates/i18n-seed';
import type { BlockCategory, BlockDescriptor, FieldType } from './block-types';
import type { TemplateStep } from './schema';
import { invalidateTemplatesCache } from '../templates/templates-service';

interface SeedTemplate {
  name: string;
  label: string;
  description?: string;
  domain?: string;
  tags?: string[];
  preconditions?: string[];
  postconditions?: string[];
  steps?: TemplateStep[];
  descriptor: BlockDescriptor;
  /** Optional explicit overrides; otherwise rendered from the declarative fields. */
  source_ts?: string;
  docs_md?: string;
}
interface SeedTemplateFile {
  category: BlockCategory;
  /** File-level vertical/domain; NULL/absent ⇒ generic. A template may override per-entry. */
  domain?: string;
  templates: SeedTemplate[];
}

// Add new catalog files here as they are authored.
const SEED_FILES = ['logic-generic.json', 'ui-generic.json', 'ai-generic.json'];

function loadSeedFile(file: string): SeedTemplateFile {
  const full = path.join(import.meta.dir, '..', 'templates', 'seed', file);
  return JSON.parse(readFileSync(full, 'utf8')) as SeedTemplateFile;
}

/** A sensible empty default for an output port of the given field type (return scaffold). */
function defaultFor(type: FieldType): string {
  switch (type) {
    case 'number': return '0';
    case 'boolean': return 'false';
    case 'json': return '{}';
    case 'string[]': return '[]';
    default: return '""';
  }
}

/** Render the descriptor as an indented JS object literal nested under `  descriptor:`. */
function descriptorLiteral(d: BlockDescriptor): string {
  return JSON.stringify(d, null, 2).split('\n').join('\n  ');
}

/** Render a runnable starter `source_ts` from the descriptor + steps (SPEC §5 SDK shape). */
export function renderSource(t: SeedTemplate): string {
  const outs = Object.entries(t.descriptor.outputs ?? {}).map(
    ([k, spec]) => `${k}: ${defaultFor(spec.type)}`,
  );
  const stepComments = (t.steps ?? []).map((s, i) => `    // ${i + 1}. ${s.label}: ${s.detail}`);
  return [
    'export default {',
    '  descriptor: ' + descriptorLiteral(t.descriptor) + ',',
    `  // ${t.label} — ${t.description ?? ''}`.trimEnd(),
    '  async run(inputs, ctx) {',
    ...stepComments,
    '    // TODO: implement the steps above for your use case.',
    '    return { ' + outs.join(', ') + ' };',
    '  }',
    '};',
    '',
  ].join('\n');
}

/**
 * Render starter `docs_md` from the declarative fields — the `en` BASE column.
 *
 * ⛔ A ONE-LINE DELEGATION ON PURPOSE. The body of this function used to live here, and the 7
 * localized `docs_md` cells are rendered from the SAME shape (migrations/0079, via
 * templates/i18n-seed.ts). Two copies would let the English document and the Dutch one drift into
 * different heading levels or a different step numbering — a divergence no test asserts and no
 * reviewer sees, because nobody reads two languages of the same document side by side. One
 * implementation, parameterized only by the three headings. See templates/i18n-docs.ts.
 */
export function renderDocs(t: SeedTemplate): string {
  return renderDocsWithHeadings(t, DOCS_HEADINGS.en);
}

/**
 * Write the curated template translations on a FRESH database.
 *
 * ⛔ WHY THE MIGRATION IS NOT ENOUGH. `bun run migrate` runs BEFORE `bun run seed`, so when
 * 0079_template_i18n.sql executes on a new cluster `block_templates` is EMPTY. The migration's
 * INSERTs still land (content_translations has no FK to block_templates), but a developer would
 * only ever have discovered that by accident — the honest reason both halves exist is the one 0073
 * documents: an i18n artifact that lives only in prod row-state is not testable and not
 * reviewable. This is the seeder's half, generated from the same JSON by the same function, so a
 * developer database and prod hold the same rows rather than merely being expected to.
 *
 * Idempotent (`ON CONFLICT … DO UPDATE`), and a no-op while the locale files are unauthored.
 * ⛔ GLOBAL (`block_template`) ROWS ONLY — tenant-authored templates are the LLM pipeline's job.
 */
export async function seedTemplateTranslations(): Promise<number> {
  const keys = seedNaturalKeys(SEED_FILES.map(loadSeedFile));
  const rows = buildTemplateI18nRows(keys);
  if (!rows.length) return 0;
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
  return rows.length;
}

export async function seedTemplates(): Promise<{ created: number; total: number; translations: number }> {
  let created = 0;
  let total = 0;
  for (const file of SEED_FILES) {
    const seed = loadSeedFile(file);
    for (const t of seed.templates) {
      total++;
      const domain = t.domain ?? seed.domain ?? null;
      const category = seed.category;
      const [existing] = await db
        .select({ id: blockTemplates.id })
        .from(blockTemplates)
        .where(
          and(
            eq(blockTemplates.category, category),
            domain === null ? isNull(blockTemplates.domain) : eq(blockTemplates.domain, domain),
            eq(blockTemplates.name, t.name),
            isNull(blockTemplates.tenant_id),
          ),
        );
      if (existing) continue;
      await db.insert(blockTemplates).values({
        category,
        domain,
        name: t.name,
        label: t.label,
        description: t.description ?? '',
        tags: t.tags ?? [],
        descriptor: t.descriptor,
        source_ts: requireScannedSource(t.source_ts ?? renderSource(t)),
        docs_md: t.docs_md ?? renderDocs(t),
        preconditions: t.preconditions ?? [],
        postconditions: t.postconditions ?? [],
        steps: t.steps ?? [],
      });
      created++;
    }
  }
  invalidateTemplatesCache();
  const translations = await seedTemplateTranslations();
  return { created, total, translations };
}
