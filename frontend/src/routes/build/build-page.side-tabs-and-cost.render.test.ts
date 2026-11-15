// @vitest-environment jsdom
//
// src/routes/build/build-page.side-tabs-and-cost.render.test.ts — two /build mount-site rules that a
// component test cannot see.
//
// 1. RUN COST. `<RunConsole showCost={showSessionCost}>`: a member's Result → Details trace carries
//    no LLM calls · tokens · USD; a tenant admin's does. Change the prop to `true` and the member case
//    goes red. (The component's own gate: lib/components/build/run-console.cost.render.test.ts.)
//
// 2. SIDE TABS. A challenge session opens on the Sample data tab. Adding or selecting a step must
//    ALWAYS show its Details — from Sample data as well as from Assistant — otherwise a reader who
//    adds a block sees nothing about it. Going BACK to Sample data with a step selected must stay
//    there (no bounce to Details), and "Use" must then write the dataset into that step.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';

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

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build?id=f1&challenge=ch-1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { startRun, streamRunSpy, getFlow, saveFlow, listFlows, listBlocks, getBlock, getChallenge } =
	vi.hoisted(() => ({
		startRun: vi.fn(),
		streamRunSpy: vi.fn(),
		getFlow: vi.fn(),
		saveFlow: vi.fn(),
		listFlows: vi.fn(),
		listBlocks: vi.fn(),
		getBlock: vi.fn(),
		getChallenge: vi.fn()
	}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: startRun, startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', () => ({
	streamRun: (...args: unknown[]) => {
		streamRunSpy(...args);
		return { close: () => {} };
	}
}));
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, blocksApi: { list: listBlocks, get: getBlock } };
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: getChallenge, list: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (q: string) => ({
		matches: false,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	})
});
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as never;

import { auth } from '$lib/stores/auth.svelte';
import Page from './+page.svelte';

const SLUG = 'load-dataset';
const DATASET = 'claims-april';

function flowFixture() {
	return {
		id: 'f1',
		name: 'Claim summariser',
		owner_id: 'u1',
		status: 'draft',
		version: '1',
		solution_id: null,
		last_saved_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		graph: {
			nodes: [
				{
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: SLUG,
					label: 'Load dataset',
					category: 'data',
					config: {},
					position: { x: 0, y: 0 }
				}
			],
			edges: []
		}
	};
}

/** A block with ONE dataset-typed input, so "Use" has somewhere to write. */
function blockDetail() {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Load dataset',
		description: 'Reads a dataset',
		category: 'data',
		current_version_id: 'v1',
		maintainer_id: null,
		owner: 'global',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		maintainer: null,
		versions: [
			{
				id: 'v1',
				block_id: 'b1',
				version: '1.0.0',
				status: 'stable',
				language: 'typescript',
				docs_md: '',
				source_ts: '',
				descriptor: {
					inputs: { source: { type: 'dataset', required: true } },
					outputs: { rows: { type: 'json' } },
					capabilities: { dataset: true }
				},
				examples: [],
				changelog: '',
				tests_passing: true,
				created_at: '2026-01-01T00:00:00.000Z'
			}
		]
	};
}

function paletteItem() {
	return {
		slug: SLUG,
		name: 'Load dataset',
		description: 'Reads a dataset',
		category: 'data',
		owner: 'global',
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

function challengeFixture() {
	return {
		id: 'ch-1',
		code: 'CH-284',
		title: 'Claims intake',
		description: '',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W21',
		tags: [],
		metrics: {},
		votesCount: 1,
		hasVoted: false,
		submitter: { name: 'S', initials: 'S' },
		createdAt: '2026-05-20T00:00:00.000Z',
		commentCount: 0,
		datasets: [{ slug: DATASET, name: 'Claims April', columns: [], rowCount: 12, note: '' }],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: [],
		cycleClosed: false
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const panel = (id: 'details' | 'data' | 'assistant') =>
	target.querySelector(`#side-panel-${id}`) as HTMLElement | null;
const shownTab = () => (['details', 'data', 'assistant'] as const).filter((id) => panel(id)?.hidden === false);
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const blockTile = () => target.querySelector(`[data-block-slug="${SLUG}"]`) as HTMLElement | null;

async function mountAs(roles: string[]) {
	auth.user = { id: 'u1', email: 'u@example.com', name: 'U', roles };
	listBlocks.mockResolvedValue({ items: [paletteItem()] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }] });
	getFlow.mockResolvedValue(flowFixture());
	getBlock.mockResolvedValue(blockDetail());
	saveFlow.mockImplementation(async () => flowFixture());
	getChallenge.mockResolvedValue(challengeFixture());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	await settle();
	expect(target.querySelector('.side-tabs'), 'the side pane never rendered').toBeTruthy();
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
	for (const fn of [startRun, streamRunSpy, getFlow, saveFlow, listFlows, listBlocks, getBlock, getChallenge])
		fn.mockReset();
});

describe('/build Result → Details trace cost', () => {
	async function runTrace(roles: string[]): Promise<string> {
		await mountAs(roles);
		startRun.mockResolvedValue({ runId: 'run-1', status: 'running', sandboxId: 's1' });
		const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'build_test_run');
		expect(btn, 'no Test run button').toBeDefined();
		expect(btn!.disabled, 'Test run is disabled — the flow did not load').toBe(false);
		click(btn!);
		await settle();
		expect(streamRunSpy, 'the run never streamed').toHaveBeenCalledTimes(1);
		const h = streamRunSpy.mock.calls[0]![1] as { onEvent: (e: TraceEvent) => void; onEnd: () => void };
		const cost = { usd: 0.0041, tokensIn: 812, tokensOut: 204, llmCalls: 3 };
		h.onEvent({
			type: 'node_success',
			runId: 'run-1',
			ts: Date.now(),
			nodeId: 'n1',
			slug: SLUG,
			durationMs: 1240,
			cost,
			outputPreview: '{}'
		});
		h.onEvent({ type: 'run_complete', runId: 'run-1', ts: Date.now(), totalMs: 1240, status: 'ok', totals: cost });
		h.onEnd();
		await settle();
		const text = target.querySelector('#build-run-log .console')?.textContent ?? '';
		// A member reads the block's name in Details; the identifier is for developers and above.
		expect(text, 'the trace never rendered the step').toMatch(/Load dataset|load-dataset/);
		return text;
	}

	it('⛔ a member does not see LLM cost in the trace', async () => {
		expect(await runTrace(['member'])).not.toContain('console_trace_cost');
	});

	it('a tenant admin sees it on the step and on the total', async () => {
		expect((await runTrace(['tenant_admin'])).match(/console_trace_cost/g)).toHaveLength(2);
	});
});

describe('/build side tabs: adding or selecting a step shows its Details', () => {
	it('precondition: a challenge session opens on Sample data', async () => {
		await mountAs(['member']);
		expect(shownTab()).toEqual(['data']);
		// The tab is the heading: no second "Challenge data" title inside it.
		const data = panel('data')!;
		expect(data.textContent, 'the panel did not render the challenge').toContain('Claims intake');
		expect(data.querySelector('header')).toBeNull();
		expect(data.textContent).not.toContain('build_data_panel_title');
	});

	it('⛔ adding a block from the Sample data tab switches to Details', async () => {
		await mountAs(['member']);
		expect(shownTab(), 'precondition').toEqual(['data']);
		expect(blockTile(), 'no palette tile').toBeTruthy();
		blockTile()!.click();
		await settle();
		expect(getBlock).toHaveBeenCalledWith(SLUG);
		expect(shownTab()).toEqual(['details']);
	});

	it('⛔ clicking a step on the canvas from the Sample data tab switches to Details', async () => {
		await mountAs(['member']);
		expect(shownTab(), 'precondition').toEqual(['data']);
		const node = target.querySelector('.svelte-flow__node[data-id="n1"]');
		expect(node, 'the flow’s step never reached the canvas').toBeTruthy();
		click(node!);
		await settle();
		expect(shownTab()).toEqual(['details']);
	});

	it('⛔ clicking a step on the canvas from the Assistant tab switches to Details', async () => {
		await mountAs(['member']);
		click(target.querySelector('#side-tab-assistant')!);
		await settle();
		expect(shownTab(), 'precondition').toEqual(['assistant']);
		click(target.querySelector('.svelte-flow__node[data-id="n1"]')!);
		await settle();
		expect(shownTab()).toEqual(['details']);
	});

	it('⛔ adding a block from the Assistant tab switches to Details', async () => {
		await mountAs(['member']);
		click(target.querySelector('#side-tab-assistant')!);
		await settle();
		expect(shownTab(), 'precondition').toEqual(['assistant']);
		blockTile()!.click();
		await settle();
		expect(shownTab()).toEqual(['details']);
	});

	it('⛔ with a step selected, Sample data stays open and Use writes into that step', async () => {
		await mountAs(['member']);
		blockTile()!.click(); // adds and selects a second Load dataset step
		await settle();
		expect(shownTab(), 'precondition: the new step shows its details').toEqual(['details']);

		click(target.querySelector('#side-tab-data')!);
		await settle();
		await settle();
		expect(shownTab(), 'going back to Sample data bounced to Details').toEqual(['data']);

		const use = panel('data')!.querySelector('button.dp-use') as HTMLButtonElement | null;
		expect(use, 'no Use button for the challenge dataset').toBeTruthy();
		expect(use!.disabled, 'Use is disabled — the selection did not persist').toBe(false);
		saveFlow.mockClear();
		click(use!);
		await settle();
		expect(shownTab(), 'Use moved the reader off the tab').toEqual(['data']);

		// The write reaches the graph the page saves (real 800 ms autosave debounce).
		await new Promise((r) => setTimeout(r, 1000));
		await settle();
		expect(saveFlow, 'the Use click never reached the saved graph').toHaveBeenCalled();
		const saved = JSON.stringify(saveFlow.mock.calls.at(-1));
		expect(saved).toContain(`"source":"${DATASET}"`);
	});
});
