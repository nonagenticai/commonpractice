// tests/agent-pool-budget.test.ts — the request-pool budget of an AI-panel turn.
//
// An agent turn used to run entirely inside `withTenantDb`: routes/agent.ts re-established the
// tenant context for the detached turn with the RESERVING wrapper, so one of only
// `config.database.poolMax` (6) request connections was pinned for the turn's WHOLE duration —
// up to MAX_ITERATIONS provider round-trips plus a 30s browser round-trip per frontend tool call.
// Six people with the AI panel open therefore held the entire request pool, and postgres-js
// `reserve()` queues on an unbounded promise with NO timeout: every other authenticated request
// on the pod hung until restart, invisibly (the liveness probe hits the unauthenticated /health).
//
// The fix is `runAgentChatScoped` = `withTenantTx` (reserves NOTHING) with narrow `withTenantDb`
// wrappers around only the short plain-statement regions.
//
// WHAT IS MEASURED, AND WHY IT IS NOT "reserves". The fix deliberately reserves MORE OFTEN — the
// prologue, each persistMessage, each backend tool call now take their own short reservation — so
// counting `reserve()` calls would score the fix as a regression. The defect was never the number
// of reservations, it was holding one ACROSS AN AWAIT that is not a database await. So this file
// instruments PEAK CONCURRENT holders and, decisively, asserts that while every turn is parked
// mid-provider-stream the count of held request connections is ZERO.
//
// CONCURRENCY is exactly `poolMax`, deliberately not `poolMax + 1`: with more turns than slots the
// surplus would block inside `reserve()` and never reach the provider, the barrier would never
// resolve, and the pre-fix failure would be an unreadable 60s timeout instead of an assertion.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  chatSessions,
  chatMessages,
  usageCounters,
  auditLog,
  queryClient,
  withTenantDb,
} from '../src/db/client';
import { config, DEMO_TENANT_ID } from '../src/config';
import { runAgentChatScoped, ensureChatSession, type AgentEvent } from '../src/ai/agent';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider, LlmStreamChunk } from '../src/ai/llm/provider';

// ⛔ Fixture ids that this file DELETEs must be unique to it — bun runs test files
// concurrently against one database, so a shared owned id means one file tears down
// another's in-flight fixtures (see tests/fixture-id-collisions.test.ts).
const USER_ID = '00000000-0000-0000-0000-00000a9e0001';
const OTHER_TENANT = '00000000-0000-0000-0000-00000a9e0002';
const OTHER_USER = '00000000-0000-0000-0000-00000a9e0003';

/** Exactly the pool ceiling — read from config, never hardcoded (see the header note). */
const CONCURRENCY = config.database.poolMax;

// ---- request-pool instrumentation ----------------------------------------------------------
/** Request connections held RIGHT NOW (incremented when `reserve()` RESOLVES, not when queued). */
let held = 0;
/** High-water mark of `held` over the test. */
let peakHeld = 0;
/** Total reservations taken — reported for context only; it is NOT the invariant. */
let reserves = 0;
type Reserved = Awaited<ReturnType<typeof queryClient.reserve>>;
const originalReserve = queryClient.reserve.bind(queryClient);

// ---- the gated provider --------------------------------------------------------------------
/** Turns that have reached the provider stream and are parked there. */
let entered = 0;
/** Resolves once ALL CONCURRENCY turns are parked inside the provider. */
let barrier!: Promise<void>;
let trip!: () => void;
/** The turns stay parked until this is opened. */
let gate!: Promise<void>;
let openGate!: () => void;

function resetGates() {
  entered = 0;
  barrier = new Promise<void>((r) => {
    trip = r;
  });
  gate = new Promise<void>((r) => {
    openGate = r;
  });
}

/**
 * A provider that PARKS. `brokerChatStream` prefers `stream()` when present, and injecting
 * `chatProvider` makes it skip `resolveChatProvider` entirely — so no `tenant_llm_settings`
 * fixture is needed. `usage` MUST be on the `done` chunk or `settleSpend` never settles.
 * No `toolCalls` ⇒ the agent takes the final-answer path ⇒ exactly one iteration per turn.
 */
const parkingProvider: LlmProvider = {
  chat() {
    throw new Error('brokerChatStream must prefer stream()');
  },
  async *stream(): AsyncGenerator<LlmStreamChunk> {
    entered += 1;
    if (entered === CONCURRENCY) trip();
    await gate;
    yield { type: 'done', text: 'ok', usage: { tokensIn: 1, tokensOut: 1 } };
  },
};

async function cleanup() {
  const sids = (
    await db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.user_id, USER_ID))
  ).map((s) => s.id);
  if (sids.length) await db.delete(chatMessages).where(inArray(chatMessages.session_id, sids));
  await db.delete(chatSessions).where(eq(chatSessions.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(users).where(eq(users.id, OTHER_USER));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see agent-loop.test.ts).
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({
    id: USER_ID,
    email: 'agentpool@test',
    name: 'Agent Pool',
    tenant_id: DEMO_TENANT_ID,
  });
  // A SECOND, unrelated tenant: assertion (b) proves an ordinary authenticated request for a
  // different tenant still gets a connection while every AI panel is mid-turn.
  await db
    .insert(tenants)
    .values({ id: OTHER_TENANT, name: 'Agent Pool Bystander', slug: 'agent-pool-bystander' });
  await db.insert(users).values({
    id: OTHER_USER,
    email: 'agentpool-bystander@test',
    name: 'Bystander',
    tenant_id: OTHER_TENANT,
  });

  __setBrokerDepsForTests({
    chatProvider: parkingProvider,
    // Permissive, so the meter runs without depending on the live governance policy rows.
    limits: () => ({ dailyLlmCap: 1000, weeklySpendUsd: 1000 }),
  });

  (queryClient as { reserve: typeof originalReserve }).reserve = async () => {
    const reserved = (await originalReserve()) as Reserved;
    reserves += 1;
    held += 1;
    if (held > peakHeld) peakHeld = held;
    const release = (reserved.release as () => void).bind(reserved);
    let done = false;
    (reserved as unknown as { release: () => void }).release = () => {
      if (!done) {
        done = true;
        held -= 1;
      }
      release();
    };
    return reserved;
  };
}, 30_000);

afterAll(async () => {
  (queryClient as { reserve: typeof originalReserve }).reserve = originalReserve;
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

test('poolMax concurrent agent turns park in the provider holding ZERO request connections', async () => {
  resetGates();

  // One chat session per turn (flowId null ⇒ ensureChatSession always inserts a fresh one).
  const sessionIds: string[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    sessionIds.push(await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, null)));
  }

  // Measure only the turns, not the fixture setup above.
  expect(held).toBe(0);
  reserves = 0;
  peakHeld = 0;

  const events: AgentEvent[][] = sessionIds.map(() => []);
  const turns = sessionIds.map((sessionId, i) =>
    // The PRODUCTION envelope for a detached turn — routes/agent.ts calls exactly this. Not a
    // hand-mirrored copy, so the test cannot drift away from what the route actually does.
    runAgentChatScoped({
      userId: USER_ID,
      tenantId: DEMO_TENANT_ID,
      sessionId,
      flowId: null,
      userMessage: `budget probe ${i}`,
      emit: (ev) => events[i]!.push(ev),
      signal: new AbortController().signal,
    }),
  );

  await barrier;
  expect(entered).toBe(CONCURRENCY);

  // (a) THE INVARIANT. Every turn is parked mid-provider-stream — the slowest await in a turn.
  // Pre-fix this is `CONCURRENCY` (the whole request pool, pinned). Post-fix it is 0: the tenant
  // scope rides `withTenantTx`, and every reservation taken in the prologue was already released
  // before the first provider call.
  expect(held).toBe(0);
  // …and nothing over-subscribed the pool on the way here either.
  expect(peakHeld).toBeLessThanOrEqual(CONCURRENCY);

  // (b) LIVENESS, from the perspective of an unrelated tenant's ordinary authenticated request:
  // it must still get a request connection while all CONCURRENCY turns are in flight. Pre-fix
  // this `reserve()` queues behind a pool with zero free slots and NEVER settles.
  const bystander = await withTenantDb(OTHER_TENANT, () =>
    db.select({ id: users.id }).from(users).where(eq(users.tenant_id, OTHER_TENANT)).limit(1),
  );
  expect(bystander[0]?.id).toBe(OTHER_USER);
  expect(held).toBe(0); // …and it gave the connection straight back.

  // Let every turn finish.
  openGate();
  await Promise.all(turns);
  expect(held).toBe(0);

  for (const evs of events) {
    expect(evs[evs.length - 1]).toMatchObject({ type: 'turn-end', status: 'done' });
  }

  // (c) THE FIX'S OWN HAZARD. `withTenantTx` gives PLAIN (non-transaction) statements no
  // `app.current_tenant` GUC, so a region that lost its narrow `withTenantDb` would write/read
  // under an empty tenant — silently, as 0 rows or a wrong-tenant row. These assertions are what
  // makes "reserve less" safe rather than merely faster.
  //
  // Transcript: user + assistant per turn, on a session owned by the right tenant.
  const sessions = await db
    .select({ id: chatSessions.id, tenant_id: chatSessions.tenant_id })
    .from(chatSessions)
    .where(inArray(chatSessions.id, sessionIds));
  expect(sessions.length).toBe(CONCURRENCY);
  expect(sessions.every((s) => s.tenant_id === DEMO_TENANT_ID)).toBe(true);
  const msgs = await db
    .select({ session_id: chatMessages.session_id, role: chatMessages.role })
    .from(chatMessages)
    .where(inArray(chatMessages.session_id, sessionIds));
  expect(msgs.length).toBe(CONCURRENCY * 2);
  for (const sessionId of sessionIds) {
    const mine = msgs.filter((m) => m.session_id === sessionId).map((m) => m.role).sort();
    expect(mine).toEqual(['assistant', 'user']);
  }

  // Metering: the broker ran on the transaction pool under the ambient withTenantTx scope, so
  // every turn is ledgered against the right tenant.
  const counters = await db.select().from(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  expect(counters.length).toBe(1);
  expect(counters[0]!.tenant_id).toBe(DEMO_TENANT_ID);
  expect(counters[0]!.llm_calls).toBe(CONCURRENCY);
}, 60_000);
