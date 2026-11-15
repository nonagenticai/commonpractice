// src/lib/stores/builder-graph.ts — pure (runes-free) mapping between the persisted FlowGraph and
// the SvelteFlow canvas nodes, plus the Phase-5 foreach (loop) authoring transforms. Kept out of
// builder.svelte.ts so it's unit-testable under the node-env vitest (which doesn't compile Svelte
// runes). The store is a thin reactive wrapper that calls these and reassigns its $state arrays.
//
// Coordinate contract: the persisted graph stores ABSOLUTE positions for every node. SvelteFlow
// positions a child relative to its parent, so a loop body node's coords are translated by its
// foreach container's origin on load and un-translated on serialize — the round-trip is lossless.
import type { Node, Edge } from '@xyflow/svelte';
import type { BlockCategory, BlockDescriptor } from '$lib/types/blocks';
import type { FlowGraph } from '$lib/types/flows';

/**
 * The descriptor a node gets when its block's `GET /api/blocks/:slug` never answered.
 *
 * ⛔ SHAPE-IDENTICAL TO AN EMPTY DESCRIPTOR ON PURPOSE, AND THAT IS EXACTLY WHY IT NEEDS A NAME.
 * The build page used to hand `flowToCanvasNodes` a private `EMPTY_DESC` on a cache miss, so a node
 * whose descriptor could not be fetched was INDISTINGUISHABLE from a block that genuinely declares
 * no ports. It rendered zero `<Handle>`s, `@xyflow/svelte` dropped every edge touching it out of the
 * RENDERED edge map (`store/visibleElements.js`'s `getLayoutedEdges`) while leaving it in
 * `signals.edges` — the error goes to `devWarn`, which is gated on `NODE_ENV === 'development'` and
 * therefore silent in production. The edge stayed SAVED and vanished from the SCREEN, and the reader
 * re-drew or deleted it. The user performed the data loss. `descriptorUnavailable` on the node data
 * is what tells the two apart; this constant is only its port-less payload.
 */
export const UNRESOLVED_DESCRIPTOR: BlockDescriptor = {
	inputs: {},
	outputs: {},
	capabilities: {}
};

/** Synthetic descriptor for a foreach container node so the canvas can render its ports without a
 *  block lookup (mirrors backend flow-validate.FOREACH_DESCRIPTOR). */
export const FOREACH_NODE_DESCRIPTOR: BlockDescriptor = {
	inputs: { in: { type: 'json' } },
	outputs: {
		item: { type: 'json' },
		index: { type: 'number' },
		results: { type: 'json' },
		count: { type: 'number' },
		errors: { type: 'number' }
	},
	capabilities: {}
};

/**
 * Does a node of this `kind` run a published library block — i.e. is there a `building_blocks` row
 * behind its slug?
 *
 * ⛔ THE ONE COPY OF THIS CONDITION, AND IT IS ONE COPY BECAUSE THE SECOND COPY IS WHAT BROKE.
 * A foreach container is control flow: `newForeachNode` (below) stamps the literal slug `foreach`,
 * `canvasToFlowGraph` PERSISTS it into `flows.graph`, and the library has never had a block by that
 * name. Every site that turns graph nodes into block lookups therefore has to skip them. There were
 * two such sites in `routes/build/+page.svelte` — the submit payload (`nodeSlugs`) and the load-time
 * descriptor prefetch (`openFlow`) — the first filtered, the second did not, and the second fired a
 * `GET /api/blocks/foreach → 404` on every load of every flow containing a loop, swallowed by a
 * `.catch(() => null)` so nothing but the network tab ever said so. Both now call THIS.
 *
 * ⚠️ `!== 'foreach'`, NOT `=== 'block'`. The field is OPTIONAL on the wire (see `FlowNode.kind`):
 * every flow saved before Phase 5, and every node the current builder creates for a plain block,
 * carries no `kind` at all. A positive test would skip the entire pre-Phase-5 corpus — i.e. stop
 * prefetching every descriptor in it — which is the same defect pointed the other way.
 */
export function isBlockKind(kind: 'block' | 'foreach' | undefined): boolean {
	return kind !== 'foreach';
}

/** Default iteration cap a new loop is created with (the executor clamps to the org policy). */
export const DEFAULT_MAX_ITERATIONS = 100;
/** Hard UI cap for the iteration field — mirrors the executor's default policy cap (1000). */
export const HARD_MAX_ITERATIONS = 1000;

/** A palette entry / resolved block ready to instantiate on the canvas. */
export interface BlockEntry {
	blockId: string;
	blockVersionId: string;
	slug: string;
	name: string;
	category: BlockCategory;
	descriptor: BlockDescriptor;
}

/** data payload carried on each SvelteFlow node. */
export interface BlockNodeData extends Record<string, unknown> {
	blockId: string;
	blockVersionId: string;
	slug: string;
	label: string;
	category: BlockCategory;
	descriptor: BlockDescriptor;
	config: Record<string, unknown>;
	/** Live execution status during a test run (Session 3). Not persisted. */
	runtimeStatus?: 'running' | 'ok' | 'error' | 'skipped';
	/**
	 * True when `resolve` could not produce this node's descriptor at load time, i.e. `descriptor`
	 * is `UNRESOLVED_DESCRIPTOR` and its real ports are UNKNOWN — not empty. Consumers must say so
	 * (BlockNode renders the unavailable notice instead of the `—` no-ports placeholder) rather than
	 * render an empty node that silently un-draws every edge attached to it.
	 *
	 * ⛔ NOT PERSISTED. `canvasToFlowGraph` whitelists the fields it serializes, so this never
	 * reaches `flows.graph` and no serializer change is needed — a transport failure must not be
	 * written into the flow that outlives it.
	 */
	descriptorUnavailable?: boolean;
	// ---- Phase 5: foreach fields ----
	/** 'foreach' = a loop container node (runs no block); absent/'block' = a normal block node. */
	kind?: 'block' | 'foreach';
	/** Set on a loop body node: the id of the foreach container that owns it. */
	parentId?: string;
	/** foreach config (on the container node). */
	loop?: { rowsInput?: string; maxIterations?: number };
}

export type CpNode = Node<BlockNodeData>;

/**
 * The ONE width of a block node on the canvas. `BlockNode.svelte` renders at this width,
 * `FlowCanvas.svelte` uses it for the drag-into-loop hit test, and `foreachSize` below wraps body
 * nodes with it. It was 190 and written in three places; a 190px node ellipsised ordinary block
 * names ("OCR-s…"). Change it here and nowhere else (`node-width.test.ts` pins that).
 */
export const BLOCK_NODE_W = 240;

// Foreach container sizing. The region wraps its body; we recompute its size from the body's
// bounding box (children are positioned relative to the container) so a reloaded loop still
// visually contains its nodes without persisting width/height in the graph.
// ⚠️ DERIVED FROM `BLOCK_NODE_W`, not literals: the old 340 was sized for a 190px body node, so
// after 190 → 240 an empty loop no longer held one block beside its output labels.
const FOREACH_PAD = 30;
/** Room on the inline-end side for the loop's own output labels (Item, Index, …). */
const FOREACH_PORT_GUTTER = 70;
/** The smallest a reader can resize a loop to: one body block plus padding. */
export const FOREACH_RESIZE_MIN_W = BLOCK_NODE_W + 2 * FOREACH_PAD;
export const FOREACH_RESIZE_MIN_H = 160;
/** A new or empty loop: one body block, padding, and the output labels. */
export const FOREACH_MIN_W = FOREACH_RESIZE_MIN_W + FOREACH_PORT_GUTTER;
export const FOREACH_MIN_H = 190;
const BODY_NODE_H = 140; // generous body-node height estimate

// ── Placement of a node nobody pointed at (palette click/keyboard, the assistant's add) ───────
const PLACE_ORIGIN = { x: 280, y: 140 };
const PLACE_GAP = 48;
const PLACE_PER_ROW = 4;

/**
 * Where a new node lands when no drop point was given: to the right of the last top-level node, a
 * new row every four, and never on top of anything already on the canvas.
 *
 * ⛔ THIS REPLACES A COUNT-BASED CASCADE (`280 + (n % 4) * 60, 140 + n * 36`). Its steps were a
 * quarter of a node wide and a third of a node tall, so three palette clicks drew three blocks on
 * top of each other; and because it read `nodes.length`, deleting a node made the next add land
 * EXACTLY on a survivor. Placement is now decided against the boxes actually on the canvas.
 */
export function nextFreePosition(nodes: readonly CpNode[]): { x: number; y: number } {
	const roots = nodes.filter((n) => !n.parentId && !n.data.parentId);
	const box = (n: CpNode) => {
		const fe = n.data.kind === 'foreach' ? foreachSize([]) : null;
		return {
			x: n.position.x,
			y: n.position.y,
			w: n.measured?.width ?? n.width ?? fe?.width ?? BLOCK_NODE_W,
			h: n.measured?.height ?? n.height ?? fe?.height ?? BODY_NODE_H
		};
	};
	const free = (p: { x: number; y: number }) =>
		!roots.some((n) => {
			const b = box(n);
			return (
				p.x < b.x + b.w + PLACE_GAP / 2 &&
				p.x + BLOCK_NODE_W + PLACE_GAP / 2 > b.x &&
				p.y < b.y + b.h + PLACE_GAP / 2 &&
				p.y + BODY_NODE_H + PLACE_GAP / 2 > b.y
			);
		});
	const last = roots[roots.length - 1];
	let cand: { x: number; y: number };
	if (!last) cand = { ...PLACE_ORIGIN };
	else if (roots.length % PLACE_PER_ROW === 0) {
		const bottom = Math.max(...roots.map((n) => box(n).y + box(n).h));
		cand = { x: PLACE_ORIGIN.x, y: bottom + PLACE_GAP };
	} else {
		const b = box(last);
		cand = { x: b.x + b.w + PLACE_GAP, y: b.y };
	}
	// Bounded walk down the column; a graph that fills 200 rows has bigger problems than placement.
	for (let i = 0; i < 200 && !free(cand); i++) cand = { x: cand.x, y: cand.y + BODY_NODE_H + PLACE_GAP };
	return cand;
}

/** Height assumed for a top-level node when separating a freshly loaded graph. Nothing is measured
 *  yet at load time; a block's header plus one port row is ~80px, so 100 counts two nodes on the
 *  same visual row as colliding without touching nodes that sit in rows above or below. */
const LOAD_NODE_H = 100;

/**
 * Push apart top-level nodes that overlap at the CURRENT node width, on load only.
 *
 * ⛔ WHY THIS EXISTS. `BLOCK_NODE_W` went 190 → 240, and every flow saved before that was laid out
 * for 190px: two blocks placed side by side with a ~40px gap now overlap by ~10px and the right one
 * hides the left one's output port ("OCR-scan" under "Claimformulier lezen" in prod). The saved
 * positions are not wrong data, they are data for an older renderer, so they are NOT rewritten on
 * the server here — `BuilderStore.load` applies this to the in-memory graph and `/build` takes its
 * autosave baseline AFTER the load, so the nudged positions reach `flows.graph` only when the
 * author's next edit saves the flow anyway.
 *
 * Sweep left → right by x (then y): a node whose box overlaps an already-placed node on the same
 * visual row (by that node's NEW position) moves right to just past it, plus `PLACE_GAP`. Only x
 * changes, so vertical relationships are untouched, and since a pushed node always lands right of
 * the node that pushed it, left-to-right order along a row (a chain a → b → c) is preserved.
 * Loop body nodes (`parentId`) are parent-relative and left alone; a foreach container takes part
 * at its own size. Returns the SAME array when nothing overlaps.
 */
export function separateOverlappingNodes(nodes: CpNode[]): CpNode[] {
	const isRoot = (n: CpNode) => !n.parentId && !n.data.parentId;
	const roots = nodes
		.filter(isRoot)
		.sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
	const w = (n: CpNode) => n.width ?? BLOCK_NODE_W;
	const h = (n: CpNode) => n.height ?? LOAD_NODE_H;
	const placed: { x: number; y: number; w: number; h: number }[] = [];
	const moved = new Map<string, number>();
	for (const n of roots) {
		let x = n.position.x;
		const y = n.position.y;
		// Re-scan after every push: moving past one node can land the box on the next one.
		for (let pushed = true; pushed; ) {
			pushed = false;
			for (const p of placed) {
				const overlaps = x < p.x + p.w && x + w(n) > p.x && y < p.y + p.h && y + h(n) > p.y;
				if (overlaps) {
					x = p.x + p.w + PLACE_GAP;
					pushed = true;
				}
			}
		}
		placed.push({ x, y, w: w(n), h: h(n) });
		if (x !== n.position.x) moved.set(n.id, x);
	}
	if (moved.size === 0) return nodes;
	return nodes.map((n) => {
		const x = moved.get(n.id);
		return x === undefined ? n : { ...n, position: { x, y: n.position.y } };
	});
}

/** Size a foreach container to wrap its body nodes (relative child positions), never below the
 *  minimum so an empty loop is still a visible drop target. */
export function foreachSize(children: { position: { x: number; y: number } }[]): {
	width: number;
	height: number;
} {
	let width = FOREACH_MIN_W;
	let height = FOREACH_MIN_H;
	for (const c of children) {
		width = Math.max(width, c.position.x + BLOCK_NODE_W + FOREACH_PAD);
		height = Math.max(height, c.position.y + BODY_NODE_H + FOREACH_PAD);
	}
	return { width, height };
}

/** SvelteFlow requires a parent node to precede its children in the array. Body nodes carry a
 *  parentId; foreach containers (and all other nodes) are roots. Single-level only (no nesting). */
export function orderParentsFirst(nodes: CpNode[]): CpNode[] {
	const children = nodes.filter((n) => n.data.parentId);
	if (!children.length) return nodes;
	return [...nodes.filter((n) => !n.data.parentId), ...children];
}

/** Detach a body node from its loop: drop both SvelteFlow's `parentId` and CP's `data.parentId`,
 *  and set its (already re-absolutized) position. */
function detachFromParent(n: CpNode, abs: { x: number; y: number }): CpNode {
	const { parentId: _drop, ...restData } = n.data;
	const next: CpNode = { ...n, position: abs, data: restData as BlockNodeData };
	delete next.parentId;
	return next;
}

/** Absolute canvas position of a node (body-node positions are stored parent-relative). */
function absPos(nodes: CpNode[], node: CpNode): { x: number; y: number } {
	if (!node.data.parentId) return node.position;
	const parent = nodes.find((p) => p.id === node.data.parentId);
	return parent
		? { x: node.position.x + parent.position.x, y: node.position.y + parent.position.y }
		: node.position;
}

/** Grow a foreach container to wrap its current body (never shrinks below a manual resize). */
function resized(nodes: CpNode[], foreachId: string): CpNode[] {
	return nodes.map((n) => {
		if (n.id !== foreachId) return n;
		const size = foreachSize(nodes.filter((k) => k.data.parentId === foreachId));
		return {
			...n,
			width: Math.max(n.width ?? 0, size.width),
			height: Math.max(n.height ?? 0, size.height)
		};
	});
}

/**
 * Build the canvas nodes for a persisted graph. `resolve` maps a (slug, versionId) to its block
 * descriptor; foreach containers use the synthetic descriptor.
 *
 * ⛔ `resolve` RETURNS `null` FOR "I COULD NOT FIND OUT", NOT AN EMPTY DESCRIPTOR. The caller's
 * prefetch is `ensureBlock(s).catch(() => null)` — deliberately swallowing, because one archived
 * block must not abort the whole flow load — so a miss is an ordinary outcome, and the widened
 * return type is what stops it being laundered into "this block has no ports". See
 * `UNRESOLVED_DESCRIPTOR`.
 */
export function flowToCanvasNodes(
	graph: FlowGraph,
	resolve: (slug: string, versionId: string) => BlockDescriptor | null
): CpNode[] {
	const foreachAbs = new Map<string, { x: number; y: number }>();
	for (const n of graph.nodes) {
		if (n.kind === 'foreach') foreachAbs.set(n.id, { x: n.position.x, y: n.position.y });
	}
	const nodes: CpNode[] = graph.nodes.map((n) => {
		// A foreach container's ports never come off the wire, so it can never be unresolved.
		const resolved =
			n.kind === 'foreach' ? FOREACH_NODE_DESCRIPTOR : resolve(n.slug, n.blockVersionId);
		const parentAbs = n.parentId ? foreachAbs.get(n.parentId) : undefined;
		const position = parentAbs
			? { x: n.position.x - parentAbs.x, y: n.position.y - parentAbs.y }
			: { x: n.position.x, y: n.position.y };
		const node: CpNode = {
			id: n.id,
			type: n.kind === 'foreach' ? 'foreach' : 'block',
			position,
			data: {
				blockId: n.blockId,
				blockVersionId: n.blockVersionId,
				slug: n.slug,
				label: n.label,
				category: n.category,
				descriptor: resolved ?? UNRESOLVED_DESCRIPTOR,
				...(resolved ? {} : { descriptorUnavailable: true }),
				config: { ...n.config },
				...(n.kind ? { kind: n.kind } : {}),
				...(n.parentId ? { parentId: n.parentId } : {}),
				...(n.loop ? { loop: n.loop } : {})
			}
		};
		// SvelteFlow nesting (no `extent` → the body can be dragged out of the loop to detach it).
		if (parentAbs) node.parentId = n.parentId;
		return node;
	});
	for (const fe of nodes) {
		if (fe.data.kind !== 'foreach') continue;
		const size = foreachSize(nodes.filter((k) => k.data.parentId === fe.id));
		fe.width = size.width;
		fe.height = size.height;
	}
	return orderParentsFirst(nodes);
}

/**
 * Fill in one slug's descriptor on the nodes that are still waiting for it, and clear the flag.
 *
 * ⛔ THE RETRY PATH IS A PATCH, NEVER A RELOAD, and that is the whole reason this exists as its own
 * function. Re-running `openFlow` would re-fetch the flow from the server and throw away every edit
 * the reader has made since the load — which is the same data loss the unavailable-descriptor
 * notice is there to prevent, arriving through the fix instead of the bug.
 *
 * Returns the SAME array reference when nothing matched, so a no-op retry does not reassign
 * `builder.nodes` and push a phantom entry onto the undo stack.
 */
export function applyResolvedDescriptor(
	nodes: CpNode[],
	slug: string,
	resolve: (slug: string, versionId: string) => BlockDescriptor | null
): CpNode[] {
	let changed = false;
	const next = nodes.map((n) => {
		if (n.data.slug !== slug || !n.data.descriptorUnavailable) return n;
		const descriptor = resolve(n.data.slug, n.data.blockVersionId);
		if (!descriptor) return n; // still unavailable — leave the flag standing
		changed = true;
		const { descriptorUnavailable: _resolved, ...rest } = n.data;
		return { ...n, data: { ...rest, descriptor } as BlockNodeData };
	});
	return changed ? next : nodes;
}

/** Serialize canvas nodes + edges back to a persistable FlowGraph (absolute positions). */
export function canvasToFlowGraph(nodes: CpNode[], edges: Edge[]): FlowGraph {
	const foreachAbs = new Map<string, { x: number; y: number }>();
	for (const n of nodes) {
		if (n.data.kind === 'foreach') foreachAbs.set(n.id, { x: n.position.x, y: n.position.y });
	}
	return {
		nodes: nodes.map((n) => {
			const parentAbs = n.data.parentId ? foreachAbs.get(n.data.parentId) : undefined;
			const abs = parentAbs
				? { x: n.position.x + parentAbs.x, y: n.position.y + parentAbs.y }
				: n.position;
			return {
				id: n.id,
				blockId: n.data.blockId,
				blockVersionId: n.data.blockVersionId,
				slug: n.data.slug,
				label: n.data.label,
				category: n.data.category,
				config: n.data.config,
				position: { x: Math.round(abs.x), y: Math.round(abs.y) },
				...(n.data.kind ? { kind: n.data.kind } : {}),
				...(n.data.parentId ? { parentId: n.data.parentId } : {}),
				...(n.data.loop ? { loop: n.data.loop } : {})
			};
		}),
		edges: edges.map((e) => ({
			id: e.id,
			source: e.source,
			sourceHandle: e.sourceHandle ?? '',
			target: e.target,
			targetHandle: e.targetHandle ?? ''
		}))
	};
}

/** A fresh foreach container node (the caller supplies a generated id). */
export function newForeachNode(id: string, position: { x: number; y: number }): CpNode {
	return {
		id,
		type: 'foreach',
		position,
		width: FOREACH_MIN_W,
		height: FOREACH_MIN_H,
		data: {
			blockId: '',
			blockVersionId: '',
			slug: 'foreach',
			label: 'For each row',
			category: 'logic',
			descriptor: FOREACH_NODE_DESCRIPTOR,
			config: {},
			kind: 'foreach',
			loop: { rowsInput: 'in', maxIterations: DEFAULT_MAX_ITERATIONS }
		}
	};
}

/** Make `nodeId` a body node of `foreachId` (single-level only; a foreach can't nest in a foreach). */
export function assignToLoop(nodes: CpNode[], nodeId: string, foreachId: string): CpNode[] {
	const fe = nodes.find((n) => n.id === foreachId && n.data.kind === 'foreach');
	const node = nodes.find((n) => n.id === nodeId);
	if (!fe || !node || node.id === foreachId || node.data.kind === 'foreach') return nodes;
	if (node.data.parentId === foreachId) return nodes;
	const abs = absPos(nodes, node);
	const rel = { x: abs.x - fe.position.x, y: abs.y - fe.position.y };
	const next = orderParentsFirst(
		nodes.map((n) =>
			n.id === nodeId
				? { ...n, position: rel, parentId: foreachId, data: { ...n.data, parentId: foreachId } }
				: n
		)
	);
	return resized(next, foreachId);
}

/** Detach `nodeId` from its loop (re-absolutize its position). No-op if it isn't in a loop. */
export function removeFromLoop(nodes: CpNode[], nodeId: string): CpNode[] {
	const node = nodes.find((n) => n.id === nodeId);
	if (!node || !node.data.parentId) return nodes;
	const parentId = node.data.parentId;
	const abs = absPos(nodes, node);
	const next = orderParentsFirst(nodes.map((n) => (n.id === nodeId ? detachFromParent(n, abs) : n)));
	return resized(next, parentId);
}

/** Update a foreach container's bounds config (rowsInput / maxIterations). */
export function setLoopConfig(
	nodes: CpNode[],
	foreachId: string,
	patch: { rowsInput?: string; maxIterations?: number }
): CpNode[] {
	return nodes.map((n) =>
		n.id === foreachId ? { ...n, data: { ...n.data, loop: { ...(n.data.loop ?? {}), ...patch } } } : n
	);
}

/** Remove a node; if it's a foreach container, ORPHAN its body (re-absolutize + detach each child)
 *  rather than silently deleting the body nodes. Returns the new nodes array (edge cleanup is the
 *  caller's job). */
export function removeNodeFromNodes(nodes: CpNode[], nodeId: string): CpNode[] {
	const removed = nodes.find((n) => n.id === nodeId) ?? null;
	return nodes
		.filter((n) => n.id !== nodeId)
		.map((n) => {
			if (n.data.parentId !== nodeId) return n;
			const abs = removed
				? { x: n.position.x + removed.position.x, y: n.position.y + removed.position.y }
				: n.position;
			return detachFromParent(n, abs);
		});
}
