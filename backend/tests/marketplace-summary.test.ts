// tests/marketplace-summary.test.ts — Home dashboard aggregate + weekly winner.
// Asserts real counts (active challenges, solutions-in-voting, distinct builders,
// live-in-production), trending order, the caller's own activity, and the winner
// payload (winning solution + honorable mentions ranks 2–4 + week stats).
import { cyclePeriodCols, ensureTenants } from './helpers/cycle-period';
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerMarketplaceSummaryRoutes } from '../src/routes/marketplace-summary';
// The solutions board is driven for real (not stubbed) by the last test in this file: the
// contract it pins is that home's "being judged now" figure equals the number of rows THAT
// route renders with a live vote pill, and only the route itself can answer that.
import { registerSolutionRoutes } from '../src/routes/solutions';
// The route's arm-2 comparator is `weekString(new Date())`. One test below derives a genuinely
// future week from the SAME function rather than hardcoding a label — see the note above it.
import { weekString } from '../src/host/iso-week';
import { db, tenants, users, challenges, solutions, votes, weeklyWinners, pipelineItems, marketplaceCycles } from '../src/db/client';
import { runWithContext } from '../src/db/tenant-context';
import * as schema from '../src/db/schema';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c400001';
// tenantId matches the tenant every fixture below is stamped with: /api/winner now scopes the
// weekly_winners read by the CLAIM as well as by RLS, so a claim-less test identity would (correctly)
// see no artifact at all.
const user: User = { id: UID, email: 'sumtest@test', name: 'Sue Mary', roles: ['employee'], tenantId: UID };
const MARK = 'ZSUMTEST';
const WEEK = '2096-W49';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerMarketplaceSummaryRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const res = await matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// Two regressions below can only be reproduced under REAL RLS — a stale winner row whose solution
// belongs to another tenant (weekly_winners.solution_id is a hard FK with ON DELETE CASCADE, so it
// can never dangle: the only way it "does not resolve" is that RLS hides it), and the tenant-scoped
// live-in-production count. The default test connection is the OWNER, which bypasses RLS.
//
// We get RLS by `SET ROLE cp_app` on an ordinary connection rather than by connecting AS cp_app:
// RLS is skipped only for the table owner and for BYPASSRLS roles, and SET ROLE changes current_user
// — so the policies apply exactly as they do in prod. Deliberately NOT `ALTER ROLE cp_app WITH LOGIN
// PASSWORD …` (what rls-isolation/rls-runtime do): that is cluster-global, survives the test run, and
// hands a LOGIN + a hardcoded password to the one role whose entire job is to enforce RLS. Harmless
// on CI's ephemeral Postgres, not harmless on a developer machine.
async function callAsTenant(method: string, path: string, tenantId: string, claim: User = user) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const conn = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const restore = () => asUser(user);
  try {
    await conn.unsafe("select set_config('app.current_tenant', $1, false)", [tenantId]);
    await conn.unsafe('SET ROLE cp_app');
    // The route derives its explicit tenant predicate from the CLAIM while Postgres derives RLS from
    // the GUC; prod keeps them in step (the server wrapper sets the GUC from the same claim), so the
    // fixture must too — a test where they disagree would pass for the wrong reason.
    asUser({ ...claim, tenantId });
    const res = await runWithContext({ tenantId, boundDb: drizzle(conn as never, { schema }) }, () =>
      matched.handler(new Request(`http://localhost${path}`, { method }), ...matched.params),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } finally {
    restore();
    await conn.end({ timeout: 5 });
  }
}

async function cleanup() {
  await db.delete(pipelineItems).where(like(pipelineItems.title, `${MARK}%`));
  await db.delete(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  const chIds = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  const solIds = chIds.length ? (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map((r) => r.id) : [];
  if (chIds.length) await db.delete(votes).where(inArray(votes.target_id, chIds));
  if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
  if (chIds.length) await db.delete(challenges).where(inArray(challenges.id, chIds));
  await db.delete(users).where(eq(users.id, UID));
}

let hostChallenge = '';
let winningSolution = '';

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'SM' }).onConflictDoNothing();
  // One submitted challenge by the caller, voted on, with three solutions.
  const [c] = await db.insert(challenges).values({ title: `${MARK} home host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID, status: 'solution_phase', votes_count: 500 }).returning();
  hostChallenge = c!.id;
  await db.insert(votes).values({ user_id: UID, target_type: 'challenge', target_id: hostChallenge, tenant_id: UID });
  // ⚠️ `week: WEEK` on every fixture solution is LOAD-BEARING, not tidiness. Honorable mentions
  // are now scoped to the winner's week (the same predicate `closeCycle` selects the winner
  // with), and `solutions.week` is `text NOT NULL DEFAULT ''` — so an unstamped fixture is a row
  // in the empty-string week, which is not the winner's week and correctly earns no mention.
  // These fixtures carried no week at all, which is exactly the shape of the prod data that made
  // the bug invisible.
  const sols = await db
    .insert(solutions)
    .values([
      { challenge_id: hostChallenge, title: `${MARK} win`, author_id: UID, status: 'shipping', votes_count: 300, blocks_used: ['a'], tenant_id: UID, week: WEEK },
      { challenge_id: hostChallenge, title: `${MARK} second`, author_id: UID, status: 'voting', votes_count: 200, blocks_used: ['b'], tenant_id: UID, week: WEEK },
      { challenge_id: hostChallenge, title: `${MARK} third`, author_id: UID, status: 'voting', votes_count: 100, blocks_used: ['c'], tenant_id: UID, week: WEEK },
    ])
    .returning();
  winningSolution = sols[0]!.id;
  await db.insert(weeklyWinners).values({ week: WEEK, solution_id: winningSolution, challenge_id: hostChallenge, stats: { totalVotesCast: 1207, solutionsSubmitted: 17 }, tenant_id: UID });
  // A live production card for the caller's OWN solution. liveInProduction is now tenant-scoped, so
  // the "at least 1" assertion below needs a card this caller can actually claim — the 9 seeded demo
  // cards belong to the demo tenant, not to this test identity, and counting them here was the leak.
  await db.insert(pipelineItems).values({ solution_id: winningSolution, title: `${MARK} live card`, author_id: UID, stage: 'production', live: true, rollout_pct: 100 });
  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

test('home summary returns real stats + trending + your activity', async () => {
  const r = await call('GET', '/api/home/summary');
  expect(r.status).toBe(200);
  // Counts are SUM over seed + these test rows — assert "at least" to stay robust
  // against the seeded marketplace data.
  expect(r.json.stats.activeChallenges).toBeGreaterThanOrEqual(1);
  expect(r.json.stats.solutionsInVoting).toBeGreaterThanOrEqual(2);
  expect(r.json.stats.liveInProduction).toBeGreaterThanOrEqual(1);
  expect(r.json.stats.activeBuilders).toBeGreaterThanOrEqual(1);

  // The 500-vote host challenge should top trending; rank starts at 1.
  expect(r.json.trending[0].rank).toBe(1);
  expect(r.json.trending[0].votesCount).toBeGreaterThanOrEqual(500);

  // Your activity: the caller submitted + voted on the host challenge.
  expect(r.json.yourActivity.submitted.some((c: { id: string }) => c.id === hostChallenge)).toBe(true);
  expect(r.json.yourActivity.votedOn.some((c: { id: string }) => c.id === hostChallenge)).toBe(true);
});

// ---------------------------------------------------------------------------
// "You voted on (n)" — n was `votedOn.length`, i.e. the LIMIT, i.e. 8 forever.
//
// Two failure modes, and this fixture is built to red on BOTH:
//   * The shipped bug — n = the page size. Reds on `votedOnTotal === 11` because the payload
//     has no total at all / because a total derived from the slice is 8.
//   * The tempting "fix" — `count(*) from votes where user_id = … and target_type =
//     'challenge'`. `votes.target_id` has NO FK (schema.ts: loose UUID pointing at challenges
//     OR solutions), so deleting a challenge leaves its vote row behind. The 12th challenge
//     below is deleted for exactly that reason: a bare count says 12, the joined count says 11,
//     and 11 is the number of rows the list could ever show.
// A dedicated voter identity keeps the arithmetic EXACT — the shared `user` fixture already
// carries a vote from beforeAll, and "at least" assertions cannot distinguish 8 from 11.
// ---------------------------------------------------------------------------
test('your-activity totals are real counts, and the vote total ignores orphaned votes', async () => {
  const VOTER = '00000000-0000-0000-0000-00000c400002';
  const voter: User = { id: VOTER, email: 'orphan@test', name: 'Ora Phan', roles: ['employee'], tenantId: VOTER };
  await db.insert(users).values({ id: VOTER, email: voter.email, name: voter.name, avatar_initials: 'OP' }).onConflictDoNothing();
  try {
    const rows = await db
      .insert(challenges)
      .values(
        Array.from({ length: 12 }, (_, i) => ({
          title: `${MARK} orphan ${String(i).padStart(2, '0')}`,
          work_area: 'Claims',
          submitter_id: VOTER,
          tenant_id: VOTER,
          status: 'voting' as const,
          votes_count: 1,
        })),
      )
      .returning();
    expect(rows).toHaveLength(12);
    await db.insert(votes).values(rows.map((c) => ({ user_id: VOTER, target_type: 'challenge' as const, target_id: c.id, tenant_id: VOTER })));
    // The orphan: the challenge goes, the vote row stays (no FK, no cascade, no trigger).
    await db.delete(challenges).where(eq(challenges.id, rows[11]!.id));
    const orphans = await db.select({ id: votes.id }).from(votes).where(eq(votes.target_id, rows[11]!.id));
    expect(orphans, 'the vote row was cascaded away, so this test no longer tests anything').toHaveLength(1);

    asUser(voter);
    const r = await call('GET', '/api/home/summary');
    expect(r.status).toBe(200);
    // The list is still one page …
    expect(r.json.yourActivity.votedOn).toHaveLength(8);
    expect(r.json.yourActivity.submitted).toHaveLength(5);
    // … and the totals are the real, joined counts. NOT 8 (the page size), NOT 12 (the orphan).
    expect(r.json.yourActivity.votedOnTotal).toBe(11);
    expect(r.json.yourActivity.submittedTotal).toBe(11);
  } finally {
    asUser(user);
    await db.delete(votes).where(eq(votes.user_id, VOTER));
    await db.delete(challenges).where(eq(challenges.submitter_id, VOTER));
    await db.delete(users).where(eq(users.id, VOTER));
  }
}, 30_000);

// ---------------------------------------------------------------------------
// THE TWO EDGES of the LIMIT-8 votedOn slice, pinned as literal numbers.
//
// ⛔ WHY THIS EXISTS. The totals are computed with `count(*) over ()` folded into the two
// existing LIMITed queries (marketplace-summary.ts) rather than by two extra round-trips.
// /api/home/summary runs on a RESERVED connection held for the whole request (db/client.ts
// withTenantDb) out of a pool of DB_POOL_MAX=6, and CP has had two production pool
// exhaustions — so two free statements on the landing route are worth removing. The window is
// evaluated after WHERE/JOIN and before LIMIT, which is what makes it equivalent to the
// separate joined count, anti-orphan innerJoin semantics included.
//
// ⛔ THE TRAP THAT MAKES THIS A TEST AND NOT A COMMENT. With ZERO matching rows the query
// returns NO ROWS AT ALL, so there is no window value to read and the total must default to 0.
// Read it off `rows[0]` without a default and the route ships `undefined` — which serialises
// as a MISSING KEY, i.e. exactly the stale-payload shape the frontend now has to defend
// against (frontend/src/routes/home-page.stale-payload.render.test.ts). N=0 below is that
// assertion and nothing else.
//
// N=8 is the other edge: exactly at the LIMIT, where `total > list.length` must stay FALSE so
// Home does not render "Showing 8 of 8". The full measured table this preserves:
//   N=0 → 0, 0, false   N=1 → 1, 1, false   N=7 → 7, 7, false
//   N=8 → 8, 8, false   N=9 → 8, 9, true
// (N=9's "true" side is covered by the orphan test above, which lands on 8 of 11.)
// ---------------------------------------------------------------------------
async function activityTotalsFor(n: number, uid: string) {
  const ident: User = { id: uid, email: `edge${n}@test`, name: `Edge ${n}`, roles: ['employee'], tenantId: uid };
  await db.insert(users).values({ id: uid, email: ident.email, name: ident.name, avatar_initials: 'ED' }).onConflictDoNothing();
  if (n > 0) {
    const rows = await db
      .insert(challenges)
      .values(
        Array.from({ length: n }, (_, i) => ({
          title: `${MARK} edge ${String(i).padStart(2, '0')}`,
          work_area: 'Claims',
          submitter_id: uid,
          tenant_id: uid,
          status: 'voting' as const,
          votes_count: 1,
        })),
      )
      .returning();
    expect(rows).toHaveLength(n);
    await db.insert(votes).values(rows.map((c) => ({ user_id: uid, target_type: 'challenge' as const, target_id: c.id, tenant_id: uid })));
  }
  asUser(ident);
  const r = await call('GET', '/api/home/summary');
  expect(r.status).toBe(200);
  return r.json.yourActivity as {
    votedOn: unknown[];
    votedOnTotal: number;
    submitted: unknown[];
    submittedTotal: number;
  };
}

async function cleanupEdge(uid: string) {
  asUser(user);
  await db.delete(votes).where(eq(votes.user_id, uid));
  await db.delete(challenges).where(eq(challenges.submitter_id, uid));
  await db.delete(users).where(eq(users.id, uid));
}

test('activity totals at N=0 — an empty window yields 0, never undefined', async () => {
  const UID0 = '00000000-0000-0000-0000-00000c400003';
  try {
    const a = await activityTotalsFor(0, UID0);
    expect(a.votedOn).toHaveLength(0);
    expect(a.submitted).toHaveLength(0);
    // `toBe(0)` is NOT enough on its own — `undefined` would also be falsy in the route's own
    // arithmetic — so the key's PRESENCE is asserted separately. A dropped key is the exact
    // failure the zero-row window produces.
    expect(Object.keys(a)).toContain('votedOnTotal');
    expect(Object.keys(a)).toContain('submittedTotal');
    expect(a.votedOnTotal).toBe(0);
    expect(a.submittedTotal).toBe(0);
    // The truncation hint's predicate, as Home evaluates it.
    expect(a.votedOnTotal > a.votedOn.length).toBe(false);
  } finally {
    await cleanupEdge(UID0);
  }
}, 30_000);

test('activity totals at N=8 — exactly at the LIMIT, the total equals the slice and the hint stays silent', async () => {
  const UID8 = '00000000-0000-0000-0000-00000c400004';
  try {
    const a = await activityTotalsFor(8, UID8);
    expect(a.votedOn).toHaveLength(8);
    expect(a.votedOnTotal).toBe(8);
    // ⛔ The whole point of the edge: 8 of 8 must NOT read as truncated.
    expect(a.votedOnTotal > a.votedOn.length).toBe(false);
    // The submitted slice is LIMIT 5, so the same 8 rows DO truncate on that side — which is
    // what proves the total is a real count and not the slice length echoed back.
    expect(a.submitted).toHaveLength(5);
    expect(a.submittedTotal).toBe(8);
    expect(a.submittedTotal > a.submitted.length).toBe(true);
  } finally {
    await cleanupEdge(UID8);
  }
}, 30_000);

test('winner returns the winning solution + honorable mentions + stats', async () => {
  const r = await call('GET', '/api/winner');
  expect(r.status).toBe(200);
  // The most-recent winner is ours (announced_at default now()).
  expect(r.json.week).toBe(WEEK);
  expect(r.json.winner.solution.title).toBe(`${MARK} win`);
  expect(r.json.winner.challenge.id).toBe(hostChallenge);
  expect(r.json.stats.totalVotesCast).toBe(1207);
  // Honorable mentions = the other two solutions, ranks 2 and 3.
  expect(r.json.honorableMentions).toHaveLength(2);
  expect(r.json.honorableMentions[0].rank).toBe(2);
  expect(r.json.honorableMentions[0].title).toBe(`${MARK} second`);
});

test('winner returns 200 with a null winner when none exists anywhere', async () => {
  // "No winner yet" is a valid empty state, not a 404 — the /winner page renders an
  // empty notice and must not log a console error. The endpoint derives a winner from
  // weekly_winners, else the live production pipeline, else a shipping solution — so the
  // truly-empty case requires neutralising ALL three sources. Snapshot + restore.
  const winnersAll = await db.select().from(weeklyWinners);
  const liveCards = await db.select().from(pipelineItems).where(eq(pipelineItems.live, true));
  const shippingSols = await db.select().from(solutions).where(eq(solutions.status, 'shipping'));
  await db.delete(weeklyWinners);
  if (liveCards.length) await db.update(pipelineItems).set({ live: false }).where(eq(pipelineItems.live, true));
  if (shippingSols.length)
    await db.update(solutions).set({ status: 'voting' }).where(eq(solutions.status, 'shipping'));
  try {
    const r = await call('GET', '/api/winner');
    expect(r.status).toBe(200);
    expect(r.json.winner).toBeNull();
    expect(r.json.week).toBeNull();
    expect(r.json.honorableMentions).toEqual([]);
  } finally {
    if (winnersAll.length) await db.insert(weeklyWinners).values(winnersAll);
    for (const c of liveCards) await db.update(pipelineItems).set({ live: true }).where(eq(pipelineItems.id, c.id));
    for (const s of shippingSols) await db.update(solutions).set({ status: 'shipping' }).where(eq(solutions.id, s.id));
  }
}, 30_000);

test('the winner artifact read is scoped by the caller tenant, not just by RLS', async () => {
  // RLS already scopes this read in prod, but the query carried no predicate of its own, so under
  // any connection that bypasses RLS (the owner — migrations, runAsSystem, every dev/test path) the
  // "latest weekly_winners row" was the latest row ON THE PLATFORM. Picking up a foreign row here
  // does not merely show a spare row: it SUPPRESSES the caller's own winner, which is exactly the
  // shape of the bug that blanked the page. Newer foreign row, owner connection, still ours.
  const OTHER = '00000000-0000-0000-0000-00000c40d001';
  const [chX] = await db.insert(challenges).values({ title: `${MARK} other host`, work_area: 'Claims', submitter_id: UID, tenant_id: OTHER }).returning();
  const [solX] = await db.insert(solutions).values({ challenge_id: chX!.id, title: `${MARK} other win`, author_id: UID, status: 'shipping', votes_count: 999, blocks_used: [], tenant_id: OTHER }).returning();
  await db.insert(weeklyWinners).values({ week: '2096-W47', tenant_id: OTHER, solution_id: solX!.id, challenge_id: chX!.id, announced_at: new Date(Date.now() + 60_000) });
  try {
    const r = await call('GET', '/api/winner');
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(WEEK);
    expect(r.json.winner.solution.title).toBe(`${MARK} win`);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, '2096-W47'));
    await db.delete(solutions).where(eq(solutions.id, solX!.id));
    await db.delete(challenges).where(eq(challenges.id, chX!.id));
  }
});

test('liveInProduction counts only the CALLER tenant\'s live cards, not the platform total', async () => {
  // pipeline_items is deliberately outside RLS (0028: the Operate pipeline is a super_admin
  // cross-tenant surface), so counting it directly put the platform-wide number on every tenant's
  // home dashboard. The per-tenant cycle close made it worse — one card per tenant per week instead
  // of one per week — so the leak now grows N× faster. Two tenants, one live card each.
  const T = '00000000-0000-0000-0000-00000c40e001';
  const O = '00000000-0000-0000-0000-00000c40e002';
  const AUTH_T = '00000000-0000-0000-0000-00000c40e0a1';
  const AUTH_O = '00000000-0000-0000-0000-00000c40e0a2';
  // users.tenant_id carries a real FK, so the two orgs have to exist.
  await db.insert(tenants).values([
    { id: T, name: 'Live T Org', slug: 'zsumtest-live-t' },
    { id: O, name: 'Live O Org', slug: 'zsumtest-live-o' },
  ]);
  await db.insert(users).values([
    { id: AUTH_T, email: 'live-t@test', name: 'Live T', tenant_id: T },
    { id: AUTH_O, email: 'live-o@test', name: 'Live O', tenant_id: O },
  ]);
  const [chT] = await db.insert(challenges).values({ title: `${MARK} live host T`, work_area: 'Claims', submitter_id: AUTH_T, tenant_id: T }).returning();
  const [chO] = await db.insert(challenges).values({ title: `${MARK} live host O`, work_area: 'Claims', submitter_id: AUTH_O, tenant_id: O }).returning();
  const [solT] = await db.insert(solutions).values({ challenge_id: chT!.id, title: `${MARK} live sol T`, author_id: AUTH_T, blocks_used: [], tenant_id: T }).returning();
  const [solO] = await db.insert(solutions).values({ challenge_id: chO!.id, title: `${MARK} live sol O`, author_id: AUTH_O, blocks_used: [], tenant_id: O }).returning();
  // Both attribution paths, for both tenants: a solution-linked card (RLS decides) and an
  // Operate-style card with no solution (the author's home tenant decides).
  const cards = await db
    .insert(pipelineItems)
    .values([
      { solution_id: solT!.id, title: `${MARK} card T linked`, author_id: AUTH_T, stage: 'production', live: true },
      { solution_id: solO!.id, title: `${MARK} card O linked`, author_id: AUTH_O, stage: 'production', live: true },
      { solution_id: null, title: `${MARK} card T loose`, author_id: AUTH_T, stage: 'production', live: true },
      { solution_id: null, title: `${MARK} card O loose`, author_id: AUTH_O, stage: 'production', live: true },
    ])
    .returning();
  try {
    const r = await callAsTenant('GET', '/api/home/summary', T);
    expect(r.status).toBe(200);
    // Exactly its own two. Unscoped this was every live card in the database — O's, the caller's
    // own from beforeAll, and all 9 seeded demo cards.
    expect(r.json.stats.liveInProduction).toBe(2);
  } finally {
    await db.delete(pipelineItems).where(inArray(pipelineItems.id, cards.map((c) => c.id)));
    await db.delete(solutions).where(inArray(solutions.id, [solT!.id, solO!.id]));
    await db.delete(challenges).where(inArray(challenges.id, [chT!.id, chO!.id]));
    await db.delete(users).where(inArray(users.id, [AUTH_T, AUTH_O]));
    await db.delete(tenants).where(inArray(tenants.id, [T, O]));
  }
}, 30_000);

test('winner falls THROUGH a stale cross-tenant weekly_winners row instead of blanking the page', async () => {
  // The live defect this guards: the Demo tenant owned a 2026-W21 weekly_winners row whose
  // solution belonged to ANOTHER tenant, announced LATER than its real W23 row. It therefore won
  // the desc(announced_at) sort, resolved to nothing under the caller's RLS, and — because the
  // old code only consulted the fallback when the row was ABSENT — the endpoint returned
  // winner: null. A real winner existed and the marquee page rendered its empty state anyway.
  const T = '00000000-0000-0000-0000-00000c40f001'; // the caller's tenant
  const O = '00000000-0000-0000-0000-00000c40f002'; // the tenant that really owns the solution
  const STALE_WEEK = '2096-W48';
  const [chT] = await db.insert(challenges).values({ title: `${MARK} stale host T`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  const [chO] = await db.insert(challenges).values({ title: `${MARK} stale host O`, work_area: 'Claims', submitter_id: UID, tenant_id: O }).returning();
  const FALLBACK_WEEK = '2096-W46';
  const [solT] = await db.insert(solutions).values({ challenge_id: chT!.id, title: `${MARK} stale real winner`, author_id: UID, status: 'shipping', votes_count: 42, blocks_used: [], tenant_id: T, week: FALLBACK_WEEK }).returning();
  const [solO] = await db.insert(solutions).values({ challenge_id: chO!.id, title: `${MARK} stale other tenant`, author_id: UID, status: 'voting', votes_count: 1, blocks_used: [], tenant_id: O }).returning();
  // T's ONLY winner row — and it points at O's solution.
  await db.insert(weeklyWinners).values({ week: STALE_WEEK, tenant_id: T, solution_id: solO!.id, challenge_id: chO!.id, announced_at: new Date() });

  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    // Fell through to T's own shipping solution rather than returning null.
    expect(r.json.winner).not.toBeNull();
    expect(r.json.winner.solution.id).toBe(solT!.id);
    // The unusable row's week is dropped with it — it described a winner we are not showing.
    expect(r.json.week).not.toBe(STALE_WEEK);
    // …and the week the page announces is the DERIVED winner's OWN week. Before, the fallback
    // paths left `week` null, so the eyebrow rendered "COMMON PRACTICE ·" with nothing after
    // the separator, and (worse) the mentions predicate had no week to scope itself by.
    expect(r.json.week).toBe(FALLBACK_WEEK);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, STALE_WEEK));
    await db.delete(solutions).where(inArray(solutions.id, [solT!.id, solO!.id]));
    await db.delete(challenges).where(inArray(challenges.id, [chT!.id, chO!.id]));
  }
}, 30_000);

test('winner announces the LATEST WEEK, not the most recently re-announced one', async () => {
  // ⛔ THE DEFECT. `/api/winner` picked the artifact with `orderBy(desc(announced_at))`, and
  // `closeCycle`'s onConflictDoUpdate re-stamps `announced_at: new Date()` on every re-close
  // (host/cycle-service.ts). So one `POST /api/cycle/advance {"week":"<old>","to":"closed",
  // "force":true}` pinned that OLD week to the top of the sort FOREVER: the marquee announced its
  // winner, its stats and its honourable mentions — internally consistent and wrong — while the
  // real, later week's winner became invisible. Reproduced here as the state that call leaves
  // behind: W23 closed normally, W21 re-closed a minute later.
  //
  // ISO week labels are fixed-width and zero-padded, so `desc(week)` IS chronological — the same
  // property `laterWeek` (host/iso-week.ts) and `backfillMissedCycles` already rely on.
  const T = '00000000-0000-0000-0000-00000c40f003';
  const OLD_WEEK = '2026-W21';
  const NEW_WEEK = '2026-W23';
  const [ch] = await db.insert(challenges).values({ title: `${MARK} reclose host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  const [solOld] = await db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK} reclose old winner`, author_id: UID, status: 'shipping', votes_count: 5, blocks_used: [], tenant_id: T, week: OLD_WEEK }).returning();
  const [solNew] = await db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK} reclose real winner`, author_id: UID, status: 'shipping', votes_count: 9, blocks_used: [], tenant_id: T, week: NEW_WEEK }).returning();
  // The real close, then the forced re-close of the older week one minute later.
  await db.insert(weeklyWinners).values({ week: NEW_WEEK, tenant_id: T, solution_id: solNew!.id, challenge_id: ch!.id, stats: { solutionsSubmitted: 2, totalVotesCast: 9 }, announced_at: new Date(Date.UTC(2026, 5, 1, 3, 0, 0)) });
  await db.insert(weeklyWinners).values({ week: OLD_WEEK, tenant_id: T, solution_id: solOld!.id, challenge_id: ch!.id, stats: { solutionsSubmitted: 1, totalVotesCast: 5 }, announced_at: new Date(Date.UTC(2026, 5, 1, 3, 1, 0)) });

  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(NEW_WEEK);
    expect(r.json.winner.solution.id).toBe(solNew!.id);
    // The stats and the eyebrow describe ONE week — the page must not narrate W23 with W21's numbers.
    expect(r.json.stats.totalVotesCast).toBe(9);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.tenant_id, T));
    await db.delete(solutions).where(inArray(solutions.id, [solOld!.id, solNew!.id]));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test('winner falls back to a shipping solution when no weekly_winners row exists', async () => {
  // Defensive A1 fallback: a tenant can have a winner shipping in the pipeline with no
  // weekly_winners artifact — the marquee page must not go blank. Clear winners + live
  // cards (so the shipping-solution branch is exercised) while OUR `${MARK} win` shipping
  // solution remains, then assert a winner is derived. Snapshot + restore.
  const winnersAll = await db.select().from(weeklyWinners);
  const liveCards = await db.select().from(pipelineItems).where(eq(pipelineItems.live, true));
  await db.delete(weeklyWinners);
  if (liveCards.length) await db.update(pipelineItems).set({ live: false }).where(eq(pipelineItems.live, true));
  try {
    const r = await call('GET', '/api/winner');
    expect(r.status).toBe(200);
    expect(r.json.winner).not.toBeNull();
    expect(r.json.winner.solution.id).toBeTruthy();
  } finally {
    if (winnersAll.length) await db.insert(weeklyWinners).values(winnersAll);
    for (const c of liveCards) await db.update(pipelineItems).set({ live: true }).where(eq(pipelineItems.id, c.id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-1a — the honourable-mentions predicate IS the winner-selection predicate.
//
// ⛔ THE DEFECT, measured against real prod rows. `closeCycle` picks the winner from
// `(week, tenant, status ∈ {voting,shipping})` ordered `votes desc, created_at asc, id asc`.
// The mentions query carried NONE of that — it ranked every solution ever submitted to the
// winning challenge, by votes alone. On 2026-W32 that printed:
//     #2 Streaming summarizer with OCR fallback  316 ▲   ← week 2026-W23
//     #3 Inline review queue for associates      271 ▲   ← week 2026-W23
//     #4 Multi-template field extractor          234 ▲   ← week 2026-W23
// beneath a 0-vote 2026-W32 winner, as its runners-up. They had never competed against it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('honorable mentions are scoped to the winner’s WEEK — a higher-voted other-week row is not a runner-up', async () => {
  // The prod row, in miniature: same challenge, far more votes, an eligible status — and a
  // different week. Under the old predicate it was mention #2 on sheer vote count.
  const [cross] = await db
    .insert(solutions)
    .values({ challenge_id: hostChallenge, title: `${MARK} other week 316`, author_id: UID, status: 'voting', votes_count: 316, blocks_used: [], tenant_id: UID, week: '2096-W23' })
    .returning();
  try {
    const r = await call('GET', '/api/winner');
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(WEEK);
    const titles = r.json.honorableMentions.map((mn: { title: string }) => mn.title);
    // A POSITIVE proof, not an absence: the two same-week runners-up are still there, in order.
    expect(titles).toEqual([`${MARK} second`, `${MARK} third`]);
    expect(titles).not.toContain(`${MARK} other week 316`);
    // …and no mention outranks the winner, which is what made the old page incoherent.
    for (const mn of r.json.honorableMentions) {
      expect(mn.votesCount).toBeLessThanOrEqual(r.json.winner.solution.votesCount);
    }
  } finally {
    await db.delete(solutions).where(eq(solutions.id, cross!.id));
  }
});

test('honorable mentions are scoped to the COMPETING statuses — an archived/draft row never ranks', async () => {
  // Neither can win: `draft` has not entered the vote, `archived` has left it. A page that
  // shows them as runners-up is claiming they were in a race they were not in.
  const extra = await db
    .insert(solutions)
    .values([
      { challenge_id: hostChallenge, title: `${MARK} archived 888`, author_id: UID, status: 'archived', votes_count: 888, blocks_used: [], tenant_id: UID, week: WEEK },
      { challenge_id: hostChallenge, title: `${MARK} draft 777`, author_id: UID, status: 'draft', votes_count: 777, blocks_used: [], tenant_id: UID, week: WEEK },
    ])
    .returning();
  try {
    const r = await call('GET', '/api/winner');
    const titles = r.json.honorableMentions.map((mn: { title: string }) => mn.title);
    expect(titles).toEqual([`${MARK} second`, `${MARK} third`]);
    expect(titles).not.toContain(`${MARK} archived 888`);
    expect(titles).not.toContain(`${MARK} draft 777`);
  } finally {
    await db.delete(solutions).where(inArray(solutions.id, extra.map((s) => s.id)));
  }
});

test('mentions rank by the SHARED WINNER_ORDER — a vote tie is broken by created_at, then id', async () => {
  // Two rows tied on votes. The order is decided by `asc(created_at)`, and they are INSERTED in
  // the reverse of that order so the physical/insertion order disagrees with the correct answer:
  // a call site that ranks by `desc(votes_count)` alone has nothing left to break the tie with.
  // (The structural drift guard for this lives in tests/cycle-eligibility.test.ts — it is the
  // instrument that reds deterministically when ONE call site re-spells the ordering.)
  const t0 = new Date('2030-01-01T00:00:00Z');
  const later = await db
    .insert(solutions)
    .values({ challenge_id: hostChallenge, title: `${MARK} tie later`, author_id: UID, status: 'voting', votes_count: 250, blocks_used: [], tenant_id: UID, week: WEEK, created_at: new Date(t0.getTime() + 60_000) })
    .returning();
  const earlier = await db
    .insert(solutions)
    .values({ challenge_id: hostChallenge, title: `${MARK} tie earlier`, author_id: UID, status: 'voting', votes_count: 250, blocks_used: [], tenant_id: UID, week: WEEK, created_at: t0 })
    .returning();
  try {
    const r = await call('GET', '/api/winner');
    const titles = r.json.honorableMentions.map((mn: { title: string }) => mn.title);
    // 250 > 250 > 200 → the two tied rows take ranks 2 and 3, earliest first.
    expect(titles).toEqual([`${MARK} tie earlier`, `${MARK} tie later`, `${MARK} second`]);
  } finally {
    await db.delete(solutions).where(inArray(solutions.id, [later[0]!.id, earlier[0]!.id]));
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-7 — the mentions candidate set is the WEEK's, not the winning CHALLENGE's.
//
// ⛔ THE SECOND HALF OF THE SAME DEFECT. WS-1a (above) gave the mentions query the week, the
// status and the tie-break — but left `eq(solutions.challenge_id, sol.challenge_id)` in place
// and then claimed, in the comment, that the result was "the SAME candidate set … `closeCycle`
// picked rank 1 from". `closeCycle` carries NO challenge predicate (cycle-service.ts: `select …
// where eligibleForWeek(week, tenant_id) order by WINNER_ORDER limit 1`), so rank 1 was the top
// solution of the whole WEEK while ranks 2–4 were drawn only from the winner's own challenge.
// Two consequences, both visible on the page:
//   • a week whose winning challenge had exactly one solution showed a winner with ZERO
//     runners-up while other people genuinely competed that week;
//   • the week's actual #2 was INVISIBLE if it answered a different challenge.
// The shipped copy already said what the right answer is — `winner_mentions_empty` reads "No
// other solutions this week." in all 8 locales, never "…to this challenge" — so the query was
// contradicting the sentence rendered directly above it.
//
// The fixture is the discriminating one: ONE week, ONE tenant, TWO challenges.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('honorable mentions span the WEEK, not just the winning challenge — the week’s #2 on another challenge ranks', async () => {
  const XT = '00000000-0000-0000-0000-00000c40a001'; // the caller's tenant
  const XO = '00000000-0000-0000-0000-00000c40a002'; // a second tenant competing the same week
  const XWEEK = '2096-W43';
  const OTHERWEEK = '2096-W42';
  // Deliberately NOT a '2099-W..' week: cycle.test.ts / votes.test.ts own that namespace and
  // delete by week, and every file shares one database (sequentially — corrected 2026-08-16, they
  // are not run concurrently; a `delete by week` in a file that runs AFTER this one is just as
  // fatal to rows this one left behind). This file's `ZSUMTEST-W9x` weeks are its own (see
  // MARK/WEEK at the top).
  const [chA] = await db.insert(challenges).values({ title: `${MARK} xch host A`, work_area: 'Claims', submitter_id: UID, tenant_id: XT, week: XWEEK }).returning();
  const [chB] = await db.insert(challenges).values({ title: `${MARK} xch host B`, work_area: 'Service', submitter_id: UID, tenant_id: XT, week: XWEEK }).returning();
  const [chO] = await db.insert(challenges).values({ title: `${MARK} xch host O`, work_area: 'Legal', submitter_id: UID, tenant_id: XO, week: XWEEK }).returning();
  const rows = await db
    .insert(solutions)
    .values([
      // rank 1 — challenge A. This is what `closeCycle` would have crowned: the top eligible
      // solution of (XWEEK, XT), across challenges.
      { challenge_id: chA!.id, title: `${MARK} xch winner A 50`, author_id: UID, status: 'shipping', votes_count: 50, blocks_used: [], tenant_id: XT, week: XWEEK },
      // rank 2 — challenge B. THE ROW THIS TEST EXISTS FOR. It placed second in the WEEK and was
      // invisible on the winner page purely because it answered a different challenge.
      { challenge_id: chB!.id, title: `${MARK} xch second B 40`, author_id: UID, status: 'voting', votes_count: 40, blocks_used: [], tenant_id: XT, week: XWEEK },
      // rank 3 — challenge A again, so the assertion below proves an ORDERING across challenges
      // and not merely "challenge B is now included".
      { challenge_id: chA!.id, title: `${MARK} xch third A 10`, author_id: UID, status: 'voting', votes_count: 10, blocks_used: [], tenant_id: XT, week: XWEEK },
      // ⛔ WS-1a MUST NOT REGRESS. A different week, another challenge, far more votes — exactly
      // the 316-vote shape that printed W23 rows under a W32 winner. Widening the candidate set
      // to the week must not widen it to every week.
      { challenge_id: chB!.id, title: `${MARK} xch otherweek B 999`, author_id: UID, status: 'voting', votes_count: 999, blocks_used: [], tenant_id: XT, week: OTHERWEEK },
      // …nor to every status: an archived row on challenge B never entered this race either.
      { challenge_id: chB!.id, title: `${MARK} xch archived B 888`, author_id: UID, status: 'archived', votes_count: 888, blocks_used: [], tenant_id: XT, week: XWEEK },
      // …nor to every tenant. Same week, another tenant, top of the platform leaderboard.
      { challenge_id: chO!.id, title: `${MARK} xch other tenant 777`, author_id: UID, status: 'voting', votes_count: 777, blocks_used: [], tenant_id: XO, week: XWEEK },
    ])
    .returning();
  const winnerId = rows[0]!.id;
  // The artifact, as the close would have written it — so the page announces a KNOWN winner and
  // the test is about the mentions predicate alone, not about which fallback picked the winner.
  await db.insert(weeklyWinners).values({ week: XWEEK, tenant_id: XT, solution_id: winnerId, challenge_id: chA!.id, stats: { totalVotesCast: 100, solutionsSubmitted: 4 } });
  try {
    const r = await callAsTenant('GET', '/api/winner', XT);
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(XWEEK);
    expect(r.json.winner.solution.id).toBe(winnerId);
    const titles = r.json.honorableMentions.map((mn: { title: string }) => mn.title);
    // A POSITIVE proof: the week's #2 (challenge B) then #3 (challenge A), in WINNER_ORDER.
    // Before the fix this was `['ZSUMTEST xch third A 10']` — the week's real runner-up gone.
    expect(titles).toEqual([`${MARK} xch second B 40`, `${MARK} xch third A 10`]);
    expect(r.json.honorableMentions[0].rank).toBe(2);
    expect(r.json.honorableMentions[1].rank).toBe(3);
    // …and the three rows that were never in this race stay out of it.
    expect(titles).not.toContain(`${MARK} xch otherweek B 999`);
    expect(titles).not.toContain(`${MARK} xch archived B 888`);
    expect(titles).not.toContain(`${MARK} xch other tenant 777`);
    // The winner is not its own runner-up (`ne(solutions.id, sol.id)`).
    expect(r.json.honorableMentions.map((mn: { id: string }) => mn.id)).not.toContain(winnerId);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, XWEEK));
    await db.delete(solutions).where(inArray(solutions.id, rows.map((s) => s.id)));
    await db.delete(challenges).where(inArray(challenges.id, [chA!.id, chB!.id, chO!.id]));
  }
}, 30_000);

test('an unknown week yields NO mentions rather than every legacy row', async () => {
  // `solutions.week` is `text NOT NULL DEFAULT ''`. If a derived winner has no week, the honest
  // answer is "we cannot name the field" — the card has an empty state for that. Issuing
  // `eq(week,'')` instead would match every pre-0047 row in the table and print them as
  // runners-up, which is fabrication dressed as a query.
  const NW = '00000000-0000-0000-0000-00000c40b001';
  const [chN] = await db.insert(challenges).values({ title: `${MARK} noweek host`, work_area: 'Claims', submitter_id: UID, tenant_id: NW }).returning();
  // Two legacy rows in the '' week, one of them the winner the fallback will derive.
  const [winN] = await db.insert(solutions).values({ challenge_id: chN!.id, title: `${MARK} noweek winner`, author_id: UID, status: 'shipping', votes_count: 9, blocks_used: [], tenant_id: NW }).returning();
  const [legacyN] = await db.insert(solutions).values({ challenge_id: chN!.id, title: `${MARK} noweek legacy`, author_id: UID, status: 'voting', votes_count: 5000, blocks_used: [], tenant_id: NW }).returning();
  try {
    const r = await callAsTenant('GET', '/api/winner', NW);
    expect(r.status).toBe(200);
    expect(r.json.winner.solution.id).toBe(winN!.id);
    expect(r.json.week).toBeNull();
    expect(r.json.honorableMentions).toEqual([]);
  } finally {
    await db.delete(solutions).where(inArray(solutions.id, [winN!.id, legacyN!.id]));
    await db.delete(challenges).where(eq(challenges.id, chN!.id));
  }
}, 30_000);

test('the week in numbers is RECOMPUTED (caller-scoped) when the winner has no stats artifact', async () => {
  // A winner derived from a shipping solution or a live pipeline card has no `weekly_winners`
  // row and therefore no stats — which is why "De week in cijfers" rendered a heading over an
  // empty list. It is recomputed from the same helper the close stamps with, under the CALLER'S
  // db (RLS), never `runAsSystem`: a cross-tenant total on a tenant's own winner page is exactly
  // the leak `liveInProduction` was fixed for.
  const T = '00000000-0000-0000-0000-00000c40c001';
  const O = '00000000-0000-0000-0000-00000c40c002';
  const SWEEK = '2096-W45';
  const [chT] = await db.insert(challenges).values({ title: `${MARK} stats host T`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  const [chO] = await db.insert(challenges).values({ title: `${MARK} stats host O`, work_area: 'Claims', submitter_id: UID, tenant_id: O }).returning();
  const mine = await db
    .insert(solutions)
    .values([
      { challenge_id: chT!.id, title: `${MARK} stats win`, author_id: UID, status: 'shipping', votes_count: 7, blocks_used: [], tenant_id: T, week: SWEEK },
      { challenge_id: chT!.id, title: `${MARK} stats two`, author_id: UID, status: 'voting', votes_count: 3, blocks_used: [], tenant_id: T, week: SWEEK },
      // A draft still counts as SUBMITTED — that is what closeCycle's aggregate counts, so it is
      // what this counts. (It is still not eligible to be a runner-up; different question.)
      { challenge_id: chT!.id, title: `${MARK} stats draft`, author_id: UID, status: 'draft', votes_count: 0, blocks_used: [], tenant_id: T, week: SWEEK },
    ])
    .returning();
  const [theirs] = await db
    .insert(solutions)
    .values({ challenge_id: chO!.id, title: `${MARK} stats other tenant`, author_id: UID, status: 'voting', votes_count: 1000, blocks_used: [], tenant_id: O, week: SWEEK })
    .returning();
  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(SWEEK);
    // 3 of the caller's own rows, 7+3+0 votes. NOT 4 rows and NOT 1010 votes — the other
    // tenant's 1000-vote row in the same week is invisible.
    expect(r.json.stats.solutionsSubmitted).toBe(3);
    expect(r.json.stats.totalVotesCast).toBe(10);
  } finally {
    await db.delete(solutions).where(inArray(solutions.id, [...mine.map((s) => s.id), theirs!.id]));
    await db.delete(challenges).where(inArray(challenges.id, [chT!.id, chO!.id]));
  }
}, 30_000);

test('a genuine ZERO reaches the page as 0, not as a missing field', async () => {
  // The first real weekly winner won a week in which no votes were cast at all. `0` has to
  // arrive as `0` — the browser's `!= null` checks can only render a zero they are given.
  const Z = '00000000-0000-0000-0000-00000c40c003';
  const ZWEEK = '2096-W44';
  const [chZ] = await db.insert(challenges).values({ title: `${MARK} zero host`, work_area: 'Claims', submitter_id: UID, tenant_id: Z }).returning();
  const [solZ] = await db.insert(solutions).values({ challenge_id: chZ!.id, title: `${MARK} zero winner`, author_id: UID, status: 'shipping', votes_count: 0, blocks_used: [], tenant_id: Z, week: ZWEEK }).returning();
  try {
    const r = await callAsTenant('GET', '/api/winner', Z);
    expect(r.json.stats.totalVotesCast).toBe(0);
    expect(r.json.stats.solutionsSubmitted).toBe(1);
    // `toBe(0)` alone would also pass on `undefined` in a loosely-typed payload check, so pin
    // the presence of the key itself.
    expect(Object.keys(r.json.stats).sort()).toEqual(['solutionsSubmitted', 'totalVotesCast']);
  } finally {
    await db.delete(solutions).where(eq(solutions.id, solZ!.id));
    await db.delete(challenges).where(eq(challenges.id, chZ!.id));
  }
}, 30_000);

// ---------------------------------------------------------------------------
// "SOLUTIONS IN VOTING" / "being judged now" — THE CARD WAS A MONOTONE COUNTER.
//
// The predicate was `eq(solutions.status,'voting')`: no week, no cycle, no recency. Nothing in
// this product ever demotes a loser (every writer of the column is enumerated in
// routes/marketplace-summary.ts), so the number could only ever GROW and the home page
// eventually announced the entire back catalogue as "being judged now".
//
// The gate is `weekClosedSql` — the SAME predicate `host/vote-service.ts` 409s on and the SAME
// one `/solutions` puts on the wire as `cycleClosed`. The three tests below pin, in order: that
// a CLOSED week stops contributing, that the legacy `week=''` row is excluded, and that the
// number the home page prints is exactly the number of rows `/solutions` renders with a LIVE
// vote pill.
//
// ⛔ EVERY ASSERTION IS A DELTA, NEVER AN ABSOLUTE. This count is global (RLS-scoped in prod,
// owner-scoped here) and the seeded marketplace contributes to it, so an absolute expectation
// would encode today's seed and break on the next seed change. The delta is the only figure
// that isolates what these fixtures add.
//
// The two weeks below are pinned by a CYCLE ROW rather than by their name, deliberately: the
// second arm of `weekClosedSql` compares the week string against the CURRENT week, so a
// name-only fixture would silently change meaning as the calendar moves. A `phase='closed'` row
// fires arm 1 and a `phase='voting'` row defeats both arms, on every future date alike.
// ---------------------------------------------------------------------------
const CYCLE_OPEN = '2096-W45';
const CYCLE_CLOSED = '2096-W46';

async function seedCycles() {
  const t = new Date('2026-01-01T00:00:00.000Z');
  await ensureTenants([UID]);
  await db
    .insert(marketplaceCycles)
    .values([
      // 0110: per-tenant rows — the fixture solutions below belong to tenant UID.
      { tenant_id: UID, ...cyclePeriodCols(CYCLE_OPEN), phase: 'voting' as const, voting_ends_at: t, solution_ends_at: t, closes_at: t },
      { tenant_id: UID, ...cyclePeriodCols(CYCLE_CLOSED), phase: 'closed' as const, voting_ends_at: t, solution_ends_at: t, closes_at: t, closed_at: t },
    ])
    .onConflictDoNothing();
}
const dropCycles = () => db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, [CYCLE_OPEN, CYCLE_CLOSED]));

const votingCount = async () => (await call('GET', '/api/home/summary')).json.stats.solutionsInVoting as number;

test('⛔ "solutions in voting" counts the OPEN week only — a CLOSED week stops contributing', async () => {
  // RED against `eq(status,'voting')`: that predicate has no idea which week a row competes in,
  // so all five rows below land in the count and the delta is 5 rather than 2.
  await seedCycles();
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} judged host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID })
    .returning();
  try {
    const before = await votingCount();
    const rows = await db
      .insert(solutions)
      .values([
        // The losers of a week that is OVER. Their own column still says 'voting' — that is the
        // whole defect: `closeCycle` never demotes them, so status can never express this.
        { challenge_id: ch!.id, title: `${MARK} judged closed a`, author_id: UID, status: 'voting', votes_count: 9, blocks_used: [], tenant_id: UID, week: CYCLE_CLOSED },
        { challenge_id: ch!.id, title: `${MARK} judged closed b`, author_id: UID, status: 'voting', votes_count: 8, blocks_used: [], tenant_id: UID, week: CYCLE_CLOSED },
        // The winner of that same closed week, for completeness: 'shipping' was never counted by
        // the old predicate either, and must not be counted by the new one.
        { challenge_id: ch!.id, title: `${MARK} judged closed win`, author_id: UID, status: 'shipping', votes_count: 20, blocks_used: [], tenant_id: UID, week: CYCLE_CLOSED },
        // The rows genuinely being judged right now.
        { challenge_id: ch!.id, title: `${MARK} judged open a`, author_id: UID, status: 'voting', votes_count: 2, blocks_used: [], tenant_id: UID, week: CYCLE_OPEN },
        { challenge_id: ch!.id, title: `${MARK} judged open b`, author_id: UID, status: 'voting', votes_count: 1, blocks_used: [], tenant_id: UID, week: CYCLE_OPEN },
      ])
      .returning();
    expect(rows).toHaveLength(5);

    expect(await votingCount()).toBe(before + 2);

    // And it FALLS again when the open week closes — the property the shipped predicate could
    // not have, expressed as a state change rather than as a second fixture. This is the whole
    // point: the number has to be able to go DOWN.
    await db.update(marketplaceCycles).set({ phase: 'closed', closed_at: new Date() }).where(eq(marketplaceCycles.week, CYCLE_OPEN));
    expect(await votingCount()).toBe(before);
  } finally {
    await db.delete(solutions).where(eq(solutions.challenge_id, ch!.id));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
    await dropCycles();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// ⛔ THE ONE CELL THAT PINS THE COMPARATOR. Every other fixture in this block pins its week by a
// CYCLE ROW (`2096-W45/W96`), which is deliberate — it keeps them meaningful as the calendar
// moves — but it also makes them blind to `weekString(new Date())`. Measured: hardcode that
// argument in routes/marketplace-summary.ts to `'2099-W52'` and the whole file still goes
// 20 pass / 0 fail. So the arm-2 comparator had ZERO coverage, and an over-advanced `currentWeek`
// would silently mark every future-week row CLOSED with nothing in this file noticing.
//
// This is the roll-forward case `cycle-eligibility.ts` point 2 exists for: `routes/solutions.ts`
// stamps `laterWeek(weekString(now), ch.week)`, so a solution answering a challenge already pushed
// into W+1 legitimately carries a FUTURE week that has no cycle row yet — and it MUST stay votable.
// Arm 1 wants `phase='closed'` (no row at all), arm 2 wants `week < currentWeek` (it is greater),
// so neither fires and the row is counted.
// ---------------------------------------------------------------------------
test('⛔ a FUTURE week with NO cycle row IS being judged — the only cell that pins the comparator', async () => {
  // Derived from `now`, never hardcoded: a literal would stop being "future" as the calendar moves
  // and this cell would quietly become a duplicate of the closed-week one.
  const FUTURE_WEEK = weekString(new Date(Date.now() + 400 * 24 * 60 * 60 * 1000));
  // Three premises, asserted rather than assumed — without all three this proves nothing.
  //  (a) it really is in the future, so arm 2's `<` must be false as shipped;
  expect(FUTURE_WEEK > weekString(new Date())).toBe(true);
  //  (b) it sorts BELOW '2099-W52', which is what makes the red-check bite: with the comparator
  //      hardcoded there, arm 2 flips true and the row is counted CLOSED, so the delta drops to 0;
  expect(FUTURE_WEEK < '2099-W52').toBe(true);
  //  (c) nothing has opened a cycle row for it — no seed inserts into marketplace_cycles, and
  //      `tickCycles`/`backfillMissedCycles` never run in this suite, but assert it anyway: a stray
  //      row would answer the question via arm 1 and the comparator would go untested again.
  expect(await db.select({ w: marketplaceCycles.week }).from(marketplaceCycles).where(eq(marketplaceCycles.week, FUTURE_WEEK))).toHaveLength(0);

  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} future host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID })
    .returning();
  try {
    const before = await votingCount();
    await db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} future week`, author_id: UID, status: 'voting', votes_count: 1, blocks_used: [], tenant_id: UID, week: FUTURE_WEEK });
    expect(await votingCount()).toBe(before + 1);
  } finally {
    await db.delete(solutions).where(eq(solutions.challenge_id, ch!.id));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test("⛔ a legacy `week = ''` row is NOT being judged", async () => {
  // `solutions.week` is `text NOT NULL DEFAULT ''` (pre-0047), so unstamped rows carry the empty
  // string rather than NULL. It sorts below every real week and has no cycle row, so arm 2 of
  // `weekClosedSql` fires and calls it closed — correct, because a row that was never filed into
  // a cycle can never be judged by one. RED against `eq(status,'voting')`, which counts it.
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} weekless host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID })
    .returning();
  try {
    const before = await votingCount();
    const [sol] = await db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} weekless`, author_id: UID, status: 'voting', votes_count: 5, blocks_used: [], tenant_id: UID })
      .returning();
    // Pin the premise: the column really did default to '' and not to NULL, or this test proves
    // nothing about the empty-string case.
    expect(sol!.week).toBe('');
    expect(await votingCount()).toBe(before);
  } finally {
    await db.delete(solutions).where(eq(solutions.challenge_id, ch!.id));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test('⛔ the home number IS the number of rows /solutions renders as VOTABLE', async () => {
  // THE DEFECT WAS NEVER JUST "the number is too big" — it was TWO NUMBERS ONE CLICK APART
  // DISAGREEING. The card links to /solutions, which applies no status filter and drives its
  // vote pill off `cycleClosed`. So the honest statement of the contract is not an arithmetic
  // one, it is: home's figure = the count of rows the linked board shows a LIVE pill on.
  //
  // `cycleClosed === false` is precisely "votable" on that board and not an approximation of it:
  // frontend `solutionVoteBlockedReason` returns null for exactly one votability, `open`, which
  // `solutionState` derives from this boolean ALONE — `row.status` is explicitly not a signal
  // (frontend/src/lib/solutions/solution-state.test.ts pins both directions).
  const solRouter = new Router();
  registerSolutionRoutes(solRouter);
  const listPage = async (page: number) => {
    const matched = solRouter.match('GET', '/api/solutions')!;
    const res = await matched.handler(new Request(`http://localhost/api/solutions?page=${page}`, { method: 'GET' }));
    return (await res.json()) as { items: { id: string; cycleClosed: boolean }[]; total: number };
  };

  await seedCycles();
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} agree host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID })
    .returning();
  try {
    await db.insert(solutions).values([
      { challenge_id: ch!.id, title: `${MARK} agree closed`, author_id: UID, status: 'voting', votes_count: 4, blocks_used: [], tenant_id: UID, week: CYCLE_CLOSED },
      { challenge_id: ch!.id, title: `${MARK} agree open`, author_id: UID, status: 'voting', votes_count: 3, blocks_used: [], tenant_id: UID, week: CYCLE_OPEN },
      { challenge_id: ch!.id, title: `${MARK} agree open ship`, author_id: UID, status: 'shipping', votes_count: 2, blocks_used: [], tenant_id: UID, week: CYCLE_OPEN },
      { challenge_id: ch!.id, title: `${MARK} agree weekless`, author_id: UID, status: 'voting', votes_count: 1, blocks_used: [], tenant_id: UID },
    ]);

    // Walk the WHOLE board, not page 1 — the board is paginated at 10 and the home card counts
    // every row. A single-page check would agree by accident on a small fixture and stop being
    // a proof the moment the seed grows.
    const first = await listPage(1);
    const seen = new Map<string, boolean>();
    for (const it of first.items) seen.set(it.id, it.cycleClosed);
    for (let p = 2; seen.size < first.total; p++) {
      const next = await listPage(p);
      if (next.items.length === 0) break;
      for (const it of next.items) seen.set(it.id, it.cycleClosed);
    }
    expect(seen.size).toBe(first.total);

    const votableOnTheBoard = [...seen.values()].filter((closed) => closed === false).length;
    // Not a tautology: both sides must also be non-trivial, or "0 === 0" would pass on a board
    // where every row is closed and prove nothing.
    expect(votableOnTheBoard).toBeGreaterThan(0);
    expect([...seen.values()].filter((closed) => closed === true).length).toBeGreaterThan(0);
    expect(await votingCount()).toBe(votableOnTheBoard);
  } finally {
    await db.delete(solutions).where(eq(solutions.challenge_id, ch!.id));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
    await dropCycles();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// ⚠️ THE PAYLOAD IS NOT INTERNALLY CLEAN, AND THIS TEST SAYS SO OUT LOUD.
//
// The test above pins the agreement that WAS the point of the change: home's figure = the rows
// /solutions renders with a live pill. It does NOT make this payload self-consistent, and the
// comment in routes/marketplace-summary.ts no longer claims that it does. ONE row can be counted
// by `solutionsInVoting` AND by `liveInProduction` in the SAME response — simultaneously "being
// judged now" and "winners shipped" (frontend/messages/en.json:109-114).
//
// ⛔ PINNED ON PURPOSE, AS A KNOWN STATE RATHER THAN A SURPRISE. Two reasons this is a test and not
// just a paragraph: (1) it is reachable through the PRODUCT — `routes/pipeline.ts:397` stamps
// `status:'shipping'` on entering Production and never touches the cycle, so an operator promoting
// a CURRENT-week solution lands exactly here (`closeCycle` cannot: it crowns and closes in one
// transaction); (2) whoever eventually decides which card owns a shipped-but-still-votable row
// needs this to go RED so the decision is made deliberately, in one place, with the fixture that
// produces the state already written down. Under the old `eq(status,'voting')` predicate the row
// showed up in the second card only — this change is what surfaced the overlap.
//
// NOT A BLOCKER and NOT a wrong count: /solutions shows a LIVE pill on this row too (`solutionState`
// gives `kind:'shipping'` with `votability:'open'`, and `solutionVoteBlockedReason` switches on
// `votability` alone), and `vote-service` would accept the vote. Home agrees with the board and
// disagrees with itself, narrowly.
//
// ⛔ IF THIS GOES RED, DO NOT "FIX" IT BY WEAKENING THE VOTE GATE. The gate is right; the open
// question is which CARD claims the row.
// ---------------------------------------------------------------------------
test('⚠️ KNOWN OVERLAP: one row can be "being judged now" AND "winners shipped" in the same payload', async () => {
  await seedCycles();
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} overlap host`, work_area: 'Claims', submitter_id: UID, tenant_id: UID })
    .returning();
  const stats = async () => (await call('GET', '/api/home/summary')).json.stats as { solutionsInVoting: number; liveInProduction: number };
  let cardId = '';
  try {
    const before = await stats();
    // The operator-promotion shape, exactly: an OPEN cycle for the row's week (so the vote gate
    // says open) and `status:'shipping'` written by the Production move (so the pipeline card is
    // live). Neither fact contradicts the other — that is the whole problem.
    const [sol] = await db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} overlap sol`, author_id: UID, status: 'shipping', votes_count: 7, blocks_used: [], tenant_id: UID, week: CYCLE_OPEN })
      .returning();
    const [card] = await db
      .insert(pipelineItems)
      .values({ solution_id: sol!.id, title: `${MARK} overlap card`, author_id: UID, stage: 'production', live: true, rollout_pct: 100 })
      .returning();
    cardId = card!.id;

    const after = await stats();
    // ONE row, BOTH cards. This is the assertion the amended comment is about.
    expect(after.solutionsInVoting).toBe(before.solutionsInVoting + 1);
    expect(after.liveInProduction).toBe(before.liveInProduction + 1);
  } finally {
    if (cardId) await db.delete(pipelineItems).where(eq(pipelineItems.id, cardId));
    await db.delete(solutions).where(eq(solutions.challenge_id, ch!.id));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
    await dropCycles();
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WS-2 — the winner's rank is MEASURED, and the mentions carry their TRUE positions.
//
// ⛔ THE DEFECT. `honorableMentions` was numbered `rank: i + 2`, which asserts "the winner is
// rank 1" without ever checking. Two of the three winner sources in the handler are
// vote-independent (the top *shipping* solution; a live pipeline card ordered by featured/live_at)
// and an announced winner keeps accruing votes after its cycle closes — so the live DB rendered a
// 2-VOTE WINNER above a 233-VOTE "#2". Reverting to `i + 2` turns [1,2,3] into [2,3,4] here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('winner rank is measured: a 2-vote winner is #4 and the week’s real leader is mention #1', async () => {
  const T = '00000000-0000-0000-0000-00000c40b001';
  const RANK_WEEK = '2096-W44';
  const [ch] = await db.insert(challenges).values({ title: `${MARK} rank host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  // The prod shape in miniature: the announced winner is NOT the vote leader of its own week.
  const [win] = await db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK} rank winner 2`, author_id: UID, status: 'shipping', votes_count: 2, blocks_used: [], tenant_id: T, week: RANK_WEEK }).returning();
  const others = await db
    .insert(solutions)
    .values([
      { challenge_id: ch!.id, title: `${MARK} rank leader 233`, author_id: UID, status: 'voting', votes_count: 233, blocks_used: [], tenant_id: T, week: RANK_WEEK },
      { challenge_id: ch!.id, title: `${MARK} rank mid 50`, author_id: UID, status: 'voting', votes_count: 50, blocks_used: [], tenant_id: T, week: RANK_WEEK },
      { challenge_id: ch!.id, title: `${MARK} rank low 10`, author_id: UID, status: 'voting', votes_count: 10, blocks_used: [], tenant_id: T, week: RANK_WEEK },
    ])
    .returning();
  await db.insert(weeklyWinners).values({ week: RANK_WEEK, tenant_id: T, solution_id: win!.id, challenge_id: ch!.id, announced_at: new Date() });
  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.week).toBe(RANK_WEEK);
    expect(r.json.winner.solution.id).toBe(win!.id);
    // 233 > 50 > 10 > 2 — the winner is fourth on votes, and the payload says so instead of
    // printing an implicit "#1".
    expect(r.json.winner.rank).toBe(4);
    // ⛔ THE ASSERTION THE OLD CODE FAILS: `i + 2` yields [2,3,4] here.
    expect(r.json.honorableMentions.map((mn: { rank: number }) => mn.rank)).toEqual([1, 2, 3]);
    expect(r.json.honorableMentions.map((mn: { title: string }) => mn.title)).toEqual([
      `${MARK} rank leader 233`,
      `${MARK} rank mid 50`,
      `${MARK} rank low 10`,
    ]);
    // The winner never appears in its own runners-up list, even though the candidate query now
    // includes it (dropping `ne(id, sol.id)` is what makes the rank knowable at all).
    expect(r.json.honorableMentions.map((mn: { id: string }) => mn.id)).not.toContain(win!.id);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, RANK_WEEK));
    await db.delete(solutions).where(inArray(solutions.id, [win!.id, ...others.map((s) => s.id)]));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test('a genuine rank-1 winner still yields mentions 2–4', async () => {
  // The happy path the old offset happened to get right. It stays right — the positions are the
  // same numbers, now derived rather than assumed, so this is the control for the test above.
  const T = '00000000-0000-0000-0000-00000c40b002';
  const RANK_WEEK = '2096-W43';
  const [ch] = await db.insert(challenges).values({ title: `${MARK} top host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  const [win] = await db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK} top winner 500`, author_id: UID, status: 'shipping', votes_count: 500, blocks_used: [], tenant_id: T, week: RANK_WEEK }).returning();
  const others = await db
    .insert(solutions)
    .values([
      { challenge_id: ch!.id, title: `${MARK} top second 233`, author_id: UID, status: 'voting', votes_count: 233, blocks_used: [], tenant_id: T, week: RANK_WEEK },
      { challenge_id: ch!.id, title: `${MARK} top third 50`, author_id: UID, status: 'voting', votes_count: 50, blocks_used: [], tenant_id: T, week: RANK_WEEK },
      { challenge_id: ch!.id, title: `${MARK} top fourth 10`, author_id: UID, status: 'voting', votes_count: 10, blocks_used: [], tenant_id: T, week: RANK_WEEK },
    ])
    .returning();
  await db.insert(weeklyWinners).values({ week: RANK_WEEK, tenant_id: T, solution_id: win!.id, challenge_id: ch!.id, announced_at: new Date() });
  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.winner.rank).toBe(1);
    expect(r.json.honorableMentions.map((mn: { rank: number }) => mn.rank)).toEqual([2, 3, 4]);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, RANK_WEEK));
    await db.delete(solutions).where(inArray(solutions.id, [win!.id, ...others.map((s) => s.id)]));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test('a winner outside the week’s eligible set has rank null — and the mentions still rank from 1', async () => {
  // The derived-winner shape: a LIVE PRODUCTION CARD stamped with this week, whose solution
  // competed in an earlier one. It won by shipping, not by polling, so it has no position on this
  // week's leaderboard — `null` is the honest answer and a fabricated number is the defect.
  const T = '00000000-0000-0000-0000-00000c40b003';
  const CARD_WEEK = '2096-W42';
  const SOL_WEEK = '2096-W40';
  const [ch] = await db.insert(challenges).values({ title: `${MARK} offweek host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  // Deliberately NOT `shipping`: that would take the shipping-solution fallback, which announces
  // the solution's OWN week and would put the winner back inside the candidate set.
  const [win] = await db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK} offweek winner`, author_id: UID, status: 'voting', votes_count: 7, blocks_used: [], tenant_id: T, week: SOL_WEEK }).returning();
  const others = await db
    .insert(solutions)
    .values([
      { challenge_id: ch!.id, title: `${MARK} offweek leader 233`, author_id: UID, status: 'voting', votes_count: 233, blocks_used: [], tenant_id: T, week: CARD_WEEK },
      { challenge_id: ch!.id, title: `${MARK} offweek mid 50`, author_id: UID, status: 'voting', votes_count: 50, blocks_used: [], tenant_id: T, week: CARD_WEEK },
    ])
    .returning();
  const [card] = await db
    .insert(pipelineItems)
    .values({ solution_id: win!.id, title: `${MARK} offweek card`, author_id: UID, stage: 'production', live: true, featured: true, week: CARD_WEEK, live_at: new Date() })
    .returning();
  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.winner.solution.id).toBe(win!.id);
    expect(r.json.week).toBe(CARD_WEEK);
    // Not 1, not 3, not "last" — absent. The field exists and is explicitly null.
    expect(r.json.winner.rank).toBeNull();
    // The week's own leaderboard is unaffected: it starts at 1 because nobody is above it.
    expect(r.json.honorableMentions.map((mn: { rank: number }) => mn.rank)).toEqual([1, 2]);
    expect(r.json.honorableMentions[0].title).toBe(`${MARK} offweek leader 233`);
  } finally {
    await db.delete(pipelineItems).where(eq(pipelineItems.id, card!.id));
    await db.delete(solutions).where(inArray(solutions.id, [win!.id, ...others.map((s) => s.id)]));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

// ⛔ THE BRANCH NO OTHER TEST IN THIS FILE REACHES. The three cases above all leave the winner
// INSIDE the bounded 25-row candidate fetch, so `winnerRank` is read straight off
// `candidates.findIndex` and `rankWithinWeek()` — the only genuinely new piece of logic in this
// change — never executes. It is also the branch that fires exclusively on production-shaped
// data: a week deep enough that the winner sits under the cut. Left untested it would degrade
// silently, and its degradation reads as a plausible number rather than as an error.

test('⛔ a winner BELOW the 25-row cut is MEASURED, not guessed — rankWithinWeek(), all three keys', async () => {
  const T = '00000000-0000-0000-0000-00000c40b004';
  const DEEP_WEEK = '2096-W41';
  // `rankWithinWeek` has to spell `WINNER_ORDER` as a PREDICATE (an ORDER BY cannot be one), so
  // the two spellings can drift. This fixture makes all three keys load-bearing at once: 25 rows
  // are ahead on VOTES, and the winner then sits inside a vote-TIED cluster where only
  // `created_at` and finally `id` can separate it. Ids are pinned rather than generated for
  // exactly that last arm — a random uuid would decide the id comparison by coin-flip and the
  // assertion would only sometimes be able to see the arm go missing.
  const TIE_EARLIER = '00000000-0000-0000-0000-00000c40d001';
  const TIE_SAME_LOWER = '00000000-0000-0000-0000-00000c40d002';
  const WINNER_ID = '00000000-0000-0000-0000-00000c40d005';
  const TIE_SAME_HIGHER = '00000000-0000-0000-0000-00000c40d009';
  const TIE_LATER = '00000000-0000-0000-0000-00000c40d00a';
  const BELOW_ID = '00000000-0000-0000-0000-00000c40d00b';
  const MID = new Date('2026-03-02T00:00:00.000Z');
  const EARLIER = new Date('2026-03-01T00:00:00.000Z');
  const LATER = new Date('2026-03-03T00:00:00.000Z');
  const [ch] = await db.insert(challenges).values({ title: `${MARK} deep host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  // Exactly WEEK_CANDIDATE_LIMIT rows above the winner on votes, so the fetch comes back full and
  // WITHOUT the winner in it — the precondition for the second, targeted read.
  const ahead = await db
    .insert(solutions)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        challenge_id: ch!.id,
        title: `${MARK} deep ahead ${String(i).padStart(2, '0')}`,
        author_id: UID,
        status: 'voting' as const,
        votes_count: 1000 - i,
        blocks_used: [],
        tenant_id: T,
        week: DEEP_WEEK,
        created_at: MID,
      })),
    )
    .returning();
  const cluster = await db
    .insert(solutions)
    .values([
      // votes tie, submitted EARLIER → ahead of the winner on key 2.
      { id: TIE_EARLIER, challenge_id: ch!.id, title: `${MARK} deep tie earlier`, author_id: UID, status: 'voting' as const, votes_count: 5, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: EARLIER },
      // votes AND created_at tie, lower id → ahead of the winner on key 3, and on key 3 alone.
      { id: TIE_SAME_LOWER, challenge_id: ch!.id, title: `${MARK} deep tie same lower id`, author_id: UID, status: 'voting' as const, votes_count: 5, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: MID },
      { id: WINNER_ID, challenge_id: ch!.id, title: `${MARK} deep winner`, author_id: UID, status: 'shipping' as const, votes_count: 5, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: MID },
      // The three rows BEHIND it. A predicate that used `gte`/`lte` anywhere would sweep these in.
      { id: TIE_SAME_HIGHER, challenge_id: ch!.id, title: `${MARK} deep tie same higher id`, author_id: UID, status: 'voting' as const, votes_count: 5, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: MID },
      { id: TIE_LATER, challenge_id: ch!.id, title: `${MARK} deep tie later`, author_id: UID, status: 'voting' as const, votes_count: 5, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: LATER },
      { id: BELOW_ID, challenge_id: ch!.id, title: `${MARK} deep below`, author_id: UID, status: 'voting' as const, votes_count: 3, blocks_used: [], tenant_id: T, week: DEEP_WEEK, created_at: EARLIER },
    ])
    .returning();
  await db.insert(weeklyWinners).values({ week: DEEP_WEEK, tenant_id: T, solution_id: WINNER_ID, challenge_id: ch!.id, announced_at: new Date() });
  try {
    const r = await callAsTenant('GET', '/api/winner', T);
    expect(r.status).toBe(200);
    expect(r.json.winner.solution.id).toBe(WINNER_ID);
    // 27 rows strictly precede it: 25 on votes, one on the earlier submission, one on the lower
    // id. NOT `null` — that is the honest-absence answer and it belongs to a winner genuinely
    // outside the eligible set. NOT `26` (`candidates.length + 1`), which is the guess this
    // helper exists to replace. Each of the three keys contributes at least one row to the 27,
    // so deleting any one arm of the predicate moves this number.
    expect(r.json.winner.rank).toBe(28);
    // The displayed runners-up are unaffected: still the week's genuine top three, from 1.
    expect(r.json.honorableMentions.map((mn: { rank: number }) => mn.rank)).toEqual([1, 2, 3]);
    expect(r.json.honorableMentions.map((mn: { votesCount: number }) => mn.votesCount)).toEqual([1000, 999, 998]);
    expect(r.json.honorableMentions.map((mn: { id: string }) => mn.id)).not.toContain(WINNER_ID);
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, DEEP_WEEK));
    await db.delete(solutions).where(inArray(solutions.id, [...ahead.map((s) => s.id), ...cluster.map((s) => s.id)]));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);

test('⛔ ties resolve to DISTINCT and STABLE ranks across two renders of the same data', async () => {
  // The in-slice half of the same contract: `WINNER_ORDER` as an ORDER BY. A ranking that
  // compared votes alone would let Postgres return the tied rows in whatever order it liked, so
  // the same unchanged week could crown a different "#1" on a re-render — the non-determinism the
  // shared ordering in host/cycle-eligibility.ts exists to prevent. Four rows on one vote count:
  // one pair shares `created_at` so only the id can separate them, the other pair is strictly
  // later.
  const T = '00000000-0000-0000-0000-00000c40b005';
  const TIE_WEEK = '2096-W40';
  const EARLY = new Date('2026-01-01T00:00:00.000Z');
  const LATE = new Date('2026-01-02T00:00:00.000Z');
  const [ch] = await db.insert(challenges).values({ title: `${MARK} tie host`, work_area: 'Claims', submitter_id: UID, tenant_id: T }).returning();
  const rows = await db
    .insert(solutions)
    .values([
      { challenge_id: ch!.id, title: `${MARK} tie early A`, author_id: UID, status: 'voting' as const, votes_count: 10, blocks_used: [], tenant_id: T, week: TIE_WEEK, created_at: EARLY },
      { challenge_id: ch!.id, title: `${MARK} tie early B`, author_id: UID, status: 'voting' as const, votes_count: 10, blocks_used: [], tenant_id: T, week: TIE_WEEK, created_at: EARLY },
      { challenge_id: ch!.id, title: `${MARK} tie late C`, author_id: UID, status: 'voting' as const, votes_count: 10, blocks_used: [], tenant_id: T, week: TIE_WEEK, created_at: LATE },
      { challenge_id: ch!.id, title: `${MARK} tie late D`, author_id: UID, status: 'shipping' as const, votes_count: 10, blocks_used: [], tenant_id: T, week: TIE_WEEK, created_at: LATE },
    ])
    .returning();
  const win = rows.find((s) => s.title.endsWith('tie late D'))!;
  await db.insert(weeklyWinners).values({ week: TIE_WEEK, tenant_id: T, solution_id: win.id, challenge_id: ch!.id, announced_at: new Date() });
  try {
    // Derived from the fixture, never hardcoded: the ids are generated here, so the expectation is
    // whatever `created_at asc, id asc` says about the rows that actually landed.
    const expectedOrder = [
      ...rows.filter((s) => s.created_at.getTime() === EARLY.getTime()).map((s) => s.id).sort(),
      ...rows.filter((s) => s.created_at.getTime() === LATE.getTime()).map((s) => s.id).sort(),
    ];
    const shape = (r: { json: { winner: { rank: number | null }; honorableMentions: { rank: number; id: string }[] } }) => ({
      rank: r.json.winner.rank,
      mentions: r.json.honorableMentions.map((mn) => [mn.rank, mn.id]),
    });
    const first = await callAsTenant('GET', '/api/winner', T);
    const second = await callAsTenant('GET', '/api/winner', T);
    expect(first.status).toBe(200);
    expect(first.json.winner.solution.id).toBe(win.id);
    expect(first.json.winner.rank).toBe(expectedOrder.indexOf(win.id) + 1);
    expect(first.json.honorableMentions.map((mn: { id: string }) => mn.id)).toEqual(expectedOrder.filter((id) => id !== win.id));
    const ranks = first.json.honorableMentions.map((mn: { rank: number }) => mn.rank);
    // A tie must not hand two rows the same position…
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toEqual([1, 2, 3]);
    // …and it must not move between two renders of the same unchanged data.
    expect(shape(second)).toEqual(shape(first));
  } finally {
    await db.delete(weeklyWinners).where(eq(weeklyWinners.week, TIE_WEEK));
    await db.delete(solutions).where(inArray(solutions.id, rows.map((s) => s.id)));
    await db.delete(challenges).where(eq(challenges.id, ch!.id));
  }
}, 30_000);
