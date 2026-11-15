// @vitest-environment jsdom
//
// src/lib/components/build/block-author.grounding-failure.render.test.ts — the "Build with AI"
// start form, in DUTCH, when its test-data grounding call fails.
//
// ⛔ THE DEFECT. `catch { /* optional grounding */ }` left `datasets` at `[]`, and the "Testdata
// (optioneel)" select then held exactly one entry: "Geen". That rendering is IDENTICAL to the one a
// developer with no datasets gets — so a 500 on `GET /api/datasets` was shown as a fact about their
// account, and the reasonable response to it ("I have nothing to ground this block in, so I'll skip
// it") costs them the exact capability this form exists to offer. Third copy of the swallow already
// fixed on `/submit` and `/challenges/[id]`.
//
// ⚠️ THE CALL STAYS OPTIONAL. "None" is a legitimate choice and the form must still submit without
// test data — so the notice sits UNDER the select rather than replacing it, and the last case below
// asserts the Start button is unaffected. A fix that disabled the form on a failed optional fetch
// would be a worse bug than the one it replaces.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — see the note in `node-config.dataset-failure.render.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetRow } from '$lib/types/datasets';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		// ⛔ THE PARAMETERS ARE REALLY INTERPOLATED — see the note on the same mock in
		// `node-config.dataset-failure.render.test.ts`. A stub that discards its arguments cannot tell
		// "2 van de 245" from "245 van de 2".
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
// ⛔ THE REAL `AgentChatStore` IS KEPT OUT ON PURPOSE. It reaches `$lib/api/agent` (SSE) and
// `licenseOrPermissionMessage` from the error-message module this file stubs — so importing it would
// couple a test about an empty dropdown to the agent transport, and the stub of one module would
// break the other. This subject is the pre-chat FORM; the chat never starts here.
vi.mock('$lib/stores/agent-chat.svelte', () => ({
	AgentChatStore: class {
		busy = false;
		messages: unknown[] = [];
		stop() {}
		async send() {}
	}
}));
vi.mock('$lib/agent/block-author-driver', () => ({
	BlockAuthorDriver: class {},
	describeBlockEdit: (name: string) => name
}));
vi.mock('$lib/i18n/ontology-axis-label', () => ({
	industryLabel: (s: string) => s,
	departmentLabel: (s: string) => s
}));

const { matrix, listAll, listPaged } = vi.hoisted(() => ({
	matrix: vi.fn(),
	listAll: vi.fn(),
	listPaged: vi.fn()
}));
vi.mock('$lib/api/ontology', () => ({ ontologyApi: { matrix } }));
// `list` is mocked but must never be called — see the note on the same line in
// `node-config.dataset-failure.render.test.ts`.
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { listAll, list: listPaged } }));

import BlockAuthorAssistant from './BlockAuthorAssistant.svelte';

/** `messages/nl.json`. */
const LOAD_FAILED_NL = 'Datasets konden niet worden geladen. Probeer het opnieuw.';
const NONE_NL = 'Geen';
/** `datasets_picker_capped`, with the figures the notice below is built from substituted in. */
const CAPPED_NL = 'Deze keuzelijst toont 2 van de 245 datasets.';

function dataset(slug: string, name: string): DatasetRow {
	return {
		id: `id-${slug}`,
		slug,
		name,
		sourceType: 'csv',
		columns: [],
		rowCount: 7,
		sizeBytes: 128,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

/**
 * What `datasetsApi.listAll` actually resolves: `{items,total,capped}` — NOT a bare `DatasetRow[]`.
 * Written once per file on purpose; see the fuller note on the twin helper in
 * `node-config.dataset-failure.render.test.ts`.
 */
function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	app = mount(BlockAuthorAssistant, {
		target: host,
		props: { category: 'logic', onProposal: () => {} }
	}) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. "The screen does not say X" is true for free on a form that never
 * rendered. Nothing is asserted absent until the test-data select is proved present.
 */
function dataSelect(): HTMLSelectElement {
	const sel = host.querySelector('#ba-dataset') as HTMLSelectElement | null;
	expect(sel, 'the test-data select never rendered — this case tests nothing').not.toBeNull();
	return sel!;
}
function errorBox(): HTMLElement | null {
	return host.querySelector('[data-testid="datasets-error"]');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	matrix.mockResolvedValue({ industries: ['insurance'], departments: ['claims'] });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [matrix, listAll, listPaged]) fn.mockReset();
});

describe('the block-authoring form, when the test-data grounding call fails', () => {
	it('⛔ says the load failed instead of showing an empty dropdown and nothing else', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* optional grounding */ }` around the datasets call.
		// The select still holds only "Geen", and the developer's only available reading of that is
		// that they own no test data.
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		// The dropdown really is down to its one placeholder entry — the state that used to be silent.
		expect([...dataSelect().options].map((o) => o.textContent?.trim())).toEqual([NONE_NL]);
		const err = errorBox();
		expect(err, 'an empty test-data dropdown was presented without a reason').not.toBeNull();
		expect(err!.textContent).toContain(LOAD_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
	});

	it('⛔ a HEALTHY load shows the datasets and no notice', async () => {
		// THE COMPLEMENT. "Always render the notice" would satisfy the case above.
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		await render();

		expect(errorBox(), 'a notice was shown for a load that succeeded').toBeNull();
		expect([...dataSelect().options].map((o) => o.value)).toContain('claims-2026');
		expect(host.textContent).not.toContain(LOAD_FAILED_NL);
	});

	it('a RETRY that succeeds clears the notice and fills the dropdown', async () => {
		listAll.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render();
		const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure notice offered no way to try again').not.toBeNull();
		// ⛔ THE RETRY MUST NOT BE INSIDE A `<label>`. A button in a label forwards its click to the
		// labelled control, so pressing it would also pop the very dropdown the notice is explaining.
		expect(retry!.closest('label'), 'the retry button sits inside a <label>').toBeNull();

		listAll.mockResolvedValueOnce(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(errorBox()).toBeNull();
		expect([...dataSelect().options].map((o) => o.value)).toContain('claims-2026');
	});

	it('⛔ pages to completion instead of reading page one', async () => {
		// The endpoint pages at 12 (backend/src/routes/datasets.ts) and this select has no pager, so
		// a developer's thirteenth dataset could never be chosen as grounding.
		listAll.mockResolvedValue(allDatasets([]));
		await render();

		expect(listAll, 'the form did not page the dataset list to completion').toHaveBeenCalled();
		expect(listPaged, 'the form still reads a single page of a paged endpoint').not.toHaveBeenCalled();
	});

	it('the grounding stays OPTIONAL: a failed load does not block Start', async () => {
		// ⚠️ THE BOUND ON THE FIX. Test data is optional by design — the agent can proceed without it.
		// Turning an optional fetch's failure into a blocked form would be the worse bug.
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		const intent = host.querySelector('textarea') as HTMLTextAreaElement;
		expect(intent, 'the intent field never rendered').not.toBeNull();
		intent.value = 'markeer claims boven de polislimiet';
		intent.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		const start = host.querySelector('button.btn-primary') as HTMLButtonElement | null;
		expect(start, 'the Start button never rendered').not.toBeNull();
		expect(start!.disabled, 'a failed OPTIONAL grounding call blocked the form').toBe(false);
	});
});

describe('the grounding walk, when it stops at its ceiling', () => {
	// ⛔ WHY `listAll` RESOLVES AN OBJECT. A select holding 2 of the developer's 245 datasets renders
	// exactly like one holding all 2 of them — the same indistinguishability as the swallowed failure
	// above, and it costs the developer the same capability. `total` is the SERVER's count, so the
	// notice names the real number rather than the number we managed to fetch.
	function cappedNotice(): HTMLElement | null {
		return host.querySelector('[data-testid="datasets-capped"]');
	}

	it('⛔ says the dropdown is short, and names the developer’s real total', async () => {
		// REVERT THAT TURNS THIS RED: discard `all.capped`/`all.total` in `loadDatasets`. The two
		// options still render, so every other case in this file stays green.
		listAll.mockResolvedValue(
			allDatasets([dataset('claims-2026', 'Claims 2026'), dataset('sales-2026', 'Sales 2026')], {
				total: 245,
				capped: true
			})
		);
		await render();

		dataSelect(); // the select exists, so a note about its completeness is about something
		const note = cappedNotice();
		expect(note, 'a 2-of-245 sample was offered as the developer’s test data').not.toBeNull();
		// Both figures, in this order — the shown/total swap reads correctly and states something false.
		expect(note!.textContent).toContain(CAPPED_NL);
		expect(note!.querySelector('a')?.getAttribute('href')).toBe('/datasets');
		// ⚠️ Not an alert: the optional grounding call SUCCEEDED, it just did not reach the end.
		expect(note!.getAttribute('role')).toBe('status');
		// ⛔ AND IT IS NOT INSIDE THE `<label>` EITHER — same reason as the retry button above: this
		// note carries a link, and a click inside a label is forwarded to the labelled `<select>`.
		expect(note!.closest('label'), 'the truncation note sits inside a <label>').toBeNull();
	});

	it('⛔ a COMPLETE list carries no notice', async () => {
		// THE COMPLEMENT. "Always render it" satisfies the case above and lies to everyone else.
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		await render();

		dataSelect();
		expect(cappedNotice(), 'a complete dataset list was reported as truncated').toBeNull();
	});
});
