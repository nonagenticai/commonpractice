// tests/ontology.test.ts — Phase 3.2 Pillar B: the ontology matrix engine + read API.
// Drives the real seed (idempotent) against CI Postgres :5433, then exercises:
//   • GET /api/ontology/matrix — the industry × department cells for the selector;
//   • GET /api/ontology?industry=insurance&department=Claims — the COMPILED graph:
//     generic base ⊕ insurance overlay ⊕ Insurance×Claims cell, with cross-layer
//     relations (Claim→Policy, Policy→Customer) resolved and the cell sharpening Claim;
//   • seed idempotency (re-run creates nothing);
//   • the 400s for missing query params.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerOntologyRoutes } from '../src/routes/ontology';
import { seedOntology } from '../src/db/seed-ontology';
import { db, ontologyEntities } from '../src/db/client';
import { sql } from 'drizzle-orm';
import type { User } from '../src/types';
import type { CompiledOntology, MatrixData } from '../src/ontology/ontology-service';

const UID = '00000000-0000-0000-0000-00000c200001';
const user: User = { id: UID, email: 'ontotest@test', name: 'Otto Tester', roles: ['super_admin'], tenantId: UID };

const router = new Router();
registerOntologyRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology(); // idempotent — guarantees the global ontology is present.
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
}, 30_000);
afterAll(() => __setAuthOverridesForTests(undefined));

test('GET /api/ontology/matrix returns the seeded industries × departments', async () => {
  const { status, json } = await call('GET', '/api/ontology/matrix');
  expect(status).toBe(200);
  const matrix = json as MatrixData;
  expect(matrix.industries).toEqual(expect.arrayContaining(['insurance', 'banking', 'healthcare']));
  expect(matrix.departments).toEqual(expect.arrayContaining(['Claims', 'Marketing', 'Sales', 'Finance']));
  // The Insurance × Claims cell is a real specialization; Banking × Claims is not.
  const insClaims = matrix.cells.find((c) => c.industry === 'insurance' && c.department === 'Claims');
  expect(insClaims?.hasSpecialization).toBe(true);
  const bankClaims = matrix.cells.find((c) => c.industry === 'banking' && c.department === 'Claims');
  expect(bankClaims?.hasSpecialization).toBe(false);
}, 30_000);

test('GET /api/ontology compiles insurance × Claims (overlay ⊕ cell ⊕ expansion)', async () => {
  const { status, json } = await call('GET', '/api/ontology?industry=insurance&department=Claims');
  expect(status).toBe(200);
  const graph = json as CompiledOntology;
  const names = graph.entities.map((e) => e.name);

  // Overlay entities + the generic Customer pulled in via the Policy→Customer edge.
  expect(names).toEqual(expect.arrayContaining(['Claim', 'Policy', 'Coverage', 'Adjuster', 'Customer']));

  const claim = graph.entities.find((e) => e.name === 'Claim')!;
  // The Insurance × Claims cell sharpens Claim → it wins the merge (highest layer).
  expect(claim.scope).toBe('industry_dept');
  const attrNames = claim.attributes.map((a) => a.name);
  expect(attrNames).toEqual(expect.arrayContaining(['amount', 'fraud_score', 'settlement_amount']));
  // Overlay synonyms survive the merge — the clm_amt alias is the 3.3 mapping hook.
  const amount = claim.attributes.find((a) => a.name === 'amount')!;
  expect(amount.synonyms).toEqual(expect.arrayContaining(['clm_amt']));

  // Customer arrives via one-hop expansion and keeps its generic scope.
  const customer = graph.entities.find((e) => e.name === 'Customer')!;
  expect(customer.scope).toBe('generic');

  // Cross-layer relations resolved to in-graph entity names.
  const hasUnder = graph.relations.some((r) => r.from === 'Claim' && r.to === 'Policy' && r.predicate === 'under');
  const hasHeldBy = graph.relations.some((r) => r.from === 'Policy' && r.to === 'Customer' && r.predicate === 'heldBy');
  expect(hasUnder).toBe(true);
  expect(hasHeldBy).toBe(true);
}, 30_000);

test('seedOntology is idempotent (re-run creates nothing, row count stable)', async () => {
  const [before] = await db.select({ n: sql<number>`count(*)::int` }).from(ontologyEntities);
  const result = await seedOntology();
  const [after] = await db.select({ n: sql<number>`count(*)::int` }).from(ontologyEntities);
  expect(result).toEqual({ entities: 0, attributes: 0, relations: 0 });
  expect(after!.n).toBe(before!.n);
}, 30_000);

test('GET /api/ontology requires industry + department', async () => {
  expect((await call('GET', '/api/ontology?industry=insurance')).status).toBe(400);
  expect((await call('GET', '/api/ontology?department=Claims')).status).toBe(400);
}, 30_000);
