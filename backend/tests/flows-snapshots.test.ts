// tests/flows-snapshots.test.ts — §3-H flow history (list / view / checkpoint /
// restore) over flow_snapshots. Driven through the live router against CI/dev
// Postgres (:5433), auth via __setAuthOverridesForTests. The AI/edit snapshot path
// itself is covered by flow-edit-service.test.ts; here we cover the new routes.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, and } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowRoutes } from '../src/routes/flows';
import { db, flows, flowSnapshots, auditLog, users, challenges, solutions, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { emptyGraph, type FlowGraph } from '../src/db/flow-types';
import type { User } from '../src/types';

const userA: User = {
  id: '00000000-0000-0000-0000-0000005a1700',
  email: 'snapA@test',
  name: 'Snap A',
  roles: ['employee'],
};
const userB: User = {
  id: '00000000-0000-0000-0000-0000005b1700',
  email: 'snapB@test',
  name: 'Snap B',
  roles: ['employee'],
};
const TEST_USER_IDS = [userA.id, userB.id];
const CHALLENGE_ID = '00000000-0000-0000-0000-0000005019c0';
const SOLUTION_ID = '00000000-0000-0000-0000-0000005019aa';

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, _role) => u,
  });
}

async function cleanup() {
  const owned = await db.select({ id: flows.id }).from(flows).where(inArray(flows.owner_id, TEST_USER_IDS));
  const ids = owned.map((f) => f.id);
  if (ids.length) await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, ids));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, TEST_USER_IDS));
  // solutions reference source flows — drop the solution before its flow.
  // is unreferenced, then solutions, then challenges, then the users.
  await db.delete(flows).where(inArray(flows.owner_id, TEST_USER_IDS));
  await db.delete(solutions).where(eq(solutions.id, SOLUTION_ID));
  await db.delete(challenges).where(eq(challenges.id, CHALLENGE_ID));
  await db.delete(users).where(inArray(users.id, TEST_USER_IDS));
}

const router = new Router();
registerFlowRoutes(router);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const twoNodeGraph: FlowGraph = {
  nodes: [
    { id: 'n1', blockId: 'b1', blockVersionId: 'v1', slug: 'read-claim-form', label: 'read', category: 'data', config: {}, position: { x: 0, y: 0 } },
    { id: 'n2', blockId: 'b2', blockVersionId: 'v2', slug: 'ai-summarize', label: 'sum', category: 'ai', config: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' }],
};

async function newFlow(name: string, graph?: FlowGraph): Promise<string> {
  const create = await call('POST', '/api/flows', { name });
  const id = create.json.id as string;
  if (graph) await call('PATCH', `/api/flows/${id}`, { graph });
  return id;
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(cleanup, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

// ---- checkpoint + list ----

test('checkpoint creates a manual snapshot the timeline lists', async () => {
  asUser(userA);
  const id = await newFlow('cp flow', twoNodeGraph);

  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'before edit' });
  expect(cp.status).toBe(201);
  expect(cp.json.source).toBe('manual');
  expect(cp.json.summary).toBe('before edit');
  expect(cp.json.node_count).toBe(2);
  expect(cp.json.edge_count).toBe(1);
  expect(cp.json.graph).toBeUndefined(); // summary row omits the graph

  const list = await call('GET', `/api/flows/${id}/snapshots`);
  expect(list.status).toBe(200);
  expect(list.json.readOnly).toBe(false);
  expect(list.json.items.some((s: any) => s.id === cp.json.id && s.summary === 'before edit')).toBe(true);
});

test('checkpoint without a summary defaults the label', async () => {
  asUser(userA);
  const id = await newFlow('cp default', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, {});
  expect(cp.status).toBe(201);
  expect(cp.json.summary).toBe('Manual checkpoint');
});

// ---- single snapshot (full graph) ----

test('GET single snapshot returns the full graph; 404 across flows', async () => {
  asUser(userA);
  const id = await newFlow('get snap', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 's' });

  const got = await call('GET', `/api/flows/${id}/snapshots/${cp.json.id}`);
  expect(got.status).toBe(200);
  expect(got.json.graph.nodes).toHaveLength(2);

  const other = await newFlow('other', twoNodeGraph);
  const cross = await call('GET', `/api/flows/${other}/snapshots/${cp.json.id}`);
  expect(cross.status).toBe(404);
});

// ---- restore ----

test('restore rolls the live graph back AND appends a reversible Restored snapshot', async () => {
  asUser(userA);
  const id = await newFlow('restore flow', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'good state' });

  // mutate the live graph away from the snapshot
  await call('PATCH', `/api/flows/${id}`, { graph: emptyGraph() });
  expect((await call('GET', `/api/flows/${id}`)).json.graph.nodes).toHaveLength(0);

  const restore = await call('POST', `/api/flows/${id}/snapshots/${cp.json.id}/restore`);
  expect(restore.status).toBe(200);
  expect(restore.json.graph.nodes).toHaveLength(2);
  expect(restore.json.validation.ok).toBe(true);

  // live graph reverted
  expect((await call('GET', `/api/flows/${id}`)).json.graph.nodes).toHaveLength(2);

  // newest snapshot is the manual "Restored…" entry and equals the live graph
  const list = await call('GET', `/api/flows/${id}/snapshots`);
  const newest = list.json.items[0];
  expect(newest.source).toBe('manual');
  expect(newest.summary).toContain('Restored snapshot from');
  expect(newest.node_count).toBe(2);
});

// ---- owner isolation ----

test('a non-owner gets 404 on list/get/checkpoint and 404 on restore for a private flow', async () => {
  asUser(userA);
  const id = await newFlow('A private', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'x' });

  asUser(userB);
  expect((await call('GET', `/api/flows/${id}/snapshots`)).status).toBe(404);
  expect((await call('GET', `/api/flows/${id}/snapshots/${cp.json.id}`)).status).toBe(404);
  expect((await call('POST', `/api/flows/${id}/snapshots`, {})).status).toBe(404);
  // private (non-solution) flow → existence is hidden even from restore → 404, not 403
  expect((await call('POST', `/api/flows/${id}/snapshots/${cp.json.id}/restore`)).status).toBe(404);
});

test('a solution-viewer can list/get (read-only) but cannot restore (403) or checkpoint (404)', async () => {
  asUser(userA);
  const id = await newFlow('A published', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'pub' });
  // Back the flow with a canonical immutable solution publication → publicly viewable.
  await db.insert(challenges).values({ id: CHALLENGE_ID, title: 'C', work_area: 'ops', submitter_id: userA.id, tenant_id: userA.id }).onConflictDoNothing();
  await db.insert(solutions).values({ id: SOLUTION_ID, challenge_id: CHALLENGE_ID, title: 'S', author_id: userA.id, flow_id: id, tenant_id: DEMO_TENANT_ID, published_graph: twoNodeGraph, published_at: new Date(), published_by: userA.id }).onConflictDoNothing();

  asUser(userB);
  const list = await call('GET', `/api/flows/${id}/snapshots`);
  expect(list.status).toBe(200);
  expect(list.json.readOnly).toBe(true);
  expect(list.json.items).toEqual([]); // source-flow history is not part of the publication
  expect((await call('GET', `/api/flows/${id}/snapshots/${cp.json.id}`)).status).toBe(404);
  expect((await call('POST', `/api/flows/${id}/snapshots/${cp.json.id}/restore`)).status).toBe(403);
  expect((await call('POST', `/api/flows/${id}/snapshots`, {})).status).toBe(404);
});

// ---- prune cap (50/flow) ----

test('checkpoint prunes to the last 50 snapshots, keeping the newest', async () => {
  asUser(userA);
  const id = await newFlow('prune flow', twoNodeGraph);

  // seed 60 rows directly with strictly increasing created_at for deterministic order
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const rows = Array.from({ length: 60 }, (_, i) => ({
    flow_id: id,
    graph: emptyGraph(),
    source: 'ai' as const,
    summary: `bulk ${i}`,
    created_by: userA.id,
    created_at: new Date(base + i * 1000),
    tenant_id: DEMO_TENANT_ID,
  }));
  await db.insert(flowSnapshots).values(rows);

  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'final' });
  expect(cp.status).toBe(201);

  const remaining = await db
    .select({ id: flowSnapshots.id })
    .from(flowSnapshots)
    .where(eq(flowSnapshots.flow_id, id));
  expect(remaining.length).toBe(50);

  const list = await call('GET', `/api/flows/${id}/snapshots`);
  expect(list.json.items[0].summary).toBe('final'); // newest survived
  // the oldest bulk rows were pruned
  expect(list.json.items.some((s: any) => s.summary === 'bulk 0')).toBe(false);
});

// ---- audit ----

test('checkpoint and restore each write an audit row', async () => {
  asUser(userA);
  const id = await newFlow('audit flow', twoNodeGraph);
  const cp = await call('POST', `/api/flows/${id}/snapshots`, { summary: 'auditcp' });
  await call('POST', `/api/flows/${id}/snapshots/${cp.json.id}/restore`);

  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.target_id, id), eq(auditLog.actor_id, userA.id)));
  const actions = rows.map((r) => r.action);
  expect(actions).toContain('flow.checkpoint');
  expect(actions).toContain('flow.restore');
});
