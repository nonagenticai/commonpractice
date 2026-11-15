// tests/cycle-eligibility.test.ts — the shared "who is competing this week, and in what
// order" predicate (host/cycle-eligibility.ts).
//
// ⛔ WHY THIS FILE EXISTS. `closeCycle` and `/api/winner` answer the SAME question about the
// SAME rows: which solutions were in this week's race. They answered it with two different
// queries, and the read side had none of the write side's predicates — so the page announced
// a 0-vote 2026-W32 winner above three 2026-W23 rows at 316/271/234 votes, presented as its
// runners-up. The behaviour of each call site is covered where it lives (cycle.test.ts,
// marketplace-summary.test.ts); what THIS file guards is that they cannot drift apart again.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CYCLE_ELIGIBLE_STATUSES,
  challengeClosedOver,
  challengeClosedSql,
  eligibleForPeriod,
  WINNER_ORDER,
  periodClosedSql,
  periodSolutionStats,
  SOLUTION_PERIOD,
} from '../src/host/cycle-eligibility';
import { closeCycle, openCycle } from '../src/host/cycle-service';
import type { PeriodGate } from '../src/host/cycle-cadence';
import { periodFromKey } from '../src/host/period';
import { ensureTenants } from './helpers/cycle-period';

/** The gate as the vote path builds it, pinned to a period key for a deterministic test. */
const gateAt = (key: string): PeriodGate => {
  const p = periodFromKey(key);
  return { mode: 'on', kind: p.kind, start: p.start };
};
import { db, users, challenges, solutions, weeklyWinners, marketplaceCycles, pipelineItems } from '../src/db/client';

const UID = '00000000-0000-0000-0000-0000000ce001';
const TENANT_A = '00000000-0000-0000-0000-0000000cea01';
const TENANT_B = '00000000-0000-0000-0000-0000000ceb02';
const MARK = 'ZCELIGTEST';
const WEEK = '2098-W41';

const src = (rel: string) => readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');
/** The module specifiers a file imports — asserted on instead of the whole file, so a failure
 *  prints a short list rather than dumping 400 lines of source into the runner. */
const importsOf = (rel: string) => [...src(rel).matchAll(/from '([^']+)'/g)].map((mm) => mm[1]!);

async function cleanup() {
  await db.delete(pipelineItems).where(like(pipelineItems.title, `${MARK}%`));
  await db.delete(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  const chIds = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (chIds.length) {
    await db.delete(solutions).where(inArray(solutions.challenge_id, chIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db.delete(marketplaceCycles).where(eq(marketplaceCycles.week, WEEK));
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see the long note in
// license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: 'celig@test', name: 'Cee Elig' }).onConflictDoNothing();
}, 30_000);
afterAll(cleanup, 30_000);

// ── the predicate itself ─────────────────────────────────────────────────────────────────────

test('the competing statuses are exactly voting + shipping', () => {
  // `draft` has not entered the vote and `archived` has left it; neither can be crowned, so
  // neither may be shown as a runner-up.
  expect([...CYCLE_ELIGIBLE_STATUSES]).toEqual(['voting', 'shipping']);
});

test('eligibleForPeriod REFUSES an empty period key instead of matching every legacy row', () => {
  // `solutions.week` is `text NOT NULL DEFAULT ''`. `eq(week,'')` is not an empty result set —
  // it is every pre-0047 row in the table. There is no safe predicate for a falsy week, so the
  // helper throws and the caller must short-circuit. A silent `undefined` here would be worse
  // still: in drizzle that means "no WHERE clause at all".
  expect(() => eligibleForPeriod('', null)).toThrow(/empty period key/);
  expect(() => eligibleForPeriod('', TENANT_A)).toThrow(/empty period key/);
  expect(() => eligibleForPeriod(WEEK, null)).not.toThrow();
});

test('WINNER_ORDER is the full three-level tie-break, in order', () => {
  // Not a style assertion: with votes alone, a tie is resolved by whatever order Postgres
  // happens to return, so a replayed close (or a re-rendered page) can crown a different row.
  // Asserted through the COMPILED SQL rather than the drizzle objects — that is the thing
  // Postgres actually executes, and the objects are cyclic.
  expect(WINNER_ORDER).toHaveLength(3);
  const compiled = db.select({ id: solutions.id }).from(solutions).orderBy(...WINNER_ORDER).toSQL().sql;
  expect(compiled).toContain(
    'order by "solutions"."votes_count" desc, "solutions"."created_at" asc, "solutions"."id" asc',
  );
});

// ── the drift guard: ONE definition, both call sites ─────────────────────────────────────────
//
// This is a SOURCE assertion on purpose, and it is the instrument the whole extraction exists
// for. A behavioural test can only observe an ordering that a divergent call site might still
// satisfy by accident (Postgres's sort for equal keys is unspecified, not adversarial), so it
// cannot deterministically red on "one call site re-spells the order". Re-spelling it is
// exactly what re-introduces the bug, so that is what is asserted.
const CALL_SITES = ['src/host/cycle-service.ts', 'src/routes/marketplace-summary.ts'];

test('both call sites select the candidate set through the SHARED eligibleForPeriod', () => {
  for (const f of CALL_SITES) {
    const text = src(f);
    expect(
      importsOf(f).some((s) => s.endsWith('cycle-eligibility')),
      `${f} must import the shared predicate`,
    ).toBe(true);
    expect(/eligibleForPeriod\(/.test(text), `${f} must use eligibleForPeriod`).toBe(true);
    // No locally re-spelled candidate set. `inArray(solutions.status, ['voting'…])` in either
    // file is the bug coming back: the two sets then only agree until someone edits one.
    expect(
      /inArray\(\s*solutions\.status/.test(text),
      `${f} re-spells the eligible-status set locally`,
    ).toBe(false);
  }
});

test('both call sites rank through the SHARED WINNER_ORDER — no locally spelled ordering', () => {
  // THE REVERT THIS CATCHES: "change WINNER_ORDER at ONE call site only", i.e. inline a
  // divergent ordering there while the other keeps the shared constant. Counting the uses is
  // what makes it precise — a re-spelled call site takes the count to zero for that file,
  // whichever ordering it was re-spelled as. (A blanket "no desc(votes_count) anywhere" ban is
  // wrong: the shipping-solution fallback in marketplace-summary legitimately ranks by votes
  // alone, and that query is not the winner ranking.)
  for (const f of CALL_SITES) {
    const text = src(f);
    const shared = [...text.matchAll(/\.orderBy\(\.\.\.WINNER_ORDER\)/g)].length;
    expect(shared, `${f} must rank through the shared WINNER_ORDER exactly once`).toBe(1);
    // …and no multi-key ordering spelled by hand: a comma after `desc(solutions.votes_count)`
    // is a tie-break, and the only correct tie-break lives in the constant.
    expect(
      /desc\(solutions\.votes_count\)\s*,/.test(text),
      `${f} spells a multi-key winner ordering of its own`,
    ).toBe(false);
  }
});

test('both call sites take their period aggregate from the SHARED periodSolutionStats', () => {
  for (const f of CALL_SITES) {
    expect(/periodSolutionStats\(/.test(src(f)), `${f} must use periodSolutionStats`).toBe(true);
  }
});

// ── the vote gate: ONE definition, the write path AND the read path ──────────────────────────
//
// ⛔ WHAT THIS CATCHES, AND WHY IT IS A SOURCE ASSERTION. `vote-service.loadTarget` used to
// `innerJoin(challenges)` and 409 on the PARENT's status — a fact about a different row in a
// different week. Prod's live 2026-W33 entry was filed at 03:49Z against a 2026-W23 challenge and
// was struck unvotable at 11:53Z the same morning when `healOrphanedChallenges` closed that parent;
// `closeCycle` then could not satisfy its "a winner needs ≥1 vote" guard, which is how nine
// consecutive cycles closed with `winner_solution_id` NULL. Re-adding that join is the bug coming
// back, and no behavioural test can red on it reliably: the two rules AGREE whenever a solution's
// week and its parent's week happen to match, which is the common case in a fixture. So the join's
// ABSENCE is what is asserted, alongside the shared predicate being used on both sides of the wire.
test('the vote gate is the SHARED periodClosedSql, on the write path and the read path alike', () => {
  const voteService = 'src/host/vote-service.ts';
  const listRoute = 'src/routes/solutions.ts';

  expect(
    importsOf(voteService).some((s) => s.endsWith('cycle-eligibility')),
    `${voteService} must import the shared vote gate`,
  ).toBe(true);
  for (const f of [voteService, listRoute]) {
    expect(/periodClosedSql\(/.test(src(f)), `${f} must gate through the shared periodClosedSql`).toBe(true);
    // ⛔ and never by comparing period KEY text — '2026-W41' vs '2026-10' do not order by time.
    expect(/weekString\(/.test(src(f)), `${f} derives the gate from an ISO week string again`).toBe(false);
  }
  // ⛔ THE REVERT THIS EXISTS FOR. Any join from solutions to challenges in the vote path is the
  // parent-challenge rule returning, whatever it is spelled as.
  expect(
    /innerJoin\(challenges/.test(src(voteService)),
    `${voteService} joins the parent challenge again — a solution's votability is its own cycle's`,
  ).toBe(false);
});

test('periodClosedSql emits FULLY QUALIFIED period references in every clause and arity', () => {
  // ⛔⛔ THE BUG THIS PINS WAS IN THE FIX ITSELF, and it is invisible in the source. Interpolating
  // the drizzle column directly is SILENTLY WRONG in a SELECT-FIELD position: drizzle drops the
  // table qualifier when the query has a single table, and the bare column inside the correlated
  // subquery is then captured by `marketplace_cycles`' OWN column of the same name — the gate
  // degrades to "is ANY period anywhere closed". Both arities are the two real call sites.
  const single = db
    .select({ id: solutions.id, c: periodClosedSql(SOLUTION_PERIOD, gateAt('2099-W01')) })
    .from(solutions)
    .toSQL().sql;
  expect(single).toContain('mc.period_kind = "solutions"."period_kind"');
  expect(single).toContain('mc.period_start = "solutions"."period_start"');
  expect(single).toContain('mc_any.period_start = "solutions"."period_start"');
  expect(single).toContain('mc.tenant_id = "solutions"."tenant_id"');
  expect(single, 'a period reference lost its table qualifier — the subquery captures it').not.toMatch(
    /mc(_any)?\.period_(kind|start) = "period_(kind|start)"/,
  );

  // The list route's shape: the columns come off a SUBQUERY alias, not a table.
  const sub = db
    .select({ id: solutions.id, period_kind: solutions.period_kind, period_start: solutions.period_start, tenant_id: solutions.tenant_id })
    .from(solutions)
    .as('ranked');
  const multi = db
    .select({ id: sub.id, c: periodClosedSql({ kind: sub.period_kind, start: sub.period_start, tenant: sub.tenant_id }, gateAt('2099-W01')) })
    .from(sub)
    .toSQL().sql;
  expect(multi).toContain('mc.period_start = "ranked"."period_start"');
  // 0110: every cycle-row reference is correlated on the ROW's tenant, qualified like the period.
  expect(multi).toContain('mc.tenant_id = "ranked"."tenant_id"');
  expect(multi).toContain('mc_any.tenant_id = "ranked"."tenant_id"');
  expect(multi).toContain('mc_fl.tenant_id = "ranked"."tenant_id"');
  expect(multi).toContain('mc_any.period_kind = "ranked"."period_kind"');
});

test('periodClosedSql REFUSES a missing current period start instead of opening the back catalogue', () => {
  expect(() => periodClosedSql(SOLUTION_PERIOD, { mode: 'on', kind: 'week', start: new Date(NaN) })).toThrow(
    /current period start/,
  );
  expect(() => periodClosedSql(SOLUTION_PERIOD, gateAt('2099-W01'))).not.toThrow();
});

test('OFF mode: periodClosedSql keeps ONLY the closed-row arm — nothing goes stale, a crowned period stays closed', () => {
  const compiled = db
    .select({ c: periodClosedSql(SOLUTION_PERIOD, { mode: 'off' }) })
    .from(solutions)
    .toSQL().sql;
  expect(compiled).toContain("phase = 'closed'");
  // The stale arm (no row, before the current period) needs a current period; off has none.
  expect(compiled).not.toContain('mc_any');
  expect(compiled).not.toContain('timestamptz');
  expect(compiled).toContain('"solutions"."period_start"');
});


// ── the challenge rule moved to `status` alone; the solution rule did NOT ───────────────────
//
// ⛔ WHY THIS CONTRAST IS THE WHOLE POINT. `challengeClosedSql` used to be
// `status = 'closed' OR weekClosedSql(challenge.week, currentWeek)` — a challenge went closed
// merely because its ISO week had passed, which swept all 17 production challenges to `closed`
// and emptied the board's default `?open=true` view. The week arm was removed: a challenge's
// liveness is now `status` and NOTHING ELSE. `weekClosedSql` itself is UNCHANGED and still governs
// SOLUTION voting and the winner path — a solution's votability stays a property of its own week,
// because "this week's winner" is genuinely a weekly question. Compiling both against a real query
// and asserting on the presence/absence of `marketplace_cycles` is what would catch either half of
// that split being undone: re-adding the week arm to the challenge predicate, OR (just as wrong)
// collapsing `weekClosedSql` down to `status` and silently opening every past week's votes.
test('challengeClosedSql compiles to the status column alone — no marketplace_cycles reference', () => {
  // ⚠️ ASSERTS THE COLUMN, NOT A QUALIFIED SPELLING — and that is deliberate, measured, not assumed.
  // In SELECT-FIELD position drizzle emits a BARE `"status" = $1`; in WHERE position it emits the
  // qualified `"challenges"."status"` / `"ranked"."status"`. All four shapes were compiled and read
  // off:
  //   select field, base table : select "status" = $1 from "challenges"
  //   where clause, base table : ... where not "challenges"."status" = $1
  //   select field, subquery   : select "id", "status" = $1 from (...) "ranked"
  //   where clause, subquery   : ... where not "ranked"."status" = $1
  // The bare form only ever appears where there is exactly ONE source in the FROM, so it cannot be
  // ambiguous. This predicate therefore does NOT need the hand-qualification `weekClosedSql` does:
  // that one is hand-qualified precisely because it sat NESTED inside `or(...)`, one level below the
  // select field's own chunks, where drizzle's rewrite is shallow and does not recurse. Removing the
  // week arm removed that nesting. Pinning the qualified spelling here would fail against correct
  // code — it did, which is how these four lines came to be measured.
  const asField = db.select({ c: challengeClosedSql() }).from(challenges).toSQL().sql;
  expect(asField).toContain('"status" = ');
  expect(asField, 'the week arm is back — challengeClosedSql must not reference marketplace_cycles').not.toContain(
    'marketplace_cycles',
  );
  // The WHERE position is where a bare column WOULD be ambiguous, so pin the qualification there.
  const asWhere = db
    .select({ id: challenges.id })
    .from(challenges)
    .where(challengeClosedOver(challenges.status))
    .toSQL().sql;
  expect(asWhere).toContain('"challenges"."status"');
  expect(asWhere).not.toContain('marketplace_cycles');
});

test('periodClosedSql still gates SOLUTION voting through marketplace_cycles', () => {
  const compiled = db.select({ c: periodClosedSql(SOLUTION_PERIOD, gateAt(WEEK)) }).from(solutions).toSQL().sql;
  expect(
    compiled,
    'periodClosedSql must still consult marketplace_cycles — only the CHALLENGE rule moved to status alone',
  ).toContain('marketplace_cycles');
});

test('cycle-eligibility imports ONLY drizzle-orm + db — a reader must not drag the closer in', () => {
  // A read surface (/api/winner) asking "who is eligible" must not pull `enqueueWinner`,
  // `recordAudit` and `config` into its module graph to find out. If this ever fails, the
  // dependency has been pointed the wrong way round.
  // `./period` is pure and dependency-free; `./cycle-cadence` is a TYPE-ONLY import (PeriodGate) and
  // is asserted as such below, because a value import would drag `config` in.
  expect(importsOf('src/host/cycle-eligibility.ts').sort()).toEqual([
    '../db/client',
    '../db/schema',
    './cycle-cadence',
    './period',
    'drizzle-orm',
  ]);
  expect(src('src/host/cycle-eligibility.ts')).toContain("import type { PeriodGate } from './cycle-cadence';");
  expect(importsOf('src/host/period.ts')).toEqual(['./iso-week']);
});

// ── the aggregate the close stamps IS the aggregate the page recomputes ──────────────────────

test('periodSolutionStats is tenant-scoped and status-blind, and equals what closeCycle stamps', async () => {
  await ensureTenants([TENANT_A, TENANT_B]);
  await openCycle(WEEK, TENANT_A);
  await openCycle(WEEK, TENANT_B);
  const [chA] = await db.insert(challenges).values({ title: `${MARK} host A`, work_area: 'Claims', submitter_id: UID, tenant_id: TENANT_A, week: WEEK }).returning();
  const [chB] = await db.insert(challenges).values({ title: `${MARK} host B`, work_area: 'Claims', submitter_id: UID, tenant_id: TENANT_B, week: WEEK }).returning();
  await db.insert(solutions).values([
    { challenge_id: chA!.id, title: `${MARK} A win`, author_id: UID, status: 'voting', votes_count: 11, blocks_used: [], tenant_id: TENANT_A, week: WEEK },
    { challenge_id: chA!.id, title: `${MARK} A two`, author_id: UID, status: 'voting', votes_count: 4, blocks_used: [], tenant_id: TENANT_A, week: WEEK },
    // Counted as SUBMITTED even though it cannot win — that is what the close counts.
    { challenge_id: chA!.id, title: `${MARK} A draft`, author_id: UID, status: 'draft', votes_count: 2, blocks_used: [], tenant_id: TENANT_A, week: WEEK },
    // Another week entirely: must not leak into A's figures.
    { challenge_id: chA!.id, title: `${MARK} A other week`, author_id: UID, status: 'voting', votes_count: 900, blocks_used: [], tenant_id: TENANT_A, week: '2098-W40' },
    { challenge_id: chB!.id, title: `${MARK} B win`, author_id: UID, status: 'voting', votes_count: 500, blocks_used: [], tenant_id: TENANT_B, week: WEEK },
  ]);

  const a = await periodSolutionStats(WEEK, TENANT_A);
  expect(a).toEqual({ solutionsSubmitted: 3, totalVotesCast: 17 });
  const b = await periodSolutionStats(WEEK, TENANT_B);
  expect(b).toEqual({ solutionsSubmitted: 1, totalVotesCast: 500 });
  // Unscoped spans both tenants — which is exactly why the scoped form is the one the close
  // stamps onto a tenant-readable row.
  expect(await periodSolutionStats(WEEK, null)).toEqual({ solutionsSubmitted: 4, totalVotesCast: 517 });
  // A falsy week answers "nothing" rather than aggregating every legacy row.
  expect(await periodSolutionStats('', TENANT_A)).toEqual({ solutionsSubmitted: 0, totalVotesCast: 0 });

  // …and this is byte-for-byte what the close writes into weekly_winners.stats, because it is
  // literally the same function. That equality is the whole point: the page's "week in numbers"
  // can no longer be a second, subtly different aggregate.
  const res = await closeCycle(WEEK, TENANT_A);
  expect(res.closed).toBe(true);
  expect((await closeCycle(WEEK, TENANT_B)).closed).toBe(true);
  const rows = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  const byTenant = new Map(rows.map((r) => [r.tenant_id, r.stats]));
  expect(byTenant.get(TENANT_A)).toEqual(a);
  expect(byTenant.get(TENANT_B)).toEqual(b);
  // The winner is A's 11-vote row, not its 900-vote row from another week.
  const winnerA = rows.find((r) => r.tenant_id === TENANT_A)!;
  const [wsol] = await db.select({ title: solutions.title }).from(solutions).where(eq(solutions.id, winnerA.solution_id));
  expect(wsol!.title).toBe(`${MARK} A win`);
}, 30_000);
