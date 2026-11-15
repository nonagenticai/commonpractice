// tests/ontology-samples.test.ts — ontology-data-blocks Phase 1: bind tenant datasets as
// the test data for an ontology entity. Proves over real Postgres :5433:
//   (a) a DEVELOPER (the new authoring role, not an admin) can bind/list/unbind samples;
//   (b) a plain member is rejected (403);
//   (c) cross-tenant isolation — another tenant can't see/bind this entity's samples (404);
//   (d) one PRIMARY per entity (binding a new primary demotes the previous);
//   (e) binding a dataset from another tenant is rejected.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { createTenantEntity } from '../src/ontology/ontology-service';
import {
  db,
  users,
  tenants,
  datasets,
  ontologyEntities,
  ontologyEntitySamples,
  datasetMappings,
} from '../src/db/client';
import type { User } from '../src/types';

const ORG = '00000000-0000-0000-0000-00000c000001';
const OTHER = '00000000-0000-0000-0000-00000c000002';
const DEV_ID = '00000000-0000-0000-0000-00000c00de01'; // developer of ORG
const MEMBER_ID = '00000000-0000-0000-0000-00000c00be01'; // plain member of ORG
const OUT_ID = '00000000-0000-0000-0000-00000c00cf01'; // developer of OTHER
// Valid v4 UUIDs (the bind route validates datasetId with a strict uuid check, matching the
// gen_random_uuid v4 ids real datasets get).
const DS_A = '0a000000-0000-4000-8000-00000cda0001'; // dataset in ORG
const DS_B = '0b000000-0000-4000-8000-00000cda0002'; // dataset in ORG
const DS_OTHER = '0c000000-0000-4000-8000-00000cda0003'; // dataset in OTHER

const developer: User = { id: DEV_ID, email: 'smp-dev@test', name: 'Dev Eloper', roles: ['developer'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'smp-mem@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUT_ID, email: 'smp-out@test', name: 'Otto Outsider', roles: ['developer'], tenantId: OTHER };

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

let entityId: string;

async function cleanup() {
  await db.delete(ontologyEntitySamples).where(inArray(ontologyEntitySamples.tenant_id, [ORG, OTHER]));
  await db.delete(datasetMappings).where(inArray(datasetMappings.tenant_id, [ORG, OTHER]));
  // By tenant (text), not id — sweeps any rows a prior run left behind under these tenants.
  await db.delete(datasets).where(inArray(datasets.tenant_id, [ORG, OTHER]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [DEV_ID, MEMBER_ID, OUT_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Ins', slug: 'acme-smp', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'other-smp', industry: 'insurance' },
  ]);
  await db.insert(users).values([
    { id: DEV_ID, email: developer.email, name: developer.name, tenant_id: ORG },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: OUT_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
  await db.insert(datasets).values([
    { id: DS_A, owner_id: DEV_ID, tenant_id: ORG, name: 'Claims A', slug: 'claims-a', source_type: 'json', row_count: 5 },
    { id: DS_B, owner_id: DEV_ID, tenant_id: ORG, name: 'Claims B', slug: 'claims-b', source_type: 'json', row_count: 3 },
    { id: DS_OTHER, owner_id: OUT_ID, tenant_id: OTHER, name: 'Foreign', slug: 'foreign', source_type: 'json', row_count: 9 },
  ]);
  const e = await createTenantEntity(ORG, {
    scope: 'industry_dept',
    industry: 'insurance',
    department: 'Claims',
    name: 'SampleTestClaim',
    label: 'Sample Test Claim',
  });
  entityId = e.id;
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('developer binds a dataset as primary test data; GET lists it', async () => {
  asUser(developer);
  const put = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
    datasetId: DS_A,
    isPrimary: true,
  });
  expect(put.status).toBe(200);
  expect(put.json.sample.datasetSlug).toBe('claims-a');
  expect(put.json.sample.isPrimary).toBe(true);

  const list = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  expect(list.status).toBe(200);
  expect(list.json.samples).toHaveLength(1);
  expect(list.json.samples[0].rowCount).toBe(5);
});

test('a plain member cannot bind (403)', async () => {
  asUser(member);
  const r = await call('PUT', `/api/ontology/entities/${entityId}/samples`, { datasetId: DS_B });
  expect(r.status).toBe(403);
});

test('binding a new primary demotes the previous (one primary per entity)', async () => {
  asUser(developer);
  await call('PUT', `/api/ontology/entities/${entityId}/samples`, { datasetId: DS_B, isPrimary: true });
  const list = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  expect(list.json.samples).toHaveLength(2);
  const primaries = list.json.samples.filter((s: { isPrimary: boolean }) => s.isPrimary);
  expect(primaries).toHaveLength(1);
  expect(primaries[0].datasetSlug).toBe('claims-b');
});

test('a dataset from another tenant is rejected (404)', async () => {
  asUser(developer);
  const r = await call('PUT', `/api/ontology/entities/${entityId}/samples`, { datasetId: DS_OTHER });
  expect(r.status).toBe(404);
});

test('another tenant cannot see or bind this entity (404)', async () => {
  asUser(outsider);
  const list = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  expect(list.status).toBe(404);
});

test('unbind removes the binding', async () => {
  asUser(developer);
  const list = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  const target = list.json.samples.find((s: { datasetSlug: string }) => s.datasetSlug === 'claims-a');
  const del = await call('DELETE', `/api/ontology/samples/${target.id}`);
  expect(del.status).toBe(200);
  const after = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  expect(after.json.samples).toHaveLength(1);
  expect(after.json.samples[0].datasetSlug).toBe('claims-b');
});

// ---- PII-gaps hunt, FIX 4 — bindEntitySample never checked that a client-supplied
// mappingId actually belongs to the datasetId being bound. An arbitrary mapping (e.g.
// one confirmed for a DIFFERENT dataset entirely) could attach to an unrelated
// dataset/entity pair, silently corrupting the derived data block's column projection
// for this entity (mapping rows hold only column-name strings — no raw data leak, but
// still a trust-boundary bug worth closing).
const MAPPING_FOR_B = '0d000000-0000-4000-8000-00000cda1001'; // dataset_mappings row bound to DS_B

test('a mappingId belonging to a DIFFERENT dataset is rejected, not silently attached', async () => {
  asUser(developer);
  await db
    .insert(datasetMappings)
    .values({
      id: MAPPING_FOR_B,
      dataset_id: DS_B,
      entity_id: entityId,
      industry: 'insurance',
      department: 'Claims',
      column_map: { claim_amount: 'amount' },
      confirmed: true,
      tenant_id: ORG,
    })
    .onConflictDoNothing();

  // ⛔ THE ACTUAL FIX: bind DS_A (a different dataset) while supplying DS_B's mapping.
  const r = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
    datasetId: DS_A,
    mappingId: MAPPING_FOR_B,
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('mapping_dataset_mismatch');

  // And the binding must not have been created (or updated) with the mismatched mapping.
  const list = await call('GET', `/api/ontology/entities/${entityId}/samples`);
  const a = list.json.samples.find((s: { datasetSlug: string }) => s.datasetSlug === 'claims-a');
  expect(a?.mappingId ?? null).not.toBe(MAPPING_FOR_B);
});

test('a mappingId belonging to the SAME dataset is accepted', async () => {
  asUser(developer);
  const r = await call('PUT', `/api/ontology/entities/${entityId}/samples`, {
    datasetId: DS_B,
    mappingId: MAPPING_FOR_B,
  });
  expect(r.status).toBe(200);
  expect(r.json.sample.mappingId).toBe(MAPPING_FOR_B);
});
