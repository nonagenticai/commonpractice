// src/lib/stores/builder.svelte.ts — Build-canvas state (Session 2).
// Holds the loaded flow + the SvelteFlow nodes/edges (as $state.raw so every
// change reassigns the array and the page's autosave $effect fires), plus
// selection. The pure graph<->canvas mapping + Phase-5 loop transforms live in
// builder-graph.ts (runes-free, unit-testable); this class is the thin reactive
// wrapper. Instantiated per build-page (not a singleton) so each visit starts clean.
import type { Edge } from '@xyflow/svelte';
import type { BlockDescriptor } from '$lib/types/blocks';
import type { Flow, FlowGraph } from '$lib/types/flows';
import type { ChallengeDatasetRef } from '$lib/types/challenges';
import {
	FOREACH_NODE_DESCRIPTOR,
	DEFAULT_MAX_ITERATIONS,
	HARD_MAX_ITERATIONS,
	flowToCanvasNodes,
	applyResolvedDescriptor,
	canvasToFlowGraph,
	newForeachNode,
	orderParentsFirst,
	assignToLoop,
	removeFromLoop,
	setLoopConfig,
	removeNodeFromNodes,
	separateOverlappingNodes,
	type BlockEntry,
	type BlockNodeData,
	type CpNode
} from './builder-graph';

// Re-export so existing importers (BlockNode, driver, build page) keep their import path.
export {
	FOREACH_NODE_DESCRIPTOR,
	DEFAULT_MAX_ITERATIONS,
	HARD_MAX_ITERATIONS,
	type BlockEntry,
	type BlockNodeData,
	type CpNode
};

/** Phase 3.1: the challenge a build targets (via ?challenge=), with its applicable
 *  datasets — surfaced on the canvas "Challenge data" panel + wired into node inputs. */
export interface ChallengeContext {
	id: string;
	title: string;
	datasets: ChallengeDatasetRef[];
	involves: string[];
	/** May this reader link sample data to the challenge (creator or admin — W8/F1)? Absent from an
	 *  older backend: treated as no, so the link is simply not offered. */
	canEditDatasets?: boolean;
}

export class BuilderStore {
	flow = $state<Flow | null>(null);
	nodes = $state.raw<CpNode[]>([]);
	edges = $state.raw<Edge[]>([]);
	selectedNodeId = $state<string | null>(null);
	/** Set true once a flow is loaded so the autosave effect ignores hydration. */
	hydrated = $state(false);
	/**
	 * The loaded flow belongs to SOMEONE ELSE and this canvas may not change it.
	 *
	 * ⛔ WHY THE GATE IS HERE AND NOT ONLY ON THE PAGE. `GET /api/flows/:id` serves a non-owner the
	 * flow behind a published solution (that is what "Open in Build" on a solution page is), and
	 * `PATCH /api/flows/:id` refuses them. Nothing read the `readOnly` the backend has always sent,
	 * so a visitor edited freely, the 800 ms autosave 403'd, "Opslaan mislukt" pinned itself over
	 * the topbar for the rest of the session, and every edit was lost on reload. The mutators are
	 * the ONE choke point five different callers share — the reader's clicks, the palette's drops,
	 * the AI copilot's tool-calls (agent-chat drives this same store), /build's undo/redo stacks
	 * (`replaceGraph`) and the canvas's own connect handler (`adoptConnection`) — so the page-level
	 * affordances below are the courtesy and this is the guarantee.
	 *
	 * ⚠️ THE LAST TWO WERE ADDED BECAUSE THEY WERE MISSING. `undo()`/`redo()` and
	 * `FlowCanvas.onConnect` used to assign `nodes`/`edges` themselves, so the sentence above was
	 * false for them: their only defence was a `disabled` button and a `nodesConnectable` prop —
	 * UI-level defences for a store-level invariant, and `onKeydown` on `<svelte:window>` walks
	 * straight past the first one. Both now come through this class.
	 *
	 * ⛔ `nodes` / `edges` ARE DELIBERATELY NOT GATED ACCESSORS. `FlowCanvas.svelte` `bind:nodes` is
	 * also how `@xyflow/svelte` writes MEASURED dimensions back; swallowing that write breaks
	 * `fitView` and leaves a read-only visitor looking at a canvas that never frames itself. The
	 * canvas is instead told `nodesDraggable={false} nodesConnectable={false} deleteKey={null}`, so
	 * xyflow raises no graph mutation of its own to swallow. That is also exactly WHY the two
	 * writers above needed methods of their own: with the channel left open, the only way to close
	 * a door is to name it.
	 *
	 * ⚠️ `load()` AND `resolveSlug()` STAY UNGATED. Hydration is not an edit, and a late descriptor
	 * arriving for a node already on screen is a repair of the RENDER, not of the graph — gating
	 * either one would make a read-only flow unopenable / permanently portless.
	 */
	readOnly = $state(false);
	/**
	 * The screen is too narrow to edit on (/build sets this below 1024px). NOT a fact about the flow
	 * — the flow is still the author's own, and the banner/save label keep reading `readOnly` — but
	 * it closes the same mutation gate.
	 *
	 * ⛔ WHY IT LIVES HERE AND NOT ONLY ON THE CANVAS. It used to reach `FlowCanvas` and the palette
	 * only, so at 900px the assistant still applied tool-calls, the Details panel still wrote config,
	 * ⌘Z still reverted the graph and Submit stayed live — on a canvas the note calls view-only.
	 * Every one of those writers already meets `locked` below.
	 */
	viewOnly = $state(false);
	/** The ONE effective read-only: the owner gate OR the layout gate. Every mutator and every
	 *  consumer that offers an edit reads this, never `readOnly` alone. */
	get locked(): boolean {
		return this.readOnly || this.viewOnly;
	}
	/** Phase 3.1: the challenge being worked (from ?challenge=), null when free-building. */
	challengeContext = $state<ChallengeContext | null>(null);

	get selectedNode(): CpNode | null {
		return this.nodes.find((n) => n.id === this.selectedNodeId) ?? null;
	}

	/** Phase 3.1: set/clear the challenge context (its applicable datasets + entities). */
	setChallengeContext(ctx: ChallengeContext | null): void {
		this.challengeContext = ctx;
	}

	/** Load a persisted flow into editable canvas state. `resolve` maps a node to
	 *  the descriptor for its block version (ports come from the descriptor), and
	 *  returns `null` when it could not be resolved — see `UNRESOLVED_DESCRIPTOR`. */
	load(flow: Flow, resolve: (slug: string, versionId: string) => BlockDescriptor | null): void {
		this.hydrated = false;
		this.flow = flow;
		// ⚠️ `=== true`, NOT `!!flow.readOnly`. Only `GET /api/flows/:id` mints the field; a
		// create/save response carries the bare row, and a backend one deploy behind carries
		// nothing at all. Both must read as "editable", which is what an explicit true-test gives
		// and what a truthiness test on an absent field also gives — but the explicit form is what
		// keeps a future `readOnly: 'false'` string from opening the gate.
		this.readOnly = flow.readOnly === true;
		// Saved positions may predate the current node width (190 → 240px) and now overlap; nudge
		// them apart in memory only. `/build` snapshots its autosave baseline after this, so the
		// nudge is persisted only by the author's next real save.
		this.nodes = separateOverlappingNodes(flowToCanvasNodes(flow.graph, resolve));
		this.edges = flow.graph.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle,
			targetHandle: e.targetHandle
		}));
		this.selectedNodeId = null;
	}

	/**
	 * One slug's descriptor arrived late (the reader hit retry): patch the nodes waiting on it and
	 * clear their `descriptorUnavailable` flag.
	 *
	 * ⛔ THIS, NOT `load()`. Re-loading the flow to pick up one descriptor discards every unsaved
	 * edit the reader has made since — the retry would then cost more than the failure it repairs.
	 */
	resolveSlug(
		slug: string,
		resolve: (slug: string, versionId: string) => BlockDescriptor | null
	): void {
		this.nodes = applyResolvedDescriptor(this.nodes, slug, resolve);
	}

	/** Serialize the canvas back to a persistable FlowGraph. Reads nodes+edges so
	 *  the page's autosave $effect tracks them. */
	serialize(): FlowGraph {
		return canvasToFlowGraph(this.nodes, this.edges);
	}

	addNode(entry: BlockEntry, position: { x: number; y: number }): string {
		// ⚠️ `''`, not a throw: every caller here is a UI gesture or an agent tool-call, and a
		// refusal that crashes the canvas is worse than a gesture that does nothing beside a banner
		// that already explains why. `insertNode` below is the only caller that reads the id back.
		if (this.locked) return '';
		const id = `n_${crypto.randomUUID().slice(0, 8)}`;
		const node: CpNode = {
			id,
			type: 'block',
			position,
			data: {
				blockId: entry.blockId,
				blockVersionId: entry.blockVersionId,
				slug: entry.slug,
				label: entry.name,
				category: entry.category,
				descriptor: entry.descriptor,
				config: {}
			}
		};
		this.nodes = [...this.nodes, node];
		this.selectedNodeId = id;
		return id;
	}

	updateConfig(nodeId: string, key: string, value: unknown): void {
		if (this.locked) return;
		this.nodes = this.nodes.map((n) =>
			n.id === nodeId
				? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } }
				: n
		);
	}

	// ---- agent-shared edit actions (Retrofit §5A) -------------------------------
	// These are the SAME mutations the user's clicks make; the agent driver calls
	// them so human + AI edits go through one path and the canvas redraws reactively.

	/** Wire one node's output handle to another node's input handle. Returns edge id. */
	connectNodes(source: string, sourceHandle: string, target: string, targetHandle: string): string {
		if (this.locked) return '';
		const id = `e_${crypto.randomUUID().slice(0, 8)}`;
		this.edges = [...this.edges, { id, source, target, sourceHandle, targetHandle }];
		return id;
	}

	/**
	 * Adopt the edge `@xyflow/svelte` has just appended through `bind:edges` for a connection the
	 * reader drew: give it this app's stable id — or, read-only, take it straight back out.
	 *
	 * ⛔ THE REMOVAL BRANCH IS THE POINT, NOT THE RENAME. `FlowCanvas.onConnect` used to rewrite
	 * `builder.edges` itself and was defended only by the `nodesConnectable={!builder.readOnly}`
	 * PROP. That prop stops the drag from ever starting, which is the right affordance and the
	 * wrong place for the invariant: it is one component's markup standing in for a rule the whole
	 * store enforces. Anything that raises `onconnect` without a handle drag — a future custom edge
	 * with an `<EdgeReconnectAnchor>`, an xyflow upgrade, a programmatic `addEdge` — walked past it.
	 * Read-only, an edge set now comes out of a connect attempt exactly as it went in.
	 *
	 * ⛔ THE APPENDED EDGE IS IDENTIFIED BY ITS EXACT ID, NOT BY A PREFIX TEST ON EVERYTHING ELSE.
	 * The old `onConnect` matched the endpoint quadruple and then excluded `id.startsWith('e_')` on
	 * the theory that every OTHER edge is one this app minted. It is not: a persisted flow carries
	 * whatever ids its graph was saved with (the fixtures alone use `e1`), so re-drawing a
	 * connection that already existed renamed the reader's ORIGINAL edge — and, once the read-only
	 * branch below exists, would have DELETED it. `@xyflow/system`'s `getEdgeId` is a pure function
	 * of the connection (`xy-edge__${source}${sourceHandle}-${target}${targetHandle}`), so the edge
	 * xyflow just appended can be named exactly rather than guessed at by elimination.
	 */
	adoptConnection(c: {
		source: string | null;
		sourceHandle?: string | null;
		target: string | null;
		targetHandle?: string | null;
	}): void {
		// Must stay byte-identical to `@xyflow/system`'s `getEdgeId`, including the `|| ''` fallbacks.
		const xyId = `xy-edge__${c.source}${c.sourceHandle || ''}-${c.target}${c.targetHandle || ''}`;
		const appended = (e: Edge) => e.id === xyId;
		if (this.locked) {
			const kept = this.edges.filter((e) => !appended(e));
			// Only reassign when something was actually taken back out: `edges` is `$state.raw`, so
			// an unconditional `filter` would hand the page's autosave + history effects a brand-new
			// array on every no-op connect attempt.
			if (kept.length !== this.edges.length) this.edges = kept;
			return;
		}
		const id = `e_${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`;
		this.edges = this.edges.map((e) => (appended(e) ? { ...e, id } : e));
	}

	/**
	 * Replace the WHOLE graph in one write — /build's undo/redo, the only mutator whose argument is
	 * a snapshot rather than a gesture.
	 *
	 * ⛔ WHY THIS EXISTS. The history stacks used to assign `builder.nodes` / `builder.edges`
	 * directly, making ⌘Z / ⌘⇧Z the two writers that never passed this class. The topbar's Undo and
	 * Redo buttons ARE `disabled` read-only — but `onKeydown` is wired to `<svelte:window>` and
	 * tests nothing, and the stacks are NOT empty on a read-only visit: `resolveSlug` is
	 * deliberately ungated (see above), so a late descriptor reassigns `nodes`, and /build's
	 * recorder snapshots that like any other change. A visitor who clicked "retry" on the unresolved
	 * -blocks pill and then pressed ⌘Z watched the canvas the banner calls read-only visibly revert.
	 *
	 * ⚠️ RETURNS WHETHER IT APPLIED, and the caller must not touch its stacks until it has. A
	 * refusal that had already popped `undoStack` would silently eat a history step — the same
	 * half-applied shape `insertNode`'s own guard exists to prevent.
	 */
	replaceGraph(nodes: CpNode[], edges: Edge[]): boolean {
		if (this.locked) return false;
		this.nodes = nodes;
		this.edges = edges;
		this.selectedNodeId = null;
		return true;
	}

	/** Remove an edge by id. */
	disconnectNodes(edgeId: string): void {
		if (this.locked) return;
		this.edges = this.edges.filter((e) => e.id !== edgeId);
	}

	/** Remove a node and every edge incident to it. Removing a foreach container ORPHANS its body
	 *  (re-absolutizes + detaches each child) rather than silently deleting the body nodes. */
	removeNode(nodeId: string): void {
		if (this.locked) return;
		this.nodes = removeNodeFromNodes(this.nodes, nodeId);
		this.edges = this.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
		if (this.selectedNodeId === nodeId) this.selectedNodeId = null;
	}

	/** Move a node to a new canvas position. */
	moveNode(nodeId: string, position: { x: number; y: number }): void {
		if (this.locked) return;
		this.nodes = this.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n));
	}

	/** Insert a new node into an existing edge (split source→target with it between),
	 *  wiring the new block's first input/output handle. Returns the new node id. */
	insertNode(entry: BlockEntry, edgeId: string, position: { x: number; y: number }): string | null {
		// ⛔ ITS OWN GUARD, THOUGH `addNode` ALREADY HAS ONE. This method REWRITES `this.edges`
		// after the add — splitting the edge in two — so leaning on the callee would leave the
		// edge list mutated around a node that was never created.
		if (this.locked) return null;
		const edge = this.edges.find((e) => e.id === edgeId);
		if (!edge) return null;
		const id = this.addNode(entry, position);
		const inHandle = Object.keys(entry.descriptor.inputs)[0] ?? 'in';
		const outHandle = Object.keys(entry.descriptor.outputs)[0] ?? 'out';
		this.edges = [
			...this.edges.filter((e) => e.id !== edgeId),
			{ id: `e_${crypto.randomUUID().slice(0, 8)}`, source: edge.source, target: id, sourceHandle: edge.sourceHandle, targetHandle: inHandle },
			{ id: `e_${crypto.randomUUID().slice(0, 8)}`, source: id, target: edge.target, sourceHandle: outHandle, targetHandle: edge.targetHandle }
		];
		return id;
	}

	/** Is the given input handle on a node fed by an incoming edge? */
	isInputConnected(nodeId: string, handle: string): boolean {
		return this.edges.some((e) => e.target === nodeId && e.targetHandle === handle);
	}

	// ---- Phase 5: foreach (loop) authoring --------------------------------------
	// Author the flat backend shape (kind:'foreach' container + body nodes carrying parentId + a
	// loop config) directly on the canvas. The pure transforms live in builder-graph.ts.

	/** Drop a new bounded-loop container at a canvas position. Returns its id. */
	addForeach(position: { x: number; y: number }): string {
		if (this.locked) return '';
		const id = `fe_${crypto.randomUUID().slice(0, 8)}`;
		this.nodes = orderParentsFirst([...this.nodes, newForeachNode(id, position)]);
		this.selectedNodeId = id;
		return id;
	}

	/** Make `nodeId` a body node of `foreachId`. */
	assignToLoop(nodeId: string, foreachId: string): void {
		if (this.locked) return;
		this.nodes = assignToLoop(this.nodes, nodeId, foreachId);
	}

	/** Detach `nodeId` from its loop. */
	removeFromLoop(nodeId: string): void {
		if (this.locked) return;
		this.nodes = removeFromLoop(this.nodes, nodeId);
	}

	/** Update a foreach container's bounds config (rowsInput / maxIterations). */
	setLoopConfig(foreachId: string, patch: { rowsInput?: string; maxIterations?: number }): void {
		if (this.locked) return;
		this.nodes = setLoopConfig(this.nodes, foreachId, patch);
	}
}
