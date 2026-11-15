// @vitest-environment jsdom
//
// src/lib/components/build/block-node.name.i18n.render.test.ts — a block node on the /build canvas,
// in DUTCH, must be TITLED in Dutch.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `BlockNode.svelte:69` rendered
// `<span class="cp-node-name">{data.slug}</span>`. So on the product's PRIMARY authoring surface,
// at locale `nl`, every node on the canvas was headed by an English hyphenated IDENTIFIER —
// `read-claim-form`, `ai-summarize`, `group-and-count` — while the palette tile that created it,
// two hundred pixels to the left, said "Claimformulier lezen" and `/api/blocks` had already
// answered with that exact Dutch name. `BlockNodeData` has carried a `label` all along
// (`stores/builder-graph.ts`) and nothing rendered it.
//
// ⛔ AND THIS FILE IS BUILT AGAINST THE *SECOND* DEFECT AS WELL — the near fix. Swapping
// `{data.slug}` for `{data.label}` reads correctly on a node you just dropped and is wrong for every
// SAVED flow: `label` is read straight out of the persisted `flows.graph` and written straight back
// on the next autosave, so it is frozen in whatever locale its author had at SAVE time and a
// language switch does not move it. The first case below hands the component exactly that — a stale
// ENGLISH label on a slug the current Dutch catalog knows — and a `data.label` fix fails it.
//
// ⚠️ THIS FILE ASSERTS THE WORDS, NOT KEY NAMES, and the words come from the CATALOG STORE rather
// than from `messages/nl.json`: a block's name is tenant data localized SERVER-side off
// `Accept-Language` (`api/auth-fetch.ts`), not a paraglide key. So the fixture publishes a listing
// exactly as `loadPalette()` does and the assertions are the Dutch an employee sees. The paraglide
// mock is still needed — `BlockNode` renders `m.build_node_ports_unavailable*` — and resolves the
// real `nl` catalog, same as `block-node.port-types.render.test.ts`, whose harness this clones.
//
// ⚠️ `@xyflow/svelte` is stubbed for the reason that file gives: `Handle` needs the SvelteFlow store
// context, which a bare `mount` cannot provide, and handles are dots that render no text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockNodeData } from '$lib/stores/builder.svelte';

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

import BlockNode from './BlockNode.svelte';
import { publishBlockCatalog } from '$lib/stores/block-catalog.svelte';

const SLUG = 'read-claim-form';
/** What `GET /api/blocks` answers a Dutch reader with today. */
const DUTCH_NAME = 'Claimformulier lezen';
/** What an English-speaking colleague's browser froze into `flows.graph` when they saved. */
const STALE_ENGLISH_LABEL = 'Read claim form';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	// The catalog is a module-level singleton (see its doc comment for why it has to be), so every
	// case starts from an empty library rather than inheriting the previous case's listing.
	publishBlockCatalog([]);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	publishBlockCatalog([]);
});

function nodeData(over: Partial<BlockNodeData> = {}): BlockNodeData {
	return {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: SLUG,
		label: STALE_ENGLISH_LABEL,
		category: 'data',
		descriptor: { inputs: { in: { type: 'json' } }, outputs: { out: { type: 'json' } }, capabilities: {} },
		config: {},
		...over
	};
}

/** Mount the node exactly as SvelteFlow does and return its rendered header element. */
function renderNode(data: BlockNodeData): HTMLElement {
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
	const el = host.querySelector('.cp-node-name') as HTMLElement | null;
	// ⛔ NON-VACUITY FIRST. A missing element makes every `not.toBe(SLUG)` below pass against an
	// empty DOM — the exact way this suite could be decorative.
	expect(el, 'the node rendered no name element at all').not.toBeNull();
	return el!;
}

describe('the canvas node is titled with a name, not with its slug', () => {
	it('⛔ THE REVERT CASE: a stale ENGLISH label whose slug IS in the catalog renders the DUTCH name', () => {
		// This is the case that fails BOTH ways round, and it is the one to look at first when this
		// file goes red:
		//   • restoring `{data.slug}` in the renderer → "read-claim-form";
		//   • "fixing" it with `{data.label}` instead  → "Read claim form".
		// Only resolving the CURRENT catalog by slug produces the Dutch.
		publishBlockCatalog([{ slug: SLUG, name: DUTCH_NAME }]);
		const el = renderNode(nodeData());

		expect(el.textContent).toBe(DUTCH_NAME);
		expect(el.textContent, 'the raw slug reached the canvas header').not.toBe(SLUG);
		expect(el.textContent, 'the label frozen into flows.graph reached the screen').not.toBe(
			STALE_ENGLISH_LABEL
		);
	});

	it('⛔ …and the English is nowhere in the node body either, not merely out of the header', () => {
		publishBlockCatalog([{ slug: SLUG, name: DUTCH_NAME }]);
		renderNode(nodeData());
		const head = host.querySelector('.cp-node-head') as HTMLElement;
		// A positive marker before the absence, so "no English" cannot mean "nothing rendered".
		expect(head.textContent).toContain(DUTCH_NAME);
		expect(head.textContent).not.toContain(STALE_ENGLISH_LABEL);
		expect(head.textContent).not.toContain(SLUG);
	});

	it('a slug ABSENT from the catalog falls back to the persisted label', () => {
		// Archived between the flow's save and this load, or a listing that holds other blocks.
		publishBlockCatalog([{ slug: 'some-other-block', name: 'Iets anders' }]);
		expect(renderNode(nodeData()).textContent).toBe(STALE_ENGLISH_LABEL);
	});

	it('⛔ NEITHER catalog NOR label falls back to the slug — NEVER a blank node', () => {
		const el = renderNode(nodeData({ label: '' }));
		expect(el.textContent).toBe(SLUG);
		// Its own assertion, because `{''}` in `.cp-node-name` is a node with no title at all: a
		// header 22px high showing an icon and nothing else, which is worse than the identifier.
		expect(el.textContent).not.toBe('');
		expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
	});

	it('⛔ A LANGUAGE SWITCH RE-TITLES A NODE ALREADY ON THE CANVAS, with no reload', () => {
		// The behaviour the whole design is for. `/build` deliberately refuses to re-run `openFlow()`
		// on a locale change (it would discard unsaved edits — see `reloadLocalizedContent`), so the
		// ONLY thing that moves is `loadPalette()` republishing the catalog. If the node title were
		// resolved once at load time, this case would keep the old language for ever.
		publishBlockCatalog([{ slug: SLUG, name: 'Read claim form' }]);
		const el = renderNode(nodeData());
		expect(el.textContent).toBe('Read claim form');

		publishBlockCatalog([{ slug: SLUG, name: DUTCH_NAME }]);
		flushSync();
		expect(
			host.querySelector('.cp-node-name')!.textContent,
			'the node kept the language it was loaded in'
		).toBe(DUTCH_NAME);
	});

	it('the SLUG stays reachable on the node, because RunConsole still prints it', () => {
		// `RunConsole.svelte` writes its trace lines as `✓ ${ev.slug}`, deliberately untranslated
		// ("Translating it breaks the match to the canvas node"). With the header now carrying a Dutch
		// name, the identifier has to remain findable or the console has nothing on screen to match.
		publishBlockCatalog([{ slug: SLUG, name: DUTCH_NAME }]);
		const el = renderNode(nodeData());
		expect(el.getAttribute('title')).toContain(SLUG);
		expect(el.getAttribute('title')).toContain(DUTCH_NAME);
	});

	it('…and the tooltip does not stutter when the name IS the slug', () => {
		const el = renderNode(nodeData({ label: '' }));
		expect(el.getAttribute('title')).toBe(SLUG);
	});
});
