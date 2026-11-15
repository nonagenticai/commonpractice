// tests/flows.test.ts — Session 2 flow-persistence coverage.
//   * flow-validate: pure unit (no DB).
//   * route handlers: driven via in-process Request objects against the live
//     CI/dev Postgres (:5433). Auth via the __setAuthOverridesForTests seam.
import { test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowRoutes } from '../src/routes/flows';
import {
  validateGraphStructure,
  validateGraphAgainstBlocks,
} from '../src/exec/flow-validate';
import { db, flows, users, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { FlowGraph } from '../src/db/flow-types';
import type { BlockDescriptor } from '../src/db/block-types';
import type { User } from '../src/types';

// Two synthetic users with fixed uuids so owner-isolation is deterministic.
const userA: User = {
  id: '00000000-0000-0000-0000-0000000f10aa',
  email: 'flowA@test',
  name: 'Flow A',
  roles: ['employee'],
};
const userB: User = {
  id: '00000000-0000-0000-0000-0000000f10bb',
  email: 'flowB@test',
  name: 'Flow B',
  roles: ['employee'],
};
const TEST_USER_IDS = [userA.id, userB.id];

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, _role) => u,
  });
}

async function cleanup() {
  await db.delete(flows).where(inArray(flows.owner_id, TEST_USER_IDS));
  await db.delete(users).where(inArray(users.id, TEST_USER_IDS));
}

const router = new Router();
registerFlowRoutes(router);

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(cleanup, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

// ---- flow-validate (pure) ----

const twoNodeGraph: FlowGraph = {
  nodes: [
    { id: 'n1', blockId: 'b1', blockVersionId: 'v1', slug: 'read-claim-form', label: 'read', category: 'data', config: {}, position: { x: 0, y: 0 } },
    { id: 'n2', blockId: 'b2', blockVersionId: 'v2', slug: 'ai-summarize', label: 'sum', category: 'ai', config: {}, position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' },
  ],
};

test('validateGraphStructure passes a clean DAG', () => {
  const r = validateGraphStructure(twoNodeGraph);
  expect(r.ok).toBe(true);
  expect(r.issues).toHaveLength(0);
});

test('validateGraphStructure flags a dangling edge endpoint', () => {
  const r = validateGraphStructure({
    nodes: twoNodeGraph.nodes,
    edges: [{ id: 'eX', source: 'n1', sourceHandle: 'text', target: 'ghost', targetHandle: 'text' }],
  });
  expect(r.ok).toBe(false);
  expect(r.issues.some((i) => i.rule === 'edge-missing-target')).toBe(true);
});

test('validateGraphStructure detects a cycle', () => {
  const r = validateGraphStructure({
    nodes: twoNodeGraph.nodes,
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'o', target: 'n2', targetHandle: 'i' },
      { id: 'e2', source: 'n2', sourceHandle: 'o', target: 'n1', targetHandle: 'i' },
    ],
  });
  expect(r.ok).toBe(false);
  expect(r.issues.some((i) => i.rule === 'cycle')).toBe(true);
});

test('validateGraphAgainstBlocks flags an unknown handle', () => {
  const desc: BlockDescriptor = { inputs: { text: { type: 'string' } }, outputs: { summary: { type: 'string' } }, capabilities: {} };
  const map = new Map<string, BlockDescriptor>([
    ['v1', { inputs: {}, outputs: { text: { type: 'string' } }, capabilities: {} }],
    ['v2', desc],
  ]);
  // edge targets handle 'text' which exists on v2 inputs → ok
  expect(validateGraphAgainstBlocks(twoNodeGraph, map).ok).toBe(true);
  // now point the edge at a non-existent input
  const bad: FlowGraph = { nodes: twoNodeGraph.nodes, edges: [{ id: 'e1', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'nope' }] };
  const r = validateGraphAgainstBlocks(bad, map);
  expect(r.ok).toBe(false);
  expect(r.issues.some((i) => i.rule === 'unknown-target-handle')).toBe(true);
});

test('graph readiness rejects duplicate edges, incompatible types, and unresolved required inputs', () => {
  const duplicate = validateGraphStructure({
    ...twoNodeGraph,
    edges: [twoNodeGraph.edges[0]!, { ...twoNodeGraph.edges[0]!, sourceHandle: 'other' }],
  });
  expect(duplicate.issues.some((issue) => issue.rule === 'duplicate-edge-id')).toBe(true);

  const descriptors = new Map<string, BlockDescriptor>([
    ['v1', { inputs: {}, outputs: { text: { type: 'string' } }, capabilities: {} }],
    ['v2', {
      inputs: {
        text: { type: 'number' },
        prompt: { type: 'string', required: true },
        withDefault: { type: 'string', required: true, default: 'safe' },
      },
      outputs: { summary: { type: 'string' } },
      capabilities: {},
    }],
  ]);
  const readiness = validateGraphAgainstBlocks(twoNodeGraph, descriptors);
  expect(readiness.issues.some((issue) => issue.rule === 'incompatible-handle-type')).toBe(true);
  expect(readiness.issues.some((issue) => issue.rule === 'missing-required-input' && issue.ref === 'n2')).toBe(true);
  expect(readiness.issues.filter((issue) => issue.rule === 'missing-required-input')).toHaveLength(1);

  // ⛔ THE `detail` BAG IS THE HALF THE FRONTEND CANNOT TEST. The browser localizes these issues by
  // switching on `rule` and interpolating `detail` (frontend/src/lib/i18n/graph-issue-label.ts); when
  // a field is absent it falls back to the English `message` — SILENTLY, because an old pod mid-roll
  // is a legitimate wire shape. So a push site that forgot its `detail`, or filled it with an id
  // where the sentence names a slug, pushes every locale back to English FOREVER while every
  // frontend test stays green on its own fixtures. Nothing but this assertion can see it.
  const incompatible = readiness.issues.find((issue) => issue.rule === 'incompatible-handle-type')!;
  expect(incompatible.detail).toEqual({
    sourceNode: 'read-claim-form',   // the SLUG the author sees, not `n1` — `ref` keeps the id
    sourceHandle: 'text',
    sourceType: 'string',
    targetNode: 'ai-summarize',
    targetHandle: 'text',
    targetType: 'number',
  });
  const required = readiness.issues.find((issue) => issue.rule === 'missing-required-input')!;
  expect(required.detail).toEqual({ node: 'ai-summarize', handle: 'prompt' });
  // The English sentence stays on the wire beside it: it is the mid-roll fallback, and it is the
  // right output for the reader that is not a browser (src/ai/mcp/tools.ts renders these to an LLM).
  expect(required.message).toBe("Node 'ai-summarize' requires input 'prompt'");

  const configured: FlowGraph = {
    ...twoNodeGraph,
    nodes: twoNodeGraph.nodes.map((node) =>
      node.id === 'n2' ? { ...node, config: { prompt: 'Summarize this' } } : node,
    ),
  };
  expect(
    validateGraphAgainstBlocks(configured, new Map([
      ['v1', descriptors.get('v1')!],
      ['v2', { ...descriptors.get('v2')!, inputs: { ...descriptors.get('v2')!.inputs, text: { type: 'string' } } }],
    ])).ok,
  ).toBe(true);
});

// ---- CRUD lifecycle ----

test('create → get → patch graph → list → archive', async () => {
  asUser(userA);

  const create = await call('POST', '/api/flows', { name: 'My Flow', description: 'demo' });
  expect(create.status).toBe(201);
  expect(create.json.status).toBe('draft');
  expect(create.json.graph).toEqual({ nodes: [], edges: [] });
  const id = create.json.id as string;

  const get = await call('GET', `/api/flows/${id}`);
  expect(get.status).toBe(200);
  expect(get.json.name).toBe('My Flow');

  const patch = await call('PATCH', `/api/flows/${id}`, { graph: twoNodeGraph, name: 'Renamed' });
  expect(patch.status).toBe(200);
  expect(patch.json.name).toBe('Renamed');
  expect(patch.json.graph.nodes).toHaveLength(2);
  expect(patch.json.last_saved_at).toBeTruthy();
  expect(patch.json.validation.ok).toBe(true);

  const list = await call('GET', '/api/flows');
  expect(list.status).toBe(200);
  expect(list.json.items.some((i: any) => i.id === id && i.node_count === 2)).toBe(true);

  const del = await call('DELETE', `/api/flows/${id}`);
  expect(del.status).toBe(204);
  // archived flows drop out of the default list
  const list2 = await call('GET', '/api/flows');
  expect(list2.json.items.some((i: any) => i.id === id)).toBe(false);
});

test('PATCH reports non-blocking validation for a cyclic graph (still saves)', async () => {
  asUser(userA);
  const create = await call('POST', '/api/flows', { name: 'Cyclic' });
  const id = create.json.id as string;
  const cyclic: FlowGraph = {
    nodes: twoNodeGraph.nodes,
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'o', target: 'n2', targetHandle: 'i' },
      { id: 'e2', source: 'n2', sourceHandle: 'o', target: 'n1', targetHandle: 'i' },
    ],
  };
  const patch = await call('PATCH', `/api/flows/${id}`, { graph: cyclic });
  expect(patch.status).toBe(200); // saved despite the cycle
  expect(patch.json.validation.ok).toBe(false);
  expect(patch.json.validation.issues.some((i: any) => i.rule === 'cycle')).toBe(true);
});

test('graph zod rejects a malformed edge (422)', async () => {
  asUser(userA);
  const create = await call('POST', '/api/flows', { name: 'Bad graph' });
  const id = create.json.id as string;
  const r = await call('PATCH', `/api/flows/${id}`, {
    graph: { nodes: [], edges: [{ id: 'e1', source: 'n1' /* missing fields */ }] },
  });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('validation');
});

// ---- owner isolation ----

test('user B cannot see or mutate user A flow (404)', async () => {
  asUser(userA);
  const create = await call('POST', '/api/flows', { name: 'A private' });
  const id = create.json.id as string;

  asUser(userB);
  expect((await call('GET', `/api/flows/${id}`)).status).toBe(404);
  expect((await call('PATCH', `/api/flows/${id}`, { name: 'hijack' })).status).toBe(404);
  expect((await call('DELETE', `/api/flows/${id}`)).status).toBe(404);
  // B's own list is empty of A's flow
  const list = await call('GET', '/api/flows');
  expect(list.json.items.some((i: any) => i.id === id)).toBe(false);
});

test('create requires a name (422)', async () => {
  asUser(userA);
  const r = await call('POST', '/api/flows', { description: 'no name' });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('validation');
});
