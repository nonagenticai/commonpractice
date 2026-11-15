// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.preview-truncation.render.test.ts — the challenge's
// dataset preview says how much of the dataset it is not showing.
//
// ⛔ THE DEFECT. `loadPreview` fetches `datasetsApi.get(slug, { limit: 5 })` and the route caps the
// array in SQL (`readRows`, backend/src/datasets/dataset-service.ts), so `rows.length` is never more
// than 5. The mount passed `maxRows={5}` and no `totalRows`, and `DatasetPreviewTable` falls back to
// `total = rows.length` — so its notice asked `5 > 5` and could not fire. A reader opened the
// preview on an 11 774-row sheet, saw five rows, and got nothing telling them there were more. The
// `.ds-meta` line ONE ELEMENT ABOVE the table already printed "11.774" through `num()`, so the page
// contradicted itself inside a single `<li>`.
//
// ⛔ THE FIX INVENTS NOTHING: `ds` is a `ChallengeDatasetRef`, which carries `rowCount` — the same
// field the meta line reads. No new request, no new endpoint, no new key. This file's job is to make
// dropping `totalRows={ds.rowCount}` red by name.
//
// ⚠️ THE FIXTURE'S `rowCount` AND ITS `rows` ARRAY ARE DELIBERATELY INDEPENDENT, and that is the
// whole design. `detail()` says 11 774 and the preview response returns 5 rows — the shape the API
// really produces. A fixture whose array is longer than the limit (the shape
// `lib/components/dataset-preview.locale-numbers.render.test.ts` uses) is a state no response can
// have, and it is exactly why CI never noticed this notice was dead in production.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail } from '$lib/types/challenges';
import type { CycleState } from '$lib/types/cycle';

// Real `en` catalog, each key resolving to its own name plus its arguments — so an assertion names
// WHICH message and WHICH interpolated values reached the DOM, never the wording.
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
	page: { params: { id: 'ch-trunc-1' }, url: new URL('http://localhost/challenges/ch-trunc-1') }
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
/** The number the challenge's own dataset reference carries. */
const TOTAL = 11_774;
/** What the route returns for `{ limit: 5 }` — never more, whatever `rowCount` says. */
const FETCHED = 5;

/**
 * ⚠️ THE FIGURES ARE ALREADY GROUPED BEFORE THEY REACH THE MESSAGE. The call site wraps both in
 * `num(_, locale.current)`, so the key-name stub receives the STRING "11,774" and joins its
 * arguments with a comma — `dataset_preview_more:5,11,774`. Built with `Intl` rather than typed as a
 * literal so this file states the rule instead of hard-coding one locale's separator.
 */
const grouped = (n: number) => new Intl.NumberFormat('en').format(n);

function detail(rowCount: number): ChallengeDetail {
	return {
		id: 'ch-trunc-1',
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
		datasets: [
			{ slug: SLUG, name: 'Claims 2026', note: '', rowCount }
		] as ChallengeDetail['datasets'],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: []
	};
}

/** The preview body the route builds: `min(rowCount, limit)` rows and nothing about the total. */
function preview(rowCount: number, limit = FETCHED) {
	return {
		columns: [{ name: 'bedrag', type: 'number' as const }],
		rows: Array.from({ length: Math.min(rowCount, limit) }, (_, i) => ({ bedrag: i }))
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

/** Mount the page on a challenge whose one dataset has `rowCount`, and open its preview. */
async function openPreview(rowCount: number) {
	getChallenge.mockResolvedValue(detail(rowCount));
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(liveCycle());
	listDatasets.mockResolvedValue({ items: [] });
	getDataset.mockResolvedValue(preview(rowCount));
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	const toggle = dsRow().querySelector('button.ds-toggle') as HTMLButtonElement | null;
	expect(toggle, 'no preview toggle on the dataset row').not.toBeNull();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The dataset list is inside `{#if data}`; on a page still loading there is
 * no row, no table and no notice, and every negative assertion below passes for free.
 */
function dsRow(): HTMLElement {
	// By `data-slug`, not by visible text: the slug is no longer printed on the row (W8/P1).
	const li = host.querySelector(`.ds-list li[data-slug="${SLUG}"]`) ?? undefined;
	expect(li, 'the dataset row never rendered — this case tests nothing').toBeTruthy();
	return li as HTMLElement;
}
const bodyRows = () => dsRow().querySelectorAll('table.sample tbody tr').length;
const notice = () => dsRow().querySelector('.sample-more');

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

describe('/challenges/[id] says why its dataset preview stops', () => {
	it('⛔ THE DEFECT: five rows of an 11 774-row dataset explain themselves', async () => {
		// REVERT THAT TURNS THIS RED: drop `totalRows={ds.rowCount}` from the mount. `total` falls back
		// to `rows.length` (5), the notice's condition becomes `5 > 5`, and `.sample-more` is gone.
		await openPreview(TOTAL);

		expect(host.querySelector('table.sample'), 'the preview table never rendered').not.toBeNull();
		expect(bodyRows(), 'the row did not render the five fetched rows').toBe(FETCHED);

		const more = notice();
		expect(more, 'the table stopped at five rows with no explanation').not.toBeNull();
		expect(more!.textContent).toBe(`dataset_preview_more:${grouped(FETCHED)},${grouped(TOTAL)}`);
	});

	it('⛔ …and the number is the DATASET’s size, not the fetched array’s length', async () => {
		// The heart of it. `rows.length` is 5 in this fixture, so a notice derived from the array could
		// only ever say "5 of 5" — which is why the old condition could not fire at all.
		await openPreview(TOTAL);
		expect(notice()!.textContent).toContain(grouped(TOTAL));
		expect(notice()!.textContent).not.toBe(
			`dataset_preview_more:${grouped(FETCHED)},${grouped(FETCHED)}`
		);
	});

	it('⚠️ and it AGREES with the meta line one element above it', async () => {
		// The self-contradiction this closes was inside a single `<li>`: `.ds-meta` grouped 11 774
		// while the table beneath it silently stopped at five. Both figures now come from `ds.rowCount`.
		await openPreview(TOTAL);
		expect(dsRow().querySelector('.ds-meta')?.textContent).toContain(grouped(TOTAL));
		expect(notice()!.textContent).toContain(grouped(TOTAL));
	});

	it('a dataset that FITS says nothing — the notice is not unconditional', async () => {
		// The complement. "Always render it" satisfies every case above and would caption every small
		// dataset on the product with "3 of 3 rows shown".
		await openPreview(3);
		expect(bodyRows()).toBe(3);
		expect(notice(), 'a complete table was labelled as truncated').toBeNull();
	});

	it('EXACTLY ONE WINDOW says nothing either — the boundary is `>`, not `>=`', async () => {
		await openPreview(FETCHED);
		expect(bodyRows()).toBe(FETCHED);
		expect(notice()).toBeNull();
	});

	it('⛔ THE WINDOW IS NOT WIDENED — the fix is the sentence, not the ceiling', async () => {
		// A "fix" that fetched every row would also make the notice disappear, and would put an
		// 11 774-row table inside a challenge card. Pin the request.
		await openPreview(TOTAL);
		expect(getDataset).toHaveBeenCalledWith(SLUG, { limit: FETCHED });
	});
});
