// @vitest-environment jsdom
//
// The Test run button while the server resumes an idle-paused test environment (2026-10-15).
// `POST /api/runs` now resumes the owner's idle-suspended sandbox before running; /build reads the
// sandbox first and passes `startingEnv`, so the button says "Starting test environment…" instead
// of a bare "Running" for that wait. Mutation: drop the `startingEnv ?` arm and the first test fails.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowListItem, FlowStatus } from '$lib/types/flows';

vi.mock('$lib/paraglide/messages', () => ({
	build_back_to_solutions: () => 'Back',
	build_flow_switch_blocked: () => 'Busy',
	build_flow_picker_aria: () => 'Open flow',
	build_new_flow: () => 'New flow',
	build_flow_name_aria: () => 'Flow name',
	build_your_sandbox: () => 'Your sandbox',
	build_block_count: ({ count }: { count: number }) => `${count} blocks`,
	build_sandbox_pill: () => 'Sandbox',
	build_more_actions: () => 'More actions',
	build_undo: () => 'Undo',
	build_redo: () => 'Redo',
	build_test_run_title_empty: () => 'Add a block first',
	build_test_run_title: () => 'Run it',
	build_running: () => 'RUNNING',
	build_starting_env: () => 'STARTING_ENV',
	build_test_run: () => 'TEST_RUN',
	flow_history_title: () => 'History',
	flow_history_open: () => 'History',
	build_share_title: () => 'Share link',
	build_share_copied: () => 'Copied',
	build_share: () => 'Share',
	build_submitted: () => 'SUBMITTED_LABEL',
	build_submitting: () => 'SUBMITTING_LABEL',
	build_submit_solution: () => 'SUBMIT_LABEL',
	build_submit_short: () => 'SUBMIT_SHORT',
	build_submit_needs_challenge: () => 'NEEDS_CHALLENGE',
	build_submit_needs_name: () => 'NEEDS_NAME',
	build_submit_challenge_closed: () => 'CHALLENGE_CLOSED',
	build_new_flow_default_name: () => 'Naamloze flow'
}));

const FLOW: FlowListItem = {
	id: 'flow-1',
	name: 'My flow',
	description: '',
	status: 'draft',
	version: '1',
	node_count: 3,
	last_saved_at: null,
	updated_at: '2026-08-09T00:00:00Z'
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function runButtonText(over: Record<string, unknown>): Promise<string> {
	const { default: BuildTopbar } = await import('./BuildTopbar.svelte');
	app = mount(BuildTopbar, {
		target: host,
		props: {
			name: 'My flow',
			status: 'draft' as FlowStatus,
			nodeCount: 3,
			saveLabel: 'Saved',
			saving: false,
			flows: [FLOW],
			currentId: 'flow-1',
			challengeId: 'ch-1',
			challengeClosed: false,
			flowLoaded: true,
			readOnly: false,
			chatBusy: false,
			submitting: false,
			running: false,
			historyOpen: false,
			canUndo: false,
			canRedo: false,
			onRename: () => {},
			onSelect: () => {},
			onNew: () => {},
			onSubmit: () => {},
			onTestRun: () => {},
			onToggleHistory: () => {},
			onUndo: () => {},
			onRedo: () => {},
			...over
		}
	});
	flushSync();
	const texts = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
	const hit = texts.find((t) => ['STARTING_ENV', 'RUNNING', 'TEST_RUN'].includes(t));
	expect(hit, `no run button among ${JSON.stringify(texts)}`).toBeTruthy();
	return hit!;
}

describe('Test run button while the test environment starts', () => {
	it('says "Starting test environment" while a run resumes a paused environment', async () => {
		expect(await runButtonText({ running: true, startingEnv: true })).toBe('STARTING_ENV');
	});
	it('says "Running" once the run has started', async () => {
		expect(await runButtonText({ running: true, startingEnv: false })).toBe('RUNNING');
	});
	it('says "Test run" when idle, even if a stale startingEnv is left set', async () => {
		expect(await runButtonText({ running: false, startingEnv: true })).toBe('TEST_RUN');
	});
});
