// tests/migration-0095-tenant-licence-state.test.ts — A2 Test 9.
//
// 0095 runs at backend STARTUP on every replica, so it must be re-runnable, and its backfill must
// leave every existing tenant on a plan (`standard`, the LICENSE_PLAN_CODE of every deployment) and
// every centrally-linked tenant with its registry name (= its slug). Proven against the real schema
// inside a transaction that is ROLLED BACK, so nothing here outlives the test.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryClient } from '../src/db/client';

const SQL = readFileSync(join(import.meta.dir, '..', 'migrations', '0095_tenant_licence_state.sql'), 'utf8');

const T_LINKED = '00000000-0000-4000-8000-0000a2c30001';
const T_UNLINKED = '00000000-0000-4000-8000-0000a2c30002';
const T_ON_PLAN = '00000000-0000-4000-8000-0000a2c30003';

class Rollback extends Error {}

test('A2 Test 9: 0095 applies twice cleanly and backfills plan_code + licences_name', async () => {
  expect(SQL).toContain('ADD COLUMN IF NOT EXISTS plan_code');
  let seen: { id: string; plan_code: string | null; licences_name: string | null }[] = [];
  try {
    await queryClient.begin(async (tx) => {
      // Rows as a pre-0095 deploy leaves them: no plan, no registry name.
      await tx.unsafe(`
        INSERT INTO tenants (id, name, slug, central_link) VALUES
          ('${T_LINKED}', 'A2C3 Linked', 'a2c3-linked', 'registered'),
          ('${T_UNLINKED}', 'A2C3 Unlinked', 'a2c3-unlinked', NULL);
        INSERT INTO tenants (id, name, slug, plan_code) VALUES ('${T_ON_PLAN}', 'A2C3 Plan', 'a2c3-plan', 'local-llm');
        UPDATE tenants SET plan_code = NULL, licences_name = NULL WHERE id IN ('${T_LINKED}', '${T_UNLINKED}');
      `);
      await tx.unsafe(SQL); // first run (columns already exist here: startup applied it)
      await tx.unsafe(SQL); // ⛔ and again — a second replica booting
      seen = (await tx.unsafe(
        `SELECT id::text, plan_code, licences_name FROM tenants
          WHERE id IN ('${T_LINKED}', '${T_UNLINKED}', '${T_ON_PLAN}') ORDER BY id`,
      )) as unknown as typeof seen;
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  expect(seen).toEqual([
    { id: T_LINKED, plan_code: 'standard', licences_name: 'a2c3-linked' },
    { id: T_UNLINKED, plan_code: 'standard', licences_name: null },
    // an explicit plan is never overwritten by the backfill
    { id: T_ON_PLAN, plan_code: 'local-llm', licences_name: null },
  ]);
});

test('0095 refuses an expiry that is not after the start', async () => {
  let err: unknown;
  try {
    await queryClient.begin(async (tx) => {
      await tx.unsafe(`
        INSERT INTO tenants (id, name, slug, licence_starts_at, licence_expires_at)
        VALUES ('${T_LINKED}', 'A2C3 Window', 'a2c3-window', '2030-01-01Z', '2029-01-01Z')`);
      throw new Rollback();
    });
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeInstanceOf(Rollback);
  expect(String((err as Error).message)).toContain('tenants_licence_window_ck');
});
