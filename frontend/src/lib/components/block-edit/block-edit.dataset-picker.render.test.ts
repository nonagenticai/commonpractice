// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-edit.dataset-picker.render.test.ts — the two dataset
// dropdowns of /block-edit (the Testing tab's test editor and the Simulate tab's input form),
// in DUTCH, when the dataset list does not arrive whole.
//
// ⛔ DEFECT 1 — A DROPDOWN THAT LIES ABOUT ITS OPTION SET. Both tabs did
//     datasetsApi.list().then((r) => (datasets = r.items))
// i.e. PAGE ONE of a 12-per-page endpoint (backend/src/routes/datasets.ts's `PAGE_SIZE`) poured
// into a `<select>` with no pager. A developer's THIRTEENTH dataset was not an option at all —
// they could neither pin a test against it nor simulate with it — and nothing on screen said the
// list was short. Fixed by `datasetsApi.listAll()`, which walks to the end and reports its own
// ceiling (`capped`/`total`).
//
// ⛔ DEFECT 2 — A FAILED FETCH RENDERED AS A FACT ABOUT THE WORKSPACE. `.catch(() => (datasets =
// []))` blanked the list, and an empty dropdown is exactly how these tabs say "you have no
// datasets yet". So a 500 or a dropped connection told the author something FALSE about their own
// workspace and pointed them at an action (go create a dataset) they had already taken. PR #309
// closed this same swallow in /build's NodeConfigPanel, /submit and /challenges/[id]; block-edit
// was the fourth and fifth copy.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice as `node-config.dataset-failure.render.test.ts`.
// The reader-visible failure is that the tab printed "Nog geen datasets" over a workspace that has
// datasets; a key-name stub cannot tell "the hint is gone" from "the hint is a key whose name
// happens not to match". `nl` is the demo locale, so `nl` is what is asserted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { BlockDescriptor } from '$lib/types/blocks';
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
		// The parameters are really interpolated — a stub that discards them renders
		// `datasets_picker_capped` as the literal "{shown} van de {total}", which makes the one
		// thing worth asserting about a truncation notice (that it names the two numbers the right
		// way round) impossible to see.
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
// Which sentence a 403 resolves to is `error-message.ts`'s own subject and its own tests. Here it
// is flattened to "the caller's fallback wins", so these assertions are about WHETHER a failure is
// stated at all.
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { listAll, listPaged } = vi.hoisted(() => ({ listAll: vi.fn(), listPaged: vi.fn() }));
// ⛔ `list` IS MOCKED EVEN THOUGH THE FIXED TABS NEVER CALL IT. Leaving it out would make the
// pre-fix code die on `datasetsApi.list is not a function`, and a test that only proves "the old
// call crashes under my mock" proves nothing about paging. Present, callable, asserted NOT called.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: vi.fn(), listMappings: vi.fn() }
}));

const { listTests } = vi.hoisted(() => ({ listTests: vi.fn() }));
vi.mock('$lib/api/blocks', () => ({
	blocksApi: {
		listTests,
		createTest: vi.fn(),
		patchTest: vi.fn(),
		deleteTest: vi.fn(),
		streamTests: vi.fn(() => ({ close: () => {} })),
		simulate: vi.fn()
	},
	ApiError: class ApiError extends Error {
		status = 500;
	}
}));

import BlockTesting from './BlockTesting.svelte';
import BlockSimulate from './BlockSimulate.svelte';

/** What a Dutch reader must NOT see when the list fetch failed. `messages/nl.json`. */
const EMPTY_HINT_NL = 'Geen datasets. Voeg er een toe onder Datasets.';
/** …and what they must see instead. */
const LOAD_FAILED_NL = 'Datasets konden niet worden geladen. Probeer het opnieuw.';

const DESCRIPTOR: BlockDescriptor = {
	inputs: { rijen: { type: 'dataset', required: true } },
	outputs: { totaal: { type: 'number' } },
	capabilities: { network: false, llm: false, mockData: true }
} as unknown as BlockDescriptor;

/** A block whose inputs the dataset list feeds nothing — the case both notices must stay off. */
const NO_DATASET_DESCRIPTOR: BlockDescriptor = {
	inputs: { bedrag: { type: 'number', required: true } },
	outputs: { totaal: { type: 'number' } },
	capabilities: { network: false, llm: false, mockData: false }
} as unknown as BlockDescriptor;

function dataset(n: number): DatasetRow {
	return {
		id: `id-${n}`,
		slug: `set-${n}`,
		name: `Set ${n}`,
		sourceType: 'csv',
		columns: [{ name: 'amount', type: 'number' }],
		rowCount: 42,
		sizeBytes: 1024,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as unknown as DatasetRow;
}

/**
 * What `listAll` actually resolves: `{items,total,capped}` — NOT a bare array. Written once, so no
 * individual case can hand the component a `capped:false` in the case that tests truncation.
 */
function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/** ⛔ THIRTEEN — one past the backend's `PAGE_SIZE` of 12. Twelve would pass on the broken code. */
const THIRTEEN = Array.from({ length: 13 }, (_, i) => dataset(i + 1));

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(rounds = 40) {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		flushSync();
	}
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function errorBox(): HTMLElement | null {
	return host.querySelector('[data-testid="datasets-error"]');
}
function emptyHint(): HTMLElement | null {
	return host.querySelector('[data-testid="datasets-empty-hint"]');
}
/**
 * ⛔ THE ANTI-VACUITY GATE. Every "the hint is gone" assertion below passes for free on a tab that
 * rendered no dataset field at all. Nothing asserts an absence until this proves the field exists.
 */
function picker(): HTMLSelectElement {
	const sel = [...host.querySelectorAll('select')].find((s) =>
		[...s.options].some((o) => o.textContent?.includes('Kies een dataset') || o.value.startsWith('set-'))
	) as HTMLSelectElement | undefined;
	expect(sel, 'the dataset dropdown never rendered — this case tests nothing').toBeTruthy();
	return sel!;
}
function optionSlugs(): string[] {
	return [...picker().options].map((o) => o.value).filter(Boolean);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	listTests.mockResolvedValue({ items: [], total: 0, version_id: 'v1' });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, listTests]) fn.mockReset();
});

/** Mount the Simulate tab — its input form (and so its dataset dropdown) is always on screen. */
async function renderSimulate(descriptor: BlockDescriptor = DESCRIPTOR) {
	app = mount(BlockSimulate, {
		target: host,
		props: { slug: 'btw-berekenen', version: '1.0.0', descriptor }
	}) as Record<string, unknown>;
	await settle();
}

/**
 * Mount the Testing tab AND open its test editor — the dropdown lives inside that form, so a case
 * that never opens it measures markup nobody rendered.
 */
async function renderTesting(descriptor: BlockDescriptor = DESCRIPTOR) {
	app = mount(BlockTesting, {
		target: host,
		props: {
			slug: 'btw-berekenen',
			version: '1.0.0',
			descriptor,
			isDraft: true,
			canAuthor: true
		}
	}) as Record<string, unknown>;
	await settle();
	const add = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'Test toevoegen'
	) as HTMLButtonElement | undefined;
	expect(add, 'no "add test" control — the editor form never opens and this case tests nothing').toBeTruthy();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	add!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

for (const [tab, render] of [
	['Simulate', renderSimulate],
	['Testing', renderTesting]
] as const) {
	describe(`/block-edit → ${tab} — the dataset dropdown`, () => {
		it('⛔ offers ALL THIRTEEN datasets, not the first page of twelve', async () => {
			// REVERT THAT TURNS THIS RED: `datasetsApi.list().then((r) => (datasets = r.items))`.
			// `list` then resolves undefined under this mock and the dropdown carries no options at
			// all; with a real page-1 response it carries twelve. Either way, not thirteen.
			listAll.mockResolvedValue(allDatasets(THIRTEEN));
			await render();

			expect(optionSlugs(), 'the dropdown is short by a page boundary').toHaveLength(13);
			expect(optionSlugs()).toContain('set-13');
			expect(listAll, 'the tab did not page the dataset list to completion').toHaveBeenCalled();
			expect(listPaged, 'the tab still reads a single page of a paged endpoint').not.toHaveBeenCalled();
		});

		it('⛔ says the load failed AND never claims the workspace has no datasets', async () => {
			// REVERT THAT TURNS THIS RED: `.catch(() => (datasets = []))`. There is then no error box
			// and the empty hint prints over a workspace whose dataset count is unknown.
			listAll.mockRejectedValue(new Error('Failed to fetch'));
			await render();

			picker(); // the field exists, so the absence below means something
			const err = errorBox();
			expect(err, 'nothing on screen said the dataset list failed to load').not.toBeNull();
			expect(err!.textContent).toContain(LOAD_FAILED_NL);
			expect(err!.getAttribute('role')).toBe('alert');
			expect(
				host.textContent,
				'a failed fetch was reported to the author as a fact about their workspace'
			).not.toContain(EMPTY_HINT_NL);
			expect(emptyHint(), 'the hint is still in the DOM for a scraper to read').toBeNull();
		});

		it('⛔ a HEALTHY empty workspace still gets the hint, and no error', async () => {
			// THE COMPLEMENT. "Never render the hint" and "always render the error" would both pass
			// the case above; only this separates the fix from either of those.
			listAll.mockResolvedValue(allDatasets([]));
			await render();

			picker();
			expect(errorBox(), 'an error was shown for a load that succeeded').toBeNull();
			expect(host.textContent).toContain(EMPTY_HINT_NL);
		});

		it('a RETRY that succeeds clears the notice and fills the dropdown', async () => {
			listAll.mockRejectedValueOnce(new Error('Failed to fetch'));
			await render();
			expect(errorBox()).not.toBeNull();

			listAll.mockResolvedValueOnce(allDatasets([dataset(1)]));
			const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
			expect(retry, 'the failure notice offered no way to try again').not.toBeNull();
			retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await settle();

			expect(errorBox()).toBeNull();
			expect(optionSlugs()).toContain('set-1');
			expect(host.textContent).not.toContain(EMPTY_HINT_NL);
		});

		it('⛔ says so when the walk stopped short, naming the SERVER’s total', async () => {
			listAll.mockResolvedValue(allDatasets([dataset(1), dataset(2)], { total: 245, capped: true }));
			await render();

			const note = host.querySelector('[data-testid="datasets-capped"]');
			expect(note, 'the dropdown is short and says nothing').not.toBeNull();
			// Both figures, in this order: "245 van de 2" would satisfy a "contains a number" check
			// and state something false.
			expect(note!.textContent).toContain('Deze keuzelijst toont 2 van de 245 datasets.');
			expect(note!.querySelector('a')?.getAttribute('href')).toBe('/datasets');
			// ⚠️ Not an alert. Nothing failed — the list arrived and is merely incomplete.
			expect(note!.getAttribute('role')).toBe('status');
		});

		it('a COMPLETE list carries no truncation notice', async () => {
			// THE COMPLEMENT: an always-on line says nothing and would misreport every complete list.
			listAll.mockResolvedValue(allDatasets([dataset(1)]));
			await render();

			picker();
			expect(host.querySelector('[data-testid="datasets-capped"]')).toBeNull();
		});

		it('a block with no dataset input is not told about a list it never uses', async () => {
			listAll.mockRejectedValue(new Error('Failed to fetch'));
			await render(NO_DATASET_DESCRIPTOR);

			expect(
				host.querySelector('input[type="number"]'),
				'the number field never rendered — this case tests nothing'
			).not.toBeNull();
			expect(errorBox(), 'a dataset failure was announced on a block with no dataset input').toBeNull();
		});
	});
}
