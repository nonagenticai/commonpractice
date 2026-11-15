// tests/metrics-counter-preseed.test.ts — the alert-visibility contract for the generic counters
// in host/metrics.ts: an alerted counter's series must EXIST AT 0 before the thing it counts has
// ever happened.
//
// THE DEFECT this pins. `incCounter` is Map-backed and lazy and `renderMetrics` iterates that Map,
// so an unbumped counter has no series and its first bump makes the series appear ALREADY HOLDING
// 1. `increase()`/`rate()` need two samples inside the window and treat the first one they find as
// the base, so an absent -> 1 rise evaluates to 0. Every rule of the shape
// `sum(increase(<counter>[15m])) > 0` is therefore blind to the FIRST event of every pod process,
// and every rollout re-arms that blind spot on every replica.
//
// Proven in production, not inferred: on 2026-08-11
// `commonpractice_scheduler_freshness_read_failures_total` read 1 on one pod (a genuine
// intermittent at 12:37:34Z) while `increase(…[15m])`, `[6h]` and `[24h]` all returned 0 — so
// `CommonPracticeSchedulerFreshnessReadFailures` never fired for the one event it exists to catch.
//
// ⛔ WHY A FRESH MODULE INSTANCE RATHER THAN AN ASSERTION ON THE SHARED ONE. `bun test` shares the
// module registry across every file in a run, and three other files (`metrics.test.ts`,
// `scheduler-freshness.test.ts`, `license-states-batch.test.ts`) legitimately bump counters. An
// assertion that the shared registry reads 0 would therefore pass or fail on FILE ORDER, which is
// the one thing a regression guard may not depend on. A cache-busted dynamic import gives this file
// a module instance whose state no other test can have touched, so "0 before any increment" is
// decided by the module's own load-time behaviour and nothing else.
import { test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  incCounter,
  renderMetrics,
  setGauge,
  PRESEEDED_COUNTERS,
  PRESEEDED_LABELLED_COUNTERS,
  PRESEEDED_GAUGES,
} from '../src/host/metrics';
import {
  OUTBOX_PENDING_GAUGE,
  OUTBOX_OLDEST_PENDING_AGE_GAUGE,
} from '../src/host/metering-outbox-drainer';
import {
  EMIT_SUCCESS_COUNTER,
  EMIT_DROPPED_COUNTER,
  EMIT_DROP_REASONS,
} from '../src/host/metering-emit';
import { READ_FAILURE_COUNTER } from '../src/host/scheduler-freshness';
import { ORPHAN_ACTOR_COUNTER } from '../src/host/audit-service';
import { ONBOARDING_INTEGRITY_READ_FAILURE_COUNTER } from '../src/host/onboarding-integrity';
import { LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER } from '../src/services/license-provisioning';

type MetricsModule = {
  incCounter: typeof incCounter;
  renderMetrics: typeof renderMetrics;
  setGauge: typeof setGauge;
  PRESEEDED_COUNTERS: typeof PRESEEDED_COUNTERS;
  PRESEEDED_LABELLED_COUNTERS: typeof PRESEEDED_LABELLED_COUNTERS;
  PRESEEDED_GAUGES: typeof PRESEEDED_GAUGES;
};

const METRICS_PATH = fileURLToPath(new URL('../src/host/metrics.ts', import.meta.url));

/**
 * A module instance with load-time state and nothing else.
 *
 * ⚠️ THE SPECIFIER SHAPE IS LOAD-BEARING: an absolute PATH plus a query string. A `file://` URL
 * carrying the same query is normalized by bun's resolver and returns the SHARED instance — the
 * first draft of this file used that form and the isolation test below caught it. Do not "tidy"
 * this into `new URL(...).href`.
 */
async function freshMetrics(tag: string): Promise<MetricsModule> {
  return (await import(`${METRICS_PATH}?preseed-probe=${tag}`)) as MetricsModule;
}

/** The rendered value of `commonpractice_<name>`, or `undefined` if the series is absent. */
function seriesValue(out: string, name: string): number | undefined {
  const m = new RegExp(String.raw`^commonpractice_${name} (\d+)$`, 'm').exec(out);
  return m ? Number(m[1]) : undefined;
}

test('the cache-bust actually isolates — otherwise every assertion below is vacuous', async () => {
  // If `bun` ever starts serving the same instance for a different query string, this reds LOUDLY
  // instead of letting the rest of the file pass on state some other test file happened to leave.
  incCounter('preseed_isolation_probe_total');
  expect(seriesValue(renderMetrics(), 'preseed_isolation_probe_total')).toBe(1);

  const fresh = await freshMetrics('isolation');
  expect(seriesValue(fresh.renderMetrics(), 'preseed_isolation_probe_total')).toBeUndefined();
});

test('every alerted counter renders at 0 on a pod that has never bumped it', async () => {
  const fresh = await freshMetrics('at-zero');
  const out = fresh.renderMetrics();

  // `toEqual` over the whole roster, not a loop of single asserts: a failure names EVERY counter
  // that lost its registration, not just the first.
  const rendered = Object.fromEntries(
    fresh.PRESEEDED_COUNTERS.map((n) => [n, seriesValue(out, n)]),
  );
  const expected = Object.fromEntries(fresh.PRESEEDED_COUNTERS.map((n) => [n, 0]));
  expect(rendered).toEqual(expected);

  // The TYPE line has to be there too — a bare sample with no `# TYPE` is not a counter to
  // Prometheus, and `increase()` over an untyped series is undefined behaviour.
  for (const name of fresh.PRESEEDED_COUNTERS) {
    expect(out).toContain(`# TYPE commonpractice_${name} counter`);
  }
});

test('the first bump is a 0 -> 1 RISE, which is what increase() can see', async () => {
  const fresh = await freshMetrics('first-rise');

  // Two consecutive scrapes across one event. Before the fix the first scrape had no series at all
  // and `increase()` had nothing to subtract from; now it has a base.
  const before = seriesValue(fresh.renderMetrics(), READ_FAILURE_COUNTER);
  fresh.incCounter(READ_FAILURE_COUNTER);
  const after = seriesValue(fresh.renderMetrics(), READ_FAILURE_COUNTER);

  expect([before, after]).toEqual([0, 1]);
});

test('the freshness read-failure counter cannot drift out of the registered set', async () => {
  // `READ_FAILURE_COUNTER` lives in host/scheduler-freshness.ts and the registration list lives in
  // host/metrics.ts, which cannot import it (scheduler-freshness imports metrics — the reverse
  // would be a cycle). Renaming the constant without touching the list would silently restore the
  // exact blind spot this file exists for, and every other test would stay green.
  expect([...PRESEEDED_COUNTERS]).toContain(READ_FAILURE_COUNTER);
});

test('the onboarding-integrity read-failure counter cannot drift out of the registered set', async () => {
  // Same drift trap as the freshness constant above: the name lives in host/onboarding-integrity.ts
  // and the list lives here, and metrics.ts cannot import that module (it imports metrics). This
  // counter guards the READ that feeds the unlicensed/stranded gauges — if that read starts failing
  // on a fresh pod and the counter is lazy, `increase()` cannot see the first failure, so the
  // census silently serves its last-known values while looking healthy.
  expect([...PRESEEDED_COUNTERS]).toContain(ONBOARDING_INTEGRITY_READ_FAILURE_COUNTER);
});

test('the unrevoked-orphan-licence counter cannot drift out of the registered set', async () => {
  // Same drift trap, highest stakes of the three: this counter is the ONLY signal that a licence was
  // minted upstream, lost the compare-and-set on the store, and then failed to be revoked. Nothing
  // in this system knows about that licence afterwards — it is not in `tenants`, so offboarding
  // cannot revoke it. With no free tier it bills forever. A lazy series would hide the first one.
  expect([...PRESEEDED_COUNTERS]).toContain(LICENSE_PROVISION_ORPHAN_UNREVOKED_COUNTER);
});

test('the scheduler tick-failure counter is registered, not lazy', async () => {
  // ⛔ WHY THIS ONE MATTERS MOST. `claimTick` already counts a REFUSAL. Until this counter existed,
  // the case where the claimed work THREW was counted nowhere — all seven schedulers only
  // `log.error`-ed it, and gitops rules.yaml records that "loki has no `ruler` stanza, so log-based
  // alerting cannot fire". A DB outage killing every tick for an hour therefore produced ZERO
  // Prometheus series. Lazy registration would half-restore that hole: the first failing tick on a
  // fresh pod — exactly the deploy-time case — would still be invisible to increase().
  //
  // ⚠️ THE GITOPS RULE IS NOT IN THIS REPO. `CommonPracticeSchedulerTickFailing` must be written in
  // gitops-production's rules.yaml; registering at 0 is the half that lands here.
  expect([...PRESEEDED_COUNTERS]).toContain('scheduler_tick_failed_total');

  const fresh = await freshMetrics('tick-failed');
  const before = seriesValue(fresh.renderMetrics(), 'scheduler_tick_failed_total');
  fresh.incCounter('scheduler_tick_failed_total');
  const after = seriesValue(fresh.renderMetrics(), 'scheduler_tick_failed_total');
  expect([before, after]).toEqual([0, 1]);
});

test('a counter no rule reads is still lazy — registration is opt-in, not a policy change', async () => {
  const fresh = await freshMetrics('still-lazy');
  const out = fresh.renderMetrics();

  // `cycle_tick_skipped_total` is diagnostic and nothing alerts on it; `run_rejected_*` names are
  // COMPUTED from an error code at runtime and cannot be enumerated at load. Registering either
  // would add permanent series to every pod for no consumer. If one of these ever gains an
  // increase()/rate() rule in gitops, add it to PRESEEDED_COUNTERS and move it out of this test.
  expect(seriesValue(out, 'cycle_tick_skipped_total')).toBeUndefined();
  expect(seriesValue(out, 'audit_export_tick_skipped_total')).toBeUndefined();
  expect(seriesValue(out, 'jit_seat_denied_total')).toBeUndefined();
});

test('the audit orphan-actor counter is registered, not lazy', async () => {
  // ⛔ `recordAudit`'s FK fallback (host/audit-service.ts) takes the orphan-actor condition OFF
  // `audit_write_failures_total` — which IS pre-seeded and IS alerted (CommonPracticeAuditWriteFailures,
  // `sum(rate(…[5m])) > 0`) — and puts it on `audit_actor_orphan_total`. Its own comment says the two
  // exist "so they can be alerted on differently". A LAZY counter cannot be: the first degraded audit
  // row on a pod is the absent -> 1 rise this whole file documents as invisible to increase()/rate().
  // Without this registration the retry does not split one condition into two alertable ones, it
  // MOVES a paged condition onto an unpageable counter — strictly less visibility than before.
  //
  // ⚠️ THE GITOPS RULE IS NOT IN THIS REPO. `CommonPracticeAuditActorOrphan` still has to be written
  // in gitops-production's rules.yaml; registering the series at 0 is the half that must land here
  // and is the precondition for the rule to be able to fire at all.
  expect([...PRESEEDED_COUNTERS]).toContain(ORPHAN_ACTOR_COUNTER);

  const fresh = await freshMetrics('orphan-actor');
  const before = seriesValue(fresh.renderMetrics(), ORPHAN_ACTOR_COUNTER);
  fresh.incCounter(ORPHAN_ACTOR_COUNTER);
  const after = seriesValue(fresh.renderMetrics(), ORPHAN_ACTOR_COUNTER);
  expect([before, after]).toEqual([0, 1]);
});

// ---- the LABELLED registry (metering cost-event drops) ----
//
// Everything above is about a counter whose series is absent until its first bump. A one-label
// counter has the same defect ONCE PER LABEL VALUE, and it bites harder: an operator reading
// `sum by (reason) (increase(commonpractice_metering_cost_event_dropped_total[15m]))` treats a
// reason that is not in the output as "not this one". If that reason has simply never fired on this
// pod, the series does not exist, the reason is absent from the output, and the operator rules out
// the exact cause they are looking for. Every declared value must therefore render at 0 from load.

test('every declared drop reason renders at 0 on a pod that has never dropped anything', async () => {
  const fresh = await freshMetrics('labelled-at-zero');
  const out = fresh.renderMetrics();

  for (const spec of fresh.PRESEEDED_LABELLED_COUNTERS) {
    // One TYPE line per metric NAME — repeating it per label value is not valid exposition and an
    // untyped series is undefined behaviour for increase().
    const typeLines = out
      .split('\n')
      .filter((l) => l === `# TYPE commonpractice_${spec.name} counter`);
    expect(typeLines).toHaveLength(1);

    const rendered = Object.fromEntries(
      spec.values.map((v) => [
        v,
        new RegExp(
          String.raw`^commonpractice_${spec.name}\{${spec.label}="${v}"\} (\d+)$`,
          'm',
        ).exec(out)?.[1],
      ]),
    );
    expect(rendered).toEqual(Object.fromEntries(spec.values.map((v) => [v, '0'])));
  }
});

test('the metering drop reasons cannot drift out of the registered set', () => {
  // ⛔ SAME DRIFT TRAP AS READ_FAILURE_COUNTER ABOVE, AND THE SAME REASON IT CANNOT BE AVOIDED BY
  // IMPORTING: host/metering-emit.ts imports host/metrics.ts, so metrics.ts cannot import the reason
  // roster back without a cycle. The two lists are therefore hand-mirrored, and a reason added to
  // the emitter but not to the registry is SILENTLY DROPPED by `incLabelledCounter` — no series, no
  // error, and every other test in the suite still green. Asserted in BOTH directions: a stale entry
  // here that no code path can produce is the other half of the same lie, a label value that reads 0
  // forever and tells an operator "not this one".
  const spec = PRESEEDED_LABELLED_COUNTERS.find((s) => s.name === EMIT_DROPPED_COUNTER);
  expect(spec).toBeDefined();
  expect(spec!.label).toBe('reason');
  expect([...spec!.values].sort()).toEqual([...EMIT_DROP_REASONS].sort());
});

test('the metering emitted DENOMINATOR is registered, not lazy', async () => {
  // ⛔ WHY THIS ONE IS NOT OPTIONAL. Production, 2026-09-06: `service_key='commonpractice'` has 0
  // rows and $0.00 in `billing_cost_events`, EVER, with METERING_EMIT_ENABLED="true" live. The
  // question that could not be answered was "is the emitter running at all?" — and a LAZY denominator
  // reproduces that exact ambiguity, because absent and zero are the same picture. Registered at 0,
  // `commonpractice_metering_cost_event_emitted_total == 0` on a pod that has served traffic is a
  // POSITIVE statement: nothing reached the bus.
  expect([...PRESEEDED_COUNTERS]).toContain(EMIT_SUCCESS_COUNTER);

  const fresh = await freshMetrics('metering-emitted');
  const before = seriesValue(fresh.renderMetrics(), EMIT_SUCCESS_COUNTER);
  fresh.incCounter(EMIT_SUCCESS_COUNTER);
  const after = seriesValue(fresh.renderMetrics(), EMIT_SUCCESS_COUNTER);
  expect([before, after]).toEqual([0, 1]);
});

test('an unregistered label value is refused, not silently created', async () => {
  // The cardinality bound, asserted rather than assumed. `incLabelledCounter` ignores a value outside
  // the declared roster; if it ever started creating them on demand, a future caller could put a
  // tenant id or a model name in the `reason` label and nothing would notice until the scrape
  // exploded. The refusal is also why the drift test above has to exist — this is what "silently
  // dropped" looks like from the inside.
  const fresh = (await freshMetrics('labelled-unregistered')) as MetricsModule & {
    incLabelledCounter: (name: string, value: string, by?: number) => void;
  };
  fresh.incLabelledCounter(EMIT_DROPPED_COUNTER, 'not_a_declared_reason');
  expect(fresh.renderMetrics()).not.toContain('not_a_declared_reason');
});

// ---- the GAUGE registry (metering-outbox backlog) ----
//
// ⛔ THE PRE-SEEDING ARGUMENT IS DIFFERENT HERE, AND READING ACROSS FROM THE COUNTERS ABOVE GETS IT
// WRONG. A counter is alerted through `increase()`, which cannot see an absent -> 1 rise; that is the
// defect every test above pins, and it does NOT transfer, because a gauge is alerted with a bare
// comparison (`> N`) which can see a first sample perfectly well.
//
// What transfers is the OTHER half: `max(<gauge>) > N` over an empty group returns EMPTY, not false.
// So the dangerous state for a backlog alert is the series going MISSING while the backlog grows —
// a pod that has never drained, a drainer disabled by `METERING_EMIT_ENABLED`, a replica that never
// won a tick claim. Registered at 0 on every replica from process start, "no drainer has ever run
// here" becomes the readable value 0 and a genuine disappearance means the pod is gone.
//
// ⚠️ AND THE AGGREGATION AN ALERT AUTHOR MUST GET RIGHT: the drainer runs under `claimTick`, so
// exactly ONE pod per tick measures. Idle replicas render their last value (0 if they never led), so
// the only correct expression is `max(...)` — `sum` counts one backlog once per leader change and
// `avg` is dragged to 0 by the followers.

/** A gauge's rendered value. Separate from `seriesValue` above, which is `(\d+)`-only: a gauge may
 *  legitimately render a float or a negative, and a reader that cannot express those would silently
 *  report `undefined` (i.e. "absent") for a series that is present and wrong. */
function gaugeValue(out: string, name: string): number | undefined {
  const m = new RegExp(String.raw`^commonpractice_${name} (-?[\d.]+)$`, 'm').exec(out);
  return m ? Number(m[1]) : undefined;
}

test('every declared gauge renders at 0, with HELP and TYPE, on a pod that has never set one', async () => {
  const fresh = await freshMetrics('gauge-at-zero');
  const out = fresh.renderMetrics();

  const rendered = Object.fromEntries(
    fresh.PRESEEDED_GAUGES.map((g) => [g.name, gaugeValue(out, g.name)]),
  );
  expect(rendered).toEqual(Object.fromEntries(fresh.PRESEEDED_GAUGES.map((g) => [g.name, 0])));

  for (const g of fresh.PRESEEDED_GAUGES) {
    // `gauge`, not `counter` — a backlog rendered as a counter makes `increase()` read a DRAINING
    // queue as a negative rise and Prometheus treat every drop as a counter reset.
    expect(out).toContain(`# TYPE commonpractice_${g.name} gauge`);
    expect(out).toContain(`# HELP commonpractice_${g.name} `);
  }
});

test('setGauge writes the value, and writing 0 is a MEASUREMENT not a no-op', async () => {
  const fresh = await freshMetrics('gauge-set');
  fresh.setGauge(OUTBOX_PENDING_GAUGE, 17);
  expect(gaugeValue(fresh.renderMetrics(), OUTBOX_PENDING_GAUGE)).toBe(17);

  // ⛔ THE ZERO WRITE IS THE POINT. "Nothing pending" is the positive statement that billing is
  // current. A `setGauge` that skipped falsy values (or a drainer that only published a non-zero
  // backlog) would leave the last non-zero reading standing forever and page on a queue that
  // cleared minutes ago.
  fresh.setGauge(OUTBOX_PENDING_GAUGE, 0);
  expect(gaugeValue(fresh.renderMetrics(), OUTBOX_PENDING_GAUGE)).toBe(0);
});

test('⛔ a NaN never replaces a good reading — it would SILENCE the alert, not break it', async () => {
  // `NaN` renders as the literal `NaN`, which Prometheus ingests as a real sample, and every `>`
  // comparison against it is false. So a single bad read would quietly turn a firing backlog alert
  // off. Keeping the last good value degrades to a flat line instead, which is visible.
  const fresh = await freshMetrics('gauge-nan');
  fresh.setGauge(OUTBOX_OLDEST_PENDING_AGE_GAUGE, 900);
  fresh.setGauge(OUTBOX_OLDEST_PENDING_AGE_GAUGE, Number.NaN);
  fresh.setGauge(OUTBOX_OLDEST_PENDING_AGE_GAUGE, Number.POSITIVE_INFINITY);

  const out = fresh.renderMetrics();
  expect(out).not.toContain('NaN');
  expect(gaugeValue(out, OUTBOX_OLDEST_PENDING_AGE_GAUGE)).toBe(900);
});

test('an undeclared gauge name is refused, not silently created', async () => {
  // The same cardinality/pre-seeding bound `incLabelledCounter` enforces: a gauge created on demand
  // is a series no alert knows about and no scrape ever saw at 0, which is exactly what the
  // declaration list exists to prevent.
  const fresh = await freshMetrics('gauge-unregistered');
  fresh.setGauge('not_a_declared_gauge', 5);
  expect(fresh.renderMetrics()).not.toContain('not_a_declared_gauge');
});

test('the outbox backlog gauge names cannot drift out of the registered set', () => {
  // ⛔ SAME DRIFT TRAP AS READ_FAILURE_COUNTER, AND THE SAME REASON IT CANNOT BE CLOSED BY IMPORTING:
  // host/metering-outbox-drainer.ts imports host/metrics.ts, so metrics.ts cannot import the names
  // back without a cycle. Rename a constant in the drainer without touching PRESEEDED_GAUGES and
  // `setGauge` SILENTLY IGNORES every write — no series, no error, and the backlog alert goes blind
  // while this whole file stays green.
  const names = PRESEEDED_GAUGES.map((g) => g.name);
  expect(names).toContain(OUTBOX_PENDING_GAUGE);
  expect(names).toContain(OUTBOX_OLDEST_PENDING_AGE_GAUGE);
});
