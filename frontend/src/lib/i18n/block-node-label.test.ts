// src/lib/i18n/block-node-label.test.ts — the RESOLUTION ORDER behind every node title on /build:
// current catalog name → persisted label → slug, with a loop container named from the catalog
// before any of the three.
//
// ⛔ WHAT THIS IS BUILT AGAINST, AND IT IS NOT THE ORIGINAL BUG. The original bug — `{data.slug}` in
// `BlockNode.svelte` — is pinned by the render test next door, because only a mount can see what a
// node header prints. THIS file exists for the SECOND defect: the obvious repair, swapping
// `{data.slug}` for `{data.label}`. That reads correctly on a freshly dropped node and is wrong for
// every SAVED flow, because `label` is read straight out of the persisted `flows.graph`
// (`flowToCanvasNodes`) and written straight back (`canvasToFlowGraph`) — it is frozen in whatever
// locale its author had at save time and a language switch does not move it. The first case below
// is the one a `data.label` fix fails.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so an assertion
// says WHICH message resolved without pinning copy. Same technique as `field-type-label.test.ts`.
// The RENDERED Dutch words are asserted in `components/build/block-node.name.i18n.render.test.ts`.
//
// These are pure transforms — the catalog arrives as a plain function, no runes — so they run under
// the node-env vitest, exactly like `stores/builder-graph.test.ts`.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => key;
	}
	return mod;
});

import { blockNodeLabel, type NamedNode } from './block-node-label';
import { newForeachNode } from '$lib/stores/builder-graph';

/** The library as the reader's CURRENT locale spells it. */
const CATALOG: Record<string, string> = {
	'read-claim-form': 'Claimformulier lezen',
	'filter-rows': 'Rijen filteren'
};
const catalog = (slug: string) => CATALOG[slug];
/** A workspace whose block listing has not arrived (or failed, or does not hold this slug). */
const noCatalog = () => undefined;

/** The English string `newForeachNode` really persists into `flows.graph`. Never reaches a screen. */
const STORED_FOREACH_LABEL = newForeachNode('probe', { x: 0, y: 0 }).data.label;

function node(over: Partial<NamedNode> & { slug: string }): NamedNode {
	return { label: undefined, ...over };
}

describe('the current catalog name wins over the label frozen into the saved graph', () => {
	it('⛔ THE DEFECT A `data.label` FIX SHIPS: a stale ENGLISH label whose slug IS in the catalog', () => {
		// A flow saved by an English-speaking colleague. `label` is what their browser wrote into
		// `flows.graph`; the Dutch reader opening it must see the Dutch name.
		expect(
			blockNodeLabel(node({ slug: 'read-claim-form', label: 'Read claim form' }), catalog)
		).toBe('Claimformulier lezen');
	});

	it('…and it beats a label that is merely OUT OF DATE, not foreign', () => {
		// The block was renamed in the library after this flow was saved. Same rung, and the reason
		// the rung is worth having even in a single-language workspace.
		expect(blockNodeLabel(node({ slug: 'filter-rows', label: 'Filter rijen (oud)' }), catalog)).toBe(
			'Rijen filteren'
		);
	});

	it('a node with no persisted label at all still gets the catalog name', () => {
		// `FlowNode.label` is DECLARED required and the wire is not bound by a declaration.
		expect(blockNodeLabel(node({ slug: 'read-claim-form' }), catalog)).toBe('Claimformulier lezen');
	});
});

describe('the fallbacks, in order', () => {
	it('a slug ABSENT from the catalog falls back to the persisted label', () => {
		// Archived since the flow was saved, or a listing that has not arrived yet. A stale name is
		// still a name a human wrote; the slug is not.
		expect(blockNodeLabel(node({ slug: 'gone-block', label: 'Oude blok' }), catalog)).toBe(
			'Oude blok'
		);
	});

	it('an EMPTY catalog resolves everything from the label — the pre-listing paint', () => {
		expect(blockNodeLabel(node({ slug: 'read-claim-form', label: 'Read claim form' }), noCatalog)).toBe(
			'Read claim form'
		);
	});

	it('⛔ NEITHER catalog NOR label falls back to the slug — never to a blank node', () => {
		const name = blockNodeLabel(node({ slug: 'group-and-count' }), noCatalog);
		expect(name).toBe('group-and-count');
		// Stated as its own assertion, not inferred from the line above: `{''}` in `.cp-node-name` is
		// a node header with nothing in it, which is strictly worse than the English identifier this
		// whole module exists to remove.
		expect(name).not.toBe('');
	});

	it('⛔ AN EMPTY-STRING catalog name does not win a rung', () => {
		// A blank `name` off the wire is an absence wearing a `string`'s type — truthy to `??`,
		// invisible to the reader. It must fall through to the label like any other miss.
		const blank = (slug: string) => (slug === 'read-claim-form' ? '' : undefined);
		expect(blockNodeLabel(node({ slug: 'read-claim-form', label: 'Read claim form' }), blank)).toBe(
			'Read claim form'
		);
	});

	it('⛔ AN EMPTY-STRING (or whitespace) label does not win a rung either', () => {
		expect(blockNodeLabel(node({ slug: 'group-and-count', label: '' }), noCatalog)).toBe(
			'group-and-count'
		);
		expect(blockNodeLabel(node({ slug: 'group-and-count', label: '   ' }), noCatalog)).toBe(
			'group-and-count'
		);
		expect(blockNodeLabel(node({ slug: 'group-and-count', label: null }), noCatalog)).toBe(
			'group-and-count'
		);
	});

	it('the catalog is consulted BY SLUG, not by label', () => {
		// A lookup keyed on the wrong field passes the happy case whenever the two agree.
		expect(blockNodeLabel(node({ slug: 'nope', label: 'read-claim-form' }), catalog)).toBe(
			'read-claim-form'
		);
	});
});

describe('a foreach container is named by the catalog, before any of the three rungs', () => {
	it('⛔ the loop renders the catalog key, NOT the stored `For each row`', () => {
		// `newForeachNode` stamps the literal slug `foreach` and the literal English label, and
		// `canvasToFlowGraph` PERSISTS both — localizing at creation time would freeze one author's
		// locale into the saved flow for ever, so the fix is always here, at render time.
		expect(STORED_FOREACH_LABEL).toBe('For each row');
		const fe = newForeachNode('fe-1', { x: 0, y: 0 }).data;
		expect(blockNodeLabel(fe, noCatalog)).toBe('foreach_palette_label');
		expect(blockNodeLabel(fe, noCatalog)).not.toBe(STORED_FOREACH_LABEL);
	});

	it('…and rung 1 comes FIRST — a `foreach` entry in the catalog cannot outrank it', () => {
		// The library has never had a block called `foreach`, but the ORDER is what is under test:
		// putting the catalog lookup ahead of the kind check would make control flow renameable by a
		// published block that happened to take the slug.
		const hostile = (slug: string) => (slug === 'foreach' ? 'Some published block' : undefined);
		expect(blockNodeLabel(newForeachNode('fe-1', { x: 0, y: 0 }).data, hostile)).toBe(
			'foreach_palette_label'
		);
	});

	it('⛔ AND A BLOCK IS NOT RENAMED TO THE LOOP — the guard, in the direction that breaks', () => {
		// A patch that returns `m.foreach_palette_label()` unconditionally passes both cases above and
		// silently renames every block in the product. Same half `node-config.foreach-label` and
		// `build-page.foreach-issue-label` each assert at their own render site.
		expect(blockNodeLabel(node({ slug: 'read-claim-form', label: 'X' }), catalog)).not.toBe(
			'foreach_palette_label'
		);
		expect(blockNodeLabel(node({ slug: 'gone-block', label: 'Oude blok' }), catalog)).not.toBe(
			'foreach_palette_label'
		);
	});

	it('an explicit `kind: "block"` takes the ordinary rungs', () => {
		// `kind` is OPTIONAL on the wire — every pre-Phase-5 node carries none — so both spellings of
		// "not a loop" have to behave identically. `isBlockKind` makes the same argument.
		expect(blockNodeLabel(node({ slug: 'read-claim-form', kind: 'block' }), catalog)).toBe(
			'Claimformulier lezen'
		);
	});
});

describe('the catalog carries the key the foreach arm names', () => {
	it('`foreach_palette_label` exists in en.json', async () => {
		// The mock above turns a MISSING key into `undefined`, not into a throw, so a typo'd key would
		// render blank in the browser and pass every assertion above.
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const en = JSON.parse(
			readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
		) as Record<string, unknown>;
		expect(typeof en['foreach_palette_label']).toBe('string');
	});
});
