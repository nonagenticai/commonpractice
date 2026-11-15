// src/host/metering-outbox-drainer.ts — delivers `metering_outbox` rows to `billing:costs`.
//
// The broker writes one outbox row per `usage_events` ledger row, in the SAME transaction
// (host/llm-broker.ts `settleSpend`, host/metering-emit.ts `enqueueCostEvent`). This drainer is the
// only thing that XADDs them. A row is `sent` only after Redis acknowledged the XADD; any failure
// leaves it `pending` with a backoff, so a transport outage delays spend reaching billing and never
// loses it.
//
// ⚠️ AT-LEAST-ONCE, NOT EXACTLY-ONCE, and that is safe by construction: a crash between the XADD and
// the `sent` UPDATE re-sends the row, and every event carries `event_key = usage_events.id`, which
// billing's cost_flusher deduplicates on. Do not try to make the send "exactly once" here.
//
// Runs under `claimTick`, i.e. as SYSTEM on one pod: the outbox is tenant-scoped under RLS and this
// read is deliberately cross-tenant.
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { config } from '../config';
import { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS, tickClaimWindowMs } from './tick-locks';
import { sendCostEventFields } from './metering-emit';
import { incCounter, setGauge } from './metrics';
import { log } from './logger';

export const OUTBOX_SENT_COUNTER = 'metering_outbox_sent_total';
export const OUTBOX_SEND_FAILED_COUNTER = 'metering_outbox_send_failed_total';

/**
 * The two backlog GAUGES (host/metrics.ts `PRESEEDED_GAUGES`).
 *
 * ⛔ THESE NUMBERS WERE ALREADY BEING COMPUTED AND THROWN AWAY. `drainMeteringOutbox` has always
 * returned `pending` + `oldestPendingAgeSeconds` and `logDrain` has always written them to a log
 * line — and gitops `rules.yaml` states that "loki has no `ruler` stanza, so log-based alerting
 * cannot fire". Undelivered LLM spend is the most alertable quantity this service produces, and it
 * was measured every period and discarded. The log line stays (it is the human breadcrumb); the
 * gauge is the part a rule can read.
 */
export const OUTBOX_PENDING_GAUGE = 'metering_outbox_pending';
export const OUTBOX_OLDEST_PENDING_AGE_GAUGE = 'metering_outbox_oldest_pending_age_seconds';

/**
 * Fire period — `METERING_EMIT_ENABLED`'s sibling knob `METERING_OUTBOX_INTERVAL_MS`
 * (config.ts `meteringOutboxIntervalMs`, default 30 000 = the literal this replaced).
 *
 * ⚠️ A FUNCTION, NOT A CONST, and not merely for tidiness: a module-level `const` snapshots
 * `config` at IMPORT time, which in `bun test` is whichever test file happened to load this module
 * first. Reading it per use keeps the value honest and keeps the claim-window derivation below
 * consistent with whatever period actually armed the timer.
 */
export function meteringOutboxIntervalMs(): number {
  return config.metering.outboxIntervalMs;
}

/**
 * The tick-claim window, DERIVED from the live period rather than asserted against it.
 *
 * ⛔ THIS IS THE HALF OF "MAKE THE INTERVAL CONFIGURABLE" THAT IS EASY TO FORGET, AND IT IS THE HALF
 * THAT BREAKS SILENTLY. `TICK_MIN_INTERVAL_MS.meteringOutbox` is 25 s and its comment reads "Drainer
 * fires every 30s … same just-below-the-period rule as the watchdog" — an invariant stated against a
 * period that was a compile-time fact and, as of this change, is not. Set
 * `METERING_OUTBOX_INTERVAL_MS=20000` and a fixed 25 s window EXCEEDS the period: every claim inside
 * the window is refused, the drainer runs at a fraction of its configured rate, and nothing says so
 * — `claimTick` is called with `refusal:'expected'` on the scheduled path, so the refusals log at
 * `info` and are indistinguishable from ordinary leader election. `tickClaimWindowMs` is exactly the
 * helper `translation` and `budget` already use for this, for exactly this reason: the registry
 * entry stays LIVE as a ceiling (at the 30 s default it still decides the window, unchanged) while
 * becoming incapable of exceeding the period it is supposed to sit below.
 */
function meteringOutboxClaimWindowMs(): number {
  return tickClaimWindowMs(meteringOutboxIntervalMs(), TICK_MIN_INTERVAL_MS.meteringOutbox);
}

const BATCH = 500;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** Exponential backoff for a row that has failed `attempts` times (1-based after the failure). */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface OutboxDrainResult {
  sent: number;
  failed: number;
  /** Pending rows left after this pass (due or not). */
  pending: number;
  /** Age in seconds of the oldest pending row, 0 when none — undelivered spend, the number to watch. */
  oldestPendingAgeSeconds: number;
}

export async function drainMeteringOutbox(limit = BATCH): Promise<OutboxDrainResult> {
  const due = (await db.execute(
    sql`SELECT id, fields, attempts FROM metering_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY created_at
         LIMIT ${limit}`,
  )) as unknown as { id: string; fields: Record<string, string>; attempts: number }[];

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const ok = await sendCostEventFields(row.fields);
    if (ok) {
      await db.execute(
        sql`UPDATE metering_outbox SET status = 'sent', sent_at = now(), last_error = NULL
             WHERE id = ${row.id} AND status = 'pending'`,
      );
      sent++;
      incCounter(OUTBOX_SENT_COUNTER);
    } else {
      const attempts = row.attempts + 1;
      await db.execute(
        sql`UPDATE metering_outbox
               SET attempts = ${attempts},
                   last_error = 'send failed (see metering_cost_event_dropped_total)',
                   next_attempt_at = now() + make_interval(secs => ${outboxBackoffMs(attempts) / 1000})
             WHERE id = ${row.id} AND status = 'pending'`,
      );
      failed++;
      incCounter(OUTBOX_SEND_FAILED_COUNTER);
    }
  }

  const [backlog] = (await db.execute(
    sql`SELECT count(*)::int AS pending,
               COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::int AS oldest
          FROM metering_outbox WHERE status = 'pending'`,
  )) as unknown as { pending: number; oldest: number }[];

  const out: OutboxDrainResult = {
    sent,
    failed,
    pending: backlog?.pending ?? 0,
    oldestPendingAgeSeconds: backlog?.oldest ?? 0,
  };

  // ⛔ SET INSIDE THE MEASURING FUNCTION, NOT IN `logDrain`. `logDrain` is only reached through the
  // scheduled `claimTick` wrapper; `drainMeteringOutbox` is ALSO called directly (the boot drain's
  // `run`, and every test in tests/metering-outbox.test.ts). Publishing from here means the gauge
  // reflects every pass that actually measured the backlog, including the boot drain — which is the
  // one that matters after a rollout, because a pod that restarted during a Redis outage must not
  // read 0 for a whole period while a real backlog sits in the table.
  //
  // ⛔ AND IT IS SET UNCONDITIONALLY, INCLUDING TO 0. A drain that finds nothing pending is a
  // POSITIVE measurement — "billing is current" — not an absence, and writing it is what lets an
  // operator tell a healthy queue from a drainer that stopped running. Skipping the zero write would
  // leave the last non-zero reading standing forever and alert on a backlog that has since cleared.
  setGauge(OUTBOX_PENDING_GAUGE, out.pending);
  setGauge(OUTBOX_OLDEST_PENDING_AGE_GAUGE, out.oldestPendingAgeSeconds);

  return out;
}

function logDrain(out: OutboxDrainResult | undefined): void {
  if (!out) return; // claim refused — another pod drained
  // WARN when anything is left pending past two periods: that is spend billing has not received.
  // Two of the CONFIGURED period, not of a hard-coded 30 s — an operator who lengthens the interval
  // has widened what "on time" means, and a threshold that did not follow would warn on every pass.
  const stale =
    out.pending > 0 && out.oldestPendingAgeSeconds * 1000 > 2 * meteringOutboxIntervalMs();
  (stale ? log.warn : log.info)('metering_outbox_drained', { component: 'metering', ...out });
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Boot-only (server.ts), same convention as every other in-process scheduler. A no-op unless
 *  METERING_EMIT_ENABLED — the broker enqueues nothing without it, so there is nothing to drain. */
export function startMeteringOutboxDrainer(): void {
  if (!config.metering.emitEnabled) {
    log.info('metering_outbox_drainer_disabled', { component: 'metering' });
    return;
  }
  const run = (label: string, skipCounter: string | null, refusal: 'notable' | 'expected') =>
    claimTick({
      key: TICK_LOCK.meteringOutbox,
      minIntervalMs: meteringOutboxClaimWindowMs(),
      label,
      skipCounter,
      refusal,
      run: () => drainMeteringOutbox(),
    }).then(logDrain);

  // Boot drain: a pod that restarts during a Redis outage must not wait a period to resume.
  void run('[metering-outbox] boot drain', null, 'notable').catch((err) =>
    log.error('metering_outbox_boot_drain_failed', { component: 'metering', err }),
  );

  const arm = (): void => {
    timer = setTimeout(() => {
      void run('[metering-outbox] scheduled drain', 'metering_outbox_tick_skipped_total', 'expected')
        .catch((err) => log.error('metering_outbox_drain_failed', { component: 'metering', err }))
        .finally(arm);
    }, meteringOutboxIntervalMs());
  };
  log.info('metering_outbox_drainer_armed', {
    component: 'metering',
    intervalMs: meteringOutboxIntervalMs(),
    // Logged alongside the period because the pair is the invariant: a window >= the period means
    // every other pod's drain is refused, and this line is the only place the two are visible at
    // once on a running pod.
    claimWindowMs: meteringOutboxClaimWindowMs(),
  });
  arm();
}

export function stopMeteringOutboxDrainer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
