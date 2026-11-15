// @vitest-environment jsdom
//
// src/routes/build/build-page.palette-activate.render.test.ts — a palette tile that ANNOUNCES itself
// as a button must behave like one: click, Enter and Space all add the block to the canvas.
//
// THE DEFECT. Both tile kinds (block and the Phase-5 foreach container) carried
// `role="button" tabindex="0" draggable="true" ondragstart={…}` and NO `onclick` and NO `onkeydown`,
// and nothing above them delegated — `FlowCanvas` has only `ondrop`. So the tiles took focus,
// announced themselves to a screen reader as buttons, and did nothing at all on activation:
// a WCAG 2.1.1 (Keyboard) failure on the single control the whole screen is built around.
//
// ⛔ AND IT IS NOT ONLY AN ACCESSIBILITY DEFECT. HTML5 `dragstart` does not fire from touch input,
// so on a tablet or a phone the drag was not merely awkward — it was the ONLY path, and it never
// fires. A block could not be added to a flow AT ALL. The one remaining way in is the AI chat's
// `add_node` tool, which spends a metered LLM turn to place one node.
//
// ⛔ THE ASSERTIONS ARE ON THE PAGE, NOT ON THE COMPONENT. `BlockPalette` gaining `onAdd` props
// proves nothing on its own — the defect is equally reachable by a page that never passes them, and
// the probe that found this measured `build_block_count: 0 -> 0` on the real screen. So this mounts
// /build and reads the node count out of the topbar, which is the number the builder sees.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// Real `en` catalog, each key resolving to its own name.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build?id=f1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getFlow, saveFlow, listFlows, listBlocks, getBlock } = vi.hoisted(() => ({
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn(),
	getBlock: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: vi.fn(), startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', () => ({ streamRun: () => ({ close: () => {} }) }));
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
// Partial: `$lib/api/solutions` re-exports `ApiError` from here, so a bare factory breaks its import.
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, blocksApi: { list: listBlocks, get: getBlock } };
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

// SvelteFlow reads both of these during construction; jsdom ships neither.
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (q: string) => ({
		matches: false,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	})
});
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as never;

import Page from './+page.svelte';

const SLUG = 'load-dataset';

/** An EMPTY flow — every node on the canvas below was put there by the tile under test. */
function emptyFlow() {
	return {
		id: 'f1',
		name: 'Claim summariser',
		owner_id: 'u1',
		status: 'draft',
		version: '1',
		solution_id: null,
		last_saved_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		graph: { nodes: [], edges: [] }
	};
}

function blockDetail() {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Load dataset',
		description: 'Reads a dataset',
		category: 'data',
		current_version_id: 'v1',
		maintainer_id: null,
		owner: 'global',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		maintainer: null,
		versions: [
			{
				id: 'v1',
				block_id: 'b1',
				version: '1.0.0',
				status: 'stable',
				language: 'typescript',
				docs_md: '',
				source_ts: '',
				descriptor: { inputs: {}, outputs: {}, capabilities: {} },
				examples: [],
				changelog: '',
				tests_passing: true,
				created_at: '2026-01-01T00:00:00.000Z'
			}
		]
	};
}

function paletteItem() {
	return {
		slug: SLUG,
		name: 'Load dataset',
		description: 'Reads a dataset',
		category: 'data',
		owner: 'global',
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const blockTile = () => target.querySelector(`[data-block-slug="${SLUG}"]`) as HTMLElement;
const foreachTile = () => target.querySelector('[data-foreach-tile]') as HTMLElement;

/** The node count the BUILDER sees, read off the topbar's `data-node-count`. */
function nodeCountText(): string {
	const path = target.querySelector('.path') as HTMLElement | null;
	expect(path, 'the Build topbar never rendered — this file would test nothing').toBeTruthy();
	// The visible "N blocks" text is gone from the topbar; the count rides on `data-node-count`.
	const n = path!.dataset.nodeCount;
	expect(n, 'the topbar carries no node count').toMatch(/^\d+$/);
	return `nodes:${n}`;
}

/**
 * Mount /build with one block in the palette and an empty canvas.
 *
 * ⛔ THE POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
 * nothing, `querySelector` answers null, and a "the tile did nothing" assertion would pass against
 * an empty DOM. Both tiles are asserted PRESENT and focusable before any activation is attempted.
 */
async function mountBuild() {
	listBlocks.mockResolvedValue({ items: [paletteItem()] });
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 0 }] });
	getFlow.mockResolvedValue(emptyFlow());
	getBlock.mockResolvedValue(blockDetail());
	saveFlow.mockImplementation(async () => emptyFlow());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	expect(blockTile(), 'no block tile in the palette').toBeTruthy();
	expect(foreachTile(), 'no foreach tile in the palette').toBeTruthy();
	// The premise of the whole file: these announce themselves as activatable.
	for (const tile of [blockTile(), foreachTile()]) {
		expect(tile.getAttribute('role')).toBe('button');
		expect(tile.getAttribute('tabindex')).toBe('0');
	}
	expect(nodeCountText(), 'precondition: the canvas starts empty').toBe('nodes:0');
}

/** Press a key on a tile the way a keyboard user does, and report whether the page ate the key. */
function press(el: HTMLElement, key: string): boolean {
	const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	el.dispatchEvent(ev);
	return ev.defaultPrevented;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const fn of [getFlow, saveFlow, listFlows, listBlocks, getBlock]) fn.mockReset();
});

describe('/build palette tiles are operable, not just draggable', () => {
	it('⛔ CLICKING a block tile adds the block — the only path that exists on a touch device', async () => {
		await mountBuild();
		blockTile().click();
		await settle();

		expect(
			getBlock,
			'the tile never even asked for the block: activation is not wired to anything'
		).toHaveBeenCalledWith(SLUG);
		expect(
			nodeCountText(),
			'a tile with role="button" was clicked and the canvas did not change — on touch, where ' +
				'`dragstart` never fires, this is the whole screen being unusable'
		).toBe('nodes:1');
	});

	it('⛔ ENTER on a focused block tile adds the block (WCAG 2.1.1)', async () => {
		await mountBuild();
		blockTile().focus();
		press(blockTile(), 'Enter');
		await settle();

		expect(nodeCountText()).toBe('nodes:1');
	});

	it('⛔ SPACE on a focused block tile adds the block, and does not scroll the palette', async () => {
		await mountBuild();
		blockTile().focus();
		const prevented = press(blockTile(), ' ');
		await settle();

		expect(nodeCountText()).toBe('nodes:1');
		// Space is the page-scroll key. A handler that adds a node AND lets the palette jump a
		// screenful is a worse control than the dead one it replaces.
		expect(prevented, 'Space added the node but was left to scroll the palette too').toBe(true);
	});

	it('a key that is NOT Enter or Space adds nothing, and is left to the browser', async () => {
		// ⛔ THE NEGATIVE HALF, AND WITHOUT IT THE KEY FILTER IS UNPINNED. Every other case here
		// presses only Enter or Space, so deleting the `if (e.key !== 'Enter' && e.key !== ' ')`
		// guard leaves them all green — while every keystroke now adds a node AND calls
		// `preventDefault()`, which eats Tab and traps focus inside the palette on the primary build
		// surface. A keyboard user could enter the palette and never leave it.
		await mountBuild();
		blockTile().focus();

		expect(press(blockTile(), 'Tab'), 'the tile ate Tab — focus is trapped in the palette').toBe(false);
		expect(press(blockTile(), 'a'), 'the tile ate an ordinary character key').toBe(false);
		expect(press(blockTile(), 'ArrowDown')).toBe(false);
		await settle();

		expect(nodeCountText(), 'a key that is not an activation added a block').toBe('nodes:0');
		expect(getBlock, 'a key that is not an activation went to the network').not.toHaveBeenCalled();
	});

	it('⛔ the FOREACH tile is operable too — it is the same dead affordance, one construct along', async () => {
		await mountBuild();
		foreachTile().click();
		await settle();
		expect(nodeCountText()).toBe('nodes:1');

		foreachTile().focus();
		press(foreachTile(), 'Enter');
		await settle();
		expect(nodeCountText()).toBe('nodes:2');
	});

	it('repeated activation CASCADES the nodes instead of stacking them on one spot', async () => {
		// Placement is the one thing a drag supplies and a click cannot. Dropping every keyboard-added
		// block on the same coordinates hides them under each other, which reads as "only one was
		// added" — the defect this fix exists to remove, wearing a different face.
		await mountBuild();
		blockTile().click();
		await settle();
		blockTile().click();
		await settle();
		expect(nodeCountText()).toBe('nodes:2');

		const nodes = [...target.querySelectorAll('.svelte-flow__node')] as HTMLElement[];
		expect(nodes.length, 'the canvas did not render the added nodes').toBe(2);
		expect(
			new Set(nodes.map((n) => n.style.transform)).size,
			'both added nodes landed on the same coordinates — the second is invisible under the first'
		).toBe(2);
	});

	it('a tile whose block detail CANNOT be fetched adds nothing, and does not wedge the palette', async () => {
		// `onDropBlock` resolves the descriptor before it can build a node; a 404 on that lookup must
		// be a no-op, not a half-added node with no ports.
		await mountBuild();
		getBlock.mockRejectedValueOnce(new Error('block_not_found'));
		blockTile().click();
		await settle();
		expect(nodeCountText()).toBe('nodes:0');

		// …and the next activation, with the block back, still works.
		blockTile().click();
		await settle();
		expect(nodeCountText()).toBe('nodes:1');
	});
});
