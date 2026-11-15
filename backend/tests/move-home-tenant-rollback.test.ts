// tests/move-home-tenant-rollback.test.ts — `moveUserHomeTenant` (routes/tenant-users.ts) under
// CP-owned tenancy.
//
// The move used to write Keycloak (the `tenant_id` attribute, then realm roles) before claiming the
// destination seat, and needed a two-half revert when the claim failed — the defect this file was
// born to pin was a revert that restored the attribute but left an unrequested `tenant_admin`
// realm role behind. Keycloak no longer holds tenancy at all: the move is ONE `users` write
// (`tenant_id` + `tenant_role`) under `claimSeat`, so a failed claim leaves nothing to revert.
// What still matters, and what this file pins: a refused move leaves BOTH columns exactly as they
// were (no unrequested tenant_admin in the source), a successful one writes both, and neither path
// touches Keycloak.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, inArray, eq } from 'drizzle-orm';
import { db, users, tenants, auditLog } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerTenantUserRoutes } from '../src/routes/tenant-users';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  type KeycloakAdminClient,
  type RealmUser,
} from '../src/services/keycloak-admin';
import type { User } from '../src/types';

// Fresh UUID suffix block (…0000000c2cXX) — tenant-users.test.ts already owns …0000000c2bXX, and
// both files touch the same tables under fixed ids, so a shared block would risk cross-file
// collisions if tests ever ran in the same process.
const TENANT = '00000000-0000-4000-8000-0000000c2c01';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000c2c02';
const TADMIN_ID = '00000000-0000-4000-8000-0000000c2c10';
const MOVER_SUB = '00000000-0000-4000-8000-0000000c2c20';
const SITTING_SUB = '00000000-0000-4000-8000-0000000c2c30';
const SUPERADMIN_ID = '00000000-0000-4000-8000-0000000c2cff';
const SEEDED = [TADMIN_ID, MOVER_SUB, SITTING_SUB, SUPERADMIN_ID];
const TENANT_IDS = [TENANT, OTHER_TENANT];

// A super_admin whose own claim is TENANT (so acting into TENANT is not itself a scope-switch).
// Seeded HOMELESS (tenant_id null), mirroring tenant-users.test.ts, so it satisfies
// `audit_log.actor_id`'s FK without being counted into either tenant's headcount or admin set.
const superAdmin: User = {
  id: SUPERADMIN_ID, email: 'sa-rollback@t', name: 'SA', roles: ['platform', 'super_admin'], tenantId: TENANT,
};

// ---- fake Keycloak admin client: records every call so the tests can assert the move never
// reaches Keycloak (the realm is shared with fr; CP owns tenancy in its own DB). ----
interface KcCall { op: string; args: unknown[] }
function makeKc(): { kc: KeycloakAdminClient; calls: KcCall[] } {
  const calls: KcCall[] = [];
  const rec = (op: string) => async (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const kc: KeycloakAdminClient = {
    async createRealmUser(...args) {
      calls.push({ op: 'createRealmUser', args });
      throw new Error('not used by this route');
    },
    logoutUser: rec('logoutUser'),
    executeActionsEmail: rec('executeActionsEmail'),
    deleteRealmUser: rec('deleteRealmUser'),
    async listRealmUsers(): Promise<RealmUser[]> {
      calls.push({ op: 'listRealmUsers', args: [] });
      return [];
    },
    async findRealmUserByUsernameOrEmail(...args) {
      calls.push({ op: 'findRealmUserByUsernameOrEmail', args });
      return null;
    },
    backfillUserEmail: rec('backfillUserEmail'),
    async getRealmRolesForUsers(userIds) {
      calls.push({ op: 'getRealmRolesForUsers', args: [userIds] });
      return new Map(userIds.map((u) => [u, []]));
    },
    createIdentityProvider: rec('createIdentityProvider'),
    async getIdentityProvider() { return null; },
    updateIdentityProvider: rec('updateIdentityProvider'),
    deleteIdentityProvider: rec('deleteIdentityProvider'),
    createIdpMapper: rec('createIdpMapper'),
    async listIdpMappers() { return []; },
    deleteIdpMapper: rec('deleteIdpMapper'),
  };
  return { kc, calls };
}

const router = new Router();
registerTenantUserRoutes(router);

let currentUser: User | null = superAdmin;
function as(u: User | null) {
  currentUser = u;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...m.params,
  );
}

const moveTo = (userId: string, tenantId: string, role?: string) =>
  call('PATCH', `/api/admin/users/${userId}/tenant`, role === undefined ? { tenantId } : { tenantId, role });

async function cleanup() {
  // Both actor_id and target_id, as tenant-users.test.ts does: a row left by a run whose actor
  // differed (an interrupted run, a seed identity) would otherwise survive a target-only cleanup.
  await db.delete(auditLog).where(eq(auditLog.actor_id, SUPERADMIN_ID));
  await db.delete(auditLog).where(inArray(auditLog.target_id, SEEDED));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, SEEDED));
  await db.delete(users).where(inArray(users.id, SEEDED));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// Explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see the long note in
// license-provisioning.test.ts); a slow one otherwise fails as "(unnamed) [5003ms]" with no cause.
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
  await db.insert(tenants).values([
    { id: TENANT, name: 'Rollback Source', slug: 'rollback-src' },
    { id: OTHER_TENANT, name: 'Rollback Dest', slug: 'rollback-dst' },
  ]).onConflictDoNothing({ target: tenants.id });
  // A co-admin so the SOURCE's last-admin guard never blocks the mover (the mover in every test
  // below is a plain member/co-admin, never the tenant's LAST tenant_admin — that guard is a
  // different, already-covered defect; this file isolates the role-revert one).
  await db.insert(users).values({ id: TADMIN_ID, email: 'tadmin-rollback@t', name: 'TA', tenant_id: TENANT })
    .onConflictDoNothing({ target: users.id });
  __setKeycloakAdminForTests(makeKc().kc);
  as(superAdmin);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

test('move: destination seat full — refused, and the mover keeps BOTH their tenant and their role', async () => {
  // A move that requested tenant_admin in a full destination must not leave the mover holding
  // tenant_admin anywhere: the role and the tenant are one write, so a refusal changes neither.
  await db.insert(users).values({
    id: MOVER_SUB, email: 'mover-rollback@t', name: 'Mover', tenant_id: TENANT, tenant_role: 'member',
  });
  await db.update(tenants).set({ max_members: 1 }).where(eq(tenants.id, OTHER_TENANT));
  await db.insert(users)
    .values({ id: SITTING_SUB, email: 'sitting-rollback@t', name: 'Sitting', tenant_id: OTHER_TENANT })
    .onConflictDoNothing({ target: users.id });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);

  const res = await moveTo(MOVER_SUB, OTHER_TENANT, 'tenant_admin');
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('seat_limit_reached');

  const [row] = await db.select().from(users).where(eq(users.id, MOVER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
  expect(row!.tenant_role).toBe('member');

  const audits = await db.select().from(auditLog)
    .where(and(eq(auditLog.action, 'user.move'), eq(auditLog.target_id, MOVER_SUB)));
  expect(audits.length).toBe(0);
  expect(calls).toEqual([]);
});

test('move: success writes tenant_id AND tenant_role in CP, and never touches Keycloak', async () => {
  await db.insert(users).values({
    id: MOVER_SUB, email: 'mover-rollback2@t', name: 'Mover2', tenant_id: TENANT, tenant_role: 'member',
  });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);

  const res = await moveTo(MOVER_SUB, OTHER_TENANT, 'developer');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fromTenantId: string; toTenantId: string; role: string };
  expect(body.fromTenantId).toBe(TENANT);
  expect(body.toTenantId).toBe(OTHER_TENANT);
  expect(body.role).toBe('developer');

  const [row] = await db.select().from(users).where(eq(users.id, MOVER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(row!.tenant_role).toBe('developer');
  expect(calls).toEqual([]);
});

test('move: an unstated role across workspaces lands as member, never carrying tenant_admin over', async () => {
  // MOVER is a co-admin of the source (TADMIN_ID is the other), so the last-admin guard does not fire.
  await db.update(users).set({ tenant_role: 'tenant_admin' }).where(eq(users.id, TADMIN_ID));
  await db.insert(users).values({
    id: MOVER_SUB, email: 'mover-rollback3@t', name: 'Mover3', tenant_id: TENANT, tenant_role: 'tenant_admin',
  });

  const res = await moveTo(MOVER_SUB, OTHER_TENANT);
  expect(res.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, MOVER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(row!.tenant_role).toBe('member');
});
