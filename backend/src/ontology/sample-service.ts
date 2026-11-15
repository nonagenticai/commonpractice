// src/ontology/sample-service.ts — Phase 1: bind tenant datasets as test data for ontology
// entities. This is the missing "each ontology part gets test data" piece. A data-type block
// (Phase 3) is later derived from an entity + its PRIMARY sample, and the runtime (Phase 4)
// validates rows against the entity's attributes.
//
// Resolution is by the reseed-stable natural key (scope/industry/department/name), NOT raw uuid:
// the compiled entity id flips to the tenant-override row once a tenant overrides a global entity,
// and all ids churn on a DB reset. So a sample bound to either the global row or the tenant
// override surfaces for the entity — mirroring how compileEffective merges entities by name.
//
// Access pattern mirrors ontology-service: explicit tenant_id filters + a `database: Db` param
// (RLS is the backstop; the explicit filter is the contract).
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  db as defaultDb,
  ontologyEntities,
  ontologyAttributes,
  ontologyEntitySamples,
  datasets,
  datasetMappings,
} from '../db/client';
import { badRequest, notFound } from '../utils/http';

type Db = typeof defaultDb;

/** An ontology entity attribute, merged across natural-key siblings (the shape the data-block
 *  compiler + the Phase-4 validator consume). */
export interface EntityAttribute {
  name: string;
  type: string;
  pii: boolean;
  description: string | null;
}

/** The entity an injected dataset is bound to (reverse of resolvePrimarySample), for run-time
 *  validation (Phase 4). Null when the dataset is not bound to any entity in this tenant. */
export interface DatasetEntityBinding {
  entityId: string;
  /** The bound dataset's id. Carried because READ-time mapping resolution needs it — the caller
   *  looked the binding up by slug and would otherwise have to re-query for the id. */
  datasetId: string;
  /**
   * The caller's EXPLICIT mapping choice, or NULL. NULL is the normal case and is NOT "no mapping"
   * — see `resolveDefaultMappingId`: the reader resolves the confirmed mapping itself.
   */
  mappingId: string | null;
  isPrimary: boolean;
}

export interface EntitySampleView {
  id: string;
  datasetId: string;
  datasetSlug: string;
  datasetName: string;
  rowCount: number;
  mappingId: string | null;
  isPrimary: boolean;
}

/**
 * The ontology_entities row ids that share the natural key of `entityId` AND are visible to the
 * tenant: the shipped global row (tenant_id IS NULL) + this tenant's override. Samples may bind
 * to either, so list/resolve union across them. Throws 404 if the anchor is missing or belongs
 * to another tenant.
 */
export async function siblingEntityIds(
  tenantId: string,
  entityId: string,
  database: Db = defaultDb,
): Promise<string[]> {
  const [anchor] = await database
    .select()
    .from(ontologyEntities)
    .where(eq(ontologyEntities.id, entityId));
  if (!anchor || (anchor.tenant_id !== null && anchor.tenant_id !== tenantId)) {
    throw notFound('entity_not_found', 'No ontology entity with that id');
  }
  const rows = await database
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, anchor.scope),
        anchor.industry === null
          ? isNull(ontologyEntities.industry)
          : eq(ontologyEntities.industry, anchor.industry),
        anchor.department === null
          ? isNull(ontologyEntities.department)
          : eq(ontologyEntities.department, anchor.department),
        eq(ontologyEntities.name, anchor.name),
        or(isNull(ontologyEntities.tenant_id), eq(ontologyEntities.tenant_id, tenantId)),
      ),
    );
  return rows.map((r) => r.id);
}

/** List the test-data bindings for an entity (across its natural-key siblings), newest-primary first. */
export async function listEntitySamples(
  tenantId: string,
  entityId: string,
  database: Db = defaultDb,
): Promise<EntitySampleView[]> {
  const ids = await siblingEntityIds(tenantId, entityId, database);
  if (ids.length === 0) return [];
  const rows = await database
    .select({
      id: ontologyEntitySamples.id,
      datasetId: datasets.id,
      datasetSlug: datasets.slug,
      datasetName: datasets.name,
      rowCount: datasets.row_count,
      mappingId: ontologyEntitySamples.mapping_id,
      isPrimary: ontologyEntitySamples.is_primary,
    })
    .from(ontologyEntitySamples)
    .innerJoin(datasets, eq(datasets.id, ontologyEntitySamples.dataset_id))
    .where(
      and(
        inArray(ontologyEntitySamples.entity_id, ids),
        eq(ontologyEntitySamples.tenant_id, tenantId),
      ),
    );
  // Primary first, then by dataset name for a stable order.
  return rows.sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.datasetName.localeCompare(b.datasetName),
  );
}

/**
 * Merge an entity's attributes across its natural-key siblings (a tenant override of a name wins
 * over the global of the same name) — the resolution model sample binding + P3 derivation use.
 * Shared by data-block-derivation (P3) and ontology-validation (P4).
 */
export async function loadEntityAttributes(
  tenantId: string,
  entityId: string,
  database: Db = defaultDb,
): Promise<EntityAttribute[]> {
  return attributesForEntityIds(await siblingEntityIds(tenantId, entityId, database), database);
}

/**
 * `loadEntityAttributes` for a sibling set the caller ALREADY resolved. Split out purely so a
 * caller that needs the sibling ids for something else (ontology-validation resolves the mapping
 * from them) does not pay for `siblingEntityIds` twice per dataset on the run hot path.
 *
 * ⚠️ `ids` MUST be a `siblingEntityIds` result — it is the tenant-visibility filter. Passing a raw
 * id list would read another tenant's attributes.
 */
export async function attributesForEntityIds(
  ids: string[],
  database: Db = defaultDb,
): Promise<EntityAttribute[]> {
  if (ids.length === 0) return [];
  const entRows = await database
    .select({ id: ontologyEntities.id, tenant_id: ontologyEntities.tenant_id })
    .from(ontologyEntities)
    .where(inArray(ontologyEntities.id, ids));
  const tenantOwned = new Set(entRows.filter((e) => e.tenant_id !== null).map((e) => e.id));
  const attrRows = await database
    .select({
      entity_id: ontologyAttributes.entity_id,
      name: ontologyAttributes.name,
      type: ontologyAttributes.type,
      pii: ontologyAttributes.pii,
      description: ontologyAttributes.description,
    })
    .from(ontologyAttributes)
    .where(inArray(ontologyAttributes.entity_id, ids));
  // Global rows first, tenant rows last → a tenant attribute of the same name wins.
  const ordered = [...attrRows].sort(
    (a, b) => Number(tenantOwned.has(a.entity_id)) - Number(tenantOwned.has(b.entity_id)),
  );
  const byName = new Map<string, EntityAttribute>();
  for (const a of ordered) {
    byName.set(a.name, { name: a.name, type: a.type, pii: a.pii, description: a.description });
  }
  return [...byName.values()];
}

/**
 * The entity an injected dataset slug is bound to in this tenant (reverse of resolvePrimarySample).
 * Prefers the primary binding. Null when unbound. Used by the Phase-4 run-time validator.
 */
export async function resolveSampleByDatasetSlug(
  tenantId: string,
  slug: string,
  database: Db = defaultDb,
): Promise<DatasetEntityBinding | null> {
  const rows = await database
    .select({
      entityId: ontologyEntitySamples.entity_id,
      datasetId: ontologyEntitySamples.dataset_id,
      mappingId: ontologyEntitySamples.mapping_id,
      isPrimary: ontologyEntitySamples.is_primary,
    })
    .from(ontologyEntitySamples)
    .innerJoin(datasets, eq(datasets.id, ontologyEntitySamples.dataset_id))
    .where(and(eq(datasets.slug, slug), eq(ontologyEntitySamples.tenant_id, tenantId)));
  if (rows.length === 0) return null;
  return rows.find((r) => r.isPrimary) ?? rows[0]!;
}

/** The PRIMARY sample for an entity (the data a derived data block emits), or null. */
export async function resolvePrimarySample(
  tenantId: string,
  entityId: string,
  database: Db = defaultDb,
): Promise<EntitySampleView | null> {
  const samples = await listEntitySamples(tenantId, entityId, database);
  return samples.find((s) => s.isPrimary) ?? samples[0] ?? null;
}

export interface BindSampleInput {
  datasetId: string;
  mappingId?: string | null;
  isPrimary?: boolean;
}

/**
 * The CONFIRMED mapping to project a binding through when the binding names none.
 *
 * ⛔ WHY THIS EXISTS AT ALL. `mapping_id` was write-only in practice: `bindEntitySample` is the
 * table's ONLY writer, and neither of its two callers ever supplied one — the seed passed
 * `{datasetId, isPrimary}` and the route passed `body.mappingId ?? null` from a UI that has no
 * mapping picker. So every row in `ontology_entity_samples` carried NULL, and
 * `datasets/ontology-validation.ts` skips a NULL binding by design ("no confirmed mapping ⇒
 * nothing to validate against"). The consequence was that `pii_uncovered` and `type_mismatch`
 * could not fire for ANY real tenant, no matter how corrupt the data — the run pre-flight, the
 * `block` 422 and the warn pill were all unreachable code. Meanwhile the confirmed mappings a
 * human had already saved on the Datasets screen sat right there, keyed by exactly the
 * (dataset, entity) pair, unused.
 *
 * ⛔ CALLED AT READ TIME, NOT AT BIND TIME — AND THAT IS THE WHOLE DESIGN. This used to run inside
 * `bindEntitySample` and store its answer. That only ever worked for a curator who confirmed the
 * mapping BEFORE binding the sample, and nothing asks them to: `/ontology`'s bind sends a bare
 * `{datasetId, isPrimary}` from a screen with no mapping picker, so the natural order — attach the
 * test data, then map the columns — left `mapping_id` NULL forever, because
 * `PUT /api/datasets/:slug/mappings` re-resolves nothing. A stored answer also DECAYS: `mapping_id`
 * is `ON DELETE SET NULL` and `pruneCellMappings` fires inside every mapping save, so a live
 * binding silently reverts to NULL with nothing to heal it. Resolving on every read makes both
 * failure modes structurally impossible — order of operations stops mattering and a deleted or
 * re-pointed mapping self-corrects on the next run. See datasets/ontology-validation.ts.
 *
 * ⛔ CONFIRMED ONLY. `confirmed=false` is an UNREVIEWED proposal (heuristic or LLM —
 * datasets/mapping-service.ts is explicit that nothing persists as confirmed until a human
 * confirms). Defaulting to one would let a machine guess drive a gate that can REFUSE a run under
 * `data.validation_mode: block`. No confirmed mapping ⇒ NULL ⇒ the validator skips, which is the
 * honest answer: there is genuinely nothing to validate against. `bindEntitySample` enforces the
 * same rule on an EXPLICIT id, so the stored-override path cannot smuggle an unconfirmed map past
 * this.
 *
 * SCOPE. Mappings are keyed `(dataset_id, entity_id, coalesce(tenant_id, 0-uuid))` — see the
 * expression index in migrations/0019_dataset_mappings.sql. `dataset_id` is the tenant's OWN
 * dataset (the caller has already proved that), so a global-scope (tenant NULL) row is not another
 * tenant's data and cannot leak across the boundary. Candidates are therefore the global row plus
 * this tenant's own override.
 *
 * ⚠️ THE CANDIDATE SET IS THE NATURAL-KEY FAMILY, NOT THE (dataset, entity) PAIR. `entityIds` is a
 * `siblingEntityIds` result, so a mapping confirmed against the SHIPPED GLOBAL entity is a
 * candidate for a binding made against this tenant's OVERRIDE of that entity, and vice versa. That
 * is deliberate and it is the same widening `listEntitySamples` and `loadEntityAttributes` already
 * apply — a sample may legitimately bind to either row of a natural-key pair, and the ids churn on
 * a DB reset. But say plainly what it does: a tenant override `E_B` that has NO mapping of its own
 * WILL pick up the global sibling `E_GLOBAL`'s mapping, and the validator can then emit
 * `pii_uncovered` naming an attribute that belongs to `E_GLOBAL` rather than to `E_B`. That is not
 * an exposure — same tenant, same dataset, and `loadEntityAttributes` merges the same siblings'
 * attributes anyway, so the attribute was already in scope for this binding — but it is NOT "the
 * confirmed mapping for this exact pair", and reading it as such will mislead the next person.
 *
 * TIE-BREAK, for the case where several confirmed mappings cover the family (a global one and a
 * tenant-scoped one, or one per sibling):
 *   1. tenant-owned beats global — the same "the tenant's override wins" rule `loadEntityAttributes`
 *      and `compileEffective` already apply to the ontology itself;
 *   2. then most recently updated — the mapping a human confirmed last;
 *   3. then lowest id — so the result is deterministic even for two rows written in the same tick.
 * Deterministic beats NULL here because every candidate is a HUMAN-CONFIRMED map of the very
 * dataset being validated onto an entity whose attributes this binding already merges.
 */
export async function resolveDefaultMappingId(
  tenantId: string,
  entityIds: string[],
  datasetId: string,
  database: Db,
): Promise<string | null> {
  if (entityIds.length === 0) return null;
  const rows = await database
    .select({
      id: datasetMappings.id,
      tenant_id: datasetMappings.tenant_id,
      updated_at: datasetMappings.updated_at,
    })
    .from(datasetMappings)
    .where(
      and(
        eq(datasetMappings.dataset_id, datasetId),
        inArray(datasetMappings.entity_id, entityIds),
        eq(datasetMappings.confirmed, true),
        or(isNull(datasetMappings.tenant_id), eq(datasetMappings.tenant_id, tenantId)),
      ),
    );
  if (rows.length === 0) return null;
  const best = [...rows].sort(
    (a, b) =>
      Number(b.tenant_id !== null) - Number(a.tenant_id !== null) ||
      b.updated_at.getTime() - a.updated_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return best[0]!.id;
}

/**
 * Bind a tenant dataset to an entity as test data (idempotent on (entity, dataset, tenant)).
 * Validates the entity is visible, the dataset is the tenant's, and any mapping exists. When
 * `isPrimary`, demotes the entity's other samples first (one primary per entity per tenant).
 *
 * ⛔ `mapping_id` STORES AN EXPLICIT OVERRIDE AND NOTHING ELSE. It is NOT resolved here. An earlier
 * cut of this fix called `resolveDefaultMappingId` at this point and stored the answer; that is
 * now done by the READER (datasets/ontology-validation.ts) on every run. Two reasons, and the
 * first is the one that matters:
 *
 *   1. A stored answer is only correct for a curator who confirms the mapping BEFORE binding, and
 *      the UI invites the opposite order. See the long note on `resolveDefaultMappingId`.
 *   2. One resolution point cannot disagree with itself. Two CAN, on shipped write paths only:
 *      bind against the global entity `E` resolves and stores the global mapping `M_G`; the tenant
 *      later creates its own override of `E` and confirms a mapping `M_T` on it. `M_T` is newer, so
 *      the resolver now prefers it — but the stored `M_G` is honoured as an explicit override and
 *      pins the old projection with nothing to heal it. Storing a RESOLVED value also makes the
 *      column ambiguous: the reader cannot tell "the caller chose this" from "the resolver guessed
 *      this once", and it must, because it treats the two differently.
 *
 * So: caller named a mapping ⇒ stored verbatim and honoured forever. Caller named none ⇒ NULL,
 * which now means "resolve me", not "nothing to validate".
 *
 * ⚠️ A falsy `mappingId` reads as "not supplied", not as "clear it": routes/ontology.ts collapses
 * an omitted field to `null` before this function sees it, so the two are already indistinguishable
 * on the wire and no shipped caller means "unset".
 */
export async function bindEntitySample(
  tenantId: string,
  entityId: string,
  input: BindSampleInput,
  database: Db = defaultDb,
): Promise<EntitySampleView> {
  const ids = await siblingEntityIds(tenantId, entityId, database);

  const [ds] = await database
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.id, input.datasetId), eq(datasets.tenant_id, tenantId)));
  if (!ds) throw notFound('dataset_not_found', 'No dataset with that id in this tenant');

  if (input.mappingId) {
    // An explicit id must satisfy EVERY rule the resolver applies to a default, because the reader
    // honours a stored id as an override and skips resolution entirely — so anything accepted here
    // is what a run is gated on:
    //   • same DATASET — an arbitrary client-supplied mappingId (column-name strings only, no raw
    //     data, but still a trust boundary) must not attach to an unrelated dataset;
    //   • same ENTITY FAMILY — a mapping authored for a different entity projects this dataset's
    //     columns onto attribute names that belong to something else. Mismatched names are dropped
    //     by the validator rather than misvalidated, so the old check merely made the binding inert
    //     in a way nothing reported;
    //   • CONFIRMED — this is the rule with teeth. `resolveDefaultMappingId` refuses to default to
    //     an unreviewed proposal precisely so a machine guess cannot 422 a run under
    //     `data.validation_mode: block`. Without this clause the explicit path was the hole in
    //     that rule: POST the id of an `auto`/unconfirmed mapping and it becomes the gate.
    // Scope mirrors the resolver: the tenant's own row or the global one, never another tenant's.
    const [mp] = await database
      .select({ id: datasetMappings.id })
      .from(datasetMappings)
      .where(
        and(
          eq(datasetMappings.id, input.mappingId),
          eq(datasetMappings.dataset_id, input.datasetId),
          inArray(datasetMappings.entity_id, ids),
          eq(datasetMappings.confirmed, true),
          or(isNull(datasetMappings.tenant_id), eq(datasetMappings.tenant_id, tenantId)),
        ),
      );
    if (!mp) {
      throw badRequest(
        'mapping_dataset_mismatch',
        'That mapping does not belong to the dataset and entity being bound, or is not confirmed',
      );
    }
  }

  // ⛔ NOT RESOLVED HERE. NULL means "the reader resolves it" — see the note above this function.
  const mappingId = input.mappingId ?? null;

  if (input.isPrimary) {
    // Demote any existing primary across the entity's natural-key siblings (logical "one primary").
    await database
      .update(ontologyEntitySamples)
      .set({ is_primary: false, updated_at: new Date() })
      .where(
        and(
          inArray(ontologyEntitySamples.entity_id, ids),
          eq(ontologyEntitySamples.tenant_id, tenantId),
          eq(ontologyEntitySamples.is_primary, true),
        ),
      );
  }

  await database
    .insert(ontologyEntitySamples)
    .values({
      entity_id: entityId,
      dataset_id: input.datasetId,
      mapping_id: mappingId,
      is_primary: input.isPrimary ?? false,
      tenant_id: tenantId,
    })
    .onConflictDoUpdate({
      target: [
        ontologyEntitySamples.entity_id,
        ontologyEntitySamples.dataset_id,
        ontologyEntitySamples.tenant_id,
      ],
      set: {
        mapping_id: mappingId,
        is_primary: input.isPrimary ?? false,
        updated_at: new Date(),
      },
    });

  const samples = await listEntitySamples(tenantId, entityId, database);
  const created = samples.find((s) => s.datasetId === input.datasetId);
  if (!created) throw notFound('sample_not_found', 'Sample not found after bind');
  return created;
}

/** Remove a test-data binding by its id (tenant-scoped). */
export async function unbindEntitySample(
  tenantId: string,
  sampleId: string,
  database: Db = defaultDb,
): Promise<void> {
  const [row] = await database
    .select({ id: ontologyEntitySamples.id })
    .from(ontologyEntitySamples)
    .where(
      and(eq(ontologyEntitySamples.id, sampleId), eq(ontologyEntitySamples.tenant_id, tenantId)),
    );
  if (!row) throw notFound('sample_not_found', 'No test-data binding with that id');
  await database
    .delete(ontologyEntitySamples)
    .where(
      and(eq(ontologyEntitySamples.id, sampleId), eq(ontologyEntitySamples.tenant_id, tenantId)),
    );
}
