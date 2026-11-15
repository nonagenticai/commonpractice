// tests/member-seat-sweeps.test.ts — the reconciler's two seat sweeps (host/onboarding-integrity.ts,
// migration 0089). These back the BACKFILL, the JIT/SSO completion and the retry for a seat whose
// release the licences service never acknowledged.
//
// ⛔ WHY THESE EXIST AT ALL. `repairUnseatedMembers` selects with a drizzle-composed `NOT EXISTS`
// over interpolated column refs. `tsc` cannot check inside a `sql` template, and validating the
// equivalent hand-written SQL in psql proves nothing about the text drizzle actually emits — a
// different tree, same confident answer. So the predicate is exercised against a real database.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, tenants, users, memberEntitlements } from '../src/db/client';
import { config } from '../src/config';
import { __seatSweepsForTests } from '../src/host/onboarding-integrity';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import type { LicenseIntrospectResponse } from '../src/services/license-client';
import { renderMetrics } from '../src/host/metrics';

/** A generic counter's current value, read the way a scrape reads it (same helper shape as
 *  license-states-batch.test.ts). Compared as a DELTA — counters are process-global. */
function counter(name: string): number {
  const m = new RegExp(`^commonpractice_${name} (\\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

const T = '00000000-0000-4000-8000-00000aa50001';
const U_SEATED = '00000000-0000-4000-8000-00000aa500a1';
const U_UNSEATED = '00000000-0000-4000-8000-00000aa500a2';
const U_STAFF = '00000000-0000-4000-8000-00000aa500a3';
const U_GONE = '00000000-0000-4000-8000-00000aa500a4';
const U_SEEDED = '00000000-0000-4000-8000-00000aa500a5';
const LIC = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SUBJ = (n: number) => `11111111-1111-4111-8111-00000000000${n}`;
const ALL_USERS = [U_SEATED, U_UNSEATED, U_STAFF, U_GONE, U_SEEDED];

const T2 = '00000000-0000-4000-8000-00000aa50002';
const U_T2_A = '00000000-0000-4000-8000-00000aa500b1';
const U_T2_B = '00000000-0000-4000-8000-00000aa500b2';
const ALL_USERS_WITH_T2 = [...ALL_USERS, U_T2_A, U_T2_B];

/**
 * `tenantLevel` decides what `getActiveLicense` answers for a tenant (the svc-subject lookup
 * `services/tenant-level-licence.ts fetchTenantLevelLicence` makes):
 *   'held'      → the tenant's own svc licence (`subject_match: true`) — members need no seat;
 *   'fallback'  → a licence came back but NOT for the svc subject (`subject_match: false`) — the
 *                 service's fallback pick, which must never read as the tenant-level licence;
 *   'throw'     → a licences outage;
 *   undefined   → none (null).
 */
function makeAdmin(
  opts: {
    failRevoke?: boolean;
    tenantLevel?: Record<string, 'held' | 'fallback' | 'throw'>;
  } = {},
) {
  const calls = {
    createLicense: [] as Array<{ subjectId: string; tenantId: string }>,
    revokeByLicenseId: [] as Array<{ licenseId: string; tenantId: string }>,
    getActiveLicense: [] as Array<{ tenantId: string; subjectId?: string }>,
  };
  let n = 0;
  const client: LicensesAdminClient = {
    async ensureTenantRegistered() {},
    async createLicense(subjectId, tenantId) {
      calls.createLicense.push({ subjectId, tenantId });
      return { licenseId: LIC(++n), subjectId: SUBJ(n) };
    },
    async createToken(licenseId) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId(licenseId, tenantId) {
      calls.revokeByLicenseId.push({ licenseId, tenantId });
      if (opts.failRevoke) throw new LicensesAdminError(503, 'licenses down');
    },
    async getActiveLicense(tenantId, o = {}) {
      calls.getActiveLicense.push({ tenantId, subjectId: o.subjectId });
      const mode = opts.tenantLevel?.[tenantId];
      if (mode === 'throw') throw new LicensesAdminError(503, 'licenses down');
      if (mode === undefined) return null;
      return {
        active: true,
        subject_match: mode === 'held',
        subject_id: mode === 'held' ? o.subjectId : SUBJ(8),
        app: { key: config.license.appKey },
        tenant_id: tenantId,
      } as LicenseIntrospectResponse;
    },
  };
  return { client, calls };
}

beforeEach(async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = true;
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, ALL_USERS_WITH_T2));
  await db.delete(users).where(inArray(users.id, ALL_USERS_WITH_T2));
  await db.delete(tenants).where(eq(tenants.id, T2));
  await db
    .insert(tenants)
    .values({ id: T, name: 'Sweep Co', slug: 'sweep-co-aa5' })
    .onConflictDoNothing({ target: tenants.id });
  await db.update(tenants).set({ status: 'active', offboarded_at: null }).where(eq(tenants.id, T));
  await db.insert(users).values([
    // `keycloak_sub` recorded = "somebody has authenticated as this row", which is what the sweep
    // now demands before it will mint an identity. U_SEEDED below deliberately has none.
    { id: U_SEATED, keycloak_sub: U_SEATED, email: 's@sweep.test', name: 'Seated', tenant_id: T, role: 'employee' },
    { id: U_UNSEATED, keycloak_sub: U_UNSEATED, email: 'u@sweep.test', name: 'Unseated', tenant_id: T, role: 'employee' },
    { id: U_STAFF, keycloak_sub: U_STAFF, email: 'p@sweep.test', name: 'Staff', tenant_id: T, role: 'platform' },
    { id: U_GONE, keycloak_sub: U_GONE, email: 'g@sweep.test', name: 'Gone', tenant_id: T, role: 'employee' },
    // No `keycloak_sub`: the shape `db/seed-tenant-showcase.ts` produces (it inserts employees with
    // no id at all, so the PK is a plain uuidv7 that no realm ever issued).
    { id: U_SEEDED, email: 'seeded@sweep.test', name: 'Seeded', tenant_id: T, role: 'employee' },
  ]);
  await db.update(users).set({ deleted_at: new Date() }).where(eq(users.id, U_GONE));
  await db.insert(memberEntitlements).values({
    tenant_id: T,
    user_id: U_SEATED,
    license_id: LIC(9),
    token_encrypted: 'sealed',
    status: 'active',
  });
}, 30_000);

afterAll(async () => {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = false;
  __setLicensesAdminForTests(undefined);
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, ALL_USERS_WITH_T2));
  await db.delete(users).where(inArray(users.id, ALL_USERS_WITH_T2));
  await db.delete(tenants).where(inArray(tenants.id, [T, T2]));
}, 30_000);

test('the sweep seats EXACTLY the unseated employee — not the seated, the staff, or the departed', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  const out = await __seatSweepsForTests.repairUnseatedMembers();

  // ⚠️ SCOPED TO THIS TEST'S OWN TENANT. The sweep is estate-wide by design, and a SEEDED database
  // (CI runs `bun run seed` after `bun run migrate`) contains other live members who legitimately
  // have no entitlement yet — so a global `toEqual` here asserts the contents of the seed, not the
  // behaviour under test. It passed only on an unseeded database, which is not the one CI uses.
  const mine = calls.createLicense.filter((c) => c.tenantId === T);
  expect(out.failed).toBe(0);
  // ⭐ The three exclusions are asserted TOGETHER, because each is a different kind of wrong:
  //   • the SEATED member would be a duplicate licence (and a double-billed seat);
  //   • the PLATFORM staffer would put an operator on the CUSTOMER's invoice — billing counts a
  //     seat as a licences-service `human_subjects` entry;
  //   • the DEPARTED member would re-seat somebody an admin removed, i.e. resurrect a released seat;
  //   • the SEEDED row has no recorded `keycloak_sub`, so minting for it would register a
  //     licences-service Subject keyed on a uuidv7 that can NEVER authenticate — and bill it.
  expect(mine).toEqual([{ subjectId: U_UNSEATED, tenantId: T }]);
  expect(out.seated).toBeGreaterThanOrEqual(1);

  const rows = await db
    .select({ userId: memberEntitlements.user_id, status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(inArray(memberEntitlements.user_id, ALL_USERS));
  expect(rows.filter((r) => r.status === 'active').map((r) => r.userId).sort()).toEqual(
    [U_SEATED, U_UNSEATED].sort(),
  );
}, 30_000);

test('the sweep is idempotent — a second pass mints nothing', async () => {
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  await __seatSweepsForTests.repairUnseatedMembers();
  const afterFirst = calls.createLicense.filter((c) => c.tenantId === T).length;
  await __seatSweepsForTests.repairUnseatedMembers();
  const afterSecond = calls.createLicense.filter((c) => c.tenantId === T).length;
  // Scoped for the same reason as above: the second pass must mint nothing FOR THIS TENANT.
  expect(afterFirst).toBe(1);
  expect(afterSecond).toBe(1);
}, 30_000);

test('a member of a SUSPENDED tenant is not seated', async () => {
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T));
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);
  const out = await __seatSweepsForTests.repairUnseatedMembers();
  expect(calls.createLicense.filter((c) => c.tenantId === T)).toHaveLength(0);
  void out;
}, 30_000);

test('releaseStuckSeats clears a `revoking` row — the row that is still costing the customer money', async () => {
  await db
    .update(memberEntitlements)
    .set({ status: 'revoking' })
    .where(eq(memberEntitlements.user_id, U_SEATED));
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  const out = await __seatSweepsForTests.releaseStuckSeats();

  // ⚠️ SCOPED TO THIS TEST'S OWN ROW, NOT THE GLOBAL TALLY. The sweep is estate-wide by design (a
  // reconciler that skipped other tenants' stuck seats would be useless), so `out.released` also
  // counts `revoking` rows other suites left in this shared database. Asserting the aggregate made
  // this test fail for a reason that had nothing to do with the behaviour under test.
  expect(out.released).toBeGreaterThanOrEqual(1);
  expect(calls.revokeByLicenseId).toContainEqual({ licenseId: LIC(9), tenantId: T });
  const [row] = await db
    .select({ status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.user_id, U_SEATED));
  expect(row!.status).toBe('revoked');
}, 30_000);

test('a release that fails again STAYS `revoking` — it must not be tombstoned as if released', async () => {
  await db
    .update(memberEntitlements)
    .set({ status: 'revoking' })
    .where(eq(memberEntitlements.user_id, U_SEATED));
  const { client } = makeAdmin({ failRevoke: true });
  __setLicensesAdminForTests(client);

  const out = await __seatSweepsForTests.releaseStuckSeats();

  // Scoped for the same reason as above; what matters is that OUR row failed and survived.
  expect(out.failed).toBeGreaterThanOrEqual(1);
  const [row] = await db
    .select({ status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.user_id, U_SEATED));
  // Still billable, and still in the sweep's queue. Tombstoning here would make an unreleased seat
  // indistinguishable from a released one — and the retry would never run again.
  expect(row!.status).toBe('revoking');
}, 30_000);

test('a member with NO recorded keycloak_sub is NEVER seated — an unproven identity is not a seat', async () => {
  // ⛔ THE DEFECT THIS PINS, AND IT WAS LIVE IN THIS SWEEP. `repairUnseatedMembers` selects by
  // PREDICATE, not by provenance. `db/seed-tenant-showcase.ts` inserts `role:'employee'` users with
  // NO id, so the PK defaults to `uuidv7()` — a value no Keycloak realm ever issued. The first
  // version of this sweep matched those rows and would have called
  // `createLicense(<uuidv7>, tenant)`, registering a licences-service Subject keyed on something
  // that can never authenticate AND counting it toward `human_subjects`, i.e. billing the customer
  // for a fictional colleague. On production most CommonPractice users are exactly those rows.
  //
  // The guard is the RECORDED sub, not the id: `upsertLocalUserTx` writes it on the onboarding
  // paths and `ensureUser` backfills it from a VERIFIED JWT, so its presence means "somebody has
  // authenticated as this row" and its absence means we must not invent an identity.
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  await __seatSweepsForTests.repairUnseatedMembers();

  const minted = calls.createLicense.filter((c) => c.tenantId === T).map((c) => c.subjectId);
  expect(minted).toContain(U_UNSEATED); // the proven member IS seated
  expect(minted).not.toContain(U_SEEDED); // the unproven one is NOT
  const rows = await db
    .select({ userId: memberEntitlements.user_id })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.user_id, U_SEEDED));
  expect(rows).toHaveLength(0);
}, 30_000);

test('a `pending` row stranded past its lease is RE-SEATED — a crash mid-mint must not lock a member out forever', async () => {
  // `pending` is written BEFORE the central mint. A pod dying between the two leaves this row, and
  // the per-member gate denies anyone without an `active` entitlement.
  await db.insert(memberEntitlements).values({
    tenant_id: T,
    user_id: U_UNSEATED,
    status: 'pending',
    updated_at: new Date(Date.now() - 24 * 3600_000),
  });
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  await __seatSweepsForTests.repairUnseatedMembers();

  expect(calls.createLicense.filter((c) => c.tenantId === T)).toEqual([
    { subjectId: U_UNSEATED, tenantId: T },
  ]);
  const [row] = await db
    .select({ status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.user_id, U_UNSEATED));
  expect(row!.status).toBe('active');
}, 30_000);

test('a FRESH `pending` row is left alone — another caller holds its live claim', async () => {
  await db.insert(memberEntitlements).values({ tenant_id: T, user_id: U_UNSEATED, status: 'pending' });
  const { client, calls } = makeAdmin();
  __setLicensesAdminForTests(client);

  await __seatSweepsForTests.repairUnseatedMembers();

  expect(calls.createLicense.filter((c) => c.tenantId === T)).toEqual([]);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// Tenant-level (svc:) licence (#415). A member of a tenant holding its bundle licence gets NO
// `member_entitlements` row, so the predicate re-selects them on every tick. The sweep must skip
// them with ONE lookup per tenant, not attempt (and look up) each member forever.

/** A second tenant with TWO unseated, proven members — so "once per tenant" is measurable. */
async function seedSecondTenant(): Promise<void> {
  await db.insert(tenants).values({ id: T2, name: 'Svc Co', slug: 'svc-co-aa5' });
  await db.insert(users).values([
    { id: U_T2_A, keycloak_sub: U_T2_A, email: 'a@svc.test', name: 'A', tenant_id: T2, role: 'employee' },
    { id: U_T2_B, keycloak_sub: U_T2_B, email: 'b@svc.test', name: 'B', tenant_id: T2, role: 'employee' },
  ]);
}

test('a tenant holding its tenant-level licence is SKIPPED — no mint, no row, ONE lookup for its members', async () => {
  await seedSecondTenant();
  const { client, calls } = makeAdmin({ tenantLevel: { [T2]: 'held' } });
  __setLicensesAdminForTests(client);
  const skippedBefore = counter('member_seat_repair_skipped_tenant_level_total');

  const out = await __seatSweepsForTests.repairUnseatedMembers();

  expect(calls.createLicense.filter((c) => c.tenantId === T2)).toEqual([]);
  // Two members, one question. The per-member re-check inside `ensureMemberEntitlement` never ran.
  expect(calls.getActiveLicense.filter((c) => c.tenantId === T2)).toHaveLength(1);
  expect(calls.getActiveLicense.find((c) => c.tenantId === T2)!.subjectId).toBe(
    `svc:${T2}:${config.license.appKey}`,
  );
  expect(out.skippedTenantLicensed).toBeGreaterThanOrEqual(2);
  expect(
    counter('member_seat_repair_skipped_tenant_level_total') - skippedBefore,
  ).toBeGreaterThanOrEqual(2);
  const rows = await db
    .select({ userId: memberEntitlements.user_id })
    .from(memberEntitlements)
    .where(inArray(memberEntitlements.user_id, [U_T2_A, U_T2_B]));
  expect(rows).toHaveLength(0);
  // The other tenant (no svc licence) is unaffected: its unseated member still mints.
  expect(calls.createLicense.filter((c) => c.tenantId === T)).toEqual([
    { subjectId: U_UNSEATED, tenantId: T },
  ]);
}, 30_000);

test('a licence that is NOT the svc one (subject_match false) is not tenant-level — members still mint', async () => {
  await seedSecondTenant();
  const { client, calls } = makeAdmin({ tenantLevel: { [T2]: 'fallback' } });
  __setLicensesAdminForTests(client);

  const out = await __seatSweepsForTests.repairUnseatedMembers();

  expect(
    calls.createLicense
      .filter((c) => c.tenantId === T2)
      .map((c) => c.subjectId)
      .sort(),
  ).toEqual([U_T2_A, U_T2_B].sort());
  const rows = await db
    .select({ userId: memberEntitlements.user_id, status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(inArray(memberEntitlements.user_id, [U_T2_A, U_T2_B]));
  expect(rows.filter((r) => r.status === 'active')).toHaveLength(2);
  void out;
}, 30_000);

test('a licences outage on the lookup FAILS that tenant once per member, mints nothing, and is not cached', async () => {
  await seedSecondTenant();
  const { client, calls } = makeAdmin({ tenantLevel: { [T2]: 'throw' } });
  __setLicensesAdminForTests(client);

  const out = await __seatSweepsForTests.repairUnseatedMembers();

  expect(calls.createLicense.filter((c) => c.tenantId === T2)).toEqual([]);
  expect(calls.getActiveLicense.filter((c) => c.tenantId === T2)).toHaveLength(1);
  expect(out.failed).toBeGreaterThanOrEqual(2);
  const rows = await db
    .select({ userId: memberEntitlements.user_id })
    .from(memberEntitlements)
    .where(inArray(memberEntitlements.user_id, [U_T2_A, U_T2_B]));
  expect(rows).toHaveLength(0);

  // Not cached across sweeps: once the service answers, the next sweep asks again and proceeds.
  const second = makeAdmin({ tenantLevel: { [T2]: 'held' } });
  __setLicensesAdminForTests(second.client);
  const out2 = await __seatSweepsForTests.repairUnseatedMembers();
  expect(second.calls.getActiveLicense.filter((c) => c.tenantId === T2)).toHaveLength(1);
  expect(out2.skippedTenantLicensed).toBeGreaterThanOrEqual(2);
}, 30_000);
