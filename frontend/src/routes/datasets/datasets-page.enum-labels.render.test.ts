// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.enum-labels.render.test.ts — /datasets stopped printing two
// backend enums at a reader.
//
// ⛔ THE DEFECT, ON A SCREEN THAT IS NAV-OPEN TO EVERY TENANT MEMBER (navConfig.ts, no role gate).
// Three sites rendered the enum itself:
//   • the roster's Source column   <span class="badge teal">{d.sourceType}</span>
//   • the schema editor's dropdown <option value={t}>{t}</option>
//   • the mapping drawer's rows    <span class="map-coltype">{col.type}</span>
// so a Dutch employee loading their own test data read "csv" under a column headed "Bron", picked a
// type from a list spelling "string / number / boolean", and saw those same English words again
// beside every column in the mapping drawer. The badge sitting IMMEDIATELY BESIDE the first one
// (`m.connector_test_source()`) was already localized, and the chips two panels below the third one
// were localized in the same pass that missed this — which is what makes these an oversight rather
// than a convention.
//
// ⛔ THE ENUM STAYS ON THE WIRE, AND THIS FILE PINS THAT AS HARD AS THE TEXT. `<option value>` is
// what `updateColumns` PUTs back; a "fix" that translated the VALUE would send `tekst` to a column
// typed `'string' | 'number' | …` and corrupt the schema of a dataset. Each case asserts the value
// attribute as well as the label.
//
// ⛔ AND EVERY CASE ASSERTS THE POSITIVE HALF. `not.toContain('csv')` over a page that never
// mounted is green, so the rows are counted and the label is read by its own text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetMapping, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name. The assertions are about WHICH key each
// enum reaches, never the wording — a reworded translation must not red this file.
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
		updateColumns: vi.fn(),
		listMappings,
		saveMapping: vi.fn(),
		deleteMapping: vi.fn(),
		suggestMappings: vi.fn()
	},
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message: string
		) {
			super(message);
		}
	}
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

function row(id: string, slug: string, sourceType: string): DatasetRow {
	return {
		id,
		slug,
		name: `Dataset ${slug}`,
		sourceType,
		columns: [
			{ name: 'claim_id', type: 'string', pii: false },
			{ name: 'amount', type: 'number', pii: false }
		],
		rowCount: 12,
		sizeBytes: 2048,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	} as DatasetRow;
}

const listResponse = (items: DatasetRow[]): DatasetList => ({
	items,
	total: items.length,
	page: 1,
	pageSize: 20,
	canManage: true
});

const detail = (r: DatasetRow): DatasetDetail => ({ ...r, rows: [], offset: 0, limit: 50 });

/** A saved mapping, so `loadMappingState` picks a cell and `loadCell()` fetches it — that is the
 *  only route to the `map-coltype` render site without hand-driving four chips. */
const savedMapping: DatasetMapping = {
	id: 'map-1',
	entityId: 'ent-1',
	entityName: 'Claim',
	entityLabel: 'Claim',
	industry: 'insurance',
	department: 'Claims',
	columnMap: {},
	confidence: 0.9,
	source: 'human',
	confirmed: true,
	updatedAt: '2026-06-01T09:00:00.000Z'
};

const matrix: MatrixData = { industries: ['insurance'], departments: ['Claims'], cells: [] } as MatrixData;

const compiled: CompiledOntology = {
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
			attributes: [{ name: 'amount', type: 'number', synonyms: [], pii: false, description: null }]
		}
	],
	relations: [],
	hidden: []
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listDatasets.mockReset();
	getDataset.mockReset();
	listMappings.mockReset();
	matrixFn.mockReset();
	ontologyGet.mockReset();
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

async function render(items: DatasetRow[]): Promise<HTMLElement> {
	listDatasets.mockResolvedValue(listResponse(items));
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	for (let i = 0; i < 20 && host.textContent?.includes('datasets_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('datasets_loading');
	return host;
}

/** Open the preview/edit drawer on a row, which is where both column-type sites live. */
async function openDrawer(r: DatasetRow) {
	getDataset.mockResolvedValue(detail(r));
	const btn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'datasets_preview'
	);
	expect(btn, 'the Preview button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	for (let i = 0; i < 20 && !host.querySelector('.schema-row'); i++) {
		await new Promise((r2) => setTimeout(r2, 0));
		flushSync();
	}
	await tick();
	expect(host.querySelector('.schema-row'), 'the drawer never opened').not.toBeNull();
}

const sourceBadges = () => [...host.querySelectorAll('td .badge.teal')].map((n) => n.textContent?.trim());

describe('the roster Source column', () => {
	it('THE DEFECT: an upload kind renders its catalog key, not the enum', async () => {
		await render([row('d1', 'claims-2026', 'csv')]);
		expect(sourceBadges()).toEqual(['dataset_source_csv']);
		// ⛔ The inverse assertion — this is what reds on a revert to `{d.sourceType}`.
		expect(host.querySelector('td .badge.teal')!.textContent).not.toBe('csv');
	});

	it('a connector kind too, and the localized neighbour badge is still beside it', async () => {
		await render([row('d1', 'live-claims', 'postgres')]);
		expect(sourceBadges()).toEqual(['dataset_source_postgres']);
		// The POSITIVE half: the row is fully rendered, including the test-source badge whose
		// already-localized presence is what made the raw enum next to it read as an oversight.
		expect(host.textContent).toContain('connector_test_source');
		expect(host.textContent).toContain('Dataset live-claims');
	});

	it('ALL EIGHT KINDS resolve — no member falls through to the raw enum', async () => {
		const kinds = ['csv', 'xlsx', 'sql', 'text', 'json', 'postgres', 'storage', 'http'];
		await render(kinds.map((k, i) => row(`d${i}`, `ds-${k}`, k)));
		expect(sourceBadges()).toEqual(kinds.map((k) => `dataset_source_${k}`));
	});

	it('AN UNKNOWN KIND DEGRADES TO ITSELF, not to a blank badge', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. A `default:` returning '' would satisfy every "the enum is
		// not on screen" assertion above while rendering an empty coloured rectangle — a dataset
		// that appears to have no source at all.
		await render([row('d1', 'future', 'sftp')]);
		expect(sourceBadges()).toEqual(['sftp']);
	});
});

describe('the schema editor dropdown', () => {
	it('THE DEFECT: the five options read as words while their VALUES stay the enum', async () => {
		const r = row('d1', 'claims-2026', 'csv');
		await render([r]);
		await openDrawer(r);

		const select = host.querySelector('.schema-row select') as HTMLSelectElement;
		const opts = [...select.options];
		expect(opts.map((o) => o.value)).toEqual(['string', 'number', 'boolean', 'date', 'json']);
		expect(opts.map((o) => o.textContent)).toEqual([
			'dataset_coltype_string',
			'dataset_coltype_number',
			'dataset_coltype_boolean',
			'dataset_coltype_date',
			'dataset_coltype_json'
		]);
		// ⛔ THE WIRE IS THE HALF THAT CANNOT BE ALLOWED TO MOVE: a translated value would PUT
		// `tekst` into a column typed `'string' | …` and corrupt the dataset's schema.
		expect(select.value, 'the selected value is no longer the enum the backend stores').toBe('string');
	});
});

describe('the mapping drawer column-type chip', () => {
	it('THE DEFECT: `{col.type}` beside each column name is now a word', async () => {
		listMappings.mockResolvedValue({ mappings: [savedMapping] });
		const r = row('d1', 'claims-2026', 'csv');
		await render([r]);
		await openDrawer(r);
		for (let i = 0; i < 20 && !host.querySelector('.map-coltype'); i++) {
			await new Promise((r2) => setTimeout(r2, 0));
			flushSync();
		}

		const chips = [...host.querySelectorAll('.map-coltype')].map((n) => n.textContent?.trim());
		expect(chips, 'the mapping rows never rendered — this case would prove nothing').toEqual([
			'dataset_coltype_string',
			'dataset_coltype_number'
		]);
		// The POSITIVE half: the column NAMES are still beside them, so this is the real panel.
		expect(host.querySelector('.map-rows')!.textContent).toContain('claim_id');
		expect(host.querySelector('.map-rows')!.textContent).toContain('amount');
	});
});
