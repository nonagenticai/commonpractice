// @vitest-environment jsdom
//
// src/lib/components/build/node-config.dataset-failure.render.test.ts — the /build inspector's
// dataset field, in DUTCH, when the dataset list does not arrive intact.
//
// ⛔ DEFECT A — A FAILED FETCH RENDERED AS A FACT ABOUT THE READER'S WORKSPACE.
// `onMount` ended in `catch { datasets = []; }`, and the panel then handed that empty array to
// `DatasetPicker` together with `emptyHint={m.nodecfg_no_datasets()}` — "Nog geen datasets — maak er
// een aan op het scherm Datasets." So a 500 on `GET /api/datasets`, or a dropped connection, told a
// builder something FALSE about their own account and pointed them at an action they had already
// taken. `/submit` and `/challenges/[id]` fixed this exact swallow against this exact widget; the
// inspector was the third copy.
//
// ⛔ DEFECT C — A CONFIGURED NODE RENDERING AS UNCONFIGURED, IN TWO HALVES.
//   1. `datasetsApi.list({ page: 1 })` reads page ONE of a 12-per-page endpoint
//      (backend/src/routes/datasets.ts) into a dropdown with no pager, so a builder's thirteenth
//      dataset was not an option at all. Fixed by paging to completion: `datasetsApi.listAll()`.
//   2. `<select value={slug}>` can only settle on a value one of its `<option>`s carries. With the
//      selected slug missing from `datasets`, the browser fell back to the FIRST option — the empty
//      placeholder "Kies een dataset…" — over a node that IS configured. The panel contradicted the
//      graph it was editing. Fixed by DatasetPicker rendering the unlisted slug as its own option.
// Both halves are pinned separately: (1) by asserting WHICH client method is called, (2) by
// asserting the select's resolved value with the slug held out of the list.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice as `block-node.port-types.render.test.ts`.
// The reader-visible failure here is that the panel printed "Nog geen datasets" over a workspace
// that has datasets; a key-name mock cannot tell "the empty hint is gone" from "the empty hint is a
// key whose name happens not to match". `nl` is the demo locale, so `nl` is what is asserted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore } from '$lib/stores/builder.svelte';
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
		// ⛔ THE PARAMETERS ARE REALLY INTERPOLATED. A `() => catalog[key]` stub renders
		// `datasets_picker_capped` as the literal "{shown} van de {total}", which makes the one thing
		// worth asserting about a truncation notice — that it names the right two numbers THE RIGHT WAY
		// ROUND — impossible to see. "245 van de 2" would pass a stub that discards its arguments.
		// ⚠️ Only a bare `{name}` is substituted, so ICU plural bodies (`{n, plural, …}`) are untouched.
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
// The localization of the error itself is `error-message.ts`'s own subject (and its own tests). Here
// it is flattened to "the caller's fallback wins", so the assertions below are about WHETHER a
// failure is stated, not about which sentence a 403 resolves to.
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
// ⛔ `list` IS MOCKED EVEN THOUGH THE FIXED PANEL NEVER CALLS IT. That is the point: leaving it out
// would make the pre-fix code die on `datasetsApi.list is not a function`, and a test that only
// proves "the old call crashes under my mock" proves nothing about paging. Present, callable, and
// asserted NOT to have been called.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';

/** What a Dutch reader must NOT see when the list fetch failed. `messages/nl.json`. */
const EMPTY_HINT_NL = 'Geen datasets. Voeg er een toe onder Datasets.';
/** …and what they must see instead. */
const LOAD_FAILED_NL = 'Datasets konden niet worden geladen. Probeer het opnieuw.';
const PLACEHOLDER_NL = 'Kies een dataset…';
/** `datasets_picker_capped`, with the two figures the notice below is built from substituted in. */
const CAPPED_NL = 'Deze keuzelijst toont 2 van de 245 datasets.';

function dataset(slug: string, name: string): DatasetRow {
	return {
		id: `id-${slug}`,
		slug,
		name,
		sourceType: 'csv',
		columns: [{ name: 'amount', type: 'number' }],
		rowCount: 42,
		sizeBytes: 1024,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

/**
 * What `datasetsApi.listAll` actually resolves: `{items,total,capped}` — NOT a bare `DatasetRow[]`.
 *
 * ⛔ THE SHAPE IS WRITTEN ONCE. Spelling the object out at every `mockResolvedValue` is a fresh
 * chance, per call, to hand the panel `capped: false` in the case that exists to test truncation, or
 * a `total` that silently equals `items.length` — a fixture that agrees with the code under test for
 * the wrong reason. `total` defaults to the honest `items.length`; a case that wants a SHORT list
 * says so explicitly and only then.
 */
function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/** A selected block with exactly one `dataset`-typed input, optionally already configured. */
function builderWith(config: Record<string, unknown> = {}): BuilderStore {
	return {
		selectedNode: {
			id: 'n1',
			data: {
				slug: 'flag-claims',
				label: 'Markeer claims',
				kind: 'block',
				config,
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

/** A block with NO dataset-typed input — the case the failure notice must stay off. */
function builderWithoutDatasetInput(): BuilderStore {
	const b = builderWith() as unknown as { selectedNode: { data: { descriptor: unknown } } };
	b.selectedNode.data.descriptor = { inputs: { text: { type: 'string', required: false } } };
	return b as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(builder: BuilderStore) {
	app = mount(NodeConfigPanel, { target: host, props: { builder } }) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Every "the empty hint is gone" assertion below passes for free on a
 * panel that rendered no dataset field at all — a broken mock, a thrown effect, a changed selector.
 * Nothing asserts an absence until this has proved the field exists.
 */
function picker(): HTMLSelectElement {
	const sel = host.querySelector('[data-field-name="rows"] select') as HTMLSelectElement | null;
	expect(sel, 'the dataset picker never rendered — this case tests nothing').not.toBeNull();
	return sel!;
}
function errorBox(): HTMLElement | null {
	return host.querySelector('[data-testid="datasets-error"]');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	getDataset.mockResolvedValue({ columns: [{ name: 'amount', type: 'number' }], rows: [{ amount: 1 }] });
	listMappings.mockResolvedValue({ mappings: [] });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset, listMappings]) fn.mockReset();
});

describe('A — the node inspector, when GET /api/datasets fails', () => {
	it('⛔ says the load failed AND never claims the workspace has no datasets', async () => {
		// REVERT THAT TURNS THIS RED: `catch { datasets = []; }` plus the unconditional
		// `emptyHint={m.nodecfg_no_datasets()}`. There is then no error box, and DatasetPicker's
		// `.picker-empty` prints EMPTY_HINT_NL — both assertions invert.
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render(builderWith());

		picker(); // the field exists, so the absence below means something
		const err = errorBox();
		expect(err, 'nothing on screen said the dataset list failed to load').not.toBeNull();
		expect(err!.textContent).toContain(LOAD_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
		expect(
			host.textContent,
			'a failed fetch was reported to the builder as a fact about their account'
		).not.toContain(EMPTY_HINT_NL);
		// And the hint is not merely blanked into an empty node the reader cannot see but a scraper can.
		expect(host.querySelector('.picker-empty')).toBeNull();
	});

	it('⛔ a HEALTHY empty account still gets the empty hint, and no error', async () => {
		// THE COMPLEMENT. "Never render the empty hint" and "always render the error" would both pass
		// the case above; only this one separates the fix from either of those.
		listAll.mockResolvedValue(allDatasets([]));
		await render(builderWith());

		picker();
		expect(errorBox(), 'an error was shown for a load that succeeded').toBeNull();
		expect(host.textContent).toContain(EMPTY_HINT_NL);
	});

	it('a RETRY that succeeds clears the notice and fills the dropdown', async () => {
		listAll.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render(builderWith());
		expect(errorBox()).not.toBeNull();

		listAll.mockResolvedValueOnce(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure notice offered no way to try again').not.toBeNull();
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(errorBox()).toBeNull();
		expect([...picker().options].map((o) => o.value)).toContain('claims-2026');
		expect(host.textContent).not.toContain(EMPTY_HINT_NL);
	});

	it('a block with no dataset input is not told about a list it never uses', async () => {
		// The notice is scoped to the panel's dataset fields, not to "any failure anywhere".
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render(builderWithoutDatasetInput());

		expect(
			host.querySelector('[data-field-name="text"]'),
			'the string field never rendered — this case tests nothing'
		).not.toBeNull();
		expect(errorBox(), 'a dataset failure was announced on a block with no dataset input').toBeNull();
	});
});

describe('C — a node configured with a dataset the list does not carry', () => {
	it('⛔ pages to completion instead of reading page one', async () => {
		// REVERT THAT TURNS THIS RED: `datasets = (await datasetsApi.list({ page: 1 })).items`. The
		// endpoint pages at 12 and this dropdown has no pager, so page one WAS the whole option set.
		listAll.mockResolvedValue(allDatasets([]));
		await render(builderWith());

		expect(listAll, 'the panel did not page the dataset list to completion').toHaveBeenCalled();
		expect(listPaged, 'the panel still reads a single page of a paged endpoint').not.toHaveBeenCalled();
	});

	it('⛔ shows the configured slug rather than the "pick one" placeholder', async () => {
		// The configured slug is deliberately HELD OUT of the loaded list — that is the whole case.
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		await render(builderWith({ rows: 'sales-2026' }));

		const sel = picker();
		// REVERT THAT TURNS THIS RED: delete the `{#if unlisted}` option in DatasetPicker. The select
		// then has no option carrying 'sales-2026', falls back to the first (`value=""`), and the
		// inspector renders "Kies een dataset…" over a node that is configured.
		expect(
			sel.value,
			'the picker dropped the configured slug and fell back to the placeholder'
		).toBe('sales-2026');
		const opt = sel.querySelector('[data-testid="picker-unlisted"]') as HTMLOptionElement | null;
		expect(opt, 'the unlisted slug was never rendered as an option').not.toBeNull();
		expect(opt!.value).toBe('sales-2026');
		expect(opt!.textContent).toContain('sales-2026');
		// The selected option is the slug's, not the placeholder's.
		expect(sel.options[sel.selectedIndex]?.textContent).not.toContain(PLACEHOLDER_NL);
	});

	it('⛔ adds no phantom option when the slug IS in the list', async () => {
		// THE COMPLEMENT. "Always render an extra option" would satisfy the case above and would
		// duplicate every configured dataset in the dropdown.
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		await render(builderWith({ rows: 'claims-2026' }));

		const sel = picker();
		expect(sel.value).toBe('claims-2026');
		expect(sel.querySelector('[data-testid="picker-unlisted"]')).toBeNull();
		expect(
			[...sel.options].filter((o) => o.value === 'claims-2026'),
			'the configured dataset appears twice in the dropdown'
		).toHaveLength(1);
	});

	it('⛔ keeps the configured slug visible even when the LIST failed', async () => {
		// The two defects meet here: nothing loaded AND the node is configured. The reader must see
		// their slug, must see that the list failed, and must not be told they have no datasets.
		listAll.mockRejectedValue(new Error('Failed to fetch'));
		await render(builderWith({ rows: 'sales-2026' }));

		expect(picker().value).toBe('sales-2026');
		expect(errorBox()).not.toBeNull();
		expect(host.textContent).not.toContain(EMPTY_HINT_NL);
	});
});

describe('D — the walk stopped at its ceiling', () => {
	// ⛔ WHY `listAll` RETURNS AN OBJECT AT ALL. `items` alone cannot express "there are more of these
	// than I fetched", and a dropdown missing the builder's 241st dataset reads exactly like one
	// missing their 13th — the defect C above exists to close, one order of magnitude further out.
	// `total` is the SERVER's count, so the notice names the real number rather than our own.
	function cappedNotice(): HTMLElement | null {
		return host.querySelector('[data-testid="datasets-capped"]');
	}

	it('⛔ says the dropdown is short, and names the server’s real total', async () => {
		// REVERT THAT TURNS THIS RED: drop `all.capped`/`all.total` on the floor (or go back to
		// `datasets = await datasetsApi.listAll()` against a bare array). The notice disappears and the
		// panel offers 2 of 245 datasets with nothing on screen saying so.
		listAll.mockResolvedValue(
			allDatasets([dataset('claims-2026', 'Claims 2026'), dataset('sales-2026', 'Sales 2026')], {
				total: 245,
				capped: true
			})
		);
		await render(builderWith());

		picker(); // the field exists, so a notice about its completeness is about something
		const note = cappedNotice();
		expect(note, 'the picker is short and says nothing — the defect, one decade further out').not.toBeNull();
		// Both figures, in this order. `245 van de 2` would satisfy a "contains a number" assertion and
		// state something false; the shown/total swap is the mistake worth pinning.
		expect(note!.textContent).toContain(CAPPED_NL);
		// The way OUT of the truncation: the screen that pages the whole list.
		expect(note!.querySelector('a')?.getAttribute('href')).toBe('/datasets');
		// ⚠️ Not an alert. Nothing failed — the list arrived and is merely incomplete.
		expect(note!.getAttribute('role')).toBe('status');
	});

	it('⛔ a COMPLETE list carries no notice', async () => {
		// THE COMPLEMENT. A line that is always on says nothing, and "always render it" would satisfy
		// the case above while telling every builder their complete list is truncated.
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		await render(builderWith());

		picker();
		expect(cappedNotice(), 'a complete dataset list was reported as truncated').toBeNull();
	});
});
