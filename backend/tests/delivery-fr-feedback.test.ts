// tests/delivery-fr-feedback.test.ts — Phase 5.1: POST /api/delivery/fr-feedback (inbound).
// fr's portal SA (delivery-feedback-writer) tells CP a forwarded draft was promoted. Drives the
// real router; auth faked via __setAuthOverridesForTests (the SA token is claim-only — no users
// row). Proves: 401 (no token) / 403 (no role); draft_created → promoted (fr_project_id + url
// stamped); idempotent re-post → 200; unknown ref → 404; cp_solution_id mismatch → 409; a row in
// another tenant is invisible (404) — the app-layer tenant predicate (RLS is the prod backstop).
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { inArray, eq } from 'drizzle-orm';
import {
  db,
  deliveryTargets,
  solutionDeliveries,
  solutions,
  challenges,
  tenants,
  users,
} from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerDeliveryRoutes } from '../src/routes/delivery';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { config } from '../src/config';

// Valid v4-format uuids (zod .uuid() enforces the version/variant nibbles — and real CP
// tenant/solution ids are gen_random_uuid() v4, so the body schema's .uuid() is exercised faithfully).
const A = '00000000-0000-4000-8000-000051000001';
const B = '00000000-0000-4000-8000-000051000002';
const USER_A = '00000000-0000-4000-8000-0000510a0001';
const USER_B = '00000000-0000-4000-8000-0000510b0001';
const CH_A = '00000000-0000-4000-8000-0000510c0001';
const CH_B = '00000000-0000-4000-8000-0000510c0002';
const SOL_A = '00000000-0000-4000-8000-0000510d0001';
const SOL_B = '00000000-0000-4000-8000-0000510d0002';
const OTHER_SOL = '00000000-0000-4000-8000-0000510d0099';
// The fr-backend service-account subject (no CP users row — claim-only auth).
const SA_ID = '00000000-0000-4000-8000-0000510f5acc';

function saUser(roles: string[], over: Partial<User> = {}): User {
  // issuer + azp: the door pins both (realm-per-app P7, middleware/fr-feedback-auth.ts).
  return { id: SA_ID, email: '', name: '', roles, tenantId: undefined, issuer: config.keycloak.issuer, azp: 'fr-backend', ...over };
}
function asWriter() {
  __setAuthOverridesForTests({ validateAuth: async () => saUser(['delivery-feedback-writer']) });
}
function asNoRole() {
  __setAuthOverridesForTests({ validateAuth: async () => saUser(['member']) });
}
function asUnauth() {
  __setAuthOverridesForTests({
    validateAuth: async () => {
      throw new UnauthorizedError('missing token');
    },
  });
}

const router = new Router();
registerDeliveryRoutes(router);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path)!;
  const req = new Request(`http://t${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return m.handler(req, ...m.params);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jbody(res: Response): Promise<any> {
  return res.json();
}

const PAYLOAD = {
  title: 't', summary: 's', problem: 'p', outcome: 'o',
  acceptance_criteria: [], deliverables: [], requirements: [], data_access: [], labels: [],
  needs_human: [],
  provenance: { cp_solution_id: SOL_A, cp_challenge_id: CH_A, cp_flow_id: null, cp_tenant_id: A, initiated_by: USER_A, votes_count: 0, flow_chain: [], blocks_used: [], datasets: [], ontology_entities: [] },
};

async function seedFrDelivery(tenant: string, solutionId: string, ref: string, initiatedBy: string) {
  const [row] = await db
    .insert(solutionDeliveries)
    .values({
      tenant_id: tenant,
      solution_id: solutionId,
      target_id: null,
      target_kind: 'fr',
      initiated_by: initiatedBy,
      status: 'draft_created',
      external_ref: ref,
      external_url: `https://fr.example.com/projects/requests/${ref}`,
      payload: PAYLOAD,
    })
    .returning();
  return row!;
}

async function cleanupDeliveries() {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [A, B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanupDeliveries();
  await db.delete(solutions).where(inArray(solutions.tenant_id, [A, B]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [A, B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
  await db.insert(tenants).values([
    { id: A, name: 'FB Tenant A', slug: 'fb-tenant-a' },
    { id: B, name: 'FB Tenant B', slug: 'fb-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'fba@test', name: 'A', tenant_id: A },
    { id: USER_B, email: 'fbb@test', name: 'B', tenant_id: B },
  ]);
  await db.insert(challenges).values([
    { id: CH_A, title: 'C-A', description: 'd', business_impact: 'b', work_area: 'w', metrics: {}, tags: [], submitter_id: USER_A, tenant_id: A },
    { id: CH_B, title: 'C-B', description: 'd', business_impact: 'b', work_area: 'w', metrics: {}, tags: [], submitter_id: USER_B, tenant_id: B },
  ]);
  await db.insert(solutions).values([
    { id: SOL_A, challenge_id: CH_A, title: 'S-A', author_id: USER_A, blocks_used: [], tenant_id: A },
    { id: OTHER_SOL, challenge_id: CH_A, title: 'S-A2', author_id: USER_A, blocks_used: [], tenant_id: A },
    { id: SOL_B, challenge_id: CH_B, title: 'S-B', author_id: USER_B, blocks_used: [], tenant_id: B },
  ]);
}, 30_000);

beforeEach(async () => {
  await cleanupDeliveries();
  asWriter();
}, 30_000);

afterAll(async () => {
  await cleanupDeliveries();
  await db.delete(solutions).where(inArray(solutions.tenant_id, [A, B]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [A, B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
  __setAuthOverridesForTests(undefined);
}, 30_000);

const FEEDBACK = '/api/delivery/fr-feedback';

test('no token → 401, row unchanged', async () => {
  await seedFrDelivery(A, SOL_A, 'pr-401', USER_A);
  asUnauth();
  const res = await call('POST', FEEDBACK, { project_request_id: 'pr-401', fr_project_id: 'frp', tenant_id: A });
  expect(res.status).toBe(401);
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-401'));
  expect(row!.status).toBe('draft_created');
});

test('valid token without the role → 403, row unchanged', async () => {
  await seedFrDelivery(A, SOL_A, 'pr-403', USER_A);
  asNoRole();
  const res = await call('POST', FEEDBACK, { project_request_id: 'pr-403', fr_project_id: 'frp', tenant_id: A });
  expect(res.status).toBe(403);
  expect((await jbody(res)).error).toBe('fr_feedback_forbidden');
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-403'));
  expect(row!.status).toBe('draft_created');
});

// Realm-per-app P7 chain C: the door pins a LIST of issuers (FR_FEEDBACK_ISSUER) and the client
// (FR_FEEDBACK_AZP), so fr's token can move portal -> secure-apps with both listed.
const SECURE = 'https://auth.example.test/realms/secure-apps';
function asWriterFrom(over: Partial<User>) {
  __setAuthOverridesForTests({ validateAuth: async () => saUser(['delivery-feedback-writer'], over) });
}
async function feedbackStatus(ref: string): Promise<[number, string | undefined, string]> {
  await seedFrDelivery(A, SOL_A, ref, USER_A);
  const res = await call('POST', FEEDBACK, { project_request_id: ref, fr_project_id: 'frp', tenant_id: A });
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, ref));
  return [res.status, res.status === 403 ? (await jbody(res)).error : undefined, row!.status];
}

test('P7: a token from an issuer NOT on FR_FEEDBACK_ISSUER → 403, row unchanged', async () => {
  asWriterFrom({ issuer: SECURE });
  expect(await feedbackStatus('pr-p7-iss')).toEqual([403, 'fr_feedback_forbidden', 'draft_created']);
});

test('P7: FR_FEEDBACK_ISSUER lists both realms → the secure-apps fr-backend token promotes', async () => {
  const saved = process.env.FR_FEEDBACK_ISSUER;
  process.env.FR_FEEDBACK_ISSUER = `${config.keycloak.issuer},${SECURE}/`;
  try {
    asWriterFrom({ issuer: SECURE });
    const [status, , row] = await feedbackStatus('pr-p7-sa');
    expect(status).toBe(200);
    expect(row).toBe('promoted');
  } finally {
    if (saved === undefined) delete process.env.FR_FEEDBACK_ISSUER;
    else process.env.FR_FEEDBACK_ISSUER = saved;
  }
});

test('P7: another client carrying the role → 403 (client pinned)', async () => {
  asWriterFrom({ azp: 'kag-frontend-x' });
  expect(await feedbackStatus('pr-p7-azp')).toEqual([403, 'fr_feedback_forbidden', 'draft_created']);
});

test('P7: an operator session (super_admin) → 403 even with the role', async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => saUser(['delivery-feedback-writer', 'super_admin']),
  });
  expect(await feedbackStatus('pr-p7-su')).toEqual([403, 'fr_feedback_forbidden', 'draft_created']);
});

test('happy: draft_created → promoted, fr_project_id + url stamped', async () => {
  await seedFrDelivery(A, SOL_A, 'pr-ok', USER_A);
  const res = await call('POST', FEEDBACK, {
    project_request_id: 'pr-ok',
    fr_project_id: 'fr-proj-123',
    tenant_id: A,
    cp_solution_id: SOL_A,
    fr_project_url: 'https://fr.example.com/projects/fr-proj-123',
  });
  expect(res.status).toBe(200);
  expect((await jbody(res)).status).toBe('promoted');
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-ok'));
  expect(row!.status).toBe('promoted');
  expect(row!.fr_project_id).toBe('fr-proj-123');
  expect(row!.external_url).toBe('https://fr.example.com/projects/fr-proj-123');
});

test('idempotent: same promotion re-posted → 200 idempotent, no extra change', async () => {
  await seedFrDelivery(A, SOL_A, 'pr-idem', USER_A);
  const body = { project_request_id: 'pr-idem', fr_project_id: 'fr-9', tenant_id: A, cp_solution_id: SOL_A };
  const first = await call('POST', FEEDBACK, body);
  expect(first.status).toBe(200);
  const second = await call('POST', FEEDBACK, body);
  expect(second.status).toBe(200);
  expect((await jbody(second)).idempotent).toBe(true);
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-idem'));
  expect(row!.status).toBe('promoted');
  expect(row!.fr_project_id).toBe('fr-9');
});

test('unknown project_request_id → 404', async () => {
  const res = await call('POST', FEEDBACK, { project_request_id: 'nope', fr_project_id: 'x', tenant_id: A });
  expect(res.status).toBe(404);
  expect((await jbody(res)).error).toBe('delivery_not_found');
});

test('cp_solution_id mismatch → 409', async () => {
  await seedFrDelivery(A, SOL_A, 'pr-mismatch', USER_A);
  const res = await call('POST', FEEDBACK, {
    project_request_id: 'pr-mismatch',
    fr_project_id: 'x',
    tenant_id: A,
    cp_solution_id: OTHER_SOL, // a real solution, but not this delivery's
  });
  expect(res.status).toBe(409);
  expect((await jbody(res)).error).toBe('delivery_solution_mismatch');
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-mismatch'));
  expect(row!.status).toBe('draft_created'); // untouched
});

test("another tenant's delivery is invisible → 404", async () => {
  await seedFrDelivery(B, SOL_B, 'pr-tenantB', USER_B);
  // Caller asserts tenant A but the row lives in B → app-layer predicate excludes it (RLS in prod).
  const res = await call('POST', FEEDBACK, { project_request_id: 'pr-tenantB', fr_project_id: 'x', tenant_id: A });
  expect(res.status).toBe(404);
  const [row] = await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.external_ref, 'pr-tenantB'));
  expect(row!.status).toBe('draft_created'); // untouched
});
