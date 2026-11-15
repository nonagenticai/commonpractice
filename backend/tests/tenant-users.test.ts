// tests/tenant-users.test.ts — tenant_admin in-workspace user management (CP-owned membership).
//
// Exercises the LIVE routes (routes/tenant-users.ts + admin.ts listMembers) against the test
// postgres, identity injected via __setAuthOverridesForTests and the Keycloak admin client replaced
// by a recording FAKE. Membership is CP's: `users.tenant_id` + `users.tenant_role`. Proves: POST
// /users creates an INVITE force-scoped to the path tenant (body tenant_id ignored) and seats
// nobody; the privilege-escalation guard (super_admin role → 422, no KC); refusals for an address
// already in this or another workspace; level changes and removals are DB-only and never write to
// Keycloak (no attribute, no realm role, no user delete — the realm is shared with fr); the
// cross-tenant 404 guard; the last-tenant_admin guard; the move route; the roster's DB role; and the
// seat cap counted against invites. Accept-flow coverage lives in tenant-invites.test.ts; pure-authz
// denials in admin-authz-matrix.test.ts.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, inArray, eq } from 'drizzle-orm';
import { db, users, tenants, auditLog, datasets, memberEntitlements } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { config } from '../src/config';
import { ensureMemberEntitlement } from '../src/services/license-provisioning';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerTenantUserRoutes } from '../src/routes/tenant-users';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { ensureUser } from '../src/services/user-service';
import { __resetCpIdentityForTests } from '../src/services/cp-identity';
import { getSeatUsage } from '../src/services/seat-limit';
import { mintKey, verifyKey, DEFAULT_SCOPES } from '../src/services/mcp-api-key';
import { issueAgentSession, refreshAgentSession } from '../src/services/agent-session';
import { mcpApiKeys, withTenantDb, withTenantDbAsRuntimeRoleForTests } from '../src/db/client';
import {
  __setKeycloakAdminForTests,
  KeycloakAdminError,
  type KeycloakAdminClient,
  type RealmUser,
} from '../src/services/keycloak-admin';
import type { User } from '../src/types';

// RFC-4122-valid v4 uuids so any body .uuid() accepts them.
const TENANT = '00000000-0000-4000-8000-0000000c2b01';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000c2b02';
const TADMIN_ID = '00000000-0000-4000-8000-0000000c2b10';
const NEW_SUB = '00000000-0000-4000-8000-0000000c2baa';
const MEMBER_SUB = '00000000-0000-4000-8000-0000000c2bbb';
const OTHER_SUB = '00000000-0000-4000-8000-0000000c2bcc';
const SUPERADMIN_ID = '00000000-0000-4000-8000-0000000c2bff';
const SEEDED = [TADMIN_ID, NEW_SUB, MEMBER_SUB, OTHER_SUB, SUPERADMIN_ID];
const TENANT_IDS = [TENANT, OTHER_TENANT];

// A tenant_admin of TENANT (CP row: tenant_id = TENANT, tenant_role = tenant_admin).
const tenantAdmin: User = {
  id: TADMIN_ID, email: 'ta-c2b@t', name: 'TA', roles: ['tenant_admin'], tenantId: TENANT,
  tenantRole: 'tenant_admin',
};

// A platform super_admin. Its `users` row is seeded HOMELESS (tenant_id null) so it satisfies
// `audit_log.actor_id`'s FK without being counted into any tenant's headcount or admin set.
const superAdmin: User = {
  id: SUPERADMIN_ID, email: 'sa-c2b@t', name: 'SA', roles: ['super_admin'],
};

// ---- fake Keycloak admin client (records calls) ----
interface KcCall { op: string; args: unknown[] }
function makeKc(opts: {
  createSub?: string;
  createThrows?: Error;
  /** Realm user the exact-match username/email lookup resolves to (default: none). */
  findResult?: RealmUser | null;
  /** Realm roles per user (read-only — `assertAdoptableIdentity` reads them). */
  rolesByUser?: Record<string, string[]>;
} = {}): { kc: KeycloakAdminClient; calls: KcCall[] } {
  const calls: KcCall[] = [];
  const rec = (op: string) => async (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const kc: KeycloakAdminClient = {
    async createRealmUser(input) {
      calls.push({ op: 'createRealmUser', args: [input] });
      if (opts.createThrows) throw opts.createThrows;
      return opts.createSub ?? NEW_SUB;
    },
    logoutUser: rec('logoutUser'),
    executeActionsEmail: rec('executeActionsEmail'),
    deleteRealmUser: rec('deleteRealmUser'),
    async listRealmUsers(): Promise<RealmUser[]> {
      calls.push({ op: 'listRealmUsers', args: [] });
      return [];
    },
    async findRealmUserByUsernameOrEmail(username, email) {
      calls.push({ op: 'findRealmUserByUsernameOrEmail', args: [username, email] });
      return opts.findResult ?? null;
    },
    backfillUserEmail: rec('backfillUserEmail'),
    async getRealmRolesForUsers(userIds) {
      calls.push({ op: 'getRealmRolesForUsers', args: [userIds] });
      return new Map(userIds.map((u) => [u, opts.rolesByUser?.[u] ?? []]));
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
registerAdminRoutes(router);
registerTenantUserRoutes(router);

let currentUser: User | null = tenantAdmin;
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

const roleOf = async (id: string) =>
  (await db.select({ r: users.tenant_role }).from(users).where(eq(users.id, id)))[0]?.r ?? null;
const invitesFor = (tenantId: string) =>
  db.select().from(tenantInvites).where(eq(tenantInvites.tenant_id, tenantId));

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED));
  await db.delete(auditLog).where(inArray(auditLog.target_id, SEEDED));
  await db.delete(auditLog).where(inArray(auditLog.tenant_id, TENANT_IDS));
  await db.delete(tenantInvites).where(inArray(tenantInvites.tenant_id, TENANT_IDS));
  // Datasets first: `datasets.owner_id` is ON DELETE NO ACTION. `mcp_api_keys.issued_by` is ON
  // DELETE SET NULL, so clear those explicitly. `member_entitlements.user_id` is a FK to users and a
  // live row surviving between tests turns the next ensure into a no-op read.
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.issued_by, SEEDED));
  await db.delete(datasets).where(inArray(datasets.owner_id, SEEDED));
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, SEEDED));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, SEEDED));
  await db.delete(users).where(inArray(users.id, SEEDED));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
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
  __resetCpIdentityForTests();
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT, name: 'Acme C2b', slug: 'acme-c2b' },
    { id: OTHER_TENANT, name: 'Other C2b', slug: 'other-c2b' },
  ]).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values({
    id: TADMIN_ID, email: tenantAdmin.email, name: tenantAdmin.name, tenant_id: TENANT, tenant_role: 'tenant_admin',
  }).onConflictDoNothing({ target: users.id });
  await db.insert(users).values({ id: SUPERADMIN_ID, email: superAdmin.email, name: superAdmin.name, tenant_id: null })
    .onConflictDoNothing({ target: users.id });
  __setKeycloakAdminForTests(makeKc().kc);
  as(tenantAdmin);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

// ---- invite (POST /api/tenants/:id/users) ----

test('invite: a pending invite in the path tenant, a bare realm identity + action email, nobody seated yet', async () => {
  const { kc, calls } = makeKc({ createSub: NEW_SUB });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'new@acme-c2b.test', name: 'Nora New', role: 'developer' });
  expect(res.status).toBe(201);
  const { invite } = (await res.json()) as { invite: { tenantId: string; role: string; email: string; inviteUrl: string } };
  expect(invite).toMatchObject({ tenantId: TENANT, role: 'developer', email: 'new@acme-c2b.test' });
  expect(invite.inviteUrl).toContain('/invite/accept?token=');

  // Lookup, a bare create (no attributes, no roles), the credential-setup mail. Nothing else.
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'createRealmUser', 'executeActionsEmail']);
  expect((calls[1]!.args[0] as { attributes?: unknown }).attributes).toBeUndefined();

  const rows = await invitesFor(TENANT);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'pending', role: 'developer', keycloak_sub: NEW_SUB });
  // The invite seats nobody: membership is written on ACCEPT.
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0);
  expect(await db.select().from(auditLog).where(eq(auditLog.action, 'invite.create'))).toHaveLength(1);
});

test('invite: body tenantId is IGNORED — the invite is force-scoped to the path tenant', async () => {
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'forced@acme-c2b.test', tenantId: OTHER_TENANT });
  expect(res.status).toBe(201);
  expect(await invitesFor(TENANT)).toHaveLength(1);
  expect(await invitesFor(OTHER_TENANT)).toHaveLength(0);
});

test('invite: role super_admin is rejected (422 — privilege-escalation guard), no KC call', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'esc@acme-c2b.test', role: 'super_admin' });
  expect(res.status).toBe(422);
  expect(calls.length).toBe(0);
});

test('invite: an address already a member here → 409 already_member (case-insensitive), no KC call', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'dup@acme-c2b.test', name: 'Dup', tenant_id: TENANT });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'DUP@acme-c2b.test' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('already_member');
  expect(calls.length).toBe(0);
});

test('invite: an email owned by ANOTHER tenant is refused (409 email_in_other_tenant), and stays put', async () => {
  // CP is single-home-tenant: an invite can never silently move an identity between workspaces.
  await db.insert(users).values({ id: OTHER_SUB, email: 'elsewhere@acme-c2b.test', name: 'Else', tenant_id: OTHER_TENANT });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'elsewhere@acme-c2b.test' });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error?: string; message?: string };
  expect(body.error).toBe('email_in_other_tenant');
  expect(body.message).toContain('another workspace');
  expect(calls.length).toBe(0);
  const [kept] = await db.select().from(users).where(eq(users.id, OTHER_SUB));
  expect(kept?.tenant_id).toBe(OTHER_TENANT);
});

test('invite: a Keycloak identity-write failure is 502 and writes NO invite', async () => {
  const { kc } = makeKc({ createThrows: new KeycloakAdminError(500, 'kc down') });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'fail@acme-c2b.test' });
  expect(res.status).toBe(502);
  expect(await invitesFor(TENANT)).toHaveLength(0);
});

test('invite: a HOMELESS identity (users.tenant_id NULL, live realm user) is ADOPTED, not re-minted', async () => {
  // The shape a stranded first login leaves: a CP row with no workspace and a live realm identity.
  // It must be invitable — and the existing identity (maybe their fr login) must get a CP mail, never
  // a Keycloak action email (UPDATE_PASSWORD would reset that login).
  await db.insert(users).values({ id: MEMBER_SUB, email: 'sso@acme-c2b.test', name: 'Sso', tenant_id: null });
  const { kc, calls } = makeKc({ findResult: { id: MEMBER_SUB, email: 'sso@acme-c2b.test' } as RealmUser });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'sso@acme-c2b.test', role: 'member' });
  expect(res.status).toBe(201);
  const ops = calls.map((c) => c.op);
  expect(ops).not.toContain('createRealmUser');
  expect(ops).not.toContain('executeActionsEmail');
  const [inv] = await invitesFor(TENANT);
  expect(inv!.keycloak_sub).toBeNull(); // CP did not mint it
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBeNull(); // still homeless until they accept
});

test('invite: an existing PLATFORM (super_admin) realm account is refused (409), no invite', async () => {
  const { kc } = makeKc({
    findResult: { id: OTHER_SUB, email: 'ops@acme-c2b.test' } as RealmUser,
    rolesByUser: { [OTHER_SUB]: ['super_admin'] },
  });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'ops@acme-c2b.test' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('platform_account_adoption_refused');
  expect(await invitesFor(TENANT)).toHaveLength(0);
});

// ---- level (PATCH) — DB only ----

test('patch role: promotion writes users.tenant_role, audits, and makes ZERO Keycloak calls', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'mem@acme-c2b.test', name: 'Mem', tenant_id: TENANT, tenant_role: 'member' });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`, { role: 'tenant_admin' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ userId: MEMBER_SUB, role: 'tenant_admin' });
  expect(calls).toEqual([]);
  expect(await roleOf(MEMBER_SUB)).toBe('tenant_admin');
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'member.set_role'));
  expect(audit!.metadata).toMatchObject({ tenantId: TENANT, fromRole: 'member', role: 'tenant_admin' });
});

test('patch role: a NULL (not backfilled) tenant_role is read as member', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'dev@acme-c2b.test', name: 'Dev', tenant_id: TENANT });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`, { role: 'developer' });
  expect(res.status).toBe(200);
  expect(await roleOf(MEMBER_SUB)).toBe('developer');
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'member.set_role'));
  expect(audit!.metadata).toMatchObject({ fromRole: 'member', role: 'developer' });
});

test('patch role: a target user in ANOTHER tenant → 404, their role untouched', async () => {
  await db.insert(users).values({ id: OTHER_SUB, email: 'other@acme-c2b.test', name: 'Other', tenant_id: OTHER_TENANT, tenant_role: 'member' });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${OTHER_SUB}`, { role: 'tenant_admin' });
  expect(res.status).toBe(404);
  expect(await roleOf(OTHER_SUB)).toBe('member');
});

test('patch role: super_admin role is rejected (422)', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'mem2@acme-c2b.test', name: 'Mem', tenant_id: TENANT });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`, { role: 'super_admin' });
  expect(res.status).toBe(422);
  expect(await roleOf(MEMBER_SUB)).toBeNull();
});

test('patch role: demoting the workspace’s LAST tenant_admin → 409 last_tenant_admin, role unchanged', async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${TADMIN_ID}`, { role: 'member' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_tenant_admin');
  expect(await roleOf(TADMIN_ID)).toBe('tenant_admin');
  expect(await db.select().from(auditLog).where(eq(auditLog.action, 'member.set_role'))).toHaveLength(0);
});

test('patch role: demoting one of TWO tenant_admins → 200 (guard fires only at the last admin)', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'co-admin@acme-c2b.test', name: 'Co', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`, { role: 'member' });
  expect(res.status).toBe(200);
  expect(await roleOf(MEMBER_SUB)).toBe('member');
});

test('patch role: a tombstoned tenant_admin does not count toward the admin set', async () => {
  // A removed admin is not somebody who can administer the workspace.
  await db.insert(users).values({
    id: MEMBER_SUB, email: 'gone-admin@acme-c2b.test', name: 'Gone', tenant_id: TENANT, tenant_role: 'tenant_admin', deleted_at: new Date(),
  });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${TADMIN_ID}`, { role: 'member' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_tenant_admin');
});

// ---- remove from workspace (DELETE · tombstone 0050) ----

test('remove: TOMBSTONES the local row, audited (200), and never touches the realm identity', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'gone@acme-c2b.test', name: 'Gone', tenant_id: TENANT });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    userId: MEMBER_SUB, offboarded: true, keysRevoked: 0, sessionsRevoked: 0, invitesRevoked: 0,
  });
  // The realm is shared with fr: no delete, no logout, no read even.
  expect(calls).toEqual([]);
  const rows = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(rows.length).toBe(1);
  expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
  expect(await db.select().from(auditLog).where(eq(auditLog.action, 'member.remove'))).toHaveLength(1);
});

test('remove: revokes the address’s pending invites in THIS workspace', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'reinv@acme-c2b.test', name: 'Re', tenant_id: TENANT });
  await db.insert(tenantInvites).values({
    tenant_id: TENANT, email: 'REINV@acme-c2b.test', role: 'member', token_hash: 'c2b-reinv-hash',
    expires_at: new Date(Date.now() + 86_400_000),
  });
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { invitesRevoked: number }).invitesRevoked).toBe(1);
  const [inv] = await invitesFor(TENANT);
  expect(inv!.status).toBe('revoked');
});

test('remove: a member who OWNS CONTENT can be removed, and the address is invitable again', async () => {
  // 14 FKs reference users.id ON DELETE NO ACTION — a hard delete raised 23503 for any member who
  // had authored anything. The tombstone keeps attribution and frees the address.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'owner@acme-c2b.test', name: 'Owner', tenant_id: TENANT });
  await db.insert(datasets).values({
    owner_id: MEMBER_SUB, tenant_id: TENANT, name: 'Owned', slug: 'owned-c2b', source_type: 'csv',
  });

  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`);
  expect(res.status).toBe(200);
  expect(await db.select().from(datasets).where(eq(datasets.owner_id, MEMBER_SUB))).toHaveLength(1);

  __setKeycloakAdminForTests(makeKc({ findResult: { id: MEMBER_SUB, email: 'owner@acme-c2b.test' } as RealmUser }).kc);
  const again = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'owner@acme-c2b.test' });
  expect(again.status).toBe(201);
});

test('remove: frees the seat — a 1-seat tenant can admit a replacement afterwards', async () => {
  await db.update(tenants).set({ max_members: 2 }).where(eq(tenants.id, TENANT));
  await db.insert(users).values({ id: MEMBER_SUB, email: 'seat@acme-c2b.test', name: 'Seat', tenant_id: TENANT });
  expect((await getSeatUsage(TENANT)).used).toBe(2);
  expect((await call('POST', `/api/tenants/${TENANT}/users`, { email: 'repl@acme-c2b.test' })).status).toBe(409);

  expect((await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`)).status).toBe(200);
  // A tombstone must not keep consuming a seat, or removal frees nothing.
  expect((await getSeatUsage(TENANT)).used).toBe(1);
  expect((await call('POST', `/api/tenants/${TENANT}/users`, { email: 'repl@acme-c2b.test' })).status).toBe(201);
});

test('remove: the tombstoned member is off the roster', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'off@acme-c2b.test', name: 'Off', tenant_id: TENANT });
  await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`);

  as(superAdmin);
  const roster = (await (await call('GET', `/api/tenants/${TENANT}/members`)).json()) as {
    members: { userId: string }[];
  };
  expect(roster.members.map((m) => m.userId)).not.toContain(MEMBER_SUB);
});

test('remove: REVOKES the MCP API key and the agent refresh chain', async () => {
  // Tombstoning ends neither credential implicitly (no CASCADE fires), so the sweep is explicit.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'api@acme-c2b.test', name: 'Api', tenant_id: TENANT });
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: MEMBER_SUB, name: 'k', scopes: [...DEFAULT_SCOPES] });
  const session = await withTenantDb(TENANT, () => issueAgentSession(MEMBER_SUB, [], TENANT));
  await expect(verifyKey(raw)).resolves.toMatchObject({ userId: MEMBER_SUB });

  const body = (await (await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`)).json()) as {
    keysRevoked: number; sessionsRevoked: number;
  };
  expect(body.keysRevoked).toBe(1);
  expect(body.sessionsRevoked).toBe(1);
  await expect(verifyKey(raw)).rejects.toThrow();
  await expect(withTenantDb(TENANT, () => refreshAgentSession(session.refreshToken))).rejects.toThrow();
});

test('remove: a tombstoned person cannot sign back in — ensureUser refuses (403)', async () => {
  // Their realm identity still authenticates (CP never deletes it), so this is the guard that matters.
  await db.insert(users).values({
    id: MEMBER_SUB, email: 'back@acme-c2b.test', name: 'Back', tenant_id: TENANT, deleted_at: new Date(),
  });
  let status = 0;
  try {
    await ensureUser({ id: MEMBER_SUB, email: 'back@acme-c2b.test', name: 'Back', roles: [] });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  expect(status).toBe(403);
  const rows = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
});

test('remove: a target user in ANOTHER tenant → 404, row preserved', async () => {
  await db.insert(users).values({ id: OTHER_SUB, email: 'other-off@acme-c2b.test', name: 'Other', tenant_id: OTHER_TENANT });
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${OTHER_SUB}`);
  expect(res.status).toBe(404);
  const rows = await db.select().from(users).where(eq(users.id, OTHER_SUB));
  expect(rows[0]!.deleted_at).toBeNull();
});

test('remove: a tenant_admin cannot remove themselves → 409', async () => {
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${TADMIN_ID}`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('cannot_offboard_self');
  const rows = await db.select().from(users).where(eq(users.id, TADMIN_ID));
  expect(rows[0]!.deleted_at).toBeNull();
});

test('remove: a super_admin removing the workspace’s LAST tenant_admin → 409 last_tenant_admin, row preserved', async () => {
  as(superAdmin);
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${TADMIN_ID}`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_tenant_admin');
  const rows = await db.select().from(users).where(eq(users.id, TADMIN_ID));
  expect(rows[0]!.deleted_at).toBeNull();
});

test('remove: a RETRY is idempotent and keeps the original tombstone timestamp', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'stuck@acme-c2b.test', name: 'Stuck', tenant_id: TENANT });
  expect((await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`)).status).toBe(200);
  const [first] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  // The target lookup deliberately does not filter tombstones, so a retry still finds the row.
  expect((await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_SUB}`)).status).toBe(200);
  const [second] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(second!.deleted_at!.getTime()).toBe(first!.deleted_at!.getTime());
});

// ---- move a user between workspaces (PATCH /api/admin/users/:userId/tenant) — DB only ----

const moveTo = (userId: string, tenantId: string, role?: string) =>
  call('PATCH', `/api/admin/users/${userId}/tenant`, role === undefined ? { tenantId } : { tenantId, role });

// A super_admin operating while some OTHER workspace is the RLS scope — production's shape.
const superAdminElsewhere: User = {
  id: SUPERADMIN_ID, email: 'sa-c2b@t', name: 'SA', roles: ['super_admin'], tenantId: OTHER_TENANT,
};

/** `moveTo`, but driven AS `cp_app` (rolbypassrls = false) with `app.current_tenant` = the
 *  OPERATOR'S OWN tenant — production's shape on both axes. */
const moveToUnderRls = (userId: string, tenantId: string, operatorTenant: string) =>
  withTenantDbAsRuntimeRoleForTests(operatorTenant, () => moveTo(userId, tenantId));

test('move: the column + level move, the seat moves, credentials die, audit is warn — zero Keycloak calls', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'mover@acme-c2b.test', name: 'Mover', tenant_id: TENANT, tenant_role: 'developer' });
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: MEMBER_SUB, name: 'k', scopes: [...DEFAULT_SCOPES] });
  const session = await withTenantDb(TENANT, () => issueAgentSession(MEMBER_SUB, [], TENANT));
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);

  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    userId: MEMBER_SUB, fromTenantId: TENANT, toTenantId: OTHER_TENANT,
    role: 'member', keysRevoked: 1, sessionsRevoked: 1,
    // `[]` is a positive assertion that the paid seat moved with the person (issuance OFF here).
    seatFailures: [],
  });
  expect(calls).toEqual([]);

  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(row!.tenant_role).toBe('member'); // an unstated level never carries across
  expect((await getSeatUsage(TENANT)).used).toBe(1); // TADMIN only
  expect((await getSeatUsage(OTHER_TENANT)).used).toBe(1);

  await expect(verifyKey(raw)).rejects.toThrow();
  await expect(withTenantDb(TENANT, () => refreshAgentSession(session.refreshToken))).rejects.toThrow();

  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'user.move'));
  expect(audit!.actor_id).toBe(SUPERADMIN_ID);
  expect(audit!.result_tone).toBe('warn');
  expect(audit!.metadata).toMatchObject({ fromTenantId: TENANT, toTenantId: OTHER_TENANT, role: 'member' });
});

test('move: a TOMBSTONED user is refused (409 user_offboarded)', async () => {
  await db.insert(users).values({
    id: MEMBER_SUB, email: 'gone@acme-c2b.test', name: 'Gone', tenant_id: TENANT, deleted_at: new Date(),
  });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('user_offboarded');
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: the SOURCE workspace’s LAST tenant_admin cannot be moved out (409 last_tenant_admin)', async () => {
  await db.update(users).set({ tenant_role: 'member' }).where(eq(users.id, TADMIN_ID));
  await db.insert(users).values({ id: MEMBER_SUB, email: 'lone@acme-c2b.test', name: 'Lone', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_tenant_admin');
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: the SOURCE workspace’s last LIVE member cannot be moved out (409 last_member)', async () => {
  // TADMIN is TENANT's only live member.
  as(superAdmin);
  const res = await moveTo(TADMIN_ID, OTHER_TENANT);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_member');
  const [row] = await db.select().from(users).where(eq(users.id, TADMIN_ID));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: one of TWO source admins moves fine (the guard fires only at the last one)', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'coadmin@acme-c2b.test', name: 'Co', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  as(superAdmin);
  expect((await moveTo(MEMBER_SUB, OTHER_TENANT)).status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
});

test('move: a destination at its seat cap is refused (409) and nothing moves', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'capped@acme-c2b.test', name: 'Capped', tenant_id: TENANT });
  await db.insert(users).values({ id: OTHER_SUB, email: 'sitting@acme-c2b.test', name: 'Sitting', tenant_id: OTHER_TENANT });
  await db.update(tenants).set({ max_members: 1 }).where(eq(tenants.id, OTHER_TENANT));
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('seat_limit_reached');
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: destination == current workspace with no role is a no-op — a lone admin keeps tenant_admin', async () => {
  as(superAdmin);
  const res = await moveTo(TADMIN_ID, TENANT);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ fromTenantId: TENANT, toTenantId: TENANT, role: 'tenant_admin', seatFailures: [] });
  expect(await roleOf(TADMIN_ID)).toBe('tenant_admin');
  expect(await db.select().from(auditLog).where(eq(auditLog.action, 'user.move'))).toHaveLength(0);
});

test('move: a tenant_admin is refused (403) — neither workspace is theirs to decide for', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'nope@acme-c2b.test', name: 'Nope', tenant_id: TENANT });
  as(tenantAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(403);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: a tenant_admin moved with NO role in the body arrives as a MEMBER, not an administrator', async () => {
  // The destination must never gain an administrator nobody chose.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'esc@acme-c2b.test', name: 'Esc', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  await db.insert(users).values({ id: OTHER_SUB, email: 'sitting@acme-c2b.test', name: 'Sitting', tenant_id: OTHER_TENANT });
  as(superAdmin);
  expect((await moveTo(MEMBER_SUB, OTHER_TENANT)).status).toBe(200);
  expect(await roleOf(MEMBER_SUB)).toBe('member');
  const members = await (await call('GET', `/api/tenants/${OTHER_TENANT}/members`)).json() as
    { members: { userId: string; role: string | null }[] };
  expect(members.members.find((m) => m.userId === MEMBER_SUB)?.role).toBe('member');
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'user.move'));
  expect(audit!.metadata).toMatchObject({ role: 'member' });
});

test('move: an EXPLICIT role is honoured, so making somebody an admin stays a decision on the record', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'promote@acme-c2b.test', name: 'Promote', tenant_id: TENANT, tenant_role: 'member' });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT, 'tenant_admin');
  expect(res.status).toBe(200);
  expect((await res.json() as { role: string }).role).toBe('tenant_admin');
  expect(await roleOf(MEMBER_SUB)).toBe('tenant_admin');
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'user.move'));
  expect(audit!.metadata).toMatchObject({ role: 'tenant_admin', actorSub: SUPERADMIN_ID });
});

test('move: a platform role in the body is a 422 and touches nothing', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'plat@acme-c2b.test', name: 'Plat', tenant_id: TENANT });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT, 'super_admin');
  expect(res.status).toBe(422);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(TENANT);
});

test('move: an UPPER-CASE tenantId is canonicalised before it reaches the column and the response', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'case@acme-c2b.test', name: 'Case', tenant_id: TENANT });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT.toUpperCase());
  expect(res.status).toBe(200);
  expect(((await res.json()) as { toTenantId: string }).toTenantId).toBe(OTHER_TENANT);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
});

test('move: a super_admin with NO local users row is still AUDITED (the production super_admin shape)', async () => {
  // `audit_log.actor_id` is a FK; an operator with no row must be attributed to System, not dropped.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'noaudit@acme-c2b.test', name: 'NoAudit', tenant_id: TENANT });
  await db.delete(users).where(eq(users.id, SUPERADMIN_ID));
  as(superAdmin);
  expect((await moveTo(MEMBER_SUB, OTHER_TENANT)).status).toBe(200);
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'user.move'));
  expect(audit).toBeDefined();
  expect(audit!.actor_id).toBeNull();
  expect(audit!.metadata).toMatchObject({ actorSub: SUPERADMIN_ID });
});

test('move: a HOMELESS user is seated in the destination as a member', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'homeless@acme-c2b.test', name: 'Homeless', tenant_id: null });
  as(superAdmin);
  const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
  expect(res.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(row!.tenant_role).toBe('member');
});

test('move: unknown user → 404; unprovisioned destination → 403', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'guard@acme-c2b.test', name: 'Guard', tenant_id: TENANT });
  as(superAdmin);
  expect((await moveTo(NEW_SUB, OTHER_TENANT)).status).toBe(404);
  const res = await moveTo(MEMBER_SUB, '00000000-0000-4000-8000-0000000c2b99');
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_not_provisioned');
});

// ---- the PAID seat follows the person (member_entitlements, 0089) -------------------------------
//
// ⛔ THE TEST ABOVE AT 'move: the column + level move' ASSERTS A SEAT MOVE AND MEANS A
// DIFFERENT SEAT. `getSeatUsage` counts `users.tenant_id`, so re-pointing the column really does
// move the HEADCOUNT seat — and that assertion passing is exactly why nobody noticed that the
// BILLED seat stayed behind. Since 0089 the invoice is driven by `member_entitlements`, which the
// column write does not touch: the source workspace kept paying for somebody who had left, and the
// destination got a member the licence gate denies. Two different objects, one word.
//
// No `mock.module` (house rule — module mocks leak process-wide on Bun). Same two levers every
// other entitlement test in this repo pulls: flip `config.license.issuanceEnabled` in place, and
// inject a fake SA client through `__setLicensesAdminForTests`. The real `ensureMemberEntitlement` /
// `revokeMemberEntitlement` bodies run, against the real CI postgres.

/** Valid v4 uuids — `license_id` / `license_subject_id` are uuid columns, so `lic-1` will not do. */
const LIC = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
const SUBJ = (i: number) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;

/**
 * Fake licences-service SA client that records the ORDER of what it was asked to do.
 *
 * `ops` is the load-bearing output, not the call counts: this whole slice is about one sequence
 * (release the source seat, THEN buy the destination's), and a set of assertions that each call
 * happened cannot tell that sequence from its reverse.
 *
 * The failure switches are keyed BY TENANT rather than being a bare boolean, because every test
 * here needs a WORKING mint for the source seat it seeds and a failing one for the leg under test.
 * A global `failCreate` would break the fixture and the subject at the same time.
 */
function makeLicenses(opts: {
  failCreateFor?: string;
  failRevokeFor?: string;
  /** Runs INSIDE `createLicense`, i.e. at the exact instant the destination seat is being bought —
   *  the only moment at which "is the source seat still live?" is answerable. */
  onCreateLicense?: (tenantId: string) => Promise<void>;
} = {}): { client: LicensesAdminClient; ops: string[] } {
  const ops: string[] = [];
  let n = 0;
  const client: LicensesAdminClient = {
    async ensureTenantRegistered() {},
    async createLicense(subjectId, tenantId) {
      ops.push(`create:${tenantId}:${subjectId}`);
      if (opts.onCreateLicense) await opts.onCreateLicense(tenantId);
      if (opts.failCreateFor === tenantId) throw new LicensesAdminError(503, 'licenses down');
      n += 1;
      return { licenseId: LIC(n), subjectId: SUBJ(n) };
    },
    async createToken(licenseId) {
      ops.push('token');
      return { token: `token-${licenseId}` };
    },
    async revokeByToken(_token, tenantId) {
      ops.push(`revokeToken:${tenantId}`);
      if (opts.failRevokeFor === tenantId) throw new LicensesAdminError(503, 'licenses down');
    },
    async revokeByLicenseId(_licenseId, tenantId) {
      ops.push(`revoke:${tenantId}`);
      if (opts.failRevokeFor === tenantId) throw new LicensesAdminError(503, 'licenses down');
    },
  };
  return { client, ops };
}

/** `config.license` is a live singleton shared by the whole bun process, so the restore is not
 *  hygiene — leaving issuance ON leaks into every other file in the run. `false` is the CI/prod
 *  default (`LICENSE_ISSUANCE_ENABLED` is unset in tests/setup-env.ts), which is also what every
 *  other test in THIS file assumes. */
async function withIssuance<T>(client: LicensesAdminClient, fn: () => Promise<T>): Promise<T> {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  __setLicensesAdminForTests(client);
  try {
    return await fn();
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
}

const entRow = (tenantId: string, userId: string) =>
  db
    .select()
    .from(memberEntitlements)
    .where(and(eq(memberEntitlements.tenant_id, tenantId), eq(memberEntitlements.user_id, userId)));

type MoveBody = { seatFailures: { userId: string; tenantId: string; message: string }[] };

test('move: the PAID seat is handed over — revoked in the SOURCE, then ensured in the DESTINATION', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'seat@acme-c2b.test', name: 'Seat', tenant_id: TENANT });
  __setKeycloakAdminForTests(makeKc().kc);
  const lic = makeLicenses();

  as(superAdmin);
  const res = await withIssuance(lic.client, async () => {
    // The seat TENANT is currently being invoiced for.
    await ensureMemberEntitlement(TENANT, MEMBER_SUB, MEMBER_SUB);
    return moveTo(MEMBER_SUB, OTHER_TENANT);
  });
  expect(res.status).toBe(200);

  // ⚠️ MUTATION TARGET: delete the `HAND THE PAID SEAT OVER` block in `moveUserHomeTenant` (or
  // either of its two calls) and this reads `[create:TENANT, token]` alone — the source keeps an
  // ACTIVE, billed licence for somebody who has left, and the destination never buys one.
  expect(lic.ops).toEqual([
    `create:${TENANT}:${MEMBER_SUB}`, 'token', // the seat seeded above
    `revoke:${TENANT}`,                         // released by the workspace they left…
    `create:${OTHER_TENANT}:${MEMBER_SUB}`, 'token', // …bought by the one they joined
  ]);

  const [from] = await entRow(TENANT, MEMBER_SUB);
  const [to] = await entRow(OTHER_TENANT, MEMBER_SUB);
  expect(from!.status).toBe('revoked');
  expect(to!.status).toBe('active');
  // A clean handover says so positively; see the `seatFailures` note on the response.
  expect(((await res.json()) as MoveBody).seatFailures).toEqual([]);
}, 30_000);

test('move: the source seat is released BEFORE the destination is minted — never two billed seats', async () => {
  // ⛔ `member_entitlements_live_uq` is PARTIAL-unique on (tenant, user, app), so nothing in the
  // schema prevents one person holding a live row in BOTH workspaces. Ensure-then-revoke double-bills
  // them for the width of the window — and if the revoke then fails, permanently. The reverse
  // residue (released, not yet licensed) is what the onboarding-integrity reconciler repairs.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'order@acme-c2b.test', name: 'Order', tenant_id: TENANT });
  __setKeycloakAdminForTests(makeKc().kc);
  let sourceStatusAtMint: string | null | undefined;
  const lic = makeLicenses({
    onCreateLicense: async (tenantId) => {
      if (tenantId !== OTHER_TENANT) return;
      const [row] = await entRow(TENANT, MEMBER_SUB);
      sourceStatusAtMint = row?.status ?? null;
    },
  });

  as(superAdmin);
  const res = await withIssuance(lic.client, async () => {
    await ensureMemberEntitlement(TENANT, MEMBER_SUB, MEMBER_SUB);
    return moveTo(MEMBER_SUB, OTHER_TENANT);
  });
  expect(res.status).toBe(200);

  // ⚠️ MUTATION TARGET: swap the revoke and the ensure in the handover block and this reads
  // `'active'` — at the instant the destination's licence is minted the source's is still live, so
  // licences-service counts this person as two `human_subjects` entries and two invoices.
  expect(sourceStatusAtMint).toBe('revoked');
}, 30_000);

test('move: a failed SOURCE revoke does NOT fail the move — the row stays `revoking` for the sweep', async () => {
  // Same policy as `offboardTenantUser`: a licences outage is a BILLING outcome, not a security one.
  // The person is already in the destination and their old credentials are already dead, so a 502 here would
  // report a move that genuinely happened as a failure.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'revfail@acme-c2b.test', name: 'RevFail', tenant_id: TENANT });
  __setKeycloakAdminForTests(makeKc().kc);
  const lic = makeLicenses({ failRevokeFor: TENANT });

  as(superAdmin);
  const res = await withIssuance(lic.client, async () => {
    await ensureMemberEntitlement(TENANT, MEMBER_SUB, MEMBER_SUB);
    return moveTo(MEMBER_SUB, OTHER_TENANT);
  });

  // ⚠️ MUTATION TARGET: drop the `try/catch` around `revokeMemberEntitlement` in the handover block
  // and this is a 502 with the column already committed — a completed move reported as a failure,
  // which invites a retry of an operation that has already happened.
  expect(res.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);

  // ⚠️ MUTATION TARGET: swallow the error instead of pushing it (drop the `seatFailures.push`) and
  // an unreleased, still-billed seat becomes indistinguishable from a released one.
  const body = (await res.json()) as MoveBody;
  expect(body.seatFailures).toHaveLength(1);
  expect(body.seatFailures[0]).toMatchObject({ userId: MEMBER_SUB, tenantId: TENANT });

  // `revoking` is the honest "unreleased" state AND `releaseStuckSeats`'s queue. Tombstoning it here
  // would tell the sweep there is nothing left to do.
  const [from] = await entRow(TENANT, MEMBER_SUB);
  expect(from!.status).toBe('revoking');

  // ⚠️ MUTATION TARGET: put the destination ensure inside the source revoke's `try` and this is
  // `undefined` — one workspace's licences outage silently leaves the arriving member unlicensed in
  // a workspace whose licences service is perfectly healthy.
  const [to] = await entRow(OTHER_TENANT, MEMBER_SUB);
  expect(to!.status).toBe('active');
}, 30_000);

test('move: a failed DESTINATION ensure does NOT roll the move back — the reconciler picks it up', async () => {
  await db.insert(users).values({ id: MEMBER_SUB, email: 'ensfail@acme-c2b.test', name: 'EnsFail', tenant_id: TENANT });
  __setKeycloakAdminForTests(makeKc().kc);
  const lic = makeLicenses({ failCreateFor: OTHER_TENANT });

  as(superAdmin);
  const res = await withIssuance(lic.client, async () => {
    await ensureMemberEntitlement(TENANT, MEMBER_SUB, MEMBER_SUB);
    return moveTo(MEMBER_SUB, OTHER_TENANT);
  });

  // ⚠️ MUTATION TARGET: let `ensureMemberEntitlement`'s 502 propagate (drop its `try/catch`) and the
  // move is reported as failed although the column and the level have both
  // committed — and the SOURCE seat has already been released, so a retry cannot reconstruct the
  // starting state either.
  expect(res.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, MEMBER_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);

  const body = (await res.json()) as MoveBody;
  expect(body.seatFailures).toHaveLength(1);
  // ⚠️ MUTATION TARGET: drop `tenantId` from the pushed entry and the two legs become
  // indistinguishable — "still billed by the old workspace" and "unlicensed in the new one" need
  // opposite repairs, and both carry the same `userId`.
  expect(body.seatFailures[0]).toMatchObject({ userId: MEMBER_SUB, tenantId: OTHER_TENANT });

  // The source seat is genuinely released (it is not held back "just in case"), and the destination
  // row is parked at `error` — which is what the reconciler re-claims, per the claim statement's
  // `status = 'error'` arm.
  const [from] = await entRow(TENANT, MEMBER_SUB);
  expect(from!.status).toBe('revoked');
  const [to] = await entRow(OTHER_TENANT, MEMBER_SUB);
  expect(to!.status).toBe('error');
}, 30_000);

test('move: the same-workspace REPAIR case hands no seat over — nothing revoked, nothing minted', async () => {
  // The same-workspace case (destination == current home tenant) moves nobody between workspaces, so
  // there is no seat to hand over. Revoking here would release a seat the tenant still owes and hand
  // the member a `revoking` row for a move that moved nobody.
  __setKeycloakAdminForTests(makeKc().kc);
  const lic = makeLicenses();

  as(superAdmin);
  const res = await withIssuance(lic.client, async () => {
    await ensureMemberEntitlement(TENANT, TADMIN_ID, TADMIN_ID);
    return moveTo(TADMIN_ID, TENANT);
  });
  expect(res.status).toBe(200);

  // ⚠️ MUTATION TARGET: drop the `if (changesWorkspace)` guard on the handover block and this gains
  // `revoke:TENANT` + a re-mint — a repair that bills a fresh licence and, in the window between
  // them, denies the person at the gate.
  expect(lic.ops).toEqual([`create:${TENANT}:${TADMIN_ID}`, 'token']);
  const [row] = await entRow(TENANT, TADMIN_ID);
  expect(row!.status).toBe('active');
  expect(((await res.json()) as MoveBody).seatFailures).toEqual([]);
}, 30_000);

test('move: with licence issuance OFF the handover is a pure no-op (the F.2 ship state)', async () => {
  // The flag is OFF in CI and in prod today, and every other move test in this file runs in that
  // state. This one pins that the new block inherits the same dormancy the rest of F.2 has rather
  // than reaching for the SA client the flag says is never constructed.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'flagoff@acme-c2b.test', name: 'FlagOff', tenant_id: TENANT });
  __setKeycloakAdminForTests(makeKc().kc);
  const lic = makeLicenses();
  __setLicensesAdminForTests(lic.client);
  try {
    as(superAdmin);
    const res = await moveTo(MEMBER_SUB, OTHER_TENANT);
    expect(res.status).toBe(200);
    expect(lic.ops).toEqual([]);
    expect(((await res.json()) as MoveBody).seatFailures).toEqual([]);
    expect(await entRow(OTHER_TENANT, MEMBER_SUB)).toHaveLength(0);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

// ---- members roster — the level is CP's own column ----

test('members: roster reads each member’s level from users.tenant_role (NULL → member), no Keycloak call', async () => {
  await db.insert(users).values([
    { id: MEMBER_SUB, email: 'm1@acme-c2b.test', name: 'M1', tenant_id: TENANT, tenant_role: 'developer' },
    { id: NEW_SUB, email: 'm2@acme-c2b.test', name: 'M2', tenant_id: TENANT }, // not backfilled
  ]);
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('GET', `/api/tenants/${TENANT}/members`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { members: { userId: string; role: string }[] };
  const byId = Object.fromEntries(body.members.map((m) => [m.userId, m.role]));
  expect(byId).toEqual({ [TADMIN_ID]: 'tenant_admin', [MEMBER_SUB]: 'developer', [NEW_SUB]: 'member' });
  // No Keycloak dependency, so no outage flag either.
  expect(Object.keys(body)).toEqual(['members']);
  expect(calls).toEqual([]);
});

// ---- seat cap (0044) — counted against members + pending invites ----

test('invite is a 409 seats_full at the cap, and mints NO Keycloak identity', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  await db.update(tenants).set({ max_members: 1 }).where(eq(tenants.id, TENANT));

  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'overflow@seatcap.test', role: 'member' });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string; details?: { max: number }; max?: number };
  expect(body.error).toBe('seats_full');
  expect(body.details?.max ?? body.max).toBe(1);
  expect(calls.some((c) => c.op === 'createRealmUser')).toBe(false);
});

test('an uncapped tenant is unaffected (every pre-0044 tenant)', async () => {
  await db.update(tenants).set({ max_members: null }).where(eq(tenants.id, TENANT));
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'uncapped@seatcap.test', role: 'member' });
  expect(res.status).toBe(201);
});

test('raising the cap immediately unblocks the next invite', async () => {
  await db.update(tenants).set({ max_members: 1 }).where(eq(tenants.id, TENANT));
  expect((await call('POST', `/api/tenants/${TENANT}/users`, { email: 'a@seatcap.test' })).status).toBe(409);
  await db.update(tenants).set({ max_members: 50 }).where(eq(tenants.id, TENANT));
  expect((await call('POST', `/api/tenants/${TENANT}/users`, { email: 'b@seatcap.test' })).status).toBe(201);
});

test('two invites racing for the LAST seat: exactly one wins', async () => {
  // `assertInviteSeatInTx` holds FOR UPDATE on the tenant row across the insert, so the second racer
  // blocks on the first and re-counts (members + pending invites).
  await db.update(tenants).set({ max_members: 2 }).where(eq(tenants.id, TENANT)); // TADMIN + one seat
  const A = '00000000-0000-4000-8000-0000000c2f01';
  const B = '00000000-0000-4000-8000-0000000c2f02';
  // ONE fake handing out a distinct sub per call (re-setting the global per arm would itself race).
  const subs = [A, B];
  let issued = 0;
  __setKeycloakAdminForTests({ ...makeKc().kc, createRealmUser: async () => subs[issued++] ?? B });
  const results = await Promise.allSettled([
    call('POST', `/api/tenants/${TENANT}/users`, { email: 'race-a@seatcap.test' }),
    call('POST', `/api/tenants/${TENANT}/users`, { email: 'race-b@seatcap.test' }),
  ]);
  const codes = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 500));
  expect(codes.filter((c) => c === 201).length).toBe(1);
  expect(codes.filter((c) => c === 409).length).toBe(1);
  const pending = (await invitesFor(TENANT)).filter((i) => i.status === 'pending');
  expect(pending).toHaveLength(1); // never over-admitted
});

test('move: the moved user\'s MCP key and agent session are revoked even when the operator is homed elsewhere', async () => {
  // ⛔ WHY THE TEST ABOVE CANNOT CATCH THIS, TWICE OVER. It runs as the table OWNER
  // (rolbypassrls = true), so RLS never binds at all — and its operator is homed in the SOURCE
  // tenant, so even under `cp_app` the credential rows would be visible. Production is neither:
  // the runtime role is `cp_app`, and a platform super_admin's own scope is some other
  // workspace entirely.
  //
  // `mcp_api_keys` and `agent_sessions` are BOTH under strict RLS, and `requireSuperAdmin` never
  // calls `refreshTenantGuc` (admin-guards.ts) — so `revokeKeysIssuedBy` / `revokeSessionsFor`
  // matched ZERO rows and returned 0. The route then reported a 200 with `keysRevoked: 0` while
  // the moved person's MCP key kept serving the workspace they had just been removed from, which
  // is precisely the hole the comment block at that call site says it closes. Measured directly
  // before the fix: bare call revoked 0 and the key stayed live; under `runAsSystem`, 1 and dead.
  await db.insert(users).values({ id: MEMBER_SUB, email: 'elsewhere@acme-c2b.test', name: 'Elsewhere', tenant_id: TENANT });
  const { raw } = await mintKey({ tenantId: TENANT, issuedBy: MEMBER_SUB, name: 'k', scopes: [...DEFAULT_SCOPES] });
  const session = await withTenantDb(TENANT, () => issueAgentSession(MEMBER_SUB, [], TENANT));
  const { kc } = makeKc();
  __setKeycloakAdminForTests(kc);

  as(superAdminElsewhere);
  const res = await moveToUnderRls(MEMBER_SUB, OTHER_TENANT, OTHER_TENANT);
  expect(res.status).toBe(200);

  // ⛔ THE NUMBERS THE 200 CANNOT STAND IN FOR. `0` here is what the defect reported, and it reads
  // as "there was nothing to revoke".
  expect(await res.json()).toMatchObject({ keysRevoked: 1, sessionsRevoked: 1 });

  // And the credentials are ACTUALLY dead, not merely counted.
  await expect(verifyKey(raw)).rejects.toThrow();
  await expect(withTenantDb(TENANT, () => refreshAgentSession(session.refreshToken))).rejects.toThrow();
});
