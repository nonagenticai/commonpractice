// tests/audit-export.test.ts — Phase 2-F compliance export.
// Pure unit (day-window math, next-run scheduling) + integration over a real Postgres:
// runExport pages the day's audit_log into an NDJSON bundle, uploads it (uploader is
// injected — no live storage), records audit_exports, and is IDEMPOTENT (a success day
// is skipped unless forced). The export date is far-future so the day window is clean.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, auditLog, auditExports } from '../src/db/client';
import {
  runExport,
  buildExportBundle,
  dayWindowUtc,
  utcDayString,
  type Uploader,
  type ExportDeps,
} from '../src/host/audit-export';
import { msUntilNextRun, runAuditExportTick } from '../src/host/audit-export-scheduler';
import { auditExportTickKey } from '../src/host/tick-locks';
import { schedulerTicks } from '../src/db/client';

const DATE = '2099-01-15';

// A separate far-future block for the scheduler-tick tests, so they cannot interact with
// DATE's fixtures above. TICK_SEED is pre-marked exported; the ticks then walk forward.
const TICK_SEED = '2099-02-01';
const TICK_DAYS = ['2099-02-02', '2099-02-03', '2099-02-04', '2099-02-05', '2099-02-06'];

/** A capturing uploader: records every (key, body) and can be told to fail. */
function fakeUploader() {
  const calls: { key: string; body: string; contentType: string }[] = [];
  let fail = false;
  const uploader: Uploader = async (key, body, contentType) => {
    if (fail) throw new Error('storage boom');
    calls.push({ key, body, contentType });
  };
  return { uploader, calls, setFail: (v: boolean) => (fail = v) };
}

async function cleanup() {
  await db.delete(auditLog).where(eq(auditLog.action, 'test.fixture'));
  await db.delete(auditLog).where(and(eq(auditLog.action, 'audit.export'), eq(auditLog.target_id, DATE)));
  await db.delete(auditExports).where(eq(auditExports.export_date, DATE));
  await db.delete(auditExports).where(inArray(auditExports.export_date, [TICK_SEED, ...TICK_DAYS]));
  await db.delete(auditLog).where(and(eq(auditLog.action, 'audit.export'), inArray(auditLog.target_id, TICK_DAYS)));
  // the per-day tick claims themselves — without this the second RUN of this file would
  // find every day already claimed and the tests would pass vacuously.
  await db.delete(schedulerTicks).where(like(schedulerTicks.key, `${auditExportTickKey('')}%`));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  // Three audit rows inside the DATE's UTC day (+ one OUTSIDE it, to prove the window).
  await db.insert(auditLog).values([
    { action: 'test.fixture', category: 'system', created_at: new Date(`${DATE}T01:00:00.000Z`) },
    { action: 'test.fixture', category: 'sandbox', created_at: new Date(`${DATE}T10:30:00.000Z`) },
    { action: 'test.fixture', category: 'policy', created_at: new Date(`${DATE}T23:59:59.000Z`) },
    { action: 'test.fixture', category: 'system', created_at: new Date('2099-01-16T00:00:01.000Z') }, // next day
  ]);
}, 30_000);

afterAll(cleanup, 30_000);

// ---- pure unit ----

test('utcDayString + dayWindowUtc compute a clean UTC day', () => {
  expect(utcDayString(new Date('2099-01-15T18:00:00Z'))).toBe('2099-01-15');
  const { start, end } = dayWindowUtc('2099-01-15');
  expect(start.toISOString()).toBe('2099-01-15T00:00:00.000Z');
  expect(end.toISOString()).toBe('2099-01-16T00:00:00.000Z');
  expect(() => dayWindowUtc('not-a-date')).toThrow();
});

test('msUntilNextRun targets the next hour:00 UTC', () => {
  expect(msUntilNextRun(new Date('2026-06-08T01:00:00Z'), 2)).toBe(60 * 60 * 1000);
  // already past today's hour → tomorrow
  expect(msUntilNextRun(new Date('2026-06-08T03:00:00Z'), 2)).toBe(23 * 60 * 60 * 1000);
  // exactly at the boundary → next day (strictly future)
  expect(msUntilNextRun(new Date('2026-06-08T02:00:00Z'), 2)).toBe(24 * 60 * 60 * 1000);
});

// ---- integration ----

test('buildExportBundle pages only the day window into NDJSON with a stable sha256', async () => {
  const b1 = await buildExportBundle(DATE, new Date('2099-02-01T00:00:00Z'), db);
  expect(b1.rowCount).toBe(3); // the 4th row is the next day
  expect(b1.ndjson.trim().split('\n')).toHaveLength(3);
  expect(b1.sha256).toMatch(/^[0-9a-f]{64}$/);
  // deterministic: same rows + same generated_at → same hash (sha is over the body only)
  const b2 = await buildExportBundle(DATE, new Date('2099-02-09T00:00:00Z'), db);
  expect(b2.sha256).toBe(b1.sha256);
  expect((b1.manifest as { audit_row_count: number }).audit_row_count).toBe(3);
});

test('runExport uploads body + manifest, records success, and is idempotent', async () => {
  const up = fakeUploader();
  const r1 = await runExport({ date: DATE, triggeredBy: 'manual', actorId: null }, { uploader: up.uploader });
  expect(r1.status).toBe('success');
  expect(r1.rowCount).toBe(3);
  expect(up.calls).toHaveLength(2); // audit_log.ndjson + manifest.json
  expect(up.calls[0]!.key).toBe('audit/2099/01/15/audit_log.ndjson');
  expect(up.calls[1]!.key).toBe('audit/2099/01/15/manifest.json');
  expect(up.calls[1]!.contentType).toBe('application/json');

  const [row] = await db.select().from(auditExports).where(eq(auditExports.export_date, DATE));
  expect(row!.status).toBe('success');
  expect(row!.row_count).toBe(3);
  expect(row!.sha256).toBe(r1.sha256!);
  expect(row!.object_key).toBe('audit/2099/01/15/manifest.json');

  // an audit.export row was written
  const [aud] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'audit.export'), eq(auditLog.target_id, DATE)));
  expect(aud!.result_tone).toBe('ok');

  // re-run without force → skipped, NO new upload
  const r2 = await runExport({ date: DATE, triggeredBy: 'scheduler' }, { uploader: up.uploader });
  expect(r2.status).toBe('skipped');
  expect(r2.reason).toBe('already_exported');
  expect(up.calls).toHaveLength(2);

  // re-run WITH force → uploads again
  const r3 = await runExport({ date: DATE, triggeredBy: 'manual', actorId: null, force: true }, { uploader: up.uploader });
  expect(r3.status).toBe('success');
  expect(up.calls).toHaveLength(4);
});

test('an upload failure is recorded as error (never thrown)', async () => {
  const up = fakeUploader();
  up.setFail(true);
  const r = await runExport(
    { date: DATE, triggeredBy: 'manual', actorId: null, force: true },
    { uploader: up.uploader },
  );
  expect(r.status).toBe('error');
  expect(r.error).toContain('storage boom');
  const [row] = await db.select().from(auditExports).where(eq(auditExports.export_date, DATE));
  expect(row!.status).toBe('error');
  expect(row!.error).toContain('storage boom');
});

// ---- scheduler tick: per-day claim + backfill ----
//
// These cover `runAuditExportTick`, which NOTHING above touches. The bug they pin was
// live in prod on 2026-08-03: the boot catch-up and the daily scheduled run shared ONE
// `runSystemTick` key with a 12h debounce, so whichever fired first consumed the window
// and the other was silently skipped — for a DIFFERENT day. Two whole compliance days
// (2026-07-30, 2026-08-02) were missing from `audit_exports` as a result, permanently,
// because `runExport` has no backfill of its own.
//
// Both tests are verified to FAIL against the pre-fix code (shared key / no backfill),
// not merely to pass against the new code.

/** Marks a day as already-exported so `missingExportDays` has a clean starting point. */
async function seedSuccess(date: string) {
  await db.insert(auditExports).values({
    export_date: date,
    status: 'success',
    row_count: 0,
    object_key: `test/${date}.ndjson`,
    sha256: 'x'.repeat(64),
    triggered_by: 'scheduler',
  });
}

test('a tick for one day does NOT starve the next day (the shared-key bug that lost 2 prod days)', async () => {
  await cleanup();
  await seedSuccess(TICK_SEED);
  const f = fakeUploader();

  // Two ticks 24h apart, each targeting the day that just closed. Under the old single
  // shared key these are the SAME claim, so the second is refused for 12h and its day is
  // lost forever; under a per-day key they are independent claims.
  const first = await runAuditExportTick(new Date('2099-02-03T02:00:00Z'), { uploader: f.uploader });
  const second = await runAuditExportTick(new Date('2099-02-04T02:00:00Z'), { uploader: f.uploader });

  expect(first.map((r) => r.date)).toEqual(['2099-02-02']);
  // THE assertion: the second day must still be exported despite the first day's claim.
  expect(second.map((r) => r.date)).toEqual(['2099-02-03']);

  const rows = await db
    .select({ date: auditExports.export_date, status: auditExports.status })
    .from(auditExports)
    .where(inArray(auditExports.export_date, TICK_DAYS));
  expect(rows.map((r) => `${r.date}:${r.status}`).sort()).toEqual([
    '2099-02-02:success',
    '2099-02-03:success',
  ]);
}, 30_000);

test('the same day claimed twice exports once — the boot catch-up must not double-export', async () => {
  await cleanup();
  await seedSuccess(TICK_SEED);
  const f = fakeUploader();

  // Simulates a redeploy: the boot catch-up and the scheduled run both target the day
  // that just closed. Per-day keying must make them COLLIDE, not both run.
  const boot = await runAuditExportTick(new Date('2099-02-03T02:00:00Z'), { uploader: f.uploader });
  const sched = await runAuditExportTick(new Date('2099-02-03T02:05:00Z'), { uploader: f.uploader });

  expect(boot.map((r) => r.date)).toEqual(['2099-02-02']);
  expect(sched).toEqual([]); // refused by the debounce window — the point of the claim
  // object keys are path-style (`audit/2099/02/02/audit_log.ndjson`), not dashed dates
  expect(f.calls.filter((c) => c.key === 'audit/2099/02/02/audit_log.ndjson')).toHaveLength(1);
}, 30_000);

test('a missed day is backfilled by the next tick instead of being lost forever', async () => {
  await cleanup();
  await seedSuccess(TICK_SEED);
  const f = fakeUploader();

  // Nothing ran for 02-02..02-05; the next tick closes 02-06. Pre-fix, `runExport` only
  // ever targeted the one day and the gap stayed a permanent hole.
  const results = await runAuditExportTick(new Date('2099-02-07T02:00:00Z'), { uploader: f.uploader });

  expect(results.map((r) => r.date)).toEqual([
    '2099-02-02',
    '2099-02-03',
    '2099-02-04',
    '2099-02-05',
    '2099-02-06',
  ]);
}, 30_000);

test('an INTERIOR hole is healed — the case a forward walk from max(success) can never see', async () => {
  await cleanup();
  // Reproduces prod's actual 2026-08-04 shape: a contiguous run of successes with ONE
  // day punched out of the middle, which later days then leapfrogged. Walking forward
  // from max(success) yields [] here and the hole never heals.
  await seedSuccess(TICK_SEED);      // 2099-02-01
  await seedSuccess('2099-02-03');
  await seedSuccess('2099-02-04');   // max(success) is now PAST the hole at 02-02
  const f = fakeUploader();

  const results = await runAuditExportTick(new Date('2099-02-06T02:00:00Z'), { uploader: f.uploader });

  // 02-02 is the interior hole; 02-05 is the ordinary trailing gap. Both are owed.
  expect(results.map((r) => r.date)).toEqual(['2099-02-02', '2099-02-05']);
  expect(results.every((r) => r.status === 'success')).toBe(true);
}, 30_000);

test('days before the first-ever successful export are not owed an archive', async () => {
  await cleanup();
  // Only ONE success on record, and the tick targets a day well after it. Days preceding
  // the first archive predate the export system — proposing them would manufacture work
  // (and empty bundles) for a period nobody was ever promised an archive for.
  await seedSuccess('2099-02-04');
  const f = fakeUploader();

  const results = await runAuditExportTick(new Date('2099-02-07T02:00:00Z'), { uploader: f.uploader });

  expect(results.map((r) => r.date)).toEqual(['2099-02-05', '2099-02-06']);
}, 30_000);

/**
 * ⛔ THE PRE-CLAIM DB READ MUST BE ALERTABLE, NOT JUST LOGGED.
 *
 * `runAuditExportTick` calls `missingExportDays()` BEFORE its first `claimTick` — it has to, since
 * that read decides WHICH days get claimed. `countFailures` inside `claimTick` only wraps the work
 * `runSystemTick` invokes, so a DB failure there threw straight past every counter to the two
 * callers in `startAuditExportScheduler`, whose only handling is `.catch(log.error)`. Per gitops
 * `clusters/strato/services/prometheus/rules.yaml` loki has NO `ruler` stanza, so a log line in this
 * estate cannot raise an alert at all: a DB outage killing the nightly COMPLIANCE export produced
 * zero Prometheus series and paged nobody, in the one job whose header insists a day that never gets
 * exported "must be discoverable, not just absent".
 *
 * Needs no fixture and no live failure: the injected `db` throws on its first statement, which is
 * exactly the shape of the outage.
 */
test('⛔ a DB failure in the PRE-CLAIM missingExportDays bumps scheduler_tick_failed_total', async () => {
  const { renderMetrics } = await import('../src/host/metrics');
  const { TICK_FAILED_COUNTER } = await import('../src/host/tick-locks');

  const counterValue = (): number => {
    const m = new RegExp(`^\\w*${TICK_FAILED_COUNTER} (\\d+)$`, 'm').exec(renderMetrics());
    return m ? Number(m[1]) : -1;
  };

  // ⛔ NON-VACUITY: the series must already EXIST (it is in PRESEEDED_COUNTERS), otherwise a
  // "counter did not move" reading and a "counter is not registered" reading are the same -1.
  const before = counterValue();
  expect(before).toBeGreaterThanOrEqual(0);

  const boom = new Error('db boom');
  const throwingDb = {
    select() {
      throw boom;
    },
  } as unknown as NonNullable<ExportDeps['db']>;

  await expect(runAuditExportTick(new Date(), { db: throwingDb })).rejects.toThrow('db boom');

  // Bumped exactly once — `countFailures` rethrows unchanged and the throw aborts the tick before
  // any `claimTick`, so there is no second wrapper on this path to double-count it.
  expect(counterValue()).toBe(before + 1);
});
