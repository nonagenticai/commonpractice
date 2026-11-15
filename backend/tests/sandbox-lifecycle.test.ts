// tests/sandbox-lifecycle.test.ts — Session 4 sandbox lifecycle + enforcement.
//   * ensureSandbox: provision-on-demand + idempotent (one primary per user).
//   * transitionSandbox: running/idle/error + idle-clock touch.
//   * sweepIdleSandboxes: pure idle-sweep (targets only ancient rows via a long
//     threshold so the seeded demo sandboxes are never touched).
//   * suspend gate: a suspended sandbox blocks POST /api/runs (422, no spawn).
// Driven in-process against Postgres (:5433); auth via __setAuthOverridesForTests.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerRunRoutes } from '../src/host/run-controller';
import {
  ensureSandbox,
  resumeOwnIdleSandbox,
  transitionSandbox,
  sweepIdleSandboxes,
} from '../src/host/sandbox-service';
import {
  db,
  auditLog,
  tenants,
  users,
  flows,
  flowRuns,
  sandboxes,
  buildingBlocks,
  blockVersions,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { FlowGraph } from '../src/db/flow-types';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';

const USER_ID = '00000000-0000-0000-0000-0000005b0001';
const user: User = { id: USER_ID, email: 'sandbox@test', name: 'Sandbox Tester', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const SLUG_PREFIX = 'ztest-sblc-';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerRunRoutes(router);

async function callJson(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(flowRuns).where(eq(flowRuns.triggered_by, USER_ID));
  await db.delete(flows).where(eq(flows.owner_id, USER_ID));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, USER_ID));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(inArray(buildingBlocks.slug, [SLUG_PREFIX + 'double']));
  const ids = blocks.map((b) => b.id);
  if (ids.length) {
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, ids));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, ids));
  }
  await db.delete(users).where(eq(users.id, USER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: USER_ID, email: user.email, name: user.name }).onConflictDoNothing();
  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

test('ensureSandbox provisions one sandbox and is idempotent', async () => {
  const a = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  expect(a.owner_id).toBe(USER_ID);
  expect(a.status).toBe('idle');
  const b = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  expect(b.id).toBe(a.id); // same primary, not a second sandbox
  const all = await db.select().from(sandboxes).where(eq(sandboxes.owner_id, USER_ID));
  expect(all).toHaveLength(1);
});

test('transitionSandbox flips status and touches the idle clock for activity', async () => {
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await transitionSandbox(sb.id, 'running');
  let [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(row!.status).toBe('running');
  const tRunning = row!.last_active_at!;
  await transitionSandbox(sb.id, 'error');
  [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(row!.status).toBe('error');
  expect(row!.last_active_at!.getTime()).toBeGreaterThanOrEqual(tRunning.getTime());
});

test('sweepIdleSandboxes suspends ancient idle/error rows, spares running + recent', async () => {
  // Reset our primary to idle, then set its clock far in the past.
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  const ancient = new Date('2020-01-01T00:00:00Z');
  await db.update(sandboxes).set({ status: 'idle', last_active_at: ancient }).where(eq(sandboxes.id, sb.id));

  // A second, RUNNING sandbox (also ancient) must NOT be swept (status filter).
  const [running] = await db
    .insert(sandboxes)
    .values({ owner_id: USER_ID, slug: SLUG_PREFIX + 'running', status: 'running', last_active_at: ancient, tenant_id: DEMO_TENANT_ID })
    .returning();

  // Threshold = 1 year → cutoff ~1y ago: only the 2020 rows qualify; the seeded
  // demo sandboxes (recent) are safely outside the window.
  const swept = await sweepIdleSandboxes(db, new Date(), { autoSuspendIdleMinutes: 525_600 });
  expect(swept).toContain(sb.id);
  expect(swept).not.toContain(running!.id);

  const [idleRow] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(idleRow!.status).toBe('suspended');
  const [runRow] = await db.select().from(sandboxes).where(eq(sandboxes.id, running!.id));
  expect(runRow!.status).toBe('running');
});

const DOUBLE_SRC = `export default {
  descriptor: { inputs: { n: { type: "number" } }, outputs: { doubled: { type: "number" } }, capabilities: {} },
  async run(inputs) { return { doubled: (inputs.n ?? 21) * 2 }; }
};`;

test('a suspended sandbox blocks POST /api/runs (422 sandbox_suspended, no spawn)', async () => {
  // Seed a runnable block + flow.
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG_PREFIX + 'double', name: 'double', category: 'logic' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      published_at: new Date(),
      source_ts: requireScannedSource(DOUBLE_SRC),
      descriptor: { inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {} } as never,
    })
    .returning();
  const graph: FlowGraph = {
    nodes: [{ id: 'n1', blockId: block!.id, blockVersionId: version!.id, slug: 'double', label: 'd', category: 'logic', config: { n: 10 }, position: { x: 0, y: 0 } }],
    edges: [],
  };
  const [flow] = await db.insert(flows).values({ name: 'gate-test', owner_id: USER_ID, graph, tenant_id: DEMO_TENANT_ID }).returning();

  // Suspend the user's sandbox, then attempt a run.
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await transitionSandbox(sb.id, 'suspended', db, { touchActivity: false });

  const r = await callJson('POST', '/api/runs', { flowId: flow!.id });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('sandbox_suspended');

  // No run row was created (the gate fired before insert/spawn).
  const runs = await db.select().from(flowRuns).where(eq(flowRuns.flow_id, flow!.id));
  expect(runs).toHaveLength(0);

  // Resume → idle → the gate would no longer block (status check only).
  await transitionSandbox(sb.id, 'idle', db, { touchActivity: true });
  const [resumed] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(resumed!.status).toBe('idle');
});

// ── An explicit run resumes the OWNER's idle-suspended sandbox (2026-10-15) ──────────────────────
// Prod: all 22 sandboxes were idle-suspended by the watchdog, so EVERY user's first Test run after a
// week away was a 422 "resume it and retry". The run is the owner's own explicit gesture, so it now
// resumes an IDLE suspension inside the claim transaction. An ADMIN pause stays fail-closed, and the
// resume can never reach another user's or another tenant's sandbox.

const OTHER_USER_ID = '00000000-0000-0000-0000-0000005b0002';
const OTHER_TENANT_ID = '00000000-0000-0000-0000-0000005b00f0';

async function gateFlowId(): Promise<string> {
  const [flow] = await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, USER_ID)).limit(1);
  if (!flow) throw new Error('gate-test flow missing — the suspended-sandbox test above seeds it');
  return flow.id;
}

async function waitClaimable(sandboxId: string) {
  for (let i = 0; i < 150; i++) {
    const [row] = await db.select({ status: sandboxes.status }).from(sandboxes).where(eq(sandboxes.id, sandboxId));
    if (row && (row.status === 'idle' || row.status === 'error')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sandbox never became claimable after 15s');
}

async function suspendIdle(sandboxId: string) {
  await transitionSandbox(sandboxId, 'suspended', db, { touchActivity: false, suspensionReason: 'idle' });
}

test("an explicit run RESUMES the owner's idle-suspended sandbox and is accepted", async () => {
  const flowId = await gateFlowId();
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await waitClaimable(sb.id);
  await suspendIdle(sb.id);

  const r = await callJson('POST', '/api/runs', { flowId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(r.json.runId).toBeTruthy();
  expect(r.json.sandboxId).toBe(sb.id);

  // The run row exists against the same sandbox, and the sandbox is no longer suspended.
  const runs = await db.select().from(flowRuns).where(eq(flowRuns.id, r.json.runId));
  expect(runs).toHaveLength(1);
  const [after] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(after!.status).not.toBe('suspended');
  expect(after!.suspension_reason).toBeNull();

  // …and the resume is attributed in the audit trail to the owner.
  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'sandbox.resume'), eq(auditLog.target_id, sb.slug), eq(auditLog.actor_id, USER_ID)));
  expect(audits.map((a) => a.result)).toContain('Owner resumed · test run');
  await waitClaimable(sb.id);
});

test('an ADMIN pause is never resumed by a run: 422 sandbox_suspended, no run row', async () => {
  const flowId = await gateFlowId();
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await waitClaimable(sb.id);
  const before = (await db.select().from(flowRuns).where(eq(flowRuns.flow_id, flowId))).length;
  await transitionSandbox(sb.id, 'suspended', db, { touchActivity: false, suspensionReason: 'admin' });

  const r = await callJson('POST', '/api/runs', { flowId });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('sandbox_suspended');
  expect(JSON.stringify(r.json)).toContain('admin');
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(row!.status).toBe('suspended');
  expect(row!.suspension_reason).toBe('admin');
  expect((await db.select().from(flowRuns).where(eq(flowRuns.flow_id, flowId))).length).toBe(before);

  await transitionSandbox(sb.id, 'idle', db);
});

test("a run never resumes ANOTHER user's or ANOTHER tenant's idle-suspended sandbox", async () => {
  const flowId = await gateFlowId();
  await db
    .insert(tenants)
    .values({ id: OTHER_TENANT_ID, name: 'Resume Other Org', slug: 'zresume-other-org', industry: 'insurance' })
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, email: 'sandbox-other@test', name: 'Other Owner', tenant_id: DEMO_TENANT_ID })
    .onConflictDoNothing();
  try {
    // Another user's idle-suspended primary, same tenant.
    const [theirs] = await db
      .insert(sandboxes)
      .values({ owner_id: OTHER_USER_ID, slug: SLUG_PREFIX + 'theirs', status: 'suspended', suspension_reason: 'idle', is_primary: true, tenant_id: DEMO_TENANT_ID })
      .returning();
    // The caller's OWN idle-suspended primary, but in a DIFFERENT tenant.
    const [otherTenant] = await db
      .insert(sandboxes)
      .values({ owner_id: USER_ID, slug: SLUG_PREFIX + 'other-tenant', status: 'suspended', suspension_reason: 'idle', is_primary: true, tenant_id: OTHER_TENANT_ID })
      .returning();

    const own = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
    await waitClaimable(own.id);
    const r = await callJson('POST', '/api/runs', { flowId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.sandboxId).toBe(own.id);

    const [t] = await db.select().from(sandboxes).where(eq(sandboxes.id, theirs!.id));
    expect(t!.status).toBe('suspended');
    const [o] = await db.select().from(sandboxes).where(eq(sandboxes.id, otherTenant!.id));
    expect(o!.status).toBe('suspended');

    // The helper itself, aimed straight at those rows with the wrong owner / wrong tenant: no-ops.
    expect(await resumeOwnIdleSandbox(db, { ownerId: USER_ID, tenantId: DEMO_TENANT_ID, sandboxId: theirs!.id })).toBeNull();
    expect(await resumeOwnIdleSandbox(db, { ownerId: USER_ID, tenantId: DEMO_TENANT_ID, sandboxId: otherTenant!.id })).toBeNull();
    expect((await db.select().from(sandboxes).where(eq(sandboxes.id, theirs!.id)))[0]!.status).toBe('suspended');
    expect((await db.select().from(sandboxes).where(eq(sandboxes.id, otherTenant!.id)))[0]!.status).toBe('suspended');
    await waitClaimable(own.id);
  } finally {
    await db.delete(sandboxes).where(inArray(sandboxes.slug, [SLUG_PREFIX + 'theirs', SLUG_PREFIX + 'other-tenant']));
    await db.delete(users).where(eq(users.id, OTHER_USER_ID));
    await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT_ID));
  }
});

// The resume lives INSIDE the claim transaction, after the idempotency lookup, so these two must
// leave an idle-suspended sandbox suspended. Mutant that reddens both: resume right after
// `ensureSandbox` (before validation and before the replay check).

test('a run REFUSED by validation leaves an idle-suspended sandbox suspended', async () => {
  const [block] = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG_PREFIX + 'double'));
  const [version] = await db.select({ id: blockVersions.id }).from(blockVersions).where(eq(blockVersions.block_id, block!.id));
  // A node pointing at a block version that does not exist: refused before any side effect.
  const graph: FlowGraph = {
    nodes: [{ id: 'n1', blockId: block!.id, blockVersionId: '00000000-0000-0000-0000-00000000dead', slug: 'double', label: 'd', category: 'logic', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
  expect(version).toBeTruthy();
  const [bad] = await db.insert(flows).values({ name: 'invalid-flow', owner_id: USER_ID, graph, tenant_id: DEMO_TENANT_ID }).returning();
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await waitClaimable(sb.id);
  await suspendIdle(sb.id);

  const r = await callJson('POST', '/api/runs', { flowId: bad!.id });
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  expect(r.json.error).not.toBe('sandbox_suspended');
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(row!.status).toBe('suspended');
  expect(row!.suspension_reason).toBe('idle');
  expect(await db.select().from(flowRuns).where(eq(flowRuns.flow_id, bad!.id))).toHaveLength(0);

  await transitionSandbox(sb.id, 'idle', db);
  await db.delete(flows).where(eq(flows.id, bad!.id));
});

test('an idempotent REPLAY returns the original run and does not resume the sandbox', async () => {
  const flowId = await gateFlowId();
  const sb = await withTenantDb(DEMO_TENANT_ID, () => ensureSandbox({ id: USER_ID, name: user.name }));
  await waitClaimable(sb.id);
  const key = `replay-${crypto.randomUUID()}`;
  const first = await callJson('POST', '/api/runs', { flowId }, { 'Idempotency-Key': key });
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  await waitClaimable(sb.id);
  await suspendIdle(sb.id);

  const replay = await callJson('POST', '/api/runs', { flowId }, { 'Idempotency-Key': key });
  expect(replay.status, JSON.stringify(replay.json)).toBe(200);
  expect(replay.json.idempotent).toBe(true);
  expect(replay.json.runId).toBe(first.json.runId);
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  expect(row!.status).toBe('suspended');
  expect(row!.suspension_reason).toBe('idle');

  await transitionSandbox(sb.id, 'idle', db);
});
