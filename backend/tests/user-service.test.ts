// tests/user-service.test.ts — first-touch provisioning (`ensureUser`) and the SSO first-login seat
// (`hydrateCpIdentity`, services/cp-identity.ts) under CP-owned tenancy.
//
// CP owns membership: `users.tenant_id` / `users.tenant_role` are the authority, and the token's
// `tenant_id` claim is ignored. So `ensureUser` seats NOBODY — it upserts the identity row (tenant
// NULL), backfills `keycloak_sub`, and refuses a tombstone. The only login-time seat is an SSO first
// login whose `idp_alias` names an enabled `identity_providers` row; its seat cap is pinned in the
// second half of this file. Its two obligations pull in opposite directions and both are asserted:
// a NEW member over the cap is refused, and an EXISTING member is NEVER refused.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  auditLog,
  memberEntitlements,
  identityProviders,
} from '../src/db/client';
import { config } from '../src/config';
import {
  __setLicensesAdminForTests,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import { ensureUser } from '../src/services/user-service';
import { hydrateCpIdentity, __resetCpIdentityForTests } from '../src/services/cp-identity';
import { getSeatUsage } from '../src/services/seat-limit';
import { renderMetrics } from '../src/host/metrics';
import type { User } from '../src/types';

const U1 = '00000000-0000-0000-0000-00000000d501';
const U2 = '00000000-0000-0000-0000-00000000d502';
const U3 = '00000000-0000-0000-0000-00000000d503'; // JIT racer A
const U4 = '00000000-0000-0000-0000-00000000d504'; // JIT racer B
const TENANT = '00000000-0000-0000-0000-00000000d5a1';
const TENANT_B = '00000000-0000-0000-0000-00000000d5a2';
const TENANTS = [TENANT, TENANT_B];
const IDS = [U1, U2, U3, U4];
const ALIAS = 'entra-user-service-test-d5a1';
const ALIAS_B = 'entra-user-service-test-d5a2';

const setCap = (max: number | null) =>
  db.update(tenants).set({ max_members: max }).where(eq(tenants.id, TENANT));

function user(id: string, opts: { claim?: string; alias?: string; roles?: string[] } = {}): User {
  return {
    id,
    email: `u-${id.slice(-4)}@test.dev`,
    name: `User ${id.slice(-4)}`,
    roles: opts.roles ?? [],
    ...(opts.claim ? { tenantId: opts.claim } : {}),
    ...(opts.alias ? { idpAlias: opts.alias } : {}),
  };
}

/** An SSO first login (or any later request) through the real hydration path. */
const ssoLogin = (id: string, opts: { alias?: string; roles?: string[]; email?: string } = {}) =>
  hydrateCpIdentity({
    ...user(id, { alias: opts.alias ?? ALIAS, roles: opts.roles }),
    ...(opts.email ? { email: opts.email } : {}),
  });

/** Read one of `host/metrics.ts`'s free-form counters out of the exposition text. */
async function counter(name: string): Promise<number> {
  const m = (await renderMetrics()).match(new RegExp(`^commonpractice_${name} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

async function cleanup() {
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, IDS));
  await db.delete(auditLog).where(inArray(auditLog.target_id, IDS));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, IDS));
  await db.delete(users).where(inArray(users.id, IDS));
  await db.delete(identityProviders).where(inArray(identityProviders.tenant_id, TENANTS));
  await db.delete(tenants).where(inArray(tenants.id, TENANTS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeEach(async () => {
  // ⛔ PIN THE ISSUANCE FLAG PER FILE: an SSO first-login seat mints its central licence inline, and
  // `config` is a process-wide singleton shared with license-provisioning.test.ts. Each test that
  // wants the mint turns it on itself.
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
  await cleanup();
  __resetCpIdentityForTests();
  await db
    .insert(tenants)
    .values(
      TENANTS.map((id) => ({ id, name: `EnsureUser ${id.slice(-4)}`, slug: `eu-${id.slice(-6)}` })),
    )
    .onConflictDoNothing({ target: tenants.id });
  await db.insert(identityProviders).values([
    { tenant_id: TENANT, alias: ALIAS, display_name: 'Test Entra', config: {} as never },
    { tenant_id: TENANT_B, alias: ALIAS_B, display_name: 'Test Entra B', config: {} as never },
  ]);
}, 30_000);
afterAll(cleanup, 30_000);

// ---- ensureUser: identity row only, never a seat ----------------------------------------------

test('ensureUser creates the identity row with tenant_id NULL and records the keycloak sub', async () => {
  await ensureUser(user(U1));
  const u = await db.select().from(users).where(eq(users.id, U1));
  expect(u).toHaveLength(1);
  expect(u[0]!.tenant_id).toBeNull(); // never fabricated (no tenant_id = sub fallback)
  // ⚠️ MUTATION TARGET: drop `keycloak_sub` from `upsertRow` and the seat reconciler cannot see it.
  expect(u[0]!.keycloak_sub).toBe(U1);
  expect(await db.select().from(tenants).where(eq(tenants.id, U1))).toHaveLength(0);
});

test('a tenant_id claim on the token seats NOBODY — the claim is ignored', async () => {
  await ensureUser(user(U1, { claim: TENANT }));
  const [row] = await db.select().from(users).where(eq(users.id, U1));
  expect(row!.tenant_id).toBeNull();
  expect(row!.tenant_role).toBeNull();
  expect((await getSeatUsage(TENANT)).used).toBe(0);
});

test('a seated row is never re-homed by a claim naming another tenant, and nothing is audited', async () => {
  await db.insert(users).values({
    id: U1,
    email: user(U1).email,
    name: 'Seated',
    keycloak_sub: U1,
    tenant_id: TENANT,
    tenant_role: 'developer',
  });
  await expect(ensureUser(user(U1, { claim: TENANT_B }))).resolves.toBeUndefined();
  const [row] = await db.select().from(users).where(eq(users.id, U1));
  expect(row!.tenant_id).toBe(TENANT);
  expect(row!.tenant_role).toBe('developer');
  expect(await db.select().from(auditLog).where(eq(auditLog.target_id, U1))).toHaveLength(0);
});

test('ensureUser backfills a NULL keycloak_sub on an existing row from the verified token', async () => {
  await db.insert(users).values({ id: U1, email: user(U1).email, name: 'Seeded', tenant_id: TENANT });
  await ensureUser(user(U1));
  const [row] = await db.select().from(users).where(eq(users.id, U1));
  expect(row!.keycloak_sub).toBe(U1);
  expect(row!.tenant_id).toBe(TENANT);
});

test('a tombstoned account is refused 403 user_offboarded and is not revived', async () => {
  await db.insert(users).values({
    id: U1,
    email: user(U1).email,
    name: 'Gone',
    keycloak_sub: U1,
    tenant_id: TENANT,
    deleted_at: new Date(),
  });
  await expect(ensureUser(user(U1))).rejects.toMatchObject({ status: 403, code: 'user_offboarded' });
  const [row] = await db.select().from(users).where(eq(users.id, U1));
  expect(row!.deleted_at).not.toBeNull();
});

test('ensureUser is idempotent, and a concurrent first touch writes exactly one row', async () => {
  await ensureUser(user(U1));
  await ensureUser(user(U1));
  expect(await db.select().from(users).where(eq(users.id, U1))).toHaveLength(1);

  await Promise.all([ensureUser(user(U2)), ensureUser(user(U2)), ensureUser(user(U2))]);
  const u = await db.select().from(users).where(eq(users.id, U2));
  expect(u).toHaveLength(1);
  expect(u[0]!.tenant_id).toBeNull();
});

// ---- SSO first login (hydrateCpIdentity + idp_alias) ------------------------------------------

test('an SSO first login seats the user as a member of the tenant that owns the alias', async () => {
  const hydrated = await ssoLogin(U1);
  expect(hydrated.tenantId).toBe(TENANT);
  expect(hydrated.roles).toContain('member');
  const [row] = await db.select().from(users).where(eq(users.id, U1));
  expect(row!.tenant_id).toBe(TENANT);
  expect(row!.tenant_role).toBe('member');
  expect(row!.keycloak_sub).toBe(U1);
});

test('an unknown or DISABLED alias seats nobody', async () => {
  expect((await ssoLogin(U1, { alias: 'entra-nope-d5' })).tenantId).toBeUndefined();
  await db.update(identityProviders).set({ enabled: false }).where(eq(identityProviders.alias, ALIAS));
  expect((await ssoLogin(U2)).tenantId).toBeUndefined();
  expect((await getSeatUsage(TENANT)).used).toBe(0);
});

test('a first login mints the central entitlement inline, without waiting for the sweep', async () => {
  const calls: string[] = [];
  const client = {
    async ensureTenantRegistered() {},
    async createLicense(subjectId: string) {
      calls.push(subjectId);
      return {
        licenseId: '00000000-0000-4000-8000-0000000000d5',
        subjectId: '11111111-1111-4111-8111-0000000000d5',
      };
    },
    async createToken(licenseId: string) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  } as unknown as LicensesAdminClient;
  __setLicensesAdminForTests(client);
  const flags = config.license as { issuanceEnabled: boolean };
  const before = await counter('jit_seat_licensed_total');
  flags.issuanceEnabled = true;
  try {
    await ssoLogin(U1);
  } finally {
    flags.issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
  expect(calls).toEqual([U1]); // called with the KEYCLOAK SUB
  const [ent] = await db.select().from(memberEntitlements).where(eq(memberEntitlements.user_id, U1));
  expect(ent!.status).toBe('active');
  expect(ent!.license_subject_id).toBe('11111111-1111-4111-8111-0000000000d5');
  expect(await counter('jit_seat_licensed_total')).toBe(before + 1);
});

test('a licences outage defers the entitlement instead of failing the login', async () => {
  const client = {
    async ensureTenantRegistered() {},
    async createLicense() {
      throw new Error('licences down');
    },
    async createToken() {
      return { token: 't' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  } as unknown as LicensesAdminClient;
  __setLicensesAdminForTests(client);
  const flags = config.license as { issuanceEnabled: boolean };
  const before = await counter('jit_seat_licence_deferred_total');
  flags.issuanceEnabled = true;
  try {
    expect((await ssoLogin(U1)).tenantId).toBe(TENANT);
  } finally {
    flags.issuanceEnabled = false;
    __setLicensesAdminForTests(undefined);
  }
  const [u] = await db.select().from(users).where(eq(users.id, U1));
  expect(u!.tenant_id).toBe(TENANT);
  expect(await counter('jit_seat_licence_deferred_total')).toBe(before + 1);
});

test('an offboarded person cannot walk back in under a NEW keycloak identity', async () => {
  // An IdP can mint a brand-new sub for a removed person: a different `users.id`, so only the
  // email tombstone check in `claimJitSeat` sees them.
  await ssoLogin(U1);
  await db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, U1));

  const back = await ssoLogin(U3, { email: user(U1).email });
  expect(back.tenantId).toBeUndefined();
  const [row] = await db.select().from(users).where(eq(users.id, U3));
  expect(row?.tenant_id ?? null).toBeNull();
});

test('a tombstone in one workspace does not bar the same person from another', async () => {
  await ssoLogin(U1);
  await db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, U1));

  const elsewhere = await ssoLogin(U4, { alias: ALIAS_B, email: user(U1).email });
  expect(elsewhere.tenantId).toBe(TENANT_B);
});

test('a first login into a FULL workspace is refused, and CREATES no local row', async () => {
  await setCap(1);
  await ssoLogin(U1); // fills the single seat
  expect((await getSeatUsage(TENANT)).used).toBe(1);

  const refused = await ssoLogin(U3);
  expect(refused.tenantId).toBeUndefined();
  expect(refused.roles).not.toContain('member');
  expect(await db.select().from(users).where(eq(users.id, U3))).toHaveLength(0);
  expect((await getSeatUsage(TENANT)).used).toBe(1);
});

test('a refusal does NOT delete a users row that was already there', async () => {
  await ensureUser(user(U3)); // row created, tenant_id NULL
  await setCap(1);
  await ssoLogin(U1);

  expect((await ssoLogin(U3)).tenantId).toBeUndefined();
  const [row] = await db.select().from(users).where(eq(users.id, U3));
  expect(row).toBeDefined(); // NOT deleted
  expect(row!.tenant_id).toBeNull(); // …but holds no seat
  expect((await getSeatUsage(TENANT)).used).toBe(1);
});

test('a super_admin is never seat-refused — and is still seated', async () => {
  await setCap(1);
  await ssoLogin(U1); // workspace is now full

  const sa = await ssoLogin(U3, { roles: ['super_admin'] });
  expect(sa.tenantId).toBe(TENANT);
  expect(sa.roles).toContain('super_admin');
  expect(await db.select().from(auditLog).where(eq(auditLog.target_id, U3))).toHaveLength(0);
});

test('a realm tenant_admin role buys no seat bypass (realm roles are ignored)', async () => {
  await setCap(1);
  await ssoLogin(U1);
  const refused = await ssoLogin(U4, { roles: ['tenant_admin'] });
  expect(refused.tenantId).toBeUndefined();
  expect(refused.roles).not.toContain('tenant_admin');
  expect(await db.select().from(users).where(eq(users.id, U4))).toHaveLength(0);
});

test('the refusal is audited once per hour per user, not per request', async () => {
  await setCap(1);
  await ssoLogin(U1);
  await ssoLogin(U3);

  const rows = await db.select().from(auditLog).where(eq(auditLog.target_id, U3));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.action).toBe('user.jit_seat_denied');
  expect(rows[0]!.category).toBe('auth');
  expect(rows[0]!.result_tone).toBe('warn');
  expect(rows[0]!.actor_id).toBeNull();
  expect(rows[0]!.metadata).toMatchObject({ tenantId: TENANT, used: 1, max: 1 });

  await ssoLogin(U3);
  await ssoLogin(U3);
  expect(await db.select().from(auditLog).where(eq(auditLog.target_id, U3))).toHaveLength(1);
});

test('three logins by the same SSO user take exactly ONE seat', async () => {
  await setCap(1);
  for (let i = 0; i < 3; i++) expect((await ssoLogin(U1)).tenantId).toBe(TENANT);
  expect(await getSeatUsage(TENANT)).toEqual({ used: 1, max: 1, remaining: 0 });
});

test('an already-seated member is never refused, even after the cap is lowered under them', async () => {
  await setCap(3);
  await ssoLogin(U1);
  await ssoLogin(U3);
  await setCap(1);

  expect((await ssoLogin(U1)).tenantId).toBe(TENANT);
  expect((await ssoLogin(U3)).tenantId).toBe(TENANT);
  expect((await getSeatUsage(TENANT)).used).toBe(2); // nobody evicted
  expect((await ssoLogin(U4)).tenantId).toBeUndefined(); // a NEW arrival is still refused
});

test('an uncapped workspace never blocks a first login', async () => {
  await Promise.all([ssoLogin(U1), ssoLogin(U3)]);
  expect((await getSeatUsage(TENANT)).used).toBe(2);
});

/** Hold the tenant row under `mode` for HOLD_MS, so a caller that wants a conflicting lock waits. */
const HOLD_MS = 1200;
function holdTenantRow(mode: 'FOR UPDATE' | 'FOR NO KEY UPDATE'): Promise<unknown> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM tenants WHERE id = ${TENANT} ${sql.raw(mode)}`);
    await new Promise((r) => setTimeout(r, HOLD_MS));
  });
}

test('a REFUSED login does not queue behind a held tenant row lock', async () => {
  // A refused user is refused on every request forever; refusing admits nobody, so it needs no lock.
  // The assertion is "the holder was still holding", not a millisecond budget.
  await setCap(1);
  await ssoLogin(U1);
  let settled = false;
  const holder = holdTenantRow('FOR UPDATE').finally(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 60));

  expect((await ssoLogin(U3)).tenantId).toBeUndefined();
  const refusedBeforeRelease = !settled;
  await holder;
  expect(refusedBeforeRelease).toBe(true);
});

test('an UNCAPPED first login takes no seat lock', async () => {
  // FOR NO KEY UPDATE conflicts with the seat claim's FOR UPDATE but not with the FK's KEY SHARE.
  const holder = holdTenantRow('FOR NO KEY UPDATE');
  await new Promise((r) => setTimeout(r, 60));
  const t0 = performance.now();
  await ssoLogin(U3);
  const elapsed = performance.now() - t0;
  await holder;

  expect(elapsed).toBeLessThan(HOLD_MS / 2);
  const [row] = await db.select().from(users).where(eq(users.id, U3));
  expect(row?.tenant_id).toBe(TENANT);
});

test('two simultaneous first logins for the LAST seat: exactly one gets in', async () => {
  await setCap(2);
  await ssoLogin(U1);
  const [a, b] = await Promise.all([ssoLogin(U3), ssoLogin(U4)]);
  expect([a.tenantId, b.tenantId].filter(Boolean)).toHaveLength(1);
  expect(await getSeatUsage(TENANT)).toEqual({ used: 2, max: 2, remaining: 0 });
});

test('parallel requests from ONE first login do not race each other for two seats', async () => {
  await setCap(1);
  const results = await Promise.all([ssoLogin(U3), ssoLogin(U3), ssoLogin(U3)]);
  expect(results.every((r) => r.tenantId === TENANT)).toBe(true);
  expect(await getSeatUsage(TENANT)).toEqual({ used: 1, max: 1, remaining: 0 });
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, U3), eq(users.tenant_id, TENANT)));
  expect(row).toBeDefined();
});
