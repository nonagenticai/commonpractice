// tests/metering-platform-calls.test.ts — the behavioural proof for migration 0061.
//
// THE DEFECT THIS PINS, as measured in prod. `usage_counters.llm_calls` was doing two
// incompatible jobs: a GOVERNANCE QUOTA ("how much of this human's daily allowance is left",
// bounded by `spend.daily_llm_cap`) and a LOAD METER ("how many provider calls did this row
// cause"). Platform background work is legitimately the second and illegitimately the first, so
// 608 pending `translation_jobs` — all attributed to one user, total cost $0.000000 because
// AGENT_MODEL is `local-llm`, which priced 0/0 at the time (no longer: since 2026-08-12 local
// inference prices at the flat tier — ai/llm/pricing.ts) — sat permanently blocked behind that person's
// 50-calls-a-day cap. 0061 splits the load half into `usage_counters.platform_llm_calls` and
// `BrokerCallMeta.platformActor` opts a call into it.
//
// ⛔ THE HARNESS NOTE THAT MAKES THESE CASES NON-VACUOUS — the CANONICAL copy. Four sibling files
// (usage-metrics-platform, translation-pipeline ×2, runs, fixture-id-collisions) restate a short
// form of it and point here; correct this one first.
//
// FOURTEEN test files share the ONE global `__setBrokerDepsForTests` singleton against ONE
// database: admin, agent-loop, agent-pool-budget, dataset-mappings, llm-broker,
// metering-cross-tenant-cap, metering-emit, metering-platform-calls (this file), ontology-mcp,
// policy-enforcement, rls-runtime, runs, translation-pipeline, usage-metrics-platform. This list
// said ELEVEN until 2026-08-16 and silently omitted `runs`, `usage-metrics-platform` and this file
// itself — re-derive it rather than trusting it: `grep -rl __setBrokerDepsForTests tests/`.
//
// ⚠️ CORRECTED 2026-08-16 — THE SENTENCE THAT USED TO SIT HERE IS FALSE. It read "and bun runs
// test FILES CONCURRENTLY", and it sent every reader hunting a race that this runner cannot
// produce. Measured, not reasoned:
//   * `bun test --help`: `--parallel` is OPT-IN and *"Implies --isolate"* — separate worker
//     processes, therefore separate module instances, therefore separate singletons. "Concurrent
//     files" and "one shared singleton" are mutually exclusive here.
//   * CI runs `cd backend && bun run test` → `bun test --timeout 30000`
//     (.github/workflows/ci-cd.yaml, package.json). No `--parallel`. No `--shard`.
//   * Durations are ADDITIVE, not overlapping. Measured 2026-08-16 on a freshly seeded database:
//     llm-broker 433 ms, metering-platform-calls 152 ms, agent-loop 254 ms when each is run ALONE
//     (839 ms of wall time, three process startups); all three in ONE invocation = 730 ms across
//     3 files. That is the SUM minus two startups — nowhere near the 433 ms MAX that overlapping
//     execution would give.
// So a `limits` value cannot arrive here from a file executing BESIDE us. Nothing does.
//
// ⛔ WHAT IS STILL TRUE, AND WHY THE 1_000_000 PRE-SEED BELOW STAYS. There is ONE database and
// every file DELETEs and re-INSERTs its fixtures, so files really do tear each other's rows down.
// The vector is not concurrency — it is A FILE (or a test) LEAKING WORK PAST ITS OWN END. An
// un-awaited broker call holds a reserved pool connection and RESUMES inside a later test's
// `beforeEach`, landing an INSERT between that hook's `delete(usage_counters)` and its
// `delete(users)`. Its fingerprint is an FK violation naming a fixture the failing test never
// touched:
//     PostgresError: ... violates foreign key constraint "usage_counters_user_id_fkey"
// Reproduced 2026-08-16 by starving Postgres (`docker update --cpus=0.01 --memory=180m`): a
// real-clock poll in llm-broker.test.ts gave up before its own provider was entered, abandoned the
// in-flight call, and reddened the NEXT test in its own file with exactly that error. Fixed at the
// leak (WS-7), not here.
//
// The pre-seed is therefore KEPT, on its surviving grounds rather than the imaginary one: it makes
// every assertion below independent of WHICH limits ran — leaked, injected, or the DB-backed
// policy default — for the price of two seeded columns. Seed the counter row at 1_000_000 calls,
// orders of magnitude above every cap any file injects and above the policy default, so "a
// platform call succeeds against a counter of one million" and "the identical call WITHOUT the
// flag is refused against that same counter" hold unconditionally. Same trick for the weekly
// ceiling: seed `spend_usd` at 1_000_000 dollars, which no injected `weeklySpendUsd` in this repo
// comes near. `maxTokens` is kept tiny on the success paths for the mirror-image reason — the
// reservation must stay below the SMALLEST `weeklySpendUsd` any sibling file injects (0.004, the
// in-flight-reservation case in llm-broker.test.ts) so a stray limit cannot fail a case that is
// not about the ceiling.
//
// Fixture ids use the `…00000c61…` prefix (0061), which no other test file uses — see
// tests/fixture-id-collisions.test.ts for why that matters.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  usageCounters,
  usageEvents,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import {
  brokerLlmCall,
  __setBrokerDepsForTests,
  type Provider,
} from '../src/host/llm-broker';

const USER_ID = '00000000-0000-0000-0000-00000c610001';
const TENANT_A = '00000000-0000-0000-0000-00000c610100';
const TENANT_B = '00000000-0000-0000-0000-00000c610200';

/** Far above every cap any of the fourteen broker-seam files injects, and above the DB default. */
const HUGE = 1_000_000;

/**
 * The same idea for MONEY, one dollar short — `spend_usd` is `numeric(12,6)`, so an absolute
 * value of 10^6 or more is a hard 22003 "numeric field overflow". 999_999 dollars is still three
 * orders of magnitude above the largest `weeklySpendUsd` any sibling file injects (1000).
 */
const HUGE_SPEND = 999_999;

/** Small enough that the reservation stays under the smallest injected weeklySpendUsd (0.004). */
const REQ = { model: 'm', prompt: 'hi', maxTokens: 16 } as const;

function fakeProvider(): { provider: Provider; calls: () => number } {
  let calls = 0;
  return {
    provider: async (req) => {
      calls++;
      return { text: `echo:${req.prompt}`, tokensIn: 10, tokensOut: 5 };
    },
    calls: () => calls,
  };
}

function explodingProvider(): { provider: Provider; calls: () => number } {
  let calls = 0;
  return {
    provider: async () => {
      calls++;
      throw new Error('provider exploded');
    },
    calls: () => calls,
  };
}

/** Install our deps immediately before the call under test (mirrors every sibling file). */
function install(provider: Provider): void {
  __setBrokerDepsForTests({
    provider,
    limits: () => ({ dailyLlmCap: 5, weeklySpendUsd: 100 }),
  });
}

/**
 * Seed today's counter row for (tenant, user) at an explicit shape.
 *
 * Written as raw SQL with the tenant_id NAMED rather than left to the column default, because
 * this runs outside any tenant context and `app_current_tenant_uuid()` would be NULL.
 */
async function seedCounter(
  tenantId: string,
  opts: { llmCalls?: number; platformLlmCalls?: number; spendUsd?: number } = {},
): Promise<void> {
  await db.execute(
    sql`INSERT INTO usage_counters
          (tenant_id, user_id, day, llm_calls, platform_llm_calls, spend_usd)
        VALUES (${tenantId}, ${USER_ID}, current_date,
                ${opts.llmCalls ?? 0}, ${opts.platformLlmCalls ?? 0}, ${opts.spendUsd ?? 0})
        ON CONFLICT (tenant_id, user_id, day) DO UPDATE
          SET llm_calls = excluded.llm_calls,
              platform_llm_calls = excluded.platform_llm_calls,
              spend_usd = excluded.spend_usd,
              reserved_spend_usd = 0`,
  );
}

async function counter(tenantId: string): Promise<{
  llm_calls: number;
  platform_llm_calls: number;
  spend_usd: string;
  reserved_spend_usd: string;
}> {
  const [row] = await db
    .select({
      llm_calls: usageCounters.llm_calls,
      platform_llm_calls: usageCounters.platform_llm_calls,
      spend_usd: usageCounters.spend_usd,
      reserved_spend_usd: usageCounters.reserved_spend_usd,
    })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.tenant_id, tenantId),
        eq(usageCounters.user_id, USER_ID),
        sql`${usageCounters.day} = current_date`,
      ),
    );
  if (!row) throw new Error(`no usage_counters row for tenant ${tenantId} — the seed did not land`);
  return row as typeof row & { llm_calls: number; platform_llm_calls: number };
}

async function cleanup(): Promise<void> {
  await db.delete(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

// Explicit hook timeout: bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause. Same note as license-provisioning.test.ts.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'Platform Calls A', slug: 'platform-calls-a' },
    { id: TENANT_B, name: 'Platform Calls B', slug: 'platform-calls-b' },
  ]);
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'platform-calls@test', name: 'Platform', tenant_id: TENANT_A });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

// ---------------------------------------------------------------------------------------------
// 1 + 2 are a MATCHED PAIR. Case 1 alone would pass equally well against a broker whose daily cap
// was simply broken; case 2 is what proves the cap is alive and that case 1 is testing the FLAG.
// ---------------------------------------------------------------------------------------------

test('a PLATFORM call passes a maxed-out daily cap and counts as platform load', async () => {
  // REVERT THAT TURNS THIS RED: delete `!platform &&` from the daily-cap check in reserveCall
  // (llm-broker.ts) — the call is then refused with kind 'llm_capped' at the first assertion.
  const fp = fakeProvider();
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);

  const out = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { platformActor: true }),
  );
  expect(
    out.ok,
    'a platform call must not be refused by a per-PERSON daily call cap — this is the 608-job ' +
      'prod stall, reproduced at one million',
  ).toBe(true);
  expect(fp.calls()).toBe(1);

  const c = await counter(TENANT_A);
  // ⛔ EXACTLY unchanged, not merely "still large". A platform call must never move the human's
  // quota column in EITHER direction.
  expect(c.llm_calls, "the human's quota column must be untouched").toBe(HUGE);
  expect(c.platform_llm_calls, 'the platform load meter must have recorded exactly one call').toBe(1);
});

test('NEGATIVE CONTROL: the SAME call without platformActor is still capped', async () => {
  // REVERT THAT TURNS THIS RED: make reserveCall IGNORE the flag and treat every call as platform
  // (`platform = true;` immediately before its transaction) — the call then succeeds and `ok` is
  // true. NB simply giving the parameter a `= true` DEFAULT is not a valid revert: every call site
  // passes it explicitly, so the default is dead code and the suite stays green — which is itself
  // the point of making the parameter REQUIRED. This case is what stops case 1 from passing for
  // the wrong reason (a cap that no longer works at all, rather than a flag that is honoured).
  const fp = fakeProvider();
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);

  const out = await withTenantDb(TENANT_A, () => brokerLlmCall(USER_ID, REQ));
  expect(out.ok, 'a HUMAN call against a maxed counter must still be refused').toBe(false);
  if (!out.ok) expect(out.kind).toBe('llm_capped');
  expect(fp.calls(), 'refused BEFORE the provider — no spend').toBe(0);

  const c = await counter(TENANT_A);
  expect(c.llm_calls).toBe(HUGE);
  expect(c.platform_llm_calls, 'a refused human call must not touch the platform meter').toBe(0);
});

test('the WEEKLY SPEND CEILING still refuses a platform call', async () => {
  // ⛔ THE BOUND THAT SURVIVES. 0061 drops a CALL cap for platform work precisely because a call
  // cap at $0.00/call bounds nothing that costs anything; the MONEY ceiling is what keeps
  // background work from being an unbounded spend channel. Extending the bypass to this check is
  // the tempting one-line "simplification" that would make the exemption unbounded.
  //
  // REVERT THAT TURNS THIS RED: gate the weekly-ceiling check on `!platform` too — the call then
  // succeeds and platform_llm_calls lands at 1.
  const fp = fakeProvider();
  await seedCounter(TENANT_A, { llmCalls: 0, spendUsd: HUGE_SPEND });
  install(fp.provider);

  const out = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { platformActor: true }),
  );
  expect(out.ok, 'platform work is exempt from the CALL cap, never from the SPEND ceiling').toBe(
    false,
  );
  if (!out.ok) {
    expect(out.kind).toBe('llm_capped');
    // Assert WHICH gate fired: 'llm_capped' is also the daily cap's kind, and with llm_calls
    // seeded at 0 the daily cap cannot be what refused this — but pinning the message is what
    // makes that explicit rather than inferred.
    expect(out.error).toMatch(/weekly spend ceiling/);
  }
  expect(fp.calls()).toBe(0);

  const c = await counter(TENANT_A);
  expect(c.platform_llm_calls, 'a refused platform call must reserve nothing').toBe(0);
});

test('a FAILED platform call releases the PLATFORM slot, never the human\'s', async () => {
  // ⛔ THIS IS THE RESERVE/RELEASE SYMMETRY ARGUMENT, and it is an INDEPENDENT reason 0061 added a
  // column rather than "just skipping the increment". releaseCall decrements on EVERY provider
  // failure. A reserve that skips the increment paired with a release that performs the decrement
  // STEALS a slot from the human on every failed platform call — 608 jobs against a flaky
  // provider would walk a real person's counter down to zero, silently, since releaseCall never
  // throws.
  //
  // REVERT THAT TURNS THIS RED: drop the `platform` argument at the releaseCall call site in
  // runMetered (pass `false`) — llm_calls lands at 6 instead of 7.
  const ep = explodingProvider();
  await seedCounter(TENANT_A, { llmCalls: 7, platformLlmCalls: 3 });
  install(ep.provider);

  await expect(
    withTenantDb(TENANT_A, () => brokerLlmCall(USER_ID, REQ, { platformActor: true })),
  ).rejects.toThrow('provider exploded');
  expect(ep.calls()).toBe(1);

  const c = await counter(TENANT_A);
  expect(c.llm_calls, "a failed PLATFORM call must not hand back a HUMAN's slot").toBe(7);
  // Reserved 3+1=4, then released back to 3 — the platform meter is where the round trip happened.
  expect(c.platform_llm_calls).toBe(3);
  expect(Number(c.reserved_spend_usd), 'the spend reservation must be released too').toBe(0);
});

test('a platform call still SETTLES spend and still writes a usage_events row', async () => {
  // ⛔ `platformActor` exempts a call from ONE gate. It does not make the call invisible: the
  // ledger row is the authoritative billing record and spend_usd is deliberately SHARED (see
  // 0061's "named residual"). Model 'm' has no catalog price, so it falls through to the flat
  // per-token estimate and costs a real, non-zero amount — a zero-priced model would make the
  // spend assertion vacuous.
  //
  // REVERT THAT TURNS THIS RED: early-return from runMetered before settleSpend when `platform`
  // — spend_usd stays 0 and the usage_events row is absent.
  const fp = fakeProvider();
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);

  const out = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { platformActor: true }),
  );
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.result.costUsd).toBeGreaterThan(0);

  const c = await counter(TENANT_A);
  expect(Number(c.spend_usd), 'platform spend accumulates into the SHARED spend_usd').toBeGreaterThan(0);
  expect(Number(c.reserved_spend_usd), 'the reservation must be settled back to 0').toBe(0);

  const events = await db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  expect(events, 'a platform call is metered in the ledger like any other').toHaveLength(1);
  expect(events[0]!.tenant_id).toBe(TENANT_A);
});

test('a platform call under tenant A leaves tenant B\'s counter at zero — under BOTH roles', async () => {
  // ⛔ BOTH ROLES, AND THE OWNER HALF IS THE ONE THAT EARNS ITS KEEP. This is the lesson
  // tests/metering-cross-tenant-cap.test.ts's header spells out: backend tests connect as the
  // table OWNER (rolbypassrls), so an assertion that leans on RLS to scope a write proves nothing
  // there — and conversely, a cp_app-only assertion is VACUOUS as a guard on the broker's own
  // predicate, because the `usage_counters_tenant` policy would hide tenant B's row even from a
  // completely un-predicated `WHERE user_id AND day`.
  //
  // Both halves must hold, for different reasons:
  //   * under cp_app — the RLS policy is the scope, and this proves the new column is inside it
  //     (a column added after the policy was written is covered because the policy is row-scoped;
  //     this pins that rather than assuming it);
  //   * under the OWNER — RLS is inert and the EXPLICIT `tenant_id = app_current_tenant_uuid()`
  //     predicate on the reserving UPDATE is the ONLY thing stopping the write from hitting EVERY
  //     tenant's row for this user. `runAsSystem`, the schedulers and the seeds all bind the owner
  //     pool, so this is not a hypothetical role.
  //
  // REVERT THAT TURNS THIS RED: drop `tenant_id = app_current_tenant_uuid()` from the reserving
  // UPDATE in reserveCall — the OWNER-role half then increments BOTH tenants' rows and B lands at
  // 1. (The cp_app half alone would stay green, which is precisely why it is not alone.)
  const fp = fakeProvider();

  // ── cp_app (RLS enforced) ──
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  await seedCounter(TENANT_B, { llmCalls: HUGE });
  install(fp.provider);
  const asApp = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { platformActor: true }),
  );
  expect(asApp.ok).toBe(true);
  expect((await counter(TENANT_A)).platform_llm_calls).toBe(1);
  expect(
    (await counter(TENANT_B)).platform_llm_calls,
    "under cp_app, another tenant's platform meter must be untouched",
  ).toBe(0);

  // ── owner (RLS INERT — the predicate is the only scope) ──
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  await seedCounter(TENANT_B, { llmCalls: HUGE });
  install(fp.provider);
  const asOwner = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { platformActor: true }),
  );
  expect(asOwner.ok).toBe(true);
  expect((await counter(TENANT_A)).platform_llm_calls).toBe(1);
  expect(
    (await counter(TENANT_B)).platform_llm_calls,
    'under the OWNER role RLS is inert, so an un-predicated UPDATE would increment EVERY ' +
      "tenant's row for this user — this is the assertion that pins the explicit predicate",
  ).toBe(0);
  expect((await counter(TENANT_B)).llm_calls).toBe(HUGE);
});

test('usage_events.stage records the stage the caller passed', async () => {
  // ⛔ `BrokerCallMeta.stage` was threaded into the OPTIONAL, off-by-default Redis fleet emit long
  // before it reached the LOCAL ledger, so the emit knew a row was background translation and the
  // authoritative billing table did not. 0061 adds the column and settleSpend now writes it.
  //
  // REVERT THAT TURNS THIS RED: drop `stage` from settleSpend's INSERT column list (and
  // `${meta?.stage ?? null}` from VALUES) — the column reads back as null.
  const fp = fakeProvider();
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);

  const out = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { stage: 'content-translation', platformActor: true }),
  );
  expect(out.ok).toBe(true);

  const events = await db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  expect(events).toHaveLength(1);
  expect(events[0]!.stage).toBe('content-translation');
});

test('usage_events.platform_actor records WHO caused the call — both halves', async () => {
  // ⛔ THE TWIN OF THE `stage` CASE ABOVE, AND THE ONE THAT IS READ RATHER THAN MERELY RECORDED.
  // 0061 split the COUNTER so background work stopped eating a person's daily quota, but /usage
  // reads the `usage_events` LEDGER, which 0061 left whole — so the tenant-admin's screen went on
  // reporting 608 drainer calls as one named human's work long after the governance half was
  // fixed. 0063 persists `BrokerCallMeta.platformActor` here, from LITERALLY the same
  // `meta?.platformActor === true` expression reserveCall/releaseCall narrow `platform` from, so
  // the ledger and the counter cannot disagree about whether a call was a person's.
  // host/usage-metrics.ts is the consumer; tests/usage-metrics-platform.test.ts pins the reads.
  //
  // REVERT THAT TURNS THIS RED: drop `platform_actor` from settleSpend's INSERT column list (and
  // `${meta?.platformActor === true}` from VALUES) — the platform row falls back to the column
  // DEFAULT and reads `false`, i.e. it is billed to the human in `user_id` on /usage.
  //
  // ⛔ BOTH HALVES ARE ASSERTED ON PURPOSE. The column is `NOT NULL DEFAULT false`, so a test
  // that only checked the NEGATIVE case would pass against a settleSpend that never wrote the
  // column at all — the DEFAULT alone would satisfy it, VACUOUSLY. The pair is what proves the
  // value is threaded rather than defaulted.
  const fp = fakeProvider();

  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);
  const platformOut = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { stage: 'content-translation', platformActor: true }),
  );
  expect(platformOut.ok).toBe(true);

  await db.delete(usageEvents).where(eq(usageEvents.user_id, USER_ID));

  await seedCounter(TENANT_A, { llmCalls: 0 });
  install(fp.provider);
  const humanOut = await withTenantDb(TENANT_A, () => brokerLlmCall(USER_ID, REQ));
  expect(humanOut.ok).toBe(true);

  const humanRows = await db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  expect(humanRows).toHaveLength(1);
  expect(
    humanRows[0]!.platform_actor,
    "a call with no platformActor is a PERSON's call and must stay attributed to them",
  ).toBe(false);

  // Re-run the platform half AFTER the human one and read them together, so the two rows are
  // compared under identical conditions rather than across a delete.
  await seedCounter(TENANT_A, { llmCalls: HUGE });
  install(fp.provider);
  const platformOut2 = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, REQ, { stage: 'content-translation', platformActor: true }),
  );
  expect(platformOut2.ok).toBe(true);

  const both = await db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  expect(both).toHaveLength(2);
  expect(
    both.filter((e) => e.platform_actor === true),
    'exactly one of the two ledger rows was platform-initiated',
  ).toHaveLength(1);
  expect(both.find((e) => e.platform_actor === true)!.stage).toBe('content-translation');
  expect(both.find((e) => e.platform_actor === false)!.stage).toBeNull();
});
