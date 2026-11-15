// src/routes/mcp.ts — the external MCP endpoint (SPEC §5A Layer 2).
//   /api/mcp           — the OFFICIAL @modelcontextprotocol/sdk Streamable HTTP
//                        transport (Web-standard variant: takes a Web Request, returns
//                        a Web Response — runs natively on Bun). POST drives requests,
//                        GET opens the server→client SSE stream, DELETE ends a session.
//   /api/mcp/jsonrpc   — the prior hand-rolled JSON-RPC 2.0 mapping, retained as a
//                        simple fallback for clients that don't speak the streamable
//                        transport (and as a stable contract-test seam).
// Both front the SAME governed McpHost (tools + resources + prompts, authed + audited
// + tenant-scoped), so in-process agent, JSON-RPC, and SDK clients share one surface.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { config, DEMO_TENANT_ID } from '../config';
import { withTenantDb } from '../db/client';
import { homeTenantOf } from '../middleware/tenant';
import { assertTenantNotSuspended } from '../middleware/tenant-status-gate';
import { verifyAgentToken } from '../services/agent-session';
import { isMcpApiKey, verifyKey } from '../services/mcp-api-key';
import { mcpHost, type McpAuthContext } from '../ai/mcp-server';
import { createMcpSdkServer, MCP_SERVER_INFO } from '../ai/mcp-sdk-server';
import { jsonResponse, readJson, route, HttpError } from '../utils/http';
import type { Router } from '../utils/router';

const BYPASS_USER = '00000000-0000-0000-0000-000000000000';
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Resolve the calling identity, then refuse a SUSPENDED workspace.
 *
 * ⛔ THE SUSPENSION CHECK IS HERE, ONCE, AND NOT AT THE THREE RETURNS BELOW. None of the three
 * credentials this endpoint accepts is a Keycloak JWT, so NOTHING on this path ever reaches
 * `validateAuth` — which means `middleware/tenant-status-gate.ts` is not applied to it by the
 * browser gate at all. Without this line a suspended tenant loses the SPA and keeps the entire MCP
 * tool surface (flow edits, dataset/ontology reads, block authoring) through an API key that was
 * issued before the suspension. `resolveCtx` is the single chokepoint every one of those routes
 * (`streamable` for POST/GET/DELETE `/api/mcp`, and `jsonrpc`) already funnels through, and gating
 * the identity rather than each transport is what stops a fourth credential or a third route from
 * being added later without the check.
 *
 * The AUTH_BYPASS branch is gated too, despite minting `roles: ['super_admin']`. The super_admin
 * exemption in `assertTenantActive` exists so the OPERATOR CONSOLE stays reachable and a suspension
 * can be undone; `/api/mcp` is not the operator console — it is tenant data access — and
 * AUTH_BYPASS is dev/LAN-only, where a suspended tenant behaving like a suspended tenant is exactly
 * what you want to be able to reproduce.
 *
 * Identity resolution itself is unchanged and lives in `resolveMcpIdentity`. Three accepted
 * credentials, in order:
 *   1. an issued `cp_mcp_…` API key (EXTERNAL clients) → acts as the issuer within the
 *      key's tenant, and is ENFORCED against the key's `scopes` at every primitive. The key's
 *      `keyId` and `scopes` are carried on `McpAuthContext` from here, threaded through
 *      `authInfoFor` → `ctxFromExtra`, and checked in `ai/mcp-server.ts`: `tools/*` against
 *      `tools:read`/`tools:write` per `TOOL_SCOPES`, `resources/*` and `prompts/*` against the
 *      coarse `resources` / `prompts` grants. Deny-by-default — an unmapped tool resolves to
 *      `tools:write`, the restrictive answer. LIST calls FILTER (an ungranted primitive is
 *      simply absent); `tools/call` returns an MCP tool-error result carrying
 *      `mcp_scope_denied` + the required scope; `resources/read` and `prompts/get` answer
 *      exactly as they do for an unknown uri/name, so neither becomes an existence oracle.
 *      Every call is still audited, refusals included (`result: 'Denied'`).
 *      ⚠️ Enforcement reaches ONLY this credential. Branches 2 and 3 below set no `scopes` at
 *      all, and `hasScope(undefined, …)` is true — see `ai/mcp/scopes.ts`.
 *   2. a browser-issued agent JWT (the in-app co-pilot) → the tenant baked into the token's `tid`
 *      at mint time, fail-closed (401 `agent_token_no_tenant` when it carries none).
 *   3. AUTH_BYPASS (LAN/dev only) — the ONE path with genuinely no claim to derive from, and so the
 *      only remaining `homeTenantOf` caller here.
 */
async function resolveCtx(req: Request): Promise<McpAuthContext> {
  const ctx = await resolveMcpIdentity(req);
  await assertTenantNotSuspended(ctx.tenantId);
  return ctx;
}

/** Identity only — see `resolveCtx` above, which is what callers use. */
async function resolveMcpIdentity(req: Request): Promise<McpAuthContext> {
  const auth = req.headers.get('Authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  if (isMcpApiKey(bearer)) {
    const key = await verifyKey(bearer!); // throws Unauthorized on miss/revoked/expired
    // ⛔ `keyId` AND `scopes` BOTH HAVE TO LEAVE THIS FUNCTION, and dropping either was a live
    // defect rather than a tidiness issue:
    //   · `scopes` was minted, stored, and carried all the way to `VerifiedKey` — and then
    //     discarded HERE. Nothing downstream could enforce what it never received, so a key
    //     minted "read-only" held full write authority over flows, blocks and templates.
    //   · `keyId` is the only thing that distinguishes two keys. `VerifiedKey.userId` is
    //     `issued_by` — the ISSUING user — so every key one admin mints in one tenant resolves
    //     to an identical (userId, tenantId) pair. Without this the session registry below
    //     cannot tell one key's session from another's, and either can DELETE the other's.
    // This is the ONLY branch that sets them. The two below leave both absent, deliberately.
    return {
      userId: key.userId,
      tenantId: key.tenantId,
      roles: [],
      keyId: key.keyId,
      scopes: key.scopes,
    };
  }

  // The agent-session token DOES carry the user's realm roles — they are baked in at mint time
  // (routes/agent.ts) precisely so the developer-gated MCP authoring tools work. Discarding them
  // here made every one of those tools (create_block, save_block_version, publish_block,
  // lint_block, propose_block_draft, …) 403 over the MCP transport: fail-closed, but the whole
  // feature was unreachable.
  //
  // ⚠️ ONLY THE VERIFY IS INSIDE THE `try`, AND THAT NARROWING IS DELIBERATE. The catch below is
  // the AUTH_BYPASS fallback, so anything thrown inside it is silently converted into a dev
  // super_admin. The `tid` refusal must NOT be — it is an authorization decision about a token that
  // verified perfectly well, not a failure to authenticate — so it is raised after the try closes.
  let identity: Awaited<ReturnType<typeof verifyAgentToken>>;
  try {
    identity = await verifyAgentToken(req);
  } catch (err) {
    if (config.authBypass) {
      return {
        userId: BYPASS_USER,
        // ⛔ THE LAST `homeTenantOf` ON THIS PATH, AND IT STAYS. AUTH_BYPASS is the one credential
        // that presents no claim and no token, so there is nothing else to derive a workspace from;
        // it is LAN/dev-only and the fixed BYPASS_USER's home tenant is exactly the intent.
        tenantId: (await homeTenantOf(BYPASS_USER)) ?? DEMO_TENANT_ID,
        // Dev-only bypass mirrors the auth middleware's super_admin default.
        roles: ['super_admin'],
        // ⛔ NO `scopes` KEY, AND NO `scopes: []`. AUTH_BYPASS presents no credential to scope,
        // so the field stays absent → `hasScope(undefined, …)` is true → full access, which is
        // the whole point of the bypass. Writing `[]` here would deny every primitive on the
        // dev/LAN path and read as "scopes broke everything".
      };
    }
    throw err;
  }
  // ⛔ FAIL CLOSED HERE, IN `resolveMcpIdentity`, AND NOT DOWNSTREAM. `McpAuthContext.tenantId` is
  // typed `string | null` (ai/mcp-server.ts), so a null tenant does not break any type further in —
  // it simply flows into `withTenantDb(null, …)`, which binds NO GUC, and into the audit rows. The
  // compiler will not catch it for us, which is precisely why the refusal belongs at the identity
  // chokepoint every transport already funnels through rather than at any one of them.
  //
  // The tenant is the token's `tid`, not `homeTenantOf(userId)`. That column is written once on
  // first touch and never reconciled against a later Keycloak claim, so the MCP transport was
  // serving a different workspace than the browser for any user whose claim had since moved.
  if (!identity.tenantId) {
    throw new HttpError(
      401,
      'agent_token_no_tenant',
      'This copilot session predates workspace-scoped tokens. Reload to start a new one.',
    );
  }
  // Same as the bypass branch: an agent JWT is not a scoped credential, so no `scopes` field is
  // set and the in-app copilot's authority is unchanged by scope enforcement. Its authorization
  // is `identity.roles` (the developer-gated authoring tools), which is orthogonal to scopes.
  return { userId: identity.userId, tenantId: identity.tenantId, roles: identity.roles };
}

/** The identity is threaded to the SDK request handlers via AuthInfo.extra (read back
 *  by ctxFromExtra in mcp-sdk-server.ts). token/clientId/scopes satisfy the type.
 *
 *  ⚠️ TWO FIELDS ARE NAMED `scopes` HERE AND THEY ARE NOT THE SAME THING.
 *    · the TOP-LEVEL one is the SDK's OAuth-shaped `AuthInfo.scopes`. It stays `[]`: nothing in
 *      this codebase reads it, our grants are not OAuth scopes, and changing it would be a
 *      protocol-surface change with no enforcement value.
 *    · `extra.scopes` is OURS, and is the credential's real grant. It is passed through
 *      UNCOALESCED — `ctx.scopes` is `undefined` for the agent-JWT and AUTH_BYPASS callers and
 *      must ARRIVE as `undefined`, because `hasScope` treats absent as "not a scoped credential"
 *      (full access) and `[]` as an explicit empty grant (deny all). Never write `?? []` here. */
function authInfoFor(ctx: McpAuthContext) {
  return {
    token: 'agent',
    clientId: ctx.userId,
    scopes: [] as string[],
    extra: {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      roles: ctx.roles,
      keyId: ctx.keyId ?? null,
      scopes: ctx.scopes,
    },
  };
}

// ---- Streamable HTTP (official SDK transport) — session registry ----
// Stateful mode: `initialize` mints a session id; the transport keeps that session's
// state in-memory. We map session id → {transport, server, owner} and route later requests.
//
// ⛔ THE OWNER IS PART OF THE KEY, NOT JUST THE SESSION ID. `resolveCtx` proves WHO is calling; it
// says nothing about whether the session id they present is THEIRS. Without `ownerUserId` /
// `ownerTenantId` below, any authenticated caller who learns a live session id attaches to that
// session's transport.
//
// Scoped honestly, because it is narrower than it first reads: this is NOT a cross-tenant data
// read. Every handler still runs inside `withTenantDb(ctx.tenantId, …)` — the ATTACKER's tenant —
// so RLS-scoped reads stay caller-scoped, and ids are `randomUUID()`, so it takes disclosure to
// exploit. What it does reach is the server→client SSE stream (a caller attaching to a stream
// carrying another identity's messages) and `DELETE`, which destroys someone else's session.
// Session takeover and DoS between authenticated callers, not a data leak.
//
// THE OWNER IS THE (userId, tenantId, keyId) TRIPLE — the same values `authInfoFor` threads into
// the SDK handlers — and all three are load-bearing:
//   · tenantId alone is too coarse. Two users in one workspace are distinct identities, and the
//     stream being attached to carries one of them specifically.
//   · userId alone is too coarse in the other direction. The same person legitimately holds
//     several contexts here — a `cp_mcp_…` key acts as its ISSUER but is pinned to the key row's
//     tenant, while an agent JWT carries that same user under whatever tenant its `tid` was minted
//     with. A session's transport state, and every tool it has dispatched, belongs to one
//     workspace; the same human arriving under a different one is a different owner.
//   · ⛔ AND THE (userId, tenantId) PAIR ALONE IS STILL NOT A CREDENTIAL — IT IS AN IDENTITY.
//     For a key caller `ctx.userId` is `VerifiedKey.userId`, which `services/mcp-api-key.ts` sets
//     to the key row's `issued_by`: the ISSUING user, not the key. So two DISTINCT `cp_mcp_…`
//     keys minted by the same admin in the same tenant — the ordinary case, e.g. one per external
//     client, or a replacement issued during a rotation — produce an IDENTICAL pair and each can
//     attach to, read the SSE stream of, and DELETE the other's session. Since scopes are now
//     enforced per key, that pair would also let a read-only key ride a read-write key's session.
//     `ownerKeyId` closes it: the credential, not just the human behind it, is part of the key.
//     Non-key callers (agent JWT, AUTH_BYPASS) carry no keyId and record `null`, which matches
//     `null` — their behaviour is byte-for-byte unchanged.
interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  /** The identity that ran `initialize` on this session. Compared on every later request. */
  ownerUserId: string;
  /** `McpAuthContext.tenantId` is `string | null`, so this is too — null only matches null. */
  ownerTenantId: string | null;
  /** The `mcp_api_keys` row that opened the session, or `null` for the two non-key credentials.
   *  Normalised to `null` at BOTH the write and the compare (`ctx.keyId ?? null`) so an absent
   *  field and an explicit null are the same owner and cannot drift into a silent mismatch. */
  ownerKeyId: string | null;
}
const sessions = new Map<string, McpSession>();

const streamable = route(async (req) => {
  const ctx = await resolveCtx(req); // reads headers only — body stays unconsumed
  const sessionId = req.headers.get('mcp-session-id') ?? undefined;

  // MCP auth (API key / agent token) is NOT a Keycloak JWT, so server.ts's peekEffectiveTenant
  // resolves null and sets NO `app.current_tenant` GUC. Bind it here so the SDK tool handlers'
  // RLS-scoped DB work (flow edits, dataset/ontology reads, block authoring) is tenant-scoped rather
  // than running unscoped under cp_app (silent 0-row reads / 42501 writes).
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (
    existing &&
    existing.ownerUserId === ctx.userId &&
    existing.ownerTenantId === ctx.tenantId &&
    existing.ownerKeyId === (ctx.keyId ?? null)
  ) {
    const { transport } = existing;
    return withTenantDb(ctx.tenantId, () =>
      transport.handleRequest(req, { authInfo: authInfoFor(ctx) }),
    );
  }

  // ⛔ A MISMATCH DELIBERATELY FALLS THROUGH TO THE UNKNOWN-SESSION PATH BELOW RATHER THAN
  // RETURNING ITS OWN ERROR. If "that session exists but is not yours" were distinguishable from
  // "no such session", this endpoint would be a session-id ORACLE: an attacker who cannot use a
  // guessed or leaked id could still confirm it is live, and enumerate. Reusing the branch — the
  // same code, not a hand-copied status and message that can drift apart later — makes the two
  // cases identical by construction: a fresh, uninitialised transport answers the request, and it
  // refuses a non-`initialize` request carrying an unrecognised id exactly as it always has.
  // It also means a mismatched `DELETE` cannot touch the real session, since it never reaches it.
  //
  // No new error code, so no new label is needed in the eight `frontend/messages/*.json` locales.

  // No (known, owned) session → a fresh transport+server. On `initialize` the transport mints
  // a session id and fires onsessioninitialized; non-initialize requests get a proper
  // protocol error from the transport itself.
  const server = createMcpSdkServer();
  let session: McpSession;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, session);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  // The ctx that reaches `initialize` IS the ctx that owns the session: `onsessioninitialized`
  // fires inside this very request's `handleRequest`, so the pair recorded here is the caller who
  // minted the id, never a later one.
  session = {
    transport,
    server,
    ownerUserId: ctx.userId,
    ownerTenantId: ctx.tenantId,
    ownerKeyId: ctx.keyId ?? null,
  };
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return withTenantDb(ctx.tenantId, () =>
    transport.handleRequest(req, { authInfo: authInfoFor(ctx) }),
  );
});

// ---- the legacy hand-rolled JSON-RPC 2.0 mapping (fallback at /api/mcp/jsonrpc) ----
const SERVER_INFO = MCP_SERVER_INFO;
const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
function rpcResult(id: unknown, result: unknown) {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

const jsonrpc = route(async (req) => {
  const ctx = await resolveCtx(req);
  const body = rpcSchema.parse(await readJson(req));
  const { id, method, params = {} } = body;

  // See `streamable` above: bind the tenant GUC so mcpHost's RLS-scoped reads/writes are scoped.
  return withTenantDb(ctx.tenantId, async () => {
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
    case 'ping':
      return rpcResult(id, {});

    case 'tools/list': {
      const tools = await mcpHost.listTools(ctx);
      return rpcResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    case 'tools/call': {
      const name = String(params.name ?? '');
      const out = await mcpHost.callTool(name, params.arguments ?? {}, ctx);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out.result) }],
        isError: out.isError,
      });
    }

    case 'resources/list': {
      const resources = await mcpHost.listResources(ctx);
      return rpcResult(id, { resources });
    }
    case 'resources/read': {
      const uri = String(params.uri ?? '');
      const contents = await mcpHost.readResource(uri, ctx);
      return rpcResult(id, { contents: [contents] });
    }

    case 'prompts/list': {
      const prompts = await mcpHost.listPrompts(ctx);
      return rpcResult(id, { prompts });
    }
    case 'prompts/get': {
      const name = String(params.name ?? '');
      const prompt = await mcpHost.getPrompt(name, ctx);
      return rpcResult(id, { messages: prompt.messages });
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
  });
});

export function registerMcpRoutes(router: Router): void {
  // Official SDK Streamable HTTP transport on the canonical path (POST/GET/DELETE).
  router.add('POST', '/api/mcp', streamable);
  router.add('GET', '/api/mcp', streamable);
  router.add('DELETE', '/api/mcp', streamable);
  // Hand-rolled JSON-RPC fallback.
  router.add('POST', '/api/mcp/jsonrpc', jsonrpc);
}
