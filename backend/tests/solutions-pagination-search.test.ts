// tests/solutions-pagination-search.test.ts — the rows the product HAS must be reachable.
//
// THE DEFECT. `/solutions` shows a leaderboard that pages at ten, and the page passed neither
// `page` nor `q`: it rendered the first ten rows and filtered THOSE TEN client-side. So on a
// challenge with fourteen entries, the builder at rank 14 did not exist as far as the product was
// concerned — the board stopped at ten with no pager, and typing their name into the search box
// answered "no solutions match your search". Both halves of that are fixed server-side here:
// `page` was always honoured by the route, `q` is new.
//
// ⚠️ THE FIXTURE MUST EXCEED THE PAGE SIZE OR THIS FILE IS DECORATIVE. With ten solutions and a
// page size of ten there is no page 2 to get wrong, no rank boundary to break, and every assertion
// below passes against the broken code. Fourteen rows is deliberate.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerSolutionRoutes } from '../src/routes/solutions';
import { db, users, challenges, solutions, votes, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (see tests/fixture-id-collisions.test.ts for why that matters).
const UID_A = '00000000-0000-0000-0000-00000c3a0001';
const UID_B = '00000000-0000-0000-0000-00000c3a0002';
const MARK = 'ZWS3PAGE';
const NEEDLE_AUTHOR = 'Zws3 Needlename Builder';
const NEEDLE_BLOCK = 'zws3-needle-block';
const NEEDLE_TITLE = 'needleword';

const caller: User = {
  id: UID_A,
  email: 'ws3page@test',
  name: 'Zws3 Ordinary Builder',
  roles: ['employee'],
  tenantId: DEMO_TENANT_ID,
};

const router = new Router();
registerSolutionRoutes(router);

async function call(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const req = new Request(`http://localhost${path}`);
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))
  ).map((r) => r.id);
  const solIds = chIds.length
    ? (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map(
        (r) => r.id,
      )
    : [];
  if (solIds.length) await db.delete(votes).where(inArray(votes.target_id, solIds));
  if (solIds.length) await db.delete(solutions).where(inArray(solutions.id, solIds));
  if (chIds.length) await db.delete(challenges).where(inArray(challenges.id, chIds));
  await db.delete(users).where(inArray(users.id, [UID_A, UID_B]));
}

let challengeId = '';
/** The 14 seeded solutions, most-voted first — the order the route returns them in. */
const seeded: { id: string; title: string; rank: number }[] = [];

beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => caller, requireRole: async () => caller });
  await db
    .insert(users)
    .values([
      { id: UID_A, email: caller.email, name: caller.name, avatar_initials: 'ZO' },
      { id: UID_B, email: 'ws3needle@test', name: NEEDLE_AUTHOR, avatar_initials: 'ZN' },
    ])
    .onConflictDoNothing();
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} board`, work_area: 'Claims', submitter_id: UID_A, tenant_id: DEMO_TENANT_ID })
    .returning();
  challengeId = c!.id;

  // 14 rows > PAGE_SIZE (10). Distinct vote counts make the ordering total, so ranks are exact.
  // The three needles sit at ranks 12/13/14 — i.e. ONLY on page 2, where the old client-side
  // filter could never have seen them.
  for (let i = 0; i < 14; i++) {
    const rank = i + 1;
    const isTitleNeedle = rank === 12;
    const isAuthorNeedle = rank === 13;
    const isBlockNeedle = rank === 14;
    const [row] = await db
      .insert(solutions)
      .values({
        challenge_id: challengeId,
        title: isTitleNeedle ? `${MARK} ${NEEDLE_TITLE} entry` : `${MARK} entry ${rank}`,
        author_id: isAuthorNeedle ? UID_B : UID_A,
        status: 'voting',
        week: '2026-W30',
        blocks_used: isBlockNeedle ? ['zws3-plain-block', NEEDLE_BLOCK] : ['zws3-plain-block'],
        votes_count: 100 - rank,
        tenant_id: DEMO_TENANT_ID,
      })
      .returning();
    seeded.push({ id: row!.id, title: row!.title, rank });
  }
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('page 2 returns rows page 1 did not, with ranks continuous across the boundary', async () => {
  const p1 = await call(`/api/solutions?challenge_id=${challengeId}`);
  const p2 = await call(`/api/solutions?challenge_id=${challengeId}&page=2`);
  expect(p1.status).toBe(200);
  expect(p2.status).toBe(200);

  expect(p1.json.total).toBe(14);
  expect(p2.json.total).toBe(14);
  expect(p1.json.items).toHaveLength(10);
  expect(p2.json.items).toHaveLength(4);

  const ids1 = p1.json.items.map((r: { id: string }) => r.id);
  const ids2 = p2.json.items.map((r: { id: string }) => r.id);
  // Without `.offset(...)` page 2 is a second copy of page 1 — the whole point of the pager.
  expect(ids2.filter((id: string) => ids1.includes(id))).toEqual([]);

  // Ranks are the reader's contract: 1…10 then 11…14, with no repeat and no gap at the seam.
  expect(p1.json.items.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(p2.json.items.map((r: { rank: number }) => r.rank)).toEqual([11, 12, 13, 14]);

  // …and they are the rows we seeded, in vote order, not merely fourteen rows in some order.
  expect([...ids1, ...ids2]).toEqual(seeded.map((s) => s.id));
});

test('the parent-challenge fields are present on every row, on both pages', async () => {
  // ⚠️ WHAT THIS DOES AND DOES NOT PROVE — read before trusting it.
  //
  // IT PROVES: `challengeId` and `challengeStatus` reach every row of both pages, and that adding
  // them did not disturb the ranks and totals the assertions above pin.
  //
  // ⛔ IT DOES **NOT** PROVE THE JOIN IS PLACED SAFELY. An adversarial pass replaced the shipped
  // implementation with the form the route's comments forbid (`innerJoin` inside the `ranked`
  // subquery, outer leftJoin deleted) and this suite stayed 10/0 green. It cannot discriminate:
  // this file connects as the table OWNER (`rolsuper=t, rolbypassrls=t`) and neither table has
  // `FORCE ROW LEVEL SECURITY`, so RLS — the only mechanism that makes the two forms differ — is
  // inert here. Every parent is visible, so an inner join drops nothing.
  //
  // THE DISCRIMINATING GUARD IS tests/solutions-parent-join-rls.test.ts, which drives the same route
  // under `SET ROLE cp_app` with a cross-tenant fixture. If you are changing that join, that is the
  // file that will tell you.
  const p1 = await call(`/api/solutions?challenge_id=${challengeId}`);
  const p2 = await call(`/api/solutions?challenge_id=${challengeId}&page=2`);

  for (const r of [...p1.json.items, ...p2.json.items]) {
    expect(r.challengeId).toBe(challengeId);
    expect(r.challengeStatus).not.toBeNull();
    // ⛔ TWO DIFFERENT FIELDS. `closeCycle` leaves losing solutions at 'voting' forever, so the
    // browser must never substitute one for the other.
    expect(r).toHaveProperty('status');
    expect(r).toHaveProperty('challengeStatus');
  }
});

test('the solution detail carries the parent’s status and week, distinct from its own', async () => {
  const target = seeded[0]!;
  const res = await call(`/api/solutions/${target.id}`);
  expect(res.status).toBe(200);
  expect(res.json.challenge.id).toBe(challengeId);
  // The fields the vote surface needs. `week` here is the CHALLENGE's cycle week — deliberately not
  // `res.json.week`, which is `laterWeek(weekString(now), ch.week)` at insert time (the week the
  // SOLUTION competes in, rolled forward when it answers an older challenge). Reaching for the
  // solution's own week as a stand-in is wrong in exactly the cases that matter.
  expect(typeof res.json.challenge.status).toBe('string');
  expect(typeof res.json.challenge.week).toBe('string');
});

test('?q= finds a title that exists ONLY on page 2', async () => {
  const target = seeded.find((s) => s.rank === 12)!;
  const p1 = await call(`/api/solutions?challenge_id=${challengeId}`);
  // Precondition: it really is unreachable from page 1, or this test proves nothing.
  expect(p1.json.items.map((r: { id: string }) => r.id)).not.toContain(target.id);

  const res = await call(`/api/solutions?challenge_id=${challengeId}&q=${NEEDLE_TITLE}`);
  expect(res.status).toBe(200);
  expect(res.json.items.map((r: { id: string }) => r.id)).toEqual([target.id]);
});

test('?q= matches an AUTHOR NAME', async () => {
  const target = seeded.find((s) => s.rank === 13)!;
  const res = await call(`/api/solutions?challenge_id=${challengeId}&q=${encodeURIComponent('needlename')}`);
  expect(res.status).toBe(200);
  expect(res.json.items.map((r: { id: string }) => r.id)).toEqual([target.id]);
  expect(res.json.items[0].author.name).toBe(NEEDLE_AUTHOR);
  // The title does NOT contain the term, so only the author arm of the predicate can have matched.
  expect(res.json.items[0].title).not.toContain('eedlename');
});

test('?q= matches a BLOCK SLUG', async () => {
  const target = seeded.find((s) => s.rank === 14)!;
  const res = await call(`/api/solutions?challenge_id=${challengeId}&q=${NEEDLE_BLOCK}`);
  expect(res.status).toBe(200);
  expect(res.json.items.map((r: { id: string }) => r.id)).toEqual([target.id]);
  expect(res.json.items[0].blocksUsed).toContain(NEEDLE_BLOCK);
});

test('?q= narrows `total` too, and the count query survives an author-name predicate', async () => {
  // THE COUNT-JOIN TRAP. The rows query joins `users`; the count query used to select from
  // `solutions` alone. Sharing one `where` that mentions `users.name` therefore either explodes
  // ("missing FROM-clause entry for table users" → 500) or, if the predicate is quietly dropped
  // from the count, returns `total: 14` for a one-row result — a pager promising pages that do
  // not exist. A 200 with the honest total is the only passing shape.
  const byTitle = await call(`/api/solutions?challenge_id=${challengeId}&q=${NEEDLE_TITLE}`);
  expect(byTitle.status).toBe(200);
  expect(byTitle.json.total).toBe(1);

  const byAuthor = await call(`/api/solutions?challenge_id=${challengeId}&q=${encodeURIComponent('needlename')}`);
  expect(byAuthor.status).toBe(200);
  expect(byAuthor.json.total).toBe(1);

  const byBlock = await call(`/api/solutions?challenge_id=${challengeId}&q=${NEEDLE_BLOCK}`);
  expect(byBlock.status).toBe(200);
  expect(byBlock.json.total).toBe(1);

  // A term matching every seeded row still reports the full set (the predicate narrows, it does
  // not simply always return 1).
  const all = await call(`/api/solutions?challenge_id=${challengeId}&q=${MARK}`);
  expect(all.json.total).toBe(14);
  expect(all.json.items).toHaveLength(10);
});

test('rank under ?q= is the row\'s TRUE board rank, not its position in the result set', async () => {
  // THE REGRESSION THIS PINS. `rank` used to be `(page-1)*PAGE_SIZE + i + 1` — the row's offset
  // into the RESPONSE. That was true while the only filter was the challenge. The moment `q`
  // joined the predicate it became a lie: searching for the builder at rank 14 returned their row
  // as the single hit and the board stamped a coral "#1" on it. A search box that fabricates a
  // leaderboard is worse than the unreachable row it was added to fix.
  //
  // Ground truth first: the ranks the board reports with NO search at all.
  const p1 = await call(`/api/solutions?challenge_id=${challengeId}`);
  const p2 = await call(`/api/solutions?challenge_id=${challengeId}&page=2`);
  const unfiltered = new Map<string, number>(
    [...p1.json.items, ...p2.json.items].map((r: { id: string; rank: number }) => [r.id, r.rank]),
  );
  expect(unfiltered.size).toBe(14);

  // …then the same rows again, this time reached ONLY through a search. Each needle is the sole
  // hit for its term, so under the old arithmetic every one of them came back as `rank: 1`.
  for (const [term, seededRank] of [
    [NEEDLE_TITLE, 12],
    ['needlename', 13],
    [NEEDLE_BLOCK, 14],
  ] as const) {
    const res = await call(`/api/solutions?challenge_id=${challengeId}&q=${encodeURIComponent(term)}`);
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    const hit = res.json.items[0] as { id: string; rank: number };
    expect(hit.rank).not.toBe(1);
    expect(hit.rank).toBe(seededRank);
    expect(unfiltered.get(hit.id)).toBe(hit.rank);
  }
});

test('a search that matches MANY rows reports each one\'s own board rank, with the gaps intact', async () => {
  // The single-hit case above could be satisfied by any number that is not 1. This one cannot:
  // the three needles are ranks 12/13/14 out of fourteen and a fourth term is deliberately NOT
  // matched, so a result set of three rows must report 12, 13, 14 — never 1, 2, 3.
  const res = await call(`/api/solutions?challenge_id=${challengeId}&q=needle`);
  expect(res.status).toBe(200);
  expect(res.json.total).toBe(3);
  expect(res.json.items.map((r: { rank: number }) => r.rank)).toEqual([12, 13, 14]);

  // And a search matching a NON-CONTIGUOUS slice keeps the holes: entry 2 and entry 11 are ranks
  // 2 and 11, not 1 and 2. (`entry 1` would also prefix-match `entry 11`/`entry 12`…, so the two
  // terms are chosen to be unambiguous.)
  const sparse = await call(`/api/solutions?challenge_id=${challengeId}&q=${encodeURIComponent('entry 1')}`);
  // `entry 1`, `entry 10`…`entry 14` — but rank 12 is the TITLE needle, which has no "entry N".
  expect(sparse.json.items.map((r: { rank: number }) => r.rank)).toEqual([1, 10, 11, 13, 14]);
});

test('ranks are continuous across a PAGED search — page 2 of a search does not restart at 1', async () => {
  // `?q=MARK` matches all fourteen. Page 2 of THAT search must be ranks 11–14, the same numbers
  // page 2 of the unsearched board shows. The old arithmetic happened to be right here (the
  // predicate matched everything), which is exactly why the single-hit test above is the load-
  // bearing one — this test guards the other direction: the window must not restart per page.
  const s2 = await call(`/api/solutions?challenge_id=${challengeId}&q=${MARK}&page=2`);
  expect(s2.status).toBe(200);
  expect(s2.json.items.map((r: { rank: number }) => r.rank)).toEqual([11, 12, 13, 14]);
});
