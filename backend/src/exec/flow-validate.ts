// src/exec/flow-validate.ts — graph integrity analysis (no execution; the seed
// of Session 3's runner pre-flight). Two layers:
//   * validateGraphStructure(graph) — DB-free: dangling edge endpoints + cycle
//     detection (Kahn). Cheap enough to run on every autosave PATCH.
//   * validateGraphAgainstBlocks(graph, descriptorsById) — handle-type checks
//     against each node's block descriptor. Used by S3 before a run.
// Nothing here gates a save: a half-built flow must still persist. Callers
// decide whether to surface findings.
import type { FlowGraph, FlowNode } from '../db/flow-types';
import type { BlockDescriptor } from '../db/block-types';

/** Synthetic descriptor for a Phase-5 `foreach` container node (it runs no block): `in` carries the
 *  rowset; `item`/`index` expose the current row to the body; `results`/`count`/`errors` are the
 *  aggregate emitted downstream. Lets edge handle-checks treat a foreach like any node. */
export const FOREACH_DESCRIPTOR: BlockDescriptor = {
  inputs: { in: { type: 'json' } },
  outputs: {
    item: { type: 'json' },
    index: { type: 'number' },
    results: { type: 'json' },
    count: { type: 'number' },
    errors: { type: 'number' },
  },
  capabilities: {},
};

/**
 * Every graph-integrity rule this module can raise.
 *
 * ⛔ EXTRACTED FROM `GraphIssue` ON PURPOSE, AND IT IS A WIRE CONTRACT NOW. The browser localizes
 * these (frontend/src/lib/i18n/graph-issue-label.ts) by switching on the rule, so a member added,
 * removed or RENAMED here silently pushes that rule's sentence back to the English `message` below
 * in all eight locales. `graph-issue-label.backend-contract.test.ts` scrapes THIS declaration by
 * name and reds when the two sets diverge — which only works while it stays a single flat
 * `export type … = 'a' | 'b';`. Do not assemble it from another type.
 */
export type GraphIssueRule =
  | 'edge-missing-source'
  | 'edge-missing-target'
  | 'duplicate-node-id'
  | 'duplicate-edge-id'
  | 'cycle'
  | 'unknown-source-handle'
  | 'unknown-target-handle'
  | 'incompatible-handle-type'
  | 'missing-required-input'
  | 'missing-descriptor'
  | 'nested-foreach'
  | 'orphan-loop-body';

/**
 * Machine fields the BROWSER needs to write this sentence itself.
 *
 * All optional; a rule supplies only what its sentence names. Values are IDENTIFIERS — slugs,
 * handle names, `FieldType` tokens — never prose and never translated, so the reader sees the same
 * `payload.text` in Dutch as in English. The English `message` beside them does not change byte for
 * byte: it is the mid-roll fallback for a browser talking to an old pod, and for any reader that is
 * not a browser at all (the MCP tool surface in src/ai/mcp/tools.ts renders these to an LLM, where
 * English is the correct output).
 *
 * ⛔ A RENAME HERE IS INVISIBLE AT RUNTIME. Drop `sourceHandle` and every locale quietly reverts to
 * English with every frontend test still green — the fallback is a legitimate state, so nothing
 * throws. `graph-issue-label.backend-contract.test.ts` pins the field names to this interface, and
 * `tests/graph-issue-machine-fields.test.ts` pins the VALUE each of the nine detail-carrying push
 * sites actually writes — substituting an id for a slug is exactly as invisible as dropping the bag
 * (measured: both mutations left backend 53/0 and frontend 30 files / 451 tests green).
 *
 * ⚠️ SLUGS EVERYWHERE EXCEPT FOUR PUSH SITES, EACH FOR A MEASURED REASON:
 * `edge-missing-source`/`edge-missing-target` name a node that is GONE from the graph (no slug
 * exists), and `nested-foreach`/`orphan-loop-body` name loop containers that ALL share the slug
 * `foreach` (see the comment at that push site).
 */
export interface GraphIssueDetail {
  node?: string;
  parent?: string;
  handle?: string;
  blockVersion?: string;
  sourceNode?: string;
  sourceHandle?: string;
  sourceType?: string;
  targetNode?: string;
  targetHandle?: string;
  targetType?: string;
}

export interface GraphIssue {
  rule: GraphIssueRule;
  message: string;
  /** Node or edge id the issue concerns, when applicable. */
  ref?: string;
  /** Identifier-only parameters, so a non-English reader gets the same names in their own sentence. */
  detail?: GraphIssueDetail;
}

export interface GraphValidation {
  ok: boolean;
  issues: GraphIssue[];
}

/** DB-free structural checks: endpoints exist, ids unique, and the graph is acyclic. */
export function validateGraphStructure(graph: FlowGraph): GraphValidation {
  const issues: GraphIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) {
      issues.push({ rule: 'duplicate-node-id', message: `Duplicate node id '${n.id}'`, ref: n.id });
    }
    nodeIds.add(n.id);
  }

  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) {
      issues.push({ rule: 'duplicate-edge-id', message: `Duplicate edge id '${e.id}'`, ref: e.id });
    }
    edgeIds.add(e.id);
    // ⚠️ `sourceNode`/`targetNode` here are the edge's RAW ENDPOINT ID, not a slug — unlike every
    // other rule below. That is the whole point of these two rules: the node is absent from the
    // graph, so there is no node to take a slug from, and the id the edge still points at is the
    // only value that exists. The English message quotes the same id.
    if (!nodeIds.has(e.source)) {
      issues.push({ rule: 'edge-missing-source', message: `Edge ${e.id} references missing source node '${e.source}'`, ref: e.id, detail: { sourceNode: e.source } });
    }
    if (!nodeIds.has(e.target)) {
      issues.push({ rule: 'edge-missing-target', message: `Edge ${e.id} references missing target node '${e.target}'`, ref: e.id, detail: { targetNode: e.target } });
    }
  }

  if (hasCycle(graph)) {
    issues.push({ rule: 'cycle', message: 'Flow contains a cycle; execution requires an acyclic graph' });
  }

  // ---- Phase 5: foreach structure ----
  // ⛔ NESTING IS REFUSED HERE, LOUDLY, because the executor cannot run it and fails SILENTLY.
  // `executeFlow` special-cases `kind === 'foreach'` at the graph ROOT and recurses into
  // `executeForeach`; the body loop inside `executeForeach` has no such branch, so a nested
  // container would hit `runBlockNode` and throw on its empty `blockVersionId`. Worse, the inner
  // container's OWN children (parentId = the inner container) appear in no loop's body order at
  // all — they are not skipped-with-a-trace-event, they simply vanish from the run with no trace.
  // A whole sub-graph disappearing quietly is the "absent collapsed into empty" failure this
  // codebase has shipped before.
  //
  // This guard was previously unnecessary-by-accident: the builder's `assignToLoop` refuses to nest,
  // AND the save schema rejected every foreach graph outright, so nesting was unreachable. Fixing
  // the schema (so foreach can be saved at all) removes the second guard — leaving only a frontend
  // check, which is not a boundary. Rejecting at validation makes it a save-time error a user can
  // see and act on, rather than a silent mid-run omission.
  const containerIds = new Set(graph.nodes.filter((n) => n.kind === 'foreach').map((n) => n.id));
  // ⛔⛔ THESE TWO RULES CARRY IDs, NOT SLUGS, AND THEY ARE THE EXCEPTION ON PURPOSE.
  // Every other rule puts the SLUG in `detail`, because the slug is what the author sees on the
  // canvas and the id is opaque. A loop container has no such slug: the builder stamps EVERY
  // foreach it creates with `slug: 'foreach'` and `label: 'For each row'`
  // (frontend/src/lib/stores/builder-graph.ts), so a slug-carrying `nested-foreach` rendered
  // "Lus “foreach” zit in lus “foreach”." — a sentence that can no longer say WHICH loop to move,
  // while the English it replaced named `fe2` and `fe1`. `issueNodeLabel(ref)` cannot break the tie
  // either: it resolves to the same default label for both. Losing information against the English
  // is the one outcome this workstream must not produce, so both endpoints are the id — exactly
  // what the English quotes, and the only value that is unique.
  // An `orphan-loop-body` parent is frequently not in the graph at all, so there the id is the only
  // value that exists regardless.
  // ⚠️ SEVERITY, STATED HONESTLY: `assignToLoop` refuses to nest and the canvas has no other way to
  // set `parentId`, so `nested-foreach` is realistically only reachable via the API or an import —
  // which is exactly why it must still be raised, and must still be readable when it is.
  for (const n of graph.nodes) {
    if (n.kind === 'foreach' && n.parentId && containerIds.has(n.parentId)) {
      issues.push({
        rule: 'nested-foreach',
        message: `Loop '${n.id}' is inside loop '${n.parentId}'. Nested loops are not supported — move it out of the outer loop.`,
        ref: n.id,
        detail: { node: n.id, parent: n.parentId },
      });
    }
    if (n.parentId && !containerIds.has(n.parentId)) {
      issues.push({
        rule: 'orphan-loop-body',
        message: `Node '${n.id}' claims parent '${n.parentId}', which is not a loop node`,
        ref: n.id,
        detail: { node: n.id, parent: n.parentId },
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Handle/readiness checks: ports exist, connected types are compatible, and every required input
 * is supplied by node config/default or an incoming edge. `json` is the deliberate escape hatch:
 * it represents an opaque structured value and may connect to/from a more specific field type. */
export function validateGraphAgainstBlocks(
  graph: FlowGraph,
  descriptorsById: Map<string, BlockDescriptor>,
): GraphValidation {
  const issues: GraphIssue[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const descFor = (n: FlowNode): BlockDescriptor | undefined =>
    n.kind === 'foreach' ? FOREACH_DESCRIPTOR : descriptorsById.get(n.blockVersionId);

  for (const n of graph.nodes) {
    if (!descFor(n)) {
      issues.push({ rule: 'missing-descriptor', message: `No published descriptor for node '${n.id}' (block version ${n.blockVersionId})`, ref: n.id, detail: { node: n.slug, blockVersion: n.blockVersionId } });
    }
  }

  for (const e of graph.edges) {
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    const srcDesc = src ? descFor(src) : undefined;
    const tgtDesc = tgt ? descFor(tgt) : undefined;
    if (srcDesc && !(e.sourceHandle in srcDesc.outputs)) {
      issues.push({ rule: 'unknown-source-handle', message: `Edge ${e.id}: '${src!.slug}' has no output '${e.sourceHandle}'`, ref: e.id, detail: { sourceNode: src!.slug, sourceHandle: e.sourceHandle } });
    }
    if (tgtDesc && !(e.targetHandle in tgtDesc.inputs)) {
      issues.push({ rule: 'unknown-target-handle', message: `Edge ${e.id}: '${tgt!.slug}' has no input '${e.targetHandle}'`, ref: e.id, detail: { targetNode: tgt!.slug, targetHandle: e.targetHandle } });
    }
    const sourceSpec = srcDesc?.outputs[e.sourceHandle];
    const targetSpec = tgtDesc?.inputs[e.targetHandle];
    if (
      sourceSpec &&
      targetSpec &&
      sourceSpec.type !== targetSpec.type &&
      sourceSpec.type !== 'json' &&
      targetSpec.type !== 'json'
    ) {
      issues.push({
        rule: 'incompatible-handle-type',
        message: `Edge ${e.id}: '${src!.slug}.${e.sourceHandle}' (${sourceSpec.type}) cannot feed '${tgt!.slug}.${e.targetHandle}' (${targetSpec.type})`,
        ref: e.id,
        detail: {
          sourceNode: src!.slug,
          sourceHandle: e.sourceHandle,
          sourceType: sourceSpec.type,
          targetNode: tgt!.slug,
          targetHandle: e.targetHandle,
          targetType: targetSpec.type,
        },
      });
    }
  }

  for (const node of graph.nodes) {
    const descriptor = descFor(node);
    if (!descriptor) continue;
    for (const [name, spec] of Object.entries(descriptor.inputs)) {
      if (!spec.required) continue;
      const configured = Object.prototype.hasOwnProperty.call(node.config ?? {}, name) &&
        node.config[name] !== undefined && node.config[name] !== null && node.config[name] !== '';
      const defaulted = spec.default !== undefined;
      const wired = graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === name);
      if (!configured && !defaulted && !wired) {
        issues.push({
          rule: 'missing-required-input',
          message: `Node '${node.slug}' requires input '${name}'`,
          ref: node.id,
          detail: { node: node.slug, handle: name },
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Kahn topological-sort cycle check over the node/edge graph. */
function hasCycle(graph: FlowGraph): boolean {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of graph.edges) {
    // Only count edges whose endpoints both exist (dangling edges are a separate issue).
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id)!) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return visited !== ids.size;
}
