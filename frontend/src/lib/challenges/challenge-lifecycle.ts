// src/lib/challenges/challenge-lifecycle.ts — how far along its own four-step arc a challenge is.
//
// ⛔ THE DEFECT. The lifecycle card on the challenge detail screen drew four steps and could only
// ever colour the first two:
//
//   <li class="done">                                            Submitted        — a literal
//   <li class={status === 'voting' ? 'active' : 'done'}>          In voting
//   <li class={status === 'solution_phase' ? 'active' : ''}>      Solution phase   — never 'done'
//   <li>                                                          Winner           — NO class, EVER
//
// A classless `<li>` leaves `.dot` on its base rule, which is `--c-border-strong` — the same grey a
// step that has not happened yet gets. `challenge_status` is `('voting','solution_phase','closed')`
// and `closed` is the DOMINANT state on the live board, so the common case rendered its last TWO
// steps as never-happened: a challenge that ran its entire course, collected solutions and shipped
// one still showed "Solution phase" and "Winner to production" as grey future.
//
// ⛔ WHY A SIBLING OF `challenge-state.ts` AND NOT AN EXTENSION OF IT. Same argument as
// `$lib/solutions/solution-state.ts`: they look alike and answer different questions.
//
//   • DIFFERENT QUESTION. `challengeState` answers "may THIS READER'S VOTE LAND", and its own
//     comment (challenge-state.ts:76-83) pins it there: "EXACTLY the backend's predicate and
//     nothing more" — `host/vote-service.ts` throws 409 on `status === 'closed'` and on nothing
//     else. Widening that predicate to also carry "how far along is this challenge" would make one
//     value mean two things, and the next person to tighten the vote gate would silently restyle a
//     timeline.
//
//   • DIFFERENT INPUT. The lifecycle's fourth step is a fact about `solutions[]` — a field
//     `challengeState` never sees and must not start seeing (it takes `{status, week}` precisely so
//     the list DTO and the detail DTO can both feed it).
//
//   • DIFFERENT CONSUMER. `challengeState` feeds a pill and a disabled button on two screens.
//     This feeds one card's four `<li>` classes and its sr-only state words.
//
// ⛔ WHAT `done` MEANS HERE, AND WHY IT IS NOT "THIS PHASE HAPPENED" FOR A CLOSED CHALLENGE.
// `challenges.status` has exactly ONE writer now: `routes/solutions.ts`, inside the
// solution-insert transaction, the moment a challenge's first solution is filed. It only ever
// moves `voting → solution_phase`, so the status is a fact about SOLUTIONS, not about the
// calendar — `solution_phase` iff the challenge has at least one. Nothing anywhere writes
// `'closed'`, and `healOrphanedChallenges` (backend/src/host/cycle-service.ts) is report-only:
// it names challenges sitting in a week with no live cycle and writes nothing at all. So every `closed` row still on the board today is
// a LEGACY write, from a calendar sweep this codebase no longer runs, and the DTO still carries no
// phase-transition history — there is exactly one `status` column and no log of what a row passed
// through on the wire. A legacy closed challenge may have entered `solution_phase` before it
// closed, or may have gone straight there having collected no solution at all; nothing on the wire
// distinguishes the two. So:
//
//     `done` means "THIS WINDOW IS BEHIND THE CHALLENGE", never "this phase was observed to happen".
//
// That is the strongest claim the data supports, and it is deliberately weaker than a tick usually
// implies. `not_reached_terminal` is reserved for step 4 alone, because step 4 is the ONLY step
// whose outcome is genuinely derivable from the payload: `solutions[].status` is on the wire, and a
// solution in `shipping` is an observable fact rather than an inference about a phase we cannot see.
// Extending `not_reached_terminal` to steps 2–3 would be the same class of lie in a new costume.
//
// ⛔ REJECTED — `winner: 'done'` ON EVERY CLOSED CHALLENGE. The one-line "fix" for the grey dot, and
// a NEW untruth rather than the removal of an old one. `closeCycle` requires a winner to have ≥1
// vote; nine consecutive prod weeks produced none, so this would paint a teal tick and "IT reviews
// the winning solution and releases it" over nothing at all, on the majority of the board.
//
// ⛔ REJECTED — `winner: 'pending'` FOR CLOSED-WITHOUT-A-WINNER. `pending` means "still ahead of
// us". A closed week is terminal: re-deciding it needs an admin `force` on the cycle, not the
// passage of time. Grey-and-pending leaves the reader waiting for an announcement that is never
// coming, which is the original defect with better intentions.
//
// ⛔ REJECTED — SHIPPING `winnerSolutionId` FROM `weekly_winners`. Strictly more precise than
// anything derivable here: `weekly_winners` is the durable winner artifact and would let step 4 name
// the row that actually won its week. It is also a BACKEND change, with a mid-roll window in which
// the field is absent and this module has to fall back to exactly the predicate below anyway — for a
// screen whose signal (`solutions[].status`, on the `getChallenge` response in
// backend/src/routes/challenges.ts) is ALREADY on both wire versions. Precision that costs a
// rolling-deploy exposure, on a card that is decoration
// beside the vote control, is not worth buying.
import type { ChallengeStatus } from '$lib/types/challenges';
import type { SolutionStatus } from '$lib/types/solutions';
import * as m from '$lib/paraglide/messages';

/**
 * How far a single step is along, as four distinct values rather than three-plus-absence.
 *
 * The absence of a class was the third state before this module existed, and absence renders as
 * "not yet" — which is how the terminal case came to be indistinguishable from the future case.
 */
export type LifecycleStepState =
	/** The window is BEHIND the challenge. See the header: not a claim that the phase was observed. */
	| 'done'
	/** The challenge is in this window right now. At most one step per challenge, none when closed. */
	| 'active'
	/** Genuinely still ahead of the challenge. Only reachable while the challenge is still open. */
	| 'pending'
	/**
	 * The arc ended here and this step never happened — and never will without an admin re-open.
	 * ⛔ STEP 4 ONLY (see the header): it is the only step whose outcome the payload can settle.
	 */
	| 'not_reached_terminal';

/** The four steps the card draws, in the order it draws them. */
export interface ChallengeLifecycle {
	submitted: LifecycleStepState;
	voting: LifecycleStepState;
	solutionPhase: LifecycleStepState;
	winner: LifecycleStepState;
}

/**
 * Has a solution of this challenge REACHED PRODUCTION?
 *
 * ⛔ NAMED `hasShippingSolution`, NOT `hasWinner`, AND THE COPY IT DRIVES MUST NOT SAY "won". The
 * name is the whole safety property here, because four separate facts break the "shipping ⇒ won its
 * week" reading:
 *
 *   • `enqueueWinner` (backend/src/host/pipeline-service.ts) HAS TWO CALLERS. One is the weekly
 *     close (host/cycle-service.ts:347). The other is `POST /api/pipeline/enqueue`
 *     (routes/pipeline.ts:561), a super_admin manually queueing ANY solution — no vote, no week, no
 *     `weekly_winners` row. Promotion to the production stage then sets `status: 'shipping'`
 *     (routes/pipeline.ts:397) on whatever was queued.
 *   • ROLLBACK SETS A GENUINE WINNER BACK TO `'voting'` (routes/pipeline.ts:399 and :524). A
 *     solution that truly won its week and was then rolled out of production reads as not-shipping
 *     here, and that is CORRECT for the sentence this drives ("reached production") and would be
 *     false for "won".
 *   • `data.solutions[]` SPANS MULTIPLE WEEKS. The query at routes/challenges.ts:438 filters on
 *     `challenge_id` alone — there is no week predicate — so a shipping row in the list may have won
 *     a different week than the one the reader is looking at.
 *   • `solution.status` IS NEVER A VOTING SIGNAL, as `$lib/solutions/solution-state.ts:22-24`
 *     already warns: `closeCycle` leaves every loser at `'voting'` forever.
 *
 * What survives all four is narrow and true: SOME solution of this challenge is currently in the
 * winner/shipping state, i.e. it reached production. That — and not "weekly_winners has a row" — is
 * what the terminal copy is written against.
 *
 * Takes the rows rather than a boolean so the predicate is one testable place instead of an
 * expression inlined at a call site, and `readonly` so it cannot be handed a list it might sort.
 */
export function hasShippingSolution(solutions: readonly { status: SolutionStatus }[]): boolean {
	// ⛔ EQUALITY WITH `'shipping'`, never `!== 'voting'`. `SolutionStatus` is
	// `'draft' | 'voting' | 'shipping' | 'archived'`: a negative test would call an ARCHIVED (pulled)
	// or DRAFT (never submitted) solution a production release, which is the loudest possible
	// version of this screen's original sin.
	//
	// ⛔ THE PARAMETER IS `SolutionStatus`, NOT `string`, AND THAT IS THE WHOLE POINT OF THE
	// TIGHTENING ON `ChallengeSolutionRef.status`. An adversarial review caught the first draft
	// taking `{ status: string }[]` here: the DTO was narrowed, but this signature RE-WIDENED it, so
	// `s.status` was `string` again inside the function and `'shippping'` typechecked cleanly
	// (measured: `bun run check` → 0 errors). The narrowed DTO only protects this comparison if the
	// comparison itself is made against the narrowed type. Do not loosen it back for the
	// convenience of a caller passing a literal — widen at the CALL SITE with a cast if you must,
	// so the widening is visible where it happens.
	return solutions.some((s) => s.status === 'shipping');
}

/**
 * The four step states for a challenge, over the full `status × shipped` product.
 *
 * Takes the two facts, not a `ChallengeDetail`: the caller owns the DTO shape, and a pure pair of
 * primitives is what makes all six rows assertable as whole objects.
 *
 * | status         | shipped | submitted | voting | solutionPhase | winner               |
 * |----------------|---------|-----------|--------|---------------|----------------------|
 * | voting         | false   | done      | active | pending       | pending              |
 * | voting         | true    | done      | active | pending       | pending              |
 * | solution_phase | false   | done      | done   | active        | pending              |
 * | solution_phase | true    | done      | done   | active        | pending              |
 * | closed         | true    | done      | done   | done          | done                 |
 * | closed         | false   | done      | done   | done          | not_reached_terminal |
 *
 * ⛔ THE TWO `shipped: true` ROWS ON AN OPEN CHALLENGE STILL SAY `pending`, and that is not an
 * oversight. A solution CAN be shipping while its parent is open — the manual super_admin enqueue
 * above needs no close, and `data.solutions[]` spans weeks — but an OPEN challenge has not finished
 * its arc. Marking step 4 `done` there would draw a completed timeline over a challenge still
 * collecting votes. `shipped` only ever decides the terminal branch.
 */
export function challengeLifecycle(status: ChallengeStatus, shipped: boolean): ChallengeLifecycle {
	switch (status) {
		case 'voting':
			return { submitted: 'done', voting: 'active', solutionPhase: 'pending', winner: 'pending' };
		case 'solution_phase':
			return { submitted: 'done', voting: 'done', solutionPhase: 'active', winner: 'pending' };
		case 'closed':
			// `solutionPhase: 'done'` is the weaker "this window is behind it" claim from the header —
			// every closed row still on the board is a legacy write from before this codebase stopped
			// closing challenges on a calendar, and nothing on the wire says whether it passed through
			// `solution_phase` first. `winner` is the one step the payload can actually settle.
			return {
				submitted: 'done',
				voting: 'done',
				solutionPhase: 'done',
				winner: shipped ? 'done' : 'not_reached_terminal'
			};
		default:
			// ⛔ THIS ARM EXISTS BECAUSE `status` IS WIRE DATA, AND tsc DOES NOT RUN IN PRODUCTION.
			//
			// Without it the switch returns `undefined` on any value outside the enum, `lifecycle`
			// becomes `undefined`, and the page's `{:else if data && viewState && lifecycle}` matches
			// NO branch — there is no trailing `{:else}`. An adversarial review measured the result:
			// a 24-character body containing only the back link. The whole detail screen disappears.
			//
			// ⛔ THAT WOULD BE A REGRESSION, NOT A NEW EDGE CASE. `challengeState` is TOTAL (an
			// if-chain ending in an unconditional `return`), so before this module existed the same
			// unknown status still rendered the entire page — just with one grey dot. Turning a
			// cosmetic defect into a blank page is exactly the trade this workstream refuses to make,
			// and it is the same failure class as the keyed-`{#each}` that blanked /governance.
			//
			// Reachable the moment a 4th phase is added BACKEND-FIRST — precisely the rolling-deploy
			// window this module's header cites when it rejects the `weekly_winners` design.
			//
			// The fallback is the OPEN shape, not the closed one: an unrecognised phase is a phase we
			// do not understand, and "still in progress" claims strictly less than "finished". It
			// never yields `not_reached_terminal`, so an unknown status can never assert that
			// something definitively did not happen.
			return { submitted: 'done', voting: 'active', solutionPhase: 'pending', winner: 'pending' };
	}
}

// ---- the words and the classes ------------------------------------------------------------------
// Exhaustive switches in the same file as the decision — the `challenge-state.ts` shape. Every `m.*`
// reference is a STATIC one: paraglide compiles one function per key and tree-shakes on the import
// graph (see challenge-state.ts:150-153), so a dynamically built key would resolve to nothing.

/**
 * The CSS class for a step's `<li>`, and the reason `not_reached_terminal` gets its own word.
 *
 * ⛔ TOTAL AND INJECTIVE. Four states in, four distinct classes out. Collapsing `terminal` into
 * `pending` — the tempting simplification, since neither is teal — resurrects the exact defect this
 * module exists to remove: the terminal step would render in the grey that means "still to come".
 * The unit test asserts injectivity for that reason.
 */
export function lifecycleStepClass(
	s: LifecycleStepState
): 'done' | 'active' | 'pending' | 'terminal' {
	switch (s) {
		case 'done':
			return 'done';
		case 'active':
			return 'active';
		case 'pending':
			return 'pending';
		case 'not_reached_terminal':
			return 'terminal';
	}
}

/**
 * The sub-label under step 4.
 *
 * ⛔ THE TERMINAL SENTENCE MUST NOT SAY "won" OR NAME A WINNING SOLUTION — see
 * `hasShippingSolution`. It says a solution reached production, or that none did. The `'done'`
 * sentence is the same discipline in the positive direction.
 *
 * `'active'` is unreachable for this step under `challengeLifecycle` (step 4 is never the current
 * window) but is handled rather than thrown on: this is a label function, and a future caller adding
 * a fifth arm must get the neutral description, not an exception on a decoration card.
 */
export function lifecycleWinnerSubLabel(s: LifecycleStepState): string {
	switch (s) {
		case 'done':
			return m.challenge_detail_lc_winner_sub_shipped();
		case 'not_reached_terminal':
			return m.challenge_detail_lc_winner_sub_none();
		case 'active':
		case 'pending':
			// The original catalog string: a description of what the step IS, for a step still ahead.
			return m.challenge_detail_lc_winner_sub();
	}
}

/**
 * Whether step 4 ("To production") is drawn at all.
 *
 * ⛔ WITH THE CADENCE OFF THERE ARE NO WINNERS (the cycle neither opens periods nor crowns anyone),
 * so the pending step's sentence — "IT reviews and releases the winning solution" — describes
 * something that cannot happen. It is hidden then, UNLESS a solution already reached production
 * (`done`): that is a fact about `solutions[]`, true whatever the cadence is now.
 */
export function lifecycleShowsWinnerStep(winner: LifecycleStepState, cycleOn: boolean): boolean {
	return cycleOn || winner === 'done';
}

/**
 * The step's state as a WORD, rendered sr-only beside each step.
 *
 * The four states are otherwise communicated by dot colour alone — teal / grey / hollow ring — which
 * is unreadable to a screen reader and ambiguous to a reader who cannot separate the two greys. The
 * span is the non-visual half of the same fact, exactly as the vote note is the on-screen half of
 * `blockedReason` on this page's vote card.
 */
export function lifecycleStateLabel(s: LifecycleStepState): string {
	switch (s) {
		case 'done':
			return m.challenge_lc_state_done();
		case 'active':
			return m.challenge_lc_state_active();
		case 'pending':
			return m.challenge_lc_state_pending();
		case 'not_reached_terminal':
			return m.challenge_lc_state_not_reached();
	}
}
