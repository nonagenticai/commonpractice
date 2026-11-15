// tests/votes.test.ts — the upvote toggle (Session 5), via the challenge route for
// a challenge target and directly through the shared vote-service for a solution.
// Proves: cast increments votes_count by exactly 1, a double-cast is a no-op (unique
// constraint → idempotent, never double-bumped), retract decrements, hasVoted flips.
// Also proves the two integrity guards added in the mcp-cycle round: an author cannot
// vote for their own challenge/solution (self-vote), and neither cast nor retract is
// possible once the target's cycle has closed (voting-closed gate) — see vote-service.ts.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { castVote, retractVote, votedTargetIds } from '../src/host/vote-service';
// A SOLUTION's vote gate is now its own competing cycle, so the fixtures below must open (and, for
// the closed case, close) a real cycle row rather than leaning on the parent challenge's status.
import { closeCycle, openCycle } from '../src/host/cycle-service';
import { db, users, challenges, solutions, votes, marketplaceCycles, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

// UID authors the challenges/solutions under test; VOTER is a distinct caller who votes
// on them. Voting is now author-exclusive (self-vote forbidden — FIX 3), so a single
// identity can no longer play both roles the way this file originally did.
const UID = '00000000-0000-0000-0000-00000c200001';
const VOTER_ID = '00000000-0000-0000-0000-00000c200002';
const author: User = { id: UID, email: 'votetest@test', name: 'Val Voter', roles: ['employee'] };
const voter: User = { id: VOTER_ID, email: 'votetest2@test', name: 'Vic Voter', roles: ['employee'] };
const MARK = 'ZVOTETEST';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  const solIds = ids.length ? (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, ids))).map((r) => r.id) : [];
  await db.delete(votes).where(eq(votes.user_id, UID));
  await db.delete(votes).where(eq(votes.user_id, VOTER_ID));
  if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
  if (ids.length) await db.delete(challenges).where(inArray(challenges.id, ids));
  // The cycle rows the two solution fixtures open (far-future, so they cannot collide with real data).
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, ['2097-W05', '2097-W06']));
  await db.delete(users).where(eq(users.id, UID));
  await db.delete(users).where(eq(users.id, VOTER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: author.email, name: author.name, avatar_initials: 'VV' }).onConflictDoNothing();
  await db.insert(users).values({ id: VOTER_ID, email: voter.email, name: voter.name, avatar_initials: 'VC' }).onConflictDoNothing();
  asUser(voter);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(voter));

test('challenge vote toggle: +1, idempotent double-cast, then -1', async () => {
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} ch`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, votes_count: 100 })
    .returning();

  const v1 = await call('POST', `/api/challenges/${c!.id}/vote`);
  expect(v1.status).toBe(200);
  expect(v1.json).toMatchObject({ voted: true, count: 101 });

  // Double-cast is a no-op — count stays 101, only one vote row exists.
  const v2 = await call('POST', `/api/challenges/${c!.id}/vote`);
  expect(v2.json).toMatchObject({ voted: true, count: 101 });
  const rows = await db.select().from(votes).where(eq(votes.target_id, c!.id));
  expect(rows).toHaveLength(1);

  const voted = await votedTargetIds(VOTER_ID, 'challenge', [c!.id]);
  expect(voted.has(c!.id)).toBe(true);

  const u1 = await call('DELETE', `/api/challenges/${c!.id}/vote`);
  expect(u1.json).toMatchObject({ voted: false, count: 100 });
  // Retract again is a no-op (count floor holds).
  const u2 = await call('DELETE', `/api/challenges/${c!.id}/vote`);
  expect(u2.json).toMatchObject({ voted: false, count: 100 });

  const votedAfter = await votedTargetIds(VOTER_ID, 'challenge', [c!.id]);
  expect(votedAfter.has(c!.id)).toBe(false);
});

test('solution vote toggle via the shared service', async () => {
  // ⚠️ THE FIXTURE STAMPS A WEEK AND OPENS ITS CYCLE, AND IT HAS TO. This test used to insert a
  // solution with NO week at all — taking the `text NOT NULL DEFAULT ''` column default — and
  // expect the vote to succeed. It did succeed, but only because votability was read off the parent
  // challenge, which was open. Under the rule this suite now enforces (`weekClosedSql`: a solution
  // is votable iff the cycle IT COMPETES IN is still running) `week=''` is a DEAD week: it sorts
  // below every real one and has no cycle row, so it can never be judged. Re-baselining this test
  // to "expect a 409" would have deleted the only coverage of the +1/idempotent/-1 toggle itself,
  // so the fixture is corrected instead — a live week with an open cycle, which is what a real
  // votable solution looks like. `week=''` gets its own explicit test in
  // tests/solution-votability.test.ts (T4).
  const WEEK = '2097-W05';
  await openCycle(WEEK, DEMO_TENANT_ID);
  const [c] = await db.insert(challenges).values({ title: `${MARK} ch2`, work_area: 'IT', submitter_id: UID, tenant_id: UID }).returning();
  const [s] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: c!.id, title: `${MARK} sol`, author_id: UID, week: WEEK, votes_count: 5 }).returning());

  const r1 = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', s!.id));
  expect(r1).toMatchObject({ voted: true, count: 6 });
  const r2 = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', s!.id)); // idempotent
  expect(r2).toMatchObject({ voted: true, count: 6 });
  const r3 = await withTenantDb(DEMO_TENANT_ID, () => retractVote(VOTER_ID, 'solution', s!.id));
  expect(r3).toMatchObject({ voted: false, count: 5 });
});

test('voting a non-existent target is 404', async () => {
  await expect(castVote(VOTER_ID, 'challenge', '00000000-0000-0000-0000-00000c2fffff')).rejects.toThrow();
});

// ---- FIX 3: self-vote guard ----

test('an author cannot vote for their own challenge (403 via the route)', async () => {
  const [c] = await db.insert(challenges).values({ title: `${MARK} selfch`, work_area: 'Claims', submitter_id: UID, tenant_id: UID }).returning();
  asUser(author); // the submitter themselves
  const r = await call('POST', `/api/challenges/${c!.id}/vote`);
  expect(r.status).toBe(403);
  expect(r.json.error).toBe('self_vote_not_allowed');
  // Nothing was recorded.
  const rows = await db.select().from(votes).where(eq(votes.target_id, c!.id));
  expect(rows).toHaveLength(0);
});

test('an author cannot vote for their own solution (rejected by the shared service)', async () => {
  const [c] = await db.insert(challenges).values({ title: `${MARK} selfsol`, work_area: 'IT', submitter_id: UID, tenant_id: UID }).returning();
  const [s] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: c!.id, title: `${MARK} selfsol`, author_id: UID, votes_count: 0 }).returning());
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(UID, 'solution', s!.id))).rejects.toMatchObject({ code: 'self_vote_not_allowed' });
});

// ---- FIX 4: no voting once the target's cycle has closed ----

test('a closed challenge rejects new votes and retracts (409)', async () => {
  const [c] = await db.insert(challenges).values({ title: `${MARK} closedch`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, status: 'closed' }).returning();
  const r1 = await call('POST', `/api/challenges/${c!.id}/vote`);
  expect(r1.status).toBe(409);
  expect(r1.json.error).toBe('voting_closed');
  // The localization seam: `type` must reach the wire as a named field, not only inside the
  // English sentence. Without it a catalog cannot say "challenge" vs "solution" in any language.
  expect(r1.json.details.type).toBe('challenge');
  const r2 = await call('DELETE', `/api/challenges/${c!.id}/vote`);
  expect(r2.status).toBe(409);
  expect(r2.json.error).toBe('voting_closed');
  expect(r2.json.details.type).toBe('challenge');
});

test('a solution whose OWN cycle has closed rejects new votes and retracts, even though the solution itself is still status=voting', async () => {
  // ⚠️ THIS TEST WAS RENAMED BECAUSE ITS OLD NAME BECAME A LIE, NOT BECAUSE IT BROKE. It used to
  // read "a solution whose PARENT CHALLENGE has closed rejects new votes", and it stayed green
  // through the votability change — but for a completely different reason. Its fixture never
  // stamped a `week`, so the solution carried the `''` column default: under the OLD rule it was
  // refused because its parent was closed, and under the NEW one it is refused because a weekless
  // row belongs to no cycle. A test whose name explains the wrong mechanism is worse than a red
  // one; it is what a future reader will trust.
  //
  // Rewritten to prove the property that actually holds now, and to keep the parent OUT of the
  // explanation: an explicitly closed cycle, a parent left at `voting`, a solution still at
  // `voting`. `closeCycle` flips only the WINNER to 'shipping' and leaves every loser at 'voting'
  // forever, so the solution's own status is still useless as a close signal — the cycle row is the
  // signal. (The complementary direction — a LIVE cycle under a CLOSED parent must ACCEPT a vote —
  // is tests/solution-votability.test.ts T1, which is the prod shape that broke nine weeks.)
  const WEEK = '2097-W06';
  await openCycle(WEEK, DEMO_TENANT_ID);
  await closeCycle(WEEK, DEMO_TENANT_ID);
  const [c] = await db.insert(challenges).values({ title: `${MARK} closedcycle`, work_area: 'IT', submitter_id: UID, tenant_id: UID, status: 'voting', week: WEEK }).returning();
  const [s] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: c!.id, title: `${MARK} closedcycle sol`, author_id: UID, status: 'voting', week: WEEK, votes_count: 0 }).returning());
  expect(s!.status).toBe('voting'); // sanity: the non-winner's own status is still 'voting'
  expect(c!.status).toBe('voting'); // sanity: the PARENT is open — it is not what decides this
  // `details.type` is asserted as 'solution' here and as 'challenge' above — the pair is what
  // proves the field tracks the target, rather than being a constant that happens to match.
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER_ID, 'solution', s!.id))).rejects.toMatchObject({ code: 'voting_closed', details: { type: 'solution' } });
  await expect(withTenantDb(DEMO_TENANT_ID, () => retractVote(VOTER_ID, 'solution', s!.id))).rejects.toMatchObject({ code: 'voting_closed', details: { type: 'solution' } });
});
