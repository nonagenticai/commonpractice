// tests/migration-0110-tenant-cycles.test.ts — 0110 on a POPULATED database shaped like prod.
//
// A scratch database is migrated to 0109 (the schema main runs today), filled with rows resembling
// prod on 2026-10-14 — platform (tenant-less) cycle rows, closed and open; three tenants with
// challenges/solutions across closed, open, row-less past and row-less future periods; one tenant with
// nothing stamped; one offboarded tenant — and only THEN is 0110 executed. The proof that matters:
// every solution's vote gate (open/closed) is IDENTICAL before (the 0109 platform predicate over the
// tenant-less rows) and after (the 0110 per-tenant predicate over the copied rows).
//
// Also measured: which tenants get which copies, the NULL-tenant rows survive, strict RLS on the new
// tables, and a second run changes nothing (idempotent — it runs at every replica's startup).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/db/schema';
import { solutions } from '../src/db/schema';
import { applyMigrations, migrationOrdinal } from '../src/db/migration-runner';
import { periodClosedSql, SOLUTION_PERIOD } from '../src/host/cycle-eligibility';
import { periodFromKey } from '../src/host/period';
import { config } from '../src/config';

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');
const FILE_0110 = join(MIGRATIONS, '0110_tenant_cycle_cadence.sql');
const SCRATCH_DB = 'cp_m0110_tenant_cycles_scratch';
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
const T1 = id('000001101001');
const T2 = id('000001101002');
const T3 = id('000001101003'); // a live tenant with nothing stamped
const T4 = id('000001101004'); // offboarded, nothing stamped
const T5 = id('000001101005'); // stamped only into a row-less legacy week
const USER = id('000001101101');

/** The "current" period of the fixture: the one open platform row (prod: W42). */
const CURRENT = '2026-W42';
// W40/W41 have NO row (an outage): the stranded floor is W39's close, so a W41 entry is OPEN — which
// only stays true after 0110 if the tenant got the closed HISTORY, not just the open row.
const CLOSED = ['2026-W37', '2026-W38', '2026-W39'];

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  // Exactly main's schema: every migration up to 0109, nothing after.
  dir = mkdtempSync(join(tmpdir(), 'cp-m0110-'));
  const upTo0109 = readdirSync(MIGRATIONS).filter((f) => {
    const n = migrationOrdinal(f);
    return n !== null && n <= 109;
  });
  expect(upTo0109.length).toBeGreaterThan(100);
  for (const f of upTo0109) symlinkSync(join(MIGRATIONS, f), join(dir, f));
  await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: { log: () => {}, warn: () => {}, error: console.error } });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });

  // ---- prod-shaped rows -------------------------------------------------------------------------
  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug, offboarded_at) VALUES
      ('${T1}', 'm0110 one', 'm0110-one', NULL), ('${T2}', 'm0110 two', 'm0110-two', NULL),
      ('${T3}', 'm0110 three', 'm0110-three', NULL), ('${T4}', 'm0110 gone', 'm0110-gone', now()),
      ('${T5}', 'm0110 legacy', 'm0110-legacy', NULL)`,
  );
  await scratch.unsafe(`INSERT INTO users (id, email, name) VALUES ('${USER}', 'm0110@test', 'M0110')`);
  // Platform rows exactly as the 0109 engine wrote them: no tenant. Three closed weeks, a two-week gap, one open.
  for (const key of [...CLOSED, CURRENT]) {
    const p = periodFromKey(key);
    const votingEnds = new Date(p.start.getTime() + 4 * 86_400_000);
    const closed = key !== CURRENT;
    await scratch.unsafe(
      `INSERT INTO marketplace_cycles (week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at, closed_at)
       VALUES ($1, 'week', $1, $2, $3, $4, $5, $5, $6)`,
      [key, p.start, closed ? 'closed' : 'voting', votingEnds, p.end, closed ? p.end : null],
    );
  }
  // Each stamped tenant: a challenge, and solutions in a closed week, the open week, a row-less legacy
  // week (W21: dead), a row-less future week (W43: open), an OFF row and a never-filed legacy row.
  for (const [t, weeks] of [
    [T1, ['2026-W39', CURRENT, '2026-W21', '2026-W43']],
    [T2, ['2026-W41', CURRENT, '2026-W23', '2026-W38']],
    [T5, ['2026-W21']],
  ] as const) {
    const [ch] = await scratch.unsafe(
      `INSERT INTO challenges (title, work_area, submitter_id, tenant_id, week) VALUES ('m0110', 'IT', $1, $2, $3) RETURNING id`,
      [USER, t, weeks[0]],
    );
    for (const w of weeks) {
      await scratch.unsafe(
        `INSERT INTO solutions (challenge_id, title, author_id, tenant_id, status, week) VALUES ($1, 'm0110', $2, $3, 'voting', $4)`,
        [ch!.id, USER, t, w],
      );
    }
    await scratch.unsafe(
      `INSERT INTO solutions (challenge_id, title, author_id, tenant_id, status, week, period_kind) VALUES ($1, 'm0110 off', $2, $3, 'voting', '', 'off')`,
      [ch!.id, USER, t],
    );
    await scratch.unsafe(
      `INSERT INTO solutions (challenge_id, title, author_id, tenant_id, status, week) VALUES ($1, 'm0110 legacy', $2, $3, 'voting', '')`,
      [ch!.id, USER, t],
    );
  }
}, 240_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  if (dir) rmSync(dir, { recursive: true, force: true });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

/** The 0109 vote gate, verbatim in SQL: the PLATFORM predicate over tenant-less rows. */
const OLD_GATE = (cur: Date) => `
  coalesce(s.period_kind, '') <> 'off' and (
    exists (select 1 from marketplace_cycles mc where mc.period_kind = s.period_kind and mc.period_start = s.period_start and mc.phase = 'closed')
    or (
      (s.period_start is null or (s.period_start < '${cur.toISOString()}'::timestamptz and
        (((s.period_start) at time zone 'UTC') + (case s.period_kind when 'week' then interval '7 days' when 'month' then interval '1 month' when 'quarter' then interval '3 months' else interval '1 year' end)) at time zone 'UTC'
        <= greatest(coalesce(
             (select max(mc_fl.closes_at) from marketplace_cycles mc_fl where mc_fl.phase = 'closed' and mc_fl.period_start <= '${cur.toISOString()}'::timestamptz),
             (select min(mc_f0.period_start) from marketplace_cycles mc_f0 where mc_f0.period_start <= '${cur.toISOString()}'::timestamptz),
             'infinity'::timestamptz), '${cur.toISOString()}'::timestamptz - '366 days'::interval)))
      and not exists (select 1 from marketplace_cycles mc_any where mc_any.period_kind = s.period_kind and mc_any.period_start = s.period_start)
    )
  )`;

async function classifyOld(): Promise<Map<string, boolean>> {
  const rows = await scratch.unsafe(`SELECT s.id::text AS id, (${OLD_GATE(periodFromKey(CURRENT).start)}) AS closed FROM solutions s`);
  return new Map(rows.map((r) => [r.id as string, r.closed as boolean]));
}

async function classifyNew(): Promise<Map<string, boolean>> {
  const d = drizzle(scratch, { schema });
  const gate = { mode: 'on' as const, kind: 'week' as const, start: periodFromKey(CURRENT).start };
  const rows = await d.select({ id: solutions.id, closed: periodClosedSql(SOLUTION_PERIOD, gate) }).from(solutions);
  return new Map(rows.map((r) => [r.id, r.closed]));
}

const cyclesOf = async (t: string | null) =>
  (await scratch.unsafe(
    t
      ? `SELECT period_key, phase FROM marketplace_cycles WHERE tenant_id = $1 ORDER BY period_start`
      : `SELECT period_key, phase FROM marketplace_cycles WHERE tenant_id IS NULL ORDER BY period_start`,
    t ? [t] : [],
  )).map((r) => `${r.period_key}:${r.phase}`);

test('0110 on a populated 0109 database: every solution’s vote gate is unchanged, per tenant', async () => {
  const before = await classifyOld();
  // Non-vacuity: the fixture really has BOTH outcomes (closed weeks, the dead legacy week; the open
  // and future weeks, OFF rows).
  expect([...before.values()].filter(Boolean).length).toBeGreaterThanOrEqual(4);
  expect([...before.values()].filter((v) => !v).length).toBeGreaterThanOrEqual(6);

  await scratch.unsafe(readFileSync(FILE_0110, 'utf8'));

  const after = await classifyNew();
  expect(after.size).toBe(before.size);
  for (const [sid, closed] of before) expect({ sid, closed: after.get(sid) }).toEqual({ sid, closed });

  // Stamped tenants: the full history. Live unstamped tenant: the open row only. Offboarded: nothing.
  const all = [...CLOSED.map((k) => `${k}:closed`), `${CURRENT}:voting`];
  expect(await cyclesOf(T1)).toEqual(all);
  expect(await cyclesOf(T2)).toEqual(all);
  expect(await cyclesOf(T5)).toEqual(all);
  expect(await cyclesOf(T3)).toEqual([`${CURRENT}:voting`]);
  expect(await cyclesOf(T4)).toEqual([]);
  // The platform rows survive for the old pods of the rollout.
  expect(await cyclesOf(null)).toEqual(all);
  // Copied boundaries are byte-identical to the platform row's.
  const [same] = await scratch.unsafe(`
    SELECT count(*)::int AS n FROM marketplace_cycles t JOIN marketplace_cycles p
      ON p.tenant_id IS NULL AND p.period_kind = t.period_kind AND p.period_key = t.period_key
     WHERE t.tenant_id = '${T1}' AND (p.voting_ends_at, p.solution_ends_at, p.closes_at, p.closed_at, p.phase, p.period_start)
           IS NOT DISTINCT FROM (t.voting_ends_at, t.solution_ends_at, t.closes_at, t.closed_at, t.phase, t.period_start)`);
  expect(same!.n).toBe(CLOSED.length + 1);
});

test('0110 is idempotent: a second run adds no row and changes none', async () => {
  const snap = async () =>
    JSON.stringify(await scratch.unsafe(`SELECT id::text, xmin::text FROM marketplace_cycles ORDER BY id`));
  const first = await snap();
  await scratch.unsafe(readFileSync(FILE_0110, 'utf8'));
  expect(await snap()).toBe(first);
});

test('0110: per-tenant uniqueness (NULLS NOT DISTINCT) and strict RLS on the cadence tables', async () => {
  // A second NULL-tenant row for an existing period is still a conflict (old pods' claim no-ops).
  // (A postgres.js query is a lazy thenable — settle it explicitly; `expect().rejects` never runs it.)
  const dup = await scratch
    .unsafe(
      `INSERT INTO marketplace_cycles (week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at)
       SELECT week, period_kind, period_key, period_start, phase, voting_ends_at, solution_ends_at, closes_at FROM marketplace_cycles
        WHERE tenant_id IS NULL AND period_key = '${CURRENT}'`,
    )
    .then(
      () => 'inserted',
      (e: unknown) => String(e),
    );
  expect(dup).toMatch(/duplicate key/);
  const rls = await scratch.unsafe(`
    SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('tenant_cycle_cadence', 'tenant_cycle_cadence_changes') ORDER BY relname`);
  expect(rls.map((r) => `${r.relname}:${r.relrowsecurity}`)).toEqual(['tenant_cycle_cadence:true', 'tenant_cycle_cadence_changes:true']);
  // marketplace_cycles: RLS on, ONE per-command SELECT policy (own tenant + NULL legacy), no write policy.
  const [mc] = await scratch.unsafe(`SELECT relrowsecurity FROM pg_class WHERE relname = 'marketplace_cycles'`);
  expect(mc!.relrowsecurity).toBe(true);
  const mcPols = await scratch.unsafe(`SELECT cmd, qual FROM pg_policies WHERE tablename = 'marketplace_cycles'`);
  expect(mcPols.map((p) => p.cmd)).toEqual(['SELECT']);
  expect(String(mcPols[0]!.qual)).toMatch(/tenant_id IS NULL/);
  const pols = await scratch.unsafe(`
    SELECT tablename, cmd FROM pg_policies WHERE tablename LIKE 'tenant_cycle_cadence%' ORDER BY tablename, cmd`);
  // The history is append-only: SELECT and INSERT policies, none for UPDATE/DELETE.
  expect(pols.map((p) => `${p.tablename}:${p.cmd}`)).toEqual([
    'tenant_cycle_cadence:ALL',
    'tenant_cycle_cadence_changes:INSERT',
    'tenant_cycle_cadence_changes:SELECT',
  ]);
});
