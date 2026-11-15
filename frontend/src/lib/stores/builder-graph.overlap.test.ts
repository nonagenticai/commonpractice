// src/lib/stores/builder-graph.overlap.test.ts — saved flows laid out for 190px nodes must not
// render as a pile once the node is 240px wide.
//
// ⛔ THE DEFECT (live walk, prod, after #444). `BLOCK_NODE_W` went 190 → 240 and an existing flow
// opened with "OCR-scan" drawn underneath "Claimformulier lezen": they were saved ~40px apart at
// 190px and now overlap by ~10px. `separateOverlappingNodes` nudges them apart on LOAD, in memory
// only; the last block below drives `BuilderStore.load` itself, so reverting the call site there
// (back to a bare `flowToCanvasNodes(...)`) goes red even though the helper still exists.
import { describe, it, expect } from 'vitest';
import type { BlockDescriptor } from '$lib/types/blocks';
import type { Flow, FlowGraph } from '$lib/types/flows';
import { BLOCK_NODE_W, flowToCanvasNodes, separateOverlappingNodes, type CpNode } from './builder-graph';
import { BuilderStore } from './builder.svelte';

const DESC: BlockDescriptor = { inputs: { in: { type: 'json' } }, outputs: { out: { type: 'json' } }, capabilities: {} };
const resolve = () => DESC;

function block(id: string, x: number, y: number, extra: Record<string, unknown> = {}): FlowGraph['nodes'][number] {
	return { id, blockId: `b_${id}`, blockVersionId: `v_${id}`, slug: id, label: id, category: 'logic', config: {}, position: { x, y }, ...extra };
}
const canvas = (nodes: FlowGraph['nodes']) => flowToCanvasNodes({ nodes, edges: [] }, resolve);
const pos = (nodes: CpNode[]) => Object.fromEntries(nodes.map((n) => [n.id, { ...n.position }]));
type Box = { x: number; y: number };
const overlapping = (a: Box, b: Box, h = 100) =>
	a.x < b.x + BLOCK_NODE_W && a.x + BLOCK_NODE_W > b.x && a.y < b.y + h && a.y + h > b.y;

describe('separateOverlappingNodes', () => {
	it('is a no-op (same array) when nothing overlaps', () => {
		const nodes = canvas([block('a', 0, 0), block('b', 300, 0), block('c', 0, 300)]);
		expect(separateOverlappingNodes(nodes)).toBe(nodes);
	});

	it('pushes the right node of an overlapping pair past the left one, keeping y', () => {
		// The prod pair: laid out 232px apart for a 190px node, i.e. 8px overlap at 240px.
		const nodes = canvas([block('ocr', 716, 552), block('claim', 948, 548)]);
		const out = pos(separateOverlappingNodes(nodes));
		expect(out.ocr).toEqual({ x: 716, y: 552 });
		expect(out.claim.y).toBe(548);
		expect(out.claim.x).toBeGreaterThanOrEqual(716 + BLOCK_NODE_W);
		expect(overlapping(out.ocr, out.claim)).toBe(false);
	});

	it('separates a chain and preserves left-to-right order', () => {
		const nodes = canvas([block('a', 0, 0), block('b', 200, 10), block('c', 400, 0), block('d', 600, 20)]);
		const out = pos(separateOverlappingNodes(nodes));
		const xs = ['a', 'b', 'c', 'd'].map((id) => out[id].x);
		expect(xs).toEqual([...xs].sort((p, q) => p - q));
		expect(new Set(xs).size).toBe(4);
		for (const [i, j] of [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'c'], ['b', 'd']]) {
			expect(overlapping(out[i], out[j]), `${i}/${j} still overlap`).toBe(false);
		}
		expect(['a', 'b', 'c', 'd'].map((id) => out[id].y)).toEqual([0, 10, 0, 20]);
	});

	it('leaves nodes on other rows alone, and does not mutate its input', () => {
		const nodes = canvas([block('a', 0, 0), block('b', 200, 0), block('below', 100, 300)]);
		const before = JSON.stringify(nodes);
		const out = pos(separateOverlappingNodes(nodes));
		expect(out.below).toEqual({ x: 100, y: 300 });
		expect(out.a).toEqual({ x: 0, y: 0 });
		expect(JSON.stringify(nodes)).toBe(before);
	});

	it('does not move loop body nodes (their positions are parent-relative)', () => {
		const nodes = canvas([
			block('loop', 0, 0, { kind: 'foreach' }),
			block('body1', 20, 40, { parentId: 'loop' }),
			block('body2', 30, 40, { parentId: 'loop' })
		]);
		const out = pos(separateOverlappingNodes(nodes));
		expect(out.body1).toEqual({ x: 20, y: 40 });
		expect(out.body2).toEqual({ x: 30, y: 40 });
	});
});

describe('BuilderStore.load nudges in memory only', () => {
	function flow(graph: FlowGraph): Flow {
		return { id: 'f1', name: 'Claims', graph } as unknown as Flow;
	}

	it('loads an overlapping saved flow already separated', () => {
		const graph: FlowGraph = { nodes: [block('ocr', 716, 552), block('claim', 948, 548)], edges: [] };
		const store = new BuilderStore();
		store.load(flow(graph), resolve);
		const out = pos(store.nodes);
		expect(
			overlapping(out.ocr, out.claim),
			'BuilderStore.load rendered the saved 190px layout as-is: the nodes overlap at 240px'
		).toBe(false);
		// The persisted graph object is not rewritten; only the next save carries the new x.
		expect(graph.nodes.find((n) => n.id === 'claim')!.position).toEqual({ x: 948, y: 548 });
		expect(store.serialize().nodes.find((n) => n.id === 'claim')!.position.x).toBe(out.claim.x);
	});
});
