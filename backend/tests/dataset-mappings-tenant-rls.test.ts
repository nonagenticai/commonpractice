// tests/dataset-mappings-tenant-rls.test.ts — the dataset → ontology mapping writers, run AS the
// runtime role.
//
// ⛔ WHY THIS FILE EXISTS AND WHY dataset-mappings.test.ts COULD NOT HAVE CAUGHT ANY OF IT.
// The default test connection is the TABLE OWNER, which BYPASSES RLS. `dataset_mappings` is a
// 0028 §4c "nullable global-override" table: SELECT sees `tenant_id IS NULL OR = mine`, but
// INSERT/UPDATE/DELETE are all `tenant_id = app_current_tenant_uuid()`. Every writer in
// mapping-service.ts filtered on `isNull(tenant_id)` and never SET the column, so as the owner
// all three worked perfectly and as `cp_app` (what production runs as — NOBYPASSRLS) all three
// were dead:
//   • INSERT  → WITH CHECK `NULL = mine` → NULL → 42501 → not HttpError/ZodError → utils/http.ts
//               rethrows → 500 Internal Server Error when a tenant admin saves a mapping.
//   • UPDATE  → USING `NULL = mine` → 0 rows, `.returning()` discarded → 200 "Saved N mapping(s)"
//               carrying the OLD values.
//   • DELETE  → 0 rows → 404 for a mapping the GET is still listing.
//   • prune   → 0 rows → the entity a save re-pointed AWAY from survives, and the runner injects
//               both the old and the new mapping (the exact failure pruneCellMappings exists for).
// Every case below therefore runs inside `withTenantDbAsRuntimeRoleForTests`, which SET ROLEs the
// request connection to cp_app — the same guarantee tests/rls-child-write.test.ts documents.
//
// Each case owns its OWN dataset so the four are independent under `--randomize`.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { seedOntology } from '../src/db/seed-ontology';
import {
  db,
  withTenantDbAsRuntimeRoleForTests,
  users,
  tenants,
  datasets,
  datasetMappings,
  ontologyEntities,
} from '../src/db/client';
import type { User } from '../src/types';

const TENANT = '00000000-0000-0000-0000-00000da70001';
const USER_ID = '00000000-0000-0000-0000-00000da7a001';
const admin: User = {
  id: USER_ID,
  email: 'maprls@test',
  name: 'Map RLS Admin',
  roles: ['tenant_admin'],
  tenantId: TENANT,
};

const router = new Router();
registerDatasetRoutes(router);

/** Drive a route AS cp_app with `app.current_tenant` = TENANT — i.e. exactly as production runs. */
async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDbAsRuntimeRoleForTests(TENANT, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const COLUMNS = [
  { name: 'clm_amt', type: 'number' as const },
  { name: 'clm_status', type: 'string' as const },
  { name: 'pol_no', type: 'string' as const },
];

const SLUGS = ['maprls-insert', 'maprls-update', 'maprls-delete', 'maprls-prune', 'maprls-global', 'maprls-collapse'];
const dsId: Record<string, string> = {};
let CLAIM = '';
let POLICY = '';

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, USER_ID));
  for (const d of owned) await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, USER_ID));
  await db.update(users).set({ tenant_id: null }).where(eq(users.id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await seedOntology(); // idempotent — guarantees the insurance × Claims cell exists.
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'Map RLS Org', slug: `maprls-${TENANT.slice(-6)}` }).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values({ id: USER_ID, email: admin.email, name: admin.name, tenant_id: TENANT }).onConflictDoNothing();

  const ents = await db
    .select({ id: ontologyEntities.id, name: ontologyEntities.name, scope: ontologyEntities.scope })
    .from(ontologyEntities)
    .where(and(eq(ontologyEntities.industry, 'insurance'), isNull(ontologyEntities.tenant_id)));
  CLAIM = ents.find((e) => e.name === 'Claim' && e.scope === 'industry_dept')!.id;
  POLICY = ents.find((e) => e.name === 'Policy')!.id;
  expect(CLAIM).toBeTruthy();
  expect(POLICY).toBeTruthy();

  for (const slug of SLUGS) {
    const [d] = await db
      .insert(datasets)
      .values({
        owner_id: USER_ID,
        tenant_id: TENANT,
        name: slug,
        slug,
        source_type: 'json',
        columns: COLUMNS,
        row_count: 0,
      })
      .returning({ id: datasets.id });
    dsId[slug] = d!.id;
  }

  // The GLOBAL (tenant_id NULL) seed rows that seed-example-blocks.ts writes for every example
  // dataset — the state a real tenant's dataset is in before anyone touches its mappings.
  await db.insert(datasetMappings).values([
    { dataset_id: dsId['maprls-update']!, entity_id: CLAIM, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'amount' }, confidence: 1, source: 'human', confirmed: true, tenant_id: null },
    { dataset_id: dsId['maprls-delete']!, entity_id: CLAIM, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'amount' }, confidence: 1, source: 'human', confirmed: true, tenant_id: null },
    { dataset_id: dsId['maprls-prune']!, entity_id: CLAIM, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'amount' }, confidence: 1, source: 'human', confirmed: true, tenant_id: null },
    // Both halves of the tenant-over-global collapse live on this one (dataset, entity) pair.
    { dataset_id: dsId['maprls-collapse']!, entity_id: CLAIM, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'GLOBAL-LOSES' }, confidence: 1, source: 'human', confirmed: true, tenant_id: null },
    // Never written to by any case — the read-side guard that the fix does not orphan the seeds.
    { dataset_id: dsId['maprls-global']!, entity_id: CLAIM, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'amount' }, confidence: 1, source: 'human', confirmed: true, tenant_id: null },
  ]);

  __setAuthOverridesForTests({ validateAuth: async () => admin });
}, 60_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 60_000);

test('INSERT — a tenant admin can save a brand-new mapping (was 42501 → 500 as cp_app)', async () => {
  const slug = 'maprls-insert';
  const put = await call('PUT', `/api/datasets/${slug}/mappings`, {
    mappings: [
      { entityId: CLAIM, industry: 'insurance', department: 'Claims', columnMap: { clm_amt: 'amount' }, confidence: 0.9 },
    ],
  });
  expect(put.status).toBe(200);
  expect(put.json.mappings).toHaveLength(1);

  // The row is OWNED by the caller's tenant — the only shape 0028 §4c will accept on write.
  const rows = await db
    .select({ tenant_id: datasetMappings.tenant_id })
    .from(datasetMappings)
    .where(eq(datasetMappings.dataset_id, dsId[slug]!));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tenant_id).toBe(TENANT);

  // And the caller can read back what they just wrote.
  const get = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(get.json.mappings).toHaveLength(1);
  expect(get.json.mappings[0].columnMap.clm_amt).toBe('amount');
});

test('UPDATE — saving over a seeded GLOBAL mapping actually changes what GET returns (was a 200 carrying the old values)', async () => {
  const slug = 'maprls-update';
  const put = await call('PUT', `/api/datasets/${slug}/mappings`, {
    mappings: [
      { entityId: CLAIM, industry: 'insurance', department: 'Claims', columnMap: { clm_amt: 'amount', clm_status: 'status' }, confidence: 0.95 },
    ],
  });
  expect(put.status).toBe(200);
  // ⛔ THE ASSERTION THAT WAS MISSING. A 200 proves nothing here: the pre-fix route returned
  // "Saved 1 mapping(s)" and a body listing the untouched global row.
  expect(put.json.mappings).toHaveLength(1);
  expect(put.json.mappings[0].columnMap.clm_status).toBe('status');

  const get = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(get.json.mappings).toHaveLength(1);
  expect(get.json.mappings[0].columnMap).toEqual({ clm_amt: 'amount', clm_status: 'status' });
});

test('DELETE — removing a mapping the GET lists returns 200, not 404', async () => {
  const slug = 'maprls-delete';
  const before = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(before.json.mappings).toHaveLength(1); // the GET lists it …

  const del = await call('DELETE', `/api/datasets/${slug}/mappings/${CLAIM}`);
  expect(del.status).toBe(200); // … so the DELETE must not 404 it.

  const after = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(after.json.mappings).toHaveLength(0);
});

test('PRUNE — re-pointing a cell drops the entity the save removed (else the runner injects both)', async () => {
  const slug = 'maprls-prune';
  const put = await call('PUT', `/api/datasets/${slug}/mappings`, {
    mappings: [
      { entityId: POLICY, industry: 'insurance', department: 'Claims', columnMap: { pol_no: 'policy_no' }, confidence: 0.9 },
    ],
  });
  expect(put.status).toBe(200);

  const get = await call('GET', `/api/datasets/${slug}/mappings`);
  const ids = get.json.mappings.map((m: { entityId: string }) => m.entityId);
  expect(ids).toEqual([POLICY]);
  expect(ids).not.toContain(CLAIM);
});

// Guard against the fix over-reaching: the SEED path writes GLOBAL rows (tenant_id NULL) and a
// tenant that has authored nothing of its own must still READ them. Without this the whole defect
// could be "fixed" by scoping the read to `tenant_id = mine`, which silently unmaps every seeded
// example dataset in the product.
test('a seeded GLOBAL mapping stays visible to a tenant that has authored none of its own', async () => {
  const rows = await db
    .select({ id: datasetMappings.id })
    .from(datasetMappings)
    .where(and(eq(datasetMappings.dataset_id, dsId['maprls-global']!), isNull(datasetMappings.tenant_id)));
  expect(rows).toHaveLength(1); // still global in the table …

  const get = await call('GET', `/api/datasets/maprls-global/mappings`);
  expect(get.status).toBe(200);
  expect(get.json.mappings).toHaveLength(1); // … and still listed to the tenant.
  expect(get.json.mappings[0].columnMap.clm_amt).toBe('amount');
});

// ⛔ THE COLLAPSE THE READ PATH PERFORMS, WHICH NOTHING ASSERTED. An adversarial review deleted
// `listMappings`' de-dup line outright and all 78 mapping tests stayed green — the invariant the
// code's own comment claims to "assert rather than assume" was pinned by nothing. Both rows exist
// simultaneously and legitimately: the seeded GLOBAL one, and the tenant's own, which supersedes
// it. Exactly one may reach the caller, and it must be the tenant's.
//
// Order-independence matters as much as the count. `dataset_mappings_natural_uq` does not order
// anything, so a collapse that just took the first row of whatever the heap returned would pass
// on a fresh table and flip later. The second half re-writes the tenant row (moving it in the
// heap) and re-reads — see the memory of a fixture that pinned physical row order.
test('a re-run seed that re-creates the GLOBAL row cannot resurrect it over the tenant\'s own', async () => {
  const slug = 'maprls-collapse';

  // Precondition: the seeded global row is there, and it is the only one.
  const before = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(before.status).toBe(200);
  expect(before.json.mappings).toHaveLength(1);
  expect(before.json.mappings[0].columnMap.clm_amt).toBe('GLOBAL-LOSES');

  const put = await call('PUT', `/api/datasets/${slug}/mappings`, {
    mappings: [
      { entityId: CLAIM, industry: 'insurance', department: 'Claims', columnMap: { clm_amt: 'TENANT-WINS' }, confidence: 0.9 },
    ],
  });
  expect(put.status).toBe(200);

  // `reclaimGlobalRows` retired the global row, so through the API alone the two never coexist —
  // which is why deleting the collapse outright leaves every other case green.
  const afterPut = await db
    .select({ tenant: datasetMappings.tenant_id })
    .from(datasetMappings)
    .where(and(eq(datasetMappings.dataset_id, dsId[slug]!), eq(datasetMappings.entity_id, CLAIM)));
  expect(afterPut).toHaveLength(1);
  expect(afterPut[0]!.tenant).toBe(TENANT);

  // ⛔ THE STATE THE COLLAPSE ACTUALLY EXISTS FOR, and the one nothing asserted. `seedAll()` runs
  // on every boot when SEED_DEMO_DATA is on, and seed-example-blocks.ts writes its mappings as
  // GLOBAL (tenant_id NULL) — so the row a tenant's save retired comes BACK on the next roll,
  // beside the tenant's own. Both are then legitimately present, and exactly one may reach the
  // caller. An adversarial review deleted the de-dup line and all 78 mapping tests stayed green.
  await db.insert(datasetMappings).values({
    dataset_id: dsId[slug]!,
    entity_id: CLAIM,
    industry: 'insurance',
    department: 'Claims',
    column_map: { clm_amt: 'GLOBAL-LOSES' },
    confidence: 1,
    source: 'human',
    confirmed: true,
    tenant_id: null,
  });
  const both = await db
    .select({ tenant: datasetMappings.tenant_id })
    .from(datasetMappings)
    .where(and(eq(datasetMappings.dataset_id, dsId[slug]!), eq(datasetMappings.entity_id, CLAIM)));
  expect(both).toHaveLength(2); // the state under test really is the two-row one

  const get = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(get.json.mappings.filter((m: { entityId: string }) => m.entityId === CLAIM)).toHaveLength(1);
  expect(get.json.mappings[0].columnMap.clm_amt).toBe('TENANT-WINS');

  // Order-independence: `dataset_mappings_natural_uq` orders nothing, so a collapse that took
  // whichever row the heap returned first would pass on a fresh table and flip later. Re-write the
  // tenant row (moving it in the heap) with the global row still present, and re-read.
  const again = await call('PUT', `/api/datasets/${slug}/mappings`, {
    mappings: [
      { entityId: CLAIM, industry: 'insurance', department: 'Claims', columnMap: { clm_amt: 'TENANT-WINS-2' }, confidence: 0.9 },
    ],
  });
  expect(again.status).toBe(200);
  const get2 = await call('GET', `/api/datasets/${slug}/mappings`);
  expect(get2.json.mappings.filter((m: { entityId: string }) => m.entityId === CLAIM)).toHaveLength(1);
  expect(get2.json.mappings[0].columnMap.clm_amt).toBe('TENANT-WINS-2');
});

// ⛔ NOT TESTED, DELIBERATELY, AND SAY SO RATHER THAN SHIP A GREEN TEST THAT PROVES NOTHING.
// `upsertMapping` carries a bounded retry on 23505 (see its comment): the SELECT-then-INSERT shape
// means two concurrent first-saves both miss and both INSERT, and the loser trips
// `dataset_mappings_natural_uq` → a bare 500. I wrote a 24-way concurrent PUT case for it and it
// passed WITH THE RETRY REMOVED — this harness drives the handler through one connection, so the
// requests serialise and the race never occurs in-process. A test that cannot fail on the mutant
// is worse than no test, so it is gone. The retry stands on the reproduction an adversarial review
// produced against a real pool (8-way post-fix, 16-way pre-fix), not on a test in this file.
