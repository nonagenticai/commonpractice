// src/ai/mcp/prompts.ts — the MCP "prompts" primitive, DB-backed (mcp_prompts).
// Per-locale (en this session), tenant-scoped (a tenant row overrides the global),
// versioned. The agent's system prompt is `agent.system` — fetched here so it is a
// governable + localizable asset, not hardcoded. prompts/list + prompts/get are
// computed at request time.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db as defaultDb, mcpPrompts } from '../../db/client';
import type { McpPromptArgument } from '../../db/schema';

type Db = typeof defaultDb;

export interface PromptDef {
  name: string;
  description?: string;
  arguments: McpPromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
  template: string;
}

// Fallback used only if the seed row is somehow absent (keeps the loop alive).
const DEFAULT_SYSTEM_PROMPT =
  'You are the Common Practice build copilot. Help the user compose a flow from ' +
  'typed building blocks using the available tools. Search before inventing blocks; ' +
  'connect matching ports; keep the graph acyclic; validate before running. Before ' +
  'composing a flow over a dataset, call get_ontology for the (industry × department) ' +
  'cell and map_dataset(slug) for its column→concept mapping, and reason about entities ' +
  'and relations (explain_relations), not raw column names; if no industry is configured, ' +
  'pass it explicitly or ask.';

// Block-authoring fallback (used only if the seed row is absent). The full prompt is
// seeded in db/seed-ai.ts as `agent.block_authoring`.
const DEFAULT_BLOCK_AUTHORING_PROMPT =
  'You are the Common Practice block-authoring copilot. Help a developer author ONE new ' +
  'building block. Ground yourself in the company context: call get_ontology for the ' +
  "(industry × department) cell and describe_data(slug) for any test dataset the developer " +
  'names; call search_blocks/get_block to reuse patterns and avoid duplicates. Then propose ' +
  'the block with propose_block_draft (a complete descriptor + a runnable source_ts that ' +
  'exports default { descriptor, run }) — do NOT call create_block; the developer reviews and ' +
  'creates. Reply in the user’s language.';

/** The keyless fallback for a given system-prompt name (kept inline so the loop never stalls). */
function fallbackFor(name: string): string {
  return name === 'agent.block_authoring' ? DEFAULT_BLOCK_AUTHORING_PROMPT : DEFAULT_SYSTEM_PROMPT;
}

/** List prompts visible to a tenant in a locale (tenant rows + global rows). */
export async function listPrompts(
  opts: { locale?: string; tenantId?: string | null } = {},
  db: Db = defaultDb,
): Promise<PromptDef[]> {
  const locale = opts.locale ?? 'en';
  const rows = await db
    .select()
    .from(mcpPrompts)
    .where(
      and(
        eq(mcpPrompts.locale, locale),
        opts.tenantId
          ? or(eq(mcpPrompts.tenant_id, opts.tenantId), isNull(mcpPrompts.tenant_id))
          : isNull(mcpPrompts.tenant_id),
      ),
    );
  return rows.map((r) => ({
    name: r.name,
    arguments: r.arguments,
  }));
}

/** Row shape the resolver needs — kept minimal so it can be unit-tested without a DB row. */
export interface PromptRowLike {
  tenant_id: string | null;
  locale: string;
  template: string;
}

/** Deterministic prompt-row resolution: exact (tenant, locale) → global+locale → global+en →
 *  any global row → null (never an arbitrary row).
 *
 *  `mcp_prompts` is tenant-scoped via 0028's RLS (a tenant row overrides the global one), but
 *  until this fix `getPrompt` fetched EVERY tenant's rows for `name` and, when none of the
 *  three named tiers matched, fell back to `rows[0]!` — whichever row the DB happened to
 *  return first, including a FOREIGN tenant's override. Only global rows exist in prod today
 *  (`seed-ai.ts` is the sole writer and always writes `tenant_id: null`), so this was latent,
 *  not live — but the schema explicitly supports tenant overrides, so the first one written
 *  would have been one unlucky query-planner ordering away from leaking into another tenant.
 *  Pure + exported so the resolution order is unit-testable without a DB. */
export function pickPromptRow<T extends PromptRowLike>(
  rows: T[],
  opts: { locale: string; tenantId: string | null },
): T | null {
  return (
    rows.find((r) => r.tenant_id === opts.tenantId && r.locale === opts.locale) ??
    rows.find((r) => r.tenant_id === null && r.locale === opts.locale) ??
    rows.find((r) => r.tenant_id === null && r.locale === 'en') ??
    rows.find((r) => r.tenant_id === null) ??
    null
  );
}

/** Fetch a prompt by name. A tenant-specific row wins over the global one; the
 *  requested locale wins over 'en' fallback; a foreign tenant's row is never served —
 *  see `pickPromptRow`. */
export async function getPrompt(
  name: string,
  opts: { locale?: string; tenantId?: string | null } = {},
  db: Db = defaultDb,
): Promise<PromptGetResult | null> {
  const locale = opts.locale ?? 'en';
  const tenantId = opts.tenantId ?? null;
  // Scoped at the DB level to (own tenant ∪ global) — mirrors listPrompts — so a foreign
  // tenant's override is never even fetched, let alone eligible to be picked.
  const rows = await db
    .select()
    .from(mcpPrompts)
    .where(
      and(
        eq(mcpPrompts.name, name),
        tenantId
          ? or(eq(mcpPrompts.tenant_id, tenantId), isNull(mcpPrompts.tenant_id))
          : isNull(mcpPrompts.tenant_id),
      ),
    );
  if (rows.length === 0) return null;

  const pick = pickPromptRow(rows, { locale, tenantId });
  if (!pick) return null;

  return {
    messages: [{ role: 'user', content: { type: 'text', text: pick.template } }],
    template: pick.template,
  };
}

/** Convenience for the agent loop: the resolved system-prompt text (never null).
 *  `name` selects which seeded prompt to use — `agent.system` (flow copilot, default) or
 *  `agent.block_authoring` (the block-authoring copilot). */
export async function getSystemPromptText(
  opts: { locale?: string; tenantId?: string | null } = {},
  db: Db = defaultDb,
  name = 'agent.system',
): Promise<string> {
  const p = await getPrompt(name, opts, db);
  return p?.template ?? fallbackFor(name);
}
