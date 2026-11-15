// tests/runs.test.ts — integration: a REAL spawned subprocess run, end-to-end,
// driven through the in-process router against Postgres (:5433). Proves the
// trace pipeline, governance (llm cap, network strip), and SSE streaming. The
// broker uses its default mock provider (no key needed).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { reconcileStaleRuns, registerRunRoutes, runRegistry } from '../src/host/run-controller';
import { __setBrokerDepsForTests, mockProvider } from '../src/host/llm-broker';
import { registerRunStream, activeRemoteTailCount, remoteTailSubscriberCount } from '../src/host/sse-stream';
import { TIMEOUT_ERROR_REDACTED } from '../src/host/run-cost-visibility';
import { registerSandboxRoutes } from '../src/routes/sandboxes';
import {
  db,
  users,
  flows,
  flowRuns,
  flowRunEvents,
  buildingBlocks,
  blockVersions,
  usageCounters,
  auditLog,
  sandboxes,
  challenges,
  solutions,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { DEMO_TENANT_ID, config } from '../src/config';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';
import type { User } from '../src/types';
import { getSeedBlock } from '../src/db/seed';
import { LISA_NODES, LISA_EDGES } from '../src/db/seed-marketplace';
import { requireScannedSource } from '../src/blocks/source-gate';

const USER_ID = '00000000-0000-0000-0000-0000000c0001';
const AUTHOR_ID = '00000000-0000-0000-0000-0000000c0002';
const user: User = { id: USER_ID, email: 'runner@test', name: 'Runner', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const SLUG_PREFIX = 'ztest-run-';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerRunRoutes(router);
registerRunStream(router);
registerSandboxRoutes(router);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  return res;
}
async function callJson(method: string, path: string, body?: unknown) {
  const res = await call(method, path, body);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function callJsonWithHeaders(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = await call(method, path, body, headers);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * Insert a block + version with self-contained source. Returns ids.
 *
 * `plant` is for the ONE fixture whose source is banned ON PURPOSE — `NET_SRC` calls the ambient
 * `fetch`, because the test it backs proves the RUNNER STRIPS NETWORK AT RUNTIME. That source
 * cannot go through `requireScannedSource` (the save gate exists precisely to refuse it), and the
 * test must not be weakened to accommodate the gate: sandbox stripping is a different, deeper rail
 * than the static scan, and a defence-in-depth layer that is never exercised is not a layer. So the
 * row is written the way a PRE-GATE row was written — insert empty, then a raw UPDATE — which is
 * also exactly the legacy state the run paths have to cope with in production.
 */
async function makeBlock(slug: string, source: string, descriptor: object, opts: { plant?: boolean } = {}) {
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG_PREFIX + slug, name: slug, category: 'logic' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      published_at: new Date(),
      source_ts: opts.plant ? requireScannedSource('') : requireScannedSource(source),
      descriptor: descriptor as never,
    })
    .returning();
  if (opts.plant) {
    await db.execute(sql`update block_versions set source_ts = ${source} where id = ${version!.id}`);
  }
  return { blockId: block!.id, versionId: version!.id };
}

function singleNode(blockId: string, versionId: string, config: Record<string, unknown> = {}): FlowGraph {
  const n: FlowNode = {
    id: 'n1',
    blockId,
    blockVersionId: versionId,
    slug: 'node',
    label: 'node',
    category: 'logic',
    config,
    position: { x: 0, y: 0 },
  };
  return { nodes: [n], edges: [] };
}

async function makeFlow(graph: FlowGraph) {
  const [flow] = await db
    .insert(flows)
    .values({ name: 'run-test', owner_id: USER_ID, graph, tenant_id: DEMO_TENANT_ID })
    .returning();
  return flow!.id;
}

/** Drive a run to completion; returns the persisted flow_runs row. */
async function runToCompletion(flowId: string) {
  return runTargetToCompletion({ flowId });
}

async function runTargetToCompletion(body: { flowId?: string; solutionId?: string }) {
  const created = await callJson('POST', '/api/runs', body);
  expect(created.status).toBe(201);
  const runId = created.json.runId as string;
  const finished = await waitForRun(runId);
  // ⛔ WAIT FOR THE SANDBOX, NOT JUST THE RUN — the file's own note 60 lines below says why:
  // "THE RUN IS NOT 'FINISHED' UNTIL THE SANDBOX IS CLAIMABLE AGAIN." `waitForRun` polls
  // `flow_runs.status`, but the NEXT `POST /api/runs` claims the SANDBOX, and `finalize` writes
  // those two things as separate statements. Observing the terminal run status a moment before the
  // sandbox transition commits is legal, and back-to-back callers then 409 `sandbox_busy`.
  //
  // This was not theoretical: it reddened a FRONTEND-ONLY pull request (#259) in CI with
  // `Expected: 201, Received: 409` at this line, while passing 27/27 locally. PR #251 removed the
  // audit-write from that window; it did not — and could not — make two statements one.
  //
  // Every caller here runs back-to-back against one sandbox, so this helper owns the wait rather
  // than each test remembering to. Bounded and asserted: a sandbox that never becomes claimable is
  // a real defect and must fail loudly, not hang until the suite timeout.
  await waitForSandboxClaimable();
  return finished;
}

/** Poll until this user's sandbox is claimable again (`idle`/`error` — the states `POST /api/runs`
 *  accepts). Bounded; throws rather than returning a sandbox nobody can claim. */
async function waitForSandboxClaimable() {
  for (let i = 0; i < 150; i++) {
    const rows = await db
      .select({ status: sandboxes.status })
      .from(sandboxes)
      .where(eq(sandboxes.owner_id, USER_ID));
    if (rows.length === 0 || rows.every((r) => r.status === 'idle' || r.status === 'error')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = await db
    .select({ id: sandboxes.id, status: sandboxes.status })
    .from(sandboxes)
    .where(eq(sandboxes.owner_id, USER_ID));
  throw new Error(
    `sandbox never became claimable after 15s — still ${JSON.stringify(rows)}. That is a real ` +
      'defect in the run finalize path, not a slow machine.',
  );
}

async function waitForRun(runId: string) {
  for (let i = 0; i < 150; i++) {
    const got = await callJson('GET', `/api/runs/${runId}`);
    if (got.json.status !== 'running') return { runId, run: got.json };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} did not finish in time`);
}

/**
 * GET /api/runs/:id as a caller with `roles`, then back to the default user. LLM spend is
 * tenant_admin+ on the wire (host/run-cost-visibility.ts), so a test whose subject is cost reads the
 * row as an admin; the default `employee` caller gets it without the cost columns.
 */
async function getRunAs(runId: string, roles: string[]) {
  asUser({ ...user, roles });
  try {
    const got = await callJson('GET', `/api/runs/${runId}`);
    expect(got.status).toBe(200);
    return got.json as Record<string, unknown>;
  } finally {
    asUser(user);
  }
}

async function cleanup() {
  const owners = [USER_ID, AUTHOR_ID];
  // Delete viewer runs (which reference the author's flow_id) before any flow,
  // or the flow_id FK blocks the delete.
  await db.delete(flowRuns).where(inArray(flowRuns.triggered_by, owners));
  // Solutions reference source flows — delete the published records first.
  await db.delete(flows).where(inArray(flows.owner_id, owners));
  await db.delete(solutions).where(inArray(solutions.author_id, owners));
  await db.delete(challenges).where(inArray(challenges.submitter_id, owners));
  // A run provisions a sandbox for the test user (S4) — drop it before the user
  // row, or the owner_id FK blocks the delete.
  await db.delete(sandboxes).where(inArray(sandboxes.owner_id, owners));
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, owners));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(sql`${buildingBlocks.slug} LIKE ${SLUG_PREFIX + '%'}`);
  const ids = blocks.map((b) => b.id);
  if (ids.length) {
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, ids));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, ids));
  }
  await db.delete(users).where(inArray(users.id, owners));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: USER_ID, email: user.email, name: user.name },
      { id: AUTHOR_ID, email: 'author@test', name: 'Author' },
    ])
    .onConflictDoNothing();
  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user)); // keep auth installed across cases

const DOUBLE_SRC = `export default {
  descriptor: { inputs: { n: { type: "number" } }, outputs: { doubled: { type: "number" } }, capabilities: {} },
  async run(inputs, ctx) { ctx.log("info", "doubling", { n: inputs.n }); return { doubled: (inputs.n ?? 21) * 2 }; }
};`;

const AI_SRC = `export default {
  descriptor: { inputs: {}, outputs: { summary: { type: "string" } }, capabilities: { llm: true } },
  async run(inputs, ctx) { const r = await ctx.llm({ model: "claude-sonnet-4-6", prompt: "summarize hello" }); return { summary: r.text }; }
};`;

const NET_SRC = `export default {
  descriptor: { inputs: {}, outputs: { x: { type: "string" } }, capabilities: {} },
  async run() { await fetch("http://example.com"); return { x: "leaked" }; }
};`;

test('a mock-only flow runs end-to-end → status ok, trace has node_success + run_complete', async () => {
  const { blockId, versionId } = await makeBlock('double', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId, { n: 10 }));
  const { run } = await runToCompletion(flowId);
  expect(run.status).toBe('ok');
  const trace = run.trace as TraceEvent[];
  const success = trace.find((e) => e.type === 'node_success');
  expect(success).toBeTruthy();
  expect((success as { outputPreview: string }).outputPreview).toContain('"doubled":20');
  expect(trace.some((e) => e.type === 'log')).toBe(true);
  expect(trace.at(-1)).toMatchObject({ type: 'run_complete', status: 'ok' });
});

test("Lisa's seeded demo flow is self-contained → every node runs green (regression for the broken generic chain)", async () => {
  // Insert the exact blocks the authored seed graph wires, with their REAL source +
  // descriptor (db/seed.ts), then run the authored graph end-to-end. This guards
  // against a regression to the old buildChain (empty configs / crossed types) that
  // rendered fine but could never actually run.
  const ids: Record<string, { blockId: string; versionId: string }> = {};
  for (const spec of LISA_NODES) {
    if (ids[spec.slug]) continue; // distinct blocks only
    const b = getSeedBlock(spec.slug);
    ids[spec.slug] = await makeBlock(spec.slug, b.source, b.descriptor);
  }
  const nodes: FlowNode[] = LISA_NODES.map((spec) => ({
    id: spec.nodeId,
    blockId: ids[spec.slug]!.blockId,
    blockVersionId: ids[spec.slug]!.versionId,
    slug: spec.slug,
    label: spec.slug,
    category: 'logic',
    config: spec.config,
    position: spec.position,
  }));
  const flowId = await makeFlow({ nodes, edges: LISA_EDGES.map((e) => ({ ...e })) });
  const { run } = await runToCompletion(flowId);
  expect(run.status).toBe('ok');
  const trace = run.trace as TraceEvent[];
  expect(trace.some((e) => e.type === 'node_error')).toBe(false);
  expect(trace.filter((e) => e.type === 'node_success')).toHaveLength(LISA_NODES.length);
  expect(trace.at(-1)).toMatchObject({ type: 'run_complete', status: 'ok' });
});

test('"Try it": a viewer runs a solution-backed flow they do not own, in their own sandbox', async () => {
  const { blockId, versionId } = await makeBlock('shared', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  // A real published solution (challenge + solution) the author's flow backs.
  const [ch] = await db
    .insert(challenges)
    .values({ title: 'tryit-ch', work_area: 'ops', submitter_id: AUTHOR_ID, tenant_id: AUTHOR_ID, created_at: new Date(), updated_at: new Date() })
    .returning();
  const publishedGraph = singleNode(blockId, versionId, { n: 5 });
  // The author owns the source flow; the solution holds the immutable publication graph.
  const [authorFlow] = await db
    .insert(flows)
    .values({
      name: 'authored',
      owner_id: AUTHOR_ID,
      graph: publishedGraph,
      tenant_id: DEMO_TENANT_ID,
    })
    .returning();
  await db.insert(solutions).values({
    challenge_id: ch!.id,
    title: 'tryit-sol',
    author_id: AUTHOR_ID,
    tenant_id: DEMO_TENANT_ID,
    flow_id: authorFlow!.id,
    published_graph: publishedGraph,
    published_manifest: [{
      nodeId: 'n1', blockId, versionId, slug: 'node',
      descriptor: { inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
    }],
    published_hash: 'test',
    published_at: new Date(),
    published_by: AUTHOR_ID,
    created_at: new Date(),
    updated_at: new Date(),
  });
  // The viewer (USER_ID) runs it: executes + meters in the viewer's sandbox.
  const { run } = await runToCompletion(authorFlow!.id);
  expect(run.status).toBe('ok');
  expect(run.triggered_by).toBe(USER_ID);
});

test('a viewer cannot run a private flow they do not own (404)', async () => {
  const { blockId, versionId } = await makeBlock('priv', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  const [privateFlow] = await db
    .insert(flows)
    .values({ name: 'private', owner_id: AUTHOR_ID, graph: singleNode(blockId, versionId, { n: 5 }), tenant_id: DEMO_TENANT_ID })
    .returning();
  const r = await callJson('POST', '/api/runs', { flowId: privateFlow!.id });
  expect(r.status).toBe(404);
  expect(r.json.error).toBe('flow_not_found');
});

test('rejects an unknown block version (422 missing_block_version)', async () => {
  const flowId = await makeFlow(
    singleNode('00000000-0000-0000-0000-0000000c00aa', '00000000-0000-0000-0000-0000000c00bb'),
  );
  const r = await callJson('POST', '/api/runs', { flowId });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('missing_block_version');
  // ⛔ THE OFFENDER'S NAME IS ON THE WIRE. The SPA replaces this English sentence with localized
  // copy (frontend/src/lib/api/error-message.ts `VALIDATION_MESSAGES`) and interpolates this field;
  // without it the Dutch refusal reads "a block in this flow", which on a 40-node graph names
  // nothing. `nodeId`/`blockId` cannot substitute — they are `n1` and a uuid.
  expect(r.json.blockSlug).toBe('node');
});

test('rejects a cyclic flow pre-flight (422 flow_invalid)', async () => {
  const { blockId, versionId } = await makeBlock('cyc', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  const a: FlowNode = { id: 'a', blockId, blockVersionId: versionId, slug: 's', label: 'a', category: 'logic', config: {}, position: { x: 0, y: 0 } };
  const b: FlowNode = { ...a, id: 'b' };
  const cyclic: FlowGraph = {
    nodes: [a, b],
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'doubled', target: 'b', targetHandle: 'n' },
      { id: 'e2', source: 'b', sourceHandle: 'doubled', target: 'a', targetHandle: 'n' },
    ],
  };
  const flowId = await makeFlow(cyclic);
  const r = await callJson('POST', '/api/runs', { flowId });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('flow_invalid');
  expect(r.json.issues.some((i: { rule: string }) => i.rule === 'cycle')).toBe(true);
});

test('network is stripped in the runner: a fetch() call → node_error block_throw', async () => {
  const { blockId, versionId } = await makeBlock('net', NET_SRC, {
    inputs: {},
    outputs: { x: { type: 'string' } },
    capabilities: {},
  }, { plant: true });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const { run } = await runToCompletion(flowId);
  expect(run.status).toBe('failed');
  const err = (run.trace as TraceEvent[]).find((e) => e.type === 'node_error');
  expect(err).toMatchObject({ kind: 'block_throw' });
  expect((err as { error: string }).error.toLowerCase()).toContain('fetch');
});

test('llm flow meters via the broker; exceeding the daily cap → node_error llm_capped', async () => {
  const { blockId, versionId } = await makeBlock('ai', AI_SRC, {
    inputs: {},
    outputs: { summary: { type: 'string' } },
    capabilities: { llm: true },
  });

  // 1. Under the cap → ok + usage metered.
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const { runId, run } = await runToCompletion(flowId);
  expect(run.status).toBe('ok');
  // Cost is the subject here, so read it as a tenant admin…
  const admin = await getRunAs(runId, ['tenant_admin']);
  expect(admin.llm_calls).toBe(1);
  expect(Number(admin.total_cost_usd)).toBeGreaterThan(0);
  // …and the run's own (member) caller gets the run without its spend.
  for (const roles of [['member'], ['developer'], ['employee']]) {
    const member = await getRunAs(runId, roles);
    expect(member.status, `${roles}`).toBe('ok');
    for (const col of ['llm_calls', 'total_cost_usd', 'tokens_in', 'tokens_out']) {
      expect(member, `${roles} received ${col}`).not.toHaveProperty(col);
    }
    const trace = member.trace as Record<string, unknown>[];
    expect(trace.find((e) => e.type === 'node_success'), `${roles}: no node_success`).toBeDefined();
    expect(trace.find((e) => e.type === 'node_success'), `${roles}`).not.toHaveProperty('cost');
    expect(trace.find((e) => e.type === 'run_complete'), `${roles}`).not.toHaveProperty('totals');
  }
  const [counter] = await db.select().from(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  expect(counter!.llm_calls).toBeGreaterThanOrEqual(1);

  // 2. Pin the counter at the daily cap → the next run's llm call is refused.
  await db.execute(
    sql`UPDATE usage_counters SET llm_calls = 1000 WHERE user_id = ${USER_ID} AND day = current_date`,
  );
  const flowId2 = await makeFlow(singleNode(blockId, versionId));
  const { run: run2 } = await runToCompletion(flowId2);
  expect(run2.status).toBe('failed');
  const err = (run2.trace as TraceEvent[]).find((e) => e.type === 'node_error');
  expect(err).toMatchObject({ kind: 'llm_capped' });
});

test('a refused call from a block that names NO model audits the RESOLVED model (AGENT_MODEL), not undefined', async () => {
  // The governance audit row (`llm.capped` / `model.blocked`) used to record `f.payload.model` — the
  // model the BLOCK typed. A block that names none (the seeded demo blocks, since 0102) audited
  // `model: undefined`, so the trail could not say what was refused. The broker now returns the
  // EFFECTIVE model and the controller audits that.
  const NO_MODEL_SRC = `export default {
  descriptor: { inputs: {}, outputs: { summary: { type: "string" } }, capabilities: { llm: true } },
  async run(inputs, ctx) { const r = await ctx.llm({ prompt: "summarize hello" }); return { summary: r.text }; }
};`;
  const { blockId, versionId } = await makeBlock('ai-no-model', NO_MODEL_SRC, {
    inputs: {},
    outputs: { summary: { type: 'string' } },
    capabilities: { llm: true },
  });
  await db.execute(sql`DELETE FROM usage_counters WHERE user_id = ${USER_ID} AND day = current_date`);
  await db.execute(
    sql`INSERT INTO usage_counters (tenant_id, user_id, day, llm_calls)
        VALUES (${DEMO_TENANT_ID}::uuid, ${USER_ID}, current_date, 1000)`,
  );
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const { run } = await runToCompletion(flowId);
  expect(run.status).toBe('failed');
  const rows = await db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    // EITHER governance refusal audits the model. Which one fires is order-dependent in this file
    // (an earlier case's model allowlist can refuse `local-llm` before the cap is reached); both
    // write the same `metadata.model`, which is what this pins.
    .where(
      and(
        sql`${auditLog.metadata}->>'runId' = ${run.id}`,
        inArray(auditLog.action, ['llm.capped', 'model.blocked']),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(config.agent.model).toBeTruthy();
  expect(rows[0]!.metadata).toMatchObject({ model: config.agent.model, runId: run.id });
  await db.execute(sql`UPDATE usage_counters SET llm_calls = 0 WHERE user_id = ${USER_ID} AND day = current_date`);
});

test('the daily cap rejects AT the threshold, not one call early or one call late', async () => {
  // ⛔ WHY THIS EXISTS WHEN A CAP TEST ALREADY DOES. The test above pins the counter to 1000 — far
  // past any plausible cap — so it proves "wildly over is refused" and says NOTHING about where the
  // boundary sits. The gate is `counter.llm_calls + 1 > limits.dailyLlmCap` (host/llm-broker.ts).
  // Flip that `>` to `>=` and a tenant silently gets cap-1 calls a day instead of cap; flip it to
  // `+ 0 >` and they get one free call past the limit. The 1000 test stays green through BOTH.
  //
  // This drives the real HTTP run route on both sides of the boundary, which is the only place the
  // rejection becomes something a user can see (`node_error` / `kind: 'llm_capped'`).
  //
  // ⚠️ The cap is READ, not hardcoded. It comes from the `spend.daily_llm_cap` governance row
  // (policy-store), which an operator can change on /governance — a literal 50 here would turn an
  // ordinary policy edit into a red suite, and would stop testing the boundary the moment it moved.
  const { getSnapshot } = await import('../src/host/policy-store');
  const cap = (await getSnapshot()).dailyLlmCap;
  expect(cap).toBeGreaterThan(1); // a cap of 0/1 would make "one below" meaningless

  const { blockId, versionId } = await makeBlock('cap-edge', AI_SRC, {
    inputs: {},
    outputs: { summary: { type: 'string' } },
    capabilities: { llm: true },
  });

  // ── ONE BELOW THE CAP: the call must be ALLOWED, and it must consume the last slot.
  // ⚠️ `tenant_id` is passed EXPLICITLY. The column's DEFAULT is `app_current_tenant_uuid()`,
  // which resolves only inside a tenant-scoped session (`withTenantDb` sets the GUC); a raw
  // `db.execute` here has no GUC, so the default yields NULL and the NOT NULL constraint fires.
  // Delete-then-insert rather than an upsert: `usage_counters`' natural key has MOVED (0058→0059),
  // and the broker itself uses an UNTARGETED `ON CONFLICT DO NOTHING` for exactly that reason —
  // naming a target here would work today and break the next time the key changes.
  await db.execute(
    sql`DELETE FROM usage_counters WHERE user_id = ${USER_ID} AND day = current_date`,
  );
  await db.execute(
    sql`INSERT INTO usage_counters (tenant_id, user_id, day, llm_calls)
        VALUES (${DEMO_TENANT_ID}::uuid, ${USER_ID}, current_date, ${cap - 1})`,
  );
  const okFlow = await makeFlow(singleNode(blockId, versionId));
  const { run: okRun } = await runToCompletion(okFlow);
  expect(okRun.status).toBe('ok');
  const [afterOk] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.user_id, USER_ID), eq(usageCounters.day, sql`current_date`)));
  // Landing exactly ON the cap is the state prod was measured in on 2026-08-08 (50/50), so this is
  // not a synthetic edge — it is the state a real user reaches.
  expect(afterOk!.llm_calls).toBe(cap);

  // ── EXACTLY AT THE CAP: the next call must be REFUSED.
  const capFlow = await makeFlow(singleNode(blockId, versionId));
  const { run: capRun } = await runToCompletion(capFlow);
  expect(capRun.status).toBe('failed');
  const capErr = (capRun.trace as TraceEvent[]).find((e) => e.type === 'node_error');
  expect(capErr).toMatchObject({ kind: 'llm_capped' });
  // The message names the limit, so an operator reading a failed run learns WHICH number bit.
  expect((capErr as { error: string }).error).toContain(String(cap));

  // ── AND THE REFUSAL COST NOTHING: a rejected call must not consume a slot or spend money.
  const [afterCap] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.user_id, USER_ID), eq(usageCounters.day, sql`current_date`)));
  expect(afterCap!.llm_calls).toBe(cap);
  expect(Number(afterCap!.reserved_spend_usd)).toBe(0);
});

test('SSE stream replays a finished run as text/event-stream and closes', async () => {
  const { blockId, versionId } = await makeBlock('sse', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId, { n: 5 }));
  const { runId } = await runToCompletion(flowId);

  const res = await call('GET', `/api/runs/${runId}/stream`);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const body = await res.text();
  expect(body).toContain('event: run_complete');
  expect(body).toContain('event: end');
  expect(body).toContain('id: 1');
});

// ⛔ LLM spend is tenant_admin+ ON THE WIRE, not just on screen. The browser hid the figure from a
// member, but the stream still delivered `node_success.cost` and `run_complete.totals` to them.
// Both stream paths are covered: the local registry handle and the cross-replica durable tail.
test('SSE stream strips cost fields for a member and keeps them for a tenant admin', async () => {
  const { blockId, versionId } = await makeBlock('sse-cost', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId, { n: 5 }));
  const { runId } = await runToCompletion(flowId);

  async function events(): Promise<Record<string, unknown>[]> {
    const body = await (await call('GET', `/api/runs/${runId}/stream`)).text();
    return body
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: {}')
      .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, unknown>);
  }
  const of = (evs: Record<string, unknown>[], type: string) => evs.find((e) => e.type === type);

  const paths = [
    { name: 'local handle', prep: () => {} },
    { name: 'durable tail', prep: () => runRegistry.delete(runId) },
  ];
  for (const path of paths) {
    path.prep();
    for (const roles of [['member'], ['developer'], ['employee']]) {
      asUser({ ...user, roles });
      const evs = await events();
      // NON-VACUITY: both events are on the stream, so an absent field is the gate.
      expect(of(evs, 'node_success'), `${path.name} ${roles}: no node_success`).toBeDefined();
      expect(of(evs, 'run_complete'), `${path.name} ${roles}: no run_complete`).toBeDefined();
      expect(of(evs, 'node_success')!, `${path.name} ${roles}`).not.toHaveProperty('cost');
      expect(of(evs, 'run_complete')!, `${path.name} ${roles}`).not.toHaveProperty('totals');
      expect(JSON.stringify(evs)).not.toMatch(/usd|tokensIn|tokensOut|llmCalls/);
    }
    for (const roles of [['tenant_admin'], ['super_admin']]) {
      asUser({ ...user, roles });
      const evs = await events();
      expect(of(evs, 'node_success')!, `${path.name} ${roles}`).toHaveProperty('cost.llmCalls');
      expect(of(evs, 'run_complete')!, `${path.name} ${roles}`).toHaveProperty('totals.usd');
    }
  }
  asUser(user);
});

test('a solution run uses its immutable graph after the source flow is edited and archived', async () => {
  const { blockId, versionId } = await makeBlock('immutable', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {},
  });
  const publishedGraph = singleNode(blockId, versionId, { n: 5 });
  const [source] = await db.insert(flows).values({
    name: 'immutable-source', owner_id: AUTHOR_ID, tenant_id: DEMO_TENANT_ID, graph: publishedGraph,
  }).returning();
  const [challenge] = await db.insert(challenges).values({
    title: 'immutable-challenge', work_area: 'ops', submitter_id: AUTHOR_ID, tenant_id: DEMO_TENANT_ID,
  }).returning();
  const [solution] = await db.insert(solutions).values({
    challenge_id: challenge!.id,
    tenant_id: DEMO_TENANT_ID,
    title: 'immutable-solution',
    author_id: AUTHOR_ID,
    flow_id: source!.id,
    published_graph: publishedGraph,
    published_manifest: [{
      nodeId: 'n1', blockId, versionId, slug: 'node',
      descriptor: { inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
    }],
    published_hash: 'immutable-test',
    published_at: new Date(),
    published_by: AUTHOR_ID,
  }).returning();
  await db.update(flows).set({
    graph: singleNode(blockId, versionId, { n: 999 }),
    status: 'archived',
  }).where(eq(flows.id, source!.id));

  const { run } = await runTargetToCompletion({ solutionId: solution!.id });
  const success = (run.trace as TraceEvent[]).find((event) => event.type === 'node_success');
  expect((success as { outputPreview: string }).outputPreview).toContain('"doubled":10');
  // The immutability trigger is scoped to the RUNTIME role (cp_app) so it cannot freeze the table
  // against migrations/runAsSystem. Tests run on an owner DSN, so this MUST assert under cp_app —
  // asserting as owner would pass vacuously and stop proving anything.
  const tamper = async () => {
    await withTenantDbAsRuntimeRoleForTests(DEMO_TENANT_ID, async () => {
      await db.update(solutions).set({ published_hash: 'tampered' }).where(eq(solutions.id, solution!.id)).returning();
    });
  };
  let tamperError: unknown;
  try {
    await tamper();
  } catch (error) {
    tamperError = error;
  }
  expect(tamperError).toBeDefined();
  const tamperMessage =
    (tamperError as { cause?: Error }).cause?.message ?? (tamperError as Error).message;
  expect(tamperMessage).toContain('published solution revision is immutable');

  // ...and the owner (migrations, runAsSystem, support) is deliberately still able to correct it.
  await db.update(solutions).set({ published_hash: 'owner-corrected' }).where(eq(solutions.id, solution!.id));
  const [corrected] = await db.select({ hash: solutions.published_hash }).from(solutions).where(eq(solutions.id, solution!.id));
  expect(corrected!.hash).toBe('owner-corrected');
});

test('draft, mismatched, and archived block versions are rejected before a run row exists', async () => {
  const [draftBlock] = await db.insert(buildingBlocks).values({
    slug: `${SLUG_PREFIX}draft-gate`, name: 'draft-gate', category: 'logic',
  }).returning();
  const [draftVersion] = await db.insert(blockVersions).values({
    block_id: draftBlock!.id,
    version: '0.1.0',
    status: 'draft',
    source_ts: requireScannedSource(DOUBLE_SRC),
    descriptor: { inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
  }).returning();
  const draftFlow = await makeFlow(singleNode(draftBlock!.id, draftVersion!.id, { n: 1 }));
  const draftRefusal = (await callJson('POST', '/api/runs', { flowId: draftFlow })).json;
  expect(draftRefusal.error).toBe('block_version_unpublished');
  // ⛔ THE **BLOCK's** SLUG, NOT THE NODE'S. `singleNode` always names the node 'node', so asserting
  // that here would pass with the field wired to the wrong source. This refusal is about the block,
  // and the author has to find it in the library by its own name.
  expect(draftRefusal.blockSlug).toBe(`${SLUG_PREFIX}draft-gate`);
  expect(draftRefusal.blockSlug).not.toBe('node');

  const a = await makeBlock('identity-a', DOUBLE_SRC, { inputs: {}, outputs: {}, capabilities: {} });
  const b = await makeBlock('identity-b', DOUBLE_SRC, { inputs: {}, outputs: {}, capabilities: {} });
  const mismatchFlow = await makeFlow(singleNode(a.blockId, b.versionId));
  const mismatchRefusal = (await callJson('POST', '/api/runs', { flowId: mismatchFlow })).json;
  expect(mismatchRefusal.error).toBe('block_version_mismatch');
  // Here the NODE's slug is right: the pinned version belongs to some other block, so naming that
  // block would send the author to the wrong place. The offender is the node on their canvas.
  expect(mismatchRefusal.blockSlug).toBe('node');

  await db.update(buildingBlocks).set({ archived: true }).where(eq(buildingBlocks.id, a.blockId));
  const archivedFlow = await makeFlow(singleNode(a.blockId, a.versionId));
  const archivedRefusal = (await callJson('POST', '/api/runs', { flowId: archivedFlow })).json;
  expect(archivedRefusal.error).toBe('block_archived');
  expect(archivedRefusal.blockSlug).toBe(`${SLUG_PREFIX}identity-a`);
});

test('an idempotency key returns the original live run instead of spawning twice', async () => {
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 300)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('idem', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const key = crypto.randomUUID();
  const first = await callJsonWithHeaders('POST', '/api/runs', { flowId }, { 'Idempotency-Key': key });
  const retry = await callJsonWithHeaders('POST', '/api/runs', { flowId }, { 'Idempotency-Key': key });
  expect(first.status).toBe(201);
  expect(retry.status).toBe(200);
  expect(retry.json.runId).toBe(first.json.runId);
  expect(retry.json.idempotent).toBe(true);
  await waitForRun(first.json.runId);
});

test('two different starts competing for one primary sandbox produce exactly one live run', async () => {
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 350)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('claim-race', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const start = () => callJsonWithHeaders(
    'POST',
    '/api/runs',
    { flowId },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  const attempts = await Promise.all([start(), start()]);
  expect(attempts.map((attempt) => attempt.status).sort()).toEqual([201, 409]);
  expect(attempts.find((attempt) => attempt.status === 409)!.json.error).toBe('sandbox_busy');
  await waitForRun(attempts.find((attempt) => attempt.status === 201)!.json.runId);
});

test('a stream on a replica without the local handle tails durable events until terminal', async () => {
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 250)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('remote-stream', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const created = await callJson('POST', '/api/runs', { flowId });
  expect(created.status).toBe(201);
  runRegistry.delete(created.json.runId); // simulate GET being routed to another backend replica
  const response = await call('GET', `/api/runs/${created.json.runId}/stream`);
  const text = await response.text();
  expect(text).toContain('event: run_complete');
  expect(text).toContain('event: end');
});

test('an expired lease is recovered after the executing replica disappears', async () => {
  const flowId = await makeFlow({ nodes: [], edges: [] });
  let [sandbox] = await db.select().from(sandboxes).where(and(
    eq(sandboxes.owner_id, USER_ID),
    eq(sandboxes.tenant_id, DEMO_TENANT_ID),
    eq(sandboxes.is_primary, true),
  ));
  if (sandbox) {
    [sandbox] = await db.update(sandboxes).set({ status: 'running' }).where(eq(sandboxes.id, sandbox.id)).returning();
  } else {
    [sandbox] = await db.insert(sandboxes).values({
      owner_id: USER_ID,
      tenant_id: DEMO_TENANT_ID,
      slug: `${SLUG_PREFIX}stale-sandbox`,
      status: 'running',
      is_primary: true,
    }).returning();
  }
  const [run] = await db.insert(flowRuns).values({
    flow_id: flowId,
    tenant_id: DEMO_TENANT_ID,
    triggered_by: USER_ID,
    sandbox_id: sandbox!.id,
    status: 'running',
    heartbeat_at: new Date(Date.now() - 120_000),
    lease_expires_at: new Date(Date.now() - 60_000),
  }).returning();

  expect(await reconcileStaleRuns()).toContain(run!.id);
  const [recovered] = await db.select().from(flowRuns).where(eq(flowRuns.id, run!.id));
  const [recoveredSandbox] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandbox!.id));
  const events = await db.select().from(flowRunEvents).where(eq(flowRunEvents.run_id, run!.id));
  expect(recovered!.status).toBe('failed');
  expect(recoveredSandbox!.status).toBe('error');
  expect((events[0]!.event as TraceEvent).type).toBe('run_complete');
});

test('an administrative pause aborts a live run and the finalizer cannot clear suspension', async () => {
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 3000)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('pause-live', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const created = await callJson('POST', '/api/runs', { flowId });
  expect(created.status).toBe(201);

  asUser({ ...user, roles: ['super_admin'] });
  const paused = await callJson('POST', `/api/sandboxes/${created.json.sandboxId}/pause`);
  expect(paused.status).toBe(200);
  expect(paused.json.cancelledRunIds).toContain(created.json.runId);

  asUser(user);
  const { run } = await waitForRun(created.json.runId);
  expect(run.status).toBe('failed');
  const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.id, created.json.sandboxId));
  expect(sandbox!.status).toBe('suspended');
  expect(sandbox!.suspension_reason).toBe('admin');
});

test('a sandbox stranded in running with no live run is released, not left permanently busy', async () => {
  // Before the atomic claim landed, a pod dying mid-run left the sandbox 'running' forever. The
  // claim now only accepts idle/error, so without this reconciliation the owner would get 409
  // sandbox_busy on every subsequent run — prod had 10 such rows against ZERO running flow_runs.
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, USER_ID));
  const [stranded] = await db.insert(sandboxes).values({
    owner_id: USER_ID,
    tenant_id: DEMO_TENANT_ID,
    slug: `${SLUG_PREFIX}stranded`,
    status: 'running',
    is_primary: true,
  }).returning();

  await reconcileStaleRuns();

  const [released] = await db.select().from(sandboxes).where(eq(sandboxes.id, stranded!.id));
  expect(released!.status).toBe('idle');

  // ...and the owner can actually start a run again rather than 409-ing forever.
  const { blockId, versionId } = await makeBlock('stranded-recover', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId, { n: 2 }));
  const { run } = await runToCompletion(flowId);
  expect(run.status).toBe('ok');
});

test('concurrent cross-replica streams for one run share a single poller', async () => {
  // One poller per RESPONSE (the naive shape) reserved a request-pool connection 4x/second per
  // viewer and could stall the whole pod — the 500-cascade class from PRs #77/#78. Cost must scale
  // with runs, not with viewers.
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 400)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('shared-tail', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const created = await callJson('POST', '/api/runs', { flowId });
  expect(created.status).toBe(201);
  runRegistry.delete(created.json.runId); // both reads now look like they hit another replica

  const [a, b] = await Promise.all([
    call('GET', `/api/runs/${created.json.runId}/stream`),
    call('GET', `/api/runs/${created.json.runId}/stream`),
  ]);
  // The discriminating assertion is the SUBSCRIBER count: a poller-per-response design would show
  // two tails serving one subscriber each. One tail serving two is what makes cost scale with runs.
  expect(activeRemoteTailCount()).toBe(1);
  expect(remoteTailSubscriberCount(created.json.runId)).toBe(2);

  const [textA, textB] = await Promise.all([a.text(), b.text()]);
  for (const text of [textA, textB]) {
    expect(text).toContain('event: run_complete');
    expect(text).toContain('event: end');
  }
  expect(activeRemoteTailCount()).toBe(0); // torn down once the run went terminal
});

// ---- WS3: the host's idle watchdog used to kill runs without ever saying so -------------------
//
// `resetIdle()` armed a flat 10 000 ms while the runner's own per-node budget was 15 000, so the
// HOST always won that race: `exec/flow-executor.ts`'s node-timeout racer — the one component that
// emits a proper `node_error{kind:'timeout'}` naming the node — was dead code in production. And
// on abort the channel's `lines` iterator ends NORMALLY (tearDown kills the attach, stdout hits
// EOF), so `spawnAndPump`'s catch never runs either. The entire record of a watchdog-killed run
// was `run_complete{status:'failed', totalMs:0}` — `● run failed · 0ms · $0.00` in the console,
// with no `✗` line, no message, and nothing in the pod log, while the tenant had already been
// metered for the LLM call that got thrown away.

/** Temporarily lower the idle watchdog. `config` is `as const` (readonly to tsc) but is a plain
 *  object at runtime — the cast is narrow and confined to this file so the suite does not have to
 *  wait out the real 20 s budget. Always restored in a `finally`. */
function setIdleMs(ms: number): number {
  const run = config.run as unknown as { idleMs: number };
  const previous = run.idleMs;
  run.idleMs = ms;
  return previous;
}

test('the idle watchdog explains itself: an abort emits a node_error NAMING the node it killed', async () => {
  // A block that goes silent for longer than the watchdog. idleMs is lowered for this test only —
  // waiting out the real 20 s budget would make the suite unusable, and the value under test is
  // the REPORTING of the abort, not the size of the budget (that is the invariant test below).
  const SILENT_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 5000)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('idle-abort', SILENT_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));

  const restoreIdle = setIdleMs(500);
  try {
    const created = await callJson('POST', '/api/runs', { flowId });
    expect(created.status).toBe(201);
    const { run: memberRun } = await waitForRun(created.json.runId);
    expect(memberRun.status).toBe('failed');
    // The watchdog's own words are developer+ on the wire (run-cost-visibility.ts): the default
    // caller (a member) gets the fixed sentence, a developer gets the record this test is about.
    const memberErr = (memberRun.trace as TraceEvent[]).find((e) => e.type === 'node_error');
    expect(memberErr).toMatchObject({ type: 'node_error', kind: 'timeout', error: TIMEOUT_ERROR_REDACTED });
    const run = await getRunAs(created.json.runId, ['developer']);

    const trace = run.trace as TraceEvent[];
    const err = trace.find((e) => e.type === 'node_error');
    // NON-VACUITY: delete the `if (handle.abortReason)` block in finalize() and this is undefined —
    // which is exactly what production did on every watchdog kill.
    expect(err).toBeDefined();
    expect(err).toMatchObject({ type: 'node_error', kind: 'timeout' });
    expect((err as { error: string }).error).toContain('idle watchdog');
    // It must name what it interrupted, not a fabricated node id.
    expect((err as { slug: string }).slug).toBe('node');
    // …and the error has to come BEFORE the terminator, or the console renders the failure first
    // and the explanation after it (or drops it — run_complete closes the stream).
    expect(trace.indexOf(err!)).toBeLessThan(trace.findIndex((e) => e.type === 'run_complete'));
    expect(trace.at(-1)).toMatchObject({ type: 'run_complete', status: 'failed' });
  } finally {
    setIdleMs(restoreIdle);
  }
}, 30_000);

test('a user-requested cancel does NOT fabricate an error event', async () => {
  // The other half of the contract, and the reason `abortReason` is set at the abort SITES rather
  // than blanket-applied in finalize: pressing Stop is not a failure. `ErrorKind` is a closed union
  // mirrored in the frontend trace types, BlockResultView and eight i18n catalogues — there is
  // deliberately no 'cancelled' member — so a cancel that synthesised a node_error would have to
  // lie about its kind and paint a red error in the console of someone who asked for the stop.
  const SLOW_SRC = `export default {
    descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
    async run() { await new Promise((resolve) => setTimeout(resolve, 3000)); return { ok: true }; }
  };`;
  const { blockId, versionId } = await makeBlock('cancel-quiet', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  const created = await callJson('POST', '/api/runs', { flowId });
  expect(created.status).toBe(201);

  asUser({ ...user, roles: ['super_admin'] });
  const paused = await callJson('POST', `/api/sandboxes/${created.json.sandboxId}/pause`);
  expect(paused.status).toBe(200);
  try {
    asUser(user);
    const { run } = await waitForRun(created.json.runId);
    expect(run.status).toBe('failed');
    const trace = run.trace as TraceEvent[];
    // NON-VACUITY: set an abortReason on the cancelRequestedAt branch too and this goes red.
    expect(trace.some((e) => e.type === 'node_error' && e.error.includes('idle watchdog'))).toBe(false);
  } finally {
    // RESUME. The sandbox is per-OWNER and shared by every case in this file, so leaving it
    // suspended makes every later `POST /api/runs` 422 `sandbox_suspended` — which is exactly how
    // this test first broke the two cases after it. Restore the state the case borrowed.
    asUser({ ...user, roles: ['super_admin'] });
    await callJson('POST', `/api/sandboxes/${created.json.sandboxId}/resume`);
    asUser(user);
  }
}, 30_000);

test('the host idle watchdog must outlast the runner budget it supervises', async () => {
  // The ordering invariant itself. While idleMs (10 000) sat BELOW maxNodeMs (15 000), a node that
  // legitimately ran 10-15 s was killed mid-execution by its own supervisor, and the runner could
  // never report a node timeout because the host had already destroyed the pod. Derived in
  // config.ts rather than independently configured so the two cannot drift apart again.
  // NON-VACUITY: restore `idleMs: int(process.env.RUN_IDLE_MS, 10000)` and this goes red.
  expect(config.run.idleMs).toBeGreaterThan(config.run.maxNodeMs);
  // And the outer wall-clock kill must outlast the silence watchdog, or the run dies before the
  // watchdog can name the cause.
  expect(config.run.maxRunMs).toBeGreaterThan(config.run.idleMs);
});

test('the run-budget ladder survives ANY single env var — not just the default posture', () => {
  // The default values passing proves almost nothing: the FIRST version of this fix chained
  // idleMs to maxNodeMs but left maxRunMs independent, so the defaults were ordered while
  // `RUN_MAX_NODE_MS=300000` produced node=300000, idle=305000, maxRunMs=30000 — the outermost
  // kill firing FIRST, i.e. the watchdog disabled again by one env var. An adversarial review
  // found it by setting exactly that. This re-derives the ladder the way config.ts does and
  // asserts the invariant across hostile inputs, so the shape is pinned rather than one sample.
  const derive = (nodeRaw?: string, idleRaw?: string, runRaw?: string) => {
    const int_ = (raw: string | undefined, fb: number) => {
      const n = Number.parseInt(raw ?? '', 10);
      return Number.isFinite(n) ? n : fb;
    };
    const node = Math.max(1000, int_(nodeRaw, 15000));
    const idle = Math.max(int_(idleRaw, node + 5000), node + 1000);
    const run = Math.max(int_(runRaw, 30000), idle + 1000);
    return { node, idle, run };
  };
  const cases: Array<[string, ReturnType<typeof derive>]> = [
    ['defaults', derive()],
    ['a very long per-node budget', derive('300000')],
    ['an operator lowering the watchdog below the node budget', derive(undefined, '5000')],
    ['an operator shrinking the wall clock below the watchdog', derive(undefined, undefined, '1000')],
    ['negative nonsense', derive('-5000')],
    ['unparseable nonsense', derive('abc', 'def', 'ghi')],
    ['all three raised together', derive('60000', '90000', '120000')],
  ];
  for (const [label, b] of cases) {
    expect(b.node, `${label}: maxNodeMs must be positive`).toBeGreaterThan(0);
    expect(b.idle, `${label}: idleMs must outlast maxNodeMs`).toBeGreaterThan(b.node);
    expect(b.run, `${label}: maxRunMs must outlast idleMs`).toBeGreaterThan(b.idle);
  }
  // …and the live config is one of those points.
  expect(config.run.maxNodeMs).toBeGreaterThan(0);
  expect(config.run.idleMs).toBeGreaterThan(config.run.maxNodeMs);
  expect(config.run.maxRunMs).toBeGreaterThan(config.run.idleMs);
});

test('a provider call SLOWER than the idle watchdog does not kill its own healthy run', async () => {
  // THE HEADLINE FIX. `onLine` calls `resetIdle()` at the TOP, then awaits the broker's provider
  // round-trip (bounded by llm.callTimeoutMs = 120 s, six times the watchdog) plus up to one
  // recordAudit. The pump is `await onLine(...)` inside `for await (const line of channel.lines)`,
  // so the iterator is not pulled and nothing re-arms; the runner is blocked on stdin awaiting the
  // llm_response, so it emits nothing either. Provider latency was therefore counted as SILENCE
  // and the host destroyed the pod of a run that was working perfectly — after metering it.
  //
  // The slow provider is keyed on THIS test's prompt marker. ⚠️ CORRECTED 2026-08-16: the reason
  // used to be "bun runs test FILES concurrently" — it does not (`--parallel` is opt-in and
  // implies `--isolate`; CI runs a plain `bun run test`; file durations are additive). See the
  // canonical note at the top of tests/metering-platform-calls.test.ts. This file IS one of the
  // FOURTEEN that share `__setBrokerDepsForTests` — it was missing from that list until the same
  // date. The keying stays because the singleton is never reset between the tests of THIS file
  // except by its own hooks, and because an unconditionally slow provider would still be installed
  // when a leaked in-flight call from anywhere resumes. Anything else falls through to the real mock.
  const SLOW_AI_SRC = `export default {
    descriptor: { inputs: {}, outputs: { summary: { type: "string" } }, capabilities: { llm: true } },
    async run(inputs, ctx) { const r = await ctx.llm({ model: "claude-sonnet-4-6", prompt: "ZSLOWPROVIDER summarize" }); return { summary: r.text }; }
  };`;
  const { blockId, versionId } = await makeBlock('slow-llm', SLOW_AI_SRC, {
    inputs: {}, outputs: { summary: { type: 'string' } }, capabilities: { llm: true },
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));

  // The broker-cap case earlier in this file pins llm_calls = 1000 and never resets it, so
  // without this the call is refused as llm_capped and the run fails in ~100ms — long before the
  // slow provider is even reached, which would make this test pass/fail for the wrong reason.
  await db.execute(sql`UPDATE usage_counters SET llm_calls = 0 WHERE user_id = ${USER_ID} AND day = current_date`);

  const PROVIDER_MS = 1200;
  const restoreIdle = setIdleMs(600); // strictly less than PROVIDER_MS — the whole point
  __setBrokerDepsForTests({
    provider: async (req) => {
      if (req.prompt.includes('ZSLOWPROVIDER')) {
        await new Promise((r) => setTimeout(r, PROVIDER_MS));
      }
      return mockProvider(req);
    },
  });
  try {
    const { runId, run } = await runToCompletion(flowId);
    // NON-VACUITY: delete the `resetIdle()` added before `channel.writeFrame(response)` in onLine
    // and this is 'failed' — the run is aborted mid-provider-call, exactly as production would.
    expect(run.status).toBe('ok');
    // `llm_calls` is tenant_admin+ on the wire (run-cost-visibility.ts).
    expect((await getRunAs(runId, ['tenant_admin'])).llm_calls).toBe(1);
    const trace = run.trace as TraceEvent[];
    expect(trace.some((e) => e.type === 'node_success')).toBe(true);
    expect(trace.at(-1)).toMatchObject({ type: 'run_complete', status: 'ok' });
  } finally {
    setIdleMs(restoreIdle);
    __setBrokerDepsForTests(undefined);
  }
}, 30_000);

test('a broker THROW between the pause and the re-arm still finalizes the run — the watchdog cannot leak', async () => {
  // The disarm hazard in the fix above. `pauseIdle()` stops the silence watchdog before the broker
  // await; if anything between there and `resetIdle()` escapes, the timer must not be left cleared
  // with the run still live — a permanently disarmed watchdog is STRICTLY WORSE than the bug it
  // replaced, because a genuinely hung runner would then never be killed at all.
  //
  // It cannot happen, and this pins why rather than trusting the reasoning: a throw propagates out
  // of onLine, out of `for await (const line of channel.lines)`, into spawnAndPump's catch — whose
  // `finally` clears both timers, disposes the channel and finalizes. The pump is over, so there is
  // no live run left to supervise. runMetered returns {ok:false} for a BrokerRejection but RETHROWS
  // anything that is not one (a metering-tenant fault, a DB error), which is the path exercised here.
  const AI2_SRC = `export default {
    descriptor: { inputs: {}, outputs: { summary: { type: "string" } }, capabilities: { llm: true } },
    async run(inputs, ctx) { const r = await ctx.llm({ model: "claude-sonnet-4-6", prompt: "ZTHROWPROVIDER go" }); return { summary: r.text }; }
  };`;
  const { blockId, versionId } = await makeBlock('throw-llm', AI2_SRC, {
    inputs: {}, outputs: { summary: { type: 'string' } }, capabilities: { llm: true },
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  await db.execute(sql`UPDATE usage_counters SET llm_calls = 0 WHERE user_id = ${USER_ID} AND day = current_date`);

  __setBrokerDepsForTests({
    provider: async (req) => {
      if (req.prompt.includes('ZTHROWPROVIDER')) throw new Error('ZTHROW simulated non-rejection broker fault');
      return mockProvider(req);
    },
  });
  try {
    // The assertion is that this RESOLVES AT ALL. waitForRun gives up after 15s and throws
    // "did not finish in time", so a leaked watchdog on a live run fails here rather than hanging.
    const { run } = await runToCompletion(flowId);
    expect(run.status).toBe('failed');
    expect(run.finished_at).not.toBeNull();
  } finally {
    __setBrokerDepsForTests(undefined);
  }
}, 30_000);

test('a run whose ctx.llm() hits the platform-local-only rule ends PROMPTLY carrying that rule (no idle-watchdog hang)', async () => {
  // THE DEFECT. `brokerLlmCall` THREW `PlatformLocalOnlyError` where the controller expects
  // `{ok:false,...}`: the pump `catch` recorded an `internal` node_error with raw English, wrote NO
  // `llm_response` frame back, and the runner sat blocked on stdin. Now the broker returns the
  // refusal with `rule: 'llm_platform_local_only'`, the runner gets its failure frame at once and
  // the node_error carries the rule so the browser renders the localized sentence.
  //
  // NON-VACUITY: revert the try/catch in `brokerLlmCall` and `rule` is undefined, `kind` is
  // 'internal' and the node is '-' (the pump's catch, not the runner) -- the assertions below fail.
  const SRC = `export default {
    descriptor: { inputs: {}, outputs: { summary: { type: "string" } }, capabilities: { llm: true } },
    async run(inputs, ctx) { const r = await ctx.llm({ model: "claude-sonnet-4-6", prompt: "ZLOCALONLY go" }); return { summary: r.text }; }
  };`;
  const { blockId, versionId } = await makeBlock('local-only-llm', SRC, {
    inputs: {}, outputs: { summary: { type: 'string' } }, capabilities: { llm: true },
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));
  await db.execute(sql`UPDATE usage_counters SET llm_calls = 0 WHERE user_id = ${USER_ID} AND day = current_date`);

  const llm = config.llm as unknown as { mode: string; openaiBaseUrl: string };
  const was = { mode: llm.mode, base: llm.openaiBaseUrl };
  llm.mode = 'openai_compatible';
  llm.openaiBaseUrl = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
  __setBrokerDepsForTests({ limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const restoreIdle = setIdleMs(8000); // far above the expected time: a hang would show as the watchdog
  try {
    const t0 = Date.now();
    const { run } = await runToCompletion(flowId);
    const elapsed = Date.now() - t0;
    expect(run.status).toBe('failed');
    const trace = run.trace as TraceEvent[];
    const err = trace.find((e) => e.type === 'node_error') as Extract<TraceEvent, { type: 'node_error' }>;
    expect(err).toBeDefined();
    expect(err.rule).toBe('llm_platform_local_only');
    expect(err.kind).not.toBe('internal');
    expect(err.nodeId).not.toBe('-'); // raised by the RUNNER on its llm_response, not by the host pump catch
    expect(err.error).not.toContain('idle watchdog');
    expect(elapsed).toBeLessThan(6000);
  } finally {
    setIdleMs(restoreIdle);
    llm.mode = was.mode;
    llm.openaiBaseUrl = was.base;
    __setBrokerDepsForTests(undefined);
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-2 / migration 0065 — the run row records WHICH SOLUTION it was a demo of.
//
// `POST /api/runs {solutionId}` IS the "Try it" button on a solution page: it resolves the
// solution, executes that solution's frozen published graph, and — until 0065 — threw the
// resolution away. Recovering it afterwards from `flow_id` is a DIFFERENT fact (a submitted flow
// keeps being edited while the published graph is frozen; one flow can back several solutions;
// draft /build runs share the bucket), which is why the column exists and why the reverse-join
// shortcut is refused. See backend/tests/solutions.test.ts for what that costs at the read end.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('a {solutionId} run is stamped with that solution; a {flowId} run is stamped with nothing', async () => {
  const { blockId, versionId } = await makeBlock('stamp', DOUBLE_SRC, {
    inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {},
  });
  const publishedGraph = singleNode(blockId, versionId, { n: 5 });
  const [source] = await db.insert(flows).values({
    name: 'stamp-source', owner_id: USER_ID, tenant_id: DEMO_TENANT_ID, graph: publishedGraph,
  }).returning();
  const [challenge] = await db.insert(challenges).values({
    title: 'stamp-challenge', work_area: 'ops', submitter_id: AUTHOR_ID, tenant_id: DEMO_TENANT_ID,
  }).returning();
  const [solution] = await db.insert(solutions).values({
    challenge_id: challenge!.id,
    tenant_id: DEMO_TENANT_ID,
    title: 'stamp-solution',
    author_id: AUTHOR_ID,
    flow_id: source!.id,
    published_graph: publishedGraph,
    published_manifest: [{
      nodeId: 'n1', blockId, versionId, slug: 'node',
      descriptor: { inputs: { n: { type: 'number' } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
    }],
    published_hash: 'stamp-test',
    published_at: new Date(),
    published_by: AUTHOR_ID,
  }).returning();

  // ⛔ Remove `solution_id: runSolutionId` from the flow_runs INSERT in host/run-controller.ts —
  // or make `loadRunnableSolution` stop returning which solution it resolved — and this is null.
  // The read side then has nothing to measure and every board falls back to "no demo yet".
  const { run: demoRun } = await runTargetToCompletion({ solutionId: solution!.id });
  const [demoRow] = await db.select({ solutionId: flowRuns.solution_id }).from(flowRuns).where(eq(flowRuns.id, demoRun.id));
  expect(demoRow!.solutionId).toBe(solution!.id);

  // ⛔ THE OTHER HALF, AND IT IS NOT SYMMETRY FOR ITS OWN SAKE. `loadRunnableFlow`'s public branch
  // DOES resolve a solution (`.limit(1)` over `solutions.flow_id`) in order to pick a graph, and
  // stamping THAT would be the ambiguous reverse lookup 0065 exists to avoid — it would credit one
  // sibling's board with another's run. Here the same flow is the caller's OWN, so this is the
  // /build draft path: a scratch iteration, nobody's demo. Returning anything but null from either
  // branch of `loadRunnableFlow` reds this.
  const { run: draftRun } = await runTargetToCompletion({ flowId: source!.id });
  const [draftRow] = await db.select({ solutionId: flowRuns.solution_id }).from(flowRuns).where(eq(flowRuns.id, draftRun.id));
  expect(draftRow!.solutionId).toBeNull();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE RUN IS NOT "FINISHED" UNTIL THE SANDBOX IS CLAIMABLE AGAIN.
//
// `waitForRun` — and the product's own run poll — watch `flow_runs.status`. The sandbox claim in
// `POST /api/runs` accepts only `['idle','error']`. `finalize` used to write the terminal
// flow_runs row, then AWAIT an audit insert, and only then transition the sandbox: a window in
// which the product reports a run as done while its sandbox is still `running`, so a user who
// clicks Run again the instant their run reports finished gets `409 sandbox_busy` for a sandbox
// that is not busy. It self-heals via `releaseOrphanedSandboxes`, which is why it stayed invisible.
// It reddened CI on a frontend-only PR, where the next test's POST beat the transition.
//
// ⚠️ THIS IS A SOURCE-ORDER ASSERTION, DELIBERATELY, AND THE HONEST REASON IS THAT THE BEHAVIOURAL
// VERSION IS VACUOUS. "Run, then immediately POST again and expect 201" was written first and it
// PASSES AGAINST THE BUG on an idle machine — the audit insert is sub-millisecond locally, so the
// window never opens and the test proves nothing. The window is only observable under load, and a
// test that depends on losing a race is a flake in the other direction. `recordAudit` has no
// injection seam to widen it deterministically, and once `finalize` returns both orderings leave
// identical rows, so no post-hoc DB state can tell them apart. The order in the source IS the
// invariant, so that is what this pins.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('finalize releases the sandbox BEFORE it awaits the audit write', async () => {
  const src = await Bun.file(
    new URL('../src/host/run-controller.ts', import.meta.url),
  ).text();

  const finalizeAt = src.indexOf('async function finalize(');
  expect(finalizeAt).toBeGreaterThan(-1);
  const body = src.slice(finalizeAt, src.indexOf('\n}\n', finalizeAt));

  const transitionAt = body.indexOf('transitionSandbox(');
  const auditAt = body.indexOf('await recordAudit(');
  expect(transitionAt).toBeGreaterThan(-1);
  expect(auditAt).toBeGreaterThan(-1);

  // Move the sandbox transition back below the audit write and this fails — which is the whole
  // point, because nothing else in the suite can see that change.
  expect(transitionAt).toBeLessThan(auditAt);
});
