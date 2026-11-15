// tests/migration-0078-review-panel-mock-data.test.ts — 0078 executed, against the OLD row.
//
// ⛔ WHY THIS FILE EXISTS, AND WHAT IT IS NOT. `db/seed.ts`'s repaired literal reaches ONLY a
// database where the `review-panel` row does not exist yet — `upsertGlobalBlock` skips a slug that
// is already there, and production never seeds at all (`server.ts:108-116` gates on
// `SEED_DEMO_DATA`, which prod runs false). So `tests/review-panel-runs.test.ts`, which drives the
// seed literal through the real executor, proves the FRESH-DATABASE half and says nothing whatever
// about the databases that already hold the broken row. This file is the other half: it plants the
// PRE-repair row, runs the shipped SQL, and asserts on what the row becomes.
//
// ⛔ AND IT ASSERTS BEHAVIOUR, NOT SPELLING. The centre of this file is `0078 makes the persisted
// source RUN` — it takes the `source_ts` the migration produced, hands it to the REAL `loadBlock`
// and the REAL `executeFlow`, and asserts the node reaches `node_success` where the pre-migration
// source reaches `node_error` / `capability_missing_mock_data`. A `toContain('mockData')` over the
// column would pass on a source that still throws (the descriptor is baked into the module text in
// a spelling the transpiler has to agree with), and it would pass on a migration that repaired the
// wrong table. There is no text ratchet in this file at all.
//
// ⛔ WHICH CASE IS LOAD-BEARING, PER PREDICATE — so nobody mistakes a tally for a proof. Remove the
// predicate, keep every literal string in 0078 intact, and this is what goes red:
//
//   changed in 0078_review_panel_mock_data.sql        the case that reds behaviourally
//   ------------------------------------------------  ---------------------------------------------
//   part 2 (the `source_ts` replace) deleted          ⛔ RUNS      (node_error, capability_missing…)
//   part 1 (the `descriptor` jsonb) deleted           ⛔ BADGE     (mock_data bit still absent)
//   `block_id IN (… slug = 'review-panel')` on part 2  ⛔ SCOPE     (if-else gains mockData)
//   `tenant_id IS NULL`                                ⛔ SCOPE     (a tenant's own block rewritten)
//   `jsonb_typeof(...) = 'object'` guards              ⛔ ROBUST    (migration RAISES → pod wedge)
//
// ⛔ SCRATCH DATABASE, REAL RUNNER — the migration-0077 idiom. `applyMigrations` builds the schema
// 0078 actually ships against (0078 included, running here against an empty table and correctly
// changing nothing), so a later migration that renames `block_versions.source_ts` reddens this file
// instead of letting it drift. The suite's shared database is never touched.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { executeFlow, type ExecDeps } from '../src/exec/flow-executor';
import { loadBlock } from '../src/exec/block-loader';
import { mockData } from '../src/exec/mock-data';
import type { FlowGraph } from '../src/db/flow-types';
import type { TraceEvent } from '../src/db/trace-types';
import { config } from '../src/config';

const MIGRATION_0078 = join(
  import.meta.dir,
  '..',
  'migrations',
  '0078_review_panel_mock_data.sql',
);

function migrationSql(): string {
  return readFileSync(MIGRATION_0078, 'utf8');
}

// ---------------------------------------------------------------------------
// Scratch database plumbing (migration-0077-dataset-capability.test.ts idiom).
// ---------------------------------------------------------------------------

const SCRATCH_DB = 'cp_m0078_review_panel_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}

// The OWNER DSN. `building_blocks`/`block_versions` carry RLS policies scoped to
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

// Fixture ids unique to this file — see tests/fixture-id-collisions.test.ts.
const TENANT = '00000000-0000-4000-8000-000000780101';
const B_GLOBAL = '00000000-0000-4000-8000-000000780110'; // global 'review-panel' — the target
const B_TENANT = '00000000-0000-4000-8000-000000780111'; // a TENANT block that also calls itself that
const B_SIBLING = '00000000-0000-4000-8000-000000780112'; // global 'if-else' — same source literal

const V_CURRENT = '00000000-0000-4000-8000-0000007801a0';
const V_OLD = '00000000-0000-4000-8000-0000007801a1'; // a NON-current version of the same block
const V_TENANT = '00000000-0000-4000-8000-0000007801a2';
const V_SIBLING = '00000000-0000-4000-8000-0000007801a3';
const V_NULL_CAPS = '00000000-0000-4000-8000-0000007801a4';
const V_ARRAY_CAPS = '00000000-0000-4000-8000-0000007801a5';
const V_SCALAR_DESC = '00000000-0000-4000-8000-0000007801a6';

/** The descriptor `db/seed.ts` shipped, pre-repair — no `mockData`. */
const OLD_DESCRIPTOR =
  '{"inputs":{"item":{"type":"json","required":true}},' +
  '"outputs":{"decision":{"type":"enum","enum":["accept","edit","reject"]},"edited":{"type":"json"}},' +
  '"capabilities":{"network":false}}';

/** The literal the seed's `src()` template bakes in — hand-written, spaces and all. */
const OLD_CAPS_LINE = 'capabilities: { network: false },';
const NEW_CAPS_LINE = 'capabilities: { network: false, mockData: true },';

/**
 * `review-panel`'s module source, verbatim from `db/seed.ts`'s `src()` output, with the
 * `capabilities` line as a parameter so the same function produces the pre- and post-repair text.
 */
function reviewPanelSource(capsLine: string): string {
  return (
    'export default {\n' +
    '  descriptor: {\n' +
    '    inputs: { item: { type: "json", required: true } },\n' +
    '    outputs: { decision: { type: "enum", enum: ["accept", "edit", "reject"] }, edited: { type: "json" } },\n' +
    `    ${capsLine}\n` +
    '  },\n' +
    '  async run(inputs, ctx) {\n' +
    '    const decision = await ctx.mockData("review_decision", { item: inputs.item });\n' +
    '    return { decision: decision.kind, edited: decision.edited ?? inputs.item };\n' +
    '  }\n' +
    '};\n'
  );
}

/** A pure sibling block whose source carries the IDENTICAL `capabilities` literal — `if-else`. */
const SIBLING_SOURCE =
  'export default {\n' +
  '  descriptor: {\n' +
  '    inputs: { condition: { type: "boolean", required: true } },\n' +
  '    outputs: { result: { type: "json" } },\n' +
  `    ${OLD_CAPS_LINE}\n` +
  '  },\n' +
  '  async run(inputs) { return { result: inputs.condition }; }\n' +
  '};\n';

/**
 * ⛔ THE FIXTURE ASSERTS ITS OWN jsonb SHAPE — 0077's lesson, inherited verbatim. postgres.js infers
 * a bind parameter's type from the cast beside it: given `$n::jsonb` it JSON-encodes the STRING, so
 * `'{"capabilities":null}'` lands as a jsonb string, `descriptor -> 'capabilities'` reads back SQL
 * NULL for every row, and 0078's own `jsonb_typeof(descriptor) = 'object'` guard then skips the
 * entire table — green on the skip cases, green-because-vacuous on the repair cases.
 * `$n::text::jsonb` makes POSTGRES do the parse, which is what a real INSERT does.
 */
const EXPECTED_DESCRIPTOR_TYPE: Record<string, string> = {
  [V_CURRENT]: 'object',
  [V_OLD]: 'object',
  [V_TENANT]: 'object',
  [V_SIBLING]: 'object',
  [V_NULL_CAPS]: 'object',
  [V_ARRAY_CAPS]: 'object',
  [V_SCALAR_DESC]: 'string',
};

async function reset(): Promise<void> {
  await scratch.unsafe('TRUNCATE block_versions, building_blocks RESTART IDENTITY CASCADE');
  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'M0078', 'm0078')
       ON CONFLICT (id) DO NOTHING`,
  );

  // ⚠️ `building_blocks_slug_owner_uq` (migration 0037) keys on
  // (slug, coalesce(tenant_id, zero-uuid)), so a global and a tenant `review-panel` coexist — which
  // is exactly the collision `tenant_id IS NULL` in 0078 has to survive. There is therefore no
  // SECOND global `review-panel` to hang the malformed versions off; they hang off `B_GLOBAL`,
  // where part 1 selects them by `block_id` and so has them inside its target set anyway.
  const blocks: [string, string, string, string | null][] = [
    [B_GLOBAL, 'review-panel', 'output', null],
    [B_TENANT, 'review-panel', 'output', TENANT],
    [B_SIBLING, 'if-else', 'logic', null],
  ];
  for (const [id, slug, category, tenant] of blocks) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (id, slug, name, category, tenant_id)
       VALUES ('${id}', '${slug}', '${slug}', '${category}', ${tenant ? `'${tenant}'` : 'NULL'})`,
    );
  }

  // [version id, block id, version, descriptor jsonb text, source_ts]
  const versions: [string, string, string, string, string][] = [
    [V_CURRENT, B_GLOBAL, '1.0.0', OLD_DESCRIPTOR, reviewPanelSource(OLD_CAPS_LINE)],
    // ⚠️ A NON-CURRENT version of the same block. `current_version_id` is left NULL here on purpose:
    // 0078 keys on `block_id`, and the version picker serves any row, so a statement that keyed on
    // the current version would leave a version that still throws one click away.
    [V_OLD, B_GLOBAL, '0.9.0', OLD_DESCRIPTOR, reviewPanelSource(OLD_CAPS_LINE)],
    [V_TENANT, B_TENANT, '1.0.0', OLD_DESCRIPTOR, reviewPanelSource(OLD_CAPS_LINE)],
    [V_SIBLING, B_SIBLING, '1.0.0', '{"inputs":{},"outputs":{},"capabilities":{"network":false}}', SIBLING_SOURCE],
    // --- the malformed descriptors, all on B_GLOBAL so part 1's block_id subquery selects them ---
    [V_NULL_CAPS, B_GLOBAL, '0.8.0', '{"inputs":{},"outputs":{},"capabilities":null}', ''],
    // ⚠️ THE ARRAY ROW IS THE ONE TO READ TWICE. `array || object` does NOT raise — it appends,
    // producing `["mockData",{"mockData":true}]` — so a guard aimed only at "must not raise" lets
    // this through as SILENT CORRUPTION. 0078's positive `= 'object'` test is what stops it.
    [V_ARRAY_CAPS, B_GLOBAL, '0.7.0', '{"inputs":{},"outputs":{},"capabilities":["mockData"]}', ''],
    // `descriptor` itself non-object → `jsonb_set` raises before `||` is reached.
    [V_SCALAR_DESC, B_GLOBAL, '0.6.0', '"not an object"', ''],
  ];
  for (const [id, blockId, version, descriptor, source] of versions) {
    await scratch.unsafe(
      `INSERT INTO block_versions (id, block_id, version, descriptor, source_ts)
       VALUES ($1, $2, $3, $4::text::jsonb, $5)`,
      [id, blockId, version, descriptor, source],
    );
  }

  const shapes = (await scratch.unsafe(
    `SELECT id::text AS id, jsonb_typeof(descriptor) AS t FROM block_versions ORDER BY id`,
  )) as unknown as { id: string; t: string }[];
  const byId = Object.fromEntries(shapes.map((r) => [r.id, r.t]));
  for (const [id, expected] of Object.entries(EXPECTED_DESCRIPTOR_TYPE)) {
    if (byId[id] !== expected) {
      throw new Error(
        `fixture is mis-encoded: block_versions.${id} has jsonb_typeof(descriptor) = ${byId[id]}, ` +
          `expected ${expected}. A '$n::jsonb' bind (rather than '$n::text::jsonb') double-encodes ` +
          'the descriptor into a jsonb string and makes every case below vacuous.',
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
  return Object.fromEntries(rows.map((r) => [r.id, `${r.d} ${r.s}`]));
}

/** Row versions — the STATEMENT-level check: did an UPDATE touch the row at all? */
async function rowVersions(): Promise<Record<string, string>> {
  const rows = (await scratch.unsafe(
    `SELECT id::text AS id, xmin::text AS v FROM block_versions ORDER BY id`,
  )) as unknown as { id: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

// ---------------------------------------------------------------------------
// Running the PERSISTED source, which is the whole point of part 2.
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

async function tmpScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cp-m0078-'));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Execute a stored `source_ts` through the real loader + real executor + real mockData, and return
 * the trace. `versionId` is passed through to `loadBlock`, but the CACHE is keyed on a hash of the
 * source, so pre- and post-migration text cannot collide.
 */
async function runStoredSource(versionId: string, source: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  let clock = 0;
  const deps: ExecDeps = {
    loadBlock,
    llm: async () => {
      throw new Error('review-panel must not call ctx.llm');
    },
    mockData: (kind, opts) => mockData(kind, opts ?? {}),
    dataset: () => {
      throw new Error('review-panel must not call ctx.dataset');
    },
    emit: (ev) => events.push(ev),
    now: () => clock++,
  };
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'rp1',
        blockId: B_GLOBAL,
        blockVersionId: versionId,
        slug: 'review-panel',
        label: 'Review panel',
        category: 'output',
        config: { item: { claim: 'CLM-2001' } },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
  await executeFlow(
    graph,
    new Map([[versionId, source]]),
    '00000000-0000-4000-8000-000000780900',
    await tmpScratch(),
    deps,
    { maxNodeMs: 5000 },
  );
  return events;
}

function errorRules(events: TraceEvent[]): string[] {
  return events
    .filter((e) => e.type === 'node_error')
    .map((e) => ('rule' in e ? String(e.rule) : 'no-rule'));
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    // FORCE so a connection stranded by a previously-killed run cannot block the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  await applyMigrations(SCRATCH_DSN, {
    logger: { log: () => {}, warn: () => {}, error: console.error },
  });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

// ---------------------------------------------------------------------------
// ⛔ RUNS — the behavioural centre. Part 2 of the migration, measured by execution.
// ---------------------------------------------------------------------------

test('⛔ 0078 makes the persisted review-panel source RUN, where it threw before', async () => {
  await reset();

  // THE DEFECT, on the row as it stands in an existing database. This is the negative control and
  // it is executed, not described.
  const before = await runStoredSource(V_CURRENT, await sourceOf(V_CURRENT));
  expect(errorRules(before)).toEqual(['capability_missing_mock_data']);

  await runMigration();

  const after = await runStoredSource(V_CURRENT, await sourceOf(V_CURRENT));
  const rules = errorRules(after);
  expect(
    rules,
    rules.length
      ? `the migrated source still errors (${JSON.stringify(rules)}). Part 2 rewrites the ` +
          `descriptor baked into source_ts — the executor gates ctx.mockData on the MODULE's ` +
          `descriptor, never on the descriptor column part 1 repairs.`
      : undefined,
  ).toEqual([]);
  expect(after.filter((e) => e.type === 'node_success')).toHaveLength(1);

  // NON-VACUITY: "no node_error" is also true of a run that never reached the node.
  const complete = after.find((e) => e.type === 'run_complete');
  expect(complete && 'status' in complete ? complete.status : undefined).toBe('ok');
}, 60_000);

// ---------------------------------------------------------------------------
// ⛔ BADGE — part 1. The descriptor COLUMN is what /blocks and run-policy read.
// ---------------------------------------------------------------------------

test('⛔ 0078 repairs the descriptor column, on EVERY version, preserving what was there', async () => {
  await reset();
  expect(await capsOf(V_CURRENT)).toEqual({ network: false });
  expect(await capsOf(V_OLD)).toEqual({ network: false });

  await runMigration();

  // `network: false` survives — this is a merge, not an overwrite. `mockData: true` is the bit
  // `routes/blocks.ts` projects as `mock_data` for the "Simulated" badge and `host/run-policy.ts`
  // reads as the whole `data.pii_scrubbing` taint-by-source test.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false, mockData: true });
  // ⚠️ the NON-current version too — the version picker serves any row.
  expect(await capsOf(V_OLD)).toEqual({ network: false, mockData: true });
}, 60_000);

// ---------------------------------------------------------------------------
// ⛔ SCOPE — the two ways this migration could reach a row it has no business rewriting.
// ---------------------------------------------------------------------------

test('⛔ 0078 does not touch a sibling global block carrying the identical source literal', async () => {
  await reset();
  const beforeCaps = await capsOf(V_SIBLING);
  const beforeSource = await sourceOf(V_SIBLING);
  const beforeVersions = await rowVersions();
  // NON-VACUITY: the case only means something if the sibling really does carry the literal part 2
  // keys on. `if-else`, `format-output` and most pure seeded blocks do.
  expect(beforeSource).toContain(OLD_CAPS_LINE);

  await runMigration();

  expect(await capsOf(V_SIBLING)).toEqual(beforeCaps);
  expect(await sourceOf(V_SIBLING)).toBe(beforeSource);
  expect(await sourceOf(V_SIBLING)).not.toContain(NEW_CAPS_LINE);
  // …and the row was not so much as rewritten with an identical value: `xmin` is the
  // STATEMENT-level check a value comparison cannot make.
  expect((await rowVersions())[V_SIBLING]).toBe(beforeVersions[V_SIBLING]!);
}, 60_000);

test('⛔ 0078 does not touch a TENANT block that happens to share the slug', async () => {
  await reset();
  const beforeSource = await sourceOf(V_TENANT);
  await runMigration();

  // A tenant row under this slug is that tenant's own code under a colliding name — 0037 made slugs
  // unique per owner precisely so that can happen — not a copy of ours to repair.
  expect(await capsOf(V_TENANT)).toEqual({ network: false });
  expect(await sourceOf(V_TENANT)).toBe(beforeSource);

  // NON-VACUITY: the global row in the SAME statement's target set WAS repaired, so a `WHERE false`
  // guard cannot satisfy this file.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false, mockData: true });
}, 60_000);

// ---------------------------------------------------------------------------
// ⛔ ROBUST — a malformed descriptor must SKIP, never RAISE. `runMigrations` puts every pending
// file in ONE transaction, so a raise here is not a skipped row, it is a deterministic boot wedge.
// ---------------------------------------------------------------------------

test('⛔ 0078 skips malformed descriptors instead of raising, and still repairs the good row', async () => {
  await reset();
  const before = await snapshotAll();

  // The whole file must COMPLETE over a table containing all three malformed shapes.
  await runMigration();

  const after = await snapshotAll();
  for (const id of [V_NULL_CAPS, V_ARRAY_CAPS, V_SCALAR_DESC]) {
    expect(after[id], `${id} must be byte-identical after 0078`).toBe(before[id]!);
  }
  // ⚠️ specifically: the ARRAY row was NOT appended to. `["mockData"] || {"mockData":true}` yields
  // `["mockData",{"mockData":true}]` WITHOUT any error, which no "must not raise" guard would catch.
  expect(await capsOf(V_ARRAY_CAPS)).toEqual(['mockData']);

  // NON-VACUITY, and the half a `WHERE false` would fail: a good row in the same target set was
  // still repaired.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false, mockData: true });
}, 60_000);

test('⛔ 0078 raises without its jsonb_typeof guards — the guards are what make the skip a skip', async () => {
  await reset();
  // The same statement with the two `jsonb_typeof` predicates removed. This is the shape 0078 would
  // have had if the guards were treated as defensive noise; it must be shown to be fatal, or
  // "0078 skips malformed descriptors" is a claim about a migration that could not fail anyway.
  const unguarded = `
    UPDATE block_versions
    SET descriptor = jsonb_set(
          descriptor, '{capabilities}',
          (COALESCE(descriptor -> 'capabilities', '{}'::jsonb)) || '{"mockData": true}'::jsonb, true)
    WHERE block_id IN (SELECT id FROM building_blocks WHERE tenant_id IS NULL AND slug = 'review-panel')`;
  let raised: string | null = null;
  try {
    await scratch.unsafe(unguarded);
  } catch (err) {
    raised = String((err as Error).message);
  }
  expect(raised, 'the unguarded statement must RAISE — otherwise the guards guard nothing').not
    .toBeNull();
  expect(raised!).toMatch(/cannot (set path in scalar|delete from scalar)|scalar/i);
}, 60_000);

// ---------------------------------------------------------------------------
// IDEMPOTENCE.
// ---------------------------------------------------------------------------

test('0078 is idempotent — a second apply changes no value and re-touches no source row', async () => {
  await reset();
  await runMigration();
  const values = await snapshotAll();
  const versions = await rowVersions();

  await runMigration();

  expect(await snapshotAll()).toEqual(values);
  // Part 2 keys on the pre-repair literal, which the first apply destroyed, so it must select ZERO
  // rows the second time — a STATEMENT-level check the value comparison above cannot make.
  const after = await rowVersions();
  expect(after[V_SIBLING]).toBe(versions[V_SIBLING]!);
  expect(await sourceOf(V_CURRENT)).toContain(NEW_CAPS_LINE);
  expect(await sourceOf(V_CURRENT)).not.toContain(`${OLD_CAPS_LINE}\n`);
}, 60_000);

test('0078 is a no-op on a database that never held the broken row', async () => {
  await scratch.unsafe('TRUNCATE block_versions, building_blocks RESTART IDENTITY CASCADE');
  await runMigration();
  const rows = (await scratch.unsafe(
    'SELECT count(*)::int AS n FROM block_versions',
  )) as unknown as { n: number }[];
  expect(rows[0]!.n).toBe(0);
}, 60_000);

// ---------------------------------------------------------------------------
// PART 3 — the verification block. Part 2 is a bare `replace()`: if the literal it keys on is ever
// spelled differently the replace matches NOTHING, part 1 still flips the descriptor, and the result
// is the worst of both — the "Simulated" badge ON over a block that still throws
// `capability_missing_mock_data`, silently. Part 3 is what stops that being silent.
//
// ⛔ THE TWO STATES ARE NOT THE SAME STATE, AND THE WHOLE DESIGN IS THAT ONE RAISES AND ONE DOES
// NOT. A migration that RAISEs rolls back the entire `sql.begin()` in `runMigrations` — including
// the `_migrations` rows of every file that already succeeded — so the next boot replays it and
// fails identically: a PERMANENT boot wedge. That is why the migration numbered 0069 was withdrawn
// before merging. So:
//   · the IMPOSSIBLE state (descriptor flipped, pre-repair literal still in source) raises — it can
//     only mean part 2 itself is broken, on a database it has not yet touched;
//   · the REACHABLE state (a source spelled some third way) warns — it is produced by data this file
//     did not write, and aborting on it is the 0069 wedge exactly.
// Both are asserted below, and so is the thing that makes the check a check at all: it must NOT fire
// on a second apply, where part 2 legitimately matches nothing because it already applied.
// ---------------------------------------------------------------------------

/**
 * Run one statement on a client that COLLECTS notices instead of discarding them.
 *
 * ⚠️ `scratch` is built with `onnotice: () => {}` — like `applyMigrations`'s own client — so a
 * `RAISE WARNING` asserted through it is invisible and the case would pass with the warning
 * deleted. This is the only way to see it from the client side at all.
 */
async function runCollectingNotices(sqlText: string): Promise<string[]> {
  const notices: string[] = [];
  const client = postgres(SCRATCH_DSN, {
    max: 1,
    onnotice: (n) => notices.push(String(n.message ?? '')),
  });
  try {
    await client.unsafe(sqlText);
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices;
}

/** 0078 with part 2 (the `source_ts` replace) deleted — the silent no-op part 3 exists to catch. */
function migrationWithoutPart2(): string {
  const full = migrationSql();
  const marker = 'UPDATE block_versions\nSET source_ts = replace(';
  const at = full.indexOf(marker);
  expect(at, 'part 2 no longer starts with the text this mutation keys on').toBeGreaterThan(-1);
  const end = full.indexOf(';', full.indexOf("AND source_ts LIKE '%capabilities: { network: false },%'", at));
  expect(end, 'part 2 has no terminating semicolon where expected').toBeGreaterThan(at);
  // Replace the statement with whitespace so every line number after it is unchanged.
  return full.slice(0, at) + full.slice(end + 1);
}

test('⛔ FRESH APPLY: part 3 is silent when parts 1 and 2 both did their job', async () => {
  await reset();
  const notices = await runCollectingNotices(migrationSql());

  // NON-VACUITY: the migration really did repair the row, so "no warning" is a statement about a
  // converged database and not about one where nothing matched.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false, mockData: true });
  expect(await sourceOf(V_CURRENT)).toContain(NEW_CAPS_LINE);
  expect(
    notices.filter((n) => n.includes('0078')),
    'part 3 warned on a database it fully repaired',
  ).toEqual([]);
}, 60_000);

test('⛔ RE-APPLY: part 3 stays silent when part 2 legitimately matches nothing', async () => {
  // ⛔ THE WEDGE THE CHECK ITSELF COULD HAVE BEEN. A verification phrased as "part 2 must have
  // changed N rows" passes on the first apply and RAISES on the second, where the literal is gone
  // BECAUSE the first apply consumed it — turning the guard into the deterministic boot failure it
  // was written to prevent. Part 3 asserts a POST-STATE instead, which is what survives this.
  await reset();
  await runMigration();
  const values = await snapshotAll();

  const notices = await runCollectingNotices(migrationSql());

  expect(await snapshotAll(), 'the second apply changed a value').toEqual(values);
  expect(
    notices.filter((n) => n.includes('0078')),
    'part 3 warned on a re-apply — the check is not idempotent',
  ).toEqual([]);
}, 60_000);

test('⛔ part 3 RAISES when part 2 silently no-ops — otherwise it verifies nothing', async () => {
  // THE NEGATIVE CONTROL ON THE CHECK ITSELF. Without this, "part 3 is silent on a good apply" is a
  // claim about a statement that might never be able to speak.
  await reset();
  let raised: string | null = null;
  try {
    await scratch.unsafe(migrationWithoutPart2());
  } catch (err) {
    raised = String((err as Error).message);
  }
  expect(raised, 'part 2 was deleted and part 3 said nothing — the badge is on over a throwing block')
    .not.toBeNull();
  expect(raised!).toContain('still carry the pre-repair capabilities literal');

  // …and the RAISE took the whole statement batch down, so the descriptor part 1 flipped is rolled
  // back too. That is the point of raising HERE rather than logging: on this state the file must not
  // half-apply.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false });
}, 60_000);

test('⛔ a source spelled a THIRD way WARNS and does not abort — the 0069 wedge, refused', async () => {
  // The reachable half. A republished version whose source matches neither the pre-repair literal
  // nor the repaired one: part 2 skips it, part 1 flips its descriptor, and the block still throws.
  // That must be REPORTED — and it must not take the pod down, because it is data this file did not
  // write and the failure would be deterministic on every retry.
  await reset();
  const DRIFTED = reviewPanelSource('capabilities: {network: false},'); // no spaces — a real re-spelling
  expect(DRIFTED).not.toContain(OLD_CAPS_LINE);
  // ⛔ THE PREDICATE UNDER TEST IS `mockData\s*:\s*true`, NOT `%mockData%`, AND THIS ASSERTION IS
  // WHY. This block's run body calls `ctx.mockData("review_decision", …)`, so the bare token is in
  // EVERY review-panel source — a substring test would be satisfied by every row and the warning
  // could never fire at all. Measured: the first draft of part 3 used `NOT LIKE '%mockData%'` and
  // this case red with the token present in a source that grants nothing.
  expect(DRIFTED, 'the token is present — a %mockData% predicate would be dead').toContain(
    'ctx.mockData(',
  );
  expect(DRIFTED, 'the drifted source must not GRANT the capability').not.toMatch(
    /mockData\s*:\s*true/,
  );
  await scratch.unsafe(`UPDATE block_versions SET source_ts = $1 WHERE id = $2`, [
    DRIFTED,
    V_CURRENT,
  ]);

  const notices = await runCollectingNotices(migrationSql());

  // ⛔ IT DID NOT ABORT: the migration ran to completion and part 1's repair is committed.
  expect(await capsOf(V_CURRENT)).toEqual({ network: false, mockData: true });
  // …the drifted source is left alone rather than corrupted…
  expect(await sourceOf(V_CURRENT)).toBe(DRIFTED);
  // …and the reader of the postgres log is told, by count and by cause.
  const warnings = notices.filter((n) => n.includes('0078'));
  expect(warnings, 'the drift was skipped SILENTLY — the badge is on over a throwing block').toHaveLength(1);
  expect(warnings[0]!).toContain('grants no mockData capability');
  expect(warnings[0]!).toContain('1 global review-panel version');

  // NON-VACUITY on the other side: the untouched V_OLD row took the ordinary repair path in the
  // same run, so the warning is about the drifted row and not about a migration that did nothing.
  expect(await sourceOf(V_OLD)).toContain(NEW_CAPS_LINE);
}, 60_000);
