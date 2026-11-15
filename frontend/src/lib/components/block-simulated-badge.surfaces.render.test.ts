// @vitest-environment jsdom
//
// src/lib/components/block-simulated-badge.surfaces.render.test.ts — a block that answers from
// `ctx.mockData()` must SAY so, on every surface that presents it.
//
// ⛔ THE DEFECT, MEASURED. The seeded block `ocr-scan` declared
// `capabilities: { network: false, mockData: true, llm: true }`, described itself as
// "Tesseract+Claude hybrid OCR for messy scans", documented itself as "Hybrid Tesseract + Claude
// OCR", and its entire `run()` was `ctx.mockData("scan", { ref: inputs.image })` — which
// `backend/src/exec/mock-data.ts` answers with "Scanned document text (sample N). Lorem ipsum dolor
// sit amet." A demo reader picked it out of the catalogue, dropped it on the canvas, ran it, read
// Lorem ipsum under the heading "Outputs", and nothing anywhere on the screen used the word
// simulation. The prose was fixed in the seed + migration 0076; this file guards the GENERIC half,
// which is what stops the next block from repeating it.
//
// ⛔ WHY A SURFACE SWEEP AND NOT A COMPONENT TEST. Fixing one presentation surface and calling the
// class closed is the failure mode this repo keeps hitting. The badge is driven off ONE bit —
// `descriptor.capabilities.mockData`, projected onto the card row as `BlockListItem.mock_data` —
// and it must reach the build palette, the canvas node, the run-result panel and the
// "from existing block" picker. This file mounts all four. (The fifth surface, the /blocks
// catalogue card, has its own file next to the page it belongs to:
// routes/blocks/blocks-page.simulated-badge.render.test.ts.)
//
// ⛔ THE PICKER WAS THE FIFTH SURFACE AND WAS FOUND UNBADGED — AND IT IS THE PROPAGATION PATH.
// `ExistingBlockPicker` renders `BlockListItem`s from the same `blocksApi.list()` as the palette,
// so `mock_data` was already sitting on the object; it simply never read it. It matters more than
// the others because the other four only DISPLAY a simulated block, while this one FORKS it:
// picking a card copies the source descriptor — `capabilities.mockData` included — into a brand-new
// draft (`routes/block-edit/+page.svelte`'s `applyExistingBlock`). So an author scaffolding a
// variant off an unbadged card inherits `ctx.mockData()` unknowingly and ships a second fabricating
// block. It was also the one surface the badge's author could not see from the catalogue screen,
// which is exactly why the sweep is derived from "every screen that presents a block" rather than
// from a list someone remembered.
//
// ⛔ BOTH DIRECTIONS, ON EVERY SURFACE. A test that only asserts "declared ⇒ badge" passes on the
// mutant that renders the badge unconditionally — which would label every pure block in the
// catalogue a simulation and destroy the badge's meaning as surely as omitting it. So each surface
// is asserted twice: present when the capability is declared, ABSENT when it is not.
//
// ⚠️ THE MOCK RESOLVES THE REAL `messages/nl.json`, AND THE ASSERTIONS ARE DUTCH WORDS. Same
// reasoning as block-node.port-types.render.test.ts: a key-name mock could not tell "the badge is
// localized" from "the badge is a raw key that happens to contain the word simulated". Dutch is the
// demo language, so it is the edition the defect was actually read in.
//
// ⚠️ `@xyflow/svelte` is stubbed for the node. `Handle` needs the SvelteFlow store context a bare
// `mount` cannot provide, and the handles are dots that render no text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockCategory } from '$lib/types/blocks';
import type { BlockNodeData } from '$lib/stores/builder.svelte';
import type { BlockListItem } from '$lib/types/blocks';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => catalog[key];
	}
	return mod;
});

vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

// ⚠️ ONLY `ExistingBlockPicker` FETCHES. The palette, the node and the result panel all take their
// data as props, so this mock exists solely for the picker — which is precisely why the picker
// was the surface nobody swept: it is the one that had to be given a client before it could be
// mounted at all. `get` is mocked but unused here (the pick/fork path has its own subject); it is
// present because the component destructures both off `blocksApi`.
const { list, get } = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('$lib/api/blocks', () => ({
	blocksApi: { list, get },
	ApiError: class ApiError extends Error {
		status = 500;
	}
}));

import BlockPalette from './build/BlockPalette.svelte';
import BlockNode from './build/BlockNode.svelte';
import BlockResultView from './block-edit/BlockResultView.svelte';
import ExistingBlockPicker from './build/ExistingBlockPicker.svelte';

/** `messages/nl.json` → `block_simulated_badge`. Asserted as the WORD a Dutch reader sees. */
const BADGE_NL = 'Gesimuleerd';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockReset();
	get.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Every badge string on screen, whichever surface put it there. */
function badges(): string[] {
	return [...host.querySelectorAll('.sim-badge, .cp-node-sim')].map((n) => n.textContent?.trim() ?? '');
}

function paletteItem(mockData: boolean): BlockListItem {
	return {
		slug: 'ocr-scan',
		name: 'OCR scan (sample)',
		description: 'Demonstration block.',
		category: 'data',
		owner: 'global',
		region: null,
		cost_class: null,
		version: '1.2.0',
		status: 'stable',
		mock_data: mockData,
		usage_count: 0,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

function mountPalette(mockData: boolean): void {
	app = mount(BlockPalette, {
		target: host,
		props: {
			items: [paletteItem(mockData)],
			loading: false,
			error: null,
			onAdd: () => {},
			onAddForeach: () => {}
		} as never
	});
	flushSync();
}

function mountNode(mockData: boolean): void {
	const data: BlockNodeData = {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: 'ocr-scan',
		label: 'OCR scan (sample)',
		category: 'data',
		descriptor: {
			inputs: { image: { type: 'json', required: true } },
			outputs: { text: { type: 'string' } },
			capabilities: { network: false, mockData }
		},
		config: {}
	};
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
}

/**
 * Mount the canvas node with an ARBITRARY capability bag, so a descriptor can be expressed that
 * `mountNode(boolean)` cannot: one carrying `dataset` without `mockData`.
 *
 * Slug/label are the real `load-dataset` block's, because it is the concrete case: its `run()` is
 * one `ctx.dataset(inputs.source)` over the tenant's OWN uploaded rows.
 */
function mountNodeWithCaps(capabilities: Record<string, boolean>): void {
	const data: BlockNodeData = {
		blockId: 'b2',
		blockVersionId: 'v2',
		slug: 'load-dataset',
		label: 'Load dataset',
		category: 'data',
		descriptor: {
			inputs: { source: { type: 'dataset', required: true } },
			outputs: { rows: { type: 'json' }, count: { type: 'number' } },
			capabilities
		},
		config: {}
	};
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
}

/**
 * Let the picker's `$effect` → `blocksApi.list()` → `items = res.items` chain settle.
 *
 * ⚠️ A FIXED `await Promise.resolve()` PAIR IS NOT ENOUGH HERE and the difference is silent: the
 * load is an async function awaited from inside an effect, so the number of microtask turns before
 * the DOM reflects `items` is an implementation detail of Svelte's scheduler, not something this
 * file should encode. The loop with a `flushSync()` per round is the idiom the sibling async render
 * tests use (block-edit.dataset-picker.render.test.ts).
 */
async function settle(rounds = 40): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		flushSync();
	}
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the "from existing block" picker over a one-item catalogue. */
async function mountPicker(mockData: boolean): Promise<void> {
	list.mockResolvedValue({ items: [paletteItem(mockData)], total: 1 });
	app = mount(ExistingBlockPicker, {
		target: host,
		props: { category: 'data' as BlockCategory, onPick: () => {} } as never
	});
	flushSync();
	await settle();
}

function mountResult(simulated: boolean): void {
	app = mount(BlockResultView, {
		target: host,
		props: {
			status: 'ok',
			outputs: { text: 'Scanned document text (sample 412). Lorem ipsum dolor sit amet.' },
			simulated
		} as never
	});
	flushSync();
}

describe('the build palette labels a fixture-backed block', () => {
	it('⛔ capabilities.mockData ⇒ the tile carries the Dutch badge', () => {
		mountPalette(true);
		// NON-VACUITY FIRST: a selector that matched no tile at all would satisfy the negative case
		// below for free, so prove the tile is on screen before reading its badge.
		expect(host.querySelectorAll('[data-block-slug="ocr-scan"]'), 'the palette rendered no tile').toHaveLength(1);
		expect(badges()).toEqual([BADGE_NL]);
	});

	it('⛔ NO mockData ⇒ NO badge (the badge-always-on mutant dies here)', () => {
		mountPalette(false);
		expect(host.querySelectorAll('[data-block-slug="ocr-scan"]'), 'the palette rendered no tile').toHaveLength(1);
		expect(badges()).toEqual([]);
	});
});

describe('the "from existing block" picker labels a fixture-backed block', () => {
	// ⛔⛔ THE SURFACE THE FABRICATION BIT PROPAGATES THROUGH, AND IT SHIPPED UNBADGED.
	// Every other case in this file guards a block being MISREAD. This one guards a block being
	// COPIED: `applyExistingBlock` (routes/block-edit/+page.svelte) reads the picked block's
	// descriptor and writes `mockData: v.descriptor.capabilities.mockData ?? false` straight into
	// the new draft's capability bag. So an unbadged card here does not merely mislead a reader —
	// it hands them `ctx.mockData()` in a block they believe they authored, and the next reader
	// meets a second fabricating block with honest-looking prose.
	//
	// ⚠️ THE DATA IS THE SAME `blocksApi.list()` ROW THE PALETTE USES, which is the whole point:
	// `mock_data` was already on the object. Nothing had to be plumbed; the template simply never
	// read it, and no test looked.

	/**
	 * NON-VACUITY, and it needs three separate facts because the negative case below is satisfied
	 * for free by any of the picker's OTHER render states — the skeleton grid, the "no results"
	 * line, or the error banner all contain no `.sim-badge` and would pass silently.
	 */
	function pickerRenderedACard(): void {
		expect(host.querySelectorAll('.tcard'), 'the picker rendered no card').toHaveLength(1);
		expect(host.textContent, 'the card is not the block under test').toContain('OCR scan (sample)');
		expect(host.textContent, 'the card is not the block under test').toContain('ocr-scan');
	}

	it('⛔ capabilities.mockData ⇒ the picker card carries the Dutch badge', async () => {
		await mountPicker(true);
		pickerRenderedACard();
		expect(badges()).toEqual([BADGE_NL]);
	});

	it('⛔ NO mockData ⇒ NO badge (the badge-always-on mutant dies here)', async () => {
		await mountPicker(false);
		pickerRenderedACard();
		expect(badges()).toEqual([]);
	});
});

describe('the canvas node labels a fixture-backed block', () => {
	it('⛔ capabilities.mockData ⇒ the node head carries the Dutch badge', () => {
		mountNode(true);
		expect(host.querySelectorAll('.cp-node-head'), 'the node rendered no head').toHaveLength(1);
		expect(badges()).toEqual([BADGE_NL]);
	});

	it('⛔ NO mockData ⇒ NO badge', () => {
		mountNode(false);
		expect(host.querySelectorAll('.cp-node-head'), 'the node rendered no head').toHaveLength(1);
		expect(badges()).toEqual([]);
	});
});

describe('a block that reads a REAL dataset is not a simulation', () => {
	// ⛔⛔ THE REGRESSION THIS WHOLE SPLIT EXISTS TO PREVENT, AND IT POINTS THE OPPOSITE WAY TO EVERY
	// OTHER CASE IN THIS FILE. Everything above guards against a fixture-backed block staying SILENT.
	// This guards against a REAL one being called fake — which is strictly worse, because the reader
	// acts on it: `load-dataset` returns the tenant's own uploaded rows and is the first node of most
	// demo flows, so badging it "Gesimuleerd" tells a customer their own data is invented.
	//
	// It was one edit away from shipping. `ctx.dataset` used to be gated on `capabilities.mockData`
	// ("same trust class as mockData → reuse that capability"), so `load-dataset` HAD to declare the
	// fabrication bit to be allowed to read a dataset at all — and the badge renders off exactly that
	// bit. The fix was to split the capability, not to special-case the slug; these cases assert the
	// split at the surface a reader actually looks at.
	it('⛔⛔ dataset:true with NO mockData ⇒ NO badge', () => {
		mountNodeWithCaps({ network: false, dataset: true });
		expect(host.querySelectorAll('.cp-node-head'), 'the node rendered no head').toHaveLength(1);
		// NON-VACUITY: the node really is the dataset block, not an empty render that would pass any
		// negative assertion for free.
		expect(host.textContent).toContain('Load dataset');
		expect(badges()).toEqual([]);
	});

	it('⛔ mockData:true still badges — the split did not disarm the badge', () => {
		// The other half of the discriminator. Without this, "never badge anything" passes the case
		// above, and the honesty work 0076 shipped would be silently undone by this change.
		mountNodeWithCaps({ network: false, mockData: true });
		expect(host.querySelectorAll('.cp-node-head'), 'the node rendered no head').toHaveLength(1);
		expect(badges()).toEqual([BADGE_NL]);
	});

	it('⛔ a block declaring BOTH keeps the badge — dataset access never cancels a fabrication claim', () => {
		// A block that genuinely reads a dataset AND invents part of its output is honestly described
		// as simulated. A reader of `dataset` as "this one is real" would badge this wrongly, so the
		// bits must not be treated as mutually exclusive.
		mountNodeWithCaps({ network: false, mockData: true, dataset: true });
		expect(badges()).toEqual([BADGE_NL]);
	});
});

describe('the run-result panel labels a fixture-backed result', () => {
	it('⛔ simulated ⇒ the badge AND the sentence sit above the outputs', () => {
		mountResult(true);
		// The outputs really are on screen — otherwise "the badge is above the outputs" is a claim
		// about an empty panel.
		expect(host.textContent, 'the panel rendered no outputs').toContain('Lorem ipsum');
		expect(badges()).toEqual([BADGE_NL]);
		// The tooltip sentence is rendered as text here, not only as a `title` — the run result is
		// where a reader needs the full explanation, not a three-word pill.
		expect(host.querySelector('.sim-text')?.textContent?.trim()).toBe(
			'Dit blok geeft voorbeelddata terug, geen echt resultaat.'
		);
	});

	it('⛔ NOT simulated ⇒ NO badge and NO sentence', () => {
		mountResult(false);
		expect(host.textContent, 'the panel rendered no outputs').toContain('Lorem ipsum');
		expect(badges()).toEqual([]);
		expect(host.querySelector('.sim-text')).toBeNull();
	});
});
