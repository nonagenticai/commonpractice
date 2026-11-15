// @vitest-environment jsdom
//
// src/lib/components/marketplace/leaderboard-row.vote-control.render.test.ts — what a leaderboard
// row actually PUTS ON SCREEN. `$lib/challenges/challenge-state.test.ts` proves the decision table;
// this proves the row is wired to it.
//
// TWO DEFECTS ARE PINNED HERE:
//
//  1. ⛔ THE VOTE PILL IGNORED STATUS ENTIRELY. `VoteButton` was rendered with no predicate at all,
//     including on CLOSED challenges — where `POST /api/challenges/:id/vote` answers
//     `409 voting_closed` (backend/src/host/vote-service.ts). So the pill invited a click, bumped
//     the count optimistically, and snapped back under a red banner. A companion workstream is
//     closing every legacy challenge, so this is about to be MOST of the board, not an edge case.
//
//  2. THE WEEK WAS FETCHED AND THROWN AWAY. `week` has been on the wire since
//     backend/src/routes/challenges.ts:216 and typed since $lib/types/challenges.ts:39, and no
//     challenge screen rendered it — which is exactly why "closes Thu 18:00" could sit unnoticed on
//     a `2026-W23` row for seven weeks.
//
// ⚠️ These are DOM assertions about AFFORDANCES. The server-side guarantee is separate and is what
// actually holds: the 409 is refused whatever this component renders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeRow } from '$lib/types/challenges';
import type { CycleState } from '$lib/types/cycle';

// Message stub: every key resolves to its own name (plus its params), so an assertion names the
// exact message the row CHOSE rather than a translation that may later be reworded — and a
// resurrected hardcoded deadline cannot pass. Built from the REAL `en` catalog rather than a
// hand-listed subset (the technique of routes/connectors/sync-outcome.render.test.ts): the row
// reaches `timeAgo`, which pulls in the whole `timeago_*` family, and a hand-listed mock turns
// "someone touched an unrelated helper" into a failure here. It also means a key this row invents
// but never adds to the catalogs fails as `undefined is not a function`.
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

import LeaderboardRow from './LeaderboardRow.svelte';

function makeRow(over: Partial<ChallengeRow> = {}): ChallengeRow {
	return {
		id: 'ch-1',
		code: 'CH-101',
		title: 'Claims intake takes four days',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W23',
		tags: [],
		votesCount: 42,
		rank: 1,
		hasVoted: false,
		solutionsCount: 0,
		submitter: { name: 'Ada Author', initials: 'AA' },
		createdAt: '2026-06-01T09:00:00.000Z',
		...over
	};
}

const LIVE_CYCLE: CycleState = {
	week: '2026-W24',
	phase: 'voting',
	votingEndsAt: '2099-06-11T16:00:00.000Z',
	solutionEndsAt: '2099-06-12T16:00:00.000Z',
	closesAt: '2099-06-12T18:00:00.000Z',
	closedAt: null
};

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

function render(row: ChallengeRow, cycle: CycleState | null) {
	component = mount(LeaderboardRow, {
		target,
		props: { row, cycle, onVote: () => {} }
	}) as Record<string, unknown>;
	flushSync();
	return target.querySelector('button.vote') as HTMLButtonElement;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
});

describe('the vote pill on a leaderboard row', () => {
	it('⛔ a CLOSED challenge renders an INERT pill carrying its reason', () => {
		const button = render(makeRow({ status: 'closed' }), LIVE_CYCLE);
		expect(button.disabled).toBe(true);
		expect(button.className).toContain('blocked');
		// The reason rides on the wrapper, not the button: a disabled button fires no pointer events,
		// so a `title` on it would never surface.
		expect(target.querySelector('.vote-wrap')?.getAttribute('title')).toBe('challenge_detail_vote_note_closed');
		// …and the same fact is on screen beside it, which is what a keyboard user actually gets.
		expect(target.querySelector('.badge')?.textContent).toBe('mkt_status_closed');
	});

	it('an OPEN challenge in the live week keeps a live pill', () => {
		const button = render(makeRow({ week: '2026-W24' }), LIVE_CYCLE);
		expect(button.disabled).toBe(false);
		expect(button.className).not.toContain('blocked');
		expect(target.querySelector('.vote-wrap')?.getAttribute('title')).toBeNull();
	});

	it('⛔ a PAST-WEEK challenge that is still open keeps its pill live', () => {
		// `host/vote-service.ts` refuses on `status === 'closed'` and on nothing else. Disabling here
		// would swap one lie for another: a control refused by a rule the server does not have.
		const button = render(makeRow({ status: 'voting', week: '2026-W21' }), LIVE_CYCLE);
		expect(button.disabled).toBe(false);
		expect(target.querySelector('.badge')?.textContent).toBe('challenge_state_earlier_week');
	});
});

describe('the week on a leaderboard row', () => {
	it('names the challenge’s own ISO week', () => {
		render(makeRow({ week: '2026-W23' }), LIVE_CYCLE);
		expect(target.querySelector('.week')?.textContent).toBe('challenge_period_week:23,2026');
	});

	it('⛔ with NO CYCLE — what prod returns today — it still shows the week and claims no deadline', () => {
		render(makeRow({ status: 'voting', week: '2026-W23' }), null);
		expect(target.querySelector('.week')?.textContent).toBe('challenge_period_week:23,2026');
		expect(target.querySelector('.badge')?.textContent).toBe('mkt_status_voting');
		expect(target.textContent).not.toContain('countdown');
		expect(target.textContent).not.toContain('undefined');
		expect(target.textContent).not.toContain('NaN');
	});

	it('counts down off the cycle row in the live week, never off a hardcoded weekday', () => {
		render(makeRow({ status: 'voting', week: '2026-W24' }), LIVE_CYCLE);
		expect(target.querySelector('.badge')?.textContent).toContain('challenge_state_voting_countdown:');
	});

	it('renders no week chip at all when the wire value is unusable', () => {
		render(makeRow({ week: '' }), LIVE_CYCLE);
		expect(target.querySelector('.week')).toBeNull();
	});
});
