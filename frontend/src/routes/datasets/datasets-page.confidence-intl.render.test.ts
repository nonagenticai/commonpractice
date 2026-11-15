// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.confidence-intl.render.test.ts — the mapping-confidence chip is
// the last un-Intl'd number on the demo journey.
//
// ⛔ THE DEFECT. `+page.svelte:776` rendered the chip as `{Math.round(pick.confidence * 100)}%`.
// Every other user-facing figure in the same file already goes through `num(x, locale.current)`
// (`:566`, `:567`, `:583`, `:659`), so under `ar` the chip printed Latin digits with a bare '%'
// beside neighbours that `Intl` had localized — and the '%' is a NEUTRAL character. Between a Latin
// digit run and Arabic text with no directional anchor, UAX#9 resolves it to the RTL base level and
// renders it on the WRONG SIDE of the number. `Intl`'s `style: 'percent'` emits the U+200E marks
// that pin it; a template literal cannot.
//
// ⛔ WHY A RENDER TEST AND NOT ONLY `format.percent.test.ts`. That file proves `pct()` is correct.
// It cannot prove the SCREEN calls it — the defect was never in a helper, it was one call site
// bypassing the helpers around it, and a unit test of a new function is exactly the shape that
// passes while the bypass stays put. This file mounts the real page, opens the real drawer, and
// reads the real chip out of the DOM.
//
// ⚠️ HARNESS COPIED FROM `datasets-page.locale-refetch.render.test.ts` — same alias-id mocks, same
// `settle()`, same "drive the locale rune directly, never `locale.set()`" note (that method fires an
// unmocked PATCH to `/api/me/locale`). Read that file for why each piece is shaped this way.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetMapping, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';
import { locale } from '$lib/stores/locale.svelte';

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

// ⛔ ESCAPES, NOT THE LITERAL CHARACTERS — both are invisible in an editor. This very line was
// first written with a plain ASCII space and failed as `expected '86 %' to be '86 %'`.
const NBSP = '\u00A0'; // NO-BREAK SPACE
const LRM = '\u200E'; // LEFT-TO-RIGHT MARK

/**
 * ⛔ 0.855, NOT 0.9. The value has to ROUND (85.5 → 86) so the chip's figure is not one a
 * truncating or a raw-value render would also produce, and it has to sit ABOVE `mapThreshold`
 * (0.7) so the `.low` class does not change what is on screen out from under the assertion.
 */
const CONFIDENCE = 0.855;
const ATTR = 'premie';
const COLUMN = 'amount';

function row(): DatasetRow {
	return {
		id: 'd1',
		slug: 'claims-2026',
		name: 'Dataset claims-2026',
		sourceType: 'csv',
		columns: [{ name: COLUMN, type: 'number', pii: false }],
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

/** A saved mapping — the only route into the panel without hand-driving the industry chips.
 *  `+page.svelte:179` pre-fills `working[col].confidence` from `mp.confidence`, which is the
 *  value the chip renders. */
const mapping = (): DatasetMapping => ({
	id: 'map-1',
	entityId: 'ent-1',
	entityName: 'BrokerNote',
	entityLabel: 'Broker note',
	industry: 'insurance',
	department: 'Claims',
	columnMap: { [COLUMN]: ATTR },
	confidence: CONFIDENCE,
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
			id: 'ent-1',
			key: 'industry_dept:insurance:Claims:BrokerNote',
			name: 'BrokerNote',
			label: 'Broker note',
			synonyms: [],
			description: null,
			scope: 'industry_dept',
			tenantOwned: false,
			attributes: [{ name: ATTR, type: 'number', synonyms: [], pii: false, description: null }]
		}
	],
	relations: [],
	hidden: []
});

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

async function settle(times = 20) {
	for (let i = 0; i < times; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	await tick();
}

const chipText = () => host.querySelector('.conf-chip')?.textContent ?? '';

/** Mount, open the preview drawer, and land in the mapping panel. */
async function openPanel() {
	listDatasets.mockResolvedValue(listResponse());
	getDataset.mockResolvedValue(detail());
	listMappings.mockResolvedValue({ mappings: [mapping()] });
	matrixFn.mockResolvedValue(matrix);
	ontologyGet.mockResolvedValue(cell());

	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	await settle();
	const btn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'datasets_preview'
	);
	expect(btn, 'the Preview button is not on screen, so this file tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root; a non-bubbling synthetic
	// click skips the handler and every assertion below passes for free.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	// ⛔ THE POSITIVE MARKERS. Without them, a "differs from the naive string" assertion is
	// satisfied by an empty string from a drawer that never opened.
	expect(host.querySelector('.schema-row'), 'the preview drawer never opened').not.toBeNull();
	expect(host.querySelector('.map-row select'), 'the attribute picker is not on screen').not.toBeNull();
	expect(host.querySelector('.conf-chip'), 'the confidence chip is not on screen').not.toBeNull();
}

/** Drive a REAL locale change, the way the topbar switcher does — minus the network.
 *  ⚠️ Assigned directly, never via `locale.set()`: that fires an unmocked PATCH to /api/me/locale. */
async function switchTo(tag: string) {
	locale.current = tag as typeof locale.current;
	flushSync();
	await settle();
}

beforeEach(() => {
	for (const m of [listDatasets, getDataset, listMappings, matrixFn, ontologyGet]) m.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	locale.current = initialLocale;
	flushSync();
});

describe('/datasets renders the mapping-confidence chip through Intl', () => {
	it('⛔ under `ar` the chip is NOT the naive `Math.round(x*100) + "%"` string', async () => {
		await openPanel();
		await switchTo('ar');

		const naive = `${Math.round(CONFIDENCE * 100)}%`;
		expect(naive, 'the fixture no longer rounds — pick a value that does').toBe('86%');
		// THE DEFECT, BY NAME. This is the assertion that reddens if `:776` goes back to a template.
		expect(chipText(), 'the chip is still the hard-coded English percent string').not.toBe(naive);
		// …and it is the measured ar form: LEFT-TO-RIGHT MARKs bracketing the sign, which is what
		// keeps '%' on the correct side of the number in an RTL run.
		expect(chipText()).toBe(`86${LRM}%${LRM}`);
	});

	it('⛔ and under `fr` it gains the NO-BREAK SPACE the naive string cannot have', async () => {
		await openPanel();
		await switchTo('fr');
		expect(chipText()).toBe(`86${NBSP}%`);
		expect(chipText()).not.toBe('86%');
	});

	it('the figure itself is unchanged for en — this is a formatting fix, not a maths one', async () => {
		// ⚠️ SAID OUT LOUD BECAUSE IT IS THE HALF THAT LOOKS LIKE A NO-OP. `en`, `nl`, `he` and `pl`
		// render exactly what the template rendered; only de/fr/es/ar differ. A reader checking the
		// Dutch screen for a visible change will not find one, and that is correct.
		await openPanel();
		expect(chipText()).toBe('86%');
		await switchTo('nl');
		expect(chipText()).toBe('86%');
	});

	it('the chip reacts to the locale rune at all — the value is not frozen at mount', async () => {
		// NON-VACUITY for the two cases above: if the chip were computed once at mount, `ar` would
		// still show the `en` string and "differs from naive" would be FALSE rather than passing for
		// the wrong reason — but the reverse mistake (a chip that never updates yet happens to match)
		// is worth ruling out directly.
		await openPanel();
		const before = chipText();
		await switchTo('de');
		expect(chipText(), 'the chip did not re-render on a locale change').not.toBe(before);
		expect(chipText()).toBe(`86${NBSP}%`);
	});
});
