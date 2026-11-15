// src/ai/agent.ts — the TS-native, provider-agnostic agent loop (SPEC §5A). It
// assembles the tool catalogue from the MCP host, calls the broker-selected
// provider (real in prod: LLM_MODE=openai_compatible → in-cluster inference-router;
// per-tenant BYO key, or the deterministic stub as the keyless dev fallback)
// THROUGH the metered broker (brokerChatCall — keys host-side, spend
// capped), and on each turn either streams a final answer or dispatches tool calls:
//   * backend tool  → execute via the MCP host (search_blocks, get_block, …),
//   * frontend tool → emit a `frontend-tool-call` SSE event and AWAIT the browser's
//     POST to /api/agent/chat/:turnId/tool-result (the driver applies the edit live
//     on the canvas through the builder store, then reports the result).
// Bounded by max-iterations + wall-clock. The whole transcript persists to
// chat_messages. Events are emitted through `emit` (the route's SSE writer).
import { and, asc, eq } from 'drizzle-orm';
import { db as defaultDb, chatSessions, chatMessages, withTenantDb, withTenantTx } from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import type { ChatContentBlock } from '../db/schema';
import { config } from '../config';
import { brokerChatStream, BrokerRejection, type BrokerRejectionKind } from '../host/llm-broker';
import { McpHost, mcpHost, type McpAuthContext } from './mcp-server';
import { FRONTEND_TOOL_NAMES } from './mcp/tools';
import { waitForFrontendTool, type ToolResultPayload } from './tool-rendezvous';
import { buildAgentChallengeContext } from '../challenges/challenge-data-service';
import { buildFlowContext } from './flow-context';
import { StreamSanitizer } from './llm/sanitize';
import { log } from '../host/logger';
import type { LlmMessage, LlmToolDef, LlmRole, LlmResult } from './llm/provider';

type Db = typeof defaultDb;

const MAX_ITERATIONS = 8;
const WALL_CLOCK_MS = 60_000;

// ---- SSE event union (the wire protocol to the browser chat) ----
export type AgentEvent =
  | { type: 'turn-start'; turnId: string; sessionId: string }
  | { type: 'assistant-delta'; turnId: string; text: string }
  | { type: 'assistant-message'; turnId: string; text: string }
  | { type: 'tool-call'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool-result'; turnId: string; callId: string; name: string; ok: boolean; output?: unknown }
  | { type: 'frontend-tool-call'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'cost'; turnId: string; costUsd: number; tokensIn: number; tokensOut: number }
  | {
      type: 'turn-end';
      turnId: string;
      status: 'done' | 'error' | 'max_iterations';
      message?: string;
      /**
       * WHY the broker refused, when the turn ended because it did — the same closed union the RUN
       * path already carries (`BrokerRejectionKind`, llm-broker.ts).
       *
       * ⛔ THE FIELD EXISTS BECAUSE `message` CANNOT BE LOCALIZED AND `kind` CAN. The broker's
       * rejection prose is hardcoded English — two sentences naming "Administer → LLM settings"
       * (`BUDGET_EXHAUSTED_MESSAGE`) — and the chat store rendered it raw, so a Dutch reader who hit their
       * workspace's spend cap got an English paragraph. The run path solved this by mapping the
       * `kind` to catalog copy (RunConsole.svelte, BlockResultView.svelte); the chat path threw the
       * `kind` away in the catch below and had nothing to map. This carries it.
       *
       * ⚠️ OPTIONAL, AND IT MUST STAY OPTIONAL. Every non-broker error end (a provider stream
       * failure, `no result from provider`, max-iterations) has no kind, and during a rolling
       * deploy an OLD backend emits this frame without the field at all. The consumer's fallback to
       * `message` is the contract, not a defensive nicety — see agent-chat.svelte.ts.
       */
      kind?: BrokerRejectionKind;
    };

export type EmitFn = (ev: AgentEvent) => void;

// ---- frontend-tool round-trip registry ----
// ⛔ IT MOVED, AND THE MOVE IS THE FIX. This used to be a `Map` in this module's heap, which meant
// the rendezvous only worked when the browser's tool-result POST happened to land on the same pod
// that was holding the promise. It does not, half the time: the POST is a NEW `fetch()`, and the
// Service has 2-4 replicas and no sessionAffinity. `ai/tool-rendezvous.ts` keeps that Map as the
// zero-database FAST path and adds a durable row + NOTIFY for the pod that is not holding it.
// `waitForFrontendTool` and `resolveFrontendTool` keep their exact shapes; the loop below is
// unchanged apart from handing the turn's tenant to the waiter so the cross-pod claim can be
// RLS-scoped without reading an ambient context that a timer callback does not have.
export type { ToolResultPayload } from './tool-rendezvous';
export {
  resolveFrontendTool,
  deliverFrontendToolResult,
  FRONTEND_TOOL_TIMEOUT_MS,
} from './tool-rendezvous';

// ---- chat_messages ⇄ LlmMessage mapping (Anthropic-shape content blocks) ----
function toBlocks(m: LlmMessage): ChatContentBlock[] {
  if (m.role === 'tool') {
    return [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }];
  }
  const blocks: ChatContentBlock[] = [];
  if (m.content) blocks.push({ type: 'text', text: m.content });
  for (const tc of m.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  return blocks;
}

function fromRow(role: LlmRole, blocks: ChatContentBlock[]): LlmMessage {
  if (role === 'tool') {
    const tr = blocks.find((b) => b.type === 'tool_result');
    const content =
      typeof tr?.content === 'string' ? tr.content : JSON.stringify(tr?.content ?? '');
    return { role: 'tool', content, toolCallId: tr?.tool_use_id };
  }
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id!, name: b.name!, input: b.input }));
  return { role, content: text, ...(toolCalls.length ? { toolCalls } : {}) };
}

/**
 * Which earlier turns may be REPLAYED to the model: only those written under the same reply
 * language and the same context format. Bump REPLAY_VERSION whenever what the model is given about
 * the flow changes shape.
 *
 * ⛔ WHY (prod, 2026-10-16, after #465 and #466 were live): "Wat doet deze flow?" kept answering
 * "Read claim form" / `claim_id` although the nl flow context (dumped in-pod) said "Claimformulier
 * lezen". The (user, flow) chat session is permanent, and its FIRST answer, written at 07:10 before
 * #465 with English names, was replayed as history on every later turn. Asked the identical
 * question, the model copied its own earlier answer almost word for word (07:59 and 08:29 answers
 * in chat_messages are near-identical to 07:10). A fresh context cannot win against a verbatim
 * answer in the transcript. Rows without a key (written before this) are never replayed.
 */
export const REPLAY_VERSION = 'ctx2';
export function replayKeyFor(locale: string): string {
  return `${REPLAY_VERSION}:${locale}`;
}

async function persistMessage(
  db: Db,
  sessionId: string,
  m: LlmMessage,
  replayKey: string,
): Promise<void> {
  // Only user/assistant/tool are persisted (the system prompt is fetched separately).
  if (m.role === 'system') return;
  await db.insert(chatMessages).values({
    session_id: sessionId,
    role: m.role,
    content: { blocks: toBlocks(m), replay: replayKey },
  });
}

async function loadHistory(db: Db, sessionId: string, replayKey: string): Promise<LlmMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(asc(chatMessages.created_at));
  // Whole turns share one key, so a tool_use is never replayed without its tool_result.
  return rows
    .filter((r) => r.content.replay === replayKey)
    .map((r) => fromRow(r.role as LlmRole, r.content.blocks ?? []));
}

/** Return the id of a chat session iff it exists and belongs to this user (RLS also
 *  scopes it to the caller's tenant). Used for block-authoring sessions, which have no
 *  flow to key on, so the browser threads the sessionId back across turns for continuity. */
export async function getOwnedChatSession(
  userId: string,
  sessionId: string,
  db: Db = defaultDb,
): Promise<string | null> {
  const [row] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.user_id, userId)));
  return row?.id ?? null;
}

/**
 * Ensure a chat_session exists for (user, flow); returns its id.
 *
 * ⛔ THE LOOKUP MUST FILTER ON BOTH COLUMNS. It used to read `where(eq(flow_id, flowId))` alone —
 * this docstring already said "(user, flow)" and `chat_sessions.user_id` has been NOT NULL since
 * 0008, but the SELECT ignored it, so the FIRST person to chat about a flow owned the only thread
 * that flow would ever have. `routes/flows.ts` `getFlow` serves a published solution's flow
 * read-only to anyone, and the build page renders the copilot with no read-only branch: a second
 * employee typing one sentence was handed the author's session, `loadHistory` replayed the
 * author's whole private conversation into the provider request as THEIR context, and their reply
 * was appended to the author's thread for good. Tenant RLS cannot see this — both people are in
 * the same tenant. `getOwnedChatSession`, ten lines up, always checked the user; this did not.
 *
 * The route now also refuses a `flowId` the caller does not own, so the two doors are independent:
 * this one keeps a future call site from reopening the leak from somewhere else.
 *
 * The INSERT is `ON CONFLICT DO NOTHING` on the 0067 unique index. Two turns from the same user on
 * the same flow arriving together both miss the SELECT above; before 0067 that split one person's
 * transcript across two threads, and after it the loser would 23505. Neither is acceptable, so the
 * loser re-reads the winner instead. A flow-LESS session (block authoring / fix loop, which have no
 * flow to key on) can never conflict — the index is NULLS DISTINCT — and so always inserts.
 */
export async function ensureChatSession(
  userId: string,
  flowId: string | null,
  db: Db = defaultDb,
): Promise<string> {
  const ownedFlowSession = async () => {
    const [row] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.flow_id, flowId!), eq(chatSessions.user_id, userId)));
    return row?.id ?? null;
  };
  if (flowId) {
    const existing = await ownedFlowSession();
    if (existing) return existing;
  }
  const [row] = await db
    .insert(chatSessions)
    .values({ user_id: userId, flow_id: flowId, title: '' })
    .onConflictDoNothing({ target: [chatSessions.user_id, chatSessions.flow_id] })
    .returning({ id: chatSessions.id });
  if (row) return row.id;
  // Lost the race for this (user, flow). Re-read the winner. If it is still invisible, the
  // conflicting row is outside this request's tenant scope — a real inconsistency, not a race, and
  // silently opening a second thread would hide it.
  const won = await ownedFlowSession();
  if (won) return won;
  throw new Error(`chat session for (${userId}, flow ${flowId}) conflicts but is not readable`);
}

// ---- the loop ----

export interface AgentChatArgs {
  userId: string;
  /** The caller's realm roles — authorizes the developer-gated MCP authoring tools. */
  roles?: string[];
  tenantId?: string | null;
  sessionId: string;
  flowId: string | null;
  /** Which copilot persona drives this turn: 'flow' (canvas), 'block' (block authoring),
   *  or 'fix' (block fix-loop). Selects the system prompt; defaults to 'flow'. */
  mode?: 'flow' | 'block' | 'fix';
  /** Phase 3.4: the challenge being worked, threaded so the ontology tools resolve the
   *  (industry × department) cell from its work_area when the agent omits explicit args. */
  challengeId?: string | null;
  userMessage: string;
  model?: string;
  locale?: string;
  emit: EmitFn;
  signal: AbortSignal;
  host?: McpHost;
  db?: Db;
}

/**
 * The entry point for DETACHED turns (the SSE route): establishes the tenant context for the whole
 * turn WITHOUT reserving a request connection, mirroring host/run-controller.ts's pump.
 *
 * The turn runs up to MAX_ITERATIONS provider calls and can await a 30s browser round-trip, so
 * wrapping it in `withTenantDb` pinned one of only `poolMax: 6` request connections for its entire
 * duration — six open AI panels starved every other authenticated request on the pod. `withTenantTx`
 * reserves nothing: the broker's metering is fully transactional (`reserveCall`/`settleSpend` both
 * run in `db.transaction`), so it stays RLS-scoped on the independent transaction pool. Each region
 * of PLAIN statements inside `runAgentChat` takes its own short-lived `withTenantDb` instead.
 */
export async function runAgentChatScoped(args: AgentChatArgs): Promise<void> {
  return withTenantTx(args.tenantId ?? null, () => runAgentChat(args));
}

export async function runAgentChat(args: AgentChatArgs): Promise<void> {
  const db = args.db ?? defaultDb;
  const host = args.host ?? mcpHost;
  const turnId = Bun.randomUUIDv7();
  // Detached route turns pass tenantId explicitly. Direct/in-process callers can instead
  // establish withTenantDb; never fabricate a tenant by treating the user's UUID as one.
  const tenantId = args.tenantId ?? currentDbContext()?.tenantId ?? null;
  const ctx: McpAuthContext = {
    userId: args.userId,
    tenantId,
    roles: args.roles ?? [],
    flowId: args.flowId,
    challengeId: args.challengeId ?? null,
  };
  const model = args.model ?? config.agent.model;
  const replayKey = replayKeyFor(args.locale ?? 'en');
  // Provider settings, policy scope, and usage ledger all use the same effective tenant.
  // Null is allowed only outside a tenant request; settlement can then resolve the user's home.
  const llmTenant = tenantId;
  const startedAt = Date.now();

  args.emit({ type: 'turn-start', turnId, sessionId: args.sessionId });

  // Build the conversation: system prompt + prior turns + this user message. The persona
  // (flow canvas vs block editor) selects which seeded system prompt drives the turn.
  const promptName =
    args.mode === 'block'
      ? 'agent.block_authoring'
      : args.mode === 'fix'
        ? 'agent.block_fix'
        : 'agent.system';
  // The prologue is all PLAIN (non-transaction) statements, so it needs withTenantDb's
  // reserved connection to carry `app.current_tenant` — the surrounding withTenantTx gives
  // plain statements NO GUC and they would silently read 0 rows under the cp_app role. The
  // reservation is held only for this contiguous region and is released before the first
  // provider call, so nothing pins a request connection across the LLM round-trips.
  const { systemText, history, tools } = await withTenantDb(tenantId, async () => {
    const systemPrompt = await host.getSystemPromptText(ctx, args.locale ?? 'en', promptName);
    // Phase 3.1: when a challenge is being worked, append its applicable datasets as a
    // context block so the agent prefers them (composes with 3.4's ontology-cell resolution).
    let systemText = systemPrompt;
    if (args.challengeId) {
      const block = await buildAgentChallengeContext(args.challengeId, db);
      if (block) systemText = `${systemText}\n\n${block}`;
    }
    // The open flow, described, so "what does this flow do?" is answerable with ZERO tool calls.
    // Without it the copilot had no way to read the flow at all (see ai/flow-context.ts).
    const flowMode = (args.mode ?? 'flow') === 'flow';
    if (flowMode) {
      const flowBlock = await buildFlowContext(args.flowId, args.userId, db, args.locale ?? 'en');
      if (flowBlock) systemText = `${systemText}\n\n${flowBlock}`;
    }
    const userMsg: LlmMessage = { role: 'user', content: args.userMessage };
    await persistMessage(db, args.sessionId, userMsg, replayKey);
    const history = await loadHistory(db, args.sessionId, replayKey);

    // The tool catalogue the model sees (backend + frontend + DB tools).
    // `run_flow` stays offered: prod's model reached for it only because it could not read the
    // flow. With the flow in context, the prompt rule ("only when the user asks to run or test")
    // is the gate — a keyword list could never cover every way, in every language, to ask.
    const toolList = await host.listTools(ctx);
    const tools: LlmToolDef[] = toolList.map((t) => ({
      name: t.name,
      description: t.description,
      input: t.inputSchema,
    }));
    return { systemText, history, tools };
  });
  const messages: LlmMessage[] = [{ role: 'system', content: systemText }, ...history];
  // Every READ-ONLY (tool, flow version, input) this turn already executed. A local model that
  // loses the thread repeats itself; re-reading the same unchanged state cannot produce new
  // information, only spend. ⛔ Only reads are deduped, and the key carries `flowVersion`, which
  // every successful mutating tool bumps: validate → connect_nodes → validate MUST re-run, and two
  // identical add_node calls are two real edits.
  const seenCalls = new Set<string>();
  let flowVersion = 0;
  // Why the loop stopped without a final answer; null while it is still working.
  let stopped: 'wall_clock' | 'repeat' | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Two very different reasons to stop, previously reported as one. A user who closed the
    // panel or switched flows aborts `req.signal`, and calling that "wall-clock exceeded"
    // sends an operator hunting a timeout that never happened — and buries the signal that
    // matters, which is how often turns are being cancelled. (The emit is best-effort here:
    // on a client abort the SSE stream is already gone, so nobody receives it. It is kept
    // for the wall-clock case, where the client IS still listening.)
    if (args.signal.aborted) {
      args.emit({ type: 'turn-end', turnId, status: 'error', message: 'cancelled by client' });
      return;
    }
    if (Date.now() - startedAt > WALL_CLOCK_MS) {
      stopped = 'wall_clock';
      break;
    }

    // Consume the metered stream: emit a token-by-token `assistant-delta` per chunk,
    // accumulate, and act on the terminal result exactly as the non-streaming path
    // did. A cap/allowlist reject throws BrokerRejection BEFORE any token streams.
    // NOT wrapped in withTenantDb, deliberately: the broker's metering is transaction-only
    // (reserveCall/settleSpend), so the ambient withTenantTx context scopes it correctly while
    // the provider call — the slowest await in the turn — holds no request connection.
    let result: LlmResult | undefined;
    let costUsd = 0;
    // Per-LLM-response incremental sanitizer: strips leaked reasoning/harmony
    // tokens from live deltas (the turn-end `assistant-message` still carries the
    // fully-sanitized text). One fresh instance per provider stream.
    const sanitizer = new StreamSanitizer();
    try {
      for await (const chunk of brokerChatStream(
        args.userId,
        llmTenant,
        { model, messages, tools },
        { signal: args.signal },
        { correlationId: args.sessionId, stage: 'agent-chat' },
      )) {
        if (chunk.type === 'text') {
          if (chunk.text) {
            const clean = sanitizer.push(chunk.text);
            if (clean) args.emit({ type: 'assistant-delta', turnId, text: clean });
          }
        } else {
          result = chunk.result;
          // What THIS TENANT pays, not the ledger's notional figure: local inference on the
          // platform's own GPU is paid by the platform (see pricing.ts `tenantChargeUsd`).
          costUsd = chunk.tenantCostUsd;
        }
      }
      const tail = sanitizer.flush();
      if (tail) args.emit({ type: 'assistant-delta', turnId, text: tail });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream error';
      // ⛔ `kind` IS THE LOCALIZABLE HALF AND IT USED TO BE DROPPED HERE. `brokerChatStream` throws
      // `BrokerRejection` — a governance refusal, not a crash — carrying a closed 3-member union
      // (llm_capped / model_not_allowed / budget_exhausted) alongside English prose. This catch
      // read only `.message`, so the chat panel rendered the broker's English paragraph verbatim
      // while the RUN path, given the same rejection, rendered catalog copy off the kind.
      //
      // ⚠️ ALL THREE MEMBERS REALLY DO ARRIVE HERE, and that took a second fix: `llm_capped` and
      // `model_not_allowed` come from `reserveCall`, but `budget_exhausted` used to be produced
      // ONLY inside `runMetered` — the non-streaming path — so a provider 402 propagated to this
      // catch as a bare `LlmProviderHttpError` and the browser was handed
      // `openrouter 402: insufficient credit for this request` with no kind at all.
      // `brokerChatStream` now classifies it (llm-broker.ts, `isCreditExhaustion` in its catch);
      // backend `agent-loop.test.ts` asserts the frame end-to-end for all three.
      //
      // `message` is still emitted unchanged: it is the fallback for every OTHER throw on this path
      // (provider stream failure, transport reset), and the browser keeps preferring it whenever
      // `kind` is absent or unrecognised.
      const kind = err instanceof BrokerRejection ? err.kind : undefined;
      args.emit({ type: 'turn-end', turnId, status: 'error', message, ...(kind ? { kind } : {}) });
      return;
    }
    if (!result) {
      args.emit({ type: 'turn-end', turnId, status: 'error', message: 'no result from provider' });
      return;
    }
    args.emit({
      type: 'cost',
      turnId,
      costUsd,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    const { text, toolCalls } = result;

    // No tool calls → final answer. Emit `assistant-message` with the sanitized full
    // text so the streamed bubble is REPLACED by the clean text (reasoning-token
    // stripping needs the whole message; the live deltas are the raw token feed).
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = text ?? '';
      const assistant: LlmMessage = { role: 'assistant', content: finalText };
      messages.push(assistant);
      await withTenantDb(tenantId, () => persistMessage(db, args.sessionId, assistant, replayKey));
      args.emit({ type: 'assistant-message', turnId, text: finalText });
      args.emit({ type: 'turn-end', turnId, status: 'done' });
      return;
    }

    // Record the assistant's tool-call turn, then dispatch each call.
    const assistant: LlmMessage = { role: 'assistant', content: text ?? '', toolCalls };
    messages.push(assistant);
    await withTenantDb(tenantId, () => persistMessage(db, args.sessionId, assistant, replayKey));

    let repeats = 0;
    for (const call of toolCalls) {
      const input = withFlowId(call.input, args.flowId);
      const readOnly = READ_ONLY_TOOLS.has(call.name);
      const signature = readOnly ? `${call.name}@${flowVersion}:${stableJson(input)}` : null;
      let result: ToolResultPayload;
      if (signature && seenCalls.has(signature)) {
        // Not executed again: the answer is already in the transcript above.
        repeats += 1;
        result = { ok: false, error: 'repeated call: this tool already ran with this input; use the result above' };
      } else if (FRONTEND_TOOL_NAMES.has(call.name)) {
        // The browser fulfils this edit live, then POSTs the result back. Register
        // the waiter BEFORE emitting so a fast tool-result can't race the listener.
        const wait = waitForFrontendTool(turnId, call.id, args.userId, tenantId);
        args.emit({ type: 'frontend-tool-call', turnId, callId: call.id, name: call.name, input });
        // DELIBERATELY holds no DB connection: this awaits a browser round-trip of up to
        // FRONTEND_TOOL_TIMEOUT_MS (30s). Reserving across it is exactly the starvation this
        // file was restructured to remove.
        result = await wait;
      } else {
        args.emit({ type: 'tool-call', turnId, callId: call.id, name: call.name, input });
        const out = await withTenantDb(tenantId, () => host.callTool(call.name, input, ctx));
        result = out.isError
          ? { ok: false, error: String((out.result as { error?: string })?.error ?? 'tool error') }
          : { ok: true, output: out.result };
      }
      if (signature) seenCalls.add(signature);
      else if (result.ok) flowVersion += 1; // a mutation landed: every earlier read is stale
      args.emit({
        type: 'tool-result',
        turnId,
        callId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.ok ? result.output : result.error,
      });
      const toolMsg: LlmMessage = {
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result.ok ? (result.output ?? {}) : { error: result.error }),
      };
      messages.push(toolMsg);
      await withTenantDb(tenantId, () => persistMessage(db, args.sessionId, toolMsg, replayKey));
    }
    // Every call this round was a repeat: the model is circling. Stop and answer.
    if (repeats === toolCalls.length) {
      stopped = 'repeat';
      break;
    }
    // loop continues — the provider's next turn sees the tool results.
  }

  // Out of budget (iterations, wall-clock) or circling. ⛔ NEVER END ON A BARE INTERNAL STRING:
  // the reader used to get "reached max iterations" in English, with nothing else, after a minute
  // of waiting. Instead ask the model ONCE more, with NO tools, for the best answer it can give
  // from what it already gathered, and end with status `max_iterations` and no English `message`
  // — the browser maps the status to localized copy (agent-chat.svelte.ts).
  log.info('agent_turn_budget_stop', { turnId, reason: stopped ?? 'iterations', elapsedMs: Date.now() - startedAt });
  if (!args.signal.aborted) {
    const answer = await finalAnswerWithoutTools(args, turnId, llmTenant, model, messages);
    if (answer) {
      const assistant: LlmMessage = { role: 'assistant', content: answer };
      messages.push(assistant);
      await withTenantDb(tenantId, () => persistMessage(db, args.sessionId, assistant, replayKey));
      args.emit({ type: 'assistant-message', turnId, text: answer });
    }
  }
  args.emit({ type: 'turn-end', turnId, status: 'max_iterations' });
}

/**
 * Tools that only READ state (catalogue, templates, datasets, ontology, validation). Only these
 * are deduped. An explicit allowlist, not "everything that isn't a frontend tool": an unknown or
 * new tool is treated as mutating, which errs toward re-running it rather than toward handing the
 * model a stale answer.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'search_blocks',
  'get_block',
  'list_templates',
  'get_template',
  'validate_flow',
  'run_flow',
  'list_datasets',
  'describe_data',
  'get_ontology',
  'map_dataset',
  'explain_relations',
  'lint_block',
]);

/** The instruction for the closing, tool-less call. English is fine: it is read by the model,
 *  and the system prompt already tells it to reply in the user's language. */
const FINALIZE_INSTRUCTION =
  'Stop using tools now. Using only what you already know from this conversation, give the user ' +
  'the best short answer you can to their last question, in their language. If something is ' +
  'still unknown, say so in one sentence.';

/**
 * One metered call with NO tools, so the model must answer in text. Returns the sanitized answer,
 * or null when it produced nothing or failed — the caller then ends with the localized notice
 * alone. Failures here are swallowed on purpose: the turn is already over budget, and a second
 * error frame would replace the notice with a less useful one.
 */
async function finalAnswerWithoutTools(
  args: AgentChatArgs,
  turnId: string,
  tenant: string | null,
  model: string,
  messages: LlmMessage[],
): Promise<string | null> {
  const sanitizer = new StreamSanitizer();
  let text = '';
  try {
    for await (const chunk of brokerChatStream(
      args.userId,
      tenant,
      { model, messages: [...messages, { role: 'user', content: FINALIZE_INSTRUCTION }] },
      { signal: args.signal },
      { correlationId: args.sessionId, stage: 'agent-chat' },
    )) {
      if (chunk.type === 'text') {
        if (chunk.text) {
          const clean = sanitizer.push(chunk.text);
          if (clean) args.emit({ type: 'assistant-delta', turnId, text: clean });
        }
      } else {
        text = chunk.result.text ?? '';
        args.emit({
          type: 'cost',
          turnId,
          costUsd: chunk.tenantCostUsd,
          tokensIn: chunk.result.usage.tokensIn,
          tokensOut: chunk.result.usage.tokensOut,
        });
      }
    }
    const tail = sanitizer.flush();
    if (tail) args.emit({ type: 'assistant-delta', turnId, text: tail });
  } catch {
    return null;
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/** JSON with sorted object keys, so `{a,b}` and `{b,a}` are the same call. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Frontend edit tools need the open flow; the model doesn't pass flowId, so the
 *  loop injects it (headless MCP clients pass it explicitly). */
function withFlowId(input: unknown, flowId: string | null): unknown {
  if (!flowId) return input;
  if (input == null) return { flowId };
  if (typeof input !== 'object') return input;
  // A blank or placeholder value ("", "current", "<flow-id>") is the model saying "this flow",
  // not naming another one. Only a real UUID is kept (its ownership is still checked downstream).
  const given = (input as Record<string, unknown>).flowId;
  if (typeof given === 'string' && UUID_RE.test(given)) return input;
  return { ...(input as Record<string, unknown>), flowId };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
