// tests/ontology-tombstone.test.ts — Phase 3.7: per-tenant tombstoning of a GLOBAL entity.
// Proves over real CI Postgres :5433:
//   (a) an org admin hides a global entity → it leaves that org's compiled graph (and its
//       relations) and is listed in `hidden[]` carrying the GLOBAL id;
//   (b) a different org still sees it (isolation);
//   (c) unhide restores it (idempotent);
//   (d) a member cannot hide (403); hiding a non-global / unknown id is rejected.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { seedOntology } from '../src/db/seed-ontology';
import { db, users, tenants, ontologyEntities, ontologyRelations } from '../src/db/client';
import type { User } from '../src/types';
import type { CompiledOntology } from '../src/ontology/ontology-service';

const ORG = '00000000-0000-0000-0000-00000c000001';
const OTHER = '00000000-0000-0000-0000-00000c000002';
const ADMIN_ID = '00000000-0000-0000-0000-00000c00ad01';
const MEMBER_ID = '00000000-0000-0000-0000-00000c00be01';
const OUTSIDER_ID = '00000000-0000-0000-0000-00000c00cf01';
const admin: User = { id: ADMIN_ID, email: 'tomb-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const member: User = { id: MEMBER_ID, email: 'tomb-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'tomb-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };

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

const cell = async (u: User): Promise<CompiledOntology & { canManage: boolean }> => {
  asUser(u);
  const r = await call('GET', '/api/ontology?industry=insurance&department=Claims');
  return r.json;
};

async function cleanup() {
  await db.delete(ontologyRelations).where(inArray(ontologyRelations.tenant_id, [ORG, OTHER]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID, MEMBER_ID, OUTSIDER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology();
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Ins', slug: 'acme-ins-tomb', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'other-ins-tomb', industry: 'insurance' },
  ]);
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

test('admin hides a global entity → it leaves the graph + relations and is listed in hidden[]', async () => {
  // Adjuster is a global insurance-overlay entity; Claim —assignedTo→ Adjuster is an edge.
  const before = await cell(admin);
  const adjuster = before.entities.find((e) => e.name === 'Adjuster')!;
  expect(adjuster).toBeTruthy();
  expect(adjuster.tenantOwned).toBe(false);
  expect(before.relations.some((r) => r.to === 'Adjuster')).toBe(true);

  asUser(admin);
  const hid = await call('POST', `/api/ontology/entities/${adjuster.id}/hide`);
  expect(hid.status).toBe(200);

  const after = await cell(admin);
  expect(after.entities.some((e) => e.name === 'Adjuster')).toBe(false);
  expect(after.relations.some((r) => r.from === 'Adjuster' || r.to === 'Adjuster')).toBe(false);
  const tomb = after.hidden.find((h) => h.name === 'Adjuster')!;
  expect(tomb).toBeTruthy();
  expect(tomb.id).toBe(adjuster.id); // the GLOBAL id, so unhide can target it
});

test('a different org still sees the hidden entity (isolation)', async () => {
  const otherView = await cell(outsider);
  expect(otherView.entities.some((e) => e.name === 'Adjuster')).toBe(true);
  expect(otherView.hidden.length).toBe(0);
});

test('unhide restores the entity (idempotent)', async () => {
  const view = await cell(admin);
  const tomb = view.hidden.find((h) => h.name === 'Adjuster')!;
  asUser(admin);
  const un = await call('POST', `/api/ontology/entities/${tomb.id}/unhide`);
  expect(un.status).toBe(200);
  // Second unhide is a harmless no-op.
  const un2 = await call('POST', `/api/ontology/entities/${tomb.id}/unhide`);
  expect(un2.status).toBe(200);

  const after = await cell(admin);
  expect(after.entities.some((e) => e.name === 'Adjuster')).toBe(true);
  expect(after.hidden.length).toBe(0);
});

test('a member cannot hide (403); non-global → 400; unknown → 404', async () => {
  const view = await cell(admin);
  const adjuster = view.entities.find((e) => e.name === 'Adjuster')!;

  asUser(member);
  const denied = await call('POST', `/api/ontology/entities/${adjuster.id}/hide`);
  expect(denied.status).toBe(403);

  // A tenant-owned (custom) entity cannot be "hidden" — it is deleted instead → 400.
  asUser(admin);
  const created = await call('POST', '/api/ontology/entities', {
    scope: 'industry_dept', industry: 'insurance', department: 'Claims', name: 'ZZTomb', label: 'ZZ Tomb',
  });
  const notGlobal = await call('POST', `/api/ontology/entities/${created.json.id}/hide`);
  expect(notGlobal.status).toBe(400);

  const unknown = await call('POST', `/api/ontology/entities/${OTHER}/hide`);
  expect(unknown.status).toBe(404);
});
