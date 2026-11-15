// tests/scheduler-freshness.test.ts — `commonpractice_scheduler_last_run_timestamp_seconds`.
//
// The gauge exists because CP's five boot schedulers had NO freshness signal: the only record of a
// tick is a `scheduler_ticks` row, host/metrics.ts never read the DB, and postgres-exporter is
// stock. The cycle tick sat ~27h overdue on 2026-08-09/10 and nothing said so.
//
// ⛔ WHAT WOULD PASS UNDER THE DEFECT, AND IS THEREFORE NOT ASSERTED ALONE. "The gauge appears in
// /metrics" passes against an uncached read, against a read that throws the scrape away on a DB
// blip, and against one series per raw `scheduler_ticks` key. Those three are the actual risks —
// pool exhaustion, losing /metrics during the outage it should report, and unbounded cardinality —
// so each has its own test that fails for that reason and no other:
//   • the QUERY COUNT under a fake reader (not timing, which is unfalsifiable on a fast box),
//   • a reader that throws / never resolves, with the rest of the body still asserted present,
//   • dated keys in the DB, with the SERIES COUNT asserted, not just the value.
//
// No UUID fixtures here on purpose — the ids this file owns are `scheduler_ticks.key` TEXT values,
// all prefixed `MARK` below, so tests/fixture-id-collisions.test.ts (which scans UUID literals) has
// nothing to register. The prefix is what keeps this file from tearing down
// tests/sandbox-watchdog-tick.test.ts's rows, which live in the same table.
//
// REVERT THAT REDS THIS (each independently verified 2026-08-11):
//   • drop the `now - lastAttemptAt < TTL` guard in getSchedulerFreshness → the cache tests red.
//   • change `split_part(key, ':', 1)` to `key` in readSchedulerFreshness → the collapse tests red.
//   • rethrow from refresh()'s catch → the DB-failure tests red.
//   • stop passing the snapshot in routes/metrics.ts (`renderMetrics()`) → the end-to-end test reds.
//   • point readSchedulerFreshness back at `db` instead of `metricsClient` → BOTH §5b tests red.
//   • drop the `SET LOCAL statement_timeout` and keep everything else → the §5b cancel test reds.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { like, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../src/config';
import { db, schedulerTicks } from '../src/db/client';
import { recordHttp, renderMetrics } from '../src/host/metrics';
import {
  READ_FAILURE_COUNTER,
  SCHEDULER_FRESHNESS_READ_TIMEOUT_MS,
  SCHEDULER_FRESHNESS_TTL_MS,
  __resetSchedulerFreshnessCacheForTests,
  __setSchedulerFreshnessReaderForTests,
  getSchedulerFreshness,
  readSchedulerFreshness,
  type SchedulerFreshness,
} from '../src/host/scheduler-freshness';
import { registerMetricsRoutes } from '../src/routes/metrics';
import { Router } from '../src/utils/router';

const MARK = 'zws6sched';
const GAUGE = 'commonpractice_scheduler_last_run_timestamp_seconds';

const router = new Router();
registerMetricsRoutes(router);

async function scrape(): Promise<{ status: number; contentType: string; body: string }> {
  const matched = router.match('GET', '/metrics');
  if (!matched) throw new Error('no route for GET /metrics');
  const res = await matched.handler(new Request('http://localhost/metrics'));
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: await res.text(),
  };
}

async function cleanup() {
  await db.delete(schedulerTicks).where(like(schedulerTicks.key, `${MARK}%`));
}

async function seedTicks(rows: { key: string; at: string }[]) {
  await db
    .insert(schedulerTicks)
    .values(rows.map((r) => ({ key: r.key, last_run_at: new Date(r.at) })));
}

function familiesFor(rows: SchedulerFreshness[], prefix: string): SchedulerFreshness[] {
  return rows.filter((r) => r.scheduler.startsWith(prefix));
}

/** A reader that counts its calls, so the cache can be asserted by QUERY COUNT rather than timing. */
function countingReader(value: SchedulerFreshness[] = []) {
  const state = { calls: 0 };
  __setSchedulerFreshnessReaderForTests(async () => {
    state.calls += 1;
    return value;
  });
  return state;
}

// explicit hook timeouts — bun ignores bunfig's [test] timeout for hooks (see check:hooks).
beforeEach(async () => {
  __setSchedulerFreshnessReaderForTests();
  __resetSchedulerFreshnessCacheForTests();
  await cleanup();
}, 30_000);
afterAll(async () => {
  __setSchedulerFreshnessReaderForTests();
  __resetSchedulerFreshnessCacheForTests();
  await cleanup();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. Exposition shape — name, TYPE, label. Pure, no DB.
// ---------------------------------------------------------------------------

test('renders as a GAUGE, one series per scheduler, labelled `scheduler`', () => {
  const out = renderMetrics([
    { scheduler: 'cycle', lastRunAtSeconds: 1786503600 },
    { scheduler: 'audit_export', lastRunAtSeconds: 1786492800.5 },
  ]);

  expect(out).toContain(`# TYPE ${GAUGE} gauge`);
  expect(out).toContain(`# HELP ${GAUGE} `);
  expect(out).toContain(`${GAUGE}{scheduler="cycle"} 1786503600`);
  expect(out).toContain(`${GAUGE}{scheduler="audit_export"} 1786492800.5`);
  // Not a counter, and not accidentally suffixed into one.
  expect(out).not.toContain(`# TYPE ${GAUGE} counter`);
});

test('NO snapshot renders NO gauge line — a fabricated 0 is a 1970 timestamp that fires the alert on every cold start', () => {
  // `renderMetrics()` with no argument is the pre-existing signature every other caller uses.
  expect(renderMetrics()).not.toContain(GAUGE);
  expect(renderMetrics([])).not.toContain(GAUGE);
  // …and the rest of the registry is unaffected by the absence.
  recordHttp('GET', '/zws6-shape-probe', 200, 0.01);
  expect(renderMetrics()).toContain(
    'commonpractice_http_requests_total{method="GET",route="/zws6-shape-probe",status="2xx"}',
  );
});

test('a label value with a quote or backslash is escaped, not emitted raw', () => {
  const out = renderMetrics([{ scheduler: 'we"ird\\key', lastRunAtSeconds: 1 }]);
  expect(out).toContain(`${GAUGE}{scheduler="we\\"ird\\\\key"} 1`);
});

// ---------------------------------------------------------------------------
// 2. The value is the row's `last_run_at`, in unix seconds. Real DB.
// ---------------------------------------------------------------------------

test('the value equals the scheduler_ticks row last_run_at, in unix seconds', async () => {
  const at = '2026-08-11T03:00:00.123Z';
  await seedTicks([{ key: `${MARK}solo`, at }]);

  const rows = await readSchedulerFreshness();
  const mine = familiesFor(rows, `${MARK}solo`);

  expect(mine).toHaveLength(1);
  expect(mine[0]!.lastRunAtSeconds).toBe(new Date(at).getTime() / 1000);

  // …and that exact number reaches the exposition, unrounded.
  expect(renderMetrics(mine)).toContain(
    `${GAUGE}{scheduler="${MARK}solo"} ${new Date(at).getTime() / 1000}`,
  );
}, 30_000);

// ---------------------------------------------------------------------------
// 3. Dated-key collapse — the cardinality guard. Real DB.
// ---------------------------------------------------------------------------

test('dated claim keys collapse to ONE series per family, carrying the NEWEST timestamp', async () => {
  const newest = '2026-08-11T03:00:00.000Z';
  await seedTicks([
    // The legacy bare key, deliberately the STALEST — prod's real `cycle` row reads
    // 2026-08-09T20:48Z, from before per-day keys landed. `max` must mask it, not inherit it.
    { key: `${MARK}fam`, at: '2026-08-09T20:48:09.000Z' },
    { key: `${MARK}fam:2026-08-10`, at: '2026-08-10T11:53:12.000Z' },
    { key: `${MARK}fam:2026-08-11`, at: newest },
  ]);

  const mine = familiesFor(await readSchedulerFreshness(), `${MARK}fam`);

  // ONE series for three rows. Without the collapse this is 3 — and grows by ~2/day forever.
  expect(mine).toHaveLength(1);
  expect(mine[0]!.scheduler).toBe(`${MARK}fam`);
  expect(mine[0]!.lastRunAtSeconds).toBe(new Date(newest).getTime() / 1000);

  // The dated keys must not survive anywhere in the exposition as labels of their own.
  const body = renderMetrics(mine);
  expect(body).not.toContain(`${MARK}fam:2026-08-10`);
  expect(body).not.toContain(`${MARK}fam:2026-08-11`);
}, 30_000);

test('distinct families stay distinct — the collapse merges dates, not schedulers', async () => {
  await seedTicks([
    { key: `${MARK}a:2026-08-11`, at: '2026-08-11T01:00:00.000Z' },
    { key: `${MARK}b`, at: '2026-08-11T02:00:00.000Z' },
  ]);

  const mine = familiesFor(await readSchedulerFreshness(), MARK).map((r) => r.scheduler).sort();
  expect(mine).toEqual([`${MARK}a`, `${MARK}b`]);
}, 30_000);

// ---------------------------------------------------------------------------
// 4. The cache — asserted by QUERY COUNT, never by elapsed time.
// ---------------------------------------------------------------------------

test('the TTL floor is at least 30s — a lower one re-creates the scrape storm this cache exists to prevent', () => {
  expect(SCHEDULER_FRESHNESS_TTL_MS).toBeGreaterThanOrEqual(30_000);
});

test('repeated scrapes inside the TTL issue exactly ONE query', async () => {
  const r = countingReader([{ scheduler: 'cycle', lastRunAtSeconds: 1 }]);
  const t0 = 1_000_000;

  expect(await getSchedulerFreshness(t0)).toEqual([{ scheduler: 'cycle', lastRunAtSeconds: 1 }]);
  await getSchedulerFreshness(t0 + 1);
  await getSchedulerFreshness(t0 + 15_000);
  await getSchedulerFreshness(t0 + SCHEDULER_FRESHNESS_TTL_MS - 1);

  expect(r.calls).toBe(1);

  // …and the TTL boundary does allow the next one through (otherwise this would pass on a cache
  // that never refreshes, which is a different and equally silent bug).
  await getSchedulerFreshness(t0 + SCHEDULER_FRESHNESS_TTL_MS);
  expect(r.calls).toBe(2);
});

test('steady state at a 15s scrape interval is ONE query per TTL per pod, not one per scrape', async () => {
  const r = countingReader();
  const t0 = 2_000_000;
  const TEN_MINUTES = 10 * 60_000;

  for (let elapsed = 0; elapsed < TEN_MINUTES; elapsed += 15_000) {
    await getSchedulerFreshness(t0 + elapsed);
  }

  // 40 scrapes in ten minutes. Uncached that is 40 queries per pod (160 at 4 replicas).
  expect(r.calls).toBe(TEN_MINUTES / SCHEDULER_FRESHNESS_TTL_MS);
  expect(r.calls).toBe(10);
});

// ⛔ THIS TEST USED TO BE CALLED "CONCURRENT scrapes collapse into a single in-flight query" AND
// NAMED A MECHANISM IT DID NOT EXERCISE. There was an `inFlight` promise in getSchedulerFreshness
// and this test was its only justification — but `lastAttemptAt` is stamped SYNCHRONOUSLY before
// the await, so callers #1..#7 return at the TTL guard and the `await inFlight` line is
// unreachable. Deleting the whole `inFlight` block left the suite at 15 pass / 0 fail: the test
// passed for a reason unrelated to its name, which is worse than no test, because it certified a
// mechanism as working while it was dead code. The mechanism is gone; the BEHAVIOUR is real, and
// this is what it actually is. See the note on getSchedulerFreshness for why reinstating a
// reachable single-flight (stamping the clock after the read) would be a regression.
test('CONCURRENT scrapes do not queue behind the read: one query, and only the FIRST caller waits', async () => {
  const READ_MS = 120;
  let calls = 0;
  __setSchedulerFreshnessReaderForTests(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, READ_MS));
    return [{ scheduler: 'cycle', lastRunAtSeconds: 1 }];
  });
  const t0 = 3_000_000;

  const started = Date.now();
  const elapsed = await Promise.all(
    Array.from({ length: 8 }, async () => {
      await getSchedulerFreshness(t0);
      return Date.now() - started;
    }),
  );

  // ONE query for eight simultaneous scrapes — the property the endpoint needs.
  expect(calls).toBe(1);
  // …and it is the TTL guard that delivers it, not a shared promise: the seven late callers do NOT
  // wait for the read, they return the (still empty) cache immediately. A single-flight
  // implementation would make all eight take >= READ_MS, so this assertion is what tells the two
  // apart — and it is the behaviour we want, since a scrape must never block on a slow DB.
  expect(elapsed[0]).toBeGreaterThanOrEqual(READ_MS - 20);
  for (const e of elapsed.slice(1)) expect(e).toBeLessThan(READ_MS / 2);
});

// ---------------------------------------------------------------------------
// 5. A DB failure must not cost us /metrics — the endpoint that reports the outage.
// ---------------------------------------------------------------------------

test('a read that THROWS does not throw out of getSchedulerFreshness, and serves the last known values', async () => {
  const good: SchedulerFreshness[] = [{ scheduler: 'cycle', lastRunAtSeconds: 1786503600 }];
  const t0 = 4_000_000;

  __setSchedulerFreshnessReaderForTests(async () => good);
  expect(await getSchedulerFreshness(t0)).toEqual(good);

  __setSchedulerFreshnessReaderForTests(async () => {
    throw new Error('ECONNREFUSED — pgbouncer pool exhausted');
  });
  // Resolves (does not reject) and still carries the values from before the outage: they are not
  // stale lies, they describe ticks that genuinely happened.
  expect(await getSchedulerFreshness(t0 + SCHEDULER_FRESHNESS_TTL_MS)).toEqual(good);

  // The failure is itself visible rather than swallowed.
  expect(renderMetrics()).toContain(`commonpractice_${READ_FAILURE_COUNTER}`);
});

test('a failing read does NOT raise the query rate — the TTL clock is stamped on attempt, not success', async () => {
  let calls = 0;
  __setSchedulerFreshnessReaderForTests(async () => {
    calls += 1;
    throw new Error('db down');
  });
  const t0 = 5_000_000;

  // Every 15s scrape strictly INSIDE one TTL window (0/15/30/45s — 60s is the next window and is
  // supposed to retry).
  for (let elapsed = 0; elapsed < SCHEDULER_FRESHNESS_TTL_MS; elapsed += 15_000) {
    expect(await getSchedulerFreshness(t0 + elapsed)).toBeUndefined();
  }

  // 4 scrapes against a dead DB → 1 attempt, not 4. A retry-per-scrape would hammer a database
  // that is already the thing failing. (`cached` stays `undefined`, so this is also the proof that
  // the TTL is driven by the ATTEMPT clock and not by "do we have a value yet".)
  expect(calls).toBe(1);
});

test('a read that HANGS is abandoned at the timeout instead of holding the scrape open', async () => {
  __setSchedulerFreshnessReaderForTests(() => new Promise<SchedulerFreshness[]>(() => {}));

  const started = Date.now();
  expect(await getSchedulerFreshness(6_000_000)).toBeUndefined();
  const elapsed = Date.now() - started;

  expect(elapsed).toBeGreaterThanOrEqual(SCHEDULER_FRESHNESS_READ_TIMEOUT_MS - 50);
  // A scrape_timeout kill would return NO series at all, including the http ones that show the
  // outage — so the ceiling matters as much as the fact that it returns.
  expect(elapsed).toBeLessThan(SCHEDULER_FRESHNESS_READ_TIMEOUT_MS + 2_000);
}, 30_000);

test('GET /metrics still answers 200 with the rest of the body when the freshness read fails', async () => {
  recordHttp('GET', '/zws6-outage-probe', 200, 0.02);
  __setSchedulerFreshnessReaderForTests(async () => {
    throw new Error('server conn crashed?');
  });
  __resetSchedulerFreshnessCacheForTests();

  const res = await scrape();

  expect(res.status).toBe(200);
  // The gauge is absent…
  expect(res.body).not.toContain(GAUGE);
  // …and NOTHING else is. This is the assertion that separates "degrades" from "breaks".
  expect(res.body).toContain('# TYPE commonpractice_http_request_duration_seconds histogram');
  expect(res.body).toContain(
    'commonpractice_http_requests_total{method="GET",route="/zws6-outage-probe",status="2xx"}',
  );
}, 30_000);

// ---------------------------------------------------------------------------
// 5b. A stalled read must RELEASE ITS CONNECTION. Real query, real lock, real backends.
//
// ⛔ EVERY TEST ABOVE THAT TOUCHES THE TIMEOUT USES A FAKE READER THAT NEVER RESOLVES, AND THAT IS
// WHY THEY ALL PASSED AGAINST THE DEFECT. A promise that never settles has no connection behind it,
// so "the scrape returns in 2s" was asserted while the thing that makes it dangerous — the QUERY,
// which `Promise.race` cannot cancel and postgres-js gives no AbortSignal for — was never present.
// The two tests below stall a GENUINE query (an ACCESS EXCLUSIVE lock on `scheduler_ticks` held by
// a second session, i.e. exactly what a migration or a `VACUUM FULL` does) and assert on
// `pg_stat_activity`, which is the only place the difference is visible.
//
// REVERT THAT REDS THESE (verified 2026-08-11, red before / green after):
//   • point readSchedulerFreshness back at `db.execute(...)` → BOTH red: the abandoned query holds
//     a `cp-query` connection, six scrapes take all six, and `SELECT 1` never gets one.
//   • keep `metricsClient` but drop the `SET LOCAL statement_timeout` → the second one reds: the
//     backend is still running when the scrape has already returned.
// ---------------------------------------------------------------------------

/** A separate connection — it must NOT come from any pool under test, or it would be the thing
 *  that starves. `max: 2`: one to hold the lock, one to observe while it is held. */
const observer = postgres(config.database.url, { max: 2, onnotice: () => {} });
afterAll(async () => {
  await observer.end({ timeout: 5 });
}, 30_000);

/** Backends this process owns that are BUSY. `state <> 'idle'` is the documented way to attribute
 *  by `application_name` (db/client.ts): an idle pooled connection may still carry a stale name. */
async function busyOwnBackends(): Promise<number> {
  const rows = await observer<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE application_name LIKE 'cp-%'
       AND state <> 'idle'
       AND pid <> pg_backend_pid()`;
  return rows[0]!.n;
}

/** Run `fn` while `scheduler_ticks` is held under ACCESS EXCLUSIVE by another session. */
async function underTableLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const lock = observer.begin(async (tx) => {
    await tx`LOCK TABLE scheduler_ticks IN ACCESS EXCLUSIVE MODE`;
    await held;
  });
  // Give the LOCK statement time to actually be granted before the reads start.
  await new Promise((r) => setTimeout(r, 300));
  try {
    return await fn();
  } finally {
    release();
    await lock;
  }
}

test('a stalled read is CANCELLED server-side, not merely abandoned — no backend of ours is left running', async () => {
  __setSchedulerFreshnessReaderForTests(); // the real query, not a fake
  const baseline = await busyOwnBackends();

  await underTableLock(async () => {
    __resetSchedulerFreshnessCacheForTests();
    const t0 = Date.now();
    expect(await getSchedulerFreshness()).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(SCHEDULER_FRESHNESS_READ_TIMEOUT_MS + 1_000);

    // The scrape has returned. Within a short grace period the QUERY must be gone too. Under the
    // defect this never drops — the backend sits waiting on the lock for as long as the lock is
    // held, and `Promise.race` has already told the caller everything is fine.
    let busy = await busyOwnBackends();
    for (let i = 0; i < 20 && busy > baseline; i++) {
      await new Promise((r) => setTimeout(r, 100));
      busy = await busyOwnBackends();
    }
    // `<=`, not `===`: the baseline is a snapshot of whatever else the suite left mid-flight, and
    // one of those finishing during the poll must not red this. The defect direction is strictly
    // upward — a stalled read ADDS a backend that never goes away — so `<=` is exactly the claim.
    expect(busy).toBeLessThanOrEqual(baseline);
  });
}, 30_000);

test('six stalled scrapes do NOT consume the request pool — an ordinary query still gets a connection', async () => {
  __setSchedulerFreshnessReaderForTests();
  const POOL_MAX = config.database.poolMax;

  await underTableLock(async () => {
    // Exactly the prod shape: one scrape per request-pool slot. Under the defect each one parks a
    // `cp-query` connection it can never get back, and the sixth leaves the pod with zero.
    for (let i = 0; i < POOL_MAX; i++) {
      __resetSchedulerFreshnessCacheForTests();
      expect(await getSchedulerFreshness()).toBeUndefined();
    }

    // THE ASSERTION THAT MATTERS. `/metrics` exists to observe pool exhaustion; it must not cause
    // it. postgres-js QUEUES on a full pool — it does not fail fast — so under the defect this
    // never resolves and ordinary tenant requests hang indefinitely behind it.
    const probe = db.execute(sql`SELECT 1`);
    const outcome = await Promise.race([
      probe.then(() => 'served'),
      new Promise<string>((r) => setTimeout(() => r('POOL STARVED — no connection after 3s'), 3_000)),
    ]);
    expect(outcome).toBe('served');
  });
}, 30_000);

// ---------------------------------------------------------------------------
// 6. End to end through the real route + the real DB read.
// ---------------------------------------------------------------------------

test('GET /metrics exposes the gauge from real scheduler_ticks rows, collapsed', async () => {
  const newest = '2026-08-11T03:00:00.000Z';
  await seedTicks([
    { key: `${MARK}e2e`, at: '2026-08-09T20:48:09.000Z' },
    { key: `${MARK}e2e:2026-08-11`, at: newest },
  ]);
  __setSchedulerFreshnessReaderForTests(); // real DB read
  __resetSchedulerFreshnessCacheForTests();

  const res = await scrape();

  expect(res.status).toBe(200);
  // The exposition content-type survived the move out of server.ts — Prometheus rejects the body
  // otherwise, and the route now lives in a different file than it did.
  expect(res.contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  expect(res.body).toContain(`# TYPE ${GAUGE} gauge`);
  expect(res.body).toContain(
    `${GAUGE}{scheduler="${MARK}e2e"} ${new Date(newest).getTime() / 1000}`,
  );

  const mySeries = res.body
    .split('\n')
    .filter((l) => l.startsWith(`${GAUGE}{`) && l.includes(`scheduler="${MARK}`));
  expect(mySeries).toHaveLength(1);
}, 30_000);
