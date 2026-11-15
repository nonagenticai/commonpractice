// src/ai/mcp-sdk-server.ts — the official @modelcontextprotocol/sdk Server bound to
// our governed McpHost (SPEC §5A Layer 2, Session 7). This is the protocol engine
// (initialize handshake, capability negotiation, schema-validated request routing);
// routes/mcp.ts drives it over the SDK's Web-standard StreamableHTTP transport so
// external MCP clients (Claude Desktop, other platform agents) connect via the
// standard transport. The host stays the SINGLE source of truth + audit point — these
// handlers only translate SDK request/response shapes onto mcpHost calls.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpHost, type McpAuthContext } from './mcp-server';
import { withTenantDb } from '../db/client';

export const MCP_SERVER_INFO = { name: 'commonpractice-mcp', version: '0.1.0' };
const BYPASS_USER = '00000000-0000-0000-0000-000000000000';

/** The per-request handler `extra` carries authInfo whose `extra` field we populate
 *  in routes/mcp.ts with the resolved identity. Recover the McpAuthContext from it.
 *
 *  ⚠️ `authInfo.extra.scopes` is OURS and is NOT `authInfo.scopes`. The latter is the SDK's own
 *  OAuth-shaped field, which `authInfoFor` fills with `[]` purely to satisfy the AuthInfo type;
 *  reading THAT one here would hand every caller an empty grant and deny the entire surface. */
function ctxFromExtra(extra: unknown): McpAuthContext {
  const a = (extra as { authInfo?: { extra?: Record<string, unknown> } })?.authInfo
    ?.extra;
  return {
    userId: (a?.userId as string) ?? BYPASS_USER,
    tenantId: (a?.tenantId as string | null) ?? null,
    roles: (a?.roles as string[]) ?? [],
    keyId: (a?.keyId as string | null | undefined) ?? null,
    // ⛔⛔ THE MISSING `?? []` IS THE POINT. Do NOT "tidy" this line by giving it a default the
    // way the three above have one. `undefined` here means NO SCOPED CREDENTIAL WAS PRESENTED —
    // the agent-JWT copilot and the AUTH_BYPASS dev path both arrive with no `scopes` in
    // `extra` — and `hasScope(undefined, …)` is TRUE, which is what keeps them working. `[]` is
    // a REAL, DELIBERATE, EMPTY grant that denies EVERYTHING, so defaulting to it would refuse
    // every tool, resource and prompt to exactly the callers that never had a key to scope.
    // The two values are opposite, not equivalent. See `hasScope` in ai/mcp/scopes.ts.
    scopes: a?.scopes as string[] | null | undefined,
  };
}

/**
 * Recover the caller's identity from `extra` AND re-establish their DB tenant scope for the
 * handler's whole body.
 *
 * ⛔ WHY THE SCOPE IS RE-ESTABLISHED HERE AND NOT (ONLY) AT THE ROUTE. routes/mcp.ts wraps
 * `transport.handleRequest(...)` in `withTenantDb(ctx.tenantId, …)`, which reads as sufficient and
 * is not. The SDK's `handlePostRequest` calls `this.onmessage?.(message, …)` WITHOUT awaiting and
 * then immediately returns the SSE `Response`
 * (@modelcontextprotocol/sdk webStandardStreamableHttp.js:552,557); `Protocol`'s onmessage hop
 * calls `this._onrequest(message, extra)` — also without awaiting (shared/protocol.js:237). The
 * handler below is therefore dispatched two microtask hops AFTER `withTenantDb`'s `finally` has
 * blanked `app.current_tenant` on the reserved connection and released it back to the pool. Every
 * tool ran on a released, blanked connection: under the production `cp_app` role (NOBYPASSRLS)
 * that is silent 0-row reads and 42501 writes. `list_datasets` reported an EMPTY dataset library
 * with no error anywhere, because it carries its own `WHERE tenant_id = …` and an owner DSN
 * therefore answers it correctly no matter what the GUC says.
 *
 * MCP is also the one surface where the route CANNOT be the fix: the dispatch point is inside the
 * SDK. But the identity is already threaded through `AuthInfo.extra` (routes/mcp.ts's
 * `authInfoFor`), so each handler can establish its own scope from data it already holds — which
 * depends on no AsyncLocalStorage inheritance and survives any future change to how the SDK
 * schedules handlers. The sibling legacy route `/api/mcp/jsonrpc` stays correct on its own terms:
 * it awaits inside `withTenantDb`.
 *
 * `withTenantDb(null, fn)` is a plain passthrough, so an unresolved tenant keeps today's behaviour.
 */
function scoped<T>(
  extra: unknown,
  fn: (ctx: McpAuthContext) => Promise<T>,
): Promise<T> {
  const ctx = ctxFromExtra(extra);
  return withTenantDb(ctx.tenantId, () => fn(ctx));
}

/** Build a fresh SDK Server wired to mcpHost. One per session (the transport keeps
 *  the initialized state in-memory; routes/mcp.ts maps sessions → server+transport). */
export function createMcpSdkServer(): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, (_req, extra) =>
    scoped(extra, async (ctx) => {
      const tools = await mcpHost.listTools(ctx);
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
    scoped(extra, async (ctx) => {
      const out = await mcpHost.callTool(req.params.name, req.params.arguments ?? {}, ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify(out.result) }],
        isError: out.isError,
      };
    }),
  );

  server.setRequestHandler(ListResourcesRequestSchema, (_req, extra) =>
    scoped(extra, async (ctx) => ({ resources: await mcpHost.listResources(ctx) })),
  );

  server.setRequestHandler(ReadResourceRequestSchema, (req, extra) =>
    scoped(extra, async (ctx) => ({
      contents: [await mcpHost.readResource(req.params.uri, ctx)],
    })),
  );

  server.setRequestHandler(ListPromptsRequestSchema, (_req, extra) =>
    scoped(extra, async (ctx) => ({ prompts: await mcpHost.listPrompts(ctx) })),
  );

  server.setRequestHandler(GetPromptRequestSchema, (req, extra) =>
    scoped(extra, async (ctx) => ({
      messages: (await mcpHost.getPrompt(req.params.name, ctx)).messages,
    })),
  );

  return server;
}
