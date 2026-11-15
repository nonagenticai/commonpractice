// tests/runner-tenant-inference.test.ts — the RUNNER path (`ctx.llm()` → brokerLlmCall) of a
// local-llm tenant carries the tenant's own inference-router token, never `Bearer EMPTY`.
//
// ⛔ WHY A SEPARATE FILE. select.ts's chat path is pinned in llm-select.test.ts, but the runner does
// not go through select.ts for a keyless tenant: it falls back to the MODE-DRIVEN provider
// (`LLM_MODE=openai_compatible` → the router, with the env sentinel), and the substitution lives in
// host/llm-broker.ts. Without these, deleting that substitution left every test green while each
// flow run of a local-llm tenant reached the router as `Bearer EMPTY` — which the router, in
// `INTROSPECT_MODE=enforce`, refuses (401).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, runAsSystem, tenants, users, usageCounters, usageEvents, withTenantTx } from '../src/db/client';
import { config } from '../src/config';
import { brokerLlmCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import { encryptSecret } from '../src/host/secret-box';
import { TenantInferenceNotProvisionedError } from '../src/services/tenant-inference';

const TENANT = '00000000-0000-4000-8000-0000b0b0e001';
const USER = '00000000-0000-4000-8000-0000b0b0e0a1';
const ROUTER = 'http://inference-router.inference-router.svc.cluster.local:8150/api';

const llm = config.llm as { mode: string; openaiBaseUrl: string };
const was = { mode: llm.mode, base: llm.openaiBaseUrl };

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(usageEvents).where(eq(usageEvents.user_id, USER));
    await db.delete(usageCounters).where(eq(usageCounters.user_id, USER));
    await db.delete(users).where(eq(users.id, USER));
    await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  });
}

async function seed(token: string | null) {
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({
      id: TENANT,
      name: 'runner local-llm',
      slug: 'runner-local-llm-e001',
      plan_code: 'local-llm',
      inference_token_encrypted: token ? encryptSecret(token) : null,
    });
    await db.insert(users).values({ id: USER, email: 'runner@test', name: 'Runner', tenant_id: TENANT });
  });
}

/** Run one ctx.llm() call as the tenant and report the Authorization the router received. */
async function runnerWire(): Promise<{ auth: string | null; error: unknown }> {
  const realFetch = globalThis.fetch;
  let auth: string | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    auth = h.authorization ?? h.Authorization ?? '';
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    await withTenantTx(TENANT, () => brokerLlmCall(USER, { model: 'local-llm', prompt: 'ping' }));
    return { auth, error: null };
  } catch (error) {
    return { auth, error };
  } finally {
    globalThis.fetch = realFetch;
  }
}

beforeEach(async () => {
  __setBrokerDepsForTests({ limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  llm.mode = 'openai_compatible';
  llm.openaiBaseUrl = ROUTER;
  await cleanup();
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  llm.mode = was.mode;
  llm.openaiBaseUrl = was.base;
  await cleanup();
}, 30_000);

test("runner: a local-llm tenant's ctx.llm() carries the TENANT's router token, never EMPTY", async () => {
  await seed('ir-runner-token-e001');
  const { auth, error } = await runnerWire();
  expect(error).toBeNull();
  expect(auth).toBe('Bearer ir-runner-token-e001');
}, 30_000);

test('runner: a local-llm tenant WITHOUT a token fails CLOSED — nothing reaches the router', async () => {
  await seed(null);
  const { auth, error } = await runnerWire();
  expect(error).toBeInstanceOf(TenantInferenceNotProvisionedError);
  expect(auth).toBeNull();
}, 30_000);
