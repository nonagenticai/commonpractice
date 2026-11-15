// tests/tenant-level-licence.test.ts — licences are TENANT-LEVEL (ruling 2026-09-28): a tenant's
// bundle holds ONE licence per (tenant, app) on the service subject `svc:<tenant>:<app>`. These
// cases need NO database: the tenant-level check runs before any row is read or claimed, which is
// itself the property under test (a tenant-licensed member leaves no `pending` claim behind).
// The DB-backed halves live in license-gate.test.ts / license-provisioning.test.ts.
import { test, expect, afterEach } from 'bun:test';
import { config } from '../src/config';
import {
  ensureMemberEntitlement,
  ensureTenantLicense,
  tenantHoldsTenantLevelLicence,
  tenantServiceSubject,
} from '../src/services/license-provisioning';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import type { LicenseIntrospectResponse } from '../src/services/license-client';
import { HttpError } from '../src/utils/http';

const T = '00000000-0000-4000-8000-0000000a7e01';

function setIssuance(on: boolean) {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = on;
}

function fake(active: LicenseIntrospectResponse | null | Error) {
  const minted: string[] = [];
  const asked: Array<string | undefined> = [];
  const client: LicensesAdminClient = {
    async ensureTenantRegistered() {
      minted.push('register');
    },
    async createLicense() {
      minted.push('createLicense');
      return { licenseId: 'x', subjectId: 'y' };
    },
    async createToken() {
      minted.push('createToken');
      return { token: 't' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
    async getActiveLicense(_tenantId, opts) {
      asked.push(opts?.subjectId);
      if (active instanceof Error) throw active;
      return active;
    },
  };
  __setLicensesAdminForTests(client);
  return { minted, asked };
}

const svcLicence = (over: Partial<LicenseIntrospectResponse> = {}): LicenseIntrospectResponse => ({
  active: true,
  tenant_id: T,
  app: { key: 'commonpractice' },
  subject_match: true,
  ...over,
});

afterEach(() => {
  setIssuance(false);
  __setLicensesAdminForTests(undefined);
});

test('the service subject is svc:<tenant>:<app>', () => {
  expect(tenantServiceSubject(T)).toBe(`svc:${T}:commonpractice`);
});

test('the svc subject and the lookup tenant id are canonicalised (lowercase, hyphenated)', async () => {
  const upper = T.toUpperCase();
  expect(tenantServiceSubject(upper)).toBe(`svc:${T}:commonpractice`);
  expect(tenantServiceSubject(T.replace(/-/g, ''))).toBe(`svc:${T}:commonpractice`);
  const { asked } = fake(svcLicence());
  expect(await tenantHoldsTenantLevelLicence(upper)).toBe(true);
  expect(asked).toEqual([`svc:${T}:commonpractice`]);
});

test('onboarding: tenant holds its tenant-level licence → ensureMemberEntitlement mints NOTHING', async () => {
  setIssuance(true);
  const { minted, asked } = fake(svcLicence());
  const out = await ensureMemberEntitlement(T, 'user-1', 'kc-sub-1');
  expect(out).toEqual({ state: 'tenant_licensed' });
  expect(minted).toEqual([]);
  expect(asked).toEqual([`svc:${T}:commonpractice`]);
});

test('onboarding: a forced tenant repair also mints nothing beside a tenant-level licence', async () => {
  setIssuance(true);
  const { minted } = fake(svcLicence());
  await ensureTenantLicense(T, 'kc-sub-1', { force: true });
  expect(minted).toEqual([]);
});

test('only the SVC holder counts: subject_match false / other tenant / other app / inactive → false', async () => {
  for (const r of [
    svcLicence({ subject_match: false }),
    svcLicence({ subject_match: null }),
    svcLicence({ tenant_id: '00000000-0000-4000-8000-0000000a7e02' }),
    svcLicence({ app: { key: 'fr' } }),
    svcLicence({ active: false }),
    null,
  ]) {
    fake(r);
    expect(await tenantHoldsTenantLevelLicence(T)).toBe(false);
  }
  fake(svcLicence());
  expect(await tenantHoldsTenantLevelLicence(T)).toBe(true);
});

test('a client without the lookup (older fake) answers false — the pre-ruling behaviour, not a skip', async () => {
  __setLicensesAdminForTests({
    async ensureTenantRegistered() {},
    async createLicense() {
      return { licenseId: 'x', subjectId: 'y' };
    },
    async createToken() {
      return { token: 't' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  });
  expect(await tenantHoldsTenantLevelLicence(T)).toBe(false);
});

test('a licences outage during the check is a fail-loud 502 on the member path (mints nothing)', async () => {
  setIssuance(true);
  const { minted } = fake(new LicensesAdminError(503, 'licenses down'));
  const err = await ensureMemberEntitlement(T, 'user-1', 'kc-sub-1').catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(502);
  expect(minted).toEqual([]);
});

test('issuance OFF → no lookup at all (the F.2 no-op invariant holds)', async () => {
  setIssuance(false);
  const { asked } = fake(svcLicence());
  expect(await ensureMemberEntitlement(T, 'user-1', 'kc-sub-1')).toEqual({ state: 'disabled' });
  expect(asked).toEqual([]);
});
