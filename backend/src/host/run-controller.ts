// src/host/run-controller.ts — TRUSTED orchestration for a flow run (SPEC §5).
// POST /api/runs: auth + own the flow, resolve every node's block source +
// descriptor, run the flow-validate pre-flight, then spawn ONE isolated
// subprocess (the only enforceable resource boundary in Bun) with a scrubbed env
// and a cross-platform memory/time backstop. The subprocess emits NDJSON on
// stdout; this pump fans each event out to SSE subscribers + a per-run buffer,
// services ctx.llm() requests via the metered broker, and persists the final
// trace to flow_runs. GET /api/runs/:id returns the persisted run.
import { and, eq, inArray, lte, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  flows,
  flowRuns,
  flowRunEvents,
  sandboxes,
  solutions,
  withTenantDb,
  withTenantTx,
  runAsSystem,
} from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import type { Flow, BlockVersion } from '../db/schema';
import type { FlowGraph } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';
import {
  type TraceEvent,
  type RunStatus,
  type CostDelta,
  type ErrorKind,
  type InitFrame,
  type LlmResponseFrame,
  zeroCost,
  isTraceEvent,
} from '../db/trace-types';
import { validateGraphStructure, validateGraphAgainstBlocks } from '../exec/flow-validate';
import type { InjectedDataset } from '../db/dataset-types';
import { loadInjectedDatasets } from '../datasets/dataset-service';
import { validateInjectedAgainstOntology } from '../datasets/ontology-validation';
import { getRunBackend, type RunChannel } from './run-backend';
import { brokerLlmCall } from './llm-broker';
import { ensureSandbox, resumeOwnIdleSandbox, transitionSandbox } from './sandbox-service';
import { getSnapshot } from './policy-store';
import { enforceRunPolicies } from './run-policy';
import { recordAudit } from './audit-service';
import { resolveTenant } from '../middleware/tenant';
import { jsonResponse, readJson, route, notFound, unprocessable, conflict, HttpError } from '../utils/http';
import { config } from '../config';
import type { Router } from '../utils/router';
import type { User } from '../types';
import { resolveExecutableBlocks } from './publication-service';
import { prepareSampleTest, type SampleBinding } from '../challenges/sample-test';
import { maskInjectedForReader } from '../datasets/member-view';
import { canManageData } from '../routes/datasets';
import { incCounter } from './metrics';
import { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS } from './tick-locks';
import { log } from './logger';
import { runRowFor } from './run-cost-visibility';

const RING_CAP = 10000; // defensive cap on buffered events per run
const EVICT_MS = 60000; // keep a completed run streamable for late reconnects
const EVENT_FLUSH_MS = 250; // max staleness of the cross-replica tail
const EVENT_FLUSH_MAX = 50; // max rows per durable-event insert
const LEASE_MS = 45_000;
// One DB write per beat per in-flight run, so this stays well below the lease rather than chasing
// it (4-5 beats per lease is ample). Same-pod cancellation does NOT wait for a beat —
// cancelRunsForSandbox aborts the local handle directly; the beat is the CROSS-replica signal.
const HEARTBEAT_MS = 10_000;
// How many `dataset.column→attribute` refs a data-validation audit row carries. `audit_log.metadata`
// is JSONB with no size ceiling, and findings are per MAPPED COLUMN — a wide dataset can raise
// hundreds. The row is a readable index into the run, not the record; the full list lives in the
// 422 body (block) or the browser (warn), and `metadata.findings` always holds the true total.
const AUDIT_FINDING_REF_CAP = 20;

// ---- per-run state (shared with sse-stream.ts) ----

export interface BufferedEvent {
  seq: number;
  ev: TraceEvent;
}
export type Subscriber = (b: BufferedEvent) => void;

export interface RunHandle {
  runId: string;
  userId: string;
  /** The effective tenant of the request that started this run (captured from the request ALS at
   *  spawn time). The detached pump + finalize re-establish this tenant's DB context via
   *  withTenantDb so the flow_runs update, sandbox transition, and broker metering carry the same
   *  `app.current_tenant` the flow_runs row was stamped with. Null only when started outside a
   *  request (e.g. a direct test call) → runs on the pool with no GUC. */
  tenantId: string | null;
  sandboxId: string | null;
  flowName: string;
  events: BufferedEvent[];
  seq: number;
  subscribers: Set<Subscriber>;
  completed: boolean;
  finalStatus: RunStatus;
  totals: CostDelta;
  totalMs: number | null;
  /** The runner's stdio transport (subprocess or Kata pod) — Phase 2-C. */
  channel: RunChannel | null;
  ac: AbortController;
  /** Why `ac.abort()` was called, when the host itself killed the run. Undefined for a run that
   *  ended on its own terms. `finalize` turns this into a real `node_error` — on abort the k8s
   *  channel's `lines` iterator ends NORMALLY (tearDown kills `kubectl attach`, stdout hits EOF),
   *  so `spawnAndPump`'s catch never fires and the ONLY record would otherwise be a bare
   *  `run_complete{status:'failed', totalMs:0}` with no cause anywhere — not in the console, not
   *  in the trace, not in the pod log. */
  abortReason?: { kind: ErrorKind; error: string };
  /** The last node the runner announced, so an abort can name what it interrupted rather than
   *  blaming a synthetic node id. Undefined if the run died before any `node_start`. */
  lastNode?: { nodeId: string; slug: string; startedAt: number };
  /** Block-test run (Phase 2-B): execute through the real runner for fidelity but
   *  do NOT persist to flow_runs / audit sandbox.run / transition a sandbox. */
  ephemeral: boolean;
  /** Emit full (untruncated) node output so the test runner can assert on it. */
  fullOutput: boolean;
  /** Serial durable-event writer. The pump never blocks on each INSERT, but finalization awaits it. */
  eventWrite: Promise<void>;
  /** Durable events buffered since the last flush (batched — see flushEvents). */
  pendingEvents: Array<{ seq: number; event: TraceEvent }>;
  eventFlushTimer?: ReturnType<typeof setTimeout>;
  traceTruncated: boolean;
}

export const runRegistry = new Map<string, RunHandle>();

// ---- helpers ----

const createRunSchema = z
  .object({
    flowId: z.string().uuid().optional(),
    solutionId: z.string().uuid().optional(),
    // W8/P4: "Test with this challenge's sample data" — bind the challenge's sample data into the
    // flow for THIS run (challenges/sample-test.ts). A draft-flow run only; `guid`, not `uuid`:
    // zod 4's `uuid()` demands an RFC version and demo ids are `…0001`.
    sampleChallengeId: z.guid().optional(),
  })
  .strict()
  .refine((body) => Number(body.flowId != null) + Number(body.solutionId != null) === 1, {
    message: 'Provide exactly one of flowId or solutionId',
  })
  .refine((body) => !(body.sampleChallengeId && body.solutionId), {
    message: 'sampleChallengeId applies to a flowId run only',
  });

// A flow the caller may RUN: the owner's own working flow, OR any flow that backs a
// published solution (the "Try it" path on a solution page). Either way the run
// executes in the CALLER's sandbox (triggered_by + datasets are the caller's) and
// never mutates the author's flow — it only reads the published graph. 404 (not 403)
// when missing/private so we never reveal existence. Mirrors loadViewableFlow.
async function loadRunnableFlow(
  id: string,
  userId: string,
): Promise<{ flow: Flow; graph: FlowGraph; solutionId: null }> {
  const [flow] = await db.select().from(flows).where(eq(flows.id, id));
  if (!flow) throw notFound('flow_not_found', `No flow '${id}'`);
  if (flow.owner_id === userId) return { flow, graph: flow.graph as FlowGraph, solutionId: null };
  // Backwards-compatible public flowId requests still resolve through the canonical solution link,
  // but execute the immutable publication graph rather than the author's working document.
  const [published] = await db
    .select({ graph: solutions.published_graph })
    .from(solutions)
    .where(eq(solutions.flow_id, flow.id))
    .limit(1);
  if (!published?.graph) throw notFound('flow_not_found', `No flow '${id}'`);
  // ⛔ `solutionId: null` ON BOTH PATHS, INCLUDING THIS ONE, AND THAT IS NOT AN OVERSIGHT. The
  // `.limit(1)` above is exactly the ambiguous `flow_id → solution` lookup that migration 0065
  // exists to avoid: one flow can back several solutions, so "the solution this flow belongs to"
  // is not a well-defined question and this query answers it arbitrarily. It is tolerable for
  // picking a graph to execute (the published graphs of siblings on one flow are the same document
  // this request already agreed to run) and NOT tolerable as an attribution written into the
  // permanent run record, where it would credit one sibling's board with another's demo time.
  // A run is stamped to a solution only when the CALLER named that solution.
  return { flow, graph: published.graph as FlowGraph, solutionId: null };
}

// ⛔ RETURNS `solutionId` — which solution it resolved — and the caller stamps it on the run row.
// This function used to resolve a solution, execute its published graph, and then throw away the
// only place in the system that KNEW the run belonged to that solution. The run then had to be
// attributed after the fact through `flow_id`, which is a different fact: a submitted flow keeps
// being edited (`routes/flows.ts:119-126`) while the published graph is frozen, and one flow can
// back several solutions (`routes/flows.ts:165-167` `.limit(1)`), so a `flow_id` join attributes a
// run of another graph — possibly a sibling solution's, possibly predating this solution. See
// migration 0065's header.
async function loadRunnableSolution(
  id: string,
): Promise<{ flow: Flow; graph: FlowGraph; solutionId: string }> {
  const [solution] = await db
    .select({ id: solutions.id, flowId: solutions.flow_id, graph: solutions.published_graph })
    .from(solutions)
    .where(eq(solutions.id, id));
  if (!solution?.flowId || !solution.graph) {
    throw notFound('solution_not_runnable', `No runnable published solution '${id}'`);
  }
  const [flow] = await db.select().from(flows).where(eq(flows.id, solution.flowId));
  if (!flow) throw notFound('solution_not_runnable', `No runnable published solution '${id}'`);
  // `solution.id`, not the `id` argument: this is the row RLS actually let us read, so a run can
  // never be stamped with an id the caller could not resolve.
  return { flow, graph: solution.graph as FlowGraph, solutionId: solution.id };
}

// ---- spawn + pump ----

export function startRun(
  runId: string,
  userId: string,
  sandboxId: string | null,
  flowName: string,
  graph: FlowGraph,
  sources: Record<string, string>,
  datasets: Record<string, InjectedDataset> = {},
  tenantId = currentDbContext()?.tenantId ?? null,
): RunHandle {
  const ac = new AbortController();
  const handle: RunHandle = {
    runId,
    userId,
    tenantId,
    sandboxId,
    flowName,
    events: [],
    seq: 0,
    subscribers: new Set(),
    completed: false,
    finalStatus: 'failed',
    totals: zeroCost(),
    totalMs: null,
    channel: null,
    ac,
    ephemeral: false,
    fullOutput: false,
    eventWrite: Promise.resolve(),
    pendingEvents: [],
    traceTruncated: false,
  };
  runRegistry.set(runId, handle);
  void spawnAndPump(handle, graph, sources, datasets);
  return handle;
}

/** Phase 2-B: run a (typically 1-node) graph through the SAME runner subprocess a
 *  production run uses — same transpile, capability gating, timeouts — but resolve
 *  with the collected trace instead of persisting to flow_runs. Used by the block
 *  test runner so a green test reflects exactly what ships. Registers the handle in
 *  runRegistry so an SSE subscriber can attach mid-run; the handle self-evicts. */
export async function runEphemeral(
  runId: string,
  userId: string,
  graph: FlowGraph,
  sources: Record<string, string>,
  datasets: Record<string, InjectedDataset> = {},
): Promise<{ status: RunStatus; events: TraceEvent[]; totals: CostDelta; totalMs: number | null }> {
  const ac = new AbortController();
  const handle: RunHandle = {
    runId,
    userId,
    tenantId: currentDbContext()?.tenantId ?? null,
    sandboxId: null,
    flowName: `block-test:${runId}`,
    events: [],
    seq: 0,
    subscribers: new Set(),
    completed: false,
    finalStatus: 'failed',
    totals: zeroCost(),
    totalMs: null,
    channel: null,
    ac,
    ephemeral: true,
    fullOutput: true,
    eventWrite: Promise.resolve(),
    pendingEvents: [],
    traceTruncated: false,
  };
  runRegistry.set(runId, handle);
  await spawnAndPump(handle, graph, sources, datasets);
  return {
    status: handle.finalStatus,
    events: handle.events.map((e) => e.ev),
    totals: handle.totals,
    totalMs: handle.totalMs,
  };
}

async function spawnAndPump(
  handle: RunHandle,
  graph: FlowGraph,
  sources: Record<string, string>,
  datasets: Record<string, InjectedDataset>,
): Promise<void> {
  // The pump is detached from the request (void startRun). Its DB writes touch RLS-scoped tables and
  // must carry the request's tenant (captured on the handle) — but we must NOT pin a reserved
  // connection across the whole run (subprocess I/O can take ~seconds; that would starve the pool).
  // So the tenant context is re-established narrowly, only around the actual DB work: the broker
  // metering (onLine → withTenantTx, transaction-only, no reserved conn) and finalize (withTenantDb).
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatBusy = false;
  // ⛔ TWO operations, not one. `reset` re-arms the silence watchdog; `pause` STOPS it for a
  // stretch the host itself knows is legitimately quiet (see onLine's broker await). Re-arming
  // only AFTER such a stretch is not enough — the timer armed before it has already fired by then,
  // which is precisely the shape of the original bug.
  const pauseIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Record the cause BEFORE aborting. The abort tears the channel down and `lines` then ends
      // normally, so this is the only moment anything knows why the run is about to die; finalize
      // reads it back and emits a real node_error. Without it the user sees `run failed · 0ms`
      // and neither the console, the trace, nor the pod log says the watchdog did it.
      handle.abortReason = {
        kind: 'timeout',
        error:
          `the runner sent nothing for ${config.run.idleMs}ms (host idle watchdog) — the run was ` +
          'stopped and its pod destroyed',
      };
      handle.ac.abort();
    }, config.run.idleMs);
  };

  let channel: RunChannel | null = null;
  try {
    if (!handle.ephemeral) {
      heartbeatTimer = setInterval(() => {
        if (heartbeatBusy || handle.completed) return;
        heartbeatBusy = true;
        // withTenantTx + transaction, NOT withTenantDb: the latter RESERVES one of only 6 request
        // connections for the call, and a timer that reserves is the pool-exhaustion footgun this
        // file's SSE counterpart was rewritten to avoid. The transaction pool is independent and
        // holds a connection only for the statement.
        void withTenantTx(handle.tenantId, () =>
          db.transaction(async (tx) => {
            const now = new Date();
            const active = await tx
              .update(flowRuns)
              .set({ heartbeat_at: now, lease_expires_at: new Date(now.getTime() + LEASE_MS) })
              // The returned cancel_requested_at is how the executing replica observes a pause or
              // cancellation persisted by ANOTHER replica; a vanished/terminal row aborts too.
              .where(and(eq(flowRuns.id, handle.runId), eq(flowRuns.status, 'running')))
              .returning({ cancelRequestedAt: flowRuns.cancel_requested_at });
            if (!active.length || active[0]!.cancelRequestedAt) {
              // Only the LOST-LEASE case gets an abortReason. A cancel/pause is a thing the user
              // asked for, not a failure — synthesising a node_error for it would put a red error
              // in the console of someone who just pressed Stop. (`ErrorKind` is a closed union
              // mirrored in the frontend trace types, BlockResultView and eight i18n catalogues;
              // there is deliberately no 'cancelled' member and adding one is a cross-repo
              // release.) A vanished or already-terminal row IS a failure: this replica was still
              // executing a run something else considers over.
              if (!active.length) {
                handle.abortReason = {
                  kind: 'internal',
                  error:
                    'the flow_runs row is gone or already terminal — this replica lost the run lease',
                };
              }
              handle.ac.abort();
            }
          }),
        ).catch((err) => log.error('run_heartbeat_failed', { runId: handle.runId, err })).finally(() => {
          heartbeatBusy = false;
        });
      }, HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    }
    // Start the runner on the configured backend (in-pod subprocess, or a Kata
    // pod-per-run). The transport differs; the stdio protocol below is identical.
    channel = await getRunBackend().start({ runId: handle.runId, signal: handle.ac.signal });
    handle.channel = channel;

    // Deliver the work as the first stdin line; the channel keeps stdin OPEN for
    // the llm_response round-trip serviced in onLine().
    const init: InitFrame = {
      type: 'init',
      runId: handle.runId,
      graph,
      sources,
      policy: {
        maxNodeMs: config.run.maxNodeMs,
        fullOutput: handle.fullOutput,
        maxRunMs: config.run.maxRunMs,
        maxIterations: config.run.maxIterations,
        maxForeachEvents: config.run.maxForeachEvents,
      },
      datasets,
    };
    channel.writeFrame(init);
    resetIdle();

    for await (const line of channel.lines) {
      await onLine(handle, line, resetIdle, pauseIdle);
    }
  } catch (err) {
    // spawn/pump failure — record an internal error event if we have nothing.
    //
    // LOG IT TOO. This branch catches the failures that are NOT the flow's fault: a run-pod that
    // never schedules, an image pull that 404s, an OOM kill, a broker throw. Until now the only
    // record was the trace event below, which lives in THIS run's in-memory ring buffer and dies
    // with it — so a backend-wide outage (bad image tag, exhausted node) looked like N unrelated
    // users reporting "my run failed" with nothing whatsoever in the pod logs to correlate.
    log.error('run_spawn_pump_failed', { runId: handle.runId, flowName: handle.flowName, err });
    if (!handle.completed) {
      pushEvent(handle, {
        type: 'node_error',
        runId: handle.runId,
        ts: Date.now(),
        nodeId: '-',
        slug: '-',
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
        kind: 'internal',
      });
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      await channel?.dispose();
    } catch {
      /* best effort */
    }
    await finalize(handle);
  }
}

async function onLine(
  handle: RunHandle,
  line: string,
  resetIdle: () => void,
  pauseIdle: () => void,
): Promise<void> {
  let frame: { type?: string };
  try {
    frame = JSON.parse(line);
  } catch {
    return; // ignore noise
  }
  resetIdle();

  if (frame.type === 'llm_request') {
    const f = frame as { id: number; payload: { model: string; prompt: string; maxTokens?: number } };
    // ⛔ STOP THE SILENCE CLOCK ACROSS THE PROVIDER CALL, and re-arm once we have the answer.
    // Everything from here to `writeFrame(response)` is awaited: the broker's round-trip (bounded
    // by llm.callTimeoutMs = 120 s, SIX TIMES this watchdog) plus up to one recordAudit. The pump
    // is `await onLine(...)` inside `for await (const line of channel.lines)`, so the iterator is
    // not pulled while we are in here and nothing else can re-arm; the runner is blocked on stdin
    // awaiting exactly this frame, so it emits nothing either. Provider latency is NOT silence —
    // counting it as such made the host destroy the pod of a run that was working perfectly, after
    // metering the call it then threw away.
    //
    // Pausing is load-bearing and re-arming afterwards is NOT sufficient on its own: the timer
    // armed at the top of this function has already fired by the time a slow call returns. That
    // exact mistake is what the 'a provider call SLOWER than the idle watchdog' test caught.
    pauseIdle();
    // Meter under the run's tenant (RLS: usage_counters/usage_events). withTenantTx sets the GUC via
    // the transaction path without reserving a connection across the (possibly slow) provider call.
    const outcome = await withTenantTx(handle.tenantId, () =>
      brokerLlmCall(handle.userId, f.payload, { correlationId: handle.runId, stage: 'flow-run' }),
    );
    // Audit the brokered governance decision (cap/model rejection, or 80%-warn).
    //
    // AWAITED and re-bound with withTenantTx. `spawnAndPump` is detached (`void spawnAndPump(...)`)
    // and inherits the request's ALS context, whose reserved connection withTenantDb's `finally`
    // has already reset and released — so a fire-and-forget audit here wrote through a dead
    // connection and `recordAudit` swallowed the error, leaving silent gaps in the append-only
    // trail for exactly the governance rejections that most need a record. The sibling calls in
    // this file (the broker call above, `finalize`) already re-bind for the same reason.
    if (!outcome.ok) {
      await withTenantTx(handle.tenantId, () =>
        recordAudit({
          actorId: handle.userId,
          action: outcome.kind === 'model_not_allowed' ? 'model.blocked' : 'llm.capped',
          category: outcome.kind === 'model_not_allowed' ? 'policy' : 'system',
          targetType: 'flow',
          targetId: handle.flowName,
          result: outcome.error,
          resultTone: 'error',
          // The EFFECTIVE model (broker-resolved): a block that names none would otherwise audit
          // `model: undefined` and the record could not say what was refused.
          metadata: { model: outcome.model ?? f.payload.model, runId: handle.runId },
        }),
      );
    } else if (outcome.warn === 'approaching_cap') {
      await withTenantTx(handle.tenantId, () =>
        recordAudit({
          actorId: handle.userId,
          action: 'quota.warn',
          category: 'system',
          targetType: 'user',
          targetId: handle.flowName,
          result: 'Approaching daily LLM cap',
          resultTone: 'warn',
          metadata: { runId: handle.runId },
        }),
      );
    }
    const response: LlmResponseFrame = outcome.ok
      ? { type: 'llm_response', id: f.id, ok: true, result: outcome.result }
      : {
          type: 'llm_response',
          id: f.id,
          ok: false,
          error: outcome.error,
          kind: outcome.kind,
          // ⛔ THE RULE RIDES THE FRAME. Without it the runner can only wrap `error` in a bare
          // Error, `classify` takes its default arm, and the browser renders the host's governance
          // English raw in eight locales. Spread so an absent rule puts NO key on the wire (see
          // `ruleOf` in flow-executor.ts for why `rule: undefined` is not the same thing).
          ...(outcome.rule ? { rule: outcome.rule } : {}),
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        };
    // The runner is about to be busy again — restart the clock it was paused on above.
    resetIdle();
    handle.channel?.writeFrame(response);
    return;
  }

  // Otherwise it SHOULD be a TraceEvent — but fd 1 is shared with anything the block printed, so
  // validate before trusting it. A malformed line is dropped with a log rather than fed into the
  // totals (where a missing `cost` used to throw, kill the pump, and report a successful run as
  // failed) or into the SSE fan-out.
  if (!isTraceEvent(frame)) {
    log.warn('run_stdout_non_protocol_line_dropped', {
      runId: handle.runId,
      hint: 'a block may be writing to stdout directly — use ctx.log instead',
    });
    return;
  }
  const ev = frame;
  pushEvent(handle, ev);
  if (ev.type === 'node_success') {
    handle.totals = {
      usd: handle.totals.usd + ev.cost.usd,
      tokensIn: handle.totals.tokensIn + ev.cost.tokensIn,
      tokensOut: handle.totals.tokensOut + ev.cost.tokensOut,
      llmCalls: handle.totals.llmCalls + ev.cost.llmCalls,
    };
  } else if (ev.type === 'run_complete') {
    handle.completed = true;
    handle.finalStatus = ev.status;
    handle.totalMs = ev.totalMs;
    handle.totals = ev.totals; // authoritative totals from the runner
  }
}

/** Drain the pending durable-event buffer into one multi-row insert, chained so writes for a run
 *  stay ordered and `finalize` can await the whole chain via `handle.eventWrite`. */
function flushEvents(handle: RunHandle): void {
  if (handle.eventFlushTimer) {
    clearTimeout(handle.eventFlushTimer);
    handle.eventFlushTimer = undefined;
  }
  if (!handle.pendingEvents.length) return;
  const batch = handle.pendingEvents.splice(0, handle.pendingEvents.length).map((e) => ({
    run_id: handle.runId,
    seq: e.seq,
    event: e.event,
  }));
  handle.eventWrite = handle.eventWrite
    .then(() =>
      withTenantTx(handle.tenantId, () =>
        db.transaction(async (tx) => {
          await tx
            .insert(flowRunEvents)
            .values(batch)
            .onConflictDoNothing({ target: [flowRunEvents.run_id, flowRunEvents.seq] });
        }),
      ),
    )
    .catch((err) => {
      handle.traceTruncated = true;
      log.error('run_durable_events_persist_failed', {
        runId: handle.runId,
        seqStart: batch[0]!.seq,
        seqEnd: batch[batch.length - 1]!.seq,
        err,
      });
    });
}

function pushEvent(handle: RunHandle, ev: TraceEvent): void {
  // Remember what the runner was last working on, so a host-side abort can name the node it
  // interrupted instead of inventing one. Cleared on the matching terminal node event, so a run
  // aborted BETWEEN nodes reports no node rather than blaming the previous (successful) one.
  if (ev.type === 'node_start') {
    handle.lastNode = { nodeId: ev.nodeId, slug: ev.slug, startedAt: ev.ts };
  } else if (ev.type === 'node_success' || ev.type === 'node_error' || ev.type === 'node_skipped') {
    if (handle.lastNode?.nodeId === ev.nodeId) handle.lastNode = undefined;
  }
  const seq = ++handle.seq;
  const buffered: BufferedEvent = { seq, ev };
  const terminal = ev.type === 'run_complete';
  // Reserve one slot for the terminal event. Once truncated, the durable stream and replay trace
  // still close deterministically and the flow_runs row advertises the loss explicitly.
  if (handle.events.length < RING_CAP - 1 || terminal) {
    handle.events.push(buffered);
  } else {
    handle.traceTruncated = true;
  }
  if (!handle.ephemeral && (seq < RING_CAP || terminal)) {
    // Buffer and flush in batches. One transaction PER EVENT would put a chatty run's whole trace
    // through the transaction pool serially and make finalize wait on that chain; a multi-row insert
    // per flush keeps the cross-replica tail fresh at a fraction of the cost. The terminal event
    // flushes immediately so a reader on another replica always sees the run close.
    handle.pendingEvents.push({ seq, event: ev });
    if (terminal || handle.pendingEvents.length >= EVENT_FLUSH_MAX) {
      flushEvents(handle);
    } else if (!handle.eventFlushTimer) {
      handle.eventFlushTimer = setTimeout(() => flushEvents(handle), EVENT_FLUSH_MS);
      handle.eventFlushTimer.unref?.();
    }
  }
  for (const sub of handle.subscribers) {
    try {
      sub(buffered);
    } catch {
      /* a slow/broken subscriber must never stall the pump */
    }
  }
}

async function finalize(handle: RunHandle): Promise<void> {
  // If the process died without a run_complete, synthesise a failed terminator
  // so subscribers unblock.
  if (!handle.completed) {
    handle.finalStatus = 'failed';
    // ⛔ SAY WHY, FIRST. When the HOST aborted the run, `channel.lines` ends NORMALLY (tearDown
    // kills `kubectl attach`, stdout hits EOF), so `spawnAndPump`'s catch never runs and nothing
    // else ever gets the chance to explain. Until this existed the entire record of a
    // watchdog-killed run was `run_complete{status:'failed', totalMs:0}` — the console rendered
    // `● run failed · 0ms · $0.00` with no preceding `✗` line, no message, and nothing in the pod
    // log, while the tenant had already been metered for the LLM call that was thrown away.
    // `abortReason` is only set for genuine failures; a user-requested cancel deliberately sets
    // nothing and still gets the bare terminator.
    if (handle.abortReason) {
      const now = Date.now();
      pushEvent(handle, {
        type: 'node_error',
        runId: handle.runId,
        ts: now,
        // Name the node that was actually in flight. Empty strings when the run died between
        // nodes (or before the first one) — honest, and the console renders the message either
        // way rather than us fabricating a node id that no graph contains.
        nodeId: handle.lastNode?.nodeId ?? '',
        slug: handle.lastNode?.slug ?? '',
        durationMs: handle.lastNode ? Math.max(0, now - handle.lastNode.startedAt) : 0,
        error: handle.abortReason.error,
        kind: handle.abortReason.kind,
      });
    }
    pushEvent(handle, {
      type: 'run_complete',
      runId: handle.runId,
      ts: Date.now(),
      totalMs: handle.totalMs ?? 0,
      status: 'failed',
      totals: handle.totals,
    });
    handle.completed = true;
  }

  // An ephemeral block-test run captures its trace in-memory only — no flow_runs
  // row, no sandbox.run audit, no sandbox transition. Just evict (the backend
  // already released the run's scratch/pod via channel.dispose()).
  if (handle.ephemeral) {
    setTimeout(() => runRegistry.delete(handle.runId), EVICT_MS).unref?.();
    return;
  }

  // Persist + transition under the run's tenant (RLS: flow_runs, sandboxes). Reserved only for these
  // few statements — NOT across the whole run — so the connection pool isn't pinned during the pump.
  await withTenantDb(handle.tenantId, async () => {
  // Drain anything still buffered (a run that ended without a terminal event, e.g. a crash or an
  // abort) so the durable tail is complete before the flow_runs row goes terminal.
  flushEvents(handle);
  await handle.eventWrite;

  // ⛔ THE TERMINAL WRITE IS A COMPARE-AND-SET, AND NOBODY WAS READING ITS RESULT.
  // `status = 'running'` in the WHERE is deliberate and must stay: it is what stops a late
  // finalize from resurrecting a run that another process legitimately terminated (a user cancel,
  // an admin pause, the lease reconciler). But it had no `.returning()` and no rowcount check, and
  // the surrounding `catch` fires only on an EXCEPTION — matching ZERO ROWS is not one. So when
  // `reconcileStaleRuns()` had already flipped a slow run to `failed` (LEASE_MS 45s), this
  // statement updated nothing, said nothing, and the two writes below carried on reading
  // `handle.finalStatus`: `audit_log` recorded `Success · 3.42s`, tone `ok`, for a run whose row
  // says `failed`, `total_ms: null`, `$0.00`. TWO PERMANENT RECORDS OF ONE RUN, DISAGREEING, and
  // no log line anywhere connecting them.
  //
  // ⛔ WHICH RECORD WINS: THE PERSISTED ONE, AND NOT BY DEFAULT. The reconciler does not merely
  // mark a row — it PUBLISHES a terminal `run_complete` into `flow_run_events`, which every other
  // replica's stream reads, and it flips the sandbox to `error`. That decision is already out in
  // the world and cannot be recalled; a late overwrite would leave the durable event stream ending
  // in a `failed` terminator on a row that claims `ok`. So the row stands, and finalize's job in
  // this branch changes from "write the outcome" to "report the disagreement".
  //
  // What that costs, stated plainly: the real trace, timing and cost of a run that DID finish are
  // not persisted on the row. They are not silently dropped either — they go into the audit
  // metadata below, where a human comparing the two records can see exactly what the runner saw.
  // The SSE subscribers of this replica were already told `ok` before finalize ran; that cannot be
  // unsaid, and inventing a second terminal event to contradict the first would corrupt the trace
  // ordering. The log line and the audit row are the honest record of the split.
  let claimed = false;
  try {
    const [updated] = await db
      .update(flowRuns)
      .set({
        status: handle.finalStatus,
        trace: handle.events.map((e) => e.ev),
        total_ms: handle.totalMs,
        total_cost_usd: String(handle.totals.usd),
        tokens_in: handle.totals.tokensIn,
        tokens_out: handle.totals.tokensOut,
        llm_calls: handle.totals.llmCalls,
        trace_truncated: handle.traceTruncated,
        event_count: handle.seq,
        heartbeat_at: new Date(),
        lease_expires_at: null,
        finished_at: new Date(),
      })
      .where(and(eq(flowRuns.id, handle.runId), eq(flowRuns.status, 'running')))
      .returning({ id: flowRuns.id });
    claimed = !!updated;
  } catch (err) {
    log.error('run_persist_failed', { runId: handle.runId, err });
  }

  // The status the DB actually holds — what every reader of this run will see. On the normal path
  // it is `handle.finalStatus`; when the CAS lost, it is whatever the other process wrote, read
  // back rather than assumed (it is `failed` today, but the row is the authority, not this file).
  let effectiveStatus: RunStatus = handle.finalStatus;
  if (!claimed) {
    // ⛔ GUARDED LIKE EVERY OTHER DB CALL IN THIS FUNCTION, AND FOR THE SAME REASON.
    // `finalize` is reached only from the detached `void spawnAndPump(...)`, so a throw here has no
    // request to surface on: it becomes a silent unhandled rejection that skips BOTH remaining
    // writes — the sandbox transition and the audit row — stranding the sandbox in `running`
    // forever with nothing in the log. That is precisely the failure the note above
    // `transitionSandbox` describes, and it is why the CAS, the transition and `recordAudit` are
    // each individually guarded. This readback was the one unguarded statement left.
    //
    // ⛔ AND ITS REACHABILITY IS NOT INDEPENDENT OF THE FAULT. This branch runs only when the
    // lease already expired — i.e. when the DB or the network was ALREADY unhappy enough for a
    // heartbeat to be missed. A readback failure here is correlated with, not orthogonal to, the
    // condition that got us here, so "it would only throw if the DB is down" is an argument FOR
    // the guard, not against it.
    //
    // FALLBACK: `effectiveStatus` is already `handle.finalStatus`, so losing the readback costs us
    // only the ability to name the OTHER process's verdict. Continuing with the runner's own status
    // is strictly better than skipping the sandbox release and the audit row entirely.
    let observed: string | undefined;
    let readbackError: unknown;
    try {
      const [row] = await db
        .select({ status: flowRuns.status })
        .from(flowRuns)
        .where(eq(flowRuns.id, handle.runId));
      observed = row?.status;
      effectiveStatus = (row?.status as RunStatus | undefined) ?? handle.finalStatus;
    } catch (err) {
      readbackError = err;
    }
    // LOUD, and on `error` rather than `warn`: a run whose results were thrown away is an incident,
    // and this line is the only place the two records are visible together.
    log.error('run_finalize_matched_no_running_row', {
      runId: handle.runId,
      observedStatus: observed ?? (readbackError ? 'unreadable' : 'gone'),
      runnerStatus: handle.finalStatus,
      runnerTotalMs: handle.totalMs,
      runnerCostUsd: handle.totals.usd,
      runnerLlmCalls: handle.totals.llmCalls,
      err: readbackError,
    });
    if (readbackError) {
      // Separate line, separate token: the audit row that follows will describe
      // `handle.finalStatus`, which may NOT be what the row holds. Say so, or the one case where
      // the two records legitimately disagree becomes indistinguishable from the bug this whole
      // block exists to close.
      log.error('run_finalize_status_readback_failed', {
        runId: handle.runId,
        fallbackStatus: handle.finalStatus,
        err: readbackError,
      });
    }
  }

  // ⛔ FREE THE SANDBOX BEFORE THE AUDIT WRITE, NOT AFTER IT.
  // `waitForRun` — and the UI's run poll — watch `flow_runs.status`, which just went terminal above.
  // The sandbox claim (`inArray(status, ['idle','error'])`) is what the NEXT `POST /api/runs` needs.
  // With the audit insert sitting between them there is a real window in which the product says the
  // run has finished while the sandbox is still `running`, so a user who clicks Run again the moment
  // their run reports done gets `409 sandbox_busy` for a sandbox that is not busy. The window is
  // invisible on an idle box and opens up under load: it reddened CI on an unrelated frontend-only
  // PR, where the next test's POST beat this transition and got the 409.
  //
  // Ordering only — nothing here is skipped or made conditional. Both writes stay individually
  // guarded, so a failing audit still cannot strand the sandbox (the reason that `try` exists), and
  // now a slow audit cannot delay its release either.
  //
  // `effectiveStatus`, not `handle.finalStatus`: the sandbox must follow the run's PERSISTED
  // outcome. (When the CAS lost, the reconciler already set this sandbox to `error` in the same
  // transaction, so the `expectedStatuses: ['running']` guard makes this a no-op anyway — but a
  // guard is not a reason to compute the wrong intent.)
  if (handle.sandboxId) {
    try {
      await transitionSandbox(
        handle.sandboxId,
        effectiveStatus === 'failed' ? 'error' : 'idle',
        db,
        { expectedStatuses: ['running'] },
      );
    } catch (err) {
      log.error('run_sandbox_transition_failed', { runId: handle.runId, err });
    }
  }

  // Audit the completed run (sandbox.run) for the platform feed. AWAIT (not fire-and-forget):
  // this runs inside withTenantDb, whose `finally` clears the GUC and releases the reserved
  // connection the moment `fn` resolves — a `void`ed insert could race that teardown and run
  // against a released connection (the error would be swallowed → a lost audit row under cp_app).
  //
  // GUARDED like its two neighbours (the flow_runs update above, transitionSandbox below): a lost
  // audit row is bad, but an UNCAUGHT throw here is worse. `finalize` is reached only from the
  // detached `void spawnAndPump(...)`, so the rejection has no request to surface on — it became a
  // silent unhandled rejection that ALSO skipped the sandbox transition below, stranding the
  // sandbox in `running` forever with no log explaining why.
  //
  // ⛔ THE AUDIT ROW DESCRIBES `effectiveStatus` — WHAT THE DB HOLDS — NOT WHAT THIS PROCESS SAW.
  // It used to read `handle.finalStatus` unconditionally, which is how one run ended up with an
  // audit line reading `Success · 3.42s` beside a `flow_runs` row reading `failed`. The audit feed
  // and `GET /api/runs/:id` are two views of ONE run and they must not contradict each other.
  //
  // ⛔ AND THE RUNNER'S OWN OBSERVATION IS KEPT, IN `metadata`, NOT DELETED. It really did finish,
  // with a real duration and a real cost the tenant was metered for. Dropping that would replace a
  // loud contradiction with a quiet one; recording it under `reconciled` is what lets a human — or
  // a query over `audit_log` — find every run this happened to and see both sides.
  try {
    await recordAudit({
      actorId: handle.userId,
      action: 'sandbox.run',
      category: 'sandbox',
      targetType: 'flow',
      targetId: handle.flowName,
      result:
        effectiveStatus === 'ok'
          ? `Success · ${((handle.totalMs ?? 0) / 1000).toFixed(2)}s`
          : effectiveStatus === 'partial'
            ? 'Partial'
            : 'Failed',
      resultTone:
        effectiveStatus === 'ok' ? 'ok' : effectiveStatus === 'partial' ? 'warn' : 'error',
      metadata: {
        runId: handle.runId,
        sandboxId: handle.sandboxId,
        // Absent on the ordinary path — a marker that fires on every run would be no marker at all.
        ...(claimed
          ? {}
          : {
              reconciled: true,
              runnerStatus: handle.finalStatus,
              runnerTotalMs: handle.totalMs,
              runnerCostUsd: handle.totals.usd,
              runnerLlmCalls: handle.totals.llmCalls,
            }),
      },
    });
  } catch (err) {
    log.error('run_audit_failed', { runId: handle.runId, err });
  }

  });

  // Keep the handle streamable briefly, then evict.
  setTimeout(() => runRegistry.delete(handle.runId), EVICT_MS).unref?.();
}

/** Persist cancellation first so a different replica observes it, then abort any matching local
 * transport immediately. The runner finalizer is compare-and-set and cannot clear the pause. */
export async function cancelRunsForSandbox(
  sandboxId: string,
  database: typeof db = db,
): Promise<string[]> {
  const now = new Date();
  const rows = await database
    .update(flowRuns)
    .set({ cancel_requested_at: now })
    .where(and(eq(flowRuns.sandbox_id, sandboxId), eq(flowRuns.status, 'running')))
    .returning({ id: flowRuns.id });
  const ids = new Set(rows.map((row) => row.id));
  for (const handle of runRegistry.values()) {
    if (handle.sandboxId === sandboxId && !handle.completed) {
      ids.add(handle.runId);
      handle.ac.abort();
    }
  }
  return [...ids];
}

/** Reconcile runs whose executing replica stopped heartbeating. Safe to call under SYSTEM scope;
 * the status predicate makes multiple watchdog replicas idempotent. */
export async function reconcileStaleRuns(now = new Date(), database: typeof db = db): Promise<string[]> {
  const stale = await database
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.status, 'running'), lte(flowRuns.lease_expires_at, now)));
  const recovered: string[] = [];
  for (const run of stale) {
    const terminal: TraceEvent = {
      type: 'run_complete',
      runId: run.id,
      ts: now.getTime(),
      totalMs: run.total_ms ?? Math.max(0, now.getTime() - new Date(run.started_at).getTime()),
      status: 'failed',
      totals: {
        usd: Number(run.total_cost_usd),
        tokensIn: run.tokens_in,
        tokensOut: run.tokens_out,
        llmCalls: run.llm_calls,
      },
    };
    const trace = ((run.trace ?? []) as TraceEvent[]).filter((event) => event.type !== 'run_complete');
    const bounded = [...trace.slice(0, RING_CAP - 1), terminal];
    const won = await database.transaction(async (tx) => {
      const [updated] = await tx
        .update(flowRuns)
        .set({
          status: 'failed',
          trace: bounded,
          trace_truncated: run.trace_truncated || trace.length >= RING_CAP,
          event_count: Math.max(run.event_count, trace.length) + 1,
          finished_at: now,
          lease_expires_at: null,
        })
        .where(and(eq(flowRuns.id, run.id), eq(flowRuns.status, 'running')))
        .returning({ id: flowRuns.id });
      if (!updated) return false;
      await tx
        .insert(flowRunEvents)
        .values({ run_id: run.id, tenant_id: run.tenant_id, seq: Math.max(run.event_count, trace.length) + 1, event: terminal })
        .onConflictDoNothing({ target: [flowRunEvents.run_id, flowRunEvents.seq] });
      if (run.sandbox_id) {
        await tx
          .update(sandboxes)
          .set({ status: 'error', suspension_reason: null, updated_at: now })
          .where(and(eq(sandboxes.id, run.sandbox_id), eq(sandboxes.status, 'running')));
      }
      return true;
    });
    if (won) recovered.push(run.id);
  }
  await releaseOrphanedSandboxes(now, database);
  return recovered;
}

/** A sandbox left 'running' with no genuinely-running run can never be claimed again (the claim
 *  only accepts 'idle'/'error'), so its owner would 409 sandbox_busy forever. That state is reached
 *  by a pod dying between the claim and the run row, so it must be healed continuously, not just by
 *  the one-time migration backfill. Deliberately does NOT touch 'suspended' — an operator pause and
 *  the idle watchdog both own that state. */
async function releaseOrphanedSandboxes(now: Date, database: typeof db = db): Promise<void> {
  await database
    .update(sandboxes)
    .set({ status: 'idle', updated_at: now })
    .where(
      and(
        eq(sandboxes.status, 'running'),
        notExists(
          database
            .select({ one: sql`1` })
            .from(flowRuns)
            .where(and(eq(flowRuns.sandbox_id, sandboxes.id), eq(flowRuns.status, 'running'))),
        ),
      ),
    );
}

let runReconcilerTimer: ReturnType<typeof setInterval> | undefined;

/** Default reconciler period. Paired with TICK_MIN_INTERVAL_MS.runLeaseReconciler (14s). */
const DEFAULT_RUN_RECONCILER_MS = 15_000;

export function startRunReconciler(intervalMs = DEFAULT_RUN_RECONCILER_MS): void {
  if (runReconcilerTimer) return;
  runReconcilerTimer = setInterval(() => {
    // The registry's interval is the DEFAULT, not a second source of truth: `startRunReconciler`
    // is parameterised (tests pass a short interval), so a caller-supplied period must still win
    // or the claim window could exceed it and suppress every other tick. Adding a constant to
    // tick-locks.ts that nothing reads would defeat the whole point of moving the key there.
    void claimTick({
      key: TICK_LOCK.runLeaseReconciler,
      minIntervalMs:
        intervalMs === DEFAULT_RUN_RECONCILER_MS
          ? TICK_MIN_INTERVAL_MS.runLeaseReconciler
          : Math.max(5_000, intervalMs - 1_000),
      label: '[run-reconciler] tick',
      // Refused every 15s on every non-winning replica — expected, so no counter AND no repeated
      // warn: 5,760/day at 2 replicas, 17,280 at 4. See the sandbox-sweep note for why a counter
      // here would measure the replica count, and `claimTick`'s `refusal` doc for the log half.
      // The first refusal per process still WARNs, so the election is visible in a pod's log.
      skipCounter: null,
      refusal: 'expected',
      run: () => reconcileStaleRuns(new Date()),
    }).catch((err) => log.error('run_reconciler_failed', { err }));
  }, intervalMs);
  runReconcilerTimer.unref?.();
}

// ---- HTTP handlers ----

const createRun = route(async (req) => {
  const { user, tenantId } = await resolveTenant(req);
  let rejectionTarget = 'unknown';
  try {
  const body = createRunSchema.parse(await readJson(req));
  rejectionTarget = body.solutionId ? `solution:${body.solutionId}` : `flow:${body.flowId}`;
  const target = body.solutionId
    ? await loadRunnableSolution(body.solutionId)
    : await loadRunnableFlow(body.flowId!, user.id);
  const { flow } = target;
  // `let`: a sample test (W8/P4) executes a copy of the graph with the challenge's data bound.
  let graph = target.graph;
  // Which solution this run is a demo OF (0065) — null for a `{flowId}` run, which is a draft on
  // the Build canvas and is nobody's demo. Stamped onto the flow_runs row below.
  const runSolutionId: string | null = target.solutionId;
  const rawIdempotencyKey = req.headers.get('Idempotency-Key')?.trim() || null;
  if (rawIdempotencyKey && rawIdempotencyKey.length > 200) {
    throw unprocessable('invalid_idempotency_key', 'Idempotency-Key must be at most 200 characters');
  }

  // A run executes in the caller's persistent sandbox (provisioned on demand).
  // An ADMINISTRATOR's pause blocks runs — that is the stop for runaway cost (SPEC §6).
  // An IDLE-watchdog suspension does not: this request is an explicit run by the sandbox's own
  // owner (`ensureSandbox` only ever returns the caller's primary), which is exactly the gesture the
  // owner's resume button stands for. It is resumed inside the claim transaction below, so a run
  // refused by validation never resumes anything. Before 2026-10-15 every first run after a week
  // idle failed with "resume it and retry" — all 22 prod sandboxes were idle-suspended.
  const sandbox = await ensureSandbox({ id: user.id, name: user.name }, db, tenantId);
  if (sandbox.status === 'suspended' && sandbox.suspension_reason !== 'idle') {
    throw unprocessable(
      'sandbox_suspended',
      'Your sandbox was paused by an administrator. Ask a platform operator to resume it.',
      {
        sandboxId: sandbox.id,
        suspensionReason: sandbox.suspension_reason,
        resumable: false,
      },
    );
  }

  // Publication identity/status/tenant/archive checks happen before every side effect. A crafted
  // graph cannot display one block while executing another version's source.
  const { versions } = await resolveExecutableBlocks(graph);
  const descriptorsById = new Map<string, BlockDescriptor>(
    versions.map((v) => [v.id, v.descriptor]),
  );

  // W8/P4: bind the challenge's sample data BEFORE validation — an unset required dataset input is
  // exactly what the binding fills, so validating first would refuse the run it is meant to start.
  // The stored flow is untouched; only this run's copy carries the binding.
  let sampleTest: { binding: SampleBinding } | null = null;
  if (body.sampleChallengeId) {
    const prepared = await prepareSampleTest({
      tenantId,
      challengeId: body.sampleChallengeId,
      graph,
      descriptors: descriptorsById,
    });
    graph = prepared.graph;
    sampleTest = { binding: prepared.binding };
  }

  // Pre-flight: structure (cycle/dangling/dup) then handle-type checks.
  const structure = validateGraphStructure(graph);
  const handles = validateGraphAgainstBlocks(graph, descriptorsById);
  const issues = [...structure.issues, ...handles.issues];
  if (issues.length) {
    throw unprocessable('flow_invalid', 'The flow is not ready to run.', { issues });
  }

  // Governance run-gate (Session 6): the network / PII run policies become real
  // preconditions here. A violation refuses the run + records a run.blocked audit.
  const snapshot = await getSnapshot();
  const violation = enforceRunPolicies(graph, descriptorsById, snapshot);
  if (violation) {
    await recordAudit({
      actorId: user.id,
      action: 'run.blocked',
      category: 'sandbox',
      targetType: 'flow',
      targetId: flow.name,
      result: `Blocked · ${violation.policyKey}`,
      resultTone: 'error',
      metadata: { code: violation.code, reason: violation.reason, flowId: flow.id },
    });
    throw unprocessable(violation.code, violation.reason, {
      policyKey: violation.policyKey,
      // Same field name as the submit path — the run pill and the submit pill are the same
      // component on the same screen reading the same `VALIDATION_MESSAGES` entry.
      blockSlug: violation.nodeSlug,
    });
  }

  // Resolve datasets referenced by any dataset-typed input (Phase 2.0). The slug is
  // the node-config literal; the host loads + caps + (per PII policy) redacts the
  // rows, then injects them in the init frame so the runner gets no DB access.
  // Done BEFORE any side effect (sandbox transition / run row) so the Phase-4 data-validation
  // gate can refuse the run cleanly.
  const referencedSlugs: string[] = [];
  for (const node of graph.nodes) {
    const d = descriptorsById.get(node.blockVersionId);
    if (!d) continue;
    for (const [inputName, spec] of Object.entries(d.inputs ?? {})) {
      if (spec.type !== 'dataset') continue;
      // The node config wins; a dataset input may also carry a descriptor `default` slug (Phase 3
      // derived data blocks bind their primary sample this way) which the host injects when the
      // node leaves the input unset.
      const cfg = node.config?.[inputName];
      const slug = typeof cfg === 'string' && cfg ? cfg : spec.default;
      if (typeof slug === 'string' && slug) referencedSlugs.push(slug);
    }
  }
  // A reader who is not a data manager gets EVERY PII-flagged column replaced by
  // `maskInjectedForReader` below (type-preserving); loading those rows pre-redacted to the string
  // "[redacted]" would put a string into a number column and fail the run's typed steps.
  const dataManager = canManageData({ user });
  const injected = referencedSlugs.length
    ? await loadInjectedDatasets(tenantId, referencedSlugs, snapshot.piiScrubbing === true && dataManager)
    : { datasets: {}, truncated: {} };
  for (const [slug, dropped] of Object.entries(injected.truncated)) {
    log.warn('run_dataset_injected_truncated', { slug, droppedRows: dropped });
  }

  // Phase 4: validate any injected dataset bound to an ontology entity against the ontology
  // (mapped-column types + PII redaction coverage). data.validation_mode: 'block' refuses the run
  // here (before side effects); 'warn' records a finding and proceeds.
  const dataFindings = await validateInjectedAgainstOntology(tenantId, injected.datasets);
  if (dataFindings.length) {
    // A bare count told the auditor a run was refused and NOTHING about why — the reader had to
    // reproduce the run to learn whether it was a type slip or PII heading into the sandbox
    // unredacted. The rule set and the first refs are the two things that make the row readable.
    //
    // ⛔ CAPPED AT 20 ON PURPOSE. `audit_log.metadata` is JSONB; a 500-column dataset would write
    // an unbounded blob on EVERY refused run, and the row exists to be read, not to be the record.
    // `findings` stays the true total, so a truncated `findingRefs` is never mistaken for the count.
    //
    // ⛔ DEDUPE BEFORE THE CAP, NOT AFTER — AND THE ORDER IS THE WHOLE POINT. `findingRefs` is an
    // ADDRESS list (`dataset.column→attribute`), not a finding list; the count above is what
    // carries multiplicity. One column raising BOTH rules is the case the frontend's own index-key
    // comment calls "the very first realistic case" (a PII attribute on an unflagged column whose
    // values also mistype), and it emits the identical address twice. Slicing first spent two of
    // the 20 budgeted slots on one address, so the auditor's 20-address window could hold as few
    // as 10 distinct addresses — half the intended read, on exactly the runs with the most to say.
    const auditFindings = {
      findings: dataFindings.length,
      findingRules: [...new Set(dataFindings.map((f) => f.rule))],
      findingRefs: [
        ...new Set(dataFindings.map((f) => `${f.dataset}.${f.column}→${f.attribute}`)),
      ].slice(0, AUDIT_FINDING_REF_CAP),
    };
    if (snapshot.dataValidation === 'block') {
      await recordAudit({
        actorId: user.id,
        action: 'run.blocked',
        category: 'data',
        targetType: 'flow',
        targetId: flow.name,
        result: `Blocked · data validation (${dataFindings.length} finding${dataFindings.length === 1 ? '' : 's'})`,
        resultTone: 'error',
        metadata: { flowId: flow.id, ...auditFindings },
      });
      throw unprocessable(
        'data_validation_failed',
        'The selected test data does not satisfy the published data contract.',
        { findings: dataFindings },
      );
    }
    await recordAudit({
      actorId: user.id,
      action: 'data.validation_warn',
      category: 'data',
      targetType: 'flow',
      targetId: flow.name,
      result: `${dataFindings.length} data-validation finding${dataFindings.length === 1 ? '' : 's'} (warn)`,
      resultTone: 'warn',
      metadata: { flowId: flow.id, ...auditFindings },
    });
  }

  // W8: ANY run by someone who is not a data manager reads its datasets MASKED, with the same rule
  // as the sample-data preview (datasets/member-view.ts), so its results — and every ctx.llm()
  // prompt a block builds from them — can only carry values the member may already see. This used
  // to apply only to the P4 sample test (`sampleChallengeId`); an ordinary {flowId} run handed a
  // member the raw rows. Data managers keep today's behaviour (`data.pii_scrubbing` only).
  // Applied AFTER the ontology validation above, so findings describe the real data. The masking
  // is type-preserving (datasets/run-mask.ts): a number column stays numbers, a date column stays
  // dates — the run's typed steps see the declared types. Findings carry counts and names, never
  // values.
  const runDatasets = await maskInjectedForReader(tenantId, injected.datasets, dataManager);

  // Claim + run row are one transaction. The primary sandbox row serializes concurrent starts and
  // the partial unique index is the final invariant. A retry carrying the same key returns the
  // original run without spawning or billing twice.
  const claimed = await db.transaction(async (tx) => {
    if (rawIdempotencyKey) {
      const [existing] = await tx
        .select()
        .from(flowRuns)
        .where(
          and(
            eq(flowRuns.triggered_by, user.id),
            eq(flowRuns.idempotency_key, rawIdempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return { run: existing, reused: true, resumed: null };
    }

    // Idle-suspended → idle, for the owner only (the helper's WHERE is the authorisation; an admin
    // pause never matches and falls through to the `sandbox_suspended` refusal below). Always
    // attempted, not only when the early read saw `suspended`: the watchdog can suspend between
    // that read and this transaction, and an UPDATE matching 0 rows costs nothing.
    const resumed = await resumeOwnIdleSandbox(tx, { ownerId: user.id, tenantId, sandboxId: sandbox.id });

    const now = new Date();
    const [won] = await tx
      .update(sandboxes)
      .set({
        status: 'running',
        suspension_reason: null,
        last_active_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(sandboxes.id, sandbox.id),
          inArray(sandboxes.status, ['idle', 'error']),
        ),
      )
      .returning({ id: sandboxes.id });
    if (!won) {
      const [current] = await tx.select().from(sandboxes).where(eq(sandboxes.id, sandbox.id));
      if (current?.status === 'suspended') {
        // `resumable: true` is still REACHABLE, so it stays: when the resume above matched 0 rows
        // (the sandbox was idle then, so no row lock was taken), the watchdog can idle-suspend it
        // before the claim UPDATE, which then re-reads `suspended` under READ COMMITTED and misses.
        // The browser offers "resume and retry" for exactly that case.
        throw unprocessable('sandbox_suspended', 'Your sandbox is suspended.', {
          sandboxId: current.id,
          suspensionReason: current.suspension_reason,
          resumable: current.suspension_reason === 'idle',
        });
      }
      throw conflict('sandbox_busy', 'Your sandbox is already running another flow.');
    }

    const [run] = await tx
      .insert(flowRuns)
      .values({
        flow_id: flow.id,
        // 0065. Written AT INSERT, from the resolution that already happened, because this is the
        // only moment the system knows it: `POST /api/runs {solutionId}` IS the "Try it" button on
        // a solution page. Recovering it later from `flow_id` is not the same fact — see the note
        // on loadRunnableSolution.
        solution_id: runSolutionId,
        tenant_id: tenantId,
        triggered_by: user.id,
        sandbox_id: sandbox.id,
        status: 'running',
        idempotency_key: rawIdempotencyKey,
        heartbeat_at: now,
        lease_expires_at: new Date(now.getTime() + LEASE_MS),
      })
      .returning();
    return { run: run!, reused: false, resumed };
  });

  if (claimed.resumed) {
    await recordAudit({
      actorId: user.id,
      action: 'sandbox.resume',
      category: 'sandbox',
      targetType: 'sandbox',
      targetId: claimed.resumed.slug,
      result: 'Owner resumed · test run',
      resultTone: 'ok',
    });
  }

  // The warn-mode findings, on the SUCCESS body.
  //
  // ⛔ THE DEFECT THIS FIXES. `warn` is the SHIPPED DEFAULT (`data.validation_mode` in
  // db/seed-platform.ts), and until now it wrote an audit row and returned a body indistinguishable
  // from a clean run — so the tester watched a green run while PII went into the sandbox
  // unredacted, and the ONE place that knew had already computed the findings and dropped them.
  //
  // CONDITIONAL ON PURPOSE. The clean-run body is byte-for-byte what it always was, so the client's
  // check is `!!body.dataValidation` and never a length compare on a key that is always present.
  // `mode` rides along because the browser cannot see the governance policy and must not guess
  // whether it is looking at a warning or the aftermath of one.
  //
  // ⚠️ UNCAPPED, DELIBERATELY, AND NOT AN OVERSIGHT OF THE 20-REF AUDIT CAP ABOVE. The two are
  // capped differently because they are different things:
  //   • `metadata.findingRefs` goes into `audit_log`, which is the PERMANENT RECORD and is written
  //     on EVERY refused run, so an unbounded blob accumulates forever. It is an index into the
  //     run, and `metadata.findings` carries the true total so a truncated list is never mistaken
  //     for the count.
  //   • THIS list is transient — sent once, read immediately, then gone. Truncating it would make
  //     the browser silently UNDER-REPORT how much data is heading into the sandbox unredacted,
  //     which is strictly worse than a large body for a warning whose entire job is to be complete.
  //     A cap would only be honest alongside a "showing N of M" signal, i.e. a wire-shape and
  //     8-locale frontend change, for a payload the browser already renders safely.
  // The magnitude, stated rather than assumed: findings are per MAPPED column, at most two per
  // column (pii_uncovered + type_mismatch), and the column map is a HUMAN-CONFIRMED mapping saved
  // on the Datasets screen. A pathological fully-mapped 500-column dataset is ~1000 findings ≈
  // 250 KB of JSON, once. The browser bounds the render independently — see the `findings-list`
  // height + scroll note in frontend/src/routes/build/+page.svelte, measured at 250 findings.
  // If this ever needs a cap, it needs the total alongside it; do not add one without.
  const dataValidationBody = dataFindings.length
    ? { dataValidation: { mode: snapshot.dataValidation, findings: dataFindings } }
    : {};

  if (claimed.reused) {
    return jsonResponse({
      runId: claimed.run.id,
      status: claimed.run.status,
      sandboxId: claimed.run.sandbox_id,
      idempotent: true,
      ...(sampleTest ? { sampleTest } : {}),
      // An idempotent replay is the SAME run against the SAME data, so it carries the same
      // warning. Omitting it here would mean a retried request — the ordinary consequence of a
      // flaky network — silently drops the alert the first response carried.
      ...dataValidationBody,
    });
  }

  const sources: Record<string, string> = {};
  for (const v of versions) sources[v.id] = v.source_ts;

  startRun(
    claimed.run.id,
    user.id,
    sandbox.id,
    flow.name,
    graph,
    sources,
    runDatasets,
    tenantId,
  );
  return jsonResponse(
    {
      runId: claimed.run.id,
      status: 'running',
      sandboxId: sandbox.id,
      ...dataValidationBody,
      // W8/P4: which step read which sample data, so the canvas can show the same binding.
      ...(sampleTest ? { sampleTest } : {}),
    },
    201,
  );
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
      incCounter(`run_rejected_${err.code.replace(/[^a-zA-Z0-9_]/g, '_')}_total`);
      try {
        await recordAudit({
          actorId: user.id,
          action: 'run.rejected',
          category: 'sandbox',
          targetType: 'flow',
          targetId: rejectionTarget,
          result: `Rejected · ${err.code}`,
          resultTone: 'error',
          metadata: { code: err.code, tenantId, ...(err.details ?? {}) },
        });
      } catch (auditErr) {
        log.error('run_rejection_audit_failed', { err: auditErr });
      }
    }
    throw err;
  }
});

const getRun = route(async (req, id) => {
  const { user } = await resolveTenant(req);
  const [run] = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, id!), eq(flowRuns.triggered_by, user.id)));
  if (!run) throw notFound('run_not_found', `No run '${id}'`);
  // LLM spend is tenant_admin+ on the wire (run-cost-visibility.ts), here as on the SSE stream.
  return jsonResponse(runRowFor(user, run));
});

export function registerRunRoutes(router: Router): void {
  router.add('POST', '/api/runs', createRun);
  router.add('GET', '/api/runs/:id', getRun);
  // GET /api/runs/:id/stream is registered by sse-stream.ts (registerRunStream).
}
