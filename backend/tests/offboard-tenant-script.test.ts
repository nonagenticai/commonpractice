// tests/offboard-tenant-script.test.ts — scripts/offboard-tenant.ts does EXACTLY what
// POST /api/tenants/:id/offboard does, because both run services/offboarding.ts `offboardTenantFully`.
//
// ⛔ The old script was a hand copy: DB writes + the tenant licence only. Against a PROD-SHAPED
// tenant (licence stored on the synthetic `cp-tenant:<id>:a` subject, two live members each holding
// an active seat, a pending invite, an enabled IdP) it left the invite live, the IdP enabled, both
// seats billable and the licences-registry tenant active — and it REFUSED the tenant outright,
// because it still believed offboarding deleted Keycloak identities (it no longer does: the portal
// realm is shared with fr). These tests fail against that script and against a route that stops
// sharing the service.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, db, identityProviders, memberEntitlements, tenants, users } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { config } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import { __setLicensesAdminForTests, type LicensesAdminClient } from '../src/services/licenses-admin';
import { __setKeycloakAdminForTests, type KeycloakAdminClient } from '../src/services/keycloak-admin';
import { SYSTEM_TENANT_ID } from '../src/services/license-provisioning';
import { runOffboardScript, SCRIPT_VIA } from '../scripts/offboard-tenant';
import { HttpError } from '../src/utils/http';

const id = (n: string) => `00000000-0000-4000-8000-00000ffb${n.padStart(4, '0')}`;
const T = id('0001');
const SLUG = 'ffb-offboard-script';
const M1 = id('0a01');
const M2 = id('0a02');
const TENANT_LIC = id('0c01');
const SEAT1 = id('0c11');
const SEAT2 = id('0c12');
const ALIAS = 'entra-ffb-script';

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string } };
const lic = config.license as unknown as LicenceCfg;
const was = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled };

let central: { revoked: string[]; archived: string[]; order: string[] };
let kcCalls: string[];

function fakes() {
  central = { revoked: [], archived: [], order: [] };
  kcCalls = [];
  const licences = {
    async revokeByLicenseId(licenseId: string) {
      central.order.push(`revoke:${licenseId}`);
      central.revoked.push(licenseId);
    },
    async revokeByToken() {
      central.order.push('revokeByToken');
    },
    async listSubjectLicences() {
      return [];
    },
    async listTenantLicences() {
      return [];
    },
    async archiveTenant(tenantId: string) {
      central.order.push('archive');
      central.archived.push(tenantId);
    },
    // CP owns this licences tenant, so the archive is allowed (see decideCentralArchive).
    async getTenant(nameOrId: string) {
      return { id: nameOrId, name: 'x', ownerKey: 'commonpractice' };
    },
  } as unknown as LicensesAdminClient;
  // Only the IdP disable may reach Keycloak; any user write would throw here (and be reported).
  const kc = new Proxy(
    {
      async getIdentityProvider(alias: string) {
        kcCalls.push(`getIdp:${alias}`);
        return { alias, enabled: true };
      },
      async updateIdentityProvider(alias: string, rep: { enabled?: boolean }) {
        kcCalls.push(`updateIdp:${alias}:${rep.enabled}`);
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return async () => {
          kcCalls.push(`UNEXPECTED:${prop}`);
          throw new Error(`unexpected Keycloak call ${prop}`);
        };
      },
    },
  ) as unknown as KeycloakAdminClient;
  __setLicensesAdminForTests(licences);
  __setKeycloakAdminForTests(kc);
}

async function cleanup() {
  await db.delete(auditLog).where(eq(auditLog.tenant_id, T));
  await db.delete(tenantInvites).where(eq(tenantInvites.tenant_id, T));
  await db.delete(identityProviders).where(eq(identityProviders.tenant_id, T));
  await db.delete(memberEntitlements).where(eq(memberEntitlements.tenant_id, T));
  await db.delete(users).where(inArray(users.id, [M1, M2]));
  await db.delete(tenants).where(eq(tenants.id, T));
}

beforeEach(async () => {
  await cleanup();
  lic.issuanceEnabled = true;
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  fakes();
  await db.insert(tenants).values({
    id: T,
    name: 'FFB Script',
    slug: SLUG,
    status: 'active',
    licences_name: SLUG,
    license_token_encrypted: encryptSecret(`tok-${TENANT_LIC}`),
    licence_id: TENANT_LIC,
    licence_subject_sub: `cp-tenant:${T}:a`,
  });
  await db.insert(users).values([
    { id: M1, email: 'm1@ffb.test', name: 'M1', tenant_id: T, tenant_role: 'tenant_admin', keycloak_sub: M1 },
    { id: M2, email: 'm2@ffb.test', name: 'M2', tenant_id: T, tenant_role: 'member', keycloak_sub: M2 },
  ]);
  await db.insert(memberEntitlements).values([
    { tenant_id: T, user_id: M1, status: 'active', license_id: SEAT1, token_encrypted: encryptSecret(`tok-${SEAT1}`) },
    { tenant_id: T, user_id: M2, status: 'active', license_id: SEAT2, token_encrypted: encryptSecret(`tok-${SEAT2}`) },
  ]);
  await db.insert(tenantInvites).values({
    tenant_id: T,
    email: 'pending@ffb.test',
    role: 'member',
    token_hash: 'ffb-hash-0123456789',
    expires_at: new Date(Date.now() + 86_400_000),
  });
  await db.insert(identityProviders).values({
    tenant_id: T,
    alias: ALIAS,
    display_name: 'FFB',
    config: { discovery_url: 'https://ffb/.well-known', client_id: 'c', scopes: 'openid', trust_email: true },
  });
}, 30_000);

afterAll(async () => {
  __setLicensesAdminForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  lic.adminBaseUrl = was.base;
  lic.sa.tokenUrl = was.token;
  lic.issuanceEnabled = was.issuance;
  await cleanup();
}, 30_000);

const snapshot = async () => ({
  tenant: (await db.select().from(tenants).where(eq(tenants.id, T)))[0]!,
  users: await db.select({ id: users.id, deletedAt: users.deleted_at }).from(users).where(inArray(users.id, [M1, M2])),
  seats: await db.select({ status: memberEntitlements.status }).from(memberEntitlements).where(eq(memberEntitlements.tenant_id, T)),
  invites: await db.select({ status: tenantInvites.status }).from(tenantInvites).where(eq(tenantInvites.tenant_id, T)),
  idps: await db.select({ enabled: identityProviders.enabled }).from(identityProviders).where(eq(identityProviders.tenant_id, T)),
});

test('dry run (default) writes nothing and calls nothing — even with live members, which it no longer refuses', async () => {
  const before = await snapshot();
  const { plan, result } = await runOffboardScript({ tenantId: T, confirmSlug: SLUG, apply: false });
  expect(result).toBeNull();
  expect(plan).toMatchObject({ liveMembers: 2, pendingInvites: 1, idps: 1, hasLicense: true, status: 'active' });
  expect(await snapshot()).toEqual(before);
  expect(central.order).toEqual([]);
  expect(kcCalls).toEqual([]);
});

test('⛔ --apply on a prod-shaped tenant does what the route does: invites, IdP, licence, BOTH seats, archive LAST, System audit', async () => {
  const { result } = await runOffboardScript({
    tenantId: T,
    confirmSlug: SLUG,
    apply: true,
    reason: 'contract ended',
    operator: 'ops-alice',
  });
  expect(result).not.toBeNull();
  expect(result!).toMatchObject({
    alreadyOffboarded: false,
    usersOffboarded: 2,
    invitesRevoked: 1,
    idpsDisabled: 1,
    seatFailures: [],
    idpDisableFailures: [],
    archiveFailure: null,
    archiveSkipped: null,
  });
  const s = await snapshot();
  expect(s.tenant.offboarded_at).not.toBeNull();
  expect(s.tenant.status).toBe('suspended');
  expect(s.tenant.license_token_encrypted).toBeNull();
  expect(s.users.every((u) => u.deletedAt !== null)).toBe(true);
  expect(s.seats.map((x) => x.status)).toEqual(['revoked', 'revoked']);
  expect(s.invites.map((x) => x.status)).toEqual(['revoked']);
  expect(s.idps.map((x) => x.enabled)).toEqual([false]);
  expect([...central.revoked].sort()).toEqual([TENANT_LIC, SEAT1, SEAT2].sort());
  expect(central.archived).toEqual([T]);
  expect(central.order.at(-1)).toBe('archive'); // the epitaph, after every revoke
  expect(kcCalls).toEqual([`getIdp:${ALIAS}`, `updateIdp:${ALIAS}:false`]); // never a user write

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'tenant.offboard'), eq(auditLog.target_id, T)));
  expect(audits.length).toBe(1);
  expect(audits[0]!.actor_id).toBeNull();
  expect(audits[0]!.tenant_id).toBe(T);
  expect(audits[0]!.result_tone).toBe('ok');
  expect(audits[0]!.metadata).toMatchObject({
    via: SCRIPT_VIA,
    operator: 'ops-alice',
    reason: 'contract ended',
    invitesRevoked: 1,
    idpsDisabled: 1,
    seatRevokeFailed: 0,
    centralArchiveError: null,
  });

  // A re-run is idempotent: nothing new tombstoned, the original timestamp kept.
  const again = await runOffboardScript({ tenantId: T, confirmSlug: SLUG, apply: true });
  expect(again.result).toMatchObject({ alreadyOffboarded: true, usersOffboarded: 0, invitesRevoked: 0 });
  expect(again.result!.offboardedAt.getTime()).toBe(s.tenant.offboarded_at!.getTime());
}, 30_000);

test('the guards run before any write: a wrong confirmSlug → 400 confirm_mismatch; the system tenant → 409 system_tenant', async () => {
  const before = await snapshot();
  const mismatch = await runOffboardScript({ tenantId: T, confirmSlug: 'nope', apply: true }).catch((e) => e);
  expect(mismatch).toBeInstanceOf(HttpError);
  expect((mismatch as HttpError).code).toBe('confirm_mismatch');
  expect(await snapshot()).toEqual(before);
  expect(central.order).toEqual([]);

  await db
    .insert(tenants)
    .values({ id: SYSTEM_TENANT_ID, name: 'Dev User', slug: `u-${SYSTEM_TENANT_ID.replace(/-/g, '')}` })
    .onConflictDoNothing();
  const [sys] = await db.select().from(tenants).where(eq(tenants.id, SYSTEM_TENANT_ID));
  const refused = await runOffboardScript({ tenantId: SYSTEM_TENANT_ID, confirmSlug: sys!.slug, apply: true }).catch((e) => e);
  expect((refused as HttpError).code).toBe('system_tenant');
  const [sysAfter] = await db.select().from(tenants).where(eq(tenants.id, SYSTEM_TENANT_ID));
  expect(sysAfter!.offboarded_at).toBeNull();

  const missing = await runOffboardScript({ tenantId: id('0999'), confirmSlug: 'x', apply: true }).catch((e) => e);
  expect((missing as HttpError).code).toBe('tenant_not_found');
});

test('the route and the script share ONE implementation (source guard: neither may grow its own copy)', async () => {
  const route = await Bun.file(new URL('../src/routes/admin.ts', import.meta.url)).text();
  const script = await Bun.file(new URL('../scripts/offboard-tenant.ts', import.meta.url)).text();
  expect(route.length).toBeGreaterThan(10_000);
  expect(script.length).toBeGreaterThan(1_000);
  const handler = route.slice(route.indexOf('const offboardTenant = route('));
  const body = handler.slice(0, handler.indexOf('\n});\n'));
  expect(body.length).toBeGreaterThan(100);
  for (const src of [body, script]) {
    expect(src).toContain('loadOffboardTarget(');
    expect(src).toContain('assertOffboardConfirmed(');
    expect(src).toContain('offboardTenantFully(');
    // the steps live in the service only
    expect(src).not.toContain('offboardTenantWrites(');
    expect(src).not.toContain('revokeMemberEntitlement(');
    expect(src).not.toContain("'archiveTenant'");
  }
});
