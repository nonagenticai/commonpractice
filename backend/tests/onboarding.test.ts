// tests/onboarding.test.ts — controlled onboarding (super_admin half), CP-owned tenancy.
//
// Exercises the LIVE onboarding routes (routes/onboarding.ts) against a postgres, with identity
// injected via __setAuthOverridesForTests and the Keycloak admin client replaced by an injected
// FAKE (no live Keycloak) via __setKeycloakAdminForTests.
// Proves: email-domain auto-routing, notify-self idempotency (DB home tenant, never the claim),
// approve seats a KNOWN requester in CP's `users` (tenant_id + tenant_role) and turns an anonymous
// request into an invite, Keycloak is only asked to find/create a bare identity (never an attribute
// or role write), fail-closed KC semantics, and the email-domain / free-mail admin surface. The
// authz 403-for-non-super matrix lives in admin-authz-matrix.test.ts.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray, eq, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  auditLog,
  signupApprovals,
  emailDomainTenants,
  freeEmailProviders,
  usageEvents,
} from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  KeycloakAdminError,
  DuplicateUserError,
  type KeycloakAdminClient,
  type RealmUser,
} from '../src/services/keycloak-admin';
import { matchTenantByEmail } from '../src/services/onboarding-service';
import { upsertLocalUser } from '../src/services/provisioning';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  tenantLicenceSubjects,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import { config } from '../src/config';
import { tryDecryptSecret } from '../src/host/secret-box';
import type { User } from '../src/types';

// ⚠️ UUIDs, NOT `lic-1`. `member_entitlements.license_id` / `.license_subject_id` are `uuid`
// columns (0089) because the licences service returns UUIDs — a fake emitting an opaque string
// cannot be stored, and the onboarding routes surface that as a 400. LIC and SUBJ stay VISIBLY
// different from one another: carrying both only matters because they are not interchangeable.
const LIC = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SUBJ = (n: number) => `11111111-1111-4111-8111-00000000000${n}`;


// RFC-4122-valid v4 uuids (3rd group '4xxx', 4th '8xxx') so zod's strict .uuid() accepts
// them in request bodies — prod tenant ids are gen_random_uuid() (valid v4) too.
const TENANT = '00000000-0000-4000-8000-0000000c2001';
const SADMIN_ID = '00000000-0000-4000-8000-0000000c2010';
const NEW_SUB = '00000000-0000-4000-8000-0000000c2aaa';
const EXISTING_SUB = '00000000-0000-4000-8000-0000000c2bbb';
// A row that OWNS DATA, used by the ghost-clear guard test. It lives up here, and in SEEDED_SUBS
// below, because that test's own teardown runs at its END — so any earlier failure (or a dev
// container dying mid-run) stranded it, and every later run then died on a users_pkey 23505 that
// looks nothing like the actual problem. It cost real debugging time; the shared cleanup owns it now.
const GHOST_SUB = '00000000-0000-4000-8000-0000000c2c11';
// A member of a DIFFERENT workspace, for the approve-is-a-move guard.
const ELSEWHERE_SUB = '00000000-0000-4000-8000-0000000c2c22';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000c2002';
const TEST_DOMAINS = ['acme-c2.test', 'noassign-c2.test', 'freemail-c2.test'];
const SEEDED_SUBS = [NEW_SUB, EXISTING_SUB, GHOST_SUB, ELSEWHERE_SUB];

const superAdmin: User = {
  id: SADMIN_ID, email: 'sa-c2@t', name: 'SA', roles: ['super_admin'], tenantId: TENANT,
};

// ---- fake Keycloak admin client ----
interface KcCall {
  op: string;
  args: unknown[];
}
function makeKc(opts: {
  createSub?: string;
  createThrows?: Error;
  existingUsers?: RealmUser[];
  /** Result of the exact-match username/email lookup used to resolve a 409 duplicate. */
  findResult?: RealmUser | null;
  findThrows?: Error;
  /** Make the magic-link send FAIL — a dead SMTP relay behind execute-actions-email. */
  emailThrows?: Error;
  /**
   * The realm roles a user ALREADY holds. This is the whole state an ADOPTED account arrives
   * carrying, and until it existed here every fake account was born role-less — which is exactly
   * why "adopting an account keeps its stale roles" could not be seen from this file.
   */
  rolesByUser?: Record<string, string[]>;
  /** Ids whose role lookup is genuinely UNKNOWN (`null`): a real KC 5xx / transport failure, NOT
   *  the 404 that definitively means "no such user" and maps to `[]`. See
   *  `getRealmRolesForUsers`'s docblock — conflating the two is what broke offboarding in prod. */
  rolesUnknown?: string[];
} = {}): { kc: KeycloakAdminClient; calls: KcCall[]; roles: Record<string, string[]> } {
  const calls: KcCall[] = [];
  // Realm roles are READ ONLY here (the client has no role-write method any more). The map is
  // returned so a test can assert an adopted account's roles were left exactly as they were.
  const roles: Record<string, string[]> = { ...(opts.rolesByUser ?? {}) };
  const kc: KeycloakAdminClient = {
    async createRealmUser(input) {
      calls.push({ op: 'createRealmUser', args: [input] });
      if (opts.createThrows) throw opts.createThrows;
      return opts.createSub ?? NEW_SUB;
    },
    async logoutUser(userId) {
      calls.push({ op: 'logoutUser', args: [userId] });
    },
    async executeActionsEmail(userId, actions, emailOpts) {
      calls.push({ op: 'executeActionsEmail', args: [userId, actions, emailOpts] });
      if (opts.emailThrows) throw opts.emailThrows;
    },
    async deleteRealmUser(userId) {
      calls.push({ op: 'deleteRealmUser', args: [userId] });
    },
    async listRealmUsers() {
      calls.push({ op: 'listRealmUsers', args: [] });
      return opts.existingUsers ?? [];
    },
    async findRealmUserByUsernameOrEmail(username, email) {
      calls.push({ op: 'findRealmUserByUsernameOrEmail', args: [username, email] });
      if (opts.findThrows) throw opts.findThrows;
      if (opts.findResult !== undefined) return opts.findResult;
      // Default: mimic Keycloak — match on username OR email over the seeded realm users.
      const want = username.toLowerCase();
      return (
        (opts.existingUsers ?? []).find(
          (u) => u.username?.toLowerCase() === want || u.email?.toLowerCase() === want,
        ) ?? null
      );
    },
    async backfillUserEmail(userId, email) {
      calls.push({ op: 'backfillUserEmail', args: [userId, email] });
    },
    async getRealmRolesForUsers(userIds) {
      calls.push({ op: 'getRealmRolesForUsers', args: [userIds] });
      const unknown = new Set(opts.rolesUnknown ?? []);
      return new Map(userIds.map((u) => [u, unknown.has(u) ? null : (roles[u] ?? [])]));
    },
    // Phase 4 / E.1 IdP surface — unused by onboarding; stubs satisfy the interface.
    async createIdentityProvider(rep) { calls.push({ op: 'createIdentityProvider', args: [rep] }); },
    async getIdentityProvider() { return null; },
    async updateIdentityProvider(alias, rep) { calls.push({ op: 'updateIdentityProvider', args: [alias, rep] }); },
    async deleteIdentityProvider(alias) { calls.push({ op: 'deleteIdentityProvider', args: [alias] }); },
    async createIdpMapper(alias, mapper) { calls.push({ op: 'createIdpMapper', args: [alias, mapper] }); },
    async listIdpMappers() { return []; },
    async deleteIdpMapper(alias, mapperId) { calls.push({ op: 'deleteIdpMapper', args: [alias, mapperId] }); },
  };
  return { kc, calls, roles };
}

/** The realm account that OWNS `email` (verified) — what approve now requires before it seats a
 *  queued sub. Without it in the fake realm, approve invites the address instead. */
function owner(sub: string, email: string, emailVerified = true): RealmUser {
  return { id: sub, username: email, email, emailVerified };
}

const router = new Router();
registerOnboardingRoutes(router);

let currentUser: User | null = superAdmin;
function as(u: User | null) {
  currentUser = u;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const pathname = path.split('?')[0]!;
  const m = router.match(method, pathname);
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
  await db.delete(signupApprovals).where(sql`lower(email) LIKE '%-c2.test' OR lower(email) LIKE '%@%-c2.test'`);
  await db.delete(emailDomainTenants).where(inArray(emailDomainTenants.domain, TEST_DOMAINS));
  await db.delete(freeEmailProviders).where(inArray(freeEmailProviders.domain, TEST_DOMAINS));
  await db.delete(auditLog).where(eq(auditLog.actor_id, SADMIN_ID));
  // usage_events CASCADEs, but the ghost row is also referenced by NO ACTION FKs in other tests —
  // clear its dependants explicitly so the users delete below can never fail.
  await db.delete(usageEvents).where(inArray(usageEvents.user_id, [...SEEDED_SUBS, SADMIN_ID]));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, [...SEEDED_SUBS, SADMIN_ID]));
  await db.delete(users).where(inArray(users.id, [...SEEDED_SUBS, SADMIN_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
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
  await db.insert(tenants).values([
    { id: TENANT, name: 'Acme C2', slug: 'acme-c2' },
    { id: OTHER_TENANT, name: 'Other C2', slug: 'other-c2' },
  ]).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values({ id: SADMIN_ID, email: superAdmin.email, name: superAdmin.name }).onConflictDoNothing({ target: users.id });
  __setKeycloakAdminForTests(makeKc().kc); // default; overridden per-test as needed
  as(superAdmin);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

// ---- email-domain auto-routing (pure service) ----

test('matchTenantByEmail: corporate domain → tenant; free-mail/no-auto/unknown → null', async () => {
  await db.insert(emailDomainTenants).values([
    { domain: 'acme-c2.test', tenant_id: TENANT, auto_assign: true },
    { domain: 'noassign-c2.test', tenant_id: TENANT, auto_assign: false },
  ]);
  await db.insert(freeEmailProviders).values({ domain: 'freemail-c2.test' }).onConflictDoNothing();

  expect(await matchTenantByEmail('alice@acme-c2.test')).toBe(TENANT);
  expect(await matchTenantByEmail('ALICE@ACME-C2.TEST')).toBe(TENANT); // case-insensitive
  expect(await matchTenantByEmail('bob@noassign-c2.test')).toBeNull(); // auto_assign=false
  expect(await matchTenantByEmail('x@freemail-c2.test')).toBeNull(); // blocklisted
  expect(await matchTenantByEmail('x@unknown-c2.test')).toBeNull(); // unmapped
  expect(await matchTenantByEmail('not-an-email')).toBeNull();
});

// ---- notify-self (open, idempotent) ----

test('notify-self: anonymous records a pending row with the auto-matched tenant', async () => {
  await db.insert(emailDomainTenants).values({ domain: 'acme-c2.test', tenant_id: TENANT, auto_assign: true });
  as(null); // anonymous
  const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'newbie@acme-c2.test', name: 'Newbie' });
  expect(res.status).toBe(204);
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'newbie@acme-c2.test'`);
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe('pending');
  expect(rows[0]!.matched_tenant_id).toBe(TENANT);
});

test('notify-self: a caller with a CP home tenant (users.tenant_id) is a no-op', async () => {
  await db.update(users).set({ tenant_id: TENANT }).where(eq(users.id, SADMIN_ID));
  as(superAdmin);
  const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'sa-onboarded@acme-c2.test' });
  expect(res.status).toBe(204);
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'sa-onboarded@acme-c2.test'`);
  expect(rows.length).toBe(0);
});

test('notify-self: a token that merely CLAIMS a tenant but has no CP home is queued, with its sub', async () => {
  // The home tenant is the DB row, never the identity's `tenantId`. SADMIN's users row (beforeEach)
  // has no tenant_id, so this caller is workspace-less and must be recorded, keyed on its sub.
  as({ ...superAdmin, tenantId: OTHER_TENANT, email: 'claimonly@acme-c2.test', emailVerified: true });
  const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'ClaimOnly@acme-c2.test' });
  expect(res.status).toBe(204);
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'claimonly@acme-c2.test'`);
  expect(rows.length).toBe(1);
  expect(rows[0]!.keycloak_sub).toBe(SADMIN_ID);
});

test('notify-self: de-dupes on a pending email', async () => {
  as(null);
  await call('POST', '/api/signup-approvals/notify-self', { email: 'dupe@acme-c2.test' });
  await call('POST', '/api/signup-approvals/notify-self', { email: 'DUPE@acme-c2.test' });
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'dupe@acme-c2.test'`);
  expect(rows.length).toBe(1);
});

// ---- HIGH-1: the body's email is only paired with the token's sub when the token proves it ----
//
// `email` comes from the request body and the sub from the token. Storing them as a pair unchecked
// let any portal account queue `{sub: attacker, email: victim@customer}`; the domain match routed the
// row to the victim's tenant and approve seated the ATTACKER. Each of these fails if notify-self
// stores `caller.id` unconditionally again.

test('⛔ notify-self: a verified caller claiming SOMEONE ELSE\'s address stores NO sub', async () => {
  await db.insert(emailDomainTenants).values({ domain: 'acme-c2.test', tenant_id: TENANT, auto_assign: true });
  as({ ...superAdmin, email: 'attacker@freemail-c2.test', emailVerified: true });
  const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'victim@acme-c2.test' });
  expect(res.status).toBe(204);
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'victim@acme-c2.test'`);
  expect(rows.length).toBe(1);
  expect(rows[0]!.keycloak_sub).toBeNull();
  expect(rows[0]!.matched_tenant_id).toBe(TENANT); // still routed — but approve will INVITE the address
});

test('⛔ notify-self: an UNVERIFIED token for the same address stores NO sub', async () => {
  as({ ...superAdmin, email: 'unverified@acme-c2.test', emailVerified: false });
  const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'unverified@acme-c2.test' });
  expect(res.status).toBe(204);
  const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'unverified@acme-c2.test'`);
  expect(rows.length).toBe(1);
  expect(rows[0]!.keycloak_sub).toBeNull();
});

// ---- approve ----

/** The pending invites for `email` in `tenantId` (owner connection: RLS does not apply). */
async function invitesFor(email: string, tenantId = TENANT) {
  return db
    .select()
    .from(tenantInvites)
    .where(sql`${tenantInvites.tenant_id} = ${tenantId} AND lower(${tenantInvites.email}) = lower(${email})`);
}

test('approve (anonymous request): becomes an INVITE — bare realm identity, no seat, no KC attribute/role', async () => {
  const { kc, calls } = makeKc({ createSub: NEW_SUB });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'approve@acme-c2.test', name: 'Ann Approve', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'tenant_admin' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tenantId: string; role: string; invite: { id: string; role: string } | null };
  expect(body.tenantId).toBe(TENANT);
  expect(body.role).toBe('tenant_admin');
  expect(body.invite?.role).toBe('tenant_admin');

  // Keycloak: look the address up, create a BARE identity, send the credential-setup mail.
  // Nothing else — membership is CP's, so no attribute or realm-role write exists to call.
  expect(calls.map((c) => c.op)).toEqual([
    'findRealmUserByUsernameOrEmail', 'createRealmUser', 'executeActionsEmail',
  ]);
  const created = calls[1]!.args[0] as { attributes?: unknown };
  expect(created.attributes).toBeUndefined();

  // No seat yet: the person is seated when they accept, not when an admin approves an address.
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0);
  const invites = await invitesFor('approve@acme-c2.test');
  expect(invites.length).toBe(1);
  expect(invites[0]!.status).toBe('pending');
  expect(invites[0]!.role).toBe('tenant_admin');
  expect(invites[0]!.keycloak_sub).toBe(NEW_SUB); // minted by this invite
  expect(invites[0]!.id).toBe(body.invite!.id);

  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(row?.status).toBe('approved');
  expect(row?.assigned_tenant_id).toBe(TENANT);

  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'signup.approve'));
  expect(audits.length).toBe(1);
});

test('approve (known requester): seats them in CP — users.tenant_id + tenant_role, KC only READ', async () => {
  const { kc, calls, roles } = makeKc({
    rolesByUser: { [NEW_SUB]: [] },
    existingUsers: [owner(NEW_SUB, 'known@acme-c2.test')],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'known@acme-c2.test', name: 'Known', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'developer' });
  expect(res.status).toBe(200);
  const known = (await res.json()) as { invite: unknown; seated: boolean };
  expect(known.invite).toBeNull();
  expect(known.seated).toBe(true);

  const [u] = await db.select().from(users).where(eq(users.id, NEW_SUB));
  expect(u?.tenant_id).toBe(TENANT);
  expect(u?.tenant_role).toBe('developer');
  expect(u?.keycloak_sub).toBe(NEW_SUB);
  // Keycloak is only READ: does the sub own the address, and is it a platform account.
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  expect(roles[NEW_SUB]).toEqual([]);
  expect(await invitesFor('known@acme-c2.test')).toHaveLength(0);
});

// ---- HIGH-1 second layer: a queued sub is seated only if the realm says it OWNS the address ----
//
// Rows queued before notify-self checked the pair, and `recordSignupStrand` rows, carry a sub with
// no proof. Each of these fails if approve seats `approval.keycloak_sub` without asking the realm.

test('⛔ approve: a queued sub that is NOT the realm owner of the address → INVITE, never seated', async () => {
  const { kc, calls } = makeKc({
    // The address belongs to EXISTING_SUB in the realm; the queue row names NEW_SUB (the attacker).
    existingUsers: [owner(EXISTING_SUB, 'victim2@acme-c2.test')],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'victim2@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'tenant_admin' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { seated: boolean; invite: { role: string } | null };
  expect(body.seated).toBe(false);
  expect(body.invite?.role).toBe('tenant_admin');
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0); // NOT seated
  const invites = await invitesFor('victim2@acme-c2.test');
  expect(invites.length).toBe(1);
  expect(invites[0]!.keycloak_sub).toBeNull(); // the realm owner is reused, not minted
  expect(calls.map((c) => c.op)).not.toContain('createRealmUser');
});

test('⛔ approve: the realm owner of the address but with an UNVERIFIED email → INVITE, never seated', async () => {
  const { kc } = makeKc({ existingUsers: [owner(NEW_SUB, 'unverified2@acme-c2.test', false)] });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'unverified2@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(200);
  expect(((await res.json()) as { seated: boolean }).seated).toBe(false);
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0);
  expect(await invitesFor('unverified2@acme-c2.test')).toHaveLength(1);
});

test('approve: a Keycloak that cannot answer the OWNERSHIP lookup is 502 — nothing seated or invited', async () => {
  const { kc } = makeKc({ findThrows: new KeycloakAdminError(503, 'kc down') });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'ownerdown@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
    .returning();
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe('keycloak_provisioning_failed');
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0);
  expect(await invitesFor('ownerdown@acme-c2.test')).toHaveLength(0);
});

// ---- approve is a MOVE path, and its input is anonymous ----
//
// `notify-self` is open: anyone can queue any address. A super_admin working the queue must never
// move a member of another workspace out of it with one click.

test('approve: an address that already belongs to ANOTHER workspace is refused (409), KC never called', async () => {
  await db.insert(users).values({
    id: ELSEWHERE_SUB, email: 'taken@acme-c2.test', name: 'Taken', tenant_id: OTHER_TENANT,
  });
  const { kc, calls } = makeKc({ createSub: NEW_SUB });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'TAKEN@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('user_belongs_to_another_workspace');
  expect(calls.length).toBe(0); // refused before any realm call

  const [row] = await db.select().from(users).where(eq(users.id, ELSEWHERE_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT); // still where they live
  const [appr] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(appr!.status).toBe('pending'); // and the queue row is undecided, not consumed
});

test('approve: a realm `tenant_id` attribute naming another tenant is IGNORED — CP membership decides', async () => {
  // Under CP-owned tenancy the Keycloak attribute is not a membership fact. A realm identity whose
  // stale attribute names OTHER_TENANT, with no CP row anywhere, is a person with no workspace —
  // the approve proceeds (as an invite) and the attribute is neither read nor rewritten.
  const { kc, calls } = makeKc({
    existingUsers: [{
      id: ELSEWHERE_SUB,
      username: 'realmonly@acme-c2.test',
      email: 'realmonly@acme-c2.test',
      attributes: { tenant_id: [OTHER_TENANT] },
    } as RealmUser],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'realmonly@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(200);
  // Reused, never created; checked for platform staff; never emailed a password reset.
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  const invites = await invitesFor('realmonly@acme-c2.test');
  expect(invites.length).toBe(1);
  expect(invites[0]!.keycloak_sub).toBeNull(); // not minted by this invite
  expect(await db.select().from(users).where(eq(users.id, ELSEWHERE_SUB))).toHaveLength(0);
});

test('approve: a Keycloak that cannot answer the identity lookup is 502, never a pass (fail closed)', async () => {
  const { kc, calls } = makeKc({ findThrows: new KeycloakAdminError(503, 'kc down') });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'unreachable@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe('keycloak_provisioning_failed');
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail']); // nothing was written
  expect(await invitesFor('unreachable@acme-c2.test')).toHaveLength(0);
  const [appr] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(appr!.status).toBe('pending');
});

test('approve: a checkpointed sub that has since been TOMBSTONED is refused (409)', async () => {
  // The local row is tombstoned while the realm identity survives; seating it would re-home a
  // removed person.
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'off@acme-c2.test', name: 'Off', tenant_id: OTHER_TENANT, deleted_at: new Date(),
  });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'off@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('user_offboarded');
  expect(calls.length).toBe(0);
  const [row] = await db.select().from(users).where(eq(users.id, EXISTING_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(row!.deleted_at).toBeInstanceOf(Date); // not resurrected
});

test('upsertLocalUserTx refuses to re-home a TOMBSTONE — loudly, not as a silent no-op', async () => {
  // The belt to the route guard's braces, tested directly because no route can reach it once the
  // guard above holds. It is the shared write EVERY provisioning path funnels through, and it
  // RAISES rather than matching zero rows.
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'tomb@acme-c2.test', name: 'Tomb', tenant_id: OTHER_TENANT, deleted_at: new Date(),
  });
  await expect(
    upsertLocalUser(EXISTING_SUB, 'tomb@acme-c2.test', 'Tomb', TENANT, 'member'),
  ).rejects.toMatchObject({ status: 409, code: 'user_offboarded' });
  const [row] = await db.select().from(users).where(eq(users.id, EXISTING_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT); // not moved
});

test('approve: the RESUME path still works — the guard must not break a retried approve', async () => {
  // Approve checkpoints the target and stays `pending` so a later failure (licence issuance) can be
  // retried — by then a users row EXISTS, homed in the tenant being approved into.
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'resume@acme-c2.test', name: 'Resume', tenant_id: TENANT,
  });
  const { kc, calls } = makeKc({ existingUsers: [owner(EXISTING_SUB, 'resume@acme-c2.test')] });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'resume@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(200);
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  const [row] = await db.select().from(users).where(eq(users.id, EXISTING_SUB));
  expect(row!.tenant_id).toBe(TENANT);
  expect(row!.tenant_role).toBe('member');
});

test('approve: an adopted account\'s stale realm roles grant NOTHING — the CP role is the requested level', async () => {
  // Under the old model the realm role WAS the level, so adoption had to strip stale ones. Now the
  // level is `users.tenant_role`; realm roles (other than super_admin) are ignored on every request,
  // so CP neither strips nor adds any — the account's realm roles are left exactly as found.
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'stale@acme-c2.test', name: 'Stale', tenant_id: TENANT, tenant_role: 'tenant_admin',
  });
  const { kc, calls, roles } = makeKc({
    rolesByUser: { [EXISTING_SUB]: ['employee', 'member', 'tenant_admin'] },
    existingUsers: [owner(EXISTING_SUB, 'stale@acme-c2.test')],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'stale@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'member' });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.id, EXISTING_SUB));
  expect(row!.tenant_role).toBe('member'); // the requested level, not the stale admin
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  expect(roles[EXISTING_SUB]).toEqual(['employee', 'member', 'tenant_admin']); // untouched
});

test('approve: a PLATFORM account is refused (409), never demoted and never re-homed', async () => {
  // A platform operator's address must not become a customer member through the queue.
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'platform@acme-c2.test', name: 'Platform', tenant_id: TENANT,
  });
  const { kc, calls, roles } = makeKc({
    rolesByUser: { [EXISTING_SUB]: ['super_admin'] },
    existingUsers: [owner(EXISTING_SUB, 'platform@acme-c2.test')],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'platform@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'member' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('platform_account_adoption_refused');
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  expect(roles[EXISTING_SUB]).toEqual(['super_admin']); // not demoted
  const [row] = await db.select().from(users).where(eq(users.id, EXISTING_SUB));
  expect(row!.tenant_role).toBeNull(); // no level written
  const [appr] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(appr!.status).toBe('pending'); // and the queue row is undecided, not consumed
});

test('approve: a role lookup that CANNOT be answered blocks the adoption (502), never passes it', async () => {
  // `null` is "could not ask", and it must not be readable as "not a platform account".
  await db.insert(users).values({
    id: EXISTING_SUB, email: 'unknownroles@acme-c2.test', name: 'Unknown', tenant_id: TENANT,
  });
  const { kc, calls } = makeKc({
    rolesUnknown: [EXISTING_SUB],
    existingUsers: [owner(EXISTING_SUB, 'unknownroles@acme-c2.test')],
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({
      email: 'unknownroles@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB,
    })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe('keycloak_provisioning_failed');
  // nothing was written
  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
});

test('approve: a Keycloak identity-create failure is 502 and writes NO user row and NO invite', async () => {
  const { kc } = makeKc({ createThrows: new KeycloakAdminError(500, 'kc down') });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'fail@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(502);

  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(row?.status).toBe('pending'); // not decided
  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0);
  expect(await invitesFor('fail@acme-c2.test')).toHaveLength(0);
});

test('approve: role super_admin is rejected (422 — privilege-escalation guard)', async () => {
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'esc@acme-c2.test', matched_tenant_id: TENANT })
    .returning();
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, { role: 'super_admin' });
  expect(res.status).toBe(422);
});

test('approve: with no resolvable tenant → 400', async () => {
  const [approval] = await db.insert(signupApprovals).values({ email: 'notenant@acme-c2.test' }).returning();
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(400);
});

test('reject: marks rejected + audits, no Keycloak call', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const [approval] = await db.insert(signupApprovals).values({ email: 'rej@acme-c2.test' }).returning();
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/reject`, {});
  expect(res.status).toBe(200);
  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(row?.status).toBe('rejected');
  expect(calls.length).toBe(0);
});

// ---- invite ----

test('invite: a NEW address gets a bare realm identity + Keycloak action email, a pending invite, no seat', async () => {
  const { kc, calls } = makeKc({ createSub: NEW_SUB });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', '/api/invites', { email: 'invite@acme-c2.test', name: 'Ivy', tenantId: TENANT, role: 'tenant_admin' });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    invite: { id: string; tenantId: string; role: string; emailDelivery: string; inviteUrl: string };
  };
  expect(body.invite).toMatchObject({ tenantId: TENANT, role: 'tenant_admin', emailDelivery: 'keycloak_actions' });
  expect(body.invite.inviteUrl).toContain('/invite/accept?token=');

  expect(calls.map((c) => c.op)).toEqual(['findRealmUserByUsernameOrEmail', 'createRealmUser', 'executeActionsEmail']);
  const [, actions, emailOpts] = calls[2]!.args as [string, string[], { redirectUri?: string; clientId?: string }];
  expect(actions).toEqual(['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
  expect(emailOpts.redirectUri).toBe(body.invite.inviteUrl);
  expect(emailOpts.clientId).toBe('commonpractice-frontend');

  expect(await db.select().from(users).where(eq(users.id, NEW_SUB))).toHaveLength(0); // seated on accept
  const invites = await invitesFor('invite@acme-c2.test');
  expect(invites.map((i) => [i.status, i.role])).toEqual([['pending', 'tenant_admin']]);
  // The raw token is never stored — only its sha256.
  const token = new URL(body.invite.inviteUrl).searchParams.get('token')!;
  expect(invites[0]!.token_hash).not.toBe(token);
  expect(invites[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'invite.create'));
  expect(audits.length).toBe(1);
});

test('invite: an EXISTING realm identity (e.g. an fr login) is reused and never sent a credential reset', async () => {
  const { kc, calls } = makeKc({
    existingUsers: [{ id: EXISTING_SUB, username: 'frlogin@acme-c2.test', email: 'frlogin@acme-c2.test' }],
  });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', '/api/invites', { email: 'frlogin@acme-c2.test', tenantId: TENANT });
  expect(res.status).toBe(201);
  const ops = calls.map((c) => c.op);
  expect(ops).not.toContain('createRealmUser');
  expect(ops).not.toContain('executeActionsEmail'); // CP mail instead — never UPDATE_PASSWORD
  expect(ops).toEqual(['findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers']);
  const invites = await invitesFor('frlogin@acme-c2.test');
  expect(invites.length).toBe(1);
  expect(invites[0]!.keycloak_sub).toBeNull();
});

test('invite: unknown tenant → 404', async () => {
  const res = await call('POST', '/api/invites', { email: 'x@acme-c2.test', tenantId: '00000000-0000-4000-8000-0000000c2fff' });
  expect(res.status).toBe(404);
});

test('invite: an address already a member of THIS workspace → 409 already_member, KC never called', async () => {
  await db.insert(users).values({ id: EXISTING_SUB, email: 'dup-db@acme-c2.test', name: 'Dup', tenant_id: TENANT });
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', '/api/invites', { email: 'DUP-DB@acme-c2.test', tenantId: TENANT });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error).toBe('already_member');
  expect(calls.length).toBe(0);
});

test('invite: an address homed in ANOTHER workspace → 409 email_in_other_tenant, not moved', async () => {
  await db.insert(users).values({ id: ELSEWHERE_SUB, email: 'elsewhere@acme-c2.test', name: 'E', tenant_id: OTHER_TENANT });
  const res = await call('POST', '/api/invites', { email: 'elsewhere@acme-c2.test', tenantId: TENANT });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error).toBe('email_in_other_tenant');
  const [row] = await db.select().from(users).where(eq(users.id, ELSEWHERE_SUB));
  expect(row!.tenant_id).toBe(OTHER_TENANT);
  expect(await invitesFor('elsewhere@acme-c2.test')).toHaveLength(0);
});

test('invite: a FAILING executeActionsEmail still 201s, but reports emailDelivery:failed', async () => {
  // Non-fatal is right — the invite stands and can be resent — but non-fatal must not mean
  // UNREPORTED: a dead relay must not look like a delivered invite.
  const { kc, calls } = makeKc({
    createSub: NEW_SUB,
    emailThrows: new KeycloakAdminError(500, 'execute-actions-email failed: HTTP 500'),
  });
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', '/api/invites', { email: 'smtpdown@acme-c2.test', tenantId: TENANT });
  expect(res.status).toBe(201);
  expect(calls.map((c) => c.op)).toContain('executeActionsEmail'); // it was genuinely attempted
  const body = (await res.json()) as { invite: { emailDelivery: string; inviteUrl: string } };
  expect(body.invite.emailDelivery).toBe('failed');
  expect(body.invite.inviteUrl).toContain('/invite/accept?token='); // the admin can hand it over
  expect(await invitesFor('smtpdown@acme-c2.test')).toHaveLength(1);
  // ...and the outcome is durable, not just in a response nobody kept.
  const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'invite.create'));
  expect((audit?.metadata as { emailDelivery?: string } | null)?.emailDelivery).toBe('failed');
});

test('invite: an UNDECLARED body field is rejected (strict schema) — nothing is created', async () => {
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await call('POST', '/api/invites', {
    email: 'strictcheck@acme-c2.test',
    tenantId: TENANT,
    sendEmail: false, // the old suppress-mail flag no longer exists; .strict() must refuse it
  });
  expect(res.status).toBe(422);
  expect(calls.length).toBe(0);
  expect(await invitesFor('strictcheck@acme-c2.test')).toHaveLength(0);
});

// ---- email-domain routing + free-mail blocklist admin ----

test('email-domain CRUD: upsert (201) → list → delete', async () => {
  const created = await call('POST', '/api/email-domains', { domain: 'ACME-C2.test', tenantId: TENANT });
  expect(created.status).toBe(201);
  // domain is lower-cased on write.
  const [m] = await db.select().from(emailDomainTenants).where(eq(emailDomainTenants.domain, 'acme-c2.test'));
  expect(m?.tenant_id).toBe(TENANT);

  const listed = (await (await call('GET', '/api/email-domains')).json()) as { domains: { domain: string }[] };
  expect(listed.domains.some((d) => d.domain === 'acme-c2.test')).toBe(true);

  const del = await call('DELETE', '/api/email-domains/acme-c2.test');
  expect(del.status).toBe(200);
  const after = await db.select().from(emailDomainTenants).where(eq(emailDomainTenants.domain, 'acme-c2.test'));
  expect(after.length).toBe(0);
});

test('email-domain upsert into an unprovisioned tenant → 403 (fail-closed)', async () => {
  const res = await call('POST', '/api/email-domains', { domain: 'acme-c2.test', tenantId: '00000000-0000-4000-8000-0000000c2fff' });
  expect(res.status).toBe(403);
});

// The demo tenant id `…0001` is not an RFC 9562 UUID (variant nibble 0), and zod 4's `.uuid()`
// REJECTS it — so mapping a domain to the demo workspace 400'd. `z.guid()` accepts any 8-4-4-4-12
// hex id. This id has the same shape on purpose; reverting onboarding.ts to `.uuid()` turns it 400.
const NON_RFC_TENANT = '00000000-0000-0000-0000-0000000c2f01';
test('email-domain upsert accepts a non-RFC tenant id like the demo …0001 (z.guid, not .uuid)', async () => {
  await db
    .insert(tenants)
    .values({ id: NON_RFC_TENANT, name: 'guid-shape c2', slug: 'guid-shape-c2' })
    .onConflictDoNothing();
  try {
    const res = await call('POST', '/api/email-domains', { domain: 'acme-c2.test', tenantId: NON_RFC_TENANT });
    expect(res.status).toBe(201);
    const [m] = await db.select().from(emailDomainTenants).where(eq(emailDomainTenants.domain, 'acme-c2.test'));
    expect(m?.tenant_id).toBe(NON_RFC_TENANT);
  } finally {
    await db.delete(emailDomainTenants).where(eq(emailDomainTenants.tenant_id, NON_RFC_TENANT));
    await db.delete(tenants).where(eq(tenants.id, NON_RFC_TENANT));
  }
});

test('free-email-providers: add → list → delete', async () => {
  const added = await call('POST', '/api/free-email-providers', { domain: 'freemail-c2.test' });
  expect(added.status).toBe(201);
  const listed = (await (await call('GET', '/api/free-email-providers')).json()) as { providers: string[] };
  expect(listed.providers).toContain('freemail-c2.test');
  const del = await call('DELETE', '/api/free-email-providers/freemail-c2.test');
  expect(del.status).toBe(200);
});

// ---- Phase 4 / F.2: license issuance folds into onboarding (flag-gated, idempotent) ----

/** A fake licenses-admin SA client that records issuance + mints deterministic tokens.
 *  `registeredTenants` models the real service's mint guard: createLicense is REFUSED for a
 *  tenant that was never registered, which is what made every CP-created tenant 502 on approve. */
function makeLicensesAdmin(opts: { enforceMintGuard?: boolean } = {}) {
  const calls = {
    ensureTenantRegistered: [] as Array<{ tenantId: string; name: string }>,
    createLicense: [] as Array<{ subjectId: string; tenantId: string }>,
    order: [] as string[],
  };
  const registered = new Set<string>();
  let n = 0;
  const client: LicensesAdminClient = {
    async ensureTenantRegistered(tenantId, name) {
      calls.ensureTenantRegistered.push({ tenantId, name });
      calls.order.push('ensureTenantRegistered');
      registered.add(tenantId);
    },
    async createLicense(subjectId, tenantId) {
      calls.order.push('createLicense');
      if (opts.enforceMintGuard && !registered.has(tenantId)) {
        throw new LicensesAdminError(400, 'tenant is not a registered tenant');
      }
      calls.createLicense.push({ subjectId, tenantId });
      return { licenseId: LIC(++n), subjectId: SUBJ(n) };
    },
    async createToken(licenseId) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  return { client, calls };
}

async function tenantToken(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ t: tenants.license_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tryDecryptSecret(row?.t ?? null);
}

test('approve with issuance ON stores the tenant license token; a 2nd seated member does not re-issue it', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  const { client, calls } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  __setKeycloakAdminForTests(
    makeKc({
      existingUsers: [owner(NEW_SUB, 'f2-issue@acme-c2.test'), owner(EXISTING_SUB, 'f2-second@acme-c2.test')],
    }).kc,
  );
  try {
    const [approval] = await db
      .insert(signupApprovals)
      .values({ email: 'f2-issue@acme-c2.test', name: 'F2 Issue', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
      .returning();
    const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
    expect(res.status).toBe(200);
    // The tenant holds a stored, decryptable token…
    expect(await tenantToken(TENANT)).toBe(`token-${LIC(1)}`);
    // …and TWO licences were minted for this one member: the tenant-level one (0031) and the
    // member's own entitlement (0089).
    // ⛔ A2: on DIFFERENT subjects — the tenant licence is held by CP's synthetic tenant subject. On
    // the same subject licences returned ONE licence for both, and offboarding this member revoked
    // the workspace's Gate-2 licence.
    expect(calls.createLicense).toEqual([
      { subjectId: tenantLicenceSubjects(TENANT)[0], tenantId: TENANT },
      { subjectId: NEW_SUB, tenantId: TENANT },
    ]);

    // The TENANT token must not be re-issued (idempotent), while the second MEMBER gets an
    // entitlement of their own.
    const beforeSecond = calls.createLicense.length;
    const [second] = await db
      .insert(signupApprovals)
      .values({ email: 'f2-second@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: EXISTING_SUB })
      .returning();
    const res2 = await call('POST', `/api/signup-approvals/${second!.id}/approve`, {});
    expect(res2.status).toBe(200);
    expect(await tenantToken(TENANT)).toBe(`token-${LIC(1)}`);
    expect(calls.createLicense.length).toBe(beforeSecond + 1);
    expect(calls.createLicense.at(-1)).toEqual({ subjectId: EXISTING_SUB, tenantId: TENANT });
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
});

test('invite: creating an invite mints NO licence — the seat (and its licence) is taken on accept', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  const { client, calls } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  __setKeycloakAdminForTests(makeKc({ createSub: NEW_SUB }).kc);
  try {
    const res = await call('POST', '/api/invites', { email: 'nolicence@acme-c2.test', tenantId: TENANT });
    expect(res.status).toBe(201);
    expect(calls.createLicense).toEqual([]);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
});

// ---- realm-identity resolution regressions ----

test('approve: a realm user that holds the address only as a USERNAME (no email) still resolves', async () => {
  // The prod state that once caused a permanent 502: the portal realm held the address as a
  // USERNAME with no email attribute. The exact-match lookup is by username first, so it resolves.
  const { kc, calls } = makeKc({
    existingUsers: [{ id: EXISTING_SUB, username: 'dup-noemail@acme-c2.test' }], // note: no email
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'dup-noemail@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(200);
  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, approval!.id));
  expect(row?.status).toBe('approved');
  // Bound to the EXISTING realm user rather than minting a second identity, via the exact-match
  // lookup and not the whole-realm scan.
  const ops = calls.map((c) => c.op);
  expect(ops).not.toContain('createRealmUser');
  expect(ops).not.toContain('listRealmUsers');
  expect(await invitesFor('dup-noemail@acme-c2.test')).toHaveLength(1);
});

test('approve: a create 409 that re-resolves to an existing user binds to it (create race)', async () => {
  let finds = 0;
  const { kc, calls } = makeKc({ createThrows: new DuplicateUserError('user already exists') });
  kc.findRealmUserByUsernameOrEmail = async (username, email) => {
    calls.push({ op: 'findRealmUserByUsernameOrEmail', args: [username, email] });
    // First lookup: nobody (yet). After the 409: the racing create's user.
    return finds++ === 0 ? null : { id: EXISTING_SUB, username: 'race@acme-c2.test', email: 'race@acme-c2.test' };
  };
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'race@acme-c2.test', matched_tenant_id: TENANT })
    .returning();
  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(200);
  expect(calls.map((c) => c.op)).toEqual([
    'findRealmUserByUsernameOrEmail', 'createRealmUser', 'findRealmUserByUsernameOrEmail', 'getRealmRolesForUsers',
  ]);
  expect(await invitesFor('race@acme-c2.test')).toHaveLength(1);
});

test('approve: a duplicate that truly resolves to nothing is a 502 with an actionable message', async () => {
  const { kc } = makeKc({
    createThrows: new DuplicateUserError('user already exists'),
    findResult: null,
  });
  __setKeycloakAdminForTests(kc);
  const [approval] = await db
    .insert(signupApprovals)
    .values({ email: 'dup-ghost@acme-c2.test', matched_tenant_id: TENANT })
    .returning();

  const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
  expect(res.status).toBe(502);
  const body = (await res.json()) as { message?: string };
  expect(body.message).toContain('dup-ghost@acme-c2.test');
  expect(body.message).toContain('inconsistent');
});

test('approve: the tenant is REGISTERED in the licenses registry before a license is minted', async () => {
  // The licenses service refuses to mint for an unregistered tenant (its FK-backed mint guard).
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  const { client, calls } = makeLicensesAdmin({ enforceMintGuard: true });
  __setLicensesAdminForTests(client);
  __setKeycloakAdminForTests(makeKc({ existingUsers: [owner(NEW_SUB, 'mintguard@acme-c2.test')] }).kc);
  try {
    const [approval] = await db
      .insert(signupApprovals)
      .values({ email: 'mintguard@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
      .returning();
    const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
    expect(res.status).toBe(200);

    // Registered with CP's OWN tenant id under the tenant SLUG, and strictly before the mint.
    expect(calls.ensureTenantRegistered.length).toBeGreaterThan(0);
    for (const c of calls.ensureTenantRegistered) {
      expect(c).toEqual({ tenantId: TENANT, name: 'acme-c2' });
    }
    expect(calls.order.indexOf('ensureTenantRegistered')).toBeLessThan(
      calls.order.indexOf('createLicense'),
    );
    expect(await tenantToken(TENANT)).toBe(`token-${LIC(1)}`);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
});

test('approve: a licenses-registry failure is a 502 that names the tenant', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  const { client } = makeLicensesAdmin();
  client.ensureTenantRegistered = async () => {
    throw new LicensesAdminError(409, "name 'acme-c2' already belongs to another tenant");
  };
  __setLicensesAdminForTests(client);
  __setKeycloakAdminForTests(makeKc({ existingUsers: [owner(NEW_SUB, 'regfail@acme-c2.test')] }).kc);
  try {
    const [approval] = await db
      .insert(signupApprovals)
      .values({ email: 'regfail@acme-c2.test', matched_tenant_id: TENANT, keycloak_sub: NEW_SUB })
      .returning();
    const res = await call('POST', `/api/signup-approvals/${approval!.id}/approve`, {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('license_provisioning_failed');
    expect(body.message).toContain('acme-c2');
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
});

test('an existing users row that OWNS DATA is never deleted by an invite — metering survives', async () => {
  // `usage_events` etc. CASCADE from `users.id`. An invite never deletes a users row: an address
  // already homed here is simply `already_member`.
  const ghostId = GHOST_SUB; // owned by the shared cleanup — see its declaration
  await db.insert(users).values({
    id: ghostId, email: 'owns-data@acme-c2.test', name: 'Ghost', tenant_id: TENANT,
  });
  await db.insert(usageEvents).values({
    tenant_id: TENANT, user_id: ghostId, provider: 'stub', model: 'm', tokens_in: 5, tokens_out: 5,
  });

  __setKeycloakAdminForTests(makeKc({ findResult: null }).kc);
  const res = await call('POST', '/api/invites', { email: 'owns-data@acme-c2.test', tenantId: TENANT });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error?: string }).error).toBe('already_member');

  const events = await db.select().from(usageEvents).where(eq(usageEvents.user_id, ghostId));
  expect(events.length).toBe(1);
  const rows = await db.select().from(users).where(eq(users.id, ghostId));
  expect(rows.length).toBe(1);

  await db.delete(usageEvents).where(eq(usageEvents.user_id, ghostId));
  await db.delete(users).where(eq(users.id, ghostId));
});
