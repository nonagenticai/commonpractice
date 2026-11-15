// tests/me-stale-active-tenant.test.ts — a stale "acting as" choice must not brick /api/me.
//
// Found in a prod browser E2E (2026-10-14): a super_admin acting as a tenant that was later
// OFFBOARDED (licence revoked) got `402` from `GET /api/me`, because `validateAuth` judged the
// scope-switched operator against that tenant. `/api/me` is the SPA's identity bootstrap, so the
// app could not initialise at all and offered no way back. `routes/me.ts authenticateForMe` now
// judges the acting tenant on its own, falls back to the home tenant, and reports the refusal in
// `activeTenantRejected` so the SPA drops the selection.
//
// The no-regress half matters as much: the SAME header on a tenant DATA route must still 402 —
// `/api/me` stops acting as the tenant, it does not license it.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMeRoutes } from '../src/routes/me';
import { registerFlowRoutes } from '../src/routes/flows';
import { db, tenants, users } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import {
  __setLicenseClientForTests,
  type LicenseClient,
  type LicenseIntrospectResponse,
} from '../src/services/license-client';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T_HOME = '00000000-0000-4000-8000-0000057a1e01';
const T_DEAD = '00000000-0000-4000-8000-0000057a1e02'; // licence revoked
const T_GONE = '00000000-0000-4000-8000-0000057a1e03'; // offboarded
const T_LIVE = '00000000-0000-4000-8000-0000057a1e04'; // licensed, active
const T_NONE = '00000000-0000-4000-8000-0000057a1e05'; // never provisioned (no row)
const T_FLAKY = '00000000-0000-4000-8000-0000057a1e06'; // licensed, but licences is DOWN
const UID_SUPER = '00000000-0000-4000-8000-0000057a1e11';
const UID_MEMBER = '00000000-0000-4000-8000-0000057a1e12';

const TOKENS: Record<string, string> = {
  [T_HOME]: 'tok-stale-home',
  [T_DEAD]: 'tok-stale-dead',
  [T_GONE]: 'tok-stale-gone',
  [T_LIVE]: 'tok-stale-live',
  [T_FLAKY]: 'tok-stale-flaky',
};

const fakeLicense: LicenseClient = {
  async introspect(token: string): Promise<LicenseIntrospectResponse> {
    const tenantId = Object.keys(TOKENS).find((t) => TOKENS[t] === token);
    if (tenantId === T_FLAKY) throw new Error('licences unreachable');
    if (!tenantId || tenantId === T_DEAD || tenantId === T_GONE) {
      return { active: false, status: 'revoked' };
    }
    return {
      active: true,
      status: 'active',
      tenant_id: tenantId,
      app: { key: config.license.appKey },
    } as LicenseIntrospectResponse;
  },
};

const superAdmin: User = {
  id: UID_SUPER,
  email: 'stale-at-super@test',
  name: 'Stale AT Super',
  roles: ['super_admin', 'tenant_admin'],
  tenantId: T_HOME,
};
const member: User = {
  id: UID_MEMBER,
  email: 'stale-at-member@test',
  name: 'Stale AT Member',
  roles: ['member'],
  tenantId: T_HOME,
};

const router = new Router();
registerMeRoutes(router);
registerFlowRoutes(router);

async function call(as: User, path: string, activeTenant?: string) {
  __setAuthOverridesForTests({ validateAuth: async () => as, requireRole: async () => as });
  const matched = router.match('GET', path);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const headers: Record<string, string> = {};
  if (activeTenant !== undefined) headers['X-Active-Tenant-Id'] = activeTenant;
  const res = await matched.handler(new Request(`http://localhost${path}`, { headers }), ...matched.params);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json, code: (json as { error?: string } | null)?.error ?? null };
}

const flags = { gate: config.license.enforceGate2, perMember: config.license.perMemberGate };
function setFlags(gate: boolean, perMember: boolean) {
  (config.license as { enforceGate2: boolean }).enforceGate2 = gate;
  (config.license as { perMemberGate: boolean }).perMemberGate = perMember;
}

async function cleanup() {
  await db.delete(users).where(inArray(users.id, [UID_SUPER, UID_MEMBER]));
  await db.delete(tenants).where(inArray(tenants.id, [T_HOME, T_DEAD, T_GONE, T_LIVE, T_FLAKY]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: T_HOME, name: 'Stale AT Home', slug: 'stale-at-home' },
    { id: T_DEAD, name: 'Stale AT Dead', slug: 'stale-at-dead' },
    { id: T_GONE, name: 'Stale AT Gone', slug: 'stale-at-gone', status: 'suspended', offboarded_at: new Date() },
    { id: T_LIVE, name: 'Stale AT Live', slug: 'stale-at-live' },
    { id: T_FLAKY, name: 'Stale AT Flaky', slug: 'stale-at-flaky' },
  ]);
  for (const [id, tok] of Object.entries(TOKENS)) {
    await db.update(tenants).set({ license_token_encrypted: encryptSecret(tok) }).where(eq(tenants.id, id));
  }
  await db.insert(users).values([
    { id: UID_SUPER, tenant_id: T_HOME, email: superAdmin.email, name: superAdmin.name },
    { id: UID_MEMBER, tenant_id: T_HOME, email: member.email, name: member.name },
  ]);
  __setLicenseClientForTests(fakeLicense);
  setFlags(true, false);
}, 30_000);

afterAll(async () => {
  setFlags(flags.gate, flags.perMember);
  __setLicenseClientForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

test('⛔ super_admin acting as a licence-revoked tenant: /api/me answers 200 about the HOME tenant and says why', async () => {
  // REVERT THAT REDDENS THIS: `const user = await validateAuth(req)` back in routes/me.ts → 402.
  const r = await call(superAdmin, '/api/me', T_DEAD);
  expect(r.status).toBe(200);
  expect(r.json.id).toBe(UID_SUPER);
  expect(r.json.tenantId).toBe(T_HOME);
  expect(r.json.isSuperAdmin).toBe(true);
  expect(r.json.activeTenantRejected).toBe('license_inactive');
});

test('super_admin acting as an OFFBOARDED tenant is refused by name, even before any licence check', async () => {
  const r = await call(superAdmin, '/api/me', T_GONE);
  expect(r.status).toBe(200);
  expect(r.json.tenantId).toBe(T_HOME);
  expect(r.json.activeTenantRejected).toBe('tenant_offboarded');
});

test('unprovisioned and malformed acting tenants are refused, not 4xx/5xx', async () => {
  const none = await call(superAdmin, '/api/me', T_NONE);
  expect(none.status).toBe(200);
  expect(none.json.activeTenantRejected).toBe('tenant_not_provisioned');
  const junk = await call(superAdmin, '/api/me', 'not-a-uuid');
  expect(junk.status).toBe(200);
  expect(junk.json.activeTenantRejected).toBe('INVALID_ACTIVE_TENANT_HEADER');
});

test('⛔ a TRANSIENT refusal (licences outage) is not a rejection: /api/me fails like every route, the selection is not condemned', async () => {
  // REVERT THAT REDDENS THIS: drop the `isTransientRefusal` re-throw in routes/me.ts — /api/me would
  // answer 200 with activeTenantRejected='license_unavailable' and the SPA would forget a valid choice.
  const r = await call(superAdmin, '/api/me', T_FLAKY);
  expect(r.status).toBe(402);
  expect(r.code).toBe('license_unavailable');
});

test('isTransientRefusal: outage codes, 429 and 5xx are transient; permanent verdicts are not', async () => {
  const { isTransientRefusal } = await import('../src/routes/me');
  const { HttpError } = await import('../src/utils/http');
  expect(isTransientRefusal(new HttpError(402, 'license_unavailable'))).toBe(true);
  expect(isTransientRefusal(new HttpError(503, 'tenant_status_unavailable'))).toBe(true);
  expect(isTransientRefusal(new HttpError(429, 'rate_limited'))).toBe(true);
  expect(isTransientRefusal(new HttpError(500, 'internal'))).toBe(true);
  expect(isTransientRefusal(new HttpError(402, 'license_inactive'))).toBe(false);
  expect(isTransientRefusal(new HttpError(402, 'license_required'))).toBe(false);
  expect(isTransientRefusal(new HttpError(403, 'license_tenant_mismatch'))).toBe(false);
});

test('a USABLE acting tenant is honoured: no rejection', async () => {
  const r = await call(superAdmin, '/api/me', T_LIVE);
  expect(r.status).toBe(200);
  expect(r.json.activeTenantRejected).toBeNull();
});

test('no header: unchanged, no rejection', async () => {
  const r = await call(superAdmin, '/api/me');
  expect(r.status).toBe(200);
  expect(r.json.activeTenantRejected).toBeNull();
});

test('a non-super_admin header stays inert (probe-resistance): no rejection, no different answer', async () => {
  const r = await call(member, '/api/me', T_DEAD);
  expect(r.status).toBe(200);
  expect(r.json.tenantId).toBe(T_HOME);
  expect(r.json.activeTenantRejected).toBeNull();
});

test('⛔ no-regress: the SAME stale header on a tenant DATA route still 402s', async () => {
  // REVERT THAT REDDENS THIS: any "fix" that exempts scope-switched super_admins from Gate 2.
  const r = await call(superAdmin, '/api/flows', T_DEAD);
  expect(r.status).toBe(402);
  expect(r.code).toBe('license_inactive');
});
