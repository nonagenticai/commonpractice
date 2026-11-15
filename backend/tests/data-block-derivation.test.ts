// tests/data-block-derivation.test.ts — Phase 3: derive a tenant data block from an ontology entity
// (+ its primary sample) over real Postgres :5433. Proves:
//   (a) derive → a tenant-owned category='data' block with per-attribute scalar ports + rows/count,
//       provenance (source_entity_key), and an auto-published `beta` version (current_version_id set);
//   (b) the source references the dataset by slug and bakes the mapping's column_map projection;
//   (c) re-derive is idempotent — a NEW version on the SAME block (no duplicate), current repointed;
//   (d) an entity with no primary sample → 422 no_primary_sample;
//   (e) cross-tenant isolation — another tenant cannot derive from this entity (404);
//   (f) derivation resolves NOTHING — a binding that names no mapping compiles a PASSTHROUGH block
//       even when a confirmed mapping for that exact pair exists. See (f)'s test for why.
// Route-level via the owner connection (RLS bypassed in dev/test); RLS isolation is proven in
// rls-isolation.test.ts. Auth via the __setAuthOverridesForTests seam (house rule).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { createTenantEntity } from '../src/ontology/ontology-service';
import { upsertMapping } from '../src/datasets/mapping-service';
import { bindEntitySample } from '../src/ontology/sample-service';
import {
  db,
  users,
  tenants,
  datasets,
  ontologyEntities,
  ontologyEntitySamples,
  datasetMappings,
  buildingBlocks,
  blockVersions,
} from '../src/db/client';
import type { User } from '../src/types';

const ORG = '00000000-0000-0000-0000-00000d000001';
const OTHER = '00000000-0000-0000-0000-00000d000002';
const DEV_ID = '00000000-0000-0000-0000-00000d00de01';
const OUT_ID = '00000000-0000-0000-0000-00000d00cf01';
const DS_A = '0a000000-0000-4000-8000-00000dda0001';

const developer: User = { id: DEV_ID, email: 'der-dev@test', name: 'Dev', roles: ['developer'], tenantId: ORG };
const outsider: User = { id: OUT_ID, email: 'der-out@test', name: 'Otto', roles: ['developer'], tenantId: OTHER };

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerOntologyRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let mappedEntityId: string; // has a primary sample + a mapping
let bareEntityId: string; // attributes but no sample
let unresolvedEntityId: string; // a confirmed mapping EXISTS, but the binding does not name it

async function cleanup() {
  // Blocks first (FK from versions), by tenant + by the derived slugs.
  const derivedSlugs = [
    'data-industry-dept-insurance-claims-derivemappedclaim',
    'data-industry-dept-insurance-claims-derivebareclaim',
    'data-industry-dept-insurance-claims-deriveunresolvedclaim',
  ];
  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, DS_A));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.tenant_id, [ORG, OTHER]));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, derivedSlugs));
  await db.delete(ontologyEntitySamples).where(inArray(ontologyEntitySamples.tenant_id, [ORG, OTHER]));
  await db.delete(datasets).where(inArray(datasets.tenant_id, [ORG, OTHER]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [DEV_ID, OUT_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Ins', slug: 'acme-der', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'other-der', industry: 'insurance' },
  ]);
  await db.insert(users).values([
    { id: DEV_ID, email: developer.email, name: developer.name, tenant_id: ORG },
    { id: OUT_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
  await db.insert(datasets).values([
    { id: DS_A, owner_id: DEV_ID, tenant_id: ORG, name: 'Derive Claims', slug: 'derive-claims', source_type: 'json', row_count: 5 },
  ]);

  const mapped = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'DeriveMappedClaim',
    label: 'Derive Mapped Claim',
    attributes: [
      { name: 'claimId', type: 'string', description: 'ref' },
      { name: 'amount', type: 'number' },
      { name: 'ssn', type: 'string', pii: true },
    ],
  });
  mappedEntityId = mapped.id;

  const bare = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'DeriveBareClaim',
    label: 'Derive Bare Claim',
    attributes: [{ name: 'claimId', type: 'string' }],
  });
  bareEntityId = bare.id;

  // A confirmed mapping projects dataset columns → attribute names.
  const mapping = await upsertMapping({
    datasetId: DS_A,
    entityId: mappedEntityId,
    industry: 'insurance',
    department: 'Claims',
    columnMap: { clm_id: 'claimId', clm_amt: 'amount' },
    confidence: 1,
    source: 'human',
    confirmed: true,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });

  // Bind the dataset as the entity's PRIMARY sample, carrying the mapping EXPLICITLY. Hand-inserted
  // rather than routed because an explicit `mapping_id` is exactly what is under test here.
  await db.insert(ontologyEntitySamples).values({
    entity_id: mappedEntityId,
    dataset_id: DS_A,
    mapping_id: mapping.id,
    is_primary: true,
    tenant_id: ORG,
  });

  // …and the mirror image: an entity with a confirmed mapping for the SAME dataset, bound the way
  // the UI binds — `{datasetId, isPrimary}`, no mapping named. Test (f) pins that this compiles a
  // passthrough block and not a projection.
  const unresolved = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'DeriveUnresolvedClaim',
    label: 'Derive Unresolved Claim',
    attributes: [
      { name: 'claimId', type: 'string' },
      { name: 'amount', type: 'number' },
    ],
  });
  unresolvedEntityId = unresolved.id;
  await upsertMapping({
    datasetId: DS_A,
    entityId: unresolvedEntityId,
    industry: 'insurance',
    department: 'Claims',
    columnMap: { clm_id: 'claimId', clm_amt: 'amount' },
    confidence: 1,
    source: 'human',
    confirmed: true,
    // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
    // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
    tenantId: null,
  });
  await bindEntitySample(ORG, unresolvedEntityId, { datasetId: DS_A, isPrimary: true });
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('derive → tenant data block with per-attribute ports + rows/count + provenance + published beta', async () => {
  asUser(developer);
  const res = await call('POST', `/api/ontology/entities/${mappedEntityId}/derive-block`);
  expect(res.status).toBe(201);
  expect(res.json.created).toBe(true);

  const block = res.json.block;
  expect(block.category).toBe('data');
  expect(block.tenant_id).toBe(ORG);
  expect(block.slug).toBe('data-industry-dept-insurance-claims-derivemappedclaim');
  expect(block.source_entity_key).toBe('industry_dept:insurance:Claims:DeriveMappedClaim');
  expect(block.current_version_id).toBe(res.json.version.id);

  const v = res.json.version;
  expect(v.status).toBe('beta');
  expect(v.published_at).not.toBeNull();
  const out = v.descriptor.outputs;
  expect(out.claimId.type).toBe('string');
  expect(out.amount.type).toBe('number');
  expect(out.ssn).toEqual({ type: 'string', pii: true });
  expect(out.rows.type).toBe('json');
  expect(out.count.type).toBe('number');
  // Defaulted dataset input → host injects the bound sample.
  expect(v.descriptor.inputs.source.type).toBe('dataset');
  expect(v.descriptor.inputs.source.default).toBe('derive-claims');
  // Source references by slug + bakes the mapping projection (no rows inlined).
  expect(v.source_ts).toContain('ctx.dataset(slug)');
  expect(v.source_ts).toContain('"clm_id":"claimId"');
  expect(v.source_ts).toContain('"derive-claims"');
}, 30_000);

test('re-derive is idempotent — a new version on the same block, current repointed', async () => {
  asUser(developer);
  const res = await call('POST', `/api/ontology/entities/${mappedEntityId}/derive-block`);
  expect(res.status).toBe(200);
  expect(res.json.created).toBe(false);

  const blocks = await db
    .select()
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, res.json.block.slug), eq(buildingBlocks.tenant_id, ORG)));
  expect(blocks).toHaveLength(1); // no duplicate block

  const versions = await db
    .select()
    .from(blockVersions)
    .where(eq(blockVersions.block_id, blocks[0]!.id));
  expect(versions.length).toBe(2); // original + re-derived
  expect(blocks[0]!.current_version_id).toBe(res.json.version.id);
  expect(res.json.version.version).toBe('0.1.1'); // patch-bumped from 0.1.0
}, 30_000);

test('an entity with no primary sample → 422 no_primary_sample', async () => {
  asUser(developer);
  const res = await call('POST', `/api/ontology/entities/${bareEntityId}/derive-block`);
  expect(res.status).toBe(422);
  expect(res.json.error).toBe('no_primary_sample');
}, 30_000);

test('another tenant cannot derive from this entity (404)', async () => {
  asUser(outsider);
  const res = await call('POST', `/api/ontology/entities/${mappedEntityId}/derive-block`);
  expect(res.status).toBe(404);
  expect(res.json.error).toBe('entity_not_found');
}, 30_000);

test('(f) a binding that names NO mapping compiles a PASSTHROUGH block, even though one exists', async () => {
  // ⛔ THE BLAST RADIUS THIS BOUNDS. `COLMAP` is not cosmetic: `renderSource`'s `project()`
  // short-circuits on `{}` and hands every row through VERBATIM, while a non-empty map builds a new
  // object holding ONLY the mapped columns, RENAMED to attribute names — every unmapped column is
  // DROPPED from `rows`. So "does this binding carry a mapping" decides the emitted shape of a
  // PUBLISHED, IMMUTABLE block version.
  //
  // Which is why derivation resolves nothing, unlike the run-time validator (which resolves the
  // confirmed mapping on every run precisely because its answer is recomputed and therefore
  // self-correcting). This entity HAS a confirmed mapping for this exact dataset — the validator
  // would find and use it — and derivation still emits passthrough, because the binding does not
  // name it. A curator gets a projection by choosing one, never by one existing somewhere.
  asUser(developer);
  const res = await call('POST', `/api/ontology/entities/${unresolvedEntityId}/derive-block`);
  expect(res.status).toBe(201);
  const src = res.json.version.source_ts as string;
  expect(
    src,
    'derivation resolved a mapping the binding never named — a mapping edit on the Datasets ' +
      'screen now silently changes the shape a published block version emits',
  ).toContain('const COLMAP = {};');

  // …and the confirmed mapping really is there and really does project, so this is a choice and
  // not an accident of fixture setup.
  const [confirmed] = await db
    .select({ id: datasetMappings.id, columnMap: datasetMappings.column_map })
    .from(datasetMappings)
    .where(
      and(
        eq(datasetMappings.dataset_id, DS_A),
        eq(datasetMappings.entity_id, unresolvedEntityId),
        eq(datasetMappings.confirmed, true),
      ),
    );
  expect(confirmed!.columnMap).toEqual({ clm_id: 'claimId', clm_amt: 'amount' });

  // Name it, re-derive, and the SAME entity now emits the projection. Passthrough vs projection is
  // one explicit act apart.
  await bindEntitySample(ORG, unresolvedEntityId, {
    datasetId: DS_A,
    mappingId: confirmed!.id,
    isPrimary: true,
  });
  const projected = await call('POST', `/api/ontology/entities/${unresolvedEntityId}/derive-block`);
  expect(projected.status).toBe(200); // 200 = a new VERSION on the block test (f) just created
  expect(projected.json.created).toBe(false);
  expect(projected.json.version.source_ts as string).toContain(
    'const COLMAP = {"clm_id":"claimId","clm_amt":"amount"};',
  );
});
