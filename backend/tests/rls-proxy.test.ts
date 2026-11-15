// tests/rls-proxy.test.ts — Phase D (RLS) plumbing: the `db` Proxy + per-request GUC.
//
// server.ts wraps every authenticated request in withTenantDb(), which reserves a connection, sets
// app.current_tenant, and stashes a bound drizzle in AsyncLocalStorage. The Proxy then routes plain
// statements onto that reserved connection and routes db.transaction() onto the pool with SET LOCAL.
// This path is LIVE in prod for every request but is NOT exercised by the route tests (they call
// handlers without the server wrapper), so prove it here: inside withTenantDb(T), the tenant_id
// DEFAULT (app_current_tenant_uuid()) resolves to T for both a plain insert and a transaction.
// (Runs as the owner → RLS bypassed; this asserts the GUC plumbing, not enforcement — that is
// rls-isolation.test.ts.)
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, withTenantDb, tenants, users, flows } from '../src/db/client';

const T = '00000000-0000-0000-0000-00000d160001';
const U = '00000000-0000-0000-0000-00000d16a001';
const EMPTY_GRAPH = { nodes: [], edges: [] } as never;

async function cleanup() {
  await db.delete(flows).where(eq(flows.tenant_id, T));
  await db.delete(users).where(eq(users.id, U));
  await db.delete(tenants).where(eq(tenants.id, T));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: T, name: 'Proxy Tenant', slug: 'rls-proxy-t' });
  await db.insert(users).values({ id: U, email: 'proxy@test', name: 'Proxy U', tenant_id: T });
}, 30_000);

afterAll(cleanup, 30_000);

test('plain insert inside withTenantDb fills tenant_id from the GUC default', async () => {
  const [row] = await withTenantDb(T, () =>
    db
      .insert(flows)
      .values({ name: 'proxy-plain', owner_id: U, graph: EMPTY_GRAPH }) // no tenant_id
      .returning({ id: flows.id, tenant_id: flows.tenant_id }),
  );
  expect(row!.tenant_id).toBe(T);
});

test('db.transaction() inside withTenantDb applies SET LOCAL and the GUC default resolves to T', async () => {
  const tid = await withTenantDb(T, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(flows)
        .values({ name: 'proxy-tx', owner_id: U, graph: EMPTY_GRAPH }) // no tenant_id
        .returning({ id: flows.id, tenant_id: flows.tenant_id });
      return row!.tenant_id;
    }),
  );
  expect(tid).toBe(T);
});

test('outside any request context, db falls back to the pool (no GUC, no reservation)', async () => {
  // A bare db query with no withTenantDb wrapper must still work (seed / schedulers / jobs path).
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, T));
  expect(rows.length).toBe(1);
});
