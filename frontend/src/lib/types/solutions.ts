// src/lib/types/solutions.ts — 1:1 with backend/src/routes/solutions.ts.
import type { ChallengeStatus, Person } from './challenges';
import type { WireChainNode } from '$lib/solutions/flow-chain';

export type SolutionStatus = 'draft' | 'voting' | 'shipping' | 'archived';

export interface SolutionRow {
	id: string;
	rank: number;
	title: string;
	/**
	 * ⛔ THE SOLUTION'S OWN LIFECYCLE — NOT AN ANSWER TO "can I vote on this?". `closeCycle` leaves
	 * every non-winning solution at `'voting'` forever and flips only the winner to `'shipping'`, so
	 * this field stays `'voting'` on solutions whose voting closed months ago. Use `cycleClosed`.
	 */
	status: SolutionStatus;
	challengeId: string;
	/**
	 * The PARENT challenge's status — "does this challenge still accept NEW SOLUTIONS" (the backend's
	 * `challenge_closed` guard on `POST /api/solutions`), and honest context to show beside a row.
	 *
	 * ⛔ NOT THE VOTE GATE. It used to be — the docblock here said it was "the only field that
	 * answers whether a vote will land", because `host/vote-service.ts` joined through to it and
	 * 409'd on `'closed'`. That rule is what kept the marketplace winnerless for nine straight
	 * weeks: a solution filed into the LIVE week, answering an older challenge, was struck unvotable
	 * the moment `healOrphanedChallenges` closed that older parent. `cycleClosed` is the gate now.
	 *
	 * `null` means UNKNOWN, not "open": the row query left-joins `challenges`, which is RLS-scoped,
	 * so an invisible parent yields null rather than dropping the row and renumbering the board.
	 */
	challengeStatus: ChallengeStatus | null;
	/**
	 * ⛔ THE FIELD THAT ANSWERS "will a vote on this row land?" — true when the CYCLE THIS SOLUTION
	 * COMPETES IN has closed, which is exactly the predicate `host/vote-service.ts` throws
	 * `409 voting_closed` on (`weekClosedSql`, host/cycle-eligibility.ts). A property of this row's
	 * own week, not of its parent challenge and not of `status` above.
	 *
	 * Never null from a current backend — the predicate is total. It is typed optional only for the
	 * mid-roll window where an older server answers without it; `solutionState` treats a missing
	 * value as UNKNOWN and blocks, rather than assuming open.
	 */
	cycleClosed: boolean;
	votesCount: number;
	/**
	 * The MEASURED duration of this solution's most recent successful demo run, in MILLISECONDS —
	 * `flow_runs.solution_id` (migration 0065) → `host/solution-demo.ts`. It replaced `demoSeconds`,
	 * which was a seeded constant and NULL for every solution a real person submitted.
	 *
	 * ⛔ `null` MEANS NOBODY HAS RUN IT — test with `!= null`, never truthiness. The board used to
	 * guard this field with `{#if row.demoSeconds}`, which hid a genuine `0` as well as the absence.
	 * Milliseconds and not seconds so the unit stays the browser's decision (`demoDuration` in
	 * lib/utils/format.ts); a server-side round re-creates the /pipeline "AVG TIME TO LIVE —" bug
	 * one order of magnitude down.
	 */
	demoMs: number | null;
	blocksUsed: string[];
	/**
	 * The READER'S names for `blocksUsed`, same length and same order — resolved server-side against
	 * the block catalogue and the reader's locale (backend/src/blocks/block-display-names.ts).
	 *
	 * ⛔ ADDITIVE, NOT A REPLACEMENT, AND `blocksUsed` IS NOT DEPRECATED BY IT. The slugs are what the
	 * board's `?q=` searches and what an older bundle renders; this is the half a Dutch reader can
	 * read. A slug the library no longer holds keeps its slug here rather than vanishing — the number
	 * of blocks a solution was built with is a fact, and silently dropping one understates it.
	 *
	 * ⚠️ OPTIONAL FOR THE MID-ROLL WINDOW ONLY: an older API answers without it, and the render site
	 * falls back to `blocksUsed`, i.e. to exactly what it showed before this change.
	 */
	blocksUsedNames?: string[];
	hasFlow: boolean;
	hasVoted: boolean;
	author: Person;
}

export interface SolutionListChallenge {
	id: string;
	code: string | null;
	title: string;
}

export interface SolutionList {
	items: SolutionRow[];
	total: number;
	page: number;
	pageSize: number;
	challenge: SolutionListChallenge | null;
}

export interface SolutionFlow {
	id: string;
	name: string;
	/**
	 * The flow's BLOCK nodes, in canvas order — `foreach` loop containers filtered out server-side
	 * with the same `kind !== 'foreach'` predicate `resolveExecutableBlocks` uses on the same graph.
	 *
	 * ⚠️ TWO SHAPES ON PURPOSE, FOR ONE RELEASE. A current API sends `{ slug, name }`; an API one
	 * roll behind sends a bare slug string. `$lib/solutions/flow-chain`'s `normalizeChain` is the one
	 * place that reads either, and it is what every render site and every length count goes through.
	 * Narrow this to `ChainNode[]` once no pod can answer with the string form.
	 */
	chain: WireChainNode[];
}

export interface ComparisonBar {
	rank: number;
	id: string;
	author: string;
	votesCount: number;
	pct: number;
	isThis: boolean;
}

export interface SolutionDetail {
	id: string;
	title: string;
	status: SolutionStatus;
	week: string;
	/** The vote gate — see `SolutionRow.cycleClosed`. Both DTOs carry it because both screens render
	 *  a vote pill, and a pill wired to `challenge.status` invites a click the server refuses. */
	cycleClosed: boolean;
	votesCount: number;
	hasVoted: boolean;
	/**
	 * The MEASURED duration of this solution's most recent successful demo run, in MILLISECONDS —
	 * `flow_runs.solution_id` (migration 0065) → `host/solution-demo.ts`. It replaced `demoSeconds`,
	 * which was a seeded constant and NULL for every solution a real person submitted.
	 *
	 * ⛔ `null` MEANS NOBODY HAS RUN IT — test with `!= null`, never truthiness. The board used to
	 * guard this field with `{#if row.demoSeconds}`, which hid a genuine `0` as well as the absence.
	 * Milliseconds and not seconds so the unit stays the browser's decision (`demoDuration` in
	 * lib/utils/format.ts); a server-side round re-creates the /pipeline "AVG TIME TO LIVE —" bug
	 * one order of magnitude down.
	 */
	demoMs: number | null;
	blocksUsed: string[];
	/** The reader's names for `blocksUsed`, same length and order — see `SolutionRow.blocksUsedNames`
	 *  for why it is additive and why it is optional. */
	blocksUsedNames?: string[];
	createdAt: string;
	author: Person;
	/**
	 * The parent challenge. `week` here is the CHALLENGE's cycle week — deliberately not the same
	 * thing as `SolutionDetail.week` above, which is `laterWeek(creationWeek, challenge.week)` at
	 * insert time (backend/src/routes/solutions.ts): the week the SOLUTION competes in, rolled
	 * forward when it answers an older challenge. Substituting one for the other is wrong in exactly
	 * the cases that matter — a solution submitted this week to a challenge from three weeks ago.
	 */
	challenge: {
		id: string;
		code: string | null;
		title: string;
		status: ChallengeStatus;
		week: string;
		/**
		 * "Does this PARENT still accept new solutions?" — `challengeClosedSql`, the same predicate
		 * `POST /api/solutions` refuses on. ⛔ NOT `SolutionDetail.cycleClosed` above, which is about
		 * THIS row's own competing cycle and gates the VOTE; and not `status` beside it, which lags
		 * the cycle by up to a tick. The only thing it decides here is whether "Open in Build" is
		 * allowed to carry `&challenge=` — handing the builder a challenge that will 422 on Submit.
		 * Optional for the same mid-roll reason as `ChallengeRow.cycleClosed`.
		 */
		cycleClosed?: boolean;
	} | null;
	flow: SolutionFlow | null;
	comparison: ComparisonBar[];
}

export interface CreateSolutionInput {
	challenge_id: string;
	title: string;
	flow_id?: string;
	// ⛔ NO `build_time_minutes` / `demo_seconds`. The server schema is `.strict()`, so sending
	// either is a 400. Build time left the product for want of an honest source; demo time is
	// measured from the solution's own runs, never declared by the client.
	blocks_used?: string[];
}
