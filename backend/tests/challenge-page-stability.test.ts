// tests/challenge-page-stability.test.ts — the leaderboard's PAGE MEMBERSHIP, i.e. "does paging
// through /api/challenges show me every challenge exactly once".
//
// THE DEFECT THIS PINS. `orderForSort` (routes/challenges.ts) documented its last two terms as a
// "total tie-break (votes_count, created_at) so a page boundary can never repeat or drop a row".
// That pair is NOT total — nothing stops two challenges sharing both. `created_at` defaults to
// `now()`, which is the TRANSACTION's clock, so every row written by one batch insert carries the
// identical timestamp, and `votes_count` is a small integer that ties constantly on a young board.
//
// A non-total ORDER BY leaves Postgres free to return tied rows in a different arbitrary order per
// query, and the page queries differ only in their OFFSET: `LIMIT 10 OFFSET 0` sorts under a top-N
// heapsort of depth 10, `LIMIT 10 OFFSET 10` under one of depth 20, and equal keys come out in a
// different order from each. Measured against this fixture's shape before the fix (66 board rows
// tied on both columns, paged 10 at a time): 66 page slots served only 58 DISTINCT rows — 8 rows
// appeared on two pages each and 8 appeared on none.
//
// This is the OUTER sort. It is a DIFFERENT key from the `row_number()` window in
// host/challenge-board.ts, which already ends on `id asc` — which is why `rank` was stable while
// the page a row landed on was not, and why a rank-based assertion could never have caught this.
//
// The fixture is deliberately degenerate: EVERY row carries the same `votes_count`, the same
// `created_at`, the same `week` (with no `marketplace_cycles` row) and no votes at all, so all
// four sorts — top | newest | trending | closing — collapse onto a fully tied set and each one
// exercises its own branch of `orderForSort` with nothing but the tie-break left to order by.
// Remove `asc(b.id)` from a branch and that sort's union stops being the whole board.
//
// ⚠️ WITH ONE MEASURED EXCEPTION, STATED HERE SO NOBODY READS MORE INTO THE GREEN THAN IS THERE.
// Reverting the fix turns `newest`, `trending` and `closing` red on every run (5/5 measured); it
// does NOT turn `top` red. `top`'s key is the window's key minus the `id`, i.e. a PREFIX of an
// ordering host/challenge-board.ts has already produced, so the planner drops the outer Sort node
// and the rows come back in the window's total order — there is no heapsort left to be arbitrary.
// That is a property of one plan, not of the code, so the LAST test below asserts the tie-break on
// the emitted SQL instead: that assertion is the non-vacuous guard for the `top` branch, and the
// runtime walk above is what pins the other three.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { desc, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes, orderForSort } from '../src/routes/challenges';
import { rankedChallengeBoard } from '../src/host/challenge-board';
import { db, users, challenges, votes, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000cf90001';
const user: User = { id: UID, email: 'wshpage@test', name: 'Page Tester', roles: ['employee'], tenantId: UID };
const MARK = 'ZWSHPAGE';

// PAGE_SIZE is 10 in the route. 66 rows is six full pages plus a stub — enough boundaries that the
// heapsort depth differs on every one of them, and it is the count the reproduction was measured at.
const ROWS = 66;
const PAGE_SIZE = 10;
const PAGES = Math.ceil(ROWS / PAGE_SIZE);

// One instant for every row: this is the tie the route used to call a tie-break.
const TIED_AT = new Date('2024-06-01T00:00:00.000Z');
// Same votes for every row, and ZERO of them, so a leak into another file's board cannot crown
// these. `votes` stays empty too, which is what flattens the `trending` branch.
const TIED_VOTES = 0;
// A past week with no `marketplace_cycles` row — `backfillMissedCycles` only ever walks FORWARD
// from max(week), so nothing else in the suite can conjure one. Every row therefore lands in the
// same `closing` tier with the same `week`, flattening that branch too.
const WEEK = '2024-W05';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);

async function call(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(votes).where(inArray(votes.target_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(inArray(users.id, [UID]));
}

let fixtureIds: string[] = [];

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores bunfig's
// [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'PT' }).onConflictDoNothing();
  // ONE insert: identical `created_at` is the point, and passing it explicitly means the fixture
  // does not depend on the batch happening to share a transaction clock.
  const inserted = await db
    .insert(challenges)
    .values(
      Array.from({ length: ROWS }, (_, i) => ({
        title: `${MARK} ${String(i).padStart(3, '0')}`,
        work_area: 'Claims',
        submitter_id: UID,
        tenant_id: UID,
        status: 'voting' as const,
        votes_count: TIED_VOTES,
        week: WEEK,
        created_at: TIED_AT,
      })),
    )
    .returning({ id: challenges.id });
  fixtureIds = inserted.map((r) => r.id);
  asUser(user);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

/** Every id the caller is served by walking pages 1..PAGES of one sort, in page order. */
async function walkPages(sort: string): Promise<string[]> {
  const served: string[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const r = await call(`/api/challenges?q=${MARK}&sort=${sort}&page=${page}`);
    expect(r.status).toBe(200);
    // `total` comes from the counts query over the base table, so it is the honest denominator the
    // pager renders — assert the fixture is the whole board this query can see before trusting it.
    expect(r.json.total).toBe(ROWS);
    for (const item of r.json.items as { id: string }[]) served.push(item.id);
  }
  return served;
}

const SORTS = ['top', 'newest', 'trending', 'closing'] as const;

for (const sort of SORTS) {
  test(`sort=${sort}: paging a board tied on votes_count AND created_at serves every row exactly once`, async () => {
    const served = await walkPages(sort);

    const seen = new Map<string, number>();
    for (const id of served) seen.set(id, (seen.get(id) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
    const dropped = fixtureIds.filter((id) => !seen.has(id));

    // Named separately so a failure says WHICH way the boundary broke rather than "58 !== 66".
    expect({ repeated, dropped }).toEqual({ repeated: [], dropped: [] });
    expect(served).toHaveLength(ROWS);
    expect(seen.size).toBe(ROWS);
    expect([...seen.keys()].sort()).toEqual([...fixtureIds].sort());
  });
}

test('every sort emits the id tie-break as its LAST ORDER BY term', () => {
  // ON THE WIRE, not on the shape of the helper's return value: what makes paging exact is the SQL
  // Postgres is handed, and `asc(b.id)` reaching the string is the only proof of it. This is the
  // guard the `top` branch needs — the runtime walk above cannot fail for `top` under the plan
  // Postgres picks (see the header), so without this a deleted tie-break there would ship green.
  const board = rankedChallengeBoard();
  for (const sort of SORTS) {
    const { sql } = db
      .select({ id: board.id })
      .from(board)
      .orderBy(...orderForSort(sort, board))
      .toSQL();
    // `lastIndexOf` because the ranking subquery carries its own `over (order by …)` — the OUTER
    // list is the last one in the string, and it is the one that decides page membership.
    const orderBy = sql.slice(sql.lastIndexOf(' order by '));
    // The board is aliased `ranked`; the id column of THAT subquery, ascending, and nothing after
    // it. A term anywhere else in the list would not make the key total.
    expect([sort, orderBy.endsWith('"ranked"."id" asc')]).toEqual([sort, true]);
  }
});

test('the tie-break is what makes the key total — without it the same board is NOT totally ordered', async () => {
  // Non-vacuity, proved against the database rather than asserted: the fixture really does tie on
  // every column the old docstring called a tie-break, so there is a genuine defect for the term
  // above to fix. If a future fixture change made the rows distinct on either column, this fails
  // and the whole file is revealed as testing nothing.
  const board = rankedChallengeBoard();
  const rows = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .select({ id: board.id, votes_count: board.votes_count, created_at: board.created_at })
      .from(board)
      .orderBy(desc(board.votes_count)),
  );
  const fixture = rows.filter((r) => fixtureIds.includes(r.id));
  expect(fixture).toHaveLength(ROWS);
  const keys = new Set(fixture.map((r) => `${r.votes_count}|${new Date(r.created_at).toISOString()}`));
  expect(keys.size).toBe(1);
});
