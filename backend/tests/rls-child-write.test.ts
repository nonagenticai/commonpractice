// tests/rls-child-write.test.ts — migration 0057: the child-via-parent policies must scope WRITES,
// not just visibility.
//
// THE AXIS THE SUITE NEVER CROSSED. rls-isolation.test.ts proves reads (a foreign tenant sees the
// global block, not the other tenant's) and proves writes on tables that CARRY a tenant_id (a tenant
// cannot UPDATE a global building_block). Nobody ever crossed the two: **global parent × write on a
// child**. The 0028 §4d / 0037 §4 child policies were written with no `FOR` clause — which defaults
// to `FOR ALL`, so they govern INSERT/UPDATE/DELETE too — while their predicate only asked "is the
// parent row VISIBLE?". A platform-global parent (tenant_id IS NULL) is visible to EVERY tenant, so
// every tenant could rewrite the platform block catalogue's versions and tests, the global ontology's
// attributes, and the shipped MCP prompts' versions. Measured before 0057, as cp_app with a
// fabricated tenant: UPDATE block_versions → 24, block_tests → 17, ontology_attributes → 133/DELETE
// 133, mcp_prompt_versions → 26/DELETE 26, INSERT INTO block_tests → 1.
//
// AND WHY THE ANTI-DRIFT GUARD COULD NOT HAVE CAUGHT IT: rls-coverage.test.ts enumerates
// `information_schema.columns WHERE column_name = 'tenant_id'`. All eight 4d children carry no
// tenant_id — that is the entire point of scoping them through a parent — so they are structurally
// invisible to that query. It asserts "RLS enabled + ≥1 policy", which these tables passed the whole
// time. This file is the enforcement half for the five affected children.
//
// Runs AS the runtime role cp_app (SET ROLE on a max:1 connection — the technique documented at
// length in rls-isolation.test.ts's cpAppSql). The default test connection is the table OWNER, which
// bypasses RLS entirely, so a test that skipped this would pass vacuously against a broken policy.
// (withTenantDbAsRuntimeRoleForTests in db/client.ts is the same guarantee for route-level tests;
// raw SQL is used here because the assertions are on affected-ROWCOUNTS, which drizzle hides.)
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray, eq, and } from 'drizzle-orm';
import postgres from 'postgres';
import {
  db,
  tenants,
  users,
  buildingBlocks,
  blockVersions,
  blockTests,
  blockTestResults,
  ontologyEntities,
  ontologyAttributes,
  mcpPrompts,
  mcpPromptVersions,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { emptyDescriptor, type BlockDescriptor } from '../src/db/block-types';
import { runBlockTests } from '../src/blocks/test-runner';
import { seedPlatform } from '../src/db/seed-platform';
import { requireScannedSource } from '../src/blocks/source-gate';

// OWNER = the tenant that legitimately owns the tenant-scoped fixtures.
// FOREIGN = a second, unrelated tenant. It owns nothing here; it is the attacker.
const OWNER = '00000000-0000-0000-0000-00000c570001';
const FOREIGN = '00000000-0000-0000-0000-00000c570002';
const USER_OWNER = '00000000-0000-0000-0000-00000c57a001';

// Global (platform) fixtures — tenant_id NULL, readable by every tenant.
const G_BLOCK = '00000000-0000-0000-0000-00000c5790a0';
const G_VERSION = '00000000-0000-0000-0000-00000c5790a1';
const G_TEST = '00000000-0000-0000-0000-00000c5790a2';
const G_ENTITY = '00000000-0000-0000-0000-00000c5790b0';
const G_ATTR = '00000000-0000-0000-0000-00000c5790b1';
const G_PROMPT = '00000000-0000-0000-0000-00000c5790c0';
const G_PROMPT_VER = '00000000-0000-0000-0000-00000c5790c1';

// A SECOND global block, this one actually RUNNABLE — it exists solely so the APPLICATION half of
// the 0057 change (test-runner.ts's runAsSystem-wrapped persists) can be exercised end to end.
// The fixtures above are inert rows for raw-SQL policy assertions; this one has real source that
// the runner subprocess can execute, so runBlockTests produces a genuine `pass` to persist.
const G_RUN_BLOCK = '00000000-0000-0000-0000-00000c5790d0';
const G_RUN_VERSION = '00000000-0000-0000-0000-00000c5790d1';
const G_RUN_TEST = '00000000-0000-0000-0000-00000c5790d2';

const DOUBLER_DESCRIPTOR: BlockDescriptor = {
  inputs: { x: { type: 'number', required: true } },
  outputs: { doubled: { type: 'number' } },
  capabilities: { network: false },
};
const DOUBLER_SOURCE = `export default {
  descriptor: { inputs: { x: { type: 'number', required: true } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
  async run(inputs, ctx) { return { doubled: inputs.x * 2 }; }
};`;

// OWNER-tenant fixtures — the same five children, but under an owned parent. These prove the fix
// only removes the CROSS-tenant write; the owning tenant's own writes must still land.
const O_BLOCK = '00000000-0000-0000-0000-00000c5710a0';
const O_VERSION = '00000000-0000-0000-0000-00000c5710a1';
const O_TEST = '00000000-0000-0000-0000-00000c5710a2';
const O_ENTITY = '00000000-0000-0000-0000-00000c5710b0';
const O_ATTR = '00000000-0000-0000-0000-00000c5710b1';
const O_PROMPT = '00000000-0000-0000-0000-00000c5710c0';
const O_PROMPT_VER = '00000000-0000-0000-0000-00000c5710c1';

/** An ordinary connection that has become cp_app via SET ROLE. `max: 1` is load-bearing: SET ROLE is
 *  per-session, so the pool must never hand out a second, un-roled connection. See rls-isolation. */
function cpAppSql() {
  return postgres(process.env.DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { options: '-c role=cp_app' },
  });
}

let app: ReturnType<typeof postgres>;

async function cleanup() {
  // Global rows have tenant_id NULL → they do NOT cascade from tenants; delete them explicitly.
  await db.delete(mcpPromptVersions).where(inArray(mcpPromptVersions.id, [G_PROMPT_VER, O_PROMPT_VER]));
  await db.delete(mcpPrompts).where(inArray(mcpPrompts.id, [G_PROMPT, O_PROMPT]));
  await db.delete(ontologyAttributes).where(inArray(ontologyAttributes.id, [G_ATTR, O_ATTR]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.id, [G_ENTITY, O_ENTITY]));
  await db.delete(blockTestResults).where(inArray(blockTestResults.version_id, [G_VERSION, O_VERSION, G_RUN_VERSION]));
  await db.delete(blockTests).where(inArray(blockTests.block_id, [G_BLOCK, O_BLOCK, G_RUN_BLOCK]));
  await db.update(buildingBlocks).set({ current_version_id: null }).where(inArray(buildingBlocks.id, [G_BLOCK, O_BLOCK, G_RUN_BLOCK]));
  await db.delete(blockVersions).where(inArray(blockVersions.block_id, [G_BLOCK, O_BLOCK, G_RUN_BLOCK]));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, [G_BLOCK, O_BLOCK, G_RUN_BLOCK]));
  await db.delete(users).where(eq(users.id, USER_OWNER));
  await db.delete(tenants).where(inArray(tenants.id, [OWNER, FOREIGN]));
}

// Explicit hook timeout: bun ignores bunfig's [test] timeout for HOOKS, so a slow one reports as
// "(unnamed) [5003ms]" with no file or cause. See license-provisioning.test.ts.
beforeAll(async () => {
  // The runnable-global-block test executes a real runner subprocess, whose governance snapshot
  // (getSnapshot → policies) must exist. Cheap and idempotent.
  await seedPlatform();
  await cleanup();
  // Seeded as the OWNER connection → RLS bypassed, so the fixtures land regardless of policy.
  await db.insert(tenants).values([
    { id: OWNER, name: 'Child-write owner', slug: 'rls-cw-owner' },
    { id: FOREIGN, name: 'Child-write foreign', slug: 'rls-cw-foreign' },
  ]);
  await db.insert(users).values([
    { id: USER_OWNER, email: 'rls-cw-owner@test', name: 'Owner User', tenant_id: OWNER },
  ]);

  await db.insert(buildingBlocks).values([
    { id: G_BLOCK, slug: 'rls-cw-global-blk', name: 'Global blk', category: 'logic', tenant_id: null },
    { id: O_BLOCK, slug: 'rls-cw-owner-blk', name: 'Owner blk', category: 'logic', tenant_id: OWNER },
    { id: G_RUN_BLOCK, slug: 'rls-cw-global-run', name: 'Global runnable blk', category: 'logic', tenant_id: null },
  ]);
  await db.insert(blockVersions).values([
    { id: G_VERSION, block_id: G_BLOCK, version: '0.1.0', status: 'draft', descriptor: emptyDescriptor(), changelog: 'orig' },
    { id: O_VERSION, block_id: O_BLOCK, version: '0.1.0', status: 'draft', descriptor: emptyDescriptor(), changelog: 'orig' },
    {
      id: G_RUN_VERSION, block_id: G_RUN_BLOCK, version: '0.1.0', status: 'draft',
      descriptor: DOUBLER_DESCRIPTOR, source_ts: requireScannedSource(DOUBLER_SOURCE), changelog: 'orig',
      tests_passing: false,
    },
  ]);
  await db.insert(blockTests).values([
    { id: G_TEST, block_id: G_BLOCK, name: 'global-case' },
    { id: O_TEST, block_id: O_BLOCK, name: 'owner-case' },
    {
      id: G_RUN_TEST, block_id: G_RUN_BLOCK, name: 'doubles-5',
      inputs: { x: 5 }, expected: { doubled: 10 }, assert_mode: 'subset',
      enabled: true, created_by: USER_OWNER,
    },
  ]);
  await db.insert(blockTestResults).values([
    { version_id: G_VERSION, test_id: G_TEST, status: 'pass', duration_ms: 1 },
    { version_id: O_VERSION, test_id: O_TEST, status: 'pass', duration_ms: 1 },
  ]);

  await db.insert(ontologyEntities).values([
    { id: G_ENTITY, scope: 'generic', department: 'rls-cw', name: 'rls_cw_global', label: 'Global entity', tenant_id: null },
    { id: O_ENTITY, scope: 'generic', department: 'rls-cw', name: 'rls_cw_owner', label: 'Owner entity', tenant_id: OWNER },
  ]);
  await db.insert(ontologyAttributes).values([
    { id: G_ATTR, entity_id: G_ENTITY, name: 'global_attr', type: 'string' },
    { id: O_ATTR, entity_id: O_ENTITY, name: 'owner_attr', type: 'string' },
  ]);

  // mcp_prompts.tenant_id is UUID as of 0084 → app_current_tenant_uuid(). It was TEXT (the
  // "text variant" 0028 §4b/§4c named) and used app_current_tenant_text(); 0084 removed the
  // variant along with its reason. NULL still means a GLOBAL prompt — that has not changed.
  await db.insert(mcpPrompts).values([
    { id: G_PROMPT, name: 'rls.cw.global', locale: 'en', tenant_id: null, template: 'global' },
    { id: O_PROMPT, name: 'rls.cw.owner', locale: 'en', tenant_id: OWNER, template: 'owner' },
  ]);
  await db.insert(mcpPromptVersions).values([
    { id: G_PROMPT_VER, prompt_id: G_PROMPT, version_number: 1, template: 'global v1' },
    { id: O_PROMPT_VER, prompt_id: O_PROMPT, version_number: 1, template: 'owner v1' },
  ]);

  app = cpAppSql();
}, 30_000);

afterAll(async () => {
  await app?.end({ timeout: 5 });
  await cleanup();
}, 30_000);

async function setTenant(t: string | null) {
  await app.unsafe("select set_config('app.current_tenant', $1, false)", [t ?? '']);
}

// try/catch rather than expect().rejects: bun's matcher double-consumes postgres-js's custom
// thenable and wedges the (max:1) connection. Same reason as rls-isolation.test.ts.
async function expectRlsRejection(fn: () => Promise<unknown>, what: string) {
  let err: Error | null = null;
  try {
    await fn();
  } catch (e) {
    err = e as Error;
  }
  expect(err, `${what} must be rejected by RLS WITH CHECK`).not.toBeNull();
  expect(err!.message).toMatch(/row-level security/i);
}

// ---------------------------------------------------------------------------------------------
// READ must be untouched: the marketplace / block catalogue / global ontology / shipped prompts
// are readable by every tenant BY DESIGN. If 0057 had broken this it would have broken the product.
// ---------------------------------------------------------------------------------------------

test('READ unchanged: a foreign tenant still SELECTs every child row of a GLOBAL parent', async () => {
  await setTenant(FOREIGN);
  const bv = await app`SELECT id FROM block_versions WHERE block_id = ${G_BLOCK}`;
  const bt = await app`SELECT id FROM block_tests WHERE block_id = ${G_BLOCK}`;
  const btr = await app`SELECT test_id FROM block_test_results WHERE version_id = ${G_VERSION}`;
  const oa = await app`SELECT id FROM ontology_attributes WHERE entity_id = ${G_ENTITY}`;
  const pv = await app`SELECT id FROM mcp_prompt_versions WHERE prompt_id = ${G_PROMPT}`;
  expect(bv.length, 'block_versions of a global block must stay visible').toBe(1);
  expect(bt.length, 'block_tests of a global block must stay visible').toBe(1);
  expect(btr.length, 'block_test_results of a global version must stay visible').toBe(1);
  expect(oa.length, 'ontology_attributes of a global entity must stay visible').toBe(1);
  expect(pv.length, 'mcp_prompt_versions of a global prompt must stay visible').toBe(1);
});

test("READ still excludes another TENANT's children (the pre-existing 4d guarantee)", async () => {
  await setTenant(FOREIGN);
  const bv = await app`SELECT id FROM block_versions WHERE block_id = ${O_BLOCK}`;
  const bt = await app`SELECT id FROM block_tests WHERE block_id = ${O_BLOCK}`;
  // block_test_results is the only TWO-HOP table (result → block_versions → building_blocks), so its
  // read policy leans on block_versions' own policy resolving inside the subquery. Omitting it here
  // left the one table whose read path can break independently untested.
  const btr = await app`SELECT test_id FROM block_test_results WHERE version_id = ${O_VERSION}`;
  const oa = await app`SELECT id FROM ontology_attributes WHERE entity_id = ${O_ENTITY}`;
  const pv = await app`SELECT id FROM mcp_prompt_versions WHERE prompt_id = ${O_PROMPT}`;
  expect(bv.length).toBe(0);
  expect(bt.length).toBe(0);
  expect(btr.length, "another tenant's block_test_results must stay invisible").toBe(0);
  expect(oa.length).toBe(0);
  expect(pv.length).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// THE BUG: global parent × write. Every one of these was a non-zero rowcount before 0057.
// ---------------------------------------------------------------------------------------------

test('block_versions: a foreign tenant cannot UPDATE or DELETE a GLOBAL block version', async () => {
  await setTenant(FOREIGN);
  const upd = await app`UPDATE block_versions SET changelog = 'HIJACK' WHERE block_id = ${G_BLOCK}`;
  expect(upd.count, 'UPDATE on a global block version must affect 0 rows').toBe(0);
  const del = await app`DELETE FROM block_versions WHERE block_id = ${G_BLOCK}`;
  expect(del.count, 'DELETE on a global block version must affect 0 rows').toBe(0);
});

test('block_tests: a foreign tenant cannot UPDATE, DELETE or INSERT against a GLOBAL block', async () => {
  await setTenant(FOREIGN);
  const upd = await app`UPDATE block_tests SET name = 'hijacked' WHERE block_id = ${G_BLOCK}`;
  expect(upd.count, 'UPDATE on a global block test must affect 0 rows').toBe(0);
  const del = await app`DELETE FROM block_tests WHERE block_id = ${G_BLOCK}`;
  expect(del.count, 'DELETE on a global block test must affect 0 rows').toBe(0);
  await expectRlsRejection(
    () => app`INSERT INTO block_tests (block_id, name) VALUES (${G_BLOCK}, 'forged')`,
    'planting a test on a global block',
  );
});

test('block_test_results: a foreign tenant cannot UPDATE, DELETE or INSERT on the GLOBAL chain', async () => {
  await setTenant(FOREIGN);
  const upd = await app`UPDATE block_test_results SET status = 'fail' WHERE version_id = ${G_VERSION}`;
  expect(upd.count, 'UPDATE on a global block test result must affect 0 rows').toBe(0);
  const del = await app`DELETE FROM block_test_results WHERE version_id = ${G_VERSION}`;
  expect(del.count, 'DELETE on a global block test result must affect 0 rows').toBe(0);
  // Ownership here is two hops away: block_test_results → block_versions → building_blocks.
  await expectRlsRejection(
    () => app`INSERT INTO block_test_results (version_id, test_id, status)
              VALUES (${O_VERSION}, ${G_TEST}, 'pass')`,
    'planting a result against another tenant/global version',
  );
});

test('ontology_attributes: a foreign tenant cannot UPDATE, DELETE or INSERT on a GLOBAL entity', async () => {
  await setTenant(FOREIGN);
  const upd = await app`UPDATE ontology_attributes SET pii = true WHERE entity_id = ${G_ENTITY}`;
  expect(upd.count, 'UPDATE on a global entity attribute must affect 0 rows').toBe(0);
  const del = await app`DELETE FROM ontology_attributes WHERE entity_id = ${G_ENTITY}`;
  expect(del.count, 'DELETE on a global entity attribute must affect 0 rows').toBe(0);
  await expectRlsRejection(
    () => app`INSERT INTO ontology_attributes (entity_id, name, type)
              VALUES (${G_ENTITY}, 'forged', 'string')`,
    'planting an attribute on a global ontology entity',
  );
});

test('mcp_prompt_versions: a foreign tenant cannot UPDATE, DELETE or INSERT on a GLOBAL prompt', async () => {
  await setTenant(FOREIGN);
  const upd = await app`UPDATE mcp_prompt_versions SET template = 'HIJACK' WHERE prompt_id = ${G_PROMPT}`;
  expect(upd.count, 'UPDATE on a global prompt version must affect 0 rows').toBe(0);
  const del = await app`DELETE FROM mcp_prompt_versions WHERE prompt_id = ${G_PROMPT}`;
  expect(del.count, 'DELETE on a global prompt version must affect 0 rows').toBe(0);
  await expectRlsRejection(
    () => app`INSERT INTO mcp_prompt_versions (prompt_id, version_number, template)
              VALUES (${G_PROMPT}, 99, 'forged')`,
    'planting a version on a global MCP prompt',
  );
});

test("a foreign tenant cannot write another TENANT's children either", async () => {
  await setTenant(FOREIGN);
  const bv = await app`UPDATE block_versions SET changelog = 'HIJACK' WHERE block_id = ${O_BLOCK}`;
  const bt = await app`UPDATE block_tests SET name = 'hijacked' WHERE block_id = ${O_BLOCK}`;
  const btr = await app`UPDATE block_test_results SET status = 'fail' WHERE version_id = ${O_VERSION}`;
  const oa = await app`UPDATE ontology_attributes SET pii = true WHERE entity_id = ${O_ENTITY}`;
  const pv = await app`UPDATE mcp_prompt_versions SET template = 'HIJACK' WHERE prompt_id = ${O_PROMPT}`;
  expect([bv.count, bt.count, btr.count, oa.count, pv.count]).toEqual([0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------------------------
// The other half of the contract: the fix must not turn into a lockout. The tenant that OWNS the
// parent still writes its own children normally.
// ---------------------------------------------------------------------------------------------

test('the OWNING tenant can still UPDATE all five of its own children', async () => {
  await setTenant(OWNER);
  const bv = await app`UPDATE block_versions SET changelog = 'owner-edit' WHERE block_id = ${O_BLOCK}`;
  const bt = await app`UPDATE block_tests SET description = 'owner-edit' WHERE block_id = ${O_BLOCK}`;
  const btr = await app`UPDATE block_test_results SET status = 'fail' WHERE version_id = ${O_VERSION}`;
  const oa = await app`UPDATE ontology_attributes SET pii = true WHERE entity_id = ${O_ENTITY}`;
  const pv = await app`UPDATE mcp_prompt_versions SET template = 'owner-edit' WHERE prompt_id = ${O_PROMPT}`;
  expect([bv.count, bt.count, btr.count, oa.count, pv.count]).toEqual([1, 1, 1, 1, 1]);
});

test('the OWNING tenant can still INSERT children under its own parents', async () => {
  await setTenant(OWNER);
  const bt = await app`INSERT INTO block_tests (block_id, name) VALUES (${O_BLOCK}, 'owner-added') RETURNING id`;
  expect(bt.length).toBe(1);
  const oa = await app`INSERT INTO ontology_attributes (entity_id, name, type)
                       VALUES (${O_ENTITY}, 'owner_added', 'string') RETURNING id`;
  expect(oa.length).toBe(1);
  const pv = await app`INSERT INTO mcp_prompt_versions (prompt_id, version_number, template)
                       VALUES (${O_PROMPT}, 2, 'owner v2') RETURNING id`;
  expect(pv.length).toBe(1);
  // Cleanup of these three is covered by the fixture cleanup (they hang off O_BLOCK / O_ENTITY /
  // O_PROMPT, which are deleted by id, and by the OWNER tenant's ON DELETE CASCADE).
});

test('the OWNING tenant can still DELETE its own children', async () => {
  await setTenant(OWNER);
  // Self-contained: this used to DELETE the 'owner-added' row planted by the INSERT test above, so
  // running this test alone (`-t 'can still DELETE'`) deleted 0 rows and failed for reasons that had
  // nothing to do with RLS. It seeds and removes its own row.
  const ins = await app`INSERT INTO block_tests (block_id, name) VALUES (${O_BLOCK}, 'owner-deletable') RETURNING id`;
  expect(ins.length, 'precondition: the owning tenant can plant its own child row').toBe(1);
  const del = await app`DELETE FROM block_tests WHERE block_id = ${O_BLOCK} AND name = 'owner-deletable'`;
  expect(del.count).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// FK REPOINT — the one attack only WITH CHECK can stop. Every test above either writes a row whose
// FK ALREADY points at a forbidden parent (blocked by USING) or inserts one (blocked by WITH CHECK
// on a fresh row). Neither covers the middle case: UPDATE a row you legitimately OWN and move its
// FK onto a GLOBAL parent. USING passes (the OLD row's parent is yours), so the write is admitted —
// only WITH CHECK, evaluated against the NEW row, rejects it. Had 0057 written USING without a
// matching WITH CHECK, every assertion above would still be green while a tenant could donate its
// own rows into the platform catalogue / global ontology / shipped prompts.
// ---------------------------------------------------------------------------------------------

test('WITH CHECK: the owning tenant cannot REPOINT its own child rows at a GLOBAL parent', async () => {
  await setTenant(OWNER);
  await expectRlsRejection(
    () => app`UPDATE block_versions SET block_id = ${G_BLOCK} WHERE id = ${O_VERSION}`,
    'repointing an owned block_version at the global block',
  );
  await expectRlsRejection(
    () => app`UPDATE block_tests SET block_id = ${G_BLOCK} WHERE id = ${O_TEST}`,
    'repointing an owned block_test at the global block',
  );
  await expectRlsRejection(
    () => app`UPDATE block_test_results SET version_id = ${G_VERSION} WHERE version_id = ${O_VERSION}`,
    'repointing an owned block_test_result at the global version (two hops)',
  );
  await expectRlsRejection(
    () => app`UPDATE ontology_attributes SET entity_id = ${G_ENTITY} WHERE id = ${O_ATTR}`,
    'repointing an owned ontology_attribute at the global entity',
  );
  await expectRlsRejection(
    () => app`UPDATE mcp_prompt_versions SET prompt_id = ${G_PROMPT} WHERE id = ${O_PROMPT_VER}`,
    'repointing an owned mcp_prompt_version at the global prompt',
  );

  // And nothing moved: a rejected statement must leave the owned rows where they were.
  const stillOwned = await app`
    SELECT (SELECT count(*) FROM block_versions      WHERE id = ${O_VERSION}    AND block_id  = ${O_BLOCK})  AS bv,
           (SELECT count(*) FROM block_tests         WHERE id = ${O_TEST}       AND block_id  = ${O_BLOCK})  AS bt,
           (SELECT count(*) FROM block_test_results  WHERE version_id = ${O_VERSION})                        AS btr,
           (SELECT count(*) FROM ontology_attributes WHERE id = ${O_ATTR}       AND entity_id = ${O_ENTITY}) AS oa,
           (SELECT count(*) FROM mcp_prompt_versions WHERE id = ${O_PROMPT_VER} AND prompt_id = ${O_PROMPT}) AS pv`;
  expect(
    [stillOwned[0]!.bv, stillOwned[0]!.bt, stillOwned[0]!.btr, stillOwned[0]!.oa, stillOwned[0]!.pv].map(Number),
  ).toEqual([1, 1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------------------------
// THE APPLICATION HALF. Everything above proves the MIGRATION. It proves nothing about
// blocks/test-runner.ts, whose two persist statements now have to route through `runAsSystem` for a
// GLOBAL block — and that code had ZERO enforcing coverage: the ordinary backend suite connects as
// the table OWNER (rolbypassrls, no app.current_tenant), so RLS is bypassed and the runAsSystem
// wrapper could be deleted with all 35 tests still green. Measured, not assumed.
//
// This test closes that hole by running the REAL runBlockTests against a GLOBAL block inside
// withTenantDbAsRuntimeRoleForTests, which is the same guarantee cpAppSql gives the raw-SQL tests
// (SET ROLE cp_app + app.current_tenant on a reserved connection) but reaches through the ALS-bound
// `db` Proxy the way a route does. Without runAsSystem the block_test_results INSERT raises 42501
// and runBlockTests throws; the tests_passing assertion additionally catches the SILENT variant,
// where the UPDATE matches 0 rows and the recomputed value is returned as if it had been written.
// ---------------------------------------------------------------------------------------------

test('runBlockTests persists a GLOBAL block\'s results under the ENFORCING runtime role', async () => {
  // Start from a known-false rollup so a passing assertion cannot be satisfied by the seed value.
  await db.update(blockVersions).set({ tests_passing: false }).where(eq(blockVersions.id, G_RUN_VERSION));
  await db.delete(blockTestResults).where(eq(blockTestResults.version_id, G_RUN_VERSION));

  const summary = await withTenantDbAsRuntimeRoleForTests(OWNER, () =>
    // `tenantId` is the request's tenant, so it is the one this connection is scoped to — the same
    // value the surrounding `withTenantDbAsRuntimeRoleForTests` binds as `app.current_tenant`.
    runBlockTests(G_RUN_VERSION, { ctxUserId: USER_OWNER, tenantId: OWNER }),
  );

  expect(summary.total, 'the one enabled test must have run').toBe(1);
  expect(summary.results[0]!.error, 'the runner must not have errored').toBeNull();
  expect(summary.results[0]!.status).toBe('pass');
  expect(summary.passed).toBe(1);
  expect(summary.testsPassing).toBe(true);

  // Read back on the OWNER connection (RLS bypassed) — the question is whether the rows are REALLY
  // there, which is exactly what the caller's own return value cannot tell you.
  const persisted = await db
    .select({ status: blockTestResults.status })
    .from(blockTestResults)
    .where(
      and(eq(blockTestResults.version_id, G_RUN_VERSION), eq(blockTestResults.test_id, G_RUN_TEST)),
    );
  expect(persisted.length, 'block_test_results row must be PERSISTED, not just returned').toBe(1);
  expect(persisted[0]!.status).toBe('pass');

  const [v] = await db
    .select({ tests_passing: blockVersions.tests_passing })
    .from(blockVersions)
    .where(eq(blockVersions.id, G_RUN_VERSION));
  expect(v!.tests_passing, 'block_versions.tests_passing must be PERSISTED as true').toBe(true);
});

test('the runtime role genuinely could NOT have written those rows itself', async () => {
  // Guards the guard: proves the test above was actually enforcing, i.e. that its writes needed the
  // runAsSystem escape hatch rather than sailing through a policy that never applied. Same tenant,
  // same rows, but through cp_app directly instead of through runAsSystem.
  await setTenant(OWNER);
  const upd = await app`UPDATE block_test_results SET status = 'fail' WHERE version_id = ${G_RUN_VERSION}`;
  expect(upd.count, 'cp_app must NOT be able to touch a global version\'s results').toBe(0);
  const bv = await app`UPDATE block_versions SET tests_passing = false WHERE id = ${G_RUN_VERSION}`;
  expect(bv.count, 'cp_app must NOT be able to flip a global version\'s tests_passing').toBe(0);
});

// ---------------------------------------------------------------------------------------------
// Shape guard: the five policies must stay SPLIT. A future migration that collapses them back into
// one FOR ALL policy — the 0028/0037 default-clause trap — re-opens the whole hole silently.
// ---------------------------------------------------------------------------------------------

test('0057 shape: the five children have a FOR SELECT read policy and a strict FOR ALL write policy', async () => {
  const CHILDREN = [
    'block_versions',
    'block_tests',
    'block_test_results',
    'ontology_attributes',
    'mcp_prompt_versions',
  ];
  const rows = await app<{ tablename: string; policyname: string; cmd: string; qual: string }[]>`
    SELECT tablename, policyname, cmd, qual FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(${CHILDREN})
  `;
  for (const t of CHILDREN) {
    const forTable = rows.filter((r) => r.tablename === t);
    const read = forTable.find((r) => r.policyname === `${t}_read`);
    const write = forTable.find((r) => r.policyname === `${t}_write`);
    expect(read, `${t}: expected a ${t}_read policy`).toBeDefined();
    expect(read!.cmd, `${t}_read must be FOR SELECT`).toBe('SELECT');
    expect(write, `${t}: expected a ${t}_write policy`).toBeDefined();
    expect(write!.cmd, `${t}_write must be FOR ALL`).toBe('ALL');
    expect(
      write!.qual,
      `${t}_write must constrain the parent's tenant_id, not just its visibility`,
      // ⛔ `uuid` ONLY, no `|text` arm. This used to accept either helper, because
      // `mcp_prompt_versions_write` was the one child policy whose parent (`mcp_prompts`) kept a
      // TEXT tenant_id. 0084 made all three remaining text columns uuid, so the text arm now
      // matches nothing that should exist — and leaving it in is worse than useless: it is
      // exactly what would let a forgotten `mcp_prompt_versions_write` recreate slip through
      // green. That policy lives on a DIFFERENT table from the column it depends on, which makes
      // it the one this assertion has to catch.
    ).toMatch(/tenant_id = app_current_tenant_uuid\(\)/);
    expect(
      forTable.find((r) => r.policyname === `${t}_via_parent`),
      `${t}: the visibility-only FOR ALL policy must be gone`,
    ).toBeUndefined();
  }
});

// The three 4d children NOT touched by 0057. Their parents (challenges / chat_sessions / datasets)
// are on the STRICT §4a/§4b shape with no `IS NULL` branch, so visible ⇒ owned and the single
// FOR ALL policy is already correct. Asserted so a well-meaning follow-up doesn't "fix" them and
// so the reasoning for the split stays testable rather than living only in a comment.
test('the strict-parent 4d children are deliberately left as a single FOR ALL policy', async () => {
  const SAFE = ['challenge_datasets', 'chat_messages', 'dataset_rows'];
  const rows = await app<{ tablename: string; policyname: string; cmd: string }[]>`
    SELECT tablename, policyname, cmd FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(${SAFE})
  `;
  for (const t of SAFE) {
    const p = rows.filter((r) => r.tablename === t);
    expect(p.length, `${t}: expected exactly one policy`).toBe(1);
    expect(p[0]!.policyname).toBe(`${t}_via_parent`);
    expect(p[0]!.cmd).toBe('ALL');
  }
});
