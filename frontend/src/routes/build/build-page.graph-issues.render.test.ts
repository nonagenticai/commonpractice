// @vitest-environment jsdom
//
// src/routes/build/build-page.graph-issues.render.test.ts — THE DEFECT, at the surface it happened
// on: a Dutch author presses Submit, the graph is refused, and they read the per-node issue list.
//
// ⛔ WHY THIS FILE EXISTS WHEN graph-issue-label.test.ts ALREADY PINS THE MAPPING. That file mocks
// `$lib/paraglide/messages` with sentinels, so it proves `rule → which message key`, and nothing
// about what a human sees. A key can exist in `nl.json`, pass key-parity, pass placeholder-parity,
// and still never reach the screen — because the render site still says `{issue.message}`, which is
// EXACTLY what it said before this change and exactly the defect. Only a mount can see that.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED HERE. Not the catalog, not the compiler output.
// `overwriteGetLocale` is the same lever `$lib/stores/locale.svelte.ts` pulls in the running app,
// so the compiled paraglide functions resolve `nl` exactly as they do in a browser. Harness cloned
// from `build-page.dutch-refusal.render.test.ts`, which does the same for the 4xx copy.
//
// The two issues are the two SHAPES the list has to survive, not two arbitrary rules:
//   • `missing-required-input` — a NODE issue, so `issueNodeLabel(issue.ref)` prefixes the canvas
//     label and the combined line has to read as one sentence.
//   • `incompatible-handle-type` — the widest rule (six interpolated identifiers, including two
//     FieldType tokens), so a break in interpolation cannot hide behind a short sentence.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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
// ⛔ PARTIAL. `SolutionApiError` and `solutionErrorIssues` are the REAL ones — the page's reading of
// a refusal, including `isGraphIssue`'s new `detail` check, is part of what is under test. Only the
// network call is replaced.
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
import Page from './+page.svelte';

const BLOCK = 'llm-summarize';
const SOURCE = 'http-fetch';
/** The bidi isolate `graphIssueLabel` wraps every identifier in — `<bdi>` in two characters. */
const I = (s: string) => `⁨${s}⁩`;

/** The English sentences backend/src/exec/flow-validate.ts puts on the wire, verbatim. */
const WIRE_REQUIRED = `Node '${BLOCK}' requires input 'prompt'`;
const WIRE_TYPES = `Edge e1: '${SOURCE}.rows' (json) cannot feed '${BLOCK}.prompt' (string)`;

/** The 422 body `POST /api/solutions` answers an unpublishable graph with. */
const ISSUES = [
	{
		rule: 'missing-required-input',
		message: WIRE_REQUIRED,
		ref: 'n1',
		detail: { node: BLOCK, handle: 'prompt' }
	},
	{
		rule: 'incompatible-handle-type',
		message: WIRE_TYPES,
		ref: 'e1',
		detail: {
			sourceNode: SOURCE,
			sourceHandle: 'rows',
			sourceType: 'json',
			targetNode: BLOCK,
			targetHandle: 'prompt',
			targetType: 'string'
		}
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
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: BLOCK,
					label: 'Samenvatten',
					category: 'data',
					config: {},
					position: { x: 0, y: 0 }
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

/** Mount /build, press Submit, and hand back the rendered `.run-issues li` elements. */
async function submitAndReadIssues(): Promise<HTMLLIElement[]> {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }] });
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
	// nothing, `querySelectorAll` returns empty, and "the list is not English" passes against an
	// empty DOM. "Not English" is satisfied by a page that never rendered anything at all.
	const btn = [...target.querySelectorAll('button.btn-primary')].find(
		(b) => b.textContent?.trim() === m.build_submit_solution()
	) as HTMLButtonElement | undefined;
	expect(btn, 'the Build topbar never rendered its Submit button — this file would test nothing').toBeDefined();
	expect(btn!.disabled, 'Submit is disabled, so the refusal path was never entered').toBe(false);

	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	expect(createSolution, 'Submit was clicked but no solution was posted').toHaveBeenCalled();
	const lis = [...target.querySelectorAll('.run-issues li')] as HTMLLIElement[];
	expect(lis, 'the refusal rendered no per-node issue list at all').toHaveLength(ISSUES.length);
	return lis;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	for (const mock of [createSolution, getChallenge, getFlow, saveFlow, listFlows, listBlocks]) mock.mockReset();
});

describe('a Dutch author reads the /build graph-issue list in Dutch', () => {
	it('the fixtures really are Dutch, and really differ from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is of the form "the li contains
		// the nl string". If `overwriteGetLocale` stopped working, `m.*()` would return ENGLISH, the
		// li would contain it, and all of them would pass while proving the exact opposite.
		overwriteGetLocale(() => 'nl');
		const nlReq = m.graph_issue_missing_required_input({ node: 'A', handle: 'B' });
		const nlType = m.graph_issue_incompatible_handle_type({
			source: 'A.B',
			sourceType: 'C',
			target: 'D.E',
			targetType: 'F'
		});
		overwriteGetLocale(() => 'en');
		expect(nlReq).not.toBe(m.graph_issue_missing_required_input({ node: 'A', handle: 'B' }));
		expect(nlType).not.toBe(
			m.graph_issue_incompatible_handle_type({
				source: 'A.B',
				sourceType: 'C',
				target: 'D.E',
				targetType: 'F'
			})
		);
		// …and the placeholders really interpolate, rather than emitting a literal `{node}`.
		expect(nlReq).toContain('A');
		expect(nlReq).not.toContain('{node}');
		expect(nlType).not.toContain('{source}');
	});

	it('⛔ missing-required-input — Dutch copy that NAMES the node and the input', async () => {
		const [li] = await submitAndReadIssues();
		const text = li!.textContent ?? '';

		overwriteGetLocale(() => 'nl');
		// Exactly what the page must produce: the nl pattern with the two identifiers, each wrapped
		// in the bidi isolate `graphIssueLabel` adds.
		expect(text).toContain(
			m.graph_issue_missing_required_input({ node: I(BLOCK), handle: I('prompt') })
		);
		// The identifiers survived the translation — the half a generic "een blok in deze flow"
		// would have silently dropped.
		expect(text).toContain(BLOCK);
		expect(text).toContain('prompt');
		// The canvas label still prefixes the sentence, and the combined line reads as one.
		expect(text.trim().startsWith('Samenvatten'), `combined line was: ${text.trim()}`).toBe(true);
		// ⛔ …and the English is GONE. Red by reverting `+page.svelte` to `{issue.message}`.
		expect(text).not.toContain(WIRE_REQUIRED);
		expect(text).not.toContain('requires input');
		// A placeholder that never got substituted would be worse than either.
		expect(text).not.toContain('{node}');
		expect(text).not.toContain('{handle}');
	});

	it('⛔ incompatible-handle-type — all SIX identifiers reach the Dutch sentence', async () => {
		const [, li] = await submitAndReadIssues();
		const text = li!.textContent ?? '';

		overwriteGetLocale(() => 'nl');
		// ⚠️ FOUR ARGUMENTS FOR SIX IDENTIFIERS. `“{source}”` is ONE placeholder carrying the whole
		// `slug.handle` compound, dot inside the bidi isolate — isolating the two halves separately
		// renders `»rows.http-fetch«` to an Arabic reader. `graph-issue-label.bidi.test.ts` is where
		// that order is asserted; this file is nl-only and cannot see it.
		expect(text).toContain(
			m.graph_issue_incompatible_handle_type({
				source: I(`${SOURCE}.rows`),
				sourceType: I('json'),
				target: I(`${BLOCK}.prompt`),
				targetType: I('string')
			})
		);
		for (const id of [SOURCE, 'rows', 'json', BLOCK, 'prompt', 'string']) {
			expect(text, `identifier ${id} was dropped`).toContain(id);
		}
		expect(text).not.toContain(WIRE_TYPES);
		expect(text).not.toContain('cannot feed');
		for (const p of ['{source}', '{sourceType}', '{target}', '{targetType}', '{sourceNode}', '{sourceHandle}']) {
			expect(text, `unsubstituted placeholder ${p}`).not.toContain(p);
		}
	});

	it('the whole pill is free of the backend English', async () => {
		// The list is what changed, but the reader sees a pill. An English sentence anywhere in it is
		// still an English screen.
		await submitAndReadIssues();
		const pill = target.querySelector('.boot-error');
		expect(pill, 'the submit refusal rendered no pill at all').not.toBeNull();
		const text = pill!.textContent ?? '';
		expect(text).not.toContain(WIRE_REQUIRED);
		expect(text).not.toContain(WIRE_TYPES);
	});
});
