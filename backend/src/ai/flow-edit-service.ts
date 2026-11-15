// src/ai/flow-edit-service.ts — owner-scoped, audited, snapshotting mutations of a
// flow's graph (SPEC §5A: flow-edit tools). This is the HEADLESS fallback used by
// browserless MCP clients and the tests; in a live browser session the SAME edits
// are applied client-side by the agent driver through the builder store (Layer 3),
// so the human and the agent share one edit path + one source of truth (flows.graph).
//
// Every mutation: (1) loads the flow the caller OWNS (404 otherwise), (2) computes
// the new graph, (3) writes a flow_snapshots row (source='ai') with a human summary
// for the undo/diff trail, (4) persists flows.graph, (5) prunes to the last N
// snapshots, (6) records an audit row. Structure is validated (non-blocking) and
// returned so a half-built graph still persists (mirrors the PATCH /api/flows rule).
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db as defaultDb, flows, flowSnapshots } from '../db/client';
import type { Flow } from '../db/schema';
import type { FlowGraph, FlowNode, FlowEdge } from '../db/flow-types';
import { validateGraphStructure, type GraphValidation } from '../exec/flow-validate';
import { recordAudit } from '../host/audit-service';
import { resolveBlockEntry } from './block-catalog-service';
import { notFound, badRequest } from '../utils/http';

type Db = typeof defaultDb;
/** A transaction handle (db.transaction's callback arg). Accepts the root db too. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const SNAPSHOT_KEEP = 50; // last N snapshots per flow

/**
 * WHICH of the nine snapshot-summary templates wrote a row (0071).
 *
 * ⛔ THIS UNION IS THE CONTRACT. `summary` stays English on the wire — it is what an MCP/LLM client
 * reads back and it is the permanent fallback — but the BROWSER renders the reader's own language
 * off this code plus `FlowSummaryParams` (`frontend/src/lib/i18n/flow-summary-label.ts`). A TENTH
 * template added without a member here would ship an English sentence into seven non-English
 * locales, silently, on /build — the product's primary authoring surface. That is what
 * `frontend/src/lib/i18n/flow-summary-label.backend-contract.test.ts` reds on.
 *
 * Two of the nine live in `../routes/flows.ts` (the manual checkpoint default and the restore
 * sentence), not here; they import this union so there is exactly one list.
 */
export type FlowSummaryCode =
  | 'flow_summary_added'
  | 'flow_summary_connected'
  | 'flow_summary_disconnected'
  | 'flow_summary_removed'
  | 'flow_summary_configured'
  | 'flow_summary_moved'
  | 'flow_summary_inserted'
  | 'flow_summary_manual_checkpoint'
  | 'flow_summary_restored';

/**
 * The machine fields a summary sentence interpolates — the UNION across all nine templates, every
 * field optional because no template uses more than four of them.
 *
 * ⛔ RAW FIELDS, NEVER PRE-JOINED AND NEVER PRE-FORMATTED. `connected` ships `source`,
 * `sourceHandle`, `target`, `targetHandle` as four separate values even though the reader sees two
 * compounds (`source.sourceHandle → target.targetHandle`): the JOIN is a rendering decision and it
 * belongs with the bidi isolation that has to wrap it, in the browser. Likewise `at` is the RAW ISO
 * instant, not "Aug 7, 2026" — a pre-formatted date on the wire is a second source of truth in a
 * language the writer had to guess.
 *
 * ⚠️ `export type`, NOT `export interface`, AND THAT IS LOAD-BEARING — same trap `BudgetAlertData`
 * documents in host/budget-service.ts. TypeScript gives an object type ALIAS an implicit index
 * signature and refuses one to an interface, so the drizzle `jsonb().$type<Record<string,
 * unknown>>()` insert only typechecks against the alias. Written as an interface this file does not
 * compile (measured: TS2769, "Index signature for type 'string' is missing").
 */
export type FlowSummaryParams = {
  slug?: string;
  nodeId?: string;
  edgeId?: string;
  key?: string;
  source?: string;
  sourceHandle?: string;
  target?: string;
  targetHandle?: string;
  /** Restore only: the RAW ISO instant of the snapshot that was rolled back to. */
  at?: string;
};

/**
 * Write a flow_snapshots row and prune to the last SNAPSHOT_KEEP per flow.
 * The single source of truth for the snapshot trail — used by the AI/headless edit
 * path (applyEdit) AND the manual checkpoint / restore routes (routes/flows.ts), so
 * the 50-cap and row shape never drift between callers. Must run inside a txn.
 *
 * `code`/`params` are REQUIRED PARAMETERS, deliberately nullable rather than optional: the one
 * caller that legitimately writes no code (a checkpoint whose text the USER typed) has to say so
 * out loud, and a new caller cannot forget them by omission.
 */
export async function writeSnapshot(
  tx: Tx,
  flowId: string,
  graph: FlowGraph,
  source: 'manual' | 'ai',
  summary: string,
  createdBy: string | null,
  code: FlowSummaryCode | null,
  params: FlowSummaryParams | null,
): Promise<void> {
  await tx.insert(flowSnapshots).values({
    flow_id: flowId,
    graph,
    source,
    summary,
    created_by: createdBy,
    summary_code: code,
    summary_params: params,
  });
  await tx.execute(
    sql`DELETE FROM flow_snapshots WHERE flow_id = ${flowId} AND id NOT IN (
          SELECT id FROM flow_snapshots WHERE flow_id = ${flowId}
          ORDER BY created_at DESC LIMIT ${SNAPSHOT_KEEP}
        )`,
  );
}

export interface EditContext {
  userId: string; // the flow owner (scopes the load)
  actorId?: string | null; // who triggered the edit (user or agent); audit actor
  source?: 'manual' | 'ai';
}

/**
 * ⛔ THE EXPORTED SHAPE, AND `summary` STAYS ENGLISH ON IT. `src/ai/mcp/tools.ts` returns this
 * object straight to an MCP/LLM client (seven call sites), where an English sentence is the CORRECT
 * output and `flow_summary_*` codes would be noise. So `code`/`params` are deliberately NOT here —
 * they travel on the INTERNAL `MutateResult` below, into the row, and reach the browser through
 * `snapshotSummary()`/`getSnapshot` in routes/flows.ts.
 */
export interface EditResult {
  graph: FlowGraph;
  summary: string;
  validation: GraphValidation;
  nodeId?: string;
  edgeId?: string;
}

/**
 * What each edit's `mutate()` hands back — INTERNAL, and wider than `EditResult` by exactly the two
 * i18n fields (see the note above). Every arm must supply both: the English `summary` for the model
 * and the code+params for the reader.
 */
interface MutateResult {
  graph: FlowGraph;
  summary: string;
  code: FlowSummaryCode;
  params: FlowSummaryParams;
  nodeId?: string;
  edgeId?: string;
}

function genNodeId(): string {
  return `n_${crypto.randomUUID().slice(0, 8)}`;
}
function genEdgeId(): string {
  return `e_${crypto.randomUUID().slice(0, 8)}`;
}

async function loadOwnedFlow(id: string, userId: string, db: Db): Promise<Flow> {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.owner_id, userId)));
  if (!flow) throw notFound('flow_not_found', `No flow '${id}'`);
  return flow;
}

/** The shared edit transaction: snapshot → persist → prune → audit. */
async function applyEdit(
  ctx: EditContext,
  flowId: string,
  mutate: (graph: FlowGraph) => MutateResult,
  db: Db,
): Promise<EditResult> {
  const source = ctx.source ?? 'ai';
  const result = await db.transaction(async (tx) => {
    const flow = await loadOwnedFlow(flowId, ctx.userId, tx as unknown as Db);
    const current = (flow.graph ?? { nodes: [], edges: [] }) as FlowGraph;
    const { graph, summary, code, params, nodeId, edgeId } = mutate(current);

    // `code`/`params` go into the ROW and stop there — the returned `EditResult` below keeps the
    // MCP shape it has always had.
    await writeSnapshot(tx, flowId, graph, source, summary, ctx.actorId ?? null, code, params);

    await tx
      .update(flows)
      .set({ graph, last_saved_at: new Date(), updated_at: new Date() })
      .where(eq(flows.id, flowId));

    return { graph, summary, nodeId, edgeId };
  });

  await recordAudit(
    {
      actorId: ctx.actorId ?? null,
      action: 'flow.edit',
      category: 'system',
      targetType: 'flow',
      targetId: flowId,
      result: result.summary,
      resultTone: 'ok',
      metadata: { source },
    },
    db,
  );

  return { ...result, validation: validateGraphStructure(result.graph) };
}

// ---- the individual edit operations (1:1 with the frontend edit tools) ----

export async function addNode(
  ctx: EditContext,
  flowId: string,
  input: { slug: string; position?: { x: number; y: number } },
  db: Db = defaultDb,
): Promise<EditResult> {
  const entry = await resolveBlockEntry(input.slug, db);
  const id = genNodeId();
  const node: FlowNode = {
    id,
    blockId: entry.blockId,
    blockVersionId: entry.blockVersionId,
    slug: entry.slug,
    label: entry.name,
    category: entry.category,
    config: {},
    position: input.position ?? { x: 320, y: 200 },
  };
  return applyEdit(
    ctx,
    flowId,
    (g) => ({
      graph: { nodes: [...g.nodes, node], edges: g.edges },
      summary: `added ${entry.slug}`,
      code: 'flow_summary_added',
      params: { slug: entry.slug },
      nodeId: id,
    }),
    db,
  );
}

export async function connectNodes(
  ctx: EditContext,
  flowId: string,
  input: { source: string; sourceHandle: string; target: string; targetHandle: string },
  db: Db = defaultDb,
): Promise<EditResult> {
  const id = genEdgeId();
  return applyEdit(
    ctx,
    flowId,
    (g) => {
      const ids = new Set(g.nodes.map((n) => n.id));
      if (!ids.has(input.source) || !ids.has(input.target)) {
        // `unknown_node` carries TWO sentences (see configureNode below), so it needs a
        // discriminator. This arm names no node: either endpoint may be the missing one.
        throw badRequest('unknown_node', 'connect_nodes references a missing node', {
          reason: 'connect_endpoint',
        });
      }
      const edge: FlowEdge = {
        id,
        source: input.source,
        sourceHandle: input.sourceHandle,
        target: input.target,
        targetHandle: input.targetHandle,
      };
      return {
        graph: { nodes: g.nodes, edges: [...g.edges, edge] },
        summary: `connected ${input.source}.${input.sourceHandle} → ${input.target}.${input.targetHandle}`,
        code: 'flow_summary_connected',
        // ⛔ FOUR RAW FIELDS, NOT TWO PRE-JOINED `a.b` STRINGS. The reader sees two compounds, but
        // joining them here would put the `.` on the wire OUTSIDE the bidi isolate the browser has
        // to wrap the compound in — and in ar/he an isolate-neutral-isolate run swaps the halves.
        // The join belongs with the isolation, in flow-summary-label.ts. The `→` is not here at
        // all: it is punctuation inside a sentence, so the CATALOGS own it and ar/he render `←`.
        params: {
          source: input.source,
          sourceHandle: input.sourceHandle,
          target: input.target,
          targetHandle: input.targetHandle,
        },
        edgeId: id,
      };
    },
    db,
  );
}

export async function disconnectNodes(
  ctx: EditContext,
  flowId: string,
  input: { edgeId: string },
  db: Db = defaultDb,
): Promise<EditResult> {
  return applyEdit(
    ctx,
    flowId,
    (g) => ({
      graph: { nodes: g.nodes, edges: g.edges.filter((e) => e.id !== input.edgeId) },
      summary: `disconnected edge ${input.edgeId}`,
      code: 'flow_summary_disconnected',
      params: { edgeId: input.edgeId },
    }),
    db,
  );
}

export async function removeNode(
  ctx: EditContext,
  flowId: string,
  input: { nodeId: string },
  db: Db = defaultDb,
): Promise<EditResult> {
  return applyEdit(
    ctx,
    flowId,
    (g) => ({
      graph: {
        nodes: g.nodes.filter((n) => n.id !== input.nodeId),
        edges: g.edges.filter((e) => e.source !== input.nodeId && e.target !== input.nodeId),
      },
      summary: `removed node ${input.nodeId}`,
      code: 'flow_summary_removed',
      params: { nodeId: input.nodeId },
    }),
    db,
  );
}

export async function configureNode(
  ctx: EditContext,
  flowId: string,
  input: { nodeId: string; key: string; value: unknown },
  db: Db = defaultDb,
): Promise<EditResult> {
  return applyEdit(
    ctx,
    flowId,
    (g) => {
      if (!g.nodes.some((n) => n.id === input.nodeId)) {
        // The other `unknown_node` sentence; this one does know which node, so it names it.
        throw badRequest('unknown_node', `No node '${input.nodeId}'`, {
          reason: 'not_found',
          node: input.nodeId,
        });
      }
      return {
        graph: {
          nodes: g.nodes.map((n) =>
            n.id === input.nodeId
              ? { ...n, config: { ...n.config, [input.key]: input.value } }
              : n,
          ),
          edges: g.edges,
        },
        summary: `configured ${input.nodeId}.${input.key}`,
        code: 'flow_summary_configured',
        // Two raw fields for one compound `nodeId.key`, for the same reason `connected` ships four.
        params: { nodeId: input.nodeId, key: input.key },
      };
    },
    db,
  );
}

export async function moveNode(
  ctx: EditContext,
  flowId: string,
  input: { nodeId: string; position: { x: number; y: number } },
  db: Db = defaultDb,
): Promise<EditResult> {
  return applyEdit(
    ctx,
    flowId,
    (g) => ({
      graph: {
        nodes: g.nodes.map((n) =>
          n.id === input.nodeId ? { ...n, position: input.position } : n,
        ),
        edges: g.edges,
      },
      summary: `moved node ${input.nodeId}`,
      code: 'flow_summary_moved',
      params: { nodeId: input.nodeId },
    }),
    db,
  );
}

/** insert_node: split an existing edge s→t with a new block N (s→N→t), wiring N's
 *  first input/output handle. Useful for "add a summarize step between X and Y". */
export async function insertNode(
  ctx: EditContext,
  flowId: string,
  input: { slug: string; edgeId: string; position?: { x: number; y: number } },
  db: Db = defaultDb,
): Promise<EditResult> {
  const entry = await resolveBlockEntry(input.slug, db);
  const inHandle = Object.keys(entry.descriptor.inputs)[0] ?? 'in';
  const outHandle = Object.keys(entry.descriptor.outputs)[0] ?? 'out';
  const nodeId = genNodeId();
  return applyEdit(
    ctx,
    flowId,
    (g) => {
      const edge = g.edges.find((e) => e.id === input.edgeId);
      // One sentence, so no `reason` — just the interpolated `edge` as a named field.
      if (!edge) throw badRequest('unknown_edge', `No edge '${input.edgeId}'`, { edge: input.edgeId });
      const node: FlowNode = {
        id: nodeId,
        blockId: entry.blockId,
        blockVersionId: entry.blockVersionId,
        slug: entry.slug,
        label: entry.name,
        category: entry.category,
        config: {},
        position: input.position ?? { x: 360, y: 240 },
      };
      const edges = g.edges.filter((e) => e.id !== input.edgeId);
      edges.push({
        id: genEdgeId(),
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: nodeId,
        targetHandle: inHandle,
      });
      edges.push({
        id: genEdgeId(),
        source: nodeId,
        sourceHandle: outHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
      });
      return {
        graph: { nodes: [...g.nodes, node], edges },
        summary: `inserted ${entry.slug} into edge ${input.edgeId}`,
        code: 'flow_summary_inserted',
        // ⚠️ TWO operands, NOT a compound: `slug` and `edgeId` are separated by real words in every
        // catalog ("into edge" / "في الحافة"), and a strong run between two isolates keeps their
        // order. That is why this one does NOT get the `connected`/`configured` treatment — the
        // compound rule is about fields joined by a NEUTRAL (`.`), not about field count.
        params: { slug: entry.slug, edgeId: input.edgeId },
        nodeId,
      };
    },
    db,
  );
}
