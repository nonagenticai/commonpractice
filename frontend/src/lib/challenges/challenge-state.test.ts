// src/lib/challenges/challenge-state.test.ts — the challenge board is not allowed to invent a
// deadline.
//
// Three branches carry the whole point of the module and each gets its own block below:
//
//  • NO CYCLE — what prod runs TODAY. `/api/cycle/current` returns null whenever no
//    `marketplace_cycles` row exists for the current ISO week, and the old code still printed
//    "closes Thu 18:00" on top of that nothing. Nothing here may produce a time, `undefined` or
//    `NaN`.
//  • A PAST WEEK — prod's challenges are stamped `2026-W21`/`W23`/`W24`. Seven weeks later the
//    detail page was still promising a Thursday. It must say the week is finished and name it.
//  • THE RUNNING WEEK — the only branch entitled to a countdown, and only from the cycle row's own
//    `votingEndsAt` / `solutionEndsAt`.
//
// The messages module is mocked so each key returns its own name plus its params: the assertions
// are about WHICH message and WHICH numbers were chosen, never about English copy a translator may
// legitimately reword. (Same technique as $lib/i18n/stage-label.test.ts.)
import { describe, it, expect, vi } from 'vitest';
import type { CycleState } from '$lib/types/cycle';

vi.mock('$lib/paraglide/messages', () => {
	const tag =
		(name: string) =>
		(params?: Record<string, unknown>): string =>
			params && Object.keys(params).length ? `${name}:${Object.values(params).join(',')}` : name;
	return {
		mkt_status_voting: tag('STATUS_VOTING'),
		mkt_status_solution_phase: tag('STATUS_SOLUTION'),
		mkt_status_closed: tag('STATUS_CLOSED'),
		challenge_state_earlier_week: tag('CYCLE_ENDED'),
		challenge_state_voting_countdown: tag('VOTING_COUNTDOWN'),
		challenge_state_solution_countdown: tag('SOLUTION_COUNTDOWN'),
		challenge_period_week: tag('WEEK_BADGE'),
		challenge_period_quarter: tag('QUARTER_BADGE'),
		challenge_vote_note_earlier_period: tag('NOTE_PAST_CYCLE'),
		challenge_vote_note_countdown: tag('NOTE_COUNTDOWN'),
		challenge_detail_vote_note_open: tag('NOTE_OPEN'),
		challenge_detail_vote_note_closed: tag('NOTE_CLOSED'),
		challenge_build_blocked_period: tag('BUILD_BLOCKED_WEEK'),
		challenge_build_blocked: tag('BUILD_BLOCKED')
	};
});

const {
	challengeState,
	challengeStatusLabel,
	challengeWeekLabel,
	challengeVoteNote,
	voteBlockedReason,
	buildBlockedReason,
	parseIsoWeek,
	parsePeriod,
	periodName,
	periodKeyName
} = await import('./challenge-state');

// ⛔ The Results hero and the pipeline card printed the raw key — "Common Practice · 2026-W21",
// "won W21" (KanbanCard stripped a hard-coded '2026-' prefix, which broke in 2027 and for every
// month/quarter/year key). Both now pass `periodKeyName(key)`.
describe('periodKeyName — a raw period key as words', () => {
	it('names every kind and never returns the raw week code', () => {
		expect(periodKeyName('2026-W21')).toBe('WEEK_BADGE:21,2026');
		expect(periodKeyName('2027-W03')).toBe('WEEK_BADGE:3,2027');
		expect(periodKeyName('2026-10', 'en')).toBe('October 2026');
		expect(periodKeyName('2026-Q4')).toBe('QUARTER_BADGE:4,2026');
		expect(periodKeyName('2026')).toBe('2026');
	});
	it('keeps an unparseable key visible rather than dropping it', () => {
		expect(periodKeyName('legacy')).toBe('legacy');
	});
	it('the Results hero and the pipeline card both pass the key through it', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const winner = readFileSync(resolve(process.cwd(), 'src/routes/winner/+page.svelte'), 'utf8');
		const card = readFileSync(resolve(process.cwd(), 'src/lib/components/ops/KanbanCard.svelte'), 'utf8');
		expect(winner.length).toBeGreaterThan(0);
		expect(card.length).toBeGreaterThan(0);
		expect(winner).toContain('m.winner_hero_eyebrow({ week: periodKeyName(data.week) })');
		expect(card).toContain('m.ops_kancard_won({ week: periodKeyName(card.week) })');
	});
});

const NOW = new Date('2026-06-08T09:00:00.000Z'); // Monday of 2026-W24

/** A live cycle row for `2026-W24`, shaped exactly like `cycleDto` in backend/src/routes/cycle.ts. */
function cycle(over: Partial<CycleState> = {}): CycleState {
	return {
		week: '2026-W24',
		phase: 'voting',
		votingEndsAt: '2026-06-11T16:00:00.000Z',
		solutionEndsAt: '2026-06-12T16:00:00.000Z',
		closesAt: '2026-06-12T18:00:00.000Z',
		closedAt: null,
		...over
	};
}

/** Every string the module can emit, for the "no invented time" sweep. */
function allWords(state: ReturnType<typeof challengeState>): string[] {
	return [
		challengeStatusLabel(state),
		challengeWeekLabel(state) ?? '',
		challengeVoteNote(state),
		voteBlockedReason(state) ?? ''
	];
}

describe('challengeState — no cycle (the branch prod is executing)', () => {
	it('a voting challenge degrades to the plain status: no deadline, no countdown', () => {
		const state = challengeState({ status: 'voting', week: '2026-W24' }, null, NOW);
		expect(state.kind).toBe('plain');
		expect(challengeStatusLabel(state)).toBe('STATUS_VOTING');
		// The old catalog entry was "In voting · closes Thu 18:00". Nothing may take its place.
		expect(challengeVoteNote(state)).toBe('NOTE_OPEN');
	});

	it('a solution-phase challenge degrades the same way', () => {
		const state = challengeState({ status: 'solution_phase', week: '2026-W24' }, null, NOW);
		expect(state.kind).toBe('plain');
		expect(challengeStatusLabel(state)).toBe('STATUS_SOLUTION');
	});

	it('⛔ prints no undefined and no NaN anywhere, and never a countdown token', () => {
		for (const status of ['voting', 'solution_phase', 'closed'] as const) {
			const state = challengeState({ status, week: '2026-W24' }, null, NOW);
			for (const word of allWords(state)) {
				expect(word).not.toContain('undefined');
				expect(word).not.toContain('NaN');
				expect(word).not.toContain('COUNTDOWN');
			}
		}
	});

	it('still names the challenge’s own week — the week does not need a cycle to be a fact', () => {
		const state = challengeState({ status: 'voting', week: '2026-W23' }, null, NOW);
		expect(challengeWeekLabel(state)).toBe('WEEK_BADGE:23,2026');
	});

	it('a missing or malformed week yields no week label rather than "Week undefined"', () => {
		for (const week of ['', 'W24', '2026-24', 'next week']) {
			const state = challengeState({ status: 'voting', week }, null, NOW);
			expect(state.period).toBeNull();
			expect(challengeWeekLabel(state)).toBeNull();
		}
	});
});

describe('challengeState — a week behind the live cycle', () => {
	it('says the week is finished and names it, instead of promising a Thursday', () => {
		// prod's real data: a W23 challenge still stamped `voting`, seven weeks after its cycle ran.
		const state = challengeState({ status: 'voting', week: '2026-W23' }, cycle(), NOW);
		expect(state.kind).toBe('past_cycle');
		expect(challengeStatusLabel(state)).toBe('CYCLE_ENDED');
		expect(challengeWeekLabel(state)).toBe('WEEK_BADGE:23,2026');
		expect(challengeVoteNote(state)).toBe('NOTE_PAST_CYCLE:WEEK_BADGE:23,2026');
	});

	it('crosses a year boundary correctly — 2026-W52 is behind 2027-W01', () => {
		const state = challengeState(
			{ status: 'voting', week: '2026-W52' },
			cycle({ week: '2027-W01' }),
			NOW
		);
		expect(state.kind).toBe('past_cycle');
		expect(challengeWeekLabel(state)).toBe('WEEK_BADGE:52,2026');
	});

	it('emits no countdown token on any of its strings', () => {
		const state = challengeState({ status: 'solution_phase', week: '2026-W21' }, cycle(), NOW);
		expect(state.kind).toBe('past_cycle');
		for (const word of allWords(state)) expect(word).not.toContain('COUNTDOWN');
	});

	it('⛔ leaves voting ENABLED — the server accepts it, so the pill must not lie the other way', () => {
		// `host/vote-service.ts` refuses on `status === 'closed'` and on nothing else. A stale week
		// is a fact about the cycle, not a rule the backend enforces.
		const state = challengeState({ status: 'voting', week: '2026-W23' }, cycle(), NOW);
		expect(state.canVote).toBe(true);
		expect(voteBlockedReason(state)).toBeNull();
	});

	it('a week AHEAD of the cycle claims nothing at all', () => {
		const state = challengeState({ status: 'voting', week: '2026-W30' }, cycle(), NOW);
		expect(state.kind).toBe('plain');
		expect(challengeStatusLabel(state)).toBe('STATUS_VOTING');
	});
});

describe('challengeState — the running week', () => {
	it('counts down to the cycle row’s own votingEndsAt, in days', () => {
		// NOW is Mon 09:00Z, votingEndsAt is Thu 16:00Z → 79h → 3d.
		const state = challengeState({ status: 'voting', week: '2026-W24' }, cycle(), NOW);
		expect(state.kind).toBe('counting_down');
		expect(state.kind === 'counting_down' && state.deadline).toBe('2026-06-11T16:00:00.000Z');
		expect(challengeStatusLabel(state)).toBe('VOTING_COUNTDOWN:3d');
		expect(challengeVoteNote(state)).toBe('NOTE_COUNTDOWN:3d');
	});

	it('switches to hours inside the last day', () => {
		const state = challengeState(
			{ status: 'voting', week: '2026-W24' },
			cycle(),
			new Date('2026-06-11T11:30:00.000Z') // 4.5h before votingEndsAt
		);
		expect(challengeStatusLabel(state)).toBe('VOTING_COUNTDOWN:4h');
	});

	it('never rounds a live boundary down to "0h"', () => {
		const state = challengeState(
			{ status: 'voting', week: '2026-W24' },
			cycle(),
			new Date('2026-06-11T15:59:00.000Z') // one minute left
		);
		expect(challengeStatusLabel(state)).toBe('VOTING_COUNTDOWN:1h');
	});

	it('a solution-phase challenge counts down to solutionEndsAt, not votingEndsAt', () => {
		const state = challengeState(
			{ status: 'solution_phase', week: '2026-W24' },
			cycle({ phase: 'solution_phase' }),
			NOW
		);
		expect(state.kind === 'counting_down' && state.deadline).toBe('2026-06-12T16:00:00.000Z');
		expect(challengeStatusLabel(state)).toBe('SOLUTION_COUNTDOWN:4d');
	});

	it('⛔ but does NOT reuse that phase countdown as a voting deadline', () => {
		// Challenge voting stays open through the solution phase — `solutionEndsAt` is when the
		// phase ends, not when this reader can no longer vote.
		const state = challengeState(
			{ status: 'solution_phase', week: '2026-W24' },
			cycle({ phase: 'solution_phase' }),
			NOW
		);
		expect(challengeVoteNote(state)).toBe('NOTE_OPEN');
	});

	it('a boundary already behind us falls back to the plain status, never a negative countdown', () => {
		// A row still stamped `voting` after the cycle moved on: votingEndsAt is in the past.
		const state = challengeState(
			{ status: 'voting', week: '2026-W24' },
			cycle({ phase: 'solution_phase' }),
			new Date('2026-06-12T09:00:00.000Z')
		);
		expect(state.kind).toBe('plain');
		expect(challengeStatusLabel(state)).toBe('STATUS_VOTING');
	});

	it('an unparseable votingEndsAt degrades instead of printing NaN', () => {
		const state = challengeState(
			{ status: 'voting', week: '2026-W24' },
			cycle({ votingEndsAt: 'not-a-date' }),
			NOW
		);
		expect(state.kind).toBe('plain');
		for (const word of allWords(state)) expect(word).not.toContain('NaN');
	});
});

describe('challengeState — the vote predicate', () => {
	it('a closed challenge blocks the vote with a reason, in every cycle situation', () => {
		for (const c of [null, cycle(), cycle({ week: '2026-W30' })]) {
			const state = challengeState({ status: 'closed', week: '2026-W23' }, c, NOW);
			expect(state.kind).toBe('closed');
			expect(state.canVote).toBe(false);
			expect(voteBlockedReason(state)).toBe('NOTE_CLOSED');
			expect(challengeStatusLabel(state)).toBe('STATUS_CLOSED');
			// Closed outranks the clock: no countdown even in the running week.
			expect(challengeStatusLabel(state)).not.toContain('COUNTDOWN');
		}
	});

	it('mirrors host/vote-service.ts exactly — only `closed` blocks', () => {
		expect(challengeState({ status: 'voting', week: '2026-W24' }, cycle(), NOW).canVote).toBe(true);
		expect(
			challengeState({ status: 'solution_phase', week: '2026-W24' }, cycle(), NOW).canVote
		).toBe(true);
		expect(challengeState({ status: 'closed', week: '2026-W24' }, cycle(), NOW).canVote).toBe(false);
	});
});

// ---- submittable: may a NEW SOLUTION still be filed against this challenge? --------------------
//
// ⛔ THE DEFECT THIS TABLE IS ABOUT, MEASURED IN A BROWSER. A `2026-W21` challenge rendered a muted
// "Voting week finished" badge, a sidebar note reading "…week 21 of 2026, which is already
// finished", AND a live "Build a solution" link — all three in one viewport. The link 201'd: the
// solution was stamped with the CURRENT week and competed in a live cycle under a May parent. Nine
// consecutive cycles crowned nobody.
//
// The gate is `canVote`'s SIBLING and not a widening of it: the server refuses a VOTE on
// `status === 'closed'` alone, and a SUBMISSION on `challengeClosedSql` (status OR the challenge's
// own week being over). Two server predicates, two fields.
//
// The table below is the full cross product of (status × cycleClosed × cycle present/absent), with
// the challenge's own week varied because it is the fallback's only input.
describe('challengeState — submittable (the submit gate, NOT the vote gate)', () => {
	const PAST = '2026-W21'; // the week of the row measured in prod
	const LIVE = '2026-W24'; // the running cycle's week

	interface Case {
		status: 'voting' | 'solution_phase' | 'closed';
		week: string;
		cycleClosed?: boolean;
		liveCycle: boolean;
		expected: boolean;
		why: string;
	}

	const CASES: Case[] = [
		// ── the wire ANSWERS, and it outranks everything except an authoritative close ────────────
		{ status: 'voting', week: PAST, cycleClosed: true, liveCycle: true, expected: false, why: 'THE MEASURED DEFECT: a W21 row whose server says the cycle is over' },
		{ status: 'voting', week: PAST, cycleClosed: true, liveCycle: false, expected: false, why: 'the wire needs no cycle row to be believed' },
		{ status: 'solution_phase', week: PAST, cycleClosed: true, liveCycle: true, expected: false, why: 'the solution phase of a dead week is still dead' },
		{ status: 'voting', week: LIVE, cycleClosed: false, liveCycle: true, expected: true, why: 'the live week, server says open' },
		{ status: 'solution_phase', week: LIVE, cycleClosed: false, liveCycle: true, expected: true, why: 'solution phase is exactly when a solution is filed' },
		{ status: 'voting', week: LIVE, cycleClosed: false, liveCycle: false, expected: true, why: 'no cycle row is not a refusal — the wire already answered' },
		// ⛔ THE MONDAY WINDOW. `weekClosedSql` reports a PAST week whose cycle row still says
		// `voting` as OPEN on purpose (~3h each Monday, a stalled scheduler, backfillMissedCycles).
		// The server will accept this POST, so the browser must not refuse it: and-ing the wire with
		// the week comparison would cost the author a completed build for a rule that does not exist.
		{ status: 'voting', week: PAST, cycleClosed: false, liveCycle: true, expected: true, why: 'the wire says OPEN on a past week — the server accepts, so we offer' },

		// ── `status === 'closed'` is an AUTHORITATIVE close and refuses first ─────────────────────
		{ status: 'closed', week: LIVE, cycleClosed: false, liveCycle: true, expected: false, why: 'healOrphanedChallenges / a super-admin has said this one is over' },
		{ status: 'closed', week: LIVE, liveCycle: true, expected: false, why: '…with no wire field either' },
		{ status: 'closed', week: PAST, cycleClosed: true, liveCycle: false, expected: false, why: 'both arms agree' },

		// ── the wire is ABSENT (mid-roll): fall back to the week comparison ───────────────────────
		{ status: 'voting', week: PAST, liveCycle: true, expected: false, why: 'MID-ROLL: the week is behind the live cycle, which is the same comparison the past_cycle badge makes' },
		{ status: 'solution_phase', week: PAST, liveCycle: true, expected: false, why: 'MID-ROLL: same, from the solution phase' },
		{ status: 'voting', week: LIVE, liveCycle: true, expected: true, why: 'MID-ROLL: the live week' },
		{ status: 'voting', week: '2026-W30', liveCycle: true, expected: true, why: 'MID-ROLL: AHEAD of the live cycle is not behind it' },
		// ⛔ NO WIRE AND NO CYCLE — the branch prod executes today (`/api/cycle/current` answers null
		// whenever the engine has not opened the running week). Nothing left but `status`, and the
		// floor is OPEN: the server guard is total and its 422 explains itself, whereas a
		// wrongly-withdrawn button costs a build that can never be filed at all.
		{ status: 'voting', week: PAST, liveCycle: false, expected: true, why: 'NO WIRE, NO CYCLE: we cannot tell, and refusing would cost a completed build' },
		{ status: 'voting', week: 'not-a-week', liveCycle: true, expected: true, why: 'an unparseable token is not evidence of death' }
	];

	for (const c of CASES) {
		const wire = 'cycleClosed' in c ? String(c.cycleClosed) : 'absent';
		it(`${c.status} · week=${c.week} · cycleClosed=${wire} · cycle=${c.liveCycle ? LIVE : 'null'} ⇒ ${c.expected} — ${c.why}`, () => {
			const state = challengeState(
				{ status: c.status, week: c.week, ...('cycleClosed' in c ? { cycleClosed: c.cycleClosed } : {}) },
				c.liveCycle ? cycle() : null,
				NOW
			);
			expect(state.submittable).toBe(c.expected);
			// The reason is present exactly when the CTA is gone, and absent exactly when it is not.
			// Without this pairing a `buildBlockedReason` that always returned null would be invisible.
			if (c.expected) expect(buildBlockedReason(state)).toBeNull();
			else expect(buildBlockedReason(state)).not.toBeNull();
		});
	}

	it('⛔ is NOT the same predicate as canVote — the vote gate must not move with it', () => {
		// The one case that separates them, and the reason `canVote` was left alone: the server
		// refuses a SUBMISSION here (`challengeClosedSql`) and ACCEPTS a VOTE (`vote-service` keys on
		// `status` alone). Collapsing the two would disable a control for a rule that does not exist.
		const state = challengeState({ status: 'voting', week: PAST, cycleClosed: true }, cycle(), NOW);
		expect(state.submittable).toBe(false);
		expect(state.canVote).toBe(true);
		expect(voteBlockedReason(state)).toBeNull();
		expect(buildBlockedReason(state)).not.toBeNull();
	});

	it('names the WEEK in the refusal whenever the token parses, and never invents one when it does not', () => {
		// The refusal speaks the page's existing cycle-ended vocabulary — the badge already says
		// "Voting week finished" and the sidebar already names week 21 of 2026.
		const dated = challengeState({ status: 'voting', week: PAST, cycleClosed: true }, cycle(), NOW);
		expect(buildBlockedReason(dated)).toBe('BUILD_BLOCKED_WEEK:WEEK_BADGE:21,2026');

		// ⛔ A "Week undefined · NaN" refusal would be a third fiction on this screen. `parseIsoWeek`
		// returns null on a malformed token and the unparameterised arm covers it.
		const undated = challengeState({ status: 'closed', week: '' }, cycle(), NOW);
		expect(buildBlockedReason(undated)).toBe('BUILD_BLOCKED');
		expect(buildBlockedReason(undated)).not.toContain('undefined');
		expect(buildBlockedReason(undated)).not.toContain('NaN');
	});
});

describe('parseIsoWeek', () => {
	it('splits the token the backend writes', () => {
		expect(parseIsoWeek('2026-W01')).toEqual({ year: 2026, week: 1 });
		expect(parseIsoWeek('2026-W53')).toEqual({ year: 2026, week: 53 });
	});

	it('refuses everything else rather than guessing', () => {
		for (const bad of [null, undefined, '', '2026-W1', '26-W01', '2026W01', 'W01-2026']) {
			expect(parseIsoWeek(bad)).toBeNull();
		}
	});
});

// ⛔ THE CYCLE RUNS WEEKLY, MONTHLY OR YEARLY (backend `cycle.cadence`), and the wire's `week` field
// carries the period KEY of whichever kind. The badge and the earlier-round notes used to parse only
// `YYYY-Www`, so a month or year challenge showed NO period at all, and a week challenge behind a
// MONTH cycle was compared as text ('2026-W40' > '2026-11') and claimed to be current.
describe('the period badge and notes render by period KIND', () => {
	it('names a month with Intl ("October 2026"), localized, and a year as the year', () => {
		const month = challengeState({ status: 'voting', week: '2026-10' }, null, NOW);
		expect(challengeWeekLabel(month)).toBe('October 2026');
		expect(periodName(parsePeriod('2026-10')!, 'nl')).toBe('oktober 2026');
		expect(periodName(parsePeriod('2026-10')!, 'de')).toBe('Oktober 2026');
		const year = challengeState({ status: 'voting', week: '2026' }, null, NOW);
		expect(challengeWeekLabel(year)).toBe('2026');
		// A week still goes through its catalog message.
		expect(challengeWeekLabel(challengeState({ status: 'voting', week: '2026-W42' }, null, NOW))).toBe('WEEK_BADGE:42,2026');
	});

	it('a past MONTH names the month in the vote note and the build refusal', () => {
		const state = challengeState({ status: 'voting', week: '2026-09', cycleClosed: true }, cycle({ week: '2026-10' }), NOW);
		expect(state.kind).toBe('past_cycle');
		expect(challengeVoteNote(state)).toBe('NOTE_PAST_CYCLE:September 2026');
		expect(buildBlockedReason(state)).toBe('BUILD_BLOCKED_WEEK:September 2026');
	});

	it('orders periods of DIFFERENT kinds by start, never by key text', () => {
		// After a week→month switch: a W40 challenge (Sep 28) is behind the November cycle.
		expect(challengeState({ status: 'voting', week: '2026-W40' }, cycle({ week: '2026-11' }), NOW).kind).toBe('past_cycle');
		// …and a December challenge is not behind it.
		expect(challengeState({ status: 'voting', week: '2026-12' }, cycle({ week: '2026-11' }), NOW).kind).toBe('plain');
	});

	it('refuses malformed month keys rather than printing "undefined"', () => {
		for (const bad of ['2026-13', '2026-00', '2026-1', '26']) expect(parsePeriod(bad)).toBeNull();
	});

	it('names a QUARTER through its catalog message (quarter, year), never as a month or "undefined"', () => {
		expect(parsePeriod('2026-Q4')).toEqual({ kind: 'quarter', year: 2026, quarter: 4 });
		const q = challengeState({ status: 'voting', week: '2026-Q4' }, null, NOW);
		expect(challengeWeekLabel(q)).toBe('QUARTER_BADGE:4,2026');
		for (const bad of ['2026-Q0', '2026-Q5', '2026-q1', '2026-Q12']) expect(parsePeriod(bad)).toBeNull();
	});

	it('a past QUARTER is behind a later cycle by START, and a quarter is not behind a month inside it', () => {
		const past = challengeState({ status: 'voting', week: '2026-Q2', cycleClosed: true }, cycle({ week: '2026-10' }), NOW);
		expect(past.kind).toBe('past_cycle');
		expect(challengeVoteNote(past)).toBe('NOTE_PAST_CYCLE:QUARTER_BADGE:2,2026');
		// Q4 starts Oct 1 = the October cycle's start: not strictly before it.
		expect(challengeState({ status: 'voting', week: '2026-Q4' }, cycle({ week: '2026-10' }), NOW).kind).toBe('plain');
		// A September (Q3) week is behind a Q4 cycle.
		expect(challengeState({ status: 'voting', week: '2026-W36' }, cycle({ week: '2026-Q4' }), NOW).kind).toBe('past_cycle');
	});
});
