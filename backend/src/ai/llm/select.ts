// src/ai/llm/select.ts — per-tenant chat-provider selection (SPEC §5A Layer 1,
// Session 7). The broker calls this to pick the LlmProvider for a chat turn from
// tenant_llm_settings (BYO key + model + base_url).
//
// Resolution order (owner rule 2026-10-13: CP holds NO commercial provider key of its own):
//   1. tenant row with the tenant's OWN key → that vendor's adapter, the tenant's model/base_url.
//   2. otherwise, a target that is the configured in-cluster router (OPENAI_BASE_URL) → the router,
//      carrying the tenant's inference-router licence token (or the platform's, for platform work),
//      and only for a local model (services/byo-posture.ts `assertPlatformLocalOnly`).
//   3. otherwise → the stub (keyless dev + the test suite, where OPENAI_BASE_URL is unset).
//
// The provider key NEVER leaves the host: it is decrypted here and handed to the
// adapter; nothing returns it to a caller.
import {
  assertPlatformCredentialAllowed,
  assertPlatformLocalOnly,
  tenantOwnKeyAllowed,
} from '../../services/byo-posture';
import { log } from '../../host/logger';
import { eq } from 'drizzle-orm';
import { db as defaultDb, tenantLlmSettings, runAsSystem } from '../../db/client';
import { routerCredential } from '../../services/tenant-inference';
import { config } from '../../config';
import { tryDecryptSecret } from '../../host/secret-box';
import { stubProvider } from './stub-provider';
import { AnthropicProvider } from './adapters/anthropic';
import { OpenAiProvider } from './adapters/openai';
import { governedLlmFetch } from './egress-fetch';
import { presetKeyFor, isConfiguredRouterTarget } from './provider-catalog';
import type { LlmProvider, LlmProviderCallOpts, LlmRequest } from './provider';

type Db = typeof defaultDb;
type ProviderKind = 'anthropic' | 'openai' | 'openai_compatible';

export interface ResolveChatArgs {
  tenantId: string | null;
  /** The request model (the agent default); used when the tenant row pins none. */
  model: string;
  db?: Db;
  /**
   * Platform background work (`BrokerCallMeta.platformActor`): nobody in the tenant asked for it, so
   * it keeps the PLATFORM's own router credential instead of the tenant's inference-router token.
   */
  platformActor?: boolean;
}

/** The selected provider plus the model that is actually used — the broker meters +
 *  allowlist-checks on THIS model, so a tenant override stays governed. `providerKind`
 *  is a coarse label for the usage_events ledger (the spend dashboards group by it). */
export interface ResolvedChat {
  provider: LlmProvider;
  model: string;
  providerKind: ProviderKind | 'stub';
  /**
   * The provider-catalog preset key — the real VENDOR, which `providerKind` cannot express.
   *
   * `providerKind` is the DB enum, and it collapses OpenRouter, DeepSeek, xAI, Cohere and the
   * in-cluster local router all into `openai_compatible`. That made per-vendor pricing structurally
   * impossible: there was no way to tell a $0 local call from an Anthropic-priced one. `presetKeyFor`
   * could always derive the vendor from (kind, base_url), but `ResolvedChat` did not carry the
   * base_url to derive it from — so it is derived here, at the one place the adapter is chosen.
   *
   * Undefined only for the stub (no vendor to speak of), which prices at the flat fallback.
   */
  presetKey?: string;
  /**
   * WHOSE KEY PAID FOR THIS CALL — the axis this type could not express, and the reason a BYO line
   * could not be billed as BYO.
   *
   * ⛔ `presetKey` and `providerKind` both describe the VENDOR. Neither says whether the credential
   * was the tenant's own or the platform's, and `resolveChatProvider` collapsed the two on one line
   * (`tryDecryptSecret(row.api_key_encrypted) ?? envKeyFor(...)`). Downstream, billing needs exactly
   * this distinction: a `tenant_byo` line is one the CUSTOMER already paid the provider for, so the
   * platform charges a percentage fee and no base cost, while a `platform_managed` line is resold at
   * cost plus markup. Emitting one as the other is a direct mis-bill in either direction.
   *
   *   tenant_byo       — the tenant's own decrypted `api_key_encrypted`.
   *   platform_managed — the platform's credential (the router token, `routerFallback`).
   *   none             — the stub; no vendor and no credential.
   *
   * ⭐ SINCE 0091 THIS IS NO LONGER DERIVED FROM WHETHER A KEY IS STORED. It is the ledger
   * projection of `tenant_llm_settings.credential_source`, which the tenant-admin PUT route
   * DECLARES. See `declaredCredentialSource` for the un-collapsed value and for why there are two.
   */
  credentialSource: CredentialSource;
  /**
   * The DECLARED state, verbatim from `tenant_llm_settings.credential_source` (migration 0091).
   * Undefined when there is no settings row to declare anything (`routerFallback`) or on the ad-hoc
   * connection-test path where the caller supplied none.
   *
   * ⛔ WHY TWO FIELDS RATHER THAN ONE WIDER UNION. `credentialSource` is consumed by
   * `host/metering-emit.ts`, whose wire contract is the three-valued
   * `'tenant_byo' | 'platform_managed' | 'none'` and whose ONLY question is `byo === true`
   * (`metering-emit.ts:246`). Widening that union would change a BILLING wire shape — and the two
   * new states, `trial_managed` and `local`, both answer "not BYO", so they would carry no new
   * information there while forcing every downstream `credential_source` reader on the ledger to
   * learn two values it cannot act on. The finer distinction is genuinely useful (a $0 in-cluster
   * call versus a platform-funded grant versus a resold vendor account), so it is carried HERE,
   * beside the coarse one, and is what a future cost-attribution change should read.
   */
  declaredCredentialSource?: DeclaredCredentialSource;
}

/** See `ResolvedChat.credentialSource`. The LEDGER axis — deliberately three-valued. */
export type CredentialSource = 'tenant_byo' | 'platform_managed' | 'none';

/**
 * The four values `tenant_llm_settings.credential_source` can hold (migration 0091) — the four
 * commercial states the product actually has. See that migration's header for the full argument.
 */
export type DeclaredCredentialSource =
  | 'tenant_byo'
  | 'platform_managed'
  | 'trial_managed'
  | 'local';

/**
 * The DECLARED state collapsed onto the ledger's three-valued axis.
 *
 * ⛔ THE ONLY PLACE THE COLLAPSE IS ALLOWED TO HAPPEN, and it is a `switch` on an exhaustive union
 * rather than `=== 'tenant_byo'` so that a FIFTH value added to the column cannot silently join the
 * `platform_managed` bucket: it fails `tsc` here instead, in front of the person adding it. That
 * distinction is not pedantic — the default arm of this function is the one that decides a customer
 * is NOT charged a BYO markup, and a new state landing in it by accident is a silent mis-bill.
 */
function ledgerCredentialSource(declared: DeclaredCredentialSource): CredentialSource {
  switch (declared) {
    case 'tenant_byo':
      return 'tenant_byo';
    case 'platform_managed':
    case 'trial_managed':
    case 'local':
      // All three are the PLATFORM's money. `trial_managed` is a platform-funded grant that lives
      // in the tenant's own `api_key_encrypted` (host/budget-service.ts) — the exact row shape the
      // old key-presence guess called `tenant_byo`.
      return 'platform_managed';
  }
}

/**
 * A tenant HAS a stored provider key that will not decrypt.
 *
 * ⛔ THIS EXISTS BECAUSE THE FALLBACK WAS SILENT AND THE PLATFORM PAID FOR IT. `tryDecryptSecret`
 * returns `null` for BOTH "no key configured" and "key present but undecryptable" — the exact
 * conflation `lib/license-status.ts` documents having fixed twice for the licence blob. On this path
 * the consequence is financial rather than cosmetic: a tenant who configured BYO, and whose blob
 * later became unreadable (a rotated `CP_SECRET_KEY`, a corrupt row), fell straight through to
 * `envKeyFor` and kept working — on the PLATFORM's credential, at the platform's expense, while the
 * cost event still described a tenant who brings their own key.
 *
 * So the two are separated here and the unreadable case REFUSES. A tenant who never configured a key
 * is unaffected and still uses the platform key: that is a real, supported state (trial, managed),
 * and refusing it would break every such tenant for no reason.
 */
export class TenantProviderKeyUnreadableError extends Error {
  constructor(readonly tenantId: string) {
    super(
      `tenant ${tenantId} has a stored LLM provider key that cannot be decrypted; refusing to fall ` +
        `back to the platform credential`,
    );
    this.name = 'TenantProviderKeyUnreadableError';
  }
}

/**
 * The ROUTER credential for a keyless call — the only credential CP itself ever supplies.
 *
 * ⛔ THERE IS NO ENV PROVIDER KEY ANY MORE (owner rule 2026-10-13: "commonpractice SIMPLY does NOT
 * CONTAIN any api tokens in its gitops files"). Routing used to hinge on `OPENAI_API_KEY` being the
 * placeholder `EMPTY`: unset, every keyless call dropped to the stub; set to a real key, the platform
 * paid a commercial vendor. Now the decision is the TARGET: a call whose (kind, base_url) is the
 * configured router (`OPENAI_BASE_URL`, `provider-catalog.ts isConfiguredRouterTarget`) goes to the
 * router with a router token, and anything else gets no credential at all (→ the stub).
 *   • a tenant's call carries the TENANT's own router licence token, or fails closed without one
 *     (`TenantInferenceNotProvisionedError`, 503 `llm_inference_not_provisioned`);
 *   • platform background work (`platformActor`) and a call with no tenant carry the PLATFORM's own
 *     router token (held by the system tenant, services/tenant-inference.ts `platformInferenceToken`).
 * No placeholder bearer is ever produced here, and `adapters/openai.ts` refuses one to the router.
 *
 * ⛔ The router is the PLATFORM's money, so the call is confined to `LOCAL_LLM_MODELS`
 * (`assertPlatformLocalOnly`) BEFORE any token is minted.
 */
async function platformKeyFor(
  tenantId: string | null,
  kind: ProviderKind,
  baseUrl: string | null,
  platformActor: boolean | undefined,
  model: string,
): Promise<string> {
  if (!isConfiguredRouterTarget(kind, baseUrl)) return '';
  assertPlatformLocalOnly({ tenantId, kind, baseUrl, model });
  return routerCredential(tenantId, platformActor === true);
}

/**
 * Combine the caller's abort signal with a hard wall-clock ceiling.
 *
 * Every adapter already threads `opts.signal` into its `fetch` — the gap was that FIVE of the six
 * call sites passed `new AbortController().signal`, a signal nobody ever fires. So no LLM call in
 * the app was bounded, and a hung provider endpoint would hang the caller indefinitely. On the
 * metering path that meant holding a DB transaction (and its `usage_counters … FOR UPDATE` row
 * lock) open forever; four of those exhaust the transaction pool and deadlock the process. On the
 * translation scheduler it meant holding a Postgres advisory lock forever, so NO pod could ever run
 * a translation tick again.
 *
 * Applying the ceiling HERE, at the one place adapters are constructed, is deliberate: it cannot be
 * forgotten by a future caller the way a per-call-site signal can.
 */
function withCallTimeout(inner: LlmProvider): LlmProvider {
  const bound = (opts: LlmProviderCallOpts): LlmProviderCallOpts => {
    const deadline = AbortSignal.timeout(config.llm.callTimeoutMs);
    // Honour BOTH: the caller's cancellation (run abort, client disconnect) and the ceiling.
    return { ...opts, signal: AbortSignal.any([opts.signal, deadline]) };
  };
  // A Proxy rather than a plain wrapper object, so the adapter's IDENTITY survives: callers and
  // tests can still assert `instanceof AnthropicProvider` / `OpenAiProvider` to check that a
  // tenant's stored config selected the right adapter. Adding a timeout should not change what the
  // thing IS.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        return (req: LlmRequest, opts: LlmProviderCallOpts) => target.chat(req, bound(opts));
      }
      if (prop === 'stream' && typeof target.stream === 'function') {
        return (req: LlmRequest, opts: LlmProviderCallOpts) => target.stream!(req, bound(opts));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function buildAdapter(
  kind: ProviderKind,
  apiKey: string,
  model: string,
  baseUrl: string | null | undefined,
  params: Record<string, unknown>,
): LlmProvider {
  // Route external provider calls through the governed egress gate; in-cluster targets
  // (the inference-router) pass straight through. Adapters fetch directly otherwise.
  const fetchImpl = governedLlmFetch();
  if (kind === 'anthropic') {
    return withCallTimeout(
      new AnthropicProvider({
        apiKey,
        model,
        baseUrl: baseUrl ?? undefined,
        params,
        fetchImpl,
      }),
    );
  }
  // openai + openai_compatible share the Chat-Completions adapter (DeepSeek etc.).
  return withCallTimeout(
    new OpenAiProvider({
      apiKey,
      model,
      baseUrl: baseUrl ?? undefined,
      params,
      fetchImpl,
    }),
  );
}

/**
 * No usable row (or the tenant's own key is switched off): the configured in-cluster router, else
 * the stub. ⛔ Never an env provider key — there is none (see `platformKeyFor`).
 */
async function routerFallback(args: ResolveChatArgs): Promise<ResolvedChat> {
  const baseUrl = config.llm.openaiBaseUrl;
  if (!baseUrl) {
    return { provider: stubProvider, model: args.model, providerKind: 'stub', credentialSource: 'none' };
  }
  const key = await platformKeyFor(args.tenantId, 'openai_compatible', baseUrl, args.platformActor, args.model);
  return {
    provider: buildAdapter('openai', key, args.model, baseUrl, {}),
    model: args.model,
    providerKind: 'openai',
    // OPENAI_BASE_URL IS the router, so this resolves to the `local` preset. ⚠ The `local` preset
    // carries NO price row since 2026-08-12, so the call is stamped `price_source='flat'` (see the
    // CORRECTION block in ai/llm/pricing.ts) — what `local` COSTS is decided there, not here.
    presetKey: presetKeyFor('openai', baseUrl),
    credentialSource: 'platform_managed',
  };
}

/** Build a chat provider from EXPLICIT, not-yet-saved settings — used by the "Test connection"
 *  button so it exercises the form the user is editing (not the stored row). The key is the
 *  freshly-typed one if given, else the tenant's already-stored key, else the env fallback. */
export interface AdHocChatArgs {
  kind: ProviderKind;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  storedKeyEncrypted?: string | null;
  params?: Record<string, unknown>;
  /**
   * The tenant row's DECLARED `credential_source`, when the caller has the row in hand.
   *
   * ⛔ THIS IS THE SECOND OF THE TWO GUESS SITES migration 0091 exists to remove. This function
   * used to answer `a.apiKey?.trim() || a.storedKeyEncrypted ? 'tenant_byo' : 'platform_managed'` —
   * the same key-presence inference as `resolveChatProvider`, one route over, and just as wrong for
   * a welcome-budget row whose stored key is the platform's. Nothing on THIS path is metered
   * (routes/llm-settings.ts's connection test and, since this change, its save-time probe), so the
   * value is not billed — but a probe that reports a different posture from the call it is probing
   * is a probe that cannot be trusted to represent it, which is the whole point of reusing one code
   * path for both.
   */
  credentialSource?: DeclaredCredentialSource;
  /** The tenant the test/save probe runs for: a router-bound probe carries ITS router token. */
  tenantId?: string | null;
}
export async function resolveAdHocChat(a: AdHocChatArgs): Promise<ResolvedChat> {
  const typed = (a.apiKey && a.apiKey.trim()) || '';
  const stored = typed ? null : tryDecryptSecret(a.storedKeyEncrypted ?? null);
  // ⛔ A STORED key the row does not declare as the tenant's own is a platform-held grant: local only.
  // (A freshly TYPED key is the operator's own, by construction.) The platform key is guarded inside
  // `platformKeyFor`.
  if (stored && a.credentialSource !== 'tenant_byo') {
    assertPlatformLocalOnly({ tenantId: a.tenantId, kind: a.kind, baseUrl: a.baseUrl, model: a.model });
  }
  const key =
    typed || stored || (await platformKeyFor(a.tenantId ?? null, a.kind, a.baseUrl ?? null, false, a.model));
  if (!key) {
    return { provider: stubProvider, model: a.model, providerKind: 'stub', credentialSource: 'none' };
  }
  // ⚠️ The CONNECTION-TEST / SAVE-PROBE path (routes/llm-settings.ts). Nothing here is metered, so
  // this value is never emitted — it is set to the truthful answer rather than left out, because
  // `credentialSource` is required precisely so a future metered caller cannot forget it.
  //
  // ⛔ THE FALLBACK WHEN THE CALLER DECLARES NOTHING IS **NOT** THE OLD KEY-PRESENCE GUESS. A
  // freshly-typed key in the form is the one case where "a key was supplied, therefore it is the
  // tenant's" is actually sound — the operator just typed it. The STORED-key half of that old
  // expression (`|| a.storedKeyEncrypted`) is the part that was wrong, and it is gone: a stored key
  // may be the platform's welcome-budget grant, which is what the row's declaration now says.
  const declared: DeclaredCredentialSource =
    a.credentialSource ?? (a.apiKey?.trim() ? 'tenant_byo' : 'platform_managed');
  return {
    provider: buildAdapter(a.kind, key, a.model, a.baseUrl ?? null, a.params ?? {}),
    model: a.model,
    providerKind: a.kind,
    presetKey: presetKeyFor(a.kind, a.baseUrl ?? null),
    credentialSource: ledgerCredentialSource(declared),
    declaredCredentialSource: declared,
  };
}

/**
 * Like `resolveChatProvider`, but returns null when the tenant has NO settings row of its own.
 *
 * The runner path (host/llm-broker.ts brokerLlmCall) needs this distinction. `resolveChatProvider`
 * falls back to an ENV-derived adapter, which is right for the agent chat but wrong for the runner:
 * the runner's historical provider is `chooseProvider()` (driven by `config.llm.mode`, so 'mock' in
 * dev/CI). Falling back to the env ADAPTER there would silently turn every mock-mode run into a
 * real network call. So the runner switches to the tenant's provider only when the tenant actually
 * configured one — e.g. after a welcome budget pointed it at OpenRouter — and otherwise keeps the
 * mode-driven provider unchanged.
 */
export async function resolveTenantChatProviderIfConfigured(
  args: ResolveChatArgs,
): Promise<ResolvedChat | null> {
  if (!args.tenantId) return null;
  const db = args.db ?? defaultDb;
  const [row] = await runAsSystem('tenant-parameterised', () =>
    db
      .select({
        key: tenantLlmSettings.api_key_encrypted,
        credentialSource: tenantLlmSettings.credential_source,
      })
      .from(tenantLlmSettings)
      .where(eq(tenantLlmSettings.tenant_id, args.tenantId!)),
  );
  // The presence of a ROW is not enough. Migration 0035 backfilled a settings row for EVERY tenant
  // (`local-llm`, no key), so a row-existence test would switch every tenant's flow runs onto that
  // row — silently overriding the model a block asked for, relabelling the ledger, and in a keyless
  // dev/CI environment dropping from `mockProvider` to the tool-call stub (whose empty text breaks
  // any block that parses the result). What the runner must key on is the tenant having its OWN
  // credentials — which is exactly what a welcome budget or a BYO key creates.
  if (!row?.key) return null;
  // ⛔ `platform_only`: the tenant's own key is switched off, so the runner keeps the mode-driven
  // (platform) provider — NOT `resolveChatProvider`'s env adapter, for the mock-mode reason above.
  const declared = effectiveDeclared(row.credentialSource);
  if (await ownKeyDisabled(args.tenantId, declared)) return null;
  const resolved = await resolveChatProvider(args);
  // Belt and braces: a stored key that fails to decrypt resolves to the stub. Never route real
  // flow runs through it — fall back to the mode-driven provider instead.
  return resolved.providerKind === 'stub' ? null : resolved;
}

/**
 * True when the row is the tenant's OWN key (`credential_source = 'tenant_byo'`, the declaration
 * migration 0091 made first-class) AND the tenant's posture is `platform_only`, which switches
 * bringing-your-own-key off. Such a row is IGNORED — never decrypted, never sent — and the call
 * takes the platform path instead, exactly as the agent workers do (see
 * services/byo-posture.ts `tenantOwnKeyAllowed`). A platform-funded row (`platform_managed`,
 * `trial_managed` — the welcome budget — or `local`) is the platform's own credential and is kept.
 */
async function ownKeyDisabled(tenantId: string, declared: DeclaredCredentialSource): Promise<boolean> {
  if (declared !== 'tenant_byo') return false;
  if (await tenantOwnKeyAllowed(tenantId)) return false;
  log.info('llm_byo_ignored_platform_only', { tenantId });
  return true;
}

/**
 * The row's declaration. Migration 0091 made it a column; 0098 relabelled the one prod row whose
 * stored key was the (now retired) welcome-budget grant as `trial_managed`. The welcome budget is
 * gone (0099), so nothing writes a grant key any more and nothing re-reads `tenant_llm_budgets` here.
 */
function effectiveDeclared(declared: DeclaredCredentialSource | null | undefined): DeclaredCredentialSource {
  return declared ?? 'platform_managed';
}

export async function resolveChatProvider(args: ResolveChatArgs): Promise<ResolvedChat> {
  const db = args.db ?? defaultDb;
  if (!args.tenantId) return routerFallback(args);
  // ⛔ OWNER RULING (2026-10-13): PLATFORM BACKGROUND WORK IS PLATFORM-PAID AND LOCAL-ONLY. Nobody in
  // the tenant asked for it (the translation drainer, on a schedule), so it must never be billed to
  // the tenant's OWN commercial key, nor refused with `TenantByoKeyRequiredError` because the
  // tenant's posture is `byo_required` — that posture governs what the TENANT spends, not the
  // platform. Skip the tenant row entirely and take the router; `platformKeyFor` still confines it
  // to the local router + LOCAL_LLM_MODELS (`assertPlatformLocalOnly`).
  if (args.platformActor) return routerFallback(args);

  // `tenant_llm_settings` is RLS-scoped, but provider selection is HOST config read that runs
  // from many caller contexts — the agent chat (withTenantDb), the runner's broker metering
  // (withTenantTx, where PLAIN statements get NO GUC), and schedulers. A plain read would be
  // invisible to RLS in those contexts → the per-tenant row would be silently ignored and every
  // tenant would fall back to the env provider. Read via runAsSystem (owner pool, bypasses RLS)
  // keyed by the EXPLICIT tenantId — exactly how license-gate reads the RLS-exempt tenants table.
  const [row] = await runAsSystem('tenant-parameterised', () =>
    db
      .select()
      .from(tenantLlmSettings)
      .where(eq(tenantLlmSettings.tenant_id, args.tenantId!)),
  );
  if (!row) {
    // No settings row → the router, i.e. the PLATFORM's credential. See services/byo-posture.ts.
    await assertPlatformCredentialAllowed(args.tenantId);
    return routerFallback(args);
  }

  // `platform_only` → the tenant's own key is off: take the platform path, as if no row existed.
  // (`assertPlatformCredentialAllowed` cannot refuse here: the posture is not `byo_required`.)
  const declared = effectiveDeclared(row.credential_source);
  if (await ownKeyDisabled(args.tenantId, declared)) return routerFallback(args);

  const kind = row.provider as ProviderKind;
  // A 'stub' sentinel model means "no real model pinned" → use the request model.
  const model = row.model && row.model !== 'stub' ? row.model : args.model;
  // ⛔ THE THREE CASES ARE SEPARATED HERE, AND THEY USED TO BE ONE LINE. `tryDecryptSecret` answers
  // `null` for "no key configured" AND for "key configured but unreadable", so the old
  // `tryDecryptSecret(...) ?? envKeyFor(...)` silently moved a BYO tenant onto the PLATFORM's
  // credential the moment their blob stopped decrypting. See `TenantProviderKeyUnreadableError`.
  const hasStoredKey = Boolean(row.api_key_encrypted);
  const tenantKey = tryDecryptSecret(row.api_key_encrypted);
  if (hasStoredKey && !tenantKey) throw new TenantProviderKeyUnreadableError(args.tenantId!);

  // The router credential is gated on the ROW's base_url, not just its kind — a keyless row pointing
  // at an arbitrary host must not collect a router token on the way out (see `platformKeyFor`).
  // ⛔ No key of the tenant's own → whatever follows is the PLATFORM's credential (the router, for
  // the keyless in-cluster local-llm row 0035 backfilled for every tenant). A `byo_required` tenant is
  // refused here rather than silently run at the platform's expense. See services/byo-posture.ts.
  //
  // ⛔ …AND A STORED KEY IS NOT AUTOMATICALLY THE TENANT'S. Since 0091 the row DECLARES whose it is:
  // `trial_managed` / `platform_managed` (the welcome budget's OpenRouter key, which
  // host/budget-service.ts writes into this same table) and `local` are the PLATFORM's credential.
  // Keying the refusal on key PRESENCE let a `byo_required` workspace spend a platform grant — the
  // opposite of the "never the platform's models, keys or welcome budget" the posture promises.
  if (!tenantKey || declared !== 'tenant_byo') {
    await assertPlatformCredentialAllowed(args.tenantId);
  }
  // ⛔ OWNER RULE: a stored key the row does NOT declare as the tenant's own (`trial_managed` /
  // `platform_managed` / `local` — a platform-held grant) is the platform's money, so it may reach
  // only the local router with a local model. There is no platform-paid commercial. (The keyless
  // case is guarded inside `platformKeyFor`.)
  if (tenantKey && declared !== 'tenant_byo') {
    assertPlatformLocalOnly({ tenantId: args.tenantId, kind, baseUrl: row.base_url, model });
  }
  const key =
    tenantKey ??
    (await platformKeyFor(args.tenantId, kind, row.base_url ?? null, args.platformActor, model));
  if (!key) {
    return { provider: stubProvider, model: args.model, providerKind: 'stub', credentialSource: 'none' };
  }

  // Temperature is a first-class tenant setting (tenant_llm_settings.temperature). Both adapters
  // honor body.temperature via the spread `params`, so merge it in (an explicit row.params value
  // wins if a tenant set one). The request itself carries no temperature on these paths.
  const params: Record<string, unknown> =
    row.temperature != null
      ? { temperature: row.temperature, ...row.params }
      : (row.params ?? {});

  // ⭐ THE COLUMN, NOT THE CIPHERTEXT. This line used to read
  // `credentialSource: tenantKey ? 'tenant_byo' : 'platform_managed'` — key PRESENCE standing in for
  // whose MONEY it is, which `host/metering-emit.ts:246` then turned into the billing `byo` flag.
  // `host/budget-service.ts` writes the PLATFORM's own welcome-budget key into this same row, so
  // that entire cohort was billed a BYO markup on platform-funded spend. The declaration is now a
  // first-class column (migration 0091) and this reads it.
  //
  // ⚠️ THE `?? 'platform_managed'` IS A TYPE-LEVEL BELT, NOT A BEHAVIOURAL FALLBACK. 0091 makes the
  // column `NOT NULL DEFAULT 'platform_managed'`, so no row can reach here without a value; the
  // coalesce exists only for the window where a pod running this code meets a database the
  // migration has not reached yet (a rolling deploy), and it answers with the conservative value
  // rather than the guess. ⛔ Do NOT "improve" it back into `tenantKey ? …` — that is the defect.
  // (`declared` above: the column, corrected by `effectiveDeclared` for a grant key labelled own.)

  return {
    provider: buildAdapter(kind, key, model, row.base_url, params),
    model,
    providerKind: kind,
    // The tenant's stored base_url is exactly what presetKeyFor was written to resolve — this is
    // where a tenant's OpenRouter / DeepSeek / local row becomes a priceable vendor identity.
    presetKey: presetKeyFor(kind, row.base_url),
    credentialSource: ledgerCredentialSource(declared),
    declaredCredentialSource: declared,
  };
}
