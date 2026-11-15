// tests/rls-isolation.test.ts — Phase D (RLS) headline: PROVABLE tenant isolation.
//
// The spec's headline test (Part 3.6 / Verification): with two seeded tenants A and B, connect to the
// DB AS the non-superuser runtime role `cp_app`, set app.current_tenant = A, and prove that — even with
// the application's WHERE clauses deleted — only A's rows are visible, cross-tenant writes are rejected
// by WITH CHECK, and an unset GUC fails closed to zero rows. The default test connection is the
// owner/superuser (bypasses RLS), so enforcement can only be exercised as cp_app — which this test
// arranges with SET ROLE on its own connection (see cpAppSql), leaving the role itself untouched.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import {
  db,
  tenants,
  users,
  challenges,
  flows,
  deliveryTargets,
  buildingBlocks,
  blockVersions,
} from '../src/db/client';
import { emptyDescriptor } from '../src/db/block-types';

const A = '00000000-0000-0000-0000-00000d150001';
const B = '00000000-0000-0000-0000-00000d150002';
const USER_A = '00000000-0000-0000-0000-00000d15a001';
const USER_B = '00000000-0000-0000-0000-00000d15b001';
const EMPTY_GRAPH = { nodes: [], edges: [] } as never;

// Phase 2 dual-ownership blocks: one global (tenant_id NULL) + one per tenant.
const BLK_GLOBAL = '00000000-0000-0000-0000-00000d15901a';
const BLK_A = '00000000-0000-0000-0000-00000d15a01a';
const BLK_B = '00000000-0000-0000-0000-00000d15b01a';
const VER_A = '00000000-0000-0000-0000-00000d15a01b';

/** An ordinary connection that has become `cp_app` via SET ROLE.
 *
 *  This used to CONNECT as cp_app, which meant granting the role LOGIN and a hardcoded password
 *  (`ALTER ROLE cp_app WITH LOGIN PASSWORD 'cp_app_dev'`) in beforeAll. That statement is
 *  cluster-global and outlived the test run: afterAll put the LOGIN back to NOLOGIN but never
 *  cleared the password, so every `bun test` left a known password on the one role whose entire job
 *  is to enforce RLS. Harmless on CI's ephemeral postgres:18, not harmless on a developer machine
 *  that keeps its :5433 container for weeks.
 *
 *  SET ROLE gets the same enforcement without touching the role: RLS is skipped only for the table
 *  OWNER and for BYPASSRLS roles, and SET ROLE changes `current_user`, so the policies apply exactly
 *  as they do in prod. This is the technique #143 introduced in marketplace-summary.test.ts, where
 *  it was proven to genuinely enforce (the tests there fail without it). `max: 1` matters — SET ROLE
 *  is per-session, so the pool must never hand out a second, un-roled connection. */
function cpAppSql() {
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { options: '-c role=cp_app' },
  });
  return sql;
}

let app: ReturnType<typeof postgres>;

async function cleanup() {
  // The global block has tenant_id NULL → it does not cascade from tenants; delete it explicitly.
  // Tenant blocks cascade from tenants, but delete by id first to keep the order independent.
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, [BLK_GLOBAL, BLK_A, BLK_B]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [A, B]));
  await db.delete(flows).where(inArray(flows.tenant_id, [A, B]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [A, B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  // cp_app stays exactly as migration 0028 created it — NOLOGIN, no password. See cpAppSql().
  await cleanup();
  // Seed two tenants, each with one user + one challenge + one flow (as the owner → RLS bypassed).
  await db.insert(tenants).values([
    { id: A, name: 'Tenant A', slug: 'rls-tenant-a' },
    { id: B, name: 'Tenant B', slug: 'rls-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'rls-a@test', name: 'A User', tenant_id: A },
    { id: USER_B, email: 'rls-b@test', name: 'B User', tenant_id: B },
  ]);
  await db.insert(challenges).values([
    { title: 'A challenge', work_area: 'ops', submitter_id: USER_A, tenant_id: A },
    { title: 'B challenge', work_area: 'ops', submitter_id: USER_B, tenant_id: B },
  ]);
  await db.insert(flows).values([
    { name: 'A flow', owner_id: USER_A, graph: EMPTY_GRAPH, tenant_id: A },
    { name: 'B flow', owner_id: USER_B, graph: EMPTY_GRAPH, tenant_id: B },
  ]);
  await db.insert(deliveryTargets).values([
    { kind: 'jira', name: 'A target', tenant_id: A },
    { kind: 'jira', name: 'B target', tenant_id: B },
  ]);
  // Phase 2 blocks: one platform/global (NULL) + one per tenant; A also gets a version (4d chain).
  await db.insert(buildingBlocks).values([
    { id: BLK_GLOBAL, slug: 'rls-global-blk', name: 'Global block', category: 'logic', tenant_id: null },
    { id: BLK_A, slug: 'rls-a-blk', name: 'A block', category: 'logic', tenant_id: A },
    { id: BLK_B, slug: 'rls-b-blk', name: 'B block', category: 'logic', tenant_id: B },
  ]);
  await db.insert(blockVersions).values([
    { id: VER_A, block_id: BLK_A, version: '0.1.0', status: 'draft', descriptor: emptyDescriptor() },
  ]);
  app = cpAppSql();
}, 30_000);

afterAll(async () => {
  await app?.end({ timeout: 5 });
  await cleanup();
  // Nothing to de-elevate: cp_app was never given LOGIN or a password. See cpAppSql().
}, 30_000);

async function setTenant(t: string | null) {
  await app.unsafe("select set_config('app.current_tenant', $1, false)", [t ?? '']);
}

test('cp_app with app.current_tenant = A reads ONLY A rows (challenges)', async () => {
  await setTenant(A);
  const rows = await app`SELECT id, tenant_id FROM challenges WHERE tenant_id IN (${A}, ${B})`;
  expect(rows.length).toBe(1);
  expect(rows[0]!.tenant_id).toBe(A);
});

test('a predicate-less SELECT still returns ONLY A rows (forgotten WHERE simulation)', async () => {
  await setTenant(A);
  // No tenant predicate at all — RLS is the only thing scoping this.
  const rows = await app`SELECT tenant_id FROM challenges`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.tenant_id).toBe(A);
});

test('RLS scopes a backfilled Group-3 table (flows) the same way', async () => {
  await setTenant(A);
  const rows = await app`SELECT tenant_id FROM flows`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.tenant_id).toBe(A);
});

test('WITH CHECK rejects an INSERT planting a row in another tenant', async () => {
  await setTenant(A);
  // try/catch rather than expect().rejects: bun's matcher double-consumes postgres-js's custom
  // thenable and wedges the (max:1) connection.
  let err: Error | null = null;
  try {
    await app`INSERT INTO challenges (title, work_area, submitter_id, tenant_id)
              VALUES ('forged', 'ops', ${USER_A}, ${B})`;
  } catch (e) {
    err = e as Error;
  }
  expect(err, 'cross-tenant INSERT must be rejected by RLS WITH CHECK').not.toBeNull();
  expect(err!.message).toMatch(/row-level security/i);
});

test("an UPDATE cannot touch another tenant's rows (B invisible under tenant A)", async () => {
  await setTenant(A);
  const res = await app`UPDATE challenges SET title = 'hijack' WHERE tenant_id = ${B}`;
  expect(res.count).toBe(0); // B's row is invisible → zero rows affected
});

test('an unset GUC fails closed to zero rows', async () => {
  await setTenant(null);
  const rows = await app`SELECT id FROM challenges WHERE tenant_id IN (${A}, ${B})`;
  expect(rows.length).toBe(0);
});

test('RLS scopes the Phase-5 delivery_targets table the same way (predicate-less SELECT)', async () => {
  await setTenant(A);
  const rows = await app`SELECT tenant_id FROM delivery_targets`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.tenant_id).toBe(A);
});

test('WITH CHECK rejects planting a delivery_targets row in another tenant', async () => {
  await setTenant(A);
  let err: Error | null = null;
  try {
    await app`INSERT INTO delivery_targets (kind, name, tenant_id)
              VALUES ('jira', 'forged', ${B})`;
  } catch (e) {
    err = e as Error;
  }
  expect(err, 'cross-tenant INSERT must be rejected by RLS WITH CHECK').not.toBeNull();
  expect(err!.message).toMatch(/row-level security/i);
});

// ---- Phase 2: dual-ownership building_blocks (0037 §4c) + child block_versions (§4d) ----

test('building_blocks §4c: tenant A sees the GLOBAL block + its OWN block, never tenant B', async () => {
  await setTenant(A);
  const rows = await app`SELECT slug, tenant_id FROM building_blocks
                         WHERE id IN (${BLK_GLOBAL}, ${BLK_A}, ${BLK_B})`;
  const slugs = rows.map((r) => r.slug).sort();
  expect(slugs).toEqual(['rls-a-blk', 'rls-global-blk']); // A + global, NOT B
});

test('a predicate-less building_blocks SELECT returns ONLY global ∪ A rows', async () => {
  await setTenant(A);
  const rows = await app`SELECT tenant_id FROM building_blocks`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.tenant_id === null || r.tenant_id === A).toBe(true);
  }
});

test('WITH CHECK rejects authoring a block in another tenant', async () => {
  await setTenant(A);
  let err: Error | null = null;
  try {
    await app`INSERT INTO building_blocks (slug, name, category, tenant_id)
              VALUES ('forged-blk', 'forged', 'logic', ${B})`;
  } catch (e) {
    err = e as Error;
  }
  expect(err, 'cross-tenant block INSERT must be rejected by WITH CHECK').not.toBeNull();
  expect(err!.message).toMatch(/row-level security/i);
});

test('a tenant cannot UPDATE a GLOBAL block (NULL tenant invisible to the §4c UPDATE policy)', async () => {
  await setTenant(A);
  const res = await app`UPDATE building_blocks SET name = 'hijack' WHERE id = ${BLK_GLOBAL}`;
  expect(res.count).toBe(0); // global row not in the UPDATE USING set → zero rows affected
});

test("a tenant cannot UPDATE another tenant's block", async () => {
  await setTenant(A);
  const res = await app`UPDATE building_blocks SET name = 'hijack' WHERE id = ${BLK_B}`;
  expect(res.count).toBe(0);
});

test('block_versions §4d: A sees its own block version; B (parent invisible) sees none', async () => {
  await setTenant(A);
  const a = await app`SELECT id FROM block_versions WHERE block_id = ${BLK_A}`;
  expect(a.length).toBe(1);
  await setTenant(B);
  const b = await app`SELECT id FROM block_versions WHERE block_id = ${BLK_A}`;
  expect(b.length).toBe(0); // parent A block invisible to B → version invisible via the 4d chain
});

test('an unset GUC fails closed to zero TENANT blocks (global still visible by design)', async () => {
  await setTenant(null);
  const rows = await app`SELECT tenant_id FROM building_blocks
                         WHERE id IN (${BLK_GLOBAL}, ${BLK_A}, ${BLK_B})`;
  // 4c read = (tenant_id IS NULL OR tenant_id = guc); unset guc → only the global (NULL) row.
  expect(rows.length).toBe(1);
  expect(rows[0]!.tenant_id).toBeNull();
});
