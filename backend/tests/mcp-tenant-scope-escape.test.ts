// tests/mcp-tenant-scope-escape.test.ts — an MCP tool must still have a tenant when it runs.
//
// THE DEFECT (routes/mcp.ts:85-120). Both streamable branches do
// `withTenantDb(ctx.tenantId, () => transport.handleRequest(...))`. That looks right and is not:
// the SDK's `handlePostRequest` calls `this.onmessage?.(message, …)` WITHOUT awaiting
// (webStandardStreamableHttp.js:552) and immediately returns the SSE `Response` (:557).
// `Protocol`'s onmessage hop then calls `this._onrequest(message, extra)` — also without awaiting
// (shared/protocol.js:237) — so the actual tool handler is dispatched two microtask hops AFTER
// `withTenantDb`'s `finally` has blanked `app.current_tenant` on the reserved connection and
// released it back to the pool. Every tool therefore executes on a released, blanked connection.
// The sibling legacy route `/api/mcp/jsonrpc` is correct: it awaits inside `withTenantDb`.
//
// It is LATENT in production only because `mcp_api_keys` is 3 issued / 0 ever used. It is a
// release gate for MCP-key rollout, not a demo blocker.
//
// ⛔ THIS DRIVES THE REAL EXTERNAL-CLIENT PATH, NOT AUTH_BYPASS. The call carries a genuine minted
// `cp_mcp_…` key in `Authorization: Bearer`, so `resolveCtx` goes through `isMcpApiKey` →
// `verifyKey` and the tenant comes from the KEY's own row — the exact identity path that the 3
// issued keys would use, and the one that has never been exercised in production. It also means
// this file owns every id it touches (no shared fixture ids; see fixture-id-collisions.test.ts).
//
// THE PROBE. `list_datasets` (ai/mcp/tools.ts:262) reads `datasets`, which is on the STRICT RLS
// shape, and applies its own `WHERE tenant_id = ctx.tenantId` on top. The explicit predicate means
// an OWNER DSN answers correctly no matter what the GUC says — which is exactly why this class was
// invisible for so long. Under the production `cp_app` role (NOBYPASSRLS) the missing GUC makes RLS
// return zero rows, and the tool reports an empty library to the caller with no error anywhere.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Router } from '../src/utils/router';
import { registerMcpRoutes } from '../src/routes/mcp';
import { db, datasets, tenants, users, mcpApiKeys, runAsSystem } from '../src/db/client';
import { mintKey } from '../src/services/mcp-api-key';
import { seed } from '../src/db/seed';

// Ids owned solely by this file.
const TENANT = '00000000-0000-0000-0000-00000c9e0001';
const ISSUER = '00000000-0000-0000-0000-00000c9e0d01';
const DS_SLUG = 'mcp-scope-probe-ds';
// Second identity + second workspace, for the session-ownership block at the foot of this file:
// PEER is a DIFFERENT user inside TENANT, and TENANT_B is a DIFFERENT workspace the SAME ISSUER
// holds a key in. Between them they vary exactly one half of the owning pair at a time.
const TENANT_B = '00000000-0000-0000-0000-00000c9e0002';
const PEER = '00000000-0000-0000-0000-00000c9e0d02';

const router = new Router();
registerMcpRoutes(router);

let apiKey: string;
let peerKey: string; // same tenant as `apiKey`, different user
let otherTenantKey: string; // same user as `apiKey`, different tenant
let siblingKey: string; // SAME issuer AND SAME tenant as `apiKey` — see the sibling-key test below

// The MCP routes are NOT reached through server.ts's per-request `withTenantDb`: an MCP API key is
// not a Keycloak JWT, so `peekEffectiveTenant` resolves null and no GUC is pre-set. The route's own
// `withTenantDb` is the ONLY tenant scope on this path — which is what makes escaping it total.
const inProcessFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(url.toString());
  const matched = router.match(init?.method ?? 'GET', u.pathname);
  if (!matched) return new Response('not found', { status: 404 });
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  return matched.handler(new Request(u.toString(), { ...init, headers }), ...matched.params);
}) as unknown as typeof fetch;

let client: Client;

/** Fixtures run as system: scaffolding must not be subject to the thing under test, and a read
 *  must observe what is really there — including a row RLS would hide from the tenant. */
async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(mcpApiKeys).where(inArray(mcpApiKeys.tenant_id, [TENANT, TENANT_B]));
    await db.delete(datasets).where(eq(datasets.slug, DS_SLUG));
    await db.delete(users).where(inArray(users.id, [ISSUER, PEER]));
    await db.delete(tenants).where(inArray(tenants.id, [TENANT, TENANT_B]));
  });
}

beforeAll(async () => {
  await seed();
  await cleanup();
  apiKey = await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: TENANT, name: 'MCP Scope', slug: 'mcp-scope-probe-t' });
    await db
      .insert(users)
      .values({ id: ISSUER, email: 'mcp-scope@test', name: 'MCP Scope', tenant_id: TENANT });
    await db.insert(datasets).values({
      tenant_id: TENANT,
      owner_id: ISSUER,
      slug: DS_SLUG,
      name: 'MCP Scope Probe',
      source_type: 'csv',
      status: 'ready',
      columns: [{ name: 'a', type: 'string' }],
      row_count: 1,
    });
    const minted = await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-scope-probe' });
    return minted.raw;
  });
  // Same issuer, same tenant as `apiKey` — the ordinary case of an admin minting a second key
  // (one per external client, or a rotation replacement). `verifyKey` resolves both to the
  // IDENTICAL (userId, tenantId) pair; only `keyId` can still tell them apart.
  siblingKey = await runAsSystem('boot-seed', async () => {
    const minted = await mintKey({ tenantId: TENANT, issuedBy: ISSUER, name: 'ws6-session-sibling' });
    return minted.raw;
  });
  [peerKey, otherTenantKey] = await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: TENANT_B, name: 'MCP Scope B', slug: 'mcp-scope-probe-b' });
    await db
      .insert(users)
      .values({ id: PEER, email: 'mcp-scope-peer@test', name: 'MCP Peer', tenant_id: TENANT });
    // `verifyKey` returns the KEY ROW's (userId, tenantId), so these two keys differ from
    // `apiKey` in exactly one coordinate each — which is what lets the tests below attribute a
    // refusal to the user half or the tenant half rather than to "some other identity".
    const peer = await mintKey({ tenantId: TENANT, issuedBy: PEER, name: 'ws6-session-peer' });
    const other = await mintKey({ tenantId: TENANT_B, issuedBy: ISSUER, name: 'ws6-session-xtenant' });
    return [peer.raw, other.raw];
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://t/api/mcp'), {
    fetch: inProcessFetch,
  });
  client = new Client({ name: 'cp-scope-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await cleanup();
}, 30_000);

test('an MCP tool dispatched by the SDK still runs inside its tenant scope', async () => {
  const out = await client.callTool({ name: 'list_datasets', arguments: {} });
  expect(out.isError).toBeFalsy();
  const text = (out.content as { type: string; text: string }[])[0]!.text;
  const parsed = JSON.parse(text) as { items: { slug: string }[] };

  // Non-vacuity: the row genuinely exists and genuinely belongs to the key's tenant, so an empty
  // answer can only mean the read ran unscoped.
  const exists = await runAsSystem('platform-admin', () =>
    db.select().from(datasets).where(eq(datasets.slug, DS_SLUG)),
  );
  expect(exists).toHaveLength(1);
  expect(exists[0]!.tenant_id).toBe(TENANT);

  expect(parsed.items.map((d) => d.slug)).toContain(DS_SLUG);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// SESSION OWNERSHIP — a streamable session belongs to the identity that initialized it.
//
// THE DEFECT (routes/mcp.ts, the `streamable` route). `sessions` was keyed by session id ALONE:
// `resolveCtx` proved WHO was calling, and nothing proved the session was theirs, so any
// authenticated caller presenting a live `mcp-session-id` attached to that session's transport.
//
// Scoped honestly: DB work still ran under `withTenantDb(ctx.tenantId, …)` — the attacker's own
// tenant — so this was never a cross-tenant READ, and ids are `randomUUID()`, so it needs
// disclosure. What it reached was the server→client SSE stream (messages meant for someone else)
// and `DELETE` (destroying their session): takeover/DoS between authenticated callers.
//
// These tests drive the router directly rather than through the SDK client, because the client
// hides the session id and will not send one that is not its own — which is the whole attack.
// ---------------------------------------------------------------------------------------------

const PROTO = '2025-06-18';

async function mcpRaw(
  key: string,
  opts: { method?: string; body?: unknown; sessionId?: string },
): Promise<{ status: number; text: string; sessionId: string | null }> {
  const method = opts.method ?? 'POST';
  const matched = router.match(method, '/api/mcp')!;
  const headers = new Headers({
    // POST on this transport 406s unless BOTH are accepted.
    accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${key}`,
    'mcp-protocol-version': PROTO,
  });
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.sessionId) headers.set('mcp-session-id', opts.sessionId);
  const res = await matched.handler(
    new Request('http://t/api/mcp', {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    ...matched.params,
  );
  return {
    status: res.status,
    text: await res.text(),
    sessionId: res.headers.get('mcp-session-id'),
  };
}

/** Full client-side handshake, so the session is live and reusable exactly as a real client's is. */
async function openSession(key: string): Promise<string> {
  const init = await mcpRaw(key, {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'own', version: '0' } },
    },
  });
  expect(init.status).toBe(200);
  const sid = init.sessionId;
  expect(typeof sid).toBe('string');
  await mcpRaw(key, { sessionId: sid!, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  return sid!;
}

/** `ping` is the cheapest request the SDK server answers itself — no tools, no DB, no fixtures. */
const ping = { jsonrpc: '2.0', id: 42, method: 'ping' } as const;

test('the identity that opened a session can keep using it', async () => {
  const sid = await openSession(apiKey);
  const reuse = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(reuse.status).toBe(200);
  // Non-vacuity: a 200 alone could be an empty stream — the session must actually have ANSWERED.
  expect(reuse.text).toContain('"id":42');
  expect(reuse.text).toContain('"result"');
}, 60_000);

test('a different user in the same tenant cannot attach to another identity\'s session', async () => {
  const sid = await openSession(apiKey);

  const stolen = await mcpRaw(peerKey, { sessionId: sid, body: ping });
  expect(stolen.status).not.toBe(200);
  expect(stolen.text).not.toContain('"result"');

  // …and the refusal did not damage the real owner's session.
  const owner = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(owner.status).toBe(200);
  expect(owner.text).toContain('"id":42');
}, 60_000);

test('the same user arriving under a different tenant cannot attach either', async () => {
  const sid = await openSession(apiKey);

  const crossWorkspace = await mcpRaw(otherTenantKey, { sessionId: sid, body: ping });
  expect(crossWorkspace.status).not.toBe(200);
  expect(crossWorkspace.text).not.toContain('"result"');

  const owner = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(owner.status).toBe(200);
}, 60_000);

test('a non-owner DELETE cannot destroy someone else\'s session', async () => {
  const sid = await openSession(apiKey);

  await mcpRaw(peerKey, { method: 'DELETE', sessionId: sid });

  const owner = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(owner.status).toBe(200);
  expect(owner.text).toContain('"id":42');

  // Control: the OWNER's DELETE does end it, so the assertion above is about ownership and not
  // about DELETE being inert on this transport.
  const ended = await mcpRaw(apiKey, { method: 'DELETE', sessionId: sid });
  expect(ended.status).toBe(200);
  const afterOwnDelete = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(afterOwnDelete.status).not.toBe(200);
}, 60_000);

test('a sibling key — same issuer, same tenant as apiKey — cannot attach to or delete its session', async () => {
  // ⭐ WHY THE FOUR TESTS ABOVE CANNOT COVER THIS. `peerKey` differs from `apiKey` by USER (same
  // tenant, TENANT); `otherTenantKey` differs by TENANT (same user, ISSUER). Each varies exactly
  // one half of the (userId, tenantId) pair `resolveMcpIdentity` used to compare sessions by, so
  // all four of those tests stay GREEN even if `ownerKeyId` were removed from the comparison
  // entirely — a userId or tenantId mismatch alone still refuses them. `siblingKey` is minted by
  // the SAME issuer in the SAME tenant as `apiKey`, so `verifyKey` resolves it to the IDENTICAL
  // (userId, tenantId) pair; only `keyId` distinguishes the two credentials. This is the one case
  // that actually depends on `ownerKeyId` being part of the session-owner key, and the one test in
  // this file that reddens if it is dropped.
  const sid = await openSession(apiKey);

  const stolen = await mcpRaw(siblingKey, { sessionId: sid, body: ping });
  expect(stolen.status).not.toBe(200);
  expect(stolen.text).not.toContain('"result"');

  await mcpRaw(siblingKey, { method: 'DELETE', sessionId: sid });

  // …and neither the failed attach nor the DELETE touched the real owner's session.
  const owner = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(owner.status).toBe(200);
  expect(owner.text).toContain('"id":42');
}, 60_000);

test('an owner mismatch is byte-identical to an unknown session id (no session-id oracle)', async () => {
  const sid = await openSession(apiKey);
  const unknown = randomUUID(); // never minted by anything

  // One caller, one verb, one difference: a LIVE id that is not theirs vs an id that does not
  // exist. If these diverged in status or body, the endpoint would confirm which ids are live.
  for (const method of ['POST', 'DELETE'] as const) {
    const body = method === 'POST' ? ping : undefined;
    const mismatch = await mcpRaw(peerKey, { method, sessionId: sid, body });
    const absent = await mcpRaw(peerKey, { method, sessionId: unknown, body });
    expect(mismatch.status).toBe(absent.status);
    expect(mismatch.text).toBe(absent.text);
    // Non-vacuity: both must genuinely be refusals, not two identical successes.
    expect(mismatch.status).not.toBe(200);
    // …and neither response may echo the id back, which would itself be the oracle.
    expect(mismatch.text).not.toContain(sid);
    expect(mismatch.sessionId).toBe(absent.sessionId);
  }

  const owner = await mcpRaw(apiKey, { sessionId: sid, body: ping });
  expect(owner.status).toBe(200);
}, 60_000);
