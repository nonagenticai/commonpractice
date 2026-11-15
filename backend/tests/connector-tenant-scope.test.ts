// tests/connector-tenant-scope.test.ts — Phase 3.5 (SPEC §5): live connectors are a
// tenant-shared, governance-gated resource — the 3.6 datasets model applied to connectors.
// Proves over real CI Postgres :5433 (no live refresh needed — the admin gate runs before
// any connection, and reads are exercised against a directly-seeded connector row):
//   (a) a MEMBER of the org browses the org's connectors (canManage=false) but CANNOT
//       create one (403, before any egress);
//   (b) a DIFFERENT org does not see them (cross-tenant isolation).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { db, users, tenants, datasets, datasetRows } from '../src/db/client';
import type { User } from '../src/types';

const ORG = '00000000-0000-0000-0000-00000d000001';
const OTHER = '00000000-0000-0000-0000-00000d000002';
const ADMIN_ID = '00000000-0000-0000-0000-00000d00ad01'; // tenant_admin of ORG
const MEMBER_ID = '00000000-0000-0000-0000-00000d00be01'; // member of ORG
const OUTSIDER_ID = '00000000-0000-0000-0000-00000d00cf01'; // tenant_admin of OTHER
const admin: User = { id: ADMIN_ID, email: 'conn-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'conn-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'conn-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };
const CONNECTOR_SLUG = 'org-live-source';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerConnectorRoutes(router);

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

async function cleanup() {
  const ds = await db.select({ id: datasets.id }).from(datasets).where(inArray(datasets.tenant_id, [ORG, OTHER]));
  for (const d of ds) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(inArray(datasets.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID, MEMBER_ID, OUTSIDER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Org', slug: 'acme-conn' },
    { id: OTHER, name: 'Other Org', slug: 'other-conn' },
  ]);
  await db.insert(users).values([
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: ORG },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: OUTSIDER_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
  // A connector the admin (IT) provisioned, materialized into the org's shared pool. We
  // insert it directly to avoid a live refresh — the route behaviour under test is scoping.
  await db.insert(datasets).values({
    owner_id: ADMIN_ID,
    tenant_id: ORG,
    name: 'Org Live Source',
    slug: CONNECTOR_SLUG,
    source_type: 'http',
    columns: [{ name: 'a', type: 'number' }],
    row_count: 1,
    size_bytes: 16,
    status: 'ready',
    event_source: 'none',
  });
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('a member browses the org connectors (canManage=false) but cannot create one (403)', async () => {
  asUser(member);
  const list = await call('GET', '/api/connectors');
  expect(list.status).toBe(200);
  expect(list.json.canManage).toBe(false);
  expect(list.json.items.some((c: { slug: string }) => c.slug === CONNECTOR_SLUG)).toBe(true);
  // Shared read by slug works for the member.
  expect((await call('GET', `/api/connectors/${CONNECTOR_SLUG}`)).status).toBe(200);

  // …but creating a live connector is admin-only — the 403 precedes any egress/connection.
  const denied = await call('POST', '/api/connectors', {
    name: 'Sneaky', sourceType: 'http', config: { url: 'https://example.com/x.json' },
  });
  expect(denied.status).toBe(403);
});

test('a different org does not see the connector (cross-tenant isolation)', async () => {
  asUser(outsider);
  const list = await call('GET', '/api/connectors');
  expect(list.json.items.some((c: { slug: string }) => c.slug === CONNECTOR_SLUG)).toBe(false);
  expect((await call('GET', `/api/connectors/${CONNECTOR_SLUG}`)).status).toBe(404);
});

test('an admin sees canManage=true', async () => {
  asUser(admin);
  const list = await call('GET', '/api/connectors');
  expect(list.json.canManage).toBe(true);
});
