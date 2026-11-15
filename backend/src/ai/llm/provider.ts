// src/ai/llm/provider.ts — the normalized, provider-agnostic LLM boundary
// (SPEC §5A Layer 1). The agent loop depends ONLY on this interface; thin adapters
// translate to each vendor. Customer companies pick any provider via
// tenant_llm_settings — the interface is the stable contract, vendors are not.
//
// This is chat-shaped (messages[] + tools[] + tool-call results), which the runner's
// single-prompt `LlmRequestPayload` (db/trace-types.ts) cannot express — hence a
// SEPARATE boundary. Both still meter through host/llm-broker.ts so spend is capped
// and provider keys stay host-side (D1 of the plan).
//
// This session ships only the deterministic StubProvider (stub-provider.ts). Session
// 7 adds adapters/anthropic.ts + adapters/openai.ts behind this same interface.
import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

/** A JSON Schema object (derived from Zod for tool inputs). */
export type JsonSchema = Record<string, unknown>;

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  /**
   * What the provider says it CHARGED for this generation, in USD — when it says so at all.
   *
   * Only OpenRouter reports this today (its `usage.cost`, always present on both the chat and the
   * final streaming frame). The five direct providers publish no per-call cost and no pricing API,
   * so this stays undefined for them and the broker falls back to the `models.pricing` table.
   *
   * Undefined means "not reported", which is NOT the same as zero — a real zero (a `:free` model)
   * is reported as 0 and must be preserved. Never coalesce this with `?? 0`.
   */
  costUsd?: number;
}

/** A model's request to invoke a tool. `id` correlates the later tool result. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One conversation message. An assistant turn may carry `toolCalls`; a `tool`
 *  message answers a specific call via `toolCallId`. `content` is the text part. */
export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  input: JsonSchema;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Optional structured-output schema (enforced by the adapter where available). */
  responseSchema?: JsonSchema;
}

/** A provider turn: either text (final answer), tool calls, or both. */
export interface LlmResult {
  text?: string;
  toolCalls?: LlmToolCall[];
  usage: TokenUsage;
  /**
   * What the gateway ACTUALLY served, when it says so (the in-cluster inference-router reports
   * `served_model` / `served_provider` on every response). Absent for a plain OpenAI-compatible
   * provider, which only echoes the requested model.
   *
   * Load-bearing for the ledger: the router does NOT 404 an unknown model — it returns 200 and
   * substitutes. Asking for `claude-sonnet-4-6` yields `served_model: local-llm`, and pricing the
   * REQUESTED id charged a tenant Claude rates (3/15 per Mtok) for free local inference. That
   * phantom spend also ate the weekly ceiling that gates service. The broker prices on this field
   * when present, so attribution follows reality instead of intent.
   */
  servedModel?: string;
  servedProvider?: string;
  /**
   * THE PROVIDER'S OWN ID FOR THIS GENERATION — what billing stores as `provider_request_id` and
   * reconciles against the vendor's invoice when CP's numbers and the vendor's disagree.
   *
   * ⛔ IT IS NOT A CORRELATION ID AND MUST NEVER BE SYNTHESISED. `correlationId` is OUR id for OUR
   * operation; this is the VENDOR'S id for the vendor's work, and its entire value is that we did
   * not choose it. A generated uuid here would look identical on the wire, satisfy every schema, and
   * be useless in the one conversation it exists for ("your invoice says X, our ledger says Y —
   * which call was it?"). So: the provider's value, or ABSENT. Never a placeholder.
   *
   * ⚠️ ABSENT IS A REAL AND CORRECT STATE. `stub-provider.ts`, the deterministic `mockProvider` and
   * the raw `anthropicProvider` in host/llm-broker.ts expose nothing, and nothing should be invented
   * for them — `host/metering-emit.ts` sends `''`, which billing parses as "not reported", exactly
   * like the absent `license_id` one field along.
   */
  providerRequestId?: string;
}

/** A streamed provider turn (SPEC §5A — token-by-token chat). v1 streams TEXT
 *  deltas; tool calls are accumulated by the adapter and surfaced on `done`
 *  (the agent still dispatches them exactly as in the non-streaming path). The
 *  `done` chunk carries the authoritative full text + accumulated tool calls +
 *  provider-counted usage, so the broker can meter the real spend post-stream. */
export type LlmStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: LlmToolCall }
  | {
      type: 'done';
      usage: TokenUsage;
      text?: string;
      toolCalls?: LlmToolCall[];
      /** See `LlmResult.providerRequestId`. On a stream the id arrives on an EARLY frame (OpenAI
       *  repeats it on every chunk, Anthropic puts it on `message_start`) but is surfaced here, on
       *  the terminal frame, because that is the one frame the broker settles from. */
      providerRequestId?: string;
    };

export interface LlmProviderCallOpts {
  signal: AbortSignal;
}

export interface LlmProvider {
  chat(req: LlmRequest, opts: LlmProviderCallOpts): Promise<LlmResult>;
  /** Optional token-by-token streaming. When absent, the broker falls back to
   *  chat() and emits a single text delta = the full result text. */
  stream?(req: LlmRequest, opts: LlmProviderCallOpts): AsyncIterable<LlmStreamChunk>;
}

// ---- Zod validators (used at the boundary so the loop stays type-safe regardless
// of vendor; tool inputs are validated before dispatch in the MCP layer) ----

export const llmToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const llmResultSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(llmToolCallSchema).optional(),
  usage: z.object({
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number().optional(),
  }),
});

/** Rough token estimate (chars/4) — used by the stub so the broker meter records
 *  genuine, non-zero spend. Real adapters report provider-counted usage in S7. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
