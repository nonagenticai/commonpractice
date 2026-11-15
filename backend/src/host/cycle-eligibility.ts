// src/host/cycle-eligibility.ts — the ONE definition of "which solutions are competing
// this week, and in what order do they rank".
//
// WHY THIS FILE EXISTS. `closeCycle` picks the winner from `(week, tenant, status ∈
// {voting,shipping})` ordered `votes desc, created_at asc, id asc`. `/api/winner`'s
// honourable-mentions list carried NONE of that: it ranked every solution on the winning
// challenge, of any week and any status, by votes alone. Against real prod rows the page
// therefore announced a 0-vote W32 winner directly above three W23 rows at 316/271/234 —
// three "runners-up" that had never competed against the winner at all. Two queries that
// answer the same question must not be two queries.
//
// ⛔ IMPORT DISCIPLINE. This module imports ONLY `drizzle-orm` + `db/client`. A *reader*
// (marketplace-summary) must not drag the *closer*'s graph — `enqueueWinner`, `recordAudit`,
// `config` — behind it just to ask "who is eligible". Keep it that way; if you find yourself
// importing cycle-service here, the dependency is pointing the wrong way.
//
// ⚠️ `tenantId` is a PARAMETER, NOT A MODE. That is how the asymmetry between the two callers
// is expressed rather than hidden: `marketplace-summary` reads under the CALLER'S RLS and
// passes the caller's tenant as belt-and-braces; `cycle-service` runs as SYSTEM (owner pool,
// no `app.current_tenant` GUC — see cycle-service.ts:188-191) where RLS narrows nothing and
// every query MUST carry its own tenant predicate. `null` means "no explicit tenant predicate",
// which is only ever correct when something else is doing the scoping.
import { and, asc, desc, eq, getTableName, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db as defaultDb, challenges, marketplaceCycles, solutions } from '../db/client';
import type { WeeklyWinnerStats } from '../db/schema';
// Pure + dependency-free (period.ts) and TYPE-only (cycle-cadence.ts) — the discipline above holds.
import { periodFromKey } from './period';
import type { PeriodGate } from './cycle-cadence';

type Db = typeof defaultDb;
/** Either the pool `db` or a drizzle transaction handle — `closeCycle` composes its stats
 *  read into the SAME transaction as the winner write, so the aggregate it stamps and the
 *  winner it stamps it beside can never come from two different snapshots. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The solution statuses that are competing in a week. `draft` has not entered the vote yet
 * and `archived` has left it; neither can win, so neither may be shown as a runner-up.
 */
export const CYCLE_ELIGIBLE_STATUSES = ['voting', 'shipping'] as const;

/**
 * The candidate-set predicate: this period, (optionally) this tenant, competing status.
 *
 * ⚠️ `solutions.week` is `text NOT NULL DEFAULT ''` (pre-0047 rows still carry the empty
 * string). `eq(week, '')` is therefore not "no rows" — it is EVERY legacy row in the table,
 * which on the winner page reads as a fabricated field of runners-up. There is no safe
 * predicate for a falsy week, so this throws rather than quietly returning one: the caller
 * must short-circuit to `[]` before it gets here. Callers that can see a falsy week do
 * exactly that; see routes/marketplace-summary.ts.
 */
export function eligibleForPeriod(key: string, tenantId: string | null) {
  if (!key) {
    throw new Error(
      'eligibleForPeriod: refusing to build a predicate for an empty period key — ' +
        "solutions.week defaults to '' so an empty key would match every legacy row. Short-circuit at the call site.",
    );
  }
  // 0107: matched on (period_kind, period_start), not on the `week` text. The key is parsed (and
  // validated) here so a caller holding only a stored key still gets the exact period.
  const p = periodFromKey(key);
  return and(
    eq(solutions.period_kind, p.kind),
    eq(solutions.period_start, p.start),
    inArray(solutions.status, [...CYCLE_ELIGIBLE_STATUSES]),
    ...(tenantId ? [eq(solutions.tenant_id, tenantId)] : []),
  );
}

/**
 * "Is the competing cycle behind this period over?" — the ONE definition of a solution's vote gate,
 * as a SQL predicate over any (period_kind, period_start) column pair, so the write path (host/vote-service) and the read
 * path (routes/solutions' `cycleClosed` DTO field) cannot answer it differently.
 *
 * ⛔ WHY THIS EXISTS AT ALL — THE NINE WINNERLESS WEEKS. A solution's votability USED to be read
 * off its PARENT CHALLENGE's status: vote-service joined `solutions → challenges` and 409'd on
 * `challenges.status = 'closed'`. That is a fact about a DIFFERENT ROW IN A DIFFERENT WEEK, and in
 * prod it deadlocked the marketplace outright. The live 2026-W33 board's only entry was filed
 * 2026-08-10 03:49Z against challenge CH-284 — a `2026-W23` challenge. Eight hours later that day's
 * tick ran `healOrphanedChallenges`, which correctly closed CH-284 (its own week ended in June).
 * From that moment the W33 entry could not be voted on, and `closeCycle`'s "a winner needs ≥1 vote"
 * guard therefore could not be satisfied. Nine closed cycles, `winner_solution_id` NULL on every
 * one. The rule is now the only one that can be right: a solution's votability is a property of the
 * cycle IT competes in.
 *
 * THE PREDICATE (0107: periods, compared by `period_start` — never by key text):
 *
 *   OFF MODE (gate.mode = 'off')  →  kind <> 'off' AND EXISTS (closed row). Nothing goes stale, but
 *                                    a race that was run and ended stays ended.
 *   otherwise, for a row with (kind, start):
 *     kind <> 'off' AND (
 *       EXISTS (mc WHERE (mc.kind, mc.start) = (kind, start) AND mc.phase = 'closed')
 *       OR ( (start IS NULL OR (start < <currentStart> AND periodEnd(kind, start) <= strandedFloorSql(currentStart)))
 *            AND NOT EXISTS (mc WHERE (mc.kind, mc.start) = (kind, start)) ) )
 *
 *   1. ⛔ "NO CYCLE ROW" IS NOT "OPEN". Nothing ever creates a cycle row for a PAST period except
 *      `backfillMissedCycles` after an outage; prod's oldest row is W24 while W21/W23 carry rows.
 *      The second arm declares a past period with no row closed (same lesson as
 *      `healOrphanedChallenges`, whose first draft healed 1 of the 16 rows it was written for).
 *
 *   2. ⛔ `start < currentStart`, NEVER `start >= currentStart` AS A BLANKET CONJUNCT. A solution may
 *      carry a FUTURE period (routes/solutions.ts `laterPeriod` rolls forward when it answers a
 *      challenge `challengePeriodFor` pushed into the next period). That period has no row yet and
 *      MUST stay votable. The cycle ROW is the authority whenever there is one.
 *
 *   3. ⛔ NO "ANOTHER KIND ⇒ CLOSED" ARM. There was one (`kind <> currentKind` with no row), and it
 *      409'd exactly the row a cadence switch makes legitimate: during week→month the running WEEK
 *      governs while a Friday challenge's solutions are already filed into the coming MONTH (no row
 *      yet). A future period of any kind with no row is open; one a switch passed over is STRANDED — open
 *      until the sweep re-homes it (cycle-service `sweepStranded`) — and one below the stranded
 *      floor is closed by arm 2. Kind alone says nothing about whether a race is over.
 *
 *   4. `kind = 'off'`: filed while the cadence was off. It never entered a race, so no race ends it.
 *      `kind IS NULL` (legacy `week = ''`, never filed) has a NULL start and is CLOSED by arm 2.
 *
 *   5. ⚠️ A PAST PERIOD WITH A LIVE ROW READS OPEN — deliberately. Between the boundary (00:00 UTC)
 *      and the 03:00 UTC tick the period that just ended is `< currentStart` while its row still says
 *      `solution_phase`; a stalled scheduler extends that window; `backfillMissedCycles` opens past
 *      periods at `voting`. A vote that arrives before the close has run is legitimate — the period is
 *      not over until the engine says so. If the window must close, fix the CLOSE side.
 *
 * ⚠️ THE GATE IS A PARAMETER, NOT AN IMPORT (IMPORT DISCIPLINE above). Callers pass
 * `gateOf(await resolveCadence(now))` (host/cycle-cadence.ts) and thread their own `now`.
 *
 * ⛔⛔ THE COLUMN REFERENCE IS BUILT BY HAND, AND IT HAS TO BE. THIS BIT US DURING THE FIX ITSELF.
 * Interpolating the drizzle column as a TOP-LEVEL chunk of a select field —
 * `` sql`... where mc.week = ${weekCol}` `` handed straight to `.select({ c: … })` — compiles
 * SILENTLY WRONG whenever that select has no joins. drizzle's `PgDialect.buildSelection`
 * (pg-core/dialect.js:142-168, v0.45.2) rewrites every top-level `PgColumn` chunk of a select
 * field to a BARE `sql.identifier(name)` when `isSingleTable` (no joins; also forced for
 * insert/update/delete … returning). Inside our correlated subquery that bare `"week"` is then
 * captured by `marketplace_cycles`' OWN week column and the gate degrades to
 * `mc.week = mc.week` — "is ANY week anywhere closed", true for every row the moment one cycle
 * has ever closed. Measured, not theorised: `vote-service` (single-table `from solutions`)
 * refused every vote while `routes/solutions`' detail query (`solutions INNER JOIN users`)
 * reported the very same row as open, in the same run.
 *
 * ⚠️ THE TRAP IS NESTING DEPTH, NOT THE CLAUSE. An earlier revision of this note blamed clause
 * position ("wrong in a select field, fine in a WHERE"), and that framing is what made this get
 * re-litigated: the rewrite above is SHALLOW — it maps only the field's own `queryChunks` and
 * does not recurse — so `const week = sql`${weekCol}`` also happens to compile correctly, and a
 * reviewer who tries that spelling will "disprove" this note and delete the fix. Do not be
 * persuaded. That spelling is correct only by accident of one level of nesting, and it breaks
 * again the moment the fragment is inlined. Likewise `listSolutions` is safe today only because
 * it carries a `leftJoin(challenges)` added for an unrelated reason — remove that join and the
 * bare spelling emits `"week"` again. Safe positions (ORDER BY / GROUP BY / HAVING / WHERE) are
 * not a rule to rely on; the select-field path is the one that ships.
 *
 * `getTableName(col.table)` + `sql.identifier` produce `"solutions"."week"` / `"ranked"."week"`
 * regardless of clause, arity, or nesting depth — including a SUBQUERY column, whose "table" is
 * the subquery alias (the list route passes `ranked.period_kind` / `ranked.period_start`). cycle-eligibility.test.ts pins both
 * arities against the compiled SQL: it goes red on the bare-column spelling above, and red again
 * if someone hardcodes `sql.identifier("solutions")` instead of deriving the table name.
 */
export function periodClosedSql(
  row: { kind: AnyColumn; start: AnyColumn; tenant: AnyColumn },
  gate: PeriodGate,
): SQL<boolean> {
  // Fully qualified, always — see the note above. NEVER replace these with a bare `${col}`.
  const kind = qualify(row.kind);
  const start = qualify(row.start);
  // ⛔ 0110: THE CYCLE ROWS ARE PER TENANT. Every `marketplace_cycles` reference below is correlated
  // on the ROW's own tenant — never the caller's, never none. Without it tenant B's weekly close
  // (a `closed` row for B's week) would 409 tenant A's votes in the same period, and B's stranded
  // floor would kill A's rows. `gate` must be the gate of the SAME tenant the rows belong to
  // (`currentPeriodGate(now, tenantId)`): under RLS every row a request sees is its own tenant's.
  const tenant = qualify(row.tenant);
  // A race that was actually RUN AND ENDED: its cycle row says closed (crowned, or closed with no
  // winner). That is a fact about the row, true whatever the cadence is now.
  const closedRow = sql`exists (
        select 1 from ${marketplaceCycles} mc
        where mc.tenant_id = ${tenant} and mc.period_kind = ${kind} and mc.period_start = ${start} and mc.phase = 'closed'
      )`;
  // OFF MODE: only the "stale / no live row" arm is bypassed — nothing goes stale while no period
  // runs, so votes on everything else are a plain ranking.
  // ⛔ A CLOSED ROW STAYS CLOSED IN OFF. An earlier draft returned `false` here outright, so turning
  // the cadence off re-opened voting on every crowned period: a vote landed on a winner whose race
  // was decided months ago, and its count moved under an announced result.
  if (gate.mode === 'off') return sql<boolean>`(coalesce(${kind}, '') <> 'off' and ${closedRow})`;
  if (!(gate.start instanceof Date) || Number.isNaN(gate.start.getTime())) {
    throw new Error(
      'periodClosedSql: refusing to build a vote gate without a current period start — ' +
        'a missing comparator would open voting on the entire back catalogue. Pass gateOf(resolveCadence(now)).',
    );
  }
  const currentStart = sql`${gate.start.toISOString()}::timestamptz`;
  // ⛔ A STRANDED ROW IS NEVER DEAD. "No row" is dead ONLY below the stranded floor (`strandedFloorSql`:
  // the end of the latest CLOSED cycle). At or above it, a period with no row is either still to
  // come (rolled forward, or a missed period the catch-up opens) or one the engine will never open
  // (passed over by a cadence switch, stamped by a pod with a stale policy, beyond the catch-up cap)
  // — and every such row is re-homed into the current open period by ONE sweep (cycle-service
  // `sweepStranded`: every tick, every open of the current period, every switch). Nothing in that
  // span was ever crowned, so nothing in it can have ended. It reads OPEN until the sweep moves it.
  // This replaced three bounded special cases (one per review round) that each left one more shape
  // of "stamped into a period that never opens" dead.
  return sql<boolean>`(
    coalesce(${kind}, '') <> 'off'
    and (
      ${closedRow}
      or (
        (${start} is null or (${start} < ${currentStart} and ${periodEndSql(kind, start)} <= ${strandedFloorSql(gate.start, tenant)}))
        and not exists (
          select 1 from ${marketplaceCycles} mc_any
          where mc_any.tenant_id = ${tenant} and mc_any.period_kind = ${kind} and mc_any.period_start = ${start}
        )
      )
    )
  )`;
}

/**
 * ⛔ THE STRANDED FLOOR — the ONE definition, shared by the vote gate (`periodClosedSql`) and the
 * re-home sweep (cycle-service `sweepStranded`), so "dead" and "re-homed" can never disagree.
 *
 * A row in a period with NO cycle row is STRANDED (never dead; swept into the current period) iff its
 * period ENDS after this instant; a period that ended at or before it keeps the legacy "past period
 * with nothing live" meaning (prod's seeded W21/W23 rows). The floor is the END (`closes_at`,
 * stretched or not) of the latest CLOSED cycle that started by `asOf` — nothing after it was crowned.
 *
 * ⚠️ BY THE PERIOD'S END, NOT ITS START. A week a switch passed over can START inside the stretched
 * span the previous close crowned (W48 = Nov 28 → Dec 5 under a W47 stretched to Dec 1; a W05 that
 * runs Jan 28 → Feb 4 into a monthly February). It was never in that race, so it must not be dead
 * the moment that race closes. Every period that ended by the floor really is behind a crowned span.
 *
 *   • Only rows that STARTED by `asOf` count: a hand-opened future period force-closed through
 *     POST /api/cycle/advance must not lift the floor past every real stranded row.
 *   • No closed row yet (the first period is still running): the START of the earliest row — what
 *     precedes the first period is seed history, exactly as before.
 *   • No row at all (fresh install): +infinity — nothing is stranded; a past period is closed and a
 *     future one open, by the `start < currentStart` arm alone.
 *   • Never lower than `asOf − STRANDED_HORIZON_DAYS` (below).
 *
 * ⚠️ CLOSING A PERIOD LIFTS THE FLOOR, possibly over a row the sweep has not moved yet (a passed-over
 * week inside a stretched span). Every closer therefore sweeps FIRST: the tick sweeps against the
 * floor it read BEFORE its own closes (one transaction), and POST /api/cycle/advance sweeps before it
 * drives a row.
 */
export function strandedFloorSql(asOf: Date, tenant: SQL): SQL {
  // `tenant`: the tenant whose floor this is — a correlated column (`"solutions"."tenant_id"`) or a
  // bound uuid. ⛔ 0110: another tenant's close must never lift this tenant's floor.
  const at = sql`${asOf.toISOString()}::timestamptz`;
  return sql`greatest(
        coalesce(
          (select max(mc_fl.closes_at) from ${marketplaceCycles} mc_fl
            where mc_fl.tenant_id = ${tenant} and mc_fl.phase = 'closed' and mc_fl.period_start <= ${at}),
          (select min(mc_f0.period_start) from ${marketplaceCycles} mc_f0
            where mc_f0.tenant_id = ${tenant} and mc_f0.period_start <= ${at}),
          'infinity'::timestamptz),
        ${at} - ${`${STRANDED_HORIZON_DAYS} days`}::interval)`;
}

/**
 * ⛔ THE HORIZON: a stranded row is at most this far from the current period, in either direction.
 * Below `asOf − horizon` a period with no row is legacy-dead even if nothing closed since (an outage
 * longer than a year, or a far-future tick in a test); at or beyond `asOf + horizon` it is left alone
 * (no roll-forward reaches a year ahead). Without it, one tick at a far-future instant swept every
 * row stamped decades earlier into its own period — the 2099 incident.
 */
export const STRANDED_HORIZON_DAYS = 366;

/**
 * The (exclusive) natural END of a period given its kind and start, in SQL — `nextPeriodStart`
 * (period.ts). Computed in UTC explicitly: `timestamptz + interval '1 month'` follows the SESSION time
 * zone, so a session at +02:00 would land a month boundary two hours off.
 */
export function periodEndSql(kind: SQL, start: SQL): SQL {
  return sql`(((${start}) at time zone 'UTC') + (case ${kind} when 'week' then interval '7 days' when 'month' then interval '1 month' when 'quarter' then interval '3 months' else interval '1 year' end)) at time zone 'UTC'`;
}

/** `"table"."column"` for any drizzle column, including a subquery alias's — see the note above. */
function qualify(col: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(col.table))}.${sql.identifier(col.name)}`;
}

/** The period (and tenant) columns of `solutions`, the usual argument to `periodClosedSql`. */
export const SOLUTION_PERIOD = { kind: solutions.period_kind, start: solutions.period_start, tenant: solutions.tenant_id } as const;

/** A bound tenant uuid for `strandedFloorSql` (the engine's per-tenant reads). */
export function tenantParam(tenantId: string): SQL {
  return sql`${tenantId}::uuid`;
}

/**
 * "Is this CHALLENGE still accepting work?" — the ONE definition of a challenge's liveness, as a
 * SQL predicate over the `challenges` table, so the submit guard (routes/solutions' 422
 * `challenge_closed`), the board's `cycleClosed` DTO field and the `?open=` filter cannot answer it
 * differently. It is the `status` column, and NOTHING ELSE.
 *
 * ⛔ THE WEEK ARM WAS REMOVED DELIBERATELY. READ THIS BEFORE PUTTING IT BACK.
 * This predicate used to be `status = 'closed' OR weekClosedSql(challenge.week, currentWeek)`, so a
 * challenge went closed merely because its ISO week had passed. That is wrong as PRODUCT
 * behaviour, not just as code: a challenge can legitimately wait months for anyone to solve it —
 * at a large company with thousands of challenges, that is the NORMAL case, not the edge. The
 * calendar is not evidence that a piece of work is finished.
 *
 * The measured damage: every one of the 17 challenges in production had been swept to `closed`,
 * the newest authored 2026-08-10, so the board rendered EMPTY under its default `?open=true`
 * filter and `castVote` answered `409 voting_closed` for every row. Demo content must be available
 * at all times; under the old rule it expired on a timer nobody chose.
 *
 * ⛔ WHY DROPPING IT CANNOT "RE-OPEN SOMETHING A HUMAN SHUT". At the time of this change there was
 * NO human close path in the product at all: `update(challenges).set({ status: 'closed' })` had
 * exactly two writers, `closeCycle` and `healOrphanedChallenges`, both in host/cycle-service.ts and
 * both purely calendar-driven, plus `enterSolutionPhase` which does not close. So `status='closed'`
 * carried no human intent to preserve. ⚠️ THAT ARGUMENT EXPIRES the moment an explicit close
 * endpoint is added — the column records no actor and no timestamp, so engine-closed and
 * human-closed become indistinguishable. Any such endpoint must land AFTER the repair migration.
 *
 * ⛔ THE NINE WINNERLESS WEEKS / CH-284, AND WHY IT NO LONGER ARGUES FOR THE WEEK ARM.
 * On 2026-08-10T03:49Z prod accepted a solution against CH-284, a `2026-W23` challenge, because
 * its status still read `voting` — `healOrphanedChallenges` had not reached it until 11:53Z. That
 * incident was used to justify the week arm submit-side. It no longer applies: under this rule a
 * past-week challenge is not "dead", it is simply OPEN, and accepting a solution against it is the
 * intended behaviour. What the incident really showed is that `status` lagged a closer that should
 * never have been closing on the calendar in the first place.
 *
 * ⚠️ `periodClosedSql` (formerly `weekClosedSql`) still governs SOLUTION voting and the winner path — a
 * solution's votability stays a property of its own week, because "this week's winner" is a
 * genuinely weekly question. Only the CHALLENGE predicate moved. Do not collapse the two.
 */
export function challengeClosedSql(): SQL<boolean> {
  return challengeClosedOver(challenges.status);
}

/**
 * The same predicate over ANOTHER status column — the board's ranking subquery
 * (host/challenge-board.ts) carries `status` through under the alias `ranked`, and the list route's
 * `?open=` filter and `cycleClosed` field are evaluated out there, one level above the table.
 * Parameterised rather than re-spelled: two spellings of "is this challenge over" is exactly the
 * drift this module exists to prevent.
 *
 * ⚠️ It no longer takes a week column. That is the whole point of the change — see the header
 * above. A caller that still has a week in hand does NOT need it here.
 */
export function challengeClosedOver(statusCol: AnyColumn): SQL<boolean> {
  return eq(statusCol, 'closed') as SQL<boolean>;
}

/**
 * The winner ranking, spread into `.orderBy(...)` at every call site.
 *
 * Deterministic all the way down on purpose: votes decide, then the earlier submission, then
 * the id. A tie broken by whatever order Postgres happened to return would make a replayed
 * close (or a re-render of the page) crown a different row. Shared so that "rank 1" on the
 * announcement and "ranks 2-4" underneath it are one ordering, not two that agree by luck.
 */
export const WINNER_ORDER = [
  desc(solutions.votes_count),
  asc(solutions.created_at),
  asc(solutions.id),
] as const;

/**
 * The week's headline figures for ONE tenant — the exact aggregate `closeCycle` stamps into
 * `weekly_winners.stats`, so a page that recomputes it (because the artifact predates the
 * stats, or because the winner was derived rather than announced) cannot disagree with the
 * row the close wrote.
 *
 * ⚠️ Deliberately NOT status-filtered: "solutions submitted this week" means every submission,
 * including the drafts that never entered the vote. That is what the close counts, so it is
 * what this counts. The candidate-set predicate above answers a different question.
 *
 * ⚠️ Tenant-scoped by parameter for the reason recorded in cycle-service: unscoped, this
 * stamped every OTHER tenant's solution count and vote total into a tenant-readable row — a
 * cross-tenant disclosure, not merely a wrong number. When the caller has RLS (the read path)
 * it passes its own tenant anyway, and passes its OWN `db`; running this under `runAsSystem`
 * from a read surface would re-open exactly that leak.
 */
export async function periodSolutionStats(
  key: string,
  tenantId: string | null,
  database: DbOrTx = defaultDb,
): Promise<WeeklyWinnerStats> {
  // Same empty-key trap as above, but a stats read has a meaningful zero to return, so it
  // answers "nothing" instead of throwing.
  if (!key) return { solutionsSubmitted: 0, totalVotesCast: 0 };
  const p = periodFromKey(key);
  const inPeriod = and(eq(solutions.period_kind, p.kind), eq(solutions.period_start, p.start));
  const [agg] = await database
    .select({
      submitted: sql<number>`count(*)::int`,
      votes: sql<number>`coalesce(sum(votes_count), 0)::int`,
    })
    .from(solutions)
    .where(tenantId ? and(inPeriod, eq(solutions.tenant_id, tenantId)) : inPeriod);
  return { solutionsSubmitted: agg?.submitted ?? 0, totalVotesCast: agg?.votes ?? 0 };
}
