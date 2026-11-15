// src/host/scheduler-freshness.ts — the DB-backed value behind
// `commonpractice_scheduler_last_run_timestamp_seconds`.
//
// WHY THIS EXISTS. CP runs five boot-only, in-process schedulers (audit export, cycle engine,
// translation drainer, budget alerts, connector reconcile — armed in server.ts) plus the sandbox
// sweep and the run-lease reconciler. A dead one is INVISIBLE: the only trace a tick ever leaves is
// a row in `scheduler_ticks` (0051), host/metrics.ts never touched the DB, and the cluster's
// postgres-exporter is stock (no custom-query mount). The cycle tick — the one that decides the
// weekly winner — sat ~27h overdue on 2026-08-09/10 and nothing anywhere said so.
//
// ⛔ WHY THIS READS THE SHARED TABLE INSTEAD OF AN IN-MEMORY TIMESTAMP. Exactly ONE pod wins each
// tick (runSystemTick's claim). An in-process `lastRunAt` would therefore be correct on the winner
// and wrong on the other 1–3 replicas, and would reset to nothing on every rollout — making the
// only expression anyone would write against this metric,
// `time() - max by (scheduler)(commonpractice_scheduler_last_run_timestamp_seconds)`, meaningless.
// The shared row is what makes the value identical across replicas and immune to restarts.
import { metricsClient } from '../db/client';
import { incCounter } from './metrics';
import type { SchedulerFreshness } from './metrics';
import { log } from './logger';

export type { SchedulerFreshness };

/**
 * How long a read is reused before another one is allowed, in ms.
 *
 * ⛔ THE CEILING THIS PROTECTS IS THE POINT OF THE CACHE. Prometheus scrapes every 15s and the
 * Deployment runs 2–4 replicas, so an uncached read would be 8–16 queries/min forever. CP has had
 * TWO production pool exhaustions (gitops #2482, #2489) and `/metrics` is not worth one basis point
 * of a third. At 60s this is at most ONE query per pod per minute — 2–4/min fleet-wide, i.e. fewer
 * round trips than the sandbox watchdog already makes on its 60s timer.
 *
 * 60s and not 30s because the staleness is irrelevant to the only consumer: the alert this metric
 * exists for measures overdue-ness in HOURS (a daily tick that has not run for >26h). A minute of
 * cache age cannot move that decision, and halving the TTL would double the query rate to buy
 * precision nobody reads.
 *
 * Deliberately NOT an env knob. `ownerPoolMax` is an env var because it is a CEILING that has to be
 * retuned against pgbouncer's `pool_size` in another repo; this is a cache TTL with no cross-repo
 * counterpart, and the only interesting value an operator could set it to (0, or a few hundred ms)
 * re-creates the exact scrape-storm the cache exists to prevent. Exported so the test suite can
 * ratchet the floor.
 */
export const SCHEDULER_FRESHNESS_TTL_MS = 60_000;

/**
 * OUTER bound on the read, enforced in JavaScript.
 *
 * `connect_timeout` (10s, db/client.ts) bounds CONNECTING; it does nothing for a connection that is
 * established but whose query never comes back (a saturated pool queues; a wedged backend just sits
 * there). `/metrics` is how we find out the service is sick — it must answer promptly with stale
 * values rather than hold the scrape open until Prometheus' own scrape_timeout kills it, because a
 * killed scrape produces NO series at all, including the http ones that would have shown the
 * outage.
 *
 * ⛔ THIS BOUND ALONE IS NOT A BOUND ON THE DATABASE, AND SHIPPING IT ALONE WAS THE BUG.
 * `Promise.race` abandons the PROMISE. postgres-js exposes no cancellation and takes no
 * AbortSignal, so the query keeps running and the connection stays checked out — which, while this
 * read still ran on the shared request pool, meant six stalled scrapes consumed every request
 * connection in the pod. The real bound is `SCHEDULER_FRESHNESS_STATEMENT_TIMEOUT_MS` below, which
 * makes POSTGRES end the statement and hand the connection back. This one stays as the outer belt:
 * it is the only thing that covers what SQL cannot — a stall BEFORE the statement runs (connect,
 * TLS, a saturated pgbouncer holding an already-connected client, DNS).
 */
export const SCHEDULER_FRESHNESS_READ_TIMEOUT_MS = 2_000;

/**
 * INNER bound on the read, enforced by Postgres via `SET LOCAL statement_timeout`.
 *
 * Strictly BELOW the JS bound on purpose: whichever fires first decides what happens to the
 * connection, and we want that to be Postgres — a `statement_timeout` cancel ends the statement,
 * ends the transaction, and returns the connection to `metricsClient`, whereas the JS race returns
 * to the caller and leaves the backend running. 500ms of margin is far more than the round trip
 * this read costs when healthy (single-digit ms against a six-row aggregate) and comfortably more
 * than the BEGIN/SET LOCAL/COMMIT that wrap it.
 *
 * ⛔ IT IS A `SET LOCAL`, NOT A CONNECTION PARAMETER, AND THAT IS NOT A STYLE CHOICE — both prod
 * poolers list `statement_timeout` in `ignore_startup_parameters`, i.e. they accept it in the
 * startup packet and silently DROP it. The full verification is on `metricsClient` in db/client.ts.
 */
export const SCHEDULER_FRESHNESS_STATEMENT_TIMEOUT_MS = 1_500;

/** Counter name bumped on a failed/timed-out read. Rendered by the generic counter block. */
export const READ_FAILURE_COUNTER = 'scheduler_freshness_read_failures_total';

/**
 * The read.
 *
 * ⛔ THE `split_part(key, ':', 1)` COLLAPSE IS THE WHOLE REASON THIS IS A GROUPED QUERY AND NOT A
 * `SELECT *`. `scheduler_ticks.key` is NOT a fixed vocabulary. Verified against prod on 2026-08-11:
 * six BARE keys (`cycle`, `budget`, `translation`, `sandbox_sweep`, `run-lease-reconciler`,
 * `audit_export`) alongside PER-DAY claim keys (`cycle:2026-08-10`, `cycle:2026-08-11`,
 * `audit_export:2026-07-30` … `audit_export:2026-08-10`) — the dated form is what stops a 12h
 * debounce starving a 24h cadence (tick-locks.ts). Those dated rows are created at ~2/day and are
 * never deleted, so a series per raw key would add ~730 permanently-stale time series a year,
 * forever, to a metric whose whole job is to be alerted on.
 *
 * Collapsing on the first `:` gives ONE series per scheduler FAMILY carrying `max(last_run_at)` —
 * "when did this scheduler last do anything", which is precisely the freshness question. Two
 * consequences worth stating because an alert depends on them:
 *   • The stale legacy bare rows (prod's `cycle` still reads 2026-08-09T20:48Z, from before the
 *     per-day keys landed) are MASKED by the `max`, not averaged into it — so the metric does not
 *     inherit the old bug's timestamp.
 *   • A scheduler that dies leaves its family's max frozen, and `time() - max by (scheduler)(…)`
 *     grows without bound. That is the signal. Nothing else in the metric moves.
 * A bare key and its dated descendants collapse to the SAME family name, so the series survives the
 * key-shape migration in either direction with no relabelling.
 *
 * ⛔ AND IT RUNS ON THE APP DSN, NOT `runAsSystem`/the owner pool. Every other system-path read in
 * this codebase goes through `runAsSystem`, and that is right when the reason is RLS bypass. It is
 * wrong here, twice over:
 *   • It is not needed. `scheduler_ticks` is outside the RLS regime by construction (0051, 0028
 *     §COVERAGE) and prod's runtime role holds SELECT on it — verified live against worker4 on
 *     2026-08-11: `relrowsecurity = f`, and `cp_app` has SELECT/INSERT/UPDATE/DELETE (0028's
 *     `ALTER DEFAULT PRIVILEGES` did cover a table created twenty-three migrations later, so the
 *     trap 0062 warns about does not apply). The runtime role returns the identical six rows.
 *   • It is actively harmful. The owner pool is `ownerPoolMax` = 4 on the TRANSACTION pooler — CP's
 *     tightest ceiling, the one both prod exhaustions landed on, and the one every scheduler and the
 *     boot migration runner already contend for. Routing `/metrics` through it means that during an
 *     owner-pool exhaustion — the incident we most need to observe — the scrape queues behind the
 *     exhaustion and we lose the metrics at exactly the moment they matter. postgres-js QUEUES on a
 *     full pool; it does not fail fast.
 *
 * ⛔ BUT IT DOES NOT RUN ON THE SHARED APP POOL EITHER, AND THE DIFFERENCE IS THE WHOLE FIX. The
 * first version of this ran on `db` — i.e. `queryClient`, the pod's 6 REQUEST connections — bounded
 * only by the JS race. Choosing the app pool over the owner pool was right; leaving the read
 * unbounded on it moved the blast radius from 4 scheduler connections to all 6 request connections
 * and turned `/metrics` into a feedback loop on the exhaustion it exists to report (measured: six
 * stalled scrapes = every request connection gone, and an ordinary `SELECT 1` unable to get one).
 * It now runs on `metricsClient` — the same DSN and the same role, a DEDICATED `max: 1` client — so
 * the worst case is one connection, and `SET LOCAL statement_timeout` below is what actually ends
 * the query rather than merely walking away from it. Both properties are asserted in
 * tests/scheduler-freshness.test.ts against a genuinely stalled query, not a fake reader.
 */
export async function readSchedulerFreshness(): Promise<SchedulerFreshness[]> {
  // ⛔ THE TRANSACTION EXISTS ONLY TO CARRY `SET LOCAL`. A bare `SET` would work on the session
  // pooler and be lost the moment postgres-js recycles the connection (`max_lifetime` 30min /
  // `idle_timeout` 20s both apply to this client), leaving later reads silently unbounded; `SET
  // LOCAL` is re-established on every read by construction and cannot outlive it. `SET LOCAL` also
  // makes the bound correct if this DSN is ever repointed at the transaction pooler.
  const rows = await metricsClient.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${SCHEDULER_FRESHNESS_STATEMENT_TIMEOUT_MS}`,
    );
    return tx<Record<string, unknown>[]>`
      SELECT split_part(key, ':', 1)              AS scheduler,
             extract(epoch FROM max(last_run_at)) AS last_run_epoch
      FROM scheduler_ticks
      GROUP BY 1
      ORDER BY 1
    `;
  });
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    scheduler: String(r.scheduler),
    // `extract(epoch …)` is numeric, which postgres-js hands back as a STRING to avoid precision
    // loss. Number() here, not in the renderer, so the exposition stays a pure string join.
    lastRunAtSeconds: Number(r.last_run_epoch),
  }));
}

type Reader = () => Promise<SchedulerFreshness[]>;

let reader: Reader = readSchedulerFreshness;
/** Last SUCCESSFUL read. `undefined` until one succeeds — never a fabricated zero (see below). */
let cached: SchedulerFreshness[] | undefined;
/** When a read was last ATTEMPTED, success or failure. This, not `cached`, drives the TTL. */
let lastAttemptAt = -Infinity;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scheduler freshness read exceeded ${ms}ms`)),
      ms,
    );
  });
  // `Promise.race` attaches a rejection handler to BOTH inputs, so a slow read that rejects after
  // the timeout already won is still handled — no unhandled rejection. `bomb` is cleared on the
  // happy path so its timer never fires.
  return Promise.race([p, bomb]).finally(() => clearTimeout(timer));
}

async function refresh(): Promise<void> {
  try {
    cached = await withTimeout(reader(), SCHEDULER_FRESHNESS_READ_TIMEOUT_MS);
  } catch (err) {
    // ⛔ NEVER RETHROW, AND NEVER CLEAR `cached`. `/metrics` is the endpoint that tells us the
    // service is sick; it must not become the second casualty of the same DB outage. A failed read
    // serves the last known values (which are still true — they describe ticks that DID happen),
    // and the failure itself is visible as a counter.
    incCounter(READ_FAILURE_COUNTER);
    log.warn('scheduler_freshness_read_failed', { component: 'metrics', err });
  }
}

/**
 * The cached freshness snapshot. NEVER throws, NEVER blocks longer than
 * `SCHEDULER_FRESHNESS_READ_TIMEOUT_MS`, and queries at most once per `SCHEDULER_FRESHNESS_TTL_MS`.
 *
 * `undefined` means "no successful read has ever happened" and the caller must render NOTHING.
 * Rendering a zero instead would publish a 1970 timestamp, and `time() - 0` is ~57 years — the
 * alert would fire on a cold start, which is the one moment it is guaranteed to be wrong.
 *
 * `now` is injectable so the TTL can be tested by value rather than by sleeping.
 *
 * ⛔ THERE IS NO SINGLE-FLIGHT / `inFlight` PROMISE HERE, AND THERE DELIBERATELY IS NOT ONE. An
 * earlier version kept one and it was UNREACHABLE code: `lastAttemptAt` is stamped SYNCHRONOUSLY
 * before the await, so a second caller arriving while a read is in flight is — by definition —
 * inside the TTL and returns at the guard on the line above. It could only be reached by a read
 * outliving the TTL, and the read is bounded at 2s against a 60s TTL. Measured on the version that
 * had it: 8 concurrent calls, caller #0 took the full read, callers #1–#7 returned in 0ms each, the
 * reader ran once — every one of them via the TTL guard, never via the promise. Deleting it changed
 * no test's outcome.
 *
 * The BEHAVIOUR the promise was supposed to provide is real and is still here — concurrent scrapes
 * do not queue behind a slow read, they get the cached value immediately — it is just the TTL that
 * provides it. Making single-flight genuinely reachable would mean stamping `lastAttemptAt` AFTER
 * the read instead, and that is strictly worse: it re-opens a retry on every scrape against a DB
 * that is already failing (a 2s failing read + a 15s scrape interval = a permanent 4x/min retry
 * storm on a sick database), which is the exact property the "a failing read does NOT raise the
 * query rate" test exists to forbid. The two mechanisms are mutually exclusive and the attempt
 * clock is the one worth having.
 */
export async function getSchedulerFreshness(
  now: number = Date.now(),
): Promise<SchedulerFreshness[] | undefined> {
  if (now - lastAttemptAt < SCHEDULER_FRESHNESS_TTL_MS) return cached;
  // Stamped BEFORE the await, deliberately: the TTL clock starts when the read is ISSUED, so the
  // rate is bounded at 1/TTL/pod no matter how slow — or how reliably failing — the read is. A
  // failing DB must not turn every scrape into a fresh connection attempt. It is also what makes
  // concurrent scrapes collapse (see above).
  lastAttemptAt = now;
  await refresh();
  return cached;
}

/** Test seam: swap the DB read for a fake (call with no argument to restore the real one). */
export function __setSchedulerFreshnessReaderForTests(fake?: Reader): void {
  reader = fake ?? readSchedulerFreshness;
}

/** Test seam: forget the cache and the TTL clock. */
export function __resetSchedulerFreshnessCacheForTests(): void {
  cached = undefined;
  lastAttemptAt = -Infinity;
}
