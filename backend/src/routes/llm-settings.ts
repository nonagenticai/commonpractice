// src/routes/llm-settings.ts — per-user/tenant LLM provider settings + BYO key
// (SPEC §5A Layer 1, Session 7). A platform user picks their provider/model and
// (optionally) supplies their own provider key; the key is AES-256-GCM encrypted
// (host/secret-box.ts) into tenant_llm_settings.api_key_encrypted and NEVER returned.
// The broker decrypts it host-side at call time (ai/llm/select.ts).
//
// Settings are keyed by the caller's ACTIVE tenant (Phase 2-D) and gated on
// tenant_admin; a personal tenant (id = user.id) backfilled in 0014 keeps every
// pre-2-D per-user row valid unchanged.
//   GET /api/llm-settings — the current config, masked (hasKey boolean, never the key)
//   PUT /api/llm-settings — upsert provider/model/base_url/params (+ optional apiKey)
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, tenantLlmSettings } from '../db/client';
import { requireTenantAdmin } from '../middleware/admin-guards';
import { encryptSecret } from '../host/secret-box';
import {
  providerCatalog,
  presetKeyFor,
  findPreset,
  adapterIdentityFor,
  type LlmProviderKind,
} from '../ai/llm/provider-catalog';
import { resolveChatProvider, resolveAdHocChat } from '../ai/llm/select';
import { tenantByoMode, tenantOwnKeyAllowed, TenantByoDisabledError } from '../services/byo-posture';
// The BROKER's own limits accessor, deliberately — so the save-time check and the call-time
// enforcement read the identical snapshot and can never disagree about what is allowlisted.
import { getGovernanceLimits } from '../host/llm-broker';
import { config } from '../config';
import { jsonResponse, readJson, readJsonOptional, route, badRequest } from '../utils/http';
import type { Router } from '../utils/router';

const putSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'openai_compatible']),
    model: z.string().min(1).max(200),
    baseUrl: z.string().url().max(500).optional(),
    // Sampling temperature 0–2 (clamped to the provider-sane range). null clears it.
    temperature: z.number().min(0).max(2).nullable().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    // Optional on update: omit to keep the existing stored key untouched.
    apiKey: z.string().min(1).max(500).optional(),
  })
  .strict();

// The Test button posts the same shape as a save so it can exercise unsaved edits.
const testFormSchema = putSchema;

// ── the key probe: ONE code path, used by BOTH /test and the save ────────────────────────────────
//
// ⛔ THE SAVE NEVER CHECKED THE KEY, AND THE ONLY THING THAT DID WAS A BUTTON NOBODY HAS TO PRESS.
// `putSettings` encrypted whatever 1–500 characters arrived and wrote them to
// `tenant_llm_settings.api_key_encrypted`; the sole verification in this file lived in
// `POST /api/llm-settings/test`, which is a separate, OPTIONAL gesture. A typo'd or revoked token
// therefore persisted with a 200 OK and `hasKey: true`, and the failure surfaced later, somewhere
// else entirely — inside a flow run or an agent turn, as a provider 401 wrapped in
// `llm_test_failed`-shaped prose the author cannot connect to the save they made an hour earlier.
//
// ⚠️ IT IS THE SAME FUNCTION, NOT THE SAME SHAPE. A second "do a 1-token ping" implementation next
// to the first would be two things to keep in step — and they would drift on exactly the details
// that matter here (which key is lent to which vendor, the 15 s ceiling, whether the stub counts as
// a pass). `resolveAdHocChat` is what makes that possible: it already takes the UNSAVED form.
//
// ⚠️ THE PROBE IS ONLY RUN FOR A **NEW** KEY. Editing a model, a temperature or a base_url does not
// store a credential, and probing on every save would put a live outbound request (and a 15 s
// worst case) in front of an edit that cannot break the key — and would fail a save for a provider
// outage that has nothing to do with what the admin changed. The literal defect is "a key is stored
// without ever being checked"; that is what this closes.
export interface LlmKeyProbeInput {
  kind: LlmProviderKind;
  model: string;
  baseUrl: string | null;
  /** The freshly-typed key, if any. NEVER logged, never returned, never echoed in an error. */
  apiKey: string | null;
  storedKeyEncrypted: string | null;
  params: Record<string, unknown>;
  credentialSource?: 'tenant_byo' | 'platform_managed' | 'trial_managed' | 'local';
  /** The tenant probed for — a router-bound probe carries its router token, never `EMPTY`. */
  tenantId?: string | null;
}

export type LlmKeyProbeResult =
  | { ok: true; providerKind: string; model: string }
  | { ok: false; code: 'llm_test_no_api_key' | 'llm_test_failed'; detail: string };

/**
 * Strip a secret out of a provider's own error text.
 *
 * ⛔ NOT PARANOIA — THE PROBE'S FAILURE TEXT IS THE ONE PLACE A JUST-TYPED KEY CAN ESCAPE. The
 * detail this function guards is `e.message` from an arbitrary vendor adapter, and adapters build
 * that message from the HTTP response BODY. Providers do echo the offending credential: an OpenAI
 * 401 body has historically carried `Incorrect API key provided: sk-abc***`, and an
 * openai-compatible gateway may return the whole `Authorization` header in a debug payload. That
 * string is then returned to the browser AND written to the pod log by `route()`. A save-time probe
 * is exactly where this bites, because the key is the thing the reader just typed and the thing
 * they are least expecting to see quoted back at them.
 *
 * ⚠️ THE PREFIX HALF IS NOT OPTIONAL. A body that truncates the key (`sk-abc…`, `sk-abc***`) does
 * not contain the full literal, so a plain `replaceAll(key, …)` misses it entirely — which is the
 * shape the real OpenAI 401 uses. Anything from 8 characters up is redacted as well, which is long
 * enough not to shred ordinary prose and short enough to catch the usual elision points.
 */
function redactKey(detail: string, key: string | null | undefined): string {
  const k = key?.trim();
  if (!k) return detail;
  let out = detail.split(k).join('«redacted»');
  for (let n = k.length - 1; n >= 8; n--) {
    const prefix = k.slice(0, n);
    if (out.includes(prefix)) out = out.split(prefix).join('«redacted»');
  }
  return out;
}

let _pingOverride:
  | ((input: LlmKeyProbeInput, resolved: { providerKind: string; model: string }) => Promise<void>)
  | undefined;

/**
 * Test seam for the probe's NETWORK HOP, and ONLY that hop.
 *
 * ⛔ REQUIRED, BECAUSE THE SAVE NOW MAKES AN OUTBOUND REQUEST. Every existing assertion in
 * `tests/llm-settings.test.ts` about encryption-at-rest, vendor switching and temperature
 * persistence PUTs a fabricated key (`sk-ant-SECRET-xyz`). Without this seam each of them would
 * either reach a real vendor from CI or be refused by the egress gate — so the whole file would go
 * red for a reason that has nothing to do with what it asserts, and the pressure would be to weaken
 * the probe rather than to stub it.
 *
 * ⛔ IT DELIBERATELY DOES **NOT** REPLACE THE WHOLE PROBE, AND THE FIRST VERSION OF IT DID — which
 * would have made `POST /test`'s stub arm unreachable and quietly broken the "does not lend the
 * stored key to a DIFFERENT vendor either" test, whose entire assertion is that resolution lands on
 * the stub because no key exists for the new vendor. Everything that DECIDES — which key is lent to
 * which vendor, whether the stub counts as a failure, the 15 s ceiling, what a failure does to the
 * save — stays real. Only the one thing a test cannot run, the request itself, is replaceable.
 * Throw from the override to simulate a provider refusal.
 */
export function __setLlmKeyProbeForTests(
  fn:
    | ((input: LlmKeyProbeInput, resolved: { providerKind: string; model: string }) => Promise<void>)
    | undefined,
): void {
  _pingOverride = fn;
}

/** Resolve the adapter the save/test would use and ask it for one token. */
async function probeLlmKey(input: LlmKeyProbeInput): Promise<LlmKeyProbeResult> {
  const adhoc = await resolveAdHocChat({
    tenantId: input.tenantId,
    kind: input.kind,
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    storedKeyEncrypted: input.storedKeyEncrypted,
    params: input.params,
    credentialSource: input.credentialSource,
  });
  // ⚠️ THE STUB IS A FAILURE HERE, NOT A PASS. `resolveAdHocChat` answers with the deterministic
  // stub when no usable key resolves at all; a probe that treated that as success would report
  // "your key works" for a config that reaches no provider.
  if (adhoc.providerKind === 'stub') {
    return {
      ok: false,
      code: 'llm_test_no_api_key',
      detail: 'No API key for this provider — add one (or save) to test.',
    };
  }
  const resolved = { providerKind: adhoc.providerKind, model: adhoc.model };
  try {
    if (_pingOverride) await _pingOverride(input, resolved);
    else
      await adhoc.provider.chat(
        { model: adhoc.model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
        { signal: AbortSignal.timeout(15_000) },
      );
    return { ok: true, ...resolved };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'llm_test_failed', detail: redactKey(raw, input.apiKey) };
  }
}

const getSettings = route(async (req) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const [row] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenantId))
    .limit(1);
  // The workspace's LLM-access posture (licences `byo_mode`), so the screen can switch the key
  // field off for `platform_only` and say why. `null` = unknown (no licences service in dev/CI).
  const byoMode = await tenantByoMode(tenantId);
  if (!row) return jsonResponse({ configured: false, byoMode });
  return jsonResponse({
    configured: true,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    // The preset the UI should preselect (resolved from provider + base_url).
    preset: presetKeyFor(row.provider, row.base_url),
    temperature: row.temperature,
    params: row.params,
    hasKey: row.api_key_encrypted != null && row.api_key_encrypted.length > 0,
    byoMode,
  });
});

// GET /api/llm-settings/catalog — the curated provider/model presets that drive the dropdowns
// (single source of truth, also used server-side to validate a save). No secrets.
const getCatalog = route(async (req) => {
  await requireTenantAdmin(req);
  return jsonResponse({ providers: providerCatalog() });
});

const putSettings = route(async (req) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);
  const body = putSchema.parse(await readJson(req));
  const now = new Date();
  // ⛔ `platform_only` switches bringing-your-own-key OFF (ai/llm/select.ts ignores such a key at
  // call time). Refuse to store one rather than accept a key that will never be used. Checked
  // before the probe, so a refused key is never even sent to its vendor.
  if (body.apiKey && !(await tenantOwnKeyAllowed(tenantId))) throw new TenantByoDisabledError(tenantId);

  // Validate against the catalog so the UI and stored state stay coherent. Resolve which preset
  // the (provider, base_url) pair names; a non-custom preset pins its model list + key requirement.
  const presetKey = presetKeyFor(body.provider, body.baseUrl ?? null);
  const preset = findPreset(presetKey)!;
  if (!preset.custom && !preset.models.includes(body.model)) {
    throw badRequest(
      'invalid_model',
      `Model '${body.model}' is not offered by provider '${preset.label}'.`,
      // The two machine fields the localized sentence needs. `preset.label` (not `body.provider`)
      // because it is the name the reader picked in the dropdown.
      { model: body.model, provider: preset.label },
    );
  }
  // ...and against the GOVERNANCE ALLOWLIST, which is a second, independent gate.
  //
  // ⛔ Passing the catalog check was never enough to make a model usable. `llm-broker.ts`'s
  // `reserveCall` refuses any model absent from `models.allowlist` with `model_not_allowed` — so
  // without this check a tenant admin could pick a model the dropdown offers, save it successfully,
  // and then have EVERY LLM call fail forever, with the error surfacing at call time (inside a flow
  // run or the agent chat) rather than at the moment they could actually act on it.
  //
  // That was not hypothetical. `models.allowlist` is seeded ONCE from the catalog
  // (`seed-platform.ts` `CATALOG_MODELS`, `ON CONFLICT DO NOTHING`) and never reconciled, so it
  // freezes at whatever the catalog held on first seed while the catalog keeps evolving. In live
  // prod that had drifted to 7 allowlisted ids against 21 in the catalog: every OpenAI, DeepSeek,
  // xAI and Cohere model — four entire providers — was selectable and then refused, and the one
  // allowlisted Anthropic Opus id (`claude-opus-4-7`) no longer existed in any catalog.
  //
  // Semantics MIRROR the broker exactly (absent/empty list = no restriction), because a check that
  // disagrees with the enforcer is worse than no check: it would refuse saves the broker allows.
  const { allowlistedModels } = await getGovernanceLimits();
  if (allowlistedModels && allowlistedModels.length > 0 && !allowlistedModels.includes(body.model)) {
    throw badRequest(
      'model_not_allowlisted',
      `Model '${body.model}' is not on this platform's allowlist, so the broker would refuse every ` +
        `call. Ask a platform administrator to allowlist it on the Governance screen, or pick an ` +
        `allowlisted model.`,
      { model: body.model },
    );
  }
  // Read the existing row once: a key requirement is satisfied by a NEW key OR an already-stored one.
  const [existing] = await db
    .select({
      enc: tenantLlmSettings.api_key_encrypted,
      provider: tenantLlmSettings.provider,
      baseUrl: tenantLlmSettings.base_url,
    })
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenantId))
    .limit(1);
  // ⛔ …BUT ONLY FOR THE VENDOR THE KEY WAS ISSUED TO. `base` below overwrites provider/base_url/
  // model unconditionally while the key patch used to be `body.apiKey ? {…} : {}` — so a PUT that
  // changed only the VENDOR left the previous vendor's ciphertext in the row, and `hadKey` (read
  // from that same ciphertext) then satisfied the NEW preset's key requirement on its behalf.
  // Nothing downstream could catch it: keys carry no vendor tag, and `ai/llm/select.ts
  // resolveChatProvider` simply decrypts `row.api_key_encrypted` and hands it to whichever adapter
  // the new row selects. Measured live: an `sk-…` OpenAI key was carried onto `anthropic` and then
  // onto `https://api.x.ai/v1`, i.e. offered to two other companies as `x-api-key` and as
  // `Authorization: Bearer`. The egress allowlist does not stop it — it is seeded with every
  // catalog vendor host, and the `custom` preset accepts an arbitrary URL besides.
  //
  // So a vendor change DISOWNS the stored key. The `requiresKey` check below then refuses the save
  // for a key-requiring vendor (the tenant is told to supply that vendor's own token), and a
  // keyless vendor persists with the ciphertext cleared rather than inherited.
  const vendorChanged =
    existing != null &&
    adapterIdentityFor(existing.provider as LlmProviderKind, existing.baseUrl) !==
      adapterIdentityFor(body.provider, body.baseUrl ?? null);
  const hadKey = !vendorChanged && existing?.enc != null && existing.enc.length > 0;
  if (preset.requiresKey && !body.apiKey && !hadKey) {
    throw badRequest(
      'api_key_required',
      vendorChanged
        ? `Provider '${preset.label}' requires its OWN API token — the key stored for the previous ` +
            `provider is not valid for it and is never sent to a different vendor.`
        : `Provider '${preset.label}' requires an API token.`,
      // ⛔ TWO SENTENCES, ONE CODE — so `reason` is what the browser switches on. Renaming the code
      // instead would break `tenant-llm-settings.test.ts` and the SPA's existing catalog key; a
      // reason is additive. See utils/http.ts's ⛔ block on `details` as the localization seam.
      { provider: preset.label, reason: vendorChanged ? 'vendor_changed' : 'missing' },
    );
  }

  // ⛔ PROBE BEFORE PERSIST — the whole point is that the refusal happens while the admin is still
  // looking at the form they typed the key into. Placed AFTER the catalog/allowlist/vendor gates so
  // a save that is going to be refused on a cheap, local rule never makes an outbound request, and
  // BEFORE the insert so a bad key leaves no ciphertext behind at all. See the probe's own header.
  if (body.apiKey) {
    const params: Record<string, unknown> =
      body.temperature != null
        ? { temperature: body.temperature, ...(body.params ?? {}) }
        : (body.params ?? {});
    const probe = await probeLlmKey({
      tenantId,
      kind: body.provider,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      apiKey: body.apiKey,
      // ⚠️ The stored key is NOT lent to this probe. A new key is being supplied, so it is the only
      // thing under test; passing the old ciphertext would let a save whose new key is broken pass
      // on the strength of the key it is about to replace.
      storedKeyEncrypted: null,
      params,
      // The declaration this save is about to write (see `credentialSourcePatch` below), so the
      // probe resolves under the same posture as the calls it is standing in for.
      credentialSource: 'tenant_byo',
    });
    if (!probe.ok) {
      throw badRequest(
        'llm_key_probe_failed',
        `The key was not accepted by '${preset.label}', so it was NOT saved: ${probe.detail}`,
        // ⚠️ `detail` IS THE PROVIDER'S OWN TEXT, KEY-REDACTED (see `redactKey`) — a rate-limit
        // notice, a TLS failure, an HTTP body. No catalog can hold it and it is the most useful
        // thing on the screen, so it rides in `details` for the SPA exactly as `llm_test_failed`'s
        // does, rather than being flattened into a generic sentence.
        //
        // ⛔ ALL THREE FIELDS ARE LOAD-BEARING FOR THE SPA, NOT DEBUG PADDING. `error-message.ts`'s
        // `llm_key_probe_failed` entry rebuilds the sentence from `provider` + `detail` and returns
        // `null` when either is absent — which is the mid-roll guard, not a gap: an old pod ships
        // the code with no `details` and the reader lands on the English sentence above, which
        // still names the vendor and quotes the provider. Dropping either field here silently
        // un-localizes the refusal in all eight locales with nothing going red.
        //
        // ⚠️ I LEARNED THIS BY RUNNING THE GUARD, NOT BY READING IT. This block first shipped with
        // a comment asserting the code "has no entry in the SPA map, and that is the documented
        // fall-through" — reasoning from the 400/422/409 scrape being seeded at
        // `POST /api/solutions`. It is not: `error-message.backend-contract.test.ts`'s whole-tree
        // half walks ALL of `backend/src` and reds unless every 400/409/422 code has a home. A
        // plausible-sounding argument for why a new code needs no copy is exactly the shape that
        // guard exists to refuse; check it against the test before believing it.
        { reason: probe.code, provider: preset.label, detail: probe.detail },
      );
    }
  }

  // ⭐ THE DECLARATION (migration 0091), which is the whole reason `credential_source` exists: this
  // route is the ONE place a human says whose credential is paying, so it is the one place that may
  // write it. A new key typed by a tenant_admin is BYO by definition. A vendor switch to a keyless
  // preset clears the ciphertext, so the platform pays from that moment — and `local` is said
  // explicitly when the target is the in-cluster inference-router, because "platform_managed" and
  // "no vendor credential at all" price differently.
  //
  // ⚠️ AN UPDATE THAT TOUCHES NEITHER WRITES NOTHING, deliberately — `{}` spreads to nothing in the
  // `set` below. Editing a model or a temperature must not silently re-declare who is paying, and a
  // row that was declared `trial_managed` by an operator must survive an ordinary edit.
  //
  // (The retired welcome budget used to write this table too; 0098 relabelled its grant key
  // `trial_managed`, and since 0099 nothing but this route writes it.)
  const credentialSourcePatch: { credential_source?: 'tenant_byo' | 'platform_managed' | 'local' } =
    body.apiKey
      ? { credential_source: 'tenant_byo' }
      : vendorChanged
        ? { credential_source: presetKey === 'local' ? 'local' : 'platform_managed' }
        : {};

  const base = {
    provider: body.provider,
    model: body.model,
    base_url: body.baseUrl ?? null,
    temperature: body.temperature ?? null,
    params: body.params ?? {},
    updated_at: now,
  } as const;
  // Only touch the encrypted key when a new one is supplied (so editing the model or the
  // temperature doesn't wipe the stored key) — UNLESS the vendor changed, in which case the old
  // ciphertext is dropped rather than carried onto the new one. That arm is reachable only for a
  // preset that needs no key; a key-requiring one has already been refused above. The plaintext key
  // never leaves this function.
  const keyPatch = body.apiKey
    ? { api_key_encrypted: encryptSecret(body.apiKey) }
    : vendorChanged
      ? { api_key_encrypted: null }
      : {};

  await db
    .insert(tenantLlmSettings)
    .values({ tenant_id: tenantId, ...base, ...keyPatch, ...credentialSourcePatch })
    .onConflictDoUpdate({
      target: tenantLlmSettings.tenant_id,
      set: { ...base, ...keyPatch, ...credentialSourcePatch },
    });

  const [row] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenantId))
    .limit(1);
  return jsonResponse({
    ok: true,
    provider: row!.provider,
    model: row!.model,
    baseUrl: row!.base_url,
    preset: presetKeyFor(row!.provider, row!.base_url),
    temperature: row!.temperature,
    hasKey: row!.api_key_encrypted != null && row!.api_key_encrypted.length > 0,
  });
});

// POST /api/llm-settings/test — verify the SAVED provider config actually answers, by
// brokering a 1-token "ping" through the resolved adapter (BYO key or the platform env
// fallback). Keys stay host-side; the body carries nothing. Returns {ok, detail} (200
// either way — a failed provider is a normal result, not a route error).
const testSettings = route(async (req) => {
  const { effectiveTenantId: tenantId } = await requireTenantAdmin(req);

  // If the form posts its in-progress values, test THOSE (so "Test" reflects unsaved edits);
  // otherwise fall back to pinging the stored row. The freshly-typed key wins; if blank we reuse
  // the tenant's already-stored key so testing an edit that only changed the model still works.
  const raw = await readJsonOptional(req);
  const form = raw && typeof raw === 'object' && Object.keys(raw).length > 0 ? testFormSchema.parse(raw) : null;
  if (form) {
    const presetKey = presetKeyFor(form.provider, form.baseUrl ?? null);
    const preset = findPreset(presetKey)!;
    if (!preset.custom && !preset.models.includes(form.model)) {
      // The model/provider pair is the fact; the sentence around it is the reader's.
      return jsonResponse({
        ok: false,
        code: 'llm_test_model_not_offered',
        params: { model: form.model, provider: preset.label },
        detail: `Model '${form.model}' is not offered by '${preset.label}'.`,
      });
    }
    const [existing] = await db
      .select({
        enc: tenantLlmSettings.api_key_encrypted,
        provider: tenantLlmSettings.provider,
        baseUrl: tenantLlmSettings.base_url,
        // Migration 0091 — the DECLARED posture, so the probe runs under the same one the real
        // calls do rather than re-deriving it from `enc` being non-null.
        credentialSource: tenantLlmSettings.credential_source,
      })
      .from(tenantLlmSettings)
      .where(eq(tenantLlmSettings.tenant_id, tenantId))
      .limit(1);
    // ⛔ The stored key is lent to the form ONLY while the form still names the vendor it belongs
    // to — the same rule the save applies, and it matters more here because this route makes a
    // LIVE outbound request. Without it, switching the provider dropdown and pressing Test posted
    // the previous vendor's secret to the new one, which is the leak the save path was fixed for
    // arriving one route over.
    const sameVendor =
      existing != null &&
      adapterIdentityFor(existing.provider as LlmProviderKind, existing.baseUrl) ===
        adapterIdentityFor(form.provider, form.baseUrl ?? null);
    const params: Record<string, unknown> =
      form.temperature != null ? { temperature: form.temperature, ...(form.params ?? {}) } : (form.params ?? {});
    // ⭐ THE SAME FUNCTION THE SAVE CALLS. This branch used to be the only verification in the file
    // and it was written inline; the save now runs the identical code path, which is what makes
    // "Test says it works" and "Save accepted it" the same claim instead of two that can drift.
    const probe = await probeLlmKey({
      tenantId,
      kind: form.provider,
      model: form.model,
      baseUrl: form.baseUrl ?? null,
      apiKey: form.apiKey ?? null,
      storedKeyEncrypted: sameVendor ? (existing?.enc ?? null) : null,
      params,
      // The row's DECLARED posture when the form still names the vendor it was stored for
      // (migration 0091); otherwise nothing is declared and `resolveAdHocChat` answers
      // conservatively. ⚠️ NOT re-derived from `existing.enc` being non-null — that inference is
      // precisely what 0091 removed.
      credentialSource: sameVendor ? (existing?.credentialSource ?? undefined) : undefined,
    });
    if (!probe.ok) {
      return jsonResponse({
        ok: false,
        code: probe.code,
        // `llm_test_no_api_key` carries no parameters (its sentence is the whole rule);
        // `llm_test_failed` carries the provider's own text, as it always did.
        ...(probe.code === 'llm_test_failed' ? { params: { detail: probe.detail } } : {}),
        detail: probe.detail,
      });
    }
    // ⛔ ANOTHER 200-OK SUCCESS PATH. `provider`/`model` were ALREADY on this response as
    // top-level fields — the machine facts were on the wire the whole time and the screen still
    // rendered the server's hand-joined `detail` string. They are repeated under `params` rather
    // than read from the top level so that ONE label module can serve all three test screens
    // without knowing which endpoint answered it.
    return jsonResponse({
      ok: true,
      provider: probe.providerKind,
      model: probe.model,
      code: 'llm_test_ok',
      params: { provider: probe.providerKind, model: probe.model },
      detail: `${probe.providerKind} · ${probe.model}`,
    });
  }

  const resolved = await resolveChatProvider({ tenantId, model: config.agent.model });
  if (resolved.providerKind === 'stub') {
    return jsonResponse({
      ok: false,
      code: 'llm_test_stub_only',
      detail: 'No external provider is configured — the built-in stub would be used.',
    });
  }
  try {
    await resolved.provider.chat(
      { model: resolved.model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
      { signal: AbortSignal.timeout(15_000) },
    );
    return jsonResponse({
      ok: true,
      provider: resolved.providerKind,
      model: resolved.model,
      code: 'llm_test_ok',
      params: { provider: resolved.providerKind, model: resolved.model },
      detail: `${resolved.providerKind} · ${resolved.model}`,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return jsonResponse({ ok: false, code: 'llm_test_failed', params: { detail }, detail });
  }
});

export function registerLlmSettingsRoutes(router: Router): void {
  router.add('GET', '/api/llm-settings', getSettings);
  router.add('GET', '/api/llm-settings/catalog', getCatalog);
  router.add('PUT', '/api/llm-settings', putSettings);
  router.add('POST', '/api/llm-settings/test', testSettings);
}
