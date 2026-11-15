// tests/license-states-batch.test.ts — WS-2 Defect 3: the platform /tenants screen told the truth
// about a boolean nobody cares about.
//
// `routes/admin.ts listAllTenants` computed `licensed: (license_token_encrypted IS NOT NULL)` —
// "a token was written once", not "the token works". Live prod: 18 of 19 tenants reported
// licensed=true while the authoritative licences service held a `commonpractice` licence for only
// 5, and 13 token-holding tenants were not registered there at all. Those 13 introspect
// `active:false`, so Gate 2 402s them on every screen while the row shows a calm grey chip.
//
// `licenseStatesForTenants` is the replacement read. Deps are injected via the module's existing
// __setLicenseStatusDepsForTests seam (no live licences service, no DB), and the deadline is
// INJECTED rather than raced against wall-clock — budget-based tests are this repo's historical
// flake source.
import { test, expect, afterEach, beforeEach } from 'bun:test';
import {
  licenseStatesForTenants,
  __setLicenseStatusDepsForTests,
  __resetLicenseStatusDepsForTests,
} from '../src/lib/license-status';
import { config } from '../src/config';
import { LicenseClientError, type LicenseIntrospectResponse } from '../src/services/license-client';
import { renderMetrics } from '../src/host/metrics';

/** Read a free-form counter out of the Prometheus text exposition (metrics.ts has no getter). */
function counter(name: string): number {
  const m = new RegExp(`^commonpractice_${name} (\\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : 0;
}

const A = '00000000-0000-0000-0000-0000000f3001'; // token, introspects active:true
const B = '00000000-0000-0000-0000-0000000f3002'; // token, introspects active:false  ← the lie
const C = '00000000-0000-0000-0000-0000000f3003'; // NO token
const D = '00000000-0000-0000-0000-0000000f3004'; // token, past expiry

function setFlag(on: boolean) {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
}

/** Install a fake token store + introspector and return the recorded introspect calls. */
function install(
  tokens: Record<string, string | null>,
  introspect: (token: string) => Promise<LicenseIntrospectResponse>,
): { calls: string[] } {
  const calls: string[] = [];
  __setLicenseStatusDepsForTests({
    loadTokens: async (ids) => new Map(ids.map((id) => [id, tokens[id] ?? null])),
    introspect: (token) => {
      calls.push(token);
      return introspect(token);
    },
    now: () => new Date('2026-06-24T00:00:00Z'),
  });
  return { calls };
}

beforeEach(() => setFlag(true));
afterEach(() => {
  __resetLicenseStatusDepsForTests();
  setFlag(false); // restore the F.1 prod/CI default
});

// ---------------------------------------------------------------------------------------------
// T5 — the lie itself.
// ---------------------------------------------------------------------------------------------

test('T5 a tenant whose STORED token introspects active:false reports state:none WITH hasToken:true', async () => {
  // REVERT THAT REDDENS THIS: trust the `licensed` boolean (token IS NOT NULL ⇒ licensed) — B then
  // reports as licensed while Gate 2 402s it, which is precisely the prod state.
  const { calls } = install({ [A]: 'tok-a', [B]: 'tok-b', [C]: null }, async (token) =>
    token === 'tok-a'
      ? { active: true, expires_at: '2999-01-01T00:00:00Z' }
      : { active: false, status: 'revoked' },
  );
  const out = await licenseStatesForTenants([A, B, C]);

  expect(out.get(A)).toMatchObject({ state: 'active', hasToken: true });
  // The 13 stranded tenants: a token IS stored, and it is worthless.
  expect(out.get(B)).toMatchObject({ state: 'none', hasToken: true });
  // No token at all — a DIFFERENT repair (issueLicense vs issueLicense(force)).
  expect(out.get(C)).toMatchObject({ state: 'none', hasToken: false });
  expect(calls.sort()).toEqual(['tok-a', 'tok-b']);
});

test('T5b a past-expiry token reports `expired`, not `none` (the derivation is reused, not re-implemented)', async () => {
  install({ [D]: 'tok-d' }, async () => ({
    active: false,
    expires_at: '2020-01-01T00:00:00Z',
  }));
  const out = await licenseStatesForTenants([D]);
  expect(out.get(D)).toMatchObject({ state: 'expired', hasToken: true });
  expect(out.get(D)?.expiresAt).toBe('2020-01-01T00:00:00Z');
});

test('T5c `expiring_soon` collapses to `active` — the chip answers entitlement, not the countdown', async () => {
  install({ [A]: 'tok-a' }, async () => ({
    active: true,
    expires_at: '2026-07-01T00:00:00Z', // 7 days out from the injected now
  }));
  const out = await licenseStatesForTenants([A]);
  expect(out.get(A)?.state).toBe('active');
  expect(out.get(A)?.daysRemaining).toBe(7);
});

// ---------------------------------------------------------------------------------------------
// T6 — an outage must not turn the whole estate coral.
// ---------------------------------------------------------------------------------------------

test('T6 every introspect rejecting ⇒ token-holders are `unknown`, NEVER `none`/`expired`; the token-less tenant is still `none`', async () => {
  // REVERT THAT REDDENS THIS: map an introspect rejection to `none` (i.e. copy the GATE's
  // fail-closed posture into this read). Every token-holding tenant then reports "No licence"
  // during a licences blip, and an operator force-reissues 19 healthy licences by hand.
  const before = counter('license_status_introspect_failures_total');
  install({ [A]: 'tok-a', [B]: 'tok-b', [C]: null }, async () => {
    throw new LicenseClientError(503, 'licences down');
  });
  const out = await licenseStatesForTenants([A, B, C]);

  expect(out.get(A)).toMatchObject({ state: 'unknown', hasToken: true });
  expect(out.get(B)).toMatchObject({ state: 'unknown', hasToken: true });
  expect(out.get(C)).toMatchObject({ state: 'none', hasToken: false });
  for (const id of [A, B]) {
    expect(out.get(id)?.state).not.toBe('none');
    expect(out.get(id)?.state).not.toBe('expired');
  }
  // Its OWN counter, not the gate's enforcement-outage signal.
  expect(counter('license_status_introspect_failures_total')).toBe(before + 2);
});

test('T6b a failing batch token READ degrades the page to `unknown`, not to `none`', async () => {
  __setLicenseStatusDepsForTests({
    loadTokens: async () => {
      throw new Error('db down');
    },
  });
  const out = await licenseStatesForTenants([A, B]);
  expect(out.get(A)?.state).toBe('unknown');
  expect(out.get(B)?.state).toBe('unknown');
});

test('T6c the failure counter is NOT the gate\'s `license_introspect_failures_total`', async () => {
  const gateBefore = counter('license_introspect_failures_total');
  install({ [A]: 'tok-a' }, async () => {
    throw new LicenseClientError(503, 'down');
  });
  await licenseStatesForTenants([A]);
  // An operator refreshing /tenants during an outage must not inflate the ENFORCEMENT alert.
  expect(counter('license_introspect_failures_total')).toBe(gateBefore);
});

// ---------------------------------------------------------------------------------------------
// T7 — the deadline, on an INJECTED budget (never wall-clock).
// ---------------------------------------------------------------------------------------------

test('T7 an introspect that never settles resolves within the injected budget, all `unknown`', async () => {
  // REVERT THAT REDDENS THIS: drop the `Promise.race` against the deadline — the call then hangs
  // on the never-settling introspect and the test times out instead of asserting.
  install({ [A]: 'tok-a', [B]: 'tok-b', [C]: null }, () => new Promise<never>(() => {}));
  const started = Date.now();
  const out = await licenseStatesForTenants([A, B, C], { budgetMs: 25 });
  // Not a wall-clock ASSERTION (that is the flake), just a sanity ceiling far above the budget.
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(out.get(A)).toMatchObject({ state: 'unknown', hasToken: true });
  expect(out.get(B)).toMatchObject({ state: 'unknown', hasToken: true });
  expect(out.get(C)).toMatchObject({ state: 'none', hasToken: false }); // resolved with zero HTTP
});

test('T7b the budget defaults to config.license.statusBatchMs', () => {
  expect(config.license.statusBatchMs).toBe(3_000);
});

// ---------------------------------------------------------------------------------------------
// T8 — no fan-out.
// ---------------------------------------------------------------------------------------------

test('T8 N tenants with M tokens ⇒ exactly M introspect calls, and ONE batched token read', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, i) => `00000000-0000-0000-0000-00000000f3${String(i).padStart(2, '0')}`,
  );
  const withToken = ids.filter((_, i) => i % 3 === 0); // 4 of 12
  const tokens: Record<string, string | null> = {};
  for (const id of ids) tokens[id] = withToken.includes(id) ? `tok-${id}` : null;

  let tokenReads = 0;
  const calls: string[] = [];
  __setLicenseStatusDepsForTests({
    loadTokens: async (batch) => {
      tokenReads += 1;
      return new Map(batch.map((id) => [id, tokens[id] ?? null]));
    },
    introspect: async (token) => {
      calls.push(token);
      return { active: true };
    },
  });

  const out = await licenseStatesForTenants(ids);
  expect(tokenReads).toBe(1); // one query for the page, not N (the getBudgetsForTenants idiom)
  expect(calls.length).toBe(withToken.length); // M, not N
  expect(new Set(calls).size).toBe(withToken.length); // and no token introspected twice
  expect(out.size).toBe(ids.length);
});

test('T8b a repeated id on the page is introspected once', async () => {
  const { calls } = install({ [A]: 'tok-a' }, async () => ({ active: true }));
  await licenseStatesForTenants([A, A, A]);
  expect(calls).toEqual(['tok-a']);
});

// ---------------------------------------------------------------------------------------------
// The dev/CI no-op.
// ---------------------------------------------------------------------------------------------

test('gate disabled ⇒ empty map, zero token reads, zero introspects (dev/CI pay nothing)', async () => {
  setFlag(false);
  let touched = false;
  __setLicenseStatusDepsForTests({
    loadTokens: async () => {
      touched = true;
      return new Map();
    },
    introspect: async () => {
      touched = true;
      return { active: true };
    },
  });
  const out = await licenseStatesForTenants([A, B, C]);
  expect(out.size).toBe(0); // ⇒ the route emits no licence fields ⇒ the frontend legacy fallback
  expect(touched).toBe(false);
});

test('an empty id list is a no-op', async () => {
  install({}, async () => ({ active: true }));
  expect((await licenseStatesForTenants([])).size).toBe(0);
});
