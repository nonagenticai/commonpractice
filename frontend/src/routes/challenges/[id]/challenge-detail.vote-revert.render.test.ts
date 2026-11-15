// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.vote-revert.render.test.ts — a vote the server
// refused stayed on the page, in plain sight.
//
// ⛔ THE DEFECT, AND THIS IS WHERE IT IS DIRECTLY VISIBLE. `vote()` writes the new count
// optimistically and, on failure, delegates the entire repair to `await load()`. `load()`'s own
// catch writes ONLY `error` — `data` is assigned inside the `try` that just rejected — so when the
// vote POST and the follow-up GET fail together (offline, or a session that expired mid-click) the
// phantom `votesCount + 1` survives.
//
// ⛔ AND ON A DETAIL PAGE NOTHING HIDES IT. The load-error arm here is `{:else if error && !data}`
// (+page.svelte), deliberately — a reload failure must not blank a challenge the reader is already
// reading. The consequence is that the stale content STAYS ON SCREEN: the pill keeps the vote,
// filled in and counted, directly under a banner saying the vote was refused. The list boards
// (/challenges, /solutions, /) render `{:else if error}` unguarded, so there the same phantom is
// hidden behind the error arm and only surfaces in the window each Retry opens — measured
// separately in challenges-page.vote-revert.render.test.ts. Same bug, two visibilities; this is the
// worse one.
//
// This is the identical shape commit 670a567 fixed in `lib/stores/notifications.svelte.ts` (the
// badge contradicting the list after a failed mark-read), and it takes the identical repair: revert
// the CAPTURED value first, then reconcile.
//
// ⚠️ NON-VACUITY, three ways, because this page can render a vote-shaped nothing:
//   1. `load()` awaits `challengesApi.get`, `challengesApi.comments` AND `cycleApi.current`; one
//      unstubbed module leaves the page in `{#if loading && !data}` forever and `pill()` returns
//      nothing, making every "the count did not move" assertion trivially true.
//   2. A pill on a closed cycle is `disabled` (VoteButton's `blockedReason`), so the click that is
//      supposed to create something to revert creates nothing. `pill()` asserts it is enabled.
//   3. Each case proves the optimistic write HAPPENED (the happy-path case) or that the detail
//      content is STILL MOUNTED after the failure — a page that blanked itself would pass a
//      "the count is 12" assertion for the wrong reason.
//
// NEGATIVE CONTROL, MEASURED against the pre-fix `vote()` (catch body reduced to
// `if (gen !== navGen) return; voteError = …; await load();` —
// `git show 928fec2^:'src/routes/challenges/[id]/+page.svelte'`): 2 failed | 3 passed. Quoted
// verbatim:
//   · "the count kept a vote the server refused, with the reload down too: expected 13 to be 12"
//   · "a failed unvote destroyed a vote that is still on the server: expected 11 to be 12"
//
// ⚠️ AND THE THREE THAT PASS PRE-FIX ARE NAMED, BECAUSE A CASE THAT CANNOT RED IS NOT EVIDENCE.
// The happy path and the "reload that returns a DIFFERENT count" case are deliberately not
// discriminating — they exist to keep the revert from being written as something that swallows the
// server's answer. "A refused vote with a WORKING reload" passes pre-fix too: that is precisely the
// path the delegated `await load()` DOES repair, which is why this defect went unnoticed for as
// long as it did. It is kept as the contrast that makes the next case's failure mean something.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail } from '$lib/types/challenges';

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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'ch-detail-1' }, url: new URL('http://localhost/challenges/ch-detail-1') }
}));
const CH_ID = 'ch-detail-1';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

// ⛔ `vi.hoisted` handles for the vote calls too — the whole file turns on being able to reject them
// from inside a case.
const { getChallenge, getComments, currentCycle, voteApi, unvoteApi } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getComments: vi.fn(),
	currentCycle: vi.fn(),
	voteApi: vi.fn(),
	unvoteApi: vi.fn()
}));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: {
		get: getChallenge,
		comments: getComments,
		vote: voteApi,
		unvote: unvoteApi,
		updateDatasets: vi.fn(),
		postComment: vi.fn()
	}
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/**
 * ⚠️ `status: 'voting'` AND `cycleApi.current` ANSWERING `null` TOGETHER ARE WHAT KEEP THE PILL
 * LIVE. `voteBlockedReason()` blocks on a closed challenge, and a blocked pill is `disabled` — every
 * case here would then measure a control that cannot be clicked.
 */
function detail(votesCount: number, hasVoted: boolean): ChallengeDetail {
	return {
		id: CH_ID,
		code: 'CH-101',
		title: 'Claims intake takes four days',
		description: 'A description.',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W23',
		tags: [],
		metrics: {},
		votesCount,
		hasVoted,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-06-01T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: []
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(votesCount: number, hasVoted = false) {
	getChallenge.mockResolvedValue(detail(votesCount, hasVoted));
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * The challenge's own vote pill, PROVING it is on screen and clickable.
 *
 * ⛔ `button.vote.md` — the SIZE is the selector, and it is not decoration. Solution rows on this
 * same page render `size="sm"` pills of their own; a bare `button.vote` would happily measure one
 * of those. Today `solutions: []` keeps the list empty, but a fixture that grows one would silently
 * move every assertion here onto the wrong control.
 */
function pill(): HTMLButtonElement {
	const pills = [...host.querySelectorAll<HTMLButtonElement>('button.vote.md')];
	expect(
		pills.length,
		'no challenge vote pill on screen — the page is still loading and this case is vacuous'
	).toBe(1);
	expect(pills[0]!.disabled, 'the vote pill is inert — this case tests nothing').toBe(false);
	return pills[0]!;
}
const count = () => Number(pill().querySelector('.num')!.textContent!.replace(/\D/g, ''));
const voted = () => pill().getAttribute('aria-pressed') === 'true';
/** The ACTION-failure banner (`voteError`), which is NOT the page's load-error arm. */
const voteBanner = () =>
	[...host.querySelectorAll('.notice.error')]
		.filter((n) => n.getAttribute('role') !== 'alert')
		.map((n) => n.textContent?.trim() ?? '');

async function click() {
	pill().click();
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
	vi.clearAllMocks();
});

describe('/challenges/[id] — a refused vote does not stay on the page', () => {
	it('the happy path applies the server count — otherwise there is nothing to revert', async () => {
		// NON-VACUITY FOR THE WHOLE FILE. With the optimistic write deleted, every case below would
		// pass on a page that simply ignored the click.
		await render(12);
		expect(count()).toBe(12);
		voteApi.mockResolvedValue({ voted: true, count: 13 });
		await click();
		expect(voteApi).toHaveBeenCalledWith(CH_ID);
		expect(count()).toBe(13);
		expect(voted()).toBe(true);
		expect(voteBanner()).toEqual([]);
	});

	it('⛔ a refused vote with a WORKING reload: the count goes back to what the server has', async () => {
		// The common refusal — 403 `self_vote_not_allowed`, network fine. A repair that reverts ONLY
		// through a successful `load()` is green here and broken in the next case.
		await render(12);
		voteApi.mockRejectedValue(new Error('403 self_vote_not_allowed'));
		getChallenge.mockResolvedValue(detail(12, false));

		await click();

		expect(count(), 'the count kept a vote the server refused').toBe(12);
		expect(voted(), 'the pill is still filled in after a refused vote').toBe(false);
		expect(voteBanner()).toEqual(['error_action_failed']);
	});

	it('⛔ a refused vote AND a failing reload: the phantom is on screen, and it must not be', async () => {
		// ⛔ THIS IS THE DEFECT, AND ON THIS PAGE IT NEEDS NO WINDOW TO SEE IT. `{:else if error &&
		// !data}` keeps the detail content mounted through a failed reload, so the stale pill sits
		// there, filled in and counted, under a banner saying the vote was refused.
		await render(12);
		voteApi.mockRejectedValue(new Error('network'));
		getChallenge.mockRejectedValue(new Error('network'));
		getComments.mockRejectedValue(new Error('network'));

		await click();

		// NON-VACUITY: the content really is still mounted — this case is not passing because the
		// page blanked itself.
		expect(host.textContent, 'the page blanked — nothing here is about the vote').toContain(
			'Claims intake takes four days'
		);
		expect(count(), 'the count kept a vote the server refused, with the reload down too').toBe(12);
		expect(voted(), 'the pill is still filled in with the reload down too').toBe(false);
		// …and the reader is still TOLD, which is the half `voteError` already got right.
		expect(voteBanner()).toEqual(['error_action_failed']);
	});

	it('⛔ an UNVOTE that fails puts the vote back — the revert is not a one-way decrement', async () => {
		// The mirror direction. A repair written as "subtract what we added" is green on the vote and
		// silently wrong here, because the optimistic write was a SUBTRACTION.
		await render(12, true);
		expect(count()).toBe(12);
		expect(voted()).toBe(true);
		unvoteApi.mockRejectedValue(new Error('network'));
		getChallenge.mockRejectedValue(new Error('network'));
		getComments.mockRejectedValue(new Error('network'));

		await click();

		expect(unvoteApi).toHaveBeenCalledWith(CH_ID);
		expect(count(), 'a failed unvote destroyed a vote that is still on the server').toBe(12);
		expect(voted(), 'the pill stopped showing a vote that was never withdrawn').toBe(true);
	});

	it('⛔ a reload that returns a DIFFERENT count wins over the revert — the server is the authority', async () => {
		// ⚠️ THE REVERT IS A FLOOR, NOT A CEILING, and it runs FIRST precisely so a reload that DOES
		// answer can overwrite it: the POST may have succeeded with only its response lost, and other
		// readers vote too. A repair that reverted AFTER `load()` would show 12 over a server saying
		// 20 — trading one wrong number for another.
		await render(12);
		voteApi.mockRejectedValue(new Error('500'));
		getChallenge.mockResolvedValue(detail(20, false));

		await click();

		expect(count(), 'the local revert overwrote the server truth').toBe(20);
	});
});
