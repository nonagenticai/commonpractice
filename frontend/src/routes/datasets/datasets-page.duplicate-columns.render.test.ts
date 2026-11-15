// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.duplicate-columns.render.test.ts — /datasets survives a dataset
// whose columns repeat a name, and TELLS the uploader when an ingest had to rename one.
//
// ⛔ THE DEFECT, ON THE CRUELLEST OF THE SIX SITES. The schema editor keyed its rows on the column
// NAME (`{#each editCols as col, i (col.name)}`) — so a dataset carrying a repeated name threw
// Svelte's `each_key_duplicate`, and with no `<svelte:boundary>` in this tree the WHOLE /datasets
// page collapsed to an empty shell. The screen whose entire purpose is inspecting and correcting a
// dataset's columns was destroyed by the exact condition it exists to let you look at.
//
// ⛔ AND A SILENT RENAME IS ITS OWN DEFECT. The ingest now disambiguates a repeated header so no
// column's data is lost, which is only half an answer: a reader who uploaded a sheet with two
// `Amount` headers is looking at a schema containing `Amount_1`, a name that appears nowhere in
// their file. `truncated` has been surfaced since SPEC §2.7 for the same reason; this follows it.
//
// ⚠️ NON-VACUITY. The page renders nothing at all when it throws, so "the bad thing is absent"
// passes trivially against a dead DOM. Every case asserts the positive structure first — the exact
// schema rows, the exact notice text — and `openDrawer` refuses to proceed if the page never left
// its loading state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any) — so an
// assertion names WHICH message and WHICH interpolated value reached the DOM, never the wording.
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

const {
	listDatasets,
	getDataset,
	listMappings,
	pasteDataset,
	matrixFn,
	ontologyGet,
	saveMappingsFn,
	suggestMappingsFn
} = vi.hoisted(() => ({
	listDatasets: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn(),
	pasteDataset: vi.fn(),
	matrixFn: vi.fn(),
	ontologyGet: vi.fn(),
	saveMappingsFn: vi.fn(),
	suggestMappingsFn: vi.fn()
}));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: {
		list: listDatasets,
		get: getDataset,
		uploadFile: vi.fn(),
		paste: pasteDataset,
		remove: vi.fn(),
		update: vi.fn(),
		updateColumns: vi.fn(),
		listMappings,
		// ⚠️ `saveMappingS`, plural. The stub that used to sit here was named `saveMapping`, which is
		// not a method the page has ever called (`saveMappings` at +page.svelte:253) — so clicking the
		// mapping panel's Save button hit `undefined` and the resulting TypeError was swallowed by
		// that function's own `catch` into `mapError`. A no-op wearing the shape of a stub: every
		// assertion about the saved wire payload would have been made against a call that never
		// happened. The plural name is what makes the payload assertions below real.
		saveMappings: saveMappingsFn,
		deleteMapping: vi.fn(),
		suggestMappings: suggestMappingsFn
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

/** ⛔ EXACTLY WHAT THE UN-FIXED xlsx INGEST PERSISTED: three columns, two of them named `Amount`. */
const DUP_COLUMNS = [
	{ name: 'id', type: 'number' as const, pii: false },
	{ name: 'Amount', type: 'number' as const, pii: false },
	{ name: 'Amount', type: 'number' as const, pii: false }
];

const dataset = (columns: DatasetRow['columns']): DatasetRow =>
	({
		id: 'd1',
		slug: 'claims-2026',
		name: 'Dataset claims-2026',
		sourceType: 'xlsx',
		columns,
		rowCount: 1,
		sizeBytes: 512,
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
const detail = (d: DatasetRow): DatasetDetail => ({
	...d,
	rows: [{ id: 1, Amount: 999 }],
	offset: 0,
	limit: 50
});

const matrix: MatrixData = { industries: [], departments: [], cells: [] } as MatrixData;
const compiled: CompiledOntology = {
	industry: '',
	department: '',
	entities: [],
	relations: [],
	hidden: []
};

// ---- the mapping panel's own fixtures (see the last describe) --------------------------------
/** One populated cell, so the two chip rows have something to click and `mapCell` can load. */
const MAP_MATRIX: MatrixData = {
	industries: ['insurance'],
	departments: ['Claims'],
	cells: [{ industry: 'insurance', department: 'Claims', hasSpecialization: true }]
};
/** Two attributes on one entity — the `<select>` needs at least two real options for "the reader
 *  changed the pick on ONE row" to be a distinguishable event rather than a no-op. */
const MAP_CELL: CompiledOntology = {
	industry: 'insurance',
	department: 'Claims',
	entities: [
		{
			id: 'ent-1',
			key: 'industry_dept:insurance:Claims:Claim',
			name: 'Claim',
			label: 'Claim',
			synonyms: [],
			description: null,
			scope: 'industry_dept',
			tenantOwned: false,
			attributes: [
				{ name: 'amount', type: 'number', synonyms: [], pii: false, description: null },
				{ name: 'claim_no', type: 'string', synonyms: [], pii: false, description: null }
			]
		}
	],
	relations: [],
	hidden: []
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	for (const m of [
		listDatasets,
		getDataset,
		listMappings,
		pasteDataset,
		matrixFn,
		ontologyGet,
		saveMappingsFn,
		suggestMappingsFn
	])
		m.mockReset();
	saveMappingsFn.mockResolvedValue({ mappings: [] });
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

async function mountPage(d: DatasetRow) {
	listDatasets.mockResolvedValue(listResponse(d));
	getDataset.mockResolvedValue(detail(d));
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	await settle(() => !host.textContent?.includes('datasets_loading'));
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('datasets_loading');
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const buttonByText = (t: string) =>
	[...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === t);

async function openDrawer() {
	const btn = buttonByText('datasets_preview');
	expect(btn, 'the Preview button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	click(btn!);
	await settle(() => !!host.querySelector('.schema-row'));
}

describe('/datasets renders a dataset whose columns repeat a name', () => {
	it('⛔ THE DEFECT: the schema editor shows all three rows instead of blanking the page', async () => {
		await mountPage(dataset(DUP_COLUMNS));
		await openDrawer();

		// ⛔ THE POSITIVE ANCHOR. Pre-fix `each_key_duplicate` threw during the drawer render and took
		// the page with it: this list was `[]` and the whole host was empty.
		const rowNames = [...host.querySelectorAll('.schema-row .col-name')].map((n) => n.textContent);
		expect(rowNames).toEqual(['id', 'Amount', 'Amount']);
		expect(host.querySelectorAll('.schema-row')).toHaveLength(3);

		// The rest of the page is still standing too — the failure mode was never scoped to the drawer.
		expect(host.textContent).toContain('Dataset claims-2026');
	});

	it('the ordinary case is unchanged — no gratuitous difference from the index key', async () => {
		await mountPage(
			dataset([
				{ name: 'claim_id', type: 'string', pii: false },
				{ name: 'holder_email', type: 'string', pii: true }
			])
		);
		await openDrawer();
		const rowNames = [...host.querySelectorAll('.schema-row .col-name')].map((n) => n.textContent);
		expect(rowNames).toEqual(['claim_id', 'holder_email']);
	});
});

describe('a rename performed at ingest is reported, not silent', () => {
	/** Drive the paste form, which is the create path that needs no File plumbing. */
	async function paste(response: Record<string, unknown>) {
		pasteDataset.mockResolvedValue(response);
		click(buttonByText('datasets_new')!);
		flushSync();
		click(buttonByText('datasets_mode_paste')!);
		flushSync();

		const name = host.querySelector<HTMLInputElement>('.create-body input[type="text"]')!;
		const content = host.querySelector<HTMLTextAreaElement>('.create-body textarea')!;
		name.value = 'Claims';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		content.value = 'id,Amount,Amount \n1,100,999\n';
		content.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		click(buttonByText('datasets_create_submit')!);
		await settle(() => !!host.querySelector('.schema-row'));
	}

	it('⛔ names the renamed column, so “Amount_1” is not a name from nowhere', async () => {
		await mountPage(dataset(DUP_COLUMNS));
		await paste({
			...dataset([
				{ name: 'id', type: 'number', pii: false },
				{ name: 'Amount', type: 'number', pii: false },
				{ name: 'Amount_1', type: 'number', pii: false }
			]),
			preview: [],
			truncated: 0,
			renamedColumns: [{ from: 'Amount', to: 'Amount_1' }]
		});

		const notice = host.querySelector('.notice.renamed');
		expect(notice, 'the rename was applied but never shown — that is the silent half').not.toBeNull();
		// The interpolated value is asserted, not just the key: a notice that names no column would
		// satisfy a key-only check and tell the reader nothing.
		expect(notice!.textContent).toContain('datasets_columns_renamed:Amount → Amount_1');
	});

	it('an ordinary upload shows NO notice — it must not cry wolf', async () => {
		await mountPage(dataset(DUP_COLUMNS));
		await paste({
			...dataset([{ name: 'id', type: 'number', pii: false }]),
			preview: [],
			truncated: 0,
			renamedColumns: []
		});
		expect(host.querySelector('.notice.renamed')).toBeNull();
	});

	it('⛔ AN OLD BACKEND OMITS THE FIELD ENTIRELY — the drawer must still open', async () => {
		// The browser reaches the API through the k8s Service, which load-balances across old and new
		// pods for the length of a rolling deploy, so a response with NO `renamedColumns` is a real
		// wire shape. Without the `?? []` in `afterCreate`, `.length` on `undefined` throws inside the
		// upload handler and the create drawer hangs on "Creating…" forever.
		await mountPage(dataset(DUP_COLUMNS));
		await paste({ ...dataset([{ name: 'id', type: 'number', pii: false }]), preview: [], truncated: 0 });
		expect(host.querySelector('.notice.renamed')).toBeNull();
		// The positive half: the drawer really did open, so this is not passing on a dead page.
		expect(host.querySelector('.schema-row')).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE SIXTH SITE, AND THE ONE NOTHING WAS WATCHING: the dataset → ontology MAPPING PANEL
// (+page.svelte, `{#each selected.columns as col, ci (ci)}`).
//
// Five sibling `{#each}`es over the same duplicate-prone column list are guarded. This one was not:
// reverting its `(ci)` to `(col.name)` left the ENTIRE frontend suite green, because no case had
// ever driven the page far enough for the panel to exist. `each_key_duplicate` is NOT dev-only and
// there is no `<svelte:boundary>` in this tree, so the revert blanks /datasets for any dataset the
// xlsx ingest ever gave two identically-named headers — the same collapse the schema editor above
// already had, one panel further down.
//
// ⚠️ THE PANEL IS GATED, which is why nothing reached it by accident. It renders only under
// `{#if mapCell}`, and `mapCell` is only ever set by `loadCell()`, which needs BOTH `mapIndustry`
// and `mapDepartment` — so the chips have to be clicked (the matrix must load first) before there
// is anything to assert on. `datasets-page.enum-labels.render.test.ts` reaches the same panel by
// the other route (a saved mapping pre-selects the cell) but feeds it UNIQUE column names, so it
// passes with the key reverted; it is not a guard for this.
//
// ⚠️ AND THE VALUE KEY MUST NOT FOLLOW THE RENDER KEY. `working[col.name]` /
// `setColMapping(col.name, …)` is the wire contract with `suggestMappings` and `saveMappings`,
// which both speak column NAMES. A future reader "finishing the job" by switching the value to the
// index would send `{"1":"amount"}` to a backend that matches on the header — the last two cases
// below pin the name in both directions, on screen and on the wire.
describe('the dataset → ontology mapping panel, on a dataset whose columns repeat a name', () => {
	/** Drive the real gate: open the drawer, then pick an industry and a department chip. */
	async function openMappingPanel() {
		matrixFn.mockResolvedValue(MAP_MATRIX);
		ontologyGet.mockResolvedValue(MAP_CELL);
		await mountPage(dataset(DUP_COLUMNS));
		await openDrawer();

		// `loadMappingState` is `void`-called from `inspect`, so the matrix lands AFTER the schema
		// rows the drawer settle waited on.
		await settle(() => host.querySelectorAll('.map-chiprow .chip').length >= 2);
		const chipRows = [...host.querySelectorAll('.map-chiprow')];
		expect(
			chipRows.length,
			'the industry/department chip rows never rendered, so no cell can be picked'
		).toBe(2);
		// Positional, not by label: the chip TEXT goes through `industryLabel`/`departmentLabel` and
		// is another lane's assertion. Picking by index keeps this case about the keying.
		click(chipRows[0]!.querySelector('.chip')!);
		click(chipRows[1]!.querySelector('.chip')!);
		await settle(() => !!host.querySelector('.map-row'));
		// ⛔ THE HELPER REFUSES TO PROCEED. `each_key_duplicate` destroys the whole page, so without
		// this every case below would fail on a confusing `undefined` deep in a DOM query instead of
		// naming what actually happened — and a case that only asserted an ABSENCE would pass.
		expect(
			host.querySelectorAll('.map-row').length,
			'the mapping panel never rendered a row — either the cell gate was not satisfied or the page collapsed'
		).toBeGreaterThan(0);
	}

	/** The column NAME each mapping row shows — the first text node, before the `.map-coltype` chip. */
	const mapRowNames = () =>
		[...host.querySelectorAll('.map-col')].map((n) => n.firstChild?.textContent);
	const mapSelects = () => [...host.querySelectorAll<HTMLSelectElement>('.map-row select')];
	const change = (el: HTMLSelectElement, value: string) => {
		el.value = value;
		el.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};

	it('⛔ THE DEFECT: all three mapping rows render instead of the page collapsing', async () => {
		await openMappingPanel();

		// ⛔ THE POSITIVE ANCHOR, FIRST. With `(col.name)` restored this list is `[]` and the host is
		// empty, so every "the bad thing is absent" assertion below would pass against a dead DOM.
		expect(host.querySelectorAll('.map-row')).toHaveLength(3);
		expect(mapRowNames()).toEqual(['id', 'Amount', 'Amount']);
		// The panel is the REAL one, not a husk: each row carries its attribute picker, and the
		// options come from the compiled cell that was actually fetched.
		expect(mapSelects()).toHaveLength(3);
		expect([...mapSelects()[0]!.options].map((o) => o.value)).toEqual([
			'',
			'ent-1::amount',
			'ent-1::claim_no'
		]);
		// …and the rest of the drawer above it is still standing — the collapse was never panel-scoped.
		expect(host.querySelectorAll('.schema-row')).toHaveLength(3);
		expect(host.textContent).toContain('Dataset claims-2026');
	});

	it('⛔ THE VALUE STAYS KEYED BY NAME: a pick on one `Amount` row shows on BOTH', async () => {
		await openMappingPanel();
		change(mapSelects()[1]!, 'ent-1::amount');

		// `working` is a `Record<columnName, pick>`, so the two rows that SHARE the name `Amount`
		// share the pick — and `id` is untouched. This is the on-screen shape of the wire contract,
		// and it is exactly what an index-keyed value would break: row 2 would fall back to unmapped.
		expect(mapSelects().map((s) => s.value)).toEqual(['', 'ent-1::amount', 'ent-1::amount']);
		// The confidence chip is a human pick at 1.0, on both rows — not a suggestion left over.
		expect([...host.querySelectorAll('.conf-chip')].map((c) => c.textContent)).toEqual([
			'100%',
			'100%'
		]);
	});

	it('⛔ AND ON THE WIRE: the saved columnMap is keyed by the NAME, never by the row index', async () => {
		await openMappingPanel();
		change(mapSelects()[1]!, 'ent-1::amount');

		const save = buttonByText('datasets_mapping_save');
		expect(save, 'the mapping Save button is not on screen, so this case tests nothing').toBeDefined();
		click(save!);
		await settle(() => saveMappingsFn.mock.calls.length > 0);

		expect(saveMappingsFn, 'the save never reached the API').toHaveBeenCalledTimes(1);
		const [slug, mappings] = saveMappingsFn.mock.calls[0] as [string, Array<Record<string, unknown>>];
		expect(slug).toBe('claims-2026');
		expect(mappings).toHaveLength(1);
		// ⛔ THE ASSERTION THE WHOLE PANEL EXISTS FOR. `toEqual` on the WHOLE object, not
		// `toHaveProperty('Amount')`: a value keyed by the render index would send `{ '1': 'amount' }`,
		// and a partial check would let `{ Amount: 'amount', '1': 'amount' }` through as well.
		expect(mappings[0]!.columnMap).toEqual({ Amount: 'amount' });
		expect(mappings[0]).toMatchObject({
			entityId: 'ent-1',
			industry: 'insurance',
			department: 'Claims'
		});
	});
});
