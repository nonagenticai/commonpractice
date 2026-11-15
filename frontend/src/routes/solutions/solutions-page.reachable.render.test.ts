// @vitest-environment jsdom
//
// src/routes/solutions/solutions-page.reachable.render.test.ts — the leaderboard page must ASK the
// server for the rows it cannot see, and tell the truth when it finds none.
//
// THE DEFECT. The backend has paged since day one (`PAGE_SIZE = 10`, `limit`/`offset`, a real
// `total`) and the client wrapper has always supported `page`. The page passed NEITHER. It rendered
// the first ten rows with no pager, and its search box `.filter()`ed those same ten rows in the
// browser — so on a fourteen-entry challenge the builder at rank 14 was unreachable by scrolling
// AND unfindable by searching, and the search box answered "no solutions match your search" about
// a row it had never been given.
//
// The backend half is proven in backend/tests/solutions-pagination-search.test.ts. THIS file proves
// the browser actually uses it: the assertions are about what `solutionsApi.list` is CALLED WITH.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionList, SolutionRow } from '$lib/types/solutions';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/solutions') } }));

// The locale-switch reload path, captured rather than driven. `reloadOnLocaleChange` is a thin
// `$effect` over the locale rune; intercepting it lets these tests FIRE that path deterministically
// and assert what the page does with it, without standing up a Paraglide runtime.
const { localeReload } = vi.hoisted(() => ({ localeReload: { fire: null as null | (() => void) } }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({
	reloadOnLocaleChange: (load: () => void) => {
		localeReload.fire = load;
	}
}));

const { listSolutions, listChallenges } = vi.hoisted(() => ({
	listSolutions: vi.fn(),
	listChallenges: vi.fn()
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { list: listSolutions, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/challenges', () => ({ challengesApi: { list: listChallenges } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const CH_ID = '00000000-0000-4000-8000-0000000000c1';

function challengePage(page: number, total: number) {
	const per = 10;
	const items = Array.from({ length: Math.max(0, Math.min(per, total - (page - 1) * per)) }, (_, i) => ({
		id: page === 1 && i === 0 ? CH_ID : `ch-${(page - 1) * per + i + 1}`,
		code: `CH-${(page - 1) * per + i + 1}`,
		title: `Challenge ${(page - 1) * per + i + 1}`,
		submitter: { name: 'Someone', initials: 'SO' }
	}));
	return { items, total, page, pageSize: per, counts: { all: total }, sort: 'top' };
}

function row(rank: number, title: string): SolutionRow {
	return {
		id: `sol-${rank}`,
		rank,
		title,
		status: 'voting',
		votesCount: 100 - rank,
		// ⛔ `0`, NOT A POSITIVE NUMBER, AND NOT NULL. This fixture is the entire non-vacuity of the
		// demo-duration guard on the row: the board used to test `{#if row.demoSeconds}`, and a
		// truthiness check passes and fails identically to `!= null` for every value EXCEPT a genuine
		// zero. With `demoMs: 42` this file would go green against the reverted guard and prove
		// nothing. A run measured at 0 ms is data — an answer, not the absence of one.
		demoMs: 0,
		blocksUsed: [],
		hasFlow: false,
		hasVoted: false,
		author: { name: `Builder ${rank}`, initials: 'B' }
	} as unknown as SolutionRow;
}

function board(ranks: number[], total: number, page = 1): SolutionList {
	return {
		items: ranks.map((r) => row(r, `Entry ${r}`)),
		total,
		page,
		pageSize: 10,
		challenge: { id: CH_ID, code: 'CH-1', title: 'Challenge 1' }
	} as unknown as SolutionList;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	// ⛔ SIXTEEN, NOT THREE, AND THAT IS THE WHOLE NON-VACUITY OF THE LOCALE-SWITCH GUARD BELOW.
	// The selector is built in two steps — page 1 is applied on its own so the board can start, then
	// the full walk is folded in — and with three challenges on ONE page those two steps carry the
	// same list, so the "keep the reader's selection" branch can never be handed a selection that is
	// missing. `PAGE_SIZE` is ten on the server, and the local dev DB has six challenges, which is
	// exactly why the defect this fixture now reaches survived: it needs an eleventh row to exist.
	listChallenges.mockImplementation(async ({ page = 1 }: { page?: number } = {}) =>
		challengePage(page, 16)
	);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	listSolutions.mockReset();
	listChallenges.mockReset();
	localeReload.fire = null;
});

const selector = () => target.querySelector('select#ch') as HTMLSelectElement;
const searchBox = () => target.querySelector('input[type="search"]') as HTMLInputElement;

function clickPagerNext() {
	const next = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'pager_next');
	expect(next, 'no Next button — the pager did not render').toBeTruthy();
	next!.click();
}

/** Type into the search box and let the 250 ms debounce elapse. */
async function search(term: string) {
	const box = searchBox();
	box.value = term;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	await new Promise((r) => setTimeout(r, 350));
	await settle();
}

function lastBoardCall(): { challengeId?: string; q?: string; page?: number } {
	const call = listSolutions.mock.calls.at(-1);
	expect(call, 'the board was never fetched').toBeTruthy();
	return call![0] ?? {};
}

describe('/solutions reaches every row', () => {
	it('renders a pager and fetches PAGE 2 from the server, with ranks past the first ten', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();

		// 10 of 14 → a second page exists, so the pager must be on screen. (With ten rows and a page
		// size of ten it would not be, which is why the fixture is fourteen.)
		expect(target.textContent).toContain('pager_showing:10,14');
		expect(target.textContent).toContain('pager_page:1,2');

		listSolutions.mockResolvedValueOnce(board([11, 12, 13, 14], 14, 2));
		const next = [...target.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'pager_next'
		);
		expect(next, 'no Next button — the pager did not render').toBeTruthy();
		next!.click();
		await settle();

		// The page ASKED THE SERVER for page 2 …
		expect(listSolutions).toHaveBeenLastCalledWith(
			expect.objectContaining({ challengeId: CH_ID, page: 2 })
		);
		// … and the rows nobody could reach before are on screen.
		expect(target.textContent).toContain('Entry 14');
		expect(target.textContent).not.toContain('Entry 1 ');
	});

	it('renders NO pager when there is only one page', async () => {
		// The /challenges behaviour, kept: "Page 1 / 1" with two dead buttons under a three-row list
		// is a visible-but-inert control, which is the class of thing this PR exists to remove.
		listSolutions.mockResolvedValueOnce(board([1, 2, 3], 3));
		await render();
		expect(target.textContent).toContain('Entry 3');
		expect(target.textContent).not.toContain('pager_page');
		expect(target.textContent).not.toContain('pager_showing');
	});

	it('sends the search term TO THE SERVER instead of filtering the ten loaded rows', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();
		listSolutions.mockClear();

		const search = target.querySelector('input[type="search"]') as HTMLInputElement;
		expect(search, 'no search box on the page').toBeTruthy();
		listSolutions.mockResolvedValueOnce(board([1], 1));
		search.value = 'needleword';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		// ~250 ms debounce, copied from /challenges.
		await new Promise((r) => setTimeout(r, 350));
		await settle();

		expect(listSolutions).toHaveBeenCalledTimes(1);
		expect(listSolutions).toHaveBeenLastCalledWith(
			expect.objectContaining({ challengeId: CH_ID, q: 'needleword', page: 1 })
		);
	});

	it('a NO-MATCH search says so, instead of "nothing here yet, go build one"', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3], 3));
		await render();

		const search = target.querySelector('input[type="search"]') as HTMLInputElement;
		listSolutions.mockResolvedValueOnce(board([], 0));
		search.value = 'zzzz-no-such-thing';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 350));
		await settle();

		expect(target.textContent).toContain('solutions_no_match');
		// The invitation to build the FIRST solution is a lie on a board that has three.
		expect(target.textContent).not.toContain('solutions_empty_pre');
	});

	it('a genuinely empty board still invites the reader to build one', async () => {
		listSolutions.mockResolvedValueOnce(board([], 0));
		await render();
		expect(target.textContent).toContain('solutions_empty_pre');
		expect(target.textContent).not.toContain('solutions_no_match');
	});

	it('offers EVERY challenge in the selector, not just the first page', async () => {
		listChallenges.mockImplementation(async ({ page = 1 }: { page?: number } = {}) =>
			challengePage(page, 16)
		);
		listSolutions.mockResolvedValue(board([1], 1));
		await render();

		const options = target.querySelectorAll('select#ch option');
		expect(options).toHaveLength(16);
		expect(listChallenges).toHaveBeenCalledTimes(2);
		// Nothing to announce when nothing was truncated.
		expect(target.textContent).not.toContain('solutions_selector_capped');
	});

	it('NAMES the true total when the selector had to stop short', async () => {
		// 205 challenges > the 20-page ceiling → 200 offered, 5 unreachable. The reader must be told.
		listChallenges.mockImplementation(async ({ page = 1 }: { page?: number } = {}) =>
			challengePage(page, 205)
		);
		listSolutions.mockResolvedValue(board([1], 1));
		await render();

		expect(target.textContent).toContain('solutions_selector_capped:200,205');
		const link = [...target.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/challenges');
		expect(link, 'the truncation note must point somewhere the rest is reachable').toBeTruthy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The page number is per-BOARD state. Every input that changes which rows the board is showing
// has to put it back to 1, or the next request asks for page 3 of a result set that has one page
// and the reader gets the empty state — with `Pager` rendered AFTER the empty-state arms, so
// there is no longer a control to page back with.
//
// ⚠️ These resets EXISTED and were entirely unpinned: deleting both `boardPage = 1` lines left the
// whole suite green. Every assertion below is on the ARGUMENT of the request, because that is the
// only place the bug is visible before it becomes a blank screen.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('/solutions never carries a page number onto a board that has no such page', () => {
	it('a SEARCH from page 2 asks for page 1', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();

		listSolutions.mockResolvedValueOnce(board([11, 12, 13, 14], 14, 2));
		clickPagerNext();
		await settle();
		expect(lastBoardCall().page, 'precondition: the reader is on page 2').toBe(2);

		// One hit — page 2 of it does not exist.
		listSolutions.mockResolvedValueOnce(board([12], 1));
		await search('needleword');

		expect(lastBoardCall()).toEqual(
			expect.objectContaining({ challengeId: CH_ID, q: 'needleword', page: 1 })
		);
		expect(target.textContent).toContain('Entry 12');
		expect(target.textContent).not.toContain('solutions_no_match');
	});

	it('CHANGING THE CHALLENGE from page 2 asks for page 1 of the new board', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();

		listSolutions.mockResolvedValueOnce(board([11, 12, 13, 14], 14, 2));
		clickPagerNext();
		await settle();
		expect(lastBoardCall().page).toBe(2);

		listSolutions.mockResolvedValueOnce(board([1, 2], 2));
		const sel = selector();
		sel.value = 'ch-2';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(lastBoardCall()).toEqual(expect.objectContaining({ challengeId: 'ch-2', page: 1 }));
	});

	it('a page PAST THE END clamps back to page 1 instead of stranding the reader on a blank board', async () => {
		// The rows behind page 2 can vanish between the two requests (someone deletes them, a
		// sibling tab retracts votes). The response is then an empty board on page 2 — the empty
		// state, with the pager below it and therefore off screen.
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();

		listSolutions.mockResolvedValueOnce(board([], 3, 2));
		listSolutions.mockResolvedValueOnce(board([1, 2, 3], 3));
		clickPagerNext();
		await settle();

		expect(lastBoardCall().page).toBe(1);
		expect(target.textContent).toContain('Entry 3');
		expect(target.textContent).not.toContain('solutions_empty_pre');
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Switching language re-fetches BOTH the selector labels and the board (titles are localized
// server-side). Doing that as two un-awaited calls raced them, and `loadChoices` reassigning
// `selectedChallenge` to `items[0]` made the loser visible: the board kept the old challenge's
// rows while the dropdown snapped to a different challenge, and nothing re-fired the board.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('/solutions survives a locale switch', () => {
	it('leaves the selector and the board naming the SAME challenge', async () => {
		listSolutions.mockResolvedValue(board([1, 2], 2));
		await render();
		expect(target.querySelectorAll('select#ch option'), 'precondition: the whole walk landed').toHaveLength(16);

		// ⛔ CHALLENGE #14, NOT #2, AND THE RANK IS THE POINT. The re-load applies page 1 FIRST so the
		// board is not held hostage to the rest of the walk — and page 1 is ten rows. A reader parked
		// on anything from #11 down is, for the duration of that first apply, on a challenge the list
		// does not contain, which is the only moment the selection can be lost. Picking #2 (as this
		// test used to) puts the reader on a row that is present in BOTH applies, so the guard below
		// is satisfied by the fixture rather than by the code and the test cannot fail.
		const sel = selector();
		sel.value = 'ch-14';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(selector().value).toBe('ch-14');

		listSolutions.mockClear();
		expect(localeReload.fire, 'the page never registered a locale-change reload').toBeTruthy();
		localeReload.fire!();
		await settle();

		// The selector was rebuilt in the new language but must still point where the reader left
		// it — and the board must have been fetched for THAT challenge, not for whatever
		// `selectedChallenge` happened to hold while the selector was still in flight.
		expect(
			selector().value,
			'the reader changed language and is now reading a DIFFERENT challenge’s leaderboard'
		).toBe('ch-14');
		expect(lastBoardCall().challengeId).toBe('ch-14');
		expect(lastBoardCall().challengeId).toBe(selector().value);
	});

	it('⛔ …and the FIRST board request already names the right challenge, not just the last', async () => {
		// The partial apply awaits `loadBoard()` before the walk finishes, so a selection clobbered
		// there is not a flicker that heals: the board request has already gone out against the wrong
		// challenge, and by the time the full list lands `previous` is the wrong challenge too, so
		// nothing can put it back. Asserting only on the LAST call would let a fix that merely
		// re-fires the board pass while the reader still sees a foreign board for a round-trip.
		listSolutions.mockResolvedValue(board([1, 2], 2));
		await render();
		const sel = selector();
		sel.value = 'ch-14';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		listSolutions.mockClear();
		localeReload.fire!();
		await settle();

		const asked = listSolutions.mock.calls.map((c) => (c[0] ?? {}).challengeId);
		expect(asked.length, 'the locale switch never re-fetched the board').toBeGreaterThan(0);
		expect(asked, 'a board for a challenge the reader never chose was requested').toEqual(
			asked.map(() => 'ch-14')
		);
	});

	it('resets to page 1 when the challenge the reader was on is GONE from the new list', async () => {
		listSolutions.mockResolvedValueOnce(board([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14));
		await render();

		listSolutions.mockResolvedValueOnce(board([11, 12, 13, 14], 14, 2));
		clickPagerNext();
		await settle();
		expect(lastBoardCall().page).toBe(2);

		// The selection genuinely moves (the challenge was closed/deleted meanwhile), so page 2 of
		// the OLD board is meaningless against the new one.
		listChallenges.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
			...challengePage(page, 1),
			items: [
				{ id: 'ch-other', code: 'CH-9', title: 'Another', submitter: { name: 'Someone', initials: 'SO' } }
			]
		}));
		listSolutions.mockResolvedValueOnce(board([1], 1));
		localeReload.fire!();
		await settle();

		expect(lastBoardCall()).toEqual(expect.objectContaining({ challengeId: 'ch-other', page: 1 }));
	});
});

describe('/solutions does not hold the board hostage to the selector', () => {
	it('renders rows while the REST of the challenge pages are still in flight', async () => {
		// 25 challenges = three pages. Page 1 answers; pages 2+ never do. The board needs exactly
		// `items[0].id` from page 1, so waiting for the whole walk (up to 20 serial round-trips)
		// before issuing the board request is latency spent for nothing.
		listChallenges.mockImplementation(async ({ page = 1 }: { page?: number } = {}) =>
			page === 1 ? challengePage(1, 25) : new Promise(() => {})
		);
		listSolutions.mockResolvedValue(board([1, 2, 3], 3));
		await render();

		expect(listSolutions).toHaveBeenCalled();
		expect(target.textContent).toContain('Entry 3');
		expect(target.textContent).not.toContain('solutions_loading');
		// …and no truncation claim while the walk is merely UNFINISHED. The note means "the rest is
		// unreachable from here", not "still loading".
		expect(target.textContent).not.toContain('solutions_selector_capped');
	});
});

// ── WS-2: the demo duration is a MEASURED figure, and 0 is one of its answers ─────────────────
//
// THE DEFECT. The row's demo clause was `{#if row.demoSeconds}` — a truthiness test standing in for
// an existence test. It hid three different facts behind one blank: a NULL (which is what
// `solutions.demo_seconds` was for every solution a real person submitted, because the column was
// only ever written by the seeders), a genuine `0`, and the field being absent altogether. The
// column is gone; `demoMs` is measured from the solution's own runs. The guard is now `!= null`.
describe('/solutions renders a measured demo duration, including a genuine zero', () => {
	it('THE NON-VACUITY CASE — `demoMs: 0` renders the clause; a truthiness guard would swallow it', async () => {
		listSolutions.mockResolvedValueOnce(board([1], 1));
		await render();

		// ⛔ REVERT `{#if row.demoMs != null}` TO `{#if row.demoMs}` IN +page.svelte AND THIS LINE
		// GOES RED — that is the only revert this assertion is here to catch, and it is only
		// catchable because `row()` above supplies `0`. With any positive fixture value both
		// guards render identically and this test is worth nothing.
		//
		// `solutions_live_demo:demo_dur_ms:0` is the mock's `key:params` shape twice over: the row
		// interpolated the message with a duration that the formatter had already built out of the
		// raw `0`. Asserting on the composed string proves the real number reached the formatter
		// rather than a placeholder.
		expect(target.textContent).toContain('solutions_live_demo:demo_dur_ms:0');
	});

	it('a row with NO measured run renders no demo clause at all — not an em dash, not "0"', async () => {
		const none = board([1], 1);
		(none.items[0] as unknown as { demoMs: number | null }).demoMs = null;
		listSolutions.mockResolvedValueOnce(none);
		await render();

		expect(target.textContent).toContain('Entry 1');
		expect(target.textContent).not.toContain('solutions_live_demo');
		expect(target.querySelector('.sol-meta')!.textContent).not.toContain('—');
	});

	it('sub-second durations use the demo unit family, never the /pipeline minutes floor', async () => {
		const fast = board([1], 1);
		(fast.items[0] as unknown as { demoMs: number }).demoMs = 3400;
		listSolutions.mockResolvedValueOnce(fast);
		await render();

		// 3400 ms → `demo_dur_sec` with "3.4". ⛔ NOT `pipeline_dur_min:0`: `duration()` floors at
		// whole minutes, which is right for a promotion interval and renders EVERY demo on this
		// board as "0m". That is the /pipeline "AVG TIME TO LIVE —" bug one order of magnitude down.
		expect(target.textContent).toContain('solutions_live_demo:demo_dur_sec:3.4');
		expect(target.textContent).not.toContain('pipeline_dur_min');
	});
});
