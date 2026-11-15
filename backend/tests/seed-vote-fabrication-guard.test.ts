// tests/seed-vote-fabrication-guard.test.ts — the two marketplace seeders must not INSERT a
// `votes_count` nobody voted. Migration 0064 corrects the rows that exist; this file is the half
// that stops them coming back on the next fresh tenant.
//
// ⛔ THE TRAP THAT WOULD MAKE THIS FILE WORTHLESS — the same one seed-fabrication-guard.test.ts
// opens with, restated because it is the single easiest way to write eight green tests that assert
// nothing. `config.ts` sets `seedFabricatedTelemetry` TRUE whenever `NODE_ENV !== 'production'`,
// and tests run with NODE_ENV=test. A test that just calls `seedTenantShowcase(id)` therefore
// exercises the UN-GATED branch and would stay green with the clamp deleted. Every assertion below
// that is about the GATE runs against SV_OFF, seeded with `{ fabricate: false }` EXPLICITLY. SV6 is
// the deliberate exception and says so.
//
// ⚠️ SCOPE OF THE INVARIANT (SV3). The honest statement is "no row anywhere shows more votes than
// were cast", but this suite's shared database is full of rows that deliberately break it — a dozen
// files INSERT `votes_count: 4321` / `999` / `100 - rank` with no `votes` rows at all, as pure
// ordering fixtures. So SV3 is scoped to the tenant THIS FILE seeded. That is not a weakened claim:
// it is the claim about the seeder, which is the thing under test. The unscoped, whole-database
// version of the same invariant is migration 0064's own post-condition guard, exercised against a
// clean database in vote-count-reconciliation.test.ts.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  challenges,
  solutions,
  votes,
  weeklyWinners,
  runAsSystem,
} from '../src/db/client';
import { seedTenantShowcase, type ShowcaseResult } from '../src/db/seed-tenant-showcase';
import { showcaseWeeks } from '../src/db/seed-marketplace';
import { seedMarketplace } from '../src/db/seed-marketplace';
import { periodSolutionStats } from '../src/host/cycle-eligibility';
import { config, DEMO_TENANT_ID } from '../src/config';
import { flagUnder } from './config-flag-probe';

// ---------------------------------------------------------------------------------------------
// Two showcase tenants, seeded once. ⚠️ The ids must differ within their FIRST 24 hex digits:
// `ensureTenant` derives `slug` as `t-<hex>.slice(0, 24)`, so two ids differing only in their tail
// would collide on the unique slug and the second seed would fail on an unrelated constraint.
// ---------------------------------------------------------------------------------------------

const SV_OFF = '00000000-0000-4000-8000-c65a00000001'; // seeded with { fabricate: false }
const SV_ON = '00000000-0000-4000-8000-c65b00000002'; // seeded with the CONFIG DEFAULT (= true)

// ⛔ DERIVED, NEVER A LITERAL — it must track the seed, and the seed no longer has a fixed week.
// This used to be `'2026-W23'`, mirroring `seed-tenant-showcase.ts`'s hardcoded `WINNER_WEEK`. That
// literal is why demo content arrived 13 weeks stale and why the challenge board emptied itself, so
// the seed now derives its week from `now()` via `showcaseWeeks`. Computing it here the SAME way
// keeps the assertion at SV5 (`offResult.winnerWeek === WEEK`) meaningful: it is now a real drift
// check between what the seed emitted and the shared helper, instead of two copies of one literal.
const WEEK = showcaseWeeks(new Date()).winnerWeek;

/** The showcase fixture, by title. `real` is how many of its 8 genuine `votes` rows point here. */
const CH = {
  claims: { title: 'Auto-summarize claim forms', fabricated: 312, real: 2 },
  renewals: { title: 'Draft renewal letters from policy data', fabricated: 198, real: 0 },
  inbox: { title: 'Auto-categorize the shared service inbox', fabricated: 176, real: 1 },
  contracts: { title: 'Compliance pre-check on contract edits', fabricated: 154, real: 1 },
  churn: { title: 'Churn-risk digest per segment', fabricated: 132, real: 1 },
  broker: { title: 'Reconcile broker payment files', fabricated: 88, real: 0 },
} as const;

const SOL = {
  sara: { title: 'Streaming summarizer with OCR fallback', fabricated: 316, real: 2 },
  noah: { title: 'Inline review queue for associates', fabricated: 271, real: 1 },
  liam: { title: 'Multi-template field extractor', fabricated: 233, real: 0 },
  yuki: { title: 'Low-code variant with audit log', fabricated: 188, real: 0 },
} as const;

let offResult: ShowcaseResult;

async function challengeVotes(tenantId: string, title: string): Promise<number> {
  const [row] = await db
    .select({ n: challenges.votes_count })
    .from(challenges)
    .where(and(eq(challenges.tenant_id, tenantId), eq(challenges.title, title)));
  expect(row, `showcase challenge "${title}" missing from tenant ${tenantId}`).toBeDefined();
  return row!.n;
}

async function solutionVotes(tenantId: string, title: string): Promise<number> {
  const [row] = await db
    .select({ n: solutions.votes_count })
    .from(solutions)
    .where(and(eq(solutions.tenant_id, tenantId), eq(solutions.title, title)));
  expect(row, `showcase solution "${title}" missing from tenant ${tenantId}`).toBeDefined();
  return row!.n;
}

/**
 * Remove both showcase tenants' marketplace rows.
 *
 * ⛔ NOT TIDINESS — WITHOUT THIS, EVERY GATE TEST IN THIS FILE IS A FALSE GREEN ON THE SECOND RUN.
 * The seeder is idempotent by (tenant, title), so on a database that already holds these rows the
 * INSERT path — the only place the clamp lives — is never reached, and SV1/SV3/SV4 would happily
 * re-read the 0s a PREVIOUS run wrote while the clamp sat deleted. (It also makes SV5's
 * `challengesCreated` a real delta rather than 0.) `challenges` cascades to `solutions` and thence
 * to `weekly_winners`; `votes` carries no FK to its polymorphic target, so it goes explicitly.
 */
async function purgeShowcaseTenants(): Promise<void> {
  await db.execute(sql`DELETE FROM votes WHERE tenant_id IN (${SV_OFF}, ${SV_ON})`);
  await db.execute(sql`DELETE FROM weekly_winners WHERE tenant_id IN (${SV_OFF}, ${SV_ON})`);
  await db.execute(sql`DELETE FROM challenges WHERE tenant_id IN (${SV_OFF}, ${SV_ON})`);
}

beforeAll(async () => {
  await runAsSystem('boot-seed', purgeShowcaseTenants);
  offResult = await runAsSystem('boot-seed', () => seedTenantShowcase(SV_OFF, { fabricate: false }));
  await runAsSystem('boot-seed', () => seedTenantShowcase(SV_ON));
}, 180_000);

afterAll(async () => {
  // ⚠️ REQUIRED, not tidiness. `ensureMembers` RE-HOMES the six `*.fr-demo@` users and the fr-test
  // user onto whatever tenant it was called with, on EVERY call — so the two seeds above left them
  // pointing at SV_ON. Put them back on the demo tenant, exactly as boot does, or the next file to
  // read them sees a workspace this file moved.
  await runAsSystem('boot-seed', () => seedTenantShowcase(DEMO_TENANT_ID));
  // Leave no showcase rows behind: the next run must reach the INSERT path (see purge comment).
  await runAsSystem('boot-seed', purgeShowcaseTenants);
}, 180_000);

// ---------------------------------------------------------------------------------------------
// SV1 / SV2 — the clamp, one test per seeder.
// ---------------------------------------------------------------------------------------------

test('SV1: the SHOWCASE seeder clamps votes_count to 0 on rows nobody voted on', async () => {
  // ⛔ 0 IS NOT A PLACEHOLDER. At INSERT time the row does not exist, so nothing can have voted on
  // it and its real vote count is provably 0. These four rows receive none of the seeder's 8
  // genuine votes, so 0 is where they correctly stay.
  // REVERT THAT REDS THIS: change either `votes_count: fabricate ? … : 0` in
  // seed-tenant-showcase.ts back to `votes_count: c.votes` / `s.votes` → 198/88/233/188 come back.
  expect(await challengeVotes(SV_OFF, CH.renewals.title)).toBe(0);
  expect(await challengeVotes(SV_OFF, CH.broker.title)).toBe(0);
  expect(await solutionVotes(SV_OFF, SOL.liam.title)).toBe(0);
  expect(await solutionVotes(SV_OFF, SOL.yuki.title)).toBe(0);
}, 30_000);

test('SV2: the MARKETPLACE seeder clamps votes_count to 0 on the INSERT path', async () => {
  // seedMarketplace is idempotent by TITLE and its five challenges already exist on this shared
  // database, so `{fabricate:false}` would create nothing and assert nothing. The row has to be
  // removed first — the same `withEmptied` reachability point seed-fabrication-guard.test.ts makes
  // for policy_changes and pipeline_items. 'Visibility into churn signals per segment' is the one
  // safe choice: nothing hangs off it (solutions, comments and the winner all anchor to CH-284).
  //
  // ⚠️ BOUNDED RETRY, and it cannot mask a regression. seed-marketplace-winner.test.ts calls
  // `seedMarketplace()` (fabrication ON) four times against the same shared database, so this row
  // can be back at 162 when we read it. (⚠️ CORRECTED 2026-08-16: this said the two files RACE
  // because "bun runs files concurrently". They do not run concurrently — canonical note at the
  // top of tests/metering-platform-calls.test.ts. The overlap that remains is sequential: a seed
  // an earlier file left behind, or work it leaked past its own end.) Retrying is the narrowest
  // fix; a genuinely deleted clamp reads 162 on all four attempts and the throw below names which
  // happened. Same pattern, same reason, as `meteredCall` in
  // usage-metrics-platform.test.ts:100-127.
  const TITLE = 'Visibility into churn signals per segment';
  const [saved] = await db.select().from(challenges).where(eq(challenges.title, TITLE));
  expect(saved, `seed anchor challenge "${TITLE}" is missing — seedMarketplace() drifted`).toBeDefined();
  if (!saved) throw new Error('unreachable: asserted defined above');

  let seen = -1;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await db.delete(challenges).where(eq(challenges.id, saved.id));
      await runAsSystem('boot-seed', () => seedMarketplace({ fabricate: false }));
      const [fresh] = await db
        .select({ id: challenges.id, n: challenges.votes_count })
        .from(challenges)
        .where(eq(challenges.title, TITLE));
      expect(fresh, 'seedMarketplace({fabricate:false}) created no challenge at all — the gate is ' +
        'not supposed to skip CONTENT, only the invented measurement on it').toBeDefined();
      seen = fresh!.n;
      if (seen === 0) break;
      await db.delete(challenges).where(eq(challenges.id, fresh!.id));
    }
    expect(
      seen,
      'seedMarketplace INSERTed a fabricated votes_count on all 4 attempts. Either the clamp at ' +
        'seed-marketplace.ts is gone, or a concurrent fabricating seed won the race every time — ' +
        'the former is the regression this test exists for.',
    ).toBe(0);
  } finally {
    // Restore the ORIGINAL row, id and all, so the content_translations keyed to that id (and any
    // reader mid-flight) find what they had. A re-seed would mint a new id instead.
    await db.delete(challenges).where(eq(challenges.title, TITLE));
    await db.insert(challenges).values(saved);
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------
// SV3 — the whole point, as ONE assertion.
// ---------------------------------------------------------------------------------------------

test('SV3: after a fabrication-off seed, NO row shows more votes than were cast', async () => {
  // Every other test here checks a number. This checks the PROPERTY, so a future fixture row added
  // to either seeder is covered without anyone remembering to extend a list. Scoped to the tenant
  // this file seeded — see the header for why the unscoped version cannot run on a shared database.
  // REVERT THAT REDS THIS: any un-clamped `votes_count` in either seeder's INSERT.
  const over = await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT c.id FROM challenges c
       WHERE c.tenant_id = ${SV_OFF}
         AND c.votes_count > (SELECT count(*) FROM votes v
                               WHERE v.target_type = 'challenge' AND v.target_id = c.id)
      UNION ALL
      SELECT s.id FROM solutions s
       WHERE s.tenant_id = ${SV_OFF}
         AND s.votes_count > (SELECT count(*) FROM votes v
                               WHERE v.target_type = 'solution' AND v.target_id = s.id)
    ) x`);
  expect((over as unknown as { n: number }[])[0]!.n).toBe(0);

  // …and not vacuously: the seeder really did create rows in this tenant.
  const rows = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM challenges WHERE tenant_id = ${SV_OFF})
         + (SELECT count(*)::int FROM solutions  WHERE tenant_id = ${SV_OFF}) AS n`)) as unknown as {
    n: number;
  }[];
  expect(rows[0]!.n).toBe(10);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// SV4 — the un-gated recount.
// ---------------------------------------------------------------------------------------------

test('SV4: the voteSpecs targets read their REAL counts, not 0', async () => {
  // ⛔ THE CLAMP ALONE WOULD SHIP A NEW DRIFT IN THE OPPOSITE DIRECTION. The seeder inserts 8
  // GENUINE `votes` rows with a raw `db.insert(votes)` that bypasses castVote (deliberately — the
  // gates would reject them), so nothing bumps `votes_count`. Clamped to 0 and never incremented,
  // these six rows would show 0 against real votes on every fresh tenant, forever, and 0064 would
  // have to be re-run after every boot. `recountVotes` after the loop is what closes it.
  //
  // REVERT THAT REDS THIS: delete the two `recountVotes(...)` calls after the voteSpecs loop in
  // seed-tenant-showcase.ts → all six of these read 0.
  expect(await challengeVotes(SV_OFF, CH.claims.title)).toBe(CH.claims.real);
  expect(await challengeVotes(SV_OFF, CH.inbox.title)).toBe(CH.inbox.real);
  expect(await challengeVotes(SV_OFF, CH.contracts.title)).toBe(CH.contracts.real);
  expect(await challengeVotes(SV_OFF, CH.churn.title)).toBe(CH.churn.real);
  expect(await solutionVotes(SV_OFF, SOL.sara.title)).toBe(SOL.sara.real);
  expect(await solutionVotes(SV_OFF, SOL.noah.title)).toBe(SOL.noah.real);

  // The counts above are REAL, i.e. there are genuinely that many rows in `votes`.
  const voteRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM votes WHERE tenant_id = ${SV_OFF}`)) as unknown as { n: number }[];
  expect(voteRows[0]!.n).toBe(8);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// SV5 — configuration is not measurement.
// ---------------------------------------------------------------------------------------------

test('SV5: fabrication OFF still creates every row — only the invented number is withheld', async () => {
  // The line config.ts draws is between "declare what exists" and "assert a measurement". A gate
  // that also stopped the CONTENT would make the flag unusable in prod (which runs the showcase
  // seeder) and would be the wrong fix: the challenge is real, the 312 is not.
  // REVERT THAT REDS THIS: wrap the challenge/solution INSERT loops in `if (fabricate)`.
  expect(offResult.challengesCreated).toBe(6);
  expect(offResult.solutionsCreated).toBe(4);
  expect(offResult.members).toBe(6);
  expect(offResult.sandboxes).toBe(6);
  expect(offResult.winnerWeek).toBe(WEEK);
  const winners = (await db.execute(sql`
    SELECT count(*)::int AS n FROM weekly_winners WHERE tenant_id = ${SV_OFF}`)) as unknown as {
    n: number;
  }[];
  expect(winners[0]!.n).toBe(1);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// SV6 — what CI actually runs, stated honestly.
// ---------------------------------------------------------------------------------------------

test('SV6: with the CONFIG DEFAULT the seeder still fabricates — CI does NOT exercise the gate', async () => {
  // ⛔ THE ONE TEST HERE THAT DELIBERATELY DOES NOT PASS `{fabricate:false}`. Under NODE_ENV=test
  // the config default is TRUE, so this is the branch a bare `seedTenantShowcase(id)` — i.e. boot,
  // and every other test file — takes. Pinning it makes the trap in this file's header a fact
  // rather than a warning: SV1/SV3/SV4/SV5/SV7 would ALL pass with the clamp deleted if they had
  // read the config instead of overriding it.
  expect(config.seedFabricatedTelemetry).toBe(true);
  expect(await challengeVotes(SV_ON, CH.renewals.title)).toBe(CH.renewals.fabricated);
  expect(await challengeVotes(SV_ON, CH.broker.title)).toBe(CH.broker.fabricated);
  expect(await solutionVotes(SV_ON, SOL.liam.title)).toBe(SOL.liam.fabricated);
  expect(await solutionVotes(SV_ON, SOL.yuki.title)).toBe(SOL.yuki.fabricated);

  // …and the recount is UN-GATED, so it applies here too. This is the deliberate dev/CI change:
  // the six voted-on rows tell the truth while the fabricated ones stand out beside them.
  expect(await challengeVotes(SV_ON, CH.claims.title)).toBe(CH.claims.real);
  expect(await solutionVotes(SV_ON, SOL.sara.title)).toBe(SOL.sara.real);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// SV7 — the frozen artifact.
// ---------------------------------------------------------------------------------------------

test('SV7: fabrication OFF writes the artifact the CLOSE would have written', async () => {
  // `1180 / 14 / 7 / 9` is a hard-coded object literal, NOT a sum of the counters — so clamping
  // them leaves it untouched, and winner/+page.svelte:88-89 prints it in the same stat row as the
  // live count ("2 stemmen ontvangen · 1.180 stemmen uitgebracht"). With fabrication off the
  // seeder writes `periodSolutionStats`, the same helper closeCycle stamps and marketplace-summary
  // recomputes with — so the artifact, the close and the page cannot disagree.
  //
  // The TWO-KEY shape is also load-bearing beyond correctness: it is the whole predicate migration
  // 0064 step 3 uses to tell a seeder artifact from a close-written one.
  // REVERT THAT REDS THIS: drop the `fabricate ?` on the `stats` literal in seed-tenant-showcase.ts
  // → the four-key 1180 object comes back.
  const [row] = await db
    .select({ stats: weeklyWinners.stats })
    .from(weeklyWinners)
    .where(and(eq(weeklyWinners.tenant_id, SV_OFF), eq(weeklyWinners.week, WEEK)));
  expect(row).toBeDefined();
  expect(Object.keys(row!.stats ?? {}).sort()).toEqual(['solutionsSubmitted', 'totalVotesCast']);

  const live = await periodSolutionStats(WEEK, SV_OFF, db);
  expect(row!.stats).toEqual(live);
  // Not vacuous, and it proves the ORDER inside the seeder: the artifact was written AFTER the
  // recount, so its total is the real 3 (2 + 1 + 0 + 0) rather than the pre-recount 0 or 1008.
  expect(live.solutionsSubmitted).toBe(4);
  expect(live.totalVotesCast).toBe(3);
}, 30_000);

// ---------------------------------------------------------------------------------------------
// SV8 — the flag itself.
// ---------------------------------------------------------------------------------------------

test('SV8: seedFabricatedTelemetry fails CLOSED in production for the vote clamp too', async () => {
  // The clamp reuses ONE flag rather than adding `CP_SEED_FABRICATED_VOTES`, so the fail-closed
  // behaviour that matters here is this flag's — asserted from a FRESH process, because the module
  // is a const evaluated once at import and this suite already imported it under NODE_ENV=test.
  // REVERT THAT REDS THIS: add a second flag for votes, or drop the `!== 'production'` clause.
  expect(await flagUnder({ NODE_ENV: 'production' })).toBe(false);
  expect(await flagUnder({ NODE_ENV: 'production', CP_SEED_FABRICATED_TELEMETRY: 'true' })).toBe(true);
  expect(await flagUnder({ NODE_ENV: 'test' })).toBe(true);
}, 30_000);
