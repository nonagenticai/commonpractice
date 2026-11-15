// tests/license-status.test.ts — the SPA license STATUS derivation (lib/license-status.ts) that
// backs `GET /api/license/status`. Covers the pure introspect→state mapping for EVERY state
// (including the past-expiry→expired defence and the !active→none collapse) AND `getLicenseStatus`'s
// orchestration (gate-off no-op, no-tenant, no-token, fail-soft to 'unknown'). Deps are injected via
// __setLicenseStatusDepsForTests (no live licenses service / DB), the repo's sanctioned seam.
import { test, expect, afterEach, describe } from 'bun:test';
import { Router } from '../src/utils/router';
import { registerLicenseRoutes } from '../src/routes/license';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';
import {
  deriveStatusFromIntrospect,
  getLicenseStatus,
  __setLicenseStatusDepsForTests,
  __resetLicenseStatusDepsForTests,
} from '../src/lib/license-status';
import {
  __setMemberEntitlementLoaderForTests,
  __resetMemberEntitlementLoaderForTests,
} from '../src/lib/license-status';
import { config } from '../src/config';
import type { LicenseIntrospectResponse } from '../src/services/license-client';
import { LicenseClientError } from '../src/services/license-client';

const T_ID = '00000000-0000-4000-8000-00000bb50001';
const U_ID = '00000000-0000-4000-8000-00000bb500a1';
const NOW = new Date('2026-06-24T00:00:00Z');
const iso = (daysFromNow: number) =>
  new Date(NOW.getTime() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();

afterEach(() => {
  __resetLicenseStatusDepsForTests();
});

// ---- pure derivation: every state ----

test('active + no expiry → active (perpetual), hasLicense', () => {
  const r = deriveStatusFromIntrospect({ active: true, plan: { code: 'standard' } }, NOW);
  expect(r.state).toBe('active');
  expect(r.hasLicense).toBe(true);
  expect(r.expiresAt).toBeNull();
  expect(r.daysRemaining).toBeNull();
  expect(r.planCode).toBe('standard');
});

test('active + expiry far in the future → active', () => {
  const r = deriveStatusFromIntrospect({ active: true, expires_at: iso(90) }, NOW);
  expect(r.state).toBe('active');
  expect(r.hasLicense).toBe(true);
  expect(r.daysRemaining).toBe(90);
});

test('active + expiry within 30d → expiring_soon (still usable)', () => {
  const r = deriveStatusFromIntrospect({ active: true, expires_at: iso(10) }, NOW);
  expect(r.state).toBe('expiring_soon');
  expect(r.hasLicense).toBe(true);
  expect(r.daysRemaining).toBe(10);
});

test('active + expiry exactly at the 30d boundary → expiring_soon', () => {
  const r = deriveStatusFromIntrospect({ active: true, expires_at: iso(30) }, NOW);
  expect(r.state).toBe('expiring_soon');
});

test('active but expiry ALREADY PASSED → expired (not expiring_soon), no license', () => {
  const r = deriveStatusFromIntrospect({ active: true, expires_at: iso(-1) }, NOW);
  expect(r.state).toBe('expired');
  expect(r.hasLicense).toBe(false);
  expect(r.daysRemaining).toBe(-1);
});

test('!active + expiry passed → expired', () => {
  const r = deriveStatusFromIntrospect(
    { active: false, expires_at: iso(-5), plan: { code: 'pro' } },
    NOW,
  );
  expect(r.state).toBe('expired');
  expect(r.hasLicense).toBe(false);
  expect(r.planCode).toBe('pro');
});

test('!active with no passed expiry (revoked / pending / never) → none', () => {
  // CP cannot distinguish revoked from never-licensed by introspection — both collapse to none.
  expect(deriveStatusFromIntrospect({ active: false, status: 'revoked' }, NOW).state).toBe('none');
  expect(deriveStatusFromIntrospect({ active: false, expires_at: iso(10) }, NOW).state).toBe('none');
  const none = deriveStatusFromIntrospect({ active: false }, NOW);
  expect(none.hasLicense).toBe(false);
  expect(none.expiresAt).toBeNull();
  expect(none.planCode).toBeNull();
});

// ---- getLicenseStatus orchestration ----

test('gate disabled → active, NO token read, NO introspect', async () => {
  let loaded = false;
  let introspected = false;
  __setLicenseStatusDepsForTests({
    loadToken: async () => {
      loaded = true;
      return 'tok';
    },
    introspect: async () => {
      introspected = true;
      return { active: true };
    },
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: 'T1', gateEnabled: false });
  expect(r.state).toBe('active');
  expect(r.hasLicense).toBe(true);
  expect(loaded).toBe(false);
  expect(introspected).toBe(false);
});

test('gate enabled + no tenant → no_workspace, NOT none (no introspect)', async () => {
  // ⛔ `none` is a BLOCKED state on the SPA and the store caches it: an invitee whose status was
  // read just before their invite was accepted kept the licence wall on an active workspace.
  let introspected = false;
  __setLicenseStatusDepsForTests({
    introspect: async () => {
      introspected = true;
      return { active: true };
    },
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: null, gateEnabled: true });
  expect(r.state).toBe('no_workspace');
  expect(r.hasLicense).toBe(false);
  expect(introspected).toBe(false);
});

// ---- the route: the answer names the tenant it is ABOUT ----

describe('GET /api/license/status carries the resolved tenantId', () => {
  const router = new Router();
  registerLicenseRoutes(router);
  const lic = config.license as { enforceGate2: boolean };
  const wasGate = lic.enforceGate2;
  afterEach(() => {
    __setAuthOverridesForTests(undefined);
    lic.enforceGate2 = wasGate;
  });

  async function status(user: User): Promise<Record<string, unknown>> {
    __setAuthOverridesForTests({ validateAuth: async () => user });
    const m = router.match('GET', '/api/license/status')!;
    const res = await m.handler(new Request('http://t/api/license/status'));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  test('a seated caller → tenantId is their tenant', async () => {
    lic.enforceGate2 = false; // ACTIVE without any DB/licences read; the tenant is still resolved
    const body = await status({ id: U_ID, email: 'u@bb5.test', name: 'U', roles: [], tenantId: T_ID });
    expect(body.tenantId).toBe(T_ID);
    expect(body.state).toBe('active');
  });

  test('an unseated caller → tenantId null and state no_workspace (non-blocking), gate ON', async () => {
    lic.enforceGate2 = true;
    const body = await status({ id: U_ID, email: 'u@bb5.test', name: 'U', roles: [] });
    expect(body).toHaveProperty('tenantId', null);
    expect(body.state).toBe('no_workspace');
  });
});

test('gate enabled + tenant has no stored token → none (no introspect)', async () => {
  let introspected = false;
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    introspect: async () => {
      introspected = true;
      return { active: true };
    },
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: 'T1', gateEnabled: true });
  expect(r.state).toBe('none');
  expect(introspected).toBe(false);
});

test('gate enabled + active token → active', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => 'tok',
    introspect: async (): Promise<LicenseIntrospectResponse> => ({
      active: true,
      tenant_id: 'T1',
      app: { key: 'commonpractice' },
      expires_at: iso(90),
      plan: { code: 'standard' },
    }),
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: 'T1', gateEnabled: true });
  expect(r.state).toBe('active');
  expect(r.hasLicense).toBe(true);
  expect(r.planCode).toBe('standard');
});

test('introspect THROWS (LicenseClientError) → unknown (fail-soft, NOT a block)', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => 'tok',
    introspect: async () => {
      throw new LicenseClientError(503, 'licenses down');
    },
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: 'T1', gateEnabled: true });
  expect(r.state).toBe('unknown');
  expect(r.hasLicense).toBe(false);
});

test('token load THROWS (DB blip) → unknown (fail-soft, NOT a block)', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => {
      throw new Error('db connection reset');
    },
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: 'T1', gateEnabled: true });
  expect(r.state).toBe('unknown');
});

// ---- per-member seat awareness (migration 0089, flag LICENSE_GATE_PER_MEMBER) ----
//
// ⛔ WHY THIS ENDPOINT HAD TO CHANGE AT ALL, RECORDED BECAUSE IT IS NOT OBVIOUS FROM EITHER SIDE.
// With the per-member gate on, the GATE judges the caller's own entitlement while this endpoint
// judged the TENANT's token. For a seatless member of a licensed workspace those two disagree:
// every gated request 402s, but this says `active`. `stores/licenseGate.svelte.ts` `load()` clears
// a forced block on an entitled answer — so the SPA cleared the block one round trip after raising
// it, and the next request raised it again. A FLAP LOOP, not a mislabel. These tests pin that the
// read side now answers about the same subject the gate asks about.

test('per-member ON + no seat → no_seat (NOT active, NOT none)', async () => {
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setMemberEntitlementLoaderForTests(async () => null);
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    // `no_seat`, not `none`: `none` means "this workspace was never licensed" and renders as a
    // billing wall aimed at the workspace. Here the workspace is licensed and paying.
    expect(r.state).toBe('no_seat');
    expect(r.hasLicense).toBe(false);
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
    __resetMemberEntitlementLoaderForTests();
  }
});

test('per-member ON + a seat whose token is bound to this member → active', async () => {
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setMemberEntitlementLoaderForTests(async () => ({ token: 'tok-m', subjectId: 'subj-m' }));
  __setLicenseStatusDepsForTests({
    introspect: async () => ({ active: true, subject_id: 'subj-m' }) as LicenseIntrospectResponse,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    expect(r.state).toBe('active');
    expect(r.hasLicense).toBe(true);
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
    __resetMemberEntitlementLoaderForTests();
  }
});

test('per-member ON + a token bound to SOMEONE ELSE → no_seat, not active', async () => {
  // The gate ENFORCES the subject binding; this endpoint must agree with it, or a member holding a
  // stale/copied token would be told they are fine while every request 403s them.
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setMemberEntitlementLoaderForTests(async () => ({ token: 'tok-m', subjectId: 'subj-mine' }));
  __setLicenseStatusDepsForTests({
    introspect: async () =>
      ({ active: true, subject_id: 'subj-someone-else' }) as LicenseIntrospectResponse,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    expect(r.state).toBe('no_seat');
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
    __resetMemberEntitlementLoaderForTests();
  }
});

test('per-member ON + an entitlement with a NULL subject → no_seat, matching the gate exactly', async () => {
  // ⛔ THE TWO SIDES MUST SHARE ONE PREDICATE. This used to read `if (ent.subjectId && …)`, which
  // SKIPPED the comparison on a null stored subject — while the gate DENIES on it. A row with a
  // token and no subject then got a 403 from the gate and an ENTITLED answer from here, which is
  // exactly the gate/endpoint disagreement that makes the SPA raise and clear the block on
  // alternate round trips. Making the endpoint seat-aware without matching this rule would have
  // reintroduced the flap it was written to remove.
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setMemberEntitlementLoaderForTests(async () => ({ token: 'tok-m', subjectId: null }));
  __setLicenseStatusDepsForTests({
    introspect: async () => ({ active: true, subject_id: 'subj-m' }) as LicenseIntrospectResponse,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    expect(r.state).toBe('no_seat');
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
    __resetMemberEntitlementLoaderForTests();
  }
});

test('per-member ON but NO member resolved (a scope-switched operator) → the TENANT answer, not no_seat', async () => {
  // ⚠️ An operator scoped into a customer's tenant holds no entitlement there by design. Reporting
  // `no_seat` would raise a seat wall on exactly the staff whose job is to fix seats.
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setLicenseStatusDepsForTests({
    loadToken: async () => 'tenant-tok',
    introspect: async () => ({ active: true }) as LicenseIntrospectResponse,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: null,
    });
    expect(r.state).toBe('active');
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
  }
});

test('per-member OFF → the caller is ignored entirely and the tenant token decides', async () => {
  (config.license as { perMemberGate: boolean }).perMemberGate = false;
  let memberLoaderCalled = false;
  __setMemberEntitlementLoaderForTests(async () => {
    memberLoaderCalled = true;
    return null;
  });
  __setLicenseStatusDepsForTests({
    loadToken: async () => 'tenant-tok',
    introspect: async () => ({ active: true }) as LicenseIntrospectResponse,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    expect(r.state).toBe('active');
    expect(memberLoaderCalled).toBe(false); // the flag is what makes this change inert
  } finally {
    __resetMemberEntitlementLoaderForTests();
  }
});

// ---- TENANT-LEVEL LICENCES (ruling 2026-09-28) ----
// The endpoint must agree with the gate: a tenant holding only its bundle's tenant-level licence
// (svc holder, no CP-stored token) is ENTITLED, not `none`.

const tenantLevelOk = (tenantId: string): LicenseIntrospectResponse => ({
  active: true,
  tenant_id: tenantId,
  app: { key: 'commonpractice' },
  expires_at: iso(90),
  plan: { code: 'bundle' },
  subject_match: true,
});

test('tenant-level: no stored token + tenant-level licence → active (not none)', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async (t) => tenantLevelOk(t),
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('active');
  expect(r.hasLicense).toBe(true);
  expect(r.planCode).toBe('bundle');
});

test('tenant-level: no stored token + NO tenant-level licence → none', async () => {
  const asked: string[] = [];
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async (t) => {
      asked.push(t);
      return null;
    },
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('none');
  expect(asked).toEqual([T_ID]);
});

test('tenant-level: a lookup answer for ANOTHER tenant is not an entitlement → none', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async () => tenantLevelOk('someone-else'),
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('none');
});

test("tenant-level: the lookup's fallback pick (another member's licence, subject_match false) → none", async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async (t) => ({ ...tenantLevelOk(t), subject_match: false }),
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('none');
});

test('tenant-level: lookup THROWS with no stored token → unknown (never a false none)', async () => {
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async () => {
      throw new Error('licenses down');
    },
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('unknown');
});

test('tenant-level: an ACTIVE stored token is unchanged and never triggers the lookup', async () => {
  let asked = 0;
  __setLicenseStatusDepsForTests({
    loadToken: async () => 'tok',
    introspect: async () => tenantLevelOk(T_ID),
    loadActiveTenantLicense: async () => {
      asked++;
      return null;
    },
    now: () => NOW,
  });
  const r = await getLicenseStatus({ appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true });
  expect(r.state).toBe('active');
  expect(asked).toBe(0);
});

test('tenant-level: per-member ON + no seat + tenant-level licence → active (agrees with the gate)', async () => {
  (config.license as { perMemberGate: boolean }).perMemberGate = true;
  __setMemberEntitlementLoaderForTests(async () => null);
  __setLicenseStatusDepsForTests({
    loadActiveTenantLicense: async (t) => tenantLevelOk(t),
    now: () => NOW,
  });
  try {
    const r = await getLicenseStatus({
      appKey: 'commonpractice',
      tenantId: T_ID,
      gateEnabled: true,
      userId: U_ID,
    });
    expect(r.state).toBe('active');
  } finally {
    (config.license as { perMemberGate: boolean }).perMemberGate = false;
    __resetMemberEntitlementLoaderForTests();
  }
});

test('tenant-level: a positive answer is cached; an expiry inside the window still denies', async () => {
  let asked = 0;
  let clock = NOW;
  __setLicenseStatusDepsForTests({
    loadToken: async () => null,
    loadActiveTenantLicense: async (t) => {
      asked++;
      return { ...tenantLevelOk(t), expires_at: new Date(NOW.getTime() + 60_000).toISOString() };
    },
    now: () => clock,
  });
  const args = { appKey: 'commonpractice', tenantId: T_ID, gateEnabled: true };
  expect((await getLicenseStatus(args)).hasLicense).toBe(true);
  expect((await getLicenseStatus(args)).hasLicense).toBe(true);
  expect(asked).toBe(1); // second answer came from the cache
  clock = new Date(NOW.getTime() + 120_000); // past expires_at, still inside the 5-min TTL
  expect((await getLicenseStatus(args)).hasLicense).toBe(false);
});
