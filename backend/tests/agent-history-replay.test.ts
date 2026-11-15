// tests/agent-history-replay.test.ts — a stale answer in the transcript must not be replayed.
//
// Prod, 2026-10-16 (tenant 01a1432b, flow "Samenvatting schadeformulier", Dutch UI): with #465 and
// #466 live, the nl context said "Claimformulier lezen", yet "Wat doet deze flow?" answered
// "Read claim form" / `claim_id`. chat_messages showed WHY: the answers at 07:59 and 08:29 had the
// SAME md5 as the 07:10 answer, written before #465. The permanent (user, flow) session replayed
// that answer as history and the model returned it verbatim.
//
// REVERT THAT TURNS THIS RED: drop the `replay === replayKey` filter in agent.ts loadHistory.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  flows,
  flowSnapshots,
  chatSessions,
  chatMessages,
  usageCounters,
  usageEvents,
  auditLog,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { emptyGraph } from '../src/db/flow-types';
import { runAgentChat, ensureChatSession, replayKeyFor } from '../src/ai/agent';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider, LlmRequest } from '../src/ai/llm/provider';

const USER_ID = '00000000-0000-0000-0000-0000000f2e01';
const STALE = 'Deze flow bestaat uit: 1. **Read claim form** – levert `text`. 2. **Extract fields** – `claim_id`.';
let flowId = '';
let sessionId = '';

async function cleanup() {
  const fids = (await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, USER_ID))).map((f) => f.id);
  if (fids.length) await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
  await db.delete(chatSessions).where(eq(chatSessions.user_id, USER_ID));
  await db.delete(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  if (fids.length) await db.delete(flows).where(inArray(flows.id, fids));
  await db.delete(users).where(eq(users.id, USER_ID));
}

beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db.insert(users).values({ id: USER_ID, email: 'replay@test', name: 'Replay' }).onConflictDoNothing({ target: users.id });
  const [flow] = await db
    .insert(flows)
    .values({ tenant_id: DEMO_TENANT_ID, name: 'Samenvatting schadeformulier', owner_id: USER_ID, graph: emptyGraph() })
    .returning();
  flowId = flow!.id;
  sessionId = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_ID, flowId));
}, 30_000);
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

async function seedTurn(answer: string, replay?: string) {
  const extra = replay ? { replay } : {};
  await db.insert(chatMessages).values([
    { session_id: sessionId, role: 'user', content: { blocks: [{ type: 'text', text: 'Wat doet deze flow?' }], ...extra } },
    { session_id: sessionId, role: 'assistant', content: { blocks: [{ type: 'text', text: answer }], ...extra } },
  ]);
}

async function promptsFor(locale: string): Promise<LlmRequest> {
  const seen: LlmRequest[] = [];
  __setBrokerDepsForTests({
    chatProvider: { chat: async (req: LlmRequest) => (seen.push(req), { text: 'ok', usage: { tokensIn: 5, tokensOut: 1 } }) } as LlmProvider,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  await withTenantDb(DEMO_TENANT_ID, () =>
    runAgentChat({
      userId: USER_ID,
      tenantId: DEMO_TENANT_ID,
      sessionId,
      flowId,
      locale,
      userMessage: 'Wat doet deze flow?',
      emit: () => {},
      signal: new AbortController().signal,
    }),
  );
  return seen[0]!;
}

const sent = (req: LlmRequest) => req.messages.map((m) => m.content).join('\n');

test('⛔ an answer written before the current context format (no replay key) is not replayed', async () => {
  await seedTurn(STALE);
  const req = await promptsFor('nl');
  expect(sent(req)).not.toContain('Read claim form');
  // Non-vacuity: the turn really ran, with the new question as the only history.
  expect(req.messages.filter((m) => m.role === 'user')).toHaveLength(1);
}, 30_000);

test('⛔ an answer written in another language is not replayed', async () => {
  await seedTurn(STALE, replayKeyFor('en'));
  const req = await promptsFor('nl');
  expect(sent(req)).not.toContain('Read claim form');
}, 30_000);

test('a turn in the same language and context format IS replayed (multi-turn continuity)', async () => {
  await seedTurn('Eerder antwoord: Claimformulier lezen.', replayKeyFor('nl'));
  const req = await promptsFor('nl');
  expect(sent(req)).toContain('Eerder antwoord: Claimformulier lezen.');
  expect(req.messages.filter((m) => m.role === 'user')).toHaveLength(2);
}, 30_000);
