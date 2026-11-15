// tests/seed-fabrication-guard.test.ts — the platform seeder must not assert events that never
// happened. #208 shipped `config.seedFabricatedTelemetry` with ZERO tests; this file is the
// executable half of the widened gate.
//
// ⛔ THE TRAP THAT WOULD MAKE THIS FILE WORTHLESS. config.ts sets `seedFabricatedTelemetry` to TRUE
// whenever `NODE_ENV !== 'production'`, and tests run with NODE_ENV=test. A test that just calls
// `seedPlatform()` therefore exercises the UN-GATED branch and would stay green with the gate
// deleted. Every assertion below that is about the gate passes `{ fabricate: false }` EXPLICITLY —
// that per-call seam is the only reason the gate is testable at all. `prodCfg()` in
// config-validation.test.ts is the same idea applied to the config object.
//
// Every test here has an exact revert that makes it RED; the revert is named in the test's own
// comment. A test whose fix can be reverted while it stays green is worth nothing.
import { test, expect, afterAll, beforeAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  db,
  auditLog,
  policies,
  policyChanges,
  pipelineItems,
  usageEvents,
  tenants,
  tenantLlmSettings,
  users,
  runAsSystem,
} from '../src/db/client';
import { seedPlatform, FABRICATED_CARD_TITLES } from '../src/db/seed-platform';
import { applyMigrations } from '../src/db/migration-runner';
import { config, DEMO_TENANT_ID } from '../src/config';
import {
  purge,
  fabChanges,
  FAB_USAGE,
  TOM_INLINE,
  BURST_FROM,
  BURST_TO,
  type Expectations,
} from '../scripts/purge-fabricated-history';
import { flagUnder } from './config-flag-probe';

const SEED_MARKED = sql`metadata @> '{"seed":true}'::jsonb`;
const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5'];

/** The 16 governance keys the seeder is responsible for. Written out longhand ON PURPOSE rather
 *  than derived from the seeder's own POLICIES array — an expectation derived from the thing under
 *  test asserts nothing. (NB: the file header and several docs still say "the 14 policies". The
 *  fixture has held 16 since `data.egress_allowlist` and `block_publish.require_passing_tests`
 *  were added.) */
const POLICY_KEYS = [
  'data.block_prod_data',
  'data.pii_scrubbing',
  'data.cross_sandbox_isolation',
  'data.eu_only',
  'data.validation_mode',
  'spend.daily_llm_cap',
  'spend.weekly_spend_ceiling',
  'spend.auto_suspend_idle',
  'models.allowlist',
  'models.external_http',
  'models.code_exec_outside_blocks',
  'data.egress_allowlist',
  'promotion.mandatory_review',
  'promotion.required_reviewers',
  'promotion.staging_canary_pct',
  'block_publish.require_passing_tests',
  'cycle.cadence', // 0107 — configuration, so it seeds with fabrication off too
];

const seededAudit = () => db.select().from(auditLog).where(SEED_MARKED);
const cardRows = () =>
  db.select().from(pipelineItems).where(inArray(pipelineItems.title, [...FABRICATED_CARD_TITLES]));
const fabricatedUsage = () =>
  db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.tenant_id, DEMO_TENANT_ID), inArray(usageEvents.model, CLAUDE_MODELS)));

/**
 * Empty a table, run `fn` against the emptied state, then put the EXACT rows back — same ids, same
 * timestamps. Most of these guards only fire when their table is empty (`if (count === 0)` /
 * `anchored.length === 0`), so a test that does not clear first would pass with the gate deleted.
 * Restoration is in `finally` so a failing assertion still leaves the suite's shared DB as it was.
 */
async function withEmptied<R>(
  read: () => Promise<R[]>,
  clear: () => Promise<unknown>,
  restore: (rows: R[]) => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = await read();
  await clear();
  try {
    await fn();
  } finally {
    await clear();
    if (saved.length) await restore(saved);
  }
}

// The seeder's un-gated audit DELETE removes the 12 baseline rows on every call, so any test in
// this file leaves them missing for the rest of the suite. Put them back once at the end by running
// the seeder exactly as boot does (no args → config default → fabricate ON under NODE_ENV=test).
// Explicit timeout: bun 1.3.14 ignores bunfig's [test] timeout for HOOKS, so a hook doing DB work
// gets the hard 5 s default without it (scripts/check-hook-timeouts.ts enforces this).
afterAll(async () => {
  await runAsSystem('boot-seed', () => seedPlatform());
}, 30_000);

// ---------------------------------------------------------------------------------------------
// TB1 — with fabrication OFF, the four fabricating writes write nothing. Four SEPARATE tests so
// each one names the single revert that reds it.
// ---------------------------------------------------------------------------------------------

test('TB1a: fabricate:false writes ZERO seed-marked audit_log rows', async () => {
  // REVERT THAT REDS THIS: drop the `if (fabricate)` around the audit reinsert loop in
  // seed-platform.ts → 12 rows come back and this expects 0.
  await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
  expect(await seededAudit()).toHaveLength(0);
});

test('TB1b: fabricate:false writes ZERO policy_changes', async () => {
  // The guard is `if (fabricate && count === 0)`, so the table must be empty for the write to be
  // reachable at all — otherwise this would pass even un-gated.
  // REVERT THAT REDS THIS: change that condition back to `if ((pcRows[0]?.count ?? 0) === 0)` →
  // 3 rows attributed to Tom appear and this expects 0.
  await withEmptied(
    () => db.select().from(policyChanges),
    () => db.delete(policyChanges),
    (rows) => db.insert(policyChanges).values(rows),
    async () => {
      await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
      expect(await db.select().from(policyChanges)).toHaveLength(0);
    },
  );
});

test('TB1c: fabricate:false writes ZERO CARDS-titled pipeline_items', async () => {
  // Same reachability point: the cards only insert when no card is anchored to Lisa's solution.
  // REVERT THAT REDS THIS: change the condition back to `if (anchored.length === 0)` → all 18
  // invented cards appear (nine of them claiming `live: true`) and this expects 0.
  await withEmptied(
    () => db.select().from(pipelineItems),
    () => db.delete(pipelineItems),
    (rows) => db.insert(pipelineItems).values(rows),
    async () => {
      await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
      expect(await cardRows()).toHaveLength(0);
      expect(await db.select().from(pipelineItems)).toHaveLength(0);
    },
  );
});

test('TB1d: fabricate:false writes ZERO fabricated usage_events', async () => {
  // 42 rows of `anthropic`/`claude-*` spend on a deployment holding no Anthropic key.
  // REVERT THAT REDS THIS: change the condition back to `if ((usageRows[0]?.n ?? 0) === 0)` in
  // seedTenants → 42 claude-priced rows appear on the demo tenant and this expects 0.
  await withEmptied(
    () => db.select().from(usageEvents).where(eq(usageEvents.tenant_id, DEMO_TENANT_ID)),
    () => db.delete(usageEvents).where(eq(usageEvents.tenant_id, DEMO_TENANT_ID)),
    (rows) => db.insert(usageEvents).values(rows),
    async () => {
      await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
      expect(await fabricatedUsage()).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// TB2 — the #208 self-cleanup property.
// ---------------------------------------------------------------------------------------------

test('TB2: the scoped audit DELETE still runs with fabricate:false — it cleans up its own past output, and only its own', async () => {
  // This is the whole reason the DELETE sits OUTSIDE the guard. Its predicate is the seeder's own
  // `{"seed":true}` marker, so a fabrication-off boot erases the twelve inventions a previous
  // fabrication-on boot left behind, instead of stranding them in the audit trail forever. A live
  // row (no marker) must be untouched by the same call.
  // REVERT THAT REDS THIS: move `await db.delete(auditLog).where(...)` inside the `if (fabricate)`
  // block → the seed-marked row survives and the first expect fails.
  const [marked] = await db
    .insert(auditLog)
    .values({
      action: 'test.fabricated',
      category: 'system',
      target_type: 'test',
      target_id: 'tb2-seed-marked',
      result: 'invented',
      result_tone: 'ok',
      metadata: { seed: true },
    })
    .returning();
  const [live] = await db
    .insert(auditLog)
    .values({
      action: 'test.genuine',
      category: 'system',
      target_type: 'test',
      target_id: 'tb2-live-no-marker',
      result: 'really happened',
      result_tone: 'ok',
      metadata: { seed: false, tb2: true },
    })
    .returning();

  try {
    await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
    expect(await db.select().from(auditLog).where(eq(auditLog.id, marked!.id))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.id, live!.id))).toHaveLength(1);
  } finally {
    await db.delete(auditLog).where(eq(auditLog.id, live!.id));
    await db.delete(auditLog).where(eq(auditLog.id, marked!.id));
  }
});

// ---------------------------------------------------------------------------------------------
// TB3 — configuration is NOT history: it must still seed with fabrication off.
// ---------------------------------------------------------------------------------------------

test('TB3: fabricate:false still seeds all 17 governance policies, the demo tenant and its LLM setting', async () => {
  // Policy rows are the live values the broker reads for the daily cap / weekly ceiling / model
  // allowlist, and the reviewer minimum the promotion gate enforces — configuration the runtime
  // obeys, not a claim about the past. Gating them would silently change ENFORCEMENT on a
  // fabrication-off boot (config.governance.* is only the fallback when a row is ABSENT).
  // REVERT THAT REDS THIS: wrap the `for (const p of POLICIES)` loop in `if (fabricate)` → zero
  // policies come back and the key-set assertion fails.
  //
  // The tenant / tenant_llm_settings assertions below are presence checks only: they are not
  // preceded by a delete because the tenant row is the FK parent of most of the schema. The
  // policies half carries this test's revert.
  // NB not `withEmptied`: policy_changes.policy_key is FK → policies.key ON DELETE CASCADE, so
  // clearing policies takes policy_changes with it. Snapshot and restore BOTH, parents first.
  const savedPolicies = await db.select().from(policies);
  const savedChanges = await db.select().from(policyChanges);
  await db.delete(policies);
  try {
    await runAsSystem('boot-seed', () => seedPlatform({ fabricate: false }));
    const keys = (await db.select({ key: policies.key }).from(policies)).map((p) => p.key).sort();
    expect(keys).toEqual([...POLICY_KEYS].sort());

    expect(await db.select().from(tenants).where(eq(tenants.id, DEMO_TENANT_ID))).toHaveLength(1);
    expect(
      await db.select().from(tenantLlmSettings).where(eq(tenantLlmSettings.tenant_id, DEMO_TENANT_ID)),
    ).toHaveLength(1);
  } finally {
    await db.delete(policies);
    if (savedPolicies.length) await db.insert(policies).values(savedPolicies);
    await db.delete(policyChanges);
    if (savedChanges.length) await db.insert(policyChanges).values(savedChanges);
  }
});

// ---------------------------------------------------------------------------------------------
// TB4 — the "no-op for CI" claim, made executable.
// ---------------------------------------------------------------------------------------------

test('TB4: fabricate:true is byte-identical to today — 18 cards, 12 seed audit rows, 3 policy_changes', async () => {
  // Without this, "the gate changes nothing for dev/CI" would be an assertion in a commit message
  // rather than in the suite. It is also the test that catches an over-broad gate: gating ANY of
  // the four blocks unconditionally (`if (false)`, or accidentally gating `policies`) reds it.
  // REVERT THAT REDS THIS: replace any `if (fabricate)` with `if (false)` → the matching count
  // drops to 0.
  const savedPipeline = await db.select().from(pipelineItems);
  const savedChanges = await db.select().from(policyChanges);
  await db.delete(pipelineItems);
  await db.delete(policyChanges);
  try {
    const r = await runAsSystem('boot-seed', () => seedPlatform({ fabricate: true }));
    expect(await cardRows()).toHaveLength(18);
    expect(r.pipeline).toBe(18);
    expect(await seededAudit()).toHaveLength(12);
    expect(r.audit).toBe(12);
    expect(await db.select().from(policyChanges)).toHaveLength(3);
  } finally {
    await db.delete(pipelineItems);
    await db.delete(policyChanges);
    if (savedPipeline.length) await db.insert(pipelineItems).values(savedPipeline);
    if (savedChanges.length) await db.insert(policyChanges).values(savedChanges);
  }
});

// ---------------------------------------------------------------------------------------------
// TB4b — the seeded Production cards must carry the timestamps they claim.
//
// The seeder inserted nine `stage:'production', live:true` cards and NEVER stamped `live_at`. Every
// dev and CI database therefore reproduced the /pipeline contradiction — "avg time to live —, none
// live yet" beside "in production 9, live now" — because the average was computed over the empty
// set. It also made metrics tests written against a seeded DB vacuous: with no `live_at` anywhere,
// any assertion about the average holds trivially.
// ---------------------------------------------------------------------------------------------
test('TB4b: every seeded live card has a created_at → live_at interval, spanning sub-day AND multi-day', async () => {
  // REVERT THAT REDS THIS: drop `shipped` from the Production fixtures in seed-platform.ts (or stop
  // spreading `created_at`/`live_at` into the insert) → `live_at` is NULL and the first expect fails.
  const savedPipeline = await db.select().from(pipelineItems);
  const savedChanges = await db.select().from(policyChanges);
  await db.delete(pipelineItems);
  await db.delete(policyChanges);
  try {
    await runAsSystem('boot-seed', () => seedPlatform({ fabricate: true }));
    const cards = await cardRows();
    const liveCards = cards.filter((c) => c.live);
    expect(liveCards).toHaveLength(9);

    const intervalsMs = liveCards.map((c) => {
      expect(c.live_at, `seeded live card "${c.title}" has no live_at`).not.toBeNull();
      return c.live_at!.getTime() - c.created_at.getTime();
    });
    // Every interval is positive — a `live_at` before `created_at` is a negative time-to-live.
    for (const ms of intervalsMs) expect(ms).toBeGreaterThan(0);

    const DAY = 24 * 60 * 60 * 1000;
    // BOTH ends of the spread, and this is the whole point of the fixture: a set that is entirely
    // multi-day cannot tell a correct duration apart from `Math.round(ms / DAY_MS)`, which is the
    // rounding that erased the real 41-minute production ship.
    expect(intervalsMs.some((ms) => ms < DAY), 'no sub-day interval in the fixture').toBe(true);
    expect(intervalsMs.some((ms) => ms >= 2 * DAY), 'no multi-day interval in the fixture').toBe(true);
    // …and nothing shipped in the future.
    for (const c of liveCards) expect(c.live_at!.getTime()).toBeLessThanOrEqual(Date.now());
  } finally {
    await db.delete(pipelineItems);
    await db.delete(policyChanges);
    if (savedPipeline.length) await db.insert(pipelineItems).values(savedPipeline);
    if (savedChanges.length) await db.insert(policyChanges).values(savedChanges);
  }
});

// ---------------------------------------------------------------------------------------------
// TB5 — the config default itself. Pure; no DB.
// ---------------------------------------------------------------------------------------------

// `flagUnder` (import src/config in a FRESH process under a given env and read the flag back) moved
// to tests/config-flag-probe.ts when seed-vote-fabrication-guard.test.ts needed the same probe — a
// `.test.ts` cannot be imported by another `.test.ts` without bun re-running its tests. Same
// helper, same reasoning, one copy.

test('TB5: seedFabricatedTelemetry fails CLOSED in production, opens only via the explicit escape hatch', async () => {
  // REVERT THAT REDS THIS: change config.ts back to an unconditional `true`, or drop the
  // `!== 'production'` clause → the first or second expect fails.
  expect(await flagUnder({ NODE_ENV: 'production' })).toBe(false);
  expect(await flagUnder({ NODE_ENV: 'production', CP_SEED_FABRICATED_TELEMETRY: 'true' })).toBe(true);
  // ⛔ And the reason every other test in this file passes `{ fabricate: false }` explicitly:
  // under test, the config default is ON, so the un-gated branch is what a bare seedPlatform() runs.
  expect(await flagUnder({ NODE_ENV: 'test' })).toBe(true);
}, 30_000);

// =============================================================================================
// TB6 — the one-shot purge script's PRECONDITIONS, one test per load-bearing check.
// =============================================================================================
//
// ⛔ WHY NOT ONE TEST. The first version of this asserted only `rejects.toThrow(/precondition:/)`.
// That is worthless: the checks run in order inside a single DO block, so deleting ANY ONE of them
// just lets the next one fire and the test stays green. Adversarial review deleted the two checks
// the script itself marks ⭐ — the burst assertion that is the ONLY thing authorising an unqualified
// `DELETE FROM pipeline_items`, and the post-0053 assertion that is the ONLY proof the 126 money
// rows are not broker output — and got 9 pass / 0 fail both times.
//
// Each test below therefore builds a fixture that violates EXACTLY ONE precondition and asserts
// that check's SPECIFIC message. Reaching a late check means satisfying every earlier one, and
// those earlier ones compare against counts that hold on exactly one production database — hence
// `purge({ expect })`, which overrides the prod constants with the values the fixture actually has.
// The CLI never passes it; it exists for the same reason `SeedPlatformOpts.fabricate` does.
//
// ---------------------------------------------------------------------------------------------
// ⛔ WHY THESE SIX TESTS OWN A SEPARATE DATABASE — the #216 race, and why the obvious fix is not one.
// ---------------------------------------------------------------------------------------------
// The first version of TB6 measured the SUITE'S database — `SELECT count(*) FROM audit_log`,
// `FROM policy_changes`, `FROM pipeline_items`, `FROM usage_events`, unscoped and global — and fed
// those totals back in as `expect`. `bun test` runs all 132 files against ONE database (⚠️
// CORRECTED 2026-08-16: SEQUENTIALLY, not "CONCURRENTLY" as this line used to claim — canonical
// note at the top of tests/metering-platform-calls.test.ts), and nearly every admin action in this
// codebase writes an `audit_log` row, so those four unscoped totals depend on every file that ran
// before TB6 and on anything any of them leaked past its own end. `purge()` then RE-measures the
// same globals on its OWN connection a few milliseconds later. When the two measurements
// disagree, an EARLIER precondition fires for a table that is not the one under test, the thrown
// message is the wrong one, and the `toThrow` regex misses. That is exactly what went red on
// `main`: five of these six failed on a runner where the suite took 76.85 s while passing locally
// at ~19 s and on the PR runner — a slow runner widens every window in which some other writer can
// land. It is a race against WHATEVER ELSE IS WRITING, not a one-off, and it does not need a
// second FILE to be running: an earlier file's leaked work, or the scheduler ticks this process
// starts, will do. Reproduced here on demand by inserting into `audit_log` in a loop from a second
// connection during the run — which is exactly the shape of that leak.
//
// The obvious cheaper fix — "inject the values the purge WILL measure rather than the values the
// test DID" — cannot work, for three independent reasons:
//   1. There is no such value. The purge measures at an instant the test cannot name, on a table
//      another process is still writing. Injection can only ever guess.
//   2. Three of the preconditions are SELF-referential and take no constant at all:
//      `pi_burst <> pi_total`, `pc_fab <> pc_tom`, and `ue_fab_after_0053 < 1`. They compare
//      measured values to each other, so no injected number can satisfy them — only the DATA can.
//   3. TB6f asserts that a dry run leaves every table byte-identical. Any concurrent writer breaks
//      that assertion no matter what is injected, because it is comparing live counts to live
//      counts.
// The only honest fix is for the tests to own their data. `purge()` already carries the seam:
// `PurgeOpts.databaseUrl` (used by the CLI's own default), so no production code changes — the
// tests point it at a scratch database created, migrated, fixtured and dropped by this file alone.
//
// A side effect worth naming: run this file ON ITS OWN before the change and TB6e failed with
// `expected exactly 1 user <fr-test@nonagentic.local>, found 0`. TB6 was silently depending on a
// user some OTHER test file happens to create. The scratch DB removes that order-dependency too.
// ---------------------------------------------------------------------------------------------

/** Named after THIS file, so a database created by a concurrently-running test file can never
 *  collide with it. Dropped in `afterAll`, and dropped-if-present before CREATE so a suite that was
 *  killed mid-run does not poison the next one. */
const SCRATCH_DB = 'cp_tb6_purge_scratch';

/** Same DSN, different database. Used for both the maintenance connection (CREATE/DROP DATABASE
 *  cannot run inside the database being created) and the scratch DSN handed to `purge()`. */
function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The OWNER DSN — the same one `purge()` defaults to, and the one that can issue DDL. In CI it is
 *  the `postgres` superuser (see .github/workflows/ci-cd.yaml), locally the `commonpractice` owner;
 *  both can CREATE DATABASE. */
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

// Fixed ids so the fixture SQL below can reference them without a round trip.
const SCRATCH_TENANT = '00000000-0000-4000-8000-0000000000aa';
const SCRATCH_TOM = '00000000-0000-4000-8000-0000000000b1';
const SCRATCH_FRTEST = '00000000-0000-4000-8000-0000000000b2';
const SCRATCH_OPS = '00000000-0000-4000-8000-0000000000b3';

const IN_BURST = new Date('2026-06-07T04:20:40Z');
const IN_BURST_SQL = `TIMESTAMPTZ '${IN_BURST.toISOString()}'`;

/**
 * Truncate the scratch database and rebuild the BASE fixture: a miniature of prod's shape in which
 * EVERY precondition passes. Each TB6 test calls this first and then breaks exactly one thing, so
 * no test needs a snapshot/restore `finally` — the next test rebuilds from nothing.
 *
 * The counts are deliberately small and deliberately NOT prod's (18 cards / 126 usage rows / 267
 * audit rows): the constants are supplied by `expectationsMatchingScratch()`, and hard-coding prod's
 * numbers here would just be a second copy of `EXPECT` that could drift. What must hold structurally
 * is only what no injected constant can express:
 *   - exactly one `tom@commonpractice.local` and one `fr-test@nonagentic.local`,
 *   - the by-Tom policy_changes set is EXACTLY the by-triple set (pc_fab = pc_tom),
 *   - every pipeline_items row is in the burst window (pi_burst = pi_total) and carries a title
 *     from the seeder's own CARDS fixture (pi_unknown_title = 0),
 *   - the fabricated usage rows are balanced across the two models and at least one postdates 0053.
 */
async function resetScratch(): Promise<void> {
  const cards = FABRICATED_CARD_TITLES.slice(0, 4);
  if (cards.length < 3) throw new Error('fixture assumption broken: need ≥3 seeder card titles');
  const statements = [
    `TRUNCATE audit_log, policy_changes, policies, pipeline_items, usage_events, users, tenants
       RESTART IDENTITY CASCADE`,

    `INSERT INTO tenants (id, name, slug)
       VALUES ('${SCRATCH_TENANT}', 'TB6 scratch', 'tb6-scratch')`,

    // The two identities the script resolves BY EMAIL, exactly one of each.
    `INSERT INTO users (id, email, name) VALUES
       ('${SCRATCH_TOM}',    'tom@commonpractice.local', 'Tom'),
       ('${SCRATCH_FRTEST}', 'fr-test@nonagentic.local', 'FR Test'),
       ('${SCRATCH_OPS}',    'ops@commonpractice.local', 'Ops')`,

    // policy_changes.policy_key is FK → policies.key, so the parents must exist.
    `INSERT INTO policies (key, category, label, control, value) VALUES
       ('spend.weekly_spend_ceiling',   'spend',     'Weekly ceiling', 'number', '15'::jsonb),
       ('spend.daily_llm_cap',          'spend',     'Daily cap',      'number', '50'::jsonb),
       ('models.allowlist',             'models',    'Allowlist',      'multi',  '["claude-opus-4-7"]'::jsonb),
       ('promotion.required_reviewers', 'promotion', 'Reviewers',      'number', '"2"'::jsonb)`,

    // The three exact (policy_key, old_value, new_value) triples seed-platform.ts hard-codes, by
    // Tom — so pc_fab = pc_tom = 3 — plus two GENUINE changes by someone else, so pc_total > pc_tom
    // exactly as on prod. `promotion.required_reviewers` is written in the STRING encoding here
    // (prod's); `fabChanges` matches both encodings on purpose — see its comment in the script.
    `INSERT INTO policy_changes (policy_key, old_value, new_value, changed_by) VALUES
       ('spend.weekly_spend_ceiling', '10'::jsonb, '15'::jsonb, '${SCRATCH_TOM}'),
       ('models.allowlist',
          '["claude-sonnet-4-6", "claude-haiku-4-5"]'::jsonb,
          '["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]'::jsonb,
          '${SCRATCH_TOM}'),
       ('promotion.required_reviewers', '"1"'::jsonb, '"2"'::jsonb, '${SCRATCH_TOM}'),
       ('spend.daily_llm_cap',          '60'::jsonb, '50'::jsonb, '${SCRATCH_OPS}'),
       ('promotion.required_reviewers', '"2"'::jsonb, '"3"'::jsonb, '${SCRATCH_OPS}')`,

    // Every card inside the one-burst window and titled from the seeder's own CARDS fixture.
    `INSERT INTO pipeline_items (title, stage, position, week, created_at) VALUES ${cards
      .map((t, i) => `('${t.replace(/'/g, "''")}', 'review', ${i}, '2026-W21', ${IN_BURST_SQL})`)
      .join(', ')}`,

    // Fabricated usage: the two exact (cost, tokens_in, tokens_out) triples, price_source NULL,
    // balanced 2/2 across the models, created NOW — i.e. after 0053 applied a moment ago, which is
    // what the ⭐ post-0053 precondition needs. Then the two genuine ledgers the purge must not
    // touch: content-translation (excluded by price_source) and legacy local-llm (excluded by
    // provider), each with the distinct-cost shape the script cross-checks.
    `INSERT INTO usage_events
       (tenant_id, user_id, provider, model, tokens_in, tokens_out, cost_usd, price_source, stage, created_at)
     VALUES
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-sonnet-4-6',1200,380,0.018,NULL,'demo',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-sonnet-4-6',1200,380,0.018,NULL,'demo',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-haiku-4-5', 800,210,0.004,NULL,'demo',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-haiku-4-5', 800,210,0.004,NULL,'demo',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-sonnet-4-6',900,140,0.011,'table','content-translation',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-sonnet-4-6',910,150,0.012,'table','content-translation',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','anthropic','claude-sonnet-4-6',920,160,0.013,'table','content-translation',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','local','local-llm',           500,100,0.000100,NULL,'demo',now()),
       ('${SCRATCH_TENANT}','${SCRATCH_TOM}','local','local-llm',           510,110,0.000200,NULL,'demo',now())`,

    // A two-valued audit table: 10 rows of which 3 carry the seeder's `{"seed":true}` marker.
    `INSERT INTO audit_log (action, category, target_type, target_id, result, result_tone, metadata)
       SELECT 'tb6.event', 'system', 'test', g::text, 'ok', 'ok',
              CASE WHEN g <= 3 THEN '{"seed":true}'::jsonb ELSE '{"seed":false}'::jsonb END
         FROM generate_series(1, 10) g`,
  ];
  for (const stmt of statements) await scratch.unsafe(stmt);
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    // FORCE so a connection stranded by a previously-killed run cannot block the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  // The real migration runner, not a hand-written schema: `_migrations` must contain a genuine
  // 0053 row with a real `applied_at`, because the ⭐ post-0053 precondition reads it.
  await applyMigrations(SCRATCH_DSN, { logger: { log: () => {}, warn: () => {}, error: console.error } });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

/** Measure the SCRATCH database with the SCRIPT'S OWN predicates (imported, not re-typed — a second
 *  copy could drift and then these tests would be asserting about a predicate nobody ships) and
 *  return expectations under which every constant-comparison precondition passes. The audit POST
 *  pair is set unreachable so the PRE branch is the one taken; TB6e/TB6f flip that. */
async function expectationsMatchingScratch(): Promise<Partial<Expectations>> {
  const rows = (await scratch.unsafe(`
      SELECT
        (SELECT count(*)::int FROM audit_log)                                          AS audit_total,
        (SELECT count(*)::int FROM audit_log WHERE metadata @> '{"seed":true}'::jsonb) AS audit_seeded,
        (SELECT count(*)::int FROM policy_changes)                                     AS pc_total,
        (SELECT count(*)::int FROM policy_changes WHERE changed_by = ${TOM_INLINE})    AS pc_tom,
        (SELECT count(*)::int FROM policy_changes WHERE ${fabChanges(TOM_INLINE)})     AS pc_fab,
        (SELECT count(*)::int FROM pipeline_items)                                     AS pi_total,
        (SELECT count(*)::int FROM pipeline_items WHERE solution_id IS NULL)           AS pi_null_sol,
        (SELECT count(*)::int FROM pipeline_items
           WHERE week = '2026-W21'
             AND created_at BETWEEN TIMESTAMPTZ '${BURST_FROM}'
                                AND TIMESTAMPTZ '${BURST_TO}')                         AS pi_burst,
        (SELECT count(*)::int FROM usage_events)                                       AS ue_total,
        (SELECT count(*)::int FROM usage_events WHERE ${FAB_USAGE})                    AS ue_fab,
        (SELECT count(*)::int FROM usage_events
           WHERE ${FAB_USAGE} AND model = 'claude-sonnet-4-6')                         AS ue_sonnet,
        (SELECT count(*)::int FROM usage_events
           WHERE ${FAB_USAGE} AND model = 'claude-haiku-4-5')                          AS ue_haiku,
        (SELECT count(DISTINCT cost_usd)::int FROM usage_events WHERE ${FAB_USAGE})    AS ue_costs,
        (SELECT COALESCE(sum(cost_usd), 0)::numeric(12,6) FROM usage_events
           WHERE ${FAB_USAGE})                                                         AS ue_spend,
        (SELECT count(*)::int FROM usage_events WHERE stage = 'content-translation')   AS ue_tr,
        (SELECT count(*)::int FROM usage_events
           WHERE price_source IS NULL AND model = 'local-llm')                         AS ue_loc,
        (SELECT count(DISTINCT cost_usd)::int FROM usage_events
           WHERE price_source IS NULL AND model = 'local-llm')                         AS ue_loc_costs
    `)) as unknown as Record<string, number | string>[];
  const r = rows[0]!;
  if (r.ue_sonnet !== r.ue_haiku) {
    // The script compares BOTH models against one constant, so an unbalanced fixture would fire
    // that check instead of the one under test. Fail with a clear reason rather than mysteriously.
    throw new Error(`fixture assumption broken: sonnet=${r.ue_sonnet} haiku=${r.ue_haiku} must be equal`);
  }
  return {
    auditTotalPreRollout: r.audit_total as number,
    auditSeededPreRollout: r.audit_seeded as number,
    auditTotalPostRollout: -1, // unreachable → the PRE branch is the one exercised
    auditSeededPostRollout: -1,
    pcTotal: r.pc_total as number,
    pcTom: r.pc_tom as number,
    pcFabricated: r.pc_fab as number,
    piTotal: r.pi_total as number,
    piBurst: r.pi_burst as number,
    piNullSolution: r.pi_null_sol as number,
    ueTotal: r.ue_total as number,
    ueFabricated: r.ue_fab as number,
    uePerModel: r.ue_sonnet as number,
    ueDistinctCosts: r.ue_costs as number,
    ueFabricatedSpend: String(r.ue_spend),
    ueTranslationSurvivors: r.ue_tr as number,
    ueLegacyLocalSurvivors: r.ue_loc as number,
    ueLegacyLocalDistinctCosts: r.ue_loc_costs as number,
  };
}

/** Every TB6 run targets the scratch database — never the suite's shared one. */
const purgeScratch = (expectations?: Partial<Expectations>) =>
  purge({ commit: false, databaseUrl: SCRATCH_DSN, ...(expectations ? { expect: expectations } : {}) });

const scratchCount = async (table: string): Promise<number> => {
  const rows = (await scratch.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as unknown as { n: number }[];
  return rows[0]!.n;
};

test('TB6a: ⭐ the burst assertion fires when the one-burst set is NOT the whole pipeline_items table', async () => {
  // This is the assertion that authorises `DELETE FROM pipeline_items` with no WHERE clause. The
  // fixture is 3 cards: 2 inside the 2-second insert burst, 1 outside — i.e. a board that contains
  // something the seeder did not put there. Nothing else is perturbed.
  // REVERT THAT REDS THIS: delete the `IF m.pi_burst <> m.pi_total` branch from the precondition
  // block → the run sails past it and fails later with a DIFFERENT message, so the toThrow regex
  // stops matching. (Adversarial review deleted exactly this and the old single TB6 stayed green.)
  await resetScratch();
  const title = FABRICATED_CARD_TITLES[0]!.replace(/'/g, "''");
  await scratch.unsafe(`DELETE FROM pipeline_items`);
  await scratch.unsafe(`
    INSERT INTO pipeline_items (title, stage, position, week, created_at) VALUES
      ('${title}', 'review', 0, '2026-W21', ${IN_BURST_SQL}),
      ('${title}', 'review', 1, '2026-W21', ${IN_BURST_SQL}),
      ('${title}', 'review', 2, '2026-W21', TIMESTAMPTZ '2026-07-01T00:00:00Z')`);

  const expectations = await expectationsMatchingScratch();
  expect(expectations.piTotal).toBe(3);
  expect(expectations.piBurst).toBe(2); // the fixture really does violate only this
  await expect(purgeScratch(expectations)).rejects.toThrow(
    /one-burst set \(2\) is NOT the whole table \(3\).*REFUSING to delete/s,
  );
}, 30_000);

test('TB6b: ⭐ the post-0053 assertion fires when no matched usage_event postdates migration 0053', async () => {
  // This is the sole proof that the 126 claude rows are seeder output rather than real broker calls
  // that were mispriced before #210 — a NULL price_source on a row newer than 0053 is impossible for
  // a metered call. The fixture backdates every matched row to before 0053 applied, so the evidence
  // no longer holds, and the script must refuse rather than delete $-valued rows on a weaker basis.
  // pipeline_items is emptied so the earlier pipeline checks pass trivially (0 = 0).
  // REVERT THAT REDS THIS: delete the `IF m.ue_fab_after_0053 < 1` branch → the run proceeds to the
  // spend check and throws a different message, so the toThrow regex stops matching.
  await resetScratch();
  await scratch.unsafe(`DELETE FROM pipeline_items`);
  await scratch.unsafe(`
    UPDATE usage_events
       SET created_at = (SELECT applied_at FROM _migrations
                         WHERE filename LIKE '0053%' ORDER BY filename LIMIT 1) - INTERVAL '1 day'
     WHERE ${FAB_USAGE}`);

  const expectations = await expectationsMatchingScratch();
  expect(expectations.ueFabricated).toBeGreaterThan(0); // there really are matched rows to judge
  await expect(purgeScratch(expectations)).rejects.toThrow(
    /NO matched usage_event postdates migration 0053.*REFUSING to delete/s,
  );
}, 30_000);

test('TB6c: the by-Tom / by-triple cross-check fires when Tom has made a REAL governance change', async () => {
  // The compensating state a count alone cannot see: delete one fabricated row, add one GENUINE
  // change by Tom, and `pc_tom` still reads 3. A `changed_by = tom` delete would eat his real change
  // with every survivor assertion still passing. Requiring the by-Tom and by-triple SETS to be the
  // same size is what catches it.
  // REVERT THAT REDS THIS: delete the `IF m.pc_fab <> m.pc_tom` branch → the run proceeds and throws
  // a different message. (Narrowing the delete predicate alone is not enough — without this check
  // the script would happily delete 2 and leave his change, or with the old predicate delete 3
  // including it.)
  await resetScratch();
  await scratch.unsafe(`
    DELETE FROM policy_changes
     WHERE id = (SELECT id FROM policy_changes
                  WHERE ${fabChanges(TOM_INLINE)} ORDER BY id LIMIT 1)`);
  // A value pair the seeder never writes → real, not fabricated, and still attributed to Tom.
  await scratch.unsafe(`
    INSERT INTO policy_changes (policy_key, old_value, new_value, changed_by)
      VALUES ('spend.daily_llm_cap', '50'::jsonb, '40'::jsonb, '${SCRATCH_TOM}')`);

  const expectations = await expectationsMatchingScratch();
  expect(expectations.pcTom).toBe(expectations.pcFabricated! + 1); // the compensating state
  await expect(purgeScratch(expectations)).rejects.toThrow(
    /appears to have made a REAL governance change, REFUSING to delete/,
  );
}, 30_000);

test('TB6d: a MISMATCHED audit_log pair is refused — 12-with-255 is not a state this rollout produces', async () => {
  // The two-state audit precondition must not degrade into "accept anything". Pre-rollout is
  // (267, 12) and post-rollout is (255, 0); a database reading 12 seed-marked rows against the
  // post-rollout total means something OTHER than this rollout moved the table.
  // REVERT THAT REDS THIS: replace the paired IF/ELSIF/ELSE with two independent
  // `IF audit_total NOT IN (267,255)` / `IF audit_seeded NOT IN (12,0)` checks → the mismatched
  // pair is accepted and the run proceeds past audit, throwing a different message.
  await resetScratch();
  const base = await expectationsMatchingScratch();
  await expect(
    purgeScratch({
      ...base,
      // Claim the PRE total but the POST seed-marked count: neither branch can match.
      auditTotalPreRollout: base.auditTotalPreRollout,
      auditSeededPreRollout: (base.auditSeededPreRollout as number) + 99,
      auditTotalPostRollout: -1,
      auditSeededPostRollout: -1,
    }),
  ).rejects.toThrow(/audit_log must be either \(total=.*pre-rollout or .*post-rollout, found/s);
}, 30_000);

test('TB6e: the POST-ROLLOUT audit state is ACCEPTED — the script survives its own deployment', async () => {
  // ⭐ F1. seedAll() runs at every prod boot and the new seeder's audit DELETE is UN-gated, so the
  // first new pod removes the 12 seed-marked rows before anyone runs this script. Pinning a single
  // expected pair would make the purge abort on its own rollout and strand the other 147 fabricated
  // rows, including the $1.386 of invented spend. This asserts the post-rollout pair is accepted:
  // the run gets PAST audit and fails on the deliberately-impossible pcTotal instead.
  // REVERT THAT REDS THIS: drop the ELSIF post-rollout branch (i.e. pin the pre-rollout pair only)
  // → the run dies on the audit precondition and the thrown message is the audit one, not the
  // policy_changes one.
  await resetScratch();
  const base = await expectationsMatchingScratch();
  await expect(
    purgeScratch({
      ...base,
      auditTotalPreRollout: -1, // pre branch unreachable
      auditSeededPreRollout: -1,
      auditTotalPostRollout: base.auditTotalPreRollout, // this DB matches the POST branch instead
      auditSeededPostRollout: base.auditSeededPreRollout,
      pcTotal: 999_999, // the next check after audit — proves audit was passed
    }),
  ).rejects.toThrow(/policy_changes total expected 999999/);
}, 30_000);

test('TB6f: with the REAL prod constants the purge refuses outright and leaves nothing behind', async () => {
  // No injected expectations: this is the script exactly as the CLI runs it. On any database that is
  // not the one it was measured against it must fail LOUDLY and roll back completely — no rows gone,
  // no snapshot tables stranded. (`CREATE TABLE` is transactional, which is what makes a dry run
  // leave zero residue even though it really did create four tables and run four DELETEs.)
  // REVERT THAT REDS THIS: delete the whole precondition DO block → the run reaches the DELETEs and
  // throws a `delete: …` row-count message instead, so the `/precondition:/` regex stops matching.
  // (NB removing the `if (!opts.commit) throw new DryRunRollback()` does NOT red this one: with the
  // real constants the run aborts at the preconditions and never reaches the rollback throw. That
  // property is covered by TB6a–TB6e, which do reach it.)
  //
  // This is also the case the shared-database version could NEVER have made honest: it compares
  // live counts before and after, so ANY other writer breaks it — and "other writer" does not
  // require concurrency (files are sequential), only work that outlives the test that started it.
  // On the scratch database nothing else can write at all, so an unchanged count really does mean
  // the rollback put everything back.
  await resetScratch();
  const before = {
    audit: await scratchCount('audit_log'),
    pipeline: await scratchCount('pipeline_items'),
    changes: await scratchCount('policy_changes'),
    usage: await scratchCount('usage_events'),
  };

  await expect(purgeScratch()).rejects.toThrow(/precondition:/);

  expect(await scratchCount('audit_log')).toBe(before.audit);
  expect(await scratchCount('pipeline_items')).toBe(before.pipeline);
  expect(await scratchCount('policy_changes')).toBe(before.changes);
  expect(await scratchCount('usage_events')).toBe(before.usage);

  const snapshotTables = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE '\\_purge\\_20260809\\_%'`,
  )) as unknown as { n: number }[];
  expect(snapshotTables[0]?.n).toBe(0);
}, 30_000);
