// src/host/audit-export-scheduler.ts — Phase 2-F nightly export scheduler.
// In-process + BOOT-ONLY (mirrors startSandboxWatchdog / startConnectorListener): a
// re-arming timer fires at AUDIT_EXPORT_HOUR_UTC and exports the day that just closed.
// The audit_exports day-claim makes a missed/double/restart fire harmless. On boot it
// also CATCHES UP yesterday if there's no success row (so a pod down at the scheduled
// hour still produces the archive). No cron framework, no k8s CronJob — portable.
//
// The tick claim (runSystemTick) is keyed PER EXPORT DAY (auditExportTickKey), not by a single
// shared wall-clock key — see tick-locks.ts for why a shared key silently lost whole compliance
// days in prod (2026-08-03 finding: 2026-07-30 and 2026-08-02 both missing). Both the boot catch-up
// and the scheduled run funnel through `runAuditExportTick` below, which ALSO bounded-backfills any
// day missed since the newest successful export — so a skipped/crashed tick self-heals on the next
// call instead of leaving a permanent hole (mirrors cycle-service.ts's backfillMissedCycles).
import { config } from '../config';
import { claimTick, countFailures, auditExportTickKey, TICK_MIN_INTERVAL_MS } from './tick-locks';
import {
  runExport,
  utcDayString,
  missingExportDays,
  type ExportResult,
  type ExportDeps,
} from './audit-export';
import { log } from './logger';

/** ms from `now` until the next `hourUtc`:00:00 UTC (today if still ahead, else tomorrow). */
export function msUntilNextRun(now: Date, hourUtc: number): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** The 'YYYY-MM-DD' of the UTC day before `now` (the day a nightly run archives). */
function yesterdayUtc(now: Date): string {
  return utcDayString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * The single tick step, shared by the boot catch-up and the scheduled timer: bounded-backfill any
 * day missed since the newest successful export, then export the day that just closed relative to
 * `now`. Each day gets its OWN `runSystemTick` claim (`auditExportTickKey`), so a claim for one day
 * cannot block another day's claim, and two callers targeting the SAME day (a boot catch-up
 * overlapping the scheduled run) correctly collide onto one winner instead of double-exporting.
 *
 * A skip (another pod/call already holds a day's claim within the debounce window) is made VISIBLE
 * — logged and counted — rather than silently swallowed, since this is a compliance job: a day that
 * never gets exported must be discoverable, not just absent.
 *
 * `deps` is test-only injection (fake uploader / db), passed straight through to `runExport` and
 * `missingExportDays`; production callers (below) never pass it.
 */
export async function runAuditExportTick(now: Date, deps: ExportDeps = {}): Promise<ExportResult[]> {
  const target = yesterdayUtc(now);
  // ⛔ WRAPPED, BECAUSE THIS RUNS BEFORE ANY CLAIM AND `claimTick` THEREFORE CANNOT SEE IT.
  // `countFailures` bumps `scheduler_tick_failed_total` and rethrows unchanged. Without it a DB
  // failure here throws past every claim below to the two callers, whose only handling is
  // `log.error` — and loki has no `ruler` stanza in this estate (gitops
  // clusters/strato/services/prometheus/rules.yaml), so a log line cannot raise an alert. That made
  // "a DB outage silently killed the compliance export every night" a state with no Prometheus
  // series at all, in the one job whose header insists a missing day "must be discoverable, not just
  // absent". It cannot double-count: the throw aborts the tick before the first `claimTick`, so no
  // wrapped `run` is reached, and a refused claim does not throw.
  // ⚠️ THIS CLOSES THE PRE-CLAIM HOLE ONLY — do not read it as "audit export failures are now
  // counted". `runExport` CATCHES EVERYTHING and returns `{status:'error'}` rather than throwing,
  // so a POST-claim failure still never reaches `countFailures` and still bumps nothing; it is
  // recorded in `audit_exports.status` and a `log.error`, and loki has no `ruler`, so no rule can
  // see it. Measured, not assumed: an injected throwing uploader RESOLVES. Making that path
  // countable means changing what `runExport` does with its errors, which is a separate change.
  const missing = await countFailures(() => missingExportDays(target, deps.db))();
  if (missing.length) {
    log.warn('audit_export_backfilling_missed_days', {
      component: 'audit-export',
      missedCount: missing.length,
      missedDays: missing,
    });
  }

  const results: ExportResult[] = [];
  for (const date of [...missing, target]) {
    const result = await claimTick({
      key: auditExportTickKey(date),
      minIntervalMs: TICK_MIN_INTERVAL_MS.auditExport,
      label: `[audit-export] tick for ${date}`,
      skipCounter: 'audit_export_tick_skipped_total',
      run: () => runExport({ date, triggeredBy: 'scheduler' }, deps),
    });
    if (result === undefined) continue;
    results.push(result);
  }
  return results;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the nightly audit-export loop. Boot-only — call once from server.ts. A no-op
 * (logged) when disabled or unconfigured, so dev / CI / `bun test` never schedule.
 */
export function startAuditExportScheduler(): void {
  if (!config.auditExport.enabled) {
    log.info('audit_export_scheduler_disabled', {
      component: 'audit-export',
      reason: 'AUDIT_EXPORT_ENABLED!=true',
    });
    return;
  }
  if (!config.auditExport.storageUrl) {
    log.warn('audit_export_storage_url_missing', {
      component: 'audit-export',
      reason: 'AUDIT_EXPORT_ENABLED=true but AUDIT_EXPORT_STORAGE_URL is empty — not scheduling',
    });
    return;
  }

  // The export archives EVERY tenant's audit_log for the day — system-wide, cross-tenant work.
  // Run it as SYSTEM (owner pool) so it stays correct once the runtime flips to the cp_app role.
  // Boot catch-up: export yesterday (+ any earlier missed day) now.
  void runAuditExportTick(new Date()).catch((err) => {
    log.error('audit_export_boot_catchup_failed', { component: 'audit-export', err });
  });

  const arm = (): void => {
    const delay = msUntilNextRun(new Date(), config.auditExport.hourUtc);
    const at = new Date(Date.now() + delay).toISOString();
    log.info('audit_export_next_run_scheduled', {
      component: 'audit-export',
      nextRunAt: at,
      inMinutes: Math.round(delay / 60000),
    });
    timer = setTimeout(() => {
      void runAuditExportTick(new Date())
        .catch((err) => log.error('audit_export_scheduled_run_failed', { component: 'audit-export', err }))
        .finally(arm);
    }, delay);
  };
  arm();
}

/** Stop the loop (used by tests / graceful shutdown). */
export function stopAuditExportScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
