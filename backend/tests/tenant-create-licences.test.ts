// tests/tenant-create-licences.test.ts — POST /api/tenants: CP registers its OWN licences tenant.
//
// The "Netcare" incident, three times over. First (0093): CP inserted its row, THEN licences 409'd
// on the name → a half-created tenant + 502. Then (A2): the fix ADOPTED the existing licences tenant
// `netcare` — fr's customer tenant — tying CP to a tenant fr owns. Then CP suffixed (`-cp`, `-cp-2`…).
// Since licences migration 050 tenant names are unique PER OWNING APP: CP registers the plain slug,
// another app's `netcare` is not a clash, and a 409 `tenant_name_taken` means CP itself already has
// that name. Every central refusal still leaves NO CP row behind.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, like, sql } from 'drizzle-orm';
import { reconcileProvisioning } from '../src/services/tenant-provisioning';
import { db, tenants, auditLog, queryClient } from '../src/db/client';
import { config } from '../src/config';
import {
  __setLicensesAdminForTests,
  LicencesNameConflictError,
  LicencesTenantOwnedByOtherAppError,
  LicensesAdminError,
  type LicensesAdminClient,
  type LicenceTerms,
  type LicencesPlan,
} from '../src/services/licenses-admin';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';
import { __setKeycloakAdminForTests, type KeycloakAdminClient } from '../src/services/keycloak-admin';

// Own id range (marker `c7ad`) and slug prefix `tca-` so cleanup cannot touch another suite's rows.
const ADMIN_ID = '00000000-0000-4000-8000-0000c7ad0001';
/** Gerard's licences tenant `netcare` — the id the adopt path used to take over. */
const LIC_EXISTING_ID = '01a0ef72-0000-7000-8000-0000c7ad00a1';
const LIC_ID = '00000000-0000-4000-8000-0000c7ad0b01';
const SUBJ_ID = '11111111-1111-4111-8111-0000c7ad0b01';

const admin: User = { id: ADMIN_ID, email: 'tca.admin@test.dev', name: 'TCA Admin', roles: ['super_admin'] };

const router = new Router();
registerAdminRoutes(router);

async function post(body: unknown): Promise<Response> {
  const m = router.match('POST', '/api/tenants')!;
  return m.handler(
    new Request('http://t/api/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string } };
const lic = config.license as LicenceCfg;
const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled };

const plan = (code: string, revoked = false): LicencesPlan => ({
  id: `00000000-0000-4000-8000-0000c7ad0${code.length}${revoked ? 'f' : 'e'}0`,
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

/**
 * A licences registry fake, OWNER-SCOPED as licences is since migration 050. `taken`: names CP itself
 * already holds on another of its tenants (PUT → 409 `tenant_name_taken`). `foreign`: names only
 * ANOTHER app holds — invisible to CP's lookups and no clash. `foreignIds`: ids registered to another
 * app (PUT → 409 `tenant_owned_by_other_app`).
 */
function makeLicences(
  opts: {
    taken?: string[];
    foreign?: string[];
    foreignIds?: boolean;
    mintFails?: boolean;
    mintFailsTimes?: number;
    plans?: LicencesPlan[];
  } = {},
) {
  const taken = new Set(opts.taken ?? []);
  const foreign = new Set(opts.foreign ?? []);
  /** The registry's UNIQUE name → id, as this fake's registrations and renames leave it. */
  const names = new Map<string, string>();
  let mintFailures = opts.mintFailsTimes ?? 0;
  const calls = {
    attempted: [] as string[],
    registered: [] as Array<{ tenantId: string; name: string; foreignNameExists: boolean }>,
    byo: [] as Array<{ tenantId: string; mode: string }>,
    minted: [] as Array<{ tenantId: string; terms: LicenceTerms | undefined }>,
    renamed: [] as Array<{ tenantId: string; name: string }>,
    archived: [] as string[],
  };
  const holderOf = (name: string) => (taken.has(name) ? LIC_EXISTING_ID : names.get(name));
  const client: LicensesAdminClient = {
    async getTenant(nameOrId) {
      const id = holderOf(nameOrId);
      return id ? { id, name: nameOrId } : null;
    },
    async ensureTenantRegistered(tenantId, name) {
      calls.attempted.push(name);
      if (opts.foreignIds) throw new LicencesTenantOwnedByOtherAppError(tenantId);
      const holder = holderOf(name);
      if (holder && holder !== tenantId) throw new LicencesNameConflictError(name);
      if (!holder) calls.registered.push({ tenantId, name, foreignNameExists: foreign.has(name) });
      names.set(name, tenantId);
    },
    async renameTenant(tenantId, name) {
      const holder = holderOf(name);
      if (holder && holder !== tenantId) throw new LicencesNameConflictError(name);
      for (const [n, id] of names) if (id === tenantId) names.delete(n);
      names.set(name, tenantId);
      calls.renamed.push({ tenantId, name });
    },
    async archiveTenant(tenantId) {
      calls.archived.push(tenantId);
    },
    async setTenantByoMode(tenantId, mode) {
      calls.byo.push({ tenantId, mode });
    },
    async listPlans() {
      return opts.plans ?? [plan('standard'), plan('pro'), plan('legacy', true)];
    },
    async createLicense(_subject, tenantId, terms) {
      // 400: a non-transient upstream failure, so the retry loop gives up at once.
      if (opts.mintFails || mintFailures-- > 0) {
        throw new LicensesAdminError(400, 'create license failed: HTTP 400');
      }
      calls.minted.push({ tenantId, terms });
      return { licenseId: LIC_ID, subjectId: SUBJ_ID };
    },
    async createToken() {
      return { token: 'tca-token' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  return { client, calls };
}

// ⚠️ The tenant-scoped audit delete is not optional: the first-admin invite test writes an
// `invite.create` row whose actor is NULL (this super_admin has no `users` row), so an actor-only
// delete leaks it — and three suites count `invite.create` rows globally.
const CLEANUP_SQL = `
  DELETE FROM audit_log WHERE actor_id = '${ADMIN_ID}';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'tca-%');
  DELETE FROM tenants WHERE slug LIKE 'tca-%' OR id = '${LIC_EXISTING_ID}';
`;

beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setLicensesAdminForTests(undefined);
  lic.adminBaseUrl = was.base;
  lic.sa.tokenUrl = was.token;
  lic.issuanceEnabled = was.issuance;
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

async function cpRows(slugPrefix: string) {
  return db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      link: tenants.central_link,
      licencesName: tenants.licences_name,
      planCode: tenants.plan_code,
      expiresAt: tenants.licence_expires_at,
    })
    .from(tenants)
    .where(like(tenants.slug, `${slugPrefix}%`));
}

interface Created {
  tenant: { id: string; name: string; slug: string; central_link: string; licences_name: string };
}

test('another app\'s licences tenant with the same name is NOT a clash → 201 under the plain slug, NEW id', async () => {
  const fake = makeLicences({ foreign: ['tca-netcare'] });
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Netcare', byoMode: 'byo_required' });
    expect(res.status).toBe(201);
    const { tenant } = (await res.json()) as Created;
    expect(tenant.name).toBe('TCA Netcare'); // the CP display name is kept
    expect(tenant.slug).toBe('tca-netcare');
    // ⛔ No `-cp` suffix: names are unique per owning app since licences migration 050.
    expect(tenant.licences_name).toBe('tca-netcare');
    expect(tenant.central_link).toBe('registered');
    // ⛔ The adopt path: CP id == the EXISTING licences tenant's id. Never again.
    expect(tenant.id).not.toBe(LIC_EXISTING_ID);
    // Every registration (the create's, then the mint's idempotent pre-register) uses the plain slug.
    expect(new Set(fake.calls.attempted)).toEqual(new Set(['tca-netcare']));
    expect(fake.calls.registered).toEqual([{ tenantId: tenant.id, name: 'tca-netcare', foreignNameExists: true }]);
    // CP's OWN tenant: its posture is CP's to set.
    expect(fake.calls.byo).toEqual([{ tenantId: tenant.id, mode: 'byo_required' }]);
    expect(fake.calls.minted.map((m) => m.tenantId)).toEqual([tenant.id]);

    const [row] = await cpRows('tca-netcare');
    expect(row?.licencesName).toBe('tca-netcare');
    expect(row?.link).toBe('registered');
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

// ⛔ First-admin NAMES are required with the email: the portal realm requires first + last name, so
// an identity minted without them stops a brand-new tenant admin at Keycloak's VERIFY_PROFILE form.
test('firstAdminEmail without first/last name → 422, and NOTHING is created', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    for (const body of [
      { name: 'TCA Nameless', byoMode: 'byo_required', firstAdminEmail: 'boss@tca.test' },
      { name: 'TCA Nameless', byoMode: 'byo_required', firstAdminEmail: 'boss@tca.test', firstAdminFirstName: 'Ann' },
      { name: 'TCA Nameless', byoMode: 'byo_required', firstAdminEmail: 'boss@tca.test', firstAdminLastName: 'Lee' },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(fake.calls.attempted).toEqual([]);
    expect(await cpRows('tca-nameless')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('firstAdminFirstName/LastName reach the first admin\'s realm identity', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  const created: unknown[] = [];
  const noop = async () => {};
  const kc: KeycloakAdminClient = {
    async createRealmUser(input) {
      created.push(input);
      return '00000000-0000-4000-8000-0000c7ad0c01';
    },
    logoutUser: noop,
    executeActionsEmail: noop,
    deleteRealmUser: noop,
    listRealmUsers: async () => [],
    findRealmUserByUsernameOrEmail: async () => null,
    backfillUserEmail: noop,
    getRealmRolesForUsers: async (ids) => new Map(ids.map((i) => [i, [] as string[]])),
    createIdentityProvider: noop,
    getIdentityProvider: async () => null,
    updateIdentityProvider: noop,
    deleteIdentityProvider: noop,
    createIdpMapper: noop,
    listIdpMappers: async () => [],
    deleteIdpMapper: noop,
  };
  __setKeycloakAdminForTests(kc);
  try {
    const res = await post({
      name: 'TCA Named',
      byoMode: 'byo_required',
      firstAdminEmail: 'boss@tca.test',
      firstAdminFirstName: 'Ann',
      firstAdminLastName: 'de Lee',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: unknown; inviteError?: string };
    expect(body.inviteError).toBeUndefined();
    expect(body.invite).not.toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ email: 'boss@tca.test', firstName: 'Ann', lastName: 'de Lee' });
  } finally {
    __setKeycloakAdminForTests(undefined);
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('CP already holds the name → 409 licences_name_unavailable after ONE attempt (no suffix), NO CP row, no posture', async () => {
  const fake = makeLicences({ taken: ['tca-raced'] });
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Raced', byoMode: 'local_allowed' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details: { name: string } };
    expect(body.error).toBe('licences_name_unavailable');
    expect(body.details.name).toBe('tca-raced');
    expect(fake.calls.attempted).toEqual(['tca-raced']);
    expect(fake.calls.byo).toEqual([]);
    expect(await cpRows('tca-raced')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('⛔ the id is registered to ANOTHER app → 502 licences_tenant_owned_by_other_app, no retry, NO CP row', async () => {
  const fake = makeLicences({ foreignIds: true });
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Foreign', byoMode: 'local_allowed' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('licences_tenant_owned_by_other_app');
    expect(fake.calls.attempted).toEqual(['tca-foreign']);
    expect(fake.calls.byo).toEqual([]);
    expect(await cpRows('tca-foreign')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('adoption is gone: `adoptLicencesTenantId` is refused (422), nothing written', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Adopt', byoMode: 'local_allowed', adoptLicencesTenantId: LIC_EXISTING_ID });
    expect(res.status).toBe(422);
    expect(fake.calls.attempted).toEqual([]);
    expect(await cpRows('tca-adopt')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('a new name registers with a fresh id under its slug; plan + expiry stored and minted with', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({
      name: 'TCA Fresh',
      byoMode: 'platform_only',
      maxMembers: 5,
      planCode: 'pro',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(res.status).toBe(201);
    const { tenant } = (await res.json()) as Created;
    expect(tenant.central_link).toBe('registered');
    expect(tenant.licences_name).toBe('tca-fresh');
    expect(fake.calls.registered[0]).toEqual({ tenantId: tenant.id, name: 'tca-fresh', foreignNameExists: false });
    expect(fake.calls.byo).toEqual([{ tenantId: tenant.id, mode: 'platform_only' }]);
    const [row] = await cpRows('tca-fresh');
    expect(row?.planCode).toBe('pro');
    expect(row?.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // ⛔ The licence is minted on the TENANT's plan, not the deployment-wide default.
    expect(fake.calls.minted[0]?.terms?.planCode).toBe('pro');
    expect(fake.calls.minted[0]?.terms?.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');

    const [audit] = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.target_id, tenant.id));
    const meta = audit?.metadata as { licencesName?: string; planCode?: string } | null;
    expect(meta?.licencesName).toBe('tca-fresh');
    expect(meta?.planCode).toBe('pro');
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('an unknown or retired plan → 422 before anything is written', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    const unknown = await post({ name: 'TCA Plan', byoMode: 'local_allowed', planCode: 'nope' });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: string }).error).toBe('plan_unknown');
    const retired = await post({ name: 'TCA Plan', byoMode: 'local_allowed', planCode: 'legacy' });
    expect(retired.status).toBe(422);
    expect(((await retired.json()) as { error: string }).error).toBe('plan_retired');
    expect(fake.calls.attempted).toEqual([]);
    expect(await cpRows('tca-plan')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('⛔ a create that fails at the mint VOIDS its licences registration: the retry gets the same name back', async () => {
  // Without the compensation the failed create's licences tenant kept `tca-retry`, and the retry
  // was refused 409 licences_name_unavailable (CP already holds that name).
  const fake = makeLicences({ mintFailsTimes: 1 });
  __setLicensesAdminForTests(fake.client);
  try {
    const failed = await post({ name: 'TCA Retry', byoMode: 'local_allowed' });
    expect(failed.status).toBe(502);
    const voidedId = fake.calls.registered[0]!.tenantId;
    // renamed out of the way, then archived
    expect(fake.calls.renamed).toEqual([
      { tenantId: voidedId, name: `tca-retry-void-${voidedId.replace(/-/g, '').slice(-8)}` },
    ]);
    expect(fake.calls.archived).toEqual([voidedId]);

    const retry = await post({ name: 'TCA Retry', byoMode: 'local_allowed' });
    expect(retry.status).toBe(201);
    const { tenant } = (await retry.json()) as Created;
    expect(tenant.licences_name).toBe('tca-retry');
    expect(tenant.id).not.toBe(voidedId);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('licence mint failure → 502 licences_unavailable and the CP row is removed again', async () => {
  const fake = makeLicences({ mintFails: true });
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Mint Fail', byoMode: 'local_allowed' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('licences_unavailable');
    expect(fake.calls.registered.length).toBeGreaterThan(0); // the central steps DID run
    expect(await cpRows('tca-mint-fail')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('removed fields are refused: welcomeBudgetUsd → 422', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Budget', byoMode: 'local_allowed', welcomeBudgetUsd: 50 });
    expect(res.status).toBe(422);
    expect(await cpRows('tca-budget')).toEqual([]);
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

// ---- the `licence` step records what was STORED, not "did not throw" --------------------------
//
// ⛔ `ensureTenantLicense` returns without a token on a busy lease (`licence_busy`) and when a
// tenant-level licence already admits the tenant. createTenant and the Retry/tick `runLicence` used
// to record `licence: ok` for both.

async function provisioningOf(tenantId: string) {
  const m = router.match('GET', `/api/tenants/${tenantId}/provisioning`)!;
  const res = await m.handler(new Request(`http://t/api/tenants/${tenantId}/provisioning`), ...m.params);
  return ((await res.json()) as { provisioning: { steps: Record<string, { status: string; code: string | null; nextAttemptAt: string | null }> } }).provisioning;
}
async function retryLicence(tenantId: string) {
  const path = `/api/tenants/${tenantId}/provisioning/licence/retry`;
  const m = router.match('POST', path)!;
  return m.handler(new Request(`http://t${path}`, { method: 'POST' }), ...m.params);
}
const tokenOf = async (id: string) =>
  (await db.select({ t: tenants.license_token_encrypted }).from(tenants).where(eq(tenants.id, id)))[0]?.t ?? null;

/** `makeLicences` plus a switchable tenant-level (bundle) licence for every tenant. */
function withTenantLevel(fake: ReturnType<typeof makeLicences>, state: { on: boolean }) {
  return {
    ...fake.client,
    async getActiveLicense(tenantId: string) {
      if (!state.on) return null;
      return {
        active: true,
        subject_match: true,
        tenant_id: tenantId,
        license_id: '00000000-0000-4000-8000-0000c7ad0b99',
        app: { key: config.license.appKey },
        expires_at: null,
      };
    },
  } as unknown as LicensesAdminClient;
}

test('a minting create records `licence: ok` AND stores the token (control)', async () => {
  const fake = makeLicences();
  __setLicensesAdminForTests(fake.client);
  try {
    const res = await post({ name: 'TCA Lic Ok', byoMode: 'platform_only' });
    expect(res.status).toBe(201);
    const { tenant } = (await res.json()) as Created;
    expect(await tokenOf(tenant.id)).not.toBeNull();
    expect((await provisioningOf(tenant.id)).steps.licence!.status).toBe('ok');
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('⛔ a create where a tenant-level licence already admits the tenant stores NO token → `licence: skipped`, never `ok`', async () => {
  const fake = makeLicences();
  const level = { on: true };
  __setLicensesAdminForTests(withTenantLevel(fake, level));
  try {
    const res = await post({ name: 'TCA Lic Level', byoMode: 'platform_only' });
    expect(res.status).toBe(201);
    const { tenant } = (await res.json()) as Created;
    expect(fake.calls.minted).toEqual([]);
    expect(await tokenOf(tenant.id)).toBeNull();
    expect((await provisioningOf(tenant.id)).steps.licence).toMatchObject({ status: 'skipped', code: 'tenant_level_licence' });
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);

test('⛔ a licence Retry that meets a busy lease → `pending` licence_busy (not ok); the tick then lands it and stores the token', async () => {
  const fake = makeLicences();
  const level = { on: true }; // create without a token (see above), so there is something to retry
  __setLicensesAdminForTests(withTenantLevel(fake, level));
  try {
    const res = await post({ name: 'TCA Lic Busy', byoMode: 'platform_only' });
    const { tenant } = (await res.json()) as Created;
    level.on = false; // the bundle licence went away: CP must mint its own now
    await db
      .update(tenants)
      .set({ licence_op_id: '00000000-0000-4000-8000-0000c7adbeef', licence_op_until: new Date(Date.now() + 60_000) })
      .where(eq(tenants.id, tenant.id));
    const r = await retryLicence(tenant.id);
    expect(r.status).toBe(200);
    expect(await tokenOf(tenant.id)).toBeNull();
    const busy = (await provisioningOf(tenant.id)).steps.licence!;
    expect(busy).toMatchObject({ status: 'pending', code: 'licence_busy' });
    expect(busy.nextAttemptAt).not.toBeNull(); // the tick owns it

    // the lease is released; the step comes due → the reconciler (no actor) finishes it
    await db
      .update(tenants)
      .set({
        licence_op_id: null,
        licence_op_until: null,
        provisioning: sql`jsonb_set(${tenants.provisioning}, '{steps,licence,nextAttemptAt}', to_jsonb(now() - interval '1 second'))`,
      })
      .where(eq(tenants.id, tenant.id));
    const sweep = await reconcileProvisioning();
    expect(sweep.landed).toBeGreaterThanOrEqual(1);
    expect(await tokenOf(tenant.id)).not.toBeNull();
    expect((await provisioningOf(tenant.id)).steps.licence!.status).toBe('ok');
  } finally {
    __setLicensesAdminForTests(undefined);
  }
}, 30_000);
