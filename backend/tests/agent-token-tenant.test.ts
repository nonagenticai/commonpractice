// tests/agent-token-tenant.test.ts — THE COPILOT MUST ANSWER ABOUT THE WORKSPACE THE BROWSER IS IN.
//
// ⛔ THE DEFECT THIS FILE PINS, MEASURED IN PRODUCTION AND NOT HYPOTHETICAL. `POST /api/agent/chat`
// and the MCP transport resolved tenancy with `homeTenantOf(userId)` — i.e. `users.tenant_id`, a
// column `ensureUser` writes ONCE on first touch and never reconciles against a later Keycloak
// `tenant_id` claim. The browser, meanwhile, resolves the CLAIM on every request (`resolveTenant`).
// So the two surfaces of one product ran in DIFFERENT workspaces for anyone whose claim had moved.
// On worker4's `commonpractice` DB: `george@nonagentic.ai` had `users.tenant_id = …0001` while the
// claim resolved to `0195f48b-…-0099`; one user's 17 `agent_sessions` rows carried THREE distinct
// tenants, with their `chat_sessions` (10) and `chat_messages` (72) split across two. Three users
// had `users.tenant_id IS NULL`, so `homeTenantOf` returned null and the route 400'd
// `no_home_tenant` at them — their copilot was 100% broken.
//
// THE FIX'S SHAPE, and therefore what each test below has to be able to see: the tenant is decided
// ONCE, at `POST /api/agent/session/issue`, which is the only copilot request that ever holds a
// Keycloak claim — and is baked into the access token as `tid`. Every later request reads it back
// out of the token instead of re-deriving it.
//
// ⚠️ EVERY TEST HERE MINTS UNDER TENANT **B** FOR A USER WHOSE `users.tenant_id` IS **A**, AND THAT
// DIVERGENCE IS THE ENTIRE FIXTURE. With an aligned user (home == mint tenant) the old code and the
// new code produce identical rows and every assertion below passes against both — which is exactly
// how this shipped. `homeA` is never the right answer to any question this file asks; a test that
// goes green while reading A is measuring nothing.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import {
  db,
  users,
  tenants,
  agentSessions,
  chatSessions,
  chatMessages,
  usageCounters,
  auditLog,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
  runAsSystem,
} from '../src/db/client';
import { config } from '../src/config';
import { Router } from '../src/utils/router';
import { registerAgentRoutes } from '../src/routes/agent';
import { registerMcpRoutes } from '../src/routes/mcp';
import {
  issueAgentSession,
  refreshAgentSession,
  verifyAgentToken,
} from '../src/services/agent-session';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider } from '../src/ai/llm/provider';

// `0000-4000-8000` keeps these valid v4-shaped UUIDs and greppably distinct from every other
// fixture's block, so a stray row from another file can never satisfy an assertion here.
const TENANT_A = '00000000-0000-4000-8000-00000a9d0001'; // the STALE `users.tenant_id`
const TENANT_B = '00000000-0000-4000-8000-00000a9d0002'; // the CLAIM — the right answer, always
const USER_HOMED_A = '00000000-0000-4000-8000-00000a9d0a01'; // home A, signs in under B
const USER_NO_HOME = '00000000-0000-4000-8000-00000a9d0a02'; // `users.tenant_id IS NULL`
const SEEDED_USERS = [USER_HOMED_A, USER_NO_HOME];
const SEEDED_TENANTS = [TENANT_A, TENANT_B];

const AUD = 'cp-agent'; // mirrors services/agent-session.ts

const agentRouter = new Router();
registerAgentRoutes(agentRouter);
const mcpRouter = new Router();
registerMcpRoutes(mcpRouter);

/** Answers immediately with plain text and no tool calls, so a turn is one provider round-trip
 *  with no 30s frontend-tool wait. This file is about WHICH TENANT the turn ran in, not the loop. */
const recorder: LlmProvider = {
  async chat() {
    return { text: 'ack', usage: { tokensIn: 1, tokensOut: 1 } };
  },
};

/** POST /api/agent/chat and drain the SSE body to EOF. The turn is DETACHED from the Response (see
 *  the long note in routes/agent.ts), so reading to EOF is what waits for it — `close()` runs in the
 *  turn promise's `.finally`. Without the drain, the `chat_sessions` assertions race the insert. */
async function chatTurn(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; streamed: boolean; json: { error?: string } | null }> {
  const m = agentRouter.match('POST', '/api/agent/chat');
  if (!m) throw new Error('no route for POST /api/agent/chat');
  const res = await m.handler(
    new Request('http://t/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    ...m.params,
  );
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const text = await res.text();
    return { status: res.status, streamed: false, json: text ? JSON.parse(text) : null };
  }
  await new Response(res.body).text();
  return { status: res.status, streamed: true, json: null };
}

async function jsonrpc(token: string, method: string, params?: Record<string, unknown>) {
  const m = mcpRouter.match('POST', '/api/mcp/jsonrpc');
  if (!m) throw new Error('no route for POST /api/mcp/jsonrpc');
  const res = await m.handler(
    new Request('http://t/api/mcp/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    ...m.params,
  );
  return { status: res.status, body: (await res.json()) as { result?: unknown; error?: unknown } };
}

/** A token shaped exactly like one minted BEFORE `tid` existed: same secret, same audience, same
 *  subject, same roles — and no tenant. This is the real rolling-deploy artefact, not a mangled
 *  string, which is why test 6 can distinguish "refused for the right reason" from "refused because
 *  it failed to verify at all". */
async function tokenWithoutTid(userId: string): Promise<string> {
  return new SignJWT({ roles: [] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${config.agent.accessTtlSec}s`)
    .sign(new TextEncoder().encode(config.agent.jwtSecret));
}

/** Read back OUTSIDE any tenant scope — as the owner, which bypasses RLS — so a row this file
 *  expects in B cannot be reported "absent" merely because the reader was scoped to A. Every
 *  assertion about where a row LANDED must be able to see BOTH tenants, or it proves nothing. */
const asOwner = <T>(fn: () => Promise<T>) => runAsSystem('platform-admin', fn);

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(chatMessages).where(
      inArray(
        chatMessages.session_id,
        db.select({ id: chatSessions.id }).from(chatSessions).where(inArray(chatSessions.user_id, SEEDED_USERS)),
      ),
    );
    await db.delete(chatSessions).where(inArray(chatSessions.user_id, SEEDED_USERS));
    await db.delete(agentSessions).where(inArray(agentSessions.user_id, SEEDED_USERS));
    await db.delete(usageCounters).where(inArray(usageCounters.user_id, SEEDED_USERS));
    await db.delete(auditLog).where(inArray(auditLog.actor_id, SEEDED_USERS));
    await db.delete(users).where(inArray(users.id, SEEDED_USERS));
    await db.delete(tenants).where(inArray(tenants.id, SEEDED_TENANTS));
  });
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause.
beforeEach(async () => {
  __setBrokerDepsForTests({ chatProvider: recorder });
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values([
      { id: TENANT_A, name: 'Stale Home Co', slug: 'agt-tid-a' },
      { id: TENANT_B, name: 'Claim Co', slug: 'agt-tid-b' },
    ]);
    await db.insert(users).values([
      { id: USER_HOMED_A, email: 'homed-a@agt-tid.test', name: 'Homed A', tenant_id: TENANT_A },
      // The three real users whose copilot 400'd `no_home_tenant`. NOT a synthetic edge case.
      { id: USER_NO_HOME, email: 'no-home@agt-tid.test', name: 'No Home', tenant_id: null },
    ]);
  });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

/** Mint the way `/api/agent/session/issue` does for a user whose CLAIM is B: under B's scope,
 *  passing B — regardless of the `users.tenant_id` the same user carries. */
const issueUnderB = (userId: string, roles: string[] = []) =>
  withTenantDb(TENANT_B, () => issueAgentSession(userId, roles, TENANT_B));

function bearer(token: string): Request {
  return new Request('http://t/api/agent/chat', { headers: { Authorization: `Bearer ${token}` } });
}

// ── 1. the token carries the MINT tenant, not the owner's home tenant ────────────────────────────
test('a token minted under B for a user homed in A verifies to B', async () => {
  const s = await issueUnderB(USER_HOMED_A);
  const { userId, tenantId } = await verifyAgentToken(bearer(s.accessToken));

  expect(userId).toBe(USER_HOMED_A);
  expect(tenantId).toBe(TENANT_B);
  // The negative half is the one that fails on main, where there is no `tid` at all and the caller
  // has to fall back to `users.tenant_id` — which is A.
  expect(tenantId).not.toBe(TENANT_A);

  // …and the session ROW agrees with the token. Two derivations that merely happened to agree is
  // the shape this change removed; assert them as one fact.
  const [row] = await asOwner(() =>
    db.select({ tenantId: agentSessions.tenant_id }).from(agentSessions).where(eq(agentSessions.id, s.sessionId)),
  );
  expect(row?.tenantId).toBe(TENANT_B);
});

// ── 2. the chat turn's rows land in the token's tenant ───────────────────────────────────────────
test('POST /api/agent/chat writes its chat_session into the token tenant B, not the home tenant A', async () => {
  const s = await issueUnderB(USER_HOMED_A, ['employee']);

  const out = await chatTurn(s.accessToken, { message: 'hello from the B workspace' });
  expect(out.status).toBe(200);
  expect(out.streamed).toBe(true);

  // Read as the owner so BOTH tenants are visible: "no row in A" must be provable, not assumed.
  const rows = await asOwner(() =>
    db
      .select({ id: chatSessions.id, tenantId: chatSessions.tenant_id })
      .from(chatSessions)
      .where(eq(chatSessions.user_id, USER_HOMED_A)),
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.tenantId).toBe(TENANT_B);
  expect(rows.map((r) => r.tenantId)).not.toContain(TENANT_A);
});

// ── 3. the three users with no home tenant get a working copilot ─────────────────────────────────
test('a user with users.tenant_id IS NULL streams instead of 400 no_home_tenant', async () => {
  const s = await issueUnderB(USER_NO_HOME, ['employee']);

  const out = await chatTurn(s.accessToken, { message: 'my account has no home tenant' });

  // On main this is a 400 whose body is `{"error":"no_home_tenant"}` — `homeTenantOf` returns null
  // and the route refuses before it ever reaches the model.
  expect(out.json?.error).toBeUndefined();
  expect(out.status).toBe(200);
  expect(out.streamed).toBe(true);

  const rows = await asOwner(() =>
    db.select({ tenantId: chatSessions.tenant_id }).from(chatSessions).where(eq(chatSessions.user_id, USER_NO_HOME)),
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.tenantId).toBe(TENANT_B);
});

// ── 4. the MCP transport agrees with the browser ─────────────────────────────────────────────────
test('/api/mcp/jsonrpc scopes the call to the token tenant B', async () => {
  const s = await issueUnderB(USER_HOMED_A, ['employee']);

  // An unknown tool is deliberate: `McpHost.callTool` catches the `tool_not_found` and STILL writes
  // the audit row, so this observes the tenant scoping with no tool side effects to clean up.
  const { status, body } = await jsonrpc(s.accessToken, 'tools/call', {
    name: 'definitely_not_a_tool',
    arguments: {},
  });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();

  // ⚠️ `audit_log` HAS NO `tenant_id` COLUMN (verified against the live schema — RLS is not even
  // enabled on it). The tenant the call ran under is recorded in `metadata.tenantId`, which is what
  // `ai/mcp-server.ts` writes, so that is what this asserts.
  const rows = await asOwner(() =>
    db
      .select({ tenantId: sql<string | null>`${auditLog.metadata}->>'tenantId'` })
      .from(auditLog)
      .where(and(eq(auditLog.actor_id, USER_HOMED_A), eq(auditLog.action, 'mcp.tool_call'))),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map((r) => r.tenantId)).toEqual(rows.map(() => TENANT_B));
  expect(rows.map((r) => r.tenantId)).not.toContain(TENANT_A);
});

// ── 5. rotation preserves the workspace — AND actually escapes RLS ───────────────────────────────
//
// ⛔ THE AMBIENT SCOPE HERE IS TENANT **A** WHILE THE SESSION ROW LIVES IN **B**, ON A `cp_app`
// CONNECTION, AND THAT IS THE POINT OF THE TEST. `/api/agent/session/refresh` carries an opaque
// refresh token and NO Keycloak header, so `peekEffectiveTenant` resolves null and the real request
// binds no tenant GUC at all. Under production's `cp_app` (measured NOBYPASSRLS on this harness)
// the `agent_sessions` policy `tenant_id = app_current_tenant_uuid()` then matches ZERO rows and
// the endpoint answers "Invalid refresh token" for a perfectly live token — a pre-existing bug the
// old tests could not see, because they wrapped the call in `withTenantDb` as the OWNER, which both
// binds a GUC the real request never has and bypasses RLS anyway.
//
// Running under a MISMATCHED tenant on a NOBYPASSRLS role reproduces the production shape and is
// strictly harder than reproducing "no GUC": if `refreshAgentSession`'s `runAsSystem` were a no-op
// — which is exactly what happens if anyone reintroduces a caller-supplied `db` handle that
// bypasses the AsyncLocalStorage Proxy — this SELECT sees A's rows only and the test fails.
test('refresh preserves tenant B and reads the row despite an RLS scope pinned to A', async () => {
  const first = await issueUnderB(USER_HOMED_A);

  const second = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    refreshAgentSession(first.refreshToken),
  );

  // The successor ROW carries B…
  const [successor] = await asOwner(() =>
    db.select({ tenantId: agentSessions.tenant_id }).from(agentSessions).where(eq(agentSessions.id, second.sessionId)),
  );
  expect(successor?.tenantId).toBe(TENANT_B);
  expect(successor?.tenantId).not.toBe(TENANT_A);

  // …and so does the successor TOKEN. A rotation that kept the row in B but re-minted a token
  // pointing at A would put the two back out of step one turn later.
  const { tenantId } = await verifyAgentToken(bearer(second.accessToken));
  expect(tenantId).toBe(TENANT_B);

  // The consumed row is chained, so the rotation really happened rather than silently no-op'ing.
  const [consumed] = await asOwner(() =>
    db.select({ replacedBy: agentSessions.replaced_by }).from(agentSessions).where(eq(agentSessions.id, first.sessionId)),
  );
  expect(consumed?.replacedBy).toBe(second.sessionId);
});

// ── 6. fail closed — a tenant-less token is refused, never silently homed ────────────────────────
test('a token with no tid is refused 401 agent_token_no_tenant and never falls back to tenant A', async () => {
  const legacy = await tokenWithoutTid(USER_HOMED_A);

  // It verifies fine — this is an AUTHORIZATION refusal about a valid token, not a failure to
  // authenticate. Asserting that first is what stops test 6 passing for the wrong reason.
  const verified = await verifyAgentToken(bearer(legacy));
  expect(verified.userId).toBe(USER_HOMED_A);
  expect(verified.tenantId).toBeNull();

  const chat = await chatTurn(legacy, { message: 'minted before tid existed' });
  expect(chat.status).toBe(401);
  expect(chat.json?.error).toBe('agent_token_no_tenant');

  const mcp = await jsonrpc(legacy, 'tools/call', { name: 'definitely_not_a_tool', arguments: {} });
  expect(mcp.status).toBe(401);

  // ⛔ THE REAL ASSERTION: nothing was written into the user's stale home tenant. A `homeTenantOf`
  // fallback would have made both calls SUCCEED against A — 200s, a chat session and an audit row
  // in the wrong workspace — which is the drift itself wearing the fix's clothes.
  const sessions = await asOwner(() =>
    db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.user_id, USER_HOMED_A)),
  );
  expect(sessions).toEqual([]);
  const audits = await asOwner(() =>
    db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.actor_id, USER_HOMED_A)),
  );
  expect(audits).toEqual([]);
});

// ── 7. the explicit tenant_id stamp, which nothing else can see ──────────────────────────────────
//
// ⛔ THIS TEST EXISTS BECAUSE THE STAMP WAS OTHERWISE UNFALSIFIABLE, AND THAT WAS MEASURED, NOT
// SUSPECTED. `agent_sessions.tenant_id` defaults to `app_current_tenant_uuid()`, and every other
// call site in this repo — including all six tests above — mints inside a `withTenantDb` whose
// tenant is the same one being passed. The default and the argument therefore produce an IDENTICAL
// row, so deleting `tenant_id: tenantId` from the insert passes the whole suite: measured at
// 6 pass / 0 fail here and 4 pass / 0 fail in agent-session.test.ts with the line removed. A
// property justified only by a comment is a property nothing defends.
//
// `runAsSystem` is what makes the two distinguishable: it binds the owner pool and sets NO
// `app.current_tenant`, and `app_current_tenant_uuid()` is
// `SELECT nullif(current_setting('app.current_tenant', true), '')::uuid` — NULL with no GUC —
// against a NOT NULL column. So the default path raises 23502 exactly where the explicit path
// succeeds.
//
// ⚠️ HONEST SCOPE: no production caller mints under `runAsSystem` today. This asserts a ROBUSTNESS
// property that `issueAgentSession`'s docstring claims in so many words ("it makes this function
// honest outside a request"), and it is the only construction that can tell the explicit stamp
// apart from the default. It is not a claim that such a caller exists.
test('issueAgentSession stamps the tenant explicitly rather than leaning on the GUC default', async () => {
  const s = await runAsSystem('platform-admin', () => issueAgentSession(USER_HOMED_A, [], TENANT_B));

  const [row] = await asOwner(() =>
    db
      .select({ tenantId: agentSessions.tenant_id })
      .from(agentSessions)
      .where(eq(agentSessions.id, s.sessionId)),
  );
  expect(row?.tenantId).toBe(TENANT_B);

  const { tenantId } = await verifyAgentToken(bearer(s.accessToken));
  expect(tenantId).toBe(TENANT_B);
});
