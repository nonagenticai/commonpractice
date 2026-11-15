// tests/pipeline-reviews-schema.test.ts — T9: the DATABASE-level guarantees of migration 0062.
//
// Everything else about the promotion gate is behaviour and is tested through the route. THIS file
// tests the one thing no route test can: that the guarantee lives in the SCHEMA rather than in
// application logic. `pipeline_reviews_item_reviewer_uq` is what makes "N distinct reviewers"
// true — not `addReview`'s `onConflictDoNothing`, which is merely how the application avoids
// tripping over it. Delete the constraint and:
//
//   * `onConflictDoNothing` has no arbiter to match, one admin clicking Approve twice inserts a
//     SECOND row, and the gate silently reverts to counting CLICKS — precisely the defect 0062
//     exists to remove;
//   * `CREATE TABLE IF NOT EXISTS` in 0062 is a no-op against the already-existing table, so the
//     migration reports success and changes nothing;
//   * and the whole route suite still passes, because those tests approve once per identity and
//     never exercise the duplicate path.
//
// So assert the constraint's existence and EXACT column set directly from the catalog. This
// duplicates the shape guard inside 0062 on purpose: that one runs at APPLY time on whatever
// database is being migrated, this one runs at TEST time against the database the suite is using.
// A hand-altered dev/CI database is caught by one; a bad migration edit is caught by both.
import { test, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client';

interface ConstraintRow {
  conname: string;
  contype: string;
  cols: string[];
}

/** Walk an error's `cause` chain for a Postgres field — drizzle wraps driver errors in its own
 *  `Failed query: …` Error, so the SQLSTATE/constraint name are never on the top-level object. */
function pgField(err: unknown, field: 'code' | 'constraint_name' | 'constraint'): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const v = (cur as Record<string, unknown>)[field];
    if (typeof v === 'string') return v;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
const pgErrorCode = (err: unknown) => pgField(err, 'code');
const pgConstraintName = (err: unknown) =>
  pgField(err, 'constraint_name') ?? pgField(err, 'constraint');

async function keyConstraints(): Promise<ConstraintRow[]> {
  const rows = await db.execute(sql`
    SELECT c.conname::text AS conname,
           c.contype::text AS contype,
           (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = 'public'
       AND t.relname  = 'pipeline_reviews'
       AND c.contype IN ('u', 'p')
  `);
  return rows as unknown as ConstraintRow[];
}

test('T9: pipeline_reviews carries a UNIQUE constraint over EXACTLY (pipeline_item_id, reviewer_id)', async () => {
  const constraints = await keyConstraints();
  // Sanity: the scrape must find the table at all, or this test passes vacuously if the migration
  // never ran against this database.
  expect(constraints.length).toBeGreaterThan(0);

  const unique = constraints.filter((c) => c.contype === 'u');
  const matching = unique.filter(
    (c) => JSON.stringify([...c.cols].sort()) === JSON.stringify(['pipeline_item_id', 'reviewer_id']),
  );

  expect(
    matching.length,
    `Expected exactly ONE UNIQUE constraint over (pipeline_item_id, reviewer_id) on ` +
      `pipeline_reviews; found ${matching.length}. Constraints present: ` +
      `${JSON.stringify(constraints)}. Without it the promotion gate counts CLICKS, not distinct ` +
      `reviewers — the exact defect migration 0062 exists to fix — and every route test still passes.`,
  ).toBe(1);

  // Named, so a future migration can find and reason about it.
  expect(matching[0]!.conname).toBe('pipeline_reviews_item_reviewer_uq');
});

test('T9: both key columns are NOT NULL (Postgres treats NULLs as DISTINCT inside UNIQUE)', async () => {
  const rows = (await db.execute(sql`
    SELECT column_name::text AS column_name, is_nullable::text AS is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'pipeline_reviews'
       AND column_name IN ('pipeline_item_id', 'reviewer_id')
  `)) as unknown as { column_name: string; is_nullable: string }[];

  expect(rows.length).toBe(2);
  for (const r of rows) {
    expect(
      r.is_nullable,
      `pipeline_reviews.${r.column_name} is NULLABLE. Postgres treats NULLs as DISTINCT inside a ` +
        `UNIQUE constraint, so nullable key columns let duplicate rows coexist and the ` +
        `distinct-reviewer guarantee silently evaporates for exactly the rows that name nobody.`,
    ).toBe('NO');
  }
});

test('T9: the UNIQUE constraint is enforced by the DATABASE, not by application logic', async () => {
  // The strongest form of the assertion: bypass every helper and try to write the duplicate
  // directly. It must be Postgres that refuses, so that no future route, script, backfill or
  // console session can produce a card with two reviews by one person.
  const [item] = (await db.execute(sql`
    INSERT INTO pipeline_items (title, stage) VALUES ('ZTEST-PRSCHEMA card', 'review') RETURNING id
  `)) as unknown as { id: string }[];
  const [user] = (await db.execute(sql`
    INSERT INTO users (email, name) VALUES ('ztest-prschema@test', 'Schema Probe') RETURNING id
  `)) as unknown as { id: string }[];

  try {
    await db.execute(sql`
      INSERT INTO pipeline_reviews (pipeline_item_id, reviewer_id)
      VALUES (${item!.id}::uuid, ${user!.id}::uuid)
    `);

    let raised: unknown;
    try {
      await db.execute(sql`
        INSERT INTO pipeline_reviews (pipeline_item_id, reviewer_id)
        VALUES (${item!.id}::uuid, ${user!.id}::uuid)
      `);
    } catch (e) {
      raised = e;
    }
    expect(
      raised,
      'A duplicate (pipeline_item_id, reviewer_id) INSERT was ACCEPTED. The distinct-reviewer ' +
        'guarantee is not in the database, so one admin clicking Approve twice counts as two ' +
        'reviewers.',
    ).toBeDefined();
    // drizzle wraps driver errors in its own `Failed query: …` Error, so the SQLSTATE lives on the
    // `cause`, not the top-level error. Walk the chain rather than asserting on the wrapper's text.
    expect(pgErrorCode(raised), `expected SQLSTATE 23505 (unique_violation), got: ${raised}`).toBe('23505');
    // …and specifically OUR constraint, not some other accidental key.
    expect(pgConstraintName(raised)).toBe('pipeline_reviews_item_reviewer_uq');

    const counted = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pipeline_reviews WHERE pipeline_item_id = ${item!.id}::uuid
    `)) as unknown as { n: number }[];
    expect(counted[0]!.n).toBe(1);
  } finally {
    // pipeline_reviews cascades off pipeline_items; delete the card first so the user's
    // NO-ACTION reviewer FK (deliberate — see 0062) does not block the user delete.
    await db.execute(sql`DELETE FROM pipeline_items WHERE id = ${item!.id}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${user!.id}::uuid`);
  }
});

test('T9: pipeline_item_id CASCADES and reviewer_id does NOT (an approval survives offboarding)', async () => {
  // 0050 made offboarding a tombstone precisely so authorship survives a departure. An approval IS
  // authorship: `ON DELETE CASCADE` on reviewer_id would silently retro-un-approve every card an
  // ex-reviewer had approved, potentially dropping a live card below its required-reviewer count
  // with no event anywhere.
  const rows = (await db.execute(sql`
    SELECT a.attname::text AS col, c.confdeltype::text AS on_delete
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE ns.nspname = 'public' AND t.relname = 'pipeline_reviews' AND c.contype = 'f'
  `)) as unknown as { col: string; on_delete: string }[];

  const byCol = new Map(rows.map((r) => [r.col, r.on_delete]));
  expect(byCol.get('pipeline_item_id')).toBe('c'); // CASCADE — deleting a card removes its reviews
  expect(byCol.get('reviewer_id')).toBe('a'); // NO ACTION — an approval outlives its reviewer
});
