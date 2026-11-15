// tests/challenge-submission-gate.test.ts — A CHALLENGE'S LIVENESS IS ITS `status` COLUMN, AND
// NOTHING ELSE. THE CALENDAR DOES NOT CLOSE IT.
//
// ⛔ THIS FILE USED TO PIN THE OPPOSITE RULE. `challengeClosedSql` was `status = 'closed' OR
// weekClosedSql(challenges.week, currentWeek)` — a challenge went dead the moment its ISO week
// passed, on the theory that CH-284 (below) proved the calendar arm was load-bearing. It wasn't:
// dropping it is the fix, not a regression.
//
//   • 2026-08-10T03:49Z prod ACCEPTED a solution against CH-284, a `week='2026-W23'` challenge,
//     because its `status` column still read `voting`
//   • 11:53Z the same morning `healOrphanedChallenges` closed CH-284 — because the WEEK ARM told
//     it a challenge with a stale week is dead, which is the premise this file now rejects
//   • the submission had already been stamped with the CURRENT week and was the live 2026-W33
//     board's only entry: a solution competing this week against a challenge closed out from
//     under it for no reason but its age
//   • every one of the 17 challenges in prod had been swept `closed` this way; the board rendered
//     EMPTY under its default `?open=true` filter
//
// A challenge can legitimately wait months for anyone with the right expertise to solve it — at
// scale that is the NORMAL case, not the edge — so `challengeClosedSql` (host/cycle-eligibility.ts)
// is now `status = 'closed'`, full stop, and takes no week argument at all. `weekClosedSql` is
// UNCHANGED and still governs SOLUTION voting (a solution's OWN week decides which cycle it
// competes in) — only the CHALLENGE predicate lost its calendar arm. T0 pins the compiled SQL of
// both, in contrast, so "the week arm is gone" is provable rather than merely asserted; T1/T2/T8
// are the cases that used to 422 on the calendar and now correctly accept; T7 is the one case that
// must still refuse, because `status` is real and the guard did not become a no-op.
//
// ⛔ AND THE ANTI-OVER-BLOCK PIN SURVIVES UNCHANGED. A "fix" that refuses EVERY submission also
// closes the marketplace — for good, and silently. T3/T4 are the cases that must stay 201; without
// them "reds on the bug" and "reds on everything" are the same test result.
//
// House conventions, from solution-votability.test.ts: far-future `2099-W..` weeks (beyond every
// `tickTenantCycles(…, DEMO_TENANT_ID)` date the rest of the suite uses, so nothing can advance these rows out from under
// the assertions), a `MARK`-prefixed title for isolation, and explicit 30s hook timeouts (bun
// ignores bunfig's `[test] timeout` for hooks — `bun run check:hooks` enforces this).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { closeCycle, openCycle, weekString } from '../src/host/cycle-service';
import { challengeClosedOver, challengeClosedSql, periodClosedSql, SOLUTION_PERIOD } from '../src/host/cycle-eligibility';
import { periodFromKey } from '../src/host/period';
import { db, users, challenges, solutions, votes, marketplaceCycles, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c9a0001';
const user: User = { id: UID, email: 'chgate@test', name: 'Gwen Gate', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const MARK = 'ZCHGATE';

// Every week this file touches, so cleanup can be exact.
//   DEAD_CYCLE_WEEK — a week whose cycle row is CLOSED, with a parent left at `status='voting'`.
//   LEGACY_WEEK     — a PAST week with NO cycle row anywhere. Prod's W23 shape, and CH-284's.
//   LIVE_WEEK       — a week with a LIVE (`phase='voting'`) cycle row. Must still accept work.
//   FUTURE_WEEK     — a FUTURE week with no cycle row yet. `challengeWeekFor` creates these.
const DEAD_CYCLE_WEEK = '2097-W21';
const LIVE_WEEK = '2097-W22';
const FUTURE_WEEK = '2097-W23';
const LEGACY_WEEK = '2020-W11';
// ⛔ A CLOSED CYCLE THAT EXISTS FROM THE FIRST ASSERTION ONWARD, and it is not decoration — this is
// solution-votability.test.ts's device, borrowed here for prod-realism rather than for the trap it
// was originally built to catch. `createSolution`'s guard is no longer a `weekClosedSql` select at
// all (see the file banner — `challengeClosedSql` dropped its week argument), so the qualification
// bug that device exists to catch cannot reproduce in THIS guard any more; T0 pins that directly
// against the compiled SQL. What this sentinel still buys: every case below runs against a database
// that already has a closed cycle sitting in it, exactly as prod does, so nothing here can pass by
// accident of an empty table.
const SENTINEL_CLOSED_WEEK = '2097-W20';
const ALL_WEEKS = [SENTINEL_CLOSED_WEEK, DEAD_CYCLE_WEEK, LIVE_WEEK, FUTURE_WEEK, LEGACY_WEEK];

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerSolutionRoutes(router);
registerChallengeRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))
  ).map((r) => r.id);
  if (chIds.length) {
    const solIds = (
      await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))
    ).map((r) => r.id);
    if (solIds.length) {
      await db.delete(votes).where(inArray(votes.target_id, solIds));
      await db.delete(solutions).where(inArray(solutions.id, solIds));
    }
    await db.delete(votes).where(inArray(votes.target_id, chIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, ALL_WEEKS));
  await db.delete(users).where(eq(users.id, UID));
}

/** A challenge with a status and a week chosen INDEPENDENTLY of each other — which is the whole
 *  point of every case below. Returns the row's id. */
async function mkChallenge(label: string, status: 'voting' | 'solution_phase' | 'closed', week: string): Promise<string> {
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} ${label}`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status, week })
    .returning();
  return c!.id;
}

/** The route's own answer for one challenge, read back off the row. Used to assert the fixture is
 *  the shape the case claims BEFORE the case leans on it — a `status` that something has swept to
 *  'closed' would make a week-gate assertion pass for the wrong reason. */
async function statusOf(id: string): Promise<string> {
  const [row] = await db.select({ status: challenges.status }).from(challenges).where(eq(challenges.id, id));
  return row!.status;
}

/** Solutions filed against a challenge — "ZERO rows inserted" is asserted through this, never
 *  through the response body alone. A 422 that still wrote a row is the failure mode worth naming. */
async function solutionCount(challengeId: string): Promise<number> {
  return (await db.select({ id: solutions.id }).from(solutions).where(eq(solutions.challenge_id, challengeId))).length;
}

// The four fixtures are built ONCE, before any case runs, because T6 asserts over the whole board
// and a per-test fixture would make its result depend on execution order.
let deadCycleCh = '';
let legacyCh = '';
let liveCh = '';
let futureCh = '';
let statusClosedCh = '';

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see the long note in
// license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'GG' }).onConflictDoNothing();

  // See SENTINEL_CLOSED_WEEK: every case below runs against a database that already has a closed
  // cycle in it, exactly as prod does.
  await openCycle(SENTINEL_CLOSED_WEEK, DEMO_TENANT_ID);
  await closeCycle(SENTINEL_CLOSED_WEEK, DEMO_TENANT_ID);

  // ⚠️ THE CYCLE IS CLOSED **BEFORE** THE CHALLENGE IS CREATED. `closeCycle` sweeps the week's
  // challenges to `status='closed'`, so building the row first would hand this file a fixture whose
  // status arm fires and whose week arm is never exercised — the exact silent-pass this test is
  // about. Created after, the row keeps `status='voting'` on a dead cycle: prod's shape.
  await openCycle(DEAD_CYCLE_WEEK, DEMO_TENANT_ID);
  await closeCycle(DEAD_CYCLE_WEEK, DEMO_TENANT_ID);
  deadCycleCh = await mkChallenge('t1 dead cycle live status', 'voting', DEAD_CYCLE_WEEK);

  // CH-284 itself: a past week the engine never opened a row for.
  legacyCh = await mkChallenge('t2 legacy no row', 'voting', LEGACY_WEEK);

  // A genuinely live cycle — the row exists and says `voting`.
  await openCycle(LIVE_WEEK, DEMO_TENANT_ID);
  liveCh = await mkChallenge('t3 live cycle', 'voting', LIVE_WEEK);

  // A future week the engine has not opened yet (`challengeWeekFor` rolls late submissions into
  // one). No row at all, and it must NOT be read as "no row ⇒ dead".
  futureCh = await mkChallenge('t4 future no row', 'voting', FUTURE_WEEK);

  // The status arm, on a week that is unambiguously OPEN — an engine/super-admin close is an
  // authoritative fact the week predicate deliberately does not cover.
  statusClosedCh = await mkChallenge('t7 status closed live week', 'closed', LIVE_WEEK);

  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

// ── T0: challengeClosedSql compiles to the STATUS predicate alone — the week arm is gone ──────

test('T0 · challengeClosedSql compiles to `status = \'closed\'` and NOTHING else — no week, no cycle table', () => {
  // ⛔⛔ THE INVERSE OF WHAT THIS TEST USED TO PIN, and it has to be the compiled SQL, not just the
  // TS call signature. `challengeClosedSql()` now takes zero arguments — a caller cannot pass a
  // week back in even by accident — but a *behavioural* regression (someone re-adding an `or(...,
  // weekClosedSql(...))` inside the function body itself) would still typecheck and still compile.
  // Every fixture week below happens to agree with its own status, so T1/T2/T7/T8 alone could not
  // tell "the week arm is gone" apart from "the week arm just never fired on these rows" — only the
  // compiled predicate can. See cycle-eligibility.ts's `challengeClosedSql` header for the WHY.
  // ⚠️ THE COLUMN, NOT A QUALIFIED SPELLING. Measured: in SELECT-FIELD position drizzle emits a bare
  // `"status" = $1`; in WHERE position it emits `"challenges"."status"` (and `"ranked"."status"` over
  // the board subquery). The bare form only appears where the FROM has exactly one source, so it
  // cannot be ambiguous — and it appears only because removing the week arm removed the `or(...)`
  // nesting that used to force hand-qualification. Pinning the qualified spelling here fails against
  // CORRECT code; the where-position assertion below is where qualification actually matters.
  const dto = db.select({ id: challenges.id, c: challengeClosedSql() }).from(challenges).toSQL().sql;
  expect(dto).toContain('"status" = ');
  expect(dto, 'the week arm is back — challengeClosedSql must never touch marketplace_cycles').not.toContain(
    'marketplace_cycles',
  );
  expect(dto, 'the week arm is back — no correlated cycle-week comparison should remain').not.toContain('mc.week');

  // The same predicate over an aliased column (host/challenge-board.ts's `ranked.status`) must
  // collapse identically — `challengeClosedOver` is the one place both spellings are allowed to
  // exist, precisely so a caller reaching for the aliased column cannot reintroduce a week join.
  const overRanked = challengeClosedOver(challenges.status);
  const dtoOver = db.select({ id: challenges.id, c: overRanked }).from(challenges).toSQL().sql;
  expect(dtoOver).toContain('"status" = ');
  expect(dtoOver).not.toContain('marketplace_cycles');

  // ⚠️ CONTRAST, SO THE ABSENCE ABOVE READS AS A CHOICE AND NOT AS BREAKAGE. `periodClosedSql` is
  // UNCHANGED — it still governs SOLUTION voting (host/vote-service, and the list/detail solution
  // DTOs' `cycleClosed`), so it must still emit exactly the correlated-subquery machinery
  // `challengeClosedSql` just lost. If this half ever stops containing `marketplace_cycles`, the
  // week arm was deleted from the wrong predicate.
  const voteGate = db
    .select({
      id: solutions.id,
      c: periodClosedSql(SOLUTION_PERIOD, { mode: 'on', kind: 'week', start: periodFromKey('2099-W01').start }),
    })
    .from(solutions)
    .toSQL().sql;
  expect(voteGate).toContain('marketplace_cycles');
  expect(voteGate).toContain('mc.period_start = "solutions"."period_start"');
});

// ── T1: a dead CYCLE behind a live status no longer refuses ──────────────────────────────────

test('T1 · a challenge whose CYCLE closed long ago still ACCEPTS — the calendar does not decide', async () => {
  // ⛔ INVERTED FROM THIS FILE'S OLD RULE. This used to be the case that proved `status` lagging the
  // cycle by a tick was dangerous and had to be caught by a week arm. It no longer is: the calendar
  // is not evidence a challenge is finished, and DEAD_CYCLE_WEEK closing months ago tells the guard
  // nothing at all now — only `status` does, and it still reads 'voting'.
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, DEAD_CYCLE_WEEK));
  expect(cycle!.phase, 'the fixture must still be a genuinely dead cycle for this to prove anything').toBe('closed');
  expect(await statusOf(deadCycleCh), 'status is the ONLY thing the guard reads now').toBe('voting');

  const r = await call('POST', '/api/solutions', { challenge_id: deadCycleCh, title: `${MARK} t1 accepted` });
  expect(r.status).toBe(201);
  expect(await solutionCount(deadCycleCh)).toBe(1);
}, 30_000);

// ── T2: prod's actual shape — a past week with NO cycle row — no longer refuses ───────────────

test('T2 · a PAST week with NO cycle row ACCEPTS — this is CH-284\'s shape, and accepting IS correct', async () => {
  // ⛔ CH-284, BYTE FOR BYTE, AND WHY THE VERDICT FLIPPED. Nothing in the engine's steady state
  // creates a cycle row for a past week, so prod's W21 and W23 carry challenges with no
  // `marketplace_cycles` entry at all — exactly this fixture. Under the OLD rule that made the
  // challenge "week-closed" and this call 422'd; that was the incident this file was written to
  // pin. Under THIS rule a stale week is not evidence of anything: the challenge's own `status`
  // says it is still open, so a solver reaching it months later is the product working as intended,
  // not a repeat of CH-284.
  const [existing] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, LEGACY_WEEK));
  expect(existing, 'this test is meaningless if a cycle row exists for the legacy week').toBeUndefined();
  expect(await statusOf(legacyCh), 'status is the ONLY thing the guard reads now').toBe('voting');

  const r = await call('POST', '/api/solutions', { challenge_id: legacyCh, title: `${MARK} t2 accepted` });
  expect(r.status).toBe(201);
  expect(await solutionCount(legacyCh)).toBe(1);
}, 30_000);

// ── T3: the anti-over-block pin ───────────────────────────────────────────────────────────────

test('T3 · a challenge whose cycle row says voting ACCEPTS a solution — the gate is not a wall', async () => {
  // ⛔ WITHOUT THIS CASE A GUARD THAT REFUSES EVERYTHING IS GREEN, and a marketplace that accepts
  // nothing is a worse outage than one that accepts the wrong thing. Run against a database that
  // already has a closed cycle in it (SENTINEL_CLOSED_WEEK) precisely so a guard that degraded to
  // "is any cycle anywhere closed" — the old qualification trap T0 now pins directly — would 422
  // here instead of passing by accident of an empty `marketplace_cycles` table.
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, LIVE_WEEK));
  expect(cycle!.phase).toBe('voting');
  const [sentinel] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, SENTINEL_CLOSED_WEEK));
  expect(sentinel!.phase).toBe('closed');

  const r = await call('POST', '/api/solutions', { challenge_id: liveCh, title: `${MARK} t3 accepted` });
  expect(r.status).toBe(201);
  expect(await solutionCount(liveCh)).toBe(1);
}, 30_000);

// ── T4: a future week the engine has not opened ───────────────────────────────────────────────

test('T4 · a FUTURE week with no cycle row ACCEPTS — "no row" is not "dead" in both directions', async () => {
  // `challengeWeekFor` rolls a challenge submitted after the running week's voting window into W+1,
  // which the engine has not opened yet. Treating a missing row as closed would refuse every
  // solution to the newest challenges on the board — the mirror-image over-block of T2's under-block.
  const [existing] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, FUTURE_WEEK));
  expect(existing, 'this test is meaningless if a cycle row exists for the future week').toBeUndefined();

  const r = await call('POST', '/api/solutions', { challenge_id: futureCh, title: `${MARK} t4 accepted` });
  expect(r.status).toBe(201);
  expect(await solutionCount(futureCh)).toBe(1);
}, 30_000);

// ── T5: the DTOs say what the gate decides ────────────────────────────────────────────────────

test('T5 · every challenge DTO carries cycleClosed, and it now equals `status === "closed"` alone', async () => {
  // ⛔ A SERVER-ONLY FIX IS INVISIBLE. If the board cannot read the gate it renders a live "Submit a
  // solution" button on a dead challenge and the author meets a 422 after writing their flow. All
  // three surfaces are asserted against the SERVER'S OWN ANSWER on the same rows, not a constant.
  //
  // ⚠️ PRESENCE IS ASSERTED WITH `in`, NEVER `!== undefined`: `cycleClosed: false` and a field the
  // route forgot to select both read as falsy, and `undefined !== undefined` is false either way —
  // a missing field would pass a `!== undefined` check written the obvious way round on the `true`
  // row and silently pass on the `false` one. `in` asks the only question that matters.
  const submitGate = async (challengeId: string): Promise<boolean> => {
    const r = await call('POST', '/api/solutions', { challenge_id: challengeId, title: `${MARK} t5 probe` });
    if (r.status === 201) {
      await db.delete(solutions).where(eq(solutions.id, r.json.id));
      return false;
    }
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('challenge_closed');
    return true;
  };

  // ---- the challenge LIST row
  const list = await call('GET', `/api/challenges?q=${MARK}`);
  expect(list.status).toBe(200);
  const rowFor = (id: string) => list.json.items.find((i: { id: string }) => i.id === id);
  for (const id of [deadCycleCh, legacyCh, liveCh, futureCh, statusClosedCh]) {
    const row = rowFor(id);
    expect(row, `challenge ${id} is missing from its own board`).toBeDefined();
    expect('cycleClosed' in row, 'the list row does not carry cycleClosed at all').toBe(true);
  }
  // ⛔ THE CALENDAR NO LONGER DECIDES. Under the OLD rule deadCycleCh (dead cycle) and legacyCh (no
  // cycle row, a past week) both read `cycleClosed: true`. Under THIS rule both are `false`, because
  // `status` — still 'voting' on both — is now the ONLY input the field has left to read.
  expect(rowFor(deadCycleCh).cycleClosed).toBe(false);
  expect(rowFor(legacyCh).cycleClosed).toBe(false);
  expect(rowFor(liveCh).cycleClosed).toBe(false);
  expect(rowFor(futureCh).cycleClosed).toBe(false);
  expect(rowFor(statusClosedCh).cycleClosed).toBe(true);
  // …and it now literally IS `status === 'closed'` on every row, not merely correlated with it —
  // there is no other input left for the two to disagree over.
  for (const id of [deadCycleCh, legacyCh, liveCh, futureCh, statusClosedCh]) {
    expect(rowFor(id).cycleClosed).toBe(rowFor(id).status === 'closed');
  }

  // ---- the challenge DETAIL response — statusClosedCh (closed) vs liveCh (open), same LIVE_WEEK,
  // so `status` is the only variable between the two fixtures.
  const closedDetail = await call('GET', `/api/challenges/${statusClosedCh}`);
  const liveDetail = await call('GET', `/api/challenges/${liveCh}`);
  expect(closedDetail.status).toBe(200);
  expect(liveDetail.status).toBe(200);
  expect('cycleClosed' in closedDetail.json, 'the detail response does not carry cycleClosed at all').toBe(true);
  expect('cycleClosed' in liveDetail.json).toBe(true);
  expect(closedDetail.json.cycleClosed).toBe(true);
  expect(liveDetail.json.cycleClosed).toBe(false);

  // ---- the nested `challenge` object on SOLUTION detail
  // liveCh already carries T3's solution. statusClosedCh can only be given one the way any
  // status-closed challenge now can — behind the gate's back, straight into the table, since the
  // gate itself correctly refuses it (T7). Deleted before this test ends: statusClosedCh is ALSO
  // T7's fixture, and T7 asserts its solution count is exactly 0 after a refused submit — a row
  // planted here and left behind would fail that assertion for a POST T7 never made.
  const [closedSol] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({
        challenge_id: statusClosedCh,
        title: `${MARK} t5 orphan entry`,
        author_id: UID,
        tenant_id: DEMO_TENANT_ID,
        status: 'voting',
        week: LIVE_WEEK,
        blocks_used: [],
      })
      .returning(),
  );
  try {
    const [liveSol] = await db.select({ id: solutions.id }).from(solutions).where(eq(solutions.challenge_id, liveCh));
    const closedNested = (await call('GET', `/api/solutions/${closedSol!.id}`)).json.challenge;
    const liveNested = (await call('GET', `/api/solutions/${liveSol!.id}`)).json.challenge;
    expect('cycleClosed' in closedNested, 'the nested challenge does not carry cycleClosed at all').toBe(true);
    expect('cycleClosed' in liveNested).toBe(true);
    expect(closedNested.cycleClosed).toBe(true);
    expect(liveNested.cycleClosed).toBe(false);

    // ---- and all three agree with the SERVER, in both directions
    expect(await submitGate(statusClosedCh)).toBe(true);
    expect(await submitGate(liveCh)).toBe(false);
    expect(rowFor(statusClosedCh).cycleClosed).toBe(await submitGate(statusClosedCh));
    expect(rowFor(liveCh).cycleClosed).toBe(await submitGate(liveCh));
    expect(closedDetail.json.cycleClosed).toBe(closedNested.cycleClosed);
    expect(liveDetail.json.cycleClosed).toBe(liveNested.cycleClosed);
  } finally {
    await db.delete(solutions).where(eq(solutions.id, closedSol!.id));
  }
}, 30_000);

// ── T6: the OPT-IN live filter ────────────────────────────────────────────────────────────────

test('T6 · ?open=true returns every non-status-closed challenge, and the per-domain counts still sum to total', async () => {
  // ⛔ THE POPULATION THIS FILTER ADMITS GREW. `openOnly` compiles to `not(challengeClosedOver(...))`
  // (routes/challenges.ts), so it is now `status !== 'closed'` — nothing about a cycle or a week is
  // consulted. deadCycleCh and legacyCh, which used to be filtered OUT for a stale calendar, are now
  // IN: four of this file's five fixtures are open, and statusClosedCh is the only one excluded.
  //
  // ⚠️ THE FILTER MUST BE ON BOTH QUERIES. `total` is read out of `counts`, so filtering the rows
  // without filtering the counts leaves a pager promising pages of rows the filter removed, and
  // filtering the counts without the rows leaves chips that under-report a board still showing
  // them. Asserted as an INVARIANT (chips sum to total) rather than as a number, so it holds
  // whatever else the shared database happens to contain.
  const open = await call('GET', `/api/challenges?q=${MARK}&open=true`);
  expect(open.status).toBe(200);
  const ids = open.json.items.map((i: { id: string }) => i.id);
  expect(ids.sort()).toEqual([deadCycleCh, legacyCh, liveCh, futureCh].sort());
  expect(open.json.items.every((i: { cycleClosed: boolean }) => i.cycleClosed === false)).toBe(true);

  const perDomainSum = Object.entries(open.json.counts as Record<string, number>)
    .filter(([k]) => k !== 'all')
    .reduce((s, [, n]) => s + n, 0);
  expect(perDomainSum).toBe(open.json.counts.all);
  expect(open.json.total).toBe(open.json.counts.all);
  expect(open.json.total).toBe(4);

  // ⛔ AND IT IS OPT-IN. The unfiltered board is a HISTORY as well as an invitation, and this file's
  // own fixtures make the point: deadCycleCh and legacyCh sit on weeks from 2099 and 2020
  // respectively, arbitrarily far from `now` in both directions, and both are still `status='voting'`
  // — still open, still on the board, exactly as a challenge waiting months for a solver should be.
  // Making `open=true` the route default would hide them from every screen that reads it for no
  // reason but their age.
  const all = await call('GET', `/api/challenges?q=${MARK}`);
  expect(all.json.items).toHaveLength(5);
  expect(all.json.total).toBe(5);
  // An unrecognised value is not a filter — `?open=maybe` must behave exactly like no parameter.
  const junk = await call('GET', `/api/challenges?q=${MARK}&open=maybe`);
  expect(junk.json.total).toBe(5);
}, 30_000);

// ── T7: the status predicate is real, on a week where nothing about the calendar would say so ──

test('T7 · an explicitly CLOSED challenge on a LIVE week still refuses — status is a real gate, not a no-op', async () => {
  // ⛔ THE PRIMARY PROOF THE PREDICATE STILL DOES ANYTHING. T1/T2/T8 all now ACCEPT — every week
  // arm that used to refuse them is gone. This is the one case left that must still 422, and it is
  // deliberately built where nothing about the calendar would explain a refusal: LIVE_WEEK's own
  // cycle row is `phase='voting'`, mid-cycle, nowhere near a boundary. Only `status='closed'` — set
  // here by `healOrphanedChallenges` or a super-admin close, a fact someone or something asserted —
  // makes this refuse. If T7 ever goes green for the wrong reason, it is because `challengeClosedSql`
  // quietly became `() => sql\`false\``, not because the week happens to agree.
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, LIVE_WEEK));
  expect(cycle!.phase, 'the week arm must NOT be what fires here').toBe('voting');

  const r = await call('POST', '/api/solutions', { challenge_id: statusClosedCh, title: `${MARK} t7 too late` });
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('challenge_closed');
  expect(await solutionCount(statusClosedCh)).toBe(0);
}, 30_000);

// ── T8: THE CALENDAR PROOF — a week computed relative to `now`, so this test cannot rot ────────

test('T8 · a challenge open on a week hundreds of days in the past still ACCEPTS — no fixed week proves this', async () => {
  // ⛔ EVERY OTHER FIXTURE IN THIS FILE USES A FIXED LITERAL ON PURPOSE (see the house-conventions
  // note at the top: far-future `2099-W..` so nothing in the rest of the suite's `tickTenantCycles(..., DEMO_TENANT_ID)`
  // calls can ever advance it out from under an assertion). That convention is exactly wrong here.
  // A hardcoded week — even one from 2020 — only proves the rule held on one fixed point in
  // calendar time; it says nothing about whether "closed" could creep back in as a hidden function
  // of how far that point sits from whenever the suite happens to run. The actual claim under test —
  // "a challenge cannot be closed by the calendar, no matter how old it is" — has to be pinned
  // against a week computed from `now`, so it is exercised freshly on every run, years from now
  // included, and cannot be satisfied by a literal that quietly stops being "old" as time passes.
  const ancientWeek = weekString(new Date(Date.now() - 400 * 24 * 3600 * 1000));
  const ancientCh = await mkChallenge('t8 ancient week open', 'voting', ancientWeek);

  const r = await call('POST', '/api/solutions', { challenge_id: ancientCh, title: `${MARK} t8 accepted` });
  expect(r.status).toBe(201);
  expect(await solutionCount(ancientCh)).toBe(1);
  // No `marketplace_cycles` row exists for `ancientWeek` — nothing opened or closed it — which is
  // the point: under the old rule an unset cycle on a past week fell to the LEGACY_WEEK case (T2)
  // and refused. Here it accepts on `status` alone, 400 days out, with no cycle bookkeeping at all.
  const [existing] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, ancientWeek));
  expect(existing, 'a real cycle row for a 400-day-old week would undercut what this test is pinning').toBeUndefined();
}, 30_000);
