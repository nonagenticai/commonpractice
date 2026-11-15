// src/db/flow-types.ts
// Shared TS shapes for the flow graph persisted as JSONB on `flows.graph`. A
// flow is a directed graph of block instances ("nodes") wired output→input
// ("edges"). The frontend keeps a 1:1 copy in lib/types/flows.ts. Kept free of
// drizzle imports so both runtimes (and Session 3's runner) can share it.
import type { BlockCategory } from './block-types';

export interface FlowNode {
  /** Stable per-flow node id (SvelteFlow node id). */
  id: string;
  /** The block this node instantiates. Pins both ids for S3 reproducibility. For a
   *  `foreach` container node (kind==='foreach') these are empty — it runs no block. */
  blockId: string;
  blockVersionId: string;
  /** Denormalised for rendering without a blocks round-trip. */
  slug: string;
  label: string;
  category: BlockCategory;
  /** Literal/config input values set in the node-config panel. */
  config: Record<string, unknown>;
  position: { x: number; y: number };
  // ---- Phase 5: bounded foreach loops ----
  /** Node role. Absent/'block' = a normal block node (the default, unchanged). 'foreach' = a
   *  loop CONTAINER: the executor runs its body (the nodes carrying parentId = this node's id)
   *  once per row of its `in` rowset, with bounded iteration/wall-clock/event budgets, and emits
   *  `results` (the per-iteration body output, aggregated). */
  kind?: 'block' | 'foreach';
  /** Set on a body node: the id of the `foreach` node that owns it. Body nodes are NOT run at the
   *  graph root — the executor runs them inside their foreach, per row. They read the current row
   *  by wiring an edge from the foreach's `item` (and `index`) output. */
  parentId?: string;
  /** foreach config (on the container node). */
  loop?: {
    /** Input port carrying the rowset to iterate (default 'in'). */
    rowsInput?: string;
    /** Hard cap on iterations (clamped to the org RUN_MAX_ITERATIONS). Excess rows are skipped. */
    maxIterations?: number;
  };
}

export interface FlowEdge {
  id: string;
  source: string; // source node id
  sourceHandle: string; // producer output port name
  target: string; // target node id
  targetHandle: string; // consumer input port name
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const FLOW_STATUSES = ['draft', 'submitted', 'archived'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export function emptyGraph(): FlowGraph {
  return { nodes: [], edges: [] };
}
