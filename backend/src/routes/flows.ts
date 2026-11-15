// src/routes/flows.ts — Build-canvas flow persistence (Session 2).
// Flows are owner-scoped working documents (the Build screen is Employee nav),
// so every route only needs validateAuth — NOT the 'platform' role that blocks
// writes require. A flow's owner is provisioned on first write (ensureUser),
// mirroring how a real Keycloak-backed app rows users in on demand. Registered
// into the shared Router by registerFlowRoutes(router) from server.ts.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, flows, flowSnapshots, solutions } from '../db/client';
import { ensureUser } from '../services/user-service';
import { emptyGraph, type FlowGraph } from '../db/flow-types';
import type { Flow, FlowSnapshot } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { jsonResponse, readJson, route, notFound, forbidden } from '../utils/http';
import { log } from '../host/logger';
import { validateGraphStructure } from '../exec/flow-validate';
import { writeSnapshot, type FlowSummaryCode, type FlowSummaryParams } from '../ai/flow-edit-service';
import { recordAudit } from '../host/audit-service';
import { enqueueTranslations } from '../host/translation-service';
import { getTranslationsBatch } from '../db/translations';
import { negotiateLocale } from '../utils/locale';
import type { Router } from '../utils/router';

/** The `content_translations` / `translation_jobs` entity_type for a flow's prose. Bare
 *  `flows.id` (a uuid) is the entity_id — see the branch note in host/translation-service.ts. */
const FLOW_I18N = 'flow';

/** The two translatable columns on `flows`, in one place so the write side (enqueue) and the
 *  read side (overlay) cannot drift apart — a field enqueued but never overlaid is a job that
 *  costs LLM spend and renders nowhere. */
const FLOW_I18N_FIELDS = ['name', 'description'] as const;

// ---- validation schemas ----

const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

/** Phase-5 foreach container config — mirrors `db/flow-types.ts` FlowNode['loop']. */
const loopSchema = z
  .object({
    rowsInput: z.string().min(1).optional(),
    maxIterations: z.number().int().positive().optional(),
  })
  .strict();

/**
 * ⛔ This schema is the write path the BUILDER uses for `flows.graph` (PATCH /api/flows/:id, called by the
 * builder's autosave effect), and until now it made a Phase-5 foreach graph IMPOSSIBLE TO SAVE.
 *
 * ⛔ CORRECTION to an earlier version of this comment, which said "the ONLY write path". It is not:
 * `ai/flow-edit-service.ts applyEdit` (the MCP/headless AI flow-edit tools) writes `flows.graph`
 * directly with NO zod validation, only an advisory `validateGraphStructure` afterwards. Harmless
 * today because none of its operations can set `kind`/`parentId`/`loop` — but a foreach-authoring
 * tool added there would inherit NONE of the guarantees below, so do not trust this as a chokepoint.
 *
 * It was `.strict()` with `blockId`/`blockVersionId` required non-empty, and knew nothing of
 * `kind`/`parentId`/`loop`. A foreach CONTAINER node fails all three at once: `flow-types.ts`
 * documents that a container carries EMPTY `blockId`/`blockVersionId` (it runs no block), and the
 * builder emits the three Phase-5 fields (`stores/builder-graph.ts`). So the moment a user dropped
 * a foreach onto the canvas the next autosave 422'd — and because the autosave does not advance its
 * last-saved marker on failure, it retried and failed forever.
 *
 * `routes/flows.ts` simply was never updated when the foreach executor shipped (#68/#70): the
 * persistence schema predates it. Live prod confirmed the consequence —
 * `SELECT count(*) FROM flows WHERE graph::text LIKE '%foreach%'` returned **0**, more than a month
 * after the feature was declared shipped. It had never once been usable.
 *
 * Tests missed it because `flow-executor-foreach.test.ts` calls `executeFlow` with hand-built
 * in-memory graphs, bypassing the route entirely — the executor was well covered, its only door was
 * not. Route-level coverage is added in `tests/flows-foreach-save.test.ts`.
 */
const flowNodeSchema = z
  .object({
    id: z.string().min(1),
    // NOT `.min(1)` any more: a foreach container legitimately carries empty ids. The
    // superRefine below re-imposes non-empty for every NON-container node, so an ordinary block
    // node with a missing blockId is still rejected exactly as before.
    blockId: z.string(),
    blockVersionId: z.string(),
    slug: z.string().min(1),
    label: z.string(),
    category: z.enum(['data', 'ai', 'logic', 'output', 'ui']),
    config: z.record(z.string(), z.unknown()),
    position: positionSchema,
    // ---- Phase 5 ----
    kind: z.enum(['block', 'foreach']).optional(),
    parentId: z.string().min(1).optional(),
    loop: loopSchema.optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if (node.kind === 'foreach') return; // a container runs no block — empty ids are correct
    for (const field of ['blockId', 'blockVersionId'] as const) {
      if (!node[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required on a block node`,
        });
      }
    }
  });

const flowEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceHandle: z.string(),
    target: z.string().min(1),
    targetHandle: z.string(),
  })
  .strict();

const flowGraphSchema = z
  .object({
    nodes: z.array(flowNodeSchema),
    edges: z.array(flowEdgeSchema),
  })
  .strict();

/** Test seam: the graph schema is the ONLY door a foreach flow can come through, and it silently
 *  barred that door for a month. Exported so `tests/flows-foreach-save.test.ts` can pin the
 *  contract directly, without a DB or a live route. */
export const __flowGraphSchemaForTests = flowGraphSchema;

const createFlowSchema = z
  .object({
    name: z.string().min(1).max(140),
    description: z.string().max(2000).optional(),
  })
  .strict();

const updateFlowSchema = z
  .object({
    name: z.string().min(1).max(140).optional(),
    description: z.string().max(2000).optional(),
    graph: flowGraphSchema.optional(),
    status: z.enum(['draft', 'submitted', 'archived']).optional(),
  })
  .strict();

const checkpointSchema = z.object({ summary: z.string().max(280).optional() }).strict();

// ---- helpers ----

/** Load a flow the caller owns. 404 (not 403) if missing or owned by someone else. */
async function loadOwnedFlow(id: string, userId: string): Promise<Flow> {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.owner_id, userId)));
  if (!flow) throw notFound('flow_not_found', `No flow '${id}'`);
  return flow;
}

function cardOf(f: Flow) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    status: f.status,
    version: f.version,
    node_count: f.graph?.nodes?.length ?? 0,
    last_saved_at: f.last_saved_at,
    updated_at: f.updated_at,
  };
}

/**
 * Queue the 7 non-en locale cells for a flow's prose. BEST-EFFORT, exactly like the challenge
 * submit path (routes/challenges.ts): a translation hiccup must never fail a save.
 *
 * `requestedBy` is the flow's own owner, who is by construction a real `users` row — `flows.owner_id`
 * is an FK to it — so this cannot hit the `translation_jobs.requested_by` FK violation that
 * routes/translations.ts has to refuse for a Keycloak-only super_admin.
 *
 * ⛔ CALL THIS ONLY WHEN `name`/`description` ACTUALLY MOVED. `PATCH /api/flows/:id` is the
 * BUILDER'S AUTOSAVE — it fires on an 800 ms debounce after every node drag — so an unguarded call
 * would run a 14-row upsert on every tick of a canvas nobody renamed. `enqueueTranslations` is
 * edit-aware (`source_hash <> excluded.source_hash`) so those rows would all be no-ops, which is
 * precisely why the waste would be invisible; the guard at the call site is one `!== undefined`.
 */
async function enqueueFlowTranslations(flow: Flow, requestedBy: string): Promise<void> {
  try {
    await enqueueTranslations(
      FLOW_I18N,
      flow.id,
      [
        { field: 'name', value: flow.name },
        { field: 'description', value: flow.description },
      ],
      requestedBy,
    );
  } catch (e) {
    log.warn('translation_enqueue_failed', { entity: 'flow', entityId: flow.id, err: e });
  }
}

/**
 * Load a flow the caller may VIEW: the owner, or anyone if it backs a published
 * solution (mirrors getFlow). 404 (not 403) when missing/private — never reveal
 * existence. Restore is owner-only and checks `isOwner` at the call site.
 */
async function loadViewableFlow(id: string, userId: string): Promise<{ flow: Flow; isOwner: boolean }> {
  const [flow] = await db.select().from(flows).where(eq(flows.id, id));
  if (!flow) throw notFound('flow_not_found', `No flow '${id}'`);
  const isOwner = flow.owner_id === userId;
  if (isOwner) return { flow, isOwner: true };
  const [published] = await db
    .select({ graph: solutions.published_graph })
    .from(solutions)
    .where(eq(solutions.flow_id, flow.id))
    .limit(1);
  if (!published?.graph) throw notFound('flow_not_found', `No flow '${id}'`);
  return { flow: { ...flow, graph: published.graph as FlowGraph }, isOwner: false };
}

/**
 * Snapshot list row — counts only, the graph is omitted to keep the payload small.
 *
 * ⛔ `summary` STAYS, IN ENGLISH, BESIDE THE CODE (0071). It is not deprecated: every row written
 * before 0071 has `summary_code IS NULL` forever (no backfill), and so does a manual checkpoint
 * whose text the USER typed. `frontend/src/lib/i18n/flow-summary-label.ts` renders it whenever the
 * code is absent or unrecognised — permanently, not just during a rolling deploy.
 */
function snapshotSummary(s: FlowSnapshot) {
  const g = (s.graph ?? { nodes: [], edges: [] }) as FlowGraph;
  return {
    id: s.id,
    source: s.source,
    summary: s.summary,
    summary_code: s.summary_code,
    summary_params: s.summary_params ?? null,
    created_by: s.created_by,
    created_at: s.created_at,
    node_count: g.nodes?.length ?? 0,
    edge_count: g.edges?.length ?? 0,
  };
}

/**
 * One snapshot INCLUDING its graph — `snapshotSummary` plus the field it omits.
 *
 * ⛔ IT IS A PROJECTION, NOT THE ROW. `getSnapshot` used to `jsonResponse(snap)`, shipping the whole
 * raw drizzle row — `tenant_id` included, and, the moment 0071 landed, `summary_code`/
 * `summary_params` as untyped extras that `FlowSnapshot` in frontend/src/lib/types/flows.ts had
 * never heard of. Composing off `snapshotSummary` is what keeps the two endpoints from drifting:
 * the list and the detail view render through the SAME label module, so they must ship the same
 * fields under the same names.
 */
function snapshotDetail(s: FlowSnapshot) {
  return { ...snapshotSummary(s), graph: (s.graph ?? emptyGraph()) as FlowGraph };
}

// ---- handlers ----

// GET /api/flows?status=&q= — the caller's own flows (archived excluded by default).
const listFlows = route(async (req) => {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q')?.trim().toLowerCase();

  // Negotiated HERE rather than beside the overlay, because the `q` filter below runs over the
  // RENDERED name: this list is what the Build picker shows, so a Dutch reader searching for the
  // Dutch label they can see must match it. Same rule as the challenge board (routes/challenges.ts).
  const locale = negotiateLocale(req);

  const rows = await db
    .select()
    .from(flows)
    .where(eq(flows.owner_id, user.id))
    .orderBy(desc(flows.updated_at));

  const visible = rows.filter((f) => (status ? f.status === status : f.status !== 'archived'));
  // Localized name/description overlay (§5B): the EN base columns fall through when a cell has no
  // translation, and `getTranslationsBatch` short-circuits to an empty map for `en`, so the default
  // locale costs no query.
  const tx = await getTranslationsBatch(
    FLOW_I18N,
    visible.map((f) => f.id),
    locale,
    [...FLOW_I18N_FIELDS],
  );

  let items = visible.map((f) => {
    const t = tx.get(f.id) ?? {};
    return cardOf({ ...f, name: t.name ?? f.name, description: t.description ?? f.description });
  });
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));

  return jsonResponse({ items, total: items.length });
});

// POST /api/flows — create an empty draft flow owned by the caller.
const createFlow = route(async (req) => {
  const user = await validateAuth(req);
  const body = createFlowSchema.parse(await readJson(req));
  await ensureUser(user);

  const [flow] = await db
    .insert(flows)
    .values({
      name: body.name,
      description: body.description ?? '',
      owner_id: user.id,
      graph: emptyGraph(),
      last_saved_at: new Date(),
    })
    .returning();

  await enqueueFlowTranslations(flow!, user.id);

  return jsonResponse(flow, 201);
});

// GET /api/flows/:id — full flow incl. graph. Owner-scoped, EXCEPT a flow that
// backs a published marketplace solution (through canonical solutions.flow_id) is publicly viewable so
// "Open in Build" on a solution renders the author's flow. Writes stay owner-only.
const getFlow = route(async (req, id) => {
  const user = await validateAuth(req);
  const [flow] = await db.select().from(flows).where(eq(flows.id, id!));
  if (!flow) throw notFound('flow_not_found', `No flow '${id}'`);
  // ⛔ THE OWNER GETS THE BASE COLUMNS, UNTRANSLATED, AND THAT IS NOT AN OVERSIGHT — DO NOT
  // "COMPLETE" THE OVERLAY BY MOVING IT ABOVE THIS LINE.
  //
  // This response is not a rendering, it is the EDITOR'S LOAD. `frontend/src/routes/build/
  // +page.svelte` `doSave()` puts `name: builder.flow.name` on EVERY autosave PATCH — that field is
  // how the topbar's inline rename persists, so it cannot simply be dropped — and `builder.flow`
  // is this payload. Overlay the name here and the sequence is: a Dutch reader opens their flow,
  // the title input shows the machine translation, they drag one node, the 800 ms autosave writes
  // that translation into `flows.name`. The English SOURCE is then gone, `enqueueFlowTranslations`
  // re-queues the Dutch string as the new source text, and the next drain translates a translation.
  // One canvas interaction, silent, unrecoverable.
  //
  // A non-owner cannot reach that path at all: `PATCH` goes through `loadOwnedFlow` and answers
  // 404, so the read-only branch below is the one place this payload cannot round-trip — and it is
  // the only one that is purely a rendering (someone reading a stranger's published flow).
  // `listFlows` is localized for the same reason: its cards are display-only.
  if (flow.owner_id === user.id) return jsonResponse({ ...flow, readOnly: false });
  const [published] = await db
    .select({ graph: solutions.published_graph })
    .from(solutions)
    .where(eq(solutions.flow_id, flow.id))
    .limit(1);
  if (!published?.graph) throw notFound('flow_not_found', `No flow '${id}'`);
  const tx =
    (await getTranslationsBatch(FLOW_I18N, [flow.id], negotiateLocale(req), [
      ...FLOW_I18N_FIELDS,
    ])).get(flow.id) ?? {};
  return jsonResponse({
    ...flow,
    name: tx.name ?? flow.name,
    description: tx.description ?? flow.description,
    graph: published.graph,
    readOnly: true,
  });
});

// PATCH /api/flows/:id — partial update; `graph` is the autosave target.
// Graph integrity is reported (non-blocking) so a half-built flow still saves.
const updateFlow = route(async (req, id) => {
  const user = await validateAuth(req);
  const body = updateFlowSchema.parse(await readJson(req));
  const flow = await loadOwnedFlow(id!, user.id);

  const set: Partial<typeof flows.$inferInsert> = { updated_at: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  if (body.status !== undefined) set.status = body.status;
  let validation = null;
  if (body.graph !== undefined) {
    set.graph = body.graph as FlowGraph;
    set.last_saved_at = new Date();
    validation = validateGraphStructure(body.graph as FlowGraph);
  }

  const [updated] = await db
    .update(flows)
    .set(set)
    .where(eq(flows.id, flow.id))
    .returning();

  // Only when the PROSE moved — see the ⛔ on enqueueFlowTranslations. `graph`/`status`-only
  // saves (the overwhelming majority: this route is the autosave target) skip it entirely.
  if (body.name !== undefined || body.description !== undefined) {
    await enqueueFlowTranslations(updated!, user.id);
  }

  // ⛔ NO LOCALIZED OVERLAY ON THIS RESPONSE. See the note on `getFlow`: the builder echoes
  // `updated.name` straight back on its next autosave, so a translated value here would be
  // written into the base column.
  return jsonResponse({ ...updated!, validation });
});

// DELETE /api/flows/:id — soft-delete (status → archived).
const deleteFlow = route(async (req, id) => {
  const user = await validateAuth(req);
  const flow = await loadOwnedFlow(id!, user.id);
  await db
    .update(flows)
    .set({ status: 'archived', updated_at: new Date() })
    .where(eq(flows.id, flow.id));
  return new Response(null, { status: 204 });
});

// ---- flow history (§3-H): list / view / checkpoint / restore over flow_snapshots ----

// GET /api/flows/:id/snapshots — the version timeline, newest-first. Viewable by the
// owner or (read-only) anyone when the flow backs a published solution. Graphs omitted.
const listSnapshots = route(async (req, id) => {
  const user = await validateAuth(req);
  const { flow, isOwner } = await loadViewableFlow(id!, user.id);
  if (!isOwner) return jsonResponse({ items: [], readOnly: true });
  const rows = await db
    .select()
    .from(flowSnapshots)
    .where(eq(flowSnapshots.flow_id, flow.id))
    .orderBy(desc(flowSnapshots.created_at));
  return jsonResponse({ items: rows.map(snapshotSummary), readOnly: !isOwner });
});

// GET /api/flows/:id/snapshots/:snapshotId — a single snapshot incl. its full graph
// (the UI previews it before restoring; the on-ramp for a future diff view).
const getSnapshot = route(async (req, id, snapshotId) => {
  const user = await validateAuth(req);
  const { flow } = await loadViewableFlow(id!, user.id);
  if (flow.owner_id !== user.id) throw notFound('snapshot_not_found', `No snapshot '${snapshotId}' on flow '${id}'`);
  const [snap] = await db
    .select()
    .from(flowSnapshots)
    .where(and(eq(flowSnapshots.id, snapshotId!), eq(flowSnapshots.flow_id, flow.id)));
  if (!snap) throw notFound('snapshot_not_found', `No snapshot '${snapshotId}' on flow '${id}'`);
  return jsonResponse(snapshotDetail(snap));
});

// POST /api/flows/:id/snapshots — manual checkpoint of the CURRENT graph. Owner-only.
// This is the only snapshot trigger for hand-built (autosave-only) flows: the PATCH
// autosave path never snapshots, so without this a canvas-only flow has no history.
const createCheckpoint = route(async (req, id) => {
  const user = await validateAuth(req);
  const body = checkpointSchema.parse(await readJson(req));
  const flow = await loadOwnedFlow(id!, user.id);
  const typed = body.summary?.trim();
  const summary = typed || 'Manual checkpoint';
  // ⛔ THE DISCRIMINATOR IS THE PRESENCE OF USER TEXT, NOT ITS VALUE. A checkpoint the user LABELLED
  // is their own words and must render back to them verbatim, in whatever language they typed —
  // including, exactly, someone who types "Manual checkpoint" by hand. Only the `|| default` branch
  // is a sentence THIS SERVER composed, and only that branch gets a code. Comparing `summary` to
  // the string 'Manual checkpoint' instead would silently translate a user's own text.
  const code: FlowSummaryCode | null = typed ? null : 'flow_summary_manual_checkpoint';
  const graph = (flow.graph ?? emptyGraph()) as FlowGraph;

  const created = await db.transaction(async (tx) => {
    // `params` is null even on the coded branch: `flow_summary_manual_checkpoint` interpolates
    // nothing, so there is nothing to persist. The reader handles it the way `graph-issue-label`
    // handles `cycle` — a parameterless code never takes the mid-roll fallback.
    await writeSnapshot(tx, flow.id, graph, 'manual', summary, user.id, code, null);
    const [row] = await tx
      .select()
      .from(flowSnapshots)
      .where(eq(flowSnapshots.flow_id, flow.id))
      .orderBy(desc(flowSnapshots.created_at))
      .limit(1);
    return row!;
  });

  await recordAudit({
    actorId: user.id,
    action: 'flow.checkpoint',
    category: 'block',
    targetType: 'flow',
    targetId: flow.id,
    result: summary,
    resultTone: 'ok',
    // ⛔ THE SAME `summary`, `code` AND params THE SNAPSHOT GOT, FROM THE SAME LOCALS. /build renders
    // this event from `flow_snapshots.summary_code` and /audit renders it from here; a Dutch reader
    // saw "Handmatig checkpoint" on one screen and "Manual checkpoint" on the other for ONE event,
    // because only the snapshot carried a code. Composing the audit values separately — a second
    // `|| 'Manual checkpoint'`, a re-derived code — is how they drift apart again, so both surfaces
    // read the variables `writeSnapshot` was handed, above.
    //
    // ⚠️ `code` IS `null` FOR A USER-TYPED CHECKPOINT, ON PURPOSE, and that null must survive to the
    // wire: it is what makes the reader render their own words verbatim instead of the catalog's.
    // The `params` half is `null` for the same reason it is on the snapshot — this code
    // interpolates nothing.
    metadata: { snapshotId: created.id, summaryCode: code, summaryParams: null },
  });
  return jsonResponse(snapshotSummary(created), 201);
});

// POST /api/flows/:id/snapshots/:snapshotId/restore — roll the live graph back to a
// snapshot. Owner-only (403 for a solution-viewer). The restore is itself recorded as a
// new 'manual' snapshot so it is reversible and the newest snapshot == the live graph.
const restoreSnapshot = route(async (req, id, snapshotId) => {
  const user = await validateAuth(req);
  const { flow, isOwner } = await loadViewableFlow(id!, user.id);
  if (!isOwner) throw forbidden('flow_not_owner', 'Only the flow owner can restore a snapshot');
  const [snap] = await db
    .select()
    .from(flowSnapshots)
    .where(and(eq(flowSnapshots.id, snapshotId!), eq(flowSnapshots.flow_id, flow.id)));
  if (!snap) throw notFound('snapshot_not_found', `No snapshot '${snapshotId}' on flow '${id}'`);

  const graph = (snap.graph ?? emptyGraph()) as FlowGraph;
  const restoredFrom = new Date(snap.created_at).toISOString();
  const summary = `Restored snapshot from ${restoredFrom}`;
  // ⛔ THE RAW ISO, NEVER A PRE-FORMATTED DATE. The browser formats it with `fullDate(at, locale)`
  // (frontend/src/lib/utils/format.ts) in the reader's own locale; shipping "Aug 7, 2026" from here
  // would be a second source of truth, in a language this server had to guess, that no reader could
  // reformat. Same value the English sentence above interpolates — one instant, two renderings.
  const params: FlowSummaryParams = { at: restoredFrom };
  // Hoisted to a const for the same reason the checkpoint above reads its locals: the snapshot row
  // and the audit row must carry the SAME code, and two literals are two places to edit.
  const code: FlowSummaryCode = 'flow_summary_restored';
  const updated = await db.transaction(async (tx) => {
    await writeSnapshot(tx, flow.id, graph, 'manual', summary, user.id, code, params);
    const [row] = await tx
      .update(flows)
      .set({ graph, last_saved_at: new Date(), updated_at: new Date() })
      .where(eq(flows.id, flow.id))
      .returning();
    return row!;
  });

  await recordAudit({
    actorId: user.id,
    action: 'flow.restore',
    category: 'block',
    targetType: 'flow',
    targetId: flow.id,
    result: summary,
    resultTone: 'ok',
    // Same rule as the checkpoint above: one instant, one code, both surfaces. `params.at` is the
    // RAW ISO the English sentence also interpolates — the browser formats it with
    // `fullDate(at, locale)`, so /audit dates this the way every other date in the product is
    // punctuated instead of printing a bare ISO string inside a Dutch sentence.
    metadata: { snapshotId: snap.id, summaryCode: code, summaryParams: params },
  });
  return jsonResponse({ ...updated, validation: validateGraphStructure(graph) });
});

export function registerFlowRoutes(router: Router): void {
  router.add('GET', '/api/flows', listFlows);
  router.add('POST', '/api/flows', createFlow);
  router.add('GET', '/api/flows/:id', getFlow);
  router.add('PATCH', '/api/flows/:id', updateFlow);
  router.add('DELETE', '/api/flows/:id', deleteFlow);
  // History timeline (more specific paths — router matches by registration; these
  // share the /:id prefix but add /snapshots segments so they don't collide).
  router.add('GET', '/api/flows/:id/snapshots', listSnapshots);
  router.add('POST', '/api/flows/:id/snapshots', createCheckpoint);
  router.add('GET', '/api/flows/:id/snapshots/:snapshotId', getSnapshot);
  router.add('POST', '/api/flows/:id/snapshots/:snapshotId/restore', restoreSnapshot);
}
