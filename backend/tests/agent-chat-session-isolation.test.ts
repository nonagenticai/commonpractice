// tests/agent-chat-session-isolation.test.ts — TWO users, ONE flow.
//
// ⛔ WHY THIS FILE EXISTS SEPARATELY FROM agent-loop.test.ts. That file is the headline
// end-to-end proof of the substrate, and it drives the WHOLE loop with a single `USER_ID`
// against a single flow. A one-user fixture cannot express the only question that matters
// here — "whose transcript is this?" — so every assertion in it stayed green while
// `ensureChatSession` resolved a session by `flow_id` ALONE, with no `user_id` predicate,
// and while `POST /api/agent/chat` accepted any client-supplied `flowId` unchecked.
//
// THE STORY THIS WALKS, exactly as it is reachable in the product:
//   1. User A builds flow F with the copilot and submits it; the solution is published.
//   2. User B opens the solution → "Open in Build" → `GET /api/flows/F` serves A's graph
//      read-only to B (routes/flows.ts `getFlow`, the documented public-view branch), and
//      `frontend/src/routes/build/+page.svelte` renders the chat panel unconditionally —
//      the page has no read-only branch.
//   3. B types one message. The browser POSTs `{ message, flowId: F }`.
//
// TWO INDEPENDENT DOORS have to be shut, and each test below pins one of them, so that
// closing either one alone still leaves the other test RED:
//   * the ROUTE door — `/api/agent/chat` must not take a `flowId` on trust, the same way
//     every other flow-touching surface in this codebase refuses to (routes/flows.ts
//     `loadOwnedFlow`, ai/flow-edit-service.ts `loadOwnedFlow`, ai/mcp/tools.ts
//     `loadOwnedFlowGraph` — all three filter on `flows.owner_id`).
//   * the DATA door — `ensureChatSession` is documented "for (user, flow)" and must
//     actually key on both, so no future caller can reopen the leak from a different route.
//
// The leak was not a stale-read: `loadHistory` replays the resolved session's transcript
// into the provider request, so A's private conversation became B's LLM context, and B's
// turn was appended to A's thread permanently. Both halves are asserted below against
// what the provider ACTUALLY received, not against what the route returned.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  flows,
  flowSnapshots,
  chatSessions,
  chatMessages,
  agentSessions,
  usageCounters,
  auditLog,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { emptyGraph } from '../src/db/flow-types';
import { Router } from '../src/utils/router';
import { registerAgentRoutes } from '../src/routes/agent';
import { issueAgentSession } from '../src/services/agent-session';
import { runAgentChatScoped, ensureChatSession, type AgentEvent } from '../src/ai/agent';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmMessage, LlmProvider } from '../src/ai/llm/provider';

const USER_A = '00000000-0000-0000-0000-00000000c5aa';
const USER_B = '00000000-0000-0000-0000-00000000c5bb';
const BOTH = [USER_A, USER_B];

// Unique, greppable tokens. A leak is only provable if the marker cannot occur by accident
// anywhere else in the transcript, the system prompt, or a tool result.
const A_SECRET = 'acme-payroll-export-9f3c';
const B_SECRET = 'brava-invoice-parser-7d21';

let flowId = '';

/** Every `LlmRequest.messages` array the provider was handed, in order. This is the only
 *  honest place to observe "what context did the model actually get for this turn" — the
 *  SSE stream shows the answer, not the history that produced it. */
let seen: LlmMessage[][] = [];

/** A provider that records its input and answers immediately with plain text — NO tool
 *  calls, so a turn is exactly one provider round-trip with no 30s browser wait. The stub
 *  provider's three-step script would drag in the frontend-tool round-trip, which is
 *  agent-loop.test.ts's subject, not this file's. */
const recorder: LlmProvider = {
  async chat(req) {
    seen.push(req.messages.map((m) => ({ ...m })));
    return { text: 'ack', usage: { tokensIn: 1, tokensOut: 1 } };
  },
};

const router = new Router();
registerAgentRoutes(router);

interface TurnOutcome {
  status: number;
  events: AgentEvent[];
  json: { error?: string; message?: string } | null;
}

/** POST /api/agent/chat as `token` and drain the SSE stream to completion. The turn is
 *  DETACHED from the Response (see the long note in routes/agent.ts), so reading the body
 *  to EOF is what waits for it — `close()` runs in the `.finally` of the turn promise. */
async function chatTurn(token: string, body: Record<string, unknown>): Promise<TurnOutcome> {
  const matched = router.match('POST', '/api/agent/chat');
  if (!matched) throw new Error('no route for POST /api/agent/chat');
  const req = new Request('http://localhost/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const res = await matched.handler(req, ...matched.params);
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const text = await res.text();
    return { status: res.status, events: [], json: text ? JSON.parse(text) : null };
  }
  const raw = await new Response(res.body).text();
  const events: AgentEvent[] = [];
  for (const frame of raw.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    if (payload === '{}') continue; // the trailing `event: end`
    events.push(JSON.parse(payload) as AgentEvent);
  }
  return { status: res.status, events, json: null };
}

async function issueToken(userId: string): Promise<string> {
  const s = await withTenantDb(DEMO_TENANT_ID, () =>
    issueAgentSession(userId, ['employee'], DEMO_TENANT_ID),
  );
  return s.accessToken;
}

/** Every message body persisted under a session, flattened to one greppable string. */
async function transcriptOf(sessionId: string): Promise<string> {
  const rows = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId));
  return JSON.stringify(rows);
}

async function sessionsForFlow(): Promise<{ id: string; user_id: string }[]> {
  return db
    .select({ id: chatSessions.id, user_id: chatSessions.user_id })
    .from(chatSessions)
    .where(eq(chatSessions.flow_id, flowId));
}

async function cleanup() {
  const fids = (
    await db.select({ id: flows.id }).from(flows).where(inArray(flows.owner_id, BOTH))
  ).map((f) => f.id);
  if (fids.length) await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
  await db.delete(chatSessions).where(inArray(chatSessions.user_id, BOTH)); // cascades messages
  await db.delete(agentSessions).where(inArray(agentSessions.user_id, BOTH));
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, BOTH));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, BOTH));
  if (fids.length) await db.delete(flows).where(inArray(flows.id, fids));
  await db.delete(users).where(inArray(users.id, BOTH));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  seen = [];
  await cleanup();
  // Both users are in the SAME tenant on purpose. RLS already stops the cross-TENANT case
  // (tests/rls-runtime.test.ts pins that); the reachable leak is between two colleagues,
  // which is precisely the case RLS cannot see.
  await db
    .insert(users)
    .values([
      { id: USER_A, tenant_id: DEMO_TENANT_ID, email: 'chatA@test', name: 'Chat A' },
      { id: USER_B, tenant_id: DEMO_TENANT_ID, email: 'chatB@test', name: 'Chat B' },
    ])
    .onConflictDoNothing({ target: users.id });
  const [flow] = await db
    .insert(flows)
    .values({
      tenant_id: DEMO_TENANT_ID,
      name: 'Published Flow',
      owner_id: USER_A,
      graph: emptyGraph(),
    })
    .returning();
  flowId = flow!.id;
  __setBrokerDepsForTests({
    chatProvider: recorder,
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

// ---- door 1: the route must not take a client-supplied flowId on trust ----

test("B's turn on A's flow is refused at the route, and never touches A's session", async () => {
  const tokenA = await issueToken(USER_A);
  const tokenB = await issueToken(USER_B);

  const a = await chatTurn(tokenA, { message: `Wire up the ${A_SECRET} step.`, flowId });
  expect(a.status).toBe(200);
  expect(a.events.map((e) => e.type)).toContain('turn-end');

  const afterA = await sessionsForFlow();
  expect(afterA.length).toBe(1);
  expect(afterA[0]!.user_id).toBe(USER_A);
  const sessionA = afterA[0]!.id;

  seen = [];
  const b = await chatTurn(tokenB, { message: `What does the ${B_SECRET} block do?`, flowId });

  // ⛔ THE LEAK ITSELF, asserted before anything about status codes: whatever the route
  // decides to do with B's request, A's private conversation must not have been replayed
  // into the provider request, and B's message must not have landed in A's thread.
  expect(JSON.stringify(seen)).not.toContain(A_SECRET);
  expect(await transcriptOf(sessionA)).not.toContain(B_SECRET);

  // B does not own F, and every other flow-touching surface answers 404 for that (never 403 —
  // routes/flows.ts `loadOwnedFlow` documents the choice). The copilot is an AUTHORING tool:
  // its whole flow toolset re-checks ownership per call and would 404 on every edit anyway.
  expect(b.status).toBe(404);
  expect(b.json?.error).toBe('flow_not_found');

  // The provider must never have been reached — no context assembled, no history replayed.
  expect(seen.length).toBe(0);

  // Flow F still has exactly ONE session, A's. B got no session on it.
  const afterB = await sessionsForFlow();
  expect(afterB.length).toBe(1);
  expect(afterB[0]!.id).toBe(sessionA);
}, 30_000);

// ---- door 2: ensureChatSession must key on (user, flow), not flow alone ----

test('a second user running a turn on the same flow gets their OWN session and context', async () => {
  const sessionA = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_A, flowId));
  await runTurn(USER_A, sessionA, `Wire up the ${A_SECRET} step.`);

  // The DATA door, exercised directly: this is what the route did before the fix, and what any
  // future caller resolving a session by flow would still do.
  const sessionB = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_B, flowId));
  expect(sessionB).not.toBe(sessionA);

  const [rowB] = await db
    .select({ user_id: chatSessions.user_id })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionB));
  expect(rowB!.user_id).toBe(USER_B);

  seen = [];
  await runTurn(USER_B, sessionB, `What does the ${B_SECRET} block do?`);

  // What the model was actually handed for B's turn carries none of A's conversation.
  expect(seen.length).toBe(1);
  const contextB = JSON.stringify(seen[0]);
  expect(contextB).toContain(B_SECRET);
  expect(contextB).not.toContain(A_SECRET);

  // ...and B's turn was not appended to A's thread, nor A's to B's.
  expect(await transcriptOf(sessionA)).not.toContain(B_SECRET);
  expect(await transcriptOf(sessionB)).not.toContain(A_SECRET);
}, 30_000);

test('the same user returning to the same flow resumes their own session', async () => {
  const first = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_A, flowId));
  await runTurn(USER_A, first, `Wire up the ${A_SECRET} step.`);
  const second = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_A, flowId));
  expect(second).toBe(first);

  // Resuming means the earlier turn IS the context for the next one — the fix must not
  // "isolate" a user from themselves by opening a fresh thread each time.
  seen = [];
  await runTurn(USER_A, first, 'And what did I ask you a moment ago?');
  expect(JSON.stringify(seen[0])).toContain(A_SECRET);

  // Exactly one session on the flow, and the whole conversation is in it.
  expect((await sessionsForFlow()).length).toBe(1);
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, first));
  expect(rows.length).toBe(4); // 2 user + 2 assistant
}, 30_000);

test('a flow-keyed session is scoped to its owner even when both users are queried', async () => {
  const sessionA = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_A, flowId));
  const sessionB = await withTenantDb(DEMO_TENANT_ID, () => ensureChatSession(USER_B, flowId));
  const rows = await db
    .select({ id: chatSessions.id, user_id: chatSessions.user_id })
    .from(chatSessions)
    .where(and(eq(chatSessions.flow_id, flowId), inArray(chatSessions.user_id, BOTH)));
  expect(rows.length).toBe(2);
  expect(new Set(rows.map((r) => r.id))).toEqual(new Set([sessionA, sessionB]));
}, 30_000);

/** One full agent turn against an already-resolved session, bypassing the route's authz so
 *  the DATA door can be tested on its own. */
async function runTurn(userId: string, sessionId: string, message: string): Promise<void> {
  const events: AgentEvent[] = [];
  await runAgentChatScoped({
    userId,
    roles: ['employee'],
    tenantId: DEMO_TENANT_ID,
    sessionId,
    flowId,
    userMessage: message,
    emit: (ev) => events.push(ev),
    signal: new AbortController().signal,
  });
  const end = events.find((e) => e.type === 'turn-end');
  expect(end && 'status' in end ? end.status : undefined).toBe('done');
}
