// tests/metering-cross-tenant-cap.test.ts — the behavioural proof for migration 0059.
//
// THE BUG THIS PINS. `usage_counters` carried a `tenant_id` (0028, NOT NULL since 0029) but its
// natural key was still the pre-tenancy `UNIQUE (user_id, day)` from 0004_runs.sql. One user
// therefore had at most ONE counter row per UTC day, globally, whichever tenant they were scoped
// to when they made their first call. Every later call under a DIFFERENT tenant that day then hit:
//
//     INSERT … ON CONFLICT DO NOTHING   -> INSERT 0 0   (silent: the narrow key already matched
//     SELECT … FOR UPDATE               -> 0 rows        another tenant's row)
//     counter = rows[0] ?? { llm_calls: 0 }              <- THE BYPASS
//     UPDATE … SET llm_calls + 1        -> UPDATE 0
//
// so the daily call cap and the weekly spend ceiling were BOTH disabled — silently, with no error
// anywhere — for the rest of the day. The trigger is the super_admin `X-Active-Tenant-Id`
// scope-switch, which the frontend attaches to every request. It is NOT offboard→re-invite (that
// is impossible: offboarding tombstones and mints a new `users.id`).
//
// ⛔ WHY THIS FILE HAD TO WAIT FOR 0059. The assertion "two counter rows, one per tenant, for the
// same (user, day)" was not merely false before 0059 — it was UNREPRESENTABLE. The narrow unique
// constraint made that state impossible to create, so no test could express the fix. That is also
// why "no row shows two tenants for one user+day" was never evidence the bug had not fired.
//
// ⛔ WHY THIS IS NOT VACUOUS UNDER THE OWNER ROLE. Backend tests connect as the table owner
// (`rolbypassrls = true`), so an assertion that leans on RLS to scope a query proves nothing here.
// This file passes precisely BECAUSE the 0059 broker change stopped depending on RLS: every
// statement in `reserveCall`/`releaseCall`/`settleSpend` now carries an explicit
// `tenant_id = app_current_tenant_uuid()` predicate, which is a no-op under RLS and the correct
// answer without it. Run these cases against a broker that relies on RLS alone and case 2 fails:
// the un-predicated `SELECT … WHERE user_id AND day` picks an ARBITRARY tenant's row (no ORDER BY)
// and the `UPDATE` hits every tenant's row for that user.
//
// Fixture ids use the `…00000c59…` prefix (0059), which no other test file uses — see
// tests/fixture-id-collisions.test.ts for why that matters (bun runs files against ONE database).
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  usageCounters,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import {
  brokerLlmCall,
  BrokerRejection,
  __setBrokerDepsForTests,
  type Provider,
} from '../src/host/llm-broker';

const USER_ID = '00000000-0000-0000-0000-00000c590001';
const TENANT_A = '00000000-0000-0000-0000-00000c59a001';
const TENANT_B = '00000000-0000-0000-0000-00000c59b001';

const DAILY_CAP = 2;

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

/** Counter rows for our user, today, one line per tenant. */
async function countersToday(): Promise<{ tenant_id: string; llm_calls: number }[]> {
  return (await db
    .select({ tenant_id: usageCounters.tenant_id, llm_calls: usageCounters.llm_calls })
    .from(usageCounters)
    .where(and(eq(usageCounters.user_id, USER_ID), sql`${usageCounters.day} = current_date`))) as {
    tenant_id: string;
    llm_calls: number;
  }[];
}

async function cleanup(): Promise<void> {
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
    { id: TENANT_A, name: 'Metering Cap A', slug: 'metering-cap-a' },
    { id: TENANT_B, name: 'Metering Cap B', slug: 'metering-cap-b' },
  ]);
  // The user's HOME tenant is A. The bug is about the tenant they are SCOPED to, which for a
  // super_admin is whatever `X-Active-Tenant-Id` says — not this column.
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'metering-cap@test', name: 'Cap', tenant_id: TENANT_A });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

test('the daily cap survives a tenant scope-switch — THE 0059 BUG', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: DAILY_CAP, weeklySpendUsd: 1000 }),
  });

  // Exhaust the cap under tenant A.
  for (let i = 0; i < DAILY_CAP; i++) {
    const out = await withTenantDb(TENANT_A, () =>
      brokerLlmCall(USER_ID, { model: 'm', prompt: `a${i}` }),
    );
    expect(out.ok).toBe(true);
  }
  const overA = await withTenantDb(TENANT_A, () =>
    brokerLlmCall(USER_ID, { model: 'm', prompt: 'a-over' }),
  );
  expect(overA.ok).toBe(false);
  if (!overA.ok) expect(overA.kind).toBe('llm_capped');
  expect(fp.calls()).toBe(DAILY_CAP); // rejected BEFORE the provider, so no spend

  // ── THE LOAD-BEARING PART ──────────────────────────────────────────────────────────────────
  // Now scope-switch to tenant B. Pre-0059 these calls were UNCAPPED: the INSERT conflicted
  // invisibly on A's narrow-key row, the SELECT returned nothing, and the `?? { llm_calls: 0 }`
  // fallback handed the broker a zero counter for the rest of the UTC day.
  for (let i = 0; i < DAILY_CAP; i++) {
    const out = await withTenantDb(TENANT_B, () =>
      brokerLlmCall(USER_ID, { model: 'm', prompt: `b${i}` }),
    );
    expect(out.ok, `call ${i} under tenant B should succeed on B's own fresh counter`).toBe(true);
  }
  const overB = await withTenantDb(TENANT_B, () =>
    brokerLlmCall(USER_ID, { model: 'm', prompt: 'b-over' }),
  );
  expect(
    overB.ok,
    'the daily cap MUST fire under the scope-switched tenant too — this is exactly the bypass ' +
      '0059 exists to close. Pre-0059 this call succeeded, and so did every call after it.',
  ).toBe(false);
  if (!overB.ok) expect(overB.kind).toBe('llm_capped');
  expect(fp.calls()).toBe(DAILY_CAP * 2);

  // Two rows, one per tenant — a state the narrow constraint made UNREPRESENTABLE.
  const rows = await countersToday();
  expect(rows.length, `expected one counter row per tenant, got: ${JSON.stringify(rows)}`).toBe(2);
  const byTenant = new Map(rows.map((r) => [r.tenant_id, r.llm_calls]));
  expect(byTenant.get(TENANT_A)).toBe(DAILY_CAP);
  // …and B's traffic did not clobber, reset, or decrement A's ledger.
  expect(byTenant.get(TENANT_B)).toBe(DAILY_CAP);
});

test('the cap survives a scope-switch UNDER cp_app — the production failure mode', async () => {
  // ⛔ THIS IS THE CASE THAT REPRODUCES THE ACTUAL PRODUCTION BYPASS, and the one above does not.
  //
  // The case above runs as the table OWNER (`rolbypassrls = true`), where RLS is inert. Against
  // the PRE-0059 broker it therefore fails in the WRONG DIRECTION: the un-predicated
  // `SELECT … WHERE user_id AND day` finds tenant A's row, so tenant B's first call is wrongly
  // CAPPED. Prod runs as `cp_app` (NOBYPASSRLS), where the `usage_counters_tenant` policy HIDES
  // A's row instead — the SELECT returns nothing, the `?? { llm_calls: 0 }` fallback supplies a
  // zero counter, and B's calls are wrongly UNCAPPED. Same defect, opposite symptom, and only the
  // second one is what shipped. A test that never SET ROLEs cannot tell the two apart.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: DAILY_CAP, weeklySpendUsd: 1000 }),
  });

  for (let i = 0; i < DAILY_CAP; i++) {
    const out = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
      brokerLlmCall(USER_ID, { model: 'm', prompt: `rr-a${i}` }),
    );
    expect(out.ok).toBe(true);
  }

  // Scope-switch. Under cp_app + the pre-0059 narrow key this is where the cap silently died.
  for (let i = 0; i < DAILY_CAP; i++) {
    const out = await withTenantDbAsRuntimeRoleForTests(TENANT_B, () =>
      brokerLlmCall(USER_ID, { model: 'm', prompt: `rr-b${i}` }),
    );
    expect(out.ok).toBe(true);
  }
  const overB = await withTenantDbAsRuntimeRoleForTests(TENANT_B, () =>
    brokerLlmCall(USER_ID, { model: 'm', prompt: 'rr-b-over' }),
  );
  expect(
    overB.ok,
    'under cp_app the scope-switched tenant MUST still hit its own daily cap. Pre-0059 this ' +
      'returned ok:true and kept doing so for the rest of the UTC day — the live bypass.',
  ).toBe(false);
  if (!overB.ok) expect(overB.kind).toBe('llm_capped');
  // The provider was called exactly the cap, twice — never once more.
  expect(fp.calls()).toBe(DAILY_CAP * 2);
});

test('the untargeted ON CONFLICT still de-duplicates — negative control for the arbiter', async () => {
  // ⛔ THE FAILURE THIS CATCHES IS THE ONE 0059's `DO $$` GUARD EXISTS TO PREVENT, observed from
  // the other side. After the DROP, the broker's INSERT is an UNTARGETED `ON CONFLICT DO NOTHING`,
  // which arbitrates over whatever unique constraints happen to exist. If the wide key were
  // missing, partial or invalid, that INSERT would stop de-duplicating and simply APPEND a row per
  // call: the day's counter would never accumulate past 1 and the cap would be disabled a NEW way,
  // silently, with no error anywhere. So: row count must stay pinned at 1 while llm_calls climbs.
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 1000 }),
  });

  for (let i = 0; i < 5; i++) {
    const out = await withTenantDb(TENANT_A, () =>
      brokerLlmCall(USER_ID, { model: 'm', prompt: `dedup${i}` }),
    );
    expect(out.ok).toBe(true);
  }

  const rows = await countersToday();
  expect(rows.length, `the arbiter stopped de-duplicating: ${JSON.stringify(rows)}`).toBe(1);
  expect(rows[0]!.llm_calls).toBe(5);
});

test('metering with NO tenant context fails CLOSED, and not as a governance verdict', async () => {
  const fp = fakeProvider();
  __setBrokerDepsForTests({
    provider: fp.provider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 1000 }),
  });

  // No withTenantDb/withTenantTx wrapper ⇒ no tenant in the ALS context. Post-0059 an unscoped
  // counter cannot enforce either limit, so the only defensible answer is to refuse the call.
  let threw: unknown;
  try {
    await brokerLlmCall(USER_ID, { model: 'm', prompt: 'unscoped' });
  } catch (err) {
    threw = err;
  }
  expect(threw, 'an unscoped metered call must throw, not proceed').toBeDefined();
  expect(fp.calls()).toBe(0); // never reached the provider

  // ⛔ ASSERT THE BROKER'S OWN MESSAGE, not merely "something threw". Without this the case passes
  // for an INCIDENTAL reason even against the pre-0059 broker: with no GUC, the `tenant_id` column
  // DEFAULT `app_current_tenant_uuid()` evaluates to NULL and the INSERT dies on the NOT NULL
  // constraint (0029) — also an Error, also not a BrokerRejection. That accident is not the
  // guarantee we want to pin; `requireMeteringTenant()` refusing BEFORE any statement runs is.
  expect(String((threw as Error).message)).toContain('[broker] refusing to meter');

  // ⛔ A plain Error, NOT a BrokerRejection. `BrokerRejectionKind` is a closed union mirrored in
  // db/trace-types.ts, the frontend trace types, BlockResultView.svelte and eight i18n catalogues;
  // reusing `llm_capped` for an internal wiring fault would write a FALSE governance verdict
  // ("you hit your quota") into the audit trail. Adding a new kind is a cross-repo release.
  expect(threw instanceof BrokerRejection).toBe(false);
  expect(threw instanceof Error).toBe(true);

  const rows = await countersToday();
  expect(rows.length, 'a refused call must not leave a counter row behind').toBe(0);
});
