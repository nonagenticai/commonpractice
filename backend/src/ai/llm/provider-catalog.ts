// src/ai/llm/provider-catalog.ts — the curated provider/model catalog that powers the
// tenant-admin LLM-settings dropdowns AND validates what a tenant may save.
//
// CommonPractice runs self-contained (no worker_management/pydantic-ai dependency): it
// has exactly two adapters — AnthropicProvider (Claude) and OpenAiProvider (OpenAI Chat
// Completions). Every other provider (OpenAI, DeepSeek, Grok/xAI, Cohere) and the
// in-cluster inference-router speak the OpenAI-completions API, so they are all served by
// OpenAiProvider by varying { base_url, api_token, model }. A "preset" is therefore a
// friendly bundle of {adapterKind, defaultBaseUrl, requiresKey, models} that maps onto the
// llm_provider enum (anthropic | openai_compatible). `local` is the platform default — the
// in-cluster inference-router (its base_url comes from gitops via config, not hard-code).
import { config } from '../../config';
import { ANTHROPIC_DEFAULT_BASE } from './adapters/anthropic';
import { OPENAI_DEFAULT_BASE } from './adapters/openai';

/** The DB llm_provider enum (db/schema.ts llmProviderEnum). */
export type LlmProviderKind = 'anthropic' | 'openai' | 'openai_compatible';

export interface ProviderPreset {
  /** Stable preset key (what the UI selects + what we resolve a stored row back to). */
  key: string;
  /** Human label for the dropdown. */
  label: string;
  /** Which adapter serves it. */
  adapterKind: LlmProviderKind;
  /** Default base_url for the OpenAI-compatible adapter (null = adapter default / native). */
  defaultBaseUrl: string | null;
  /** Whether a tenant API token is required (false only for the in-cluster local model). */
  requiresKey: boolean;
  /** Curated model ids for the dropdown. `local` is dynamic-ish (the router alias). */
  models: string[];
  /** A custom/escape-hatch preset lets the user type base_url + model freely. */
  custom?: boolean;
  /**
   * Published list price per model, as `"<inputUsdPerMtok>/<outputUsdPerMtok>"` — the unit every
   * vendor quotes. A `'*'` key prices every model of the preset.
   *
   * These are only the SEED for the `models.pricing` governance row (migration 0053); the live
   * values are read from that row, so a price change is a Governance-screen edit, not a deploy.
   * A model absent here is deliberately unpriced: it falls back to the flat estimate and is
   * recorded as `price_source='flat'` rather than being given an invented number.
   */
  pricing?: Record<string, string>;
}

/** The in-cluster inference-router base url — sourced from gitops (config.llm.openaiBaseUrl),
 *  never hard-coded, so the platform default tracks the deployment. */
function localBaseUrl(): string {
  return config.llm.openaiBaseUrl || 'http://inference-router.inference-router.svc.cluster.local:8150/api';
}

/**
 * The ONLY models a call may target when it is NOT paid for with the tenant's own key.
 *
 * ⛔ OWNER RULE (2026-10-13): commercial models are only ever called with the TENANT'S OWN key. The
 * platform never pays for, and never serves, a commercial model. So every platform-credential path
 * (env key, the platform's or the tenant's inference-router token, a platform-held grant key stored
 * in a `trial_managed` / `platform_managed` row) is confined to the in-cluster router AND to these
 * models — see `services/byo-posture.ts assertPlatformLocalOnly`.
 *
 * This is the SAME list the `local` preset offers (it is spread into `models` below), so the
 * dropdown and the enforcement cannot drift apart.
 */
export const LOCAL_LLM_MODELS: readonly string[] = ['local-llm'];

/**
 * Is (kind, baseUrl, model) the in-cluster router serving a local model?
 *
 * The target is compared by adapter IDENTITY (scheme + host), exactly how `select.ts envKeyFor`
 * decides who the platform key belongs to, against the `local` preset's base url. Anthropic is never
 * local. The model must be in `LOCAL_LLM_MODELS` — on its own the target check is not enough,
 * because `localBaseUrl()` IS `OPENAI_BASE_URL`, which a self-host may point at api.openai.com.
 */
/**
 * Is (kind, baseUrl) the CONFIGURED in-cluster router (`OPENAI_BASE_URL`)? The one target CP itself
 * supplies a credential for (a router token, never a provider key). False when no router is
 * configured (dev/CI), so keyless calls there stay on the stub.
 */
export function isConfiguredRouterTarget(kind: LlmProviderKind, baseUrl: string | null): boolean {
  if (kind === 'anthropic' || !config.llm.openaiBaseUrl) return false;
  return adapterIdentityFor(kind, baseUrl) === adapterIdentityFor('openai_compatible', config.llm.openaiBaseUrl);
}

export function isPlatformLocalTarget(kind: LlmProviderKind, baseUrl: string | null, model: string): boolean {
  if (kind === 'anthropic') return false;
  if (adapterIdentityFor(kind, baseUrl) !== adapterIdentityFor('openai_compatible', localBaseUrl())) return false;
  return LOCAL_LLM_MODELS.includes(model);
}

/**
 * The three model tiers a tenant's welcome budget is granted against, keyed by work tier.
 *
 * These are the DEFAULTS. The live values come from the `models.work_tiers` governance policy row
 * (seed-platform.ts), so they can be changed on the Governance screen without a deploy — which is
 * the whole point: model ids churn far faster than releases do. `workTierModels()` reads the policy
 * with these as the fallback.
 */
export const DEFAULT_WORK_TIER_MODELS = {
  small: 'google/gemma-4-26b-a4b-it:free',
  medium: 'nvidia/nemotron-3-super-120b-a12b',
  large: 'z-ai/glm-5.2',
} as const;

export type WorkTier = keyof typeof DEFAULT_WORK_TIER_MODELS;

/** OpenRouter's OpenAI-compatible base. Public constant so the egress allowlist can reference it. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_HOST = 'openrouter.ai';

/** Build the catalog. A function (not a const) so `local`'s base_url reflects the live config. */
export function providerCatalog(): ProviderPreset[] {
  return [
    {
      key: 'local',
      label: 'Local (pgx vLLM)',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: localBaseUrl(),
      requiresKey: false,
      // The inference-router's stable alias for the pgx vLLM (gemma); the router maps it.
      models: [...LOCAL_LLM_MODELS],
      // ⛔ DELIBERATELY UNPRICED — no `pricing` key at all, so `local-llm` reaches the flat tier
      // (`LLM_IN_RATE_USD`/`LLM_OUT_RATE_USD`) and is stamped `price_source='flat'`. See the
      // CORRECTION block in `ai/llm/pricing.ts` for the full reasoning; the part specific to THIS
      // file is why the entry that used to sit here (`pricing: { '*': '0/0' }`) had to go too:
      //
      // Emptying `ZERO_COST_MODELS` alone would have been INERT for most of prod. `local/*` is a
      // preset-WILDCARD row, and it is consulted whenever a call carries `presetKey === 'local'`
      // — which `presetKeyFor(kind, base_url)` returns for every tenant whose stored base_url is
      // the router, AND for the env fallback (`select.ts envFallback` passes OPENAI_BASE_URL, and
      // its own comment says so). That is the agent-chat path, i.e. the bulk of the traffic. So
      // with this row still present the model-level hardcode could be deleted and every screen
      // would go on reading $0.00, with the change looking applied and measuring nothing.
      //
      // Absent rather than set to a notional number on purpose: a `pricing` row is a PUBLISHED
      // VENDOR RATE (the header above says so, and the whole table exists to be corrected on the
      // Governance screen when a vendor's list price moves). `local-llm` has no vendor and no list
      // price; putting $10/$25 here would stamp `price_source='table'`, which the UI is entitled to
      // present as fact. The flat tier says "estimate" — which is what an internal chargeback
      // figure for our own hardware is.
      //
      // An operator who wants a firm number can still add `local/*` on the Governance screen; the
      // stored row wins over these defaults (`policy-store.ts asModelPricing`). That escape hatch
      // is pinned by a test so this comment stays true.
    },
    {
      key: 'anthropic',
      label: 'Anthropic (Claude)',
      adapterKind: 'anthropic',
      defaultBaseUrl: null, // native api.anthropic.com
      requiresKey: true,
      // Verified live against api.anthropic.com/v1/models (2026-06-16); latest generation first.
      models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
      // Anthropic first-party API list prices, USD per Mtok (input/output), 2026-07-29.
      pricing: {
        'claude-opus-4-8': '5/25',
        'claude-sonnet-4-6': '3/15',
        'claude-haiku-4-5': '1/5',
        'claude-fable-5': '10/50',
      },
    },
    {
      key: 'openai',
      label: 'OpenAI',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: 'https://api.openai.com/v1',
      requiresKey: true,
      // Not live-verified (no key supplied); current flagship ids.
      models: ['gpt-4o', 'gpt-4.1', 'o4-mini'],
      // platform.openai.com/docs/pricing, standard tier, 2026-07-29. (Batch tier is exactly half
      // and priority is separate; CP always calls the standard tier.)
      pricing: { 'gpt-4o': '2.5/10', 'gpt-4.1': '2/8', 'o4-mini': '1.1/4.4' },
    },
    {
      key: 'deepseek',
      label: 'DeepSeek',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      requiresKey: true,
      // Verified live against api.deepseek.com/v1/models (2026-06-16) — V4 is current.
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      // api-docs.deepseek.com/quick_start/pricing, 2026-07-29 — the OFFICIAL table.
      // ⚠ Every pricing aggregator (deepseek.ai — not DeepSeek's domain — benchlm, costgoat,
      // aipricing.guru) reports v4-pro at 1.74/3.48, i.e. 4× the real rate. Do not "correct"
      // these numbers from a search result; re-check api-docs.deepseek.com.
      pricing: { 'deepseek-v4-flash': '0.14/0.28', 'deepseek-v4-pro': '0.435/0.87' },
    },
    {
      // Key is 'xai' — matching the platform provider key used by
      // worker_management's provider_catalog and billing-service's
      // provider_pricing rows. Naming it 'grok' here would re-create the
      // anthropic-vs-claude mis-key class that left every claude cost_event
      // at cost_usd=NULL. Safe to rename: the preset key is derived by
      // presetKeyFor() from (adapterKind + base_url) and is never persisted.
      key: 'xai',
      label: 'Grok (xAI)',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: 'https://api.x.ai/v1',
      requiresKey: true,
      // Verified live against api.x.ai/v1/models (2026-07-19). grok-4.5 is
      // xAI's current recommended default; text models only (the
      // grok-imagine-* image/video models are not chat-completions).
      models: [
        'grok-4.5',
        'grok-4.3',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
      ],
      // docs.x.ai/docs/models, 2026-07-29.
      // ⚠ KNOWN UNDER-BILLING: every grok model carries longContextThreshold=200000, above which
      // BOTH rates exactly double (grok-4.5 → 4/12; the others → 2.5/5). This table has no
      // prompt-length branch, so a >200k-token call is billed at half its real price. Accepted
      // for now — it fails in the safe direction (never over-charges, never over-triggers the
      // spend ceiling) and CP's own agent turns are nowhere near 200k. Fixing it needs a
      // tiered-rate shape, not another row.
      pricing: {
        'grok-4.5': '2/6',
        'grok-4.3': '1.25/2.5',
        'grok-4.20-0309-reasoning': '1.25/2.5',
        'grok-4.20-0309-non-reasoning': '1.25/2.5',
      },
    },
    {
      key: 'cohere',
      label: 'Cohere',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: 'https://api.cohere.ai/compatibility/v1',
      requiresKey: true,
      // Verified live against the Cohere OpenAI-compat /models (2026-06-16); latest first.
      models: ['command-a-plus-05-2026', 'command-a-reasoning-08-2025', 'command-a-03-2025', 'command-r-plus-08-2024'],
      // ⚠ THREE OF THESE FOUR ARE DELIBERATELY UNPRICED. Cohere publishes no per-token rate for
      // the Command A family anywhere (cohere.com/pricing lists only Command R and Command R7B;
      // Command A+ appears as a free open-weights card with no API rate; docs.cohere.com confirms
      // they bill per token but defers to a pricing page that no longer carries the numbers —
      // i.e. it has moved behind contact-sales). Rather than invent a figure or borrow a
      // reseller's rate, they fall through to the flat estimate and are recorded as
      // price_source='flat', which is at least honest about not knowing. Fill these in from a
      // quote or invoice.
      // command-r-plus-08-2024 IS published — 2.5/10 — but from the "For existing customers"
      // (grandfathered) block of cohere.com/pricing, 2026-07-29.
      pricing: { 'command-r-plus-08-2024': '2.5/10' },
    },
    {
      key: 'openrouter',
      label: 'OpenRouter',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: OPENROUTER_BASE_URL,
      requiresKey: true,
      // The three work-tier models a platform welcome budget is granted against. A tenant that
      // brings its OWN OpenRouter key is not restricted to these — `custom` covers anything else —
      // but keeping the tiers here means the dropdown matches what the granted budget can run.
      models: Object.values(DEFAULT_WORK_TIER_MODELS),
      // openrouter.ai/api/v1/models, 2026-07-29. These are only a SAFETY NET: OpenRouter reports
      // its actual charge per generation in `usage.cost`, which always wins (price_source
      // 'provider'), so these apply solely when a response arrives without it.
      // ⚠ `google/gemma-4-26b-a4b-it:free` is $0, but the paid twin WITHOUT the `:free` suffix is
      // 0.07/0.34 — dropping the suffix in config starts silent charges.
      // ⚠ `z-ai/glm-5.2` is OpenRouter's BLENDED price across its default route; it moves as
      // routing shifts, so it is a snapshot, not a contract rate.
      pricing: {
        'google/gemma-4-26b-a4b-it:free': '0/0',
        'nvidia/nemotron-3-super-120b-a12b': '0.085/0.4',
        'z-ai/glm-5.2': '0.6958/2.1868',
      },
    },
    {
      key: 'custom',
      label: 'Custom (OpenAI-compatible)',
      adapterKind: 'openai_compatible',
      defaultBaseUrl: null,
      requiresKey: true,
      models: [],
      custom: true,
    },
  ];
}

export function findPreset(key: string): ProviderPreset | undefined {
  return providerCatalog().find((p) => p.key === key);
}

/**
 * The seeded default for the `models.pricing` governance row, flattened to `preset/model` keys.
 *
 * Flat rather than nested because the governance `map` control is a string→string dictionary
 * edited one labelled field at a time — the same shape `models.work_tiers` uses. The key splits on
 * the FIRST slash, so an OpenRouter id that already contains slashes survives intact
 * (`openrouter/google/gemma-4-26b-a4b-it:free`).
 *
 * A function, not a const, because `local`'s entry comes from a catalog built against live config.
 */
export function defaultModelPricing(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const preset of providerCatalog()) {
    for (const [model, rate] of Object.entries(preset.pricing ?? {})) {
      out[`${preset.key}/${model}`] = rate;
    }
  }
  return out;
}

/**
 * WHO WOULD RECEIVE THIS TENANT'S KEY — the adapter family plus the host it actually talks to.
 *
 * ⛔ THIS IS DELIBERATELY NOT `presetKeyFor`, AND THE DIFFERENCE IS THE WHOLE POINT. `presetKeyFor`
 * answers "which dropdown entry does this row correspond to", and it collapses EVERY unrecognised
 * base_url onto the single `custom` key — so `https://vendor-a.example/v1` and
 * `https://vendor-b.example/v1`, two unrelated companies, are the same preset. A stored secret must
 * not survive that move, so the identity is computed from what the request would look like on the
 * wire instead:
 *   • the FAMILY, because it decides the auth header (`x-api-key` for Anthropic vs
 *     `Authorization: Bearer` for the OpenAI-completions adapter). `openai` and `openai_compatible`
 *     are one family — `buildAdapter` serves both with `OpenAiProvider`, so at the same host they
 *     are the same request carrying the same secret.
 *   • the SCHEME, because it decides whether the key crosses the network in CLEARTEXT. `https://`
 *     and `http://` at one host are the same company but NOT the same request: editing only the
 *     `s` used to keep the stored key and then ship it unencrypted to a host anyone on the path can
 *     read, which is a disclosure of the same key by a different route. Folding the protocol in
 *     makes that edit a vendor change, so the key is disowned and the tenant must re-enter it
 *     deliberately. ⛔ NOT the same as REQUIRING https, which would break this deployment: prod
 *     runs `OPENAI_BASE_URL=http://inference-router.inference-router.svc.cluster.local:8150/api`,
 *     an in-cluster plaintext hop the NetworkPolicy governs. `http` is allowed; SILENTLY MOVING a
 *     key from `https` to `http` is not.
 *   • the HOST, with each adapter's own default filled in, so a stored `null` base_url compares
 *     equal to the explicit URL it resolves to rather than reading as a vendor change.
 *
 * Host (with port) and not the full URL on purpose: a vendor that reorganises its path (`/v1` →
 * `/v2`, or Cohere's `/compatibility/v1`) is still the same company holding the same key, and a
 * needless wipe costs the tenant a re-entry for no security gain.
 */
export function adapterIdentityFor(provider: LlmProviderKind, baseUrl: string | null): string {
  const family = provider === 'anthropic' ? 'anthropic' : 'openai';
  const raw = baseUrl?.trim() || (family === 'anthropic' ? ANTHROPIC_DEFAULT_BASE : OPENAI_DEFAULT_BASE);
  try {
    const url = new URL(raw);
    return `${family}|${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    // A stored base_url that will not parse predates the route's `z.string().url()` schema. Compare
    // it literally rather than letting every such row collapse onto one identity.
    return `${family}|${raw.replace(/\/+$/, '').toLowerCase()}`;
  }
}

/** Resolve a stored row { provider, base_url } back to a preset key for the UI to preselect.
 *  Matches on (adapterKind + base_url); falls back to 'custom' for an unknown base_url. */
export function presetKeyFor(provider: LlmProviderKind, baseUrl: string | null): string {
  const cat = providerCatalog();
  if (provider === 'anthropic') return 'anthropic';
  const norm = (u: string | null) => (u ?? '').replace(/\/+$/, '').toLowerCase();
  const match = cat.find(
    (p) => p.adapterKind !== 'anthropic' && !p.custom && norm(p.defaultBaseUrl) === norm(baseUrl),
  );
  return match?.key ?? 'custom';
}
