// scripts/purge-fabricated-history.ts — ONE-SHOT, reviewed, run-by-hand cleanup of the fabricated
// history that seed-platform.ts wrote to PRODUCTION before the fabrication gate existed.
//
// ⛔ WHY THIS IS A SCRIPT AND NOT A MIGRATION. Migration 0061's own header argues the case and it
// applies verbatim here: "A DELETE over an empty set and a RAISE guard that is VACUOUSLY satisfied
// prove nothing; running them against prod would have manufactured a false sense of a contract
// having been enforced." These rows exist on exactly one database. They do not exist in CI, they do
// not exist on any laptop, and they will never exist again — the gate in seed-platform.ts is what
// stops them being re-created. A migration would be a no-op everywhere it ran except once, and
// every future `bun run migrate` would replay a purge with nothing to purge. This is a one-shot.
// It is idempotent only in the sense that a second run FAILS LOUDLY on its own preconditions.
//
// RUN:  MIGRATE_DATABASE_URL=<owner dsn> bun run scripts/purge-fabricated-history.ts            # dry run
//       MIGRATE_DATABASE_URL=<owner dsn> bun run scripts/purge-fabricated-history.ts --commit   # for real
//
// The whole thing is ONE transaction. `--dry-run` (the default) measures, snapshots, deletes,
// asserts every survivor invariant, prints the report, and then ROLLBACKs. `CREATE TABLE` is
// transactional in PostgreSQL, so a dry run leaves ZERO residue — not even the snapshot tables.
// It uses the OWNER DSN (MIGRATE_DATABASE_URL) so the `_purge_20260809_*` snapshot tables are owned
// by the owner role rather than by `cp_app`.
//
// ⛔ The snapshot prefix is `_purge_20260809_`. It is NOT `_purge_20260807_`: #208's snapshot tables
// carry that date, and reusing it would file this operation under a day it did not happen — the
// exact sin this script exists to undo.
//
//
// ============================ RUNBOOK — ORDER OF OPERATIONS ============================
//
// ⭐ SAFE SEQUENCE:   merge  →  complete the rollout to ZERO old-image pods  →  purge  →  verify
//
// The purge may run EITHER BEFORE OR AFTER the rollout — the audit_log precondition below accepts
// both states explicitly and RAISE NOTICEs which one it found. What is NOT safe is an old-image pod
// booting AFTER the purge:
//
//   • BEFORE the rollout ("pre-rollout" state): audit_log = 267 total / 12 seed-marked. The old
//     image is still running, so the fabrications are all present.
//   • AFTER the rollout ("post-rollout" state): audit_log = 255 total / 0 seed-marked. The NEW
//     seeder's UN-gated scoped DELETE (seed-platform.ts, the #208 self-cleanup property) removes
//     the 12 seed-marked rows on the first boot of the first new pod — it does part of this purge's
//     job for us. Pinning a single expected pair here would have made the script abort on its own
//     deployment and strand the other 147 fabricated rows, which is why it accepts both.
//   • ⛔ AN OLD POD BOOTING AFTER THE PURGE RE-FABRICATES. Once purged, `policy_changes` and
//     `pipeline_items` are EMPTY, which is exactly the `count === 0` / `anchored.length === 0`
//     condition the OLD seeder's guards test — so an old-image pod that restarts re-inserts all 21
//     rows, and the new code has no scoped delete for either table to clean them up (neither
//     carries a seed marker). Verify zero old pods remain before `--commit`.
//
// ⛔ CONCURRENCY: the survivor assertions are ABSOLUTE totals (audit_log = 255, usage_events = 752),
// and this runs at READ COMMITTED, so ANY concurrent commit to those tables during the transaction
// aborts the run. The app writes audit_log on nearly every admin action, so in practice that means:
// SCALE THE DEPLOYMENT TO 0 (or take a maintenance window) BEFORE `--commit`. Failing closed on a
// concurrent write is the correct behaviour — a purge that silently tolerated drift in the tables it
// is asserting about would prove nothing — but it means an unquiesced run will simply never succeed.
// Note also that `DELETE FROM pipeline_items` takes an unqualified full-table lock: on a live board
// that blocks every reader and writer of the pipeline screen for the duration of the transaction.
//
//
// ============================ WHAT IS BEING DELETED, AND WHY ============================
//
// (1) audit_log — 12 rows carrying the seeder's own `metadata @> {"seed":true}` marker. Each
//     asserts a person did a thing at a time with a result ("Mo published ocr-scan@1.2, approved by
//     Tom K., 9 minutes ago"). None happened. 267 rows total → 255 genuine survivors. These 12 are
//     the ones the new seeder's un-gated DELETE also removes, hence the two-state precondition.
//
// (2) policy_changes — 3 rows claiming Tom Kemper raised the weekly spend ceiling €10 → €15 and
//     tightened the reviewer minimum. He did neither. This is the governance change log; it was
//     answering an auditor's "who changed this, and when" with an invention attributed to a named
//     employee. 5 rows total → 2 genuine survivors (both the fr-test identity, both 2026-06-14).
//     ⛔ The predicate is NOT `changed_by = tom` — Tom is a REAL user who can make REAL governance
//     changes, and `changed_by` alone would delete them. It matches the three EXACT (policy_key,
//     old_value, new_value) triples the seeder hard-codes, AND cross-checks that the by-Tom count
//     and the by-triple count agree. That cross-check is what catches the compensating state the
//     count alone cannot see: one fabricated row hand-deleted plus one genuine Tom change still
//     reads `pc_tom = 3`, but then `pc_fabricated = 2` and the run aborts instead of eating his
//     real change.
//
// (3) pipeline_items — ALL 18. Every row on that board is seeder debris: all 18 sit inside a
//     ~2-second insert burst on 2026-06-07 with `week='2026-W21'`. Nine of them claim `live=true`
//     at 100% rollout — i.e. that nine solutions shipped to production. Lisa's anchor card goes too
//     despite its non-null `solution_id`: the solution it points at is real, but the card's
//     `progress: {day 3 of 5}` is a fabricated measurement that the /winner screen renders verbatim
//     to every user. 18 rows total → 0 survivors; the board is genuinely empty and should look it.
//
// (4) usage_events — 126 rows of invented Anthropic spend, on a deployment that holds no Anthropic
//     key and brokers every call to the in-cluster inference-router. $1.386 of the $2.3308 that
//     /usage displays — 59% of the money that screen reports — was never spent, and it is
//     attributed to four named people. FOUR INDEPENDENT LINES OF EVIDENCE that these are seeder
//     output and not real pre-#210 mispriced broker calls:
//       a. Every matched row reproduces one of exactly TWO hard-coded fixture tuples —
//          (claude-sonnet-4-6, $0.018000, 1200 in, 380 out) or (claude-haiku-4-5, $0.004000, 800 in,
//          210 out) — all `provider='anthropic'`. ONE cost, ONE token pairing per model across 126
//          rows. A real broker derives cost FROM the token counts, so it cannot produce a constant
//          cost against a constant token count twice over; the 92 genuine legacy `local-llm` rows
//          have 62 distinct cost values. The predicate below matches those two tuples WHOLE rather
//          than intersecting loose `IN` lists, so a real call that merely happened to cost $0.018
//          is not swept up.
//       b. The per-day shape is exactly 3 rows/day across 42 contiguous days: this fixture's
//          `14 days × 3 calls` loop, three loop-runs' worth.
//          ⛔ ATTRIBUTION — those three runs are NOT all seed-platform.ts. seed-tenant-showcase.ts
//          (~:538) contains a byte-identical models fixture (same two models, same costs, same
//          token counts) and its rows are matched by the same predicate. The two are told apart by
//          `seed_key`: the showcase seeder stamps `showcase:<tenant>:usage:<day>:<k>`, seed-platform
//          stamps nothing. Both are fabrications by the same standard and BOTH are swept — the
//          showcase seeder has its own un-gated scoped delete, but it is env-gated OFF in prod
//          (SEED_TENANT_SHOWCASE), so it never runs and never cleans up after itself. The
//          measurement below reports the split (`showcase-keyed N of M`) so the operator sees which
//          seeder produced what at run time instead of taking this comment's word for it.
//       c. ⭐ DECISIVE: `price_source IS NULL` on rows dated AFTER migration 0053 applied. 0053
//          (llm_price_source_and_model_pricing) applied 2026-07-29 20:08:20+00, and every row the
//          broker has written since carries a `price_source` (all 660 `local-llm` rows from
//          2026-07-30 onward read 'table'). Twelve of these claude rows are dated after that
//          timestamp and still have NULL `price_source`. That is impossible for a metered call.
//          They were INSERTed directly. This is asserted below as its own named precondition.
//       d. The spread is 4 users across 2 tenants — this fixture's member spread, not organic use.
//     878 rows total → 752 survivors, of which the 608 `stage='content-translation'` rows and the
//     92 genuine NULL-`price_source` `local-llm` rows (2026-06-08 → 2026-06-29, 62 distinct costs)
//     are asserted untouched. That last assertion is the load-bearing one: it is what proves the
//     predicate removed fabrications and not the real legacy ledger.
//
// Everything deleted is snapshotted into `_purge_20260809_<table>` inside the same transaction
// FIRST, so the operation is reversible with an INSERT … SELECT for as long as those tables are
// kept. Drop them only once the result has been reviewed on the live screens.
import postgres from 'postgres';
import { config } from '../src/config';
import { FABRICATED_CARD_TITLES } from '../src/db/seed-platform';

/** Measured on prod 2026-08-09. Every one of these is asserted before anything is deleted; a single
 *  mismatch aborts the whole transaction, because a mismatch means the database is not the database
 *  this script was reviewed against and its predicates can no longer be trusted to be precise. */
export const EXPECT = {
  // ⭐ audit_log is TWO-VALUED — see the runbook in the header. Pre-rollout the old image still has
  // its 12 seed-marked rows; post-rollout the new seeder's un-gated DELETE has already removed them.
  // The two are accepted as PAIRS (12 ⇔ 267, 0 ⇔ 255): a mismatched pair means something OTHER than
  // this rollout changed the table, and must still abort.
  auditTotalPreRollout: 267,
  auditSeededPreRollout: 12,
  auditTotalPostRollout: 255,
  auditSeededPostRollout: 0,
  auditSurvivors: 255, // the same in both states — that is the point
  pcTotal: 5,
  pcTom: 3,
  pcFabricated: 3, // by the exact-triple predicate; must equal pcTom or we abort (see FAB_CHANGES)
  pcSurvivors: 2,
  pcSurvivorDate: '2026-06-14',
  piTotal: 18,
  piNullSolution: 17,
  piBurst: 18, // ⭐ equal to piTotal — see the burst assertion below
  ueTotal: 878,
  ueFabricated: 126,
  uePerModel: 63,
  ueDistinctCosts: 2,
  ueFabricatedSpend: '1.386000',
  ueSurvivors: 752,
  ueTranslationSurvivors: 608,
  ueLegacyLocalSurvivors: 92,
  ueLegacyLocalDistinctCosts: 62,
};

export type Expectations = typeof EXPECT;

const TOM_EMAIL = 'tom@commonpractice.local';
const FR_TEST_EMAIL = 'fr-test@nonagentic.local';

// The one-burst window every pipeline_items row was inserted in (2026-06-07, ~2 seconds wide).
export const BURST_FROM = '2026-06-07 04:20:39+00';
export const BURST_TO = '2026-06-07 04:20:41+00';

/** The fabricated-usage predicate, written ONCE and reused by the measurement, the snapshot and the
 *  delete so those three can never drift apart.
 *
 *  It matches the two hard-coded fixture tuples WHOLE — provider + model + cost + tokens_in +
 *  tokens_out together — rather than intersecting loose `IN` lists. That matters: a real brokered
 *  call derives `cost_usd` FROM the token counts, so it can coincide with a fixture cost OR with a
 *  fixture token count, but reproducing the exact (cost, tokens_in, tokens_out) triple is what no
 *  metered call does by accident. Combined with `price_source IS NULL` (evidence c) this is the
 *  signature of a direct INSERT. Values are from seed-platform.ts `models` (~:474-477) and the
 *  byte-identical fixture in seed-tenant-showcase.ts (~:538) — both are swept, see header (4b). */
export const FAB_USAGE = `
  price_source IS NULL
  AND provider = 'anthropic'
  AND (
       (model = 'claude-sonnet-4-6' AND cost_usd = 0.018 AND tokens_in = 1200 AND tokens_out = 380)
    OR (model = 'claude-haiku-4-5'  AND cost_usd = 0.004 AND tokens_in = 800  AND tokens_out = 210)
  )`;

/** The fabricated-governance-change predicate: the THREE exact (policy_key, old_value, new_value)
 *  triples seed-platform.ts hard-codes, and only those. Deliberately NOT `changed_by = tom` — Tom is
 *  a real user who can make real governance changes, and this log is exactly where those would live.
 *  `changed_by` is still required, so a genuine change by someone ELSE that happened to restore the
 *  same values is not swept either. */
//  Parameterised by the expression that yields Tom's id, because the MEASUREMENT runs while
//  `_purge_measure` is still being created and so cannot read `tom_id` back out of it.
//
//  ⚠️ `promotion.required_reviewers` EXISTS IN TWO JSON ENCODINGS IN THE WILD, AND MATCHING ONLY
//  ONE SILENTLY ABORTS THE WHOLE RUN. `'1'::jsonb` is the NUMBER 1; `'"1"'::jsonb` is the STRING
//  "1"; they never compare equal. Both were measured with `jsonb_typeof` on 2026-08-09:
//
//      PROD (worker4)          promotion.required_reviewers  old=STRING "1"  new=STRING "2"
//      FRESHLY-SEEDED DB       promotion.required_reviewers  old=NUMBER 1    new=NUMBER 2
//
//  The seeder source writes the JS string `'1'` (`seed-platform.ts:566`), but `'1'` is also valid
//  JSON *text* for the number 1, and today's postgres-js/drizzle path parses it that way — so a
//  fresh seed lands a number while prod's older rows hold a string. Neither is "the" encoding, so
//  this matches BOTH: prod is where the purge runs, a fresh seed is where its tests run, and a
//  predicate that only fits one of them is a predicate that fails exactly where it is not being
//  watched. Matching both is safe — `changed_by = Tom` plus the exact key and the exact
//  old/new pair is already the narrowing; the encoding is not carrying any of the selectivity.
//
//  The other two keys are single-encoding and were checked individually — NOT generalised from one
//  row, which is how the number-only draft got written and why it matched 2 of 3, tripping the
//  `pc_fab <> pc_tom` cross-check below. Read the data per row.
//      spend.weekly_spend_ceiling  old=number 10  new=number 15
//      models.allowlist            old=array      new=array
export const fabChanges = (tomExpr: string) => `
  changed_by = ${tomExpr}
  AND (policy_key, old_value, new_value) IN (
    ('spend.weekly_spend_ceiling',   '10'::jsonb,  '15'::jsonb),
    ('models.allowlist',
       '["claude-sonnet-4-6", "claude-haiku-4-5"]'::jsonb,
       '["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]'::jsonb),
    ('promotion.required_reviewers', '"1"'::jsonb, '"2"'::jsonb),
    ('promotion.required_reviewers', '1'::jsonb,   '2'::jsonb)
  )`;

/** Tom's id as read back out of the measurement temp table (snapshot + delete phases). */
const TOM_FROM_MEASURE = '(SELECT tom_id FROM _purge_measure)';
/** Tom's id resolved inline by email (measurement phase, before _purge_measure exists). */
export const TOM_INLINE = `(SELECT id FROM users WHERE email = '${TOM_EMAIL}' ORDER BY id LIMIT 1)`;

/** Thrown to unwind the transaction on a dry run. Not an error — the expected exit for the default. */
class DryRunRollback extends Error {
  constructor() {
    super('dry run — rolling back');
  }
}

export interface Measurement {
  tom_n: number;
  frtest_n: number;
  audit_total: number;
  audit_seeded: number;
  pc_total: number;
  pc_tom: number;
  /** By the exact-triple FAB_CHANGES predicate. Must agree with `pc_tom` — see header (2). */
  pc_fab: number;
  pi_total: number;
  pi_null_sol: number;
  pi_burst: number;
  pi_unknown_title: number;
  ue_total: number;
  ue_fab: number;
  ue_fab_sonnet: number;
  ue_fab_haiku: number;
  ue_fab_distinct_costs: number;
  ue_fab_spend: string;
  ue_fab_after_0053: number;
  /** How many of the matched rows carry the SHOWCASE seeder's seed_key — reported, not asserted,
   *  so the operator sees the real split between the two identical fixtures. See header (4b). */
  ue_fab_showcase: number;
  ue_translation: number;
  ue_legacy_local: number;
  ue_legacy_local_distinct_costs: number;
}

export interface PurgeResult {
  committed: boolean;
  before: Measurement;
  after: { audit_total: number; pc_total: number; pi_total: number; ue_total: number };
}

export interface PurgeOpts {
  commit: boolean;
  databaseUrl?: string;
  /**
   * Override the prod-measured expectations. The CLI NEVER passes this — a real run always uses the
   * reviewed constants above. It exists so the load-bearing preconditions are TESTABLE AT ALL:
   * they are gated behind earlier checks against numbers that hold on exactly one database, so
   * without a seam a test could only ever observe the FIRST precondition firing, and deleting any
   * of the later ones — including the two marked ⭐, which are the only things authorising an
   * unqualified `DELETE FROM pipeline_items` and the deletion of 126 money rows — would leave the
   * suite green. Same injectable-seam reasoning as `SeedPlatformOpts.fabricate`.
   */
  expect?: Partial<Expectations>;
}

/**
 * Measure → assert → snapshot → delete → assert survivors, in ONE transaction.
 * `commit: false` (the default caller) rolls the whole thing back, so a dry run exercises every
 * assertion and every DELETE for real and still leaves the database byte-identical.
 */
export async function purge(opts: PurgeOpts): Promise<PurgeResult> {
  const E: Expectations = { ...EXPECT, ...(opts.expect ?? {}) };
  // The OWNER DSN: DDL for the snapshot tables, and an RLS-free view of every tenant's rows.
  const sql = postgres(opts.databaseUrl ?? config.database.migrateUrl, { max: 1, onnotice: () => {} });
  let result: PurgeResult | null = null;
  try {
    await sql.begin(async (tx) => {
      // ---- 0. the fixture's own title list, so the debris check compares against the SEEDER
      //         rather than a second hard-coded copy that could drift away from it. ----
      await tx`CREATE TEMP TABLE _purge_card_titles (title text) ON COMMIT DROP`;
      await tx`INSERT INTO _purge_card_titles ${tx(
        FABRICATED_CARD_TITLES.map((title) => ({ title })),
        'title',
      )}`;

      // ---- 1. measure into a temp table ----
      // Everything downstream reads its identities and predicates out of THIS row, so the numbers
      // asserted, the rows snapshotted and the rows deleted are guaranteed to be the same set.
      // Tom's and fr-test's ids are resolved by EMAIL at runtime rather than hard-coded, and the
      // resolution is asserted below to have found exactly one of each.
      await tx.unsafe(`
        CREATE TEMP TABLE _purge_measure ON COMMIT DROP AS
        SELECT
          (SELECT count(*)::int FROM users WHERE email = '${TOM_EMAIL}')                    AS tom_n,
          (SELECT count(*)::int FROM users WHERE email = '${FR_TEST_EMAIL}')                AS frtest_n,
          (SELECT id FROM users WHERE email = '${TOM_EMAIL}' ORDER BY id LIMIT 1)           AS tom_id,
          (SELECT id FROM users WHERE email = '${FR_TEST_EMAIL}' ORDER BY id LIMIT 1)       AS frtest_id,
          (SELECT count(*)::int FROM audit_log)                                             AS audit_total,
          (SELECT count(*)::int FROM audit_log
             WHERE metadata @> '{"seed":true}'::jsonb)                                      AS audit_seeded,
          (SELECT count(*)::int FROM policy_changes)                                        AS pc_total,
          (SELECT count(*)::int FROM policy_changes WHERE changed_by = ${TOM_INLINE})       AS pc_tom,
          (SELECT count(*)::int FROM policy_changes
             WHERE ${fabChanges(TOM_INLINE)})                                               AS pc_fab,
          (SELECT count(*)::int FROM pipeline_items)                                        AS pi_total,
          (SELECT count(*)::int FROM pipeline_items WHERE solution_id IS NULL)              AS pi_null_sol,
          (SELECT count(*)::int FROM pipeline_items
             WHERE week = '2026-W21'
               AND created_at BETWEEN TIMESTAMPTZ '${BURST_FROM}'
                                  AND TIMESTAMPTZ '${BURST_TO}')                            AS pi_burst,
          (SELECT count(*)::int FROM pipeline_items p
             WHERE NOT EXISTS (SELECT 1 FROM _purge_card_titles c
                               WHERE c.title = p.title))                                    AS pi_unknown_title,
          (SELECT count(*)::int FROM usage_events)                                          AS ue_total,
          (SELECT count(*)::int FROM usage_events WHERE ${FAB_USAGE})                       AS ue_fab,
          (SELECT count(*)::int FROM usage_events
             WHERE ${FAB_USAGE} AND model = 'claude-sonnet-4-6')                            AS ue_fab_sonnet,
          (SELECT count(*)::int FROM usage_events
             WHERE ${FAB_USAGE} AND model = 'claude-haiku-4-5')                             AS ue_fab_haiku,
          (SELECT count(DISTINCT cost_usd)::int FROM usage_events
             WHERE ${FAB_USAGE})                                                            AS ue_fab_distinct_costs,
          (SELECT COALESCE(sum(cost_usd), 0)::numeric(12,6) FROM usage_events
             WHERE ${FAB_USAGE})                                                            AS ue_fab_spend,
          -- ⭐ The decisive measurement: a metered broker call made after 0053 applied ALWAYS
          -- stamps price_source. A matched row NEWER than 0053 that is still NULL was INSERTed
          -- directly — proof these are seeder output, not real mispriced broker calls.
          (SELECT count(*)::int FROM usage_events
             WHERE ${FAB_USAGE}
               AND created_at > (SELECT applied_at FROM _migrations
                                 WHERE filename LIKE '0053%' ORDER BY filename LIMIT 1))    AS ue_fab_after_0053,
          (SELECT count(*)::int FROM usage_events
             WHERE ${FAB_USAGE} AND seed_key LIKE 'showcase:%')                             AS ue_fab_showcase,
          (SELECT count(*)::int FROM usage_events
             WHERE stage = 'content-translation')                                           AS ue_translation,
          (SELECT count(*)::int FROM usage_events
             WHERE price_source IS NULL AND model = 'local-llm')                            AS ue_legacy_local,
          (SELECT count(DISTINCT cost_usd)::int FROM usage_events
             WHERE price_source IS NULL AND model = 'local-llm')                            AS ue_legacy_local_distinct_costs
      `);

      const [before] = (await tx`SELECT * FROM _purge_measure`) as unknown as Measurement[];
      report('BEFORE', before!);

      // ---- 2. preconditions. RAISE EXCEPTION unless this database is the one the script was
      //         reviewed against; each check names what it protects so a failure self-explains. ----
      await tx.unsafe(`
        DO $$
        DECLARE m record;
        BEGIN
          SELECT * INTO m FROM _purge_measure;

          -- identities: resolved by email, and there must be EXACTLY ONE of each
          IF m.tom_n <> 1 THEN
            RAISE EXCEPTION 'precondition: expected exactly 1 user <${TOM_EMAIL}>, found %', m.tom_n;
          END IF;
          IF m.frtest_n <> 1 THEN
            RAISE EXCEPTION 'precondition: expected exactly 1 user <${FR_TEST_EMAIL}>, found %', m.frtest_n;
          END IF;

          -- ⭐ audit_log is TWO-VALUED. This script may run either BEFORE the rollout of the gate
          -- (old image still live: 267 total / 12 seed-marked) or AFTER it (the new seeder's
          -- UN-gated scoped DELETE has already removed the 12 on first boot: 255 total / 0). Pinning
          -- one pair would make the script abort on its own deployment and strand the other 147
          -- fabricated rows — including the $1.386 of invented spend. The pair must AGREE, though:
          -- 12-with-255 or 0-with-267 means something OTHER than this rollout moved the table, and
          -- that must still abort. The survivor assertion is 255 in BOTH cases.
          IF m.audit_seeded = ${E.auditSeededPreRollout} AND m.audit_total = ${E.auditTotalPreRollout} THEN
            RAISE NOTICE 'purge: PRE-ROLLOUT audit_log state (total=%, seed-marked=%) — the old image is still seeding; this run removes all 12', m.audit_total, m.audit_seeded;
          ELSIF m.audit_seeded = ${E.auditSeededPostRollout} AND m.audit_total = ${E.auditTotalPostRollout} THEN
            RAISE NOTICE 'purge: POST-ROLLOUT audit_log state (total=%, seed-marked=%) — the new seeder''s un-gated DELETE already removed the 12; this run removes 0 from audit_log and proceeds to the other 147 rows', m.audit_total, m.audit_seeded;
          ELSE
            RAISE EXCEPTION 'precondition: audit_log must be either (total=${E.auditTotalPreRollout}, seed-marked=${E.auditSeededPreRollout}) pre-rollout or (total=${E.auditTotalPostRollout}, seed-marked=${E.auditSeededPostRollout}) post-rollout, found (total=%, seed-marked=%)', m.audit_total, m.audit_seeded;
          END IF;

          -- policy_changes
          IF m.pc_total <> ${E.pcTotal} THEN
            RAISE EXCEPTION 'precondition: policy_changes total expected ${E.pcTotal}, found %', m.pc_total;
          END IF;
          IF m.pc_tom <> ${E.pcTom} THEN
            RAISE EXCEPTION 'precondition: policy_changes by Tom expected ${E.pcTom}, found %', m.pc_tom;
          END IF;
          IF m.pc_fab <> ${E.pcFabricated} THEN
            RAISE EXCEPTION 'precondition: policy_changes matching the three fabricated value-triples expected ${E.pcFabricated}, found %', m.pc_fab;
          END IF;
          -- ⭐ The cross-check the counts alone cannot make. If one fabricated row were hand-deleted
          -- and Tom then made ONE GENUINE governance change, pc_tom would still read 3 — and a
          -- changed_by-only delete would eat his real change while every survivor check passed.
          -- Requiring the by-Tom set and the by-triple set to be the same SIZE catches exactly that.
          IF m.pc_fab <> m.pc_tom THEN
            RAISE EXCEPTION 'precondition: Tom has % policy_changes but only % match the fabricated value-triples — he appears to have made a REAL governance change, REFUSING to delete', m.pc_tom, m.pc_fab;
          END IF;

          -- pipeline_items. ⭐ THE ASSERTION THAT MAKES THE FULL-TABLE DELETE SAFE: the one-burst
          -- set is the ENTIRE table (burst = total = 18). There is not one real card on that board,
          -- so no real card can be swept up. This SUBSUMES the weaker "the 17 NULL-solution_id rows
          -- are the same 17 as the burst set" check: solution_id is ON DELETE SET NULL, so a REAL
          -- card whose solution was later deleted would ALSO read NULL, and matching the two sets
          -- is what would have been needed to rule that out. Proving burst = total rules it out
          -- outright. The null-count and title checks below are belt-and-braces on top.
          IF m.pi_total <> ${E.piTotal} THEN
            RAISE EXCEPTION 'precondition: pipeline_items total expected ${E.piTotal}, found %', m.pi_total;
          END IF;
          IF m.pi_burst <> m.pi_total THEN
            RAISE EXCEPTION 'precondition: the pipeline_items one-burst set (%) is NOT the whole table (%) — a REAL card may exist, REFUSING to delete', m.pi_burst, m.pi_total;
          END IF;
          IF m.pi_burst <> ${E.piBurst} THEN
            RAISE EXCEPTION 'precondition: pipeline_items burst set expected ${E.piBurst}, found %', m.pi_burst;
          END IF;
          IF m.pi_null_sol <> ${E.piNullSolution} THEN
            RAISE EXCEPTION 'precondition: pipeline_items with NULL solution_id expected ${E.piNullSolution}, found %', m.pi_null_sol;
          END IF;
          IF m.pi_unknown_title <> 0 THEN
            RAISE EXCEPTION 'precondition: % pipeline_items row(s) carry a title that is NOT in the seeder CARDS fixture — REFUSING to delete', m.pi_unknown_title;
          END IF;

          -- usage_events
          IF m.ue_total <> ${E.ueTotal} THEN
            RAISE EXCEPTION 'precondition: usage_events total expected ${E.ueTotal}, found %', m.ue_total;
          END IF;
          IF m.ue_fab <> ${E.ueFabricated} THEN
            RAISE EXCEPTION 'precondition: fabricated usage_events expected ${E.ueFabricated}, found %', m.ue_fab;
          END IF;
          IF m.ue_fab_sonnet <> ${E.uePerModel} OR m.ue_fab_haiku <> ${E.uePerModel} THEN
            RAISE EXCEPTION 'precondition: expected ${E.uePerModel} rows per claude model, found sonnet=% haiku=%', m.ue_fab_sonnet, m.ue_fab_haiku;
          END IF;
          -- Evidence (a): ONE distinct cost per model across all 126 rows. A real broker derives
          -- cost from token counts — the genuine local-llm ledger has ${E.ueLegacyLocalDistinctCosts} distinct costs over ${E.ueLegacyLocalSurvivors} rows.
          IF m.ue_fab_distinct_costs <> ${E.ueDistinctCosts} THEN
            RAISE EXCEPTION 'precondition: expected exactly ${E.ueDistinctCosts} distinct cost_usd values across the fabricated set, found %', m.ue_fab_distinct_costs;
          END IF;
          -- ⭐ Evidence (c), the decisive "these are NOT broker output" proof: at least one matched
          -- row postdates migration 0053, after which every real metered call stamps price_source.
          -- A newer-than-0053 row with a NULL price_source cannot have come through the broker.
          -- If this does not hold, the whole classification is in doubt and we must not delete.
          IF m.ue_fab_after_0053 < 1 THEN
            RAISE EXCEPTION 'precondition: NO matched usage_event postdates migration 0053 — the decisive "not broker output" proof does not hold on this database, REFUSING to delete';
          END IF;
          IF m.ue_fab_spend <> ${E.ueFabricatedSpend}::numeric THEN
            RAISE EXCEPTION 'precondition: fabricated spend expected ${E.ueFabricatedSpend}, found %', m.ue_fab_spend;
          END IF;
          -- The REAL ledger this delete must not touch, measured before so it can be re-measured after.
          IF m.ue_translation <> ${E.ueTranslationSurvivors} THEN
            RAISE EXCEPTION 'precondition: content-translation usage_events expected ${E.ueTranslationSurvivors}, found %', m.ue_translation;
          END IF;
          IF m.ue_legacy_local <> ${E.ueLegacyLocalSurvivors} THEN
            RAISE EXCEPTION 'precondition: genuine legacy local-llm usage_events expected ${E.ueLegacyLocalSurvivors}, found %', m.ue_legacy_local;
          END IF;
          IF m.ue_legacy_local_distinct_costs <> ${E.ueLegacyLocalDistinctCosts} THEN
            RAISE EXCEPTION 'precondition: genuine legacy local-llm distinct costs expected ${E.ueLegacyLocalDistinctCosts}, found %', m.ue_legacy_local_distinct_costs;
          END IF;
        END $$;
      `);

      // ---- 3. snapshot FIRST, then delete. Plain SQL, not plpgsql: CREATE TABLE AS is a UTILITY
      //         statement, and plpgsql does NOT substitute variables into utility statements — so
      //         every predicate reads its identity straight out of _purge_measure instead. ----
      await tx.unsafe(`
        CREATE TABLE _purge_20260809_audit_log AS
        SELECT * FROM audit_log WHERE metadata @> '{"seed":true}'::jsonb`);
      await tx.unsafe(`
        CREATE TABLE _purge_20260809_policy_changes AS
        SELECT * FROM policy_changes WHERE ${fabChanges(TOM_FROM_MEASURE)}`);
      // ALL 18 — the burst assertion above proved the debris set IS the table.
      await tx.unsafe(`
        CREATE TABLE _purge_20260809_pipeline_items AS
        SELECT * FROM pipeline_items`);
      await tx.unsafe(`
        CREATE TABLE _purge_20260809_usage_events AS
        SELECT * FROM usage_events WHERE ${FAB_USAGE}`);

      // ---- 4. delete + GET DIAGNOSTICS + survivor assertions, in ONE plpgsql block so a wrong
      //         row count aborts before the next statement can run. ----
      await tx.unsafe(`
        DO $$
        DECLARE n int; bad int; want_audit int;
        BEGIN
          -- The audit expectation is whatever the two-state precondition already VALIDATED as legal
          -- (12 pre-rollout, 0 post-rollout), not a second hard-coded constant that could disagree
          -- with it. Reading it back out of the measurement is what keeps the two in step.
          SELECT audit_seeded INTO want_audit FROM _purge_measure;
          DELETE FROM audit_log WHERE metadata @> '{"seed":true}'::jsonb;
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n <> want_audit THEN
            RAISE EXCEPTION 'delete: audit_log removed % row(s), expected % (the measured seed-marked count)', n, want_audit;
          END IF;

          DELETE FROM policy_changes WHERE ${fabChanges(TOM_FROM_MEASURE)};
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n <> ${E.pcFabricated} THEN
            RAISE EXCEPTION 'delete: policy_changes removed % row(s), expected ${E.pcFabricated}', n;
          END IF;

          DELETE FROM pipeline_items;
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n <> ${E.piTotal} THEN
            RAISE EXCEPTION 'delete: pipeline_items removed % row(s), expected ${E.piTotal}', n;
          END IF;

          DELETE FROM usage_events WHERE ${FAB_USAGE};
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n <> ${E.ueFabricated} THEN
            RAISE EXCEPTION 'delete: usage_events removed % row(s), expected ${E.ueFabricated}', n;
          END IF;

          -- ---------------- survivors ----------------
          SELECT count(*)::int INTO n FROM audit_log;
          IF n <> ${E.auditSurvivors} THEN
            RAISE EXCEPTION 'survivor: audit_log left % row(s), expected ${E.auditSurvivors}', n;
          END IF;

          SELECT count(*)::int INTO n FROM policy_changes;
          IF n <> ${E.pcSurvivors} THEN
            RAISE EXCEPTION 'survivor: policy_changes left % row(s), expected ${E.pcSurvivors}', n;
          END IF;
          -- Every surviving governance change must be the genuine fr-test one from ${E.pcSurvivorDate}.
          SELECT count(*)::int INTO bad FROM policy_changes
            WHERE changed_by IS DISTINCT FROM (SELECT frtest_id FROM _purge_measure)
               OR created_at::date <> DATE '${E.pcSurvivorDate}';
          IF bad <> 0 THEN
            RAISE EXCEPTION 'survivor: % policy_changes row(s) are not the expected fr-test / ${E.pcSurvivorDate} change', bad;
          END IF;

          SELECT count(*)::int INTO n FROM pipeline_items;
          IF n <> 0 THEN
            RAISE EXCEPTION 'survivor: pipeline_items left % row(s), expected 0', n;
          END IF;

          SELECT count(*)::int INTO n FROM usage_events;
          IF n <> ${E.ueSurvivors} THEN
            RAISE EXCEPTION 'survivor: usage_events left % row(s), expected ${E.ueSurvivors}', n;
          END IF;
          SELECT count(*)::int INTO n FROM usage_events WHERE model LIKE 'claude%';
          IF n <> 0 THEN
            RAISE EXCEPTION 'survivor: % claude-model usage_event(s) remain, expected 0', n;
          END IF;
          -- ⭐ THE LOAD-BEARING SURVIVOR ASSERTION: the REAL ledger is untouched. The translation
          -- backfill's rows and the genuine legacy local-llm rows (with their ${E.ueLegacyLocalDistinctCosts} distinct,
          -- token-derived costs) must be exactly as many as they were before the delete. This is
          -- what proves the predicate removed fabrications and not the real append-only ledger.
          SELECT count(*)::int INTO n FROM usage_events WHERE stage = 'content-translation';
          IF n <> ${E.ueTranslationSurvivors} THEN
            RAISE EXCEPTION 'survivor: content-translation usage_events left %, expected ${E.ueTranslationSurvivors} — the REAL ledger was touched', n;
          END IF;
          SELECT count(*)::int INTO n FROM usage_events WHERE price_source IS NULL AND model = 'local-llm';
          IF n <> ${E.ueLegacyLocalSurvivors} THEN
            RAISE EXCEPTION 'survivor: genuine legacy local-llm usage_events left %, expected ${E.ueLegacyLocalSurvivors} — the REAL ledger was touched', n;
          END IF;
          SELECT count(DISTINCT cost_usd)::int INTO n FROM usage_events WHERE price_source IS NULL AND model = 'local-llm';
          IF n <> ${E.ueLegacyLocalDistinctCosts} THEN
            RAISE EXCEPTION 'survivor: genuine legacy local-llm distinct costs left %, expected ${E.ueLegacyLocalDistinctCosts} — the REAL ledger was touched', n;
          END IF;
        END $$;
      `);

      const [after] = (await tx`
        SELECT
          (SELECT count(*)::int FROM audit_log)      AS audit_total,
          (SELECT count(*)::int FROM policy_changes) AS pc_total,
          (SELECT count(*)::int FROM pipeline_items) AS pi_total,
          (SELECT count(*)::int FROM usage_events)   AS ue_total
      `) as unknown as PurgeResult['after'][];
      console.log(
        `[purge] AFTER  audit_log=${after!.audit_total} policy_changes=${after!.pc_total} ` +
          `pipeline_items=${after!.pi_total} usage_events=${after!.ue_total}`,
      );

      result = { committed: opts.commit, before: before!, after: after! };
      if (!opts.commit) throw new DryRunRollback();
    });
    console.log(
      '[purge] COMMITTED. Snapshots kept in ' +
        '_purge_20260809_{audit_log,policy_changes,pipeline_items,usage_events} — drop them only ' +
        'once the live screens have been reviewed.',
    );
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    console.log(
      '[purge] DRY RUN — transaction rolled back. Nothing changed, and no snapshot tables were left\n' +
        '[purge] behind (CREATE TABLE is transactional). Re-run with --commit to apply.',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  return result!;
}

function report(label: string, m: Measurement): void {
  console.log(
    `[purge] ${label} audit_log=${m.audit_total} (seed-marked ${m.audit_seeded}) ` +
      `policy_changes=${m.pc_total} (tom ${m.pc_tom}, fabricated-triples ${m.pc_fab}) ` +
      `pipeline_items=${m.pi_total} (burst ${m.pi_burst}, null-solution ${m.pi_null_sol}, off-fixture titles ${m.pi_unknown_title}) ` +
      `usage_events=${m.ue_total} (fabricated ${m.ue_fab} = ${m.ue_fab_sonnet} sonnet + ${m.ue_fab_haiku} haiku, ` +
      `$${m.ue_fab_spend}, ${m.ue_fab_after_0053} post-0053, ${m.ue_fab_showcase} showcase-keyed of ${m.ue_fab} ` +
      `[remainder = seed-platform, which stamps no seed_key]; ` +
      `translation ${m.ue_translation}, legacy local-llm ${m.ue_legacy_local})`,
  );
}

function redact(dsn: string): string {
  try {
    const u = new URL(dsn);
    u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable dsn>';
  }
}

if (import.meta.main) {
  const commit = process.argv.includes('--commit');
  if (commit && process.argv.includes('--dry-run')) {
    throw new Error('pass --commit OR --dry-run (the default), not both');
  }
  if (!config.database.migrateUrlExplicit) {
    console.warn(
      '[purge] MIGRATE_DATABASE_URL is not set — falling back to DATABASE_URL. The snapshot tables ' +
        'need DDL rights, so set the OWNER DSN explicitly.',
    );
  }
  console.log(
    `[purge] mode=${commit ? 'COMMIT' : 'dry-run (default)'} target=${redact(config.database.migrateUrl)}`,
  );
  await purge({ commit });
  process.exit(0);
}
