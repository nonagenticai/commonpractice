// src/flow-templates/service.ts — flow templates (0108): whole flows a reader can start from.
//
// Three operations carry the feature, and each has one rule that matters:
//
//   • LIST/GET — global (tenant_id NULL) + the caller's own tenant, never archived. Every template is
//     reported with `available` + `missingBlocks`: a template is only useful if every block it names
//     resolves to a block the CALLER can read (global, or their own tenant's), not archived, with a
//     published version. The tenant predicate is written out in SQL as well as enforced by RLS, so the
//     owner-role test connection cannot make a cross-tenant read look correct.
//
//   • SAVE — copies a flow the caller owns. A GLOBAL template (super_admin, scope=global) may name
//     only GLOBAL blocks — a tenant block in a starter would be a dead node for every other tenant and
//     would publish one tenant's block slug to all of them. Its node config is RESET to each block's
//     declared defaults (see `structureOnlyGraph`): an allowlist of structure, never a guess at which
//     values are secret. Refusing instead would make global saving impractical, since nearly every real
//     flow binds a dataset; the block's own `default` is the shape Phase-3 data blocks already rely on.
//
//   • USE — instantiates a NEW draft flow owned by the caller. The template row is never written.
//     The graph is deep-copied with FRESH node and edge ids (edges and foreach `parentId` remapped)
//     and every block node is re-bound by slug to a block the caller can read. A block that does not
//     resolve does NOT fail the copy: the node stays (so the reader sees what the template meant) and
//     its slug is returned in `missingBlocks`, the same way the builder's unresolved-blocks notice
//     treats an unknown slug.
import { and, eq, inArray, isNull, or, sql, asc } from 'drizzle-orm';
import { db, flowTemplates, flows, buildingBlocks, blockVersions } from '../db/client';
import type { FlowEdge, FlowGraph, FlowNode } from '../db/flow-types';
import type { FlowTemplate } from '../db/schema';
import type { BlockDescriptor } from '../db/block-types';
import { getTranslationsBatch } from '../db/translations';

/** `content_translations.entity_type` for a template's name/description. */
export const FLOW_TEMPLATE_I18N = 'flow_template';
export const FLOW_TEMPLATE_I18N_FIELDS = ['name', 'description'] as const;

/** Stands in for the block ids of a node whose block could not be resolved. A valid uuid that names
 *  no row, so a run or publish reports `missing_block_version` for that node by slug, instead of a
 *  500 from casting '' to uuid. Empty strings would also fail the builder's autosave schema. */
export const UNRESOLVED_BLOCK_ID = '00000000-0000-0000-0000-000000000000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isBlockNode = (n: FlowNode) => n.kind !== 'foreach';

/** Unique, sorted slugs of the graph's block nodes (foreach containers run no block). */
export function deriveBlockSlugs(graph: FlowGraph): string[] {
  return [...new Set((graph.nodes ?? []).filter(isBlockNode).map((n) => n.slug))].sort();
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Deep copy with FRESH ids, in the builder's own id shapes (`n_…`, `fe_…`, `e_…`). Edges' source /
 * target and every body node's `parentId` are remapped through the same table. An edge or parentId
 * that points at a node not in the graph is dangling already; it is dropped rather than carried into
 * the new flow pointing at nothing.
 */
export function remapGraphIds(graph: FlowGraph): FlowGraph {
  const copy = structuredClone(graph) as FlowGraph;
  const ids = new Map<string, string>();
  for (const n of copy.nodes ?? []) {
    ids.set(n.id, `${n.kind === 'foreach' ? 'fe' : 'n'}_${shortId()}`);
  }
  const nodes = (copy.nodes ?? []).map((n) => {
    const next: FlowNode = { ...n, id: ids.get(n.id)! };
    if (n.parentId !== undefined) {
      const parent = ids.get(n.parentId);
      if (parent) next.parentId = parent;
      else delete next.parentId;
    }
    return next;
  });
  const edges: FlowEdge[] = [];
  for (const e of copy.edges ?? []) {
    const source = ids.get(e.source);
    const target = ids.get(e.target);
    if (!source || !target) continue;
    edges.push({ ...e, id: `e_${shortId()}`, source, target });
  }
  return { nodes, edges };
}

interface ReadableBlock {
  id: string;
  slug: string;
  name: string;
  category: FlowNode['category'];
  tenantId: string | null;
  currentVersionId: string;
}

/**
 * Blocks the caller can use, by slug: global or the caller's tenant, not archived, with a published
 * current version. The tenant predicate is explicit (RLS repeats it for cp_app).
 */
export async function readableBlocksBySlug(
  slugs: string[],
  tenantId: string,
): Promise<Map<string, ReadableBlock[]>> {
  const out = new Map<string, ReadableBlock[]>();
  if (!slugs.length) return out;
  const rows = await db
    .select({
      id: buildingBlocks.id,
      slug: buildingBlocks.slug,
      name: buildingBlocks.name,
      category: buildingBlocks.category,
      tenantId: buildingBlocks.tenant_id,
      currentVersionId: buildingBlocks.current_version_id,
    })
    .from(buildingBlocks)
    .where(
      and(
        inArray(buildingBlocks.slug, slugs),
        eq(buildingBlocks.archived, false),
        sql`${buildingBlocks.current_version_id} IS NOT NULL`,
        or(isNull(buildingBlocks.tenant_id), eq(buildingBlocks.tenant_id, tenantId)),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.slug) ?? [];
    list.push({ ...r, category: r.category as FlowNode['category'], currentVersionId: r.currentVersionId! });
    out.set(r.slug, list);
  }
  return out;
}

export function missingSlugs(slugs: string[], readable: Map<string, ReadableBlock[]>): string[] {
  return slugs.filter((s) => !readable.has(s));
}

/**
 * Re-bind each block node to a block the caller can read. Preference: the block the node already
 * pins (when readable) → the global block with that slug → the caller's tenant block. The pinned
 * VERSION is kept when it belongs to the chosen block; otherwise the block's current version is used.
 * Unresolvable nodes keep their ids, or get `UNRESOLVED_BLOCK_ID` when they had none (seeded starters
 * carry slugs only), and are reported in `missing`.
 */
export async function rebindGraph(
  graph: FlowGraph,
  tenantId: string,
): Promise<{ graph: FlowGraph; missing: string[] }> {
  const slugs = deriveBlockSlugs(graph);
  const readable = await readableBlocksBySlug(slugs, tenantId);
  const pinned = [
    ...new Set(graph.nodes.filter(isBlockNode).map((n) => n.blockVersionId).filter((v) => UUID_RE.test(v))),
  ];
  const versionBlock = new Map<string, string>();
  if (pinned.length) {
    const rows = await db
      .select({ id: blockVersions.id, blockId: blockVersions.block_id })
      .from(blockVersions)
      .where(inArray(blockVersions.id, pinned));
    for (const r of rows) versionBlock.set(r.id, r.blockId);
  }
  const nodes = graph.nodes.map((n) => {
    if (!isBlockNode(n)) return n;
    const candidates = readable.get(n.slug);
    if (!candidates?.length) {
      return {
        ...n,
        blockId: n.blockId || UNRESOLVED_BLOCK_ID,
        blockVersionId: n.blockVersionId || UNRESOLVED_BLOCK_ID,
      };
    }
    const chosen =
      candidates.find((c) => c.id === n.blockId) ??
      candidates.find((c) => c.tenantId === null) ??
      candidates[0]!;
    const keepVersion = chosen.id === n.blockId && versionBlock.get(n.blockVersionId) === chosen.id;
    return {
      ...n,
      blockId: chosen.id,
      blockVersionId: keepVersion ? n.blockVersionId : chosen.currentVersionId,
      category: chosen.category,
      label: n.label || chosen.name,
    };
  });
  return { graph: { nodes, edges: graph.edges }, missing: missingSlugs(slugs, readable) };
}

/** A port name, as the builder writes them (`in`, `rows`, `claim_text`). */
const PORT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * For a GLOBAL template: keep the STRUCTURE of the flow and nothing the saving tenant typed into it.
 *
 * ⛔ This is deliberately an ALLOWLIST, not secret detection. The first version dropped keys that
 * LOOKED tenant-owned (dataset inputs, `*token*`/`*api_key*` names) and kept everything else — which
 * shipped a `pii: true` `document` full of claimant text, `file: {ref:'tenantA-claim-778'}`,
 * `customer_id`, `authorization: 'Bearer sk-live…'`, nested `headers: {'X-Api-Key': …}`,
 * `webhook_url` and `dsn: 'postgres://u:p@…'` to every organisation. No name or value heuristic can
 * know what a block's free-form input holds, so a starter carries none of it:
 *
 *  - every block node's `config` is RESET to its block descriptor's declared `default`s (the block's
 *    own platform content); an input with no default is left unset, and a node whose descriptor cannot
 *    be read gets `{}`;
 *  - a node is rebuilt from the FlowNode fields only (id, blockId, blockVersionId, slug, label,
 *    category, position, kind, parentId, loop), so a key smuggled onto the node object does not ride
 *    along; an edge keeps only id/source/sourceHandle/target/targetHandle;
 *  - a `foreach` container keeps `parentId` wiring and `loop` — `rowsInput` is the port the rowset
 *    arrives on and `maxIterations` the bound, both structural (they decide WHAT runs, not with which
 *    data). `rowsInput` must be a port name and `maxIterations` a finite number, or it is dropped. Its
 *    `config` is `{}`: the executor reads a container's settings from `loop`, and its `config` can only
 *    hold a LITERAL rowset — the saving tenant's rows. A starter's rows arrive over the wired edge.
 *
 * Labels and positions are kept: they are the template's meaning and layout. Returns the graph and,
 * per node, the config keys whose saved value did not survive, so the response can say so.
 * Organisation (tenant) templates do NOT come through here — they stay in the saving tenant.
 */
export function structureOnlyGraph(
  graph: FlowGraph,
  descriptors: Map<string, BlockDescriptor>,
): { graph: FlowGraph; stripped: { nodeId: string; key: string }[] } {
  const stripped: { nodeId: string; key: string }[] = [];
  const nodes = (graph.nodes ?? []).map((n): FlowNode => {
    let config: Record<string, unknown> = {};
    if (isBlockNode(n)) {
      const inputs = descriptors.get(n.blockVersionId)?.inputs ?? {};
      for (const [key, spec] of Object.entries(inputs)) {
        if (spec && spec.default !== undefined) config[key] = structuredClone(spec.default);
      }
    }
    for (const [key, value] of Object.entries(n.config ?? {})) {
      if (JSON.stringify(config[key]) !== JSON.stringify(value)) stripped.push({ nodeId: n.id, key });
    }
    const x = Number(n.position?.x);
    const y = Number(n.position?.y);
    const next: FlowNode = {
      id: String(n.id),
      blockId: String(n.blockId ?? ''),
      blockVersionId: String(n.blockVersionId ?? ''),
      slug: String(n.slug ?? ''),
      label: String(n.label ?? ''),
      category: n.category,
      config,
      position: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 },
    };
    if (n.kind === 'foreach' || n.kind === 'block') next.kind = n.kind;
    if (typeof n.parentId === 'string') next.parentId = n.parentId;
    if (n.kind === 'foreach' && n.loop && typeof n.loop === 'object') {
      const loop: NonNullable<FlowNode['loop']> = {};
      if (typeof n.loop.rowsInput === 'string' && PORT_RE.test(n.loop.rowsInput)) loop.rowsInput = n.loop.rowsInput;
      if (typeof n.loop.maxIterations === 'number' && Number.isFinite(n.loop.maxIterations)) {
        loop.maxIterations = n.loop.maxIterations;
      }
      next.loop = loop;
    }
    return next;
  });
  const edges: FlowEdge[] = (graph.edges ?? []).map((e) => ({
    id: String(e.id),
    source: String(e.source),
    sourceHandle: String(e.sourceHandle ?? ''),
    target: String(e.target),
    targetHandle: String(e.targetHandle ?? ''),
  }));
  return { graph: { nodes, edges }, stripped };
}

/** Slugs of block nodes whose pinned block is NOT global (or does not exist). */
export async function nonGlobalBlockSlugs(graph: FlowGraph): Promise<string[]> {
  const blockNodes = graph.nodes.filter(isBlockNode);
  const ids = [...new Set(blockNodes.map((n) => n.blockId).filter((v) => UUID_RE.test(v)))];
  const global = new Set<string>();
  if (ids.length) {
    const rows = await db
      .select({ id: buildingBlocks.id })
      .from(buildingBlocks)
      .where(and(inArray(buildingBlocks.id, ids), isNull(buildingBlocks.tenant_id)));
    for (const r of rows) global.add(r.id);
  }
  return [...new Set(blockNodes.filter((n) => !global.has(n.blockId)).map((n) => n.slug))].sort();
}

export async function descriptorsFor(graph: FlowGraph): Promise<Map<string, BlockDescriptor>> {
  const ids = [
    ...new Set(graph.nodes.filter(isBlockNode).map((n) => n.blockVersionId).filter((v) => UUID_RE.test(v))),
  ];
  const out = new Map<string, BlockDescriptor>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: blockVersions.id, descriptor: blockVersions.descriptor })
    .from(blockVersions)
    .where(inArray(blockVersions.id, ids));
  for (const r of rows) out.set(r.id, r.descriptor as BlockDescriptor);
  return out;
}

export interface FlowTemplateView {
  id: string;
  name: string;
  description: string;
  category: string;
  scope: 'global' | 'tenant';
  blockCount: number;
  available: boolean;
  missingBlocks: string[];
  createdBy: string | null;
  createdAt: Date;
}

/** Visible-to-caller predicate: global or own tenant, not archived. */
function visibleTo(tenantId: string) {
  return and(
    isNull(flowTemplates.archived_at),
    or(isNull(flowTemplates.tenant_id), eq(flowTemplates.tenant_id, tenantId)),
  );
}

/** Who is reading. `superAdmin` decides whether a STARTER names its creator (see `toViews`). */
export interface TemplateViewer {
  superAdmin: boolean;
}

async function toViews(
  rows: FlowTemplate[],
  tenantId: string,
  locale: string,
  viewer: TemplateViewer,
): Promise<FlowTemplateView[]> {
  const allSlugs = [...new Set(rows.flatMap((r) => r.block_slugs ?? []))];
  const readable = await readableBlocksBySlug(allSlugs, tenantId);
  const tx = await getTranslationsBatch(
    FLOW_TEMPLATE_I18N,
    rows.map((r) => r.id),
    locale,
    [...FLOW_TEMPLATE_I18N_FIELDS],
  );
  return rows.map((r) => {
    const t = tx.get(r.id) ?? {};
    const missing = missingSlugs(r.block_slugs ?? [], readable);
    return {
      id: r.id,
      name: t.name ?? r.name,
      description: t.description ?? r.description,
      category: r.category,
      scope: r.tenant_id === null ? 'global' : 'tenant',
      blockCount: (r.graph?.nodes ?? []).filter(isBlockNode).length,
      available: missing.length === 0,
      missingBlocks: missing,
      // ⛔ A STARTER's creator is a platform admin's user id, and starters are listed to EVERY
      // organisation: only a super_admin sees it. An organisation template keeps it — it is a
      // colleague in the same tenant, and `canArchive` needs it.
      createdBy: r.tenant_id === null && !viewer.superAdmin ? null : r.created_by,
      createdAt: r.created_at,
    };
  });
}

export async function listFlowTemplates(
  tenantId: string,
  locale: string,
  viewer: TemplateViewer,
): Promise<FlowTemplateView[]> {
  const rows = await db
    .select()
    .from(flowTemplates)
    .where(visibleTo(tenantId))
    // Starters first, then the organisation's own; stable by name within each.
    .orderBy(sql`${flowTemplates.tenant_id} IS NOT NULL`, asc(flowTemplates.name));
  return toViews(rows, tenantId, locale, viewer);
}

/** One visible template row (raw), or null. */
export async function loadVisibleTemplate(id: string, tenantId: string): Promise<FlowTemplate | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(flowTemplates)
    .where(and(eq(flowTemplates.id, id), visibleTo(tenantId)));
  return row ?? null;
}

export async function viewOf(
  row: FlowTemplate,
  tenantId: string,
  locale: string,
  viewer: TemplateViewer,
): Promise<FlowTemplateView> {
  return (await toViews([row], tenantId, locale, viewer))[0]!;
}

/**
 * Create a new draft flow for `ownerId` in `tenantId` from a template's (or a solution's) graph.
 * Never writes the source. Returns the flow id and the slugs that did not resolve.
 *
 * `intoFlowId` — the EMPTY draft the reader is looking at. /build opens a blank draft for a reader
 * with no flows, so "use a template" from that canvas used to leave TWO flows behind: the blank
 * "Untitled flow" and the template's copy (a brand-new org on prod, 2026-10-16). When `intoFlowId`
 * names a draft of this owner in this tenant whose graph has no nodes and no edges, the template is
 * written INTO it instead. The emptiness check is in the UPDATE's own WHERE, so a node the reader's
 * autosave lands first makes the UPDATE match nothing and this falls back to a new flow — never an
 * overwrite of work. Anything else about `intoFlowId` (someone else's, submitted, not empty, absent)
 * also falls back to a new flow; it is a hint, never a way to write to a flow.
 */
export async function instantiateGraph(
  source: FlowGraph,
  opts: { name: string; description: string; ownerId: string; tenantId: string; intoFlowId?: string },
): Promise<{ flowId: string; missingBlocks: string[] }> {
  const fresh = remapGraphIds(source);
  const { graph, missing } = await rebindGraph(fresh, opts.tenantId);
  if (opts.intoFlowId) {
    const [reused] = await db
      .update(flows)
      .set({
        name: opts.name.slice(0, 140),
        description: opts.description.slice(0, 2000),
        graph,
        last_saved_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(flows.id, opts.intoFlowId),
          eq(flows.owner_id, opts.ownerId),
          eq(flows.tenant_id, opts.tenantId),
          eq(flows.status, 'draft'),
          sql`jsonb_array_length(coalesce(${flows.graph}->'nodes', '[]'::jsonb)) = 0`,
          sql`jsonb_array_length(coalesce(${flows.graph}->'edges', '[]'::jsonb)) = 0`,
        ),
      )
      .returning({ id: flows.id });
    if (reused) return { flowId: reused.id, missingBlocks: missing };
  }
  const [flow] = await db
    .insert(flows)
    .values({
      name: opts.name.slice(0, 140),
      description: opts.description.slice(0, 2000),
      owner_id: opts.ownerId,
      tenant_id: opts.tenantId,
      graph,
      last_saved_at: new Date(),
    })
    .returning({ id: flows.id });
  return { flowId: flow!.id, missingBlocks: missing };
}
