// src/lib/challenges/challenge-state.ts — what a challenge's state ACTUALLY says, as a value.
//
// ⛔ THE DEFECT. Three strings on the challenge screens announced a deadline that nothing on the
// wire produced:
//
//   "In voting · closes Thu 18:00"   `challenge_detail_status_voting` — the status pill
//   "Voting closes Thursday 18:00."  `challenge_detail_vote_note_open` — the sidebar note
//   "Tue → Thu 18:00"                `challenge_detail_lc_in_voting_sub` — the lifecycle step
//
// None of them read a field. They were static catalog entries, so every challenge claimed the same
// deadline forever — including prod's `2026-W21`/`W23`/`W24` rows, whose cycles closed SEVEN WEEKS
// before the page was still promising "closes Thu 18:00". Meanwhile `week` was fetched
// (routes/challenges.ts:216 + :481), typed (types/challenges.ts), and never rendered by either
// challenge screen — the one field that could have told the truth was the one being thrown away.
//
// WHY A MODULE AND NOT AN INLINE `$derived`. Same reason as `$lib/billing/budget-status.ts` and
// `$lib/layout/navConfig.ts`: an expression inside a Svelte `{#if}` can only ever be asserted
// through a mounted page, and the branch that matters most here — `cycle === null` — is the one
// prod executes today, because `GET /api/cycle/current` returns null whenever no `marketplace_cycles`
// row exists for the current ISO week (routes/cycle.ts:51, host/cycle-service.ts:450). A branch
// nobody can call directly is a branch nobody tests.
import type { ChallengeStatus } from '$lib/types/challenges';
import type { CycleState } from '$lib/types/cycle';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { monthYear } from '$lib/utils/format';

/** An ISO week token (`2026-W23`) split into its two numbers, so no call site parses strings. */
export interface IsoWeek {
	year: number;
	week: number;
}

/** `2026-W23` — the exact shape `weekString()` writes and `POST /api/cycle/advance` validates. */
const ISO_WEEK = /^(\d{4})-W(\d{2})$/;

/**
 * Parse an ISO week token, or `null` if it is missing/malformed.
 *
 * Returns null rather than throwing or coercing: `week` reaches us from JSON, and an older row, a
 * partial payload or a future format change must degrade to "we don't name a week" — never to
 * `Week undefined · NaN` on the badge.
 */
export function parseIsoWeek(raw: string | null | undefined): IsoWeek | null {
	const match = ISO_WEEK.exec(raw ?? '');
	if (!match) return null;
	return { year: Number(match[1]), week: Number(match[2]) };
}

/**
 * A competition period token of any kind — the voting cycle runs weekly, monthly, quarterly or
 * yearly (backend `cycle.cadence`), and the wire's `week` field carries the period KEY of whichever
 * kind: `2026-W42` · `2026-10` · `2026-Q4` · `2026`. The four shapes are disjoint, so the key names
 * its kind.
 */
export type PeriodToken =
	| { kind: 'week'; year: number; week: number }
	| { kind: 'month'; year: number; month: number }
	| { kind: 'quarter'; year: number; quarter: number }
	| { kind: 'year'; year: number };

const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/;
const YEAR_KEY = /^(\d{4})$/;

/** Parse a period key of any kind, or `null` when it is missing/malformed (never `NaN` on screen). */
export function parsePeriod(raw: string | null | undefined): PeriodToken | null {
	const w = parseIsoWeek(raw);
	if (w) return { kind: 'week', ...w };
	const mo = MONTH_KEY.exec(raw ?? '');
	if (mo) {
		const month = Number(mo[2]);
		return month >= 1 && month <= 12 ? { kind: 'month', year: Number(mo[1]), month } : null;
	}
	const q = QUARTER_KEY.exec(raw ?? '');
	if (q) return { kind: 'quarter', year: Number(q[1]), quarter: Number(q[2]) };
	const y = YEAR_KEY.exec(raw ?? '');
	return y ? { kind: 'year', year: Number(y[1]) } : null;
}

/** The first instant of a period, UTC (ISO week 1 is the week holding 4 January). */
function periodStartMs(p: PeriodToken): number {
	if (p.kind === 'year') return Date.UTC(p.year, 0, 1);
	if (p.kind === 'month') return Date.UTC(p.year, p.month - 1, 1);
	if (p.kind === 'quarter') return Date.UTC(p.year, 3 * (p.quarter - 1), 1);
	const jan4 = Date.UTC(p.year, 0, 4);
	const mondayW1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
	return mondayW1 + (p.week - 1) * 7 * 86_400_000;
}

/**
 * Is period `a` strictly before period `b`? By START, never by key text: `'2026-W41' < '2026-10'`
 * is true as text and meaningless as time, and across a cadence change the two kinds mix.
 */
function weekIsBefore(a: string, b: string): boolean {
	const pa = parsePeriod(a);
	const pb = parsePeriod(b);
	return !!pa && !!pb && periodStartMs(pa) < periodStartMs(pb);
}

/**
 * The period as words, by its kind: "Week 42 · 2026" (a catalog message — the word and its order
 * are a translator's) · "October 2026" (`Intl`, no catalog entry) · "Q4 2026" (a catalog message:
 * the quarter's letter is a translator's — T4 in French/Spanish, K4 in Dutch) · "2026".
 */
export function periodName(p: PeriodToken, locale: string = getLocale()): string {
	switch (p.kind) {
		case 'week':
			return m.challenge_period_week({ week: p.week, year: p.year });
		case 'month':
			return monthYear(Date.UTC(p.year, p.month - 1, 1), locale);
		case 'quarter':
			return m.challenge_period_quarter({ quarter: p.quarter, year: p.year });
		case 'year':
			return String(p.year);
	}
}

/**
 * A raw period key ("2026-W21", "2026-10", "2026-Q4", "2026") as words — `periodName` of the
 * parsed key. A key that does not parse is returned as-is rather than dropped: the reader then
 * still sees which period is meant, which beats an empty slot.
 */
export function periodKeyName(raw: string, locale: string = getLocale()): string {
	const p = parsePeriod(raw);
	return p ? periodName(p, locale) : raw;
}

/**
 * A coarse "3d" / "5h" to a real boundary, or `null` when there is nothing truthful to say.
 *
 * Direction-neutral and RTL-safe (no weekday, no clock time), matching `remaining()` in
 * components/marketplace/CadenceStrip.svelte — the countdown that already ships. Null on a
 * non-positive or unparseable interval is the load-bearing part: CadenceStrip prints `—` there,
 * which is acceptable on a phase strip but not inside a sentence like "closes in —".
 */
function coarseRemaining(deadline: string, now: Date): string | null {
	const ms = Date.parse(deadline) - now.getTime();
	if (!Number.isFinite(ms) || ms <= 0) return null;
	const hours = Math.floor(ms / 3_600_000);
	return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${Math.max(1, hours)}h`;
}

interface StateBase {
	status: ChallengeStatus;
	/** The challenge's own period (week, month or year), parsed; null when missing or malformed. */
	period: PeriodToken | null;
	/**
	 * May this reader's vote actually land?
	 *
	 * ⛔ EXACTLY the backend's predicate and nothing more: `host/vote-service.ts` throws
	 * `409 voting_closed` on `status === 'closed'`, and on nothing else. Widening this (e.g. also
	 * blocking a stale-week challenge the server would still accept) trades one lie for another —
	 * a control disabled for a rule that does not exist. Narrowing it is the bug this replaces:
	 * both vote sites rendered a live-looking pill on closed challenges that 409'd on click.
	 */
	canVote: boolean;
	/**
	 * May a NEW SOLUTION still be filed against this challenge?
	 *
	 * ⛔ A DIFFERENT QUESTION FROM `canVote`, WITH A DIFFERENT SERVER RULE, AND THAT IS THE WHOLE
	 * POINT. `host/vote-service.ts` refuses a vote on `status === 'closed'` and nothing else;
	 * `POST /api/solutions` refuses a SUBMISSION on `challengeClosedSql` — `status === 'closed'` OR
	 * the challenge's own week being over (backend/src/host/cycle-eligibility.ts). Two predicates,
	 * so two fields. Folding them into one would either widen the vote gate (a control disabled for
	 * a rule that does not exist) or narrow the submit gate back to the bug below.
	 *
	 * ⛔ THE BUG THIS EXISTS FOR, MEASURED IN A BROWSER. A `2026-W21` challenge rendered, in ONE
	 * viewport, a muted "Voting week finished" badge, a sidebar line reading "…week 21 of 2026,
	 * which is already finished", and between them a live "Build a solution" link. Following it and
	 * submitting returned 201: the solution was stamped with the CURRENT week and competed in a live
	 * cycle under a May parent. Nine consecutive cycles crowned nobody. The server now 422s it — this
	 * field is what stops the product OFFERING it.
	 *
	 * SOURCE OF TRUTH, IN ORDER: the wire's `cycleClosed` when it is present (it is the only party
	 * that can see `marketplace_cycles`), else the client-side week comparison against the live
	 * cycle, else `status` alone. See `submittableFrom` for why the wire OUTRANKS the week
	 * comparison rather than being and-ed with it.
	 */
	submittable: boolean;
}

/**
 * The four things a challenge's state can be. Discriminated rather than a bag of optional fields
 * so the label functions below cannot reach for a countdown that was never computed.
 */
export type ChallengeState =
	/** `status === 'closed'`. The server refuses votes; the pill must not look live. */
	| (StateBase & { kind: 'closed'; canVote: false; submittable: false })
	/**
	 * The challenge's week is strictly behind the live cycle's. It cannot have a future deadline.
	 *
	 * ⚠️ DELIBERATELY NOT NARROWED TO `submittable: false`, even though the week comparison is what
	 * the FALLBACK reads. `weekClosedSql` reports a past week whose cycle row still says `voting` as
	 * OPEN on purpose — the ~3h Monday window before the scheduler ticks, a stalled scheduler,
	 * `backfillMissedCycles`. In that window the server accepts the submission, so a `past_cycle`
	 * row carrying `cycleClosed: false` is submittable and this type must be able to say so.
	 */
	| (StateBase & { kind: 'past_cycle'; period: PeriodToken })
	/** The live week, with a REAL boundary from the cycle row still ahead of us. */
	| (StateBase & { kind: 'counting_down'; deadline: string; remaining: string })
	/** Status word only. No cycle, no derivable boundary — so no time claim of any kind. */
	| (StateBase & { kind: 'plain' });

/** The three facts a challenge carries about its own liveness. Not `ChallengeRow`/`ChallengeDetail`:
 *  those are two different DTO shapes and this module must not learn either. */
export interface ChallengeLiveness {
	status: ChallengeStatus;
	week: string;
	/** The server's own submit gate, off the wire. Absent only during a mid-roll — see below. */
	cycleClosed?: boolean | null;
}

/**
 * `submittable`, as its own function because the precedence is the whole argument.
 *
 * 1. `status === 'closed'` refuses first, and the backend keeps the same disjunct
 *    (`challengeClosedSql`). ⚠️ It is a LEGACY value, not a live decision: nothing in the product
 *    writes `'closed'` any more — there is no user-facing close path, `healOrphanedChallenges` is
 *    report-only, and the calendar sweeps that used to write it are deleted. Every closed row on
 *    the board predates that. The refusal stays because a row that IS closed must still be
 *    refused; it no longer means anyone recently judged the work finished.
 *
 * 2. ⛔ THE WIRE OUTRANKS THE CLOCK, AND IS NOT AND-ED WITH IT. `cycleClosed` is computed against
 *    `marketplace_cycles`, which no browser query reaches; the week comparison below is a coarse
 *    approximation of it. Where the two disagree the server is right BY CONSTRUCTION — it is the
 *    party that will accept or refuse the POST. And-ing them would re-introduce the mirror bug: a
 *    challenge the server would happily accept, refused by the browser during the Monday window,
 *    which costs the author a completed build.
 *
 * 3. ⚠️ ABSENT IS NOT `false`. A missing field means an older server, a partial fixture or a
 *    hand-built object, so fall through to the week comparison this page already performs — the
 *    same comparison that decides the `past_cycle` badge. With no cycle EITHER (the branch prod
 *    executes today: `/api/cycle/current` returns null whenever the engine has not opened the
 *    running week) there is nothing left but `status`, and staying OPEN there is the right floor:
 *    the server guard is total, and a wrongly-withdrawn button costs a completed build while a
 *    wrongly-offered one costs one 422 that now says exactly what went wrong.
 */
function submittableFrom(challenge: ChallengeLiveness, cycle: CycleState | null): boolean {
	if (challenge.status === 'closed') return false;
	// `!= null`, LOOSE, so `undefined` takes the fallback as well as `null`.
	if (challenge.cycleClosed != null) return !challenge.cycleClosed;
	return !(cycle && weekIsBefore(challenge.week, cycle.week));
}

/**
 * Decide what a challenge's state says, given the live cycle (or its absence).
 *
 * `now` is a parameter, not `new Date()` inline, for the usual reason: the countdown branch is a
 * clock comparison and a test must be able to stand on either side of the boundary.
 */
export function challengeState(
	challenge: ChallengeLiveness,
	cycle: CycleState | null,
	now: Date = new Date()
): ChallengeState {
	const period = parsePeriod(challenge.week);
	const base = {
		status: challenge.status,
		period,
		canVote: challenge.status !== 'closed',
		submittable: submittableFrom(challenge, cycle)
	};

	// 1. Closed is the server's own verdict and it outranks every clock. It is also the branch the
	//    board is about to be dominated by: the companion workstream closes the legacy challenges,
	//    so this is the common case, not the edge case.
	if (challenge.status === 'closed') return { ...base, kind: 'closed', canVote: false, submittable: false };

	// 2. ⛔ NO CYCLE — the branch prod is executing right now. `/api/cycle/current` reads
	//    `marketplace_cycles` for `weekString(now)` and returns null when the engine has not opened
	//    that week. With no cycle row there is no `votingEndsAt`, no reference week, and therefore
	//    nothing true to say about time. A plain status word is the honest floor.
	if (!cycle) return { ...base, kind: 'plain' };

	// 3. Behind the live week. Whatever the row's `status` column still claims, its cycle is over —
	//    a W23 challenge cannot close next Thursday. `week` is non-null here by construction:
	//    `weekIsBefore` only answers true when both tokens parse.
	if (period && weekIsBefore(challenge.week, cycle.week)) {
		return { ...base, kind: 'past_cycle', period };
	}

	// 4. Not the live week and not behind it — either the same week, or ahead of it (a challenge
	//    stamped for a week the engine has not opened yet), or an unparseable token. Only the
	//    same-week case has a boundary we are entitled to quote.
	if (challenge.week !== cycle.week) return { ...base, kind: 'plain' };

	// 5. The live week. Quote the cycle's OWN boundary for this challenge's phase — `votingEndsAt`
	//    while it is in voting, `solutionEndsAt` once it is in the solution phase. No weekday and no
	//    clock time is invented anywhere: if the row says the boundary is a Tuesday, we count down
	//    to a Tuesday.
	const deadline = challenge.status === 'voting' ? cycle.votingEndsAt : cycle.solutionEndsAt;
	const remaining = coarseRemaining(deadline, now);
	// A boundary already behind us needs no phase check of its own: a challenge still stamped
	// `voting` while the cycle has moved to `solution_phase` has a `votingEndsAt` in the past, and
	// falls out here into the plain status rather than counting down to a negative number.
	if (!remaining) return { ...base, kind: 'plain' };
	return { ...base, kind: 'counting_down', deadline, remaining };
}

// ---- the words --------------------------------------------------------------------------------
// Paraglide-aware, exhaustive switches, in the same file as the decision — the `stage-label.ts`
// shape. Every `m.*` reference below is a STATIC one: paraglide compiles one function per key and
// tree-shakes on the import graph, so a dynamically built `m[`challenge_state_${kind}`]` would not
// resolve to anything at runtime.

/** The status pill. Carries a countdown only when `challengeState` produced a real one. */
export function challengeStatusLabel(state: ChallengeState): string {
	switch (state.kind) {
		case 'closed':
			return m.mkt_status_closed();
		case 'past_cycle':
			return m.challenge_state_earlier_week();
		case 'counting_down':
			return state.status === 'voting'
				? m.challenge_state_voting_countdown({ time: state.remaining })
				: m.challenge_state_solution_countdown({ time: state.remaining });
		case 'plain':
			return state.status === 'voting' ? m.mkt_status_voting() : m.mkt_status_solution_phase();
	}
}

/**
 * The challenge's week, as words — or `null` when the token did not parse and there is no week to
 * name. ⛔ ONE message with two params, never `m.week_word() + ' ' + n`: a fragment glued to a
 * number is unorderable, and `ar`/`he` put the pieces the other way round.
 */
export function challengeWeekLabel(state: ChallengeState): string | null {
	if (!state.period) return null;
	return periodName(state.period);
}

/**
 * The sentence under the vote control — what clicking it will do.
 *
 * ⛔ NOT simply `challengeStatusLabel` reworded. The `counting_down` pill may be quoting
 * `solutionEndsAt` (the phase boundary), but challenge voting stays OPEN through the solution
 * phase — the server only refuses on `closed`. Repeating the solution-phase countdown here would
 * read as "you have 2 days to vote", which is not what that timestamp means. Only the `voting`
 * countdown is a statement about voting.
 */
export function challengeVoteNote(state: ChallengeState): string {
	switch (state.kind) {
		case 'closed':
			return m.challenge_detail_vote_note_closed();
		case 'past_cycle':
			return m.challenge_vote_note_earlier_period({ period: periodName(state.period) });
		case 'counting_down':
			return state.status === 'voting'
				? m.challenge_vote_note_countdown({ time: state.remaining })
				: m.challenge_detail_vote_note_open();
		case 'plain':
			return m.challenge_detail_vote_note_open();
	}
}

/**
 * Why the vote pill is inert, or `null` when it is live. Fed to the control's tooltip; the same
 * fact is always on screen as well (the status badge beside the row, the vote note under the
 * detail-page pill), because a `title` on a disabled button is not reachable by keyboard.
 */
export function voteBlockedReason(state: ChallengeState): string | null {
	return state.canVote ? null : m.challenge_detail_vote_note_closed();
}

/**
 * Why the "Build a solution" affordance is gone, or `null` when it is live. The SUBMIT-side sibling
 * of `voteBlockedReason`, and never the same sentence: "Voting has closed" is about a vote, and a
 * reader who wanted to BUILD is owed the reason their build cannot be filed.
 *
 * ⛔ IT NAMES THE WEEK WHENEVER THERE IS ONE. The vocabulary is the page's existing cycle-ended
 * vocabulary (`challenge_state_earlier_week` on the badge, `challenge_vote_note_earlier_period` in the
 * sidebar) — the measured defect was those two truths sitting in the same viewport as a live
 * "Build a solution" link, so the refusal has to speak the same language they do rather than
 * introduce a third account of the same fact. The unparameterised arm exists only for the rows
 * whose `week` token does not parse; `challengeWeekLabel` returns null on exactly those, so a
 * "Week undefined" can never be built here either.
 *
 * ⚠️ Returns the REASON only. The way OUT — a link to the board — is the caller's markup, because
 * this module emits strings and the pattern that matters ("the thing that says no is also the way
 * out", BuildTopbar.svelte:206-212) is an anchor, not a sentence.
 */
export function buildBlockedReason(state: ChallengeState): string | null {
	if (state.submittable) return null;
	return state.period
		? m.challenge_build_blocked_period({ period: periodName(state.period) })
		: m.challenge_build_blocked();
}
