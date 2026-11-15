// src/lib/agent/cascade-position.test.ts — where a node lands when nobody pointed at a spot (a
// palette click or keyboard activation on /build, the assistant's `add_node`).
//
// ⛔ THE DEFECT (browser walk, 2026-10-14). Three palette clicks drew three blocks on top of each
// other. The rule was `{ x: 280 + (n % 4) * 60, y: 140 + n * 36 }`: steps a quarter of a 240px node
// wide and a third of a node tall, so every new block covered most of the last one; and because it
// keyed on `nodes.length`, deleting a node made the next add land EXACTLY on a survivor.
import { describe, it, expect } from 'vitest';
import { BuilderStore, type BlockEntry } from '$lib/stores/builder.svelte';
import { BLOCK_NODE_W } from '$lib/stores/builder-graph';
import { cascadePosition } from './driver';

const ENTRY: BlockEntry = {
	blockId: 'b',
	blockVersionId: 'v',
	slug: 'summarise',
	name: 'Summarise',
	category: 'ai',
	descriptor: { inputs: {}, outputs: {}, capabilities: {} }
};
/** A conservative rendered height for a block node (header + a port or two). */
const NODE_H = 100;

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
	return a.x < b.x + BLOCK_NODE_W && a.x + BLOCK_NODE_W > b.x && a.y < b.y + NODE_H && a.y + NODE_H > b.y;
}
function assertNoOverlap(b: BuilderStore) {
	const ps = b.nodes.map((n) => n.position);
	for (let i = 0; i < ps.length; i++)
		for (let j = i + 1; j < ps.length; j++)
			expect(overlaps(ps[i]!, ps[j]!), `nodes ${i} and ${j} overlap: ${JSON.stringify([ps[i], ps[j]])}`).toBe(false);
}

describe('cascadePosition — palette clicks and the assistant place blocks side by side', () => {
	it('⛔ six successive adds never overlap one another', () => {
		const b = new BuilderStore();
		for (let i = 0; i < 6; i++) b.addNode(ENTRY, cascadePosition(b.nodes));
		expect(b.nodes).toHaveLength(6);
		assertNoOverlap(b);
	});

	it('⛔ after a delete, the next add does not land on a survivor', () => {
		const b = new BuilderStore();
		const ids = [0, 1, 2].map(() => b.addNode(ENTRY, cascadePosition(b.nodes)));
		b.removeNode(ids[1]!);
		b.addNode(ENTRY, cascadePosition(b.nodes));
		assertNoOverlap(b);
	});

	it('steps clear of a node the reader dragged into the next slot', () => {
		const b = new BuilderStore();
		const a = b.addNode(ENTRY, cascadePosition(b.nodes));
		const next = cascadePosition(b.nodes);
		const c = b.addNode(ENTRY, { x: 2000, y: 2000 });
		b.moveNode(c, next); // someone is already standing there
		b.addNode(ENTRY, cascadePosition(b.nodes));
		expect(b.nodes.map((n) => n.id)).toContain(a);
		assertNoOverlap(b);
	});
});
