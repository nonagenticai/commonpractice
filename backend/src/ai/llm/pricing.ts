// src/ai/llm/pricing.ts — what a brokered LLM call actually COST.
//
// This replaces `llm-broker.ts priceUsd()`, which multiplied every call by two flat constants
// ($3/$15 per Mtok, "Claude-Sonnet-ish") whose own config comment admitted they were "mock
// pricing … so totals look real". That was model-blind AND provider-blind: the in-cluster
// `local-llm` (marginal cost ~$0) and `google/gemma-4-26b-a4b-it:free` (real price exactly zero)
// were both billed at Sonnet rates. Because `usage_counters.spend_usd` is summed over 7 days and
// checked against the `spend.weekly_spend_ceiling` governance policy, that error did not merely
// mis-draw a dashboard — it could REFUSE SERVICE for spend that never happened.
//
// The pricing model here is a hybrid, deliberately weighted toward what the provider REPORTS:
//
//   1. `provider` — OpenRouter returns the actual charged amount for the generation in its
//      `usage.cost` field. That is the money, not an approximation of it, so it always wins.
//      No price table can beat the invoice.
//   2. `table`    — the five DIRECT providers (Anthropic, OpenAI, DeepSeek, xAI, Cohere) publish
//      no pricing API at all: `/v1/models` returns ids and capabilities, never prices. So this is
//      a hand-maintained table, and it WILL go stale. It therefore lives in the `models.pricing`
//      governance policy row (not in this file) so an operator can correct it on the Governance
//      screen without a deploy — the same rationale, and the same `map` control, as
//      `models.work_tiers`. The catalog defaults are only the seed.
//   3. `flat`     — the two-constant estimate (`LLM_IN_RATE_USD` / `LLM_OUT_RATE_USD`), the last
//      resort for a model nobody has priced: a `custom` preset, an unknown model id, AND — since
//      the correction below — the in-cluster `local-llm`. It is recorded as such in
//      `usage_events.price_source` so the UI can hedge it honestly instead of guessing.
//
// Every priced call reports which of the three produced the number. That provenance is the point:
// a provider-reported figure is the truth and should stop being labelled an estimate, while a
// flat-rate figure should never stop being labelled one.
//
// ---------------------------------------------------------------------------------------------
// ⚠ CORRECTION (2026-08-12), because the paragraph above used to end with the opposite rule and
// the reasoning that produced it is still worth reading before anyone re-applies it.
//
// The original work zeroed `local-llm` outright, in TWO independent places: a `ZERO_COST_MODELS`
// hardcode here, and a `local/*` wildcard row in the catalog's seeded price table
// (`provider-catalog.ts`). Both are now gone. What that produced, measured against prod:
//
//   • Every `usage_events` row this deployment has EVER written is model `local-llm` — CP has
//     never called a paid provider — so from the day those two rules landed, 100% of metered
//     traffic priced at exactly $0.00.
//   • `LLM_IN_RATE_USD` / `LLM_OUT_RATE_USD` therefore became unreachable dead config, while the
//     gitops configmap that sets them ($10/$25 per Mtok) states they are "chosen so the cost
//     screens show meaningful, non-zero spend".
//   • The `spend.weekly_spend_ceiling` governance policy evaluated `0 + 0 > 15` on every call —
//     structurally unreachable — while the Governance screen reported it `enabled`. A limit that
//     cannot be reached is not a limit, and nothing about it was testable end to end.
//
// So local inference is now priced NOTIONALLY, at the flat tier. The marginal cost of a call on
// hardware we already own really is ~$0 — that fact has not changed and is not in dispute. What
// changed is what the number is FOR: an internal chargeback estimate, deliberately stamped
// `price_source='flat'` so every screen keeps calling it an estimate, which is the only thing that
// makes the cost screens and the spend ceiling exercisable at all.
//
// ⛔ The original defect this replaced is REAL and must not be re-introduced: a tenant running
// only free/local models must never be REFUSED SERVICE for spend that never happened. The bound
// on that risk is arithmetic, not optimism — August prod metered 60,907 input + 19,094 output
// tokens, which at the configured $10/$25 per Mtok is $1.09 for the MONTH against a ceiling of
// $15 per user per WEEK. Before changing either rate, redo that sum; a notional rate large enough
// to trip the ceiling on local-only traffic would recreate the refusal, and this comment is the
// reason nobody has to rediscover why.
// ---------------------------------------------------------------------------------------------
import { providerCatalog, LOCAL_LLM_MODELS } from './provider-catalog';

/** A published per-model rate, in USD per MILLION tokens — the unit every vendor quotes. */
export interface ModelRate {
  inUsdPerMtok: number;
  outUsdPerMtok: number;
}

/**
 * The live price table, flattened to one entry per priced model.
 *
 * The key is `${presetKey}/${model}` split on the FIRST slash, so an OpenRouter id that already
 * contains slashes round-trips intact: `openrouter/google/gemma-4-26b-a4b-it:free` parses as
 * preset `openrouter`, model `google/gemma-4-26b-a4b-it:free`. A `${presetKey}/*` entry prices
 * every model of that preset (used for `local`, where the whole point is that nothing is charged).
 *
 * Flat rather than nested because the governance `map` control is a string→string dictionary
 * edited as one labelled field per key — the same shape `models.work_tiers` uses.
 */
export type PricingTable = Record<string, ModelRate>;

/** Where a priced call's number came from. Persisted to `usage_events.price_source`.
 *
 * `'abort_estimate'` (migration 0087) is never produced by `priceCall` below — it is stamped
 * only by `brokerChatStream`'s `finally`, for a stream that generated and delivered real text but
 * never reached the provider's terminal frame (a caller abort or a mid-stream provider death), so
 * the settled `tokensOut` is `estimateTokens(text)`, not a provider-reported or table-priced
 * count. Kept distinct from `'flat'`: `'flat'` means "this MODEL has no pricing-table entry";
 * `'abort_estimate'` means "this CALL never got the chance to report its real usage." */
export type PriceSource = 'provider' | 'table' | 'flat' | 'abort_estimate';

export interface PricedCall {
  costUsd: number;
  source: PriceSource;
}

/**
 * Model ids that are free by construction on a HARDWARE-POLICY basis, whatever preset routes them.
 *
 * ⛔ DELIBERATELY EMPTY, and the empty set is the decision — do not read it as a list nobody has
 * filled in yet. It held exactly one entry, `local-llm`, and removing that entry is the change
 * described in the module header: the in-cluster router's marginal cost really is ~$0, but pricing
 * it at literally zero made 100% of this deployment's metered traffic cost $0.00, which turned
 * both the cost screens and the weekly spend ceiling into decoration. `local-llm` now falls
 * through `lookupRate` (no preset entry either — see `provider-catalog.ts`) to the flat tier and
 * is stamped `price_source='flat'`, i.e. priced as the internal estimate it is.
 *
 * The type is kept rather than the whole mechanism deleted because the DISTINCTION it draws is
 * still the right one: this is for "our own hardware, so we choose not to charge", which is a
 * policy we can reverse, as opposed to `isFreeModelId` below, which is a VENDOR fact we cannot.
 * Anything added here again must be free for the second reason, not the first.
 */
const ZERO_COST_MODELS = new Set<string>([]);

/** OpenRouter marks zero-price models with a `:free` id suffix. Structural, not a price that
 *  churns, so it is a rule here rather than a table row that could go stale.
 *
 *  ⛔ KEPT ON PURPOSE while `ZERO_COST_MODELS` was emptied around it. These two rules look alike
 *  and are not: a `:free` id is a statement by the VENDOR that this generation is billed at zero,
 *  so pricing it notionally would invent spend against an invoice that will read $0.00 — the exact
 *  over-billing the pricing work exists to remove. `local-llm` was OUR policy about OUR hardware,
 *  and only that half was reversed. */
function isFreeModelId(model: string): boolean {
  return model.endsWith(':free');
}

/** Free by construction, whatever preset routes it — the same rule `lookupRate` applies before
 *  ever consulting the table. Exported so the drift guard below (and anything else auditing a
 *  bare model id without a presetKey) doesn't have to re-derive it. */
export function isZeroCostModel(model: string): boolean {
  return isFreeModelId(model) || ZERO_COST_MODELS.has(model);
}

/** numeric(12,6) — never float the ledger. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Build the `${presetKey}/${model}` table key. */
export function pricingKey(presetKey: string, model: string): string {
  return `${presetKey}/${model}`;
}

/**
 * Parse the governance `map` value (`"<inPerMtok>/<outPerMtok>"`) into a rate.
 *
 * Defensive on purpose: this string is operator-editable on the Governance screen, so a typo must
 * degrade to "this model is unpriced" (falling through to the next tier) rather than poisoning the
 * ledger with NaN. Negative values are rejected for the same reason.
 */
export function parseRate(raw: unknown): ModelRate | undefined {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split('/');
  if (parts.length !== 2) return undefined;
  const inUsdPerMtok = Number.parseFloat(parts[0]!.trim());
  const outUsdPerMtok = Number.parseFloat(parts[1]!.trim());
  if (!Number.isFinite(inUsdPerMtok) || !Number.isFinite(outUsdPerMtok)) return undefined;
  if (inUsdPerMtok < 0 || outUsdPerMtok < 0) return undefined;
  return { inUsdPerMtok, outUsdPerMtok };
}

/** Render a rate back to the governance `map` string form. */
export function formatRate(r: ModelRate): string {
  return `${r.inUsdPerMtok}/${r.outUsdPerMtok}`;
}

/** Parse a whole `models.pricing` policy value into a usable table, skipping malformed rows. */
export function parsePricingTable(value: unknown): PricingTable {
  const out: PricingTable = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const rate = parseRate(raw);
    if (rate) out[key] = rate;
  }
  return out;
}

export interface PriceCallArgs {
  /** The provider-catalog preset the call actually went to (`anthropic`, `openrouter`, `local`,
   *  …). Undefined when the caller could not derive one — e.g. the runner's mode-driven env
   *  provider — in which case only the model-level rules and the flat fallback apply. */
  presetKey?: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** The provider's OWN charge for this generation, when it reported one (OpenRouter
   *  `usage.cost`). Always wins when present and sane. */
  reportedCostUsd?: number | null;
  table: PricingTable;
  /** The legacy flat estimate, retained as the last resort. USD per TOKEN (config.llm.*RateUsd). */
  flatInRateUsd: number;
  flatOutRateUsd: number;
}

/**
 * Price one completed call, and say where the number came from.
 *
 * Precedence is fixed and deliberate — see the module header. Note that a reported cost of
 * exactly 0 is a legitimate answer (a free model really did cost nothing), so the check is
 * "is it a usable number", never "is it truthy".
 */
export function priceCall(args: PriceCallArgs): PricedCall {
  const { presetKey, model, tokensIn, tokensOut, reportedCostUsd, table } = args;

  // 1. The provider told us what it charged. That is not an estimate of the money — it IS the
  //    money. Nothing in a table can improve on it.
  if (
    reportedCostUsd != null &&
    Number.isFinite(reportedCostUsd) &&
    reportedCostUsd >= 0
  ) {
    return { costUsd: round6(reportedCostUsd), source: 'provider' };
  }

  const rate = lookupRate(table, presetKey, model);
  if (rate) {
    const raw =
      (tokensIn / 1_000_000) * rate.inUsdPerMtok + (tokensOut / 1_000_000) * rate.outUsdPerMtok;
    return { costUsd: round6(raw), source: 'table' };
  }

  // 3. Nothing prices this (model, preset): an unknown id, a `custom` BYO endpoint, or — since
  //    2026-08-12 — the in-cluster `local-llm`, which is deliberately absent from the table.
  //    Fall back to the flat estimate rather than silently booking zero: under-reporting spend
  //    defeats the weekly ceiling entirely, which is precisely what zeroing local inference did
  //    to 100% of this deployment's traffic. Recorded as 'flat' so the UI keeps hedging it.
  const raw = tokensIn * args.flatInRateUsd + tokensOut * args.flatOutRateUsd;
  return { costUsd: round6(raw), source: 'flat' };
}

/** Resolve a rate for (preset, model), or undefined when nothing prices it. */
function lookupRate(
  table: PricingTable,
  presetKey: string | null | undefined,
  model: string,
): ModelRate | undefined {
  // Free by construction, regardless of how it was routed. Today this is the `:free` VENDOR
  // suffix only — `ZERO_COST_MODELS` is empty, so a local model no longer short-circuits here and
  // reaches the flat tier below via `!presetKey`.
  if (isZeroCostModel(model)) {
    return { inUsdPerMtok: 0, outUsdPerMtok: 0 };
  }
  if (!presetKey) return undefined;
  return table[pricingKey(presetKey, model)] ?? table[pricingKey(presetKey, '*')];
}

// ---------------------------------------------------------------------------------------------
// Allowlist ⇄ pricing drift guard
//
// `models.allowlist` (the broker's model gate, `policy-store.ts GovernanceSnapshot
// .allowlistedModels`) and `models.pricing` (this module's table, same snapshot
// `.modelPricing`) are BOTH hand-edited governance rows, edited independently, on the same
// Governance screen, by the same operator action ("add a model") — but nothing ties them
// together. An operator can allowlist a model this table has never heard of (that is exactly
// how `claude-opus-4-7` got allowlisted in prod with no matching price row: a routine
// allowlist edit, not a deploy, and not a `provider-catalog.ts` change either). `priceCall`
// already fails safe when that happens — it falls through to the flat estimate rather than
// booking $0 — but "safe" here still means real spend can run ~1.67x ahead of what the weekly
// ceiling counter shows before anyone notices. The fix is not a data edit (0053's own header
// says the table WILL go stale); it's making that drift visible.
// ---------------------------------------------------------------------------------------------

/**
 * Governance-accepted models that will NEVER get a price entry, and so must never be reported
 * as drift by `findUnpricedAllowlistedModels`. Two sources, both already declared as
 * deliberate omissions elsewhere (this list doesn't invent new judgment calls, it just records
 * the existing ones somewhere a guard can read):
 *
 *   1. The Cohere Command A family — `provider-catalog.ts`'s `cohere.pricing` comment explains
 *      Cohere publishes no per-token rate for these three ids anywhere (the pricing page has
 *      moved them behind contact-sales). There is no structural signal that distinguishes
 *      "no rate exists" from "nobody priced it yet" — that judgment call was already made in
 *      0053, so it is hand-listed here rather than re-derived.
 *   2. Every model belonging to a catalog preset marked `custom: true` — unpriceable BY
 *      DEFINITION, since a `custom` call supplies both `base_url` and `model` freely with no
 *      vendor list to price against. Derived from the catalog (not hand-listed) so this stays
 *      correct if `custom` preset ever grows named models; today `custom.models` is `[]`, so
 *      this contributes nothing.
 *   3. `local-llm` — the in-cluster router alias. It has NO vendor and therefore no list price to
 *      go stale, so a price-table row for it would be a fiction dressed as a published rate. It is
 *      priced at the flat tier on purpose (see the module header), which is exactly what
 *      "deliberately unpriced" means here: the drift guard asks "did an operator allowlist a model
 *      nobody priced", and for this one the answer is "yes, and that is the design".
 *      ⚠ This entry is REQUIRED, not cosmetic. Until 2026-08-12 `local-llm` was rescued from the
 *      guard by `isZeroCostModel`; emptying `ZERO_COST_MODELS` without adding it here makes the
 *      guard report the platform's own default model as governance drift on every boot, and turns
 *      the catalog's self-consistency test red — a false alarm on the one model that is always
 *      allowlisted.
 */
export const ACCEPTED_UNPRICED_MODELS: ReadonlySet<string> = new Set<string>([
  'command-a-plus-05-2026',
  'command-a-reasoning-08-2025',
  'command-a-03-2025',
  'local-llm',
  ...providerCatalog()
    .filter((preset) => preset.custom)
    .flatMap((preset) => preset.models),
]);

/** The two fields `findUnpricedAllowlistedModels` needs off a `GovernanceSnapshot` — a narrow
 *  structural type (not imported from `policy-store.ts`) so this module never has to depend on
 *  the policy store; the real snapshot satisfies this shape without a cast. */
export interface AllowlistPricingSnapshot {
  allowlistedModels: string[];
  modelPricing: PricingTable;
}

/** The model-id half of a `${presetKey}/${model}` table key (inverse of `pricingKey`, splitting
 *  on the same FIRST slash so an OpenRouter id that contains its own slashes round-trips). */
function modelIdFromTableKey(key: string): string {
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Every model on the governance allowlist that resolves to NO price anywhere in the pricing
 * table, and is not accepted as deliberately unpriced.
 *
 * The allowlist is preset-agnostic — `models.allowlist` is a flat list of bare model ids with no
 * `presetKey` attached (see `policy-store.ts` / `seed-platform.ts CATALOG_MODELS`), so this
 * cannot do the same `(presetKey, model)` exact lookup `lookupRate` does at call time. Instead it
 * checks whether the bare id matches the MODEL half of any table key, for any preset. That is a
 * deliberate relaxation, not a bug: a real price collision across two different providers' model
 * ids is not a realistic risk (`claude-*`, `gpt-*`, `command-*`, `deepseek-*`, `grok-*` are all
 * provider-distinctive), and the alternative — resolving each allowlist entry to a single
 * "owning" preset via the catalog's curated dropdown lists — is exactly what would make this
 * guard BLIND to the bug it exists to catch: `claude-opus-4-7` isn't in `anthropic.models`
 * either, so a dropdown-membership check would silently bucket it as "not this preset's problem"
 * instead of flagging it.
 *
 * ⛔ SCOPE, stated precisely because the relaxation above has one reachable consequence. This
 * audits GOVERNANCE DRIFT for the curated presets — "an operator allowlisted a model nobody
 * priced". It is NOT a guarantee that every call prices from the table, and must not be read as
 * one. The gap: `routes/llm-settings.ts:81` skips catalog validation for `custom` presets
 * (`!preset.custom && !preset.models.includes(...)`), so a tenant with a BYO OpenAI-compatible
 * endpoint may store ANY model string — including one this table already prices under a different
 * preset, e.g. `claude-opus-4-8`. At call time `lookupRate` does the exact `(presetKey, model)`
 * lookup, finds no `custom/claude-opus-4-8`, and flat-estimates; this guard meanwhile reports no
 * drift, because the bare id IS priced somewhere. Verified empirically:
 *
 *   findUnpricedAllowlistedModels({allowlistedModels:['claude-opus-4-8'], modelPricing: seeded})
 *     -> []                                  // "no drift"
 *   priceCall({presetKey:'custom', model:'claude-opus-4-8', tokensIn:1e6, tokensOut:1e6, ...})
 *     -> { source:'flat', costUsd:18 }       // the real Anthropic rate would be 30
 *
 * That flat fallback is WORKING AS DESIGNED — 0053 declares every `custom`-preset model
 * unpriceable (CP cannot know a third party's rate for a BYO endpoint) and stamps
 * `price_source='flat'` so the Usage screen keeps calling it an estimate. What would be wrong is
 * letting this function imply otherwise, so: it deliberately does not try to model `custom`, and
 * `pricing.test.ts` pins the behaviour above so nobody "fixes" the guard into a false promise.
 */
export function findUnpricedAllowlistedModels(
  snapshot: AllowlistPricingSnapshot,
  acceptedUnpriced: ReadonlySet<string> = ACCEPTED_UNPRICED_MODELS,
): string[] {
  const pricedModelIds = new Set(
    Object.keys(snapshot.modelPricing).map(modelIdFromTableKey),
  );
  const unpriced = snapshot.allowlistedModels.filter(
    (model) =>
      !isZeroCostModel(model) && !acceptedUnpriced.has(model) && !pricedModelIds.has(model),
  );
  // De-dupe defensively — `models.allowlist` is operator-edited free text and could repeat.
  return [...new Set(unpriced)];
}

/**
 * Catalog models that the governance allowlist does NOT permit — i.e. models a tenant admin can
 * select in the LLM-settings dropdown and save, whose every call the broker will then refuse with
 * `model_not_allowed`.
 *
 * This is the inverse drift of `findUnpricedAllowlistedModels`, and it is the more damaging one:
 * unpriced-but-allowlisted merely mis-bills, whereas allowlisted-nowhere makes a configured
 * workspace permanently non-functional.
 *
 * Root cause it exists to surface: `models.allowlist` is seeded ONCE from the catalog
 * (`db/seed-platform.ts` `CATALOG_MODELS`, `ON CONFLICT DO NOTHING`) and is never reconciled
 * afterwards, so it freezes at whatever the catalog held on the first seed while the catalog keeps
 * evolving. Live prod had drifted to 7 allowlisted ids against 21 in the catalog — every OpenAI,
 * DeepSeek, xAI and Cohere model, four entire providers, selectable and then refused.
 *
 * ⛔ Reports only. It deliberately does NOT auto-add the missing ids: the allowlist is a governance
 * CONTROL, and silently widening what a platform permits because code shipped a new model would
 * invert who decides that. Making the drift loud is the fix; choosing the contents stays human.
 */
export function findUnallowlistedCatalogModels(snapshot: {
  allowlistedModels: string[];
}): string[] {
  // Mirror the broker's own semantics exactly (`llm-broker.ts` reserveCall): an absent or empty
  // allowlist means "no restriction", so nothing can be missing from it.
  const allowed = snapshot.allowlistedModels;
  if (!allowed || allowed.length === 0) return [];
  const allowedSet = new Set(allowed);
  const catalogModels = [...new Set(providerCatalog().flatMap((preset) => preset.models))];
  return catalogModels.filter((model) => !allowedSet.has(model));
}

// ---------------------------------------------------------------------------------------------
// What the TENANT pays for a call — distinct from the ledger figure above.
//
// ⛔ THE LEDGER STAYS NOTIONAL; ONLY THE TENANT-FACING FIGURE IS ZERO. The CORRECTION block at the
// top of this file prices `local-llm` at the flat tier ON PURPOSE, so `usage_events.cost_usd` and
// the weekly spend ceiling stay exercisable. That is an internal chargeback estimate. It is NOT a
// charge to the tenant: the `local-llm` plan is "the platform's in-cluster inference-router, paid by
// the platform" (services/plan-posture.ts), and the owner rule in provider-catalog.ts is that the
// platform credential only ever serves local models. Showing that estimate to a tenant as their own
// "AI usage this session" told a brand-new early-access admin that one question cost ~$0.50
// (prod, 2026-10-16: 8 calls x ~6k prompt tokens x $10/Mtok) for inference on our own GPU.
//
// So the chat panel shows this number instead. A call is tenant-free ONLY when all three hold:
// the in-cluster router (`presetKey === 'local'`), a local model id, and the PLATFORM's credential.
// A tenant's own key (`tenant_byo`) or any commercial preset is shown exactly as priced.
// ---------------------------------------------------------------------------------------------
export interface TenantChargeArgs {
  presetKey?: string | null;
  model: string;
  credentialSource?: 'tenant_byo' | 'platform_managed' | 'none' | null;
  costUsd: number;
}

export function isPlatformPaidLocal(a: Omit<TenantChargeArgs, 'costUsd'>): boolean {
  return (
    a.presetKey === 'local' &&
    LOCAL_LLM_MODELS.includes(a.model) &&
    a.credentialSource === 'platform_managed'
  );
}

export function tenantChargeUsd(a: TenantChargeArgs): number {
  return isPlatformPaidLocal(a) ? 0 : a.costUsd;
}
