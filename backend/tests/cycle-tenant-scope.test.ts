// tests/cycle-tenant-scope.test.ts — 0110: the voting-cycle engine is PER TENANT.
//
// Before 0110 `marketplace_cycles` was ONE platform clock (no tenant_id). Now every tenant owns its
// own cycle rows and may run its own cadence, so every engine query must carry a tenant predicate.
// Each test here is built so that dropping ONE such predicate at its call site turns it red:
//
//   1. the vote gate + GET /api/cycle/current, as cp_app: tenant B's closed rows must neither close
//      tenant A's votes (closedRow arm) nor lift A's stranded floor; A (monthly) and B (weekly) each
//      read THEIR OWN current period (readLiveCycle / readCurrentCycle);
//   2. the tick's back-fill reads the TENANT's newest row, and its sweep moves only that tenant's rows;
//   3. one tenant's failing tick does not stop the others (tickCycles' per-tenant isolation);
//   4. a platform switch moves only INHERITING tenants; a tenant switch (switchTenantCadence) only
//      that tenant — with its history replayed per tenant, and an identical value a no-op;
//   5. a source guard: no `marketplace_cycles` read in the engine without a tenant predicate.
//
// Far-future 2081–2088 periods and file-unique ids, so no other file's fixtures can interfere.
import { test, expect, afterAll, afterEach, spyOn } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  auditLog,
  challenges,
  marketplaceCycles,
  policies,
  solutions,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
  tenants,
  users,
  votes,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import {
  boundariesOf,
  CYCLE_TENANT_LOCK_NS,
  closeCycle,
  planCadenceSwitch,
  switchCadence,
  switchTenantCadence,
  tickCycles,
  tickTenantCycles,
} from '../src/host/cycle-service';
import {
  CADENCE_POLICY_KEY,
  __setCycleClockForTests,
  cadenceAt,
  invalidateTenantCadenceCache,
  readCadencePolicyWithHistory,
} from '../src/host/cycle-cadence';
import { castVote } from '../src/host/vote-service';
import { periodFor, periodFromKey, nextPeriodStart, firstBoundaryAtOrAfter, type Period } from '../src/host/period';
import { registerCycleRoutes } from '../src/routes/cycle';
import { Router } from '../src/utils/router';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { MarketplaceCycle } from '../src/db/schema';
import type { User } from '../src/types';
import { stripComments } from './helpers/strip-non-code';
import { periodClosedSql, SOLUTION_PERIOD, strandedFloorSql, tenantParam } from '../src/host/cycle-eligibility';
import { renderMetrics } from '../src/host/metrics';
import { TICK_FAILED_COUNTER } from '../src/host/tick-locks';
import { log } from '../src/host/logger';
import { UnauthorizedError } from '../src/types';

type Db = typeof db;
const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
const TA = id('0000011000a1');
const TB = id('0000011000b2');
const UA = id('0000011001a1');
const VA = id('0000011002a1');
const UB = id('0000011001b2');
const VB = id('0000011002b2');
const MARK = 'ZW7BTENANT';
const DAY = 86_400_000;

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

/** A cycle row for `tenantId` over `p`, inserted directly (no claim side effects). */
async function cycleRow(
  d: Db,
  tenantId: string,
  p: Period,
  phase: MarketplaceCycle['phase'],
): Promise<MarketplaceCycle> {
  const [row] = await d
    .insert(marketplaceCycles)
    .values({
      tenant_id: tenantId,
      week: p.key,
      period_kind: p.kind,
      period_key: p.key,
      period_start: p.start,
      phase,
      ...boundariesOf(p),
      ...(phase === 'closed' ? { closed_at: p.end } : {}),
    })
    .returning();
  return row!;
}

async function tenantRows(d: Db, ids: string[]) {
  for (const t of ids) {
    await d.insert(tenants).values({ id: t, name: `w7b ${t.slice(-4)}`, slug: `w7b-${t}` }).onConflictDoNothing();
  }
}

async function cleanupCommitted() {
  await db.delete(votes).where(inArray(votes.user_id, [VA, VB]));
  await db.delete(solutions).where(inArray(solutions.tenant_id, [TA, TB]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [TA, TB]));
  await db.delete(users).where(inArray(users.id, [UA, VA, UB, VB]));
  // Cascades the cycle rows, the overrides and their history.
  await db.delete(tenants).where(inArray(tenants.id, [TA, TB]));
  invalidateTenantCadenceCache();
}

afterEach(() => {
  __setAuthOverridesForTests(undefined);
  __setCycleClockForTests(undefined);
});
afterAll(cleanupCommitted, 30_000);

// ── 1. the vote gate and GET /api/cycle/current, per tenant, as cp_app ─────────────────────────────
test('⛔ tenant B (weekly) closing its weeks neither closes tenant A (monthly) votes nor moves A’s current period — as cp_app', async () => {
  await cleanupCommitted();
  await tenantRows(db, [TA, TB]);
  await db.insert(users).values([
    { id: UA, email: 'w7b-ua@test', name: 'W7B UA', tenant_id: TA },
    { id: VA, email: 'w7b-va@test', name: 'W7B VA', tenant_id: TA },
    { id: UB, email: 'w7b-ub@test', name: 'W7B UB', tenant_id: TB },
    { id: VB, email: 'w7b-vb@test', name: 'W7B VB', tenant_id: TB },
  ]);
  await db.insert(tenantCycleCadence).values([
    { tenant_id: TA, value: 'month' },
    { tenant_id: TB, value: 'week' },
  ]);
  const now = new Date('2081-03-20T12:00:00Z');
  const month = periodFromKey('2081-03');
  const w = periodFor('week', now);
  const w1 = periodFor('week', new Date(w.start.getTime() - DAY));
  // A: a closed January (A's floor = Feb 1) and a running March.
  await cycleRow(db, TA, periodFromKey('2081-01'), 'closed');
  await cycleRow(db, TA, month, 'voting');
  // B: a closed week straddling Mar 1 (it STARTED before A's March, so a floor read across tenants
  // would count it and land on Mar 5 — past A's February), a closed W-1 and a running W.
  await cycleRow(db, TB, periodFor('week', new Date('2081-02-28T12:00:00Z')), 'closed');
  await cycleRow(db, TB, w1, 'closed');
  await cycleRow(db, TB, w, 'voting');

  const [chA] = await db.insert(challenges).values({ title: `${MARK} A`, work_area: 'IT', submitter_id: UA, tenant_id: TA, week: month.key }).returning();
  const [chB] = await db.insert(challenges).values({ title: `${MARK} B`, work_area: 'IT', submitter_id: UB, tenant_id: TB, week: w.key }).returning();
  const sol = async (tenant: string, author: string, ch: string, key: string, label: string) =>
    (await db
      .insert(solutions)
      .values({ challenge_id: ch, title: `${MARK} ${label}`, author_id: author, status: 'voting', tenant_id: tenant, week: key, votes_count: 0 })
      .returning())[0]!.id;
  const aCurrent = sol(TA, UA, chA!.id, month.key, 'A current month');
  // February: no A row, ends Mar 1 — after A's floor (Feb 1) → STRANDED, never dead. B's floor (the
  // close of its week straddling Mar 1) would kill it.
  const aFeb = sol(TA, UA, chA!.id, '2081-02', 'A february');
  // W-1: A has no row for it; B CLOSED it. Another tenant's close must not end A's race.
  const aW1 = sol(TA, UA, chA!.id, w1.key, 'A w-1');
  const bW1 = sol(TB, UB, chB!.id, w1.key, 'B w-1');
  const [idCur, idFeb, idW1, idB] = await Promise.all([aCurrent, aFeb, aW1, bW1]);
  invalidateTenantCadenceCache();

  const vote = (tenant: string, voter: string, solution: string) =>
    withTenantDbAsRuntimeRoleForTests(tenant, () => castVote(voter, 'solution', solution, now)).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code }),
    );
  expect(await vote(TA, VA, idCur!)).toMatchObject({ ok: true, r: { voted: true } });
  expect(await vote(TA, VA, idFeb!), 'B’s floor killed A’s stranded February entry').toMatchObject({ ok: true });
  expect(await vote(TA, VA, idW1!), 'B’s closed W-1 closed A’s W-1 entry').toMatchObject({ ok: true });
  // Positive control: B's own closed week IS closed for B.
  expect(await vote(TB, VB, idB!)).toEqual({ ok: false, code: 'voting_closed' });

  // GET /api/cycle/current as cp_app: each tenant reads its OWN running period.
  const router = new Router();
  registerCycleRoutes(router);
  const getCurrent = async (tenant: string, user: User) => {
    __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
    const m = router.match('GET', '/api/cycle/current')!;
    const res = await withTenantDbAsRuntimeRoleForTests(tenant, () => m.handler(new Request('http://localhost/api/cycle/current'), ...m.params));
    expect(res.status).toBe(200);
    return (await res.json()) as { periodKind: string; periodKey: string; phase: string } | null;
  };
  __setCycleClockForTests(now);
  const a = await getCurrent(TA, { id: VA, email: 'w7b-va@test', name: 'W7B VA', roles: ['member'], tenantId: TA });
  const b = await getCurrent(TB, { id: VB, email: 'w7b-vb@test', name: 'W7B VB', roles: ['member'], tenantId: TB });
  expect(a).toMatchObject({ periodKind: 'month', periodKey: '2081-03', phase: 'voting' });
  expect(b).toMatchObject({ periodKind: 'week', periodKey: w.key, phase: 'voting' });

  // And B's tick closing W does not touch A's March (B's tick sees only B's rows).
  const r = await tickTenantCycles(new Date(w.end.getTime() + 3_600_000), TB);
  expect(r.closed).toEqual([w.key]);
  const [aMarch] = await db
    .select()
    .from(marketplaceCycles)
    .where(and(eq(marketplaceCycles.tenant_id, TA), eq(marketplaceCycles.period_key, '2081-03')));
  expect(aMarch!.phase).toBe('voting');
}, 30_000);

// ── 1b. RLS on marketplace_cycles (0110), as cp_app ─────────────────────────────────────────────
test('⛔ RLS as cp_app: a tenant reads only its own cycle rows, never another tenant’s, and cannot write any', async () => {
  // Runs on test 1's committed TA/TB rows. 0114: no tenant-less row can exist any more — the column
  // is NOT NULL, so even the owner (who bypasses RLS) cannot write one.
  const legacy = periodFromKey('2081-W40');
  const nullIns = await db
    .insert(marketplaceCycles)
    .values({
      tenant_id: null as unknown as string,
      week: legacy.key, period_kind: legacy.kind, period_key: legacy.key, period_start: legacy.start, phase: 'voting', ...boundariesOf(legacy),
    })
    .then(
      () => 'inserted',
      (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
    );
  expect(nullIns).toMatch(/null value in column "tenant_id"/);
  // And the read policy has no NULL branch left (0114 removed `tenant_id IS NULL OR`).
  const pols = (await db.execute(
    sql`SELECT cmd, qual FROM pg_policies WHERE tablename = 'marketplace_cycles'`,
  )) as unknown as { cmd: string; qual: string }[];
  expect(pols.map((p) => p.cmd)).toEqual(['SELECT']);
  expect(pols[0]!.qual).not.toMatch(/IS NULL/i);
  try {
    const visible = (t: string) =>
      withTenantDbAsRuntimeRoleForTests(t, () =>
        db
          .select({ tenant: marketplaceCycles.tenant_id, key: marketplaceCycles.period_key })
          .from(marketplaceCycles)
          .where(sql`${marketplaceCycles.tenant_id} in (${TA}::uuid, ${TB}::uuid) or ${marketplaceCycles.period_key} = ${legacy.key}`),
      );
    const a = await visible(TA);
    const b = await visible(TB);
    // Non-vacuity: the owner sees both tenants' rows.
    const owner = await db.select().from(marketplaceCycles).where(inArray(marketplaceCycles.tenant_id, [TA, TB]));
    expect(new Set(owner.map((r) => r.tenant_id))).toEqual(new Set([TA, TB]));
    expect(a.some((r) => r.tenant === TA)).toBe(true);
    expect(a.some((r) => r.tenant === TB), 'tenant A read tenant B’s cycle rows').toBe(false);
    expect(b.some((r) => r.tenant === TB)).toBe(true);
    expect(b.some((r) => r.tenant === TA), 'tenant B read tenant A’s cycle rows').toBe(false);
    expect(a.every((r) => r.tenant === TA)).toBe(true);
    expect(b.every((r) => r.tenant === TB)).toBe(true);

    // No write policy: an INSERT is refused, an UPDATE (own row, other tenant's) matches nothing.
    const p = periodFromKey('2081-W45');
    const ins = await withTenantDbAsRuntimeRoleForTests(TA, () =>
      db
        .insert(marketplaceCycles)
        .values({ tenant_id: TA, week: p.key, period_kind: p.kind, period_key: p.key, period_start: p.start, phase: 'voting', ...boundariesOf(p) })
        .then(
          () => 'inserted',
          (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
        ),
    );
    expect(ins).toMatch(/row-level security/);
    const upd = await withTenantDbAsRuntimeRoleForTests(TA, () =>
      db
        .update(marketplaceCycles)
        .set({ phase: 'closed' })
        .where(inArray(marketplaceCycles.tenant_id, [TA, TB]))
        .returning({ id: marketplaceCycles.id }),
    );
    expect(upd).toEqual([]);
    const del = await withTenantDbAsRuntimeRoleForTests(TA, () =>
      db.delete(marketplaceCycles).where(eq(marketplaceCycles.tenant_id, TA)).returning({ id: marketplaceCycles.id }),
    );
    expect(del).toEqual([]);
    const after = await db.select().from(marketplaceCycles).where(eq(marketplaceCycles.tenant_id, TA));
    const phases = (rows: MarketplaceCycle[]) => rows.map((r) => `${r.id}:${r.phase}`).sort();
    expect(phases(after)).toEqual(phases(owner.filter((r) => r.tenant_id === TA)));
  } finally {
    // nothing to clean up: the NULL-tenant insert above was refused
  }
}, 30_000);

// ── 2. the tick's back-fill and sweep are per tenant ─────────────────────────────────────────────
const TC = id('0000011000c3');
const TD = id('0000011000d4');
const UC = id('0000011001c3');

test('⛔ the tick back-fills from the TENANT’s newest row and sweeps only that tenant’s rows', async () => {
  await inRolledBackTx(async (tx) => {
    await tenantRows(tx, [TC, TD]);
    await tx.insert(users).values({ id: UC, email: 'w7b-uc@test', name: 'W7B UC' });
    await tx.insert(tenantCycleCadence).values([
      { tenant_id: TC, value: 'week' },
      { tenant_id: TD, value: 'week' },
    ]);
    // C's newest row is W10 (closed); D runs a NEWER week. A back-fill that read "the newest row" of
    // any tenant would start from D's W12 and open nothing for C.
    await cycleRow(tx, TC, periodFromKey('2082-W10'), 'closed');
    await cycleRow(tx, TD, periodFromKey('2082-W12'), 'voting');
    const now = new Date(periodFromKey('2082-W13').start.getTime() + DAY);
    // One OFF-filed challenge per tenant: re-enabling a period sweeps the TENANT's own into it.
    const filed = new Date(now.getTime() - DAY);
    const [offC] = await tx.insert(challenges).values({ title: `${MARK} off C`, work_area: 'IT', submitter_id: UC, tenant_id: TC, week: '', period_kind: 'off', created_at: filed }).returning();
    const [offD] = await tx.insert(challenges).values({ title: `${MARK} off D`, work_area: 'IT', submitter_id: UC, tenant_id: TD, week: '', period_kind: 'off', created_at: filed }).returning();

    const r = await tickTenantCycles(now, TC, tx);
    expect(r.backfilled).toEqual(['2082-W11', '2082-W12']);
    expect(r.opened).toBe('2082-W13');
    // (The open of W13 swept C's OFF row into it — `claimCycle` sweeps in the same transaction.)
    const [c] = await tx.select().from(challenges).where(eq(challenges.id, offC!.id));
    expect(c!.period_kind).toBe('week');
    const [dRow] = await tx.select().from(challenges).where(eq(challenges.id, offD!.id));
    expect(dRow!.period_kind, 'C’s tick swept D’s row').toBe('off');
    // D's rows are untouched: still exactly its one W12 row.
    const dCycles = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.tenant_id, TD));
    expect(dCycles.map((x) => `${x.period_key}:${x.phase}`)).toEqual(['2082-W12:voting']);
  });
}, 30_000);

// ── 3. one tenant's failure is isolated ─────────────────────────────────────────────────────────
const TE = id('0000011000e5');
const TF = id('0000011000f6');
const TG = id('000001100a07');

test('⛔ one tenant’s tick failing (its lock is busy) does not stop the other tenants from advancing', async () => {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (locked = r));
  // Another connection holds G's per-tenant cycle lock for the duration.
  const holder = db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(${CYCLE_TENANT_LOCK_NS}::int, hashtext(${TG}::uuid::text))`);
    locked();
    await gate;
  });
  try {
    await isLocked;
    await inRolledBackTx(async (tx) => {
      await tenantRows(tx, [TE, TF, TG]);
      await tx.insert(tenantCycleCadence).values([TE, TF, TG].map((t) => ({ tenant_id: t, value: 'week' as const })));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '1500ms'`));
      const now = new Date(periodFromKey('2083-W20').start.getTime() + DAY);
      const before = tickFailedCount();
      const summary = await tickCycles(now, tx);
      expect(summary.failed).toContain(TG);
      // ⛔ The failure reaches the alert's counter (CommonPracticeSchedulerTickFailing) exactly once —
      // tickCycles RETURNS normally, so claimTick's countFailures wrapper never sees it.
      expect(tickFailedCount(), 'a caught tenant failure did not bump scheduler_tick_failed_total').toBe(before + 1);
      const byId = new Map(summary.tenants.map((t) => [t.tenantId, t]));
      expect(byId.get(TG)?.error).toBeDefined();
      expect(byId.get(TE)?.result?.opened).toBe('2083-W20');
      expect(byId.get(TF)?.result?.opened).toBe('2083-W20');
      const rows = await tx.select().from(marketplaceCycles).where(inArray(marketplaceCycles.tenant_id, [TE, TF, TG]));
      expect(rows.map((x) => x.tenant_id).sort()).toEqual([TE, TF].sort()); // G rolled back, nothing half-done
    });
  } finally {
    release();
    await holder;
  }
}, 60_000);

function tickFailedCount(): number {
  const m = new RegExp(`^\\w*${TICK_FAILED_COUNTER} (\\d+)$`, 'm').exec(renderMetrics());
  expect(m, `${TICK_FAILED_COUNTER} is not rendered`).not.toBeNull();
  return Number(m![1]);
}

test('a tenant whose FIRST attempt fails is retried at the end of the same tick — and, once it succeeds, is neither failed nor counted', async () => {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(${CYCLE_TENANT_LOCK_NS}::int, hashtext(${TG}::uuid::text))`);
    locked();
    await gate;
  });
  // Release G's lock the moment its FIRST attempt is reported failed — deterministic, no sleeps: the
  // retry then waits (lock_timeout 1.5s) only for the holder's commit.
  const warn = spyOn(log, 'warn').mockImplementation((msg, fields) => {
    if (msg === 'cycle_tick_tenant_attempt_failed' && fields?.tenantId === TG) release();
  });
  try {
    await isLocked;
    await inRolledBackTx(async (tx) => {
      await tenantRows(tx, [TE, TF, TG]);
      await tx.insert(tenantCycleCadence).values([TE, TF, TG].map((t) => ({ tenant_id: t, value: 'week' as const })));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '1500ms'`));
      const now = new Date(periodFromKey('2083-W30').start.getTime() + DAY);
      const before = tickFailedCount();
      const summary = await tickCycles(now, tx);
      expect(warn.mock.calls.some(([m, f]) => m === 'cycle_tick_tenant_attempt_failed' && f?.tenantId === TG)).toBe(true); // it DID fail first
      expect(summary.failed, 'the failed tenant was not retried within the tick').toEqual([]);
      expect(summary.tenants.find((x) => x.tenantId === TG)?.result?.opened).toBe('2083-W30');
      expect(tickFailedCount()).toBe(before);
    });
  } finally {
    warn.mockRestore();
    release();
    await holder;
  }
}, 60_000);

// ── 4. platform switch vs tenant switch ───────────────────────────────────────────────────────────
const TH = id('000001100b08'); // inherits the platform cadence
const TI = id('000001100c09'); // overrides it

/** A week of 2084 whose NEXT week crosses a month boundary: a week→month switch stretches it. */
function stretchableWeek(): Period {
  for (let t = Date.UTC(2084, 2, 1); ; t += 7 * DAY) {
    const w = periodFor('week', new Date(t));
    const b = firstBoundaryAtOrAfter('month', w.end);
    if (b.getTime() > w.end.getTime() && nextPeriodStart('week', w.end).getTime() > b.getTime()) return w;
  }
}

test('⛔ a PLATFORM switch moves only inheriting tenants; a TENANT switch moves only that tenant (history per tenant, identical value a no-op)', async () => {
  await inRolledBackTx(async (tx) => {
    await tenantRows(tx, [TH, TI]);
    await tx
      .update(policies)
      .set({ value: 'week', effective_from: null, previous_value: null, updated_at: new Date('2084-01-01T00:00:00Z') })
      .where(eq(policies.key, CADENCE_POLICY_KEY));
    const w = stretchableWeek();
    const at = new Date(w.start.getTime() + DAY);
    const liveH = await cycleRow(tx, TH, w, 'voting');
    const liveI = await cycleRow(tx, TI, w, 'voting');

    // I pins 'week' — the value it inherits. That IS a change (a pin), recorded in I's history.
    const pin = await switchTenantCadence(TI, 'week', null, { at: new Date(at.getTime() - 3_600_000), database: tx });
    expect(pin).toMatchObject({ changed: true, inherited: true, oldValue: 'week' });
    // The identical value again is a NO-OP: nothing written.
    const again = await switchTenantCadence(TI, 'week', null, { at: new Date(at.getTime() - 1_800_000), database: tx });
    expect(again.changed).toBe(false);
    expect(await tx.select().from(tenantCycleCadenceChanges).where(eq(tenantCycleCadenceChanges.tenant_id, TI))).toHaveLength(1);

    // The platform goes week → month. H follows (its running week stretches to the month boundary);
    // I does not move at all.
    const expected = planCadenceSwitch(at, { setting: 'week', pending: null }, 'month', liveH);
    expect(expected.liveUpdate!.closes_at.getTime()).toBeGreaterThan(w.end.getTime()); // the fixture really stretches
    const sw = await switchCadence('month', at, tx, { updatedBy: null });
    expect(sw.inheriting).toContain(TH);
    expect(sw.inheriting).not.toContain(TI);
    const [h] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.id, liveH.id));
    const [i] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.id, liveI.id));
    expect(h!.closes_at.toISOString()).toBe(expected.liveUpdate!.closes_at.toISOString());
    expect(i!.closes_at.toISOString(), 'the platform switch stretched an OVERRIDING tenant').toBe(w.end.toISOString());

    // What each tenant's engine now reads: H the platform's month (pending), I its own week.
    const ph = await readCadencePolicyWithHistory(tx, TH, { lock: false });
    const pi = await readCadencePolicyWithHistory(tx, TI, { lock: false });
    expect(ph.setting).toBe('month');
    expect(ph.pending?.at.toISOString()).toBe(expected.pending!.at.toISOString());
    expect(pi).toMatchObject({ setting: 'week', pending: null });
    // I's timeline is the platform's up to I's first override, then its own: week throughout.
    const after = new Date(expected.pending!.at.getTime() + 40 * DAY);
    expect(cadenceAt(ph.timeline, after)).toBe('month');
    expect(cadenceAt(pi.timeline, after)).toBe('week');

    // Ticks after the boundary: H opens a month, I a week.
    const t = new Date(expected.pending!.at.getTime() + 2 * DAY);
    expect((await tickTenantCycles(t, TH, tx)).opened).toBe(periodFor('month', t).key);
    expect((await tickTenantCycles(t, TI, tx)).opened).toBe(periodFor('week', t).key);

    // A TENANT switch (I: week → quarter) moves I's running week, never H's running month.
    const iWeek = periodFor('week', t);
    const [iLive] = await tx
      .select()
      .from(marketplaceCycles)
      .where(and(eq(marketplaceCycles.tenant_id, TI), eq(marketplaceCycles.period_key, iWeek.key)));
    const [hLiveBefore] = await tx
      .select()
      .from(marketplaceCycles)
      .where(and(eq(marketplaceCycles.tenant_id, TH), eq(marketplaceCycles.period_key, periodFor('month', t).key)));
    const isw = await switchTenantCadence(TI, 'quarter', null, { at: new Date(t.getTime() + 3_600_000), database: tx });
    expect(isw).toMatchObject({ changed: true, inherited: false, oldValue: 'week' });
    expect(isw.pending?.previous).toBe('week');
    const [hLiveAfter] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.id, hLiveBefore!.id));
    expect(hLiveAfter!.closes_at.toISOString()).toBe(hLiveBefore!.closes_at.toISOString());
    const [iAfter] = await tx.select().from(marketplaceCycles).where(eq(marketplaceCycles.id, iLive!.id));
    expect(iAfter!.tenant_id).toBe(TI);
    expect(await tx.select().from(tenantCycleCadenceChanges).where(eq(tenantCycleCadenceChanges.tenant_id, TI))).toHaveLength(2);
  });
}, 60_000);

// ── 5. the source guard ─────────────────────────────────────────────────────────────────────────
test('⛔ no query in the cycle engine reads or writes marketplace_cycles without a tenant predicate', async () => {
  const files = [
    '../src/host/cycle-service.ts',
    '../src/host/cycle-cadence.ts',
    '../src/host/cycle-eligibility.ts',
    '../src/routes/cycle.ts',
    '../src/routes/challenges.ts',
  ];
  let checked = 0;
  for (const f of files) {
    const raw = await Bun.file(new URL(f, import.meta.url)).text();
    expect(raw.length, `${f} is empty or unreadable — the guard would pass vacuously`).toBeGreaterThan(1000);
    const src = stripComments(raw);
    // A predicate spelled once and reused (`const thisRow = and(eq(marketplaceCycles.tenant_id, …), …)`)
    // counts when its own definition carries the tenant.
    const tenantBound = new Set<string>();
    for (const d of src.matchAll(/const (\w+) = and\(([^;]*?)\);/g)) if (/tenant_id/.test(d[2]!)) tenantBound.add(d[1]!);
    const re = /(\.from\(marketplaceCycles\)|\.update\(marketplaceCycles\)|\.insert\(marketplaceCycles\)|\.delete\(marketplaceCycles\)|\$\{marketplaceCycles\})/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // The statement: up to its `;`, at most ~400 chars — the predicate sits right next to the table.
      const rest = src.slice(m.index, m.index + 400);
      const stmt = rest.slice(0, rest.indexOf(';') === -1 ? rest.length : rest.indexOf(';'));
      const ok = /tenant_id/.test(stmt) || [...tenantBound].some((v) => new RegExp(`\\b${v}\\b`).test(stmt));
      expect(ok, `${f}: a marketplace_cycles query with no tenant predicate:\n${stmt}`).toBe(true);
      checked++;
    }
  }
  // Non-vacuity: the engine has well over a dozen such statements.
  expect(checked).toBeGreaterThan(15);
});

// ── 6. two tenants on the SAME kind and the SAME period key ──────────────────────────────────────
// Both weekly, both with a row for week W. K closes W (and W-1); J's W is still running and J has a
// stranded W-1 entry (J has no W-1 row; J's latest close is W-3). K's closes must neither close J's
// W for voting (`periodClosedSql`'s closed-row arm) nor lift J's stranded floor (`strandedFloorSql`).
//
// ⚠️ WHY THE OWNER ARM IS THE ONE THAT CAN GO RED. Under cp_app the tenant GUC's RLS already hides
// K's cycle rows from J, so the vote below stays green even with the tenant predicate deleted — that
// arm documents the request path, it cannot catch the regression. The gate ALSO runs as the
// RLS-bypassing owner (the tick's healOrphanedChallenges, the scheduler's floor read), and there
// only the predicate separates the tenants. Each owner assertion below is pinned to ONE predicate.
const TJ = id('000001100d10');
const TK = id('000001100e11');
const UJ = id('000001101d10');
const VJ = id('000001102d10');
const UK = id('000001101e11');

test('⛔ same kind, same period key: tenant K closing W and W-1 neither closes J’s W nor kills J’s stranded W-1 — owner and cp_app', async () => {
  const cleanup = async () => {
    await db.delete(votes).where(eq(votes.user_id, VJ));
    await db.delete(solutions).where(inArray(solutions.tenant_id, [TJ, TK]));
    await db.delete(challenges).where(inArray(challenges.tenant_id, [TJ, TK]));
    await db.delete(users).where(inArray(users.id, [UJ, VJ, UK]));
    await db.delete(tenants).where(inArray(tenants.id, [TJ, TK]));
    invalidateTenantCadenceCache();
  };
  await cleanup();
  try {
    await tenantRows(db, [TJ, TK]);
    await db.insert(users).values([
      { id: UJ, email: 'w7b-uj@test', name: 'W7B UJ', tenant_id: TJ },
      { id: VJ, email: 'w7b-vj@test', name: 'W7B VJ', tenant_id: TJ },
      { id: UK, email: 'w7b-uk@test', name: 'W7B UK', tenant_id: TK },
    ]);
    await db.insert(tenantCycleCadence).values([
      { tenant_id: TJ, value: 'week' },
      { tenant_id: TK, value: 'week' },
    ]);
    const W = periodFromKey('2085-W20');
    const W1 = periodFromKey('2085-W19');
    const W3 = periodFromKey('2085-W17');
    const now = new Date(W.start.getTime() + DAY);
    await cycleRow(db, TJ, W3, 'closed'); // J's floor = end of W-3
    await cycleRow(db, TJ, W, 'voting');
    await cycleRow(db, TK, W1, 'closed');
    await cycleRow(db, TK, W, 'closed'); // K's floor = end of W (past J's W-1)

    const [chJ] = await db.insert(challenges).values({ title: `${MARK} J`, work_area: 'IT', submitter_id: UJ, tenant_id: TJ, week: W.key }).returning();
    const [chK] = await db.insert(challenges).values({ title: `${MARK} K`, work_area: 'IT', submitter_id: UK, tenant_id: TK, week: W.key }).returning();
    const sol = async (tenant: string, author: string, ch: string, key: string, label: string) =>
      (await db
        .insert(solutions)
        .values({ challenge_id: ch, title: `${MARK} ${label}`, author_id: author, status: 'voting', tenant_id: tenant, week: key, votes_count: 0 })
        .returning())[0]!.id;
    const jW = await sol(TJ, UJ, chJ!.id, W.key, 'J W');
    const jW1 = await sol(TJ, UJ, chJ!.id, W1.key, 'J W-1 stranded');
    const kW = await sol(TK, UK, chK!.id, W.key, 'K W');
    invalidateTenantCadenceCache();

    // OWNER (RLS bypassed): the gate exactly as the engine builds it, J's gate for J's rows.
    const gateJ = { mode: 'on' as const, kind: W.kind, start: W.start };
    const closedAsOwner = async (solutionId: string): Promise<boolean> => {
      const [r] = await db
        .select({ closed: periodClosedSql(SOLUTION_PERIOD, gateJ) })
        .from(solutions)
        .where(eq(solutions.id, solutionId));
      return r!.closed;
    };
    // Positive control: K's W solution IS closed (K closed W) — the gate is not vacuously open.
    expect(await closedAsOwner(kW)).toBe(true);
    // closed-row arm: K's closed W row must not close J's W entry.
    expect(await closedAsOwner(jW), 'K’s closed W closed J’s running W (periodClosedSql closed-row tenant predicate)').toBe(false);
    // floor arm: K's close of W must not lift J's floor over J's stranded W-1 entry.
    expect(await closedAsOwner(jW1), 'K’s floor killed J’s stranded W-1 entry (strandedFloorSql tenant predicate)').toBe(false);
    // The floor itself, as the engine reads it (a bound tenant uuid): J's own last close, not K's.
    const floorOf = async (t: string): Promise<number> => {
      const rows = (await db.execute(
        sql`select (extract(epoch from ${strandedFloorSql(W.start, tenantParam(t))}) * 1000)::float8 as floor`,
      )) as unknown as { floor: number | string }[];
      return Number(rows[0]!.floor);
    };
    expect(await floorOf(TJ), 'J’s stranded floor was lifted by K’s close').toBe(boundariesOf(W3).closes_at.getTime());
    expect(await floorOf(TK)).toBe(boundariesOf(W).closes_at.getTime()); // control: K's own floor is its W close

    // cp_app (the request path; RLS-masked — see the header): J can vote on both entries.
    const vote = (solution: string) =>
      withTenantDbAsRuntimeRoleForTests(TJ, () => castVote(VJ, 'solution', solution, now)).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code }),
      );
    expect(await vote(jW)).toMatchObject({ ok: true, r: { voted: true } });
    expect(await vote(jW1)).toMatchObject({ ok: true, r: { voted: true } });
  } finally {
    await cleanup();
  }
}, 30_000);

// ── 7. POST /api/cycle/advance?tenantId= refuses an unknown or offboarded tenant ─────────────────
const TO = id('000001100f12'); // offboarded
const TX = id('000001100f13'); // never exists

test('POST /api/cycle/advance?tenantId=: an unknown tenant is 404 (not an FK 500); an offboarded tenant is 409 — and nothing is opened', async () => {
  const admin: User = { id: UJ, email: 'w7b-admin@test', name: 'W7B Admin', roles: ['super_admin', 'employee'] };
  __setAuthOverridesForTests({
    validateAuth: async () => admin,
    requireRole: async (_r, role) => {
      if (!admin.roles.includes(role)) throw new UnauthorizedError('no');
      return admin;
    },
  });
  await db.delete(tenants).where(inArray(tenants.id, [TO, TX]));
  await db.insert(tenants).values({ id: TO, name: 'w7b offboarded', slug: `w7b-${TO}`, offboarded_at: new Date() });
  try {
    const router = new Router();
    registerCycleRoutes(router);
    const post = async (tenant: string) => {
      const m = router.match('POST', '/api/cycle/advance')!;
      const res = await m.handler(
        new Request(`http://localhost/api/cycle/advance?tenantId=${tenant}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'solution_phase' }),
        }),
        ...m.params,
      );
      return { status: res.status, body: JSON.stringify(await res.json()) };
    };
    const unknown = await post(TX);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain('tenant_not_found');
    const off = await post(TO);
    expect(off.status).toBe(409);
    expect(off.body).toContain('tenant_offboarded');
    expect(await db.select().from(marketplaceCycles).where(inArray(marketplaceCycles.tenant_id, [TO, TX]))).toEqual([]);
  } finally {
    await db.delete(tenants).where(inArray(tenants.id, [TO, TX]));
  }
}, 30_000);

// ── 8. an EMPTY tenant's period closes without audit rows ────────────────────────────────────────
const TL = id('000001100f14'); // nothing filed
const TM = id('000001100f15'); // one challenge
const UM = id('000001101f15');

test('a tenant period with no challenge and no solution still advances and closes, but writes no cycle.advance / cycle.close audit row', async () => {
  await inRolledBackTx(async (tx) => {
    await tenantRows(tx, [TL, TM]);
    await tx.insert(users).values({ id: UM, email: 'w7b-um@test', name: 'W7B UM', tenant_id: TM });
    await tx.insert(tenantCycleCadence).values([TL, TM].map((t) => ({ tenant_id: t, value: 'week' as const })));
    const W = periodFromKey('2086-W10');
    await cycleRow(tx, TL, W, 'voting');
    await cycleRow(tx, TM, W, 'voting');
    await tx.insert(challenges).values({ title: `${MARK} M`, work_area: 'IT', submitter_id: UM, tenant_id: TM, week: W.key });
    const at = new Date(W.end.getTime() + 3_600_000);
    const rl = await tickTenantCycles(at, TL, tx);
    const rm = await tickTenantCycles(at, TM, tx);
    // The transitions themselves happen for both.
    expect(rl.advanced).toEqual([W.key]);
    expect(rl.closed).toEqual([W.key]);
    expect(rm.closed).toEqual([W.key]);
    const audits = async (t: string) =>
      (
        await tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(
            and(
              inArray(auditLog.action, ['cycle.advance', 'cycle.close']),
              eq(auditLog.target_id, W.key),
              sql`${auditLog.metadata}->>'tenantId' = ${t}`,
            ),
          )
      )
        .map((r) => r.action)
        .sort();
    expect(await audits(TL), 'an empty period wrote cycle audit rows').toEqual([]);
    // Control: a period with a challenge (and no winner) is still audited, both rows.
    expect(await audits(TM)).toEqual(['cycle.advance', 'cycle.close']);
  });
}, 30_000);
