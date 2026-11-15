// src/lib/api/agent.ts — the agent client. The chat + tool-result endpoints
// authenticate with a short-lived AGENT token (the two-token model), minted from
// the Keycloak login via /api/agent/session/issue (which authFetch authorizes with
// the Keycloak Bearer). We issue a fresh agent token per chat turn (simplest; the
// refresh flow exists server-side for longer sessions). The chat is a POST SSE
// stream, so we reuse the run-stream's `parseBlock` framing parser.
import { authFetch } from './auth-fetch';
import { getLocale } from '$lib/paraglide/runtime';
import { detailsFrom } from './parse';
import { parseBlock } from '$lib/services/sse';
import type { AgentEvent, ToolResultPayload } from '$lib/types/agent';

export class AgentApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** Backend error code (e.g. `license_required`) when the response carried a JSON body. */
		readonly code?: string,
		/**
		 * ⛔ THE SAME GAP `ApiError` (./blocks) HAD, IN THE ONE CLIENT THAT DOES NOT SHARE ITS `unwrap`.
		 * `writeErrorText` duck-types on `status`/`code`/`message`/`details` — it never checks the
		 * class — so a copilot refusal reaches the SAME localized catalog as every other client error,
		 * and reached it with an empty bag for the same reason: the value was on the wire, the catalog
		 * asked for it, and the class in between had nowhere to put it. Read the block on ./blocks.
		 */
		readonly details?: Record<string, unknown>,
	) {
		super(message);
	}
}

/**
 * This client's own placeholder for "the response carried NO `message`", in the ONE shape the
 * browser already knows how to discard.
 *
 * ⛔ THE STRING ITSELF STAYS ENGLISH AND STAYS NON-EMPTY — `AgentApiError.message` is the
 * machine-readable half (console traces, the `throw` out of `postToolResult`, `writeErrorText`'s own
 * fall-through logic), and localizing or blanking it would break readers that are not a browser.
 * What changed is its SHAPE. `error-message.ts`'s `isUselessMessage` already recognises exactly one
 * family of client-synthesised placeholder — `parse.ts`'s `nonJsonErrorMessage`, matched on
 * `/^HTTP \d{3}\b/` — and hands the reader the caller's localized fallback instead. agent.ts was the
 * one client in this directory whose placeholder had a bespoke shape (`chat failed (400)`), so it
 * sailed through that guard and landed in a chat bubble on `/build` in all eight locales. This is the
 * house split (`i18n/graph-issue-label.ts`): the English/machine string stays on the wire byte-for-
 * byte, and the browser owns the words — here by REUSING the existing recogniser rather than adding
 * a second heuristic or a ninth catalog key.
 *
 * ⚠️ NOT `nonJsonErrorMessage` ITSELF: that one needs the response BODY TEXT, and `readErrorBody`
 * has already consumed a `clone()` as JSON. The status line is the whole of what it would emit for
 * an empty body anyway; `op` is appended so a log still says which endpoint answered.
 */
function noMessageOnWire(op: string, res: Response): string {
	return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} (${op} failed)`;
}

/** Best-effort read of the backend `{ error, message, details }` body so license/permission codes
 *  (Gate-2 402, role 403) and the localized catalog's interpolation values survive to the UI.
 *  Never throws — a non-JSON body yields undefined.
 *
 *  ⚠️ `details` USED TO BE DISCARDED HERE RATHER THAN UPSTREAM, and the CAST is what hid it: the body
 *  was read whole and then narrowed to `{ error?, message? }`, so nothing on the type ever admitted
 *  a third field existed. The bag was always available — it was destructured away one line later. */
async function readErrorBody(
	res: Response,
): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
	try {
		const body = (await res.clone().json()) as unknown;
		return {
			code: (body as { error?: string } | null)?.error,
			message: (body as { message?: string } | null)?.message,
			details: detailsFrom(body),
		};
	} catch {
		return {};
	}
}

/** Exchange the Keycloak login for a short-lived agent access token. */
export async function issueAgentToken(): Promise<string> {
	const res = await authFetch('/api/agent/session/issue', { method: 'POST' });
	if (!res.ok) {
		const { code, message, details } = await readErrorBody(res);
		throw new AgentApiError(
			res.status,
			message ?? noMessageOnWire('agent session issue', res),
			code,
			details,
		);
	}
	const body = (await res.json()) as { accessToken: string };
	return body.accessToken;
}

export interface ChatHandlers {
	onEvent: (ev: AgentEvent) => void;
	onError?: (err: unknown) => void;
	onEnd?: () => void;
}

export interface ChatControl {
	close: () => void;
}

/** Open the SSE chat stream for one user message. `token` is the agent access token. */
export function streamAgentChat(
	args: {
		message: string;
		flowId: string | null;
		challengeId?: string | null;
		/** Copilot persona: 'flow' (canvas), 'block' (block authoring), or 'fix' (fix-loop). */
		mode?: 'flow' | 'block' | 'fix';
		/** Block-authoring continuity: the session to resume (no flow to key on). */
		sessionId?: string | null;
		token: string;
	},
	handlers: ChatHandlers,
): ChatControl {
	const ac = new AbortController();
	let closed = false;

	(async () => {
		try {
			const res = await fetch('/api/agent/chat', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${args.token}`,
					'content-type': 'application/json',
					Accept: 'text/event-stream',
				},
				body: JSON.stringify({
						message: args.message,
						...(args.flowId ? { flowId: args.flowId } : {}),
						...(args.challengeId ? { challengeId: args.challengeId } : {}),
						...(args.mode ? { mode: args.mode } : {}),
						...(args.sessionId ? { sessionId: args.sessionId } : {}),
						// ⛔ The UI locale, explicitly. This is a raw `fetch` (SSE), not `authFetch`, so
						// it never carried authFetch's UI-locale Accept-Language; the backend fell back
						// to the BROWSER's header and a Dutch UI on an English browser got an English
						// copilot (prod 2026-10-16, after #465).
						locale: getLocale(),
					}),
				signal: ac.signal,
			});
			if (!res.ok || !res.body) {
				const { code, message, details } = await readErrorBody(res);
				handlers.onError?.(
					new AgentApiError(res.status, message ?? noMessageOnWire('chat', res), code, details),
				);
				return;
			}
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buf = '';
			let ended = false;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += value;
				let idx: number;
				while ((idx = buf.indexOf('\n\n')) >= 0) {
					const raw = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					const block = parseBlock(raw);
					if (!block) continue;
					if (block.event === 'end') {
						ended = true;
						break;
					}
					if (block.data) {
						try {
							handlers.onEvent(JSON.parse(block.data) as AgentEvent);
						} catch {
							/* ignore a malformed frame */
						}
					}
				}
				if (ended) break;
			}
			if (!closed) handlers.onEnd?.();
		} catch (err) {
			if (!closed && !ac.signal.aborted) handlers.onError?.(err);
		}
	})();

	return {
		close() {
			closed = true;
			ac.abort();
		},
	};
}

/**
 * How many times a tool-result report is attempted in total, and the pause before each retry.
 *
 * ⛔ THE RETRY IS NOT DEFENSIVE PADDING — IT IS THE ROLLING-DEPLOY HALF OF THE CROSS-REPLICA FIX.
 * This POST is a NEW `fetch()`, not the SSE connection, and the Service has 2-4 replicas with no
 * sessionAffinity, so each attempt is an INDEPENDENT draw across the pods. A backend that has been
 * upgraded accepts the report wherever it lands (it queues the result for the owning pod); an OLD
 * pod mid-roll still answers 400 `no_pending_tool`, and for that window a second draw is the only
 * thing that can find the owner before the turn's 30s timeout. Three attempts inside ~1.2s is well
 * inside that budget.
 *
 * Retrying cannot double-apply anything: the report is idempotent end to end — the server delivers
 * out of a Map it deletes from before resolving, and the durable fallback is a
 * `PRIMARY KEY (turn_id, call_id)` row written `ON CONFLICT DO NOTHING`.
 */
const TOOL_RESULT_ATTEMPTS = 3;
const TOOL_RESULT_RETRY_MS = [300, 900];

/**
 * Report a fulfilled frontend (edit) tool call so the server loop can resume.
 *
 * Throws `AgentApiError` once every attempt has failed. ⛔ THE CALLER MUST NOT SWALLOW IT. It used
 * to be called inside a bare `catch { /* non-fatal *\/ }`, which is how the live defect stayed
 * invisible: the browser applied the edit to the canvas, the report 400'd on the wrong replica, and
 * the ONLY trace anywhere was a 30-second pause followed by the model being told its own tool had
 * timed out. Nothing was logged in the pod (the route returned a clean 4xx), nothing was shown to
 * the user, and the edit silently diverged from what the assistant believed it had done.
 */
export async function postToolResult(args: {
	turnId: string;
	callId: string;
	token: string;
	payload: ToolResultPayload;
}): Promise<void> {
	let last: unknown;
	for (let attempt = 0; attempt < TOOL_RESULT_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const wait = TOOL_RESULT_RETRY_MS[attempt - 1] ?? 900;
			await new Promise((r) => setTimeout(r, wait));
		}
		try {
			const res = await fetch(`/api/agent/chat/${encodeURIComponent(args.turnId)}/tool-result`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${args.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ callId: args.callId, ...args.payload }),
			});
			if (res.ok) return;
			const { code, message, details } = await readErrorBody(res);
			last = new AgentApiError(
				res.status,
				message ?? noMessageOnWire('tool-result', res),
				code,
				details,
			);
			// 401/403 are about the TOKEN, not about which pod answered: another draw cannot help and
			// would only delay the turn's own timeout. Everything else (a 400 from a not-yet-upgraded
			// replica, a 5xx, a dropped connection) is worth another draw.
			if (res.status === 401 || res.status === 403) break;
		} catch (err) {
			// Network-level failure — no response at all. Worth another draw.
			last = err;
		}
	}
	throw last instanceof Error
		? last
		: new AgentApiError(0, 'tool-result failed (no response)');
}
