// src/ai/llm/stub-provider.ts — the deterministic stub LlmProvider (SPEC §5A
// "Stub-first"). NO real model is called. It returns a fixed three-step script that
// exercises the ENTIRE substrate path end-to-end:
//   turn 1 (user msg)            → tool_call search_blocks(query)   [backend tool]
//   turn 2 (search result back)  → tool_call add_node(slug, pos)    [frontend tool]
//   turn 3 (add_node result back)→ final answer text
// This proves: the agent loop, MCP tools/call, the frontend-tool round-trip
// (frontend-tool-call SSE → /tool-result → resume), transcript persistence, broker
// metering, and audit — all without a provider. Session 7 swaps this for real
// adapters behind the same LlmProvider interface; nothing else moves.
import type {
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamChunk,
  LlmMessage,
} from './provider';
import { estimateTokens } from './provider';

/** Split text into n roughly-equal chunks so the stub streams ≥2 deltas. */
function chunkText(text: string, n = 3): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return '';
}

/** The most recent tool-result message content (a JSON string from an MCP tool). */
function lastToolContent(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'tool') return messages[i]!.content;
  }
  return '';
}

/** Pick a block slug from a search_blocks result; fall back to a known seed block. */
function pickSlug(searchResultJson: string): string {
  try {
    const parsed = JSON.parse(searchResultJson) as {
      items?: { slug?: string }[];
    };
    const slug = parsed.items?.[0]?.slug;
    if (typeof slug === 'string' && slug.length > 0) return slug;
  } catch {
    /* fall through */
  }
  return 'ai-summarize';
}

function usageFor(messages: LlmMessage[], out: string): LlmResult['usage'] {
  const inText = messages.map((m) => m.content).join('\n');
  return { tokensIn: estimateTokens(inText), tokensOut: estimateTokens(out) };
}

export class StubProvider implements LlmProvider {
  async chat(req: LlmRequest): Promise<LlmResult> {
    const toolResults = req.messages.filter((m) => m.role === 'tool').length;

    // Step 1 — no tool results yet → search the catalogue.
    if (toolResults === 0) {
      const query = lastUserText(req.messages).slice(0, 80) || 'summarize';
      const input = { query };
      return {
        toolCalls: [{ id: 'call_search_1', name: 'search_blocks', input }],
        usage: usageFor(req.messages, JSON.stringify(input)),
      };
    }

    // Step 2 — one tool result (the search) → drop a node on the canvas.
    if (toolResults === 1) {
      const slug = pickSlug(lastToolContent(req.messages));
      const input = { slug, position: { x: 360, y: 200 } };
      return {
        toolCalls: [{ id: 'call_add_1', name: 'add_node', input }],
        usage: usageFor(req.messages, JSON.stringify(input)),
      };
    }

    // Step 3 — the add_node result is back → final answer.
    const text =
      'Done — I searched the block catalogue and added a block to your flow on ' +
      'the canvas. (No language model is configured for this workspace, so I used ' +
      'a built-in offline assistant. Add a provider key in LLM settings for full ' +
      'reasoning.)';
    return { text, usage: usageFor(req.messages, text) };
  }

  // Streaming variant of chat(): yields the same deterministic script, but the
  // final-answer text arrives in 2–3 text chunks then a `done`. Tool-call steps
  // yield no text and surface the call(s) on `done` — keeping the keyless dev path
  // + the broker/agent streaming tests on a deterministic stream.
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const result = await this.chat(req);
    if (result.text) {
      for (const part of chunkText(result.text)) yield { type: 'text', text: part };
    }
    yield {
      type: 'done',
      usage: result.usage,
      ...(result.text ? { text: result.text } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  }
}

export const stubProvider = new StubProvider();
