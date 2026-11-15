// src/datasets/mapping-service.ts — Phase 3.3: the dataset → ontology mapping bridge.
//
// Binds a dataset's columns to ontology entity attributes so the agent (3.4) reasons
// about MEANING + relations, not raw column names. Two suggest strategies, neither of
// which persists until a human confirms:
//   (a) heuristic — deterministic name/synonym/type scoring against the compiled
//       (industry × department) cell from 3.2's compileEffective. Maps clm_amt →
//       Claim.amount because `amount` lists `clm_amt` as a synonym.
//   (b) LLM-assisted (opt-in) — for columns the heuristic left unmatched, ask the
//       metered, spend-capped broker (brokerChatCall) for proposals, parsed + clamped.
//
// Same service shape as dataset-service.ts (pure drizzle, optional `database` param).
// Audit is done by the route, not here.
import { and, eq, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  db as defaultDb,
  datasetMappings,
  ontologyEntities,
  runAsSystem,
} from '../db/client';
import type { DatasetMapping } from '../db/schema';
import type { DatasetColumn, DatasetColumnType } from '../db/dataset-types';
import { compileEffective, entityKey, localizeEntityLabels } from '../ontology/ontology-service';
import type { CompiledEntity } from '../ontology/ontology-service';
import { DEFAULT_LOCALE } from '../utils/locale';
import { brokerChatCall } from '../host/llm-broker';
import { config } from '../config';
import { log } from '../host/logger';

type Db = typeof defaultDb;

/** SPEC §8 default: proposals ≥ this surface as high-confidence (pre-checked in the
 *  UI); below it are flagged "needs review". Tunable; only governs UI emphasis — never
 *  auto-acceptance (nothing persists as confirmed until a human confirms). */
export const MAPPING_CONFIDENCE_THRESHOLD = 0.7;

/** Heuristic floor: a column with no attribute scoring at least this is left unmatched
 *  (and becomes an LLM candidate when useLlm). */
const HEURISTIC_MATCH_FLOOR = 0.5;

// ---------------------------------------------------------------------------------------------
// TENANT SCOPE — read this before touching any writer below.
//
// ⛔ EVERY WRITER IN THIS FILE USED TO LEAVE `tenant_id` UNSET AND FILTER ON `isNull(tenant_id)`.
// That is green under `bun test` (the test connection is the table OWNER, which bypasses RLS) and
// completely dead in production, where DATABASE_URL binds the NOBYPASSRLS role `cp_app`.
// `dataset_mappings` is a 0028_rls.sql §4c "nullable global-override" table:
//     SELECT  USING      (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid())
//     INSERT  WITH CHECK (tenant_id = app_current_tenant_uuid())
//     UPDATE  USING+CHECK(tenant_id = app_current_tenant_uuid())
//     DELETE  USING      (tenant_id = app_current_tenant_uuid())
// and `schema.ts` gives the column NO default (unlike flow_run_events, which got
// `DEFAULT app_current_tenant_uuid()` in 0054). So for a real tenant:
//   INSERT → `NULL = <uuid>` is NULL → WITH CHECK fails → 42501, which is neither an HttpError nor
//            a ZodError nor 22P02, so utils/http.ts rethrows it → 500 on "save mappings".
//   UPDATE → 0 rows; `.returning()` was discarded → 200 "Saved N mapping(s)" with the OLD values.
//   DELETE → 0 rows → 404 for a mapping the GET is still listing.
//   PRUNE  → 0 rows → the entity a save re-pointed AWAY from survives and the runner's ontology
//            injection uses BOTH the old and the new mapping — the exact failure prune exists for.
// Downstream, ontology-validation.ts skips validation when no CONFIRMED mapping resolves, so the
// `pii_uncovered` run-gate could never fire for a real tenant.
//
// THE MODEL NOW: a mapping is a child of a DATASET, and every dataset is tenant-scoped
// (`routes/datasets.ts:loadInTenant`). So a mapping's owner is the dataset's tenant, and writes
// always carry it. `tenant_id IS NULL` rows still exist and still READ — the seeder
// (`db/seed-example-blocks.ts`) writes global rows for the example datasets, and it has no choice
// for the DEV_OWNER ones: `datasets.tenant_id` is a bare uuid column with no FK (it was text
// until migration 0084 — the point that matters here is the MISSING FK, not the type), while
// `dataset_mappings.tenant_id` has a real FK to `tenants`, and no `tenants` row exists for the dev
// pseudo-tenant. So "global mapping on a tenant-owned dataset" is a permanent, legitimate state,
// not migratable residue, and the read predicate stays "mine OR global".
// ---------------------------------------------------------------------------------------------

/** Who owns a mapping WRITE: a tenant uuid, or `null` for the platform/seed path (global rows). */
export type MappingScope = string | null;

/** The row-ownership predicate for one scope. */
function scopedTo(tenantId: MappingScope): SQL {
  return tenantId ? eq(datasetMappings.tenant_id, tenantId) : isNull(datasetMappings.tenant_id)!;
}

/**
 * Drop the GLOBAL (tenant_id IS NULL) rows a tenant's write supersedes, on the OWNER pool.
 *
 * ⛔ WHY AN ESCALATION IS CORRECT HERE, AND WHY ITS BLAST RADIUS IS ONE ROW ON THE CALLER'S OWN
 * DATASET. A global `dataset_mappings` row is not a shared catalogue entry the way a global
 * `ontology_entities` row is: it is keyed to ONE `dataset_id`, every dataset belongs to exactly one
 * tenant, and every route that reaches this service has already proved that ownership through
 * `loadInTenant(ctx.tenantId, slug)`. No other tenant can see the row, so nobody else can be
 * affected by removing it. Without this, a tenant editing a SEEDED mapping on its own dataset can
 * add its own row but can never retire the seed one — leaving two rows for one (dataset, entity),
 * which is precisely the double ontology injection `pruneCellMappings` exists to prevent, and
 * leaving DELETE permanently 404-ing a mapping the GET still lists.
 *
 * Runs on `defaultDb` rather than the caller's `database` handle on purpose: `runAsSystem` rebinds
 * the module-level proxy, and the only callers that reach this path are the request routes, which
 * pass no handle. The seed path never reaches it (its scope is `null`).
 */
async function reclaimGlobalRows(where: SQL): Promise<number> {
  const gone = await runAsSystem('tenant-parameterised', () =>
    defaultDb
      .delete(datasetMappings)
      .where(and(where, isNull(datasetMappings.tenant_id)))
      .returning({ id: datasetMappings.id }),
  );
  return gone.length;
}

// ---- proposal shapes (returned by suggestMappings; not persisted) ----

export interface SuggestedColumn {
  column: string;
  attribute: string;
  confidence: number;
  origin: 'heuristic' | 'llm';
}

export interface MappingSuggestion {
  entityId: string;
  entityName: string;
  entityLabel: string;
  industry: string;
  department: string;
  /** { datasetColumn: attributeName } — the persisted column_map grain. */
  columnMap: Record<string, string>;
  /** Aggregate confidence for the (dataset, entity) mapping (mean of its columns). */
  confidence: number;
  columns: SuggestedColumn[];
}

/** A stored mapping joined with its entity's display fields (for the API/UI). */
export interface MappingRow {
  id: string;
  entityId: string;
  entityName: string;
  entityLabel: string;
  industry: string;
  department: string;
  columnMap: Record<string, string>;
  confidence: number;
  source: DatasetMapping['source'];
  confirmed: boolean;
  updatedAt: Date;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Loose dataset-column-type ↔ ontology-attribute-type compatibility. */
function typeCompatible(colType: DatasetColumnType, attrType: string): boolean {
  const a = attrType.toLowerCase();
  if (colType === (a as DatasetColumnType)) return true;
  if (colType === 'json' || a === 'json') return true; // permissive catch-all
  if (colType === 'number') return ['number', 'integer', 'int', 'float', 'decimal'].includes(a);
  if (colType === 'date') return ['date', 'datetime', 'timestamp'].includes(a);
  if (colType === 'string') return ['string', 'text', 'enum'].includes(a);
  if (colType === 'boolean') return ['boolean', 'bool'].includes(a);
  return false;
}

interface ColumnMatch {
  entity: CompiledEntity;
  attribute: string;
  confidence: number;
}

/** Best (entity, attribute) for one column across the compiled cell, or null. */
function bestHeuristicMatch(col: DatasetColumn, entities: CompiledEntity[]): ColumnMatch | null {
  const cn = norm(col.name);
  let best: ColumnMatch | null = null;
  for (const entity of entities) {
    for (const attr of entity.attributes) {
      const an = norm(attr.name);
      let score = 0;
      if (cn === an) {
        score = 1;
      } else if (attr.synonyms.some((s) => norm(s) === cn)) {
        score = 0.92;
      } else if (cn.length >= 3 && (an.includes(cn) || cn.includes(an))) {
        score = 0.6;
      } else if (attr.synonyms.some((s) => norm(s).includes(cn) || cn.includes(norm(s)))) {
        score = 0.55;
      }
      if (score === 0) continue;
      if (!typeCompatible(col.type, attr.type)) score *= 0.85;
      if (!best || score > best.confidence) best = { entity, attribute: attr.name, confidence: score };
    }
  }
  return best;
}

const llmItemSchema = z.object({
  column: z.string(),
  entity: z.string(),
  attribute: z.string(),
  confidence: z.number(),
});

/** Extract the first JSON array from a possibly-prosey/code-fenced LLM response. */
function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface SuggestArgs {
  columns: DatasetColumn[];
  industry: string;
  department: string;
  userId: string;
  tenantId: string | null;
  useLlm?: boolean;
  signal?: AbortSignal;
}

/**
 * Propose column→concept mappings for a dataset against the (industry × department)
 * cell. Heuristic always; LLM-assisted for unmatched columns when `useLlm`. Returns
 * grouped (dataset, entity) suggestions WITHOUT persisting anything.
 */
export async function suggestMappings(
  args: SuggestArgs,
  database: Db = defaultDb,
): Promise<MappingSuggestion[]> {
  const cell = await compileEffective(args.industry, args.department, {
    tenantId: args.tenantId ?? null,
    database,
  });
  const entitiesByName = new Map(cell.entities.map((e) => [e.name, e]));

  // Per-column best assignment from the heuristic.
  const assigned = new Map<string, { entity: CompiledEntity; attribute: string; confidence: number; origin: 'heuristic' | 'llm' }>();
  const unmatched: DatasetColumn[] = [];
  for (const col of args.columns) {
    const m = bestHeuristicMatch(col, cell.entities);
    if (m && m.confidence >= HEURISTIC_MATCH_FLOOR) {
      assigned.set(col.name, { entity: m.entity, attribute: m.attribute, confidence: m.confidence, origin: 'heuristic' });
    } else {
      unmatched.push(col);
    }
  }

  // LLM-assisted pass for the columns the heuristic could not place.
  if (args.useLlm && unmatched.length > 0 && cell.entities.length > 0) {
    const llm = await proposeWithLlm(unmatched, cell.entities, args);
    for (const item of llm) {
      const entity = entitiesByName.get(item.entity);
      if (!entity) continue;
      if (!entity.attributes.some((a) => a.name === item.attribute)) continue;
      if (!unmatched.some((c) => c.name === item.column)) continue; // never override heuristic
      const confidence = Math.max(0, Math.min(1, item.confidence));
      const prev = assigned.get(item.column);
      if (!prev || confidence > prev.confidence) {
        assigned.set(item.column, { entity, attribute: item.attribute, confidence, origin: 'llm' });
      }
    }
  }

  // Group assignments by entity → one suggestion per (dataset, entity).
  const byEntity = new Map<string, MappingSuggestion>();
  for (const [column, a] of assigned) {
    let s = byEntity.get(a.entity.id);
    if (!s) {
      s = {
        entityId: a.entity.id,
        entityName: a.entity.name,
        entityLabel: a.entity.label,
        industry: args.industry,
        department: args.department,
        columnMap: {},
        confidence: 0,
        columns: [],
      };
      byEntity.set(a.entity.id, s);
    }
    s.columnMap[column] = a.attribute;
    s.columns.push({ column, attribute: a.attribute, confidence: round2(a.confidence), origin: a.origin });
  }
  for (const s of byEntity.values()) {
    s.confidence = round2(s.columns.reduce((sum, c) => sum + c.confidence, 0) / s.columns.length);
  }
  // Highest-confidence entities first.
  return [...byEntity.values()].sort((a, b) => b.confidence - a.confidence);
}

async function proposeWithLlm(
  unmatched: DatasetColumn[],
  entities: CompiledEntity[],
  args: SuggestArgs,
): Promise<z.infer<typeof llmItemSchema>[]> {
  const ontologyDesc = entities
    .map(
      (e) =>
        `- ${e.name}: ${e.attributes.map((a) => a.name + (a.synonyms.length ? ` (aka ${a.synonyms.join('/')})` : '')).join(', ')}`,
    )
    .join('\n');
  const columnsDesc = unmatched.map((c) => `- ${c.name} (${c.type})`).join('\n');
  const system =
    'You map dataset columns to ontology entity attributes. Reply with ONLY a JSON array ' +
    '[{"column": string, "entity": string, "attribute": string, "confidence": number 0..1}]. ' +
    'Use only entity/attribute names from the provided ontology. Omit a column if nothing fits.';
  const user = `Ontology (${args.industry} × ${args.department}):\n${ontologyDesc}\n\nUnmapped dataset columns:\n${columnsDesc}\n\nReturn the JSON array.`;

  const outcome = await brokerChatCall(
    args.userId,
    args.tenantId,
    {
      model: config.agent.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      maxTokens: 1024,
    },
    { signal: args.signal ?? new AbortController().signal },
    { stage: 'dataset-mapping' },
  );
  // CALLER CONTRACT: `[]` means "the LLM added nothing", NOT "the LLM failed" — suggestMappings
  // merges this on top of an already-complete heuristic pass, and its one caller (the MCP
  // map_dataset tool) has no channel for a partial result. Degrading to heuristic-only is the
  // right product behaviour, so we deliberately do NOT throw. But a broker rejection
  // (budget_exhausted / model_not_allowed) or a model that returns prose instead of JSON was
  // previously indistinguishable from "nothing matched" with nothing in the logs — a mapping
  // screen that silently stops using the LLM the day a tenant's budget runs out. Log loudly so
  // the degrade is visible; the return value stays `[]`.
  if (!outcome.ok) {
    log.error('llm_suggest_failed', { component: 'mapping', kind: outcome.kind, error: outcome.error });
    return [];
  }
  if (!outcome.result.text) {
    log.error('llm_suggest_failed', { component: 'mapping', reason: 'empty_response' });
    return [];
  }
  const arr = extractJsonArray(outcome.result.text);
  if (!arr) {
    log.error('llm_suggest_failed', {
      component: 'mapping',
      reason: 'unparseable_response',
      textPreview: outcome.result.text.slice(0, 300),
    });
    return [];
  }
  const out: z.infer<typeof llmItemSchema>[] = [];
  for (const raw of arr) {
    const parsed = llmItemSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- persistence (global scope this phase: tenant_id IS NULL) ----

export interface ListMappingsOptions {
  /** Reader locale for `entityLabel`. Omitted or `DEFAULT_LOCALE` = the en base column — i.e.
   *  exactly the behaviour every existing caller had, and no extra query. */
  locale?: string;
  /** The org whose own overrides' translations apply. Tenant entity i18n is org-isolated
   *  (ONTOLOGY_ENTITY_TENANT_I18N), so without this a tenant-authored entity stays en. */
  tenantId?: string | null;
}

/**
 * Current mappings for a dataset, joined with their entity display fields.
 *
 * ⛔ `entityLabel` IS DISPLAY PROSE AND WAS THE ONLY ONTOLOGY LABEL IN THE PRODUCT THAT NEVER
 * TRANSLATED. `grep -n locale` over this file returned nothing, while `compileEffective` has joined
 * `content_translations` since 3.7 — so the very same row read "Tussenpersoon-notitie" on
 * /ontology and "Broker Note" on /challenges/[id], whose "This challenge involves:" chips come from
 * here via `resolveChallengeEntities`. The join is not repeated here: `localizeEntityLabels` is
 * `compileEffective`'s own two passes, extracted.
 *
 * ⚠️ OPT-IN, and the line is drawn at the CONSUMER, not the route. An earlier version of this note
 * said "the two /datasets routes … are deliberately English", which was wrong and cost a release:
 * it lumped together two consumers that want opposite things.
 *
 *   LOCALIZED — a human reads the label as prose:
 *     • routes/datasets.ts GET + PUT /api/datasets/:slug/mappings → NodeConfigPanel.svelte:197,
 *       `nodecfg_ontology_coverage` → nl "… kolommen gekoppeld aan {entity}".
 *     • resolveChallengeEntities (from routes/challenges.ts) → the "involves" chips.
 *
 *   EN — no human reader, or the value is an identifier:
 *     • ai/mcp/tools.ts `list_mappings` — agent input; concept vocabulary stays canonical, the
 *       same rule that keeps predicates and attribute names en.
 *     • routes/delivery.ts → buildDeliveryPayload — likewise agent-facing.
 *
 * `/datasets/+page.svelte` is unaffected by either choice: it renders `entityName`, never
 * `entityLabel`. `entityName` is the canonical concept id and is never localized anywhere.
 */
export async function listMappings(
  datasetId: string,
  database: Db = defaultDb,
  opts: ListMappingsOptions = {},
): Promise<MappingRow[]> {
  const rows = await database
    .select({
      id: datasetMappings.id,
      entityId: datasetMappings.entity_id,
      entityName: ontologyEntities.name,
      entityLabel: ontologyEntities.label,
      industry: datasetMappings.industry,
      department: datasetMappings.department,
      columnMap: datasetMappings.column_map,
      confidence: datasetMappings.confidence,
      source: datasetMappings.source,
      confirmed: datasetMappings.confirmed,
      updatedAt: datasetMappings.updated_at,
      // Not on MappingRow — the four columns `entityKey` needs plus the tenant flag, so the
      // localization pass can build the same reseed-stable natural key `compileEffective` uses.
      // ⚠️ The entity's OWN scope/industry/department, NOT `datasetMappings.industry` /
      // `.department` above: those record the cell the mapping was made IN, which is not
      // necessarily where the entity is declared (a generic `Customer` mapped from the insurance
      // Claims cell), and keying off them would look up a translation that does not exist.
      entityScope: ontologyEntities.scope,
      entityIndustry: ontologyEntities.industry,
      entityDepartment: ontologyEntities.department,
      entityTenantId: ontologyEntities.tenant_id,
      // The MAPPING's own owner (not the entity's) — drives the tenant-supersedes-global collapse
      // below. Stripped from the returned row like the four `entity*` columns above.
      tenantId: datasetMappings.tenant_id,
    })
    .from(datasetMappings)
    .innerJoin(ontologyEntities, eq(datasetMappings.entity_id, ontologyEntities.id))
    .where(
      and(
        eq(datasetMappings.dataset_id, datasetId),
        // MINE OR GLOBAL — the same shape `compileEffective` uses for ontology_entities, and the
        // same shape 0028 §4c's SELECT policy grants. Reading only `tenant_id = mine` would
        // silently unmap every SEEDED example dataset in the product; reading only `IS NULL` (what
        // this used to do) hides everything a tenant has ever saved for itself.
        opts.tenantId
          ? or(isNull(datasetMappings.tenant_id), eq(datasetMappings.tenant_id, opts.tenantId))
          : isNull(datasetMappings.tenant_id),
      ),
    );

  // A tenant-owned row SUPERSEDES the global row for the same entity. `upsertMapping` reclaims the
  // global row it replaces, so this should never have anything to collapse — but a read that can
  // return the same (dataset, entity) twice would double the runner's ontology injection, and the
  // natural-key unique index (coalesce over tenant_id) permits both rows to exist, so the read
  // asserts the invariant rather than assuming it.
  const byEntity = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byEntity.get(r.entityId);
    if (!prev || (!prev.tenantId && r.tenantId)) byEntity.set(r.entityId, r);
  }
  const deduped = rows.filter((r) => byEntity.get(r.entityId) === r);

  const localizable = deduped.map((r) => ({
    key: entityKey({
      scope: r.entityScope,
      industry: r.entityIndustry,
      department: r.entityDepartment,
      name: r.entityName,
    }),
    tenantOwned: !!r.entityTenantId,
    label: r.entityLabel,
  }));
  await localizeEntityLabels(localizable, {
    locale: opts.locale ?? DEFAULT_LOCALE,
    tenantId: opts.tenantId ?? null,
    database,
  });

  return deduped.map(
    ({ entityScope, entityIndustry, entityDepartment, entityTenantId, tenantId, ...r }, i) => ({
      ...r,
      entityLabel: localizable[i]!.label,
      columnMap: r.columnMap ?? {},
    }),
  );
}

/** The persisted column→attribute map for one mapping id ({} when absent). Used by the Phase-4
 *  run-time validator + P3 derivation to project dataset columns onto ontology attributes. */
export async function getMappingColumnMap(
  mappingId: string,
  database: Db = defaultDb,
): Promise<Record<string, string>> {
  const [m] = await database
    .select({ cm: datasetMappings.column_map })
    .from(datasetMappings)
    .where(eq(datasetMappings.id, mappingId));
  return m?.cm ?? {};
}

export interface UpsertMappingArgs {
  datasetId: string;
  entityId: string;
  industry: string;
  department: string;
  columnMap: Record<string, string>;
  confidence: number;
  source: DatasetMapping['source'];
  confirmed: boolean;
  /** REQUIRED. The dataset's tenant for a request write; `null` only on the platform/seed path.
   *  See the TENANT SCOPE block at the top of this file — omitting it is the whole defect. */
  tenantId: MappingScope;
}

/** Insert/update one (dataset, entity) mapping in `args.tenantId`'s scope. Idempotent on the
 *  natural key (dataset_id, entity_id, coalesce(tenant_id, …)). A tenant write also retires the
 *  GLOBAL row for the same (dataset, entity), which its own row now supersedes. */
export async function upsertMapping(args: UpsertMappingArgs, database: Db = defaultDb): Promise<DatasetMapping> {
  // ⛔ ONE RETRY, AND ONLY ON 23505. This is SELECT-then-INSERT, so two concurrent first-saves of
  // the same (dataset, entity, tenant) both miss the SELECT and both take the INSERT branch; the
  // loser hits `dataset_mappings_natural_uq` and — 23505 being neither an HttpError, a ZodError
  // nor a 22P02 — `utils/http.ts` rethrows it as a bare 500. The user shape is mundane: a
  // double-clicked "Opslaan", or two admins on the same dataset.
  //
  // The race PRE-DATES this file's tenant-scope fix (reproduced on the parent commit at 16-way
  // concurrency), but the fix makes it EASIER to reach: a tenant's SELECT no longer sees the
  // seeded global row, so every concurrent first-save now takes the INSERT branch — it fires at
  // 8-way. Widening the door is reason enough to close it here rather than defer it.
  //
  // A retry rather than ON CONFLICT because the unique index is on the EXPRESSION
  // `coalesce(tenant_id, …)`, which drizzle cannot name as a conflict target without dropping to
  // raw SQL and hand-mapping the row back. The retry is bounded at one and re-enters through the
  // ordinary path, so the winner's row is then found by the SELECT and updated — which is exactly
  // what the loser of the race should have done in the first place.
  return await upsertMappingOnce(args, database);
}

/** Postgres 23505 — unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

async function upsertMappingOnce(args: UpsertMappingArgs, database: Db): Promise<DatasetMapping> {
  const identity = and(
    eq(datasetMappings.dataset_id, args.datasetId),
    eq(datasetMappings.entity_id, args.entityId),
  )!;
  const [existing] = await database
    .select({ id: datasetMappings.id })
    .from(datasetMappings)
    .where(and(identity, scopedTo(args.tenantId)));
  let row: DatasetMapping;
  if (existing) {
    const [updated] = await database
      .update(datasetMappings)
      .set({
        industry: args.industry,
        department: args.department,
        column_map: args.columnMap,
        confidence: args.confidence,
        source: args.source,
        confirmed: args.confirmed,
        updated_at: new Date(),
      })
      .where(eq(datasetMappings.id, existing.id))
      .returning();
    // ⛔ NOT `return updated!`. That is how this failed SILENTLY: the UPDATE matched 0 rows under
    // RLS, `.returning()` came back empty, and the route — which discards this value — answered
    // 200 "Saved N mapping(s)" with the row untouched. A write that changed nothing must say so.
    if (!updated) {
      throw new Error(
        `dataset_mappings UPDATE matched 0 rows for mapping ${existing.id} (dataset ${args.datasetId}, entity ${args.entityId}) — RLS scope mismatch`,
      );
    }
    row = updated;
  } else {
    const [inserted] = await database
      .insert(datasetMappings)
      .values({
        dataset_id: args.datasetId,
        entity_id: args.entityId,
        industry: args.industry,
        department: args.department,
        column_map: args.columnMap,
        confidence: args.confidence,
        source: args.source,
        confirmed: args.confirmed,
        // The line whose absence made every tenant save a 500 under `cp_app`.
        tenant_id: args.tenantId,
      })
      .returning();
    row = inserted!;
  }
  if (args.tenantId) await reclaimGlobalRows(identity);
  return row;
}

/** Delete one (dataset, entity) mapping (global scope). Returns true if a row went. */
/**
 * Delete every saved mapping for a dataset's (industry × department) CELL whose entity is not in
 * `keepEntityIds`. A confirmed save (PUT) is authoritative for the cell it covers, so re-mapping a
 * column from entity A to entity B (which drops A from the working set) must remove A's now-orphaned
 * mapping — otherwise the runner's ontology injection silently uses BOTH the old and new mapping.
 * No-op when `keepEntityIds` is empty (the UI disables save with no picks; removal goes via deleteMapping).
 */
export async function pruneCellMappings(
  datasetId: string,
  industry: string,
  department: string,
  keepEntityIds: string[],
  tenantId: MappingScope,
  database: Db = defaultDb,
): Promise<number> {
  if (!keepEntityIds.length) return 0;
  const doomed = and(
    eq(datasetMappings.dataset_id, datasetId),
    eq(datasetMappings.industry, industry),
    eq(datasetMappings.department, department),
    notInArray(datasetMappings.entity_id, keepEntityIds),
  )!;
  const deleted = await database
    .delete(datasetMappings)
    .where(and(doomed, scopedTo(tenantId)))
    .returning({ id: datasetMappings.id });
  // A tenant's save is authoritative for the CELL of its own dataset, so it must also retire the
  // seeded global rows the cell no longer covers. Skipping them leaves the runner injecting both
  // the old and the new mapping — the failure this function exists to prevent.
  const reclaimed = tenantId ? await reclaimGlobalRows(doomed) : 0;
  return deleted.length + reclaimed;
}

export async function deleteMapping(
  datasetId: string,
  entityId: string,
  tenantId: MappingScope,
  database: Db = defaultDb,
): Promise<boolean> {
  const identity = and(
    eq(datasetMappings.dataset_id, datasetId),
    eq(datasetMappings.entity_id, entityId),
  )!;
  const deleted = await database
    .delete(datasetMappings)
    .where(and(identity, scopedTo(tenantId)))
    .returning({ id: datasetMappings.id });
  // The GET lists global rows too (see listMappings), so a DELETE that could only ever remove the
  // tenant's own row 404s a mapping the product is still showing. Reclaim it.
  const reclaimed = tenantId ? await reclaimGlobalRows(identity) : 0;
  return deleted.length + reclaimed > 0;
}
