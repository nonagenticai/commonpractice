// src/ai/llm/adapters/openai.ts — the OpenAI Chat Completions + function-calling
// adapter behind the normalized LlmProvider interface (SPEC §5A Layer 1). DeepSeek
// and most providers are OpenAI-compatible, so the same adapter covers them via a
// `baseUrl` override (provider enum `openai` | `openai_compatible`).
//
// Maps our chat-shaped LlmRequest onto Chat Completions messages (tool_calls on the
// assistant turn, role:'tool' + tool_call_id for results) and parses the response
// back into LlmResult. Hand-rolled fetch with an injectable transport seam (tests
// feed recorded fixtures, zero network). Key passed in host-side at construction.
import { isInferenceRouterBase, isSentinelCredential } from '../sentinel';
import type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamChunk,
  LlmMessage,
  LlmToolCall,
} from '../provider';
import type { FetchImpl } from './anthropic';
import { stripReasoningTokens } from '../sanitize';
import { sseData } from './sse';

export interface OpenAiAdapterOpts {
  apiKey: string;
  model?: string;
  /** Base URL incl. version path, e.g. https://api.openai.com/v1 or
   *  https://api.deepseek.com/v1. The adapter appends /chat/completions. */
  baseUrl?: string;
  params?: Record<string, unknown>;
  fetchImpl?: FetchImpl;
}

/** Exported so `provider-catalog.ts adapterIdentityFor` fills in the same default this adapter
 *  actually calls — a null base_url must not read as "a different vendor from api.openai.com". */
export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

// ---- OpenAI wire types (only the fields we read) ----
interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}
/**
 * The `usage` object, including OpenRouter's cost accounting.
 *
 * OpenRouter returns `cost` (the amount actually charged to the account, in credits — which are
 * dollar-denominated 1:1) on EVERY response. It used to be gated behind a `usage: {include: true}`
 * request field; that field and `stream_options: {include_usage: true}` are now deprecated no-ops
 * and full usage detail is always included. So this adapter reads the field opportunistically and
 * sends NOTHING extra on the wire — which matters, because the same adapter serves OpenAI,
 * DeepSeek, xAI and Cohere, and an unrecognised body field is a 400 on several of them. Reading a
 * field that may be absent is free; writing one that may be rejected is not.
 *
 * `cost_details.upstream_inference_cost` is the upstream provider's own charge (BYOK only) and is
 * deliberately ignored — `cost` is what the tenant is actually billed.
 */
interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  /** OpenRouter only. Absent on the five direct providers. */
  cost?: number;
}

interface OpenAiResponse {
  choices: {
    message: { content: string | null; tool_calls?: OpenAiToolCall[] };
  }[];
  /**
   * The vendor's own id for this generation (`chatcmpl-…` on OpenAI, `gen-…` on OpenRouter).
   * Present on every OpenAI-compatible chat response — see `readProviderRequestId`.
   */
  id?: string;
  usage?: OpenAiUsage;
  /**
   * Non-standard, emitted by the in-cluster inference-router: what it actually routed to, as
   * opposed to `model`, which merely echoes the request. Read opportunistically — absent on the
   * five direct providers — and never sent on the wire. See `LlmResult.servedModel`.
   */
  served_model?: string;
  served_provider?: string;
}

/**
 * The provider's own id for this call, for billing's `provider_request_id` (vendor reconciliation).
 *
 * ⛔ BODY `id` FIRST, `x-request-id` ONLY AS A FALLBACK, AND THE ORDER IS THE WHOLE POINT. They are
 * not two spellings of one value:
 *   • the BODY `id` is the GENERATION id — `chatcmpl-…` on OpenAI, `gen-…` on OpenRouter. It is the
 *     key the vendor's own usage/billing records are filed under, and on OpenRouter it is the exact
 *     argument to `GET /api/v1/generation?id=…`, the endpoint that answers "what did you charge for
 *     this call". It is what reconciliation actually needs.
 *   • `x-request-id` is the TRANSPORT/support id for the HTTP round trip. It identifies the request
 *     to the vendor's support desk, not the generation to their ledger, and a retried or
 *     proxy-rewritten hop can change it while the generation stays the same.
 * Preferring the header would therefore fill the column with a value that is present, well-formed,
 * and cannot be joined against an invoice — the worst shape of wrong, because nothing downstream can
 * tell it from the right one. The header is kept solely so a gateway that omits the body `id`
 * (the in-cluster inference-router is entitled to) still yields SOMETHING rather than nothing.
 *
 * ⚠️ Trimmed, and an empty string collapses to `undefined`: `''` here would travel to
 * `buildCostEventFields` and land as `provider_request_id: ''`, which is indistinguishable from
 * "this provider exposes no id" — a false negative that is cheaper to prevent than to diagnose.
 */
function readProviderRequestId(
  bodyId: string | undefined,
  headers: Headers | undefined,
): string | undefined {
  const fromBody = bodyId?.trim();
  if (fromBody) return fromBody;
  const fromHeader = headers?.get('x-request-id')?.trim();
  return fromHeader || undefined;
}

/** Lift a provider-reported cost, preserving a legitimate 0 and rejecting anything unusable. */
function reportedCost(usage: OpenAiUsage | null | undefined): number | undefined {
  const cost = usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// ---- streaming wire types (Chat Completions `stream:true`) ----
interface OpenAiStreamToolDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAiStreamFrame {
  /** Repeated on EVERY chunk of a stream and identical throughout — the generation id. The adapter
   *  keeps the FIRST non-empty one it sees (see `stream`). */
  id?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: OpenAiStreamToolDelta[] } }[];
  usage?: OpenAiUsage | null;
}

function mapMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments:
              typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function parseResponse(json: OpenAiResponse, headers?: Headers): LlmResult {
  const msg = json.choices?.[0]?.message;
  const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
    let input: unknown = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, input };
  });
  const text = stripReasoningTokens(msg?.content ?? '');
  const requestId = readProviderRequestId(json.id, headers);
  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    // Same spread-don't-assign rule as `servedModel` below: absent must stay ABSENT so an explicit
    // `undefined` never reaches the ledger as a key that survives JSON round-trips as `null`.
    ...(requestId ? { providerRequestId: requestId } : {}),
    // Spread, not assign: absent must stay absent so the broker keeps the requested model as the
    // attribution when the provider says nothing about what it served.
    ...(json.served_model ? { servedModel: json.served_model } : {}),
    ...(json.served_provider ? { servedProvider: json.served_provider } : {}),
    usage: {
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      // Spread rather than assign: an ABSENT cost must stay absent (the broker then prices from
      // the table), while a reported 0 must survive as 0 (a free model really did cost nothing).
      ...(reportedCost(json.usage) !== undefined ? { costUsd: reportedCost(json.usage) } : {}),
    },
  };
}

/**
 * A non-2xx from the provider, carrying the STATUS so callers can classify it.
 *
 * The broker needs to tell "you are out of credit" apart from "the model is down": a tenant whose
 * welcome budget is spent must get an actionable message pointing at LLM settings, not a generic
 * run failure. Previously every provider error was an untyped `Error` with the status only in the
 * message text.
 */
export class LlmProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    provider = 'openai',
  ) {
    super(`${provider} ${status}: ${bodyText}`);
    this.name = 'LlmProviderHttpError';
  }
}

export class OpenAiProvider implements LlmProvider {
  constructor(private readonly opts: OpenAiAdapterOpts) {}

  private endpoint(): { url: string; headers: Record<string, string>; fetchImpl: FetchImpl } {
    if (!this.opts.apiKey) throw new Error('openai: missing api key');
    // ⛔ NEVER A PLACEHOLDER BEARER TO THE ROUTER. `EMPTY` / `none` / `internal` are what a keyless
    // OpenAI SDK sends; the in-cluster inference-router (INTROSPECT_MODE=enforce) refuses them (401), and
    // before enforcement they made every call unattributable. Every router-bound call carries a real
    // licence token (services/tenant-inference.ts `routerCredential`); anything else is a bug, so it
    // is refused HERE, at the one place the Authorization header is built, before any request. A
    // tenant's OWN endpoint that accepts any key is not the router and is left alone (sentinel.ts).
    if (isSentinelCredential(this.opts.apiKey) && isInferenceRouterBase(this.opts.baseUrl ?? OPENAI_DEFAULT_BASE)) {
      throw new Error('openai: refusing to send a placeholder credential (EMPTY/none/internal) — no request was made');
    }
    const fetchImpl = this.opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
    const base = (this.opts.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
    return {
      url: `${base}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
      fetchImpl,
    };
  }

  private buildBody(req: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...this.opts.params,
      model: req.model || this.opts.model,
      messages: mapMessages(req.messages),
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input },
      }));
    }
    return body;
  }

  async chat(req: LlmRequest, { signal }: { signal: AbortSignal }): Promise<LlmResult> {
    const { url, headers, fetchImpl } = this.endpoint();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.buildBody(req)),
      signal,
    });
    if (!res.ok) throw new LlmProviderHttpError(res.status, await res.text());
    return parseResponse((await res.json()) as OpenAiResponse, res.headers);
  }

  // Streaming: POST with stream:true + stream_options.include_usage so the final
  // frame carries token usage. Yields text deltas as they arrive; tool-call argument
  // fragments are accumulated by index and surfaced (with the assembled text) on done.
  async *stream(req: LlmRequest, { signal }: { signal: AbortSignal }): AsyncIterable<LlmStreamChunk> {
    const { url, headers, fetchImpl } = this.endpoint();
    const body = this.buildBody(req);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new LlmProviderHttpError(res.status, await res.text());

    const textParts: string[] = [];
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    // ⚠️ THE FIRST FRAME'S id WINS, NOT THE LAST. Every chunk of one stream repeats the same
    // generation id, so first-vs-last is normally a distinction without a difference — but the
    // TERMINAL usage frame is the one most likely to be synthesised by a proxy (OpenRouter's usage
    // frame, the inference-router's rollup), and a synthesised frame can carry no `id` at all.
    // Latching the first non-empty value means a stream that dies after its first chunk still
    // reports the id the vendor will bill under, and a stripped final frame cannot erase it.
    let streamId: string | undefined;
    let usage: { tokensIn: number; tokensOut: number; costUsd?: number } = {
      tokensIn: 0,
      tokensOut: 0,
    };

    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      let frame: OpenAiStreamFrame;
      try {
        frame = JSON.parse(data) as OpenAiStreamFrame;
      } catch {
        continue;
      }
      if (!streamId && frame.id) streamId = frame.id;
      if (frame.usage) {
        // OpenRouter puts cost on the LAST SSE message alongside the token counts, so the same
        // frame that settles usage settles the money. Same absent-vs-zero care as the chat path.
        const cost = reportedCost(frame.usage);
        usage = {
          tokensIn: frame.usage.prompt_tokens ?? 0,
          tokensOut: frame.usage.completion_tokens ?? 0,
          ...(cost !== undefined ? { costUsd: cost } : {}),
        };
      }
      const delta = frame.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        textParts.push(delta.content);
        yield { type: 'text', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = toolAcc.get(tc.index) ?? { args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        toolAcc.set(tc.index, slot);
      }
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s], i) => {
        let input: unknown = {};
        try {
          input = s.args ? JSON.parse(s.args) : {};
        } catch {
          input = { _raw: s.args };
        }
        return { id: s.id ?? `call_${i}`, name: s.name ?? '', input };
      });
    const text = stripReasoningTokens(textParts.join(''));
    const requestId = readProviderRequestId(streamId, res.headers);
    yield {
      type: 'done',
      usage,
      ...(text ? { text } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
    };
  }
}
