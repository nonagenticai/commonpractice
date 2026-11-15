// @vitest-environment jsdom
//
// src/routes/build/build-page.dutch-refusal.render.test.ts — THE DEFECT, at the surface it happened
// on: a Dutch author presses Submit and reads the refusal.
//
// ⛔ WHY THIS FILE EXISTS WHEN error-message.test.ts ALREADY PINS THE MAPPING. That file mocks
// `$lib/paraglide/messages` with sentinels, so it proves `code → which message key`, and nothing
// about what a human sees. `solutions.create.test.ts` uses the real catalog but only `en`. Between
// them, EVERY assertion in this workstream was made in English — for a change whose entire subject
// is that the English reached a Dutch screen. A key can exist in `nl.json`, pass key-parity, pass
// placeholder-parity, and still never be rendered, because nothing rendered it.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED HERE. Not the catalog, not the compiler output, not
// `writeErrorText`. `overwriteGetLocale` is the same lever `$lib/stores/locale.svelte.ts` pulls in
// the running app, so the compiled paraglide functions resolve `nl` exactly as they do in a
// browser. The other /build render specs stub messages to their KEY NAMES — correct for them (they
// assert which key, not which words) and useless here, where the words are the subject.
//
// The two cases are the two SHAPES of refusal, not two arbitrary codes:
//   • `block_archived` — copy that must NAME the offending block, interpolated from `details.blockSlug`.
//   • `flow_archived`  — copy with no placeholder, so a break in interpolation cannot mask a break
//     in the plain lookup.
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
// a refusal is part of what is under test. Only the network call is replaced.
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
import { iso } from '$lib/test/bidi';

/** The block slug the backend puts on the wire — `details.blockSlug`, publication-service.ts. */
const BLOCK = 'llm-summarize';
/** The slug as the pill actually renders it — `naming()` bidi-isolates it. See `$lib/test/bidi`. */
const ISO_BLOCK = iso(BLOCK);
/** The English sentence that used to reach this screen verbatim. */
const WIRE_EN = `Block '${BLOCK}' is archived and cannot be published or run.`;

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
					label: 'Summarise',
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

/** Mount /build, press Submit, and hand back the refusal pill's text. */
async function submitAndReadPill(refusal: SolutionApiError): Promise<string> {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }] });
	getFlow.mockResolvedValue(flowFixture());
	saveFlow.mockImplementation(async () => flowFixture());
	getChallenge.mockResolvedValue(challengeFixture());
	createSolution.mockRejectedValue(refusal);

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	// ⛔ THE POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
	// nothing, `querySelector` returns null, and "the pill is not English" passes against an empty DOM.
	const btn = [...target.querySelectorAll('button.btn-primary')].find(
		(b) => b.textContent?.trim() === m.build_submit_solution()
	) as HTMLButtonElement | undefined;
	expect(btn, 'the Build topbar never rendered its Submit button — this file would test nothing').toBeDefined();
	expect(btn!.disabled, 'Submit is disabled, so the refusal path was never entered').toBe(false);

	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	expect(createSolution, 'Submit was clicked but no solution was posted').toHaveBeenCalled();
	const pill = target.querySelector('.boot-error');
	expect(pill, 'the submit refusal rendered no pill at all').not.toBeNull();
	return pill!.textContent ?? '';
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

describe('a Dutch author reads the /build submit refusal in Dutch', () => {
	it('the fixture really is Dutch, and really differs from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is of the form "the pill contains
		// the nl string". If `overwriteGetLocale` stopped working, `m.*()` would return ENGLISH, the
		// pill would contain it, and all of them would pass while proving the exact opposite. So:
		// under `nl` these must differ from what they are under `en`.
		overwriteGetLocale(() => 'nl');
		const nl = m.error_block_archived({ block: BLOCK });
		const nlPlain = m.error_flow_archived();
		const nlWrapper = m.build_submit_error({ error: 'X' });
		overwriteGetLocale(() => 'en');
		expect(nl).not.toBe(m.error_block_archived({ block: BLOCK }));
		expect(nlPlain).not.toBe(m.error_flow_archived());
		expect(nlWrapper).not.toBe(m.build_submit_error({ error: 'X' }));
		// …and the placeholder really interpolates, rather than emitting a literal `{block}`.
		expect(nl).toContain(BLOCK);
		expect(nl).not.toContain('{block}');
	});

	it('⛔ block_archived — Dutch copy that NAMES the block, never the English wire sentence', async () => {
		// The verbatim 422 body `POST /api/solutions` answers with, `blockSlug` and all.
		const text = await submitAndReadPill(
			new SolutionApiError(422, 'block_archived', WIRE_EN, {
				nodeId: 'n1',
				blockId: 'b1',
				versionId: 'v1',
				blockSlug: BLOCK
			})
		);

		overwriteGetLocale(() => 'nl');
		// ⛔ `iso(BLOCK)`, NOT `BLOCK` — `error_block_archived` is one of the six codes routed through
		// `naming()` in `api/error-message.ts`, which wraps the slug in a bidi isolate. The pill
		// therefore carries U+2068/U+2069 around the name, and the catalog call this is compared
		// against has to carry them too. Imported rather than pasted: the characters are INVISIBLE,
		// so a raw literal here is unreviewable and drifts.
		expect(text).toContain(m.error_block_archived({ block: ISO_BLOCK }));
		// The wrapper sentence around it is Dutch too — an English frame around Dutch copy is still
		// an English screen.
		expect(text).toContain(
			m.build_submit_error({ error: m.error_block_archived({ block: ISO_BLOCK }) })
		);
		// The name survived the translation. This is the half that a generic "een blok in deze flow"
		// would have silently dropped.
		expect(text).toContain(BLOCK);
		// …and the English is gone. Red by removing the `block_archived` entry from
		// VALIDATION_MESSAGES: the fall-through hands this exact string to the pill.
		expect(text).not.toContain(WIRE_EN);
		expect(text).not.toContain('is archived and cannot be published');
	});

	it('⛔ flow_archived — Dutch copy on a refusal with NO placeholder and no details', async () => {
		const wire = 'An archived flow cannot be submitted';
		const text = await submitAndReadPill(new SolutionApiError(422, 'flow_archived', wire, {}));

		overwriteGetLocale(() => 'nl');
		expect(text).toContain(m.error_flow_archived());
		expect(text).not.toContain(wire);
		// The instruction the product can actually honour: there is no "restore" anywhere in the SPA
		// (no archived-flows surface, and the only `flowsApi.save` call site sends `{name, graph}`),
		// so the Dutch copy must not tell the author to put the flow back.
		expect(text).not.toContain('terug');
	});
});
