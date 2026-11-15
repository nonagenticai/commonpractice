// src/lib/types/agent.ts — 1:1 mirror of the backend agent SSE event union
// (backend/src/ai/agent.ts AgentEvent). The chat store switches on `type`.

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
			 * Why the metered broker refused, when that is why the turn ended — mirrors
			 * `BrokerRejectionKind` (backend/src/host/llm-broker.ts:79), a CLOSED 3-member union.
			 *
			 * ⚠️ TYPED AS `string`, NOT AS THE UNION, DELIBERATELY. This is a WIRE type: the value is
			 * whatever a running backend put on the SSE frame, which during a rolling deploy may be a
			 * kind this build has never heard of. A literal union here would let a `switch` be
			 * "exhaustive" over three cases and hand a fourth kind to code that cannot render it. The
			 * store treats an unrecognised kind exactly like an absent one — it falls back to
			 * `message`, which is always English but is at least the truth.
			 */
			kind?: string;
	  };

/** What the browser POSTs back after fulfilling a frontend (edit) tool call. */
export interface ToolResultPayload {
	ok: boolean;
	output?: unknown;
	error?: string;
}
