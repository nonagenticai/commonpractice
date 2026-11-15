// tests/tenant-offboard.test.ts — POST /api/tenants/:id/offboard, the workspace-level offboard.
//
// WHAT THIS ROUTE EXISTS FOR, restated because it is what the tests assert: before it there was no
// way to offboard a TENANT. Member offboarding (DELETE /api/tenants/:id/users/:userId) works, but
// emptying a workspace meant clicking every member individually, and the last-admin guard
// (`tenantAdminIds`, src/routes/tenant-users.ts) means the FINAL administrator can never be removed
// through it at all. So every departed customer left live Keycloak identities and live, working
// `mcp_api_keys` behind.
//
// Drives the LIVE routes through the real router with identity injected by
// `__setAuthOverridesForTests` and Keycloak replaced by a recording fake, exactly as
// tests/tenant-users.test.ts does. Cross-tenant containment — and the `runAsSystem` that makes the
// key revocation real rather than a reported zero — is the separate
// tests/tenant-offboard-cross-tenant.test.ts, which must run as `cp_app` to prove anything.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  auditLog,
  mcpApiKeys,
  agentSessions,
  withTenantDb,
  memberEntitlements,
} from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { config } from '../src/config';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  tenantLicenceSubjects,
  type LicensesAdminClient,
  type SubjectLicence,
  type TenantLicence,
} from '../src/services/licenses-admin';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerTenantUserRoutes } from '../src/routes/tenant-users';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  KeycloakAdminError,
  type KeycloakAdminClient,
} from '../src/services/keycloak-admin';
import { mintKey, DEFAULT_SCOPES } from '../src/services/mcp-api-key';
import { issueAgentSession } from '../src/services/agent-session';
import type { User } from '../src/types';

// RFC-4122-valid v4 uuids (3rd group '4xxx', 4th '8xxx') so any body `.uuid()` accepts them.
const TENANT = '00000000-0000-4000-8000-00000f0b0001';
const SOLO_TENANT = '00000000-0000-4000-8000-00000f0b0002';
const SADMIN_ID = '00000000-0000-4000-8000-00000f0b0a01';
const ADMIN_ID = '00000000-0000-4000-8000-00000f0b0a02';
const MEMBER_ID = '00000000-0000-4000-8000-00000f0b0a03';
const SOLO_ADMIN_ID = '00000000-0000-4000-8000-00000f0b0a04';
const SEEDED = [SADMIN_ID, ADMIN_ID, MEMBER_ID, SOLO_ADMIN_ID];
const TENANT_IDS = [TENANT, SOLO_TENANT];

const TENANT_SLUG = 'acme-offboard';
const SOLO_SLUG = 'solo-offboard';

/** The platform operator. Its `users` row is seeded HOMELESS (`tenant_id` null) so it satisfies
 *  `audit_log.actor_id`'s FK without being counted into either tenant's headcount — otherwise the
 *  offboard would tombstone the actor performing it and every count would be off by one. */
const superAdmin: User = {
  id: SADMIN_ID,
  email: 'sa-offboard@t',
  name: 'SA',
  roles: ['platform', 'super_admin'],
  tenantId: TENANT,
};
/** The same operator, claiming SOLO_TENANT — so the member-route control below authorizes against
 *  the path tenant without a scope-switch header. */
const superAdminSolo: User = { ...superAdmin, tenantId: SOLO_TENANT };

interface KcCall {
  op: string;
  args: unknown[];
}

/**
 * Recording Keycloak fake.
 *
 * `deleteFailsFor` is the option this file exists for: the tenant offboard's contract is that ONE
 * unreachable identity is reported and the rest of the workspace still completes, so the fake has to
 * be able to fail for a SINGLE subject. A whole-client `deleteThrows` (what tenant-users.test.ts
 * uses) cannot express that and would prove only the all-or-nothing case.
 */
function makeKc(
  opts: { deleteFailsFor?: string[]; rolesByUser?: Record<string, string[]> } = {},
): { kc: KeycloakAdminClient; calls: KcCall[] } {
  const calls: KcCall[] = [];
  const fails = new Set(opts.deleteFailsFor ?? []);
  const roles = opts.rolesByUser ?? {};
  const kc: KeycloakAdminClient = {
    async createRealmUser() {
      return MEMBER_ID;
    },
    async logoutUser() {},
    async executeActionsEmail() {},
    async deleteRealmUser(userId) {
      calls.push({ op: 'deleteRealmUser', args: [userId] });
      if (fails.has(userId)) throw new KeycloakAdminError(500, `kc down for ${userId}`);
    },
    async listRealmUsers() {
      return [];
    },
    async findRealmUserByUsernameOrEmail() {
      return null;
    },
    async backfillUserEmail() {},
    async getRealmRolesForUsers(userIds) {
      calls.push({ op: 'getRealmRolesForUsers', args: [userIds] });
      // `[]`, never `null`, for an unlisted user: `null` means "could not ask Keycloak" and makes
      // the last-admin guard fail closed with a 502, which would mask the 409 the control asserts.
      return new Map(userIds.map((u) => [u, roles[u] ?? []]));
    },
    async createIdentityProvider() {},
    async getIdentityProvider() {
      return null;
    },
    async updateIdentityProvider() {},
    async deleteIdentityProvider() {},
    async createIdpMapper() {},
    async listIdpMappers() {
      return [];
    },
    async deleteIdpMapper() {},
  };
  return { kc, calls };
}

const router = new Router();
registerAdminRoutes(router);
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

const offboard = (tenantId: string, confirmSlug: string, reason?: string) =>
  call('POST', `/api/tenants/${tenantId}/offboard`, { confirmSlug, ...(reason ? { reason } : {}) });

/**
 * The `audit_log` rows for THIS tenant's offboard.
 *
 * ⛔ SCOPED BY `target_id`, AND IT HAS TO BE — this is test isolation, not a product fact. The
 * database is SHARED: bun runs this file alongside every other suite, and
 * `tests/tenant-offboard-cross-tenant.test.ts` drives the very same route against its own
 * workspaces. A bare `action = 'tenant.offboard'` count therefore measures every offboard any
 * concurrent test performed, so the exact-count assertions below (`length === 1`, `=== 2`,
 * `=== 0`) would go red for reasons that have nothing to do with the code under test — and would
 * go GREEN again on a re-run, which is the worst shape a failure can have.
 *
 * `target_id` is the tenant uuid (`routes/admin.ts` writes `targetId: t.id`) and `cleanup()`
 * already deletes by it, so it is the isolation key this file was otherwise only half using.
 */
const offboardAudits = (tenantId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'tenant.offboard'), eq(auditLog.target_id, tenantId)));

interface OffboardBody {
  tenantId: string;
  offboardedAt: string;
  alreadyOffboarded: boolean;
  usersOffboarded: number;
  keysRevoked: number;
  sessionsRevoked: number;
  seatFailures: { userId: string; email: string; message: string }[];
  /** `null` = archived, or there was nothing/no service to archive against. A STRING = the licences
   *  registry still lists this workspace as live. Three-valued on purpose — see the route. */
  archiveFailure: string | null;
  /** Non-null = the archive was deliberately NOT attempted (CP does not provably own the tenant). */
  archiveSkipped: string | null;
  residualLicencesRevoked: number;
  residualLicenceFailures: { licenseId: string | null; appKey: string | null; message: string }[];
}

async function cleanup() {
  // Runs OUTSIDE any tenant context, i.e. as the owner, so it sees every tenant.
  await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED));
  await db.delete(auditLog).where(inArray(auditLog.target_id, [...SEEDED, ...TENANT_IDS]));
  // `mcp_api_keys.issued_by` is ON DELETE SET NULL, so the users delete below would leave orphan key
  // rows rather than failing — clear them by BOTH columns (the tenant-scoped revoke this feature
  // adds is precisely about keys whose issuer is null).
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.tenant_id, TENANT_IDS));
  await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.issued_by, SEEDED));
  // `agent_sessions.user_id` is ON DELETE CASCADE, so the users delete takes them.
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, SEEDED));
  await db.delete(users).where(inArray(users.id, SEEDED));
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.tenant_id, TENANT_IDS));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// Explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause (see license-provisioning.test.ts).
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
    { id: TENANT, name: 'Acme Offboard', slug: TENANT_SLUG },
    { id: SOLO_TENANT, name: 'Solo Offboard', slug: SOLO_SLUG },
  ]);
  await db.insert(users).values([
    { id: SADMIN_ID, email: superAdmin.email, name: 'SA', tenant_id: null },
    { id: ADMIN_ID, email: 'admin@acme-offboard.test', name: 'Admin', tenant_id: TENANT },
    { id: MEMBER_ID, email: 'member@acme-offboard.test', name: 'Member', tenant_id: TENANT },
    { id: SOLO_ADMIN_ID, email: 'lone@solo-offboard.test', name: 'Lone', tenant_id: SOLO_TENANT },
  ]);
  __setKeycloakAdminForTests(makeKc().kc);
  as(superAdmin);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = ISSUANCE_AT_LOAD;
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

/** Two live MCP keys in TENANT (one per member) and one live agent session for MEMBER_ID.
 *  `issueAgentSession` runs inside a tenant-bound connection because `agent_sessions.tenant_id`
 *  defaults from the `app.current_tenant` GUC, exactly as it does on a real request. */
async function seedCredentials() {
  await mintKey({
    tenantId: TENANT,
    issuedBy: ADMIN_ID,
    name: 'admin-key',
    scopes: [...DEFAULT_SCOPES],
  });
  await mintKey({
    tenantId: TENANT,
    issuedBy: MEMBER_ID,
    name: 'member-key',
    scopes: [...DEFAULT_SCOPES],
  });
  await withTenantDb(TENANT, () => issueAgentSession(MEMBER_ID, [], TENANT));
}

test('offboard: suspends the tenant, tombstones every member, revokes every key + session — Keycloak untouched', async () => {
  await seedCredentials();
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);

  const res = await offboard(TENANT, TENANT_SLUG, 'contract ended');
  expect(res.status).toBe(200);
  const body = (await res.json()) as OffboardBody;
  expect(body.tenantId).toBe(TENANT);
  expect(body.alreadyOffboarded).toBe(false);
  expect(body.usersOffboarded).toBe(2);
  expect(body.keysRevoked).toBe(2);
  expect(body.sessionsRevoked).toBe(1);
  // ⛔ The portal realm is shared with fr: offboarding a CP workspace never touches an identity.
  expect(calls).toEqual([]);
  expect(new Date(body.offboardedAt).getTime()).toBeGreaterThan(0);

  // The tenant row: suspended AND stamped. Both matter — `suspended` is what every runtime gate
  // already denies, `offboarded_at` is what says this one can never come back.
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(t!.status).toBe('suspended');
  expect(t!.offboarded_at).toBeInstanceOf(Date);

  // Every member tombstoned — the rows SURVIVE (14 FKs reference them ON DELETE NO ACTION), which
  // is what keeps their past work attributed.
  const members = await db.select().from(users).where(eq(users.tenant_id, TENANT));
  expect(members.length).toBe(2);
  for (const m of members) expect(m.deleted_at).toBeInstanceOf(Date);

  // Every MCP key in the workspace revoked. This is the credential that outlives the Keycloak
  // identity delete and that nothing in the product could previously revoke in bulk.
  const keys = await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT));
  expect(keys.length).toBe(2);
  for (const k of keys) expect(k.revoked_at).toBeInstanceOf(Date);

  // …and the agent refresh chain, which outlives any access token.
  const sessions = await db.select().from(agentSessions).where(eq(agentSessions.user_id, MEMBER_ID));
  expect(sessions.length).toBe(1);
  expect(sessions[0]!.revoked_at).toBeInstanceOf(Date);

  const audits = await offboardAudits(TENANT);
  expect(audits.length).toBe(1);
  expect(audits[0]!.result_tone).toBe('ok');
  expect(audits[0]!.target_id).toBe(TENANT);
  expect((audits[0]!.metadata as { reason?: string }).reason).toBe('contract ended');
});

test('offboard: a second call is 200 alreadyOffboarded with the ORIGINAL timestamp and zero write counts', async () => {
  await seedCredentials();
  __setKeycloakAdminForTests(makeKc().kc);

  const first = (await (await offboard(TENANT, TENANT_SLUG)).json()) as OffboardBody;
  expect(first.alreadyOffboarded).toBe(false);
  expect(first.usersOffboarded).toBe(2);

  const second = await offboard(TENANT, TENANT_SLUG);
  expect(second.status).toBe(200);
  const body = (await second.json()) as OffboardBody;
  expect(body.alreadyOffboarded).toBe(true);
  // ⛔ BYTE-IDENTICAL. `COALESCE(offboarded_at, now())` is what makes this true; a plain
  // `SET offboarded_at = now()` would silently re-date the offboarding on every retry, which is the
  // one fact a compliance reader would come to this column for.
  expect(body.offboardedAt).toBe(first.offboardedAt);
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(t!.offboarded_at!.toISOString()).toBe(new Date(first.offboardedAt).toISOString());

  // Nothing left to do: no row was tombstoned, no key revoked, no session revoked.
  expect(body.usersOffboarded).toBe(0);
  expect(body.keysRevoked).toBe(0);
  expect(body.sessionsRevoked).toBe(0);
});

test('offboard: a SOLE-ADMIN tenant offboards fully — paired with the control that the MEMBER route still refuses', async () => {
  // THE CONTROL, FIRST, so it cannot be argued that the tenant route works because the guard was
  // quietly relaxed. `tenantAdminIds` protects a LIVE tenant's ability to administer itself; it
  // still fires, and it still makes the lone admin unremovable one-at-a-time.
  as(superAdminSolo);
  // The role is CP's own (users.tenant_role), not a Keycloak realm role.
  await db.update(users).set({ tenant_role: 'tenant_admin' }).where(eq(users.id, SOLO_ADMIN_ID));
  const refused = await call('DELETE', `/api/tenants/${SOLO_TENANT}/users/${SOLO_ADMIN_ID}`);
  expect(refused.status).toBe(409);
  const [stillThere] = await db.select().from(users).where(eq(users.id, SOLO_ADMIN_ID));
  expect(stillThere!.deleted_at).toBeNull();

  // …and the tenant route offboards that same workspace completely, because an offboarded tenant has
  // no self-administrability left to protect. It never calls `tenantAdminIds` at all.
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);
  const res = await offboard(SOLO_TENANT, SOLO_SLUG);
  expect(res.status).toBe(200);
  const body = (await res.json()) as OffboardBody;
  expect(body.usersOffboarded).toBe(1);
  expect(calls).toEqual([]); // no admin-set lookup, no identity delete

  const [gone] = await db.select().from(users).where(eq(users.id, SOLO_ADMIN_ID));
  expect(gone!.deleted_at).toBeInstanceOf(Date);
  const [t] = await db.select().from(tenants).where(eq(tenants.id, SOLO_TENANT));
  expect(t!.status).toBe('suspended');
  expect(t!.offboarded_at).toBeInstanceOf(Date);
});


const ISSUANCE_AT_LOAD = config.license.issuanceEnabled;
const ADMIN_LIC = '00000000-0000-4000-8000-00000f0b1c01';
const MEMBER_LIC = '00000000-0000-4000-8000-00000f0b1c02';

/** Licences SA fake that records every licence-id revoke and can refuse ONE of them. */
function makeLicenses(opts: { revokeFailsFor?: string[] } = {}) {
  const revoked: string[] = [];
  const client = {
    async ensureTenantRegistered() {},
    async createLicense() {
      throw new Error('not used');
    },
    async createToken() {
      throw new Error('not used');
    },
    async revokeByToken() {},
    async revokeByLicenseId(licenseId: string) {
      revoked.push(licenseId);
      if (opts.revokeFailsFor?.includes(licenseId)) throw new LicensesAdminError(503, 'licenses down');
    },
  } as unknown as LicensesAdminClient;
  return { client, revoked };
}

async function seedSeats() {
  await db.insert(memberEntitlements).values([
    { tenant_id: TENANT, user_id: ADMIN_ID, license_id: ADMIN_LIC, token_encrypted: 'sealed', status: 'active' },
    { tenant_id: TENANT, user_id: MEMBER_ID, license_id: MEMBER_LIC, token_encrypted: 'sealed', status: 'active' },
  ]);
}

const seatStatus = async (userId: string) =>
  (
    await db
      .select({ status: memberEntitlements.status })
      .from(memberEntitlements)
      .where(eq(memberEntitlements.user_id, userId))
  ).map((r) => r.status);

test('offboard: EVERY member seat is revoked centrally — the tenant licence alone left the headcount billable', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    await seedSeats();
    const lic = makeLicenses();
    __setLicensesAdminForTests(lic.client);

    const res = await offboard(TENANT, TENANT_SLUG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;

    // ⛔ By LICENCE id — a token revoke leaves the licence `active` upstream and still counted.
    expect(lic.revoked.sort()).toEqual([ADMIN_LIC, MEMBER_LIC].sort());
    expect(body.seatFailures).toEqual([]);
    expect(await seatStatus(ADMIN_ID)).toEqual(['revoked']);
    expect(await seatStatus(MEMBER_ID)).toEqual(['revoked']);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = ISSUANCE_AT_LOAD;
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('offboard: ONE unreleasable seat is 200 + reported + `revoking` (still billed), and the retry releases it', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    await seedSeats();
    const flaky = makeLicenses({ revokeFailsFor: [MEMBER_LIC] });
    __setLicensesAdminForTests(flaky.client);

    const res = await offboard(TENANT, TENANT_SLUG);
    // NOT 502: the workspace is offboarded; an unreleased seat is a billing remainder, not a
    // security one, and aborting would strand the Keycloak sweep behind a licences outage.
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    expect(body.seatFailures.map((f) => f.userId)).toEqual([MEMBER_ID]);
    expect(await seatStatus(ADMIN_ID)).toEqual(['revoked']);
    // ⚠️ NOT `revoked`: still active upstream, so it must stay visibly unreleased.
    expect(await seatStatus(MEMBER_ID)).toEqual(['revoking']);
    const audits = await offboardAudits(TENANT);
    expect(audits[0]!.result_tone).toBe('warn');

    const healed = makeLicenses();
    __setLicensesAdminForTests(healed.client);
    const retry = await offboard(TENANT, TENANT_SLUG);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as OffboardBody;
    expect(retryBody.seatFailures).toEqual([]);
    // Only the unreleased seat is re-sent; an already-revoked row is a no-op.
    expect(healed.revoked).toEqual([MEMBER_LIC]);
    expect(await seatStatus(MEMBER_ID)).toEqual(['revoked']);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = ISSUANCE_AT_LOAD;
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('reactivating an offboarded workspace → 409 tenant_offboarded (a rename still works)', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  expect((await offboard(TENANT, TENANT_SLUG)).status).toBe(200);

  const res = await call('PATCH', `/api/tenants/${TENANT}`, { status: 'active' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_offboarded');
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(t!.status).toBe('suspended'); // the refusal wrote nothing
  expect(t!.offboarded_at).toBeInstanceOf(Date);

  // NON-VACUITY: the bar is on REACTIVATION specifically, not on the whole PATCH route. Bookkeeping
  // on a dead row stays available, so this test cannot pass by the route simply being broken.
  const renamed = await call('PATCH', `/api/tenants/${TENANT}`, { name: 'Acme (offboarded)' });
  expect(renamed.status).toBe(200);
  const [after] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(after!.name).toBe('Acme (offboarded)');
  expect(after!.status).toBe('suspended');
});

// ── ⛔ AN OFFBOARDED WORKSPACE IS READ-ONLY: every licence- or state-changing route says 409 ──────
//
// Seen on prod: the /tenants/<id> page offered "Issue licence" on an offboarded tenant, and the route
// behind it would have obliged — minting a live Gate-2 licence bound to a tombstoned member. Each case
// below asserts the CODE, not just the status: the same routes answer other 409s/502s on a LIVE
// tenant in this harness (`license_issuance_disabled`, `billing_unavailable`, `tenant_not_active`), so
// a 409 alone could be the wrong refusal passing for the right one.

/** Offboard TENANT and return the row as the refusal must leave it. */
async function offboarded() {
  expect((await offboard(TENANT, TENANT_SLUG)).status).toBe(200);
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  return t!;
}

async function expectOffboardedRefusal(res: Response) {
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_offboarded');
}

test('⛔ offboarded: POST /license → 409 tenant_offboarded, before the issuance flag and the alreadyLicensed no-op', async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  try {
    const before = await offboarded();
    await expectOffboardedRefusal(await call('POST', `/api/tenants/${TENANT}/license`));
    await expectOffboardedRefusal(await call('POST', `/api/tenants/${TENANT}/license?force=1`));
    const [after] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
    expect(after!.license_token_encrypted).toEqual(before.license_token_encrypted);
    const issued = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'tenant.license_issue'), eq(auditLog.target_id, TENANT)));
    expect(issued).toEqual([]);
  } finally {
    (config.license as { issuanceEnabled: boolean }).issuanceEnabled = ISSUANCE_AT_LOAD;
  }
});

test('⛔ offboarded: PATCH refuses status (either way), seats, licence terms, BYO and billing terms — a rename still lands', async () => {
  const before = await offboarded();
  const bodies: Record<string, unknown>[] = [
    { status: 'active' },
    { status: 'suspended' },
    { maxMembers: 50 },
    { maxMembers: null },
    { planCode: 'standard' },
    { expiresAt: null },
    { byoMode: 'local_allowed' },
    { terms: { platformFeeUsd: 10, seatFeeUsd: 5, markupPct: 10 } },
    // A rename riding along does not smuggle a refused field through.
    { name: 'Acme renamed', maxMembers: 9 },
  ];
  for (const body of bodies) {
    await expectOffboardedRefusal(await call('PATCH', `/api/tenants/${TENANT}`, body));
  }
  const [after] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(after!.status).toBe('suspended');
  expect(after!.max_members).toBe(before.max_members);
  expect(after!.name).toBe(before.name);
  expect(after!.plan_code).toBe(before.plan_code);
});

test('⛔ offboarded: POST /budget/topup → 409 tenant_offboarded (a live tenant here reaches billing: 502)', async () => {
  await offboarded();
  const body = { amount: 10, idempotencyKey: 'offboarded-topup-1' };
  await expectOffboardedRefusal(await call('POST', `/api/tenants/${TENANT}/budget/topup`, body));
  // CONTROL: the live tenant gets past the guard to the billing step — a different answer entirely.
  as(superAdminSolo);
  const live = await call('POST', `/api/tenants/${SOLO_TENANT}/budget/topup`, body);
  expect(((await live.json()) as { error?: string }).error).not.toBe('tenant_offboarded');
});

test('⛔ offboarded: inviting a member → 409 tenant_offboarded, not the generic tenant_not_active', async () => {
  await offboarded();
  const res = await call('POST', `/api/tenants/${TENANT}/users`, { email: 'late-joiner@acme-offboard.test' });
  await expectOffboardedRefusal(res);
  const pending = await db
    .select()
    .from(tenantInvites)
    .where(and(eq(tenantInvites.tenant_id, TENANT), eq(tenantInvites.status, 'pending')));
  expect(pending).toEqual([]);
});

test('⛔ offboarded: minting an MCP key → 409 tenant_offboarded, no key row', async () => {
  await offboarded();
  await expectOffboardedRefusal(await call('POST', `/api/tenants/${TENANT}/mcp-keys`, { name: 'zombie' }));
  const live = await db
    .select()
    .from(mcpApiKeys)
    .where(and(eq(mcpApiKeys.tenant_id, TENANT), isNull(mcpApiKeys.revoked_at)));
  expect(live).toEqual([]);
  // CONTROL: the same call on a live tenant mints — the route is not simply broken.
  as(superAdminSolo);
  expect((await call('POST', `/api/tenants/${SOLO_TENANT}/mcp-keys`, { name: 'fine' })).status).toBe(201);
});

test('offboard: a confirmSlug mismatch is 400 confirm_mismatch and writes NOTHING', async () => {
  await seedCredentials();
  const { kc, calls } = makeKc();
  __setKeycloakAdminForTests(kc);

  const res = await offboard(TENANT, 'not-the-slug');
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('confirm_mismatch');

  // ⛔ THE POINT OF THE ASSERTION BLOCK: the guard has to sit BEFORE the transaction, not inside it.
  // A confirmation that runs after the writes is not a confirmation.
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(t!.status).toBe('active');
  expect(t!.offboarded_at).toBeNull();
  for (const m of await db.select().from(users).where(eq(users.tenant_id, TENANT))) {
    expect(m.deleted_at).toBeNull();
  }
  for (const k of await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT))) {
    expect(k.revoked_at).toBeNull();
  }
  const sessions = await db.select().from(agentSessions).where(eq(agentSessions.user_id, MEMBER_ID));
  expect(sessions[0]!.revoked_at).toBeNull();
  expect(calls.length).toBe(0); // Keycloak never touched
  expect((await offboardAudits(TENANT)).length).toBe(0);
});

test('offboard: an unknown tenant is 404 tenant_not_found', async () => {
  __setKeycloakAdminForTests(makeKc().kc);
  const res = await offboard('00000000-0000-4000-8000-00000f0b0fff', 'whatever');
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_not_found');
});

// =================================================================================================
// THE CENTRAL TENANT LIFECYCLE — three gaps that all had the same shape: CP changed its own rows and
// the licences service was never told.
//
//   SUSPEND   released the tenant licence and left every MEMBER SEAT active → a workspace nobody
//             could work in, invoiced at full headcount.
//   OFFBOARD  released the seats and left the registry TENANT `active` → a departed customer that
//             central reconciliation still counts as live.
//   CREATE    registered centrally only from inside the licence-MINTING path → with issuance off
//             (the state of every environment today) the workspace was unknown centrally and its
//             BYO posture was never stated, which `byo-posture.ts` enforces as a hard refusal of the
//             platform credential.
//
// ⚠️ HARNESS NOTE, LOAD-BEARING FOR EVERY TEST BELOW. Two DIFFERENT gates decide whether a central
// call happens, and they are not the same question:
//   • seat revoke/ensure → `config.license.issuanceEnabled` (it is minting).
//   • tenant register/archive/posture → `licencesAdminConfigured()`, i.e. is there a service to
//     talk to at all. Tests that want those must set `adminBaseUrl` + `sa.tokenUrl`.
// A test that sets only the first would pass vacuously against a route that never archived.
// =================================================================================================

type LicenceCfg = {
  adminBaseUrl: string;
  issuanceEnabled: boolean;
  sa: { tokenUrl: string };
};

/** Set the licence globals for one test and restore them, whatever happens. */
async function withLicences<T>(
  opts: { issuance: boolean; configured: boolean; client: LicensesAdminClient },
  body: () => Promise<T>,
): Promise<T> {
  const lic = config.license as LicenceCfg;
  const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled };
  lic.issuanceEnabled = opts.issuance;
  lic.adminBaseUrl = opts.configured ? 'http://licenses.test' : '';
  lic.sa.tokenUrl = opts.configured ? 'http://kc.test/token' : '';
  __setLicensesAdminForTests(opts.client);
  try {
    return await body();
  } finally {
    __setLicensesAdminForTests(undefined);
    lic.adminBaseUrl = was.base;
    lic.sa.tokenUrl = was.token;
    lic.issuanceEnabled = was.issuance;
  }
}

interface CentralLog {
  /** Every central call in the order it was made — this is what proves ARCHIVE comes LAST. */
  order: string[];
  registered: Array<{ tenantId: string; name: string }>;
  byoSet: Array<{ tenantId: string; mode: string }>;
  minted: string[];
  revokedLicences: string[];
  archived: string[];
}

/**
 * A licences fake covering the whole tenant lifecycle: register, posture, mint, revoke, archive.
 * `failing` names the operations that should throw, so each non-fatal arm can be driven on its own.
 */
type CentralOp = 'register' | 'mint' | 'revoke' | 'archive' | 'lookup' | 'list';

/**
 * `ownerKey` is what the registry's `GET /tenants/{id}` reports as the tenant's owner (licences
 * migration 050). Default `'commonpractice'` — a tenant CP created and owns, so the archive runs.
 * `undefined` models a response with no owner_key; `null` (the explicit `visible: false`) models
 * licences' generic owner-scoped 404. `subjectLicences` is what `listSubjectLicences` returns for
 * the tenant's cp-tenant subject — the input to `sweepTenantLicences`.
 */
function makeCentral(
  opts: {
    failing?: CentralOp[];
    ownerKey?: string;
    noOwnerKey?: boolean;
    visible?: boolean;
    subjectLicences?: SubjectLicence[];
    /** What `listTenantLicences` (GET /licenses?status=active) returns — the bundle licences. */
    tenantLicences?: TenantLicence[];
    /** Licence ids whose revoke throws, the rest succeed. */
    revokeFailsFor?: string[];
  } = {},
) {
  const revokeFails = new Set(opts.revokeFailsFor ?? []);
  const fails = new Set<string>(opts.failing ?? []);
  const calls: CentralLog = {
    order: [],
    registered: [],
    byoSet: [],
    minted: [],
    revokedLicences: [],
    archived: [],
  };
  let n = 0;
  const client = {
    async ensureTenantRegistered(tenantId: string, name: string) {
      calls.order.push('register');
      calls.registered.push({ tenantId, name });
      if (fails.has('register')) throw new LicensesAdminError(503, 'licences down');
    },
    async setTenantByoMode(tenantId: string, mode: string) {
      calls.order.push('byo');
      calls.byoSet.push({ tenantId, mode });
    },
    async createLicense(keycloakSub: string) {
      calls.order.push('mint');
      calls.minted.push(keycloakSub);
      if (fails.has('mint')) throw new LicensesAdminError(503, 'licences down');
      n++;
      return {
        licenseId: `00000000-0000-4000-8000-00000f0b2c0${n}`,
        subjectId: `11111111-1111-4111-8111-00000f0b2c0${n}`,
      };
    },
    async createToken(licenseId: string) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId(licenseId: string) {
      calls.order.push('revoke');
      // `revokedLicences` = revokes licences ACCEPTED (a `revokeFailsFor` id never lands in it).
      if (revokeFails.has(licenseId)) {
        throw new LicensesAdminError(403, 'revoke refused by licences: HTTP 403 app_not_issuable_by_caller');
      }
      calls.revokedLicences.push(licenseId);
      if (fails.has('revoke')) throw new LicensesAdminError(503, 'licences down');
    },
    async isTenantRegistered() {
      return true;
    },
    async archiveTenant(tenantId: string) {
      calls.order.push('archive');
      calls.archived.push(tenantId);
      if (fails.has('archive')) throw new LicensesAdminError(503, 'licences down');
    },
    async getTenant(nameOrId: string) {
      calls.order.push('lookup');
      if (fails.has('lookup')) throw new LicensesAdminError(503, 'licences down');
      if (opts.visible === false) return null;
      return {
        id: nameOrId,
        name: 'x',
        ...(opts.noOwnerKey ? {} : { ownerKey: opts.ownerKey ?? 'commonpractice' }),
      };
    },
    async listSubjectLicences(sub: string) {
      return sub === tenantLicenceSubjects(TENANT)[0] ? (opts.subjectLicences ?? []) : [];
    },
    async listTenantLicences(tenantId: string) {
      calls.order.push('list');
      if (fails.has('list')) throw new LicensesAdminError(503, 'licences down');
      return tenantId === TENANT ? (opts.tenantLicences ?? []) : [];
    },
  } as unknown as LicensesAdminClient;
  return { client, calls };
}

interface PatchBody {
  tenant: { id: string; status: string };
  seatFailures: { userId: string; email: string; message: string }[];
}

const patch = (tenantId: string, body: Record<string, unknown>) =>
  call('PATCH', `/api/tenants/${tenantId}`, body);

const updateAudits = (tenantId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'tenant.update'), eq(auditLog.target_id, tenantId)));

// ---- 1. SUSPEND RELEASES THE SEATS ---------------------------------------------------------------

test('suspend: EVERY member seat is released — a suspended tenant does not pay seats', async () => {
  await seedSeats();
  const central = makeCentral();
  await withLicences({ issuance: true, configured: false, client: central.client }, async () => {
    const res = await patch(TENANT, { status: 'suspended' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(body.tenant.status).toBe('suspended');
    expect(body.seatFailures).toEqual([]);
  });

  // ⛔ MUTATION TARGET: delete the `releaseSeatsForSuspend(...)` line from `patchTenant` and this is
  // `[]` while both rows stay `active`. That is the ORIGINAL bug verbatim — a workspace in which
  // every runtime gate denies every request, still invoiced for its whole headcount, because only
  // the LEGACY tenant licence was revoked. By LICENCE id, not token: a token revoke leaves the
  // licence `active` upstream and still counted in `human_subjects`.
  expect(central.calls.revokedLicences.sort()).toEqual([ADMIN_LIC, MEMBER_LIC].sort());
  expect(await seatStatus(ADMIN_ID)).toEqual(['revoked']);
  expect(await seatStatus(MEMBER_ID)).toEqual(['revoked']);

  // NON-VACUITY: the tenant really did move, so this cannot pass by the PATCH having 4xx'd.
  const [t] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  expect(t!.status).toBe('suspended');
}, 30_000);

test('suspend: ONE unreleasable seat is 200 + reported + left `revoking` (still billed), audited warn', async () => {
  await seedSeats();
  const central = makeCentral({ failing: ['revoke'] });
  await withLicences({ issuance: true, configured: false, client: central.client }, async () => {
    const res = await patch(TENANT, { status: 'suspended' });
    // ⛔ NOT 502. Same policy as the offboard route's seat loop: one member's licences hiccup must
    // not abort the release for everyone behind them, and the status write has already committed.
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchBody;
    expect(body.seatFailures.map((f) => f.userId).sort()).toEqual([ADMIN_ID, MEMBER_ID].sort());
  });

  // ⚠️ MUTATION TARGET: tombstone the row to `revoked` on a failed revoke and this reads `revoked` —
  // making an unreleased, STILL-BILLED seat indistinguishable from a released one, and invisible to
  // `releaseStuckSeats`, which selects exactly the `revoking` rows.
  expect(await seatStatus(ADMIN_ID)).toEqual(['revoking']);
  expect(await seatStatus(MEMBER_ID)).toEqual(['revoking']);

  const audits = await updateAudits(TENANT);
  expect(audits.length).toBe(1);
  expect(audits[0]!.result_tone).toBe('warn');
  expect((audits[0]!.metadata as { seatFailed?: number }).seatFailed).toBe(2);
}, 30_000);

// ---- 1b. REACTIVATION RE-SEATS -------------------------------------------------------------------

/** Give the two members a realm subject — the PROOF `restoreSeatsForReactivate` requires before it
 *  will mint anything against a row. */
const setSubs = (ids: string[]) =>
  Promise.all(
    ids.map((id) => db.update(users).set({ keycloak_sub: id }).where(eq(users.id, id))),
  );

/**
 * Park a (fake) stored tenant token so `reissueTenantLicense` short-circuits on
 * `storedTokenBlob` and does not mint a SECOND, tenant-level licence during these tests.
 *
 * ⚠️ ISOLATION, NOT A CLAIM ABOUT REACTIVATION. The legacy tenant licence has its own coverage
 * (tests/license-provisioning.ts); leaving it live here would push a third `createLicense` — bound
 * to `users.id`, not a realm sub — into `calls.minted` and make the per-member assertions below
 * depend on which of two rows inserted in the same statement sorts oldest.
 */
const parkTenantToken = () =>
  db
    .update(tenants)
    .set({ license_token_encrypted: 'ciphertext-not-a-real-token' })
    .where(eq(tenants.id, TENANT));

test('reactivate: every live member is re-seated — otherwise suspend is a one-way door', async () => {
  await setSubs([ADMIN_ID, MEMBER_ID]);
  await parkTenantToken();
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, TENANT));

  const central = makeCentral();
  await withLicences({ issuance: true, configured: false, client: central.client }, async () => {
    const res = await patch(TENANT, { status: 'active' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PatchBody).seatFailures).toEqual([]);
  });

  // ⛔ MUTATION TARGET: delete the `restoreSeatsForReactivate(...)` line and this is `[]`. Once
  // `perMemberGate` is on, Gate 2 checks the CALLER'S OWN entitlement — so a workspace reactivated
  // without re-seating answers `license_seat_required` to every single member: the reactivation
  // looks like it worked and nobody can get in. `reissueTenantLicense` does not cover this; it binds
  // ONE licence to the oldest member and the per-member gate never reads it.
  //
  // ⚠️ THE KEYCLOAK SUB, NOT `users.id`. They are only the same string for provisioned members;
  // sending the id would register a Subject that can never authenticate and bill for it.
  expect(central.calls.minted.sort()).toEqual([ADMIN_ID, MEMBER_ID].sort());
  expect(await seatStatus(ADMIN_ID)).toContain('active');
  expect(await seatStatus(MEMBER_ID)).toContain('active');
}, 30_000);

test('⛔ reactivate NEVER mints for a member with no realm subject — that seat would be billable and unusable', async () => {
  // Only ONE of the two members has ever authenticated. `db/seed-tenant-showcase.ts` inserts
  // `role:'employee'` rows with no id, so `users.id` is a plain uuidv7 that is not a realm subject
  // at all; minting against one registers a licences-service Subject that can never log in AND
  // counts it as a human seat on the customer's invoice.
  await setSubs([ADMIN_ID]);
  await parkTenantToken(); // see the note on parkTenantToken — isolates the LEGACY tenant licence
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, TENANT));

  const central = makeCentral();
  await withLicences({ issuance: true, configured: false, client: central.client }, async () => {
    expect((await patch(TENANT, { status: 'active' })).status).toBe(200);
  });

  // ⚠️ MUTATION TARGET: drop the `if (!member.keycloakSub) continue` guard (or fall back to
  // `member.id`) and MEMBER_ID appears here — a paid seat nobody can ever use.
  expect(central.calls.minted).toEqual([ADMIN_ID]);
  expect(await seatStatus(MEMBER_ID)).toEqual([]);
}, 30_000);

// ---- 2. OFFBOARD ARCHIVES THE TENANT CENTRALLY ---------------------------------------------------

test('offboard: the tenant is ARCHIVED centrally, and strictly AFTER every seat revoke', async () => {
  await seedSeats();
  const central = makeCentral();
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const res = await offboard(TENANT, TENANT_SLUG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    expect(body.archiveFailure).toBeNull();
    expect(body.archiveSkipped).toBeNull();
    expect(body.seatFailures).toEqual([]);
  });

  // ⛔ MUTATION TARGET: remove the archive step and this is `[]` — the workspace is gone from CP and
  // still `active` in the licences registry, which is the one disagreement neither system can see.
  expect(central.calls.archived).toEqual([TENANT]);

  // ⛔ MUTATION TARGET, AND THE ORDER IS THE WHOLE POINT: move the archive above the seat loop and
  // this assertion fails. `set_tenant_archived` only stops licences AUTHORIZING — it revokes
  // nothing, so the seats would go on counting toward `human_subjects` while the workspace looked
  // shut; and because un-archiving is a true restore, it would silently resurrect all of them.
  expect(central.calls.order.indexOf('archive')).toBe(central.calls.order.length - 1);
  expect(central.calls.order.filter((o) => o === 'revoke').length).toBe(2);
  expect(central.calls.order.indexOf('archive')).toBeGreaterThan(
    central.calls.order.lastIndexOf('revoke'),
  );
}, 30_000);

test('offboard: a failed central archive is 200 + reported + audited warn, never a 502', async () => {
  const central = makeCentral({ failing: ['archive'] });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const res = await offboard(TENANT, TENANT_SLUG);
    // By now the workspace IS offboarded — committed, suspended, tombstoned, credentials dead. A 502
    // would report a completed operation as a failure and say nothing about what actually remains.
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    // ⚠️ MUTATION TARGET: make this a boolean (`archived: false`) and the REASON is lost; make it a
    // missing key and "we never tried" and "it worked" become the same response.
    expect(body.archiveFailure).toContain('licences down');
  });

  const audits = await offboardAudits(TENANT);
  expect(audits.length).toBe(1);
  expect(audits[0]!.result_tone).toBe('warn');
  expect((audits[0]!.metadata as { centralArchiveError?: string | null }).centralArchiveError).toContain(
    'licences down',
  );
}, 30_000);

test('offboard: with NO licences service configured the archive is skipped cleanly, not failed', async () => {
  const central = makeCentral();
  await withLicences({ issuance: true, configured: false, client: central.client }, async () => {
    const body = (await (await offboard(TENANT, TENANT_SLUG)).json()) as OffboardBody;
    expect(body.archiveFailure).toBeNull();
  });
  // ⚠️ MUTATION TARGET: drop the `licencesAdminConfigured()` guard and every dev/CI offboard warns
  // on a call it was never configured to make. The skip is honest only because the paired test above
  // proves a CONFIGURED deployment really does archive — a guard with no such pair is untestable.
  expect(central.calls.archived).toEqual([]);
  const audits = await offboardAudits(TENANT);
  expect(audits[0]!.result_tone).toBe('ok');
}, 30_000);

// ---- 2b. ONLY A LICENCES TENANT CP OWNS IS EVER ARCHIVED ----------------------------------------
//
// CP tenant id == licences tenant id, and legacy CP workspaces were ADOPTED onto pre-existing
// licences tenants owned by `platform` that carry OTHER apps' licences. Archiving is tenant-wide
// (every licence on it introspects `tenant_archived`), so offboarding such a workspace must leave
// the licences tenant alone — while still revoking everything that is CP's own.

const CP_TENANT_LIC = '00000000-0000-4000-8000-00000f0b3c01';
const NULL_APP_LIC = '00000000-0000-4000-8000-00000f0b3c02';
const OTHER_APP_LIC = '00000000-0000-4000-8000-00000f0b3c03';
const subjectLics = (): SubjectLicence[] => [
  { id: CP_TENANT_LIC, tenantId: TENANT, status: 'active', appKey: 'commonpractice' },
  { id: NULL_APP_LIC, tenantId: TENANT, status: 'active', appKey: null },
  { id: OTHER_APP_LIC, tenantId: TENANT, status: 'active', appKey: 'aa-agents' },
];

test('⛔ offboard of an ADOPTED, platform-owned licences tenant: NO archive, but CP licence + seats still revoked', async () => {
  await seedSeats();
  await db.update(tenants).set({ central_link: 'adopted' }).where(eq(tenants.id, TENANT));
  const central = makeCentral({ ownerKey: 'platform', subjectLicences: subjectLics() });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const res = await offboard(TENANT, TENANT_SLUG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    expect(body.archiveFailure).toBeNull();
    expect(body.archiveSkipped).toContain('not_owned_by_cp');
    expect(body.archiveSkipped).toContain('platform');
    expect(body.seatFailures).toEqual([]);
  });

  // ⛔ MUTATION TARGET: drop the ownership gate and this is `[TENANT]` — the shared tenant, and
  // with it every other app's licences on it, switched off by one CP workspace leaving.
  expect(central.calls.archived).toEqual([]);
  // NON-VACUITY: the ownership question WAS asked, and the CP-side revokes all still ran.
  expect(central.calls.order).toContain('lookup');
  expect(central.calls.revokedLicences.sort()).toEqual([ADMIN_LIC, MEMBER_LIC, CP_TENANT_LIC].sort());
  expect(await seatStatus(ADMIN_ID)).toEqual(['revoked']);
  expect(await seatStatus(MEMBER_ID)).toEqual(['revoked']);

  // A definite "not ours" is the intended outcome, not something to re-run: audited ok, reason kept.
  const audits = await offboardAudits(TENANT);
  expect(audits.length).toBe(1);
  expect(audits[0]!.result_tone).toBe('ok');
  expect((audits[0]!.metadata as { centralArchiveSkipped?: string | null }).centralArchiveSkipped).toContain(
    'not_owned_by_cp',
  );
}, 30_000);

test('offboard: the tenant licence sweep revokes ONLY licences whose appKey is CP — never a null or foreign app key', async () => {
  const central = makeCentral({ subjectLicences: subjectLics() });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    expect((await offboard(TENANT, TENANT_SLUG)).status).toBe(200);
  });
  // ⛔ MUTATION TARGET: restore `if (l.appKey && l.appKey !== appKey) continue` and NULL_APP_LIC
  // appears here — a licence CP cannot prove is its own, revoked on a possibly shared tenant.
  expect(central.calls.revokedLicences).toEqual([CP_TENANT_LIC]);
  expect(central.calls.revokedLicences).not.toContain(NULL_APP_LIC);
  expect(central.calls.revokedLicences).not.toContain(OTHER_APP_LIC);
}, 30_000);

for (const [label, opts, expectReason] of [
  ['the owner lookup FAILS', { failing: ['lookup'] as CentralOp[] }, 'owner_lookup_failed'],
  ['the registry returns NO owner_key', { noOwnerKey: true }, 'owner_unknown'],
] as const) {
  test(`offboard: when ${label}, the archive is NOT attempted (fail safe), reported + audited warn`, async () => {
    await seedSeats();
    await db.update(tenants).set({ central_link: 'adopted' }).where(eq(tenants.id, TENANT));
    const central = makeCentral(opts);
    await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
      const res = await offboard(TENANT, TENANT_SLUG);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OffboardBody;
      expect(body.archiveSkipped).toContain(expectReason);
      expect(body.archiveFailure).toBeNull();
    });
    // ⛔ MUTATION TARGET: treat "could not tell" as "ours" and this is `[TENANT]`.
    expect(central.calls.archived).toEqual([]);
    expect(central.calls.order).toContain('lookup');
    expect(central.calls.revokedLicences.sort()).toEqual([ADMIN_LIC, MEMBER_LIC].sort());
    // Unlike a definite "not ours", "could not tell" is worth a re-run: warn.
    const audits = await offboardAudits(TENANT);
    expect(audits[0]!.result_tone).toBe('warn');
  }, 30_000);
}

test('offboard: a tenant the registry will not show CP (absent / another owner, no grant) is NOT archived', async () => {
  const central = makeCentral({ visible: false });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const body = (await (await offboard(TENANT, TENANT_SLUG)).json()) as OffboardBody;
    expect(body.archiveSkipped).toContain('not_visible_to_cp');
  });
  expect(central.calls.archived).toEqual([]);
}, 30_000);

// ---- 2c. A CP-OWNED TENANT'S BUNDLE LICENCES ARE REVOKED BEFORE THE ARCHIVE ---------------------
//
// CP's bundles mint one licence per bundle app on the tenant (`svc:<tenant>:<app>`). Neither the
// cp-tenant sweep nor the seat loop reaches them, so the archive used to leave them `active`
// (prod `cp-e2e-test-1014`: 9). licenses#265 lets the tenant OWNER revoke them.

const BUNDLE_WORKERS_LIC = '00000000-0000-4000-8000-00000f0b4c01';
const BUNDLE_KANBAN_LIC = '00000000-0000-4000-8000-00000f0b4c02';
const BUNDLE_ADOPTED_LIC = '00000000-0000-4000-8000-00000f0b4c03';
const FOREIGN_TENANT_LIC = '00000000-0000-4000-8000-00000f0b4c04';
const bundleLics = (): TenantLicence[] => [
  { id: BUNDLE_WORKERS_LIC, tenantId: TENANT, status: 'active', appKey: 'workers', bundle: 'early-access' },
  { id: BUNDLE_KANBAN_LIC, tenantId: TENANT, status: 'active', appKey: 'kanban', bundle: 'early-access' },
  // ADOPTED into the bundle: licences sets no `metadata.bundle` on it — still revoked (no filter on it).
  { id: BUNDLE_ADOPTED_LIC, tenantId: TENANT, status: 'active', appKey: 'n8n', bundle: null },
  // Defence in depth: a row the registry attributes to ANOTHER tenant is never revoked from here.
  { id: FOREIGN_TENANT_LIC, tenantId: SOLO_TENANT, status: 'active', appKey: 'workers', bundle: 'early-access' },
];

test('⛔ offboard of a CP-owned tenant revokes every bundle licence, ALL before the archive', async () => {
  await seedSeats();
  const central = makeCentral({ tenantLicences: bundleLics() });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const res = await offboard(TENANT, TENANT_SLUG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    expect(body.archiveFailure).toBeNull();
    expect(body.archiveSkipped).toBeNull();
    expect(body.residualLicencesRevoked).toBe(3);
    expect(body.residualLicenceFailures).toEqual([]);
  });

  // ⛔ MUTATION TARGET: drop `revokeResidualTenantLicences` and the three bundle licences are absent
  // here — the tenant is archived with them still `active` upstream (the prod finding).
  expect(central.calls.revokedLicences.sort()).toEqual(
    [ADMIN_LIC, MEMBER_LIC, BUNDLE_WORKERS_LIC, BUNDLE_KANBAN_LIC, BUNDLE_ADOPTED_LIC].sort(),
  );
  expect(central.calls.revokedLicences).not.toContain(FOREIGN_TENANT_LIC);
  // ⛔ ORDER: list, then every revoke, then the archive LAST.
  expect(central.calls.archived).toEqual([TENANT]);
  expect(central.calls.order.at(-1)).toBe('archive');
  expect(central.calls.order.indexOf('list')).toBeGreaterThan(central.calls.order.indexOf('lookup'));
  expect(central.calls.order.lastIndexOf('revoke')).toBeLessThan(central.calls.order.indexOf('archive'));
  expect(central.calls.order.filter((o) => o === 'revoke').length).toBe(5);

  const audits = await offboardAudits(TENANT);
  expect(audits[0]!.result_tone).toBe('ok');
  expect(audits[0]!.metadata).toMatchObject({ residualLicencesRevoked: 3, residualLicenceRevokeFailed: 0 });
}, 30_000);

test('offboard: ONE bundle licence licences refuses is reported (still active), the rest revoked, archive still runs, audited warn', async () => {
  const central = makeCentral({ tenantLicences: bundleLics(), revokeFailsFor: [BUNDLE_KANBAN_LIC] });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const res = await offboard(TENANT, TENANT_SLUG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardBody;
    // ⚠️ MUTATION TARGET: swallow the error and this is `[]` — a live licence on an archived tenant,
    // reported as a clean offboard.
    expect(body.residualLicenceFailures).toEqual([
      { licenseId: BUNDLE_KANBAN_LIC, appKey: 'kanban', message: expect.stringContaining('403') },
    ]);
    expect(body.residualLicencesRevoked).toBe(2);
    expect(body.archiveFailure).toBeNull();
  });
  expect(central.calls.revokedLicences.sort()).toEqual([BUNDLE_WORKERS_LIC, BUNDLE_ADOPTED_LIC].sort());
  expect(central.calls.archived).toEqual([TENANT]);
  const audits = await offboardAudits(TENANT);
  expect(audits[0]!.result_tone).toBe('warn');
  expect(audits[0]!.metadata).toMatchObject({ residualLicenceRevokeFailed: 1 });
}, 30_000);

test('offboard: when the tenant licences cannot be LISTED, that is reported (licenseId null), archive still runs, warn', async () => {
  const central = makeCentral({ tenantLicences: bundleLics(), failing: ['list'] });
  await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
    const body = (await (await offboard(TENANT, TENANT_SLUG)).json()) as OffboardBody;
    expect(body.residualLicenceFailures).toEqual([
      { licenseId: null, appKey: null, message: expect.stringContaining('licences down') },
    ]);
    expect(body.residualLicencesRevoked).toBe(0);
  });
  expect(central.calls.archived).toEqual([TENANT]);
  const audits = await offboardAudits(TENANT);
  expect(audits[0]!.result_tone).toBe('warn');
}, 30_000);

for (const [label, opts] of [
  ['a platform-owned (adopted) tenant', { ownerKey: 'platform' }],
  ['a tenant whose owner lookup FAILS', { failing: ['lookup'] as CentralOp[] }],
  ['a tenant licences will not show CP', { visible: false }],
] as const) {
  test(`⛔ offboard of ${label}: other apps' bundle licences are NEVER listed or revoked`, async () => {
    const central = makeCentral({ ...opts, tenantLicences: bundleLics() });
    await withLicences({ issuance: true, configured: true, client: central.client }, async () => {
      const body = (await (await offboard(TENANT, TENANT_SLUG)).json()) as OffboardBody;
      expect(body.archiveSkipped).not.toBeNull();
      expect(body.residualLicencesRevoked).toBe(0);
      expect(body.residualLicenceFailures).toEqual([]);
    });
    // ⛔ MUTATION TARGET: run the residual revoke outside the ownership gate and these appear —
    // another owner's bundle licences switched off by one CP workspace leaving.
    expect(central.calls.order).not.toContain('list');
    for (const lic of bundleLics()) expect(central.calls.revokedLicences).not.toContain(lic.id);
    expect(central.calls.archived).toEqual([]);
  }, 30_000);
}

// ---- 3. CREATE REGISTERS CENTRALLY, BEFORE THE CP ROW, INDEPENDENT OF THE ISSUANCE FLAG ----------

interface CreateBody {
  tenant: { id: string; slug: string; central_link: string | null };
}

/** `createTenant` mints its own id, so it cannot be cleaned up by this file's fixed id list. */
async function dropCreatedTenant(tenantId: string | undefined) {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.target_id, tenantId));
  await db.update(users).set({ tenant_id: null }).where(eq(users.tenant_id, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

/** makeCentral() plus the registry lookup create performs first (nothing found by name). */
function withLookup(client: LicensesAdminClient): LicensesAdminClient {
  return Object.assign(client, { async getTenant() { return null; } });
}

test('⛔ create registers the tenant + states the requested BYO posture with ISSUANCE OFF', async () => {
  const central = makeCentral();
  let created: string | undefined;
  try {
    await withLicences({ issuance: false, configured: true, client: withLookup(central.client) }, async () => {
      const res = await call('POST', '/api/tenants', { name: 'Central Register Me', byoMode: 'byo_required' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateBody;
      created = body.tenant.id;
      expect(body.tenant.central_link).toBe('registered');
      expect(central.calls.registered.map((c) => c.tenantId)).toEqual([created]);
      // The SLUG, never the display name — the registry constrains `name` to `^[a-z0-9][a-z0-9-]*$`.
      expect(central.calls.registered[0]!.name).toBe(body.tenant.slug);
      expect(central.calls.byoSet).toEqual([{ tenantId: created!, mode: 'byo_required' }]);
    });
  } finally {
    await dropCreatedTenant(created);
  }
}, 30_000);

test('create: a licences OUTAGE is a 502 and writes NO CP row — never a half-created workspace', async () => {
  const central = makeCentral({ failing: ['register'] });
  await withLicences({ issuance: false, configured: true, client: withLookup(central.client) }, async () => {
    const res = await call('POST', '/api/tenants', { name: 'Central Register Outage', byoMode: 'local_allowed' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('licences_unavailable');
  });
  // The posture write is not attempted after a failed registration.
  expect(central.calls.byoSet).toEqual([]);
  const rows = await db.select().from(tenants).where(eq(tenants.slug, 'central-register-outage'));
  expect(rows).toEqual([]);
}, 30_000);

test('create: with NO licences service nothing central is called and central_link stays NULL', async () => {
  const central = makeCentral();
  let created: string | undefined;
  try {
    await withLicences({ issuance: false, configured: false, client: withLookup(central.client) }, async () => {
      const res = await call('POST', '/api/tenants', { name: 'Central Register Unwired', byoMode: 'local_allowed' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateBody;
      created = body.tenant.id;
      expect(body.tenant.central_link).toBeNull();
    });
    expect(central.calls.registered).toEqual([]);
    expect(central.calls.byoSet).toEqual([]);
  } finally {
    await dropCreatedTenant(created);
  }
}, 30_000);
