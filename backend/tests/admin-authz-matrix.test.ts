// tests/admin-authz-matrix.test.ts — Phase 4 / C.1 authorization matrix.
//
// The headline test: the platform/tenant split + the X-Active-Tenant-Id scope-switch
// matrix (SPEC-PHASE4 §6.1), exercised through the LIVE routes (not the guards in
// isolation). Tenancy + role are the JWT claim + realm roles (no membership). Identity
// is injected via __setAuthOverridesForTests; the DB is the live :5433 CI postgres. This
// file is the authoritative source of truth for "who can reach what" — the frontend
// guards are UX/defense-in-depth, not this.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, and, eq } from 'drizzle-orm';
import { db, users, tenants, auditLog } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { registerTenantUserRoutes } from '../src/routes/tenant-users';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

const TENANT_A = '00000000-0000-0000-0000-0000000b1001';
const TENANT_B = '00000000-0000-0000-0000-0000000b1002';
const UNPROVISIONED = '00000000-0000-0000-0000-0000000b1003'; // never inserted

const MEMBER_ID = '00000000-0000-0000-0000-0000000b1010';
const TADMIN_ID = '00000000-0000-0000-0000-0000000b1011';
const SADMIN_ID = '00000000-0000-0000-0000-0000000b1012';
const USER_IDS = [MEMBER_ID, TADMIN_ID, SADMIN_ID];
const TENANT_IDS = [TENANT_A, TENANT_B];

// Tenancy is the claim; role is the realm role. member(A) and tenant_admin(A) both carry
// tenantId = A; only tenant_admin holds the realm role. super_admin's OWN tenant is its
// claim (A) — acting on A is NOT a switch, acting on B IS.
const anon = null;
const member: User = { id: MEMBER_ID, email: 'mem@t', name: 'Mem', roles: ['employee'], tenantId: TENANT_A };
const tenantAdmin: User = { id: TADMIN_ID, email: 'ta@t', name: 'TA', roles: ['employee', 'tenant_admin'], tenantId: TENANT_A };
const superAdmin: User = { id: SADMIN_ID, email: 'sa@t', name: 'SA', roles: ['super_admin'], tenantId: TENANT_A };

const router = new Router();
registerAdminRoutes(router);
registerTenantUserRoutes(router);

let currentUser: User | null = member;
function as(u: User | null) {
  currentUser = u;
}

async function call(
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const pathname = path.split('?')[0]!;
  const m = router.match(method, pathname);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }),
    ...m.params,
  );
}

async function scopeSwitchCount(actorId: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, actorId), eq(auditLog.action, 'scope_switch')));
  return rows.length;
}

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, USER_IDS));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError('no auth');
      }
      return currentUser;
    },
  });
  await cleanup();
  await db.insert(users).values([
    { id: MEMBER_ID, email: member.email, name: member.name },
    { id: TADMIN_ID, email: tenantAdmin.email, name: tenantAdmin.name },
    { id: SADMIN_ID, email: superAdmin.email, name: superAdmin.name },
  ]).onConflictDoNothing({ target: users.id });
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Tenant A', slug: 'tenant-a-b1' },
    { id: TENANT_B, name: 'Tenant B', slug: 'tenant-b-b1' },
  ]).onConflictDoNothing({ target: tenants.id });
  as(member);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

const PLATFORM = ['GET', '/api/admin/tenants'] as const;
const OWN_A = ['GET', `/api/tenants/${TENANT_A}/members`] as const;
const FOREIGN_B = ['GET', `/api/tenants/${TENANT_B}/members`] as const;

// ---- the matrix: {anon, member, tenant_admin(A), super_admin} × {platform, own A, foreign B} ----

test('anon → 401 on every admin route', async () => {
  as(anon);
  expect((await call(...PLATFORM)).status).toBe(401);
  expect((await call(...OWN_A)).status).toBe(401);
  expect((await call(...FOREIGN_B)).status).toBe(401);
});

test('member(A) → 403 everywhere (platform, own tenant as non-admin, foreign)', async () => {
  as(member);
  expect((await call(...PLATFORM)).status).toBe(403); // no super_admin
  expect((await call(...OWN_A)).status).toBe(403);     // member, not tenant_admin
  expect((await call(...FOREIGN_B)).status).toBe(403); // not a member of B
});

test('tenant_admin(A) → 403 platform, 200 own A, 403 foreign B', async () => {
  as(tenantAdmin);
  expect((await call(...PLATFORM)).status).toBe(403);  // not super_admin
  expect((await call(...OWN_A)).status).toBe(200);     // claim tenant_admin of A
  expect((await call(...FOREIGN_B)).status).toBe(403); // path B ≠ claim A → scope mismatch
});

test('super_admin → 200 platform; 200 own A (no audit); 200 foreign B (scope_switch audited)', async () => {
  as(superAdmin);
  expect((await call(...PLATFORM)).status).toBe(200);

  // A == super_admin's claim → NOT a scope switch, no audit row.
  expect(await scopeSwitchCount(SADMIN_ID)).toBe(0);
  expect((await call(...OWN_A)).status).toBe(200);
  expect(await scopeSwitchCount(SADMIN_ID)).toBe(0);

  // B != own → cross-tenant scope switch, audited.
  expect((await call(...FOREIGN_B)).status).toBe(200);
  expect(await scopeSwitchCount(SADMIN_ID)).toBe(1);
});

// ---- X-Active-Tenant-Id scope-switch header semantics (spec 6.1) ----

test('super_admin + valid header == path → 200 + audit; header != path → 403; malformed → 422', async () => {
  as(superAdmin);

  // header equals the path target B → allowed, audited.
  expect((await call('GET', `/api/tenants/${TENANT_B}/members`, { 'X-Active-Tenant-Id': TENANT_B })).status).toBe(200);
  expect(await scopeSwitchCount(SADMIN_ID)).toBeGreaterThanOrEqual(1);

  // header B but path A → mismatch → 403 (path authoritative, no leak).
  expect((await call('GET', `/api/tenants/${TENANT_A}/members`, { 'X-Active-Tenant-Id': TENANT_B })).status).toBe(403);

  // malformed header → 422, only super_admins get the diagnostic.
  expect((await call('GET', `/api/tenants/${TENANT_A}/members`, { 'X-Active-Tenant-Id': 'not-a-uuid' })).status).toBe(422);
});

test('non-super_admin sending X-Active-Tenant-Id → silently ignored (no 422, no audit)', async () => {
  as(tenantAdmin);
  // tenant_admin of A sends a foreign B header on an A route → header ignored,
  // still authorized by their claim (A) → 200; no audit, never 422.
  const res = await call('GET', `/api/tenants/${TENANT_A}/members`, { 'X-Active-Tenant-Id': TENANT_B });
  expect(res.status).toBe(200);
  expect(await scopeSwitchCount(TADMIN_ID)).toBe(0);
});

// ---- fail-closed provisioning on the super_admin scope-switch path ----

test('super_admin scope-switch into an UNPROVISIONED tenant → 403 tenant_not_provisioned', async () => {
  as(superAdmin);
  const res = await call('GET', `/api/tenants/${UNPROVISIONED}/members`);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('tenant_not_provisioned');
});

// ---- Phase 4 / C.2a: super_admin-gated onboarding surface ----
// Every onboarding queue/invite/email-domain route is super_admin-only; the open
// self-signup NOTIFY is reachable without it. (The provisioning behaviour itself —
// Keycloak-first chain, idempotency — lives in onboarding.test.ts with a fake KC client.)

const onboardingRouter = new Router();
registerOnboardingRoutes(onboardingRouter);
async function callOnboarding(method: string, path: string): Promise<Response> {
  const m = onboardingRouter.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no onboarding route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, { method, headers: { 'content-type': 'application/json' } }),
    ...m.params,
  );
}

const SUPER_ONLY: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/signup-approvals'],
  ['GET', '/api/signup-approvals/stats'],
  ['POST', '/api/invites'],
  ['GET', '/api/email-domains'],
  ['GET', '/api/free-email-providers'],
];

test('onboarding: tenant_admin → 403 on every super_admin-gated route', async () => {
  as(tenantAdmin);
  for (const [method, path] of SUPER_ONLY) {
    expect((await callOnboarding(method, path)).status).toBe(403);
  }
});

test('onboarding: anon → 401 on a super_admin route; notify-self stays open (not 401/403)', async () => {
  as(anon);
  expect((await callOnboarding('GET', '/api/signup-approvals')).status).toBe(401);
  // notify-self is the open path — anonymous reaches the handler (no auth gate). A missing
  // body is a 4xx from validation, never 401/403.
  const notify = await callOnboarding('POST', '/api/signup-approvals/notify-self');
  expect(notify.status).not.toBe(401);
  expect(notify.status).not.toBe(403);
});

// ---- Phase 4 / C.2b: tenant_admin in-tenant user management (deny semantics) ----
// Pure-authz denials only — they short-circuit in requireTenantAdmin BEFORE any Keycloak/DB
// write, so no fake KC client is needed here. The ALLOW behaviour (create / role set / force-
// scope / escalation guard) lives in tenant-users.test.ts with an injected fake KC client.

test('tenant-users: member → 403 on create + role-patch in their own tenant', async () => {
  as(member);
  expect((await call('POST', `/api/tenants/${TENANT_A}/users`)).status).toBe(403);
  expect((await call('PATCH', `/api/tenants/${TENANT_A}/users/${MEMBER_ID}`)).status).toBe(403);
});

test('tenant-users: tenant_admin(A) → 403 acting into a FOREIGN tenant B (scope mismatch)', async () => {
  as(tenantAdmin);
  expect((await call('POST', `/api/tenants/${TENANT_B}/users`)).status).toBe(403);
  expect((await call('PATCH', `/api/tenants/${TENANT_B}/users/${MEMBER_ID}`)).status).toBe(403);
});

test('tenant-users: anon → 401 on create', async () => {
  as(anon);
  expect((await call('POST', `/api/tenants/${TENANT_A}/users`)).status).toBe(401);
});
