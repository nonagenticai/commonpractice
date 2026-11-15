// tests/block-fixture-tenant.test.ts — A BLOCK'S DATASET FIXTURE MUST COME FROM THE TENANT THE
// REQUEST IS SCOPED TO, NOT FROM THE CALLER'S STALE `users.tenant_id`.
//
// ⛔ THE DEFECT THIS FILE PINS. `src/blocks/test-runner.ts` resolved dataset fixtures with
// `(await homeTenantOf(ctxUserId)) ?? ctxUserId` — the `users.tenant_id` column `ensureUser` writes
// ONCE on first touch and never reconciles against a later Keycloak `tenant_id` claim. The copilot,
// meanwhile, binds the TOKEN'S tenant for the whole turn (`ai/agent.ts` → `withTenantDb`), and the
// block routes bind the request's. So `simulate_block` / `run_block_test` reached PAST the scope
// their own caller had established and re-derived an older workspace: a developer whose claim had
// moved saw the WRONG tenant's rows injected into their block, or — when `users.tenant_id IS NULL`
// — the `?? ctxUserId` fallback put a USER id where `loadInjectedDatasets` compares a TENANT id, so
// the predicate matched nothing and every fixture silently resolved to the empty set.
//
// ⚠️ THE FIXTURE'S SHAPE IS THE WHOLE TEST. The user is homed in A and runs scoped to B, and the
// SAME dataset slug exists in BOTH tenants with DIFFERENT row counts (A=1, B=3). With an aligned
// user, or with one slug in one tenant, the old code and the new code produce identical output and
// every assertion below passes against both — which is exactly how the defect shipped. A green run
// that reads 1 row is measuring the bug, not the fix, so every assertion states BOTH halves:
// the count IS B's and is NOT A's.
//
// MEASURED against the pre-fix line (`const fixtureTenant = (await homeTenantOf(ctxUserId)) ?? ctxUserId;`
// restored by hand into `simulateBlockVersion`) — and it fails DIFFERENTLY depending on the DB role,
// which is worth writing down because only one of the two is what a customer meets:
//
//   • OWNER DSN (RLS bypassed, how these suites are usually run): `count` came back **1** against an
//     expected **3**. The other workspace's rows were genuinely INJECTED into the block — a silent
//     wrong-data result, no error anywhere.
//   • `cp_app` DSN (NOBYPASSRLS — PRODUCTION's shape): the block errors
//     `dataset_not_available: dataset 'block-fixture-tenant-probe' is not available in this
//     workspace`. `datasets` carries RLS `tenant_id = app_current_tenant_uuid()` (it was the
//     `_text()` helper until migration 0084 made the column uuid), so the cross-tenant
//     read the old code attempts is refused outright and the fixture resolves to the EMPTY set.
//     The developer is told their own workspace's dataset does not exist.
//
// Both are this defect; the second is the one in the field, and it is why the reported symptom was
// "the copilot cannot see my test data" rather than "the copilot showed me someone else's". Run this
// file under BOTH DSNs — it passes under both, and 2 pass / 0 fail under `cp_app` is the meaningful
// half.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  datasets,
  buildingBlocks,
  blockVersions,
  blockTests,
  blockTestResults,
  withTenantDb,
  runAsSystem,
} from '../src/db/client';
import { createDataset } from '../src/datasets/dataset-service';
import { parseJsonValue } from '../src/datasets/parse/json';
import { requireScannedSource } from '../src/blocks/source-gate';
import { simulateBlockVersion, runBlockTests } from '../src/blocks/test-runner';
import type { BlockDescriptor } from '../src/db/block-types';

// `00000b1f` ("block fixture") is this file's own id block — greppably distinct from every other
// fixture in the suite, so a stray row from another file can never satisfy an assertion here and
// this file's teardown can never rip a row out from under another file
// (see tests/fixture-id-collisions.test.ts).
const TENANT_A = '00000000-0000-4000-8000-00000b1f0001'; // the STALE `users.tenant_id`
const TENANT_B = '00000000-0000-4000-8000-00000b1f0002'; // the REQUEST scope — the right answer
const USER_HOMED_A = '00000000-0000-4000-8000-00000b1f0a01';
const BLOCK_ID = '00000000-0000-4000-8000-00000b1f0b01';
const VERSION_ID = '00000000-0000-4000-8000-00000b1f0c01';
const BLOCK_TEST_ID = '00000000-0000-4000-8000-00000b1f0d01';

const SEEDED_TENANTS = [TENANT_A, TENANT_B];

/** ONE name in BOTH tenants. `datasets_tenant_slug_uq` is on (tenant_id, slug), so `createDataset`'s
 *  first slug probe (`slugify(name)` unsuffixed) wins in each tenant independently and the two rows
 *  come out with the SAME slug. That is asserted in `beforeEach` rather than assumed — the probe
 *  loop appends `-2` on a collision, and a silently different slug in B would make every assertion
 *  below measure "the fixture was missing" instead of "the wrong tenant answered". */
const DS_NAME = 'Block Fixture Tenant Probe';
const A_ROWS = [{ id: 'A-1' }];
const B_ROWS = [{ id: 'B-1' }, { id: 'B-2' }, { id: 'B-3' }];
let SLUG = '';

const DESCRIPTOR: BlockDescriptor = {
  inputs: {
    source: { type: 'dataset', required: true, description: 'The dataset to load.' },
  },
  outputs: {
    rows: { type: 'json' },
    count: { type: 'number' },
  },
  // Mirrors the seeded `load-dataset` block: `ctx.dataset` is gated on `dataset`, NOT `mockData`
  // (these rows are the tenant's own, not fabricated — see db/seed-datasets.ts).
  capabilities: { network: false, dataset: true },
};

// The one thing the block does is report how many rows the host injected for `inputs.source`, which
// is the tenant question expressed as a number the runner can carry back out of the subprocess.
const SOURCE = `export default {
  descriptor: ${JSON.stringify(DESCRIPTOR)},
  async run(inputs, ctx) {
    const rows = await ctx.dataset(inputs.source);
    return { rows, count: rows.length };
  },
};
`;

async function cleanup() {
  // Owner pool, no tenant GUC: setup and teardown must SEE BOTH TENANTS. A scoped reader could
  // report a leftover row "absent" merely because it was looking at the other workspace.
  await runAsSystem('boot-seed', async () => {
    await db.delete(blockTestResults).where(eq(blockTestResults.version_id, VERSION_ID));
    await db.delete(blockTests).where(eq(blockTests.block_id, BLOCK_ID));
    await db.delete(blockVersions).where(eq(blockVersions.block_id, BLOCK_ID));
    await db.delete(buildingBlocks).where(eq(buildingBlocks.id, BLOCK_ID));
    // dataset_rows cascades from datasets (FK onDelete: 'cascade').
    await db.delete(datasets).where(inArray(datasets.tenant_id, SEEDED_TENANTS));
    await db.delete(users).where(eq(users.id, USER_HOMED_A));
    await db.delete(tenants).where(inArray(tenants.id, SEEDED_TENANTS));
  });
}

// Explicit hook timeout — bun ignores bunfig's `[test]` timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause.
beforeEach(async () => {
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values([
      { id: TENANT_A, name: 'Stale Home Co', slug: 'bft-home-a' },
      { id: TENANT_B, name: 'Request Scope Co', slug: 'bft-scope-b' },
    ]);
    // `users.tenant_id = A` is the drift itself. Every run below is scoped to B.
    await db.insert(users).values({
      id: USER_HOMED_A,
      email: 'homed-a@bft.test',
      name: 'Homed A',
      tenant_id: TENANT_A,
    });

    // `datasets.owner_id` is a real FK to `users`; `datasets.tenant_id` is UUID (since 0084) with
    // no FK — scoped by value, the `challenges.tenant_id` house pattern — and it
    // is the column `loadInjectedDatasets` filters on — so the same owner in both tenants is
    // correct and keeps the ONLY difference between the two rows the thing under test.
    const dsA = await createDataset({
      ownerId: USER_HOMED_A,
      tenantId: TENANT_A,
      name: DS_NAME,
      sourceType: 'json',
      parsed: parseJsonValue(A_ROWS),
    });
    const dsB = await createDataset({
      ownerId: USER_HOMED_A,
      tenantId: TENANT_B,
      name: DS_NAME,
      sourceType: 'json',
      parsed: parseJsonValue(B_ROWS),
    });
    // The premise of every assertion in this file: ONE slug, TWO tenants, different row counts.
    expect(dsB.slug).toBe(dsA.slug);
    expect(dsA.row_count).toBe(A_ROWS.length);
    expect(dsB.row_count).toBe(B_ROWS.length);
    SLUG = dsA.slug;

    // Tenant-owned by B (the request scope), so `runBlockTests`'s result persistence runs on the
    // caller's connection under B — the production shape for a tenant-authored block.
    await db.insert(buildingBlocks).values({
      id: BLOCK_ID,
      slug: 'bft-load-fixture',
      name: 'BFT Load Fixture',
      category: 'data',
      tenant_id: TENANT_B,
    });
    await db.insert(blockVersions).values({
      id: VERSION_ID,
      block_id: BLOCK_ID,
      version: '0.1.0',
      status: 'draft',
      // `source_ts` is branded — nothing can write a block source without passing the gate.
      // `requireScannedSource` is the unconditional variant the seeders use: no `policies` read,
      // so this file cannot inherit a governance value another test file set (see the PR #155
      // note in tests/block-tests.test.ts).
      source_ts: requireScannedSource(SOURCE),
      descriptor: DESCRIPTOR,
    });
    // `created_by: null` ON PURPOSE. `runOneBlockTest` resolves fixtures in the test AUTHOR's org
    // when the row HAS an author — a real, deliberate axis that is NOT request tenancy. A test with
    // no author has no such axis, so the request's tenant is the only answer, and that is the case
    // this file is entitled to assert.
    await db.insert(blockTests).values({
      id: BLOCK_TEST_ID,
      block_id: BLOCK_ID,
      name: 'loads the request tenant fixture',
      inputs: { source: SLUG },
      expected: { count: B_ROWS.length },
      assert_mode: 'subset',
      created_by: null,
      enabled: true,
    });
  });
}, 30_000);

afterAll(cleanup, 30_000);

// ── 1. simulate ─────────────────────────────────────────────────────────────────────────────────
// The `simulate_block` MCP tool's path. There is no author axis here at all — a simulate has no
// saved test and no `created_by` — so the request's tenant is the ONLY defensible answer.
test('simulate resolves the fixture in the REQUEST tenant B, not the caller home tenant A', async () => {
  const outcome = await withTenantDb(TENANT_B, () =>
    simulateBlockVersion(
      { id: BLOCK_ID, slug: 'bft-load-fixture', category: 'data' },
      { id: VERSION_ID, source_ts: requireScannedSource(SOURCE), descriptor: DESCRIPTOR, status: 'draft' },
      { source: SLUG },
      USER_HOMED_A,
      TENANT_B,
    ),
  );

  // Collapse to a named outcome first — a bare `toBe('ok')` would discard the one field that
  // separates "the fixture came from the wrong tenant" from "the runner never started".
  expect(outcome.status === 'ok' ? 'ok' : `error:${JSON.stringify(outcome.error)}`).toBe('ok');

  const count = outcome.outputs?.count;
  // Both directions. `not.toBe(1)` is the half that fails against the pre-fix line: it resolved
  // `homeTenantOf(USER_HOMED_A)` = A and injected A's single row.
  expect(count).toBe(B_ROWS.length);
  expect(count).not.toBe(A_ROWS.length);

  // And the ROWS themselves are B's, not merely the right length. A fixture that happened to carry
  // three rows of A's data would satisfy the count alone.
  const rows = outcome.outputs?.rows as Array<Record<string, unknown>>;
  expect(rows.map((r) => r.id)).toEqual(['B-1', 'B-2', 'B-3']);
  expect(JSON.stringify(rows)).not.toContain('A-1');
}, 120_000);

// ── 2. run the saved suite ──────────────────────────────────────────────────────────────────────
// `runBlockTests` → `runOneBlockTest`. The seeded row has NO author, so the author axis does not
// apply and the request tenant must be used. This is the `run_block_test` MCP tool's path and the
// POST /api/blocks/:slug/versions/:v/test route's.
test('runBlockTests resolves an authorless test fixture in the REQUEST tenant B', async () => {
  const summary = await withTenantDb(TENANT_B, () =>
    runBlockTests(VERSION_ID, { ctxUserId: USER_HOMED_A, tenantId: TENANT_B }),
  );

  expect(summary.total).toBe(1);
  const result = summary.results[0]!;
  // Name the failure rather than asserting a bare 'pass' — the diffs are what say WHICH tenant
  // answered when this goes red.
  expect(
    result.status === 'pass' ? 'pass' : `${result.status}:${result.error}:${JSON.stringify(result.diffs)}`,
  ).toBe('pass');

  expect(result.actual?.count).toBe(B_ROWS.length);
  expect(result.actual?.count).not.toBe(A_ROWS.length);
  expect(summary.passed).toBe(1);
  expect(summary.testsPassing).toBe(true);

  // The rollup really was persisted — `recomputeTestsPassing` returns its value either way, so
  // reading the column back is what separates "written" from "computed and dropped".
  const [row] = await runAsSystem('platform-admin', () =>
    db
      .select({ passing: blockVersions.tests_passing })
      .from(blockVersions)
      .where(eq(blockVersions.id, VERSION_ID)),
  );
  expect(row?.passing).toBe(true);
}, 120_000);
