// tests/challenges-rank-rls.test.ts — the Challenge board's `rank` is a standing WITHIN THE
// TENANT'S OWN BOARD, and this is the file that can prove it.
//
// ⛔ WHY THIS FILE EXISTS SEPARATELY FROM challenge-rank-truth.test.ts. That file inserts its rows
// with `tenant_id: UID` and then calls the route under `withTenantDb(DEMO_TENANT_ID)` — a tenant
// its own fixtures do not belong to. Every one of its assertions passes anyway, for a reason that
// has nothing to do with the code under test: the default test connection is the table OWNER
// (`rolsuper=t, rolbypassrls=t`) and `challenges` does not carry `FORCE ROW LEVEL SECURITY`, so
// the `challenges_tenant` policy is INERT in ordinary backend tests. Run that file's fixtures
// through `withTenantDbAsRuntimeRoleForTests` instead and every row is invisible — the assertions
// come back `[]`. They are therefore DECORATIVE with respect to tenant scoping: they measure the
// window, never the policy the window's own header leans on.
//
// That is a pre-existing house convention (nine files share it) and this file does not reform it.
// It ports the guard that solutions already has. tests/solutions-parent-join-rls.test.ts exists
// for exactly this reason and states the rule plainly: "A cross-tenant test that does NOT do this
// fails in the wrong direction — it passes." The /solutions window form was ported to /challenges
// WITHOUT porting that guard; this is the guard.
//
// So this file drives the LIVE route through `withTenantDbAsRuntimeRoleForTests`, which
// `SET ROLE cp_app` (NOBYPASSRLS) on the request connection and sets `app.current_tenant` — the
// production shape. Precedent: rls-isolation.test.ts, invite-cross-tenant-cascade.test.ts,
// solutions-parent-join-rls.test.ts.
//
// THE FIXTURE INTERLEAVES TWO TENANTS BY VOTES, which is what makes the two roles disagree:
//
//     tenant A   500        300        100
//     tenant B        400        200
//
// host/challenge-board.ts computes `row_number()` over the UNFILTERED board, and RLS is the ONE
// narrowing it is allowed to have ("a standing is a standing within the tenant's own board").
// So the SAME request, on the SAME data, yields:
//
//   runtime role `cp_app`, GUC = A  -> A's rows rank 1, 2, 3   (B's rows are not on A's board)
//   owner role, RLS bypassed        -> A's rows rank 1, 3, …   (MEASURED 1, 3, 10 — B's 400 sits
//                                      between A's 500 and 300, and the seed board pushes A's
//                                      100-vote row down to tenth)
//
// A leaderboard that renumbers itself according to rows the viewer may not see is the same defect
// class the board was built to remove, one level down — and only the runtime role can see it.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import {
  db,
  tenants,
  users,
  challenges,
  solutions,
  votes,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts explains why that matters).
const T_A = '00000000-0000-0000-0000-00000cb2a001';
const T_B = '00000000-0000-0000-0000-00000cb2b001';
const U_A = '00000000-0000-0000-0000-00000cb2f001';
const U_B = '00000000-0000-0000-0000-00000cb2f002';
const A_TOP = '00000000-0000-0000-0000-00000cb2c001'; // 500 votes
const A_MID = '00000000-0000-0000-0000-00000cb2c002'; // 300 votes
const A_LOW = '00000000-0000-0000-0000-00000cb2c003'; // 100 votes
const B_HI = '00000000-0000-0000-0000-00000cb2c0b1'; //  400 votes — interleaves ABOVE A_MID
const B_LO = '00000000-0000-0000-0000-00000cb2c0b2'; //  200 votes — interleaves ABOVE A_LOW
const A_IDS = [A_TOP, A_MID, A_LOW];
const ALL_IDS = [...A_IDS, B_HI, B_LO];
const MARK = 'ZCHRANKRLS';
const WEEK = '2026-W24';

const caller: User = {
  id: U_A,
  email: 'cb2@test',
  name: 'Cb2 Reader',
  roles: ['employee'],
  tenantId: T_A,
};

const router = new Router();
registerChallengeRoutes(router);

/** The board as PRODUCTION serves it: role `cp_app` (NOBYPASSRLS), `app.current_tenant` = A. */
async function boardAsRuntimeRole() {
  return callWith((fn) => withTenantDbAsRuntimeRoleForTests(T_A, fn));
}
/** The SAME request on the SAME data as the rest of the suite runs it: the table OWNER, whose
 *  `rolbypassrls=t` makes `challenges_tenant` inert. This is the CONTROL, not a second guard —
 *  its whole job is to show that the assertion above is load-bearing. */
async function boardAsOwner() {
  return callWith((fn) => withTenantDb(T_A, fn));
}

async function callWith(run: <T>(fn: () => Promise<T>) => Promise<T>) {
  const path = `/api/challenges?q=${MARK}&sort=top`;
  const matched = router.match('GET', '/api/challenges');
  if (!matched) throw new Error('no route for GET /api/challenges');
  const res = await run(() => matched.handler(new Request(`http://localhost${path}`), ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The rank each of tenant A's three rows carries, in votes order. Keyed by id, never by position:
 *  which rows come back is precisely what differs between the two roles. */
function ranksOfA(items: { id: string; rank: number }[]): (number | undefined)[] {
  const by = new Map(items.map((i) => [i.id, i.rank]));
  return A_IDS.map((id) => by.get(id));
}

async function cleanup() {
  // Teardown runs OUTSIDE any tenant context, i.e. as the owner — so it sees both tenants.
  await db.delete(votes).where(inArray(votes.target_id, ALL_IDS));
  await db.delete(solutions).where(inArray(solutions.challenge_id, ALL_IDS));
  await db.delete(challenges).where(inArray(challenges.id, ALL_IDS));
  await db.delete(users).where(inArray(users.id, [U_A, U_B]));
  await db.delete(tenants).where(inArray(tenants.id, [T_A, T_B]));
}

beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => caller, requireRole: async () => caller });

  await db.insert(tenants).values([
    { id: T_A, name: 'Cb2 Tenant A', slug: 'cb2-a' },
    { id: T_B, name: 'Cb2 Tenant B', slug: 'cb2-b' },
  ]);
  // A submitter per tenant. `users` carries NO RLS policy, so both stay visible to `cp_app` — which
  // matters: the board's `innerJoin(users)` would otherwise drop rows for a reason that has nothing
  // to do with the policy under test, and this file would be measuring the join instead.
  await db.insert(users).values([
    { id: U_A, email: caller.email, name: caller.name, tenant_id: T_A },
    { id: U_B, email: 'cb2b@test', name: 'Cb2 Other', tenant_id: T_B },
  ]);

  // Inserted as the OWNER, so both tenants' rows land regardless of any GUC. The votes interleave
  // 500/400/300/200/100 across the tenant boundary — that interleaving is the experiment.
  const base = Date.UTC(2026, 5, 1);
  await db.insert(challenges).values([
    { id: A_TOP, tenant_id: T_A, title: `${MARK} A top`, work_area: 'Claims', submitter_id: U_A, status: 'voting' as const, week: WEEK, votes_count: 500, created_at: new Date(base) },
    { id: B_HI, tenant_id: T_B, title: `${MARK} B high`, work_area: 'Claims', submitter_id: U_B, status: 'voting' as const, week: WEEK, votes_count: 400, created_at: new Date(base + 1_000) },
    { id: A_MID, tenant_id: T_A, title: `${MARK} A mid`, work_area: 'Claims', submitter_id: U_A, status: 'voting' as const, week: WEEK, votes_count: 300, created_at: new Date(base + 2_000) },
    { id: B_LO, tenant_id: T_B, title: `${MARK} B low`, work_area: 'Claims', submitter_id: U_B, status: 'voting' as const, week: WEEK, votes_count: 200, created_at: new Date(base + 3_000) },
    { id: A_LOW, tenant_id: T_A, title: `${MARK} A low`, work_area: 'Claims', submitter_id: U_A, status: 'voting' as const, week: WEEK, votes_count: 100, created_at: new Date(base + 4_000) },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the fixture really is enforcing RLS — tenant B\'s challenges are invisible to cp_app', async () => {
  // ⛔ THE META-ASSERTION, AND THE MOST IMPORTANT LINE IN THIS FILE. Every claim below is only
  // meaningful while RLS is actually biting. If a future change grants the test role BYPASSRLS, or
  // the GUC stops being set, B's rows become visible, the two roles converge, and the test below
  // would silently start proving nothing — which is exactly the state challenge-rank-truth.test.ts
  // is in. This one reds instead.
  const seenByA = await withTenantDbAsRuntimeRoleForTests(T_A, async () =>
    (await db.select({ id: challenges.id }).from(challenges).where(inArray(challenges.id, ALL_IDS))).map((r) => r.id),
  );
  expect([...seenByA].sort()).toEqual([...A_IDS].sort());
});

test('⛔ the board ranks within the tenant — A reads 1,2,3 through rows another tenant interleaves', async () => {
  const res = await boardAsRuntimeRole();
  expect(res.status).toBe(200);

  // Only A's rows come back at all…
  expect(res.json.items.map((r: { id: string }) => r.id)).toEqual(A_IDS);
  // …and they are numbered 1,2,3 CONSECUTIVELY. B's 400- and 200-vote rows sit between them on the
  // raw table and must not consume a slot: `row_number()` is computed over the board RLS leaves
  // this caller, so a row the viewer may not see cannot push the viewer's own rows down.
  expect(ranksOfA(res.json.items)).toEqual([1, 2, 3]);
  // The crown, as the browser reads it (RankBadge.svelte `.top`): exactly one row carries rank 1
  // and it is the tenant's own leader.
  const crowned = res.json.items.filter((r: { rank: number }) => r.rank === 1);
  expect(crowned).toHaveLength(1);
  expect(crowned[0]!.id).toBe(A_TOP);
  // `total` counts the same scoped board the rows came from — a pager must not promise B's rows.
  expect(res.json.total).toBe(3);
});

test('⛔ and the owner connection PROVES the assertion above is not decorative', async () => {
  // ⛔ THE NON-VACUITY CONTROL. This is the identical request over the identical data, run the way
  // the other nine challenge/solution test files run it — as the table owner, `rolbypassrls=t`.
  // If the assertion above held under BOTH roles it would be measuring nothing about tenancy, and
  // this file would be as decorative as the one it was written to backstop.
  const res = await boardAsOwner();
  expect(res.status).toBe(200);

  // B's rows are right there in the payload, which is the whole point: RLS is inert for this role.
  const ids = res.json.items.map((r: { id: string }) => r.id);
  expect(ids).toContain(B_HI);
  expect(ids).toContain(B_LO);

  const ranks = ranksOfA(res.json.items);
  // MEASURED: [1, 3, 10]. The exact third number depends on how many seed rows out-vote a 100-vote
  // challenge, so only the tenancy-determined part is pinned here — asserting 10 would make this a
  // seed-size tripwire rather than a statement about RLS.
  expect(ranks).not.toEqual([1, 2, 3]);
  // A_MID is rank 3, not 2, because B's 400-vote row — invisible to A — took the slot above it.
  expect(ranks[1]).toBe(3);
  // And A_LOW is pushed below third by rows A cannot see.
  expect(ranks[2]!).toBeGreaterThan(3);
});
