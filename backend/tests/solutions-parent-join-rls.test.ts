// tests/solutions-parent-join-rls.test.ts — the parent-challenge join must not be able to move a
// row, a rank, or the total.
//
// ⛔ WHY THIS FILE EXISTS SEPARATELY FROM solutions-pagination-search.test.ts. The assertions were
// first added there, and an adversarial pass proved they were DECORATIVE: replacing the shipped
// implementation with the exact form its comments forbid — `innerJoin(challenges, …)` INSIDE the
// `ranked` subquery, outer leftJoin deleted — left that suite 10/0 green. The cause is that the
// default test connection is the table OWNER (`rolsuper=t, rolbypassrls=t`) and neither table
// carries `FORCE ROW LEVEL SECURITY`, so RLS — the ONLY mechanism by which the two join forms can
// differ — is inert in every ordinary backend test. A guard that cannot go red is worse than no
// guard: it reports safety it never measured.
//
// So this file drives the LIVE route through `withTenantDbAsRuntimeRoleForTests`, which
// `SET ROLE cp_app` (NOBYPASSRLS) on the request connection and sets `app.current_tenant` — the
// production shape. Precedent: rls-isolation.test.ts, invite-cross-tenant-cascade.test.ts,
// marketplace-summary.test.ts. A cross-tenant test that does NOT do this fails in the wrong
// direction — it passes.
//
// THE FIXTURE IS A DELIBERATE INVARIANT VIOLATION, and that is the whole point. `solutions.tenant_id`
// is scoped-by-value with NO foreign key, and nothing in the database requires it to equal its
// challenge's `tenant_id` — only the column default and the 0028 backfill do, by convention. So we
// insert (as the owner, bypassing RLS) three solutions in tenant A whose middle one hangs off a
// challenge in tenant B. Under `cp_app` with the GUC set to A:
//
//   • all three SOLUTIONS are visible (their own tenant_id is A)
//   • the middle one's PARENT is invisible (challenges policy: tenant_id = current tenant)
//
//   shipped form  (leftJoin, OUTSIDE `ranked`) → 3 rows, ranks 1,2,3, challengeStatus null on #2
//   forbidden form (innerJoin, INSIDE `ranked`) → 2 rows against total=3, and the ranks renumber
//
// The board's entire purpose is ranking, so the second outcome is a correctness failure, not a
// cosmetic one.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSolutionRoutes } from '../src/routes/solutions';
import {
  db,
  tenants,
  users,
  challenges,
  solutions,
  votes,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts explains why that matters).
const T_A = '00000000-0000-0000-0000-00000cf10001';
const T_B = '00000000-0000-0000-0000-00000cf10002';
const UID = '00000000-0000-0000-0000-00000cf1a001';
const CH_A = '00000000-0000-0000-0000-00000cf1c0a1';
const CH_B = '00000000-0000-0000-0000-00000cf1c0b1';
const SOL_TOP = '00000000-0000-0000-0000-00000cf150a1';
const SOL_MID = '00000000-0000-0000-0000-00000cf150a2'; // the one whose parent lives in tenant B
const SOL_LOW = '00000000-0000-0000-0000-00000cf150a3';

const caller: User = {
  id: UID,
  email: 'cf1@test',
  name: 'Cf1 Builder',
  roles: ['employee'],
  tenantId: T_A,
};

const router = new Router();
registerSolutionRoutes(router);

/** The UNSCOPED board (`?challenge_id=` omitted), driven as production does: role `cp_app`,
 *  `app.current_tenant` = tenant A. Unscoped because a board scoped to one challenge could only
 *  ever have one parent, and the defect is about rows whose parents differ in visibility. */
async function board(path = '/api/solutions') {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const res = await withTenantDbAsRuntimeRoleForTests(T_A, () =>
    matched.handler(new Request(`http://localhost${path}`), ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  // Teardown runs OUTSIDE any tenant context, i.e. as the owner — so it sees both tenants.
  await db.delete(votes).where(inArray(votes.target_id, [SOL_TOP, SOL_MID, SOL_LOW]));
  await db.delete(solutions).where(inArray(solutions.id, [SOL_TOP, SOL_MID, SOL_LOW]));
  await db.delete(challenges).where(inArray(challenges.id, [CH_A, CH_B]));
  await db.delete(users).where(inArray(users.id, [UID]));
  await db.delete(tenants).where(inArray(tenants.id, [T_A, T_B]));
}

beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => caller });

  await db.insert(tenants).values([
    { id: T_A, name: 'Cf1 Tenant A', slug: 'cf1-a' },
    { id: T_B, name: 'Cf1 Tenant B', slug: 'cf1-b' },
  ]);
  await db.insert(users).values({ id: UID, email: caller.email, name: caller.name, tenant_id: T_A });

  await db.insert(challenges).values([
    {
      id: CH_A,
      tenant_id: T_A,
      title: 'Cf1 visible parent',
      description: 'x',
      work_area: 'Claims',
      submitter_id: UID,
      status: 'voting',
      week: '2026-W24',
    },
    {
      // ⛔ TENANT B. Invisible to a cp_app connection with the GUC set to A — this row is the
      // entire experiment.
      id: CH_B,
      tenant_id: T_B,
      title: 'Cf1 hidden parent',
      description: 'x',
      work_area: 'Claims',
      submitter_id: UID,
      status: 'voting',
      week: '2026-W24',
    },
  ]);

  // All three solutions belong to tenant A; only their PARENTS differ. Distinct vote counts make
  // the ordering total, so the ranks below are exact rather than merely plausible.
  await db.insert(solutions).values([
    { id: SOL_TOP, challenge_id: CH_A, tenant_id: T_A, title: 'Cf1 top', author_id: UID, votes_count: 30, blocks_used: [], week: '2026-W24' },
    { id: SOL_MID, challenge_id: CH_B, tenant_id: T_A, title: 'Cf1 mid', author_id: UID, votes_count: 20, blocks_used: [], week: '2026-W24' },
    { id: SOL_LOW, challenge_id: CH_A, tenant_id: T_A, title: 'Cf1 low', author_id: UID, votes_count: 10, blocks_used: [], week: '2026-W24' },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the fixture really is enforcing RLS — the hidden parent is invisible to cp_app', async () => {
  // ⛔ THE META-ASSERTION, AND THE MOST IMPORTANT LINE IN THIS FILE. Every claim below is only
  // meaningful while RLS is actually biting. If a future change grants the test role BYPASSRLS, or
  // the GUC stops being set, `CH_B` becomes visible, the two join forms converge, and every other
  // test here would silently start proving nothing. This one reds instead.
  const seenByA = await withTenantDbAsRuntimeRoleForTests(T_A, async () =>
    (await db.select({ id: challenges.id }).from(challenges).where(inArray(challenges.id, [CH_A, CH_B]))).map((r) => r.id),
  );
  expect(seenByA).toEqual([CH_A]);
});

test('⛔ a row whose parent is hidden KEEPS its place, its rank and its slot in the total', async () => {
  const res = await board();
  expect(res.status).toBe(200);

  const ids = res.json.items.map((r: { id: string }) => r.id);
  const ranks = res.json.items.map((r: { rank: number }) => r.rank);

  // THE ASSERTION THE FORBIDDEN FORM FAILS. An innerJoin inside `ranked` drops SOL_MID entirely:
  // two rows come back, `total` still says three, and SOL_LOW is renumbered from 3 to 2 — a pager
  // that promises a row it will never deliver, on a board whose whole purpose is ranking.
  expect(ids).toEqual([SOL_TOP, SOL_MID, SOL_LOW]);
  expect(ranks).toEqual([1, 2, 3]);
  expect(res.json.total).toBe(3);
  expect(res.json.items).toHaveLength(res.json.total);
});

test('the hidden parent degrades to challengeStatus null — never to a guess', async () => {
  const res = await board();
  const byId = new Map(res.json.items.map((r: { id: string }) => [r.id, r]));

  // Visible parents resolve.
  expect((byId.get(SOL_TOP) as { challengeStatus: string }).challengeStatus).toBe('voting');
  expect((byId.get(SOL_LOW) as { challengeStatus: string }).challengeStatus).toBe('voting');

  // The hidden one is null, and null is a FACT — the parent is outside this caller's RLS scope, so
  // the board says "we cannot see it" instead of guessing 'voting'.
  //
  // ⛔ THIS COMMENT USED TO CLAIM the browser answers that null by BLOCKING the vote, "because
  // `vote-service.ts` `loadTarget` reaches the parent through the same RLS with an INNER join and
  // therefore 404s on this row". BOTH HALVES ARE NOW FALSE, and leaving them here would teach the
  // exact model this branch removed: `loadTarget` no longer touches `challenges` at all (it gates
  // on `weekClosedSql(solutions.week, …)`), so an invisible parent cannot 404 a vote; and
  // `solutionState` reads `cycleClosed`, never `challengeStatus`, so it cannot block on this field
  // either. What `challengeStatus` still answers is "may I file a NEW solution against this
  // challenge" — a different question, and one this row genuinely cannot answer.
  expect((byId.get(SOL_MID) as { challengeStatus: string | null }).challengeStatus).toBeNull();

  // …and the row still carries its own status, which is NOT a substitute for the parent's: this is
  // exactly the pair a caller must not conflate.
  expect((byId.get(SOL_MID) as { status: string }).status).toBe('voting');
  expect((byId.get(SOL_MID) as { challengeId: string }).challengeId).toBe(CH_B);

  // ⛔ AND THE VOTE GATE IS UNMOVED BY THE INVISIBILITY — the property this file's join rewrite has
  // to preserve, and the one the retired comment got backwards. All three rows compete in the same
  // week, so `cycleClosed` must be the SAME boolean on the hidden-parent row as on a visible one:
  // it is computed from `marketplace_cycles` (global, non-RLS) keyed on the SOLUTION's own week, so
  // nothing on the challenges side of this query can reach it.
  const mid = byId.get(SOL_MID) as { cycleClosed: boolean };
  const low = byId.get(SOL_LOW) as { cycleClosed: boolean };
  expect(typeof mid.cycleClosed).toBe('boolean');
  expect(mid.cycleClosed).toBe(low.cycleClosed);
});
