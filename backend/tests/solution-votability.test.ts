// tests/solution-votability.test.ts — A SOLUTION'S VOTE GATE IS ITS OWN COMPETING CYCLE'S.
//
// ⛔ THE DEFECT THIS FILE EXISTS FOR — nine consecutive winnerless weeks.
// `host/vote-service.ts` `loadTarget` used to `innerJoin(challenges)` and 409 `voting_closed` on
// `challenges.status = 'closed'`. That reads a fact about a DIFFERENT ROW IN A DIFFERENT WEEK, and
// in prod it deadlocked the marketplace:
//
//   • the only `week='2026-W33'` solution (`voting`, votes_count 0) was filed 2026-08-10 03:49Z
//   • its parent challenge CH-284 is a `week='2026-W23'` row
//   • at 11:53Z the same morning `healOrphanedChallenges` closed CH-284 — correctly, its own week
//     ended in June
//   • from then on every vote on the W33 entry 409'd, so `closeCycle`'s "a winner needs ≥1 vote"
//     guard could never be satisfied and W33 was guaranteed to be the 10th winnerless week.
//
// The rule is now `weekClosedSql` (host/cycle-eligibility.ts): a solution is votable iff the CYCLE
// IT COMPETES IN has not closed. The four gate cases below are the four branches of that predicate,
// each one written to be RED against the parent-challenge rule.
//
// House conventions: far-future `2099-W..` weeks so the windows are clean and cleanup is exact, a
// `MARK`-prefixed title for isolation, and explicit 30s hook timeouts (bun ignores bunfig's
// `[test] timeout` for hooks — see scripts/check-hook-timeouts.ts).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { castVote, retractVote } from '../src/host/vote-service';
import { closeCycle, openCycle } from '../src/host/cycle-service';
import {
  db,
  users,
  challenges,
  solutions,
  votes,
  weeklyWinners,
  marketplaceCycles,
  pipelineItems,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c4b0001';
const VOTER_ID = '00000000-0000-0000-0000-00000c4b0002';
const author: User = { id: UID, email: 'votability@test', name: 'Ava Author', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const voter: User = { id: VOTER_ID, email: 'votability2@test', name: 'Vic Voter', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const MARK = 'ZVOTABILITY';

// Every week this file touches, so cleanup can be exact.
//   OPEN_WEEK   — the prod shape: a live cycle, a long-dead parent challenge.
//   CLOSED_WEEK — the door that must stay shut, with a deliberately OPEN parent.
//   E2E_WEEK    — open cycle → one vote → close → winner.
//   LEGACY_WEEK — a PAST week with no cycle row anywhere (prod's W21/W23 shape).
//   FORCE_WEEK  — a week that is CLOSED and won, then force-closed again through a failure.
const OPEN_WEEK = '2097-W10';
const CLOSED_WEEK = '2097-W11';
const E2E_WEEK = '2097-W12';
const FORCE_WEEK = '2097-W13';
const LEGACY_WEEK = '2020-W10';
// ⛔ A CLOSED CYCLE THAT EXISTS FROM THE FIRST ASSERTION ONWARD, and it is not decoration.
// The first cut of `weekClosedSql` interpolated the week column WITHOUT a table qualifier, which
// drizzle emits bare in a single-table select field — so the correlated `mc.week = week` bound to
// the SUBQUERY's own column and the predicate collapsed to "is ANY week anywhere closed". On a
// database where nothing had closed yet that reads FALSE for every row, and T1 went green on a
// predicate that was answering a different question. Prod has nine closed weeks; the fixture must
// too, or "open" is indistinguishable from "broken".
const SENTINEL_CLOSED_WEEK = '2097-W09';
const ALL_WEEKS = [SENTINEL_CLOSED_WEEK, OPEN_WEEK, CLOSED_WEEK, E2E_WEEK, FORCE_WEEK, LEGACY_WEEK];

// ⛔ MAKE THE IN-TRANSACTION WINNER WRITE FAIL, so T6 can observe what a mid-close throw leaves
// behind. A `NOT VALID` CHECK is enforced on every new INSERT/UPDATE and skips the rows already
// there, so it is a one-statement stand-in for "the winner write blew up" with nothing to clean up
// but itself (same device as budget-service.test.ts's blocked alert inserts).
//
// Raw, and the week is INLINED rather than bound: Postgres takes no bind parameters in DDL, so
// `CHECK (week <> $1)` is a syntax error. FORCE_WEEK is a literal in this file, not input.
const BLOCK_WINNER = 'cp_test_block_force_winner';
const blockWinnerWrites = () =>
  db.execute(
    sql.raw(`ALTER TABLE weekly_winners ADD CONSTRAINT ${BLOCK_WINNER} CHECK (week <> '${FORCE_WEEK}') NOT VALID`),
  );
const unblockWinnerWrites = () =>
  db.execute(sql.raw(`ALTER TABLE weekly_winners DROP CONSTRAINT IF EXISTS ${BLOCK_WINNER}`));

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerSolutionRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  // FIRST, defensively: a CHECK left behind by a failed T6 would break every later weekly_winners
  // write in this database, not just this file.
  await unblockWinnerWrites();
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))
  ).map((r) => r.id);
  const solIds = chIds.length
    ? (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map((r) => r.id)
    : [];
  if (solIds.length) {
    await db.delete(pipelineItems).where(inArray(pipelineItems.solution_id, solIds));
    await db.delete(weeklyWinners).where(inArray(weeklyWinners.solution_id, solIds));
    await db.delete(votes).where(inArray(votes.target_id, solIds));
    await db.delete(solutions).where(inArray(solutions.id, solIds));
  }
  if (chIds.length) await db.delete(challenges).where(inArray(challenges.id, chIds));
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, ALL_WEEKS));
  await db.delete(users).where(eq(users.id, UID));
  await db.delete(users).where(eq(users.id, VOTER_ID));
}

/** A parent challenge, with a status and a week chosen INDEPENDENTLY of its solutions' — which is
 *  the whole point of every case below. */
async function mkChallenge(label: string, status: 'voting' | 'solution_phase' | 'closed', week: string): Promise<string> {
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} ${label}`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status, week })
    .returning();
  return c!.id;
}

/** A solution filed into `week`, authored by UID so VOTER can vote on it (self-vote is forbidden). */
async function mkSolution(challengeId: string, label: string, week: string, votesCount = 0): Promise<string> {
  const [s] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({
        challenge_id: challengeId,
        title: `${MARK} ${label}`,
        author_id: UID,
        tenant_id: DEMO_TENANT_ID,
        status: 'voting',
        week,
        votes_count: votesCount,
        blocks_used: [],
      })
      .returning(),
  );
  return s!.id;
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see the long note in
// license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: author.email, name: author.name, avatar_initials: 'AA' }).onConflictDoNothing();
  await db.insert(users).values({ id: VOTER_ID, email: voter.email, name: voter.name, avatar_initials: 'VV' }).onConflictDoNothing();
  // See SENTINEL_CLOSED_WEEK: every case below runs against a database that already has a closed
  // cycle in it, exactly as prod does.
  await openCycle(SENTINEL_CLOSED_WEEK, DEMO_TENANT_ID);
  await closeCycle(SENTINEL_CLOSED_WEEK, DEMO_TENANT_ID);
  asUser(voter);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(voter));

// ── T1: the prod shape ───────────────────────────────────────────────────────────────────────

test('T1 · a LIVE week’s 0-vote entry is votable even though its parent challenge closed months ago', async () => {
  // This is byte-for-byte prod's 2026-W33: an open cycle, an entry filed into it, and a parent
  // challenge from an older week that `healOrphanedChallenges` has already (correctly) closed.
  // Under the parent-challenge rule this throws `voting_closed` and the week cannot be won.
  await openCycle(OPEN_WEEK, DEMO_TENANT_ID);
  // Sanity: a closed cycle DOES exist in this database (see SENTINEL_CLOSED_WEEK). A predicate that
  // answers "is anything closed" rather than "is THIS week closed" reds here instead of passing.
  const [sentinel] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, SENTINEL_CLOSED_WEEK));
  expect(sentinel!.phase).toBe('closed');

  const ch = await mkChallenge('t1 dead parent', 'closed', '2098-W01');
  const sol = await mkSolution(ch, 't1 live entry', OPEN_WEEK);

  const r = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol));
  expect(r).toMatchObject({ voted: true, count: 1 });

  // …and it is a real vote row, not just a bumped counter.
  const rows = await db.select().from(votes).where(eq(votes.target_id, sol));
  expect(rows).toHaveLength(1);
}, 30_000);

// ── T2: the door stays shut ──────────────────────────────────────────────────────────────────

test('T2 · a CLOSED week rejects cast AND retract, even with an OPEN parent challenge', async () => {
  // The mirror image of T1, and the reason this change is not "drop the gate". The parent is left
  // at `voting` on purpose: under the old rule that open parent made the vote SUCCEED on a week
  // that had already been closed and won.
  await openCycle(CLOSED_WEEK, DEMO_TENANT_ID);
  await closeCycle(CLOSED_WEEK, DEMO_TENANT_ID);
  const ch = await mkChallenge('t2 open parent', 'voting', CLOSED_WEEK);
  const sol = await mkSolution(ch, 't2 dead entry', CLOSED_WEEK);

  // `details.type` carries the target kind as a named field for the localization catalog. Asserted
  // once here; tests/votes.test.ts holds the discriminating pair (challenge vs solution) that
  // proves it tracks the target rather than being a constant.
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
    code: 'voting_closed',
    details: { type: 'solution' },
  });
  await expect(withTenantDb(DEMO_TENANT_ID, () => retractVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
    code: 'voting_closed',
    details: { type: 'solution' },
  });
  // Nothing was recorded and the counter did not move.
  expect(await db.select().from(votes).where(eq(votes.target_id, sol))).toHaveLength(0);
  const [row] = await db.select({ n: solutions.votes_count }).from(solutions).where(eq(solutions.id, sol));
  expect(row!.n).toBe(0);
}, 30_000);

// ── T3: "no cycle row" is NOT "open" ─────────────────────────────────────────────────────────

test('T3 · a PAST week with NO cycle row anywhere rejects, however open its parent is', async () => {
  // ⛔ THE HALF OF THE PREDICATE THAT IS EASIEST TO DROP. Nothing in this engine ever creates a
  // cycle row for a past week, so prod's W21 and W23 carry rows with no `marketplace_cycles` entry
  // at all. A rows-only rule (`phase <> 'closed'`) would declare the entire back catalogue OPEN and
  // re-arm voting on every legacy solution in the product.
  const [existing] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, LEGACY_WEEK));
  expect(existing, 'this test is meaningless if a cycle row exists for the legacy week').toBeUndefined();

  const ch = await mkChallenge('t3 open parent', 'voting', LEGACY_WEEK);
  const sol = await mkSolution(ch, 't3 legacy entry', LEGACY_WEEK);
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
    code: 'voting_closed',
  });
}, 30_000);

// ── T4: the legacy empty week ────────────────────────────────────────────────────────────────

test("T4 · a solution with week='' rejects — the pre-0047 default is a dead week, not a live one", async () => {
  // `solutions.week` is `text NOT NULL DEFAULT ''`. Such a row was never filed into any cycle and
  // can never be judged by one, so it must not accept votes. It sorts below every real week and has
  // no cycle row, which is exactly the second half of the predicate.
  const ch = await mkChallenge('t4 open parent', 'voting', OPEN_WEEK);
  const sol = await mkSolution(ch, 't4 weekless entry', '');
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
    code: 'voting_closed',
  });
}, 30_000);

// ── T5: end to end — the thing that has not happened in nine weeks ───────────────────────────

test('T5 · open cycle + closed parent + 0-vote entry → one vote → the close CROWNS it', async () => {
  // The whole defect, end to end. Every step of this was reachable before EXCEPT the vote, and the
  // vote is what `closeCycle`'s `top.votes === 0` guard needs.
  await openCycle(E2E_WEEK, DEMO_TENANT_ID);
  const ch = await mkChallenge('t5 dead parent', 'closed', '2098-W02');
  const sol = await mkSolution(ch, 't5 sole entry', E2E_WEEK);

  const voted = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol));
  expect(voted).toMatchObject({ voted: true, count: 1 });

  const res = await closeCycle(E2E_WEEK, DEMO_TENANT_ID);
  expect(res.closed).toBe(true);
  expect(res.winners.map((w) => w.solutionId)).toEqual([sol]);

  // The durable artifact…
  const winnerRows = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, E2E_WEEK));
  expect(winnerRows).toHaveLength(1);
  expect(winnerRows[0]!.solution_id).toBe(sol);
  expect(winnerRows[0]!.stats).toEqual({ solutionsSubmitted: 1, totalVotesCast: 1 });

  // …the solution's own status…
  const [after] = await db.select({ status: solutions.status }).from(solutions).where(eq(solutions.id, sol));
  expect(after!.status).toBe('shipping');

  // …and EXACTLY ONE production pipeline card.
  const cards = await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, sol));
  expect(cards).toHaveLength(1);
  expect(cards[0]!.stage).toBe('review');

  // And the door is shut behind it: the week's cycle is now closed, so the same solution 409s.
  await expect(withTenantDb(DEMO_TENANT_ID, () => retractVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
    code: 'voting_closed',
  });
}, 30_000);

// ── T6: a force-close that THROWS must not re-open the week ──────────────────────────────────

test('T6 · a force-close that throws mid-transaction leaves the week CLOSED — it does not re-open voting', async () => {
  // ⛔ THE TEST FOR `closeCycle`'s ATOMIC RE-ARM (cycle-service.ts, top of the transaction), which
  // nothing else in either suite touches: move those four lines back OUT of the transaction, where
  // they lived before this change, and the whole backend suite still passes.
  //
  // `force` re-arms an already-closed week (`phase='solution_phase', closed_at=null`) so the close
  // can run again with fresh vote counts. OUTSIDE the transaction that re-closes it, that re-arm is
  // its own committed statement — so any throw further down (a winner write, the challenge sweep, a
  // dropped connection) rolls back the RE-CLOSE and leaves the re-arm standing:
  //
  //                        after a force-close that throws          then a vote
  //   re-arm INSIDE  (now) closed / closed_at set                   refused `voting_closed`
  //   re-arm OUTSIDE (was) solution_phase / closed_at NULL          ACCEPTED  ← the week re-opened
  //
  // Under the OLD parent-challenge rule that was nearly harmless: the week's challenges were
  // already closed and votability was read off them, so a re-armed cycle row changed nothing anyone
  // could act on. `weekClosedSql` reads `marketplace_cycles.phase` directly, so it is now the
  // cardinal sin this whole change exists to prevent — a historical week accepting votes.
  await openCycle(FORCE_WEEK, DEMO_TENANT_ID);
  const ch = await mkChallenge('t6 parent', 'voting', FORCE_WEEK);
  const sol = await mkSolution(ch, 't6 winner', FORCE_WEEK);
  // A real winner: the force re-close must reach the weekly_winners write, which is where the
  // failure is injected. (`top.votes === 0` would `continue` past it.)
  await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol));
  const first = await closeCycle(FORCE_WEEK, DEMO_TENANT_ID);
  expect(first.winners.map((w) => w.solutionId)).toEqual([sol]);
  const [beforeRow] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, FORCE_WEEK));
  expect(beforeRow!.phase).toBe('closed');
  const closedAtBefore = beforeRow!.closed_at;
  expect(closedAtBefore).not.toBeNull();

  try {
    await blockWinnerWrites();
    // The re-close now dies on the weekly_winners upsert, INSIDE the transaction, after the re-arm.
    await expect(closeCycle(FORCE_WEEK, DEMO_TENANT_ID, db, { force: true })).rejects.toThrow();

    // ⛔ THE ASSERTION. The week is exactly as it was: still closed, still carrying the ORIGINAL
    // close timestamp. Either the week ends this call or nothing about it moved.
    const [after] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, FORCE_WEEK));
    expect(after!.phase).toBe('closed');
    expect(after!.closed_at).not.toBeNull();
    expect(after!.closed_at?.getTime()).toBe(closedAtBefore!.getTime());

    // …and the consequence that actually matters, through the real vote path rather than by
    // re-reading the row: the dead week still refuses votes. With the re-arm outside the
    // transaction this call SUCCEEDS — a week that was closed and won is taking votes again.
    await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', sol))).rejects.toMatchObject({
      code: 'voting_closed',
    });

    // The winner artifact the first close wrote is intact too — the failed transaction took
    // nothing with it.
    const winnerRows = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, FORCE_WEEK));
    expect(winnerRows).toHaveLength(1);
    expect(winnerRows[0]!.solution_id).toBe(sol);
  } finally {
    // In a `finally`, not at the end: a failed assertion above must not leave a CHECK constraint
    // behind that reds every later weekly_winners write in this shared database.
    await unblockWinnerWrites();
  }

  // And once the injected failure is gone, `force` still does its job — proof that the assertions
  // above pinned the FAILURE path and not a permanently broken close.
  const again = await closeCycle(FORCE_WEEK, DEMO_TENANT_ID, db, { force: true });
  expect(again.closed).toBe(true);
  expect(again.winners.map((w) => w.solutionId)).toEqual([sol]);
}, 30_000);

// ── T8: the DTOs say what the gate decides ───────────────────────────────────────────────────

test('T8 · BOTH solution DTOs carry cycleClosed, and it equals what the vote gate decides', async () => {
  // ⛔ A SERVER-ONLY FIX IS INVISIBLE. If the board cannot read the gate it renders an inert pill on
  // a votable row (or a live pill on a dead one) and the marketplace closes winnerless anyway. Both
  // directions are asserted against the SERVER'S OWN ANSWER on the same rows, not against a
  // constant — that is what makes this a contract rather than a snapshot.
  // Self-sufficient rather than leaning on T1/T2 having run — both calls are idempotent.
  await openCycle(OPEN_WEEK, DEMO_TENANT_ID);
  await openCycle(CLOSED_WEEK, DEMO_TENANT_ID);
  await closeCycle(CLOSED_WEEK, DEMO_TENANT_ID);
  const liveCh = await mkChallenge('t8 dead parent', 'closed', '2098-W03');
  const liveSol = await mkSolution(liveCh, 't8 votable', OPEN_WEEK);
  const deadCh = await mkChallenge('t8 open parent', 'voting', CLOSED_WEEK);
  const deadSol = await mkSolution(deadCh, 't8 unvotable', CLOSED_WEEK);

  // The gate itself, from the service the routes actually call.
  const gate = async (id: string): Promise<boolean> => {
    try {
      await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', id));
      await withTenantDb(DEMO_TENANT_ID, () => retractVote(VOTER_ID, 'solution', id));
      return false; // the vote landed → the cycle is open
    } catch (e) {
      expect((e as { code?: string }).code).toBe('voting_closed');
      return true;
    }
  };

  // ---- detail DTO
  const liveDetail = await call('GET', `/api/solutions/${liveSol}`);
  const deadDetail = await call('GET', `/api/solutions/${deadSol}`);
  expect(liveDetail.status).toBe(200);
  expect(deadDetail.status).toBe(200);
  expect(liveDetail.json.cycleClosed).toBe(false);
  expect(deadDetail.json.cycleClosed).toBe(true);
  // …and the parent's status is the OPPOSITE of the answer in both rows, which is the whole point:
  // a board wired to `challenge.status` gets both of these backwards.
  expect(liveDetail.json.challenge.status).toBe('closed');
  expect(deadDetail.json.challenge.status).toBe('voting');

  // ---- list DTO
  const liveList = await call('GET', `/api/solutions?challenge_id=${liveCh}`);
  const deadList = await call('GET', `/api/solutions?challenge_id=${deadCh}`);
  const liveRow = liveList.json.items.find((i: { id: string }) => i.id === liveSol);
  const deadRow = deadList.json.items.find((i: { id: string }) => i.id === deadSol);
  expect(liveRow, 'the live solution is missing from its own board').toBeDefined();
  expect(deadRow, 'the dead solution is missing from its own board').toBeDefined();
  expect(liveRow.cycleClosed).toBe(false);
  expect(deadRow.cycleClosed).toBe(true);
  expect(liveRow.challengeStatus).toBe('closed');
  expect(deadRow.challengeStatus).toBe('voting');

  // ---- both DTOs agree with the SERVER, in both directions
  expect(await gate(liveSol)).toBe(false);
  expect(await gate(deadSol)).toBe(true);
  expect(liveDetail.json.cycleClosed).toBe(await gate(liveSol));
  expect(deadDetail.json.cycleClosed).toBe(await gate(deadSol));
  expect(liveRow.cycleClosed).toBe(liveDetail.json.cycleClosed);
  expect(deadRow.cycleClosed).toBe(deadDetail.json.cycleClosed);
}, 30_000);
