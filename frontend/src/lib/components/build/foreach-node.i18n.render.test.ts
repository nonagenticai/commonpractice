// @vitest-environment jsdom
//
// src/lib/components/build/foreach-node.i18n.render.test.ts — the loop container on the canvas must
// carry a title the reader can read.
//
// ⛔ THE DEFECT, AND IT IS VISIBLE SIDE BY SIDE. The palette tile that CREATES this node is already
// localized (`foreach_palette_label`, "Lus (voor elke rij)" in nl), but `newForeachNode`
// (stores/builder-graph.ts) stamps `label: 'For each row'` into the node's `data`, and this
// component rendered `{data.label}` raw. A Dutch author dragged "Lus (voor elke rij)" onto the
// canvas and got an English node header next to it — in every one of the eight locales.
//
// ⛔ WHY THE FIX IS AT RENDER TIME AND NOT AT CREATION TIME. `label` is serialized by
// `toGraph()` and PERSISTED into `flows.graph`. Localizing `newForeachNode` would freeze the
// creator's locale into the saved flow for ever: a Dutch author's flow would show Dutch to a French
// colleague, and re-opening it in another language would not change it back. So the stored label is
// left exactly as it was, and the component — which already knows `data.kind === 'foreach'` —
// resolves the catalog string instead. Nothing about the persisted graph changes.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so the assertions
// state WHICH message resolved without pinning copy. Same technique as
// `run-console.i18n.render.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockNodeData } from '$lib/stores/builder.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

// `Handle`/`NodeResizer` read the SvelteFlow store out of Svelte CONTEXT and throw "must be used
// within a Custom Node component" when mounted bare. Neither contributes text to the header, which
// is this file's whole subject. Same stub as `block-node.port-types.render.test.ts`.
vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	NodeResizer: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

import ForeachNode from './ForeachNode.svelte';
import { BLOCK_NODE_W, FOREACH_MIN_W, newForeachNode } from '$lib/stores/builder-graph';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the node exactly as SvelteFlow does: `data` is the node's persisted `data` bag. */
function renderTitle(data: BlockNodeData): string {
	app = mount(ForeachNode, {
		target: host,
		props: { data, selected: false, width: 340, height: 190 } as never
	});
	flushSync();
	const title = host.querySelector('.fe-title');
	// ⛔ NON-VACUITY: a missing element would make every `not.toBe('For each row')` below pass.
	expect(title, 'the component rendered no title element').not.toBeNull();
	return title!.textContent ?? '';
}

describe('the foreach container names itself from the catalog, not from the stored label', () => {
	it('⛔ the node the palette creates renders the catalog key, not `For each row`', () => {
		// The REAL creation path — `newForeachNode` is what the palette calls — so this cannot pass on
		// a hand-built `data` bag that the product never produces.
		const node = newForeachNode('fe-1', { x: 0, y: 0 });
		// The stored label is still the English one, and MUST be: it is persisted into `flows.graph`.
		expect(node.data.label).toBe('For each row');
		// ⚠️ `foreach_palette_label`, REUSED rather than a new `foreach_node_label` sibling. The palette
		// tile and the node it creates are the same object named twice; two keys would be 8 more
		// catalog strings whose only distinguishing feature is that they drift.
		expect(renderTitle(node.data)).toBe('foreach_palette_label');
	});

	it('a flow LOADED from `flows.graph` — the stored `For each row` literal — renders the same title', () => {
		// The persisted path rather than the creation path: a `data` bag as it comes back out of
		// `flows.graph` for a flow saved by any earlier build, reaching the component through
		// `flowToCanvasNodes` instead of through `newForeachNode`. Every foreach node ever written
		// carries this exact literal, so this is the whole installed base.
		//
		// ⛔ THE ASSERTION IS DELIBERATELY NARROW: it names the ONE stored literal
		// `'For each row'` and says that literal is replaced. It does NOT say "any stored label is
		// replaced", and the difference is a data-loss bug waiting for a feature.
		//
		// Renaming a loop is impossible TODAY — `nodeTypes` maps `foreach` → `ForeachNode`,
		// `flowToCanvasNodes` derives `type` from `kind`, and NOTHING in the product writes
		// `data.label` on a foreach node. So there is no author-chosen label to lose, and the
		// component is free to ignore the field. The day someone adds rename, `data.label` becomes
		// the author's own words and discarding them becomes DATA LOSS ON SCREEN — and this test
		// must be revisited alongside that feature (the title then has to be
		// `data.label ?? m.foreach_palette_label()`, or the rename has to write somewhere else).
		//
		// A broad `expect(renderTitle({ ...data, label: 'Herhaal per klant' })).toBe(catalog title)`
		// — which this case used to be — would have ENSHRINED the discard as desired behaviour: the
		// rename PR would find this test green, read it as "labels are meant to be ignored", and
		// ship the regression with a passing suite as its evidence.
		const stored = {
			...newForeachNode('fe-2', { x: 0, y: 0 }).data,
			label: 'For each row'
		};
		expect(stored.label, 'the literal this case is about is no longer the stored one').toBe(
			'For each row'
		);
		// ONE mount: `renderTitle` mounts into the shared host and `afterEach` unmounts only the last
		// app, so calling it twice would leave the second query reading the FIRST mount's title.
		const title = renderTitle(stored);
		expect(title).toBe('foreach_palette_label');
		expect(title).not.toBe('For each row');
	});

	it('the rest of the header is still localized (the change did not eat the badge)', () => {
		const node = newForeachNode('fe-3', { x: 0, y: 0 });
		app = mount(ForeachNode, {
			target: host,
			props: { data: node.data, selected: false, width: 340, height: 190 } as never
		});
		flushSync();
		// `foreach_iter_badge` takes `{count}` → the mock renders `key:value`.
		expect(host.querySelector('.fe-badge')?.textContent).toMatch(/^foreach_iter_badge:/);
		expect(host.querySelector('.fe-hint')?.textContent).toBe('foreach_empty_hint');
	});
});

describe('the loop block matches the block nodes beside it', () => {
	it('output names go through portLabel, not the raw descriptor keys', () => {
		const node = newForeachNode('fe-ports', { x: 0, y: 0 });
		app = mount(ForeachNode, { target: host, props: { data: node.data, selected: false } as never });
		flushSync();
		const labels = [...host.querySelectorAll('.fe-out-label')].map((n) => n.textContent?.trim());
		expect(labels).toEqual(['Item', 'Index', 'Results', 'Count', 'Errors']);
	});

	it('an unsized loop takes its width from BLOCK_NODE_W, not a literal', () => {
		const node = newForeachNode('fe-size', { x: 0, y: 0 });
		app = mount(ForeachNode, { target: host, props: { data: node.data, selected: false } as never });
		flushSync();
		const el = host.querySelector('.cp-foreach') as HTMLElement | null;
		expect(el, 'no container').not.toBeNull();
		expect(el!.style.width).toBe(`${FOREACH_MIN_W}px`);
		expect(FOREACH_MIN_W).toBeGreaterThan(BLOCK_NODE_W + 2 * 30);
		expect(node.width).toBe(FOREACH_MIN_W);
	});

	it('no hard-coded 340/190 and no mono font left in the component', () => {
		const src = readFileSync(resolve(process.cwd(), 'src/lib/components/build/ForeachNode.svelte'), 'utf8');
		expect(src.length).toBeGreaterThan(500);
		expect(src).not.toMatch(/\?\?\s*(340|190)\b/);
		expect(src).not.toMatch(/font-mono/);
	});
});
