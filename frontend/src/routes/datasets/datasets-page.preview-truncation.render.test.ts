// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.preview-truncation.render.test.ts — the drawer says WHY its
// table stops, instead of just stopping.
//
// ⛔ THE DEFECT, AND IT IS A NOTICE THAT COULD NOT FIRE ANYWHERE IN THE PRODUCT. `inspect()` calls
// `datasetsApi.get(slug, { limit: 50 })` and mounted `<DatasetPreviewTable columns rows />` with
// NEITHER `maxRows` NOR any notion of the dataset's size. So the drawer showed a header reading
// "claims-2026 · 12.480 rijen", a table that stopped dead at row 50, and nothing between them. A
// tester's only available reading is that the dataset really has 50 rows, or that the page broke.
//
// ⛔ AND `maxRows={50}` ALONE WOULD NOT HAVE FIXED IT — this is the part worth reading twice. The
// notice's condition was `rows.length > maxRows`: "is the array I was handed longer than what I
// display?". But `GET /api/datasets/:slug?limit=` caps the array SERVER-side (`readRows(d.id,
// limit, offset)`, backend/src/routes/datasets.ts), so a caller fetching `limit: N` and passing
// `maxRows={N}` asks whether `N > N`. On /datasets that is `50 > 50`; on the four inline previews
// (NodeConfigPanel, ChallengeDataPanel, /submit, /challenges/[id] — all `limit: 5` + `maxRows={5}`)
// it is `5 > 5`. The notice was unreachable at EVERY ONE of its five mount sites.
//
// ⛔ WHY CI NEVER SAW THAT. `lib/components/dataset-preview.locale-numbers.render.test.ts` DOES
// render this notice — by handing the component 10 000 rows with `maxRows: 50`. That is a state the
// API cannot produce: no response ever carries more rows than the limit it echoes. The one spec
// that exercised the notice did so from a fabricated shape, so it proved the message formats
// correctly and could never have noticed the condition was dead in production. This file therefore
// drives the REAL response shape — 50 rows, `limit: 50`, `rowCount: 12480` — through the real page.
//
// ⚠️ 50 IS NOT RAISED, AND MUST NOT BE. It is a deliberate page size; the defect is the silence,
// not the number. The last case pins that the drawer still fetches 50.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name plus its arguments — so an assertion names
// WHICH message and WHICH interpolated values reached the DOM, never the wording. (The wording and
// its per-locale grouping are the subject of `dataset-preview.locale-numbers.render.test.ts`.)
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

const { listDatasets, getDataset, listMappings, matrixFn, ontologyGet } = vi.hoisted(() => ({
	listDatasets: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn(),
	matrixFn: vi.fn(),
	ontologyGet: vi.fn()
}));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: {
		list: listDatasets,
		get: getDataset,
		uploadFile: vi.fn(),
		paste: vi.fn(),
		remove: vi.fn(),
		update: vi.fn(),
		updateColumns: vi.fn(),
		listMappings,
		saveMappings: vi.fn(),
		deleteMapping: vi.fn(),
		suggestMappings: vi.fn()
	},
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/ontology', () => ({
	ontologyApi: { matrix: matrixFn, get: ontologyGet, compiled: vi.fn() },
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/** The page size `inspect()` asks for. Not raised by this change — see the header. */
const PAGE = 50;
/** A dataset far larger than one page: the demo's own claims sheet. */
const TOTAL = 12_480;

const dataset = (rowCount: number): DatasetRow =>
	({
		id: 'd1',
		slug: 'claims-2026',
		name: 'Dataset claims-2026',
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' as const, pii: false }],
		rowCount,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	}) as DatasetRow;

const listResponse = (d: DatasetRow): DatasetList => ({
	items: [d],
	total: 1,
	page: 1,
	pageSize: 20,
	canManage: true
});

/**
 * The response shape the ROUTE actually produces: at most `limit` rows, and the row count of the
 * whole dataset alongside. `rows` is `min(rowCount, limit)` long — never more, whatever `rowCount`
 * says — because `readRows` applies the limit in SQL.
 */
const detail = (d: DatasetRow, limit = PAGE): DatasetDetail => ({
	...d,
	rows: Array.from({ length: Math.min(d.rowCount, limit) }, (_, i) => ({ bedrag: i })),
	offset: 0,
	limit
});

const matrix: MatrixData = { industries: [], departments: [], cells: [] } as MatrixData;
const compiled: CompiledOntology = {
	industry: '',
	department: '',
	entities: [],
	relations: [],
	hidden: []
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	for (const fn of [listDatasets, getDataset, listMappings, matrixFn, ontologyGet]) fn.mockReset();
	listMappings.mockResolvedValue({ mappings: [] });
	matrixFn.mockResolvedValue(matrix);
	ontologyGet.mockResolvedValue(compiled);
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

const settle = async (until: () => boolean, tries = 30) => {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
};
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** Mount /datasets on one dataset and open its preview drawer. */
async function openDrawer(rowCount: number, limit = PAGE) {
	const d = dataset(rowCount);
	listDatasets.mockResolvedValue(listResponse(d));
	getDataset.mockResolvedValue(detail(d, limit));
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	await settle(() => !host.textContent?.includes('datasets_loading'));
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('datasets_loading');

	const btn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'datasets_preview'
	);
	expect(btn, 'the Preview button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	click(btn!);
	await settle(() => !!host.querySelector('table.sample'));
}

/** The rendered `<tr>` count of the preview table body. */
const bodyRows = () => host.querySelectorAll('table.sample tbody tr').length;
const notice = () => host.querySelector('.sample-more');
/**
 * ⚠️ THE FIGURES ARE ALREADY GROUPED BEFORE THEY REACH THE MESSAGE. The call site wraps both in
 * `num(_, locale.current)` (see `dataset-preview.locale-numbers.render.test.ts`, which owns that
 * behaviour), so the key-name stub receives the STRING "12,480", not the number 12480 — and joins
 * its arguments with a comma, producing `dataset_preview_more:50,12,480`. Built with `Intl` rather
 * than typed as a literal so this file states the rule instead of hard-coding one locale's comma.
 */
const grouped = (n: number) => new Intl.NumberFormat('en').format(n);
/** The DRAWER's slug line. `.ds-slug` also names every row of the list behind it, and the list's
 *  copy carries no row count — so an unscoped `querySelector` reads the wrong element and the
 *  assertion fails against a string that was never the subject. */
const drawerSlug = () => host.querySelector('aside .ds-slug')?.textContent ?? '';

describe('/datasets says why the preview stops', () => {
	it('⛔ THE DEFECT: a 12 480-row dataset explains its 50-row table', async () => {
		await openDrawer(TOTAL);

		// ⛔ POSITIVE ANCHORS FIRST. The table must really be there and really be truncated, or the
		// notice assertion below would be a claim about an empty drawer.
		expect(host.querySelector('table.sample'), 'the preview table never rendered').not.toBeNull();
		expect(bodyRows(), 'the drawer did not render the 50 fetched rows').toBe(PAGE);

		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT. Pre-fix this element did not exist, in this or
		// any other real scenario.
		const more = notice();
		expect(more, 'the table stopped at row 50 with no explanation').not.toBeNull();
		// Both figures reach the reader — "truncated" without saying by how much is barely better.
		// The stub renders `key:arg1,arg2`, so this pins WHICH values were interpolated.
		expect(more!.textContent).toBe(`dataset_preview_more:${grouped(PAGE)},${grouped(TOTAL)}`);
	});

	it('⛔ …and the number it reports is the DATASET’s size, not the array’s length', async () => {
		// The heart of it. `rows.length` is 50 in this fixture — a notice built from the array can
		// only ever say "50 of 50", which is why the old condition could not fire. The 12 480 can
		// have come from nowhere but `rowCount`.
		await openDrawer(TOTAL);
		const text = notice()!.textContent ?? '';
		expect(text).toContain(grouped(TOTAL));
		expect(text).not.toBe(`dataset_preview_more:${grouped(PAGE)},${grouped(PAGE)}`);
	});

	it('A DATASET THAT FITS SAYS NOTHING — the notice is not unconditional', async () => {
		// The complement. "Always render it" satisfies both cases above and would put "12 of 12" under
		// every small dataset in the product.
		await openDrawer(12);
		expect(bodyRows()).toBe(12);
		expect(notice(), 'a complete table was labelled as truncated').toBeNull();
	});

	it('EXACTLY ONE PAGE SAYS NOTHING EITHER — the boundary is `>`, not `>=`', async () => {
		// A dataset of exactly 50 rows is fully shown. An off-by-one here reads as "50 of 50 rows
		// shown", which is both false and alarming.
		await openDrawer(PAGE);
		expect(bodyRows()).toBe(PAGE);
		expect(notice()).toBeNull();
	});

	it('⛔ THE PAGE SIZE IS NOT RAISED — the fix is the sentence, not the ceiling', async () => {
		// A "fix" that fetched all 12 480 rows would also make the notice disappear, and would ship a
		// 12 480-row table into a drawer. Pin the request.
		await openDrawer(TOTAL);
		expect(getDataset).toHaveBeenCalledWith('claims-2026', { limit: PAGE });
	});

	it('the drawer header still states the real total — the notice explains it, it does not replace it', async () => {
		// The header is where the reader learns the dataset is big; the notice is where they learn
		// the TABLE is small. Both, or the notice is answering a question nobody was asked.
		await openDrawer(TOTAL);
		expect(drawerSlug()).toContain('claims-2026');
		expect(drawerSlug()).toContain(grouped(TOTAL));
	});
});
