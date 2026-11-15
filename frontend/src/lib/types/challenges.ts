// src/lib/types/challenges.ts — 1:1 with backend/src/routes/challenges.ts.
import type { DatasetColumn } from './datasets';
// Type-only, and deliberately circular with `./solutions` (which imports `ChallengeStatus` from
// here): both sides are erased at compile time, so no runtime cycle exists. The alternative —
// re-declaring the four status literals in this file — is how two copies of an enum drift.
import type { SolutionStatus } from './solutions';

export type ChallengeStatus = 'voting' | 'solution_phase' | 'closed';

// Phase 3.0: a dataset the creator marked as applicable to a challenge.
export interface ChallengeDatasetRef {
	slug: string;
	name: string;
	columns: DatasetColumn[];
	rowCount: number;
	note: string;
	/** W8/P7 — see `DatasetRow.maskedColumns`. Optional for a rolling deploy. */
	maskedColumns?: string[];
}

/** W8 "Information involved": one type of information a challenge is about. `id` is sent back by
 *  the picker and never shown; `label`/`description` arrive localized. */
export interface InformationCard {
	id: string;
	label: string;
	description: string | null;
	/** True when the creator linked it directly (editable); false when it comes from the sample
	 *  data. Optional: the P1 backend did not send it. */
	linked?: boolean;
}

/** One choice in the "Information involved" picker. */
export interface InformationOption {
	id: string;
	label: string;
	description: string | null;
	synonyms: string[];
}

/** GET /api/challenges/:id/entities */
export interface ChallengeInformation {
	items: InformationCard[];
	/** The reader may change the links (the challenge's creator, or a super_admin). */
	canEdit: boolean;
}

// Phase 3.0: one dataset link in a create/update payload.
export interface ChallengeDatasetInput {
	slug: string;
	note?: string;
}
export type ChallengeSort = 'top' | 'newest' | 'trending' | 'closing';

export interface Person {
	name: string;
	initials: string;
}

export interface ChallengeMetrics {
	timeSavedPerWeek?: string;
	affectedStaff?: string;
	backlogReduction?: string;
}

/**
 * "Is this challenge's cycle over?" — `challengeClosedSql` (backend/src/host/cycle-eligibility.ts),
 * the SAME predicate `POST /api/solutions` refuses `422 challenge_closed` on and the same one the
 * list route's `?open=true` filter is built from.
 *
 * ⛔ NOT A RESTATEMENT OF `status`, and the screens must render THIS one. `status` is what the
 * engine last got round to writing; this is whether the cycle the challenge competes in is over.
 * They disagree for up to a full tick — prod's CH-284 sat at `status='voting'` for eight hours
 * after its `2026-W23` cycle had been dead since June, and a solution was filed against it in
 * that gap and stamped with the CURRENT week.
 *
 * ⚠️ OPTIONAL, and `$lib/challenges/challenge-state.ts` treats absent as "ask the clock instead"
 * rather than as `false`. A server mid-roll, a partial fixture or a hand-built object legitimately
 * omits it; defaulting it to `false` at the boundary would make "absent" and "open" the same value
 * and re-offer the button this field exists to withdraw.
 */
type CycleClosedFlag = boolean;

export interface ChallengeRow {
	id: string;
	code: string | null;
	title: string;
	workArea: string;
	status: ChallengeStatus;
	week: string;
	/** See `CycleClosedFlag`. */
	cycleClosed?: CycleClosedFlag;
	tags: string[];
	votesCount: number;
	rank: number;
	hasVoted: boolean;
	solutionsCount: number;
	submitter: Person;
	createdAt: string;
}

export interface ChallengeList {
	items: ChallengeRow[];
	total: number;
	page: number;
	pageSize: number;
	counts: Record<string, number>;
	sort: ChallengeSort;
}

export interface ChallengeSolutionRef {
	id: string;
	title: string;
	/**
	 * The solution's OWN lifecycle column, straight off `backend/src/routes/challenges.ts:495`.
	 *
	 * ⛔ WAS `string`, WHICH IS WHY IT MATTERS. `$lib/challenges/challenge-lifecycle.ts` decides the
	 * final step of the challenge timeline on `status === 'shipping'`; against a bare `string` tsc
	 * cannot tell that comparison from a typo, so a rename on the backend enum would have shipped a
	 * permanently-false predicate and a permanently-grey step with a green build.
	 *
	 * ⛔ AND IT IS NOT A VOTING SIGNAL — see `$lib/solutions/solution-state.ts:22-24`: `closeCycle`
	 * flips only the winner to `'shipping'` and leaves every loser at `'voting'` forever. The only
	 * question it answers is `hasShippingSolution`'s: did a solution reach production.
	 */
	status: SolutionStatus;
	votesCount: number;
	rank: number;
	// ⛔ NO demo figure. `demoSeconds` used to be here and the challenge page has never rendered
	// one — dead payload on both sides of the wire. It is deliberately NOT reinstated as `demoMs`:
	// that costs an extra query per page, and adding it to feed a field no screen reads is how the
	// dead field got here. If this page ever wants it, add the backend lookup and the markup in
	// the same change.
	blocksUsed: string[];
	hasVoted: boolean;
	author: Person;
}

export interface SimilarChallenge {
	id: string;
	title: string;
	workArea: string;
	votesCount: number;
}

export interface ChallengeDetail {
	id: string;
	code: string | null;
	title: string;
	description: string;
	businessImpact: string;
	workArea: string;
	status: ChallengeStatus;
	week: string;
	/** See `CycleClosedFlag`. This is the page where "Build a solution" lives, so this is the field
	 *  that decides whether that link is an invitation or a 422 waiting to happen. */
	cycleClosed?: CycleClosedFlag;
	tags: string[];
	metrics: ChallengeMetrics;
	votesCount: number;
	hasVoted: boolean;
	submitter: Person;
	createdAt: string;
	commentCount: number;
	datasets: ChallengeDatasetRef[];
	canEditDatasets: boolean;
	involves: string[];
	solutions: ChallengeSolutionRef[];
	similar: SimilarChallenge[];
}

export interface CommentItem {
	id: string;
	body: string;
	createdAt: string;
	author: Person;
}

export interface CommentList {
	items: CommentItem[];
	total: number;
}

export interface VoteResult {
	voted: boolean;
	count: number;
}

export interface CreateChallengeInput {
	title: string;
	description: string;
	business_impact?: string;
	work_area: string;
	metrics?: ChallengeMetrics;
	tags?: string[];
	datasets?: ChallengeDatasetInput[];
	/** W8/P2: the types of information (ids from the picker) this challenge is about. */
	entities?: string[];
}

// Phase 3.0: PATCH /api/challenges/:id response.
export interface UpdateChallengeDatasetsResult {
	datasets: ChallengeDatasetRef[];
	canEditDatasets: boolean;
}
