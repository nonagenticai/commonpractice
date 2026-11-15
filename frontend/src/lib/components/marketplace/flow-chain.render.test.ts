// @vitest-environment jsdom
//
// src/lib/components/marketplace/flow-chain.render.test.ts — what the marketplace SHOWCASE actually
// puts on screen for a solution's block chain.
//
// ⛔ THE DEFECT THIS FILE PINS, MEASURED. `FlowChain.svelte` rendered `{slug}`: a Dutch reader on
// `/solutions/[id]` met `read-claim-form → group-and-count → ai-summarize` inside a card whose
// heading ("De flow die Ada bouwde"), caption ("3 blokken") and link ("Openen in Build") were all
// Dutch. Five other render sites of a block name were routed through `nodeDisplayName` in the same
// lane; this one was missed, and it could not have been fixed the same way — that helper reads a
// store published only by `/build`'s `loadPalette()`, so on this route it is empty and every chip
// would have resolved straight back to its slug. The name now arrives ON THE DTO.
//
// ⛔ AND THE SECOND DEFECT, WHICH IS NOT ABOUT LANGUAGE AT ALL. The chain had no node-kind filter —
// the sibling `blocks_used` has had one since Phase 5 (`isBlockKind`, routes/build/+page.svelte:816)
// — so a flow containing a loop published the literal control-flow token `foreach` onto the board as
// if it were a block, linking to `/block-edit?slug=foreach`, which the library has never had a row
// for. The server drops it now; the string arm of `normalizeChain` drops it for a payload from a pod
// one roll behind, which has no `kind` to filter on.
//
// ⚠️ THESE ARE DOM ASSERTIONS ABOUT WHAT A READER SEES. The wire contract is asserted separately, in
// backend/tests/solutions.test.ts, against the real route.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// Message stub built from the REAL `en` catalog, each key resolving to its own name (plus params) —
// the technique `leaderboard-row.vote-control.render.test.ts` documents. It means an assertion names
// the message this component CHOSE rather than prose that may later be reworded, and a key this
// component invents but never adds to the catalogs fails as `undefined is not a function`.
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

import FlowChain from './FlowChain.svelte';
import type { WireChainNode } from '$lib/solutions/flow-chain';

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

function render(chain: readonly WireChainNode[]) {
	component = mount(FlowChain, { target, props: { chain } }) as Record<string, unknown>;
	flushSync();
	return [...target.querySelectorAll('a.node')] as HTMLAnchorElement[];
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
});

describe('the block chain on a solution showcase', () => {
	it("⛔ prints the reader's NAME for each block, never the English slug", () => {
		// The payload a Dutch reader's request produces today: the server resolved each slug through
		// the block catalogue at the negotiated locale.
		const nodes = render([
			{ slug: 'read-claim-form', name: 'Claimformulier lezen' },
			{ slug: 'ai-summarize', name: 'AI-samenvatting' }
		]);

		expect(nodes.map((a) => a.textContent)).toEqual(['Claimformulier lezen', 'AI-samenvatting']);
		// BOTH DIRECTIONS. `.toEqual` on the names alone would still pass if the component also
		// printed the slug somewhere — and printing both is the half-fix this lane keeps meeting.
		expect(target.textContent).not.toContain('read-claim-form');
		expect(target.textContent).not.toContain('ai-summarize');
		// …and the LINK still carries the slug, which is the whole reason the DTO kept it. A chain of
		// unclickable words would be a different regression wearing the fix's clothes.
		expect(nodes.map((a) => a.getAttribute('href'))).toEqual([
			'/block-edit?slug=read-claim-form',
			'/block-edit?slug=ai-summarize'
		]);
		expect(nodes[0]!.getAttribute('title')).toBe('flowchain_open_block:read-claim-form');
	});

	it('⛔ a `foreach` loop container is NOT rendered as a block', () => {
		// The legacy wire shape — a pod one roll behind sends bare slugs and no `kind`, so the literal
		// token is the only signal there is. Before this change the token became a chip captioned
		// `foreach`, linking to `/block-edit?slug=foreach`: a 404 by construction.
		const nodes = render(['read-claim-form', 'foreach', 'ai-summarize']);

		expect(nodes).toHaveLength(2);
		expect(target.textContent).not.toContain('foreach');
		expect(target.innerHTML).not.toContain('slug=foreach');
		// Non-vacuity: the two real blocks are still there, so this did not pass by rendering nothing.
		expect(nodes.map((a) => a.getAttribute('href'))).toEqual([
			'/block-edit?slug=read-claim-form',
			'/block-edit?slug=ai-summarize'
		]);
	});

	it('⚠️ a bare-slug chain from an older API still renders, as slugs', () => {
		// The mid-roll window in the other direction. It is a DEGRADATION, not a fix — and it is
		// exactly what this screen showed before the change, which is the bar a compat arm has to
		// clear. Rendering `[object Object]`, or nothing at all, would be worse than the defect.
		const nodes = render(['read-claim-form']);
		expect(nodes.map((a) => a.textContent)).toEqual(['read-claim-form']);
		expect(nodes[0]!.getAttribute('href')).toBe('/block-edit?slug=read-claim-form');
	});

	it('a chip with a blank name falls back to its slug rather than rendering untitled', () => {
		// ⛔ `''` MUST NOT WIN. A blank `name` is a truthy-looking string to `??` and renders as a chip
		// with NO TITLE — worse by every measure than the English identifier it replaced. Same reading
		// as `has()` in `i18n/block-node-label.ts`.
		const nodes = render([{ slug: 'read-claim-form', name: '   ' }]);
		expect(nodes.map((a) => a.textContent)).toEqual(['read-claim-form']);
	});

	it('an empty chain renders no chips and no stray arrow', () => {
		expect(render([])).toHaveLength(0);
		expect(target.querySelector('.arrow')).toBeNull();
	});

	it('draws one arrow BETWEEN chips, never a trailing one', () => {
		// The separator count is the property, not the markup: a chain of three blocks is two arrows.
		render([
			{ slug: 'a-block', name: 'A' },
			{ slug: 'b-block', name: 'B' },
			{ slug: 'c-block', name: 'C' }
		]);
		expect(target.querySelectorAll('.arrow')).toHaveLength(2);
	});
});
