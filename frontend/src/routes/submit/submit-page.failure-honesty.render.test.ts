// @vitest-environment jsdom
//
// src/routes/submit/submit-page.failure-honesty.render.test.ts — two things this form did silently.
//
// ⛔ 1. THE PREVIEW THAT NEVER ARRIVES LOOKS EXACTLY LIKE ONE STILL LOADING. `loadPreview()` ended
// in `catch { /* no preview */ }`, and the preview table is behind `{#if dataPreviews[slug]}`. So a
// 500 on `GET /api/datasets/:slug` left the picked dataset with its heading and its note box and no
// table — pixel-for-pixel the in-flight state. The creator waits for rows that are never coming and
// then writes the note that tells every solver what matters in data they never saw.
//
// ⛔ 2. THE TAG INPUT ATE WHAT YOU TYPED. `addTag` was
//
//       if (t && !tags.includes(t) && tags.length < 12) tags = [...tags, t];
//       tagDraft = '';
//
// — the clear is UNCONDITIONAL. Enter on a duplicate, or on the thirteenth tag, emptied the box and
// added no chip and said nothing. The reader's own text vanished, no chip appeared, and the only
// available reading is that the field is broken. There was also no counter and nothing naming the
// cap of 12, so the second case is unreachable knowledge until you hit it.
//
// ⛔ THE ANTI-VACUITY RULE. A rejected tag is asserted by BOTH halves — the draft text is STILL in
// the input AND the reason is on screen — because "no chip was added" alone is satisfied by a form
// that never mounted, and "the box is empty" is what the defect produced.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetRow } from '$lib/types/datasets';
import type { AllDatasets } from '$lib/api/datasets';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any) — so
// `submit_tag_duplicate:claims` proves WHICH message and WHICH interpolated value reached the DOM.
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
// ⚠️ THE FACTORY REPLACES THE WHOLE MODULE, so every member the page imports has to be here or it
// dies at import time and reads as an unrelated failure. `+page.svelte:71` now calls `listAll`; `list`
// stays mocked and callable even though nothing calls it any more, for the reason the three
// `lib/components/build/*.render.test.ts` specs record — a revert must fail on an assertion, not on
// `datasetsApi.list is not a function`.
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

function dataset(id: string, slug: string, name: string): DatasetRow {
	return {
		id,
		slug,
		name,
		sourceType: 'csv',
		columns: [{ name: 'amount', type: 'number' }],
		rowCount: 11774,
		sizeBytes: 1024,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** What `datasetsApi.listAll` resolves — `{items,total,capped}`, NOT a bare `DatasetRow[]`. Written
 * once per file, the same one-liner the three `lib/components/build/*.render.test.ts` specs use. */
const allDatasets = (items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets => ({
	items,
	total: items.length,
	capped: false,
	...extra
});

async function render(datasets: DatasetRow[] = [dataset('d1', SLUG, 'Claims 2026')]) {
	listAll.mockResolvedValue(allDatasets(datasets));
	listDatasets.mockResolvedValue({ items: datasets });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** The picker checkbox for a slug, after proving the picker itself rendered. */
async function pick(slug: string) {
	// By `data-slug`: the picker row no longer prints the slug (W8/F3).
	const item = host.querySelector(`.picker-item[data-slug="${slug}"]`) ?? undefined;
	expect(item, `the picker has no row for ${slug} — this case tests nothing`).toBeTruthy();
	const box = item!.querySelector('input[type="checkbox"]') as HTMLInputElement;
	box.checked = true;
	box.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

/** The picked-dataset block, proved present before anything is asserted about its contents. */
function pickedBlock(slug: string): HTMLElement {
	// By `data-slug`, not by visible text: the slug is no longer printed (W8).
	const block = host.querySelector(`.ds-pick[data-slug="${slug}"]`) ?? undefined;
	expect(block, `the picked block for ${slug} never rendered`).toBeTruthy();
	return block as HTMLElement;
}

function tagInput(): HTMLInputElement {
	const el = host.querySelector('#tags') as HTMLInputElement | null;
	expect(el, 'the tag input never rendered — this file would prove nothing').not.toBeNull();
	return el!;
}
/** Type into the tag box the way a person does: input event, then Enter. */
async function typeTag(text: string) {
	const el = tagInput();
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await settle();
}
const chips = (): string[] =>
	[...host.querySelectorAll('.tag-input .tag')].map((t) => t.textContent?.replace('×', '').trim() ?? '');

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

// ==================================================================================================
// 1. THE PREVIEW.
// ==================================================================================================
describe('/submit dataset preview, when the fetch fails', () => {
	it('⛔ says the preview could not be loaded instead of rendering as "still loading"', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* no preview */ }`. The block renders its heading and
		// note box and nothing else, and both assertions below invert.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		await pick(SLUG);

		expect(getDataset, 'the preview was never requested').toHaveBeenCalledWith(SLUG, { limit: 5 });
		const block = pickedBlock(SLUG);
		const err = block.querySelector(`[data-testid="preview-error-${SLUG}"]`);
		expect(err, 'the picked dataset rendered as an empty box — indistinguishable from loading').not.toBeNull();
		expect(err!.textContent).toContain('dataset_preview_load_failed');
		expect(err!.getAttribute('role')).toBe('alert');
		// The block itself is still there — the failure is a caption on it, not a replacement for it:
		// the note field is the reader's own text and must survive.
		expect(block.querySelector('input.ds-note'), 'the note field was thrown away').not.toBeNull();
		expect(block.querySelector('table')).toBeNull();
	});

	it('a HEALTHY preview renders the table and no error line', async () => {
		// ⛔ THE COMPLEMENT: "always render the error" would satisfy the case above.
		getDataset.mockResolvedValue({
			columns: [{ name: 'amount', type: 'number' }],
			rows: [{ amount: 2500 }]
		});
		await render();
		await pick(SLUG);

		const block = pickedBlock(SLUG);
		expect(block.querySelector('table'), 'the healthy preview did not render').not.toBeNull();
		expect(block.querySelector(`[data-testid="preview-error-${SLUG}"]`)).toBeNull();
		expect(host.textContent).not.toContain('dataset_preview_load_failed');
	});
});

// ==================================================================================================
// 2. THE TAG INPUT.
// ==================================================================================================
describe('/submit tag input keeps what you typed when it refuses it', () => {
	it('⛔ a DUPLICATE leaves the text in the box AND says why', async () => {
		// REVERT THAT TURNS THIS RED: the unconditional `tagDraft = ''`. The box empties, no chip is
		// added, nothing is said — and the first two assertions here invert together.
		await render();
		await typeTag('claims');
		expect(chips(), 'the first tag was not accepted, so the duplicate case is vacuous').toEqual([
			'claims'
		]);

		await typeTag('claims');
		// KEPT…
		expect(tagInput().value, 'the reader’s own text was silently discarded').toBe('claims');
		// …AND EXPLAINED, naming the tag that was refused.
		const note = host.querySelector('[data-testid="tag-error"]');
		expect(note, 'nothing said why the tag was not added').not.toBeNull();
		expect(note!.textContent).toContain('submit_tag_duplicate:claims');
		// …and no second chip appeared.
		expect(chips()).toEqual(['claims']);
	});

	it('⛔ the THIRTEENTH tag is refused by name, with the cap in the sentence', async () => {
		await render();
		for (let i = 1; i <= 12; i++) await typeTag(`tag${i}`);
		expect(chips(), 'the cap was not reached, so this case tests nothing').toHaveLength(12);

		await typeTag('tag13');
		expect(tagInput().value, 'the thirteenth tag was eaten').toBe('tag13');
		expect(chips(), 'the cap did not hold').toHaveLength(12);
		const note = host.querySelector('[data-testid="tag-error"]');
		expect(note, 'the cap was enforced silently — the field reads as broken').not.toBeNull();
		expect(note!.textContent).toContain('submit_tag_max:12');
	});

	it('the cap is NAMED in the field hint, not only discovered by hitting it', async () => {
		await render();
		// The hint takes `{max}` now; a hint that stopped interpolating it would render the key alone.
		expect(host.textContent).toContain('submit_field_tags_hint:12');
	});

	it('an ACCEPTED tag clears the box and leaves no message', async () => {
		// ⛔ THE COMPLEMENT AND THE OVER-CORRECTION GUARD: "never clear the draft" satisfies both
		// failure cases above and makes the field unusable.
		await render();
		await typeTag('claims');
		expect(chips()).toEqual(['claims']);
		expect(tagInput().value).toBe('');
		expect(host.querySelector('[data-testid="tag-error"]')).toBeNull();
	});

	it('editing the box clears a standing complaint', async () => {
		// The message is about the LAST Enter, not a sticky flag: a reader who starts fixing the tag
		// must not be lectured about the version they are already editing away from.
		await render();
		await typeTag('claims');
		await typeTag('claims');
		expect(host.querySelector('[data-testid="tag-error"]')).not.toBeNull();

		const el = tagInput();
		el.value = 'claims-2';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(host.querySelector('[data-testid="tag-error"]')).toBeNull();
	});

	it('removing a chip clears the cap message', async () => {
		// "Remove one to add another" is the action the message asks for; it must not still be on
		// screen once it has been taken.
		await render();
		for (let i = 1; i <= 12; i++) await typeTag(`tag${i}`);
		await typeTag('tag13');
		expect(host.querySelector('[data-testid="tag-error"]')).not.toBeNull();

		const remove = host.querySelector('.tag-input .tag button') as HTMLButtonElement;
		expect(remove, 'the chips have no remove control').not.toBeNull();
		remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(chips()).toHaveLength(11);
		expect(host.querySelector('[data-testid="tag-error"]')).toBeNull();
	});
});
