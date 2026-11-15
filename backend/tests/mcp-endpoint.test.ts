// tests/mcp-endpoint.test.ts — Stage F: the external /api/mcp JSON-RPC endpoint +
// the agent⟷MCP tool-catalogue contract. Against the live :5433 DB; authenticates
// with a real agent token (independent of AUTH_BYPASS).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, withTenantDb, users, agentSessions, auditLog } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import { Router } from '../src/utils/router';
import { registerMcpRoutes } from '../src/routes/mcp';
import { issueAgentSession } from '../src/services/agent-session';
import { mcpHost, type McpAuthContext } from '../src/ai/mcp-server';
import { PLATFORM_TOOLS, FRONTEND_TOOL_NAMES } from '../src/ai/mcp/tools';

const USER_ID = '00000000-0000-0000-0000-00000010f001';
const router = new Router();
registerMcpRoutes(router);
let token = '';

async function rpc(method: string, params?: Record<string, unknown>) {
  const m = router.match('POST', '/api/mcp/jsonrpc')!;
  const res = await m.handler(
    new Request('http://t/api/mcp/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await res.json()) as { result?: any; error?: any };
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await db.delete(agentSessions).where(eq(agentSessions.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'mcp-ep@test', name: 'Mcp Ep' })
    .onConflictDoNothing({ target: users.id });
  token = (await withTenantDb(DEMO_TENANT_ID, () => issueAgentSession(USER_ID, [], DEMO_TENANT_ID)))
    .accessToken;
}, 30_000);
afterAll(async () => {
  await db.delete(agentSessions).where(eq(agentSessions.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}, 30_000);

// ---- the contract: agent catalogue ⟷ MCP tools/list ⟷ driver edit set ----
test('contract: MCP tools/list == the in-code platform catalogue', async () => {
  const ctx: McpAuthContext = { userId: USER_ID, tenantId: null, roles: [] };
  const hostNames = (await mcpHost.listTools(ctx)).map((t) => t.name).sort();
  const codeNames = PLATFORM_TOOLS.map((t) => t.name).sort();
  expect(hostNames).toEqual(codeNames);
});

test('contract: the frontend (driver-fulfilled) tool set is exactly the surface=frontend tools', () => {
  const fromSurface = new Set(
    PLATFORM_TOOLS.filter((t) => t.surface === 'frontend').map((t) => t.name),
  );
  // Frontend tools are fulfilled live by one of two browser drivers:
  //  · the canvas edit driver (driver.ts) — the flow-graph verbs;
  //  · the block-editor drivers — propose_block_draft (authoring) + propose_block_patch (fix-loop).
  const canvasDriverImplements = [
    'add_node',
    'insert_node',
    'remove_node',
    'connect_nodes',
    'disconnect_nodes',
    'configure_node',
    'move_node',
  ];
  const editorDriverImplements = ['propose_block_draft', 'propose_block_patch'];
  const driverImplements = new Set([...canvasDriverImplements, ...editorDriverImplements]);
  expect([...FRONTEND_TOOL_NAMES].sort()).toEqual([...fromSurface].sort());
  expect([...FRONTEND_TOOL_NAMES].sort()).toEqual([...driverImplements].sort());
});

// ---- the JSON-RPC endpoint ----
test('initialize advertises the three MCP primitives', async () => {
  const { result } = await rpc('initialize');
  expect(result.capabilities).toHaveProperty('tools');
  expect(result.capabilities).toHaveProperty('resources');
  expect(result.capabilities).toHaveProperty('prompts');
});

test('tools/list + tools/call search_blocks work over JSON-RPC', async () => {
  const list = await rpc('tools/list');
  expect(list.result.tools.some((t: { name: string }) => t.name === 'search_blocks')).toBe(true);

  const call = await rpc('tools/call', { name: 'search_blocks', arguments: { query: 'summar' } });
  expect(call.result.isError).toBe(false);
  const payload = JSON.parse(call.result.content[0].text);
  expect(Array.isArray(payload.items)).toBe(true);
});

test('resources/list + prompts/get resolve over JSON-RPC', async () => {
  const resources = await rpc('resources/list');
  expect(resources.result.resources.some((r: { uri: string }) => r.uri.startsWith('doc://'))).toBe(true);

  const prompt = await rpc('prompts/get', { name: 'agent.system' });
  expect(prompt.result.messages[0].content.text.length).toBeGreaterThan(0);
});

test('an unknown method returns a JSON-RPC method-not-found error', async () => {
  const { error } = await rpc('does/not/exist');
  expect(error.code).toBe(-32601);
});
