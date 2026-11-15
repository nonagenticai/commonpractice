// tests/usage-metrics-platform.test.ts — the behavioural proof for migration 0063.
//
// THE DEFECT THIS PINS, as measured in prod. 0061 split the COUNTER
// (`usage_counters.llm_calls` vs `platform_llm_calls`) so the translation drainer stopped eating
// a person's daily quota. It did NOT split the LEDGER, and `/usage` reads `usage_events`. 608
// backfill rows — every one carrying ONE real person's `user_id`, every one $0.00 because
// AGENT_MODEL is `local-llm`, which at the time priced 0/0 (no longer true since 2026-08-12; see
// PLATFORM_MODEL below) — therefore went on being reported as that person's work on the
// tenant-admin's Usage & Spend screen:
//
//   * getStats   `calls` read 878 where the humans made 270, and the four price_source buckets
//                (which the UI reads to decide whether to hedge every figure with a tilde) were
//                padded by rows nobody authorised.
//   * getByModel a `local-llm` row of 608 calls at $0.00 — and because that query is ORDER BY
//                spend, the biggest row by COUNT sorted last and drew as a zero-width bar.
//   * getByDay   the sparkline is plotted on CALLS, so the backfill burst set `dayMax` and
//                flattened every genuine human day against a baseline that is not human activity.
//   * getByMember ONE ROW, A REAL PERSON'S REAL NAME, `calls` = 608 + their own, FUSED INTO ONE
//                INTEGER — sortable by a "Calls" header that puts them top of a per-person table
//                on work they did not do, and exported by the client-side CSV into a file that
//                leaves the product.
//
// 0063 persists `BrokerCallMeta.platformActor` to `usage_events.platform_actor` and all four
// aggregates exclude it. See the ⛔ block at the top of src/host/usage-metrics.ts for why the
// discriminator is that flag and NOT `stage` (three of `stage`'s four live values are human, so
// filtering on it is a hand-maintained blacklist that breaks silently on the next drainer).
//
// ⛔ THE ASYMMETRIC TRIO THIS FILE COMPLETES. Three screens, three questions, three answers:
//     host/ops-metrics.ts    /it-dash fleet load  SUM(llm_calls + platform_llm_calls)  BOTH
//     routes/sandboxes.ts    one person's row     SUM(llm_calls)                       HUMAN
//     host/usage-metrics.ts  /usage, all four     NOT ue.platform_actor  (HERE)        HUMAN
// tests/ops-metrics.test.ts and tests/sandboxes-routes.test.ts seed the SAME shape and assert
// DIFFERENT numbers on purpose. "Harmonising" any two of the three reds exactly one of them.
//
// ⛔ THE HARNESS NOTE THAT MAKES THESE CASES NON-VACUOUS — read the CANONICAL copy at the top of
// tests/metering-platform-calls.test.ts; this is the short form. FOURTEEN test files share the ONE
// global `__setBrokerDepsForTests` singleton against ONE database, and THIS FILE IS ONE OF THEM —
// it was missing from that list until 2026-08-16, along with runs.test.ts.
//
// ⚠️ CORRECTED 2026-08-16: this note used to say "and bun runs test FILES CONCURRENTLY". It does
// not. `bun test --help` — `--parallel` is opt-in and *implies `--isolate`* (separate worker
// processes ⇒ separate module instances ⇒ separate singletons); CI runs a plain `bun run test`;
// and measured file durations are additive (3 files alone 433+152+254 ms, together 730 ms — the
// sum minus two process startups, not the 433 ms max), not overlapping. Nothing runs beside us, so no `limits` value can arrive from a sibling FILE.
//
// The real vector is a file or test LEAKING WORK PAST ITS OWN END — an un-awaited broker call that
// resumes during a later `beforeEach` — which is a torn-fixture / FK-violation problem
// (`usage_counters_user_id_fkey`), not a limits problem.
//
// `meteredCall` below is KEPT anyway, and is cheap: it installs our deps immediately before the
// call AND retries a cap rejection. Our own counter row starts at zero calls and $0 spend, so no
// cap of OURS is ever the one that fires — the retry only ever absorbs a limit that is not ours,
// whatever its provenance. That matters here specifically because this file needs its HUMAN call
// to SUCCEED and so cannot use metering-platform-calls' pin-above-every-cap trick. Every assertion
// downstream is then about attribution, never about limits.
//
// Fixture ids use the `…00000c63…` prefix (0063), which no other test file uses — see
// tests/fixture-id-collisions.test.ts for why that matters.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  translationJobs,
  usageCounters,
  usageEvents,
  withTenantDb,
} from '../src/db/client';
import {
  brokerLlmCall,
  __setBrokerDepsForTests,
  type BrokerCallMeta,
  type BrokerOutcome,
  type Provider,
} from '../src/host/llm-broker';
import { getTenantUsage } from '../src/host/usage-metrics';

const USER_ID = '00000000-0000-0000-0000-00000c630001';
const TENANT_ID = '00000000-0000-0000-0000-00000c630100';

/** The one human in this fixture. The whole point of getByMember is that this name is real. */
const HUMAN_NAME = 'Dana Okafor';

/** The human's model and its exact cost. See `provider()` — the fake reports the charge, so this
 *  is the ledger value, not an estimate of it. */
const HUMAN_MODEL = 'demo-model';
const HUMAN_COST = 0.01;

/** The platform's model in prod: AGENT_MODEL is `local-llm`. When the 608 rows were written,
 *  pricing.ts priced it at 0 in / 0 out, which is why they are all $0.00 and why the defect they
 *  caused was a COUNT problem rather than a money problem. ⚠ That pricing changed on 2026-08-12
 *  (local-llm now prices at the flat tier — see ai/llm/pricing.ts), so this is history, not a
 *  current property: rows written from now on carry real notional cost. The cases below inject
 *  their own costs and do not depend on either regime. */
const PLATFORM_MODEL = 'local-llm';

/**
 * Small enough that the reservation stays under the smallest `weeklySpendUsd` any sibling file
 * injects (0.004, the in-flight-reservation case in llm-broker.test.ts) — the same precaution
 * metering-platform-calls.test.ts takes, so a leaked limit cannot fail a case that is not about
 * the ceiling.
 */
const MAX_TOKENS = 16;

/** A provider that reports its own charge, so `priceCall` takes rule 1 (`price_source =
 *  'provider'`) and the ledger holds EXACTLY this number rather than a flat estimate of it. */
function provider(costUsd: number): Provider {
  return async (req) => ({ text: `echo:${req.prompt}`, tokensIn: 10, tokensOut: 5, costUsd });
}

/**
 * One brokered call with our deps installed immediately before it, retrying a cap rejection.
 *
 * See the harness note at the top. A rejection here is never OUR cap firing — our counter row is
 * created fresh in `beforeEach` at zero calls and zero spend — it is another file's `limits`
 * winning the singleton for a moment. Re-installing and retrying is the narrowest possible fix
 * and it cannot mask a real regression: a genuinely broken gate rejects all four attempts and the
 * throw below names the kind.
 */
async function meteredCall(
  costUsd: number,
  model: string,
  meta?: BrokerCallMeta,
): Promise<BrokerOutcome> {
  let last: BrokerOutcome | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    __setBrokerDepsForTests({
      provider: provider(costUsd),
      limits: () => ({ dailyLlmCap: 1000, weeklySpendUsd: 1000 }),
    });
    const out = await withTenantDb(TENANT_ID, () =>
      brokerLlmCall(USER_ID, { model, prompt: 'hi', maxTokens: MAX_TOKENS }, meta),
    );
    if (out.ok) return out;
    last = out;
  }
  throw new Error(
    `brokered ${model} call was refused on all 4 attempts (kind=${last?.ok === false ? last.kind : '?'}): ` +
      'another test file held __setBrokerDepsForTests for the whole window, or the gate is broken',
  );
}

/** The human's call: one real person, one real model, one real (tiny) cost. */
const humanCall = () => meteredCall(HUMAN_COST, HUMAN_MODEL, { stage: 'flow-run' });

/**
 * The platform's call — SAME USER, which is the entire defect. `requested_by` on a translation
 * job is the human who asked for the CONTENT to exist (audit data 0060 goes to real trouble to
 * get right), not someone spending their allowance, so the drainer's ledger rows land on a real
 * person's user_id and there is nothing wrong with that. What is wrong is REPORTING them as hers.
 */
const platformCall = (costUsd = 0) =>
  meteredCall(costUsd, PLATFORM_MODEL, { stage: 'content-translation', platformActor: true });

const MIGRATION_0063 = join(
  import.meta.dir,
  '..',
  'migrations',
  '0063_usage_events_platform_actor.sql',
);

/**
 * Lift step 4's backfill block out of the migration file and run it VERBATIM.
 *
 * Re-implementing the statement here would pin a COPY of the logic and stay green while the
 * shipped migration rotted — the failure mode that lets a backfill regress unnoticed. Reading the
 * real file means the test is about the artefact that actually runs against prod.
 *
 * The block is idempotent by construction (`AND NOT ue.platform_actor`), which is what makes it
 * safe to execute from a test at all: a re-run claims nothing and reports 0.
 */
function step4Backfill(): string {
  const text = readFileSync(MIGRATION_0063, 'utf8');
  const marker = text.indexOf('>>> 0063 STEP 4 BACKFILL');
  const end = text.indexOf('-- >>> END 0063 STEP 4 BACKFILL <<<');
  const start = marker < 0 ? -1 : text.indexOf('DO $$', marker);
  if (marker < 0 || start < 0 || end < 0 || start > end) {
    throw new Error(
      'could not find 0063 step 4 between its markers — the PRE-0061 backfill has been removed ' +
        'or renamed. If it was removed on purpose, 106 platform rows in prod go back to being ' +
        "billed to a named human on /usage's DEFAULT 30-day view (26x overstated), and this test " +
        'is the thing that was supposed to stop that.',
    );
  }
  const block = text.slice(start, end);
  if (!block.includes('translation_jobs')) {
    throw new Error('0063 step 4 no longer correlates against translation_jobs');
  }
  return block;
}

async function cleanup(): Promise<void> {
  await db.delete(translationJobs).where(eq(translationJobs.requested_by, USER_ID));
  await db.delete(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_ID]));
}

// Explicit hook timeout: bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause. Same note as metering-platform-calls.test.ts.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db.insert(tenants).values({ id: TENANT_ID, name: 'Usage 0063', slug: 'usage-0063' });
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'usage-0063@test', name: HUMAN_NAME, tenant_id: TENANT_ID });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

// ---------------------------------------------------------------------------------------------
// T1 — the load-bearing one. Everything else on the page is a wrong number; THIS one is a false
// statement about a named individual, printed beside their name and exported to a file.
// ---------------------------------------------------------------------------------------------
test('getByMember bills the human for HER calls only, never the platform\'s', async () => {
  // REVERT THAT TURNS THIS RED: delete `AND ${HUMAN_ONLY}` from getByMember's WHERE in
  // host/usage-metrics.ts — `calls` becomes 2, i.e. Dana is billed for the drainer's work.
  await humanCall();
  await platformCall();

  const usage = await getTenantUsage(TENANT_ID, 30);

  expect(
    usage.byMember,
    'both calls carry the SAME user_id, so a leaked platform row does not add a ROW — it inflates ' +
      'an existing one, which is why the row count alone would not have caught this in prod',
  ).toHaveLength(1);
  const dana = usage.byMember[0]!;
  expect(dana.userId).toBe(USER_ID);
  expect(dana.name).toBe(HUMAN_NAME);
  expect(
    dana.calls,
    'Dana made ONE call. The platform made the other; attributing it to her is a false statement ' +
      'about a person, and the "Calls" column header is sortable, so it puts her top of a ' +
      'per-person usage table on work she did not do',
  ).toBe(1);
  expect(dana.spendUsd).toBeCloseTo(HUMAN_COST, 6);
});

// ---------------------------------------------------------------------------------------------
// T2 — the headline stat cards. `calls` is the visible one; `models` and `members` are asserted
// with strict === because a padded DISTINCT is exactly as wrong and far easier to miss.
// ---------------------------------------------------------------------------------------------
test('getStats counts human calls, human models and human members only', async () => {
  // REVERT THAT TURNS THIS RED: delete `AND ${HUMAN_ONLY}` from getStats' WHERE — `calls`
  // becomes 2 and `models` becomes 2 (a `local-llm` nobody in this tenant ever chose).
  await humanCall();
  await platformCall();

  const { stats } = await getTenantUsage(TENANT_ID, 30);

  expect(stats.calls, 'one human call was made in this tenant').toBe(1);
  expect(
    stats.models,
    'this tenant used ONE model. `local-llm` is the platform\'s own inference router, not a ' +
      'choice anyone here made, and counting it makes the "Models" card overstate the estate',
  ).toBe(1);
  expect(stats.members, 'one human made calls in this tenant').toBe(1);
  expect(stats.spendUsd).toBeCloseTo(HUMAN_COST, 6);
});

// ---------------------------------------------------------------------------------------------
// T3a + T3b are a MATCHED PAIR and MUST STAY TWO TESTS. The predicate belongs in getByDay's LEFT
// JOIN `ON` clause; moving it to the `WHERE` still produces the right TOTAL and silently destroys
// the zero-fill. T3a alone stays GREEN through that revert — see T3b.
// ---------------------------------------------------------------------------------------------
test('getByDay plots human calls only (the sparkline is scaled on CALLS)', async () => {
  // REVERT THAT TURNS THIS RED: delete `AND ${HUMAN_ONLY}` from getByDay's LEFT JOIN ON clause —
  // the total becomes 2, the backfill burst sets `dayMax`, and every human day is flattened.
  await humanCall();
  await platformCall();

  const { byDay } = await getTenantUsage(TENANT_ID, 30);

  expect(byDay.reduce((s, d) => s + d.calls, 0)).toBe(1);
  expect(byDay.reduce((s, d) => s + d.spendUsd, 0)).toBeCloseTo(HUMAN_COST, 6);
});

test('getByDay keeps the generate_series zero-fill: 30 buckets for a 30-day range', async () => {
  // ⛔ REVERT THAT TURNS THIS RED: MOVE the predicate out of getByDay's LEFT JOIN ON clause and
  // into its WHERE. For a day with no matching row every `ue.*` is NULL and `NOT NULL` is NULL —
  // not TRUE — so the LEFT JOIN degenerates to an INNER JOIN and `byDay` collapses from 30
  // entries to only the 1 day that has rows. The sparkline silently re-scales and the x-axis
  // lies about which days it is drawing.
  //
  // ⛔ THAT REVERT LEAVES T3a GREEN — the surviving day still holds exactly the one human call —
  // WHICH IS PRECISELY WHY THIS IS A SEPARATE TEST. A sum-only assertion cannot see a destroyed
  // axis. Do not merge the two.
  await humanCall();
  await platformCall();

  const { byDay } = await getTenantUsage(TENANT_ID, 30);

  expect(
    byDay,
    'the zero-fill is what makes the sparkline an honest time axis: 30 days requested, 30 ' +
      'buckets returned, whether or not anything happened on each',
  ).toHaveLength(30);

  const seven = await getTenantUsage(TENANT_ID, 7);
  expect(seven.byDay, 'and the bucket count tracks the requested range, not the data').toHaveLength(7);
});

// ---------------------------------------------------------------------------------------------
// T4 — the BarRows.
// ---------------------------------------------------------------------------------------------
test('getByModel drops the platform-only model rather than drawing a zero-width bar', async () => {
  // REVERT THAT TURNS THIS RED: delete `AND ${HUMAN_ONLY}` from getByModel's WHERE — the
  // `local-llm` row returns: 608 calls in prod, $0.00, sorted LAST by spend, rendered as nothing.
  await humanCall();
  await platformCall();

  const { byModel } = await getTenantUsage(TENANT_ID, 30);

  expect(byModel.map((x) => x.model)).not.toContain(PLATFORM_MODEL);
  expect(byModel).toHaveLength(1);
  expect(byModel[0]!.model).toBe(HUMAN_MODEL);
  expect(byModel[0]!.calls).toBe(1);
  expect(byModel[0]!.spendUsd).toBeCloseTo(HUMAN_COST, 6);
});

// ---------------------------------------------------------------------------------------------
// T8 — the PRE-0061 rows, which `stage` structurally cannot reach.
//
// `stage` did not exist until 0061, so platform translations that completed before it shipped
// wrote ledger rows with `stage IS NULL`. In prod that is 106 rows (translation_jobs holds 714
// done jobs; step 3's `stage = 'content-translation'` claims 608), and they are NOT spread evenly
// — they cluster recently. Step 3 alone would have left the /usage DEFAULT view (range=30) still
// reporting 52 calls for one named human of which 50 were the drainer's: 26x overstated. At
// range=7 it was 50 of 50 — one hundred percent platform work under a real person's name.
//
// An earlier draft of 0063's header asserted these rows were "not separable … there is no third
// field to tell them apart", and that unmeasured sentence was the whole justification for not
// fixing them. There IS a third field: translation_jobs, in the same database. This test is that
// claim's executable form.
// ---------------------------------------------------------------------------------------------
test('0063 step 4 claims PRE-0061 platform rows by correlation, and leaves the human ones alone', async () => {
  // ⛔ REVERT THAT TURNS THIS RED: delete the second UPDATE (0063's step 4 block, between its
  // `>>> 0063 STEP 4 BACKFILL` markers) — the correlated row is never claimed and reappears in
  // the human's count, so `calls` reads 2 instead of 1. Deleting the whole block instead reds it
  // at the extraction guard in step4Backfill(), with the same explanation.
  //
  // Both rows below are what a pre-0061 platform call looks like on disk: NULL stage, `local-llm`,
  // platform_actor still false. The ONLY thing that distinguishes them is whether a translation
  // job finished at the same moment — which is precisely the evidence step 4 reads.
  const CORRELATED_AT = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const HUMAN_AT = new Date(Date.now() - 5 * 24 * 3600 * 1000);

  const seedLegacyRow = (createdAt: Date) =>
    db.execute(sql`
      INSERT INTO usage_events (tenant_id, user_id, provider, model, cost_usd, stage, platform_actor, created_at)
      VALUES (${TENANT_ID}, ${USER_ID}, 'mock', ${PLATFORM_MODEL}, 0, NULL, false,
              ${createdAt.toISOString()}::timestamptz)
    `);
  await seedLegacyRow(CORRELATED_AT);
  await seedLegacyRow(HUMAN_AT);

  // The drainer's own record of the same call, 3s later — the third field. Nothing is inserted
  // anywhere near HUMAN_AT, which is the control: in prod, zero jobs completed on the days
  // holding the 38 rows that are genuinely a person's.
  await db.insert(translationJobs).values({
    entity_type: 'block',
    entity_id: 'usage-0063-step4',
    field: 'name',
    target_locale: 'nl',
    source_text: 'x',
    source_hash: 'h',
    status: 'done',
    requested_by: USER_ID,
    created_at: CORRELATED_AT,
    updated_at: new Date(CORRELATED_AT.getTime() + 3000),
  });

  const before = await getTenantUsage(TENANT_ID, 30);
  expect(
    before.byMember[0]!.calls,
    'precondition: both legacy rows start attributed to the human, which is the prod state',
  ).toBe(2);

  await db.execute(sql.raw(step4Backfill()));

  const after = await getTenantUsage(TENANT_ID, 30);
  expect(
    after.byMember[0]!.calls,
    'the row that coincides with a completed translation job is the drainer\'s; the one that ' +
      'coincides with nothing is hers, and must survive the backfill untouched',
  ).toBe(1);
  expect(after.stats.calls).toBe(1);

  // Assert the classification directly, not just its aggregate shadow: a backfill that claimed
  // BOTH rows would also have moved `calls` off 2, just to the wrong number in the other
  // direction — over-claiming is the failure mode that erases a real person's usage entirely.
  const ledger = await db
    .select({ created_at: usageEvents.created_at, platform_actor: usageEvents.platform_actor })
    .from(usageEvents)
    .where(eq(usageEvents.user_id, USER_ID));
  expect(ledger).toHaveLength(2);
  const correlated = ledger.find((r) => r.created_at.getTime() === CORRELATED_AT.getTime())!;
  const human = ledger.find((r) => r.created_at.getTime() === HUMAN_AT.getTime())!;
  expect(correlated.platform_actor, 'a job finished within 10s of this call — it is the drainer').toBe(true);
  expect(
    human.platform_actor,
    'no job finished anywhere near this call, so there is no evidence it was the platform, and ' +
      'claiming it anyway would be the exact fabrication 0053 refused',
  ).toBe(false);

  // Idempotent: the shipped block runs on every boot that has it pending, and a second pass must
  // claim nothing rather than re-reporting the same rows.
  await db.execute(sql.raw(step4Backfill()));
  const again = await getTenantUsage(TENANT_ID, 30);
  expect(again.byMember[0]!.calls).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// T6 — the named residual. SPEND, not just calls.
// ---------------------------------------------------------------------------------------------
test('platform SPEND is excluded too, not only platform calls', async () => {
  // REVERT THAT TURNS THIS RED: apply the exclusion to the COUNT aggregates but leave
  // `COALESCE(SUM(ue.cost_usd), 0)` unfiltered (e.g. by moving `AND ${HUMAN_ONLY}` into the
  // `FILTER (WHERE …)` of the counts only) — spendUsd reads 0.51.
  //
  // ⛔ THIS IS THE ACCEPTED RESIDUAL AS OF 0063, WRITTEN DOWN RATHER THAN DISCOVERED LATER.
  // `usage_counters.spend_usd` is deliberately NOT split (0061's header says so explicitly and
  // gives the reason: the weekly MONEY ceiling is the bound that survives the call-cap
  // exemption, so platform work can never spend without limit). So platform spend still consumes
  // the human's WEEKLY ALLOWANCE even though this screen no longer REPORTS it as hers.
  //
  // ⚠ THAT DIVERGENCE IS NOW REACHABLE IN PROD. This paragraph used to say the opposite — "
  // currently UNREACHABLE: AGENT_MODEL is `local-llm`, and pricing.ts prices it at exactly 0 in /
  // 0 out (ZERO_COST_MODELS), so every one of the 608 rows is $0.000000 and 'excluded from the
  // report' and 'excluded from the ceiling' agree at zero" — and it predicted the trigger exactly:
  // "the day AGENT_MODEL stops being a `local-*` model it becomes reachable with no code change".
  // What actually happened on 2026-08-12 was the other half of the same condition: AGENT_MODEL is
  // still `local-llm`, but `local-llm` stopped being priced at zero (both zeros removed — see the
  // CORRECTION block in ai/llm/pricing.ts), so platform spend is now a real, growing number.
  //
  // So this case is no longer defensive. The failure it describes is live: /usage excludes
  // platform rows (correctly — nobody should be billed for the drainer), while the weekly ceiling
  // in llm-broker.ts deliberately does NOT, so a person can be refused service over spend her own
  // Usage screen does not show. It is bounded (August prod: $1.09/month of local inference against
  // $15/user/week) and it is the deliberate design — platform work is governed by money instead of
  // by a headcount quota — but it is now something a support question can actually be about.
  // The stand-in model priced at $0.50 stays, because it makes the divergence visible in one call
  // instead of a month of accumulation.
  // THE REMEDY WHEN THAT DAY COMES is the same shape as 0061 — a `usage_counters
  // .platform_spend_usd` column plus a platform ceiling — NOT widening this file's predicate,
  // which is about REPORTING and is already correct.
  const PAID_PLATFORM_MODEL_COST = 0.5;
  await humanCall();
  await meteredCall(PAID_PLATFORM_MODEL_COST, 'paid-agent-model', {
    stage: 'content-translation',
    platformActor: true,
  });

  const { stats, byMember } = await getTenantUsage(TENANT_ID, 30);

  expect(
    stats.spendUsd,
    'the tenant-admin is looking at a budget + chargeback screen; $0.50 of platform translation ' +
      'is not spend this tenant caused, so it must not appear as spend this tenant caused',
  ).toBeCloseTo(HUMAN_COST, 6);
  expect(stats.calls).toBe(1);
  expect(byMember[0]!.spendUsd).toBeCloseTo(HUMAN_COST, 6);

  // The residual, asserted rather than described: the COUNTER did take the money, and that is the
  // deliberate 0061 decision this file does not revisit. If this assertion ever fails because
  // spend was split, DELETE the residual note above — it will have been fixed.
  const [counter] = await db
    .select({ spend_usd: usageCounters.spend_usd })
    .from(usageCounters)
    .where(eq(usageCounters.user_id, USER_ID));
  expect(
    Number(counter?.spend_usd ?? 0),
    'usage_counters.spend_usd is deliberately NOT split (0061): the weekly money ceiling still ' +
      'bounds platform work, which is what made dropping the CALL cap safe',
  ).toBeCloseTo(HUMAN_COST + PAID_PLATFORM_MODEL_COST, 6);
});

// ---------------------------------------------------------------------------------------------
// T7 — the fix for T6's named residual: platform cost excluded from `spendUsd` above must not
// be invisible everywhere. `stats.platformSpendUsd`/`platformCalls` are additive fields (this
// PR) computed from a SEPARATE query (`getPlatformCost`), not a widened HUMAN_ONLY predicate —
// T2/T6 above prove the human-only fields are unaffected by this test coexisting with them.
// ---------------------------------------------------------------------------------------------
test('stats.platformSpendUsd/platformCalls surface exactly the cost T6 shows is excluded from spendUsd', async () => {
  // REVERT THAT TURNS THIS RED: delete the `getPlatformCost` call from `getStats`, or filter it
  // by `HUMAN_ONLY` instead of `ue.platform_actor` — platformSpendUsd/platformCalls read 0.
  const PAID_PLATFORM_MODEL_COST = 0.5;
  await humanCall();
  await meteredCall(PAID_PLATFORM_MODEL_COST, 'paid-agent-model', {
    stage: 'content-translation',
    platformActor: true,
  });

  const { stats } = await getTenantUsage(TENANT_ID, 30);

  expect(
    stats.platformSpendUsd,
    'the platform work T6 proves is excluded from spendUsd must still be measurable somewhere',
  ).toBeCloseTo(PAID_PLATFORM_MODEL_COST, 6);
  expect(stats.platformCalls).toBe(1);
  // Unaffected by the new field existing: the human-only totals stay exactly what T2/T6 assert.
  expect(stats.spendUsd).toBeCloseTo(HUMAN_COST, 6);
  expect(stats.calls).toBe(1);
});
