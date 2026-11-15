// Pins the natural key of `usage_counters` through the 0058 → 0059 expand/contract.
//
// Background: the pre-tenancy `UNIQUE (user_id, day)` from 0004 disagreed with the tenant_id
// column added in 0028, and that disagreement silently disabled the daily LLM call cap and the
// weekly spend ceiling for any user metering under more than one tenant on the same UTC day
// (the super_admin `X-Active-Tenant-Id` scope-switch is the common trigger).
//
// ⛔ THIS FILE MUST ASSERT STRUCTURE, NOT TEXT. A previous version matched substrings against
// `pg_indexes.indexdef` (/UNIQUE/ && /tenant_id/ && /user_id/ && /day/) and was vacuous in
// exactly the way it claimed to guard: `CREATE UNIQUE INDEX … (user_id, day) INCLUDE (tenant_id)`
// — the BROKEN narrow key — satisfied every predicate, as did a partial
// `UNIQUE (tenant_id, user_id, day) WHERE …`, which cannot serve as an `ON CONFLICT` arbiter at
// all. So we read `pg_index` directly and check: unique, non-partial, and KEY columns (not
// INCLUDE payload) exactly {tenant_id, user_id, day}.
import { describe, expect, test } from 'bun:test';
import { db } from '../src/db/client';

export type IndexRow = {
  indexname: string;
  is_unique: boolean;
  is_partial: boolean;
  nkeyatts: number;
  /** KEY columns only, in index order, comma-joined. INCLUDE columns are excluded. */
  key_cols: string | null;
};

/**
 * Structural index inventory for a table.
 *
 * `indkey[0:indnkeyatts-1]` slices off INCLUDE columns (indkey is 0-subscripted), so `key_cols`
 * is the true arbiter column list. `indpred IS NOT NULL` marks a partial index, which Postgres
 * will not accept as an `ON CONFLICT` arbiter.
 */
export const INDEX_SQL = (table: string): string => `
  SELECT i.relname                                   AS indexname,
         ix.indisunique                              AS is_unique,
         (ix.indpred IS NOT NULL)                    AS is_partial,
         ix.indnkeyatts                              AS nkeyatts,
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM unnest(ix.indkey[0:ix.indnkeyatts-1]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS key_cols
    FROM pg_index ix
    JOIN pg_class i     ON i.oid = ix.indexrelid
    JOIN pg_class t     ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname = '${table}' AND n.nspname = 'public'`;

/** Column set of an index's KEY columns, order-insensitive. */
function keySet(r: IndexRow): string {
  return (r.key_cols ?? '').split(',').filter(Boolean).sort().join(',');
}

/**
 * A usable `ON CONFLICT` arbiter over exactly the given columns: UNIQUE, NOT partial, and with
 * those columns as KEY columns — an INCLUDE payload does not count toward the key.
 */
export function arbitersOver(rows: IndexRow[], cols: string[]): IndexRow[] {
  const want = [...cols].sort().join(',');
  return rows.filter(
    (r) =>
      String(r.is_unique) === 'true' &&
      String(r.is_partial) === 'false' &&
      Number(r.nkeyatts) === cols.length &&
      keySet(r) === want,
  );
}

export const TENANT_ALIGNED = ['tenant_id', 'user_id', 'day'];
export const NARROW = ['user_id', 'day'];

export function describeRows(rows: IndexRow[]): string {
  return rows
    .map(
      (r) =>
        `  ${r.indexname}: unique=${r.is_unique} partial=${r.is_partial} ` +
        `nkeyatts=${r.nkeyatts} key_cols=(${r.key_cols ?? ''})`,
    )
    .join('\n');
}

export async function usageCounterIndexes(): Promise<IndexRow[]> {
  return (await db.execute(
    // eslint-disable-next-line no-restricted-syntax
    INDEX_SQL('usage_counters') as never,
  )) as unknown as IndexRow[];
}

describe('usage_counters natural key', () => {
  test('a tenant-aligned unique key usable as an ON CONFLICT arbiter exists (0058)', async () => {
    const rows = await usageCounterIndexes();
    // Guard against a vacuous sweep: an empty inventory is a broken premise, not a pass.
    expect(rows.length).toBeGreaterThan(0);

    const wide = arbitersOver(rows, TENANT_ALIGNED);
    expect(
      wide.length,
      'expected a NON-PARTIAL UNIQUE index whose KEY columns are exactly ' +
        `(${TENANT_ALIGNED.join(', ')}). Indexes present:\n${describeRows(rows)}`,
    ).toBeGreaterThan(0);
  });

  test('the pre-tenancy (user_id, day) key never exists without the tenant-aligned one', async () => {
    const rows = await usageCounterIndexes();
    expect(rows.length).toBeGreaterThan(0);

    const narrow = arbitersOver(rows, NARROW);
    if (narrow.length === 0) return; // 0059 has landed — nothing to reconcile.

    // 0058 (expand) deliberately leaves the narrow key in place so old replicas keep working
    // mid-rollout; 0059 (contract) drops it. Both states are legal. What is NOT legal is the
    // narrow key existing WITHOUT a usable tenant-aligned one — the broken pre-0058 shape, and
    // equally the `(user_id, day) INCLUDE (tenant_id)` near-miss that reads fine in a text diff.
    const wide = arbitersOver(rows, TENANT_ALIGNED);
    expect(
      wide.length,
      'usage_counters has the narrow (user_id, day) unique key but NO usable tenant-aligned ' +
        'key — the daily LLM cap and the weekly spend ceiling are bypassable. See migration ' +
        `0058. Indexes present:\n${describeRows(rows)}`,
    ).toBeGreaterThan(0);
  });

  // ---- 0061 ----
  //
  // 0061 splits the PLATFORM's LLM load off the HUMAN's governance quota by ADDING a column. Two
  // things need pinning, and the second is the one that is easy to forget.
  test('platform_llm_calls has exactly the shape 0061 declares (0061)', async () => {
    // ⛔ WHY SHAPE, NOT MERE EXISTENCE. The migration uses `ADD COLUMN IF NOT EXISTS`, which is a
    // SILENT no-op against a column of any other shape. A NULLABLE `platform_llm_calls` in
    // particular would let the broker's reserving `platform_llm_calls + 1` write NULL, and the
    // platform load meter would read as absent forever with no error anywhere — /it-dash would
    // simply stop counting background traffic. 0061 carries a DO $$ guard for exactly this; this
    // is that guard re-asserted from the outside, where a hand-patched environment can be caught.
    const rows = (await db.execute(
      // eslint-disable-next-line no-restricted-syntax
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'usage_counters'
          AND column_name  = 'platform_llm_calls'` as never,
    )) as unknown as { data_type: string; is_nullable: string; column_default: string | null }[];

    expect(rows, 'usage_counters.platform_llm_calls is missing — migration 0061 has not run').toHaveLength(1);
    const col = rows[0]!;
    expect(col.data_type).toBe('integer');
    expect(col.is_nullable, 'a nullable load meter reads as absent forever, silently').toBe('NO');
    expect(col.column_default, 'DEFAULT 0 is what makes every pre-existing row correct').toBe('0');
  });

  test('0061 did not disturb the 0059 one-way door — the wide key is still the ONLY arbiter', async () => {
    // ⛔ THIS IS THE POINT OF THE TEST. 0059 is IRREVERSIBLE: once any user has metered under two
    // tenants on one UTC day the pre-tenancy `(user_id, day)` key can never be re-created without
    // destroying real metering data, and the broker's INSERT is an UNTARGETED
    // `ON CONFLICT DO NOTHING` that arbitrates over whatever unique constraints happen to exist.
    // So a SECOND unique index appearing on this table is not a harmless addition — it changes
    // which key that INSERT de-duplicates on, and the failure is silent (the day's counter simply
    // stops accumulating and the cap is disabled a new way). 0061 only ADDs a column, and this
    // pins that it stayed that way.
    const rows = await usageCounterIndexes();
    expect(rows.length).toBeGreaterThan(0);

    const uniques = rows.filter((r) => String(r.is_unique) === 'true');
    expect(
      uniques.map((r) => r.indexname).sort(),
      `exactly ONE unique index must exist on usage_counters, and it must be the tenant-aligned ` +
        `0059 arbiter. Indexes present:\n${describeRows(rows)}`,
    ).toEqual(['usage_counters_tenant_user_day_uq']);
    expect(arbitersOver(rows, TENANT_ALIGNED)).toHaveLength(1);
    expect(arbitersOver(rows, NARROW), 'the 0059 door must stay shut').toHaveLength(0);
  });
});
