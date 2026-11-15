// @vitest-environment jsdom
//
// src/lib/components/build/run-console.result.render.test.ts — the default view of a test run is a
// plain-language Result: one row per step (block name, done/failed, short summary). The raw trace is
// still there, behind "Details".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';
import { runSteps, shortSummary } from './run-steps';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

import RunConsole from './RunConsole.svelte';

const R = 'run-1';
const noCost = { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };
const EVENTS: TraceEvent[] = [
	{ type: 'run_start', runId: R, ts: 1, nodeCount: 3 },
	{ type: 'node_start', runId: R, ts: 2, nodeId: 'n1', slug: 'read-claim-form' },
	{ type: 'node_success', runId: R, ts: 3, nodeId: 'n1', slug: 'read-claim-form', durationMs: 40, cost: noCost, outputPreview: '{"claim":"A-12"}' },
	{ type: 'node_start', runId: R, ts: 4, nodeId: 'n2', slug: 'triage' },
	{ type: 'node_error', runId: R, ts: 5, nodeId: 'n2', slug: 'triage', durationMs: 9, kind: 'block_throw', error: 'no claim number' },
	{ type: 'node_skipped', runId: R, ts: 6, nodeId: 'n3', slug: 'notify', reason: 'upstream failed' },
	{ type: 'run_complete', runId: R, ts: 7, totalMs: 60, status: 'partial', totals: noCost }
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

function render(events: TraceEvent[], nodeCount = 3) {
	const names: Record<string, string> = { n1: 'Read claim form', n2: 'Triage claims', n3: 'Notify team' };
	app = mount(RunConsole, {
		target: host,
		props: { events, status: 'idle' as const, nodeCount, stepName: (id: string, slug: string) => names[id] ?? slug }
	});
	flushSync();
}

describe('runSteps', () => {
	it('folds the trace into one row per node, in order', () => {
		expect(runSteps(EVENTS).map((s) => [s.nodeId, s.state])).toEqual([
			['n1', 'done'],
			['n2', 'failed'],
			['n3', 'skipped']
		]);
	});
	it('a node still running reads as running', () => {
		expect(runSteps(EVENTS.slice(0, 4)).map((s) => s.state)).toEqual(['done', 'running']);
	});
	it('shortens a long output to one line', () => {
		const s = shortSummary('a\n'.repeat(200), 20);
		expect(s.length).toBeLessThanOrEqual(20);
		expect(s.endsWith('…')).toBe(true);
		expect(s).not.toContain('\n');
	});
});

describe('the Result view', () => {
	it('idle: one short sentence, no console', () => {
		render([]);
		expect(host.querySelector('.idle')?.textContent).toBe('build_result_idle');
		expect(host.querySelector('.console')).toBeNull();
	});

	it('idle with an empty canvas asks for blocks first', () => {
		render([], 0);
		expect(host.querySelector('.idle')?.textContent).toBe('build_result_idle_empty');
	});

	it('⛔ each step is the BLOCK NAME plus its outcome, not the slug', () => {
		render(EVENTS);
		const rows = [...host.querySelectorAll('.steps .step')];
		expect(rows, 'no step rows').toHaveLength(3);
		expect(rows.map((r) => r.querySelector('.step-name')?.textContent)).toEqual([
			'Read claim form',
			'Triage claims',
			'Notify team'
		]);
		expect(rows.map((r) => r.querySelector('.step-state')?.textContent)).toEqual([
			'build_step_done',
			'build_step_failed',
			'build_step_skipped'
		]);
		// The output reads as label → value, never as the JSON the runner sent (run-console.output).
		expect(rows[0].querySelector('.step-summary')).toBeNull();
		expect(rows[0].querySelector('.out-field dt')?.textContent).toBe('Claim');
		expect(rows[0].querySelector('.out-field dd')?.textContent).toBe('A-12');
		expect(rows[1].querySelector('.step-summary')?.textContent).toBe('no claim number');
		expect(host.querySelector('.outcome')?.textContent).toBe('build_result_partial');
	});

	it('the raw trace is kept, collapsed behind Details', () => {
		render(EVENTS);
		const details = host.querySelector('details.trace') as HTMLDetailsElement | null;
		expect(details, 'no Details disclosure').not.toBeNull();
		expect(details!.open).toBe(false);
		expect(details!.querySelector('summary')?.textContent).toBe('build_result_details');
		expect(details!.querySelectorAll('.line')).toHaveLength(EVENTS.length);
	});
});
