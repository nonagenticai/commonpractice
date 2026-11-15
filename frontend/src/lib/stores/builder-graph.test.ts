// src/lib/stores/builder-graph.test.ts — the Phase-5 loop authoring contract. The hard invariant
// is the coordinate round-trip: body-node positions are stored ABSOLUTE but rendered parent-relative,
// so load→serialize must reproduce the persisted graph byte-for-byte (per node id). These are pure
// transforms (no Svelte runes), so they run under the node-env vitest.
import { test, expect } from 'vitest';
import type { BlockDescriptor } from '$lib/types/blocks';
import type { FlowGraph } from '$lib/types/flows';
import {
	flowToCanvasNodes,
	canvasToFlowGraph,
	newForeachNode,
	assignToLoop,
	removeFromLoop,
	setLoopConfig,
	removeNodeFromNodes,
	applyResolvedDescriptor,
	UNRESOLVED_DESCRIPTOR,
	type CpNode
} from './builder-graph';

const DESC: BlockDescriptor = { inputs: { in: { type: 'json' } }, outputs: { out: { type: 'json' } }, capabilities: {} };
const resolve = () => DESC;

/** Sort a graph's nodes by id so round-trip comparison ignores array order (load reorders parents-first). */
function byId(g: FlowGraph): FlowGraph {
	return {
		nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)),
		edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id))
	};
}

function block(id: string, x: number, y: number, extra: Record<string, unknown> = {}): FlowGraph['nodes'][number] {
	return { id, blockId: `b_${id}`, blockVersionId: `v_${id}`, slug: id, label: id, category: 'logic', config: {}, position: { x, y }, ...extra };
}

test('plain (loop-free) graph round-trips identically', () => {
	const graph: FlowGraph = {
		nodes: [block('a', 100, 100), block('b', 400, 100)],
		edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }]
	};
	const nodes = flowToCanvasNodes(graph, resolve);
	expect(byId(canvasToFlowGraph(nodes, graph.edges.map((e) => ({ ...e }))))).toEqual(byId(graph));
});

test('foreach + body graph round-trips with absolute coords (the key invariant)', () => {
	const graph: FlowGraph = {
		nodes: [
			block('src', 40, 60), // data source feeding the loop
			{ id: 'fe1', blockId: '', blockVersionId: '', slug: 'foreach', label: 'For each row', category: 'logic', config: {}, position: { x: 400, y: 200 }, kind: 'foreach', loop: { rowsInput: 'in', maxIterations: 50 } },
			block('body', 520, 300, { parentId: 'fe1' }) // absolute (520,300) → relative (120,100) inside fe1
		],
		edges: [
			{ id: 'e1', source: 'src', sourceHandle: 'out', target: 'fe1', targetHandle: 'in' },
			{ id: 'e2', source: 'fe1', sourceHandle: 'item', target: 'body', targetHandle: 'in' }
		]
	};
	const nodes = flowToCanvasNodes(graph, resolve);
	// Body node is rendered parent-relative.
	const body = nodes.find((n) => n.id === 'body')!;
	expect(body.position).toEqual({ x: 120, y: 100 });
	expect(body.parentId).toBe('fe1');
	expect(body.data.parentId).toBe('fe1');
	// Parent precedes child (SvelteFlow requirement).
	expect(nodes.findIndex((n) => n.id === 'fe1')).toBeLessThan(nodes.findIndex((n) => n.id === 'body'));
	// And it serializes back to the exact persisted graph.
	expect(byId(canvasToFlowGraph(nodes, graph.edges.map((e) => ({ ...e }))))).toEqual(byId(graph));
});

test('assignToLoop converts a root node into a parent-relative body node; serialize keeps its absolute spot', () => {
	const fe = newForeachNode('fe1', { x: 400, y: 200 });
	const node: CpNode = {
		id: 'n1', type: 'block', position: { x: 520, y: 260 },
		data: { blockId: 'b', blockVersionId: 'v', slug: 'x', label: 'x', category: 'logic', descriptor: DESC, config: {} }
	};
	let nodes = [fe, node];
	nodes = assignToLoop(nodes, 'n1', 'fe1');
	const moved = nodes.find((n) => n.id === 'n1')!;
	expect(moved.data.parentId).toBe('fe1');
	expect(moved.parentId).toBe('fe1');
	expect(moved.position).toEqual({ x: 120, y: 60 }); // 520-400, 260-200
	// Its absolute position survives a serialize.
	const out = canvasToFlowGraph(nodes, []);
	expect(out.nodes.find((n) => n.id === 'n1')!.position).toEqual({ x: 520, y: 260 });
	expect(out.nodes.find((n) => n.id === 'n1')!.parentId).toBe('fe1');
});

test('removeFromLoop re-absolutizes and detaches', () => {
	const fe = newForeachNode('fe1', { x: 400, y: 200 });
	let nodes: CpNode[] = [fe, {
		id: 'n1', type: 'block', position: { x: 700, y: 350 },
		data: { blockId: 'b', blockVersionId: 'v', slug: 'x', label: 'x', category: 'logic', descriptor: DESC, config: {} }
	}];
	nodes = assignToLoop(nodes, 'n1', 'fe1');
	nodes = removeFromLoop(nodes, 'n1');
	const n1 = nodes.find((n) => n.id === 'n1')!;
	expect(n1.data.parentId).toBeUndefined();
	expect(n1.parentId).toBeUndefined();
	expect(n1.position).toEqual({ x: 700, y: 350 }); // back to absolute
});

test('removing a foreach orphans its body instead of deleting it', () => {
	const fe = newForeachNode('fe1', { x: 400, y: 200 });
	let nodes: CpNode[] = [fe, {
		id: 'n1', type: 'block', position: { x: 500, y: 280 },
		data: { blockId: 'b', blockVersionId: 'v', slug: 'x', label: 'x', category: 'logic', descriptor: DESC, config: {} }
	}];
	nodes = assignToLoop(nodes, 'n1', 'fe1');
	nodes = removeNodeFromNodes(nodes, 'fe1');
	expect(nodes.find((n) => n.id === 'fe1')).toBeUndefined();
	const n1 = nodes.find((n) => n.id === 'n1')!;
	expect(n1).toBeDefined();
	expect(n1.data.parentId).toBeUndefined(); // detached
	expect(n1.position).toEqual({ x: 500, y: 280 }); // re-absolutized (100+400, 80+200)
});

test('setLoopConfig updates only the targeted container', () => {
	const fe = newForeachNode('fe1', { x: 0, y: 0 });
	const nodes = setLoopConfig([fe], 'fe1', { maxIterations: 25 });
	expect(nodes[0]!.data.loop).toEqual({ rowsInput: 'in', maxIterations: 25 });
});

test('a foreach cannot be nested inside another foreach', () => {
	const a = newForeachNode('fa', { x: 0, y: 0 });
	const b = newForeachNode('fb', { x: 300, y: 0 });
	const nodes = assignToLoop([a, b], 'fb', 'fa');
	expect(nodes.find((n) => n.id === 'fb')!.data.parentId).toBeUndefined(); // refused
});

// ---------------------------------------------------------------------------------------------
// A descriptor that could not be fetched is UNKNOWN, not EMPTY.
//
// ⛔ THE DEFECT. `/build`'s `resolveDescriptor` answered a cache MISS with `{inputs:{}, outputs:{},
// capabilities:{}}` — the exact shape of a block that genuinely declares no ports. The node then
// rendered zero `<Handle>`s, `@xyflow/svelte` dropped every edge touching it out of its RENDERED
// edge map (leaving it in the saved graph, complaining only through a `NODE_ENV==='development'`
// `devWarn`), and the author re-drew or deleted an edge that was never broken. These two tests are
// the pure half of the fix: the flag that lets every consumer tell the two apart.
// ---------------------------------------------------------------------------------------------

const unresolvedGraph = (): FlowGraph => ({
	nodes: [block('gone', 100, 100), block('ok', 400, 100)],
	edges: [{ id: 'e1', source: 'gone', sourceHandle: 'out', target: 'ok', targetHandle: 'in' }]
});

test('a resolve that returns null marks the node unavailable, it does not fake an empty block', () => {
	const nodes = flowToCanvasNodes(unresolvedGraph(), () => null);
	// Non-vacuity: the graph really produced nodes to assert about.
	expect(nodes).toHaveLength(2);
	expect(nodes[0]!.data.descriptorUnavailable).toBe(true);
	expect(nodes[0]!.data.descriptor).toBe(UNRESOLVED_DESCRIPTOR);
	// ⛔ AND THE FLAG IS THE ONLY DIFFERENCE THAT EXISTS. The descriptor is deliberately
	// shape-identical to an empty one, so a consumer that reads only `descriptor` cannot tell a
	// failed fetch from a portless block — which is precisely how the defect stayed invisible.
	expect(nodes[0]!.data.descriptor).toEqual({ inputs: {}, outputs: {}, capabilities: {} });
});

test('a resolve that succeeds leaves the flag off — the notice never fires on a healthy load', () => {
	// The over-correction guard: a `descriptorUnavailable: true` stamped unconditionally would pass
	// the test above forever and put an amber pill on every flow anyone ever opens.
	const nodes = flowToCanvasNodes(unresolvedGraph(), resolve);
	expect(nodes.map((n) => n.data.descriptorUnavailable)).toEqual([undefined, undefined]);
	expect(nodes[0]!.data.descriptor).toBe(DESC);
});

test('a foreach container is never unavailable — its ports never came off the wire', () => {
	const graph: FlowGraph = {
		nodes: [
			{ id: 'fe1', blockId: '', blockVersionId: '', slug: 'foreach', label: 'For each row', category: 'logic', config: {}, position: { x: 0, y: 0 }, kind: 'foreach' }
		],
		edges: []
	};
	// A total prefetch outage (`() => null`) must still leave the loop container fully drawn: its
	// descriptor is synthetic, so flagging it would send the reader retrying a fetch that never
	// happens — the sibling of the `GET /api/blocks/foreach → 404` this file already guards.
	const nodes = flowToCanvasNodes(graph, () => null);
	expect(nodes[0]!.data.descriptorUnavailable).toBeUndefined();
	expect(Object.keys(nodes[0]!.data.descriptor.outputs)).toContain('item');
});

test('applyResolvedDescriptor fills in one slug and clears its flag, leaving the others alone', () => {
	const nodes = flowToCanvasNodes(unresolvedGraph(), () => null);
	const next = applyResolvedDescriptor(nodes, 'gone', () => DESC);

	const fixed = next.find((n) => n.id === 'gone')!;
	expect(fixed.data.descriptor).toBe(DESC);
	expect(fixed.data.descriptorUnavailable).toBeUndefined();
	// ⛔ SLUG-SCOPED. A retry that resolved one block must not silently clear the flag on the block
	// still failing beside it — the pill would empty while half the canvas was still lying.
	expect(next.find((n) => n.id === 'ok')!.data.descriptorUnavailable).toBe(true);
	// The reader's canvas is PATCHED, not reloaded: the untouched node keeps its identity.
	expect(next.find((n) => n.id === 'ok')).toBe(nodes.find((n) => n.id === 'ok'));
});

test('applyResolvedDescriptor is a no-op (same reference) when the retry resolves nothing', () => {
	// Reassigning `builder.nodes` for a retry that changed nothing pushes a phantom entry onto the
	// undo stack — the reader's Ctrl-Z then does nothing visible.
	const nodes = flowToCanvasNodes(unresolvedGraph(), () => null);
	expect(applyResolvedDescriptor(nodes, 'gone', () => null)).toBe(nodes);
	expect(applyResolvedDescriptor(nodes, 'never-on-this-canvas', () => DESC)).toBe(nodes);
});

test('an unresolved node still serializes exactly as it loaded — the flag never reaches the wire', () => {
	// ⛔ A TRANSPORT FAILURE MUST NOT BE WRITTEN INTO THE FLOW THAT OUTLIVES IT. The autosave runs
	// 800 ms after any edit, including one made while a descriptor is still unavailable.
	const graph = unresolvedGraph();
	const nodes = flowToCanvasNodes(graph, () => null);
	const out = canvasToFlowGraph(nodes, graph.edges.map((e) => ({ ...e })));
	expect(byId(out)).toEqual(byId(graph));
	expect(JSON.stringify(out)).not.toContain('descriptorUnavailable');
});
