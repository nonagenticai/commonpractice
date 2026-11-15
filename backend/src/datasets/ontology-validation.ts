// src/datasets/ontology-validation.ts — Phase 4: validate a dataset injected into a run against the
// ontology entity it is bound to (P1 sample binding). Two checks, both driven by the confirmed
// column→attribute mapping (no mapping ⇒ nothing to validate against, skip):
//   • TYPE — each mapped column's values must match the attribute's expected block FieldType
//     (reuses the runtime descriptor engine, validateField, so host + runner agree).
//   • PII COVERAGE — an attribute flagged pii must map to a dataset column that is itself flagged
//     pii, because redaction (dataset-service.redactPii) keys off DatasetColumn.pii. An ontology-PII
//     attribute on a non-pii column would be injected UNREDACTED — the gap this catches.
//
// The pure `validateInjectedDataset` is fully unit-testable; `validateInjectedAgainstOntology` is the
// DB orchestration the run pre-flight (run-controller) calls.
import type { DatasetColumn, InjectedDataset } from '../db/dataset-types';
import { validateField } from '../exec/descriptor';
import { mapOntologyType } from '../ontology/data-block-compiler';
import {
  attributesForEntityIds,
  resolveDefaultMappingId,
  resolveSampleByDatasetSlug,
  siblingEntityIds,
  type EntityAttribute,
} from '../ontology/sample-service';
import { getMappingColumnMap } from './mapping-service';
import { db as defaultDb } from '../db/client';

type Db = typeof defaultDb;

export type DataValidationRule = 'type_mismatch' | 'pii_uncovered';

export interface DataValidationFinding {
  rule: DataValidationRule;
  dataset: string;
  column: string;
  attribute: string;
  /**
   * The English sentence. Kept BYTE-IDENTICAL by the `count`/`expected` addition below: it is the
   * only field an old frontend reads, and it stays the fallback a new frontend renders when the
   * machine fields are absent (an old backend answering a new frontend mid-roll).
   */
  message: string;
  /**
   * `type_mismatch` only — how many sampled values failed the attribute's type, and the block
   * FieldType they were checked against.
   *
   * These exist as FIELDS rather than only inside `message` because a localized sentence cannot be
   * recovered from English prose: the browser owns the words (see frontend/src/lib/i18n/), so it
   * needs the numbers. Optional so `pii_uncovered` — which has neither — is not forced to carry
   * meaningless zeros, and so a consumer written against the pre-change shape still typechecks.
   */
  count?: number;
  expected?: string;
}

export interface ValidateInjectedArgs {
  datasetSlug: string;
  columns: DatasetColumn[];
  /** { datasetColumn: attributeName } — the confirmed mapping. {} ⇒ no findings (can't validate). */
  columnMap: Record<string, string>;
  attributes: Pick<EntityAttribute, 'name' | 'type' | 'pii'>[];
  rows: Record<string, unknown>[];
  /** Head sample size for the value-type scan (cheap; rows are already capped). Default 50. */
  sampleSize?: number;
}

/** Pure validator: mapped-column value types + PII redaction coverage → findings. */
export function validateInjectedDataset(args: ValidateInjectedArgs): DataValidationFinding[] {
  const findings: DataValidationFinding[] = [];
  const attrByName = new Map(args.attributes.map((a) => [a.name, a]));
  const colByName = new Map(args.columns.map((c) => [c.name, c]));
  const sample = args.rows.slice(0, args.sampleSize ?? 50);

  for (const [column, attrName] of Object.entries(args.columnMap)) {
    const attr = attrByName.get(attrName);
    if (!attr) continue; // mapping references an attribute the entity no longer has — skip
    const col = colByName.get(column);

    // PII coverage: a pii attribute must land on a column that redaction will blank.
    if (attr.pii && !col?.pii) {
      findings.push({
        rule: 'pii_uncovered',
        dataset: args.datasetSlug,
        column,
        attribute: attrName,
        message: `Attribute '${attrName}' is PII but dataset column '${column}' is not flagged PII, so its values would be injected unredacted.`,
      });
    }

    // Type: scan a head sample; flag if any non-null value fails the attribute's expected type.
    const spec = { type: mapOntologyType(attr.type) } as const;
    let bad = 0;
    let example: unknown;
    for (const row of sample) {
      const v = row[column];
      if (v === undefined || v === null) continue;
      if (validateField(column, spec, v) !== null) {
        bad++;
        if (example === undefined) example = v;
      }
    }
    if (bad > 0) {
      findings.push({
        rule: 'type_mismatch',
        dataset: args.datasetSlug,
        column,
        attribute: attrName,
        // ⛔ DO NOT reword. `count`/`expected` below are the SAME two locals this sentence already
        // interpolates — lifting them out is additive, and any edit here silently changes what an
        // old frontend (which reads only `message`) shows.
        message: `Column '${column}' has ${bad} value(s) that don't match attribute '${attrName}' type '${attr.type}' (expected ${spec.type}; e.g. ${JSON.stringify(example)}).`,
        count: bad,
        expected: spec.type,
      });
    }
  }
  return findings;
}

/**
 * For each injected dataset bound to an ontology entity in this tenant, validate it against the
 * entity (types + PII coverage). Returns the aggregated findings; the caller applies the
 * data.validation_mode policy (block ⇒ 422, warn ⇒ audit + proceed).
 *
 * ⛔ THE MAPPING IS RESOLVED HERE, ON EVERY RUN — NOT WHEN THE SAMPLE WAS BOUND. `bindEntitySample`
 * used to resolve and store it, which made the whole contract depend on the curator confirming the
 * mapping BEFORE binding the dataset. Nothing enforces or even hints at that order (`/ontology`
 * binds from a screen with no mapping picker, and `PUT /api/datasets/:slug/mappings` re-resolves
 * nothing), so the natural order left the binding permanently NULL and the validator permanently
 * silent. A stored answer decays too: `mapping_id` is `ON DELETE SET NULL` and `pruneCellMappings`
 * runs inside every mapping save. Resolving on read deletes that entire class of staleness — order
 * of operations stops mattering, and a deleted or re-pointed mapping self-corrects next run.
 *
 * A STORED id is still honoured as an EXPLICIT override and is never second-guessed: a caller who
 * deliberately named a mapping keeps it. `bindEntitySample` is what makes that safe — it accepts an
 * explicit id only if it is confirmed and belongs to this dataset and entity family, i.e. only if
 * the resolver could have chosen it too.
 *
 * COST, because this is the run hot path. MEASURED against the seeded demo tenant by counting
 * `select()` calls through a proxy — not estimated — per injected dataset:
 *
 *   unbound (no binding at all)                1 query  → 1 query   unchanged
 *   bound, explicit mapping stored             6        → 6         unchanged
 *   bound, NULL, no confirmed mapping anywhere 1        → 4         +3
 *   bound, NULL, resolves to a mapping         1        → 7         +6
 *
 * The two rows that grow are the two that used to do NOTHING — the "1 query" was the early skip
 * that made the contract inert. +3 buys the certainty that there is genuinely nothing to validate;
 * +6 buys an actual validation. The +3 is `siblingEntityIds` (2) plus the resolver (1); the further
 * +3 is the column map (1) plus the attributes (2), which the old code also paid whenever it did
 * validate. Nothing regressed; work that was being skipped is now being done.
 *
 * The two caches below are what keep a MULTI-dataset run flat. Both are keyed by entity, so several
 * datasets bound to the SAME entity — the ordinary shape, since a flow injects several tables of one
 * domain — pay the sibling + attribute lookups ONCE. Measured: 2 datasets on one entity cost 9
 * queries, not 14. Distinct entities do not share, by definition: 3 datasets on 3 entities cost 21.
 * Both caches are per-call, so nothing survives the request and there is no invalidation problem —
 * which is the point of resolving at read time in the first place.
 */
export async function validateInjectedAgainstOntology(
  tenantId: string,
  datasets: Record<string, InjectedDataset>,
  database: Db = defaultDb,
): Promise<DataValidationFinding[]> {
  const findings: DataValidationFinding[] = [];
  const siblingCache = new Map<string, string[]>();
  const attributeCache = new Map<string, EntityAttribute[]>();

  for (const [slug, ds] of Object.entries(datasets)) {
    const binding = await resolveSampleByDatasetSlug(tenantId, slug, database);
    if (!binding) continue;

    let siblings = siblingCache.get(binding.entityId);
    if (!siblings) {
      siblings = await siblingEntityIds(tenantId, binding.entityId, database);
      siblingCache.set(binding.entityId, siblings);
    }

    const mappingId =
      binding.mappingId ??
      (await resolveDefaultMappingId(tenantId, siblings, binding.datasetId, database));
    if (!mappingId) continue; // no confirmed mapping anywhere → genuinely nothing to validate

    const columnMap = await getMappingColumnMap(mappingId, database);
    if (Object.keys(columnMap).length === 0) continue; // an empty projection validates nothing

    let attributes = attributeCache.get(binding.entityId);
    if (!attributes) {
      attributes = await attributesForEntityIds(siblings, database);
      attributeCache.set(binding.entityId, attributes);
    }

    findings.push(
      ...validateInjectedDataset({
        datasetSlug: slug,
        columns: ds.columns,
        columnMap,
        attributes,
        rows: ds.rows,
      }),
    );
  }
  return findings;
}
