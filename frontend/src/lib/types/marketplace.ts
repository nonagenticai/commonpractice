// src/lib/types/marketplace.ts — Home summary + weekly winner
// (backend/src/routes/marketplace-summary.ts).
import type { ChallengeRow, Person } from './challenges';
import type { CadenceInfo, CycleState } from './cycle';

export interface HomeStats {
	activeChallenges: number;
	solutionsInVoting: number;
	activeBuilders: number;
	liveInProduction: number;
}

export interface ActivityChallenge {
	id: string;
	code: string | null;
	title: string;
	votesCount: number;
	status?: string;
}

export interface HomeSummary {
	stats: HomeStats;
	trending: ChallengeRow[];
	// the live weekly cycle (Phase 2-E); null when the engine has not opened a week.
	cycle: CycleState | null;
	/** The voting-cycle cadence (0107). Absent from an older backend: treat as the weekly cycle. */
	cadence?: CadenceInfo;
	// ⚠️ Both lists are LIMITed page slices (submitted 5, votedOn 8) — `.length` is a PAGE SIZE,
	// never a count. Render `submittedTotal` / `votedOnTotal` for anything the reader will read as
	// "how many". Home told every heavy voter "You voted on (8)" for exactly that reason.
	yourActivity: {
		submitted: ActivityChallenge[];
		submittedTotal: number;
		votedOn: ActivityChallenge[];
		votedOnTotal: number;
	};
}

export interface WinnerSolution {
	id: string;
	title: string;
	votesCount: number;
	/**
	 * The MEASURED duration of the winner's most recent successful demo run, in MILLISECONDS, or
	 * `null` when nobody has run it. See `SolutionRow.demoMs` in types/solutions.ts.
	 *
	 * ⛔ The hero tile is CONDITIONAL on `!= null` — this page's doctrine (see the `hasNumbers`
	 * note on /winner) is that a genuine 0 is data and only absence is absence, so an unknown
	 * figure is a tile that is not rendered, never a rendered '—'.
	 *
	 * It replaced two fields: `demoSeconds`, a seeded constant this payload shipped and /winner
	 * never read, and `buildTimeMinutes`, which WAS the '—' in the hero and is gone from the
	 * product entirely.
	 */
	demoMs: number | null;
	blocksUsed: string[];
	flowId: string | null;
	author: Person;
}

export interface HonorableMention {
	rank: number;
	id: string;
	title: string;
	votesCount: number;
	blocksUsed: string[];
	author: Person;
}

export interface PipelineTimeline {
	stage: 'review' | 'hardening' | 'staging' | 'production';
	rolloutPct: number;
	live: boolean;
	progress: { day?: number; ofDays?: number } | null;
	steps: { key: string; label: string; state: 'done' | 'active' | '' }[];
}

export interface WeeklyWinner {
	// null when no winner has been announced yet (valid empty state, not an error).
	week: string | null;
	announcedAt: string | null;
	/**
	 * ⛔ EXACTLY THE TWO FIGURES THE PRODUCT CAN COMPUTE, AND NO MORE.
	 *
	 * `weekSolutionStats` (backend/src/host/cycle-eligibility.ts) emits `{solutionsSubmitted,
	 * totalVotesCast}` — that is the whole aggregate `closeCycle` stamps into `weekly_winners.stats`
	 * and the whole aggregate `/api/winner` recomputes with.
	 *
	 * `firstTimeBuilders` and `crossDomain` USED TO BE DECLARED HERE and rendered beside those two,
	 * in the same list, in the same typography. Nothing in this codebase can produce either one —
	 * there is no first-time flag on a solution and no cross-domain relation — and migration
	 * `0064_reconcile_vote_counts.sql:184-191` says so in as many words. The only writer they ever
	 * had is the two seeders' `fabricate` branch, so on any non-production database `/winner` showed
	 * "Nieuwe bouwers 9" and "Domeinoverstijgende oplossingen 11" as measurements. Measured on the
	 * running app 2026-08-15, on the payoff screen of the whole product.
	 *
	 * ⚠️ THEY STILL EXIST IN THE DATABASE AND IN THE BACKEND TYPE, ON PURPOSE. Their presence in a
	 * `weekly_winners.stats` row is the ONLY marker distinguishing a seeder artifact from a
	 * close-written one — it is the entire predicate of migration 0064 step 3
	 * (`jsonb_exists(stats,'firstTimeBuilders') OR jsonb_exists(stats,'crossDomain')`). Deleting
	 * them from the seeders would leave fabricated totals byte-indistinguishable from real ones and
	 * make a future reconciliation impossible. They are dropped from the WIRE-FACING type instead,
	 * which is the narrow thing that was actually wrong: the browser must not be able to render a
	 * figure the product cannot defend.
	 */
	stats: {
		totalVotesCast?: number;
		solutionsSubmitted?: number;
	};
	pipeline: PipelineTimeline | null;
	winner: {
		/**
		 * The winner's 1-based position in ITS OWN week's ordered candidate set (votes desc,
		 * created_at asc, id asc — the ordering `closeCycle` crowned it with), or `null` when it
		 * has no position at all.
		 *
		 * ⛔ IT IS NOT ALWAYS 1, AND THE PAGE MUST NOT ASSUME IT IS. Two of the three winner
		 * sources in `/api/winner` are vote-INDEPENDENT (the top `shipping` solution; a live
		 * pipeline card ordered by featured/live_at), and an announced winner keeps accruing votes
		 * after its cycle closes. Prod rendered a 2-vote winner directly above a 233-vote "#2".
		 *
		 * `null` means "no position on this leaderboard" — a winner derived from a solution that
		 * never competed in the announced week — NOT "rank unknown, probably 1". Render nothing
		 * extra for it, exactly as `demoMs: null` renders no tile.
		 */
		rank: number | null;
		solution: WinnerSolution;
		challenge: { id: string; code: string | null; title: string; submitter: string } | null;
	} | null;
	honorableMentions: HonorableMention[];
}
