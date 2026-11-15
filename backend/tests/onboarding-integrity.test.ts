// tests/onboarding-integrity.test.ts — the boot-time onboarding integrity census
// (host/onboarding-integrity.ts, written concurrently with this file — see the note on
// `census()` below). Pins the two predicates the module's own header describes:
//   Census A — tenants stuck with no license token (`status='active' AND offboarded_at IS NULL
//     AND license_token_encrypted IS NULL`), split by whether a live member exists who could
//     still complete onboarding (resolvable) or not (unresolvable).
//   Census B — `signup_approvals` rows with `status='pending'` ("stranded" signups), plus the
//     oldest one's age in seconds.
//   Census C — live users holding NO tenant (`tenant_id IS NULL AND deleted_at IS NULL`), split by
//     whether the onboarding queue can see them, and EXCLUDING addresses in the reserved,
//     unroutable `.local` / `.invalid` TLDs. `usersWithoutTenantUnqueued` is the series
//     `CommonPracticeSignupStrandedUnqueued` fires on; see that section's own header for why an
//     undeliverable address must not appear in it.
//
// Harness: follows tests/allowlist-reconcile.test.ts and tests/stranded-signup-is-visible.test.ts
// exactly — bun:test, the shared `db` singleton from ../src/db/client (no pool/testcontainers
// helper exists in this repo), raw drizzle inserts for fixtures, explicit 30s hook timeouts (bun
// ignores bunfig's [test] timeout for hooks), and cleanup by an owned id range run in BOTH
// beforeEach and afterAll.
//
// Membership note: there is no `tenant_members` table — it was dropped in migration
// 0025_drop_multimembership.sql. "Live member" is `users.tenant_id = tenant.id AND
// users.deleted_at IS NULL`, per schema.ts and the same convention used in tenant-offboard.test.ts
// and stranded-signup-is-visible.test.ts.
//
// Shared-DB scoping: `readOnboardingCensus()` returns a GLOBAL, unscoped aggregate over the whole
// `tenants` / `signup_approvals` tables — the exposed interface takes no tenant/run id. Per
// tenant-offboard.test.ts's own scoping note, this test DB is shared with every concurrently
// running suite, so exact absolute counts cannot be asserted. Every assertion below is therefore a
// DELTA taken immediately around inserting this file's own fixture rows (narrow race window,
// same risk this repo already accepts for other shared-table count assertions).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, users, tenants, signupApprovals } from '../src/db/client';
import {
  readOnboardingCensus,
  __resetOnboardingIntegrityCacheForTests,
  __seatSweepsForTests,
  type OnboardingIntegrityCensus,
} from '../src/host/onboarding-integrity';
import { config } from '../src/config';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';

// Own id range (hex marker `0b19` = "obi[ntegrity]") + own email domain, so cleanup here can
// never collide with tenant-offboard.test.ts's `0f0b*` range or stranded-signup-is-visible's
// `e5*` range / `@stranded.test` domain.
const T_RESOLVABLE = '00000000-0000-4000-8000-00000b190001';
const T_UNRESOLVABLE_NOMEMBER = '00000000-0000-4000-8000-00000b190002';
const T_UNRESOLVABLE_TOMBSTONED = '00000000-0000-4000-8000-00000b190003';
const T_OFFBOARDED = '00000000-0000-4000-8000-00000b190004';
const T_SUSPENDED = '00000000-0000-4000-8000-00000b190005';
const T_LICENSED = '00000000-0000-4000-8000-00000b190006';
// Census A4 (central registration repair) fixtures.
const T_UNREGISTERED = '00000000-0000-4000-8000-00000b190007';
const T_REGISTERED = '00000000-0000-4000-8000-00000b190008';
const T_UNREG_OFFBOARDED = '00000000-0000-4000-8000-00000b190009';
const T_LINKED = '00000000-0000-4000-8000-00000b19000a';
const T_NAME_CONFLICT = '00000000-0000-4000-8000-00000b19000b';
const TENANT_IDS = [
  T_LINKED,
  T_NAME_CONFLICT,
  T_RESOLVABLE,
  T_UNRESOLVABLE_NOMEMBER,
  T_UNRESOLVABLE_TOMBSTONED,
  T_OFFBOARDED,
  T_SUSPENDED,
  T_LICENSED,
  T_UNREGISTERED,
  T_REGISTERED,
  T_UNREG_OFFBOARDED,
];

const U_RESOLVABLE = '00000000-0000-4000-8000-00000b19a001';
const U_TOMBSTONED = '00000000-0000-4000-8000-00000b19a002';
// Census C fixtures: live users holding NO tenant at all.
const U_ORPHAN_REAL = '00000000-0000-4000-8000-00000b19a003'; // deliverable → counted
const U_ORPHAN_LOCAL = '00000000-0000-4000-8000-00000b19a004'; // `.local` → excluded
const U_ORPHAN_INVALID = '00000000-0000-4000-8000-00000b19a005'; // `.invalid` → excluded
const U_ORPHAN_LOCALPART = '00000000-0000-4000-8000-00000b19a006'; // `.local` in the LOCAL PART
const U_ORPHAN_PLATFORM = '00000000-0000-4000-8000-00000b19a007'; // platform staff → excluded
const USER_IDS = [
  U_RESOLVABLE,
  U_TOMBSTONED,
  U_ORPHAN_REAL,
  U_ORPHAN_LOCAL,
  U_ORPHAN_INVALID,
  U_ORPHAN_LOCALPART,
  U_ORPHAN_PLATFORM,
];

const SA_PENDING_OLD = '00000000-0000-4000-8000-00000b19f001';
const SA_PENDING_YOUNG = '00000000-0000-4000-8000-00000b19f002';
const SIGNUP_IDS = [SA_PENDING_OLD, SA_PENDING_YOUNG];

async function cleanup() {
  // users.tenant_id -> tenants ON DELETE SET NULL, so this null-out is belt-and-suspenders (not
  // strictly required before deleting tenants below) but matches the defensive style of the
  // sibling test files.
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(signupApprovals).where(inArray(signupApprovals.id, SIGNUP_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

beforeEach(cleanup, 30_000);
afterAll(cleanup, 30_000);

/**
 * ⚠️ THE RESET IS NOT OPTIONAL, AND OMITTING IT IS A SILENT FALSE PASS.
 * `readOnboardingCensus()` serves a 60s TTL cache (`ONBOARDING_INTEGRITY_TTL_MS`) and returns the
 * PREVIOUS value verbatim inside that window. Every test below inserts fixtures and then asserts a
 * delta, so without forgetting the cache first, test 2 onwards would assert against test 1's
 * snapshot — rows this test never inserted, taken before the ones it did. The failure would look
 * like a flaky count rather than a stale read, which is the worst shape of wrong.
 *
 * `__resetOnboardingIntegrityCacheForTests()` clears both `cached` and the TTL clock, so the next
 * call is a genuine DB round trip.
 *
 * ⛔ Deliberately does NOT call `startOnboardingIntegrity()`. That arms a 5-minute re-arming timer
 * for the process lifetime AND runs the repair pass, which calls `ensureTenantLicense` against the
 * real licences service. A census assertion needs neither; starting a scheduler to read a number
 * would leave a live timer behind and let a unit test issue licences.
 */
async function census(): Promise<OnboardingIntegrityCensus> {
  __resetOnboardingIntegrityCacheForTests();
  const c = await readOnboardingCensus();
  if (!c) {
    throw new Error(
      'readOnboardingCensus() returned undefined immediately after a cache reset — the underlying ' +
        'read failed (it never throws by contract, so the error is in the DB read, not here).',
    );
  }
  return c;
}

async function seedTenant(opts: {
  id: string;
  slug: string;
  status?: 'active' | 'suspended';
  offboarded_at?: Date | null;
  license_token_encrypted?: string | null;
  central_link?: 'registered' | 'adopted' | null;
}) {
  await db.insert(tenants).values({
    id: opts.id,
    name: `Onboarding Integrity ${opts.slug}`,
    slug: opts.slug,
    status: opts.status ?? 'active',
    offboarded_at: opts.offboarded_at ?? null,
    license_token_encrypted: opts.license_token_encrypted ?? null,
    central_link: opts.central_link ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Census A: tenants stuck with no license token
// ---------------------------------------------------------------------------------------------

test('active, not offboarded, NULL token, one live member -> resolvable', async () => {
  const before = await census();
  await seedTenant({ id: T_RESOLVABLE, slug: 'ob-resolvable' });
  await db.insert(users).values({
    id: U_RESOLVABLE,
    email: 'ob-resolvable@onboarding-integrity.test',
    name: 'Live Member',
    tenant_id: T_RESOLVABLE,
  });

  const after = await census();
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(1);
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(0);
});

test('same, but zero live members -> unresolvable, and not auto-repaired', async () => {
  const before = await census();
  await seedTenant({ id: T_UNRESOLVABLE_NOMEMBER, slug: 'ob-nomember' });

  const after = await census();
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(1);
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(0);

  // "Not repaired": the census is a read-only observation, not a mutation. The row it just
  // counted must still be exactly what we seeded.
  const [row] = await db.select().from(tenants).where(eq(tenants.id, T_UNRESOLVABLE_NOMEMBER));
  expect(row!.status).toBe('active');
  expect(row!.offboarded_at).toBeNull();
  expect(row!.license_token_encrypted).toBeNull();
});

test('same, but every member is soft-deleted -> unresolvable; tombstones are not members', async () => {
  const before = await census();
  await seedTenant({ id: T_UNRESOLVABLE_TOMBSTONED, slug: 'ob-tombstoned' });
  await db.insert(users).values({
    id: U_TOMBSTONED,
    email: 'ob-tombstoned@onboarding-integrity.test',
    name: 'Departed Member',
    tenant_id: T_UNRESOLVABLE_TOMBSTONED,
    deleted_at: new Date(),
  });

  const after = await census();
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(1);
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(0);
});

// -- negative controls: none of these belong in EITHER bucket -----------------------------------

test('an offboarded tenant (offboarded_at set) with a NULL token is counted in neither bucket', async () => {
  // Deliberately leaves `status` at its default 'active' rather than mirroring the real offboard
  // route (which also flips status to 'suspended'). The task's predicate lists status and
  // offboarded_at as two independent guards — this isolates the offboarded_at branch so a
  // predicate that forgot to check it can't hide behind the status check caught by the next test.
  const before = await census();
  await seedTenant({ id: T_OFFBOARDED, slug: 'ob-offboarded', offboarded_at: new Date() });

  const after = await census();
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(0);
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(0);
});

test('a suspended (not offboarded) tenant with a NULL token is counted in neither bucket', async () => {
  const before = await census();
  await seedTenant({ id: T_SUSPENDED, slug: 'ob-suspended', status: 'suspended' });

  const after = await census();
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(0);
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(0);
});

test('a tenant WITH a license token is counted in neither bucket, even with zero members', async () => {
  const before = await census();
  await seedTenant({
    id: T_LICENSED,
    slug: 'ob-licensed',
    license_token_encrypted: 'ciphertext-not-a-real-token',
  });

  const after = await census();
  expect(after.tenantsUnlicensedResolvable - before.tenantsUnlicensedResolvable).toBe(0);
  expect(after.tenantsUnlicensedUnresolvable - before.tenantsUnlicensedUnresolvable).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// Census B: stranded signup_approvals
// ---------------------------------------------------------------------------------------------

test('signupStrandOldestAgeSeconds is 0 (not undefined/NaN) whenever there are zero pending rows', async () => {
  // Mirrors the conditional-assertion idiom in allowlist-reconcile.test.ts's "REAL dev fixture"
  // test: the DB is shared, so the global pending count can't be forced to zero on demand. The
  // strong claim from the task (age === 0, not undefined/NaN) is asserted only when the live
  // state actually satisfies its precondition (zero pending rows anywhere) — that precondition
  // does hold here because beforeEach has just deleted this file's own pending rows and no other
  // test in this file has inserted any yet. Whether or not the precondition holds, the weaker
  // shape assertions (finite, non-negative) always run and still catch the NaN/undefined
  // regression class the task names.
  const c = await census();
  expect(Number.isFinite(c.signupStrandOldestAgeSeconds)).toBe(true);
  expect(c.signupStrandOldestAgeSeconds).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(c.signupStrandPending)).toBe(true);
  expect(c.signupStrandPending).toBeGreaterThanOrEqual(0);
  if (c.signupStrandPending === 0) {
    expect(c.signupStrandOldestAgeSeconds).toBe(0);
  }
});

test('two pending rows of different ages -> the older one sets signupStrandOldestAgeSeconds', async () => {
  const before = await census();

  const youngCreatedAt = new Date(Date.now() - 60_000); // 1 minute old
  const oldCreatedAt = new Date(Date.now() - 315_360_000_000); // ~10 years old — safely older than
  // any realistic pending row already sitting in a dev/CI database, which is what lets us prove
  // the aggregate MAX moved to reflect ours rather than pre-existing debris, without needing to
  // touch (or even see) rows this file doesn't own.

  await db.insert(signupApprovals).values([
    {
      id: SA_PENDING_YOUNG,
      email: 'ob-pending-young@onboarding-integrity.test',
      status: 'pending',
      created_at: youngCreatedAt,
    },
    {
      id: SA_PENDING_OLD,
      email: 'ob-pending-old@onboarding-integrity.test',
      status: 'pending',
      created_at: oldCreatedAt,
    },
  ]);

  const after = await census();
  expect(after.signupStrandPending - before.signupStrandPending).toBe(2);

  const expectedOldestAgeSeconds = (Date.now() - oldCreatedAt.getTime()) / 1000;
  const youngAgeSeconds = (Date.now() - youngCreatedAt.getTime()) / 1000;
  // Wide tolerance for clock skew / query latency — the point being proven is "picked the
  // ~10-year-old row, not the 1-minute-old one," not a tight timing assertion.
  expect(after.signupStrandOldestAgeSeconds).toBeGreaterThan(expectedOldestAgeSeconds - 30);
  expect(after.signupStrandOldestAgeSeconds).toBeGreaterThan(youngAgeSeconds + 1_000);
});

// ---------------------------------------------------------------------------------------------
// Census C: live users holding NO tenant, split by whether the onboarding queue can see them.
// `usersWithoutTenantUnqueued` IS `commonpractice_users_without_tenant{queued="false"}`, the series
// `CommonPracticeSignupStrandedUnqueued` fires on.
//
// ⛔ WHAT THESE PIN, AND WHY. The census excludes addresses in the reserved, unroutable `.local`
// (RFC 6762) and `.invalid` (RFC 2606) TLDs. Neither can hold an MX record, so such an account can
// never receive the mail every step past the queue depends on: it can never confirm a realm
// identity and can never complete onboarding. Approving it and rejecting it are equally meaningless
// — so counting it makes the alert fire FOREVER on a row no human can ever action, which is not a
// signal but a permanent red light that teaches its readers to ignore the panel.
//
// The exclusion is only half a claim on its own: "a `.local` user is not counted" also passes if
// NOTHING is counted. Every test below therefore measures a delta, and the deliverable-address test
// is what proves the census still counts a real stranded person.
//
// ⚠️ Deltas, not absolutes — the same shared-DB scoping this file's header already describes.

/** Plants one live user holding no tenant and no queue row — the census C population. */
async function seedOrphan(id: string, email: string, name: string): Promise<void> {
  await db.insert(users).values({ id, email, name, tenant_id: null });
}

test('census C counts a stranded user at a DELIVERABLE address', async () => {
  // The non-vacuity anchor for every exclusion test below: if this delta were 0, "the `.local` row
  // is not counted" would be proving nothing at all.
  const before = await census();
  await seedOrphan(U_ORPHAN_REAL, 'ob-orphan-real@onboarding-integrity.test', 'Real Orphan');

  const after = await census();
  expect(after.usersWithoutTenantUnqueued - before.usersWithoutTenantUnqueued).toBe(1);
  expect(after.usersWithoutTenantQueued - before.usersWithoutTenantQueued).toBe(0);
});

test('⛔ census C does NOT count a stranded `.local` user — RFC 6762, unroutable, unanswerable', async () => {
  const before = await census();
  await seedOrphan(U_ORPHAN_LOCAL, 'ob-orphan@commonpractice.local', 'Local Orphan');

  const after = await census();
  expect(after.usersWithoutTenantUnqueued - before.usersWithoutTenantUnqueued).toBe(0);
  // Not counted in the OTHER bucket either — excluded from census C entirely, not reclassified.
  expect(after.usersWithoutTenantQueued - before.usersWithoutTenantQueued).toBe(0);

  // …and the row really is there, live and tenant-less. Without this the zero delta above would
  // also hold if the insert had silently failed, which is the same shape of false pass the
  // exclusion is meant to remove from the alert.
  const [row] = await db.select().from(users).where(eq(users.id, U_ORPHAN_LOCAL));
  expect(row!.tenant_id).toBeNull();
  expect(row!.deleted_at).toBeNull();
});

test('⛔ census C does NOT count a stranded `example.invalid` user — RFC 2606, same principle', async () => {
  const before = await census();
  await seedOrphan(U_ORPHAN_INVALID, 'ob-orphan@example.invalid', 'Invalid Orphan');

  const after = await census();
  expect(after.usersWithoutTenantUnqueued - before.usersWithoutTenantUnqueued).toBe(0);
  expect(after.usersWithoutTenantQueued - before.usersWithoutTenantQueued).toBe(0);

  const [row] = await db.select().from(users).where(eq(users.id, U_ORPHAN_INVALID));
  expect(row!.tenant_id).toBeNull();
});

test('⛔ the exclusion is anchored to the DOMAIN: `a.local@…test` IS still counted', async () => {
  // The counter-case that keeps the filter honest. An unanchored match on `.local` anywhere in the
  // address would drop this DELIVERABLE one, hiding a real stranded person from the only alert that
  // can surface them — the exact harm the exclusion exists to avoid, inverted.
  const before = await census();
  await seedOrphan(U_ORPHAN_LOCALPART, 'a.local@onboarding-integrity.test', 'Localpart Orphan');

  const after = await census();
  expect(after.usersWithoutTenantUnqueued - before.usersWithoutTenantUnqueued).toBe(1);
});

test('⛔ census C does NOT count a workspace-less PLATFORM row — a super_admin, never queued by design', async () => {
  const before = await census();
  await db.insert(users).values({
    id: U_ORPHAN_PLATFORM,
    email: 'ob-orphan-platform@onboarding-integrity.test',
    name: 'Platform Orphan',
    tenant_id: null,
    role: 'platform',
  });
  const after = await census();
  expect(after.usersWithoutTenantUnqueued - before.usersWithoutTenantUnqueued).toBe(0);
  expect(after.usersWithoutTenantQueued - before.usersWithoutTenantQueued).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// Census A4 + repair: TENANTS CP KNOWS ABOUT AND THE LICENCES REGISTRY DOES NOT.
//
// ⛔ WHY THIS SWEEP IS NOT COSMETIC. An unregistered tenant is answered `byo_required` by
// `getTenantByoMode`, and `services/byo-posture.ts` enforces that as a HARD REFUSE — so the
// workspace cannot make one platform-credentialled LLM call, including against the welcome budget
// its own create request granted it. The licences service also refuses to MINT for it, so the first
// member onboard 502s. `routes/admin.ts createTenant` now registers at create; this sweep is what
// reaches every tenant that predates that, and every create that hit a licences outage (which is
// deliberately non-fatal there).
//
// Harness: the sweep is driven DIRECTLY via `__seatSweepsForTests`, never via
// `startOnboardingIntegrity()` — that would arm a 5-minute timer for the process lifetime and run
// the licence-issuing passes too.
//
// ⚠️ SHARED DB, so the sweep sees every other suite's active tenants as well as this file's. The
// fake below therefore reports "already registered" for everything OUTSIDE the fixture set and
// every assertion is about this file's own ids — never about `checked`, which counts the whole
// fleet and would be a different number on every run.
// ---------------------------------------------------------------------------------------------

interface RegistryCalls {
  probed: string[];
  registered: Array<{ tenantId: string; name: string }>;
  byoSet: Array<{ tenantId: string; mode: string }>;
}

/** A licences client that knows about `known` and nothing else. `probeThrowsFor` simulates the
 *  outage arm — the one that must NOT be read as "unregistered". */
function makeRegistry(
  opts: { known?: string[]; probeThrowsFor?: string[]; nameConflictFor?: string[]; foreignIdFor?: string[] } = {},
) {
  const known = new Set(opts.known ?? []);
  const conflictFor = new Set(opts.nameConflictFor ?? []);
  const foreignIdFor = new Set(opts.foreignIdFor ?? []);
  const throwsFor = new Set(opts.probeThrowsFor ?? []);
  const calls: RegistryCalls = { probed: [], registered: [], byoSet: [] };
  const client = {
    async ensureTenantRegistered(tenantId: string, name: string) {
      if (conflictFor.has(tenantId)) throw new LicencesNameConflictError(name);
      if (foreignIdFor.has(tenantId)) throw new LicencesTenantOwnedByOtherAppError(tenantId);
      calls.registered.push({ tenantId, name });
      known.add(tenantId);
    },
    async createLicense() {
      throw new Error('not used');
    },
    async createToken() {
      throw new Error('not used');
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
    async isTenantRegistered(tenantId: string) {
      calls.probed.push(tenantId);
      if (throwsFor.has(tenantId)) throw new LicensesAdminError(503, 'licences down');
      // Anything this file did not seed is treated as already registered, so the sweep does no work
      // on another suite's rows and this test asserts only about its own.
      if (!TENANT_IDS.includes(tenantId)) return true;
      return known.has(tenantId);
    },
    async setTenantByoMode(tenantId: string, mode: string) {
      calls.byoSet.push({ tenantId, mode });
    },
  } as unknown as LicensesAdminClient;
  return { client, calls };
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string } };

/** Run the registration sweep with licences CONFIGURED but issuance OFF — the state this whole
 *  feature exists for — restoring every mutated global afterwards. */
async function runRegistrationSweep(client: LicensesAdminClient) {
  const lic = config.license as LicenceCfg;
  const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled };
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  // ⛔ OFF. The sweep must not be gated on licence MINTING — see `licencesAdminConfigured`.
  lic.issuanceEnabled = false;
  __setLicensesAdminForTests(client);
  try {
    return await __seatSweepsForTests.repairUnregisteredTenants();
  } finally {
    __setLicensesAdminForTests(undefined);
    lic.adminBaseUrl = was.base;
    lic.sa.tokenUrl = was.token;
    lic.issuanceEnabled = was.issuance;
  }
}

test('the sweep registers an UNKNOWN active tenant and states its BYO posture — with issuance OFF', async () => {
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });
  await seedTenant({ id: T_REGISTERED, slug: 'ob-registered' });

  const reg = makeRegistry({ known: [T_REGISTERED] });
  const out = await runRegistrationSweep(reg.client);

  expect(reg.calls.registered.map((c) => c.tenantId)).toEqual([T_UNREGISTERED]);
  // ⚠️ MUTATION TARGET: pass `tenant.name` instead of `tenant.slug` and licences rejects it — the
  // registry constrains the name to `^[a-z0-9][a-z0-9-]*$`, and "Onboarding Integrity ob-…" is not.
  expect(reg.calls.registered[0]!.name).toBe('ob-unregistered');
  expect(reg.calls.byoSet).toEqual([{ tenantId: T_UNREGISTERED, mode: 'local_allowed' }]);
  expect(out.registered).toBe(1);
  expect(out.failed).toBe(0);

  // ⛔ MUTATION TARGET: gate the sweep on `config.license.issuanceEnabled` instead of
  // `licencesAdminConfigured()` and this goes to 0 registered — which is exactly the conflation the
  // feature closes, since issuance is OFF in every environment today.
  expect(reg.calls.probed).toContain(T_UNREGISTERED);
});

test('⛔ an ALREADY-registered tenant is never re-PUT and its BYO posture is never re-asserted', async () => {
  await seedTenant({ id: T_REGISTERED, slug: 'ob-registered' });

  const reg = makeRegistry({ known: [T_REGISTERED] });
  await runRegistrationSweep(reg.client);

  // ⛔ MUTATION TARGET, AND THE MOST EXPENSIVE ONE IN THIS FILE. Move `setTenantByoMode` above the
  // `if (registered) continue` — or replace the probe with an unconditional idempotent
  // `ensureTenantRegistered` — and this sweep re-asserts `local_allowed` over an operator's
  // deliberate central `byo_required` EVERY FIVE MINUTES, silently moving that customer's LLM spend
  // onto the platform's credential. The re-PUT would also overwrite any rename done centrally.
  expect(reg.calls.probed).toContain(T_REGISTERED);
  expect(reg.calls.registered).toEqual([]);
  expect(reg.calls.byoSet).toEqual([]);
});

test('⛔ a probe FAILURE counts as failed, never as "unregistered"', async () => {
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });

  const reg = makeRegistry({ probeThrowsFor: [T_UNREGISTERED] });
  const out = await runRegistrationSweep(reg.client);

  // ⛔ MUTATION TARGET: make `isTenantRegistered` swallow its errors and return `false`, or wrap this
  // loop's probe in a `catch { return false }`. A licences outage would then make the sweep re-PUT
  // the whole fleet every five minutes against a service that is already failing, and re-assert the
  // BYO posture over every deliberate `byo_required` while doing it.
  expect(out.failed).toBe(1);
  expect(reg.calls.registered).toEqual([]);
  expect(reg.calls.byoSet).toEqual([]);
});

test('⛔ an OFFBOARDED tenant is never re-registered — the sweep must not resurrect it centrally', async () => {
  await seedTenant({
    id: T_UNREG_OFFBOARDED,
    slug: 'ob-unreg-offboarded',
    status: 'suspended',
    offboarded_at: new Date(),
  });
  // Non-vacuity anchor: an identical tenant that is merely ACTIVE IS registered by the same run, so
  // this cannot pass because the sweep does nothing at all.
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });

  const reg = makeRegistry();
  await runRegistrationSweep(reg.client);

  // ⚠️ MUTATION TARGET: drop `isNull(tenants.offboarded_at)` (or `eq(status,'active')`) from the
  // selection and the offboard route's central ARCHIVE is undone by the reconciler on the next tick
  // — the workspace would flip back to a live registry tenant every five minutes forever.
  expect(reg.calls.probed).not.toContain(T_UNREG_OFFBOARDED);
  expect(reg.calls.registered.map((c) => c.tenantId)).toEqual([T_UNREGISTERED]);
});

test('with NO licences service configured the sweep is a clean no-op, not a fleet of failures', async () => {
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });
  const reg = makeRegistry();
  __setLicensesAdminForTests(reg.client);
  try {
    // config.license.adminBaseUrl / sa.tokenUrl are empty in dev, CI and `bun test` — untouched here
    // deliberately, so this measures the real default rather than a state the test invented.
    const out = await __seatSweepsForTests.repairUnregisteredTenants();
    // ⚠️ MUTATION TARGET: drop the `licencesAdminConfigured()` guard and every tick of every
    // dev/CI/test process probes the whole tenant table against a relative URL `fetch` rejects —
    // `failed` would equal the fleet size and the tick log would fire every five minutes forever.
    expect(out).toEqual({ checked: 0, registered: 0, failed: 0, nameConflicts: 0 });
    expect(reg.calls.probed).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
});

test('a tenant with central_link set is never probed; a probed-registered one gets stamped', async () => {
  await seedTenant({ id: T_LINKED, slug: 'ob-linked', central_link: 'adopted' });
  await seedTenant({ id: T_REGISTERED, slug: 'ob-registered' });
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });

  const reg = makeRegistry({ known: [T_REGISTERED] });
  await runRegistrationSweep(reg.client);

  expect(reg.calls.probed).not.toContain(T_LINKED);
  const rows = await db
    .select({ id: tenants.id, link: tenants.central_link })
    .from(tenants)
    .where(inArray(tenants.id, [T_LINKED, T_REGISTERED, T_UNREGISTERED]));
  const link = new Map(rows.map((r) => [r.id, r.link]));
  expect(link.get(T_LINKED)).toBe('adopted'); // untouched
  expect(link.get(T_REGISTERED)).toBe('registered'); // found registered → stamped
  expect(link.get(T_UNREGISTERED)).toBe('registered'); // registered by the sweep → stamped

  // Stamped rows drop out of the next sweep entirely.
  const again = makeRegistry({ known: [T_REGISTERED, T_UNREGISTERED] });
  await runRegistrationSweep(again.client);
  expect(again.calls.probed).not.toContain(T_REGISTERED);
  expect(again.calls.probed).not.toContain(T_UNREGISTERED);
});

test('a licences NAME CONFLICT is counted as a conflict, not a failure, and the row stays unlinked', async () => {
  await seedTenant({ id: T_NAME_CONFLICT, slug: 'ob-name-conflict' });

  const reg = makeRegistry({ nameConflictFor: [T_NAME_CONFLICT] });
  const out = await runRegistrationSweep(reg.client);
  expect(out.nameConflicts).toBeGreaterThanOrEqual(1);
  expect(out.failed).toBe(0);
  expect(reg.calls.byoSet.map((c) => c.tenantId)).not.toContain(T_NAME_CONFLICT);

  const [row] = await db
    .select({ link: tenants.central_link })
    .from(tenants)
    .where(eq(tenants.id, T_NAME_CONFLICT));
  expect(row?.link).toBeNull();
});

// ⛔ HUNT (A2 review): a tenant registered under a name OTHER than its slug — a pre-050 `<slug>-cp`
// registration — is found "registered" by the sweep and must be stamped with the name the registry
// HOLDS. Stamping the slug would make every later mint PUT (id, slug), which licences answers with
// the existing row unchanged at best and a name clash at worst.
test('a tenant already registered under `<slug>-cp` (pre-050) is stamped with THAT name, not its slug', async () => {
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });
  const names = new Map<string, string>([[T_UNREGISTERED, 'ob-unregistered-cp']]); // registry: id → name
  const registered: string[] = [];
  const client = {
    async ensureTenantRegistered(tenantId: string) {
      registered.push(tenantId);
    },
    async isTenantRegistered(tenantId: string) {
      if (!TENANT_IDS.includes(tenantId)) return true;
      return names.has(tenantId);
    },
    async getTenant(nameOrId: string) {
      const name = names.get(nameOrId);
      return name ? { id: nameOrId, name } : null;
    },
    async setTenantByoMode() {},
  } as unknown as LicensesAdminClient;

  await runRegistrationSweep(client);
  expect(registered).not.toContain(T_UNREGISTERED);
  const [row] = await db
    .select({ link: tenants.central_link, licencesName: tenants.licences_name })
    .from(tenants)
    .where(eq(tenants.id, T_UNREGISTERED));
  expect(row?.link).toBe('registered');
  expect(row?.licencesName).toBe('ob-unregistered-cp');
});

test('the sweep registers the PLAIN slug — one attempt, no `-cp` suffix', async () => {
  await seedTenant({ id: T_UNREGISTERED, slug: 'ob-unregistered' });
  const reg = makeRegistry();
  await runRegistrationSweep(reg.client);
  expect(reg.calls.registered.filter((c) => c.tenantId === T_UNREGISTERED)).toEqual([
    { tenantId: T_UNREGISTERED, name: 'ob-unregistered' },
  ]);
});

test('an id licences says is owned by ANOTHER app is a FAILURE (not a name conflict), never suffixed, row stays unlinked', async () => {
  await seedTenant({ id: T_NAME_CONFLICT, slug: 'ob-name-conflict' });
  const reg = makeRegistry({ foreignIdFor: [T_NAME_CONFLICT] });
  const out = await runRegistrationSweep(reg.client);
  expect(out.failed).toBeGreaterThanOrEqual(1);
  expect(out.nameConflicts).toBe(0);
  expect(reg.calls.byoSet.map((c) => c.tenantId)).not.toContain(T_NAME_CONFLICT);
  const [row] = await db
    .select({ link: tenants.central_link })
    .from(tenants)
    .where(eq(tenants.id, T_NAME_CONFLICT));
  expect(row?.link).toBeNull();
});
