// tests/helpers/policy-snapshot.ts — capture-and-restore for the GLOBAL policy rows a suite mutates.
//
// ⛔ WHY THIS EXISTS, AND WHY IT IS A HELPER RATHER THAN FIVE COPIES OF FOUR LINES.
// `policies` has no `tenant_id` — migration 0028 lists it as explicitly outside RLS — so it is one
// global table, read live by `policy-store`/`policy-enforcement`, shared by every suite and every
// concurrent session on the same database.
//
// The bug this prevents is neither hypothetical nor small. `governance.test.ts` used to "restore"
// `models.allowlist` by writing a hardcoded THREE-element literal. The live row held TWENTY-TWO.
// Every run of that file silently truncated the broker's model gate by 19 entries — no diff, no
// audit row, no failing assertion — for everyone sharing the DB. Fixed in #312.
//
// The connector suites carried the same shape (`setAllowlist([], false)` in `afterAll`) and were
// harmless only because the baseline happened to coincide with the literal. Proven, not assumed: a
// sentinel written to `data.egress_allowlist` before a run came back as `[]` afterwards.
//
// A snapshot cannot go stale. A literal always does — it freezes the value at the moment someone
// typed it and destroys every later change. So: capture in `beforeAll`, put back what you found.
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { policies } from '../../src/db/schema';
import { invalidatePolicyCache } from '../../src/host/policy-store';

/** Capture the current `value` of each key. A key with no row is simply absent from the snapshot,
 *  so `restorePolicies` will not resurrect a row the suite never found. */
export async function snapshotPolicies(keys: readonly string[]): Promise<Map<string, unknown>> {
  const snap = new Map<string, unknown>();
  for (const key of keys) {
    const [row] = await db.select({ value: policies.value }).from(policies).where(eq(policies.key, key));
    if (row) snap.set(key, row.value);
  }
  return snap;
}

/** Put back exactly what `snapshotPolicies` found, then drop the in-process policy cache. */
export async function restorePolicies(snap: Map<string, unknown>): Promise<void> {
  for (const [key, value] of snap) {
    await db.update(policies).set({ value: value as never }).where(eq(policies.key, key));
  }
  invalidatePolicyCache();
}

/** The two rows every connector suite flips. */
export const CONNECTOR_POLICY_KEYS = ['models.external_http', 'data.egress_allowlist'] as const;
