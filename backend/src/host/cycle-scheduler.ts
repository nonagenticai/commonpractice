// src/host/cycle-scheduler.ts — Phase 2-E marketplace-cycle scheduler.
// In-process + BOOT-ONLY (mirrors startAuditExportScheduler): a re-arming timer fires
// once a day at CYCLE_TICK_HOUR_UTC and runs tickCycles, which opens the current week
// and advances any cycle past a phase boundary. A daily cadence lands each boundary
// within ~24h; tickCycles is itself the catch-up, so a pod down across a boundary still
// transitions on the next run. The boot catch-up runs one tick immediately.
//
// NB that catch-up claim used to be only HALF true, and the half it got wrong was silent:
// tickCycles advanced every overdue cycle, but it opened only `weekString(now)`. A week that
// elapsed ENTIRELY during downtime therefore never got a cycle row at all, and challenges stamped
// into it (challengeWeekFor, 0047) had no boundaries to advance them — they sat in `voting`
// forever. tickCycles now back-fills those weeks before opening the current one. No cron framework, no k8s CronJob — portable.
//
// 0107: the cadence is the `cycle.cadence` policy (host/cycle-cadence.ts), not CYCLE_ENABLED. The
// timer is always armed by server.ts, and EVERY tick claims the day's lock — OFF included, where
// `tickCycles` then does nothing. ⛔ An earlier draft returned before the claim when off; that left
// `scheduler_ticks` unwritten, so the gitops alert `CommonPracticeDailySchedulerStale` (which reads
// the claim's age) either fired forever on an off cluster or had to be taught an exception — the
// alert stops meaning "the scheduler is dead". The starvation that draft feared cannot happen: a
// switch off→on starts at the next period boundary (a later day's 00:00), whose 03:00 tick claims
// its own day key. `bun test` never imports server.ts, so tests never schedule.
import { config } from '../config';
import { utcDayString } from './audit-export';
import { claimTick, cycleTickKey, TICK_MIN_INTERVAL_MS } from './tick-locks';
import { tickCycles } from './cycle-service';
import { log } from './logger';

/** ms from `now` until the next `hourUtc`:00:00 UTC (today if still ahead, else tomorrow). */
export function msUntilNextTick(now: Date, hourUtc: number): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * One cycle tick, shared by the boot catch-up and the scheduled timer.
 *
 * Two things here are the actual fix, and both are about VISIBILITY as much as correctness:
 *
 * 1. The claim is keyed per UTC DAY (`cycleTickKey`), not on the bare cadence. Rationale, and why
 *    the day rather than the week, is in tick-locks.ts — read it before changing this.
 *
 * 2. A REFUSED claim is logged and counted. The claim resolves to `undefined` when another caller
 *    holds the window, so `.catch()` never fires and the original code discarded it entirely. That
 *    silence is what made the 2026-08-09/10 starvation undiagnosable: the cycle sat ~27h overdue and
 *    the ONLY trace anywhere was the next `[cycle] next tick at …` line naming a day later than
 *    expected. Now a skip says so, and `cycle_tick_skipped_total` makes it alertable.
 *
 * That branch is no longer written here: `claimTick` (tick-locks.ts) owns it for all six ticks,
 * because the same comment used to promise that every scheduler had it and four of them did not.
 *
 * `label` distinguishes the two callers in the log line — they claim the same key on the same day
 * by design (the second is correctly refused, since the first already advanced everything), so
 * without it a normal same-day collision and a real starvation read identically.
 */
export function cycleTickKeyForNow(now: Date = new Date()): string {
  return cycleTickKey(utcDayString(now));
}

export async function runCycleTick(label: string, scheduled: boolean, now: () => Date = () => new Date()): Promise<void> {
  try {
    const result = await claimTick({
      key: cycleTickKeyForNow(now()),
      minIntervalMs: TICK_MIN_INTERVAL_MS.cycle,
      label: `[cycle] ${label}`,
      // ⚠️ ONLY the SCHEDULED tick is counted, and that asymmetry is the whole point — it is why
      // `claimTick` takes a NULLABLE counter rather than deriving one from the key. A boot catch-up
      // colliding with the same day's already-run tick is healthy and happens on every deploy;
      // counting it would page on every rollout and the counter would be ignored within a week.
      // `incCounter` takes no labels, so the log line's `label` cannot separate them at the metric —
      // the call site has to. A scheduled tick being refused still means something was claimed
      // before 03:00 UTC that day, which is the condition worth looking at. Both still LOG.
      skipCounter: scheduled ? 'cycle_tick_skipped_total' : null,
      // OFF: the claim above is still made (see the header) and the tick is a recorded no-op.
      run: () => tickCycles(now()),
    });
    if (result === undefined) return;
    // 0110: ONE outcome per tenant. Report a tenant only when something MOVED (most ticks are
    // no-ops).
    let off = 0;
    for (const t of result.tenants) {
      const r = t.result;
      if (!r) continue;
      if (r.cadence === 'off' && r.opened === null && r.closed.length === 0) {
        off++;
        continue;
      }
      const moved = r.backfilled.length + r.advanced.length + r.closed.length;
      if (moved > 0) {
        log.info('cycle_tick_moved', {
          component: 'cycle',
          label,
          tenantId: t.tenantId,
          opened: r.opened,
          backfilled: r.backfilled,
          advanced: r.advanced,
          closed: r.closed,
          orphanedCount: r.orphaned.length,
        });
      }
    }
    if (off > 0) log.info('cycle_tick_off', { component: 'cycle', label, tenants: off });
    // Failed tenants (`result.failed`) are counted + logged ONCE by `tickCycles` itself: it returns
    // normally, so the failure has to reach `scheduler_tick_failed_total` there, not here.
  } catch (err) {
    log.error('cycle_tick_failed', { component: 'cycle', label, err });
  }
}

/**
 * Start the daily marketplace-cycle tick. Boot-only — call once from server.ts. Always armed;
 * whether a tick does anything is the `cycle.cadence` policy's call, read at each tick.
 */
export function startCycleScheduler(): void {
  // A cycle tick advances EVERY tenant's cycle (0110: each tenant sequentially, in its own transaction
  // under its own lock — cycle-service `tickCycles`) — work no single per-request tenant scope covers. Run it as SYSTEM
  // (owner pool, RLS-bypassed) so it stays correct once the runtime flips to the non-owner cp_app.
  // Boot catch-up: advance any overdue cycle now (idempotent). runSystemTick → only one pod
  // runs it when replicas > 1.
  void runCycleTick('boot catch-up', false);

  const arm = (): void => {
    const delay = msUntilNextTick(new Date(), config.cycle.tickHourUtc);
    const at = new Date(Date.now() + delay).toISOString();
    log.info('cycle_next_tick_scheduled', { component: 'cycle', at, delayMinutes: Math.round(delay / 60000) });
    timer = setTimeout(() => {
      void runCycleTick('scheduled tick', true).finally(arm);
    }, delay);
  };
  arm();
}

/** Stop the loop (used by tests / graceful shutdown). */
export function stopCycleScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
