// tests/vote-count-reconciliation.test.ts — migration 0064 reconciles the denormalized
// `votes_count` caches to the `votes` rows. Prod displayed 4,760 votes across 25 rows against 18
// real `votes` rows platform-wide, and `WINNER_ORDER` ranks the winner on that column.
//
// ⛔ THE TESTS EXECUTE THE SHIPPED SQL, LIFTED VERBATIM FROM THE MIGRATION FILE BETWEEN ITS OWN
// MARKERS. Re-implementing the three UPDATEs here would pin a COPY: the copy would stay green while
// the shipped file rotted, which is the exact failure mode that lets a backfill regress unnoticed.
// Same technique, and same reasoning, as usage-metrics-platform.test.ts:141-176 does for 0063.
//
// ⛔ WHY A SCRATCH DATABASE AND NOT THE SUITE'S SHARED ONE. The shipped statements are TABLE-WIDE
// by design — that is what makes them a reconciliation. Every test file shares ONE database (⚠️
// CORRECTED 2026-08-16: sequentially — this line used to say "bun runs test FILES CONCURRENTLY",
// which is false; canonical note at the top of tests/metering-platform-calls.test.ts) and a dozen
// other files INSERT deliberately-drifted fixtures (`votes_count: 4321` with one `votes` row,
// `votes_count: 999` with none — see marketplace-i18n / content-i18n / challenges /
// cycle-eligibility). A table-wide UPDATE against that database would silently repair every one of
// those, so whichever of those files runs AFTER us reads a reconciled row it never wrote — and any
// work leaked past an earlier file's end could still land between our UPDATE and our residual
// count, reading as a failed reconciliation. So: our own database, created and dropped here, migrated
// by the REAL runner. Precedent and helper shape: seed-fabrication-guard.test.ts's TB6 block.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { applyMigrations } from '../src/db/migration-runner';
import { periodSolutionStats } from '../src/host/cycle-eligibility';
import { recountVotes } from '../src/host/vote-service';
import { config } from '../src/config';

// ---------------------------------------------------------------------------------------------
// The shipped SQL, lifted from the file that actually runs against prod.
// ---------------------------------------------------------------------------------------------

const MIGRATION_0064 = join(import.meta.dir, '..', 'migrations', '0064_reconcile_vote_counts.sql');

type StepNo = 1 | 2 | 3;

const STEP_NAME: Record<StepNo, string> = {
  1: 'CHALLENGES RECONCILE',
  2: 'SOLUTIONS RECONCILE',
  3: 'WINNER STATS RECOMPUTE',
};

/** What each block must still contain. Not decoration: each entry is a property the block would
 *  lose silently under a plausible "tidy-up", and each one has a named consequence. */
const STEP_MUST_CONTAIN: Record<StepNo, string[]> = {
  1: ['UPDATE challenges', 'IS DISTINCT FROM', "v.target_type = 'challenge'", 'residual'],
  2: ['UPDATE solutions', 'IS DISTINCT FROM', "v.target_type = 'solution'", 'residual'],
  3: ['UPDATE weekly_winners', 'jsonb_exists', 'firstTimeBuilders', 'crossDomain', 'residual'],
};

/**
 * Extract one step's `DO $$ … $$;` block from the migration, between its `>>> … <<<` markers.
 *
 * The throws below name what REGRESSES if the block is gone, rather than reporting a missing
 * string: a test that fails with "could not find marker" invites deleting the test.
 */
function stepSql(n: StepNo): string {
  const text = readFileSync(MIGRATION_0064, 'utf8');
  const head = text.indexOf(`>>> 0064 STEP ${n} ${STEP_NAME[n]}`);
  const end = text.indexOf(`-- >>> END 0064 STEP ${n} ${STEP_NAME[n]} <<<`);
  const start = head < 0 ? -1 : text.indexOf('DO $$', head);
  if (head < 0 || start < 0 || end < 0 || start > end) {
    throw new Error(
      `could not find 0064 step ${n} (${STEP_NAME[n]}) between its markers — it has been removed ` +
        'or renamed. If that was deliberate: step 1/2 leaving means 25 prod rows go back to ' +
        'showing 4,760 votes against 18 real ones and WINNER_ORDER goes back to ranking the ' +
        'winner on a number nobody cast; step 3 leaving means the winner screen prints the live ' +
        'count beside a hard-coded 1.180 in the same stat row. This test is what was supposed to ' +
        'stop that.',
    );
  }
  const block = text.slice(start, end);
  for (const needle of STEP_MUST_CONTAIN[n]) {
    if (!block.includes(needle)) {
      throw new Error(`0064 step ${n} no longer contains ${JSON.stringify(needle)}`);
    }
  }
  // ⛔ A CTE here would be a MEASURE-THEN-WRITE and could destroy a genuine vote cast between the
  // measurement and the write (castVote inserts the row and bumps the counter in one transaction).
  // The count must stay a correlated subquery inside the UPDATE — see the migration's header.
  // ⚠️ NECESSARY, NOT SUFFICIENT: the correlated subquery does NOT close the race on its own (READ
  // COMMITTED evaluates it against the statement snapshot even after EvalPlanQual re-checks the
  // locked row), which is why VC10 below pins the RESIDUAL GUARD as the thing that actually makes
  // the file safe. This check only stops the strictly-worse spelling.
  // (Matched as CTE SYNTAX — `WITH <name> AS (` — not the bare word: the guards' own error text
  // says "disagree with the votes table", which a `\bWITH\b` check flags as a false positive.)
  if (/\bWITH\s+\w+\s+AS\s*\(/i.test(block)) {
    throw new Error(
      `0064 step ${n} now contains a CTE. The count must be a CORRELATED SUBQUERY INSIDE the ` +
        'UPDATE: a pre-measured CTE races castVote and silently overwrites a real vote with a ' +
        'count taken before it landed.',
    );
  }
  return block;
}

// ---------------------------------------------------------------------------------------------
// Scratch database. Named after THIS file so no other file — or a second checkout running its own
// suite against the same server — can collide on the name.
// ---------------------------------------------------------------------------------------------

const SCRATCH_DB = 'cp_vc64_recount_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}

const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');

let scratch: postgres.Sql;
let scratchDb: ReturnType<typeof drizzle>;

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture. Own UUID prefix (`…-00000c64…`, after the migration number) so nothing here can ever be
// confused with another file's ids — see fixture-id-collisions.test.ts for why that matters.
// ---------------------------------------------------------------------------------------------

const T1 = '00000000-0000-4000-8000-00000c640001'; // the seeded tenant: drift in both directions
const T2 = '00000000-0000-4000-8000-00000c640002'; // a tenant whose winner was written by a CLOSE
const T3 = '00000000-0000-4000-8000-00000c640003'; // a DERIVED winner: stats IS NULL

const AUTHOR = '00000000-0000-4000-8000-00000c6400a0';
const V1 = '00000000-0000-4000-8000-00000c6400b1';
const V2 = '00000000-0000-4000-8000-00000c6400b2';
const V3 = '00000000-0000-4000-8000-00000c6400b3';

const CH1 = '00000000-0000-4000-8000-00000c6401c1'; // 312 shown / 2 real  — the prod shape
const CH2 = '00000000-0000-4000-8000-00000c6401c2'; //   0 shown / 3 real  — UNDER-count
const CH3 = '00000000-0000-4000-8000-00000c6401c3'; //   0 shown / 0 real  — already correct

const S1 = '00000000-0000-4000-8000-00000c6402d1'; // 316 shown / 2 real
const S2 = '00000000-0000-4000-8000-00000c6402d2'; // 189 shown / 1 real
const S3 = '00000000-0000-4000-8000-00000c6402d3'; //   0 shown / 0 real — already correct
const S4 = '00000000-0000-4000-8000-00000c6402d4'; //   7 shown / 0 real, in T2
/** ⛔ A `draft` SOLUTION, AND THE ONLY ONE. Without it VC9's advertised revert — "status-filter step
 *  3's subquery" — is VACUOUS: the fixture held only `shipping` and `voting` rows, so adding
 *  `AND s.status <> 'draft'` to all four of step 3's subqueries changed no number and the whole
 *  suite stayed green while the property VC9 claims to pin was gone. `draft` is precisely the status
 *  periodSolutionStats does NOT filter (the close counts every submission, drafts included), so it is
 *  the one status whose presence makes the transcription-vs-helper comparison load-bearing. It also
 *  carries drift of its own (25 shown / 1 real) so it moves BOTH keys, not just solutionsSubmitted. */
const S5 = '00000000-0000-4000-8000-00000c6402d5'; //  25 shown / 1 real, status = 'draft', in T1

const W1 = '00000000-0000-4000-8000-00000c6403e1'; // seeder artifact  (4 keys)
const W2 = '00000000-0000-4000-8000-00000c6403e2'; // close artifact   (2 keys, STALE on purpose)
const W3 = '00000000-0000-4000-8000-00000c6403e3'; // derived winner   (stats IS NULL)

const WEEK = '2026-W23';

/** The close-written artifact, written STALE ON PURPOSE. If it already equalled what the recompute
 *  produces, VC8 would stay green even with the predicate widened to `stats ? 'totalVotesCast'` —
 *  the test would assert nothing. T2's real figures after reconciliation are {1, 0}. */
const CLOSE_WRITTEN_STATS = '{"totalVotesCast": 999, "solutionsSubmitted": 42}';

/** Rebuild the whole fixture from nothing. Every test calls it first, so no test needs a restore
 *  step and no test can inherit another's writes. */
async function reset(): Promise<void> {
  const statements = [
    `TRUNCATE weekly_winners, votes, solutions, challenges, users, tenants RESTART IDENTITY CASCADE`,

    `INSERT INTO tenants (id, name, slug) VALUES
       ('${T1}', 'VC64 seeded',  'vc64-seeded'),
       ('${T2}', 'VC64 closed',  'vc64-closed'),
       ('${T3}', 'VC64 derived', 'vc64-derived')`,

    `INSERT INTO users (id, email, name, tenant_id) VALUES
       ('${AUTHOR}', 'vc64-author@commonpractice.local', 'VC64 Author', '${T1}'),
       ('${V1}',     'vc64-v1@commonpractice.local',     'VC64 Voter 1', '${T1}'),
       ('${V2}',     'vc64-v2@commonpractice.local',     'VC64 Voter 2', '${T1}'),
       ('${V3}',     'vc64-v3@commonpractice.local',     'VC64 Voter 3', '${T1}')`,

    // votes_count carries the SHOWN number; the `votes` rows below carry the REAL one.
    `INSERT INTO challenges (id, title, work_area, submitter_id, tenant_id, status, week, votes_count) VALUES
       ('${CH1}', 'VC64 auto-summarize claim forms', 'Claims',    '${AUTHOR}', '${T1}', 'solution_phase', '${WEEK}', 312),
       ('${CH2}', 'VC64 under-counted challenge',    'Service',   '${AUTHOR}', '${T1}', 'voting',         '${WEEK}',   0),
       ('${CH3}', 'VC64 already-correct challenge',  'Marketing', '${AUTHOR}', '${T2}', 'voting',         '${WEEK}',   0)`,

    `INSERT INTO solutions (id, challenge_id, title, author_id, tenant_id, status, week, votes_count) VALUES
       ('${S1}', '${CH1}', 'VC64 streaming summarizer', '${AUTHOR}', '${T1}', 'shipping', '${WEEK}', 316),
       ('${S2}', '${CH1}', 'VC64 inline review queue',  '${AUTHOR}', '${T1}', 'voting',   '${WEEK}', 189),
       ('${S3}', '${CH1}', 'VC64 already-correct',      '${AUTHOR}', '${T1}', 'voting',   '${WEEK}',   0),
       ('${S4}', '${CH3}', 'VC64 other tenant',         '${AUTHOR}', '${T2}', 'shipping', '${WEEK}',   7),
       ('${S5}', '${CH1}', 'VC64 draft submission',     '${AUTHOR}', '${T1}', 'draft',    '${WEEK}',  25)`,

    // THE RECORD. 9 rows: CH1←2, CH2←3, S1←2, S2←1, S5←1. Nothing votes on CH3/S3/S4.
    `INSERT INTO votes (user_id, tenant_id, target_type, target_id) VALUES
       ('${V1}', '${T1}', 'challenge', '${CH1}'),
       ('${V2}', '${T1}', 'challenge', '${CH1}'),
       ('${V1}', '${T1}', 'challenge', '${CH2}'),
       ('${V2}', '${T1}', 'challenge', '${CH2}'),
       ('${V3}', '${T1}', 'challenge', '${CH2}'),
       ('${V1}', '${T1}', 'solution',  '${S1}'),
       ('${V2}', '${T1}', 'solution',  '${S1}'),
       ('${V1}', '${T1}', 'solution',  '${S2}'),
       ('${V3}', '${T1}', 'solution',  '${S5}')`,

    `INSERT INTO weekly_winners (id, week, solution_id, challenge_id, tenant_id, stats) VALUES
       ('${W1}', '${WEEK}',    '${S1}', '${CH1}', '${T1}',
          '{"totalVotesCast": 1180, "solutionsSubmitted": 14, "firstTimeBuilders": 7, "crossDomain": 9}'::jsonb),
       ('${W2}', '${WEEK}',    '${S4}', '${CH3}', '${T2}', '${CLOSE_WRITTEN_STATS}'::jsonb),
       ('${W3}', '2026-W24',   '${S3}', '${CH1}', '${T3}', NULL)`,
  ];
  for (const stmt of statements) await scratch.unsafe(stmt);
}

async function runStep(n: StepNo): Promise<void> {
  await scratch.unsafe(stepSql(n));
}

/** The migration's three data steps, in file order. Step 3 sums `solutions.votes_count`, so it is
 *  only correct after steps 1-2 — running them out of order would freeze the inflated total. */
async function runAllSteps(): Promise<void> {
  await runStep(1);
  await runStep(2);
  await runStep(3);
}

async function votesCount(table: 'challenges' | 'solutions', id: string): Promise<number> {
  const rows = (await scratch.unsafe(
    `SELECT votes_count FROM ${table} WHERE id = '${id}'`,
  )) as unknown as { votes_count: number }[];
  if (!rows[0]) throw new Error(`fixture row ${table}.${id} is missing`);
  return rows[0].votes_count;
}

async function stats(id: string): Promise<Record<string, number> | null> {
  const rows = (await scratch.unsafe(
    `SELECT stats FROM weekly_winners WHERE id = '${id}'`,
  )) as unknown as { stats: Record<string, number> | null }[];
  if (!rows[0]) throw new Error(`fixture winner ${id} is missing`);
  return rows[0].stats;
}

/** `xmin` is the transaction that last WROTE the row. It is the only way to tell "written with the
 *  same value" apart from "not written at all" — which is exactly the difference between an UPDATE
 *  that carries `IS DISTINCT FROM` and one that does not. */
async function rowVersions(table: string): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, xmin::text AS v FROM ${table} ORDER BY id`,
  )) as unknown as { id: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

/**
 * Remove the `IF residual <> 0 THEN … END IF;` branch from a step block, leaving everything else
 * byte-for-byte. VC10 runs the SHIPPED block and this mutation through the SAME interleaving, so
 * the difference between them is the guard and nothing else.
 */
function stripResidualGuard(block: string): string {
  const at = block.indexOf('IF residual <> 0 THEN');
  const end = block.indexOf('END IF;', at);
  if (at < 0 || end < 0) {
    throw new Error(
      'could not find the `IF residual <> 0 THEN … END IF;` guard to strip. Either it is gone — in ' +
        'which case the migration can silently destroy a genuine vote cast during the roll-out, ' +
        'which is what VC10 exists to prove — or it was respelled and this mutation needs ' +
        're-deriving before the test can be trusted.',
    );
  }
  return block.slice(0, at) + block.slice(end + 'END IF;'.length);
}

/**
 * Block until some backend on the scratch database is waiting on a LOCK inside the statement whose
 * text contains `marker`. This is what makes VC10/VC11 deterministic rather than a sleep: the
 * interleaving they need is "the reconciler is parked on the voter's row lock", and that is a state
 * the server will tell us about directly.
 */
async function awaitLockWait(probe: postgres.Sql, marker: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await probe.unsafe(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND position($1 in query) > 0`,
      [marker],
    )) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `no backend ever blocked on a row lock inside a statement containing ${JSON.stringify(marker)}. ` +
          'The interleaving this test depends on did not happen, so a green result would mean ' +
          'nothing — do not weaken the assertion, work out why the reconciler did not wait.',
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** BEGIN a second session that casts a GENUINE vote exactly the way castVote does — insert the
 *  `votes` row and bump the counter in ONE transaction — and leave it uncommitted, holding the
 *  target's row lock. CH1 goes from 312/2 to a legitimate 313 shown / 3 real. */
async function beginHeldVoteOnCh1(voter: postgres.Sql): Promise<void> {
  await voter.unsafe('BEGIN');
  await voter.unsafe(
    `INSERT INTO votes (user_id, tenant_id, target_type, target_id)
       VALUES ('${V3}', '${T1}', 'challenge', '${CH1}')`,
  );
  await voter.unsafe(`UPDATE challenges SET votes_count = votes_count + 1 WHERE id = '${CH1}'`);
}

async function voteRows(): Promise<string[]> {
  const rows = (await scratch.unsafe(
    `SELECT (target_type || ':' || target_id || ':' || user_id) AS k FROM votes ORDER BY k`,
  )) as unknown as { k: string }[];
  return rows.map((r) => r.k);
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    // FORCE so a connection stranded by a previously-killed run cannot block the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  // The REAL runner, so the scratch schema is the schema 0064 ships against — including 0064
  // itself, which runs here against an empty database and correctly does nothing.
  await applyMigrations(SCRATCH_DSN, { logger: { log: () => {}, warn: () => {}, error: console.error } });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
  scratchDb = drizzle(scratch);
}, 180_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

// ---------------------------------------------------------------------------------------------
// VC1-VC2 — the defect itself.
// ---------------------------------------------------------------------------------------------

test('VC1: an inflated CHALLENGE counter is reconciled to the votes rows (312 → 2)', async () => {
  // REVERT THAT REDS THIS: delete step 1 from the migration (the extractor throws), or change its
  // UPDATE to leave the column alone → 312 stays.
  await reset();
  expect(await votesCount('challenges', CH1)).toBe(312);
  await runAllSteps();
  expect(await votesCount('challenges', CH1)).toBe(2);
}, 30_000);

test('VC2: an inflated SOLUTION counter is reconciled to the votes rows (316 → 2)', async () => {
  // The one with teeth: WINNER_ORDER (cycle-eligibility.ts:71) ranks on this column, so 316 does
  // not merely misreport the winner — it picks one.
  // REVERT THAT REDS THIS: delete step 2 → 316 stays and S1 keeps outranking every real vote.
  await reset();
  expect(await votesCount('solutions', S1)).toBe(316);
  await runAllSteps();
  expect(await votesCount('solutions', S1)).toBe(2);
  expect(await votesCount('solutions', S2)).toBe(1);
  // The `draft` row is reconciled like any other — step 2 is not status-filtered either, and a
  // draft that has been voted on is exactly the row a status filter would strand at 25.
  expect(await votesCount('solutions', S5)).toBe(1);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// VC3 — idempotence, measured by row VERSION and not by value.
// ---------------------------------------------------------------------------------------------

test('VC3: a second pass writes ZERO rows (not "the same values again")', async () => {
  // ⛔ Asserting the VALUES are unchanged would pass with `IS DISTINCT FROM` deleted — a second
  // full-table rewrite produces identical values. `xmin` is the transaction that last wrote the
  // row, so an unchanged xmin is proof no write happened: no WAL, no bloat, no `updated_at` churn
  // across every board row on every boot, and no lock taken on a row a member is voting on.
  // REVERT THAT REDS THIS: drop the `WHERE … IS DISTINCT FROM (…)` clause from step 1, 2 or 3 →
  // every row is rewritten on the second pass and its xmin moves.
  await reset();
  await runAllSteps();
  const before = {
    challenges: await rowVersions('challenges'),
    solutions: await rowVersions('solutions'),
    weekly_winners: await rowVersions('weekly_winners'),
  };
  await runAllSteps();
  expect({
    challenges: await rowVersions('challenges'),
    solutions: await rowVersions('solutions'),
    weekly_winners: await rowVersions('weekly_winners'),
  }).toEqual(before);
}, 30_000);

test('VC3b: an ALREADY-CORRECT row is never written, even on the first pass', async () => {
  // The corollary, and the reason a fresh CI database is a legitimate full no-op: CH3/S3 already
  // agree with the (empty) vote set, so the first pass must skip them exactly as the second does.
  await reset();
  const before = { c: await rowVersions('challenges'), s: await rowVersions('solutions') };
  await runAllSteps();
  const after = { c: await rowVersions('challenges'), s: await rowVersions('solutions') };
  expect(after.c[CH3]).toBe(before.c[CH3]!);
  expect(after.s[S3]).toBe(before.s[S3]!);
  // …and the drifted ones next to them DID move, so this is not vacuous.
  expect(after.c[CH1]).not.toBe(before.c[CH1]!);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// VC4 — the direction of the fix.
// ---------------------------------------------------------------------------------------------

test('VC4: no `votes` row is created or destroyed', async () => {
  // The other way to make 312 and 2 agree is to INSERT 310 votes — i.e. to forge 310 members'
  // opinions in the table that is supposed to be the evidence. `votes` is the RECORD and
  // `votes_count` is a CACHE of it; this migration may only ever write the cache.
  // REVERT THAT REDS THIS: add any INSERT INTO votes / DELETE FROM votes to any step.
  await reset();
  const before = await voteRows();
  expect(before).toHaveLength(9);
  await runAllSteps();
  expect(await voteRows()).toEqual(before);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// VC5 — this is a RECONCILIATION, not a clamp.
// ---------------------------------------------------------------------------------------------

test('VC5: an UNDER-count is fixed too (0 → 3)', async () => {
  // ⛔ The cheap version of this migration is `votes_count = LEAST(votes_count, real)`, which fixes
  // every prod row measured and is still wrong: it enshrines the counter as an upper bound and
  // silently keeps a row that LOST votes. It also cannot repair the drift the showcase seeder
  // itself creates — it inserts 8 genuine `votes` rows with a raw insert that bumps nothing, so
  // its targets sit BELOW the truth. CH2 is that shape.
  // REVERT THAT REDS THIS: wrap either UPDATE's subquery in LEAST(votes_count, …) → CH2 stays 0.
  await reset();
  expect(await votesCount('challenges', CH2)).toBe(0);
  await runAllSteps();
  expect(await votesCount('challenges', CH2)).toBe(3);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// VC6 — the post-condition guard is load-bearing, not ceremony.
// ---------------------------------------------------------------------------------------------

test('VC6: the post-condition guard RAISES when the UPDATE fails to reconcile', async () => {
  // ⛔ WITHOUT THIS TEST, DELETING THE `IF residual <> 0` BRANCH LEAVES EVERY OTHER TEST IN THIS
  // FILE GREEN — the guard only ever fires on a state the happy path cannot reach.
  //
  // Provoking it means making the statement NOT do its job, which is done here by neutering the
  // shipped UPDATE's predicate (`WHERE false AND …`) and leaving the shipped guard untouched. The
  // mutation is asserted, so it cannot silently stop applying and turn this into a vacuous pass.
  await reset();
  const block = stepSql(1);
  const anchor = 'WHERE c.votes_count IS DISTINCT FROM (';
  // Two occurrences: the UPDATE's predicate, then the residual SELECT's. Only the FIRST is
  // neutered — the guard must keep measuring the whole table or it would not notice.
  expect(
    block.split(anchor).length,
    'step 1 no longer has exactly one UPDATE predicate and one residual predicate — re-derive the ' +
      'neutering below before trusting this test',
  ).toBe(3);
  const at = block.indexOf(anchor);
  // `WHERE c.votes_count IS …` → `WHERE false AND c.votes_count IS …`, i.e. the UPDATE still runs
  // and still matches nothing. Everything else in the shipped block is byte-for-byte untouched.
  const neutered = `${block.slice(0, at)}WHERE false AND ${block.slice(at + 'WHERE '.length)}`;
  expect(neutered).toContain('WHERE false AND c.votes_count IS DISTINCT FROM (');
  expect(neutered.length).toBe(block.length + 'false AND '.length);

  // Plain try/catch rather than `expect(...).rejects.toThrow(...)`: bun 1.3.14's `.rejects` matcher
  // does not terminate on a postgres.js PendingQuery (it spins at 100% CPU indefinitely, never
  // reporting), which is a harness bug, not a property of the SQL — the statement below rejects in
  // ~4 ms when awaited directly.
  let raised: unknown;
  try {
    await scratch.unsafe(neutered);
  } catch (e) {
    raised = e;
  }
  expect(
    raised,
    'the neutered UPDATE reconciled nothing and the shipped guard did NOT refuse. That is the ' +
      '`IF residual <> 0` branch being gone: a partial or failed reconciliation would then report ' +
      'success and the board would keep ranking on numbers nobody cast.',
  ).toBeDefined();
  expect((raised as Error).message).toMatch(
    /step 1: 2 challenge row\(s\) still disagree with the votes table/,
  );
  // …and nothing was written, so a raised guard really does abort rather than half-apply.
  expect(await votesCount('challenges', CH1)).toBe(312);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// VC10 — the guard is not paranoia: it is the only thing standing between a concurrent vote and
// its destruction. Two sessions, no sleeps.
// ---------------------------------------------------------------------------------------------

test('VC10: a vote committed during the UPDATE is DESTROYED without the guard, and ABORTS with it', async () => {
  // ⛔ THIS TEST IS THE EVIDENCE FOR THE RETRACTION IN THE MIGRATION HEADER. That header used to
  // claim the correlated subquery closed this race — "evaluated as part of the UPDATE's own
  // statement snapshot against the row it is locking, so the window does not exist". It does not.
  // Under READ COMMITTED an UPDATE that blocks on a row lock re-checks the UPDATED ROW when the
  // blocker commits (EvalPlanQual) but evaluates the rest of the statement, subquery included,
  // against its ORIGINAL snapshot: it sees "the effects of concurrent updating commands on the same
  // rows it is trying to update", not their effects "on other rows in the database". `votes` is
  // another table, so the subquery still returns the pre-vote count.
  //
  // Deterministic, not timed: the voter holds the row lock, and we do not commit it until
  // pg_stat_activity reports a backend PARKED ON A LOCK inside the step-1 statement itself.
  const voter = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
  const probe = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
  const marker = '[0064] step 1';
  try {
    // ---- half 1: guard STRIPPED. The genuine vote is silently deleted. -----------------------
    await reset();
    const stripped = stripResidualGuard(stepSql(1));
    expect(stripped).not.toContain('IF residual <> 0 THEN');
    await beginHeldVoteOnCh1(voter);
    const unguarded = scratch.unsafe(stripped).then(
      () => null,
      (e: unknown) => e,
    );
    await awaitLockWait(probe, marker);
    await voter.unsafe('COMMIT'); // CH1 is now legitimately 313 shown / 3 real
    expect(
      await unguarded,
      'the guard-stripped block refused. It cannot: with the IF branch gone there is nothing left ' +
        'in step 1 that can raise.',
    ).toBeNull();
    // The whole point, in one line. The `votes` row survives to prove the vote was cast; no
    // counter anywhere reflects it; nothing logged, nothing failed.
    expect(
      await votesCount('challenges', CH1),
      'without the residual guard the reconciler was supposed to overwrite a legitimate 3 with the ' +
        'count it took before the vote landed. It did not — which means the race this file ' +
        'documents no longer reproduces and the header retraction needs re-deriving, NOT that the ' +
        'guard has become optional.',
    ).toBe(2);
    expect(await voteRows()).toHaveLength(10);

    // ---- half 2: SHIPPED block, same interleaving. It refuses and writes nothing. -------------
    await reset();
    await beginHeldVoteOnCh1(voter);
    const guarded = scratch.unsafe(stepSql(1)).then(
      () => null,
      (e: unknown) => e,
    );
    await awaitLockWait(probe, marker);
    await voter.unsafe('COMMIT');
    const raised = await guarded;
    expect(
      raised,
      'the SHIPPED step 1 completed through a concurrent vote. Compare half 1: that is a destroyed ' +
        'vote reported as a success.',
    ).not.toBeNull();
    expect((raised as Error).message).toMatch(
      /step 1: 1 challenge row\(s\) still disagree with the votes table/,
    );
    // Aborted, not half-applied: CH1 keeps castVote's own correct +1, and CH2 — which the same
    // statement had already reconciled 0 → 3 — is rolled back with it.
    expect(await votesCount('challenges', CH1)).toBe(313);
    expect(await votesCount('challenges', CH2)).toBe(0);
    // …and the file is re-runnable, which is what makes "abort and re-roll the pod" an acceptable
    // trade rather than an outage: with the vote committed, the next pass just works.
    await runStep(1);
    expect(await votesCount('challenges', CH1)).toBe(3);
    expect(await votesCount('challenges', CH2)).toBe(3);
  } finally {
    await voter.unsafe('ROLLBACK').catch(() => {});
    await voter.end({ timeout: 5 });
    await probe.end({ timeout: 5 });
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------
// VC11 — the SAME race in the general repair primitive, which has no migration guard behind it.
// ---------------------------------------------------------------------------------------------

test('VC11: recountVotes() cannot be beaten by a vote committed while it waits for the row lock', async () => {
  // ⛔ recountVotes is documented as THE general repair primitive for this counter, and it carried
  // the same false rationale the migration header did (see VC10). It is worse off than the
  // migration, though: the migration aborts the whole boot when it loses this race, and
  // recountVotes had nothing at all — it returned "changed 1 row" while leaving shown = 2 against a
  // real 3. Silent, permanent, undetectable, and it is exported and called by the showcase seeder.
  //
  // The fix is a `SELECT … FOR UPDATE` on the target rows inside the same transaction, taken BEFORE
  // the count: while those locks are held no castVote/retractVote transaction can COMMIT a `votes`
  // row (its own counter write blocks behind us), and the counting statement that follows the lock
  // is a NEW statement, so its READ COMMITTED snapshot includes anything that committed while we
  // waited. Both orderings then land on the truth — see the docblock in host/vote-service.ts.
  //
  // REVERT THAT REDS THIS: delete the `.for('update')` pre-lock (or the transaction wrapper around
  // it) from recountVotes → CH1 ends at 2 against three `votes` rows.
  const voter = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
  const probe = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
  try {
    await reset();
    expect(await votesCount('challenges', CH1)).toBe(312);
    await beginHeldVoteOnCh1(voter); // 313 shown / 3 real, uncommitted, row lock held
    const pending = recountVotes(
      'challenge',
      [CH1],
      scratchDb as unknown as Parameters<typeof recountVotes>[2],
    ).then(
      (n) => n,
      (e: unknown) => e,
    );
    await awaitLockWait(probe, 'challenges');
    await voter.unsafe('COMMIT');
    const outcome = await pending;
    expect(
      outcome,
      'recountVotes threw. The chosen mechanism is a pre-lock, not an abort — it is supposed to ' +
        'produce the RIGHT number here, not refuse.',
    ).toBe(1);
    expect(
      await votesCount('challenges', CH1),
      'recountVotes overwrote a legitimate 3 with the count it took before the vote it was ' +
        'blocked behind. Its `votes` row is still there, and no counter in the system reflects it.',
    ).toBe(3);
    // It repaired the cache; it did not touch the record.
    expect(await voteRows()).toHaveLength(10);
  } finally {
    await voter.unsafe('ROLLBACK').catch(() => {});
    await voter.end({ timeout: 5 });
    await probe.end({ timeout: 5 });
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------
// VC7-VC9 — step 3, the frozen artifact.
// ---------------------------------------------------------------------------------------------

test('VC7: step 3 recomputes a SEEDER-written artifact and DROPS the two invented keys', async () => {
  // Without step 3 this migration MANUFACTURES the contradiction it exists to remove: the winner
  // screen prints the live count and the frozen total in the same stat row
  // (winner/+page.svelte:88-89), and marketplace-summary.ts:355 only recomputes when the artifact
  // is EMPTY — which prod's rows are not. So steps 1-2 alone would ship
  // "2 stemmen ontvangen · 1.180 stemmen uitgebracht".
  //
  // The keys are DROPPED, not zeroed: winner/+page.svelte:150-151 guards each tile with `!= null`,
  // so an absent key renders nothing while `0` renders as a measured zero — a fresh false claim.
  // REVERT THAT REDS THIS: delete step 3 (extractor throws), or make it write 0 for the two keys.
  await reset();
  expect(await stats(W1)).toEqual({
    totalVotesCast: 1180,
    solutionsSubmitted: 14,
    firstTimeBuilders: 7,
    crossDomain: 9,
  });
  await runAllSteps();
  // T1 / W23 holds S1(2) + S2(1) + S3(0) + S5(1, and `draft` — periodSolutionStats counts every
  // submission, so the draft is in both keys) after reconciliation.
  expect(await stats(W1)).toEqual({ totalVotesCast: 4, solutionsSubmitted: 4 });
}, 30_000);

test('VC8: step 3 does NOT touch a CLOSE-written artifact, or a derived one', async () => {
  // A close-written artifact is legitimately FROZEN — it says what the week looked like when it
  // was announced. W2 is deliberately STALE (999/42 against a real 1/0), so a widened predicate
  // could not hide behind "it would have written the same thing anyway".
  // REVERT THAT REDS THIS: widen the predicate to `jsonb_exists(stats,'totalVotesCast')` (or drop
  // it entirely) → W2 is rewritten to {1, 0} and its xmin moves.
  await reset();
  const beforeText = await stats(W2);
  const beforeVersion = (await rowVersions('weekly_winners'))[W2];
  await runAllSteps();
  expect(await stats(W2)).toEqual(beforeText!);
  expect((await rowVersions('weekly_winners'))[W2]).toBe(beforeVersion!);
  // A DERIVED winner has no stats at all. It must stay NULL: marketplace-summary recomputes those
  // live at request time, and writing an object here would take that path away forever.
  expect(await stats(W3)).toBeNull();
}, 30_000);

test('VC9: the recomputed artifact equals what periodSolutionStats() would compute', async () => {
  // The artifact and the live recompute must be ONE aggregate. marketplace-summary calls
  // periodSolutionStats when the artifact is empty; closeCycle stamps the same helper. If step 3's
  // SQL transcription drifted from the helper, a page would show different numbers depending on
  // whether the row happened to be empty.
  // REVERT THAT REDS THIS: status-filter step 3's subqueries — `AND s.status <> 'draft'` on all
  // four — or drop its tenant predicate. periodSolutionStats deliberately is not filtered: the close
  // counts every submission, drafts included. S5 is the fixture's one `draft` row and it exists for
  // this revert; without it the fixture held only `shipping` and `voting` rows and the advertised
  // mutation changed nothing at all, leaving this test green while pinning none of what it claims.
  await reset();
  await runAllSteps();
  const live = await periodSolutionStats(
    WEEK,
    T1,
    // The helper takes any drizzle handle; this one is bound to the scratch database rather than
    // the suite's shared pool, which the parameter type (built from `db/client`'s schema) has no
    // way to express.
    scratchDb as unknown as Parameters<typeof periodSolutionStats>[2],
  );
  expect(await stats(W1)).toEqual(live as unknown as Record<string, number>);
  // Not vacuous: the helper really did compute something.
  expect(live.totalVotesCast).toBe(4);
  expect(live.solutionsSubmitted).toBe(4);
}, 30_000);
