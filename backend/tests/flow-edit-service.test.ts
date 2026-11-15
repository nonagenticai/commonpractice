// tests/flow-edit-service.test.ts — the headless flow-edit fallback (Stage C):
// owner-scoped graph mutations that snapshot (flow_snapshots, source='ai') + audit.
// Against the live :5433 DB; seeds an owner, a non-owner, a block, and a flow.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
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
import { addNode, connectNodes, removeNode } from '../src/ai/flow-edit-service';

const OWNER = '00000000-0000-0000-0000-0000000d0001';
const OTHER = '00000000-0000-0000-0000-0000000d0002';
const SLUG = 'zz-edit-test-block';
let flowId = '';

const descriptor: BlockDescriptor = {
  inputs: { text: { type: 'string', required: true } },
  outputs: { summary: { type: 'string' } },
  capabilities: { llm: true },
};

async function cleanup() {
  const fids = (
    await db.select({ id: flows.id }).from(flows).where(inArray(flows.owner_id, [OWNER, OTHER]))
  ).map((f) => f.id);
  if (fids.length) {
    await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
    await db.delete(flows).where(inArray(flows.id, fids));
  }
  await db.delete(auditLog).where(inArray(auditLog.actor_id, [OWNER, OTHER]));
  const blocks = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  if (blocks.length) {
    await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.slug, SLUG));
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  }
  await db.delete(users).where(inArray(users.id, [OWNER, OTHER]));
}

async function setup() {
  await db
    .insert(users)
    .values([
      { id: OWNER, email: 'owner@test', name: 'Owner' },
      { id: OTHER, email: 'other@test', name: 'Other' },
    ])
    .onConflictDoNothing({ target: users.id });
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG, name: 'ZZ Edit Test', description: 'x', category: 'ai' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({ block_id: block!.id, version: '1.0.0', status: 'stable', descriptor, published_at: new Date() })
    .returning();
  await db.update(buildingBlocks).set({ current_version_id: version!.id }).where(eq(buildingBlocks.id, block!.id));
  const [flow] = await db
    .insert(flows)
    .values({ name: 'Edit Test Flow', owner_id: OWNER, tenant_id: DEMO_TENANT_ID, graph: emptyGraph() })
    .returning();
  flowId = flow!.id;
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await setup();
}, 30_000);
afterAll(cleanup, 30_000);

test('addNode appends a node, snapshots (source=ai), and audits', async () => {
  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    addNode({ userId: OWNER, actorId: OWNER }, flowId, { slug: SLUG }),
  );
  expect(res.graph.nodes.length).toBe(1);
  expect(res.graph.nodes[0]!.slug).toBe(SLUG);
  expect(res.nodeId).toBeDefined();

  const [persisted] = await db.select().from(flows).where(eq(flows.id, flowId));
  expect(persisted!.graph.nodes.length).toBe(1);

  const snaps = await db.select().from(flowSnapshots).where(eq(flowSnapshots.flow_id, flowId));
  expect(snaps.length).toBe(1);
  expect(snaps[0]!.source).toBe('ai');

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, OWNER), eq(auditLog.action, 'flow.edit')));
  expect(audits.length).toBe(1);
});

test('a non-owner editing the flow gets a 404 (owner-scoped)', async () => {
  await expect(
    withTenantDb(DEMO_TENANT_ID, () => addNode({ userId: OTHER, actorId: OTHER }, flowId, { slug: SLUG })),
  ).rejects.toThrow(/flow_not_found|No flow/);
});

test('connectNodes wires two added nodes; removeNode drops a node + its edges', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () =>
    addNode({ userId: OWNER, actorId: OWNER }, flowId, { slug: SLUG }),
  );
  const b = await withTenantDb(DEMO_TENANT_ID, () =>
    addNode({ userId: OWNER, actorId: OWNER }, flowId, { slug: SLUG }),
  );
  const conn = await withTenantDb(DEMO_TENANT_ID, () =>
    connectNodes({ userId: OWNER, actorId: OWNER }, flowId, {
      source: a.nodeId!,
      sourceHandle: 'summary',
      target: b.nodeId!,
      targetHandle: 'text',
    }),
  );
  expect(conn.graph.edges.length).toBe(1);

  const rem = await withTenantDb(DEMO_TENANT_ID, () =>
    removeNode({ userId: OWNER, actorId: OWNER }, flowId, { nodeId: b.nodeId! }),
  );
  expect(rem.graph.nodes.length).toBe(1);
  expect(rem.graph.edges.length).toBe(0); // the incident edge is gone
});
