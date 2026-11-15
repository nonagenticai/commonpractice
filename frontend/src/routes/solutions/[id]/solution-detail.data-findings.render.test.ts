// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.data-findings.render.test.ts — "Try it" must SAY
// SOMETHING when the test data going into the run violates the ontology data contract.
//
// ⛔ THE DEFECT THIS GUARDS, AND WHY THIS SCREEN IS THE WORSE OF THE TWO. `runSample()` called
// `const { runId, sandboxId } = await runsApi.startSolution(id)` and DESTRUCTURED THE REPORT AWAY:
// `dataValidation` — the whole `DataValidationFinding[]` naming dataset, column and attribute —
// reached the browser on the 201 and was dropped on the floor. And the failure path rendered only
// `writeErrorText(e, …)`, so even a `block` 422 arrived as ONE sentence naming no column.
//
// Unlike /build, this run happens in the VIEWER'S OWN SANDBOX against an author's test data the
// viewer has never seen. Under the shipped `warn` policy a `pii_uncovered` finding means the
// author's personal data lands in the viewer's sandbox unredacted while the run goes green and the
// page says nothing at all.
//
// The `en` catalog is mocked key-for-key (same technique as the sibling board tests): the
// assertions are about WHICH message and WHICH interpolated values reach the DOM, never about
// English copy a translator may reword.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DataValidationFinding } from '$lib/types/flows';
import type { SolutionDetail } from '$lib/types/solutions';
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

// ⛔ `runErrorDataFindings` / `RunApiError` are NOT stubbed — the page's reading of a refusal is
// part of what is under test, so the real functions run against a real `RunApiError`. Only the
// network calls are replaced.
vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runsApi: {
			startSolution,
			getMySandbox,
			start: vi.fn(),
			resumeMySandbox: vi.fn()
		}
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

/** Typed WITHOUT a cast: `SolutionDetail` is the contract and the compiler is the cheapest reviewer
 *  of the fixture. `flow` must be non-null — the whole "Try it" card is behind `{#if data.flow}`. */
function detail(): SolutionDetail {
	return {
		id: 'sol-1',
		title: 'Claims triage',
		status: 'voting',
		week: '2026-W30',
		// Required since #234 moved votability onto the solution's OWN cycle. `false` = this
		// solution's week is still open, which is the state this file's data-findings cases
		// assume (a run is being started from the page). The rebase surfaced this as a type
		// error rather than a silent wrong render — which is exactly why the fixture is typed
		// as `SolutionDetail` with no cast.
		cycleClosed: false,
		votesCount: 4,
		hasVoted: false,
		// ⛔ `0`, NOT A POSITIVE NUMBER, AND NOT NULL. This fixture is the entire non-vacuity of the
		// demo-duration guard on the row: the board used to test `{#if row.demoSeconds}`, and a
		// truthiness check passes and fails identically to `!= null` for every value EXCEPT a genuine
		// zero. With `demoMs: 42` this file would go green against the reverted guard and prove
		// nothing. A run measured at 0 ms is data — an answer, not the absence of one.
		demoMs: 0,
		blocksUsed: ['load-dataset'],
		createdAt: new Date().toISOString(),
		author: { name: 'Bea Builder', initials: 'BB' },
		challenge: { id: 'ch-1', code: 'CH-1', title: 'Triage', status: 'voting', week: '2026-W30' },
		flow: { id: 'f1', name: 'Triage flow', chain: ['load-dataset'] },
		comparison: []
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the detail page, then press "Try it" and let everything settle. */
async function mountAndRun() {
	getSolution.mockResolvedValue(detail());
	getMySandbox.mockResolvedValue({ id: 's1', slug: 'viewer-sbx', status: 'idle' });

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const btn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'solution_detail_tryit_run'
	);
	expect(btn, 'the Try it button never rendered, so this file tests nothing').toBeDefined();
	// ⛔ `bubbles: true`. Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the delegated handler.
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
	for (const fn of [getSolution, startSolution, getMySandbox, streamRunSpy]) fn.mockReset();
});

describe('/solutions/[id] renders the data-contract findings behind a "Try it" run', () => {
	it('⛔ WARN: the pill renders AND the run still streams — the shipped default', async () => {
		// ⛔ RED BEFORE THIS CHANGE: `startSolution`'s report was destructured away, so this pill did
		// not exist and the viewer watched a green run while the author's PII went into the viewer's
		// own sandbox in the clear.
		startSolution.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII, TYPE] }
		});
		await mountAndRun();

		const warn = target.querySelector('[data-testid="data-findings-warn"]');
		expect(warn, 'the warn pill did not render — this is the defect verbatim').not.toBeNull();
		const text = warn!.textContent ?? '';
		expect(text).toContain('data_findings_title_warn');
		// The ADDRESS — the thing the backend had already computed and this page discarded.
		expect(text).toContain('claims-2026.ssn_col → ssn');
		expect(text).toContain('claims-2026.amount → amount');
		// …and the localized sentence with the machine fields interpolated, not the backend's English.
		expect(text).toContain('data_finding_pii_uncovered:ssn,ssn_col,claims-2026');
		expect(text).toContain('data_finding_type_mismatch:3,amount,amount,number');
		expect(text).not.toContain('would be injected unredacted');
		// The reader must be TOLD the run continued, not left to infer it.
		expect(text).toContain('data_findings_warn_policy_note');

		// ⛔ AND THE RUN PROCEEDED. Showing the warning by refusing the run would be a different,
		// worse product; this assertion is what stops that "fix".
		expect(streamRunSpy).toHaveBeenCalledTimes(1);
		expect(streamRunSpy.mock.calls[0]![0]).toBe('run-1');
		// Amber, not coral: nothing failed, so there is no run-error paragraph.
		expect(target.querySelector('.run-error')).toBeNull();
	});

	it('⛔ BLOCK: the refusal names dataset, column and attribute', async () => {
		// The 422 already carried all three; the page rendered one `writeErrorText` sentence.
		startSolution.mockRejectedValue(
			new RunApiError(422, 'data_validation_failed', 'The selected test data does not satisfy…', {
				findings: [PII, TYPE]
			})
		);
		await mountAndRun();

		const card = target.querySelector('.card')!;
		const text = card.textContent ?? '';
		expect(text).toContain('data_findings_title_block');
		expect(text).toContain('claims-2026.ssn_col → ssn');
		expect(text).toContain('data_finding_type_mismatch:3,amount,amount,number');
		// A refused run never opened a stream…
		expect(streamRunSpy).not.toHaveBeenCalled();
		// …and the WARN pill is absent: the two are mutually exclusive by mode.
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
	});

	it('WARN: the pill survives `run_complete` and only goes on Dismiss', async () => {
		// ⛔ A run that finished GREEN while PII went into the sandbox unredacted is EXACTLY the
		// state that has to stay on screen — clearing on the terminal event erases the warning at
		// the moment the viewer looks back at the console.
		startSolution.mockResolvedValue({
			runId: 'run-1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII] }
		});
		await mountAndRun();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).not.toBeNull();

		const handlers = streamRunSpy.mock.calls[0]![1] as {
			onEvent: (e: TraceEvent) => void;
			onEnd: () => void;
		};
		// Typed, not a loose literal: `RunConsole` reads `totals.llmCalls` off this event.
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

		const warn = target.querySelector('[data-testid="data-findings-warn"]')!;
		const dismiss = [...warn.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'common_dismiss'
		);
		expect(dismiss, 'the warn pill has no Dismiss').toBeDefined();
		// Same clip guard as /build: the control comes BEFORE the list, so its position does not
		// depend on the finding count. jsdom has no layout engine, so this is asserted structurally.
		const list = warn.querySelector('[data-testid="data-findings-list"]')!;
		expect(
			dismiss!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
	});

	it('a CLEAN run shows no pill at all', async () => {
		// The backend's conditional spread means a clean 201 has no `dataValidation` key. A page
		// that rendered an empty pill would train the viewer to ignore the real one.
		startSolution.mockResolvedValue({ runId: 'run-1', status: 'running', sandboxId: 's1' });
		await mountAndRun();
		expect(target.querySelector('[data-testid="data-findings-warn"]')).toBeNull();
		expect(target.querySelector('.run-error')).toBeNull();
		expect(streamRunSpy).toHaveBeenCalledTimes(1);
	});
});
