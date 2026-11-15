// tests/tenant-invites.test.ts — CP-owned membership: invites, levels and removal.
//
// Live routes (routes/tenant-users.ts) against the test postgres, identity injected via
// __setAuthOverridesForTests and Keycloak replaced by a recording fake. Proves: an address homed
// in another workspace is refused BEFORE any Keycloak call; the seat cap counts pending invites;
// acceptance demands a verified, matching email and a live invite, and seats the user with the
// invite's level; level changes and removals never touch Keycloak; the last tenant_admin stays.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, users, tenants, auditLog, memberEntitlements, signupApprovals, identityProviders } from '../src/db/client';
import { config } from '../src/config';
import { registerAdminRoutes } from '../src/routes/admin';
import { hydrateCpIdentity, __resetCpIdentityForTests } from '../src/services/cp-identity';
import { __setLicensesAdminForTests, type LicensesAdminClient } from '../src/services/licenses-admin';
import { tenantInvites } from '../src/db/schema';
import { Router } from '../src/utils/router';
import { registerTenantUserRoutes } from '../src/routes/tenant-users';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { hashToken, maskEmail } from '../src/services/invite-service';
import {
  __setKeycloakAdminForTests,
  type KeycloakAdminClient,
  type RealmUser,
} from '../src/services/keycloak-admin';
import { __setMailTransportForTests } from '../src/host/mailer';
import type { User } from '../src/types';

const TENANT = '00000000-0000-4000-8000-00000e1a0001';
const OTHER_TENANT = '00000000-0000-4000-8000-00000e1a0002';
const TADMIN_ID = '00000000-0000-4000-8000-00000e1a0010';
const MEMBER_ID = '00000000-0000-4000-8000-00000e1a0011';
const OTHER_ID = '00000000-0000-4000-8000-00000e1a0012';
const INVITEE_ID = '00000000-0000-4000-8000-00000e1a0013';
const NEW_SUB = '00000000-0000-4000-8000-00000e1a0014';
const SUPER_ID = '00000000-0000-4000-8000-00000e1a00ff';
const SSO_ID = '00000000-0000-4000-8000-00000e1a0015';
const SEEDED = [TADMIN_ID, MEMBER_ID, OTHER_ID, INVITEE_ID, NEW_SUB, SUPER_ID, SSO_ID];
const TENANT_IDS = [TENANT, OTHER_TENANT];

const tenantAdmin: User = {
  id: TADMIN_ID,
  email: 'ta@e1a.test',
  name: 'TA',
  roles: ['tenant_admin'],
  tenantId: TENANT,
  tenantRole: 'tenant_admin',
  emailVerified: true,
};
const superAdmin: User = {
  id: SUPER_ID,
  email: 'sa@e1a.test',
  name: 'SA',
  roles: ['super_admin'],
  emailVerified: true,
};
const invitee = (over: Partial<User> = {}): User => ({
  id: INVITEE_ID,
  email: 'invitee@e1a.test',
  name: 'Ivy Invitee',
  roles: [],
  emailVerified: true,
  ...over,
});

interface KcCall { op: string; args: unknown[] }
function makeKc(
  opts: {
    findResult?: RealmUser | null;
    /** `GET users/{id}/credentials`; null = refused (403). Absent → method not implemented. */
    credentials?: { type: string }[] | null;
    federated?: { identityProvider: string }[] | null;
  } = {},
) {
  const calls: KcCall[] = [];
  const rec = (op: string) => async (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const kc: KeycloakAdminClient = {
    async createRealmUser(input) {
      calls.push({ op: 'createRealmUser', args: [input] });
      return NEW_SUB;
    },
    logoutUser: rec('logoutUser'),
    executeActionsEmail: rec('executeActionsEmail'),
    deleteRealmUser: rec('deleteRealmUser'),
    async listRealmUsers() {
      calls.push({ op: 'listRealmUsers', args: [] });
      return [];
    },
    async findRealmUserByUsernameOrEmail(username, email) {
      calls.push({ op: 'findRealmUserByUsernameOrEmail', args: [username, email] });
      return opts.findResult ?? null;
    },
    backfillUserEmail: rec('backfillUserEmail'),
    backfillUserNames: rec('backfillUserNames'),
    async getRealmRolesForUsers(ids) {
      calls.push({ op: 'getRealmRolesForUsers', args: [ids] });
      return new Map(ids.map((i) => [i, [] as string[]]));
    },
    createIdentityProvider: rec('createIdentityProvider'),
    async getIdentityProvider() {
      return null;
    },
    updateIdentityProvider: rec('updateIdentityProvider'),
    deleteIdentityProvider: rec('deleteIdentityProvider'),
    createIdpMapper: rec('createIdpMapper'),
    async listIdpMappers() {
      return [];
    },
    deleteIdpMapper: rec('deleteIdpMapper'),
    ...('credentials' in opts
      ? {
          async getUserCredentials(id: string) {
            calls.push({ op: 'getUserCredentials', args: [id] });
            return opts.credentials ?? null;
          },
        }
      : {}),
    ...('federated' in opts
      ? {
          async getFederatedIdentities(id: string) {
            calls.push({ op: 'getFederatedIdentities', args: [id] });
            return opts.federated ?? null;
          },
        }
      : {}),
  };
  return { kc, calls };
}

const router = new Router();
registerTenantUserRoutes(router);
registerOnboardingRoutes(router);
registerAdminRoutes(router);

let currentUser: User = tenantAdmin;
async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path);
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

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED));
  await db.delete(auditLog).where(inArray(auditLog.tenant_id, TENANT_IDS));
  await db.delete(tenantInvites).where(inArray(tenantInvites.tenant_id, TENANT_IDS));
  await db.delete(signupApprovals).where(inArray(signupApprovals.email, ['approve-me@e1a.test']));
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, SEEDED));
  await db.delete(users).where(inArray(users.id, SEEDED));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

async function seedInvite(over: Partial<typeof tenantInvites.$inferInsert> & { token: string }) {
  const { token, ...rest } = over;
  const [row] = await db
    .insert(tenantInvites)
    .values({
      tenant_id: TENANT,
      email: 'invitee@e1a.test',
      role: 'developer',
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + 86_400_000),
      ...rest,
    })
    .returning();
  return row!;
}

beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => currentUser });
  __resetCpIdentityForTests();
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT, name: 'E1a Tenant', slug: 'e1a-tenant' },
    { id: OTHER_TENANT, name: 'E1a Other', slug: 'e1a-other' },
  ]);
  await db.insert(users).values([
    { id: TADMIN_ID, email: tenantAdmin.email, name: 'TA', tenant_id: TENANT, tenant_role: 'tenant_admin' },
    { id: SUPER_ID, email: superAdmin.email, name: 'SA', tenant_id: null },
  ]);
  __setKeycloakAdminForTests(makeKc().kc);
  currentUser = tenantAdmin;
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

test('invite: an address homed in another workspace → 409 email_in_other_tenant, zero Keycloak calls', async () => {
  await db.insert(users).values({ id: OTHER_ID, email: 'taken@e1a.test', name: 'O', tenant_id: OTHER_TENANT });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'TAKEN@e1a.test' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('email_in_other_tenant');
  expect(calls).toEqual([]);
  expect(await db.select().from(tenantInvites).where(eq(tenantInvites.tenant_id, TENANT))).toEqual([]);
});

test('invite: a new address mints a bare identity and sends the action email with the accept link', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'new@e1a.test', role: 'developer' });
  expect(res.status).toBe(201);
  const { invite } = (await res.json()) as { invite: { role: string; inviteUrl: string; emailDelivery: string } };
  expect(invite.role).toBe('developer');
  expect(invite.inviteUrl).toContain('/invite/accept?token=');
  expect(invite.emailDelivery).toBe('keycloak_actions');
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).not.toHaveProperty('attributes');
  const mail = calls.find((c) => c.op === 'executeActionsEmail');
  expect(mail?.args[1]).toEqual(['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
  expect((mail?.args[2] as { redirectUri: string }).redirectUri).toBe(invite.inviteUrl);
});

// ⛔ The portal realm REQUIRES first + last name: an identity minted without them is stopped at
// Keycloak's VERIFY_PROFILE form on first sign-in (a brand-new tenant admin hit it 2026-10-13).
test('invite: explicit firstName/lastName reach the minted identity (a spaced surname is not re-split)', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, {
    email: 'named@e1a.test',
    firstName: 'Jan',
    lastName: 'van der Berg',
  });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'Jan', lastName: 'van der Berg' });
  expect(create?.args[0]).not.toHaveProperty('attributes');
});

test('invite: a one-word `name` fills BOTH realm names (fr parity — no VERIFY_PROFILE stop)', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'cher@e1a.test', name: 'Cher' });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'Cher', lastName: 'Cher' });
});

test('invite: no name at all → the email local part fills BOTH realm names (fr parity)', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'nameless@e1a.test' });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'nameless', lastName: 'nameless' });
});

test('invite: ONLY firstName → it fills lastName too (never an empty realm half)', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'onlyfirst@e1a.test', firstName: 'Jan' });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'Jan', lastName: 'Jan' });
});

test('invite: ONLY lastName → it fills firstName too, and beats a `name` split', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, {
    email: 'onlylast@e1a.test',
    name: 'Ignored Person',
    lastName: 'van der Berg',
  });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'van der Berg', lastName: 'van der Berg' });
});

test('invite: neither firstName nor lastName → `name` is split (fr rule)', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'split@e1a.test', name: 'Anna van der Berg' });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'Anna', lastName: 'van der Berg' });
});

test('super_admin POST /api/invites: explicit firstName/lastName reach the minted identity', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  currentUser = superAdmin;
  const res = await call('POST', '/api/invites', {
    email: 'first-admin@e1a.test',
    tenantId: TENANT,
    role: 'tenant_admin',
    firstName: 'Marieke',
    lastName: 'de Vries',
  });
  expect(res.status).toBe(201);
  const create = calls.find((c) => c.op === 'createRealmUser');
  expect(create?.args[0]).toMatchObject({ firstName: 'Marieke', lastName: 'de Vries' });
});

test('invite: an EXISTING identity with empty names gets them filled — profile only, never a tenancy write', async () => {
  const { kc, calls } = makeKc({ findResult: { ...existingNoPassword, firstName: '', lastName: undefined } });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, {
    email: 'invitee@e1a.test',
    firstName: 'Ivy',
    lastName: 'Invitee',
  });
  expect(res.status).toBe(201);
  const fill = calls.filter((c) => c.op === 'backfillUserNames');
  expect(fill.map((c) => c.args)).toEqual([[INVITEE_ID, 'Ivy', 'Invitee']]);
  // The only Keycloak writes are the names fill and the action email — no role or attribute write.
  expect(calls.some((c) => c.op === 'createRealmUser')).toBe(false);
});

test('invite: an existing identity that already HAS names is left alone', async () => {
  const { kc, calls } = makeKc({
    findResult: { ...existingNoPassword, firstName: 'Ivy', lastName: 'Already' },
  });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, {
    email: 'invitee@e1a.test',
    firstName: 'Other',
    lastName: 'Name',
  });
  expect(res.status).toBe(201);
  expect(calls.some((c) => c.op === 'backfillUserNames')).toBe(false);
});

test('invite: seats_full counts PENDING invites, not just members', async () => {
  await db.update(tenants).set({ max_members: 2 }).where(eq(tenants.id, TENANT));
  // 1 member (TA) + 0 pending → room for one invite.
  const first = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'one@e1a.test' });
  expect(first.status).toBe(201);
  // 1 member + 1 pending = 2 = max → full, though only ONE person is actually a member.
  const second = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'two@e1a.test' });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error: string }).error).toBe('seats_full');
});

test('accept: refuses an unverified email', async () => {
  await seedInvite({ token: 'tok-unverified-0123456789' });
  currentUser = invitee({ emailVerified: false });
  const res = await call('POST', '/api/invites/accept', { token: 'tok-unverified-0123456789' });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('email_not_verified');
});

test('accept: refuses a mismatched email', async () => {
  await seedInvite({ token: 'tok-mismatch-0123456789ab' });
  currentUser = invitee({ email: 'someone-else@e1a.test' });
  const res = await call('POST', '/api/invites/accept', { token: 'tok-mismatch-0123456789ab' });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('invite_email_mismatch');
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u).toBeUndefined();
});

test('accept: refuses an expired invite (410) and marks it expired', async () => {
  const inv = await seedInvite({ token: 'tok-expired-0123456789abc', expires_at: new Date(Date.now() - 1000) });
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-expired-0123456789abc' });
  expect(res.status).toBe(410);
  expect(((await res.json()) as { error: string }).error).toBe('invite_expired');
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('expired');
});

test("accept: seats the user with the invite's tenant_role and marks the invite accepted", async () => {
  const inv = await seedInvite({ token: 'tok-accept-0123456789abcd', role: 'developer' });
  currentUser = invitee({ email: 'INVITEE@e1a.test' }); // case-insensitive match
  const res = await call('POST', '/api/invites/accept', { token: 'tok-accept-0123456789abcd' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tenantId: TENANT, role: 'developer' });
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u?.tenant_id).toBe(TENANT);
  expect(u?.tenant_role).toBe('developer');
  expect(u?.keycloak_sub).toBe(INVITEE_ID);
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('accepted');
  expect(row?.accepted_by).toBe(INVITEE_ID);
});

test('PATCH role: updates users.tenant_role and makes ZERO Keycloak calls', async () => {
  await db.insert(users).values({ id: MEMBER_ID, email: 'm@e1a.test', name: 'M', tenant_id: TENANT, tenant_role: 'member' });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_ID}`, { role: 'tenant_admin' });
  expect(res.status).toBe(200);
  expect(calls).toEqual([]);
  const [u] = await db.select().from(users).where(eq(users.id, MEMBER_ID));
  expect(u?.tenant_role).toBe('tenant_admin');
});

test('PATCH role: demoting the last tenant_admin → 409 last_tenant_admin', async () => {
  currentUser = superAdmin;
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${TADMIN_ID}`, { role: 'member' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('last_tenant_admin');
  const [u] = await db.select().from(users).where(eq(users.id, TADMIN_ID));
  expect(u?.tenant_role).toBe('tenant_admin');
});

test('DELETE member: tombstones and revokes their pending invites, never deletes the realm user', async () => {
  await db.insert(users).values({ id: MEMBER_ID, email: 'gone@e1a.test', name: 'G', tenant_id: TENANT, tenant_role: 'member' });
  const inv = await seedInvite({ token: 'tok-gone-0123456789abcdef', email: 'gone@e1a.test' });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('DELETE', `/api/tenants/${TENANT}/users/${MEMBER_ID}`);
  expect(res.status).toBe(200);
  expect(calls.some((c) => c.op === 'deleteRealmUser')).toBe(false);
  const [u] = await db.select().from(users).where(eq(users.id, MEMBER_ID));
  expect(u?.deleted_at).not.toBeNull();
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('revoked');
});

test("approve (existing): seats the requester's known sub with the level, no Keycloak writes", async () => {
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'approve-me@e1a.test', name: 'Ann', keycloak_sub: INVITEE_ID })
    .returning();
  // The realm must vouch that the queued sub OWNS the address (verified) before approve seats it.
  const { kc, calls } = makeKc({
    findResult: { id: INVITEE_ID, username: 'approve-me@e1a.test', email: 'approve-me@e1a.test', emailVerified: true },
  });
  __setKeycloakAdminForTests(kc);
  currentUser = superAdmin;
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {
    mode: 'existing',
    tenantId: TENANT,
    role: 'developer',
  });
  expect(res.status).toBe(200);
  // read-only: the ownership lookup, then the platform-account check
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u?.tenant_id).toBe(TENANT);
  expect(u?.tenant_role).toBe('developer');
  const [a] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(a?.status).toBe('approved');
});

// ---- adversarial-review regressions --------------------------------------------------------------

/** A licences fake that records every mint, with issuance switched on for the duration of `fn`. */
async function withIssuance<T>(fn: (mints: string[]) => Promise<T>): Promise<T> {
  const mints: string[] = [];
  const client = {
    async ensureTenantRegistered() {},
    async createLicense(subjectId: string, tenantId: string) {
      mints.push(`${tenantId}:${subjectId}`);
      return { licenseId: '00000000-0000-4000-8000-000017e0a1c0', subjectId };
    },
    async createToken() {
      return { token: 'tok' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
    async getActiveLicense() {
      return null;
    },
  } as unknown as LicensesAdminClient;
  __setLicensesAdminForTests(client);
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    return await fn(mints);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
}

test('accept: a licence failure AFTER the seat is committed → 200 setupPending, seated, entitlement parked for the tick, status seat_pending', async () => {
  await seedInvite({ token: 'tok-pending-0123456789abc', role: 'developer' });
  currentUser = invitee();
  const failing = {
    async ensureTenantRegistered() {},
    async createLicense() {
      throw new Error('licences down');
    },
    async createToken() {
      return { token: 'tok' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
    async getActiveLicense() {
      return null;
    },
  } as unknown as LicensesAdminClient;
  __setLicensesAdminForTests(failing);
  const lic = config.license as { issuanceEnabled: boolean; perMemberGate: boolean };
  const wasGate = lic.perMemberGate;
  lic.issuanceEnabled = true;
  try {
    const res = await call('POST', '/api/invites/accept', { token: 'tok-pending-0123456789abc' });
    // NOT an error page: the person IS a member now.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: TENANT, role: 'developer', setupPending: true });
    const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
    expect(u?.tenant_id).toBe(TENANT);
    // A row the reconciler re-claims at once (`error`), with the cause on it.
    const ents = await db.select().from(memberEntitlements).where(eq(memberEntitlements.user_id, INVITEE_ID));
    expect(ents.map((e) => e.status)).toEqual(['error']);
    expect(ents[0]!.last_error).toContain('licences down');

    // …and the licence status says "being set up", not "ask for a seat".
    lic.perMemberGate = true;
    const { getLicenseStatus } = await import('../src/lib/license-status');
    const status = await getLicenseStatus({ appKey: 'commonpractice', tenantId: TENANT, gateEnabled: true, userId: INVITEE_ID });
    expect(status.state).toBe('seat_pending');
    expect(status.hasLicense).toBe(false);

    // Control: a member with NO entitlement row at all is still `no_seat`.
    await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, INVITEE_ID));
    const bare = await getLicenseStatus({ appKey: 'commonpractice', tenantId: TENANT, gateEnabled: true, userId: INVITEE_ID });
    expect(bare.state).toBe('no_seat');
  } finally {
    lic.issuanceEnabled = false;
    lic.perMemberGate = wasGate;
    __setLicensesAdminForTests(undefined);
  }
});

test('accept (control): a licence setup that succeeds carries NO setupPending flag', async () => {
  await seedInvite({ token: 'tok-ok-setup-0123456789ab', role: 'developer' });
  currentUser = invitee();
  await withIssuance(async () => {
    const res = await call('POST', '/api/invites/accept', { token: 'tok-ok-setup-0123456789ab' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: TENANT, role: 'developer' });
  });
});

test('MED-2: replaying an accepted invite after removal → 410, and no licence is minted', async () => {
  await seedInvite({ token: 'tok-replay-0123456789abcd' });
  currentUser = invitee();
  expect((await call('POST', '/api/invites/accept', { token: 'tok-replay-0123456789abcd' })).status).toBe(200);
  currentUser = tenantAdmin;
  expect((await call('DELETE', `/api/tenants/${TENANT}/users/${INVITEE_ID}`)).status).toBe(200);

  currentUser = invitee();
  await withIssuance(async (mints) => {
    const res = await call('POST', '/api/invites/accept', { token: 'tok-replay-0123456789abcd' });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe('invite_not_pending');
    expect(mints).toEqual([]);
  });
  expect(await db.select().from(memberEntitlements).where(eq(memberEntitlements.user_id, INVITEE_ID))).toEqual([]);
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u?.deleted_at).not.toBeNull();
});

test('MED-3: a stale invite accepted by a current member is consumed WITHOUT changing their level', async () => {
  await db.insert(users).values({ id: INVITEE_ID, email: 'invitee@e1a.test', name: 'I', tenant_id: TENANT, tenant_role: 'member' });
  const inv = await seedInvite({ token: 'tok-stale-0123456789abcde', role: 'tenant_admin' });
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-stale-0123456789abcde' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tenantId: TENANT, role: 'member' });
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u?.tenant_role).toBe('member');
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('accepted');
});

test("MED-3: PATCH role revokes that member's pending invites in the workspace", async () => {
  await db.insert(users).values({ id: MEMBER_ID, email: 'm@e1a.test', name: 'M', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  const inv = await seedInvite({ token: 'tok-patchrev-0123456789ab', email: 'M@e1a.test', role: 'tenant_admin' });
  const res = await call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_ID}`, { role: 'member' });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('revoked');
});

test('MED-4: accepting into a suspended workspace → 409 tenant_not_active, nobody seated', async () => {
  await seedInvite({ token: 'tok-susp-0123456789abcdef' });
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, TENANT));
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-susp-0123456789abcdef' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_not_active');
  expect(await db.select().from(users).where(eq(users.id, INVITEE_ID))).toEqual([]);
});

test('MED-4: accepting into an offboarded workspace (status flipped back to active) → 409 tenant_not_active', async () => {
  await seedInvite({ token: 'tok-offb-0123456789abcdef' });
  await db.update(tenants).set({ status: 'active', offboarded_at: new Date() }).where(eq(tenants.id, TENANT));
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-offb-0123456789abcdef' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_not_active');
});

const ssoUser = (): User => ({
  id: SSO_ID,
  email: 'sso@e1a.test',
  name: 'Sso',
  roles: [],
  emailVerified: true,
  idpAlias: 'entra-e1a-tenant',
});
async function seedIdp(): Promise<void> {
  await db.insert(identityProviders).values({
    tenant_id: TENANT,
    alias: 'entra-e1a-tenant',
    display_name: 'E1a Entra',
    config: {} as never,
  });
}

test('MED-4: SSO first login into an offboarded workspace (IdP still enabled) → no workspace, no seat', async () => {
  await seedIdp();
  await db.update(tenants).set({ status: 'suspended', offboarded_at: new Date() }).where(eq(tenants.id, TENANT));
  const hydrated = await hydrateCpIdentity(ssoUser());
  expect(hydrated.tenantId).toBeUndefined();
  const [u] = await db.select().from(users).where(eq(users.id, SSO_ID));
  expect(u?.tenant_id ?? null).toBeNull();
});

test('MED-4: SSO first login into an ACTIVE workspace still seats (control for the test above)', async () => {
  await seedIdp();
  const hydrated = await hydrateCpIdentity(ssoUser());
  expect(hydrated.tenantId).toBe(TENANT);
});

test('MED-4: offboarding a workspace revokes its pending invites and disables its IdPs in CP', async () => {
  await seedIdp();
  const inv = await seedInvite({ token: 'tok-offroute-0123456789ab' });
  currentUser = superAdmin;
  const res = await call('POST', `/api/tenants/${TENANT}/offboard`, { confirmSlug: 'e1a-tenant' });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
  expect(row?.status).toBe('revoked');
  const [idp] = await db.select().from(identityProviders).where(eq(identityProviders.tenant_id, TENANT));
  expect(idp?.enabled).toBe(false);
});

test('MED-5: two admins demoting each other at once → exactly one 409 last_tenant_admin', async () => {
  await db.insert(users).values({ id: MEMBER_ID, email: 'm@e1a.test', name: 'M', tenant_id: TENANT, tenant_role: 'tenant_admin' });
  currentUser = superAdmin;
  const [a, b] = await Promise.all([
    call('PATCH', `/api/tenants/${TENANT}/users/${TADMIN_ID}`, { role: 'member' }),
    call('PATCH', `/api/tenants/${TENANT}/users/${MEMBER_ID}`, { role: 'member' }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const loser = a.status === 409 ? a : b;
  expect(((await loser.json()) as { error: string }).error).toBe('last_tenant_admin');
  const admins = await db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, TENANT), eq(users.tenant_role, 'tenant_admin'), isNull(users.deleted_at)));
  expect(admins.length).toBe(1);
});

test('MED-7: a double-submitted invite → ONE invite, both answered, the minted identity never deleted', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const [a, b] = await Promise.all([
    call('POST', `/api/tenants/${TENANT}/users`, { email: 'twice@e1a.test' }),
    call('POST', `/api/tenants/${TENANT}/users`, { email: 'twice@e1a.test' }),
  ]);
  expect([a.status, b.status]).toEqual([201, 201]);
  const ia = ((await a.json()) as { invite: { id: string } }).invite.id;
  const ib = ((await b.json()) as { invite: { id: string } }).invite.id;
  expect(ia).toBe(ib);
  const rows = await db.select().from(tenantInvites).where(eq(tenantInvites.tenant_id, TENANT));
  expect(rows.length).toBe(1);
  expect(rows[0]?.keycloak_sub).toBe(NEW_SUB);
  expect(calls.some((c) => c.op === 'deleteRealmUser')).toBe(false);
});

test('accept by inviteId with a mismatched email → 403 invite_email_mismatch, nobody seated', async () => {
  const inv = await seedInvite({ token: 'tok-byid-0123456789abcdef' });
  currentUser = invitee({ email: 'not-the-invitee@e1a.test' });
  const res = await call('POST', '/api/invites/accept', { inviteId: inv.id });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe('invite_email_mismatch');
  expect(await db.select().from(users).where(eq(users.id, INVITEE_ID))).toEqual([]);
});

test('LOW-8: accept refuses when the identity is live in ANOTHER workspace (re-checked under the row lock)', async () => {
  await db.insert(users).values({ id: INVITEE_ID, email: 'invitee@e1a.test', name: 'I', tenant_id: OTHER_TENANT, tenant_role: 'member' });
  await seedInvite({ token: 'tok-other-0123456789abcde' });
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-other-0123456789abcde' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('email_in_other_tenant');
  const [u] = await db.select().from(users).where(eq(users.id, INVITEE_ID));
  expect(u?.tenant_id).toBe(OTHER_TENANT);
});

test('LOW-9: the invite being accepted does not count against its own seat', async () => {
  // TA + this pending invite = 2 = max: full for anyone ELSE, but the reservation is the invitee's.
  await db.update(tenants).set({ max_members: 2 }).where(eq(tenants.id, TENANT));
  await seedInvite({ token: 'tok-ownseat-0123456789abc' });
  currentUser = invitee();
  const res = await call('POST', '/api/invites/accept', { token: 'tok-ownseat-0123456789abc' });
  expect(res.status).toBe(200);
});

test("LOW-9: SSO first login counts other people's pending invites against the cap", async () => {
  await seedIdp();
  await db.update(tenants).set({ max_members: 2 }).where(eq(tenants.id, TENANT));
  await seedInvite({ token: 'tok-reserved-0123456789ab', email: 'reserved@e1a.test' });
  const hydrated = await hydrateCpIdentity(ssoUser());
  expect(hydrated.tenantId).toBeUndefined();
});

// ---- A2 §1: delivery is decided by the identity's LOGIN STATE, not by who created it ----------
//
// Prod 2026-10-12 (Netcare): the invitee's portal identity pre-existed (created 2026-06-27 by another
// provisioning) with NO password credential, NO IdP link and UPDATE_PASSWORD + VERIFY_EMAIL pending.
// CP mailed "sign in and accept" — to someone who could not sign in.

type MailCfg = { enabled: boolean; host: string; from: string };
async function withMail<T>(fn: (sent: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const cfg = config.mail as unknown as MailCfg;
  const was = { ...cfg };
  const sent: Record<string, unknown>[] = [];
  __setMailTransportForTests({
    sendMail: async (m: Record<string, unknown>) => {
      sent.push(m);
      return {};
    },
  } as never);
  Object.assign(cfg, { enabled: true, host: 'smtp.test', from: 'cp@test' });
  try {
    return await fn(sent);
  } finally {
    Object.assign(cfg, was);
    __setMailTransportForTests(undefined);
  }
}

const existingNoPassword: RealmUser = {
  id: INVITEE_ID,
  username: 'invitee@e1a.test',
  email: 'invitee@e1a.test',
  emailVerified: false,
  requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'],
};

test('A2 Test 1: an EXISTING identity with no password + UPDATE_PASSWORD pending → Keycloak action email, NOT the CP mail', async () => {
  const { kc, calls } = makeKc({ findResult: existingNoPassword, credentials: [], federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'invitee@e1a.test', role: 'tenant_admin' });
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as { invite: { emailDelivery: string; inviteUrl: string } };
    expect(invite.emailDelivery).toBe('keycloak_actions');
    expect(calls.some((c) => c.op === 'createRealmUser')).toBe(false); // it pre-existed
    const mail = calls.find((c) => c.op === 'executeActionsEmail');
    expect(mail?.args[0]).toBe(INVITEE_ID);
    expect(mail?.args[1]).toEqual(['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
    expect((mail?.args[2] as { redirectUri: string }).redirectUri).toBe(invite.inviteUrl);
    expect(sent).toEqual([]); // ⛔ the dead-end CP "sign in" mail is NOT sent
  });
});

test('A2 Test 1: no password, no IdP, NOTHING pending → still the action email (it cannot sign in)', async () => {
  const { kc, calls } = makeKc({
    findResult: { ...existingNoPassword, emailVerified: true, requiredActions: [] },
    credentials: [],
    federated: [],
  });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'invitee@e1a.test' });
    expect(res.status).toBe(201);
    // verified email → only UPDATE_PASSWORD is asked for
    expect(calls.find((c) => c.op === 'executeActionsEmail')?.args[1]).toEqual(['UPDATE_PASSWORD']);
    expect(sent).toEqual([]);
  });
});

test('A2 Test 1: credentials unreadable (403) → degrades to required actions: UPDATE_PASSWORD pending still gets the action email', async () => {
  const { kc, calls } = makeKc({ findResult: existingNoPassword, credentials: null, federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'invitee@e1a.test' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { invite: { emailDelivery: string } }).invite.emailDelivery).toBe('keycloak_actions');
    expect(calls.some((c) => c.op === 'executeActionsEmail')).toBe(true);
    expect(sent).toEqual([]);
  });
});

test('A2 Test 1 (control): an existing identity WITH a password and nothing pending → the CP mail, no action email', async () => {
  const { kc, calls } = makeKc({
    findResult: { ...existingNoPassword, emailVerified: true, requiredActions: [] },
    credentials: [{ type: 'password' }],
    federated: [],
  });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'invitee@e1a.test' });
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as { invite: { emailDelivery: string; inviteUrl: string } };
    expect(invite.emailDelivery).toBe('sent');
    expect(calls.some((c) => c.op === 'executeActionsEmail')).toBe(false);
    expect(sent.length).toBe(1);
    expect(String(sent[0]!.text)).toContain(invite.inviteUrl);
    expect(String(sent[0]!.text)).toContain('Forgot password');
  });
});

test('A2 Test 1: an IdP-linked identity with no password → CP mail (it signs in through its IdP)', async () => {
  const { kc, calls } = makeKc({
    findResult: { ...existingNoPassword, emailVerified: true, requiredActions: [] },
    credentials: [],
    federated: [{ identityProvider: 'entra-e1a-tenant' }],
  });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'invitee@e1a.test' });
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.op === 'executeActionsEmail')).toBe(false);
    expect(sent.length).toBe(1);
  });
});

test('A2 Test 1: RESEND applies the same predicate — an existing no-password invitee gets the action email again', async () => {
  const inv = await seedInvite({ token: 'tok-resend-a2-0123456789' }); // keycloak_sub NULL: CP did not mint it
  const { kc, calls } = makeKc({ findResult: existingNoPassword, credentials: [], federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv.id}/resend`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite: { emailDelivery: string } };
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    expect(calls.find((c) => c.op === 'executeActionsEmail')?.args[0]).toBe(INVITEE_ID);
    expect(sent).toEqual([]);
  });
});

// ⛔ HUNT (A2 review): the RESEND of an invite that MINTED its identity must still send the set-password
// mail when Keycloak will not show credentials (403 — the expected answer for the SA, see
// keycloak-admin.ts getUserCredentials). Create shortcuts on `identity.created`; resend asked only the
// login state, and a CP-minted identity has NO required actions (`executeActionsEmail` never adds them),
// so it degraded to the CP "sign in" mail — to somebody who has never had a password. The pre-A2
// predicate (minted by this invite + email not verified) is the floor for that unknown case.
const mintedRealm = (emailVerified: boolean): RealmUser => ({
  id: NEW_SUB,
  username: 'invitee@e1a.test',
  email: 'invitee@e1a.test',
  emailVerified,
  requiredActions: [],
});

test('A2 hunt: RESEND of an invite whose identity CP MINTED, credentials unreadable → the action email again, not the CP mail', async () => {
  const inv = await seedInvite({ token: 'tok-resend-minted-0123456789', keycloak_sub: NEW_SUB });
  const { kc, calls } = makeKc({ findResult: mintedRealm(false), credentials: null, federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv.id}/resend`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invite: { emailDelivery: string } }).invite.emailDelivery).toBe('keycloak_actions');
    expect(calls.find((c) => c.op === 'executeActionsEmail')?.args[0]).toBe(NEW_SUB);
    expect(sent).toEqual([]);
  });
});

test('A2 hunt (control): RESEND of a CP-minted identity that has VERIFIED (finished the action email) → the CP mail', async () => {
  const inv = await seedInvite({ token: 'tok-resend-minted-done-012345', keycloak_sub: NEW_SUB });
  const { kc, calls } = makeKc({ findResult: mintedRealm(true), credentials: null, federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv.id}/resend`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invite: { emailDelivery: string } }).invite.emailDelivery).toBe('sent');
    expect(calls.some((c) => c.op === 'executeActionsEmail')).toBe(false);
    expect(sent.length).toBe(1);
  });
});

// ---- login_hint + the masked mismatch target (prod 2026-10-13) -----------------------------------
// ⛔ Keycloak's action-token flow (set password) creates NO session, so the redirect to the accept
// link hit `login-required` with an EMPTY username, Chrome autofilled a DIFFERENT saved account, and
// accept answered 403 invite_email_mismatch — twice. The accept link now carries the invited address
// as `login_hint`, and the 403 tells the wrong account WHICH address (masked) the invite is for.

test('login_hint: the accept link (action-email redirect + response) carries the ENCODED invited address — `+` is %2B', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'new+tag@e1a.test' });
  expect(res.status).toBe(201);
  const { invite } = (await res.json()) as { invite: { inviteUrl: string; emailDelivery: string } };
  expect(invite.emailDelivery).toBe('keycloak_actions');
  // A raw `+` decodes back to a SPACE in a query string: it must travel as %2B.
  expect(invite.inviteUrl).toContain('login_hint=new%2Btag%40e1a.test');
  const url = new URL(invite.inviteUrl);
  expect(url.pathname).toBe('/invite/accept');
  expect(url.searchParams.get('login_hint')).toBe('new+tag@e1a.test');
  expect(url.searchParams.get('token')).toBeTruthy(); // the token survives alongside the hint
  const mail = calls.find((c) => c.op === 'executeActionsEmail');
  expect((mail?.args[2] as { redirectUri: string }).redirectUri).toBe(invite.inviteUrl);
});

test("login_hint: RESEND carries the invite row's address too (action email and CP mail)", async () => {
  const inv = await seedInvite({ token: 'tok-resend-hint-0123456789' });
  const { kc, calls } = makeKc({ findResult: existingNoPassword, credentials: [], federated: [] });
  __setKeycloakAdminForTests(kc);
  await withMail(async () => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv.id}/resend`);
    expect(res.status).toBe(200);
    const mail = calls.find((c) => c.op === 'executeActionsEmail');
    const redirect = new URL((mail?.args[2] as { redirectUri: string }).redirectUri);
    expect(redirect.searchParams.get('login_hint')).toBe('invitee@e1a.test');
  });
  const inv2 = await seedInvite({ token: 'tok-resend-hint-cpmail-01234', email: 'cpmail@e1a.test', keycloak_sub: NEW_SUB });
  const { kc: kc2 } = makeKc({
    findResult: { ...mintedRealm(true), email: 'cpmail@e1a.test', username: 'cpmail@e1a.test' },
    credentials: null,
    federated: [],
  });
  __setKeycloakAdminForTests(kc2);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv2.id}/resend`);
    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(String(sent[0]?.text)).toContain('login_hint=cpmail%40e1a.test');
  });
});

test('mismatch: the 403 carries the MASKED invited address, never the full one', async () => {
  await seedInvite({ token: 'tok-mismatch-mask-0123456789' });
  currentUser = invitee({ email: 'someone-else@e1a.test' });
  const res = await call('POST', '/api/invites/accept', { token: 'tok-mismatch-mask-0123456789' });
  expect(res.status).toBe(403);
  const text = await res.text();
  const body = JSON.parse(text) as { error: string; details: { invitedEmail?: string } };
  expect(body.error).toBe('invite_email_mismatch');
  expect(body.details.invitedEmail).toBe('i••••••@e1a.test');
  expect(text.toLowerCase()).not.toContain('invitee');
});

test('maskEmail: first char + dots + domain; short and malformed inputs leak nothing extra', () => {
  expect(maskEmail('george@gmail.com')).toBe('g•••••@gmail.com');
  expect(maskEmail('a@x.test')).toBe('a•••@x.test');
  expect(maskEmail('averyveryverylonglocalpart@x.test')).toBe('a••••••••@x.test');
  expect(maskEmail('no-at-sign')).toBe('•••');
  expect(maskEmail('@x.test')).toBe('•••');
});

test('⛔ RESEND of an EXPIRED invite superseded by a newer pending one → 409 invite_superseded (not a 23505 500), nothing sent', async () => {
  const old = await seedInvite({
    token: 'tok-superseded-old-012345',
    status: 'expired',
    expires_at: new Date(Date.now() - 86_400_000),
  });
  const newer = await seedInvite({ token: 'tok-superseded-new-012345', email: 'INVITEE@e1a.test' }); // lower() matches
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  await withMail(async (sent) => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${old.id}/resend`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('invite_superseded');
    expect(sent).toEqual([]);
  });
  expect(calls.filter((c) => c.op === 'executeActionsEmail')).toEqual([]);
  const rows = await db.select().from(tenantInvites).where(inArray(tenantInvites.id, [old.id, newer.id]));
  const by = new Map(rows.map((r) => [r.id, r]));
  expect(by.get(old.id)!.status).toBe('expired');
  expect(by.get(old.id)!.token_hash).toBe(old.token_hash);
  expect(by.get(newer.id)!.status).toBe('pending');
});

test('RESEND of an EXPIRED invite with NO newer pending one (control) → renewed to pending, 200', async () => {
  const old = await seedInvite({
    token: 'tok-superseded-ctl-012345',
    status: 'expired',
    expires_at: new Date(Date.now() - 86_400_000),
  });
  await withMail(async () => {
    const res = await call('POST', `/api/tenants/${TENANT}/invites/${old.id}/resend`);
    expect(res.status).toBe(200);
  });
  expect((await db.select().from(tenantInvites).where(eq(tenantInvites.id, old.id)))[0]!.status).toBe('pending');
});

for (const [label, set, code] of [
  ['SUSPENDED', { status: 'suspended' as const }, 'tenant_not_active'],
  ['OFFBOARDED', { offboarded_at: new Date() }, 'tenant_offboarded'],
] as const) {
  test(`⛔ RESEND of a still-PENDING invite in a ${label} workspace → 409 ${code}, nothing re-emailed, token unchanged`, async () => {
    const inv = await seedInvite({ token: `tok-resend-${label.toLowerCase()}-0123456789` }); // live, unexpired
    await db.update(tenants).set(set).where(eq(tenants.id, TENANT));
    // A super_admin: the workspace's own tenant_admin is already stopped by the suspension gate (403);
    // the platform operator is not, and neither is the service-level resend behind POST /api/invites.
    currentUser = superAdmin;
    const { kc, calls } = makeKc({ findResult: existingNoPassword, credentials: [], federated: [] });
    __setKeycloakAdminForTests(kc);
    await withMail(async (sent) => {
      const res = await call('POST', `/api/tenants/${TENANT}/invites/${inv.id}/resend`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(code);
      expect(sent).toEqual([]);
    });
    expect(calls.filter((c) => c.op === 'executeActionsEmail')).toEqual([]);
    const [after] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, inv.id));
    expect(after!.token_hash).toBe(inv.token_hash);
    expect(after!.resent_at).toBeNull();
  });
}
