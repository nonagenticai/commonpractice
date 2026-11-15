// tests/challenges.test.ts — marketplace Challenges routes (Session 5).
// list (filter by work_area/status/q + per-domain counts + rank), create (submit),
// detail (ranked solutions + similar + hasVoted), and the comment thread. Test rows
// are isolated from the seeded demo data by a unique title marker used as ?q=.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { db, users, challenges, solutions, comments, votes, marketplaceCycles, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { closeCycle, enterSolutionPhase, openCycle, weekStart, weekString } from '../src/host/cycle-service';
import type { User } from '../src/types';
import { ensureTenants } from './helpers/cycle-period';

const UID = '00000000-0000-0000-0000-00000c100001';
const user: User = { id: UID, email: 'chtest@test', name: 'Chris Tester', roles: ['employee'], tenantId: UID };
const MARK = 'ZCHTEST';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
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

async function makeChallenge(workArea: string, votes_count: number, status: 'voting' | 'solution_phase' | 'closed' = 'voting') {
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} ${workArea} ${votes_count}`, work_area: workArea, submitter_id: UID, tenant_id: UID, status, votes_count, week: '2026-W21' })
    .returning();
  return c!;
}

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(votes).where(inArray(votes.target_id, ids));
    await db.delete(comments).where(inArray(comments.challenge_id, ids));
    await db.delete(solutions).where(inArray(solutions.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(users).where(eq(users.id, UID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name, avatar_initials: 'CT' }).onConflictDoNothing();
  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(() => asUser(user));

test('list returns per-domain counts, rank, and filters by work_area + status', async () => {
  await makeChallenge('Claims', 300);
  await makeChallenge('Claims', 150);
  await makeChallenge('Sales', 200);
  await makeChallenge('Legal', 90, 'closed');

  const all = await call('GET', `/api/challenges?q=${MARK}`);
  expect(all.status).toBe(200);
  expect(all.json.counts.all).toBe(4);
  expect(all.json.counts.Claims).toBe(2);
  expect(all.json.counts.Sales).toBe(1);
  // top sort → highest votes first, rank starts at 1.
  expect(all.json.items[0].votesCount).toBe(300);
  expect(all.json.items[0].rank).toBe(1);

  const claims = await call('GET', `/api/challenges?q=${MARK}&work_area=Claims`);
  expect(claims.json.total).toBe(2);
  expect(claims.json.items.every((i: { workArea: string }) => i.workArea === 'Claims')).toBe(true);

  const closed = await call('GET', `/api/challenges?q=${MARK}&status=closed`);
  expect(closed.json.items).toHaveLength(1);
  expect(closed.json.items[0].status).toBe('closed');
});

test('newest sort orders by creation, not votes', async () => {
  const top = await call('GET', `/api/challenges?q=${MARK}&sort=newest`);
  // The most-recently created marker challenge is the Legal/closed one.
  expect(top.json.items[0].workArea).toBe('Legal');
});

test('off-list work_area still appears in counts so the per-domain counts sum to counts.all (A3)', async () => {
  // A legacy/off-canonical work_area (like CH-243's) must not vanish into "All": it gets its own
  // count key, and the per-domain counts always sum to counts.all so the chips can never under-count.
  await makeChallenge('Finance', 42); // not one of the 8 canonical WORK_AREAS
  const r = await call('GET', `/api/challenges?q=${MARK}`);
  expect(r.status).toBe(200);
  const counts: Record<string, number> = r.json.counts;
  expect(counts.Finance ?? 0).toBe(1);
  const perDomainSum = Object.entries(counts)
    .filter(([k]) => k !== 'all')
    .reduce((s, [, n]) => s + n, 0);
  expect(perDomainSum).toBe(counts.all ?? 0);
});

test('create rejects an off-canonical work_area (A3 write-side guard)', async () => {
  const bad = await call('POST', '/api/challenges', {
    title: `${MARK} bad domain`,
    description: 'a real frustration',
    work_area: 'Finance',
  });
  expect(bad.status).toBe(422); // schema validation rejection
});

test('create a challenge then read it back in the detail view', async () => {
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} brand new`,
    description: 'a real frustration',
    business_impact: 'lots of people',
    work_area: 'Ops',
    metrics: { timeSavedPerWeek: '~1 hr' },
    tags: ['x', 'y'],
  });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  expect(created.json.status).toBe('voting');
  // `code` was left null on every user-submitted challenge (only the seeds set one), so the CH-
  // badge was blank. `week` is asserted in the two cycle-phase tests below, which pin the phase
  // rather than depending on which day of the week the suite happens to run.
  expect(created.json.code).toMatch(/^CH-\d+$/);
  expect(created.json.week).toMatch(/^\d{4}-W\d{2}$/);

  const detail = await call('GET', `/api/challenges/${id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.title).toBe(`${MARK} brand new`);
  expect(detail.json.metrics.timeSavedPerWeek).toBe('~1 hr');
  expect(detail.json.tags).toEqual(['x', 'y']);
  expect(detail.json.hasVoted).toBe(false);
  expect(detail.json.solutions).toEqual([]);
});

test('concurrent submits each get a distinct CH- code (the max+1 allocator is race-safe)', async () => {
  // The allocator reads max(code)+1 and inserts; six submits landing together all read the same
  // max. Without the (tenant_id, code) unique index + retry, five of them would silently share a
  // badge (or 500). Proven here rather than argued: the index is what makes the retry meaningful.
  const N = 6;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call('POST', '/api/challenges', { title: `${MARK} race ${i}`, description: 'd', work_area: 'Ops' }),
    ),
  );
  expect(results.map((r) => r.status)).toEqual(Array(N).fill(201));
  const codes = results.map((r) => r.json.code as string);
  expect(codes.every((c) => /^CH-\d+$/.test(c))).toBe(true);
  expect(new Set(codes).size).toBe(N);
});

test('the CH- code space is PER TENANT — two tenants both start at CH-1', async () => {
  // A globally-unique code (or a global sequence) would hand the second tenant CH-2 and leak the
  // platform's challenge volume into a tenant-visible badge. Fresh tenants, so the counts are exact.
  const T1 = '00000000-0000-0000-0000-00000c10f001';
  const T2 = '00000000-0000-0000-0000-00000c10f002';
  asUser({ ...user, tenantId: T1 });
  const a = await call('POST', '/api/challenges', { title: `${MARK} t1 first`, description: 'd', work_area: 'Ops' });
  asUser({ ...user, tenantId: T2 });
  const b = await call('POST', '/api/challenges', { title: `${MARK} t2 first`, description: 'd', work_area: 'Ops' });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.json.code).toBe('CH-1');
  expect(b.json.code).toBe('CH-1');
  expect(a.json.tenant_id).toBe(T1);
  expect(b.json.tenant_id).toBe(T2);
});

const DAY_MS = 24 * 60 * 60 * 1000;
const thisWeek = () => weekString(new Date());
const nextWeek = () => weekString(new Date(weekStart(thisWeek()).getTime() + 7 * DAY_MS));

/**
 * Pin the REAL current week's cycle row into a given shape and return an undo. The submission-week
 * rule reads that row, so the two tests below have to control it or they would silently assert a
 * different branch depending on which weekday the suite runs. Only the one row is touched (never
 * `enterSolutionPhase`, which would cascade over every other challenge in the shared dev DB).
 */
async function pinCurrentCycle(phase: 'voting' | 'solution_phase', votingEndsAt: Date) {
  // 0110: cycles are per tenant — pin the CREATOR's tenant's row (`user.tenantId` = UID; the route
  // stamps the challenge with the caller's tenant and resolves THAT tenant's cycle).
  const week = thisWeek();
  await ensureTenants([UID]);
  const mine = and(eq(marketplaceCycles.tenant_id, UID), eq(marketplaceCycles.week, week));
  const [prior] = await db.select().from(marketplaceCycles).where(mine);
  await openCycle(week, UID);
  await db.update(marketplaceCycles).set({ phase, voting_ends_at: votingEndsAt }).where(mine);
  return async () => {
    if (prior) {
      await db
        .update(marketplaceCycles)
        .set({ phase: prior.phase, voting_ends_at: prior.voting_ends_at, closed_at: prior.closed_at })
        .where(mine);
    } else {
      await db.delete(marketplaceCycles).where(mine);
    }
  };
}

test('a challenge submitted while the voting window is open joins the RUNNING week', async () => {
  const undo = await pinCurrentCycle('voting', new Date(Date.now() + 2 * DAY_MS));
  try {
    const r = await call('POST', '/api/challenges', { title: `${MARK} early submit`, description: 'd', work_area: 'Ops' });
    expect(r.status).toBe(201);
    expect(r.json.week).toBe(thisWeek());
  } finally {
    await undo();
  }
});

test('a huge CH- code neither breaks challenge creation nor wedges the allocator', async () => {
  // The allocator casts the numeric part of every CH- code. Unbounded with ::int it raises
  // `value "99999999999" is out of range for type integer` and turns EVERY submit in that tenant
  // into a 500 — and the same cast sits in migration 0047, which runs at backend BOOT, so there it
  // aborts the migration instead. So the capture is bounded and the cast is total.
  //
  // The bound is 18 digits with ::bigint, NOT 9 with ::int, and that difference is the point: a
  // bound the allocator can CROSS is worse than the crash it replaces. At CH-999999999 a 9-digit
  // bound yields CH-1000000000 — invisible to the very pattern that generated it — so the next
  // call re-proposes the same code forever: 23505, retries exhausted, a permanent silent 500 on
  // every submit in that tenant. max+1 can never reach 19 digits, so the sequence stays
  // self-consistent, and a wide code is counted rather than skipped (no duplicate risk either).
  const T = '00000000-0000-0000-0000-00000c10f003';
  await db
    .insert(challenges)
    .values({ title: `${MARK} wide code`, work_area: 'Ops', submitter_id: UID, tenant_id: T, code: 'CH-99999999999' });
  asUser({ ...user, tenantId: T });
  const r = await call('POST', '/api/challenges', { title: `${MARK} after wide`, description: 'd', work_area: 'Ops' });
  expect(r.status).toBe(201);
  expect(r.json.code).toBe('CH-100000000000');

  // Crossing the old int4 boundary twice in a row: each code must be NEW, not the same one again.
  const T2 = '00000000-0000-0000-0000-00000c10f004';
  await db
    .insert(challenges)
    .values({ title: `${MARK} int4 edge`, work_area: 'Ops', submitter_id: UID, tenant_id: T2, code: 'CH-999999999' });
  asUser({ ...user, tenantId: T2 });
  const a = await call('POST', '/api/challenges', { title: `${MARK} past edge 1`, description: 'd', work_area: 'Ops' });
  const b = await call('POST', '/api/challenges', { title: `${MARK} past edge 2`, description: 'd', work_area: 'Ops' });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.json.code).toBe('CH-1000000000');
  expect(b.json.code).toBe('CH-1000000001');
});

test("a challenge submitted after the week's voting window rolls into the NEXT cycle", async () => {
  // The dead-week regression. A challenge is voted on during the cycle's `voting` phase only; with
  // the default 4+3 cadence that is Mon 00:00 → Fri 00:00 UTC. Stamping the running week for a
  // Friday-to-Sunday submission (3 of every 7 days) meant `enterSolutionPhase` had already run, so
  // the row sat in `voting` until the next close swept it straight to `closed` hours later — no
  // voting window, no solution window, nobody ever saw it.
  const next = nextWeek();
  const undo = await pinCurrentCycle('solution_phase', new Date(Date.now() - 1 * DAY_MS));
  try {
    const created = await call('POST', '/api/challenges', { title: `${MARK} late submit`, description: 'd', work_area: 'Ops' });
    expect(created.status).toBe(201);
    expect(created.json.week).toBe(next);
    expect(created.json.week).not.toBe(thisWeek());

    // …and it really does get the full cycle: the next week opens in `voting` with the challenge in
    // it, and `enterSolutionPhase` genuinely transitions that cycle row — proving it HELD a voting
    // window. The challenge's OWN status no longer follows the calendar (that invariant moved to
    // routes/solutions.ts, set on first solution submit): with no solution filed here it stays
    // `voting`. Before the fix the row went voting → closed at the very next tick without ever
    // getting a voting window at all. THAT is what this test protects, and it still holds.
    const cycle = await openCycle(next, UID);
    expect(cycle.phase).toBe('voting');
    expect(await enterSolutionPhase(next, UID)).toBe(true);
    const [mid] = await db.select().from(challenges).where(eq(challenges.id, created.json.id));
    expect(mid!.status).toBe('voting');
    // ⛔ AND CLOSING THE CYCLE NO LONGER CLOSES THE CHALLENGE. The weekly competition ends; the work
    // does not. A challenge stays open until something explicitly closes it, so a late submitter is
    // not punished twice — once by missing the window, and again by the board forgetting the row.
    await closeCycle(next, UID);
    const [end] = await db.select().from(challenges).where(eq(challenges.id, created.json.id));
    expect(end!.status).not.toBe('closed');
  } finally {
    await db.delete(marketplaceCycles).where(eq(marketplaceCycles.week, next));
    await undo();
  }
});

test('create dedupes duplicate tags (guards the each_key_duplicate render crash)', async () => {
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} dup tags`,
    description: 'a real frustration',
    business_impact: 'lots of people',
    work_area: 'Ops',
    tags: ['a', 'a', 'b', 'a'],
  });
  expect(created.status).toBe(201);
  const detail = await call('GET', `/api/challenges/${created.json.id}`);
  // first-seen order preserved, no duplicate keys reach the value-keyed chip render.
  expect(detail.json.tags).toEqual(['a', 'b']);
});

test('detail ranks its solutions and lists similar challenges', async () => {
  const host = await makeChallenge('Risk', 120);
  const other = await makeChallenge('Risk', 80); // same work_area → "similar"
  await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values([
    { challenge_id: host.id, title: `${MARK} sol-lo`, author_id: UID, votes_count: 10, blocks_used: ['ai-summarize'] },
    { challenge_id: host.id, title: `${MARK} sol-hi`, author_id: UID, votes_count: 50, blocks_used: ['read-claim-form'] },
  ]));

  const detail = await call('GET', `/api/challenges/${host.id}`);
  expect(detail.json.solutions[0].title).toBe(`${MARK} sol-hi`);
  expect(detail.json.solutions[0].rank).toBe(1);
  expect(detail.json.similar.some((s: { id: string }) => s.id === other.id)).toBe(true);
  expect(detail.json.similar.some((s: { id: string }) => s.id === host.id)).toBe(false);
});

test('detail on a missing challenge is 404', async () => {
  const r = await call('GET', '/api/challenges/00000000-0000-0000-0000-00000cffffff');
  expect(r.status).toBe(404);
});

test('comments: list is empty, post grows the thread', async () => {
  const c = await makeChallenge('IT', 33);
  const empty = await call('GET', `/api/challenges/${c.id}/comments`);
  expect(empty.json.total).toBe(0);

  const posted = await call('POST', `/api/challenges/${c.id}/comments`, { body: 'first reply' });
  expect(posted.status).toBe(201);
  expect(posted.json.body).toBe('first reply');
  expect(posted.json.author.name).toBe('Chris Tester');

  const after = await call('GET', `/api/challenges/${c.id}/comments`);
  expect(after.json.total).toBe(1);
  expect(after.json.items[0].body).toBe('first reply');
});

test('posting a comment to a missing challenge is 404', async () => {
  const r = await call('POST', '/api/challenges/00000000-0000-0000-0000-00000cffffff/comments', { body: 'hi' });
  expect(r.status).toBe(404);
});
