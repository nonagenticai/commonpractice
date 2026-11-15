// tests/license-gate-guard-derived.test.ts — WS-2: WHICH requests Gate 2 applies to.
//
// tests/license-gate.test.ts owns the VERDICT (the 402/403 matrix for a given tenant). This file
// owns the other axis: the gate now runs from `validateAuth`, i.e. from the guard the route already
// chose, instead of once in server.ts before any guard against `peekEffectiveTenant`. The bug that
// caused: a super_admin scope-switched into an unlicensed tenant lost the ENTIRE operator console —
// /api/pipeline, /api/audit, /api/governance, /api/ops all answered 402 — even though those rows
// are platform-global (pipeline_items / audit_log sit outside RLS by design, migration 0028) and
// have no tenant whose licence could be checked.
//
// Every test below names the revert that reddens it, because "a path allowlist cannot express this
// route set" is only worth writing down if it is falsifiable.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerPipelineRoutes } from '../src/routes/pipeline';
import { registerAuditRoutes } from '../src/routes/audit';
import { registerGovernanceRoutes } from '../src/routes/governance';
import { registerOpsRoutes } from '../src/routes/ops';
import { registerFlowRoutes } from '../src/routes/flows';
import { registerSandboxRoutes } from '../src/routes/sandboxes';
import { registerCycleRoutes } from '../src/routes/cycle';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerLicenseRoutes } from '../src/routes/license';
import { registerBlockRoutes } from '../src/routes/blocks';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { db, tenants, users } from '../src/db/client';
import { config, DEMO_TENANT_ID } from '../src/config';
import { encryptSecret } from '../src/host/secret-box';
import {
  __setLicenseClientForTests,
  type LicenseClient,
  type LicenseIntrospectResponse,
} from '../src/services/license-client';

// The tenant the operator ACTS INTO. It holds a stored token whose introspection says
// `active:false` — the exact live shape that produced `402 license_inactive`.
const T_DEAD = '00000000-0000-0000-0000-0000000f2a01';
const DEAD_TOKEN = 'tok-ws2-dead';
const ADMIN_ID = '00000000-0000-0000-0000-0000000f2a10';

const superAdmin: User = {
  id: ADMIN_ID,
  email: 'ws2-op@test',
  name: 'WS2 Operator',
  roles: ['super_admin'],
  tenantId: DEMO_TENANT_ID, // their OWN tenant; the acting target comes from the header
};

let introspectCalls: string[] = [];
const fakeLicense: LicenseClient = {
  async introspect(token: string): Promise<LicenseIntrospectResponse> {
    introspectCalls.push(token);
    return { active: false, status: 'revoked' };
  },
};

function install(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const router = new Router();
registerPipelineRoutes(router);
registerAuditRoutes(router);
registerGovernanceRoutes(router);
registerOpsRoutes(router);
registerFlowRoutes(router);
registerSandboxRoutes(router);
registerCycleRoutes(router);
registerOnboardingRoutes(router);
registerAdminRoutes(router);
registerLicenseRoutes(router);
registerBlockRoutes(router);
registerDatasetRoutes(router);

/** Call a route AS the super_admin, scope-switched into the unlicensed tenant (the header the
 *  frontend attaches to every request the moment an operator clicks "act as"). */
async function actingCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; code: string | null; json: unknown }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const headers: Record<string, string> = { 'X-Active-Tenant-Id': T_DEAD };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  let code: string | null = null;
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
    code = (json as { error?: string } | null)?.error ?? null;
  } catch {
    /* non-JSON body (e.g. a CSV export) — the status is what this file asserts */
  }
  return { status: res.status, code, json };
}

function setFlag(on: boolean) {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see license-gate.test.ts).
beforeAll(async () => {
  await db
    .insert(tenants)
    .values([{ id: T_DEAD, name: 'WS2 Dead Co', slug: 'ws2-dead-tenant' }])
    .onConflictDoNothing({ target: tenants.id });
  await db
    .update(tenants)
    .set({ license_token_encrypted: encryptSecret(DEAD_TOKEN) })
    .where(eq(tenants.id, T_DEAD));
  await db
    .insert(users)
    .values({ id: ADMIN_ID, email: superAdmin.email, name: superAdmin.name, avatar_initials: 'WO' })
    .onConflictDoNothing();
  install(superAdmin);
  __setLicenseClientForTests(fakeLicense);
  setFlag(true);
}, 30_000);

afterAll(async () => {
  setFlag(false); // restore the F.1 prod/CI default
  __setLicenseClientForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
  await db.delete(tenants).where(eq(tenants.id, T_DEAD));
}, 30_000);

beforeEach(() => {
  introspectCalls = [];
});

// ---------------------------------------------------------------------------------------------
// T1 — the defect. The platform console survives an unlicensed acting target.
// ---------------------------------------------------------------------------------------------

test('T1 platform routes are NOT 402 for a super_admin acting into an unlicensed tenant, and never introspect', async () => {
  // REVERT THAT REDDENS THIS: point `requireSuperAdmin` (middleware/admin-guards.ts) back at
  // `validateAuth` instead of `authenticateWithoutLicense`.
  for (const [method, path] of [
    ['GET', '/api/pipeline'],
    ['GET', '/api/audit'],
    ['GET', '/api/governance'],
    ['GET', '/api/ops/dashboard'],
  ] as const) {
    const r = await actingCall(method, path);
    expect(r.status, `${method} ${path} must not be licence-blocked`).not.toBe(402);
    expect(r.status, `${method} ${path}`).toBe(200);
  }
  // Not merely "allowed" — the licence was never even consulted. A platform route has no tenant
  // to license, so it must not pay for a DB read + an introspect either.
  expect(introspectCalls).toEqual([]);
});

test('T1b POST /api/pipeline/enqueue — the exact call observed 402ing in prod — is not licence-blocked', async () => {
  const r = await actingCall('POST', '/api/pipeline/enqueue', {});
  expect(r.status).not.toBe(402);
  expect(r.code).not.toBe('license_inactive');
  expect(introspectCalls).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// T2 — the no-regress half. Having BOTH T1 and T2 is the point: each kills a different shortcut.
// ---------------------------------------------------------------------------------------------

test('T2 GET /api/flows still 402 license_inactive for that same scope-switched super_admin', async () => {
  // REVERT THAT REDDENS THIS: implement the exemption as "skip Gate 2 when isSuperAdmin(user)" in
  // licenseCallerTenant. T1 stays green, this goes red — which is precisely why both exist.
  const r = await actingCall('GET', '/api/flows');
  expect(r.status).toBe(402);
  expect(r.code).toBe('license_inactive');
  expect(introspectCalls).toEqual([DEAD_TOKEN]); // it DID consult the licence, once
});

test('T2b every tenant-scoped surface named in the WS-2 brief still 402s under the acting scope', async () => {
  for (const [method, path] of [
    ['GET', '/api/flows'],
    ['GET', '/api/blocks'],
    ['GET', '/api/datasets'],
    ['GET', '/api/sandboxes/me'],
    ['GET', `/api/tenants/${T_DEAD}/members`],
    ['GET', `/api/tenants/${T_DEAD}/usage`],
    ['GET', `/api/tenants/${T_DEAD}/budget`],
    ['GET', '/api/cycle/current'],
  ] as const) {
    expect(router.match(method, path), `${method} ${path} must be registered here`).toBeTruthy();
    const r = await actingCall(method, path);
    expect(r.status, `${method} ${path} must stay licence-gated`).toBe(402);
  }
});

// ---------------------------------------------------------------------------------------------
// T3 — the sibling trap. THIS is what makes "a path allowlist cannot express the route set"
// falsifiable rather than rhetorical.
// ---------------------------------------------------------------------------------------------

test('T3 sibling paths under one prefix land on OPPOSITE sides of the gate', async () => {
  // REVERT THAT REDDENS THIS: implement Defect 1 as a prefix allowlist over `/api/sandboxes`,
  // `/api/cycle` and `/api/signup-approvals` — all three gated siblings below flip to non-402.
  const meSandbox = await actingCall('GET', '/api/sandboxes/me');
  expect(meSandbox.status, 'GET /api/sandboxes/me is a TENANT route').toBe(402);
  const listSandboxes = await actingCall('GET', '/api/sandboxes');
  expect(listSandboxes.status, 'GET /api/sandboxes is a PLATFORM route').not.toBe(402);

  const currentCycle = await actingCall('GET', '/api/cycle/current');
  expect(currentCycle.status, 'GET /api/cycle/current is a TENANT route').toBe(402);
  const advanceCycle = await actingCall('POST', '/api/cycle/advance', {});
  expect(advanceCycle.status, 'POST /api/cycle/advance is a PLATFORM route').not.toBe(402);

  const listApprovals = await actingCall('GET', '/api/signup-approvals');
  expect(listApprovals.status, 'GET /api/signup-approvals is a PLATFORM route').not.toBe(402);
});

test('T3b POST /api/signup-approvals/notify-self is licence-gated, its GET sibling is not', async () => {
  // notify-self is deliberately anonymous-TOLERANT: it wraps validateAuth in a try/catch so a
  // caller with no token falls through and records intent. That catch must not swallow a licence
  // denial about an AUTHENTICATED caller (routes/onboarding.ts re-throws HttpError for exactly
  // this reason) — otherwise moving the gate into validateAuth silently converts today's 402 into
  // "signup intent recorded".
  const notifySelf = await actingCall('POST', '/api/signup-approvals/notify-self', {
    email: 'ws2-prospect@example.com',
  });
  expect(notifySelf.status).toBe(402);
  expect(notifySelf.code).toBe('license_inactive');
  expect(introspectCalls).toEqual([DEAD_TOKEN]);

  introspectCalls = [];
  const list = await actingCall('GET', '/api/signup-approvals');
  expect(list.status).not.toBe(402);
  expect(introspectCalls, 'a platform route must not even read the licence').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// T4 — the four old allowlist entries survive as CONSEQUENCES of the guards, with isExemptPath gone.
// ---------------------------------------------------------------------------------------------

test('T4 GET /api/admin/tenants (requireSuperAdmin) is reachable with the acting tenant unlicensed', async () => {
  const r = await actingCall('GET', '/api/admin/tenants');
  expect(r.status).toBe(200);
  // It DOES introspect — but not as a gate. This is Defect 3's truth-read (lib/license-status.ts
  // licenseStatesForTenants) telling the operator what each tenant's licence really is, which is
  // the whole point of the screen. The distinction is visible in the payload: the row is RETURNED,
  // carrying `licenseState:'none'` WITH a stored token, instead of the request being refused.
  const { tenants: listed } = r.json as {
    tenants: { id: string; licensed: boolean; licenseState?: string; licenseHasToken?: boolean }[];
  };
  const row = listed.find((t) => t.id === T_DEAD);
  expect(row, 'the unlicensed tenant must still appear on the platform screen').toBeTruthy();
  expect(row!.licensed, 'the legacy boolean is unchanged — a token IS stored').toBe(true);
  expect(row!.licenseState).toBe('none');
  expect(row!.licenseHasToken).toBe(true);
});

test('T4 GET /api/license/status answers instead of 402ing — the "no licence" screen cannot deadlock', async () => {
  // It resolves the tenant through `peekEffectiveTenant`, which uses the RAW verifier. If that ever
  // becomes `validateAuth`, the endpoint that reports "you have no licence" starts 402ing itself.
  const r = await actingCall('GET', '/api/license/status');
  expect(r.status).toBe(200);
});

test('T4 POST /api/tenants/{uuid}/license — the REPAIR route — is not blocked by the gate it lifts', async () => {
  const r = await actingCall('POST', `/api/tenants/${T_DEAD}/license`, {});
  expect(r.status).not.toBe(402);
  // Issuance is off in CI, so the route reports that honestly rather than pretending to repair.
  expect(r.code).toBe('license_issuance_disabled');
  expect(introspectCalls).toEqual([]);
});

test('T4 /health, /healthz, /ready and /metrics call NO auth guard, so no gate can reach them', async () => {
  // These four are registered inline in server.ts (importing that module would boot a server), so
  // this is a source-level guard: with the path allowlist deleted, "health is exempt" is true only
  // because those handlers invoke no guard at all. Adding one would silently gate the probes.
  const src = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8');
  const GUARDS =
    /\b(validateAuth|requireRole|requireSuperAdmin|requireAnyAdmin|requireTenantAdmin|requireDeveloper|requireBlockAuthor|resolveTenant)\s*\(/;
  for (const probe of ['/health', '/healthz', '/ready', '/metrics']) {
    const start = src.indexOf(`router.add('GET', '${probe}'`);
    if (start < 0) continue; // /healthz is served by the ingress in some deployments
    const next = src.indexOf('router.add(', start + 10);
    const block = src.slice(start, next < 0 ? src.length : next);
    expect(GUARDS.test(block), `${probe} handler must call no auth guard`).toBe(false);
  }
  // …and at least /health and /ready must actually be registered, so the loop can't pass vacuously.
  expect(src).toContain("router.add('GET', '/health'");
  expect(src).toContain("router.add('GET', '/ready'");
});

// ---------------------------------------------------------------------------------------------
// The memo: two guards in one handler ⇒ one licence check.
// ---------------------------------------------------------------------------------------------

test('a handler that passes two guards checks the licence once per request (the WeakMap memo)', async () => {
  // POST /api/flows calls validateAuth and then ensureUser/resolve paths that authenticate again.
  const r = await actingCall('POST', '/api/flows', { name: 'ws2-memo' });
  expect(r.status).toBe(402);
  expect(introspectCalls.length).toBeLessThanOrEqual(1);
});
