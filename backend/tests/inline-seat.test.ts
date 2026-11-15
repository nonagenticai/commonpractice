// tests/inline-seat.test.ts — the per-member gate and the LLM broker SEAT an unseated member inline
// (services/inline-seat.ts) instead of locking them out until the next `repairUnseatedMembers` tick.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  tenants,
  users,
  memberEntitlements,
  usageCounters,
  usageEvents,
  runAsSystem,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID, config } from '../src/config';
import { assertTenantLicensed, licenseCallerTenant } from '../src/middleware/license-gate';
import { __setLicenseClientForTests, type LicenseClient } from '../src/services/license-client';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import { __resetInlineSeatForTests, seatMemberInline } from '../src/services/inline-seat';
import { brokerLlmCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import { HttpError } from '../src/utils/http';
import type { User } from '../src/types';

const T = '00000000-0000-4000-8000-0000005ea701';
const U = '00000000-0000-4000-8000-0000005ea7a1';
const U_NOSUB = '00000000-0000-4000-8000-0000005ea7a2';
const U_BROKER = '00000000-0000-4000-8000-0000005ea7a3';
const U_GONE = '00000000-0000-4000-8000-0000005ea7a4';
const U_OP = '00000000-0000-4000-8000-0000005ea7a5';
const LIC = '00000000-0000-4000-8000-0000005ea7c1';
const SUBJ = '11111111-1111-4111-8111-0000005ea7c1';
const ALL_USERS = [U, U_NOSUB, U_BROKER, U_GONE, U_OP];

type Flags = { enforceGate2: boolean; perMemberGate: boolean; issuanceEnabled: boolean };
const flags = config.license as unknown as Flags;
const was: Flags = { ...flags };

/** A licences admin fake that mints for the member; `refuse` models licences refusing the mint
 *  (e.g. its own seat cap). `mints` counts createLicense calls — the stampede assertion. */
function makeAdmin(opts: { refuse?: boolean; delayMs?: number } = {}) {
  const calls = { mints: 0 };
  const client = {
    async ensureTenantRegistered() {},
    async createLicense() {
      calls.mints++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.refuse) throw new LicensesAdminError(409, 'seat cap reached upstream');
      return { licenseId: LIC, subjectId: SUBJ };
    },
    async createToken(licenseId: string) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  } as unknown as LicensesAdminClient;
  return { client, calls };
}

/** Introspect: the minted member token is valid and bound to SUBJ in tenant `tenantId`. */
function introspectFor(tenantId: string): LicenseClient {
  return {
    async introspect(token: string) {
      if (token !== `token-${LIC}`) throw new Error(`unknown token ${token}`);
      return {
        active: true,
        tenant_id: tenantId,
        app: { key: config.license.appKey },
        status: 'active',
        expires_at: '2999-01-01T00:00:00Z',
        subject_id: SUBJ,
      };
    },
  };
}

async function gate(userId: string): Promise<string | 200> {
  try {
    await assertTenantLicensed(new Request('http://t/api/flows'), T, { userId });
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
}

const seatStatus = async (userId: string) =>
  (await db.select({ s: memberEntitlements.status }).from(memberEntitlements).where(eq(memberEntitlements.user_id, userId))).map(
    (r) => r.s,
  );

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(memberEntitlements).where(inArray(memberEntitlements.user_id, ALL_USERS));
    await db.delete(usageEvents).where(inArray(usageEvents.user_id, ALL_USERS));
    await db.delete(usageCounters).where(inArray(usageCounters.user_id, ALL_USERS));
    await db.delete(users).where(inArray(users.id, ALL_USERS));
    await db.delete(tenants).where(eq(tenants.id, T));
  });
}

beforeEach(async () => {
  await cleanup();
  __resetInlineSeatForTests();
  __setBrokerDepsForTests(undefined);
  await db.insert(tenants).values({ id: T, name: 'Inline Seat Co', slug: 'inline-seat-test' });
  await db.insert(users).values([
    { id: U, email: 'u@inline-seat.test', name: 'U', tenant_id: T, keycloak_sub: U },
    // Never authenticated: no proven realm subject → never minted (the sweep's rule).
    { id: U_NOSUB, email: 'nosub@inline-seat.test', name: 'N', tenant_id: T },
  ]);
  flags.enforceGate2 = true;
  flags.perMemberGate = true;
  flags.issuanceEnabled = true;
}, 30_000);

afterAll(async () => {
  Object.assign(flags, was);
  __setLicensesAdminForTests(undefined);
  __setLicenseClientForTests(undefined);
  __setBrokerDepsForTests(undefined);
  __resetInlineSeatForTests();
  await cleanup();
}, 30_000);

test('⭐ gate: an unseated member is SEATED INLINE and admitted — no wait for the sweep', async () => {
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // ⛔ MUTATION TARGET: drop the `seatMemberInline` call in license-gate.ts and this is
  // `license_seat_required` — the member locked out until the next 5-minute sweep tick.
  expect(await gate(U)).toBe(200);
  expect(admin.calls.mints).toBe(1);
  expect(await seatStatus(U)).toEqual(['active']);
  // Seated now: the next request goes straight through on the stored token, minting nothing.
  expect(await gate(U)).toBe(200);
  expect(admin.calls.mints).toBe(1);
}, 30_000);

test('gate: issuance OFF → 402 license_seat_required, nothing minted', async () => {
  flags.issuanceEnabled = false;
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  expect(await gate(U)).toBe('license_seat_required');
  expect(admin.calls.mints).toBe(0);
  expect(await seatStatus(U)).toEqual([]);
}, 30_000);

test('gate: licences REFUSES the mint (seat cap) → 402, and the refusal is negative-cached', async () => {
  const admin = makeAdmin({ refuse: true });
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  expect(await gate(U)).toBe('license_seat_required');
  expect(admin.calls.mints).toBe(1);
  // ⚠️ MUTATION TARGET: drop the negative cache and every retry of a refused member is another
  // licences round trip.
  expect(await gate(U)).toBe('license_seat_required');
  expect(admin.calls.mints).toBe(1);
}, 30_000);

test('gate: a member with no recorded keycloak_sub is never minted for (unproven subject)', async () => {
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  expect(await gate(U_NOSUB)).toBe('license_seat_required');
  expect(admin.calls.mints).toBe(0);
}, 30_000);

test('gate: CONCURRENT requests of one unseated member → exactly ONE mint, all admitted', async () => {
  const admin = makeAdmin({ delayMs: 50 });
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  const out = await Promise.all(Array.from({ length: 6 }, () => gate(U)));
  // ⛔ MUTATION TARGET: drop the single-flight map and the losers find the winner's `pending` claim
  // (held-by-another-caller) and are refused mid-mint — a stampede of 402s for a member being seated.
  expect(out).toEqual([200, 200, 200, 200, 200, 200]);
  expect(admin.calls.mints).toBe(1);
}, 30_000);

test('broker: an unseated member is seated inline and the LLM call proceeds', async () => {
  await runAsSystem('boot-seed', () =>
    db
      .insert(users)
      .values({ id: U_BROKER, email: 'b@inline-seat.test', name: 'B', tenant_id: DEMO_TENANT_ID, keycloak_sub: U_BROKER }),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  let providerCalls = 0;
  __setBrokerDepsForTests({
    provider: async (req) => {
      providerCalls++;
      return { text: `echo:${req.prompt}`, tokensIn: 1, tokensOut: 1 };
    },
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  // ⛔ MUTATION TARGET: drop the seat-and-retry in `reserveCall` and this is `seat_required`.
  const out = await withTenantDb(DEMO_TENANT_ID, () => brokerLlmCall(U_BROKER, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(true);
  expect(providerCalls).toBe(1);
  expect(admin.calls.mints).toBe(1);

  // …and with issuance off a seatless member is still refused before the provider is called.
  __resetInlineSeatForTests();
  await runAsSystem('boot-seed', () => db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, U_BROKER)));
  flags.issuanceEnabled = false;
  const refused = await withTenantDb(DEMO_TENANT_ID, () => brokerLlmCall(U_BROKER, { model: 'm', prompt: 'x' }));
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.kind).toBe('seat_required');
  expect(providerCalls).toBe(1);
}, 30_000);

// ── Eligibility edge cases. Each one is the sweep's predicate term that, dropped, would mint a
// licence (and a billed licences `human_subjects` seat) for someone who must never hold one.

test('deleted member: never seated inline — gate 402, nothing minted', async () => {
  await runAsSystem('boot-seed', () =>
    db.insert(users).values({
      id: U_GONE,
      email: 'gone@inline-seat.test',
      name: 'G',
      tenant_id: T,
      keycloak_sub: U_GONE,
      deleted_at: new Date(),
    }),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // ⛔ MUTATION TARGET: drop `isNull(users.deleted_at)` in inline-seat.ts and a soft-deleted
  // member with a still-valid session is re-seated (and re-billed) on their next request.
  expect(await seatMemberInline(T, U_GONE)).toBe(false);
  expect(await gate(U_GONE)).toBe('license_seat_required');
  expect(admin.calls.mints).toBe(0);
  expect(await seatStatus(U_GONE)).toEqual([]);
}, 30_000);

test('offboarded tenant: never seated inline — offboarded_at alone refuses, even with status active', async () => {
  // Offboarding stamps `offboarded_at` and suspends. Leave status `active` so the ONLY term that
  // can refuse is the `offboarded_at IS NULL` one — with status also flipped, the `status` term
  // would mask its removal.
  await runAsSystem('boot-seed', () =>
    db.update(tenants).set({ offboarded_at: new Date() }).where(eq(tenants.id, T)),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // ⛔ MUTATION TARGET: drop `isNull(tenants.offboarded_at)` and an offboarded tenant's member
  // gets a fresh licence minted AFTER offboarding revoked them all (commonpractice#441).
  expect(await seatMemberInline(T, U)).toBe(false);
  expect(admin.calls.mints).toBe(0);

  // …and the real offboarded shape (suspended too) through the gate: refused, nothing minted.
  __resetInlineSeatForTests();
  await runAsSystem('boot-seed', () =>
    db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T)),
  );
  expect(await gate(U)).not.toBe(200);
  expect(admin.calls.mints).toBe(0);
  expect(await seatStatus(U)).toEqual([]);
}, 30_000);

test('suspended (not offboarded) tenant: never seated inline', async () => {
  await runAsSystem('boot-seed', () =>
    db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, T)),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // ⛔ MUTATION TARGET: drop `eq(tenants.status, 'active')`.
  expect(await seatMemberInline(T, U)).toBe(false);
  expect(admin.calls.mints).toBe(0);
}, 30_000);

/** A super_admin whose HOME tenant is the demo tenant (as in prod), not T. */
const operator: User = {
  id: U_OP,
  email: 'op@inline-seat.test',
  name: 'Operator',
  roles: ['super_admin'],
  tenantId: DEMO_TENANT_ID,
};

async function callerGate(user: User, actingInto?: string): Promise<string | 200> {
  const headers = actingInto ? { 'X-Active-Tenant-Id': actingInto } : undefined;
  try {
    await licenseCallerTenant(new Request('http://t/api/flows', { headers }), user);
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.code;
    throw e;
  }
}

test('super_admin scope-switched INTO another tenant: never seated there (not that customer\'s seat)', async () => {
  await runAsSystem('boot-seed', () =>
    db.insert(users).values({
      id: U_OP,
      email: operator.email,
      name: operator.name,
      tenant_id: DEMO_TENANT_ID,
      keycloak_sub: U_OP,
    }),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // T holds no tenant-level licence, so the operator is refused on the TENANT path — but never with
  // the per-member `license_seat_required`, and never by minting them a seat in T.
  // ⛔ MUTATION TARGET: make licenseCallerTenant pass `member` for a scope-switched caller and this
  // is `license_seat_required` — the operator judged as one of T's seats. (Only the tenant-scope term
  // in inline-seat.ts then stops a mint — platform staff on the customer's invoice — which the
  // direct call below pins on its own.)
  const verdict = await callerGate(operator, T);
  expect(verdict).not.toBe(200);
  expect(verdict).not.toBe('license_seat_required');
  expect(admin.calls.mints).toBe(0);
  // Defence in depth: even called directly, seating is scoped to the member's OWN tenant.
  expect(await seatMemberInline(T, U_OP)).toBe(false);
  expect(admin.calls.mints).toBe(0);
  expect(await seatStatus(U_OP)).toEqual([]);
}, 30_000);

test('positive control: a super_admin in their OWN home tenant IS seated inline (no super_admin skip)', async () => {
  await runAsSystem('boot-seed', () =>
    db.insert(users).values({ id: U_OP, email: operator.email, name: operator.name, tenant_id: T, keycloak_sub: U_OP }),
  );
  const admin = makeAdmin();
  __setLicensesAdminForTests(admin.client);
  __setLicenseClientForTests(introspectFor(T));
  // Proves the refusal above is the SCOPE SWITCH, not "super_admins are never seated" — the same
  // role, unswitched, in its own tenant, is seated and admitted.
  expect(await callerGate({ ...operator, tenantId: T })).toBe(200);
  expect(admin.calls.mints).toBe(1);
  expect(await seatStatus(U_OP)).toEqual(['active']);
}, 30_000);
