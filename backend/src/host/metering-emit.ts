// src/host/metering-emit.ts — OPTIONAL fleet cost-event emit (additive).
//
// CP is self-contained: host/llm-broker.ts writes a local `usage_events` ledger that
// host/usage-metrics.ts reads for /usage — that ledger remains the source of truth.
// This module ADDITIONALLY XADDs a cost event onto the shared `billing:costs` Redis
// stream after each metered LLM call so billing-service's fleet-wide cost rollup +
// per-correlation read (GET /api/costs/by-correlation) include CommonPractice.
//
// The event is a flat string→string map whose field names/types mirror the canonical
// shape in billing_service/docs/EMITTER_GUIDE.md EXACTLY, so billing's cost_flusher
// parses it unchanged (it prices every event from its own provider_pricing table —
// our cost_usd is advisory). DEFAULT OFF (config.metering.emitEnabled) and a clean
// no-op without a Redis URL. Best-effort: any Redis error is swallowed + logged so it
// can never break the LLM call or the local ledger write.
import { RedisClient } from 'bun';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { currentDbContext } from '../db/tenant-context';
import { log } from './logger';
import { incCounter, incLabelledCounter } from './metrics';

// ---- visibility (host/metrics.ts) ----
//
// ⛔ THE MEASUREMENT THAT PUT THESE HERE — AND ITS CORRECTION. On 2026-09-06 this header claimed
// `service_key='commonpractice'` had "0 rows and $0.00 in `billing_cost_events`, EVER". That was a
// count against a SHORT-RETENTION table read as "never arrived". Re-measured 2026-09-17: the raw
// table's oldest row was 2026-09-05 (~12 days live), while `billing_cost_daily` held 6 CP rows /
// 696 requests / $1.0008 from 2026-07-30 to 2026-08-10, exact against CP's own ledger on the days it
// ran. The emitter DID deliver. What was actually wrong: every one of those rows was
// `license_id = 0…0` / `attribution_status='unlicensed'` (uninvoiceable), and on 2026-09-02, 168
// metered calls produced 0 central rows with no record of why — the loss the outbox now prevents.
// ⚠️ Count a CP delivery against `billing_cost_daily`, never the raw events table alone.
//
// And until this change NOTHING IN THIS MODULE COULD SAY WHY. There were four distinct ways to
// produce that outcome and not one of them was counted: the flag off (a bare `return`), no sender
// (a bare `return`), a tenant that did not resolve (silently swallowed by the nil sentinel), and a
// throwing XADD (`log.warn` only — and gitops rules.yaml states that "loki has no `ruler` stanza,
// so log-based alerting cannot fire"). 19h of live pod logs showed ZERO emit-failure lines, which
// is equally consistent with "the path never runs" and "it returns on its first line". An emitter
// that cannot distinguish those is not instrumented, it is merely quiet.
//
// So: EVERY exit from `emitCostEvent` now increments exactly one series. `emitted + dropped` is the
// total number of metered calls that reached this function, which makes both "is it running at all"
// and "which of the four" answerable from one scrape.
export const EMIT_SUCCESS_COUNTER = 'metering_cost_event_emitted_total';
export const EMIT_DROPPED_COUNTER = 'metering_cost_event_dropped_total';
/** Rows written into `metering_outbox` (the numerator the drainer's `emitted` must converge to). */
export const OUTBOX_ENQUEUED_COUNTER = 'metering_outbox_enqueued_total';

/**
 * The CLOSED set of `reason` label values on `metering_cost_event_dropped_total`.
 *
 * ⚠️ MIRRORED in host/metrics.ts `PRESEEDED_LABELLED_COUNTERS`, which cannot import this file (that
 * would be a cycle — this module imports metrics). `tests/metrics-counter-preseed.test.ts` asserts
 * the two rosters are EQUAL in both directions: a reason added here but not there is silently lazy,
 * i.e. its first occurrence is invisible to `increase()`, which is precisely the failure mode this
 * whole change exists to remove.
 */
export const EMIT_DROP_REASONS = ['disabled', 'no_sender', 'no_tenant', 'send_failed'] as const;
export type EmitDropReason = (typeof EMIT_DROP_REASONS)[number];

/**
 * Count a drop and say so at WARN.
 *
 * ⛔ WARN, NOT DEBUG, AND THAT IS NOT A STYLE CHOICE. These services run at `LOG_LEVEL=INFO`
 * (host/logger.ts defaults to `info` and the gitops deployment does not override it), so a
 * `log.debug` here is not a quieter log line — it is a DELETED one. The counter is the alertable
 * signal; the log line is the only thing that carries the tenant/subject/correlation context needed
 * to chase an individual drop, and it has to survive to be worth writing.
 *
 * ⚠️ `reason="disabled"` LOGS AT WARN TOO, but ONCE PER PROCESS — not per call, and not at DEBUG.
 * The distinction matters in both directions. Demoting it to DEBUG would delete it at
 * `LOG_LEVEL=INFO`, which is the exact defect above. Logging it on every metered call would emit one
 * line per LLM call forever on every deployment that has not joined the fleet rollup, and a warn
 * channel that is always full is a warn channel nobody reads. One line per process is loud enough
 * to be seen in a pod's logs and quiet enough to stay meaningful. THE COUNTER IS NOT LATCHED — it
 * increments on every call, so the Prometheus view is exact and the log is merely the human
 * breadcrumb pointing at it.
 */
const warnedOnce = new Set<EmitDropReason>();

function dropEmit(reason: EmitDropReason, fields: Record<string, unknown>): void {
  incLabelledCounter(EMIT_DROPPED_COUNTER, reason);
  // Latched only for the configured steady state; a real fault warns every single time.
  if (reason === 'disabled') {
    if (warnedOnce.has(reason)) return;
    warnedOnce.add(reason);
  }
  log.warn('metering_cost_event_dropped', { component: 'metering', reason, ...fields });
}

// CP's cost_source + service_key. cost_source disambiguates CP's spend from other apps hitting the
// same provider; service_key is CP's stable short id.
// ⚠️ NOT YET in billing_service/docs/EMITTER_GUIDE.md's cost_source registry — an earlier version of
// this comment said it was, and it was not. Registering it is billing-side work.
export const COST_SOURCE = 'commonpractice';
export const SERVICE_KEY = 'commonpractice';

export interface CostEmitInput {
  /**
   * Effective tenant UUID. A null/empty value is a REFUSAL, not a fallback — the event is dropped
   * and counted `reason="no_tenant"`. See the ⛔ block on `buildCostEventFields`.
   */
  tenantId: string | null;
  /**
   * The licences-service SUBJECT UUID — WHO PAYS (`member_entitlements.license_subject_id`).
   *
   * ⛔ NOT `users.id`, which is what this field carried until migration 0090 and is exactly why 100%
   * of CP's central spend landed `attribution_status='unlicensed'`. Billing defines `subject_id` as
   * the licence holder's Subject; CP's own user id is a different identifier in a different system.
   * Empty when the member held no entitlement at settle time — never substituted.
   */
  subjectId: string;
  /** `member_entitlements.license_id` — the exact licence. Empty when there was none. */
  licenseId?: string | null;
  /** `users.keycloak_sub` — WHO ACTED. Empty for platform work, where no person acted. */
  actorId?: string | null;
  /** Idempotency key — the local `usage_events.id`. Billing's `derive_event_key` prefers it. */
  eventKey?: string | null;
  /** Whose credential paid the provider — drives `usage_extra.byo`. */
  credentialSource?: 'tenant_byo' | 'platform_managed' | 'none' | null;
  /** The provider's own reported charge, when it reported one. */
  vendorCostUsd?: number | null;
  /**
   * The VENDOR'S id for this generation — billing's `provider_request_id`, the key a disputed
   * invoice line is looked up by (`ai/llm/provider.ts LlmResult.providerRequestId`).
   *
   * ⛔ NEVER SYNTHESISE ONE. Absent/empty is the honest answer for every provider that exposes
   * nothing — today: `ai/llm/stub-provider.ts`, the deterministic `mockProvider`, and the raw
   * `anthropicProvider` / `openaiCompatibleProvider` shims in host/llm-broker.ts, which map the
   * adapter's result into a narrower shape that does not carry the field. It is sent as `''`,
   * exactly like an absent `license_id`, because billing parses `''` as "not reported" and counts
   * it — where a fabricated uuid would be a value that passes every check and answers no question.
   */
  providerRequestId?: string | null;
  /** Platform-initiated work (`BrokerCallMeta.platformActor`) — `usage_extra.origin='system'`. */
  platformActor?: boolean;
  /** When the call happened. Defaults to now; the outbox freezes it at settle time so a late
   *  delivery is still booked on the day the money was spent. */
  occurredAt?: Date;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Advisory only — billing recomputes USD from provider_pricing. */
  costUsd: number;
  latencyMs: number;
  /** The operation this cost ties back to (CP: flow run id / agent session id). */
  correlationId?: string;
  /** Optional sub-step label (CP: 'flow-run' | 'agent-chat' | 'content-translation' | …). */
  stage?: string;
}

/** A Redis command sender: (command, args) => Promise. Bun's RedisClient.send matches. */
export type RedisSender = (command: string, args: string[]) => Promise<unknown>;

// ---- test seam ----
// Tests inject an `enabled` flag and/or a fake `sender` so they never touch real Redis
// (and so the OFF path can be asserted without mutating the frozen config). `undefined`
// (the default) means "use config + the lazily-built Bun client".
interface MeteringTestOverrides {
  enabled?: boolean;
  sender?: RedisSender | null;
}
let testOverrides: MeteringTestOverrides | undefined;
export function __setMeteringOverridesForTests(o: MeteringTestOverrides | undefined): void {
  testOverrides = o;
}

let memoizedClient: RedisClient | undefined;

/**
 * Retry budget for the memoized client. `RedisClient` DOES auto-reconnect
 * (`autoReconnect` defaults true) — but `maxRetries` defaults to **10**, and a
 * transport outage longer than that budget exhausts it, after which the client
 * is dead for the life of the process.
 *
 * That is not hypothetical. fr#947 (2026-09-04): an Istio ambient **ztunnel**
 * pod was recreated under a running pod, and 39s later BOTH of that service's
 * Redis clients — two disjoint clusters — died in the same second and never
 * returned. It served 503 for ~1h45m until a human restarted it. ztunnel rolls
 * are routine: node reboots, Istio upgrades, DaemonSet changes.
 *
 * MEASURED there, redis in docker, identical 45s outage, options the only
 * variable:
 *
 *   defaults   connects=0  ping ok=13   err=107  finalConnected=false
 *   hardened   connects=1  ping ok=120  err=0    finalConnected=true
 *
 * ⚠️ CP fails DIFFERENTLY from fr, and more quietly. This module swallows every
 * Redis error by design and is default-off, so an exhausted client does not
 * announce itself with 503s — it silently stops emitting cost events onto
 * `billing:costs`, and CP's spend just stops appearing in billing's fleet
 * rollup. The local `usage_events` ledger stays correct, which is exactly what
 * makes the gap easy to miss.
 *
 * ⛔ Do NOT "clear `memoizedClient` on close" as a belt-and-braces — that is a
 * client LEAK: the close fires while Bun is still retrying, so discarding the
 * instance builds a second client racing the first, per disconnect. With
 * retries unbounded the SAME client recovers, so this one lever is the fix.
 */
const REDIS_CONNECTION_OPTIONS = {
  maxRetries: 2_147_483_647,
  connectionTimeout: 10_000,
} as const;

function defaultSender(): RedisSender | null {
  if (!config.metering.redisUrl) return null;
  if (!memoizedClient) {
    memoizedClient = new RedisClient(config.metering.redisUrl, REDIS_CONNECTION_OPTIONS);
  }
  const client = memoizedClient;
  return (command, args) => client.send(command, args);
}

/**
 * Build the flat string→string field map billing's cost_flusher parses. Pure + exported so a unit
 * test can assert the exact wire shape.
 *
 * ⛔ TAKES A NON-NULL TENANT, AND THE NIL-UUID SENTINEL IS GONE. This function used to read
 * `input.tenantId || '00000000-0000-0000-0000-000000000000'`, described as failing SAFE: billing's
 * cost_flusher coerces the nil UUID to `__unattributed__` and excludes it from billing side effects,
 * so an unattributable call was emitted rather than lost.
 *
 * That reasoning was superseded on 2026-08-26, when w2v_common REMOVED this exact sentinel under the
 * ruling that a `tenant_id` may never hold one. Billing now DEAD-LETTERS such an event as
 * `nil_tenant_id`. So the sentinel no longer buys attribution-at-a-lower-grade; it buys a row that
 * is thrown away at the far end, having consumed a stream slot and taught nobody anything. The
 * honest behaviour is to refuse locally and COUNT the refusal, which is what `emitCostEvent` now
 * does — `reason="no_tenant"` is a number an operator can read, where the sentinel was a value that
 * looked like an emit and was not.
 *
 * ⚠️ AND THE ASYMMETRY THAT MADE IT LOOK WORSE THAN IT MEASURES. The LOCAL ledger insert
 * (host/llm-broker.ts `settleSpend`) resolves its tenant as
 * `COALESCE(<explicit>, (SELECT tenant_id FROM users WHERE id = <userId>))`; `resolveEmitTenant`
 * below has no such `users` rung, so on paper the ledger could be attributed while the bus event was
 * a placeholder — for the same call, in the same function. That lookup IS available to this path and
 * is now wired (`RETURNING tenant_id` on that INSERT feeds `input.tenantId`), so the refusal is the
 * LAST resort rather than the first.
 *
 * ⛔ BUT DO NOT READ THAT AS THE CAUSE OF CP'S SILENCE — it is not, and the check matters more than
 * the story. `requireMeteringTenant()` throws unless an RLS tenant context is present, and every
 * metered path passes through it, so `resolveEmitTenant`'s context rung ALWAYS resolved and the nil
 * sentinel was structurally unreachable from the only caller. The fleet numbers agree: 0
 * nil-UUID-tenant rows anywhere. Removing the sentinel is correct on its own merits and makes the
 * remaining gap countable; it does not explain 0 rows in `billing_cost_events`, and anyone who ships
 * it and stops looking has changed a value on a path that emits nothing.
 */
export function buildCostEventFields(
  input: CostEmitInput & { tenantId: string },
): Record<string, string> {
  const intStr = (n: number): string => String(Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0)));
  // `usage_extra` carries the ownership flags billing's rollup derives `byo` / `owner_provided` from
  // (rollup_engine.py). EXACTLY ONE flag per event: a tenant-owned key is BYO (the customer paid the
  // provider, billing charges only the markup); platform work is `origin: system` so billing can tell
  // legitimate unattributed platform spend from a member whose attribution went missing.
  const extra: Record<string, unknown> = {};
  if (input.credentialSource === 'tenant_byo') extra.byo = true;
  if (input.platformActor) extra.origin = 'system';
  const vendor = input.vendorCostUsd;
  return {
    tenant_id: input.tenantId,
    // An absent licence is sent EMPTY, never a placeholder: billing parses '' → None and counts it,
    // where a fabricated id would be booked against a licence that did not pay.
    license_id: input.licenseId || '',
    subject_id: input.subjectId || '',
    actor_id: input.actorId || '',
    correlation_id: input.correlationId || '',
    stage: input.stage || '',
    // '' on purpose: billing DERIVES app_id from the exact licence (cost_flusher.py, "Derive the app
    // from the licence"), and an asserted value is never overwritten there — so sending a value CP
    // would have to resolve over the network adds a failure mode and no information.
    app_id: '',
    service_key: SERVICE_KEY,
    cost_source: COST_SOURCE,
    provider: input.provider,
    model: input.model,
    served_model: input.model,
    input_tokens: intStr(input.inputTokens),
    output_tokens: intStr(input.outputTokens),
    cache_creation_input_tokens: '0',
    cache_read_input_tokens: '0',
    cost_usd: (Number.isFinite(input.costUsd) ? input.costUsd : 0).toFixed(8),
    ...(vendor != null && Number.isFinite(vendor) ? { vendor_cost_usd: vendor.toFixed(8) } : {}),
    latency_ms: intStr(input.latencyMs),
    // ⚠️ THIS WAS A HARD-CODED `''` FROM THE DAY THE EMITTER SHIPPED, and the field read as though it
    // were being populated. Billing stores it for VENDOR RECONCILIATION — the join key when their
    // invoice and our ledger disagree — so a column that is empty on 100% of rows does not degrade
    // that workflow, it removes it, silently, while every schema check stays green.
    // `||` and not `??`: an empty string is as unusable to a reconciliation lookup as an absent one
    // and must fall back the same way (the same argument the `provider` fallback makes above).
    provider_request_id: input.providerRequestId || '',
    ...(input.eventKey ? { event_key: input.eventKey } : {}),
    usage_extra: JSON.stringify(extra),
    timestamp: (input.occurredAt ?? new Date()).toISOString(),
  };
}

/** Resolve the tenant for the emit: an explicit value wins, else the request's RLS
 *  tenant context (set by withTenantDb/withTenantTx), else null → a counted refusal.
 *
 *  ⚠️ This is the SECOND rung, not the first. The caller (host/llm-broker.ts) passes the tenant the
 *  local `usage_events` ledger actually recorded — `COALESCE(<explicit>, users.tenant_id)`, read back
 *  off the INSERT — and only falls through to this when that is NULL. Keeping the RLS-context rung
 *  here means a call metered inside a tenant transaction is still attributed even when the user row
 *  carries no tenant, so this change can only ever ADD attribution, never remove it. */
export function resolveEmitTenant(explicit: string | null | undefined): string | null {
  if (explicit) return explicit;
  const ctx = currentDbContext();
  return ctx?.tenantId || null;
}

function emitEnabled(): boolean {
  return testOverrides?.enabled ?? config.metering.emitEnabled;
}

/** The subset of a field map worth putting on a drop log line — no tokens, no cost. */
function logContext(fields: Record<string, string>): Record<string, string> {
  return {
    subjectId: fields.subject_id ?? '',
    correlationId: fields.correlation_id ?? '',
    stage: fields.stage ?? '',
    eventKey: fields.event_key ?? '',
  };
}

/**
 * ENQUEUE one cost event into `metering_outbox`, inside the caller's LEDGER transaction.
 *
 * ⛔ THIS REPLACES A `void` XADD FIRED AFTER COMMIT, AND THAT IS THE WHOLE POINT. The old shape could
 * commit a ledger row and then lose its cost event to any transport blip, with nothing recording that
 * it had ever been owed: on 2026-09-02, 168 metered calls produced 0 central rows and the cause is
 * unrecoverable. Written in the same transaction, a ledger row without a pending cost event is
 * unrepresentable, and a failed send is a retryable ROW rather than a log line.
 *
 * Refusals are counted here exactly as before (`disabled`, `no_tenant`) — enqueueing nothing for a
 * disabled deployment is deliberate: an outbox nobody drains would grow forever.
 */
export async function enqueueCostEvent(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  input: CostEmitInput & { eventKey: string },
): Promise<boolean> {
  const ctx = {
    subjectId: input.subjectId || '',
    correlationId: input.correlationId || '',
    stage: input.stage || '',
    eventKey: input.eventKey,
  };
  if (!emitEnabled()) {
    dropEmit('disabled', {
      ...ctx,
      hint: 'METERING_EMIT_ENABLED is not "true" — this deployment has not joined the fleet cost rollup',
    });
    return false;
  }
  if (!input.tenantId) {
    dropEmit('no_tenant', {
      ...ctx,
      hint: 'no tenant resolved from the ledger row, the explicit argument, or the RLS context — the call is unattributable and billing would dead-letter it as nil_tenant_id',
    });
    return false;
  }
  const fields = buildCostEventFields({ ...input, tenantId: input.tenantId });
  await tx.execute(
    sql`INSERT INTO metering_outbox (tenant_id, usage_event_id, fields)
        VALUES (${input.tenantId}::uuid, ${input.eventKey}::uuid, ${JSON.stringify(fields)}::jsonb)
        ON CONFLICT (usage_event_id) DO NOTHING`,
  );
  incCounter(OUTBOX_ENQUEUED_COUNTER);
  return true;
}

/**
 * XADD one prepared field map to `billing:costs`. Returns true only when Redis acknowledged it.
 *
 *  ⛔ EVERY EXIT IS COUNTED — see the visibility block at the top of this file. `emitted` means
 *  "reached the bus", never "was attempted". Never throws: the caller (the outbox drainer) decides
 *  what a failure means for its row. */
export async function sendCostEventFields(fields: Record<string, string>): Promise<boolean> {
  const ctx = logContext(fields);
  try {
    const sender =
      testOverrides && 'sender' in testOverrides ? testOverrides.sender : defaultSender();
    if (!sender) {
      dropEmit('no_sender', {
        ...ctx,
        hint: 'METERING_EMIT_ENABLED is "true" but METERING_REDIS_URL is empty — the flag is armed and the transport is not configured',
      });
      return false;
    }
    // XADD <stream> MAXLEN ~ 100000 * <k1> <v1> <k2> <v2> ...
    const args: string[] = [config.metering.costsStream, 'MAXLEN', '~', '100000', '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    await sender('XADD', args);
    incCounter(EMIT_SUCCESS_COUNTER);
    return true;
  } catch (err) {
    dropEmit('send_failed', { ...ctx, err });
    log.warn('metering_cost_event_emit_failed', { component: 'metering', err });
    return false;
  }
}

/** Build + send in one step, for callers with no ledger transaction (and the wire-shape tests).
 *  The brokered LLM path does NOT use this: it enqueues (see `enqueueCostEvent`). */
export async function emitCostEvent(input: CostEmitInput): Promise<void> {
  const ctx = {
    subjectId: input.subjectId || '',
    correlationId: input.correlationId || '',
    stage: input.stage || '',
  };
  if (!emitEnabled()) {
    dropEmit('disabled', {
      ...ctx,
      hint: 'METERING_EMIT_ENABLED is not "true" — this deployment has not joined the fleet cost rollup',
    });
    return;
  }
  if (!input.tenantId) {
    dropEmit('no_tenant', {
      ...ctx,
      hint: 'no tenant resolved from the ledger row, the explicit argument, or the RLS context — the call is unattributable and billing would dead-letter it as nil_tenant_id',
    });
    return;
  }
  await sendCostEventFields(buildCostEventFields({ ...input, tenantId: input.tenantId }));
}
