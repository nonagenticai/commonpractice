// @vitest-environment jsdom
//
// src/routes/build/build-page.foreach-issue-label.i18n.render.test.ts — the FOURTH render site of a
// canvas node's `data.label`, and the last one that still printed the persisted English.
//
// ⛔ THE DEFECT. `newForeachNode` (stores/builder-graph.ts) stamps `label: 'For each row'` and
// `canvasToFlowGraph()` PERSISTS that string into `flows.graph`. That is deliberate: the stored
// label is the wire/machine half, and localizing at CREATION time would freeze one author's locale
// into the saved flow for ever. So the fix is always at RENDER time, and three sites already do it
// (`ForeachNode.svelte`, and `.cfg-title` + the "add to loop" `<option>` in `NodeConfigPanel.svelte`).
// `issueNodeLabel` in `+page.svelte` was the one that did not: it returned `n.data.label` raw, so a
// refused graph whose issue points at a loop still named it "For each row" on an otherwise-Dutch
// screen — the same node the canvas two hundred pixels to the left called "Lus (voor elke rij)".
//
// ⛔ THE BLOCK CASE IS NOT PADDING — IT IS THE HALF A NAIVE FIX BREAKS. `issueNodeLabel` resolves
// the label for EVERY node kind, and a BLOCK node's `data.label` is that block's real author-facing
// name with no catalog entry. A patch that simply returns `m.foreach_palette_label()` passes the
// foreach assertion below and silently renames every block in every issue line. Both directions are
// asserted here, or the `kind === 'foreach'` guard is untested.
//
// ⛔ WHY THIS TESTS THROUGH THE COMPONENT AND `issueNodeLabel` IS NOT EXPORTED. It is an instance
// closure over `builder.nodes`; exporting it would mean lifting it into a module and threading the
// node list in — a bigger change than the defect, to test a mapping. And the mapping is not what
// broke: the header of `build-page.graph-issues.render.test.ts` records the lesson exactly, a key
// can exist, pass key-parity, pass placeholder-parity, and still never reach the screen because the
// render site still says the old thing. Only a mount can see `<bdi class="run-issue-node">`.
// Harness cloned from that file; message idiom cloned from
// `lib/components/build/node-config.foreach-label.i18n.render.test.ts`.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so an assertion
// names WHICH message resolved without pinning copy.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/build?id=f1&challenge=ch-live-1') }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { createSolution, getChallenge, getFlow, saveFlow, listFlows, listBlocks } = vi.hoisted(() => ({
	createSolution: vi.fn(),
	getChallenge: vi.fn(),
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: vi.fn(), startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', () => ({ streamRun: () => ({ close: () => {} }) }));
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		blocksApi: { list: listBlocks, get: vi.fn().mockRejectedValue(new Error('no block detail')) }
	};
});
// ⛔ PARTIAL, for the reason the sibling file gives: `SolutionApiError` and `solutionErrorIssues`
// are the page's REAL reading of a refusal and are part of what is under test.
vi.mock('$lib/api/solutions', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, solutionsApi: { create: createSolution, list: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: getChallenge, list: vi.fn() } }));

// SvelteFlow reads both of these during construction; jsdom ships neither.
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

import { SolutionApiError } from '$lib/api/solutions';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { newForeachNode } from '$lib/stores/builder-graph';
import Page from './+page.svelte';

const BLOCK = 'llm-summarize';
/** A BLOCK node's label — a real author-facing name, no catalog entry, must render verbatim. */
const BLOCK_LABEL = 'Markeer claims';
/** The English string the REAL creation path persists into `flows.graph`. Never reaches a screen. */
const STORED_LABEL = newForeachNode('probe', { x: 0, y: 0 }).data.label;

/** The 422 body `POST /api/solutions` answers an unpublishable graph with. One issue per node kind,
 *  SAME rule on purpose: the sentence half is then identical and the only difference between the
 *  two rendered lines is the node name — which is the thing under test. */
const ISSUES = [
	{
		rule: 'missing-required-input',
		message: `Node 'foreach' requires input 'in'`,
		ref: 'fe-1',
		detail: { node: 'foreach', handle: 'in' }
	},
	{
		rule: 'missing-required-input',
		message: `Node '${BLOCK}' requires input 'prompt'`,
		ref: 'n1',
		detail: { node: BLOCK, handle: 'prompt' }
	}
];

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
					id: 'fe-1',
					blockId: '',
					blockVersionId: '',
					slug: 'foreach',
					// The persisted English, taken from the product's own creation path rather than
					// re-typed here, so a rename of the stored literal reds this file instead of
					// silently making it test a string nothing writes any more.
					label: STORED_LABEL,
					category: 'logic',
					kind: 'foreach',
					config: {},
					loop: { rowsInput: 'in', maxIterations: 100 },
					position: { x: 0, y: 0 }
				},
				{
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: BLOCK,
					label: BLOCK_LABEL,
					category: 'data',
					config: {},
					position: { x: 320, y: 0 }
				}
			],
			edges: []
		}
	};
}

/** A live challenge — Submit must be armed, or nothing below can be clicked. */
function challengeFixture() {
	return {
		id: 'ch-live-1',
		code: 'CH-901',
		title: 'Claims intake',
		description: '',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W33',
		cycleClosed: false,
		tags: [],
		metrics: {},
		votesCount: 1,
		hasVoted: false,
		submitter: { name: 'S', initials: 'S' },
		createdAt: '2026-08-01T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: []
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount /build, press Submit, and hand back the rendered node-name `<bdi>` elements. */
async function submitAndReadNodeNames(): Promise<HTMLElement[]> {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 2 }] });
	getFlow.mockResolvedValue(flowFixture());
	saveFlow.mockImplementation(async () => flowFixture());
	getChallenge.mockResolvedValue(challengeFixture());
	createSolution.mockRejectedValue(
		new SolutionApiError(422, 'flow_invalid', 'The flow is not ready to publish.', {
			issues: ISSUES
		})
	);

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	// ⛔ THE POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
	// nothing, every `querySelector` returns null, and "the English is absent" passes against an
	// empty DOM.
	const btn = [...target.querySelectorAll('button.btn-primary')].find(
		(b) => b.textContent?.trim() === m.build_submit_solution()
	) as HTMLButtonElement | undefined;
	expect(
		btn,
		'the Build topbar never rendered its Submit button — this file would test nothing'
	).toBeDefined();
	expect(btn!.disabled, 'Submit is disabled, so the refusal path was never entered').toBe(false);

	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	expect(createSolution, 'Submit was clicked but no solution was posted').toHaveBeenCalled();
	const lis = [...target.querySelectorAll('.run-issues li')] as HTMLLIElement[];
	expect(lis, 'the refusal rendered no per-node issue list at all').toHaveLength(ISSUES.length);

	// ⛔ THE SECOND ANTI-VACUITY GATE, and the one that matters most here. `issueNodeLabel` returns
	// `null` for an unresolvable ref and the render site is `{#if label}` — so a fix that broke the
	// lookup outright would emit NO `<bdi>` at all and satisfy every `not.toContain` below.
	const names = [...target.querySelectorAll('.run-issues li bdi.run-issue-node')] as HTMLElement[];
	expect(names, 'no issue line carried a node name — the labels never rendered').toHaveLength(
		ISSUES.length
	);
	return names;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	// The message layer is mocked, so this changes no copy; it puts everything that reads the
	// runtime locale DIRECTLY (number/duration formatting) into the reader's language too.
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	for (const mock of [createSolution, getChallenge, getFlow, saveFlow, listFlows, listBlocks])
		mock.mockReset();
});

describe('a refused graph names a loop from the catalog, exactly as the canvas does', () => {
	it('⛔ the issue line for a FOREACH node is the catalog key, not the stored `For each row`', async () => {
		const [feName] = await submitAndReadNodeNames();

		expect(feName!.textContent).toBe('foreach_palette_label');
		const list = target.querySelector('.run-issues')!;
		expect(list.textContent, 'the stored English label reached the screen').not.toContain(
			STORED_LABEL
		);
	});

	it('⛔ the issue line for a BLOCK node keeps `data.label` VERBATIM — the guard, in the direction that breaks', async () => {
		// REVERT THAT TURNS THIS RED: an unguarded `m.foreach_palette_label()` in `issueNodeLabel`.
		// It makes the case above pass and renames every block in every refusal the product shows.
		const [, blockName] = await submitAndReadNodeNames();

		expect(blockName!.textContent).toBe(BLOCK_LABEL);
		expect(blockName!.textContent).not.toBe('foreach_palette_label');
	});

	it('the fix is at RENDER time only — the loaded graph is never rewritten in place', async () => {
		// `canvasToFlowGraph()` writes `label` straight back into `flows.graph` on every autosave, so
		// a "fix" applied on LOAD instead of on RENDER would be laundered into the saved flow on the
		// next keystroke and freeze one author's locale into it for ever. The fixture object the API
		// handed the page is the thing that would carry the damage.
		expect(STORED_LABEL).toBe('For each row');
		await submitAndReadNodeNames();
		const loaded = (await getFlow.mock.results.at(-1)!.value) as {
			graph: { nodes: { id: string; label: string }[] };
		};
		expect(loaded.graph.nodes.find((n) => n.id === 'fe-1')?.label).toBe(STORED_LABEL);
		expect(loaded.graph.nodes.find((n) => n.id === 'n1')?.label).toBe(BLOCK_LABEL);
	});
});
