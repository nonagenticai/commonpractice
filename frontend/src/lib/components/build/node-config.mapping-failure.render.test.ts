// @vitest-environment jsdom
//
// src/lib/components/build/node-config.mapping-failure.render.test.ts — a failed ontology read is
// no longer reported as a fact about the dataset.
//
// ⛔ THE DEFECT, AND IT IS A COLLISION OF TWO MEANINGS ON ONE VALUE. `loadMappings`' catch wrote
// `datasetMappings[slug] = null`, and `null` is that map's value for "loaded, and this dataset has
// no mapping" — which the card renders as
//
//     "Nog geen ontologiekoppeling — koppel de kolommen van deze dataset op het scherm Datasets
//      voor getypeerde, gevalideerde invoer."
//
// So a 500 on `GET /api/datasets/:slug/mappings` told a builder their dataset was unmapped and sent
// them off to map it. The mapping they were told to create may already exist; the instruction is to
// redo work, derived from a failure. Same species as the `datasets = []` swallow this component's
// own header documents one field over, and the one `/submit`, `ChallengeDataPanel` and
// `/challenges/[id]` each fixed against this same widget.
//
// ⛔ WHY THE ERROR ARM SITS BEFORE `{#if mapping}` RATHER THAN INSIDE THE `{:else}`. The two states
// being separated are BOTH `mapping === null`; an arm added after the fact would be unreachable.
//
// ⚠️ AND `datasetMappings[slug]` IS STILL WRITTEN ON FAILURE. It is what `loadMappings`' own
// `slug in datasetMappings` guard tests and what `{#if slug in datasetMappings}` uses to decide the
// card renders at all — dropping it would make the `$effect` re-fetch on every tick. Which is also
// why the retry must EVICT the entry, and why this file asserts the retry actually re-requests.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, same reason, as every sibling spec here.
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
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';

const SLUG = 'claims-2026';
/** `messages/nl.json` — what a failed read must say. */
const LOAD_FAILED_NL = 'Veldkoppeling kon niet worden geladen.';
/** …and what it must NOT say: an instruction to go and redo work that may already exist. */
const NONE_NL = 'Nog geen veldkoppeling';
const RETRY_NL = 'Opnieuw proberen';

function dataset(): DatasetRow {
	return {
		id: `id-${SLUG}`,
		slug: SLUG,
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' }],
		rowCount: 12_480,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

function detail(): DatasetDetail {
	const d = dataset();
	return {
		...d,
		columns: [{ name: 'bedrag', type: 'number', pii: false }],
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
		columnMap: { bedrag: 'attr_bedrag' },
		confidence: 0.9,
		source: 'human',
		confirmed: true,
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetMapping;
}

function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

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

async function render(canMapData?: boolean) {
	listAll.mockResolvedValue(allDatasets([dataset()]));
	getDataset.mockResolvedValue(detail());
	const extra = canMapData === undefined ? {} : { canMapData };
	app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder(), ...extra } }) as Record<
		string,
		unknown
	>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The whole card is behind `{#if slug in datasetMappings}`; on a panel
 * that rendered nothing, "it does not say `Nog geen ontologiekoppeling`" is true for free.
 */
function ontoCard(): HTMLElement {
	const el = host.querySelector('.onto');
	expect(el, 'the ontology card never rendered — this case tests nothing').not.toBeNull();
	return el as HTMLElement;
}
const errorBox = () => ontoCard().querySelector(`[data-testid="mapping-error-${SLUG}"]`);

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

describe('the /build inspector, when the ontology mapping read fails', () => {
	it('⛔ THE DEFECT: says the read failed instead of "this dataset has no mapping yet"', async () => {
		// REVERT THAT TURNS THIS RED: `catch { datasetMappings[slug] = null }` with no error map. The
		// card falls through to `nodecfg_ontology_none` and instructs the builder to go and map a
		// dataset that may already be mapped.
		listMappings.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		const err = errorBox();
		expect(err, 'a failed ontology read is still indistinguishable from an unmapped dataset')
			.not.toBeNull();
		expect(err!.textContent).toContain(LOAD_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
		expect(
			ontoCard().textContent,
			'a 500 was reported as a fact about the dataset, with an instruction to redo the work'
		).not.toContain(NONE_NL);
	});

	it('⛔ …and the retry EVICTS the cache entry, so it really re-requests', async () => {
		// Unlike `loadPreview`, this loader writes `datasetMappings[slug] = null` on failure — which is
		// exactly what its own `slug in datasetMappings` guard tests. A retry that only re-called the
		// loader would return at its first line and do nothing at all. Red by dropping the eviction
		// from `retryMappings`.
		listMappings.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		const before = listMappings.mock.calls.length;

		const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure is stated with no way to act on it').not.toBeNull();
		expect(retry!.textContent?.trim()).toBe(RETRY_NL);

		listMappings.mockResolvedValue({ mappings: [mapping()] });
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(
			listMappings.mock.calls.length,
			'the retry never reached the client — the loader’s own guard swallowed it'
		).toBeGreaterThan(before);
		expect(errorBox(), 'the notice survived a retry that succeeded').toBeNull();
		expect(ontoCard().textContent, 'the recovered mapping did not render').toContain('Schadeclaim');
	});

	it('⛔ A GENUINELY UNMAPPED DATASET STILL GETS THE INSTRUCTION — it is true for that reader', async () => {
		// THE COMPLEMENT, and the one an over-correction breaks. An empty `mappings` array really does
		// mean "map this on the Datasets screen", and that sentence is useful. Deleting the arm would
		// satisfy the case above.
		listMappings.mockResolvedValue({ mappings: [] });
		await render();

		expect(errorBox(), 'a successful read was rendered as a failure').toBeNull();
		expect(ontoCard().textContent).toContain(NONE_NL);
		expect(ontoCard().classList.contains('onto-unmapped'), 'the unmapped styling was lost').toBe(true);
	});

	it('a MAPPED dataset shows neither the failure nor the instruction', async () => {
		// The third arm, so "always render the failure" cannot pass.
		listMappings.mockResolvedValue({ mappings: [mapping()] });
		await render();

		expect(errorBox()).toBeNull();
		expect(ontoCard().textContent).not.toContain(NONE_NL);
		expect(ontoCard().textContent).toContain('Schadeclaim');
		expect(
			ontoCard().classList.contains('onto-unmapped'),
			'a mapped dataset was styled as unmapped'
		).toBe(false);
	});

	it('⚠️ a failed read is not styled as "unmapped" either', async () => {
		// `class:onto-unmapped={!mapping}` was true on a failure too, so even with the sentence fixed
		// the card kept the visual language of "nothing here". The class now excludes the error state.
		listMappings.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(
			ontoCard().classList.contains('onto-unmapped'),
			'a failed read still wears the "no mapping" styling'
		).toBe(false);
	});
});

describe('the "no field mapping" line names an action only for someone who can take it', () => {
	/** `messages/nl.json` — the instruction half, which only a developer+ can act on (/datasets). */
	const INSTRUCTION_NL = 'Koppel de kolommen onder Datasets';

	it('⛔ a member reads the fact, without an instruction they cannot follow', async () => {
		// REVERT THAT TURNS THIS RED: render `m.nodecfg_ontology_none()` for everyone again.
		listMappings.mockResolvedValue({ mappings: [] });
		await render(false);
		expect(ontoCard().textContent).toContain(NONE_NL);
		expect(ontoCard().textContent).not.toContain(INSTRUCTION_NL);
	});

	it('the default (no role passed) is the member wording', async () => {
		listMappings.mockResolvedValue({ mappings: [] });
		await render();
		expect(ontoCard().textContent).not.toContain(INSTRUCTION_NL);
	});

	it('a developer and above still get the instruction', async () => {
		listMappings.mockResolvedValue({ mappings: [] });
		await render(true);
		expect(ontoCard().textContent).toContain(INSTRUCTION_NL);
	});
});
