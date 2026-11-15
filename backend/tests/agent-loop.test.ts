// tests/agent-loop.test.ts — THE headline: the stub agent loop end-to-end against
// the live :5433 DB. Proves the whole substrate path: backend tool (search_blocks)
// via the MCP host → frontend tool (add_node) emitted + the browser round-trip
// simulated by POST-equivalent resolveFrontendTool → final answer; the transcript
// persists to chat_messages; spend is metered via the broker; MCP calls are audited.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  users,
  flows,
  flowSnapshots,
  chatSessions,
  chatMessages,
  usageCounters,
  auditLog,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { emptyGraph } from '../src/db/flow-types';
import {
  runAgentChat,
  ensureChatSession,
  resolveFrontendTool,
  type AgentEvent,
} from '../src/ai/agent';
import { stubProvider } from '../src/ai/llm/stub-provider';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';

const USER_ID = '00000000-0000-0000-0000-0000000f0001';
let flowId = '';

async function cleanup() {
  const fids = (
    await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, USER_ID))
  ).map((f) => f.id);
  if (fids.length) {
    await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
  }
  await db.delete(chatSessions).where(eq(chatSessions.user_id, USER_ID)); // cascades messages
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  if (fids.length) await db.delete(flows).where(inArray(flows.id, fids));
  await db.delete(users).where(eq(users.id, USER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'loop@test', name: 'Loop' })
    .onConflictDoNothing({ target: users.id });
  const [flow] = await db
    .insert(flows)
    .values({ tenant_id: DEMO_TENANT_ID, name: 'Loop Flow', owner_id: USER_ID, graph: emptyGraph() })
    .returning();
  flowId = flow!.id;
  // Use the real stub provider + permissive limits (so the meter runs without
  // depending on the live allowlist policy).
  __setBrokerDepsForTests({
    chatProvider: stubProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
}, 30_000);
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

test('the stub loop drives search_blocks → add_node (browser round-trip) → final answer', async () => {
  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));

  const emit = (ev: AgentEvent) => {
    events.push(ev);
    // Simulate the browser fulfilling the frontend edit + POSTing the result.
    if (ev.type === 'frontend-tool-call') {
      // The 4th arg is the OWNER of the turn — resolveFrontendTool refuses a mismatch, so a
      // stranger holding a valid agent token cannot answer someone else's tool call.
      resolveFrontendTool(
        ev.turnId,
        ev.callId,
        { ok: true, output: { nodeId: 'n_browser', applied: true } },
        USER_ID,
      );
    }
  };

  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      sessionId,
      flowId,
      userMessage: 'add a summarize step',
      emit,
      signal: new AbortController().signal,
    }),
  );

  const types = events.map((e) => e.type);
  // backend tool call + its result
  expect(events.some((e) => e.type === 'tool-call' && e.name === 'search_blocks')).toBe(true);
  expect(events.some((e) => e.type === 'tool-result' && e.name === 'search_blocks' && e.ok)).toBe(true);
  // frontend edit emitted + resolved
  expect(events.some((e) => e.type === 'frontend-tool-call' && e.name === 'add_node')).toBe(true);
  expect(events.some((e) => e.type === 'tool-result' && e.name === 'add_node' && e.ok)).toBe(true);
  // a final assistant answer + a clean end
  expect(events.some((e) => e.type === 'assistant-message')).toBe(true);
  expect(types[types.length - 1]).toBe('turn-end');
  const end = events.find(
    (e): e is Extract<AgentEvent, { type: 'turn-end' }> => e.type === 'turn-end',
  );
  expect(end?.status).toBe('done');

  // transcript persisted: user, assistant(search), tool, assistant(add), tool, assistant(final)
  const msgs = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId));
  expect(msgs.length).toBe(6);
  expect(msgs.filter((m) => m.role === 'tool').length).toBe(2);

  // Metered through the broker (3 provider turns), at the NOTIONAL flat rate.
  //
  // ⚠ THIS ASSERTION HAS NOW BEEN WRONG IN BOTH DIRECTIONS, so read the history before flipping
  // it a third time. It began as `spend_usd > 0` (the pre-0053 flat rate billed the free,
  // self-hosted `local-llm` at Claude-Sonnet rates — phantom spend that counted against
  // `spend.weekly_spend_ceiling` and could refuse service). 0053/#157 made it `toBe(0)`. That
  // over-corrected: the agent runs on `config.agent.model` = `local-llm` and so does everything
  // else here, so pricing local at exactly zero meant EVERY row this deployment ever wrote cost
  // $0.00 — the cost screens showed nothing, the two `LLM_*_RATE_USD` knobs were unreachable, and
  // the weekly ceiling evaluated `0 + 0 > 15` on every call while /governance called it enabled.
  //
  // Local inference is now priced notionally at the flat tier (ai/llm/pricing.ts): the marginal
  // cost of owned hardware is still ~$0, but an internal chargeback estimate is what makes the
  // cost screens and the ceiling testable at all. `price_source='flat'` is what keeps it honest —
  // every screen must go on calling this figure an estimate.
  const [counter] = await db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.user_id, USER_ID));
  expect(counter!.llm_calls).toBe(3);
  expect(Number(counter!.spend_usd)).toBeGreaterThan(0);

  // Every turn is LEDGERED and every turn costs something.
  const priced = (await db.execute(
    sql`SELECT model, cost_usd, price_source FROM usage_events WHERE user_id = ${USER_ID}`,
  )) as unknown as { model: string; cost_usd: string; price_source: string }[];
  expect(priced.length).toBe(3);
  expect(priced.every((r) => r.model === 'local-llm')).toBe(true);
  expect(priced.every((r) => Number(r.cost_usd) > 0)).toBe(true);
  // ⛔ 'flat', not 'table'. Both of #157's zeros are gone — the `ZERO_COST_MODELS` hardcode and
  // the catalog's `local/*` wildcard — so neither route to the price table resolves and the
  // estimate is labelled as one.
  expect(priced.every((r) => r.price_source === 'flat')).toBe(true);
  // The counter and the ledger must agree to the cent. `> 0` on its own would survive the broker
  // metering some other number entirely; this ties the two records together, which is the
  // invariant that actually matters and the one an exact-dollar literal would not express.
  const ledgerTotal = priced.reduce((sum, r) => sum + Number(r.cost_usd), 0);
  expect(Number(counter!.spend_usd)).toBeCloseTo(ledgerTotal, 6);

  // the backend MCP tool call was audited
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.actor_id, USER_ID));
  expect(audits.some((a) => a.action === 'mcp.tool_call' && a.target_id === 'search_blocks')).toBe(true);
});

test('the final answer streams as assistant-delta chunks before the assistant-message + turn-end', async () => {
  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));
  const emit = (ev: AgentEvent) => {
    events.push(ev);
    if (ev.type === 'frontend-tool-call') {
      resolveFrontendTool(ev.turnId, ev.callId, { ok: true, output: { applied: true } }, USER_ID);
    }
  };

  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      sessionId,
      flowId,
      userMessage: 'add a summarize step',
      emit,
      signal: new AbortController().signal,
    }),
  );

  // The stub streams the final answer in ≥2 text chunks.
  const deltas = events.filter((e) => e.type === 'assistant-delta');
  expect(deltas.length).toBeGreaterThanOrEqual(2);
  const streamed = deltas.map((e) => (e as Extract<AgentEvent, { type: 'assistant-delta' }>).text).join('');
  expect(streamed.length).toBeGreaterThan(0);

  // Ordering: first delta → sanitized assistant-message → turn-end.
  const firstDelta = events.findIndex((e) => e.type === 'assistant-delta');
  const finalMsg = events.findIndex((e) => e.type === 'assistant-message');
  const end = events.findIndex((e) => e.type === 'turn-end');
  expect(firstDelta).toBeGreaterThanOrEqual(0);
  expect(finalMsg).toBeGreaterThan(firstDelta);
  expect(end).toBeGreaterThan(finalMsg);

  // The clean assistant-message text equals the streamed text (stub emits no
  // reasoning tokens, so the sanitized final equals the concatenated deltas).
  const finalText = (events[finalMsg] as Extract<AgentEvent, { type: 'assistant-message' }>).text;
  expect(finalText).toBe(streamed);
});

test('a frontend tool-result from a DIFFERENT user is refused', () => {
  // Any valid agent token used to be able to resolve any pending (turnId, callId) — injecting
  // arbitrary tool output into another user's in-flight turn. Ownership is now checked.
  const other = '00000000-0000-4000-8000-00000000beef';
  expect(resolveFrontendTool('turn-x', 'call-x', { ok: true }, other)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ A GOVERNANCE REFUSAL MUST REACH THE BROWSER AS A `kind`, NOT ONLY AS ENGLISH PROSE.
//
// `brokerChatStream` rejects a capped/disallowed call by THROWING `BrokerRejection` before any
// token streams, carrying a closed 3-member `kind` alongside a hardcoded English sentence. The
// catch in `runAgentChat` used to read `err.message` and drop `.kind` on the floor, so the chat
// panel had nothing to key localized copy on and rendered the English raw — while the RUN path,
// given the identical rejection, rendered catalog copy off the kind (RunConsole.svelte).
//
// REVERT THAT TURNS THESE RED: delete `...(kind ? { kind } : {})` from the `turn-end` emit in
// src/ai/agent.ts. `message` still arrives, so ONLY the `kind` assertions invert — which is the
// point: the English was never the missing half.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Run one turn under the given governance limits and hand back the `turn-end` frame. */
async function endFrameUnderLimits(limits: {
  dailyLlmCap: number;
  weeklySpendUsd: number;
  allowlistedModels?: string[];
}) {
  __setBrokerDepsForTests({ chatProvider: stubProvider, limits: () => limits });
  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));
  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      sessionId,
      flowId,
      userMessage: 'add a summarize step',
      emit: (ev) => events.push(ev),
      signal: new AbortController().signal,
    }),
  );
  const end = events.find(
    (e): e is Extract<AgentEvent, { type: 'turn-end' }> => e.type === 'turn-end',
  );
  // ⛔ POSITIVE MARKER. "the frame has no wrong kind" is satisfied by a turn that never ended at
  // all; and a turn that ended `done` would mean the cap never fired and this asserts nothing.
  expect(end, 'the turn never emitted turn-end').toBeDefined();
  expect(end!.status, 'the broker did not refuse — this case tests nothing').toBe('error');
  return end!;
}

test('a daily-cap refusal reaches the browser as kind=llm_capped, not only as English', async () => {
  const end = await endFrameUnderLimits({ dailyLlmCap: 0, weeklySpendUsd: 100 });
  expect(end.kind).toBe('llm_capped');
  // The English is still there — it is the mid-rolling-deploy fallback for a browser that has
  // never heard of `kind`, and the only detail for a kind the SPA cannot map.
  expect(end.message).toContain('daily LLM call cap reached');
});

test('an allowlist refusal reaches the browser as kind=model_not_allowed', async () => {
  // A SECOND kind, so "the field is hardcoded to one value" cannot pass this file.
  const end = await endFrameUnderLimits({
    dailyLlmCap: 100,
    weeklySpendUsd: 100,
    allowlistedModels: ['some-other-model'],
  });
  expect(end.kind).toBe('model_not_allowed');
  expect(end.message).toContain('not allowlisted');
});

test('a provider credit failure reaches the browser as kind=budget_exhausted, not as the raw 402', async () => {
  // ⛔ THE THIRD MEMBER OF THE UNION, AND THE ONE THAT WAS DEAD ON THIS SURFACE. `isCreditExhaustion`
  // had a single call site — `runMetered`, the NON-streaming path — so `brokerChatStream` let the
  // provider's own error propagate. MEASURED before the fix, on the chat path:
  //     {"type":"turn-end","status":"error",
  //      "message":"openrouter 402: insufficient credit for this request"}
  // No `kind`. A Dutch reader got a raw provider string — WORSE than the English paragraph the
  // localization work replaced, and it made `case 'budget_exhausted'` in the store's copy map dead
  // code while the union claimed all three kinds were reachable.
  //
  // REVERT THAT TURNS THIS RED: delete the `isCreditExhaustion(err)` branch from
  // `brokerChatStream`'s catch (llm-broker.ts).
  const { LlmProviderHttpError } = await import('../src/ai/llm/adapters/openai');
  __setBrokerDepsForTests({
    chatProvider: {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new LlmProviderHttpError(402, 'insufficient credit for this request', 'openrouter');
      },
    } as never,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));
  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      sessionId,
      flowId,
      userMessage: 'add a summarize step',
      emit: (ev) => events.push(ev),
      signal: new AbortController().signal,
    }),
  );
  const end = events.find(
    (e): e is Extract<AgentEvent, { type: 'turn-end' }> => e.type === 'turn-end',
  );
  expect(end, 'the turn never emitted turn-end').toBeDefined();
  expect(end!.status).toBe('error');
  // THE FIX: the localizable half arrives.
  expect(end!.kind).toBe('budget_exhausted');
  // THE MEASURED DEFECT: the provider's wire string must not be what the reader sees.
  expect(end!.message).not.toContain('402');
  expect(end!.message).not.toContain('insufficient credit');
  // The fallback prose is the actionable sentence the run path has always used.
  expect(end!.message).toContain('LLM settings');
});

test('a NON-broker error end carries no kind at all', async () => {
  // ⛔ THE COMPLEMENT. `kind` must be absent — not an empty string, not 'internal' — whenever the
  // turn did not end on a governance refusal, because the browser's `kind ?? message` fallback is
  // what keeps a provider outage readable. A field that is always present would silence it.
  __setBrokerDepsForTests({
    chatProvider: {
      chat: () => {
        throw new Error('upstream connect error');
      },
    } as never,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));
  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      sessionId,
      flowId,
      userMessage: 'add a summarize step',
      emit: (ev) => events.push(ev),
      signal: new AbortController().signal,
    }),
  );
  const end = events.find(
    (e): e is Extract<AgentEvent, { type: 'turn-end' }> => e.type === 'turn-end',
  );
  expect(end, 'the turn never emitted turn-end').toBeDefined();
  expect(end!.status).toBe('error');
  expect(end!.message).toContain('upstream connect error');
  expect('kind' in end!, 'a non-refusal error carries a governance kind it never had').toBe(false);
});
