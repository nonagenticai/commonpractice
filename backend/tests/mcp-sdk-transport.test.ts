// tests/mcp-sdk-transport.test.ts — the OFFICIAL @modelcontextprotocol/sdk client
// driving our /api/mcp Streamable HTTP transport end-to-end, in-process (a fetch shim
// routes the SDK client's requests straight into the Router — no network/port). Proves
// the SDK transport speaks the protocol and fronts the SAME governed mcpHost surface.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Router } from '../src/utils/router';
import { registerMcpRoutes } from '../src/routes/mcp';
import { mcpHost, type McpAuthContext } from '../src/ai/mcp-server';
import { seedAi } from '../src/db/seed-ai';

const router = new Router();
registerMcpRoutes(router);

// Route the SDK client's HTTP calls into the in-process Router (AUTH_BYPASS supplies
// the dev identity, so no token is needed in the test env).
const inProcessFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(url.toString());
  const method = init?.method ?? 'GET';
  const matched = router.match(method, u.pathname);
  if (!matched) return new Response('not found', { status: 404 });
  return matched.handler(new Request(u.toString(), init), ...matched.params);
}) as unknown as typeof fetch;

let client: Client;

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedAi(); // ensure agent.system prompt rows exist (prompts/list + get)
  const transport = new StreamableHTTPClientTransport(new URL('http://t/api/mcp'), {
    fetch: inProcessFetch,
  });
  client = new Client({ name: 'cp-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport); // runs the initialize handshake over the transport
}, 30_000);
afterAll(async () => {
  await client?.close();
});

test('contract: SDK client tools/list == mcpHost.listTools', async () => {
  const ctx: McpAuthContext = {
    userId: '00000000-0000-0000-0000-000000000000',
    tenantId: null,
    roles: [],
  };
  const hostNames = (await mcpHost.listTools(ctx)).map((t) => t.name).sort();
  const wire = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(wire).toEqual(hostNames);
  expect(wire).toContain('search_blocks');
  expect(wire).toContain('add_node');
});

test('SDK client resources/list + read (doc://book) round-trips', async () => {
  const list = await client.listResources();
  const uris = list.resources.map((r) => r.uri);
  expect(uris).toContain('doc://book/getting-started?lang=en');

  const read = await client.readResource({ uri: 'doc://book/getting-started?lang=en' });
  const first = read.contents[0] as { uri: string; text?: string };
  expect(first.uri).toBe('doc://book/getting-started?lang=en');
  expect(String(first.text)).toContain('Common Practice');
});

test('SDK client prompts/list + get (agent.system) round-trips', async () => {
  const list = await client.listPrompts();
  expect(list.prompts.map((p) => p.name)).toContain('agent.system');

  const got = await client.getPrompt({ name: 'agent.system' });
  expect(got.messages.length).toBeGreaterThan(0);
  expect(got.messages[0]!.content.type).toBe('text');
});

test('SDK client tools/call (search_blocks) returns content via the host', async () => {
  const out = await client.callTool({
    name: 'search_blocks',
    arguments: { query: 'summarize' },
  });
  expect(out.isError).toBeFalsy();
  const content = out.content as { type: string; text: string }[];
  expect(content[0]!.type).toBe('text');
  // the host returns a JSON payload as text
  expect(() => JSON.parse(content[0]!.text)).not.toThrow();
});
