// @vitest-environment jsdom
//
// src/routes/challenges/challenges-page.vote-revert.render.test.ts — a vote that never happened
// stayed on the board.
//
// ⛔ THE DEFECT, AND IT IS THE ONE COMMIT 670a567 FIXED ONE FILE OVER. `vote()` writes the new count
// optimistically and, on failure, delegates the whole repair to `await load()`. `load()`'s own catch
// (`+page.svelte`, the `{ error = errorText(...) }` arm) writes ONLY `error` — it never touches
// `list`, because `list` is assigned inside the `try` that just rejected. So on the failure that
// actually happens in the field — offline, or a session that expired mid-click, where the vote POST
// and the follow-up list GET fail TOGETHER — the phantom `votesCount + 1` and `hasVoted: true`
// SURVIVE, under a banner saying the vote was refused. A reader who is told "that did not work" and
// shown a count that says it did believes the count. Same shape, same repair: revert the captured
// value first, then reconcile.
//
// ⛔ THE TWO FAILURE PATHS ARE SEPARATE CASES, AND THAT SEPARATION IS THE POINT — 670a567's test
// makes the same split. A repair that reverts only when the reload SUCCEEDS is green on the common
// 403 (`self_vote_not_allowed`) and broken on the outage; a repair that reverts only the count and
// not `hasVoted` is green on the number and leaves the pill filled in. Neither case catches the
// other, and the second one is the SAME outage as the first, not a rarer one.
//
// ⚠️ NON-VACUITY IS LOAD-BEARING HERE IN THREE PLACES, because this page can render a
// vote-shaped nothing:
//   1. `load()` awaits `challengesApi.list` AND `cycleApi.current`; an unstubbed module leaves the
//      page in `{#if loading && !list}` forever and `pill()` would throw rather than assert.
//   2. A pill on a CLOSED challenge is `disabled` (VoteButton's `blockedReason`), so a click does
//      nothing and "the count did not move" passes for a reason that has nothing to do with the
//      revert. Every case asserts the pill is enabled BEFORE clicking.
//   3. Each case opens by asserting the optimistic write HAPPENED — otherwise there is nothing to
//      revert and "the count is 284" is true of a page that ignored the click.
//
// NEGATIVE CONTROL, MEASURED against the pre-fix `vote()` (the catch body reduced to
// `voteError = …; await load();` — `git show 928fec2^:src/routes/challenges/+page.svelte`):
//   3 failed | 3 passed. Quoted verbatim:
//     · "the count kept a vote the server refused, with the reload down too: expected 285 to be 284"
//     · "a failed unvote destroyed a vote that is still on the server: expected 284 to be 285"
//     · "the failed row kept its phantom: expected 285 to be 284"
//
// ⚠️ AND THE THREE THAT PASS PRE-FIX ARE NAMED, BECAUSE A CASE THAT CANNOT RED IS NOT EVIDENCE.
// The happy path and the "reload that returns a DIFFERENT count" case are deliberately not
// discriminating — they exist to keep the revert from being written as something that swallows the
// server's answer. And "a refused vote with a WORKING reload" passes pre-fix too: that is exactly
// the path the delegated `await load()` DOES repair, which is why the defect went unnoticed. It is
// kept as the contrast that makes the next case's failure mean something.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeList, ChallengeRow } from '$lib/types/challenges';

// Real `en` catalog, each key resolving to its own name.
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
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

// ⛔ `vi.hoisted` handles, not bare `vi.fn()` inside the factory — the whole file turns on being
// able to `mockRejectedValue` the vote AND the reload from inside a case.
const { listChallenges, currentCycle, voteApi, unvoteApi } = vi.hoisted(() => ({
	listChallenges: vi.fn(),
	currentCycle: vi.fn(),
	voteApi: vi.fn(),
	unvoteApi: vi.fn()
}));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: { list: listChallenges, vote: voteApi, unvote: unvoteApi }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const LIVE_ID = 'live-1';
const OTHER_ID = 'live-2';

function row(id: string, votesCount: number, hasVoted = false): ChallengeRow {
	return {
		id,
		code: `CH-${id}`,
		title: `Challenge ${id}`,
		workArea: 'Claims',
		status: 'voting',
		// ⚠️ `cycleClosed: false` — a closed challenge renders the pill DISABLED, and every case
		// below would then pass against a control that cannot be clicked at all.
		week: '2026-W24',
		cycleClosed: false,
		tags: [],
		votesCount,
		rank: 1,
		hasVoted,
		solutionsCount: 0,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-05-20T00:00:00.000Z'
	};
}

function list(items: ChallengeRow[]): ChallengeList {
	return {
		items,
		total: items.length,
		page: 1,
		pageSize: 20,
		counts: { all: items.length, Claims: items.length },
		sort: 'top'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(items: ChallengeRow[]) {
	window.history.replaceState({}, '', '/challenges');
	listChallenges.mockResolvedValue(list(items));
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * The vote pill of the Nth rendered row, PROVING it is there and clickable.
 *
 * ⛔ THE POSITIVE MARKER, and it guards two different vacuities at once: a page still in its
 * loading arm has no pill (so `count()` would read `undefined` and every "unchanged" assertion
 * would be trivially true), and a pill on a closed cycle is `disabled` (so the click that is
 * supposed to produce something to revert produces nothing).
 */
function pill(n = 0): HTMLButtonElement {
	const pills = [...host.querySelectorAll<HTMLButtonElement>('button.vote')];
	expect(
		pills.length,
		'no vote pill on screen — the page is still loading and every assertion here is vacuous'
	).toBeGreaterThan(n);
	const btn = pills[n]!;
	expect(btn.disabled, 'the vote pill is inert — this case tests nothing').toBe(false);
	return btn;
}
/** The number the reader can actually see in the pill. */
const count = (n = 0) => Number(pill(n).querySelector('.num')!.textContent!.replace(/\D/g, ''));
/** Whether the pill renders as "you voted" — `aria-pressed`, which is `hasVoted` verbatim. */
const voted = (n = 0) => pill(n).getAttribute('aria-pressed') === 'true';
const banner = () =>
	[...host.querySelectorAll('.notice.error')].map((n) => n.textContent?.trim() ?? '');

async function click(n = 0) {
	pill(n).click();
	await settle();
}

/** The page's LOAD-error arm — mutually exclusive with the board on this page. */
const loadErrorArm = () => host.querySelector('.notice.error[role="alert"]');

/**
 * ⛔ THE WINDOW IN WHICH A LIST PAGE ACTUALLY SHOWS ITS PHANTOM, AND WHY THESE CASES NEED A HELPER
 * WHERE THE DETAIL PAGES DO NOT. `/challenges` renders `{:else if error}` as an arm that REPLACES
 * the board, so while a reload is failing the stale rows are hidden — the phantom is in `list`, not
 * on screen. The detail pages guard the same arm with `&& !data`, so there the phantom is visible
 * immediately and permanently (pinned in challenge-detail.vote-revert.render.test.ts).
 *
 * Here it becomes visible the moment `error` clears, which is the FIRST LINE of `load()` — so every
 * press of the arm's own Retry button re-renders the board, dimmed, out of whatever `list` holds,
 * before the retry has answered anything. That is a real screen a real reader sees on every retry
 * during an outage, so it is where these cases measure: click Retry, flush SYNCHRONOUSLY, and read
 * the pill before the request settles.
 */
function retryWindow(): void {
	const retry = host.querySelector<HTMLButtonElement>('.notice.error[role="alert"] button.retry');
	expect(retry, 'no load-error arm — this case is not reproducing the outage it describes').not.toBe(
		null
	);
	retry!.click();
	// NOT `await settle()` — awaiting lets the retry reject and closes the window again.
	flushSync();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.clearAllMocks();
});

describe('/challenges — a refused vote does not stay on the board', () => {
	it('the happy path applies the server count — otherwise there is nothing to revert', async () => {
		// NON-VACUITY FOR THE WHOLE FILE. If a click never reached `vote()` at all, every case below
		// would pass with the optimistic write deleted.
		await render([row(LIVE_ID, 284)]);
		expect(count()).toBe(284);
		voteApi.mockResolvedValue({ voted: true, count: 285 });
		await click();
		expect(voteApi).toHaveBeenCalledWith(LIVE_ID);
		expect(count()).toBe(285);
		expect(voted()).toBe(true);
		expect(banner()).toEqual([]);
	});

	it('⛔ a refused vote with a WORKING reload: the count goes back to what the server has', async () => {
		// The common case — 403 `self_vote_not_allowed`, network fine. A repair that reverts ONLY
		// through a successful `load()` is green here and broken in the next case.
		await render([row(LIVE_ID, 284)]);
		voteApi.mockRejectedValue(new Error('403 self_vote_not_allowed'));
		// The reload answers with the untouched truth, exactly as the server would.
		listChallenges.mockResolvedValue(list([row(LIVE_ID, 284)]));

		await click();

		expect(count(), 'the count kept a vote the server refused').toBe(284);
		expect(voted(), 'the pill is still filled in after a refused vote').toBe(false);
		// …and the reader is TOLD, which is the half `voteError` already got right.
		expect(banner()).toEqual(['error_action_failed']);
	});

	it('⛔ a refused vote AND a failing reload: the SAME outage, and the count still goes back', async () => {
		// ⛔ THIS IS THE DEFECT. Offline, or a session that expired mid-click: the POST and the GET
		// fail together, `load()`'s catch writes only `error`, and the delegated repair repairs
		// nothing. The phantom count survives under a banner that says the vote was refused.
		await render([row(LIVE_ID, 284)]);
		voteApi.mockRejectedValue(new Error('network'));
		listChallenges.mockRejectedValue(new Error('network'));

		await click();

		// NON-VACUITY: the outage really did take the reload down too, which is what puts this page
		// into its load-error arm and hides the board.
		expect(loadErrorArm(), 'the reload did not fail — this is case 2 again, not the outage').not.toBe(
			null
		);
		retryWindow();

		expect(count(), 'the count kept a vote the server refused, with the reload down too').toBe(
			284
		);
		expect(voted(), 'the pill is still filled in with the reload down too').toBe(false);
	});

	it('⛔ an UNVOTE that fails puts the vote back — the revert is not a one-way decrement', async () => {
		// The mirror direction. A repair written as "subtract what we added" is green on the vote and
		// silently wrong here, because the optimistic write was a SUBTRACTION.
		await render([row(LIVE_ID, 285, true)]);
		expect(count()).toBe(285);
		expect(voted()).toBe(true);
		unvoteApi.mockRejectedValue(new Error('network'));
		listChallenges.mockRejectedValue(new Error('network'));

		await click();

		expect(unvoteApi).toHaveBeenCalledWith(LIVE_ID);
		retryWindow();
		expect(count(), 'a failed unvote destroyed a vote that is still on the server').toBe(285);
		expect(voted(), 'the pill stopped showing a vote that was never withdrawn').toBe(true);
	});

	it('⛔ the revert touches only the row that failed, not the whole board', async () => {
		// ⚠️ THE REASON THE REVERT IS A ROW REWRITE AND NOT A SNAPSHOT RESTORE. Several rows can sit
		// in `voteBusy` at once. Rolling `list` back to a pre-click snapshot would also undo the
		// SECOND row's vote, which succeeded — the phantom's mirror image, and just as wrong.
		await render([row(LIVE_ID, 284), row(OTHER_ID, 100)]);
		listChallenges.mockRejectedValue(new Error('network'));

		// Row 2 succeeds…
		voteApi.mockResolvedValueOnce({ voted: true, count: 101 });
		await click(1);
		expect(count(1)).toBe(101);

		// …row 1 fails.
		voteApi.mockRejectedValue(new Error('network'));
		await click(0);
		retryWindow();

		expect(count(0), 'the failed row kept its phantom').toBe(284);
		expect(count(1), 'an unrelated row was rolled back too').toBe(101);
		expect(voted(1), 'an unrelated row lost its vote').toBe(true);
	});

	it('⛔ a reload that returns a DIFFERENT count wins over the revert — the server is the authority', async () => {
		// ⚠️ THE REVERT IS A FLOOR, NOT A CEILING. It runs first precisely so that a reload which DOES
		// answer can overwrite it: the POST may have succeeded with only its response lost, and other
		// readers vote too. A repair that reverted AFTER `load()` would show 284 over a server that
		// says 290 — trading one wrong number for another.
		await render([row(LIVE_ID, 284)]);
		voteApi.mockRejectedValue(new Error('500'));
		listChallenges.mockResolvedValue(list([row(LIVE_ID, 290, false)]));

		await click();

		expect(count(), 'the local revert overwrote the server truth').toBe(290);
	});
});
