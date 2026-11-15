// tests/platform-inference.test.ts — the PLATFORM's own inference-router credential.
//
// Platform background work (`platformActor`: content translation) and a call with no tenant used to
// reach the in-cluster router as `Bearer EMPTY`. The router runs INTROSPECT_MODE=enforce (measured
// 2026-10-13) and refuses that with a 401. The platform now holds its own router licence, on a
// dedicated licences SERVICE tenant (`INFERENCE_PLATFORM_TENANT_ID`, svc-commonpractice) — not the
// nil `default-anon` tenant, whose cost events inference-router drops.
//
// ⛔ THE ONE FILE THAT TOUCHES `platform_inference_state` (a single row). bun runs test files
// concurrently against one database, so every test that needs it lives here and resets it.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, runAsSystem, tenants, tenantLlmSettings, users, usageCounters, usageEvents, withTenantTx } from '../src/db/client';
import { config } from '../src/config';
import { encryptSecret, tryDecryptSecret } from '../src/host/secret-box';
import { resolveChatProvider } from '../src/ai/llm/select';
import { brokerChatCall, brokerLlmCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import {
  ensurePlatformInference,
  TenantInferenceNotProvisionedError,
  __resetPlatformInferenceCacheForTests,
  __setInferenceLicencesForTests,
  __setInferenceFetchForTests,
} from '../src/services/tenant-inference';
import { __setLicensesAdminForTests, type LicensesAdminClient } from '../src/services/licenses-admin';
import { platformInferenceState } from '../src/db/schema';
import { platformBackoffMs, PLATFORM_BACKOFF_CAP_MS } from '../src/services/tenant-inference';
import type { LlmProvider } from '../src/ai/llm/provider';
import { AnthropicProvider } from '../src/ai/llm/adapters/anthropic';
import { __setByoPostureForTests } from '../src/services/byo-posture';

const ROUTER = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
const TENANT = '00000000-0000-4000-8000-0000b0b0f001';
const USER = '00000000-0000-4000-8000-0000b0b0f0a1';
const llm = config.llm as { mode: string; openaiBaseUrl: string };
const lic = config.license as { issuanceEnabled: boolean };
const inf = config.inference as { platformTenantId: string };
const was = {
  mode: llm.mode,
  base: llm.openaiBaseUrl,
  issuance: lic.issuanceEnabled,
  holder: inf.platformTenantId,
};
/** svc-commonpractice — a licences SERVICE tenant (uuid5 in prod; any real uuid here). */
const SVC = '5c0e0000-0000-5000-8000-0000b0b0f5c1';
/** The nil uuid (`default-anon` in licences), built so the shared-fixture-id guard does not count it. */
const NIL = ['00000000', '0000', '0000', '0000', '000000000000'].join('-');

async function resetPlatformState() {
  await db
    .update(platformInferenceState)
    .set({
      holder_tenant_id: null,
      token_encrypted: null,
      licence_id: null,
      provisioned_at: null,
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      revoke_pending: [],
      op_id: null,
      op_until: null,
    })
    .where(eq(platformInferenceState.id, 1));
  __resetPlatformInferenceCacheForTests();
}
async function setPlatformToken(token: string | null, holder: string = SVC) {
  await db
    .update(platformInferenceState)
    .set({ holder_tenant_id: holder, token_encrypted: token ? encryptSecret(token) : null })
    .where(eq(platformInferenceState.id, 1));
  __resetPlatformInferenceCacheForTests();
}
const restoreSystem = resetPlatformState;

async function cleanupTenant() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(usageEvents).where(eq(usageEvents.user_id, USER));
    await db.delete(usageCounters).where(eq(usageCounters.user_id, USER));
    await db.delete(users).where(eq(users.id, USER));
    await db.delete(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, TENANT));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
  });
}
async function seedTenant() {
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({
      id: TENANT,
      name: 'pi tenant',
      slug: 'pi-tenant-f001',
      plan_code: 'local-llm',
      inference_token_encrypted: encryptSecret('ir-tenant-token-f001'),
    });
    await db.insert(users).values({ id: USER, email: 'pi@test', name: 'PI', tenant_id: TENANT });
    await db.insert(tenantLlmSettings).values({
      tenant_id: TENANT,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: ROUTER,
      credential_source: 'local',
    });
  });
}

/** Run `fn` with global fetch stubbed; report the Authorization of the request it made (null = none). */
async function authOnWire(fn: () => Promise<unknown>): Promise<{ auth: string | null; error: unknown }> {
  const realFetch = globalThis.fetch;
  let auth: string | null = null;
  globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    auth = h.authorization ?? h.Authorization ?? '';
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await fn();
    return { auth, error: null };
  } catch (error) {
    return { auth, error };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const chatOnce = (p: LlmProvider) =>
  p.chat({ model: 'local-llm', messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }, { signal: AbortSignal.timeout(5_000) });

beforeEach(async () => {
  llm.mode = 'openai_compatible';
  llm.openaiBaseUrl = ROUTER;
  __setBrokerDepsForTests({ limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  inf.platformTenantId = SVC;
  await cleanupTenant();
  await seedTenant();
  await resetPlatformState();
}, 30_000);

afterAll(async () => {
  await resetPlatformState();
  inf.platformTenantId = was.holder;
  await cleanupTenant();
  llm.mode = was.mode;
  llm.openaiBaseUrl = was.base;
  lic.issuanceEnabled = was.issuance;
  __setBrokerDepsForTests(undefined);
  __setLicensesAdminForTests(undefined);
  __setInferenceLicencesForTests(undefined);
  __setInferenceFetchForTests(undefined);
  __resetPlatformInferenceCacheForTests();
}, 30_000);

test('chat: platform background work (platformActor) carries the PLATFORM router token, never EMPTY', async () => {
  try {
    await setPlatformToken('ir-platform-token-f001');
    const sel = await resolveChatProvider({ tenantId: TENANT, model: 'local-llm', platformActor: true });
    const { auth } = await authOnWire(() => chatOnce(sel.provider));
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    await restoreSystem();
  }
}, 30_000);

/** Turn the seeded tenant into one that brought its OWN commercial key. */
async function giveTenantOwnKey() {
  await runAsSystem('boot-seed', () =>
    db
      .update(tenantLlmSettings)
      .set({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        base_url: null,
        api_key_encrypted: encryptSecret('sk-ant-TENANT-OWN-f001'),
        credential_source: 'tenant_byo',
      })
      .where(eq(tenantLlmSettings.tenant_id, TENANT)),
  );
}

test('⛔ OWNER RULING: platform work NEVER uses the tenant’s OWN key — router + local model + platform token', async () => {
  // Platform background work is platform-paid and local-only. Before, `resolveChatProvider` read the
  // tenant row first, so a tenant with a BYO Anthropic key had the PLATFORM's translation drainer
  // bill its commercial key (and its model) for work nobody in the tenant asked for.
  try {
    await setPlatformToken('ir-platform-token-f001');
    await giveTenantOwnKey();
    const sel = await resolveChatProvider({ tenantId: TENANT, model: 'local-llm', platformActor: true });
    expect(sel.provider).not.toBeInstanceOf(AnthropicProvider);
    expect(sel.providerKind).toBe('openai');
    expect(sel.model).toBe('local-llm');
    expect(sel.credentialSource).toBe('platform_managed');
    const { auth } = await authOnWire(() => chatOnce(sel.provider));
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    await restoreSystem();
  }
}, 30_000);

test('POSITIVE CONTROL: the same tenant’s OWN (non-platform) work still uses its own key', async () => {
  await giveTenantOwnKey();
  const sel = await resolveChatProvider({ tenantId: TENANT, model: 'local-llm' });
  expect(sel.provider).toBeInstanceOf(AnthropicProvider);
  expect(sel.model).toBe('claude-sonnet-4-6');
  expect(sel.credentialSource).toBe('tenant_byo');
}, 30_000);

test('platform work for a byo_required KEYLESS tenant is not refused with TenantByoKeyRequired', async () => {
  // The posture governs what the TENANT spends; the platform pays for its own background work.
  const before = lic.issuanceEnabled;
  lic.issuanceEnabled = true;
  __setByoPostureForTests({ resolver: async () => 'byo_required' });
  try {
    await setPlatformToken('ir-platform-token-f001');
    const sel = await resolveChatProvider({ tenantId: TENANT, model: 'local-llm', platformActor: true });
    expect(sel.credentialSource).toBe('platform_managed');
    const { auth } = await authOnWire(() => chatOnce(sel.provider));
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    lic.issuanceEnabled = before;
    __setByoPostureForTests(undefined);
    await restoreSystem();
  }
}, 30_000);

test('chat: a call with NO tenant carries the platform router token', async () => {
  try {
    await setPlatformToken('ir-platform-token-f001');
    const sel = await resolveChatProvider({ tenantId: null, model: 'local-llm' });
    const { auth } = await authOnWire(() => chatOnce(sel.provider));
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    await restoreSystem();
  }
}, 30_000);

test('chat: platform work with NO platform token fails CLOSED', async () => {
  try {
    await setPlatformToken(null);
    await expect(resolveChatProvider({ tenantId: TENANT, model: 'local-llm', platformActor: true })).rejects.toBeInstanceOf(
      TenantInferenceNotProvisionedError,
    );
  } finally {
    await restoreSystem();
  }
}, 30_000);

test('runner: a platformActor ctx.llm() carries the PLATFORM router token', async () => {
  try {
    await setPlatformToken('ir-platform-token-f001');
    // No tenant settings row on the runner path: the mode-driven router provider is what is used.
    await db.delete(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, TENANT));
    const { auth, error } = await authOnWire(() =>
      withTenantTx(TENANT, () =>
        brokerLlmCall(USER, { model: 'local-llm', prompt: 'ping' }, { stage: 'content-translation', platformActor: true }),
      ),
    );
    expect(error).toBeNull();
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    await restoreSystem();
  }
}, 30_000);

test('broker chat: the PRODUCTION platform path (brokerChatCall + platformActor, as translation-service calls it) carries the PLATFORM token', async () => {
  // ⛔ translation-service.ts is the one production platformActor caller and it goes through
  // brokerChatCall. Dropping `platformActor` where brokerChatCall resolves the provider would send
  // the TENANT's token for platform work (billing the tenant for the platform's translation).
  try {
    await setPlatformToken('ir-platform-token-f001');
    const { auth, error } = await authOnWire(() =>
      withTenantTx(TENANT, () =>
        brokerChatCall(
          USER,
          TENANT,
          { model: 'local-llm', messages: [{ role: 'user', content: 'translate' }], maxTokens: 1 },
          { signal: AbortSignal.timeout(5_000) },
          { stage: 'content-translation', platformActor: true },
        ),
      ),
    );
    expect(error).toBeNull();
    expect(auth).toBe('Bearer ir-platform-token-f001');
  } finally {
    await restoreSystem();
  }
}, 30_000);

function makeIr(opts: { revokeFails?: boolean } = {}) {
  const minted: Array<{ subject: string; tenantId: string }> = [];
  const revoked: string[] = [];
  let n = 0;
  const client = {
    async createLicense(subject: string, tenantId: string) {
      minted.push({ subject, tenantId });
      n++;
      return { licenseId: `00000000-0000-4000-8000-0000b0b0f1c${n}`, subjectId: '11111111-1111-4111-8111-0000b0b0f001' };
    },
    async createToken() {
      return { token: 'tok-platform-f001' };
    },
    async revokeByLicenseId(id: string) {
      if (opts.revokeFails) throw new Error('licences down (revoke)');
      revoked.push(id);
    },
    async revokeByToken() {},
  } as unknown as LicensesAdminClient;
  return { client, minted, revoked };
}
const enforcingRouter = async (_url: string, init?: RequestInit) => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return new Response('{}', { status: h.authorization === 'Bearer tok-platform-f001' ? 200 : 401 });
};

test('ensurePlatformInference mints on the PLATFORM SERVICE tenant (never the nil default-anon), smoke + negative control, idempotently', async () => {
  const ir = makeIr();
  __setInferenceLicencesForTests(ir.client);
  const bearers: string[] = [];
  __setInferenceFetchForTests(async (url, init) => {
    bearers.push(((init?.headers ?? {}) as Record<string, string>).authorization ?? '');
    return enforcingRouter(url, init);
  });
  try {
    expect((await ensurePlatformInference()).status).toBe('provisioned');
    expect(ir.minted).toEqual([{ subject: `cp-tenant:${SVC}:a`, tenantId: SVC }]);
    expect(ir.minted[0]!.tenantId).not.toBe(NIL);
    expect(bearers).toHaveLength(2); // negative control (refused) + the platform token
    const [row] = await db.select().from(platformInferenceState).where(eq(platformInferenceState.id, 1));
    expect(row!.holder_tenant_id).toBe(SVC);
    expect(tryDecryptSecret(row!.token_encrypted)).toBe('tok-platform-f001');
    expect(row!.attempts).toBe(0);
    // Idempotent.
    expect((await ensurePlatformInference()).status).toBe('already_provisioned');
    expect(ir.minted).toHaveLength(1);
  } finally {
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
    await resetPlatformState();
  }
}, 30_000);

test('a token held for ANOTHER holder is never used (the configured platform tenant moved)', async () => {
  try {
    await setPlatformToken('ir-platform-token-f001', NIL);
    await expect(resolveChatProvider({ tenantId: null, model: 'local-llm' })).rejects.toBeInstanceOf(
      TenantInferenceNotProvisionedError,
    );
  } finally {
    await resetPlatformState();
  }
}, 30_000);

test('⛔ a failing platform smoke BACKS OFF (persisted): no re-mint until next_attempt_at, then doubles', async () => {
  const ir = makeIr();
  __setInferenceLicencesForTests(ir.client);
  __setInferenceFetchForTests(async () => new Response('nope', { status: 401 })); // refuses everything
  try {
    const t0 = new Date();
    await expect(ensurePlatformInference(t0)).rejects.toThrow();
    let [row] = await db.select().from(platformInferenceState).where(eq(platformInferenceState.id, 1));
    expect(row!.attempts).toBe(1);
    expect(row!.next_attempt_at!.getTime() - t0.getTime()).toBe(platformBackoffMs(1));
    expect(ir.revoked).toHaveLength(1); // the smoke-failed licence is not left live

    // The next ticks inside the window do NOTHING — no mint, no revoke (this is what used to churn).
    for (const dtMs of [60_000, 4 * 60_000]) {
      const out = await ensurePlatformInference(new Date(t0.getTime() + dtMs));
      expect(out.status).toBe('backoff');
    }
    expect(ir.minted).toHaveLength(1);

    // Past the window: one more attempt, and the window doubles.
    const t1 = new Date(t0.getTime() + platformBackoffMs(1) + 1_000);
    await expect(ensurePlatformInference(t1)).rejects.toThrow();
    [row] = await db.select().from(platformInferenceState).where(eq(platformInferenceState.id, 1));
    expect(row!.attempts).toBe(2);
    expect(row!.next_attempt_at!.getTime() - t1.getTime()).toBe(platformBackoffMs(2));
    expect(platformBackoffMs(2)).toBe(2 * platformBackoffMs(1));
    expect(ir.minted).toHaveLength(2);
    // Capped at 6 h however many times it fails.
    expect(platformBackoffMs(50)).toBe(PLATFORM_BACKOFF_CAP_MS);
  } finally {
    __setInferenceLicencesForTests(undefined);
    __setInferenceFetchForTests(undefined);
    await resetPlatformState();
  }
}, 30_000);
