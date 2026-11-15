// tests/helpers/cycle-period.ts — the period columns a `marketplace_cycles` fixture row needs (0107).
// The DB trigger would derive them from `week`, but the drizzle insert type requires them, which is
// the point: application code must always name the period explicitly.
import { periodFromKey } from '../../src/host/period';

export function cyclePeriodCols(key: string) {
  const p = periodFromKey(key);
  return { week: p.key, period_kind: p.kind, period_key: p.key, period_start: p.start };
}

/**
 * 0110: `marketplace_cycles.tenant_id` is a foreign key onto `tenants` (challenges / solutions are
 * not), so a synthetic test tenant needs a `tenants` row before the engine can open a cycle for it.
 * Idempotent; the slug is derived from the id so parallel files never collide.
 */
export async function ensureTenants(ids: string[]): Promise<void> {
  const { db, tenants } = await import('../../src/db/client');
  for (const id of ids) {
    await db
      .insert(tenants)
      .values({ id, name: `cycle test ${id.slice(-8)}`, slug: `cycle-test-${id}` })
      .onConflictDoNothing();
  }
}
