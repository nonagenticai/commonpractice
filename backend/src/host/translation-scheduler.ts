// src/host/translation-scheduler.ts — Phase 2-G translation drainer.
// In-process + BOOT-ONLY (mirrors startCycleScheduler / startAuditExportScheduler), but
// INTERVAL-based rather than a daily tick: queued content must localize within minutes,
// not within ~24h. A re-arming timer runs processPendingBatch every TRANSLATION_INTERVAL_MIN;
// each drain is bounded by batchSize and the per-actor daily LLM cap (a cap-reject DEFERS,
// leaving jobs pending for the next tick), so it never blocks a request thread and is its
// own catch-up. The boot drain runs one batch immediately. No cron framework, no k8s
// CronJob — portable. A no-op (logged) when TRANSLATION_ENABLED!=true, so dev / CI /
// `bun test` never schedule.
import { config } from '../config';
import { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS, tickClaimWindowMs } from './tick-locks';
import { processPendingBatch, type BatchResult } from './translation-service';
import { log } from './logger';

/** ms between drains. Pure (unit-tested) so the cadence is verifiable without a timer. */
export function msUntilNextDrain(intervalMinutes: number): number {
  return Math.max(1, intervalMinutes) * 60_000;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The claim window for THIS pod's CONFIGURED drain period.
 *
 * ⛔ NOT `TICK_MIN_INTERVAL_MS.translation` DIRECTLY. That constant is 2 min and its comment used to
 * assert "scheduler fires every 5 min" — but the period is `TRANSLATION_INTERVAL_MIN`, which an
 * operator sets. At `=2` the window equals the period and every second drain is refused; at `=1` it
 * exceeds it and four drains in five are refused. Neither is visible: the scheduled path is
 * `refusal:'expected'`, so those refusals are `info` lines identical to normal leader election.
 * `tickClaimWindowMs` keeps the constant as the CEILING (so the default period behaves exactly as
 * before, and the registry entry is still read) while the configured period always wins when tighter.
 *
 * Read at CALL time, not at module load: `startTranslationScheduler` is called after config is
 * assembled, and tests mutate `config.translation` in place.
 */
function drainClaimWindowMs(): number {
  return tickClaimWindowMs(
    msUntilNextDrain(config.translation.intervalMinutes),
    TICK_MIN_INTERVAL_MS.translation,
  );
}

/**
 * Wall-clock ceiling on ONE drain, as a backstop for the tick claim.
 *
 * ⛔ CORRECTED: this used to say `runSystemTick` "holds `pg_advisory_lock(TICK_LOCK.translation)`".
 * It does not, and describing a mechanism that was deliberately REMOVED is worse than saying
 * nothing — a session-level advisory lock cannot work behind PgBouncer's transaction pooler, which
 * is exactly why leader election had never worked and was replaced (#149, migration 0051) by an
 * atomic row claim in `scheduler_ticks` (`host/tick-locks.ts`) that depends on no connection
 * identity.
 *
 * The hazard this guard exists for is still real, just differently shaped: if the tick never
 * settles, its claim is never completed and the drain does not run again — and because the promise
 * never settles, `.catch()` never fires either, so the failure cannot even be logged. The LLM calls inside are now individually bounded
 * (ai/llm/select.ts), which removes the known cause; this bounds the tick as a whole so that any
 * FUTURE unbounded await inside it degrades to a logged, self-healing timeout instead of a
 * fleet-wide wedge.
 */
// Returns `BatchResult` (the service's own type) rather than an inline structural copy: the
// inline shape silently dropped every field added to BatchResult later — `cappedActors` included —
// so the stall signal would never have reached the logger below.
function boundedDrain(ms: number): Promise<BatchResult> {
  return Promise.race([
    processPendingBatch(new Date()),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`translation drain exceeded ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * The ONE drain logger, shared by the boot drain and every scheduled drain.
 *
 * It was previously inline on the interval path only, so the BOOT drain — the one that runs
 * against the whole accumulated backlog, and the only drain a short-lived pod ever performs —
 * had a `.catch` and nothing else: it logged NOTHING on success and nothing on a pure defer.
 * A pod could start, find 608 undrainable jobs, and say not one word.
 *
 * ⛔ `r` IS OPTIONAL BECAUSE A REFUSED CLAIM RESOLVES TO `undefined`, AND THE `if (!r) return`
 * BELOW USED TO SWALLOW IT. That early return is correct for the case it was written for — a tick
 * that did literally nothing (no jobs pending) stays silent, since that is the normal steady state
 * and logging it every interval would bury the lines that matter. But it made a REFUSED CLAIM
 * indistinguishable from an idle drain: both arrived here as a falsy `r` and produced not one word.
 * That is precisely the silence that hid the ~27h cycle starvation on a different scheduler, and
 * tick-locks.ts carried a comment asserting this file did not have it.
 *
 * The refusal is now logged and counted by `claimTick` BEFORE this function is reached, so the
 * early return once again means only what it says: nothing happened, and that is normal.
 */
function logDrain(r: BatchResult | undefined): void {
  if (!r) return;
  if (r.cappedActors > 0 && r.processed === 0) {
    // The stall. Loud, at warn, and named as such — this is the state that produced a 608-job
    // backlog nobody noticed because a pure-defer tick used to be indistinguishable from an idle
    // one in both the log and the audit trail.
    log.warn('translation_drain_no_progress', {
      component: 'translation',
      cappedActors: r.cappedActors,
      deferred: r.deferred,
      failed: r.failed,
    });
    return;
  }
  if (r.processed || r.failed || r.deferred) {
    log.info('translation_drain_completed', {
      component: 'translation',
      processed: r.processed,
      failed: r.failed,
      deferred: r.deferred,
      cappedActors: r.cappedActors,
    });
  }
}

/**
 * Start the translation drainer. Boot-only — call once from server.ts. A no-op (logged)
 * when disabled, so dev / CI / `bun test` never schedule a timer.
 */
export function startTranslationScheduler(): void {
  if (!config.translation.enabled) {
    log.info('translation_scheduler_disabled', {
      component: 'translation',
      reason: 'TRANSLATION_ENABLED!=true',
    });
    return;
  }

  // Boot drain: translate any backlog now (cap-reject defers). runSystemTick → exactly one pod
  // drains when replicas > 1 (the pending select has no SKIP-LOCKED claim, so two concurrent
  // drains would double-spend LLM budget) and runs the cross-tenant queue read as SYSTEM.
  void claimTick({
    key: TICK_LOCK.translation,
    minIntervalMs: drainClaimWindowMs(),
    label: '[translation] boot drain',
    // ⛔ NULL ON THE BOOT PATH — same asymmetry as cycle-scheduler and budget-scheduler, same
    // reason. The claim window is 2 min against a 5-min period, so a second replica booting inside
    // a rolling deploy collides with the first pod's boot drain; that collision is the claim doing
    // its job (two concurrent drains would double-spend LLM budget), not a fault. The SCHEDULED
    // path keeps the counter. Both still LOG.
    skipCounter: null,
    run: () => boundedDrain(config.translation.drainTimeoutMs),
  })
    .then(logDrain)
    .catch((err) => {
      log.error('translation_boot_drain_failed', { component: 'translation', err });
    });

  const arm = (): void => {
    const delay = msUntilNextDrain(config.translation.intervalMinutes);
    timer = setTimeout(() => {
      void claimTick({
        key: TICK_LOCK.translation,
        minIntervalMs: drainClaimWindowMs(),
        label: '[translation] scheduled drain',
        skipCounter: 'translation_tick_skipped_total',
        // At 2 replicas the loser of this tick is refused every single cycle (5-min period vs a
        // process that runs forever) — that is leader election working, not a fault, so only the
        // first refusal per pod WARNs (still proving election is live in the logs); every
        // subsequent one is `info`, not silence. See `refusal` doc on `claimTick` in tick-locks.ts.
        refusal: 'expected',
        run: () => boundedDrain(config.translation.drainTimeoutMs),
      })
        .then(logDrain)
        .catch((err) => log.error('translation_scheduled_drain_failed', { component: 'translation', err }))
        .finally(arm);
    }, delay);
  };
  log.info('translation_scheduler_armed', {
    component: 'translation',
    intervalMinutes: config.translation.intervalMinutes,
    batchSize: config.translation.batchSize,
  });
  arm();
}

/** Stop the loop (used by tests / graceful shutdown). */
export function stopTranslationScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
