// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.run-cost.render.test.ts — the "Try it" run console on a
// solution page must not show a member the LLM spend.
//
// ⛔ THE LINE THIS IS BUILT AGAINST: the page's `<RunConsole … showCost={…}>`. Change that prop to
// `true` and the member case goes red; to `false` and the tenant_admin case goes red. The component
// gate alone is covered by run-console.cost.render.test.ts; this pins the MOUNT SITE.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionDetail } from '$lib/types/solutions';
import type { TraceEvent } from '$lib/types/trace';
import type { WireChainNode } from '$lib/solutions/flow-chain';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/solutions/sol-1'), params: { id: 'sol-1' } }
}));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getSolution, startSolution, getMySandbox, streamRunSpy } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	startSolution: vi.fn(),
	getMySandbox: vi.fn(),
	streamRunSpy: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runsApi: { startSolution, getMySandbox, start: vi.fn(), resumeMySandbox: vi.fn() }
	};
});
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: vi.fn().mockResolvedValue(null) } }));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: { list: vi.fn().mockResolvedValue([]), listForSolution: vi.fn().mockResolvedValue([]) }
}));
vi.mock('$lib/services/sse', () => ({
	streamRun: (...args: unknown[]) => {
		streamRunSpy(...args);
		return { close: () => {} };
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

import { auth } from '$lib/stores/auth.svelte';
import Page from './+page.svelte';

function detail(chain: WireChainNode[] = ['summarise']): SolutionDetail {
	return {
		id: 'sol-1',
		title: 'Claims triage',
		status: 'voting',
		week: '2026-W30',
		cycleClosed: false,
		votesCount: 4,
		hasVoted: false,
		demoMs: 0,
		blocksUsed: ['summarise'],
		createdAt: new Date().toISOString(),
		author: { name: 'Bea Builder', initials: 'BB' },
		challenge: { id: 'ch-1', code: 'CH-1', title: 'Triage', status: 'voting', week: '2026-W30' },
		flow: { id: 'f1', name: 'Triage flow', chain },
		comparison: []
	};
}

const cost = { usd: 0.0041, tokensIn: 812, tokensOut: 204, llmCalls: 3 };

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount as `roles`, press "Try it", stream a step and the total with LLM cost, return the trace. */
async function runAs(roles: string[], chain?: WireChainNode[]): Promise<string> {
	auth.user = { id: 'u1', email: 'u@example.com', name: 'U', roles };
	getSolution.mockResolvedValue(detail(chain));
	getMySandbox.mockResolvedValue({ id: 's1', slug: 'viewer-sbx', status: 'idle' });
	startSolution.mockResolvedValue({ runId: 'run-1', status: 'running', sandboxId: 's1' });

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	const btn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'solution_detail_tryit_run'
	);
	expect(btn, 'the Try it button never rendered, so this file tests nothing').toBeDefined();
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	expect(streamRunSpy, 'the run never streamed').toHaveBeenCalledTimes(1);
	const handlers = streamRunSpy.mock.calls[0]![1] as { onEvent: (e: TraceEvent) => void; onEnd: () => void };
	handlers.onEvent({
		type: 'node_success',
		runId: 'run-1',
		ts: Date.now(),
		nodeId: 'n1',
		slug: 'summarise',
		durationMs: 1240,
		cost,
		outputPreview: '{}'
	});
	handlers.onEvent({ type: 'run_complete', runId: 'run-1', ts: Date.now(), totalMs: 1240, status: 'ok', totals: cost });
	handlers.onEnd();
	await settle();

	const trace = target.querySelector('.console');
	expect(trace, 'the run console never rendered').not.toBeNull();
	const text = trace!.textContent ?? '';
	// NON-VACUITY: the success line is there, so an absent cost is the gate and not an empty trace.
	expect(text).toContain('✓');
	return text;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	auth.user = null;
	for (const fn of [getSolution, startSolution, getMySandbox, streamRunSpy]) fn.mockReset();
});

describe('/solutions/[id] run console cost', () => {
	it('⛔ a member sees the run, not its LLM cost', async () => {
		expect(await runAs(['member'])).not.toContain('console_trace_cost');
	});

	it('a tenant admin sees the cost on the step and the total', async () => {
		expect((await runAs(['tenant_admin'])).match(/console_trace_cost/g)).toHaveLength(2);
	});
});

// ⛔ The page passes `stepName` from the chain the DTO carries, so a member reads the block's name
// in the Result panel and in Details — not its identifier. A developer and above keeps the slug in
// Details. Drop the page's `stepName={…}` and the member case goes red.
describe('/solutions/[id] run console names blocks', () => {
	const chain: WireChainNode[] = [{ slug: 'summarise', name: 'Samenvatten' }];

	it('⛔ a member reads the block name, not the slug', async () => {
		const text = await runAs(['member'], chain);
		expect(text).toContain('Samenvatten');
		expect(text).not.toContain('summarise');
		expect(target.querySelector('.steps .step-name')?.textContent).toBe('Samenvatten');
	});

	it('a developer keeps the slug in Details', async () => {
		expect(await runAs(['developer'], chain)).toContain('summarise');
		expect(target.querySelector('.steps .step-name')?.textContent).toBe('Samenvatten');
	});
});
