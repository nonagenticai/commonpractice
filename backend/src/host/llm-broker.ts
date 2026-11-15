// src/host/llm-broker.ts — the TRUSTED, metered LLM gateway (SPEC §5, the single
// most important governance decision). The runner's ctx.llm() has no provider
// key; it round-trips here. Before every call this:
//   1. locks the caller's usage_counters row for today (SELECT … FOR UPDATE) so
//      concurrent runs can't race past the cap,
//   2. rejects if the daily call cap or weekly spend ceiling would be exceeded
//      (no provider call, no spend) → the runner sees a `llm_capped` rejection,
//   3. otherwise calls the provider (S3 = deterministic mock; S7 flips to real
//      Anthropic), meters tokens + cost into the ledger, and returns the result.
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import { config } from '../config';
import { routerCredential } from '../services/tenant-inference';
import { getSnapshot } from './policy-store';
import type {
  LlmRequestPayload,
  LlmResult,
  BlockErrorRule,
  BlockErrorDetail,
} from '../db/trace-types';
import type {
  LlmProvider,
  LlmRequest,
  LlmResult as ChatResult,
} from '../ai/llm/provider';
import type { LlmProviderCallOpts } from '../ai/llm/provider';
import { estimateTokens } from '../ai/llm/provider';
import { stubProvider } from '../ai/llm/stub-provider';
import {
  resolveChatProvider,
  resolveTenantChatProviderIfConfigured,
  type CredentialSource,
} from '../ai/llm/select';
import {
  assertPlatformCredentialAllowed,
  assertPlatformLocalOnly,
  PlatformLocalOnlyError,
  TenantByoKeyRequiredError,
} from '../services/byo-posture';
import { OpenAiProvider, LlmProviderHttpError } from '../ai/llm/adapters/openai';
import { governedLlmFetch } from '../ai/llm/egress-fetch';
import {
  parsePricingTable,
  priceCall,
  tenantChargeUsd,
  type PriceSource,
  type PricingTable,
} from '../ai/llm/pricing';
import { defaultModelPricing } from '../ai/llm/provider-catalog';
import { enqueueCostEvent, resolveEmitTenant } from './metering-emit';
import { log } from './logger';
import { incCounter } from './metrics';
import { seatMemberInline } from '../services/inline-seat';

/** Optional cost-correlation metadata threaded from the caller into the broker so the
 *  OPTIONAL shared `metering:costs` emit can tie each LLM cost back to an operation.
 *  Purely additive — absent fields just emit empty correlation/stage. */
export interface BrokerCallMeta {
  /** Operation id (CP: flow run id on the runner path, agent session id on chat). */
  correlationId?: string;
  /** Optional sub-step label (CP: 'flow-run' | 'agent-chat' | 'content-translation' | …). */
  stage?: string;
  /**
   * ⛔ THIS IS GOVERNANCE, NOT CORRELATION. Every other field in this interface is inert
   * metadata that only decorates a ledger row; this one is the single field that changes what
   * the broker DOES. Read the list below before setting it anywhere.
   *
   * Set it ONLY for work the PLATFORM itself initiated with no human in the loop — today, the
   * translation drainer. It says "this call is not a person spending their allowance". Concretely
   * it does exactly two things:
   *   • the per-user DAILY CALL CAP (`spend.daily_llm_cap` vs `llm_calls`) is not applied, and
   *   • the call is counted into `usage_counters.platform_llm_calls` instead of `llm_calls`
   *     — on the reserve AND on the release, so a provider failure hands back the PLATFORM's
   *     slot and never steals one from the human in `requested_by` (migration 0061).
   *
   * It does NOT skip, and must never be extended to skip:
   *   • the models.allowlist check,
   *   • `requireMeteringTenant()` — an unscoped platform call is still refused outright,
   *   • the WEEKLY SPEND CEILING — this is the bound that survives, and the whole reason a call
   *     cap could be dropped safely. Platform work can never spend real money without limit.
   *   • `settleSpend` — `spend_usd` is shared, not split,
   *   • the `usage_events` ledger row, or the fleet cost emit.
   *
   * ⚠ `spend_usd` sharing is DELIBERATE, not an oversight — and as of 2026-08-12 it is no longer
   * free. When this paragraph was first written (2026-08-08), `local-llm` — the only model any
   * platform caller has ever used — priced at exactly $0.00 (the pre-correction `ZERO_COST_MODELS`
   * era; see `ai/llm/pricing.ts`), so filing a platform row under the human's `user_id` cost that
   * human nothing, and that was the whole justification for sharing the row instead of splitting
   * it. The 2026-08-12 pricing correction (`ai/llm/pricing.ts:32-61`) deliberately stopped pricing
   * `local-llm` at zero — specifically because a `0 + 0 > ceiling` check can never refuse anything,
   * which made the weekly spend ceiling structurally unreachable. Since then platform rows carry
   * real notional cost: measured live, `platform_actor=true` rows total $0.238499 across 917 rows,
   * spread over at least 9 distinct real human `user_id`s (168 rows / $0.173 on 2026-09-02 alone).
   * That cost is real and it lands on a real customer's `spend_usd` — which remains CORRECT and
   * intentional, not a bug: the operator's standing decision is that platform usage is always
   * attributed to a customer, and the WEEKLY SPEND CEILING bullet above is exactly the bound that
   * makes sharing the row safe rather than silent. What expired is only the premise that it didn't
   * matter because it was free. Because /usage (host/usage-metrics.ts) still correctly excludes
   * `platform_actor` rows from every human-facing total — nobody should be BILLED for the
   * drainer's work — that premise's expiry made platform cost invisible everywhere, not just
   * harmless; `getTenantUsage`'s `platformSpendUsd` / `platformCalls` fields are where it is now
   * measured separately, per tenant, without changing this attribution.
   *
   * Typed as the LITERAL `true`, not `boolean`, on purpose: a governance bypass must be written
   * out at its call site by a human. `boolean` would let it arrive from a config flag, a
   * `...spread` of some wider object, or an `isBackground` variable, with no cast and no review.
   * `platformActor: someBoolean` is a type error; `platformActor: true` is a decision.
   */
  platformActor?: true;
}

/**
 * Why a brokered call was refused.
 *   llm_capped        — a CP governance quota (per-user daily calls / weekly spend).
 *   model_not_allowed — the model is not on the governance allowlist.
 *   budget_exhausted  — the PROVIDER refused for lack of credit: the tenant's welcome budget (or
 *                       their own account balance) is spent. Distinct from llm_capped because the
 *                       remedy is different — top up or switch provider, not wait for tomorrow.
 */
export type BrokerRejectionKind =
  | 'llm_capped'
  | 'model_not_allowed'
  | 'budget_exhausted'
  // The caller is a member of this workspace with no CommonPractice seat. Distinct from
  // `llm_capped` because nothing the person does — waiting for tomorrow, spending less — clears it:
  // an administrator has to give them a seat. See `assertMemberSeat`.
  | 'seat_required';

/**
 * The MACHINE half of a governance refusal: which rule, and the identifiers its sentence names.
 *
 * ⛔ WHY THE BROKER AND NOT THE RUNNER. A refused brokered call reaches a block author through
 * `ctx.llm()` and lands in `node_error.error`, which /build's run console renders. Until now only
 * `{error, kind}` crossed the `llm_response` frame, so `daily LLM call cap reached (200)` and the
 * "Add your own provider key in Administer → LLM settings" paragraph were rendered VERBATIM to a
 * Dutch, Polish or Arabic reader. The runner cannot recover the rule from that prose without
 * parsing English — so the rule is attached HERE, where `limits.dailyLlmCap` and `model` are still
 * values rather than words. `BlockErrorRule` names this group `host/` for exactly that reason.
 *
 * ⚠️ The English `message` stays byte for byte: `ai/agent.ts` and the chat surface render it, and
 * `mcp/tools.ts`'s reader is an LLM, for which English is correct.
 */
export interface BrokerRefusal {
  rule: BlockErrorRule;
  detail?: BlockErrorDetail;
}

// `model` is the EFFECTIVE model the call ran (or was refused) on — after the "a block that names
// no model gets AGENT_MODEL / the tenant's configured model" resolution below. The run controller
// audits it, so a block that names no model records what actually ran instead of `undefined`.
export type BrokerOutcome =
  | { ok: true; result: LlmResult; warn?: 'approaching_cap'; model?: string }
  | ({ ok: false; error: string; kind: BrokerRejectionKind; model?: string } & Partial<BrokerRefusal>);

// The chat-path outcome (the agent loop). Same gate/ledger as the runner path; the
// result is chat-shaped (text and/or tool calls) and carries the metered cost so the
// loop can surface a live quota readout.
export type ChatBrokerOutcome =
  | { ok: true; result: ChatResult; costUsd: number; warn?: 'approaching_cap' }
  | ({ ok: false; error: string; kind: BrokerRejectionKind } & Partial<BrokerRefusal>);

/** Thrown by brokerChatStream when the call is refused BEFORE any token streams (so the agent
 *  surfaces the same outcome as the non-streaming path, which returns it as a value). A streaming
 *  generator can't return a structured rejection, so it throws.
 *
 *  ALL THREE kinds are reachable from here: `llm_capped` / `model_not_allowed` come from
 *  `reserveCall` before the provider is touched, and `budget_exhausted` from the provider's own
 *  402/403/429, which the adapter raises on `!res.ok` — before the first SSE frame. */
export class BrokerRejection extends Error {
  constructor(
    readonly kind: BrokerRejectionKind,
    message: string,
    /** See `BrokerRefusal` — the rule + tokens the RUNNER path forwards to the browser. Optional
     *  because the chat/agent path reads only `kind` and `message`. */
    readonly refusal?: BrokerRefusal,
  ) {
    super(message);
    this.name = 'BrokerRejection';
  }
}

/** One streamed step toward the agent: a text delta, or the terminal `done` carrying
 *  the assembled result (text + accumulated tool calls + usage) + the settled cost. */
export type ChatStreamChunk =
  | { type: 'text'; text: string }
  | {
      type: 'done';
      result: ChatResult;
      /** The LEDGER figure (usage_events.cost_usd) — notional for local inference. */
      costUsd: number;
      /** What the tenant pays for this call: 0 for platform-paid local inference, else `costUsd`.
       *  The figure to SHOW a tenant (pricing.ts `tenantChargeUsd`). */
      tenantCostUsd: number;
      warn?: 'approaching_cap';
    };

export interface GovernanceLimits {
  dailyLlmCap: number;
  weeklySpendUsd: number;
  /** Session 6: the models.allowlist policy. Empty/undefined = no allowlist check
   *  (back-compat for tests that inject only the two numeric limits). */
  allowlistedModels?: string[];
  /** The live `models.pricing` table (migration 0053). Undefined = price from the catalog
   *  defaults; same back-compat shape as `allowlistedModels`. */
  modelPricing?: PricingTable;
}

/** A raw provider call — returns text + token counts (+ the provider's own charge when it
 *  reports one); pricing is applied here. */
export type Provider = (
  req: LlmRequestPayload & { model: string },
) => Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  /** What the gateway actually served, when it says so. See `LlmResult.servedModel`. */
  servedModel?: string;
  servedProvider?: string;
  /** The provider's own id for this generation — what a vendor invoice line is looked up by.
   *  Absent for the stub and for any adapter that exposes none; see `LlmResult.providerRequestId`. */
  providerRequestId?: string;
}>;

/** The transaction handle `deps.db.transaction` hands its callback — derived rather than named, so
 *  it cannot drift from the driver's own type. */
type BrokerTx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

export interface BrokerDeps {
  db: typeof defaultDb;
  provider: Provider;
  /** The chat-shaped provider for the agent loop (the runner uses `provider`).
   *  Defaults to the deterministic stub; S7 selects a real adapter. */
  chatProvider: LlmProvider;
  /** May be sync (test injection) or async (the real policy-store read). */
  limits: () => GovernanceLimits | Promise<GovernanceLimits>;
  /** TEST-ONLY, read only when `chatProvider` is injected: the preset/credential the injected
   *  provider stands in for. Production resolves both from the tenant's settings (select.ts). */
  chatSelection?: { presetKey?: string; credentialSource?: CredentialSource };
}

// ---- providers ----

/** Deterministic mock: valid JSON when the prompt asks for JSON (so blocks that
 *  JSON.parse the result don't crash), else a short summary line. */
export const mockProvider: Provider = async (req) => {
  const wantsJson = /\bjson\b/i.test(req.prompt);
  const text = wantsJson
    ? '{}'
    : `Mock summary: ${req.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  const tokensIn = Math.max(1, Math.ceil(req.prompt.length / 4));
  const tokensOut = Math.max(1, Math.ceil(text.length / 4));
  return { text, tokensIn, tokensOut };
};

/**
 * The runner's ctx.llm() provider for LLM_MODE=openai_compatible — the in-cluster inference-router
 * (OPENAI_BASE_URL), carrying a SPECIFIC router credential: a tenant's own inference-router licence
 * token or the platform's (services/tenant-inference.ts `routerCredential`).
 *
 * ⛔ THERE IS NO ENV-KEYED VARIANT ANY MORE, AND NO ANTHROPIC PROVIDER. Both carried a platform
 * provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); CP holds none (owner rule 2026-10-13). A
 * placeholder bearer (`EMPTY`) is refused by `adapters/openai.ts` before any request to the router.
 */
export const openaiCompatibleProviderWithKey = (apiKey: string): Provider => async (req) => {
  if (!config.llm.openaiBaseUrl) {
    throw new Error('LLM_MODE=openai_compatible but OPENAI_BASE_URL (the inference-router) is unset');
  }
  if (!apiKey) {
    throw new Error('LLM_MODE=openai_compatible but no inference-router credential was resolved');
  }
  const adapter = new OpenAiProvider({
    apiKey,
    model: req.model,
    baseUrl: config.llm.openaiBaseUrl,
    // ⛔ THE RUNNER'S `ctx.llm()` WAS THE ONE LLM EGRESS NOBODY GOVERNED. `ai/llm/select.ts`
    // (buildAdapter) passes `governedLlmFetch()` into every TENANT-resolved adapter, so a chat call
    // to an external provider passes models.external_http + data.egress_allowlist + the SSRF
    // hard-block. This provider — the one `LLM_MODE=openai_compatible` selects, which is what prod
    // runs — constructed the SAME adapter class with NO fetchImpl, so it fell through to bare
    // `fetch`. Point OPENAI_BASE_URL at any external host and a block's ctx.llm() reached it with
    // the allowlist switched off and no record of the decision. In-cluster targets (the
    // inference-router, the normal prod path) pass straight through the gate unchanged.
    fetchImpl: governedLlmFetch(),
  });
  const r = await adapter.chat(
    {
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    },
    { signal: AbortSignal.timeout(config.llm.callTimeoutMs) },
  );
  return {
    text: r.text ?? '',
    tokensIn: r.usage.tokensIn,
    tokensOut: r.usage.tokensOut,
    // Conditional spread so a provider that reports nothing yields exactly the old shape.
    ...(r.servedModel ? { servedModel: r.servedModel } : {}),
    ...(r.servedProvider ? { servedProvider: r.servedProvider } : {}),
  };
};



/** Session 6: reads the LIVE policy store (cached ≤5s) instead of config
 *  constants. config.governance.* is the fallback baked into buildSnapshot when a
 *  policy row is absent. Async — brokerLlmCall awaits it. */
export async function getGovernanceLimits(): Promise<GovernanceLimits> {
  const s = await getSnapshot();
  return {
    dailyLlmCap: s.dailyLlmCap,
    weeklySpendUsd: s.weeklySpendUsd,
    allowlistedModels: s.allowlistedModels,
    modelPricing: s.modelPricing,
  };
}

/**
 * Does this provider failure mean "no credit left"?
 *
 * OpenRouter answers 402 when a key's dollar `limit` is exhausted, and 403 on a workspace budget
 * overage; other OpenAI-compatible providers use 429 with an "insufficient credit"-style message.
 * Matching on status first and the message only as a fallback keeps this from misreading an
 * ordinary rate-limit as an exhausted budget.
 */
/**
 * The prose that accompanies a `budget_exhausted` refusal.
 *
 * ⛔ ONE CONSTANT, TWO PATHS. `runMetered` (non-streaming) and `brokerChatStream` (the agent chat
 * loop) both classify a provider credit failure, and both must say the same thing — this is the
 * mid-rolling-deploy fallback the browser renders when it cannot map the `kind`, so two copies
 * drifting apart is two different answers to the same refusal on two surfaces.
 *
 * It stays ENGLISH on purpose: the host composing it does not know who is reading. The localizable
 * half is the `kind`, which both paths now carry.
 *
 * ⛔ THE PATH IS THE ONE THE SHELL SHOWS TODAY: the settings gear → Organisation → LLM settings.
 * It said "Administer → LLM settings" after the sidebar's Administer group was retired, which sent
 * the reader to a menu that no longer exists. Pinned by `tests/budget-exhausted-message.test.ts`.
 */
export const BUDGET_EXHAUSTED_MESSAGE =
  'The LLM budget for this workspace is exhausted. Add your own provider key in ' +
  'Settings → Organisation → LLM settings, or ask your Common Practice contact to top up the budget.';

export function isCreditExhaustion(err: unknown): boolean {
  if (!(err instanceof LlmProviderHttpError)) return false;
  if (err.status === 402) return true;
  const text = err.bodyText.toLowerCase();
  if (err.status === 403 || err.status === 429) {
    return (
      text.includes('credit') ||
      text.includes('quota') ||
      text.includes('budget') ||
      text.includes('billing') ||
      text.includes('limit exceeded')
    );
  }
  return false;
}

/**
 * Price a completed call, and record WHERE the price came from.
 *
 * Replaces the old `priceUsd(tokensIn, tokensOut)`, which multiplied everything by two flat
 * constants regardless of model or vendor — so a $0 local call and a free OpenRouter call were
 * both billed at Claude-Sonnet rates. See ai/llm/pricing.ts for the precedence rules.
 *
 * `limits.modelPricing` is undefined only for tests that inject the two numeric limits directly;
 * production always carries the live `models.pricing` row. The catalog defaults are the fallback
 * so an unseeded DB still prices `local` at zero rather than at the flat rate.
 */
function priceFor(
  limits: GovernanceLimits,
  presetKey: string | undefined,
  model: string,
  tokensIn: number,
  tokensOut: number,
  reportedCostUsd?: number,
): { costUsd: number; priceSource: PriceSource } {
  const { costUsd, source } = priceCall({
    presetKey,
    model,
    tokensIn,
    tokensOut,
    reportedCostUsd,
    table: limits.modelPricing ?? parsePricingTable(defaultModelPricing()),
    flatInRateUsd: config.llm.inRateUsd,
    flatOutRateUsd: config.llm.outRateUsd,
  });
  return { costUsd, priceSource: source };
}

/** Coarse provider label for the usage_events ledger on the runner path (the chat
 *  path uses the resolved providerKind). 'mock' is the deterministic S3 provider. */
function runnerProviderLabel(): string {
  return config.llm.mode; // 'openai_compatible' | 'mock'
}

const defaults: BrokerDeps = {
  db: defaultDb,
  // The mock. `LLM_MODE=openai_compatible` never reaches this default: `brokerLlmCall` always builds
  // the router provider with a router credential for it.
  provider: mockProvider,
  // Safe default; brokerChatCall resolves the real per-tenant adapter at call time
  // (select.ts). Tests inject chatProvider via __setBrokerDepsForTests, bypassing it.
  chatProvider: stubProvider,
  limits: getGovernanceLimits,
};
let overrides: Partial<BrokerDeps> | undefined;

/** Test seam (mirrors __setAuthOverridesForTests). Inject a fake provider/limits. */
export function __setBrokerDepsForTests(d: Partial<BrokerDeps> | undefined): void {
  overrides = d;
}

/** Token counts every metered provider call must report. */
interface ProviderTokens {
  tokensIn: number;
  tokensOut: number;
  /** The provider's own charge for this call, when it reported one (OpenRouter). Absent — NOT
   *  zero — when unreported; the broker then prices from the table. */
  costUsd?: number;
  /** What the gateway actually served, when it says so. See `LlmResult.servedModel`. */
  servedModel?: string;
  servedProvider?: string;
  /** The provider's own id for this generation — what a vendor invoice line is looked up by.
   *  Absent for the stub and for any adapter that exposes none; see `LlmResult.providerRequestId`. */
  providerRequestId?: string;
}

/** The discriminated outcome of the shared meter (so the txn callback + the captured
 *  `outcome` keep their narrowing instead of widening `ok` to `boolean`). */
type MeteredOutcome<R> =
  | { ok: true; warn?: 'approaching_cap'; result: R; costUsd: number }
  | ({ ok: false; error: string; kind: BrokerRejectionKind } & Partial<BrokerRefusal>);

/**
 * Bound `invoke()` with the SAME `config.llm.callTimeoutMs` ceiling `ai/llm/select.ts`'s
 * `withCallTimeout` uses (same config knob, same `AbortSignal.timeout` primitive) — applied
 * here, at the one choke point BOTH the runner path (brokerLlmCall) and the chat path
 * (brokerChatCall) already call `invoke()` through, so every provider is bounded regardless
 * of which one `chooseProvider()`/`resolveChatProvider()` picked, including ones that don't
 * (or stop) honouring their own `signal`. This does not abort the underlying provider call —
 * a provider that ignores its AbortSignal keeps its socket open on the host — but it
 * guarantees the CALLER (runMetered's catch below) moves on: releaseCall still runs and the
 * run reaches a terminal rejection instead of hanging forever. The `.then` below always
 * attaches a handler to the real `invoke()` promise so a late rejection from an abandoned
 * call never surfaces as an unhandled rejection.
 */
function withInvokeTimeout<R>(invoke: () => Promise<R>): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    const deadline = AbortSignal.timeout(config.llm.callTimeoutMs);
    const onTimeout = () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(`LLM provider call exceeded callTimeoutMs (${config.llm.callTimeoutMs}ms)`),
      );
    };
    deadline.addEventListener('abort', onTimeout, { once: true });
    invoke().then(
      (result) => {
        if (settled) return;
        settled = true;
        deadline.removeEventListener('abort', onTimeout);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        deadline.removeEventListener('abort', onTimeout);
        reject(err);
      },
    );
  });
}

/** The shared cap/lock/meter transaction (SPEC §5: the single most important
 *  governance decision). Both the runner path (brokerLlmCall) and the agent-loop
 *  path (brokerChatCall) run through this so spend is metered identically and the
 *  provider key never leaves the host. `invoke` performs the actual provider call
 *  AFTER the gate passes and reports tokens for the ledger. */
async function runMetered<R extends ProviderTokens>(
  deps: BrokerDeps,
  userId: string,
  provider: string,
  model: string,
  invoke: () => Promise<R>,
  tenantId?: string | null,
  meta?: BrokerCallMeta,
  /** The resolved vendor (provider-catalog preset). Drives per-model pricing; undefined falls
   *  back to the model-level rules then the flat estimate. */
  presetKey?: string,
  reservationTokens: { inputTokens: number; maxOutputTokens: number } = {
    inputTokens: 0,
    maxOutputTokens: 4096,
  },
  /** Whose credential paid the provider — recorded on the ledger + cost event (migration 0090). */
  credentialSource?: CredentialSource,
): Promise<MeteredOutcome<R>> {
  const limits = await deps.limits();
  const reservationUsd = priceFor(
    limits,
    presetKey,
    model,
    Math.max(0, reservationTokens.inputTokens),
    Math.max(0, reservationTokens.maxOutputTokens),
  ).costUsd;
  // Narrowed to a real boolean ONCE, here, and then threaded to BOTH reserveCall and releaseCall.
  // `=== true` rather than a truthiness test because the field is typed as the literal `true`: an
  // explicit comparison keeps this honest if that type is ever widened by accident.
  const platform = meta?.platformActor === true;

  // 1. RESERVE — allowlist + daily-cap + weekly-ceiling checks, then claim the daily-call slot,
  //    all inside ONE SHORT transaction that does not outlive a few statements.
  let warn: 'approaching_cap' | undefined;
  try {
    ({ warn } = await reserveCall(deps, userId, model, limits, reservationUsd, platform));
  } catch (err) {
    if (err instanceof BrokerRejection) {
      // ⛔ SPREAD, NOT `rule: err.refusal?.rule`. An explicit `rule: undefined` survives
      // `JSON.stringify` as an absent key on the frame but reappears as `"rule": null` once the
      // browser's `!err.rule` guard is replaced by someone's `d && …`. Emitting neither key is the
      // shape that cannot be misread — the same argument `flow-executor.ts`'s `ruleOf` makes.
      return { ok: false, kind: err.kind, error: err.message, ...(err.refusal ?? {}) };
    }
    throw err;
  }

  // 2. PROVIDER CALL — deliberately OUTSIDE any transaction, and bounded by
  //    withInvokeTimeout (config.llm.callTimeoutMs — same knob select.ts's
  //    withCallTimeout uses) so a hung provider can never hold this open forever.
  //
  // This used to run between `SELECT … FOR UPDATE` on usage_counters and the ledger INSERT, so a
  // slow or hung provider held a database transaction (and that row lock) for its whole duration.
  // With DB_TX_POOL_MAX=4, four concurrent hung calls exhausted the transaction pool and deadlocked
  // the process — the same failure shape that produced the dedicated tx pool in the first place.
  // The streaming path already solved this with reserve/settle; this is the same split, so there is
  // one mechanism, not two.
  let out: R;
  const t0 = performance.now();
  try {
    out = await withInvokeTimeout(invoke);
  } catch (err) {
    // The slot was claimed up front, so hand it back — a provider outage must not silently burn a
    // user's daily quota. Best-effort and never masks the original error.
    // `platform` MUST match what reserveCall was given: the release has to decrement the same
    // column the reserve incremented, or a failed platform call refunds a slot the human never
    // spent (see 0061's alternative (c)).
    await releaseCall(deps, userId, reservationUsd, platform);
    // A provider "out of credit" is an ACTIONABLE outcome, not a crash: the tenant's welcome budget
    // (or their own balance) is spent, and the remedy is in LLM settings.
    if (isCreditExhaustion(err)) {
      return {
        ok: false,
        kind: 'budget_exhausted',
        error: BUDGET_EXHAUSTED_MESSAGE,
        rule: 'llm_budget_exhausted',
      };
    }
    throw err;
  }
  const latencyMs = performance.now() - t0;

  // 3. SETTLE — a short txn adds the metered spend and appends the ledger row (and fires the
  //    OPTIONAL fleet cost emit, which never throws).
  //
  // Meter what was SERVED, not what was asked for. The in-cluster inference-router answers an
  // unknown model with 200 + a substitution rather than a 404, so pricing the requested id billed
  // Claude rates for free local inference and burned the weekly ceiling that gates service.
  // `presetKey` is dropped alongside it: it names the vendor the tenant *selected*, which is by
  // definition wrong once the gateway routed elsewhere, so pricing falls back to the model-level
  // rules and then the flat estimate. (That parenthetical used to read "`local-llm` is zero-cost
  // by construction" — no longer true, and the substitution case is now precisely one of the paths
  // that prices local inference notionally at the flat tier; see ai/llm/pricing.ts.) Absent
  // `servedModel` — every direct provider — leaves both untouched, so this is a no-op off the
  // router path.
  const substituted = !!out.servedModel && out.servedModel !== model;
  const meteredModel = out.servedModel ?? model;
  const meteredPreset = substituted ? undefined : presetKey;
  if (substituted) {
    log.warn('broker_model_substituted', {
      requestedModel: model,
      servedModel: out.servedModel,
      servedProvider: out.servedProvider,
      hint:
        'metering the served model — the requested model is allowlisted but not reachable, ' +
        'reconcile models.allowlist with what the router actually serves',
    });
  }
  const { costUsd, priceSource } = priceFor(
    limits,
    meteredPreset,
    meteredModel,
    out.tokensIn,
    out.tokensOut,
    out.costUsd,
  );
  //
  // ⛔ GUARDED, and the guard RETURNS THE ANSWER ANYWAY. `settleSpend`'s body is one
  // `deps.db.transaction`; a pool exhaustion or an `08P01` (both have happened on this
  // deployment) throws right here — AFTER a provider call that already succeeded and is already
  // paid for. Unguarded, that exception propagated out of `runMetered` and destroyed `out`: the
  // caller lost an answer the money had already bought. The live symptom is a flow run failing
  // after its LLM step succeeded and was billed (`host/run-controller.ts` is the one consumer
  // that reaches this line — the streaming path `brokerChatStream` runs its own reserve/settle
  // with a `finally`, and has already handed its tokens to the client by the time it settles).
  //
  // This is the SAME direction of protection `settleSpend` already argues for internally at its
  // row-count assertion ("by the time we get here the money is already spent; throwing would lose
  // the usage_events row, which is the more authoritative record") — one layer out. There the
  // ledger outranks the counter; here the paid-for ANSWER outranks both, because losing it wastes
  // the spend a second time on the retry.
  //
  // What is lost when this fires: the `usage_events` ledger row and the counter's `spend_usd`
  // increment. There is no reservation reaper (the only writers of `reserved_spend_usd` are
  // reserveCall / releaseCall / settleSpend), so the console.error below carries everything needed
  // to reconstruct the row by hand, and the reservation is released best-effort so it does not
  // sit on the ceiling until midnight.
  try {
    await settleSpend(
      deps,
      userId,
      out.servedProvider ?? provider,
      meteredModel,
      out.tokensIn,
      out.tokensOut,
      costUsd,
      priceSource,
      tenantId,
      latencyMs,
      meta,
      reservationUsd,
      // The vendor for the fleet cost event. `meteredPreset` is exactly the value `priceFor` was
      // given two statements above, so the bus event and CP's own price are keyed on ONE vendor
      // decision rather than two — including the substitution case, where it is deliberately
      // undefined and the `provider` argument (already `out.servedProvider ?? provider`) carries
      // whatever the router said it actually served.
      meteredPreset,
      credentialSource,
      out.providerRequestId,
    );
  } catch (err) {
    log.error('broker_settle_failed_after_paid_call', {
      hint:
        'the answer was returned to the caller anyway; the usage_events ledger row was NOT ' +
        'written and the daily counter is understated by this amount',
      userId,
      tenantId: tenantId ?? null,
      provider: out.servedProvider ?? provider,
      model: meteredModel,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      costUsd,
      priceSource,
      reservationUsd,
      latencyMs: Math.round(latencyMs),
      correlationId: meta?.correlationId ?? null,
      stage: meta?.stage ?? null,
      platformActor: meta?.platformActor === true,
      err,
    });
    // Release the SPEND reservation only. ⛔ NOT `releaseCall` — that also decrements the daily
    // call counter, and the call genuinely happened: the user spent that slot, the provider ran,
    // and refunding it would let them exceed `spend.daily_llm_cap` by one call for every settle
    // failure. Governance quota and money are separate ledgers here on purpose.
    await releaseReservedSpend(deps, userId, reservationUsd);
  }
  return { ok: true, ...(warn ? { warn } : {}), result: out, costUsd };
}

/** The runner's ctx.llm() path — single-prompt, returns text + cost. Unchanged
 *  behaviour; now a thin wrapper over the shared meter. */
export async function brokerLlmCall(
  userId: string,
  req: LlmRequestPayload,
  meta?: BrokerCallMeta,
): Promise<BrokerOutcome> {
  // ⛔ A SPEND-POSTURE REFUSAL IS A VALUE HERE, NOT A THROW. This function's contract (BrokerOutcome)
  // is `{ok:false,…}` for every governance refusal, and `run-controller.ts` answers the runner's
  // `llm_request` from it. `PlatformLocalOnlyError` / `TenantByoKeyRequiredError` used to escape as
  // exceptions: the controller's pump `catch` recorded an `internal` node_error with raw English
  // and wrote NO `llm_response`, so the runner sat blocked on stdin until the idle watchdog. Now
  // the refusal carries its rule, the runner gets its failure frame at once, and the browser
  // renders the localized sentence off `rule`. The English `error` stays the fallback.
  try {
    return await brokerLlmCallUnguarded(userId, req, meta);
  } catch (err) {
    if (err instanceof PlatformLocalOnlyError) {
      return {
        ok: false,
        kind: 'model_not_allowed',
        error: err.message,
        rule: 'llm_platform_local_only',
        model: err.model,
      };
    }
    if (err instanceof TenantByoKeyRequiredError) {
      return {
        ok: false,
        kind: 'model_not_allowed',
        error: err.message,
        rule: 'llm_byo_key_required',
        // Refused before any tenant selection: the model it WOULD have run is the defaulted one.
        model: req.model || config.agent.model,
      };
    }
    throw err;
  }
}

async function brokerLlmCallUnguarded(
  userId: string,
  rawReq: LlmRequestPayload,
  meta?: BrokerCallMeta,
): Promise<BrokerOutcome> {
  // ⛔ A BLOCK THAT NAMES NO MODEL GETS THE TENANT'S, NOT A HARDCODED COMMERCIAL ONE. The seeded demo
  // blocks used to pin `claude-sonnet-4-6`, which a local-llm tenant (platform-paid router) may not
  // reach (`llm_platform_local_only`). With no model on the request, a tenant that has its OWN
  // credential gets its configured model (`sel.model` below, from `tenant_llm_settings.model`), and
  // every other tenant gets `config.agent.model` (AGENT_MODEL, default `local-llm`).
  const req: LlmRequestPayload & { model: string } = {
    ...rawReq,
    model: rawReq.model || config.agent.model,
  };
  // Resolve the TENANT's configured provider, exactly like the agent-chat path.
  //
  // This path used to run on `chooseProvider()` — the process-wide env provider — and ignore
  // `tenant_llm_settings` entirely. That made a tenant's own credentials apply to agent chat but
  // NOT to flow runs, so a tenant-scoped grant (the OpenRouter welcome budget) silently funded
  // only half the product while flow spend went to the platform's env key. The runner's tenant
  // comes from its RLS context (withTenantTx), the same source the cost emit already used.
  //
  // Falls back to the env provider when the tenant has no settings row, so behaviour for an
  // unconfigured tenant is unchanged. A test-injected `provider` override still wins.
  const runnerTenantId = resolveEmitTenant(undefined);
  let provider = overrides?.provider;
  let model = req.model;
  let providerLabel = runnerProviderLabel();
  // The mode-driven env provider (mock / raw anthropic / raw openai-compatible) is not a catalog
  // preset, so it stays unpriced and falls back to the model rules + flat estimate. Only a
  // tenant-resolved adapter carries a real vendor identity.
  let presetKey: string | undefined;
  const sel = provider
    ? null
    : await resolveTenantChatProviderIfConfigured({ tenantId: runnerTenantId, model: req.model });
  if (!provider && sel) {
    model = sel.model;
    providerLabel = sel.providerKind;
    presetKey = sel.presetKey;
    // Adapt the chat-shaped adapter to the runner's single-prompt shape.
    provider = async (r: LlmRequestPayload) => {
      const out = await sel.provider.chat(
        {
          model,
          messages: [{ role: 'user', content: r.prompt }],
          ...(r.maxTokens !== undefined ? { maxTokens: r.maxTokens } : {}),
        },
        { signal: new AbortController().signal },
      );
      return {
        text: out.text ?? '',
        tokensIn: out.usage.tokensIn,
        tokensOut: out.usage.tokensOut,
        // Carry the provider-reported charge through the runner's narrower shape, so a flow run
        // on OpenRouter is priced from the invoice exactly like an agent-chat turn is.
        ...(out.usage.costUsd !== undefined ? { costUsd: out.usage.costUsd } : {}),
      };
    };
  }
  // provider may still be undefined (no test override AND no tenant settings) → keep the
  // mode-driven default, i.e. exactly the pre-0044 behaviour.
  //
  // ⛔ …EXCEPT for a `byo_required` tenant. The mode-driven default is the PLATFORM's provider (in
  // prod the in-cluster inference-router), so running a keyless byo_required tenant's flow on it is
  // the platform paying for spend billed as customer-paid. Refuse. See services/byo-posture.ts.
  if (!provider && !sel) await assertPlatformCredentialAllowed(runnerTenantId);
  // The mode-driven router provider: a tenant's flow run carries the TENANT's router token (or
  // fails closed without one), platform background work and a tenant-less run carry the PLATFORM's
  // (services/tenant-inference.ts `routerCredential`). No env key exists to send instead.
  //
  // ⛔ OWNER RULE: that is the PLATFORM's money, so it may reach only the in-cluster router with a
  // local model — never a commercial one (checked BEFORE a token is minted). `mock` spends nothing.
  // See services/byo-posture.ts `PlatformLocalOnlyError`.
  if (!provider && !sel && config.llm.mode === 'openai_compatible') {
    assertPlatformLocalOnly({
      tenantId: runnerTenantId,
      kind: 'openai_compatible',
      baseUrl: config.llm.openaiBaseUrl || null,
      model: req.model,
    });
    provider = openaiCompatibleProviderWithKey(
      await routerCredential(runnerTenantId, meta?.platformActor === true),
    );
  }
  const deps: BrokerDeps = {
    ...defaults,
    ...overrides,
    ...(provider ? { provider } : {}),
  };
  const effReq: LlmRequestPayload & { model: string } = { ...req, model };
  // The mode-driven default is the PLATFORM's provider (or the mock); a test-injected override has
  // no resolved credential at all, so it records nothing rather than a guess.
  const credentialSource: CredentialSource | undefined = sel
    ? sel.credentialSource
    : overrides?.provider
      ? undefined
      : config.llm.mode === 'mock'
        ? 'none'
        : 'platform_managed';
  const m = await runMetered(
    deps,
    userId,
    providerLabel,
    model,
    () => deps.provider(effReq),
    runnerTenantId,
    meta,
    presetKey,
    {
      inputTokens: Math.max(1, Math.ceil(effReq.prompt.length / 4)),
      maxOutputTokens: effReq.maxTokens ?? 4096,
    },
    credentialSource,
  );
  if (!m.ok) return { ...m, model: effReq.model };
  return {
    ok: true,
    ...(m.warn ? { warn: m.warn } : {}),
    model: effReq.model,
    result: {
      text: m.result.text,
      usage: { tokensIn: m.result.tokensIn, tokensOut: m.result.tokensOut },
      costUsd: m.costUsd,
    },
  };
}

/** The agent-loop path — chat-shaped (messages + tools), returns text and/or tool
 *  calls. Same gate/ledger as the runner path (D1): the loop CANNOT bypass spend
 *  control and never holds a provider key. */
export async function brokerChatCall(
  userId: string,
  tenantId: string | null,
  req: LlmRequest,
  opts: { signal: AbortSignal },
  meta?: BrokerCallMeta,
): Promise<ChatBrokerOutcome> {
  // A test-injected chatProvider wins and skips the DB-backed tenant lookup. Otherwise
  // select the real per-tenant adapter (BYO key / env key / stub) — keys stay host-side.
  let chatProvider = overrides?.chatProvider;
  let model = req.model;
  let providerKind = 'stub'; // test-injected provider → labelled 'stub' in the ledger
  let presetKey: string | undefined;
  let credentialSource: CredentialSource | undefined;
  if (!chatProvider) {
    const sel = await resolveChatProvider({
      tenantId,
      model: req.model,
      platformActor: meta?.platformActor === true,
    });
    chatProvider = sel.provider;
    model = sel.model; // meter + allowlist-check the model actually used
    providerKind = sel.providerKind;
    presetKey = sel.presetKey; // the real vendor — what the price table is keyed on
    credentialSource = sel.credentialSource;
  }
  const deps: BrokerDeps = { ...defaults, ...overrides, chatProvider };
  const effReq: LlmRequest = { ...req, model };
  const m = await runMetered(
    deps,
    userId,
    providerKind,
    model,
    async () => {
      const r = await deps.chatProvider.chat(effReq, opts);
      return {
        ...r,
        tokensIn: r.usage.tokensIn,
        tokensOut: r.usage.tokensOut,
        ...(r.usage.costUsd !== undefined ? { costUsd: r.usage.costUsd } : {}),
      };
    },
    tenantId,
    meta,
    presetKey,
    {
      inputTokens: Math.max(1, Math.ceil(JSON.stringify(effReq.messages).length / 4)),
      maxOutputTokens: effReq.maxTokens ?? 4096,
    },
    credentialSource,
  );
  if (!m.ok) return m;
  return {
    ok: true,
    costUsd: m.costUsd,
    ...(m.warn ? { warn: m.warn } : {}),
    result: {
      text: m.result.text,
      toolCalls: m.result.toolCalls,
      usage: m.result.usage,
    },
  };
}

// ---- streaming path (token-by-token chat) ----
//
// A stream can't hold the usage_counters row lock for its whole duration, so the
// single metering transaction is split:
//   1. RESERVE — lock the row, run the SAME allowlist/daily-cap/weekly checks, and
//      increment `llm_calls` UP FRONT (atomically reserves the daily-call slot → no
//      concurrent-bypass). On reject, throw BrokerRejection before any token streams.
//   2. stream the provider's text deltas, accumulating text + capturing usage.
//   3. SETTLE — a short txn adds the metered spend_usd for the actual tokens.
// Spend is reserved at the configured output bound before the provider is called, then the
// actual charge is settled and the reservation released on every terminal path. This keeps both
// the DAILY-CALL cap and the WEEKLY-SPEND ceiling strict across overlapping calls.

/**
 * The tenant every usage_counters statement in this file must be scoped to.
 *
 * ⛔ WHY THIS EXISTS AT ALL. Post-0059 the table's only natural key is
 * `(tenant_id, user_id, day)`, so a user LEGITIMATELY holds one counter row PER TENANT per day.
 * The statements below used to filter on `user_id AND day` alone; that was correct only because
 * RLS (`usage_counters_tenant` USING `tenant_id = app_current_tenant_uuid()`) silently narrowed
 * them. Correctness that depends solely on RLS evaporates the moment anything runs the same code
 * on the OWNER pool — `runAsSystem`, a scheduler, a test with an owner DSN — where the policy is
 * bypassed: the SELECT would then pick an ARBITRARY tenant's row (no ORDER BY) and the UPDATEs
 * would hit EVERY tenant's row for that user. Both are silent. So every statement now carries an
 * explicit `tenant_id = app_current_tenant_uuid()` predicate: a no-op under RLS, and the correct
 * answer without it.
 *
 * And if no tenant can be determined at all we refuse the call outright rather than metering
 * against an unscoped row. FAIL CLOSED is the only defensible default here — the alternative is
 * an un-capped, un-metered LLM call, which is exactly the defect 0058/0059 exist to close.
 *
 * ⛔ A PLAIN `Error`, NOT a `BrokerRejection`. BrokerRejectionKind is a closed union mirrored in
 * db/trace-types.ts, the frontend trace types, BlockResultView.svelte and eight i18n catalogues;
 * reusing `llm_capped` here would write a FALSE governance verdict ("you hit your quota") into the
 * audit trail for what is really an internal wiring fault. runMetered rethrows anything that is
 * not a BrokerRejection, so the provider is still never called. Adding a new kind is a
 * cross-repo release, not a line in this file.
 */
function requireMeteringTenant(): void {
  if (!currentDbContext()?.tenantId) {
    throw new Error(
      '[broker] refusing to meter an LLM call with no tenant context: usage_counters is ' +
        'tenant-keyed since 0059 and an unscoped counter cannot enforce the daily cap or the ' +
        'weekly ceiling. Wrap the call in withTenantDb/withTenantTx for the caller\'s tenant.',
    );
  }
}

/**
 * Refuse a metered call by a MEMBER who holds no seat — at the point of spend, not only at the HTTP
 * door.
 *
 * ⛔ WHY THIS EXISTS WHEN `middleware/license-gate.ts` ALREADY CHECKS. The gate is HTTP middleware,
 * so it only sees calls that arrive as a request from that person's browser. A flow run does not:
 * `host/run-controller.ts` and `datasets/mapping-service.ts` bill a human `userId` from a scheduler,
 * a webhook or a queued run, where no request of theirs is in flight and the gate never ran. The
 * provider is paid either way, so without this an unseated member's scheduled work keeps spending —
 * and `settleSpend` records the row with `license_id` NULL, which billing ingests as unattributed
 * and cannot invoice. Failing here is the only place that covers every producer.
 *
 * ⚠️ WHO IS EXEMPT, AND WHY IT IS NOT "EVERYONE WITHOUT A ROW". Three populations legitimately have
 * no entitlement and must keep working:
 *   • platform work (`platformActor`) — nobody acted, and it is emitted as `origin: system`;
 *   • platform staff (`users.role = 'platform'`) — they are never a billable seat, which is the
 *     same exclusion `repairUnseatedMembers` and the seat count make;
 *   • a user who is not a member of the tenant this call is metered under — a super_admin scoped
 *     in, which `license-gate.ts` also lets through on the tenant token (`member != null` there).
 * So the refusal is narrow by construction: a live, non-platform member of THIS tenant with no
 * active seat. `revoking` counts as a seat — the central revoke has not been acknowledged, the
 * tenant is still billed for it, and cutting service before the seat is actually released would
 * charge for something we refused to provide.
 *
 * ⛔ GATED ON THE SAME FLAG AS THE HTTP GATE (`LICENSE_GATE_PER_MEMBER`), ON PURPOSE. Before the
 * flag is flipped, entitlements are still being backfilled, so enforcing here would deny members
 * whose seat simply has not been minted yet. One flag means one rollout: when it flips, both doors
 * close together, and rollout gate 2 (drift = 0 between CP members and licences `human_subjects`)
 * is what makes that safe.
 */
async function assertMemberSeat(tx: BrokerTx, userId: string, platform: boolean): Promise<void> {
  if (platform) return;
  if (!config.license.perMemberGate) return;

  const rows = (await tx.execute(
    sql`SELECT
          EXISTS (SELECT 1 FROM users u
                   WHERE u.id = ${userId}
                     AND u.tenant_id = app_current_tenant_uuid()
                     AND u.deleted_at IS NULL
                     AND u.role <> 'platform') AS is_member,
          EXISTS (SELECT 1 FROM member_entitlements me
                   WHERE me.tenant_id = app_current_tenant_uuid()
                     AND me.user_id = ${userId}
                     AND me.app_key = ${config.license.appKey}
                     AND me.status IN ('active', 'revoking')
                     AND me.license_id IS NOT NULL) AS has_seat`,
  )) as unknown as { is_member: boolean; has_seat: boolean }[];
  const row = rows[0];
  // ⛔ NO `?? { is_member: false }` FALLBACK, for the reason the counter read below states in full:
  // a missing row here would mean the tenant scope is broken, and defaulting it would turn a broken
  // scope into a silent free pass. `EXISTS` always returns exactly one row.
  if (!row) {
    throw new Error(
      `[broker] seat check returned no row for user ${userId} — the tenant GUC is not set. ` +
        'Refusing to meter.',
    );
  }
  if (row.is_member && !row.has_seat) {
    incCounter('broker_seat_refused_total');
    throw new BrokerRejection(
      'seat_required',
      'You do not have a Common Practice seat in this workspace.',
      { rule: 'llm_seat_required' },
    );
  }
}

/** Reserve a call slot: allowlist + daily-cap + weekly checks, then increment the caller's
 *  call counter. Throws BrokerRejection (rolling back the increment) on any gate fail.
 *
 *  `platform` is REQUIRED and deliberately not defaulted. Every call site must state which
 *  counter it is claiming, because `releaseCall` has to give back the SAME one — and because the
 *  streaming path (`brokerChatStream`) calls this directly rather than through `runMetered`, so a
 *  defaulted parameter would let that path silently keep the old behaviour. The compiler catching
 *  a missing argument is the mechanism that stops the streaming path from being forgotten. */
async function reserveCall(
  deps: BrokerDeps,
  userId: string,
  model: string,
  limits: GovernanceLimits,
  reservationUsd: number,
  platform: boolean,
): Promise<{ warn?: 'approaching_cap'; reservationUsd: number }> {
  const allowlist = limits.allowlistedModels;
  if (allowlist && allowlist.length > 0 && !allowlist.includes(model)) {
    throw new BrokerRejection('model_not_allowed', `model '${model}' is not allowlisted`, {
      rule: 'llm_model_not_allowed',
      detail: { model },
    });
  }
  requireMeteringTenant();
  // ⭐ SELF-HEALING SEAT, OUTSIDE THE TRANSACTION. `assertMemberSeat` is the authoritative check and
  // stays inside the reservation txn; when it refuses for want of a seat, seat the member once
  // (`seatMemberInline` — network calls, so never while this txn holds a connection) and retry the
  // whole reservation. Nothing is incremented before `assertMemberSeat`, so the first attempt rolled
  // back clean. A refused / failed seating re-throws the original `seat_required`.
  try {
    return await reserveCallTxn(deps, userId, limits, reservationUsd, platform);
  } catch (err) {
    if (!(err instanceof BrokerRejection) || err.kind !== 'seat_required') throw err;
    const tenantId = currentDbContext()?.tenantId;
    if (!tenantId || !(await seatMemberInline(tenantId, userId))) throw err;
    return await reserveCallTxn(deps, userId, limits, reservationUsd, platform);
  }
}

async function reserveCallTxn(
  deps: BrokerDeps,
  userId: string,
  limits: GovernanceLimits,
  reservationUsd: number,
  platform: boolean,
): Promise<{ warn?: 'approaching_cap'; reservationUsd: number }> {
  return await deps.db.transaction(async (tx) => {
    await assertMemberSeat(tx, userId, platform);
    await tx.execute(
      // ⛔ UNTARGETED `ON CONFLICT DO NOTHING`, deliberately — do not "tidy" this back to a
      // named target. 0059 has now landed, so `usage_counters_tenant_user_day_uq
      // (tenant_id, user_id, day)` is the table's ONLY natural key; the pre-tenancy
      // `usage_counters_user_day_uq (user_id, day)` from 0004 is gone. Naming a target would
      // work today and re-break the rolling deploy the next time the key moves — untargeted is
      // valid in every schema state, which is what let 0058 → 0059 ship without 42P10-ing
      // in-flight replicas. It arbitrates on the wide key; 0059's guard proves that key exists,
      // because without a usable arbiter this clause would append a row per call instead of
      // de-duplicating, and the daily cap would never accumulate past 1.
      // `tenant_id` is supplied by its column DEFAULT `app_current_tenant_uuid()`, so the row is
      // stamped with the REQUEST's tenant.
      sql`INSERT INTO usage_counters (user_id, day) VALUES (${userId}, current_date)
          ON CONFLICT DO NOTHING`,
    );
    const counterRows = (await tx.execute(
      sql`SELECT llm_calls, platform_llm_calls, spend_usd FROM usage_counters
          WHERE tenant_id = app_current_tenant_uuid()
            AND user_id = ${userId} AND day = current_date FOR UPDATE`,
    )) as unknown as { llm_calls: number; platform_llm_calls: number; spend_usd: string }[];
    const counter = counterRows[0];
    // ⛔ NO `?? { llm_calls: 0, spend_usd: '0' }` FALLBACK. That fallback WAS the bypass: when
    // the day's row belonged to another tenant, RLS hid it, this SELECT returned nothing, and
    // the broker cheerfully spent a zero counter — every cap check passed for the rest of the
    // UTC day. The INSERT above has just guaranteed a row for (this tenant, user, today), so
    // zero rows now means the tenant scope is broken, not that the user has made no calls.
    if (!counter) {
      throw new Error(
        `[broker] no usage_counters row for user ${userId} under the current tenant after ` +
          'the upsert — the tenant GUC and the row\'s tenant_id disagree. Refusing to meter.',
      );
    }

    // ⛔ THE ONE GATE A PLATFORM CALL SKIPS (migration 0061), and only this one. `dailyLlmCap` is a
    // per-PERSON allowance; platform background work is not a person and has no allowance. Prod
    // symptom of applying it anyway: 608 pending translation_jobs, all attributed to one user
    // whose counter sat at 50/50 with spend_usd = 0.000000 — a $0 backlog blocked by a call cap.
    // The weekly SPEND ceiling below still runs, so this is not "platform work is ungoverned",
    // it is "platform work is governed by money instead of by a headcount quota".
    if (!platform && counter.llm_calls + 1 > limits.dailyLlmCap) {
      throw new BrokerRejection(
        'llm_capped',
        `daily LLM call cap reached (${limits.dailyLlmCap})`,
        { rule: 'llm_daily_cap_reached', detail: { limit: String(limits.dailyLlmCap) } },
      );
    }
    // ⛔ RUNS FOR PLATFORM CALLS TOO — deliberately NOT gated on `!platform`. This is the bound
    // that survives the daily-cap exemption above and the reason that exemption is safe: a
    // platform call at $0.00 costs nothing and passes, and a platform call that ever DOES cost
    // money is bounded by the same weekly ceiling a human's is. Extending the bypass to here
    // would make background work able to spend without limit.
    //
    // Scoped to (THIS tenant, THIS user) — both predicates are load-bearing and neither is
    // redundant. `limits` is this tenant's governance policy, so the spend it is compared against
    // must be this tenant's; and `spend.weekly_spend_ceiling` is labelled "Per-USER weekly spend
    // ceiling" in `seed-platform.ts` and enforced that way here. (This sentence used to read
    // "Per-tenant by design", which described only half of its own predicate and invited the
    // reader to conclude the ceiling pools across a tenant's users. It does not.)
    //
    // ⛔ `>=`, NOT `>`. `day` is a DATE (schema.ts usageCounters), `current_date - INTERVAL '6
    // days'` is a TIMESTAMP at midnight, and `>` is strict — so `current_date - 6` was EXCLUDED
    // and this summed only SIX distinct days while every description of it, including the
    // customer-facing `policy_desc_spend_weekly_spend_ceiling` string in the frontend locales,
    // promised a rolling SEVEN. The oldest day of a user's own week silently stopped counting
    // toward the ceiling that gates their service. `>= current_date - INTERVAL '6 days'` spans
    // current_date-6 … current_date inclusive = 7 days; `> current_date - INTERVAL '7 days'` is
    // the identical set if you prefer that spelling. Pinned by a test that seeds a counter row at
    // exactly `current_date - 6`, which is the day the old predicate dropped.
    const weekRows = (await tx.execute(
      sql`SELECT COALESCE(SUM(spend_usd + reserved_spend_usd), 0) AS spent FROM usage_counters
          WHERE tenant_id = app_current_tenant_uuid()
            AND user_id = ${userId} AND day >= current_date - INTERVAL '6 days'`,
    )) as unknown as { spent: string }[];
    if (Number(weekRows[0]?.spent ?? 0) + reservationUsd > limits.weeklySpendUsd) {
      throw new BrokerRejection(
        'llm_capped',
        `weekly spend ceiling reached ($${limits.weeklySpendUsd})`,
        // ⚠️ The `$` SIGN IS PART OF THE TOKEN, not of the sentence. The ceiling is denominated in
        // USD by the policy, so the currency travels with the amount instead of being spelled into
        // eight translations that would each have to guess it.
        { rule: 'llm_weekly_spend_reached', detail: { limit: `$${limits.weeklySpendUsd}` } },
      );
    }

    // RETURNING + a row-count assertion because `UPDATE 0` is the EXACT shape the original bug
    // took: the increment silently matched nothing and the caller went on to make the call
    // anyway. The reserved slot is the cap; if it was not written, there is no cap.
    //
    // ⛔ KEEP THE EXPLICIT `::int` CASTS. Drizzle binds `${0}` / `${1}` as untyped parameters, so
    // without them Postgres resolves `integer + unknown`, which is a coercion rule this governance
    // path should not be trusting to stay convenient. Cast, and the arithmetic is integer + integer.
    // The two increments are complementary by construction (exactly one of them is 1): a platform
    // call moves ONLY platform_llm_calls, a human call moves ONLY llm_calls, and releaseCall
    // mirrors this exactly.
    const reserved = (await tx.execute(
      sql`UPDATE usage_counters
          SET llm_calls = llm_calls + ${platform ? 0 : 1}::int,
              platform_llm_calls = platform_llm_calls + ${platform ? 1 : 0}::int,
              reserved_spend_usd = reserved_spend_usd + ${reservationUsd}
          WHERE tenant_id = app_current_tenant_uuid()
            AND user_id = ${userId} AND day = current_date
          RETURNING llm_calls, platform_llm_calls`,
    )) as unknown as { llm_calls: number; platform_llm_calls: number }[];
    if (reserved.length !== 1) {
      throw new Error(
        `[broker] the call-slot reservation matched ${reserved.length} usage_counters rows for ` +
          `user ${userId} (expected exactly 1) — the daily cap is not being enforced. ` +
          'Refusing to make the call.',
      );
    }
    // Read the POST-increment value back from the database rather than recomputing it from the
    // pre-UPDATE snapshot: the row is what the cap is actually enforced against.
    const callsAfter = Number(reserved[0]!.llm_calls);
    // ⛔ NO `approaching_cap` FOR A PLATFORM CALL. This warning is a MESSAGE TO A HUMAN about a
    // human quota — it surfaces in the agent UI as "you are near your daily limit". A platform
    // call is not subject to that cap at all, and there is nobody at the other end of the drainer
    // to warn. Emitting it would put a false quota advisory in front of whichever person happens
    // to be `requested_by`, about a limit their own usage never approached.
    const warn = platform
      ? undefined
      : limits.dailyLlmCap > 0 && callsAfter >= Math.ceil(limits.dailyLlmCap * 0.8)
        ? ('approaching_cap' as const)
        : undefined;
    return warn ? { warn, reservationUsd } : { reservationUsd };
  });
}

/**
 * Hand back a call slot claimed by `reserveCall` when the provider call then FAILED.
 *
 * Without this, a provider outage would burn the caller's daily quota: the slot is claimed before
 * the call (that is what makes the cap race-free), so a failure has to return it. Best-effort and
 * never throws — losing the decrement is a far smaller problem than masking the real error.
 *
 * ⛔ `platform` IS REQUIRED AND MUST MATCH THE `reserveCall` THAT CLAIMED THE SLOT. This is the
 * argument that made migration 0061 add a column rather than "just skip the increment": a reserve
 * that skips the increment paired with a release that still performs the decrement STEALS a slot
 * from the human on every failed platform call, driving a real person's counter down for work
 * they did not do — silently, since this function never throws. Decrement the same column that
 * was incremented, and move the positivity guard with it.
 */
async function releaseCall(
  deps: BrokerDeps,
  userId: string,
  reservationUsd: number,
  platform: boolean,
): Promise<void> {
  try {
    // ⛔ `deps.db.transaction`, NOT a plain `deps.db.execute` — and this is not stylistic symmetry
    // with `reserveCall`, it is the only way this statement sees a tenant at all.
    //
    // `deps.db` is the `db` Proxy. Under `withTenantDb` (a reserved connection with a session-level
    // `app.current_tenant`) both spellings work, which is why every test in llm-broker.test.ts that
    // meters through `withTenantDb` was green on a refund that never happened. But NO production
    // caller uses that scope: run-controller.ts, `runAgentChatScoped` (ai/agent.ts) and
    // translation-service.ts all meter under `withTenantTx`, which deliberately reserves nothing —
    // it installs `{tenantId, boundDb: poolDb}` and the Proxy injects `SET LOCAL
    // app.current_tenant` ONLY on the `.transaction` property. A plain `execute` under it lands on
    // an arbitrary pool connection with the GUC unset, `app_current_tenant_uuid()` returns NULL
    // (0028_rls.sql:35 normalises unset/blank to NULL), and `WHERE tenant_id = NULL` matches
    // nothing. RLS is not even involved: the predicate names the function directly, so this was
    // `UPDATE 0` for the owner role too.
    //
    // What that cost, in the shape a user sees it: press Stop, close the AI panel, navigate away,
    // or let the provider time out — `brokerChatStream`'s `finally` calls this with
    // `settled === false` and it refunds nothing. The daily slot stays spent and
    // `reserved_spend_usd` stays inflated by the reservation (priced at `maxTokens ?? 4096`,
    // i.e. the WORST case, never what was actually streamed). Nothing reaps it; it counts against
    // the rolling 7-day ceiling until the row ages out. A handful of cancelled turns and the user
    // is refused with "weekly spend ceiling reached ($X)" for money nobody spent.
    //
    // Tenant-scoped for the same reason reserveCall is (see requireMeteringTenant): without the
    // predicate an owner-pool caller would decrement EVERY tenant's counter for this user, handing
    // back a slot that was never taken and re-opening the cap somewhere else entirely.
    const released = (await deps.db.transaction(async (tx) =>
      tx.execute(
        sql`UPDATE usage_counters
            SET llm_calls = llm_calls - ${platform ? 0 : 1}::int,
                platform_llm_calls = platform_llm_calls - ${platform ? 1 : 0}::int,
                reserved_spend_usd = GREATEST(0, reserved_spend_usd - ${reservationUsd})
            WHERE tenant_id = app_current_tenant_uuid()
              AND user_id = ${userId} AND day = current_date
              AND ${platform ? sql`platform_llm_calls > 0` : sql`llm_calls > 0`}
            RETURNING 1 AS ok`,
      ),
    )) as unknown as { ok: number }[];
    // ⛔ COUNT THE ROWS, AND DO NOT THROW. `reserveCall` asserts its rowcount and refuses the call
    // on a mismatch; here the call has already failed and the caller is owed its original error, so
    // a throw would mask it — that is why this function's contract is "best-effort, never throws".
    // But the SILENCE was the bug: both of this function's call sites run only after a reserve that
    // succeeded, so a row must exist and must match. Zero rows means the refund was lost, and
    // without this line it is indistinguishable from a refund that worked. Same "not fatal, but
    // loud" shape settleSpend already uses for its counter drift.
    if (released.length !== 1) {
      log.error('broker_call_slot_release_mismatch', {
        userId,
        matchedRows: released.length,
        reservationUsd,
        hint:
          'the slot and its reservation stay spent; there is no reaper — check that the caller ' +
          'established a tenant context',
      });
    }
  } catch (err) {
    log.error('broker_call_slot_release_failed', { userId, err });
  }
}

/**
 * Hand back ONLY the spend reservation, keeping the daily call slot spent.
 *
 * The narrow sibling of `releaseCall`, for the one case where the provider call SUCCEEDED but the
 * settle transaction did not (see the guard in `runMetered`). The two halves of a reservation stop
 * being symmetric there: the call really was made, so `llm_calls` must stay incremented — a
 * refunded slot would let a user exceed `spend.daily_llm_cap` once per settle failure — while
 * `reserved_spend_usd` is a hold against money that is now settled-or-lost, and leaving it in
 * place would keep counting toward the weekly ceiling until the row ages out of the window. There
 * is no reaper to do it later; this is the only chance.
 *
 * Deliberately takes no `platform` flag, unlike `reserveCall`/`releaseCall`: `reserved_spend_usd`
 * is a single shared column (platform work is exempt from the CALL cap, never from the spend
 * ceiling), so there is no second column to choose between and no way to give back the wrong one.
 *
 * Best-effort and never throws — it runs on a path whose whole purpose is to stop a bookkeeping
 * failure from destroying an answer the caller already paid for.
 */
async function releaseReservedSpend(
  deps: BrokerDeps,
  userId: string,
  reservationUsd: number,
): Promise<void> {
  if (!(reservationUsd > 0)) return;
  try {
    // `deps.db.transaction`, not `deps.db.execute` — see the long note in `releaseCall`. Under
    // `withTenantTx` (the scope run-controller meters in, and the only path that reaches this
    // function) a plain statement carries no `app.current_tenant`, so
    // `WHERE tenant_id = app_current_tenant_uuid()` matched zero rows every time. The docstring
    // above says "There is no reaper to do it later; this is the only chance" — that was exactly
    // true, and the only chance was being missed.
    const released = (await deps.db.transaction(async (tx) =>
      tx.execute(
        sql`UPDATE usage_counters
            SET reserved_spend_usd = GREATEST(0, reserved_spend_usd - ${reservationUsd})
            WHERE tenant_id = app_current_tenant_uuid()
              AND user_id = ${userId} AND day = current_date
            RETURNING 1 AS ok`,
      ),
    )) as unknown as { ok: number }[];
    if (released.length !== 1) {
      log.error('broker_spend_reservation_release_mismatch', {
        userId,
        matchedRows: released.length,
        reservationUsd,
        hint: 'reserved_spend_usd is overstated by this amount until the row ages out of the weekly window',
      });
    }
  } catch (err) {
    log.error('broker_spend_reservation_release_failed', {
      userId,
      reservationUsd,
      hint: 'reserved_spend_usd is overstated by this amount until the row ages out of the weekly window',
      err,
    });
  }
}

/** Settle the metered spend for a completed call (short txn; the row already
 *  exists from reserveCall) and append the usage_events ledger row. */
async function settleSpend(
  deps: BrokerDeps,
  userId: string,
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  /** How `costUsd` was derived — persisted so the UI can stop guessing whether a figure is an
   *  estimate, and so rows priced under different regimes stay distinguishable forever. */
  priceSource: PriceSource,
  tenantId?: string | null,
  latencyMs = 0,
  meta?: BrokerCallMeta,
  reservationUsd = 0,
  /**
   * The REAL VENDOR (a `provider-catalog.ts` preset key: `openrouter` | `openai` | `anthropic` |
   * `deepseek` | `xai` | `cohere` | `local` | `custom`), for the fleet cost event ONLY.
   *
   * ⛔ WHY THIS IS A SEPARATE PARAMETER AND NOT JUST `provider`. `provider` above is the COARSE
   * label the local `usage_events` ledger has always stored and the /usage dashboards group by —
   * `ResolvedChat.providerKind`, which is the DB enum, and `ai/llm/select.ts:47-49` states in terms
   * that it "collapses OpenRouter, DeepSeek, xAI, Cohere and the in-cluster local router all into
   * `openai_compatible`". That is tolerable for a local dashboard axis and WRONG on the bus:
   * billing-service prices a cost event on `(provider, model, service_key)`, and
   * `openai_compatible` is not a vendor any `provider_pricing` row is keyed on — so every external
   * OpenRouter/DeepSeek/xAI call CP ever emits would arrive unpriceable and be refused or booked at
   * $0. The catalog comment on the `xai` preset already records this exact failure once: a
   * vendor mis-key "left every claude cost_event at cost_usd=NULL".
   *
   * The vendor was ALREADY resolved on every one of these paths (`ResolvedChat.presetKey`, derived
   * by `presetKeyFor(kind, base_url)`) and was already used for PRICING three lines above each call
   * site — it simply was never handed to the emit. So this changes no routing, no model selection
   * and no pricing: it stops discarding a value the caller had.
   *
   * ⚠️ NOT persisted and NOT merged into `provider`. Widening `usage_events.provider` would move a
   * column four aggregates in host/usage-metrics.ts group by, which is a dashboard change nobody
   * asked for. Absent (the stub, and the runner's env-mode fallback, which resolve no preset) the
   * event keeps today's value via the `||` below — so this can only ever REPLACE a coarse label
   * with a real vendor, never lose one.
   */
  vendor?: string,
  /** Whose credential paid the provider (`ResolvedChat.credentialSource`). Recorded on the ledger
   *  row and drives the cost event's `usage_extra.byo`. Undefined = not resolved by this path. */
  credentialSource?: CredentialSource,
  /**
   * The provider's own id for the generation this row settles, for VENDOR RECONCILIATION: it is the
   * only value that joins one of our cost rows to one line on the provider's invoice. Empty when the
   * adapter exposes none (the stub, the raw anthropic shim) — `metering-emit.ts` sends `''` rather
   * than fabricating one, because a made-up id would reconcile against nothing while LOOKING
   * reconcilable.
   */
  providerRequestId?: string,
): Promise<void> {
  // The tenant the LOCAL LEDGER actually recorded, read back off its own INSERT below. See the ⛔
  // note on the emit at the bottom of this function for why it is captured here rather than
  // re-derived: it is the one value guaranteed to agree with the authoritative `usage_events` row.
  let ledgerTenantId: string | null = null;
  await deps.db.transaction(async (tx) => {
    // Tenant-scoped (see requireMeteringTenant): reserveCall wrote the reservation on exactly one
    // tenant's row and this must settle that same row, not "whichever rows share the user".
    const settled = (await tx.execute(
      sql`UPDATE usage_counters
          SET spend_usd = spend_usd + ${costUsd},
              reserved_spend_usd = GREATEST(0, reserved_spend_usd - ${reservationUsd})
          WHERE tenant_id = app_current_tenant_uuid()
            AND user_id = ${userId} AND day = current_date
          RETURNING 1 AS ok`,
    )) as unknown as { ok: number }[];
    // DELIBERATELY NOT FATAL, unlike the reserve-side assertion. By the time we get here the
    // provider has already been called and the money is already spent; throwing would abort this
    // transaction and lose the usage_events row, which is the BILLING ledger and the more
    // authoritative record. So: keep the ledger, and make the counter drift loud instead of
    // silent — a reserved slot that never settles is otherwise invisible until someone wonders
    // why reserved_spend_usd only ever grows.
    if (settled.length !== 1) {
      log.error('broker_settle_spend_mismatch', {
        userId,
        matchedRows: settled.length,
        hint:
          'the reserved spend was not released and the daily counter is now understated; the ' +
          'usage_events ledger row below is still authoritative',
      });
    }
    // Always record the call in the ledger (even at zero cost) for the dashboards.
    // `stage` (migration 0061) was already being threaded into the OPTIONAL, off-by-default fleet
    // emit below while the AUTHORITATIVE local ledger dropped it on the floor — so Redis knew a
    // row was 'content-translation' and the billing table did not. Same `meta`, same value.
    //
    // `platform_actor` (migration 0063) is the same story one layer deeper, and it is the one that
    // is READ rather than merely recorded: 0061 split the COUNTER so background work stopped
    // eating a person's daily quota, but /usage reads THIS TABLE, so the tenant-admin screen went
    // on billing a named human for 608 platform calls — one fused integer next to their name, and
    // exported to CSV. All four aggregates in host/usage-metrics.ts now exclude these rows.
    //
    // ⛔ `${meta?.platformActor === true}` is LITERALLY THE SAME EXPRESSION reserveCall and
    // releaseCall narrow `platform` from (see runMetered and brokerChatStream). That is deliberate
    // and load-bearing: the ledger row and the usage_counters split are then derived from one
    // decision, so they CANNOT disagree about whether a call was a person's. Anything cleverer
    // here — a truthiness test, a `stage`-based inference, a cached boolean — reintroduces the
    // possibility of a row counted as platform load but billed to a human, or the reverse.
    //
    // `RETURNING tenant_id` feeds the fleet emit at the bottom of this function the tenant the
    // LEDGER actually recorded, so the bus event and the authoritative row are the same value by
    // construction rather than by two independent derivations that happen to agree.
    //
    // ⚠️ BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT FIX — the obvious story here is WRONG and was
    // written down before it was checked. The tempting claim is: "the COALESCE resolves the tenant
    // from `users` when no explicit one was passed, `resolveEmitTenant` has no such fallback, so the
    // ledger was right while the cost event carried the nil UUID." MEASURED, that cannot happen on
    // this path. `requireMeteringTenant()` (above) THROWS unless an RLS tenant context is present,
    // and every metered path goes through it — so `resolveEmitTenant`'s context rung always
    // resolved, and the nil sentinel was structurally unreachable from here. It is corroborated by
    // the production numbers: 0 nil-UUID-tenant rows fleet-wide. The missing `users` fallback was
    // therefore NOT the reason CP has emitted nothing, and reading it back does not make it one.
    //
    // What this IS: the two derivations are now one, so they cannot drift if either side's rule
    // changes — and it costs nothing, being a `RETURNING` on an INSERT that was already happening
    // rather than the second round trip a repeated subquery would need. The nil sentinel is still
    // removed on its own merits (billing dead-letters it as `nil_tenant_id` since 2026-08-26), and
    // the refusal that replaces it is COUNTED, so if this reasoning is ever wrong the counter says
    // so instead of a placeholder tenant quietly absorbing it.
    // ATTRIBUTION (migration 0090), resolved in the SAME statement as the ledger row so the row and
    // its cost event cannot disagree about who paid:
    //   • `license_id` / `license_subject_id` — the member's entitlement. `revoking` counts: the seat
    //     is still active upstream (and still billed) until the central revoke is acknowledged, and a
    //     call that completed in that window was spent on it. Most recent first, in case a re-hire
    //     left history behind.
    //   • `actor_id` — the member's verified Keycloak sub. NULL for platform work: no person acted,
    //     and naming the `requested_by` human as the ACTOR would be the same conflation 0063 removed.
    // A member with no entitlement records NULLs, never a substitute: the provider was already paid,
    // so the row must exist, and it must say plainly that nobody's licence was attributed.
    const vendorCostUsd = priceSource === 'provider' && Number.isFinite(costUsd) ? costUsd : null;
    const ledgerRows = (await tx.execute(
      sql`WITH u AS (
            SELECT COALESCE(${tenantId ?? null}::uuid, tenant_id) AS tenant_id, keycloak_sub
              FROM users WHERE id = ${userId}
          ),
          ent AS (
            SELECT me.license_id, me.license_subject_id
              FROM member_entitlements me, u
             WHERE me.tenant_id = u.tenant_id
               AND me.user_id = ${userId}
               AND me.app_key = ${config.license.appKey}
               AND me.status IN ('active', 'revoking')
               AND me.license_id IS NOT NULL
             ORDER BY me.created_at DESC
             LIMIT 1
          )
          INSERT INTO usage_events
            (tenant_id, user_id, provider, model, tokens_in, tokens_out, cost_usd, price_source, stage,
             platform_actor, license_id, license_subject_id, actor_id, credential_source,
             vendor_cost_usd, correlation_id)
          VALUES (
            COALESCE(${tenantId ?? null}::uuid, (SELECT tenant_id FROM users WHERE id = ${userId})),
            ${userId}, ${provider}, ${model}, ${tokensIn}, ${tokensOut}, ${costUsd}, ${priceSource},
            ${meta?.stage ?? null},
            ${meta?.platformActor === true},
            (SELECT license_id FROM ent),
            (SELECT license_subject_id FROM ent),
            CASE WHEN ${meta?.platformActor === true} THEN NULL
                 ELSE (SELECT keycloak_sub::uuid FROM u) END,
            ${credentialSource ?? null},
            ${vendorCostUsd},
            ${meta?.correlationId ?? null}
          )
          RETURNING id, tenant_id, license_id, license_subject_id, actor_id, created_at`,
    )) as unknown as {
      id: string;
      tenant_id: string | null;
      license_id: string | null;
      license_subject_id: string | null;
      actor_id: string | null;
      created_at: Date | string;
    }[];
    const ledger = ledgerRows[0];
    ledgerTenantId = ledger?.tenant_id ?? null;

    // ⛔ THE COST EVENT IS ENQUEUED IN THIS TRANSACTION, NOT FIRED AFTER IT. It used to be a `void`
    // XADD after commit: a transport blip lost the event with nothing recording it was owed (168
    // calls on 2026-09-02, cause unrecoverable). Now the ledger row and its pending event commit or
    // roll back together, and host/metering-outbox-drainer.ts delivers it.
    //
    // THE LEDGER'S TENANT FIRST, `resolveEmitTenant` ONLY AS A FALLBACK — monotonic: the ledger value
    // already subsumes the explicit argument and adds the `users` lookup, and the RLS-context rung
    // still attributes a call whose user row carries no tenant.
    if (ledger) {
      await enqueueCostEvent(tx, {
        tenantId: ledgerTenantId ?? resolveEmitTenant(tenantId),
        subjectId: ledger.license_subject_id ?? '',
        licenseId: ledger.license_id,
        actorId: ledger.actor_id,
        eventKey: ledger.id,
        credentialSource: credentialSource ?? null,
        vendorCostUsd,
        platformActor: meta?.platformActor === true,
        occurredAt: new Date(ledger.created_at),
        // ⛔ THE VENDOR, NOT THE ADAPTER KIND — see the `vendor` parameter's block above. `||` and
        // not `??` on purpose: an empty-string preset is as unusable to billing's price lookup as an
        // absent one, and must fall back the same way.
        provider: vendor || provider,
        model,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        costUsd,
        latencyMs,
        correlationId: meta?.correlationId,
        stage: meta?.stage,
        providerRequestId,
      });
    }
  });

}

/** The streaming agent-loop path. Reserves the call slot (cap-rejects throw
 *  BrokerRejection before any token), streams the provider's text deltas, then
 *  settles spend. Falls back to chat() (one delta = the full text) for a provider
 *  that doesn't implement stream(). The provider key never leaves the host. */
export async function* brokerChatStream(
  userId: string,
  tenantId: string | null,
  req: LlmRequest,
  opts: LlmProviderCallOpts,
  meta?: BrokerCallMeta,
): AsyncGenerator<ChatStreamChunk> {
  let chatProvider = overrides?.chatProvider;
  let model = req.model;
  let providerKind = 'stub';
  // A test that injects a provider may also say which preset/credential it stands in for, so the
  // pricing and tenant-charge paths can be exercised without a live router.
  let presetKey: string | undefined = overrides?.chatSelection?.presetKey;
  let credentialSource: CredentialSource | undefined = overrides?.chatSelection?.credentialSource;
  if (!chatProvider) {
    const sel = await resolveChatProvider({
      tenantId,
      model: req.model,
      platformActor: meta?.platformActor === true,
    });
    chatProvider = sel.provider;
    model = sel.model;
    providerKind = sel.providerKind;
    presetKey = sel.presetKey;
    credentialSource = sel.credentialSource;
  }
  const deps: BrokerDeps = { ...defaults, ...overrides, chatProvider };
  const limits = await deps.limits();
  // Hoisted (not just inlined into the priceFor call below) because the abort-settle path in the
  // `finally` reuses this SAME estimate as `tokensIn` — the request messages do not change
  // between the reservation and an abort, so re-deriving it there would be a second estimator for
  // a number we already have.
  const estTokensIn = estimateTokens(JSON.stringify(req.messages));
  const reservationUsd = priceFor(limits, presetKey, model, estTokensIn, req.maxTokens ?? 4096)
    .costUsd;
  // ⛔ THIS PATH BYPASSES `runMetered` AND CALLS reserve/release DIRECTLY. It is the one that gets
  // forgotten when the metering contract changes, which is exactly why `platform` is a REQUIRED
  // parameter on both: omitting it here is a compile error, not a silently mis-metered stream.
  // The `releaseCall` in the `finally` below must be given the SAME value.
  const platform = meta?.platformActor === true;
  const { warn } = await reserveCall(deps, userId, model, limits, reservationUsd, platform); // throws on reject, before any slot is claimed

  // From here the slot IS claimed, so any exit other than a successful settle must hand it
  // back — exactly what runMetered's catch does for the non-streaming path. This is an async
  // GENERATOR: besides a thrown exception from the provider stream, the consumer can also stop
  // early (`for await … break`, or the caller aborting `args.signal`), which resumes execution
  // here via `.return()`/`.throw()` — a `finally` around the body catches both, a plain
  // try/catch would not. `settled` distinguishes "reached a successful settle" (must NOT
  // release — the ledger row already exists) from every other exit (must release).
  let settled = false;
  // Hoisted OUT of the try: the `finally` below needs whatever was accumulated so far to settle
  // an abort honestly, and a `finally` can only see what survives past the point of a throw/early
  // `.return()` if it was never scoped inside the block that got interrupted.
  let text = '';
  let toolCalls: ChatResult['toolCalls'];
  let usage: ChatResult['usage'] = { tokensIn: 0, tokensOut: 0 };
  // Hoisted for the same reason `text` and `usage` are: the abort-settle in the `finally` needs
  // whatever the stream had already told us, and the id arrives on the FIRST frame.
  let providerRequestId: string | undefined;
  let t0 = performance.now();
  try {
    const effReq: LlmRequest = { ...req, model };
    t0 = performance.now();
    if (typeof deps.chatProvider.stream === 'function') {
      for await (const chunk of deps.chatProvider.stream(effReq, opts)) {
        if (chunk.type === 'text') {
          text += chunk.text;
          if (chunk.text) yield { type: 'text', text: chunk.text };
        } else if (chunk.type === 'tool_call') {
          (toolCalls ??= []).push(chunk.toolCall);
        } else {
          // done: prefer the adapter's authoritative (sanitized) text + tool calls.
          usage = chunk.usage;
          if (chunk.text !== undefined) text = chunk.text;
          if (chunk.toolCalls) toolCalls = chunk.toolCalls;
          if (chunk.providerRequestId) providerRequestId = chunk.providerRequestId;
        }
      }
    } else {
      const r = await deps.chatProvider.chat(effReq, opts);
      usage = r.usage;
      toolCalls = r.toolCalls;
      text = r.text ?? '';
      providerRequestId = r.providerRequestId;
      if (text) yield { type: 'text', text };
    }

    const latencyMs = performance.now() - t0;
    // The adapter surfaces OpenRouter's charge on the final SSE frame, so the settle-after-stream
    // path prices from the same invoice the non-streaming path does.
    const { costUsd, priceSource } = priceFor(
      limits,
      presetKey,
      model,
      usage.tokensIn,
      usage.tokensOut,
      usage.costUsd,
    );
    await settleSpend(
      deps,
      userId,
      providerKind,
      model,
      usage.tokensIn,
      usage.tokensOut,
      costUsd,
      priceSource,
      tenantId,
      latencyMs,
      meta,
      reservationUsd,
      // ⛔ THE PATH THAT MATTERS MOST AND THE ONE THAT WAS WRONG. This is the agent/chat stream —
      // the only broker entry point `ai/agent.ts` uses — and it passed `providerKind` as the emit's
      // provider while handing the real vendor (`presetKey`) to `priceFor` three lines up. So every
      // external OpenRouter turn would have reached billing labelled `openai_compatible`.
      presetKey,
      credentialSource,
      providerRequestId,
    );
    settled = true; // the ledger row now exists — the reserved slot must NOT be released below
    yield {
      type: 'done',
      result: { ...(text ? { text } : {}), ...(toolCalls ? { toolCalls } : {}), usage },
      costUsd,
      tenantCostUsd: tenantChargeUsd({ presetKey, model, credentialSource, costUsd }),
      ...(warn ? { warn } : {}),
    };
  } catch (err) {
    // ⛔ A PROVIDER "OUT OF CREDIT" IS A GOVERNANCE REFUSAL ON THIS PATH TOO.
    //
    // `runMetered` has classified this since it was written, and returns `kind: 'budget_exhausted'`.
    // This generator did not: it let the raw `LlmProviderHttpError` propagate, so `ai/agent.ts`'s
    // catch found no `BrokerRejection`, emitted no `kind`, and the chat panel rendered the provider's
    // own string — measured, a Dutch reader got `openrouter 402: insufficient credit for this
    // request`. That is WORSE than the English paragraph it was supposed to replace, and it made
    // `budget_exhausted` dead copy on the chat surface while the union claimed it was reachable.
    //
    // The `BrokerRejection` contract — thrown before any token reaches the consumer — HOLDS here
    // structurally, it is not a hope: the adapter raises `LlmProviderHttpError` only on `!res.ok`
    // (adapters/openai.ts:203,217), i.e. on the HTTP response, before the first SSE frame is read.
    // There is therefore no "already streamed some text" case to guard, and adding a guard for one
    // would be a provably dead branch.
    //
    // `settled` is still false, so the `finally` below hands the reserved slot back exactly as it
    // does for any other failure — this changes the error's SHAPE, never the metering.
    if (isCreditExhaustion(err)) {
      throw new BrokerRejection('budget_exhausted', BUDGET_EXHAUSTED_MESSAGE, {
        rule: 'llm_budget_exhausted',
      });
    }
    throw err;
  } finally {
    if (!settled) {
      // ⛔ THE DEFECT THIS BLOCK CLOSES: a caller abort (client disconnect, `args.signal`, an
      // early `for await … break`) or a mid-stream provider death both land here with `settled`
      // still false — same as the "nothing streamed" case above — but ONLY when real text was
      // never generated is a plain refund correct. The moment `text`/`toolCalls` hold anything,
      // the vendor has already been charged for tokens this generator DELIVERED to the caller,
      // and `releaseCall` would make that spend vanish: the reservation gets refunded, no
      // `usage_events` row exists, and the money is gone from the ledger with nothing to show
      // for it. This is the ONLY exit in this file where that can happen — every other early exit
      // precedes provider work entirely.
      const streamedSomething = text !== '' || (toolCalls?.length ?? 0) > 0;
      if (!streamedSomething) {
        // Unchanged from before this fix, on purpose: the well-covered zero-token path (cap
        // rejection, an immediate throw, a stream that yielded nothing before dying) keeps its
        // exact prior behaviour. That bounds this change strictly to the defect above and
        // regresses nothing.
        await releaseCall(deps, userId, reservationUsd, platform);
      } else {
        // Settle an ESTIMATE. The provider's authoritative `usage` only ever arrives on the
        // terminal `done` frame (~1273 above) — an abort by definition never reaches it — so
        // there is no real `tokensOut` to settle with. `estimateTokens` (chars/4) is the SAME
        // helper the reservation above was priced with; reusing it here rather than inventing a
        // second estimator keeps the estimate self-consistent with what was reserved. `estTokensIn`
        // is the identical number the reservation used, for the same reason. Recording this as
        // `price_source='abort_estimate'` (migration 0087) rather than whatever `priceFor` would
        // otherwise stamp keeps the provenance honest: fabricating this as `'provider'` or
        // `'table'` truth would assert a precision this number does not have and would be worse
        // than the leak it fixes — an operator reading the ledger must be able to tell "this row
        // is a best-effort guess about an interrupted call" from "this row is what the vendor
        // actually reported."
        try {
          const latencyMs = performance.now() - t0;
          const tokensOut = estimateTokens(text);
          const { costUsd } = priceFor(limits, presetKey, model, estTokensIn, tokensOut);
          await settleSpend(
            deps,
            userId,
            providerKind,
            model,
            estTokensIn,
            tokensOut,
            costUsd,
            'abort_estimate',
            tenantId,
            latencyMs,
            meta,
            reservationUsd,
            // Same vendor on the abort-settle row as on the success row. An aborted stream that
            // delivered real text was still charged by the SAME vendor, so labelling it differently
            // here would split one tenant's OpenRouter spend across two `provider` values in
            // billing purely by whether the reader disconnected.
            presetKey,
            credentialSource,
            // The abort path usually HAS one: the id arrives on the stream's first frame, and an
            // interrupted call the vendor still charged for is the row most worth reconciling.
            providerRequestId,
          );
          // Mirrors the success path: the ledger row now exists, so the call slot must NOT also
          // be released — settle-or-release, exactly once, is what `settled` exists to enforce.
          settled = true;
          incCounter('llm_stream_abort_settled_total');
        } catch (settleErr) {
          // Mirrors `releaseCall`'s own documented contract: log, never throw. The stream is
          // already unwinding (a thrown error or an abandoned generator); a throw from THIS
          // finally would replace that original failure/abandonment with a settle-plumbing error
          // instead of surfacing it, and — for the `.return()` abandonment case — an uncaught
          // throw out of a `finally` during generator cleanup is not something callers expect to
          // catch at all. Fall back to `releaseCall` so the slot is never left stuck: `settled`
          // is still false here, so this is exactly the "nothing streamed" branch above, just
          // reached from the other side of a failed settle.
          log.error('broker_stream_abort_settle_failed', {
            userId,
            model,
            reservationUsd,
            err: settleErr instanceof Error ? settleErr.message : String(settleErr),
          });
          incCounter('llm_stream_abort_settle_failed_total');
          await releaseCall(deps, userId, reservationUsd, platform);
        }
      }
    }
  }
}
