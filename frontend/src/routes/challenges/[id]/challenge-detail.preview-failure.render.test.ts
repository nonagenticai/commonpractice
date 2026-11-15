// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.preview-failure.render.test.ts — the dataset preview
// toggle must not read "Hide" over a row where nothing was ever shown.
//
// ⛔ THE DEFECT, WHICH TAKES TWO FUNCTIONS TO SEE. `loadPreview()` ended in
// `catch { /* no preview */ }` — invisible on its own. But `togglePreview()` had ALREADY put the
// slug into `openPreviews` before awaiting it, and the button's label is
// `openPreviews.has(slug) ? build_data_hide : build_data_preview`. So a 500 on
// `GET /api/datasets/:slug` left a row whose control says "Hide", with nothing under it — and
// pressing "Hide" then "hid" nothing and offered "Preview" again, which is a control that does the
// opposite of what it says twice in a row. The table body is behind
// `openPreviews.has(slug) && previews[slug]`, so the second half was never satisfied.
//
// ⛔ BOTH HALVES ARE ASSERTED IN EVERY FAILURE CASE: the error line is PRESENT, and the toggle is
// back in its "not shown" state. Asserting only the label would pass on a page that never rendered
// the dataset card at all, so `dsRow()` proves the row exists first.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail } from '$lib/types/challenges';
import type { CycleState } from '$lib/types/cycle';

// Real `en` catalog, each key resolving to its own name.
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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'ch-prev-1' }, url: new URL('http://localhost/challenges/ch-prev-1') }
}));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getChallenge, getComments, currentCycle, getDataset, listDatasets } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getComments: vi.fn(),
	currentCycle: vi.fn(),
	getDataset: vi.fn(),
	listDatasets: vi.fn()
}));
// ⛔ The page imports `ApiError` as a VALUE from this module; a mock that omits it fails at import.
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: {
		get: getChallenge,
		comments: getComments,
		vote: vi.fn(),
		unvote: vi.fn(),
		updateDatasets: vi.fn(),
		postComment: vi.fn()
	}
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { list: listDatasets, get: getDataset } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const SLUG = 'claims-2026';

function detail(): ChallengeDetail {
	return {
		id: 'ch-prev-1',
		code: 'CH-284',
		title: 'Claims intake takes four days',
		description: 'A description.',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W24',
		cycleClosed: false,
		tags: [],
		metrics: {},
		votesCount: 284,
		hasVoted: false,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-05-20T00:00:00.000Z',
		commentCount: 0,
		// TWO datasets, because the fix keeps the failures PER SLUG and a single row cannot tell a
		// per-slug map from one shared string.
		datasets: [
			{ slug: SLUG, name: 'Claims 2026', note: '', rowCount: 11774 },
			{ slug: 'sales-2026', name: 'Sales 2026', note: '', rowCount: 42 }
		] as ChallengeDetail['datasets'],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: []
	};
}

function liveCycle(): CycleState {
	return {
		week: '2026-W24',
		phase: 'voting',
		votingEndsAt: '2026-06-11T16:00:00.000Z',
		solutionEndsAt: '2026-06-12T16:00:00.000Z',
		closesAt: '2026-06-12T18:00:00.000Z',
		closedAt: null
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	getChallenge.mockResolvedValue(detail());
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(liveCycle());
	listDatasets.mockResolvedValue({ items: [] });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The dataset list is behind `{#if data.datasets.length || …}` inside
 * `{#if data}`. On a page still in its loading branch there is no row, no button and no error line,
 * and every "the label is not Hide" assertion below passes for free.
 */
function dsRow(slug: string): HTMLElement {
	// By `data-slug`, not by visible text: the slug is no longer printed on the row (W8/P1).
	const li = host.querySelector(`.ds-list li[data-slug="${slug}"]`) ?? undefined;
	expect(li, `the row for ${slug} never rendered — this case tests nothing`).toBeTruthy();
	return li as HTMLElement;
}
function toggleOf(slug: string): HTMLButtonElement {
	const btn = dsRow(slug).querySelector('button.ds-toggle') as HTMLButtonElement | null;
	expect(btn, `no preview toggle on the row for ${slug}`).not.toBeNull();
	return btn!;
}
async function clickToggle(slug: string) {
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	toggleOf(slug).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getChallenge, getComments, currentCycle, getDataset, listDatasets]) fn.mockReset();
});

describe('/challenges/[id] dataset preview, when the fetch fails', () => {
	it('⛔ says the preview could not be loaded AND leaves the toggle on "Preview"', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* no preview */ }`. The slug stays in `openPreviews`,
		// the label becomes `build_data_hide`, and there is no error line — both assertions invert.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(toggleOf(SLUG).textContent?.trim()).toBe('build_data_preview');

		await clickToggle(SLUG);
		expect(getDataset, 'the preview was never requested').toHaveBeenCalledWith(SLUG, { limit: 5 });

		// PRESENT: the reader is told.
		const err = dsRow(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`);
		expect(err, 'nothing said the preview failed').not.toBeNull();
		expect(err!.textContent).toContain('dataset_preview_load_failed');
		expect(err!.getAttribute('role')).toBe('alert');
		// NOT SHOWN: the control does not claim there is something to hide.
		expect(
			toggleOf(SLUG).textContent?.trim(),
			'the toggle says "Hide" over a row that never showed anything'
		).toBe('build_data_preview');
		expect(dsRow(SLUG).querySelector('table'), 'a table rendered from a failed fetch').toBeNull();
	});

	it('⛔ keeps the failure on the FAILING row only', async () => {
		// The map is per slug for a reason: one dataset's 500 must not caption the dataset beside it.
		getDataset.mockImplementation((slug: string) =>
			slug === SLUG
				? Promise.reject(new Error('Failed to fetch'))
				: Promise.resolve({ columns: [{ name: 'amount', type: 'number' }], rows: [{ amount: 1 }] })
		);
		await render();
		await clickToggle(SLUG);
		await clickToggle('sales-2026');

		expect(dsRow(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).not.toBeNull();
		// …and the healthy row is fully open: label flipped, table rendered, no error.
		expect(dsRow('sales-2026').querySelector('[data-testid="preview-error-sales-2026"]')).toBeNull();
		expect(toggleOf('sales-2026').textContent?.trim()).toBe('build_data_hide');
		expect(
			dsRow('sales-2026').querySelector('table'),
			'the healthy preview did not render, so the contrast proves nothing'
		).not.toBeNull();
	});

	it('a RETRY that succeeds opens the row and clears the failure', async () => {
		// `previewErrors` is a fact about the LAST attempt for this slug, not a sticky flag.
		getDataset.mockRejectedValueOnce(new Error('Failed to fetch'));
		await render();
		await clickToggle(SLUG);
		expect(dsRow(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).not.toBeNull();

		getDataset.mockResolvedValueOnce({
			columns: [{ name: 'amount', type: 'number' }],
			rows: [{ amount: 2500 }]
		});
		await clickToggle(SLUG);

		expect(dsRow(SLUG).querySelector(`[data-testid="preview-error-${SLUG}"]`)).toBeNull();
		expect(toggleOf(SLUG).textContent?.trim()).toBe('build_data_hide');
		expect(dsRow(SLUG).querySelector('table'), 'the recovered preview did not render').not.toBeNull();
	});

	it('a HEALTHY preview shows no error line at all', async () => {
		// ⛔ THE COMPLEMENT. A message that is always on says nothing, and "render the error
		// unconditionally" would satisfy every case above.
		getDataset.mockResolvedValue({
			columns: [{ name: 'amount', type: 'number' }],
			rows: [{ amount: 2500 }]
		});
		await render();
		await clickToggle(SLUG);

		expect(toggleOf(SLUG).textContent?.trim()).toBe('build_data_hide');
		expect(dsRow(SLUG).querySelector('table')).not.toBeNull();
		expect(host.textContent).not.toContain('dataset_preview_load_failed');
	});
});
