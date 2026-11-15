// src/services/byo-posture.ts — "may this tenant's LLM calls run on the PLATFORM's credential?"
//
// ⛔ WHY THIS EXISTS. A tenant whose central posture is `byo_required` pays the provider directly and
// is invoiced only a markup on that spend. Every provider-selection path used to fall back to a
// platform credential when the tenant had no key of its own — the env key (`envKeyFor`), the env
// adapter (`envFallback`), or the runner's mode-driven provider (in prod: the in-cluster
// inference-router). For a `byo_required` tenant each of those is the platform silently paying for
// spend that is then billed as if the customer had paid it. The decision is a HARD REFUSE, never a
// fallback.
//
// The posture lives in the licences service (`tenants.byo_mode`, per-app override), not in CP.
//
// Semantics of an UNKNOWN posture, chosen deliberately:
//   • issuance disabled (dev/CI, no licences service) → not enforced; CP cannot know a posture it
//     has no service to ask, and those environments run on mock/local providers.
//   • read fails, last known value exists → keep using it (stale beats fabricated).
//   • read fails, nothing known → FAIL CLOSED (treat as byo_required). A licences outage may then
//     refuse a keyless tenant's call; the alternative is the platform paying on every outage.
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { BYO_PLAN } from './plan-posture';
import { log } from '../host/logger';
import { HttpError } from '../utils/http';
import { licensesAdmin, LicensesAdminService, type ByoMode } from './licenses-admin';
import { isPlatformLocalTarget, type LlmProviderKind } from '../ai/llm/provider-catalog';

const TTL_MS = 60_000;

type Resolver = (tenantId: string) => Promise<ByoMode>;

const cache = new Map<string, { mode: ByoMode; fetchedAt: number }>();
let _resolver: Resolver | undefined;
let _now: () => number = Date.now;

function resolver(): Resolver {
  if (_resolver) return _resolver;
  const client = licensesAdmin();
  if (!(client instanceof LicensesAdminService)) {
    // A test fake without a posture read: nothing to enforce against.
    return async () => 'local_allowed';
  }
  return (tenantId) => client.getTenantByoMode(tenantId);
}

/**
 * The wire code for the refusal below.
 *
 * ⛔ IT HAD NONE, AND THAT IS WHY THE READER SAW NOTHING USEFUL. `TenantByoKeyRequiredError` was a
 * plain `Error`, so `utils/http.ts route()` could not recognise it: it fell through to the bare 500
 * arm, which emits no `code` field at all. `frontend/src/lib/api/error-message.ts` keys EVERY
 * localized refusal on that code, and `licenseOrPermissionMessage` returns `null` for a 500 — so a
 * `byo_required` tenant with no key met their own screen's generic fallback ("Kon niet laden") in
 * all eight locales, with no mention of the one gesture that repairs it: add a provider key on the
 * LLM settings screen. The tenant_admin who can do that is very often the person looking at it.
 *
 * ⚠️ 403 AND NOT 402, DELIBERATELY. 402 is Gate 2 — the WORKSPACE's Common Practice entitlement —
 * and `stores/licenseGate.svelte.ts` raises a whole-app renewal wall for the codes in
 * `LICENSE_BLOCK_CODES`. This workspace's licence is fine; it is a per-tenant SPEND POSTURE that is
 * unsatisfied. Routing it to 402 would take a paying workspace offline over a missing API key, the
 * same failure the `fr_license_*` family is kept out of `LICENSE_BLOCK_CODES` to avoid.
 *
 * ⚠️ `llm_` PREFIXED so it cannot be mistaken for the licence-seat family. `license_seat_required`
 * is about a PERSON's seat; this is about a WORKSPACE's credential.
 */
export const TENANT_BYO_KEY_REQUIRED_CODE = 'llm_byo_key_required';

/**
 * Thrown when a `byo_required` tenant would otherwise run on a platform credential.
 *
 * ⚠️ AN `HttpError` SUBCLASS SINCE THE CODE EXISTED — the class identity is unchanged, so the
 * `rejects.toBeInstanceOf(TenantByoKeyRequiredError)` assertions in `llm-select.test.ts` and
 * `llm-broker.test.ts` still say exactly what they said. What changes is what escapes to a client:
 * a 403 carrying `llm_byo_key_required` instead of an unlabelled 500. `host/run-controller.ts:1285`
 * also starts counting and AUDITING it as a run rejection (`run.rejected`) rather than logging a
 * server fault, which is what it always was.
 *
 * ⚠️ THE TENANT ID IS IN `details`, NOT INTERPOLATED INTO THE LOCALIZED SENTENCE. The SPA copy is
 * keyed on the code alone (`FORBIDDEN_MESSAGES`); the id is for the operator reading the audit row.
 */
export class TenantByoKeyRequiredError extends HttpError {
  constructor(readonly tenantId: string) {
    // ⛔ THE CODE IS SPELLED OUT AS A LITERAL HERE AND **NOT** PASSED AS
    // `TENANT_BYO_KEY_REQUIRED_CODE`, WHICH IS THE OPPOSITE OF THE USUAL ADVICE — AND THAT IS
    // DELIBERATE. `frontend/src/lib/api/error-message.backend-contract.test.ts` derives the set of
    // 403 codes the backend can emit by reading BACKEND SOURCE TEXT (the two projects share no
    // types; see that file's header for why). It resolves a QUOTED LITERAL in the code slot and
    // records anything else as unresolved — its `literalOrUnresolved` note records measuring
    // exactly this: extracting a code to a `const` silently switched the guard off and three
    // uncatalogued author-facing codes shipped with every assertion green. A bare identifier here
    // would leave `llm_byo_key_required` invisible to the scrape, so the SPA could lose its copy in
    // all eight locales with nothing going red.
    //
    // ⚠️ THE CONSTANT ABOVE IS STILL THE THING CALLERS COMPARE AGAINST, and the two are pinned
    // equal by `tests/llm-select.test.ts` ("the wire code is a LITERAL the SPA scrape can read"),
    // so this duplication cannot rot into two different strings in silence.
    super(
      403,
      'llm_byo_key_required',
      `tenant ${tenantId} is byo_required but has no LLM provider key of its own; refusing to fall ` +
        `back to the platform credential — configure a provider key in LLM settings`,
      { tenantId },
    );
    this.name = 'TenantByoKeyRequiredError';
  }
}

/**
 * Thrown when a call that is NOT paid with the tenant's own key would reach anything other than the
 * in-cluster router serving a local model.
 *
 * ⛔ OWNER RULE (2026-10-13): commercial models are only ever called with the TENANT'S OWN key
 * (`credential_source = 'tenant_byo'` + a stored key that decrypts). The platform never pays for, and
 * never serves, a commercial model. Every other credential — the env keys (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`), `LLM_MODE=anthropic`, the platform's or the tenant's inference-router token, and
 * a platform-held grant key stored in a `trial_managed` / `platform_managed` row — is confined to
 * `ai/llm/provider-catalog.ts isPlatformLocalTarget` (the router + `LOCAL_LLM_MODELS`).
 *
 * ⚠️ WHY THIS IS NOT LEFT TO THE ROUTER. inference-router's `default_chain` still lists a paid
 * provider; it is safe today only because those providers are disabled in the ROUTER's config. One
 * config change there would put platform money behind every keyless tenant row naming a commercial
 * model. CP refuses before the request is built.
 *
 * 403 for the same reason as `llm_byo_key_required` (a spend posture, not the workspace licence).
 * A QUOTED LITERAL in the code slot so the SPA's backend-contract scrape can see it.
 */
export class PlatformLocalOnlyError extends HttpError {
  constructor(
    readonly tenantId: string | null,
    readonly model: string,
  ) {
    super(
      403,
      'llm_platform_local_only',
      'Commercial models need your own API key. Add it in LLM settings.',
      { tenantId, model },
    );
    this.name = 'PlatformLocalOnlyError';
  }
}
export const PLATFORM_LOCAL_ONLY_CODE = 'llm_platform_local_only';

/**
 * The ONE enforcement point for the owner rule above. Callers invoke it whenever the credential is
 * not the tenant's own key; it throws `PlatformLocalOnlyError` unless the call targets the in-cluster
 * router with a local model.
 */
export function assertPlatformLocalOnly(target: {
  tenantId: string | null | undefined;
  kind: LlmProviderKind;
  baseUrl: string | null | undefined;
  model: string;
}): void {
  if (isPlatformLocalTarget(target.kind, target.baseUrl ?? null, target.model)) return;
  log.warn('llm_platform_local_only_refused', {
    tenantId: target.tenantId ?? null,
    kind: target.kind,
    model: target.model,
  });
  throw new PlatformLocalOnlyError(target.tenantId ?? null, target.model);
}

export async function tenantByoMode(tenantId: string): Promise<ByoMode | null> {
  if (!config.license.issuanceEnabled) return null;
  const hit = cache.get(tenantId);
  if (hit && _now() - hit.fetchedAt < TTL_MS) return hit.mode;
  try {
    const mode = await resolver()(tenantId);
    cache.set(tenantId, { mode, fetchedAt: _now() });
    return mode;
  } catch (err) {
    const fallback: ByoMode = hit?.mode ?? 'byo_required';
    log.warn('byo_posture_unresolved', {
      tenantId,
      using: fallback,
      basis: hit ? 'last_known' : 'fail_closed',
      err,
    });
    return fallback;
  }
}

/** Throws `TenantByoKeyRequiredError` when the tenant may not use a platform credential. */
export async function assertPlatformCredentialAllowed(tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) return;
  // ⛔ THE PLAN FIRST, AND FROM CP'S OWN ROW. A `byo` tenant has NO platform path, whatever the
  // licences posture read says — that read is skipped with issuance off and is cached for a minute,
  // and a stale or missing `byo_required` must never let a byo workspace run on the platform's money.
  if (await onByoPlan(tenantId)) throw new TenantByoKeyRequiredError(tenantId);
  if ((await tenantByoMode(tenantId)) === 'byo_required') {
    throw new TenantByoKeyRequiredError(tenantId);
  }
}

async function onByoPlan(tenantId: string): Promise<boolean> {
  const [row] = await db.select({ plan: tenants.plan_code }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.plan === BYO_PLAN;
}

/**
 * May this tenant's OWN provider key (a `tenant_byo` row in `tenant_llm_settings`) be used at all?
 *
 * ⛔ `platform_only` (demo / trial) LOCKS the tenant to platform inference: bringing your own key is
 * switched OFF. The agent workers already enforce this (worker_management
 * `factory/llm_config_resolver.py`: "platform_only: BYO (external) is disabled BY POLICY, not
 * broken" — the stored row is ignored and the worker stays on platform routing). CP used to check
 * only `byo_required`, so inside CP a `platform_only` tenant's saved key was still decrypted and
 * sent — `platform_only` behaved exactly like `local_allowed`.
 *
 * Unknown posture (issuance off → `null`, or a failed read that fails closed to `byo_required`)
 * answers TRUE: refusing a tenant's own key never protects the platform's money, so there is no
 * reason to fail that direction closed.
 */
export async function tenantOwnKeyAllowed(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return true;
  return (await tenantByoMode(tenantId)) !== 'platform_only';
}

/**
 * The wire code a `platform_only` tenant gets when it tries to SAVE a key of its own
 * (routes/llm-settings.ts PUT). 403, not 402, for the same reason as `llm_byo_key_required`: the
 * workspace's licence is fine; its spend posture forbids the gesture.
 */
export class TenantByoDisabledError extends HttpError {
  constructor(readonly tenantId: string) {
    // ⛔ A QUOTED LITERAL in the code slot, deliberately — see `TenantByoKeyRequiredError` above:
    // the SPA's backend-contract scrape can only see a literal.
    super(
      403,
      'llm_byo_disabled',
      `tenant ${tenantId} is platform_only: bringing your own LLM provider key is switched off for ` +
        `this workspace, so the key was not saved`,
      { tenantId },
    );
    this.name = 'TenantByoDisabledError';
  }
}

export function __setByoPostureForTests(opts: { resolver?: Resolver; now?: () => number } | undefined): void {
  _resolver = opts?.resolver;
  _now = opts?.now ?? Date.now;
  cache.clear();
}
