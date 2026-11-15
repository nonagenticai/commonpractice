// tests/migration-0118-drop-purge-snapshots.test.ts — 0118 drops exactly the 19 approved `_purge_*`
// snapshot tables, by explicit name, and nothing else.
//
// The tables only ever existed on prod (created by hand / by scripts/purge-fabricated-history.ts,
// never by a migration), so on a CI database 0118 is a silent no-op and proves nothing on its own.
// This file plants all 19 plus a decoy `_purge_` table inside ONE transaction on the test database,
// runs the shipped SQL, asserts, and rolls back — nothing is left behind.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryClient } from '../src/db/client';

const MIGRATION = readFileSync(
  join(import.meta.dir, '..', 'migrations', '0118_drop_purge_snapshots.sql'),
  'utf8',
);

// The owner-approved list (2026-10-16), inventoried on prod the same day. Named here independently
// of the migration so that adding a table to 0118 is a deliberate edit in two places.
const APPROVED = [
  '_purge_20260807_flow_run_events',
  '_purge_20260807_flow_runs',
  '_purge_20260807_usage_counters',
  '_purge_20260807_usage_events',
  '_purge_20260809_audit_log',
  '_purge_20260809_pipeline_items',
  '_purge_20260809_policy_changes',
  '_purge_20260809_usage_events',
  '_purge_20260809b_challenges',
  '_purge_20260809b_comments',
  '_purge_20260809b_flow_runs',
  '_purge_20260809b_flows',
  '_purge_20260809b_llm_settings',
  '_purge_20260809b_sandboxes',
  '_purge_20260809b_solutions',
  '_purge_20260809b_tenants',
  '_purge_20260809b_usage_events',
  '_purge_20260809b_users',
  '_purge_20260809b_weekly_winners',
] as const;

const DECOY = '_purge_20991231_not_approved';

class Rollback extends Error {}

test('0118 names exactly the 19 approved tables, and only as explicit DROP TABLE IF EXISTS', () => {
  const statements = MIGRATION.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('--'));
  const dropped = statements.map((s) => /^DROP TABLE IF EXISTS public\.([a-z0-9_]+);$/.exec(s)?.[1] ?? `NOT A DROP: ${s}`);
  expect(dropped.sort()).toEqual([...APPROVED].sort());
  // No dynamic pattern that could reach a table nobody approved.
  expect(statements.join('\n')).not.toMatch(/\bEXECUTE\b|\bDO\s+\$|\bLIKE\b/i);
});

test('0118 drops every approved snapshot and leaves an unlisted _purge_ table alone', async () => {
  let remaining: string[] = [];
  let decoyAlive = false;
  await expect(
    queryClient.begin(async (tx) => {
      for (const t of [...APPROVED, DECOY]) {
        await tx.unsafe(`CREATE TABLE public.${t} (id int, email text)`);
      }
      await tx.unsafe(`INSERT INTO public._purge_20260809b_users VALUES (1, 'a@example.com')`);
      await tx.unsafe(MIGRATION);
      const rows = await tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${[...APPROVED, DECOY]})`;
      remaining = rows.map((r) => r.relname).filter((n) => n !== DECOY);
      decoyAlive = rows.some((r) => r.relname === DECOY);
      // Idempotent: a second run (IF EXISTS) is a no-op, not an error.
      await tx.unsafe(MIGRATION);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
  expect(remaining).toEqual([]);
  expect(decoyAlive).toBe(true);

  // The rollback left nothing behind.
  const after = await queryClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY(${[...APPROVED, DECOY]})`;
  expect(after[0]!.n).toBe(0);
});
