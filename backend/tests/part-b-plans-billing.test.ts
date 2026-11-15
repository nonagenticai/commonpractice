// tests/part-b-plans-billing.test.ts — Part B: the `local-llm` / `byo` plans, billing terms, the
// retired welcome budget, the tenant's own inference-router credential, and the plan migration.
//
// Every test here fails on the code before this change:
//   • create writes the billing terms exactly ONCE, and a replay writes nothing;
//   • the plan FIXES the BYO posture (local-llm → local_allowed, byo → byo_required);
//   • a local-llm create provisions + smoke-tests + stores the tenant's router token;
//   • the welcome-budget grant route is gone and the budget read no longer comes from it;
//   • (offboarding no longer touches OpenRouter: the grant-key path is deleted);
//   • the plan-migration dry run writes nothing.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, like, inArray } from 'drizzle-orm';
import { db, tenants, tenantLlmBudgets, tenantLlmSettings, queryClient } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret, tryDecryptSecret } from '../src/host/secret-box';
import {
  __setLicensesAdminForTests,
  type LicensesAdminClient,
  type LicenceTerms,
  type LicencesPlan,
} from '../src/services/licenses-admin';
import {
  __setBillingAdminForTests,
  type BillingAdminClient,
  type BillingTermsView,
  type TenantTerms,
} from '../src/services/billing-admin';
import { writeTenantTerms } from '../src/services/tenant-terms';
import {
  __setInferenceLicencesForTests,
  __setInferenceFetchForTests,
} from '../src/services/tenant-inference';
import { applyTenantMigration, planTenantMigration, type MigrationStep } from '../src/services/plan-migration';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

const ADMIN_ID = '00000000-0000-4000-8000-0000b0b00001';
const admin: User = { id: ADMIN_ID, email: 'pb.admin@test.dev', name: 'PB Admin', roles: ['super_admin'] };
const GRANT_TENANT = '00000000-0000-4000-8000-0000b0b0a001';

const router = new Router();
registerAdminRoutes(router);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const m = router.match(method, path);
  if (!m) return new Response(null, { status: 404 });
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    ...m.params,
  );
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string } };
const lic = config.license as LicenceCfg;
const llm = config.llm as { openaiBaseUrl: string };
const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled, ir: llm.openaiBaseUrl };

const plan = (code: string, revoked = false): LicencesPlan => ({
  id: `00000000-0000-4000-8000-0000b0b0${String(code.length).padStart(2, '0')}${revoked ? 'f' : 'e'}0`,
  code,
  name: code,
  description: null,
  durationDays: null,
  rateLimitRpm: 60,
  rateLimitBurst: 10,
  quotaMonthly: null,
  tokenBudgetMonthly: null,
  revoked,
  createdAt: null,
});

/** A licences fake recording every call; `mutations` lists every WRITE method invoked. */
function makeLicences(
  plans: LicencesPlan[] = [plan('standard'), plan('local-llm'), plan('byo')],
  opts: { revokeFails?: boolean; byoFails?: boolean } = {},
) {
  const calls = {
    revoked: [] as string[],
    tokensRevoked: [] as string[],
    byo: [] as Array<{ tenantId: string; mode: string }>,
    minted: [] as Array<{ subject: string; tenantId: string; terms: LicenceTerms | undefined }>,
    mutations: [] as string[],
  };
  let n = 0;
  const postures = new Map<string, string>();
  const client: LicensesAdminClient & { getTenantByoMode(id: string): Promise<string> } = {
    async getTenant() {
      return null;
    },
    async ensureTenantRegistered() {
      calls.mutations.push('ensureTenantRegistered');
    },
    async archiveTenant() {
      calls.mutations.push('archiveTenant');
    },
    async setTenantByoMode(tenantId, mode) {
      calls.mutations.push('setTenantByoMode');
      if (opts.byoFails) throw new Error('licences down (byo)');
      calls.byo.push({ tenantId, mode });
      postures.set(tenantId, mode);
    },
    // The live posture read (`readTenantByoMode`): what was last set, else licences' default.
    async getTenantByoMode(tenantId: string) {
      return postures.get(tenantId) ?? 'local_allowed';
    },
    async listPlans() {
      return plans;
    },
    async createPlan() {
      calls.mutations.push('createPlan');
      return plan('x');
    },
    async updatePlan() {
      calls.mutations.push('updatePlan');
      return plan('x');
    },
    async createLicense(subject, tenantId, terms) {
      calls.mutations.push('createLicense');
      calls.minted.push({ subject, tenantId, terms });
      n++;
      return { licenseId: `00000000-0000-4000-8000-0000b0b0c${String(n).padStart(3, '0')}`, subjectId: '11111111-1111-4111-8111-0000b0b00001' };
    },
    async createToken(licenseId) {
      calls.mutations.push('createToken');
      return { token: `tok-${licenseId.slice(-4)}` };
    },
    async revokeByToken(token) {
      calls.mutations.push('revokeByToken');
      calls.tokensRevoked.push(token);
    },
    async revokeByLicenseId(licenseId) {
      calls.mutations.push('revokeByLicenseId');
      if (opts.revokeFails) throw new Error('licences down (revoke)');
      calls.revoked.push(licenseId);
    },
  };
  return { client, calls };
}

/** A billing fake holding one tenant's terms; GET reads back what PUT stored. */
function makeBilling() {
  const stored = new Map<string, TenantTerms>();
  const puts: Array<{ tenantId: string; terms: TenantTerms }> = [];
  const view = (tenantId: string, changed: string[]): BillingTermsView => {
    const t = stored.get(tenantId);
    return {
      billingMode: t ? 'byo_markup_only' : 'standard_markup',
      platformFeeUsd: t?.platformFeeUsd ?? 0,
      seatFeeUsd: t?.seatFeeUsd ?? 0,
      markupPct: t?.markupPct ?? 0,
      fullyConfigured: Boolean(t),
      changed,
    };
  };
  const client: BillingAdminClient = {
    async actorCosts() {
      return [];
    },
    async invoicePreview() {
      throw new Error('unused');
    },
    async invoices() {
      return [];
    },
    async invoice() {
      throw new Error('unused');
    },
    async commercialTerms(tenantId) {
      return view(tenantId, []);
    },
    async putCommercialTerms(tenantId, terms) {
      puts.push({ tenantId, terms });
      stored.set(tenantId, terms);
      return view(tenantId, ['platform_fee', 'seat_fee', 'byo_markup']);
    },
    async moneyBudgetStatus(tenantId) {
      return tenantId === GRANT_TENANT
        ? { amount: 100, currency: 'EUR', consumed: 12.5, remaining: 87.5, thresholdsCrossed: [] }
        : null;
    },
  };
  return { client, puts };
}

const CLEANUP_SQL = `
  DELETE FROM audit_log WHERE actor_id = '${ADMIN_ID}';
  DELETE FROM tenant_llm_settings WHERE tenant_id = '${GRANT_TENANT}';
  DELETE FROM tenant_llm_budgets WHERE tenant_id = '${GRANT_TENANT}';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'pb-%');
  DELETE FROM tenants WHERE slug LIKE 'pb-%' OR id = '${GRANT_TENANT}';
`;

beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  llm.openaiBaseUrl = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setBillingAdminForTests(undefined);
  __setInferenceLicencesForTests(undefined);
  __setInferenceFetchForTests(undefined);
  lic.adminBaseUrl = was.base;
  lic.sa.tokenUrl = was.token;
  lic.issuanceEnabled = was.issuance;
  llm.openaiBaseUrl = was.ir;
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

const TERMS: TenantTerms = { platformFeeUsd: 250, seatFeeUsd: 12.5, markupPct: 20 };

test('create writes the billing terms EXACTLY ONCE, and a replay of the same terms writes nothing', async () => {
  const licences = makeLicences();
  const billing = makeBilling();
  __setLicensesAdminForTests(licences.client);
  __setBillingAdminForTests(billing.client);
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Terms', planCode: 'byo', terms: TERMS });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; terms?: string };
    expect(body.terms).toBe('written');
    expect(billing.puts).toEqual([{ tenantId: body.tenant.id, terms: TERMS }]);

    // The replay — a re-saved form, a retried request: billing already says this, so no PUT.
    expect((await writeTenantTerms(body.tenant.id, TERMS)).status).toBe('unchanged');
    const patched = await call('PATCH', `/api/tenants/${body.tenant.id}`, { terms: TERMS });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { termsStatus: string }).termsStatus).toBe('unchanged');
    expect(billing.puts.length).toBe(1);

    // A real change is one more PUT, with exactly the new values.
    const changed = { ...TERMS, markupPct: 0 };
    await call('PATCH', `/api/tenants/${body.tenant.id}`, { terms: changed });
    expect(billing.puts).toEqual([
      { tenantId: body.tenant.id, terms: TERMS },
      { tenantId: body.tenant.id, terms: changed },
    ]);
  } finally {
    __setLicensesAdminForTests(undefined);
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('the plan FIXES the BYO posture: byo → byo_required (no byoMode needed); a contradiction is 422', async () => {
  const licences = makeLicences();
  __setLicensesAdminForTests(licences.client);
  try {
    const ok = await call('POST', '/api/tenants', { name: 'PB Byo', planCode: 'byo' });
    expect(ok.status).toBe(201);
    const { tenant } = (await ok.json()) as { tenant: { id: string } };
    expect(licences.calls.byo).toEqual([{ tenantId: tenant.id, mode: 'byo_required' }]);

    const bad = await call('POST', '/api/tenants', { name: 'PB Bad', planCode: 'byo', byoMode: 'local_allowed' });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe('byo_mode_fixed_by_plan');
    expect(await db.select().from(tenants).where(eq(tenants.slug, 'pb-bad'))).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('a local-llm create provisions the tenant’s OWN inference-router licence, smoke-tests it, stores it encrypted', async () => {
  const licences = makeLicences();
  const ir = makeLicences();
  const smokes: Array<{ url: string; auth: string; model: string }> = [];
  __setLicensesAdminForTests(licences.client);
  __setInferenceLicencesForTests(ir.client);
  // An ENFORCING router: only a minted token (`tok-…`) is vouched for; anything else is 401.
  __setInferenceFetchForTests(async (url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    smokes.push({ url, auth: h.authorization ?? '', model: JSON.parse(String(init?.body)).model });
    return new Response('{}', { status: (h.authorization ?? '').startsWith('Bearer tok-') ? 200 : 401 });
  });
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Local', planCode: 'local-llm' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; inferenceError?: string };
    expect(body.inferenceError).toBeUndefined();
    expect(licences.calls.byo).toEqual([{ tenantId: body.tenant.id, mode: 'local_allowed' }]);
    // The IR licence: the tenant's synthetic holder, on the inference-router client.
    expect(ir.calls.minted).toEqual([
      { subject: `cp-tenant:${body.tenant.id}:a`, tenantId: body.tenant.id, terms: { planCode: 'standard' } },
    ]);
    const [row] = await db
      .select({ enc: tenants.inference_token_encrypted, licenceId: tenants.inference_licence_id })
      .from(tenants)
      .where(eq(tenants.id, body.tenant.id));
    const token = tryDecryptSecret(row!.enc);
    expect(token).toMatch(/^tok-/);
    expect(row!.enc).not.toContain(token!); // encrypted at rest, never the plain token
    // The negative control first (a random licence-shaped bearer, refused), then the tenant's token.
    expect(smokes).toHaveLength(2);
    expect(smokes[0]!.auth).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(smokes[1]).toEqual({ url: `${llm.openaiBaseUrl}/chat/completions`, auth: `Bearer ${token}`, model: 'local-llm' });
  } finally {
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('a failed smoke stores NO token AND revokes the licence it just minted (nothing live is orphaned)', async () => {
  const licences = makeLicences();
  const ir = makeLicences();
  __setLicensesAdminForTests(licences.client);
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(async () => new Response('nope', { status: 401 }));
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Smoke', planCode: 'local-llm' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; inferenceError?: string };
    expect(body.inferenceError).toBe('inference_smoke_failed');
    const [row] = await db
      .select({ enc: tenants.inference_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, body.tenant.id));
    expect(row!.enc).toBeNull();
    // ⛔ The minted licence is revoked by id, so a retry mints a fresh one instead of piling another
    // live token onto it.
    expect(ir.calls.minted).toHaveLength(1);
    expect(ir.calls.revoked).toEqual(['00000000-0000-4000-8000-0000b0b0c001']);
  } finally {
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('a router that is NOT enforcing (accepts a bogus token) fails the smoke — nothing is stored', async () => {
  __setLicensesAdminForTests(makeLicences().client);
  const ir = makeLicences();
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(async () => new Response('{}', { status: 200 })); // answers ANY bearer
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Lax', planCode: 'local-llm' });
    const body = (await res.json()) as { tenant: { id: string }; inferenceError?: string };
    expect(body.inferenceError).toBe('inference_router_not_enforcing');
    const [row] = await db
      .select({ enc: tenants.inference_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, body.tenant.id));
    expect(row!.enc).toBeNull();
    expect(ir.calls.revoked).toEqual(['00000000-0000-4000-8000-0000b0b0c001']);
  } finally {
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('a failed smoke whose revoke ALSO fails queues the licence in licence_revoke_pending', async () => {
  __setLicensesAdminForTests(makeLicences().client);
  const ir = makeLicences(undefined, { revokeFails: true });
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(async () => new Response('nope', { status: 503 }));
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Orphan', planCode: 'local-llm' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; inferenceError?: string };
    expect(body.inferenceError).toBe('inference_smoke_failed');
    const [row] = await db
      .select({ enc: tenants.inference_token_encrypted, pending: tenants.licence_revoke_pending })
      .from(tenants)
      .where(eq(tenants.id, body.tenant.id));
    expect(row!.enc).toBeNull();
    expect(row!.pending).toEqual(['00000000-0000-4000-8000-0000b0b0c001']);
  } finally {
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('the welcome-budget grant route is GONE, and the budget read comes from billing, not tenant_llm_budgets', async () => {
  expect(router.match('POST', `/api/tenants/${GRANT_TENANT}/budget`)).toBeNull();
  await db.insert(tenants).values({ id: GRANT_TENANT, name: 'PB Grant', slug: 'pb-grant' });
  await db.insert(tenantLlmBudgets).values({ tenant_id: GRANT_TENANT, or_key_hash: 'h1', limit_usd: '5' });
  const billing = makeBilling();
  __setBillingAdminForTests(billing.client);
  try {
    const res = await call('GET', `/api/tenants/${GRANT_TENANT}/budget`, undefined, {
      'X-Active-Tenant-Id': GRANT_TENANT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budget: Record<string, unknown> | null; budgetState: string };
    expect(body.budgetState).toBe('ok');
    expect(body.budget).toEqual({ amount: 100, currency: 'EUR', consumed: 12.5, remaining: 87.5, thresholdsCrossed: [] });
    expect(JSON.stringify(body)).not.toContain('limitUsd'); // not the $5 OpenRouter grant
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('the plan-migration DRY RUN writes nothing — not to CP, not to licences — and plans the right steps', async () => {
  await db.insert(tenants).values([
    // One of the owner's local-llm tenants (CP Demo) may already exist from the seed; use our own.
    { id: '00000000-0000-4000-8000-0000b0b0d001', name: 'PB Customer', slug: 'pb-customer', plan_code: 'standard' },
  ]);
  const licences = makeLicences([plan('standard'), plan('tenant-pooled')]);
  __setLicensesAdminForTests(licences.client);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'byo'; // the default has been moved off `standard` (see the retire_blocked test)
  const snapshot = () =>
    db
      .select()
      .from(tenants)
      .where(like(tenants.slug, 'pb-%'))
      .then((r) => JSON.stringify(r));
  try {
    const before = await snapshot();
    const steps = await planTenantMigration();
    expect(licences.calls.mutations).toEqual([]);
    expect(await snapshot()).toBe(before);
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('create_plan'); // local-llm and byo are missing in this catalogue
    expect(steps).toContainEqual({
      kind: 'change_plan',
      tenantId: '00000000-0000-4000-8000-0000b0b0d001',
      name: 'PB Customer',
      from: 'standard',
      to: 'byo',
    });
    expect(steps.filter((s) => s.kind === 'retire_plan').map((s) => (s as { code: string }).code)).toEqual([
      'standard',
      'tenant-pooled',
    ]);
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
    await db.delete(tenants).where(inArray(tenants.id, ['00000000-0000-4000-8000-0000b0b0d001']));
  }
}, 30_000);

// ---- applyTenantMigration (the --apply half) ------------------------------------------------------
//
// Driven with hand-built steps for this file's own tenants, so the seeded estate (CP Demo …0001 is one
// of the owner's local-llm tenants) is never touched; the PLANNER is asserted only for those tenants.

const T_LOCAL = '00000000-0000-4000-8000-0000b0b0d101';
const T_BYO = '00000000-0000-4000-8000-0000b0b0d102';
const STANDARD = plan('standard');

async function seedPlanTenant(id: string, slug: string) {
  await db.insert(tenants).values({ id, name: slug, slug, plan_code: 'standard' });
}

test('apply: a SMOKE failure skips that tenant’s plan change and posture, and the plans are NOT retired', async () => {
  await seedPlanTenant(T_LOCAL, 'pb-apply-local');
  const licences = makeLicences([STANDARD, plan('local-llm'), plan('byo')]);
  __setLicensesAdminForTests(licences.client);
  __setInferenceLicencesForTests(makeLicences().client);
  __setInferenceFetchForTests(async () => new Response('nope', { status: 401 })); // refuses everything
  try {
    const steps: MigrationStep[] = [
      { kind: 'provision_inference', tenantId: T_LOCAL, name: 'pb-apply-local' },
      { kind: 'change_plan', tenantId: T_LOCAL, name: 'pb-apply-local', from: 'standard', to: 'local-llm' },
      { kind: 'set_posture', tenantId: T_LOCAL, name: 'pb-apply-local', from: 'byo_required', to: 'local_allowed' },
      { kind: 'retire_plan', code: 'standard', planId: STANDARD.id },
    ];
    const results = await applyTenantMigration(steps, 'test');
    expect(results.map((r) => [r.step.kind, r.ok])).toEqual([
      ['provision_inference', false],
      ['change_plan', false],
      ['set_posture', false],
      ['retire_plan', false],
    ]);
    expect(licences.calls.mutations).not.toContain('updatePlan');
    expect(licences.calls.mutations).not.toContain('setTenantByoMode');
    const [row] = await db.select({ plan: tenants.plan_code }).from(tenants).where(eq(tenants.id, T_LOCAL));
    expect(row!.plan).toBe('standard'); // never moved onto local-llm without a credential
  } finally {
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('apply: a POSTURE failure is a failed tenant — no retire — and a RE-RUN plans the posture again, then retires', async () => {
  await seedPlanTenant(T_BYO, 'pb-apply-byo');
  const opts = { byoFails: true };
  const licences = makeLicences([STANDARD, plan('local-llm'), plan('byo')], opts);
  __setLicensesAdminForTests(licences.client);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'byo'; // the configured default must not be the plan being retired (item 5)
  try {
    const first = await applyTenantMigration(
      [
        { kind: 'change_plan', tenantId: T_BYO, name: 'pb-apply-byo', from: 'standard', to: 'byo' },
        { kind: 'set_posture', tenantId: T_BYO, name: 'pb-apply-byo', from: 'local_allowed', to: 'byo_required' },
        { kind: 'retire_plan', code: 'standard', planId: STANDARD.id },
      ],
      'test',
    );
    expect(first.map((r) => [r.step.kind, r.ok])).toEqual([
      ['change_plan', true],
      ['set_posture', false],
      ['retire_plan', false],
    ]);
    expect(licences.calls.mutations).not.toContain('updatePlan');

    // ⛔ THE RE-RUN. The plan already says `byo` (from == to), but the posture never landed: the
    // planner must still plan it, from the LIVE posture — not plan nothing and retire `standard`.
    const replanned = (await planTenantMigration()).filter((st) => 'tenantId' in st && st.tenantId === T_BYO);
    expect(replanned).toEqual([
      { kind: 'set_posture', tenantId: T_BYO, name: 'pb-apply-byo', from: 'local_allowed', to: 'byo_required' },
    ]);

    // Licences recovers: the posture lands and only now is `standard` retired.
    opts.byoFails = false;
    const second = await applyTenantMigration(
      [...replanned, { kind: 'retire_plan', code: 'standard', planId: STANDARD.id }],
      'test',
    );
    expect(second.every((r) => r.ok)).toBe(true);
    expect(licences.calls.byo).toEqual([{ tenantId: T_BYO, mode: 'byo_required' }]);
    expect(licences.calls.mutations.filter((m) => m === 'updatePlan')).toHaveLength(1);
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

// ---- the configured default plan (LICENSE_PLAN_CODE) is never retired out from under createTenant --

test('the planner REFUSES to retire the configured default plan, and says what to change', async () => {
  __setLicensesAdminForTests(makeLicences([plan('standard'), plan('tenant-pooled'), plan('local-llm'), plan('byo')]).client);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'standard';
  try {
    const steps = await planTenantMigration();
    const retire = steps.filter((st) => st.kind === 'retire_plan' || st.kind === 'retire_blocked');
    expect(retire.map((st) => [st.kind, (st as { code: string }).code])).toEqual([
      ['retire_blocked', 'standard'],
      ['retire_plan', 'tenant-pooled'],
    ]);
    expect((retire[0] as { reason: string }).reason).toContain('LICENSE_PLAN_CODE=byo');
    const [result] = await applyTenantMigration([retire[0]!], 'test');
    expect(result!.ok).toBe(false);
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('createTenant REFUSES a retired default plan (422 plan_retired) — no tenant lands on it', async () => {
  const licences = makeLicences([plan('standard', true), plan('byo')]);
  __setLicensesAdminForTests(licences.client);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'standard';
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Default', byoMode: 'local_allowed' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('plan_retired');
    expect(licences.calls.mutations).toEqual([]);
    expect(await db.select().from(tenants).where(eq(tenants.slug, 'pb-default'))).toEqual([]);
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

// ---- prepaid-credit top-up (billing PR #267) + the standard rate card -----------------------------

const TOPUP_TENANT = '00000000-0000-4000-8000-0000b0b0e101';
const tenantAdmin: User = {
  id: '00000000-0000-4000-8000-0000b0b0e1a1',
  email: 'pb.ta@test.dev',
  name: 'PB TA',
  roles: ['tenant_admin'],
  tenantId: TOPUP_TENANT,
};
const member: User = { ...tenantAdmin, id: '00000000-0000-4000-8000-0000b0b0e1a2', roles: ['member'] };

function makeTopupBilling(opts: { statusMissing?: boolean; topupMissing?: boolean } = {}) {
  const base = makeBilling();
  const topups: Array<{ tenantId: string; amount: number; currency: string; idempotencyKey: string }> = [];
  const seen = new Set<string>();
  const client: BillingAdminClient = {
    ...base.client,
    async moneyBudgetStatus() {
      return opts.statusMissing ? null : { amount: 100, currency: 'EUR', consumed: 40, remaining: 60, thresholdsCrossed: [] };
    },
    async moneyTopup(tenantId, input) {
      if (opts.topupMissing) {
        const { BillingTopupUnavailableError } = await import('../src/services/billing-admin');
        throw new BillingTopupUnavailableError();
      }
      const replayed = seen.has(input.idempotencyKey);
      seen.add(input.idempotencyKey);
      if (!replayed) topups.push({ tenantId, ...input });
      return {
        replayed,
        amount: input.amount,
        currency: input.currency,
        credit: { grantedUsd: 10 + input.amount, drawnUsd: 4, remainingUsd: 6 + input.amount, settledThrough: null },
      };
    },
    async rateCard() {
      return { currency: 'USD', platformFeeUsd: 5000, seatFeeUsd: 25, markupPct: 20, byoMarkupPct: 20, source: 'settings_default' };
    },
  };
  return { client, topups };
}

async function asUser<T>(u: User, fn: () => Promise<T>): Promise<T> {
  __setAuthOverridesForTests({ validateAuth: async () => u });
  try {
    return await fn();
  } finally {
    __setAuthOverridesForTests({ validateAuth: async () => admin });
  }
}

test('top-up: a tenant_admin buys USD credit — the amount and the idempotency key reach billing ONCE', async () => {
  await db.insert(tenants).values({ id: TOPUP_TENANT, name: 'PB Topup', slug: 'pb-topup' });
  const b = makeTopupBilling();
  __setBillingAdminForTests(b.client);
  try {
    const key = 'click-0001-abcdef';
    const res = await asUser(tenantAdmin, () =>
      call('POST', `/api/tenants/${TOPUP_TENANT}/budget/topup`, { amount: 50, idempotencyKey: key }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credit: { remainingUsd: number }; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.credit.remainingUsd).toBe(56);
    expect(b.topups).toEqual([{ tenantId: TOPUP_TENANT, amount: 50, currency: 'USD', idempotencyKey: key }]);
    // The same click retried: billing replays it, nothing is charged twice.
    const again = await asUser(tenantAdmin, () =>
      call('POST', `/api/tenants/${TOPUP_TENANT}/budget/topup`, { amount: 50, idempotencyKey: key }),
    );
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(b.topups).toHaveLength(1);
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('top-up is tenant_admin-only: a member is refused (403) and nothing reaches billing', async () => {
  await db.insert(tenants).values({ id: TOPUP_TENANT, name: 'PB Topup', slug: 'pb-topup' });
  const b = makeTopupBilling();
  __setBillingAdminForTests(b.client);
  try {
    const res = await asUser(member, () =>
      call('POST', `/api/tenants/${TOPUP_TENANT}/budget/topup`, { amount: 50, idempotencyKey: 'click-0002-abcdef' }),
    );
    expect(res.status).toBe(403);
    expect(b.topups).toEqual([]);
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('top-up needs NO money budget: a tenant without one still buys credit', async () => {
  await db.insert(tenants).values({ id: TOPUP_TENANT, name: 'PB Topup', slug: 'pb-topup' });
  const b = makeTopupBilling({ statusMissing: true });
  __setBillingAdminForTests(b.client);
  try {
    const res = await asUser(tenantAdmin, () =>
      call('POST', `/api/tenants/${TOPUP_TENANT}/budget/topup`, { amount: 5, idempotencyKey: 'click-0003-abcdef' }),
    );
    expect(res.status).toBe(200);
    expect(b.topups).toHaveLength(1);
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('top-up when the top-up route answers 404 (flag off) → 409 billing_topup_unavailable', async () => {
  await db.insert(tenants).values({ id: TOPUP_TENANT, name: 'PB Topup', slug: 'pb-topup' });
  __setBillingAdminForTests(makeTopupBilling({ topupMissing: true }).client);
  try {
    const res = await asUser(tenantAdmin, () =>
      call('POST', `/api/tenants/${TOPUP_TENANT}/budget/topup`, { amount: 5, idempotencyKey: 'click-0004-abcdef' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('billing_topup_unavailable');
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test("a tenant_admin of tenant A cannot top up tenant B (403) — nothing reaches billing", async () => {
  const OTHER = '00000000-0000-4000-8000-0000b0b0e102';
  await db.insert(tenants).values([
    { id: TOPUP_TENANT, name: 'PB Topup', slug: 'pb-topup' },
    { id: OTHER, name: 'PB Other', slug: 'pb-topup-other' },
  ]);
  const b = makeTopupBilling();
  __setBillingAdminForTests(b.client);
  try {
    const res = await asUser(tenantAdmin, () =>
      call('POST', `/api/tenants/${OTHER}/budget/topup`, { amount: 5, idempotencyKey: 'click-0005-abcdef' }),
    );
    expect(res.status).toBe(403);
    expect(b.topups).toEqual([]);
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

test('rate card: the standard rate card is served to the terms forms (super_admin)', async () => {
  __setBillingAdminForTests(makeTopupBilling().client);
  try {
    const res = await call('GET', '/api/platform/rate-card');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rateCard: { byoMarkupPct: number; platformFeeUsd: number } }).rateCard).toMatchObject({
      platformFeeUsd: 5000,
      byoMarkupPct: 20,
    });
    const denied = await asUser(tenantAdmin, () => call('GET', '/api/platform/rate-card'));
    expect(denied.status).toBe(403);
  } finally {
    __setBillingAdminForTests(undefined);
  }
}, 30_000);

// ---- early access: a new workspace defaults to the platform's local model ---------------------------
//
// Before: POST /api/tenants with no plan fell back to LICENSE_PLAN_CODE, which prod sets to `byo` →
// `byo_required`, so a new organisation had NO LLM until it brought its own key. Now the create route
// defaults to NEW_TENANT_PLAN (local-llm). The deployment default stays the fallback for EXISTING
// NULL rows, so the change cannot silently re-plan a tenant that already exists.

const T_OLD_BYO = '00000000-0000-4000-8000-0000b0b0ea01'; // plan_code 'byo', explicit
const T_OLD_NULL = '00000000-0000-4000-8000-0000b0b0ea02'; // plan_code NULL → reads as LICENSE_PLAN_CODE

/** An ENFORCING router fake: only a minted token (`tok-…`) is vouched for. */
const enforcingRouter = async (_url: string, init?: RequestInit) => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return new Response('{}', { status: (h.authorization ?? '').startsWith('Bearer tok-') ? 200 : 401 });
};

test('early access: a workspace created with NO plan chosen gets local-llm (even with LICENSE_PLAN_CODE=byo)', async () => {
  const licences = makeLicences();
  const ir = makeLicences();
  __setLicensesAdminForTests(licences.client);
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(enforcingRouter);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'byo'; // prod's deployment default
  try {
    const res = await call('POST', '/api/tenants', { name: 'PB Early Access' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; inferenceError?: string };
    expect(body.inferenceError).toBeUndefined();
    const [row] = await db
      .select({ plan: tenants.plan_code, enc: tenants.inference_token_encrypted })
      .from(tenants)
      .where(eq(tenants.id, body.tenant.id));
    // Written to the row, not left NULL (a NULL would follow LICENSE_PLAN_CODE later).
    expect(row!.plan).toBe('local-llm');
    expect(licences.calls.byo).toEqual([{ tenantId: body.tenant.id, mode: 'local_allowed' }]);
    // …and it got its own inference-router credential, so its LLM calls work on day one.
    expect(ir.calls.minted.map((c) => c.subject)).toEqual([`cp-tenant:${body.tenant.id}:a`]);
    expect(tryDecryptSecret(row!.enc)).toMatch(/^tok-/);

    // An explicit choice still wins.
    const byo = await call('POST', '/api/tenants', { name: 'PB Early Byo', planCode: 'byo' });
    expect(byo.status).toBe(201);
    const byoId = ((await byo.json()) as { tenant: { id: string } }).tenant.id;
    const [byoRow] = await db.select({ plan: tenants.plan_code }).from(tenants).where(eq(tenants.id, byoId));
    expect(byoRow!.plan).toBe('byo');
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);

test('early access: EXISTING byo tenants are unchanged — explicit byo and NULL (deployment default) alike', async () => {
  await db.insert(tenants).values([
    { id: T_OLD_BYO, name: 'PB Old Byo', slug: 'pb-old-byo', plan_code: 'byo' },
    { id: T_OLD_NULL, name: 'PB Old Null', slug: 'pb-old-null', plan_code: null },
  ]);
  const licences = makeLicences();
  const ir = makeLicences();
  __setLicensesAdminForTests(licences.client);
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(enforcingRouter);
  const lic2 = config.license as { planCode: string };
  const defaultWas = lic2.planCode;
  lic2.planCode = 'byo';
  try {
    // A new default-plan workspace is created next to them…
    expect((await call('POST', '/api/tenants', { name: 'PB Early Next' })).status).toBe(201);

    // …and neither existing row moved: not in the DB, not in what the platform screen reads.
    const rows = await db
      .select({ id: tenants.id, plan: tenants.plan_code })
      .from(tenants)
      .where(inArray(tenants.id, [T_OLD_BYO, T_OLD_NULL]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.plan]))).toEqual({ [T_OLD_BYO]: 'byo', [T_OLD_NULL]: null });
    for (const id of [T_OLD_BYO, T_OLD_NULL]) {
      const m = router.match('GET', '/api/admin/tenants')!;
      const res = await m.handler(new Request(`http://t/api/admin/tenants?id=${id}`), ...m.params);
      expect(res.status).toBe(200);
      const list = (await res.json()) as { tenants: Array<{ id: string; planCode: string }> };
      expect(list.tenants.map((t) => [t.id, t.planCode])).toEqual([[id, 'byo']]);
    }
    // No licences posture write and no IR licence for either existing tenant.
    const old = (c: { tenantId: string }) => c.tenantId === T_OLD_BYO || c.tenantId === T_OLD_NULL;
    expect(licences.calls.byo.filter(old)).toEqual([]);
    expect(ir.calls.minted.filter(old)).toEqual([]);
  } finally {
    lic2.planCode = defaultWas;
    __setLicensesAdminForTests(undefined);
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
  }
}, 30_000);
