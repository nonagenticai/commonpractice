// src/routes/solutions.ts — the marketplace the Solution leaderboard (solutions). Employee Discover
// screens → validateAuth only. A solution is built on a Build flow (flow_id); the
// solution-detail derives its block chain from that flow's persisted graph (no new
// execution — "Open in Build" on the frontend loads the real flow on the S2 canvas).
// Vote toggle is the shared host/vote-service. Registered via registerSolutionRoutes.
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, solutions, challenges, flows, users } from '../db/client';
import { validateAuth } from '../middleware/auth';
import { peekEffectiveTenant } from '../middleware/tenant';
import { getTranslationsBatch } from '../db/translations';
import { translatedMatchSql } from '../db/translation-search';
// slug → the READER'S name for a library block, resolved with the SAME tenant-keyed overlay
// routes/blocks.ts serves the library screen with. Both marketplace DTOs below carry names beside
// the slugs because the browser cannot resolve them: the SPA's slug→name store is fed only by
// /build's palette fetch, so on /solutions it is empty. See that module's header.
import { blockDisplayNames } from '../blocks/block-display-names';
import { negotiateLocale } from '../utils/locale';
import { likeTerm } from '../utils/search';
import { jsonResponse, readJson, route, notFound, unprocessable, badRequest } from '../utils/http';
import { log } from '../host/logger';
import { recordAudit } from '../host/audit-service';
import { OFF_PERIOD_COLUMNS, periodColumns } from '../host/cycle-service';
import { gateOf, requestTenantId, resolveCadence } from '../host/cycle-cadence';
import { laterPeriod, tryPeriodFromKey } from '../host/period';
// The SAME predicate host/vote-service.ts gates the 409 on. One definition, two call sites in this
// file (list + detail) — see the `cycleClosed` note on the list DTO for what it replaced and why.
// `challengeClosedSql` is its sibling for the PARENT row — the submit gate, mirrored onto the
// nested `challenge` DTO below so a screen can grey the submit affordance before the 422.
import { challengeClosedSql, periodClosedSql, SOLUTION_PERIOD } from '../host/cycle-eligibility';
import { castVote, retractVote, votedTargetIds } from '../host/vote-service';
// The MEASURED demo duration — one definition, used by both DTOs in this file. It replaced
// `solutions.demo_seconds`, which was a seeded constant and NULL for every real submission.
import { demoMsForSolutions } from '../host/solution-demo';
import { enqueueTranslations } from '../host/translation-service';
import { ensureUser } from '../services/user-service';
import type { Router } from '../utils/router';
import type { User } from '../types';
import type { FlowGraph } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';
import { validateGraphAgainstBlocks, validateGraphStructure } from '../exec/flow-validate';
import {
  resolveExecutableBlocks,
  graphContentHash,
  type PublishedBlockManifestEntry,
} from '../host/publication-service';
import { enforceRunPolicies } from '../host/run-policy';
import { getSnapshot } from '../host/policy-store';

const PAGE_SIZE = 10;

// UUID standard: we GENERATE UUIDv7 (time-ordered) for new IDs (schema.ts `uuidv7()` defaults +
// Bun.randomUUIDv7()), but VALIDATE with version-agnostic `.uuid()` on purpose: existing rows hold
// v4 IDs and tenant IDs are mixed-version across services (license-authz accepts any UUID version),
// so a v7-strict check would 400 on legitimate IDs. Generation = v7; validation = any-version.
const createSolutionSchema = z
  .object({
    challenge_id: z.string().uuid(),
    title: z.string().min(1).max(160),
    flow_id: z.string().uuid().optional(),
    // ⛔ NO `build_time_minutes` AND NO `demo_seconds`. Both are gone from the product, and the
    // schema is `.strict()`, so sending either is now a 400 rather than a silently stored figure.
    //   • build time had no honest source at all — see the comment on the column in db/schema.ts.
    //   • demo time is now MEASURED, not declared: `flow_runs.solution_id` (0065) →
    //     `host/solution-demo.ts`. A client-supplied duration is exactly the self-report that
    //     replaced.
    blocks_used: z.array(z.string().max(60)).max(40).optional(),
  })
  .strict();

/**
 * One node of a solution's rendered block chain.
 *
 * ⛔ BOTH HALVES ARE LOAD-BEARING AND NEITHER REPLACES THE OTHER. `slug` is the LINK TARGET
 * (`/block-edit?slug=…`) and the machine identity of the node — `RunConsole` prints slugs on purpose
 * and must keep being able to. `name` is the only half a reader can read: `FlowChain.svelte`
 * rendered `{slug}` inside a fully localized card, so a Dutch reader met `read-claim-form →
 * ai-summarize` under a Dutch heading. Sending only the name would break the link; sending only the
 * slug is the defect.
 */
interface SolutionChainNode {
  slug: string;
  name: string;
}

/**
 * `blocks_used` off the row, as the `string[]` the column is declared to hold.
 *
 * The only writer is `createSolutionSchema` (`z.array(z.string())`), so a non-array is unreachable
 * through the API — but this reads a `jsonb` column whose TYPE is a promise the database does not
 * keep, and the two call sites below both `.map()` over it. An `Array.isArray` here is one line;
 * a `TypeError` out of a `.map()` is a 500 on the leaderboard.
 */
function blocksUsedOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

function initialsOf(name: string, stored?: string | null): string {
  if (stored) return stored;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}


// GET /api/solutions?challenge_id=&q=&page= — solution leaderboard (ranked by votes).
const listSolutions = route(async (req) => {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const challengeId = url.searchParams.get('challenge_id');
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  // Reject a malformed challenge_id explicitly (400) rather than silently
  // returning an empty leaderboard for a non-UUID value.
  if (challengeId !== null && !z.string().uuid().safeParse(challengeId).success) {
    throw badRequest('invalid_challenge_id', 'challenge_id must be a UUID');
  }

  // Server-side search over title ∪ author name ∪ block slug. It used to be a client-side
  // `.filter()` over the ten rows the page had already loaded, so a builder at rank 14 was
  // reported as "no match" by a search box that had never seen their row. Mirrors the shape in
  // routes/challenges.ts, widened to the two columns this board actually shows beside the title.
  //
  // `blocks_used` is `jsonb NOT NULL DEFAULT '[]'` holding a string[], so the slug arm is a
  // lateral over `jsonb_array_elements_text` — there is no scalar column to ILIKE.
  //
  // ⚠️ ONE PREDICATE, TWO COLUMN SETS. The rows query reads these three values off the ranking
  // SUBQUERY (below) and the count query reads them off the base tables, so the predicate is a
  // function of its columns rather than two hand-copied `or(...)` blocks that can drift apart.
  // A count built on a different predicate than the rows is a pager promising pages that do not
  // exist — the exact trap the previous revision documented.
  //
  // ⛔ A `blocks_used` holding a non-array JSON value would make `jsonb_array_elements_text`
  // error and 500 the search. Unreachable through the API — the only writer is
  // `createSolutionSchema`, whose `blocks_used` is `z.array(z.string())` — so it stays latent and
  // untouched rather than being papered over with a `jsonb_typeof` guard here.
  //
  // ⛔ THE TITLE ARM SEARCHES THE TITLE THIS ROUTE RENDERS. The response's `title` is OVERLAID
  // from `content_translations` (below), so matching the EN base column alone meant a reader on
  // `nl` searching the Dutch title they were looking at got an empty board and `total: 0`. The
  // fourth arm asks the reader's own edition — one correlated EXISTS (db/translation-search.ts),
  // which is what keeps it out of the FROM clause: `ranked` carries a `row_number()` window and a
  // join that duplicated a row would renumber the leaderboard. The base arm STAYS (a reader may
  // type the English product term); on `en` the arm is `undefined` and `or()` drops it.
  //
  // The id column is passed for the same "one predicate, two column sets" reason as the other
  // three: the rows query reads it off `ranked`, the count query off `solutions`.
  const locale = negotiateLocale(req);

  // ⛔ ONE escaped pattern for ALL FOUR arms. `%` and `_` are ILIKE metacharacters, so the raw
  // `` `%${q}%` `` this used to repeat four times let a builder searching for a solution called
  // `Korting 100% eraf` match every title containing `Korting 100`. utils/search.ts owns the
  // escape; no `ESCAPE` clause is needed because `\` is Postgres's default LIKE escape character
  // and the pattern below is always a BIND PARAMETER, including inside the `sql` template (which
  // parameterises `${}` interpolations of plain values rather than splicing them into the text).
  // The `translatedMatchSql` arm takes a COMPLETE pattern by contract (db/translation-search.ts),
  // so it gets the same string — four arms that escape differently would match different rows.
  const like = q ? likeTerm(q) : '';

  type SearchColumn = Parameters<typeof ilike>[0];
  const searchOver = (
    id: SearchColumn,
    title: SearchColumn,
    authorName: SearchColumn,
    blocksUsed: SearchColumn,
  ) =>
    q
      ? or(
          ilike(title, like),
          ilike(authorName, like),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${blocksUsed}) AS b(slug) WHERE b.slug ILIKE ${like})`,
          translatedMatchSql('solution', id, locale, ['title'], like),
        )
      : undefined;

  const boardScope = challengeId ? eq(solutions.challenge_id, challengeId) : undefined;

  // The selected challenge (for the page header), if scoped — title localized.
  let challenge: { id: string; code: string | null; title: string } | null = null;
  if (challengeId) {
    const [c] = await db.select({ id: challenges.id, code: challenges.code, title: challenges.title }).from(challenges).where(eq(challenges.id, challengeId));
    if (c) {
      const chTx = (await getTranslationsBatch('challenge', [c.id], locale, ['title'])).get(c.id) ?? {};
      challenge = { ...c, title: chTx.title ?? c.title };
    }
  }

  // ⚠️ RANK IS A PROPERTY OF THE BOARD, NOT OF THE RESULT SET. It used to be computed from the
  // row's position in the response (`(page-1)*PAGE_SIZE + i + 1`). That was true while the only
  // filter was the challenge, and became a LIE the moment `q` joined the predicate: searching for
  // the builder sitting at rank 14 returned their row as the only hit and the board stamped a
  // coral "#1" on it. A search box that fabricates a leaderboard is worse than the unreachable
  // row it was added to fix, on a page whose entire purpose is ranking.
  //
  // So the number is computed by a window over the UNFILTERED board (challenge scope only) and the
  // search filters the ranked set from the outside. `row_number` rather than `rank` because the
  // ordering below is TOTAL (id breaks any votes+created_at tie), which also makes limit/offset
  // paging stable — two rows on identical votes and timestamps could previously swap between the
  // page-1 and page-2 queries and be shown twice or not at all.
  const ranked = db
    .select({
      id: solutions.id,
      // The parent's id comes off `solutions` itself — no join, so `ranked` still reads exactly one
      // table plus `users`, and the window below is computed over precisely the row set it was
      // before this change. The parent's STATUS needs the challenges table and is joined OUTSIDE
      // this subquery; see the leftJoin on the row query for why it must not happen in here.
      challenge_id: solutions.challenge_id,
      title: solutions.title,
      status: solutions.status,
      // The week THIS ROW competes in, carried out of the subquery so `cycleClosed` can be computed
      // OUTSIDE it (see the note on the row query below). Selecting one more column of the same
      // table adds no join and drops no row, so the window function above is computed over exactly
      // the row set it was before — which is the property that the leftJoin note protects.
      week: solutions.week,
      period_kind: solutions.period_kind,
      period_start: solutions.period_start,
      // 0110: the vote gate correlates the cycle rows on the ROW's tenant (cycles are per tenant).
      tenant_id: solutions.tenant_id,
      votes_count: solutions.votes_count,
      blocks_used: solutions.blocks_used,
      flow_id: solutions.flow_id,
      created_at: solutions.created_at,
      authorName: users.name,
      authorInitials: users.avatar_initials,
      rank: sql<number>`(row_number() over (order by ${solutions.votes_count} desc, ${solutions.created_at} desc, ${solutions.id} asc))::int`.as(
        'rank',
      ),
    })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(boardScope)
    .as('ranked');

  // ⛔ THE PARENT CHALLENGE JOINS **HERE**, OUTSIDE `ranked`, AND AS A **LEFT** JOIN. Both halves
  // of that are deliberate; an innerJoin inside the subquery is the obvious version and is wrong.
  //
  // WHY NOT INSIDE `ranked`: `rank` is `row_number() over (…)` computed across whatever rows that
  // subquery yields. Any join that can drop a row therefore does not merely hide it — it RENUMBERS
  // every row beneath it, and the board silently re-ranks itself. (This file already carries the
  // scar: the rank used to be the response offset, and a `#1` badge appeared on the row at real
  // rank 14 the moment `q` entered the predicate.) Joining outside means the window function never
  // sees the challenges table at all, so ranks are bit-for-bit what they were before this change.
  //
  // WHY LEFT AND NOT INNER: `solutions.challenge_id` is `NOT NULL REFERENCES challenges(id)` and
  // `challenges.id` is the primary key, so at the SCHEMA level the match is provably exactly one
  // row. But `challenges` carries RLS (`0028_rls.sql` §4a: `USING (tenant_id =
  // app_current_tenant_uuid())`), and a solution's tenant equals its challenge's tenant only by
  // CONVENTION — the column default plus the 0028 backfill — never by a database constraint. An
  // inner join would stake the row's very existence on an invariant nothing enforces. A left join
  // degrades a (hypothetical) violation to `challengeStatus: null`, which the browser reads as
  // "unknown" and answers with no claim in either direction. Rows and ranks cannot move.
  //
  // NOTE the `total` count query below is deliberately NOT touched: it never learns the join
  // exists, so `total` is unchanged by construction.
  // The vote gate, evaluated ONCE per request so every row on the page is judged at the same
  // instant (and so a board rendered across a period boundary cannot show two different rules).
  // 0110: the CALLER's tenant's gate — under RLS every row on this board is that tenant's.
  const gate = gateOf(await resolveCadence(new Date(), requestTenantId()));

  const rows = await db
    .select({
      id: ranked.id,
      challenge_id: ranked.challenge_id,
      title: ranked.title,
      status: ranked.status,
      // NULL only if the parent is invisible to this caller — see the leftJoin note above.
      challengeStatus: challenges.status,
      // ⛔ COMPUTED IN THE **OUTER** SELECT, NEVER INSIDE `ranked`. The subquery carries a
      // `row_number() over (…)` window; anything added in there that could change its row set
      // renumbers the whole board (read the warning above the subquery — this file already shipped
      // that bug once). Out here the window is closed and this is just a scalar per surviving row.
      cycleClosed: periodClosedSql({ kind: ranked.period_kind, start: ranked.period_start, tenant: ranked.tenant_id }, gate),
      votes_count: ranked.votes_count,
      blocks_used: ranked.blocks_used,
      flow_id: ranked.flow_id,
      authorName: ranked.authorName,
      authorInitials: ranked.authorInitials,
      rank: ranked.rank,
    })
    .from(ranked)
    .leftJoin(challenges, eq(ranked.challenge_id, challenges.id))
    .where(searchOver(ranked.id, ranked.title, ranked.authorName, ranked.blocks_used))
    .orderBy(asc(ranked.rank))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const voted = await votedTargetIds(user.id, 'solution', rows.map((r) => r.id));
  const solTx = await getTranslationsBatch('solution', rows.map((r) => r.id), locale, ['title']);
  // ⛔ HERE, AFTER `rows` LAND — NEVER INSIDE `ranked`. Same rule as `votedTargetIds` above and for
  // the same reason: `ranked` carries a `row_number() over (…)` window, so anything joined in there
  // that can drop a row RENUMBERS the whole board (the warning above the subquery spells out the
  // bug this file already shipped once). This is a keyed lookup over the ids of the rows that
  // survived, computed with the window long closed.
  //
  // It replaced `solutions.demo_seconds`, a seeded constant that was NULL for every solution a real
  // person submitted. `host/solution-demo.ts` measures it from the solution's own runs instead —
  // read that file's header before changing the join key. Absent ⇒ `null`, never `0`.
  const demoMs = await demoMsForSolutions(rows.map((r) => r.id), await peekEffectiveTenant(req));

  // ⛔ THE READER'S NAMES FOR THE SLUGS THIS BOARD PRINTS, in ONE lookup for the whole page — the
  // same "after `rows` land, never inside `ranked`" rule as `votedTargetIds` and `solTx` above, and
  // for the same reason. `+page.svelte` renders `blocksUsed` as `solutions_built_with({ blocks })`,
  // i.e. English identifiers inside a Dutch sentence. `blocksUsed` itself STAYS on the wire: it is
  // what the `?q=` slug arm searches, and an older SPA is still reading it.
  const listBlockNames = await blockDisplayNames(
    rows.flatMap((r) => blocksUsedOf(r.blocks_used)),
    locale,
  );

  const items = rows.map((r) => ({
    id: r.id,
    // The board rank, NOT the offset into this response. Identical with and without `?q=`.
    rank: r.rank,
    title: solTx.get(r.id)?.title ?? r.title,
    status: r.status,
    challengeId: r.challenge_id,
    // ⚠️ NOT AN ANSWER TO "will a vote on this row land?" — `cycleClosed` is. This says whether the
    // parent challenge still accepts NEW SOLUTIONS: `createSolution` below refuses
    // `challenge_closed` on exactly this value. It is also still the honest thing to show beside a
    // row ("the challenge behind this is over"), and `null` still means the parent is invisible to
    // this caller rather than open — see the leftJoin note above.
    //
    // It USED to be the vote gate, because `vote-service.loadTarget` joined through to it. That is
    // the defect this field's neighbour exists to fix; see `cycleClosed`.
    challengeStatus: r.challengeStatus,
    // ⛔ THE FIELD THAT ANSWERS "will a vote on this row land?". `host/vote-service.ts` `loadTarget`
    // throws `409 voting_closed` on precisely this predicate (`weekClosedSql`, the shared
    // definition in host/cycle-eligibility.ts) — a property of the CYCLE THIS SOLUTION COMPETES IN,
    // not of its parent challenge and not of `solutions.status` (which `closeCycle` leaves at
    // 'voting' on every loser forever). Never `null`: the predicate is total, computed off a
    // NOT NULL column on a row we already have, with no join that can fail to match.
    cycleClosed: r.cycleClosed,
    votesCount: r.votes_count,
    // The MEASURED duration of this solution's most recent successful demo run, in milliseconds.
    // `null` when nobody has run it — absence, not `0`. Milliseconds and not seconds on purpose:
    // a 2-block flow finishes in a few hundred ms, and rounding server-side re-creates the
    // /pipeline "AVG TIME TO LIVE —" bug (a 41-minute interval sent as whole days arrived as 0,
    // and the page read that magnitude as a data-existence test). The unit is the browser's
    // decision — `frontend/src/lib/utils/format.ts` `demoDuration`.
    demoMs: demoMs.get(r.id) ?? null,
    blocksUsed: r.blocks_used,
    // ⛔ AN ADDITIVE FIELD, NOT A REPLACEMENT, AND THAT IS THE WIRE-COMPAT DECISION. Same length and
    // same order as `blocksUsed`. An OLD SPA ignores it and renders slugs exactly as it does today;
    // a NEW SPA against an OLD API finds it `undefined` and falls back to `blocksUsed`, which is
    // also exactly today. Rewriting `blocksUsed` in place would have broken neither renderer but
    // WOULD have changed what `?q=` matches against for anyone reading the two as the same list.
    // ⚠️ A slug the library no longer holds keeps its slug here rather than vanishing: the count of
    // blocks a solution was built with is a fact, and dropping one silently would understate it.
    blocksUsedNames: blocksUsedOf(r.blocks_used).map((slug) => listBlockNames.get(slug) ?? slug),
    hasFlow: r.flow_id != null,
    hasVoted: voted.has(r.id),
    author: { name: r.authorName, initials: initialsOf(r.authorName, r.authorInitials) },
  }));

  // Real count over the same predicate (RLS scopes it per-tenant), matching the
  // sibling list endpoints — the previous estimate over-/under-counted on every
  // non-last page.
  //
  // ⚠️ THE JOIN IS LOAD-BEARING, not decoration. `where` now carries an author-name arm
  // (`users.name`), so a count that selected from `solutions` alone would reference a table that
  // is not in its own FROM clause — a hard SQL error under a search, and (worse, if it were ever
  // "fixed" by dropping the arm) a `total` that counted rows the page never returns, promising
  // pages that do not exist. The rows query and the count query share one predicate and therefore
  // must share one shape.
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(
      and(
        boardScope,
        searchOver(solutions.id, solutions.title, users.name, solutions.blocks_used),
      ),
    );
  return jsonResponse({ items, total, page, pageSize: PAGE_SIZE, challenge });
});

// GET /api/solutions/:id — detail: flow chain + comparison bars + hasVoted.
const getSolution = route(async (req, id) => {
  const user = await validateAuth(req);
  const [s] = await db
    .select({
      id: solutions.id,
      challenge_id: solutions.challenge_id,
      title: solutions.title,
      status: solutions.status,
      week: solutions.week,
      votes_count: solutions.votes_count,
      blocks_used: solutions.blocks_used,
      flow_id: solutions.flow_id,
      published_graph: solutions.published_graph,
      created_at: solutions.created_at,
      authorName: users.name,
      authorInitials: users.avatar_initials,
      // The vote gate — the SAME `periodClosedSql` the list route computes and the SAME one
      // `host/vote-service.ts` 409s on. Two call sites in this file, one definition; the reason
      // that matters is written out on the list DTO's `cycleClosed`.
      cycleClosed: periodClosedSql(SOLUTION_PERIOD, gateOf(await resolveCadence(new Date(), requestTenantId()))),
    })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(eq(solutions.id, id!));
  if (!s) throw notFound('solution_not_found', `No solution '${id}'`);

  const locale = negotiateLocale(req);
  const sTitle = (await getTranslationsBatch('solution', [s.id], locale, ['title'])).get(s.id)?.title ?? s.title;

  // `status` + `week` join the three fields already read here. NO JOIN AND NO EXTRA QUERY: this
  // select already existed for the code/title chip. `status` is what decides whether the challenge
  // still takes NEW SOLUTIONS (`createSolution`'s `challenge_closed` guard below) — it is NO LONGER
  // what decides whether a vote lands; `cycleClosed` on the solution itself is. `week` is the
  // parent's OWN cycle week, which is NOT `solutions.week` — that one is
  // `laterPeriod(current, challenge period)` at insert time, i.e. the week the SOLUTION competes in,
  // rolled forward when it answers an older challenge. Anyone reaching for `solutions.week` as a
  // stand-in for the parent's week is wrong in exactly the cases that matter.
  //
  // A missing `ch` is already handled below (`challenge: ch ? … : null`) — that path exists because
  // `challenges` is RLS-scoped, so this stays a read that can legitimately return nothing.
  const [ch] = await db
    .select({
      id: challenges.id,
      code: challenges.code,
      title: challenges.title,
      status: challenges.status,
      week: challenges.week,
      // ⛔ THE FIELD THAT ANSWERS "can I still submit a solution to this challenge?" — the SAME
      // `challengeClosedSql` the submit guard refuses `challenge_closed` on and the same one the
      // board's `?open=` filter is built from. `status` beside it is NOT that answer: it lags the
      // cycle by up to a tick, which is how prod accepted a solution onto a June challenge. A
      // "Submit a solution" button wired to `status` invites a click the server refuses.
      cycleClosed: challengeClosedSql(),
    })
    .from(challenges)
    .where(eq(challenges.id, s.challenge_id));
  const chTitle = ch ? ((await getTranslationsBatch('challenge', [ch.id], locale, ['title'])).get(ch.id)?.title ?? ch.title) : null;

  // The author's flow → its block chain (derived from the persisted graph nodes).
  //
  // ⛔ TWO DEFECTS FIXED HERE, AND THEY ARE INDEPENDENT.
  //
  // (1) THE CHAIN CARRIED SLUGS ONLY. `chain: nodes.map((n) => n.slug)` fed `FlowChain.svelte`,
  //     which rendered `{slug}` — so `read-claim-form → group-and-count → ai-summarize` sat inside a
  //     fully Dutch card, on the marketplace SHOWCASE screen. It is the sixth render site of a block
  //     name and the only one the browser cannot repair on its own: the SPA's slug→name store is
  //     published exclusively by /build's `loadPalette()`, so on this route it holds nothing. The
  //     name therefore resolves HERE, where the catalogue and `negotiateLocale` already are.
  //
  // (2) NO NODE-KIND FILTER. `blocks_used` has been filtered by the builder since Phase 5
  //     (`isBlockKind`, routes/build/+page.svelte:816) and this was its unfiltered sibling: a flow
  //     with a loop put the literal control-flow token `foreach` on the board as if it were a block,
  //     linking to `/block-edit?slug=foreach` — a 404 the library has never had a row for.
  //     `!== 'foreach'` and not `=== 'block'`: `kind` is OPTIONAL on the wire (db/flow-types.ts) and
  //     every pre-Phase-5 node carries none, so a positive test would empty the whole legacy corpus.
  //     Same condition, same polarity, as `resolveExecutableBlocks` (host/publication-service.ts:25)
  //     applies to the same graph on the submit path.
  //
  // THE FALLBACK ORDER IS `blockNodeLabel`'S, deliberately — catalogue name, then the label frozen
  // into `flows.graph`, then the slug. A stale name is still a name a human wrote; the slug is the
  // last rung and a rung, not a bug (a chip with no title is worse than an English identifier).
  const detailBlocksUsed = blocksUsedOf(s.blocks_used);
  const published = s.published_graph as FlowGraph | null;
  const chainNodes = published ? (published.nodes ?? []).filter((n) => n.kind !== 'foreach') : [];
  // ONE lookup for BOTH surfaces this DTO feeds — the chain card and the no-flow `blocksUsed` line.
  // The two sets overlap almost entirely (`blocks_used` is the same node slugs, denormalised at
  // submit time), so a second call would be a second round-trip for the same rows.
  const detailNames = await blockDisplayNames(
    [...detailBlocksUsed, ...chainNodes.map((n) => n.slug)],
    locale,
  );

  let flow: { id: string; name: string; chain: SolutionChainNode[] } | null = null;
  // `published` in the guard as well as `f`: without a published graph there is no chain to build,
  // so the flows read below is pure cost. Behaviour is unchanged — that case already yielded `null`.
  if (s.flow_id && published) {
    const [f] = await db.select({ id: flows.id, name: flows.name }).from(flows).where(eq(flows.id, s.flow_id));
    if (f) {
      flow = {
        id: f.id,
        name: f.name,
        chain: chainNodes.map((n) => ({
          slug: n.slug,
          name: detailNames.get(n.slug) ?? (n.label?.trim() ? n.label : n.slug),
        })),
      };
    }
  }

  // Comparison bars: the top-5 solutions for this challenge, percent of the leader.
  const peers = await db
    .select({ id: solutions.id, votes_count: solutions.votes_count, authorName: users.name })
    .from(solutions)
    .innerJoin(users, eq(solutions.author_id, users.id))
    .where(eq(solutions.challenge_id, s.challenge_id))
    .orderBy(desc(solutions.votes_count), desc(solutions.created_at))
    .limit(5);
  const leader = peers[0]?.votes_count ?? s.votes_count ?? 1;
  const comparison = peers.map((p, i) => ({
    rank: i + 1,
    id: p.id,
    author: p.authorName,
    votesCount: p.votes_count,
    pct: leader > 0 ? Math.round((p.votes_count / leader) * 100) : 0,
    isThis: p.id === s.id,
  }));

  const voted = await votedTargetIds(user.id, 'solution', [s.id]);
  // Same measured figure as the list DTO, from the same helper — one definition, two call sites.
  // See the note beside the list route's `demoMs`.
  const demoMs = (await demoMsForSolutions([s.id], await peekEffectiveTenant(req))).get(s.id) ?? null;

  return jsonResponse({
    id: s.id,
    title: sTitle,
    status: s.status,
    week: s.week,
    // ⛔ The vote gate — see the list DTO's `cycleClosed`. Both DTOs carry it because both screens
    // render a vote pill, and a pill wired to `challenge.status` invites a click the server refuses.
    cycleClosed: s.cycleClosed,
    votesCount: s.votes_count,
    hasVoted: voted.has(s.id),
    demoMs,
    blocksUsed: s.blocks_used,
    // The reader's names for the same list, same order — see the list DTO's `blocksUsedNames` for
    // why this is an ADDITIVE field rather than an overwrite. Rendered by the no-flow branch of
    // `/solutions/[id]` (`blocksUsed.join(' · ')`), which printed English slugs in a Dutch card.
    blocksUsedNames: detailBlocksUsed.map((slug) => detailNames.get(slug) ?? slug),
    createdAt: s.created_at,
    author: { name: s.authorName, initials: initialsOf(s.authorName, s.authorInitials) },
    challenge: ch ? { ...ch, title: chTitle } : null,
    flow,
    comparison,
  });
});

// POST /api/solutions — submit a solution for a challenge (optionally links a flow).
const createSolution = route(async (req) => {
  const user = await validateAuth(req);
  const body = createSolutionSchema.parse(await readJson(req));
  await ensureUser(user);

  // ONE instant for the whole request: the gate below and the `week` stamped on the insert are
  // two halves of the same decision, and reading the clock twice across an ISO-week boundary would
  // let a submission be admitted by one week and filed into another.
  const now = new Date();
  // The period this submission is filed into: the effective cadence's current period, or none at
  // all when the cadence is OFF (host/cycle-cadence.ts).
  // 0110: the tenant the solution is filed into (its `tenant_id` defaults to this request's scope).
  const cadence = await resolveCadence(now, requestTenantId());

  const [ch] = await db
    .select({
      id: challenges.id,
      status: challenges.status,
      week: challenges.week,
      // ⛔ THE WEEK ARM IS GONE ON PURPOSE — this used to also select
      // `cycleClosed: weekClosedSql(challenges.week, currentWeek)` and refuse on it. That is the
      // single line that turned "a human solves an old challenge months later" into a 422, which is
      // precisely the behaviour the product owner ruled out: a challenge may sit unsolved for
      // months and is still open. `status` is now the whole gate. See `challengeClosedSql`'s header.
    })
    .from(challenges)
    .where(eq(challenges.id, body.challenge_id));
  if (!ch) throw unprocessable('challenge_not_found', `No challenge '${body.challenge_id}'`);
  // A challenge takes no more solutions only once it has been EXPLICITLY closed. The age of its
  // week is not evidence of anything: at a large company a challenge can wait months for someone
  // with the right expertise, and that is the normal case.
  //
  // The solution is still stamped with the CURRENT week below, so it competes in this week's cycle
  // even when it answers an older challenge — `laterWeek` already handles exactly that, and it is
  // what makes solving an old challenge meaningful rather than a submission into a dead cycle.
  //
  // The code stays `challenge_closed` — the frontend already asserts it
  // (frontend/src/lib/api/solutions.create.test.ts) and a rename buys the user nothing.
  if (ch.status === 'closed') {
    throw unprocessable(
      'challenge_closed',
      `Challenge '${body.challenge_id}' has been closed and takes no new solutions.`,
    );
  }

  let sourceFlow: typeof flows.$inferSelect | null = null;
  let publishedGraph: FlowGraph | null = null;
  let publishedManifest: PublishedBlockManifestEntry[] = [];
  let publishedHash: string | null = null;
  if (body.flow_id) {
    // A linked flow must be one the caller owns (404-as-unprocessable otherwise).
    const [f] = await db.select().from(flows).where(and(eq(flows.id, body.flow_id), eq(flows.owner_id, user.id)));
    if (!f) throw unprocessable('flow_not_found', `No owned flow '${body.flow_id}'`);
    if (f.status === 'archived') throw unprocessable('flow_archived', 'An archived flow cannot be submitted');
    sourceFlow = f;
    publishedGraph = f.graph as FlowGraph;

    const resolved = await resolveExecutableBlocks(publishedGraph);
    const descriptors = new Map<string, BlockDescriptor>(
      resolved.versions.map((version) => [version.id, version.descriptor]),
    );
    const validation = [
      ...validateGraphStructure(publishedGraph).issues,
      ...validateGraphAgainstBlocks(publishedGraph, descriptors).issues,
    ];
    if (validation.length) {
      throw unprocessable('flow_invalid', 'The flow is not ready to publish.', { issues: validation });
    }
    const policyViolation = enforceRunPolicies(publishedGraph, descriptors, await getSnapshot());
    if (policyViolation) {
      throw unprocessable(policyViolation.code, policyViolation.reason, {
        policyKey: policyViolation.policyKey,
        // ONE detail name across the whole submit path — publication-service.ts uses `blockSlug`
        // too, so the SPA has a single field to read rather than a per-code lookup table.
        blockSlug: policyViolation.nodeSlug,
      });
    }
    publishedManifest = resolved.manifest;
    publishedHash = await graphContentHash(publishedGraph);
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(solutions).values({
      challenge_id: body.challenge_id,
      title: body.title,
      author_id: user.id,
      flow_id: body.flow_id ?? null,
      published_graph: publishedGraph,
      published_manifest: publishedManifest,
      published_hash: publishedHash,
      published_at: publishedGraph ? new Date() : null,
      published_by: publishedGraph ? user.id : null,
      status: 'voting',
      // The ISO week this solution competes in. `week` was omitted entirely here, so every
      // user-submitted solution took the column default '' and the weekly close (`where week =
      // '2026-W30'`) could never see it — the reason the engine announced no winner for seven
      // consecutive weeks.
      //
      // Normally the CREATION week, not the challenge's: the phase clock is ISO-week-aligned
      // (cycle-service weekStart/boundariesFor, close at weekStart+7d), so the cycle that judges
      // this row is the one running when it was submitted. Always taking the challenge's week
      // would file solutions into an already-closed week whenever someone answers an older
      // challenge — never judged at all.
      //
      // The `max` is for challenges `challengeWeekFor` rolled FORWARD: one created during
      // solution_phase is stamped W+1 but appears on the board immediately, so a solution
      // submitted to it during W would otherwise be judged a week BEFORE its own challenge
      // closes — crowning "this week's winner" for a challenge still open for voting. A solution
      // can never compete earlier than the challenge it answers. ISO week strings sort
      // lexicographically in chronological order, so a plain `>` is the whole comparison.
      // 0107: periods, compared by START (`laterPeriod`) — and only against a challenge period of
      // the SAME kind; with the cadence OFF the row is filed with no period at all.
      ...(cadence.current ? periodColumns(laterPeriod(cadence.current, tryPeriodFromKey(ch.week))) : OFF_PERIOD_COLUMNS),
      blocks_used: body.blocks_used ?? [],
      votes_count: 0,
    }).returning();
    if (sourceFlow) {
      await tx.update(flows).set({ status: 'submitted', updated_at: new Date() }).where(eq(flows.id, sourceFlow.id));
    }
    // ⛔ THE ONLY REMAINING WRITER OF `challenges.status`. The calendar-driven writers in
    // host/cycle-service.ts are gone — the product owner ruled the calendar must not decide a
    // challenge's phase. What decides it now: `solution_phase` iff the challenge has at least one
    // solution, `voting` otherwise. This insert is the moment that fact becomes true for the FIRST
    // solution, so this is where it gets written — in the SAME transaction as the insert, so a
    // rolled-back insert can never leave a challenge advanced with zero solutions to show for it.
    //
    // `eq(challenges.status, 'voting')` is load-bearing, not a micro-optimisation: it makes the
    // write IDEMPOTENT for the 2nd..Nth solution (already 'solution_phase' ⇒ 0 rows touched), and
    // it means this can never DEMOTE a 'solution_phase' row back to 'voting' nor resurrect a
    // 'closed' one into either — 'closed' simply never matches the guard.
    await tx
      .update(challenges)
      .set({ status: 'solution_phase', updated_at: new Date() })
      .where(and(eq(challenges.id, body.challenge_id), eq(challenges.status, 'voting')));
    return row!;
  });

  await recordAudit({
    actorId: user.id,
    action: 'solution.submit',
    category: 'block',
    targetType: 'solution',
    targetId: created.title,
    result: 'In voting',
    resultTone: 'ok',
  });

  // Phase 2-G: queue the solution title for translation (best-effort).
  try {
    await enqueueTranslations(
      'solution',
      created.id,
      [{ field: 'title', value: created.title }],
      user.id,
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', { entity: 'solution', entityId: created.id, err: e });
  }

  return jsonResponse(created, 201);
});

// `new Date()` is passed EXPLICITLY rather than left to the default so the request's instant is
// visible at the route — the gate `castVote` applies is `periodClosedSql(period, gate(now))`, and
// a reader following the vote path should be able to see where `now` enters it.
const voteSolution = route(async (req, id) => {
  const user = await validateAuth(req);
  await ensureUser(user);
  return jsonResponse(await castVote(user.id, 'solution', id!, new Date()));
});
const unvoteSolution = route(async (req, id) => {
  const user = await validateAuth(req);
  return jsonResponse(await retractVote(user.id, 'solution', id!, new Date()));
});

export function registerSolutionRoutes(router: Router): void {
  router.add('GET', '/api/solutions', listSolutions);
  router.add('POST', '/api/solutions', createSolution);
  router.add('GET', '/api/solutions/:id', getSolution);
  router.add('POST', '/api/solutions/:id/vote', voteSolution);
  router.add('DELETE', '/api/solutions/:id/vote', unvoteSolution);
}
