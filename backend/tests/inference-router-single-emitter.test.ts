// tests/inference-router-single-emitter.test.ts — CP must be the ONLY cost emitter for its LLM calls.
//
// ⛔ WHY THIS IS A TEST AND NOT A COMMENT. CP's default LLM path is the in-cluster inference-router
// (`OPENAI_BASE_URL=http://inference-router…:8150/api`). The router ALSO emits a cost event to
// billing:costs for every call — but only when the caller presents a tenant: with no `X-Tenant-Id` it
// takes its nil-tenant branch (inference-router/src/services/metering.py) and emits NOTHING.
// CP meters every call itself (host/llm-broker.ts → metering_outbox). So the one thing keeping a CP
// call from being billed TWICE is that CP's adapter sends no identity headers to the router — an
// invariant by OMISSION, with no dedup in either repo. Adding `X-Tenant-Id` "for tracing" would
// silently double-bill every call. This test is the guard.
import { test, expect } from 'bun:test';
import { OpenAiProvider } from '../src/ai/llm/adapters/openai';

const FORBIDDEN = ['x-tenant-id', 'x-license-id', 'x-subject-id', 'x-actor-id', 'x-app-id'];

test('the OpenAI-compatible adapter sends NO identity headers to the router — one emitter per call', async () => {
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as never;

  const p = new OpenAiProvider({
    // A licence-shaped token: the adapter refuses a placeholder (`EMPTY`) before any request.
    apiKey: 'tok-licence-shaped-0000000000000000000000000',
    model: 'local-llm',
    baseUrl: 'http://inference-router.inference-router.svc.cluster.local:8150/api',
    fetchImpl,
  });
  await p.chat({ model: 'local-llm', messages: [{ role: 'user', content: 'hi' }] }, {
    signal: AbortSignal.timeout(5_000),
  });

  expect(seen).toHaveLength(1); // positive control: the request was actually observed
  const names = Object.keys(seen[0]!);
  expect(names).toContain('authorization');
  for (const h of FORBIDDEN) expect(names).not.toContain(h);
});
