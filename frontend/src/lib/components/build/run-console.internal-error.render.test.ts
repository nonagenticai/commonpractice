// @vitest-environment jsdom
//
// src/lib/components/build/run-console.example.com-error.render.test.ts — the test environment failing
// is not a result a member can read.
//
// ⛔ THE DEFECT (live walk as a member, nl). The run pod never became Ready. The Result panel showed a
// step named "-" whose summary was "run pod cp-run-… not Running: error: timed out waiting for the
// condition on pods/…", and Details repeated it as "interne fout: run pod …". Kind `internal` is the
// HOST failing: the Result view always gives the plain message, and Details keeps the raw text only
// for a developer and above (`showInternalErrors`). The backend strips the text below developer
// too (`backend/src/host/run-cost-visibility.ts`); this file pins the screen.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';
import { runSteps } from './run-steps';
import { canSeeInternalErrors } from './run-error-visibility';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		const v = catalog[key];
		// Plural/variant entries are objects; their text is irrelevant here.
		mod[key] = (params?: Record<string, unknown>) =>
			typeof v !== 'string' ? key : v.replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));

import RunConsole from './RunConsole.svelte';

/** `messages/nl.json` `build_result_internal_error`. */
const FRIENDLY_NL = 'De testomgeving kon de test niet uitvoeren. Probeer het later opnieuw.';
const RAW = 'run pod cp-run-0192 not Running: error: timed out waiting for the condition on pods/cp-run-0192';
const R = 'run-1';
const noCost = { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };

/** The member's run: the pod never started, so the host reports it against no step. */
const SPAWN_FAILED: TraceEvent[] = [
	{ type: 'node_error', runId: R, ts: 1, nodeId: '-', slug: '-', durationMs: 0, kind: 'internal', error: RAW },
	{ type: 'run_complete', runId: R, ts: 2, totalMs: 0, status: 'failed', totals: noCost }
] as TraceEvent[];

/** A run lost mid-step: the host names the step that was in flight. */
const LOST_MID_STEP: TraceEvent[] = [
	{ type: 'run_start', runId: R, ts: 1, nodeCount: 1 },
	{ type: 'node_start', runId: R, ts: 2, nodeId: 'n1', slug: 'triage' },
	{ type: 'node_error', runId: R, ts: 3, nodeId: 'n1', slug: 'triage', durationMs: 9, kind: 'internal', error: RAW },
	{ type: 'run_complete', runId: R, ts: 4, totalMs: 9, status: 'failed', totals: noCost }
] as TraceEvent[];

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

function render(events: TraceEvent[], showInternalErrors?: boolean) {
	app = mount(RunConsole, {
		target: host,
		props: { events, status: 'failed' as const, nodeCount: 1, ...(showInternalErrors === undefined ? {} : { showInternalErrors }) }
	});
	flushSync();
	expect(host.querySelector('.outcome'), 'the run outcome never rendered — this case tests nothing').not.toBeNull();
}
const resultText = () => [...host.querySelectorAll('.result > :not(details)')].map((e) => e.textContent).join(' ');
const detailsText = () => host.querySelector('details.trace')?.textContent ?? '';

describe('RunConsole — an internal error, read by a member', () => {
	it('⛔ the Result view gives the plain message, never the pod text', () => {
		// REVERT THAT TURNS THIS RED: `stepSummary`/`runError` back to `blockTestErrorLabel(...)` —
		// the raw "run pod … not Running" lands in the Result view again.
		render(SPAWN_FAILED);
		expect(resultText()).toContain(FRIENDLY_NL);
		expect(resultText()).not.toContain('cp-run');
	});

	it('⛔ Details does not carry the raw text either (default: no internal errors)', () => {
		render(SPAWN_FAILED);
		expect(detailsText()).toContain(FRIENDLY_NL);
		expect(detailsText()).not.toContain('cp-run');
		expect(host.textContent).not.toMatch(/not Running|pods\//);
	});

	it('a failure with no step gets no "-" step row', () => {
		render(SPAWN_FAILED);
		expect(runSteps(SPAWN_FAILED)).toEqual([]);
		expect(host.querySelectorAll('.step')).toHaveLength(0);
	});

	it('a run lost mid-step: the step row reads the plain message', () => {
		render(LOST_MID_STEP);
		const step = host.querySelector('.step.failed');
		expect(step, 'the in-flight step lost its row').not.toBeNull();
		expect(step!.textContent).toContain(FRIENDLY_NL);
		expect(host.textContent).not.toContain('cp-run');
	});
});

describe('RunConsole — an internal error, read by a developer and above', () => {
	it('Details keeps the raw text; the Result view still gives the plain message', () => {
		render(SPAWN_FAILED, true);
		expect(detailsText()).toContain(RAW);
		expect(resultText()).toContain(FRIENDLY_NL);
		expect(resultText()).not.toContain('cp-run');
	});

	it.each([
		[['member'], false],
		[[], false],
		[['developer'], true],
		[['tenant_admin'], true],
		[['super_admin'], true]
	])('canSeeInternalErrors(%j) → %s', (roles, expected) => {
		expect(canSeeInternalErrors(roles)).toBe(expected);
	});
});

/** `messages/nl.json` `build_result_idle_timeout`. */
const IDLE_NL = 'De test reageerde niet meer en is gestopt. Probeer het later opnieuw.';
const IDLE_RAW = 'the runner sent nothing for 120000ms (host idle watchdog) — the run was stopped and its pod destroyed';
/** The host idle watchdog: kind `timeout`, NO rule, nodeId '' (aborted between nodes). */
const IDLE: TraceEvent[] = [
	{ type: 'node_error', runId: R, ts: 1, nodeId: '', slug: '', durationMs: 0, kind: 'timeout', error: IDLE_RAW },
	{ type: 'run_complete', runId: R, ts: 2, totalMs: 0, status: 'failed', totals: noCost }
] as TraceEvent[];

/** A RULED internal error: a deterministic block defect, not the environment. As a member receives it. */
const RULED_INTERNAL: TraceEvent[] = [
	{ type: 'node_start', runId: R, ts: 1, nodeId: 'n1', slug: 'triage' },
	{
		type: 'node_error', runId: R, ts: 2, nodeId: 'n1', slug: 'triage', durationMs: 1, kind: 'internal',
		error: 'The test environment could not run the test.', rule: 'block_no_default_export', detail: { blockVersion: '3' }
	},
	{ type: 'run_complete', runId: R, ts: 3, totalMs: 1, status: 'failed', totals: noCost }
] as TraceEvent[];
/** `messages/nl.json` `blockerr_block_no_default_export`, fragment. */
const NO_EXPORT_NL = 'exporteert geen blok';

describe('RunConsole — a RULED internal error is its catalog sentence, for everyone', () => {
	it.each([[false], [true]])('showInternalErrors=%s: never "try again later"', (show) => {
		// REVERT THAT TURNS THIS RED: `errorText` keyed on `kind === 'internal'` alone — a missing
		// default export, which no retry can fix, reads "probeer het later opnieuw".
		render(RULED_INTERNAL, show);
		expect(resultText()).toContain(NO_EXPORT_NL);
		expect(resultText()).not.toContain(FRIENDLY_NL);
		expect(detailsText()).toContain(NO_EXPORT_NL);
	});
});

describe('RunConsole — the host idle watchdog', () => {
	it('⛔ a member reads the plain timeout sentence in Result and Details', () => {
		// REVERT THAT TURNS THIS RED: drop the `timeout` arm of `hostFailureText`.
		render(IDLE);
		expect(resultText()).toContain(IDLE_NL);
		expect(detailsText()).toContain(IDLE_NL);
		expect(host.textContent).not.toMatch(/watchdog|pod destroyed/);
	});

	it('a developer keeps the raw text under Details; the Result view stays plain', () => {
		render(IDLE, true);
		expect(detailsText()).toContain(IDLE_RAW);
		expect(resultText()).toContain(IDLE_NL);
		expect(resultText()).not.toContain('watchdog');
	});
});

describe('RunConsole — product refusals are not host failures', () => {
	it.each<[string, TraceEvent, string]>([
		['validation', { type: 'node_error', runId: R, ts: 2, nodeId: 'n1', slug: 'triage', durationMs: 1, kind: 'validation',
			error: "'amount' must be a number", rule: 'field_must_be_number', detail: { field: 'amount' } } as TraceEvent, 'moet een getal zijn'],
		['llm_capped', { type: 'node_error', runId: R, ts: 2, nodeId: 'n1', slug: 'triage', durationMs: 1, kind: 'llm_capped',
			error: 'daily LLM call cap reached (50)', rule: 'llm_daily_cap_reached', detail: { limit: '50' } } as TraceEvent, 'daglimiet']
	])('a member reads a %s error as its own sentence', (_n, ev, fragment) => {
		render([
			{ type: 'node_start', runId: R, ts: 1, nodeId: 'n1', slug: 'triage' },
			ev,
			{ type: 'run_complete', runId: R, ts: 3, totalMs: 1, status: 'failed', totals: noCost }
		] as TraceEvent[]);
		expect(resultText()).toContain(fragment);
		expect(resultText()).not.toContain(FRIENDLY_NL);
		expect(resultText()).not.toContain(IDLE_NL);
	});
});

describe('"Test with sample data" verdict — the same rule', () => {
	it('a ruled internal error keeps its catalog sentence; the idle watchdog reads plain', async () => {
		const { sampleRunOutcome } = await import('./sample-test');
		const steps = [{ id: 'n1', label: 'Triage', datasets: [] }];
		const ruled = sampleRunOutcome(R, { runId: R, events: RULED_INTERNAL, active: false }, steps, 'nl');
		expect((ruled as { failures: { text: string }[] }).failures[0]!.text).toContain(NO_EXPORT_NL);
		const idle = sampleRunOutcome(R, { runId: R, events: IDLE, active: false }, steps, 'nl');
		expect((idle as { failures: { text: string }[] }).failures[0]!.text).toBe(IDLE_NL);
	});
	it('⛔ an internal failure reads as the plain message, with or without a step', async () => {
		// REVERT THAT TURNS THIS RED: `text:` back to `blockTestErrorLabel(...)` in `sampleRunOutcome`
		// — the member's sample-test verdict quotes the pod text again.
		const { sampleRunOutcome } = await import('./sample-test');
		const steps = [{ id: 'n1', label: 'Triage', datasets: [] }];
		for (const events of [SPAWN_FAILED, LOST_MID_STEP]) {
			const out = sampleRunOutcome(R, { runId: R, events, active: false }, steps, 'nl');
			expect(out.state).toBe('failed');
			const failures = (out as { failures: { text: string }[] }).failures;
			expect(failures, 'the failure vanished from the verdict').toHaveLength(1);
			expect(failures[0]!.text).toBe(FRIENDLY_NL);
		}
	});
});

describe('RunConsole — a block’s own error is unchanged', () => {
	it('block_throw text still reaches the Result view', () => {
		render([
			{ type: 'node_start', runId: R, ts: 1, nodeId: 'n1', slug: 'triage' },
			{ type: 'node_error', runId: R, ts: 2, nodeId: 'n1', slug: 'triage', durationMs: 3, kind: 'block_throw', error: 'no claim number' },
			{ type: 'run_complete', runId: R, ts: 3, totalMs: 3, status: 'failed', totals: noCost }
		] as TraceEvent[]);
		expect(resultText()).toContain('no claim number');
		expect(resultText()).not.toContain(FRIENDLY_NL);
	});
});
