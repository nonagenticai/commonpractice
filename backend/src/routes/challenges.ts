// src/routes/challenges.ts — the marketplace the Challenge leaderboard (challenges) + the
// challenge-detail discussion (comments). These are Employee Discover screens, so
// every route only needs validateAuth (no 'platform' gate). A challenge submitter /
// commenter is provisioned on first write (ensureUser). Vote toggle delegates to
// host/vote-service (shared with solutions); votes_count is the denormalized
// leaderboard counter. Registered via registerChallengeRoutes(router) in server.ts.
import { and, asc, desc, eq, ilike, inArray, not, or, sql, type AnyColumn } from 'drizzle-orm';
import { z } from 'zod';
import { db, challenges, challengeDatasets, solutions, comments, users, votes, marketplaceCycles } from '../db/client';
import type { Challenge } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { resolveTenant } from '../middleware/tenant';
import { getTranslationsBatch } from '../db/translations';
import { translatedMatchSql } from '../db/translation-search';
import { negotiateLocale } from '../utils/locale';
import { likeTerm } from '../utils/search';
import { jsonResponse, readJson, route, notFound, badRequest, forbidden } from '../utils/http';
import { log } from '../host/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import {
  resolveChallengeDatasetsForReader,
  resolveChallengeEntities,
  tenantSlugs,
} from '../challenges/challenge-data-service';
import { canManageData } from './datasets';
import {
  assertLinkableEntities,
  canEditChallengeLinks,
  challengeInTenant,
  informationOptions,
  MAX_CHALLENGE_ENTITIES,
  replaceChallengeEntities,
  resolveChallengeInformation,
  suggestInformation,
  uniqueIds,
} from '../challenges/challenge-information';
import { recordAudit } from '../host/audit-service';
import { challengePeriodFor, OFF_PERIOD_COLUMNS, periodColumns, readCurrentCycle } from '../host/cycle-service';
import { resolveCadence } from '../host/cycle-cadence';
// "Is this challenge still accepting work?" — the ONE definition, shared with routes/solutions'
// `challenge_closed` submit guard. The board must not invent a second answer: a chip that offers a
// challenge whose cycle is over sends the author to a 422 (and, before that guard existed, to a
// solution filed against a June challenge — see the helper's header).
import { challengeClosedOver, challengeClosedSql } from '../host/cycle-eligibility';
// "Where does this challenge stand?" — the ONE definition, shared with home's Trending card. The
// board must not invent a second answer: `rank` used to be the row's offset into the RESPONSE, so
// the gold crown landed on whatever sorted first under `?sort=newest` or a `?work_area=` filter.
// Read that file's header before touching the window or its ordering.
import { rankedChallengeBoard, CHALLENGE_COLS, type RankedChallengeBoard } from '../host/challenge-board';
import { castVote, retractVote, votedTargetIds } from '../host/vote-service';
import { enqueueTranslations } from '../host/translation-service';
import { ensureUser } from '../services/user-service';
import type { Router } from '../utils/router';
import type { User } from '../types';

const PAGE_SIZE = 10;
const STATUSES = ['voting', 'solution_phase', 'closed'] as const;
type ChStatus = (typeof STATUSES)[number];
const SORTS = ['top', 'newest', 'trending', 'closing'] as const;
type Sort = (typeof SORTS)[number];

export const WORK_AREAS = ['Claims', 'Sales', 'Service', 'Legal', 'Marketing', 'Risk', 'Ops', 'IT'] as const;

// An ontology entity id. `guid`, not `uuid`: zod 4's `uuid()` also demands an RFC version/variant,
// and the shape is all the route needs — `assertLinkableEntities` decides whether the id is real.
const entityIdSchema = z.guid().transform((s) => s.toLowerCase());

const createChallengeSchema = z
  .object({
    title: z.string().min(1).max(140),
    description: z.string().min(1).max(8000),
    business_impact: z.string().max(8000).optional(),
    // Constrained to the canonical domains: the chip UI only renders these, so a free-text
    // work_area silently inflated "All" without a matching chip (the CH-243 count drift). The
    // submit form only ever sends one of these — tightening here just stops future drift.
    work_area: z.enum(WORK_AREAS),
    metrics: z
      .object({
        timeSavedPerWeek: z.string().max(40).optional(),
        affectedStaff: z.string().max(40).optional(),
        backlogReduction: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
    // Dedupe at the validation boundary: duplicate tags would collide in the value-keyed
    // {#each tags as t (t)} chip render and crash the page with Svelte's each_key_duplicate.
    tags: z
      .array(z.string().max(40))
      .max(12)
      .optional()
      .transform((v) => (v ? [...new Set(v)] : v)),
    // Phase 3.0: the test datasets the creator marks as applicable to this challenge.
    datasets: z
      .array(z.object({ slug: z.string().min(1).max(160), note: z.string().max(2000).optional() }).strict())
      .max(20)
      .optional(),
    // W8/P2: the types of information (ontology entity ids) the creator says this is about.
    entities: z.array(entityIdSchema).max(MAX_CHALLENGE_ENTITIES).optional(),
  })
  .strict();

// Phase 3.0: PATCH /api/challenges/:id sets the full applicable-datasets set (replace).
const updateDatasetsSchema = z
  .object({
    datasets: z
      .array(z.object({ slug: z.string().min(1).max(160), note: z.string().max(2000).optional() }).strict())
      .max(20),
  })
  .strict();

const commentSchema = z.object({ body: z.string().min(1).max(4000) }).strict();

// ---- per-tenant display code (CH-nnn) ----
// Until now `code` was only ever set by the seeds, so every user-submitted challenge showed a
// blank badge and the pipeline card's "from CH-…" deep link had nothing to render. The code is a
// per-tenant running number (the format the seeds established), NOT a global one — two tenants
// may both hold CH-12 and neither may hold it twice (partial unique index, migration 0047).
const CODE_PREFIX = 'CH-';
const CODE_ALLOC_ATTEMPTS = 8;

/** Next free `CH-n` for a tenant = max existing n + 1. Scoped explicitly, never on RLS alone.
 *  The digit count is bounded so the cast is TOTAL: an out-of-range code would otherwise turn
 *  every challenge submit in that tenant into a 500.
 *
 *  It is bounded to 18 with a ::bigint rather than to 9 with an ::int, because a bound the
 *  ALLOCATOR CAN CROSS is worse than the crash it replaces: at CH-999999999 a 9-digit bound makes
 *  the next code CH-1000000000, which is then invisible to the very pattern that generated it, so
 *  the allocator re-proposes it forever — 23505, retries exhausted, a permanent 500 on every
 *  submit in that tenant, silently. 18 digits cannot be reached by max+1 from anything bigint can
 *  hold, so the sequence stays self-consistent. Wider codes are not part of the CH-n scheme. */
async function nextChallengeCode(tenantId: string): Promise<string> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max((substring(code from '^CH-([0-9]{1,18})$'))::bigint), 0) + 1`,
    })
    .from(challenges)
    .where(and(eq(challenges.tenant_id, tenantId), sql`code ~ '^CH-[0-9]{1,18}$'`));
  return `${CODE_PREFIX}${row?.next ?? 1}`;
}

/** Dedup a creator's dataset links by slug (composite PK forbids dupes), last note wins. */
function dedupDatasetLinks(input: { slug: string; note?: string }[]): { slug: string; note: string }[] {
  const map = new Map<string, string>();
  for (const d of input) map.set(d.slug, d.note ?? '');
  return [...map.entries()].map(([slug, note]) => ({ slug, note }));
}

// ---- leaderboard ordering ----
//
// All four sort options are offered by the board's chips AND translated in all 8 catalogs, but
// only `top` and `newest` used to do anything: `trending` and `closing` fell into the same else
// branch as `top` and produced BYTE-IDENTICAL ordering, so two of the four chips were inert
// affordances that redrew the board with the same rows in the same order.
//
// `top` is deliberately left as ALL-TIME `votes_count` even though its label reads "Top this
// week": narrowing it to the running ISO week would hide every older challenge from the DEFAULT
// view, which is a product decision (and an 8-catalog relabel), not a bug fix. Flagged, not
// silently changed.

/** How far back `trending` looks. One week, because the marketplace cycle is weekly: "trending"
 *  should mean "gathering votes in the cycle people are currently in", not all-time. */
const TRENDING_WINDOW_DAYS = 7;

/** Votes cast on a challenge inside the trending window. Correlated subquery rather than a join
 *  so the surrounding paginated query keeps its exact row shape; `votes_target_idx` covers the
 *  (target_type, target_id) lookup.
 *
 *  ⚠️ The id column is a PARAMETER because the list query no longer selects from `challenges`: it
 *  selects from the ranking subquery (host/challenge-board.ts) and orders the ranked set from the
 *  outside, so these fragments must correlate against `ranked`, not against a table that is not in
 *  their FROM clause. */
const recentVotes = (idCol: AnyColumn) => sql<number>`(
  SELECT count(*) FROM ${votes} v
  WHERE v.target_type = 'challenge' AND v.target_id = ${idCol}
    AND v.created_at >= now() - make_interval(days => ${TRENDING_WINDOW_DAYS})
)`;

/** The instant this challenge's period closes, read from the CYCLE ROW rather than derived
 *  from the period key.
 *
 *  Deriving it (weekStart(week) + config.cycle.votingDays + solutionDays) would reproduce the
 *  cadence the row was OPENED with only for as long as that config never changes; the row's own
 *  `closes_at` is the boundary the engine will actually act on, and `closeCycle` can also move it.
 *  Ordering by the `week` label instead would be the same order only under a fixed cadence, and
 *  would silently diverge the moment one week's boundaries differ from another's.
 *
 *  Matched on (tenant_id, period_kind, period_start) — exactly the unique index
 *  `marketplace_cycles_tenant_period_start_uq` (0110/0114), so this returns AT MOST ONE row. ⛔ Not
 *  on `week`: it is not unique on its own (a tenant's month row and week row are distinct rows, and
 *  the text is only a mirror of `period_key`, dropped in a later release), and a scalar subquery
 *  that finds two rows fails the whole board query. A challenge stamped into a period the engine
 *  has not opened yet — or filed while the cadence was off (period_start NULL) — has no boundary
 *  at all; see `closingTier` for where it lands. */
const closesAt = (b: { tenant_id: AnyColumn; period_kind: AnyColumn; period_start: AnyColumn }) => sql`(
  SELECT mc.closes_at FROM ${marketplaceCycles} mc
   WHERE mc.tenant_id = ${b.tenant_id}
     AND mc.period_kind = ${b.period_kind}
     AND mc.period_start = ${b.period_start}
)`;

/** The FIRST key of the `closing` sort: which of the three states a challenge is in, because
 *  ascending `closes_at` alone ranks the MOST-EXPIRED first.
 *
 *    0 — a real boundary still ahead of now(). These are the ones actually closing; ordered
 *        among themselves by ascending `closes_at`, soonest first, which is what the chip means.
 *    1 — NO cycle row for the challenge's week. The engine has not opened that week, so no
 *        boundary EXISTS to compare. It is not hidden (this is ordering, never filtering) and it
 *        cannot outrank a genuinely-closing-soon one, but it sits ABOVE the already-expired: a
 *        week the engine has yet to open is still live and still actionable, whereas an expired
 *        one has nothing left to close. Inside this tier the sort falls to `period_start` ASC —
 *        the only estimate available. Without it the whole tier collapses onto the `votes_count`
 *        tie-break, i.e. onto `top` — which is exactly what `closing` did on a freshly seeded
 *        database, where `marketplace_cycles` is EMPTY and therefore EVERY row is tier 1.
 *    2 — a real boundary already in the past.
 *
 *  The previous guard was `challenges.status = 'closed'`, which is a different fact: the cycle
 *  engine closes CYCLES, and a challenge's own `status` never reflects that — it only ever advances
 *  `voting → solution_phase` (when a solution is filed, or a stranded row is healed forward), and
 *  nothing writes `'closed'` at all. So a challenge whose week ended eight weeks ago was still tier
 *  "not closed" and, having the
 *  smallest `closes_at`, sorted ABOVE one closing tonight — the sort ran exactly backwards for
 *  every stale row. */
const closingTier = (b: { tenant_id: AnyColumn; period_kind: AnyColumn; period_start: AnyColumn }) => sql`(CASE
  WHEN ${closesAt(b)} IS NULL THEN 1
  WHEN ${closesAt(b)} < now() THEN 2
  ELSE 0
END)`;

/** ORDER BY terms for a leaderboard sort. Every branch ends on `asc(b.id)`, and that last term is
 *  the ONLY thing making any of them total.
 *
 *  ⛔ (votes_count, created_at) IS NOT A TIE-BREAK — this docstring used to claim it was. Nothing
 *  stops two challenges sharing both: `created_at` defaults to `now()`, which is the TRANSACTION's
 *  clock, so every row the seeder (or any batch insert, or one API call per two users in the same
 *  millisecond) writes in one transaction carries the identical timestamp, and `votes_count` is a
 *  small integer that ties constantly on a young board. When the ORDER BY is not total, Postgres
 *  is free to return tied rows in a DIFFERENT arbitrary order per query, and it does: the page
 *  queries differ only in their OFFSET, so `LIMIT 10 OFFSET 0` sorts under a top-N heapsort of
 *  depth 10 and `LIMIT 10 OFFSET 10` under one of depth 20, which order equal keys differently.
 *  Measured on 66 board rows tied on both columns, paged 10 at a time: 66 slots served only 58
 *  DISTINCT rows — 8 rows appeared on two pages each and 8 rows appeared on none. `id` is the
 *  primary key, so appending it makes the key unique per row and the paging exact.
 *
 *  This is the OUTER sort — page MEMBERSHIP. It is a different key from the `row_number()` window
 *  in host/challenge-board.ts, whose header explains the same trap for `rank`; that window already
 *  ends on `id asc`, which is why `rank` was stable while the page a row landed on was not.
 *
 *  ⚠️ `top` ALONE COULD NOT BE MADE TO MISBEHAVE, and that is luck, not safety. Its key is exactly
 *  the window's key minus the `id`, i.e. a PREFIX of an ordering the subquery has already produced,
 *  so the planner drops the outer Sort node entirely and the rows arrive in the window's total
 *  order. The other three branches get a real Sort and a real top-N heapsort, and all three page
 *  wrongly. `top` is only ever one cheaper plan — or one change to the window's ordering — away
 *  from joining them, so it carries the same term; the tests assert the term on the WIRE for all
 *  four branches precisely because the runtime probe cannot see this one.
 *
 *  The columns come from the RANKED BOARD rather than from `challenges` directly — sorting happens
 *  outside the ranking subquery, which is the whole point: reordering the page must not renumber
 *  it. `b.rank` is untouched by every branch below.
 *
 *  Exported for tests ONLY — nothing else may call it; the board's ordering is this route's. */
export function orderForSort(sort: Sort, b: RankedChallengeBoard) {
  if (sort === 'newest') return [desc(b.created_at), asc(b.id)];
  if (sort === 'trending') {
    return [desc(recentVotes(b.id)), desc(b.votes_count), desc(b.created_at), asc(b.id)];
  }
  if (sort === 'closing') {
    // Tier FIRST (see closingTier) — ascending `closes_at` on its own puts the most-expired row
    // at the top. Then the boundary itself (soonest first) inside tiers 0 and 2; then `week`,
    // which is the only ordering tier 1 has.
    return [
      asc(closingTier(b)),
      sql`${closesAt(b)} ASC NULLS LAST`,
      // 0107: by period START, never by key text — '2026-W41' vs '2026-10' do not sort by time.
      sql`${b.period_start} ASC NULLS FIRST`,
      desc(b.votes_count),
      desc(b.created_at),
      asc(b.id),
    ];
  }
  return [desc(b.votes_count), desc(b.created_at), asc(b.id)]; // 'top'
}

function initialsOf(name: string, stored?: string | null): string {
  if (stored) return stored;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

type ChallengeRow = Challenge & { submitterName: string; submitterInitials: string | null; cycleClosed: boolean };

function rowOf(c: ChallengeRow, rank: number, hasVoted: boolean, solutionsCount: number) {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    workArea: c.work_area,
    status: c.status,
    // `week` carries the PERIOD KEY for every kind ('2026-W41' | '2026-10' | '2026'); '' when filed
    // with the cadence off. `periodKind` names which.
    week: c.week,
    periodKind: c.period_kind,
    // ⛔ NOT a restatement of `status`, and the board must render THIS one. `status` is what the
    // engine last got round to writing; `cycleClosed` is whether the cycle this challenge competes
    // in is over. They disagree for up to a full tick — prod's CH-284 sat at `status='voting'` for
    // eight hours after its 2026-W23 cycle had been dead since June, and a solution was filed
    // against it in that gap. Never `null`: the predicate is total over columns on this row.
    cycleClosed: c.cycleClosed,
    tags: c.tags,
    votesCount: c.votes_count,
    rank,
    hasVoted,
    solutionsCount,
    submitter: { name: c.submitterName, initials: initialsOf(c.submitterName, c.submitterInitials) },
    createdAt: c.created_at,
  };
}

/** CHALLENGE_COLS (host/challenge-board.ts — the ONE column map, shared with the ranked board)
 *  + the liveness flag, which needs the request's `now` and so cannot be a module constant. The
 *  DETAIL route reads this off the base tables; the LIST route reads the same fields off the
 *  ranked subquery and computes the same flag over ITS columns, so the flag can never be on one
 *  screen and absent from the other. */
const selectCols = () => ({ ...CHALLENGE_COLS, cycleClosed: challengeClosedSql() }) as const;

// GET /api/challenges?work_area=&status=&sort=&q=&open=&page= — leaderboard.
const listChallenges = route(async (req) => {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const workArea = url.searchParams.get('work_area');
  const statusParam = url.searchParams.get('status');
  const status = STATUSES.includes(statusParam as ChStatus) ? (statusParam as ChStatus) : null;
  const sortParam = url.searchParams.get('sort');
  const sort: Sort = SORTS.includes(sortParam as Sort) ? (sortParam as Sort) : 'top';
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  // Negotiated HERE and not beside the overlay below, because the SEARCH needs it too: this
  // board renders localized titles (see the overlay at the bottom of this handler) and must
  // therefore also MATCH on them. Read once, used by both.
  const locale = negotiateLocale(req);

  // ⛔ ONE escaped pattern, built ONCE, used by BOTH arms of the search predicate below.
  // `%` and `_` are ILIKE metacharacters: a raw `` `%${q}%` `` turned a board search for
  // `Korting 100% eraf` into a match on every title containing `Korting 100` followed by
  // anything. utils/search.ts owns the escape (`\` is Postgres's default LIKE escape and the
  // pattern is a bind parameter, so no `ESCAPE` clause is needed). The translated arm takes a
  // COMPLETE pattern by contract (db/translation-search.ts), so it gets the same value — the two
  // arms must match exactly the same strings or the overlay finds rows the base column cannot.
  const like = q ? likeTerm(q) : '';

  // One instant for the whole request, so every row on a page is judged by the same rule even if
  // the board is rendered across an ISO-week boundary. An empty week throws by design
  // (`weekClosedSql`) rather than silently opening the entire back catalogue.

  // ⛔ OPT-IN, AND IT MUST STAY OPT-IN. "Only challenges still accepting work" is the honest DEFAULT
  // for a submit flow and the wrong default for a leaderboard, which is a HISTORY as well as an
  // invitation — the board's own `closing` sort exists to rank rows by how near their boundary is,
  // and hiding the far side of that boundary by default would delete the marketplace's back
  // catalogue from every screen that reads this route. Callers that need live rows ask for them.
  const openParam = url.searchParams.get('open');
  const openOnly = openParam === 'true' || openParam === '1';

  // ⚠️ ONE PREDICATE, TWO COLUMN SETS — the discipline routes/solutions.ts spells out on its own
  // `searchOver`. The rows query now reads these columns off the ranking SUBQUERY (below) and the
  // counts query reads them off the base table, so the predicate is a FUNCTION of its columns
  // rather than two hand-copied `and(...)` blocks that can drift apart.
  //
  // ⛔ THE `open` FILTER BELONGS ON **BOTH** CALLS, and that is not belt-and-braces. `total` is read
  // out of `counts` (below), and the per-domain chips are asserted to sum to `counts.all`
  // (challenges.test.ts, the A3 test). Filter the ROWS without filtering the COUNTS and the pager
  // promises pages of rows the filter removed; filter the counts without the rows and the chips
  // under-report a board that still shows the rows.
  //
  // `workAreaCol: null` is how the counts call opts OUT of the work_area filter — the chips are the
  // per-domain totals of the OTHER filters, so applying it there would leave every tab reading its
  // own count and zero for its siblings.
  //
  // ⛔ THE SEARCH ARM MATCHES THE TEXT THIS ROUTE ACTUALLY RENDERS. `q` used to be
  // `ilike(title, …)` on the EN base column alone, while the response's `title` is OVERLAID from
  // `content_translations` a hundred lines below. So the board showed a Dutch reader
  // "Schadeformulieren automatisch samenvatten", and searching `schadeformulieren` returned zero
  // rows and `counts.all: 0` under the row that was still on screen. The predicate now also asks
  // "does THIS reader's edition of the title contain the term" — one correlated EXISTS
  // (db/translation-search.ts), so it costs no round trip and, critically, no JOIN: a join here
  // could duplicate a row and the rows query reads from the RANKED subquery, so a duplicate is a
  // re-numbered leaderboard. The base-column arm STAYS: a reader on `nl` may well type the
  // English product term. On `en` the arm is `undefined` and `or()` drops it, so English is
  // unchanged by construction.
  const boardWhere = (
    id: AnyColumn,
    title: AnyColumn,
    statusCol: AnyColumn,
    weekCol: AnyColumn,
    workAreaCol: AnyColumn | null,
  ) =>
    and(
      q
        ? or(
            ilike(title, like),
            translatedMatchSql('challenge', id, locale, ['title'], like),
          )
        : undefined,
      status ? eq(statusCol, status) : undefined,
      workAreaCol && workArea ? eq(workAreaCol, workArea) : undefined,
      openOnly ? not(challengeClosedOver(statusCol)) : undefined,
    );

  // Per-domain counts over the search+status(+open) set (work_area filter NOT applied → tab totals).
  const countRows = await db
    .select({ work_area: challenges.work_area, n: sql<number>`count(*)::int` })
    .from(challenges)
    .where(boardWhere(challenges.id, challenges.title, challenges.status, challenges.week, null))
    .groupBy(challenges.work_area);
  const counts: Record<string, number> = { all: 0 };
  for (const wa of WORK_AREAS) counts[wa] = 0;
  for (const r of countRows) {
    counts[r.work_area] = (counts[r.work_area] ?? 0) + r.n;
    counts.all = (counts.all ?? 0) + r.n;
  }

  const total = workArea ? counts[workArea] ?? 0 : counts.all ?? 0;

  // ⛔ THE RANK COMES OFF THE BOARD, NOT OFF THIS RESPONSE. `rank` used to be
  // `(page-1)*PAGE_SIZE + i + 1`, which is the row's offset into whatever slice the caller asked
  // for — true of the unfiltered first page of `sort=top` and a LIE of every other view this route
  // serves. On the live stack `?sort=newest` therefore stamped `rank: 1` on a 0-vote challenge and
  // `rank: 6` on the 284-vote leader, and the browser paints `rank === 1` with the gold crown. The
  // window is computed over the UNFILTERED board (host/challenge-board.ts) and the search / status /
  // work_area / open filters and the sort are applied OUT HERE, so the number is the row's true
  // standing however the list is sliced. Read that module's header before changing this shape.
  const board = rankedChallengeBoard();

  const rows = await db
    .select({
      id: board.id,
      title: board.title,
      description: board.description,
      business_impact: board.business_impact,
      work_area: board.work_area,
      submitter_id: board.submitter_id,
      tenant_id: board.tenant_id,
      status: board.status,
      week: board.week,
      period_kind: board.period_kind,
      period_start: board.period_start,
      metrics: board.metrics,
      tags: board.tags,
      code: board.code,
      votes_count: board.votes_count,
      created_at: board.created_at,
      updated_at: board.updated_at,
      submitterName: board.submitterName,
      submitterInitials: board.submitterInitials,
      rank: board.rank,
      // ⛔ COMPUTED IN THE **OUTER** SELECT, NEVER INSIDE THE SUBQUERY, for the reason its header
      // gives: anything in there that could change its row set renumbers the whole board. Out here
      // the window is closed and this is just a scalar per surviving row.
      cycleClosed: challengeClosedOver(board.status),
    })
    .from(board)
    .where(boardWhere(board.id, board.title, board.status, board.week, board.work_area))
    .orderBy(...orderForSort(sort, board))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const ids = rows.map((r) => r.id);
  const voted = await votedTargetIds(user.id, 'challenge', ids);
  const solCounts = await solutionCountsFor(ids);

  // Localized-title overlay (§5B): EN base columns fall through when no translation. `locale`
  // was negotiated at the top of the handler because the SEARCH predicate needs the same value —
  // the rows matched in this reader's language must be RENDERED in it too.
  const tx = await getTranslationsBatch('challenge', ids, locale, ['title']);

  const items = rows.map((r) =>
    rowOf(
      { ...(r as ChallengeRow), title: tx.get(r.id)?.title ?? r.title },
      // The board rank, NOT the offset into this response. Identical under every sort and filter.
      r.rank,
      voted.has(r.id),
      solCounts.get(r.id) ?? 0,
    ),
  );
  return jsonResponse({ items, total, page, pageSize: PAGE_SIZE, counts, sort });
});

/** Count of solutions per challenge id. */
async function solutionCountsFor(challengeIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!challengeIds.length) return map;
  const rows = await db
    .select({ challenge_id: solutions.challenge_id, n: sql<number>`count(*)::int` })
    .from(solutions)
    .where(inArray(solutions.challenge_id, challengeIds))
    .groupBy(solutions.challenge_id);
  for (const r of rows) map.set(r.challenge_id, r.n);
  return map;
}

// POST /api/challenges — submit a challenge (defaults to status 'voting').
const createChallenge = route(async (req) => {
  const ctx = await resolveTenant(req);
  const user = ctx.user;
  const body = createChallengeSchema.parse(await readJson(req));

  // Phase 3.6: validate the creator's dataset links against the ORG's shared test data
  // (the creator tags from it, need not own it) BEFORE creating the challenge, so a bad
  // slug never leaves an orphan challenge behind.
  const dsLinks = dedupDatasetLinks(body.datasets ?? []);
  if (dsLinks.length) {
    const valid = await tenantSlugs(ctx.tenantId, dsLinks.map((d) => d.slug));
    const bad = dsLinks.find((d) => !valid.has(d.slug));
    // ⚠️ A 400 `dataset_not_found`, NOT the 404 of the same code elsewhere — a catalog entry has to
    // read the status alongside the code. One sentence, so no `reason`; just the named `slug`.
    if (bad) {
      throw badRequest('dataset_not_found', `No dataset '${bad.slug}' in the org's test data`, {
        slug: bad.slug,
      });
    }
  }

  // W8/P2: validate the information links BEFORE creating the challenge, for the same reason.
  const entityIds = uniqueIds(body.entities ?? []);
  await assertLinkableEntities(ctx.tenantId, entityIds);

  // The ISO week this challenge competes in. The cycle engine keys EVERYTHING off this label
  // (`where week = '2026-W30'`); it used to be hardcoded '', so the close query matched nothing and
  // the engine produced zero winners for seven weeks straight ("Closed · no winner" in audit_log for
  // 2026-W24…W30). It is NOT just the current week: `challengeWeekFor` rolls a submission that
  // arrives after the running week's challenge-voting window has shut into the next cycle, so it
  // lands in a cycle that is actually live, instead of in a week whose cycle has already moved on.
  // Nothing would rewrite its status there — no sweep writes `challenges.status` any more — but it
  // would sit `voting` with no live cycle to judge the solutions filed against it, and be named in
  // every tick's orphan report (`healOrphanedChallenges`, host/cycle-service.ts, report-only).
  // With the cadence OFF there is no period to file into: the row carries `period_kind = 'off'`.
  const now = new Date();
  // 0110: the challenge's tenant's cadence and running cycle.
  const cadence = await resolveCadence(now, ctx.tenantId);
  const period = cadence.current
    ? periodColumns(
        // current/next carry a pending cadence switch: a stretched current period, and a next period
        // of the NEW kind — so a late challenge never lands in a period that will not open.
        challengePeriodFor(now, cadence.current.kind, await readCurrentCycle(now, ctx.tenantId), {
          current: cadence.current,
          next: cadence.next,
        }),
      )
    : OFF_PERIOD_COLUMNS;

  // Allocate the display code and retry the insert on the (tenant_id, code) unique violation:
  // two submits landing in the same millisecond both read the same max and would otherwise
  // 500 one of them. Bounded — a persistent 23505 is a real bug and must surface.
  let created: Challenge | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      [created] = await db
        .insert(challenges)
        .values({
          title: body.title,
          description: body.description,
          business_impact: body.business_impact ?? '',
          work_area: body.work_area,
          submitter_id: user.id,
          tenant_id: ctx.tenantId,
          status: 'voting',
          ...period,
          code: await nextChallengeCode(ctx.tenantId),
          metrics: body.metrics ?? {},
          tags: body.tags ?? [],
          votes_count: 0,
        })
        .returning();
      break;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= CODE_ALLOC_ATTEMPTS) throw err;
    }
  }

  if (dsLinks.length) {
    await db.insert(challengeDatasets).values(
      dsLinks.map((d) => ({ challenge_id: created!.id, dataset_slug: d.slug, note: d.note, added_by: user.id })),
    );
  }

  if (entityIds.length) {
    await replaceChallengeEntities({ id: created!.id, tenant_id: ctx.tenantId }, entityIds, user.id);
  }

  await recordAudit({
    actorId: user.id,
    action: 'challenge.submit',
    category: 'block',
    targetType: 'challenge',
    targetId: created!.title,
    result: 'Published to voting',
    resultTone: 'ok',
  });

  // Phase 2-G: queue translations for the 7 non-en locales (best-effort — a
  // translation hiccup must never fail the submit).
  try {
    await enqueueTranslations(
      'challenge',
      created!.id,
      [
        { field: 'title', value: created!.title },
        { field: 'description', value: created!.description },
        { field: 'business_impact', value: created!.business_impact },
      ],
      user.id,
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', { entity: 'challenge', entityId: created!.id, err: e });
  }

  return jsonResponse(created, 201);
});

// GET /api/challenges/:id — detail: challenge + its solutions + similar + hasVoted.
const getChallenge = route(async (req, id) => {
  const user = await validateAuth(req);
  const [c] = await db
    .select(selectCols())
    .from(challenges)
    .innerJoin(users, eq(challenges.submitter_id, users.id))
    .where(eq(challenges.id, id!));
  if (!c) throw notFound('challenge_not_found', `No challenge '${id}'`);

  // Its solutions, ranked by votes.
  const solRows = await db
    .select({
      id: solutions.id,
      title: solutions.title,
      status: solutions.status,
      votes_count: solutions.votes_count,
      // ⛔ NO demo figure here, and this is not an omission to be "fixed". `demoSeconds` used to
      // ride along on this DTO and NOTHING rendered it — the challenge page has never shown a demo
      // duration. It is not merely reinstated as `demoMs`: `host/solution-demo.ts` is an extra
      // query per page, and paying for it to feed a field no screen reads is how the dead payload
      // got here in the first place. If the challenge page ever wants it, add the lookup AND the
      // markup in the same change.
      blocks_used: solutions.blocks_used,
      authorName: users.name,
      authorInitials: users.avatar_initials,
    })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(eq(solutions.challenge_id, c.id))
    .orderBy(desc(solutions.votes_count), desc(solutions.created_at));

  const solVoted = await votedTargetIds(user.id, 'solution', solRows.map((s) => s.id));
  const chVoted = await votedTargetIds(user.id, 'challenge', [c.id]);

  // Similar: same work_area first, exclude self, top by votes, limit 3.
  const similarRows = await db
    .select({ id: challenges.id, title: challenges.title, work_area: challenges.work_area, votes_count: challenges.votes_count })
    .from(challenges)
    .where(and(eq(challenges.work_area, c.work_area), sql`${challenges.id} <> ${c.id}`))
    .orderBy(desc(challenges.votes_count))
    .limit(3);

  const commentRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(comments)
    .where(eq(comments.challenge_id, c.id));
  const commentCount = commentRows[0]?.n ?? 0;

  // Phase 3.6: the challenge's applicable datasets (resolved within the challenge's org)
  // + whether the viewer may edit the tagged set (creator, tenant_admin or super_admin — W8.4).
  // W8/P7: column samples are masked for a reader who is not a data manager.
  const datasets = await resolveChallengeDatasetsForReader(c.id, c.tenant_id, canManageData({ user }));
  const canEditDatasets = canEditChallengeLinks(user, c.submitter_id);
  // Localized overlays (§5B): challenge title/description/impact + nested solution
  // and similar-challenge titles. EN base columns fall through when untranslated.
  // ⚠️ HOISTED ABOVE `involves` — it used to be negotiated on the next line down, after the chips
  // had already been resolved in en.
  const locale = negotiateLocale(req);

  // §B6: the ontology entities this challenge involves, from its datasets' confirmed mappings.
  // ⛔ `locale` IS THE FIX. These chips read the raw `ontology_entities.label` column while the
  // SAME entity on /ontology read its `content_translations` overlay — "Broker Note" here,
  // "Tussenpersoon-notitie" there, one row, two languages, in one product. `undefined` is the
  // default `database`; the locale is the fourth parameter (see resolveChallengeEntities, which
  // keeps the en default for the agent-facing delivery caller).
  const involves = await resolveChallengeEntities(c.id, c.tenant_id, undefined, locale);
  const cx = (await getTranslationsBatch('challenge', [c.id], locale, ['title', 'description', 'business_impact'])).get(c.id) ?? {};
  const solTx = await getTranslationsBatch('solution', solRows.map((s) => s.id), locale, ['title']);
  const simTx = await getTranslationsBatch('challenge', similarRows.map((s) => s.id), locale, ['title']);

  return jsonResponse({
    id: c.id,
    code: c.code,
    title: cx.title ?? c.title,
    description: cx.description ?? c.description,
    businessImpact: cx.business_impact ?? c.business_impact,
    workArea: c.work_area,
    status: c.status,
    week: c.week,
    // The same flag the list row carries and the same one `createSolution` refuses on — see the
    // note on `rowOf`. The detail page is where "Submit a solution" lives, so this is the field
    // that decides whether that button is an invitation or a 422 waiting to happen.
    cycleClosed: c.cycleClosed,
    tags: c.tags,
    metrics: c.metrics,
    votesCount: c.votes_count,
    hasVoted: chVoted.has(c.id),
    submitter: { name: c.submitterName, initials: initialsOf(c.submitterName, c.submitterInitials) },
    createdAt: c.created_at,
    commentCount,
    datasets,
    canEditDatasets,
    involves,
    solutions: solRows.map((s, i) => ({
      id: s.id,
      title: solTx.get(s.id)?.title ?? s.title,
      status: s.status,
      votesCount: s.votes_count,
      rank: i + 1,
      blocksUsed: s.blocks_used,
      hasVoted: solVoted.has(s.id),
      author: { name: s.authorName, initials: initialsOf(s.authorName, s.authorInitials) },
    })),
    similar: similarRows.map((s) => ({ id: s.id, title: simTx.get(s.id)?.title ?? s.title, workArea: s.work_area, votesCount: s.votes_count })),
  });
});

// PATCH /api/challenges/:id — replace the challenge's applicable-datasets set.
// Gated creator-or-platform. Slugs validated against the challenge's org test data (so
// the stored link always resolves back, regardless of who edits). Whole-set replace in a txn.
const updateChallengeDatasets = route(async (req, id) => {
  const user = await validateAuth(req);
  const body = updateDatasetsSchema.parse(await readJson(req));
  await ensureUser(user);

  const [c] = await db
    .select({ id: challenges.id, submitter_id: challenges.submitter_id, tenant_id: challenges.tenant_id, title: challenges.title })
    .from(challenges)
    .where(eq(challenges.id, id!));
  if (!c) throw notFound('challenge_not_found', `No challenge '${id}'`);

  const canEdit = canEditChallengeLinks(user, c.submitter_id);
  if (!canEdit) throw forbidden('forbidden', 'Only the challenge creator or an admin may edit its datasets');

  const dsLinks = dedupDatasetLinks(body.datasets);
  if (dsLinks.length) {
    const valid = await tenantSlugs(c.tenant_id, dsLinks.map((d) => d.slug));
    const bad = dsLinks.find((d) => !valid.has(d.slug));
    // ⚠️ A 400 `dataset_not_found`, NOT the 404 of the same code elsewhere — a catalog entry has to
    // read the status alongside the code. One sentence, so no `reason`; just the named `slug`.
    if (bad) {
      throw badRequest('dataset_not_found', `No dataset '${bad.slug}' in the org's test data`, {
        slug: bad.slug,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(challengeDatasets).where(eq(challengeDatasets.challenge_id, c.id));
    if (dsLinks.length) {
      await tx.insert(challengeDatasets).values(
        dsLinks.map((d) => ({ challenge_id: c.id, dataset_slug: d.slug, note: d.note, added_by: user.id })),
      );
    }
  });

  await recordAudit({
    actorId: user.id,
    action: 'challenge.datasets.update',
    category: 'block',
    targetType: 'challenge',
    targetId: c.title,
    result: `${dsLinks.length} dataset(s) linked`,
    resultTone: 'ok',
  });

  const datasets = await resolveChallengeDatasetsForReader(c.id, c.tenant_id, canManageData({ user }));
  return jsonResponse({ datasets, canEditDatasets: true });
});

// GET /api/challenges/:id/entities — W8/P1 "Information involved": the types of information this
// challenge is about, as localized cards (no keys, no slugs). Read-only; any member of the tenant.
const getChallengeEntities = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const c = await challengeInTenant(id!, ctx.tenantId);
  const items = await resolveChallengeInformation(c.id, c.tenant_id, negotiateLocale(req));
  return jsonResponse({ items, canEdit: canEditChallengeLinks(ctx.user, c.submitter_id) });
});

const putEntitiesSchema = z
  .object({ entityIds: z.array(entityIdSchema).max(MAX_CHALLENGE_ENTITIES) })
  .strict();

// PUT /api/challenges/:id/entities — W8/P2: replace the challenge's DIRECT information links.
// Same edit rule as the dataset links (creator, tenant_admin or super_admin). Writes `challenge_entities` only —
// never the ontology, so no ontology role gate is involved or changed.
const putChallengeEntities = route(async (req, id) => {
  const ctx = await resolveTenant(req);
  const body = putEntitiesSchema.parse(await readJson(req));
  const c = await challengeInTenant(id!, ctx.tenantId);
  if (!canEditChallengeLinks(ctx.user, c.submitter_id)) {
    throw forbidden('forbidden', 'Only the challenge creator or an admin may edit its information');
  }
  const ids = uniqueIds(body.entityIds);
  await assertLinkableEntities(c.tenant_id, ids);
  await replaceChallengeEntities(c, ids, ctx.user.id);
  await recordAudit({
    actorId: ctx.user.id,
    action: 'challenge.entities.update',
    category: 'block',
    targetType: 'challenge',
    targetId: c.title,
    result: `${ids.length} type(s) of information linked`,
    resultTone: 'ok',
  });
  const items = await resolveChallengeInformation(c.id, c.tenant_id, negotiateLocale(req));
  return jsonResponse({ items, canEdit: true });
});

// GET /api/challenges/entity-options?work_area= — W8/P2: what the picker offers, localized.
const getEntityOptions = route(async (req) => {
  const ctx = await resolveTenant(req);
  const url = new URL(req.url);
  const workArea = url.searchParams.get('work_area')?.trim() || null;
  const items = await informationOptions(ctx.tenantId, workArea, negotiateLocale(req));
  return jsonResponse({ items });
});

// ⛔ STRICT, AND THE THREE FIELDS ARE THE WHOLE PROMPT INPUT. Nothing else a client sends can reach
// the AI — no dataset, no rows, no notes — because there is nowhere in this body to put it.
const suggestSchema = z
  .object({
    title: z.string().max(140),
    description: z.string().max(8000),
    // Free text like `GET /api/challenges/entity-options`: it only selects the ontology cell
    // (`resolveCell` maps an unknown work area to a same-named department).
    work_area: z.string().min(1).max(40),
  })
  .strict();

// POST /api/challenges/entity-suggestions — W8/P3: the tenant's AI proposes types of information
// from the challenge's title + description only. Suggestions only: the member confirms each one,
// and nothing is linked here. Any failure answers `{ items: [] }`.
const suggestEntities = route(async (req) => {
  const ctx = await resolveTenant(req);
  const body = suggestSchema.parse(await readJson(req));
  if (!body.title.trim() && !body.description.trim()) return jsonResponse({ items: [] });
  const options = await informationOptions(ctx.tenantId, body.work_area, negotiateLocale(req));
  const ids = await suggestInformation({
    userId: ctx.user.id,
    tenantId: ctx.tenantId,
    title: body.title.trim(),
    description: body.description.trim(),
    options,
    signal: req.signal,
  });
  const byId = new Map(options.map((o) => [o.id, o]));
  const items = ids.map((id) => byId.get(id)!).map(({ id, label, description }) => ({ id, label, description }));
  return jsonResponse({ items });
});

// POST /api/challenges/:id/vote — cast (idempotent). DELETE — retract.
const voteChallenge = route(async (req, id) => {
  const user = await validateAuth(req);
  await ensureUser(user);
  const result = await castVote(user.id, 'challenge', id!);
  return jsonResponse(result);
});
const unvoteChallenge = route(async (req, id) => {
  const user = await validateAuth(req);
  const result = await retractVote(user.id, 'challenge', id!);
  return jsonResponse(result);
});

// GET /api/challenges/:id/comments — the discussion thread (oldest first).
const listComments = route(async (req, id) => {
  await validateAuth(req);
  const [c] = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.id, id!));
  if (!c) throw notFound('challenge_not_found', `No challenge '${id}'`);
  const rows = await db
    .select({ id: comments.id, body: comments.body, created_at: comments.created_at, authorName: users.name, authorInitials: users.avatar_initials })
    .from(comments)
    .innerJoin(users, eq(comments.author_id, users.id))
    .where(eq(comments.challenge_id, id!))
    .orderBy(comments.created_at);
  return jsonResponse({
    items: rows.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.created_at,
      author: { name: r.authorName, initials: initialsOf(r.authorName, r.authorInitials) },
    })),
    total: rows.length,
  });
});

// POST /api/challenges/:id/comments — post a reply.
const postComment = route(async (req, id) => {
  const user = await validateAuth(req);
  const body = commentSchema.parse(await readJson(req));
  const [c] = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.id, id!));
  if (!c) throw notFound('challenge_not_found', `No challenge '${id}'`);
  await ensureUser(user);
  const [created] = await db
    .insert(comments)
    .values({ challenge_id: id!, author_id: user.id, body: body.body })
    .returning();
  return jsonResponse(
    {
      id: created!.id,
      body: created!.body,
      createdAt: created!.created_at,
      author: { name: user.name, initials: initialsOf(user.name) },
    },
    201,
  );
});

export function registerChallengeRoutes(router: Router): void {
  router.add('GET', '/api/challenges', listChallenges);
  router.add('POST', '/api/challenges', createChallenge);
  // Before `/api/challenges/:id`, which would otherwise capture `entity-options` as an id.
  router.add('GET', '/api/challenges/entity-options', getEntityOptions);
  router.add('POST', '/api/challenges/entity-suggestions', suggestEntities);
  router.add('GET', '/api/challenges/:id/entities', getChallengeEntities);
  router.add('PUT', '/api/challenges/:id/entities', putChallengeEntities);
  router.add('GET', '/api/challenges/:id', getChallenge);
  router.add('PATCH', '/api/challenges/:id', updateChallengeDatasets);
  router.add('POST', '/api/challenges/:id/vote', voteChallenge);
  router.add('DELETE', '/api/challenges/:id/vote', unvoteChallenge);
  router.add('GET', '/api/challenges/:id/comments', listComments);
  router.add('POST', '/api/challenges/:id/comments', postComment);
}
