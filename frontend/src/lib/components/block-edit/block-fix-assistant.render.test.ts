// @vitest-environment jsdom
//
// Proves the CALL SITE, which is where the bug actually was.
//
// `AgentChatStore.stop()` was not broken — it had always called `ChatControl.close()`,
// which is a real `AbortController.abort()` on the SSE fetch. It simply had ZERO call
// sites anywhere in the app. So closing "Fix with AI" mid auto-iterate left the request
// streaming and still metering real LLM spend against the tenant's budget, invisibly,
// for as long as the turn ran.
//
// That distinction matters for what a test has to do here. A unit test of `stop()`
// (agent-chat.flow-guard.test.ts) passes identically before and after the fix — it
// proves the mechanism is real, not that anything uses it. Only mounting the component,
// starting a turn, and UNMOUNTING it discriminates: this file fails with the one-line
// `onDestroy(() => chat.stop())` removed and passes with it.
//
// BlockFixAssistant is the honest subject of the three consumers: it owns its own
// AgentChatStore, and its "Start" button puts a turn in flight without needing a route,
// a canvas, or a flow. BlockAuthorAssistant uses the byte-identical one-line pattern;
// the build page's teardown additionally covers openFlow, which the flow-guard suite
// exercises directly at the store level.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import BlockFixAssistant from './BlockFixAssistant.svelte';
import type { BlockDescriptor } from '$lib/types/blocks';

const { issueAgentTokenMock, streamAgentChatMock, postToolResultMock, closeMock } = vi.hoisted(
	() => ({
		issueAgentTokenMock: vi.fn(),
		streamAgentChatMock: vi.fn(),
		postToolResultMock: vi.fn(),
		closeMock: vi.fn()
	})
);

// Same reasoning as agent-chat.flow-guard.test.ts: the real $lib/api/agent pulls in
// auth-fetch -> keycloak.ts, which calls `new Keycloak(...)` at module load and throws
// outside a browser. Mocking the whole module keeps that chain out of the graph.
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

// Every key reachable from BlockFixAssistant + ChatPanel + BlockDiffView, enumerated.
// NB do NOT substitute a Proxy here: vitest wraps a mock factory's return in an ESM
// namespace, and a bare Proxy without ownKeys/getOwnPropertyDescriptor traps makes that
// wrapping hang the run with no output and no failure. The one existing render test in
// this repo enumerates its keys for the same reason.
vi.mock('$lib/paraglide/messages', () => ({
	blockfix_start: () => 'Start',
	blockfix_close: () => 'Close',
	blockfix_intro: () => 'intro',
	blockfix_origin_generic: () => 'generic',
	blockfix_title: () => 'Fix with AI',
	blockfix_start_hint: () => 'hint',
	blockfix_autoiterate_label: () => 'auto',
	blockfix_autoiterate_hint: () => 'auto hint',
	blockfix_apply: () => 'apply',
	blockfix_applying: () => 'applying',
	blockfix_applied: () => 'applied',
	blockfix_applied_generic: () => 'applied',
	blockfix_dismiss: () => 'dismiss',
	blockfix_patch_title: () => 'patch',
	blockfix_patch_nochange: () => 'no change',
	// The seed's own vocabulary (`blockfix_seed_*` / `blockfix_ctx_test`), added when buildSeed()
	// stopped composing raw English. Enumerated like every other key here — the note above explains
	// why a Proxy is not an option. What the seed SAYS is `block-fix-seed.i18n.test.ts`'s subject;
	// this file only needs `start()` to survive so the turn it cancels really begins.
	blockfix_ctx_test: () => '(test)',
	blockfix_seed_intro: () => 'seed intro',
	blockfix_seed_failure: () => 'seed failure',
	blockfix_seed_origin_lint: () => 'lint',
	blockfix_seed_origin_test: () => 'test',
	blockfix_seed_origin_simulate: () => 'simulate',
	blockfix_seed_diffs: () => 'seed diffs',
	blockfix_seed_lint: () => 'seed lint',
	blockfix_seed_lint_line: () => '(line)',
	blockfix_seed_autoiterate_on: () => 'auto on',
	blockfix_seed_autoiterate_off: () => 'auto off',
	blockfix_seed_source: () => 'seed source',
	chat_header: () => 'chat',
	chat_intro: () => 'intro',
	chat_working: () => 'working',
	chat_stop: () => 'Stop',
	chat_send_aria: () => 'send',
	chat_input_aria: () => 'input',
	chat_input_placeholder: () => 'type here',
	chat_role_you: () => 'you',
	chat_role_assistant: () => 'assistant',
	chat_session_cost: () => 'cost',
	chat_tool_searched: () => 'searched',
	chat_error_session: () => 'session error',
	chat_error_generic: () => 'generic error',
	chat_error_stopped: () => 'The assistant stopped.'
}));

const DESCRIPTOR: BlockDescriptor = { inputs: {}, outputs: {}, capabilities: {} };

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	issueAgentTokenMock.mockReset().mockResolvedValue('tok');
	postToolResultMock.mockReset().mockResolvedValue(undefined);
	closeMock.mockReset();
	// A turn that never ends on its own — exactly the auto-iterate case that made this
	// leak expensive. If the component does not cancel it, nothing else will.
	streamAgentChatMock.mockReset().mockImplementation(() => ({ close: closeMock }));
});

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

function mountPanel() {
	return mount(BlockFixAssistant, {
		target: host,
		props: {
			slug: 'test-block',
			version: '0.1.0',
			sourceTs: 'export default {};',
			descriptor: DESCRIPTOR,
			context: { origin: 'test', errorKind: 'validation', errorMessage: 'boom' },
			onApply: () => {},
			onClose: () => {}
		}
	});
}

/** Click "Start" and let send()'s `await issueAgentToken(...)` settle so the stream exists. */
async function startTurn() {
	const start = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Start');
	expect(start, 'the Start button should be rendered before a turn begins').toBeTruthy();
	start!.click();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	flushSync();
}

describe('BlockFixAssistant turn cancellation', () => {
	it('cancels the in-flight metered turn when the panel is unmounted', async () => {
		app = mountPanel();
		await startTurn();

		expect(streamAgentChatMock, 'a turn should be in flight').toHaveBeenCalledTimes(1);
		expect(closeMock).not.toHaveBeenCalled();

		unmount(app);
		app = undefined;

		// The assertion the missing call site made impossible: closing the panel must abort
		// the request, not merely stop rendering it.
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('unmounting with no turn in flight is a harmless no-op', async () => {
		app = mountPanel();
		flushSync();

		unmount(app);
		app = undefined;

		expect(closeMock).not.toHaveBeenCalled();
	});
});
