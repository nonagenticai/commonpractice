// tests/tenant-licence-bundles.test.ts — licences BUNDLES CP ensures on a tenant it owns (0104).
//
// netcare (George 2026-10-14): a FRESH CP tenant, created by a super_admin with its first admin, that
// gets every customer-facing app plus the n8n-node-module apps through licences bundles CP ensures as
// the tenant's owning app. Pinned here:
//   • create with bundles → each bundle ensured ONCE, after CP's own licence, recorded per bundle;
//   • licences 403 / 404 → the tenant STANDS, the bundle is `failed` with licences' own code, and a
//     403 is never retried (a 5xx is);
//   • the repair route is idempotent and adds bundles to what the tenant holds;
//   • the schema refuses malformed / duplicate / too many keys (no hardcoded key list);
//   • the real client reads licences' bodies: 200, 409-with-refused, `{"detail":{"error"}}`, bare 403;
//   • every ensure carries `plans` from LICENCE_BUNDLE_PLANS (default `tenant-pooled,standard`, in
//     that order) — `{}` made licences default to `standard`, refusing the n8n-nodes apps `no_plan`.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, tenants, queryClient } from '../src/db/client';
import { config, DEFAULT_LICENCE_BUNDLE_PLANS, parseLicenceBundlePlans } from '../src/config';
import {
  __setLicensesAdminForTests,
  LicencesBundleError,
  LicensesAdminError,
  LicensesAdminService,
  type BundleEnsureOutcome,
  type LicensesAdminClient,
  type LicencesPlan,
} from '../src/services/licenses-admin';
import { __setBundleSleepForTests, readLicenceBundles } from '../src/services/tenant-licence-bundles';
import {
  claimStep,
  createLicenceBundlesLeaseMs,
  licenceBundlesLeaseMs,
  PROVISIONING_LEASE_MS,
  readProvisioning,
  releaseClaim,
} from '../src/services/tenant-provisioning';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

// Own id marker `b0d1` and slug prefix `tlb-` so cleanup cannot touch another suite's rows.
const ADMIN_ID = '00000000-0000-4000-8000-0000b0d10001';
const admin: User = { id: ADMIN_ID, email: 'tlb.admin@test.dev', name: 'TLB Admin', roles: ['super_admin'] };

const router = new Router();
registerAdminRoutes(router);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path);
  if (!m) return new Response(null, { status: 404 });
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    ...m.params,
  );
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; bundlePlans: string[]; sa: { tokenUrl: string } };
const lic = config.license as LicenceCfg;
const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled, plans: lic.bundlePlans };

const standard: LicencesPlan = {
  id: '00000000-0000-4000-8000-0000b0d100e0',
  code: 'standard',
  name: 'standard',
  description: null,
  durationDays: null,
  rateLimitRpm: null,
  rateLimitBurst: null,
  quotaMonthly: null,
  tokenBudgetMonthly: null,
  revoked: false,
  createdAt: null,
};

/** A licences fake. `answers[bundle]` = a queue of what the NEXT ensures of that bundle answer
 *  (an error to throw or an outcome); empty queue = every app `exists`/`insert`. */
function makeLicences(answers: Record<string, Array<Error | BundleEnsureOutcome>> = {}) {
  const log: string[] = [];
  const ensured: Array<{ tenantId: string; bundle: string; plans: readonly string[] }> = [];
  const client: LicensesAdminClient = {
    async getTenant() {
      return null;
    },
    async ensureTenantRegistered() {
      log.push('register');
    },
    async renameTenant() {},
    async archiveTenant() {},
    async setTenantByoMode() {},
    async listPlans() {
      return [standard];
    },
    async createLicense() {
      log.push('mint');
      return { licenseId: '00000000-0000-4000-8000-0000b0d10b01', subjectId: '11111111-1111-4111-8111-0000b0d10b01' };
    },
    async createToken() {
      return { token: 'tlb-token' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
    async ensureTenantBundle(tenantId, bundle, plans) {
      log.push(`ensure:${bundle}`);
      ensured.push({ tenantId, bundle, plans });
      const next = answers[bundle]?.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      const already = ensured.filter((e) => e.tenantId === tenantId && e.bundle === bundle).length > 1;
      return {
        bundle,
        apps: { [`${bundle}-app`]: { decision: already ? 'exists' : 'insert', licenseId: 'l1', plan: 'standard' } },
        refused: [],
      };
    },
  };
  return { client, log, ensured };
}

const CLEANUP_SQL = `
  DELETE FROM audit_log WHERE actor_id = '${ADMIN_ID}';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'tlb-%');
  DELETE FROM tenants WHERE slug LIKE 'tlb-%';
`;

const sleeps: number[] = [];
beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  lic.bundlePlans = was.plans;
  sleeps.length = 0;
  __setBundleSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setBundleSleepForTests(undefined);
  lic.adminBaseUrl = was.base;
  lic.sa.tokenUrl = was.token;
  lic.issuanceEnabled = was.issuance;
  lic.bundlePlans = was.plans;
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

interface CreateBody {
  tenant: { id: string };
  licenceBundles?: Array<{ bundle: string; status: string; code: string | null; apps: Record<string, string>; attempts: number }>;
  licenceBundlesError?: string;
  provisioning: { steps: Record<string, { status: string; code: string | null }> };
}

async function create(name: string, licenceBundles?: unknown): Promise<Response> {
  return call('POST', '/api/tenants', {
    name,
    byoMode: 'byo_required',
    ...(licenceBundles !== undefined ? { licenceBundles } : {}),
  });
}

test('create with bundles → each ensured once, AFTER CP registered and minted its own licence', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const res = await create('TLB Netcare', ['commonpractice', 'n8n-nodes', 'w2v']);
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateBody;
  expect(body.licenceBundlesError).toBeUndefined();
  expect(body.licenceBundles!.map((b) => [b.bundle, b.status])).toEqual([
    ['commonpractice', 'ok'],
    ['n8n-nodes', 'ok'],
    ['w2v', 'ok'],
  ]);
  // Order: CP's own registration + licence first, then the bundles (key order).
  const firstEnsure = fake.log.findIndex((l) => l.startsWith('ensure:'));
  expect(fake.log.indexOf('register')).toBeLessThan(fake.log.indexOf('mint'));
  expect(fake.log.lastIndexOf('mint')).toBeLessThan(firstEnsure);
  expect(fake.log.slice(firstEnsure)).toEqual(['ensure:commonpractice', 'ensure:n8n-nodes', 'ensure:w2v']);
  expect(fake.ensured.every((e) => e.tenantId === body.tenant.id)).toBe(true);
  expect(body.provisioning.steps.licence_bundles).toMatchObject({ status: 'ok' });
  const stored = (await readLicenceBundles(body.tenant.id))!;
  expect(Object.keys(stored).sort()).toEqual(['commonpractice', 'n8n-nodes', 'w2v']);
  expect(stored['n8n-nodes']).toMatchObject({ status: 'ok', apps: { 'n8n-nodes-app': 'insert' }, attempts: 1 });
  expect(stored['n8n-nodes']!.ensuredAt).not.toBeNull();
});

test('create without bundles → no ensure call, step skipped, nothing stored', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const res = await create('TLB Plain');
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateBody;
  expect(body.licenceBundles).toBeUndefined();
  expect(fake.ensured).toHaveLength(0);
  expect(body.provisioning.steps.licence_bundles).toMatchObject({ status: 'skipped', code: 'no_bundles_requested' });
  expect(await readLicenceBundles(body.tenant.id)).toEqual({});
});

test('licences 403 / 404 → the tenant STANDS, each bundle recorded failed with licences\' code, a 403 is NOT retried', async () => {
  const fake = makeLicences({
    'n8n-nodes': [
      new LicencesBundleError(403, 'tenant_owner_only', 'n8n-nodes', 'ensure bundle failed: HTTP 403 tenant_owner_only'),
    ],
    nope: [new LicencesBundleError(404, 'bundle_not_found', 'nope', 'ensure bundle failed: HTTP 404 bundle_not_found')],
  });
  __setLicensesAdminForTests(fake.client);
  const res = await create('TLB Refused', ['n8n-nodes', 'nope', 'w2v']);
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateBody;
  expect(body.licenceBundlesError).toBe('licence_bundles_failed');
  const by = Object.fromEntries(body.licenceBundles!.map((b) => [b.bundle, b]));
  expect(by['n8n-nodes']).toMatchObject({ status: 'failed', code: 'tenant_owner_only', attempts: 1 });
  expect(by['nope']).toMatchObject({ status: 'failed', code: 'bundle_not_found' });
  expect(by['w2v']).toMatchObject({ status: 'ok' });
  // One call each: a 4xx is final.
  expect(fake.ensured.filter((e) => e.bundle === 'n8n-nodes')).toHaveLength(1);
  expect(sleeps).toHaveLength(0);
  // The tenant row is there, licensed; the step says what failed.
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, body.tenant.id));
  expect(row).toBeDefined();
  const rec = (await readProvisioning(body.tenant.id))!;
  expect(rec.steps.licence_bundles).toMatchObject({ status: 'failed', code: 'licence_bundles_failed' });
  expect(rec.steps.licence_bundles!.message).toContain('n8n-nodes: tenant_owner_only');
  expect(rec.steps.licence_bundles!.message).toContain('nope: bundle_not_found');
});

test('a licences 5xx is retried in the request and lands', async () => {
  const fake = makeLicences({ w2v: [new LicensesAdminError(503, 'licenses admin transport error: boom')] });
  __setLicensesAdminForTests(fake.client);
  const res = await create('TLB Blip', ['w2v']);
  const body = (await res.json()) as CreateBody;
  expect(body.licenceBundles![0]).toMatchObject({ bundle: 'w2v', status: 'ok' });
  expect(fake.ensured).toHaveLength(2);
  expect(sleeps).toHaveLength(1);
});

test('apps refused inside a bundle (licences 409 body) → failed bundle_apps_refused, the ensured apps kept', async () => {
  const fake = makeLicences({
    'n8n-nodes': [
      {
        bundle: 'n8n-nodes',
        apps: { kag: { decision: 'exists', licenseId: 'l2', plan: 'standard' } },
        refused: [{ app: 'metering', reason: 'no_plan' }],
      },
    ],
  });
  __setLicensesAdminForTests(fake.client);
  const body = (await (await create('TLB Partial', ['n8n-nodes'])).json()) as CreateBody;
  expect(body.licenceBundles![0]).toMatchObject({
    status: 'failed',
    code: 'bundle_apps_refused',
    apps: { kag: 'exists' },
  });
  expect(body.licenceBundlesError).toBe('bundle_apps_refused');
  // The per-app refusal is STORED on the bundle, reason and all — not only answered once.
  const stored = (await readLicenceBundles(body.tenant.id))!;
  expect(stored['n8n-nodes']).toMatchObject({
    status: 'failed',
    code: 'bundle_apps_refused',
    apps: { kag: 'exists' },
    refused: [{ app: 'metering', reason: 'no_plan' }],
    ensuredAt: null,
  });
  expect(stored['n8n-nodes']!.message).toContain('metering (no_plan)');
});

test('every ensure sends the configured plan preference (LICENCE_BUNDLE_PLANS), in order', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  // The deployment default reaches licences unchanged: tenant-pooled FIRST, standard as fallback.
  await create('TLB Plans Default', ['n8n-nodes']);
  expect(fake.ensured.map((e) => [...e.plans])).toEqual([['tenant-pooled', 'standard']]);
  // A configured preference replaces it, order kept.
  lic.bundlePlans = ['perpetual', 'standard'];
  fake.ensured.length = 0;
  await create('TLB Plans Configured', ['w2v', 'n8n-nodes']);
  expect(fake.ensured.map((e) => [e.bundle, [...e.plans]])).toEqual([
    ['n8n-nodes', ['perpetual', 'standard']],
    ['w2v', ['perpetual', 'standard']],
  ]);
});

test('LICENCE_BUNDLE_PLANS parsing: default tenant-pooled,standard; order kept; blanks and duplicates dropped', () => {
  expect([...DEFAULT_LICENCE_BUNDLE_PLANS]).toEqual(['tenant-pooled', 'standard']);
  expect(parseLicenceBundlePlans(undefined)).toEqual(['tenant-pooled', 'standard']);
  expect(parseLicenceBundlePlans('')).toEqual(['tenant-pooled', 'standard']);
  expect(parseLicenceBundlePlans(' , ,')).toEqual(['tenant-pooled', 'standard']);
  expect(parseLicenceBundlePlans('standard, tenant-pooled')).toEqual(['standard', 'tenant-pooled']);
  expect(parseLicenceBundlePlans('tenant-pooled,standard,tenant-pooled')).toEqual(['tenant-pooled', 'standard']);
  expect(parseLicenceBundlePlans('perpetual')).toEqual(['perpetual']);
  // A returned default is a copy: mutating it cannot change the next parse.
  parseLicenceBundlePlans(undefined).push('x');
  expect(parseLicenceBundlePlans(undefined)).toEqual(['tenant-pooled', 'standard']);
});

test('licences 403 bundle_not_ensurable_by_caller → recorded failed with that code, never retried', async () => {
  const fake = makeLicences({
    'n8n-nodes': [
      new LicencesBundleError(
        403,
        'bundle_not_ensurable_by_caller',
        'n8n-nodes',
        'ensure bundle failed: HTTP 403 bundle_not_ensurable_by_caller',
      ),
    ],
  });
  __setLicensesAdminForTests(fake.client);
  const body = (await (await create('TLB Not Ensurable', ['n8n-nodes'])).json()) as CreateBody;
  expect(body.licenceBundles![0]).toMatchObject({ status: 'failed', code: 'bundle_not_ensurable_by_caller', attempts: 1 });
  expect(body.licenceBundlesError).toBe('bundle_not_ensurable_by_caller');
  expect(fake.ensured).toHaveLength(1);
  expect(sleeps).toHaveLength(0);
  const stored = (await readLicenceBundles(body.tenant.id))!;
  expect(stored['n8n-nodes']).toMatchObject({ status: 'failed', code: 'bundle_not_ensurable_by_caller' });
});

test('the repair route is idempotent, adds new bundles, and the step Retry re-ensures every recorded one', async () => {
  const fake = makeLicences({
    'n8n-nodes': [new LicencesBundleError(403, 'tenant_not_accessible', 'n8n-nodes', 'HTTP 403 tenant_not_accessible')],
  });
  __setLicensesAdminForTests(fake.client);
  const created = (await (await create('TLB Repair', ['n8n-nodes'])).json()) as CreateBody;
  const id = created.tenant.id;
  expect(created.licenceBundles![0]!.status).toBe('failed');

  const path = `/api/tenants/${id}/licence-bundles`;
  const first = await call('POST', path, { bundles: ['n8n-nodes', 'w2v'] });
  expect(first.status).toBe(200);
  const a = (await first.json()) as {
    results: Array<{ bundle: string; status: string; attempts: number }>;
    licenceBundles: Array<{ bundle: string; status: string }>;
    provisioning: { steps: Record<string, { status: string }> };
  };
  expect(a.results.map((r) => [r.bundle, r.status, r.attempts])).toEqual([
    ['n8n-nodes', 'ok', 2],
    ['w2v', 'ok', 1],
  ]);
  expect(a.licenceBundles.map((b) => b.bundle)).toEqual(['n8n-nodes', 'w2v']);
  expect(a.provisioning.steps.licence_bundles!.status).toBe('ok');

  // Again: same answer, licences reports `exists`, nothing new stored.
  const second = (await (await call('POST', path, { bundles: ['n8n-nodes', 'w2v'] })).json()) as typeof a;
  expect(second.results.map((r) => [r.bundle, r.status])).toEqual([
    ['n8n-nodes', 'ok'],
    ['w2v', 'ok'],
  ]);
  const stored = (await readLicenceBundles(id))!;
  expect(Object.keys(stored).sort()).toEqual(['n8n-nodes', 'w2v']);
  expect(stored.w2v).toMatchObject({ apps: { 'w2v-app': 'exists' }, attempts: 2 });

  // The step's Retry re-ensures EVERY recorded bundle.
  fake.ensured.length = 0;
  const retry = await call('POST', `/api/tenants/${id}/provisioning/licence_bundles/retry`);
  expect(retry.status).toBe(200);
  expect(fake.ensured.map((e) => e.bundle)).toEqual(['n8n-nodes', 'w2v']);

  // The provisioning read carries the bundles.
  const view = (await (await call('GET', `/api/tenants/${id}/provisioning`)).json()) as {
    licenceBundles: Array<{ bundle: string; status: string }>;
  };
  expect(view.licenceBundles.map((b) => [b.bundle, b.status])).toEqual([
    ['n8n-nodes', 'ok'],
    ['w2v', 'ok'],
  ]);
});

test('the repair route: 404 for an unknown tenant, 409 for an offboarded one', async () => {
  __setLicensesAdminForTests(makeLicences().client);
  const missing = await call('POST', '/api/tenants/00000000-0000-4000-8000-0000b0d1ffff/licence-bundles', { bundles: ['w2v'] });
  expect(missing.status).toBe(404);
  const created = (await (await create('TLB Gone')).json()) as CreateBody;
  await db.update(tenants).set({ offboarded_at: new Date() }).where(eq(tenants.id, created.tenant.id));
  const gone = await call('POST', `/api/tenants/${created.tenant.id}/licence-bundles`, { bundles: ['w2v'] });
  expect(gone.status).toBe(409);
  expect(((await gone.json()) as { error: string }).error).toBe('tenant_offboarded');
});

test('the schema refuses malformed, duplicate, empty and too many bundle keys — on create and on repair', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const bad: unknown[] = [
    [],
    ['N8n-Nodes'],
    ['n8n_nodes'],
    ['-w2v'],
    ['w2v-'],
    ['a--b'],
    ['w2v', 'w2v'],
    [''],
    ['x'.repeat(65)],
    Array.from({ length: 21 }, (_, i) => `b${i}`),
    'w2v',
    [42],
  ];
  for (const b of bad) {
    const res = await create('TLB Bad', b);
    expect(res.status).toBe(422);
  }
  const ok = (await (await create('TLB Good')).json()) as CreateBody;
  for (const b of bad) {
    const res = await call('POST', `/api/tenants/${ok.tenant.id}/licence-bundles`, { bundles: b });
    expect(res.status).toBe(422);
  }
  expect((await call('POST', `/api/tenants/${ok.tenant.id}/licence-bundles`, { bundles: ['w2v'], extra: 1 })).status).toBe(422);
  expect(fake.ensured).toHaveLength(0);
  // Licences decides validity: an unknown but well-formed key is SENT (licences answers 404).
  const res = await create('TLB Unknown', ['made-up-bundle', 'book-fulfillment']);
  expect(res.status).toBe(201);
  expect(fake.ensured.map((e) => e.bundle).sort()).toEqual(['book-fulfillment', 'made-up-bundle']);
});

test('without a licences service every bundle is recorded skipped (dev/CI), the create still answers 201', async () => {
  lic.adminBaseUrl = '';
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const body = (await (await create('TLB Local', ['w2v'])).json()) as CreateBody;
  expect(body.licenceBundles![0]).toMatchObject({ status: 'skipped', code: 'licences_not_configured' });
  expect(body.provisioning.steps.licence_bundles).toMatchObject({ status: 'skipped', code: 'licences_not_configured' });
  expect(fake.ensured).toHaveLength(0);
});

// ---- overlapping bundles: `other_bundle` = covered by another bundle, not a failure ----

test('every refused app `other_bundle` → bundle ok, apps listed in coveredByOtherBundle, step ok', async () => {
  const fake = makeLicences({
    knowledge: [
      {
        bundle: 'knowledge',
        apps: { hirag: { decision: 'insert', licenseId: 'l3', plan: 'standard' } },
        refused: [
          { app: 'fr', reason: 'other_bundle' },
          { app: 'kag', reason: 'other_bundle' },
        ],
      },
    ],
    research: [
      {
        bundle: 'research',
        apps: {},
        refused: [
          { app: 'fr', reason: 'other_bundle' },
          { app: 'kag', reason: 'other_bundle' },
          { app: 'n8n', reason: 'other_bundle' },
        ],
      },
    ],
  });
  __setLicensesAdminForTests(fake.client);
  const res = await create('TLB Overlap', ['non-agentic-ai', 'knowledge', 'research']);
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateBody;
  expect(body.licenceBundlesError).toBeUndefined();
  const by = Object.fromEntries(body.licenceBundles!.map((b) => [b.bundle, b]));
  expect(by.knowledge).toMatchObject({ status: 'ok', code: null, refused: [], coveredByOtherBundle: ['fr', 'kag'], apps: { hirag: 'insert' } });
  expect(by.research).toMatchObject({ status: 'ok', code: null, refused: [], coveredByOtherBundle: ['fr', 'kag', 'n8n'] });
  expect(body.provisioning.steps.licence_bundles).toMatchObject({ status: 'ok' });
  const stored = (await readLicenceBundles(body.tenant.id))!;
  expect(stored.research).toMatchObject({ status: 'ok', coveredByOtherBundle: ['fr', 'kag', 'n8n'] });
  expect(stored.research!.ensuredAt).not.toBeNull();
  // Retry is green and stays green: the same overlap answers again, still ok.
  fake.ensured.length = 0;
  const retry = await call('POST', `/api/tenants/${body.tenant.id}/provisioning/licence_bundles/retry`);
  expect(retry.status).toBe(200);
  expect((await readProvisioning(body.tenant.id))!.steps.licence_bundles).toMatchObject({ status: 'ok' });
});

test('`other_bundle` mixed with `no_plan` → bundle failed on the no_plan app only; covered app kept apart', async () => {
  const fake = makeLicences({
    knowledge: [
      {
        bundle: 'knowledge',
        apps: {},
        refused: [
          { app: 'fr', reason: 'other_bundle' },
          { app: 'metering', reason: 'no_plan' },
        ],
      },
    ],
  });
  __setLicensesAdminForTests(fake.client);
  const body = (await (await create('TLB Overlap Mixed', ['knowledge'])).json()) as CreateBody;
  expect(body.licenceBundles![0]).toMatchObject({
    status: 'failed',
    code: 'bundle_apps_refused',
    refused: [{ app: 'metering', reason: 'no_plan' }],
    coveredByOtherBundle: ['fr'],
  });
  expect(body.licenceBundlesError).toBe('bundle_apps_refused');
  expect(body.provisioning.steps.licence_bundles).toMatchObject({ status: 'failed', code: 'bundle_apps_refused' });
  const stored = (await readLicenceBundles(body.tenant.id))!;
  expect(stored.knowledge!.message).toContain('metering (no_plan)');
  expect(stored.knowledge!.message).not.toContain('fr (other_bundle)');
});

// ---- the `licence_bundles` claim: create, Retry and repair never run side by side ----

test('create HOLDS the licence_bundles claim from its INSERT: repair and Retry → 409 before and during the bundles; released after', async () => {
  const fake = makeLicences();
  // Two pause points: CP's own licence mint (the row exists, no bundle has run yet) and the first
  // bundle ensure. Each resolves `entered` and waits for `open`.
  const pause = () => {
    let entered!: () => void;
    let open!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (open = r));
    return { inside, gate, entered: () => entered(), open: () => open() };
  };
  const atMint = pause();
  const atBundle = pause();
  const realMint = fake.client.createLicense.bind(fake.client);
  fake.client.createLicense = async (...args: Parameters<typeof realMint>) => {
    atMint.entered();
    await atMint.gate;
    return realMint(...args);
  };
  const realEnsure = fake.client.ensureTenantBundle!.bind(fake.client);
  let first = true;
  fake.client.ensureTenantBundle = async (tenantId, bundle, plans) => {
    if (first) {
      first = false;
      atBundle.entered();
      await atBundle.gate;
    }
    return realEnsure(tenantId, bundle, plans);
  };
  __setLicensesAdminForTests(fake.client);
  const creating = create('TLB Claim', ['n8n-nodes', 'w2v']);

  const expectBusy = async (id: string) => {
    const repair = await call('POST', `/api/tenants/${id}/licence-bundles`, { bundles: ['w2v'] });
    expect(repair.status).toBe(409);
    expect(((await repair.json()) as { error: string }).error).toBe('provisioning_step_busy');
    const retry = await call('POST', `/api/tenants/${id}/provisioning/licence_bundles/retry`);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: string }).error).toBe('provisioning_step_busy');
  };

  await atMint.inside;
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, 'tlb-claim'));
  const id = row!.id;
  await expectBusy(id); // before any bundle has run: the claim was born with the row
  atMint.open();
  await atBundle.inside;
  await expectBusy(id); // mid-loop
  atBundle.open();
  const res = await creating;
  expect(res.status).toBe(201);
  // Only the create's two ensures ran — the refused callers reached nothing.
  expect(fake.ensured.map((e) => e.bundle)).toEqual(['n8n-nodes', 'w2v']);
  // Released: no live lease left, and the repair now runs.
  const [p] = await db.select({ p: tenants.provisioning }).from(tenants).where(eq(tenants.id, id));
  expect((p!.p as { steps: Record<string, { leaseUntil?: string }> }).steps.licence_bundles!.leaseUntil).toBeUndefined();
  expect((await call('POST', `/api/tenants/${id}/licence-bundles`, { bundles: ['w2v'] })).status).toBe(200);
});

test('repair route: a live licence_bundles claim → 409 provisioning_step_busy, nothing sent; free again once released', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const created = (await (await create('TLB Busy')).json()) as CreateBody;
  const id = created.tenant.id;
  expect(await claimStep(id, 'licence_bundles')).not.toBeNull();
  const busy = await call('POST', `/api/tenants/${id}/licence-bundles`, { bundles: ['w2v'] });
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: string }).error).toBe('provisioning_step_busy');
  expect(fake.ensured).toHaveLength(0);
  // Nothing was recorded for the refused request either.
  expect(await readLicenceBundles(id)).toEqual({});
  await releaseClaim(id, 'licence_bundles');
  expect((await call('POST', `/api/tenants/${id}/licence-bundles`, { bundles: ['w2v'] })).status).toBe(200);
  expect(fake.ensured.map((e) => e.bundle)).toEqual(['w2v']);
});

test('the claim outlives the bundle loop: refreshed per bundle to one worst-case bundle + margin', async () => {
  // One bundle: 3 attempts × (token + ensure) × LICENSE_ADMIN_TIMEOUT_MS + 0.8 s backoff.
  const perBundle = 3 * 2 * config.license.adminTimeoutMs + 800;
  expect(licenceBundlesLeaseMs()).toBe(perBundle + PROVISIONING_LEASE_MS);
  expect(createLicenceBundlesLeaseMs()).toBe(3 * PROVISIONING_LEASE_MS + perBundle + PROVISIONING_LEASE_MS);
  // The lease is pushed forward before EVERY bundle, observed from inside the ensure call.
  const fake = makeLicences();
  const leases: number[] = [];
  const real = fake.client.ensureTenantBundle!.bind(fake.client);
  let tid = '';
  fake.client.ensureTenantBundle = async (tenantId, bundle, plans) => {
    tid = tenantId;
    const [p] = await db.select({ p: tenants.provisioning }).from(tenants).where(eq(tenants.id, tenantId));
    const until = (p!.p as { steps: Record<string, { leaseUntil?: string }> }).steps.licence_bundles!.leaseUntil;
    leases.push(until ? Date.parse(until) - Date.now() : -1);
    return real(tenantId, bundle, plans);
  };
  __setLicensesAdminForTests(fake.client);
  await create('TLB Lease', ['a-one', 'b-two', 'c-three']);
  expect(tid).not.toBe('');
  expect(leases).toHaveLength(3);
  for (const ms of leases) {
    expect(ms).toBeGreaterThan(licenceBundlesLeaseMs() - 30_000);
    expect(ms).toBeLessThanOrEqual(licenceBundlesLeaseMs() + 1_000);
  }
});

// ---- the real client against licences' wire shapes ----

function realClient(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('http://kc.test')) {
      return new Response(JSON.stringify({ access_token: 'sa-token' }), { status: 200 });
    }
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
    return answer(url, init);
  }) as typeof fetch;
  const svc = new LicensesAdminService({
    adminBaseUrl: 'http://licenses.test',
    tokenUrl: 'http://kc.test/token',
    clientId: 'cp',
    clientSecret: 's',
    fetchImpl,
  });
  return { svc, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('real client: 200 → outcome; path, method and body are what licences routes', async () => {
  const { svc, calls } = realClient(() =>
    json(200, {
      tenant_id: 't',
      bundle: 'n8n-nodes',
      budget_currency: null,
      apps: { kag: { decision: 'insert', license_id: 'L', plan: 'standard', metering: 'token_and_quota' } },
      refused: [],
    }),
  );
  const out = await svc.ensureTenantBundle('01a0ef72-31af-7561-936a-b8383b5fb6c8', 'n8n-nodes', ['tenant-pooled', 'standard']);
  expect(out).toEqual({ bundle: 'n8n-nodes', apps: { kag: { decision: 'insert', licenseId: 'L', plan: 'standard' } }, refused: [] });
  expect(calls[0]).toEqual({
    url: 'http://licenses.test/internal/tenants/01a0ef72-31af-7561-936a-b8383b5fb6c8/bundles/n8n-nodes/ensure',
    method: 'POST',
    body: '{"plans":["tenant-pooled","standard"]}',
  });
});

test('real client: 409 with the ensure body → outcome with refused apps', async () => {
  const { svc } = realClient(() =>
    json(409, { tenant_id: 't', bundle: 'w2v', budget_currency: null, apps: {}, refused: [{ app: 'w2v', reason: 'member_licence' }] }),
  );
  const out = await svc.ensureTenantBundle('t', 'w2v', ['standard']);
  expect(out.refused).toEqual([{ app: 'w2v', reason: 'member_licence' }]);
});

test("real client: licences' {detail:{error,message}} → LicencesBundleError with that code", async () => {
  for (const [status, error] of [
    [403, 'tenant_owner_only'],
    [403, 'tenant_not_accessible'],
    [403, 'bundle_not_ensurable_by_caller'],
    [404, 'bundle_not_found'],
    [409, 'tenant_archived'],
  ] as const) {
    const { svc } = realClient(() => json(status, { detail: { error, message: `m-${error}` } }));
    const err = await svc.ensureTenantBundle('t', 'b', ['standard']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicencesBundleError);
    expect((err as LicencesBundleError).code).toBe(error);
    expect((err as LicencesBundleError).status).toBe(status);
    expect((err as LicencesBundleError).message).toContain(`m-${error}`);
  }
});

test('real client: a 403 with a bare string detail (missing role) → licences_forbidden; a 500 → LicensesAdminError 500', async () => {
  const forbidden = realClient(() => json(403, { detail: 'Role required: bundle-provisioner' }));
  const e1 = (await forbidden.svc.ensureTenantBundle('t', 'b', ['standard']).catch((e: unknown) => e)) as LicencesBundleError;
  expect(e1.code).toBe('licences_forbidden');
  expect(e1.message).toContain('Role required');
  const down = realClient(() => new Response('oops', { status: 500 }));
  const e2 = (await down.svc.ensureTenantBundle('t', 'b', ['standard']).catch((e: unknown) => e)) as LicensesAdminError;
  expect(e2).toBeInstanceOf(LicensesAdminError);
  expect(e2.status).toBe(500);
});
