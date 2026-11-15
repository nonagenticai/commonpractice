// tests/migration-0114-cycle-tenant-not-null.test.ts — 0114 on a POPULATED database shaped like prod.
//
// A scratch database is migrated to 0113 (main's schema today) and filled the way prod is on
// 2026-10-15: NULL-tenant platform cycle rows (pre-0110, kept one release) next to per-tenant copies,
// plus a weekly_winners row so we can see nothing outside marketplace_cycles is touched. Only THEN is
// 0114 applied through the real runner. Measured: the NULL-tenant rows are gone and every tenant row
// is untouched; tenant_id is NOT NULL (a tenant-less insert is refused); the cp_app read policy has no
// NULL branch; the unique indexes lost NULLS NOT DISTINCT but still enforce one row per period per
// tenant; and a second run of the file changes nothing (it runs at every replica's startup).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { applyMigrations, migrationOrdinal } from '../src/db/migration-runner';
import { periodFromKey } from '../src/host/period';
import { config } from '../src/config';

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');
const FILE_0114 = join(MIGRATIONS, '0114_cycle_tenant_not_null.sql');
const SCRATCH_DB = 'cp_m0114_cycle_tenant_scratch';
function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');
let scratch: postgres.Sql;
let dir = '';

const id = (tail: string) => `00000000-0000-4000-8000-${tail}`;
const T1 = id('000001141001');
const T2 = id('000001141002');
const USER = id('000001141101');
const KEYS = ['2026-W40', '2026-W41', '2026-W42'];
const quiet = { log: () => {}, warn: () => {}, error: console.error };

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function insertCycle(tenant: string | null, key: string): Promise<void> {
  const p = periodFromKey(key);
  const closed = key !== KEYS[KEYS.length - 1];
  await scratch.unsafe(
    `INSERT INTO marketplace_cycles (tenant_id, week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at, closed_at)
     VALUES ($1, $2, 'week', $2, $3, $4, $5, $6, $6, $7)`,
    [tenant, key, p.start, closed ? 'closed' : 'voting', new Date(p.start.getTime() + 4 * 86_400_000), p.end, closed ? p.end : null],
  );
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  dir = mkdtempSync(join(tmpdir(), 'cp-m0114-'));
  const upTo0113 = readdirSync(MIGRATIONS).filter((f) => {
    const n = migrationOrdinal(f);
    return n !== null && n <= 113;
  });
  expect(upTo0113.length).toBeGreaterThan(100);
  for (const f of upTo0113) symlinkSync(join(MIGRATIONS, f), join(dir, f));
  await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: quiet });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });

  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug) VALUES ('${T1}', 'm0114 one', 'm0114-one'), ('${T2}', 'm0114 two', 'm0114-two')`,
  );
  await scratch.unsafe(`INSERT INTO users (id, email, name) VALUES ('${USER}', 'm0114@test', 'M0114')`);
  for (const key of KEYS) {
    await insertCycle(null, key); // the pre-0110 platform row
    await insertCycle(T1, key);
    await insertCycle(T2, key);
  }
  // A winner, so the test can see the DELETE reaches nothing outside marketplace_cycles.
  const [ch] = await scratch.unsafe(
    `INSERT INTO challenges (title, work_area, submitter_id, tenant_id, week) VALUES ('m0114', 'IT', $1, $2, $3) RETURNING id`,
    [USER, T1, KEYS[0]!],
  );
  const [sol] = await scratch.unsafe(
    `INSERT INTO solutions (challenge_id, title, author_id, tenant_id, status, week) VALUES ($1, 'm0114', $2, $3, 'voting', $4) RETURNING id`,
    [ch!.id, USER, T1, KEYS[0]!],
  );
  await scratch.unsafe(
    `INSERT INTO weekly_winners (tenant_id, week, solution_id) VALUES ($1, $2, $3)`,
    [T1, KEYS[0]!, sol!.id],
  );
}, 240_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  if (dir) rmSync(dir, { recursive: true, force: true });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

const tenantRows = async () =>
  JSON.stringify(
    await scratch.unsafe(
      `SELECT id::text, tenant_id::text, period_key, phase, closes_at, closed_at FROM marketplace_cycles WHERE tenant_id IS NOT NULL ORDER BY id`,
    ),
  );

test('0114 on a populated 0113 database: NULL-tenant rows gone, tenant rows untouched, tenant_id NOT NULL', async () => {
  const [pre] = await scratch.unsafe(
    `SELECT count(*) FILTER (WHERE tenant_id IS NULL)::int AS legacy, count(*) FILTER (WHERE tenant_id IS NOT NULL)::int AS tenant FROM marketplace_cycles`,
  );
  // Non-vacuity: the 0110 shape really is in place before 0114 runs.
  expect({ legacy: pre!.legacy, tenant: pre!.tenant }).toEqual({ legacy: KEYS.length, tenant: 2 * KEYS.length });
  const [{ nullable: nullableBefore }] = await scratch.unsafe(
    `SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_name = 'marketplace_cycles' AND column_name = 'tenant_id'`,
  ) as unknown as [{ nullable: string }];
  expect(nullableBefore).toBe('YES');
  const tenantBefore = await tenantRows();
  const [{ n: winnersBefore }] = await scratch.unsafe(`SELECT count(*)::int AS n FROM weekly_winners`) as unknown as [{ n: number }];

  symlinkSync(FILE_0114, join(dir, '0114_cycle_tenant_not_null.sql'));
  await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: quiet });

  const [post] = await scratch.unsafe(
    `SELECT count(*) FILTER (WHERE tenant_id IS NULL)::int AS legacy, count(*) FILTER (WHERE tenant_id IS NOT NULL)::int AS tenant FROM marketplace_cycles`,
  );
  expect({ legacy: post!.legacy, tenant: post!.tenant }).toEqual({ legacy: 0, tenant: 2 * KEYS.length });
  expect(await tenantRows()).toBe(tenantBefore);
  const [{ n: winnersAfter }] = await scratch.unsafe(`SELECT count(*)::int AS n FROM weekly_winners`) as unknown as [{ n: number }];
  expect(winnersAfter).toBe(winnersBefore);
  expect(winnersAfter).toBe(1);

  const [{ nullable }] = await scratch.unsafe(
    `SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_name = 'marketplace_cycles' AND column_name = 'tenant_id'`,
  ) as unknown as [{ nullable: string }];
  expect(nullable).toBe('NO');
});

test('0114: a tenant-less cycle row is refused (not-null), even by the owner', async () => {
  const p = periodFromKey('2026-W43');
  const res = await scratch
    .unsafe(
      `INSERT INTO marketplace_cycles (week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at)
       VALUES ($1, 'week', $1, $2, 'voting', $3, $3, $3)`,
      [p.key, p.start, p.end],
    )
    .then(
      () => 'inserted',
      (e: unknown) => `${(e as { code?: string }).code}:${String(e)}`,
    );
  expect(res).toMatch(/^23502:.*tenant_id/);
});

test('0114: the read policy has no NULL branch; the unique indexes are plain and still unique per tenant', async () => {
  const pols = await scratch.unsafe(`SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'marketplace_cycles'`);
  expect(pols.map((p) => `${p.policyname}:${p.cmd}`)).toEqual(['marketplace_cycles_read:SELECT']);
  expect(String(pols[0]!.qual)).not.toMatch(/IS NULL/i);
  expect(String(pols[0]!.qual)).toMatch(/tenant_id = app_current_tenant_uuid\(\)/);

  const idx = await scratch.unsafe(`
    SELECT c.relname, i.indisunique, i.indnullsnotdistinct FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('marketplace_cycles_tenant_period_key_uq', 'marketplace_cycles_tenant_period_start_uq') ORDER BY c.relname`);
  expect(idx.map((r) => `${r.relname}:${r.indisunique}:${r.indnullsnotdistinct}`)).toEqual([
    'marketplace_cycles_tenant_period_key_uq:true:false',
    'marketplace_cycles_tenant_period_start_uq:true:false',
  ]);

  // Same tenant + same period = conflict; another tenant's row for the period is not.
  const dup = await scratch
    .unsafe(
      `INSERT INTO marketplace_cycles (tenant_id, week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at)
       SELECT tenant_id, week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at
         FROM marketplace_cycles WHERE tenant_id = '${T1}' AND period_key = '${KEYS[0]}'`,
    )
    .then(
      () => 'inserted',
      (e: unknown) => String(e),
    );
  expect(dup).toMatch(/duplicate key/);
});

test('0114 is idempotent: a second run of the file changes nothing', async () => {
  const snap = async () =>
    JSON.stringify(await scratch.unsafe(`SELECT id::text, xmin::text FROM marketplace_cycles ORDER BY id`));
  const idxOids = async () =>
    JSON.stringify(await scratch.unsafe(
      `SELECT relname, oid::text FROM pg_class WHERE relname LIKE 'marketplace_cycles_tenant_period_%_uq' ORDER BY relname`,
    ));
  const first = await snap();
  const firstIdx = await idxOids();
  await scratch.begin(async (tx) => {
    await tx.unsafe(readFileSync(FILE_0114, 'utf8'));
  });
  expect(await snap()).toBe(first);
  // The rebuild is guarded on indnullsnotdistinct, so a second run does not drop/recreate the indexes.
  expect(await idxOids()).toBe(firstIdx);
});
