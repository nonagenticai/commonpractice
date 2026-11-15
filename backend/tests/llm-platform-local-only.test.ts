// tests/llm-platform-local-only.test.ts — OWNER RULE (2026-10-13): commercial models are only ever
// called with the TENANT'S OWN key. Every platform-credential path is confined to the in-cluster
// router + `LOCAL_LLM_MODELS` (services/byo-posture.ts `assertPlatformLocalOnly`). One test per path;
// each was proven to go red with its guard line reverted.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, tenantLlmSettings, tenants } from '../src/db/client';
import { resolveAdHocChat, resolveChatProvider } from '../src/ai/llm/select';
import { AnthropicProvider } from '../src/ai/llm/adapters/anthropic';
import { LOCAL_LLM_MODELS, providerCatalog, isPlatformLocalTarget } from '../src/ai/llm/provider-catalog';
import { encryptSecret } from '../src/host/secret-box';
import { brokerLlmCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import { config } from '../src/config';
import { PlatformLocalOnlyError, PLATFORM_LOCAL_ONLY_CODE } from '../src/services/byo-posture';

// Fixed, recognisable uuids unique to this file (shared-DB fixture collisions are a known trap).
const T = {
  grant: '1a0c0000-0000-4000-8000-0000000a1001',
  keyless: '1a0c0000-0000-4000-8000-0000000a1002',
  byo: '1a0c0000-0000-4000-8000-0000000a1003',
};
const ALL = Object.values(T);
const LOCAL_BASE = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
const COMMERCIAL = 'claude-sonnet-4-6';

async function cleanup() {
  await db.delete(tenantLlmSettings).where(inArray(tenantLlmSettings.tenant_id, ALL));
  await db.delete(tenants).where(inArray(tenants.id, ALL));
}
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  // Since migration 0102 `tenant_llm_settings.tenant_id` REFERENCES tenants(id).
  await db.insert(tenants).values(ALL.map((id, i) => ({ id, name: `local-only ${i}`, slug: `local-only-${id.slice(-4)}` })));
}, 30_000);
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

/** Run `fn` with config.llm temporarily overridden, always restored. */
async function withLlm<T>(patch: Partial<typeof config.llm>, fn: () => Promise<T>): Promise<T> {
  const prev = { ...config.llm };
  Object.assign(config.llm as Record<string, unknown>, patch);
  try {
    return await fn();
  } finally {
    Object.assign(config.llm as Record<string, unknown>, prev);
  }
}
const ROUTER_ENV = { openaiBaseUrl: LOCAL_BASE } as Partial<typeof config.llm>;

test('the allowlist is the local preset’s own list, and the wire code is stable', () => {
  expect(providerCatalog().find((p) => p.key === 'local')!.models).toEqual([...LOCAL_LLM_MODELS]);
  expect(LOCAL_LLM_MODELS).toEqual(['local-llm']);
  expect(isPlatformLocalTarget('openai_compatible', LOCAL_BASE, 'local-llm')).toBe(true);
  expect(isPlatformLocalTarget('openai_compatible', LOCAL_BASE, COMMERCIAL)).toBe(false);
  expect(isPlatformLocalTarget('anthropic', null, 'local-llm')).toBe(false);
  const err = new PlatformLocalOnlyError(null, COMMERCIAL);
  expect(err.code).toBe(PLATFORM_LOCAL_ONLY_CODE);
  expect(err.code).toBe('llm_platform_local_only');
  expect(err.status).toBe(403);
  expect(err.message).toBe('Commercial models need your own API key. Add it in LLM settings.');
});

test('path 1: a platform-held GRANT key (trial_managed) is refused for a commercial model', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.grant,
    provider: 'anthropic',
    model: COMMERCIAL,
    api_key_encrypted: encryptSecret('sk-ant-PLATFORM-GRANT'),
    credential_source: 'trial_managed',
  });
  await expect(resolveChatProvider({ tenantId: T.grant, model: 'm' })).rejects.toBeInstanceOf(
    PlatformLocalOnlyError,
  );
});

test('path 2: a keyless row naming a commercial model at the router is refused before any token is minted', async () => {
  await withLlm(ROUTER_ENV, async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.keyless,
      provider: 'openai_compatible',
      model: COMMERCIAL,
      base_url: LOCAL_BASE,
      credential_source: 'local',
    });
    // Without the guard this reaches `routerCredential` (→ TenantInferenceNotProvisionedError, or the
    // tenant's IR token sent with a commercial model id).
    await expect(resolveChatProvider({ tenantId: T.keyless, model: 'm' })).rejects.toBeInstanceOf(
      PlatformLocalOnlyError,
    );
  });
});

test('path 3a: the router fallback (no settings row) refuses a commercial model', async () => {
  // (There is no env provider key any more; the platform's only fallback is the router.)
  await withLlm(ROUTER_ENV, async () => {
    await expect(resolveChatProvider({ tenantId: null, model: COMMERCIAL })).rejects.toBeInstanceOf(
      PlatformLocalOnlyError,
    );
  });
});

test('path 3b: the runner’s mode-driven router provider refuses a commercial model', async () => {
  await withLlm({ mode: 'openai_compatible', openaiBaseUrl: LOCAL_BASE } as Partial<typeof config.llm>, async () => {
    // A STRUCTURED refusal, not a throw: run-controller answers the runner's `llm_request` from this
    // value, and a throw left the runner without an `llm_response` frame.
    const out = await brokerLlmCall('1a0c0000-0000-4000-8000-0000000a10ff', { model: COMMERCIAL, prompt: 'x' });
    expect(out).toMatchObject({ ok: false, kind: 'model_not_allowed', rule: 'llm_platform_local_only' });
  });
});

test('path 4: the ad-hoc probe does not lend the platform credential to a commercial model', async () => {
  await withLlm(ROUTER_ENV, async () => {
    await expect(
      resolveAdHocChat({ tenantId: T.keyless, kind: 'openai_compatible', model: COMMERCIAL, baseUrl: LOCAL_BASE }),
    ).rejects.toBeInstanceOf(PlatformLocalOnlyError);
  });
  // …nor a stored key the row declares as the platform's.
  await expect(
    resolveAdHocChat({
      tenantId: T.grant,
      kind: 'anthropic',
      model: COMMERCIAL,
      storedKeyEncrypted: encryptSecret('sk-ant-PLATFORM-GRANT'),
      credentialSource: 'trial_managed',
    }),
  ).rejects.toBeInstanceOf(PlatformLocalOnlyError);
});

test('path 5: platform work (platformActor) asking for a commercial model is refused, whatever key the tenant row holds', async () => {
  // Platform work no longer reads the tenant row at all (owner ruling: platform-paid, local-only),
  // so a row's key cannot lend it a commercial model; the router fallback's local-only guard refuses.
  await withLlm(ROUTER_ENV, async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.byo,
      provider: 'anthropic',
      model: COMMERCIAL,
      api_key_encrypted: encryptSecret('sk-ant-TENANT-OWN'),
      credential_source: 'tenant_byo',
    });
    await expect(
      resolveChatProvider({ tenantId: T.byo, model: COMMERCIAL, platformActor: true }),
    ).rejects.toBeInstanceOf(PlatformLocalOnlyError);
  });
});

test('POSITIVE CONTROL: the tenant’s OWN key (tenant_byo) still reaches a commercial model', async () => {
  await withLlm(ROUTER_ENV, async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.byo,
      provider: 'anthropic',
      model: COMMERCIAL,
      api_key_encrypted: encryptSecret('sk-ant-TENANT-OWN'),
      credential_source: 'tenant_byo',
    });
    const sel = await resolveChatProvider({ tenantId: T.byo, model: 'm' });
    expect(sel.provider).toBeInstanceOf(AnthropicProvider);
    expect(sel.model).toBe(COMMERCIAL);
    expect(sel.credentialSource).toBe('tenant_byo');
    // A freshly TYPED key on the probe is the operator's own too.
    const adhoc = await resolveAdHocChat({ kind: 'anthropic', model: COMMERCIAL, apiKey: 'sk-ant-typed' });
    expect(adhoc.provider).toBeInstanceOf(AnthropicProvider);
  });
});
