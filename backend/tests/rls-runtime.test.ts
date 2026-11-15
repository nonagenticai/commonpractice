// tests/rls-runtime.test.ts — Phase 4 / D.1.1: prove the previously-out-of-ALS code paths are
// RLS-correct under the non-owner runtime role.
//
// D.1 proved that a `cp_app`-connected session is scoped by RLS (rls-isolation.test.ts). But several
// writes happen OUTSIDE a request's AsyncLocalStorage tenant context — the detached run pump/finalize
// (flow_runs), the metered LLM broker (usage_counters/usage_events), and the cross-tenant schedulers
// (the weekly cycle advancing every tenant's challenges). D.1.1 threaded those: per-tenant work runs
// under `withTenantDb(tenant)`, genuine cross-tenant work runs under `runAsSystem()` (owner pool).
// This test exercises those mechanisms and asserts, AS the cp_app role, that the rows land under the
// right tenant — so a regression that forgets the GUC (a NULL/invisible row) fails the build.
import { cyclePeriodCols } from './helpers/cycle-period';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  db,
  withTenantDb,
  runAsSystem,
  tenants,
  users,
  flows,
  flowRuns,
  usageCounters,
  usageEvents,
  challenges,
  solutions,
  weeklyWinners,
  marketplaceCycles,
  pipelineItems,
  chatSessions,
  sandboxes,
} from '../src/db/client';
import { brokerLlmCall, __setBrokerDepsForTests, type Provider } from '../src/host/llm-broker';
import { closeCycle } from '../src/host/cycle-service';
import { ensureChatSession } from '../src/ai/agent';
import { sweepIdleSandboxes } from '../src/host/sandbox-service';

const A = '00000000-0000-0000-0000-00000d310001';
const B = '00000000-0000-0000-0000-00000d310002';
const USER_A = '00000000-0000-0000-0000-00000d31a001';
const USER_B = '00000000-0000-0000-0000-00000d31b001';
const FLOW_A = '00000000-0000-0000-0000-00000d31f001';
const RUN_A = '00000000-0000-0000-0000-00000d31e001';
const WEEK = '2099-W01'; // a fixed, never-current week so the cross-tenant cycle test is isolated
const EMPTY_GRAPH = { nodes: [], edges: [] } as never;

/** An ordinary connection that has become `cp_app` via SET ROLE (see rls-isolation.test.ts for the
 *  full rationale). Previously this CONNECTED as cp_app, which required
 *  `ALTER ROLE cp_app WITH LOGIN PASSWORD 'cp_app_dev'` in beforeAll — a cluster-global statement
 *  whose afterAll only restored NOLOGIN and never cleared the password, so every `bun test` left a
 *  hardcoded password on the role whose whole job is enforcing RLS. `max: 1` because SET ROLE is
 *  per-session and a second pooled connection would silently run as the owner (RLS bypassed). */
function cpAppSql() {
  return postgres(process.env.DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { options: '-c role=cp_app' },
  });
}

let app: ReturnType<typeof postgres>;

const fakeProvider: Provider = async (req) => ({
  text: `echo:${req.prompt}`,
  tokensIn: 7,
  tokensOut: 3,
});

async function cleanup() {
  // Order: dependents before parents. pipeline_items.solution_id is ON DELETE SET NULL.
  await db.delete(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  await db.delete(pipelineItems).where(eq(pipelineItems.week, WEEK));
  await db.delete(marketplaceCycles).where(eq(marketplaceCycles.week, WEEK));
  await db.delete(solutions).where(eq(solutions.week, WEEK));
  await db.delete(challenges).where(eq(challenges.week, WEEK));
  await db.delete(flowRuns).where(eq(flowRuns.id, RUN_A));
  await db.delete(chatSessions).where(inArray(chatSessions.user_id, [USER_A, USER_B]));
  await db.delete(sandboxes).where(inArray(sandboxes.owner_id, [USER_A, USER_B]));
  await db.delete(flows).where(eq(flows.id, FLOW_A));
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, [USER_A, USER_B]));
  await db.delete(usageEvents).where(inArray(usageEvents.user_id, [USER_A, USER_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  // cp_app stays as migration 0028 created it — NOLOGIN, no password. See cpAppSql().
  await cleanup();
  await db.insert(tenants).values([
    { id: A, name: 'RT Tenant A', slug: 'rls-rt-a' },
    { id: B, name: 'RT Tenant B', slug: 'rls-rt-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'rt-a@test', name: 'RT A', tenant_id: A },
    { id: USER_B, email: 'rt-b@test', name: 'RT B', tenant_id: B },
  ]);
  app = cpAppSql();
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await app?.end({ timeout: 5 });
  await cleanup();
}, 30_000);

async function setTenant(t: string | null) {
  await app.unsafe("select set_config('app.current_tenant', $1, false)", [t ?? '']);
}

// 1. The run pump/finalize mechanism: a flow_runs INSERT + UPDATE done under withTenantDb(A) (exactly
//    what the detached spawnAndPump+finalize now do) must stamp tenant A and be visible ONLY under A.
test('withTenantDb stamps + scopes a flow_runs write (the finalize path)', async () => {
  await withTenantDb(A, async () => {
    await db.insert(flows).values({ id: FLOW_A, name: 'rt flow', owner_id: USER_A, graph: EMPTY_GRAPH });
    await db.insert(flowRuns).values({ id: RUN_A, flow_id: FLOW_A, triggered_by: USER_A, status: 'running' });
    await db.update(flowRuns).set({ status: 'ok', finished_at: new Date() }).where(eq(flowRuns.id, RUN_A));
  });

  // Owner: the GUC default stamped tenant A (not NULL, not B).
  const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, RUN_A));
  expect(row!.tenant_id).toBe(A);
  expect(row!.status).toBe('ok');

  // cp_app: the row is visible under A's GUC, invisible under B's (a forgotten GUC → 0 rows).
  await setTenant(A);
  expect((await app`SELECT id FROM flow_runs WHERE id = ${RUN_A}`).length).toBe(1);
  await setTenant(B);
  expect((await app`SELECT id FROM flow_runs WHERE id = ${RUN_A}`).length).toBe(0);
});

// 2. The broker metering mechanism: a brokered call under withTenantDb(A) must meter usage_counters
//    (GUC-defaulted) + usage_events (user-tenant subquery) under tenant A and be cp_app-visible there.
test('the metered broker writes usage under the active tenant', async () => {
  __setBrokerDepsForTests({
    provider: fakeProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const out = await withTenantDb(A, () => brokerLlmCall(USER_A, { model: 'm', prompt: 'hi' }));
  expect(out.ok).toBe(true);

  const [counter] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.user_id, USER_A), eq(usageCounters.day, sql`current_date`)));
  expect(counter!.tenant_id).toBe(A);

  // cp_app: the per-call ledger row is visible under A, invisible under B.
  await setTenant(A);
  expect((await app`SELECT id FROM usage_events WHERE user_id = ${USER_A}`).length).toBeGreaterThan(0);
  await setTenant(B);
  expect((await app`SELECT id FROM usage_events WHERE user_id = ${USER_A}`).length).toBe(0);
});

// 2b. The agent-chat mechanism: /api/agent/chat authenticates with an agent token (not a Keycloak
//     JWT), so the server's per-request withTenantDb resolves to null and sets NO tenant GUC. The
//     route must establish the tenant context itself; ensureChatSession's INSERT leaves tenant_id to
//     its app_current_tenant_uuid() default, so without a GUC it lands NULL and RLS rejects it (42501,
//     the builder-chat 500). Under withTenantDb(A) it must stamp A and be cp_app-visible only under A.
test('ensureChatSession under withTenantDb stamps + scopes the chat_sessions write (agent-chat path)', async () => {
  const sessionId = await withTenantDb(A, () => ensureChatSession(USER_A, null));

  // Owner: the GUC default stamped tenant A (not NULL) — the bug left this NULL → RLS 42501.
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  expect(row!.tenant_id).toBe(A);

  // cp_app: visible under A's GUC, invisible under B's (a forgotten GUC → 0 rows).
  await setTenant(A);
  expect((await app`SELECT id FROM chat_sessions WHERE id = ${sessionId}`).length).toBe(1);
  await setTenant(B);
  expect((await app`SELECT id FROM chat_sessions WHERE id = ${sessionId}`).length).toBe(0);
});

// 2c. The sandbox idle-sweep watchdog: a detached setInterval (no request → no tenant GUC) sweeps
//     idle sandboxes across ALL tenants. Under cp_app with no GUC the UPDATE on the RLS-scoped
//     `sandboxes` table matches 0 rows (silent no-op — the bug). Run as SYSTEM it reaches every
//     tenant. Insert idle sandboxes for A and B with a stale last_active_at; assert runAsSystem
//     suspends BOTH (a single per-request tenant GUC could only touch one).
test('runAsSystem lets the idle-sweep watchdog suspend sandboxes across tenants', async () => {
  const stale = new Date('2000-01-01T00:00:00Z');
  await withTenantDb(A, () =>
    db.insert(sandboxes).values({ owner_id: USER_A, slug: 'rt-sb-a', status: 'idle', last_active_at: stale }),
  );
  await withTenantDb(B, () =>
    db.insert(sandboxes).values({ owner_id: USER_B, slug: 'rt-sb-b', status: 'idle', last_active_at: stale }),
  );

  const suspended = await runAsSystem('scheduler-tick', () => sweepIdleSandboxes(db, new Date()));
  // Cross-tenant reach: both tenants' idle sandboxes were swept (the bug returned []).
  const swept = await db
    .select({ slug: sandboxes.slug, status: sandboxes.status })
    .from(sandboxes)
    .where(inArray(sandboxes.owner_id, [USER_A, USER_B]));
  expect(suspended.length).toBe(2);
  expect(swept.every((s) => s.status === 'suspended')).toBe(true);
});

// 3. The runAsSystem mechanism: closing a weekly cycle advances challenges across EVERY tenant — a
//    single per-request tenant GUC could only touch one. Under runAsSystem (owner) both A and B close,
//    and the winner's tenant_id is carried onto weekly_winners (no NULL under the GUC-less system path).
test('runAsSystem lets the cycle engine reach across tenants', async () => {
  const past = new Date('2099-01-01T00:00:00Z');
  // 0110: one cycle row PER TENANT — each tenant runs its own race.
  await db.insert(marketplaceCycles).values(
    [A, B].map((tenant_id) => ({
      tenant_id,
      ...cyclePeriodCols(WEEK),
      phase: 'solution_phase' as const,
      voting_ends_at: past,
      solution_ends_at: past,
      closes_at: past,
    })),
  );
  await db.insert(challenges).values([
    { title: 'RT A challenge', work_area: 'ops', submitter_id: USER_A, tenant_id: A, week: WEEK, status: 'solution_phase' },
    { title: 'RT B challenge', work_area: 'ops', submitter_id: USER_B, tenant_id: B, week: WEEK, status: 'solution_phase' },
  ]);
  const chs = await db.select({ id: challenges.id, tenant_id: challenges.tenant_id }).from(challenges).where(eq(challenges.week, WEEK));
  const chA = chs.find((c) => c.tenant_id === A)!.id;
  const chB = chs.find((c) => c.tenant_id === B)!.id;
  await db.insert(solutions).values([
    { challenge_id: chA, tenant_id: A, title: 'RT A solution', author_id: USER_A, week: WEEK, status: 'voting', votes_count: 5 },
    { challenge_id: chB, tenant_id: B, title: 'RT B solution', author_id: USER_B, week: WEEK, status: 'voting', votes_count: 9 },
  ]);

  // The engine closes each tenant's row under runAsSystem (no GUC) — the reach is still cross-tenant.
  for (const t of [A, B]) {
    const result = await runAsSystem('scheduler-tick', () => closeCycle(WEEK, t));
    expect(result.closed).toBe(true);
  }

  // ⛔ CROSS-TENANT REACH IS NOW PROVEN BY THE WINNERS, NOT BY A CHALLENGE SWEEP.
  // This used to assert that BOTH tenants' challenges came back `closed`, because `closeCycle`
  // swept every challenge in the week. That sweep was deleted: closing a weekly competition is not
  // a statement that the work is finished, and a challenge can wait months for a solver. The
  // engine's cross-tenant reach — the actual subject of this test — is unchanged and is asserted
  // below: ONE winner per tenant, each with its own tenant_id and its OWN stats, which the engine
  // can only produce by reading both tenants' solutions under `runAsSystem` with no GUC set. That
  // is a strictly stronger proof than the sweep was, because it requires reading AND writing
  // per-tenant rows correctly rather than blanket-updating every row in a week.
  const after = await db.select({ status: challenges.status }).from(challenges).where(eq(challenges.week, WEEK));
  expect(after.length).toBe(2);
  expect(after.every((c) => c.status !== 'closed')).toBe(true);

  // ONE winner PER TENANT (weekly_winners is per-tenant since 0041), each carrying its own
  // tenant_id (not NULL — the system path has no GUC to default from) and its OWN stats. Under the
  // old global top-1 close, B (9 votes) was the single platform winner, A's page stayed blank, and
  // B's stats row read 2 solutions / 14 votes — A's numbers written into a row B can read.
  const winners = await db.select().from(weeklyWinners).where(eq(weeklyWinners.week, WEEK));
  expect(winners).toHaveLength(2);
  const byTenant = new Map(winners.map((w) => [w.tenant_id, w]));
  expect(byTenant.get(A)?.stats).toEqual({ solutionsSubmitted: 1, totalVotesCast: 5 });
  expect(byTenant.get(B)?.stats).toEqual({ solutionsSubmitted: 1, totalVotesCast: 9 });
}, 30_000);
