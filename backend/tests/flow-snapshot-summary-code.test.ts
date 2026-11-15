// tests/flow-snapshot-summary-code.test.ts — every one of the NINE snapshot-summary templates
// persists a `summary_code` and the machine `summary_params` its sentence interpolates (0071).
//
// ⛔ WHY A BEHAVIOURAL TEST AND NOT A SOURCE SCRAPE. `frontend/src/lib/i18n/
// flow-summary-label.backend-contract.test.ts` already diffs the code VOCABULARY against the
// frontend switch by reading source text. That cannot see whether the code ever reaches the ROW:
// a `code:` on a `mutate()` return that `applyEdit` forgets to thread into `writeSnapshot`, a
// `params` object built from the wrong variable, a column dropped by a `.values()` refactor — all
// of them leave the scrape green and every /build history row in English forever, because
// `summary_code IS NULL` is a legitimate value that nothing throws on. This is the same standard
// `graph-issue-machine-fields.test.ts` set for the validator: run the real thing, read the real
// row, assert the VALUE.
//
// Against the live dev/CI Postgres, like its siblings.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray, desc } from 'drizzle-orm';
import {
  db,
  withTenantDb,
  users,
  flows,
  flowSnapshots,
  auditLog,
  buildingBlocks,
  blockVersions,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { BlockDescriptor } from '../src/db/block-types';
import { emptyGraph } from '../src/db/flow-types';
import {
  addNode,
  connectNodes,
  disconnectNodes,
  removeNode,
  configureNode,
  moveNode,
  insertNode,
} from '../src/ai/flow-edit-service';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowRoutes } from '../src/routes/flows';
import type { User } from '../src/types';

const OWNER = '00000000-0000-0000-0000-00000071c0d1';
const SLUG = 'zz-summary-code-block';
let flowId = '';

const owner: User = { id: OWNER, email: 'code@test', name: 'Code', roles: ['employee'] };

const descriptor: BlockDescriptor = {
  inputs: { text: { type: 'string', required: true } },
  outputs: { summary: { type: 'string' } },
  capabilities: { llm: true },
};

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

async function cleanup() {
  const fids = (await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, OWNER))).map((f) => f.id);
  if (fids.length) {
    await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
    await db.delete(flows).where(inArray(flows.id, fids));
  }
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER));
  const blocks = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  if (blocks.length) {
    await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.slug, SLUG));
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  }
  await db.delete(users).where(eq(users.id, OWNER));
}

async function setup() {
  await db.insert(users).values({ id: OWNER, email: 'code@test', name: 'Code' }).onConflictDoNothing({ target: users.id });
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG, name: 'ZZ Summary Code', description: 'x', category: 'ai' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({ block_id: block!.id, version: '1.0.0', status: 'stable', descriptor, published_at: new Date() })
    .returning();
  await db.update(buildingBlocks).set({ current_version_id: version!.id }).where(eq(buildingBlocks.id, block!.id));
  const [flow] = await db
    .insert(flows)
    .values({ name: 'Summary Code Flow', owner_id: OWNER, tenant_id: DEMO_TENANT_ID, graph: emptyGraph() })
    .returning();
  flowId = flow!.id;
  __setAuthOverridesForTests({ validateAuth: async () => owner, requireRole: async () => owner });
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await setup();
}, 30_000);
afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

/** The newest flow_snapshots row for the test flow, straight out of the DB. */
async function newest() {
  const [row] = await db
    .select()
    .from(flowSnapshots)
    .where(eq(flowSnapshots.flow_id, flowId))
    .orderBy(desc(flowSnapshots.created_at));
  return row!;
}

const ctx = { userId: OWNER, actorId: OWNER };

// ============================================================================================
// The seven flow-edit templates.
// ============================================================================================

test('addNode persists flow_summary_added + {slug}, and the English summary UNCHANGED', async () => {
  const res = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_added');
  expect(row.summary_params).toEqual({ slug: SLUG });
  // ⛔ THE ENGLISH IS BYTE-IDENTICAL AND STAYS. It is what src/ai/mcp/tools.ts hands the model, and
  // it is the permanent fallback for every row that has no code. A change here is a wire break.
  expect(row.summary).toBe(`added ${SLUG}`);
  // …and `EditResult` — the MCP shape — did NOT grow the two fields.
  expect(res.summary).toBe(`added ${SLUG}`);
  // `as unknown as` because `EditResult` is an INTERFACE, so it has no index signature and tsc
  // refuses the direct cast (TS2352) — which is itself a small reminder that the shape is closed.
  expect(res as unknown as Record<string, unknown>).not.toHaveProperty('code');
  expect(res as unknown as Record<string, unknown>).not.toHaveProperty('params');
});

test('connectNodes persists flow_summary_connected + FOUR RAW fields, never a pre-joined ref', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const b = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  await withTenantDb(DEMO_TENANT_ID, () =>
    connectNodes(ctx, flowId, {
      source: a.nodeId!,
      sourceHandle: 'summary',
      target: b.nodeId!,
      targetHandle: 'text',
    }),
  );
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_connected');
  // ⛔ FOUR SEPARATE FIELDS, NOT TWO `a.b` STRINGS. The reader sees two compounds, but the JOIN is a
  // rendering decision that has to happen inside the bidi isolate — in the browser. Pre-joining
  // here would put the `.` on the wire outside the isolate, and ar/he swap the halves.
  expect(row.summary_params).toEqual({
    source: a.nodeId!,
    sourceHandle: 'summary',
    target: b.nodeId!,
    targetHandle: 'text',
  });
  expect(JSON.stringify(row.summary_params)).not.toContain(`${a.nodeId}.summary`);
  expect(row.summary).toBe(`connected ${a.nodeId}.summary → ${b.nodeId}.text`);
});

test('disconnectNodes persists flow_summary_disconnected + {edgeId}', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const b = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const e = await withTenantDb(DEMO_TENANT_ID, () =>
    connectNodes(ctx, flowId, { source: a.nodeId!, sourceHandle: 'summary', target: b.nodeId!, targetHandle: 'text' }),
  );
  await withTenantDb(DEMO_TENANT_ID, () => disconnectNodes(ctx, flowId, { edgeId: e.edgeId! }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_disconnected');
  expect(row.summary_params).toEqual({ edgeId: e.edgeId! });
  expect(row.summary).toBe(`disconnected edge ${e.edgeId}`);
});

test('removeNode persists flow_summary_removed + {nodeId}', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  await withTenantDb(DEMO_TENANT_ID, () => removeNode(ctx, flowId, { nodeId: a.nodeId! }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_removed');
  expect(row.summary_params).toEqual({ nodeId: a.nodeId! });
  expect(row.summary).toBe(`removed node ${a.nodeId}`);
});

test('configureNode persists flow_summary_configured + {nodeId, key} as TWO raw fields', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  await withTenantDb(DEMO_TENANT_ID, () => configureNode(ctx, flowId, { nodeId: a.nodeId!, key: 'model', value: 'x' }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_configured');
  // Same compound rule as `connected`: the `nodeId.key` join belongs with the isolation.
  expect(row.summary_params).toEqual({ nodeId: a.nodeId!, key: 'model' });
  expect(JSON.stringify(row.summary_params)).not.toContain(`${a.nodeId}.model`);
  expect(row.summary).toBe(`configured ${a.nodeId}.model`);
  // ⛔ AND THE VALUE IS NOT IN THE PARAMS. `configure_node` sets arbitrary block config — an API
  // key, a prompt, a customer name. The sentence names WHICH key changed, never to what.
  expect(JSON.stringify(row.summary_params)).not.toContain('x');
});

test('moveNode persists flow_summary_moved + {nodeId}', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  await withTenantDb(DEMO_TENANT_ID, () => moveNode(ctx, flowId, { nodeId: a.nodeId!, position: { x: 9, y: 9 } }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_moved');
  expect(row.summary_params).toEqual({ nodeId: a.nodeId! });
  expect(row.summary).toBe(`moved node ${a.nodeId}`);
});

test('insertNode persists flow_summary_inserted + {slug, edgeId}', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const b = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  const e = await withTenantDb(DEMO_TENANT_ID, () =>
    connectNodes(ctx, flowId, { source: a.nodeId!, sourceHandle: 'summary', target: b.nodeId!, targetHandle: 'text' }),
  );
  await withTenantDb(DEMO_TENANT_ID, () => insertNode(ctx, flowId, { slug: SLUG, edgeId: e.edgeId! }));
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_inserted');
  // ⚠️ TWO operands, NOT a compound — they are separated by real words in every catalog, and a
  // strong directional run between two isolates keeps their order. The compound rule is about
  // fields joined by a NEUTRAL (`.`), not about how many fields a sentence carries.
  expect(row.summary_params).toEqual({ slug: SLUG, edgeId: e.edgeId! });
  expect(row.summary).toBe(`inserted ${SLUG} into edge ${e.edgeId}`);
});

// ============================================================================================
// The two route templates — and the one branch that must emit NO code at all.
// ============================================================================================

test('a checkpoint with NO user text persists flow_summary_manual_checkpoint and NULL params', async () => {
  const cp = await call('POST', `/api/flows/${flowId}/snapshots`, {});
  expect(cp.status).toBe(201);
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_manual_checkpoint');
  // The only parameterless code: nothing to persist, and the reader never falls back on it (the
  // same exception `graph_issue_cycle` is).
  expect(row.summary_params).toBeNull();
  expect(row.summary).toBe('Manual checkpoint');
  // …and the LIST endpoint really ships both new fields, or none of this reaches a browser.
  expect(cp.json.summary_code).toBe('flow_summary_manual_checkpoint');
  expect(cp.json.summary_params).toBeNull();
});

test('⛔ a checkpoint the USER labelled emits NO code — the discriminator is PRESENCE, not value', async () => {
  await call('POST', `/api/flows/${flowId}/snapshots`, { summary: 'voor de demo van dinsdag' });
  const row = await newest();
  expect(row.summary_code).toBeNull();
  expect(row.summary_params).toBeNull();
  expect(row.summary).toBe('voor de demo van dinsdag');
});

test('⛔ …including a user who types EXACTLY the English default', async () => {
  // THE ONE A VALUE COMPARISON GETS WRONG. `summary === 'Manual checkpoint' → emit the code` looks
  // identical on every other input and silently translates this user's own words into whatever
  // language the reader happens to have selected. Their text is theirs.
  await call('POST', `/api/flows/${flowId}/snapshots`, { summary: 'Manual checkpoint' });
  const row = await newest();
  expect(row.summary_code).toBeNull();
  expect(row.summary).toBe('Manual checkpoint');

  // …and whitespace-only text is NOT user text — it falls to the default branch and IS coded.
  await call('POST', `/api/flows/${flowId}/snapshots`, { summary: '   ' });
  const blank = await newest();
  expect(blank.summary_code).toBe('flow_summary_manual_checkpoint');
  expect(blank.summary).toBe('Manual checkpoint');
});

test('restore persists flow_summary_restored + the RAW ISO instant, never a formatted date', async () => {
  const cp = await call('POST', `/api/flows/${flowId}/snapshots`, { summary: 'good state' });
  const restore = await call('POST', `/api/flows/${flowId}/snapshots/${cp.json.id}/restore`);
  expect(restore.status).toBe(200);
  const row = await newest();
  expect(row.summary_code).toBe('flow_summary_restored');
  const at = (row.summary_params as { at?: string }).at;
  // ⛔ A RAW ISO INSTANT. The browser formats it with `fullDate(at, locale)`; shipping "Aug 7, 2026"
  // from here would be a second source of truth in a language this server had to guess.
  expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // …and it is the SAME instant the English sentence spells, i.e. one fact rendered twice.
  expect(row.summary).toBe(`Restored snapshot from ${at}`);
  // …and it really is the RESTORED-FROM snapshot's time, not the new row's own `created_at`.
  const [source] = await db.select().from(flowSnapshots).where(eq(flowSnapshots.id, cp.json.id));
  expect(at).toBe(new Date(source!.created_at).toISOString());
  expect(at).not.toBe(new Date(row.created_at).toISOString());
});

// ============================================================================================
// The read endpoints — both of them.
// ============================================================================================

test('⛔ BOTH read endpoints ship the two fields, and getSnapshot no longer leaks the raw row', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => addNode(ctx, flowId, { slug: SLUG }));
  expect(a.nodeId).toBeDefined();

  const list = await call('GET', `/api/flows/${flowId}/snapshots`);
  expect(list.status).toBe(200);
  expect(list.json.items).toHaveLength(1);
  expect(list.json.items[0].summary_code).toBe('flow_summary_added');
  expect(list.json.items[0].summary_params).toEqual({ slug: SLUG });

  const got = await call('GET', `/api/flows/${flowId}/snapshots/${list.json.items[0].id}`);
  expect(got.status).toBe(200);
  // The detail view renders through the SAME label module, so it must ship the same fields under
  // the same names — and the graph it exists for.
  expect(got.json.summary_code).toBe('flow_summary_added');
  expect(got.json.summary_params).toEqual({ slug: SLUG });
  expect(got.json.summary).toBe(`added ${SLUG}`);
  expect(got.json.graph.nodes).toHaveLength(1);
  // ⛔ IT IS A PROJECTION NOW, NOT `jsonResponse(snap)`. The raw drizzle row carried `tenant_id`
  // straight to the browser; a projection is also what stops the two endpoints drifting apart.
  expect(got.json.tenant_id).toBeUndefined();
  expect(Object.keys(got.json).sort()).toEqual(
    ['created_at', 'created_by', 'edge_count', 'graph', 'id', 'node_count', 'source', 'summary', 'summary_code', 'summary_params'].sort(),
  );
});

test('a pre-0071 row (no code) survives both endpoints with its English intact', async () => {
  // Inserted with `summary_code` unset, exactly as every row written before the migration is. There
  // is no backfill and there cannot be one, so this shape is permanent, not transitional.
  await db.insert(flowSnapshots).values({
    flow_id: flowId,
    graph: emptyGraph(),
    source: 'ai',
    summary: 'added legacy-block',
    created_by: OWNER,
    tenant_id: DEMO_TENANT_ID,
  });
  const list = await call('GET', `/api/flows/${flowId}/snapshots`);
  expect(list.json.items[0].summary).toBe('added legacy-block');
  expect(list.json.items[0].summary_code).toBeNull();
  expect(list.json.items[0].summary_params).toBeNull();
});
