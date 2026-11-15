// src/host/cycle-service.ts — the marketplace weekly-cycle engine (Phase 2-E).
//
// ⛔ 0110: THE ENGINE IS PER TENANT. Each tenant has its own cadence (cycle-cadence.ts) and its own
// `marketplace_cycles` rows, and EVERY query below that reads or writes a cycle row (or a row stamped
// into one) carries an explicit tenant predicate — the engine runs as SYSTEM (owner pool, RLS
// bypassed), so nothing else would narrow it. `tests/cycle-tenant-scope.test.ts` greps this file and
// cycle-cadence.ts / cycle-eligibility.ts for a `marketplace_cycles` read without one.
// The paragraph below predates 0110: read "platform-wide" as "per tenant".
// Turns the inert social loop into a real, time-boxed one: each ISO week opens in
// `voting`, advances to `solution_phase` when voting closes, then `closed` (ONE winner
// per competing TENANT selected + announced) when the solution phase ends. The phase
// clock in marketplace_cycles is platform-wide and stays global; the winners are not,
// and are written per-tenant to weekly_winners. `tickCycles` is the single
// idempotent advance step the daily scheduler AND the manual route both call — it is
// safe to fire repeatedly, after downtime, or from two replicas: the marketplace_cycles
// week-claim (open) and `closed_at IS NULL` (close) guards make every transition
// at-most-once. weekly_winners stays the durable winner artifact; enqueueWinner lands
// the winner on the production pipeline exactly as the manual path always did.
import { and, asc, desc, eq, getTableName, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import {
  db as defaultDb,
  marketplaceCycles,
  challenges,
  solutions,
  weeklyWinners,
  pipelineItems,
  policies,
  policyChanges,
  tenants,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
} from '../db/client';
import type { MarketplaceCycle, WeeklyWinnerStats } from '../db/schema';
import { log } from './logger';
import { incCounter } from './metrics';
import { TICK_FAILED_COUNTER } from './tick-locks';
import { recordAudit } from './audit-service';
import { enqueueWinner } from './pipeline-service';
// The candidate set + ranking + week aggregate live in ONE module shared with the read
// surface (routes/marketplace-summary.ts). Before that, /api/winner's "honourable mentions"
// re-implemented this query with none of its predicates and announced runners-up from other
// weeks and other statuses. See cycle-eligibility.ts for the full account.
import {
  eligibleForPeriod,
  WINNER_ORDER,
  periodClosedSql,
  periodSolutionStats,
  SOLUTION_PERIOD,
  STRANDED_HORIZON_DAYS,
  periodEndSql,
  strandedFloorSql,
  tenantParam,
} from './cycle-eligibility';
import {
  firstBoundaryAtOrAfter,
  nextPeriod,
  nextPeriodStart,
  periodFor,
  periodFromKey,
  phaseBoundaries,
  stretchedEnd,
  type Cadence,
  type Period,
  type PeriodKind,
} from './period';
import {
  cadenceAt,
  cadenceInForce,
  cycleNow,
  cadenceStateFrom,
  invalidateTenantCadenceCache,
  periodStartingAt,
  readCadencePolicy,
  readCadencePolicyLocked,
  readCadencePolicyWithHistory,
  readCadenceTimeline,
  readLiveCycle,
  readPlatformCadenceRow,
  readTenantCadenceRow,
  readTenantTimeline,
  scheduledPeriods,
  tenantRowGoverns,
  tenantRowOf,
  timelineOfPolicy,
  type CadenceTimeline,
  type PendingSwitch,
  type TenantCadenceRow,
} from './cycle-cadence';
// The ISO-week vocabulary (weekString / weekStart / laterWeek) MOVED to host/iso-week.ts and is
// re-exported below, unchanged, so every existing importer of this module keeps working.
//
// WHY IT MOVED: `host/vote-service.ts` — the hot path behind a single upvote click — now needs
// `weekString(now)` to ask whether a solution's OWN cycle has closed. Importing it from here would
// have pulled `config`, `recordAudit`, `enqueueWinner` and the pipeline onto the vote path to get
// three lines of date arithmetic. Same discipline cycle-eligibility.ts already applies to the read
// path. There is still exactly ONE implementation; this file is not a second copy.
import { laterWeek, weekStart, weekString } from './iso-week';
export { laterWeek, weekStart, weekString };

type Db = typeof defaultDb;
const DAY_MS = 86_400_000;

/** The period columns written alongside the legacy `week` key on every row this engine stamps. */
export function periodColumns(p: Period): { week: string; period_kind: PeriodKind; period_start: Date } {
  return { week: p.key, period_kind: p.kind, period_start: p.start };
}

/** The columns for a row filed while the cadence is OFF: no period, never made stale by one. */
export const OFF_PERIOD_COLUMNS = { week: '', period_kind: 'off' as const, period_start: null };

/**
 * The period a NEWLY SUBMITTED CHALLENGE should compete in, for a cadence of `kind`.
 *
 * NOT simply `periodFor(kind, now)`. A challenge is voted on during the cycle's `voting` phase only;
 * one submitted after that phase has shut (week: Fri–Sun; month: the 22nd onward; year: December)
 * would be stamped into a period whose challenge-voting window has ALREADY closed and never be seen.
 * Roll those into the NEXT period instead, where they get the full cycle.
 *
 * Pure so every branch (and the ISO-year / month / year boundary) is unit-testable; `cycle` is the
 * current period's row or null when the engine has not opened it. The row's phase is authoritative
 * when present — a manually force-closed or force-advanced period must not accept new challenges
 * either — and its own `voting_ends_at` beats the derived boundary.
 *
 * Solutions deliberately do NOT use this: they are submitted AND voted during `solution_phase`, so
 * the running period is exactly the cycle that will judge them.
 */
export function challengePeriodFor(
  now: Date,
  kind: PeriodKind,
  cycle: Pick<MarketplaceCycle, 'phase' | 'voting_ends_at'> | null,
  // The governing period and the one after it (CadenceState.current / .next). Default: the plain
  // `periodFor(kind, now)` and its successor of the same kind. Pass them when a cadence switch may be
  // pending: the current period may be STRETCHED and the next one of the NEW kind (a Friday
  // challenge under week→month rolls into the month, not into a week that will never open). A
  // `next` of null (switching off) keeps the challenge in the current period.
  opts: { current?: Period; next?: Period | null } = {},
): Period {
  const current = opts.current ?? periodFor(kind, now);
  const votingEnds = cycle?.voting_ends_at ?? phaseBoundaries(current).voting_ends_at;
  const stillTakingChallenges = (!cycle || cycle.phase === 'voting') && now.getTime() < votingEnds.getTime();
  if (stillTakingChallenges) return current;
  if (opts.next === undefined) return nextPeriod(current);
  return opts.next ?? current;
}

/** Open-claim a period (idempotent). Returns the existing-or-created cycle row. Accepts a period
 *  or its key. Boundaries come from `phaseBoundaries` (per-kind), closing at `nextPeriodStart`. */
export async function openCycle(period: Period | string, tenantId: string, database: Db = defaultDb): Promise<MarketplaceCycle> {
  return (await claimCycle(period, tenantId, database)).row;
}

/**
 * The boundaries a period's row carries. A period whose `end` is not its natural end was STRETCHED
 * by a pending cadence switch (period.ts `stretchedEnd`): the extra time goes to the building phase,
 * so `voting_ends_at` keeps its natural value (clamped, should the end ever be EARLIER).
 */
export function boundariesOf(p: Period): { voting_ends_at: Date; solution_ends_at: Date; closes_at: Date } {
  const natural = phaseBoundaries(p);
  if (p.end.getTime() === natural.closes_at.getTime()) return natural;
  const votingEnds = natural.voting_ends_at.getTime() < p.end.getTime() ? natural.voting_ends_at : p.end;
  return { voting_ends_at: votingEnds, solution_ends_at: p.end, closes_at: p.end };
}

/** The cadence a sweep (and an open) decides by: the stored setting, its pending switch, the full history. */
export interface SweepPolicy {
  setting: Cadence;
  pending: PendingSwitch | null;
  timeline: CadenceTimeline;
}

/**
 * THE one function that creates a cycle row (`openCycle`, the tick's open, the back-fill and
 * POST /api/cycle/advance all come through here). Says whether THIS call created the row, and how
 * many stranded rows it re-homed into it.
 *
 * ⛔ OPENING THE CURRENT PERIOD SWEEPS STRANDED ROWS INTO IT, IN THE SAME TRANSACTION. There is then no
 * committed instant at which the current period is open and a stranded row is not in it. `sweep`:
 * `undefined` = decide at the wall clock with the stored policy (the manual route), `null` = never
 * (the back-fill opens PAST periods, and the tick sweeps once itself after them), or the tick's own
 * instant + policy. The sweep runs only when the period being opened IS the current open period at
 * that instant — opening a past (back-filled) or hand-opened future period moves nothing.
 */
async function claimCycle(
  period: Period | string,
  tenantId: string,
  database: Db,
  sweep?: { now: Date; policy: SweepPolicy; floor?: number } | null,
): Promise<{ row: MarketplaceCycle; created: boolean; rehomed: number }> {
  const p = typeof period === 'string' ? periodFromKey(period) : period;
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // ON CONFLICT DO NOTHING against (tenant_id, period_kind, period_key|period_start): one row per
    // period PER TENANT. Another tenant's row for the same period is not a conflict.
    const inserted = await tx
      .insert(marketplaceCycles)
      .values({
        tenant_id: tenantId,
        week: p.key,
        period_kind: p.kind,
        period_key: p.key,
        period_start: p.start,
        phase: 'voting',
        ...boundariesOf(p),
      })
      .onConflictDoNothing()
      .returning({ id: marketplaceCycles.id });
    let rehomed = 0;
    if (sweep !== null) {
      const at = cycleNow();
      const ctx = sweep ?? { now: at, policy: await readCadencePolicyWithHistory(tx, tenantId, { lock: false, at }) };
      rehomed = await sweepStranded(tx, tenantId, ctx.now, ctx.policy, { onlyInto: p, floor: 'floor' in ctx ? ctx.floor : undefined });
    }
    const [row] = await tx
      .select()
      .from(marketplaceCycles)
      .where(
        and(
          eq(marketplaceCycles.tenant_id, tenantId),
          eq(marketplaceCycles.period_kind, p.kind),
          eq(marketplaceCycles.period_key, p.key),
        ),
      );
    return { row: row!, created: inserted.length > 0, rehomed };
  });
}

/** The three tables whose rows are stamped into a period. */
const STAMPED_TABLES = [challenges, solutions, pipelineItems] as const;

/**
 * ⛔ THE STRANDED-ROW INVARIANT — one idempotent sweep instead of a bounded window per edge case.
 *
 * A row (challenge / solution / pipeline card) is STRANDED when its period has NO cycle row and:
 *
 *   its period ENDS after the stranded floor (cycle-eligibility `strandedFloorSql`: the end of the
 *                  latest CLOSED cycle — nothing after it was ever crowned), within the horizon
 *   AND it is not a period the engine is still going to open:
 *     • not one the catch-up will back-fill (`scheduledPeriods` over the full cadence history,
 *       between the newest row before the current period and the current period), and
 *     • not an UPCOMING one: starting at or after the end of the current period (or, when off, the
 *       next switch that turns the cycle on) AND of the kind in force at its start — a Friday
 *       challenge rolled into next week, or into the month a pending switch opens next;
 *   OR it was filed while OFF (`period_kind = 'off'`) within the horizon, and a period is open now
 *   (re-enabling the cycle brings what was filed while it was off into the first period).
 *
 * Every stranded row moves to where a FRESH submission at `now` would be stamped (see the target note
 * in the body: the current open period, or the upcoming one for a challenge filed after the current
 * period's challenge voting shut, and its solutions with it) — or to the OFF stamp when the cadence
 * is off — and NEVER into any other period (an unbounded first attempt once swept rows into a far-future
 * 2099 week). The vote gate reads a stranded row as OPEN until then (`periodClosedSql`), so no row is
 * ever dead between the moment it strands and the sweep. Runs: inside every tick's transaction, in
 * every open of the current period (`claimCycle`), and in every cadence switch.
 *
 * Rows below the floor with no cycle row keep the legacy "past period with nothing live" meaning.
 * Legacy rows with no period (`week = ''`) are never touched. Returns the number of rows moved.
 */
export async function sweepStranded(
  database: Db,
  tenantId: string,
  now: Date,
  policy: SweepPolicy,
  opts: { onlyInto?: Period; floor?: number } = {},
): Promise<number> {
  // ⛔ 0110: ONE TENANT'S rows, against ONE TENANT'S cycle rows and floor. `policy` must be that
  // tenant's (readCadencePolicyWithHistory(tx, tenantId, …)).
  const tenantSql = tenantParam(tenantId);
  const state = cadenceStateFrom(now, policy.setting, await readLiveCycle(database, tenantId, now), policy.pending);
  const dest = state.current;
  if (opts.onlyInto && !(dest && dest.kind === opts.onlyInto.kind && dest.start.getTime() === opts.onlyInto.start.getTime())) {
    return 0;
  }
  const asOf = dest ? dest.start : now;
  const asOfSql = sql`${asOf.toISOString()}::timestamptz`;
  // The tick passes the floor it read BEFORE its own closes (see `strandedFloorSql`).
  const floor =
    opts.floor === undefined
      ? strandedFloorSql(asOf, tenantSql)
      : Number.isFinite(opts.floor)
        ? sql`${new Date(opts.floor).toISOString()}::timestamptz`
        : sql`'infinity'::timestamptz`;
  const horizonStart = new Date(asOf.getTime() - STRANDED_HORIZON_DAYS * DAY_MS);
  const horizonEnd = new Date(asOf.getTime() + STRANDED_HORIZON_DAYS * DAY_MS);

  // The periods the catch-up still owes (opened by the tick's back-fill, never swept).
  const [newestBefore] = await database
    .select({ kind: marketplaceCycles.period_kind, start: marketplaceCycles.period_start, closes: marketplaceCycles.closes_at })
    .from(marketplaceCycles)
    .where(and(eq(marketplaceCycles.tenant_id, tenantId), sql`${marketplaceCycles.period_start} < ${asOfSql}`))
    .orderBy(desc(marketplaceCycles.period_start))
    .limit(1);
  const owed = newestBefore
    ? scheduledPeriods(
        policy.timeline,
        { start: newestBefore.start, end: newestBefore.closes, kind: newestBefore.kind as PeriodKind },
        asOf,
        MAX_BACKFILL_WEEKS,
      ).periods
    : [];

  // UPCOMING: from the end of the current period (or the next switch that turns the cycle on).
  const upcomingFrom = dest
    ? dest.end
    : (policy.timeline.transitions.find((t) => t.at.getTime() > now.getTime() && t.to !== 'off')?.at ?? null);
  const future = policy.timeline.transitions.filter((t) => t.at.getTime() > now.getTime());
  const kindNow = cadenceAt(policy.timeline, now);

  // ⛔ THE TARGET IS EXACTLY WHAT A FRESH SUBMISSION AT `now` WOULD BE STAMPED WITH — never simply
  // "the current period". A Friday challenge swept into a stretched week whose challenge voting has
  // already shut would sit in a period that can no longer judge it (the route would roll it forward).
  //   challenges: `challengePeriodFor(now, …)` against the current period's own row (routes/challenges)
  //   solutions:  `laterPeriod(current, its challenge's period)` (routes/solutions) — challenges are
  //               swept FIRST, so a solution follows its challenge's NEW period
  //   pipeline cards: the current period (they copy a crowned solution's period; never upcoming)
  let chTarget: Period | null = null;
  if (dest) {
    const [destRow] = await database
      .select()
      .from(marketplaceCycles)
      .where(
        and(
          eq(marketplaceCycles.tenant_id, tenantId),
          eq(marketplaceCycles.period_kind, dest.kind),
          eq(marketplaceCycles.period_start, dest.start),
        ),
      );
    chTarget = challengePeriodFor(now, dest.kind, destRow ?? null, { current: dest, next: state.next });
  }

  let moved = 0;
  for (const t of STAMPED_TABLES) {
    // Qualified by hand (cycle-eligibility's `qualify` note): the correlated `not exists` below must
    // never see a bare "period_kind" that `marketplace_cycles mc` would capture.
    const tbl = sql.identifier(getTableName(t));
    const kind = sql`${tbl}.${sql.identifier(t.period_kind.name)}`;
    const start = sql`${tbl}.${sql.identifier(t.period_start.name)}`;
    // The kind in force at the row's own start (only instants after `now` are ever asked).
    const kindAtStart = future.length
      ? sql`(case ${sql.join(
          future.map((tr, i) => sql`when ${start} < ${tr.at.toISOString()}::timestamptz then ${i === 0 ? kindNow : future[i - 1]!.to}`),
          sql` `,
        )} else ${future[future.length - 1]!.to} end)`
      : sql`${kindNow}`;
    // The per-row target (see above) as SQL: week key, kind, start.
    let target: { week: SQL; kind: SQL; start: SQL } | null = null;
    if (dest && chTarget) {
      const pt = (p: Period) => ({
        week: sql`${p.key}::text`,
        kind: sql`${p.kind}::text`,
        start: sql`${p.start.toISOString()}::timestamptz`,
      });
      if (t === challenges) target = pt(chTarget);
      else if (t === solutions) {
        // laterPeriod(dest, challenge period): same kind → later start wins; another kind → only one
        // starting at or after the current period's end.
        const later = (col: string) =>
          sql`(select ${sql.raw(`ch.${col}`)} from ${challenges} ch
                where ch.id = ${tbl}.${sql.identifier(solutions.challenge_id.name)}
                  and ch.period_kind in ('week', 'month', 'quarter', 'year')
                  and ((ch.period_kind = ${dest.kind} and ch.period_start > ${dest.start.toISOString()}::timestamptz)
                    or (ch.period_kind <> ${dest.kind} and ch.period_start >= ${dest.end.toISOString()}::timestamptz)))`;
        const d = pt(dest);
        target = {
          week: sql`coalesce(${later('week')}, ${d.week})`,
          kind: sql`coalesce(${later('period_kind')}, ${d.kind})`,
          start: sql`coalesce(${later('period_start')}, ${d.start})`,
        };
      } else target = pt(dest);
    }
    // The tenant this sweep is about. `pipeline_items` has no tenant_id: its tenant is its solution's.
    const ofTenant =
      t === pipelineItems
        ? sql`exists (select 1 from ${solutions} s_t where s_t.id = ${tbl}.${sql.identifier(pipelineItems.solution_id.name)} and s_t.tenant_id = ${tenantSql})`
        : sql`${tbl}.${sql.identifier('tenant_id')} = ${tenantSql}`;
    const strandedOn = and(
      sql`${kind} in ('week', 'month', 'quarter', 'year')`,
      // A row already where a fresh submission would land is not stranded (idempotent sweep).
      ...(target ? [sql`not (${kind} = ${target.kind} and ${start} = ${target.start})`] : []),
      sql`${periodEndSql(kind, start)} > ${floor}`,
      sql`${start} < ${horizonEnd.toISOString()}::timestamptz`,
      sql`not exists (select 1 from ${marketplaceCycles} mc where mc.tenant_id = ${tenantSql} and mc.period_kind = ${kind} and mc.period_start = ${start})`,
      ...(dest ? [sql`not (${kind} = ${dest.kind} and ${start} = ${dest.start.toISOString()}::timestamptz)`] : []),
      ...(upcomingFrom
        ? [sql`not (${start} >= ${upcomingFrom.toISOString()}::timestamptz and ${kind} = ${kindAtStart})`]
        : []),
      ...(owed.length
        ? [
            sql`(${kind}, ${start}) not in (${sql.join(
              owed.map((p) => sql`(${p.kind}::text, ${p.start.toISOString()}::timestamptz)`),
              sql`, `,
            )})`,
          ]
        : []),
    );
    const rows = await database
      .update(t)
      .set(
        target
          ? ({ week: target.week, period_kind: target.kind, period_start: target.start } as unknown as ReturnType<typeof periodColumns>)
          : OFF_PERIOD_COLUMNS,
      )
      // OFF rows: every one filed within the horizon. Not bounded by the floor — the floor is about
      // PERIODS, and a Friday entry OFF-stamped by a switch before the 03:00 close was filed BEFORE
      // that close. An OFF row cannot predate an earlier on-run either: that run's first open swept it.
      .where(
        and(
          ofTenant,
          dest
            ? or(
                and(
                  sql`${kind} = 'off'`,
                  sql`${tbl}.${sql.identifier(t.created_at.name)} >= ${horizonStart.toISOString()}::timestamptz`,
                  sql`${tbl}.${sql.identifier(t.created_at.name)} < ${horizonEnd.toISOString()}::timestamptz`,
                ),
                strandedOn,
              )
            : strandedOn,
        ),
      )
      .returning({ id: t.id });
    moved += rows.length;
  }
  if (moved > 0) {
    log.warn('cycle_rehomed_stranded', { component: 'cycle', tenantId, into: dest?.key ?? 'off', count: moved });
  }
  return moved;
}

/** The stranded floor as it stands NOW (before any close), in epoch ms (`Infinity`: nothing is stranded). */
async function readStrandedFloor(database: Db, tenantId: string, now: Date, policy: SweepPolicy): Promise<number> {
  const state = cadenceStateFrom(now, policy.setting, await readLiveCycle(database, tenantId, now), policy.pending);
  const asOf = state.current ? state.current.start : now;
  const rows = (await database.execute(
    sql`select (extract(epoch from ${strandedFloorSql(asOf, tenantParam(tenantId))}) * 1000)::float8 as floor`,
  )) as unknown as { floor: number | string }[];
  return Number(rows[0]?.floor ?? Infinity);
}

/** THE sweep at the wall clock with the stored policy and its full history (the manual route). */
export async function sweepStrandedNow(tenantId: string, database: Db = defaultDb, now: Date = cycleNow()): Promise<number> {
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockTenantCycle(tx, tenantId);
    return sweepStranded(tx, tenantId, now, await readCadencePolicyWithHistory(tx, tenantId, { lock: false, at: now }));
  });
}

/**
 * Did anything happen in `tenantId`'s period `p` — at least one challenge OR one solution stamped
 * into it? The per-period audit rows (`cycle.advance`, `cycle.close`) are written only when it did.
 *
 * ⛔ WHY: 0110 made the cycle per tenant, so every live tenant now runs its own period even when its
 * workspace is empty — ~22 tenants turned ONE `cycle.close` row a week into ~22, almost all of them
 * "Closed · no winner" about a period nobody used, in the table the nightly compliance export ships.
 * The phase TRANSITIONS still happen (the cycle row closes either way); only the audit noise is
 * skipped. A period with a challenge but no solution still audits — that IS a winnerless race.
 */
async function periodHadActivity(database: Db, tenantId: string, p: Period): Promise<boolean> {
  const inPeriod = (t: typeof challenges | typeof solutions) =>
    and(eq(t.tenant_id, tenantId), eq(t.period_kind, p.kind), eq(t.period_start, p.start));
  const [ch] = await database.select({ id: challenges.id }).from(challenges).where(inPeriod(challenges)).limit(1);
  if (ch) return true;
  const [so] = await database.select({ id: solutions.id }).from(solutions).where(inPeriod(solutions)).limit(1);
  return !!so;
}

/**
 * voting → solution_phase, at most once (phase-predicated). On the real transition it
 * also opens solution voting: the week's solutions go draft→voting. It does NOT touch
 * `challenges.status` any more — the calendar does not decide a challenge's phase.
 * `challenges.status = 'solution_phase'` iff the challenge has at least one solution, and
 * `routes/solutions.ts` is the one writer that makes that true, inside the solution-insert
 * transaction, the moment the first solution is filed. Returns true only on the
 * marketplace_cycles transition that it performed.
 */
export async function enterSolutionPhase(week: string, tenantId: string, database: Db = defaultDb): Promise<boolean> {
  const p = periodFromKey(week);
  const claimed = await database
    .update(marketplaceCycles)
    .set({ phase: 'solution_phase', updated_at: new Date() })
    .where(
      and(
        eq(marketplaceCycles.tenant_id, tenantId),
        eq(marketplaceCycles.period_kind, p.kind),
        eq(marketplaceCycles.period_key, week),
        eq(marketplaceCycles.phase, 'voting'),
      ),
    )
    .returning({ id: marketplaceCycles.id });
  if (claimed.length === 0) return false;

  await database
    .update(solutions)
    .set({ status: 'voting', updated_at: new Date() })
    .where(
      and(
        eq(solutions.tenant_id, tenantId),
        eq(solutions.period_kind, p.kind),
        eq(solutions.period_start, p.start),
        eq(solutions.status, 'draft'),
      ),
    );
  // An empty period's transition is not audited (`periodHadActivity`).
  if (!(await periodHadActivity(database, tenantId, p))) return true;
  // ⚠️ SAVEPOINTED (`bestEffort`): this runs inside the tick's ONE transaction, and `recordAudit`
  // swallows its own error — a failed insert would leave the tick's transaction aborted (25P02) and
  // roll back the phase change above with it.
  await bestEffort(
    database,
    (d) =>
      recordAudit(
        {
          action: 'cycle.advance',
          category: 'deploy',
          targetType: 'marketplace_cycle',
          targetId: week,
          result: '→ Solution phase',
          resultTone: 'ok',
          metadata: { week, tenantId },
        },
        d,
      ),
    (err) => log.error('cycle_advance_audit_failed', { component: 'cycle', week, tenantId, err }),
  );
  return true;
}

/** One tenant's winner for the week (weekly_winners is a PER-TENANT artifact, see 0041). */
export interface CycleWinner {
  tenantId: string;
  solutionId: string;
  challengeId: string;
  stats: WeeklyWinnerStats;
}

export interface CloseResult {
  closed: boolean; // true only on the close that this call performed
  // One entry per tenant that had an eligible solution this week, ordered by tenant_id.
  // NOT a single "the winner": a global top-1 gave the whole platform one winner per week
  // and left every other tenant's "This week's winner" page blank forever.
  winners: CycleWinner[];
}

/**
 * Close a week + select its winners. Idempotent via the `closed_at IS NULL` claim: a
 * second call (or a concurrent replica) finds 0 rows and no-ops. The claim, winner
 * writes, and challenge-close run in ONE transaction so the week is never marked closed
 * without its winners. enqueueWinner + the audit row run AFTER commit (a pipeline-card
 * failure must not roll back the close). `force` re-arms an already-closed week INSIDE that same
 * transaction (the manual demo path); weekly_winners ON CONFLICT keeps the artifact single.
 *
 * Runs as SYSTEM (owner pool, no `app.current_tenant` GUC — see cycle-scheduler.ts), so
 * EVERY query below must carry its own tenant predicate: RLS is bypassed here and will
 * not narrow anything for us.
 */
export async function closeCycle(
  week: string,
  tenantId: string,
  database: Db = defaultDb,
  opts: { force?: boolean } = {},
): Promise<CloseResult> {
  let closed = false;
  const winners: CycleWinner[] = [];
  // ⛔ 0110: this closes `tenantId`'s row for the period and crowns only `tenantId`. Another tenant's
  // row for the same period is another race with its own clock.
  const p = periodFromKey(week);
  const thisRow = and(
    eq(marketplaceCycles.tenant_id, tenantId),
    eq(marketplaceCycles.period_kind, p.kind),
    eq(marketplaceCycles.period_key, week),
  );

  await database.transaction(async (tx) => {
    // ⛔ THE `force` RE-ARM IS INSIDE THE TRANSACTION, IMMEDIATELY BEFORE THE CLAIM THAT UNDOES IT.
    // It used to run in its OWN statement before `database.transaction(...)` opened, which meant a
    // window — and a permanent one on failure: if anything below threw (a winner write, the
    // challenge sweep, a lost connection), the transaction rolled back and the week was left
    // `phase='solution_phase', closed_at=null` FOREVER, with no scheduler path that reaches it
    // (`tickCycles` only closes a cycle once `now >= closes_at`, and for an already-elapsed week
    // that is true, so in practice the next tick did re-close it — but any week whose boundaries
    // were re-derived, or any failure on the LAST tick before an outage, left it open).
    //
    // That used to be nearly harmless: the week's challenges were already `closed`, and votability
    // was read off the parent challenge, so a re-armed cycle row changed nothing anyone could act
    // on. IT IS NOT HARMLESS ANY MORE. `weekClosedSql` reads `marketplace_cycles.phase` directly:
    // a week stuck at `solution_phase` is a week whose every solution is votable again, months
    // after it ended. Atomic re-arm-and-reclose closes that window — either the week ends this call
    // or nothing about it moved.
    if (opts.force) {
      await tx
        .update(marketplaceCycles)
        .set({ phase: 'solution_phase', closed_at: null, updated_at: new Date() })
        .where(thisRow);
    }

    const claim = await tx
      .update(marketplaceCycles)
      .set({ phase: 'closed', closed_at: new Date(), updated_at: new Date() })
      .where(and(thisRow, isNull(marketplaceCycles.closed_at)))
      .returning({ id: marketplaceCycles.id });
    if (claim.length === 0) return; // already closed → no-op
    closed = true;

    // ⛔ THE CHALLENGE SWEEP WAS REMOVED HERE — DO NOT PUT IT BACK.
    // This used to run `update(challenges).set({ status: 'closed' })` over every row in the week,
    // with the comment "Always close the week's challenges (winner or not)". Closing the CYCLE is a
    // statement about a weekly competition; it is NOT a statement that the underlying work is done.
    // A challenge can legitimately wait months for someone able to solve it — at a large company
    // with thousands of challenges that is the normal case — so the calendar must not close it.
    //
    // Measured consequence of the old behaviour: all 17 production challenges were `closed`, the
    // board rendered empty under its default `?open=true` filter, and every vote answered
    // `409 voting_closed`. Demo and evaluation content has to stay available at all times.
    //
    // What still happens here is correct and unchanged: the CYCLE closes, winners are ranked and
    // recorded. Only the challenges outlive it. A challenge now leaves `voting`/`solution_phase`
    // solely by an explicit act, never by the clock.

    // The tenants that actually competed this week. Ordered so a close is deterministic
    // (and so the audit row's winner list is stable between replays).
    const tenantRows = await tx
      .selectDistinct({ tenant_id: solutions.tenant_id })
      .from(solutions)
      // 0110: only this cycle's tenant competes in it (at most one row comes back).
      .where(eligibleForPeriod(week, tenantId))
      .orderBy(asc(solutions.tenant_id));

    for (const { tenant_id } of tenantRows) {
      // Winner = that TENANT's top eligible solution (deterministic tie-break). Carry the
      // tenant_id forward so the weekly_winners insert sets it explicitly: the close runs as
      // SYSTEM (no tenant GUC) so the column's GUC default would resolve to NULL otherwise.
      const [top] = await tx
        .select({ id: solutions.id, challenge_id: solutions.challenge_id, votes: solutions.votes_count })
        .from(solutions)
        .where(eligibleForPeriod(week, tenant_id))
        .orderBy(...WINNER_ORDER)
        .limit(1);
      // A WINNER NEEDS AT LEAST ONE VOTE. `WINNER_ORDER` leads on `desc(votes_count)`, so on a set
      // of one it returns that one whatever its score — and the only guard used to be "is the set
      // empty". A week whose sole entry nobody voted for therefore crowned it, flipped it to
      // `shipping`, and opened a production pipeline card (enqueueWinner, below) on the strength of
      // nobody's opinion. That is not a cosmetic problem: it means one person can push their own
      // flow into the production pipeline unilaterally, just by being the only submitter.
      //
      // ⛔ THE GUARD BELONGS HERE, NOT IN `eligibleForWeek`. That predicate is shared with the READ
      // surface (routes/marketplace-summary.ts), where a 0-vote solution is a perfectly legitimate
      // row to list as a candidate or an honourable mention. Narrowing it there would delete rows
      // from pages that should show them. The close is the only place "may this WIN" is asked.
      //
      // Falling through to `continue` lands the week on the already-existing `Closed · no winner`
      // audit path below (resultTone 'warn'), which is exactly the right description of what
      // happened.
      //
      // ⛔ WHAT THIS COSTS, STATED EXACTLY — IT IS TERMINAL ONLY *AFTER* THIS CLOSE COMMITS.
      //
      // Two earlier drafts of this comment were both wrong, in opposite directions, and the second
      // one is why nine consecutive weeks shipped with `winner_solution_id` NULL. Draft 1 said the
      // 0-vote entry is "left at `voting` so a later force-close can re-decide it once somebody
      // actually votes". Draft 2 corrected that to "the week is terminal, nobody can become
      // somebody who actually votes" — because `vote-service.loadTarget` derived a solution's
      // votability from its PARENT CHALLENGE's status, and the sweep above had just closed every
      // challenge in the week. That was an accurate description of a BUG, written down as a design.
      //
      // THAT BUG IS WHAT PRODUCED THE NINE WINNERLESS WEEKS, and it never needed a close to
      // trigger. `healOrphanedChallenges` used to ADVANCE any challenge whose own week was over
      // (it is report-only now, see its docstring — the write it once did is gone), and
      // `routes/solutions.ts` files a solution into the week it was SUBMITTED in — so an entry in
      // the live week, answering an older challenge, was struck unvotable the moment the next tick
      // touched its parent. Prod's whole 2026-W33 board was one such row: filed 03:49Z on
      // 2026-08-10, unvotable by 11:53Z the same morning, and therefore unwinnable at the close.
      //
      // WHAT IS TRUE NOW. `weekClosedSql` (host/cycle-eligibility.ts) makes votability a property
      // of THIS week's cycle row, so:
      //   • WHILE THE WEEK IS RUNNING a 0-vote entry stays fully votable. This `continue` is not a
      //     verdict on it — the close simply has not happened yet, and somebody genuinely can
      //     become the first voter.
      //   • ONCE THIS TRANSACTION COMMITS the week IS terminal, and now for a reason that is a
      //     design rather than an accident: the cycle row goes `phase='closed'`, `weekClosedSql` is
      //     true for every solution stamped with this week, and every later vote 409s. A `force`
      //     re-close re-arms and re-closes inside ONE transaction (see the top of this function),
      //     so there is no window in which the re-armed week accepts votes either.
      //
      // That end state is accepted, not overlooked. The alternative — crowning a submission nobody
      // endorsed, flipping it to `shipping` and opening a production pipeline card — lets one
      // person push their own flow into production unilaterally by being the only submitter. A
      // winnerless week is the better failure and it is honestly labelled. If low engagement still
      // makes winnerless weeks common now that voting actually works, the fix is a re-vote path
      // (re-open the cycle row, which is now the single thing votability reads), NOT dropping this
      // guard.
      if (!top || top.votes === 0) continue;

      // The stats land on a row the WINNING TENANT reads, so the aggregate must be scoped to
      // that tenant. Unscoped it stamped every other tenant's solution count + vote totals
      // into a tenant-readable row — a cross-tenant disclosure, not just a wrong number.
      // Shared with the read surface so /api/winner's "week in numbers" recomputes THIS
      // aggregate rather than a second, subtly different one.
      const stats: WeeklyWinnerStats = await periodSolutionStats(week, tenant_id, tx);

      // DESIGN CHOICE (force-close coherence): `force` re-arms an already-closed week
      // (closed_at cleared above) so this whole block can run again with fresh vote
      // counts, and `top` may now be a DIFFERENT solution than the one weekly_winners
      // already holds for (tenant_id, week) — normal voting can keep moving right up
      // until an admin re-triggers the manual demo path. onConflictDoNothing here would
      // leave the OLD winner row in place while still unconditionally flipping the NEW
      // top to 'shipping' below: two 'shipping' solutions for one tenant/week, and the
      // audit/pipeline record (driven by `top`) disagreeing with GET /api/winner (still
      // reading the old row). Chosen fix: onConflictDoUpdate — the winner row always
      // reflects the CURRENT top — plus dethrone the previous winner's solution back to
      // 'voting' when it's being displaced, so at most one solution is ever 'shipping'
      // per (tenant, week). (Alternative considered: refuse `force` outright once the top
      // has moved. Rejected — that defeats the documented purpose of `force` as a re-decide
      // path and would leave the SAME two-invariant violation for anyone who force-closed
      // once already, since there'd be no way to correct it going forward.) Note this does
      // NOT retract a dethroned solution's already-created pipeline_items card (Session 6:
      // enqueueWinner is idempotent per solution_id, and pipeline_items has no "cancelled"
      // stage) — that card is left as historical debris, out of this fix's scope.
      const [existingWinner] = await tx
        .select({ solutionId: weeklyWinners.solution_id })
        .from(weeklyWinners)
        .where(and(eq(weeklyWinners.tenant_id, tenant_id), eq(weeklyWinners.week, week)));
      if (existingWinner && existingWinner.solutionId !== top.id) {
        // Only unwind a status this row itself put in place — never clobber a status the
        // production pipeline has since moved past (e.g. an operator already archived it).
        await tx
          .update(solutions)
          .set({ status: 'voting', updated_at: new Date() })
          .where(and(eq(solutions.id, existingWinner.solutionId), eq(solutions.status, 'shipping')));
      }

      await tx
        .insert(weeklyWinners)
        .values({
          ...periodColumns(periodFromKey(week)),
          solution_id: top.id,
          challenge_id: top.challenge_id,
          tenant_id,
          stats,
        })
        .onConflictDoUpdate({
          target: [weeklyWinners.tenant_id, weeklyWinners.week],
          set: { solution_id: top.id, challenge_id: top.challenge_id, stats, announced_at: new Date() },
        });
      await tx
        .update(solutions)
        .set({ status: 'shipping', updated_at: new Date() })
        .where(eq(solutions.id, top.id));

      winners.push({ tenantId: tenant_id, solutionId: top.id, challengeId: top.challenge_id, stats });
    }

    // NOTE: marketplace_cycles.winner_solution_id / .stats are deliberately NOT written any
    // more. marketplace_cycles is the platform-wide phase clock (a global, non-RLS table —
    // 0028), so those two single-valued columns cannot represent N per-tenant winners; the
    // only thing they could hold is one arbitrary tenant's solution id + platform-wide totals,
    // served to every tenant through GET /api/cycle/current. weekly_winners is the winner
    // artifact. 0047 nulls out the values earlier closes left behind.
  });

  if (closed && winners.length > 0) {
    // After commit: land each winner on the pipeline (idempotent) + audit. Best-effort —
    // a pipeline-enqueue failure must not undo the (committed) close, and one tenant's
    // failure must not skip the remaining tenants.
    //
    // ⚠️ EACH IN ITS OWN SAVEPOINT (`bestEffort`). The tick now runs in ONE transaction (see
    // `tickCycles`), and a failed statement aborts the transaction it runs in whether or not JS
    // catches the error — without the savepoint, one bad pipeline card would roll the whole tick back.
    for (const w of winners) {
      await bestEffort(
        database,
        (d) => enqueueWinner(w.solutionId, d),
        (err) => log.error('cycle_enqueue_winner_failed', { component: 'cycle', week, tenantId: w.tenantId, err }),
      );
    }
    // One audit row per week (audit_log is a platform table read only by super_admin, so the
    // per-tenant detail belongs in metadata rather than in N rows nobody can attribute).
    await bestEffort(
      database,
      (d) =>
      recordAudit(
        {
          action: 'cycle.close',
          category: 'deploy',
          targetType: 'marketplace_cycle',
          targetId: week,
          result: `Winners announced · ${winners.length} tenant${winners.length === 1 ? '' : 's'}`,
          resultTone: 'ok',
          metadata: { week, tenantId, winners },
        },
        d,
      ),
      (err) => log.error('cycle_close_audit_failed', { component: 'cycle', week, err }),
    );
  } else if (closed && (await periodHadActivity(database, tenantId, p))) {
    // No winner: audited only when the period had a challenge or a solution (`periodHadActivity`).
    await bestEffort(
      database,
      (d) =>
      recordAudit(
        {
          action: 'cycle.close',
          category: 'deploy',
          targetType: 'marketplace_cycle',
          targetId: week,
          result: 'Closed · no winner',
          resultTone: 'warn',
          metadata: { week, tenantId },
        },
        d,
      ),
      (err) => log.error('cycle_close_audit_failed', { component: 'cycle', week, err }),
    );
  }

  return { closed, winners };
}

/** Run `fn` in its own transaction — a SAVEPOINT when `database` already is one — and hand any
 *  failure to `onError` (which logs; never throws): the caller's transaction survives a failed
 *  statement inside `fn`. */
async function bestEffort(database: Db, fn: (d: Db) => Promise<unknown>, onError: (err: unknown) => void): Promise<void> {
  try {
    await database.transaction(async (sp) => {
      await fn(sp as unknown as Db);
    });
  } catch (err) {
    onError(err);
  }
}

export interface TickResult {
  /** The setting this tick read (`cycle.cadence`). */
  cadence: Cadence;
  /** The key of the period that governs after this tick (open-claimed by it, or the running row that
   *  still covers `now` — possibly stretched by a pending switch); null when the cadence is off. */
  opened: string | null;
  backfilled: string[]; // whole periods missed during downtime, opened by this tick
  advanced: string[]; // weeks that entered solution_phase this tick
  closed: string[]; // weeks that closed this tick
  orphaned: string[]; // ids of challenges sitting in a week with no live cycle — report only, nothing here is written
  rehomed: number; // stranded rows this tick's sweep moved into the current period (or to OFF)
}

/** How many missed weeks a single tick will back-fill. A long outage should catch the engine up;
 *  an empty `marketplace_cycles` on a fresh install must NOT walk from the epoch. 26 weeks is far
 *  beyond any plausible downtime and bounded enough to stay a handful of INSERTs. */
const MAX_BACKFILL_WEEKS = 26;

/**
 * Open every ISO week between the newest cycle on record and `current`, so a week that elapsed
 * entirely while CP was down still gets a cycle row.
 *
 * `tickCycles` used to open ONLY `weekString(now)` and then advance existing rows. Challenges are
 * stamped with `challengeWeekFor` (0047), which can name a week the engine never opened — and a
 * cycle row is what carries the boundaries that drive `voting → solution_phase → closed`. So a
 * full week of downtime left every challenge stamped into it stuck in `voting` forever, with
 * nothing to advance them: not a delayed close, a permanent one. Returns the weeks it opened.
 *
 * ⛔ THIS FUNCTION CREATES CYCLE ROWS FOR WEEKS THAT ARE ALREADY IN THE PAST, AT `phase='voting'`.
 * Say it out loud here, because two docblocks elsewhere (this file's `healOrphanedChallenges`, and
 * `weekClosedSql` in host/cycle-eligibility.ts) reason from "nothing in this engine ever creates a
 * row for a past week". That is a description of the STEADY STATE — true of prod today, where W21
 * and W23 carry challenges with no `marketplace_cycles` row at all — and it is NOT an invariant.
 * Every week this loop opens satisfies `w < current` by construction.
 *
 * It is safe in the happy path and only there: the caller opens these rows BEFORE the same tick's
 * loop reads `phase <> 'closed'`, and every one of them is past both its boundaries, so the loop
 * drives each straight through `solution_phase → closed` milliseconds later. The order in
 * `tickCycles` is load-bearing for that reason. If the loop throws, or the process dies between the
 * two, the back-filled weeks stay `voting` — and `weekClosedSql` then reports every solution filed
 * into them as VOTABLE until a later tick finishes the job. See the window note in
 * cycle-eligibility.ts; this is the failure-driven half of it.
 */
async function backfillMissedCycles(current: Period, tenantId: string, database: Db, timeline: CadenceTimeline): Promise<string[]> {
  // THIS TENANT's newest cycle on record, by START (never by key text — keys of different kinds do not sort).
  const [newest] = await database
    .select({ kind: marketplaceCycles.period_kind, start: marketplaceCycles.period_start, closes: marketplaceCycles.closes_at })
    .from(marketplaceCycles)
    .where(eq(marketplaceCycles.tenant_id, tenantId))
    .orderBy(desc(marketplaceCycles.period_start))
    .limit(1);
  // No cycles at all = a fresh install, not an outage. The caller opens `current` and that is the
  // engine's first period; there is no history to catch up on.
  if (!newest) return [];

  // Walk from the newest row's (possibly stretched) CLOSE, following what was IN FORCE at each
  // boundary according to the FULL cadence history (`scheduledPeriods` over `policy_changes`):
  // old-kind periods (stretched to a switch), the new kind from it, an `off` stretch jumped to the
  // switch that ended it.
  //
  // ⛔ THE HISTORY, NOT THE ROW'S ONE `previous_value`. With week→month recorded Oct 8 (for Nov 1)
  // and month→week recorded Nov 15 (for Dec 7) during one outage, the row alone says "month until
  // Dec 7": the walk from the newest week's close found no month boundary on Oct 5 and stopped, so
  // the October weeks never opened and their entries were dead. Replayed, the walk opens W41..W43
  // (W43 stretched to Nov 1), November (stretched to Dec 7), and stops at the current week.
  //
  // It still refuses to INVENT a crossing: a kind change with no recorded switch since the previous
  // period began (or a boundary that is not a period start) ends the walk — a kind switch is not an
  // outage. Stops before `current`, which the caller opens itself.
  const plan = scheduledPeriods(
    timeline,
    { start: newest.start, end: newest.closes, kind: newest.kind as PeriodKind },
    current.start,
    MAX_BACKFILL_WEEKS,
  );
  const opened: string[] = [];
  for (const p of plan.periods) {
    // `null`: a back-filled period is in the past and never the sweep's destination; the tick
    // sweeps once itself after the current period is open.
    await claimCycle(p, tenantId, database, null);
    opened.push(p.key);
  }
  if (plan.capped) {
    log.warn('cycle_backfill_capped', {
      component: 'cycle',
      tenantId,
      maxBackfillPeriods: MAX_BACKFILL_WEEKS,
      stoppedAt: plan.stoppedAt.toISOString(),
      current: current.key,
    });
  }
  return opened;
}

/** How many orphaned challenges a single tick's report will name. Prod's whole backlog is 16, so
 *  this is far above any real case while keeping the read — and the audit row's JSONB — bounded. */
const MAX_HEAL_CHALLENGES = 500;

/**
 * Report challenges sitting in a week whose cycle is no longer live to reach them. Report-only:
 * this function writes nothing to `challenges.status`.
 *
 * THE HOLE THIS DESCRIBES. `challenges.status` has exactly ONE writer now: `routes/solutions.ts`
 * sets `solution_phase` inside the solution-insert transaction when the first solution is filed
 * against a challenge; a challenge with none stays `voting`. Neither that writer nor anything in
 * this engine is triggered by a week ending — the product owner ruled the calendar must not decide
 * a challenge's phase — so a challenge that never gets a solution, in a week nobody is tending any
 * more, sits at `voting` forever. THAT IS NOW CORRECT, not a bug: `voting` is the resting state for
 * "no solution yet", regardless of what week it is. What is still worth surfacing is WHICH
 * challenges are in that state in a week whose own cycle has moved on, because a solution can still
 * legitimately be filed against one at any time and the resulting `solution_phase` challenge then
 * has no live weekly cycle judging it either.
 *
 * That is not hypothetical. Prod carried 16 orphaned rows: the showcase seeders stamp HARDCODED
 * week literals (`'2026-W21'`, `'2026-W23'`) and were re-run on 2026-06-25, i.e. after those weeks
 * had closed. Seven weeks later the board still advertised them as "In voting", and the vote path —
 * which reads `challenges.status` and never joins the cycle — happily accepted votes on them. 10
 * challenge votes in prod went nowhere.
 *
 * ⚠️ THE PREDICATE IS A PROPERTY, NEVER A LIST OF WEEKS. An enumerated fix would have missed
 * rows: prod holds 4 more challenges than HEAD's seed specs account for (older revisions of the
 * seed lists), so any hand-written week list is a guess about history.
 *
 * ⛔ THE PROPERTY IS "PAST WEEK WITH NO LIVE CYCLE" — *NOT* "has a closed cycle row". The first
 * draft of this used `exists (cycle where phase='closed')`, which reads as the obvious statement of
 * the invariant and is WRONG in exactly the case it was written for. An adversarial pass measured
 * it against prod:
 *
 *     2026-W21   3 challenges   cycle row: NONE
 *     2026-W23  12 challenges   cycle row: NONE
 *     2026-W24   1 challenge    cycle row: closed
 *
 * The oldest `marketplace_cycles` row prod has is W24, and old weeks routinely have no row at all:
 * no seed path inserts into `marketplace_cycles`, and a normally-running `tickCycles` only ever
 * opens the current week. So the "closed cycle" form would have named 1 of the 16 rows it was
 * written for.
 *
 * ⚠️ THAT IS THE STEADY STATE, NOT AN INVARIANT — an earlier draft of this paragraph asserted that
 * "nothing ever creates a row for a past week", and `backfillMissedCycles` (above) does exactly
 * that after an outage, at `phase='voting'`. Which is precisely why the predicate below is
 * `phase <> 'closed'` rather than "no row": a past week that DOES have a live row is a week whose
 * challenges are not orphaned — a solution filed against one is answered by a real cycle, not a
 * dead one.
 *
 * A week strictly older than the current one whose cycle was never opened is just as unreachable as
 * one whose cycle closed — more so, because there is not even a row to re-open. Both are covered by
 * asking the real question: is this challenge's week over, and is there nothing live attached to it?
 *
 * ⚠️ `week < current` IS LOAD-BEARING, twice over.
 *   1. It is what keeps the running and future weeks out of the report — an open or solution-phase
 *      cycle's challenges are doing exactly what they should, and a week with no row YET is a week
 *      the next tick will open (`tickCycles` → `openCycle(current)`), not an orphan.
 *   2. It closes a hole the adversarial pass found in the first draft: `challengeWeekFor` rolls a
 *      late submission into NEXT week without checking that week's phase, so a future week's
 *      challenges must never be reported as orphaned — they haven't even started yet.
 * `YYYY-Www` is fixed-width and zero-padded, so `<` is chronological — the same property
 * `laterWeek` and `backfillMissedCycles` rely on. The empty-string week (the `text NOT NULL
 * DEFAULT ''` legacy value) sorts before every real week and is genuinely unreachable, so it is
 * correctly in scope.
 *
 * Returns the ids found, so `TickResult` can report the orphan population instead of it going
 * unseen (the same lesson as the tick-skip logging), and so the caller can write ONE audit row for
 * what is otherwise an untraced population feeding the nightly compliance export. There used to be
 * a write here (advancing the orphaned challenge to `solution_phase`) and a `healed` result naming
 * the rows it touched; both are deleted, per the ruling that the calendar does not get a vote in a
 * challenge's phase. `orphaned` below is the read that write used to be scoped by — same
 * population, no longer mutated.
 *
 * ⚠️ IT ALSO RETURNS `stranded`, AND THAT LIST IS THE INSTRUMENT THIS ENGINE DID NOT HAVE. A
 * solution's OWN week can still be live while the CHALLENGE it answers sits in a dead one. Under
 * the OLD rule (votability read off the parent challenge) every such row was silently struck
 * unvotable the moment a tick's now-deleted write touched its challenge, and unwinnable at the next
 * close — that is precisely how prod's 2026-W33 entry died eight hours after it was filed, and how
 * nine weeks closed with no winner while every tick logged a clean heal. `weekClosedSql` now makes
 * votability a property of the SOLUTION's own cycle row, so that strike can no longer happen — but
 * the shape is still worth naming in the `cycle.heal` audit row: it is the only place a compliance
 * reader (or the next engineer) can see "these challenges have no live cycle, and these live
 * entries answer them". Had this line existed in June, the defect would have surfaced then instead
 * of in August.
 */
async function healOrphanedChallenges(
  current: Period,
  tenantId: string,
  database: Db,
): Promise<{ orphaned: string[]; stranded: string[] }> {
  // Bounded, oldest-first — one report per tick stays a single bounded read, and it consistently
  // names the LONGEST-orphaned challenges first rather than an arbitrary subset.
  //
  // No `status = 'voting'` narrowing any more. That filter used to exist so the (now-deleted)
  // UPDATE would converge — it advanced a row to `solution_phase`, and without the narrowing the
  // rows it had just advanced would still match on the NEXT tick and get re-advanced (and
  // re-audited) forever. A report has nothing to converge: it is correct for the same challenge to
  // be named every tick for as long as its week stays orphaned, whatever its status is. Dropping
  // the filter also fixes a gap the filter would otherwise leave — a challenge a SOLUTION has since
  // moved to `solution_phase` is still sitting in a week with no live cycle, and belongs in this
  // report exactly as much as one still at `voting` does.
  //
  // Spelled ONCE and used twice (the ids below, then the stranded-solutions read) so the two lists
  // are always about exactly the same set of challenges — two hand-copied subqueries would drift.
  // 0107: "older than the current period" is `period_start <`, and a period of ANOTHER kind (left
  // over from before a cadence change) counts as past too. `'off'` rows were filed with no period
  // and are never orphaned by one; legacy `week = ''` rows (period NULL) still are.
  const currentStart = sql`${current.start.toISOString()}::timestamptz`;
  const orphanCandidates = sql`(
    select c2.id from ${challenges} c2
    where c2.tenant_id = ${tenantParam(tenantId)}
      and coalesce(c2.period_kind, '') <> 'off'
      and (c2.period_start is null or c2.period_start < ${currentStart} or c2.period_kind <> ${current.kind})
      and not exists (
        select 1 from ${marketplaceCycles} mc2
        where mc2.tenant_id = c2.tenant_id
          and mc2.period_kind = c2.period_kind and mc2.period_start = c2.period_start and mc2.phase <> 'closed'
      )
    order by c2.created_at asc
    limit ${MAX_HEAL_CHALLENGES}
  )`;

  const orphanedRows = await database
    .select({ id: challenges.id })
    .from(challenges)
    .where(sql`${challenges.id} in ${orphanCandidates}`);

  // `not(weekClosedSql(...))` is the same gate the vote path applies, so "stranded" means exactly
  // "an entry that is still votable today, under a challenge with no live cycle of its own".
  //
  // ⚠️ NO `LIMIT` HERE, WHILE `orphaned` IS CAPPED AT 500 — THE ASYMMETRY IS DELIBERATE.
  //   1. It is not actually unbounded: it selects through `orphanCandidates`, which is already
  //      capped at 500 challenges, so it can never walk the whole solutions table — it is "the
  //      entries hanging off at most 500 challenges". Worst realistic payload measured at ~220 KB
  //      of JSONB, once a day, against a column that routinely carries per-tenant winner lists.
  //   2. Truncating it would defeat what it is for. `stranded` exists because its ABSENCE is what
  //      let the parent-challenge defect run unseen from June to August; a silently short list is
  //      the same failure in miniature. If it ever does need bounding, the shape is "record the
  //      full COUNT, truncate the ids" — never a cap that makes the number itself a lie.
  const strandedRows = await database
    .select({ id: solutions.id })
    .from(solutions)
    .where(
      and(
        eq(solutions.tenant_id, tenantId),
        sql`${solutions.challenge_id} in ${orphanCandidates}`,
        not(periodClosedSql(SOLUTION_PERIOD, { mode: 'on', kind: current.kind, start: current.start })),
      ),
    );

  return { orphaned: orphanedRows.map((r) => r.id), stranded: strandedRows.map((r) => r.id) };
}

/**
 * The single idempotent advance step. Advances EVERY non-closed cycle past any boundary it has
 * crossed (so a running period finishes under its own rules whatever the setting now says). Then,
 * when no row covers `now` any more, it opens the period IN FORCE at `now` (host/cycle-cadence.ts):
 * the previous cadence's next period while a switch is still pending — STRETCHED to the switch
 * boundary when the one after it would cross it — and the new cadence's period from the boundary
 * on. It back-fills periods missed while CP was down (following the full cadence history), and
 * sweeps stranded rows into the current period (`sweepStranded`) — on EVERY tick, off included.
 * Safe to call repeatedly.
 *
 * OFF: with `off` in force and nothing running, the tick opens nothing, closes nothing and reports no
 * orphans; it only sweeps stray period-stamped rows to the OFF stamp. A period that was running when
 * the setting went off still closes normally.
 */
export async function tickTenantCycles(
  now: Date,
  tenantId: string,
  database: Db = defaultDb,
  opts: { setting?: Cadence; pending?: PendingSwitch | null; timeline?: CadenceTimeline } = {},
): Promise<TickResult> {
  if (opts.setting) {
    const pending = opts.pending ?? null;
    return tickUnder(now, tenantId, database, {
      setting: opts.setting,
      pending,
      timeline: opts.timeline ?? timelineOfPolicy(opts.setting, pending),
    });
  }
  // ⛔ ONE TRANSACTION, ONE CONNECTION, ONE TENANT: the tenant's lock first (CYCLE_TENANT_LOCK), then
  // its policy read FRESH `FOR SHARE` (with its full history), then ALL the tick's work for that tenant
  // on the same transaction. It used to take the share lock on one owner-pool connection and do the
  // work on `database` — a SECOND owner connection held for the whole tick, on a pool of 4 shared by
  // four schedulers that all fire at boot (the deadlock class runSystemTick's docblock records).
  //
  // The cost of atomicity is accepted: a tenant's tick that fails rolls back whole and the next one
  // redoes it (every step is idempotent). `closeCycle` still treats its pipeline card and audit row as
  // best-effort — each in its own SAVEPOINT, so their failure cannot abort the tick.
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockTenantCycle(tx, tenantId); // BEFORE any row lock — see CYCLE_TENANT_LOCK
    const policy = await readCadencePolicyLocked(tx, tenantId, now);
    return tickUnder(now, tenantId, tx, policy);
  });
}

/** One tenant's outcome in a platform tick. */
export interface TenantTickOutcome {
  tenantId: string;
  result?: TickResult;
  error?: string;
}

/** What a platform tick did: one outcome per tenant, in tenant_id order. */
export interface CycleTickSummary {
  tenants: TenantTickOutcome[];
  /** Tenants whose tick threw on BOTH attempts (rolled back; counted + logged; next retry is the next day's tick). */
  failed: string[];
}

/**
 * The tenants the engine drives, in tenant_id order (THE lock order — see CYCLE_TENANT_LOCK): every
 * tenant that is not offboarded, plus any tenant (offboarded or not) that still has a non-closed
 * cycle row, so a running period is always finished.
 */
export async function engineTenantIds(database: Db): Promise<string[]> {
  const live = database
    .selectDistinct({ id: marketplaceCycles.tenant_id })
    .from(marketplaceCycles)
    .where(and(sql`${marketplaceCycles.tenant_id} is not null`, ne(marketplaceCycles.phase, 'closed')));
  const active = await database.select({ id: tenants.id }).from(tenants).where(isNull(tenants.offboarded_at));
  const ids = new Set<string>(active.map((r) => r.id));
  for (const r of await live) if (r.id) ids.add(r.id);
  return [...ids].sort();
}

/**
 * THE PLATFORM TICK (the daily scheduler and the boot catch-up): `tickTenantCycles` for every engine
 * tenant, SEQUENTIALLY, each in its OWN transaction under its own lock. One tenant's failure is caught,
 * logged and counted; the others still advance (a bad row in one workspace must not freeze every
 * other workspace's cycle). Sequential on purpose: the owner pool is 4 connections, shared with three
 * other schedulers that fire at boot.
 *
 * ⛔ A CAUGHT FAILURE MUST STILL REACH THE ALERT. Catching per tenant means this function RETURNS
 * normally, so `claimTick`'s `countFailures` wrapper (which only counts a THROW) never sees it and
 * `commonpractice_scheduler_tick_failed_total` — the series behind the gitops alert
 * `CommonPracticeSchedulerTickFailing`, `sum(increase(…[15m])) > 0`, unlabelled — stayed flat while a
 * tenant's cycle silently stopped moving. So: if ANY tenant still failed after the retry below, bump
 * that counter ONCE for the tick (it cannot double-count: the tick itself did not throw) and log one
 * error naming every failed tenant.
 *
 * RETRY. Each tenant's tick rolls back whole and is idempotent, so the failed tenants get ONE more
 * attempt at the end of the same tick (after the others — a lock held by a concurrent switch has had
 * time to release). There is no later retry the same day: the scheduler's claim is per UTC day
 * (`cycleTickKey`), so the boot catch-up of a redeploy on that day is refused, and the next attempt is
 * the next day's 03:00 tick. A tenant that fails twice is therefore the ALERT's job, not a retry loop's.
 */
export async function tickCycles(
  now: Date,
  database: Db = defaultDb,
  opts: { setting?: Cadence; pending?: PendingSwitch | null; timeline?: CadenceTimeline } = {},
): Promise<CycleTickSummary> {
  const outcomes = new Map<string, TenantTickOutcome>();
  const attempt = async (tenantId: string): Promise<boolean> => {
    try {
      outcomes.set(tenantId, { tenantId, result: await tickTenantCycles(now, tenantId, database, opts) });
      return true;
    } catch (err) {
      log.warn('cycle_tick_tenant_attempt_failed', { component: 'cycle', tenantId, err });
      outcomes.set(tenantId, { tenantId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  const ids = await engineTenantIds(database);
  const firstFailures: string[] = [];
  for (const tenantId of ids) if (!(await attempt(tenantId))) firstFailures.push(tenantId);
  const failed: string[] = [];
  for (const tenantId of firstFailures) if (!(await attempt(tenantId))) failed.push(tenantId);

  if (failed.length > 0) {
    incCounter(TICK_FAILED_COUNTER);
    log.error('cycle_tick_tenants_failed', {
      component: 'cycle',
      failed,
      errors: failed.map((t) => ({ tenantId: t, error: outcomes.get(t)?.error })),
      tenantsTotal: ids.length,
    });
  }
  return { tenants: ids.map((t) => outcomes.get(t)!), failed };
}

async function tickUnder(now: Date, tenantId: string, database: Db, policy: SweepPolicy): Promise<TickResult> {
  const { setting, pending, timeline } = policy;
  // ⛔ THE FLOOR IS READ BEFORE THIS TICK CLOSES ANYTHING. A close lifts it (`strandedFloorSql`), and a
  // catch-up that closes a back-filled month would otherwise lift it over a passed-over week the
  // sweep below has not moved yet — turning a stranded row into a dead one inside the very tick that
  // exists to heal it.
  const floor = await readStrandedFloor(database, tenantId, now, policy);
  if (cadenceInForce(now, setting, pending) === 'off' && !(await readLiveCycle(database, tenantId, now))) {
    const rehomed = await sweepStranded(database, tenantId, now, policy, { floor });
    return { cadence: setting, opened: null, backfilled: [], advanced: [], closed: [], orphaned: [], rehomed };
  }

  const advanced: string[] = [];
  const closed: string[] = [];
  const advanceAll = async (): Promise<void> => {
    const open = await database
      .select()
      .from(marketplaceCycles)
      .where(and(eq(marketplaceCycles.tenant_id, tenantId), ne(marketplaceCycles.phase, 'closed')))
      .orderBy(asc(marketplaceCycles.period_start));
    for (const c of open) {
      let phase: MarketplaceCycle['phase'] = c.phase;
      if (phase === 'voting' && now.getTime() >= c.voting_ends_at.getTime()) {
        if (await enterSolutionPhase(c.period_key, tenantId, database)) advanced.push(c.period_key);
        phase = 'solution_phase';
      }
      if (phase === 'solution_phase' && now.getTime() >= c.closes_at.getTime()) {
        const r = await closeCycle(c.period_key, tenantId, database);
        if (r.closed) closed.push(c.period_key);
      }
    }
  };

  // 1. Finish whatever is running, under its own rules (and its own, possibly stretched, close).
  await advanceAll();

  // 2. What governs now. A row still running after step 1 covers `now` (its close is ahead), so
  //    nothing new opens; otherwise `current` is the in-force period starting at its boundary.
  let state = cadenceStateFrom(now, setting, await readLiveCycle(database, tenantId, now), pending);
  const covers = (r: MarketplaceCycle | null): r is MarketplaceCycle =>
    !!r && r.period_start.getTime() <= now.getTime() && now.getTime() < r.closes_at.getTime();
  let opened: string | null = null;
  let backfilled: string[] = [];
  if (state.current && !covers(state.live)) {
    const current = state.current;
    // Before opening `current`: the back-fill reads the newest cycle, and opening `current` first
    // would make that newest `current` and the gap invisible.
    backfilled = await backfillMissedCycles(current, tenantId, database, timeline);
    if (backfilled.length) {
      log.warn('cycle_backfilled_periods', { component: 'cycle', tenantId, count: backfilled.length, periods: backfilled });
    }
    await claimCycle(current, tenantId, database, { now, policy, floor });
    opened = current.key;
    // Drive the back-filled (already elapsed) periods straight through to closed.
    if (backfilled.length) await advanceAll();
    state = cadenceStateFrom(now, setting, await readLiveCycle(database, tenantId, now), pending);
  } else if (state.current && state.live) {
    opened = state.live.period_key;
  }

  // 3. THE SWEEP, every tick, inside this transaction: rows stamped by a pod with a stale policy, or
  //    left behind by anything the open above did not cover, join the current period (or OFF).
  const rehomed = await sweepStranded(database, tenantId, now, policy, { floor });

  if (!state.current) {
    return { cadence: setting, opened, backfilled, advanced, closed, orphaned: [], rehomed };
  }
  const current = state.current;

  // LAST, deliberately: the closes above are what turn a week's cycle into `phase='closed'`, so
  // running this report first would miss this tick's own newly-closed week until the next tick.
  // Nothing here writes any more, but the timeliness argument still holds for the REPORT: a
  // challenge's week only becomes orphaned once its cycle goes `closed`, and running the report
  // after the closes lets the SAME tick that closed the week also name its stragglers, instead of
  // waiting a day for the next one to notice.
  const { orphaned, stranded } = await healOrphanedChallenges(current, tenantId, database);
  if (orphaned.length) {
    // ⚠️ `info`, NOT `warn` — and that downgrade is the point, not a style choice. While this
    // function still WROTE, a non-empty result meant a bulk mutation had just happened and the
    // set converged to empty on the next tick, so a warn fired rarely and always about a change.
    // Report-only, the set never empties: a challenge with no solution, in a week whose cycle has
    // moved on, is the CORRECT resting state under the rule that the calendar does not decide a
    // challenge's phase. Prod holds 17 such rows permanently (weeks W21/W23/W33 have no cycle row
    // and never will), so a warn here would fire every night forever about a state nobody can or
    // should act on — alarm fatigue manufactured by a rename. The actionable signal is `stranded`.
    log.info('cycle_orphaned_challenges_found', {
      component: 'cycle',
      tenantId,
      orphanedCount: orphaned.length,
      strandedCount: stranded.length,
      cappedAtMax: orphaned.length === MAX_HEAL_CHALLENGES,
      maxHealChallenges: MAX_HEAL_CHALLENGES,
    });
    // ONE durable record. Every other transition in this engine writes an audit row
    // (`cycle.advance`, `cycle.close`), and `audit_log` is the source for the nightly compliance
    // export — so a population of challenges no writer can reach, sitting behind only a console
    // line, was the one thing about this engine a compliance reader could not see. Ids go in
    // metadata rather than N rows for the same reason `cycle.close` does it: audit_log is
    // platform-global and super-admin-only, so per-tenant rows nobody can attribute are worse than
    // one row that names them.
    //
    // `stranded` names the solutions whose OWN cycle is still open, sitting under a challenge with
    // no live cycle of its own — see the note on healOrphanedChallenges. It is a diagnostic, not a
    // failure: those rows stay votable. It is recorded because its absence is what let this exact
    // interaction run unseen from June to August.
    // SAVEPOINTED like every other audit write inside the tick's transaction (see enterSolutionPhase).
    await bestEffort(
      database,
      (d) =>
        recordAudit(
          {
            action: 'cycle.heal',
            category: 'deploy',
            targetType: 'marketplace_cycle',
            targetId: current.key,
            result: `${orphaned.length} orphaned challenge${orphaned.length === 1 ? '' : 's'} · no live cycle`,
            resultTone: 'warn',
            metadata: { tenantId, currentWeek: current.key, currentPeriod: current.key, orphaned, stranded },
          },
          d,
        ),
      (err) => log.error('cycle_heal_audit_failed', { component: 'cycle', tenantId, week: current.key, err }),
    );
  }

  return { cadence: setting, opened, backfilled, advanced, closed, orphaned, rehomed };
}

/**
 * ⛔ THE PER-TENANT CYCLE LOCK (0110) — one transaction-scoped advisory lock per tenant,
 * `pg_advisory_xact_lock(0x6380, hashtext(tenant_id::text))`, taken FIRST (before any row lock) by
 * every transaction that drives a tenant's cycle: the tick (`tickTenantCycles`), the manual drive
 * (`driveCycle`), a tenant cadence switch (`switchTenantCadence`) and a platform cadence switch
 * (`switchCadence`, for every tenant it may touch).
 *
 * WHY: the drive and the tick lock rows in OPPOSITE orders (sweep → claim → close vs. advance/close →
 * sweep), and holding the policy rows only `FOR SHARE` does not serialise them — two such transactions
 * could each hold what the other wants next ⇒ 40P01. Taking this lock at the top makes the second
 * wait before it holds anything.
 *
 * ⛔ THE LOCK ORDER (never invert it):
 *   1. tenant advisory lock(s) — a transaction holding SEVERAL takes them in ascending tenant_id order
 *      (only the platform switch does; the tick holds ONE at a time, each tenant in its own transaction)
 *   2. the platform `cycle.cadence` policy row (`FOR SHARE` in the engine, `FOR UPDATE` in the switch)
 *   3. the tenant's `tenant_cycle_cadence` row (`FOR SHARE` / `FOR UPDATE`)
 *   4. cycle rows, then stamped rows.
 * The platform switch used to take the policy row FIRST; it now takes every engine tenant's lock
 * before it, so a tick holding tenant T (and waiting for the policy row's share lock) can never be
 * waiting on a switch that holds the policy row and waits for T.
 *
 * Re-entrant within one transaction and released at COMMIT/ROLLBACK — works behind PgBouncer's
 * transaction pooling, unlike a session lock (tick-locks.ts). Two-int form in namespace 0x6380: no key
 * shared with the old platform engine lock (0x6379, retired by 0110), the connector lock (0x6370) or
 * the migration runner's single-bigint key. A hashtext collision between two tenants only serialises
 * them; it cannot deadlock (every multi-lock holder takes them in the same order).
 */
export const CYCLE_TENANT_LOCK_NS = 0x6380;
export async function lockTenantCycle(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CYCLE_TENANT_LOCK_NS}::int, hashtext(${tenantId}::uuid::text))`);
}

/**
 * POST /api/cycle/advance's work for ONE tenant, in ONE transaction under that tenant's lock with its
 * policy read `FOR SHARE` — exactly like the tick. `to` absent = a plain tick of that tenant.
 */
export async function driveCycle(
  week: string,
  to: 'solution_phase' | 'closed' | undefined,
  now: Date,
  tenantId: string,
  database: Db = defaultDb,
  opts: { force?: boolean } = {},
): Promise<void> {
  await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockTenantCycle(tx, tenantId); // BEFORE any row lock — see CYCLE_TENANT_LOCK
    const policy = await readCadencePolicyLocked(tx, tenantId, now);
    if (!to) {
      await tickUnder(now, tenantId, tx, policy);
      return;
    }
    // ⛔ SWEEP BEFORE DRIVING. Closing a row lifts the stranded floor (cycle-eligibility
    // `strandedFloorSql`); a stranded row it would pass over joins the current period first.
    await sweepStranded(tx, tenantId, now, policy);
    await claimCycle(week, tenantId, tx, { now, policy });
    if (to === 'closed') await closeCycle(week, tenantId, tx, { force: opts.force === true });
    else await enterSolutionPhase(week, tenantId, tx);
  });
}

// ── the cadence SWITCH (PATCH /api/governance/cycle.cadence) ─────────────────────────────────

/** What a cadence change does, computed purely from the instant, the old policy and the live row. */
export interface CadenceSwitchPlan {
  /** The pending switch to persist on the policy row (`effective_from` / `previous_value`). */
  pending: PendingSwitch | null;
  /** New boundaries for the running row (stretched, un-stretched or unchanged), or null. */
  liveUpdate: { id: string; voting_ends_at: Date; solution_ends_at: Date; closes_at: Date } | null;
  /** The period that follows the running one under the new plan (null: none — switching off). */
  next: Period | null;
}

/**
 * ⛔ THE SWITCH RULES (decided 2026-10-14) — a change never opens a partly-elapsed period:
 *
 *   X→Y   X keeps running. Y starts at B = the first Y-boundary at or after E, the end of the X
 *         period open now. The X period that would cross B is stretched to end at B (`stretchedEnd`).
 *   on→off  the open period finishes under its OWN rules (any earlier stretch is undone); then off.
 *   off→Y   the first Y period starts at the next Y boundary at or after now.
 *   X→X     (switching back while a switch is pending) the pending switch is cancelled and the
 *           running period returns to its own end.
 *
 * "The X period open now" is the live row while it has not reached its close; a row past its close
 * is finished (the next tick closes it) and does not count. E is that period's NATURAL end — or, if
 * an earlier stretch already carried it past that, the next X boundary after now.
 */
export function planCadenceSwitch(
  at: Date,
  from: { setting: Cadence; pending: PendingSwitch | null },
  to: Cadence,
  liveRow: MarketplaceCycle | null,
): CadenceSwitchPlan {
  const live =
    liveRow && liveRow.period_start.getTime() <= at.getTime() && at.getTime() < liveRow.closes_at.getTime()
      ? liveRow
      : null;
  const prev = cadenceInForce(at, from.setting, from.pending);
  const x: Cadence = live ? (live.period_kind as PeriodKind) : prev;
  if (x === 'off') {
    if (to === 'off') return { pending: null, liveUpdate: null, next: null };
    const b = firstBoundaryAtOrAfter(to, at);
    return {
      pending: b.getTime() > at.getTime() ? { at: b, previous: 'off' } : null,
      liveUpdate: null,
      next: null,
    };
  }
  const natural = periodFor(x, live ? live.period_start : at);
  let e = natural.end;
  while (e.getTime() <= at.getTime()) e = nextPeriodStart(x, e);

  let pending: PendingSwitch | null = null;
  let close = e;
  if (to !== x && to !== 'off') {
    const b = firstBoundaryAtOrAfter(to, e);
    pending = { at: b, previous: x };
    close = stretchedEnd({ kind: x, start: natural.start, end: e }, b);
  }
  const liveUpdate = live
    ? { id: live.id, ...boundariesOf({ ...natural, end: close }) }
    : null;
  return { pending, liveUpdate, next: periodStartingAt(close, to, pending) };
}

/**
 * Apply a plan's CYCLE side: move the running row's boundaries, then run THE sweep (`sweepStranded`)
 * under the NEW policy at the switch instant. Runs inside the caller's transaction (switchCadence
 * writes the policy row in the same one). Returns the number of rows re-homed.
 *
 * Sweeping HERE, not only at the next open, is what keeps a row from ever looking dead: switching
 * week→off at 01:00 Monday (before the 03:00 tick closes the week) leaves Friday-rolled W+1 rows in a
 * week that will never open — the sweep OFF-stamps them at once, and the open of the first period
 * after a later re-enable takes them in. There is no bounded window here any more; the invariant
 * decides which rows move, and they only ever move into the current period (or OFF).
 */
export async function applyCadenceSwitchToCycles(
  plan: CadenceSwitchPlan,
  database: Db,
  tenantId: string,
  after: { at: Date; setting: Cadence; timeline?: CadenceTimeline },
): Promise<number> {
  if (plan.liveUpdate) {
    const { id, ...b } = plan.liveUpdate;
    await database
      .update(marketplaceCycles)
      .set({ ...b, updated_at: new Date() })
      .where(and(eq(marketplaceCycles.id, id), eq(marketplaceCycles.tenant_id, tenantId)));
  }
  return sweepStranded(database, tenantId, after.at, {
    setting: after.setting,
    pending: plan.pending,
    timeline: after.timeline ?? timelineOfPolicy(after.setting, plan.pending),
  });
}

/** How long a cadence switch waits for the row locks (the tick holds the policy row `FOR SHARE` for
 *  its whole transaction). Past it the PATCH answers 409 `cycle_busy` instead of hanging. */
export const CADENCE_SWITCH_LOCK_TIMEOUT = '10s';

/** Postgres `lock_not_available` (55P03) anywhere in an error's cause chain — a lock_timeout expiry. */
export function isLockTimeout(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    if ((e as { code?: string }).code === '55P03') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** A tenant's running row (not closed, started by `at`), locked `FOR UPDATE` for a switch. */
async function liveRowForSwitch(tx: Db, tenantId: string, at: Date): Promise<MarketplaceCycle | null> {
  const [live] = await tx
    .select()
    .from(marketplaceCycles)
    .where(
      and(
        eq(marketplaceCycles.tenant_id, tenantId),
        ne(marketplaceCycles.phase, 'closed'),
        sql`${marketplaceCycles.period_start} <= ${at.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(marketplaceCycles.period_start))
    .limit(1)
    .for('update');
  return live ?? null;
}

/**
 * The PLATFORM switch (PATCH /api/governance/cycle.cadence), in ONE transaction. It changes the
 * DEFAULT: it applies to every tenant WITHOUT its own `tenant_cycle_cadence` row (they inherit), and
 * to none that has one.
 *
 * Order (CYCLE_TENANT_LOCK): every engine tenant's lock in tenant_id order → the policy row
 * `FOR UPDATE` → plan → persist the value with its pending switch AND its `policy_changes` entry (the
 * history the catch-up replays — recorded HERE so no switch can exist without it) → for each
 * INHERITING tenant: move its running row's boundaries and sweep its stranded rows.
 *
 * `SET LOCAL lock_timeout` bounds every lock wait in the transaction; a timeout surfaces as Postgres
 * 55P03 (`isLockTimeout`), which the route maps to 409 `cycle_busy`.
 */
export async function switchCadence(
  to: Cadence,
  // `null` (the route): the instant is taken AFTER the `FOR UPDATE` below is granted. A Date pins it
  // (tests replaying a dated history).
  atIn: Date | null,
  database: Db,
  // `unlessSame(stored)`: decided UNDER the lock — true makes this a no-op (`changed: false`).
  write: { updatedBy: string | null; unlessSame?: (stored: unknown) => boolean },
): Promise<CadenceSwitchPlan & { oldValue: unknown; rehomed: number; changed: boolean; inheriting: string[] }> {
  const result = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${CADENCE_SWITCH_LOCK_TIMEOUT}'`));
    // 1. Every tenant this switch may touch, locked in tenant_id order BEFORE the policy row.
    const engine = await engineTenantIds(tx);
    for (const id of engine) await lockTenantCycle(tx, id);
    // 2. The policy row.
    const [row] = await tx.select().from(policies).where(eq(policies.key, 'cycle.cadence')).for('update');
    // ⛔ THE SWITCH INSTANT IS READ UNDER THE LOCK. Taken before the wait, a switch that queued behind
    // another (or behind the tick) recorded an instant EARLIER than one that committed before it, and
    // the catch-up — which replays `policy_changes` by `created_at` — replayed them in the wrong order.
    const at = atIn ?? new Date();
    if (row && write.unlessSame?.(row.value)) {
      const pending =
        row.effective_from && row.previous_value ? { at: row.effective_from, previous: row.previous_value as Cadence } : null;
      return { pending, liveUpdate: null, next: null, oldValue: row.value, rehomed: 0, changed: false, inheriting: [] };
    }
    const fromSetting = (row?.value as Cadence | undefined) ?? 'off';
    const fromPending =
      row?.effective_from && row.previous_value
        ? { at: row.effective_from, previous: row.previous_value as Cadence }
        : null;
    // 3. Who inherits: an override row (tenant_cycle_cadence) cannot appear for a locked tenant now —
    //    `switchTenantCadence` writes it under the same tenant lock.
    //    0112: a `follows_platform` row is NOT an override. Once its return has taken effect the
    //    tenant inherits like one with no row (the stale carrier row is dropped here); while its return
    //    is still pending ("returning") the tenant is re-planned from ITS state below.
    const engineSet = new Set(engine);
    const overriding = new Set<string>();
    const returning = new Map<string, TenantCadenceRow>();
    for (const raw of await tx.select().from(tenantCycleCadence)) {
      const r = tenantRowOf(raw);
      if (!r || !r.followsPlatform) {
        overriding.add(raw.tenant_id);
      } else if (!engineSet.has(raw.tenant_id)) {
        overriding.add(raw.tenant_id); // not locked by this switch (offboarded): leave it alone
      } else if (tenantRowGoverns(r, at)) {
        returning.set(raw.tenant_id, r);
      } else {
        await tx.delete(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, raw.tenant_id));
      }
    }
    const inheriting = engine.filter((id) => !overriding.has(id) && !returning.has(id));
    const lives = new Map<string, MarketplaceCycle | null>();
    for (const id of inheriting) lives.set(id, await liveRowForSwitch(tx, id, at));
    // The persisted pending switch is the platform's: planned from the running row inheriting tenants
    // share (they all follow the same clock), or from the calendar when none is running.
    const reference = [...lives.values()].find((r) => r !== null) ?? null;
    const plan = planCadenceSwitch(at, { setting: fromSetting, pending: fromPending }, to, reference);
    await tx
      .update(policies)
      .set({
        value: to,
        effective_from: plan.pending?.at ?? null,
        previous_value: plan.pending?.previous ?? null,
        updated_by: write.updatedBy,
        updated_at: at,
      })
      .where(eq(policies.key, 'cycle.cadence'));
    // ⛔ `old_value` IS THE VALUE READ UNDER THE `FOR UPDATE` ABOVE: two concurrent PATCHes both
    // pre-read the same value, and the second to take the lock must record the FIRST one's new value
    // as its old one. `created_at = at` and `effective_from` make the row a replayable history entry.
    await tx.insert(policyChanges).values({
      policy_key: 'cycle.cadence',
      old_value: row?.value ?? null,
      new_value: to,
      effective_from: plan.pending?.at ?? null,
      changed_by: write.updatedBy,
      created_at: at,
    });
    const timeline = await readCadenceTimeline(tx, { setting: to, pending: plan.pending, updatedAt: at });
    // 4. Each inheriting tenant's own running row and stranded rows.
    let rehomed = 0;
    for (const id of inheriting) {
      const own = planCadenceSwitch(at, { setting: fromSetting, pending: fromPending }, to, lives.get(id) ?? null);
      if ((own.pending?.at.getTime() ?? null) !== (plan.pending?.at.getTime() ?? null)) {
        log.warn('cycle_cadence_switch_tenant_diverges', {
          component: 'cycle',
          tenantId: id,
          platformEffectiveFrom: plan.pending?.at ?? null,
          tenantEffectiveFrom: own.pending?.at ?? null,
        });
      }
      rehomed += await applyCadenceSwitchToCycles({ ...own, pending: plan.pending }, tx, id, { at, setting: to, timeline });
    }
    // 5. Each RETURNING tenant (a `follows_platform` row whose return is still pending): it follows
    //    the platform, so it moves to `to` too — planned from ITS state (still on its old cadence until
    //    the boundary), never from the platform's. Its carrier row is rewritten (or dropped when `to`
    //    can take over at once) and the step is recorded in its history, so its catch-up replays it.
    for (const [id, r] of returning) {
      const live = await liveRowForSwitch(tx, id, at);
      const own = planCadenceSwitch(at, { setting: r.setting, pending: r.pending }, to, live);
      if (own.pending) {
        await tx
          .update(tenantCycleCadence)
          .set({
            value: to,
            effective_from: own.pending.at,
            previous_value: own.pending.previous,
            follows_platform: true,
            updated_by: write.updatedBy,
            updated_at: at,
          })
          .where(eq(tenantCycleCadence.tenant_id, id));
      } else {
        await tx.delete(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, id));
      }
      await tx.insert(tenantCycleCadenceChanges).values({
        tenant_id: id,
        old_value: r.setting,
        new_value: to,
        effective_from: own.pending?.at ?? null,
        actor_id: write.updatedBy,
        created_at: at,
        follows_platform: true,
      });
      const tl = await readTenantTimeline(
        tx,
        id,
        own.pending ? { setting: to, pending: own.pending, updatedAt: at, followsPlatform: true } : null,
      );
      rehomed += await applyCadenceSwitchToCycles(own, tx, id, { at, setting: to, timeline: tl });
    }
    log.info('cycle_cadence_switched', {
      component: 'cycle',
      scope: 'platform',
      from: fromSetting,
      to,
      effectiveFrom: plan.pending?.at ?? null,
      liveCloses: plan.liveUpdate?.closes_at ?? null,
      next: plan.next?.key ?? null,
      inheriting: inheriting.length,
      returning: returning.size,
      rehomed,
    });
    return { ...plan, oldValue: row?.value ?? null, rehomed, changed: true, inheriting };
  });
  // After COMMIT: returning tenants' carrier rows moved (or went) — this pod must not serve the old ones.
  invalidateTenantCadenceCache();
  return result;
}

/**
 * A TENANT's own cadence switch (PATCH /api/tenant/cycle-cadence). Same rules as the platform switch
 * (`planCadenceSwitch`: next boundary, stretch, X→X cancels a pending switch), applied to that tenant
 * only, in ONE transaction:
 *
 *   tenant lock → platform row `FOR SHARE` → the tenant's override row `FOR UPDATE` → plan from what
 *   governs the tenant now (its own row, else the platform's) → write the override row + append a
 *   `tenant_cycle_cadence_changes` entry (the tenant's replayable history) → move the tenant's running
 *   row → sweep the tenant's stranded rows.
 *
 * `value` a cadence: PIN the tenant to it. NO-OP (`changed: false`, nothing written) when the tenant is
 * already pinned to exactly this value. A tenant with NO override that asks for the value it currently
 * inherits DOES get a row: from then on it is pinned and no longer follows platform switches.
 *
 * `value` null (0112): RETURN to the platform default. The switch to the platform's setting is planned
 * like any other (next boundary, never a partly-elapsed period). When it can take over at once the
 * override row is deleted; when it must wait for a boundary the row stays as a `follows_platform`
 * CARRIER of that pending switch (`tenantRowGoverns`), which a platform switch re-plans
 * (`switchCadence` step 5) and which stops governing at its boundary. NO-OP when nothing pins the
 * tenant (no row, or already returning).
 *
 * ⛔ Caller: run it as SYSTEM (`runAsSystem('tenant-parameterised', …)`) after `requireTenantAdmin` has
 * fixed `tenantId` from auth. NOT under the request's cp_app scope: `marketplace_cycles` has a
 * read-only RLS policy for cp_app (0110), so the running row's stretch would silently match nothing.
 * Every write below carries `tenantId` explicitly.
 * `lock_timeout` 55P03 → the route answers 409 `cycle_busy` (`isLockTimeout`).
 */
export async function switchTenantCadence(
  tenantId: string,
  value: Cadence | null,
  actor: string | null,
  opts: { at?: Date; database?: Db } = {},
): Promise<CadenceSwitchPlan & { oldValue: Cadence; inherited: boolean; rehomed: number; changed: boolean }> {
  const database = opts.database ?? defaultDb;
  const result = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${CADENCE_SWITCH_LOCK_TIMEOUT}'`));
    await lockTenantCycle(tx, tenantId);
    const platform = await readPlatformCadenceRow(tx, { lock: true });
    const row = await readTenantCadenceRow(tx, tenantId, { lock: 'update' });
    const at = opts.at ?? new Date();
    // What governs the tenant now: its row while that governs (a pinned row, or a return still
    // waiting for its boundary), else the platform policy.
    const own = tenantRowGoverns(row, at) ? row : null;
    const from = own ?? platform;
    const pinned = own !== null && !own.followsPlatform;
    const noop = value === null ? !pinned : pinned && own.setting === value;
    if (noop) {
      return { pending: from.pending, liveUpdate: null, next: null, oldValue: from.setting, inherited: !pinned, rehomed: 0, changed: false };
    }
    const to: Cadence = value ?? platform.setting;
    const live = await liveRowForSwitch(tx, tenantId, at);
    const plan = planCadenceSwitch(at, { setting: from.setting, pending: from.pending }, to, live);
    const followsPlatform = value === null;
    if (followsPlatform && !plan.pending) {
      // The platform's setting takes over at once: the tenant inherits from now on.
      await tx.delete(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, tenantId));
    } else {
      const values = {
        value: to,
        effective_from: plan.pending?.at ?? null,
        previous_value: plan.pending?.previous ?? null,
        follows_platform: followsPlatform,
        updated_by: actor,
        updated_at: at,
      };
      await tx
        .insert(tenantCycleCadence)
        .values({ tenant_id: tenantId, ...values })
        .onConflictDoUpdate({ target: tenantCycleCadence.tenant_id, set: values });
    }
    await tx.insert(tenantCycleCadenceChanges).values({
      tenant_id: tenantId,
      old_value: from.setting,
      new_value: to,
      effective_from: plan.pending?.at ?? null,
      actor_id: actor,
      created_at: at,
      follows_platform: followsPlatform,
    });
    const timeline = await readTenantTimeline(
      tx,
      tenantId,
      followsPlatform && !plan.pending ? null : { setting: to, pending: plan.pending, updatedAt: at, followsPlatform },
    );
    const rehomed = await applyCadenceSwitchToCycles(plan, tx, tenantId, { at, setting: to, timeline });
    log.info('cycle_cadence_switched', {
      component: 'cycle',
      scope: 'tenant',
      tenantId,
      from: from.setting,
      to,
      followsPlatform,
      effectiveFrom: plan.pending?.at ?? null,
      liveCloses: plan.liveUpdate?.closes_at ?? null,
      next: plan.next?.key ?? null,
      rehomed,
    });
    return { ...plan, oldValue: from.setting, inherited: !own, rehomed, changed: true };
  });
  // After COMMIT: this pod's hot-path snapshot must see the new value at once (others within ≤5s).
  invalidateTenantCadenceCache(tenantId);
  return result;
}

/**
 * The current period's cycle, READ-ONLY (for GET surfaces / the home countdown). Returns null when
 * the engine has not opened it yet or the cadence is off — a GET never opens a cycle (only the
 * scheduler tick and the manual route do). "Current" is the effective kind's period containing
 * `now` (host/cycle-cadence.ts): the running period's kind until it closes, then the setting.
 */
export async function readCurrentCycle(
  now: Date,
  tenantId: string | null,
  database: Db = defaultDb,
): Promise<MarketplaceCycle | null> {
  if (!tenantId) return null;
  const { setting, pending } = await readCadencePolicy(database, tenantId);
  const state = cadenceStateFrom(now, setting, await readLiveCycle(database, tenantId, now), pending);
  if (!state.current) return null;
  const [row] = await database
    .select()
    .from(marketplaceCycles)
    .where(
      and(
        eq(marketplaceCycles.tenant_id, tenantId),
        eq(marketplaceCycles.period_kind, state.current.kind),
        eq(marketplaceCycles.period_key, state.current.key),
      ),
    );
  return row ?? null;
}
