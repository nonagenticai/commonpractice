// @vitest-environment jsdom
//
// src/lib/components/build/node-config.foreach-label.i18n.render.test.ts — the /build inspector must
// name a loop the same way the canvas does.
//
// ⛔ THE DEFECT, AND IT IS A SELF-CONTRADICTION VISIBLE IN ONE SCREENSHOT. `ForeachNode.svelte` was
// changed to render `m.foreach_palette_label()` instead of the persisted `data.label`, but the
// inspector two panels to the right still printed the raw stored string in TWO places:
//   · `.cfg-title` — the sub-title of the SELECTED node's header.
//   · the `Add to loop` `<select>` — one `<option>` per foreach node in the graph.
// So a Dutch author selected the loop and read "Lus (voor elke rij)" on the canvas and
// "For each row" beside it. One node, two names, in every one of the eight locales.
//
// ⛔ WHY `.cfg-title` NEEDS A `kind === 'foreach'` GUARD AND THE `<option>` DOES NOT. `.cfg-title`
// renders for EVERY selected node, and for a block node `data.label` is that block's real,
// author-facing name ("Markeer claims") which MUST reach the screen byte-for-byte — there is no
// catalog string for it and inventing one would erase the name. The `<option>` list is built from
// `builder.nodes.filter(n => n.data.kind === 'foreach')`, so every row in it is provably a loop; the
// guard there is belt-and-braces against that filter widening later.
//
// ⛔ THE BLOCK CASE IS NOT PADDING — IT IS THE HALF A NAIVE FIX BREAKS. A patch that simply swaps
// `{node.data.label}` for `{m.foreach_palette_label()}` at `.cfg-title` passes every foreach assertion
// in this file and silently renames every block in the product to "Lus (voor elke rij)". Assert both
// directions or the guard is untested.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so the assertions
// state WHICH message resolved without pinning copy — same technique as
// `foreach-node.i18n.render.test.ts`, whose canvas-side half this file completes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore } from '$lib/stores/builder.svelte';

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
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { listAll, listPaged, getDataset, listMappings } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn()
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';
import { newForeachNode } from '$lib/stores/builder-graph';
import { fieldTypes } from '$lib/stores/field-types.svelte';

/** The English string `newForeachNode` persists into `flows.graph`. It must never reach the screen. */
const STORED_LABEL = 'For each row';
/** A BLOCK node's label — a real name, no catalog entry, must render verbatim. */
const BLOCK_LABEL = 'Markeer claims';

type Node = { id: string; data: Record<string, unknown> };

function foreachNode(id: string): Node {
	// The REAL creation path, so the stored label is the product's own and not a fixture's guess.
	const n = newForeachNode(id, { x: 0, y: 0 }) as unknown as Node;
	expect(n.data.label, 'the fixture no longer carries the stored English label').toBe(STORED_LABEL);
	expect(n.data.kind).toBe('foreach');
	return n;
}

function blockNode(id: string): Node {
	return {
		id,
		data: {
			slug: 'flag-claims',
			label: BLOCK_LABEL,
			kind: 'block',
			config: {},
			descriptor: { inputs: { text: { type: 'string', required: false } } }
		}
	};
}

function storeWith(selected: Node, nodes: Node[]): BuilderStore {
	return {
		selectedNode: selected,
		nodes,
		isInputConnected: () => false,
		updateConfig: vi.fn(),
		removeNode: vi.fn(),
		setLoopConfig: vi.fn(),
		assignToLoop: vi.fn(),
		removeFromLoop: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function render(builder: BuilderStore) {
	app = mount(NodeConfigPanel, { target: host, props: { builder } }) as Record<string, unknown>;
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Every `not.toContain('For each row')` below passes for free on a panel
 * that rendered no header at all. Nothing asserts an absence until this has proved the element is
 * there.
 */
function cfgSub(): HTMLElement {
	const el = host.querySelector('.cfg-title') as HTMLElement | null;
	expect(el, 'the inspector rendered no node sub-title — this case tests nothing').not.toBeNull();
	return el!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	listAll.mockResolvedValue({ items: [], total: 0, capped: false });
	getDataset.mockResolvedValue({ columns: [], rows: [] });
	listMappings.mockResolvedValue({ mappings: [] });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset, listMappings]) fn.mockReset();
});

describe('the inspector names a loop from the catalog, exactly as the canvas does', () => {
	it('⛔ `.cfg-title` of a SELECTED foreach node is the catalog key, not the stored `For each row`', async () => {
		const fe = foreachNode('fe-1');
		await render(storeWith(fe, [fe]));

		expect(cfgSub().textContent).toBe('foreach_palette_label');
		expect(host.textContent, 'the stored English label reached the screen').not.toContain(
			STORED_LABEL
		);
		// The stored graph is untouched — the fix is at RENDER time, never at creation time, because
		// `label` is serialized by `toGraph()` into `flows.graph` and would otherwise freeze the
		// creator's locale into the saved flow for ever.
		expect(fe.data.label).toBe(STORED_LABEL);
	});

	it('⛔ a BLOCK node keeps its own `data.label` VERBATIM — the guard, in the direction that breaks', async () => {
		// REVERT THAT TURNS THIS RED: an unguarded `{m.foreach_palette_label()}` at `.cfg-title`. It
		// makes the case above pass and renames every block in the product.
		const blk = blockNode('n1');
		await render(storeWith(blk, [blk]));

		expect(cfgSub().textContent).toBe(BLOCK_LABEL);
		expect(cfgSub().textContent).not.toBe('foreach_palette_label');
	});

	it('⛔ every `<option>` in "add to loop" is the catalog title, not the stored label', async () => {
		// The dropdown renders for a block node that is not already inside a loop, when the graph has
		// at least one loop. Two loops, so a fix that localizes only the first row still reds.
		const fe1 = foreachNode('fe-1');
		const fe2 = foreachNode('fe-2');
		const blk = blockNode('n1');
		await render(storeWith(blk, [blk, fe1, fe2]));

		const options = [...host.querySelectorAll('option')].map((o) => o.textContent);
		// Non-vacuity: the placeholder plus one row per loop. An empty list would satisfy the
		// `not.toContain` below while proving nothing.
		expect(options).toEqual(['nodecfg_add_to_loop_ph', 'foreach_palette_label', 'foreach_palette_label']);
		expect(host.textContent, 'the stored English label reached the dropdown').not.toContain(
			STORED_LABEL
		);
	});
});

describe('the Details header names the block, not its identifier', () => {
	// ⛔ THE DEFECT (browser walk, 2026-10-14): the header's first line was `node.data.slug` in mono
	// ("lookup-policy"), above the name. A business reader names a step by its name; the identifier
	// is a developer's fact and now shows only with the field types switched on.
	afterEach(() => {
		fieldTypes.allowed = false;
		fieldTypes.preference = false;
	});

	it('⛔ shows the display name and hides the raw id from a non-developer', async () => {
		const b = blockNode('n1');
		await render(storeWith(b, [b]));
		expect(cfgSub().textContent?.trim()).toBe(BLOCK_LABEL);
		expect(host.querySelector('.cfg-head')!.textContent, 'the raw block id reached a business reader').not.toContain(
			'flag-claims'
		);
		expect(host.querySelector('[data-testid="cfg-raw-id"]')).toBeNull();
	});

	it('…and shows the raw id behind the developer field-types switch', async () => {
		fieldTypes.allowed = true;
		fieldTypes.preference = true;
		const b = blockNode('n1');
		await render(storeWith(b, [b]));
		expect(host.querySelector('[data-testid="cfg-raw-id"]')?.textContent?.trim()).toBe('flag-claims');
	});
});

describe('a locked canvas (someone else’s flow, or a screen under 1024px) offers no edits here', () => {
	it('⛔ every config control is disabled and "Remove block" is gone', async () => {
		const b = blockNode('n1');
		const store = storeWith(b, [b]);
		(store as unknown as { locked: boolean }).locked = true;
		await render(store);
		const inputs = [...host.querySelectorAll<HTMLInputElement>('.cfg-body input, .cfg-body select')];
		expect(inputs.length, 'no config control rendered — nothing to assert on').toBeGreaterThan(0);
		expect(inputs.every((i) => i.disabled), 'a config field stayed editable on a locked canvas').toBe(true);
		expect(host.querySelector('.cfg-foot .del')).toBeNull();
	});

	it('…and the same panel unlocked is editable (non-vacuity)', async () => {
		const b = blockNode('n1');
		await render(storeWith(b, [b]));
		expect([...host.querySelectorAll<HTMLInputElement>('.cfg-body input')].some((i) => !i.disabled)).toBe(true);
		expect(host.querySelector('.cfg-foot .del')).not.toBeNull();
	});
});
