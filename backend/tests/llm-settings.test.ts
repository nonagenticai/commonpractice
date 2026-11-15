// tests/llm-settings.test.ts — the BYO-key settings route (PUT/GET /api/llm-settings).
// The provider key is stored AES-256-GCM encrypted and NEVER returned. Auth is faked
// via __setAuthOverridesForTests so we control the user id (= the settings tenant).
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, tenantLlmSettings, tenants } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerLlmSettingsRoutes, __setLlmKeyProbeForTests } from '../src/routes/llm-settings';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { decryptSecret } from '../src/host/secret-box';
import { __setSnapshotOverrideForTests, buildSnapshot } from '../src/host/policy-store';
import { providerCatalog } from '../src/ai/llm/provider-catalog';
import { config } from '../src/config';
import { __setByoPostureForTests } from '../src/services/byo-posture';
import type { User } from '../src/types';

const USER_ID = '00000000-0000-0000-0000-00000010b001';
const platformUser: User = {
  id: USER_ID,
  email: 'llmset@test',
  name: 'LlmSet',
  roles: ['platform', 'employee', 'tenant_admin'], // requireTenantAdmin needs the realm role
  tenantId: USER_ID,
};

const router = new Router();
registerLlmSettingsRoutes(router);

function call(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const m = router.match(method, '/api/llm-settings')!;
  return m.handler(
    new Request('http://t/api/llm-settings', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function testCall(body?: unknown): Promise<Response> {
  const m = router.match('POST', '/api/llm-settings/test')!;
  return m.handler(
    new Request('http://t/api/llm-settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

/** The persisted row — every vendor-switch assertion below reads THIS, never a return value. */
async function storedRow() {
  const [row] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, USER_ID));
  return row;
}

async function cleanup() {
  await db.delete(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, USER_ID));
  await db.delete(tenants).where(eq(tenants.id, USER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => platformUser,
    requireRole: async () => platformUser,
  });
  // Pin a CORRECTLY-CONFIGURED platform: every catalog model allowlisted, plus the two free-text
  // ids the custom-preset tests use. Without this the file reads whatever `models.allowlist` the
  // shared dev database happens to hold — which is exactly the drifted, stale value this PR is
  // about (dev had 3 entries, prod 7, against 21 in the catalog), so unrelated tests about key
  // encryption and temperature persistence would fail for a reason that has nothing to do with
  // what they assert. The allowlist gate itself is covered explicitly at the end of this file.
  __setSnapshotOverrideForTests({
    ...buildSnapshot([]),
    allowlistedModels: [...new Set(providerCatalog().flatMap((p) => p.models)), 'm1', 'm2'],
  });
  // ⛔ THE SAVE NOW PROBES THE KEY BEFORE IT PERSISTS IT, SO EVERY PUT IN THIS FILE WOULD OTHERWISE
  // MAKE A LIVE OUTBOUND REQUEST. Twenty-odd assertions here are about encryption-at-rest, vendor
  // switching, temperature persistence and the allowlist gate, and every one of them PUTs a
  // fabricated key (`sk-ant-SECRET-xyz`). Without this stub each would either reach a real vendor
  // from CI or be refused by the egress gate, and the whole file would go red for a reason that has
  // nothing to do with what it asserts — which is the pressure that gets a new guard weakened
  // instead of stubbed.
  //
  // ⚠️ THE DEFAULT IS **SUCCESS**, AND THAT IS WHAT KEEPS THOSE ASSERTIONS HONEST: they continue to
  // test exactly what they tested before, with the probe passing. The FAILING arm is installed by
  // the one test that is about the probe, and nothing else in this file depends on it.
  //
  // ⚠️ IT REPLACES ONLY THE NETWORK HOP. Which key is lent to which vendor, whether resolution
  // lands on the stub, whether the probe runs at all, and what a failure does to the save are all
  // still the real code — which is why `POST /test`'s stub arm ("does not lend the stored key to a
  // DIFFERENT vendor either", at the foot of this file) keeps working unchanged.
  __setLlmKeyProbeForTests(async () => {});
  await cleanup();
  // Since migration 0102 `tenant_llm_settings.tenant_id` REFERENCES tenants(id): the workspace the
  // route saves for has to exist (a real request always has one).
  await db.insert(tenants).values({ id: USER_ID, name: 'llm-settings test', slug: 'llm-settings-10b001' });
}, 30_000);
afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
  __setLlmKeyProbeForTests(undefined);
  await cleanup();
}, 30_000);

test('GET before any config → {configured:false}', async () => {
  const res = await call('GET');
  expect(res.status).toBe(200);
  // `byoMode` is the licences posture (null = unknown: issuance is off in the test env).
  expect(await res.json()).toEqual({ configured: false, byoMode: null });
});

test('PUT stores the key ENCRYPTED (not plaintext) and never echoes it', async () => {
  const apiKey = 'sk-ant-super-secret-123';
  const res = await call('PUT', {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey,
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as Record<string, unknown>;
  expect(out.ok).toBe(true);
  expect(out.hasKey).toBe(true);
  // the response must NOT contain the plaintext key anywhere
  expect(JSON.stringify(out)).not.toContain(apiKey);

  const [row] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, USER_ID));
  expect(row!.api_key_encrypted).toBeTruthy();
  expect(row!.api_key_encrypted).not.toContain(apiKey); // ciphertext at rest
  expect(decryptSecret(row!.api_key_encrypted!)).toBe(apiKey); // host can recover it
});

test('PUT without apiKey on update keeps the existing stored key', async () => {
  // A custom OpenAI-compatible endpoint (base_url matches no preset) → free-form model, no list check.
  const custom = { provider: 'openai_compatible' as const, baseUrl: 'https://custom.example/v1' };
  await call('PUT', { ...custom, model: 'm1', apiKey: 'sk-keep-me' });
  const [before] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, USER_ID));

  // edit only the model — no apiKey supplied
  const res = await call('PUT', { ...custom, model: 'm2' });
  expect(res.status).toBe(200);
  const [after] = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, USER_ID));
  expect(after!.model).toBe('m2');
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted); // untouched
});

test('GET masks the key + returns preset and temperature', async () => {
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    temperature: 0.3,
    apiKey: 'sk-deepseek',
  });
  const res = await call('GET');
  const out = (await res.json()) as Record<string, unknown>;
  expect(out).toEqual({
    configured: true,
    provider: 'openai_compatible',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    preset: 'deepseek',
    temperature: 0.3,
    params: {},
    hasKey: true,
    // The licences LLM-access posture; null = unknown (issuance is off in the test env).
    byoMode: null,
  });
  expect(JSON.stringify(out)).not.toContain('sk-deepseek');
});

test('PUT rejects an invalid provider (422)', async () => {
  const res = await call('PUT', { provider: 'gemini', model: 'x' });
  expect(res.status).toBe(422);
});

test('PUT rejects a model not offered by the provider preset (400)', async () => {
  const res = await call('PUT', { provider: 'anthropic', model: 'not-a-claude-model', apiKey: 'sk' });
  expect(res.status).toBe(400);
});

test('PUT rejects a key-requiring provider with no key (400)', async () => {
  const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  expect(res.status).toBe(400);
});

test('PUT the local provider needs NO key and persists temperature', async () => {
  const res = await call('PUT', {
    provider: 'openai_compatible',
    model: 'local-llm',
    baseUrl: 'http://inference-router.inference-router.svc.cluster.local:8150/api',
    temperature: 0.1,
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as Record<string, unknown>;
  expect(out.preset).toBe('local');
  expect(out.temperature).toBe(0.1);
  expect(out.hasKey).toBe(false);
});

test('GET /api/llm-settings/catalog lists the provider presets', async () => {
  const m = router.match('GET', '/api/llm-settings/catalog')!;
  const res = await m.handler(new Request('http://t/api/llm-settings/catalog'));
  expect(res.status).toBe(200);
  const out = (await res.json()) as { providers: { key: string }[] };
  const keys = out.providers.map((p) => p.key);
  expect(keys).toContain('local');
  expect(keys).toContain('anthropic');
  expect(keys).toContain('deepseek');
});

// ---- the governance allowlist is a SECOND gate, checked at save time -------------------------

test('PUT is refused when the model is not on the governance allowlist', async () => {
  // THE BUG THIS CLOSES. Passing the catalog check was never enough to make a model usable:
  // `llm-broker.ts reserveCall` independently refuses anything absent from `models.allowlist` with
  // `model_not_allowed`. So a tenant admin could pick a model the dropdown offers, save it
  // successfully, and then have EVERY LLM call fail — with the error surfacing inside a flow run or
  // the agent chat rather than at the moment they could act on it.
  //
  // Live prod had drifted to 7 allowlisted ids against 21 in the catalog, because
  // `models.allowlist` is seeded ONCE from the catalog and never reconciled. Four entire providers
  // (OpenAI, DeepSeek, xAI, Cohere) were selectable and then refused.
  //
  // `gpt-4o` is deliberately the fixture: it IS in the catalog (so it clears the `invalid_model`
  // check on the line above) and is NOT in this allowlist — exactly the prod shape.
  __setSnapshotOverrideForTests({
    ...buildSnapshot([]),
    allowlistedModels: ['local-llm', 'claude-sonnet-4-6'],
  });
  try {
    const res = await call('PUT', {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-not-allowlisted',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('model_not_allowlisted'); // NOT the generic 'invalid_model'
    // And nothing was persisted — a refused save must not leave a half-configured tenant.
    const rows = await db
      .select()
      .from(tenantLlmSettings)
      .where(eq(tenantLlmSettings.tenant_id, USER_ID));
    expect(rows.length).toBe(0);
  } finally {
    __setSnapshotOverrideForTests(undefined);
  }
});

test('PUT succeeds for the SAME model once it is allowlisted', async () => {
  // The other half: the gate must not be a blanket refusal of non-local providers.
  __setSnapshotOverrideForTests({
    ...buildSnapshot([]),
    allowlistedModels: ['local-llm', 'gpt-4o'],
  });
  try {
    const res = await call('PUT', {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-allowlisted',
    });
    expect(res.status).toBe(200);
  } finally {
    __setSnapshotOverrideForTests(undefined);
  }
});

test('an EMPTY allowlist means no restriction — mirroring the broker, not blocking every save', () => {
  // `reserveCall` gates on `allowlist && allowlist.length > 0`. If this check disagreed with the
  // enforcer it would refuse saves the broker would happily serve, which is worse than no check.
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), allowlistedModels: [] });
  return call('PUT', { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test-open' })
    .then(async (res) => {
      expect(res.status).toBe(200);
    })
    .finally(() => __setSnapshotOverrideForTests(undefined));
});

// ---- a stored key belongs to the vendor it was issued to, and to nobody else -----------------
//
// ⛔ THE DEFECT THIS SECTION CLOSES. `keyPatch` was `body.apiKey ? {…} : {}` — "only touch the
// encrypted key when a new one is supplied" — while `base` overwrote `provider`, `base_url` and
// `model` unconditionally. So a PUT that changed only the VENDOR left the previous vendor's
// ciphertext sitting in the row, and `hadKey` (read from that same ciphertext) satisfied the new
// preset's `requiresKey` check on its behalf. Keys carry no vendor tag, so nothing downstream could
// catch it: `ai/llm/select.ts resolveChatProvider` does `tryDecryptSecret(row.api_key_encrypted)`
// and hands the result to whichever adapter the NEW row selects.
//
// Measured live against this route before the fix (one tenant, three PUTs):
//   provider=openai_compatible base=api.openai.com/v1 apiKey=sk-OPENAI-… → ciphertext QeC38t0O…
//   provider=anthropic         model=claude-sonnet-4-6  (NO apiKey) → 200, ciphertext QeC38t0O…
//   provider=openai_compatible base=https://api.x.ai/v1 (NO apiKey) → 200, ciphertext QeC38t0O…
// i.e. `adapters/anthropic.ts` would then send the OpenAI key as `x-api-key` to api.anthropic.com,
// and `adapters/openai.ts` as `Authorization: Bearer` to api.x.ai. The egress allowlist does not
// stop it — `policies.data.egress_allowlist` is seeded with every catalog vendor host.
//
// ⛔ SECTION TWO IS THE OVER-CORRECTION GUARD AND IS NOT OPTIONAL. "Clear the key on every PUT"
// passes every assertion in section one, and would force a tenant to re-enter their key to change
// a temperature.

const LOCAL_BASE = 'http://inference-router.inference-router.svc.cluster.local:8150/api';

test('a VENDOR switch with no new key is REFUSED — the stored ciphertext never travels', async () => {
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-OPENAI-SECRET-abc123',
  });
  const before = await storedRow();
  expect(before!.api_key_encrypted).toBeTruthy();

  // The live reproduction, exactly: change the vendor, supply no key.
  const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('api_key_required');

  // …and the refusal is total: nothing half-wrote a row pointing the old key at Anthropic.
  const after = await storedRow();
  expect(after!.provider).toBe('openai_compatible');
  expect(after!.base_url).toBe('https://api.openai.com/v1');
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('a VENDOR switch to a keyless provider CLEARS the stored ciphertext', async () => {
  // The `local` preset needs no key, so this PUT legitimately succeeds — which makes it the case
  // that can assert the ciphertext is GONE rather than merely un-reachable behind a 400.
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-SECRET-xyz' });
  expect((await storedRow())!.api_key_encrypted).toBeTruthy();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'local-llm', baseUrl: LOCAL_BASE });
  expect(res.status).toBe(200);
  const after = await storedRow();
  expect(after!.provider).toBe('openai_compatible');
  expect(after!.api_key_encrypted).toBeNull(); // ⛔ not "some other value" — absent
  // And the screen is told, so the panel stops claiming a key exists.
  expect(((await res.json()) as { hasKey: boolean }).hasKey).toBe(false);
  expect(((await (await call('GET')).json()) as { hasKey: boolean }).hasKey).toBe(false);
});

test('two different CUSTOM endpoints are two different vendors', async () => {
  // ⛔ THE CASE A PRESET-KEY COMPARISON CANNOT SEE. `presetKeyFor` collapses every unrecognised
  // base_url onto the single `custom` key, so these two URLs — two unrelated companies — are the
  // SAME preset. Comparing preset keys would carry the key straight across.
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'm1',
    baseUrl: 'https://vendor-a.example/v1',
    apiKey: 'sk-VENDOR-A-SECRET',
  });
  const before = await storedRow();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'm2', baseUrl: 'https://vendor-b.example/v1' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('api_key_required');
  const after = await storedRow();
  expect(after!.base_url).toBe('https://vendor-a.example/v1');
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('the SAME host on a different ADAPTER is a vendor switch — the auth header changes', async () => {
  // ⛔ THE MUTATION THE 21 CASES ABOVE ALL SURVIVED: dropping `${family}|` from the identity, so it
  // is the host alone. Every other case here moves the HOST as well as the adapter, so none of them
  // can see it. Here the host is FIXED and only the adapter moves — an Anthropic key issued for
  // `x-api-key` would be carried onto `adapters/openai.ts`, which sends it as
  // `Authorization: Bearer` to the same company. Same secret, wrong header, no consent.
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-SECRET-family' });
  const before = await storedRow();
  expect(before!.api_key_encrypted).toBeTruthy();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'm1', baseUrl: 'https://api.anthropic.com/v1' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('api_key_required');
  const after = await storedRow();
  expect(after!.provider).toBe('anthropic'); // the refusal is total — nothing half-wrote the row
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('DOWNGRADING https → http at one host is a vendor switch — the key never goes cleartext', async () => {
  // ⛔ Measured before the scheme was folded into the identity: this PUT returned 200 and KEPT the
  // ciphertext, so `adapters/openai.ts` then sent `Authorization: Bearer sk-…` over plaintext http
  // to a host anyone on the path can read. Editing one character of the URL is not consent to
  // publish the key. The tenant must re-enter it deliberately.
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-OPENAI-SECRET-cleartext',
  });
  const before = await storedRow();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'm1', baseUrl: 'http://api.openai.com/v1' });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('api_key_required');
  const after = await storedRow();
  expect(after!.base_url).toBe('https://api.openai.com/v1');
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('…and plain http is still a first-class base url — the in-cluster router round-trips', async () => {
  // ⛔ THE OVER-CORRECTION GUARD FOR THE TEST ABOVE, AND IT IS THE PRODUCTION CONFIGURATION.
  // "Require https" passes that case and breaks every tenant in this deployment: migration 0035
  // points them all at this plaintext in-cluster address. What is refused is the silent MOVE
  // between schemes, never http itself — so a save at an http base must succeed, and a later
  // non-vendor edit at the same http base must keep the key. (The `local` preset offers exactly one
  // model, so the non-vendor edit here is the temperature.)
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'local-llm',
    baseUrl: LOCAL_BASE,
    apiKey: 'sk-LOCAL-ROUTER-KEEP-ME',
  });
  const before = await storedRow();
  expect(before!.base_url).toBe(LOCAL_BASE);
  expect(before!.api_key_encrypted).toBeTruthy();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'local-llm', baseUrl: LOCAL_BASE, temperature: 0.4 });
  expect(res.status).toBe(200);
  const after = await storedRow();
  expect(after!.temperature).toBe(0.4);
  expect(after!.base_url).toBe(LOCAL_BASE);
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('a vendor switch WITH a new key stores the NEW key and drops the old ciphertext', async () => {
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-OPENAI-SECRET-abc123',
  });
  const before = await storedRow();

  const res = await call('PUT', {
    provider: 'openai_compatible',
    model: 'grok-4.5',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: 'xai-GROK-SECRET',
  });
  expect(res.status).toBe(200);
  const after = await storedRow();
  expect(after!.base_url).toBe('https://api.x.ai/v1');
  expect(after!.api_key_encrypted).not.toBe(before!.api_key_encrypted!);
  expect(decryptSecret(after!.api_key_encrypted!)).toBe('xai-GROK-SECRET'); // never the OpenAI one
});

// ---- …and the legitimate edits that must NOT cost the tenant their key ----------------------

test('changing only the MODEL within one vendor keeps the key byte-for-byte', async () => {
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-KEEP-ME' });
  const before = await storedRow();

  const res = await call('PUT', { provider: 'anthropic', model: 'claude-haiku-4-5' });
  expect(res.status).toBe(200);
  const after = await storedRow();
  expect(after!.model).toBe('claude-haiku-4-5');
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('a trailing slash / different casing is the SAME vendor, not a switch', async () => {
  // The identity has to normalize the way `presetKeyFor` already does, or every tenant whose form
  // round-trips a URL with a trailing slash loses their key for nothing.
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-openai-KEEP-ME',
  });
  const before = await storedRow();

  const res = await call('PUT', { provider: 'openai_compatible', model: 'gpt-4.1', baseUrl: 'https://API.OpenAI.com/v1/' });
  expect(res.status).toBe(200);
  expect((await storedRow())!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('changing only the TEMPERATURE keeps the key', async () => {
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-TEMP' });
  const before = await storedRow();
  const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.7 });
  expect(res.status).toBe(200);
  const after = await storedRow();
  expect(after!.temperature).toBe(0.7);
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!);
});

test('the FIRST save of a tenant with no row at all is unaffected', async () => {
  // There is no stored vendor to differ from; a key-requiring preset still needs a key, and a
  // keyless one still does not.
  expect(await storedRow()).toBeUndefined();
  expect((await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6' })).status).toBe(400);
  expect((await call('PUT', { provider: 'openai_compatible', model: 'local-llm', baseUrl: LOCAL_BASE })).status).toBe(200);
});

test('POST /test does not lend the stored key to a DIFFERENT vendor either', async () => {
  // Same leak, same file, one route over: `testSettings` posts the form the user is EDITING and
  // falls back to the stored ciphertext for a blank key — which, after a provider switch in the
  // dropdown, is a LIVE outbound request carrying the previous vendor's secret.
  await call('PUT', {
    provider: 'openai_compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-OPENAI-SECRET-abc123',
  });
  const res = await testCall({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  expect(res.status).toBe(200); // a failed provider is a normal result on this route, never a throw
  const body = (await res.json()) as { ok: boolean; detail: string };
  expect(body.ok).toBe(false);
  // The stub arm — i.e. no key was found for Anthropic, so no request was built and none was sent.
  expect(body.detail).toContain('No API key for this provider');
});

// ── the save-time key probe ──────────────────────────────────────────────────────────────────────
//
// ⛔ THE DEFECT THIS SECTION CLOSES. `putSettings` encrypted whatever 1–500 characters arrived and
// wrote them to `tenant_llm_settings.api_key_encrypted` without ever asking a provider whether they
// worked. The ONLY verification in the whole route file lived behind `POST /api/llm-settings/test`
// — a button the admin does not have to press. A typo'd, revoked or wrong-vendor token therefore
// persisted with `200 OK` and `hasKey: true`, and the failure surfaced hours later inside a flow
// run or an agent turn, as a provider 401 the author has no way to connect back to the save.
//
// ⚠️ THE STORED ROW IS WHAT EVERY ASSERTION BELOW READS, never a return value — the same rule the
// vendor-switch section above sets. A route that answered 400 and persisted anyway would satisfy a
// status-only test.

test('PUT REFUSES a key the provider rejects — and stores NOTHING', async () => {
  // ⛔ THE PROBE FAILS THE WAY A REAL PROVIDER FAILS: an exception out of the adapter carrying the
  // vendor's own HTTP body. Only the network hop is stubbed; resolution, the gate and the refusal
  // are the real code.
  __setLlmKeyProbeForTests(async () => {
    throw new Error('401 Unauthorized: invalid_api_key');
  });

  const res = await call('PUT', {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: 'sk-ant-DEFINITELY-WRONG',
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; message: string; reason?: string };
  // A STABLE machine code, not a sentence — the thing a screen can switch on.
  expect(body.error).toBe('llm_key_probe_failed');
  // The provider's own text survives to the reader: it is the most useful fact on the screen and no
  // catalog can hold it.
  expect(body.message).toContain('invalid_api_key');

  // ⛔ THE HALF THAT MATTERS. A 400 that still wrote the row would leave the tenant with a stored
  // credential that cannot work, which is the exact state this change exists to make unreachable.
  expect(await storedRow()).toBeUndefined();
}, 30_000);

test('a failed probe does not CLOBBER the key that was already working', async () => {
  // The upgrade path, and the nastier half of the same defect: refusing the save is only correct if
  // the row the tenant already had survives it. An `onConflictDoUpdate` that ran before the probe
  // would have replaced a live credential with a dead one.
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-GOOD-ONE' });
  const before = await storedRow();
  expect(before!.api_key_encrypted).toBeTruthy();

  __setLlmKeyProbeForTests(async () => {
    throw new Error('403 Forbidden: key revoked');
  });
  expect(
    (await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-BAD-ONE' }))
      .status,
  ).toBe(400);

  const after = await storedRow();
  expect(after!.api_key_encrypted).toBe(before!.api_key_encrypted!); // byte-for-byte
  expect(decryptSecret(after!.api_key_encrypted!)).toBe('sk-ant-GOOD-ONE');
}, 30_000);

test('the probe failure NEVER echoes the key back — not whole, not truncated', async () => {
  // ⛔ THE ONE PLACE A JUST-TYPED SECRET CAN ESCAPE. The detail is `e.message` from an arbitrary
  // vendor adapter, built from the HTTP response BODY, and providers DO quote the offending
  // credential — a real OpenAI 401 reads `Incorrect API key provided: sk-abc***`. That string is
  // returned to the browser AND written to the pod log by `route()`.
  //
  // ⚠️ THE TRUNCATED FORM IS THE ONE A PLAIN `replaceAll(key, …)` MISSES, which is why the test
  // uses it rather than the whole key: a redaction that only catches the full literal passes a
  // whole-key test and leaks on every real 401.
  const KEY = 'sk-ant-SUPER-SECRET-9f3a2b1c';
  __setLlmKeyProbeForTests(async () => {
    throw new Error(`Incorrect API key provided: ${KEY.slice(0, 14)}***. Check your account.`);
  });

  const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: KEY });
  expect(res.status).toBe(400);
  const raw = await res.text();
  expect(raw).not.toContain(KEY);
  expect(raw).not.toContain(KEY.slice(0, 14));
  expect(raw).not.toContain('SUPER-SECRET');
  // …and the reader still learns what went wrong.
  expect(raw).toContain('Check your account');
}, 30_000);

test('a model-only edit does NOT probe — no live request for a save that stores no credential', async () => {
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-KEEP' });

  // ⚠️ AN EXPLODING PROBE IS THE INSTRUMENT: if the gate is wrong and probes on every save, this
  // PUT throws and the test reds. A counter would prove the same thing less loudly.
  let probed = 0;
  __setLlmKeyProbeForTests(async () => {
    probed++;
    throw new Error('the probe must not run for a save that supplies no key');
  });
  const res = await call('PUT', { provider: 'anthropic', model: 'claude-haiku-4-5' });
  expect(res.status).toBe(200);
  expect(probed).toBe(0);
  // The stored key is untouched, which is what makes "no credential is being stored" true.
  expect(decryptSecret((await storedRow())!.api_key_encrypted!)).toBe('sk-ant-KEEP');
}, 30_000);

test('a successful save DECLARES credential_source=tenant_byo (migration 0091)', async () => {
  // ⛔ THE DECLARATION IS THE POINT OF 0091: this route is the one place a human says whose
  // credential is paying, so it is the one place that may write the column. Before it,
  // `ai/llm/select.ts` INFERRED BYO from the ciphertext being non-null — and
  // `host/budget-service.ts` stores the PLATFORM's own welcome-budget key in that same column, so
  // an entire cohort was billed a BYO markup on platform-funded spend.
  await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-DECLARED' });
  expect((await storedRow())!.credential_source).toBe('tenant_byo');

  // A vendor switch to a KEYLESS preset clears the ciphertext, so the platform pays from that
  // moment — and the declaration has to move with it or the row keeps claiming BYO with no key.
  // ⚠️ The module-level `LOCAL_BASE` (the in-cluster inference-router), NOT a fresh URL — it is the
  // one base the catalog resolves to a keyless preset that accepts the `local-llm` model id, so a
  // local re-declaration here would be refused by the catalog gate before the vendor switch runs.
  const res = await call('PUT', {
    provider: 'openai_compatible',
    model: 'local-llm',
    baseUrl: LOCAL_BASE,
  });
  expect(res.status).toBe(200);
  const row = await storedRow();
  expect(row!.api_key_encrypted).toBeNull();
  expect(row!.credential_source).not.toBe('tenant_byo');
}, 30_000);

// ---- platform_only: bringing your own key is switched OFF ------------------------------------
//
// ⛔ CP used to check only `byo_required`, so a `platform_only` (demo/trial) workspace could save a
// key here and `ai/llm/select.ts` would then use it — `platform_only` behaved like `local_allowed`.
// The agent workers already refuse it (worker_management `_router.py`). The save now does too.
async function withByoMode<T>(mode: 'local_allowed' | 'byo_required' | 'platform_only', fn: () => Promise<T>) {
  const cfg = config.license as { issuanceEnabled: boolean };
  const before = cfg.issuanceEnabled;
  cfg.issuanceEnabled = true;
  __setByoPostureForTests({ resolver: async () => mode });
  try {
    return await fn();
  } finally {
    cfg.issuanceEnabled = before;
    __setByoPostureForTests(undefined);
  }
}

test('platform_only: a PUT carrying a key is REFUSED 403 llm_byo_disabled and nothing is stored', async () => {
  let probed = 0;
  __setLlmKeyProbeForTests(async () => {
    probed++;
  });
  await withByoMode('platform_only', async () => {
    const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-DEMO' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('llm_byo_disabled');
    // The GET tells the screen why the key field is off.
    const got = (await (await call('GET')).json()) as { byoMode: string | null };
    expect(got.byoMode).toBe('platform_only');
  });
  expect(await storedRow()).toBeUndefined();
  // Refused BEFORE the probe: the key is never even sent to its vendor.
  expect(probed).toBe(0);
}, 30_000);

test('platform_only: a keyless save (the platform local model) still works', async () => {
  await withByoMode('platform_only', async () => {
    const res = await call('PUT', { provider: 'openai_compatible', model: 'local-llm', baseUrl: LOCAL_BASE });
    expect(res.status).toBe(200);
  });
}, 30_000);

test('local_allowed: the same keyed PUT is accepted (the refusal is platform_only-specific)', async () => {
  await withByoMode('local_allowed', async () => {
    const res = await call('PUT', { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-OWN' });
    expect(res.status).toBe(200);
  });
  expect((await storedRow())!.credential_source).toBe('tenant_byo');
}, 30_000);
