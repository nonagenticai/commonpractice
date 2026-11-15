// @vitest-environment jsdom
//
// src/lib/components/build/challenge-data.failure-honesty.render.test.ts — the /build canvas data
// panel, in DUTCH, when its two fetches fail.
//
// ⛔ DEFECT A — `catch { browseAll = []; }`. In browse mode the panel lists the builder's own test
// data. A 500 or a dropped connection collapsed into the same empty array an account with no
// datasets produces, and the panel then printed `challenge_data_empty` — "Je hebt nog geen
// datasets." A FALSE FACT about the reader's workspace, pointing at an action (go make one) that is
// the wrong action. Identical swallow to the ones already fixed on `/submit` and `/challenges/[id]`.
//
// ⛔ DEFECT B — A STUCK "VERBERGEN" OVER A ROW THAT NEVER RENDERED. `togglePreview` added the slug
// to `open` BEFORE awaiting, and `loadPreview` ended in `catch { /* no preview */ }`. The button's
// label is `open.has(slug) ? build_data_hide : build_data_preview`, and the table is behind
// `open.has(slug) && previews[slug]` — so a failed preview left a control reading "Verbergen" over
// an empty row, and pressing it hid nothing and offered "Voorbeeld" again. A control that does the
// opposite of what it says, twice in a row. `/challenges/[id]` documents this exact pair as fixed;
// this is the second copy of the same two functions.
//
// ⛔ BOTH HALVES ARE ASSERTED IN EVERY FAILURE CASE: the failure is STATED, and the control is back
// in the state that matches what is on screen. Asserting only the label would pass on a panel that
// rendered no row at all, so `row()` proves the row exists first.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — see the note in `node-config.dataset-failure.render.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore, ChallengeContext } from '$lib/stores/builder.svelte';
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

const { listAll, listPaged, getDataset } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn()
}));
// `list` is mocked but must never be called — see the note on the same line in
// `node-config.dataset-failure.render.test.ts`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset }
}));

import ChallengeDataPanel from './ChallengeDataPanel.svelte';

/** `messages/nl.json` — the words a Dutch builder sees. */
const BROWSE_EMPTY_NL = 'Nog geen datasets.';
const CHALLENGE_EMPTY_NL = 'Er zijn geen datasets aan deze uitdaging gekoppeld.';
const LOAD_FAILED_NL = 'Datasets konden niet worden geladen. Probeer het opnieuw.';
const PREVIEW_FAILED_NL = 'Het voorbeeld van deze dataset kon niet worden geladen.';
const PREVIEW_NL = 'Voorbeeld';
const HIDE_NL = 'Verbergen';
/** `datasets_picker_capped`, with the figures the notice below is built from substituted in. */
const CAPPED_NL = 'Deze keuzelijst toont 2 van de 245 datasets.';

const SLUG = 'claims-2026';
const OTHER = 'sales-2026';

function dataset(slug: string, name: string): DatasetRow {
	return {
		id: `id-${slug}`,
		slug,
		name,
		sourceType: 'csv',
		columns: [{ name: 'amount', type: 'number' }],
		rowCount: 11774,
		sizeBytes: 2048,
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

function builder(ctx: ChallengeContext | null = null): BuilderStore {
	return {
		challengeContext: ctx,
		selectedNode: null,
		nodes: [],
		updateConfig: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(b: BuilderStore = builder()) {
	app = mount(ChallengeDataPanel, {
		target: host,
		props: { builder: b, onClose: () => {} }
	}) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE for the toggle assertions: on a panel that rendered no rows, "the label is
 * not Verbergen" is true for free.
 */
function row(slug: string): HTMLElement {
	const li = [...host.querySelectorAll('.dp-list li')].find((el) =>
		el.textContent?.includes(slug === SLUG ? 'Claims 2026' : 'Sales 2026')
	);
	expect(li, `the row for ${slug} never rendered — this case tests nothing`).toBeTruthy();
	return li as HTMLElement;
}
function toggleOf(slug: string): HTMLButtonElement {
	const btn = row(slug).querySelector('button.dp-link') as HTMLButtonElement | null;
	expect(btn, `no preview toggle on the row for ${slug}`).not.toBeNull();
	return btn!;
}
async function clickToggle(slug: string) {
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	toggleOf(slug).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}
function browseError(): HTMLElement | null {
	return host.querySelector('[data-testid="browse-error"]');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset]) fn.mockReset();
});

describe('A — browse mode, when GET /api/datasets fails', () => {
	it('⛔ says the load failed AND never claims the builder has no datasets', async () => {
		// REVERT THAT TURNS THIS RED: `catch { browseAll = []; }`. `items` is then empty, the
		// `items.length === 0` branch prints BROWSE_EMPTY_NL, and there is no notice — both invert.
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		// Non-vacuity: the panel itself mounted and rendered its browse-mode heading.
		expect(host.textContent, 'the panel never rendered').toContain('Voorbeelddata');
		const err = browseError();
		expect(err, 'nothing said the dataset list failed to load').not.toBeNull();
		expect(err!.textContent).toContain(LOAD_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
		expect(
			host.textContent,
			'a failed fetch was reported to the builder as a fact about their account'
		).not.toContain(BROWSE_EMPTY_NL);
	});

	it('⛔ a HEALTHY empty account still gets the empty line, and no notice', async () => {
		// THE COMPLEMENT. Without it, "delete the empty branch" and "always show the notice" both pass.
		listAll.mockResolvedValue(allDatasets([]));
		await render();

		expect(browseError(), 'a notice was shown for a load that succeeded').toBeNull();
		expect(host.textContent).toContain(BROWSE_EMPTY_NL);
	});

	it('a RETRY that succeeds clears the notice and lists the datasets', async () => {
		listAll.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render();
		const retry = browseError()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure notice offered no way to try again').not.toBeNull();

		listAll.mockResolvedValueOnce(allDatasets([dataset(SLUG, 'Claims 2026')]));
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(browseError()).toBeNull();
		expect(host.textContent).toContain('Claims 2026');
		expect(host.textContent).not.toContain(BROWSE_EMPTY_NL);
	});

	it('⛔ pages to completion instead of reading page one', async () => {
		// The endpoint pages at 12 (backend/src/routes/datasets.ts) and this panel has no pager, so
		// `list({ page: 1 })` presented twelve datasets as "all of them".
		listAll.mockResolvedValue(allDatasets([]));
		await render();

		expect(listAll, 'the panel did not page the dataset list to completion').toHaveBeenCalled();
		expect(listPaged, 'the panel still reads a single page of a paged endpoint').not.toHaveBeenCalled();
	});

	it('challenge mode is untouched: no fetch, and its own empty line stays true', async () => {
		// ⚠️ THE SCOPE BOUNDARY. In challenge mode `items` comes from the flow's challenge context, not
		// from a request — so "no datasets are linked to this challenge" is a TRUE statement and must
		// keep rendering. A fix that suppressed the empty branch globally would erase it.
		await render(
			builder({ id: 'ch-1', title: 'Claims duren vier dagen', datasets: [], involves: [] })
		);

		expect(listAll, 'challenge mode fired a dataset list request it does not need').not.toHaveBeenCalled();
		expect(browseError()).toBeNull();
		expect(host.textContent).toContain(CHALLENGE_EMPTY_NL);
	});
});

describe('B — the preview toggle, when GET /api/datasets/:slug fails', () => {
	async function renderTwoRows() {
		listAll.mockResolvedValue(allDatasets([dataset(SLUG, 'Claims 2026'), dataset(OTHER, 'Sales 2026')]));
		await render();
	}

	it('⛔ says the preview failed AND leaves the toggle on "Voorbeeld"', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* no preview */ }` with the slug added to `open` before
		// the await. The label becomes "Verbergen", there is no error line, and the row stays blank.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await renderTwoRows();
		expect(toggleOf(SLUG).textContent?.trim()).toBe(PREVIEW_NL);

		await clickToggle(SLUG);
		expect(getDataset, 'the preview was never requested').toHaveBeenCalledWith(SLUG, { limit: 5 });

		const err = row(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`);
		expect(err, 'nothing said the preview failed').not.toBeNull();
		expect(err!.textContent).toContain(PREVIEW_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
		expect(
			toggleOf(SLUG).textContent?.trim(),
			'the toggle says "Verbergen" over a row that never showed anything'
		).toBe(PREVIEW_NL);
		expect(row(SLUG).querySelector('table'), 'a table rendered from a failed fetch').toBeNull();
	});

	it('⛔ keeps the failure on the FAILING row only', async () => {
		getDataset.mockImplementation((slug: string) =>
			slug === SLUG
				? Promise.reject(new Error('Failed to fetch'))
				: Promise.resolve({ columns: [{ name: 'amount', type: 'number' }], rows: [{ amount: 1 }] })
		);
		await renderTwoRows();
		await clickToggle(SLUG);
		await clickToggle(OTHER);

		expect(row(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).not.toBeNull();
		expect(row(OTHER).querySelector(`[data-testid="preview-error-${OTHER}"]`)).toBeNull();
		expect(toggleOf(OTHER).textContent?.trim()).toBe(HIDE_NL);
		expect(
			row(OTHER).querySelector('table'),
			'the healthy preview did not render, so the contrast proves nothing'
		).not.toBeNull();
	});

	it('a RETRY that succeeds opens the row and clears the failure', async () => {
		// `previewErrors` is a fact about the LAST attempt for this slug, not a sticky flag.
		getDataset.mockRejectedValueOnce(new Error('Failed to fetch'));
		await renderTwoRows();
		await clickToggle(SLUG);
		expect(row(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).not.toBeNull();

		getDataset.mockResolvedValueOnce({
			columns: [{ name: 'amount', type: 'number' }],
			rows: [{ amount: 2500 }]
		});
		await clickToggle(SLUG);

		expect(row(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).toBeNull();
		expect(toggleOf(SLUG).textContent?.trim()).toBe(HIDE_NL);
		expect(row(SLUG).querySelector('table'), 'the recovered preview did not render').not.toBeNull();
	});

	it('⛔ a HEALTHY preview shows no error line at all, and DOES say "Verbergen"', async () => {
		// THE COMPLEMENT. A message that is always on says nothing, and "never flip the label" would
		// satisfy every case above while breaking the working control.
		getDataset.mockResolvedValue({
			columns: [{ name: 'amount', type: 'number' }],
			rows: [{ amount: 2500 }]
		});
		await renderTwoRows();
		await clickToggle(SLUG);

		expect(toggleOf(SLUG).textContent?.trim()).toBe(HIDE_NL);
		expect(row(SLUG).querySelector('table')).not.toBeNull();
		expect(host.textContent).not.toContain(PREVIEW_FAILED_NL);

		// …and closing it again really closes it: the rollback must not have broken the ordinary path.
		await clickToggle(SLUG);
		expect(toggleOf(SLUG).textContent?.trim()).toBe(PREVIEW_NL);
		expect(row(SLUG).querySelector('table')).toBeNull();
	});
});

describe('C — the browse walk stopped at its ceiling', () => {
	// ⛔ WHY `listAll` RESOLVES AN OBJECT. `items` alone cannot say "there are more than these", and a
	// panel titled "all your test data" that lists 2 of 245 is the same false statement about the
	// reader's workspace as defect A above — just told with rows on screen instead of an empty line.
	function cappedNotice(): HTMLElement | null {
		return host.querySelector('[data-testid="datasets-capped"]');
	}

	it('⛔ says the list is short, and names the server’s real total', async () => {
		// REVERT THAT TURNS THIS RED: discard `all.capped`/`all.total` in `loadBrowse`. The rows still
		// render, so nothing else in this file notices — which is exactly why this assertion exists.
		listAll.mockResolvedValue(
			allDatasets([dataset(SLUG, 'Claims 2026'), dataset(OTHER, 'Sales 2026')], {
				total: 245,
				capped: true
			})
		);
		await render();

		row(SLUG); // the list really rendered, so a note about its completeness is about something
		const note = cappedNotice();
		expect(note, 'a 2-of-245 sample was presented as the builder’s test data').not.toBeNull();
		// Both figures, in this order — "245 van de 2" is a sentence that looks right and is false.
		expect(note!.textContent).toContain(CAPPED_NL);
		expect(note!.querySelector('a')?.getAttribute('href')).toBe('/datasets');
		// ⚠️ Not an alert: the fetch succeeded, it simply did not reach the end of the list.
		expect(note!.getAttribute('role')).toBe('status');
	});

	it('⛔ a COMPLETE list carries no notice', async () => {
		// THE COMPLEMENT. "Always render it" satisfies the case above and lies to every other builder.
		listAll.mockResolvedValue(allDatasets([dataset(SLUG, 'Claims 2026')]));
		await render();

		row(SLUG);
		expect(cappedNotice(), 'a complete dataset list was reported as truncated').toBeNull();
	});
});
