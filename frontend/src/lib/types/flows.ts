// src/lib/types/flows.ts — 1:1 mirror of backend/src/db/flow-types.ts plus the
// API response shapes returned by /api/flows. Keep in sync with the backend.
import type { BlockCategory } from '$lib/types/blocks';

export interface FlowNode {
	id: string;
	blockId: string;
	blockVersionId: string;
	slug: string;
	label: string;
	category: BlockCategory;
	config: Record<string, unknown>;
	position: { x: number; y: number };
	// ---- Phase 5: bounded foreach loops (backend executes; FE canvas authoring is a follow-up) ----
	/** 'foreach' = a loop container node (runs no block). Absent = a normal block node. */
	kind?: 'block' | 'foreach';
	/** Set on a loop body node: the id of the foreach node that owns it. */
	parentId?: string;
	/** foreach config (on the container node). */
	loop?: { rowsInput?: string; maxIterations?: number };
}

export interface FlowEdge {
	id: string;
	source: string;
	sourceHandle: string;
	target: string;
	targetHandle: string;
}

export interface FlowGraph {
	nodes: FlowNode[];
	edges: FlowEdge[];
}

export type FlowStatus = 'draft' | 'submitted' | 'archived';

/** A card row from GET /api/flows. */
export interface FlowListItem {
	id: string;
	name: string;
	description: string;
	status: FlowStatus;
	version: string;
	node_count: number;
	last_saved_at: string | null;
	updated_at: string;
}

/** Full flow from GET /api/flows/:id (and create/patch responses). */
export interface Flow {
	id: string;
	name: string;
	description: string;
	owner_id: string;
	status: FlowStatus;
	graph: FlowGraph;
	version: string;
	solution_id: string | null;
	last_saved_at: string | null;
	created_at: string;
	updated_at: string;
	/**
	 * True when the caller is NOT the owner and is seeing this flow only because it backs a
	 * published solution (`routes/flows.ts` `getFlow`). Writes are owner-only — `PATCH
	 * /api/flows/:id` goes through `loadOwnedFlow` and answers 404 — so an editable canvas here
	 * is a canvas whose every edit is lost.
	 *
	 * ⚠️ OPTIONAL, AND ONLY `GET /api/flows/:id` MINTS IT. `POST /api/flows` and `PATCH
	 * /api/flows/:id` return the bare row, so the field is absent on a create/save response and
	 * `readOnly === true` is the only safe test — `!flow.readOnly` would read "editable" from a
	 * backend one deploy behind, which is the state that produced the defect in the first place.
	 */
	readOnly?: boolean;
}

/**
 * The identifier-only parameters a `GraphIssue` carries so the BROWSER can write the sentence.
 *
 * Mirrors `GraphIssueDetail` in backend/src/exec/flow-validate.ts. Every field is optional because
 * each rule supplies only what its own sentence names, and the whole bag is optional because a
 * backend one deploy behind ships none of it — see `graphIssueLabel` for what that costs. Values
 * are slugs, handle names and `FieldType` tokens: they are NEVER translated and never prose.
 *
 * ⚠️ THREE RULES CARRY AN ID RATHER THAN A SLUG, each for a measured reason. On
 * `edge-missing-source`/`edge-missing-target` the `sourceNode`/`targetNode` is the edge's raw
 * endpoint ID — the node it names is missing from the graph, so no slug exists. On
 * `nested-foreach`/`orphan-loop-body` BOTH `node` and `parent` are ids, because every foreach
 * container the builder creates carries the same `slug: 'foreach'` and the same `label:
 * 'For each row'` — a slug there renders "Lus “foreach” zit in lus “foreach”", which cannot say
 * which loop to move, while the English it replaced named `fe2` and `fe1`.
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
	/**
	 * A plain `string`, NOT the backend's 12-value `GraphIssueRule` union, for the reason spelled
	 * out in `isGraphIssue`: a rule shipped backend-first must degrade to its own `message`, never
	 * vanish from the list.
	 */
	rule: string;
	message: string;
	ref?: string;
	detail?: GraphIssueDetail;
}

export interface GraphValidation {
	ok: boolean;
	issues: GraphIssue[];
}

/**
 * One violation of the ontology data contract by the test data a run injects.
 *
 * Mirrors `DataValidationFinding` in backend/src/datasets/ontology-validation.ts. It sits beside
 * `GraphIssue` rather than reusing it because the two answer different questions about different
 * subjects: a `GraphIssue` points at a NODE (`ref`), a finding points at a dataset COLUMN and the
 * ontology ATTRIBUTE it was mapped onto. Collapsing them would leave `rule` + `message` as the only
 * fields either could promise — which is exactly the information loss api/graph-issues.ts exists to
 * prevent.
 *
 * `rule` is a plain `string`, not the backend's two-value union, for the reason spelled out in
 * `isGraphIssue`: a rule shipped backend-first must degrade to its own `message`, never vanish.
 *
 * `count`/`expected` are `type_mismatch`-only AND optional on the wire — a backend one deploy
 * behind ships neither. See `dataFindingLabel` for what that costs.
 */
export interface DataValidationFinding {
	rule: string;
	dataset: string;
	column: string;
	attribute: string;
	message: string;
	count?: number;
	expected?: string;
}

/** The policy that decided what happened to a run whose data raised findings. */
export type DataValidationMode = 'warn' | 'block';

/** PATCH /api/flows/:id returns the flow plus a non-blocking graph validation. */
export type FlowWithValidation = Flow & { validation: GraphValidation | null };

/**
 * A row in the flow version timeline (GET /api/flows/:id/snapshots). Graph omitted.
 *
 * `summary` is the backend's ENGLISH sentence and stays on the wire deliberately (0071): it is what
 * an MCP/LLM client reads, and it is the permanent fallback `flowSummaryLabel` renders whenever
 * `summary_code` is absent or unrecognised.
 */
export interface FlowSnapshotSummary {
	id: string;
	source: 'manual' | 'ai';
	summary: string;
	/**
	 * WHICH of the nine templates wrote `summary` (`FlowSummaryCode` in
	 * backend/src/ai/flow-edit-service.ts), so the browser can say it in the reader's language.
	 *
	 * ⛔ `null` IS A PERMANENT, ORDINARY VALUE, NOT A MIGRATION ARTEFACT. Every snapshot written
	 * before 0071 carries `null` forever (no backfill), and so does every manual checkpoint whose
	 * text the USER typed — that text is theirs and is rendered verbatim. `?` on top of `| null`
	 * because an old pod mid-roll ships the field not at all. See `flow-summary-label.ts`.
	 */
	summary_code?: string | null;
	/** The machine fields that sentence interpolates — raw, never pre-joined or pre-formatted. */
	summary_params?: Record<string, unknown> | null;
	created_by: string | null;
	created_at: string;
	node_count: number;
	edge_count: number;
}

/**
 * A single snapshot incl. its full graph (GET /api/flows/:id/snapshots/:snapshotId).
 *
 * ⚠️ This is only true because that endpoint PROJECTS its row through `snapshotDetail()` in
 * backend/src/routes/flows.ts. It used to `jsonResponse(snap)` — the whole raw drizzle row — which
 * shipped `tenant_id` and would have shipped 0071's two columns un-declared here.
 */
export type FlowSnapshot = FlowSnapshotSummary & { graph: FlowGraph };

export function emptyGraph(): FlowGraph {
	return { nodes: [], edges: [] };
}
