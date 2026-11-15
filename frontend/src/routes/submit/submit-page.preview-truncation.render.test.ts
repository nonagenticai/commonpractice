// @vitest-environment jsdom
//
// src/routes/submit/submit-page.preview-truncation.render.test.ts — the picked dataset's preview
// says how much of the dataset it is not showing.
//
// ⛔ THE DEFECT. `loadPreview` fetches `datasetsApi.get(slug, { limit: 5 })` and the route caps the
// array in SQL (`readRows`, backend/src/datasets/dataset-service.ts), so `rows.length` is never more
// than 5. The mount passed `maxRows={5}` and no `totalRows`, and `DatasetPreviewTable` falls back to
// `total = rows.length` — so its notice asked `5 > 5` and could not fire. This is the screen where a
// creator writes the note that tells every solver what matters about the data, and they wrote it
// having seen five rows of 11 774 with nothing on screen saying so.
//
// ⛔ THE SAME `<div class="ds-pick">` ALREADY PRINTED THE REAL TOTAL. `.ds-pick-meta` renders
// `{ds.slug} · {num(ds.rowCount, locale.current)}` directly above the table — so the block
// contradicted itself, in one element, in one glance. `ds` comes from `pickedDatasets`, a filter over
// `availableDatasets: DatasetRow[]`, so `rowCount` is structurally present: a dataset can only be
// picked because it is in that list. No new request, no new key.
//
// ⚠️ THE FIXTURE'S `rowCount` AND ITS `rows` ARRAY ARE INDEPENDENT ON PURPOSE — the shape the API
// really produces. A fixture whose array is longer than the requested limit is a state no response
// can have, and building the only existing notice spec that way is why nothing caught this.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetRow } from '$lib/types/datasets';
import type { AllDatasets } from '$lib/api/datasets';

// Real `en` catalog, each key resolving to its own name plus its arguments.
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

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { listDatasets, listAll, getDataset, createChallenge } = vi.hoisted(() => ({
	listDatasets: vi.fn(),
	listAll: vi.fn(),
	getDataset: vi.fn(),
	createChallenge: vi.fn()
}));
// ⚠️ THE FACTORY REPLACES THE WHOLE MODULE — every member the page imports has to be here, and
// `list` stays mocked and callable though nothing calls it, so a revert fails on an assertion rather
// than on `datasetsApi.list is not a function`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: listDatasets, listAll, get: getDataset }
}));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: { create: createChallenge }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const SLUG = 'claims-2026';
/** The number `availableDatasets` carries for this dataset. */
const TOTAL = 11_774;
/** What the route returns for `{ limit: 5 }` — never more, whatever `rowCount` says. */
const FETCHED = 5;

/**
 * ⚠️ Both figures are grouped by `num(_, locale.current)` BEFORE they reach the message, so the
 * key-name stub receives the STRING "11,774" and joins its arguments with a comma. Built with `Intl`
 * so this file states the rule rather than hard-coding one locale's separator.
 */
const grouped = (n: number) => new Intl.NumberFormat('en').format(n);

function dataset(rowCount: number): DatasetRow {
	return {
		id: 'd1',
		slug: SLUG,
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' }],
		rowCount,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z'
	};
}

/** The preview body the route builds: `min(rowCount, limit)` rows and no total of its own. */
function preview(rowCount: number, limit = FETCHED) {
	return {
		columns: [{ name: 'bedrag', type: 'number' as const }],
		rows: Array.from({ length: Math.min(rowCount, limit) }, (_, i) => ({ bedrag: i }))
	};
}

const allDatasets = (items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets => ({
	items,
	total: items.length,
	capped: false,
	...extra
});

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount /submit on one dataset of `rowCount` rows and tick its picker box. */
async function pickDataset(rowCount: number) {
	const ds = dataset(rowCount);
	listAll.mockResolvedValue(allDatasets([ds]));
	listDatasets.mockResolvedValue({ items: [ds] });
	getDataset.mockResolvedValue(preview(rowCount));
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();

	// By `data-slug`: the picker row no longer prints the slug (W8/F3).
	const item = host.querySelector(`.picker-item[data-slug="${SLUG}"]`) ?? undefined;
	expect(item, `the picker has no row for ${SLUG} — this case tests nothing`).toBeTruthy();
	const box = item!.querySelector('input[type="checkbox"]') as HTMLInputElement;
	box.checked = true;
	box.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Nothing below is asserted until the picked-dataset block is proved on
 * screen: on a page that never mounted, or a checkbox that never took, every "no notice" case is
 * true for free and the "notice is present" cases fail for the wrong reason.
 */
function pickedBlock(): HTMLElement {
	// By `data-slug`, not by visible text: the slug is no longer printed (W8).
	const block = host.querySelector(`.ds-pick[data-slug="${SLUG}"]`) ?? undefined;
	expect(block, `the picked block for ${SLUG} never rendered`).toBeTruthy();
	return block as HTMLElement;
}
const bodyRows = () => pickedBlock().querySelectorAll('table.sample tbody tr').length;
const notice = () => pickedBlock().querySelector('.sample-more');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listDatasets, listAll, getDataset, createChallenge]) fn.mockReset();
});

describe('/submit says why the dataset preview stops', () => {
	it('⛔ THE DEFECT: five rows of an 11 774-row dataset explain themselves', async () => {
		// REVERT THAT TURNS THIS RED: drop `totalRows={ds.rowCount}` from the mount. `total` falls back
		// to `rows.length` (5), the condition becomes `5 > 5`, and `.sample-more` does not exist.
		await pickDataset(TOTAL);

		expect(pickedBlock().querySelector('table.sample'), 'the preview table never rendered').not.toBeNull();
		expect(bodyRows(), 'the block did not render the five fetched rows').toBe(FETCHED);

		const more = notice();
		expect(more, 'the table stopped at five rows with no explanation').not.toBeNull();
		expect(more!.textContent).toBe(`dataset_preview_more:${grouped(FETCHED)},${grouped(TOTAL)}`);
	});

	it('⛔ …and the number is the DATASET’s size, not the fetched array’s length', async () => {
		await pickDataset(TOTAL);
		expect(notice()!.textContent).toContain(grouped(TOTAL));
		expect(notice()!.textContent).not.toBe(
			`dataset_preview_more:${grouped(FETCHED)},${grouped(FETCHED)}`
		);
	});

	it('⚠️ and it AGREES with the meta line in the same block', async () => {
		// The self-contradiction this closes lived inside one `<div class="ds-pick">`.
		await pickDataset(TOTAL);
		expect(pickedBlock().querySelector('.ds-pick-meta')?.textContent).toContain(grouped(TOTAL));
		expect(notice()!.textContent).toContain(grouped(TOTAL));
	});

	it('a dataset that FITS says nothing — the notice is not unconditional', async () => {
		await pickDataset(3);
		expect(bodyRows()).toBe(3);
		expect(notice(), 'a complete table was labelled as truncated').toBeNull();
	});

	it('EXACTLY ONE WINDOW says nothing either — the boundary is `>`, not `>=`', async () => {
		await pickDataset(FETCHED);
		expect(bodyRows()).toBe(FETCHED);
		expect(notice()).toBeNull();
	});

	it('⛔ THE WINDOW IS NOT WIDENED — the fix is the sentence, not the ceiling', async () => {
		await pickDataset(TOTAL);
		expect(getDataset).toHaveBeenCalledWith(SLUG, { limit: FETCHED });
	});
});
