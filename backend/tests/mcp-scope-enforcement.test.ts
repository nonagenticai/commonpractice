// tests/mcp-scope-enforcement.test.ts — a minted key's `scopes` must actually gate the MCP
// primitives it can reach.
//
// THE DEFECT (ai/mcp/scopes.ts, routes/mcp.ts resolveMcpIdentity, ai/mcp-server.ts).
// `mcp_api_keys.scopes` was minted, stored, and carried into `VerifiedKey.scopes` — and then
// DROPPED in `resolveMcpIdentity`, which returned `{ userId, tenantId, roles: [] }` with no
// `scopes` field. Nothing downstream could enforce a grant it never received, so a key minted
// "read-only" held full write authority over flows, blocks and templates. Before this file,
// `grep "scopes" backend/tests/mcp-*.test.ts` found nothing: no test anywhere minted a
// restricted-scope key, so no test could have failed while the defect was live.
//
// ⛔ THE MUTANT THAT MATTERS MOST. `scopes` reaches the SDK request handlers ONLY through
// `authInfoFor` (routes/mcp.ts) → `AuthInfo.extra` → `ctxFromExtra` (ai/mcp-sdk-server.ts). A fix
// that threads scopes into `McpAuthContext` but not through that channel would leave the real
// `/api/mcp` streamable transport — what every external MCP client actually speaks — wide open,
// while a jsonrpc-only test stayed green. So every assertion below runs over BOTH
// `/api/mcp/jsonrpc` and the SDK streamable transport at `/api/mcp`, through one shared `callBoth`
// helper, never as duplicated per-transport bodies.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Router } from '../src/utils/router';
import { registerMcpRoutes } from '../src/routes/mcp';
import { db, tenants, users, mcpApiKeys, runAsSystem } from '../src/db/client';
import { mintKey } from '../src/services/mcp-api-key';
import { seed } from '../src/db/seed';
import { PLATFORM_TOOL_NAMES, MCP_SCOPE_DENIED } from '../src/ai/mcp/scopes';

// Ids owned solely by this file.
const TENANT = '00000000-0000-0000-0000-00000c9f0001';
const ISSUER = '00000000-0000-0000-0000-00000c9f0d01';

const router = new Router();
registerMcpRoutes(router);

let readOnlyKey: string; // scopes: ['resources'] — no tools, no prompts
let fullKey: string; // default scopes: ['tools', 'resources', 'prompts']
let promptsOnlyKey: string; // scopes: ['prompts'] — the "empty-ish" grant that must still deny tools
let emptyScopeKey: string; // scopes: [] — the LITERAL deliberate-empty-grant case `hasScope` names

async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(mcpApiKeys).where(eq(mcpApiKeys.tenant_id, TENANT));
    await db.delete(users).where(eq(users.id, ISSUER));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
  });
}

beforeAll(async () => {
  await seed();
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: TENANT, name: 'MCP Scope Enf', slug: 'mcp-scope-enf-t' });
    await db
      .insert(users)
      .values({ id: ISSUER, email: 'mcp-scope-enf@test', name: 'MCP Scope Enf', tenant_id: TENANT });
    readOnlyKey = (
      await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-scope-ro', scopes: ['resources'] })
    ).raw;
    fullKey = (await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-scope-full' })).raw;
    promptsOnlyKey = (
      await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-scope-prompts', scopes: ['prompts'] })
    ).raw;
    emptyScopeKey = (
      await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-scope-empty', scopes: [] })
    ).raw;
  });
}, 60_000);

afterAll(cleanup, 30_000);

// ---------------------------------------------------------------------------------------------
// Two-transport harness. Mirrors mcp-tenant-scope-escape.test.ts's `mcpRaw`/`openSession` shape
// (that file keeps them module-private, so they are re-expressed here rather than imported), but
// adds a second target path and a JSON-RPC result diff so one call drives both transports.
// ---------------------------------------------------------------------------------------------
const PROTO = '2025-06-18';

async function rawRequest(
  path: string,
  key: string | undefined,
  opts: { method?: string; body?: unknown; sessionId?: string },
): Promise<{ status: number; text: string; sessionId: string | null }> {
  const method = opts.method ?? 'POST';
  const matched = router.match(method, path)!;
  const headers = new Headers({
    // POST on the streamable transport 406s unless both are accepted; harmless for jsonrpc.
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTO,
  });
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.sessionId) headers.set('mcp-session-id', opts.sessionId);
  const res = await matched.handler(
    new Request(`http://t${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    ...matched.params,
  );
  return { status: res.status, text: await res.text(), sessionId: res.headers.get('mcp-session-id') };
}

/** One streamable session per key (`undefined` = no Authorization header, i.e. the AUTH_BYPASS /
 *  agent-JWT path), reused across calls. Safe to reuse: `authInfoFor` resolves `scopes` from the
 *  Authorization header on EVERY request — it is never cached on the session — so reusing a
 *  session cannot mask a scope check that only ran once. */
const streamableSessions = new Map<string | undefined, string>();
async function streamableSessionFor(key: string | undefined): Promise<string> {
  const cached = streamableSessions.get(key);
  if (cached) return cached;
  const init = await rawRequest('/api/mcp', key, {
    body: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'scope-test', version: '0' } },
    },
  });
  expect(init.status).toBe(200);
  const sid = init.sessionId!;
  expect(typeof sid).toBe('string');
  await rawRequest('/api/mcp', key, {
    sessionId: sid,
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  streamableSessions.set(key, sid);
  return sid;
}

/** Parses a `/api/mcp` (SDK Streamable HTTP transport) response body into its JSON-RPC envelope.
 *
 *  `WebStandardStreamableHTTPServerTransport.handlePostRequest` defaults to SSE streaming (it only
 *  returns bare JSON when constructed with `enableJsonResponse: true`, which `createMcpSdkServer`
 *  in `src/ai/mcp-sdk-server.ts` never sets), so the body is SSE-framed by `writeSSEEvent`
 *  (`@modelcontextprotocol/sdk` `server/webStandardStreamableHttp.js`):
 *    `event: message\n` (+ optional `id: <n>\n`) + `data: <JSON>\n\n`
 *  i.e. exactly the shape the brief sketched, confirmed by reading the installed SDK source rather
 *  than assumed. A keepalive tick on the same stream would additionally enqueue a bare SSE COMMENT
 *  line (`: keepalive\n\n`, no `data:`), so this parser must skip non-`data:` lines rather than
 *  index into the body positionally.
 *
 *  Handles both shapes: a body that already starts with `{`/`[` (no SSE framing — e.g. if the SDK
 *  is ever run with `enableJsonResponse: true`) is parsed directly; otherwise the body is split on
 *  blank lines into SSE event frames, each frame's `data:` line(s) are joined (per the SSE spec,
 *  multi-line `data:` fields concatenate with `\n`), and the LAST frame whose joined data parses as
 *  JSON is returned — "last" because a keepalive comment frame carries no `data:` at all and an
 *  event's own priming frame (resumable-stream mode only, not used here) sends an empty `data:`.
 *
 *  Throws — never returns `{}`/`null` — when no frame yields parseable JSON, so a body shape this
 *  parser doesn't understand fails loudly instead of turning every assertion downstream vacuously
 *  green. */
function parseStreamableBody(rawBody: string): any {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  for (const frame of rawBody.split(/\n\n+/).reverse()) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    if (!joined) continue; // empty `data:` (priming/keepalive frame) — not the payload
    try {
      return JSON.parse(joined);
    } catch {
      continue;
    }
  }
  throw new Error(
    `streamable response body carried no parseable SSE "data:" payload (and is not bare JSON). ` +
      `Raw body (first 200 chars): ${rawBody.slice(0, 200)}`,
  );
}

let nextId = 1;
/** Drives one JSON-RPC call over BOTH transports and returns both parsed envelopes. Both routes
 *  build the identical `{ jsonrpc, id, result | error }` shape from the same `mcpHost` calls
 *  (routes/mcp.ts `rpcResult` vs the SDK Server's own envelope), so every caller below asserts on
 *  `.jsonrpc.result` and `.streamable.result` side by side — a fix reaching only one transport
 *  fails exactly one half. */
async function callBoth(
  key: string | undefined,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ jsonrpc: any; streamable: any }> {
  const id = nextId++;
  const body = { jsonrpc: '2.0', id, method, params };

  const rawJsonrpc = await rawRequest('/api/mcp/jsonrpc', key, { body });
  expect(rawJsonrpc.status).toBe(200);

  const sid = await streamableSessionFor(key);
  const rawStreamable = await rawRequest('/api/mcp', key, { sessionId: sid, body });
  expect(rawStreamable.status).toBe(200);

  return { jsonrpc: JSON.parse(rawJsonrpc.text), streamable: parseStreamableBody(rawStreamable.text) };
}

/** Asserts a `tools/list`-shaped result names exactly `names` on BOTH transports. */
function expectToolNames(out: { jsonrpc: any; streamable: any }, names: string[]): void {
  const sorted = [...names].sort();
  for (const half of [out.jsonrpc, out.streamable]) {
    expect(half.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(sorted);
  }
}

// ---------------------------------------------------------------------------------------------
// readOnlyKey (`scopes: ['resources']`) — no `tools`, no `prompts`.
// ---------------------------------------------------------------------------------------------

test('a resources-only key sees no tools on either transport', async () => {
  const out = await callBoth(readOnlyKey, 'tools/list');
  expectToolNames(out, []);
});

test('a resources-only key calling a tool is refused mcp_scope_denied on both transports', async () => {
  const out = await callBoth(readOnlyKey, 'tools/call', {
    name: 'search_blocks',
    arguments: { query: 'summarize' },
  });
  for (const half of [out.jsonrpc, out.streamable]) {
    expect(half.result.isError).toBe(true);
    const payload = JSON.parse(half.result.content[0].text);
    expect(payload.error).toBe(MCP_SCOPE_DENIED);
    expect(payload.required).toBe('tools:read');
  }
});

test('a resources-only key sees no prompts on either transport', async () => {
  const out = await callBoth(readOnlyKey, 'prompts/list');
  for (const half of [out.jsonrpc, out.streamable]) {
    expect(half.result.prompts).toEqual([]);
  }
});

test('a resources-only key can still read a resource on both transports', async () => {
  const out = await callBoth(readOnlyKey, 'resources/read', {
    uri: 'doc://book/getting-started?lang=en',
  });
  for (const half of [out.jsonrpc, out.streamable]) {
    expect(half.error).toBeUndefined();
    expect(String(half.result.contents[0].text)).toContain('Common Practice');
  }
}, 30_000);

// ---------------------------------------------------------------------------------------------
// Non-vacuity control (required by the brief): a fully-scoped key must see EVERYTHING readOnlyKey
// was denied. Without this control, the three denial tests above would pass identically against a
// host that refuses every key — a merely broken host, not an enforced one.
// ---------------------------------------------------------------------------------------------

test('non-vacuity: a full-scope key sees all 29 tools and can actually call one, on both transports', async () => {
  const list = await callBoth(fullKey, 'tools/list');
  expectToolNames(list, [...PLATFORM_TOOL_NAMES]);

  const call = await callBoth(fullKey, 'tools/call', {
    name: 'search_blocks',
    arguments: { query: 'summarize' },
  });
  for (const half of [call.jsonrpc, call.streamable]) {
    expect(half.result.isError).toBe(false);
    const payload = JSON.parse(half.result.content[0].text);
    expect(Array.isArray(payload.items)).toBe(true);
  }
});

// ---------------------------------------------------------------------------------------------
// Empty-ish grant: `['prompts']` grants nothing towards `tools`. Paired in this SAME file with the
// unscoped case directly below so the "treat [] and undefined alike" fail-open mutant, which would
// pass either test in isolation, cannot pass both.
// ---------------------------------------------------------------------------------------------

test('a prompts-only key is denied tools on both transports (an empty-ish grant must deny)', async () => {
  const out = await callBoth(promptsOnlyKey, 'tools/list');
  expectToolNames(out, []);
});

// `['prompts']` above has length 1, so it never touches a mutant shaped like
// `if (!granted?.length) return true` — that collapse only fires on a LITERAL `[]`. `hasScope`'s
// own doc comment names `[]` as "a REAL, DELIBERATE, EMPTY grant" that must deny everything, as
// opposed to `undefined` ("not a scoped credential at all"), which must allow everything — the
// two are opposite, not merely both "falsy". This key is minted with the literal empty array and
// must be denied every primitive, tools included, on both transports.
test('a key minted with a literal [] scope is denied every primitive on both transports', async () => {
  const tools = await callBoth(emptyScopeKey, 'tools/list');
  expectToolNames(tools, []);
  const prompts = await callBoth(emptyScopeKey, 'prompts/list');
  for (const half of [prompts.jsonrpc, prompts.streamable]) {
    expect(half.result.prompts).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------
// Unscoped credential: the agent-JWT / AUTH_BYPASS path never sets `scopes` at all (`undefined`,
// not `[]`), and `hasScope(undefined, …)` is true by design — this is what keeps the in-app
// copilot working. `key: undefined` here means no Authorization header, which (with
// tests/setup-env.ts's `AUTH_BYPASS=true`) resolves through resolveMcpIdentity's bypass branch.
// Paired here with the LITERAL `[]` test above (same file) so a mutant that treats an absent
// `scopes` field and a present-but-empty array identically — in EITHER direction — fails one half
// of this pair: collapsing toward "allow" passes this test but reddens the one above; collapsing
// toward "deny" passes the one above but reddens this one.
// ---------------------------------------------------------------------------------------------

test('an unscoped (AUTH_BYPASS) credential still lists all 29 tools on both transports', async () => {
  const out = await callBoth(undefined, 'tools/list');
  expectToolNames(out, [...PLATFORM_TOOL_NAMES]);
});
