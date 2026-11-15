// src/lib/stores/agent-chat.svelte.ts — the chat conversation store (SPEC §5A).
// Owns the message list + busy state + accumulated spend, and orchestrates one turn:
// issue an agent token → open the SSE chat stream → render assistant/tool events →
// on a frontend-tool-call, apply the edit via the driver (live on the canvas) and
// POST the result back so the server loop resumes. Reactive ($state) so the panel
// redraws as events arrive.
import { issueAgentToken, streamAgentChat, postToolResult, type ChatControl } from '$lib/api/agent';
import { licenseOrPermissionMessage, writeErrorText } from '$lib/api/error-message';
import type { AgentEvent, ToolResultPayload } from '$lib/types/agent';
import { describeEdit } from '$lib/agent/driver';
import { cursor } from '$lib/agent/cursor.svelte';
import * as m from '$lib/paraglide/messages';
import { llmSettingsPath } from '$lib/i18n/llm-settings-path';

export interface ChatMessage {
	kind: 'user' | 'assistant' | 'tool' | 'error';
	text: string;
}

/** A frontend-tool driver: applies one frontend (edit) tool call and returns the result to
 *  POST back to the loop. The canvas AgentDriver and the block-editor BlockAuthorDriver both
 *  satisfy this structurally, so the store is reusable across copilot personas. */
export interface ChatDriver {
	apply(name: string, input: unknown): Promise<ToolResultPayload>;
}

export interface AgentChatConfig {
	driver: ChatDriver;
	/** The open flow (canvas copilot); null for the block-authoring copilot. */
	getFlowId?: () => string | null;
	/** Phase 3.4: the challenge being worked, so the agent resolves the ontology cell. */
	getChallengeId?: () => string | null;
	/** Copilot persona: 'flow' (canvas, default), 'block' (block authoring), or 'fix' (fix-loop). */
	mode?: 'flow' | 'block' | 'fix';
	/** The opening assistant message(s). Defaults to the canvas intro. */
	intro?: () => ChatMessage[];
	/** Human-readable label for a frontend-tool-call in the activity feed. */
	describe?: (name: string, input: unknown) => string;
}

const CATALOG_TOOLS = new Set(['search_blocks', 'get_block', 'list_templates', 'get_template']);
const CHECK_TOOLS = new Set(['validate_flow', 'run_flow']);

/**
 * The activity line for a backend tool call. ⛔ Prod 2026-10-16: every backend tool was labelled
 * "searched the catalogue", so a flow check read as "doorzocht de catalogus (validate_flow)".
 */
export function toolActivityLabel(name: string): string {
	if (CATALOG_TOOLS.has(name)) return m.chat_tool_searched({ tool: name });
	if (CHECK_TOOLS.has(name)) return m.chat_tool_checked_flow();
	return m.chat_tool_used();
}

function defaultIntro(): ChatMessage[] {
	return [{ kind: 'assistant', text: m.chat_intro() }];
}

/**
 * Localized copy for a metered-broker refusal on the chat path, or `null` for "I do not have copy
 * for this — use whatever the backend said".
 *
 * ⛔ REUSES THE RUN PATH'S THREE `blockresult_errkind_*` KEYS RATHER THAN MINTING `chat_error_kind_*`
 * SIBLINGS, and that is a decision, not laziness. Read the three strings: "The AI call was refused
 * because a spend cap or ceiling was reached…", "The requested AI model isn't on the allow-list…",
 * "The LLM budget for this workspace is used up. Add your own provider key in Administer → LLM
 * settings…". None of them says "block" or "run" — they describe the BROKER's decision, which is
 * the same decision, made by the same code, about the same workspace, whichever surface asked. Three
 * new keys would be 24 new catalog strings (8 locales × 3) whose only distinguishing feature would
 * be that they drift from these when someone edits one set. The `blockresult_` prefix is a naming
 * wart inherited from where the copy first appeared; a rename would touch two components and eight
 * catalogs for zero reader-visible change, and is not this PR's business.
 *
 * ⛔ THE `null` DEFAULT IS THE ROLLING-DEPLOY BRANCH AND MUST NOT BECOME A GENERIC STRING. Two live
 * cases reach it: (a) an OLD backend, mid-roll, emits `turn-end` with no `kind` at all —
 * `maxSurge: 1 / maxUnavailable: 0` guarantees old and new pods serve simultaneously; (b) a FUTURE
 * backend adds a fourth `BrokerRejectionKind` this build has never compiled against. In both the
 * caller falls through to `ev.message`, which is English but true and specific. A localized
 * "something went wrong" here would be a worse answer than the English one it replaced — the same
 * trade `VALIDATION_MESSAGES` makes when it returns `null`.
 */
function brokerRejectionCopy(kind: string | undefined): string | null {
	// An explicit switch, not `m[`blockresult_errkind_${kind}`]`: paraglide tree-shakes on the import
	// graph, so a computed key can resolve to `undefined` in a production bundle even though it works
	// under vitest. RunConsole.svelte's `errorKindLabel` carries the same warning.
	switch (kind) {
		case 'llm_capped':
			return m.blockresult_errkind_llm_capped();
		case 'model_not_allowed':
			return m.blockresult_errkind_model_not_allowed();
		case 'budget_exhausted':
			return m.blockresult_errkind_budget_exhausted({ path: llmSettingsPath() });
		default:
			return null;
	}
}

export class AgentChatStore {
	messages = $state<ChatMessage[]>([]);
	busy = $state(false);
	costUsd = $state(0);
	private readonly driver: ChatDriver;
	private readonly getFlowId: () => string | null;
	private readonly getChallengeId: () => string | null;
	private readonly mode: 'flow' | 'block' | 'fix';
	private readonly describe: (name: string, input: unknown) => string;
	private control: ChatControl | null = null;
	// Index of the assistant bubble currently being streamed (token-by-token), or
	// null when no stream is open. Reset at each turn boundary.
	private streamingIdx: number | null = null;
	// Block-authoring sessions have no flow to key on, so we capture the sessionId from
	// turn-start and thread it back across turns for multi-turn continuity.
	private sessionId: string | null = null;
	// The flow this turn was issued against (canvas copilot only — null for block/fix
	// modes). Captured at send() time and re-checked before applying any
	// frontend-tool-call: if the caller has since switched to a different flow, the
	// event is refused rather than silently mutating the graph now on screen. This is
	// the structural backstop — stop() on switch (see the build page) closes the
	// stream so no further events arrive, but a tool-call already in flight when the
	// switch happens must still be caught here.
	private turnFlowId: string | null = null;

	constructor(config: AgentChatConfig) {
		this.driver = config.driver;
		this.getFlowId = config.getFlowId ?? (() => null);
		this.getChallengeId = config.getChallengeId ?? (() => null);
		this.mode = config.mode ?? 'flow';
		this.describe = config.describe ?? describeEdit;
		this.messages = (config.intro ?? defaultIntro)();
	}

	async send(text: string): Promise<void> {
		const message = text.trim();
		if (this.busy || !message) return;
		this.busy = true;
		this.turnFlowId = this.getFlowId();
		// Belt and braces: a turn always opens its own assistant bubble, so no index may
		// carry over from a previous turn however that turn ended (stop(), onError, a
		// stream that died without turn-end).
		this.streamingIdx = null;
		this.messages = [...this.messages, { kind: 'user', text: message }];

		let token: string;
		try {
			token = await issueAgentToken();
		} catch (e) {
			this.push('error', licenseOrPermissionMessage(e) ?? m.chat_error_session());
			this.busy = false;
			return;
		}

		this.control = streamAgentChat(
			{
				message,
				flowId: this.getFlowId(),
				challengeId: this.getChallengeId(),
				mode: this.mode,
				sessionId: this.sessionId,
				token,
			},
			{
				onEvent: (ev) => void this.onEvent(ev, token),
				// ⛔ `writeErrorText`, NOT `licenseOrPermissionMessage ?? e.message`. That chain answered
				// only 402 / 403 / 409 `seat_limit_reached` and printed the backend's ENGLISH sentence
				// for EVERYTHING else, straight into a chat bubble on `/build` and `/block-edit` — the
				// two surfaces an ordinary author lives on. `writeErrorText` is a strict SUPERSET of what
				// was here: the same `VALIDATION_MESSAGES` lookup the run/submit paths use on 400/422/409,
				// then a fall-through to the same `licenseOrPermissionMessage`. No branch that had copy
				// loses it.
				//
				// ⚠️ `writeErrorText` STILL PREFERS THE ENGLISH SENTENCE WHERE THE CATALOG CANNOT NAME THE
				// OFFENDER — a `naming(...)` entry whose `details.blockSlug` did not arrive returns
				// `null`, and the backend's sentence NAMES the block where a localized one could only
				// say "a block in this flow". ⛔ THAT BRANCH IS DEAD **ON THIS ROUTE** AND MUST NOT BE
				// CITED AS A PROPERTY OF IT. `POST /api/agent/chat` can emit 401 `agent_token_no_tenant`
				// (backend/src/routes/agent.ts:129 — the refusal that replaced the old 400
				// `no_home_tenant` when the workspace moved into the token's `tid` claim), 422
				// `validation`, 404 `flow_not_found`, other 401s from `verifyAgentToken` and 5xx — not
				// one of which interpolates a value, so no `naming(...)` entry is reachable from here.
				// The `agent_token_no_tenant` sentence reaches this bubble through
				// `licenseOrPermissionMessage`'s 401 arm (`AGENT_SESSION_MESSAGES`), NOT through
				// `VALIDATION_MESSAGES`, which `writeErrorText` consults on 400/422/409 only. The trade is real and is
				// pinned where it is LIVE: `api/solutions.create.test.ts`, on `POST /api/solutions`,
				// the only path that throws `block_archived`
				// (backend/src/host/publication-service.ts:64).
				// `agent-chat.refusal-copy.wire.test.ts` pins what this route can actually produce.
				//
				// ⚠️ THE ONE BRANCH THAT SHOWS LESS THAN BEFORE, STATED PLAINLY: a status outside
				// 400/422/409/402/403 no longer renders `e.message`. On this route that is the 404
				// `flow_not_found` — `No flow '<uuid>'`, thrown when the open flow was deleted elsewhere.
				// A raw uuid is nothing an author can act on, and it was the last raw-English string on
				// the surface, so the localized generic is the better read. A specific 404 sentence is a
				// copy decision, not part of this fix.
				onError: (e) => {
					// ⛔ THE BUBBLE IS NOT A RECORD. `writeErrorText` collapses a 500 with no `message` at
					// all, a 401 `Invalid or expired agent token`, a 502 from the keycloak hop and a
					// `TypeError: Failed to fetch` onto ONE sentence — correct for the author, and it
					// leaves this line as the only place that still knows WHICH of them happened.
					// Without it an outage on `/build` and the model declining a turn are the same
					// event to everyone looking at it. Same `[chat] …` idiom as `report()` below.
					console.error('[chat] turn failed', e);
					this.push('error', writeErrorText(e, m.chat_error_generic()));
					this.busy = false;
				},
				onEnd: () => {
					this.busy = false;
				},
			},
		);
	}

	/** Abort the in-flight turn, if any. Truly cancels the request (an AbortController
	 *  wired to the SSE fetch's `signal`, not just local state) so the server sees the
	 *  disconnect and releases the metered quota slot instead of running to completion
	 *  unobserved. Safe to call when idle. */
	stop(): void {
		if (this.control) {
			this.control.close();
			this.control = null;
			this.push('tool', m.chat_error_stopped());
		}
		// Close the streamed bubble as well as the stream. The partial text STAYS on screen
		// (the user chose to stop; erasing what they just watched arrive would be worse than
		// leaving it), but the index must not survive the turn — otherwise the next turn's
		// first delta appends onto this old bubble and its assistant-message then overwrites
		// it, so the new answer lands in the previous turn's bubble. Not dropStreaming():
		// that DELETES the bubble, which is right for a tool-call preamble and wrong here.
		this.streamingIdx = null;
		this.busy = false;
	}

	private async onEvent(ev: AgentEvent, token: string): Promise<void> {
		switch (ev.type) {
			case 'assistant-delta':
				// First delta of a turn → open a new assistant bubble; subsequent deltas
				// append. ($state arrays are deeply reactive, so mutating .text redraws.)
				if (this.streamingIdx === null) {
					this.messages = [...this.messages, { kind: 'assistant', text: ev.text }];
					this.streamingIdx = this.messages.length - 1;
				} else {
					this.messages[this.streamingIdx]!.text += ev.text;
				}
				break;
			case 'tool-call':
				// A streamed preamble that resolved into a tool call isn't shown (parity
				// with the non-streaming path) → drop it before the tool activity line.
				this.dropStreaming();
				this.push('tool', toolActivityLabel(ev.name));
				break;
			case 'turn-start':
				// Capture the session id so block-authoring turns (no flow) stay one thread.
				this.sessionId = ev.sessionId;
				break;
			case 'frontend-tool-call': {
				this.dropStreaming();
				// The caller may have switched flows since this turn started (stop() on
				// switch should already have closed the stream — see the build page's
				// openFlow — but that races with an event already being handled here).
				// Refuse to apply an edit against a flow this turn was never issued for
				// rather than silently writing to whatever graph now happens to be open.
				if (this.getFlowId() !== this.turnFlowId) {
					// Nothing was applied and the turn is being abandoned on purpose, so there is no edit
					// to warn the reader about — but it still must not be SILENT. A refusal that never
					// reaches the loop costs the same 30s stall as a lost result.
					await this.report(ev.turnId, ev.callId, token, {
						ok: false,
						error: 'flow changed; turn cancelled',
					});
					break;
				}
				this.push('tool', this.describe(ev.name, ev.input));
				const result = await this.driver.apply(ev.name, ev.input);
				// ⛔ THE EDIT IS ALREADY ON THE CANVAS BY THE TIME WE GET HERE. If the report does not
				// land, the assistant is told its own tool timed out and the two views of the document
				// diverge — which is exactly the failure that shipped, and it shipped SILENTLY because
				// this call sat inside a bare `catch { /* non-fatal *\/ }`.
				if (!(await this.report(ev.turnId, ev.callId, token, result))) {
					this.push('error', m.chat_tool_result_undelivered());
				}
				break;
			}
			case 'cost':
				this.costUsd += ev.costUsd;
				break;
			case 'assistant-message':
				// The sanitized final text: replace the streamed bubble (so reasoning-token
				// stripping wins over the raw token feed), or push one if nothing streamed.
				if (this.streamingIdx !== null) {
					this.messages[this.streamingIdx]!.text = ev.text;
					this.streamingIdx = null;
				} else {
					this.push('assistant', ev.text);
				}
				break;
			case 'turn-end':
				this.streamingIdx = null;
				// ⛔ THE `kind` WINS OVER `message`, AND ONLY WHEN IT IS ONE WE KNOW. `ev.message` on a
				// broker refusal is the broker's hardcoded English paragraph (llm-broker.ts) — a Dutch
				// reader who hit the workspace spend cap was told, in English, to go to
				// "Administer → LLM settings". `brokerRejectionCopy` is the same code→copy mapping the
				// run path already does (RunConsole.svelte, BlockResultView.svelte) against the same
				// three catalog keys. `??` chains through to `message` for everything else.
				// ⛔ `max_iterations` NEVER RENDERS `message`. It used to carry the loop's internal
				// "reached max iterations" and this line showed it raw, in English, as the whole reply to
				// a Dutch reader's first question (prod, 2026-10-16). The backend now closes the turn with
				// its best partial answer and no message; an OLD backend mid-roll still sends the English
				// string, so the status, not the message, decides.
				if (ev.status === 'max_iterations') this.push('error', m.chat_turn_incomplete());
				else if (ev.status !== 'done')
					this.push('error', brokerRejectionCopy(ev.kind) ?? ev.message ?? m.chat_error_stopped());
				this.busy = false;
				// Tuck the synthetic cursor away once the agent finishes operating.
				setTimeout(() => cursor.hide(), 500);
				break;
			// 'tool-result' needs no UI change here.
		}
	}

	/** Discard the in-progress streamed assistant bubble (a tool-call preamble). */
	private dropStreaming(): void {
		if (this.streamingIdx === null) return;
		const idx = this.streamingIdx;
		this.streamingIdx = null;
		this.messages = this.messages.filter((_, i) => i !== idx);
	}

	private push(kind: ChatMessage['kind'], text: string): void {
		this.messages = [...this.messages, { kind, text }];
	}

	/**
	 * Report one frontend-tool outcome to the loop. `postToolResult` already retries across replicas;
	 * this is the last stop, and its job is to make a total failure LEAVE A TRACE instead of vanishing.
	 * Returns whether the loop was told.
	 *
	 * It does not rethrow: the turn is still running, the SSE stream is still open, and throwing here
	 * would abandon the rest of the event loop over one unreported call. The caller decides whether
	 * the reader needs to see it (an applied edit does; a cancelled turn does not).
	 */
	private async report(
		turnId: string,
		callId: string,
		token: string,
		payload: ToolResultPayload,
	): Promise<boolean> {
		try {
			await postToolResult({ turnId, callId, token, payload });
			return true;
		} catch (err) {
			console.error('[chat] could not report a frontend tool result', { turnId, callId }, err);
			return false;
		}
	}
}
