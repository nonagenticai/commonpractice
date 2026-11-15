// @vitest-environment jsdom
//
// src/routes/solutions/solutions-page.vote-control.render.test.ts — the solution board's vote pill
// must follow the SOLUTION'S OWN COMPETING CYCLE (`cycleClosed`), not its parent challenge and not
// its own status column.
//
// ⛔ THIS FILE USED TO ASSERT THE EXACT INVERSE, AND THAT IS THE POINT. Its fixtures varied
// `challengeStatus` alone and pinned "a CLOSED parent makes every pill inert" as correct, because
// `host/vote-service.ts` really did gate on the parent. That rule is why the marketplace announced
// no winner for nine consecutive weeks: `healOrphanedChallenges` closes any challenge whose own
// week is over, so an entry filed into the LIVE week while answering an older challenge went inert
// on the board AND was refused by the server, and `closeCycle`'s "a winner needs ≥1 vote" guard
// could never be satisfied. Prod's whole 2026-W33 board was one such row.
//
// So the decisive case below is the one the old fixture could not express: `challengeStatus:
// 'closed'` together with `cycleClosed: false` must render a LIVE pill.
//
// `$lib/solutions/solution-state.test.ts` proves the decision table. THIS proves the board is wired
// to it — delete `blockedReason` from the VoteButton and the blocked tests red.
//
// EVERY FIXTURE BELOW SETS `status: 'voting'` ON THE SOLUTION. That is the point: the only thing
// that varies between the blocked and live cases is `cycleClosed`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeStatus } from '$lib/types/challenges';
import type { SolutionList, SolutionRow } from '$lib/types/solutions';

// Real `en` catalog, each key resolving to its own name — see the sibling reachable.render test.
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
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

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

function challengeChoices() {
	return {
		items: [{ id: CH_ID, code: 'CH-1', title: 'Challenge 1', submitter: { name: 'S', initials: 'S' } }],
		total: 1,
		page: 1,
		pageSize: 10,
		counts: { all: 1 },
		sort: 'top'
	};
}

/**
 * A solution row. `status` is ALWAYS 'voting' — `cycleClosed` is the variable that decides the pill,
 * and `challengeStatus` is carried INDEPENDENTLY so the tests can set the two in opposition. That
 * opposition is the whole subject of this file: they are facts about two different weeks.
 */
function row(
	rank: number,
	cycleClosed: boolean | null,
	challengeStatus: ChallengeStatus | null = 'closed'
): SolutionRow {
	return {
		id: `sol-${rank}`,
		rank,
		title: `Entry ${rank}`,
		status: 'voting',
		challengeId: CH_ID,
		challengeStatus,
		// `as never` only for the deliberate mid-roll case (`null`/omitted): the DTO types this as a
		// real boolean, and the point of the test is what the page does when the wire disagrees.
		cycleClosed: cycleClosed as never,
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
	};
}

/**
 * ⛔ `challenge` IS `{id, code, title}` AND NOTHING MORE — no `status`, no `week`. The backend
 * populates it from a three-column select (`routes/solutions.ts`), and it is only present at all
 * when the board is scoped by `?challenge_id=`. An earlier version of this fixture invented
 * `status`/`week` on it and the `as unknown as` cast swallowed the lie, so a page later wired to
 * `list.challenge.status` would have gone green here and rendered `undefined` in prod. The parent's
 * status reaches the browser PER ROW (`challengeStatus`), which is the only place it exists.
 *
 * Typed WITHOUT a cast for exactly that reason: `SolutionList` is the contract, and the compiler is
 * the cheapest reviewer of it.
 */
function board(cycleClosed: boolean | null, challengeStatus: ChallengeStatus | null = 'closed'): SolutionList {
	return {
		items: [row(1, cycleClosed, challengeStatus), row(2, cycleClosed, challengeStatus)],
		total: 2,
		page: 1,
		pageSize: 10,
		challenge: { id: CH_ID, code: 'CH-1', title: 'Challenge 1' }
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function renderBoard(cycleClosed: boolean | null, challengeStatus: ChallengeStatus | null = 'closed') {
	listChallenges.mockResolvedValue(challengeChoices());
	listSolutions.mockResolvedValue(board(cycleClosed, challengeStatus));
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	const pills = [...target.querySelectorAll('button.vote')] as HTMLButtonElement[];
	expect(pills.length, 'the board rendered no vote pills, so this file tests nothing').toBe(2);
	return pills;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	listSolutions.mockReset();
	listChallenges.mockReset();
});

describe('the vote pill on the solution board', () => {
	it('⛔ a CLOSED PARENT with a LIVE CYCLE renders a LIVE pill — the row that broke nine weeks', async () => {
		// THE DECISIVE CASE. This is prod's 2026-W33 entry: filed into the running week, answering a
		// 2026-W23 challenge that `healOrphanedChallenges` correctly closed hours later. The previous
		// revision of this file asserted the exact opposite (inert), because the server gated on the
		// parent — and an inert pill on the only entry in the open week is precisely how the tenth
		// consecutive winnerless week was guaranteed.
		const pills = await renderBoard(false, 'closed');
		for (const pill of pills) {
			expect(pill.disabled).toBe(false);
			expect(pill.className).not.toContain('blocked');
		}
		expect(target.querySelector('.vote-wrap')?.getAttribute('title')).toBeNull();
	});

	it('⛔ a CLOSED CYCLE makes every pill inert, though each solution still says `voting`', async () => {
		// `closeCycle` flips only the WINNER to 'shipping' and leaves every loser at 'voting' forever,
		// so the row's own status column can never carry this. The parent is left OPEN here to prove
		// it is not what is being read.
		const pills = await renderBoard(true, 'voting');
		for (const pill of pills) {
			expect(pill.disabled).toBe(true);
			expect(pill.className).toContain('blocked');
		}
		// And the reason names the WEEK. `solution_vote_note_parent_closed` is retired: it named the
		// challenge, which no longer decides this, and `_detail_vote_note_closed` would claim the
		// solution's own row closed, which is false.
		const titles = [...target.querySelectorAll('.vote-wrap')].map((w) => w.getAttribute('title'));
		expect(titles).toEqual(['solution_vote_note_cycle_closed', 'solution_vote_note_cycle_closed']);
	});

	it('the parent’s status alone moves NOTHING — both directions, same cycleClosed', async () => {
		// The strongest form of "it is not reading challengeStatus": hold the gate fixed and sweep
		// the parent across every status it can have.
		for (const parent of ['voting', 'solution_phase', 'closed', null] as const) {
			const pills = await renderBoard(false, parent);
			for (const pill of pills) {
				expect(pill.disabled, `parent=${String(parent)} must not block a live cycle`).toBe(false);
				expect(pill.className).not.toContain('blocked');
			}
			// RESTORED (it was dropped when this file was rebuilt around `cycleClosed`): the wrapper
			// carries no `title` either. `blockedReason` is what puts one there, so a pill that is
			// enabled while the wrapper still explains why it is not would mean the two halves of the
			// blocked state had come apart — and it still means exactly that in the new fixture, where
			// a live gate must leave every parent status unexplained.
			expect(
				target.querySelector('.vote-wrap')?.getAttribute('title'),
				`parent=${String(parent)} must leave the pill unexplained, because it is live`
			).toBeNull();
			if (component) unmount(component);
			component = null;
			target.innerHTML = '';
			listSolutions.mockReset();
			listChallenges.mockReset();
		}
	});

	it('⛔ a MISSING cycleClosed ALSO makes the pills inert — we did not read the gate', async () => {
		// `null` is the mid-roll shape: an older server answering without the field. The gate lives
		// in `marketplace_cycles` and no client query reaches it, so the page cannot fill the blank.
		// A live pill on an unverified row is the worst of the three outcomes.
		const pills = await renderBoard(null, 'voting');
		for (const pill of pills) {
			expect(pill.disabled).toBe(true);
			expect(pill.className).toContain('blocked');
		}
		// …and it says COULD NOT TELL, not "closed". Different facts.
		const title = target.querySelector('.vote-wrap')?.getAttribute('title');
		expect(title).toBe('solution_vote_note_votability_unknown');
		expect(title).not.toBe('solution_vote_note_cycle_closed');
	});

	it('renders no invented deadline anywhere on the board', async () => {
		await renderBoard(false, 'voting');
		expect(target.textContent).not.toContain('18:00');
		expect(target.textContent).not.toContain('undefined');
		expect(target.textContent).not.toContain('NaN');
	});
});
