// tests/platform-plans.test.ts — A2 §5: the plan catalogue routes (/api/platform/plans).
//
// super_admin only; the app is pinned server-side (a request naming another app is refused, and an
// id outside THIS app's catalogue is a 404 — licences' PATCH/DELETE /plans/{id} would otherwise edit
// any product's plan by id); delete of a plan in use is a 409 `plan_in_use` whether CP or licences
// knows it; retire without licences support is a 501, never a silent success.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, tenants, auditLog } from '../src/db/client';
import { config } from '../src/config';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  PlanRetireUnsupportedError,
  type LicensesAdminClient,
  type LicencesPlan,
  type PlanUpdateInput,
} from '../src/services/licenses-admin';
import { registerPlatformPlanRoutes, __resetRetireCapabilityForTests } from '../src/routes/platform-plans';
import { Router } from '../src/utils/router';
import { SYSTEM_TENANT_ID } from '../src/services/license-provisioning';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

const SA_ID = '00000000-0000-4000-8000-0000a2c20001';
const TA_ID = '00000000-0000-4000-8000-0000a2c20002';
const TENANT = '00000000-0000-4000-8000-0000a2c20003';
const P_STD = '00000000-0000-4000-8000-0000a2c2b001';
const P_LOCAL = '00000000-0000-4000-8000-0000a2c2b002';
const P_UNUSED = '00000000-0000-4000-8000-0000a2c2b003';
/** A plan of ANOTHER app — never in this app's catalogue. */
const P_FOREIGN = '00000000-0000-4000-8000-0000a2c2b0ff';

const superAdmin: User = { id: SA_ID, email: 'sa@a2c2.test', name: 'SA', roles: ['super_admin'] };
const tenantAdmin: User = {
  id: TA_ID,
  email: 'ta@a2c2.test',
  name: 'TA',
  roles: [],
  tenantId: TENANT,
  tenantRole: 'tenant_admin',
};
let current: User = superAdmin;

const router = new Router();
registerPlatformPlanRoutes(router);

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

const mk = (id: string, code: string, revoked = false): LicencesPlan => ({
  id,
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

function makeLicences(opts: { retireSupported?: boolean; deleteConflict?: boolean } = {}) {
  const plans = [mk(P_STD, 'standard'), mk(P_LOCAL, 'local-llm'), mk(P_UNUSED, 'a2c2-unused')];
  const calls = { updated: [] as Array<{ id: string; patch: PlanUpdateInput }>, deleted: [] as string[], created: [] as string[] };
  const client = {
    async listPlans(o?: { includeRevoked?: boolean }) {
      return plans.filter((p) => o?.includeRevoked || !p.revoked);
    },
    async createPlan(input: { code: string; name: string }) {
      if (plans.some((p) => p.code === input.code)) throw new LicensesAdminError(409, 'taken');
      calls.created.push(input.code);
      const p = mk('00000000-0000-4000-8000-0000a2c2b0aa', input.code);
      plans.push(p);
      return p;
    },
    async updatePlan(id: string, patch: PlanUpdateInput) {
      calls.updated.push({ id, patch });
      if (patch.revoked !== undefined && !opts.retireSupported) throw new PlanRetireUnsupportedError();
      const p = plans.find((x) => x.id === id)!;
      Object.assign(p, patch);
      return { ...p };
    },
    async deletePlan(id: string) {
      if (opts.deleteConflict) throw new LicensesAdminError(409, 'licenses still reference it');
      calls.deleted.push(id);
    },
  } as unknown as LicensesAdminClient;
  return { client, calls, plans };
}

type LicenceCfg = { adminBaseUrl: string; sa: { tokenUrl: string } };
const lic = config.license as unknown as LicenceCfg;
const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl };

beforeEach(async () => {
  current = superAdmin;
  __setAuthOverridesForTests({ validateAuth: async () => current });
  __resetRetireCapabilityForTests();
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  await db.delete(auditLog).where(eq(auditLog.actor_id, SA_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
  // One CP tenant on `local-llm`: that plan is IN USE as far as CP knows.
  await db.insert(tenants).values({ id: TENANT, name: 'A2C2', slug: 'a2c2-tenant', plan_code: 'local-llm' });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  lic.adminBaseUrl = was.base;
  lic.sa.tokenUrl = was.token;
  await db.delete(auditLog).where(eq(auditLog.actor_id, SA_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}, 30_000);

test('A2 Test 8: every plan route refuses a non-super_admin (403), and nothing reaches licences', async () => {
  const fake = makeLicences({ retireSupported: true });
  __setLicensesAdminForTests(fake.client);
  current = tenantAdmin;
  expect((await call('GET', '/api/platform/plans')).status).toBe(403);
  expect((await call('POST', '/api/platform/plans', { code: 'x1', name: 'X' })).status).toBe(403);
  expect((await call('PATCH', `/api/platform/plans/${P_UNUSED}`, { name: 'Y' })).status).toBe(403);
  expect((await call('DELETE', `/api/platform/plans/${P_UNUSED}`)).status).toBe(403);
  expect(fake.calls).toEqual({ updated: [], deleted: [], created: [] });
});

test('A2 Test 8: an app other than commonpractice is refused — by name, and by a foreign plan id', async () => {
  const fake = makeLicences({ retireSupported: true });
  __setLicensesAdminForTests(fake.client);
  const byQuery = await call('GET', '/api/platform/plans?app=fr');
  expect(byQuery.status).toBe(403);
  expect(((await byQuery.json()) as { error: string }).error).toBe('app_not_allowed');
  const byBody = await call('POST', '/api/platform/plans', { app: 'fr', code: 'x1', name: 'X' });
  expect(byBody.status).toBe(403);
  // A plan id that is not in THIS app's catalogue is not ours to edit or delete.
  expect((await call('PATCH', `/api/platform/plans/${P_FOREIGN}`, { name: 'Y' })).status).toBe(404);
  expect((await call('DELETE', `/api/platform/plans/${P_FOREIGN}`)).status).toBe(404);
  expect(fake.calls).toEqual({ updated: [], deleted: [], created: [] });
  // Naming the OWN app explicitly is fine.
  expect((await call('GET', `/api/platform/plans?app=${config.license.appKey}`)).status).toBe(200);
});

test('A2 Test 8: deleting a plan CP tenants are on → 409 plan_in_use with the count; licences never asked', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const res = await call('DELETE', `/api/platform/plans/${P_LOCAL}`);
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string; details: { tenantCount: number } };
  expect(body.error).toBe('plan_in_use');
  expect(body.details.tenantCount).toBe(1);
  expect(fake.calls.deleted).toEqual([]);
});

test('A2 Test 8: licences 409 on delete (licences reference it) → mapped 409 plan_in_use', async () => {
  const fake = makeLicences({ deleteConflict: true });
  __setLicensesAdminForTests(fake.client);
  const res = await call('DELETE', `/api/platform/plans/${P_UNUSED}`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('plan_in_use');
});

test('delete of an unreferenced plan → 200, audited', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const res = await call('DELETE', `/api/platform/plans/${P_UNUSED}`);
  expect(res.status).toBe(200);
  expect(fake.calls.deleted).toEqual([P_UNUSED]);
  const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'plan.delete'));
  expect(rows.some((r) => r.target_id === P_UNUSED)).toBe(true);
});

test('GET lists the catalogue with per-plan tenant counts from tenants.plan_code', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const res = await call('GET', '/api/platform/plans');
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    app: string;
    plans: Array<{ code: string; tenantCount: number }>;
    capabilities: { canRetire: boolean | null };
  };
  expect(body.app).toBe(config.license.appKey);
  expect(body.plans.find((p) => p.code === 'local-llm')?.tenantCount).toBeGreaterThanOrEqual(1);
  expect(body.plans.find((p) => p.code === 'a2c2-unused')?.tenantCount).toBe(0);
  expect(body.capabilities.canRetire).toBeNull(); // not observed yet
});

test('create → 201; a taken code → 409 plan_code_taken', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const ok = await call('POST', '/api/platform/plans', { code: 'a2c2-new', name: 'New', quotaMonthly: 100 });
  expect(ok.status).toBe(201);
  expect(fake.calls.created).toEqual(['a2c2-new']);
  const dup = await call('POST', '/api/platform/plans', { code: 'standard', name: 'Std' });
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as { error: string }).error).toBe('plan_code_taken');
});

test('retire without licences support → 501 retire_unsupported; canRetire flips to false', async () => {
  const fake = makeLicences({ retireSupported: false });
  __setLicensesAdminForTests(fake.client);
  const res = await call('PATCH', `/api/platform/plans/${P_UNUSED}`, { revoked: true });
  expect(res.status).toBe(501);
  expect(((await res.json()) as { error: string }).error).toBe('retire_unsupported');
  const list = (await (await call('GET', '/api/platform/plans')).json()) as { capabilities: { canRetire: boolean | null } };
  expect(list.capabilities.canRetire).toBe(false);
});

test('retire WITH licences support → the plan comes back revoked; fields and revoked go as separate PATCHes', async () => {
  const fake = makeLicences({ retireSupported: true });
  __setLicensesAdminForTests(fake.client);
  const res = await call('PATCH', `/api/platform/plans/${P_UNUSED}`, { name: 'Old', revoked: true });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { plan: { revoked: boolean } }).plan.revoked).toBe(true);
  expect(fake.calls.updated).toEqual([
    { id: P_UNUSED, patch: { name: 'Old' } },
    { id: P_UNUSED, patch: { revoked: true } },
  ]);
});

test('the SYSTEM tenant is not counted as a workspace on a plan (it is not a customer)', async () => {
  // ⛔ Plans showed "Standard … Workspaces: 4" for 3 customer workspaces: the nil-UUID seed tenant
  // (Dev User) sits on the default plan and was counted — and it would block deleting that plan.
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  await db
    .insert(tenants)
    .values({ id: SYSTEM_TENANT_ID, name: 'Dev User', slug: `u-${SYSTEM_TENANT_ID.replace(/-/g, '')}` })
    .onConflictDoNothing();
  const [before] = await db
    .select({ plan: tenants.plan_code })
    .from(tenants)
    .where(eq(tenants.id, SYSTEM_TENANT_ID));
  await db.update(tenants).set({ plan_code: 'a2c2-unused' }).where(eq(tenants.id, SYSTEM_TENANT_ID));
  try {
    const body = (await (await call('GET', '/api/platform/plans')).json()) as {
      plans: Array<{ code: string; tenantCount: number }>;
    };
    expect(body.plans.find((p) => p.code === 'a2c2-unused')?.tenantCount).toBe(0);
    // …and it does not hold the plan hostage either.
    expect((await call('DELETE', `/api/platform/plans/${P_UNUSED}`)).status).toBe(200);
  } finally {
    await db
      .update(tenants)
      .set({ plan_code: before?.plan ?? null })
      .where(eq(tenants.id, SYSTEM_TENANT_ID));
  }
});
