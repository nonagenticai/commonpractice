// tests/acting-as-scope.test.ts — B2-3: a super_admin's `X-Active-Tenant-Id` scope-switch must scope
// CONTENT WRITES (not just reads) to the acting tenant. Regression for the bug where `resolveTenant`
// was claim-only, so a super_admin "acting as" tenant B wrote challenges into their HOME tenant A while
// reads were scoped to B → a just-created row 404'd and content leaked cross-tenant. Runs over real CI
// Postgres :5433 (RLS enforced via the GUC `resolveTenant` sets). Auth via the test override seam.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerRunRoutes } from '../src/host/run-controller';
import {
  db,
  users,
  tenants,
  challenges,
  buildingBlocks,
  blockVersions,
  flows,
  flowRuns,
  flowRunEvents,
  sandboxes,
  datasets,
  datasetRows,
  usageCounters,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import type { User } from '../src/types';
import type { FlowGraph } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';
import { requireScannedSource } from '../src/blocks/source-gate';

const ACTING = '00000000-0000-0000-0000-00000aa50001'; // the tenant being acted-as
const HOME_S = '00000000-0000-0000-0000-00000aa50002'; // the super_admin's own home tenant
const ABSENT = '00000000-0000-0000-0000-0000000000aa'; // a tenant id that is NOT provisioned
const SUPER_ID = '00000000-0000-0000-0000-00000aa5ad01';
const MEMBER_ID = '00000000-0000-0000-0000-00000aa5be01';
// super_admin whose HOME is HOME_S (proves the write does NOT land at home when acting-as).
const superAdmin: User = { id: SUPER_ID, email: 'aa-super@test', name: 'Sue Super', roles: ['super_admin'], tenantId: HOME_S };
// a plain member of ACTING (proves a non-super cannot scope-switch via the header).
const member: User = { id: MEMBER_ID, email: 'aa-member@test', name: 'Manny Member', roles: ['employee'], tenantId: ACTING };
const MARK = 'ZAASCOPE';
const BLOCK_PREFIX = 'ztest-acting-run-';

function asUser(u: User) {
  currentUser = u;
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

let currentUser: User = superAdmin;

const router = new Router();
registerChallengeRoutes(router);
registerRunRoutes(router);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const activeHeader = headers['X-Active-Tenant-Id'];
  const initialTenant =
    currentUser.roles.includes('super_admin') && /^[0-9a-f-]{36}$/i.test(activeHeader ?? '')
      ? activeHeader!
      : currentUser.tenantId!;
  // Mirrors server.ts's peekEffectiveTenant wrapper: a valid super-admin scope header establishes
  // the acting GUC before routes that intentionally rely on request-level scoping execute.
  const res = await withTenantDbAsRuntimeRoleForTests(initialTenant, () =>
    matched.handler(req, ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const challengeBody = (title: string) => ({ title, description: 'scope-switch regression', work_area: 'Claims' });

async function cleanup() {
  const testFlows = await db.select({ id: flows.id }).from(flows).where(inArray(flows.tenant_id, [ACTING, HOME_S]));
  if (testFlows.length) {
    const flowIds = testFlows.map((flow) => flow.id);
    const runs = await db.select({ id: flowRuns.id }).from(flowRuns).where(inArray(flowRuns.flow_id, flowIds));
    if (runs.length) await db.delete(flowRunEvents).where(inArray(flowRunEvents.run_id, runs.map((run) => run.id)));
    await db.delete(flowRuns).where(inArray(flowRuns.flow_id, flowIds));
    await db.delete(flows).where(inArray(flows.id, flowIds));
  }
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, SUPER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, SUPER_ID));
  const testDatasets = await db.select({ id: datasets.id }).from(datasets).where(inArray(datasets.tenant_id, [ACTING, HOME_S]));
  if (testDatasets.length) await db.delete(datasetRows).where(inArray(datasetRows.dataset_id, testDatasets.map((dataset) => dataset.id)));
  await db.delete(datasets).where(inArray(datasets.tenant_id, [ACTING, HOME_S]));
  const testBlocks = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(inArray(buildingBlocks.tenant_id, [ACTING, HOME_S]));
  if (testBlocks.length) await db.delete(blockVersions).where(inArray(blockVersions.block_id, testBlocks.map((block) => block.id)));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.tenant_id, [ACTING, HOME_S]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [ACTING, HOME_S]));
  await db.delete(users).where(inArray(users.id, [SUPER_ID, MEMBER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [ACTING, HOME_S]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: ACTING, name: 'Acting Org', slug: `acting-${MARK.toLowerCase()}` },
    { id: HOME_S, name: 'Super Home', slug: `home-${MARK.toLowerCase()}` },
  ]);
  await db.insert(users).values([
    { id: SUPER_ID, email: superAdmin.email, name: superAdmin.name, tenant_id: HOME_S },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: ACTING },
  ]);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('super_admin acting-as: a challenge write lands in the ACTING tenant and is readable there (not 404)', async () => {
  asUser(superAdmin);
  const created = await call('POST', '/api/challenges', challengeBody(`${MARK} acting write`), { 'X-Active-Tenant-Id': ACTING });
  expect(created.status).toBe(201);

  // The row is stamped with the ACTING tenant, NOT the super_admin's home tenant.
  const [row] = await db.select({ tenant: challenges.tenant_id }).from(challenges).where(eq(challenges.id, created.json.id));
  expect(row!.tenant).toBe(ACTING);

  // And the read (same scope-switch header) finds it — the read-after-create 404 is gone.
  const detail = await call('GET', `/api/challenges/${created.json.id}`, undefined, { 'X-Active-Tenant-Id': ACTING });
  expect(detail.status).toBe(200);
});

test('super_admin WITHOUT the header writes to their HOME tenant (claim fallback unchanged)', async () => {
  asUser(superAdmin);
  const created = await call('POST', '/api/challenges', challengeBody(`${MARK} home write`));
  expect(created.status).toBe(201);
  const [row] = await db.select({ tenant: challenges.tenant_id }).from(challenges).where(eq(challenges.id, created.json.id));
  expect(row!.tenant).toBe(HOME_S);
});

test('a non-super caller cannot scope-switch — the header is silently ignored (probe-resistant)', async () => {
  asUser(member); // home = ACTING; tries to write into HOME_S via the header
  const created = await call('POST', '/api/challenges', challengeBody(`${MARK} member no switch`), { 'X-Active-Tenant-Id': HOME_S });
  expect(created.status).toBe(201);
  const [row] = await db.select({ tenant: challenges.tenant_id }).from(challenges).where(eq(challenges.id, created.json.id));
  expect(row!.tenant).toBe(ACTING); // its own claim tenant, NOT the header
});

test('super_admin acting-as an UNPROVISIONED tenant is rejected (fail-closed, no phantom scope)', async () => {
  asUser(superAdmin);
  const created = await call('POST', '/api/challenges', challengeBody(`${MARK} absent`), { 'X-Active-Tenant-Id': ABSENT });
  expect(created.status).toBe(403);
  expect(created.json.error).toBe('tenant_not_provisioned');
});

test('super_admin with a malformed scope-switch header → 422 (diagnostic, super-only)', async () => {
  asUser(superAdmin);
  const created = await call('POST', '/api/challenges', challengeBody(`${MARK} bad header`), { 'X-Active-Tenant-Id': 'not-a-uuid' });
  expect(created.status).toBe(422);
  expect(created.json.error).toBe('INVALID_ACTIVE_TENANT_HEADER');
});

test('a scope-switched run uses only the acting tenant flow, block, dataset, sandbox, and run rows under cp_app', async () => {
  const descriptor = {
    inputs: { source: { type: 'dataset' as const, required: true } },
    outputs: { marker: { type: 'string' as const } },
    capabilities: { mockData: true },
  };
  const source = `export default {
    descriptor: ${JSON.stringify(descriptor)},
    async run(inputs, ctx) {
      const rows = await ctx.dataset(inputs.source);
      return { marker: rows[0]?.marker ?? 'missing' };
    }
  };`;
  const [block] = await db.insert(buildingBlocks).values({
    tenant_id: ACTING,
    slug: `${BLOCK_PREFIX}acting`,
    name: 'Acting dataset reader',
    category: 'data',
  }).returning();
  const [version] = await db.insert(blockVersions).values({
    block_id: block!.id,
    version: '1.0.0',
    status: 'stable',
    published_at: new Date(),
    descriptor,
    source_ts: requireScannedSource(source),
  }).returning();
  const graph: FlowGraph = {
    nodes: [{
      id: 'n1',
      blockId: block!.id,
      blockVersionId: version!.id,
      slug: block!.slug,
      label: 'Read acting dataset',
      category: 'data',
      config: { source: 'scope-data' },
      position: { x: 0, y: 0 },
    }],
    edges: [],
  };
  const [flow] = await db.insert(flows).values({
    tenant_id: ACTING,
    owner_id: SUPER_ID,
    name: `${MARK} run`,
    graph,
  }).returning();
  const [homeData, actingData] = await db.insert(datasets).values([
    { tenant_id: HOME_S, owner_id: SUPER_ID, name: 'Home data', slug: 'scope-data', source_type: 'json', columns: [{ name: 'marker', type: 'string' }], row_count: 1, status: 'ready' },
    { tenant_id: ACTING, owner_id: SUPER_ID, name: 'Acting data', slug: 'scope-data', source_type: 'json', columns: [{ name: 'marker', type: 'string' }], row_count: 1, status: 'ready' },
  ]).returning();
  await db.insert(datasetRows).values([
    { dataset_id: homeData!.id, idx: 0, data: { marker: 'HOME' } },
    { dataset_id: actingData!.id, idx: 0, data: { marker: 'ACTING' } },
  ]);

  asUser(superAdmin);
  const headers = { 'X-Active-Tenant-Id': ACTING, 'Idempotency-Key': crypto.randomUUID() };
  const started = await call('POST', '/api/runs', { flowId: flow!.id }, headers);
  expect(started.status).toBe(201);
  let terminal: any;
  for (let i = 0; i < 100; i++) {
    const current = await call('GET', `/api/runs/${started.json.runId}`, undefined, headers);
    if (current.json.status !== 'running') {
      terminal = current.json;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(terminal?.status).toBe('ok');
  const success = (terminal.trace as TraceEvent[]).find((event) => event.type === 'node_success');
  expect((success as { outputPreview: string }).outputPreview).toContain('"marker":"ACTING"');
  const [persistedRun] = await db.select().from(flowRuns).where(eq(flowRuns.id, started.json.runId));
  const [persistedSandbox] = await db.select().from(sandboxes).where(eq(sandboxes.id, started.json.sandboxId));
  expect(persistedRun!.tenant_id).toBe(ACTING);
  expect(persistedSandbox!.tenant_id).toBe(ACTING);

  const [foreignBlock] = await db.insert(buildingBlocks).values({
    tenant_id: HOME_S,
    slug: `${BLOCK_PREFIX}foreign`,
    name: 'Foreign block',
    category: 'data',
  }).returning();
  const [foreignVersion] = await db.insert(blockVersions).values({
    block_id: foreignBlock!.id,
    version: '1.0.0',
    status: 'stable',
    published_at: new Date(),
    descriptor,
    source_ts: requireScannedSource(source),
  }).returning();
  const [foreignFlow] = await db.insert(flows).values({
    tenant_id: ACTING,
    owner_id: SUPER_ID,
    name: `${MARK} foreign block run`,
    graph: {
      ...graph,
      nodes: [{ ...graph.nodes[0]!, blockId: foreignBlock!.id, blockVersionId: foreignVersion!.id }],
    },
  }).returning();
  const rejected = await call('POST', '/api/runs', { flowId: foreignFlow!.id }, {
    ...headers,
    'Idempotency-Key': crypto.randomUUID(),
  });
  expect(rejected.status).toBe(422);
  expect(rejected.json.error).toBe('missing_block_version');
  expect(await db.select().from(flowRuns).where(eq(flowRuns.flow_id, foreignFlow!.id))).toHaveLength(0);
}, 30_000);
