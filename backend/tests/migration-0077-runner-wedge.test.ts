// tests/migration-0077-runner-wedge.test.ts — the boot wedge, pinned through the REAL runner.
//
// ⛔ WHY THIS FILE IS SEPARATE FROM tests/migration-0077-dataset-capability.test.ts. That file
// drives 0077 with `sql.unsafe(migrationSql())` — one statement batch, one connection, no
// `_migrations` bookkeeping. It proves what the PREDICATES do. It cannot prove the thing the
// hardening actually exists to prevent, because that property does not belong to 0077 at all: it
// belongs to `src/db/migration-runner.ts`.
//
//   `runMigrations` (:101-130) opens ONE `sql.begin()` for ALL pending files, takes an advisory
//   lock, and applies each file inside its own `tx.savepoint`. The catch at :125-128 does not
//   swallow — it RETHROWS, wrapped. So the failure escapes the savepoint AND the outer `begin`,
//   and the whole transaction rolls back: the failing file, every file that succeeded BEFORE it in
//   the same run, and every `INSERT INTO _migrations` those files earned.
//
// ⛔ THE BLAST RADIUS IS THE POINT, AND IT IS WIDER THAN "0077 DID NOT APPLY". 0075 and 0076 apply
// CLEANLY, ahead of 0077, in the same transaction — and they are lost too, unrecorded, as if they
// had never run. The database is left exactly where it started, which is what makes the next boot
// replay the identical file list against the identical rows and fail identically. Deterministic
// data plus a rethrow is not a degraded boot, it is a PERMANENT one: the pod never starts again
// without a human editing the row out by hand.
//
// ⛔ AND THE CONTROL IS BUILT IN, NOT A MANUAL REVERT. The "unhardened" arm is not a retyped copy of
// the old SQL — `withoutGuards()` takes the SHIPPED file and deletes only the guard predicates,
// leaving every other character (and every MUST_CONTAIN needle) intact. So this file reds on the
// SQL SEMANTICS by construction: you cannot make it pass by restoring a spelling. If someone
// weakens the guard in 0077, `RUN 3` below stops being green.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { applyMigrations, migrationOrdinal } from '../src/db/migration-runner';
import { config } from '../src/config';

const REAL_MIGRATIONS = join(import.meta.dir, '..', 'migrations');
const SCRATCH_DB = 'cp_m0077_wedge_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');

const QUIET = { log: () => {}, warn: () => {}, error: () => {} };

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Numeric prefix of a migration filename, e.g. `0077_split_dataset_capability.sql` -> 77.
 *
 * ⛔ DELEGATES TO THE RUNNER'S OWN PREDICATE, and does not re-derive it. This used to be
 * `Number.parseInt(name.slice(0, 4), 10)` — a fixed 4-char window, which reads `00100_x.sql` as
 * **10** and would sort a five-digit migration into this file's baseline arm while production
 * applied it in the pending one. A test whose notion of "which migrations are pending" disagrees
 * with the runner's is describing a run that never happens. `NaN` is preserved as the
 * unparseable marker because the non-vacuity assertion below is written against `isFinite`.
 */
function ordinal(name: string): number {
  return migrationOrdinal(name) ?? Number.NaN;
}

/** Migrations with an ordinal at or above this are left PENDING for the runner to swallow whole. */
const WEDGE_CUTOFF = 75;

/**
 * The pending set must contain these three, in this order, or the scenario has no subject: 0077 is
 * the file that wedges, 0075 and 0076 are the collateral the header is about. Anything ELSE that is
 * pending (0078 today, and whatever lands next) is scenery — it rides along in the same transaction
 * and is asserted by count, not by name, so a new migration does not red this file.
 */
const REQUIRED_PENDING = [
  '0075_tenants_offboarded_at.sql',
  '0076_ocr_block_honest_copy.sql',
  '0077_split_dataset_capability.sql',
];

/**
 * ⛔ THE MUTATION, AND IT IS A SEMANTIC ONE. Deletes ONLY the `jsonb_typeof` guard predicates from
 * the shipped 0077 — the two single-line `AND jsonb_typeof(...)` clauses and the multi-line
 * `AND ( ... IS NULL OR jsonb_typeof(...) = 'object' )` block. Every comment, every other predicate
 * and every MUST_CONTAIN needle survives verbatim, so a text ratchet cannot tell the two apart and
 * only the DATABASE can. This is the pre-0e54e7f behaviour, derived rather than retyped.
 */
function withoutGuards(text: string): string {
  const out: string[] = [];
  let removed = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // The single-line guards, in both part 1 and part 2.
    if (/^\s*AND jsonb_typeof\(/.test(line)) {
      removed++;
      continue;
    }
    // Part 1's multi-line `AND ( … IS NULL OR jsonb_typeof(…) = 'object' )` — dropped whole, but
    // its statement terminator is NOT part of the guard and must survive.
    if (/^\s*AND \($/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\)\s*;?\s*$/.test(lines[j]!)) j++;
      if (j >= lines.length) throw new Error('unterminated `AND (` while deriving the mutation');
      if (lines[j]!.includes(';')) out.push(';');
      removed++;
      i = j;
      continue;
    }
    out.push(line);
  }
  // 4 = part 1's single-line `AND jsonb_typeof(descriptor)` + its multi-line `AND ( … )` block,
  // plus part 2's two single-line guards. A change in that shape must be noticed, not absorbed.
  if (removed !== 4) {
    throw new Error(
      `withoutGuards() removed ${removed} guard clause(s), expected 4 — 0077 no longer spells its ` +
        'guards the way this mutation expects, so the RUN 1/RUN 2 arms below would be running the ' +
        'HARDENED file and would pass vacuously. Re-derive the mutation against the current file.',
    );
  }
  return out.join('\n');
}

/** A migrations directory containing `files`, with 0077 optionally replaced. */
function stageMigrations(files: string[], override?: { name: string; body: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-m0077-'));
  for (const name of files) {
    const body =
      override && override.name === name
        ? override.body
        : readFileSync(join(REAL_MIGRATIONS, name), 'utf8');
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

let allFiles: string[];
let baselineFiles: string[];
let pendingFiles: string[];
let scratch: postgres.Sql;
const staged: string[] = [];

async function appliedNames(): Promise<string[]> {
  const rows = (await scratch.unsafe(
    `SELECT filename FROM _migrations ORDER BY filename`,
  )) as unknown as { filename: string }[];
  return rows.map((r) => r.filename);
}

/** Drives the REAL runner and reports what escaped it. */
async function runRunner(dir: string): Promise<string | null> {
  try {
    await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: QUIET });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeAll(async () => {
  allFiles = readdirSync(REAL_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // ⛔ THE SCENARIO IS A CUTOFF, NOT A COUNT. Everything below WEDGE_CUTOFF is applied first and
  // is the baseline; everything at or above it is left PENDING and goes into the single
  // transaction that 0077 either wedges (RUN 1/2) or survives (RUN 3). What the scenario NEEDS is
  // that 0077 is in that pending set with 0075 and 0076 ahead of it as the collateral — it does
  // NOT need the set to have exactly three members, and every migration added after 0077 joins it
  // harmlessly (it applies behind 0077 in RUN 3 and is rolled back with it in RUN 1).
  //
  // ⛔ WHY THIS IS DERIVED AND NOT `.toBe(3)`. It WAS a hand-typed 3, and 0078 broke it the day it
  // landed — a red that said "expected exactly 0075/0076/0077 pending" about a file list that was
  // exactly right. A literal here does not state the scenario's requirement, it states the
  // migrations directory's length on the day it was typed, so every future migration reds a test
  // about a runner it did not touch. The three names below are the requirement, spelled out.
  baselineFiles = allFiles.filter((f) => ordinal(f) < WEDGE_CUTOFF);
  pendingFiles = allFiles.filter((f) => ordinal(f) >= WEDGE_CUTOFF);

  // NON-VACUITY, AND IT IS THE HALF A COUNT USED TO PROVIDE. A derived split is satisfied by an
  // empty directory, by a renamed 0077, and by an unparseable filename (`Number.parseInt` yields
  // NaN, `NaN >= 75` is false, and the file would silently join the BASELINE — applied before the
  // wedge instead of inside it). Each of those is asserted rather than assumed.
  expect(
    allFiles.filter((f) => !Number.isFinite(ordinal(f))),
    'a migration filename has no 4-digit ordinal — it would silently sort into the baseline arm',
  ).toEqual([]);
  expect(baselineFiles.length, 'no baseline migrations — the scratch DB would start from nothing').toBeGreaterThan(0);
  for (const required of REQUIRED_PENDING) {
    expect(
      pendingFiles,
      `${required} is not pending — this file's whole scenario is 0077 wedging the transaction ` +
        'with 0075/0076 as collateral. If it was renamed, rename it here; if it was squashed away, ' +
        'this test no longer has a subject and needs rewriting, not re-pointing.',
    ).toContain(required);
  }

  // ⛔ FROM THE SIBLING LANE, AND NOT REDUNDANT WITH THE LOOP ABOVE. `toContain` says each required
  // file is pending; this says they are the FIRST THREE, IN ORDER. That adjacency is the whole
  // reason 0075/0076 are collateral when 0077 rethrows — a new file sorting BETWEEN them would
  // satisfy every assertion above and still break the scenario. Both branches that rewrote this
  // file landed half the property; this is the union.
  expect(
    pendingFiles.slice(0, 3),
    'the wedge needs 0075 and 0076 pending immediately ahead of 0077',
  ).toEqual([
    '0075_tenants_offboarded_at.sql',
    '0076_ocr_block_honest_copy.sql',
    '0077_split_dataset_capability.sql',
  ]);

  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  const baseDir = stageMigrations(baselineFiles);
  staged.push(baseDir);
  await applyMigrations(SCRATCH_DSN, { migrationsDir: baseDir, logger: QUIET });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });

  // The offending row: a GLOBAL slug part 1 of 0077 names, whose `capabilities` is JSON null.
  // `$3::text::jsonb`, never `$3::jsonb` — postgres.js would JSON-encode the string into a jsonb
  // STRING and the row would not have the shape this case is about.
  await scratch.unsafe(
    `INSERT INTO building_blocks (id, slug, name, category, tenant_id)
       VALUES ($1, 'example-claim-data', 'example-claim-data', 'data', NULL)`,
    ['00000000-0000-4000-8000-000000771001'],
  );
  await scratch.unsafe(
    `INSERT INTO block_versions (id, block_id, version, descriptor, source_ts)
       VALUES ($1, '00000000-0000-4000-8000-000000771001', '1.0.0', $2::text::jsonb, '')`,
    ['00000000-0000-4000-8000-0000007710a0', '{"inputs":{},"outputs":{},"capabilities":null}'],
  );
  expect(
    (
      (await scratch.unsafe(
        `SELECT jsonb_typeof(descriptor -> 'capabilities') AS t FROM block_versions WHERE id = $1`,
        ['00000000-0000-4000-8000-0000007710a0'],
      )) as unknown as { t: string }[]
    )[0]!.t,
    'the fixture is not a JSON null — this case tests nothing',
  ).toBe('null');

}, 300_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  for (const d of staged) rmSync(d, { recursive: true, force: true });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

test('⛔ WEDGE: one malformed descriptor rolls back 0075+0076 too, and every retry repeats it', async () => {
  const before = await appliedNames();
  expect(before, 'baseline should not contain any of the pending files').not.toContain(
    '0077_split_dataset_capability.sql',
  );

  const brokenDir = stageMigrations(allFiles, {
    name: '0077_split_dataset_capability.sql',
    body: withoutGuards(readFileSync(join(REAL_MIGRATIONS, '0077_split_dataset_capability.sql'), 'utf8')),
  });
  staged.push(brokenDir);

  // ---- RUN 1: the boot that breaks.
  const run1 = await runRunner(brokenDir);
  expect(run1, 'the unguarded 0077 did NOT throw — the whole premise is gone').not.toBeNull();
  expect(run1).toContain('0077_split_dataset_capability.sql');
  expect(run1).toMatch(/cannot delete from scalar/i);

  // ⛔ THE BLAST RADIUS. Not "0077 is missing" — 0075 and 0076 applied cleanly, ahead of it, and
  // went down with it. `_migrations` is byte-identical to the pre-run baseline.
  const after1 = await appliedNames();
  expect(after1, '0075 survived the rollback — the runner is not all-or-nothing after all').not.toContain(
    '0075_tenants_offboarded_at.sql',
  );
  expect(after1).not.toContain('0076_ocr_block_honest_copy.sql');
  expect(after1).toEqual(before);

  // ---- RUN 2: the next boot. Deterministic data + rethrow = the SAME failure, forever.
  const run2 = await runRunner(brokenDir);
  expect(run2, 'the second boot succeeded — the failure is not deterministic').not.toBeNull();
  expect(run2).toBe(run1!);
  expect(await appliedNames(), 'the retry made progress — it should make none').toEqual(before);

}, 300_000);

/**
 * ⛔ RUN 3, DELIBERATELY A SEPARATE CASE — AND IT IS THE ONE THAT REDS ON A REVERTED MIGRATION.
 * The case above needs `withoutGuards()` to build its broken arm, and `withoutGuards()` refuses to
 * run on a 0077 that has no guards left to remove. So if someone reverts the hardening, that case
 * fails at the MUTATION, which is a spelling-shaped failure — exactly the thing this file is not
 * allowed to rely on. This case touches no mutation at all: it feeds the runner the SHIPPED
 * migrations directory over a database that still holds the malformed row, and asserts it boots.
 * Revert 0077 and it goes red the only way that means anything — the real runner throwing.
 *
 * It runs SECOND on purpose. bun executes a file's tests in declaration order and both share one
 * scratch database, so this case inherits the exact state the failed boots left behind: every file
 * at or above the cutoff still pending, the malformed row still there, nothing repaired.
 */
test('⛔ RECOVERY: the SHIPPED 0077 boots the same database, malformed row and all', async () => {
  // ⛔ SELF-CONTAINED ON PURPOSE. It reads its own baseline instead of inheriting one from the
  // case above, so that a WEDGE failure cannot CASCADE into a fake failure here. Reverting 0077
  // makes WEDGE fail at its mutation (a spelling-shaped failure) — this case must still reach the
  // runner and fail on what the runner actually does. The pending set is intact either way: a wedged
  // boot rolls everything back, and a WEDGE that never ran changed nothing.
  const before = await appliedNames();
  expect(before, 'the pending files are not pending — the baseline is wrong').not.toContain(
    '0077_split_dataset_capability.sql',
  );

  const goodDir = stageMigrations(allFiles);
  staged.push(goodDir);
  const run3 = await runRunner(goodDir);
  expect(run3, `the shipped 0077 wedges the runner: ${run3}`).toBeNull();

  const after3 = await appliedNames();
  expect(after3).toContain('0075_tenants_offboarded_at.sql');
  expect(after3).toContain('0076_ocr_block_honest_copy.sql');
  expect(after3).toContain('0077_split_dataset_capability.sql');
  // Every pending file, not just the three named ones — the recovery boot must record the whole
  // set it swallowed, so a migration that applies but fails to record is still caught here.
  expect(
    after3.length,
    `the boot recovered but did not record all ${pendingFiles.length} pending migrations`,
  ).toBe(before.length + pendingFiles.length);
  expect(after3, 'the recovery boot recorded something outside the pending set').toEqual(
    [...before, ...pendingFiles].sort(),
  );

  // …and the row that caused all of it is untouched — not normalised, not deleted. The migration's
  // decision is SKIP, and this is that decision measured rather than asserted in a comment.
  const rows = (await scratch.unsafe(
    `SELECT descriptor::text AS d FROM block_versions WHERE id = $1`,
    ['00000000-0000-4000-8000-0000007710a0'],
  )) as unknown as { d: string }[];
  expect(JSON.parse(rows[0]!.d)).toEqual({ inputs: {}, outputs: {}, capabilities: null });
}, 300_000);
