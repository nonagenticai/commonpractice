// tests/mcp-validate-flow-foreach.test.ts — the pin for 83e4307.
//
// ⛔ WHAT THIS PINS, AND WHY IT IS NOT COSMETIC. A Phase-5 `foreach` container runs no block, so the
// builder persists it with `blockVersionId: ''` (frontend/src/lib/stores/builder-graph.ts,
// `newForeachNode`). `block_versions.id` is a `uuid` COLUMN. Before 83e4307, `descriptorsFor`
// (src/ai/mcp/tools.ts) batched the `blockVersionId` of EVERY node into one `id in ($1, …)`, so the
// empty string reached Postgres and it rejected the WHOLE statement:
//
//   PostgresError: invalid input syntax for type uuid: ""   (SQLSTATE 22P02, psql 18)
//
// That is not a missing row, it is a failed query — so MCP `validate_flow` AND `run_flow` answered
// an error for ANY flow containing a loop. The AI co-pilot's own validation path, on the product's
// primary authoring surface, on a first-class Phase-5 feature.
//
// ⚠️ THE MIXED GRAPH IS THE POINT. A foreach-ONLY flow passes either way: with no real node the id
// list is `['']` before the fix (still fatal) but `[]` after it, and `ids.length ? … : []` short-
// circuits — so a fix that filtered out EVERYTHING would look identical. The graph below therefore
// carries a foreach container AND a real block node, and the assertions are two-sided:
//   * negative — no error, no `missing-descriptor`: the empty string never reaches the driver;
//   * positive — the real block's descriptor IS in the returned map. Proven twice: `issues` is empty
//     (a missing descriptor would be its own issue), and a deliberately bogus target handle raises
//     `unknown-target-handle`, a rule `validateGraphAgainstBlocks` can only reach when `descFor`
//     RESOLVED that node's descriptor. An over-broad filter reds on both.
//
// Driven through the REAL entry point — `McpHost.callTool('validate_flow' | 'run_flow')`, the same
// path an MCP client takes — against the live Postgres. `descriptorsFor` is not exported and must
// not be: re-implementing its SELECT here would prove the SELECT, not the product, and the failure
// being pinned is the DRIVER'S, so it only exists against a real `uuid` column.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  flows,
  flowSnapshots,
  auditLog,
  buildingBlocks,
  blockVersions,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { BlockDescriptor } from '../src/db/block-types';
import type { FlowGraph } from '../src/db/flow-types';
import { McpHost, type McpAuthContext } from '../src/ai/mcp-server';
import { getPlatformTool, type McpToolContext } from '../src/ai/mcp/tools';

// ⛔ Fixture ids must be UNIQUE PER TEST FILE — every file shares ONE database (sequentially) and
// deletes/recreates its own fixtures, so a shared id makes one file rip a row out from under
// another's. See tests/fixture-id-collisions.test.ts, which reds if these are ever duplicated.
const OWNER = '00000000-0000-0000-0000-00000f0e0001';
const SLUG = 'zz-mcp-foreach-block';

const LOOP_NODE = 'loop-1';
const BLOCK_NODE = 'blk-1';

/** A real, published block version — the node whose descriptor MUST survive the foreach filter. */
const descriptor: BlockDescriptor = {
  inputs: { text: { type: 'string', required: true } },
  outputs: { summary: { type: 'string' } },
  capabilities: { llm: true },
};

const host = new McpHost();
const ctx: McpAuthContext = { userId: OWNER, tenantId: DEMO_TENANT_ID, roles: ['employee'] };

let flowId = '';
let versionId = '';

async function cleanup() {
  const fids = (await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, OWNER))).map(
    (f) => f.id,
  );
  if (fids.length) {
    await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
    await db.delete(flows).where(inArray(flows.id, fids));
  }
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, SLUG));
  if (blocks.length) {
    await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.slug, SLUG));
    await db.delete(blockVersions).where(
      inArray(blockVersions.block_id, blocks.map((b) => b.id)),
    );
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  }
  await db.delete(users).where(eq(users.id, OWNER));
}

/** The graph the BUILDER actually persists for "one real block inside a loop":
 *  a foreach container carrying the empty-string ids, plus a body node pinned to a real
 *  `block_versions.id`, wired container.item → block.text. */
function mixedGraph(overrides?: Partial<FlowGraph>): FlowGraph {
  return {
    nodes: [
      {
        // Exactly `newForeachNode`'s persisted shape — empty blockId/blockVersionId, slug 'foreach'.
        id: LOOP_NODE,
        blockId: '',
        blockVersionId: '',
        slug: 'foreach',
        label: 'For each row',
        category: 'logic',
        config: {},
        position: { x: 0, y: 0 },
        kind: 'foreach',
        loop: { rowsInput: 'in', maxIterations: 100 },
      },
      {
        // ⚠️ `kind` deliberately ABSENT — the field is optional on the wire and every plain block
        // node the builder creates omits it. A filter written as `=== 'block'` would drop this node
        // and the positive assertions below would red.
        id: BLOCK_NODE,
        blockId: '',
        blockVersionId: versionId,
        slug: SLUG,
        label: 'Summarize',
        category: 'ai',
        config: {},
        position: { x: 240, y: 0 },
        parentId: LOOP_NODE,
      },
    ],
    edges: [
      { id: 'e1', source: LOOP_NODE, sourceHandle: 'item', target: BLOCK_NODE, targetHandle: 'text' },
    ],
    ...overrides,
  };
}

async function setGraph(graph: FlowGraph) {
  await db.update(flows).set({ graph }).where(eq(flows.id, flowId));
}

async function setup() {
  await db
    .insert(users)
    .values({ id: OWNER, email: 'mcp-foreach@test', name: 'Foreach Owner' })
    .onConflictDoNothing({ target: users.id });
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG, name: 'ZZ Mcp Foreach Block', description: 'a test summarizer', category: 'ai' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      descriptor,
      published_at: new Date(),
    })
    .returning();
  versionId = version!.id;
  await db
    .update(buildingBlocks)
    .set({ current_version_id: version!.id })
    .where(eq(buildingBlocks.id, block!.id));
  const [flow] = await db
    .insert(flows)
    .values({
      name: 'ZZ Mcp Foreach Flow',
      owner_id: OWNER,
      tenant_id: DEMO_TENANT_ID,
      graph: { nodes: [], edges: [] },
    })
    .returning();
  flowId = flow!.id;
  await setGraph(mixedGraph());
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file and no cause.
beforeEach(async () => {
  await cleanup();
  await setup();
}, 30_000);
afterAll(cleanup, 30_000);

type Validation = { ok: boolean; issues: { rule: string; ref?: string }[]; nodeCount: number };

/** Dump the tool's own payload into the assertion message — when the pinned defect regresses this
 *  prints `invalid input syntax for type uuid: ""` verbatim in the failure, instead of `true !== false`. */
const why = (out: { result: unknown }) => `tool result: ${JSON.stringify(out.result)}`;

test('validate_flow on a graph mixing a foreach container with a real block does not 500', async () => {
  const out = await host.callTool('validate_flow', { flowId }, ctx);

  // THE DEFECT: before 83e4307 the foreach node's `blockVersionId: ''` went into `id in (…)` against
  // a uuid column and Postgres rejected the whole query, so this was `true` with
  // result.error = 'invalid input syntax for type uuid: ""'.
  expect(out.isError, why(out)).toBe(false);

  const v = out.result as Validation;
  expect(v.nodeCount).toBe(2); // both nodes were considered, not just the one that survives a filter

  // POSITIVE CONTROL. `validateGraphAgainstBlocks` raises `missing-descriptor` for any node whose
  // descriptor `descriptorsFor` failed to return. An empty (or foreach-only) map would red here,
  // which is what a fix that filtered out EVERYTHING would produce.
  expect(v.issues.filter((i) => i.rule === 'missing-descriptor')).toEqual([]);
  expect(v.issues, why(out)).toEqual([]);
  expect(v.ok).toBe(true);
});

test('the real block version IS in the descriptor map (a bogus handle can only be caught with it)', async () => {
  // `unknown-target-handle` is raised ONLY when `descFor(node)` resolved — i.e. only when
  // `descriptorsFor` actually returned THIS block version's descriptor from the database. It is
  // therefore a direct read of the map's contents through the real tool, not an inference.
  const g = mixedGraph();
  g.edges = [
    { id: 'e1', source: LOOP_NODE, sourceHandle: 'item', target: BLOCK_NODE, targetHandle: 'nope' },
  ];
  await setGraph(g);

  const out = await host.callTool('validate_flow', { flowId }, ctx);
  expect(out.isError, why(out)).toBe(false);

  const v = out.result as Validation;
  expect(v.issues.map((i) => i.rule)).toContain('unknown-target-handle');
  // …and NOT because the descriptor was missing altogether.
  expect(v.issues.filter((i) => i.rule === 'missing-descriptor')).toEqual([]);
});

test('run_flow reports the same flow run-ready (it shares descriptorsFor, and 500d too)', async () => {
  // run_flow does not execute anything — it calls the same `validateFlow` and appends a note — so
  // it took the identical empty-uuid hit. Pinned separately because it is a separate tool name on
  // the wire and a future refactor could give it its own descriptor path.
  const out = await host.callTool('run_flow', { flowId }, ctx);
  expect(out.isError, why(out)).toBe(false);

  const v = out.result as Validation & { note: string };
  expect(v.ok, why(out)).toBe(true);
  expect(v.issues).toEqual([]);
  expect(v.note).toContain('ready to run');
});

test('the tool handler itself does not throw — and names the driver error if it ever does again', async () => {
  // ⚠️ WHY THIS EXISTS BESIDE THE callTool TESTS. `McpHost.callTool` catches and FLATTENS every
  // throw to `err.message`, and drizzle's message is only the query dump ("Failed query: select …") —
  // the driver's actual sentence lives on `err.cause`. So the callTool assertions above red with a
  // rendered SQL statement, which is evidence of *a* failure but does not name THIS one. Driving the
  // tool's own handler (the exact function callTool invokes, from the exact catalogue lookup it
  // uses) lets the failure message walk the cause chain and print the fingerprint that identifies
  // the defect: `22P02 PostgresError: invalid input syntax for type uuid: ""`.
  const tool = getPlatformTool('validate_flow');
  expect(tool).toBeDefined();
  const toolCtx: McpToolContext = {
    userId: OWNER,
    tenantId: DEMO_TENANT_ID,
    roles: ['employee'],
    db,
    flowId: null,
    challengeId: null,
  };

  let thrown: unknown;
  let result: unknown;
  try {
    result = await tool!.handler({ flowId }, toolCtx);
  } catch (err) {
    thrown = err;
  }

  // `seen` is not defensive dressing: postgres.js hands back an error whose `cause` is ITSELF, so a
  // naive `while (e) e = e.cause` never terminates. Measured — without it this walk spins.
  const chain = (err: unknown): string => {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let e: any = err;
    while (e && !seen.has(e)) {
      seen.add(e);
      parts.push(`${e.code ? `${e.code} ` : ''}${e.name ?? 'Error'}: ${e.message}`);
      e = e.cause;
    }
    return parts.join('\n  caused by: ');
  };

  expect(thrown === undefined, thrown === undefined ? '' : chain(thrown)).toBe(true);
  expect((result as Validation).ok).toBe(true);
});

test('a foreach-only graph also validates (the empty id list must not be sent either)', async () => {
  // Weaker than the mixed case on its own — this is exactly the graph a filter-everything fix would
  // also pass — but it pins the OTHER half: `ids` is now empty, so the `ids.length ? … : []` guard
  // must skip the query rather than send `id in ()`.
  const g = mixedGraph();
  g.nodes = g.nodes.filter((n) => n.id === LOOP_NODE);
  g.edges = [];
  await setGraph(g);

  const out = await host.callTool('validate_flow', { flowId }, ctx);
  expect(out.isError, why(out)).toBe(false);
  expect((out.result as Validation).ok).toBe(true);
});
