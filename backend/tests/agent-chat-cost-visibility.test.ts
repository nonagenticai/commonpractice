// tests/agent-chat-cost-visibility.test.ts — the assistant's chat stream sends `event: cost` to
// tenant_admin+ only, proven by DRIVING a turn, not by reading the source.
//
// run-cost-visibility.test.ts pins `routes/agent.ts` with two source regexes. Those still match if
// the gate is defeated (`canSeeRunCostRoles(roles) || true` keeps both lines intact), so a member
// would see per-turn USD/token spend with a green suite. This file posts one real turn per role
// through POST /api/agent/chat with a stub provider and reads the SSE frames the browser gets.
// Mutation proven when written: `const showCost = canSeeRunCostRoles(roles) || true;` turns the
// member test red.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, users, chatSessions, agentSessions, usageCounters, auditLog, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { Router } from '../src/utils/router';
import { registerAgentRoutes } from '../src/routes/agent';
import { issueAgentSession } from '../src/services/agent-session';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider } from '../src/ai/llm/provider';

const MEMBER = '00000000-0000-0000-0000-00000000c0c1';
const ADMIN = '00000000-0000-0000-0000-00000000c0c2';
const BOTH = [MEMBER, ADMIN];

/** Answers at once with plain text and non-zero usage, so the turn reaches its `cost` emit. */
const stub: LlmProvider = {
  async chat() {
    return { text: 'ack', usage: { tokensIn: 12, tokensOut: 7 } };
  },
};

const router = new Router();
registerAgentRoutes(router);

/** POST /api/agent/chat and return the SSE event NAMES the browser receives, in order. */
async function eventNames(userId: string, roles: string[]): Promise<string[]> {
  const session = await withTenantDb(DEMO_TENANT_ID, () => issueAgentSession(userId, roles, DEMO_TENANT_ID));
  const matched = router.match('POST', '/api/agent/chat');
  if (!matched) throw new Error('no route for POST /api/agent/chat');
  const res = await matched.handler(
    new Request('http://localhost/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ message: 'Hello' }),
    }),
    ...matched.params,
  );
  expect(res.headers.get('content-type') ?? '').toStartWith('text/event-stream');
  const raw = await new Response(res.body).text();
  return raw
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7))
    .filter((n): n is string => !!n);
}

async function cleanup() {
  await db.delete(chatSessions).where(inArray(chatSessions.user_id, BOTH));
  await db.delete(agentSessions).where(inArray(agentSessions.user_id, BOTH));
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, BOTH));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, BOTH));
  await db.delete(users).where(inArray(users.id, BOTH));
}

beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: MEMBER, tenant_id: DEMO_TENANT_ID, email: 'cost-member@test', name: 'Cost Member' },
      { id: ADMIN, tenant_id: DEMO_TENANT_ID, email: 'cost-admin@test', name: 'Cost Admin' },
    ])
    .onConflictDoNothing({ target: users.id });
  __setBrokerDepsForTests({ chatProvider: stub, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

test('a member\'s chat turn completes WITHOUT an `event: cost` frame', async () => {
  const names = await eventNames(MEMBER, ['member']);
  // Non-vacuity: the turn really ran to its answer, so the absence below is a decision, not a crash.
  expect(names).toContain('assistant-message');
  expect(names).toContain('turn-end');
  expect(names).not.toContain('cost');
}, 30_000);

test('a tenant_admin\'s chat turn carries the `event: cost` frame', async () => {
  const names = await eventNames(ADMIN, ['tenant_admin']);
  expect(names).toContain('turn-end');
  expect(names).toContain('cost');
}, 30_000);
