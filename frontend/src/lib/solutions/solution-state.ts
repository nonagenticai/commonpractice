// src/lib/solutions/solution-state.ts — what a SOLUTION's vote control is allowed to say.
//
// ⛔ WHY THIS IS A SIBLING OF `$lib/challenges/challenge-state.ts` AND NOT A CALL INTO IT.
// The two look alike and are not. For a challenge, one record answers both questions: its `status`
// decides votability and its `week` dates it. For a solution the two answers live in DIFFERENT
// RECORDS, and the obvious shortcuts are all wrong:
//
//   • VOTABILITY IS THE SOLUTION'S OWN COMPETING CYCLE'S. The server gate is `weekClosedSql`
//     (backend/src/host/cycle-eligibility.ts): has the cycle for THIS ROW'S week closed?
//     `host/vote-service.ts` throws `409 voting_closed` on exactly that and on nothing else. The
//     browser cannot recompute it (it needs `marketplace_cycles`), so the answer arrives on the wire
//     as `cycleClosed` and this module's job is to not second-guess it.
//
//   • ⛔ IT IS **NOT** THE PARENT CHALLENGE'S STATUS, and this module used to say it was. The
//     server really did derive it that way, and that derivation is why the marketplace announced no
//     winner for nine consecutive weeks: `healOrphanedChallenges` closed any challenge whose own
//     week was over, so an entry filed into the LIVE week while answering an older challenge was
//     struck unvotable within hours of being submitted, and `closeCycle`'s "a winner needs ≥1 vote"
//     guard could never be met. Prod's whole 2026-W33 board was one such row. A pill wired to the
//     parent's status is now wrong in BOTH directions: inert on a votable row, live on a dead one.
//
//   • `solution.status` IS NEVER THE SIGNAL. `closeCycle` flips only the WINNER to 'shipping' and
//     leaves every other solution at 'voting' forever, so `status === 'voting'` is true of most
//     solutions in the product and means nothing about voting.
//
//   • `solution.week` IS NOT THE PARENT'S WEEK. It is written as
//     `laterWeek(weekString(now), ch.week)` (backend/src/routes/solutions.ts) — the week the
//     SOLUTION competes in, rolled forward when someone answers an older challenge so the row is
//     not filed into an already-closed week. It is still the right key for "may we quote the live
//     cycle's clock at this row" (step 5 below), and still NOT a stand-in for the parent's cycle.
//
// Folding those into `ChallengeState` would have meant one vocabulary quietly meaning two things
// depending on which screen read it. Two honest vocabularies beat one leaky one.
import type { SolutionStatus } from '$lib/types/solutions';
import type { CycleState } from '$lib/types/cycle';
import * as m from '$lib/paraglide/messages';

/**
 * Whether a vote on this solution can land, as a value with three states rather than a nullable
 * boolean — `null` meaning "maybe" reads as falsy at every call site that forgets to check.
 *
 * ⛔ `'unknown'` IS BLOCKED, NOT A COIN FLIP, and the reasoning survives the rule change that
 * renamed its sibling. The three-way split exists because a MISSING answer and a NEGATIVE answer
 * are different facts that deserve different words; collapsing them into a boolean is what makes a
 * page confidently claim something it never read.
 *
 * The value can only be missing during a mid-roll — an older server answering without
 * `cycleClosed`, a partial fixture, a hand-built object. In that window the browser genuinely does
 * not know: the gate lives in `marketplace_cycles`, which no client query reaches. The first
 * version of this module argued "the server may well accept the vote, so leave the pill live", and
 * that is exactly backwards — it ships an inviting control that may answer with a red banner. A
 * blocked pill with an honest "we cannot tell" costs one click that was never going to work.
 *
 * ⚠️ `'parent_closed'` USED TO BE THE MIDDLE VALUE. It is `'cycle_closed'` now, because the server
 * gate moved off the parent challenge and onto this solution's own competing cycle — see the header.
 * The rename is the point: a state whose name says "parent" would keep teaching the wrong model.
 */
export type SolutionVotability = 'open' | 'cycle_closed' | 'unknown';

export type SolutionState =
	/** This solution won its week and is on its way to production. Its own status says so. */
	| { kind: 'shipping'; votability: SolutionVotability }
	/** This solution's own competing cycle has closed. The server refuses; the pill must not look live. */
	| { kind: 'voting_closed'; votability: 'cycle_closed' }
	/** The wire did not carry `cycleClosed` — we cannot tell. See `SolutionVotability`. */
	| { kind: 'votability_unknown'; votability: 'unknown' }
	/** Votable AND competing in the live week: a real boundary exists. */
	| { kind: 'counting_down'; votability: 'open'; deadline: string; remaining: string }
	/** Status word only: votable, but there is no live boundary to quote. */
	| { kind: 'plain'; votability: 'open' };

/** Mirrors `coarseRemaining` in challenge-state.ts. Duplicated rather than shared: see below. */
function coarseRemaining(deadline: string, now: Date): string | null {
	const ms = Date.parse(deadline) - now.getTime();
	if (!Number.isFinite(ms) || ms <= 0) return null;
	const hours = Math.floor(ms / 3_600_000);
	return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${Math.max(1, hours)}h`;
}

/**
 * Decide what a solution's vote surface may say.
 *
 * The parameters are the four independent facts, deliberately not a `SolutionRow` — the list DTO
 * and the detail DTO are different shapes and this must not learn either.
 *
 * @param cycleClosed the server's own vote gate, off the wire. `null`/`undefined` only during a
 *        mid-roll where the payload omits it (see `SolutionVotability`).
 */
export function solutionState(
	solutionStatus: SolutionStatus,
	solutionWeek: string,
	cycleClosed: boolean | null,
	cycle: CycleState | null,
	now: Date = new Date()
): SolutionState {
	// ⛔ `== null`, LOOSE, ON PURPOSE — it must catch `undefined` as well as `null`. A payload that
	// OMITS `cycleClosed` (an older backend mid-roll, a partial fixture, a hand-built object) would
	// otherwise fall past a strict `=== null` into 'open' and render a confidently live pill on a
	// row nobody has verified — the single worst of the three outcomes, and the one a strict check
	// picks silently. Note this is ALSO why the field is not defaulted to `false` at the boundary:
	// "absent" and "open" must not become the same value.
	const votability: SolutionVotability =
		cycleClosed == null ? 'unknown' : cycleClosed ? 'cycle_closed' : 'open';

	// 1. Shipping is the winner's own, earned state and it outranks the rest — including a closed
	//    cycle, which is precisely the situation a winner is always in (the close that crowned it
	//    is the same close that shut its week).
	if (solutionStatus === 'shipping') return { kind: 'shipping', votability };

	// 2. ⛔ THE SERVER REFUSES, AND THIS IS THE ONE FACT THE BROWSER CANNOT DERIVE. `cycleClosed`
	//    comes off `marketplace_cycles`, which no client query reaches. This branch used to key on
	//    the PARENT CHALLENGE's status and was wrong in both directions: inert on a live entry whose
	//    old parent had been healed shut (prod's entire 2026-W33 board — the tenth winnerless week
	//    in a row), and live on a dead entry whose parent happened to still say `voting`.
	if (votability === 'cycle_closed') return { kind: 'voting_closed', votability };

	// 3. The gate did not arrive, so nothing about it can be said — including that it is open.
	if (votability === 'unknown') return { kind: 'votability_unknown', votability };

	// 4. Votable, but with no live cycle there is no boundary to quote.
	if (!cycle) return { kind: 'plain', votability };

	// 5. ⛔ ONLY the live week may be quoted, and `solutionWeek` is exactly the right key: it is the
	//    week THIS ROW is judged in, so if it is not the running week there is no boundary of ours in
	//    the cycle row to point at. The comparison is equality, never ordering — a FUTURE
	//    `solutionWeek` is legitimate (`laterWeek` rolls a row forward when it answers a challenge
	//    already pushed into W+1) and votable, it just has no cycle row to quote yet.
	if (solutionWeek !== cycle.week) return { kind: 'plain', votability };

	// 6. `closesAt`, NOT `votingEndsAt`. A solution stops being votable when ITS OWN cycle closes,
	//    which is what `closeCycle` does at `closes_at` — `votingEndsAt` is the CHALLENGE-voting
	//    boundary and has nothing to do with this row. A boundary already behind us yields null and
	//    falls back to the plain status rather than a negative countdown.
	const remaining = coarseRemaining(cycle.closesAt, now);
	if (!remaining) return { kind: 'plain', votability };
	return { kind: 'counting_down', votability: 'open', deadline: cycle.closesAt, remaining };
}

// ---- the words --------------------------------------------------------------------------------
// Its own message keys, not the `challenge_*` ones. The strings coincide today; the concepts do
// not, and a shared key is how one screen's rewording silently becomes another's. Same reason
// `coarseRemaining` is duplicated above: extracting it would be the first thread pulling the two
// vocabularies back together.

/** The status pill. */
export function solutionStatusLabel(state: SolutionState): string {
	switch (state.kind) {
		case 'shipping':
			return m.solution_detail_status_shipping();
		case 'voting_closed':
			return m.solution_state_voting_closed();
		case 'votability_unknown':
			// The solution's own lifecycle word. The badge reports THIS row's column; the vote note and
			// the inert pill carry the fact that the gate could not be read — inventing a status the
			// row does not have would be a second fiction on top of the first.
			return m.solution_detail_status_voting();
		case 'counting_down':
			return m.solution_state_voting_countdown({ time: state.remaining });
		case 'plain':
			return m.solution_detail_status_voting();
	}
}

/** The sentence under the vote control. */
export function solutionVoteNote(state: SolutionState): string {
	switch (state.kind) {
		case 'shipping':
			return m.solution_detail_vote_note_shipping();
		case 'voting_closed':
			return m.solution_vote_note_cycle_closed();
		case 'votability_unknown':
			return m.solution_vote_note_votability_unknown();
		case 'counting_down':
			return m.solution_vote_note_countdown({ time: state.remaining });
		case 'plain':
			// Describes what votes DO. Voting is known-open here but no boundary is quotable, so this
			// says the mechanism rather than inventing a deadline.
			return m.solution_detail_vote_note_ranking();
	}
}

/**
 * Why the vote pill is inert, or `null` when it is live.
 *
 * ⛔ NAMES THE WEEK, NEVER THE SOLUTION, AND KEEPS THE TWO BLOCKED CASES APART. "This solution is
 * closed" would be false — the solution's own row is untouched by the close and still says
 * `voting`. "The challenge behind this closed" would ALSO be false now, and used to be what these
 * two branches said: the parent's lifecycle stopped deciding this the moment the server gate moved
 * onto the solution's own cycle. And a gate we could not READ is not a gate that said no — claiming
 * "voting closed" for a payload that simply omitted the field asserts something we never saw.
 *
 * Only `'open'` returns null. Both other states end in a red banner if clicked.
 */
export function solutionVoteBlockedReason(state: SolutionState): string | null {
	switch (state.votability) {
		case 'cycle_closed':
			return m.solution_vote_note_cycle_closed();
		case 'unknown':
			return m.solution_vote_note_votability_unknown();
		case 'open':
			return null;
	}
}
