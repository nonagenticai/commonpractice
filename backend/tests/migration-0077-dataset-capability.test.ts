// tests/migration-0077-dataset-capability.test.ts — the executing test 0077 did not have.
//
// ⛔ WHY THIS FILE EXISTS. `0077_split_dataset_capability.sql` rewrites persisted descriptors AND
// persisted block source with three UPDATEs, and until now nothing ran a single one of them. Its
// header made three claims that only executed SQL can settle, and an adversarial read found all
// three either false, unstated, or unenforced:
//
//   1. "nothing that ran yesterday stops" (mirrored in exec/flow-executor.ts) CONTRADICTED
//      host/run-policy.ts's "Such a flow is now refused." Both cannot be true. run-policy's is the
//      true one — `enforceRunPolicies` reads the `block_versions.descriptor` COLUMN (via
//      `resolveExecutableBlocks`), which is the column these UPDATEs delete `mockData` from, and
//      that bit is the ENTIRE test for `data.pii_scrubbing`. `PII` below proves the consequence on
//      a real row rather than on a hand-built descriptor: same flow, same blocks, allowed before the
//      migration and refused after it.
//   2. `COALESCE(descriptor->'capabilities','{}')` covers only an ABSENT key. A key present as JSON
//      `null` or a scalar RAISES, and this repo's runner puts every pending file in ONE transaction
//      — so one malformed descriptor does not skip a row, it fails the migration and wedges the pod
//      on every boot retry. `ROBUST` below proves the raise is real and that the added `WHERE`
//      converts it into a skip. A jsonb ARRAY does something worse and is covered separately.
//   3. `NOT LIKE '%ctx.mockData(%'` was documented as proving "no ctx.mockData call at all". It does
//      not: `ctx["mockData"](…)` evades it, and such a block would lose the bit that gates
//      `ctx.mockData()` (which, unlike `ctx.dataset()`, still has exactly one key) and throw
//      `capability_missing_mock_data` at run time. `EVADE` pins the added regex.
//
// ⛔ WHICH CASE IS LOAD-BEARING, PER PREDICATE — SO NOBODY MISTAKES A TALLY FOR A PROOF.
// Every guard below is pinned by a case that reds on the SQL SEMANTICS with every literal string in
// the file left intact. Revert the predicate, keep the text, and this is what goes red:
//
//   predicate removed from 0077                     the case that reds behaviourally
//   ---------------------------------------------   ------------------------------------------------
//   jsonb_typeof(descriptor) = 'object'             ROBUST/skipped  (runner + hand-driven: RAISES)
//   jsonb_typeof(descriptor->'capabilities')='object' ROBUST/skipped (raises on null/scalar;
//                                                     ARRAY row is silently rewritten, no error)
//   source_ts !~ 'mockData[^A-Za-z0-9_]{0,4}\('      ⛔ EVADE        (V_EVADER loses mockData)
//   the WHOLE FILE, through the real runner          ⛔ WEDGE         (_migrations stuck at 73)
//
// A `MUST_CONTAIN` text ratchet also exists, at the BOTTOM of this file, as ONE test. It is a
// supplement. If it is the only thing that reds when you break the migration, the break was
// cosmetic — go and break the semantics instead.
//
// ⛔ SCRATCH DATABASE, REAL RUNNER — the `vote-count-reconciliation.test.ts` idiom. The migration is
// executed against the schema it actually ships against, not a hand-rolled table, so a column rename
// or a later migration that changes `block_versions` reddens this file instead of silently drifting.
// The suite's shared database is never touched.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { buildSnapshot } from '../src/host/policy-store';
import { enforceRunPolicies } from '../src/host/run-policy';
import type { FlowGraph } from '../src/db/flow-types';
import type { BlockDescriptor } from '../src/db/block-types';
import { config } from '../src/config';

const MIGRATION_0077 = join(import.meta.dir, '..', 'migrations', '0077_split_dataset_capability.sql');

/**
 * ⛔ A SUPPLEMENT, AND DELIBERATELY NOT LOAD-BEARING — READ THE HEADER NOTE ABOVE. These needles are
 * asserted by ONE test at the very bottom of this file, and `migrationSql()` does NOT check them.
 * They used to be checked inside `migrationSql()`, which threw before a single statement executed —
 * so reverting the migration reddened all ten cases with the SAME string-grep error and NOT ONE
 * behavioural assertion. That control was a spelling check wearing a behavioural test's tally.
 * Measured: re-adding the four needles as SQL COMMENTS over a reverted body still gave 1 pass /
 * 10 fail. The needles are worth keeping — a silently-deleted predicate should be loud — but they
 * are a ratchet, not the proof.
 */
const MUST_CONTAIN: [string, string][] = [
  [
    "jsonb_typeof(descriptor) = 'object'",
    'the guard that stops `jsonb_set` raising "cannot set path in scalar" on a non-object descriptor',
  ],
  [
    "jsonb_typeof(descriptor -> 'capabilities') = 'object'",
    'the guard that stops `- \'mockData\'` raising on a JSON-null/scalar `capabilities`, and that ' +
      'stops an ARRAY `capabilities` being silently rewritten into `["x",{"dataset":true}]`',
  ],
  [
    "source_ts !~ 'mockData[^A-Za-z0-9_]{0,4}\\('",
    'the tightened NEGATIVE predicate — `ctx["mockData"](…)` evades the LIKE beside it',
  ],
  ['\'{"dataset": true}\'::jsonb', 'the bit the whole migration exists to set'],
];

/** The shipped file, verbatim. No text assertions here — see MUST_CONTAIN's note. */
function migrationSql(): string {
  return readFileSync(MIGRATION_0077, 'utf8');
}

// ---------------------------------------------------------------------------
// Scratch database plumbing (vote-count-reconciliation.test.ts idiom).
// ---------------------------------------------------------------------------

const SCRATCH_DB = 'cp_m0077_dataset_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}

// The OWNER DSN. `building_blocks`/`block_versions` carry RLS policies that scope writes to
// `app_current_tenant_uuid()`, so a global (`tenant_id IS NULL`) fixture is only insertable here.
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');

let scratch: postgres.Sql;

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// Fixture ids are unique to this file — see tests/fixture-id-collisions.test.ts. (They could not
// collide in practice, since this file owns its own database, but the ratchet is static.)
const TENANT = '00000000-0000-4000-8000-000000770001';
const B_LOAD = '00000000-0000-4000-8000-000000770010'; // global 'load-dataset'
const B_MALFORMED = '00000000-0000-4000-8000-000000770011'; // global 'example-claim-data'
const B_DERIVED = '00000000-0000-4000-8000-000000770020'; // tenant, compiler output
const B_BOTH = '00000000-0000-4000-8000-000000770021'; // tenant, genuinely fabricates too
const B_EVADER = '00000000-0000-4000-8000-000000770022'; // tenant, ctx["mockData"](…)
const B_SPACED = '00000000-0000-4000-8000-000000770023'; // tenant, ctx . dataset(…)
const B_ALIAS = '00000000-0000-4000-8000-000000770024'; // tenant, const m = ctx.mockData; m(…)

const V_LOAD = '00000000-0000-4000-8000-0000007700a0';
const V_NULL_CAPS = '00000000-0000-4000-8000-0000007700a1';
const V_SCALAR_CAPS = '00000000-0000-4000-8000-0000007700a2';
const V_ARRAY_CAPS = '00000000-0000-4000-8000-0000007700a3';
const V_NO_CAPS = '00000000-0000-4000-8000-0000007700a4';
const V_SCALAR_DESC = '00000000-0000-4000-8000-0000007700a5';
const V_DERIVED = '00000000-0000-4000-8000-0000007700b0';
const V_BOTH = '00000000-0000-4000-8000-0000007700b1';
const V_EVADER = '00000000-0000-4000-8000-0000007700b2';
const V_SPACED = '00000000-0000-4000-8000-0000007700b3';
const V_ALIAS = '00000000-0000-4000-8000-0000007700b4';

/** The literal both generators bake into `source_ts`, pre-split. Part 3 keys on it exactly. */
const BAKED_MOCK = '"capabilities":{"network":false,"mockData":true}';
const BAKED_DATASET = '"capabilities":{"network":false,"dataset":true}';

/** A compiler-shaped module source: the baked descriptor plus the one `ctx.dataset` call. */
function derivedSource(datasetCall: string, extra = ''): string {
  return (
    `export default {\n  descriptor: {"inputs":{},"outputs":{},${BAKED_MOCK}},\n` +
    `  async run(inputs, ctx) {\n    const raw = await ${datasetCall}"claims");\n` +
    `${extra}    return { rows: raw, count: raw.length };\n  },\n};\n`
  );
}

/**
 * The jsonb TYPE each fixture row must land in the column as. Only `V_SCALAR_DESC` is deliberately
 * not an object — it is the row that proves `jsonb_set` raises before `-` is ever reached.
 */
const EXPECTED_DESCRIPTOR_TYPE: Record<string, string> = {
  [V_LOAD]: 'object',
  [V_NULL_CAPS]: 'object',
  [V_SCALAR_CAPS]: 'object',
  [V_ARRAY_CAPS]: 'object',
  [V_NO_CAPS]: 'object',
  [V_SCALAR_DESC]: 'string',
  [V_DERIVED]: 'object',
  [V_BOTH]: 'object',
  [V_EVADER]: 'object',
  [V_SPACED]: 'object',
  [V_ALIAS]: 'object',
};

async function reset(): Promise<void> {
  await scratch.unsafe('TRUNCATE block_versions, building_blocks RESTART IDENTITY CASCADE');
  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'M0077', 'm0077')
       ON CONFLICT (id) DO NOTHING`,
  );

  const blocks: [string, string, string | null][] = [
    [B_LOAD, 'load-dataset', null],
    [B_MALFORMED, 'example-claim-data', null],
    [B_DERIVED, 'data-m0077-claim', TENANT],
    [B_BOTH, 'data-m0077-both', TENANT],
    [B_EVADER, 'data-m0077-evader', TENANT],
    [B_SPACED, 'data-m0077-spaced', TENANT],
    [B_ALIAS, 'data-m0077-alias', TENANT],
  ];
  for (const [id, slug, tenant] of blocks) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (id, slug, name, category, tenant_id)
       VALUES ('${id}', '${slug}', '${slug}', 'data', ${tenant ? `'${tenant}'` : 'NULL'})`,
    );
  }

  // [version id, block id, version, descriptor jsonb, source_ts]
  const versions: [string, string, string, string, string][] = [
    // --- part 1: the four named GLOBAL slugs ---
    [V_LOAD, B_LOAD, '1.0.0', '{"inputs":{},"outputs":{},"capabilities":{"network":false,"mockData":true}}', `export default { descriptor: {${BAKED_MOCK}}, async run(i, ctx) { return { rows: await ctx.dataset(i.source) }; } };`],
    // --- part 1, the malformed descriptors the COALESCE does NOT cover. Same block, many versions:
    //     part 1 selects by block_id, so every one of these is inside its target set. ---
    [V_NULL_CAPS, B_MALFORMED, '1.0.0', '{"inputs":{},"outputs":{},"capabilities":null}', ''],
    [V_SCALAR_CAPS, B_MALFORMED, '1.0.1', '{"inputs":{},"outputs":{},"capabilities":"mockData"}', ''],
    [V_ARRAY_CAPS, B_MALFORMED, '1.0.2', '{"inputs":{},"outputs":{},"capabilities":["mockData"]}', ''],
    // The case COALESCE genuinely handles — kept so the guard cannot be "skip everything".
    [V_NO_CAPS, B_MALFORMED, '1.0.3', '{"inputs":{},"outputs":{}}', ''],
    // `descriptor` itself non-object → `jsonb_set` is what raises here, before `-` is reached.
    [V_SCALAR_DESC, B_MALFORMED, '1.0.4', '"not an object"', ''],
    // --- part 2: the property match, tenant rows ---
    [V_DERIVED, B_DERIVED, '1.0.0', '{"inputs":{},"outputs":{"rows":{"type":"json"}},"capabilities":{"network":false,"mockData":true}}', derivedSource('ctx.dataset(')],
    [V_BOTH, B_BOTH, '1.0.0', '{"inputs":{},"outputs":{"rows":{"type":"json"}},"capabilities":{"network":false,"mockData":true}}', derivedSource('ctx.dataset(', '    const fake = await ctx.mockData("names");\n')],
    [V_EVADER, B_EVADER, '1.0.0', '{"inputs":{},"outputs":{"rows":{"type":"json"}},"capabilities":{"network":false,"mockData":true}}', derivedSource('ctx.dataset(', '    const fake = await ctx["mockData"]("names");\n')],
    [V_SPACED, B_SPACED, '1.0.0', '{"inputs":{},"outputs":{"rows":{"type":"json"}},"capabilities":{"network":false,"mockData":true}}', derivedSource('ctx . dataset(')],
    // ⚠️ THE ALIAS FORM. `const m = ctx.mockData; await m(...)` — no `mockData` token is ever
    // followed by `(`, so it evades BOTH the `NOT LIKE '%ctx.mockData(%'` and the `!~` beside it.
    [V_ALIAS, B_ALIAS, '1.0.0', '{"inputs":{},"outputs":{"rows":{"type":"json"}},"capabilities":{"network":false,"mockData":true}}', derivedSource('ctx.dataset(', '    const m = ctx.mockData;\n    const fake = await m("names");\n')],
  ];
  for (const [id, blockId, version, descriptor, source] of versions) {
    await scratch.unsafe(
      // ⛔ `$4::text::jsonb`, NEVER `$4::jsonb`, AND THE DIFFERENCE IS THE WHOLE FIXTURE.
      // postgres.js infers a bind parameter's type from the cast written beside it. Given
      // `$4::jsonb` it picks its JSON serialiser and sends `JSON.stringify(descriptorString)` — so
      // the literal `'{"capabilities":null}'` above lands in the column as the jsonb STRING
      // `"{\"capabilities\":null}"`, not as an object. Every row in this fixture then has
      // `jsonb_typeof(descriptor) = 'string'`, `descriptor -> 'capabilities'` is SQL NULL for all of
      // them, and the migration's own `jsonb_typeof(descriptor) = 'object'` guard skips the entire
      // table — so the file goes green on the skip cases and red on the repair cases while proving
      // nothing about either. Routing through `::text` makes postgres.js send the string AS text and
      // lets POSTGRES parse it into jsonb, which is what a real INSERT of a descriptor does.
      // The resulting shape is not taken on trust — it is asserted immediately after this loop.
      `INSERT INTO block_versions (id, block_id, version, descriptor, source_ts)
       VALUES ($1, $2, $3, $4::text::jsonb, $5)`,
      [id, blockId, version, descriptor, source],
    );
  }

  // ⛔ THE FIXTURE ASSERTS ITS OWN SHAPE, BECAUSE THE BUG THIS REPLACES WAS INVISIBLE. A
  // double-encoded descriptor is a jsonb STRING that reads back through `descriptor -> 'capabilities'`
  // as SQL NULL — indistinguishable, in the `capsOf` helper, from a genuine JSON `null`. The WIP
  // commit that shipped this file diagnosed the resulting `capsOf(...) === null` as "the fixture rows
  // are never created"; the rows were created, with the wrong jsonb TYPE. This loop makes that class
  // of fixture defect a named failure instead of a misread symptom.
  const shapes = (await scratch.unsafe(
    `SELECT id::text AS id, jsonb_typeof(descriptor) AS t FROM block_versions ORDER BY id`,
  )) as unknown as { id: string; t: string }[];
  const byId = Object.fromEntries(shapes.map((r) => [r.id, r.t]));
  for (const [id, expected] of Object.entries(EXPECTED_DESCRIPTOR_TYPE)) {
    if (byId[id] !== expected) {
      throw new Error(
        `fixture is mis-encoded: block_versions.${id} has jsonb_typeof(descriptor) = ` +
          `${byId[id]}, expected ${expected}. A '$n::jsonb' bind (rather than '$n::text::jsonb') ` +
          'double-encodes the descriptor into a jsonb string and makes every case below vacuous.',
      );
    }
  }
}

async function runMigration(): Promise<void> {
  await scratch.unsafe(migrationSql());
}

async function capsOf(versionId: string): Promise<unknown> {
  const rows = (await scratch.unsafe(
    `SELECT descriptor -> 'capabilities' AS caps FROM block_versions WHERE id = $1`,
    [versionId],
  )) as unknown as { caps: unknown }[];
  return rows[0]!.caps;
}

async function descriptorOf(versionId: string): Promise<BlockDescriptor> {
  const rows = (await scratch.unsafe(`SELECT descriptor FROM block_versions WHERE id = $1`, [
    versionId,
  ])) as unknown as { descriptor: BlockDescriptor }[];
  return rows[0]!.descriptor;
}

async function sourceOf(versionId: string): Promise<string> {
  const rows = (await scratch.unsafe(`SELECT source_ts FROM block_versions WHERE id = $1`, [
    versionId,
  ])) as unknown as { source_ts: string }[];
  return rows[0]!.source_ts;
}

/** Every row's full persisted state — the VALUE-level idempotence check. */
async function snapshotAll(): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, descriptor::text AS d, source_ts AS s FROM block_versions ORDER BY id`,
  )) as unknown as { id: string; d: string; s: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, `${r.d} ${r.s}`]));
}

/** Row versions — the STATEMENT-level check: did the UPDATE touch the row at all? */
async function rowVersions(): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, xmin::text AS v FROM block_versions ORDER BY id`,
  )) as unknown as { id: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    // FORCE so a connection stranded by a previously-killed run cannot block the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  // The REAL runner: the scratch schema is the schema 0077 ships against — 0077 included, which runs
  // here against an empty database and correctly changes nothing.
  await applyMigrations(SCRATCH_DSN, {
    logger: { log: () => {}, warn: () => {}, error: console.error },
  });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

// ---------------------------------------------------------------------------
// The repair itself — the baseline the rest of the file is measured against.
// ---------------------------------------------------------------------------

test('0077 repairs a named global block and a compiler-derived tenant block', async () => {
  await reset();
  expect(await capsOf(V_LOAD)).toEqual({ network: false, mockData: true });
  expect(await capsOf(V_DERIVED)).toEqual({ network: false, mockData: true });

  await runMigration();

  // Part 1: named slug. Part 2: property match. Both drop the FABRICATION bit and add the ACCESS bit.
  expect(await capsOf(V_LOAD)).toEqual({ network: false, dataset: true });
  expect(await capsOf(V_DERIVED)).toEqual({ network: false, dataset: true });
  // Part 3: the SECOND copy of the same fact, inside the module source.
  expect(await sourceOf(V_DERIVED)).toContain(BAKED_DATASET);
  expect(await sourceOf(V_DERIVED)).not.toContain(BAKED_MOCK);
}, 30_000);

test('0077 leaves a block that genuinely fabricates alone — it keeps its badge', async () => {
  await reset();
  await runMigration();
  // Declares mockData, reads a dataset, AND calls ctx.mockData → `mockData: true` is the honest
  // description. Stripping it here would reintroduce the original defect pointing the other way.
  expect(await capsOf(V_BOTH)).toEqual({ network: false, mockData: true });
  expect(await sourceOf(V_BOTH)).toContain(BAKED_MOCK);
}, 30_000);

// ---------------------------------------------------------------------------
// PROBLEM 3 — the documented evasion, now closed on the half where it is expensive.
// ---------------------------------------------------------------------------

test('⛔ EVADE: `ctx["mockData"](…)` must NOT be treated as "contains no ctx.mockData call"', async () => {
  await reset();

  // RED HALF — the predicate the migration shipped with, run on its own, matches this row. So the
  // guard being asserted below is not a property of the fixture; it is a property of the `!~`.
  const likeOnly = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM block_versions
      WHERE id = $1
        AND source_ts LIKE '%ctx.dataset(%'
        AND source_ts NOT LIKE '%ctx.mockData(%'`,
    [V_EVADER],
  )) as unknown as { n: number }[];
  expect(likeOnly[0]!.n, 'fixture no longer evades the LIKE — the RED half is vacuous').toBe(1);

  await runMigration();

  // ⛔ THE ASSERTION. This block calls ctx.mockData by a spelling the LIKE cannot see. Stripping
  // `mockData` from it removes the ONLY key that opens `ctx.mockData()` in exec/flow-executor.ts
  // (`if (!caps.mockData)` — no second key, unlike the dataset gate), so the block would throw
  // `capability_missing_mock_data` on its next run, in a tenant's database, silently introduced by
  // a migration whose stated purpose was display copy.
  expect(await capsOf(V_EVADER)).toEqual({ network: false, mockData: true });
  expect(await sourceOf(V_EVADER)).toContain(BAKED_MOCK);
}, 30_000);

test('⚠️ KNOWN BOUND: `ctx . dataset(` is not matched, and the miss is fail-SAFE', async () => {
  await reset();
  await runMigration();

  // Recorded in 0077's header as an accepted limitation rather than closed. This test exists so the
  // limitation is a MEASURED fact with a stated direction, not a sentence in a comment: the row is
  // skipped, which means it keeps `mockData: true` — it keeps running (the executor's dataset gate
  // still opens on `mockData`), keeps its pre-migration PII behaviour, and keeps a "Simulated" badge
  // it should not have. Cosmetic defect, unfixed, for a spelling no generator in this repo emits.
  //
  // If someone later tightens the POSITIVE predicate too, this test SHOULD go red — and the right
  // edit is to flip it to `{ network: false, dataset: true }`, not to delete it.
  expect(await capsOf(V_SPACED)).toEqual({ network: false, mockData: true });
}, 30_000);

// ---------------------------------------------------------------------------
// PROBLEM 2 — a malformed `capabilities` must skip, never raise.
// ---------------------------------------------------------------------------

/**
 * ⛔ NEVER `await expect(sql.unsafe(...)).rejects.toThrow(...)` — IT HANGS THE WHOLE TEST PROCESS,
 * FOREVER, AND NOT EVEN THE PER-TEST TIMEOUT INTERRUPTS IT. A postgres.js query is a LAZY thenable:
 * nothing is sent to the server until something calls its `then`. bun's `expect(x).rejects` does not
 * drive it, so the query is never executed, the promise never settles, and `bun test` sits at 0%
 * with no output and no failing test name — measured on bun 1.3.14 / postgres 3.4.7. It is a
 * silent-hang trap rather than a false pass, but it costs a whole run either way.
 *
 * Awaiting inside a `try` forces execution. It also buys a distinction `.rejects.toThrow` does not
 * make: a statement that SUCCEEDS leaves `message` null and fails `toMatch` with "did not raise at
 * all" — which is the case that would matter if a future postgres made one of these shapes legal.
 */
async function expectRaises(sqlText: string, pattern: RegExp): Promise<void> {
  let message: string | null = null;
  try {
    await scratch.unsafe(sqlText);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message, `this statement did not raise at all: ${sqlText}`).toMatch(pattern);
}

test('⛔ ROBUST: the unguarded expression really does raise (the RED half)', async () => {
  // Without this, "the migration did not raise" proves nothing — it would pass on a migration that
  // was never capable of raising. This is the exact sub-expression 0077 uses, minus the WHERE.
  await expectRaises(
    `SELECT ((COALESCE('{"capabilities":null}'::jsonb -> 'capabilities', '{}'::jsonb)) - 'mockData')`,
    /cannot delete from scalar/i,
  );
  await expectRaises(
    `SELECT ((COALESCE('{"capabilities":"x"}'::jsonb -> 'capabilities', '{}'::jsonb)) - 'mockData')`,
    /cannot delete from scalar/i,
  );
  await expectRaises(
    `SELECT jsonb_set('"scalar"'::jsonb, '{capabilities}', '{}'::jsonb, true)`,
    /cannot set path in scalar/i,
  );
  // ⚠️ A NON-OBJECT `descriptor` HAS TWO FAILURE MESSAGES, NOT ONE. An ARRAY does not say "cannot
  // set path in scalar" — it complains about the path element instead. Both are equally fatal, which
  // is why the guard is a positive `jsonb_typeof(descriptor) = 'object'` test and not a list of
  // shapes someone remembered to exclude.
  await expectRaises(
    `SELECT jsonb_set('[1,2]'::jsonb, '{capabilities}', '{}'::jsonb, true)`,
    /path element at position 1 is not an integer/i,
  );

  // ⚠️ AND THE ONE THAT DOES NOT RAISE, WHICH IS WHY THE GUARD IS A POSITIVE `= 'object'` TEST.
  // `jsonb - text` is defined on an ARRAY (it removes matching string elements) and `array || object`
  // appends, so a `capabilities` of `["mockData"]` is silently rewritten to `[{"dataset": true}]`
  // with no error at all. "The statement must not raise" would have accepted that.
  const quiet = (await scratch.unsafe(
    `SELECT (('["mockData"]'::jsonb) - 'mockData') || '{"dataset": true}'::jsonb AS out`,
  )) as unknown as { out: unknown }[];
  expect(quiet[0]!.out).toEqual([{ dataset: true }]);
}, 30_000);

test('⛔ ROBUST: a malformed `capabilities` is SKIPPED — the migration completes and the pod boots', async () => {
  await reset();
  const before = await snapshotAll();

  // ⛔ THE WHOLE FILE IN ONE BATCH, WHICH IS THE POINT. `runMigrations` applies every pending file
  // inside ONE `sql.begin()`; a raise anywhere takes the entire migration transaction down, and
  // because the cause is data-deterministic it recurs on every boot. So the assertion is not "these
  // rows were skipped" — it is "the statement that repairs the GOOD rows still ran".
  await runMigration();

  // Malformed rows: untouched, byte for byte.
  for (const id of [V_NULL_CAPS, V_SCALAR_CAPS, V_ARRAY_CAPS, V_SCALAR_DESC]) {
    expect(await snapshotOne(id), `row ${id} was rewritten instead of skipped`).toBe(before[id]!);
  }
  // ⚠️ NON-VACUITY, AND IT IS THE ASSERTION THAT MATTERS. A guard of `WHERE false` would satisfy
  // every line above. These two rows sit in the SAME statement's target set as the malformed ones —
  // `V_NO_CAPS` shares a block_id with them — and they were repaired anyway.
  expect(await capsOf(V_NO_CAPS)).toEqual({ dataset: true }); // the absent-key case COALESCE covers
  expect(await capsOf(V_LOAD)).toEqual({ network: false, dataset: true });
}, 30_000);

async function snapshotOne(id: string): Promise<string> {
  return (await snapshotAll())[id]!;
}

// ---------------------------------------------------------------------------
// IDEMPOTENCE — preserved, and stated precisely enough to be useful.
// ---------------------------------------------------------------------------

test('⛔ IDEMPOTENT: re-applying 0077 changes no persisted VALUE', async () => {
  await reset();
  await runMigration();
  const afterFirst = await snapshotAll();

  await runMigration();
  expect(await snapshotAll()).toEqual(afterFirst);
  await runMigration();
  expect(await snapshotAll()).toEqual(afterFirst);
}, 30_000);

test('IDEMPOTENT, precisely: parts 2+3 re-select ZERO rows; part 1 rewrites the same value', async () => {
  await reset();
  await runMigration();
  const v1 = await rowVersions();
  await runMigration();
  const v2 = await rowVersions();

  // ⚠️ THE HONEST VERSION OF "rows_changed_on_second_apply = 0". Parts 2 and 3 re-test the very bit
  // they changed (`->>'mockData' = 'true'`, `LIKE '%…mockData":true%'`), so they select nothing the
  // second time and the row is not touched at all.
  for (const id of [V_DERIVED, V_BOTH, V_EVADER, V_SPACED]) {
    expect(v2[id], `part 2/3 re-touched row ${id} on a second apply`).toBe(v1[id]!);
  }
  // Part 1 keys on the SLUG only, so it re-selects its rows forever and writes the identical jsonb
  // back — a no-op WRITE, not a no-op STATEMENT. Data-idempotent (the test above), not
  // xmin-idempotent. Recorded rather than "fixed": adding an `IS DISTINCT FROM` guard would mean
  // duplicating the whole `jsonb_set` expression in the WHERE, and the write is four rows on a
  // migration that runs once.
  expect(v2[V_LOAD], 'part 1 unexpectedly stopped re-selecting — check its WHERE').not.toBe(v1[V_LOAD]!);
  // The skipped rows are skipped on every apply, which is what makes the guard a filter rather than
  // a one-shot repair.
  for (const id of [V_NULL_CAPS, V_SCALAR_CAPS, V_ARRAY_CAPS, V_SCALAR_DESC]) {
    expect(v2[id], `a guarded row was touched on the second apply`).toBe(v1[id]!);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// PROBLEM 1 — the contradiction, settled against real rows.
// ---------------------------------------------------------------------------

/** `data.pii_scrubbing` ON, everything else default. Shape copied from policy-enforcement.test.ts. */
function piiOnSnapshot() {
  return buildSnapshot([
    {
      key: 'data.pii_scrubbing', category: 'd', label: '', description: '', control: 'toggle',
      value: true, options: null, unit: null, enabled: true, sort: 0, updated_by: null,
      updated_at: new Date(),
    },
  ] as Parameters<typeof buildSnapshot>[0]);
}

/** producer(`v-src`) → consumer whose input `record` is `pii: true`. */
function piiGraph(): FlowGraph {
  return {
    nodes: [
      { id: 'p', blockId: B_DERIVED, blockVersionId: V_DERIVED, slug: 'claims-data', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } },
      { id: 'c', blockId: B_BOTH, blockVersionId: 'v-consumer', slug: 'mask-claimant', label: '', category: 'data', config: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'e', source: 'p', sourceHandle: 'rows', target: 'c', targetHandle: 'record' }],
  } as FlowGraph;
}

const CONSUMER: BlockDescriptor = {
  inputs: { record: { type: 'json', pii: true } },
  outputs: {},
  capabilities: {},
};

test('⛔ PROBLEM 1 — 0077 IS what flips a real flow from allowed to policy_pii_violation', async () => {
  await reset();

  // ⛔ THE DESCRIPTOR IS READ OUT OF THE DATABASE, NOT HAND-BUILT, AND THAT IS THE WHOLE POINT.
  // `tests/policy-enforcement.test.ts` already pins that a `{dataset:true}` producer is refused —
  // but it constructs that descriptor by hand, so it proves a rule about a shape, not that any real
  // row ever ACQUIRES that shape. `enforceRunPolicies`' two callers build `descriptorsById` from
  // `resolveExecutableBlocks`, which selects the `block_versions.descriptor` COLUMN — the column
  // these UPDATEs rewrite. This test closes that gap by running the migration in between.
  const snap = piiOnSnapshot();
  const graph = piiGraph();

  const beforeDesc = await descriptorOf(V_DERIVED);
  expect(beforeDesc.capabilities).toEqual({ network: false, mockData: true });
  const allowed = enforceRunPolicies(
    graph,
    new Map<string, BlockDescriptor>([[V_DERIVED, beforeDesc], ['v-consumer', CONSUMER]]),
    snap,
  );
  // YESTERDAY: allowed. The `mockData` bit this block only ever declared to pass the executor's
  // dataset gate also bought it a free pass through `data.pii_scrubbing`.
  expect(allowed, 'the pre-migration row was already refused — the fixture proves nothing').toBeNull();

  await runMigration();

  const afterDesc = await descriptorOf(V_DERIVED);
  expect(afterDesc.capabilities).toEqual({ network: false, dataset: true });
  const refused = enforceRunPolicies(
    graph,
    new Map<string, BlockDescriptor>([[V_DERIVED, afterDesc], ['v-consumer', CONSUMER]]),
    snap,
  );

  // ⛔ TODAY: refused. Same flow, same blocks, same rows, same policy — only the migration ran.
  // This is the sentence `host/run-policy.ts` claims and the one `exec/flow-executor.ts` used to
  // deny ("nothing that ran yesterday stops"). run-policy is the true one; the executor comment now
  // says so and names this exact condition.
  expect(refused?.code).toBe('policy_pii_violation');
  expect(refused?.policyKey).toBe('data.pii_scrubbing');
  // Named offender, not "a block in this flow" — the consumer is the node that trips it.
  expect(refused?.nodeSlug).toBe('mask-claimant');

  // ⚠️ AND IT IS DECIDED, NOT ACCIDENTAL. Widening run-policy to `mockData || dataset` — the obvious
  // fix the first time a customer flow breaks — would make this expectation `toBeNull()` and would
  // make `data.pii_scrubbing` unfalsifiable for every dataset-reading block while the Governance
  // screen still classifies it 'enforced'. The argument for and against is in run-policy.ts; this
  // assertion is what makes reversing it a deliberate act.
}, 30_000);

test('⚠️ pii_scrubbing OFF: the same post-migration flow runs — the refusal is the POLICY, not 0077', async () => {
  await reset();
  await runMigration();
  const snapOff = buildSnapshot([
    {
      key: 'data.pii_scrubbing', category: 'd', label: '', description: '', control: 'toggle',
      value: false, options: null, unit: null, enabled: true, sort: 0, updated_by: null,
      updated_at: new Date(),
    },
  ] as Parameters<typeof buildSnapshot>[0]);
  const desc = await descriptorOf(V_DERIVED);
  expect(
    enforceRunPolicies(
      piiGraph(),
      new Map<string, BlockDescriptor>([[V_DERIVED, desc], ['v-consumer', CONSUMER]]),
      snapOff,
    ),
  ).toBeNull();
}, 30_000);

test('⚠️ the change is LATENT: with no `pii` input, a repaired block is unaffected', async () => {
  await reset();
  await runMigration();
  const desc = await descriptorOf(V_DERIVED);
  // The measured reason this is an honesty problem and not an outage: nothing seeded marks an input
  // `pii: true`, so today the repaired descriptor changes no run's outcome. It is the NEXT tenant to
  // mark an ontology attribute PII (data-block-compiler.ts copies `pii` straight onto its output
  // ports) that meets the refusal above.
  const noPiiConsumer: BlockDescriptor = { inputs: { record: { type: 'json' } }, outputs: {}, capabilities: {} };
  expect(
    enforceRunPolicies(
      piiGraph(),
      new Map<string, BlockDescriptor>([[V_DERIVED, desc], ['v-consumer', noPiiConsumer]]),
      piiOnSnapshot(),
    ),
  ).toBeNull();
}, 30_000);

// ---------------------------------------------------------------------------
// BOUNDS — recorded as executing cases, because a bound nothing asserts is a bound that widens.
// ---------------------------------------------------------------------------

test('⚠️ KNOWN BOUND: the ALIAS form evades the regex, and that is a REAL cost, not a cosmetic one', async () => {
  await reset();

  // RED HALF — the fixture really does evade both negative predicates. Without this the assertion
  // below would pass on a row that never had the alias spelling in it at all.
  const evades = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM block_versions
      WHERE id = $1
        AND source_ts LIKE '%ctx.dataset(%'
        AND source_ts NOT LIKE '%ctx.mockData(%'
        AND source_ts !~ 'mockData[^A-Za-z0-9_]{0,4}\\('`,
    [V_ALIAS],
  )) as unknown as { n: number }[];
  expect(evades[0]!.n, 'the alias fixture no longer evades — this case is vacuous').toBe(1);
  // …and it genuinely calls ctx.mockData, so the row IS a fabricator.
  expect(await sourceOf(V_ALIAS)).toContain('const m = ctx.mockData;');

  await runMigration();

  // ⛔ THE BOUND, STATED AS AN OUTCOME RATHER THAN A SENTENCE IN A COMMENT. Part 2 matches this row
  // — it reads a dataset and no negative predicate sees the call — so it is STRIPPED of `mockData`.
  // That is NOT fail-safe the way the `ctx . dataset(` bound is: `ctx.mockData()` is gated on
  // `caps.mockData` ALONE in flow-executor.ts (no second key, unlike the dataset gate), so this
  // block throws `capability_missing_mock_data` the next time it runs.
  expect(
    await capsOf(V_ALIAS),
    'the alias row is no longer stripped — if the regex was tightened to catch `const m = ' +
      'ctx.mockData`, that is an IMPROVEMENT: flip this to { network: false, mockData: true } ' +
      'and delete the bound from 0077 header. Do not delete this case.',
  ).toEqual({ network: false, dataset: true });

  // ⛔ WHY IT IS ACCEPTED RATHER THAN CHASED, AND THE NUMBER THAT MAKES IT ACCEPTABLE. A rename
  // cannot be caught by text at all (`const m = ctx.mockData` is arbitrarily spellable), so closing
  // this needs a TS parse of every stored module — a different and much larger change than a
  // migration predicate. It is PRE-EXISTING: the unhardened 0077 strips this row too, so the
  // hardening did not widen it. And both generators that produce these rows (seed-datasets.ts,
  // ontology/data-block-compiler.ts) emit `await ctx.mockData(` literally — this is a text match on
  // GENERATED source. The measured population is what settles it: ZERO stored rows match.
  const wild = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM block_versions
      WHERE source_ts LIKE '%= ctx.mockData%' AND source_ts !~ 'mockData[^A-Za-z0-9_]{0,4}\\('`,
  )) as unknown as { n: number }[];
  expect(wild[0]!.n, 'a real alias-form block now exists — the bound stopped being theoretical').toBe(1);
}, 30_000);

// ---------------------------------------------------------------------------
// THE TEXT RATCHET — ONE case, at the bottom, and NOT load-bearing. See MUST_CONTAIN's note.
// ---------------------------------------------------------------------------

test('the four guard predicates are still spelled in 0077 (ratchet, NOT the behavioural proof)', () => {
  const text = migrationSql();
  for (const [needle, why] of MUST_CONTAIN) {
    expect(
      text.includes(needle),
      `0077 no longer contains ${JSON.stringify(needle)} — ${why}. This case is a RATCHET: if it ` +
        'is the ONLY thing that went red, the change was cosmetic and the behavioural cases above ' +
        'still pass. Removing a predicate deliberately means updating the case that covers it, ' +
        'named in the table at the top of this file.',
    ).toBe(true);
  }
});
