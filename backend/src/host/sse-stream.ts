// src/host/sse-stream.ts — GET /api/runs/:id/stream as text/event-stream.
// Subscribes to the live RunHandle: replays the per-run buffer for events newer
// than Last-Event-ID (header or ?lastEventId=), then streams live events with
// `id:` = seq so a dropped client can resume on reconnect. A 15s heartbeat keeps
// proxies from idle-closing. A slow/aborted client is cleaned up and never stalls
// the runner (the pump fans out best-effort). If the run already finished + was
// evicted from the registry, the persisted trace is replayed once and closed.
import { and, asc, eq, gt } from 'drizzle-orm';
import { db, flowRuns, flowRunEvents, withTenantTx } from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import { runRegistry, type BufferedEvent } from './run-controller';
import type { TraceEvent } from '../db/trace-types';
import { route, notFound, HttpError } from '../utils/http';
import { validateAuth } from '../middleware/auth';
import { traceEventFor } from './run-cost-visibility';
import { assertTenantNotSuspended } from '../middleware/tenant-status-gate';
import type { Router } from '../utils/router';

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

/** Poll cadence for the cross-replica tail. Deliberately NOT sub-second: this is the fallback for a
 *  stream that landed on a replica which does not own the run, and every tick costs a DB round trip.
 *  Termination is guaranteed by the run reconciler flipping a dead run terminal within ~15s. */
const REMOTE_TAIL_POLL_MS = 1000;

function frame(seq: number, ev: TraceEvent): string {
  return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** The keepalive period for BOTH stream shapes below, and therefore also the tenant-status
 *  re-check period — see `tenantAwareHeartbeat`. */
const HEARTBEAT_DEFAULT_MS = 15000;
let heartbeatMs = HEARTBEAT_DEFAULT_MS;

/** Test seam, same idiom as `__setAuthOverridesForTests`. The mid-stream suspension defect cannot
 *  be observed without at least one tick, and a 15s tick makes that a 15-second test. */
export function __setRunStreamHeartbeatMsForTests(ms: number | undefined): void {
  heartbeatMs = ms ?? HEARTBEAT_DEFAULT_MS;
}

/**
 * The keepalive tick, plus a per-tick re-read of `tenants.status`.
 *
 * ⛔ WHY A STREAM NEEDS ITS OWN TENANT CHECK AT ALL. `middleware/tenant-status-gate.ts` is
 * PER-REQUEST: `validateAuth` at the top of `streamRun` runs `assertTenantActive` exactly once, at
 * CONNECT, and an SSE response is a single request that then stays open for the life of a run.
 * Measured before this existed: a stream opened while the tenant was active kept delivering run
 * frames 10s and 25s AFTER the workspace was suspended, while every browser route answered 403.
 * Nothing else in the process terminates a live stream. Any long-lived response added here later
 * inherits the same hole — a connect-time guard does not enforce a state that can change under it.
 *
 * IT RIDES THE EXISTING KEEPALIVE, never a second timer: one primary-key SELECT per tick per open
 * stream — at the production 15s period, 4 queries/min per open stream on an indexed `uuid`. There
 * is deliberately no cached verdict (the gate's Decision 2: CP runs 2–4 replicas and the suspending
 * PATCH lands on exactly one of them, so a per-process cache would enforce nothing on its peers).
 *
 * ⛔ A FAILED LOOKUP LEAVES THE STREAM OPEN — THE OPPOSITE OF THE REQUEST PATH, ON PURPOSE. The
 * request gate fails CLOSED because a denied request is retried instantly by the client and costs
 * one page load. A stream is not symmetrical: a dropped SSE connection reconnects with backoff and
 * loses every event in the gap (here, the tail of a RUN), and one DB blip would drop every listener
 * on the pod at once — a self-inflicted disconnect storm, to enforce a state ~0% of rows carry.
 * Staying open costs at most one more tick of frames the tenant could already see, and the next
 * tick re-checks. It is not silence: `assertTenantNotSuspended` already counts the failure as
 * `tenant_status_lookup_failures_total`.
 *
 * `terminate('gone')` is the pre-existing "client hung up" teardown; `terminate('suspended')` runs
 * AFTER the terminal frame is enqueued.
 */
function tenantAwareHeartbeat(
  enc: TextEncoder,
  controller: ReadableStreamDefaultController<Uint8Array>,
  tenantId: string | null,
  terminate: (reason: 'gone' | 'suspended') => void,
): () => void {
  let recheckInFlight = false;
  return () => {
    try {
      controller.enqueue(enc.encode(': ping\n\n'));
    } catch {
      terminate('gone');
      return;
    }
    // A lookup slower than one period must not stack up one query per tick.
    if (recheckInFlight) return;
    recheckInFlight = true;
    void (async () => {
      try {
        await assertTenantNotSuspended(tenantId);
      } catch (err) {
        if (!(err instanceof HttpError) || err.code !== 'tenant_suspended') return; // see above
        try {
          // The code-only `event: error` frame is this repo's SSE refusal convention
          // (routes/connectors.ts's `push_failed`, routes/blocks.ts's error frame). Deliberately
          // NOT `event: end` — that means "the run finished", and telling a client its run
          // completed when the workspace was cut off is a lie the UI would render as success.
          controller.enqueue(enc.encode('event: error\ndata: {"code":"tenant_suspended"}\n\n'));
        } catch {
          /* client already hung up — tearing down below is still correct */
        }
        terminate('suspended');
      } finally {
        recheckInFlight = false;
      }
    })();
  };
}

// ---- Cross-replica tail (shared, one poller per run per pod) ----
//
// The naive shape — one `setInterval` per response, each doing `withTenantDb` — is what made the
// original 500-cascade (PRs #77/#78): `withTenantDb` RESERVES a connection from the 6-slot request
// pool, so a handful of concurrent viewers could hold every reserved slot and stall unrelated
// requests on the pod. Two properties keep that from recurring:
//   1. ONE poller per runId, shared by every subscriber, so cost scales with runs, not viewers.
//   2. Reads go through `withTenantTx` + `db.transaction`, which uses the INDEPENDENT transaction
//      pool and holds a connection only for the query — never a per-request reserved slot.
interface TailSubscriber {
  delivered: number;
  send(seq: number, ev: TraceEvent): void;
  finish(): void;
  fail(err: unknown): void;
}

interface RemoteTail {
  runId: string;
  tenantId: string | null;
  userId: string;
  cursor: number;
  subscribers: Set<TailSubscriber>;
  timer: ReturnType<typeof setInterval>;
  polling: boolean;
}

const remoteTails = new Map<string, RemoteTail>();

function stopTail(tail: RemoteTail): void {
  clearInterval(tail.timer);
  remoteTails.delete(tail.runId);
}

async function pollTail(tail: RemoteTail): Promise<void> {
  if (tail.polling) return;
  if (tail.subscribers.size === 0) return stopTail(tail);
  tail.polling = true;
  try {
    const { durable, fresh } = await withTenantTx(tail.tenantId, () =>
      db.transaction(async (tx) => {
        const rows = await tx
          .select({ seq: flowRunEvents.seq, event: flowRunEvents.event })
          .from(flowRunEvents)
          .where(and(eq(flowRunEvents.run_id, tail.runId), gt(flowRunEvents.seq, tail.cursor)))
          .orderBy(asc(flowRunEvents.seq));
        const [row] = await tx
          .select({ status: flowRuns.status, trace: flowRuns.trace })
          .from(flowRuns)
          .where(and(eq(flowRuns.id, tail.runId), eq(flowRuns.triggered_by, tail.userId)));
        return { durable: rows, fresh: row };
      }),
    );

    for (const item of durable) {
      tail.cursor = Math.max(tail.cursor, item.seq);
      for (const sub of tail.subscribers) {
        if (item.seq > sub.delivered) {
          sub.delivered = item.seq;
          sub.send(item.seq, item.event as TraceEvent);
        }
      }
    }

    if (!fresh) {
      for (const sub of tail.subscribers) sub.finish();
      return stopTail(tail);
    }
    if (fresh.status !== 'running') {
      // Runs that completed before durable events existed keep only their JSONB trace — replay it
      // for any subscriber that received nothing from flow_run_events.
      const legacy = (fresh.trace ?? []) as TraceEvent[];
      for (const sub of tail.subscribers) {
        if (tail.cursor === 0 && legacy.length) {
          let seq = 0;
          for (const ev of legacy) {
            seq++;
            if (seq > sub.delivered) {
              sub.delivered = seq;
              sub.send(seq, ev);
            }
          }
        }
        sub.finish();
      }
      return stopTail(tail);
    }
  } catch (err) {
    for (const sub of tail.subscribers) sub.fail(err);
    return stopTail(tail);
  } finally {
    tail.polling = false;
  }
}

/** Attach a subscriber to this run's shared tail, creating it on first use. The tail's cursor is
 *  lowered to the joiner's watermark so a client resuming from an older Last-Event-ID is caught up
 *  by the next tick; per-subscriber `delivered` makes the re-read duplicate-free. */
function attachToTail(
  runId: string,
  tenantId: string | null,
  userId: string,
  sub: TailSubscriber,
): RemoteTail {
  let tail = remoteTails.get(runId);
  if (!tail) {
    tail = {
      runId,
      tenantId,
      userId,
      cursor: sub.delivered,
      subscribers: new Set(),
      polling: false,
      timer: setInterval(() => {
        const current = remoteTails.get(runId);
        if (current) void pollTail(current);
      }, REMOTE_TAIL_POLL_MS),
    };
    tail.timer.unref?.();
    remoteTails.set(runId, tail);
  }
  tail.cursor = Math.min(tail.cursor, sub.delivered);
  tail.subscribers.add(sub);
  void pollTail(tail);
  return tail;
}

/** Exposed for tests: how many shared tails this pod currently runs, and how many subscribers each
 *  is serving. A design that polled per RESPONSE would show one subscriber per tail; the point of
 *  this one is many subscribers per tail, so both numbers matter. */
export function activeRemoteTailCount(): number {
  return remoteTails.size;
}

export function remoteTailSubscriberCount(runId: string): number {
  return remoteTails.get(runId)?.subscribers.size ?? 0;
}

const streamRun = route(async (req, id) => {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const lastEventId =
    Number(req.headers.get('Last-Event-ID') ?? url.searchParams.get('lastEventId') ?? '0') || 0;

  const handle = runRegistry.get(id!);

  // Live run in the registry.
  if (handle) {
    if (handle.userId !== user.id) throw notFound('run_not_found', `No run '${id}'`);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Cost fields are stripped for callers below tenant_admin (run-cost-visibility.ts).
        const send = (b: BufferedEvent) =>
          controller.enqueue(enc.encode(frame(b.seq, traceEventFor(user, b.ev))));
        // Replay anything the client hasn't seen (synchronously — no event can
        // interleave before we subscribe, single-threaded).
        for (const b of handle.events) if (b.seq > lastEventId) send(b);
        if (handle.completed) {
          controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
          controller.close();
          return;
        }
        let hb: ReturnType<typeof setInterval>;
        const sub = (b: BufferedEvent) => {
          try {
            send(b);
            if (b.ev.type === 'run_complete') {
              controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
              cleanup();
              controller.close();
            }
          } catch {
            cleanup();
          }
        };
        const onAbort = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        function cleanup() {
          clearInterval(hb);
          handle!.subscribers.delete(sub);
          req.signal.removeEventListener('abort', onAbort);
        }
        handle.subscribers.add(sub);
        // Live-run path. The RUN's own tenant is judged (the same authority the tail branch below
        // uses, `run.tenant_id` — one route must not judge two different tenants depending on which
        // replica the reader landed on). It is null only for a run started outside a request, where
        // the caller's tenant is the best available answer.
        hb = setInterval(
          tenantAwareHeartbeat(enc, controller, handle.tenantId ?? user.tenantId ?? null, (reason) => {
            cleanup();
            if (reason === 'suspended') {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          }),
          heartbeatMs,
        );
        req.signal.addEventListener('abort', onAbort);
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Not in this replica's registry. Authorize from the shared run row, then either replay a
  // terminal run or tail the durable sequenced event table. A live run must never be ended merely
  // because this request landed on a different pod.
  const [run] = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, id!), eq(flowRuns.triggered_by, user.id)));
  if (!run) throw notFound('run_not_found', `No run '${id}'`);

  const enc = new TextEncoder();
  const tenantId = currentDbContext()?.tenantId ?? run.tenant_id;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const sub: TailSubscriber = {
        delivered: lastEventId,
        send(seq, ev) {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(frame(seq, traceEventFor(user, ev))));
          } catch {
            detach(false);
          }
        },
        finish: () => detach(true),
        fail: (err) => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.error(err);
          } catch {
            /* already closed */
          }
        },
      };

      function cleanup() {
        if (heartbeat) clearInterval(heartbeat);
        remoteTails.get(id!)?.subscribers.delete(sub);
        req.signal.removeEventListener('abort', onAbort);
      }
      function detach(sendEnd: boolean) {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          if (sendEnd) controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
          controller.close();
        } catch {
          /* already closed */
        }
      }
      const onAbort = () => detach(false);

      req.signal.addEventListener('abort', onAbort);
      // Cross-replica tail path. `tenantId` here is the run row's own tenant (or the request's
      // bound GUC) — the same id the tail polls under — so it is what must be re-checked.
      // `detach(false)` closes WITHOUT `event: end`; the terminal error frame is already out.
      heartbeat = setInterval(
        tenantAwareHeartbeat(enc, controller, tenantId, () => detach(false)),
        heartbeatMs,
      );
      attachToTail(id!, tenantId, user.id, sub);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

export function registerRunStream(router: Router): void {
  router.add('GET', '/api/runs/:id/stream', streamRun);
}
