// @vitest-environment jsdom
//
// src/routes/datasets/datasets-page.locale-refetch.render.test.ts — the dataset→ontology mapping
// panel must speak the reader's language, and must keep doing so after they switch it.
//
// ⛔ TWO DEFECTS, AND THEY ARE INDEPENDENT. Fixing either alone leaves a Dutch reader wrong.
//
// (1) THE LOCALIZED HALF WAS ARRIVING AND BEING THROWN AWAY. `GET /api/datasets/:slug/mappings`
//     resolves `entityLabel` per `Accept-Language` (backend/src/routes/datasets.ts:511 →
//     `listMappings` → `localizeEntityLabels`), and `GET /api/ontology` resolves the compiled
//     cell's `entities[].label` (ontology.ts:125). This page rendered `mp.entityName` and
//     `` `${e.name}.${a.name}` `` — the canonical English concept nouns off `ontology_entities.name`
//     — so /ontology called a row "Tussenpersoon-notitie" while this drawer called the SAME row
//     "Broker Note", two clicks apart, in the same session.
//
// (2) NOTHING RE-READ THEM ON A LANGUAGE SWITCH. `/datasets` was the one server-localized screen
//     with no `reloadOnLocaleChange` (`onMount(load);` and nothing else), and both localized fields
//     are fetched exactly once, when the drawer opens. So even with (1) fixed the panel froze in
//     whichever language the drawer happened to be opened in.
//
// ⚠️ AND THE FIX THAT WOULD HAVE BEEN A NO-OP. The obvious idiom `reloadOnLocaleChange(load)` — the
// one every other screen on this helper uses — refetches `GET /api/datasets`, a route that calls no
// `negotiateLocale` at all (datasets.ts:320). Every field the ROSTER renders is the reader's own
// data or a browser-side label that re-renders off the locale rune with no request. The last case
// pins that the roster fetch is NOT re-issued, so a future "just add it like the other pages" edit
// reds here instead of shipping a silent extra round-trip.
//
// ⚠️ AND THE FIX THAT WOULD HAVE BEEN WORSE THAN THE DEFECT. `loadMappingState(slug)` resets
// `working = {}`, `mapIndustry` and `mapDepartment`. Wiring THAT to the locale switch would delete
// every unsaved column pick the moment a reader touched the language switcher — no undo, no
// autosave. Case 4 is that guard, and it is the same one block-edit.locale-refetch.render.test.ts
// holds for the docs editor.
//
// ⛔ THE ANTI-VACUITY RULE. Every case asserts the Dutch is present AND the English is gone AND the
// panel still exists with the right number of rows — "the English is absent" is satisfied by a page
// that crashed. The two language fixtures share no substring in either direction, checked in the
// first case rather than assumed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DatasetDetail, DatasetList, DatasetMapping, DatasetRow } from '$lib/types/datasets';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';
import { locale } from '$lib/stores/locale.svelte';

// Real `en` catalog, each key resolving to its own name — the chrome is not the subject here. This
// file is about the API-fetched ontology vocabulary inside the drawer, which no message catalog can
// reach.
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

/**
 * ⛔ NO SUBSTRING OVERLAP IN EITHER DIRECTION, pinned by the first case. Every assertion below is
 * "the Dutch is present AND the English is absent"; a shared word would let one half be satisfied
 * by the other language's text. The attribute key `premie` is deliberately NOT translated — it is
 * the `columnMap` key, and case 3 pins that it stays put while the entity around it moves.
 */
const EN = { label: 'Broker note' };
const NL = { label: 'Tussenpersoonbericht' };
/** The canonical concept noun off `ontology_entities.name`. Shares nothing with either label, so
 *  "the English label is gone" cannot be satisfied by this leaking through instead. */
const CANONICAL = 'Zzcanonical';
const ATTR = 'premie';

function row(): DatasetRow {
	return {
		id: 'd1',
		slug: 'claims-2026',
		name: 'Dataset claims-2026',
		sourceType: 'csv',
		columns: [{ name: 'amount', type: 'number', pii: false }],
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

/** A saved mapping, which is what makes `loadMappingState` pick a cell and fetch it — the only
 *  route into the panel without hand-driving the industry/department chips. */
const mapping = (label: string): DatasetMapping => ({
	id: 'map-1',
	entityId: 'ent-1',
	entityName: CANONICAL,
	entityLabel: label,
	industry: 'insurance',
	department: 'Claims',
	columnMap: { amount: ATTR },
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

const cell = (label: string): CompiledOntology => ({
	industry: 'insurance',
	department: 'Claims',
	entities: [
		{
			id: 'ent-1',
			key: 'industry_dept:insurance:Claims:BrokerNote',
			name: CANONICAL,
			label,
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

const savedEnt = () => [...host.querySelectorAll('.saved-ent')].map((n) => n.textContent);
const mapSelect = () => host.querySelector<HTMLSelectElement>('.map-row select');
const optionTexts = () => [...(mapSelect()?.options ?? [])].map((o) => o.textContent);
const optionValues = () => [...(mapSelect()?.options ?? [])].map((o) => o.value);
const panelText = () => host.querySelector('.drawer')?.textContent ?? host.textContent ?? '';

/**
 * Drive a REAL locale change, the way the topbar switcher does — minus the network.
 *
 * ⚠️ ASSIGNED DIRECTLY, NEVER VIA `locale.set()`: that method fires an unmocked `authFetch` PATCH
 * to `/api/me/locale`. The rune assignment IS the trigger — `reloadOnLocaleChange` tracks
 * `locale.current` and nothing else.
 */
async function switchToDutch() {
	locale.current = 'nl';
	flushSync();
	await settle();
}

/** Mount, open the preview drawer, and land in the mapping panel with the ENGLISH payloads. */
async function openPanel() {
	listDatasets.mockResolvedValue(listResponse());
	getDataset.mockResolvedValue(detail());
	listMappings.mockResolvedValue({ mappings: [mapping(EN.label)] });
	matrixFn.mockResolvedValue(matrix);
	ontologyGet.mockResolvedValue(cell(EN.label));

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

	// ⛔ THE POSITIVE MARKERS. Without them, "the English is gone" passes against a drawer that never
	// opened or a panel that never fetched.
	expect(host.querySelector('.schema-row'), 'the preview drawer never opened').not.toBeNull();
	expect(listMappings, 'the mapping panel never fetched').toHaveBeenCalled();
	expect(ontologyGet, 'the compiled cell was never fetched').toHaveBeenCalled();
	expect(mapSelect(), 'the attribute picker is not on screen').not.toBeNull();
}

beforeEach(() => {
	listDatasets.mockReset();
	getDataset.mockReset();
	listMappings.mockReset();
	matrixFn.mockReset();
	ontologyGet.mockReset();
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

describe('/datasets relocalizes its ontology vocabulary when the reader switches language', () => {
	it('the fixtures really are different, and none contains another', () => {
		for (const [a, b] of [
			[EN.label, NL.label],
			[NL.label, EN.label],
			[CANONICAL, EN.label],
			[CANONICAL, NL.label],
			[EN.label, CANONICAL],
			[NL.label, CANONICAL]
		]) {
			expect(a!.includes(b!), `"${a}" must not contain "${b}"`).toBe(false);
		}
	});

	it('⛔ DEFECT 1: the saved mapping shows the reader’s LABEL, never the canonical concept noun', async () => {
		// RED AGAINST `{mp.entityName}`: `savedEnt()` is `['Zzcanonical']` and both assertions invert.
		await openPanel();
		expect(savedEnt()).toEqual([EN.label]);
		expect(
			panelText(),
			'the drawer printed the canonical ontology noun at a reader'
		).not.toContain(CANONICAL);
	});

	it('⛔ DEFECT 1, second site: the attribute picker’s OPTION TEXT is the label, its VALUE is not', async () => {
		// RED AGAINST ``label: `${e.name}.${a.name}` ``.
		await openPanel();
		expect(optionTexts()).toEqual(['datasets_mapping_unmapped', `${EN.label}.${ATTR}`]);
		// ⛔ THE WIRE IS THE HALF THAT MUST NOT MOVE. `setColMapping` splits this value on `::` and
		// `saveMappings` sends both halves; a localized value would post an entity id that is a Dutch
		// noun. Same rule ontology-axis-label.ts states for every ontology `<select>`.
		expect(optionValues()).toEqual(['', `ent-1::${ATTR}`]);
	});

	it('⛔ DEFECT 2: a locale switch re-reads both payloads and the panel is Dutch, with no English left', async () => {
		await openPanel();
		// The English is genuinely on screen first — otherwise the "absent" half proves nothing.
		expect(panelText()).toContain(EN.label);
		expect(panelText()).not.toContain(NL.label);
		const mappingCalls = listMappings.mock.calls.length;
		const cellCalls = ontologyGet.mock.calls.length;

		listMappings.mockResolvedValue({ mappings: [mapping(NL.label)] });
		ontologyGet.mockResolvedValue(cell(NL.label));
		await switchToDutch();

		// The requests really were re-issued. (The locale rides on `Accept-Language`, not on the
		// arguments, so the arguments are unchanged — the COUNT is the observable.)
		expect(
			listMappings.mock.calls.length,
			'the locale switch did not re-read the saved mappings'
		).toBe(mappingCalls + 1);
		expect(
			ontologyGet.mock.calls.length,
			'the locale switch did not re-read the compiled cell'
		).toBe(cellCalls + 1);

		// The panel still exists and still holds its row — not a blank drawer, not a husk.
		expect(host.querySelectorAll('.saved-map')).toHaveLength(1);
		expect(savedEnt()).toEqual([NL.label]);
		expect(optionTexts()).toEqual(['datasets_mapping_unmapped', `${NL.label}.${ATTR}`]);
		// …and the English is GONE. Red by deleting `reloadOnLocaleChange` from the page.
		expect(panelText()).not.toContain(EN.label);
		expect(panelText()).not.toContain(CANONICAL);
	});

	it('⛔ …and an UNSAVED column pick survives the switch untouched', async () => {
		// RED AGAINST `reloadOnLocaleChange(() => loadMappingState(selected.slug))`, which resets
		// `working`, `mapIndustry` and `mapDepartment`. There is no undo on this screen.
		await openPanel();
		const select = mapSelect()!;
		select.value = `ent-1::${ATTR}`;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle(4);
		expect(mapSelect()!.value, 'the pick never reached `working`').toBe(`ent-1::${ATTR}`);
		expect(host.querySelector('.conf-chip')?.textContent).toBe('100%');

		listMappings.mockResolvedValue({ mappings: [mapping(NL.label)] });
		ontologyGet.mockResolvedValue(cell(NL.label));
		await switchToDutch();

		// The relocalization happened…
		expect(savedEnt()).toEqual([NL.label]);
		// …and it did NOT reach into the reader's working set. The chip is the load-bearing half:
		// `working[amount]` is what `saveMappings` posts, and a reset would drop the row to unmapped.
		expect(
			mapSelect()!.value,
			'the locale switch destroyed the reader’s unsaved column mapping'
		).toBe(`ent-1::${ATTR}`);
		expect(host.querySelector('.conf-chip')?.textContent).toBe('100%');
	});

	it('the ROSTER fetch is NOT re-issued — nothing in `GET /api/datasets` is localized', async () => {
		// ⛔ THE OVER-FIX GUARD, and the reason this page does not just call
		// `reloadOnLocaleChange(load)` like its siblings. `listDatasets` hits a route with no
		// `negotiateLocale` (backend/src/routes/datasets.ts:320); everything the roster renders is the
		// reader's own data or a browser-side label that re-renders off the rune. Re-running it would
		// be a round-trip that changes not one pixel — on the screen a demo opens first.
		await openPanel();
		const rosterCalls = listDatasets.mock.calls.length;
		listMappings.mockResolvedValue({ mappings: [mapping(NL.label)] });
		ontologyGet.mockResolvedValue(cell(NL.label));
		await switchToDutch();
		expect(listDatasets.mock.calls.length, 'the roster was refetched for nothing').toBe(
			rosterCalls
		);
	});

	it('⛔ the locale effect must not subscribe to `selected`: a later drawer open stays ONE fetch', async () => {
		// ⛔ THE TRAP IN THE SHARED IDIOM, and the whole reason for the `untrack` at the call site.
		// `reloadOnLocaleChange` runs its callback INSIDE a `$effect`, and Svelte re-collects an
		// effect's dependencies on every run. The first run returns early (`first`), so it tracks only
		// `locale.current`. The SECOND run actually invokes the callback — and a bare call would read
		// `selected?.slug` synchronously, inside the tracking window, making the locale effect a
		// second subscriber to `selected`. From then on every drawer open fires BOTH `loadMappingState`
		// and the locale effect: two identical `listMappings` requests per open, forever.
		//
		// ⚠️ `selected` IS THE ONLY ONE AT RISK, which is narrower than this comment first claimed.
		// `mapIndustry`/`mapDepartment` are read AFTER the first `await`, i.e. in a later microtask and
		// outside the synchronous tracking window, so they were never subscribable either way — the
		// same mechanism that made `$effect` blind to the locale rune in the first place (see
		// blocks-page.locale-refetch.render.test.ts's note on `authFetch`).
		await openPanel();
		expect(listMappings).toHaveBeenCalledTimes(1);

		listMappings.mockResolvedValue({ mappings: [mapping(NL.label)] });
		ontologyGet.mockResolvedValue(cell(NL.label));
		await switchToDutch();
		expect(listMappings, 'the relocalize did not run, so the trap is not armed').toHaveBeenCalledTimes(2);

		// Close and re-open the drawer — `inspect()` reassigns `selected`, which is the trigger.
		const close = host.querySelector('button.icon-x') as HTMLButtonElement;
		expect(close, 'the drawer close button is not on screen').not.toBeNull();
		close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(6);
		expect(host.querySelector('.schema-row'), 'the drawer never closed').toBeNull();

		const preview = [...host.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'datasets_preview'
		);
		expect(preview, 'the Preview button is not back on screen').toBeDefined();
		preview!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		// ⛔ THE POSITIVE HALF FIRST: the panel really did re-open and re-fetch.
		expect(host.querySelector('.schema-row'), 'the drawer never re-opened').not.toBeNull();
		expect(
			listMappings,
			'the drawer open fired twice — the locale effect is subscribed to `selected`'
		).toHaveBeenCalledTimes(3);
	});

	it('the mount itself does not double any fetch — the reload skips its first run', async () => {
		// Guards the variant that "just uses a plain $effect": `reloadOnLocaleChange` deliberately
		// returns on its first pass because `onMount`/the drawer already covers it.
		await openPanel();
		expect(listDatasets).toHaveBeenCalledTimes(1);
		expect(listMappings).toHaveBeenCalledTimes(1);
		expect(ontologyGet).toHaveBeenCalledTimes(1);
	});

	it('with NO drawer open a locale switch fetches nothing at all', async () => {
		// `relocalizeMappingPanel` returns early on `!selected`. Without that a language switch on the
		// bare roster would fire `listMappings(undefined)`.
		listDatasets.mockResolvedValue(listResponse());
		app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
		await settle();
		expect(host.querySelectorAll('tbody tr').length, 'the roster never rendered').toBeGreaterThan(
			0
		);

		await switchToDutch();
		expect(listMappings).not.toHaveBeenCalled();
		expect(ontologyGet).not.toHaveBeenCalled();
		expect(listDatasets).toHaveBeenCalledTimes(1);
	});
});
