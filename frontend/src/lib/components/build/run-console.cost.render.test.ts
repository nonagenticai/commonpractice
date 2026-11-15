// @vitest-environment jsdom
//
// src/lib/components/build/run-console.cost.render.test.ts — the Result panel's Details trace must
// not show a member the LLM spend.
//
// ⛔ THE LINE THIS IS BUILT AGAINST: `fmtCost` appended "· N LLM calls · in+out tokens · $x" to
// every `node_success` and `run_complete` line for every reader. Remove the `showCost` check from
// `fmtCost` and the member cases below go red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';

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
import { canSeeSessionCost } from './session-cost-visibility';

const cost = { usd: 0.0041, tokensIn: 812, tokensOut: 204, llmCalls: 3 };
const events: TraceEvent[] = [
	{ type: 'run_start', runId: 'r1', ts: 1, nodeCount: 1 } as TraceEvent,
	{ type: 'node_start', runId: 'r1', ts: 2, nodeId: 'n1', slug: 'summarise' } as TraceEvent,
	{
		type: 'node_success',
		runId: 'r1',
		ts: 3,
		nodeId: 'n1',
		slug: 'summarise',
		durationMs: 1240,
		cost,
		outputPreview: '{}'
	},
	{ type: 'run_complete', runId: 'r1', ts: 4, totalMs: 1240, status: 'ok', totals: cost }
];

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

function render(props: Record<string, unknown>): string {
	app = mount(RunConsole, { target: host, props: { events, status: 'ok', nodeCount: 1, ...props } as never });
	flushSync();
	return host.querySelector('.console')?.textContent ?? '';
}

describe('the Details trace cost figure', () => {
	it('non-vacuity: the trace rendered its success and completion lines', () => {
		const text = render({ showCost: false });
		expect(text).toContain('summarise');
		expect(text).toContain('console_trace_run_complete');
	});

	it('⛔ hidden from a member', () => {
		const text = render({ showCost: canSeeSessionCost(['member']) });
		expect(text).not.toContain('console_trace_cost');
	});

	it('⛔ hidden from a developer', () => {
		const text = render({ showCost: canSeeSessionCost(['developer']) });
		expect(text).not.toContain('console_trace_cost');
	});

	it('⛔ hidden when the mount site passes nothing', () => {
		expect(render({})).not.toContain('console_trace_cost');
	});

	it('shown to a tenant admin, on the step and on the total', () => {
		const text = render({ showCost: canSeeSessionCost(['tenant_admin']) });
		expect(text.match(/console_trace_cost/g)).toHaveLength(2);
	});
});
