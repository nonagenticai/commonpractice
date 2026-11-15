// src/ontology/data-block-derivation.ts — Phase 3: DB-aware orchestration that derives a tenant
// data block from an ontology entity (+ its bound primary sample). Pairs with the pure
// data-block-compiler.ts (which holds zero I/O).
//
// Flow: resolve the entity + its merged attributes (natural-key siblings, mirroring sample-service)
// → resolve the PRIMARY sample (dataset slug + optional mapping) → compile → FIND-OR-VERSION the
// tenant block (idempotent on the deterministic slug; never mutate a published version) → lint +
// auto-publish to `beta` so it is immediately runnable and surfaced in the palette.
//
// Runs under the REQUEST's RLS-scoped connection (the route resolved + bound the tenant GUC): the
// building_blocks / block_versions writes are own-tenant only (0037 §4c), so a foreign-tenant block
// is structurally impossible. The entity / attribute reads use explicit tenant filters (the contract;
// RLS-free ontology tables) exactly like sample-service.
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  db as defaultDb,
  buildingBlocks,
  blockVersions,
  ontologyEntities,
  users,
} from '../db/client';
import type { BuildingBlock, BlockVersion } from '../db/schema';
import { entityKey } from './ontology-service';
import { loadEntityAttributes, resolvePrimarySample } from './sample-service';
import { getMappingColumnMap } from '../datasets/mapping-service';
import { compileDataBlock } from './data-block-compiler';
import { lintBlock } from '../blocks/lint';
import { requireScannedSource } from '../blocks/source-gate';
import { conflict, notFound, unprocessable } from '../utils/http';

type Db = typeof defaultDb;

export interface DeriveResult {
  block: BuildingBlock;
  version: BlockVersion;
  /** True when this derivation created the block; false when it added a new version to an existing one. */
  created: boolean;
}

/** Bump the patch component of a 2- or 3-part semver ("0.1.0" → "0.1.1"). Mirrors routes/blocks.ts. */
function bumpVersion(latest: string): string {
  const nums = latest.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  nums[2] = (nums[2] ?? 0) + 1;
  return nums.join('.');
}

/**
 * Derive (or re-derive) the tenant data block for an ontology entity. Idempotent: re-deriving adds a
 * new immutable version to the existing block rather than creating a duplicate. 422 if the entity has
 * no primary sample bound; 409 if its deterministic slug collides with a platform block.
 */
export async function deriveDataBlock(
  tenantId: string,
  entityId: string,
  actorUserId: string,
  database: Db = defaultDb,
): Promise<DeriveResult> {
  // 1. Resolve the entity (anchor → natural key) and its merged attributes.
  const [anchor] = await database
    .select()
    .from(ontologyEntities)
    .where(eq(ontologyEntities.id, entityId));
  if (!anchor || (anchor.tenant_id !== null && anchor.tenant_id !== tenantId)) {
    throw notFound('entity_not_found', 'No ontology entity with that id');
  }
  const key = entityKey(anchor);
  const attributes = await loadEntityAttributes(tenantId, entityId, database);

  // 2. The PRIMARY sample supplies the block's data source.
  const sample = await resolvePrimarySample(tenantId, entityId, database);
  if (!sample) {
    throw unprocessable(
      'no_primary_sample',
      'Bind a primary test-data sample to this entity before deriving a data block',
    );
  }

  // 3. The sample's EXPLICIT mapping (if the binding names one) projects dataset columns →
  //    attribute names.
  //
  // ⛔ DELIBERATELY DOES *NOT* RESOLVE, unlike datasets/ontology-validation.ts, which resolves the
  //    confirmed mapping on every run even when the binding stores none. The asymmetry is about
  //    LIFETIME, and it is the whole reason it is safe to resolve over there:
  //
  //      • a validation finding is RECOMPUTED every run, so resolving fresh is self-correcting —
  //        a mapping that is added, edited or deleted shows up in the next run's answer;
  //      • a derived block version is IMMUTABLE. `columnMap` is frozen into the generated
  //        `source_ts` below and published. Resolving it here would mean the shape a published
  //        artifact emits is decided by whatever the mapping happened to be at derive time, changed
  //        silently by an edit made on a different screen at an unrelated moment, with existing
  //        versions left disagreeing with new ones for reasons invisible from this page.
  //
  // ⚠️ AND THE SHAPE CHANGE IS NOT SUBTLE, which is why it needs a deliberate act. `{}` makes
  //    `renderSource`'s `project()` short-circuit and pass every row through VERBATIM. A non-empty
  //    map makes it build a new object holding ONLY the mapped columns, RENAMED to attribute names
  //    — so every unmapped column is DROPPED from `rows`. (The per-attribute scalar outputs are the
  //    mirror image: they read `first[attributeName]`, so they are null under passthrough unless the
  //    raw column names already equal the attribute names.) Passthrough vs projection is a
  //    different block, and a curator gets it by naming a mapping on the binding, not by having one
  //    exist somewhere. Pinned both ways in tests/data-block-derivation.test.ts.
  const columnMap = sample.mappingId
    ? await getMappingColumnMap(sample.mappingId, database)
    : {};

  // 4. Compile.
  const compiled = compileDataBlock({
    entity: { key, name: anchor.name, label: anchor.label, description: anchor.description, attributes },
    datasetSlug: sample.datasetSlug,
    columnMap,
  });

  // 5. Find-or-version. A platform (global) block reserves the slug (v1 rule, mirrors createBlock).
  const [globalDup] = await database
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, compiled.slug), isNull(buildingBlocks.tenant_id)));
  if (globalDup) {
    // `slug` on details, matching blocks/authoring-service.ts's throw of the SAME code. A catalog
    // entry keyed on `slug` renders an empty name at any site that omits it, and this was the site
    // that omitted it — one code must have one shape at every throw.
    throw conflict('slug_reserved_global', `'${compiled.slug}' is a platform block slug`, {
      slug: compiled.slug,
    });
  }

  const [existing] = await database
    .select()
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, compiled.slug), eq(buildingBlocks.tenant_id, tenantId)));

  const [maintainer] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, actorUserId));
  const maintainerId = maintainer?.id ?? null;

  // 6. Lint the generated source before publishing (defensive — generated code should always pass).
  const lint = lintBlock(compiled.source_ts);
  if (!lint.ok) {
    // The sentence joins the findings' ENGLISH prose, which no catalog can re-localize. `findings`
    // puts them on the wire STRUCTURED, in the same `LintFinding[]` shape `lint_failed` already
    // carries from source-gate.ts / publishVersionCore — so `scan-finding-label.ts` renders them
    // localized with no new client code. The English message is untouched: it stays the fallback an
    // old bundle (and a rolling deploy) reads.
    throw unprocessable(
      'derived_lint_failed',
      `Generated data block failed lint: ${lint.findings.map((f) => f.message).join('; ')}`,
      { findings: lint.findings },
    );
  }
  // Mints the branded value the two INSERTs below need. Unconditional (not policy-aware): this is
  // GENERATED code, so a finding here is a compiler bug and an operator's governance switch is not
  // a licence to write one. Cannot throw in practice — `lintBlock` above is a strict superset.
  const scannedSource = requireScannedSource(compiled.source_ts);

  let block: BuildingBlock;
  let version: BlockVersion;
  let created: boolean;

  if (!existing) {
    const result = await database.transaction(async (tx) => {
      const [b] = await tx
        .insert(buildingBlocks)
        .values({
          slug: compiled.slug,
          name: compiled.name,
          description: compiled.description,
          category: 'data',
          tenant_id: tenantId,
          source_entity_key: key,
          maintainer_id: maintainerId,
          region: 'eu-west',
          cost_class: 'low',
        })
        .returning();
      const [v] = await tx
        .insert(blockVersions)
        .values({
          block_id: b!.id,
          version: '0.1.0',
          status: 'beta',
          docs_md: `# ${compiled.name}\n\nDerived from the **${anchor.label}** ontology entity and its primary test-data sample.`,
          source_ts: scannedSource,
          descriptor: compiled.descriptor,
          published_by: maintainerId,
          published_at: new Date(),
        })
        .returning();
      await tx
        .update(buildingBlocks)
        .set({ current_version_id: v!.id })
        .where(eq(buildingBlocks.id, b!.id));
      return { block: { ...b!, current_version_id: v!.id }, version: v! };
    });
    block = result.block;
    version = result.version;
    created = true;
  } else {
    const versions = await database
      .select({ version: blockVersions.version })
      .from(blockVersions)
      .where(eq(blockVersions.block_id, existing.id))
      .orderBy(desc(blockVersions.created_at));
    const next = bumpVersion(versions[0]?.version ?? '0.0.0');

    const result = await database.transaction(async (tx) => {
      const [v] = await tx
        .insert(blockVersions)
        .values({
          block_id: existing.id,
          version: next,
          status: 'beta',
          docs_md: `# ${compiled.name}\n\nRe-derived from the **${anchor.label}** ontology entity and its primary test-data sample.`,
          source_ts: scannedSource,
          descriptor: compiled.descriptor,
          changelog: 'Re-derived from the ontology entity.',
          published_by: maintainerId,
          published_at: new Date(),
        })
        .returning();
      // Keep provenance current (older derived blocks may predate source_entity_key) + repoint current.
      const [b] = await tx
        .update(buildingBlocks)
        .set({
          current_version_id: v!.id,
          source_entity_key: key,
          description: compiled.description,
          updated_at: new Date(),
        })
        .where(eq(buildingBlocks.id, existing.id))
        .returning();
      return { block: b!, version: v! };
    });
    block = result.block;
    version = result.version;
    created = false;
  }

  return { block, version, created };
}
