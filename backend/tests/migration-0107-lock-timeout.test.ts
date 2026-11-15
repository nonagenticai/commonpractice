// tests/migration-0107-lock-timeout.test.ts — 0107 fails FAST under a held table lock, and the
// runner leaves the database exactly as it found it.
//
// 0107 ALTERs five hot tables (challenges, solutions, pipeline_items, weekly_winners,
// marketplace_cycles) plus policies, each needing ACCESS EXCLUSIVE, at pod startup while old pods
// still serve. Without a lock_timeout the ALTER queues behind any long reader and every later query
// on that table queues behind the ALTER: a full stall of the marketplace for as long as the reader
// runs. With `SET LOCAL lock_timeout = '5s'` the file fails with 55P03 instead.
//
// What happens then (measured here, through the REAL runner): `runMigrations` applies every pending
// file inside ONE transaction, so the failure rolls back the whole run — no half-applied file, no
// `_migrations` row — and `applyMigrations` throws, which at server.ts's top-level `await` exits the
// process; Kubernetes restarts the pod and the next boot retries from a clean slate.
//
// The file is fed to the runner under a fresh ordinal in a scratch directory (0107 itself is already
// applied on this database, and every statement in it is idempotent, so re-running it is a no-op
// unless the lock stops it). The scratch ordinal never reaches `_migrations`: the run fails.
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { runMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';

const FILE = new URL('../migrations/0107_cycle_period_columns.sql', import.meta.url).pathname;
const PROBE = '9107_lock_probe.sql';

test('⛔ 0107 under a held ACCESS EXCLUSIVE lock: fails with lock_timeout in ~5s and the run rolls back clean', async () => {
  const text = readFileSync(FILE, 'utf8');
  expect(text.length).toBeGreaterThan(1000); // never pass vacuously on an unreadable path
  const dir = mkdtempSync(join(tmpdir(), 'cp-0107-lock-'));
  writeFileSync(join(dir, PROBE), text);

  const holder = postgres(config.database.migrateUrl, { max: 1, onnotice: () => {} });
  const runner = postgres(config.database.migrateUrl, {
    max: 1,
    onnotice: () => {},
    // A backstop so a REVERTED file (no lock_timeout) fails this test in 20s instead of hanging it:
    // the error is then 57014 (statement timeout), not 55P03, and the assertion below reddens.
    connection: { statement_timeout: 20_000 } as never,
  });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const hold = holder
    .begin(async (tx) => {
      await tx`LOCK TABLE challenges IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
    })
    .catch(() => {});
  try {
    await isLocked;
    const t0 = Date.now();
    let err: unknown;
    try {
      await runMigrations(runner, { migrationsDir: dir, logger: { log() {}, warn() {}, error() {} } });
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(PROBE);
    expect((err as Error).message).toContain('lock timeout');
    expect(ms).toBeLessThan(15_000);
    // Rolled back whole: the probe file is not recorded as applied.
    const rows = await runner`SELECT 1 FROM _migrations WHERE filename = ${PROBE}`;
    expect(rows.length).toBe(0);
  } finally {
    release();
    await hold;
    // Only reachable if the run wrongly SUCCEEDED: never leave the probe recorded as applied.
    await runner`DELETE FROM _migrations WHERE filename = ${PROBE}`.catch(() => {});
    await holder.end({ timeout: 5 });
    await runner.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
