// src/ai/mcp/scopes.ts — the MCP scope vocabulary and the tool→scope map. This file is
// VOCABULARY ONLY: it holds no DB access, no HTTP, and deliberately no imports, so both the
// admin mint route and the MCP host can depend on it without dragging the tool catalogue (and
// its db/exec/blocks import graph) into a route module, and without any import cycle.
//
// ⛔ WHY THIS EXISTS: `mcp_api_keys.scopes` has been minted, stored, carried through
// `verifyKey` → `VerifiedKey.scopes` and… dropped. `routes/mcp.ts resolveMcpIdentity` returns
// `{ userId, tenantId, roles: [] }` and never puts the scopes on `McpAuthContext`, and no
// authorization site anywhere in the tree reads them. A key minted "read-only" therefore had
// full write authority over flows, blocks and templates. The decision is to ENFORCE, and to
// DENY BY DEFAULT: an unrecognised tool, and an unrecognised scope, resolve to the most
// restrictive answer, never to "unguarded".
//
// ⭐ WHY DENY-BY-DEFAULT IS SAFE TO SHIP NOW rather than behind an audit/observe phase.
// Measured read-only against live prod: `mcp_api_keys` holds THREE rows, TWO of them revoked,
// and the single active key has `last_used_at = NULL` and the full default scopes
// `['tools','resources','prompts']`. So there is no traffic to break: every key that could be
// presented today carries the parent `tools` scope, which (see the hierarchy below) satisfies
// both `tools:read` and `tools:write`. This change denies nobody who exists.

// ---- the vocabulary ----------------------------------------------------------------------
//
// EXTENDED ADDITIVELY, NEVER NARROWED. `DEFAULT_SCOPES` (services/mcp-api-key.ts) and the
// `scopes` column default (db/schema.ts) are `['tools','resources','prompts']`, and both stay
// exactly that. `tools:read` / `tools:write` are NEW, FINER grants that a minter may choose
// instead of the coarse `tools`; every already-issued key keeps `tools` and therefore loses
// nothing. `resources` and `prompts` are unchanged — no read/write split is meaningful there
// yet, since both primitives are read-only surfaces (mcp/resources.ts, mcp/prompts.ts).
//
/** Every scope a key may be minted with. `routes/admin.ts` derives its `SCOPE_VALUES` (and the
 *  zod enum on the mint route) from THIS array — duplicating the list there is what would make
 *  the two new scopes unmintable and ship the feature dead. */
export const MCP_SCOPE_VALUES = [
  'tools',
  'tools:read',
  'tools:write',
  'resources',
  'prompts',
] as const;

export type McpScope = (typeof MCP_SCOPE_VALUES)[number];

/** The two scopes a tool call can require. A tool is always one or the other — never neither. */
export type ToolScope = 'tools:read' | 'tools:write';

// ---- the tool → scope map ----------------------------------------------------------------
//
// EXHAUSTIVENESS MECHANISM, and why it is spelled this way.
// `mcp/tools.ts` annotates the catalogue as `PLATFORM_TOOLS: PlatformToolDef[]` with
// `name: string`, so the literal tool names are WIDENED to `string` at that declaration and
// there is no `typeof PLATFORM_TOOLS[number]['name']` union to derive from. Deriving one would
// mean editing tools.ts. So exhaustiveness is enforced in TWO layers, because either alone
// fails open in a different direction:
//
//   1. COMPILE TIME — `PLATFORM_TOOL_NAMES` is an `as const` tuple, so it keeps its literal
//      types; `TOOL_SCOPES` is typed `Record<PlatformToolName, ToolScope>`. Omit a name and
//      tsc errors (TS2739, "missing the following properties"); add a name that is not in the
//      union and tsc errors on the excess property. There is no way to write this object with
//      a hole in it.
//   2. RUNTIME DRIFT — layer 1 cannot see a tool ADDED to tools.ts, because the union is this
//      file's own tuple. `toolScopeCoverage()` compares the two lists and is meant to be
//      asserted by a test (and/or at host construction). Until someone runs it, a new tool is
//      still not unguarded: `scopeForTool` resolves an unknown name to `tools:write`, the
//      restrictive answer. An unmapped tool is DENIED to a read-only key, not waved through.
//
// ⛔ Never make `scopeForTool` return `undefined` or `tools:read` for an unknown name. Both are
// the fail-open shape: the first makes callers write `if (scope && !hasScope(...))`, which
// skips the check for exactly the tool nobody classified.

/** The tool names as of this commit — the compile-time key set for `TOOL_SCOPES`. Kept in the
 *  same order as `PLATFORM_TOOLS` so the two lists diff against each other by eye. */
export const PLATFORM_TOOL_NAMES = [
  // backend — read-only introspection
  'search_blocks',
  'get_block',
  'list_templates',
  'get_template',
  'validate_flow',
  'list_datasets',
  'describe_data',
  'get_ontology',
  'map_dataset',
  'explain_relations',
  'lint_block',
  // backend — run / author / mutate
  'run_flow',
  'create_block',
  'create_template',
  'delete_template',
  'save_block_version',
  'publish_block',
  'create_data_block_from_entity',
  'simulate_block',
  'run_block_test',
  'propose_block_draft',
  'propose_block_patch',
  // frontend (canvas edit) tools — the headless fallback of every one of these calls
  // `flowEdit.*`, which PERSISTS the graph. They are writes on both surfaces.
  'add_node',
  'insert_node',
  'remove_node',
  'connect_nodes',
  'disconnect_nodes',
  'configure_node',
  'move_node',
] as const;

export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number];

/**
 * Every tool's required scope. Total over `PlatformToolName` by construction (see above).
 *
 * Classification rule: introspection that reads and returns state — search / get / list /
 * validate / describe / explain / map — is `tools:read`. Anything that runs a flow, executes
 * a block, or mutates a flow, graph, block or template is `tools:write`. Ambiguity resolves to
 * `tools:write`.
 */
export const TOOL_SCOPES: Record<PlatformToolName, ToolScope> = {
  // ---- tools:read ----
  search_blocks: 'tools:read',
  get_block: 'tools:read',
  list_templates: 'tools:read',
  get_template: 'tools:read',
  /** Pure analysis of a loaded graph; writes nothing. */
  validate_flow: 'tools:read',
  list_datasets: 'tools:read',
  /** Returns a schema (names, types, PII flags) + row count — no values. Read of tenant data, no write. */
  describe_data: 'tools:read',
  get_ontology: 'tools:read',
  /** ⚠️ READ WITH ONE CAVEAT: `map_dataset` persists nothing, but `useLlm: true` opt-in
   *  spends a METERED brokered model call (suggestMappings). Money is not authority, so it
   *  stays `tools:read` — but if a spend-bearing grant is ever wanted, this is the tool that
   *  motivates it, and a `tools:spend` scope would be an additive extension here. */
  map_dataset: 'tools:read',
  explain_relations: 'tools:read',
  /** Static scan + typecheck of a source string. Its own description says it writes nothing,
   *  and it is already developer-role gated on top. */
  lint_block: 'tools:read',

  // ---- tools:write ----
  /** ⚠️ TODAY THIS TOOL ONLY VALIDATES — it calls `validateFlow` and returns a readiness note;
   *  execution still comes from the Test-run button / POST /api/runs. It is classified WRITE
   *  anyway, deliberately: the tool is named and described as running the flow, and the moment
   *  a headless run is wired behind it (the deferred Session 7 item named in tools.ts) the
   *  scope must already be write, or that commit silently hands execution to read-only keys. */
  run_flow: 'tools:write',
  create_block: 'tools:write',
  create_template: 'tools:write',
  delete_template: 'tools:write',
  save_block_version: 'tools:write',
  publish_block: 'tools:write',
  create_data_block_from_entity: 'tools:write',
  /** ⚠️ "Persists nothing" — but it EXECUTES a block version in the sandbox and bills the run.
   *  Arbitrary code execution is not introspection; deny-by-default puts it here. */
  simulate_block: 'tools:write',
  /** Runs the saved suite through the real runner. Same reasoning as `simulate_block`. */
  run_block_test: 'tools:write',
  /** ⚠️ "Propose" names the BROWSER behaviour (the editor shows a diff for a human to Apply).
   *  The HEADLESS fallback these keys actually hit calls `createBlockCore` / `saveVersionCore`
   *  and persists. An external MCP client has no editor, so for a key this is a plain write. */
  propose_block_draft: 'tools:write',
  propose_block_patch: 'tools:write',
  // Canvas edits — `flowEdit.addNode/insertNode/removeNode/connectNodes/disconnectNodes/
  // configureNode/moveNode`, all of which persist the graph.
  add_node: 'tools:write',
  insert_node: 'tools:write',
  remove_node: 'tools:write',
  connect_nodes: 'tools:write',
  disconnect_nodes: 'tools:write',
  configure_node: 'tools:write',
  /** Position-only, but it is still a persisted mutation of the flow graph. */
  move_node: 'tools:write',
};

/** The scope a tool call requires. An UNKNOWN name resolves to `tools:write` — the restrictive
 *  answer — so a tool added to `PLATFORM_TOOLS` and forgotten here is denied to a read-only
 *  key rather than left unguarded. Never returns undefined. */
export function scopeForTool(name: string): ToolScope {
  // The cast is needed only because `noUncheckedIndexedAccess` + a literal-keyed Record cannot
  // be indexed by a plain `string`; the `??` is what actually decides the unknown case.
  return (TOOL_SCOPES as Record<string, ToolScope | undefined>)[name] ?? 'tools:write';
}

/**
 * Runtime drift check against the real catalogue — layer 2 of the exhaustiveness argument.
 * Pass `PLATFORM_TOOLS`; a test (or host construction) asserts both lists are empty.
 *
 * Takes a structural `{ name: string }[]` rather than importing `PlatformToolDef` so this file
 * stays import-free and `routes/admin.ts` can consume the vocabulary without pulling in the
 * tool catalogue's transitive db/exec/blocks graph.
 */
export function toolScopeCoverage(tools: readonly { name: string }[]): {
  /** In `PLATFORM_TOOLS` but not in `TOOL_SCOPES` — each is currently denied to read-only keys. */
  unmapped: string[];
  /** In `TOOL_SCOPES` but no longer in `PLATFORM_TOOLS` — a stale entry, harmless but rotting. */
  stale: string[];
} {
  const live = new Set(tools.map((t) => t.name));
  const mapped = new Set<string>(PLATFORM_TOOL_NAMES);
  return {
    unmapped: [...live].filter((n) => !mapped.has(n)).sort(),
    stale: [...mapped].filter((n) => !live.has(n)).sort(),
  };
}

// ---- the check ---------------------------------------------------------------------------

/**
 * Does this credential's grant satisfy `required`?
 *
 * ⛔⛔ THE FIRST TWO CASES LOOK IDENTICAL AND ARE OPPOSITE. Do NOT "simplify" them into one
 * `if (!granted?.length) return …` — either collapse is a whole-gate defect:
 *
 *   • `undefined` / `null` → TRUE. This is NOT a scoped credential at all. The in-process
 *     copilot (`ai/agent.ts` holds `mcpHost` directly, never through an API key) and the
 *     AUTH_BYPASS dev path have no `scopes` field to carry, and both must keep full access.
 *     Collapsing them into the empty case breaks the entire in-app copilot.
 *   • `[]` → FALSE for everything. An empty array is a REAL, DELIBERATE, EMPTY grant that a
 *     minter wrote down. Collapsing it into the absent case is the classic fail-open mutant:
 *     the one credential that was explicitly granted nothing would get everything.
 *
 * Hierarchy: a grant satisfies `required` if it holds `required` verbatim, or the parent scope
 * before the `:` — so `['tools']` satisfies both `tools:read` and `tools:write`, which is what
 * keeps every already-issued key working. The rule is the generic prefix rule rather than a
 * lookup table so a future `resources:read` inherits it without another map to keep in sync.
 *
 * ⚠️ It is deliberately ONE level and ONE direction: `tools:write` does NOT imply `tools:read`.
 * Deny-by-default does not invent grants nobody minted; a write-only key is useless rather than
 * over-powered, and that is the correct side to be wrong on.
 */
export function hasScope(granted: string[] | null | undefined, required: string): boolean {
  if (granted === undefined || granted === null) return true; // unscoped credential — see above
  if (granted.includes(required)) return true;
  const sep = required.indexOf(':');
  if (sep <= 0) return false; // already a parent scope, and it was not granted
  return granted.includes(required.slice(0, sep));
}

/** Convenience for the tool path: `hasScope(granted, scopeForTool(name))`. */
export function canCallTool(granted: string[] | null | undefined, name: string): boolean {
  return hasScope(granted, scopeForTool(name));
}

// ---- denial ------------------------------------------------------------------------------
//
// ⛔ NO USER-FACING STRING AND NO HTTP STATUS LIVES IN THIS FILE, BY CONSTRAINT, NOT BY TASTE.
// `frontend/src/lib/api/error-message.backend-contract.test.ts` (the 403 half, ~lines 139-186)
// walks EVERY .ts file under `backend/src`, strips comments, and scrapes two call patterns —
// the http.ts 403 helper, and a direct HttpError constructed with status 403 — for their
// machine code. (This comment names neither call shape verbatim, deliberately.) Every code
// it finds must appear in `ForbiddenCode` + `FORBIDDEN_MESSAGES` and in all EIGHT locale
// catalogs (`frontend/messages/*.json`); there is no exemption list for 403. Raising a scope
// refusal that way from here would red that test until eight translations landed.
//
// It does not need to be raised that way. A scope refusal on the MCP surface is an MCP
// TOOL-ERROR RESULT — `callTool` already returns `{ result, isError: true }` and the transport
// carries the payload as the tool's own error — not an HTTP status page a human ever reads.
// So this is a machine code only. If a REST-shaped refusal is ever genuinely needed, it belongs
// in the route file that raises it, together with its frontend catalog + eight locale entries.

/** Machine-readable denial code. Callers put this in an MCP tool-error result. */
export const MCP_SCOPE_DENIED = 'mcp_scope_denied';

/** The denial payload for a refused MCP call — shape matches `ToolCallResult.result`, with the
 *  required scope named so an external client can see which grant it is missing. */
export function scopeDeniedResult(required: string): {
  error: typeof MCP_SCOPE_DENIED;
  required: string;
} {
  return { error: MCP_SCOPE_DENIED, required };
}
