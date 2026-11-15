// src/lib/stores/node-width.test.ts — ONE block-node width.
//
// The width used to be 190 and written three times: BlockNode's CSS, FlowCanvas's drag-into-loop
// hit test (`NODE_W`), and `foreachSize`'s body estimate. 190px ellipsised ordinary block names
// ("OCR-s…"), and three copies meant a change to one silently desynchronised the hit test and the
// loop sizing from what is drawn.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOCK_NODE_W, foreachSize } from './builder-graph';

const read = (rel: string) => {
	const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
	expect(src.length, `${rel} is empty — every assertion below would pass vacuously`).toBeGreaterThan(100);
	return src;
};

describe('BLOCK_NODE_W', () => {
	it('is 240', () => {
		expect(BLOCK_NODE_W).toBe(240);
	});

	it('is what foreachSize wraps a body node with', () => {
		// x 200 + node + 30 padding — wider than the 340 minimum, so the node width decides it.
		expect(foreachSize([{ position: { x: 200, y: 0 } }]).width).toBe(200 + BLOCK_NODE_W + 30);
	});

	it('BlockNode renders at it and carries no width literal of its own', () => {
		const src = read('src/lib/components/build/BlockNode.svelte');
		expect(src).toMatch(/import \{ BLOCK_NODE_W \} from '\$lib\/stores\/builder-graph'/);
		expect(src).toMatch(/width:\{BLOCK_NODE_W\}px/);
		const css = src.slice(src.indexOf('<style>'));
		const nodeRule = css.match(/\.cp-node\s*\{[^}]*\}/)?.[0] ?? '';
		expect(nodeRule.length, 'no .cp-node rule found').toBeGreaterThan(10);
		expect(nodeRule).not.toMatch(/(^|[^-])width:\s*\d+px/);
	});

	it('FlowCanvas uses it for the hit test and declares no NODE_W copy', () => {
		const src = read('src/lib/components/build/FlowCanvas.svelte');
		expect(src).toMatch(/abs\.x \+ BLOCK_NODE_W \/ 2/);
		expect(src).not.toMatch(/const NODE_W\b/);
	});
});

describe('the canvas zoom', () => {
	it('fits with padding and never above 1:1, inside 0.2–1.5', () => {
		const src = read('src/lib/components/build/FlowCanvas.svelte');
		expect(src).toMatch(/FIT_OPTIONS = \{ padding: 0\.3, maxZoom: 1 \}/);
		expect(src).toMatch(/fitViewOptions=\{FIT_OPTIONS\}/);
		expect(src).toMatch(/minZoom=\{0\.2\}/);
		expect(src).toMatch(/maxZoom=\{1\.5\}/);
	});
});
