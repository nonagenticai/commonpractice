// @vitest-environment jsdom
//
// src/routes/build/build-page.data-findings.render.test.ts — /build must SAY SOMETHING when the
// test data going into a run violates the ontology data contract.
//
// ⛔ THE DEFECT THIS GUARDS. `POST /api/runs` pre-flights every injected dataset against the
// ontology entity it is bound to and produces a `DataValidationFinding[]` naming the dataset, the
// column and the attribute — `pii_uncovered` says in so many words that the values "would be
// injected unredacted". The governance policy `data.validation_mode` ships as **warn**, and in
// `warn` THE RUN PROCEEDS. Before this change `runs.ts` declared `findings?: unknown[]` and nothing
// anywhere read it, so:
//   • in `block` the tester got one bare sentence and never learned which column;
//   • in `warn` — the DEFAULT — the tester got NOTHING AT ALL, and watched a green run finish while
//     PII went into the sandbox in the clear.
// The second case is the one that matters, and it is the second test below: the warn pill must
// render AND `streamRun` must still be called. A "fix" that shows the warning by refusing the run
// would pass a sloppier version of this file and be a different, worse product.
//
// The `en` catalog is mocked key-for-key (same technique as
// solutions/solutions-page.vote-control.render.test.ts): the assertions are about WHICH message and
// WHICH interpolated values reach the DOM, never about English copy a translator may reword.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DataValidationFinding } from '$lib/types/flows';
import type { TraceEvent } from '$lib/types/trace';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any).
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

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build?id=f1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { startRun, streamRunSpy, getFlow, saveFlow, listFlows, listBlocks } = vi.hoisted(() => ({
	startRun: vi.fn(),
	streamRunSpy: vi.fn(),
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn()
}));

// ⛔ `runErrorDataFindings` / `runErrorIssues` / `RunApiError` are NOT stubbed — the page's reading
// of a refusal is part of what is under test, so the real functions run against a real
// `RunApiError`. Only the network call is replaced.
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
// Partial: `$lib/api/solutions` re-exports `ApiError` from here, so a bare factory breaks its import.
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		blocksApi: { list: listBlocks, get: vi.fn().mockRejectedValue(new Error('no block detail')) }
	};
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

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

import { RunApiError } from '$lib/api/runs';
import Page from './+page.svelte';

const PII: DataValidationFinding = {
	rule: 'pii_uncovered',
	dataset: 'claims-2026',
	column: 'ssn_col',
	attribute: 'ssn',
	message: "Attribute 'ssn' is PII but dataset column 'ssn_col' is not flagged PII."
};
const TYPE: DataValidationFinding = {
	rule: 'type_mismatch',
	dataset: 'claims-2026',
	column: 'amount',
	attribute: 'amount',
	message: "Column 'amount' has 3 value(s) that don't match.",
	count: 3,
	expected: 'number'
};

/** A one-node flow — `testRun()` refuses to do anything with an empty canvas. */
function flowFixture() {
	return {
		id: 'f1',
		name: 'Test flow',
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
					slug: 'load-dataset',
					label: 'Load dataset',
					category: 'data',
					config: { source: 'claims-2026' },
					position: { x: 0, y: 0 }
				}
			],
			edges: []
		}
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount /build with one flow loaded, then press "Test run" and let everything settle. */
async function mountAndRun() {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Test flow', node_count: 1 }] });
	getFlow.mockResolvedValue(flowFixture());
	saveFlow.mockImplementation(async () => flowFixture());

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const btn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'build_test_run'
	);
	expect(btn, 'the Test run button never rendered, so this file tests nothing').toBeDefined();
	expect(btn!.disabled, 'Test run is disabled — the flow fixture did not load onto the canvas').toBe(
		false
	);
	// ⛔ `bubbles: true`. Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the delegated handler and the test would pass or fail for a
	// reason unrelated to the code under test.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

/** Drive the run to its terminal event through the handlers the page gave `streamRun`, so
 *  `running` goes false and the Test run button is pressable again. */
async function finishRun(call = 0) {
	const handlers = streamRunSpy.mock.calls[call]![1] as {
		onEvent: (e: TraceEvent) => void;
		onEnd: () => void;
	};
	handlers.onEvent({
		type: 'run_complete',
		runId: `run-${call + 1}`,
		ts: Date.now(),
		totalMs: 12,
		status: 'ok',
		totals: { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 }
	});
	handlers.onEnd();
	await settle();
}

/** Press "Test run" on the already-mounted page. */
async function pressTestRun() {
	const btn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'build_test_run'
	);
	expect(btn, 'Test run is not pressable — the previous run never reached its terminal event')
		.toBeDefined();
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const m of [startRun, streamRunSpy, getFlow, saveFlow, listFlows, listBlocks]) m.mockReset();
});

describe('/build renders the data-contract findings behind a run', () => {
	it('⛔ BLOCK: the refusal pill names dataset, column and attribute', async () => {
		startRun.mockRejectedValue(
			new RunApiError(422, 'data_validation_failed', 'The selected test data does not satisfy…', {
				findings: [PII, TYPE]
			})
		);
		await mountAndRun();

		const pill = target.querySelector('.boot-error');
		expect(pill, 'no run-error pill rendered').not.toBeNull();
		const text = pill!.textContent ?? '';
		expect(text).toContain('data_findings_title_block');
		// The ADDRESS — the thing the backend had already computed and the page used to discard.
		expect(text).toContain('claims-2026.ssn_col → ssn');
		expect(text).toContain('claims-2026.amount → amount');
		// …and the localized sentence, with the machine fields interpolated (mocked catalog:
		// `key:arg,arg,…`), not the backend's English.
		expect(text).toContain('data_finding_pii_uncovered:ssn,ssn_col,claims-2026');
		expect(text).toContain('data_finding_type_mismatch:3,amount,amount,number');
		expect(text).not.toContain('would be injected unredacted');

		// A refused run never opened a stream.
		expect(streamRunSpy).not.toHaveBeenCalled();
		// …and the WARN pill is absent: the two are mutually exclusive by mode.
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
	});

	it('⛔ WARN: the pill renders AND the run still streams — the whole defect', async () => {
		// This is the shipped default. The 201 is a NORMAL success body plus `dataValidation`.
		startRun.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII] }
		});
		await mountAndRun();

		const warn = target.querySelector('[data-testid="data-findings-warn"]');
		expect(warn, 'the warn pill did not render — this is the defect verbatim').not.toBeNull();
		const text = warn!.textContent ?? '';
		expect(text).toContain('data_findings_title_warn');
		expect(text).toContain('claims-2026.ssn_col → ssn');
		expect(text).toContain('data_finding_pii_uncovered:ssn,ssn_col,claims-2026');
		// The policy note: the reader must be told the run CONTINUED, not left to infer it.
		expect(text).toContain('data_findings_warn_policy_note');

		// ⛔ AND THE RUN PROCEEDED. Showing the warning by refusing the run would be a different
		// product; this assertion is what stops that "fix".
		expect(streamRunSpy).toHaveBeenCalledTimes(1);
		expect(streamRunSpy.mock.calls[0]![0]).toBe('run-1');

		// Amber, not coral: no error pill anywhere, because nothing failed.
		expect(target.querySelector('.boot-error')).toBeNull();
		expect(warn!.className).toContain('data-warn');
	});

	it('WARN: the pill survives `run_complete` and only goes on Dismiss', async () => {
		// ⛔ A run that finished GREEN while its PII went into the sandbox unredacted is EXACTLY the
		// state that has to stay on screen. Clearing on the terminal event would erase the warning
		// at the moment the user looks back at the console.
		startRun.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII] }
		});
		await mountAndRun();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).not.toBeNull();

		// Drive the real terminal event through the handlers the page gave `streamRun`.
		const handlers = streamRunSpy.mock.calls[0]![1] as {
			onEvent: (e: TraceEvent) => void;
			onEnd: () => void;
		};
		// Typed, not a loose object literal: `RunConsole` reads `totals.llmCalls` off this event and
		// throws on a fixture that invents the shape — the compiler is the cheapest reviewer of it.
		handlers.onEvent({
			type: 'run_complete',
			runId: 'run-1',
			ts: Date.now(),
			totalMs: 12,
			status: 'ok',
			totals: { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 }
		});
		handlers.onEnd();
		await settle();
		expect(
			target.querySelector('[data-testid="data-findings-warn"]'),
			'the warn pill vanished when the run finished — the one moment it must not'
		).not.toBeNull();

		const dismiss = [...target.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'common_dismiss'
		);
		expect(dismiss, 'the warn pill has no Dismiss — it would sit over the canvas forever').toBeDefined();
		dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
	});

	it('⛔ 250 findings: Dismiss stays inside the clipped region and the list owns the scroll', async () => {
		// ⛔ THE DEFECT THIS GUARDS. `.pill-stack` is `position: absolute; top: 60px` inside
		// `.build-page { height: calc(100vh - 56px); overflow: hidden }`. The warn pill's list had
		// no `max-height` and no `overflow`, and Dismiss was the pill's LAST child — so the button's
		// distance from the top of the viewport was a linear function of the finding count. At ~16
		// findings on a 900px viewport it was already past the clip: not scrolled off (nothing
		// scrolls — the container is `hidden`), GONE, while the pill it closes covered the canvas.
		// The count is bounded by the dataset's column width, which is why run-controller.ts caps
		// the AUDIT refs at 20; the render surface had no such reasoning applied to it.
		const many: DataValidationFinding[] = Array.from({ length: 250 }, (_, i) => ({
			rule: 'pii_uncovered',
			dataset: 'wide-dataset',
			column: `col_${i}`,
			attribute: `attr_${i}`,
			message: `Attribute 'attr_${i}' is PII but column 'col_${i}' is not flagged PII.`
		}));
		startRun.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: many }
		});
		await mountAndRun();

		const warn = target.querySelector('[data-testid="data-findings-warn"]')!;
		expect(warn).not.toBeNull();
		const list = warn.querySelector('[data-testid="data-findings-list"]')!;
		// Nothing is dropped — every finding is still in the DOM and reachable by scrolling.
		expect(list.querySelectorAll('li').length).toBe(250);

		const dismiss = [...warn.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'common_dismiss'
		);
		expect(dismiss, 'the warn pill lost its Dismiss button').toBeDefined();

		// ⛔ THE STRUCTURAL GUARANTEE, and it is asserted structurally ON PURPOSE: jsdom has no
		// layout engine, so every box here measures 0×0 and a geometric assertion would pass
		// against the broken markup too. What actually makes the control reachable at ANY count is
		// that it comes BEFORE the list — its offset from the top of the pill is then a constant,
		// and `.pill-stack`'s `top: 60px` plus one header row is inside the clip on any viewport
		// this app supports. DOCUMENT_POSITION_FOLLOWING = the list comes after the button.
		expect(
			dismiss!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
			'Dismiss is rendered after the findings list — 250 <li> push it out of the clipped ' +
				'region and it can never be clicked'
		).toBeTruthy();

		// …and it still works.
		dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
	});

	it('the findings list declares its own height cap and scroller', async () => {
		// The partner to the DOM-order assertion above, and the reason the pill does not simply
		// cover the whole canvas at 250 findings. It is asserted against the component SOURCE
		// because vitest does not process the `<style>` block (see vitest.config.ts — no `css`
		// option) and jsdom would not lay it out if it did: there is no other way to catch someone
		// deleting the cap, and "an uncapped list" is exactly the state this whole case is about.
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const source = readFileSync(resolve(process.cwd(), 'src/routes/build/+page.svelte'), 'utf8');
		const rule = /\.findings-list\s*\{([^}]*)\}/.exec(source);
		expect(rule, '`.findings-list` has no style rule at all — the list is uncapped').not.toBeNull();
		expect(rule![1]).toMatch(/max-height:/);
		expect(rule![1]).toMatch(/overflow-y:\s*auto/);
	});

	it('⛔ a SECOND run resets `dataFindingsDismissed` — a dismissed pill comes back', async () => {
		// ⛔ THE UNENFORCED RESET (`dataFindingsDismissed = false` in `testRun`). Nothing tested it:
		// deleting the line left every case green. What it buys is that Dismiss means "I have read
		// THIS run's warning", not "never warn me again on this page". Without it, the tester
		// dismisses once, edits the flow, runs again with the same broken data — and the run goes
		// green in silence for the rest of the session. That is the original defect back, with an
		// extra click in front of it.
		startRun.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII] }
		});
		await mountAndRun();
		const dismiss = [...target.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'common_dismiss'
		);
		dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();

		// Second run, same broken data.
		await finishRun(0);
		await pressTestRun();
		expect(
			target.querySelector('[data-testid="data-findings-warn"]'),
			'the pill stayed dismissed across runs — the tester is now blind for the session'
		).not.toBeNull();
	});

	it('⛔ a CLEAN second run resets `dataFindings` — the stale pill does not linger', async () => {
		// ⛔ THE OTHER UNENFORCED RESET (`dataFindings = []` in `testRun`). Also untested: deleting
		// it left every case green. The success path only ASSIGNS when `dataValidationFrom(res)`
		// returns non-null, and a clean 201 has no `dataValidation` key at all (the backend's
		// conditional spread), so nothing clears the array on the way in. Without the reset, fixing
		// the data and re-running leaves the previous run's findings on screen: the pill now names
		// columns that are fine, over a run that is clean, and the reader learns the pill lies.
		startRun.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII] }
		});
		await mountAndRun();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).not.toBeNull();

		// The data got fixed. Second run answers a clean 201 — no `dataValidation` key.
		await finishRun(0);
		startRun.mockResolvedValue({ runId: 'run-2', status: 'running', sandboxId: 's1' });
		await pressTestRun();
		expect(
			target.querySelector('[data-testid="data-findings-warn"]'),
			'the previous run’s findings are still on screen over a clean run'
		).toBeNull();
	});

	it('a CLEAN run shows no pill at all', async () => {
		// The conditional spread on the backend means a clean 201 has no `dataValidation` key. A
		// page that rendered an empty pill would train the tester to ignore the real one.
		startRun.mockResolvedValue({ runId: 'run-1', status: 'running', sandboxId: 's1' });
		await mountAndRun();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
		expect(target.querySelector('.boot-error')).toBeNull();
		expect(streamRunSpy).toHaveBeenCalledTimes(1);
	});
});
