// tests/tenant-licence-control.test.ts — A2 §3/§4: the super_admin licence editor.
//
// PATCH /api/tenants/:id with planCode / startsAt / expiresAt / byoMode / name / maxMembers, and
// GET /api/tenants/:id/licence. Live routes against the test postgres; the licences service is a
// STATEFUL fake that behaves like licences on the point that matters: at most ONE active licence
// per (tenant, app, subject), and `POST /licenses/user/{sub}` hands the existing one back — old
// plan and all — instead of minting (licences main.py `create_user_license`, "Idempotency").
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db, tenants, users, auditLog, memberEntitlements } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { config } from '../src/config';
import { encryptSecret, decryptSecret } from '../src/host/secret-box';
import {
  __setLicensesAdminForTests,
  LicencesNameConflictError,
  LicensesAdminError,
  type LicensesAdminClient,
  type LicenceTerms,
  type LicencesPlan,
  type ByoMode,
} from '../src/services/licenses-admin';
import { __setLicenseClientForTests, type LicenseClient } from '../src/services/license-client';
import {
  ensureTenantLicense,
  ensureMemberEntitlement,
  revokeMemberEntitlement,
  rehomeTenantLicence,
} from '../src/services/license-provisioning';
import { assertTenantLicensed } from '../src/middleware/license-gate';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { HttpError } from '../src/utils/http';
import { renderMetrics } from '../src/host/metrics';
import { __seatSweepsForTests, __resetRehomeNameConflictsForTests } from '../src/host/onboarding-integrity';
import type { User } from '../src/types';

// Own id range (marker `a2c1`), slug prefix `a2c-`.
const TENANT = '00000000-0000-4000-8000-0000a2c10001';
const ACTOR_ID = '00000000-0000-4000-8000-0000a2c10010';
const MEMBER_ID = '00000000-0000-4000-8000-0000a2c10011';
const MEMBER2_ID = '00000000-0000-4000-8000-0000a2c10012';
/** The sub the tenant's licence was originally bound to (an earlier super_admin). */
const OLD_SUB = '00000000-0000-4000-8000-0000a2c10013';
const OLD_LIC = '00000000-0000-4000-8000-0000a2c1aa01';
const MEM_LIC = '00000000-0000-4000-8000-0000a2c1aa02';
const USER_IDS = [ACTOR_ID, MEMBER_ID, MEMBER2_ID];

const actor: User = { id: ACTOR_ID, email: 'sa@a2c.test', name: 'SA', roles: ['super_admin'], emailVerified: true };

const router = new Router();
registerAdminRoutes(router);

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

type LicenceCfg = {
  adminBaseUrl: string;
  issuanceEnabled: boolean;
  enforceGate2: boolean;
  sa: { tokenUrl: string };
};
const lic = config.license as unknown as LicenceCfg;
const was = { ...lic, sa: { ...lic.sa } };

const plan = (code: string, revoked = false): LicencesPlan => ({
  id: `00000000-0000-4000-8000-0000a2c1b${code.length.toString(16).padStart(3, '0')}`,
  code,
  name: code,
  description: null,
  durationDays: null,
  rateLimitRpm: null,
  rateLimitBurst: null,
  quotaMonthly: null,
  tokenBudgetMonthly: null,
  revoked,
  createdAt: null,
});

interface FakeLicence {
  id: string;
  sub: string;
  planCode: string;
  startsAt: Date | null;
  expiresAt: Date | null;
  revoked: boolean;
  /** Defaults to TENANT. */
  tenant?: string;
}

/** licences' Subject UUID for a sub: ONE per sub (not per licence), as licences keys it. */
const subjectUuid = (sub: string) =>
  `00000000-0000-4000-8000-${Buffer.from(sub).toString('hex').slice(-12).padStart(12, '0')}`;

/**
 * licences, as far as these routes can tell — FAITHFUL on the points that bit:
 *   • ONE active licence per (tenant, app, subject): `createLicense` hands an existing one back,
 *     old terms and all;
 *   • `subject_id` is per SUBJECT;
 *   • `getActiveLicense` sees EVERY active licence (members' seats included — the first fake
 *     excluded member subjects, which hid the tenant-licence-is-a-seat defect), and `subject_match`
 *     is true only when the selector's subject holds one.
 */
function makeLicences(opts: { takenNames?: string[]; mintFails?: boolean; registerConflict?: boolean } = {}) {
  let n = 0;
  const licences: FakeLicence[] = [
    { id: OLD_LIC, sub: OLD_SUB, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false },
    { id: MEM_LIC, sub: MEMBER_ID, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false },
  ];
  const order: string[] = [];
  /** Switchable faults (mutate in a test). */
  const failures = { revokeIds: new Set<string>(), list: false, introspect: false };
  const renames: string[] = [];
  const byo: Array<{ tenantId: string; mode: ByoMode }> = [];
  const taken = new Set(opts.takenNames ?? []);
  const ms = (d: Date | null | undefined) => d?.getTime() ?? null;
  const sameTerms = (l: FakeLicence, t: LicenceTerms) =>
    l.planCode === t.planCode &&
    ms(l.expiresAt) === ms(t.expiresAt) &&
    (t.startsAt ? ms(l.startsAt) === ms(t.startsAt) : !l.startsAt || l.startsAt.getTime() <= Date.now());
  const view = (l: FakeLicence, tenantId: string) => ({
    active: true,
    tenant_id: tenantId,
    license_id: l.id,
    subject_id: subjectUuid(l.sub),
    app: { key: config.license.appKey } as never,
    plan: { code: l.planCode } as never,
    expires_at: l.expiresAt?.toISOString() ?? null,
  });
  const client: LicensesAdminClient & { getTenantByoMode(id: string): Promise<ByoMode> } = {
    async ensureTenantRegistered(_id, name) {
      order.push(`register:${name}`);
      if (opts.registerConflict) throw new LicencesNameConflictError(name);
    },
    async createLicense(sub, _tenantId, terms) {
      if (opts.mintFails) throw new LicensesAdminError(503, 'licences down');
      const t = terms ?? { planCode: 'standard' };
      const active = licences.find((l) => l.sub === sub && !l.revoked);
      if (active) {
        order.push(`return:${active.id}`);
        return { licenseId: active.id, subjectId: subjectUuid(sub), termsMatch: sameTerms(active, t) };
      }
      const id = `00000000-0000-4000-8000-0000a2c1c${(++n).toString(16).padStart(3, '0')}`;
      licences.push({
        id,
        sub,
        planCode: t.planCode,
        startsAt: t.startsAt ?? null,
        expiresAt: t.expiresAt ?? null,
        revoked: false,
      });
      order.push(`mint:${id}`);
      return { licenseId: id, subjectId: subjectUuid(sub), termsMatch: true };
    },
    async createToken(licenseId) {
      return { token: `tok-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId(id) {
      if (failures.revokeIds.has(id)) throw new LicensesAdminError(503, 'licences down (revoke)');
      order.push(`revoke:${id}`);
      const l = licences.find((x) => x.id === id);
      if (l) l.revoked = true;
    },
    async listPlans() {
      return [plan('standard'), plan('pro'), plan('legacy', true)];
    },
    async getTenant(name) {
      return taken.has(name) ? { id: '00000000-0000-4000-8000-0000a2c1ffff', name } : null;
    },
    async renameTenant(_id, name) {
      if (taken.has(name)) throw new LicencesNameConflictError(name);
      renames.push(name);
    },
    async setTenantByoMode(tenantId, mode) {
      byo.push({ tenantId, mode });
    },
    async getTenantByoMode() {
      return 'local_allowed';
    },
    async listSubjectLicences(sub) {
      if (failures.list) throw new LicensesAdminError(503, 'licences down (list)');
      return licences
        .filter((l) => l.sub === sub)
        .map((l) => ({ id: l.id, tenantId: l.tenant ?? TENANT, status: l.revoked ? 'revoked' : 'active', appKey: config.license.appKey }));
    },
    async archiveTenant() {},
    async getActiveLicense(tenantId, sel) {
      const live = licences.filter((x) => !x.revoked);
      const mine = sel?.subjectId ? live.find((x) => x.sub === sel.subjectId) : undefined;
      const l = mine ?? live.at(-1);
      if (!l) return null;
      return {
        ...view(l, tenantId),
        subject_match: sel?.subjectId ? Boolean(mine) : null,
        candidate_count: live.length,
      };
    },
  };
  /** Gate 2's introspect, answering from the same state. */
  const introspector: LicenseClient = {
    async introspect(token: string) {
      if (failures.introspect) throw new Error('introspect transport error');
      const l = licences.find((x) => `tok-${x.id}` === token);
      if (!l || l.revoked) return { active: false, status: 'revoked' };
      return view(l, TENANT);
    },
  } as unknown as LicenseClient;
  return { client, introspector, licences, order, renames, byo, failures };
}

async function cleanup() {
  await db.delete(auditLog).where(inArray(auditLog.actor_id, USER_IDS));
  await db.delete(auditLog).where(eq(auditLog.tenant_id, TENANT));
  await db.delete(tenantInvites).where(eq(tenantInvites.tenant_id, TENANT));
  await db.delete(memberEntitlements).where(eq(memberEntitlements.tenant_id, TENANT));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

let fake: ReturnType<typeof makeLicences>;

beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => actor });
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  await cleanup();
  await db.insert(tenants).values({
    id: TENANT,
    name: 'A2C Acme',
    slug: 'a2c-acme',
    central_link: 'registered',
    licences_name: 'a2c-acme',
    plan_code: 'standard',
    max_members: 10,
    license_token_encrypted: encryptSecret(`tok-${OLD_LIC}`),
    licence_id: OLD_LIC,
    licence_subject_sub: OLD_SUB,
  });
  await db.insert(users).values([
    { id: ACTOR_ID, email: actor.email, name: 'SA', tenant_id: null },
    {
      id: MEMBER_ID,
      email: 'm@a2c.test',
      name: 'M',
      tenant_id: TENANT,
      tenant_role: 'tenant_admin',
      keycloak_sub: MEMBER_ID,
    },
  ]);
  await db.insert(memberEntitlements).values({
    tenant_id: TENANT,
    user_id: MEMBER_ID,
    status: 'active',
    license_id: MEM_LIC,
    license_subject_id: MEM_LIC,
    token_encrypted: encryptSecret(`tok-${MEM_LIC}`),
  });
  fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setLicenseClientForTests(undefined);
  Object.assign(lic, { ...was, sa: was.sa });
  lic.sa.tokenUrl = was.sa.tokenUrl;
  await cleanup();
}, 30_000);

async function tenantRow() {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, TENANT));
  return row!;
}

/** The fake licence the tenant row's `licence_id` names. */
function tenantLicence(row: { licence_id: string | null }) {
  const l = fake.licences.find((x) => x.id === row.licence_id);
  if (!l) throw new Error(`tenant licence ${row.licence_id} unknown to the fake`);
  return l;
}

async function audits(action: string) {
  return db
    .select({ metadata: auditLog.metadata, tone: auditLog.result_tone })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.target_id, TENANT)));
}

// ---- Test 4: plan change ------------------------------------------------------------------------

test('A2 Test 4: plan change → NEW licence minted on the new plan BEFORE the old is revoked by id; token + licence_id swap; audited', async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    tenant: { planCode: string; licenceId: string };
    licence: { reminted: boolean; oldLicenceRevoked: boolean; before: { licenceId: string }; after: { licenceId: string } };
  };
  const minted = tenantLicence(await tenantRow());
  expect(minted.planCode).toBe('pro');
  // ⛔ The tenant licence is held by nobody who is a person.
  expect(USER_IDS).not.toContain(minted.sub);
  expect(minted.sub).not.toBe(OLD_SUB);

  // ⛔ ORDER: the new tenant licence exists before the old one is revoked — no 402 window.
  const mintAt = fake.order.indexOf(`mint:${minted.id}`);
  const revokeAt = fake.order.indexOf(`revoke:${OLD_LIC}`);
  expect(mintAt).toBeGreaterThanOrEqual(0);
  expect(revokeAt).toBeGreaterThan(mintAt);
  expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);

  const row = await tenantRow();
  expect(row.plan_code).toBe('pro');
  expect(row.licence_id).toBe(minted.id);
  expect(decryptSecret(row.license_token_encrypted!)).toBe(`tok-${minted.id}`);
  expect(body.tenant.planCode).toBe('pro');
  expect(body.licence.reminted).toBe(true);
  expect(body.licence.oldLicenceRevoked).toBe(true);

  const [a] = await audits('tenant.licence_change');
  const meta = a?.metadata as { before: { planCode: string; licenceId: string }; after: { planCode: string; licenceId: string } };
  expect(meta.before).toMatchObject({ planCode: 'standard', licenceId: OLD_LIC });
  expect(meta.after).toMatchObject({ planCode: 'pro', licenceId: minted.id });
});

test("A2 Test 4: the members' seats are re-issued on the NEW plan through the seat-repair path", async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { licence: { membersReissued: number; memberFailures: unknown[] } };
  expect(body.licence.membersReissued).toBe(1);
  expect(body.licence.memberFailures).toEqual([]);
  // licences returned the member's OLD-plan licence; it was revoked and a new one minted.
  expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(true);
  const memberLic = fake.licences.find((l) => l.sub === MEMBER_ID && !l.revoked)!;
  expect(memberLic.planCode).toBe('pro');
  const [ent] = await db
    .select()
    .from(memberEntitlements)
    .where(and(eq(memberEntitlements.user_id, MEMBER_ID), eq(memberEntitlements.status, 'active')));
  expect(ent?.license_id).toBe(memberLic.id);
});

test('consecutive changes alternate the tenant licence between two NON-person holders, always mint-before-revoke', async () => {
  const holders: string[] = [];
  for (const planCode of ['pro', 'standard', 'pro']) {
    const before = (await tenantRow()).licence_id!;
    fake.order.length = 0;
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode })).status).toBe(200);
    const now = tenantLicence(await tenantRow());
    holders.push(now.sub);
    expect(fake.order.indexOf(`mint:${now.id}`)).toBeLessThan(fake.order.indexOf(`revoke:${before}`));
  }
  expect(holders[0]).not.toBe(holders[1]);
  expect(holders[2]).toBe(holders[0]);
  for (const h of holders) expect(USER_IDS).not.toContain(h);
});

/** Seats of this tenant, as stored. */
async function seatLicences() {
  return db
    .select({ userId: memberEntitlements.user_id, licenceId: memberEntitlements.license_id, status: memberEntitlements.status })
    .from(memberEntitlements)
    .where(eq(memberEntitlements.tenant_id, TENANT));
}

test('⛔ REGRESSION (auditor probe): create → change → change → offboard the oldest member → the tenant stays licensed; its licence is never a seat', async () => {
  // A tenant as CREATE leaves it: licensed by ensureTenantLicense, no stored licence yet.
  await db
    .update(tenants)
    .set({ license_token_encrypted: null, licence_id: null, licence_subject_sub: null })
    .where(eq(tenants.id, TENANT));
  fake.licences.find((l) => l.id === OLD_LIC)!.revoked = true;
  await ensureTenantLicense(TENANT, ACTOR_ID);
  // A second member with their own seat (MEMBER, seeded first, is the OLDEST).
  await db.insert(users).values({
    id: MEMBER2_ID,
    email: 'm2@a2c.test',
    name: 'M2',
    tenant_id: TENANT,
    keycloak_sub: MEMBER2_ID,
    created_at: new Date(Date.now() + 60_000),
  });
  await ensureMemberEntitlement(TENANT, MEMBER2_ID, MEMBER2_ID);

  // After EVERY change: the tenant licence is NOT any member's seat licence, and no person holds it.
  for (const planCode of ['pro', 'standard']) {
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode })).status).toBe(200);
    const row = await tenantRow();
    const seats = await seatLicences();
    expect(seats.map((s) => s.licenceId)).not.toContain(row.licence_id);
    expect(USER_IDS).not.toContain(tenantLicence(row).sub);
  }

  // Offboard the oldest member: their seat is released.
  await revokeMemberEntitlement(TENANT, MEMBER_ID);

  // …and the WORKSPACE is still licensed (Gate 2 on the tenant token).
  expect(tenantLicence(await tenantRow()).revoked).toBe(false);
  lic.enforceGate2 = true;
  __setLicenseClientForTests(fake.introspector);
  try {
    await assertTenantLicensed(new Request('http://t/api/x'), TENANT);
  } finally {
    lic.enforceGate2 = was.enforceGate2;
    __setLicenseClientForTests(undefined);
  }
  // …and the remaining member's seat licence still works.
  const [m2] = (await seatLicences()).filter((s) => s.userId === MEMBER2_ID);
  expect(m2?.status).toBe('active');
  expect(fake.licences.find((l) => l.id === m2!.licenceId)?.revoked).toBe(false);
});

test('TRANSITION: a pre-A2 tenant licence that IS a member\'s seat is not revoked by the change — it stays the seat', async () => {
  // Pre-A2 shape: the tenant licence was minted for MEMBER, so licences returned MEMBER's seat.
  await db
    .update(tenants)
    .set({ license_token_encrypted: encryptSecret(`tok-${MEM_LIC}`), licence_id: MEM_LIC, licence_subject_sub: MEMBER_ID })
    .where(eq(tenants.id, TENANT));
  fake.licences.find((l) => l.id === OLD_LIC)!.revoked = true;
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { expiresAt: '2032-01-01T00:00:00Z' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { licence: { oldLicenceKeptAsSeat: boolean; oldLicenceRevoked: boolean | null } };
  expect(body.licence.oldLicenceKeptAsSeat).toBe(true);
  // The tenant step swapped to a non-person holder and did NOT revoke MEM_LIC itself: the only
  // revoke of MEM_LIC is the seat re-issue AFTER the swap (the member's seat moving to new terms).
  const row = await tenantRow();
  expect(row.licence_id).not.toBe(MEM_LIC);
  expect(USER_IDS).not.toContain(tenantLicence(row).sub);
  expect(fake.order.indexOf(`mint:${row.licence_id}`)).toBeLessThan(fake.order.indexOf(`revoke:${MEM_LIC}`));
  const [seat] = (await seatLicences()).filter((s) => s.userId === MEMBER_ID && s.status === 'active');
  expect(seat?.licenceId).not.toBe(row.licence_id);
});

// ---- validate-before-write (auditor probe) -------------------------------------------------------

test('⛔ PROBE: {name, maxMembers:7, expiresAt < stored start} → 422 and NOTHING changed (no rename, no seats, no audit)', async () => {
  await db
    .update(tenants)
    .set({ licence_starts_at: new Date('2031-01-01T00:00:00Z') })
    .where(eq(tenants.id, TENANT));
  const res = await call('PATCH', `/api/tenants/${TENANT}`, {
    name: 'A2C Probe',
    maxMembers: 7,
    expiresAt: '2030-01-01T00:00:00Z',
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: string }).error).toBe('licence_window_invalid');
  const row = await tenantRow();
  expect(row.name).toBe('A2C Acme');
  expect(row.licences_name).toBe('a2c-acme');
  expect(row.max_members).toBe(10);
  expect(fake.renames).toEqual([]);
  expect(fake.order).toEqual([]);
  const rows = await db.select().from(auditLog).where(eq(auditLog.target_id, TENANT));
  expect(rows).toEqual([]);
});

test('a licences outage on the licence step (502) leaves name and seats untouched', async () => {
  fake = makeLicences({ mintFails: true });
  __setLicensesAdminForTests(fake.client);
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { name: 'A2C Probe', maxMembers: 7, planCode: 'pro' });
  expect(res.status).toBe(502);
  const row = await tenantRow();
  expect(row.name).toBe('A2C Acme');
  expect(row.max_members).toBe(10);
  expect(row.plan_code).toBe('standard');
  expect(fake.renames).toEqual([]);
});

test('a rename never consults licences: a name CP holds there elsewhere does not block the PATCH', async () => {
  fake = makeLicences({ takenNames: ['a2c-renamed'] });
  __setLicensesAdminForTests(fake.client);
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { name: 'A2C Renamed', maxMembers: 7 });
  expect(res.status).toBe(200);
  const row = await tenantRow();
  expect(row.name).toBe('A2C Renamed');
  expect(row.max_members).toBe(7);
  expect(row.licences_name).toBe('a2c-acme');
  expect(fake.renames).toEqual([]);
});

test('an unknown or retired plan → 422, nothing minted', async () => {
  const a = await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'nope' });
  expect(a.status).toBe(422);
  expect(((await a.json()) as { error: string }).error).toBe('plan_unknown');
  const b = await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'legacy' });
  expect(((await b.json()) as { error: string }).error).toBe('plan_retired');
  expect(fake.order).toEqual([]);
});

// ---- Test 5: expiry -----------------------------------------------------------------------------

test('A2 Test 5: clearing the expiry re-issues with expires_at null', async () => {
  const exp = new Date('2030-01-01T00:00:00Z');
  await db.update(tenants).set({ licence_expires_at: exp }).where(eq(tenants.id, TENANT));
  fake.licences.find((l) => l.id === OLD_LIC)!.expiresAt = exp;
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { expiresAt: null });
  expect(res.status).toBe(200);
  const fresh = tenantLicence(await tenantRow());
  expect(fresh.expiresAt).toBeNull();
  expect((await tenantRow()).licence_expires_at).toBeNull();
});

test('A2 Test 5: a PAST expiry → the licence is re-issued with it and Gate 2 answers 402 license_expired', async () => {
  const past = '2001-01-01T00:00:00Z';
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { expiresAt: past });
  expect(res.status).toBe(200);
  expect((await tenantRow()).licence_expires_at?.toISOString()).toBe('2001-01-01T00:00:00.000Z');

  lic.enforceGate2 = true;
  __setLicenseClientForTests(fake.introspector);
  try {
    await assertTenantLicensed(new Request('http://t/api/x'), TENANT);
    throw new Error('the gate admitted an expired licence');
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(402);
    expect((e as HttpError).code).toBe('license_expired');
  } finally {
    lic.enforceGate2 = was.enforceGate2;
    __setLicenseClientForTests(undefined);
  }
});

test('an expiry before the start → 422 licence_window_invalid', async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}`, {
    startsAt: '2030-01-01T00:00:00Z',
    expiresAt: '2029-01-01T00:00:00Z',
  });
  expect(res.status).toBe(422);
  expect(fake.order).toEqual([]);
});

// ---- Test 6: rename -----------------------------------------------------------------------------

test('A2 Test 6: rename → the DISPLAY name only; slug and licences_name stay one name; licences not called; audited', async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { name: 'A2C Renamed' });
  expect(res.status).toBe(200);
  expect(fake.renames).toEqual([]);
  const row = await tenantRow();
  expect(row.name).toBe('A2C Renamed');
  // ⛔ Both immutable: the slug is the SSO alias root (`entra-<slug>`) and the offboard confirm;
  // the licences name IS the slug (cb4dd0f). A rename that moved only one split the pair.
  expect(row.slug).toBe('a2c-acme');
  expect(row.licences_name).toBe('a2c-acme');
  const [a] = await audits('tenant.rename');
  expect(a?.metadata).toMatchObject({
    before: { name: 'A2C Acme' },
    after: { name: 'A2C Renamed' },
    slug: 'a2c-acme',
    licencesName: 'a2c-acme',
  });
});

// ---- Test 7: seats ------------------------------------------------------------------------------

test('A2 Test 7: seats below members + pending invites → 409 seats_below_usage; at the usage → 200', async () => {
  await db.insert(users).values({ id: MEMBER2_ID, email: 'm2@a2c.test', name: 'M2', tenant_id: TENANT });
  await db.insert(tenantInvites).values({
    tenant_id: TENANT,
    email: 'pending@a2c.test',
    role: 'member',
    token_hash: 'a2c-pending-hash',
    expires_at: new Date(Date.now() + 86_400_000),
  });
  // 2 members + 1 pending = 3
  const low = await call('PATCH', `/api/tenants/${TENANT}`, { maxMembers: 2 });
  expect(low.status).toBe(409);
  const body = (await low.json()) as { error: string; details: Record<string, number> };
  expect(body.error).toBe('seats_below_usage');
  expect(body.details).toMatchObject({ members: 2, pending: 1, used: 3, requested: 2 });
  expect((await tenantRow()).max_members).toBe(10);

  const ok = await call('PATCH', `/api/tenants/${TENANT}`, { maxMembers: 3 });
  expect(ok.status).toBe(200);
  expect((await tenantRow()).max_members).toBe(3);
  const [a] = await audits('tenant.seats');
  expect(a?.metadata).toMatchObject({ before: 10, after: 3 });
});

// ---- BYO + GET licence --------------------------------------------------------------------------

test('byoMode → the per-app posture is set centrally, audited before/after', async () => {
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { byoMode: 'byo_required' });
  expect(res.status).toBe(200);
  expect(fake.byo).toEqual([{ tenantId: TENANT, mode: 'byo_required' }]);
  const [a] = await audits('tenant.byo_mode');
  expect(a?.metadata).toMatchObject({ before: 'local_allowed', after: 'byo_required' });
});

test('GET /api/tenants/:id/licence → CP terms + THE TENANT LICENCE (by its cp-tenant holder) side by side', async () => {
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  const row = await tenantRow();
  const res = await call('GET', `/api/tenants/${TENANT}/licence`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    tenantId: TENANT,
    planCode: 'pro',
    startsAt: null,
    expiresAt: null,
    status: 'active',
    licenceId: row.licence_id,
    holder: row.licence_subject_sub,
    byoMode: 'local_allowed',
    licencesName: 'a2c-acme',
    live: { active: true, licenceId: row.licence_id, planCode: 'pro' },
    liveError: null,
  });
});

test("GET /licence on a pre-A2 tenant reports holder 'legacy_member_seat' — never a member's seat as the tenant licence", async () => {
  // The seeded row: licence on a person's subject, as every pre-A2 tenant. licences, asked without
  // a selector, would answer with ANY active licence of the tenant — a member's seat included.
  const res = await call('GET', `/api/tenants/${TENANT}/licence`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { holder: string; live: unknown };
  expect(body.holder).toBe('legacy_member_seat');
  expect(body.live).toBeNull();
});

// ---- the cp-tenant licence is RELEASED by suspend / offboard (re-audit finding) ------------------

/** Active licences this tenant holds on its cp-tenant subjects, per the fake registry. */
const activeCpTenantLicences = () =>
  fake.licences.filter((l) => l.sub.startsWith(`cp-tenant:${TENANT}:`) && !l.revoked);

test('⛔ suspend releases EVERY cp-tenant licence (licences revokes only the token on the token arm); reactivate leaves exactly one', async () => {
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'standard' })).status).toBe(200);
  expect(activeCpTenantLicences().length).toBe(1);

  expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'suspended' })).status).toBe(200);
  expect(activeCpTenantLicences()).toEqual([]);

  expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'active' })).status).toBe(200);
  expect(activeCpTenantLicences().length).toBe(1);
  expect(activeCpTenantLicences()[0]!.id).toBe((await tenantRow()).licence_id!);
});

test('⛔ offboard releases the cp-tenant licence — directly, and after a suspend (no token stored any more)', async () => {
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  expect(activeCpTenantLicences().length).toBe(1);
  // A strayed second cp-tenant licence (e.g. an old-licence revoke that failed) is swept too.
  fake.licences.push({
    id: '00000000-0000-4000-8000-0000a2c1d001',
    sub: `cp-tenant:${TENANT}:b`, // the change put the licence on :a
    planCode: 'standard',
    startsAt: null,
    expiresAt: null,
    revoked: false,
  });
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'suspended' })).status).toBe(200);
  // Simulate a suspend that left one behind, then offboard the suspended (token-less) workspace.
  fake.licences.find((l) => l.id === '00000000-0000-4000-8000-0000a2c1d001')!.revoked = false;
  const res = await call('POST', `/api/tenants/${TENANT}/offboard`, { confirmSlug: 'a2c-acme' });
  expect(res.status).toBe(200);
  expect(activeCpTenantLicences()).toEqual([]);
});

test('offboarding a licensed workspace directly leaves zero active cp-tenant licences', async () => {
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  const res = await call('POST', `/api/tenants/${TENANT}/offboard`, { confirmSlug: 'a2c-acme' });
  expect(res.status).toBe(200);
  expect(activeCpTenantLicences()).toEqual([]);
  // member seats are released by the seat loop, not by this sweep
  expect(fake.order.filter((o) => o.startsWith('revoke:'))).not.toContain(`revoke:${OLD_SUB}`);
});

// ---- re-home of pre-A2 tenants (onboarding-integrity sweep) --------------------------------------

test('⛔ RE-HOME: one tick moves a pre-A2 tenant (licence = oldest member\'s seat) onto cp-tenant:a; offboarding that member keeps it licensed; a 2nd tick is a no-op', async () => {
  await db
    .update(tenants)
    .set({ license_token_encrypted: encryptSecret(`tok-${MEM_LIC}`), licence_id: MEM_LIC, licence_subject_sub: MEMBER_ID })
    .where(eq(tenants.id, TENANT));
  fake.licences.find((l) => l.id === OLD_LIC)!.revoked = true;
  __setLicenseClientForTests(fake.introspector);
  try {
    const first = await __seatSweepsForTests.rehomeLegacyTenantLicences();
    expect(first).toMatchObject({ rehomed: 1, failed: 0 });
    const row = await tenantRow();
    expect(row.licence_subject_sub).toBe(`cp-tenant:${TENANT}:a`);
    expect(row.licence_id).not.toBe(MEM_LIC);
    // The old licence is the member's SEAT: not revoked.
    expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false);

    await revokeMemberEntitlement(TENANT, MEMBER_ID);
    lic.enforceGate2 = true;
    await assertTenantLicensed(new Request('http://t/api/x'), TENANT); // throws on 402

    const ordersBefore = fake.order.length;
    const second = await __seatSweepsForTests.rehomeLegacyTenantLicences();
    expect(second).toMatchObject({ rehomed: 0, failed: 0 });
    expect(fake.order.length).toBe(ordersBefore);
  } finally {
    lic.enforceGate2 = was.enforceGate2;
    __setLicenseClientForTests(undefined);
  }
});

test('RE-HOME: an old licence held by a non-member person (a super_admin) is revoked once the tenant is moved', async () => {
  __setLicenseClientForTests(fake.introspector);
  try {
    // The seeded row: holder OLD_SUB, no seat row, not a member.
    expect(await __seatSweepsForTests.rehomeLegacyTenantLicences()).toMatchObject({ rehomed: 1, failed: 0 });
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);
    expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('licence routes are super_admin only', async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => ({
      id: MEMBER_ID,
      email: 'm@a2c.test',
      name: 'M',
      roles: [],
      tenantId: TENANT,
      tenantRole: 'tenant_admin',
      emailVerified: true,
    }),
  });
  expect((await call('GET', `/api/tenants/${TENANT}/licence`)).status).toBe(403);
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(403);
  expect(fake.order).toEqual([]);
});

// ---- final audit: PROD-SHAPED rows, the licence lease, a lost CAS, the ensure preconditions -----

/** PROD SHAPE: every pre-0095 row has licence_id NULL and licence_subject_sub NULL (0095 backfills
 *  neither; every post-0095 write stores a cp-tenant holder). */
async function prodShape(over: { token?: string } = {}) {
  await db
    .update(tenants)
    .set({
      licence_id: null,
      licence_subject_sub: null,
      ...(over.token ? { license_token_encrypted: encryptSecret(over.token) } : {}),
    })
    .where(eq(tenants.id, TENANT));
}

test('⛔ PROD SHAPE (holder + id NULL): a licence bound to a super_admin who is no member is REVOKED on re-home', async () => {
  await prodShape(); // token → OLD_LIC on OLD_SUB, a super_admin, not a member of this tenant
  __setLicenseClientForTests(fake.introspector);
  try {
    expect(await __seatSweepsForTests.rehomeLegacyTenantLicences()).toMatchObject({ rehomed: 1, failed: 0 });
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);
    expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false); // the member's seat
    expect((await tenantRow()).licence_subject_sub).toBe(`cp-tenant:${TENANT}:a`);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('PROD SHAPE: a licence that IS a live member\'s seat is KEPT — by seat row, and without one (pre-0089 member)', async () => {
  for (const withSeatRow of [true, false]) {
    await db
      .update(tenants)
      .set({ licence_subject_sub: null, licence_id: null })
      .where(eq(tenants.id, TENANT));
    await prodShape({ token: `tok-${MEM_LIC}` });
    if (!withSeatRow) await db.delete(memberEntitlements).where(eq(memberEntitlements.tenant_id, TENANT));
    __setLicenseClientForTests(fake.introspector);
    try {
      expect(await __seatSweepsForTests.rehomeLegacyTenantLicences()).toMatchObject({ rehomed: 1 });
      expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false);
    } finally {
      __setLicenseClientForTests(undefined);
    }
  }
});

test('⛔ PROBE 2b: a plan change during a re-home is refused (409 licence_busy); ONE active cp-tenant licence, the stored one; Gate 2 passes', async () => {
  await prodShape();
  __setLicenseClientForTests(fake.introspector);
  const realToken = fake.client.createToken.bind(fake.client);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let first = true;
  fake.client.createToken = async (id, t) => {
    if (first) {
      first = false;
      await hold; // the re-home, parked between its mint and its CAS
    }
    return realToken(id, t);
  };
  try {
    const rehome = rehomeTenantLicence(TENANT);
    await new Promise((r) => setTimeout(r, 50));
    const change = await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' });
    expect(change.status).toBe(409);
    expect(((await change.json()) as { error: string }).error).toBe('licence_busy');
    release();
    expect(await rehome).toBe('rehomed');

    const row = await tenantRow();
    const active = fake.licences.filter((l) => l.sub.startsWith(`cp-tenant:${TENANT}:`) && !l.revoked);
    expect(active.map((l) => l.id)).toEqual([row.licence_id!]);
    expect(decryptSecret(row.license_token_encrypted!)).toBe(`tok-${row.licence_id}`);
    lic.enforceGate2 = true;
    await assertTenantLicensed(new Request('http://t/api/x'), TENANT); // 200
    // …and the lease was released: the change now goes through.
    lic.enforceGate2 = was.enforceGate2;
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  } finally {
    lic.enforceGate2 = was.enforceGate2;
    fake.client.createToken = realToken;
    __setLicenseClientForTests(undefined);
  }
});

test('mintWithTerms never revokes the STORED tenant licence: it takes the other slot instead', async () => {
  // The stored licence sits on slot :a with OLD terms; something asks for slot :a on new terms.
  const stored = '00000000-0000-4000-8000-0000a2c1d0a1';
  fake.licences.push({ id: stored, sub: `cp-tenant:${TENANT}:a`, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false });
  await db
    .update(tenants)
    .set({ licence_id: stored, licence_subject_sub: `cp-tenant:${TENANT}:b`, license_token_encrypted: encryptSecret(`tok-${stored}`) })
    .where(eq(tenants.id, TENANT));
  // holder recorded as :b (stale), so the change prefers :a — where the STORED licence lives.
  expect((await call('PATCH', `/api/tenants/${TENANT}`, { planCode: 'pro' })).status).toBe(200);
  const row = await tenantRow();
  expect(row.licence_subject_sub).toBe(`cp-tenant:${TENANT}:b`);
  // the stored licence was only revoked AFTER the swap, as the old licence — never to make room
  const swapMint = fake.order.findIndex((o) => o === `mint:${row.licence_id}`);
  expect(swapMint).toBeGreaterThanOrEqual(0);
  expect(fake.order.indexOf(`revoke:${stored}`)).toBeGreaterThan(swapMint);
});

test('⛔ a re-home that LOSES its CAS revokes the licence it minted', async () => {
  await prodShape();
  __setLicenseClientForTests(fake.introspector);
  const realToken = fake.client.createToken.bind(fake.client);
  fake.client.createToken = async (id, t) => {
    // Something outside the lease rewrites the tenant's token between the re-home's mint and CAS.
    await db
      .update(tenants)
      .set({ license_token_encrypted: encryptSecret(`tok-${MEM_LIC}`) })
      .where(eq(tenants.id, TENANT));
    return realToken(id, t);
  };
  try {
    expect(await rehomeTenantLicence(TENANT)).toBe('lost_race');
    const orphan = fake.licences.find((l) => l.sub === `cp-tenant:${TENANT}:a`)!;
    expect(orphan.revoked).toBe(true);
  } finally {
    fake.client.createToken = realToken;
    __setLicenseClientForTests(undefined);
  }
});

test('re-home leaves a tenant covered by a bundle (svc:) licence alone — exactly like ensureTenantLicense', async () => {
  await prodShape();
  fake.licences.push({
    id: '00000000-0000-4000-8000-0000a2c1d0b1',
    sub: `svc:${TENANT}:${config.license.appKey}`,
    planCode: 'standard',
    startsAt: null,
    expiresAt: null,
    revoked: false,
  });
  __setLicenseClientForTests(fake.introspector);
  try {
    expect(await rehomeTenantLicence(TENANT)).toBe('tenant_level');
    expect(fake.order.filter((o) => o.startsWith('mint:'))).toEqual([]);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('re-home registers the licences name first; a NAME CONFLICT is counted once and not retried every tick', async () => {
  await prodShape();
  fake = makeLicences({ registerConflict: true });
  __setLicensesAdminForTests(fake.client);
  __resetRehomeNameConflictsForTests();
  __setLicenseClientForTests(fake.introspector);
  try {
    expect(await __seatSweepsForTests.rehomeLegacyTenantLicences()).toEqual({ rehomed: 0, failed: 0, nameConflicts: 1 });
    expect(fake.order).toEqual(['register:a2c-acme']); // registered first, nothing minted
    expect(await __seatSweepsForTests.rehomeLegacyTenantLicences()).toEqual({ rehomed: 0, failed: 0, nameConflicts: 0 });
    expect(fake.order).toEqual(['register:a2c-acme']); // not asked again
  } finally {
    __resetRehomeNameConflictsForTests();
    __setLicenseClientForTests(undefined);
  }
});

// ---- re-audit of deed13b: inactive vs unknown, decide-before-CAS + durable pending revoke, the
// ---- legacy revoke path, prod shapes (nonagentic), reactivation -----------------------------------

const OTHER_TENANT = '00000000-0000-4000-8000-0000a2c1e001';
const FRTEST_SUB = '00000000-0000-4000-8000-0000a2c1e002';
const FRTEST_LIC_HERE = '00000000-0000-4000-8000-0000a2c1e0a1';
const FRTEST_SEAT_HOME = '00000000-0000-4000-8000-0000a2c1e0a2';

test('⛔ re-home of a tenant whose stored licence is INACTIVE (introspect answered) — re-homed, not skipped forever', async () => {
  await prodShape();
  fake.licences.find((l) => l.id === OLD_LIC)!.revoked = true; // licences answers active:false
  __setLicenseClientForTests(fake.introspector);
  try {
    expect(await rehomeTenantLicence(TENANT)).toBe('rehomed');
    const row = await tenantRow();
    expect(row.licence_subject_sub).toBe(`cp-tenant:${TENANT}:a`);
    lic.enforceGate2 = true;
    await assertTenantLicensed(new Request('http://t/api/x'), TENANT); // no longer 402
  } finally {
    lic.enforceGate2 = was.enforceGate2;
    __setLicenseClientForTests(undefined);
  }
});

test('re-home when introspect THREW is deferred (unresolved) and counted', async () => {
  await prodShape();
  fake.failures.introspect = true;
  __setLicenseClientForTests(fake.introspector);
  try {
    const before = (renderMetrics().match(/tenant_licence_rehome_unresolved_total (\d+)/)?.[1] ?? '0');
    expect(await rehomeTenantLicence(TENANT)).toBe('unresolved');
    const after = renderMetrics().match(/tenant_licence_rehome_unresolved_total (\d+)/)?.[1];
    expect(Number(after)).toBe(Number(before) + 1);
    expect((await tenantRow()).licence_subject_sub).toBeNull(); // untouched
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('⛔ a member lookup failing BEFORE the swap leaves the tenant un-swapped (it is selected again next tick)', async () => {
  await prodShape();
  fake.failures.list = true; // the keep-or-revoke lookup for a holder-less row
  __setLicenseClientForTests(fake.introspector);
  try {
    expect((await __seatSweepsForTests.rehomeLegacyTenantLicences()).failed).toBe(1);
    expect((await tenantRow()).licence_subject_sub).toBeNull();
    expect(fake.order.filter((o) => o.startsWith('mint:'))).toEqual([]);
    fake.failures.list = false;
    expect((await __seatSweepsForTests.rehomeLegacyTenantLicences()).rehomed).toBe(1);
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('⛔ the old-licence revoke failing AFTER the swap is recorded durably and retried by the sweep', async () => {
  await prodShape();
  fake.failures.revokeIds.add(OLD_LIC);
  __setLicenseClientForTests(fake.introspector);
  try {
    expect(await rehomeTenantLicence(TENANT)).toBe('rehomed');
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(false);
    expect((await tenantRow()).licence_revoke_pending).toEqual([OLD_LIC]);
    // still down → still pending
    expect(await __seatSweepsForTests.retryPendingLicenceRevokes()).toMatchObject({ revoked: 0, failed: 1 });
    fake.failures.revokeIds.clear();
    expect(await __seatSweepsForTests.retryPendingLicenceRevokes()).toMatchObject({ revoked: 1, failed: 0 });
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);
    expect((await tenantRow()).licence_revoke_pending).toEqual([]);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('⛔ suspend of a NEVER-re-homed tenant (prod shape, super_admin-bound) revokes the licence BY ID, not just its token', async () => {
  await prodShape();
  __setLicenseClientForTests(fake.introspector);
  try {
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'suspended' })).status).toBe(200);
    expect(fake.licences.find((l) => l.id === OLD_LIC)?.revoked).toBe(true);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('suspend of a never-re-homed tenant whose licence IS a live member\'s seat ends only the token (the seat loop releases the seat)', async () => {
  await prodShape({ token: `tok-${MEM_LIC}` });
  // keep the member's seat row out of the suspend seat loop's way: no row, licence still the seat
  await db.delete(memberEntitlements).where(eq(memberEntitlements.tenant_id, TENANT));
  __setLicenseClientForTests(fake.introspector);
  try {
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'suspended' })).status).toBe(200);
    expect(fake.order).not.toContain(`revoke:${MEM_LIC}`);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('⛔ PROD SHAPE "nonagentic": the only licence is held by a super_admin who is a member of ANOTHER tenant — revoked here; their seat in their home tenant untouched', async () => {
  await db.insert(tenants).values({ id: OTHER_TENANT, name: 'A2C Home', slug: 'a2c-home' }).onConflictDoNothing();
  await db.insert(users).values({
    id: FRTEST_SUB,
    email: 'frtest@a2c.test',
    name: 'FR',
    tenant_id: OTHER_TENANT,
    keycloak_sub: FRTEST_SUB,
  });
  try {
    // This tenant: NO member holds a licence; its single licence is fr-test's (subject realm is
    // irrelevant — prod has secure-apps AND portal subjects; nothing keys on it).
    fake.licences.find((l) => l.id === OLD_LIC)!.revoked = true;
    fake.licences.push(
      { id: FRTEST_LIC_HERE, sub: FRTEST_SUB, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false },
      { id: FRTEST_SEAT_HOME, sub: FRTEST_SUB, planCode: 'standard', startsAt: null, expiresAt: null, revoked: false, tenant: OTHER_TENANT },
    );
    await prodShape({ token: `tok-${FRTEST_LIC_HERE}` });
    __setLicenseClientForTests(fake.introspector);
    expect(await rehomeTenantLicence(TENANT)).toBe('rehomed');
    expect(fake.licences.find((l) => l.id === FRTEST_LIC_HERE)?.revoked).toBe(true);
    expect(fake.licences.find((l) => l.id === FRTEST_SEAT_HOME)?.revoked).toBe(false);
    expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false); // this tenant's member
  } finally {
    __setLicenseClientForTests(undefined);
    await db.delete(users).where(eq(users.id, FRTEST_SUB));
    await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
  }
});

test('reactivating a SUSPENDED legacy tenant (token still stored) revokes no live member\'s seat; the next re-home keeps it too', async () => {
  await prodShape({ token: `tok-${MEM_LIC}` });
  await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, TENANT));
  __setLicenseClientForTests(fake.introspector);
  try {
    expect((await call('PATCH', `/api/tenants/${TENANT}`, { status: 'active' })).status).toBe(200);
    expect(await rehomeTenantLicence(TENANT)).toBe('rehomed');
    expect(fake.order).not.toContain(`revoke:${MEM_LIC}`);
    expect(fake.licences.find((l) => l.id === MEM_LIC)?.revoked).toBe(false);
  } finally {
    __setLicenseClientForTests(undefined);
  }
});

test('reactivate while another licence op holds the lease → 409 licence_busy (not 200 without a licence)', async () => {
  await db
    .update(tenants)
    .set({ status: 'suspended', license_token_encrypted: null, licence_op_id: OLD_LIC, licence_op_until: new Date(Date.now() + 60_000) })
    .where(eq(tenants.id, TENANT));
  const res = await call('PATCH', `/api/tenants/${TENANT}`, { status: 'active' });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('licence_busy');
});
