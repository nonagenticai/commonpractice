// src/lib/solutions/solution-state.test.ts — a solution's vote control tells the truth about a
// fact only the SERVER can compute.
//
// ⛔ THE DEFECT THIS FILE WAS REWRITTEN FOR — nine winnerless weeks. This module used to take the
// PARENT CHALLENGE's status and treat `'closed'` as "voting closed", because that is what
// `host/vote-service.ts` gated on. The parent is a different row in a different week:
// `healOrphanedChallenges` closes any challenge whose own week is over, so an entry filed into the
// LIVE week while answering an older challenge was reported unvotable within hours of being
// submitted — and was in fact refused by the server, which is why `closeCycle`'s "a winner needs
// ≥1 vote" guard could never be met. Prod's entire 2026-W33 board was one such row.
//
// The gate is now `cycleClosed` off the wire: has the cycle THIS SOLUTION COMPETES IN closed? The
// browser cannot derive it (it lives in `marketplace_cycles`), so this module's whole job is to
// carry it faithfully and to refuse to guess when it is absent.
//
// The messages module is mocked so each key returns its own name plus params: assertions name the
// message CHOSEN, not English copy a translator may reword.
import { describe, it, expect, vi } from 'vitest';
import type { CycleState } from '$lib/types/cycle';

vi.mock('$lib/paraglide/messages', () => {
	const tag =
		(name: string) =>
		(params?: Record<string, unknown>): string =>
			params && Object.keys(params).length ? `${name}:${Object.values(params).join(',')}` : name;
	return {
		solution_detail_status_shipping: tag('STATUS_SHIPPING'),
		solution_detail_status_voting: tag('STATUS_VOTING'),
		solution_state_voting_closed: tag('STATE_VOTING_CLOSED'),
		solution_state_voting_countdown: tag('STATE_COUNTDOWN'),
		solution_detail_vote_note_shipping: tag('NOTE_SHIPPING'),
		solution_detail_vote_note_ranking: tag('NOTE_RANKING'),
		solution_vote_note_cycle_closed: tag('NOTE_CYCLE_CLOSED'),
		solution_vote_note_votability_unknown: tag('NOTE_VOTABILITY_UNKNOWN'),
		solution_vote_note_countdown: tag('NOTE_COUNTDOWN')
	};
});

const { solutionState, solutionStatusLabel, solutionVoteNote, solutionVoteBlockedReason } =
	await import('./solution-state');

const NOW = new Date('2026-06-08T09:00:00.000Z'); // Monday of 2026-W24

function cycle(over: Partial<CycleState> = {}): CycleState {
	return {
		week: '2026-W24',
		phase: 'voting',
		votingEndsAt: '2026-06-09T16:00:00.000Z',
		solutionEndsAt: '2026-06-11T16:00:00.000Z',
		closesAt: '2026-06-12T18:00:00.000Z',
		closedAt: null,
		...over
	};
}

describe('solutionState — the solution’s OWN cycle decides', () => {
	it('⛔ cycleClosed:false leaves the pill LIVE — this is the row that broke nine weeks', () => {
		// Prod's 2026-W33 entry: a live cycle, and a parent challenge closed months earlier. Under
		// the old parent-challenge rule this rendered inert and the week could not be won.
		const state = solutionState('voting', '2026-W24', false, null, NOW);
		expect(state.votability).toBe('open');
		expect(solutionVoteBlockedReason(state)).toBeNull();
	});

	it('⛔ cycleClosed:true BLOCKS, even though the solution’s own status still says voting', () => {
		// `closeCycle` flips only the WINNER to 'shipping' and leaves every loser at 'voting'
		// forever, so the row's own column can never carry this.
		const state = solutionState('voting', '2026-W24', true, cycle(), NOW);
		expect(state.kind).toBe('voting_closed');
		expect(state.votability).toBe('cycle_closed');
		expect(solutionVoteBlockedReason(state)).toBe('NOTE_CYCLE_CLOSED');
		expect(solutionStatusLabel(state)).toBe('STATE_VOTING_CLOSED');
	});

	it('⛔ the reason names the WEEK, never the solution and never the parent challenge', () => {
		// "This solution is closed" would be false — its own row is untouched by the close. "The
		// challenge behind it closed" would ALSO be false now: the parent stopped deciding this.
		const state = solutionState('voting', '2026-W24', true, null, NOW);
		expect(solutionVoteBlockedReason(state)).toBe('NOTE_CYCLE_CLOSED');
		expect(solutionVoteNote(state)).toBe('NOTE_CYCLE_CLOSED');
	});

	it('exactly one votability leaves the pill live, and it is the boolean off the wire', () => {
		expect(solutionVoteBlockedReason(solutionState('voting', '2026-W24', false, null, NOW))).toBeNull();
		// Exhaustive the other way: every non-open votability blocks.
		for (const closed of [true, null, undefined] as const) {
			const state = solutionState('voting', '2026-W24', closed as never, null, NOW);
			expect(solutionVoteBlockedReason(state), `cycleClosed=${String(closed)}`).not.toBeNull();
		}
	});

	it('⛔ solution.status is NEVER the signal — the same row flips on cycleClosed alone', () => {
		const blocked = solutionState('voting', '2026-W24', true, cycle(), NOW);
		const live = solutionState('voting', '2026-W24', false, cycle(), NOW);
		expect(solutionVoteBlockedReason(blocked)).not.toBeNull();
		expect(solutionVoteBlockedReason(live)).toBeNull();
	});
});

describe('solutionState — a MISSING gate is not an open one', () => {
	// ⛔ THE WORST OF THE THREE OUTCOMES IS A CONFIDENTLY LIVE PILL ON A ROW NOBODY VERIFIED. The
	// only producer of a missing `cycleClosed` is a mid-roll (an older server, a partial fixture, a
	// hand-built object). The browser cannot compute the gate itself — it lives in
	// `marketplace_cycles` — so it says so instead of guessing.
	it('⛔ null BLOCKS the vote, with a reason that claims only what is true', () => {
		const state = solutionState('voting', '2026-W24', null, cycle(), NOW);
		expect(state.votability).toBe('unknown');
		expect(state.kind).toBe('votability_unknown');
		expect(solutionVoteBlockedReason(state)).toBe('NOTE_VOTABILITY_UNKNOWN');
	});

	it('⛔ an OMITTED cycleClosed is unknown too, not open — the `== null` is loose on purpose', () => {
		// A payload that leaves the field out yields `undefined`; a strict `=== null` let it fall
		// through to 'open' and rendered a live pill on an unverified row, silently.
		const omitted = solutionState('voting', '2026-W24', undefined as never, cycle(), NOW);
		expect(omitted.votability).toBe('unknown');
		expect(solutionVoteBlockedReason(omitted)).toBe('NOTE_VOTABILITY_UNKNOWN');
	});

	it('⛔ says COULD NOT TELL, never "closed" — they are different facts', () => {
		const unknown = solutionState('voting', '2026-W24', null, cycle(), NOW);
		const closed = solutionState('voting', '2026-W24', true, cycle(), NOW);
		expect(solutionVoteBlockedReason(unknown)).toBe('NOTE_VOTABILITY_UNKNOWN');
		expect(solutionVoteBlockedReason(closed)).toBe('NOTE_CYCLE_CLOSED');
		expect(solutionVoteBlockedReason(unknown)).not.toBe(solutionVoteBlockedReason(closed));
	});

	it('quotes no deadline and promises nothing about voting being open', () => {
		const state = solutionState('voting', '2026-W24', null, cycle(), NOW);
		expect(solutionVoteNote(state)).toBe('NOTE_VOTABILITY_UNKNOWN');
		expect(solutionStatusLabel(state)).not.toContain('COUNTDOWN');
	});

	it('prints no undefined and no NaN on any string', () => {
		const state = solutionState('voting', '', null, null, NOW);
		for (const word of [solutionStatusLabel(state), solutionVoteNote(state), solutionVoteBlockedReason(state) ?? '']) {
			expect(word).not.toContain('undefined');
			expect(word).not.toContain('NaN');
		}
	});
});

describe('solutionState — the countdown', () => {
	it('counts down to the cycle’s closesAt, not votingEndsAt', () => {
		// closesAt Fri 18:00Z − Mon 09:00Z = 105h → 4d. votingEndsAt would have given 1d.
		const state = solutionState('voting', '2026-W24', false, cycle(), NOW);
		expect(state.kind).toBe('counting_down');
		expect(state.kind === 'counting_down' && state.deadline).toBe('2026-06-12T18:00:00.000Z');
		expect(solutionStatusLabel(state)).toBe('STATE_COUNTDOWN:4d');
		expect(solutionVoteNote(state)).toBe('NOTE_COUNTDOWN:4d');
	});

	it('⛔ with NO CYCLE it degrades to the plain status — no invented deadline', () => {
		// The old catalog said "Voting closes Thursday 18:00." unconditionally. This is that branch.
		const state = solutionState('voting', '2026-W24', false, null, NOW);
		expect(state.kind).toBe('plain');
		expect(solutionStatusLabel(state)).toBe('STATUS_VOTING');
		expect(solutionVoteNote(state)).toBe('NOTE_RANKING');
	});

	it('quotes nothing when the solution competes in a different week from the live cycle', () => {
		// ⚠️ `solution.week` is `laterWeek(creationWeek, challenge.week)` — the week THIS ROW is
		// judged in. Not the running week ⇒ no boundary of ours in the cycle row to point at. A
		// FUTURE week is included deliberately: it is legitimate and still votable, it just has no
		// cycle row to quote yet.
		for (const week of ['2026-W21', '2026-W30', '']) {
			const state = solutionState('voting', week, false, cycle(), NOW);
			expect(state.kind).toBe('plain');
			expect(solutionVoteBlockedReason(state), `week=${week} must stay votable`).toBeNull();
		}
	});

	it('never counts down past a boundary that has already gone', () => {
		const state = solutionState('voting', '2026-W24', false, cycle(), new Date('2026-06-13T09:00:00.000Z'));
		expect(state.kind).toBe('plain');
		expect(solutionStatusLabel(state)).toBe('STATUS_VOTING');
	});

	it('degrades instead of printing NaN on an unparseable closesAt', () => {
		const state = solutionState('voting', '2026-W24', false, cycle({ closesAt: 'not-a-date' }), NOW);
		expect(state.kind).toBe('plain');
		expect(solutionStatusLabel(state)).not.toContain('NaN');
	});
});

describe('solutionState — the winner', () => {
	it('shipping outranks everything, including the closed cycle it always has', () => {
		const state = solutionState('shipping', '2026-W23', true, cycle(), NOW);
		expect(state.kind).toBe('shipping');
		expect(solutionStatusLabel(state)).toBe('STATUS_SHIPPING');
		expect(solutionVoteNote(state)).toBe('NOTE_SHIPPING');
	});

	it('but a shipping solution still reports its closed cycle as the vote blocker', () => {
		// The note says "won and is shipping"; the pill must still be inert, because the server
		// refuses on the week regardless of how this row got here.
		const state = solutionState('shipping', '2026-W23', true, cycle(), NOW);
		expect(solutionVoteBlockedReason(state)).toBe('NOTE_CYCLE_CLOSED');
	});
});
