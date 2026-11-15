// tests/tenant-data-scope.test.ts — Phase 3.6 (Pillar A rework): test data is a shared,
// org-level resource. Proves the model end-to-end over real CI Postgres :5433:
//   (a) IT (a tenant_admin) uploads a dataset → it lands in the org's tenant;
//   (b) a regular MEMBER of that org browses it (canManage=false) but CANNOT create one (403);
//   (c) a user in a DIFFERENT org does NOT see it (cross-tenant isolation);
//   (d) the MEMBER can raise a challenge tagging the admin's dataset it does NOT own, and
//       the challenge resolves it within the org.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { db, users, tenants, datasets, datasetRows, challenges, challengeDatasets } from '../src/db/client';
import type { User } from '../src/types';

// Org tenants (the scope axis) and the people in them. Tenancy is the `tenant_id` claim;
// role is the realm role (Phase 4 / C.1) — tenant_admin via the realm role, member via none.
const ORG = '00000000-0000-0000-0000-00000a000001'; // the shared org
const OTHER = '00000000-0000-0000-0000-00000a000002'; // a different org
const ADMIN_ID = '00000000-0000-0000-0000-00000a00ad01'; // IT — tenant_admin of ORG
const MEMBER_ID = '00000000-0000-0000-0000-00000a00be01'; // employee — member of ORG (challenge creator)
const OUTSIDER_ID = '00000000-0000-0000-0000-00000a00cf01'; // tenant_admin of OTHER
const admin: User = { id: ADMIN_ID, email: 'org-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'org-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'org-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };
const MARK = 'ZTDSCOPE';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerDatasetRoutes(router);
registerChallengeRoutes(router);

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
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(inArray(challenges.tenant_id, [ORG, OTHER]))).map((r) => r.id);
  if (ids.length) {
    await db.delete(challengeDatasets).where(inArray(challengeDatasets.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
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
    { id: ORG, name: 'Acme Org', slug: `acme-${MARK.toLowerCase()}` },
    { id: OTHER, name: 'Other Org', slug: `other-${MARK.toLowerCase()}` },
  ]);
  // Home tenant pre-set (so ensureUser's "set if null" is a no-op). Role comes from the
  // realm roles on the User fixture above, not a membership row.
  await db.insert(users).values([
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: ORG },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ORG },
    { id: OUTSIDER_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

let orgSlug = '';

test('IT (tenant_admin) uploads a dataset → it lands in the org tenant', async () => {
  asUser(admin);
  const r = await call('POST', '/api/datasets', {
    name: `${MARK} Org Claims`,
    sourceType: 'json',
    content: JSON.stringify([{ clm_amt: 2500 }, { clm_amt: 800 }]),
  });
  expect(r.status).toBe(201);
  orgSlug = r.json.slug;
  const [row] = await db.select({ tenant: datasets.tenant_id, owner: datasets.owner_id }).from(datasets).where(eq(datasets.slug, orgSlug));
  expect(row!.tenant).toBe(ORG); // scoped to the org…
  expect(row!.owner).toBe(ADMIN_ID); // …with the uploader recorded as owner (audit)
});

test('a MEMBER of the org browses the IT-owned data but cannot create it', async () => {
  asUser(member);
  const list = await call('GET', '/api/datasets');
  expect(list.status).toBe(200);
  expect(list.json.canManage).toBe(false); // members browse, IT manages
  expect(list.json.items.some((d: { slug: string }) => d.slug === orgSlug)).toBe(true);
  // GET by slug also resolves for the member (shared read).
  const get = await call('GET', `/api/datasets/${orgSlug}`);
  expect(get.status).toBe(200);

  // …but a member may not add/delete test data.
  const create = await call('POST', '/api/datasets', {
    name: `${MARK} Sneaky`,
    sourceType: 'json',
    content: JSON.stringify([{ a: 1 }]),
  });
  expect(create.status).toBe(403);
  const del = await call('DELETE', `/api/datasets/${orgSlug}`);
  expect(del.status).toBe(403);
});

test('a user in a DIFFERENT org does not see the data (cross-tenant isolation)', async () => {
  asUser(outsider);
  const list = await call('GET', '/api/datasets');
  expect(list.json.items.some((d: { slug: string }) => d.slug === orgSlug)).toBe(false);
  const get = await call('GET', `/api/datasets/${orgSlug}`);
  expect(get.status).toBe(404);
});

test('a member can raise a challenge tagging IT-owned data it does not own', async () => {
  asUser(member);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} flag big claims`,
    description: 'flag claims over the threshold',
    work_area: 'Claims',
    datasets: [{ slug: orgSlug, note: 'amount matters' }],
  });
  expect(created.status).toBe(201);
  const detail = await call('GET', `/api/challenges/${created.json.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.datasets).toHaveLength(1);
  expect(detail.json.datasets[0].slug).toBe(orgSlug);
  expect(detail.json.canEditDatasets).toBe(true); // the creator may edit the tagged set

  // An outsider tagging the same slug from THEIR org fails (it isn't in their tenant).
  asUser(outsider);
  const bad = await call('POST', '/api/challenges', {
    title: `${MARK} cross-org`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: orgSlug }],
  });
  expect(bad.status).toBe(400);
});
