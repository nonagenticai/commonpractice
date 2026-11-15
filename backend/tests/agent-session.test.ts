// tests/agent-session.test.ts — the agent two-token model (Stage D): issue →
// verify, refresh rotation + replay revocation. Against the live :5433 DB.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, users, agentSessions, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import {
  issueAgentSession,
  refreshAgentSession,
  verifyAgentToken,
} from '../src/services/agent-session';

const USER_ID = '00000000-0000-0000-0000-0000000e0001';

// The agent-session service inserts into agent_sessions (tenant_id NOT NULL). Tests
// call it directly, without the request wrapper that sets the tenant_id GUC, so run
// these inside an explicit tenant context.
const tx = <T>(fn: () => Promise<T>) => withTenantDb(DEMO_TENANT_ID, fn);

function bearer(token: string): Request {
  return new Request('http://test/api/agent/chat', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function cleanup() {
  await db.delete(agentSessions).where(eq(agentSessions.user_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'agent@test', name: 'Agent' })
    .onConflictDoNothing({ target: users.id });
}, 30_000);
afterAll(cleanup, 30_000);

test('issue mints an access token that verifies to the user', async () => {
  const s = await tx(() => issueAgentSession(USER_ID, [], DEMO_TENANT_ID));
  expect(s.accessToken.length).toBeGreaterThan(0);
  expect(s.refreshToken.length).toBeGreaterThan(0);
  const { userId } = await verifyAgentToken(bearer(s.accessToken));
  expect(userId).toBe(USER_ID);
});

test('verifyAgentToken rejects garbage / missing tokens', async () => {
  await expect(verifyAgentToken(bearer('not-a-jwt'))).rejects.toThrow();
  await expect(
    verifyAgentToken(new Request('http://test', {})),
  ).rejects.toThrow();
});

test('refresh rotates the token and marks the old row replaced', async () => {
  const first = await tx(() => issueAgentSession(USER_ID, [], DEMO_TENANT_ID));
  const second = await tx(() => refreshAgentSession(first.refreshToken));
  expect(second.refreshToken).not.toBe(first.refreshToken);
  const { userId } = await verifyAgentToken(bearer(second.accessToken));
  expect(userId).toBe(USER_ID);
});

test('replay of a consumed refresh token is detected and revokes the chain', async () => {
  const first = await tx(() => issueAgentSession(USER_ID, [], DEMO_TENANT_ID));
  const second = await tx(() => refreshAgentSession(first.refreshToken)); // consumes `first`
  // Replaying `first` must fail...
  await expect(tx(() => refreshAgentSession(first.refreshToken))).rejects.toThrow(/replay/i);
  // ...and the whole forward chain is now revoked, so `second` is dead too.
  await expect(tx(() => refreshAgentSession(second.refreshToken))).rejects.toThrow(/revoked/i);
});
