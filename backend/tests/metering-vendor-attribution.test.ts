// tests/metering-vendor-attribution.test.ts — the VENDOR a fleet cost event is attributed to.
//
// ⛔ THE DEFECT THIS FILE PINS. billing-service prices a cost event on `(provider, model,
// service_key)`. `host/llm-broker.ts` resolved the real vendor on every metered path
// (`ResolvedChat.presetKey`, derived by `presetKeyFor(kind, base_url)`) and used it for PRICING —
// and then handed `providerKind` to `emitCostEvent` instead. `providerKind` is the DB enum, and
// `ai/llm/select.ts:47-49` says in terms that it "collapses OpenRouter, DeepSeek, xAI, Cohere and
// the in-cluster local router all into `openai_compatible`". So every external OpenRouter turn CP
// ever emits would arrive on `billing:costs` labelled `openai_compatible` — a string no
// `provider_pricing` row is keyed on, i.e. refused or booked at $0. The catalog's own comment on the
// `xai` preset records this exact class of mis-key having already "left every claude cost_event at
// cost_usd=NULL" once.
//
// ⚠️ WHY THESE TESTS DRIVE A REAL ADAPTER INSTEAD OF INJECTING ONE. `__setBrokerDepsForTests({
// chatProvider })` makes both broker entry points SKIP `resolveChatProvider` — so `presetKey` is
// undefined and `providerKind` is the literal `'stub'`. A test built that way cannot tell the fixed
// code from the broken code, because the two strings it is meant to distinguish are both absent.
// The vendor only exists once a tenant row has actually been resolved, so that is what is set up
// here: a `tenant_llm_settings` row with a BYO key pointed at OpenRouter, the governed egress gate
// opened for that one host, and `globalThis.fetch` stubbed with a recorded vendor response. The
// discriminator is then sharp: `openrouter` (the vendor) vs `openai_compatible` (the adapter kind).
//
// ⚠️ Ids are unique to this file — see tests/fixture-id-collisions.test.ts. One database, files run
// sequentially, and every file tears its own fixtures down.
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  tenantLlmSettings,
  usageCounters,
  withTenantDb,
} from '../src/db/client';
import { encryptSecret } from '../src/host/secret-box';
import { OPENROUTER_BASE_URL, OPENROUTER_HOST } from '../src/ai/llm/provider-catalog';
import {
  __setMeteringOverridesForTests,
  SERVICE_KEY,
  COST_SOURCE,
  type RedisSender,
} from '../src/host/metering-emit';
import { drainMeteringOutbox } from '../src/host/metering-outbox-drainer';
import {
  brokerChatCall,
  brokerChatStream,
  __setBrokerDepsForTests,
  type ChatStreamChunk,
} from '../src/host/llm-broker';
import { __setSnapshotOverrideForTests, getSnapshot } from '../src/host/policy-store';
import { __setEgressHooksForTests } from '../src/host/egress-guard';

const TENANT_ID = '00000000-0000-4000-8000-0000000cf001';
const USER_ID = '00000000-0000-4000-8000-0000000cf002';
const MODEL = 'z-ai/glm-5.2';

/** The token counts the stubbed vendor reports. Deliberately not round numbers a fallback
 *  estimator could coincidentally produce: `estimateTokens` is chars/4 of the request, so 137/59
 *  cannot be arrived at by accident and proves the counts came from the RESPONSE. */
const VENDOR_TOKENS_IN = 137;
const VENDOR_TOKENS_OUT = 59;
const VENDOR_COST_USD = 0.0042;

/** A recording fake Redis sender. */
function recorder(): { sender: RedisSender; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  return { calls, sender: async (command, args) => (calls.push({ command, args }), 'fake-id') };
}

/** Parse the flat [k1,v1,…] tail of an XADD args array back into a dict. */
function fieldsFromXadd(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 5; i < args.length; i += 2) out[args[i]!] = args[i + 1]!;
  return out;
}

/** Open the governed egress gate for openrouter.ai ONLY, and give it a public-looking A record.
 *  Without both, `governedLlmFetch` throws before the adapter ever reaches the stubbed fetch and
 *  the assertion below would pass for the wrong reason (nothing emitted at all). */
async function allowOpenRouterEgress(): Promise<void> {
  __setSnapshotOverrideForTests(undefined);
  const base = await getSnapshot();
  __setSnapshotOverrideForTests({
    ...base,
    externalHttp: true,
    egressAllowlist: [OPENROUTER_HOST],
  });
  __setEgressHooksForTests({ lookup: async () => ['203.0.113.10'] });
}

/** Stub `globalThis.fetch` with `body`, run `fn`, restore. Returns the URLs that were requested,
 *  so a test can prove the call really went to the vendor rather than nowhere. */
async function withVendorFetch<T>(
  body: () => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    return body();
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A non-streaming OpenAI-shaped completion carrying OpenRouter's usage + cost accounting. */
const nonStreamingResponse = (): Response =>
  new Response(
    JSON.stringify({
      model: MODEL,
      choices: [{ message: { content: 'brokered answer' } }],
      usage: {
        prompt_tokens: VENDOR_TOKENS_IN,
        completion_tokens: VENDOR_TOKENS_OUT,
        cost: VENDOR_COST_USD,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** The same call as an SSE stream: two text deltas, then the terminal frame that carries usage.
 *  This is the shape `stream_options.include_usage` produces and the ONLY place a streamed call's
 *  token counts ever appear — which is why the streaming path has to be asserted separately. */
const streamingResponse = (): Response =>
  new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'brokered ' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: VENDOR_TOKENS_IN,
          completion_tokens: VENDOR_TOKENS_OUT,
          cost: VENDOR_COST_USD,
        },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function cleanup() {
  await db.execute(sql`DELETE FROM usage_events WHERE user_id = ${USER_ID}`);
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, [USER_ID]));
  await db.delete(users).where(inArray(users.id, [USER_ID]));
  await db.delete(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause (see license-provisioning.test.ts).
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db.insert(tenants).values({ id: TENANT_ID, name: 'Vendor Attribution Co', slug: 'vendor-attr-test' });
  await db.insert(users).values({
    id: USER_ID,
    email: 'vendor-attr@test',
    name: 'Vendor Attr',
    tenant_id: TENANT_ID,
  });
  // The tenant row that makes `presetKeyFor('openai_compatible', OPENROUTER_BASE_URL)` resolve to
  // the `openrouter` preset. A BYO key (not the env fallback) so the adapter is selected on the
  // tenant's own credential and `envKeyFor`'s identity gate is not in the picture.
  //
  // ⛔ `credential_source` IS DECLARED EXPLICITLY SINCE MIGRATION 0091, AND IT IS NOT DECORATION —
  // it is what makes `usage_extra.byo === true` below true. This fixture used to rely on
  // `select.ts` INFERRING BYO from `api_key_encrypted` being non-null, and that inference is the
  // defect 0091 removed: `host/budget-service.ts` stores the PLATFORM's own welcome-budget key in
  // this same column, so key-presence billed a BYO markup on platform-funded spend. An OpenRouter
  // base_url plus a stored key is EXACTLY the shape of a welcome-budget row — this fixture is
  // indistinguishable from one without the declaration, which is the whole point.
  await db.insert(tenantLlmSettings).values({
    tenant_id: TENANT_ID,
    provider: 'openai_compatible',
    model: MODEL,
    base_url: OPENROUTER_BASE_URL,
    api_key_encrypted: encryptSecret('sk-or-test-attribution'),
    credential_source: 'tenant_byo',
  });
  await allowOpenRouterEgress();
}, 30_000);

afterEach(() => {
  __setMeteringOverridesForTests(undefined);
  __setBrokerDepsForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
  __setEgressHooksForTests(undefined);
});

afterAll(async () => {
  __setMeteringOverridesForTests(undefined);
  __setBrokerDepsForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
  __setEgressHooksForTests(undefined);
  await cleanup();
}, 30_000);

/** Governance wide enough that nothing under test is refused for a cap reason. No `models.allowlist`
 *  → every model is permitted, exactly as `reserveCall` reads an absent list. */
const wideLimits = () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 });

test('a NON-STREAMING external call emits ONE cost event attributed to the real vendor', async () => {
  __setBrokerDepsForTests({ limits: wideLimits });
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  const { result, urls } = await withVendorFetch(nonStreamingResponse, () =>
    withTenantDb(TENANT_ID, () =>
      brokerChatCall(
        USER_ID,
        TENANT_ID,
        { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
        { signal: AbortSignal.timeout(10_000) },
        { correlationId: 'flow-run-vendor-1', stage: 'flow-run' },
      ),
    ),
  );

  // POSITIVE CONTROL FIRST. Without this, an emit that never happened and an emit with the wrong
  // provider are the same empty `r.calls`, and every assertion below would be vacuous.
  expect(urls).toEqual([`${OPENROUTER_BASE_URL}/chat/completions`]);
  expect(result.ok).toBe(true);
  // ⛔ NOTHING IS SENT BY THE CALL ITSELF ANY MORE. The broker ENQUEUES in its ledger transaction
  // (migration 0090); the drainer delivers. A send here would be the old fire-and-forget path back.
  expect(r.calls).toHaveLength(0);
  await drainMeteringOutbox();
  const mine = r.calls.filter((c) => fieldsFromXadd(c.args).correlation_id === 'flow-run-vendor-1');
  expect(mine).toHaveLength(1);

  const f = fieldsFromXadd(mine[0]!.args);
  // ⛔ THE ASSERTION. `openai_compatible` — the adapter kind, and what this field carried before the
  // fix — is a string billing cannot price. `openrouter` is the vendor the SAME call was already
  // priced from locally.
  expect(f.provider).toBe('openrouter');
  expect(f.provider).not.toBe('openai_compatible');
  expect(f.model).toBe(MODEL);
  expect(f.served_model).toBe(MODEL);
  // From the VENDOR's `usage` object, not from `estimateTokens`.
  expect(f.input_tokens).toBe(String(VENDOR_TOKENS_IN));
  expect(f.output_tokens).toBe(String(VENDOR_TOKENS_OUT));
  expect(f.tenant_id).toBe(TENANT_ID);
  // ⛔ NOT `USER_ID`. `subject_id` is the licences-service Subject that PAYS; this member holds no
  // entitlement, so it is EMPTY — never CP's own user id, which is what made every central row
  // `unlicensed`. The attributed case is its own test below.
  expect(f.subject_id).toBe('');
  expect(f.subject_id).not.toBe(USER_ID);
  expect(f.correlation_id).toBe('flow-run-vendor-1');
  expect(f.stage).toBe('flow-run');
  expect(f.service_key).toBe(SERVICE_KEY);
  expect(f.cost_source).toBe(COST_SOURCE);
  expect(f.license_id).toBe('');
  // Billing derives app_id from the licence; CP sends it empty on purpose.
  expect(f.app_id).toBe('');
  // The tenant's OWN key → BYO, so billing charges only the markup on it.
  expect(JSON.parse(f.usage_extra!)).toEqual({ byo: true });
  // Idempotency key = the ledger row's id.
  const [ledger] = (await db.execute(
    sql`SELECT id FROM usage_events WHERE user_id = ${USER_ID} AND correlation_id = 'flow-run-vendor-1'`,
  )) as unknown as { id: string }[];
  expect(f.event_key).toBe(ledger!.id);
});

test('a STREAMED external call emits the vendor too, with the terminal frame\'s token counts', async () => {
  // ⚠️ THE PATH `ai/agent.ts` ACTUALLY USES. `brokerChatStream` is the only broker entry point the
  // agent/chat surface calls, and it is where the wrong label was passed — so a fix asserted only on
  // the non-streaming path would leave the majority of CP's LLM traffic mis-attributed while
  // reporting the hole closed.
  __setBrokerDepsForTests({ limits: wideLimits });
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  const { result: chunks, urls } = await withVendorFetch(streamingResponse, () =>
    withTenantDb(TENANT_ID, () =>
      drain(
        brokerChatStream(
          USER_ID,
          TENANT_ID,
          { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
          { signal: AbortSignal.timeout(10_000) },
          { correlationId: 'agent-sess-vendor-1', stage: 'agent-chat' },
        ),
      ),
    ),
  );

  expect(urls).toEqual([`${OPENROUTER_BASE_URL}/chat/completions`]);
  const done = chunks.find((c) => c.type === 'done');
  expect(done).toBeDefined();
  expect(r.calls).toHaveLength(0);
  await drainMeteringOutbox();
  const mine = r.calls.filter((c) => fieldsFromXadd(c.args).correlation_id === 'agent-sess-vendor-1');
  expect(mine).toHaveLength(1);

  const f = fieldsFromXadd(mine[0]!.args);
  expect(f.provider).toBe('openrouter');
  expect(f.model).toBe(MODEL);
  // A streamed completion reports usage ONLY on the terminal frame. These two numbers are the proof
  // the streaming path is metered from the vendor's own accounting and not from an estimate.
  expect(f.input_tokens).toBe(String(VENDOR_TOKENS_IN));
  expect(f.output_tokens).toBe(String(VENDOR_TOKENS_OUT));
  expect(f.stage).toBe('agent-chat');
  expect(f.tenant_id).toBe(TENANT_ID);
});

test('a metering failure does NOT fail the non-streaming LLM call, and the local ledger stands', async () => {
  // The existing coverage for this is on the STREAMING path only (tests/metering-emit.test.ts).
  // The non-streaming settle is wrapped differently — `runMetered` guards `settleSpend` and returns
  // the paid-for answer anyway — so it is a separate failure direction and needs its own assertion.
  __setBrokerDepsForTests({ limits: wideLimits });
  __setMeteringOverridesForTests({
    enabled: true,
    sender: async () => {
      throw new Error('redis down mid-call');
    },
  });

  const { result } = await withVendorFetch(nonStreamingResponse, () =>
    withTenantDb(TENANT_ID, () =>
      brokerChatCall(
        USER_ID,
        TENANT_ID,
        { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
        { signal: AbortSignal.timeout(10_000) },
        { correlationId: 'flow-run-vendor-2', stage: 'flow-run' },
      ),
    ),
  );

  // The caller still got the answer the money already bought.
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.result.text).toBe('brokered answer');

  // And the AUTHORITATIVE local ledger row exists, with the vendor's own token counts.
  const rows = (await db.execute(
    sql`SELECT provider, model, tokens_in, tokens_out FROM usage_events WHERE user_id = ${USER_ID}`,
  )) as unknown as { provider: string; model: string; tokens_in: number; tokens_out: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tokens_in).toBe(VENDOR_TOKENS_IN);
  expect(rows[0]!.tokens_out).toBe(VENDOR_TOKENS_OUT);
  // ⛔ THE LEDGER COLUMN IS DELIBERATELY UNCHANGED. `usage_events.provider` is the coarse axis four
  // aggregates in host/usage-metrics.ts group by; the vendor was added for the BUS event only, so a
  // fix to fleet attribution cannot silently move a local dashboard's dimension.
  expect(rows[0]!.provider).toBe('openai_compatible');
});
