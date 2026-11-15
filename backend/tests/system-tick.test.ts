// tests/system-tick.test.ts — leader election for the boot schedulers (0051).
//
// The guard this replaces (a session-level `pg_try_advisory_lock`) could not work through the
// TRANSACTION pooler the owner pool points at in prod, and the audit trail proved it: `audit.export`
// wrote two rows ~200 ms apart on four separate nights. These tests pin the property that actually
// matters — concurrent callers, exactly one winner — plus the debounce window that lets the NEXT
// legitimate tick through.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, schedulerTicks, runSystemTick } from '../src/db/client';

const KEY = 'test_tick';
const HOUR = 60 * 60 * 1000;

async function cleanup() {
  await db.delete(schedulerTicks).where(eq(schedulerTicks.key, KEY));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(cleanup, 30_000);
afterAll(cleanup, 30_000);

test('the FIRST claim wins and the tick runs', async () => {
  let ran = 0;
  const out = await runSystemTick(KEY, HOUR, async () => {
    ran++;
    return 'done';
  });
  expect(out).toBe('done');
  expect(ran).toBe(1);
});

test('a second caller inside the window SKIPS — the fn never runs, and it returns undefined', async () => {
  let ran = 0;
  await runSystemTick(KEY, HOUR, async () => { ran++; });
  const second = await runSystemTick(KEY, HOUR, async () => { ran++; });
  expect(second).toBeUndefined();
  expect(ran).toBe(1);
});

test('CONCURRENT callers — the real replica case — produce exactly ONE run', async () => {
  // Both pods' schedulers fire within milliseconds of each other (the observed duplicate audit
  // exports were ~200 ms apart). Firing these in parallel is the whole point: the old advisory
  // lock passed a sequential test and still double-fired in prod, because two statements could
  // share a pooled server connection and Postgres lets a session re-acquire its own lock.
  let ran = 0;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => runSystemTick(KEY, HOUR, async () => { ran++; return 'x'; })),
  );
  expect(ran).toBe(1);
  expect(results.filter((r) => r === 'x')).toHaveLength(1);
  expect(results.filter((r) => r === undefined)).toHaveLength(7);
});

test('once the window has passed, the NEXT tick is claimable again', async () => {
  let ran = 0;
  await runSystemTick(KEY, HOUR, async () => { ran++; });
  // Age the claim past the window rather than sleeping.
  await db
    .update(schedulerTicks)
    .set({ last_run_at: new Date(Date.now() - 2 * HOUR) })
    .where(eq(schedulerTicks.key, KEY));
  await runSystemTick(KEY, HOUR, async () => { ran++; });
  expect(ran).toBe(2);
});

test('a THROWING tick still holds its claim — it does not hand the same tick to the next pod', async () => {
  // The claim is written when the tick STARTS. A pod that dies mid-tick therefore blocks that tick
  // for at most one window instead of letting a second pod redo half-finished work.
  await expect(
    runSystemTick(KEY, HOUR, async () => {
      throw new Error('tick blew up');
    }),
  ).rejects.toThrow('tick blew up');
  let ran = 0;
  const after = await runSystemTick(KEY, HOUR, async () => { ran++; });
  expect(after).toBeUndefined();
  expect(ran).toBe(0);
});

test('the claim records which pod won it (diagnostic provenance)', async () => {
  await runSystemTick(KEY, HOUR, async () => {});
  const [row] = await db.select().from(schedulerTicks).where(eq(schedulerTicks.key, KEY));
  expect(row).toBeTruthy();
  expect(row!.claimed_by).toBeTruthy();
});
