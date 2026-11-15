// tests/sandbox-watchdog-tick.test.ts — the idle-sandbox watchdog is claim-serialised across pods.
//
// The watchdog was the ONE scheduler with no claim: a 60s `setInterval` in every pod calling
// `runAsSystem` directly. At 4 HPA replicas that is a permanent 4x/min draw on the OWNER pool,
// which sits on the TRANSACTION pooler — CP's tighter ceiling, and the one that has already
// produced a live `08P01 server conn crashed?` FATAL. It now goes through `runSystemTick`.
//
// ⛔ THE TRAP THIS FILE EXISTS TO AVOID. The sweep is
// `UPDATE … WHERE status IN ('idle','error') AND last_active_at < cutoff RETURNING id`, which
// Postgres row-lock-serializes — the second caller re-evaluates the WHERE and matches nothing. So
// it is IDEMPOTENT AT THE ROW LEVEL, and an assertion like "the same sandboxes ended up suspended"
// or "no sandbox was double-audited" PASSES UNDER THE DEFECT TOO. Those tests would be green,
// meaningless, and indistinguishable from real ones.
//
// The only thing that separates fixed from broken is THE CLAIM: whether the second call inside the
// window declines to do the work at all. That is what is asserted here — the `scheduler_ticks` row,
// and the `undefined` return that means "another pod owns this tick".
//
// REVERT THAT REDS THIS: in src/host/sandbox-service.ts, change `runSandboxSweepTick` back to a
// bare `runAsSystem('scheduler-tick', () => sweepIdleSandboxes(defaultDb, new Date()))` → the second call returns an
// array instead of `undefined` and writes no claim row, failing every test below.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schedulerTicks, sandboxes, users, runAsSystem } from '../src/db/client';
import { runSandboxSweepTick } from '../src/host/sandbox-service';
import { TICK_LOCK, TICK_MIN_INTERVAL_MS } from '../src/host/tick-locks';

const KEY = TICK_LOCK.sandboxSweep;
const TENANT = '00000000-0000-0000-0000-000000000001';
// ⛔ Fixture ids DELETEd here must be unique to this file — every file shares one database (they
// run sequentially, NOT concurrently — corrected 2026-08-16; see
// tests/fixture-id-collisions.test.ts and the canonical note in metering-platform-calls.test.ts).
const OWNER_ID = '00000000-0000-0000-0000-0000ba5d0001';
const SANDBOX_ID = '00000000-0000-0000-0000-0000ba5d0002';

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, KEY));
    await db.delete(sandboxes).where(eq(sandboxes.id, SANDBOX_ID));
    await db.delete(users).where(eq(users.id, OWNER_ID));
  });
}

/** A sandbox that is unambiguously sweepable: idle, and last active long before any cutoff. */
async function seedIdleSandbox() {
  await runAsSystem('boot-seed', async () => {
    await db.insert(users).values({
      id: OWNER_ID,
      email: 'sandboxtick@test',
      name: 'Sandbox Tick',
      role: 'platform',
      tenant_id: TENANT,
    });
    await db.insert(sandboxes).values({
      id: SANDBOX_ID,
      tenant_id: TENANT,
      owner_id: OWNER_ID,
      slug: 'sandbox-watchdog-tick-fixture',
      status: 'idle',
      last_active_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
  });
}

async function claimRows() {
  return runAsSystem('scheduler-tick', () => db.select().from(schedulerTicks).where(eq(schedulerTicks.key, KEY)));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see license-provisioning.test.ts).
beforeEach(cleanup, 30_000);
afterAll(cleanup, 30_000);

test('the watchdog tick registers a claim under its own key', async () => {
  const out = await runSandboxSweepTick();
  expect(out).not.toBeUndefined();
  const rows = await claimRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.key).toBe(KEY);
}, 30_000);

test('a SECOND tick inside the min-interval is a no-op — this is the whole fix', async () => {
  await seedIdleSandbox();

  const first = await runSandboxSweepTick();
  // The winner actually did the work: our fixture is in its result set.
  expect(first).toContain(SANDBOX_ID);

  // Immediately again, well inside TICK_MIN_INTERVAL_MS.sandboxSweep — this is the other three pods
  // firing their own 60s timers within milliseconds of the winner.
  const second = await runSandboxSweepTick();
  // `undefined` — NOT an empty array. An empty array would mean the sweep RAN and matched nothing,
  // i.e. it still took an owner-pool connection, which is exactly the cost being removed. Only
  // `undefined` proves it never reached the sweep.
  expect(second).toBeUndefined();

  // …and exactly ONE claim row for the key, not one per caller.
  expect(await claimRows()).toHaveLength(1);
}, 30_000);

test('CONCURRENT ticks — the real 4-replica case — produce exactly ONE run', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => runSandboxSweepTick()));
  expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  expect(results.filter((r) => r === undefined)).toHaveLength(3);
  expect(await claimRows()).toHaveLength(1);
}, 30_000);

test('the min-interval is BELOW the 60s watchdog period, so a legitimate next tick is never suppressed', async () => {
  // A window >= the period would let a pod whose timer drifted early suppress every other pod's
  // next sweep, converting a rate limit into a stall. Cheap to assert, and the failure mode it
  // guards is silent.
  expect(TICK_MIN_INTERVAL_MS.sandboxSweep).toBeLessThan(60_000);

  await seedIdleSandbox();
  await runSandboxSweepTick();
  // Age the claim past the window rather than sleeping (same trick as tests/system-tick.test.ts).
  await runAsSystem('scheduler-tick', () =>
    db
      .update(schedulerTicks)
      .set({ last_run_at: new Date(Date.now() - 2 * TICK_MIN_INTERVAL_MS.sandboxSweep) })
      .where(eq(schedulerTicks.key, KEY)),
  );
  // Claimable again. The sweep itself finds nothing (already suspended) — an empty array, which is
  // still meaningfully different from the `undefined` a refused claim returns.
  const next = await runSandboxSweepTick();
  expect(next).not.toBeUndefined();
  expect(next).toHaveLength(0);

  // The fixture really was suspended by the first tick — the claim gates the sweep, it does not
  // replace it.
  const rows = await runAsSystem('scheduler-tick', () =>
    db
      .select({ status: sandboxes.status, reason: sandboxes.suspension_reason })
      .from(sandboxes)
      .where(and(eq(sandboxes.id, SANDBOX_ID), inArray(sandboxes.status, ['suspended']))),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reason).toBe('idle');
}, 30_000);
