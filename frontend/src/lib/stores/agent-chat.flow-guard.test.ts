// Unit tests for AgentChatStore's turn-cancellation guarantees.
//
// FIX 1 (SEVERE, adversarial hunt): stop() had zero call sites anywhere in the app, so
// closing an AI panel mid-turn never cancelled the metered LLM stream. This file proves
// the mechanism stop() relies on is real — a genuine AbortController wired to the SSE
// fetch's `signal`, not just local `busy` state flipping (the "dead AbortController that
// reads like a live one" bug this repo has already shipped twice on the backend). The
// call-site wiring itself (onDestroy in BlockFixAssistant/BlockAuthorAssistant, the
// build page's openFlow/onMount teardown) is proven by
// `src/lib/components/block-edit/block-fix-assistant.render.test.ts` (mount + unmount)
// for the smallest of the three consumers; the other two use the identical one-line
// pattern (see PR diff) and are not independently re-mounted here — see that test file's
// header comment for why full-page mounts of /build and BlockAuthorAssistant were judged
// out of proportion to what they'd additionally prove.
//
// FIX 2 backstop: switching flows mid-chat must never silently write to the OTHER flow.
// stop()-on-switch (wired in the build page's openFlow) closes the stream so no further
// server events arrive, but that can still race a frontend-tool-call event that was
// ALREADY handed to onEvent before the switch ran (JS is single-threaded, but `await
// driver.apply(...)` yields the microtask queue, and openFlow can run in that gap). The
// store must refuse to apply an edit whose flow no longer matches the flow the turn was
// issued for, rather than trust that stop() always wins the race.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { issueAgentTokenMock, streamAgentChatMock, postToolResultMock } = vi.hoisted(() => ({
	issueAgentTokenMock: vi.fn(),
	streamAgentChatMock: vi.fn(),
	postToolResultMock: vi.fn()
}));

// Full-module mock: agent-chat.svelte.ts imports $lib/api/agent, which for real pulls in
// auth-fetch.ts -> $lib/services/keycloak.ts -> `new Keycloak(...)` at module load — a
// browser-only call that throws under plain node (see the belt-and-braces comment atop
// src/lib/api/admin.onboarding.test.ts). Mocking the whole module means the real agent.ts
// (and that chain) is never imported.
vi.mock('$lib/api/agent', () => ({
	issueAgentToken: issueAgentTokenMock,
	streamAgentChat: streamAgentChatMock,
	postToolResult: postToolResultMock,
	AgentApiError: class AgentApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
			readonly code?: string
		) {
			super(message);
		}
	}
}));

// ⛔ AN ENUMERATED MOCK OMITS THE KEY YOU JUST ADDED. This list is hand-written, so the day
// `describeEdit` started routing through `agentEditLine` (i18n/agent-edit-label.ts) every tool call
// threw "No export is defined on the mock" — as an UNHANDLED REJECTION inside the store, which
// surfaced as one unrelated assertion failing rather than as a missing key. A Proxy is deliberately
// NOT used here: it would make every future key silently resolve, which is the opposite of what this
// file is for. Adding a key to `agent-edit-label.ts` means adding it here, on purpose.
vi.mock('$lib/paraglide/messages', () => ({
	chat_intro: () => 'intro',
	chat_error_session: () => 'session error',
	chat_error_generic: () => 'generic error',
	chat_error_stopped: () => 'The assistant stopped.',
	chat_tool_searched: () => 'searched',
	agent_edit_add_node: (p: Record<string, unknown>) => `add ${p.slug}`,
	agent_edit_insert_node: (p: Record<string, unknown>) => `insert ${p.slug}`,
	agent_edit_remove_node: () => 'remove a node',
	agent_edit_connect_nodes: (p: Record<string, unknown>) => `connect ${p.source} to ${p.target}`,
	agent_edit_disconnect_nodes: () => 'disconnect an edge',
	agent_edit_configure_node: (p: Record<string, unknown>) => `set ${p.key}`,
	agent_edit_move_node: () => 'move a node',
	agent_edit_draft_block: () => 'draft a block',
	agent_edit_propose_fix: () => 'propose a fix',
	agent_edit_unknown: (p: Record<string, unknown>) => String(p.name)
}));

import { AgentChatStore } from './agent-chat.svelte';
import type { AgentEvent } from '$lib/types/agent';

function driverStub() {
	return { apply: vi.fn().mockResolvedValue({ ok: true, output: {} }) };
}

/** Captures the handlers streamAgentChat was given so a test can push events into the
 *  store exactly as the real SSE reader loop would. */
function wireStream() {
	let handlers: { onEvent: (ev: AgentEvent) => void };
	const closeMock = vi.fn();
	streamAgentChatMock.mockImplementation((_args: unknown, h: typeof handlers) => {
		handlers = h;
		return { close: closeMock };
	});
	return {
		closeMock,
		emit: (ev: AgentEvent) => handlers!.onEvent(ev)
	};
}

/** Flush the microtask queue so an `emit()`'d event's `await driver.apply(...)` /
 *  `await postToolResult(...)` chain settles before assertions run (onEvent is invoked
 *  fire-and-forget by the store: `(ev) => void this.onEvent(ev, token)`). */
async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
	issueAgentTokenMock.mockReset().mockResolvedValue('tok');
	streamAgentChatMock.mockReset();
	postToolResultMock.mockReset().mockResolvedValue(undefined);
});

describe('AgentChatStore.stop()', () => {
	it('truly aborts the in-flight request, not just local state', async () => {
		const { closeMock } = wireStream();
		const chat = new AgentChatStore({ driver: driverStub() });

		await chat.send('hello');
		expect(chat.busy).toBe(true);

		chat.stop();

		// This is the real AbortController.abort() path (streamAgentChat's ChatControl),
		// not a flag flip — see src/lib/api/agent.ts: close() calls `ac.abort()`, and
		// that AbortController's signal is the one passed to `fetch`.
		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(chat.busy).toBe(false);
	});

	it('is a safe no-op when idle', () => {
		const chat = new AgentChatStore({ driver: driverStub() });
		expect(() => chat.stop()).not.toThrow();
		expect(chat.busy).toBe(false);
	});
});

describe('AgentChatStore turn-boundary reset of the streaming bubble', () => {
	// stop() closed the stream but left `streamingIdx` pointing at the half-streamed
	// assistant bubble of the turn it just aborted. Every other turn boundary
	// (assistant-message, turn-end, dropStreaming) cleared it; stop() did not, and neither
	// did send(). So the NEXT turn's first `assistant-delta` appended onto the OLD bubble
	// and its `assistant-message` then overwrote that same old bubble — the new answer was
	// rendered inside the previous turn's message and the new turn showed nothing at all.
	// Reachable from the visible Stop button (ChatPanel) and from every flow switch
	// (the build page's openFlow calls stop()).
	it('renders the answer after a stop() as its own message, leaving the stopped bubble intact', async () => {
		const { emit } = wireStream();
		const chat = new AgentChatStore({ driver: driverStub() });

		// Turn 1: streams a partial answer, then the user hits Stop.
		await chat.send('first question');
		emit({ type: 'assistant-delta', turnId: 't1', text: 'partial one' });
		await flush();
		chat.stop();

		// intro, user#1, the stopped partial bubble, the "stopped" activity line.
		expect(chat.messages).toHaveLength(4);
		expect(chat.messages[2]!.text).toBe('partial one');

		// Turn 2: a fresh stream delivers a completely different answer.
		await chat.send('second question');
		emit({ type: 'assistant-delta', turnId: 't2', text: 'second ' });
		emit({ type: 'assistant-message', turnId: 't2', text: 'second answer' });
		await flush();

		// The aborted turn's bubble must be byte-identical to what the user watched stop.
		expect(chat.messages[2]!.kind).toBe('assistant');
		expect(chat.messages[2]!.text).toBe('partial one');
		// ...and the new answer must be its OWN message after the second user turn.
		expect(chat.messages).toHaveLength(6);
		expect(chat.messages[4]!).toMatchObject({ kind: 'user', text: 'second question' });
		expect(chat.messages[5]!).toMatchObject({ kind: 'assistant', text: 'second answer' });
	});
});

describe('AgentChatStore frontend-tool-call flow guard', () => {
	it('refuses to apply a tool-call once the caller has switched to a different flow', async () => {
		let flowId = 'flow-A';
		const driver = driverStub();
		const { emit } = wireStream();
		const chat = new AgentChatStore({ driver, getFlowId: () => flowId });

		await chat.send('add a node');
		// The exact race: the turn was issued against flow-A, but by the time this
		// tool-call event is handled, the caller has switched to flow-B (e.g. stop() on
		// switch raced an event already in flight).
		flowId = 'flow-B';

		emit({ type: 'frontend-tool-call', turnId: 't1', callId: 'c1', name: 'add_node', input: { slug: 'x' } });
		await flush();

		expect(driver.apply).not.toHaveBeenCalled();
		expect(postToolResultMock).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: 't1',
				callId: 'c1',
				payload: expect.objectContaining({ ok: false })
			})
		);
	});

	it('applies the tool-call normally when the flow has not changed', async () => {
		const driver = driverStub();
		const { emit } = wireStream();
		const chat = new AgentChatStore({ driver, getFlowId: () => 'flow-A' });

		await chat.send('add a node');
		emit({ type: 'frontend-tool-call', turnId: 't1', callId: 'c1', name: 'add_node', input: { slug: 'x' } });
		await flush();

		expect(driver.apply).toHaveBeenCalledWith('add_node', { slug: 'x' });
		expect(postToolResultMock).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: 't1', callId: 'c1', payload: { ok: true, output: {} } })
		);
	});
});
