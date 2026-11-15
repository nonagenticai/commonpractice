// tests/challenge-no-auto-close.test.ts — the calendar-proof pin for challenges.
//
// ⛔ WHY THIS FILE EXISTS. Three closers used to treat a challenge's ISO week as a deadline on the
// WORK itself, not just on the weekly voting competition: `closeCycle` swept every challenge in a
// closing week to `status='closed'`, and `healOrphanedChallenges` did the same for anything stranded
// in an already-elapsed week. Measured against prod: all 17 production challenges ended up `closed`,
// the board rendered EMPTY under its default `?open=true` filter, and every vote 409'd
// `voting_closed`. A challenge can legitimately wait months for someone able to solve it — at a large
// company with thousands of challenges that is the NORMAL case — so the calendar must never be the
// thing that decides a challenge is "done". `challengeClosedOver` / `challengeClosedSql`
// (cycle-eligibility.ts) are `eq(status,'closed')` alone — no week arm — so this file pins the
// BEHAVIOUR those predicates exist to describe, not the predicate itself (that is
// cycle-eligibility.test.ts's job).
//
// ⛔ THE INVARIANT, AS OF THIS STEP — the owner ruled the calendar must not decide a challenge's
// phase AT ALL, not even "advance it to solution_phase instead of closed". So:
//   `challenges.status = 'solution_phase'` IFF the challenge has ≥1 solution. `'voting'` otherwise.
//   `'closed'` stays unwritable (nothing in this engine ever sets it — winners are still ranked and
//   shipped by `closeCycle`, but only the CYCLE closes; the challenge outlives it).
// `cycle-service.ts closeCycle` had its `update(challenges).set({status:'closed'})` sweep deleted
// outright. `cycle-service.ts enterSolutionPhase` no longer touches `challenges` at all — it only
// advances the cycle row's phase and opens that week's solutions for voting. `healOrphanedChallenges`
// is now REPORT-ONLY: it keeps its `stranded`/candidate READ (so the `cycle.heal` audit row still
// names the challenges an old bug would have mishandled) but performs no WRITE — a challenge stranded
// in a dead week stays exactly where a human left it. The only remaining writer of
// `challenges.status` is `routes/solutions.ts` `createSolution`: filing the FIRST solution against a
// challenge advances it `voting → solution_phase`, inside the solution-insert transaction, guarded by
// `eq(challenges.status, 'voting')` — which is what makes a 2nd/Nth solution a no-op rather than a
// re-write, and what stops the write from ever demoting `solution_phase` back or resurrecting
// `closed`.
//
// ⛔ NEVER a hardcoded `20\d\d-W\d\d` literal here. Every week this file uses is derived from
// `new Date()` at run time via `weekString`, specifically so this suite cannot rot as the calendar
// advances — the whole point is "long enough ago that the OLD calendar-driven bug would have fired".
//
// Fixture ids are namespaced `cnac-`/`ZCNACTEST` — distinct from cycle.test.ts (ZCYCTEST),
// cycle-eligibility.test.ts (ZCELIGTEST) and challenges.test.ts (ZCHTEST), all of which share this
// database.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { db, users, challenges, solutions, marketplaceCycles, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { openCycle, closeCycle, enterSolutionPhase, tickTenantCycles, weekStart, weekString } from '../src/host/cycle-service';
import type { User } from '../src/types';

const DAY = 24 * 60 * 60 * 1000;
const UID = '00000000-0000-0000-0000-0000000cac01'; // 'cnac' spelled in hex-legal digits (uuid forbids 'n')
const testUser: User = { id: UID, email: 'cnac@test', name: 'Cnac Test', roles: ['employee'], tenantId: DEMO_TENANT_ID };
const MARK = 'ZCNACTEST';

// Two DISTINCT past weeks, both derived from `new Date()` — never a literal. Kept apart (52 vs 80
// weeks back) so test 1's `openCycle` call cannot leave a marketplace_cycles row behind that would
// contaminate test 3's "no cycle row at all" precondition for healOrphanedChallenges.
const NOW = new Date();
const OLD_WEEK = weekString(new Date(NOW.getTime() - 52 * 7 * DAY));
const ORPHAN_WEEK = weekString(new Date(NOW.getTime() - 80 * 7 * DAY));

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);
// Needed for the "a solution advances the challenge" cases below — the ONLY remaining writer of
// `challenges.status` lives in `createSolution`, so pinning the invariant's "yes" direction means
// actually exercising that route rather than poking the column by hand.
registerSolutionRoutes(router);

// Wiring the real HTTP route turned out cheap here (challenges.test.ts already establishes the exact
// pattern), so case 2 goes through the actual `?open=true` list route rather than asserting
// `challengeClosedOver` directly — it is the closer instrument to "is this visible to a user". `body`
// is optional (GET callers omit it) so this one helper serves both the challenge list route and the
// solution-create route (mirrors tests/solutions.test.ts's `call`).
async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
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
    await db.delete(solutions).where(inArray(solutions.challenge_id, chIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, [OLD_WEEK, ORPHAN_WEEK]));
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see the long note in
// license-provisioning.test.ts), so a slow one fails as "(unnamed) [5003ms]" with no cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: testUser.email, name: testUser.name, avatar_initials: 'CN' }).onConflictDoNothing();
  asUser(testUser);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

// A challenge id shared between the first two tests: test 1 drives it through a real cycle tick and
// test 2 checks what a user is actually served afterwards. Sequential sharing is the house pattern —
// challenges.test.ts's own tests accumulate MARK rows across `test()` blocks the same way.
let survivorId: string;

test('a challenge ~52 weeks old survives tickCycles + closeCycle — the calendar never closes it, nor advances it', async () => {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} calendar-survivor`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: OLD_WEEK })
    .returning();
  survivorId = ch!.id;

  await openCycle(OLD_WEEK, DEMO_TENANT_ID);
  // Land squarely past both phase boundaries (default 4+3 cadence closes at week_start+7d), so ONE
  // tick drives the CYCLE voting -> solution_phase -> closed in a single call — the same "boot
  // catch-up" shape as cycle.test.ts's own overdue-cycle test. The challenge has no solution, so
  // none of that is a statement about IT.
  const tick = await tickTenantCycles(new Date(weekStart(OLD_WEEK).getTime() + 8 * DAY), DEMO_TENANT_ID);
  expect(tick.advanced).toContain(OLD_WEEK); // sanity: the CYCLE really did move voting -> solution_phase
  expect(tick.closed).toContain(OLD_WEEK); // sanity: and the CYCLE really did close

  // Run closeCycle explicitly too (idempotent — the tick above already closed it): the task this
  // test guards is specifically that NEITHER entry point ever touches the challenge.
  const reclose = await closeCycle(OLD_WEEK, DEMO_TENANT_ID);
  expect(reclose.closed).toBe(false);

  const [row] = await db.select().from(challenges).where(eq(challenges.id, survivorId));
  // THE REGRESSION PIN. Before this step, closeCycle's now-deleted sweep set every challenge in the
  // closing week to 'closed', and an intermediate version of the fix advanced it to 'solution_phase'
  // instead. Both are the calendar deciding a challenge's phase, and the owner ruled that out
  // entirely: with zero solutions filed, the challenge must sit exactly where it started, however
  // hard or however many times the cycle machinery runs over it.
  expect(row!.status).not.toBe('closed');
  expect(row!.status).toBe('voting');

  // ...and it does not creep forward on a SECOND tick either (the calendar has no ratchet on this
  // row at all — see the dedicated "stays voting across repeated ticks" case below for the same pin
  // isolated from closeCycle/openCycle noise).
  await tickTenantCycles(new Date(weekStart(OLD_WEEK).getTime() + 15 * DAY), DEMO_TENANT_ID);
  const [row2] = await db.select().from(challenges).where(eq(challenges.id, survivorId));
  expect(row2!.status).toBe('voting');
}, 30_000);

test('...and it is still served by GET /api/challenges?open=true — the calendar cannot hide it from a user', async () => {
  const r = await callJson('GET', `/api/challenges?q=${MARK}&open=true`);
  expect(r.status).toBe(200);
  const row = (r.json.items as { id: string; cycleClosed: boolean }[]).find((i) => i.id === survivorId);
  expect(row, 'the calendar-survivor challenge must be in the open-only list').toBeDefined();
  // cycleClosed is challengeClosedOver(status) = eq(status,'closed'); status is 'voting' (never
  // touched by the calendar — see the previous test), so this must read false — the open filter
  // (`not(challengeClosedOver(...))`) is what let it through. `?open=true` means "not closed", and
  // 'voting' qualifies exactly as much as 'solution_phase' would have.
  expect(row!.cycleClosed).toBe(false);
}, 30_000);

test('healOrphanedChallenges (via tickCycles) is report-only — a stranded voting row stays voting, forever', async () => {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} stranded-orphan`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: ORPHAN_WEEK })
    .returning();
  const id = ch!.id;

  // Sanity on the precondition healOrphanedChallenges exists for: a past week with NO cycle row at
  // all (the actual prod shape — no seed path ever inserts a marketplace_cycles row for a past week).
  const preexisting = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, ORPHAN_WEEK));
  expect(preexisting).toHaveLength(0);

  // Deliberately NOT asserting on `tickTenantCycles(..., DEMO_TENANT_ID)`'s return shape — `healOrphanedChallenges`'s
  // return type is changing in this same commit (report-only), and coupling this test to whatever
  // field replaces `healed` would make it fail for the wrong reason. The database row is the only
  // thing this invariant is about.
  await tickTenantCycles(new Date(), DEMO_TENANT_ID);
  const [afterFirst] = await db.select().from(challenges).where(eq(challenges.id, id));
  // THE REGRESSION PIN. The heal used to advance this row — first to 'closed', then (an intermediate
  // step) to 'solution_phase'. Both are the calendar deciding the challenge is done or has moved on,
  // with zero solutions filed. Under the current rule it is neither: it stays 'voting'.
  expect(afterFirst!.status).toBe('voting');

  // Run it again — not to check convergence (there is nothing left to converge; a report-only sweep
  // has no write to make idempotent), but to pin that repeated ticks cannot eventually wear the row
  // down by some other path than the one already checked.
  await tickTenantCycles(new Date(), DEMO_TENANT_ID);
  const [afterSecond] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(afterSecond!.status).toBe('voting');
}, 30_000);

test('no solutions ⇒ stays voting across repeated ticks, from a fresh ~52-week-old row', async () => {
  // Isolated from the shared `survivorId` fixture above (which also exercises closeCycle/openCycle
  // directly) so this is a clean, single-purpose pin: a challenge with zero solutions, aged well past
  // both phase boundaries, never leaves 'voting' no matter how many times the engine ticks over it.
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} no-solutions-ever`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: OLD_WEEK })
    .returning();
  const id = ch!.id;

  const past = new Date(weekStart(OLD_WEEK).getTime() + 8 * DAY);
  await tickTenantCycles(past, DEMO_TENANT_ID);
  const [afterFirst] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(afterFirst!.status).toBe('voting');

  await tickTenantCycles(past, DEMO_TENANT_ID);
  const [afterSecond] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(afterSecond!.status).toBe('voting');
}, 30_000);

test('a current-week challenge with no solutions, driven through enterSolutionPhase directly, stays voting', async () => {
  // This is the case that pins the DELETED challenge sweep specifically: `enterSolutionPhase` used
  // to advance every `voting` challenge in the week it claims to `solution_phase` unconditionally.
  // Without this test, restoring that sweep would not turn any other case in this file red — the
  // ~52-week-old cases above go through `tickCycles`, which also runs `healOrphanedChallenges` and
  // would mask a reintroduced sweep behind the heal's own (also report-only) no-op. Driving
  // `enterSolutionPhase` directly, on the CURRENT week (so the heal's `week < current` guard cannot
  // apply here at all), isolates the one function this pin is about.
  const currentWeek = weekString(NOW);
  await openCycle(currentWeek, DEMO_TENANT_ID); // idempotent — a fresh cycle row or the existing one, either is fine
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} current-week-no-solution`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: currentWeek })
    .returning();

  await enterSolutionPhase(currentWeek, DEMO_TENANT_ID);

  const [row] = await db.select().from(challenges).where(eq(challenges.id, ch!.id));
  expect(row!.status).toBe('voting');
}, 30_000);

test('filing the first solution advances the challenge to solution_phase; a second solution is a no-op', async () => {
  const currentWeek = weekString(NOW);
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} first-solution-advances`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: currentWeek })
    .returning();
  const id = ch!.id;

  const [before] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(before!.status).toBe('voting'); // sanity: nothing above has touched this fresh row

  // FIRST solution — no `flow_id`: routes/solutions.ts's schema makes it optional, and this test is
  // about the challenge-status side effect, not the flow/publication path.
  const first = await callJson('POST', '/api/solutions', { challenge_id: id, title: `${MARK} sol one` });
  expect(first.status).toBe(201);
  const [afterFirst] = await db.select().from(challenges).where(eq(challenges.id, id));
  // THE INVARIANT'S "YES" DIRECTION. A solution now exists, so the challenge must be 'solution_phase'
  // — this is the ONLY writer left, and it must actually fire.
  expect(afterFirst!.status).toBe('solution_phase');

  // SECOND solution — the idempotence guard (`eq(challenges.status, 'voting')` on the write) must
  // make this a 0-row no-op, not an error and not a re-write.
  const second = await callJson('POST', '/api/solutions', { challenge_id: id, title: `${MARK} sol two` });
  expect(second.status).toBe(201);
  const [afterSecond] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(afterSecond!.status).toBe('solution_phase'); // unchanged, not merely "still truthy"

  const solCount = await db.select({ id: solutions.id }).from(solutions).where(eq(solutions.challenge_id, id));
  expect(solCount).toHaveLength(2); // both solutions really landed — the guard didn't reject #2
}, 30_000);
