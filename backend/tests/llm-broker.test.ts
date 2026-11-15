// tests/llm-broker.test.ts — the metered, cap-enforcing LLM broker against the
// live CI/dev Postgres (:5433). Provider + limits are injected via the
// __setBrokerDepsForTests seam so no real key / external call is needed.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  memberEntitlements,
  db,
  users,
  usageCounters,
  usageEvents,
  withTenantDb,
  withTenantTx,
  runAsSystem,
} from '../src/db/client';
import { DEMO_TENANT_ID, config } from '../src/config';
import {
  brokerLlmCall,
  brokerChatCall,
  brokerChatStream,
  BrokerRejection,
  __setBrokerDepsForTests,
  type Provider,
  type ChatStreamChunk,
} from '../src/host/llm-broker';
import type { LlmProvider } from '../src/ai/llm/provider';
import { linesWithMsg } from './helpers/log-lines';
import { __setByoPostureForTests } from '../src/services/byo-posture';

const USER_ID = '00000000-0000-0000-0000-0000000b0001';
const TEST_IDS = [USER_ID];

// Tests call the broker directly (no request wrapper), so the tenant_id GUC default
// has nothing to read. Run metered inserts inside an explicit tenant context.
const meter = <T>(fn: () => Promise<T>) => withTenantDb(DEMO_TENANT_ID, fn);

// ⛔ THE OTHER METERING SCOPE, AND THE ONE PRODUCTION ACTUALLY USES ON THESE PATHS.
// `withTenantDb` RESERVES a connection and sets `app.current_tenant` on it, so EVERY statement —
// plain or transactional — carries the GUC. `withTenantTx` reserves nothing: it installs
// `{tenantId, boundDb: poolDb}` and the `db` Proxy injects `SET LOCAL app.current_tenant` ONLY on
// the `.transaction` property (see the Proxy in db/client.ts). A plain `db.execute` under it runs
// on the pool with NO GUC, so `app_current_tenant_uuid()` is NULL and every
// `WHERE tenant_id = app_current_tenant_uuid()` matches zero rows — with or without RLS, because
// the predicate names the function directly.
//
// Every reachable broker caller meters through THIS shape, not `meter`:
// run-controller.ts:452 (`brokerLlmCall`), ai/agent.ts:238 `runAgentChatScoped`
// (`brokerChatCall` / `brokerChatStream`), translation-service.ts:301. So a broker statement that
// is correct only under `withTenantDb` is broken in 100% of production traffic while every test
// in this file that uses `meter` stays green. Assert the release paths under both.
const meterTx = <T>(fn: () => Promise<T>) => withTenantTx(DEMO_TENANT_ID, fn);

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

// ⛔ THE FIXTURES RUN AS SYSTEM, THE SUBJECT DOES NOT. Every helper below is scaffolding: it sets
// up or reads back rows so that the BROKER's own writes can be judged. Scaffolding must not be
// subject to the thing under test. Run this file against a production-shaped, NOBYPASSRLS role
// (`DATABASE_URL=…cp_app… MIGRATE_DATABASE_URL=…owner…`) and an unscoped `db.delete` here matches
// zero rows under RLS — cleanup silently no-ops, then the `users` delete dies on
// `usage_counters_user_id_fkey` and all 33 tests fail on the fixture rather than on the product.
// `runAsSystem` binds the owner pool (MIGRATE_DATABASE_URL) with no tenant GUC, which is the same
// escape hatch the seeder and the cross-tenant schedulers use. Reads go through it for the same
// reason plus one more: an assertion must observe what the broker ACTUALLY wrote, including a row
// that RLS would hide from the tenant — otherwise "the refund did not happen" and "the refund
// happened on a row I cannot see" are indistinguishable.
async function cleanup() {
  // usage_events before users: the ledger is what the served-model tests assert on, and a leftover
  // row from a previous test in this file would make their `toHaveLength(1)` order-dependent.
  await runAsSystem('boot-seed', async () => {
    await db.delete(usageEvents).where(inArray(usageEvents.user_id, TEST_IDS));
    await db.delete(usageCounters).where(inArray(usageCounters.user_id, TEST_IDS));
    await db.delete(users).where(inArray(users.id, TEST_IDS));
  });
}

// ⛔ READ THE COUNTER BY ITS WHOLE KEY. Since 0059 the table's only natural key is
// (tenant_id, user_id, day), and this file's own fixtures write MORE THAN ONE ROW for USER_ID:
// the weekly-window cases seed `current_date - 6` and `current_date - 7` before the broker creates
// today's. `where(eq(user_id))` + `const [row] =` therefore takes whichever row the planner
// happened to return first, with no ORDER BY — it is only ever right by luck, and it goes wrong
// silently. Every assertion in this file is about TODAY's row for THIS tenant, so say so.
const counterRows = () =>
  runAsSystem('platform-admin', () =>
    db
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.tenant_id, DEMO_TENANT_ID),
          eq(usageCounters.user_id, USER_ID),
          eq(usageCounters.day, sql`current_date`),
        ),
      ),
  );

/** Today's counter row, asserted to EXIST first. `row!` turned a missing row into
 *  `TypeError: undefined is not an object`, which names neither the row nor the reason — and a
 *  suite that starts at 23:59:59 will one day cross midnight between the write and this read.
 *  `toHaveLength(1)` fails as "expected length 1, received 0" against the query above, which is
 *  legible. Use `counterRows()` directly for the cases where NO row is the correct answer. */
async function counterRow() {
  const rows = await counterRows();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

// ⛔ `tenant_id` IS PART OF THE FIXTURE, not decoration. This user used to be seeded with a NULL
// tenant, which no real user has (Keycloak provisioning always stamps one). `settleSpend` writes
// its ledger row as
// `COALESCE(<explicit tenantId>, (SELECT tenant_id FROM users WHERE id = …))`, and the chat paths
// pass `tenantId: null` — so a tenant-less user made that INSERT write `tenant_id = NULL`, which
// every RLS `WITH CHECK` on `usage_events` rejects (42501) the moment the runtime role is not the
// owner. Owner-DSN runs never noticed. Give the fixture a tenant and the ledger row is stamped
// with it, exactly as production does.
async function seedUser() {
  await runAsSystem('boot-seed', () =>
    db
      .insert(users)
      .values({ id: USER_ID, email: 'broker@test', name: 'Broker', tenant_id: DEMO_TENANT_ID })
      .onConflictDoNothing({ target: users.id }),
  );
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await seedUser();
}, 30_000);
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

// ---- the seat is checked AT THE POINT OF SPEND, not only at the HTTP door ------------------------
//
// ⭐ WHY THESE EXIST SEPARATELY FROM `middleware/license-gate.ts`'s tests: a scheduled flow run, a
// webhook run and a dataset mapping bill a human `userId` with no HTTP request of theirs in flight,
// so the gate never sees them. Only `assertMemberSeat` covers those producers.

const setPerMemberGate = (on: boolean) => {
  (config.license as { perMemberGate: boolean }).perMemberGate = on;
};

async function seatRow(status: 'active' | 'revoking' | 'revoked') {
  await runAsSystem('boot-seed', async () => {
    await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, USER_ID));
    await db.insert(memberEntitlements).values({
      tenant_id: DEMO_TENANT_ID,
      user_id: USER_ID,
      app_key: config.license.appKey,
      status,
      license_id: '00000000-0000-4000-8000-00000000b001',
      license_subject_id: '11111111-1111-4111-8111-00000000b001',
    });
  });
}

async function clearSeat() {
  await runAsSystem('boot-seed', () =>
    db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, USER_ID)),
  );
}

test('a member with no seat is refused before the provider is called', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  await clearSeat();
  setPerMemberGate(true);
  try {
    // ⚠️ MUTATION TARGET: delete the `assertMemberSeat` call in `reserveCall` and this call succeeds,
    // spending the provider's money on a member nobody is billed for.
    const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe('seat_required');
      expect(out.rule).toBe('llm_seat_required');
    }
    // The provider was never touched, so nothing was spent and no slot was burned.
    expect(fp.calls()).toBe(0);
    expect(await counterRows()).toHaveLength(0);
  } finally {
    setPerMemberGate(false);
  }
}, 30_000);

test('a seat being released (`revoking`) still works — it is still being billed', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  await seatRow('revoking');
  setPerMemberGate(true);
  try {
    // ⭐ Cutting service here would charge the tenant for a seat we refused to serve: `revoking`
    // means the central revoke has not been acknowledged yet, so `human_subjects` still counts it.
    const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
    expect(out.ok).toBe(true);
  } finally {
    setPerMemberGate(false);
    await clearSeat();
  }
}, 30_000);

test('with the flag off, a seatless member is not refused', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  await clearSeat();
  // ⛔ The rollout invariant: entitlements are still being backfilled until LICENSE_GATE_PER_MEMBER
  // flips, so enforcing early would deny members whose seat merely has not been minted yet.
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(true);
}, 30_000);

test('a successful brokered call meters tokens + cost into usage_counters', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'hello world' }));
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.result.text).toBe('echo:hello world');
    expect(out.result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
    expect(out.result.costUsd).toBeGreaterThan(0);
  }
  expect(fp.calls()).toBe(1);

  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBeGreaterThan(0);
});

// The in-cluster inference-router does NOT 404 a model it cannot serve — it answers 200 and
// substitutes, reporting the truth in `served_model`/`served_provider`. Metering the REQUESTED id
// therefore billed a tenant for a model that never ran: prod's Usage screen showed real spend
// against `claude-sonnet-4-6` and `claude-haiku-4-5` on a router that serves neither, and that
// phantom spend counts against the weekly ceiling that gates service.
//
// Non-vacuity: revert the `out.servedModel ?? model` swap in `runMetered` and the ledger records
// `claude-sonnet-4-6` instead of `local-llm`.
//
// ⚠ What this test asserts about MONEY was rewritten 2026-08-12. It used to require the substituted
// call to cost exactly $0, on the grounds that "local inference is free, so nothing may be charged"
// — that is #157's rule, and pricing every local call at zero is what made 100% of this
// deployment's ledger read $0.00 and left the weekly ceiling unreachable. Local inference is now
// priced NOTIONALLY at the flat tier (ai/llm/pricing.ts). The substitution behaviour itself is
// unchanged and is still the point: a $0.035 flat estimate for what the router actually served is
// a very different bill from Claude-Sonnet's table rate for a model that never ran.
test('a substituted model is metered as what the gateway SERVED, not what was requested', async () => {
  let calls = 0;
  const provider: Provider = async (req) => {
    calls++;
    return {
      text: `echo:${req.prompt}`,
      tokensIn: 1000,
      tokensOut: 1000,
      servedModel: 'local-llm',
      servedProvider: 'pgx-local',
    };
  };
  __setBrokerDepsForTests({
    provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });

  const out = await meter(() =>
    brokerLlmCall(USER_ID, { model: 'claude-sonnet-4-6', prompt: 'summarize' }),
  );
  expect(out.ok).toBe(true);
  expect(calls).toBe(1);

  // Priced at the flat tier: dropping `presetKey` on substitution (the tenant's chosen vendor is
  // wrong once the gateway routed elsewhere) leaves nothing to price from, which is exactly the
  // `!presetKey` fall-through. 1000 * $0.00001 + 1000 * $0.000025 = $0.035.
  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBe(0.035);

  // The ledger — the authoritative billing record — must name the model that actually ran, and
  // say that its price is an estimate rather than a vendor rate.
  const events = await runAsSystem('platform-admin', () =>
    db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID)),
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.model).toBe('local-llm');
  expect(events[0]!.provider).toBe('pgx-local');
  expect(Number(events[0]!.cost_usd)).toBe(0.035);
  expect(events[0]!.price_source).toBe('flat');
});

// The other half of the contract: a provider that reports nothing about routing (every direct
// vendor — OpenAI, DeepSeek, xAI, Cohere, Anthropic) must be metered exactly as before. Without
// this, the fix above could "pass" by always zeroing spend.
test('a provider that reports no served model is metered on the requested model, unchanged', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });

  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'some-vendor-model', prompt: 'x' }));
  expect(out.ok).toBe(true);

  const events = await runAsSystem('platform-admin', () => db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID)));
  expect(events).toHaveLength(1);
  expect(events[0]!.model).toBe('some-vendor-model');
  const row = await counterRow();
  expect(Number(row.spend_usd)).toBeGreaterThan(0);
});

test('daily cap rejects BEFORE the provider is called (no spend)', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 0, weeklySpendUsd: 100 }),
  });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe('llm_capped');
  expect(fp.calls()).toBe(0); // the runner literally cannot bypass

  const [row] = await counterRows();
  // row may exist (created by the INSERT) but must show zero spend
  expect(row ? Number(row.spend_usd) : 0).toBe(0);
});

test('weekly spend ceiling rejects once exceeded', async () => {
  const fp = fakeProvider();
  // Pre-seed today's spend above the ceiling.
  await runAsSystem('boot-seed', () =>
    db.execute(
      sql`INSERT INTO usage_counters (tenant_id, user_id, day, llm_calls, spend_usd)
          VALUES (${DEMO_TENANT_ID}, ${USER_ID}, current_date, 5, 99.0)`,
    ),
  );
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 50 }),
  });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(false);
  expect(fp.calls()).toBe(0);
});

// ---- the ceiling's WINDOW is 7 days, and both of its edges are pinned --------------------------
//
// `reserveCall` summed `day > current_date - INTERVAL '6 days'`. `day` is a DATE and
// `current_date - INTERVAL '6 days'` is a midnight TIMESTAMP, so `>` excluded `current_date - 6`
// and the "rolling 7-day" ceiling actually summed SIX days. Nothing could see it: every existing
// test in this file seeds `current_date` only, so the window's far edge was never exercised at all
// — the bug lived entirely in the days no fixture ever wrote to. Five places describe this as 7
// days, including the customer-facing `policy_desc_spend_weekly_spend_ceiling` locale string.

test('the weekly ceiling counts the OLDEST day of the window (current_date - 6)', async () => {
  const fp = fakeProvider();
  // ONE counter row, on the seventh day back, holding spend well over the ceiling. Today's row
  // does not exist yet (reserveCall creates it at 0), so this row is the ONLY thing that can
  // reject the call — which is what makes the test non-vacuous: restore the old `>` and the sum
  // is 0.00, the call is admitted, and every assertion below flips.
  await runAsSystem('boot-seed', () =>
    db.execute(
      sql`INSERT INTO usage_counters (tenant_id, user_id, day, llm_calls, spend_usd)
          VALUES (${DEMO_TENANT_ID}, ${USER_ID}, current_date - 6, 5, 99.0)`,
    ),
  );
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 50 }),
  });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe('llm_capped');
  expect(fp.calls()).toBe(0); // rejected before the provider, so no spend was added to the pile
});

test('the weekly ceiling window STOPS at 7 days: spend on current_date - 7 is outside it', async () => {
  // The other edge, pinned so the fix cannot drift the other way. `>=` on a 6-day interval spans
  // current_date-6 … current_date inclusive = exactly 7 distinct days; day -7 is the eighth and
  // must not count. Without this, changing the predicate to `>= current_date - INTERVAL '7 days'`
  // (an 8-day window, and an easy "off-by-one goes the other way" correction) would stay green.
  const fp = fakeProvider();
  await runAsSystem('boot-seed', () =>
    db.execute(
      sql`INSERT INTO usage_counters (tenant_id, user_id, day, llm_calls, spend_usd)
          VALUES (${DEMO_TENANT_ID}, ${USER_ID}, current_date - 7, 5, 99.0)`,
    ),
  );
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 50 }),
  });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
  expect(out.ok).toBe(true);
  expect(fp.calls()).toBe(1);
});

test('concurrent calls at cap=1 serialize via FOR UPDATE → exactly one succeeds', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: async (req) => {
      // small delay so the two txns genuinely overlap on the lock
      await new Promise((r) => setTimeout(r, 20));
      return fp.provider(req);
    },
    limits: () => ({ dailyLlmCap: 1, weeklySpendUsd: 100 }),
  });
  const [a, b] = await Promise.all([
    meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'a' })),
    meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'b' })),
  ]);
  const oks = [a, b].filter((r) => r.ok).length;
  expect(oks).toBe(1);
  expect(fp.calls()).toBe(1);
});

// ⛔ THE FLAKE THIS SHAPE EXISTS TO PREVENT (WS-7, 2026-08-16) — do NOT reintroduce a real-clock
// wait here, and do NOT drop the `finally`.
//
// This test used to poll the wall clock for the provider to be entered:
//     for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5));
//     expect(calls).toBe(1);
// 250 ms, against a reserve transaction (`llm-broker.ts` reserveCall: INSERT … ON CONFLICT, then
// SELECT … FOR UPDATE) whose duration is a property of the DATABASE, not of the code under test.
// The six sibling polls in this suite allow 3–6 s; this one was by far the tightest. Reproduced
// 2026-08-16 against a throwaway `postgres:18` starved with
// `docker update --cpus=0.01 --memory=180m`: THIS TEST FAILED 12 OF 20 RUNS with
// `Expected: 1 / Received: 0`, at observed failure durations from 574 ms up to 9.98 s.
//
// ⛔ AND IT CASCADED, which is the expensive half. When line `expect(calls).toBe(1)` threw, the old
// body never reached `releaseFirst()`, so `first` NEVER SETTLED — leaving (a) a pooled connection
// checked out for the rest of the process (`withTenantDb` releases in its `finally`; pool max is 6)
// and (b) an unwatched in-flight broker call. That call resumed inside the NEXT test's
// `beforeEach`, INSERTing its usage_counters row between `cleanup()`'s `delete(usageCounters)` and
// its `delete(users)`, so `brokerChatCall meters the chat turn` died before its body ran with:
//     PostgresError: update or delete on table "users" violates foreign key constraint
//     "usage_counters_user_id_fkey" … Key (id)=(…000b0001) is still referenced from usage_counters
// IT FAILED 8 OF THE SAME 20 RUNS AND NEVER INDEPENDENTLY — one root cause, two reds, and the
// second one names a table the failing test never touches. Same fingerprint as a fixture-id
// collision (tests/fixture-id-collisions.test.ts), which is what made it so hard to place.
//
// MEASURED, exactly as run — 20 runs before, 10 after (the after-loop was stopped at 10 for time,
// so do not read the second column as 20):
//     before  20 runs   14 red   poll test 12/20   cascade 8/20   `usage_counters_user_id_fkey` x18
//     after   10 runs    0 red   poll test  0/10   cascade 0/10   `usage_counters_user_id_fkey` x0
// The after-runs faced a HARSHER box than the before-runs (other agents' Postgres containers had
// joined the same Docker VM; per-run wall time climbed 42 s → 81 s across the ten), so the
// asymmetry is not an artefact of a quieter machine.
//
// Three properties keep it fixed, and each is load-bearing on its own:
//   1. `providerEntered` is resolved from INSIDE the injected provider, so the wait is on the
//      EVENT, with no clock anywhere. A genuinely hung reserve now reports bun's 30 s timeout on
//      the line that is actually waiting, instead of a wrong assertion in the next test.
//   2. Everything after `first` is created runs in a `try`, whose `finally` releases the provider
//      UNCONDITIONALLY.
//   3. `await first` in that `finally` is the one that kills the cascade: it hands the pooled
//      connection back and forces the settle to land inside THIS test's window.
test('an in-flight spend reservation prevents a second call from passing the old settled-spend snapshot', async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  let markProviderEntered!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const providerEntered = new Promise<void>((resolve) => { markProviderEntered = resolve; });
  __setBrokerDepsForTests({
    provider: async (req) => {
      calls++;
      markProviderEntered();
      await firstMayFinish;
      return { text: req.prompt, tokensIn: 10, tokensOut: 5 };
    },
    // model "m" uses the flat fallback: a one-character prompt plus maxTokens=100 reserves
    // 1 * $0.00001 + 100 * $0.000025 = $0.00251. One fits this ceiling; two overlapping
    // reservations ($0.00502) cannot. (Was $0.001503 against a $0.002 ceiling until the flat
    // defaults moved to the prod notional rates — same arithmetic, restated.)
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 0.004 }),
  });

  const first = meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'a', maxTokens: 100 }));
  try {
    // Raced against `first` so that a reserve which REJECTS surfaces its own error here rather
    // than parking us until the test timeout — `first` cannot resolve while `firstMayFinish` is
    // unresolved, so the race can only ever be won by `providerEntered` or by a rejection.
    await Promise.race([providerEntered, first]);
    expect(calls).toBe(1);

    const second = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'b', maxTokens: 100 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe('llm_capped');
    expect(calls).toBe(1);
  } finally {
    // ⛔ BOTH LINES, ALWAYS. Releasing without awaiting still leaves the settle in flight for the
    // next test's beforeEach to trip over.
    releaseFirst();
    await first.catch(() => {});
  }
  expect((await first).ok).toBe(true);
  const row = await counterRow();
  expect(Number(row.reserved_spend_usd)).toBe(0);
});

// ---- the agent-loop (chat) path shares the SAME gate/ledger (D1) ----

function fakeChat(): { chatProvider: LlmProvider; calls: () => number } {
  let calls = 0;
  return {
    chatProvider: {
      chat: async () => {
        calls++;
        return {
          text: 'hi',
          toolCalls: [{ id: 'c1', name: 'search_blocks', input: { query: 'x' } }],
          usage: { tokensIn: 12, tokensOut: 7 },
        };
      },
    },
    calls: () => calls,
  };
}

test('brokerChatCall meters the chat turn + returns tool calls', async () => {
  const fc = fakeChat();
  __setBrokerDepsForTests({
    chatProvider: fc.chatProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const ac = new AbortController();
  const out = await meter(() =>
    brokerChatCall(
      USER_ID,
      null,
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal },
    ),
  );
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.result.toolCalls?.[0]?.name).toBe('search_blocks');
    expect(out.result.usage).toEqual({ tokensIn: 12, tokensOut: 7 });
    expect(out.costUsd).toBeGreaterThan(0);
  }
  expect(fc.calls()).toBe(1);

  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBeGreaterThan(0);
});

test('brokerChatCall daily cap rejects BEFORE the provider (no spend)', async () => {
  const fc = fakeChat();
  __setBrokerDepsForTests({
    chatProvider: fc.chatProvider,
    limits: () => ({ dailyLlmCap: 0, weeklySpendUsd: 100 }),
  });
  const ac = new AbortController();
  const out = await meter(() =>
    brokerChatCall(
      USER_ID,
      null,
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal },
    ),
  );
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe('llm_capped');
  expect(fc.calls()).toBe(0);
});

test('brokerChatCall enforces the model allowlist (chat path, no spend)', async () => {
  const fc = fakeChat();
  __setBrokerDepsForTests({
    chatProvider: fc.chatProvider,
    limits: () => ({
      dailyLlmCap: 100,
      weeklySpendUsd: 100,
      allowlistedModels: ['claude-sonnet-4-6'],
    }),
  });
  const ac = new AbortController();
  const out = await meter(() =>
    brokerChatCall(
      USER_ID,
      null,
      { model: 'gpt-not-allowed', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal },
    ),
  );
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe('model_not_allowed');
  expect(fc.calls()).toBe(0);
});

// ---- streaming path: reserve-then-settle (brokerChatStream) ----

function fakeStreamChat(): { chatProvider: LlmProvider; streamCalls: () => number } {
  let streamCalls = 0;
  return {
    chatProvider: {
      chat: async () => ({ text: 'whole', usage: { tokensIn: 10, tokensOut: 5 } }),
      async *stream() {
        streamCalls++;
        yield { type: 'text', text: 'Hel' };
        yield { type: 'text', text: 'lo' };
        yield { type: 'done', usage: { tokensIn: 10, tokensOut: 5 }, text: 'Hello' };
      },
    },
    streamCalls: () => streamCalls,
  };
}

const isDone = (c: ChatStreamChunk): c is Extract<ChatStreamChunk, { type: 'done' }> => c.type === 'done';

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

test('brokerChatStream streams text deltas then settles spend (call reserved up front)', async () => {
  const fs = fakeStreamChat();
  __setBrokerDepsForTests({
    chatProvider: fs.chatProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const chunks = await meter(() =>
    drain(
      brokerChatStream(USER_ID, null, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal }),
    ),
  );
  expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)).toEqual(['Hel', 'lo']);
  const done = chunks.find(isDone);
  expect(done?.result.text).toBe('Hello');
  expect(done?.result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
  expect(done?.costUsd).toBeGreaterThan(0);
  expect(fs.streamCalls()).toBe(1);

  const row = await counterRow();
  expect(row.llm_calls).toBe(1); // reserved up front
  expect(Number(row.spend_usd)).toBeGreaterThan(0); // settled after the stream
});

test('brokerChatStream cap-rejects BEFORE streaming (throws BrokerRejection, no provider call, no spend)', async () => {
  const fs = fakeStreamChat();
  __setBrokerDepsForTests({
    chatProvider: fs.chatProvider,
    limits: () => ({ dailyLlmCap: 0, weeklySpendUsd: 100 }),
  });
  let threw: unknown;
  try {
    await meter(() => drain(brokerChatStream(USER_ID, null, { model: 'm', messages: [] }, { signal: new AbortController().signal })));
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(BrokerRejection);
  expect((threw as BrokerRejection).kind).toBe('llm_capped');
  expect(fs.streamCalls()).toBe(0); // never reached the provider
  const [row] = await counterRows();
  expect(row ? Number(row.spend_usd) : 0).toBe(0);
  expect(row ? row.llm_calls : 0).toBe(0); // reserve rolled back on reject
});

test('brokerChatStream allowlist-rejects BEFORE streaming', async () => {
  const fs = fakeStreamChat();
  __setBrokerDepsForTests({
    chatProvider: fs.chatProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100, allowlistedModels: ['allowed-model'] }),
  });
  let threw: unknown;
  try {
    await meter(() => drain(brokerChatStream(USER_ID, null, { model: 'nope', messages: [] }, { signal: new AbortController().signal })));
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(BrokerRejection);
  expect((threw as BrokerRejection).kind).toBe('model_not_allowed');
  expect(fs.streamCalls()).toBe(0);
});

// ⛔⛔ THE STREAMING PATH MUST CLASSIFY "OUT OF CREDIT" TOO, OR THE CHAT PANEL SHOWS RAW PROVIDER
// TEXT. `isCreditExhaustion` used to have exactly ONE call site — `runMetered`, the NON-streaming
// path. `brokerChatStream` let the provider's `LlmProviderHttpError` propagate untouched, so
// `ai/agent.ts` found no `BrokerRejection`, emitted a `turn-end` with no `kind`, and the browser
// rendered the provider's own string:
//     {"type":"turn-end","status":"error","message":"openrouter 402: insufficient credit for this request"}
// A Dutch reader got that. `budget_exhausted` was simultaneously advertised as a member of a closed,
// fully-handled union and unreachable on this surface.
//
// REVERT THAT TURNS THESE RED: delete the `isCreditExhaustion(err)` branch from `brokerChatStream`'s
// catch. The rejection reverts to a bare `LlmProviderHttpError` with no `kind`.
test('brokerChatStream turns a provider credit failure into kind=budget_exhausted (and hands the slot back)', async () => {
  const { LlmProviderHttpError } = await import('../src/ai/llm/adapters/openai');
  let streamCalls = 0;
  const chatProvider: LlmProvider = {
    chat: async () => ({ text: 'unused', usage: { tokensIn: 1, tokensOut: 1 } }),
    // Mirrors adapters/openai.ts:217 — the adapter raises on `!res.ok`, i.e. BEFORE the first SSE
    // frame, so the generator throws without ever yielding. That is what makes a BrokerRejection
    // (whose contract is "before any token streams") the correct shape here.
    // eslint-disable-next-line require-yield
    async *stream() {
      streamCalls++;
      throw new LlmProviderHttpError(402, 'insufficient credit for this request', 'openrouter');
    },
  };
  __setBrokerDepsForTests({ chatProvider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });

  let threw: unknown;
  const seen: ChatStreamChunk[] = [];
  try {
    await meter(async () => {
      for await (const c of brokerChatStream(
        USER_ID,
        null,
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      )) {
        seen.push(c);
      }
    });
  } catch (e) {
    threw = e;
  }
  // The provider really was reached — otherwise this is the cap-reject case wearing a disguise.
  expect(streamCalls, 'the provider was never called — this is not the credit path').toBe(1);
  expect(threw).toBeInstanceOf(BrokerRejection);
  expect((threw as BrokerRejection).kind).toBe('budget_exhausted');
  // THE POSITIVE HALF: the prose is the actionable sentence, not the provider's wire string.
  expect((threw as BrokerRejection).message).toContain('LLM settings');
  expect((threw as BrokerRejection).message).not.toContain('402');
  // Contract intact: nothing was yielded before the throw.
  expect(seen).toEqual([]);
  // And the shape change did not disturb the metering — the reserved slot is handed back exactly
  // as it is for any other stream failure.
  const [row] = await runAsSystem('platform-admin', () => db.select().from(usageCounters).where(eq(usageCounters.user_id, USER_ID)));
  expect(row?.llm_calls ?? 0).toBe(0);
  expect(row ? Number(row.spend_usd) : 0).toBe(0);
});

test('an ordinary provider failure on the stream path is NOT reclassified as budget_exhausted', async () => {
  // ⛔ THE COMPLEMENT. `isCreditExhaustion` must stay a discriminator, not a catch-all: a transport
  // reset or a 500 has to keep propagating raw so the browser's `message` fallback still describes
  // it. A catch that wrapped everything would satisfy the case above and silently retitle every
  // outage as "top up your budget".
  const chatProvider: LlmProvider = {
    chat: async () => ({ text: 'unused', usage: { tokensIn: 1, tokensOut: 1 } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('upstream connect error');
    },
  };
  __setBrokerDepsForTests({ chatProvider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  let threw: unknown;
  try {
    await meter(() =>
      drain(brokerChatStream(USER_ID, null, { model: 'm', messages: [] }, { signal: new AbortController().signal })),
    );
  } catch (e) {
    threw = e;
  }
  expect(threw).not.toBeInstanceOf(BrokerRejection);
  expect((threw as Error).message).toContain('upstream connect error');
  const [row] = await runAsSystem('platform-admin', () => db.select().from(usageCounters).where(eq(usageCounters.user_id, USER_ID)));
  expect(row?.llm_calls ?? 0).toBe(0);
});

test('brokerChatStream falls back to chat() with one delta when the provider has no stream()', async () => {
  const chatProvider: LlmProvider = {
    chat: async () => ({ text: 'whole answer', usage: { tokensIn: 8, tokensOut: 4 } }),
  };
  __setBrokerDepsForTests({ chatProvider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const chunks = await meter(() =>
    drain(
      brokerChatStream(USER_ID, null, { model: 'm', messages: [] }, { signal: new AbortController().signal }),
    ),
  );
  expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)).toEqual(['whole answer']);
  expect(chunks.find(isDone)?.result.text).toBe('whole answer');
  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBeGreaterThan(0);
});

// ---- brokerChatStream must SETTLE an ESTIMATE (never silently refund) when real text was
// already streamed to the caller before an abort/mid-stream death, and must still release the
// slot outright when nothing streamed. Before this fix (migration 0087,
// price_source='abort_estimate') both tests below asserted ZERO ledger rows here — that pinned
// the leak as the spec: the vendor had already been charged for the delivered tokens, and
// `releaseCall` made that spend vanish with no usage_events row to show for it. ----

test('brokerChatStream settles an estimate (not a release) when the provider stream throws mid-stream after delivering text', async () => {
  const chatProvider: LlmProvider = {
    chat: async () => {
      throw new Error('chat() should not be reached — stream() exists');
    },
    async *stream() {
      yield { type: 'text', text: 'Hel' };
      throw new Error('provider exploded mid-stream');
    },
  };
  __setBrokerDepsForTests({ chatProvider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });

  let threw: unknown;
  try {
    await meter(() =>
      drain(
        brokerChatStream(USER_ID, null, { model: 'm', messages: [] }, { signal: new AbortController().signal }),
      ),
    );
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toBe('provider exploded mid-stream');

  // The call slot stays spent — a settle, not a release, happened. Previously this asserted
  // llm_calls === 0 (a refund); that was the bug: "Hel" really streamed and the vendor was
  // already billed for it.
  const [row] = await counterRows();
  expect(row?.llm_calls ?? 0).toBe(1);
  expect(row ? Number(row.reserved_spend_usd) : 0).toBe(0); // the reservation was consumed by the settle, not left dangling
  expect(row ? Number(row.spend_usd) : 0).toBeGreaterThan(0);

  const events = await runAsSystem('platform-admin', () =>
    db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID)),
  );
  // Exactly ONE row — settle-or-release happens exactly once, never both.
  expect(events).toHaveLength(1);
  const [row0] = events;
  expect(row0?.price_source).toBe('abort_estimate');
  // tokens_out is estimateTokens('Hel') = max(1, ceil(3/4)) = 1 — derived from what actually
  // streamed, not from the provider's never-reached terminal usage frame.
  expect(row0?.tokens_out).toBe(1);
});

test('brokerChatStream settles an estimate (not a release) when the consumer abandons the stream early (client disconnect / run abort)', async () => {
  let providerSawAbandon = false;
  const chatProvider: LlmProvider = {
    chat: async () => {
      throw new Error('chat() should not be reached — stream() exists');
    },
    async *stream() {
      try {
        yield { type: 'text', text: 'Hel' };
        yield { type: 'text', text: 'lo' };
        yield { type: 'done', usage: { tokensIn: 10, tokensOut: 5 }, text: 'Hello' };
      } finally {
        // proves the underlying provider generator itself got torn down, not just the broker's
        providerSawAbandon = true;
      }
    },
  };
  __setBrokerDepsForTests({ chatProvider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });

  await meter(async () => {
    const gen = brokerChatStream(
      USER_ID,
      null,
      { model: 'm', messages: [] },
      { signal: new AbortController().signal },
    );
    for await (const _chunk of gen) {
      break; // abandon after the first chunk, exactly like a client disconnect
    }
  });

  expect(providerSawAbandon).toBe(true);
  const [row] = await counterRows();
  // Previously this asserted llm_calls === 0 (a refund). "Hel" streamed before the break, so a
  // settle must happen instead — the slot stays spent and the reservation is consumed, not
  // dangling.
  expect(row?.llm_calls ?? 0).toBe(1);
  expect(row ? Number(row.reserved_spend_usd) : 0).toBe(0);
  expect(row ? Number(row.spend_usd) : 0).toBeGreaterThan(0);

  const events = await runAsSystem('platform-admin', () =>
    db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID)),
  );
  expect(events).toHaveLength(1);
  const [row0] = events;
  expect(row0?.price_source).toBe('abort_estimate');
  // Only "Hel" (3 chars) was yielded before the break — the 'lo' and 'done' chunks were never
  // reached, so tokens_out is estimateTokens('Hel') = 1, not estimateTokens('Hello') or the
  // provider's real usage.tokensOut of 5.
  expect(row0?.tokens_out).toBe(1);
});

// ---- the provider call must NOT run inside the metering transaction ----
//
// It used to: `invoke()` sat between `SELECT … FOR UPDATE` on usage_counters and the ledger INSERT,
// so a slow or hung provider held a DB transaction and that row lock for its entire duration. With
// DB_TX_POOL_MAX=4, four concurrent hung calls exhausted the transaction pool and deadlocked the
// process — the same shape as the incident that produced the dedicated tx pool.

test('the call slot is COMMITTED before the provider runs (no txn held across the call)', async () => {
  let seenDuringCall: number | null = null as number | null;
  const provider: Provider = async () => {
    // Read on a SEPARATE connection while the provider "call" is in flight. If the reservation were
    // still inside an open transaction this would either block or see the pre-increment value.
    const rows = (await db.execute(
      sql`SELECT llm_calls FROM usage_counters WHERE user_id = ${USER_ID} AND day = current_date`,
    )) as unknown as { llm_calls: number }[];
    seenDuringCall = rows[0]?.llm_calls ?? 0;
    return { text: 'ok', tokensIn: 1, tokensOut: 1 };
  };
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 50, weeklySpendUsd: 15 }) });

  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }));
  expect(out.ok).toBe(true);
  // The slot was already visible to another connection => the reserve txn had committed.
  expect(seenDuringCall).toBe(1);
});

test('a provider FAILURE hands the reserved call slot back', async () => {
  // The slot is claimed up front (that is what makes the daily cap race-free), so a provider outage
  // must not silently burn the user's quota for the day.
  const provider: Provider = async () => {
    throw new Error('provider exploded');
  };
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 50, weeklySpendUsd: 15 }) });

  await expect(meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }))).rejects.toThrow(
    'provider exploded',
  );
  const [row] = await counterRows();
  expect(row?.llm_calls ?? 0).toBe(0);
});

// ---- the release paths must work under withTenantTx, the scope production meters in ------------
//
// The test above proves the refund under `withTenantDb`. Nothing reaches the broker that way:
// run-controller / runAgentChatScoped / translation-service all use `withTenantTx` precisely so a
// slow LLM call does not pin one of six reserved request connections. Under that scope
// `releaseCall`'s plain `deps.db.execute` had no GUC, so its
// `WHERE tenant_id = app_current_tenant_uuid()` matched zero rows and the refund was a guaranteed
// no-op — silently, because releaseCall swallows errors and checks no rowcount (unlike its sibling
// `reserveCall`, which asserts one and says why).
//
// User-visible shape: press Stop / close the AI panel / let the provider time out, and
// `brokerChatStream`'s `finally` "returns" the slot to nobody. The slot stays spent for the day and
// `reserved_spend_usd` stays inflated by the reservation (priced at `maxTokens ?? 4096`), counting
// against the 7-day ceiling with no reaper to clear it. The user is then told
// "weekly spend ceiling reached" for money that was never spent.
test('a provider FAILURE hands the slot back under withTenantTx too, not just withTenantDb', async () => {
  const provider: Provider = async () => {
    throw new Error('provider exploded');
  };
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 50, weeklySpendUsd: 15 }) });

  await expect(meterTx(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }))).rejects.toThrow(
    'provider exploded',
  );

  // Non-vacuity: `reserveCall` runs inside `db.transaction`, which the Proxy DOES scope, so the
  // row exists and was incremented. If this row were missing the refund assertion below would pass
  // for the wrong reason (nothing to refund).
  const row = await counterRow();
  expect(row.llm_calls).toBe(0);
  // The spend reservation goes back with the slot — same UPDATE, same predicate.
  expect(Number(row.reserved_spend_usd)).toBe(0);
});

test('a FAILED settle frees the spend reservation under withTenantTx too', async () => {
  // `releaseReservedSpend` is the runMetered-catch sibling of `releaseCall` and shares its defect:
  // a plain `deps.db.execute` under a scope that gives plain statements no GUC. Its own docstring
  // says "There is no reaper to do it later; this is the only chance" — so a no-op here leaves the
  // hold on the weekly ceiling until the row ages out of the 7-day window.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    db: dbWithFailingSettle(),
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });

  const realError = console.error;
  console.error = () => {};
  let out: Awaited<ReturnType<typeof brokerLlmCall>>;
  try {
    out = await meterTx(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'hello world' }));
  } finally {
    console.error = realError;
  }
  expect(out.ok).toBe(true);

  const row = await counterRow();
  // The call slot stays spent — the provider really ran (same contract as the withTenantDb case).
  expect(row.llm_calls).toBe(1);
  // Non-vacuity: the settle genuinely failed, so this is a real un-settled reservation and not a
  // row that happened to be clean because settleSpend zeroed it on the way through.
  expect(Number(row.spend_usd)).toBe(0);
  // THE ASSERTION: the hold is released.
  expect(Number(row.reserved_spend_usd)).toBe(0);
});

test('an exhausted provider budget is a typed rejection, and does not burn the slot', async () => {
  const { LlmProviderHttpError } = await import('../src/ai/llm/adapters/openai');
  const provider: Provider = async () => {
    throw new LlmProviderHttpError(402, 'insufficient credits');
  };
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 50, weeklySpendUsd: 15 }) });

  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }));
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.kind).toBe('budget_exhausted');
    expect(out.error).toContain('LLM settings'); // tells the tenant what to DO
  }
  const [row] = await counterRows();
  expect(row?.llm_calls ?? 0).toBe(0);
});

// ---- a HUNG provider must not hang the caller forever (the unbounded-fetch defect) ----
//
// anthropicProvider had NO signal at all on its fetch, and openaiCompatibleProvider passed
// `new AbortController().signal` — a controller nobody ever aborts, a dead signal that reads like
// a live one. Neither is exercised directly here (both need real network config), but `invoke()` in
// runMetered is the one choke point EVERY provider — including those two, and the test-injected one
// below — flows through, so bounding it there proves the fix for all of them at once. Without
// `withInvokeTimeout` wrapping `invoke()`, this test hangs until bun's 30s test timeout kills it
// (the injected provider's promise never settles) instead of rejecting within `callTimeoutMs`.
test('a HUNG provider is bounded by config.llm.callTimeoutMs: releases the slot and rejects, does not hang', async () => {
  // `config` is declared `as const` (deep-readonly at the TYPE level only — nothing calls
  // Object.freeze), so mutating it for the test needs an explicit cast back to a mutable shape.
  const mutableLlm = config.llm as { callTimeoutMs: number };
  const originalTimeoutMs = mutableLlm.callTimeoutMs;
  mutableLlm.callTimeoutMs = 150; // short, injected — production default (120s) would stall this test
  try {
    // Never resolves/rejects — the exact shape of a provider whose TCP connection is accepted but
    // which never responds (a real failure mode for a self-hosted in-cluster inference router).
    const provider: Provider = () => new Promise<never>(() => {});
    __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 50, weeklySpendUsd: 15 }) });

    const start = performance.now();
    await expect(meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }))).rejects.toThrow(
      /exceeded callTimeoutMs/,
    );
    const elapsedMs = performance.now() - start;
    // Bounded near the configured ceiling, nowhere near bun's 30s test timeout — proves the call
    // was actually cut off rather than happening to finish fast for an unrelated reason.
    expect(elapsedMs).toBeLessThan(5_000);

    // The slot reserveCall claimed up front must have been handed back — a timeout takes the SAME
    // release path as any other invoke() failure (runMetered's catch calls releaseCall either way),
    // so the run reaches a terminal (rejected) outcome instead of burning the quota on a hang.
    const [row] = await counterRows();
    expect(row?.llm_calls ?? 0).toBe(0);
  } finally {
    mutableLlm.callTimeoutMs = originalTimeoutMs;
  }
}, 10_000);

// ---- a failed SETTLE must not destroy an answer the money already bought ----------------------
//
// `settleSpend`'s whole body is one `deps.db.transaction`, and `runMetered` awaited it unguarded —
// AFTER the provider call had succeeded and been paid for. A pool exhaustion or an `08P01`
// (connection terminated), both of which have happened on this deployment, therefore threw past a
// perfectly good `out` and the caller lost the answer. The live shape is a flow run that fails
// after its LLM step already succeeded and was billed; `host/run-controller.ts` is the one consumer
// that reaches this line.

/** The real db with its SECOND transaction of the call rigged to fail — reserveCall's txn is the
 *  first and must still work, settleSpend's is the second. A Proxy (not a hand-rolled fake) so
 *  every other drizzle method the broker touches, including releaseReservedSpend's `execute`,
 *  behaves exactly as in production. */
function dbWithFailingSettle(): typeof db {
  let txns = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (...args: unknown[]) => {
          txns += 1;
          if (txns === 2) {
            throw new Error('08P01: terminating connection due to administrator command');
          }
          return (target.transaction as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      // receiver = target, not the proxy: drizzle's internals read private fields off `this`, and
      // handing them the proxy would re-enter this trap mid-query.
      return Reflect.get(target, prop, target) as unknown;
    },
  }) as typeof db;
}

test('a FAILED settle still returns the paid-for answer, keeps the call slot spent, and frees the reservation', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    db: dbWithFailingSettle(),
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  let out: Awaited<ReturnType<typeof brokerLlmCall>>;
  try {
    out = await meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'hello world' }));
  } finally {
    console.error = realError;
  }

  // 1. The answer survives. This is the whole point: the provider ran, the tokens were generated
  //    and (on a paid provider) charged; throwing here would make the caller pay twice for it.
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.result.text).toBe('echo:hello world');
  expect(fp.calls()).toBe(1);

  const row = await counterRow();
  // 2. ⛔ The daily call slot stays SPENT. The user really did make the call, so refunding it
  //    (what `releaseCall` would do) would hand back a `spend.daily_llm_cap` slot per settle
  //    failure — a governance quota bypass paid for by a bookkeeping error.
  expect(row.llm_calls).toBe(1);
  // 3. The spend reservation IS released — nothing reaps it later (reserveCall / releaseCall /
  //    settleSpend are the only writers), so an un-freed hold would count against the weekly
  //    ceiling until the row aged out of the window.
  expect(Number(row.reserved_spend_usd)).toBe(0);
  // 4. The settle genuinely failed: the counter never got the spend and the ledger has no row.
  //    Asserting this makes the test non-vacuous — without it, a settle that quietly succeeded
  //    would satisfy everything above.
  expect(Number(row.spend_usd)).toBe(0);
  const events = await runAsSystem('platform-admin', () => db.select().from(usageEvents).where(eq(usageEvents.user_id, USER_ID)));
  expect(events).toHaveLength(0);

  // 5. It is LOUD, and loud enough to reconstruct the lost ledger row by hand: the log carries the
  //    model and the token counts, not just "something failed".
  //
  //    ⛔ READ AS FIELDS, NOT AS TEXT. host/logger.ts emits one JSON object per event, so the old
  //    `includes('SETTLE FAILED')` / `toContain('"tokensIn":10')` substring pair is now an exact
  //    match on `msg` and on the parsed numbers — the same proof, tightened: a line that merely
  //    MENTIONED those characters can no longer satisfy it, and `tokensIn: 100` can no longer pass
  //    as `"tokensIn":10`. Unparseable lines throw rather than being filtered away (see
  //    helpers/log-lines.ts): a raw console.* here would be exactly the unattributable line the
  //    structured logger exists to remove.
  const settleLog = linesWithMsg(logged, 'broker_settle_failed_after_paid_call')[0];
  expect(settleLog).toBeDefined();
  expect(settleLog?.lvl).toBe('error');
  expect(settleLog?.model).toBe('m');
  expect(settleLog?.tokensIn).toBe(10);
  expect(settleLog?.tokensOut).toBe(5);
});

test('the daily cap is still enforced strictly across concurrent calls', async () => {
  // Moving the provider call out of the transaction must not weaken the cap: the slot is claimed
  // inside the reserve txn, so N concurrent calls against a cap of N-1 still reject the excess.
  const provider: Provider = async () => {
    await new Promise((r) => setTimeout(r, 20)); // overlap the calls
    return { text: 'ok', tokensIn: 1, tokensOut: 1 };
  };
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 3, weeklySpendUsd: 15 }) });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => meter(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'p' }))),
  );
  expect(results.filter((r) => r.ok).length).toBe(3);
  expect(results.filter((r) => !r.ok).length).toBe(3);
  const row = await counterRow();
  expect(row?.llm_calls).toBe(3); // never over-counted, never over-admitted
});

// ---- per-model pricing (migration 0053) ------------------------------------------------------

/** Read back the single ledger row this test wrote. */
async function ledgerRow(): Promise<{ model: string; cost_usd: string; price_source: string }> {
  const rows = (await runAsSystem('platform-admin', () =>
    db.execute(sql`SELECT model, cost_usd, price_source FROM usage_events WHERE user_id = ${USER_ID}`),
  )) as unknown as { model: string; cost_usd: string; price_source: string }[];
  return rows[0]!;
}

test('a LOCAL-model call is priced NOTIONALLY at the flat tier, and stamped as an estimate', async () => {
  // ⚠ THIS TEST WAS INVERTED ON 2026-08-12. It read "a LOCAL-model call costs $0 and never accrues
  // toward the weekly ceiling", and it passed for the same reason the product was broken: PR #157
  // priced `local-llm` at exactly zero, and every `usage_events` row this deployment has ever
  // written is `local-llm`, so the entire ledger read $0.00, the two `LLM_*_RATE_USD` knobs became
  // unreachable dead config, and `spend.weekly_spend_ceiling` evaluated `0 + 0 > 15` on every call
  // while /governance reported it enabled. A test asserting $0 was pinning that in place.
  //
  // The marginal cost of pgx hardware really is ~$0; the flat figure is an internal CHARGEBACK
  // estimate, which is why it is stamped `price_source='flat'` rather than given a table row that
  // the UI would be entitled to present as a vendor fact. #157's actual defect — refusing service
  // for spend that never happened — is bounded by arithmetic, not by this zero: at $10/$25 per
  // Mtok, August prod's whole 60,907-in / 19,094-out month costs $1.09 against $15 per week.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const out = await meter(() =>
    brokerLlmCall(USER_ID, { model: 'local-llm', prompt: 'hello world' }),
  );
  expect(out.ok).toBe(true);
  // 10 in + 5 out at the flat tier = 10 * $0.00001 + 5 * $0.000025 = $0.000225. Asserted exactly,
  // not as `> 0`: `> 0` is what the pre-0053 broker test asserted, and it held for every model on
  // earth including the ones being overcharged.
  if (out.ok) expect(out.result.costUsd).toBe(0.000225);

  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBe(0.000225);

  const ev = await ledgerRow();
  expect(ev.model).toBe('local-llm');
  expect(Number(ev.cost_usd)).toBe(0.000225);
  // ⛔ 'flat', not 'table'. It was 'table' because `lookupRate` short-circuited on
  // ZERO_COST_MODELS; that short-circuit is gone, and `local` no longer carries a `*` price row
  // in the catalog either, so both routes to the table now miss and the estimate is labelled.
  expect(ev.price_source).toBe('flat');
});

test('an OpenRouter `:free` model still costs exactly $0 — the surviving zero is a VENDOR fact', async () => {
  // The half of #157 that was KEPT, pinned so emptying ZERO_COST_MODELS does not get "finished"
  // by deleting `isFreeModelId` too. A `:free` suffix is OpenRouter stating that this generation
  // is billed at zero — an invoice, not a hardware policy of ours. Pricing it notionally would
  // invent spend against a bill that will read $0.00, which is the over-billing this whole
  // module exists to remove.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const out = await meter(() =>
    brokerLlmCall(USER_ID, { model: 'google/gemma-4-26b-a4b-it:free', prompt: 'hello world' }),
  );
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.result.costUsd).toBe(0);

  // Still LEDGERED — the dashboards need the row, it just costs nothing.
  const row = await counterRow();
  expect(row.llm_calls).toBe(1);
  expect(Number(row.spend_usd)).toBe(0);

  const ev = await ledgerRow();
  expect(Number(ev.cost_usd)).toBe(0);
  expect(ev.price_source).toBe('table'); // a rate WAS resolved (0/0) — it did not fall through
});

test('an unpriced model still costs something, and is recorded as a flat ESTIMATE', async () => {
  // The honest fallback: nothing prices 'mystery-model', so the legacy estimate is kept rather
  // than booking zero (which would silently defeat the spend ceiling) — but it is stamped 'flat'
  // so the UI keeps hedging it instead of presenting it as fact.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const out = await meter(() =>
    brokerLlmCall(USER_ID, { model: 'mystery-model', prompt: 'hello world' }),
  );
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.result.costUsd).toBeGreaterThan(0);

  const ev = await ledgerRow();
  expect(Number(ev.cost_usd)).toBeGreaterThan(0);
  expect(ev.price_source).toBe('flat');
});

test('a provider-REPORTED cost is written to the ledger verbatim, beating any computed rate', async () => {
  // OpenRouter reports what it actually charged. That is the invoice, not an approximation of it,
  // so it must survive into the ledger unmodified — note the token counts here would produce a
  // dollars-scale number under any per-token rate, and the reported cents win anyway.
  const provider: Provider = async () => ({
    text: 'ok',
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    costUsd: 0.0125,
  });
  __setBrokerDepsForTests({ provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const out = await meter(() => brokerLlmCall(USER_ID, { model: 'z-ai/glm-5.2', prompt: 'p' }));
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.result.costUsd).toBe(0.0125);

  const ev = await ledgerRow();
  expect(Number(ev.cost_usd)).toBe(0.0125);
  expect(ev.price_source).toBe('provider');
});

test('⛔ runner: a keyless byo_required tenant is REFUSED — the mode-driven default is the PLATFORM provider', async () => {
  // No `provider` override: that seam would bypass selection entirely. DEMO_TENANT carries the
  // keyless backfilled settings row, so selection yields no tenant provider and the runner would
  // fall to `chooseProvider()` — in prod the in-cluster inference-router, i.e. platform-paid.
  __setBrokerDepsForTests({ limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const cfg = config.license as { issuanceEnabled: boolean };
  const before = cfg.issuanceEnabled;
  cfg.issuanceEnabled = true;
  __setByoPostureForTests({ resolver: async () => 'byo_required' });
  try {
    // A STRUCTURED refusal (the runner needs an `llm_response` frame), not a throw.
    const out = await meterTx(() => brokerLlmCall(USER_ID, { model: 'm', prompt: 'x' }));
    expect(out).toMatchObject({ ok: false, kind: 'model_not_allowed', rule: 'llm_byo_key_required' });
    // Nothing was metered for a call that never ran.
    const rows = await counterRows();
    expect(rows.reduce((n, r) => n + r.llm_calls, 0)).toBe(0);
  } finally {
    cfg.issuanceEnabled = before;
    __setByoPostureForTests(undefined);
  }
});
