// tests/challenge-rank-truth.test.ts — `rank` on the Challenge leaderboard (and on home's
// Trending card) is the row's STANDING ON THE BOARD, never its offset into the response.
//
// ⛔ THE DEFECT, MEASURED ON THE RUNNING LOCAL STACK (before the fix):
//
//     GET /api/challenges?sort=newest  ->
//      [(rank 1, votes 0,   'Flag high-value claims for faster review'),
//       (rank 2, votes 162, 'Visibility into churn signals per segment'),
//       ...
//       (rank 6, votes 284, 'Auto-summarize claim forms')]
//
// A 0-vote challenge served `rank: 1` and the 284-vote leader served `rank: 6`. The frontend
// paints `rank === 1` with the gold crown (LeaderboardRow.svelte -> RankBadge.svelte `.top`),
// so the board crowned its own last-placed row. It fired on the board's OWN DEFAULT view
// (`?open=true`), on `?sort=newest`, and on every `?q=` / `?work_area=` filter — the identical
// shape routes/solutions.ts already documents as "a LIE" and fixed with a window over the
// UNFILTERED board.
//
// The fixture's votes are deliberately far above anything the seed or a sibling test can hold,
// so the three rows own board ranks 1/2/3 outright and the assertions are exact rather than
// relative.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerMarketplaceSummaryRoutes } from '../src/routes/marketplace-summary';
import { db, users, challenges, solutions, votes, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { weekString } from '../src/host/iso-week';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000cb00001';
const user: User = { id: UID, email: 'ranktruth@test', name: 'Rae Truth', roles: ['employee'], tenantId: UID };
const MARK = 'ZRANKTRUTH';

// ⛔ THE TIED GROUP — its own search mark, so `?q=ZRANKTRUTH` never sees it and the A/B/C
// assertions below stay exactly as they were. The ids are EXPLICIT and listed in ASCENDING order,
// which is the order the board must number them in; see the tie test at the bottom of this file.
const TIE = 'ZRANKTIE';
const TIE_IDS = [
  '00000000-0000-0000-0000-00000cb00da1',
  '00000000-0000-0000-0000-00000cb00db1',
  '00000000-0000-0000-0000-00000cb00dc1',
  '00000000-0000-0000-0000-00000cb00dd1',
  '00000000-0000-0000-0000-00000cb00de1',
  '00000000-0000-0000-0000-00000cb00df1',
] as const;
/** The ranks the tied group must hold: it sits directly under C (ranks 1/2/3), so 4..9. */
const TIE_RANKS = [4, 5, 6, 7, 8, 9];

const router = new Router();
registerChallengeRoutes(router);
registerMarketplaceSummaryRoutes(router);

async function call(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    matched.handler(new Request(`http://localhost${path}`, { method: 'GET' }), ...matched.params),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// The board's three rows. `top` (votes) and `newest` (created_at) order them in OPPOSITE
// directions on purpose — an offset-derived rank cannot survive both. B is `closed`, which is
// what makes home's Trending card (which filters closed rows out) disagree with the board: C is
// the SECOND row Trending shows and the THIRD row on the board.
type Fixture = { id: string; votes: number; workArea: string; rank: number };
let A: Fixture;
let B: Fixture;
let C: Fixture;

async function cleanup() {
  const ids = [
    ...(await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id),
    // The tied group carries its OWN mark (so the `?q=` views above cannot see it) and therefore
    // has to be named here too — a `like('${MARK}%')` teardown would leave it in the database.
    ...TIE_IDS,
  ];
  if (ids.length) {
    await db.delete(votes).where(inArray(votes.target_id, ids));
    await db.delete(solutions).where(inArray(solutions.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'RT' }).onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
  // The CURRENT week, so the `?open=true` view (the board's own default) keeps A and C live.
  const week = weekString(new Date());
  const t0 = Date.UTC(2026, 0, 1);
  const rows = await db
    .insert(challenges)
    .values([
      { title: `${MARK} A leader`, work_area: 'Ops', submitter_id: UID, tenant_id: UID, status: 'voting' as const, votes_count: 900_000, week, created_at: new Date(t0) },
      { title: `${MARK} B closed`, work_area: 'Risk', submitter_id: UID, tenant_id: UID, status: 'closed' as const, votes_count: 800_000, week, created_at: new Date(t0 + 60_000) },
      { title: `${MARK} C third`, work_area: 'Ops', submitter_id: UID, tenant_id: UID, status: 'voting' as const, votes_count: 700_000, week, created_at: new Date(t0 + 120_000) },
    ])
    .returning();
  A = { id: rows[0]!.id, votes: 900_000, workArea: 'Ops', rank: 1 };
  B = { id: rows[1]!.id, votes: 800_000, workArea: 'Risk', rank: 2 };
  C = { id: rows[2]!.id, votes: 700_000, workArea: 'Ops', rank: 3 };

  // ⛔ THE TIED GROUP. Six rows on the SAME `votes_count` AND the SAME `created_at` — the one
  // fixture shape under which the window's `id asc` tie-break is load-bearing, and the shape no
  // other assertion in this file constructs (A/B/C are 900k/800k/700k, all distinct, so the
  // tie-break never fires for them and deleting it leaves them green).
  //
  // 650k sits BELOW C and above anything the seed or a sibling test holds, so the group owns board
  // ranks 4..9 outright while A/B/C keep 1/2/3. `closed` keeps it out of `?open=true` and out of
  // home's Trending card, so every assertion above is untouched by its presence.
  //
  // ⛔ SIX OF THEM, AND THE COUNT IS THE EXPERIMENT — not decoration. With `, id asc` deleted the
  // window's ordering key is no longer total, so these rows are numbered in whatever order the plan
  // happens to emit them (Seq Scan -> Hash Join against `users` -> Sort; there is no index on
  // `votes_count`, so it is a plain sort over equal keys). That order is arbitrary but NOT random:
  // it can coincide with `id asc` and let the mutant live. TWO rows was measured doing exactly that
  // — the pair came back already in id order and the mutant passed. Six rows have 720 permutations
  // and only ONE is `id asc`, and MEASURED here the mutant emits ranks 9,8,7,6,4,5 — near-total
  // reversal. "The mutant got lucky" stops being a plausible way for this test to pass.
  //
  // ⚠️ IF THIS EVER GOES GREEN UNDER A MUTATED WINDOW, the plan changed, not the contract — widen
  // the group or vary the insertion order until it reds again. A tie is the ONLY observable of the
  // `id asc` clause, so there is no order-independent form of this assertion to retreat to.
  const tiedAt = new Date(Date.UTC(2026, 0, 2));
  await db.insert(challenges).values(
    [...TIE_IDS].map((id, i) => ({
      id,
      title: `${TIE} tied ${i}`,
      work_area: 'Ops',
      submitter_id: UID,
      tenant_id: UID,
      status: 'closed' as const,
      votes_count: 650_000,
      week,
      created_at: tiedAt,
    })),
  );
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

type Item = { id: string; rank: number; votesCount: number };
/** The rank the payload gives each fixture row, keyed by id — the only thing that may not move. */
function ranksOf(items: Item[]): Record<string, number | undefined> {
  const by = new Map(items.map((i) => [i.id, i.rank]));
  return { A: by.get(A.id), B: by.get(B.id), C: by.get(C.id) };
}
/** The row this view would crown: the highest-voted one it contains. */
function topVoted(items: Item[]): Item {
  return [...items].sort((x, y) => y.votesCount - x.votesCount)[0]!;
}

test('the leaderboard rank is the standing on the board, identical under every sort and filter', async () => {
  const top = await call(`/api/challenges?q=${MARK}&sort=top`);
  expect(top.status).toBe(200);
  // `top` is the one view where the offset and the standing agree — it is the control.
  expect(top.json.items.map((i: Item) => i.id)).toEqual([A.id, B.id, C.id]);
  expect(ranksOf(top.json.items)).toEqual({ A: 1, B: 2, C: 3 });

  // `newest` orders the SAME three rows backwards. The offset-derived rank crowned C here.
  const newest = await call(`/api/challenges?q=${MARK}&sort=newest`);
  expect(newest.json.items.map((i: Item) => i.id)).toEqual([C.id, B.id, A.id]);
  expect(ranksOf(newest.json.items)).toEqual({ A: 1, B: 2, C: 3 });

  // A work_area filter removes B from the middle. The surviving rows keep 1 and 3 — a filter
  // may hide a row, it may never promote the one underneath it.
  const ops = await call(`/api/challenges?q=${MARK}&work_area=Ops`);
  expect(ops.json.items.map((i: Item) => i.id)).toEqual([A.id, C.id]);
  expect(ranksOf(ops.json.items)).toEqual({ A: 1, B: undefined, C: 3 });

  // `?open=true` — the board's OWN default view (frontend/src/routes/challenges/+page.svelte).
  const open = await call(`/api/challenges?q=${MARK}&open=true&sort=newest`);
  expect(open.json.items.map((i: Item) => i.id)).toEqual([C.id, A.id]);
  expect(ranksOf(open.json.items)).toEqual({ A: 1, B: undefined, C: 3 });

  // The crown, stated the way the browser reads it: in EVERY one of those views the row that
  // carries rank 1 is the top-voted row, and no other row carries it.
  for (const view of [top, newest, ops, open]) {
    const crowned = view.json.items.filter((i: Item) => i.rank === 1);
    expect(crowned).toHaveLength(1);
    expect(crowned[0]!.id).toBe(topVoted(view.json.items).id);
  }
});

test('⛔ rows tied on votes AND created_at get distinct consecutive ranks, ordered by id asc', async () => {
  // ⛔ WHY THIS CASE EXISTS. host/challenge-board.ts justifies its window in one sentence —
  // "`row_number` rather than `rank` because the ordering is TOTAL (id breaks any votes+created_at
  // tie), which also makes limit/offset paging stable — two rows on identical votes and timestamps
  // could otherwise swap between the page-1 and page-2 queries and be shown twice or not at all".
  // NOTHING ASSERTED IT. Every other fixture in this file uses DISTINCT vote counts (900k/800k/700k),
  // so no tie is ever constructed, `, id asc` never fires, and deleting it left all 25 assertions
  // green. A tie is the ONLY state in which that clause is observable, so this is the only case
  // that can hold the claim its header makes.
  const res = await call(`/api/challenges?q=${TIE}&sort=top`);
  expect(res.status).toBe(200);

  // Keyed by id, NEVER by array position: `sort=top` is `(votes_count desc, created_at desc)` and
  // BOTH are equal across this group, so the RESPONSE order is genuinely arbitrary here. `rank` is
  // the thing under test and it is not allowed to be.
  const byId = new Map<string, number>(res.json.items.map((i: Item) => [i.id, i.rank]));
  expect([...byId.keys()].sort()).toEqual([...TIE_IDS].sort());
  const ranks = TIE_IDS.map((id) => byId.get(id)!);

  // DISTINCT — a tie in the ordering key must not become a tie in the number the browser paints.
  //
  // ⛔ `row_number()` -> `rank()` AND `row_number()` -> `dense_rank()` ARE EQUIVALENT MUTANTS HERE,
  // and no test can kill them. That is a PROOF, not a gap left open: the window orders by
  // `(votes_count desc, created_at desc, id asc)` and `id` is the PRIMARY KEY, so the key is UNIQUE
  // and the order is TOTAL — with no ties in the key the three functions are the same function.
  // MEASURED over this board: `row_number`, `rank` and `dense_rank` agree on ALL 12 rows, 0
  // differences. Delete `, id asc` as well and they diverge instantly — 5 rows disagree with
  // `rank()`, 11 with `dense_rank()`, and all six rows below come back numbered `1`, i.e. SIX
  // GOLD CROWNS on one board. So `id asc` is what makes the choice of window function moot, and
  // this assertion is what reds if it is ever removed while the function is swapped (both composed
  // mutations were measured red against this case).
  expect(new Set(ranks).size).toBe(TIE_IDS.length);
  // CONSECUTIVE, AND IN `id asc` ORDER — TIE_IDS is listed ascending, so this single assertion
  // pins the tie-break's existence AND its direction.
  expect(ranks).toEqual(TIE_RANKS);
  // Stated the third way, as a pager reads it: the board's numbering runs 1..9 across A/B/C plus
  // this group with nothing repeated and nothing skipped — the exact property limit/offset paging
  // rests on, and the one a non-total ordering destroys.
  expect(ranks).toEqual([...ranks].sort((x, y) => x - y));

  // ⛔ AND THE SAME SIX NUMBERS UNDER A DIFFERENT SORT — the header's paging claim, stated the way
  // a pager would hit it. `sort=newest` orders by `created_at` ALONE, which across this group is a
  // pure tie, so the RESPONSE may hand the rows back in any order; the RANKS may not move. If rank
  // tracked the response, these rows would swap between two adjacent page queries and the pager
  // would show one twice and another never.
  const newest = await call(`/api/challenges?q=${TIE}&sort=newest`);
  const byIdNewest = new Map<string, number>(newest.json.items.map((i: Item) => [i.id, i.rank]));
  expect(TIE_IDS.map((id) => byIdNewest.get(id)!)).toEqual(TIE_RANKS);
});

test("home's Trending card ranks by the same board, not by its own offset", async () => {
  const r = await call('/api/home/summary');
  expect(r.status).toBe(200);
  const trending: Item[] = r.json.trending;
  // Trending filters `status <> 'closed'`, so B is absent — and C must keep the board rank 3
  // it holds on the page this card links to, not inherit B's slot.
  expect(trending.map((i) => i.id).slice(0, 2)).toEqual([A.id, C.id]);
  expect(ranksOf(trending)).toEqual({ A: 1, B: undefined, C: 3 });
});
