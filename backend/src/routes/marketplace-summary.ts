// src/routes/marketplace-summary.ts — the employee Home dashboard aggregate and the
// weekly-winner screen. Employee Discover surfaces → validateAuth only.
//
// HONEST stats: activeChallenges / solutionsInVoting / liveInProduction / activeBuilders
// are all REAL counts over the seeded + live marketplace rows. The demo's headline
// "312 active builders" is inflated; we return the genuine distinct-builder count and
// label it real — we do not fabricate (same posture as the S4 Ops "312").
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, not, or, sql } from 'drizzle-orm';
import { db, challenges, solutions, votes, weeklyWinners, pipelineItems, users } from '../db/client';
import { validateAuth } from '../middleware/auth';
import { peekEffectiveTenant } from '../middleware/tenant';
import { jsonResponse, route } from '../utils/http';
import { getTranslationsBatch } from '../db/translations';
import { negotiateLocale } from '../utils/locale';
import { votedTargetIds } from '../host/vote-service';
import { solutionTimeline } from '../host/pipeline-service';
// The MEASURED demo duration for the hero's demo-time tile. It replaced `solutions.demo_seconds`,
// a seeded constant this payload shipped and /winner never rendered.
import { demoMsForSolutions } from '../host/solution-demo';
import { readCurrentCycle } from '../host/cycle-service';
// The SHARED candidate set / ranking / week aggregate — the same three things `closeCycle`
// selects the winner with. This file used to re-implement the mentions query with none of
// them; see host/cycle-eligibility.ts for what that cost on the live page.
import { eligibleForPeriod, WINNER_ORDER, periodClosedSql, periodSolutionStats, SOLUTION_PERIOD } from '../host/cycle-eligibility';
import { gateOf, requestTenantId, resolveCadence } from '../host/cycle-cadence';
// The SHARED board ranking — Trending's `rank` must be the number /challenges puts on the same
// row, and it was this card's own offset into its own five-row slice. See the module header.
import { rankedChallengeBoard } from '../host/challenge-board';
import type { WeeklyWinnerStats } from '../db/schema';
import type { Router } from '../utils/router';

const TOTAL_OVER = sql<number>`(count(*) over ())::int`;

function initialsOf(name: string, stored?: string | null): string {
  if (stored) return stored;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

async function scalar(q: Promise<{ n: number }[]>): Promise<number> {
  const rows = await q;
  return rows[0]?.n ?? 0;
}

// GET /api/home/summary — stat cards + trending + the caller's own activity.
const homeSummary = route(async (req) => {
  const user = await validateAuth(req);
  // §5B UGC overlay. This route serves the Trending card and "your activity", both of which
  // list the SAME challenge rows /challenges lists — and /challenges has overlaid its titles
  // from `content_translations` since §5B shipped. This one did not, so a Dutch reader saw the
  // Dutch title on /challenges and the English original in Trending, one click apart.
  const locale = negotiateLocale(req);
  // The cycle cadence at this instant (host/cycle-cadence.ts): drives the vote gate below and is put
  // on the wire so the home screen can hide the cadence strip when the cycle is off.
  // 0110: the caller's tenant's cadence and cycle (cycles are per tenant).
  const cadence = await resolveCadence(new Date(), requestTenantId());

  // ⚠️ `challenges.status <> 'closed'` LOOKS like the defect below and is NOT — but reason 1 that
  //   used to justify that is DEAD. Left deliberately, corrected in place.
  //   1. ⛔ RETRACTED. This used to claim the column has an OFF-RAMP: `closeCycle` closing every
  //      non-closed challenge of the week it closes, and `healOrphanedChallenges` sweeping up the
  //      weeks that were never opened. PR #348 deleted `closeCycle`'s challenge sweep
  //      (cycle-service.ts:201-214, "THE CHALLENGE SWEEP WAS REMOVED HERE — DO NOT PUT IT BACK") and
  //      `healOrphanedChallenges` now advances a stranded row to `solution_phase`, never `closed`
  //      (cycle-service.ts:601-609, "HEALS FORWARD TO `solution_phase` — IT MUST NOT CLOSE"). No
  //      writer sets `challenges.status = 'closed'` anywhere in this product any more, and there is
  //      no user-facing close path. `activeChallenges` is therefore exactly the monotone-growing
  //      number this predicate was written to avoid: it counts every challenge ever authored and can
  //      only go up. Whether that is still the right thing for this card to count is a product
  //      decision nobody has made yet — fixing the predicate without that decision would just trade
  //      one unreviewed number for another, so it is left as-is and named here instead.
  //   2. The card must agree with the surface it is a count OF, and this still constrains any future
  //      fix: `weekClosedSql` here would disagree with the Trending list built from
  //      `ne(status,'closed')` in THIS SAME payload, thirty lines down — the same "two numbers, one
  //      click apart" defect, freshly minted. Any predicate this card adopts next must keep agreeing
  //      with that list, whatever it ends up counting.
  //   ⚠️ AN EARLIER REVISION LISTED A THIRD REASON AND IT WAS FALSE — RETRACTED, do not restore it.
  //      It claimed that in the Monday 00:00-03:00 window (cycle-eligibility.ts, point 4) a
  //      `weekClosedSql` count "would contradict the engine by answering closed". It would not:
  //      that window is precisely where `weekClosedSql` answers OPEN (the row exists and is not yet
  //      `phase='closed'`, so neither arm fires — point 4 is written to say exactly that). The
  //      window is an argument for the helper, never against it. Reason 2 carries this decision on
  //      its own now that reason 1 is gone.
  const activeChallenges = await scalar(
    db.select({ n: sql<number>`count(*)::int` }).from(challenges).where(ne(challenges.status, 'closed')),
  );
  // ⛔ "SOLUTIONS IN VOTING" IS A PROPERTY OF THE CYCLE, NEVER OF `solutions.status`. This card is
  // labelled "being judged now" and links to /solutions, and it used to be
  // `eq(solutions.status,'voting')` — no week, no cycle, no recency. That number can only GROW:
  //
  //   ⚠️ NOTHING IN THIS PRODUCT DEMOTES A LOSER. Every writer of the column, exhaustively:
  //   cycle-service.ts:116 (draft→voting), :314 (shipping→voting, dethroning a displaced winner on
  //   force-close), :327 (winner→shipping); routes/solutions.ts:433 (insert at 'voting');
  //   routes/pipeline.ts:397 (→shipping), :399/:524 (→voting on rollback); the two seeds. There is
  //   no transition OUT of 'voting' except winning. `closeCycle` leaves every loser there forever
  //   (host/vote-service.ts:62-63 says so in prose), so the count accumulated every solution ever
  //   filed and the home page announced the back catalogue as "being judged now".
  //
  //   ⚠️ AND THE ENUM EXPLAINS WHY THERE IS NO OFF-RAMP. `solution_status` has four values
  //   (schema.ts:676-681) and only TWO are ever written: `'draft'` and `'archived'` appear nowhere
  //   in the repo as a value assigned to a solution — the `draft`/`archived` hits elsewhere belong
  //   to the unrelated `block_status` / `flow_status` enums. So `cycle-service.ts:116`'s
  //   `draft → voting` sweep can never match a row, and no code path can ever reach a terminal
  //   state. Named, not deleted: the dead values are the evidence for this predicate.
  //
  // `weekClosedSql` is the SAME gate `host/vote-service.ts` 409s on and the SAME one /solutions
  // puts on the wire as `cycleClosed`, so this number is exactly "the rows /solutions renders with
  // a LIVE vote pill" — which is what "being judged now" promises. THAT cross-screen agreement is
  // by construction rather than by coincidence, and it is the only agreement being claimed.
  //
  //   ⚠️ IT IS NOT A CLAIM THAT THIS PAYLOAD IS INTERNALLY CLEAN. IT IS NOT. One row can be counted
  //   by BOTH `solutionsInVoting` and `liveInProduction` in a single GET /api/home/summary, so the
  //   same solution is announced as "being judged now" AND as "winners shipped"
  //   (frontend/messages/en.json:109-114) at once. Reproduced, not theorised — cycle row
  //   `phase='voting'` for week W, a solution at `week=W, status='shipping'`, and a
  //   `pipeline_items` row `stage='production', live=true` linked to it moves both cards 0 → 1.
  //   Under the old `eq(status,'voting')` predicate that row appeared only in the second card, so
  //   this change is what surfaces the overlap.
  //
  //   ⛔ IT IS REACHABLE THROUGH THE PRODUCT, so do not read it as a fixture artefact.
  //   `routes/pipeline.ts:397` stamps `status:'shipping'` on entering Production and never touches
  //   the cycle, so an operator promoting a CURRENT-week solution lands there directly. (`closeCycle`
  //   cannot produce it — it crowns and closes in one transaction.) `marketplace-summary.test.ts`
  //   pins the overlap so it stays a KNOWN, chosen state rather than a surprise in a bug report.
  //
  //   ⚠️ NOT A BLOCKER, AND THE COUNT IS STILL RIGHT RELATIVE TO THE VOTE GATE. /solutions renders a
  //   LIVE pill on that row too (`solutionState` yields `kind:'shipping'` with `votability:'open'`,
  //   and `solutionVoteBlockedReason` switches on `votability` ALONE — status is explicitly not a
  //   signal), and `vote-service` would accept a vote on it. So home agrees with the board and
  //   disagrees with itself, narrowly. Fixing it means deciding which card owns a shipped-but-still-
  //   votable row — a product question, not a predicate question, and NOT a reason to widen or
  //   weaken the gate below.
  //
  // ⛔ IN `.where()`, AND THE HELPER'S QUALIFIED SPELLING STAYS. This is a single-table `count(*)`
  // over `solutions` with NO join — precisely the `isSingleTable` shape where drizzle rewrites a
  // bare column chunk to an unqualified identifier and the gate silently degrades to "is ANY week
  // closed" (cycle-eligibility.ts:143-171, measured, not theorised). Do not "simplify" it.
  // Same shape as `healOrphanedChallenges`' `stranded` read (cycle-service.ts:575-583) — a
  // single-table `.where()` over `solutions` that already ships this exact spelling. Verified on
  // THIS query, not assumed: the compiled SQL reads `"solutions"."week"`, not a bare `"week"`.
  //
  // ⚠️ COST, MEASURED (postgres 18.4, EXPLAIN ANALYZE, inside a rolled-back transaction, 60 cycle
  // rows of which 59 closed). STATEMENT COUNT IS UNCHANGED — this is the same single `count(*)`,
  // not an extra round-trip on a route that holds a reserved connection out of DB_POOL_MAX=6.
  // Planner hashes both correlated subqueries once (`loops=1` on each marketplace_cycles scan), so
  // the per-row cost is a hash probe, not a scan:
  //     solutions rows |    old |    new
  //              1 000 | 0.09ms | 0.19ms
  //             20 000 | 1.5 ms | 9.3 ms
  //            200 000 | 17.7ms | 99.0ms
  // ≈0.5µs/row, linear. Immaterial at this product's scale (an internal marketplace; the seeded
  // set is 5 rows and prod is in the hundreds) — well under 1ms, against a ~14-statement request.
  // ⛔ IF `solutions` EVER PASSES ~50k ROWS, DO NOT "OPTIMISE" THIS BY WEAKENING THE PREDICATE.
  // The fix is an index: there is NO index on `solutions.week` today (only id/author/challenge/
  // status/tenant). Add one and rewrite to a semi-join against the OPEN weeks — the non-closed
  // cycle set is normally a single row — rather than trading correctness back for latency.
  //
  // `week = ''` (the pre-0047 `text NOT NULL DEFAULT ''` legacy value) is handled and excluded:
  // it sorts below every real week and has no cycle row, so the predicate's second arm fires and
  // calls it closed. Correct — such a row was never filed into a cycle and can never be judged.
  const solutionsInVoting = await scalar(
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(solutions)
      .where(not(periodClosedSql(SOLUTION_PERIOD, gateOf(cadence)))),
  );
  // Real "live in production" = pipeline cards actually live in the Production stage
  // (Phase 2-E) — was a weekly_winners proxy. Falls to 0 cleanly when none are live.
  //
  // Scoped to the CALLER'S tenant. `pipeline_items` is deliberately outside RLS (0028: the Operate
  // pipeline is a super_admin cross-tenant surface, and giving it a tenant_id would be a much larger
  // change to that whole surface), so counting the table directly put the PLATFORM-WIDE total on
  // every tenant's home dashboard. The per-tenant cycle close made that worse rather than better —
  // it lands one card per tenant per week instead of one per week, so the leaked figure now grows
  // N× faster. Two attribution paths, because a card can be owned two ways:
  //   • it links a solution → the left join is RLS-scoped, so a non-null match means it is ours;
  //   • it links no solution (seeded/manually-created Operate cards, and solution_id is ON DELETE
  //     SET NULL) → fall back to the AUTHOR's home tenant. That column can lag a user's real tenant,
  //     which is why it is the fallback and is only consulted when there is no solution to ask.
  // A card with neither belongs to no tenant and is counted for nobody.
  const callerTenantId = await peekEffectiveTenant(req);
  const liveInProduction = !callerTenantId
    ? 0
    : await scalar(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(pipelineItems)
          .leftJoin(solutions, eq(pipelineItems.solution_id, solutions.id))
          .leftJoin(users, eq(pipelineItems.author_id, users.id))
          .where(
            and(
              eq(pipelineItems.stage, 'production'),
              eq(pipelineItems.live, true),
              or(
                isNotNull(solutions.id),
                and(isNull(pipelineItems.solution_id), eq(users.tenant_id, callerTenantId)),
              ),
            ),
          ),
      );
  // Genuine distinct builders = anyone who has authored a challenge or a solution.
  const builderRows = (await db.execute(
    sql`select count(*)::int as n from (select submitter_id as b from challenges union select author_id as b from solutions) t`,
  )) as unknown as { n: number }[];
  const activeBuilders = builderRows[0]?.n ?? 0;

  // Trending: top-5 non-closed challenges by votes.
  //
  // ⛔ THE RANK IS THE BOARD'S, NOT THIS CARD'S OFFSET. The `rank` field below used to be `i + 1`
  // over these five rows — the same defect routes/challenges.ts shipped, one screen along. This
  // card filters `status <> 'closed'` and shows five rows, so the row sitting at position 2 here is
  // routinely NOT the board's #2, and the card links straight to the board that says otherwise.
  // The window comes from host/challenge-board.ts (the UNFILTERED board) and the `closed` filter is
  // applied OUTSIDE it, so both screens quote one number. Same reason `title` is overlaid from the
  // same batch the list route uses: this card must not disagree with the list it links to.
  //
  // Ordering by the rank rather than by `votes_count` alone also makes the top-5 DETERMINISTIC —
  // the window's tie-break is total (votes, created_at, id), where a bare `desc(votes_count)` let
  // tied rows swap places between two renders of the same page.
  const board = rankedChallengeBoard();
  const trendingRows = await db
    .select({
      id: board.id,
      code: board.code,
      title: board.title,
      work_area: board.work_area,
      status: board.status,
      week: board.week,
      tags: board.tags,
      votes_count: board.votes_count,
      created_at: board.created_at,
      submitterName: board.submitterName,
      submitterInitials: board.submitterInitials,
      rank: board.rank,
    })
    .from(board)
    .where(ne(board.status, 'closed'))
    .orderBy(asc(board.rank))
    .limit(5);

  const trendingIds = trendingRows.map((r) => r.id);
  const trendingVoted = await votedTargetIds(user.id, 'challenge', trendingIds);
  const solCountRows = trendingIds.length
    ? await db
        .select({ challenge_id: solutions.challenge_id, n: sql<number>`count(*)::int` })
        .from(solutions)
        .where(inArray(solutions.challenge_id, trendingIds))
        .groupBy(solutions.challenge_id)
    : [];
  const solCounts = new Map(solCountRows.map((r) => [r.challenge_id, r.n]));

  // Your activity: challenges the caller submitted + challenges they voted on.
  const submitted = await db
    .select({ id: challenges.id, code: challenges.code, title: challenges.title, votes_count: challenges.votes_count, status: challenges.status, total: TOTAL_OVER })
    .from(challenges)
    .where(eq(challenges.submitter_id, user.id))
    .orderBy(desc(challenges.created_at))
    .limit(5);

  const votedOn = await db
    .select({ id: challenges.id, code: challenges.code, title: challenges.title, votes_count: challenges.votes_count, total: TOTAL_OVER })
    .from(votes)
    .innerJoin(challenges, eq(votes.target_id, challenges.id))
    .where(and(eq(votes.user_id, user.id), eq(votes.target_type, 'challenge')))
    .orderBy(desc(votes.created_at))
    .limit(8);

  // The REAL totals behind those two LIMITed slices, at ZERO extra round-trips. Home renders
  // "You voted on (n)" and the page size was standing in for the count, so a user who had voted
  // on 30 challenges was told 8 — forever, on the product's first screen. Both totals ship
  // together even though only votedOn renders a number today: an asymmetric DTO is an invitation
  // to render `submitted.length` as a count in the sibling block and re-create exactly this bug.
  //
  // ⛔ `?? 0` IS LOAD-BEARING — DO NOT DROP IT. With zero matching rows the query returns NO ROWS
  // AT ALL, so there is no window value to read: `rows[0]?.total` is `undefined`, and `undefined`
  // does not survive JSON.stringify — the KEY DISAPPEARS from the payload. That is byte-for-byte
  // the stale-payload shape an OLD backend produces, and the frontend would render "You voted on
  // (undefined)". tests/marketplace-summary.test.ts pins N=0 by asserting the key's PRESENCE, not
  // just its value, because `toBe(0)` alone cannot tell 0 from a dropped key.
  //
  // ⛔ WHY A WINDOW AND NOT TWO COUNT QUERIES. `/api/home/summary` runs on a RESERVED connection
  // held for the WHOLE request (db/client.ts withTenantDb) out of DB_POOL_MAX=6 (config.ts), and
  // it is the landing route. Two extra sequential statements on a ~14-statement request is ~15%
  // more reserved-connection hold time on the hottest path in the product, and CP has had two
  // production pool exhaustions. The header note below already reasons about not issuing extra
  // queries for the same rows; this applies that same standard to the totals.
  //
  // ⛔ WHY THIS IS STILL ORPHAN-SAFE. `votes.target_id` is a LOOSE UUID with NO FOREIGN KEY
  // (db/schema.ts: "points at challenges OR solutions per target_type"), so nothing deletes a
  // vote when its challenge is deleted, and a bare `count(*) from votes` reports MORE challenges
  // than the list can ever contain. `count(*) over ()` needs no such caveat: the window is
  // evaluated AFTER WHERE/JOIN and BEFORE LIMIT, on the very rows the slice is drawn from, so it
  // inherits the anti-orphan innerJoin by construction rather than by a copied predicate that can
  // drift. The orphaned-vote fixture in tests/ pins that (8 shown, 11 total, never 12).
  const submittedTotal = submitted[0]?.total ?? 0;
  const votedOnTotal = votedOn[0]?.total ?? 0;

  // ONE batched overlay over the DEDUPED union of every challenge id this payload mentions —
  // the three lists overlap heavily (a trending challenge is usually one you voted on), and
  // three separate batches would issue three queries for the same rows.
  //
  // `title` ONLY, deliberately: routes/challenges.ts overlays exactly `['title']`, and home's
  // Trending card must not disagree with the list it links to. Widening the field set here
  // without widening it there would just relocate the inconsistency.
  const challengeIds = [
    ...new Set([...trendingRows.map((r) => r.id), ...submitted.map((r) => r.id), ...votedOn.map((r) => r.id)]),
  ];
  const chTx = await getTranslationsBatch('challenge', challengeIds, locale, ['title']);
  const localTitle = (id: string, base: string) => chTx.get(id)?.title ?? base;

  const trending = trendingRows.map((r) => ({
    id: r.id,
    code: r.code,
    title: localTitle(r.id, r.title),
    workArea: r.work_area,
    status: r.status,
    week: r.week,
    tags: r.tags,
    votesCount: r.votes_count,
    // The board rank, NOT this card's offset — see the note on the query above.
    rank: r.rank,
    hasVoted: trendingVoted.has(r.id),
    solutionsCount: solCounts.get(r.id) ?? 0,
    submitter: { name: r.submitterName, initials: initialsOf(r.submitterName, r.submitterInitials) },
    createdAt: r.created_at,
  }));

  // The live weekly cycle (Phase 2-E) — null when the engine has not opened a week, so
  // the cadence strip falls back to its static rhythm. READ-ONLY (a GET never opens one).
  const cycle = await readCurrentCycle(new Date(), requestTenantId());

  return jsonResponse({
    stats: { activeChallenges, solutionsInVoting, activeBuilders, liveInProduction },
    trending,
    // The voting cycle cadence: `effective` governs the screens (off hides winners and the cadence
    // strip), `setting` is what the NEXT period will be once the running one closes.
    cadence: { setting: cadence.setting, effective: cadence.effective },
    cycle: cycle
      ? {
          week: cycle.week,
          periodKind: cycle.period_kind,
          periodKey: cycle.period_key,
          periodStart: cycle.period_start,
          phase: cycle.phase,
          votingEndsAt: cycle.voting_ends_at,
          solutionEndsAt: cycle.solution_ends_at,
          closesAt: cycle.closes_at,
        }
      : null,
    yourActivity: {
      submitted: submitted.map((c) => ({ id: c.id, code: c.code, title: localTitle(c.id, c.title), votesCount: c.votes_count, status: c.status })),
      submittedTotal,
      votedOn: votedOn.map((c) => ({ id: c.id, code: c.code, title: localTitle(c.id, c.title), votesCount: c.votes_count })),
      votedOnTotal,
    },
  });
});

/** Load a candidate winner solution under the CALLER's RLS. undefined = not theirs to read. */
async function loadWinnerSolution(id: string) {
  const [row] = await db
    .select({
      id: solutions.id,
      challenge_id: solutions.challenge_id,
      title: solutions.title,
      // The solution's OWN week. On both fallback paths (no weekly_winners artifact) this is
      // the only thing that knows which week is being announced — and the eyebrow and the
      // honourable-mentions predicate must describe the SAME week or the page contradicts
      // itself in two places at once.
      week: solutions.week,
      votes_count: solutions.votes_count,
      blocks_used: solutions.blocks_used,
      flow_id: solutions.flow_id,
      authorName: users.name,
      authorInitials: users.avatar_initials,
    })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(eq(solutions.id, id));
  return row;
}

/**
 * The solution's 1-based position in ITS OWN week's ordered candidate set, or `null` when it is
 * not in that set at all.
 *
 * Only reached when the winner fell below `/api/winner`'s bounded candidate fetch: "not in the
 * slice we read" is NOT the same fact as "not competing", and the page must not print the second
 * when it has only measured the first.
 *
 * Rank = 1 + the number of eligible rows that STRICTLY PRECEDE it under `WINNER_ORDER`
 * (votes desc, created_at asc, id asc). Spelled as a predicate here because `WINNER_ORDER` is an
 * ORDER BY and cannot be one — but it is the same three keys in the same precedence, and
 * host/cycle-eligibility.ts is where both change together.
 */
async function rankWithinWeek(id: string, week: string, tenantId: string | null): Promise<number | null> {
  // Eligibility FIRST: a winner outside the week's candidate set has no rank, and asking "how
  // many rows precede it" of a row that is not in the race would answer with a plausible number.
  const [self] = await db
    .select({ id: solutions.id, votes_count: solutions.votes_count, created_at: solutions.created_at })
    .from(solutions)
    .where(and(eq(solutions.id, id), eligibleForPeriod(week, tenantId)));
  if (!self) return null;
  const [ahead] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(solutions)
    .where(
      and(
        eligibleForPeriod(week, tenantId),
        or(
          gt(solutions.votes_count, self.votes_count),
          and(eq(solutions.votes_count, self.votes_count), lt(solutions.created_at, self.created_at)),
          and(eq(solutions.votes_count, self.votes_count), eq(solutions.created_at, self.created_at), lt(solutions.id, self.id)),
        ),
      ),
    );
  return (ahead?.n ?? 0) + 1;
}

// GET /api/winner — the latest weekly winner + honorable mentions + week stats.
const getWinner = route(async (req) => {
  await validateAuth(req);
  // §5B UGC overlay — same reason as home above. The winning solution and its challenge are
  // the same rows /solutions and /challenges already localize; this page showed the English
  // originals for both.
  const locale = negotiateLocale(req);
  // Belt AND braces on the artifact read specifically. Its sibling reads in this file lean on RLS
  // alone (0028's explicit design: "RLS scopes the existing predicate-less queries with no route
  // changes"), and that stays true for them — but this one is different in kind: picking up ANOTHER
  // tenant's row here does not merely show a spare row, it SUPPRESSES the caller's own winner, which
  // is precisely the bug that blanked the page. `peekEffectiveTenant` is the same value the server
  // wrapper set the GUC from (claim, or a super_admin's validated X-Active-Tenant-Id), so the two
  // agree; null (no derivable tenant) skips the artifact and falls through, fail-closed.
  const callerTenantId = await peekEffectiveTenant(req);
  const [w] = callerTenantId
    ? await db
        .select()
        .from(weeklyWinners)
        .where(eq(weeklyWinners.tenant_id, callerTenantId))
        // ⛔ THE LATEST **WEEK**, NOT THE MOST RECENT ANNOUNCEMENT. This was
        // `desc(announced_at)` alone, and `announced_at` is not a record of when a week happened —
        // `closeCycle`'s onConflictDoUpdate re-stamps it `new Date()` on every re-close
        // (host/cycle-service.ts). So one `POST /api/cycle/advance {"week":"<old>","to":"closed",
        // "force":true}` pinned that OLD week to the top of this sort PERMANENTLY: the marquee
        // announced its winner, its stats and its honourable mentions — internally consistent and
        // wrong — while the real, later week's winner became unreachable. Nothing decays it back.
        //
        // 0107: ordered by `period_start`, NOT the `week` text. The key text sorted chronologically
        // only while every key was an ISO week; once the cadence changes, '2026-W41' vs '2026-10'
        // compares as text and means nothing. `announced_at` stays as the TIE-BREAK: `(tenant_id,
        // week)` is UNIQUE (db/schema.ts), so it only ever decides between rows of one period.
        .orderBy(sql`${weeklyWinners.period_start} desc nulls last`, desc(weeklyWinners.announced_at))
        .limit(1)
    : [];

  // The durable winner artifact is `weekly_winners`, but it can be absent for a tenant
  // (e.g. fr-test, whose showcase winner row was never written). Rather than leave the
  // marquee page blank while the rest of the app clearly shows winners, derive the winner
  // from the CALLER'S OWN data: first the top shipping solution, else a live production
  // pipeline card that belongs to one of the caller's solutions.
  //
  // RLS NOTE: `solutions` is tenant-scoped but `pipeline_items` is NOT — so the pipeline
  // path MUST inner-join `solutions` (which RLS scopes to the caller) or it would surface a
  // cross-tenant card whose solution the caller then can't read, re-blanking the page.
  let week: string | null = null;
  let announcedAt: Date | null = null;
  let stats: WeeklyWinnerStats = {};

  // DEFENCE IN DEPTH: only ACCEPT the artifact row once its solution actually resolves under
  // the caller's RLS. A weekly_winners row pointing at ANOTHER tenant's solution (a pre-0047
  // mis-stamp — the demo tenant's 2026-W21 row, which under the old `desc(announced_at)` sort won
  // outright over its real W23 one) used to short-circuit the fallback below and blank the page.
  // An unusable row must fall THROUGH, and its week/announcedAt/stats must be dropped with it —
  // they describe a winner we are not showing. ⚠️ STILL LOAD-BEARING NOW THAT THE SORT READS
  // `week`: ordering decides WHICH row is picked, never whether the picked row is readable, and a
  // mis-stamped row in the LATEST week is exactly the one this sort hands over first.
  let sol = w ? await loadWinnerSolution(w.solution_id) : undefined;
  if (sol && w) {
    week = w.week;
    announcedAt = w.announced_at;
    stats = w.stats ?? {};
  }

  if (!sol) {
    const [ship] = await db
      .select({ id: solutions.id })
      .from(solutions)
      .where(eq(solutions.status, 'shipping'))
      .orderBy(desc(solutions.votes_count))
      .limit(1);
    if (ship?.id) {
      sol = await loadWinnerSolution(ship.id);
      // `|| null` not `?? null`: solutions.week is `text NOT NULL DEFAULT ''`, so the absent
      // case is the empty string, not null. Letting '' through would make the eyebrow read
      // "Common Practice · " AND (worse) hand an empty week to the mentions predicate.
      week ??= sol?.week || null;
    } else {
      const [prod] = await db
        .select({ solution_id: solutions.id, week: pipelineItems.week })
        .from(pipelineItems)
        .innerJoin(solutions, eq(pipelineItems.solution_id, solutions.id))
        .where(and(eq(pipelineItems.stage, 'production'), eq(pipelineItems.live, true)))
        .orderBy(desc(pipelineItems.featured), desc(pipelineItems.live_at))
        .limit(1);
      if (prod?.solution_id) {
        sol = await loadWinnerSolution(prod.solution_id);
        if (sol) {
          // The pipeline card's week wins when it has one (it is the card that actually
          // shipped), and the solution's own week is the backstop — `pipeline_items.week` is
          // nullable and seeded/manually-created cards routinely have none.
          week = prod.week ?? null;
          week ??= sol.week || null;
        }
      }
    }
  }

  // No winner anywhere is a valid empty state, not an error — return 200 with a null winner
  // (same "never 404 a valid empty state" rule as the list endpoints) so the page renders its
  // empty state without logging a console 404.
  if (!sol) {
    return jsonResponse({ week: null, announcedAt: null, stats: {}, pipeline: null, winner: null, honorableMentions: [] });
  }

  const [ch] = await db
    .select({ id: challenges.id, code: challenges.code, title: challenges.title, submitterName: users.name })
    .from(challenges)
    .innerJoin(users, eq(challenges.submitter_id, users.id))
    .where(eq(challenges.id, sol.challenge_id));

  // Honorable mentions: the top of THE WEEK's leaderboard minus the winner — the same candidate
  // set, and the same ordering, that `closeCycle` picked rank 1 from. NOT "ranks 2-4": the winner
  // is not necessarily rank 1 (see PART 3 below), so the positions are measured, not assumed. `eligibleForWeek` + `WINNER_ORDER` are
  // spelled once, in host/cycle-eligibility.ts, and both call sites import them; that is the
  // whole reason that module exists.
  //
  // ⛔ THE DEFECT, PART 1. This query used to carry neither the week nor the status nor the
  // tie-break: it ranked every solution ever submitted to the winning challenge, by votes alone.
  // In prod that printed three 2026-W23 rows at 316/271/234 votes directly beneath a 0-vote
  // 2026-W32 winner, as its "runners-up" — rows that had never competed against it. The
  // predicate a page uses to say "who else was in this race" has to be the predicate that
  // decided the race.
  //
  // ⛔ THE DEFECT, PART 2 — AND WHY THE SENTENCE ABOVE USED TO BE FALSE. That first fix added the
  // week/status/tie-break but LEFT `eq(solutions.challenge_id, sol.challenge_id)` in place, while
  // this comment already claimed the candidate set matched `closeCycle`'s. It did not:
  // `closeCycle` (host/cycle-service.ts) selects `eligibleForPeriod(week, tenant_id)` with NO
  // challenge predicate at all, so rank 1 was the top solution of the whole WEEK while ranks 2–4
  // came only from the winner's own challenge. A week whose winning challenge had a single
  // solution therefore showed a winner with ZERO runners-up although others genuinely competed,
  // and the week's real #2 was invisible whenever it answered a different challenge. An
  // equivalence asserted in a comment and not held by the code is how this survived review; the
  // challenge predicate is gone rather than the claim being softened, because:
  //   • the card sits under "the week's winner" and `closeCycle` decided the race week-wide;
  //   • `weekSolutionStats` below feeds the SAME page's "week in numbers" and is week-scoped, so
  //     keeping the challenge scoping would leave the page inconsistent with itself twice over;
  //   • the shipped copy already says so — `winner_mentions_empty` is "No other solutions this
  //     week." in all 8 locales (frontend/messages/*.json), never "…to this challenge". The
  //     relabel alternative would have meant re-translating the card to match a narrower query
  //     than the one that crowned the winner it sits beneath.
  // The winning CHALLENGE is still fetched and rendered — it is the winner's context, not the
  // field of play.
  //
  // ⚠️ NO WEEK → NO MENTIONS. `solutions.week` is `text NOT NULL DEFAULT ''`, so `eq(week,'')`
  // is not an empty result set, it is every legacy row in the table. An unknown week means we
  // cannot name the field honestly, and the card already has an empty state for exactly that.
  // `eligibleForWeek` THROWS on a falsy week rather than building that predicate, so this
  // `week ? … : []` short-circuit is load-bearing, not a tidy-up.
  // ⛔ THE DEFECT, PART 3 — THE RANKS WERE AN OFFSET, NOT A MEASUREMENT. This list used to be
  // fetched with the winner EXCLUDED (`ne(solutions.id, sol.id)`) and then numbered `i + 2`,
  // which silently asserts "the winner is rank 1". Nothing above makes that true: two of the
  // three winner sources are vote-INDEPENDENT (the top *shipping* solution, ordered across every
  // week; a live pipeline card ordered by `featured`/`live_at`), and even an announced artifact
  // winner keeps accruing votes after its cycle closes. Prod rendered a 2-vote winner directly
  // above a 233-vote "#2" — the page contradicting itself on its own numbers. So: rank the winner
  // inside the SAME ordered candidate set as everybody else and print the position we measured.
  //
  // ⚠️ THE WINNER IS NOW INSIDE THE PREDICATE. Dropping `ne(solutions.id, sol.id)` is precisely
  // what makes the measurement possible; the winner is removed from the DISPLAYED mentions below,
  // by identity, AFTER its position has been read off the ordered set.
  //
  // 25, not 3: the card shows three runners-up, but a rank is only knowable from the rows ABOVE
  // it, so the fetch must be deep enough to contain the winner in every realistic week (prod's
  // busiest week to date carries single-digit eligible solutions; 25 is several times the ceiling
  // and still one bounded round-trip). It is a cut-off, not a guarantee — the winner sitting under
  // it is handled explicitly by `rankWithinWeek`, never by collapsing to null.
  const WEEK_CANDIDATE_LIMIT = 25;
  const candidates = week
    ? await db
        .select({ id: solutions.id, title: solutions.title, votes_count: solutions.votes_count, blocks_used: solutions.blocks_used, authorName: users.name, authorInitials: users.avatar_initials })
        .from(solutions)
        .innerJoin(users, eq(solutions.author_id, users.id))
        .where(
          // Read path: RLS already scopes this, and the caller's tenant is passed as the
          // explicit belt-and-braces predicate this file applies to the artifact read for
          // the same reason (see peekEffectiveTenant above).
          eligibleForPeriod(week, callerTenantId),
        )
        .orderBy(...WINNER_ORDER)
        .limit(WEEK_CANDIDATE_LIMIT)
    : [];

  // `null` is a real answer here, and the only honest one, in two distinct cases:
  //   1. the winner is not in the week's eligible set AT ALL — a `shipping` solution of another
  //      week, or a live pipeline card whose solution never competed in this one. It won by
  //      shipping, not by polling: it has no position on this leaderboard, and inventing one is
  //      the same class of claim as the `i + 2` this replaced.
  //   2. the week is unknown, so there is no leaderboard to hold a position in.
  // The one case that must NOT collapse into null is "eligible, but below WEEK_CANDIDATE_LIMIT" —
  // a genuine rank we merely did not fetch. Hence the second, targeted read; it only ever runs for
  // a winner sitting deep in an unusually large week.
  const winnerIndex = candidates.findIndex((c) => c.id === sol.id);
  let winnerRank: number | null = winnerIndex >= 0 ? winnerIndex + 1 : null;
  if (winnerRank === null && week && candidates.length === WEEK_CANDIDATE_LIMIT) {
    winnerRank = await rankWithinWeek(sol.id, week, callerTenantId);
  }

  // The card shows the runners-up, so the winner comes out — by identity, after ranking, and each
  // survivor keeps the 1-based position it actually held. A rank-4 winner therefore sits above
  // mentions #1/#2/#3, which is what prod's 2-vote winner should have rendered as all along.
  const mentions = candidates
    .map((row, i) => ({ ...row, rank: i + 1 }))
    .filter((m) => m.id !== sol.id)
    .slice(0, 3);

  // "The week in numbers" is stamped onto the weekly_winners artifact by the close. A winner
  // DERIVED from a shipping solution or a live pipeline card has no artifact and therefore no
  // stats, which is why the card rendered a heading over an empty list. Recompute it — the
  // same aggregate the close would have stamped, from the same shared helper.
  //
  // ⛔ Under THIS file's `db` (the caller's RLS), never `runAsSystem`. A cross-tenant total on
  // a tenant's own winner page is precisely the leak `liveInProduction` above was fixed for.
  // ⛔ And never fabricated: no week, or no rows, means the empty state — not a plausible number.
  if (week && Object.keys(stats).length === 0) {
    stats = await periodSolutionStats(week, callerTenantId, db);
  }

  // §5B overlay, ONE batch for the winner + every mention (all `solution`/`title`), and one
  // more for the challenge. Batched together on purpose: the winner is a solution like any
  // other and a second round-trip for a single id is pure waste.
  const solTx = await getTranslationsBatch('solution', [sol.id, ...mentions.map((mn) => mn.id)], locale, ['title']);
  const chTx = ch ? (await getTranslationsBatch('challenge', [ch.id], locale, ['title'])).get(ch.id) ?? {} : {};

  // Real production timeline for the winning solution (replaces the seeded const
  // on the winner screen). Null if the winner has no pipeline card yet.
  const timeline = await solutionTimeline(sol.id);

  // The winner's measured demo duration — see the note on the `demoMs` field below.
  const winnerDemoMs = (await demoMsForSolutions([sol.id], callerTenantId)).get(sol.id) ?? null;

  return jsonResponse({
    week,
    announcedAt,
    stats,
    pipeline: timeline,
    winner: {
      // The winner's 1-based position in ITS OWN week's ordered candidate set, or `null` when it
      // has none (see winnerRank above). The hero badge is CONDITIONAL on `rank === 1` — same
      // `hasNumbers` doctrine as `demoMs`: an unknown position is a badge that is not there,
      // never a fabricated "#1".
      rank: winnerRank,
      solution: {
        id: sol.id,
        title: solTx.get(sol.id)?.title ?? sol.title,
        votesCount: sol.votes_count,
        // The MEASURED duration of the winner's most recent successful demo run, in milliseconds,
        // or `null` when nobody has run it. The hero tile is CONDITIONAL on it (`{#if demoMs !=
        // null}`) — this page's `hasNumbers` doctrine is that a genuine 0 is data and only absence
        // is absence, so an unknown figure is a tile that isn't there, never a rendered '—'.
        //
        // It replaced two fields. `demoSeconds` was a seeded constant that this payload shipped and
        // /winner never rendered; `buildTimeMinutes` was the '—' in the hero, and is gone from the
        // product entirely for want of an honest source (see db/schema.ts on the column).
        //
        // Under the caller's `db` (RLS), like every other read on this page.
        demoMs: winnerDemoMs,
        blocksUsed: sol.blocks_used,
        flowId: sol.flow_id,
        author: { name: sol.authorName, initials: initialsOf(sol.authorName, sol.authorInitials) },
      },
      challenge: ch ? { id: ch.id, code: ch.code, title: chTx.title ?? ch.title, submitter: ch.submitterName } : null,
    },
    honorableMentions: mentions.map((m) => ({
      // The MEASURED position in the week's ordered set — never `i + 2`, which assumed the
      // winner held rank 1 and printed the week's real leader as "#2".
      rank: m.rank,
      id: m.id,
      title: solTx.get(m.id)?.title ?? m.title,
      votesCount: m.votes_count,
      blocksUsed: m.blocks_used,
      author: { name: m.authorName, initials: initialsOf(m.authorName, m.authorInitials) },
    })),
  });
});

export function registerMarketplaceSummaryRoutes(router: Router): void {
  router.add('GET', '/api/home/summary', homeSummary);
  router.add('GET', '/api/winner', getWinner);
}
