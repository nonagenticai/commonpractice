// tests/llm-broker-unpinned-model.test.ts -- a platform block that names NO model (the seeded demo
// blocks since migration 0102) is served the TENANT's model, never a hardcoded commercial one.
//
//   * local-llm / keyless tenant -> the platform router, model = AGENT_MODEL (`local-llm`)
//   * tenant_byo tenant           -> its OWN provider, with the model stored in tenant_llm_settings
//   * a block that still PINS a commercial model on the platform router is still refused (the rule
//     did not weaken; the blocks stopped tripping it).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { inArray } from 'drizzle-orm';
import {
  db,
  runAsSystem,
  tenantLlmSettings,
  tenants,
  users,
  usageCounters,
  usageEvents,
  withTenantTx,
} from '../src/db/client';
import { config } from '../src/config';
import { brokerLlmCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import { encryptSecret } from '../src/host/secret-box';

const T_LOCAL = '00000000-0000-4000-8000-0000b0b0f101';
const T_BYO = '00000000-0000-4000-8000-0000b0b0f102';
const U_LOCAL = '00000000-0000-4000-8000-0000b0b0f1a1';
const U_BYO = '00000000-0000-4000-8000-0000b0b0f1a2';
const ROUTER = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
const BYO_MODEL = 'tenant-own-model-7b';

const llm = config.llm as { mode: string; openaiBaseUrl: string };
const agent = config.agent as { model: string };
const was = { mode: llm.mode, base: llm.openaiBaseUrl, model: agent.model };

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(usageEvents).where(inArray(usageEvents.user_id, [U_LOCAL, U_BYO]));
    await db.delete(usageCounters).where(inArray(usageCounters.user_id, [U_LOCAL, U_BYO]));
    await db.delete(users).where(inArray(users.id, [U_LOCAL, U_BYO]));
    await db.delete(tenantLlmSettings).where(inArray(tenantLlmSettings.tenant_id, [T_LOCAL, T_BYO]));
    await db.delete(tenants).where(inArray(tenants.id, [T_LOCAL, T_BYO]));
  });
}

beforeEach(async () => {
  __setBrokerDepsForTests({ limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  llm.mode = 'openai_compatible';
  llm.openaiBaseUrl = ROUTER;
  agent.model = 'local-llm';
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values([
      { id: T_LOCAL, name: 'unpinned local', slug: 'unpinned-local-f101', plan_code: 'local-llm', inference_token_encrypted: encryptSecret('ir-token-f001') },
      { id: T_BYO, name: 'unpinned byo', slug: 'unpinned-byo-f102' },
    ]);
    await db.insert(users).values([
      { id: U_LOCAL, email: 'unpinned-local@test', name: 'L', tenant_id: T_LOCAL },
      { id: U_BYO, email: 'unpinned-byo@test', name: 'B', tenant_id: T_BYO },
    ]);
  });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  llm.mode = was.mode;
  llm.openaiBaseUrl = was.base;
  agent.model = was.model;
  await cleanup();
}, 30_000);

/** Run `fn` with fetch replaced; returns the JSON bodies the "provider" received. */
async function withFetch<T>(reply: () => Response, fn: () => Promise<T>): Promise<{ out: T; bodies: Record<string, unknown>[] }> {
  const realFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return reply();
  }) as typeof fetch;
  try {
    return { out: await fn(), bodies };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const openAiReply = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('a local-llm tenant running a block with NO model resolves to `local-llm` on the router', async () => {
  const { out, bodies } = await withFetch(openAiReply, () =>
    withTenantTx(T_LOCAL, () => brokerLlmCall(U_LOCAL, { prompt: 'ping' })),
  );
  expect(out).toMatchObject({ ok: true });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.model).toBe('local-llm');
}, 30_000);

test('a tenant_byo tenant running a block with NO model gets ITS OWN model on ITS OWN provider', async () => {
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenantLlmSettings).values({
      tenant_id: T_BYO,
      // An OpenAI-compatible endpoint on an in-cluster-looking host keeps this test off the egress
      // policy (models.external_http) while exercising the same tenant_byo path.
      provider: 'openai_compatible',
      base_url: 'http://byo-llm.svc.cluster.local:8081/v1',
      model: BYO_MODEL,
      api_key_encrypted: encryptSecret('sk-TENANT-OWN'),
      credential_source: 'tenant_byo',
    });
  });
  const { out, bodies } = await withFetch(openAiReply, () =>
    withTenantTx(T_BYO, () => brokerLlmCall(U_BYO, { prompt: 'ping' })),
  );
  expect(out).toMatchObject({ ok: true });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.model).toBe(BYO_MODEL);
}, 30_000);

test('the rule did not weaken: a block that still PINS a commercial model on the platform router is refused', async () => {
  const { out, bodies } = await withFetch(openAiReply, () =>
    withTenantTx(T_LOCAL, () => brokerLlmCall(U_LOCAL, { model: 'claude-sonnet-4-6', prompt: 'ping' })),
  );
  expect(out).toMatchObject({ ok: false, rule: 'llm_platform_local_only' });
  expect(bodies).toHaveLength(0); // nothing reached the router
}, 30_000);
