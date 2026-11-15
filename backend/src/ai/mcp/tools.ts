// src/ai/mcp/tools.ts — the platform tool catalogue (in code). Two surfaces:
//   * backend  — run server-side via callTool (search_blocks, get_block,
//                validate_flow, run_flow).
//   * frontend — flow EDITS. In a browser session the agent driver applies these
//                live on the canvas through the builder store (Layer 3); the loop
//                emits a frontend-tool-call instead of calling the handler. The
//                handler here is the HEADLESS fallback (flow-edit-service) used by
//                browserless MCP clients + tests, and requires `flowId` in input.
// This static array is the WHOLE tool surface — `tools/list` returns exactly it.
// Customer-authored extensions are blocks, not tools: they are authored through the
// block-authoring tools below and run in the block sandbox. (A `mcp_tools` table once
// promised DB-defined tools merged in at request time; it never had an executor and was
// dropped in 0052.)
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, flows, blockVersions } from '../../db/client';
import type { FlowGraph } from '../../db/flow-types';
import type { BlockDescriptor } from '../../db/block-types';
import {
  validateGraphStructure,
  validateGraphAgainstBlocks,
} from '../../exec/flow-validate';
import { searchBlocks, getBlockDetail } from '../block-catalog-service';
import * as flowEdit from '../flow-edit-service';
import { datasets } from '../../db/client';
import { schemaForAi } from '../../datasets/dataset-service';
import { isConnectorSource } from '../../db/dataset-types';
import { BLOCK_CATEGORIES, type BlockCategory } from '../../db/block-types';
import { notFound, badRequest, forbidden } from '../../utils/http';
import { listTemplates, getTemplate, createTemplate, deleteTemplate } from '../../templates/templates-service';
import { lintBlock } from '../../blocks/lint';
import {
  isDeveloperRoles,
  resolveCreateScopeByRoles,
  authorizeBlockWriteByRoles,
  loadBlockVersion,
  createBlockCore,
  saveVersionCore,
  publishVersionCore,
} from '../../blocks/authoring-service';
import { simulateBlockVersion, sampleInputsFor, runBlockTests } from '../../blocks/test-runner';
import { deriveDataBlock } from '../../ontology/data-block-derivation';
import { compileEffective } from '../../ontology/ontology-service';
import { resolveAgentCell } from '../../ontology/cell-context';
import { listMappings, suggestMappings } from '../../datasets/mapping-service';
import { simulateOutcomeFor } from '../../host/run-cost-visibility';

type Db = typeof defaultDb;

export type ToolSurface = 'backend' | 'frontend';

export interface McpToolContext {
  userId: string;
  tenantId: string | null;
  /** The caller's realm roles — authorizes the developer-gated authoring tools. */
  roles: string[];
  db: Db;
  /** Phase 3.4: request context for (industry × department) cell auto-resolution when
   *  an ontology tool omits explicit args. Optional — external MCP callers and tools
   *  that ignore them compile unchanged. */
  flowId?: string | null;
  challengeId?: string | null;
}

export interface PlatformToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input (what the model fills in). */
  inputSchema: Record<string, unknown>;
  surface: ToolSurface;
  /** Server-side execution (backend) or headless fallback (frontend). */
  handler: (input: unknown, ctx: McpToolContext) => Promise<unknown>;
}

// ---- small JSON-schema builders (kept literal so the contract is obvious) ----
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });
const position = obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']);

/** Kebab-case a display name into a block slug (mirrors the editor's slugify). */
function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ---- backend tool helpers ----

async function loadOwnedFlowGraph(
  flowId: string,
  userId: string,
  db: Db,
): Promise<{ graph: FlowGraph; name: string }> {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.owner_id, userId)));
  if (!flow) throw notFound('flow_not_found', `No flow '${flowId}'`);
  return { graph: (flow.graph ?? { nodes: [], edges: [] }) as FlowGraph, name: flow.name };
}

async function descriptorsFor(graph: FlowGraph, db: Db): Promise<Map<string, BlockDescriptor>> {
  // ⛔ FOREACH CONTAINERS ARE EXCLUDED, AND HERE IT IS A 500, NOT A MISS. A loop container runs no
  // block: the builder persists it with `blockVersionId: ''` (frontend stores/builder-graph.ts,
  // `newForeachNode`), and `block_versions.id` is a `uuid` column — so the empty string went into
  // `id in ($1, …)` and Postgres answered `invalid input syntax for type uuid: ""` (22P02, measured
  // directly against psql 18), failing the WHOLE query. Every MCP `validate_flow`/`run_flow` on a
  // flow containing a loop therefore 500'd instead of validating. `validateGraphAgainstBlocks`
  // never wanted the row anyway: it resolves a foreach node to `FOREACH_DESCRIPTOR` itself
  // (exec/flow-validate.ts, `descFor`). Same filter, same reason, as `resolveExecutableBlocks`
  // (host/publication-service.ts) — which is the path the real run takes, and why runs were fine
  // while this one was not.
  const ids = [
    ...new Set(graph.nodes.filter((n) => n.kind !== 'foreach').map((n) => n.blockVersionId)),
  ];
  const rows = ids.length
    ? await db.select().from(blockVersions).where(inArray(blockVersions.id, ids))
    : [];
  return new Map(rows.map((v) => [v.id, v.descriptor]));
}

/** Validate the flow's graph (structure + handle types). Shared by validate_flow +
 *  run_flow (run execution itself is the Test-run button / POST /api/runs — wiring
 *  a headless subprocess run from MCP is Session 7). */
async function validateFlow(flowId: string, ctx: McpToolContext) {
  const { graph } = await loadOwnedFlowGraph(flowId, ctx.userId, ctx.db);
  const descriptors = await descriptorsFor(graph, ctx.db);
  const structure = validateGraphStructure(graph);
  const handles = validateGraphAgainstBlocks(graph, descriptors);
  const issues = [...structure.issues, ...handles.issues];
  return { ok: issues.length === 0, issues, nodeCount: graph.nodes.length };
}

// ---- Phase 3.4 ontology-tool helpers ----

/** A clear, non-crashing response when no industry can be resolved for the cell. */
const NO_INDUSTRY_HINT = {
  error: 'no_industry',
  message:
    'No industry is configured for this tenant and none was passed. Call again with an ' +
    'explicit `industry` (e.g. "insurance"), or ask the user which industry to use.',
} as const;

/** Resolve the (industry × department) cell for an ontology tool: explicit args win;
 *  omitted args are filled from request context (tenant industry + challenge work_area). */
async function resolveOntologyCell(
  args: { industry?: string; department?: string },
  ctx: McpToolContext,
): Promise<{ industry: string | null; department: string | null }> {
  if (args.industry) {
    return { industry: args.industry, department: args.department ?? null };
  }
  const resolved = await resolveAgentCell(
    { tenantId: ctx.tenantId, challengeId: ctx.challengeId, flowId: ctx.flowId },
    ctx.db,
  );
  return { industry: resolved.industry, department: args.department ?? resolved.department };
}

// ---- input schemas (zod) for handler-side validation ----
const flowIdReq = z.object({ flowId: z.string().uuid() });

/**
 * The flow validate_flow / run_flow act on: the given one when it is a real id, else the flow open
 * on the canvas (`ctx.flowId`). ⛔ Prod 2026-10-16: with `flowId` required and no id in its
 * context, the copilot asked a user for a UUID. "Test this flow" means the open one.
 */
function targetFlowId(input: unknown, ctx: McpToolContext): string {
  const given = (input as { flowId?: unknown } | null | undefined)?.flowId;
  const parsed = flowIdReq.safeParse({ flowId: given });
  if (parsed.success) return parsed.data.flowId;
  if (ctx.flowId) return ctx.flowId;
  return flowIdReq.parse(input ?? {}).flowId; // no open flow and no valid id: the original error
}
const posOpt = z.object({ x: z.number(), y: z.number() }).optional();

// ---- the catalogue ----

export const PLATFORM_TOOLS: PlatformToolDef[] = [
  {
    name: 'search_blocks',
    description:
      'Search the building-block catalogue by name/description/category. Returns each block with its typed input/output ports and capabilities.',
    inputSchema: obj(
      {
        query: str('free-text search'),
        category: { type: 'string', enum: ['data', 'ai', 'logic', 'output', 'ui'] },
        limit: { type: 'number' },
      },
      ['query'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({ query: z.string(), category: z.string().optional(), limit: z.number().optional() })
        .parse(input);
      return searchBlocks(i.query, { category: i.category, limit: i.limit }, ctx.db);
    },
  },
  {
    name: 'get_block',
    description: 'Read one block’s full descriptor (typed I/O + capabilities) and documentation by slug.',
    inputSchema: obj({ slug: str('block slug, e.g. ai-summarize') }, ['slug']),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z.object({ slug: z.string() }).parse(input);
      const block = await getBlockDetail(i.slug, ctx.db);
      if (!block) throw notFound('block_not_found', `No block '${i.slug}'`);
      return block;
    },
  },
  {
    name: 'list_templates',
    description:
      'List the starter templates available as block scaffolds — each is a PKO/PDDL-structured pattern (preconditions/postconditions/steps) with a typed descriptor and source. Filter by category/domain/free-text. Returns summaries; call get_template for one template’s full scaffold to ground a new block in a proven structure instead of starting blank.',
    inputSchema: obj({
      category: { type: 'string', enum: ['data', 'ai', 'logic', 'output', 'ui'] },
      domain: str('industry/vertical overlay, e.g. insurance'),
      q: str('free-text search'),
    }),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          category: z.string().optional(),
          domain: z.string().optional(),
          q: z.string().optional(),
        })
        .parse(input);
      return listTemplates(
        {
          tenantId: ctx.tenantId,
          category: i.category as BlockCategory | undefined,
          domain: i.domain,
          q: i.q,
        },
        ctx.db,
      );
    },
  },
  {
    name: 'get_template',
    description:
      'Read one starter template’s full scaffold by id: typed descriptor, source_ts, docs, and its PKO/PDDL preconditions/postconditions/steps. Reuse this structure when authoring a new block.',
    inputSchema: obj({ id: str('template id (uuid) from list_templates') }, ['id']),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z.object({ id: z.string() }).parse(input);
      const t = await getTemplate(i.id, { tenantId: ctx.tenantId }, ctx.db);
      if (!t) throw notFound('template_not_found', `No template '${i.id}'`);
      return t;
    },
  },
  {
    name: 'validate_flow',
    description: 'Check the current flow for cycles, dangling edges, duplicate ids, missing descriptors and handle-type mismatches.',
    inputSchema: obj({ flowId: str('omit to use the flow open on the canvas') }, []),
    surface: 'backend',
    handler: async (input, ctx) => {
      return validateFlow(targetFlowId(input, ctx), ctx);
    },
  },
  {
    name: 'run_flow',
    description:
      'Report whether the flow is ready to run (it validates; it does not execute). Use ONLY when the user asks to run or test the flow — never to explain what a flow does.',
    inputSchema: obj({ flowId: str('omit to use the flow open on the canvas') }, []),
    surface: 'backend',
    handler: async (input, ctx) => {
      const validation = await validateFlow(targetFlowId(input, ctx), ctx);
      return {
        ...validation,
        note: validation.ok
          ? 'Flow is valid and ready to run. Trigger Test-run to execute.'
          : 'Fix the reported issues before running.',
      };
    },
  },
  {
    name: 'list_datasets',
    description:
      'List the developer-loaded datasets available to wire into a flow (test data: CSV/Excel/text/JSON). Returns each dataset\'s slug, name, typed columns, and row count. Use a slug as a dataset-typed input\'s value via configure_node.',
    inputSchema: obj({ query: str('optional name/slug filter') }, []),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z.object({ query: z.string().optional() }).parse(input ?? {});
      const rows = await ctx.db
        .select()
        .from(datasets)
        .where(eq(datasets.tenant_id, ctx.tenantId ?? ''));
      const q = i.query?.toLowerCase();
      const items = rows
        .filter((d) => !q || d.name.toLowerCase().includes(q) || d.slug.includes(q))
        .map((d) => ({
          slug: d.slug,
          name: d.name,
          sourceType: d.source_type,
          // A live connector (postgres/storage/http) materializes real data on refresh.
          live: isConnectorSource(d.source_type),
          status: d.status,
          lastSyncedAt: d.last_synced_at,
          rowCount: d.row_count,
          columns: schemaForAi(d.columns),
        }));
      return { items };
    },
  },
  {
    name: 'describe_data',
    description:
      'Describe one dataset by slug: its typed column schema (names, types, personal-data flags) and row count. Use before wiring a dataset into a flow so you pick the right columns. No row values are returned.',
    inputSchema: obj({ slug: str('dataset slug') }, ['slug']),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z.object({ slug: z.string() }).parse(input);
      const [d] = await ctx.db
        .select()
        .from(datasets)
        .where(and(eq(datasets.tenant_id, ctx.tenantId ?? ''), eq(datasets.slug, i.slug)));
      if (!d) throw notFound('dataset_not_found', `No dataset '${i.slug}'`);
      // ⛔ NO EXAMPLE DATA, EVER (owner decision W8, 2026-10-14). This result flows straight into
      // the LLM conversation (ai/agent.ts), i.e. to whatever EXTERNAL provider the tenant has
      // configured, and to any external MCP client. It used to carry a row `sample` (PII-blanked
      // only when governance scrubbing was ON) and every column's `sample` — a real cell value —
      // unconditionally. Both are gone: the schema (name + type + pii flag) is what the agent needs
      // to wire columns, and `schemaForAi` is the ONE shape every AI-facing dataset read uses.
      return {
        slug: d.slug,
        name: d.name,
        sourceType: d.source_type,
        live: isConnectorSource(d.source_type),
        status: d.status,
        lastSyncedAt: d.last_synced_at,
        // English on purpose for THIS reader — an LLM client has no locale to negotiate and the
        // prose is the most informative thing we have. The code rides along so a tool caller can
        // branch on the failure without re-parsing the sentence; it is the same value
        // /api/connectors serves the browser, so the two surfaces cannot disagree.
        syncError: d.sync_error,
        syncErrorCode: d.sync_error_code,
        rowCount: d.row_count,
        columns: schemaForAi(d.columns),
      };
    },
  },
  // ---- ontology reasoning (Phase 3.4): the agent reads the company's semantic
  //      model + a dataset's column→concept mapping instead of guessing from columns ----
  {
    name: 'get_ontology',
    description:
      "Load the company's semantic model — the entities, their attributes (with synonyms) " +
      'and the relations between them — for an (industry × department) cell. Call this before ' +
      'composing a flow over a dataset so you reason about business concepts (Claim, Policy) and ' +
      'how they relate, not raw column names. Omit industry/department to use the current ' +
      "challenge's cell; pass them to override.",
    inputSchema: obj(
      {
        industry: str("industry, e.g. insurance (omit to use the tenant's configured industry)"),
        department: str('department, e.g. Claims (omit to derive from the challenge work_area)'),
      },
      [],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({ industry: z.string().optional(), department: z.string().optional() })
        .parse(input ?? {});
      const cell = await resolveOntologyCell(i, ctx);
      if (!cell.industry) return NO_INDUSTRY_HINT;
      // Tenant-aware (3.5): the agent sees the tenant's overrides/extensions. Labels stay
      // canonical (en) — the agent reasons on concepts; localization is a UI concern.
      return compileEffective(cell.industry, cell.department ?? '', {
        tenantId: ctx.tenantId,
        database: ctx.db,
      });
    },
  },
  {
    name: 'map_dataset',
    description:
      "Read a dataset's column→concept mapping for the (industry × department) cell: which " +
      'ontology entity/attribute each column means (e.g. clm_amt → Claim.amount). Returns the ' +
      'human-confirmed mapping when one exists; otherwise proposes one. Set useLlm to ask the ' +
      'metered model to place columns the name-heuristic could not (opt-in; costs a brokered call).',
    inputSchema: obj(
      {
        slug: str('dataset slug'),
        useLlm: {
          type: 'boolean',
          description: 'opt-in metered LLM proposal for ambiguous columns (default false)',
        },
        industry: str('override the resolved industry'),
        department: str('override the resolved department'),
      },
      ['slug'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          slug: z.string(),
          useLlm: z.boolean().optional(),
          industry: z.string().optional(),
          department: z.string().optional(),
        })
        .parse(input);
      const [d] = await ctx.db
        .select()
        .from(datasets)
        .where(and(eq(datasets.tenant_id, ctx.tenantId ?? ''), eq(datasets.slug, i.slug)));
      if (!d) throw notFound('dataset_not_found', `No dataset '${i.slug}'`);
      // A human-confirmed mapping is authoritative — return it verbatim.
      // `{ tenantId }` is load-bearing since mapping writes became tenant-scoped: without it this
      // reads global rows only and the agent never sees what the org actually confirmed.
      const saved = await listMappings(d.id, ctx.db, { tenantId: ctx.tenantId });
      const confirmed = saved.filter((m) => m.confirmed);
      if (confirmed.length > 0) {
        return { slug: d.slug, source: 'confirmed', mappings: confirmed };
      }
      // Nothing confirmed yet → propose against the resolved cell.
      const cell = await resolveOntologyCell(i, ctx);
      if (!cell.industry) return NO_INDUSTRY_HINT;
      const suggestions = await suggestMappings(
        {
          columns: d.columns ?? [],
          industry: cell.industry,
          department: cell.department ?? '',
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          useLlm: i.useLlm ?? false,
        },
        ctx.db,
      );
      return {
        slug: d.slug,
        source: 'proposed',
        industry: cell.industry,
        department: cell.department ?? '',
        suggestions,
      };
    },
  },
  {
    name: 'explain_relations',
    description:
      'Explain how a set of ontology entities relate in the current (industry × department) ' +
      'cell — the directed relations (e.g. Claim —under→ Policy) with their cardinality. Use ' +
      'after get_ontology to see how the concepts behind a dataset connect.',
    inputSchema: obj(
      {
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'entity names, e.g. ["Claim","Policy"]',
        },
        industry: str('override the resolved industry'),
        department: str('override the resolved department'),
      },
      ['entities'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          entities: z.array(z.string()).min(1),
          industry: z.string().optional(),
          department: z.string().optional(),
        })
        .parse(input);
      const cell = await resolveOntologyCell(i, ctx);
      if (!cell.industry) return NO_INDUSTRY_HINT;
      const compiled = await compileEffective(cell.industry, cell.department ?? '', {
        tenantId: ctx.tenantId,
        database: ctx.db,
      });
      const want = new Set(i.entities.map((e) => e.toLowerCase()));
      // Edges that touch ANY requested entity (from or to) — the agent asked "how do
      // these relate", which includes edges to neighbours it didn't list.
      const relations = compiled.relations.filter(
        (r) => want.has(r.from.toLowerCase()) || want.has(r.to.toLowerCase()),
      );
      return { industry: cell.industry, department: cell.department ?? '', relations };
    },
  },
  // ---- block authoring (backend): the agent authors tenant building blocks through the SAME
  //      service the HTTP routes use. Developer-gated by the caller's realm roles. ----
  {
    name: 'lint_block',
    description:
      'Static-scan + type-check a block TypeScript source against the SDK types WITHOUT writing ' +
      'anything. Use to self-check a draft before create_block / save_block_version / publish_block.',
    inputSchema: obj({ source_ts: str('the block module TypeScript source to lint') }, ['source_ts']),
    surface: 'backend',
    handler: async (input, ctx) => {
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      const i = z.object({ source_ts: z.string() }).parse(input);
      return lintBlock(i.source_ts);
    },
  },
  {
    name: 'create_block',
    description:
      'Author a NEW tenant building block: creates the block + its 0.1.0 draft with the given ' +
      'TypeScript source + descriptor (typed inputs/outputs/capabilities). Developer-only. After ' +
      'creating, lint_block then publish_block to make it runnable.',
    inputSchema: obj(
      {
        slug: str('unique kebab-case slug'),
        name: str('display name'),
        category: { type: 'string', enum: [...BLOCK_CATEGORIES] },
        description: str(),
        source_ts: str('the block module TypeScript source (export default { descriptor, run })'),
        docs_md: str('markdown documentation'),
        descriptor: { type: 'object', description: 'BlockDescriptor: { inputs, outputs, capabilities }' },
      },
      ['slug', 'name', 'category'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          slug: z.string(),
          name: z.string(),
          category: z.enum(['data', 'ai', 'logic', 'output', 'ui']),
          description: z.string().optional(),
          source_ts: z.string().optional(),
          docs_md: z.string().optional(),
          descriptor: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(input);
      const scope = resolveCreateScopeByRoles(ctx.userId, ctx.roles, ctx.tenantId);
      const created = await createBlockCore(scope, {
        slug: i.slug,
        name: i.name,
        category: i.category,
        description: i.description,
        source_ts: i.source_ts,
        docs_md: i.docs_md,
        descriptor: i.descriptor as unknown as BlockDescriptor | undefined,
      });
      return {
        slug: created.block.slug,
        version: created.version.version,
        status: created.version.status,
        owner: created.owner,
      };
    },
  },
  {
    name: 'create_template',
    description:
      'Save a reusable starter TEMPLATE for THIS tenant from a finished block design (descriptor + ' +
      'source + docs). Developer-only; the template is tenant-scoped and appears in the editor’s ' +
      '"From template" gallery. Offer this once the developer is happy with a block worth reusing.',
    inputSchema: obj(
      {
        name: str('unique template name within the tenant (identifier-style)'),
        label: str('display label'),
        category: { type: 'string', enum: [...BLOCK_CATEGORIES] },
        description: str(),
        domain: str('industry/vertical overlay, e.g. insurance; omit for generic'),
        tags: { type: 'array', items: { type: 'string' } },
        source_ts: str('the block module TypeScript source'),
        docs_md: str('markdown documentation'),
        descriptor: { type: 'object', description: 'BlockDescriptor: { inputs, outputs, capabilities }' },
      },
      ['name', 'label', 'category', 'descriptor'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      if (!ctx.tenantId) throw forbidden('tenant_id_claim_required', 'No tenant for template authoring');
      const i = z
        .object({
          name: z.string(),
          label: z.string(),
          category: z.enum(['data', 'ai', 'logic', 'output', 'ui']),
          description: z.string().optional(),
          domain: z.string().optional(),
          tags: z.array(z.string()).optional(),
          source_ts: z.string().optional(),
          docs_md: z.string().optional(),
          descriptor: z.record(z.string(), z.unknown()),
        })
        .parse(input);
      const created = await createTemplate(
        {
          name: i.name,
          label: i.label,
          category: i.category,
          description: i.description,
          domain: i.domain,
          tags: i.tags,
          source_ts: i.source_ts,
          docs_md: i.docs_md,
          descriptor: i.descriptor as unknown as BlockDescriptor,
        },
        // `userId` is the metering actor for the translation jobs `createTemplate` enqueues for
        // this tenant-authored row; a NULL one would be undrainable.
        { tenantId: ctx.tenantId, userId: ctx.userId },
        ctx.db,
      );
      return { id: created.id, name: created.name, category: created.category };
    },
  },
  {
    name: 'delete_template',
    description:
      'Remove a tenant-authored starter TEMPLATE by id (from list_templates). Developer-only and ' +
      'own-tenant only — shipped global templates cannot be deleted. Use when a saved template is ' +
      'obsolete or was created by mistake.',
    inputSchema: obj({ id: str('template id (uuid) of an own-tenant template') }, ['id']),
    surface: 'backend',
    handler: async (input, ctx) => {
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      if (!ctx.tenantId) throw forbidden('tenant_id_claim_required', 'No tenant for template authoring');
      const i = z.object({ id: z.string() }).parse(input);
      const deletedId = await deleteTemplate(i.id, { tenantId: ctx.tenantId }, ctx.db);
      if (!deletedId) throw notFound('template_not_found', `No own-tenant template '${i.id}'`);
      return { id: deletedId, deleted: true };
    },
  },
  {
    name: 'save_block_version',
    description:
      'Edit a DRAFT version of a block (source_ts / descriptor / docs). Developer-only; only drafts ' +
      'are editable (publish then create a new version to change a published block).',
    inputSchema: obj(
      {
        slug: str(),
        version: str('semver, e.g. 0.1.0'),
        source_ts: str(),
        docs_md: str(),
        descriptor: { type: 'object' },
        changelog: str(),
      },
      ['slug', 'version'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          slug: z.string(),
          version: z.string(),
          source_ts: z.string().optional(),
          docs_md: z.string().optional(),
          descriptor: z.record(z.string(), z.unknown()).optional(),
          changelog: z.string().optional(),
        })
        .parse(input);
      const { block, version } = await loadBlockVersion(i.slug, i.version);
      const { isGlobal } = authorizeBlockWriteByRoles(ctx.roles, ctx.tenantId, block);
      const updated = await saveVersionCore({ isGlobal }, version, {
        source_ts: i.source_ts,
        docs_md: i.docs_md,
        descriptor: i.descriptor as unknown as BlockDescriptor | undefined,
        changelog: i.changelog,
      });
      return { slug: block.slug, version: updated.version, status: updated.status };
    },
  },
  {
    name: 'publish_block',
    description:
      'Publish a draft version after the lint gate. Defaults to "beta" (lint only — immediately ' +
      'runnable); "stable" additionally requires passing tests when governance requires them. ' +
      'Developer-only.',
    inputSchema: obj(
      { slug: str(), version: str('semver'), status: { type: 'string', enum: ['beta', 'stable'] } },
      ['slug', 'version'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({ slug: z.string(), version: z.string(), status: z.enum(['beta', 'stable']).optional() })
        .parse(input);
      const { block, version } = await loadBlockVersion(i.slug, i.version);
      const { isGlobal } = authorizeBlockWriteByRoles(ctx.roles, ctx.tenantId, block);
      const published = await publishVersionCore(
        { userId: ctx.userId, tenantId: ctx.tenantId, isGlobal },
        block,
        version,
        i.status ?? 'beta',
      );
      return { slug: block.slug, version: published.version, status: published.status };
    },
  },
  {
    name: 'create_data_block_from_entity',
    description:
      'Derive (or re-derive) a tenant data block from an ontology entity that has a bound primary ' +
      'sample — one typed output port per attribute plus rows/count, auto-published to beta. ' +
      'Idempotent on the entity (re-deriving adds a version). Developer-only.',
    inputSchema: obj({ entityId: str('ontology entity id') }, ['entityId']),
    surface: 'backend',
    handler: async (input, ctx) => {
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      if (!ctx.tenantId) throw forbidden('tenant_id_claim_required', 'No tenant for data-block derivation');
      const i = z.object({ entityId: z.string() }).parse(input);
      const r = await deriveDataBlock(ctx.tenantId, i.entityId, ctx.userId);
      return { slug: r.block.slug, version: r.version.version, status: r.version.status, created: r.created };
    },
  },
  // ---- block fix-loop (backend): let the agent OBSERVE run results so it can close an
  //      edit→test→re-observe loop. Their output re-enters the agent loop as a tool message,
  //      so the bounded loop (MAX_ITERATIONS/wall-clock) drives auto-iterate for free. ----
  {
    name: 'simulate_block',
    description:
      'Run a block version ONCE with the given inputs (auto-filled from the version examples + ' +
      'descriptor defaults where absent) and return the outcome — outputs, ctx.log lines, a ' +
      'classified error, cost, duration. Persists nothing. Use to check a draft you just edited.',
    inputSchema: obj(
      {
        slug: str(),
        version: str('semver, e.g. 0.1.0'),
        inputs: { type: 'object', description: 'optional input values; missing ones are auto-filled' },
      },
      ['slug', 'version'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      const i = z
        .object({ slug: z.string(), version: z.string(), inputs: z.record(z.string(), z.unknown()).optional() })
        .parse(input);
      const { block, version } = await loadBlockVersion(i.slug, i.version);
      const inputs = { ...sampleInputsFor(version.descriptor, version.examples), ...(i.inputs ?? {}) };
      const outcome = await simulateBlockVersion(
        block,
        version,
        inputs,
        ctx.userId,
        ctx.tenantId,
        ctx.db,
      );
      // `cost` is tenant_admin+ on the wire (run-cost-visibility.ts), same as the REST route.
      return { ...simulateOutcomeFor(ctx.roles, outcome), inputs };
    },
  },
  {
    name: 'run_block_test',
    description:
      "Run the block version's saved test suite (or one test by id) through the real runner and " +
      'return per-test pass/fail/error + diffs + the testsPassing rollup. Use after editing a draft ' +
      'to check whether the fix made the tests green. Developer-only.',
    inputSchema: obj(
      { slug: str(), version: str('semver'), test_id: str('optional: run just this test') },
      ['slug', 'version'],
    ),
    surface: 'backend',
    handler: async (input, ctx) => {
      const i = z
        .object({ slug: z.string(), version: z.string(), test_id: z.string().optional() })
        .parse(input);
      const { block, version } = await loadBlockVersion(i.slug, i.version);
      authorizeBlockWriteByRoles(ctx.roles, ctx.tenantId, block);
      return runBlockTests(version.id, {
        ctxUserId: ctx.userId,
        tenantId: ctx.tenantId,
        testId: i.test_id,
        database: ctx.db,
      });
    },
  },
  // ---- block authoring (frontend): propose a draft into the editor for the developer to
  //      review + Create. In a browser session the loop emits a frontend-tool-call and the
  //      editor pre-fills its buffers; the headless fallback (tests / browserless MCP) persists
  //      the draft via the same authoring service create_block uses. Developer-gated. ----
  {
    name: 'propose_block_draft',
    description:
      'Propose a NEW block draft to the developer in the block editor: pre-fills the editor ' +
      'buffers (descriptor, TypeScript source, docs, examples) for them to review and click ' +
      'Create. Use this in block-authoring mode INSTEAD of create_block — the developer reviews ' +
      'and creates. Provide a complete descriptor (typed inputs/outputs/capabilities) and a ' +
      'runnable source_ts (export default { descriptor, run }).',
    inputSchema: obj(
      {
        name: str('display name'),
        slug: str('kebab-case slug (optional; derived from name if omitted)'),
        category: { type: 'string', enum: [...BLOCK_CATEGORIES] },
        description: str(),
        descriptor: { type: 'object', description: 'BlockDescriptor: { inputs, outputs, capabilities }' },
        source_ts: str('the block module TypeScript source (export default { descriptor, run })'),
        docs_md: str('markdown documentation'),
        examples: { type: 'array', description: 'optional example { name, inputs, expectedOutputs } objects' },
      },
      ['name', 'category', 'descriptor', 'source_ts'],
    ),
    surface: 'frontend',
    handler: async (input, ctx) => {
      // Headless fallback: only reachable via the MCP host (tests / browserless). In a browser
      // session the loop routes this to the editor and never calls the handler.
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      const i = z
        .object({
          name: z.string(),
          slug: z.string().optional(),
          category: z.enum(['data', 'ai', 'logic', 'output', 'ui']),
          description: z.string().optional(),
          descriptor: z.record(z.string(), z.unknown()).optional(),
          source_ts: z.string(),
          docs_md: z.string().optional(),
        })
        .parse(input);
      const slug = (i.slug && i.slug.trim()) || slugifyName(i.name);
      const scope = resolveCreateScopeByRoles(ctx.userId, ctx.roles, ctx.tenantId);
      const created = await createBlockCore(scope, {
        slug,
        name: i.name,
        category: i.category,
        description: i.description,
        source_ts: i.source_ts,
        docs_md: i.docs_md,
        descriptor: i.descriptor as unknown as BlockDescriptor | undefined,
      });
      return { slug: created.block.slug, version: created.version.version, created: true };
    },
  },
  // ---- block fix (frontend): propose a PATCHED source_ts into the open draft for the developer
  //      to review as a diff and Apply. In a browser session the editor shows the diff; the
  //      headless fallback (tests / browserless, when slug+version are given) saves the draft via
  //      the same service save_block_version uses. Developer-gated. ----
  {
    name: 'propose_block_patch',
    description:
      'Propose a FIXED version of the block source to the developer: shows a reviewable diff of the ' +
      'current vs proposed TypeScript in the editor for them to Apply. Use this in fix mode to hand ' +
      'back a corrected `source_ts` (a complete module: export default { descriptor, run }). Include ' +
      'a short `summary` of what you changed and `rationale` for why.',
    inputSchema: obj(
      {
        source_ts: str('the complete corrected block module TypeScript source'),
        summary: str('one-line summary of the change'),
        rationale: str('why this fixes the failure'),
        slug: str('optional: target block slug (headless apply only)'),
        version: str('optional: target draft version (headless apply only)'),
      },
      ['source_ts'],
    ),
    surface: 'frontend',
    handler: async (input, ctx) => {
      // Headless fallback: only reachable via the MCP host (tests / browserless). In a browser the
      // loop routes this to the editor, which shows a diff and never calls the handler. We persist
      // only when the agent supplied slug+version to target a draft.
      if (!isDeveloperRoles(ctx.roles)) throw forbidden('developer_required', 'Developer role required');
      const i = z
        .object({
          source_ts: z.string(),
          summary: z.string().optional(),
          rationale: z.string().optional(),
          slug: z.string().optional(),
          version: z.string().optional(),
        })
        .parse(input);
      if (!i.slug || !i.version) return { applied: false, reason: 'no_editor_session' };
      const { block, version } = await loadBlockVersion(i.slug, i.version);
      const { isGlobal } = authorizeBlockWriteByRoles(ctx.roles, ctx.tenantId, block);
      const updated = await saveVersionCore({ isGlobal }, version, { source_ts: i.source_ts });
      return { slug: block.slug, version: updated.version, status: updated.status, applied: true };
    },
  },
  // ---- frontend (edit) tools: definitions + headless fallback handlers ----
  {
    name: 'add_node',
    description: 'Add a block to the flow as a new node on the canvas.',
    inputSchema: obj({ slug: str('block slug to add'), position }, ['slug']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), slug: z.string(), position: posOpt }).parse(input);
      return flowEdit.addNode({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, {
        slug: i.slug,
        position: i.position,
      }, ctx.db);
    },
  },
  {
    name: 'insert_node',
    description: 'Insert a block into an existing edge (split source→target with the new block between).',
    inputSchema: obj({ slug: str(), edgeId: str(), position }, ['slug', 'edgeId']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), slug: z.string(), edgeId: z.string(), position: posOpt }).parse(input);
      return flowEdit.insertNode({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, {
        slug: i.slug,
        edgeId: i.edgeId,
        position: i.position,
      }, ctx.db);
    },
  },
  {
    name: 'remove_node',
    description: 'Remove a node (and its incident edges) from the flow.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), nodeId: z.string() }).parse(input);
      return flowEdit.removeNode({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, { nodeId: i.nodeId }, ctx.db);
    },
  },
  {
    name: 'connect_nodes',
    description: 'Connect one node’s output port to another node’s input port.',
    inputSchema: obj(
      { source: str(), sourceHandle: str(), target: str(), targetHandle: str() },
      ['source', 'sourceHandle', 'target', 'targetHandle'],
    ),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z
        .object({
          flowId: z.string().uuid(),
          source: z.string(),
          sourceHandle: z.string(),
          target: z.string(),
          targetHandle: z.string(),
        })
        .parse(input);
      return flowEdit.connectNodes({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, i, ctx.db);
    },
  },
  {
    name: 'disconnect_nodes',
    description: 'Remove an edge between two nodes.',
    inputSchema: obj({ edgeId: str() }, ['edgeId']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), edgeId: z.string() }).parse(input);
      return flowEdit.disconnectNodes({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, { edgeId: i.edgeId }, ctx.db);
    },
  },
  {
    name: 'configure_node',
    description: 'Set a config/literal input value on a node.',
    inputSchema: obj({ nodeId: str(), key: str(), value: {} }, ['nodeId', 'key', 'value']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), nodeId: z.string(), key: z.string(), value: z.unknown() }).parse(input);
      return flowEdit.configureNode({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, i, ctx.db);
    },
  },
  {
    name: 'move_node',
    description: 'Move a node to a new position on the canvas.',
    inputSchema: obj({ nodeId: str(), position }, ['nodeId', 'position']),
    surface: 'frontend',
    handler: async (input, ctx) => {
      const i = z.object({ flowId: z.string().uuid(), nodeId: z.string(), position: z.object({ x: z.number(), y: z.number() }) }).parse(input);
      return flowEdit.moveNode({ userId: ctx.userId, actorId: ctx.userId }, i.flowId, i, ctx.db);
    },
  },
];

/** The set of edit tools the frontend driver fulfils live. The agent loop routes a
 *  tool call to the browser (frontend-tool-call) iff its name is in here. */
export const FRONTEND_TOOL_NAMES: ReadonlySet<string> = new Set(
  PLATFORM_TOOLS.filter((t) => t.surface === 'frontend').map((t) => t.name),
);

export function getPlatformTool(name: string): PlatformToolDef | undefined {
  return PLATFORM_TOOLS.find((t) => t.name === name);
}
