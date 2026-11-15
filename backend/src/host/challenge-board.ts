// src/host/challenge-board.ts — the ONE definition of "where does this challenge stand on the
// leaderboard", as a ranked subquery that every reader selects FROM.
//
// ⛔ WHY THIS FILE EXISTS — RANK IS A PROPERTY OF THE BOARD, NOT OF THE RESULT SET. Both readers
// used to derive `rank` from the row's position in the RESPONSE: routes/challenges.ts stamped
// `(page-1)*PAGE_SIZE + i + 1` and routes/marketplace-summary.ts's Trending card stamped `i + 1`.
// That is only ever true of one view — the unfiltered `sort=top` first page — and it is a lie
// everywhere else. Measured on the running stack before the fix:
//
//     GET /api/challenges?sort=newest  ->
//      [(rank 1, votes 0,   'Flag high-value claims for faster review'),
//       ...
//       (rank 6, votes 284, 'Auto-summarize claim forms')]
//
// The 0-vote row was served `rank: 1` and the 284-vote leader `rank: 6`, and the browser paints
// `rank === 1` with the gold crown (LeaderboardRow.svelte -> RankBadge.svelte `.top`). So the
// board's own default view (`?open=true`), every `?sort=`, and every `?q=`/`?work_area=` filter
// crowned whichever row happened to sort first. routes/solutions.ts hit the identical defect and
// its header calls the offset form "a LIE"; this is that fix, applied to challenges, and hoisted
// into `host/` because the number appears on TWO screens that link to each other and must not
// disagree about it.
//
// HOW: the window is computed over the UNFILTERED board and the callers filter/sort the ranked
// set from the OUTSIDE. `row_number` rather than `rank` because the ordering is TOTAL (id breaks
// any votes+created_at tie), which also makes limit/offset paging stable — two rows on identical
// votes and timestamps could otherwise swap between the page-1 and page-2 queries and be shown
// twice or not at all.
//
// ⛔ NO `.where()` HERE, EVER, AND NO JOIN THAT CAN DROP A ROW. Anything that narrows this subquery
// does not merely hide a row, it RENUMBERS every row beneath it and the board silently re-ranks
// itself — which is the whole defect above, re-minted one level down. Callers filter outside.
// (RLS is the one exception and it is the correct one: a standing is a standing within the
// tenant's own board, and every caller reads under the same policy.)
import { eq, sql } from 'drizzle-orm';
import { db, challenges, users } from '../db/client';

/** The board's columns, spelled ONCE. The list route reads them off the ranked subquery below and
 *  the detail route reads them off the base tables; a second hand-copied map is how one screen
 *  gains a field and its sibling quietly keeps serving the old shape. */
export const CHALLENGE_COLS = {
  id: challenges.id,
  title: challenges.title,
  description: challenges.description,
  business_impact: challenges.business_impact,
  work_area: challenges.work_area,
  submitter_id: challenges.submitter_id,
  tenant_id: challenges.tenant_id,
  status: challenges.status,
  week: challenges.week,
  period_kind: challenges.period_kind,
  period_start: challenges.period_start,
  metrics: challenges.metrics,
  tags: challenges.tags,
  code: challenges.code,
  votes_count: challenges.votes_count,
  created_at: challenges.created_at,
  updated_at: challenges.updated_at,
  submitterName: users.name,
  submitterInitials: users.avatar_initials,
} as const;

/**
 * The whole board, numbered. Select FROM this and apply the screen's own filters and ordering to
 * the result — `rank` is then the row's true standing however the caller slices it.
 *
 * The `innerJoin(users)` is the submitter, which is `NOT NULL REFERENCES users(id)`, so it drops
 * nothing the callers would have shown anyway (both already joined it for the submitter chip).
 */
export function rankedChallengeBoard() {
  return db
    .select({
      ...CHALLENGE_COLS,
      rank: sql<number>`(row_number() over (order by ${challenges.votes_count} desc, ${challenges.created_at} desc, ${challenges.id} asc))::int`.as(
        'rank',
      ),
    })
    .from(challenges)
    .innerJoin(users, eq(challenges.submitter_id, users.id))
    .as('ranked');
}

/** The subquery's shape, for callers that pass its columns around (ordering helpers, predicates). */
export type RankedChallengeBoard = ReturnType<typeof rankedChallengeBoard>;
