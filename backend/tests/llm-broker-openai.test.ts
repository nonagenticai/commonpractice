// tests/llm-broker-openai.test.ts — the runner's openai-compatible ctx.llm()
// provider (LLM_MODE=openai_compatible). In prod this brokers block-level LLM calls
// to the in-cluster inference-router. Verified offline through a stubbed global fetch
// (zero network): the missing-key guard, the single-prompt → chat-message mapping,
// the <base>/chat/completions URL (the inference-router /api path), and result mapping.
import { test, expect, afterEach } from 'bun:test';
import { openaiCompatibleProviderWithKey } from '../src/host/llm-broker';
import { config } from '../src/config';
import { __setSnapshotOverrideForTests, getSnapshot } from '../src/host/policy-store';
import { __setEgressHooksForTests } from '../src/host/egress-guard';

// config is `as const` (type-only readonly) and not frozen; mutate via a cast so the
// provider's call-time reads see test values, and restore after each test.
const llm = config.llm as unknown as { openaiBaseUrl: string };
const origBase = llm.openaiBaseUrl;
const origFetch = globalThis.fetch;

afterEach(() => {
  llm.openaiBaseUrl = origBase;
  globalThis.fetch = origFetch;
  __setSnapshotOverrideForTests(undefined);
  __setEgressHooksForTests(undefined);
});

/**
 * Let this EXTERNAL base URL past the governed egress gate.
 *
 * ⛔ WHY THIS IS SUDDENLY NEEDED. `openaiCompatibleProvider` now builds its adapter with
 * `fetchImpl: governedLlmFetch()` — before, it fell through to bare `fetch`, which is precisely the
 * defect: a block's `ctx.llm()` reached whatever OPENAI_BASE_URL named with `models.external_http`
 * off and no allowlist check. `router.test` is not an in-cluster name, so it is now judged. The
 * base URL is deliberately NOT changed to an in-cluster one to dodge the gate: keeping it external
 * and allowlisting it is what proves the gate is TRANSPARENT when the policy permits, which is the
 * half a refusal test cannot show. DNS is pinned through the seam so the SSRF check stays offline.
 */
async function permitEgress(host: string): Promise<void> {
  __setSnapshotOverrideForTests(undefined);
  const live = await getSnapshot();
  __setEgressHooksForTests({ lookup: async () => ['203.0.113.10'] });
  __setSnapshotOverrideForTests({ ...live, externalHttp: true, egressAllowlist: [host] });
}

test('the router provider refuses with no router configured (OPENAI_BASE_URL unset)', async () => {
  llm.openaiBaseUrl = '';
  await expect(
    openaiCompatibleProviderWithKey('ir-token')({ model: 'local-llm', prompt: 'hi' }),
  ).rejects.toThrow(/OPENAI_BASE_URL/);
});

test('the router provider refuses with no router credential', async () => {
  llm.openaiBaseUrl = 'https://router.test/api';
  await expect(
    openaiCompatibleProviderWithKey('')({ model: 'local-llm', prompt: 'hi' }),
  ).rejects.toThrow(/inference-router credential/);
});

test('openaiCompatibleProvider maps a single prompt → chat and back, hitting <base>/chat/completions', async () => {
  llm.openaiBaseUrl = 'https://router.test/api';
  await permitEgress('router.test');
  const captured: { url?: string; body?: Record<string, unknown> } = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'real summary' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const out = await openaiCompatibleProviderWithKey('ir-tenant-token')({
    model: 'claude-sonnet-4-6',
    prompt: 'summarize this',
    maxTokens: 128,
  });

  expect(out).toEqual({ text: 'real summary', tokensIn: 11, tokensOut: 4 });
  // the inference-router OpenAI-compatible path is <base>/chat/completions
  expect(captured.url).toBe('https://router.test/api/chat/completions');
  expect(captured.body!.model).toBe('claude-sonnet-4-6');
  expect(captured.body!.messages).toEqual([
    { role: 'user', content: 'summarize this' },
  ]);
  expect(captured.body!.max_tokens).toBe(128);
});
