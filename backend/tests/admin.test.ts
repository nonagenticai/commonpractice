// tests/admin.test.ts — Phase 4 / C.1 enterprise admin: platform tenant lifecycle
// (super_admin), a read-only member roster, MCP API-key issuance/auth/revoke, and
// usage/spend aggregation. Against the live :5433 DB. Tenancy is the `tenant_id` claim
// (no switcher, no membership); a super_admin scope-switches into a tenant via the
// path/`?tenant=` target. Identity is controlled via __setAuthOverridesForTests.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  usageEvents,
  usageCounters,
  auditLog,
  withTenantDb,
  queryClient,
} from '../src/db/client';
import { DEMO_TENANT_ID, config } from '../src/config';
import { tryDecryptSecret } from '../src/host/secret-box';
import { assertTenantLicensed } from '../src/middleware/license-gate';
import {
  __setLicensesAdminForTests,
  LicensesAdminError,
  tenantLicenceSubjects,
  type LicensesAdminClient,
} from '../src/services/licenses-admin';
import {
  __setLicenseClientForTests,
  LicenseClientError,
  type LicenseClient,
  type LicenseIntrospectResponse,
} from '../src/services/license-client';
import { HttpError } from '../src/utils/http';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { registerMcpRoutes } from '../src/routes/mcp';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  brokerLlmCall,
  __setBrokerDepsForTests,
  type Provider,
} from '../src/host/llm-broker';
import type { User } from '../src/types';

// ⚠️ UUIDs, NOT `lic-1`. `member_entitlements.license_id` / `.license_subject_id` are `uuid`
// columns (0089) because the licences service returns UUIDs — a fake emitting an opaque string
// cannot be stored, and the onboarding routes surface that as a 400. LIC and SUBJ stay VISIBLY
// different from one another: carrying both only matters because they are not interchangeable.
const LIC = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const SUBJ = (n: number) => `11111111-1111-4111-8111-00000000000${n}`;


const A_ID = '00000000-0000-0000-0000-0000000ad001'; // platform super_admin
const B_ID = '00000000-0000-0000-0000-0000000ad002'; // plain member
const T_ID = '00000000-0000-0000-0000-0000000ad0a1'; // a fixed tenant for the roster/usage tests
const IDS = [A_ID, B_ID];
const TENANT_IDS = [T_ID];
// Ada is the platform super_admin who provisions tenants and (via scope-switch)
// administers them; Ben is a plain member of T_ID, authorized only by his claim.
const userA: User = { id: A_ID, email: 'ada.admin@test.dev', name: 'Ada Admin', roles: ['super_admin'] };
const userB: User = { id: B_ID, email: 'ben.member@test.dev', name: 'Ben Member', roles: ['employee'], tenantId: T_ID };

const router = new Router();
registerAdminRoutes(router);
registerMcpRoutes(router);

let currentUser: User = userA;

function as(u: User) {
  currentUser = u;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const pathname = path.split('?')[0]!; // the router matches on pathname, not query
  const m = router.match(method, pathname);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return m.handler(new Request(`http://t${path}`, init), ...m.params);
}

async function mcpRpc(method: string, bearer: string) {
  const m = router.match('POST', '/api/mcp/jsonrpc')!;
  const res = await m.handler(
    new Request('http://t/api/mcp/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    }),
  );
  return res;
}

// ONE round trip, deliberately. Every statement here is trivial, but each separate query costs a
// full round trip to the dev container, and ~9 of them exceeds the 5 s `beforeEach` budget on a
// constrained Docker — a budget bun 1.3.14 ignores `bunfig.toml`'s `[test] timeout` for, so it
// cannot simply be raised. The result was a whole file of phantom "hook timed out" failures that
// look exactly like real ones. Batched, the same work is a single statement.
//
// Ordering matters and is preserved: dependants first, `users.tenant_id` nulled before tenants go
// (FK), tenants last. Ids are compile-time constants, so interpolation here is not a injection
// surface — and a parameterised multi-statement is not possible over the simple query protocol.
const CLEANUP_SQL = `
  DELETE FROM audit_log      WHERE actor_id IN ('${A_ID}','${B_ID}');
  DELETE FROM audit_log      WHERE target_id IN ('${A_ID}','${B_ID}');
  DELETE FROM usage_events   WHERE user_id  IN ('${A_ID}','${B_ID}');
  DELETE FROM usage_counters WHERE user_id  IN ('${A_ID}','${B_ID}');
  UPDATE users SET tenant_id = NULL WHERE id IN ('${A_ID}','${B_ID}');
  DELETE FROM users          WHERE id       IN ('${A_ID}','${B_ID}');
  DELETE FROM tenants        WHERE id       IN ('${T_ID}');
  DELETE FROM tenants        WHERE name     IN ('Acme Corp','Beta Inc','Raw Throw Org','Conflict Org','Blip Org');
`;

/** The per-test seed, appended to the cleanup so the whole hook is ONE round trip (see above). */
const SEED_SQL = `
  INSERT INTO tenants (id, name, slug) VALUES ('${T_ID}', 'Roster Org', 'roster-${T_ID.slice(-6)}')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO users (id, email, name, tenant_id) VALUES
    ('${A_ID}', 'ada.admin@test.dev', 'Ada Admin', NULL),
    ('${B_ID}', 'ben.member@test.dev', 'Ben Member', '${T_ID}')
    ON CONFLICT (id) DO NOTHING;
`;

async function cleanup() {
  await queryClient.unsafe(CLEANUP_SQL);
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => currentUser });
  __setBrokerDepsForTests(undefined);
  // Cleanup + seed in a single statement: the fixed tenant and its one member (Ben); Ada is
  // platform staff with no home tenant.
  await queryClient.unsafe(CLEANUP_SQL + SEED_SQL);
  as(userA);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setBrokerDepsForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setLicenseClientForTests(undefined);
  setIssuance(false);
  setGate(false);
  await cleanup();
}, 30_000);

// ---- P0: a tenant a super_admin creates must be USABLE, not 402-trapped ----
//
// Issuance used to happen only when a user was onboarded THROUGH CP, so a tenant created here stayed
// unlicensed — and with the fail-closed Gate 2 enforced in prod, everyone who reached it (SSO/JIT,
// or a member moved in by hand) got `402 license_required` on every non-admin path. Live evidence:
// tenant `Better Results Group` with `license_token_encrypted IS NULL` and 0 users.

function setIssuance(on: boolean) {
  (config.license as { issuanceEnabled: boolean }).issuanceEnabled = on;
}
function setGate(on: boolean) {
  (config.license as { enforceGate2: boolean }).enforceGate2 = on;
}

/** Fake licences-admin SA client: records the registry + mint calls, returns deterministic tokens. */
function makeLicensesAdmin() {
  const calls = {
    ensureTenantRegistered: [] as Array<{ tenantId: string; name: string }>,
    createLicense: [] as Array<{ subjectId: string; tenantId: string }>,
  };
  let n = 0;
  const client: LicensesAdminClient = {
    async ensureTenantRegistered(tenantId, name) {
      calls.ensureTenantRegistered.push({ tenantId, name });
    },
    async createLicense(subjectId, tenantId) {
      calls.createLicense.push({ subjectId, tenantId });
      return { licenseId: LIC(++n), subjectId: SUBJ(n) };
    },
    async createToken(licenseId) {
      return { token: `token-${licenseId}` };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  return { client, calls };
}

/** Fake introspection client for Gate 2 — the same seam tests/license-gate.test.ts uses. */
function makeLicenseClient(byToken: Record<string, LicenseIntrospectResponse>): LicenseClient {
  return {
    async introspect(token: string) {
      const r = byToken[token];
      if (!r) throw new LicenseClientError(404, 'unknown token');
      return r;
    },
  };
}

const activeFor = (tenantId: string): LicenseIntrospectResponse => ({
  active: true,
  tenant_id: tenantId,
  app: { key: config.license.appKey },
  status: 'active',
  expires_at: '2999-01-01T00:00:00Z',
});

async function tenantToken(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ t: tenants.license_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tryDecryptSecret(row?.t ?? null);
}

/** The status Gate 2 would produce for this tenant (200 = the tenant can use the product). */
async function gateStatus(tenantId: string): Promise<number> {
  try {
    await assertTenantLicensed(new Request('http://t/api/flows'), tenantId);
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

test('created tenant is licensed at birth and passes Gate 2 (was: 402 on every screen)', async () => {
  setIssuance(true);
  const { client, calls } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  try {
    const created = await call('POST', '/api/tenants', { name: 'Acme Corp', byoMode: 'local_allowed' });
    expect(created.status).toBe(201);
    const { tenant } = (await created.json()) as { tenant: { id: string; slug: string } };

    // Registered under the SLUG (the licences service refuses to mint for an unregistered tenant),
    // then minted — bound to the creating super-admin, since a fresh tenant has no users to bind to.
    expect(calls.ensureTenantRegistered).toEqual([{ tenantId: tenant.id, name: tenant.slug }]);
    // A2: held by CP's synthetic tenant subject, never a person (bound to a person, the tenant
    // licence WAS that person's seat licence).
    expect(calls.createLicense).toEqual([{ subjectId: tenantLicenceSubjects(tenant.id)[0], tenantId: tenant.id }]);
    const token = await tenantToken(tenant.id);
    expect(token).toBe(`token-${LIC(1)}`);

    // The proof that matters: with Gate 2 ENFORCED (prod's setting) the empty tenant is usable.
    setGate(true);
    __setLicenseClientForTests(makeLicenseClient({ [token!]: activeFor(tenant.id) }));
    expect(await gateStatus(tenant.id)).toBe(200); // before the fix: 402 license_required

    await db.delete(tenants).where(inArray(tenants.id, [tenant.id]));
  } finally {
    setGate(false);
    setIssuance(false);
    __setLicenseClientForTests(undefined);
    __setLicensesAdminForTests(undefined);
  }
}, 30_000); // ⛔ MEASURED, not theoretical: this test timed out at exactly 5000ms in a real run
// (12025.21ms total) under DB load — it dispatches through `POST /api/tenants` (createTenant),
// which is invisible to the raw db.*-call counter (see check-hook-timeouts.ts's test-body-audit
// note) because the real round trips happen inside the route handler + license-provisioning, not
// as literal `db.*` calls in this file.

test('POST /api/tenants/:id/license repairs a tenant stranded without one; idempotent', async () => {
  // T_ID is the live prod shape: a tenant row with no stored token. Gate 2 402s it today.
  setGate(true);
  __setLicenseClientForTests(makeLicenseClient({}));
  expect(await gateStatus(T_ID)).toBe(402);
  setGate(false);

  // With issuance OFF the repair must REFUSE rather than report a success that changed nothing.
  const refused = await call('POST', `/api/tenants/${T_ID}/license`);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error?: string }).error).toBe('license_issuance_disabled');

  setIssuance(true);
  const { client, calls } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  try {
    const fixed = await call('POST', `/api/tenants/${T_ID}/license`);
    expect(fixed.status).toBe(200);
    const body = (await fixed.json()) as { licensed: boolean; alreadyLicensed: boolean; boundTo: string };
    expect(body).toMatchObject({ licensed: true, alreadyLicensed: false, boundTo: B_ID }); // oldest member
    const token = await tenantToken(T_ID);
    expect(token).toBe(`token-${LIC(1)}`);

    setGate(true);
    __setLicenseClientForTests(makeLicenseClient({ [token!]: activeFor(T_ID) }));
    expect(await gateStatus(T_ID)).toBe(200);
    setGate(false);

    // Re-running it never mints a second licence.
    const again = await call('POST', `/api/tenants/${T_ID}/license`);
    expect(((await again.json()) as { alreadyLicensed: boolean }).alreadyLicensed).toBe(true);
    expect(calls.createLicense.length).toBe(1);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'tenant.license_issue'));
    expect(audits.length).toBe(1);
  } finally {
    setGate(false);
    setIssuance(false);
    __setLicenseClientForTests(undefined);
    __setLicensesAdminForTests(undefined);
  }
});

test('createTenant: a NON-HttpError escaping issuance is a 502 licences_unavailable and leaves NO CP row', async () => {
  // A licence failure deletes the just-inserted row (services/tenant-service.ts step 4), so there is
  // never a half-created workspace to "create again" over.
  setIssuance(true);
  const exploding: LicensesAdminClient = {
    async ensureTenantRegistered() { throw new TypeError('undefined is not a function'); },
    async createLicense() { return { licenseId: LIC(7), subjectId: SUBJ(7) }; },
    async createToken() { return { token: 'x' }; },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  __setLicensesAdminForTests(exploding);
  try {
    const res = await call('POST', '/api/tenants', { name: 'Raw Throw Org', byoMode: 'local_allowed' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('licences_unavailable');
    expect(body.message ?? '').toContain('NOT created');
    const rows = await db.select().from(tenants).where(eq(tenants.slug, 'raw-throw-org'));
    expect(rows).toEqual([]);
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('createTenant: a real upstream 4xx (slug collision) is NOT retried — as502 must not hide it as transient', async () => {
  // `ensureTenantRegistered` 409s on a slug already registered under a different tenant id — a data
  // conflict that fails identically on every attempt. `as502` flattens this to HttpError(502, ...),
  // but it now carries `details.upstreamStatus: 409`, so `isTransientLicenseError` must see through
  // the flattening and NOT retry. Before the fix this call count would be 3 (LICENSE_RETRY_ATTEMPTS).
  setIssuance(true);
  let registerAttempts = 0;
  const slugCollision: LicensesAdminClient = {
    async ensureTenantRegistered() {
      registerAttempts++;
      throw new LicensesAdminError(409, "register tenant 'conflict-org' failed: HTTP 409");
    },
    async createLicense() { return { licenseId: LIC(8), subjectId: SUBJ(8) }; },
    async createToken() { return { token: 'unused' }; },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  __setLicensesAdminForTests(slugCollision);
  try {
    const res = await call('POST', '/api/tenants', { name: 'Conflict Org', byoMode: 'local_allowed' });
    expect(res.status).toBe(502); // response contract unchanged — still a flat 502
    expect(registerAttempts).toBe(1); // exactly ONE attempt: not retried
    expect(((await res.json()) as { error?: string }).error).toBe('licences_unavailable');
    const rows = await db.select().from(tenants).where(eq(tenants.slug, 'conflict-org'));
    expect(rows).toEqual([]); // the licence failure removed the row again
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('createTenant: a real upstream 5xx blip IS retried through as502', async () => {
  // The complement of the test above: a genuine upstream 503 must still ride out the retry — the
  // fix must not accidentally turn EVERY as502'd error non-transient.
  setIssuance(true);
  let attempts = 0;
  const blip: LicensesAdminClient = {
    async ensureTenantRegistered() {},
    async createLicense() {
      attempts++;
      if (attempts < 3) throw new LicensesAdminError(503, 'licenses admin transport error: timeout');
      return { licenseId: LIC(9), subjectId: SUBJ(9) };
    },
    async createToken() { return { token: 'tok-recovered' }; },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  __setLicensesAdminForTests(blip);
  try {
    const res = await call('POST', '/api/tenants', { name: 'Blip Org', byoMode: 'local_allowed' });
    expect(res.status).toBe(201); // recovered by the 3rd attempt
    expect(attempts).toBe(3);
    const [t] = await db.select().from(tenants).where(eq(tenants.slug, 'blip-org'));
    await db.delete(tenants).where(inArray(tenants.id, [t!.id]));
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('POST /api/tenants/:id/license?force=1 RE-MINTS over a stored token that no longer works', async () => {
  // A stored blob proves a token was written once, not that it still works — revoked upstream, or
  // undecryptable after a secret-box rotation. The default call reported `alreadyLicensed` while
  // the tenant kept 402-ing, which is the "repaired but still broken" trap.
  setIssuance(true);
  const { client, calls } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  try {
    const first = await call('POST', `/api/tenants/${T_ID}/license`);
    expect(first.status).toBe(200);
    expect(calls.createLicense.length).toBe(1);
    const firstToken = await tenantToken(T_ID);

    // Default: idempotent no-op, mints nothing.
    const noop = await call('POST', `/api/tenants/${T_ID}/license`);
    expect(((await noop.json()) as { alreadyLicensed: boolean }).alreadyLicensed).toBe(true);
    expect(calls.createLicense.length).toBe(1);

    // force=1: mints again and replaces the stored token.
    const forced = await call('POST', `/api/tenants/${T_ID}/license?force=1`);
    expect(forced.status).toBe(200);
    const body = (await forced.json()) as { alreadyLicensed: boolean; reminted: boolean };
    expect(body.alreadyLicensed).toBe(false);
    expect(body.reminted).toBe(true);
    expect(calls.createLicense.length).toBe(2);
    expect(await tenantToken(T_ID)).not.toBe(firstToken);
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('force does NOT clear a working token when the licences service is down', async () => {
  // Mint first, then force-repair against a dead service. The new blob is written only after a
  // successful mint, so the tenant must keep the licence it already had rather than being left
  // with nothing by an operator who guessed wrong about it being broken.
  setIssuance(true);
  const { client } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  await call('POST', `/api/tenants/${T_ID}/license`);
  const good = await tenantToken(T_ID);
  expect(good).toBeTruthy();

  const dead: LicensesAdminClient = {
    async ensureTenantRegistered() {},
    async createLicense() { throw new HttpError(502, 'license_provisioning_failed', 'down'); },
    async createToken() { return { token: 'never' }; },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  __setLicensesAdminForTests(dead);
  try {
    const res = await call('POST', `/api/tenants/${T_ID}/license?force=1`);
    expect(res.status).toBe(502);
    expect(await tenantToken(T_ID)).toBe(good); // untouched
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('the all-tenants list flags an UNLICENSED tenant — the 402 trap is now visible', async () => {
  // Without this the only way to find a 402-trapped workspace was to query the database, which is
  // how `Better Results Group` sat unusable in prod. The list must also never carry the token.
  setIssuance(true);
  const { client } = makeLicensesAdmin();
  __setLicensesAdminForTests(client);
  try {
    const before = (await (await call('GET', '/api/admin/tenants')).json()) as {
      tenants: { id: string; licensed: boolean }[];
    };
    expect(before.tenants.find((t) => t.id === T_ID)?.licensed).toBe(false);
    expect(JSON.stringify(before)).not.toContain('token-lic');

    await call('POST', `/api/tenants/${T_ID}/license`);

    const after = (await (await call('GET', '/api/admin/tenants')).json()) as {
      tenants: { id: string; licensed: boolean }[];
    };
    expect(after.tenants.find((t) => t.id === T_ID)?.licensed).toBe(true);
    expect(JSON.stringify(after)).not.toContain('token-lic'); // still only a boolean
  } finally {
    setIssuance(false);
    __setLicensesAdminForTests(undefined);
  }
});

test('super_admin creates an EMPTY tenant; it appears in GET /api/admin/tenants', async () => {
  const created = await call('POST', '/api/tenants', { name: 'Acme Corp', byoMode: 'local_allowed' });
  expect(created.status).toBe(201);
  const { tenant } = (await created.json()) as { tenant: { id: string; slug: string } };
  expect(tenant.id).toBeTruthy();

  const list = await call('GET', '/api/admin/tenants');
  expect(list.status).toBe(200);
  const body = (await list.json()) as { tenants: { id: string; memberCount: number }[] };
  const row = body.tenants.find((t) => t.id === tenant.id);
  expect(row).toBeTruthy();
  expect(row!.memberCount).toBe(0); // created empty — first admin is onboarded in C.2

  await db.delete(tenants).where(inArray(tenants.id, [tenant.id]));
});

test('member (no tenant_admin role) → 403 on the roster; super_admin scope-switches in', async () => {
  // Ben is a member of T_ID — he cannot read its admin roster.
  as(userB);
  const denied = await call('GET', `/api/tenants/${T_ID}/members`);
  expect(denied.status).toBe(403);

  // Ada (super_admin) scope-switches into T_ID and reads the roster (Ben is in it).
  as(userA);
  const ok = await call('GET', `/api/tenants/${T_ID}/members`);
  expect(ok.status).toBe(200);
  const { members } = (await ok.json()) as { members: { userId: string }[] };
  expect(members.some((m) => m.userId === B_ID)).toBe(true);
});

test('GET /api/tenant returns the caller\'s own tenant (from the claim)', async () => {
  as(userB);
  const res = await call('GET', '/api/tenant');
  expect(res.status).toBe(200);
  const { tenant } = (await res.json()) as { tenant: { id: string; name: string } };
  expect(tenant.id).toBe(T_ID);
  expect(tenant.name).toBe('Roster Org');
});

test('MCP API key: issue → external Bearer authenticates → revoke → 401', async () => {
  const created = await call('POST', '/api/tenants', { name: 'Acme Corp', byoMode: 'local_allowed' });
  const { tenant } = (await created.json()) as { tenant: { id: string } };

  const issued = await call('POST', `/api/tenants/${tenant.id}/mcp-keys`, { name: 'ext-client' });
  expect(issued.status).toBe(201);
  const key = (await issued.json()) as { id: string; key: string };
  expect(key.key.startsWith('cp_mcp_')).toBe(true);

  // The raw key authenticates an external MCP client (independent of AUTH_BYPASS).
  const ok = await mcpRpc('tools/list', key.key);
  expect(ok.status).toBe(200);
  const okBody = (await ok.json()) as { result?: { tools: unknown[] } };
  expect(Array.isArray(okBody.result?.tools)).toBe(true);

  // List shows the prefix, never the secret.
  const list = await call('GET', `/api/tenants/${tenant.id}/mcp-keys`);
  const listed = (await list.json()) as { keys: { id: string; keyPrefix: string }[] };
  expect(listed.keys.length).toBe(1);
  expect(JSON.stringify(listed)).not.toContain(key.key);

  // Revoke → the same Bearer is now rejected.
  const del = await call('DELETE', `/api/tenants/${tenant.id}/mcp-keys/${key.id}`);
  expect(del.status).toBe(200);
  const after = await mcpRpc('tools/list', key.key);
  expect(after.status).toBe(401);

  await db.delete(tenants).where(inArray(tenants.id, [tenant.id]));
});

test('a metered call stamps usage_events; /api/tenants/:id/usage aggregates it', async () => {
  // Ben's home tenant is T_ID; a brokered call attributes usage to it.
  const provider: Provider = async (req) => ({ text: `echo:${req.prompt}`, tokensIn: 12, tokensOut: 8 });
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  // Run the call in the same tenant context an authenticated request would establish.
  // The explicit context is authoritative for both RLS and scope-switched metering.
  const out = await withTenantDb(T_ID, () =>
    brokerLlmCall(B_ID, { model: 'demo-model', prompt: 'hi' }),
  );
  expect(out.ok).toBe(true);

  const events = await db
    .select({ tenant_id: usageEvents.tenant_id, model: usageEvents.model })
    .from(usageEvents)
    .where(inArray(usageEvents.user_id, [B_ID]));
  expect(events.length).toBe(1);
  expect(events[0]!.tenant_id).toBe(T_ID);
  expect(events[0]!.model).toBe('demo-model');

  // The admin aggregate: Ada (super_admin) scope-switches into T_ID via the path param.
  as(userA);
  const usage = await call('GET', `/api/tenants/${T_ID}/usage?range=30`);
  expect(usage.status).toBe(200);
  const agg = (await usage.json()) as {
    stats: { calls: number };
    byModel: { model: string }[];
  };
  // ⛔ `toBe(1)`, NOT `toBeGreaterThanOrEqual(1)`. This assertion used the loose form, and that
  // looseness is precisely why prod ran for weeks with `/usage` reporting 878 calls where the
  // humans had made 270: 608 platform translation rows were being counted as this tenant's, and
  // a `>= 1` cannot tell a correct aggregate from an inflated one. An exact count is the only
  // shape that can. This tenant made exactly one brokered call above (migration 0063,
  // tests/usage-metrics-platform.test.ts).
  expect(agg.stats.calls).toBe(1);
  expect(agg.byModel.some((m) => m.model === 'demo-model')).toBe(true);
});
