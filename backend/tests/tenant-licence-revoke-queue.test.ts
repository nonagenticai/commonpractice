// tests/tenant-licence-revoke-queue.test.ts — prod-shaped deploy simulation of the A2 re-home, and
// the tenant-licence revoke-pending SET (0097): a second failed revoke must not overwrite the first,
// the sweep never revokes the licence a tenant STORES (nor a live member's seat), and it runs under
// the per-tenant licence lease. Also: the nil-UUID system tenant is left alone. Built from the
// auditor's deploy-sim probe of 5120073.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db, tenants, users, memberEntitlements, auditLog } from '../src/db/client';
import { config, DEMO_TENANT_ID } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  type LicensesAdminClient,
  type LicenceTerms,
} from '../src/services/licenses-admin';
import { __setLicenseClientForTests, type LicenseClient } from '../src/services/license-client';
import { assertTenantLicensed } from '../src/middleware/license-gate';
import { __seatSweepsForTests } from '../src/host/onboarding-integrity';
import { rehomeTenantLicence, revokeTenantLicense, SYSTEM_TENANT_ID } from '../src/services/license-provisioning';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

const id = (n: string) => `00000000-0000-4000-8000-0000ad17${n.padStart(4, '0')}`;
const T0 = id('1000'), T1 = id('1001'), T3 = id('1003'), T99 = id('1099'), TN = id('10a1'), TR = id('10a2');
const S1 = id('2001'), S2 = id('2002');
const ACTIVE = [T0, T1, T3, T99, TN, TR];
const SUSP = [S1, S2];
const ALL = [...ACTIVE, ...SUSP];
const FR = id('3001'), P99 = id('3002'), M1 = id('3003'), M3 = id('3004'), SA1 = 'sa-secure-apps-1', SA2 = 'sa-secure-apps-2', SP = id('3005');
const USERS = [FR, P99, M1, M3, SP];
const subjMap = new Map<string, string>();
const su = (sub: string) => {
  if (!subjMap.has(sub)) subjMap.set(sub, `11111111-0000-4000-8000-${(subjMap.size + 1).toString(16).padStart(12, '0')}`);
  return subjMap.get(sub)!;
};

const router = new Router();
registerAdminRoutes(router);
async function call(method: string, path: string, body?: unknown) {
  const m = router.match(method, path.split('?')[0]!)!; // the router matches the path, not the query
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...m.params,
  );
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; enforceGate2: boolean; sa: { tokenUrl: string } };
const lic = config.license as unknown as LicenceCfg;
const was = { ...lic, sa: { ...lic.sa } };

interface L {
  id: string;
  sub: string;
  tenant: string;
  planCode: string;
  startsAt: Date | null;
  expiresAt: Date | null;
  revoked: boolean;
}
function makeFake() {
  let n = 0;
  const ls: L[] = [];
  const add = (lid: string, sub: string, tenant: string) =>
    ls.push({ id: lid, sub, tenant, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false });
  const failRevoke = new Set<string>();
  const holdRevoke = new Map<string, Promise<void>>();
  const calls: string[] = [];
  const ms = (d: Date | null | undefined) => d?.getTime() ?? null;
  const same = (l: L, t: LicenceTerms) =>
    l.planCode === t.planCode &&
    ms(l.expiresAt) === ms(t.expiresAt ?? null) &&
    (t.startsAt ? ms(l.startsAt) === ms(t.startsAt) : true);
  const view = (l: L) => ({
    active: true,
    tenant_id: l.tenant,
    license_id: l.id,
    subject_id: su(l.sub),
    app: { key: config.license.appKey },
    plan: { code: l.planCode },
    expires_at: l.expiresAt?.toISOString() ?? null,
  });
  const client = {
    async ensureTenantRegistered() {},
    async isTenantRegistered() {
      return true;
    },
    async createLicense(sub: string, tenantId: string, terms?: LicenceTerms) {
      const t = terms ?? { planCode: 'standard' };
      const a = ls.find((l) => l.sub === sub && l.tenant === tenantId && !l.revoked);
      if (a) {
        calls.push(`return:${a.id}`);
        return { licenseId: a.id, subjectId: su(sub), termsMatch: same(a, t) };
      }
      const lid = id(`f${(++n).toString(16).padStart(3, '0')}`);
      ls.push({ id: lid, sub, tenant: tenantId, planCode: t.planCode, startsAt: t.startsAt ?? null, expiresAt: t.expiresAt ?? null, revoked: false });
      calls.push(`mint:${lid}`);
      return { licenseId: lid, subjectId: su(sub), termsMatch: true };
    },
    async createToken(licenseId: string) {
      return { token: `tok-${licenseId}` };
    },
    async revokeByToken() {
      calls.push('revokeByToken');
    },
    async revokeByLicenseId(lid: string) {
      if (failRevoke.has(lid)) throw new LicensesAdminError(503, 'down');
      const held = holdRevoke.get(lid);
      if (held) await held; // a revoke that HANGS (the pod could die here)
      calls.push(`revoke:${lid}`);
      const l = ls.find((x) => x.id === lid);
      if (l) l.revoked = true;
    },
    async listPlans() {
      return ['standard', 'pro'].map((code) => ({
        id: id('9' + code.length),
        code,
        name: code,
        description: null,
        durationDays: null,
        rateLimitRpm: null,
        rateLimitBurst: null,
        quotaMonthly: null,
        tokenBudgetMonthly: null,
        revoked: false,
        createdAt: null,
      }));
    },
    async getTenant() {
      return null;
    },
    async renameTenant() {},
    async setTenantByoMode() {},
    async getTenantByoMode() {
      return 'local_allowed';
    },
    async archiveTenant() {},
    async listSubjectLicences(sub: string) {
      return ls
        .filter((l) => l.sub === sub)
        .map((l) => ({ id: l.id, tenantId: l.tenant, status: l.revoked ? 'revoked' : 'active', appKey: config.license.appKey }));
    },
    async getActiveLicense(tenantId: string, sel?: { subjectId?: string }) {
      const live = ls.filter((x) => !x.revoked && x.tenant === tenantId);
      const mine = sel?.subjectId ? live.find((x) => x.sub === sel.subjectId) : undefined;
      const l = mine ?? live.at(-1);
      if (!l) return null;
      return { ...view(l), subject_match: sel?.subjectId ? Boolean(mine) : null, candidate_count: live.length };
    },
  } as unknown as LicensesAdminClient;
  const introspector = {
    async introspect(token: string) {
      const l = ls.find((x) => `tok-${x.id}` === token);
      if (!l || l.revoked) return { active: false, status: 'revoked' };
      return view(l);
    },
  } as unknown as LicenseClient;
  return { client, introspector, ls, add, failRevoke, holdRevoke, calls };
}

let f: ReturnType<typeof makeFake>;
const LID = {
  T0a: id('a000'),
  T0b: id('a001'),
  M1: id('a011'),
  M3: id('a013'),
  FR99: id('a099'),
  P99: id('a098'),
  FRN: id('a0a1'),
  FRR: id('a0a2'),
  S1: id('a201'),
  S2: id('a202'),
  SYS: id('a5a5'),
};
const ALL_PLUS_SYS = [...ALL, SYSTEM_TENANT_ID];

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.tenant_id, ALL));
  await db.delete(memberEntitlements).where(inArray(memberEntitlements.tenant_id, ALL));
  await db.delete(users).where(inArray(users.id, USERS));
  await db.delete(tenants).where(inArray(tenants.id, ALL));
  // the system tenant may exist in a seeded DB: only its licence columns are put back
  await db
    .update(tenants)
    .set({ license_token_encrypted: null, licence_id: null, licence_subject_sub: null, licence_revoke_pending: [] })
    .where(eq(tenants.id, SYSTEM_TENANT_ID));
}

beforeEach(async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => ({ id: id('3999'), email: 'sa@x', name: 'SA', roles: ['super_admin'], emailVerified: true }) as User,
  });
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  lic.enforceGate2 = false;
  await cleanup();
  f = makeFake();
  f.add(LID.T0a, SA1, T0);
  f.add(LID.T0b, SA2, T0);
  f.add(LID.M1, M1, T1);
  f.add(LID.M3, M3, T3);
  f.add(LID.FR99, FR, T99);
  f.add(LID.P99, P99, T99);
  f.add(LID.FRN, FR, TN);
  f.add(LID.FRR, FR, TR);
  f.add(LID.S1, SP, S1);
  f.add(LID.S2, FR, S2);
  const t = (tid: string, slug: string, tok: string, status: 'active' | 'suspended' = 'active') => ({
    id: tid,
    name: slug,
    slug,
    central_link: 'registered' as const,
    licences_name: slug,
    plan_code: 'standard',
    max_members: 10,
    status,
    license_token_encrypted: encryptSecret(`tok-${tok}`),
    licence_id: null,
    licence_subject_sub: null,
  });
  await db.insert(tenants).values([
    t(T0, 'ad17-zero', LID.T0a),
    t(T1, 'ad17-one', LID.M1),
    t(T3, 'ad17-three', LID.M3),
    t(T99, 'ad17-nn', LID.FR99),
    t(TN, 'ad17-nonagentic', LID.FRN),
    t(TR, 'ad17-rmt', LID.FRR),
    t(S1, 'ad17-s1', LID.S1, 'suspended'),
    t(S2, 'ad17-s2', LID.S2, 'suspended'),
  ]);
  await db.insert(users).values([
    { id: FR, email: 'fr@x', name: 'FR', tenant_id: T99, keycloak_sub: FR },
    { id: P99, email: 'p@x', name: 'P', tenant_id: T99, keycloak_sub: P99 },
    { id: M1, email: 'm1@x', name: 'M1', tenant_id: T1, keycloak_sub: M1 },
    { id: M3, email: 'm3@x', name: 'M3', tenant_id: T3, keycloak_sub: M3 },
  ]);
  await db.insert(memberEntitlements).values([
    { tenant_id: T1, user_id: M1, status: 'active', license_id: LID.M1, license_subject_id: su(M1), token_encrypted: encryptSecret(`tok-${LID.M1}`) },
    { tenant_id: T99, user_id: P99, status: 'active', license_id: LID.P99, license_subject_id: su(P99), token_encrypted: encryptSecret(`tok-${LID.P99}`) },
  ]);
  __setLicensesAdminForTests(f.client);
  __setLicenseClientForTests(f.introspector);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setLicenseClientForTests(undefined);
  Object.assign(lic, { ...was, sa: was.sa });
  await cleanup();
}, 30_000);

const S = __seatSweepsForTests;
async function tick() {
  await S.repairUnregisteredTenants();
  await S.rehomeLegacyTenantLicences();
  await S.retryPendingLicenceRevokes();
}
const rows = async () => db.select().from(tenants).where(inArray(tenants.id, ALL_PLUS_SYS));
const row = async (tid: string) => (await db.select().from(tenants).where(eq(tenants.id, tid)))[0]!;
async function gate(tid: string) {
  lic.enforceGate2 = true;
  try {
    await assertTenantLicensed(new Request('http://t/api/x'), tid);
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 'err';
  } finally {
    lic.enforceGate2 = false;
  }
}

test('DEPLOY SIM: 6 active tenants, tick x2 — every active tenant on ONE cp-tenant licence, suspended untouched', async () => {
  const snap = (rs: Awaited<ReturnType<typeof rows>>) =>
    JSON.stringify(rs.filter((r) => SUSP.includes(r.id)).map((r) => [r.id, r.license_token_encrypted, r.licence_id, r.licence_subject_sub, r.status]));
  const suspBefore = snap(await rows());
  await tick();
  const callsAfter1 = f.calls.length;
  await tick();
  expect(f.calls.length).toBe(callsAfter1); // the second tick is a no-op
  for (const tid of ACTIVE) {
    expect([tid, await gate(tid)]).toEqual([tid, 200]);
    const active = f.ls.filter((l) => l.tenant === tid && l.sub.startsWith(`cp-tenant:${tid}:`) && !l.revoked);
    expect([tid, active.length]).toEqual([tid, 1]);
  }
  const rev = (k: keyof typeof LID) => f.ls.find((l) => l.id === LID[k])!.revoked;
  expect([rev('FRN'), rev('FRR')]).toEqual([true, true]); // fr-test's licences in tenants it is no member of
  expect([rev('M1'), rev('M3'), rev('FR99'), rev('P99')]).toEqual([false, false, false, false]);
  const after = await rows();
  expect(after.filter((r) => r.licence_revoke_pending.length > 0)).toEqual([]);
  expect(snap(after)).toBe(suspBefore);
  expect([rev('S1'), rev('S2')]).toEqual([false, false]);
});

test('DEPLOY SIM: 3 replicas race the re-home concurrently', async () => {
  await Promise.all([S.rehomeLegacyTenantLicences(), S.rehomeLegacyTenantLicences(), S.rehomeLegacyTenantLicences()]);
  await tick();
  for (const tid of ACTIVE) {
    expect([tid, await gate(tid)]).toEqual([tid, 200]);
    expect([tid, f.ls.filter((l) => l.tenant === tid && l.sub.startsWith('cp-tenant:') && !l.revoked).length]).toEqual([tid, 1]);
  }
  expect((await rows()).filter((r) => r.licence_revoke_pending.length > 0)).toEqual([]);
});

test('⛔ PROBE A: a second failed revoke APPENDS — the first old licence is still revoked once licences recovers', async () => {
  f.failRevoke.add(LID.FRN);
  await S.rehomeLegacyTenantLicences();
  expect((await row(TN)).licence_revoke_pending).toEqual([LID.FRN]);
  const cpA = (await row(TN)).licence_id!;
  f.failRevoke.add(cpA);
  expect((await call('PATCH', `/api/tenants/${TN}`, { planCode: 'pro' })).status).toBe(200);
  expect([...(await row(TN)).licence_revoke_pending].sort()).toEqual([LID.FRN, cpA].sort());
  f.failRevoke.clear();
  await S.retryPendingLicenceRevokes();
  expect(f.ls.find((l) => l.id === LID.FRN)!.revoked).toBe(true);
  expect(f.ls.find((l) => l.id === cpA)!.revoked).toBe(true);
  expect((await row(TN)).licence_revoke_pending).toEqual([]);
  expect(await gate(TN)).toBe(200);
});

test('⛔ PROBE B: change A→B with a failed old revoke, then back to A — the queued licence is STORED again and never revoked', async () => {
  await S.rehomeLegacyTenantLicences(); // TN on cp-tenant:a (X), standard
  const X = (await row(TN)).licence_id!;
  f.failRevoke.add(X);
  expect((await call('PATCH', `/api/tenants/${TN}`, { planCode: 'pro' })).status).toBe(200);
  expect((await row(TN)).licence_revoke_pending).toEqual([X]);
  f.failRevoke.clear();
  expect((await call('PATCH', `/api/tenants/${TN}`, { planCode: 'standard' })).status).toBe(200);
  const r = await row(TN);
  // licences handed X back (still active, terms match): X is the stored licence — and left the set
  // in the same CAS that stored it.
  expect(r.licence_id).toBe(X);
  expect(r.licence_revoke_pending).not.toContain(X);
  await S.retryPendingLicenceRevokes();
  await tick();
  await tick();
  expect(f.ls.find((l) => l.id === X)!.revoked).toBe(false);
  expect(await gate(TN)).toBe(200);
});

test('the sweep DROPS (never revokes) a queued id that is the stored tenant licence or a live member\'s seat', async () => {
  await S.rehomeLegacyTenantLicences();
  const stored = (await row(T1)).licence_id!;
  // inject: the stored licence and M1's seat, as a buggy writer might have left them
  await db.update(tenants).set({ licence_revoke_pending: [stored, LID.M1] }).where(eq(tenants.id, T1));
  const out = await S.retryPendingLicenceRevokes();
  expect(out).toMatchObject({ revoked: 0, dropped: 2, failed: 0 });
  expect(f.ls.find((l) => l.id === stored)!.revoked).toBe(false);
  expect(f.ls.find((l) => l.id === LID.M1)!.revoked).toBe(false);
  expect((await row(T1)).licence_revoke_pending).toEqual([]);
});

test('⛔ the sweep honours the per-tenant licence lease: a held lease → skipped, nothing revoked', async () => {
  f.failRevoke.add(LID.FRN);
  await S.rehomeLegacyTenantLicences();
  f.failRevoke.clear();
  expect((await row(TN)).licence_revoke_pending).toEqual([LID.FRN]);
  await db
    .update(tenants)
    .set({ licence_op_id: id('beef'), licence_op_until: new Date(Date.now() + 60_000) })
    .where(eq(tenants.id, TN));
  expect(await S.retryPendingLicenceRevokes()).toMatchObject({ revoked: 0, busy: 1 });
  expect(f.ls.find((l) => l.id === LID.FRN)!.revoked).toBe(false);
  await db.update(tenants).set({ licence_op_id: null, licence_op_until: null }).where(eq(tenants.id, TN));
  expect(await S.retryPendingLicenceRevokes()).toMatchObject({ revoked: 1, busy: 0 });
});

test('⛔ the nil-UUID SYSTEM tenant is left alone: no re-home, no revoke, editor refuses with 409 system_tenant', async () => {
  await db
    .insert(tenants)
    .values({ id: SYSTEM_TENANT_ID, name: 'Dev User', slug: `u-${SYSTEM_TENANT_ID.replace(/-/g, '')}` })
    .onConflictDoNothing();
  f.add(LID.SYS, SA1, SYSTEM_TENANT_ID);
  await db
    .update(tenants)
    .set({ status: 'active', offboarded_at: null, license_token_encrypted: encryptSecret(`tok-${LID.SYS}`) })
    .where(eq(tenants.id, SYSTEM_TENANT_ID));

  await S.rehomeLegacyTenantLicences();
  expect(await rehomeTenantLicence(SYSTEM_TENANT_ID)).toBe('skipped');
  await revokeTenantLicense(SYSTEM_TENANT_ID);
  expect(f.ls.find((l) => l.id === LID.SYS)!.revoked).toBe(false);
  expect(f.calls.filter((c) => c.includes(LID.SYS))).toEqual([]);
  expect((await row(SYSTEM_TENANT_ID)).licence_subject_sub).toBeNull();

  const res = await call('PATCH', `/api/tenants/${SYSTEM_TENANT_ID}`, { planCode: 'pro' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('system_tenant');
});

test('⛔ the CHANGE path queues the old licence INSIDE the swap: a revoke that hangs after the swap still leaves it pending', async () => {
  await S.rehomeLegacyTenantLicences(); // TN on cp-tenant:a (X)
  const X = (await row(TN)).licence_id!;
  let release!: () => void;
  f.holdRevoke.set(X, new Promise<void>((r) => (release = r)));
  const change = call('PATCH', `/api/tenants/${TN}`, { planCode: 'pro' });
  // wait for the swap to land (the request is now parked inside the old-licence revoke)
  for (let i = 0; i < 100 && (await row(TN)).licence_id === X; i++) await Bun.sleep(10);
  const swapped = await row(TN);
  expect(swapped.licence_id).not.toBe(X);
  // ⛔ the pod could die right here: X must already be queued
  expect(swapped.licence_revoke_pending).toContain(X);
  release();
  expect((await change).status).toBe(200);
  // a confirmed revoke takes it out again
  expect(f.ls.find((l) => l.id === X)!.revoked).toBe(true);
  expect((await row(TN)).licence_revoke_pending).not.toContain(X);
});

test('⛔ offboarding the SYSTEM tenant is refused (409 system_tenant) before any write', async () => {
  await db
    .insert(tenants)
    .values({ id: SYSTEM_TENANT_ID, name: 'Dev User', slug: `u-${SYSTEM_TENANT_ID.replace(/-/g, '')}` })
    .onConflictDoNothing();
  await db.update(tenants).set({ status: 'active', offboarded_at: null }).where(eq(tenants.id, SYSTEM_TENANT_ID));
  const before = await row(SYSTEM_TENANT_ID);
  const res = await call('POST', `/api/tenants/${SYSTEM_TENANT_ID}/offboard`, { confirmSlug: before.slug });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('system_tenant');
  const after = await row(SYSTEM_TENANT_ID);
  expect(after.offboarded_at).toBeNull();
  expect(after.status).toBe(before.status);
  expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
});

test('⛔ offboarding the DEMO tenant is refused (409 demo_tenant) before any write', async () => {
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: 'Common Practice Demo', slug: 'common-practice-demo' })
    .onConflictDoNothing();
  await db.update(tenants).set({ status: 'active', offboarded_at: null }).where(eq(tenants.id, DEMO_TENANT_ID));
  const before = await row(DEMO_TENANT_ID);
  const res = await call('POST', `/api/tenants/${DEMO_TENANT_ID}/offboard`, { confirmSlug: before.slug });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('demo_tenant');
  const after = await row(DEMO_TENANT_ID);
  expect(after.offboarded_at).toBeNull();
  expect(after.status).toBe(before.status);
  expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
});

test('the tenant list and licence read FLAG the system tenant, and `?id=` narrows the list to one row', async () => {
  // The platform screen used to render the system tenant as an editable, "Licensed" customer
  // workspace while PATCH/offboard refuse it (409 system_tenant). The flag is how it can tell.
  await db
    .insert(tenants)
    .values({ id: SYSTEM_TENANT_ID, name: 'Dev User', slug: `u-${SYSTEM_TENANT_ID.replace(/-/g, '')}` })
    .onConflictDoNothing();
  type Row = { id: string; isSystemTenant: boolean };
  const sys = (await (await call('GET', `/api/admin/tenants?id=${SYSTEM_TENANT_ID}`)).json()) as {
    tenants: Row[];
    total: number;
  };
  expect(sys.tenants.map((t) => [t.id, t.isSystemTenant])).toEqual([[SYSTEM_TENANT_ID, true]]);
  expect(sys.total).toBe(1);

  const one = (await (await call('GET', `/api/admin/tenants?id=${TN}`)).json()) as { tenants: Row[] };
  expect(one.tenants.map((t) => [t.id, t.isSystemTenant])).toEqual([[TN, false]]);

  // A malformed id matches nothing — never the whole estate, never a 500 from a uuid cast.
  const bad = await call('GET', '/api/admin/tenants?id=not-a-uuid');
  expect(bad.status).toBe(200);
  expect(((await bad.json()) as { tenants: Row[] }).tenants).toEqual([]);

  const all = (await (await call('GET', '/api/admin/tenants?limit=1000')).json()) as { tenants: Row[] };
  expect(all.tenants.find((t) => t.id === SYSTEM_TENANT_ID)?.isSystemTenant).toBe(true);
  expect(all.tenants.find((t) => t.id === TN)?.isSystemTenant).toBe(false);

  const lic = await call('GET', `/api/tenants/${SYSTEM_TENANT_ID}/licence`);
  expect(lic.status).toBe(200);
  expect(((await lic.json()) as { isSystemTenant: boolean }).isSystemTenant).toBe(true);
  const licTn = await call('GET', `/api/tenants/${TN}/licence`);
  expect(((await licTn.json()) as { isSystemTenant: boolean }).isSystemTenant).toBe(false);
});

test('⛔ `?id=` accepts every id shape Postgres stores — the demo tenant …0001, the nil system id, v4 and v7', async () => {
  // zod 4's `.uuid()` is RFC-strict (version nibble 1-8, variant 8-b), so it refused the prod demo
  // tenant `00000000-0000-0000-0000-000000000001` (common-practice-demo): its page said "not found"
  // and its licence, budget and offboard became unreachable once the inline editor was gone.
  const V4 = '3f2b9c1e-8d4a-4b6e-9a1c-2e7f5d0b4c11';
  const V7 = '01928c3a-7b2e-7c4d-8e5f-6a7b8c9d0e1f';
  const ids = [DEMO_TENANT_ID, SYSTEM_TENANT_ID, V4, V7];
  for (const tid of ids) {
    await db
      .insert(tenants)
      .values({ id: tid, name: `shape ${tid}`, slug: `shape-${tid}` })
      .onConflictDoNothing();
  }
  try {
    for (const tid of ids) {
      const res = (await (await call('GET', `/api/admin/tenants?id=${tid}`)).json()) as {
        tenants: Array<{ id: string }>;
      };
      expect(res.tenants.map((t) => t.id), tid).toEqual([tid]);
    }
  } finally {
    await db.delete(tenants).where(inArray(tenants.id, [V4, V7]));
  }
});

test('⛔ a FORCED re-mint (POST /license?force=1) queues the replaced cp-tenant licence; the sweep revokes it — slot a→b and b→a', async () => {
  // Prod shape (Netcare 2026-10-13): the stored tenant licence is held by `cp-tenant:<id>:a|b`, with
  // `licence_id` + holder recorded. A force re-mint protects the stored one and lands on the OTHER
  // slot; before the fix the replaced licence was never queued → two active cp-tenant licences and an
  // empty revoke queue, forever.
  await S.rehomeLegacyTenantLicences(); // TN on cp-tenant:a
  for (let round = 0; round < 2; round++) {
    const before = await row(TN);
    const X = before.licence_id!;
    expect(before.licence_subject_sub).toMatch(new RegExp(`^cp-tenant:${TN}:(a|b)$`));
    f.failRevoke.add(X); // nothing in the request revokes it; only the queue can
    const res = await call('POST', `/api/tenants/${TN}/license?force=1`);
    expect(res.status).toBe(200);
    const after = await row(TN);
    expect(after.licence_id).not.toBe(X);
    expect(after.licence_subject_sub).not.toBe(before.licence_subject_sub); // alternated
    expect(after.licence_revoke_pending).toEqual([X]);
    f.failRevoke.clear();
    expect(await S.retryPendingLicenceRevokes()).toMatchObject({ revoked: 1, failed: 0 });
    expect(f.ls.find((l) => l.id === X)!.revoked).toBe(true);
    expect((await row(TN)).licence_revoke_pending).toEqual([]);
    const active = f.ls.filter((l) => l.tenant === TN && l.sub.startsWith(`cp-tenant:${TN}:`) && !l.revoked);
    expect(active.map((l) => l.id)).toEqual([after.licence_id!]);
    expect(await gate(TN)).toBe(200);
  }
});

test('⛔ the tenant.license_issue audit row is filed under the TARGET tenant, not the acting super_admin\'s', async () => {
  // rows a wrongly-attributed earlier run left behind (tenant_id NULL escapes `cleanup`)
  await db.delete(auditLog).where(and(eq(auditLog.action, 'tenant.license_issue'), eq(auditLog.target_id, TN)));
  await S.rehomeLegacyTenantLicences();
  expect((await call('POST', `/api/tenants/${TN}/license?force=1`)).status).toBe(200);
  const rowsForAction = await db
    .select({ tenantId: auditLog.tenant_id, targetId: auditLog.target_id })
    .from(auditLog)
    .where(eq(auditLog.action, 'tenant.license_issue'));
  const mine = rowsForAction.filter((r) => r.targetId === TN);
  expect(mine.length).toBe(1);
  expect(mine[0]!.tenantId).toBe(TN);
});
