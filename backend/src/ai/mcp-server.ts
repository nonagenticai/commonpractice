// src/ai/mcp-server.ts — the in-process MCP host: the platform's governed AI
// contract (SPEC §5A Layer 2). It exposes all three MCP primitives — tools,
// resources, prompts — computed from the DB at request time, every call tenant-
// scoped + AUDITED. The agent loop (ai/agent.ts) talks to this object directly; the
// external streamable-HTTP endpoint (routes/mcp.ts, Stage F) wraps the SAME host via
// @modelcontextprotocol/sdk, so in-process and over-the-wire share one implementation.
//
// `tools/list` is exactly PLATFORM_TOOLS. Customer-authored extensions are BLOCKS
// (building_blocks + block_versions), authored over MCP and run in the sandbox; the
// old DB-defined-tools table was dropped in 0052 — it had no executor, so a row in it
// only ever advertised a tool to the LLM that `tools/call` would then refuse.
import { db as defaultDb } from '../db/client';
import { recordAudit } from '../host/audit-service';
import {
  PLATFORM_TOOLS,
  getPlatformTool,
  type ToolSurface,
  type McpToolContext,
} from './mcp/tools';
import {
  listResources as listResourcesImpl,
  readResource as readResourceImpl,
  type ResourceDef,
  type ResourceContents,
} from './mcp/resources';
import {
  listPrompts as listPromptsImpl,
  getPrompt as getPromptImpl,
  getSystemPromptText as getSystemPromptTextImpl,
  type PromptDef,
  type PromptGetResult,
} from './mcp/prompts';
import {
  canCallTool,
  hasScope,
  scopeDeniedResult,
  scopeForTool,
  type ToolScope,
} from './mcp/scopes';
import { notFound } from '../utils/http';

type Db = typeof defaultDb;

export interface McpAuthContext {
  userId: string;
  tenantId: string | null;
  roles: string[];
  /** Phase 3.4: optional flow/challenge context threaded into tool calls for ontology
   *  (industry × department) cell auto-resolution. */
  flowId?: string | null;
  challengeId?: string | null;
  /** The `mcp_api_keys` row this call was authenticated with, when it was authenticated with
   *  one at all. `null`/absent for the agent-JWT and AUTH_BYPASS credentials, neither of which
   *  is a key. routes/mcp.ts compares it to decide whether a presented session id is the
   *  caller's own — `VerifiedKey.userId` is the ISSUING user, so two keys minted by one admin in
   *  one tenant are otherwise the same identity and can delete each other's sessions. */
  keyId?: string | null;
  /**
   * ⛔⛔ THE THREE STATES OF THIS FIELD ARE NOT INTERCHANGEABLE, AND `?` IS LOAD-BEARING.
   *
   *   · `undefined` (field absent) — NOT A SCOPED CREDENTIAL. The in-process copilot
   *     (`ai/agent.ts:248` builds this object with no `scopes`) and the AUTH_BYPASS dev path
   *     both land here, and both must keep full access. Making this field REQUIRED would force
   *     every such construction site to write a value, and the obvious value to write is `[]` —
   *     which denies everything and takes the whole in-app copilot down with it.
   *   · `[]` — a REAL, DELIBERATE, EMPTY grant a minter wrote down. Denies everything.
   *   · a populated array — the key's grant; `hasScope` applies the one-level parent rule, so a
   *     legacy `['tools']` key still satisfies both `tools:read` and `tools:write`.
   *
   * See the long note on `hasScope` (ai/mcp/scopes.ts) — do not collapse the first two cases.
   */
  scopes?: string[] | null;
}

export interface McpToolListItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  surface: ToolSurface;
}

export interface ToolCallResult {
  result: unknown;
  isError: boolean;
}

/** A short, non-reversible fingerprint of a tool input for the audit trail. */
function inputHash(input: unknown): string {
  try {
    return Bun.hash(JSON.stringify(input ?? null)).toString(16);
  } catch {
    return '0';
  }
}

export class McpHost {
  constructor(private readonly db: Db = defaultDb) {}

  /** tools/list — the in-code platform tools. Every tool listed here is executable by
   *  `callTool`; nothing is advertised to the model that cannot then be run.
   *
   *  ⛔ THE FILTER IS WHAT KEEPS THAT SENTENCE TRUE UNDER SCOPES, and it is a filter rather
   *  than a refusal on purpose. A read-only key that could still SEE `delete_template` would be
   *  handed a list of calls `callTool` then refuses — the model burns turns on them, and the
   *  list itself becomes an inventory of what the caller is missing. Filtering makes
   *  deny-by-default invisible: the key simply has a smaller surface. `canCallTool` resolves an
   *  UNKNOWN tool name to `tools:write`, so a tool added to PLATFORM_TOOLS and forgotten in
   *  TOOL_SCOPES disappears from a read-only key's list rather than being waved through. */
  async listTools(ctx: McpAuthContext): Promise<McpToolListItem[]> {
    return PLATFORM_TOOLS.filter((t) => canCallTool(ctx.scopes, t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      surface: t.surface,
    }));
  }

  /** tools/call — execute a backend tool (or a frontend tool's HEADLESS fallback).
   *  Frontend tools, in a browser session, are NOT routed here — the agent loop
   *  emits a frontend-tool-call and the driver applies them live. Every call audits,
   *  INCLUDING a scope refusal (see below). */
  async callTool(
    name: string,
    input: unknown,
    ctx: McpAuthContext,
  ): Promise<ToolCallResult> {
    const tool = getPlatformTool(name);
    const toolCtx: McpToolContext = {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      roles: ctx.roles,
      db: this.db,
      flowId: ctx.flowId ?? null,
      challengeId: ctx.challengeId ?? null,
    };
    let isError = false;
    /** Set only on a scope refusal — separates "denied" from "the handler threw" in the audit. */
    let deniedScope: ToolScope | null = null;
    let result: unknown;
    try {
      // ⛔ THE CHECK IS INSIDE THE `try`, AND BEFORE THE `tool` BRANCH, FOR TWO REASONS.
      //   1. INSIDE — everything that leaves this block falls through to the single recordAudit
      //      below. A refusal that returned early would be the one MCP call in the system with no
      //      audit row, which is exactly the call an operator most needs to see.
      //   2. BEFORE — `scopeForTool` answers `tools:write` for an unrecognised name, so a
      //      read-only key gets the identical refusal for a real write tool and for a name that
      //      does not exist. Checking after the lookup would instead answer `tool_not_found`
      //      first and turn this endpoint into a tool-name ORACLE for under-scoped keys.
      //
      // ⛔ AND IT IS NOT `throw`n. The catch below stringifies to `{ error: err.message }`, which
      // would flatten the refusal to a bare human string and DROP the required scope — the one
      // field a client needs to know which grant it is missing. `scopeDeniedResult` is the
      // machine-readable payload, and it is an MCP tool-error RESULT, never an HTTP 403: see the
      // note at the bottom of ai/mcp/scopes.ts for why a 403 here would red the frontend's
      // backend-contract test until eight locale catalogs had been updated.
      const required = scopeForTool(name);
      if (!hasScope(ctx.scopes, required)) {
        deniedScope = required;
        isError = true;
        result = scopeDeniedResult(required);
      } else if (tool) {
        result = await tool.handler(input, toolCtx);
      } else {
        throw notFound('tool_not_found', `No tool '${name}'`);
      }
    } catch (err) {
      isError = true;
      result = { error: err instanceof Error ? err.message : String(err) };
    }

    await recordAudit(
      {
        actorId: ctx.userId,
        action: 'mcp.tool_call',
        category: 'system',
        targetType: 'tool',
        targetId: name,
        // Same action + target as an allowed call, so a scope refusal is greppable in the same
        // stream as the calls it sits beside. Audit strings are free text and unlocalized —
        // nothing scrapes them into the frontend catalogs.
        result: deniedScope ? 'Denied' : isError ? 'Error' : 'OK',
        resultTone: deniedScope ? 'warn' : isError ? 'error' : 'ok',
        metadata: {
          inputHash: inputHash(input),
          tenantId: ctx.tenantId,
          ...(deniedScope ? { requiredScope: deniedScope } : {}),
        },
      },
      this.db,
    );

    return { result, isError };
  }

  // ---- resources ----
  //
  // `resources` has no read/write split: both entry points below are read-only surfaces, so the
  // single coarse scope is the whole grant. A future `resources:read` inherits `hasScope`'s
  // generic parent rule without any change here.

  /** resources/list — FILTERED, not refused, for the same reason as `listTools`: an ungranted
   *  caller sees an empty library rather than a list it may not touch. */
  async listResources(ctx: McpAuthContext): Promise<ResourceDef[]> {
    if (!hasScope(ctx.scopes, 'resources')) return [];
    return listResourcesImpl(this.db, ctx.tenantId);
  }

  async readResource(uri: string, ctx: McpAuthContext): Promise<ResourceContents> {
    // ⛔ A REFUSAL HERE IS THE *IDENTICAL* ANSWER TO AN UNKNOWN URI — same helper, same code, same
    // message string, built from the same `uri`. That is the no-oracle doctrine already written
    // at routes/mcp.ts's session-mismatch branch: if "exists but not granted to you" were
    // distinguishable from "no such resource", an under-scoped key could enumerate the tenant's
    // resource library without being able to read a byte of it. It also reuses an EXISTING code,
    // so no new label is needed in the eight frontend/messages/*.json locales — and deliberately
    // not a 403, which is the shape the frontend contract test scrapes.
    if (!hasScope(ctx.scopes, 'resources')) {
      await recordAudit(
        {
          actorId: ctx.userId,
          action: 'mcp.resource_read',
          category: 'system',
          targetType: 'resource',
          targetId: uri,
          result: 'Denied',
          resultTone: 'warn',
          metadata: { tenantId: ctx.tenantId, requiredScope: 'resources' },
        },
        this.db,
      );
      throw notFound('resource_not_found', `No resource '${uri}'`);
    }
    const contents = await readResourceImpl(uri, this.db, ctx.tenantId);
    await recordAudit(
      {
        actorId: ctx.userId,
        action: 'mcp.resource_read',
        category: 'system',
        targetType: 'resource',
        targetId: uri,
        result: contents ? 'OK' : 'Not found',
        resultTone: contents ? 'ok' : 'warn',
        metadata: { tenantId: ctx.tenantId },
      },
      this.db,
    );
    if (!contents) throw notFound('resource_not_found', `No resource '${uri}'`);
    return contents;
  }

  // ---- prompts ----

  /** prompts/list — FILTERED, exactly as `listTools` / `listResources`. */
  async listPrompts(ctx: McpAuthContext): Promise<PromptDef[]> {
    if (!hasScope(ctx.scopes, 'prompts')) return [];
    return listPromptsImpl({ tenantId: ctx.tenantId }, this.db);
  }

  async getPrompt(
    name: string,
    ctx: McpAuthContext,
    locale = 'en',
  ): Promise<PromptGetResult> {
    // Same no-oracle refusal as `readResource` above: byte-identical to the unknown-name answer.
    if (!hasScope(ctx.scopes, 'prompts')) {
      await recordAudit(
        {
          actorId: ctx.userId,
          action: 'mcp.prompt_get',
          category: 'system',
          targetType: 'prompt',
          targetId: name,
          result: 'Denied',
          resultTone: 'warn',
          metadata: { locale, tenantId: ctx.tenantId, requiredScope: 'prompts' },
        },
        this.db,
      );
      throw notFound('prompt_not_found', `No prompt '${name}'`);
    }
    const prompt = await getPromptImpl(name, { locale, tenantId: ctx.tenantId }, this.db);
    await recordAudit(
      {
        actorId: ctx.userId,
        action: 'mcp.prompt_get',
        category: 'system',
        targetType: 'prompt',
        targetId: name,
        result: prompt ? 'OK' : 'Not found',
        resultTone: prompt ? 'ok' : 'warn',
        metadata: { locale, tenantId: ctx.tenantId },
      },
      this.db,
    );
    if (!prompt) throw notFound('prompt_not_found', `No prompt '${name}'`);
    return prompt;
  }

  /** The agent loop's system prompt (resolved from mcp_prompts; never throws). `name`
   *  selects the seeded prompt — `agent.system` (flow copilot) or `agent.block_authoring`.
   *
   *  ⛔ DELIBERATELY NOT SCOPE-GATED, and that is not an omission. This is not an MCP method:
   *  it is reachable from no transport — neither `routes/mcp.ts`'s SDK handlers nor its
   *  `/api/mcp/jsonrpc` switch dispatches to it — and its only caller is `ai/agent.ts`, which
   *  holds this host in-process and carries no `scopes` at all. Gating it would refuse nobody
   *  and could only ever break the copilot's own prompt resolution. */
  async getSystemPromptText(
    ctx: McpAuthContext,
    locale = 'en',
    name = 'agent.system',
  ): Promise<string> {
    return getSystemPromptTextImpl({ locale, tenantId: ctx.tenantId }, this.db, name);
  }
}

export const mcpHost = new McpHost();
