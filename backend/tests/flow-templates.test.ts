// tests/flow-templates.test.ts — flow templates (0108 + routes/flow-templates.ts + seed-flow-templates.ts).
//
// What is pinned, and how each would go red:
//   • USE copies with FRESH ids, remaps edges AND foreach parentId, never writes the template.
//   • every seeded STARTER, once used, wires real ports of real global blocks (no unknown/incompatible
//     handle) — the JSON names blocks by slug, so a renamed port or slug reds here, not in a demo.
//   • AVAILABILITY names the missing slugs, and a block owned by ANOTHER tenant counts as missing.
//   • ROLE GATES: a member cannot save; a member CAN use; only a super_admin saves a starter, and a
//     starter may name only global blocks and keeps NO config the saver typed (reset to the block's
//     declared defaults — the reviewer's PII/credential payloads are asserted absent verbatim), and a
//     starter's creator id is shown to super_admins only.
//   • CROSS-TENANT isolation is driven under `cp_app` (withTenantDbAsRuntimeRoleForTests). The default
//     test connection is the table OWNER and bypasses RLS, so a cross-tenant assertion made on it
//     cannot fail for the reason it claims to test. The explicit tenant predicates in the service are
//     pinned separately on the owner connection, where they are the ONLY protection.
//   • SEED idempotency: a second run changes nothing, and a tenant row sharing a seed_key is untouched.
//     Translations are insert-if-missing (xmin unchanged on a re-run; a corrected cell survives), and
//     an archived starter stays archived even when the re-run's UPDATE actually fires.
//
// Fixture ids are owned by this file only (tests/fixture-id-collisions.test.ts).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowTemplateRoutes } from '../src/routes/flow-templates';
import {
  db,
  tenants,
  users,
  flows,
  flowTemplates,
  buildingBlocks,
  blockVersions,
  challenges,
  solutions,
  contentTranslations,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { seedFlowTemplates, loadFlowSeedFiles } from '../src/db/seed-flow-templates';
import { remapGraphIds, UNRESOLVED_BLOCK_ID, FLOW_TEMPLATE_I18N } from '../src/flow-templates/service';
import { validateGraphAgainstBlocks, validateGraphStructure } from '../src/exec/flow-validate';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { BlockDescriptor } from '../src/db/block-types';
import type { User } from '../src/types';

const T_A = '00000000-0000-0000-0000-0000f7e00a01';
const T_B = '00000000-0000-0000-0000-0000f7e00b01';
const id = (n: string) => `00000000-0000-0000-0000-0000f7e0${n}`;

const memberA: User = { id: id('1a01'), email: 'ftpl-member-a@test', name: 'Ftpl Member A', roles: ['member'], tenantId: T_A };
const devA: User = { id: id('1a02'), email: 'ftpl-dev-a@test', name: 'Ftpl Dev A', roles: ['developer'], tenantId: T_A };
const adminA: User = { id: id('1a03'), email: 'ftpl-admin-a@test', name: 'Ftpl Admin A', roles: ['tenant_admin'], tenantId: T_A };
const superA: User = { id: id('1a04'), email: 'ftpl-super@test', name: 'Ftpl Super', roles: ['super_admin'], tenantId: T_A };
const dev2A: User = { id: id('1a05'), email: 'ftpl-dev2-a@test', name: 'Ftpl Dev2 A', roles: ['developer'], tenantId: T_A };
const devB: User = { id: id('1b01'), email: 'ftpl-dev-b@test', name: 'Ftpl Dev B', roles: ['developer'], tenantId: T_B };
const memberB: User = { id: id('1b02'), email: 'ftpl-member-b@test', name: 'Ftpl Member B', roles: ['member'], tenantId: T_B };
const ALL_USERS = [memberA, devA, adminA, superA, dev2A, devB, memberB];

// A tenant-A block and a tenant-B block, each with a published version.
const BLK_A = id('b0a1');
const VER_A = id('b0a2');
const BLK_B = id('b0b1');
const VER_B = id('b0b2');
const SLUG_A = 'ftpl-a-only';
const SLUG_B = 'ftpl-b-only';

// A test-owned GLOBAL block whose inputs are the reviewer's tenant-data shapes; `document` is pii.
const BLK_PII = id('b0c1');
const VER_PII = id('b0c2');
const SLUG_PII = 'ftpl-pii-doc';
const FLOW_SUPER_PII = id('f0a4'); // superA's flow carrying real-shaped tenant data in its config

const FLOW_A = id('f0a1'); // devA's flow: global blocks + dataset/credential config
const FLOW_A_TENANT_BLOCK = id('f0a2'); // superA's flow that uses tenant A's block
const FLOW_SUPER = id('f0a3'); // superA's flow, global blocks only
const TPL_A = id('7a01'); // an organisation template of tenant A
const TPL_B = id('7b01'); // an organisation template of tenant B
const TPL_A_SEEDKEY = id('7a02'); // tenant A row that happens to carry a starter's seed_key
const CH_A = id('c0a1');
const CH_B = id('c0b1');
const SOL_A = id('50a1');
const SOL_B = id('50b1');
const SOL_A_EMPTY = id('50a2');

const router = new Router();
registerFlowTemplateRoutes(router);

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

/** Dispatch a route. `rlsTenant` runs it as production does — role cp_app, GUC = that tenant. */
async function call(method: string, path: string, body?: unknown, rlsTenant?: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const run = async () => {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await matched.handler(req, ...matched.params);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return rlsTenant ? withTenantDbAsRuntimeRoleForTests(rlsTenant, run) : run();
}

async function globalBlock(slug: string) {
  const [b] = await db
    .select()
    .from(buildingBlocks)
    .where(and(eq(buildingBlocks.slug, slug), isNull(buildingBlocks.tenant_id)));
  if (!b?.current_version_id) throw new Error(`fixture needs the seeded global block '${slug}'`);
  return b;
}

async function cleanup() {
  // Global rows are not tenant-cascaded: remove every template saved from this file's flows.
  await db
    .delete(flowTemplates)
    .where(inArray(flowTemplates.source_flow_id, [FLOW_A, FLOW_SUPER, FLOW_A_TENANT_BLOCK, FLOW_SUPER_PII]));
  await db.delete(buildingBlocks).where(eq(buildingBlocks.id, BLK_PII)); // global: not tenant-cascaded
  await db.delete(solutions).where(inArray(solutions.id, [SOL_A, SOL_B, SOL_A_EMPTY]));
  await db.delete(challenges).where(inArray(challenges.id, [CH_A, CH_B]));
  // Cascades flows, building_blocks (+versions) and the tenant-owned flow_templates.
  await db.delete(tenants).where(inArray(tenants.id, [T_A, T_B]));
  await db.delete(flows).where(inArray(flows.owner_id, ALL_USERS.map((u) => u.id)));
  await db.delete(users).where(inArray(users.id, ALL_USERS.map((u) => u.id)));
}

/** The reviewer's payloads, verbatim in shape: every one is tenant data a starter must not carry. */
const TENANT_VALUES = [
  'Jane Roe, DOB 1971-03-02, SSN 123-45-6789, diagnosis: lumbar fracture',
  'tenantA-claim-778',
  'CUST-0042-tenantA',
  'Bearer sk-live-4f9a8b7c6d5e',
  'xk-tenantA-9911',
  'https://hooks.tenant-a.example/claims',
  'postgres://u:p@db.tenant-a.example.com:5432/claims',
  'ssn-in-a-literal-rowset',
  'smuggled-node-key',
  'smuggled-edge-key',
];

function piiGraph(): FlowGraph {
  return {
    nodes: [
      {
        id: 'n1', blockId: readClaim.id, blockVersionId: readClaim.current_version_id!, slug: 'read-claim-form',
        label: 'Read the claim', category: 'data', position: { x: 10, y: 20 },
        config: { file: { ref: 'tenantA-claim-778' }, force_ocr: true },
      },
      {
        id: 'fe1', blockId: '', blockVersionId: '', slug: 'foreach', label: 'Each page', category: 'logic',
        position: { x: 300, y: 0 }, kind: 'foreach',
        // A literal rowset in the container's config is the tenant's rows, and `note` is not a loop field.
        config: { in: [{ ssn: 'ssn-in-a-literal-rowset' }] },
        loop: { rowsInput: 'in', maxIterations: 5, note: 'smuggled-node-key' } as FlowNode['loop'],
      },
      {
        id: 'n2', blockId: BLK_PII, blockVersionId: VER_PII, slug: SLUG_PII, label: 'Read the page',
        category: 'ai', position: { x: 40, y: 60 }, parentId: 'fe1',
        config: {
          document: 'Jane Roe, DOB 1971-03-02, SSN 123-45-6789, diagnosis: lumbar fracture',
          customer_id: 'CUST-0042-tenantA',
          authorization: 'Bearer sk-live-4f9a8b7c6d5e',
          headers: { 'X-Api-Key': 'xk-tenantA-9911' },
          webhook_url: 'https://hooks.tenant-a.example/claims',
          dsn: 'postgres://u:p@db.tenant-a.example.com:5432/claims',
          mode: 'thorough',
        },
        ...({ secretNote: 'smuggled-node-key' } as object),
      } as FlowNode,
    ],
    edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'pages', target: 'fe1', targetHandle: 'in' },
      { id: 'e2', source: 'fe1', sourceHandle: 'item', target: 'n2', targetHandle: 'document', ...({ data: { token: 'smuggled-edge-key' } } as object) },
    ],
  };
}

function leaked(graph: unknown): string[] {
  const text = JSON.stringify(graph);
  return TENANT_VALUES.filter((v) => text.includes(v));
}

let summarize: Awaited<ReturnType<typeof globalBlock>>;
let classify: Awaited<ReturnType<typeof globalBlock>>;
let claimData: Awaited<ReturnType<typeof globalBlock>>;
let readClaim: Awaited<ReturnType<typeof globalBlock>>;

beforeAll(async () => {
  await seedFlowTemplates(); // idempotent; CI has already seeded
  await cleanup();
  summarize = await globalBlock('ai-summarize');
  classify = await globalBlock('classify');
  claimData = await globalBlock('example-claim-data');
  readClaim = await globalBlock('read-claim-form');

  await db.insert(tenants).values([
    { id: T_A, name: 'Ftpl Tenant A', slug: 'ftpl-a' },
    { id: T_B, name: 'Ftpl Tenant B', slug: 'ftpl-b' },
  ]);
  await db.insert(users).values(ALL_USERS.map((u) => ({ id: u.id, email: u.email, name: u.name, tenant_id: u.tenantId })));
  const desc: BlockDescriptor = { inputs: { text: { type: 'string' } }, outputs: { out: { type: 'json' } }, capabilities: {} };
  await db.insert(buildingBlocks).values([
    { id: BLK_A, slug: SLUG_A, name: 'A only', category: 'logic', tenant_id: T_A, maintainer_id: devA.id },
    { id: BLK_B, slug: SLUG_B, name: 'B only', category: 'logic', tenant_id: T_B, maintainer_id: devB.id },
  ]);
  await db.insert(blockVersions).values([
    { id: VER_A, block_id: BLK_A, version: '1.0.0', status: 'stable', descriptor: desc, published_at: new Date() },
    { id: VER_B, block_id: BLK_B, version: '1.0.0', status: 'stable', descriptor: desc, published_at: new Date() },
  ]);
  await db.insert(buildingBlocks).values({ id: BLK_PII, slug: SLUG_PII, name: 'Ftpl PII doc', category: 'ai', tenant_id: null, maintainer_id: superA.id });
  await db.insert(blockVersions).values({
    id: VER_PII,
    block_id: BLK_PII,
    version: '1.0.0',
    status: 'stable',
    published_at: new Date(),
    descriptor: {
      inputs: {
        document: { type: 'string', required: true, pii: true },
        customer_id: { type: 'string' },
        authorization: { type: 'string' },
        headers: { type: 'json' },
        webhook_url: { type: 'string' },
        dsn: { type: 'string' },
        mode: { type: 'string', default: 'fast' },
      },
      outputs: { out: { type: 'json' } },
      capabilities: {},
    } satisfies BlockDescriptor,
  });
  await db.update(buildingBlocks).set({ current_version_id: VER_PII }).where(eq(buildingBlocks.id, BLK_PII));
  await db.update(buildingBlocks).set({ current_version_id: VER_A }).where(eq(buildingBlocks.id, BLK_A));
  await db.update(buildingBlocks).set({ current_version_id: VER_B }).where(eq(buildingBlocks.id, BLK_B));

  const pos = { x: 0, y: 0 };
  const globalGraph: FlowGraph = {
    nodes: [
      // `source` is the data block's dataset-typed input; `api_key` names a credential.
      { id: 'n1', blockId: claimData.id, blockVersionId: claimData.current_version_id!, slug: 'example-claim-data', label: 'Claims', category: 'data', config: { source: 'tenant-a-private-claims', api_key: 'sk-not-for-sharing' }, position: pos },
      { id: 'n2', blockId: summarize.id, blockVersionId: summarize.current_version_id!, slug: 'ai-summarize', label: 'Sum', category: 'ai', config: { max_lines: 4 }, position: { x: 300, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'rows', target: 'n2', targetHandle: 'text' }],
  };
  await db.insert(flows).values([
    { id: FLOW_A, name: 'Ftpl flow A', owner_id: devA.id, tenant_id: T_A, graph: globalGraph },
    { id: FLOW_SUPER, name: 'Ftpl super flow', owner_id: superA.id, tenant_id: T_A, graph: globalGraph },
    { id: FLOW_SUPER_PII, name: 'Ftpl super PII flow', owner_id: superA.id, tenant_id: T_A, graph: piiGraph() },
    {
      id: FLOW_A_TENANT_BLOCK,
      name: 'Ftpl tenant-block flow',
      owner_id: superA.id,
      tenant_id: T_A,
      graph: {
        nodes: [{ id: 'n1', blockId: BLK_A, blockVersionId: VER_A, slug: SLUG_A, label: 'A', category: 'logic', config: {}, position: pos }],
        edges: [],
      },
    },
  ]);

  const tplGraph = (slug: string, blockId: string, ver: string): FlowGraph => ({
    nodes: [
      { id: 'n1', blockId: classify.id, blockVersionId: classify.current_version_id!, slug: 'classify', label: 'Classify', category: 'ai', config: { labels: ['x'] }, position: pos },
      { id: 'n2', blockId, blockVersionId: ver, slug, label: slug, category: 'logic', config: {}, position: { x: 300, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'label', target: 'n2', targetHandle: 'text' }],
  });
  await db.insert(flowTemplates).values([
    { id: TPL_A, tenant_id: T_A, name: 'Ftpl org template A', graph: tplGraph(SLUG_A, BLK_A, VER_A), block_slugs: ['classify', SLUG_A], created_by: devA.id },
    { id: TPL_B, tenant_id: T_B, name: 'Ftpl org template B', graph: tplGraph(SLUG_B, BLK_B, VER_B), block_slugs: ['classify', SLUG_B], created_by: devB.id },
    {
      id: TPL_A_SEEDKEY,
      tenant_id: T_A,
      seed_key: 'claim-form-summary',
      name: 'Ftpl tenant copy, must survive the seeder',
      graph: { nodes: [], edges: [] },
      block_slugs: [],
    },
  ]);

  await db.insert(challenges).values([
    { id: CH_A, tenant_id: T_A, title: 'Ftpl challenge A', description: 'x', work_area: 'Claims', submitter_id: memberA.id, status: 'voting', week: '2026-W41' },
    { id: CH_B, tenant_id: T_B, title: 'Ftpl challenge B', description: 'x', work_area: 'Claims', submitter_id: memberB.id, status: 'voting', week: '2026-W41' },
  ]);
  await db.insert(solutions).values([
    { id: SOL_A, challenge_id: CH_A, tenant_id: T_A, title: 'Ftpl solution A', author_id: devA.id, blocks_used: [], week: '2026-W41', published_graph: globalGraph },
    { id: SOL_B, challenge_id: CH_B, tenant_id: T_B, title: 'Ftpl solution B', author_id: devB.id, blocks_used: [], week: '2026-W41', published_graph: globalGraph },
    { id: SOL_A_EMPTY, challenge_id: CH_A, tenant_id: T_A, title: 'Ftpl solution without flow', author_id: devA.id, blocks_used: [], week: '2026-W41' },
  ]);
}, 60_000);

afterAll(cleanup, 60_000);
afterEach(() => __setAuthOverridesForTests(undefined));

async function descriptorsOf(graph: FlowGraph): Promise<Map<string, BlockDescriptor>> {
  const ids = graph.nodes.map((n) => n.blockVersionId).filter((v) => /^[0-9a-f-]{36}$/.test(v));
  const rows = ids.length
    ? await db.select({ id: blockVersions.id, d: blockVersions.descriptor }).from(blockVersions).where(inArray(blockVersions.id, ids))
    : [];
  return new Map(rows.map((r) => [r.id, r.d as BlockDescriptor]));
}

async function loadFlow(flowId: string) {
  const [f] = await db.select().from(flows).where(eq(flows.id, flowId));
  return f!;
}

async function starterId(seedKey: string): Promise<string> {
  const [row] = await db
    .select({ id: flowTemplates.id })
    .from(flowTemplates)
    .where(and(eq(flowTemplates.seed_key, seedKey), isNull(flowTemplates.tenant_id)));
  return row!.id;
}

// ---------------------------------------------------------------------------------------------- remap

test('remapGraphIds: fresh node + edge ids, edges and foreach parentId follow, input untouched', () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'a', blockId: 'x', blockVersionId: 'y', slug: 's', label: '', category: 'data', config: {}, position: { x: 1, y: 2 } },
      { id: 'loop', blockId: '', blockVersionId: '', slug: 'foreach', label: '', category: 'logic', config: {}, position: { x: 0, y: 0 }, kind: 'foreach', loop: { rowsInput: 'in' } },
      { id: 'body', blockId: 'x', blockVersionId: 'y', slug: 's', label: '', category: 'ai', config: { k: [1] }, position: { x: 5, y: 6 }, parentId: 'loop' },
    ],
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'rows', target: 'loop', targetHandle: 'in' },
      { id: 'e2', source: 'loop', sourceHandle: 'item', target: 'body', targetHandle: 'claim' },
    ],
  };
  const before = structuredClone(g);
  const out = remapGraphIds(g);
  expect(g).toEqual(before); // the source graph is never mutated
  const byOld = new Map(g.nodes.map((n, i) => [n.id, out.nodes[i]!]));
  for (const n of out.nodes) expect(g.nodes.some((o) => o.id === n.id)).toBe(false);
  expect(byOld.get('loop')!.id.startsWith('fe_')).toBe(true);
  expect(byOld.get('body')!.parentId).toBe(byOld.get('loop')!.id);
  expect(out.edges.map((e) => [e.source, e.target])).toEqual([
    [byOld.get('a')!.id, byOld.get('loop')!.id],
    [byOld.get('loop')!.id, byOld.get('body')!.id],
  ]);
  for (const e of out.edges) expect(['e1', 'e2']).not.toContain(e.id);
  expect(byOld.get('a')!.position).toEqual({ x: 1, y: 2 });
  // Deep copy: the config object is not shared with the template.
  expect(byOld.get('body')!.config).toEqual({ k: [1] });
  expect(byOld.get('body')!.config).not.toBe(g.nodes[2]!.config);
});

// ---------------------------------------------------------------------------------------------- list

test('GET list (member A): the starters + own organisation template, never tenant B’s', async () => {
  asUser(memberA);
  const { status, json } = await call('GET', '/api/flow-templates');
  expect(status).toBe(200);
  const ids = json.templates.map((t: { id: string }) => t.id);
  expect(ids).toContain(TPL_A);
  expect(ids).not.toContain(TPL_B);
  const starters = json.templates.filter((t: { scope: string }) => t.scope === 'global');
  expect(starters.length).toBeGreaterThanOrEqual(loadFlowSeedFiles().length);
  // Every shipped starter resolves against the seeded catalogue.
  for (const key of loadFlowSeedFiles().map((f) => f.seed_key)) {
    const sid = await starterId(key);
    const t = json.templates.find((x: { id: string }) => x.id === sid);
    expect(t, key).toBeDefined();
    expect(t.available, `${key}: ${t.missingBlocks}`).toBe(true);
  }
});

test('availability: a block owned by ANOTHER tenant is missing (owner connection — the explicit predicate is the only guard)', async () => {
  // Plant a tenant-A template that names tenant B's block. RLS is bypassed on this connection, so if
  // `readableBlocksBySlug` lost its tenant predicate, SLUG_B would resolve and this would read "available".
  const planted = id('7a09');
  await db.insert(flowTemplates).values({
    id: planted,
    tenant_id: T_A,
    name: 'Ftpl planted',
    graph: { nodes: [], edges: [] },
    block_slugs: [SLUG_B, 'ftpl-no-such-block'],
  });
  try {
    asUser(memberA);
    const { json } = await call('GET', `/api/flow-templates/${planted}`);
    expect(json.template.available).toBe(false);
    expect(json.template.missingBlocks).toEqual([SLUG_B, 'ftpl-no-such-block']);
    // Its own tenant's block is available to tenant A.
    const { json: a } = await call('GET', `/api/flow-templates/${TPL_A}`);
    expect(a.template.available).toBe(true);
    expect(a.template.missingBlocks).toEqual([]);
  } finally {
    await db.delete(flowTemplates).where(eq(flowTemplates.id, planted));
  }
});

test('cross-tenant under cp_app: tenant B cannot list, get, use or archive tenant A’s template', async () => {
  asUser(devB);
  const list = await call('GET', '/api/flow-templates', undefined, T_B);
  expect(list.status).toBe(200);
  const ids = list.json.templates.map((t: { id: string }) => t.id);
  expect(ids).toContain(TPL_B);
  expect(ids).not.toContain(TPL_A);
  // The fixture really is bound by RLS: starters (global) are still visible to B.
  expect(list.json.templates.some((t: { scope: string }) => t.scope === 'global')).toBe(true);

  expect((await call('GET', `/api/flow-templates/${TPL_A}`, undefined, T_B)).status).toBe(404);
  expect((await call('POST', `/api/flow-templates/${TPL_A}/use`, undefined, T_B)).status).toBe(404);
  expect((await call('DELETE', `/api/flow-templates/${TPL_A}`, undefined, T_B)).status).toBe(404);
  const [still] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, TPL_A));
  expect(still!.archived_at).toBeNull();
});

test('cross-tenant on the owner connection: the explicit tenant predicate alone refuses B', async () => {
  asUser(devB);
  expect((await call('GET', `/api/flow-templates/${TPL_A}`)).status).toBe(404);
  expect((await call('POST', `/api/flow-templates/${TPL_A}/use`)).status).toBe(404);
  expect((await call('DELETE', `/api/flow-templates/${TPL_A}`)).status).toBe(404);
});

// ---------------------------------------------------------------------------------------------- use

test('USE (member, under cp_app): a new draft owned by the caller with fresh ids; the template is untouched', async () => {
  const tplId = await starterId('triage-each-claim');
  const [before] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, tplId));
  asUser(memberA);
  const { status, json } = await call('POST', `/api/flow-templates/${tplId}/use`, undefined, T_A);
  expect(status).toBe(201);
  expect(json.missingBlocks).toEqual([]);
  const flow = await loadFlow(json.flowId);
  expect(flow.owner_id).toBe(memberA.id);
  expect(flow.tenant_id).toBe(T_A);
  expect(flow.status).toBe('draft');
  expect(flow.name).toBe(before!.name);

  const tg = before!.graph as FlowGraph;
  const g = flow.graph as FlowGraph;
  expect(g.nodes.length).toBe(tg.nodes.length);
  expect(g.edges.length).toBe(tg.edges.length);
  const oldIds = new Set([...tg.nodes.map((n) => n.id), ...tg.edges.map((e) => e.id)]);
  for (const x of [...g.nodes, ...g.edges]) expect(oldIds.has(x.id)).toBe(false);
  const loop = g.nodes.find((n) => n.kind === 'foreach')!;
  const body = g.nodes.find((n) => n.slug === 'triage-claim')!;
  expect(body.parentId).toBe(loop.id);
  expect(validateGraphStructure(g).issues).toEqual([]);
  // Re-bound to the real global block, current version.
  const triage = await globalBlock('triage-claim');
  expect(body.blockId).toBe(triage.id);
  expect(body.blockVersionId).toBe(triage.current_version_id!);

  const [after] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, tplId));
  expect(after!.graph).toEqual(before!.graph);
  expect(after!.updated_at).toEqual(before!.updated_at);
});

// ⛔ A brand-new org on prod (2026-10-16) ended its first visit to /build with TWO flows: the blank
// "Untitled flow" /build opens for a reader with none, and the template's copy. `into` names the
// empty draft on screen; the template now lands IN it. Each fallback is a different reason the
// hint must not be honoured, and each must still produce a working new flow, never a 4xx.
test('USE with `into`: an empty own draft is reused; non-empty, a colleague’s or a submitted one is not', async () => {
  const tplId = await starterId('triage-each-claim');
  const EMPTY = id('f0b1');
  const BUSY = id('f0b2');
  const OTHERS = id('f0b3');
  const SUBMITTED = id('f0b4');
  const empty = { nodes: [], edges: [] };
  const busy = (await loadFlow(FLOW_A)).graph as FlowGraph;
  await db.insert(flows).values([
    { id: EMPTY, name: 'Untitled flow', owner_id: memberA.id, tenant_id: T_A, graph: empty },
    { id: BUSY, name: 'Mine, with work', owner_id: memberA.id, tenant_id: T_A, graph: busy },
    { id: OTHERS, name: 'A colleague’s blank', owner_id: devA.id, tenant_id: T_A, graph: empty },
    { id: SUBMITTED, name: 'Submitted blank', owner_id: memberA.id, tenant_id: T_A, graph: empty, status: 'submitted' },
  ]);
  const countMine = async () =>
    (await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, memberA.id))).length;

  asUser(memberA);
  const before = await countMine();
  const reused = await call('POST', `/api/flow-templates/${tplId}/use`, { into: EMPTY }, T_A);
  expect(reused.status).toBe(201);
  expect(reused.json.flowId).toBe(EMPTY);
  expect(await countMine()).toBe(before); // no second flow
  const filled = await loadFlow(EMPTY);
  expect((filled.graph as FlowGraph).nodes.length).toBeGreaterThan(0);
  expect(filled.name).not.toBe('Untitled flow');

  // EMPTY now has work in it, so a second use must not overwrite it either.
  for (const into of [EMPTY, BUSY, OTHERS, SUBMITTED]) {
    const r = await call('POST', `/api/flow-templates/${tplId}/use`, { into }, T_A);
    expect(r.status, into).toBe(201);
    expect(r.json.flowId, into).not.toBe(into);
  }
  expect(((await loadFlow(BUSY)).graph as FlowGraph).nodes.length).toBe(busy.nodes.length);
  expect(((await loadFlow(OTHERS)).graph as FlowGraph).nodes.length).toBe(0);
  expect(((await loadFlow(SUBMITTED)).graph as FlowGraph).nodes.length).toBe(0);
  // A malformed hint is refused, not silently turned into a new flow.
  expect((await call('POST', `/api/flow-templates/${tplId}/use`, { into: 'nope' }, T_A)).status).toBe(422);
});

test('every seeded starter, once used, wires real ports of real blocks', async () => {
  asUser(devA);
  for (const file of loadFlowSeedFiles()) {
    const { status, json } = await call('POST', `/api/flow-templates/${await starterId(file.seed_key)}/use`);
    expect(status, file.seed_key).toBe(201);
    expect(json.missingBlocks, file.seed_key).toEqual([]);
    const g = (await loadFlow(json.flowId)).graph as FlowGraph;
    const issues = validateGraphAgainstBlocks(g, await descriptorsOf(g)).issues.filter(
      (i) => i.rule !== 'missing-required-input', // a starter leaves the reader's own inputs open
    );
    expect(issues, file.seed_key).toEqual([]);
    expect(validateGraphStructure(g).issues, file.seed_key).toEqual([]);
  }
});

test('USE with a block the caller cannot read still succeeds and names it', async () => {
  // Tenant A's org template names SLUG_A; seen from a tenant whose catalogue lacks it, it is missing.
  // Plant the same graph for tenant B (owner connection) and use it as B.
  const planted = id('7b09');
  const [a] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, TPL_A));
  await db.insert(flowTemplates).values({ id: planted, tenant_id: T_B, name: 'Ftpl planted B', graph: a!.graph, block_slugs: a!.block_slugs });
  try {
    asUser(memberB);
    const { status, json } = await call('POST', `/api/flow-templates/${planted}/use`, undefined, T_B);
    expect(status).toBe(201);
    expect(json.missingBlocks).toEqual([SLUG_A]);
    const g = (await loadFlow(json.flowId)).graph as FlowGraph;
    const node = g.nodes.find((n) => n.slug === SLUG_A)!;
    // Kept on the canvas, with ids that cannot resolve to tenant A's block for tenant B.
    expect(node.blockId).toBe(BLK_A); // the template's own pin, unreadable to B
    expect(g.nodes.find((n) => n.slug === 'classify')!.blockId).toBe(classify.id);
  } finally {
    await db.delete(flowTemplates).where(eq(flowTemplates.id, planted));
  }
});

test('USE of a seeded starter whose block is absent uses the nil id, never an empty string', async () => {
  const planted = id('7a0a');
  await db.insert(flowTemplates).values({
    id: planted,
    tenant_id: T_A,
    name: 'Ftpl slug-only',
    graph: { nodes: [{ id: 'n1', blockId: '', blockVersionId: '', slug: 'ftpl-no-such-block', label: '', category: 'logic', config: {}, position: { x: 0, y: 0 } }], edges: [] },
    block_slugs: ['ftpl-no-such-block'],
  });
  try {
    asUser(memberA);
    const { json } = await call('POST', `/api/flow-templates/${planted}/use`);
    const node = ((await loadFlow(json.flowId)).graph as FlowGraph).nodes[0]!;
    expect(node.blockId).toBe(UNRESOLVED_BLOCK_ID);
    expect(node.blockVersionId).toBe(UNRESOLVED_BLOCK_ID);
  } finally {
    await db.delete(flowTemplates).where(eq(flowTemplates.id, planted));
  }
});

// ---------------------------------------------------------------------------------------------- save

test('SAVE: a member cannot save a template', async () => {
  asUser(memberA);
  const { status, json } = await call('POST', '/api/flow-templates', { flowId: FLOW_A, name: 'Nope' });
  expect(status).toBe(403);
  expect(json.error).toBe('developer_required');
});

test('SAVE: a developer saves an organisation template from their own flow, config kept', async () => {
  asUser(devA);
  const { status, json } = await call('POST', '/api/flow-templates', { flowId: FLOW_A, name: 'Ftpl saved', description: 'd' }, T_A);
  expect(status).toBe(201);
  expect(json.template.scope).toBe('tenant');
  const [row] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, json.template.id));
  expect(row!.tenant_id).toBe(T_A);
  expect(row!.source_flow_id).toBe(FLOW_A);
  expect(row!.block_slugs).toEqual(['ai-summarize', 'example-claim-data']);
  expect((row!.graph as FlowGraph).nodes[0]!.config).toEqual({ source: 'tenant-a-private-claims', api_key: 'sk-not-for-sharing' });
});

test('SAVE: someone else’s flow is 404, and a developer cannot save a starter', async () => {
  asUser(dev2A);
  expect((await call('POST', '/api/flow-templates', { flowId: FLOW_A, name: 'x' })).status).toBe(404);
  asUser(devA);
  const g = await call('POST', '/api/flow-templates?scope=global', { flowId: FLOW_A, name: 'x' });
  expect(g.status).toBe(403);
  expect(g.json.error).toBe('super_admin_required');
});

test('SAVE global: a starter may not use a tenant block (422, names it)', async () => {
  asUser(superA);
  const { status, json } = await call('POST', '/api/flow-templates?scope=global', { flowId: FLOW_A_TENANT_BLOCK, name: 'x' });
  expect(status).toBe(422);
  expect(json.error).toBe('flow_template_tenant_blocks');
  expect(json.blockSlugs).toEqual([SLUG_A]);
  const leaked = await db.select().from(flowTemplates).where(eq(flowTemplates.source_flow_id, FLOW_A_TENANT_BLOCK));
  expect(leaked).toEqual([]);
});

test('SAVE global: every node’s config is reset to its block’s declared defaults; the row is global', async () => {
  asUser(superA);
  const { status, json } = await call('POST', '/api/flow-templates?scope=global', { flowId: FLOW_SUPER, name: 'Ftpl starter' });
  expect(status).toBe(201);
  expect(json.template.scope).toBe('global');
  expect(json.strippedConfig.map((s: { key: string }) => s.key).sort()).toEqual(['api_key', 'max_lines', 'source']);
  const [row] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, json.template.id));
  expect(row!.tenant_id).toBeNull();
  const nodes = (row!.graph as FlowGraph).nodes;
  // The data block's own declared default (platform content) replaces the tenant's dataset slug.
  const claimInputs = (await descriptorsOf({ nodes: [nodes[0]!], edges: [] })).get(nodes[0]!.blockVersionId)!.inputs;
  const claimDefaults = Object.fromEntries(
    Object.entries(claimInputs).filter(([, f]) => f.default !== undefined).map(([k, f]) => [k, f.default]),
  );
  expect(nodes[0]!.config).toEqual(claimDefaults);
  expect(JSON.stringify(nodes[0]!.config)).not.toContain('tenant-a-private-claims');
  // `max_lines: 4` is not a secret, but a starter keeps no value the saver typed: ai-summarize declares
  // no default, so it is unset.
  expect(nodes[1]!.config).toEqual({});

  // And tenant B (under cp_app) can see and use the new starter.
  asUser(memberB);
  expect((await call('GET', `/api/flow-templates/${row!.id}`, undefined, T_B)).status).toBe(200);
});

test('SAVE global: the reviewer’s tenant payloads survive in neither the starter nor a flow made from it', async () => {
  asUser(superA);
  const { status, json } = await call('POST', '/api/flow-templates?scope=global', { flowId: FLOW_SUPER_PII, name: 'Ftpl PII starter' });
  expect(status).toBe(201);
  const [row] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, json.template.id));
  const g = row!.graph as FlowGraph;
  expect(leaked(g)).toEqual([]);
  expect(JSON.stringify(g).length).toBeGreaterThan(200); // a non-empty graph was checked

  // Structure kept: nodes, labels, positions, foreach wiring + loop bound, edge ports.
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  expect([...byId.keys()]).toEqual(['n1', 'fe1', 'n2']);
  expect(byId.get('n1')!.label).toBe('Read the claim');
  expect(byId.get('n2')!.position).toEqual({ x: 40, y: 60 });
  expect(byId.get('n2')!.parentId).toBe('fe1');
  expect(byId.get('fe1')!.kind).toBe('foreach');
  expect(byId.get('fe1')!.loop).toEqual({ rowsInput: 'in', maxIterations: 5 });
  expect(g.edges).toEqual([
    { id: 'e1', source: 'n1', sourceHandle: 'pages', target: 'fe1', targetHandle: 'in' },
    { id: 'e2', source: 'fe1', sourceHandle: 'item', target: 'n2', targetHandle: 'document' },
  ]);
  // Config: the descriptor's defaults, and nothing else — `mode` falls back to the block's 'fast'.
  expect(byId.get('n2')!.config).toEqual({ mode: 'fast' });
  expect(byId.get('n1')!.config).toEqual({});
  expect(byId.get('fe1')!.config).toEqual({});
  expect(Object.keys(byId.get('n2')!).sort()).toEqual(
    ['blockId', 'blockVersionId', 'category', 'config', 'id', 'label', 'parentId', 'position', 'slug'],
  );
  const reported = json.strippedConfig.map((s: { nodeId: string; key: string }) => `${s.nodeId}.${s.key}`).sort();
  expect(reported).toEqual(
    ['fe1.in', 'n1.file', 'n1.force_ocr', 'n2.authorization', 'n2.customer_id', 'n2.document', 'n2.dsn', 'n2.headers', 'n2.mode', 'n2.webhook_url'],
  );

  // Another organisation starts from it (under cp_app): the new flow carries none of it either.
  asUser(memberB);
  const used = await call('POST', `/api/flow-templates/${row!.id}/use`, undefined, T_B);
  expect(used.status).toBe(201);
  const fg = (await loadFlow(used.json.flowId)).graph as FlowGraph;
  expect(fg.nodes.length).toBe(3);
  expect(leaked(fg)).toEqual([]);
});

test('SAVE organisation template: config is kept as-is (same tenant)', async () => {
  asUser(superA);
  const { status, json } = await call('POST', '/api/flow-templates', { flowId: FLOW_SUPER_PII, name: 'Ftpl PII org' }, T_A);
  expect(status).toBe(201);
  expect(json.template.scope).toBe('tenant');
  const [row] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, json.template.id));
  expect((row!.graph as FlowGraph).nodes.find((n) => n.id === 'n2')!.config).toEqual(piiGraph().nodes[2]!.config);
});

test('createdBy: a starter hides its platform-admin creator from every non-super_admin; org templates keep theirs', async () => {
  asUser(superA);
  const saved = await call('POST', '/api/flow-templates?scope=global', { flowId: FLOW_SUPER, name: 'Ftpl creator starter' });
  expect(saved.status).toBe(201);
  const starter = saved.json.template.id as string;
  expect(saved.json.template.createdBy).toBe(superA.id); // the super_admin who saved it

  for (const [viewer, tenant] of [[memberA, T_A], [devA, T_A], [adminA, T_A], [memberB, T_B]] as const) {
    asUser(viewer);
    const one = await call('GET', `/api/flow-templates/${starter}`, undefined, tenant);
    expect(one.status).toBe(200);
    expect(one.json.template.createdBy, viewer.email).toBeNull();
    const list = await call('GET', '/api/flow-templates', undefined, tenant);
    const listed = list.json.templates.filter((t: { scope: string }) => t.scope === 'global');
    expect(listed.length).toBeGreaterThan(0);
    for (const t of listed) expect(t.createdBy, `${viewer.email} ${t.id}`).toBeNull();
  }
  asUser(memberA);
  expect((await call('GET', `/api/flow-templates/${TPL_A}`, undefined, T_A)).json.template.createdBy).toBe(devA.id);
  asUser(superA);
  expect((await call('GET', `/api/flow-templates/${starter}`)).json.template.createdBy).toBe(superA.id);
});

// ---------------------------------------------------------------------------------------------- archive

test('ARCHIVE: a non-creator member is refused; the creator archives; a starter needs a super_admin', async () => {
  asUser(memberA);
  const refused = await call('DELETE', `/api/flow-templates/${TPL_A}`);
  expect(refused.status).toBe(403);
  expect(refused.json.error).toBe('tenant_admin_required');

  asUser(devA);
  const starter = await call('DELETE', `/api/flow-templates/${await starterId('claims-by-status')}`);
  expect(starter.status).toBe(403);
  expect(starter.json.error).toBe('super_admin_required');

  expect((await call('DELETE', `/api/flow-templates/${TPL_A}`, undefined, T_A)).status).toBe(204);
  const { json } = await call('GET', '/api/flow-templates', undefined, T_A);
  expect(json.templates.map((t: { id: string }) => t.id)).not.toContain(TPL_A);
  await db.update(flowTemplates).set({ archived_at: null }).where(eq(flowTemplates.id, TPL_A));
});

test('ARCHIVE: a tenant_admin may archive a colleague’s template', async () => {
  asUser(adminA);
  expect((await call('DELETE', `/api/flow-templates/${TPL_A}`, undefined, T_A)).status).toBe(204);
  await db.update(flowTemplates).set({ archived_at: null }).where(eq(flowTemplates.id, TPL_A));
});

// ---------------------------------------------------------------------------------------------- solutions

test('use-as-start: a member starts from a solution of their own tenant (cp_app)', async () => {
  asUser(memberA);
  const { status, json } = await call('POST', `/api/solutions/${SOL_A}/use-as-start`, undefined, T_A);
  expect(status).toBe(201);
  const flow = await loadFlow(json.flowId);
  expect(flow.owner_id).toBe(memberA.id);
  expect(flow.tenant_id).toBe(T_A);
  expect(flow.name).toBe('Ftpl solution A');
  expect((flow.graph as FlowGraph).nodes.map((n) => n.id)).not.toContain('n1');
});

test('use-as-start: another tenant’s solution is 404 — under cp_app and on the owner connection', async () => {
  asUser(memberA);
  expect((await call('POST', `/api/solutions/${SOL_B}/use-as-start`, undefined, T_A)).status).toBe(404);
  expect((await call('POST', `/api/solutions/${SOL_B}/use-as-start`)).status).toBe(404);
});

test('use-as-start: a solution with no flow is a 422', async () => {
  asUser(memberA);
  const { status, json } = await call('POST', `/api/solutions/${SOL_A_EMPTY}/use-as-start`);
  expect(status).toBe(422);
  expect(json.error).toBe('solution_no_flow');
});

// ---------------------------------------------------------------------------------------------- seed

test('seed is idempotent and never touches a tenant row that shares a seed_key', async () => {
  const snapshot = async () =>
    db
      .select({ id: flowTemplates.id, key: flowTemplates.seed_key, updated: flowTemplates.updated_at, graph: flowTemplates.graph })
      .from(flowTemplates)
      .where(isNull(flowTemplates.tenant_id));
  const before = await snapshot();
  const again = await seedFlowTemplates();
  expect(again.total).toBe(loadFlowSeedFiles().length);
  expect(again.created).toBe(0);
  expect(again.updated).toBe(0);
  const after = await snapshot();
  expect(after).toEqual(before);
  const [tenantCopy] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, TPL_A_SEEDKEY));
  expect(tenantCopy!.name).toBe('Ftpl tenant copy, must survive the seeder');
  expect(tenantCopy!.graph).toEqual({ nodes: [], edges: [] });
});

async function starterTranslationCells() {
  const ids = await Promise.all(loadFlowSeedFiles().map((f) => starterId(f.seed_key)));
  return db
    .select({
      id: contentTranslations.entity_id,
      locale: contentTranslations.locale,
      field: contentTranslations.field,
      value: contentTranslations.value,
      xmin: sql<string>`${sql.raw('content_translations.xmin')}::text`,
    })
    .from(contentTranslations)
    .where(and(eq(contentTranslations.entity_type, FLOW_TEMPLATE_I18N), inArray(contentTranslations.entity_id, ids)));
}

test('seed translations: a re-run writes 0 rows (xmin unchanged) and never reverts a corrected cell', async () => {
  const expected = loadFlowSeedFiles().reduce((n, f) => n + Object.keys(f.i18n ?? {}).length * 2, 0);
  const before = await starterTranslationCells();
  expect(expected).toBeGreaterThan(0);
  expect(before.length).toBe(expected); // every seeded cell exists (first boot inserted them)

  const again = await seedFlowTemplates();
  expect(again.translations).toBe(0);
  const after = await starterTranslationCells();
  const key = (c: { id: string; locale: string; field: string }) => `${c.id}|${c.locale}|${c.field}`;
  const xminBefore = new Map(before.map((c) => [key(c), c.xmin]));
  for (const c of after) expect(c.xmin, key(c)).toBe(xminBefore.get(key(c))!);

  // A translator corrects one cell; the next boot must not put the seed text back.
  const target = before[0]!;
  const where = and(
    eq(contentTranslations.entity_type, FLOW_TEMPLATE_I18N),
    eq(contentTranslations.entity_id, target.id),
    eq(contentTranslations.locale, target.locale),
    eq(contentTranslations.field, target.field),
  );
  await db.update(contentTranslations).set({ value: 'Ftpl corrected by a translator' }).where(where);
  try {
    await seedFlowTemplates();
    const [cell] = await db.select({ value: contentTranslations.value }).from(contentTranslations).where(where);
    expect(cell!.value).toBe('Ftpl corrected by a translator');
  } finally {
    await db.update(contentTranslations).set({ value: target.value }).where(where);
  }

  // And a missing cell is still (re)inserted — insert-if-missing, not "never write".
  await db.delete(contentTranslations).where(where);
  const healed = await seedFlowTemplates();
  expect(healed.translations).toBe(1);
  const [back] = await db.select({ value: contentTranslations.value }).from(contentTranslations).where(where);
  expect(back!.value).toBe(target.value);
});

test('seed: an archived starter stays archived even when the re-run DOES update its content', async () => {
  const file = loadFlowSeedFiles().find((f) => f.seed_key === 'claims-by-status')!;
  const sid = await starterId(file.seed_key);
  const archivedAt = new Date('2026-10-01T00:00:00Z');
  // Stale content forces the IS DISTINCT FROM branch, so the UPDATE really executes against this row —
  // an update set that cleared archived_at would run here (with unchanged content it never would).
  await db.update(flowTemplates).set({ name: 'Ftpl stale starter name', archived_at: archivedAt }).where(eq(flowTemplates.id, sid));
  try {
    const out = await seedFlowTemplates();
    expect(out.updated).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(flowTemplates).where(eq(flowTemplates.id, sid));
    expect(row!.name).toBe(file.name); // the update ran
    expect(row!.archived_at).toEqual(archivedAt); // and did not un-archive
  } finally {
    await db.update(flowTemplates).set({ archived_at: null, name: file.name }).where(eq(flowTemplates.id, sid));
  }
});
