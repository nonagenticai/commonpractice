// tests/llm-adapters.test.ts — the Anthropic + OpenAI LlmProvider adapters, verified
// offline through an injected fetch (recorded fixtures, zero network). Covers BOTH
// directions: LlmRequest → wire body mapping, and wire response → LlmResult parsing,
// for a tool-use turn and a final-answer turn.
import { test, expect } from 'bun:test';
import { AnthropicProvider } from '../src/ai/llm/adapters/anthropic';
import { OpenAiProvider } from '../src/ai/llm/adapters/openai';
import type { LlmRequest, LlmStreamChunk } from '../src/ai/llm/provider';

const signal = new AbortController().signal;

type DoneChunk = Extract<LlmStreamChunk, { type: 'done' }>;
const isDone = (c: LlmStreamChunk): c is DoneChunk => c.type === 'done';

/** Build a fetchImpl that replays recorded SSE frames as the Response body. Each
 *  frame is a single `data:` line; an extra `[DONE]` is appended for OpenAI.
 *  `resHeaders` lets a case add RESPONSE headers (`x-request-id` / `request-id`) — the transport-id
 *  fallback the adapters read when a body/frame carries no generation id. */
function sseRecorder(frames: string[], status = 200, resHeaders: Record<string, string> = {}) {
  const captured: { url?: string; body?: any } = {};
  const payload = frames.map((f) => `data: ${f}`).join('\n\n') + '\n\n';
  const fetchImpl = async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.body = JSON.parse(init.body as string);
    return new Response(payload, {
      status,
      headers: { 'content-type': 'text/event-stream', ...resHeaders },
    });
  };
  return { captured, fetchImpl };
}

async function drainStream(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const textsOf = (chunks: LlmStreamChunk[]) =>
  chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);

/** A captured outgoing request + a canned JSON response. `resHeaders` adds RESPONSE headers so a
 *  case can exercise the `x-request-id` / `request-id` fallback. */
function recorder(responseJson: unknown, status = 200, resHeaders: Record<string, string> = {}) {
  const captured: { url?: string; init?: RequestInit; body?: any } = {};
  const fetchImpl = async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    captured.body = JSON.parse(init.body as string);
    return new Response(JSON.stringify(responseJson), {
      status,
      headers: { 'content-type': 'application/json', ...resHeaders },
    });
  };
  return { captured, fetchImpl };
}

const REQ: LlmRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'You are a copilot.' },
    { role: 'user', content: 'add a summarize step' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'search_blocks', input: { query: 'sum' } }],
    },
    { role: 'tool', toolCallId: 'c1', content: '{"items":[{"slug":"ai-summarize"}]}' },
  ],
  tools: [
    { name: 'search_blocks', description: 'find blocks', input: { type: 'object' } },
  ],
};

// ---- Anthropic ----

test('anthropic: maps system out, tool_use/tool_result, tools → input_schema', async () => {
  const { captured, fetchImpl } = recorder({
    content: [{ type: 'text', text: 'ignored' }],
    usage: { input_tokens: 11, output_tokens: 4 },
  });
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  await p.chat(REQ, { signal });

  expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
  expect((captured.init!.headers as Record<string, string>)['x-api-key']).toBe('k');
  const body = captured.body;
  expect(body.model).toBe('test-model');
  expect(body.system).toBe('You are a copilot.');
  // system message is NOT in messages[]; first message is the user turn
  expect(body.messages[0]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'add a summarize step' }],
  });
  // assistant tool_use block
  expect(body.messages[1].role).toBe('assistant');
  expect(body.messages[1].content[0]).toEqual({
    type: 'tool_use',
    id: 'c1',
    name: 'search_blocks',
    input: { query: 'sum' },
  });
  // tool result → user message with a tool_result block
  expect(body.messages[2]).toEqual({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        content: '{"items":[{"slug":"ai-summarize"}]}',
      },
    ],
  });
  expect(body.tools[0]).toEqual({
    name: 'search_blocks',
    description: 'find blocks',
    input_schema: { type: 'object' },
  });
});

test('anthropic: parses a tool-use response turn', async () => {
  const { fetchImpl } = recorder({
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'tu1', name: 'add_node', input: { slug: 'ai-summarize' } },
    ],
    usage: { input_tokens: 20, output_tokens: 9 },
  });
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  const out = await p.chat(REQ, { signal });
  expect(out.text).toBe('let me look');
  expect(out.toolCalls).toEqual([
    { id: 'tu1', name: 'add_node', input: { slug: 'ai-summarize' } },
  ]);
  expect(out.usage).toEqual({ tokensIn: 20, tokensOut: 9 });
});

test('anthropic: parses a final-answer turn (no tool calls)', async () => {
  const { fetchImpl } = recorder({
    content: [{ type: 'text', text: 'Done.' }],
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  const out = await p.chat(REQ, { signal });
  expect(out.text).toBe('Done.');
  expect(out.toolCalls).toBeUndefined();
});

test('anthropic: respects baseUrl override + non-2xx throws', async () => {
  const { captured, fetchImpl } = recorder({ error: 'nope' }, 401);
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl, baseUrl: 'https://proxy.test' });
  await expect(p.chat(REQ, { signal })).rejects.toThrow(/anthropic 401/);
  expect(captured.url).toBe('https://proxy.test/v1/messages');
});

// ---- OpenAI / OpenAI-compatible ----

test('openai: maps assistant tool_calls, role:tool result, tools → function defs', async () => {
  const { captured, fetchImpl } = recorder({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  });
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  await p.chat(REQ, { signal });

  expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
  expect((captured.init!.headers as Record<string, string>)['authorization']).toBe(
    'Bearer k',
  );
  const body = captured.body;
  expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a copilot.' });
  expect(body.messages[2]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_blocks', arguments: '{"query":"sum"}' } },
    ],
  });
  expect(body.messages[3]).toEqual({
    role: 'tool',
    tool_call_id: 'c1',
    content: '{"items":[{"slug":"ai-summarize"}]}',
  });
  expect(body.tools[0]).toEqual({
    type: 'function',
    function: { name: 'search_blocks', description: 'find blocks', parameters: { type: 'object' } },
  });
});

test('openai: parses a tool-call response (arguments JSON-decoded)', async () => {
  const { fetchImpl } = recorder({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'add_node', arguments: '{"slug":"ai-summarize"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 14, completion_tokens: 6 },
  });
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  const out = await p.chat(REQ, { signal });
  expect(out.toolCalls).toEqual([
    { id: 't1', name: 'add_node', input: { slug: 'ai-summarize' } },
  ]);
  expect(out.text).toBeUndefined();
  expect(out.usage).toEqual({ tokensIn: 14, tokensOut: 6 });
});

test('openai-compatible: DeepSeek-style baseUrl override hits /chat/completions', async () => {
  const { captured, fetchImpl } = recorder({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl, baseUrl: 'https://api.deepseek.com/v1' });
  const out = await p.chat(REQ, { signal });
  expect(captured.url).toBe('https://api.deepseek.com/v1/chat/completions');
  expect(out.text).toBe('hi');
});

// ---- streaming (stream:true) ----

test('openai stream(): text deltas in order + usage on done; request sets stream + include_usage', async () => {
  const { captured, fetchImpl } = sseRecorder([
    JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
    '[DONE]',
  ]);
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  const chunks = await drainStream(p.stream(REQ, { signal }));
  expect(captured.body.stream).toBe(true);
  expect(captured.body.stream_options).toEqual({ include_usage: true });
  expect(textsOf(chunks)).toEqual(['Hel', 'lo']);
  const done = chunks.find(isDone)!;
  expect(done.text).toBe('Hello');
  expect(done.usage).toEqual({ tokensIn: 12, tokensOut: 7 });
  expect(done.toolCalls).toBeUndefined();
});

test('openai stream(): accumulates tool-call argument fragments → one tool call on done', async () => {
  const { fetchImpl } = sseRecorder([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'add_node', arguments: '{"slug":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ai-summarize"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
    '[DONE]',
  ]);
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  const chunks = await drainStream(p.stream(REQ, { signal }));
  expect(textsOf(chunks)).toEqual([]);
  const done = chunks.find(isDone)!;
  expect(done.toolCalls).toEqual([{ id: 't1', name: 'add_node', input: { slug: 'ai-summarize' } }]);
  expect(done.usage).toEqual({ tokensIn: 5, tokensOut: 3 });
});

test('openai stream(): non-2xx throws', async () => {
  const { fetchImpl } = sseRecorder([], 500);
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  await expect(drainStream(p.stream(REQ, { signal }))).rejects.toThrow(/openai 500/);
});

test('anthropic stream(): text_delta chunks + usage from message_start/message_delta', async () => {
  const { captured, fetchImpl } = sseRecorder([
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    JSON.stringify({ type: 'content_block_stop', index: 0 }),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  const chunks = await drainStream(p.stream(REQ, { signal }));
  expect(captured.body.stream).toBe(true);
  expect(textsOf(chunks)).toEqual(['Hel', 'lo']);
  const done = chunks.find(isDone)!;
  expect(done.text).toBe('Hello');
  expect(done.usage).toEqual({ tokensIn: 11, tokensOut: 4 });
});

// ---- provider_request_id: the VENDOR'S own id for the generation ----
//
// ⛔ WHAT THIS BLOCK EXISTS FOR. `host/metering-emit.ts buildCostEventFields` shipped with
// `provider_request_id: ''` HARD-CODED. Billing stores that field for VENDOR RECONCILIATION — the
// join key when their invoice and CP's ledger disagree — so a column empty on 100% of rows does not
// degrade the workflow, it deletes it, while every schema check stays green. Nothing anywhere could
// have noticed: a constant `''` is exactly what a provider that reports nothing legitimately yields.
//
// ⛔ AND THE PRECEDENCE IS THE LOAD-BEARING PART, NOT THE PLUMBING. Both vendors expose TWO ids and
// they answer different questions: the BODY id names the GENERATION (`chatcmpl-…`/`gen-…`/`msg_…`),
// which is what the vendor's usage records are filed under and what OpenRouter's
// `GET /generation?id=` takes; `x-request-id` / `request-id` names the HTTP ROUND TRIP and is what
// their support desk asks for. Taking the header would fill the column with a value that is present,
// well-formed, and cannot be joined against an invoice — which is worse than empty, because nothing
// downstream can tell it from a correct one. Hence the `…WINS over…` cases below: a test that only
// checked "some id arrived" would pass against the inverted precedence.

test('openai: the response body `id` becomes providerRequestId', async () => {
  const { fetchImpl } = recorder({
    id: 'chatcmpl-abc123',
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  const out = await new OpenAiProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  // ⚠️ MUTATION TARGET: drop `readProviderRequestId` from `parseResponse`'s returned object (or
  // restore the hard-coded '' in buildCostEventFields) and this is undefined — billing's
  // `provider_request_id` goes back to being empty on every row CP has ever emitted.
  expect(out.providerRequestId).toBe('chatcmpl-abc123');
});

test('openai: falls back to the x-request-id header when the body carries no id', async () => {
  // A gateway is entitled to omit the body `id` — the in-cluster inference-router does not promise
  // one. The header is then the only id there is, and SOMETHING beats nothing for reconciliation.
  const { fetchImpl } = recorder(
    { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    200,
    { 'x-request-id': 'req_fallback_1' },
  );
  const out = await new OpenAiProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBe('req_fallback_1');
});

test('⛔ openai: the body id WINS over x-request-id — they are not two spellings of one value', async () => {
  // Non-vacuity for the two cases above: both would pass against INVERTED precedence, which would
  // file every row under a transport id no invoice is keyed on.
  const { fetchImpl } = recorder(
    {
      id: 'gen-openrouter-9',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    },
    200,
    { 'x-request-id': 'req_transport_9' },
  );
  const out = await new OpenAiProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  // ⚠️ MUTATION TARGET: swap the two rungs in `readProviderRequestId` and this reads
  // 'req_transport_9' — present, well-formed, and unjoinable against an OpenRouter generation.
  expect(out.providerRequestId).toBe('gen-openrouter-9');
});

test('openai: a provider exposing NEITHER id leaves the field ABSENT, not empty-string', async () => {
  // ⛔ ABSENT, NOT ''. The spread-don't-assign rule: an explicit `undefined` survives a JSON round
  // trip as a `null` key, and `''` here would reach the cost event indistinguishable from "this
  // provider reports no id" — which is true, but must be decided by metering-emit's `|| ''`, in one
  // place, rather than by every adapter independently choosing a placeholder.
  const { fetchImpl } = recorder({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  const out = await new OpenAiProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBeUndefined();
  expect('providerRequestId' in out).toBe(false);
});

test('openai stream(): the generation id from the FIRST frame reaches the done chunk', async () => {
  // ⚠️ MUTATION TARGET: read `frame.id` unconditionally (`streamId = frame.id`) instead of latching
  // the first non-empty one, and the id-less terminal usage frame erases it — the exact shape a
  // proxy-synthesised final frame takes.
  const { fetchImpl } = sseRecorder([
    JSON.stringify({ id: 'chatcmpl-stream-1', choices: [{ delta: { content: 'Hi' } }] }),
    JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
    '[DONE]',
  ]);
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  const done = (await drainStream(p.stream(REQ, { signal }))).find(isDone)!;
  expect(done.providerRequestId).toBe('chatcmpl-stream-1');
});

test('openai stream(): no frame id → the x-request-id header still carries one', async () => {
  const { fetchImpl } = sseRecorder(
    [
      JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }),
      JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
      '[DONE]',
    ],
    200,
    { 'x-request-id': 'req_stream_hdr' },
  );
  const p = new OpenAiProvider({ apiKey: 'k', fetchImpl });
  const done = (await drainStream(p.stream(REQ, { signal }))).find(isDone)!;
  expect(done.providerRequestId).toBe('req_stream_hdr');
});

test('anthropic: the Message `id` becomes providerRequestId', async () => {
  const { fetchImpl } = recorder({
    id: 'msg_01XYZ',
    content: [{ type: 'text', text: 'Done.' }],
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const out = await new AnthropicProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBe('msg_01XYZ');
});

test('⛔ anthropic: the Message id WINS over the `request-id` header', async () => {
  // Same non-vacuity as the OpenAI pair: `request-id` is Anthropic's SUPPORT id for the HTTP hop,
  // `msg_…` is the generation their usage records are filed under.
  const { fetchImpl } = recorder(
    { id: 'msg_01WINS', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } },
    200,
    { 'request-id': 'req_anthropic_hop' },
  );
  const out = await new AnthropicProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBe('msg_01WINS');
});

test('anthropic: no Message id → the `request-id` header is the fallback', async () => {
  const { fetchImpl } = recorder(
    { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } },
    200,
    { 'request-id': 'req_anthropic_only' },
  );
  const out = await new AnthropicProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBe('req_anthropic_only');
});

test('anthropic stream(): message_start carries the id through to done', async () => {
  // ⚠️ MUTATION TARGET: delete the `messageId` latch in the `message_start` case and this falls back
  // to the header (absent here) → undefined. Anthropic sends the id ONCE, unlike OpenAI which
  // repeats it on every chunk, so reading it off any later frame finds nothing.
  const { fetchImpl } = sseRecorder([
    JSON.stringify({ type: 'message_start', message: { id: 'msg_stream_1', usage: { input_tokens: 11 } } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  const done = (await drainStream(p.stream(REQ, { signal }))).find(isDone)!;
  expect(done.providerRequestId).toBe('msg_stream_1');
  // The id must not disturb what was already pinned on this path.
  expect(done.usage).toEqual({ tokensIn: 11, tokensOut: 2 });
});

test('a blank id is treated as ABSENT, not as a value', async () => {
  // `''` and `'   '` are what a proxy that "populates" the field without knowing one emits. Passing
  // either through would fill billing's column with whitespace that is neither a usable id nor a
  // readable "not reported", so both collapse to undefined at the adapter boundary.
  const { fetchImpl } = recorder(
    { id: '   ', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    200,
    { 'x-request-id': '' },
  );
  const out = await new OpenAiProvider({ apiKey: 'k', fetchImpl }).chat(REQ, { signal });
  expect(out.providerRequestId).toBeUndefined();
});

test('anthropic stream(): input_json_delta fragments accumulate into a tool call', async () => {
  const { fetchImpl } = sseRecorder([
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'add_node' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"slug":' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ai-summarize"}' } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } }),
    JSON.stringify({ type: 'message_stop' }),
  ]);
  const p = new AnthropicProvider({ apiKey: 'k', fetchImpl });
  const chunks = await drainStream(p.stream(REQ, { signal }));
  expect(textsOf(chunks)).toEqual([]);
  const done = chunks.find(isDone)!;
  expect(done.toolCalls).toEqual([{ id: 'tu1', name: 'add_node', input: { slug: 'ai-summarize' } }]);
  expect(done.usage).toEqual({ tokensIn: 20, tokensOut: 9 });
});
