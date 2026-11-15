// tests/blocks-tenant-author.test.ts — Phase 2 dual-ownership block authoring (0037).
//
// Route-level coverage for the scope-aware authoring path: a developer authors a TENANT block
// (tenant_id stamped, owner='tenant'); a super_admin authors a GLOBAL/platform block (tenant_id NULL,
// owner='global'); a tenant block may not reuse a platform slug (slug_reserved_global); a developer
// cannot mutate a platform block (super_admin_required) nor another tenant's block (block_not_found).
//
// These run against the owner connection (RLS bypassed in dev/test — provable isolation lives in
// rls-isolation.test.ts); here we assert the APPLICATION-layer ownership/authorization logic. Auth is
// installed through the __setAuthOverridesForTests seam (house rule — no mock.module).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { seed } from '../src/db/seed';
import { db, buildingBlocks, blockVersions, tenants, users } from '../src/db/client';
import type { User } from '../src/types';

const TENANT_A = '00000000-0000-0000-0000-00000b10a001';
const TENANT_B = '00000000-0000-0000-0000-00000b10b001';
const BLK_B = '00000000-0000-0000-0000-00000b10b01a';
const AUTHORED_SLUGS = [
  'ta-tenant-blk',
  'ta-global-blk',
  'ta-foreign-blk',
  'ta-del-global',
  'ta-del-tenant',
];

const superAdmin: User = {
  id: '00000000-0000-0000-0000-00000b100aaa',
  email: 'sa@test',
  name: 'Super',
  roles: ['super_admin'],
};
const developerA: User = {
  id: '00000000-0000-0000-0000-00000b100ddd',
  email: 'dev-a@test',
  name: 'Dev A',
  roles: ['developer'],
  tenantId: TENANT_A,
};

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerBlockRoutes(router);

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
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, AUTHORED_SLUGS));
  await db.delete(buildingBlocks).where(eq(buildingBlocks.id, BLK_B));
  await db.delete(users).where(inArray(users.id, [superAdmin.id, developerA.id]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seed(); // idempotent — the 12 demo blocks exist and are GLOBAL (tenant_id NULL)
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Author Tenant A', slug: 'ta-tenant-a' },
    { id: TENANT_B, name: 'Author Tenant B', slug: 'ta-tenant-b' },
  ]);
  // The actors must exist so recordAudit's actor_id FK is satisfied (delete/create write an
  // audit row). cleanup() already removes them.
  await db.insert(users).values([
    { id: superAdmin.id, email: superAdmin.email, name: superAdmin.name },
    { id: developerA.id, email: developerA.email, name: developerA.name, tenant_id: TENANT_A },
  ]).onConflictDoNothing();
  // A block owned by tenant B — used to prove a developer of A cannot touch it.
  await db.insert(buildingBlocks).values([
    { id: BLK_B, slug: 'ta-foreign-blk', name: 'B block', category: 'logic', tenant_id: TENANT_B },
  ]);
}, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

test('a developer authors a TENANT block (tenant_id stamped, owner=tenant)', async () => {
  asUser(developerA);
  const { status, json } = await call('POST', '/api/blocks', {
    slug: 'ta-tenant-blk',
    name: 'Tenant Block',
    category: 'logic',
  });
  expect(status).toBe(201);
  expect(json.owner).toBe('tenant');
  expect(json.block.tenant_id).toBe(TENANT_A);
  expect(json.version.version).toBe('0.1.0');
}, 30_000);

test('the tenant block + the seeded globals both list, tagged by owner', async () => {
  asUser(developerA);
  const { json } = await call('GET', '/api/blocks');
  const mine = json.items.find((i: any) => i.slug === 'ta-tenant-blk');
  const seeded = json.items.find((i: any) => i.slug === 'read-claim-form');
  expect(mine?.owner).toBe('tenant');
  expect(seeded?.owner).toBe('global');
});

test('a tenant block cannot reuse a platform/global slug (slug_reserved_global)', async () => {
  asUser(developerA);
  const { status, json } = await call('POST', '/api/blocks', {
    slug: 'read-claim-form', // a seeded global block
    name: 'Shadow',
    category: 'logic',
  });
  expect(status).toBe(409);
  expect(json.error).toBe('slug_reserved_global');
  // The refused slug must be a NAMED field, not only interpolated into the English sentence.
  expect(json.details.slug).toBe('read-claim-form');
});

test('a super_admin authors a GLOBAL block (tenant_id NULL, owner=global)', async () => {
  asUser(superAdmin);
  const { status, json } = await call('POST', '/api/blocks', {
    slug: 'ta-global-blk',
    name: 'Global Block',
    category: 'logic',
  });
  expect(status).toBe(201);
  expect(json.owner).toBe('global');
  expect(json.block.tenant_id).toBeNull();
});

test('a developer cannot author into a platform (global) block', async () => {
  asUser(developerA);
  const { status, json } = await call('POST', '/api/blocks/read-claim-form/versions', {});
  expect(status).toBe(403);
  expect(json.error).toBe('super_admin_required');
});

test("a developer cannot author into another tenant's block (block_not_found)", async () => {
  asUser(developerA);
  const { status, json } = await call('POST', '/api/blocks/ta-foreign-blk/versions', {});
  expect(status).toBe(404);
  expect(json.error).toBe('block_not_found');
});

// ---- DELETE /api/blocks/:slug (provenance-preserving archive path) ----

test('a super_admin archives a GLOBAL block and preserves its pinned versions', async () => {
  asUser(superAdmin);
  const created = await call('POST', '/api/blocks', {
    slug: 'ta-del-global',
    name: 'Deletable Global',
    category: 'logic',
  });
  expect(created.status).toBe(201);
  const blockId = created.json.block.id as string;
  // The create path stamps an initial draft version — it must remain addressable for
  // already-published solution manifests after the parent is archived.
  const before = await db.select().from(blockVersions).where(eq(blockVersions.block_id, blockId));
  expect(before.length).toBeGreaterThan(0);

  const { status, json } = await call('DELETE', '/api/blocks/ta-del-global');
  expect(status).toBe(200);
  expect(json.archived).toBe(true);

  const blockRows = await db.select().from(buildingBlocks).where(eq(buildingBlocks.id, blockId));
  expect(blockRows).toHaveLength(1);
  expect(blockRows[0]!.archived).toBe(true);
  const verRows = await db.select().from(blockVersions).where(eq(blockVersions.block_id, blockId));
  expect(verRows.length).toBe(before.length);
});

test('a developer archives their own TENANT block', async () => {
  asUser(developerA);
  const created = await call('POST', '/api/blocks', {
    slug: 'ta-del-tenant',
    name: 'Deletable Tenant',
    category: 'logic',
  });
  expect(created.status).toBe(201);

  const { status, json } = await call('DELETE', '/api/blocks/ta-del-tenant');
  expect(status).toBe(200);
  expect(json.archived).toBe(true);

  asUser(superAdmin);
  const { status: getStatus, json: detail } = await call('GET', '/api/blocks/ta-del-tenant');
  expect(getStatus).toBe(200);
  expect(detail.archived).toBe(true);
});

test('a developer cannot delete a platform (global) block', async () => {
  asUser(developerA);
  const { status, json } = await call('DELETE', '/api/blocks/read-claim-form'); // seeded global
  expect(status).toBe(403);
  expect(json.error).toBe('super_admin_required');
});

test("a developer cannot delete another tenant's block (block_not_found)", async () => {
  asUser(developerA);
  const { status, json } = await call('DELETE', '/api/blocks/ta-foreign-blk');
  expect(status).toBe(404);
  expect(json.error).toBe('block_not_found');
});

test('deleting a missing slug → 404', async () => {
  asUser(superAdmin);
  const { status } = await call('DELETE', '/api/blocks/does-not-exist');
  expect(status).toBe(404);
});
