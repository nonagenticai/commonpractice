// @vitest-environment jsdom
//
// src/lib/components/build/dataset-preview-total.render.test.ts — the two /build inline dataset
// previews say how big the dataset they are showing five rows of actually is.
//
// ⛔ THE DEFECT, AND IT IS THE SAME ONE `/datasets` FIXED AND THE OTHER FOUR MOUNT SITES DID NOT.
// `DatasetPreviewTable` renders its truncation notice on `total > shown.length`, where `total` is
// `totalRows ?? rows.length`. Both panels below fetch `datasetsApi.get(slug, { limit: 5 })` — and
// the server applies that limit in SQL (`readRows`, backend/src/datasets/dataset-service.ts), so the
// array can never be longer than 5 — then passed `maxRows={5}` and NO `totalRows`. The comparison
// was `5 > 5`. The notice could not fire on either panel in the product's life, and a builder
// wiring a 12 480-row claims sheet into a node saw five rows with nothing to say they were five.
//
// ⛔ NEITHER FIX INVENTS A NUMBER, AND THAT IS THE PART WORTH CHECKING.
//   · ChallengeDataPanel already holds `it.rowCount` on the loop variable and PRINTS it two lines
//     above the table — so pre-fix the panel showed "11.774" and, directly beneath, five rows and
//     silence.
//   · NodeConfigPanel had the figure on the wire and threw it away: `datasetsApi.get` resolves a
//     `DatasetDetail` (`extends DatasetRow`, so `rowCount` is on it), and `loadPreview` narrowed the
//     cache entry to `{ columns, rows }`. The fix widens the cache; it adds no request. That is why
//     case B2 asserts the client was called exactly ONCE.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, and the same reason, as the two sibling
// files `node-config.dataset-failure.render.test.ts` and `challenge-data.failure-honesty.render.test.ts`
// state at length. The reader-visible defect is a missing SENTENCE; a key-name mock cannot tell "the
// notice is absent" from "the notice is a key whose name happens not to match". And the numbers are
// really interpolated, so "5 van 12.480" cannot pass as "12.480 van 5".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore, ChallengeContext } from '$lib/stores/builder.svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetDetail, DatasetRow } from '$lib/types/datasets';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		// ⛔ THE PARAMETERS ARE REALLY INTERPOLATED. `dataset_preview_more` is "{shown} van {total}
		// rijen getoond", and the one thing worth asserting about a truncation notice is that it names
		// the two numbers THE RIGHT WAY ROUND. A stub that discards its arguments passes on "12.480 van
		// 5".
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

const { listAll, listPaged, getDataset, listMappings } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn()
}));
// `list` is mocked but must never be called — both panels page to completion via `listAll`. See the
// fuller note on the same line in `node-config.dataset-failure.render.test.ts`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import ChallengeDataPanel from './ChallengeDataPanel.svelte';
import NodeConfigPanel from './NodeConfigPanel.svelte';

const SLUG = 'claims-2026';
/** The demo's own claims sheet: far more than one five-row window. */
const TOTAL = 12_480;
/** What the route actually returns for `{ limit: 5 }` — `readRows` caps the array in SQL. */
const FETCHED = 5;

/**
 * The Dutch sentence, with the two figures `num(_, 'nl')` produces. Built with `Intl` rather than
 * typed as a literal, so this file states the RULE (the reader's grouping) instead of hard-coding
 * one CLDR release's separator.
 */
const nl = (n: number) => new Intl.NumberFormat('nl').format(n);
const MORE_NL = `${nl(FETCHED)} van ${nl(TOTAL)} rijen getoond`;
/** The sentence a notice built from `rows.length` could produce — i.e. the defect, not the fix. */
const SELF_REFERENTIAL_NL = `${nl(FETCHED)} van ${nl(FETCHED)} rijen getoond`;

function dataset(rowCount: number): DatasetRow {
	return {
		id: `id-${SLUG}`,
		slug: SLUG,
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' }],
		rowCount,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

/**
 * The preview response as the ROUTE builds it: at most `limit` rows, plus the dataset's own
 * `rowCount` beside them. `rows` is `min(rowCount, limit)` long — never longer, whatever `rowCount`
 * says — which is precisely why the old `rows.length > maxRows` condition was dead.
 */
function detail(rowCount: number, limit = FETCHED): DatasetDetail {
	const d = dataset(rowCount);
	return {
		...d,
		rows: Array.from({ length: Math.min(rowCount, limit) }, (_, i) => ({ bedrag: i })),
		offset: 0,
		limit
	} as DatasetDetail;
}

function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/** A builder in BROWSE mode (no challenge context) — ChallengeDataPanel then lists `listAll()`. */
function browseBuilder(): BuilderStore {
	return {
		challengeContext: null,
		selectedNode: null,
		nodes: [],
		updateConfig: vi.fn()
	} as unknown as BuilderStore;
}

/** A builder in CHALLENGE mode — the panel then lists the challenge's own `ChallengeDatasetRef`s. */
function challengeBuilder(rowCount: number): BuilderStore {
	return {
		challengeContext: {
			// `title` + `involves` are read by the panel's header before it ever reaches the list; a
			// fixture without them throws inside the render and every assertion below dies with it.
			title: 'Claims sneller afhandelen',
			involves: [],
			datasets: [
				{ slug: SLUG, name: 'Claims 2026', columns: [{ name: 'bedrag', type: 'number' }], rowCount, note: '' }
			]
		} as unknown as ChallengeContext,
		selectedNode: null,
		nodes: [],
		updateConfig: vi.fn()
	} as unknown as BuilderStore;
}

/** A selected block whose one `dataset` input is ALREADY configured — that is what loads a preview. */
function nodeBuilder(): BuilderStore {
	return {
		selectedNode: {
			id: 'n1',
			data: {
				slug: 'flag-claims',
				label: 'Markeer claims',
				kind: 'block',
				config: { rows: SLUG },
				descriptor: { inputs: { rows: { type: 'dataset', required: true } } }
			}
		},
		nodes: [],
		isInputConnected: () => false,
		updateConfig: vi.fn(),
		removeNode: vi.fn(),
		setLoopConfig: vi.fn(),
		assignToLoop: vi.fn(),
		removeFromLoop: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * ⛔ THE ANTI-VACUITY GATE, and it is the whole risk in a file whose subject is one `<div>`. Every
 * "the notice is present" case would be a claim about an empty host if the panel never mounted, and
 * every complement ("no notice") passes for free on the same empty host. Nothing is asserted until
 * a real preview table with the expected number of body rows is on screen.
 */
function previewRows(): number {
	const table = host.querySelector('table.sample');
	expect(table, 'the preview table never rendered — this case tests nothing').not.toBeNull();
	return table!.querySelectorAll('tbody tr').length;
}
function notice(): HTMLElement | null {
	return host.querySelector('.sample-more');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	listMappings.mockResolvedValue({ mappings: [] });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset, listMappings]) fn.mockReset();
});

/** Mount ChallengeDataPanel and open the one row's preview. */
async function openChallengeDataPreview(b: BuilderStore) {
	app = mount(ChallengeDataPanel, {
		target: host,
		props: { builder: b, onClose: () => {} }
	}) as Record<string, unknown>;
	await settle();
	const toggle = host.querySelector('.dp-list li button.dp-link') as HTMLButtonElement | null;
	expect(toggle, 'the panel rendered no dataset row — this case tests nothing').not.toBeNull();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

describe('A — the /build canvas data panel', () => {
	it('⛔ THE DEFECT: five rows of a 12 480-row dataset now say so', async () => {
		// REVERT THAT TURNS THIS RED: drop `totalRows={it.rowCount}` from the mount. `total` falls
		// back to `rows.length` (5), the condition becomes `5 > 5`, and `.sample-more` does not exist.
		getDataset.mockResolvedValue(detail(TOTAL));
		await openChallengeDataPreview(challengeBuilder(TOTAL));

		expect(previewRows(), 'the panel did not render the five fetched rows').toBe(FETCHED);
		const more = notice();
		expect(more, 'the table stopped at five rows with no explanation').not.toBeNull();
		expect(more!.textContent?.trim()).toBe(MORE_NL);
	});

	it('⛔ …and the figure is the DATASET’s size, not the fetched array’s length', async () => {
		// The heart of it. `rows.length` is 5 in this fixture, so a notice derived from the array can
		// only ever say "5 van 5" — which is why the old condition could not fire at all. The 12 480
		// can have come from nowhere but `rowCount`.
		getDataset.mockResolvedValue(detail(TOTAL));
		await openChallengeDataPreview(challengeBuilder(TOTAL));
		expect(notice()!.textContent).not.toContain(SELF_REFERENTIAL_NL);
		expect(notice()!.textContent).toContain(nl(TOTAL));
	});

	it('a dataset that FITS says nothing — the notice is not unconditional', async () => {
		// The complement. "Always render it" satisfies both cases above and would caption every small
		// dataset in the builder with "3 van 3 rijen getoond".
		getDataset.mockResolvedValue(detail(3));
		await openChallengeDataPreview(challengeBuilder(3));
		expect(previewRows()).toBe(3);
		expect(notice(), 'a complete table was labelled as truncated').toBeNull();
	});

	it('EXACTLY ONE WINDOW says nothing either — the boundary is `>`, not `>=`', async () => {
		// A dataset of exactly five rows is fully shown; an off-by-one here reads as "5 van 5 rijen
		// getoond", which is both false and alarming.
		getDataset.mockResolvedValue(detail(FETCHED));
		await openChallengeDataPreview(challengeBuilder(FETCHED));
		expect(previewRows()).toBe(FETCHED);
		expect(notice()).toBeNull();
	});

	it('BROWSE mode gets it too — the total comes from the list, not from the challenge', async () => {
		// The panel has two sources for `items` (`challengeContext.datasets` vs `listAll()`), and both
		// feed the same mount. A fix keyed off the challenge context alone would leave browse mode dead.
		listAll.mockResolvedValue(allDatasets([dataset(TOTAL)]));
		getDataset.mockResolvedValue(detail(TOTAL));
		await openChallengeDataPreview(browseBuilder());
		expect(notice()?.textContent?.trim()).toBe(MORE_NL);
	});
});

describe('B — the /build node inspector', () => {
	it('⛔ THE DEFECT: the inline preview under a configured dataset input says how much it is not showing', async () => {
		// REVERT THAT TURNS THIS RED: narrow the `datasetPreviews` cache back to `{ columns, rows }`
		// and drop `totalRows={preview.rowCount}`. `svelte-check` cannot see it — the prop is optional
		// by design, so the component keeps compiling and keeps rendering nothing.
		listAll.mockResolvedValue(allDatasets([dataset(TOTAL)]));
		getDataset.mockResolvedValue(detail(TOTAL));
		app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder() } }) as Record<
			string,
			unknown
		>;
		await settle();

		expect(previewRows(), 'the inspector did not render the five fetched rows').toBe(FETCHED);
		expect(notice()?.textContent?.trim()).toBe(MORE_NL);
	});

	it('⛔ …WITHOUT A SECOND REQUEST — the total was already on the response', async () => {
		// The alternative fix was `datasets.find((x) => x.slug === slug)?.rowCount`, and the one that
		// shipped keeps `d.rowCount` off the preview response instead — because a node can be
		// configured with a dataset outside the walked list (DatasetPicker's `unlisted` option) and the
		// list lookup would then be `undefined`. This pins BOTH halves of that: the list is deliberately
		// EMPTY, so a list-derived total is unavailable, and the notice must still be right; and
		// `datasetsApi.get` is called exactly once, so no fix smuggled in an extra round-trip.
		listAll.mockResolvedValue(allDatasets([]));
		getDataset.mockResolvedValue(detail(TOTAL));
		app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder() } }) as Record<
			string,
			unknown
		>;
		await settle();

		expect(notice()?.textContent?.trim()).toBe(MORE_NL);
		expect(getDataset, 'the preview total cost an extra request').toHaveBeenCalledTimes(1);
		expect(getDataset).toHaveBeenCalledWith(SLUG, { limit: FETCHED });
		expect(listPaged, 'the panel went back to reading page one').not.toHaveBeenCalled();
	});

	it('a dataset that FITS says nothing here either', async () => {
		listAll.mockResolvedValue(allDatasets([dataset(3)]));
		getDataset.mockResolvedValue(detail(3));
		app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder() } }) as Record<
			string,
			unknown
		>;
		await settle();
		expect(previewRows()).toBe(3);
		expect(notice()).toBeNull();
	});
});
