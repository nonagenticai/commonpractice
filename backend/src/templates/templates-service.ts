// src/templates/templates-service.ts — read access to the seeded block-template catalog.
//
// Templates are STARTER SCAFFOLDS surfaced in the block editor ("From template" create mode). v1 is
// a seeded, read-only catalog: all rows are GLOBAL (tenant_id NULL). The dual-ownership columns +
// "own-tenant ∪ global" read shape mirror building_blocks / ontology so a later "save as template"
// can light up without a schema change. Mirrors the service shape of ontology-service.ts (an
// optional `database` param keeps it test-friendly; the global set is memoized, invalidated on seed).
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db as defaultDb, blockTemplates } from '../db/client';
import type { BlockTemplate, TemplateStep } from '../db/schema';
import type { BlockCategory, BlockDescriptor } from '../db/block-types';
import { conflict } from '../utils/http';
import { assertBlockSourceSafe } from '../blocks/source-gate';
import { getTranslationsBatch } from '../db/translations';
import { enqueueTranslations } from '../host/translation-service';
import { log } from '../host/logger';
import { DEFAULT_LOCALE } from '../utils/locale';
import {
  TEMPLATE_I18N,
  TEMPLATE_TENANT_I18N,
  templateI18nKey,
  templateNaturalKey,
  splitTags,
} from './i18n-key';

type Db = typeof defaultDb;

export interface TemplateSummary {
  id: string;
  category: BlockCategory;
  domain: string | null;
  name: string;
  label: string;
  description: string;
  tags: string[];
  /** True when the row is tenant-authored (reserved for a later "save as template"). */
  tenantOwned: boolean;
}

export interface TemplateDetail extends TemplateSummary {
  descriptor: BlockDescriptor;
  source_ts: string;
  docs_md: string;
  preconditions: string[];
  postconditions: string[];
  steps: TemplateStep[];
}

export interface TemplateListResult {
  templates: TemplateSummary[];
  /** Facets for the editor's filters (scoped to the requested category when given). */
  categories: BlockCategory[];
  domains: string[];
  tags: string[];
}

// The shipped global catalog (tenant_id NULL) is small + read-mostly → memoize the whole set.
// Tenant-authored rows (future) are read live and never cached.
//
// ⛔ THIS CACHE HOLDS BASE (`en`) ROWS ONLY, AND MUST KEEP DOING SO. It is module-level, i.e.
// shared by every request of every tenant in every language, so caching a LOCALIZED row would
// serve the first reader's language to everyone until the next seed — a cache poisoning that no
// test of a single locale can see. `localize()` therefore returns COPIES and never mutates a row
// in place; `listTemplates`' `[...await loadGlobal()]` only clones the ARRAY, so the element
// objects are the cached ones.
let globalCache: BlockTemplate[] | null = null;

/** Drop the cached global catalog. Call after ANY template seed/write. */
export function invalidateTemplatesCache(): void {
  globalCache = null;
}

async function loadGlobal(database: Db): Promise<BlockTemplate[]> {
  if (globalCache) return globalCache;
  globalCache = await database
    .select()
    .from(blockTemplates)
    .where(and(isNull(blockTemplates.tenant_id), eq(blockTemplates.hidden, false)));
  return globalCache;
}

function toSummary(r: BlockTemplate): TemplateSummary {
  return {
    id: r.id,
    category: r.category,
    domain: r.domain,
    name: r.name,
    label: r.label,
    description: r.description,
    tags: r.tags,
    tenantOwned: r.tenant_id !== null,
  };
}

function toDetail(r: BlockTemplate): TemplateDetail {
  return {
    ...toSummary(r),
    descriptor: r.descriptor,
    source_ts: r.source_ts,
    docs_md: r.docs_md,
    preconditions: r.preconditions,
    postconditions: r.postconditions,
    steps: r.steps,
  };
}

/** The template columns that hold PROSE and may therefore be overlaid from content_translations.
 *  `category`, `domain` and `name` are deliberately absent: they are IDENTIFIERS that round-trip
 *  as filter keys / natural-key parts, and translating them would break both. */
export type LocalizableField = 'label' | 'description' | 'tags' | 'docs_md';

/**
 * Overlay `fields` on `rows` with the reader's language, returning COPIES (never mutating — the
 * globals come straight out of the module-level cache).
 *
 * Two `getTranslationsBatch` calls, keyed by each row's OWN ownership — the same two-pass shape as
 * blocks/block-display-names.ts:61,64, for the same reason: 0043's natural-key unique index is
 * scoped by tenant, so a tenant template may legitimately share `(category, domain, name)` with a
 * shipped global. One bare-natural-key batch would hand the platform's curated prose to a tenant's
 * own template (templates/i18n-key.ts spells this out).
 *
 * On `en` both calls short-circuit to an empty map inside `getTranslationsBatch`
 * (db/translations.ts:118-121) and every row falls through with its base columns — no query, no
 * allocation of consequence. A row with no translation likewise keeps its base columns, so a
 * partially-translated catalog degrades per-cell rather than per-catalog.
 */
async function localize<T extends BlockTemplate>(
  rows: T[],
  locale: string,
  fields: readonly LocalizableField[],
  database: Db,
): Promise<T[]> {
  if (locale === DEFAULT_LOCALE || rows.length === 0 || fields.length === 0) return rows;

  const globalRows = rows.filter((r) => r.tenant_id === null);
  const tenantRows = rows.filter((r) => r.tenant_id !== null);
  const empty = new Map<string, Record<string, string>>();
  const globalTx = globalRows.length
    ? await getTranslationsBatch(
        TEMPLATE_I18N,
        globalRows.map((r) => templateNaturalKey(r)),
        locale,
        [...fields],
        database,
      )
    : empty;
  const tenantTx = tenantRows.length
    ? await getTranslationsBatch(
        TEMPLATE_TENANT_I18N,
        tenantRows.map((r) => templateI18nKey(r).entityId),
        locale,
        [...fields],
        database,
      )
    : empty;

  return rows.map((r) => {
    const key = templateI18nKey(r);
    const t = (r.tenant_id === null ? globalTx : tenantTx).get(key.entityId);
    if (!t) return r;
    const out = { ...r };
    for (const f of fields) {
      const v = t[f];
      // A blank cell is an ABSENCE wearing a value's type — an empty label renders a nameless
      // card, which is strictly worse than the English one it replaced. `??` cannot tell them apart.
      if (typeof v !== 'string' || v.trim() === '') continue;
      // `tags` is a string[] column but content_translations is flat (entity, locale, field) →
      // TEXT, so the localized list is stored newline-joined and split back here. See
      // templates/i18n-key.ts TAGS_SEPARATOR.
      if (f === 'tags') out.tags = splitTags(v);
      else (out as Record<string, unknown>)[f] = v;
    }
    return out;
  });
}

export interface ListOpts {
  tenantId?: string | null;
  category?: BlockCategory;
  domain?: string;
  q?: string;
  /** The reader's language. Absent ⇒ `en`, i.e. the base columns verbatim (the MCP tool surface
   *  passes nothing on purpose — an LLM client has no locale to negotiate, ai/mcp/tools.ts). */
  locale?: string;
}

/** List templates (global ∪ own-tenant), filtered + with facets for the editor's filters. */
export async function listTemplates(opts: ListOpts, database: Db = defaultDb): Promise<TemplateListResult> {
  let rows = [...(await loadGlobal(database))];
  if (opts.tenantId) {
    const tenantRows = await database
      .select()
      .from(blockTemplates)
      .where(and(eq(blockTemplates.tenant_id, opts.tenantId), eq(blockTemplates.hidden, false)));
    rows = rows.concat(tenantRows);
  }

  // ⛔ THE OVERLAY RUNS HERE — BEFORE THE `q` FILTER AND BEFORE THE SORT — AND THE PLACEMENT IS
  // THE WHOLE POINT. Every line below reads prose, and this gallery RENDERS the localized prose:
  //   * search: a Dutch reader looking at Dutch cards types a Dutch word. Filtering the `en` base
  //     columns and then translating the survivors gives them an empty gallery for text that is
  //     visibly on their screen — the same defect routes/blocks.ts:288 documents for the block
  //     library, where the fix was to make the predicate search the prose the route renders.
  //   * sort: `localeCompare` on the `en` label and then translating produces an order that is
  //     alphabetical in a language the reader is not reading — cards in no discernible order.
  // Moving this call after either of them is silently wrong in exactly those two ways, so both are
  // pinned by negative controls in tests/template-i18n.test.ts.
  const locale = opts.locale ?? DEFAULT_LOCALE;
  rows = await localize(rows, locale, ['label', 'description', 'tags'], database);

  // Facets are scoped to the requested category so the domain/tag filters stay relevant.
  const scope = opts.category ? rows.filter((r) => r.category === opts.category) : rows;
  const categories = [...new Set(rows.map((r) => r.category))].sort() as BlockCategory[];
  // ⛔ `domains` STAYS UNTRANSLATED. It is not prose: each value round-trips verbatim as
  // `?domain=<d>` on the next request and is matched against the `domain` COLUMN below. A
  // localized facet would be a filter key that matches nothing — an inert <select>. `tags` has no
  // such round-trip (the tag chips are display-only), so it derives from the localized values.
  const domains = [...new Set(scope.map((r) => r.domain).filter((d): d is string => !!d))].sort();
  const tags = [...new Set(scope.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b, locale));

  let filtered = rows;
  // `category` and `domain` are IDENTIFIERS, matched on the base row — `localize` never touches
  // either column, so these two filters are unaffected by the overlay above by construction.
  if (opts.category) filtered = filtered.filter((r) => r.category === opts.category);
  if (opts.domain) filtered = filtered.filter((r) => r.domain === opts.domain);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        // `name` is a slug-like identifier that is never translated — the arm STAYS, so a reader
        // who knows the technical name still finds the card in any language.
        r.name.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return {
    templates: filtered.map(toSummary).sort((a, b) => a.label.localeCompare(b.label, locale)),
    categories,
    domains,
    tags,
  };
}

export interface CreateTemplateInput {
  name: string;
  label: string;
  category: BlockCategory;
  description?: string;
  domain?: string | null;
  tags?: string[];
  descriptor: BlockDescriptor;
  source_ts?: string;
  docs_md?: string;
  preconditions?: string[];
  postconditions?: string[];
  steps?: TemplateStep[];
}

/**
 * Save a TENANT-scoped template (Phase 5D "save as template"). Runs on the request's tenant-bound
 * connection (the caller gated via `requireDeveloper` → `refreshTenantGuc`), so the `tenant_id` column
 * default + RLS INSERT `WITH CHECK (tenant_id = app_current_tenant_uuid())` stamp + authorize it; we
 * also set `tenant_id` explicitly for clarity. Globals stay seed-only (RLS rejects a NULL tenant on
 * INSERT). The natural key `(category, coalesce(domain,''), name, tenant)` is pre-checked for a
 * friendly 409 (and the DB unique index is the backstop). Invalidates only the global cache is a no-op
 * here — tenant rows are read live — but we call it defensively for symmetry with the seed path.
 */
export async function createTemplate(
  input: CreateTemplateInput,
  /** `userId` is the METERING ACTOR for the translation jobs enqueued below — a NULL one is
   *  UNDRAINABLE (`processPendingBatch` fails every such job with `no metering actor`), so the
   *  HTTP + MCP callers both pass the real author. */
  opts: { tenantId: string; userId?: string | null },
  database: Db = defaultDb,
): Promise<TemplateDetail> {
  const domain = input.domain?.trim() || null;
  const [dup] = await database
    .select({ id: blockTemplates.id })
    .from(blockTemplates)
    .where(
      and(
        eq(blockTemplates.tenant_id, opts.tenantId),
        eq(blockTemplates.category, input.category),
        eq(sql`coalesce(${blockTemplates.domain}, '')`, domain ?? ''),
        eq(blockTemplates.name, input.name),
      ),
    );
  if (dup) {
    // `name` named on the wire so a locale need not re-parse it out of the English sentence.
    throw conflict('template_name_taken', `A template '${input.name}' already exists for this tenant`, {
      name: input.name,
    });
  }

  // ⛔ BEFORE THE INSERT. `create_template` (MCP) and POST /api/templates both land here with an
  // agent- or author-supplied `source_ts` and wrote it unexamined. Policy-aware, like every other
  // author-facing write.
  const source = await assertBlockSourceSafe(input.source_ts ?? '');

  const [row] = await database
    .insert(blockTemplates)
    .values({
      category: input.category,
      domain,
      name: input.name,
      label: input.label,
      description: input.description ?? '',
      tags: input.tags ?? [],
      descriptor: input.descriptor,
      source_ts: source,
      docs_md: input.docs_md ?? '',
      preconditions: input.preconditions ?? [],
      postconditions: input.postconditions ?? [],
      steps: input.steps ?? [],
      tenant_id: opts.tenantId,
    })
    .returning();
  invalidateTemplatesCache();

  try {
    // ⛔ TENANT TEMPLATES ONLY — AND THIS IS THE ONLY PLACE A TEMPLATE IS EVER ENQUEUED.
    // `createTemplate` is by construction tenant-scoped (globals are seed-only; 0043's RLS INSERT
    // `WITH CHECK (tenant_id = app_current_tenant_uuid())` rejects a NULL tenant), so `templateI18nKey`
    // resolves to `block_template_tenant` here every time. The 20 SHIPPED globals are curated in
    // migration 0079 and must NEVER enter this queue: `processPendingBatch` UPSERTs into
    // `content_translations` with no curated-row guard (host/translation-service.ts:319-326), so one
    // backfill of `block_template` would overwrite 560 reviewed cells with machine output and leave
    // no trace that it had. host/translation-service.ts' backfill branch is `WHERE tenant_id IS NOT
    // NULL` for the same reason.
    // Best-effort, exactly like the block publish seam (blocks/authoring-service.ts:~424): a
    // translation queue outage must not fail the author's save.
    const key = templateI18nKey(row!);
    await enqueueTranslations(
      key.entityType,
      key.entityId,
      [
        { field: 'label', value: row!.label },
        { field: 'description', value: row!.description },
        { field: 'docs_md', value: row!.docs_md },
      ],
      opts.userId ?? null,
      { db: database },
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', {
      component: 'translation',
      entity: 'template',
      template: row!.name,
      err: e,
    });
  }

  return toDetail(row!);
}

/**
 * Delete a TENANT-scoped template (own-tenant only). Runs on the request's tenant-bound connection
 * (caller gated via `requireDeveloper` → `refreshTenantGuc`); the explicit `tenant_id` clause + RLS
 * DELETE policy (`USING tenant_id = app_current_tenant_uuid()`) both ensure a global (NULL tenant) or
 * another tenant's id is a clean no-match. Returns the deleted id, or `null` when nothing matched (the
 * route maps that to a 404). Invalidates the global cache defensively (tenant rows are read live).
 */
export async function deleteTemplate(
  id: string,
  opts: { tenantId: string },
  database: Db = defaultDb,
): Promise<string | null> {
  const [row] = await database
    .delete(blockTemplates)
    .where(and(eq(blockTemplates.id, id), eq(blockTemplates.tenant_id, opts.tenantId)))
    .returning({ id: blockTemplates.id });
  if (row) invalidateTemplatesCache();
  return row?.id ?? null;
}

/**
 * A single template (global, or own-tenant) with its full scaffold, or null if not visible.
 *
 * Overlays `docs_md` as well as the three summary fields: the detail view is where the author
 * actually READS the template, and picking it copies `docs_md` verbatim into their new block.
 * `source_ts`, `descriptor`, `preconditions`, `postconditions` and `steps` are NOT overlaid —
 * `source_ts` and `descriptor` are code/schema, and the three formal lists already reach the
 * reader through the localized `docs_md` this renders from (see templates/i18n-docs.ts). Giving
 * the raw arrays their own cells would mean two copies of the same sentences drifting apart.
 */
export async function getTemplate(
  id: string,
  opts: { tenantId?: string | null; locale?: string },
  database: Db = defaultDb,
): Promise<TemplateDetail | null> {
  const global = await loadGlobal(database);
  let row = global.find((r) => r.id === id) ?? null;
  if (!row && opts.tenantId) {
    const [t] = await database
      .select()
      .from(blockTemplates)
      .where(and(eq(blockTemplates.id, id), eq(blockTemplates.tenant_id, opts.tenantId)));
    row = t ?? null;
  }
  if (!row) return null;
  const [localized] = await localize(
    [row],
    opts.locale ?? DEFAULT_LOCALE,
    ['label', 'description', 'tags', 'docs_md'],
    database,
  );
  return toDetail(localized!);
}
