// tests/run-finalize-lost-race.test.ts — a finished run whose results were silently discarded.
//
// ⛔ THE DEFECT. `finalize()` writes the terminal `flow_runs` row with a compare-and-set:
//   .where(and(eq(flowRuns.id, handle.runId), eq(flowRuns.status, 'running')))
// with NO `.returning()` and no rowcount check. The surrounding `catch` only fires on an EXCEPTION,
// and matching zero rows is not one. `startRunReconciler()` (wired in server.ts, LEASE_MS 45s)
// flips a run whose replica stopped heartbeating to `failed`. If the run then finishes, finalize
// matches ZERO ROWS and does nothing at all — silently.
//
// ⛔ AND THE NEXT TWO WRITES CARRIED ON REGARDLESS. `recordAudit` a few lines below reads
// `handle.finalStatus` — the RUNNER's view — so `audit_log` recorded `Success · 3.42s`, tone `ok`,
// for a run whose row says `failed`, `total_ms: null`, `$0.00`. Two permanent records of one run,
// disagreeing, and nothing anywhere said so. The SSE stream had already told the user it succeeded.
//
// ⛔ WHICH RECORD WINS, AND WHY. The reconciler's. It does not merely mark a row: it PUBLISHES a
// terminal `run_complete` into `flow_run_events` (read by every other replica's stream) and flips
// the sandbox to `error`. That decision is already out in the world and cannot be recalled, and the
// `status='running'` predicate is precisely what stops a late finalize from resurrecting a run
// another process legitimately terminated — dropping it would be a worse bug than the one here.
// So: the persisted record stands, the audit row is written to AGREE with it, and the runner's own
// observation is preserved in the audit metadata rather than being either imposed or thrown away.
//
// ⛔ THE ASSERTIONS ARE ABOUT AGREEMENT, NOT ABOUT ONE ROW. Every case derives what the audit row
// must say FROM the `flow_runs` row it reads back. A test that only checked `flow_runs.status`, or
// only the audit text, was green before this fix.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { reconcileStaleRuns, registerRunRoutes, runRegistry } from '../src/host/run-controller';
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
  sandboxes,
  auditLog,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { FlowGraph, FlowNode } from '../src/db/flow-types';
import type { User } from '../src/types';
import { requireScannedSource } from '../src/blocks/source-gate';
import { linesWithMsg, parseLogLines, errMessage } from './helpers/log-lines';

const USER_ID = '00000000-0000-0000-0000-0000000c5001';
const user: User = {
  id: USER_ID,
  email: 'lostrace@test',
  name: 'Lost Race',
  roles: ['employee'],
  tenantId: DEMO_TENANT_ID,
};
const SLUG_PREFIX = 'ztest-lostrace-';

const router = new Router();
registerRunRoutes(router);
registerSandboxRoutes(router);

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function makeBlock(slug: string, source: string, descriptor: object) {
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
      source_ts: requireScannedSource(source),
      descriptor: descriptor as never,
    })
    .returning();
  return { blockId: block!.id, versionId: version!.id };
}

function singleNode(blockId: string, versionId: string): FlowGraph {
  const n: FlowNode = {
    id: 'n1',
    blockId,
    blockVersionId: versionId,
    slug: 'node',
    label: 'node',
    category: 'logic',
    config: {},
    position: { x: 0, y: 0 },
  };
  return { nodes: [n], edges: [] };
}

async function makeFlow(graph: FlowGraph) {
  const [flow] = await db
    .insert(flows)
    .values({ name: 'lost-race', owner_id: USER_ID, graph, tenant_id: DEMO_TENANT_ID })
    .returning();
  return flow!.id;
}

/** The run's own `sandbox.run` audit row — the second of the two records that must agree. */
async function auditRowsFor(runId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.action, 'sandbox.run')))
    .then((rows) => rows.filter((r) => (r.metadata as { runId?: string } | null)?.runId === runId));
}

/** Wait for `finalize` to reach its LAST write (the audit insert). Bounded and loud: a run whose
 *  finalize never completes is itself the defect, not a slow box. */
async function waitForFinalize(runId: string, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const rows = await auditRowsFor(runId);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, runId));
  throw new Error(
    `finalize never wrote its sandbox.run audit row for ${runId} within ${(attempts * 100) / 1000}s ` +
      `(flow_runs.status=${row?.status}) — finalize did not run to completion.`,
  );
}

/** What the audit row MUST say, derived from the persisted run row. This is the whole point of the
 *  file: the expectation is computed from one record and checked against the other. */
function auditMustMatch(status: string): { tone: 'ok' | 'warn' | 'error'; prefix: string } {
  if (status === 'ok') return { tone: 'ok', prefix: 'Success' };
  if (status === 'partial') return { tone: 'warn', prefix: 'Partial' };
  return { tone: 'error', prefix: 'Failed' };
}

async function cleanup() {
  const runs = await db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.triggered_by, USER_ID));
  if (runs.length) {
    await db.delete(flowRunEvents).where(inArray(flowRunEvents.run_id, runs.map((r) => r.id)));
  }
  await db.delete(flowRuns).where(eq(flowRuns.triggered_by, USER_ID));
  await db.delete(flows).where(eq(flows.owner_id, USER_ID));
  await db.delete(sandboxes).where(eq(sandboxes.owner_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(sql`${buildingBlocks.slug} LIKE ${SLUG_PREFIX + '%'}`);
  const ids = blocks.map((b) => b.id);
  if (ids.length) {
    await db.delete(blockVersions).where(inArray(blockVersions.block_id, ids));
    await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, ids));
  }
  await db.delete(users).where(eq(users.id, USER_ID));
}

const SLOW_SRC = `export default {
  descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
  async run() { await new Promise((r) => setTimeout(r, 1500)); return { ok: true }; }
};`;

const FAST_SRC = `export default {
  descriptor: { inputs: {}, outputs: { ok: { type: "boolean" } }, capabilities: {} },
  async run() { return { ok: true }; }
};`;

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

test('THE DEFECT: a run the reconciler already failed leaves the DB and the audit row in agreement', async () => {
  const { blockId, versionId } = await makeBlock('slow', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  let runId!: string;
  try {
    const created = await callJson('POST', '/api/runs', { flowId });
    expect(created.status, `run not started: ${JSON.stringify(created.json)}`).toBe(201);
    runId = created.json.runId as string;

    // The run IS live in this process — otherwise there is no finalize to lose the race.
    expect(runRegistry.get(runId)?.completed, 'the run was already over before the reconciler ran').toBe(false);

    // Reproduce the 45s lease expiry the watchdog reacts to, without waiting 45s. HEARTBEAT_MS is
    // 10s and the block sleeps 1.5s, so nothing re-extends the lease before reconcile claims it.
    await db
      .update(flowRuns)
      .set({ heartbeat_at: new Date(Date.now() - 120_000), lease_expires_at: new Date(Date.now() - 60_000) })
      .where(eq(flowRuns.id, runId));
    expect(
      await reconcileStaleRuns(),
      'the reconciler did not claim the run — the race this file is about never happened',
    ).toContain(runId);

    // Now let the run finish and finalize land on a row that is no longer 'running'.
    await waitForFinalize(runId);
  } finally {
    console.error = realError;
  }

  const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, runId));
  const audits = await auditRowsFor(runId);

  // 1. The reconciler's terminal decision stands — finalize must not resurrect a run another
  //    process already published as over.
  expect(row!.status, 'finalize overwrote a terminal status another process had already published').toBe('failed');

  // 2. Exactly one audit row, and it AGREES with the row above. Derived, not hardcoded.
  expect(audits.length, 'the run produced no single sandbox.run audit row').toBe(1);
  const audit = audits[0]!;
  const must = auditMustMatch(row!.status);
  expect(
    audit.result_tone,
    `audit tone '${audit.result_tone}' contradicts flow_runs.status '${row!.status}'`,
  ).toBe(must.tone);
  expect(
    audit.result?.startsWith(must.prefix),
    `audit result '${audit.result}' contradicts flow_runs.status '${row!.status}'`,
  ).toBe(true);

  // 3. The disagreement is RECORDED, not erased. The runner really did see this run succeed; that
  //    fact is evidence, and dropping it would replace a loud contradiction with a quiet lie.
  const meta = audit.metadata as Record<string, unknown>;
  expect(meta.reconciled, 'nothing records that this run was terminated by the reconciler').toBe(true);
  expect(meta.runnerStatus, "the runner's own observed outcome was thrown away").toBe('ok');

  // 4. …and it is observable in the log, where on-call actually looks.
  //
  //    ⛔ THE EVENT, NOT A SUBSTRING. host/logger.ts emits one JSON object per event, so "a line
  //    mentioning this run and the word finalize" is now "a `run_finalize_matched_no_running_row`
  //    event whose `runId` field IS this run" — the same proof with the coincidences removed (the
  //    old match would have been satisfied by any unrelated line that happened to contain both).
  const line = linesWithMsg(errors, 'run_finalize_matched_no_running_row').find(
    (l) => l.runId === runId,
  );
  expect(
    line,
    `finalize matched zero rows and said nothing. console.error saw: ${JSON.stringify(errors)}`,
  ).toBeTruthy();
});

/**
 * Make the NEXT `db.select({ status })` — finalize's post-CAS readback, and nothing else in this
 * path — fail the way a real database failure does: an AWAITED rejection, not a synchronous throw.
 *
 * ⛔ DISCRIMINATED ON THE FIELD SPEC, NOT ON "the next select". `reconcileStaleRuns` runs a bare
 * `db.select()` and this file's own helpers select other shapes; a blunt one-shot patch would fire
 * on whichever call happened to come first and the case would silently stop testing the readback.
 * `{ status }` with exactly one key is unique to that statement. `transitionSandbox` and
 * `recordAudit` use `.update()` / `.insert()`, so neither can absorb the fault by accident.
 */
function armStatusReadbackFault(message: string): () => void {
  // ⛔ THE PROTOTYPE, NOT `db`. `db` (db/client.ts:355) is a Proxy whose `get` trap resolves to
  // `currentDbContext().boundDb` — the RESERVED per-request connection — whenever an
  // AsyncLocalStorage context is active. `finalize` runs its whole tail inside `withTenantDb`, so an
  // own-property patch on the proxy target (`poolDb`) is never consulted there: the first attempt at
  // this case injected nothing at all and passed for free, reporting the row as read. Patching
  // `PgDatabase.prototype`, which every drizzle instance in the process shares, is what actually
  // reaches the statement. The one-shot + field-spec discriminator below is what keeps that blunt
  // instrument down to exactly one call.
  let proto: object | null = Object.getPrototypeOf(db as object);
  while (proto && !Object.hasOwn(proto, 'select')) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error('could not find drizzle `select` on the prototype chain');
  const holder = proto as Record<string, unknown>;
  const real = holder.select as (this: unknown, fields?: unknown) => unknown;
  let fired = false;
  holder.select = function (this: unknown, fields?: unknown) {
    const spec = fields as Record<string, unknown> | undefined;
    if (!fired && spec && Object.keys(spec).length === 1 && Object.hasOwn(spec, 'status')) {
      fired = true;
      // An AWAITED rejection, the shape a real connection failure takes — not a synchronous throw.
      return { from: () => ({ where: () => Promise.reject(new Error(message)) }) };
    }
    return real.call(this, fields);
  };
  return () => {
    holder.select = real;
  };
}

test('THE GUARD: a readback that FAILS must not strand the sandbox or swallow the audit row', async () => {
  // ⛔ THIS IS A DEFECT THE FIX ITSELF INTRODUCED. The `!claimed` readback was the only
  // unguarded DB call in `finalize` — every other one (the CAS, `transitionSandbox`, `recordAudit`)
  // is individually wrapped. `finalize` is reached only from the detached `void spawnAndPump(...)`,
  // so a throw there has no request to surface on: it becomes a silent unhandled rejection that
  // skips BOTH remaining writes and leaves the sandbox in `running` FOREVER — after which its owner
  // 409s `sandbox_busy` on every future run. And the branch is reached only when the lease already
  // expired, i.e. when the infrastructure is already unhappy, so the fault is correlated with the
  // path, not orthogonal to it.
  const { blockId, versionId } = await makeBlock('readback-fault', SLOW_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));

  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  let disarm = () => {};
  let runId!: string;
  let sandboxId!: string;
  try {
    const created = await callJson('POST', '/api/runs', { flowId });
    expect(created.status, `run not started: ${JSON.stringify(created.json)}`).toBe(201);
    runId = created.json.runId as string;
    sandboxId = created.json.sandboxId as string;

    await db
      .update(flowRuns)
      .set({ heartbeat_at: new Date(Date.now() - 120_000), lease_expires_at: new Date(Date.now() - 60_000) })
      .where(eq(flowRuns.id, runId));
    expect(await reconcileStaleRuns(), 'the reconciler did not claim the run').toContain(runId);

    // ⛔ PUT THE SANDBOX BACK IN `running` — otherwise this case proves nothing. The reconciler
    // just moved it to `error` in its own transaction, so it would read as "released" whether or not
    // finalize's `transitionSandbox` was ever reached. Restoring `running` makes the sandbox
    // assertion below a genuine witness that execution got past the readback.
    await db.update(sandboxes).set({ status: 'running' }).where(eq(sandboxes.id, sandboxId));

    disarm = armStatusReadbackFault('ZINJECTED readback fault: connection terminated');
    await waitForFinalize(runId, 100);
  } finally {
    disarm();
    console.error = realError;
    process.off('unhandledRejection', onRejection);
  }
  // Give any rejection that WOULD have been unhandled a turn to be reported.
  await new Promise((r) => setTimeout(r, 50));

  // ⛔ NON-VACUITY FIRST. Everything below is also true of a run where the readback SUCCEEDED,
  // so if the injection missed, this case would be a green test of nothing — which is exactly what
  // the first version of it was.
  // The fault arrives as a SERIALIZED Error on the `err` field (host/logger.ts keeps
  // name/message/stack), so the witness is that message — not the raw characters appearing
  // anywhere in the line.
  expect(
    parseLogLines(errors).find((l) => errMessage(l)?.includes('ZINJECTED readback fault')),
    `the injected fault never reached the readback — this case proved nothing. ` +
      `console.error saw: ${JSON.stringify(errors)}`,
  ).toBeTruthy();

  // (a) nothing escaped the detached finalize.
  expect(
    rejections.map((e) => (e instanceof Error ? e.message : String(e))),
    'the readback failure escaped as an unhandled rejection',
  ).toEqual([]);

  // (b) the sandbox was still released — the write that lives AFTER the readback ran.
  const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  expect(
    sandbox!.status,
    'the sandbox was stranded in `running` — its owner would 409 sandbox_busy forever',
  ).not.toBe('running');

  // (c) the audit row — the LAST write in finalize — was still written.
  const audits = await auditRowsFor(runId);
  expect(audits.length, 'the run produced no sandbox.run audit row').toBe(1);
  // The split is still recorded even though the other side could not be read.
  expect((audits[0]!.metadata as Record<string, unknown>).reconciled).toBe(true);

  // (d) and BOTH halves are in the log: that the CAS lost, and that the readback could not say
  //     what won. The second line is what stops this fallback from looking like agreement.
  // ⛔ TWO DISTINCT EVENTS, each carrying THIS run's id — the free-form sentences they replaced
  // ("finalize matched no 'running' row" / "status readback failed") are now `msg` tokens, which is
  // exactly the pair `run-controller.ts` says it emits on purpose so the two records' disagreement
  // is not mistaken for agreement.
  expect(
    linesWithMsg(errors, 'run_finalize_matched_no_running_row').find((l) => l.runId === runId),
    `the lost-CAS line is missing. console.error saw: ${JSON.stringify(errors)}`,
  ).toBeTruthy();
  const readbackLine = linesWithMsg(errors, 'run_finalize_status_readback_failed').find(
    (l) => l.runId === runId,
  );
  expect(
    readbackLine,
    `nothing said the readback failed, so the audit row silently describes the RUNNER's status ` +
      `while the row may say something else. console.error saw: ${JSON.stringify(errors)}`,
  ).toBeTruthy();
  // …and it carries the actual failure, not just the fact that one happened.
  expect(errMessage(readbackLine)).toContain('ZINJECTED readback fault');
});

test('THE CONTROL: an ordinary run still records success, in both records, with no reconcile marker', async () => {
  // ⛔ THE OVER-CORRECTION GUARD. Always writing 'Failed', or always stamping `reconciled`, would
  // satisfy the case above and destroy the ordinary path. This is the half that reds on it.
  const { blockId, versionId } = await makeBlock('fast', FAST_SRC, {
    inputs: {}, outputs: { ok: { type: 'boolean' } }, capabilities: {},
  });
  const flowId = await makeFlow(singleNode(blockId, versionId));

  const created = await callJson('POST', '/api/runs', { flowId });
  expect(created.status, `run not started: ${JSON.stringify(created.json)}`).toBe(201);
  const runId = created.json.runId as string;
  await waitForFinalize(runId);

  const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, runId));
  const audits = await auditRowsFor(runId);
  expect(row!.status).toBe('ok');
  expect(row!.total_ms, 'a healthy finalize must still persist its timing').not.toBeNull();
  expect(audits.length).toBe(1);
  const must = auditMustMatch(row!.status);
  expect(audits[0]!.result_tone).toBe(must.tone);
  expect(audits[0]!.result?.startsWith(must.prefix)).toBe(true);
  expect(
    (audits[0]!.metadata as Record<string, unknown>).reconciled,
    'an ordinary run was labelled as reconciled',
  ).toBeUndefined();
});
