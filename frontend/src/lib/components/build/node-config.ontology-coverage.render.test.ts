// @vitest-environment jsdom
//
// src/lib/components/build/node-config.ontology-coverage.render.test.ts — the /build inspector
// stops stating a coverage figure it never measured.
//
// ⛔ THE DEFECT. The card read
//
//     total: num(preview?.columns.length ?? cols.length, locale.current)
//
// so whenever the preview was absent the fraction collapsed to `cols.length / cols.length` and the
// panel announced "3 van 3 kolommen gekoppeld" — a 100% coverage figure derived from the mapped set
// counting ITSELF as the denominator. On a dataset with twelve columns and three mapped, that reads
// as fully mapped.
//
// ⛔ AND ABSENT IS NOT A CORNER — IT IS A RACE THE PANEL RUNS EVERY TIME. `loadPreview` and
// `loadMappings` are fired UN-AWAITED from the same `$effect`. Whenever the mappings resolve first
// the reader gets that sentence and it corrects a tick later; when the preview 500s it never
// corrects at all. The `?? cols.length` was a deliberate fallback, not a typo, which is exactly why
// it survived review: it produces a plausible number instead of a crash, and a wrong figure that
// looks right is the harder defect.
//
// ⛔ THE SECOND HALF, AND THE ONE THAT MATTERS MORE. `colIsPii` returned `Boolean(...)`, so an
// absent preview read as "not PII" for EVERY column and the PII badges simply did not render. A
// missing badge is indistinguishable from a column the ontology says is safe — on the panel where a
// builder decides what data a block may see. It is `boolean | null` now, and the chip claims PII
// only on an explicit `true`.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, same reason, as the sibling specs in this
// directory. And the mock really interpolates, because "3 van 3" versus "3 van 12" is the whole
// subject: a stub that discards its arguments renders both as "{mapped} van {total}".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore } from '$lib/stores/builder.svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetDetail, DatasetMapping, DatasetRow } from '$lib/types/datasets';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
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
// `list` is mocked but must never be called — the panel pages to completion via `listAll`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';

const SLUG = 'claims-2026';
/** TWELVE columns on the dataset, THREE of them mapped — the fraction the panel must state. */
const ALL_COLUMNS = [
	'bedrag',
	'polisnummer',
	'bsn',
	'datum',
	'status',
	'kanaal',
	'regio',
	'agent',
	'schadetype',
	'valuta',
	'notitie',
	'bron'
];
const MAPPED = ['bedrag', 'polisnummer', 'bsn'];
/** ⛔ ONE OF THE MAPPED COLUMNS IS PII. Without it the PII half of this file is unfalsifiable. */
const PII_COLUMN = 'bsn';

/** `messages/nl.json`, with the figures substituted in. */
const COVERAGE_TRUE = '3 van 12 kolommen gekoppeld aan Schadeclaim';
/** …and the sentence the defect produced: the mapped set as its own denominator. */
const COVERAGE_SELF = '3 van 3 kolommen gekoppeld aan Schadeclaim';
const SCHEMA_UNKNOWN = 'Structuur van de dataset niet geladen';

function dataset(): DatasetRow {
	return {
		id: `id-${SLUG}`,
		slug: SLUG,
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: ALL_COLUMNS.map((name) => ({ name, type: 'string' as const })),
		rowCount: 12_480,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

/** The preview response — this is the ONLY carrier of the dataset's column schema in this panel. */
function detail(): DatasetDetail {
	const d = dataset();
	return {
		...d,
		columns: ALL_COLUMNS.map((name) => ({
			name,
			type: 'string' as const,
			pii: name === PII_COLUMN
		})),
		rows: [{ bedrag: 1 }],
		offset: 0,
		limit: 5
	} as DatasetDetail;
}

function mapping(): DatasetMapping {
	return {
		id: 'map-1',
		entityId: 'ent-1',
		entityName: 'Claim',
		entityLabel: 'Schadeclaim',
		industry: 'insurance',
		department: 'Claims',
		columnMap: Object.fromEntries(MAPPED.map((c) => [c, `attr_${c}`])),
		confidence: 0.9,
		source: 'human',
		confirmed: true,
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetMapping;
}

function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/** A selected block whose one dataset input is already configured — that is what loads both fetches. */
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
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	listAll.mockResolvedValue(allDatasets([dataset()]));
	listMappings.mockResolvedValue({ mappings: [mapping()] });
	app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder() } }) as Record<
		string,
		unknown
	>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Everything below is an assertion about one `<div>`; on a panel that
 * rendered no ontology card at all, "the false fraction is gone" is true for free.
 */
function ontoCard(): HTMLElement {
	const el = host.querySelector('.onto');
	expect(el, 'the ontology card never rendered — this case tests nothing').not.toBeNull();
	return el as HTMLElement;
}
const coverage = () => ontoCard().querySelector('.onto-cov')?.textContent?.trim() ?? '';
const chips = () => [...ontoCard().querySelectorAll('.onto-chip')];
const piiChips = () => chips().filter((c) => c.classList.contains('pii'));

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset, listMappings]) fn.mockReset();
});

describe('the /build inspector states a coverage figure only when it has measured one', () => {
	it('⛔ THE DEFECT: a FAILED preview no longer produces "3 van 3"', async () => {
		// REVERT THAT TURNS THIS RED: `total: num(preview?.columns.length ?? cols.length, …)` with no
		// `{#if preview}` guard. The card then announces 100% coverage of a dataset whose schema it
		// could not read.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		expect(chips(), 'the mapping chips vanished — they come from the mapping, not the preview')
			.toHaveLength(3);
		expect(
			ontoCard().textContent,
			'the panel claimed full coverage using the mapped set as its own denominator'
		).not.toContain(COVERAGE_SELF);
		expect(coverage(), 'nothing says why there is no coverage figure').toContain(SCHEMA_UNKNOWN);
	});

	it('⛔ …and the same holds while the two un-awaited fetches are still racing', async () => {
		// The panel fires `loadPreview` and `loadMappings` together and awaits neither, so the
		// mappings-first ordering is the ordinary case, not a fault. A preview that never resolves is
		// that race frozen at its worst moment.
		getDataset.mockReturnValue(new Promise(() => {}));
		await render();
		expect(ontoCard().textContent).not.toContain(COVERAGE_SELF);
		expect(coverage()).toContain(SCHEMA_UNKNOWN);
	});

	it('⛔ THE PII BADGES DO NOT SILENTLY READ AS "SAFE" WITHOUT A SCHEMA', async () => {
		// `colIsPii` returned `Boolean(datasetPreviews[slug]?…)`, so an absent preview answered `false`
		// for every column and no badge rendered — indistinguishable from a column the ontology says is
		// safe, on the panel where a builder decides what data a block may see. The sentence above the
		// chips now says the marking is unknown; nothing pretends otherwise.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(piiChips(), 'a PII badge was claimed with no schema to claim it from').toHaveLength(0);
		expect(coverage(), 'the missing PII marking is not accounted for anywhere').toContain(
			SCHEMA_UNKNOWN
		);
	});

	it('⛔ A LOADED PREVIEW GIVES THE REAL FRACTION — 3 of 12, not 3 of 3', async () => {
		// The complement, and the one that reds on "just delete the coverage line". This is also the
		// case that proves the fixture is honest: 12 columns on the dataset, 3 in the mapping.
		getDataset.mockResolvedValue(detail());
		await render();
		expect(coverage()).toBe(COVERAGE_TRUE);
		expect(coverage()).not.toContain('Structuur van de dataset');
	});

	it('…and the PII badge appears on exactly the column the schema flags', async () => {
		// The other complement: "never render a PII badge" satisfies the absent-schema case above.
		getDataset.mockResolvedValue(detail());
		await render();
		const flagged = piiChips();
		expect(flagged, 'the PII badge stopped rendering for a column that IS PII').toHaveLength(1);
		expect(flagged[0]!.textContent).toContain(PII_COLUMN);
	});
});
