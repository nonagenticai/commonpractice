// src/host/metering-reconcile.ts — does billing agree with our own ledger?
//
// ⛔ WHY THIS EXISTS. CP writes one `usage_events` row per brokered LLM call (the authoritative
// local ledger) and, in the SAME transaction, one `metering_outbox` row which
// `host/metering-outbox-drainer.ts` XADDs onto `billing:costs`. After that the money leaves this
// repo: billing prices it, attributes it to a licences Subject, and puts it on an invoice. Nothing
// has ever checked that what arrived is what we sent.
//
// That gap is not theoretical, and the estate has already been burned by both directions of it:
//   • UNDER-COUNTING — measured 2026-09-06, `service_key='commonpractice'` had **0 rows and $0.00
//     in `billing_cost_events`, ever**, while `METERING_EMIT_ENABLED` was live and the Redis secret
//     was populated. Every local screen looked perfect. The only symptom was an absence in another
//     database that nobody in this repo could see.
//   • MIS-ATTRIBUTION — before migration 0090 the emit sent `users.id` where billing expected the
//     licences Subject uuid, so 100 % of this service's central spend landed
//     `attribution_status='unlicensed'`. Again: locally invisible, and the TOTAL was right, so any
//     check that compared only totals would have passed. This is why the comparison below is
//     PER-ACTOR and not per-tenant.
//
// ⛔ THIS TICK REPAIRS NOTHING AND WRITES NOTHING. It is a measurement. A reconciler that
// "corrected" a disagreement would be inventing spend in one of the two systems, and the one thing
// worse than two ledgers that disagree is two ledgers that agree because one was overwritten to
// match the other. The output is a gauge, a log line and a return value.
//
// ⚠️ IT COMPARES **SETTLED** ROWS ONLY — see `SETTLED_ONLY` below. That is the single decision that
// separates a useful signal from a daily false alarm.
import { sql } from 'drizzle-orm';
import { db, runAsSystem } from '../db/client';
import { config } from '../config';
import {
  claimTick,
  meteringReconcileTickKey,
  TICK_MIN_INTERVAL_MS,
  tickClaimWindowMs,
} from './tick-locks';
import { setGauge } from './metrics';
import { billingAdmin, billingAdminConfigured } from '../services/billing-admin';
import { log } from './logger';
// The shared fixed-hour helper. cycle-scheduler owns it; importing beats a third copy
// (audit-export already carries the second) and the DST/UTC logic stays in one place.
import { msUntilNextTick } from './cycle-scheduler';

/**
 * ⛔ ALL FOUR OF THESE ARE INERT UNTIL SOMEBODY ADDS THEM TO `PRESEEDED_GAUGES` IN
 * `host/metrics.ts`, AND THAT FILE IS OWNED BY ANOTHER CHANGE IN FLIGHT ON THIS BRANCH.
 *
 * `setGauge` SILENTLY IGNORES a name outside `PRESEEDED_GAUGES` — deliberately, and its own
 * docblock explains why (a gauge created on demand is a series no alert knows about and no scrape
 * ever saw at 0). The consequence here is that every `setGauge` call below is a no-op today: the
 * call sites are correct and wired, and they publish nothing. ⚠️ DO NOT READ A GREEN /metrics AS
 * AGREEMENT — there is no series at all until the four names below are declared there. That is
 * exactly the "inert gauge" failure this repo has shipped before, so it is stated here at the
 * declaration rather than left for a scrape to not-show.
 *
 * Suggested HELP text for whoever registers them:
 *   metering_reconcile_mismatch_usd
 *     "Absolute USD difference between CP's settled usage_events and billing's per-actor totals
 *      for the reconciled UTC day, summed over every actor on every tenant compared."
 *   metering_reconcile_actors_mismatched
 *     "Actors whose CP total and billing total differ by more than the ledger's own precision."
 *   metering_reconcile_tenants_compared
 *     "Tenants whose day was actually compared — the DENOMINATOR. A mismatch of 0 means nothing
 *      without it."
 *   metering_reconcile_tenants_unavailable
 *     "Tenants whose billing read failed, so their day was NOT compared."
 *
 * ⛔ AND THE ALERT MUST READ ALL FOUR, NOT JUST THE FIRST. `mismatch_usd == 0` is the value this
 * gauge holds when everything agrees AND the value it holds when zero tenants were compared —
 * a billing outage, a disabled flag, a pod that never won a claim. On its own it is a gate that
 * cannot fail. `tenants_compared` is what makes the zero mean something, and
 * `tenants_unavailable` is what distinguishes "nothing to compare" from "could not compare".
 * TODO(gitops-production): `CommonPracticeMeteringLedgerDrift`,
 *   `max(commonpractice_metering_reconcile_mismatch_usd) > 1
 *    and max(commonpractice_metering_reconcile_tenants_compared) > 0`
 * plus a separate `…_tenants_unavailable > 0` rule — they are different repairs.
 *
 * ⚠️ PER-POD STATE FOR A CLUSTER-WIDE FACT, exactly like the outbox gauges: the tick runs under
 * `claimTick`, so only ONE pod measures and every other replica renders its last value (0 on a pod
 * that has never won a claim). The only correct aggregation is `max(...)`, never `sum` and never
 * `avg`.
 */
export const RECONCILE_MISMATCH_USD_GAUGE = 'metering_reconcile_mismatch_usd';
export const RECONCILE_ACTORS_MISMATCHED_GAUGE = 'metering_reconcile_actors_mismatched';
export const RECONCILE_TENANTS_COMPARED_GAUGE = 'metering_reconcile_tenants_compared';
export const RECONCILE_TENANTS_UNAVAILABLE_GAUGE = 'metering_reconcile_tenants_unavailable';

/**
 * How close is "the same amount of money".
 *
 * ⛔ NOT A CENT, AND NOT ZERO. Zero is wrong because the two systems store the number at different
 * precisions and the round-trip is lossy by construction: `usage_events.cost_usd` is
 * `numeric(12,6)`, and `host/metering-emit.ts` serialises it onto the wire as `.toFixed(8)`, which
 * billing then re-parses and re-sums in its own arithmetic. Exact equality would therefore report a
 * mismatch on the last digit of a perfectly healthy day, which is how a real signal gets muted
 * within a week. A CENT is wrong in the other direction and much worse: this deployment's whole
 * metered traffic priced out at **$1.09 for the month of August**, so a per-actor tolerance of
 * $0.01 would swallow essentially every disagreement this tick exists to find.
 *
 * 1e-6 is the ledger's own last representable digit — the finest distinction either system is
 * capable of making, and therefore the only non-arbitrary choice available.
 */
export const MISMATCH_EPSILON_USD = 1e-6;

/** Per-actor delta on one tenant, for one day. Positive `deltaUsd` = CP has MORE than billing. */
export interface ActorDelta {
  tenantId: string;
  /** licences Subject uuid, or '' for the unattributed bucket. See `SUBJECT_KEY` below. */
  subjectId: string;
  cpUsd: number;
  billingUsd: number;
  deltaUsd: number;
  cpEvents: number;
  billingEvents: number;
}

export interface ReconcileResult {
  /** The UTC day compared, `YYYY-MM-DD`. */
  day: string;
  /** Tenants whose day was actually compared — the denominator for every number below. */
  tenantsCompared: number;
  /** Tenants whose billing read failed. Their rows are NOT in any total here. */
  tenantsUnavailable: number;
  /** Distinct (tenant, subject) pairs seen on either side. */
  actorsCompared: number;
  /** …of which, differ by more than `MISMATCH_EPSILON_USD`. */
  actorsMismatched: number;
  /** Sum of |delta| over every mismatched actor. */
  mismatchUsd: number;
  /** The mismatches themselves, largest first, capped at `MAX_REPORTED_DELTAS`. */
  deltas: ActorDelta[];
}

/**
 * How many per-actor deltas are logged and returned. A day in which EVERY actor disagrees is the
 * emitter being broken, not a thousand separate findings — and a thousand log lines is how a pod's
 * stdout becomes unreadable at the exact moment somebody is reading it. The COUNT and the SUM are
 * never truncated; only the itemisation is.
 */
const MAX_REPORTED_DELTAS = 25;

/**
 * ⛔ THE PREDICATE THAT MAKES THIS TICK A SIGNAL INSTEAD OF A DAILY FALSE ALARM.
 *
 * A `usage_events` row and its `metering_outbox` row are written in ONE transaction, and the
 * drainer sends the outbox row afterwards — with backoff, and surviving a Redis outage by design.
 * So at any instant there is a legitimate population of committed ledger rows that billing has
 * CORRECTLY not seen yet. Comparing all of them would report that entirely healthy backlog as a
 * shortfall, every single day, and the operator would learn to ignore the alert — at which point
 * the real under-count (0 rows, $0.00, ever) is invisible again for exactly the same reason it was
 * the first time.
 *
 * So the comparison is restricted to rows whose outbox entry is `sent`, i.e. rows Redis has
 * acknowledged. "We sent it and billing does not have it" is a genuine defect; "we have not sent it
 * yet" is a different measurement and it already has one —
 * `commonpractice_metering_outbox_pending` / `…_oldest_pending_age_seconds`, which the drainer
 * publishes. Two questions, two instruments; conflating them would make BOTH unreadable.
 *
 * ⚠️ `sent` IS AT-LEAST-ONCE, NOT EXACTLY-ONCE (see the drainer's header): a crash between the XADD
 * and the `sent` UPDATE re-sends the row. Billing deduplicates on `event_key`, so a duplicate send
 * does not double-count on their side and this comparison is unaffected. The residual is the
 * opposite window — acknowledged by Redis, not yet flushed by billing's consumer — which is why
 * the reconciled day is YESTERDAY and not today (see `previousUtcDay`).
 */
const SETTLED_ONLY = sql`EXISTS (
  SELECT 1 FROM metering_outbox mo
   WHERE mo.usage_event_id = ue.id AND mo.status = 'sent'
)`;

/**
 * The actor key, on BOTH sides of the comparison.
 *
 * ⛔ `license_subject_id`, NEVER `user_id`. Billing attributes a cost event on the licences-service
 * SUBJECT uuid; CP's own user id is a different identifier in a different system, and confusing the
 * two is the documented cause of 100 % of this service's central spend landing `unlicensed`
 * (migration 0090). Joining on the local user id here would not merely be wrong — it would find
 * ZERO matching actors on billing's side and report the entire day as a mismatch, i.e. it would
 * produce a loud, permanent, completely false alarm.
 *
 * ⚠️ NULL COLLAPSES TO `''` RATHER THAN BEING DROPPED. A ledger row with no subject is spend that
 * settled while the member held no entitlement, and billing keeps the same unattributed bucket. It
 * is a REAL bucket on both sides and it is the one most likely to disagree, so discarding it would
 * hide precisely the rows worth looking at while making the report look tidier.
 */
const SUBJECT_KEY = sql`COALESCE(ue.license_subject_id::text, '')`;

/** The UTC day before `now`, `YYYY-MM-DD`. */
export function previousUtcDay(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

interface CpRow {
  tenant_id: string;
  subject_id: string;
  cost_usd: string | number;
  events: number;
}

/**
 * CP's settled ledger for one UTC day, grouped by (tenant, subject).
 *
 * ⚠️ THE DAY BOUNDS ARE SPELLED IN UTC EXPLICITLY, not as `${day}::date`. `created_at` is
 * `timestamptz`, so comparing it against a bare `date` casts through the SESSION's TimeZone —
 * which on a pooled connection is whatever the server default happens to be, not necessarily UTC.
 * That would silently shift the window by hours and make the reconciler compare a sliver of two
 * days against billing's one, producing a mismatch whose cause is a timezone and whose appearance
 * is an accounting failure.
 */
async function cpSettledDay(day: string): Promise<CpRow[]> {
  const start = `${day}T00:00:00Z`;
  return (await db.execute(sql`
    SELECT ue.tenant_id::text AS tenant_id,
           ${SUBJECT_KEY} AS subject_id,
           COALESCE(SUM(ue.cost_usd), 0) AS cost_usd,
           COUNT(*)::int AS events
      FROM usage_events ue
     WHERE ue.tenant_id IS NOT NULL
       AND ue.created_at >= ${start}::timestamptz
       AND ue.created_at <  ${start}::timestamptz + interval '1 day'
       AND ${SETTLED_ONLY}
     GROUP BY ue.tenant_id, ${SUBJECT_KEY}
  `)) as unknown as CpRow[];
}

/**
 * Compare one UTC day, tenant by tenant, actor by actor.
 *
 * Exported and callable on its own — the scheduler below only supplies leader election and a
 * timer, so every behaviour worth pinning is reachable from a test without one.
 *
 * ⛔ THE CROSS-TENANT READ IS `'cross-tenant-aggregate'`, NOT `'platform-admin'`. Nothing here is
 * behind `requireSuperAdmin`; it is a scheduler tick, and only AGGREGATES cross back to the caller
 * — no row, no id and no name from another tenant is returned to any request. Labelling it
 * `platform-admin` would overstate the gate, which is precisely what `SystemReason` exists to stop
 * (see db/client.ts). The tick itself is `'scheduler-tick'` where it claims.
 */
export async function reconcileMeteringDay(day: string): Promise<ReconcileResult> {
  const cpRows = await runAsSystem('cross-tenant-aggregate', () => cpSettledDay(day));

  // (tenant → subject → totals), built from CP's side first. A tenant with no settled rows at all
  // is not visited: billing cannot be holding spend we never sent, and asking about every tenant
  // in the estate on every tick would be N requests to find nothing.
  const byTenant = new Map<string, Map<string, { usd: number; events: number }>>();
  for (const r of cpRows) {
    let actors = byTenant.get(r.tenant_id);
    if (!actors) {
      actors = new Map();
      byTenant.set(r.tenant_id, actors);
    }
    actors.set(r.subject_id, { usd: Number(r.cost_usd), events: Number(r.events) });
  }

  const client = billingAdmin();
  const deltas: ActorDelta[] = [];
  let tenantsCompared = 0;
  let tenantsUnavailable = 0;
  let actorsCompared = 0;

  for (const [tenantId, cpActors] of byTenant) {
    let billingActors: Map<string, { usd: number; events: number }>;
    try {
      const rows = await client.actorCosts(tenantId, day, day);
      billingActors = new Map(
        rows.map((r) => [r.subjectId, { usd: r.costUsd, events: r.events }]),
      );
    } catch (err) {
      // ⛔ A FAILED READ IS NOT A ZERO. Treating an unreachable billing as "billing has $0 for this
      // tenant" would report the tenant's entire day as missing money — a fabricated, maximally
      // alarming finding produced by an outage. The tenant is COUNTED AS UNCOMPARED and skipped,
      // and `tenantsUnavailable` is what stops the resulting low mismatch total from reading as
      // agreement.
      tenantsUnavailable++;
      log.warn('metering_reconcile_tenant_unavailable', {
        component: 'metering',
        tenantId,
        day,
        err,
      });
      continue;
    }
    tenantsCompared++;

    // The union of both sides' actors: an actor billing has and CP does not is just as much a
    // finding as the reverse (it means spend was attributed to somebody this ledger never
    // credited), and iterating only CP's keys would make that class structurally invisible.
    for (const subjectId of new Set([...cpActors.keys(), ...billingActors.keys()])) {
      const cp = cpActors.get(subjectId) ?? { usd: 0, events: 0 };
      const bill = billingActors.get(subjectId) ?? { usd: 0, events: 0 };
      actorsCompared++;
      const deltaUsd = cp.usd - bill.usd;
      if (Math.abs(deltaUsd) <= MISMATCH_EPSILON_USD) continue;
      deltas.push({
        tenantId,
        subjectId,
        cpUsd: cp.usd,
        billingUsd: bill.usd,
        deltaUsd,
        cpEvents: cp.events,
        billingEvents: bill.events,
      });
    }
  }

  deltas.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  const mismatchUsd = deltas.reduce((sum, d) => sum + Math.abs(d.deltaUsd), 0);

  const out: ReconcileResult = {
    day,
    tenantsCompared,
    tenantsUnavailable,
    actorsCompared,
    actorsMismatched: deltas.length,
    mismatchUsd,
    deltas: deltas.slice(0, MAX_REPORTED_DELTAS),
  };

  // ⛔ PUBLISHED FROM INSIDE THE MEASURING FUNCTION, AND UNCONDITIONALLY — INCLUDING THE ZEROES.
  // Same two reasons as the outbox drainer's gauges: (1) this function is also called directly (the
  // boot catch-up, and every test), so publishing in the scheduler wrapper would leave the boot
  // measurement — the one that matters after a rollout — unpublished; and (2) a day in which the
  // two ledgers AGREE is a positive measurement, not an absence. Skipping the zero write would
  // leave yesterday's non-zero reading standing forever and alert on drift that has since been
  // fixed. ⚠️ All four calls are no-ops until the names are in `PRESEEDED_GAUGES` — see the block
  // at the top of this file.
  setGauge(RECONCILE_MISMATCH_USD_GAUGE, out.mismatchUsd);
  setGauge(RECONCILE_ACTORS_MISMATCHED_GAUGE, out.actorsMismatched);
  setGauge(RECONCILE_TENANTS_COMPARED_GAUGE, out.tenantsCompared);
  setGauge(RECONCILE_TENANTS_UNAVAILABLE_GAUGE, out.tenantsUnavailable);

  return out;
}

function logReconcile(out: ReconcileResult | undefined): void {
  if (!out) return; // claim refused — another pod reconciled this day
  const level = out.actorsMismatched > 0 || out.tenantsUnavailable > 0 ? log.warn : log.info;
  level('metering_reconcile_done', {
    component: 'metering',
    day: out.day,
    tenantsCompared: out.tenantsCompared,
    tenantsUnavailable: out.tenantsUnavailable,
    actorsCompared: out.actorsCompared,
    actorsMismatched: out.actorsMismatched,
    mismatchUsd: out.mismatchUsd,
  });
  // ⚠️ ONE LINE PER MISMATCHED ACTOR, and it carries the SUBJECT id rather than a name or an
  // email. The subject is the only identifier both systems share, so it is the only one an
  // operator can carry across to billing's own tables — and it discloses nothing about the person
  // to anyone reading pod logs. The summary line above is already emitted, so these are detail,
  // not the signal.
  for (const d of out.deltas) {
    log.warn('metering_reconcile_actor_delta', { component: 'metering', day: out.day, ...d });
  }
}

/** Fire period. Daily — the work item is a whole UTC day and it does not exist until the day ends. */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function reconcileClaimWindowMs(): number {
  return tickClaimWindowMs(RECONCILE_INTERVAL_MS, TICK_MIN_INTERVAL_MS.meteringReconcile);
}

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Boot-only (server.ts), same convention as every other in-process scheduler.
 *
 * ⛔ TWO PRECONDITIONS, AND BOTH REFUSALS ARE ANNOUNCED RATHER THAN SILENT. With
 * `METERING_EMIT_ENABLED` off, CP sends billing nothing, so every actor would read
 * "CP has spend, billing has none" and the tick would manufacture a 100 % mismatch out of a
 * correctly-configured deployment. With no billing API configured there is nothing to ask. In
 * either case the tick does not arm — and says so at `info`, because a scheduler that is silently
 * absent is indistinguishable from one that is silently broken, which is the failure mode this
 * whole family of files exists to remove.
 */
export function startMeteringReconciler(): void {
  if (!config.metering.emitEnabled) {
    log.info('metering_reconciler_disabled', { component: 'metering', reason: 'emit_disabled' });
    return;
  }
  if (!billingAdminConfigured()) {
    log.info('metering_reconciler_disabled', {
      component: 'metering',
      reason: 'billing_not_configured',
    });
    return;
  }

  const run = (label: string, skipCounter: string | null, refusal: 'notable' | 'expected') => {
    const day = previousUtcDay();
    return claimTick({
      // ⛔ PER-DAY KEY. See `meteringReconcileTickKey` — a bare cadence key with a 12 h window
      // against a 24 h period lets a deploy's boot catch-up eat that night's scheduled run.
      key: meteringReconcileTickKey(day),
      minIntervalMs: reconcileClaimWindowMs(),
      label,
      skipCounter,
      refusal,
      run: () => reconcileMeteringDay(day),
    }).then(logReconcile);
  };

  // Boot catch-up, with `skipCounter: null` for the reason cycle-scheduler documents: colliding
  // with the same day's already-run tick happens on EVERY deploy, and a counter that is non-zero
  // after every rollout is a counter nobody reads. It still LOGS — `null` means "do not count
  // this", never "do not mention it".
  void run('[metering-reconcile] boot reconcile', null, 'notable').catch((err) =>
    log.error('metering_reconcile_boot_failed', { component: 'metering', err }),
  );

  // ⛔ FIXED UTC HOUR, NOT A BOOT-RELATIVE 24 h TIMER. A boot-relative timer moves the
  // daily tick to boot+24h on every deploy, so the gap between the last claim and the
  // next one becomes (boot - last claim) + 24h and can exceed the 30h freshness alert
  // with nothing wrong: measured 2026-11-10, a 19:40Z roll put the next claim at
  // ~19:40Z the following day, ~33h after the previous one, and paged
  // CommonPracticeDailySchedulerStale. cycle-scheduler and audit-export-scheduler are
  // fixed-hour for the same reason; this is the third member of that family.
  const arm = (): void => {
    const delay = msUntilNextTick(new Date(), config.metering.reconcileHourUtc);
    const at = new Date(Date.now() + delay).toISOString();
    log.info('metering_reconciler_next_run_scheduled', {
      component: 'metering',
      at,
      delayMinutes: Math.round(delay / 60000),
    });
    timer = setTimeout(() => {
      void run('[metering-reconcile] scheduled reconcile', 'metering_reconcile_tick_skipped_total', 'notable')
        .catch((err) => log.error('metering_reconcile_failed', { component: 'metering', err }))
        .finally(arm);
    }, delay);
  };
  log.info('metering_reconciler_armed', {
    component: 'metering',
    intervalMs: RECONCILE_INTERVAL_MS,
    hourUtc: config.metering.reconcileHourUtc,
    // Logged as a PAIR because the pair is the invariant: a window >= the period means every other
    // pod's tick is refused, and this is the only place both numbers are visible at once on a
    // running pod.
    claimWindowMs: reconcileClaimWindowMs(),
  });
  arm();
}

export function stopMeteringReconciler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
