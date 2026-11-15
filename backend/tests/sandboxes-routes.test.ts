// tests/sandboxes-routes.test.ts — Session 4 platform Ops sandbox routes.
// list (filter/search/paginate + per-status counts), inspect (recent runs),
// pause/resume, and the platform role gate. Test sandboxes are isolated from the
// seeded demo data via unique project markers passed as the search query.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerSandboxRoutes } from '../src/routes/sandboxes';
import {
  db,
  users,
  tenants,
  flows,
  flowRuns,
  sandboxes,
  usageCounters,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { Sandbox } from '../src/db/schema';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000005b0100';
const platform: User = { id: OWNER_ID, email: 'plat@test', name: 'Platform Admin', roles: ['super_admin', 'employee'], tenantId: DEMO_TENANT_ID };
const employee: User = { id: OWNER_ID, email: 'emp@test', name: 'Just Employee', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const SLUG_PREFIX = 'ztest-sbr-';
const EX_OWNER = '00000000-0000-4000-8000-0000005b0199'; // offboarded owner (provisioning-refusal test)
const OTHER_TENANT = '00000000-0000-4000-8000-0000005b0188';
const OTHER_OWNER = '00000000-0000-4000-8000-0000005b0189';

/** Role-enforcing override (the default test seam bypasses requireRole). */
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
registerSandboxRoutes(router);

async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDbAsRuntimeRoleForTests(DEMO_TENANT_ID, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let idx = 0;
async function makeSandbox(status: Sandbox['status'], project: string): Promise<Sandbox> {
  const [row] = await db
    .insert(sandboxes)
    .values({ owner_id: OWNER_ID, slug: `${SLUG_PREFIX}${idx++}`, project, status, last_active_at: new Date(), tenant_id: DEMO_TENANT_ID })
    .returning();
  return row!;
}

async function cleanup() {
  await db.delete(flowRuns).where(eq(flowRuns.triggered_by, OWNER_ID));
  await db.delete(flows).where(eq(flows.owner_id, OWNER_ID));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, OWNER_ID));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, OTHER_OWNER));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, EX_OWNER));
  // BEFORE the users delete: usage_counters.user_id is a plain FK to users, so leftover
  // counters from the usage test would make the user delete fail with a 23503.
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, [OWNER_ID, OTHER_OWNER]));
  await db.delete(users).where(inArray(users.id, [OWNER_ID, EX_OWNER, OTHER_OWNER]));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
}

// ⛔ Explicit hook timeout: bun 1.3.14 does NOT apply bunfig.toml's `[test] timeout` to HOOKS —
// they get a fixed 5 s, and this hook's cleanup deletes across four tables. Over budget it reports
// as `(fail) (unnamed) [5003ms]`, which names neither the file nor the cause. Same remedy as
// keycloak.test.ts:39 and the ontology-i18n fix in #155.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: OWNER_ID, email: platform.email, name: platform.name, avatar_initials: 'PA' }).onConflictDoNothing();
  install(platform);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => install(platform));

test('non-super_admin user is rejected (403)', async () => {
  install(employee);
  const r = await callJson('GET', '/api/sandboxes');
  expect(r.status).toBe(403);
});

test('list returns per-status counts + filters by status, scoped by search marker', async () => {
  const M = 'ZSBROUTE';
  await makeSandbox('running', M);
  await makeSandbox('running', M);
  await makeSandbox('idle', M);
  await makeSandbox('suspended', M);
  await makeSandbox('error', M);

  const all = await callJson('GET', `/api/sandboxes?q=${M}`);
  expect(all.status).toBe(200);
  expect(all.json.counts).toMatchObject({ all: 5, running: 2, idle: 1, suspended: 1, error: 1 });
  expect(all.json.items).toHaveLength(5);
  expect(all.json.items[0].owner.name).toBe('Platform Admin');

  const running = await callJson('GET', `/api/sandboxes?q=${M}&status=running`);
  expect(running.json.total).toBe(2);
  expect(running.json.items.every((i: { status: string }) => i.status === 'running')).toBe(true);
});

test('list paginates at the page size', async () => {
  const M = 'ZSBPAGE';
  for (let i = 0; i < 13; i++) await makeSandbox('idle', M);
  const p1 = await callJson('GET', `/api/sandboxes?q=${M}&page=1`);
  expect(p1.json.total).toBe(13);
  expect(p1.json.items).toHaveLength(12); // PAGE_SIZE
  const p2 = await callJson('GET', `/api/sandboxes?q=${M}&page=2`);
  expect(p2.json.items).toHaveLength(1);
});

test('platform list, inspect, pause, and resume reach another tenant under cp_app RLS', async () => {
  const marker = 'ZSB-CROSS-TENANT';
  await db.insert(tenants).values({ id: OTHER_TENANT, name: 'Sandbox Other', slug: 'ztest-sb-other' });
  await db.insert(users).values({
    id: OTHER_OWNER,
    tenant_id: OTHER_TENANT,
    email: 'sandbox-other@test',
    name: 'Sandbox Other',
  });
  const [sandbox] = await db.insert(sandboxes).values({
    owner_id: OTHER_OWNER,
    tenant_id: OTHER_TENANT,
    slug: `${SLUG_PREFIX}cross-tenant`,
    project: marker,
    status: 'idle',
    is_primary: true,
  }).returning();

  const listed = await callJson('GET', `/api/sandboxes?q=${marker}`);
  expect(listed.status).toBe(200);
  expect(listed.json.items.map((item: { id: string }) => item.id)).toEqual([sandbox!.id]);
  expect((await callJson('GET', `/api/sandboxes/${sandbox!.id}`)).status).toBe(200);

  const paused = await callJson('POST', `/api/sandboxes/${sandbox!.id}/pause`);
  expect(paused.status).toBe(200);
  expect(paused.json.suspension_reason).toBe('admin');
  const resumed = await callJson('POST', `/api/sandboxes/${sandbox!.id}/resume`);
  expect(resumed.status).toBe(200);
  expect(resumed.json.status).toBe('idle');
});

test('inspect returns the sandbox + its recent runs', async () => {
  const sb = await makeSandbox('idle', 'ZSBINSPECT');
  const [flow] = await db.insert(flows).values({ name: 'inspect-flow', owner_id: OWNER_ID, graph: { nodes: [], edges: [] }, tenant_id: DEMO_TENANT_ID }).returning();
  await db.insert(flowRuns).values({
    flow_id: flow!.id,
    triggered_by: OWNER_ID,
    sandbox_id: sb.id,
    status: 'ok',
    total_ms: 1234,
    total_cost_usd: '0.005',
    llm_calls: 1,
    finished_at: new Date(),
    tenant_id: DEMO_TENANT_ID,
  });

  const r = await callJson('GET', `/api/sandboxes/${sb.id}`);
  expect(r.status).toBe(200);
  expect(r.json.id).toBe(sb.id);
  expect(r.json.recentRuns).toHaveLength(1);
  expect(r.json.recentRuns[0]).toMatchObject({ flowName: 'inspect-flow', status: 'ok', totalMs: 1234, llmCalls: 1 });
});

test('pause then resume flips a sandbox suspended → idle', async () => {
  const sb = await makeSandbox('running', 'ZSBPAUSE');
  const paused = await callJson('POST', `/api/sandboxes/${sb.id}/pause`);
  expect(paused.status).toBe(200);
  expect(paused.json.status).toBe('suspended');

  const resumed = await callJson('POST', `/api/sandboxes/${sb.id}/resume`);
  expect(resumed.status).toBe(200);
  expect(resumed.json.status).toBe('idle');
});

test('owner can resume an idle-watchdog pause but not an administrative pause', async () => {
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, OWNER_ID));
  const [sandbox] = await db.insert(sandboxes).values({
    owner_id: OWNER_ID,
    tenant_id: DEMO_TENANT_ID,
    slug: `${SLUG_PREFIX}owner-primary`,
    status: 'suspended',
    suspension_reason: 'idle',
    is_primary: true,
  }).returning();
  install(employee);
  const visible = await callJson('GET', '/api/sandboxes/me');
  expect(visible.status).toBe(200);
  expect(visible.json).toMatchObject({ id: sandbox!.id, suspensionReason: 'idle' });

  const resumed = await callJson('POST', '/api/sandboxes/me/resume');
  expect(resumed.status).toBe(200);
  expect(resumed.json.status).toBe('idle');

  await db.update(sandboxes).set({ status: 'suspended', suspension_reason: 'admin' }).where(eq(sandboxes.id, sandbox!.id));
  const refused = await callJson('POST', '/api/sandboxes/me/resume');
  expect(refused.status).toBe(422);
  expect(refused.json.error).toBe('sandbox_admin_suspended');
});

test('provisioning for an OFFBOARDED owner is refused (422), no sandbox created', async () => {
  // Provisioning is a GRANT, not attribution, so the 0050 tombstone rule applies: an offboarded
  // person is not a valid owner. `ownerId` arrives as a bare caller-supplied uuid with no
  // membership check anywhere in the route, so this lookup is the only gate — without the filter a
  // super_admin could mint a sandbox owned by someone who can never sign in to use it.
  // RFC-4122-valid v4 shape: the route body runs through zod `.uuid()`, which rejects a zero
  // version nibble as a "validation" error long before the owner lookup — the same trap
  // tenant-users.test.ts documents at its constants.
  const ex = EX_OWNER;
  // `onConflictDoNothing` + `cleanup()` membership: a fixed id on a long-lived shared dev container
  // means debris from an interrupted run would otherwise fail every later run on a duplicate key.
  await db.insert(users).values({
    id: ex,
    email: 'ex-owner@test',
    name: 'Ex Owner',
    deleted_at: new Date('2026-07-01T00:00:00Z'),
  }).onConflictDoNothing({ target: users.id });
  try {
    const res = await callJson('POST', '/api/sandboxes', { ownerId: ex });
    expect(res.status).toBe(422);
    expect((res.json as { error: string }).error).toBe('owner_not_found');
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.owner_id, ex));
    expect(rows.length).toBe(0);
  } finally {
    await db.delete(sandboxes).where(eq(sandboxes.owner_id, ex));
    await db.delete(users).where(eq(users.id, ex));
  }
});

test('inspect on a missing sandbox is 404', async () => {
  const r = await callJson('GET', '/api/sandboxes/00000000-0000-0000-0000-0000005bffff');
  expect(r.status).toBe(404);
});

// Guards `usageTodayFor()`, which was rewritten to SUM/GROUP BY over usage_counters.
//
// WHY THIS IS SINGLE-TENANT: the real defect it protects against — one user holding a counter
// row PER TENANT per day, where the unaggregated reader kept whichever row the planner emitted
// last — is UNREACHABLE until 0059 drops `usage_counters_user_day_uq (user_id, day)`, because
// that constraint currently makes the two-row state impossible to create. So this asserts the
// reachable half: the aggregate still reports the ordinary single-tenant figures exactly (a
// broken SUM, cast, or GROUP BY shape would show up here). The cross-tenant assertion — seed
// two tenants for one owner, expect the SUM — becomes writable the moment 0059 lands and should
// be added to this test then. Until then it is verified only at the SQL level.
//
// ⛔ ALSO HALF OF A MATCHED PAIR (0061). Its twin is 'the fleet LLM-calls headline counts platform
// load as well as human calls' in tests/ops-metrics.test.ts, which seeds the SAME row shape
// (llm_calls = 3, platform_llm_calls = 5) and asserts 8 where this one asserts 3. Neither number
// is meaningful alone; together they PIN A DELIBERATE ASYMMETRY:
//   * this figure sits in a PER-PERSON row of the sandbox list, labelled as that named human's
//     usage today, and answers "how much is this employee using". Platform background work is not
//     that — attributing 608 drainer calls to whoever last clicked Backfill is a false statement
//     about a person, printed next to their name.
//   * the /it-dash figure is the FLEET-LOAD headline, where a background call is exactly as real
//     as a human one.
// Anyone "harmonising" the two queries reds exactly one of these two tests.
test('list + inspect report today usage from usage_counters (aggregated, HUMAN calls only)', async () => {
  // REVERT THAT TURNS THIS RED: change routes/sandboxes.ts:56 to
  // `SUM(llm_calls + platform_llm_calls)` — llmCallsToday becomes 8.
  const M = 'ZSBUSAGE';
  const sb = await makeSandbox('idle', M);
  await db.insert(usageCounters).values({
    user_id: OWNER_ID,
    tenant_id: DEMO_TENANT_ID,
    day: new Date().toISOString().slice(0, 10),
    llm_calls: 3,
    platform_llm_calls: 5,
    spend_usd: '1.250000',
  });

  const list = await callJson('GET', `/api/sandboxes?q=${M}`);
  expect(list.status).toBe(200);
  expect(list.json.items).toHaveLength(1);
  expect(
    list.json.items[0].llmCallsToday,
    "this owner made 3 calls; the 5 platform calls are NOT theirs and must not appear in their row",
  ).toBe(3);
  expect(list.json.items[0].costTodayUsd).toBeCloseTo(1.25, 6);

  const detail = await callJson('GET', `/api/sandboxes/${sb.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.llmCallsToday).toBe(3);
  expect(detail.json.costTodayUsd).toBeCloseTo(1.25, 6);
});
