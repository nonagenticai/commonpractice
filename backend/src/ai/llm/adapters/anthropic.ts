// src/ai/llm/adapters/anthropic.ts — the Anthropic Messages API adapter behind the
// normalized LlmProvider interface (SPEC §5A Layer 1). Maps our chat-shaped
// LlmRequest (system/user/assistant/tool messages + tool defs) onto the Messages
// API (top-level `system`, content-block messages with tool_use / tool_result) and
// parses the response back into LlmResult (text + toolCalls + usage).
//
// Hand-rolled fetch (no vendor SDK dep) with an injectable transport seam so tests
// feed recorded fixtures with zero network. The provider key is passed in at
// construction by the broker (host-side only); it never reaches this module's callers.
import type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamChunk,
  LlmMessage,
  LlmToolCall,
} from '../provider';
import { sseData } from './sse';

/** The subset of `fetch` we use — injectable so tests stub the network. */
export type FetchImpl = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface AnthropicAdapterOpts {
  apiKey: string;
  /** Default model when a request omits one (the broker normally sets req.model). */
  model?: string;
  /** Override the API base (e.g. a proxy); defaults to api.anthropic.com. */
  baseUrl?: string;
  /** Extra body params merged into every request (tenant_llm_settings.params). */
  params?: Record<string, unknown>;
  /** Test seam: inject a fake fetch. Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  apiVersion?: string;
}

/** Exported so `provider-catalog.ts adapterIdentityFor` fills in the same default this adapter
 *  actually calls — a null base_url must not read as "a different vendor from api.anthropic.com". */
export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

// ---- Anthropic wire types (only the fields we read) ----
type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };
interface AnthropicResponse {
  /** The Message id (`msg_…`) — Anthropic's own id for this generation. See
   *  `readProviderRequestId`. */
  id?: string;
  content: AnthropicContent[];
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * The provider's own id for this call, for billing's `provider_request_id` (vendor reconciliation).
 *
 * ⛔ THE MESSAGE `id` FIRST, THE `request-id` HEADER SECOND — the same precedence, for the same
 * reason, as `adapters/openai.ts readProviderRequestId`. `msg_…` names the GENERATION, which is what
 * Anthropic's usage records are filed under; `request-id` names the HTTP round trip and is the id
 * their support desk asks for. Both are real, they answer different questions, and only the first
 * can be joined against a line on an invoice. Filling the column with the header would be a value
 * that is present, well-formed and unjoinable — indistinguishable downstream from a correct one.
 *
 * ⚠️ The header fallback is NOT decoration here: on the STREAMING path the message id arrives on
 * `message_start`, and a stream that dies before that event has no body id at all while the response
 * headers were read long before the first frame. That is the one case where the header is the only
 * thing there is.
 *
 * Trimmed, and `''` collapses to `undefined`: an empty string would reach the cost event as
 * `provider_request_id: ''`, which reads as "this provider exposes no id" — a false negative.
 */
function readProviderRequestId(
  bodyId: string | undefined,
  headers: Headers | undefined,
): string | undefined {
  const fromBody = bodyId?.trim();
  if (fromBody) return fromBody;
  const fromHeader = headers?.get('request-id')?.trim();
  return fromHeader || undefined;
}

interface AnthropicMsg {
  role: 'user' | 'assistant';
  content: unknown[];
}

// ---- streaming wire types (Messages API `stream:true`; every event carries `type`) ----
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  /** `message_start` carries the whole Message envelope, including its `id` (`msg_…`). */
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { output_tokens?: number };
}

/** Map our messages to Anthropic's. System messages are lifted out (returned
 *  separately). Tool results become `tool_result` blocks on a user message.
 *  Consecutive same-role messages are merged (Anthropic wants alternating roles). */
function mapMessages(messages: LlmMessage[]): {
  system: string;
  msgs: AnthropicMsg[];
} {
  const systemParts: string[] = [];
  const msgs: AnthropicMsg[] = [];

  const push = (role: 'user' | 'assistant', blocks: unknown[]): void => {
    if (blocks.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
        },
      ]);
      continue;
    }
    if (m.role === 'user') {
      push('user', m.content ? [{ type: 'text', text: m.content }] : []);
      continue;
    }
    // assistant: text (optional) + tool_use blocks
    const blocks: unknown[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    push('assistant', blocks);
  }

  return { system: systemParts.join('\n\n'), msgs };
}

function parseResponse(json: AnthropicResponse, headers?: Headers): LlmResult {
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  const text = textParts.join('');
  const requestId = readProviderRequestId(json.id, headers);
  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    // Spread, not assign — absent must stay absent rather than becoming an explicit `undefined`.
    ...(requestId ? { providerRequestId: requestId } : {}),
    usage: {
      tokensIn: json.usage?.input_tokens ?? 0,
      tokensOut: json.usage?.output_tokens ?? 0,
    },
  };
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly opts: AnthropicAdapterOpts) {}

  private endpoint(): { url: string; headers: Record<string, string>; fetchImpl: FetchImpl } {
    if (!this.opts.apiKey) throw new Error('anthropic: missing api key');
    const fetchImpl = this.opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
    const base = (this.opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
    return {
      url: `${base}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': this.opts.apiVersion ?? DEFAULT_VERSION,
      },
      fetchImpl,
    };
  }

  private buildBody(req: LlmRequest): Record<string, unknown> {
    const { system, msgs } = mapMessages(req.messages);
    const body: Record<string, unknown> = {
      ...this.opts.params,
      model: req.model || this.opts.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: msgs,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input,
      }));
    }
    return body;
  }

  // POST the request, retrying ONCE without `temperature` if the API rejects it. The newest
  // Anthropic models (e.g. claude-opus-4-8) dropped the `temperature` parameter and 400 on it;
  // since temperature is a tenant setting (and the platform default is 0.1, merged via params),
  // we strip it and retry rather than failing the tenant's chat. Returns the final Response; the
  // caller still checks `.ok`. `temperature` may arrive via req.temperature OR opts.params.
  private async send(req: LlmRequest, signal: AbortSignal, stream: boolean): Promise<Response> {
    const { url, headers, fetchImpl } = this.endpoint();
    const body = this.buildBody(req);
    if (stream) body.stream = true;
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (res.ok || res.status !== 400 || body.temperature === undefined) return res;
    const errText = await res.text();
    if (!errText.includes('temperature')) throw new Error(`anthropic ${res.status}: ${errText}`);
    delete body.temperature;
    return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }

  async chat(req: LlmRequest, { signal }: { signal: AbortSignal }): Promise<LlmResult> {
    const res = await this.send(req, signal, false);
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    return parseResponse((await res.json()) as AnthropicResponse, res.headers);
  }

  // Streaming: POST with stream:true. Parse content_block_delta(text_delta) → text
  // chunks; content_block_start(tool_use) + input_json_delta → accumulated tool calls;
  // message_start carries input_tokens, message_delta carries output_tokens.
  async *stream(req: LlmRequest, { signal }: { signal: AbortSignal }): AsyncIterable<LlmStreamChunk> {
    const res = await this.send(req, signal, true);
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

    const textParts: string[] = [];
    const toolAcc = new Map<number, { id?: string; name?: string; json: string }>();
    // The Message id arrives ONCE, on `message_start`, and never again — unlike OpenAI, which
    // repeats it on every chunk. So it must be latched here rather than read off the final frame.
    let messageId: string | undefined;
    let usage = { tokensIn: 0, tokensOut: 0 };

    for await (const data of sseData(res)) {
      let ev: AnthropicStreamEvent;
      try {
        ev = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          usage.tokensIn = ev.message?.usage?.input_tokens ?? usage.tokensIn;
          if (!messageId && ev.message?.id) messageId = ev.message.id;
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
            toolAcc.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
          }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            textParts.push(ev.delta.text);
            yield { type: 'text', text: ev.delta.text };
          } else if (ev.delta?.type === 'input_json_delta' && ev.index !== undefined) {
            const slot = toolAcc.get(ev.index) ?? { json: '' };
            slot.json += ev.delta.partial_json ?? '';
            toolAcc.set(ev.index, slot);
          }
          break;
        case 'message_delta':
          usage.tokensOut = ev.usage?.output_tokens ?? usage.tokensOut;
          break;
        default:
          break;
      }
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s], i) => {
        let input: unknown = {};
        try {
          input = s.json ? JSON.parse(s.json) : {};
        } catch {
          input = { _raw: s.json };
        }
        return { id: s.id ?? `call_${i}`, name: s.name ?? '', input };
      });
    const text = textParts.join('');
    const requestId = readProviderRequestId(messageId, res.headers);
    yield {
      type: 'done',
      usage,
      ...(text ? { text } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
    };
  }
}
