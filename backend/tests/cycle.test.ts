// tests/cycle.test.ts — the marketplace weekly-cycle engine + routes (Phase 2-E).
// Pure unit (weekString / weekStart ISO-week math, msUntilNextTick scheduling) +
// integration over a real Postgres: the engine opens a week, advances voting →
// solution_phase → closed, selects a winner (deterministic tie-break), ships it, lands
// a pipeline review card, and is IDEMPOTENT (a closed week is a no-op; one winner/one
// card). Edge cases: no solutions, tie, no challenges, mid-phase (0 rows), boot catch-up
// (overdue cycle → straight to closed in one tick). All test data lives in far-future
// '2099-W..' weeks so the windows are clean and cleanup is exact.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerCycleRoutes } from '../src/routes/cycle';
import {
  db,
  users,
  challenges,
  solutions,
  weeklyWinners,
  marketplaceCycles,
  pipelineItems,
  auditLog,
  schedulerTicks,
  runSystemTick,
  withTenantDb,
  queryClient,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import {
  weekString,
  weekStart,
  challengePeriodFor,
  laterWeek,
  openCycle,
  enterSolutionPhase,
  closeCycle,
  tickTenantCycles,
} from '../src/host/cycle-service';
import { msUntilNextTick, cycleTickKeyForNow } from '../src/host/cycle-scheduler';
import { ensureTenants } from './helpers/cycle-period';
import type { User } from '../src/types';

const UID = '00000000-0000-0000-0000-0000000c9c01';
const platform: User = { id: UID, email: 'cyc@test', name: 'Cy Cle', roles: ['super_admin', 'employee'] };
const employee: User = { id: UID, email: 'cyc@test', name: 'Cy Cle', roles: ['employee'] };
const MARK = 'ZCYCTEST';
const DAY = 24 * 60 * 60 * 1000;
// Two synthetic tenants for the multi-tenant close. The engine had never been tested with more
// than one tenant in a week — which is exactly why it shipped with a global top-1 winner and a
// platform-wide stats aggregate stamped onto a tenant-readable row.
const TENANT_A = '00000000-0000-0000-0000-0000000c9ca1';
const TENANT_B = '00000000-0000-0000-0000-0000000c9cb2';

function install(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const router = new Router();
registerCycleRoutes(router);

async function callJson(method: string, path: string, body?: unknown) {
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

interface SeedSol {
  v: number;
  createdAt?: Date;
  status?: 'draft' | 'voting' | 'shipping' | 'archived';
}

/**
 * Seed a challenge (optional) + N solutions for a week, all in ONE tenant. `tenantId` scopes
 * both the challenge and (via the request GUC that solutions.tenant_id defaults to) its
 * solutions, so a test can stand up two competing tenants in the same week.
 */
async function seedWeek(
  week: string,
  sols: SeedSol[],
  opts: { withChallenge?: boolean; tenantId?: string } = {},
) {
  const tenantId = opts.tenantId ?? DEMO_TENANT_ID;
  let chId: string | null = null;
  if (opts.withChallenge !== false) {
    const [c] = await db
      .insert(challenges)
      .values({ title: `${MARK} ${week} ${tenantId.slice(-4)} ch`, work_area: 'Claims', submitter_id: UID, tenant_id: tenantId, status: 'voting', week })
      .returning();
    chId = c!.id;
  }
  const created: string[] = [];
  for (let i = 0; i < sols.length; i++) {
    const s = sols[i]!;
    const [sol] = await withTenantDb(tenantId, () =>
      db
        .insert(solutions)
        .values({
          challenge_id: chId!,
          title: `${MARK} ${week} ${tenantId.slice(-4)} sol${i}`,
          author_id: UID,
          week,
          status: s.status ?? 'voting',
          votes_count: s.v,
          ...(s.createdAt ? { created_at: s.createdAt } : {}),
        })
        .returning(),
    );
    created.push(sol!.id);
  }
  return { chId, solIds: created };
}

async function cleanup() {
  await db.delete(pipelineItems).where(like(pipelineItems.title, `${MARK}%`));
  await db.delete(weeklyWinners).where(like(weeklyWinners.week, '2099-%'));
  await db.delete(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'));
  await db.delete(auditLog).where(eq(auditLog.actor_id, UID));
  await db.delete(auditLog).where(and(inArray(auditLog.action, ['cycle.close', 'cycle.advance', 'cycle.trigger']), like(auditLog.target_id, '2099-%')));
  await db.delete(solutions).where(like(solutions.title, `${MARK}%`));
  await db.delete(challenges).where(like(challenges.title, `${MARK}%`));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: UID, email: platform.email, name: platform.name, avatar_initials: 'CC' }).onConflictDoNothing();
  install(platform);
}, 30_000);
afterAll(async () => {
  await cleanup();
  await db.delete(users).where(eq(users.id, UID));
  __setAuthOverridesForTests(undefined);
}, 30_000);

// ---- pure unit ----

test('weekString computes ISO week labels (incl. year boundaries)', () => {
  expect(weekString(new Date('2026-06-08T12:00:00Z'))).toBe('2026-W24'); // a Monday mid-year
  // 2027-01-01 is a Friday → ISO week 53 of 2026 (the week belongs to the prior year).
  expect(weekString(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  // 2024-12-30 (Mon) is ISO week 1 of 2025.
  expect(weekString(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
});

test('weekStart returns the Monday 00:00 UTC of an ISO week', () => {
  const ws = weekStart('2026-W24');
  expect(ws.toISOString()).toBe('2026-06-08T00:00:00.000Z'); // Monday
  expect(weekString(ws)).toBe('2026-W24'); // round-trips
  expect(() => weekStart('not-a-week')).toThrow();
});

test('a solution never competes in an earlier week than the challenge it answers', () => {
  // The other half of the roll-forward. A challenge submitted during solution_phase is stamped
  // W+1 by challengeWeekFor but appears on the board IMMEDIATELY, so a solution filed against it
  // during W would be judged a week before its own challenge closes — crowning "this week's
  // winner" for a challenge still open for voting. laterWeek is what stops that.
  expect(laterWeek('2026-W31', '2026-W32')).toBe('2026-W32');
  // The ordinary case is untouched: answering an OLDER challenge still competes in the CURRENT
  // week, never the challenge's closed one, or it would never be judged at all.
  expect(laterWeek('2026-W31', '2026-W23')).toBe('2026-W31');
  expect(laterWeek('2026-W31', '2026-W31')).toBe('2026-W31');
  // A legacy row still carrying the pre-0047 '' default must lose, not win by sorting first.
  expect(laterWeek('2026-W31', '')).toBe('2026-W31');
  expect(laterWeek('2026-W31', null)).toBe('2026-W31');
  // Lexicographic order is chronological across the ISO year boundary — the whole premise.
  expect(laterWeek('2026-W53', '2027-W01')).toBe('2027-W01');
  expect(laterWeek('2027-W01', '2026-W53')).toBe('2027-W01');
});

test('challengePeriodFor (week) rolls a post-voting submission into the next cycle', () => {
  // Mon 2026-06-08 opens 2026-W24; with the 4+3 week cadence challenge voting runs
  // Mon 00:00 → Fri 2026-06-12 00:00 UTC.
  const wk = (now: string, cycle: Parameters<typeof challengePeriodFor>[2]) =>
    challengePeriodFor(new Date(now), 'week', cycle).key;
  const votingEnds = new Date('2026-06-12T00:00:00Z');
  const open = { phase: 'voting' as const, voting_ends_at: votingEnds };

  // Inside the window → the running week.
  expect(wk('2026-06-08T09:00:00Z', open)).toBe('2026-W24');
  expect(wk('2026-06-11T23:59:59Z', open)).toBe('2026-W24');
  // Past it → next week (Fri–Sun = 3 of every 7 days would otherwise get no voting window).
  expect(wk('2026-06-12T00:00:00Z', open)).toBe('2026-W25');
  expect(wk('2026-06-14T23:00:00Z', open)).toBe('2026-W25');
  // A week already advanced or force-closed takes no new challenges either, clock notwithstanding.
  expect(wk('2026-06-09T09:00:00Z', { phase: 'solution_phase', voting_ends_at: votingEnds })).toBe('2026-W25');
  expect(wk('2026-06-09T09:00:00Z', { phase: 'closed', voting_ends_at: votingEnds })).toBe('2026-W25');
  // No cycle row (engine never opened the week) → the per-kind derived boundary.
  expect(wk('2026-06-08T09:00:00Z', null)).toBe('2026-W24');
  expect(wk('2026-06-13T09:00:00Z', null)).toBe('2026-W25');
  // The roll-forward crosses the ISO year boundary correctly: 2026-W53 → 2027-W01.
  expect(wk('2027-01-02T09:00:00Z', { phase: 'closed', voting_ends_at: votingEnds })).toBe('2027-W01');
});

test('challengePeriodFor (month / year) rolls after the voting phase of each kind', () => {
  const key = (now: string, kind: 'month' | 'year') => challengePeriodFor(new Date(now), kind, null).key;
  // month: days 1–21 vote; from the 22nd a new challenge waits for next month.
  expect(key('2026-10-21T23:59:59Z', 'month')).toBe('2026-10');
  expect(key('2026-10-22T00:00:00Z', 'month')).toBe('2026-11');
  expect(key('2026-12-25T00:00:00Z', 'month')).toBe('2027-01');
  // year: January–November vote; December rolls into next year.
  expect(key('2026-11-30T23:59:59Z', 'year')).toBe('2026');
  expect(key('2026-12-01T00:00:00Z', 'year')).toBe('2027');
});

test('msUntilNextTick targets the next hour:00 UTC', () => {
  expect(msUntilNextTick(new Date('2026-06-08T01:00:00Z'), 3)).toBe(2 * 60 * 60 * 1000);
  expect(msUntilNextTick(new Date('2026-06-08T05:00:00Z'), 3)).toBe(22 * 60 * 60 * 1000); // past today → tomorrow
  expect(msUntilNextTick(new Date('2026-06-08T03:00:00Z'), 3)).toBe(24 * 60 * 60 * 1000); // exactly on boundary → next day
});

// ---- integration ----

test('full lifecycle: open → solution_phase → close selects + ships the winner + enqueues a card', async () => {
  const week = '2099-W10';
  // sol0 has fewer votes than sol1 → sol1 wins.
  const { solIds } = await seedWeek(week, [{ v: 10, status: 'draft' }, { v: 30, status: 'draft' }]);

  await openCycle(week, DEMO_TENANT_ID);
  // advance to solution phase: the CYCLE's own phase advances and solutions draft→voting.
  // The calendar no longer decides a challenge's phase — enterSolutionPhase's challenge sweep is
  // gone, so a challenge seeded directly (not filed through routes/solutions.ts) stays 'voting'
  // here even though the week has moved on.
  expect(await enterSolutionPhase(week, DEMO_TENANT_ID)).toBe(true);
  const [ch] = await db.select().from(challenges).where(eq(challenges.week, week));
  expect(ch!.status).toBe('voting');
  const solsAfter = await db.select().from(solutions).where(eq(solutions.week, week));
  expect(solsAfter.every((s) => s.status === 'voting')).toBe(true);

  // close: winner = sol1, shipped; challenges closed; a weekly_winners row; a pipeline card
  const r = await closeCycle(week, DEMO_TENANT_ID);
  expect(r.closed).toBe(true);
  expect(r.winners.map((w) => w.solutionId)).toEqual([solIds[1]!]);

  const [winner] = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(winner!.solution_id).toBe(solIds[1]!);
  expect(winner!.stats?.solutionsSubmitted).toBe(2);
  expect(winner!.stats?.totalVotesCast).toBe(40);

  const [shipped] = await db.select().from(solutions).where(eq(solutions.id, solIds[1]!));
  expect(shipped!.status).toBe('shipping');
  // ⛔ THE CHALLENGE OUTLIVES ITS CYCLE. `closeCycle` used to sweep every challenge in the week to
  // `closed` ("Always close the week's challenges (winner or not)"). That sweep is gone: closing a
  // weekly COMPETITION is not a statement that the underlying work is finished, and a challenge can
  // wait months for someone able to solve it. What still has to happen — and is asserted above — is
  // that the winner is selected, shipped and carded. Only the challenge's own status is untouched.
  const [survivingCh] = await db.select().from(challenges).where(eq(challenges.week, week));
  expect(survivingCh!.status).not.toBe('closed');
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, week));
  expect(cycle!.phase).toBe('closed');
  // The global phase clock deliberately holds NO winner: it has one winner_solution_id/stats
  // pair and there are N per-tenant winners. weekly_winners is the artifact (see 0047).
  expect(cycle!.winner_solution_id).toBeNull();
  expect(cycle!.stats).toBeNull();

  const card = await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, solIds[1]!));
  expect(card).toHaveLength(1);
  expect(card[0]!.stage).toBe('review');

  // idempotent: re-close is a no-op (no second winner, no second card)
  const r2 = await closeCycle(week, DEMO_TENANT_ID);
  expect(r2.closed).toBe(false);
  expect(await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week))).toHaveLength(1);
  expect(await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, solIds[1]!))).toHaveLength(1);
}, 30_000);

test('tie → deterministic by created_at then id', async () => {
  const week = '2099-W11';
  const earlier = new Date('2099-01-01T01:00:00Z');
  const later = new Date('2099-01-01T02:00:00Z');
  // equal votes; sol0 created earlier → sol0 wins
  const { solIds } = await seedWeek(week, [
    { v: 50, createdAt: earlier },
    { v: 50, createdAt: later },
  ]);
  await openCycle(week, DEMO_TENANT_ID);
  const r = await closeCycle(week, DEMO_TENANT_ID);
  expect(r.winners.map((w) => w.solutionId)).toEqual([solIds[0]!]);
});

test('close is PER-TENANT: every competing tenant gets a winner, with only its OWN stats', async () => {
  const week = '2099-W15';
  // Tenant A: two solutions, 3 + 9 votes → A's winner is the 9-vote one, A's stats are 2 / 12.
  // Tenant B: one solution with 40 votes → B wins the platform-wide vote count outright.
  // Under the old global `.limit(1)` close, B was the ONE winner of the whole week (A's page
  // stayed blank forever) and B's stats row read 3 solutions / 52 votes — A's numbers, written
  // into a row B can read. Both halves of that are asserted against below.
  const a = await seedWeek(week, [{ v: 3 }, { v: 9 }], { tenantId: TENANT_A });
  const b = await seedWeek(week, [{ v: 40 }], { tenantId: TENANT_B });

  // 0110: each tenant runs its OWN cycle row; the platform tick closes each in turn.
  await ensureTenants([TENANT_A, TENANT_B]);
  await openCycle(week, TENANT_A);
  await openCycle(week, TENANT_B);
  const rA = await closeCycle(week, TENANT_A);
  const rB = await closeCycle(week, TENANT_B);
  expect(rA.closed && rB.closed).toBe(true);
  expect([...rA.winners, ...rB.winners]).toHaveLength(2);
  expect(rA.winners.map((w) => w.tenantId)).toEqual([TENANT_A]);

  const rows = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(rows).toHaveLength(2);
  const byTenant = new Map(rows.map((w) => [w.tenant_id, w]));

  expect(byTenant.get(TENANT_A)?.solution_id).toBe(a.solIds[1]!);
  expect(byTenant.get(TENANT_A)?.stats).toEqual({ solutionsSubmitted: 2, totalVotesCast: 12 });
  expect(byTenant.get(TENANT_B)?.solution_id).toBe(b.solIds[0]!);
  expect(byTenant.get(TENANT_B)?.stats).toEqual({ solutionsSubmitted: 1, totalVotesCast: 40 });

  // Each tenant's winner is shipped + carded, not just the platform-wide top one.
  const shipped = await db.select().from(solutions).where(inArray(solutions.id, [a.solIds[1]!, b.solIds[0]!]));
  expect(shipped.every((s) => s.status === 'shipping')).toBe(true);
  expect(await db.select().from(pipelineItems).where(inArray(pipelineItems.solution_id, [a.solIds[1]!, b.solIds[0]!]))).toHaveLength(2);

  // …and re-closing is still a no-op for BOTH tenants (the per-tenant unique key holds).
  expect((await closeCycle(week, TENANT_A)).closed).toBe(false);
  expect((await closeCycle(week, TENANT_B)).closed).toBe(false);
  expect(await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week))).toHaveLength(2);
}, 30_000);

test('the 0047 week backfill (SQL to_char) agrees with weekString for the same instant', async () => {
  // The backfill derives `week` from created_at in pure SQL while the runtime writes it from
  // weekString(). If the two ever disagreed, backfilled rows would be filed into a week the
  // engine never closes — the exact failure this whole change exists to end. Pin them together,
  // including the ISO year-boundary cases where a naive YYYY-WW would drift.
  const dates = [
    '2026-07-01T12:00:00Z',
    '2026-06-15T00:00:00Z',
    '2027-01-01T00:00:00Z', // Friday → 2026-W53
    '2024-12-30T00:00:00Z', // Monday → 2025-W01
    '2026-12-31T23:59:59Z',
  ];
  for (const iso of dates) {
    const [row] = await queryClient<{ w: string }[]>`
      SELECT to_char(${iso}::timestamptz AT TIME ZONE 'UTC', 'IYYY-"W"IW') AS w
    `;
    expect(row!.w, iso).toBe(weekString(new Date(iso)));
  }
});

test('no solutions → week closes with no winner, no card', async () => {
  const week = '2099-W12';
  await seedWeek(week, []); // a challenge, zero solutions
  await openCycle(week, DEMO_TENANT_ID);
  const r = await closeCycle(week, DEMO_TENANT_ID);
  expect(r.closed).toBe(true);
  expect(r.winners).toHaveLength(0);
  expect(await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week))).toHaveLength(0);
  const [ch] = await db.select().from(challenges).where(eq(challenges.week, week));
  // A cycle that produced no winner still closes — but it does not take the challenge with it. The
  // challenge simply never got solved that week, which is not a reason to stop accepting solutions.
  expect(ch!.status).not.toBe('closed');
});

test('no challenges/solutions → opens + closes cleanly, no winner, no error', async () => {
  const week = '2099-W13';
  await openCycle(week, DEMO_TENANT_ID);
  const r = await closeCycle(week, DEMO_TENANT_ID);
  expect(r.closed).toBe(true);
  expect(r.winners).toHaveLength(0);
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, week));
  expect(cycle!.phase).toBe('closed');
});

test('mid-phase tick (before the boundary) advances nothing', async () => {
  await db.delete(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'));
  const week = '2099-W14';
  await openCycle(week, DEMO_TENANT_ID);
  const ws = weekStart(week);
  // now is 1 day in — before voting_ends (ws + 4d). tickCycles opens weekString(now)
  // (which IS this week) and advances nothing past a boundary.
  await tickTenantCycles(new Date(ws.getTime() + 1 * DAY), DEMO_TENANT_ID);
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, week));
  expect(cycle!.phase).toBe('voting');
});

test('boot catch-up: an all-overdue cycle goes straight to closed in one tick', async () => {
  await db.delete(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'));
  const week = '2099-W20';
  const { solIds } = await seedWeek(week, [{ v: 5 }, { v: 15 }]);
  await openCycle(week, DEMO_TENANT_ID);
  const ws = weekStart(week);
  // now is 8 days in — past both boundaries. One tick should advance + close it.
  await tickTenantCycles(new Date(ws.getTime() + 8 * DAY), DEMO_TENANT_ID);
  const [cycle] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.week, week));
  expect(cycle!.phase).toBe('closed');
  const [winner] = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(winner!.solution_id).toBe(solIds[1]!); // the 15-vote one
});

test('a whole week missed during downtime is BACK-FILLED, not stranded', async () => {
  await db.delete(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'));
  // CP was last up in W30 and comes back in W33: W31 and W32 elapsed with nobody running a tick.
  // Before the back-fill, tickCycles opened only W33, so anything stamped into W31/W32 had no
  // cycle row carrying its boundaries and could never leave `voting`.
  await openCycle('2099-W30', DEMO_TENANT_ID);
  const res = await tickTenantCycles(new Date(weekStart('2099-W33').getTime() + 1 * DAY), DEMO_TENANT_ID);

  expect(res.backfilled).toEqual(['2099-W31', '2099-W32']);
  const weeks = (
    await db.select().from(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'))
  ).map((c) => c.week).sort();
  expect(weeks).toEqual(['2099-W30', '2099-W31', '2099-W32', '2099-W33']);

  // And the back-filled weeks are fully overdue, so the SAME tick drives them to closed rather
  // than leaving them parked in voting — the whole point of catching up.
  const backfilled = await db
    .select()
    .from(marketplaceCycles)
    .where(inArray(marketplaceCycles.week, ['2099-W31', '2099-W32']));
  for (const c of backfilled) expect(c.phase).toBe('closed');
}, 30_000);

test('back-fill is idempotent and does nothing when no week was missed', async () => {
  await db.delete(marketplaceCycles).where(like(marketplaceCycles.week, '2099-%'));
  await openCycle('2099-W40', DEMO_TENANT_ID);
  const first = await tickTenantCycles(new Date(weekStart('2099-W40').getTime() + 1 * DAY), DEMO_TENANT_ID);
  expect(first.backfilled).toEqual([]); // same week — nothing to catch up
  const second = await tickTenantCycles(new Date(weekStart('2099-W40').getTime() + 1 * DAY), DEMO_TENANT_ID);
  expect(second.backfilled).toEqual([]);
});

test('back-fill does NOT walk from the epoch on a database with no cycles at all', async () => {
  // A fresh install has no history; the current week is simply its first. Without this guard the
  // walk would have no lower bound to start from.
  await db.delete(marketplaceCycles);
  const res = await tickTenantCycles(new Date(weekStart('2099-W25').getTime() + 1 * DAY), DEMO_TENANT_ID);
  expect(res.backfilled).toEqual([]);
  expect(res.opened).toBe('2099-W25');
});

// ---- routes ----

test('POST /api/cycle/advance is super_admin-gated (employee → 403)', async () => {
  install(employee);
  const r = await callJson('POST', '/api/cycle/advance', { week: '2099-W30', to: 'closed' });
  expect(r.status).toBe(403);
  install(platform);
});

test('POST /api/cycle/advance {to:closed} drives a full close on demand', async () => {
  const week = '2099-W31';
  const { solIds } = await seedWeek(week, [{ v: 7 }, { v: 21 }]);
  const r = await callJson('POST', '/api/cycle/advance', { week, to: 'closed' });
  expect(r.status).toBe(200);
  expect(r.json.week).toBe(week);
  expect(r.json.phase).toBe('closed');
  // The route DTO no longer carries a winner: marketplace_cycles is the global phase clock and
  // cannot hold N per-tenant winners, so serving one to every tenant was a cross-tenant leak.
  expect(r.json.winnerSolutionId).toBeUndefined();
  expect(r.json.stats).toBeUndefined();
  // the winner itself landed in the per-tenant artifact
  const [ww] = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(ww!.solution_id).toBe(solIds[1]!);

  // a cycle.trigger audit row by the platform actor
  const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, 'cycle.trigger'), eq(auditLog.target_id, week)));
  expect(audits.some((a) => a.actor_id === UID)).toBe(true);
});

test('POST /api/cycle/advance {to:solution_phase} opens solution voting', async () => {
  const week = '2099-W32';
  await seedWeek(week, [{ v: 1, status: 'draft' }]);
  const r = await callJson('POST', '/api/cycle/advance', { week, to: 'solution_phase' });
  expect(r.status).toBe(200);
  // The CYCLE'S phase still advances on demand.
  expect(r.json.phase).toBe('solution_phase');
  // The challenge itself is untouched by this route now — only routes/solutions.ts (filing the
  // first solution) can move challenges.status. This one was seeded directly, so it stays 'voting'.
  const [ch] = await db.select().from(challenges).where(eq(challenges.week, week));
  expect(ch!.status).toBe('voting');
});

test('force re-close after the leader changes: winner row, shipping status, and audit all agree on the NEW top', async () => {
  const week = '2099-W16';
  // sol0 wins the first close (30 > 10).
  const { solIds } = await seedWeek(week, [{ v: 30 }, { v: 10 }]);
  await openCycle(week, DEMO_TENANT_ID);
  const r1 = await closeCycle(week, DEMO_TENANT_ID);
  expect(r1.winners.map((w) => w.solutionId)).toEqual([solIds[0]!]);
  const [shipped0] = await db.select().from(solutions).where(eq(solutions.id, solIds[0]!));
  expect(shipped0!.status).toBe('shipping');

  // More votes land: sol1 overtakes sol0.
  await db.update(solutions).set({ votes_count: 99 }).where(eq(solutions.id, solIds[1]!));

  // The manual demo path: force re-arms the week and re-closes it. The new top is sol1.
  const r2 = await closeCycle(week, DEMO_TENANT_ID, db, { force: true });
  expect(r2.closed).toBe(true);
  expect(r2.winners.map((w) => w.solutionId)).toEqual([solIds[1]!]);

  // INVARIANT: exactly one solution is 'shipping' for this (tenant, week) — the one
  // weekly_winners now names. Without the fix, sol0 stayed 'shipping' (onConflictDoNothing
  // left the old winner row in place) AND sol1 was unconditionally flipped to 'shipping' too.
  const [ww] = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(ww!.solution_id).toBe(solIds[1]!);
  const both = await db.select().from(solutions).where(inArray(solutions.id, [solIds[0]!, solIds[1]!]));
  const shippingIds = both.filter((s) => s.status === 'shipping').map((s) => s.id);
  expect(shippingIds).toEqual([solIds[1]!]);
  const [dethroned] = await db.select().from(solutions).where(eq(solutions.id, solIds[0]!));
  expect(dethroned!.status).toBe('voting');
}, 30_000);

test('GET /api/cycle/current is read-only + employee-accessible', async () => {
  install(employee);
  const r = await callJson('GET', '/api/cycle/current');
  expect(r.status).toBe(200);
  // null (no cycle opened for the real current week) or a cycle object — both valid.
  expect(r.json === null || typeof r.json.week === 'string').toBe(true);
  install(platform);
});

// ---- 2026-08-10: the three defects that let a live prod cycle sit ~27h overdue ----
//
// Context, because these tests read as trivia without it. On 2026-08-09T20:48Z a deploy ran the
// cycle scheduler's boot catch-up, which stamped `scheduler_ticks.cycle`. Cycle 2026-W32 was due
// to close at 2026-08-10T00:00Z. The 03:00Z scheduled tick fell inside the shared 12h debounce
// window and was refused — silently, because a refused claim RESOLVES to `undefined` rather than
// throwing, and both call sites discarded the return. Meanwhile 16 challenges seeded into weeks
// that had already closed sat in `voting` accepting votes that could never matter, because
// nothing in the engine can reach a challenge whose cycle is closed. And when the close finally
// did come, its only candidate had zero votes — which the winner query would have crowned and
// pushed onto the production pipeline.

test('the SCHEDULER derives its claim key from the UTC day, so a boot tick cannot eat the scheduled one', async () => {
  // ⛔ WHY THIS TEST IS SHAPED LIKE THIS. The first version asserted only that
  // `cycleTickKey('a') !== cycleTickKey('b')` and that runSystemTick honours two distinct keys.
  // Both are true of a pure function and of runSystemTick's PRE-EXISTING behaviour, so reverting
  // the actual defect — the scheduler passing the bare cadence key — left the whole suite green.
  // An adversarial pass caught it. A test that cannot go red is not evidence.
  //
  // So this pins the SCHEDULER's own key function, across a real UTC-midnight boundary.
  const beforeMidnight = new Date(Date.UTC(2099, 0, 1, 23, 59, 59, 900));
  const afterMidnight = new Date(Date.UTC(2099, 0, 2, 0, 0, 0, 100));
  const k1 = cycleTickKeyForNow(beforeMidnight);
  const k2 = cycleTickKeyForNow(afterMidnight);
  expect(k1).toBe('cycle:2099-01-01');
  expect(k2).toBe('cycle:2099-01-02');

  await db.delete(schedulerTicks).where(inArray(schedulerTicks.key, [k1, k2]));
  try {
    let ran = 0;
    // The boot catch-up on day 1 — the 20:48Z deploy that started all this.
    const boot = await runSystemTick(k1, 12 * 60 * 60 * 1000, async () => { ran++; return 'boot'; });
    expect(boot).toBe('boot');
    // The 03:00Z scheduled tick the next day, WELL inside a 12h window measured from that claim.
    // Under the old cadence key this returned undefined and the week never closed.
    const sched = await runSystemTick(k2, 12 * 60 * 60 * 1000, async () => { ran++; return 'sched'; });
    expect(sched).toBe('sched');
    expect(ran).toBe(2);

    // ...and two callers on the SAME day still collapse to one winner. This half matters just as
    // much: the per-day key must not turn two pods' boot ticks into two concurrent advances.
    const sameDay = await runSystemTick(k2, 12 * 60 * 60 * 1000, async () => { ran++; return 'dupe'; });
    expect(sameDay).toBeUndefined();
    expect(ran).toBe(2);
  } finally {
    await db.delete(schedulerTicks).where(inArray(schedulerTicks.key, [k1, k2]));
  }
}, 30_000);

test('the scheduler call site itself uses the per-day key — not the bare cadence key', async () => {
  // The behavioural test above pins `cycleTickKeyForNow`. It cannot pin that the SCHEDULER calls
  // it: reverting the call site to `TICK_LOCK.cycle` leaves that function intact and passing. This
  // is the guard that actually reddens on the revert. Source-grep guards are the house pattern for
  // exactly this (see frontend audit-categories.backend-contract.test.ts).
  const src = await Bun.file(new URL('../src/host/cycle-scheduler.ts', import.meta.url)).text();
  expect(src.length).toBeGreaterThan(500); // never pass vacuously on an unreadable path
  const claim = src.slice(src.indexOf('async function runCycleTick'));
  // The claim now goes through `claimTick` (host/tick-locks.ts, which owns the refused-claim
  // branch); what this guard cares about is unchanged — that the KEY is the per-day one.
  // `now()` is the injectable clock (tests pin the day); it is still the per-day key function.
  expect(claim).toContain('key: cycleTickKeyForNow(now())');
  // The bare cadence key must not reappear at the claim site under any spelling.
  expect(claim).not.toContain('TICK_LOCK.cycle');
}, 30_000);

test('a week whose only entry has ZERO votes crowns nobody', async () => {
  const week = '2099-W21';
  await openCycle(week, DEMO_TENANT_ID);
  const { solIds } = await seedWeek(week, [{ v: 0 }]);
  const r = await closeCycle(week, DEMO_TENANT_ID);

  expect(r.closed).toBe(true);
  // The candidate set is NOT empty — `eligibleForWeek` still returns this row, and it still shows
  // up on the read surfaces as a submission. It simply may not WIN.
  expect(r.winners).toEqual([]);
  const ww = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, week));
  expect(ww).toEqual([]);
  const [sol] = await db.select().from(solutions).where(eq(solutions.id, solIds[0]!));
  expect(sol!.status).toBe('voting');
  // And no production pipeline card was created on nobody's endorsement.
  const cards = await db.select().from(pipelineItems).where(eq(pipelineItems.solution_id, solIds[0]!));
  expect(cards).toEqual([]);
}, 30_000);

test('ONE vote is enough — the guard is a floor, not a quorum', async () => {
  // The complement of the test above, and the reason it is here: a guard that also blocked the
  // 1-vote case would re-create the eight consecutive winnerless weeks this engine just escaped.
  const week = '2099-W22';
  await openCycle(week, DEMO_TENANT_ID);
  const { solIds } = await seedWeek(week, [{ v: 1 }]);
  const r = await closeCycle(week, DEMO_TENANT_ID);

  expect(r.closed).toBe(true);
  expect(r.winners.map((w) => w.solutionId)).toEqual([solIds[0]!]);
  const [sol] = await db.select().from(solutions).where(eq(solutions.id, solIds[0]!));
  expect(sol!.status).toBe('shipping');
}, 30_000);

// ---- the heal: "a past week with nothing live to advance it" ----
//
// ⛔ THE PREDICATE THAT SHIPPED FIRST WAS WRONG, AND ITS TEST PINNED THE WRONG THING. It asked for
// `exists (cycle where phase='closed')`, and a test asserted that a challenge whose week has NO
// cycle row is deliberately left alone ("a fresh install is not an outage"). Measured against prod,
// that combination healed 1 of the 16 rows it was written for: W21 (3 rows) and W23 (12 rows) have
// NO cycle row at all, because nothing ever creates one for a past week. The tests below pin the
// corrected property in both directions.

async function mkChallenge(week: string, label: string): Promise<string> {
  const [c] = await db
    .insert(challenges)
    .values({ title: `${MARK} ${label}`, work_area: 'Claims', submitter_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week })
    .returning();
  return c!.id;
}

test('tickCycles REPORTS a challenge stranded in a past week with NO cycle row — but does not write its status', async () => {
  // ⚠️ The week must be BELOW the stranded floor (the end of a later CLOSED cycle) — that is what makes
  // it legacy history (prod's W21/W23). A no-row week ABOVE the floor is STRANDED, not orphaned: the
  // tick's sweep re-homes it into the running week (cycle-service `sweepStranded`).
  await openCycle('2099-W25', DEMO_TENANT_ID);
  await closeCycle('2099-W25', DEMO_TENANT_ID);
  const id = await mkChallenge('2099-W23', 'never-opened');
  // Sanity: enterSolutionPhase cannot reach it (no cycle row for the week at all).
  expect(await enterSolutionPhase('2099-W23', DEMO_TENANT_ID)).toBe(false);

  await tickTenantCycles(new Date(Date.UTC(2099, 6, 1)), DEMO_TENANT_ID);
  // The heal is report-only now — it names the stranded challenge in an audit row (see the
  // dedicated audit tests below), but the calendar no longer writes challenges.status. Only
  // routes/solutions.ts (filing the first solution) can move it off 'voting'.
  const [healed] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(healed!.status).toBe('voting');
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), like(auditLog.target_id, '2099-%')));
  const mine = rows.find((r) => JSON.stringify(r.metadata ?? {}).includes(id));
  expect(mine, 'heal did not report this stranded challenge').toBeDefined();
}, 30_000);

test('tickCycles REPORTS a challenge whose past week HAS a closed cycle — but leaves its status alone', async () => {
  const week = '2099-W24';
  await openCycle(week, DEMO_TENANT_ID);
  await closeCycle(week, DEMO_TENANT_ID);
  const id = await mkChallenge(week, 'closed-cycle');

  await tickTenantCycles(new Date(Date.UTC(2099, 6, 1)), DEMO_TENANT_ID);
  const [healed] = await db.select().from(challenges).where(eq(challenges.id, id));
  expect(healed!.status).toBe('voting');
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), like(auditLog.target_id, '2099-%')));
  const mine = rows.find((r) => JSON.stringify(r.metadata ?? {}).includes(id));
  expect(mine, 'heal did not report this stranded challenge').toBeDefined();
}, 30_000);

test('the heal LEAVES the CURRENT week alone, in either live phase', async () => {
  // ⛔ AN EARLIER VERSION OF THIS TEST WAS WRONG AND IT TAUGHT ME SOMETHING. It opened two PAST
  // weeks in `voting`/`solution_phase` and asserted their challenges survived a tick — and under
  // the rules of the day they did not. `tickCycles` advances every overdue cycle to `closed` BEFORE
  // the heal runs (that ordering is deliberate, see the call site), so "a past week whose cycle is
  // still live" cannot exist once a tick has run, and the heal's write reached them.
  // ⚠️ That write is GONE — the challenges would survive a tick today — so this test no longer
  // protects a status at all. What it still protects is the REPORT boundary below.
  //
  // What actually needs protecting is the week the reader is IN. So `now` sits inside it.
  const now = new Date(Date.UTC(2099, 5, 22, 12)); // a Monday inside 2099-W26
  const current = weekString(now);
  await openCycle(current, DEMO_TENANT_ID);
  const inVoting = await mkChallenge(current, 'current-voting');

  await tickTenantCycles(now, DEMO_TENANT_ID);
  let [row] = await db.select().from(challenges).where(eq(challenges.id, inVoting));
  expect(row!.status).toBe('voting');
  // The heal never writes to ANY week's challenges now (see the two tests above), so "left alone"
  // is only meaningfully distinct from a past week in the REPORT: the current week must not be
  // named as stranded in the audit trail either.
  let audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), eq(auditLog.target_id, current)));
  expect(audits.every((a) => !JSON.stringify(a.metadata ?? {}).includes(inVoting))).toBe(true);

  // Same week, now in solution_phase — the phase prod's W32 sat in while it was current.
  await enterSolutionPhase(current, DEMO_TENANT_ID);
  const inSolution = await mkChallenge(current, 'current-solution');
  await tickTenantCycles(now, DEMO_TENANT_ID);
  [row] = await db.select().from(challenges).where(eq(challenges.id, inSolution));
  expect(row!.status).toBe('voting');
  audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), eq(auditLog.target_id, current)));
  expect(audits.every((a) => !JSON.stringify(a.metadata ?? {}).includes(inSolution))).toBe(true);
  expect(audits.every((a) => !JSON.stringify(a.metadata ?? {}).includes(inVoting))).toBe(true);
}, 30_000);

test('the heal NEVER touches the current or a FUTURE week, even one force-closed by an admin', async () => {
  // This is the shredder an adversarial pass found in the first draft. `challengeWeekFor` rolls a
  // late submission into NEXT week without consulting that week's phase, so one supported call —
  // POST /api/cycle/advance {week: <future>, to: 'closed'} — used to make every Fri-Sun submission
  // get silently closed within 24h. `week < current` is what makes that unreachable.
  const now = new Date(Date.UTC(2099, 6, 1)); // 2099-W27
  const current = weekString(now);
  const futureWeek = '2099-W30';
  await openCycle(futureWeek, DEMO_TENANT_ID);
  await closeCycle(futureWeek, DEMO_TENANT_ID); // an admin force-close of a week that has not happened
  const future = await mkChallenge(futureWeek, 'future-forceclosed');
  const currentWeekCh = await mkChallenge(current, 'current-week');

  await tickTenantCycles(now, DEMO_TENANT_ID);
  const [rf] = await db.select().from(challenges).where(eq(challenges.id, future));
  const [rc] = await db.select().from(challenges).where(eq(challenges.id, currentWeekCh));
  expect(rf!.status).toBe('voting');
  expect(rc!.status).toBe('voting');
  // As above: the write is gone for every week, so what still has to hold is that neither the
  // future nor the current-week challenge is ever NAMED as stranded in a heal audit row.
  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), like(auditLog.target_id, '2099-%')));
  expect(audits.every((a) => !JSON.stringify(a.metadata ?? {}).includes(future))).toBe(true);
  expect(audits.every((a) => !JSON.stringify(a.metadata ?? {}).includes(currentWeekCh))).toBe(true);
}, 30_000);

test('the heal writes ONE audit row naming what it reported', async () => {
  // A bulk cross-tenant report that leaves only a console line is the one engine action a
  // compliance reader cannot see — audit_log is the source for the nightly export.
  const id = await mkChallenge('2099-W28', 'audited');
  await tickTenantCycles(new Date(Date.UTC(2099, 8, 1)), DEMO_TENANT_ID);

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), like(auditLog.target_id, '2099-%')));
  expect(rows.length).toBeGreaterThan(0);
  const mine = rows.find((r) => JSON.stringify(r.metadata ?? {}).includes(id));
  expect(mine).toBeDefined();
  expect(mine!.result_tone).toBe('warn');
}, 30_000);

test('the heal audit names the STRANDED live-week solutions hanging off what it reported', async () => {
  // ⛔ THE SIGNAL THAT WOULD HAVE SURFACED THE VOTABILITY DEFECT IN JUNE. The heal itself is
  // correct: a challenge whose own week is over gets named as stranded (report-only — it no
  // longer writes challenges.status at all). What was invisible is
  // the collateral — a solution whose OWN cycle is still RUNNING, sitting under that challenge.
  // Under the old rule (votability read off the parent) every such row was silently struck
  // unvotable and therefore unwinnable, which is exactly what happened to prod's 2026-W33 entry
  // eight hours after it was filed. Nine weeks closed with no winner while every tick logged a
  // clean heal. The rows stay votable now, but the shape is worth naming out loud.
  const now = new Date(Date.UTC(2099, 8, 7)); // a Monday, so the current cycle this tick opens stays open
  const current = weekString(now);
  const parent = await mkChallenge('2099-W29', 'stranding-parent'); // past week, no cycle row → healed
  // The entry competes in the CURRENT week, not its parent's — `routes/solutions.ts` stamps
  // `laterWeek(weekString(now), ch.week)`, so this is the ordinary shape, not a contrived one.
  const [live] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: parent, title: `${MARK} stranded live`, author_id: UID, week: current, status: 'voting', votes_count: 0 })
      .returning(),
  );
  // …and a sibling in a DEAD week, which is collateral of nothing and must NOT be reported.
  const [dead] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: parent, title: `${MARK} stranded dead`, author_id: UID, week: '2099-W29', status: 'voting', votes_count: 0 })
      .returning(),
  );

  await tickTenantCycles(now, DEMO_TENANT_ID);

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'cycle.heal'), eq(auditLog.target_id, current)));
  const mine = rows.find((r) => JSON.stringify(r.metadata ?? {}).includes(parent));
  expect(mine, 'no cycle.heal row named the challenge this tick reported').toBeDefined();
  const meta = mine!.metadata as { orphaned: string[]; stranded: string[] };
  expect(meta.stranded).toContain(live!.id);
  expect(meta.stranded).not.toContain(dead!.id);
  // ⚠️ THE REPORTING SURVIVED THE BEHAVIOUR CHANGE, AND THAT IS THE POINT OF KEEPING THIS TEST.
  // The heal no longer writes challenges.status AT ALL — it is report-only, and the parent stays
  // exactly where it was ('voting') unless routes/solutions.ts advances it by filing a solution.
  // But the `stranded` list is unconditional, because its ABSENCE is what let a defect run unseen
  // from June to August. Neither solution's own status is touched, exactly as before.
  const [pRow] = await db.select({ status: challenges.status }).from(challenges).where(eq(challenges.id, parent));
  expect(pRow!.status).toBe('voting');
  const sRows = await db.select({ id: solutions.id, status: solutions.status }).from(solutions).where(inArray(solutions.id, [live!.id, dead!.id]));
  expect(sRows.map((r) => r.status)).toEqual(['voting', 'voting']);
}, 30_000);
