// tests/llm-select.test.ts — per-tenant chat-provider selection (select.ts). Against
// the dev/CI Postgres (:5433); env provider keys are unset in the test env, so the
// keyless paths resolve to the stub (the production default).
import { test, expect, afterAll, beforeEach } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, tenantLlmSettings, tenantLlmBudgets, tenants } from '../src/db/client';
import { resolveAdHocChat, resolveChatProvider, resolveTenantChatProviderIfConfigured } from '../src/ai/llm/select';
import { stubProvider } from '../src/ai/llm/stub-provider';
import { AnthropicProvider } from '../src/ai/llm/adapters/anthropic';
import { OpenAiProvider } from '../src/ai/llm/adapters/openai';
import { encryptSecret } from '../src/host/secret-box';
import { config } from '../src/config';
import type { LlmProvider } from '../src/ai/llm/provider';
import {
  __setByoPostureForTests,
  TenantByoKeyRequiredError,
  TENANT_BYO_KEY_REQUIRED_CODE,
  PlatformLocalOnlyError,
} from '../src/services/byo-posture';

// ⛔ THESE MUST BE UUIDs. `tenant_llm_settings.tenant_id` is the table's PRIMARY KEY and is
// `uuid` as of migration 0084 (it was `text`, which is why these used to read
// 'test-tenant-anthropic'). A non-uuid literal no longer fails an assertion — it raises 22P02
// `invalid input syntax for type uuid` at the INSERT, so the test errors instead of failing and
// says nothing about provider selection. Fixed, deliberately-recognisable test uuids.
const T = {
  anthropic: '0e5d0000-0000-4000-8000-00000000a417',
  openai: '0e5d0000-0000-4000-8000-00000000a0a1',
  nokey: '0e5d0000-0000-4000-8000-00000000a0e4',
};
const ALL = Object.values(T);

async function cleanup() {
  await db.delete(tenantLlmSettings).where(inArray(tenantLlmSettings.tenant_id, ALL));
  await db.delete(tenantLlmBudgets).where(inArray(tenantLlmBudgets.tenant_id, ALL));
  await db.delete(tenants).where(inArray(tenants.id, ALL));
}
// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
// Since migration 0102 `tenant_llm_settings.tenant_id` REFERENCES tenants(id): a settings fixture
// needs its tenant to exist. (`cleanup` deletes the tenants, which cascades to any settings left.)
beforeEach(async () => {
  await cleanup();
  await db.insert(tenants).values(ALL.map((id, i) => ({ id, name: `llm-select ${i}`, slug: `llm-select-${id.slice(-4)}` })));
}, 30_000);
afterAll(cleanup, 30_000);

test('tenant with an encrypted anthropic key → AnthropicProvider, tenant model', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-test'),
    // The tenant's OWN key: only a declared tenant_byo key may reach a commercial model.
    credential_source: 'tenant_byo',
  });
  const sel = await resolveChatProvider({ tenantId: T.anthropic, model: 'fallback-model' });
  expect(sel.provider).toBeInstanceOf(AnthropicProvider);
  expect(sel.model).toBe('claude-haiku-4-5');
});

test('tenant openai_compatible (DeepSeek) with base_url + key → OpenAiProvider', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.openai,
    provider: 'openai_compatible',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    api_key_encrypted: encryptSecret('sk-deepseek-test'),
    credential_source: 'tenant_byo',
  });
  const sel = await resolveChatProvider({ tenantId: T.openai, model: 'fallback-model' });
  expect(sel.provider).toBeInstanceOf(OpenAiProvider);
  expect(sel.model).toBe('deepseek-chat');
});

test('tenant row with NO key (and no env key) → stub, request model preserved', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.nokey,
    provider: 'anthropic',
    model: 'stub',
  });
  const sel = await resolveChatProvider({ tenantId: T.nokey, model: 'claude-sonnet-4-6' });
  expect(sel.provider).toBe(stubProvider);
  expect(sel.model).toBe('claude-sonnet-4-6');
});

test('no tenant row + no env key → stub', async () => {
  // A well-formed uuid that is deliberately absent from the table. Post-0084 it MUST be a valid
  // uuid: `resolveChatProvider` puts it straight into `eq(tenantLlmSettings.tenant_id, …)`
  // (ai/llm/select.ts), so 'does-not-exist' would now 22P02 rather than miss — turning "no row →
  // stub" into an error, which is the opposite of what this test asserts.
  const sel = await resolveChatProvider({
    tenantId: '0e5d0000-0000-4000-8000-0000000d0e5e',
    model: 'claude-sonnet-4-6',
  });
  expect(sel.provider).toBe(stubProvider);
});

test('null tenant + no env key → stub', async () => {
  const sel = await resolveChatProvider({ tenantId: null, model: 'claude-sonnet-4-6' });
  expect(sel.provider).toBe(stubProvider);
});

// ---- the PLATFORM env key is lent to ONE vendor -------------------------------------------
//
// ⛔ THE VENDOR-SWITCH LEAK, ONE LAYER DOWN. `routes/llm-settings.ts` now disowns the tenant's
// STORED key when the form names a different vendor — and that is exactly what exposed this: with
// the stored key correctly withheld, `envKeyFor` handed the PLATFORM's key to whatever host the
// tenant had just typed. Every catalog vendor host is on the seeded egress allowlist and the
// `custom` preset takes free text, so on a self-host with a real `OPENAI_API_KEY` a tenant_admin
// could point the form anywhere and read the platform's credential off the wire.
//
// Asserted ON THE WIRE, not on the resolver's return value: `providerKind` is the DB enum, so a
// leak and the prod path are both `openai_compatible`, and only the Authorization header the
// adapter actually sends can tell them apart. `governedLlmFetch` passes `.svc.cluster.local`
// straight through to the global fetch (the NetworkPolicy governs in-cluster targets), so stubbing
// `globalThis.fetch` intercepts the real request the real adapter builds.

/** Prod's in-cluster inference-router — the value of `OPENAI_BASE_URL` in this deployment. */
const LOCAL_BASE = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
/** A DIFFERENT in-cluster host. ⚠️ Deliberately in-cluster: `governedLlmFetch` short-circuits the
 *  egress allowlist for `.svc.cluster.local`, so a leak here WOULD reach the stubbed fetch and be
 *  visible. Pointing the leak case at an external host instead would make `wire === null` vacuous —
 *  `assertEgressAllowed` throws first in this test env, so nothing would be sent either way. */
const OTHER_CLUSTER_BASE = 'http://rogue-router.rogue.svc.cluster.local:8150/api';

/** Drive the resolved adapter and report what it actually put on the wire (null = nothing sent). */
async function wireOf(sel: { provider: LlmProvider; model: string }): Promise<{ url: string; auth: string } | null> {
  const realFetch = globalThis.fetch;
  let seen: { url: string; auth: string } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const h = (init?.headers ?? {}) as Record<string, string>;
    seen = { url, auth: h.authorization ?? h.Authorization ?? '' };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await sel.provider.chat(
      { model: sel.model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
      { signal: AbortSignal.timeout(5_000) },
    );
  } catch {
    // The stub provider never fetches; a resolver that withheld the key is proved by `seen` staying
    // null, not by whether the call itself threw.
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

/** Run `fn` with `OPENAI_BASE_URL` (the router) set to `base`, always restored. */
async function withRouterBase<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const prev = config.llm.openaiBaseUrl;
  (config.llm as { openaiBaseUrl: string }).openaiBaseUrl = base;
  try {
    return await fn();
  } finally {
    (config.llm as { openaiBaseUrl: string }).openaiBaseUrl = prev;
  }
}

test('router: the PROD shape — a keyless row at the router with no router token FAILS CLOSED, never `Bearer EMPTY`', async () => {
  // ⚠️ THE PATH EVERY PRODUCTION TENANT USES: migration 0035 gave every tenant a keyless row pinned
  // to the in-cluster router. Routing to it depends ONLY on the row's target being OPENAI_BASE_URL —
  // there is no OPENAI_API_KEY any more (owner rule 2026-10-13). A tenant without its own router
  // token is refused with a clear 503 code, and NOTHING reaches the wire.
  const { TenantInferenceNotProvisionedError } = await import('../src/services/tenant-inference');
  await withRouterBase(LOCAL_BASE, async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.nokey,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: LOCAL_BASE, // exactly what 0035 writes
    });
    await expect(resolveChatProvider({ tenantId: T.nokey, model: 'fallback-model' })).rejects.toBeInstanceOf(
      TenantInferenceNotProvisionedError,
    );
  });
});

test('router: a keyless row pointed at ANOTHER host gets NOTHING — no request is sent', async () => {
  // A router token travels only to the router OPENAI_BASE_URL names; a host the tenant typed into
  // the free-text `custom` field gets no credential and resolves to the stub.
  await withRouterBase(LOCAL_BASE, async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.openai,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: OTHER_CLUSTER_BASE,
    });
    const sel = await resolveChatProvider({ tenantId: T.openai, model: 'fallback-model' });
    expect(sel.provider).toBe(stubProvider);
    expect(await wireOf(sel)).toBeNull();
  });
});

test('router: an https→http DOWNGRADE of the router base is also another host', async () => {
  // The scheme is part of the identity (provider-catalog.ts), so the router token cannot be walked
  // onto a cleartext hop at the same host either.
  await withRouterBase('https://inference-router.example/api', async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.openai,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: 'http://inference-router.example/api',
    });
    expect((await resolveChatProvider({ tenantId: T.openai, model: 'fallback-model' })).provider).toBe(stubProvider);
  });
});

test('router: with NO router configured (dev/CI) a keyless router row is the stub — no env key exists to fall back to', async () => {
  await withRouterBase('', async () => {
    await db.insert(tenantLlmSettings).values([
      { tenant_id: T.nokey, provider: 'openai_compatible', model: 'local-llm', base_url: LOCAL_BASE },
      { tenant_id: T.anthropic, provider: 'anthropic', model: 'claude-haiku-4-5', base_url: null },
    ]);
    const local = await resolveChatProvider({ tenantId: T.nokey, model: 'fallback-model' });
    expect(local.provider).toBe(stubProvider);
    expect(await wireOf(local)).toBeNull();
    // A keyless Anthropic row: the platform holds no Anthropic key, so nothing is lent.
    expect((await resolveChatProvider({ tenantId: T.anthropic, model: 'm' })).provider).toBe(stubProvider);
    // …and with no row at all.
    expect((await resolveChatProvider({ tenantId: null, model: 'local-llm' })).provider).toBe(stubProvider);
  });
});

test('config holds no provider key: OPENAI_API_KEY / ANTHROPIC_API_KEY are not read', () => {
  expect(Object.keys(config.llm)).not.toContain('openaiApiKey');
  expect(Object.keys(config.llm)).not.toContain('anthropicApiKey');
});

// ---- credential ORIGIN (whose key paid), and the refusal that stops the platform paying ----

test('a DECLARED tenant_byo row resolves credentialSource=tenant_byo', async () => {
  // ⚠️ `credential_source` IS DECLARED HERE AND USED NOT TO BE. Before migration 0091 this test
  // inserted a key and nothing else, and passed because `select.ts` INFERRED BYO from the
  // ciphertext being non-null. That inference is the defect; see the MUTATION TARGET test below.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    api_key_encrypted: encryptSecret('sk-ant-byo'),
    credential_source: 'tenant_byo',
  });
  const r = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });
  expect(r.credentialSource).toBe('tenant_byo');
  expect(r.declaredCredentialSource).toBe('tenant_byo');
}, 30_000);

// ⛔⛔ MUTATION TARGET — `ai/llm/select.ts resolveChatProvider`, the `credentialSource:` line.
//
// REVERT THAT LINE TO `credentialSource: tenantKey ? 'tenant_byo' : 'platform_managed'` AND THIS
// TEST MUST GO RED. Nothing else in the suite can tell the two implementations apart, because
// every OTHER fixture has a stored key AND declares `tenant_byo`, so both the column and the guess
// give the same answer for all of them. This row is deliberately the ONE shape where they differ:
// a real, decryptable key IS stored, and the declaration says the money is the PLATFORM's.
//
// ⛔ THAT SHAPE IS NOT HYPOTHETICAL — IT IS THE PRODUCTION DEFECT, AND IT IS A BILLING ONE.
// `host/budget-service.ts:367` and `:462` write the platform's OWN OpenRouter welcome-budget key
// into `tenant_llm_settings.api_key_encrypted`. Key present ⇒ the old guess said `tenant_byo` ⇒
// `host/metering-emit.ts:246` set `usage_extra.byo = true` ⇒ the customer was charged a BYO markup
// on spend the platform had already paid the vendor for. `api_key_encrypted` answers "is there a
// key in this row"; it never answered "whose money is it", and the two questions diverge for an
// entire cohort of tenants.
//
// ⚠️ BOTH HALVES ARE ASSERTED ON PURPOSE. The `.not.toBe('tenant_byo')` alone would also pass if
// the field were dropped, mistyped or left undefined — i.e. for a broken implementation as well as
// a correct one. The positive half pins the value the ledger will actually carry.
test('MUTATION TARGET: credentialSource comes from the COLUMN, not from key presence', async () => {
  // ⚠️ The LOCAL router + `local-llm`: a platform-held key may reach nothing else (owner rule,
  // PlatformLocalOnlyError), so this is the only shape where a platform-declared stored key resolves.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'openai_compatible',
    model: 'local-llm',
    base_url: LOCAL_BASE,
    // A real, decryptable key — the guess's entire input is present and says "BYO".
    api_key_encrypted: encryptSecret('sk-ant-platform-funded-grant'),
    // …and the declaration says the platform funded it.
    credential_source: 'trial_managed',
  });
  const r = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });

  // The un-collapsed declaration survives to the caller, verbatim.
  expect(r.declaredCredentialSource).toBe('trial_managed');
  // …and the LEDGER axis collapses it to the platform, which is what stops the BYO markup.
  expect(r.credentialSource).toBe('platform_managed');
  expect(r.credentialSource).not.toBe('tenant_byo');

  // ⚠️ THE CONTROL. Without this the test could pass because the code ignores the column and always
  // answers `platform_managed` — a second bug that happens to satisfy the assertions above. Same
  // row shape, opposite declaration, opposite answer: only an implementation that actually READS
  // the column satisfies both.
  await db
    .update(tenantLlmSettings)
    .set({ credential_source: 'tenant_byo' })
    .where(eq(tenantLlmSettings.tenant_id, T.anthropic));
  const byo = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });
  expect(byo.credentialSource).toBe('tenant_byo');
}, 30_000);

// ⚠️ THE WIRE CODE IS DUPLICATED IN `byo-posture.ts` ON PURPOSE — spelled as a LITERAL inside
// `super(403, 'llm_byo_key_required', …)` so that
// `frontend/src/lib/api/error-message.backend-contract.test.ts` can READ it out of backend source
// text (the two projects share no types, so that scrape is the only contract there is; its
// `literalOrUnresolved` note records measuring that a bare `const` in the code slot silently turns
// the guard off). This pins the duplicate to the exported constant so the two cannot drift into
// different strings while every other assertion stays green.
test('the BYO refusal carries a stable 403 wire code the SPA scrape can read', () => {
  const err = new TenantByoKeyRequiredError(T.nokey);
  expect(err.code).toBe(TENANT_BYO_KEY_REQUIRED_CODE);
  expect(err.code).toBe('llm_byo_key_required');
  expect(err.status).toBe(403);
  // The class identity every other assertion in this file and in llm-broker.test.ts leans on.
  expect(err).toBeInstanceOf(TenantByoKeyRequiredError);
  // ⛔ The tenant id belongs in `details` for the operator/audit row, NOT interpolated into a
  // localized sentence — `FORBIDDEN_MESSAGES` is keyed on the code alone.
  expect(err.details).toEqual({ tenantId: T.nokey });
});

test('no tenant row at all → platform_managed or none, never tenant_byo', async () => {
  const r = await resolveChatProvider({ tenantId: T.nokey, model: 'm' });
  // Env keys are unset in the test env, so this is the stub — the point is only that a call the
  // tenant did not pay for can never be labelled as one they did.
  expect(r.credentialSource).not.toBe('tenant_byo');
}, 30_000);

test('a row with NO stored key still falls back to the platform — trial/managed is a real state', async () => {
  // ⚠️ The refusal below must NOT catch this case. A tenant who never configured a key is supported
  // (trial, managed), and refusing them would break every such tenant for no reason.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.nokey,
    provider: 'anthropic',
    model: 'stub',
    api_key_encrypted: null,
  });
  const r = await resolveChatProvider({ tenantId: T.nokey, model: 'm' });
  expect(r.credentialSource).not.toBe('tenant_byo');
}, 30_000);

test('a stored key that will NOT decrypt REFUSES — it must not silently spend the platform key', async () => {
  // ⛔ THE DEFECT THIS PINS, AND IT IS FINANCIAL RATHER THAN COSMETIC. `tryDecryptSecret` returns
  // null for BOTH "no key configured" and "key present but undecryptable" — the same conflation
  // `lib/license-status.ts` documents having fixed twice for the licence blob. Here the old
  // `tryDecryptSecret(...) ?? envKeyFor(...)` meant a BYO tenant whose blob stopped decrypting (a
  // rotated CP_SECRET_KEY, a corrupt row) kept working — on the PLATFORM's credential, at the
  // platform's expense, while the cost event still described a tenant who brings their own key.
  //
  // The assertion is the REFUSAL, not a label: a test that only checked `credentialSource` would
  // have passed on the old code, because the fallback produced a perfectly honest
  // `platform_managed` for a call the tenant was supposed to pay for.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.openai,
    provider: 'openai',
    model: 'gpt-4o-mini',
    api_key_encrypted: 'not-a-valid-secret-box-blob',
  });
  await expect(resolveChatProvider({ tenantId: T.openai, model: 'm' })).rejects.toThrow(
    /cannot be decrypted/,
  );
}, 30_000);

// ---- byo_required posture: a keyless tenant must NEVER run on the platform credential ----
//
// The posture comes from the licences service (services/byo-posture.ts); here the resolver is
// injected. Issuance is forced ON because an issuance-off environment (no licences service) does
// not enforce a posture it cannot read.

async function withPosture<T>(
  resolver: (tenantId: string) => Promise<'local_allowed' | 'byo_required' | 'platform_only'>,
  fn: () => Promise<T>,
): Promise<T> {
  const cfg = config.license as { issuanceEnabled: boolean };
  const before = cfg.issuanceEnabled;
  cfg.issuanceEnabled = true;
  __setByoPostureForTests({ resolver });
  try {
    return await fn();
  } finally {
    cfg.issuanceEnabled = before;
    __setByoPostureForTests(undefined);
  }
}

test('byo_required + keyless row → REFUSED, never the platform credential', async () => {
  await db.insert(tenantLlmSettings).values({ tenant_id: T.nokey, provider: 'anthropic', model: 'stub' });
  await withPosture(
    async () => 'byo_required',
    async () => {
      await expect(resolveChatProvider({ tenantId: T.nokey, model: 'm' })).rejects.toBeInstanceOf(
        TenantByoKeyRequiredError,
      );
    },
  );
});

test('byo_required + NO settings row → REFUSED (the env adapter is the platform too)', async () => {
  await withPosture(
    async () => 'byo_required',
    async () => {
      await expect(
        resolveChatProvider({ tenantId: '0e5d0000-0000-4000-8000-0000000d0e5f', model: 'm' }),
      ).rejects.toBeInstanceOf(TenantByoKeyRequiredError);
    },
  );
});

test('byo_required WITH its own key → resolves normally as tenant_byo (the posture is satisfied)', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-test'),
    // Declared since 0091 — the label is read off the column now, not inferred from the ciphertext.
    credential_source: 'tenant_byo',
  });
  let asked = 0;
  await withPosture(
    async () => {
      asked++;
      return 'byo_required';
    },
    async () => {
      const sel = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });
      expect(sel.credentialSource).toBe('tenant_byo');
    },
  );
  // ⚠️ THIS USED TO ASSERT 0 ("a tenant with its own key never needs the licences round trip").
  // Since `platform_only` is honoured, an OWN key (`tenant_byo`) is exactly the row that must ask:
  // a platform_only tenant's own key is switched off. One read, then the 60 s cache.
  expect(asked).toBe(1);
});

test('local_allowed + keyless row → still falls back (trial/managed is unaffected)', async () => {
  await db.insert(tenantLlmSettings).values({ tenant_id: T.nokey, provider: 'anthropic', model: 'stub' });
  await withPosture(
    async () => 'local_allowed',
    async () => {
      const sel = await resolveChatProvider({ tenantId: T.nokey, model: 'm' });
      expect(sel.credentialSource).not.toBe('tenant_byo');
    },
  );
});

test('posture read FAILS with nothing known → fail CLOSED (refuse), never fail open onto the platform', async () => {
  await db.insert(tenantLlmSettings).values({ tenant_id: T.nokey, provider: 'anthropic', model: 'stub' });
  await withPosture(
    async () => {
      throw new Error('licenses down');
    },
    async () => {
      await expect(resolveChatProvider({ tenantId: T.nokey, model: 'm' })).rejects.toBeInstanceOf(
        TenantByoKeyRequiredError,
      );
    },
  );
});

// ---- platform_only: the tenant's OWN key is switched off; always the platform path ----------
//
// ⛔ CP used to check only `byo_required`, so a `platform_only` (demo/trial) tenant's saved key was
// still decrypted and sent: inside CP `platform_only` behaved exactly like `local_allowed`. The
// agent workers ignore such a row (worker_management `factory/llm_config_resolver.py`); so does CP.

test('platform_only + its OWN key (tenant_byo) → the key is IGNORED, the platform path is used', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-OWN-KEY'),
    credential_source: 'tenant_byo',
  });
  await withPosture(
    async () => 'platform_only',
    async () => {
      const sel = await resolveChatProvider({ tenantId: T.anthropic, model: 'req-model' });
      // Not the tenant's adapter, not billed as BYO, not the tenant's pinned model. With no env
      // key in the test env the platform path is the stub; in prod it is the inference-router.
      expect(sel.provider).not.toBeInstanceOf(AnthropicProvider);
      expect(sel.credentialSource).not.toBe('tenant_byo');
      expect(sel.model).toBe('req-model');
      // The runner keeps its mode-driven (platform) provider rather than the tenant's row.
      expect(
        await resolveTenantChatProviderIfConfigured({ tenantId: T.anthropic, model: 'req-model' }),
      ).toBeNull();
    },
  );
});

test('platform_only + a PLATFORM-funded key (trial_managed) at the local router → still used', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'openai_compatible',
    model: 'local-llm',
    base_url: LOCAL_BASE,
    api_key_encrypted: encryptSecret('ir-GRANT'),
    credential_source: 'trial_managed',
  });
  await withPosture(
    async () => 'platform_only',
    async () => {
      const sel = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });
      expect(sel.provider).toBeInstanceOf(OpenAiProvider);
      expect(sel.credentialSource).toBe('platform_managed');
    },
  );
});

test('local_allowed + its OWN key → the key IS used (the lock is platform_only-specific)', async () => {
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-OWN-KEY'),
    credential_source: 'tenant_byo',
  });
  await withPosture(
    async () => 'local_allowed',
    async () => {
      const sel = await resolveChatProvider({ tenantId: T.anthropic, model: 'm' });
      expect(sel.provider).toBeInstanceOf(AnthropicProvider);
      expect(sel.credentialSource).toBe('tenant_byo');
    },
  );
});

test('byo_required + a PLATFORM-funded key (welcome-budget grant) → REFUSED, the grant is never spent', async () => {
  // ⛔ The refusal used to key on key PRESENCE, so a byo_required workspace holding the platform's
  // own OpenRouter grant key (declared `trial_managed`/`platform_managed`) spent it freely.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-GRANT'),
    credential_source: 'trial_managed',
  });
  await withPosture(
    async () => 'byo_required',
    async () => {
      await expect(resolveChatProvider({ tenantId: T.anthropic, model: 'm' })).rejects.toBeInstanceOf(
        TenantByoKeyRequiredError,
      );
    },
  );
});

test('⛔ RUNNER path, platform_only + own key → null (the mode-driven platform provider), even with a router configured', async () => {
  // The runner gate in `resolveTenantChatProviderIfConfigured` had no test: without an env key the
  // env fallback is the stub, which that function ALSO maps to null, so deleting the gate left the
  // suite green. With a platform env key present, the gate is the only thing that keeps the runner
  // on its mode-driven provider instead of switching it to an adapter.
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-OWN-KEY'),
    credential_source: 'tenant_byo',
  });
  // With a router configured, `resolveChatProvider` would take the router path (and refuse or need
  // a router token) — the gate is the only thing that returns null here.
  await withRouterBase(LOCAL_BASE, () =>
    withPosture(
      async () => 'platform_only',
      async () => {
        expect(
          await resolveTenantChatProviderIfConfigured({ tenantId: T.anthropic, model: 'req-model' }),
        ).toBeNull();
      },
    ),
  );
});

// ---- a GRANT key mislabelled `tenant_byo` is the platform's money (0091 backfill) -------------
//
// ⛔ Measured in prod: raisemytickets' settings key is byte-identical to its $5 welcome-budget grant
// (`tenant_llm_budgets.or_key_encrypted`), but 0091 labelled the row `tenant_byo`. Under
// byo_required it would spend the grant; under platform_only it would lose it.
async function grantRow(opts: { reEncrypt?: boolean } = {}) {
  await db
    .insert(tenants)
    .values({ id: T.anthropic, name: 'grant-mislabel', slug: 'grant-mislabel-a417' })
    .onConflictDoNothing();
  const grantEnc = encryptSecret('sk-or-PLATFORM-GRANT');
  await db.insert(tenantLlmBudgets).values({
    tenant_id: T.anthropic,
    or_key_encrypted: grantEnc,
    limit_usd: '5',
  });
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.anthropic,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    // budget-service copies the ciphertext verbatim; a re-encrypted copy differs as bytes.
    api_key_encrypted: opts.reEncrypt ? encryptSecret('sk-or-PLATFORM-GRANT') : grantEnc,
    credential_source: 'tenant_byo',
  });
}

// (The call-time "a tenant_byo key equal to the welcome-budget grant is the platform's money"
// correction is gone with the welcome budget itself — 0099. 0098 relabelled the one prod row, and
// nothing writes a grant key any more, so select.ts no longer reads tenant_llm_budgets.)

test('migration 0098 relabels a byte-identical grant row and leaves a genuine own key alone', async () => {
  await grantRow();
  await db
    .insert(tenants)
    .values({ id: T.openai, name: 'own-key', slug: 'own-key-a0a1' })
    .onConflictDoNothing();
  await db.insert(tenantLlmBudgets).values({
    tenant_id: T.openai,
    or_key_encrypted: encryptSecret('sk-or-OTHER-GRANT'),
    limit_usd: '5',
    status: 'replaced',
  });
  await db.insert(tenantLlmSettings).values({
    tenant_id: T.openai,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    api_key_encrypted: encryptSecret('sk-ant-GENUINELY-OWN'),
    credential_source: 'tenant_byo',
  });
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const text = readFileSync(resolve(import.meta.dir, '../migrations/0098_llm_grant_key_not_byo.sql'), 'utf8');
  for (let i = 0; i < 2; i++) await db.transaction(async (tx) => { await tx.execute(sql.raw(text)); }); // idempotent
  const src = async (id: string) =>
    (await db.select({ c: tenantLlmSettings.credential_source }).from(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, id)))[0]!.c;
  expect(await src(T.anthropic)).toBe('trial_managed');
  expect(await src(T.openai)).toBe('tenant_byo');
});

// ---- Part B: a local-llm tenant calls the router with ITS OWN inference-router token ----------
//
// ⛔ Today's code sent every tenant's router call as `Bearer EMPTY` — unattributable, unbudgeted.
// A tenant holding an inference-router licence token (services/tenant-inference.ts, 0099) sends that
// token; a `local-llm` tenant WITHOUT one fails closed; platform background work keeps EMPTY.
async function withRouterEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withRouterBase(LOCAL_BASE, fn);
}
async function localLlmTenant(opts: { token: string | null; withRow: boolean }) {
  await db
    .insert(tenants)
    .values({
      id: T.nokey,
      name: 'local-llm tenant',
      slug: 'partb-local-llm-a0e4',
      plan_code: 'local-llm',
      inference_token_encrypted: opts.token ? encryptSecret(opts.token) : null,
    })
    // The tenant row already exists (beforeEach creates it for the 0102 FK), so UPDATE it.
    .onConflictDoUpdate({
      target: tenants.id,
      set: {
        plan_code: 'local-llm',
        inference_token_encrypted: opts.token ? encryptSecret(opts.token) : null,
      },
    });
  if (opts.withRow) {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.nokey,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: LOCAL_BASE,
      credential_source: 'local',
    });
  }
}

test("local-llm: a keyless router row sends the TENANT's inference-router token, never EMPTY", async () => {
  await withRouterEnv(async () => {
    await localLlmTenant({ token: 'ir-tenant-token-a0e4', withRow: true });
    const sel = await resolveChatProvider({ tenantId: T.nokey, model: 'm' });
    const wire = await wireOf(sel);
    expect(wire).not.toBeNull();
    expect(wire!.url).toBe(`${LOCAL_BASE}/chat/completions`);
    expect(wire!.auth).toBe('Bearer ir-tenant-token-a0e4');
    expect(wire!.auth).not.toContain('EMPTY');
  });
});

test('local-llm: with NO settings row (env fallback) the tenant token is sent too', async () => {
  await withRouterEnv(async () => {
    await localLlmTenant({ token: 'ir-tenant-token-a0e4', withRow: false });
    const wire = await wireOf(await resolveChatProvider({ tenantId: T.nokey, model: 'local-llm' }));
    expect(wire!.auth).toBe('Bearer ir-tenant-token-a0e4');
  });
});

// (The PLATFORM's router credential — platformActor / tenant-less calls — is pinned in
// tests/platform-inference.test.ts, the one file that touches the system tenant's row.)

test('⛔ `Bearer EMPTY` is IMPOSSIBLE: the adapter refuses every placeholder before any request', async () => {
  for (const placeholder of ['EMPTY', 'empty', ' none ', 'internal']) {
    let sent = 0;
    const p = new OpenAiProvider({
      apiKey: placeholder,
      model: 'local-llm',
      baseUrl: LOCAL_BASE,
      fetchImpl: (async () => {
        sent++;
        return new Response('{}', { status: 200 });
      }) as never,
    });
    await expect(
      p.chat({ model: 'local-llm', messages: [{ role: 'user', content: 'x' }] }, { signal: AbortSignal.timeout(5_000) }),
    ).rejects.toThrow(/placeholder credential/);
    expect(sent).toBe(0);
  }
});

test('local-llm WITHOUT a provisioned token fails CLOSED — nothing is sent as EMPTY', async () => {
  const { TenantInferenceNotProvisionedError } = await import('../src/services/tenant-inference');
  await withRouterEnv(async () => {
    await localLlmTenant({ token: null, withRow: true });
    await expect(resolveChatProvider({ tenantId: T.nokey, model: 'm' })).rejects.toBeInstanceOf(
      TenantInferenceNotProvisionedError,
    );
  });
});

test('byo plan: a tenant with no key of its own FAILS CLOSED even with no licences posture', async () => {
  // Issuance is off in the test env, so the licences posture read answers null ("unknown"). The
  // PLAN is CP's own and is enough: a `byo` workspace has no platform path.
  await withRouterEnv(async () => {
    await db
      .insert(tenants)
      .values({ id: T.nokey, name: 'byo tenant', slug: 'partb-byo-a0e4', plan_code: 'byo' })
      .onConflictDoUpdate({ target: tenants.id, set: { plan_code: 'byo' } });
    await db.insert(tenantLlmSettings).values({
      tenant_id: T.nokey,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: LOCAL_BASE,
    });
    await expect(resolveChatProvider({ tenantId: T.nokey, model: 'm' })).rejects.toBeInstanceOf(
      TenantByoKeyRequiredError,
    );
  });
});

test("a tenant's OWN endpoint that accepts any key still gets the key the tenant typed — `EMPTY` included", async () => {
  // ⚠️ The placeholder refusal is for the ROUTER only. A self-hosted vLLM / gateway behind the
  // `custom` preset may accept any bearer, and a tenant may genuinely configure `EMPTY` for it.
  let sent = null as string | null;
  const p = new OpenAiProvider({
    apiKey: 'EMPTY',
    model: 'my-model',
    baseUrl: OTHER_CLUSTER_BASE,
    fetchImpl: (async (_u: string, init?: RequestInit) => {
      sent = ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never,
  });
  await p.chat({ model: 'my-model', messages: [{ role: 'user', content: 'x' }] }, { signal: AbortSignal.timeout(5_000) });
  expect(sent).toBe('Bearer EMPTY');
});

test("Test connection against a tenant's own any-key endpoint sends the typed `EMPTY` (not refused, not swapped)", async () => {
  await withRouterEnv(async () => {
    const adhoc = await resolveAdHocChat({
      tenantId: T.nokey,
      kind: 'openai_compatible',
      model: 'my-model',
      baseUrl: OTHER_CLUSTER_BASE,
      apiKey: 'EMPTY',
    });
    const wire = await wireOf(adhoc);
    expect(wire).not.toBeNull();
    expect(wire!.url).toBe(`${OTHER_CLUSTER_BASE}/chat/completions`);
    expect(wire!.auth).toBe('Bearer EMPTY');
  });
});
