// src/host/tick-locks.ts — leader election for the boot schedulers' periodic ticks.
//
// Each scheduler arms its own in-process timer in EVERY pod, so once the deployment runs more than
// one replica an unguarded tick double-fires (double cycle-phase advances, a duplicate audit
// export, double translation LLM spend). `runSystemTick(key, minIntervalMs, fn)` (db/client.ts)
// claims the tick with one atomic statement against `scheduler_ticks` (0051), so exactly one pod
// runs it and the others skip.
//
// This REPLACED numeric `pg_try_advisory_lock` keys, which could never work in prod: the owner pool
// points at the TRANSACTION pooler, where two pods' lock statements can share a server connection
// and Postgres lets a session re-acquire an advisory lock it already holds. Full mechanism, and the
// audit-trail evidence of the double-runs it caused, in migration 0051 and on `runSystemTick`.
//
// The sandbox-watchdog USED to have no entry, and the reasoning was sound as far as it went: its
// sweep is `UPDATE … WHERE status IN(...) AND idle RETURNING id`, which Postgres row-lock-
// serializes — a second pod re-evaluates the WHERE, gets the empty set, and neither double-suspends
// nor double-audits. It is genuinely idempotent without a claim, and that is the same property the
// claim mechanism below relies on.
//
// ⚠️ IT NOW HAS ONE ANYWAY, FOR A REASON THAT IS NOT CORRECTNESS. Row-level idempotence says
// nothing about CONNECTIONS. The watchdog is a 60s `setInterval` in EVERY pod calling `runAsSystem`
// directly, so at 4 HPA replicas it draws from the owner pool 4x every 60s, forever — and the owner
// pool sits on the TRANSACTION pooler, the tighter of CP's two ceilings and the one that has
// already logged a live `08P01 server conn crashed?`.
//
// ⚠️ BE PRECISE ABOUT WHAT THE CLAIM BUYS. It does NOT reduce the number of owner-pool
// ACQUISITIONS: the claim's own `INSERT … ON CONFLICT` runs on `ownerClient` in EVERY pod, before
// any leader is decided, so all replicas still take a connection once per tick. What it removes is
// the BODY — the sweep UPDATE, `getSnapshot()`, and N audit inserts — i.e. how long each connection
// is held and how much it writes. An earlier draft of this comment claimed "a permanent 4x/min
// floor becomes 1x/min"; that was false, and in a change whose whole thesis is that wrong numbers
// in comments caused two mis-sizings it deserved correcting rather than repeating.
// Nothing about the SWEEP's behaviour changes: whichever pod wins does exactly what all
// four used to do, and the ones that skip were doing no useful work.
import { runSystemTick } from '../db/client';
import { incCounter } from './metrics';
import { log } from './logger';

export const TICK_LOCK = {
  cycle: 'cycle',
  auditExport: 'audit_export',
  translation: 'translation',
  /** Idle-sandbox sweep (host/sandbox-service.ts). Claimed for CONNECTION BUDGET, not correctness —
   *  see the note above; the sweep itself is idempotent and was safe unguarded. */
  sandboxSweep: 'sandbox_sweep',
  /** Tenant welcome-budget threshold poll (host/budget-scheduler.ts). Unguarded, two pods would
   *  each raise the same 75/90/100 % notification and send the same email — the threshold claim is
   *  a read-then-write, not an atomic RETURNING, so it is NOT self-serializing like the watchdog. */
  budget: 'budget',
  /** Stale run-lease reconciler (host/run-controller.ts). Lived as a bare string literal at its
   *  call site until 2026-08-10, which made it invisible to this registry — the one place that
   *  exists to answer "which ticks are there, and is any of them mis-keyed?". The `cycle`
   *  starvation below went unnoticed for exactly that kind of reason, so: every tick key lives
   *  here, no exceptions. */
  runLeaseReconciler: 'run-lease-reconciler',
  /** Onboarding-integrity reconciler (host/onboarding-integrity.ts). Repairs tenants whose licence
   *  issuance failed and censuses people stranded without a tenant. The claim exists because the
   *  repair calls an external licences service and two pods would double-issue. */
  onboardingIntegrity: 'onboarding_integrity',
  /** Metering outbox drainer (host/metering-outbox-drainer.ts). Claimed so two pods do not XADD the
   *  same pending rows concurrently — billing would dedup them on `event_key`, but every duplicate
   *  is a wasted stream slot on a MAXLEN-trimmed stream. */
  meteringOutbox: 'metering_outbox',
  /**
   * Daily CP-ledger vs billing-service reconciliation (host/metering-reconcile.ts). Claimed
   * because the tick makes an OUTBOUND call per tenant to billing's per-actor cost API — two pods
   * would double the request volume against a shared service for an answer that is identical, and
   * would publish two disagreeing readings into the same per-pod gauge.
   *
   * ⚠️ USE `meteringReconcileTickKey(day)`, NEVER THIS BARE KEY, at the call site. Its cadence is
   * daily against a 12 h window, which is the `cycle` / `auditExport` shape — see the ⚠️ block on
   * `TICK_MIN_INTERVAL_MS` for why a same-order-of-magnitude window makes a boot tick eat that
   * day's scheduled tick outright. The bare key is here only because the registry is the one place
   * that answers "which ticks exist", and a key that lived only inside a template string would be
   * invisible to it — the exact reason `runLeaseReconciler` was hoisted here in 2026-08.
   */
  meteringReconcile: 'metering_reconcile',
  /**
   * Unverified-signup digest (host/signup-digest-scheduler.ts). ⚠️ HERE THE CLAIM IS THE RATE LIMIT,
   * NOT LEADER ELECTION FOR A FIXED CADENCE: the scheduler polls every 15 min and claims with a
   * window of SIGNUP_DIGEST_INTERVAL_HOURS, so the `scheduler_ticks` row is what guarantees "at most
   * one Telegram digest per N hours" across replicas AND across restarts (an in-process timer would
   * reset on every rollout). The window is therefore deliberately LONGER than the poll period —
   * the opposite of every entry in `TICK_MIN_INTERVAL_MS` — and is not listed there: it comes from
   * env at the call site. The poll only claims when there is something new to report.
   */
  signupDigest: 'signup_digest',
} as const;

/**
 * Per-day tick key for the audit export. UNLIKE the other schedulers above, the export's claim is
 * keyed on the WORK ITEM (the UTC day being archived), not on the scheduler's wall-clock cadence.
 *
 * `runExport` only ever targets one specific day and has no backfill of its own, so a single shared
 * key across the boot catch-up and the daily scheduled run is actively wrong: any successful claim
 * (whichever day it happened to target) blocks the OTHER call for `TICK_MIN_INTERVAL_MS.auditExport`
 * regardless of which day that other call needs — a redeploy's boot catch-up (which exports
 * "yesterday relative to boot") can therefore consume the shared window and starve that night's
 * scheduled run (which exports "yesterday relative to 02:00 UTC", almost always a DIFFERENT day) for
 * up to 12h, silently skipping that day's compliance archive forever (proven live: 2026-07-30 and
 * 2026-08-02 both missing). Keying per day makes the boot catch-up and the scheduled run for the
 * SAME day collide correctly (idempotent — the second claim is correctly refused, `runExport`'s own
 * day-level success guard would have no-opped it anyway) while a claim on day X can never block day
 * X+1. See host/audit-export-scheduler.ts for the bounded backfill this is paired with.
 */
export function auditExportTickKey(date: string): string {
  return `${TICK_LOCK.auditExport}:${date}`;
}

/**
 * Per-UTC-day tick key for the marketplace cycle. Same disease as the audit export above, same
 * cure — but arrived at differently, and the difference is the whole point of this comment.
 *
 * WHAT WENT WRONG WITH THE BARE `'cycle'` KEY. The scheduler fires once a day at
 * `CYCLE_TICK_HOUR_UTC` and ALSO fires an immediate catch-up on every boot (cycle-scheduler.ts).
 * Both claimed the same key under a 12h window against a 24h cadence, so the two are
 * indistinguishable to `scheduler_ticks`: a deploy at 20:48 UTC stamped `last_run_at`, and the
 * 03:00 UTC tick 6h later fell inside the window and was refused. Not once — a deploy landing
 * anywhere in the 15:00–03:00 UTC band starves that night's tick EVERY time. Proven live: cycle
 * 2026-W32 (`closes_at` 2026-08-10T00:00Z) sat unclosed while `scheduler_ticks.cycle` read
 * 2026-08-09T20:48Z and the pod logged `next tick at 2026-08-11T03:00Z` — a ~27h miss with no
 * error, because a refused claim resolves to `undefined` rather than throwing.
 *
 * WHY THE DAY, AND NOT THE WEEK. `auditExportTickKey` keys on the day being archived because
 * `runExport` targets exactly one day. The analogous "work item" for `tickCycles` is NOT one
 * week: a single call opens the current week, back-fills missed ones, and advances EVERY
 * non-closed cycle past any boundary it has crossed (cycle-service.ts). Keying per week would be
 * strictly WORSE than the bug it fixes — the scheduler fires 7× per ISO week, so a week-keyed 12h
 * claim would suppress 6 of those 7 ticks. The unit of work the SCHEDULER actually has is "today's
 * run", so that is what the claim names.
 *
 * WHAT THIS BUYS. A boot catch-up on day D claims `cycle:D` and can never consume day D+1's
 * window. Two callers on the SAME day (a boot catch-up overlapping the scheduled run) still
 * collide onto one winner — correctly, since `tickCycles` is idempotent and the first caller has
 * already advanced everything the second would have.
 */
export function cycleTickKey(date: string): string {
  return `${TICK_LOCK.cycle}:${date}`;
}

/**
 * Per-UTC-day tick key for the metering reconciliation, for the SAME reason as `cycleTickKey` and
 * `auditExportTickKey` above — and it is the third instance of that disease, which is why it is
 * spelled this way from birth rather than after an incident.
 *
 * The reconciler's work item is A DAY: `reconcileMeteringDay(day)` compares one UTC day's totals
 * and nothing else. Its cadence is daily and its claim window is 12 h, i.e. the same order of
 * magnitude — so a bare `metering_reconcile` key would let a deploy's boot catch-up consume the
 * window and starve that night's scheduled run, silently (a refused claim resolves to `undefined`,
 * it does not throw). Keyed per day, a claim on day D can never block day D+1, while a boot
 * catch-up and the scheduled run for the SAME day still collide onto one winner — correctly, since
 * the comparison is a pure read and re-running it produces the same answer.
 */
export function meteringReconcileTickKey(day: string): string {
  return `${TICK_LOCK.meteringReconcile}:${day}`;
}

/**
 * How long a claimed tick stays claimed, in ms.
 *
 * Set BELOW the scheduler's own period, so a legitimate next tick is never suppressed, and far
 * above the spread between replicas firing the same tick — milliseconds in practice; the duplicate
 * audit exports this fixes were ~200 ms apart. Half the period is the rule of thumb used here.
 *
 * The claim is written when the tick STARTS, so a pod that crashes mid-tick blocks that tick for at
 * most one window rather than forever. For this work — all of it idempotent and re-runnable — a
 * skipped tick is the right failure direction.
 *
 * ⚠️ TWO CLAIMS IN THE PARAGRAPH ABOVE WERE FALSE FOR `cycle`, AND THE FALSEHOOD COST ~27h.
 *
 * (1) "Set BELOW the scheduler's own period, so a legitimate next tick is never suppressed" holds
 *     only when the window is ≪ the period. `translation` (2min/5min), `budget` (7min/15min) and
 *     `sandboxSweep` (45s/60s) all satisfy that, so for them an unscheduled boot tick can never eat
 *     a scheduled one. `cycle` and `auditExport` are 12h against a 24h cadence — the SAME order of
 *     magnitude — so one boot tick eats that day's scheduled tick outright. That is why both of
 *     them, and only them, need a per-work-item key (`cycleTickKey` / `auditExportTickKey`) rather
 *     than a bare cadence key. The interval alone cannot save a 12h/24h pair.
 *
 * (2) "a skipped tick is the right failure direction" is true where a miss self-heals on the next
 *     tick minutes later. For `cycle` the next tick is 24h away and the skip is caused by DEPLOYS,
 *     which recur — so the miss compounds instead of healing. Hence: the keys below are only half
 *     the fix; the other half is that every scheduler LOGS AND COUNTS a refused claim.
 *
 * ⚠️ THAT LAST SENTENCE WAS PROSE, AND PROSE DOES NOT HOLD. It used to end "…(see the
 * `result === undefined` branch in each *-scheduler.ts)", and it was FALSE for four of the six
 * ticks at the moment it was written: `translation` discarded the refusal inside a logger that
 * early-returns on a falsy result (so a refused claim and an idle drain were the same silence),
 * `budget` discarded it on both its boot and its scheduled path, and `sandboxSweep` /
 * `runLeaseReconciler` have no `*-scheduler.ts` file at all, so the cross-reference could not even
 * be followed. A convention that is only described is a convention that is only sometimes
 * followed — which is exactly the failure mode ("the only symptom is silence") this paragraph was
 * written about. `claimTick` below now OWNS the branch, and `tests/tick-claim-contract.test.ts`
 * makes calling `runSystemTick` directly from a scheduler a RED TEST rather than a lapse.
 */
export const TICK_MIN_INTERVAL_MS = {
  cycle: 12 * 60 * 60 * 1000, // scheduler fires daily
  auditExport: 12 * 60 * 60 * 1000, // scheduler fires daily
  // ⚠️ THESE TWO ARE CEILINGS, NOT THE WINDOW — read them through `tickClaimWindowMs` below.
  // Their periods are OPERATOR-SETTABLE (`TRANSLATION_INTERVAL_MIN`, default 5;
  // `BUDGET_CHECK_INTERVAL_MIN`, default 15), so a bare constant here is a claim window asserted
  // against a period it cannot see. `TRANSLATION_INTERVAL_MIN=2` makes the 2-min window equal the
  // period and every second tick is refused; `=1` makes it exceed the period and the scheduler runs
  // at a fifth of its configured rate — invisibly, because both scheduled paths pass
  // `refusal:'expected'`, so the refusals log at `info` and read exactly like leader election.
  translation: 2 * 60 * 1000, // ceiling; scheduler fires every TRANSLATION_INTERVAL_MIN (default 5)
  budget: 7 * 60 * 1000, // ceiling; scheduler fires every BUDGET_CHECK_INTERVAL_MIN (default 15)
  // Watchdog fires every 60s. Deliberately only just BELOW that period rather than the usual half:
  // the sweep's job is to suspend sandboxes idle for `autoSuspendIdleMinutes` (minutes, not
  // seconds), so nothing depends on the exact cadence, and a wider window would let a pod whose
  // timer drifted a few ms early suppress the next legitimate sweep on every other pod.
  sandboxSweep: 45 * 1000,
  // Reconciler fires every 15s; same just-below-the-period rule as the watchdog.
  runLeaseReconciler: 14 * 1000,
  // Cadence deliberately identical to `translation` (2m claim / 5m fire, 2m < 5m) so it joins the
  // same polling cadence class in the Prometheus rules with no new cadence reasoning.
  onboardingIntegrity: 2 * 60 * 1000, // scheduler fires every 5 min
  // Drainer fires every 30s (METERING_OUTBOX_INTERVAL_MS); same just-below-the-period rule as the
  // watchdog — a late cost event is only late, and a wider window would skip legitimate drains.
  meteringOutbox: 25 * 1000,
  // Reconciler fires daily. 12 h, matching `cycle` / `auditExport` — and, like both of them, it is
  // ONLY safe because the call site keys per UTC day (`meteringReconcileTickKey`). Read the ⚠️
  // block above before shortening this in the belief that the interval alone protects the tick: a
  // 12 h window against a 24 h cadence cannot, which is the whole point of that block.
  meteringReconcile: 12 * 60 * 60 * 1000,
} as const;

/**
 * The claim window for a tick whose PERIOD IS CONFIGURED AT RUNTIME, not fixed by this registry.
 *
 * ⛔ WHY THIS EXISTS. The invariant every entry in `TICK_MIN_INTERVAL_MS` is written against is
 * "the window is strictly SHORTER than the period". For the daily/fixed ticks the period is a
 * compile-time fact, so a constant can encode it. For `translation` and `budget` it is not:
 * `config.translation.intervalMinutes` (and, before its retirement, the budget poll period) come from env. A constant
 * cannot hold an invariant about a number an operator supplies later — set
 * `TRANSLATION_INTERVAL_MIN=2` and the 2-min constant window refuses every second tick, halving the
 * drain rate with no error, no counter and no warn (the scheduled paths are `refusal:'expected'`).
 *
 * ⛔ THE CALLER'S PERIOD WINS, THE REGISTRY IS A CEILING — the same rule `startRunReconciler`
 * (run-controller.ts) already applies for the same reason, which is why this is that pattern
 * generalised rather than a second mechanism. `ceilingMs` keeps the registry entries LIVE (they
 * still decide the window at the default period, so they are not dead constants) while making them
 * incapable of exceeding the period they are supposed to sit below.
 *
 * Two properties, both pinned by tests/tick-claim-contract.test.ts:
 *   (a) at the DEFAULT period the result is exactly the registry entry — no behaviour change;
 *   (b) at any period >= 1ms the result is strictly below it — including the hostile-but-legal
 *       1-minute floor that `msUntilNextDrain` / `msUntilNextCheck` clamp to.
 *
 * ⚠️ (b) IS NOT UNCONDITIONAL, AND AN EARLIER DRAFT OF THIS COMMENT CLAIMED IT WAS ("at ANY
 * period"). It is false at the edges this function does not defend: `periodMs <= 0` returns 0,
 * which is not strictly below 0, and `NaN` returns `NaN`. Neither is reachable TODAY, but the
 * reason lives in ANOTHER FILE — `msUntilNextDrain` / `msUntilNextCheck` both clamp
 * `Math.max(1, minutes) * 60_000`, so this helper never sees a period under 60 000. Verified
 * against `int()`, which does accept `0` / `-1` / `0.9` as-is (only garbage falls back to the
 * default), so without those clamps `TRANSLATION_INTERVAL_MIN=0` WOULD reach here.
 * ⇒ A THIRD CALLER MUST CLAMP ITS OWN PERIOD. Do not read (b) as a guarantee this function makes
 * on its own; it is a guarantee its two current callers make on its behalf.
 * The `periodMs / 2` branch only matters for a period so short that "one second below" is not below
 * at all; a window of 0 (or near it) is the SAFE direction — it degrades to no leader election, not
 * to a suppressed scheduler.
 */
export function tickClaimWindowMs(periodMs: number, ceilingMs: number): number {
  const belowPeriod = periodMs > 2_000 ? periodMs - 1_000 : Math.floor(periodMs / 2);
  return Math.max(0, Math.min(ceilingMs, belowPeriod));
}

/**
 * THE ONE PLACE A REFUSED TICK CLAIM IS HANDLED. Every scheduler goes through here; nothing outside
 * this file and `db/client.ts` may name `runSystemTick` (pinned by tests/tick-claim-contract.test.ts).
 *
 * ⛔ WHY A WRAPPER AND NOT A CONVENTION. `runSystemTick` RESOLVES to `undefined` when another caller
 * holds the window — it does not throw — so `.catch()` never fires and a call site that only wires
 * up `.catch()` discards the refusal in complete silence. That silence cost ~27h of unclosed
 * marketplace cycle (2026-08-09/10) whose only trace anywhere was the next `[cycle] next tick at …`
 * line naming a day later than expected. The fix at the time added the missing branch to two
 * schedulers and a comment claiming all of them had it. Four did not. Ownership beats convention:
 * a refusal is now impossible to drop without deleting this function.
 *
 * `minIntervalMs` is a PARAMETER rather than a lookup in `TICK_MIN_INTERVAL_MS` because
 * `startRunReconciler` is parameterised (tests pass a short interval) and must be able to narrow the
 * claim window below the registry default — a caller-supplied period that is shorter than the claim
 * window would suppress every tick after the first.
 *
 * `skipCounter` is NULLABLE, and that is not laziness — it encodes cycle-scheduler's deliberate
 * boot-vs-scheduled asymmetry. A boot catch-up colliding with the same day's already-run tick is
 * HEALTHY and happens on every deploy; counting it would page on every rollout and the counter
 * would be muted within a week. `incCounter` takes no labels, so the log line's label cannot
 * separate the two at the metric — only the call site can. Passing `null` still LOGS.
 *
 * ⛔ AND `refusal` EXISTS FOR THE SAME REASON ONE LEVEL DOWN — SEE ITS DOC BELOW. A `warn` on every
 * refusal of a sub-minute tick is not a signal, it is 7k–22k lines a day, and this function's own
 * rationale ("a counter that ticks 3x/min at 4 replicas measures the replica count, not a fault")
 * applies just as exactly to a log line.
 */
/**
 * Counter bumped when a CLAIMED tick's `run()` throws — i.e. the work itself failed, as opposed to
 * a refused claim (already counted per-call-site via `skipCounter`) or a tick that was never
 * claimed (never invokes `run()` at all, see `wrappedRun` below).
 *
 * ⛔ WHY THIS EXISTS: every one of the seven schedulers' call sites only `log.error`s a thrown
 * failure — cycle-scheduler.ts:86, budget-scheduler.ts:56,84, translation-scheduler.ts:125,144,
 * audit-export-scheduler.ts:104,117, onboarding-integrity.ts:361,378, sandbox-service.ts:234,
 * run-controller.ts:353,563,992 — and per gitops `clusters/strato/services/prometheus/rules.yaml`
 * loki has no `ruler` stanza, so log-based alerting cannot fire on any of them. A DB outage that
 * kills every tick for an hour therefore produces NO Prometheus series and pages nobody.
 *
 * ⚠️ UNLABELLED, DELIBERATELY. `host/metrics.ts`'s `incCounter` is a hand-rolled
 * `Map<string, number>` with no label dimension anywhere in `renderMetrics`'s counter loop (the
 * labelled series there — `scheduler_last_run_timestamp_seconds`, `tenants_unlicensed`, etc. — are
 * hand-built strings bypassing `incCounter` entirely). Inventing a `{scheduler="…"}` syntax on top
 * of a flat map would not render as a Prometheus label; it would render as a literal string inside
 * the metric name's value line and silently fail to parse. Per-scheduler granularity, when needed,
 * comes from the `label` on the `log.error` call each site already makes — this counter only needs
 * to answer "did ANY claimed tick's work fail", which one unlabelled series does.
 *
 * `commonpractice_scheduler_tick_failed_total` must be added to `PRESEEDED_COUNTERS` in
 * `metrics.ts` (owned by another agent) before it is alertable from a fresh pod — a lazy counter's
 * first bump looks like a series born already at 1, and `increase()`/`rate()` see no 0 -> 1 step.
 */
export const TICK_FAILED_COUNTER = 'scheduler_tick_failed_total';

/**
 * Wrap `run` so a THROW is counted before it propagates. Lives INSIDE `claimTick` — one call to
 * `runSystemTick` per invocation — rather than at each of the seven call sites, for the same reason
 * this whole file gives for owning the refusal branch centrally: a wrapper cannot be forgotten by a
 * scheduler added later, whereas seven independent `try { … } catch { incCounter(...); throw; }`
 * blocks (or an eighth one that omits it) can. The counter is bumped, THEN THE ERROR IS RETHROWN
 * UNCHANGED — every call site still does its own `log.error` with its own context, and swallowing
 * here would delete those logs and change behaviour at all seven of them simultaneously.
 *
 * Only wraps the invocation `runSystemTick` actually makes (i.e. only on the winning pod, only when
 * the claim succeeded) — a refused claim never calls `run` at all, so this can never double-count a
 * refusal, and a tick that was never claimed never reaches here.
 *
 * ⛔ EXPORTED FOR THE WORK A SCHEDULER DOES *BEFORE* IT CLAIMS ANYTHING, which `claimTick` cannot
 * see. `audit-export-scheduler.ts` calls `missingExportDays()` at the TOP of its tick, before the
 * first `claimTick`, to decide WHICH days to claim — so a DB failure there throws straight past this
 * wrapper to a call site whose only handling is `log.error`. Per gitops
 * `clusters/strato/services/prometheus/rules.yaml` loki has no `ruler` stanza, so a log line is zero
 * alertable signal; for the COMPLIANCE export — whose own header says a day that never gets exported
 * "must be discoverable, not just absent" — a DB outage killing every night's run was invisible.
 * Wrapping that pre-claim call bumps the same counter. It cannot double-count: the throw aborts the
 * tick before any `claimTick` runs, so the wrapped `run` below is never reached on that path, and a
 * refusal is still never counted here (a refusal does not throw).
 */
export function countFailures<T>(run: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await run();
    } catch (err) {
      incCounter(TICK_FAILED_COUNTER);
      throw err;
    }
  };
}

export async function claimTick<T>(opts: {
  /** `scheduler_ticks.key` to claim. */
  key: string;
  /** Debounce window; set below the scheduler's own period. */
  minIntervalMs: number;
  /** Log prefix identifying the tick AND the caller, e.g. `[cycle] scheduled tick`. */
  label: string;
  /** Counter to bump on a refusal, or `null` to log only. */
  skipCounter: string | null;
  /**
   * How LOUD a refusal is. Default `'notable'` — every refusal WARNs, which is right for a tick
   * that fires minutes or hours apart, where a refusal is rare and means something.
   *
   * ⛔ `'expected'` IS FOR THE TICKS THAT ARE REFUSED BY DESIGN ON EVERY CYCLE.
   * `runLeaseReconciler` fires every 15s and `sandboxSweep` every 60s, on EVERY replica — so on a
   * 2-replica deployment exactly one pod wins and the other is refused 5,760 + 1,440 times a day;
   * at 4 replicas it is 17,280 + 4,320. Both call sites were SILENT before this wrapper existed, so
   * warning on all of them is not "restoring a lost signal", it is manufacturing ~7k–22k WARN lines
   * a day that say nothing except "there is more than one pod". The commit that introduced this
   * function argued, correctly, that noise gets a signal ignored inside a week — and then shipped
   * exactly that.
   *
   * `'expected'` still WARNs the FIRST refusal per label per process, so a fresh pod leaves one
   * visible line proving the leader election is live and reachable in the logs; every subsequent
   * one goes to `console.debug`. Not silence — the failure mode this whole file exists to remove is
   * silence — just not repetition.
   */
  refusal?: 'notable' | 'expected';
  /** The work. Runs as SYSTEM (owner pool) only on the winning pod. */
  run: () => Promise<T>;
}): Promise<T | undefined> {
  const result = await runSystemTick(opts.key, opts.minIntervalMs, countFailures(opts.run));
  if (result === undefined) {
    if (opts.refusal === 'expected' && warnedRefusals.has(opts.label)) {
      // Every refusal after the first for this label: still emitted, at a level nobody pages on.
      //
      // ⛔ `info`, NOT `debug`, AND THAT IS THE WHOLE POINT OF THIS BRANCH. The predecessor here was
      // `console.debug`, which is NOT level-gated — it always reached stdout. `log.debug` IS gated:
      // `LOG_LEVEL` defaults to `info`, so routing these through it would emit NOTHING in
      // production. That is silence, and silence is the exact failure mode this file exists to
      // remove (see the `refusal` doc above). `info` preserves both properties the contract needs:
      // the line is still emitted, and it is still not a level anyone pages on.
      log.info('tick_skipped', { label: opts.label });
    } else {
      warnedRefusals.add(opts.label);
      log.warn('tick_skipped', { label: opts.label });
    }
    if (opts.skipCounter) incCounter(opts.skipCounter);
  }
  return result;
}

/**
 * Labels that have already WARNed a refusal in this process (only consulted for `refusal:
 * 'expected'`). Process-local and unbounded by design: `label` is a compile-time constant at every
 * one of the six call sites except `audit-export`, whose label carries a date and which is
 * `'notable'` anyway — so this set holds at most a handful of entries for a pod's whole life.
 */
const warnedRefusals = new Set<string>();
