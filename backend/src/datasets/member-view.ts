// src/datasets/member-view.ts — what a reader who is NOT a data manager may see of a dataset's
// values (owner decision 2026-10-14, PLAN-2026-10-14-ux-cleanup.md §W8.1).
//
// Every read path that hands dataset VALUES to a browser goes through `memberMasks` + `maskRows` /
// `maskColumns`: `GET /api/datasets`, `GET /api/datasets/:slug`, `GET /api/connectors`,
// `GET /api/connectors/:slug`, and the challenge detail / dataset-link responses. Values are blanked
// with `redactPii` — the SAME function the MCP and block-test paths use. A RUN uses the same
// `memberMasks` decision but TYPE-PRESERVING values (`maskInjectedForReader` → datasets/run-mask.ts),
// because a blank string in a number column fails the run's typed steps.
//
// WHO SEES RAW VALUES: a data manager, i.e. `requireDataManager`'s predicate in routes/datasets.ts
// (`isDeveloper`: developer, tenant_admin, super_admin). They classify columns, and you cannot
// classify a column you are not allowed to look at. Everyone else gets the masked view.
//
// THE RULE FOR A NON-MANAGER — a column's values are shown ONLY when all of these hold:
//   1. the column is not flagged PII on the dataset (`DatasetColumn.pii`, the name heuristic or a
//      data manager's flag — the same flag a run redacts on);
//   2. EITHER a data manager marked the column not personal (`DatasetColumn.nonPersonal`, written
//      through `PATCH /api/datasets/:slug` — `requireDataManager`, the same permission as the
//      mappings; since 2026-10-15), OR a CONFIRMED mapping (dataset → ontology entity) maps the
//      column to an attribute; and
//   3. every attribute it is mapped to exists and is NOT flagged `pii` in the ontology.
// Any personal signal (1, or a mapping to a PII attribute) wins over `nonPersonal`.
// ⛔ Nothing is ever unmasked AUTOMATICALLY. datasets/column-suggestions.ts only SUGGESTS columns to
// a data manager ("Suggested: not personal"); a suggestion changes nothing until confirmed. The
// owner rejected automatic real values (2026-10-15): no rule over the data can tell 3 handlers
// ("J. de Vries") from 3 tiers.
// So an UNMAPPED column is masked. That is the safe default: nobody with data rights has yet said
// what the column means, and a free-text column ("adjuster_notes") carries names and addresses that
// no name heuristic catches. A data manager unmasks a column for members by confirming a mapping to
// a non-PII attribute. ⛔ That is why `PUT /api/datasets/:slug/mappings` and
// `DELETE /api/datasets/:slug/mappings/:entityId` require a data manager (`requireDataManager`,
// since 2026-10-15): when they only resolved the tenant, ANY member could confirm a mapping and so
// unmask a column for every member — this rule would have been decided by the people it restricts.
// A per-DATASET "not sensitive" switch is deliberately not offered; marking is per column.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db as defaultDb, datasetMappings, datasets } from '../db/client';
import type { DatasetColumn, InjectedDataset } from '../db/dataset-types';
import { PII_REDACTION } from '../db/dataset-types';
import { loadEntityAttributes, type EntityAttribute } from '../ontology/sample-service';
import { redactPii } from './dataset-service';
import { scrubPiiCell, scrubPiiRow } from './pii-values';
import { maskDatasetForRun } from './run-mask';
import { log } from '../host/logger';

type Db = typeof defaultDb;

/** The columns of one dataset whose values a non-manager must not see, in column order. */
export type MaskedColumns = string[];

/**
 * For each dataset, the column names a reader who is NOT a data manager must not see.
 * `raw = true` (a data manager) short-circuits to "nothing masked" with no query.
 * Keyed by dataset id. One mapping query for the whole batch; attributes are cached per entity.
 */
export async function memberMasks(
  tenantId: string,
  items: { id: string; columns: DatasetColumn[] | null }[],
  raw: boolean,
  database: Db = defaultDb,
): Promise<Map<string, MaskedColumns>> {
  const out = new Map<string, MaskedColumns>();
  if (raw || items.length === 0) {
    for (const d of items) out.set(d.id, []);
    return out;
  }
  for (const [id, c] of await memberColumnClassification(tenantId, items, database)) out.set(id, c.masked);
  return out;
}

/** One dataset's member-view decision: the masked columns, and every column an EXPLICIT
 *  classification covers (`pii: true`, `nonPersonal: true`, or any confirmed mapping). */
export interface MemberColumnClassification {
  masked: MaskedColumns;
  classified: Set<string>;
}

/** `memberMasks` for a non-manager, plus which columns are explicitly classified — the not-personal
 *  SUGGESTIONS (datasets/column-suggestions.ts) are only ever made for the OTHERS. */
export async function memberColumnClassification(
  tenantId: string,
  items: { id: string; columns: DatasetColumn[] | null }[],
  database: Db = defaultDb,
): Promise<Map<string, MemberColumnClassification>> {
  const out = new Map<string, MemberColumnClassification>();
  if (items.length === 0) return out;

  // Confirmed mappings visible to this tenant: its own rows + the global (seeded) ones. The tenant
  // predicate is explicit, not left to RLS — the owner connection used by schedulers and tests
  // bypasses RLS, and a wider read here would UNMASK columns, the fail-open direction.
  const mappings = await database
    .select({
      datasetId: datasetMappings.dataset_id,
      entityId: datasetMappings.entity_id,
      columnMap: datasetMappings.column_map,
    })
    .from(datasetMappings)
    .where(
      and(
        inArray(
          datasetMappings.dataset_id,
          items.map((d) => d.id),
        ),
        eq(datasetMappings.confirmed, true),
        or(isNull(datasetMappings.tenant_id), eq(datasetMappings.tenant_id, tenantId)),
      ),
    );

  const attrCache = new Map<string, Map<string, EntityAttribute>>();
  async function attrsOf(entityId: string): Promise<Map<string, EntityAttribute>> {
    let hit = attrCache.get(entityId);
    if (!hit) {
      try {
        const attrs = await loadEntityAttributes(tenantId, entityId, database);
        hit = new Map(attrs.map((a) => [a.name, a]));
      } catch (err) {
        // An entity this tenant cannot see resolves to "no attributes", which masks every column
        // mapped to it. Never let a lookup failure widen what a member sees.
        log.warn('member_mask_entity_unresolved', { entityId, err });
        hit = new Map();
      }
      attrCache.set(entityId, hit);
    }
    return hit;
  }

  // Per dataset: column → "every mapping of it is to a known, non-PII attribute".
  const safeByDataset = new Map<string, Map<string, boolean>>();
  for (const m of mappings) {
    const attrs = await attrsOf(m.entityId);
    const safe = safeByDataset.get(m.datasetId) ?? new Map<string, boolean>();
    for (const [column, attrName] of Object.entries(m.columnMap ?? {})) {
      const attr = attrs.get(attrName);
      const ok = !!attr && !attr.pii;
      safe.set(column, (safe.get(column) ?? true) && ok);
    }
    safeByDataset.set(m.datasetId, safe);
  }

  for (const d of items) {
    const safe = safeByDataset.get(d.id);
    out.set(d.id, {
      masked: (d.columns ?? []).filter((c) => isMaskedForMember(c, safe?.get(c.name))).map((c) => c.name),
      classified: new Set([
        ...(safe?.keys() ?? []),
        ...(d.columns ?? []).filter((c) => c.pii === true || c.nonPersonal === true).map((c) => c.name),
      ]),
    });
  }
  return out;
}

/** The rule above for one column. `mapped` = undefined (no confirmed mapping covers it), true (every
 *  mapping is to a known non-PII attribute) or false (some mapping is to a PII/unknown attribute).
 *  Every "personal" signal wins over every "not personal" one — fail closed on a conflict. */
function isMaskedForMember(c: DatasetColumn, mapped: boolean | undefined): boolean {
  if (c.pii === true || mapped === false) return true;
  return !(c.nonPersonal === true || mapped === true);
}

/** Rows as a reader who is NOT a data manager may see them: the masked columns blanked through
 *  the one shared `redactPii`, and every other cell scrubbed of VALUE-detected personal data
 *  (`scrubPiiRow`, datasets/pii-values.ts — an e-mail or phone number in a shown free-text column,
 *  a BSN in a column called "klant"). `raw` (a data manager) passes the rows through unchanged.
 *  ⛔ `raw` is required on purpose: an empty `masked` list does NOT mean "a data manager". */
export function maskRows(
  rows: Record<string, unknown>[],
  masked: MaskedColumns,
  raw: boolean,
): Record<string, unknown>[] {
  if (raw) return rows;
  return rows.map((r) => scrubPiiRow(masked.length ? redactPii(r, masked) : r));
}

/** Column metadata with the representative `sample` value blanked for masked columns, and
 *  value-scrubbed for the rest. The sample is a real cell value (the first non-empty one), so it
 *  leaks exactly what the rows would. `raw` (a data manager): unchanged. */
export function maskColumns(columns: DatasetColumn[], masked: MaskedColumns, raw: boolean): DatasetColumn[] {
  if (raw) return columns;
  const set = new Set(masked);
  return columns.map((c) => {
    if (c.sample === undefined) return c;
    const sample = set.has(c.name) ? PII_REDACTION : scrubPiiCell(c.name, c.sample);
    return sample === c.sample ? c : { ...c, sample: sample as DatasetColumn['sample'] };
  });
}

/**
 * The injected datasets of a RUN as a reader who is NOT a data manager may see them: every column
 * the sample-data preview masks for them is masked here too (values AND the column `sample`),
 * through the one shared `memberMasks` rule — but with values of the SAME TYPE that are not the
 * originals (`maskDatasetForRun`), where the preview shows a blank. A data manager's datasets pass
 * through unchanged.
 *
 * ⛔ The caller must load a member's rows WITHOUT `data.pii_scrubbing`'s "[redacted]" (run-controller
 * passes `redact` only for a data manager): every PII-flagged column is in `masked` anyway, and a
 * pre-redacted string in a number column is exactly the type break this function exists to avoid.
 *
 * ⛔ APPLIED TO EVERY `POST /api/runs`, not only the W8/P4 sample test (since 2026-10-15). It used
 * to run only when `sampleChallengeId` was set, so a member who wired the SAME dataset into a node
 * by hand and pressed Test-run got the raw rows in the run's output — and in every `ctx.llm()`
 * prompt a block built from them, i.e. to the tenant's external LLM. `data.pii_scrubbing` does not
 * close that: it redacts only dataset-flagged PII columns, never an unmapped free-text column, and
 * a tenant may turn it off. Block tests and simulate (blocks/test-runner.ts) do not call this: they
 * are developer-gated (`authorizeBlockWrite*` → isDeveloper), i.e. data managers only.
 */
export async function maskInjectedForReader(
  tenantId: string,
  injected: Record<string, InjectedDataset>,
  raw: boolean,
  database: Db = defaultDb,
): Promise<Record<string, InjectedDataset>> {
  const slugs = Object.keys(injected);
  if (raw || !slugs.length) return injected;
  const rows = await database
    .select({ id: datasets.id, slug: datasets.slug })
    .from(datasets)
    .where(and(eq(datasets.tenant_id, tenantId), inArray(datasets.slug, slugs)));
  const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
  const masks = await memberMasks(
    tenantId,
    slugs.flatMap((slug) => {
      const id = idBySlug.get(slug);
      return id ? [{ id, columns: injected[slug]!.columns }] : [];
    }),
    false,
    database,
  );
  const out: Record<string, InjectedDataset> = {};
  for (const slug of slugs) {
    const ds = injected[slug]!;
    const id = idBySlug.get(slug);
    // A slug with no row here cannot be classified: mask every column rather than guess.
    const masked = id ? (masks.get(id) ?? ds.columns.map((c) => c.name)) : ds.columns.map((c) => c.name);
    // TYPE-PRESERVING (datasets/run-mask.ts), not `maskRows`: a run's typed steps must receive a
    // number where the column holds numbers. "[redacted]" in a number column failed every member
    // run on an unmasked-for-them numeric column ("'amount' must be a finite number").
    out[slug] = maskDatasetForRun(`${tenantId}:${id ?? slug}`, ds.columns, ds.rows, masked);
  }
  return out;
}
