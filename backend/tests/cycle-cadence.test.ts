// tests/cycle-cadence.test.ts — the voting-cycle CADENCE (off | week | month | quarter | year), 0107 + 0109.
//
// What is pinned here:
//   • SQL (migration 0107's key parser + trigger) and TS (host/period.ts) agree on every period.
//   • tickCycles: OFF does nothing; a running period finishes under its own rules when the setting
//     changes; the new kind opens only at the boundary; month/year run a full lifecycle.
//   • The vote gate: OFF mode bypasses it end-to-end (castVote), and a rolled-forward MONTH solution
//     stays votable — the case the old `week < currentWeek` TEXT comparison got wrong.
//   • The setting is a governance policy: PATCH /api/governance/cycle.cadence is validated + audited.
//
// ⚠️ `policies` and `marketplace_cycles` are GLOBAL tables shared with every other file. Engine tests
// run inside a transaction that is ROLLED BACK (tickCycles takes its database), so they can wipe the
// cycle table for a deterministic start without touching anyone else; vote-path tests use the
// cadence seam instead of flipping the real row.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, desc, eq, inArray, like, lte, ne, sql } from 'drizzle-orm';
import {
  db,
  users,
  challenges,
  solutions,
  votes,
  marketplaceCycles,
  weeklyWinners,
  pipelineItems,
  policies,
  policyChanges,
  schedulerTicks,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { castVote } from '../src/host/vote-service';
import {
  applyCadenceSwitchToCycles,
  boundariesOf,
  challengePeriodFor,
  openCycle,
  driveCycle,
  CYCLE_TENANT_LOCK_NS,
  periodColumns,
  planCadenceSwitch,
  switchCadence,
  tickTenantCycles,
} from '../src/host/cycle-service';
import { eligibleForPeriod, periodEndSql } from '../src/host/cycle-eligibility';
import { runCycleTick, cycleTickKeyForNow } from '../src/host/cycle-scheduler';
import { registerCycleRoutes } from '../src/routes/cycle';
import type { MarketplaceCycle } from '../src/db/schema';
import {
  __setCadenceOverrideForTests,
  __setCycleClockForTests,
  CADENCE_POLICY_KEY,
  CADENCE_POLICY_ROW,
  cadenceStateFrom,
  ensureCadencePolicy,
  readCadenceSetting,
  type PendingSwitch,
} from '../src/host/cycle-cadence';
import { laterPeriod, periodFor, periodFromKey, nextPeriod, PERIOD_KINDS, type Cadence, type Period } from '../src/host/period';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { invalidatePolicyCache } from '../src/host/policy-store';
import { UnauthorizedError, type User } from '../src/types';
import { Router } from '../src/utils/router';
import { registerGovernanceRoutes } from '../src/routes/governance';

const UID = '00000000-0000-0000-0000-0000000cad01';
const VOTER = '00000000-0000-0000-0000-0000000cad02';
const VOTER3 = '00000000-0000-0000-0000-0000000cad03';
const VOTER4 = '00000000-0000-0000-0000-0000000cad04';
const MARK = 'ZCADENCETEST';
type Db = typeof db;

/** Run `fn` against a transaction that is ALWAYS rolled back. */
class Rollback extends Error {}
async function inRolledBackTx(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function cleanup() {
  __setCadenceOverrideForTests();
  const chIds = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (chIds.length) {
    const solIds = (await db.select({ id: solutions.id }).from(solutions).where(inArray(solutions.challenge_id, chIds))).map((r) => r.id);
    if (solIds.length) {
      await db.delete(votes).where(inArray(votes.target_id, solIds));
      await db.delete(pipelineItems).where(inArray(pipelineItems.solution_id, solIds));
      await db.delete(weeklyWinners).where(inArray(weeklyWinners.solution_id, solIds));
      await db.delete(solutions).where(inArray(solutions.id, solIds));
    }
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db
    .delete(marketplaceCycles)
    .where(
      inArray(marketplaceCycles.period_key, [
        '2095-W10', '2095-03', '2095-04', '2095-W47', '2095-12', '2095-05',
        '2095-W20', '2095-W21', '2095-W22', '2097-01', '2097-02', '2097-12', '2098-01', '2098-02',
        '2096-W10', '2096-W11', '2096-W12', '2096-W20', '2096-W21',
      ]),
    );
  await db.delete(users).where(inArray(users.id, [UID, VOTER, VOTER3, VOTER4]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(users).values([
    { id: UID, email: 'cadence@test', name: 'Cad Author' },
    { id: VOTER, email: 'cadence2@test', name: 'Cad Voter' },
    { id: VOTER3, email: 'cadence3@test', name: 'Cad Voter 3' },
    { id: VOTER4, email: 'cadence4@test', name: 'Cad Voter 4' },
  ]).onConflictDoNothing();
}, 30_000);
afterAll(cleanup, 30_000);
afterEach(() => {
  __setCadenceOverrideForTests();
  __setCycleClockForTests();
});

// ── SQL ↔ TS: one definition of a period ─────────────────────────────────────────────────────

test('migration 0107/0109 key parser + periodEndSql agree with host/period.ts for every kind across 2020–2035', async () => {
  // ⛔ All FOUR kinds must be in the sample — a kind missing from PERIOD_KINDS would otherwise
  // shrink this parity test silently instead of failing it.
  expect([...PERIOD_KINDS].sort()).toEqual(['month', 'quarter', 'week', 'year']);
  const keys: string[] = [];
  for (const kind of PERIOD_KINDS) {
    let p = periodFor(kind, new Date(Date.UTC(2020, 0, 1)));
    while (p.start.getTime() < Date.UTC(2035, 0, 1)) {
      keys.push(p.key);
      p = nextPeriod(p);
    }
  }
  expect(keys.length).toBeGreaterThan(900);
  expect(keys.filter((k) => /^\d{4}-Q[1-4]$/.test(k)).length).toBe(60);
  const rows = await db.execute<{ k: string; kind: string; start: string; end: string }>(sql`
    select k, cp_period_kind_of_key(k) as kind, cp_period_start_of_key(k)::text as start,
           ${periodEndSql(sql`cp_period_kind_of_key(k)`, sql`cp_period_start_of_key(k)`)}::text as "end"
    from unnest(${sql.raw(`ARRAY[${keys.map((k) => `'${k}'`).join(',')}]`)}::text[]) as k`);
  const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows;
  expect(list.length).toBe(keys.length);
  const seen = new Set<string>();
  for (const r of list as unknown as { k: string; kind: string; start: string; end: string }[]) {
    const p = periodFromKey(r.k);
    expect(r.kind).toBe(p.kind);
    expect(new Date(r.start).getTime()).toBe(p.start.getTime());
    expect(new Date(r.end).getTime()).toBe(p.end.getTime());
    seen.add(r.kind);
  }
  expect([...seen].sort()).toEqual(['month', 'quarter', 'week', 'year']);
  // Not a key → no period (legacy `week = ''`), and no out-of-range quarter.
  const bad = (await db.execute(sql`
    select k, cp_period_kind_of_key(k) as kind from unnest(array['', '2026-Q0', '2026-Q5', '2026-q1', '2026-Q12']::text[]) as k`)) as unknown as {
    k: string;
    kind: string | null;
  }[];
  expect(bad.length).toBe(5);
  for (const b of bad) expect(b.kind).toBeNull();
});

test('0109: quarter keys pass every period_kind CHECK and the follow-week trigger derives them', async () => {
  await inRolledBackTx(async (tx) => {
    const [ch] = await tx
      .insert(challenges)
      .values({ title: `${MARK} quarter`, work_area: 'IT', submitter_id: UID, tenant_id: UID, week: '2095-Q4' })
      .returning();
    expect(ch!.period_kind).toBe('quarter');
    expect(ch!.period_start!.toISOString()).toBe('2095-10-01T00:00:00.000Z');
    const q = periodFromKey('2095-Q4');
    const [cy] = await tx
      .insert(marketplaceCycles)
      .values({ tenant_id: DEMO_TENANT_ID, week: q.key, ...boundariesOf(q), phase: 'voting' } as typeof marketplaceCycles.$inferInsert)
      .returning();
    expect(cy).toMatchObject({ period_kind: 'quarter', period_key: '2095-Q4' });
    expect(cy!.period_start.toISOString()).toBe('2095-10-01T00:00:00.000Z');
    for (const t of ['challenges', 'solutions', 'pipeline_items', 'weekly_winners', 'marketplace_cycles']) {
      const [c] = (await tx.execute(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = ${t + '_period_kind_check'} and conrelid = ${t}::regclass`)) as unknown as { def: string }[];
      expect(c!.def).toContain("'quarter'");
    }
  });
});

test('the trigger derives period_* from week when a writer sets only week, and follows a rewrite', async () => {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} trig`, work_area: 'IT', submitter_id: UID, tenant_id: UID, week: '2095-03' })
    .returning();
  expect(ch!.period_kind).toBe('month');
  expect(ch!.period_start!.toISOString()).toBe('2095-03-01T00:00:00.000Z');
  const [up] = await db.update(challenges).set({ week: '2095-W10' }).where(eq(challenges.id, ch!.id)).returning();
  expect(up!.period_kind).toBe('week');
  expect(up!.period_start!.getTime()).toBe(periodFromKey('2095-W10').start.getTime());
  // An explicit OFF stamp is kept, not overwritten from the empty key.
  const [off] = await db
    .insert(challenges)
    .values({ title: `${MARK} off`, work_area: 'IT', submitter_id: UID, tenant_id: UID, week: '', period_kind: 'off' })
    .returning();
  expect(off!.period_kind).toBe('off');
  expect(off!.period_start).toBeNull();
});

// ── the engine ───────────────────────────────────────────────────────────────────────────────

test('OFF with nothing running: tickCycles opens nothing, closes nothing, reports nothing', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    const r = await tickTenantCycles(new Date('2095-03-10T03:00:00Z'), DEMO_TENANT_ID, tx, { setting: 'off' });
    expect(r).toMatchObject({ cadence: 'off', opened: null, backfilled: [], advanced: [], closed: [] });
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(marketplaceCycles)) as [{ n: number }];
    expect(n).toBe(0);
  });
});

// ── the cadence SWITCH: takes effect at the next boundary, never opens a partly-elapsed period ──

type Policy = { setting: Cadence; pending: PendingSwitch | null };
const DAY_MS = 86_400_000;

/** The newest row that has started by `at` and is not closed (what switchCadence locks). */
async function liveAt(tx: Db, at: Date): Promise<MarketplaceCycle | null> {
  const [r] = await tx
    .select()
    .from(marketplaceCycles)
    .where(and(ne(marketplaceCycles.phase, 'closed'), lte(marketplaceCycles.period_start, at)))
    .orderBy(desc(marketplaceCycles.period_start))
    .limit(1);
  return r ?? null;
}
/** The cycle side of PATCH /api/governance/cycle.cadence, against `tx`; returns the new policy. */
async function switchTo(tx: Db, at: Date, from: Policy, to: Cadence): Promise<Policy> {
  const plan = planCadenceSwitch(at, from, to, await liveAt(tx, at));
  await applyCadenceSwitchToCycles(plan, tx, DEMO_TENANT_ID, { at, setting: to });
  return { setting: to, pending: plan.pending };
}
const tick = (tx: Db, at: string | Date, pol: Policy) =>
  tickTenantCycles(typeof at === 'string' ? new Date(at) : at, DEMO_TENANT_ID, tx, { setting: pol.setting, pending: pol.pending });
/** Every cycle row as `kind:key:phase start→close` (dates only), ordered by start. */
async function cycleRows(tx: Db): Promise<string[]> {
  const rows = await tx.select().from(marketplaceCycles).orderBy(marketplaceCycles.period_start);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return rows.map((r) => `${r.period_kind}:${r.period_key}:${r.phase} ${d(r.period_start)}→${d(r.closes_at)}`);
}

test('week→month MID-WEEK: weeks keep running; the last week before the 1st is STRETCHED to it; the month opens on the 1st', async () => {
  // 2095-12-01 is a Thursday. Switch on Wed 2095-11-02 (week W44, Oct 31 → Nov 7).
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-11-02T03:00:00Z', pol); // opens W44
    pol = await switchTo(tx, new Date('2095-11-02T12:00:00Z'), pol, 'month');
    expect(pol.pending).toEqual({ at: new Date('2095-12-01T00:00:00Z'), previous: 'week' });
    // ⛔ The original engine opened the month containing `now` (2095-11, from Nov 1) on the first
    // tick after W44 closed — a month that was already a week old. Every Monday must open a WEEK.
    for (const mon of ['2095-11-07', '2095-11-14', '2095-11-21']) {
      const t = await tick(tx, `${mon}T03:00:00Z`, pol);
      expect(periodFromKey(t.opened!).kind).toBe('week');
    }
    // Nov 28 → Dec 5 would cross Dec 1: no such week opens; the Nov 21 week runs on to Dec 1.
    const late = await tick(tx, '2095-11-28T03:00:00Z', pol);
    expect(late.opened).toBe('2095-W47');
    const d1 = await tick(tx, '2095-12-01T03:00:00Z', pol);
    expect(d1.closed).toEqual(['2095-W47']);
    expect(d1.opened).toBe('2095-12');
    expect(await cycleRows(tx)).toEqual([
      'week:2095-W44:closed 2095-10-31→2095-11-07',
      'week:2095-W45:closed 2095-11-07→2095-11-14',
      'week:2095-W46:closed 2095-11-14→2095-11-21',
      'week:2095-W47:closed 2095-11-21→2095-12-01', // 10 days: stretched, never truncated
      'month:2095-12:voting 2095-12-01→2096-01-01',
    ]);
    // The stretch went to the BUILDING phase: voting still ended on the week's own Friday.
    const [w47] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-W47'));
    expect(w47!.voting_ends_at.toISOString()).toBe('2095-11-25T00:00:00.000Z');
  });
});

test('month→week for a month ENDING ON A SUNDAY: no stretch, the first week opens on the Monday after', async () => {
  // July 2095 ends Sunday 31st, so its close (Mon Aug 1) already is a week boundary.
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'month', pending: null };
    await tick(tx, '2095-07-01T03:00:00Z', pol);
    pol = await switchTo(tx, new Date('2095-07-12T09:00:00Z'), pol, 'week');
    expect(pol.pending!.at.toISOString()).toBe('2095-08-01T00:00:00.000Z');
    // Mid-July ticks open nothing new (the month governs).
    expect((await tick(tx, '2095-07-18T03:00:00Z', pol)).opened).toBe('2095-07');
    const t = await tick(tx, '2095-08-01T03:00:00Z', pol);
    expect(t.closed).toEqual(['2095-07']);
    expect(t.opened).toBe('2095-W31');
    expect(await cycleRows(tx)).toEqual([
      'month:2095-07:closed 2095-07-01→2095-08-01',
      'week:2095-W31:voting 2095-08-01→2095-08-08',
    ]);
  });
  // …and a month that does NOT end on a Sunday (Nov 2095 ends Wed 30th) runs on to the Monday.
  const plan = planCadenceSwitch(new Date('2095-11-10T00:00:00Z'), { setting: 'month', pending: null }, 'week', {
    id: 'x',
    period_kind: 'month',
    period_key: '2095-11',
    period_start: new Date('2095-11-01T00:00:00Z'),
    closes_at: new Date('2095-12-01T00:00:00Z'),
  } as MarketplaceCycle);
  expect(plan.pending!.at.toISOString()).toBe('2095-12-05T00:00:00.000Z');
  expect(plan.liveUpdate!.closes_at.toISOString()).toBe('2095-12-05T00:00:00.000Z');
  expect(plan.next!.key).toBe('2095-W49');
});

test('week→quarter then quarter→month: the last fitting week stretches to the quarter; the quarter votes 2 months, builds 1', async () => {
  // 2095-04-01 is a Friday. Switch Wed 2095-03-09 (W10, Mar 7 → 14).
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-03-07T03:00:00Z', pol);
    pol = await switchTo(tx, new Date('2095-03-09T10:00:00Z'), pol, 'quarter');
    expect(pol.pending).toEqual({ at: new Date('2095-04-01T00:00:00Z'), previous: 'week' });
    for (const mon of ['2095-03-14', '2095-03-21']) expect(periodFromKey((await tick(tx, `${mon}T03:00:00Z`, pol)).opened!).kind).toBe('week');
    // Mar 28 → Apr 4 would cross Apr 1: no such week opens; W12 runs on to Apr 1.
    expect((await tick(tx, '2095-03-28T03:00:00Z', pol)).opened).toBe('2095-W12');
    const a1 = await tick(tx, '2095-04-01T03:00:00Z', pol);
    expect(a1.closed).toEqual(['2095-W12']);
    expect(a1.opened).toBe('2095-Q2');
    const [q2] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-Q2'));
    expect(q2!.voting_ends_at.toISOString()).toBe('2095-06-01T00:00:00.000Z');
    expect(q2!.closes_at.toISOString()).toBe('2095-07-01T00:00:00.000Z');

    // quarter→month mid-quarter: the quarter already ends on a month boundary — no stretch.
    pol = await switchTo(tx, new Date('2095-05-10T10:00:00Z'), pol, 'month');
    expect(pol.pending).toEqual({ at: new Date('2095-07-01T00:00:00Z'), previous: 'quarter' });
    expect((await tick(tx, '2095-06-01T03:00:00Z', pol)).opened).toBe('2095-Q2');
    const j1 = await tick(tx, '2095-07-01T03:00:00Z', pol);
    expect(j1.closed).toEqual(['2095-Q2']);
    expect(j1.opened).toBe('2095-07');
    expect(await cycleRows(tx)).toEqual([
      'week:2095-W10:closed 2095-03-07→2095-03-14',
      'week:2095-W11:closed 2095-03-14→2095-03-21',
      'week:2095-W12:closed 2095-03-21→2095-04-01', // stretched 4 days, never truncated
      'quarter:2095-Q2:closed 2095-04-01→2095-07-01',
      'month:2095-07:voting 2095-07-01→2095-08-01',
    ]);
  });
});

test('week→year IN DECEMBER: weekly periods continue until 1 January; the last one is stretched, none is short', async () => {
  // 2096-01-01 is a Sunday. Switch Wed 2095-12-07 (W49, Dec 5 → 12).
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-12-05T03:00:00Z', pol);
    pol = await switchTo(tx, new Date('2095-12-07T10:00:00Z'), pol, 'year');
    expect(pol.pending!.at.toISOString()).toBe('2096-01-01T00:00:00.000Z');
    for (const d of ['2095-12-12', '2095-12-19', '2095-12-26', '2096-01-01']) await tick(tx, `${d}T03:00:00Z`, pol);
    const rows = await cycleRows(tx);
    expect(rows).toEqual([
      'week:2095-W49:closed 2095-12-05→2095-12-12',
      'week:2095-W50:closed 2095-12-12→2095-12-19',
      'week:2095-W51:closed 2095-12-19→2096-01-01', // 13 days
      'year:2096:voting 2096-01-01→2097-01-01',
    ]);
    const all = await tx.select().from(marketplaceCycles);
    for (const r of all) expect(r.closes_at.getTime() - r.period_start.getTime()).toBeGreaterThanOrEqual(7 * DAY_MS);
  });
});

test('off→week: nothing opens mid-week; the first week opens at the NEXT Monday', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'off', pending: null };
    pol = await switchTo(tx, new Date('2095-03-09T10:00:00Z'), pol, 'week'); // Wed of W10
    expect(pol.pending).toEqual({ at: new Date('2095-03-14T00:00:00Z'), previous: 'off' });
    // The original engine opened 2095-W10 (from Mon Mar 7) on this tick — a week already 3 days old.
    const mid = await tick(tx, '2095-03-10T03:00:00Z', pol);
    expect(mid.opened).toBeNull();
    expect(await cycleRows(tx)).toEqual([]);
    // Between the switch and the boundary the screens and the vote gate still see OFF.
    expect(cadenceStateFrom(new Date('2095-03-12T00:00:00Z'), pol.setting, null, pol.pending)).toMatchObject({
      effective: 'off',
      current: null,
    });
    const mon = await tick(tx, '2095-03-14T03:00:00Z', pol);
    expect(mon.opened).toBe('2095-W11');
    expect(await cycleRows(tx)).toEqual(['week:2095-W11:voting 2095-03-14→2095-03-21']);
  });
});

test('week→off: the running week finishes under its own rules and CROWNS; nothing opens after it', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-03-07T03:00:00Z', pol);
    const [ch] = await tx
      .insert(challenges)
      .values({ title: `${MARK} off ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2095-W10' })
      .returning();
    const [sol] = await tx
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} off sol`, author_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: '2095-W10', votes_count: 2 })
      .returning();
    pol = await switchTo(tx, new Date('2095-03-09T10:00:00Z'), pol, 'off');
    expect(pol.pending).toBeNull();
    // The week keeps its own close (no stretch, no truncation).
    expect(await cycleRows(tx)).toEqual(['week:2095-W10:voting 2095-03-07→2095-03-14']);
    const t = await tick(tx, '2095-03-14T03:00:00Z', pol);
    expect(t.closed).toEqual(['2095-W10']);
    expect(t.opened).toBeNull();
    const [w] = await tx.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, sol!.id));
    expect(w).toMatchObject({ week: '2095-W10' });
    expect(await tick(tx, '2095-03-21T03:00:00Z', pol)).toMatchObject({ opened: null, closed: [] });
    expect(await cycleRows(tx)).toEqual(['week:2095-W10:closed 2095-03-07→2095-03-14']);
  });
});

test('switching BACK while a switch is pending cancels it and un-stretches the running period', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-11-21T03:00:00Z', pol); // W47, Nov 21 → 28
    pol = await switchTo(tx, new Date('2095-11-22T10:00:00Z'), pol, 'month');
    expect(await cycleRows(tx)).toEqual(['week:2095-W47:voting 2095-11-21→2095-12-01']);
    pol = await switchTo(tx, new Date('2095-11-23T10:00:00Z'), pol, 'week');
    expect(pol.pending).toBeNull();
    expect(await cycleRows(tx)).toEqual(['week:2095-W47:voting 2095-11-21→2095-11-28']);
  });
});

test('OFF with a period running: the period still closes; nothing new opens after it', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    const wk = periodFromKey('2095-W10');
    await openCycle(wk, DEMO_TENANT_ID, tx);
    const t = await tickTenantCycles(new Date(wk.end.getTime() + 3_600_000), DEMO_TENANT_ID, tx, { setting: 'off' });
    expect(t.closed).toEqual([wk.key]);
    expect(t.opened).toBeNull();
    const again = await tickTenantCycles(new Date(wk.end.getTime() + 2 * 86_400_000), DEMO_TENANT_ID, tx, { setting: 'off' });
    expect(again).toMatchObject({ cadence: 'off', opened: null, closed: [] });
  });
});

test('MONTH lifecycle: voting through the 21st, building to month end, close crowns + opens the next month', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    const m = periodFromKey('2095-03');
    const row = await openCycle(m, DEMO_TENANT_ID, tx);
    expect(row.voting_ends_at.toISOString()).toBe('2095-03-22T00:00:00.000Z');
    expect(row.closes_at.toISOString()).toBe('2095-04-01T00:00:00.000Z');

    const [ch] = await tx
      .insert(challenges)
      .values({ title: `${MARK} month ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: m.key })
      .returning();
    const [sol] = await tx
      .insert(solutions)
      .values({
        challenge_id: ch!.id,
        title: `${MARK} month sol`,
        author_id: UID,
        tenant_id: DEMO_TENANT_ID,
        status: 'voting',
        week: m.key,
        votes_count: 3,
      })
      .returning();

    const p1 = await tickTenantCycles(new Date('2095-03-15T03:00:00Z'), DEMO_TENANT_ID, tx, { setting: 'month' });
    expect(p1.advanced).toEqual([]);
    const p2 = await tickTenantCycles(new Date('2095-03-22T03:00:00Z'), DEMO_TENANT_ID, tx, { setting: 'month' });
    expect(p2.advanced).toEqual(['2095-03']);
    const p3 = await tickTenantCycles(new Date('2095-04-01T03:00:00Z'), DEMO_TENANT_ID, tx, { setting: 'month' });
    expect(p3.closed).toEqual(['2095-03']);
    expect(p3.opened).toBe('2095-04');
    const [w] = await tx.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, sol!.id));
    expect(w).toMatchObject({ week: '2095-03', period_kind: 'month' });
    expect(w!.period_start!.toISOString()).toBe('2095-03-01T00:00:00.000Z');
  });
});

test('back-fill never walks across a cadence change (a kind switch is not an outage)', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    // A closed week long ago, setting now 'month': only the current month opens — no months between.
    const old = await openCycle(periodFromKey('2094-W10'), DEMO_TENANT_ID, tx);
    await tx.update(marketplaceCycles).set({ phase: 'closed', closed_at: new Date() }).where(eq(marketplaceCycles.id, old.id));
    const t = await tickTenantCycles(new Date('2095-03-10T03:00:00Z'), DEMO_TENANT_ID, tx, { setting: 'month' });
    expect(t.backfilled).toEqual([]);
    expect(t.opened).toBe('2095-03');
  });
});

test('the cadence state: the running period governs until it closes, then what is in force', () => {
  const now = new Date('2095-03-10T12:00:00Z');
  expect(cadenceStateFrom(now, 'off', null)).toMatchObject({ effective: 'off', current: null });
  const s = cadenceStateFrom(now, 'month', null);
  expect(s.effective).toBe('month');
  expect(s.current!.key).toBe('2095-03');
  const w10 = periodFromKey('2095-W10');
  const live = {
    period_kind: 'week',
    period_key: w10.key,
    period_start: w10.start,
    closes_at: w10.end,
  } as MarketplaceCycle;
  const running = cadenceStateFrom(now, 'off', live);
  expect(running.effective).toBe('week');
  expect(running.current!.key).toBe('2095-W10');
  expect(running.next).toBeNull(); // switching off: nothing follows
  // Past its close the row no longer governs (it waits for the tick): what is in force does.
  expect(cadenceStateFrom(new Date('2095-03-14T01:00:00Z'), 'off', live)).toMatchObject({ effective: 'off', current: null });
  // A STRETCHED row governs to its stretched close, and the next period is of the new kind.
  const toApril = { ...live, period_key: '2095-W12', period_start: periodFromKey('2095-W12').start, closes_at: new Date('2095-04-01T00:00:00Z') } as MarketplaceCycle;
  const st2 = cadenceStateFrom(new Date('2095-03-30T09:00:00Z'), 'month', toApril, { at: new Date('2095-04-01T00:00:00Z'), previous: 'week' });
  expect(st2.current!.key).toBe('2095-W12');
  expect(st2.next!.key).toBe('2095-04');
});

// ── the vote gate, end to end ────────────────────────────────────────────────────────────────

async function closedWeekSolution(): Promise<string> {
  // A solution in a week whose cycle is CLOSED: under any period gate a vote 409s.
  const wk = periodFromKey('2095-W10');
  const row = await openCycle(wk, DEMO_TENANT_ID);
  await db.update(marketplaceCycles).set({ phase: 'closed', closed_at: new Date() }).where(eq(marketplaceCycles.id, row.id));
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} gate ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: wk.key })
    .returning();
  const [s] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} gate sol`, author_id: UID, week: wk.key, status: 'voting', votes_count: 0 })
      .returning(),
  );
  return s!.id;
}

test('⛔ OFF mode: a CLOSED (crowned) period stays closed; only the stale arm is bypassed', async () => {
  const at = new Date('2095-03-22T10:00:00Z'); // W12 — W10 (closed row) and W08 (no row) are both behind it
  const id = await closedWeekSolution();
  // A solution in a PAST period that never had a row: stale under a period gate, open while off.
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} stale ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2095-W08' })
    .returning();
  const [stale] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} stale sol`, author_id: UID, week: '2095-W08', status: 'voting', votes_count: 0 })
      .returning(),
  );
  // Control: with the weekly cadence both refuse.
  __setCadenceOverrideForTests({ setting: 'week', live: null });
  for (const sid of [id, stale!.id]) {
    await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', sid, at))).rejects.toMatchObject({
      code: 'voting_closed',
    });
  }
  // OFF: the closed period's race is over — a vote would move a count under an announced result.
  __setCadenceOverrideForTests({ setting: 'off', live: null });
  await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', id, at))).rejects.toMatchObject({
    code: 'voting_closed',
  });
  // …while nothing goes STALE in off: the never-run period's entry is a plain ranking and takes the vote.
  const r = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', stale!.id, at));
  expect(r).toMatchObject({ voted: true, count: 1 });
});

test('⛔ a rolled-forward MONTH solution stays votable — period_start, not key text, decides', async () => {
  // Current period 2095-03 (month, live). A solution filed into NEXT month (it answers a challenge
  // `challengePeriodFor` rolled forward) has no cycle row yet and must accept votes. The old text
  // comparison `'2095-04' < weekString(now) = '2095-W12'` called it a dead past week and 409'd.
  const m = await openCycle(periodFromKey('2095-03'), DEMO_TENANT_ID);
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} fwd ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2095-04' })
    .returning();
  const [s] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} fwd sol`, author_id: UID, week: '2095-04', status: 'voting', votes_count: 0 })
      .returning(),
  );
  __setCadenceOverrideForTests({ setting: 'month', live: m });
  const now = new Date('2095-03-23T10:00:00Z');
  const r = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', s!.id, now));
  expect(r).toMatchObject({ voted: true, count: 1 });
});

// ── the setting is a governance policy ───────────────────────────────────────────────────────

test('the seeded cycle.cadence row matches CADENCE_POLICY_ROW (one definition, two writers)', async () => {
  // seed-platform.ts carries the row as a literal (the frontend label contract scrapes it); the boot
  // writer uses CADENCE_POLICY_ROW. If they drift, /governance shows different words depending on
  // which writer created the row.
  const src = await Bun.file(new URL('../src/db/seed-platform.ts', import.meta.url)).text();
  expect(src.length).toBeGreaterThan(1000);
  const at = src.indexOf("key: 'cycle.cadence'");
  expect(at).toBeGreaterThan(-1);
  const obj = src.slice(at, src.indexOf('},', at));
  expect(obj).toContain(`category: '${CADENCE_POLICY_ROW.category}'`);
  expect(obj).toContain(`label: '${CADENCE_POLICY_ROW.label}'`);
  expect(obj).toContain(`'${CADENCE_POLICY_ROW.description}'`);
  expect(obj).toContain(`control: '${CADENCE_POLICY_ROW.control}'`);
  expect(obj).toContain(`options: [${(CADENCE_POLICY_ROW.options ?? []).map((o) => `'${o}'`).join(', ')}]`);
  expect(obj).toContain(`sort: ${CADENCE_POLICY_ROW.sort}`);
});

test('PATCH /api/governance/cycle.cadence validates the select and records a policy_changes diff', async () => {
  const [before] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  // The switch moves the running row's close (stretch) — snapshot every live row to put it back.
  const liveBefore = await db.select().from(marketplaceCycles).where(ne(marketplaceCycles.phase, 'closed'));
  await ensureCadencePolicy();
  const [row] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  expect(row).toMatchObject({ control: 'select', category: 'marketplace', options: ['off', 'week', 'month', 'quarter', 'year'] });
  const original = row!.value;

  const admin: User = { id: UID, email: 'cadence@test', name: 'Cad Admin', roles: ['super_admin', 'employee'] };
  __setAuthOverridesForTests({
    validateAuth: async () => admin,
    requireRole: async (_r, role) => {
      if (!admin.roles.includes(role)) throw new UnauthorizedError('no');
      return admin;
    },
  });
  const router = new Router();
  registerGovernanceRoutes(router);
  const patch = async (value: unknown) => {
    const m = router.match('PATCH', `/api/governance/${CADENCE_POLICY_KEY}`)!;
    const res = await m.handler(
      new Request(`http://localhost/api/governance/${CADENCE_POLICY_KEY}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      }),
      ...m.params,
    );
    return res.status;
  };
  // 'quarter' (0109) unless that is already the value: the PATCH must accept the new kind.
  const target = original === 'quarter' ? 'month' : 'quarter';
  try {
    expect(await patch('daily')).toBe(422);
    expect(await patch(target)).toBe(200);
    expect(await readCadenceSetting()).toBe(target);
    const diffs = await db
      .select()
      .from(policyChanges)
      .where(and(eq(policyChanges.policy_key, CADENCE_POLICY_KEY), eq(policyChanges.changed_by, UID)));
    expect(diffs.some((d) => d.old_value === original && d.new_value === target)).toBe(true);
    // The switch is PERSISTED with the value (not in memory): a pending boundary in the future, and
    // the cadence in force until then — so every replica and the boot catch-up agree.
    const [after] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
    if (original !== 'off') {
      expect(after!.previous_value).toBe(original);
      expect(after!.effective_from!.getTime()).toBeGreaterThan(Date.now());
    }
  } finally {
    __setAuthOverridesForTests(undefined);
    for (const r of liveBefore) {
      await db
        .update(marketplaceCycles)
        .set({ voting_ends_at: r.voting_ends_at, solution_ends_at: r.solution_ends_at, closes_at: r.closes_at })
        .where(eq(marketplaceCycles.id, r.id));
    }
    if (before) {
      await db
        .update(policies)
        .set({ value: original, effective_from: before.effective_from, previous_value: before.previous_value })
        .where(eq(policies.key, CADENCE_POLICY_KEY));
      await db.delete(policyChanges).where(and(eq(policyChanges.policy_key, CADENCE_POLICY_KEY), eq(policyChanges.changed_by, UID)));
    } else {
      // This file created the row: remove it (cascades its policy_changes) so the table is as found.
      await db.delete(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
    }
    // ⛔ The setting is read through policy-store's ≤5s snapshot cache. Restoring the ROW without
    // dropping the cache left 'year' visible to the NEXT file for up to 5s — every week-stamped
    // solution then read as closed (measured: marketplace-summary's "solutions in voting" went 0).
    invalidatePolicyCache();
  }
});

test('a challenge filed after voting in a STRETCHED week rolls into the coming MONTH, not a week that never opens', async () => {
  const w47 = periodFromKey('2095-W47');
  const row = {
    period_kind: 'week',
    period_key: w47.key,
    period_start: w47.start,
    phase: 'voting',
    voting_ends_at: new Date('2095-11-25T00:00:00Z'),
    closes_at: new Date('2095-12-01T00:00:00Z'),
  } as MarketplaceCycle;
  const pending = { at: new Date('2095-12-01T00:00:00Z'), previous: 'week' as const };
  const now = new Date('2095-11-29T10:00:00Z'); // in the extension, after W47's voting closed
  const st = cadenceStateFrom(now, 'month', row, pending);
  expect(challengePeriodFor(now, 'week', row, { current: st.current!, next: st.next }).key).toBe('2095-12');
  // The ROUTE must pass the state's current/next — without them the roll goes to the week after
  // periodFor(now), a week that never opens.
  expect(challengePeriodFor(now, 'week', row).key).not.toBe('2095-12');
  const src = await Bun.file(new URL('../src/routes/challenges.ts', import.meta.url)).text();
  expect(src.length).toBeGreaterThan(1000);
  expect(src).toContain('next: cadence.next');
  expect(src).toContain('current: cadence.current');
});

// ── B: rows rolled into a period the switch passes over are RE-HOMED ─────────────────────────

test('⛔ week→month, Friday submission end to end: submit → switch → vote → tick; the passed-over entry lands where a FRESH submission would — the coming MONTH, with a full voting window', async () => {
  // W47 = Mon 2095-11-21 → 28; 2095-12-01 is a Thursday, so the switch stretches W47 to Dec 1.
  const w47 = await openCycle(periodFromKey('2095-W47'), DEMO_TENANT_ID);
  try {
    const week: Policy = { setting: 'week', pending: null };
    // Friday, after W47's challenge voting closed: the challenge rolls into W48, and its solution
    // follows it there (`laterPeriod`) — exactly what routes/challenges + routes/solutions stamp.
    const fri = new Date('2095-11-25T10:00:00Z');
    const st = cadenceStateFrom(fri, week.setting, w47, week.pending);
    const chP = challengePeriodFor(fri, 'week', w47, { current: st.current!, next: st.next });
    expect(chP.key).toBe('2095-W48');
    const [ch] = await db
      .insert(challenges)
      .values({ title: `${MARK} fri ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, ...periodColumns(chP) })
      .returning();
    const [sol] = await withTenantDb(DEMO_TENANT_ID, () =>
      db
        .insert(solutions)
        .values({ challenge_id: ch!.id, title: `${MARK} fri sol`, author_id: UID, status: 'voting', votes_count: 0, ...periodColumns(laterPeriod(st.current!, chP)) })
        .returning(),
    );
    expect(sol!.week).toBe('2095-W48');

    // Saturday: switch to month. W48 will never open (W47 is stretched over it): its rows are
    // STRANDED. THE sweep moves them to where a fresh Saturday submission would be stamped: W47's
    // challenge voting closed on Nov 25, so the challenge rolls into the coming MONTH (the switch's
    // next period) and its solution follows it — NOT back into the stretched W47, where no one could
    // ever vote on the challenge again.
    const sat = new Date('2095-11-26T09:00:00Z');
    const plan = planCadenceSwitch(sat, week, 'month', w47);
    expect(plan.next?.key).toBe('2095-12');
    const moved = await applyCadenceSwitchToCycles(plan, db, DEMO_TENANT_ID, { at: sat, setting: 'month' });
    expect(moved).toBeGreaterThanOrEqual(2);
    const month: Policy = { setting: 'month', pending: plan.pending };
    expect(await stampOf(challenges, ch!.id)).toEqual(['2095-12', 'month']);
    expect(await stampOf(solutions, sol!.id)).toEqual(['2095-12', 'month']);
    // Idempotent: a second sweep finds nothing stranded — the rows already sit at their target.
    expect(await applyCadenceSwitchToCycles({ ...plan, liveUpdate: null }, db, DEMO_TENANT_ID, { at: sat, setting: 'month' })).toBe(0);

    const [w47s] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.id, w47.id));
    expect(w47s!.closes_at.toISOString()).toBe('2095-12-01T00:00:00.000Z');
    // Never dead in between: the upcoming month has no row yet, and the entry is votable.
    __setCadenceOverrideForTests({ ...month, live: w47s! });
    const during = await withTenantDb(DEMO_TENANT_ID, () =>
      castVote(VOTER, 'solution', sol!.id, new Date('2095-11-29T10:00:00Z')),
    );
    expect(during).toMatchObject({ voted: true, count: 1 });

    // The 03:00 tick closes the stretched week WITHOUT this entry and opens December, where it
    // competes with December's full challenge-voting window still ahead of it.
    const tickAt = new Date('2095-12-01T03:00:00Z');
    const t = await tickTenantCycles(tickAt, DEMO_TENANT_ID, db, month);
    expect(t.closed).toContain('2095-W47');
    expect(t.opened).toBe('2095-12');
    expect(await db.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, sol!.id))).toEqual([]);
    const [dec] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-12'));
    expect(dec!.phase).toBe('voting');
    expect(dec!.voting_ends_at.getTime()).toBeGreaterThan(tickAt.getTime() + 14 * DAY_MS);
    expect(await stampOf(challenges, ch!.id)).toEqual(['2095-12', 'month']);
    expect(await stampOf(solutions, sol!.id)).toEqual(['2095-12', 'month']);
  } finally {
    __setCadenceOverrideForTests();
  }
}, 30_000);

test('⛔ the tick that OPENS a period re-homes rows stamped into a period that never opened (same transaction)', async () => {
  // The switch-time re-home cannot see a row filed AFTER it into the passed-over week (an old pod
  // mid-rollout still stamps W+1). The open is the second, final chance.
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    let pol: Policy = { setting: 'week', pending: null };
    await tick(tx, '2095-11-21T03:00:00Z', pol);
    pol = await switchTo(tx, new Date('2095-11-22T10:00:00Z'), pol, 'month');
    const [late] = await tx
      .insert(challenges)
      .values({ title: `${MARK} late w48`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2095-W48' })
      .returning();
    // A past period that DID have a row is history — never moved.
    const [hist] = await tx
      .insert(challenges)
      .values({ title: `${MARK} hist w47`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2095-W47' })
      .returning();
    const t = await tick(tx, '2095-12-01T03:00:00Z', pol);
    expect(t.opened).toBe('2095-12');
    const [a] = await tx.select().from(challenges).where(eq(challenges.id, late!.id));
    const [b] = await tx.select().from(challenges).where(eq(challenges.id, hist!.id));
    expect(a!.week).toBe('2095-12');
    expect(b!.week).toBe('2095-W47');
  });
});

// ── C: OFF still claims the scheduler tick ───────────────────────────────────────────────────

test('⛔ OFF: the scheduler tick still CLAIMS scheduler_ticks (CommonPracticeDailySchedulerStale stays meaningful)', async () => {
  const now = new Date();
  const key = cycleTickKeyForNow(now);
  await db.delete(schedulerTicks).where(eq(schedulerTicks.key, key));
  __setCadenceOverrideForTests({ setting: 'off', live: null });
  try {
    await runCycleTick('test off tick', false, () => now);
    const [row] = await db.select().from(schedulerTicks).where(eq(schedulerTicks.key, key));
    expect(row).toBeDefined();
    // ⚠️ The behaviour above runs on the SHARED test DB, where other files leave live cycle rows —
    // and the original early return ("off AND nothing running → return before the claim") read the
    // real row, not the seam, so it would pass vacuously here. The source guard is what reddens on
    // that revert: nothing in runCycleTick may return before the claim is made.
    const src = await Bun.file(new URL('../src/host/cycle-scheduler.ts', import.meta.url)).text();
    expect(src.length).toBeGreaterThan(500);
    const fn = src.slice(src.indexOf('export async function runCycleTick'));
    const beforeClaim = fn.slice(0, fn.indexOf('claimTick('));
    expect(beforeClaim.length).toBeGreaterThan(0);
    expect(fn.indexOf('claimTick(')).toBeGreaterThan(0);
    expect(beforeClaim).not.toMatch(/\breturn\b/);
  } finally {
    __setCadenceOverrideForTests();
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, key));
  }
}, 30_000);

// ── D: the manual advance refuses a key of another kind ─────────────────────────────────────

test('⛔ POST /api/cycle/advance refuses (400) a period key whose kind is not the effective cadence', async () => {
  const admin: User = { id: UID, email: 'cadence@test', name: 'Cad Admin', roles: ['super_admin', 'employee'] };
  __setAuthOverridesForTests({
    validateAuth: async () => admin,
    requireRole: async (_r, role) => {
      if (!admin.roles.includes(role)) throw new UnauthorizedError('no');
      return admin;
    },
  });
  __setCadenceOverrideForTests({ setting: 'week', live: null });
  const router = new Router();
  registerCycleRoutes(router);
  // A key with NO row: driving it would OPEN a month beside the weeks. (A key that matches an existing
  // row of any kind may be driven — see the force-close test below.)
  await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-05'));
  const before = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-05'));
  try {
    const m = router.match('POST', '/api/cycle/advance')!;
    const res = await m.handler(
      new Request(`http://localhost/api/cycle/advance?tenantId=${DEMO_TENANT_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week: '2095-05', to: 'solution_phase' }),
      }),
      ...m.params,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('cycle_kind_mismatch');
    // Nothing was driven: no month row was opened or advanced to solution_phase.
    const after = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-05'));
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  } finally {
    __setAuthOverridesForTests(undefined);
    __setCadenceOverrideForTests();
  }
}, 30_000);

// ── round 3: catch-up across B, manual advance on existing rows, lock ordering, re-home on open ──

const ADMIN: User = { id: UID, email: 'cadence@test', name: 'Cad Admin', roles: ['super_admin', 'employee'] };
function asAdmin(): void {
  __setAuthOverridesForTests({
    validateAuth: async () => ADMIN,
    requireRole: async (_r, role) => {
      if (!ADMIN.roles.includes(role)) throw new UnauthorizedError('no');
      return ADMIN;
    },
  });
}
async function postAdvance(body: unknown): Promise<{ status: number; json: unknown }> {
  const router = new Router();
  registerCycleRoutes(router);
  const m = router.match('POST', '/api/cycle/advance')!;
  const res = await m.handler(
    new Request(`http://localhost/api/cycle/advance?tenantId=${DEMO_TENANT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ...m.params,
  );
  return { status: res.status, json: await res.json() };
}
async function patchCadence(value: unknown): Promise<number> {
  const router = new Router();
  registerGovernanceRoutes(router);
  const m = router.match('PATCH', `/api/governance/${CADENCE_POLICY_KEY}`)!;
  const res = await m.handler(
    new Request(`http://localhost/api/governance/${CADENCE_POLICY_KEY}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    }),
    ...m.params,
  );
  return res.status;
}
/** Insert a cycle row WITHOUT going through `claimCycle` (no re-home side effect on the shared DB). */
async function rawCycleRow(key: string, phase: MarketplaceCycle['phase'] = 'voting'): Promise<MarketplaceCycle> {
  const p = periodFromKey(key);
  await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, key));
  const [row] = await db
    .insert(marketplaceCycles)
    .values({
      tenant_id: DEMO_TENANT_ID,
      week: p.key,
      period_kind: p.kind,
      period_key: p.key,
      period_start: p.start,
      phase,
      ...boundariesOf(p),
      ...(phase === 'closed' ? { closed_at: new Date() } : {}),
    })
    .returning();
  return row!;
}
/**
 * Wait until some backend is parked on a row lock running a statement that matches `like`. Polls
 * pg_stat_activity; THROWS if it never parks, so a test built on it cannot pass vacuously.
 */
async function waitForLockWait(like: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = (await db.execute(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        and query ilike ${like}`)) as unknown as { n: number }[];
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: { n: number }[] }).rows;
    if ((list[0]?.n ?? 0) > 0) return;
    await Bun.sleep(25);
  }
  throw new Error(`no backend ever waited on a lock running ${like}`);
}
/** Hold the cadence policy row locked by an UNCOMMITTED update to `value`; `release()` commits it. */
function holdPolicyUpdate(value: Cadence): { locked: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const lockedP = new Promise<void>((r) => (locked = r));
  const done = db.transaction(async (b) => {
    await b
      .update(policies)
      .set({ value, effective_from: null, previous_value: null })
      .where(eq(policies.key, CADENCE_POLICY_KEY));
    locked();
    await gate;
  });
  return { locked: lockedP, release, done };
}
async function setPolicyCommitted(value: Cadence): Promise<void> {
  await ensureCadencePolicy();
  await db.update(policies).set({ value, effective_from: null, previous_value: null }).where(eq(policies.key, CADENCE_POLICY_KEY));
  invalidatePolicyCache();
}

test('⛔ catch-up ACROSS a pending switch: old weeks (stretched) → November → December; November is never merged into December', async () => {
  // 2026: week→month switched Tue Oct 13 while W42 (Oct 12 → 19) runs ⇒ B = Sun Nov 1, and W43
  // (Oct 19 → 26) is stretched to Nov 1 (the week after it would cross B). The pod is then down
  // until Sat Dec 5. Two outage starts: before W43 opened (Oct 14) and inside it (Oct 28).
  for (const outageFrom of ['2026-10-14', '2026-10-28'] as const) {
    await inRolledBackTx(async (tx) => {
      await tx.delete(marketplaceCycles);
      let pol: Policy = { setting: 'week', pending: null };
      await tick(tx, '2026-10-12T03:00:00Z', pol);
      pol = await switchTo(tx, new Date('2026-10-13T10:00:00Z'), pol, 'month');
      expect(pol.pending!.at.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      if (outageFrom === '2026-10-28') {
        await tick(tx, '2026-10-19T03:00:00Z', pol);
        await tick(tx, '2026-10-28T03:00:00Z', pol);
      }
      // November's own entry (rolled forward into the month before the outage) with real votes…
      const [novCh] = await tx
        .insert(challenges)
        .values({ title: `${MARK} nov ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2026-11' })
        .returning();
      const [novSol] = await tx
        .insert(solutions)
        .values({ challenge_id: novCh!.id, title: `${MARK} nov sol`, author_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: '2026-11', votes_count: 2 })
        .returning();
      // …and a row an old pod stamped into W44 (Oct 26), a week the switch passed over.
      const [w44] = await tx
        .insert(challenges)
        .values({ title: `${MARK} w44 ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2026-W44' })
        .returning();

      const t = await tick(tx, '2026-12-05T03:00:00Z', pol);
      expect(t.opened).toBe('2026-12');
      expect(t.backfilled).toEqual(outageFrom === '2026-10-14' ? ['2026-W43', '2026-11'] : ['2026-11']);
      expect(t.closed).toContain('2026-11');
      expect(await cycleRows(tx)).toEqual([
        'week:2026-W42:closed 2026-10-12→2026-10-19',
        'week:2026-W43:closed 2026-10-19→2026-11-01', // stretched to B
        'month:2026-11:closed 2026-11-01→2026-12-01',
        'month:2026-12:voting 2026-12-01→2027-01-01',
      ]);
      // November competed as November and was crowned there; nothing of it moved into December.
      const [sol] = await tx.select().from(solutions).where(eq(solutions.id, novSol!.id));
      expect(sol!.week).toBe('2026-11');
      const [win] = await tx.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, novSol!.id));
      expect(win).toMatchObject({ week: '2026-11', period_kind: 'month' });
      const [a] = await tx.select().from(challenges).where(eq(challenges.id, novCh!.id));
      const [b] = await tx.select().from(challenges).where(eq(challenges.id, w44!.id));
      expect(a!.week).toBe('2026-11');
      // The passed-over week's row is STRANDED (no row, above the floor the tick read before its own
      // closes) and joins the CURRENT open period — December — never a dead week. (A previous round
      // routed it into November; the invariant only ever sweeps into the current period.)
      expect(b!.week).toBe('2026-12');
    });
  }
}, 30_000);

test('⛔ POST /api/cycle/advance: an EXISTING row of any kind is driven in off mode and in the post-boundary gap; OPENING is refused', async () => {
  asAdmin();
  try {
    // OFF, a week row still running (or past its close, waiting for the tick): force-close it by key.
    await rawCycleRow('2095-W20');
    __setCadenceOverrideForTests({ setting: 'off', live: null });
    const off = await postAdvance({ week: '2095-W20', to: 'closed' });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ periodKey: '2095-W20', phase: 'closed' });

    // The 00:00–03:00 gap after a week→month boundary: the effective cadence is already MONTH while
    // the stretched week row has reached its close. Its key is a week — and it must still close.
    const w21 = await rawCycleRow('2095-W21');
    __setCadenceOverrideForTests({ setting: 'month', live: w21 });
    const gap = await postAdvance({ week: '2095-W21', to: 'closed' });
    expect(gap.status).toBe(200);
    expect(gap.json).toMatchObject({ periodKey: '2095-W21', phase: 'closed' });

    // OFF + a key with NO row: opening is refused with its own code, and nothing is created.
    await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-W22'));
    __setCadenceOverrideForTests({ setting: 'off', live: null });
    const open = await postAdvance({ week: '2095-W22', to: 'solution_phase' });
    expect(open.status).toBe(422);
    expect(JSON.stringify(open.json)).toContain('cycle_off');
    expect(await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2095-W22'))).toEqual([]);
    // OFF + no key: also `cycle_off`, and the message no longer tells the operator to "pass a period key".
    const bare = await postAdvance({ to: 'closed' });
    expect(bare.status).toBe(422);
    expect(JSON.stringify(bare.json)).toContain('cycle_off');
    expect(JSON.stringify(bare.json)).not.toContain('Pass a period key');
  } finally {
    __setAuthOverridesForTests(undefined);
    __setCadenceOverrideForTests();
  }
}, 30_000);

test('⛔ POST /api/cycle/advance that OPENS the current period sweeps stranded rows into it', async () => {
  asAdmin();
  try {
    await rawCycleRow('2097-01', 'closed'); // floor = Feb 1 2097
    await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2097-02'));
    // A week that runs INTO February (Jan 28 → Feb 4) and never opened (the cadence is monthly). It
    // STARTS before the floor but ENDS after it — it was never in January's race, so it is stranded.
    const [ch] = await db
      .insert(challenges)
      .values({ title: `${MARK} adv w05`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2097-W05' })
      .returning();
    __setCadenceOverrideForTests({ setting: 'month', live: null });
    __setCycleClockForTests(new Date('2097-02-01T01:00:00Z'));
    const r = await postAdvance({ week: '2097-02', to: 'solution_phase' });
    expect(r.status).toBe(200);
    const [after] = await db.select().from(challenges).where(eq(challenges.id, ch!.id));
    expect(after!.week).toBe('2097-02');
    // The OPEN itself sweeps too (not only the route): a row stamped into the passed-over week after
    // the period exists is taken in by the next open-claim of the CURRENT period.
    // February's challenge voting is still open (Feb 1 01:00) once its phase is back at voting.
    await db.update(marketplaceCycles).set({ phase: 'voting' }).where(eq(marketplaceCycles.period_key, '2097-02'));
    await db.update(challenges).set({ week: '2097-W05' }).where(eq(challenges.id, ch!.id));
    await openCycle(periodFromKey('2097-02'), DEMO_TENANT_ID);
    const [again] = await db.select().from(challenges).where(eq(challenges.id, ch!.id));
    expect(again!.week).toBe('2097-02');
    // …and the target is what a FRESH submission would get: with February past its challenge voting
    // (forced to solution_phase), a stranded challenge goes to March, never into a closed window.
    await db.update(marketplaceCycles).set({ phase: 'solution_phase' }).where(eq(marketplaceCycles.period_key, '2097-02'));
    await db.update(challenges).set({ week: '2097-W05' }).where(eq(challenges.id, ch!.id));
    await openCycle(periodFromKey('2097-02'), DEMO_TENANT_ID);
    const [rolled] = await db.select().from(challenges).where(eq(challenges.id, ch!.id));
    expect(rolled!.week).toBe('2097-03');
  } finally {
    __setAuthOverridesForTests(undefined);
    __setCadenceOverrideForTests();
    __setCycleClockForTests();
  }
}, 30_000);

test('⛔ the 00:00–03:00 gap: an entry in a never-opened period after the last CLOSED cycle is votable and joins the period the tick opens; history behind a closed cycle stays closed', async () => {
  await rawCycleRow('2097-12', 'closed'); // floor = Jan 1 2098: everything that ENDED by then is history
  const jan = await rawCycleRow('2098-01'); // the running month: closes Feb 1, the tick has not run yet
  await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2098-02'));
  const mk = async (key: string, tag: string) => {
    const [ch] = await db
      .insert(challenges)
      .values({ title: `${MARK} ${tag} ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: key })
      .returning();
    const [s] = await withTenantDb(DEMO_TENANT_ID, () =>
      db
        .insert(solutions)
        .values({ challenge_id: ch!.id, title: `${MARK} ${tag} sol`, author_id: UID, week: key, status: 'voting', votes_count: 0 })
        .returning(),
    );
    return s!.id;
  };
  const passedOver = await mk('2098-W05', 'gap'); // Jan 26 → Feb 2 2098: runs INTO February
  const history = await mk('2097-W50', 'hist'); // Dec 2097: ended behind the closed 2097-12 — dead
  // Jan 19 → 26 2098: never opened, ENDS before February — but after the last closed cycle, so nothing
  // ever judged it. It used to be dead (the old "ends before the current period" arm); it is
  // STRANDED: votable, and swept into the current period.
  const stranded = await mk('2098-W04', 'stranded');
  __setCadenceOverrideForTests({ setting: 'month', live: jan });
  const gap = new Date('2098-02-01T01:00:00Z');
  try {
    for (const open of [passedOver, stranded]) {
      const r = await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', open, gap));
      expect(r).toMatchObject({ voted: true, count: 1 });
    }
    await expect(withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', history, gap))).rejects.toMatchObject({
      code: 'voting_closed',
    });
    // The 03:00 tick closes January and opens February; its sweep takes both entries in.
    const t = await tickTenantCycles(new Date('2098-02-01T03:00:00Z'), DEMO_TENANT_ID, db, { setting: 'month' });
    expect(t.opened).toBe('2098-02');
    const week = async (id: string) => (await db.select().from(solutions).where(eq(solutions.id, id)))[0]!.week;
    expect(await week(passedOver)).toBe('2098-02');
    expect(await week(stranded)).toBe('2098-02');
    expect(await week(history)).toBe('2097-W50');
  } finally {
    __setCadenceOverrideForTests();
  }
}, 30_000);

test('⛔ the tick reads the cadence FRESH under FOR SHARE: a switch committing while the tick waits is fully seen', async () => {
  const [orig] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  await setPolicyCommitted('off');
  // Prime the per-pod snapshot with OFF — the stale value the old tick would have used.
  expect(await readCadenceSetting()).toBe('off');
  const hold = holdPolicyUpdate('week');
  await hold.locked;
  let result: Awaited<ReturnType<typeof tickTenantCycles>> | undefined;
  try {
    const ticking = inRolledBackTx(async (tx) => {
      await tx.delete(marketplaceCycles);
      result = await tickTenantCycles(new Date('2095-03-14T03:00:00Z'), DEMO_TENANT_ID, tx); // Monday of 2095-W11
    });
    await waitForLockWait('%policies%for share%');
    hold.release();
    await hold.done;
    await ticking;
    // The switch committed while the tick waited ⇒ the tick saw it whole: the week opens.
    expect(result).toMatchObject({ cadence: 'week', opened: '2095-W11' });
  } finally {
    hold.release();
    await hold.done.catch(() => {});
    if (orig) {
      await db
        .update(policies)
        .set({ value: orig.value, effective_from: orig.effective_from, previous_value: orig.previous_value })
        .where(eq(policies.key, CADENCE_POLICY_KEY));
    }
    invalidatePolicyCache();
  }
}, 30_000);

test('⛔ concurrent cadence PATCHes: policy_changes.old_value is the value read UNDER the row lock', async () => {
  const [orig] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  const liveBefore = await db.select().from(marketplaceCycles).where(ne(marketplaceCycles.phase, 'closed'));
  await setPolicyCommitted('week');
  asAdmin();
  // Another edit (week → month) is mid-flight and holds the row; this PATCH (→ year) pre-reads 'week'.
  const hold = holdPolicyUpdate('month');
  await hold.locked;
  try {
    const patching = patchCadence('year');
    await waitForLockWait('%policies%for update%');
    hold.release();
    await hold.done;
    expect(await patching).toBe(200);
    const diffs = await db
      .select()
      .from(policyChanges)
      .where(and(eq(policyChanges.policy_key, CADENCE_POLICY_KEY), eq(policyChanges.changed_by, UID)));
    const mine = diffs.filter((d) => d.new_value === 'year');
    expect(mine.length).toBe(1);
    expect(mine[0]!.old_value).toBe('month');
  } finally {
    hold.release();
    await hold.done.catch(() => {});
    __setAuthOverridesForTests(undefined);
    for (const r of liveBefore) {
      await db
        .update(marketplaceCycles)
        .set({ voting_ends_at: r.voting_ends_at, solution_ends_at: r.solution_ends_at, closes_at: r.closes_at })
        .where(eq(marketplaceCycles.id, r.id));
    }
    await db.delete(policyChanges).where(and(eq(policyChanges.policy_key, CADENCE_POLICY_KEY), eq(policyChanges.changed_by, UID)));
    if (orig) {
      await db
        .update(policies)
        .set({ value: orig.value, effective_from: orig.effective_from, previous_value: orig.previous_value })
        .where(eq(policies.key, CADENCE_POLICY_KEY));
    }
    invalidatePolicyCache();
  }
}, 30_000);

// ── I1: THE STRANDED-ROW INVARIANT — a row stamped into a period that never opens is never dead ──

const hoursAfter = (base: Date, h: number) => new Date(base.getTime() + h * 3_600_000);
async function cycleRowOf(key: string): Promise<MarketplaceCycle> {
  const [r] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, key));
  return r!;
}
/** A challenge + solution stamped exactly as routes/challenges + routes/solutions would at `at`. */
async function fileEntry(p: Period, current: Period, at: Date, tag: string) {
  const [ch] = await db
    .insert(challenges)
    .values({ title: `${MARK} ${tag} ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, ...periodColumns(p), created_at: at })
    .returning();
  const [sol] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(solutions)
      .values({ challenge_id: ch!.id, title: `${MARK} ${tag} sol`, author_id: UID, status: 'voting', votes_count: 0, ...periodColumns(laterPeriod(current, p)), created_at: at })
      .returning(),
  );
  return { chId: ch!.id, solId: sol!.id };
}
async function stampOf(table: typeof challenges | typeof solutions, id: string): Promise<[string, string | null]> {
  const [r] = await db.select({ week: table.week, kind: table.period_kind }).from(table).where(eq(table.id, id));
  return [r!.week, r!.kind];
}

test('⛔ I1(a) week→off at 01:00 Monday (before the 03:00 tick closes the week): Friday-rolled rows are OFF-stamped and votable; re-enabling week brings them into the new open week', async () => {
  const w10 = periodFromKey('2096-W10');
  const w11 = nextPeriod(w10);
  const w12 = nextPeriod(w11);
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.period_key, [w10.key, w11.key, w12.key]));
  try {
    let pol: Policy = { setting: 'week', pending: null };
    expect((await tickTenantCycles(hoursAfter(w10.start, 3), DEMO_TENANT_ID, db, pol)).opened).toBe(w10.key);
    const w10row = await cycleRowOf(w10.key);
    // Friday, after W10's challenge voting closed: the entry rolls into W11.
    const fri = hoursAfter(w10.start, 4 * 24 + 10);
    const st = cadenceStateFrom(fri, 'week', w10row, null);
    const chP = challengePeriodFor(fri, 'week', w10row, { current: st.current!, next: st.next });
    expect(chP.key).toBe(w11.key);
    const e = await fileEntry(chP, st.current!, fri, 'I1a');
    expect(await stampOf(solutions, e.solId)).toEqual([w11.key, 'week']);

    // Monday 01:00: W10 has reached its close, the 03:00 tick has not run. Switch to OFF.
    const mon = hoursAfter(w11.start, 1);
    const plan = planCadenceSwitch(mon, pol, 'off', await liveAt(db, mon));
    await applyCadenceSwitchToCycles(plan, db, DEMO_TENANT_ID, { at: mon, setting: 'off' });
    pol = { setting: 'off', pending: plan.pending };
    // W11 will never open: the sweep OFF-stamps both rows at once (the old window started strictly
    // AFTER W11's start, so they kept W11 — and after a later re-enable they were dead forever).
    expect(await stampOf(challenges, e.chId)).toEqual(['', 'off']);
    expect(await stampOf(solutions, e.solId)).toEqual(['', 'off']);
    __setCadenceOverrideForTests({ setting: 'off', live: w10row });
    expect(await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', e.solId, hoursAfter(w11.start, 2)))).toMatchObject({
      voted: true,
      count: 1,
    });

    // 03:00: W10 closes; nothing opens.
    const t = await tickTenantCycles(hoursAfter(w11.start, 3), DEMO_TENANT_ID, db, pol);
    expect(t.closed).toContain(w10.key);
    expect(t.opened).toBeNull();

    // Wednesday: re-enable week → the first week opens next Monday (W12) and takes the entry in.
    const wed = hoursAfter(w11.start, 2 * 24 + 10);
    const plan2 = planCadenceSwitch(wed, pol, 'week', await liveAt(db, wed));
    expect(plan2.pending).toEqual({ at: w12.start, previous: 'off' });
    await applyCadenceSwitchToCycles(plan2, db, DEMO_TENANT_ID, { at: wed, setting: 'week' });
    pol = { setting: 'week', pending: plan2.pending };
    expect(await stampOf(solutions, e.solId)).toEqual(['', 'off']); // still off until W12 opens
    const t2 = await tickTenantCycles(hoursAfter(w12.start, 3), DEMO_TENANT_ID, db, pol);
    expect(t2.opened).toBe(w12.key);
    expect(await stampOf(challenges, e.chId)).toEqual([w12.key, 'week']);
    expect(await stampOf(solutions, e.solId)).toEqual([w12.key, 'week']);
    const eligible = await db.select({ id: solutions.id }).from(solutions).where(eligibleForPeriod(w12.key, DEMO_TENANT_ID));
    expect(eligible.map((r) => r.id)).toContain(e.solId);
    __setCadenceOverrideForTests({ setting: 'week', live: await cycleRowOf(w12.key) });
    expect(await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER3, 'solution', e.solId, hoursAfter(w12.start, 5)))).toMatchObject({
      voted: true,
      count: 2,
    });
  } finally {
    __setCadenceOverrideForTests();
  }
}, 30_000);

test('⛔ I1(b) a pod with a STALE 5s policy stamps the NEXT week after a week→off switch: votable meanwhile, healed by the next tick', async () => {
  const w20 = periodFromKey('2096-W20');
  const w21 = nextPeriod(w20);
  await db.delete(marketplaceCycles).where(inArray(marketplaceCycles.period_key, [w20.key, w21.key]));
  try {
    const week: Policy = { setting: 'week', pending: null };
    await tickTenantCycles(hoursAfter(w20.start, 3), DEMO_TENANT_ID, db, week);
    const w20row = await cycleRowOf(w20.key);
    // Saturday: switch week → off. W20 runs on to its own close; nothing follows it.
    const sat = hoursAfter(w20.start, 5 * 24 + 9);
    const plan = planCadenceSwitch(sat, week, 'off', await liveAt(db, sat));
    await applyCadenceSwitchToCycles(plan, db, DEMO_TENANT_ID, { at: sat, setting: 'off' });
    const off: Policy = { setting: 'off', pending: plan.pending };
    // Two seconds later a pod whose snapshot still says `week` rolls a Saturday challenge into W21.
    const stale = new Date(sat.getTime() + 2_000);
    const st = cadenceStateFrom(stale, 'week', w20row, null);
    const chP = challengePeriodFor(stale, 'week', w20row, { current: st.current!, next: st.next });
    expect(chP.key).toBe(w21.key);
    const e = await fileEntry(chP, st.current!, stale, 'I1b');
    expect(await stampOf(solutions, e.solId)).toEqual([w21.key, 'week']);
    // Meanwhile it is votable: no row, after the floor — stranded, never dead.
    __setCadenceOverrideForTests({ setting: 'off', live: await cycleRowOf(w20.key) });
    expect(await withTenantDb(DEMO_TENANT_ID, () => castVote(VOTER, 'solution', e.solId, hoursAfter(sat, 1)))).toMatchObject({
      voted: true,
      count: 1,
    });
    // The NEXT tick (Sunday 03:00, W20 still running, nothing opens) heals it into W20.
    const sun = await tickTenantCycles(hoursAfter(w20.start, 6 * 24 + 3), DEMO_TENANT_ID, db, off);
    expect(sun.opened).toBe(w20.key);
    expect(sun.rehomed).toBeGreaterThanOrEqual(2);
    expect(await stampOf(challenges, e.chId)).toEqual([w20.key, 'week']);
    expect(await stampOf(solutions, e.solId)).toEqual([w20.key, 'week']);
    // …and it competes there: W20's close crowns it.
    const mon = await tickTenantCycles(hoursAfter(w21.start, 3), DEMO_TENANT_ID, db, off);
    expect(mon.closed).toContain(w20.key);
    const [win] = await db.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, e.solId));
    expect(win).toMatchObject({ week: w20.key });
  } finally {
    __setCadenceOverrideForTests();
  }
}, 30_000);

// ── I2: the catch-up replays the FULL cadence history ────────────────────────────────────────

test('⛔ I2 catch-up after TWO switches in one tick outage: W41..W43 (W43 stretched to Nov 1), November (stretched to Dec 7), then weeks; no row lost', async () => {
  // 2093 has 2026's calendar (Jan 1 = Thursday). The tick is dead from Oct 5 (newest row W40);
  // week→month is recorded Oct 8 (effective Nov 1), month→week Nov 15 (effective Dec 7). The policy
  // row alone says "month until Dec 7" — the October weeks were never reconstructed from it.
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    await tx.delete(policyChanges).where(eq(policyChanges.policy_key, CADENCE_POLICY_KEY));
    await tx
      .update(policies)
      .set({ value: 'week', effective_from: null, previous_value: null, updated_at: new Date('2093-09-01T00:00:00Z') })
      .where(eq(policies.key, CADENCE_POLICY_KEY));
    expect((await tickTenantCycles(new Date('2093-09-28T03:00:00Z'), DEMO_TENANT_ID, tx)).opened).toBe('2093-W40');

    // Pods kept stamping during the outage — one entry per period that must still be judged.
    const keys = ['2093-W41', '2093-W42', '2093-W43', '2093-11'];
    const sols: Record<string, string> = {};
    for (const key of keys) {
      const [ch] = await tx
        .insert(challenges)
        .values({ title: `${MARK} I2 ${key} ch`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: key })
        .returning();
      const [sol] = await tx
        .insert(solutions)
        .values({ challenge_id: ch!.id, title: `${MARK} I2 ${key} sol`, author_id: UID, tenant_id: DEMO_TENANT_ID, status: 'voting', week: key, votes_count: 1 })
        .returning();
      sols[key] = sol!.id;
    }

    const s1 = await switchCadence('month', new Date('2093-10-08T10:00:00Z'), tx, { updatedBy: null });
    expect(s1.pending).toEqual({ at: new Date('2093-11-01T00:00:00Z'), previous: 'week' });
    const s2 = await switchCadence('week', new Date('2093-11-15T10:00:00Z'), tx, { updatedBy: null });
    expect(s2.pending).toEqual({ at: new Date('2093-12-07T00:00:00Z'), previous: 'month' });
    // Both switches are history entries, each with its own effective instant.
    const trail = await tx
      .select({ n: policyChanges.new_value, e: policyChanges.effective_from })
      .from(policyChanges)
      .where(eq(policyChanges.policy_key, CADENCE_POLICY_KEY))
      .orderBy(policyChanges.created_at);
    expect(trail.map((r) => [r.n, r.e?.toISOString()])).toEqual([
      ['month', '2093-11-01T00:00:00.000Z'],
      ['week', '2093-12-07T00:00:00.000Z'],
    ]);
    // Neither switch moved anything: every one of those periods is still owed by the catch-up.
    for (const key of keys) {
      const [r] = await tx.select({ week: solutions.week }).from(solutions).where(eq(solutions.id, sols[key]!));
      expect(r!.week).toBe(key);
    }

    const t = await tickTenantCycles(new Date('2093-12-09T03:00:00Z'), DEMO_TENANT_ID, tx);
    expect(t.backfilled).toEqual(['2093-W41', '2093-W42', '2093-W43', '2093-11']);
    expect(t.opened).toBe('2093-W50');
    expect(await cycleRows(tx)).toEqual([
      'week:2093-W40:closed 2093-09-28→2093-10-05',
      'week:2093-W41:closed 2093-10-05→2093-10-12',
      'week:2093-W42:closed 2093-10-12→2093-10-19',
      'week:2093-W43:closed 2093-10-19→2093-11-01', // stretched to the week→month boundary
      'month:2093-11:closed 2093-11-01→2093-12-07', // stretched to the month→week boundary
      'week:2093-W50:voting 2093-12-07→2093-12-14',
    ]);
    // No row lost: each entry stayed in its own period and was crowned there.
    for (const key of keys) {
      const [r] = await tx.select({ week: solutions.week }).from(solutions).where(eq(solutions.id, sols[key]!));
      expect(r!.week).toBe(key);
      const [w] = await tx.select().from(weeklyWinners).where(eq(weeklyWinners.solution_id, sols[key]!));
      expect(w).toMatchObject({ week: key });
    }
  });
}, 30_000);

// ── I3: one connection per tick; a switch that meets the tick answers 409 ─────────────────────

test('⛔ I3 the tick does ALL its work on the transaction that holds FOR SHARE — no second connection', async () => {
  await inRolledBackTx(async (tx) => {
    // Every method called on the handle the tick was GIVEN (other than opening its transaction) is
    // work done outside that transaction — on another pooled connection in production.
    const outside: string[] = [];
    const handle = new Proxy(tx as object, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        if (prop !== 'transaction') outside.push(String(prop));
        return v.bind(target);
      },
    }) as Db;
    await tx.delete(marketplaceCycles);
    await tx
      .update(policies)
      .set({ value: 'week', effective_from: null, previous_value: null })
      .where(eq(policies.key, CADENCE_POLICY_KEY));
    // A past orphan so the `cycle.heal` audit write runs too.
    await tx
      .insert(challenges)
      .values({ title: `${MARK} I3 orphan`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2093-W05' });
    // …AND every call that reaches the DEFAULT pool (`db`, i.e. a `database = defaultDb` parameter
    // somebody forgot to pass). The proxy above only sees the handle the tick was given; a helper
    // that falls back to `db` takes a second pooled connection without ever touching it.
    const pooled: string[] = [];
    const methods = ['select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete', 'execute', 'transaction', 'with', '$with', '$count'];
    const spied: string[] = [];
    for (const m of methods) {
      const orig = (db as unknown as Record<string, unknown>)[m];
      if (typeof orig !== 'function') continue;
      (db as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        pooled.push(m);
        return (orig as (...a: unknown[]) => unknown)(...args);
      };
      spied.push(m);
    }
    expect(spied).toContain('insert');
    try {
      // Mon 03:00 opens W11; the next Monday's tick advances + closes it (solution phase, close,
      // winners, audits) and opens W12 — every write path of the tick.
      const r = await tickTenantCycles(new Date('2093-03-10T03:00:00Z'), DEMO_TENANT_ID, handle);
      expect(r.opened).toBe('2093-W11');
      expect(r.orphaned.length).toBeGreaterThan(0);
      const r2 = await tickTenantCycles(new Date('2093-03-16T03:00:00Z'), DEMO_TENANT_ID, handle);
      expect(r2.advanced).toContain('2093-W11');
      expect(r2.closed).toContain('2093-W11');
      expect(r2.opened).toBe('2093-W12');
    } finally {
      for (const m of spied) delete (db as unknown as Record<string, unknown>)[m];
    }
    expect(outside).toEqual([]);
    expect(pooled).toEqual([]);
  });
});

test('⛔ I3 a cadence PATCH that meets the running tick waits at most lock_timeout and answers 409 cycle_busy', async () => {
  const [orig] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  const target: Cadence = orig?.value === 'month' ? 'year' : 'month';
  const before = await db.select({ id: policyChanges.id }).from(policyChanges).where(eq(policyChanges.policy_key, CADENCE_POLICY_KEY));
  asAdmin();
  // A tick in flight: the policy row held FOR SHARE by an open transaction.
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (locked = r));
  const tickTx = db.transaction(async (t) => {
    await t.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY)).for('share');
    locked();
    await gate;
  });
  await isLocked;
  try {
    const router = new Router();
    registerGovernanceRoutes(router);
    const m = router.match('PATCH', `/api/governance/${CADENCE_POLICY_KEY}`)!;
    const t0 = Date.now();
    const res = await m.handler(
      new Request(`http://localhost/api/governance/${CADENCE_POLICY_KEY}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: target }),
      }),
      ...m.params,
    );
    const waited = Date.now() - t0;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cycle_busy' });
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(waited).toBeLessThan(25_000);
  } finally {
    release();
    await tickTx;
    __setAuthOverridesForTests(undefined);
  }
  // Nothing was written: same value, no new history row.
  const [after] = await db.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  expect(after?.value).toEqual(orig?.value);
  const now = await db.select({ id: policyChanges.id }).from(policyChanges).where(eq(policyChanges.policy_key, CADENCE_POLICY_KEY));
  expect(now.length).toBe(before.length);
}, 40_000);


// ── round 5: savepointed tick audits, one-transaction manual advance, switch instant under the lock,
//    governance no-op decided under the lock ──────────────────────────────────────────────────

test('⛔ a failing audit insert inside the tick cannot abort it (25P02): the phase change and the heal still commit', async () => {
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    await tx
      .insert(challenges)
      .values({ title: `${MARK} r5 orphan`, work_area: 'IT', submitter_id: UID, tenant_id: DEMO_TENANT_ID, week: '2093-W05' });
    __setCadenceOverrideForTests({ setting: 'week', live: null });
    const w = periodFromKey('2093-W11');
    expect((await tickTenantCycles(hoursAfter(w.start, 3), DEMO_TENANT_ID, tx)).opened).toBe(w.key);
    // From here on every `cycle.advance` / `cycle.heal` audit insert FAILS (a CHECK violation —
    // rolled back with the test transaction).
    await tx.execute(
      sql.raw(`alter table audit_log add constraint zz_r5_cycle_audit_fails check (action not in ('cycle.advance', 'cycle.heal')) not valid`),
    );
    const [row] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, w.key));
    const r = await tickTenantCycles(new Date(row!.voting_ends_at.getTime() + 3_600_000), DEMO_TENANT_ID, tx);
    expect(r.advanced).toEqual([w.key]);
    expect(r.orphaned.length).toBeGreaterThan(0); // the heal ran — and its audit failed — and the tick went on
    const [after] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, w.key));
    expect(after!.phase).toBe('solution_phase');
    const audits = (await tx.execute(
      sql`select count(*)::int as n from audit_log where action in ('cycle.advance', 'cycle.heal') and target_id = ${w.key}`,
    )) as unknown as { n: number }[];
    expect(audits[0]!.n).toBe(1); // only the FIRST tick's heal row; the failed ones left nothing
  });
}, 30_000);

test('⛔ POST /api/cycle/advance drives in ONE transaction that holds the policy row FOR SHARE (a switch cannot commit between its steps)', async () => {
  await ensureCadencePolicy();
  await inRolledBackTx(async (tx) => {
    let txCount = 0;
    const outside: string[] = [];
    const handle = new Proxy(tx as object, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        if (prop === 'transaction') txCount++;
        else outside.push(String(prop));
        return v.bind(target);
      },
    }) as Db;
    // A cadence switch in flight on another connection: the policy row held FOR UPDATE.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const sw = db.transaction(async (t) => {
      await t.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY)).for('update');
      locked();
      await gate;
    });
    await isLocked;
    let done = false;
    const drive = driveCycle('2096-W30', 'solution_phase', new Date('2096-07-25T10:00:00Z'), DEMO_TENANT_ID, handle).then(() => {
      done = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 600));
      expect(done).toBe(false); // waiting for the switch to commit — it never decides under a moving policy
    } finally {
      release();
      await sw;
      await drive;
    }
    expect(done).toBe(true);
    expect(txCount).toBe(1);
    expect(outside).toEqual([]);
    const [row] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, '2096-W30'));
    expect(row!.phase).toBe('solution_phase');
  });
}, 30_000);

test('⛔ switchCadence takes its instant AFTER the row lock is granted, so policy_changes replay in commit order', async () => {
  await ensureCadencePolicy();
  await inRolledBackTx(async (tx) => {
    const [orig] = await tx.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
    const target: Cadence = orig?.value === 'month' ? 'year' : 'month';
    // A tick in flight on another connection holds the row FOR SHARE.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const tickTx = db.transaction(async (t) => {
      await t.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY)).for('share');
      locked();
      await gate;
    });
    await isLocked;
    const sw = switchCadence(target, null, tx, { updatedBy: null });
    await new Promise((r) => setTimeout(r, 700));
    const releasedAt = Date.now();
    release();
    await tickTx;
    const res = await sw;
    expect(res.changed).toBe(true);
    const [change] = await tx
      .select()
      .from(policyChanges)
      .where(eq(policyChanges.policy_key, CADENCE_POLICY_KEY))
      .orderBy(desc(policyChanges.created_at))
      .limit(1);
    expect(change!.new_value).toBe(target);
    expect(change!.created_at.getTime()).toBeGreaterThanOrEqual(releasedAt - 5);
  });
}, 30_000);

test('⛔ governance PATCH decides "unchanged" UNDER the row lock: a value that differs by the time it locks is never dropped; a true no-op is changed:false with no trail', async () => {
  // The test's OWN policy row: it used to borrow the seeded `promotion.staging_canary_pct` and so
  // failed on a migrated-but-unseeded database. Any `number` row exercises the same PATCH path.
  const KEY = 'zz_cadtest.race_pct';
  await db.delete(policies).where(eq(policies.key, KEY));
  await db.insert(policies).values({ key: KEY, category: 'zz_cadtest', label: 'cadence test race', control: 'number', value: 5 });
  const [orig] = await db.select().from(policies).where(eq(policies.key, KEY));
  expect(orig).toBeDefined();
  const a = Number(orig!.value);
  const b = a === 10 ? 20 : 10;
  const router = new Router();
  registerGovernanceRoutes(router);
  const patch = async (value: unknown) => {
    const m = router.match('PATCH', `/api/governance/${KEY}`)!;
    const res = await m.handler(
      new Request(`http://localhost/api/governance/${KEY}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      }),
      ...m.params,
    );
    return { status: res.status, body: (await res.json()) as { value: unknown; changed?: boolean } };
  };
  const mine = () =>
    db.select().from(policyChanges).where(and(eq(policyChanges.policy_key, KEY), eq(policyChanges.changed_by, UID)));
  asAdmin();
  try {
    // A true no-op: 200, changed:false, nothing recorded (no diff, no audit row).
    const auditCount = async () =>
      ((await db.execute(sql`select count(*)::int as n from audit_log where action = 'policy.change' and target_id = ${KEY}`)) as unknown as { n: number }[])[0]!.n;
    const auditsBefore = await auditCount();
    const noop = await patch(a);
    expect(noop.status).toBe(200);
    expect(noop.body.changed).toBe(false);
    expect(await mine()).toEqual([]);
    expect(await auditCount()).toBe(auditsBefore);

    // Race: the row is locked; P1 (→ b) queues first, then P2 (→ a, equal to the PRE-lock value).
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (t) => {
      await t.select().from(policies).where(eq(policies.key, KEY)).for('update');
      locked();
      await gate;
    });
    await isLocked;
    const p1 = patch(b);
    await new Promise((r) => setTimeout(r, 300));
    const p2 = patch(a);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // P2 locked AFTER P1 committed b, so a is a real change — recorded, never silently dropped.
    expect([r1.body.changed, r2.body.changed]).toEqual([true, true]);
    const diffs = await mine();
    expect(diffs.map((d) => [Number(d.old_value), Number(d.new_value)]).sort()).toEqual([[a, b], [b, a]].sort());
    const [final] = await db.select().from(policies).where(eq(policies.key, KEY));
    expect(Number(final!.value)).toBe(a);
  } finally {
    __setAuthOverridesForTests(undefined);
    await db.delete(policyChanges).where(eq(policyChanges.policy_key, KEY));
    await db.delete(policies).where(eq(policies.key, KEY));
    invalidatePolicyCache();
  }
}, 30_000);

test('⛔ POST /api/cycle/advance — through the ROUTE — parks on a held cadence switch and commits nothing until it lands', async () => {
  // The route used to run sweep / open / drive as THREE transactions with no policy lock: with a
  // switch holding the policy row FOR UPDATE it ran straight through and committed the phase change
  // under the moving policy. It now calls `driveCycle` (one transaction, policy row FOR SHARE), so it
  // must WAIT. Red by restoring the old three-transaction body in routes/cycle.ts: nothing ever
  // parks on the policy row, so `waitForLockWait` throws (and the row is already solution_phase).
  await ensureCadencePolicy();
  const KEY = '2094-W10';
  await rawCycleRow(KEY);
  asAdmin();
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = db.transaction(async (t) => {
    await t.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY)).for('update');
    locked();
    await gate;
  });
  try {
    await isLocked;
    const res = postAdvance({ week: KEY, to: 'solution_phase' });
    try {
      await waitForLockWait('%policies%for share%');
      const [mid] = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, KEY));
      expect(mid!.phase).toBe('voting'); // nothing committed while the switch holds the row
    } finally {
      release();
      await holder;
    }
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ periodKey: KEY, phase: 'solution_phase' });
  } finally {
    release();
    __setAuthOverridesForTests(undefined);
    await db.delete(marketplaceCycles).where(eq(marketplaceCycles.period_key, KEY));
  }
}, 30_000);

/** Wait until some backend is parked on the CYCLE ENGINE advisory lock. Throws if none ever does. */
async function waitForEngineLockWait(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = (await db.execute(sql`
      select count(*)::int as n from pg_stat_activity a
      join pg_locks l on l.pid = a.pid and not l.granted and l.locktype = 'advisory'
      where a.datname = current_database() and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'
        and l.classid = ${CYCLE_TENANT_LOCK_NS}::int::oid and l.objid = hashtext(${DEMO_TENANT_ID}::uuid::text)::oid and l.objsubid = 2`)) as unknown as { n: number }[];
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: { n: number }[] }).rows;
    if ((list[0]?.n ?? 0) > 0) return;
    await Bun.sleep(25);
  }
  throw new Error('no backend ever waited on the cycle engine advisory lock');
}

test('⛔ the tick and the manual drive serialise on ONE advisory lock taken before any row lock (no 40P01 from inverted row-lock order)', async () => {
  // driveCycle locks stranded rows → the cycle row; the tick locks cycle rows → then sweeps. Both hold
  // the policy row only FOR SHARE, which does not serialise them — so they could deadlock (40P01).
  // Each now takes the TENANT's `pg_advisory_xact_lock(CYCLE_TENANT_LOCK_NS, hashtext(tenant))` FIRST
  // (0110). Here a stand-in transaction on another connection holds DEMO's lock; BOTH engine entry
  // points must park on it (polled in pg_stat_activity + pg_locks, never slept on), then complete once
  // it commits. Red by deleting either `lockTenantCycle(tx, …)` call in cycle-service.ts: that entry
  // point never waits and
  // `waitForEngineLockWait` throws.
  await ensureCadencePolicy();
  const KEY = '2094-W12';
  const now = new Date(periodFromKey(KEY).start.getTime() + 36 * 3_600_000); // inside KEY's voting
  const hold = () => {
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const isLocked = new Promise<void>((r) => (locked = r));
    const done = db.transaction(async (t) => {
      await t.execute(sql`select pg_advisory_xact_lock(${CYCLE_TENANT_LOCK_NS}::int, hashtext(${DEMO_TENANT_ID}::uuid::text))`);
      locked();
      await gate;
    });
    return { isLocked, release, done };
  };
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    const errors: unknown[] = [];

    // 1. The manual drive waits for a tick in flight.
    const h1 = hold();
    await h1.isLocked;
    let driven = false;
    const drive = driveCycle(KEY, 'solution_phase', now, DEMO_TENANT_ID, tx)
      .then(() => (driven = true))
      .catch((e) => errors.push(e));
    try {
      await waitForEngineLockWait();
      expect(driven).toBe(false);
    } finally {
      h1.release();
      await h1.done;
    }
    await drive;
    expect(errors).toEqual([]);
    expect(driven).toBe(true);
    const [row] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, KEY));
    expect(row!.phase).toBe('solution_phase');
  });
  // A SEPARATE outer transaction: an xact advisory lock taken in a savepoint is held until the
  // TOP-LEVEL transaction ends, so the first block's connection still owns it.
  await inRolledBackTx(async (tx) => {
    await tx.delete(marketplaceCycles);
    await rawCycleRowIn(tx, KEY);
    const errors: unknown[] = [];
    // 2. The tick waits for a drive in flight (the same lock, the other entry point).
    const h2 = hold();
    await h2.isLocked;
    let ticked = false;
    const tick = tickTenantCycles(now, DEMO_TENANT_ID, tx)
      .then(() => (ticked = true))
      .catch((e) => errors.push(e));
    try {
      await waitForEngineLockWait();
      expect(ticked).toBe(false);
    } finally {
      h2.release();
      await h2.done;
    }
    await tick;
    expect(errors).toEqual([]); // no 40P01, nothing else either
    expect(ticked).toBe(true);
    const [row] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.period_key, KEY));
    expect(row!.phase).toBe('voting'); // the tick ran and correctly left a period inside its voting window
  });
}, 30_000);

async function rawCycleRowIn(tx: Db, key: string): Promise<void> {
  const p = periodFromKey(key);
  await tx.insert(marketplaceCycles).values({ tenant_id: DEMO_TENANT_ID, week: p.key, period_kind: p.kind, period_key: p.key, period_start: p.start, phase: 'voting', ...boundariesOf(p) });
}
