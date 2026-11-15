// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.schema-save-keeps-mapping.render.test.ts — "Schema opslaan"
// must not throw away the mapping work sitting under it.
//
// ⛔ THE DEFECT. `saveSchema` ended in
//
//     await Promise.all([inspect(selected.slug), load()]);
//
// and `inspect` calls `loadMappingState`, which resets `mapCell`, `working`, `mapIndustry` and
// `mapDepartment` unconditionally. `working` is the editable proposal set — everything "Voorstel
// doen" produced plus every correction made by hand — and it is not persisted ANYWHERE until
// "Koppelingen opslaan" is pressed. So the sequence the drawer's own layout invites (the schema
// block sits ABOVE the mapping block): map a dozen columns, notice a column is typed wrong or
// should be flagged PII, flip it, press Save — and every pick is gone. No prompt, no warning, and a
// successful save.
//
// ⛔ PRESERVING RATHER THAN WARNING, AND THE BACKEND IS WHY. `working` is keyed by COLUMN NAME, and
// `PATCH /api/datasets/:slug` REFUSES a column-set change: it compares submitted names against
// stored names as SETS and throws `columns_mismatch` unless they are identical (plus
// `duplicate_column` on a repeat) — `backend/src/routes/datasets.ts`. A save that returns 200 can
// therefore only have retyped a column or flipped its PII flag, neither of which `WorkingPick`
// records. There is no state in the mapping panel a successful schema save can invalidate, so a
// "you are about to lose your work" dialog would be asking the reader to approve a loss that has no
// reason to happen.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, and where the proof lives: that the backend really rejects a
// changed column set is `backend/tests/`' own subject. A mocked client here returns what it is told.
// What this file pins is that the FRONTEND stopped discarding on the strength of that guarantee.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetMapping, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

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

const { listDatasets, getDataset, listMappings, updateDataset, matrixFn, ontologyGet } = vi.hoisted(
	() => ({
		listDatasets: vi.fn(),
		getDataset: vi.fn(),
		listMappings: vi.fn(),
		updateDataset: vi.fn(),
		matrixFn: vi.fn(),
		ontologyGet: vi.fn()
	})
);
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
// ⚠️ AND EVERY NAME BELOW IS THE CLIENT'S REAL ONE: `update` (not `updateColumns`) and
// `saveMappings` (not `saveMapping`). A sibling spec in this very directory stubs `saveMapping` for
// a client that only has `saveMappings`; the page's call would hit `undefined`, its own catch would
// swallow the TypeError, and everything downstream of it is vacuous. Checked against
// `$lib/api/datasets.ts`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: {
		list: listDatasets,
		listAll: vi.fn(),
		get: getDataset,
		uploadFile: vi.fn(),
		paste: vi.fn(),
		remove: vi.fn(),
		update: updateDataset,
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
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

/** Column ONE arrives with a saved mapping; column TWO is mapped by hand in the test and is the
 *  unsaved work the defect destroyed. */
const COL_SAVED = 'bedrag';
const COL_UNSAVED = 'polisnummer';
const ATTR_SAVED = 'premie';
const ATTR_UNSAVED = 'polis';
const ENTITY = 'ent-1';

function row(): DatasetRow {
	return {
		id: 'd1',
		slug: 'claims-2026',
		name: 'Dataset claims-2026',
		sourceType: 'csv',
		columns: [
			{ name: COL_SAVED, type: 'number', pii: false },
			{ name: COL_UNSAVED, type: 'string', pii: false }
		],
		rowCount: 12,
		sizeBytes: 2048,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	} as DatasetRow;
}
const DS = row();
const listResponse = (): DatasetList => ({
	items: [DS],
	total: 1,
	page: 1,
	pageSize: 20,
	canManage: true
});
const detail = (): DatasetDetail => ({ ...DS, rows: [], offset: 0, limit: 50 });

const mapping = (): DatasetMapping => ({
	id: 'map-1',
	entityId: ENTITY,
	entityName: 'BrokerNote',
	entityLabel: 'Broker note',
	industry: 'insurance',
	department: 'Claims',
	columnMap: { [COL_SAVED]: ATTR_SAVED },
	confidence: 0.9,
	source: 'human',
	confirmed: true,
	updatedAt: '2026-06-01T09:00:00.000Z'
});

const matrix: MatrixData = {
	industries: ['insurance'],
	departments: ['Claims'],
	cells: []
} as MatrixData;

const cell = (): CompiledOntology => ({
	industry: 'insurance',
	department: 'Claims',
	entities: [
		{
			id: ENTITY,
			key: 'industry_dept:insurance:Claims:BrokerNote',
			name: 'BrokerNote',
			label: 'Broker note',
			synonyms: [],
			description: null,
			scope: 'industry_dept',
			tenantOwned: false,
			attributes: [
				{ name: ATTR_SAVED, type: 'number', synonyms: [], pii: false, description: null },
				{ name: ATTR_UNSAVED, type: 'string', synonyms: [], pii: false, description: null }
			]
		}
	],
	relations: [],
	hidden: []
});

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle(times = 20) {
	for (let i = 0; i < times; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	await tick();
}

const mapSelects = () => [...host.querySelectorAll<HTMLSelectElement>('.map-row select')];
const schemaSelects = () => [...host.querySelectorAll<HTMLSelectElement>('.schema-row select')];
const saveButton = () =>
	[...host.querySelectorAll('.schema-actions button')].find((b) =>
		b.textContent?.trim().startsWith('datasets_sav')
	) as HTMLButtonElement | undefined;

/** Mount, open the preview drawer, and land in the mapping panel with both selects on screen. */
async function openPanel() {
	listDatasets.mockResolvedValue(listResponse());
	getDataset.mockResolvedValue(detail());
	listMappings.mockResolvedValue({ mappings: [mapping()] });
	matrixFn.mockResolvedValue(matrix);
	ontologyGet.mockResolvedValue(cell());
	updateDataset.mockResolvedValue({});

	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	await settle();
	const btn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'datasets_preview'
	);
	expect(btn, 'the Preview button is not on screen, so this file tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	// ⛔ THE POSITIVE MARKERS. Without them every "the pick survived" assertion is a claim about an
	// empty drawer, and every "the panel did not reload" assertion passes on a panel that never
	// loaded in the first place.
	expect(host.querySelector('.schema-row'), 'the preview drawer never opened').not.toBeNull();
	expect(mapSelects(), 'the mapping panel never rendered its column rows').toHaveLength(2);
	expect(mapSelects()[0]!.value, 'the saved mapping did not pre-fill').toBe(
		`${ENTITY}::${ATTR_SAVED}`
	);
}

/** Map the SECOND column by hand — the work that has never touched the server. */
async function mapSecondColumnByHand() {
	const sel = mapSelects()[1]!;
	expect(sel.value, 'the second column started out already mapped').toBe('');
	sel.value = `${ENTITY}::${ATTR_UNSAVED}`;
	sel.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
	expect(mapSelects()[1]!.value, 'the hand pick did not take — this file would prove nothing').toBe(
		`${ENTITY}::${ATTR_UNSAVED}`
	);
}

/** Retype the first column and press Save. */
async function editSchemaAndSave() {
	const typeSel = schemaSelects()[0]!;
	typeSel.value = 'string';
	typeSel.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();

	const save = saveButton();
	expect(save, 'the Save button is not on screen').toBeDefined();
	expect(save!.disabled, 'the edit never marked the drawer dirty, so Save is inert').toBe(false);
	save!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
	expect(updateDataset, 'the schema was never saved').toHaveBeenCalledTimes(1);
}

beforeEach(() => {
	for (const fn of [listDatasets, getDataset, listMappings, updateDataset, matrixFn, ontologyGet])
		fn.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

describe('/datasets: saving the schema keeps the mapping work under it', () => {
	it('⛔ THE DEFECT: a hand-made pick survives "Schema opslaan"', async () => {
		// REVERT THAT TURNS THIS RED: `await Promise.all([inspect(selected.slug), load()])`.
		// `loadMappingState` runs, `working = {}`, and this select goes back to "unmapped".
		await openPanel();
		await mapSecondColumnByHand();
		await editSchemaAndSave();

		expect(
			mapSelects()[1]!.value,
			'the schema save silently discarded a mapping the reader had made and not yet saved'
		).toBe(`${ENTITY}::${ATTR_UNSAVED}`);
	});

	it('⛔ …and so does the whole panel — cell, chips and the pre-filled pick', async () => {
		// `loadMappingState` resets FOUR things, not one: `mapCell` (which is what renders the rows at
		// all), `working`, `mapIndustry` and `mapDepartment`. A fix that restored only `working` would
		// leave the reader looking at an empty panel with their picks in a variable behind it.
		await openPanel();
		await mapSecondColumnByHand();
		await editSchemaAndSave();

		expect(mapSelects(), 'the mapping panel collapsed — mapCell was cleared').toHaveLength(2);
		expect(mapSelects()[0]!.value, 'the saved mapping was dropped too').toBe(
			`${ENTITY}::${ATTR_SAVED}`
		);
		expect(host.querySelectorAll('.conf-chip'), 'both picks should still show a confidence chip')
			.toHaveLength(2);
		// The industry/department chips are what `mapCell` was loaded from; losing them is how the
		// panel ends up empty.
		expect(host.querySelector('.map-chiprow .chip.active'), 'the ontology cell was reset').not.toBeNull();
	});

	it('⚠️ and the panel is not silently re-fetched behind the reader either', async () => {
		// The mapping panel reads a DIFFERENT table (`dataset_mappings`) that this PATCH does not
		// write — it sets only `name`, `sandbox_id` and `columns`. So the correct number of extra
		// mapping fetches caused by a schema save is zero, and a "fix" that re-fetched and then merged
		// would be racing the reader's own edits for no gain.
		await openPanel();
		await mapSecondColumnByHand();
		expect(listMappings).toHaveBeenCalledTimes(1);
		await editSchemaAndSave();
		expect(listMappings, 'the schema save re-ran the mapping loader').toHaveBeenCalledTimes(1);
	});

	it('⛔ THE SAVE STILL REFRESHES THE COLUMNS — the drawer is not frozen', async () => {
		// The complement, and the one a lazy fix breaks: dropping the `inspect()` call entirely would
		// satisfy every case above and leave the drawer showing a schema the server no longer has.
		await openPanel();
		expect(getDataset).toHaveBeenCalledTimes(1);
		await mapSecondColumnByHand();
		await editSchemaAndSave();
		expect(getDataset, 'the drawer stopped re-reading the saved schema').toHaveBeenCalledTimes(2);
		expect(saveButton()!.disabled, 'the drawer is still marked dirty after a successful save').toBe(true);
	});

	it('⛔ A FRESH OPEN STILL LOADS THE MAPPING STATE — the loader is not disabled', async () => {
		// The other complement. `keepMappingState` is passed by `saveSchema` ALONE; if it leaked into
		// the ordinary path the panel would come up blank on every dataset. Proved on a SECOND drawer
		// open, because the first one is what establishes the baseline.
		await openPanel();
		expect(listMappings).toHaveBeenCalledTimes(1);

		// Close and re-open the same dataset.
		(host.querySelector('.icon-x') as HTMLButtonElement).dispatchEvent(
			new MouseEvent('click', { bubbles: true })
		);
		await settle();
		const btn = [...host.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'datasets_preview'
		);
		btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(listMappings, 'reopening the drawer no longer loads the mapping panel').toHaveBeenCalledTimes(2);
		expect(mapSelects()[0]!.value).toBe(`${ENTITY}::${ATTR_SAVED}`);
	});
});
