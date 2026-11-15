// tests/challenge-sorts.test.ts — the two leaderboard sort chips that did nothing.
//
// THE DEFECT THIS PINS. `/challenges` offers four sorts — top | newest | trending | closing — and
// all four are translated in all 8 catalogs. The route accepted all four and then did:
//
//   sort === 'newest' ? [desc(created_at)] : [desc(votes_count), desc(created_at)]
//
// so `trending` and `closing` fell into the `top` branch and produced BYTE-IDENTICAL ordering:
// two of the four chips redrew the board with the same rows in the same order, forever.
//
// TWO FURTHER FAULTS in the first `closing` fix, both pinned below.
//
//  (b) IT RANKED THE MOST-EXPIRED FIRST. The guard was `challenges.status = 'closed'`, which is a
//      different fact from "its week is over": the cycle engine closes CYCLES, and a challenge
//      keeps `status='voting'` until something closes it. So a challenge whose cycle ended eight
//      weeks ago was still "not closed", had the SMALLEST `closes_at`, and sorted ABOVE one
//      closing tonight — the chip ran exactly backwards. The fixture below carries one FUTURE
//      boundary and one eight-weeks-stale boundary, both on `status='voting'` rows.
//
//  (a) IT COLLAPSED BACK ONTO `top` WITH NO CYCLE ROWS. `marketplace_cycles` is EMPTY on a freshly
//      migrated+seeded database, so every `closes_at` was NULL, every row fell through to the
//      `votes_count` tie-break, and `closing === top` byte for byte. The last test pins a set of
//      challenges whose weeks have no cycle row at all.
//
// The fixtures make the four orderings genuinely disagree — recent votes vs all-time votes, and
// cycle boundary vs vote count — so an ordering that has collapsed back onto `top` cannot pass.
import { cyclePeriodCols } from './helpers/cycle-period';
import { ensureTenants } from './helpers/cycle-period';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { db, users, challenges, votes, marketplaceCycles, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-00000c5f0001';
const user: User = { id: UID, email: 'ws5sorts@test', name: 'Sort Tester', roles: ['employee'], tenantId: UID };
const MARK = 'ZWS5SORT';
// A SECOND marker so the fresh-install (no cycle rows anywhere) board is queried on its own and
// does not disturb the three-row fixture above.
const MARK_FRESH = 'ZWS5FRESH';

// Voter pool — `votes` is unique on (user, target_type, target_id), so N votes on one challenge
// need N distinct users.
const VOTER_PREFIX = '00000000-0000-0000-0000-00000c5f10';
const VOTERS = Array.from({ length: 12 }, (_, i) => `${VOTER_PREFIX}${String(i).padStart(2, '0')}`);

// Past weeks with explicitly CLOSED cycle rows: `tickCycles` only walks `phase != 'closed'` and
// back-fills forward from max(week), so these are inert for the rest of the suite.
const WEEK_STALE = '2025-W02'; // cycle boundary EIGHT WEEKS in the past
const WEEK_SOON = '2025-W03'; // cycle boundary in the FUTURE — the one genuinely closing
// Weeks with NO marketplace_cycles row. All EARLIER than the two above, because
// `backfillMissedCycles` only ever walks FORWARD from max(week) — it can never conjure a row for
// these, whatever else in the suite ticks the engine.
const WEEK_NO_CYCLE = '2024-W40';
// Three more no-cycle weeks — the fresh-install shape (fault (a)), where the engine has opened
// nothing at all and every `closes_at` is NULL.
const FRESH_WEEKS = ['2024-W10', '2024-W20', '2024-W30'];

const DAY = 24 * 60 * 60 * 1000;

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);

async function call(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Titles are the identity used in assertions; `?q=MARK` isolates them from the seeded board. */
async function makeChallenge(tag: string, votesCount: number, week: string, createdAt: Date, mark = MARK) {
  const [c] = await db
    .insert(challenges)
    .values({
      title: `${mark} ${tag}`,
      work_area: 'Claims',
      submitter_id: UID,
      tenant_id: UID,
      status: 'voting',
      votes_count: votesCount,
      week,
      created_at: createdAt,
    })
    .returning();
  return c!;
}

/** `n` real vote rows on a challenge, all cast `daysAgo` days ago. */
async function castVotes(challengeId: string, n: number, daysAgo: number, voterOffset: number) {
  const created = new Date(Date.now() - daysAgo * DAY);
  for (let i = 0; i < n; i++) {
    await db.insert(votes).values({
      user_id: VOTERS[voterOffset + i]!,
      tenant_id: UID,
      target_type: 'challenge',
      target_id: challengeId,
      created_at: created,
    });
  }
}

async function cleanup() {
  const ids = (
    await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(or(like(challenges.title, `${MARK}%`), like(challenges.title, `${MARK_FRESH}%`)))
  ).map((r) => r.id);
  if (ids.length) {
    await db.delete(votes).where(inArray(votes.target_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.week, [WEEK_STALE, WEEK_SOON]));
  await db.delete(users).where(inArray(users.id, [UID, ...VOTERS]));
}

/** A cycle row in the phase it would really be in at `closesAt` relative to now, so the fixture
 *  cannot pass by accident on a `status`/`phase` shortcut. A future boundary is a LIVE cycle
 *  (`voting`); a past one is `closed`. Both are inert for the rest of the suite: `tickCycles`
 *  walks `phase != 'closed'` and would leave the live one alone (its voting_ends_at is also in
 *  the future), and back-fills only forward from max(week). */
function cycleRow(week: string, closesAt: Date) {
  const past = closesAt.getTime() < Date.now();
  return {
    // 0110: the cycle rows are per tenant — these belong to the challenges' tenant (UID).
    tenant_id: UID,
    ...cyclePeriodCols(week),
    phase: past ? ('closed' as const) : ('voting' as const),
    // For a live cycle both boundaries stay in the future, so a `tickCycles` from elsewhere in
    // the suite cannot advance it out from under the assertions.
    voting_ends_at: past
      ? new Date(closesAt.getTime() - 3 * DAY)
      : new Date((Date.now() + closesAt.getTime()) / 2),
    solution_ends_at: closesAt,
    closes_at: closesAt,
    closed_at: past ? closesAt : null,
  };
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: user.email, name: user.name }).onConflictDoNothing();
  for (const [i, id] of VOTERS.entries()) {
    await db.insert(users).values({ id, email: `ws5voter${i}@test`, name: `Voter ${i}` }).onConflictDoNothing();
  }
  await ensureTenants([UID]);
  await db.insert(marketplaceCycles).values([
    // Eight weeks STALE — the boundary is long past, but nothing set the challenge's own
    // `status` to 'closed', which is precisely how the old guard was fooled.
    cycleRow(WEEK_STALE, new Date(Date.now() - 56 * DAY)),
    // Closing SOON — a real, live boundary a few hours out.
    cycleRow(WEEK_SOON, new Date(Date.now() + 6 * 60 * 60 * 1000)),
  ]);

  // The three rows disagree on every axis, so each of the four sorts has to produce its own
  // distinct order:                votes_count | recent votes | cycle closes  | created
  //   old-guard                            500 |            0 | 56 DAYS AGO   | Jan 8
  //   surging                               10 |            6 | (no cycle)    | Jan 9
  //   closing-soon                         100 |            0 | IN 6 HOURS    | Jan 10
  // All three are `status='voting'` (makeChallenge), so a guard keyed on `status = 'closed'`
  // cannot separate them at all — which is the bug.
  const oldGuard = await makeChallenge('old-guard', 500, WEEK_STALE, new Date('2025-01-08T00:00:00Z'));
  await castVotes(oldGuard.id, 4, 40, 0); // all-time leader, but every vote is 40 days old
  const surging = await makeChallenge('surging', 10, WEEK_NO_CYCLE, new Date('2025-01-09T00:00:00Z'));
  await castVotes(surging.id, 6, 0, 4); // few all-time votes, all of them cast today
  const closingSoon = await makeChallenge('closing-soon', 100, WEEK_SOON, new Date('2025-01-10T00:00:00Z'));
  await castVotes(closingSoon.id, 1, 20, 10); // middling everywhere, but its cycle closes tonight

  // Fault (a): the fresh-install shape. Three challenges whose weeks have NO cycle row, so every
  // `closes_at` is NULL — as it is on a freshly migrated+seeded database, where
  // `marketplace_cycles` is empty. Votes ASCEND as the week ASCENDS, so `closing` (earliest week
  // first) and `top` (most votes first) are exact reverses: they can only agree if `closing` has
  // collapsed back onto the votes tie-break, which is what it did.
  for (const [i, week] of FRESH_WEEKS.entries()) {
    await makeChallenge(`fresh${i}`, 100 + i * 100, week, new Date(`2024-0${i + 1}-01T00:00:00Z`), MARK_FRESH);
  }

  asUser(user);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

/** The board's rows, as bare tags, for `?sort=`. */
async function order(sort: string, mark = MARK): Promise<string[]> {
  const { status, json } = await call('GET', `/api/challenges?q=${mark}&sort=${sort}`);
  expect(status).toBe(200);
  return json.items.map((i: { title: string }) => i.title.replace(`${mark} `, ''));
}

test('trending ranks by RECENT votes, and differs from top', async () => {
  const top = await order('top');
  const trending = await order('trending');

  expect(top).toEqual(['old-guard', 'closing-soon', 'surging']);
  // 6 votes cast today beats 4 votes cast 40 days ago; the two challenges with nothing in the
  // window fall back to the all-time count.
  expect(trending).toEqual(['surging', 'old-guard', 'closing-soon']);
  expect(trending).not.toEqual(top);
});

test('closing puts the challenge closing TONIGHT above one whose cycle ended 8 weeks ago', async () => {
  const top = await order('top');
  const closing = await order('closing');

  // The order of the three tiers:
  //   closing-soon — a real boundary 6 hours out. Genuinely closing; first.
  //   surging      — no cycle row for its week, so no boundary exists to compare. Not hidden,
  //                  cannot outrank a real deadline, but ranks above the already-over: a week
  //                  the engine has yet to open is still live.
  //   old-guard    — boundary passed 8 weeks ago. Nothing left to close; last.
  //
  // Under the previous `challenges.status = 'closed'` guard old-guard is not "closed" (nothing
  // ever set that column), so it tied with closing-soon on the first key and then WON on
  // `closes_at ASC` by 8 weeks — the most-expired row sorted first, which is the whole defect.
  expect(closing).toEqual(['closing-soon', 'surging', 'old-guard']);
  expect(closing).not.toEqual(top);
});

test('closing returns ONE row per challenge when the tenant has another cycle row carrying the same `week` text', async () => {
  // `week` is not unique per tenant (only (tenant_id, period_kind, period_key|period_start) is): a
  // month row whose `week` mirror happens to read like the challenge's week is a second match for a
  // `mc.week = week` correlation, and a scalar subquery that finds two rows fails the WHOLE board
  // query (500). The join is on (tenant_id, period_kind, period_start) — the unique index — so the
  // month row is invisible to a week-stamped challenge and the order is exactly the one above.
  const month = cyclePeriodCols('2025-01');
  await db.insert(marketplaceCycles).values({
    tenant_id: UID,
    week: WEEK_SOON, // same `week` text as closing-soon's cycle row, different period
    period_kind: month.period_kind,
    period_key: month.period_key,
    period_start: month.period_start,
    phase: 'closed',
    voting_ends_at: new Date('2025-01-20T00:00:00Z'),
    solution_ends_at: new Date('2025-02-01T00:00:00Z'),
    closes_at: new Date('2025-02-01T00:00:00Z'),
    closed_at: new Date('2025-02-01T00:00:00Z'),
  });
  try {
    const closing = await order('closing');
    expect(closing).toEqual(['closing-soon', 'surging', 'old-guard']);
    expect(new Set(closing).size).toBe(closing.length);
  } finally {
    await db
      .delete(marketplaceCycles)
      .where(and(eq(marketplaceCycles.tenant_id, UID), eq(marketplaceCycles.period_key, month.period_key)));
  }
});

test('closing is still not `top` when the engine has opened NO cycle at all', async () => {
  // A freshly migrated+seeded database has an EMPTY `marketplace_cycles`, so every `closes_at` is
  // NULL and every row used to fall straight through to the `votes_count` tie-break — i.e. onto
  // `top`, byte for byte. These three weeks have no cycle row; votes ASCEND as the week ascends,
  // so the two sorts are exact reverses of one another.
  const cycleRows = await db
    .select({ week: marketplaceCycles.week })
    .from(marketplaceCycles)
    .where(inArray(marketplaceCycles.week, FRESH_WEEKS));
  expect(cycleRows).toEqual([]); // the fixture is not the fix

  const top = await order('top', MARK_FRESH);
  const closing = await order('closing', MARK_FRESH);

  expect(top).toEqual(['fresh2', 'fresh1', 'fresh0']); // 300 > 200 > 100
  // Ordered by week ASC — 2024-W10, 2024-W20, 2024-W30 — the only estimate available when no
  // boundary exists. `YYYY-Www` is fixed-width and zero-padded, so that is chronological.
  expect(closing).toEqual(['fresh0', 'fresh1', 'fresh2']);
  expect(closing).not.toEqual(top);
});

test('all four sorts stay distinct — none silently collapses onto another', async () => {
  const orders = {
    top: await order('top'),
    newest: await order('newest'),
    trending: await order('trending'),
    closing: await order('closing'),
  };
  // Written out in full rather than as a set-size assertion so a collapse names itself in the
  // diff instead of reporting "expected 4, got 3".
  expect(Object.entries(orders).map(([name, o]) => `${name}=${o.join('>')}`)).toEqual([
    'top=old-guard>closing-soon>surging',
    'newest=closing-soon>surging>old-guard',
    'trending=surging>old-guard>closing-soon',
    'closing=closing-soon>surging>old-guard',
  ]);
});
