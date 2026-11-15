// tests/delivery.test.ts — Phase 5 / 5A: delivery-connector CRUD + the read-only deliveries list.
// Proves the secret-hygiene posture (credentials encrypted, never returned), the tenant_admin gate,
// app-layer tenant scoping (tenant B never sees tenant A's connectors), and 409/404/422 edges.
// Auth is faked via __setAuthOverridesForTests so we control the caller's tenant + role.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
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
import { decryptSecret } from '../src/host/secret-box';
import type { User } from '../src/types';

const A = '00000000-0000-0000-0000-0000005a0001';
const B = '00000000-0000-0000-0000-0000005a0002';
const USER_A = '00000000-0000-0000-0000-0000005aa001';
const USER_B = '00000000-0000-0000-0000-0000005ab001';
const CH_A = '00000000-0000-0000-0000-0000005ac001';
const SOL_A = '00000000-0000-0000-0000-0000005ad001';

function admin(id: string, tenant: string): User {
  return { id, email: `${id}@test`, name: 'Admin', roles: ['tenant_admin'], tenantId: tenant };
}
const adminA = admin(USER_A, A);
const adminB = admin(USER_B, B);
const memberA: User = { id: USER_A, email: 'm@test', name: 'M', roles: ['member'], tenantId: A };

const router = new Router();
registerDeliveryRoutes(router);

function as(user: User) {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path)!;
  const req = new Request(`http://t${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return m.handler(req, ...m.params);
}

async function cleanup() {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [A, B]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [A, B]));
  await db.delete(solutions).where(inArray(solutions.tenant_id, [A, B]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [A, B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: A, name: 'Tenant A', slug: 'deliv-tenant-a' },
    { id: B, name: 'Tenant B', slug: 'deliv-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'da@test', name: 'A', tenant_id: A },
    { id: USER_B, email: 'db@test', name: 'B', tenant_id: B },
  ]);
  await db
    .insert(challenges)
    .values({ id: CH_A, title: 'A ch', work_area: 'ops', submitter_id: USER_A, tenant_id: A });
  await db.insert(solutions).values({
    id: SOL_A,
    challenge_id: CH_A,
    title: 'A sol',
    author_id: USER_A,
    tenant_id: A,
  });
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

beforeEach(async () => {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [A, B]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [A, B]));
}, 30_000);

test('POST stores credentials ENCRYPTED and never echoes them; hasCredentials is true', async () => {
  as(adminA);
  const res = await call('POST', '/api/delivery-targets', {
    kind: 'jira',
    name: 'Acme Jira',
    baseUrl: 'https://acme.atlassian.net',
    projectKey: 'DEL',
    credentials: { email: 'ops@acme.io', apiToken: 'jira-secret-xyz' },
  });
  expect(res.status).toBe(201);
  const out = (await res.json()) as { target: Record<string, unknown> };
  expect(out.target.hasCredentials).toBe(true);
  expect(out.target.kind).toBe('jira');
  // No plaintext secret anywhere in the response (and no encrypted column either).
  expect(JSON.stringify(out)).not.toContain('jira-secret-xyz');
  expect(out.target).not.toHaveProperty('credentials_encrypted');

  const [row] = await db
    .select()
    .from(deliveryTargets)
    .where(eq(deliveryTargets.tenant_id, A));
  expect(row!.credentials_encrypted).toBeTruthy();
  expect(row!.credentials_encrypted).not.toContain('jira-secret-xyz'); // ciphertext at rest
  expect(JSON.parse(decryptSecret(row!.credentials_encrypted!))).toEqual({
    email: 'ops@acme.io',
    apiToken: 'jira-secret-xyz',
  });
});

test('POST /api/delivery-targets/:id/test → 404 for an unknown target', async () => {
  as(adminA);
  const res = await call('POST', '/api/delivery-targets/00000000-0000-0000-0000-0000005a09ff/test');
  expect(res.status).toBe(404);
});

test('tenant B never sees tenant A connectors (app-layer scope)', async () => {
  as(adminA);
  await call('POST', '/api/delivery-targets', { kind: 'fr', name: 'A-only' });

  as(adminB);
  const resB = await call('GET', '/api/delivery-targets');
  expect(((await resB.json()) as { targets: unknown[] }).targets).toEqual([]);

  as(adminA);
  const resA = await call('GET', '/api/delivery-targets');
  const aTargets = ((await resA.json()) as { targets: { name: string }[] }).targets;
  expect(aTargets.map((t) => t.name)).toEqual(['A-only']);
});

test('PUT without credentials keeps the stored blob; PUT with credentials rotates it', async () => {
  as(adminA);
  const created = (await (
    await call('POST', '/api/delivery-targets', {
      kind: 'jira',
      name: 'Rotatable',
      credentials: { apiToken: 'first' },
    })
  ).json()) as { target: { id: string } };
  const id = created.target.id;

  const [before] = await db.select().from(deliveryTargets).where(eq(deliveryTargets.id, id));
  // Edit only the name — no credentials supplied → blob untouched.
  await call('PUT', `/api/delivery-targets/${id}`, { name: 'Renamed' });
  const [afterRename] = await db.select().from(deliveryTargets).where(eq(deliveryTargets.id, id));
  expect(afterRename!.name).toBe('Renamed');
  expect(afterRename!.credentials_encrypted).toBe(before!.credentials_encrypted);

  // Supply new credentials → blob rotates.
  await call('PUT', `/api/delivery-targets/${id}`, { credentials: { apiToken: 'second' } });
  const [rotated] = await db.select().from(deliveryTargets).where(eq(deliveryTargets.id, id));
  expect(rotated!.credentials_encrypted).not.toBe(before!.credentials_encrypted);
  expect(JSON.parse(decryptSecret(rotated!.credentials_encrypted!))).toEqual({ apiToken: 'second' });
});

test('duplicate name in the same tenant → 409', async () => {
  as(adminA);
  await call('POST', '/api/delivery-targets', { kind: 'jira', name: 'Dup' });
  const res = await call('POST', '/api/delivery-targets', { kind: 'fr', name: 'Dup' });
  expect(res.status).toBe(409);
});

test('a non-tenant_admin is forbidden (403)', async () => {
  as(memberA);
  const res = await call('GET', '/api/delivery-targets');
  expect(res.status).toBe(403);
});

test("DELETE another tenant's connector → 404 (scope); own → ok", async () => {
  as(adminA);
  const created = (await (
    await call('POST', '/api/delivery-targets', { kind: 'fr', name: 'DelMe' })
  ).json()) as { target: { id: string } };
  const id = created.target.id;

  as(adminB);
  expect((await call('DELETE', `/api/delivery-targets/${id}`)).status).toBe(404);

  as(adminA);
  expect((await call('DELETE', `/api/delivery-targets/${id}`)).status).toBe(200);
  const rows = await db.select().from(deliveryTargets).where(eq(deliveryTargets.id, id));
  expect(rows.length).toBe(0);
});

test('POST rejects an unknown kind (422)', async () => {
  as(adminA);
  const res = await call('POST', '/api/delivery-targets', { kind: 'gitlab', name: 'x' });
  expect(res.status).toBe(422);
});

test('GET deliveries for a solution: own tenant → empty list; other tenant → 404', async () => {
  as(adminA);
  const res = await call('GET', `/api/solutions/${SOL_A}/deliveries`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);

  as(adminB);
  const resB = await call('GET', `/api/solutions/${SOL_A}/deliveries`);
  expect(resB.status).toBe(404);
});
