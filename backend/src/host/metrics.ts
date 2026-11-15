// src/host/metrics.ts — minimal, dependency-free Prometheus metrics.
//
// The backend is intentionally dependency-light (custom Bun.serve), so rather than pull in a
// prom client we hand-roll the handful of series that matter for production SLOs: request
// throughput, error rate, and latency (a histogram), plus a couple of generic counters that
// other modules bump (license-introspect failures, audit-write failures). Rendered as Prometheus
// text exposition by GET /metrics (auth/license-exempt) and scraped by the cluster Prometheus.
//
// Cardinality is kept deliberately low: HTTP series are labelled by method + status CLASS (2xx…5xx)
// + a normalized route, never the raw path (which would explode cardinality on :slug/:id params).

const SVC = 'commonpractice';

// ---- HTTP request histogram + counter ----
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HttpSeries {
  count: number;
  sum: number;
  buckets: number[]; // cumulative-ready raw counts per bucket (rendered cumulatively)
}
const httpSeries = new Map<string, HttpSeries>();

function httpKey(method: string, route: string, statusClass: string): string {
  return `${method}\0${route}\0${statusClass}`;
}

/**
 * Record one finished HTTP request. `route` should be the matched ROUTE TEMPLATE
 * (e.g. /api/blocks/:slug), not the concrete path, to keep label cardinality bounded.
 */
export function recordHttp(
  method: string,
  route: string,
  status: number,
  durationSec: number,
): void {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const key = httpKey(method, route, statusClass);
  let s = httpSeries.get(key);
  if (!s) {
    s = { count: 0, sum: 0, buckets: new Array(BUCKETS.length).fill(0) };
    httpSeries.set(key, s);
  }
  s.count += 1;
  s.sum += durationSec;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (durationSec <= BUCKETS[i]!) s.buckets[i]! += 1;
  }
}

// ---- generic counters (license-introspect failures, audit-write failures, …) ----
const counters = new Map<string, number>();

/**
 * Counters that are REGISTERED AT ZERO when this module loads, so their series exists on a pod
 * before the thing they count has ever happened.
 *
 * ⛔ WHY THIS LIST EXISTS: A LAZY COUNTER CANNOT BE ALERTED ON WITH `increase()`/`rate()`. The map
 * below is populated on first `incCounter`, and `renderMetrics` iterates the map — so an unbumped
 * counter has NO SERIES AT ALL, and its first bump makes the series appear *already holding 1*.
 * Prometheus never sees the 0 -> 1 transition; `increase()` needs two samples inside the window and
 * treats the first one it finds as the base, so it returns 0 for that rise. `rate()` is the same
 * function divided by time and has the same blind spot.
 *
 * That is not theoretical. `commonpractice_scheduler_freshness_read_failures_total` read **1** in
 * prod on 2026-08-11 (one pod, a genuine intermittent at 12:37:34Z — the outer 2000ms JS bound in
 * host/scheduler-freshness.ts tripping on a connect/pooler stall before the statement ran; NOT pool
 * exhaustion, pgbouncer `client_waiting`/`maxwait` were 0 throughout) while
 * `increase(…[15m])`, `[6h]` and `[24h]` ALL returned 0. `CommonPracticeSchedulerFreshnessReadFailures`
 * (`sum(increase(…[15m])) > 0`, gitops rules.yaml) therefore did not fire for it, and structurally
 * COULD NOT fire for the first failure of any pod process — and every rollout re-arms that blind
 * spot on every replica. Registering the series at 0 is the whole fix: the rise is then 0 -> 1,
 * which `increase()` can see.
 *
 * ⛔ THE MEMBERSHIP RULE, AND WHY THIS IS A LIST RATHER THAN A CHANGE TO `incCounter`. A counter
 * belongs here when BOTH hold:
 *   (1) its name is a FIXED literal known at module load, and
 *   (2) a gitops alert consumes it through `increase()`/`rate()`, where absent -> N is invisible.
 * `incCounter` itself is deliberately left lazy. It also serves counters whose NAME IS COMPUTED —
 * `run_rejected_${err.code}_total` (host/run-controller.ts) — where "register everything at 0" is
 * not even expressible without enumerating every error code, and would publish a permanent series
 * for every code that never occurs. And for a counter nothing alerts on, absent-until-first-use is
 * the cheaper and equally readable state: `cycle_tick_skipped_total`,
 * `audit_export_tick_skipped_total`, `connector_listen_*`, `jit_seat_denied_total` and
 * `license_status_introspect_failures_total` are all deliberately NOT here — no rule reads them, so
 * seeding them would add series to every pod to fix an alert that does not exist. (Pre-seeding also
 * would not unpark `CommonPracticeCycleTickStarved`: that rule's defect is semantic — N-1 replicas
 * increment `cycle_tick_skipped_total` on every healthy tick — not the laziness.)
 *
 * ⚠️ NOTHING IN THIS REPO OR IN gitops PAIRS THESE THREE WITH `absent()`, so registering them at 0
 * cannot make an absence rule vacuous. Verified against rules.yaml on 2026-08-11: the only
 * `absent()` guards over commonpractice counters are on `commonpractice_http_requests_total`, which
 * is fed by `recordHttp` and is a different mechanism entirely. If you ever add an `absent()` rule
 * over a counter, check this list first — a registered counter is never absent.
 */
export const PRESEEDED_COUNTERS = [
  // host/metering-emit.ts + host/metering-outbox-drainer.ts (migration 0090). `enqueued - sent` over a
  // window is spend that has not yet reached billing; `send_failed` > 0 is a transport fault the
  // outbox is absorbing. Pre-seeded so the first failure is visible to `increase()`.
  'metering_outbox_enqueued_total',
  'metering_outbox_sent_total',
  'metering_outbox_send_failed_total',
  // gitops rules.yaml: CommonPracticeSchedulerFreshnessReadFailures — sum(increase(…[15m])) > 0.
  // The counter that proved the defect live. Must match host/scheduler-freshness.ts
  // READ_FAILURE_COUNTER, which tests/metrics-counter-preseed.test.ts pins.
  'scheduler_freshness_read_failures_total',
  // gitops rules.yaml: CommonPracticeLicenseIntrospectFailures — sum(rate(…[5m])) > 0.1.
  'license_introspect_failures_total',
  // gitops rules.yaml: CommonPracticeAuditWriteFailures — sum(rate(…[5m])) > 0. Same shape as the
  // freshness rule: a `> 0` threshold, so a first-failure blind spot is the whole alert.
  'audit_write_failures_total',
  // ⚠️ THE ONE ENTRY WHOSE gitops RULE DOES NOT EXIST YET, and it is here on purpose.
  // `recordAudit`'s orphan-actor fallback (host/audit-service.ts, `ORPHAN_ACTOR_COUNTER`) TAKES a
  // condition OFF `audit_write_failures_total` — pre-seeded and alerted, one line up — and puts it
  // on this one. Leaving it lazy would not "alert on the two differently"; it would move a paged
  // condition onto a counter no `increase()` can see, i.e. strictly less visibility than before the
  // fallback existed. Registering the series at 0 is the half that belongs in this repo and is the
  // precondition for a rule to be able to fire at all. TODO(gitops-production):
  // `CommonPracticeAuditActorOrphan`, `sum(increase(commonpractice_audit_actor_orphan_total[15m])) > 0`.
  // Pinned to the constant by tests/metrics-counter-preseed.test.ts (this module cannot import
  // audit-service — audit-service imports this one).
  'audit_actor_orphan_total',
  // gitops rules.yaml: CommonPracticeRateLimitRejections — sum(increase(…[15m])) > 0, added in the
  // same unit of work that introduced the limiter (middleware/rate-limit.ts).
  //
  // ⛔ PRE-SEEDED FOR THE REASON THIS LIST EXISTS, and the limiter is the sharpest case of it. A
  // lazily-created counter series does not appear until its FIRST increment, and `increase()` over
  // a series whose first sample is its creation cannot see that first burst — so the one moment
  // the alert exists for (a flood arriving at a pod that has never rejected anything) is precisely
  // the moment it would be blind. Registering at 0 makes the first rejection a visible 0 -> 1 step.
  'rate_limit_rejected_total',
  // Onboarding-integrity reconciler (host/onboarding-integrity.ts): gitops alerts will `increase()`
  // these, so — same rule as every other entry in this list — they must exist at 0 before the first
  // repair attempt or the first bump is invisible to `increase()`. See the ⛔ block at the top of
  // this list for why a lazy counter cannot be alerted on.
  'license_repair_attempted_total',
  'license_repair_succeeded_total',
  'license_repair_failed_total',
  'license_repair_declined_unresolvable_total',
  // Per-member seats (0089). Pre-seeded for the same reason as the tenant repair counters above:
  // a lazily-created counter's FIRST occurrence is invisible to `increase()`, and the first time a
  // seat fails to mint (or fails to be RELEASED) is exactly the occurrence worth alerting on.
  // A first-login (JIT/SSO) seat mints its licence inline now (`services/user-service.ts`), so the
  // sweep is the fallback rather than the only path. Pre-seeded because the interesting value is a
  // STANDING `deferred` count: it means the inline mint keeps failing and every new SSO member is
  // waiting on a sweep tick to get past `license_seat_required`.
  'jit_seat_licensed_total',
  'jit_seat_licence_deferred_total',
  'member_seat_repair_attempted_total',
  'member_seat_repair_succeeded_total',
  'member_seat_repair_failed_total',
  // A member of a tenant holding its tenant-level (svc:) licence needs no member seat (#415), so
  // the sweep skips them — one licences lookup per tenant per tick. Pre-seeded so a standing
  // skip population is visible from its first tick rather than read as a repair backlog.
  'member_seat_repair_skipped_tenant_level_total',
  // ⛔ EVERY BUMP OF THIS ONE IS COSTING A CUSTOMER MONEY. A `revoking` entitlement means an
  // offboard denied access but the licences service never acknowledged the revoke, so the member is
  // gone and the tenant is STILL being billed for their `human_subjects` entry. Unlike a failed
  // mint, which merely delays access, this is a standing overcharge until the retry sweep clears it.
  'member_seat_release_retry_succeeded_total',
  'member_seat_release_retry_failed_total',
  // ⛔ THE FAILURE OF A SCHEDULER'S WORK WAS, UNTIL NOW, INVISIBLE TO PROMETHEUS ENTIRELY.
  // `claimTick` counts a REFUSAL (`skipCounter`), but when the claimed work itself THREW, all seven
  // call sites only `log.error`-ed it — and gitops `rules.yaml` states plainly that "loki has no
  // `ruler` stanza, so log-based alerting cannot fire". So a DB outage that killed every cycle,
  // budget, translation, audit-export and onboarding tick for an hour produced NO series at all:
  // not a weak signal, no signal. `host/tick-locks.ts` now bumps this inside `claimTick` and
  // rethrows, so the seven existing log lines are unchanged and a future scheduler cannot forget it.
  // Unlabelled on purpose: this registry is a plain Map<string, number> with no label support, and
  // a `{scheduler="…"}` suffix would not parse — the per-scheduler detail stays in the log line.
  // TODO(gitops-production): `CommonPracticeSchedulerTickFailing`,
  // `sum(increase(commonpractice_scheduler_tick_failed_total[15m])) > 0`.
  'scheduler_tick_failed_total',
  // The onboarding-integrity census READ path (host/onboarding-integrity.ts). Its own comment asked
  // for this — "whoever wires the gitops alert should pre-seed it there first" — and the unit that
  // shipped the reconciler did not do it, which left the read that FEEDS the unlicensed/stranded
  // gauges able to fail without a first-failure signal. Same rule as every entry above.
  'onboarding_integrity_read_failures_total',
  // The unrecoverable half of the licence-mint race. `ensureTenantLicense` lets two concurrent
  // first-time callers both mint (harmless), then guards the STORE with a compare-and-set; the
  // loser revokes the licence it just minted. This counter fires only when that revoke ALSO fails —
  // i.e. an upstream licence exists that this system will never store and can therefore never
  // revoke on offboarding. With no free tier that is a licence you keep paying for and cannot see,
  // so it must never be a lazy series whose first occurrence `increase()` cannot observe.
  // TODO(gitops-production): `CommonPracticeLicenseOrphanUnrevoked`,
  // `sum(increase(commonpractice_license_provision_orphan_unrevoked_total[15m])) > 0`.
  'license_provision_orphan_unrevoked_total',
  // A tenant licence CHANGE (plan / dates, services/license-provisioning.ts `changeTenantLicence`)
  // swapped in the new licence but could not revoke the OLD one: it stays active upstream — a second
  // licence for the same tenant that nothing in CP holds any more. Pre-seeded for the same reason.
  'licence_change_old_unrevoked_total',
  // A local-llm tenant's inference-router licence whose provisioning smoke failed, and whose revoke
  // ALSO failed: queued in `tenants.licence_revoke_pending` for the integrity sweep
  // (services/tenant-inference.ts `discardMinted`). Pre-seeded so the first one is observable.
  'tenant_inference_orphan_revoke_queued_total',
  // A tenant create failed after registering its licences tenant and could not void that registration
  // (services/tenant-service.ts `voidRegistration`): the name stays held by an unused tenant.
  'tenant_create_licences_void_failed_total',
  // The onboarding-integrity re-home of pre-A2 tenant licences onto CP's cp-tenant holder
  // (services/license-provisioning.ts `rehomeTenantLicence`). A failure leaves that workspace's
  // licence on a member's seat — offboarding the member 402s it.
  'tenant_licence_rehomed_total',
  'tenant_licence_rehome_failed_total',
  // A re-home deferred because licences could not be asked what the stored licence is (introspect
  // failed). A steady rise = a workspace stuck on a person's licence.
  'tenant_licence_rehome_unresolved_total',
  // `brokerChatStream`'s abort-settle path (host/llm-broker.ts `finally`, migration 0087). A
  // caller abort or a mid-stream provider death that DID deliver real text now settles an
  // estimate (`price_source='abort_estimate'`) instead of silently refunding spend the vendor
  // already charged us for. Both counters below are the only visibility that path has: there is
  // no other signal that distinguishes "this defect stopped recurring" from "nobody is looking."
  // Same rule as every entry in this list — a lazy counter's first bump is invisible to
  // `increase()`, and the first abort after a rollout is precisely the moment this must be seen.
  // TODO(gitops-production): `CommonPracticeLlmStreamAbortSettleFailing`,
  // `sum(increase(commonpractice_llm_stream_abort_settle_failed_total[15m])) > 0` — this one
  // pages, because a failure here falls back to `releaseCall` and re-opens the original leak for
  // that call.
  'llm_stream_abort_settled_total',
  'llm_stream_abort_settle_failed_total',
  // The DENOMINATOR of the fleet cost-event emit (host/metering-emit.ts). Bumped only after the
  // XADD onto `billing:costs` has actually resolved, so it counts events that reached the bus —
  // not attempts. Its partner is the LABELLED `metering_cost_event_dropped_total` below.
  //
  // ⛔ WHY THIS PAIR EXISTS AT ALL. Measured in production 2026-09-06: `service_key='commonpractice'`
  // has **0 rows and $0.00 in `billing_cost_events`, ever** — while `METERING_EMIT_ENABLED="true"`
  // is live and the `metering-redis-url` secret is populated. Billing is not rejecting the events
  // (0 nil-UUID-tenant rows and 0 `excluded_from_billing` rows fleet-wide); they never arrive. The
  // module had FOUR ways to produce exactly that outcome — the flag off, no sender, a refused
  // tenant, a throwing XADD — and NOT ONE of them was counted. Two were bare `return`s and the
  // third only reached `log.warn`, and gitops rules.yaml records that "loki has no `ruler` stanza,
  // so log-based alerting cannot fire". So the emitter could not tell anyone which of the four it
  // was doing, and 19h of live pod logs showed zero emit-failure lines — an observation that is
  // equally consistent with "it never runs" and "it returns on line 2". These counters are the
  // discriminator.
  'metering_cost_event_emitted_total',
  // The alertable half of the tenant-admin billing panel's outage state: the panel answers 200 with
  // `status:'unavailable'` and no money fields (a 503 would ship uncopied English, see
  // routes/billing-view.ts), so the READER is told honestly — but nothing would tell an operator.
  'billing_view_unavailable_total',
] as const;

for (const name of PRESEEDED_COUNTERS) counters.set(name, 0);

/**
 * Bump a free-form counter. `name` must be a valid Prometheus metric name suffix.
 *
 * Deliberately still lazy for names not in `PRESEEDED_COUNTERS` — see the note there.
 */
export function incCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

// ---- ONE-LABEL counters ----
//
// ⚠️ READ THIS BEFORE REACHING FOR IT. `incCounter` above is deliberately unlabelled, and the
// `scheduler_tick_failed_total` note in PRESEEDED_COUNTERS says why: `counters` is a plain
// Map<string, number> and a `{scheduler="…"}` suffix baked into the NAME does not render — it would
// emit `# TYPE commonpractice_x{scheduler="y"} counter`, which is not a valid TYPE line and poisons
// the whole scrape. That constraint is about ABUSING the unlabelled registry, not about labels
// themselves: `renderMetrics` already emits labelled series for the http histogram and for every
// gauge. This registry is the missing third case, rendered properly — one `# TYPE` per metric NAME,
// then one sample line per label value.
//
// ⛔ EXACTLY ONE LABEL DIMENSION, ON PURPOSE. Cardinality is the reason the http series are labelled
// by status CLASS and normalized route rather than raw values (see the header note). A general
// label-set registry invites `{tenant="…"}` and `{model="…"}`, which is how a hand-rolled exposition
// turns into a cardinality incident. One dimension, drawn from a CLOSED set enumerated at module
// load, is enough for the "why did this drop" question and cannot grow unbounded.
//
// The pre-seeding rule is identical to PRESEEDED_COUNTERS and matters MORE here: every label value
// must exist at 0, because a `reason` that has never occurred is exactly the reason an operator
// needs to be able to rule OUT. An absent series does not read as "this never happened", it reads
// as "no data", and `increase()` cannot see its first rise either.
interface LabelledCounter {
  /** Label NAME, e.g. `reason`. */
  readonly label: string;
  /** Label VALUE → count. Every value in the declared roster is present at 0 from module load. */
  readonly values: Map<string, number>;
}
const labelledCounters = new Map<string, LabelledCounter>();

/**
 * Metric name → label name → the CLOSED set of label values, all registered at 0 on load.
 *
 * ⚠️ SAME DRIFT TRAP AS PRESEEDED_COUNTERS, and pinned the same way. The reason strings the emitter
 * actually passes live in host/metering-emit.ts (`EMIT_DROP_REASONS`), and this module cannot import
 * that file — metering-emit imports metrics, so the reverse is a cycle. Adding a reason there without
 * adding it here makes that one reason lazy, i.e. invisible to `increase()` on its first occurrence,
 * while every other test stays green. `tests/metrics-counter-preseed.test.ts` asserts the two sets
 * are equal, in both directions.
 */
export const PRESEEDED_LABELLED_COUNTERS = [
  {
    // gitops-production TODO: `CommonPracticeMeteringCostEventsDropped`,
    // `sum by (reason) (increase(commonpractice_metering_cost_event_dropped_total[15m])) > 0`.
    // `reason="disabled"` is the one value that must NOT page — it is the default-off state for
    // every deployment that has not joined the fleet rollup, and it is counted anyway so that
    // "the flag is off" is a POSITIVE observation rather than an absence to be guessed at.
    name: 'metering_cost_event_dropped_total',
    label: 'reason',
    values: ['disabled', 'no_sender', 'no_tenant', 'send_failed'],
  },
  {
    // gitops-production TODO: `CommonPracticeSignupQueueRefusing`,
    // `sum by (reason) (increase(commonpractice_signup_queue_refused_total[15m])) > 0`.
    //
    // ⛔ THE TWO REASONS MUST NOT BE ONE SERIES, WHICH IS THE WHOLE POINT OF LABELLING IT.
    // `reason="queue_full"` is an OPERATOR BACKLOG — the whole table is at its ceiling and every
    // caller, including a paying customer's employee, is being turned away; the repair is to work
    // the queue down. `reason="anonymous_quota"` is the ABUSE ARM — the anonymous reserve is
    // exhausted while matched and authenticated signups are still being served; the repair is to
    // look at who is spraying, and it is explicitly NOT a customer outage. Collapsed into one
    // counter the two page identically and the second one reads as the first, i.e. as an outage
    // that is not happening. Both values are pre-seeded for the reason in this file's header: an
    // absent series reads as "no data", and an operator needs to be able to RULE OUT the arm that
    // is not firing.
    name: 'signup_queue_refused_total',
    label: 'reason',
    values: ['queue_full', 'anonymous_quota'],
  },
  {
    // services/signup-telegram.ts — early-access signup notifications to George's Telegram topic.
    // `*_failed` > 0 means a signup or decision was recorded in CP but nobody was told; the queue
    // on /onboarding is still the source of truth.
    name: 'signup_telegram_send_total',
    label: 'outcome',
    values: ['new_signup_ok', 'new_signup_failed', 'decision_ok', 'decision_failed', 'digest_ok', 'digest_failed'],
  },
  {
    // services/book-links.ts — the epub download link put into the early-access approval email.
    // `failed` > 0 means an approval email went out WITHOUT its book link (never blocked by it);
    // `disabled` counts approvals on a deployment where BOOK_FULFILLMENT_URL / the client is unset.
    name: 'signup_book_link_total',
    label: 'outcome',
    values: ['ok', 'failed', 'disabled'],
  },
] as const;

for (const spec of PRESEEDED_LABELLED_COUNTERS) {
  const values = new Map<string, number>();
  for (const v of spec.values) values.set(v, 0);
  labelledCounters.set(spec.name, { label: spec.label, values });
}

/**
 * Bump `<name>{<label>="<value>"}`.
 *
 * ⛔ Silently ignores a `name` that is not in `PRESEEDED_LABELLED_COUNTERS`, and a `value` outside
 * that name's declared roster. That is not defensive padding, it is the cardinality bound: an
 * unregistered value would create a series no alert knows about and no scrape ever saw at 0, which
 * is the exact defect this registry exists to prevent. Callers type their reasons as a union
 * (`EmitDropReason`) so this branch is unreachable from correct code — and the drift test makes an
 * incorrect caller fail loudly at build time rather than quietly at 3am.
 */
export function incLabelledCounter(name: string, value: string, by = 1): void {
  const c = labelledCounters.get(name);
  if (!c) return;
  const cur = c.values.get(value);
  if (cur === undefined) return;
  c.values.set(value, cur + by);
}

// ---- PROCESS-LOCAL GAUGES (set, not incremented) ----
//
// ⛔ THERE WAS NO GAUGE FACILITY IN THIS FILE, and the two gauges that already render are NOT one.
// `scheduler_last_run_timestamp_seconds` and the onboarding-integrity census are both PASSED IN to
// `renderMetrics` as arguments, precisely so this module stays synchronous, pure and DB-free (see
// the ⛔ block on `renderMetrics`). That works because both values are DATABASE reads a scrape can
// perform on demand. This registry is the OTHER case: a value produced by a background job, on the
// job's own schedule, which nothing at scrape time can recompute — so it has to be STORED here when
// it is measured. Adding it as a third `renderMetrics` argument would have meant editing the one
// caller (routes/metrics.ts) to fetch something it cannot fetch.
//
// ⛔ WHY THIS EXISTS AT ALL, AND WHY A LOG WAS NOT ENOUGH. `host/metering-outbox-drainer.ts` already
// computed `pending` and `oldestPendingAgeSeconds` — undelivered LLM spend, the exact quantity that
// says billing is missing money — and only ever `log.warn`-ed them. gitops `rules.yaml` records that
// "loki has no `ruler` stanza, so log-based alerting cannot fire". So the single most alertable
// number this service produces was computed every 30 seconds and thrown away. This is the same
// defect, and the same fix, as `scheduler_tick_failed_total` in PRESEEDED_COUNTERS above.
//
// ⛔ PRE-SEEDED AT 0, FOR A REASON THAT IS THE MIRROR IMAGE OF THE COUNTER ONE — READ THIS BEFORE
// ADDING AN ENTRY. For a counter, a lazy series hides the first RISE from `increase()`. A gauge is
// alerted with a bare comparison (`> N`), which CAN see a first sample, so the counter argument does
// not transfer. The reason here is the `absent()` one: a backlog alert's dangerous failure is the
// gauge going MISSING while the backlog grows — a pod that has never drained, a drainer that is
// disabled, a replica that never won a tick claim. `max(...) > N` over an empty group returns EMPTY,
// not false, so the alert silently stops firing at the moment it matters. Registered at 0 the series
// exists from process start on EVERY replica, which turns "no drainer has ever run here" from an
// absence into the readable value 0, and makes a genuine disappearance mean "the pod is gone".
//
// ⚠️ AND THE PART AN ALERT AUTHOR MUST NOT GET WRONG: THIS IS PER-POD STATE FOR A CLUSTER-WIDE FACT.
// The drainer runs under `claimTick`, i.e. exactly ONE pod per tick actually drains and measures.
// Every other replica renders its last value — 0 on a pod that has never won a claim. So the only
// correct expression is `max(commonpractice_metering_outbox_pending)`, never `sum` (which would
// count one backlog once per leader change) and never `avg` (which the idle replicas drag toward 0).
// The same `max by` reasoning the scheduler-freshness gauge already documents, for the same reason.
// TODO(gitops-production): `CommonPracticeMeteringOutboxBacklog`,
// `max(commonpractice_metering_outbox_oldest_pending_age_seconds) > 600` — age, not count, because a
// large backlog that is DRAINING is healthy and a single row stuck for an hour is not.
export const PRESEEDED_GAUGES = [
  {
    name: 'metering_outbox_pending',
    help: 'Rows in metering_outbox still awaiting delivery to billing:costs, as of the last drain pass on THIS pod (use max() across pods — only the tick-claim leader measures).',
  },
  {
    name: 'metering_outbox_oldest_pending_age_seconds',
    help: 'Age in seconds of the oldest undelivered metering_outbox row, 0 when none. This is LLM spend billing has not received yet.',
  },
  // ---- daily reconciliation against billing (host/metering-reconcile.ts) ----
  //
  // ⛔ THE LAST TWO ARE THE DENOMINATORS, AND WITHOUT THEM AN ALERT ON THE FIRST TWO CANNOT FAIL.
  // A billing outage, a missing service token or a tenant list that came back empty all produce
  // `mismatch_usd = 0` — the same reading as perfect agreement. `tenants_compared` says how many
  // tenants the number is actually ABOUT, and `tenants_unavailable` says how many were skipped, so
  // an alert can require that the comparison happened before it believes the agreement.
  {
    name: 'metering_reconcile_mismatch_usd',
    help: "Absolute USD difference between CP's settled usage_events and billing's per-actor totals for the compared day (use max() across pods — only the tick-claim leader measures).",
  },
  {
    name: 'metering_reconcile_actors_mismatched',
    help: 'Number of actors whose CP total and billing total disagree beyond ledger precision.',
  },
  {
    name: 'metering_reconcile_tenants_compared',
    help: 'Tenants the last reconciliation actually compared. A zero here makes any mismatch_usd reading meaningless — alert on it.',
  },
  {
    name: 'metering_reconcile_tenants_unavailable',
    help: 'Tenants the last reconciliation could NOT compare (billing unreachable, unconfigured). Not drift — absence of measurement.',
  },
] as const;

const gauges = new Map<string, number>();
for (const spec of PRESEEDED_GAUGES) gauges.set(spec.name, 0);

/**
 * Set `<name>` to `value`.
 *
 * ⛔ Silently ignores a name outside `PRESEEDED_GAUGES`, exactly like `incLabelledCounter` refuses an
 * undeclared label value, and for the same reason: a gauge created on demand is a series that no
 * alert knows about and no scrape ever saw at 0 — which is the precise defect the pre-seeding above
 * exists to prevent. Declaring it is one line; the refusal is what makes the declaration mandatory.
 *
 * ⚠️ A NON-FINITE VALUE IS DROPPED, NOT WRITTEN. `NaN` renders as the literal `NaN`, which
 * Prometheus ingests as a real sample — so a single bad read would REPLACE a true backlog reading
 * with a value every comparison is false against, i.e. it would silence the alert rather than break
 * it. Keeping the last good value is the safe direction; a stall then shows up as a flat line, which
 * is visible, instead of as a quietly passing threshold.
 */
export function setGauge(name: string, value: number): void {
  if (!gauges.has(name)) return;
  if (!Number.isFinite(value)) return;
  gauges.set(name, value);
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---- scheduler freshness (the ONE value in here that does not live in this process) ----
//
/**
 * One scheduler FAMILY and the unix-seconds timestamp of its most recent tick.
 *
 * Sourced from the `scheduler_ticks` table by host/scheduler-freshness.ts, which owns the read, the
 * cache and the dated-key collapse. It is PASSED IN rather than fetched here on purpose — see the
 * note on `renderMetrics`.
 */
export interface SchedulerFreshness {
  /** `scheduler_ticks.key` up to the first ':' — `cycle:2026-08-11` collapses to `cycle`. */
  scheduler: string;
  /** Unix seconds (fractional). */
  lastRunAtSeconds: number;
}

/**
 * One census pass of the onboarding-integrity reconciler: two broken onboarding states, counted at
 * scrape time and PASSED IN rather than fetched here, for the same reason as `SchedulerFreshness`
 * (see the note on `renderMetrics`) — this module stays synchronous, pure and DB-free.
 */
export interface OnboardingIntegrityCensus {
  readonly tenantsUnlicensedResolvable: number;
  readonly tenantsUnlicensedUnresolvable: number;
  readonly signupStrandPending: number;
  readonly signupStrandOldestAgeSeconds: number;
  readonly usersWithoutTenantQueued: number;
  readonly usersWithoutTenantUnqueued: number;
}

/**
 * Render the full registry as Prometheus text exposition format.
 *
 * ⛔ THIS FUNCTION IS SYNCHRONOUS, PURE AND TOTAL, AND THAT IS LOAD-BEARING. Everything else it
 * renders is process-local counters, so it cannot fail, cannot block, and is trivially testable
 * with no fixtures — `tests/metrics.test.ts` and `tests/metrics-key-separator.test.ts` both call it
 * with nothing but in-memory state. The scheduler-freshness gauge is the first value that comes
 * from the DATABASE, and there were two ways to let it in:
 *
 *   (a) make this async and await a read here, or
 *   (b) keep it pure and hand it the already-resolved snapshot.
 *
 * (b), taken here. (a) would put an I/O failure mode, a timeout and a cache inside the one function
 * in the service that currently has none of those, and would force every existing caller and test
 * through a DB. The `/metrics` route handler is ALREADY `async` (routes/metrics.ts), so awaiting one
 * cache lookup there costs nothing and keeps the exposition format a string join over its
 * arguments. Omitting the argument omits the gauge — which is exactly the behaviour wanted when no
 * successful read has happened yet: no series at all beats a fabricated `0`, whose age
 * (`time() - 0`) is ~57 years and would fire the alert on every cold start.
 *
 * The rejected third option was a background `setInterval` refreshing a module-level snapshot. It
 * keeps this function pure too, but it queries the DB on a timer whether or not anyone is scraping,
 * needs boot-only wiring so `bun test` never spins it (the convention every other scheduler in
 * server.ts follows), and adds a second lifecycle to shut down. A scrape-driven TTL cache does the
 * same job with no timer and no lifecycle.
 */
export function renderMetrics(
  schedulerFreshness?: readonly SchedulerFreshness[],
  onboarding?: OnboardingIntegrityCensus,
): string {
  const lines: string[] = [];

  lines.push(`# HELP ${SVC}_http_request_duration_seconds HTTP request latency.`);
  lines.push(`# TYPE ${SVC}_http_request_duration_seconds histogram`);
  for (const [key, s] of httpSeries) {
    const [method, route, statusClass] = key.split('\0') as [string, string, string];
    const lbl = `method="${esc(method)}",route="${esc(route)}",status="${statusClass}"`;
    // s.buckets[i] already holds the cumulative count (requests with duration <= BUCKETS[i]),
    // which is exactly the Prometheus `le` semantics — emit directly, don't re-accumulate.
    for (let i = 0; i < BUCKETS.length; i++) {
      lines.push(`${SVC}_http_request_duration_seconds_bucket{${lbl},le="${BUCKETS[i]}"} ${s.buckets[i]}`);
    }
    lines.push(`${SVC}_http_request_duration_seconds_bucket{${lbl},le="+Inf"} ${s.count}`);
    lines.push(`${SVC}_http_request_duration_seconds_sum{${lbl}} ${s.sum}`);
    lines.push(`${SVC}_http_request_duration_seconds_count{${lbl}} ${s.count}`);
  }

  lines.push(`# HELP ${SVC}_http_requests_total Total HTTP requests.`);
  lines.push(`# TYPE ${SVC}_http_requests_total counter`);
  for (const [key, s] of httpSeries) {
    const [method, route, statusClass] = key.split('\0') as [string, string, string];
    lines.push(
      `${SVC}_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${statusClass}"} ${s.count}`,
    );
  }

  for (const [name, value] of counters) {
    lines.push(`# TYPE ${SVC}_${name} counter`);
    lines.push(`${SVC}_${name} ${value}`);
  }

  // One `# TYPE` per metric NAME (Prometheus rejects a repeated TYPE for the same name), then one
  // sample per label value — including the values still at 0, which is the whole point.
  for (const [name, c] of labelledCounters) {
    lines.push(`# TYPE ${SVC}_${name} counter`);
    for (const [value, count] of c.values) {
      lines.push(`${SVC}_${name}{${esc(c.label)}="${esc(value)}"} ${count}`);
    }
  }

  // Process-local gauges. Iterated over the DECLARATION, not the map, so the rendered set is the
  // declared set by construction: a value that somehow reached the map without being declared cannot
  // render, and a declared gauge always renders even if nothing has ever set it (which is the
  // pre-seeding contract — see the ⛔ block on PRESEEDED_GAUGES).
  for (const spec of PRESEEDED_GAUGES) {
    lines.push(`# HELP ${SVC}_${spec.name} ${spec.help}`);
    lines.push(`# TYPE ${SVC}_${spec.name} gauge`);
    lines.push(`${SVC}_${spec.name} ${gauges.get(spec.name) ?? 0}`);
  }

  // A GAUGE, not a counter: the value is a point in time that can move backwards (a `scheduler_ticks`
  // row being reset, a family disappearing), and the only useful expression over it is
  // `time() - max by (scheduler)(…)` — the tick's AGE. `max by` is required, not decoration: every
  // replica renders its own cache of the same shared row, so the series exists once per pod and the
  // caches can differ by up to one TTL.
  //
  // Cardinality is `scheduler`, one label, bounded by the SIX families in host/tick-locks.ts
  // (`TICK_LOCK`: cycle, audit_export, translation, sandbox_sweep, budget, run-lease-reconciler) —
  // NOT by the row count, which grows by ~2/day forever. See the collapse note in
  // host/scheduler-freshness.ts.
  //
  // ⚠️ FOR WHOEVER WRITES THE GITOPS ALERT — three gaps this series does NOT cover on its own, all
  // established while verifying this change. The rule must not ship until the series is confirmed
  // scraped in prod, and when it is written it needs all three:
  //   • `time() - max by (scheduler)(…) > N` returns EMPTY, not true, if the group vanishes. If
  //     ALL pods restart during a DB outage nothing emits the series, the expression matches
  //     nothing, and the alert silently stops firing at exactly the moment it should. Pair it with
  //     `absent_over_time(commonpractice_scheduler_last_run_timestamp_seconds[15m])`.
  //   • A scheduler that has NEVER run has no `scheduler_ticks` row, so it emits no series and can
  //     never alert — the freshness metric cannot report a scheduler that was dead from boot.
  //     Symmetrically, a RETIRED scheduler's row is never deleted, so its age grows forever and it
  //     fires permanently. Both need a per-expected-scheduler `absent()` hard-coded against the six
  //     `TICK_LOCK` values above, reviewed whenever that object changes.
  //   • "scheduler dead" and "DB unreachable" look identical from this gauge alone — a failed read
  //     serves the last known values, so the age keeps growing either way. Disambiguate with
  //     `increase(commonpractice_scheduler_freshness_read_failures_total[15m]) > 0`.
  if (schedulerFreshness?.length) {
    lines.push(
      `# HELP ${SVC}_scheduler_last_run_timestamp_seconds Unix time of the most recent claimed tick per scheduler, from the scheduler_ticks table (max over that scheduler's dated claim keys).`,
    );
    lines.push(`# TYPE ${SVC}_scheduler_last_run_timestamp_seconds gauge`);
    for (const f of schedulerFreshness) {
      lines.push(
        `${SVC}_scheduler_last_run_timestamp_seconds{scheduler="${esc(f.scheduler)}"} ${f.lastRunAtSeconds}`,
      );
    }
  }

  // Onboarding-integrity census (host/onboarding-integrity.ts). Two GAUGEs, same reasoning as the
  // scheduler-freshness gauge above: these are database-derived point-in-time counts, passed in
  // rather than read here, so this function stays synchronous, pure and total.
  //
  // `commonpractice_tenants_unlicensed` is split into TWO label series — `resolvable="true"` and
  // `resolvable="false"` — rather than one unlabelled count, and BOTH are emitted even when zero.
  // An absent series and a zero series are not the same thing to an alert (see the PRESEEDED_COUNTERS
  // block above for the general form of that trap). The split exists because the two states are not
  // the same defect: the unresolvable tenant is a KNOWN, PERMANENT, human-shaped condition (it needs
  // a person, not a repair job, and will sit at >0 indefinitely), while the resolvable count is the
  // one the reconciler should be driving to, and keeping at, zero. A single `commonpractice_tenants_
  // unlicensed > 0` alert would therefore either page forever on the permanent case or, tuned to
  // ignore that, go blind to the case that is actually actionable. The alertable quantity is
  // `resolvable="true"`, which SHOULD normally read 0.
  if (onboarding) {
    lines.push(`# HELP ${SVC}_tenants_unlicensed Tenants currently missing a valid licence, split by whether the reconciler can repair them automatically.`);
    lines.push(`# TYPE ${SVC}_tenants_unlicensed gauge`);
    lines.push(`${SVC}_tenants_unlicensed{resolvable="true"} ${onboarding.tenantsUnlicensedResolvable}`);
    lines.push(`${SVC}_tenants_unlicensed{resolvable="false"} ${onboarding.tenantsUnlicensedUnresolvable}`);

    lines.push(`# HELP ${SVC}_signup_strand_pending Signups currently stranded mid-flow, awaiting reconciliation.`);
    lines.push(`# TYPE ${SVC}_signup_strand_pending gauge`);
    lines.push(`${SVC}_signup_strand_pending ${onboarding.signupStrandPending}`);

    lines.push(`# HELP ${SVC}_signup_strand_oldest_age_seconds Age in seconds of the oldest currently-stranded signup.`);
    lines.push(`# TYPE ${SVC}_signup_strand_oldest_age_seconds gauge`);
    lines.push(`${SVC}_signup_strand_oldest_age_seconds ${onboarding.signupStrandOldestAgeSeconds}`);

    // ⚠️ `signup_strand_pending` above counts APPROVAL ROWS. This counts PEOPLE, and the two do not
    // agree: measured in production 2026-09-04, 3 live users have no tenant while only 1 approval
    // row is pending. `queued="false"` is the strictly worse state — that person is not merely
    // waiting, they are absent from the onboarding queue entirely, so no human will ever see them
    // to action. Both labels are emitted at zero for the same absent-vs-zero reason as above.
    lines.push(`# HELP ${SVC}_users_without_tenant Live users holding no tenant, split by whether a signup_approvals row exists for them (queued="false" means invisible to the onboarding queue).`);
    lines.push(`# TYPE ${SVC}_users_without_tenant gauge`);
    lines.push(`${SVC}_users_without_tenant{queued="true"} ${onboarding.usersWithoutTenantQueued}`);
    lines.push(`${SVC}_users_without_tenant{queued="false"} ${onboarding.usersWithoutTenantUnqueued}`);
  }

  return lines.join('\n') + '\n';
}
