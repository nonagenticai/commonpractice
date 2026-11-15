// tests/ontology-tombstone-expansion.test.ts — Phase 3.7 tombstone, the relation-expansion case.
//
// ontology-tombstone.test.ts only ever hides `Adjuster`: an insurance-overlay entity whose natural
// key (scope=industry, industry=insurance) is matched by the SAME `layered` predicate the viewed
// cell uses, so its tombstone is guaranteed to be fetched back. That is the easy half.
//
// The other half is an entity that reaches the cell through the deliberate ONE-HOP RELATION
// EXPANSION (ontology-service.ts :337): insurance `Policy —heldBy→ Customer`, where Customer is
// generic/Service. Viewed from (insurance, Claims), Customer is NOT in `layered` — the expansion
// pulls it in BY RAW GLOBAL ID. A tombstone copies the global's natural key (generic/·/Service),
// which no predicate of the (insurance, Claims) compile selects, so the hide used to be a 200 + an
// audit row that changed nothing on screen.
//
// These tests assert the REAL READ PATH (`GET /api/ontology`), never the tombstone row: a test that
// checked only "the INSERT happened" passed before the fix.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { seedOntology } from '../src/db/seed-ontology';
import { db, users, tenants, ontologyEntities, ontologyRelations } from '../src/db/client';
import type { User } from '../src/types';
import type { CompiledOntology } from '../src/ontology/ontology-service';

const ORG = '00000000-0000-0000-0000-00000d400001';
const OTHER = '00000000-0000-0000-0000-00000d400002';
const ADMIN_ID = '00000000-0000-0000-0000-00000d40ad01';
const OUTSIDER_ID = '00000000-0000-0000-0000-00000d40cf01';
const admin: User = { id: ADMIN_ID, email: 'exp-admin@test', name: 'Ada Admin', roles: ['employee', 'tenant_admin'], tenantId: ORG };
const outsider: User = { id: OUTSIDER_ID, email: 'exp-outsider@test', name: 'Otto Outsider', roles: ['employee', 'tenant_admin'], tenantId: OTHER };

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

/** The viewed cell: insurance/Claims. `Customer` is generic/Service — it is only here at all
 *  because Policy —heldBy→ Customer expands one hop. */
const cell = async (u: User): Promise<CompiledOntology & { canManage: boolean }> => {
  asUser(u);
  const r = await call('GET', '/api/ontology?industry=insurance&department=Claims');
  return r.json;
};

async function cleanup() {
  await db.delete(ontologyRelations).where(inArray(ontologyRelations.tenant_id, [ORG, OTHER]));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID, OUTSIDER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await seedOntology();
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Acme Exp', slug: 'acme-exp-tomb', industry: 'insurance' },
    { id: OTHER, name: 'Other Exp', slug: 'other-exp-tomb', industry: 'insurance' },
  ]);
  await db.insert(users).values([
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: ORG },
    { id: OUTSIDER_ID, email: outsider.email, name: outsider.name, tenant_id: OTHER },
  ]);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the cell reaches Customer ONLY through the one-hop expansion (the premise)', async () => {
  const view = await cell(admin);
  const customer = view.entities.find((e) => e.name === 'Customer');
  expect(customer).toBeTruthy();
  // generic/Service — the (insurance, Claims) `layered` predicate cannot select this key.
  expect(customer!.scope).toBe('generic');
  expect(customer!.key).toBe('generic::Service:Customer');
  // …and it is here because an edge leaving the layered set points at it.
  expect(view.relations.some((r) => r.to === 'Customer')).toBe(true);
});

test('hiding an expansion-reached global entity removes it from the real read path', async () => {
  const before = await cell(admin);
  const customer = before.entities.find((e) => e.name === 'Customer')!;
  expect(customer.tenantOwned).toBe(false);

  asUser(admin);
  const hid = await call('POST', `/api/ontology/entities/${customer.id}/hide`);
  expect(hid.status).toBe(200);

  const after = await cell(admin);
  // THE DEFECT: this used to still contain Customer, with an empty hidden[].
  expect(after.entities.some((e) => e.name === 'Customer')).toBe(false);
  expect(after.relations.some((r) => r.from === 'Customer' || r.to === 'Customer')).toBe(false);
  // …and the unhide affordance the UI keys off must be present, carrying the GLOBAL id.
  const tomb = after.hidden.find((h) => h.name === 'Customer')!;
  expect(tomb).toBeTruthy();
  expect(tomb.id).toBe(customer.id);
});

test('the hide holds in the entity\'s OWN cell too (generic/Service, insurance)', async () => {
  asUser(admin);
  const own = (await call('GET', '/api/ontology?industry=insurance&department=Service')).json as CompiledOntology;
  expect(own.entities.some((e) => e.name === 'Customer')).toBe(false);
  expect(own.hidden.some((h) => h.name === 'Customer')).toBe(true);
});

test('another org still sees the expansion-reached entity (isolation)', async () => {
  const otherView = await cell(outsider);
  expect(otherView.entities.some((e) => e.name === 'Customer')).toBe(true);
  expect(otherView.hidden.length).toBe(0);
});

test('unhide restores the expansion-reached entity', async () => {
  const view = await cell(admin);
  const tomb = view.hidden.find((h) => h.name === 'Customer')!;
  asUser(admin);
  const un = await call('POST', `/api/ontology/entities/${tomb.id}/unhide`);
  expect(un.status).toBe(200);

  const after = await cell(admin);
  expect(after.entities.some((e) => e.name === 'Customer')).toBe(true);
  expect(after.relations.some((r) => r.to === 'Customer')).toBe(true);
  expect(after.hidden.some((h) => h.name === 'Customer')).toBe(false);
});

test('an entity the cell reaches directly is unaffected (no regression on the easy half)', async () => {
  const before = await cell(admin);
  const adjuster = before.entities.find((e) => e.name === 'Adjuster')!;
  expect(adjuster).toBeTruthy();

  asUser(admin);
  expect((await call('POST', `/api/ontology/entities/${adjuster.id}/hide`)).status).toBe(200);
  const after = await cell(admin);
  expect(after.entities.some((e) => e.name === 'Adjuster')).toBe(false);
  expect(after.hidden.some((h) => h.name === 'Adjuster')).toBe(true);

  expect((await call('POST', `/api/ontology/entities/${adjuster.id}/unhide`)).status).toBe(200);
  expect((await cell(admin)).entities.some((e) => e.name === 'Adjuster')).toBe(true);
});
