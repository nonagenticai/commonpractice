// @vitest-environment jsdom
//
// src/routes/blocks/blocks-page.chip-counts.render.test.ts — a category chip's number is a PROMISE
// about what clicking it will show. It must not contradict the grid underneath it.
//
// ⛔ THE DEFECT. `countFor()` counted over the full `items` list while `filtered` applied BOTH the
// category AND the search term `q` — and `load()` sends only `sort`, so `q` never reaches the server
// and nothing else ever narrowed `items`. Type a term nothing matches and the grid emptied to
// `blocks_no_match` while the chips went on reading "All 40 · Data 12 · AI 9". Clicking the chip
// that promised twelve blocks landed on "no blocks match your search". Two numbers about the same
// list, on the same screen, computed over different populations.
//
// `/challenges` had already settled this idiom the other way: it passes `q` into its counts query
// (backend/src/routes/challenges.ts:365) so its facet totals and its result list always agree. Two
// screens, one idiom, and this was the half that was wrong.
//
// ⛔ THE INVARIANT THIS FILE PINS, and it is deliberately stronger than the one reproduction:
// FOR EVERY VISIBLE CHIP, the number it renders equals the number of cards the grid shows once that
// chip is clicked. Cases 1 and 2 are the reproductions; case 3 walks every chip and every state, so
// a future filter added to `filtered` but not to `countFor` reds here rather than shipping.
//
// ⚠️ AND THE OVER-CORRECTION GUARD (case 4): folding `activeCategory` into the counts as well would
// satisfy "the chips agree with the grid" trivially — every inactive chip would read 0, hide itself,
// and there would be no way out of a filter. Each chip must answer for ITS OWN category under the
// current search.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockListItem } from '$lib/types/blocks';

// Real `en` catalog, each key resolving to its own name — see the sibling render tests.
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

const { list, goto } = vi.hoisted(() => ({ list: vi.fn(), goto: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones.
vi.mock('$lib/api/blocks', () => ({ blocksApi: { list } }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback
}));

import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

function block(slug: string, category: BlockListItem['category']): BlockListItem {
	return {
		slug,
		name: slug,
		// ⚠️ The description is searched too (`filtered` matches name ‖ slug ‖ description), so it
		// deliberately repeats the slug and adds no word that could match across fixtures.
		description: `${slug} summary`,
		category,
		owner: 'platform' as BlockListItem['owner'],
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

// Three data blocks, two AI blocks. `alpha` selects exactly one DATA block and no AI block, so a
// term that leaves a category non-empty and another category empty is covered by one keystroke.
const LIBRARY = {
	items: [
		block('alpha-data', 'data'),
		block('beta-data', 'data'),
		block('gamma-data', 'data'),
		block('delta-ai', 'ai'),
		block('epsilon-ai', 'ai')
	],
	total: 5
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const chips = () => [...host.querySelectorAll<HTMLButtonElement>('button.chip')];
/** Every visible chip as `{ label, count, el }` — the number the reader can actually see. */
function visibleChips() {
	return chips().map((el) => ({
		el,
		label: el.textContent?.trim().split(/\s+/)[0] ?? '',
		count: Number(el.querySelector('.chip-count')?.textContent?.trim() ?? 'NaN')
	}));
}
const rows = () => host.querySelectorAll('.blocks-grid .block-card:not(.skeleton)').length;

async function search(term: string) {
	const box = host.querySelector('input.search') as HTMLInputElement;
	box.value = term;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

async function clickChip(label: string) {
	const chip = visibleChips().find((c) => c.label === label);
	expect(chip, `no visible chip labelled "${label}"`).toBeTruthy();
	chip!.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

async function render() {
	window.history.replaceState({}, '', '/blocks');
	list.mockResolvedValue(LIBRARY);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE MARKER — without it, "no chip reads >0" passes against a page that never rendered.
	expect(
		host.querySelector('input.search'),
		'the blocks page never rendered, so this file tests nothing'
	).not.toBeNull();
	expect(rows(), 'the library never reached the grid').toBe(5);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	list.mockReset();
	goto.mockReset();
});

describe('/blocks category chips agree with the grid beneath them', () => {
	it('⛔ THE DEFECT: a search that empties the grid leaves the chips promising blocks', async () => {
		await render();
		await search('zzz-no-such-block');

		expect(rows(), 'the grid is not empty, so this case is not the one described').toBe(0);
		expect(host.textContent, 'the no-match notice never rendered').toContain(m.blocks_no_match());

		for (const c of visibleChips()) {
			expect(
				c.count,
				`the chip "${c.label}" promises ${c.count} blocks while the grid shows none`
			).toBe(0);
		}
	});

	it('⛔ …and a partial search: each chip counts only what survives the term', async () => {
		await render();
		await search('alpha');

		const byLabel = Object.fromEntries(visibleChips().map((c) => [c.label, c.count]));
		expect(byLabel[m.blocks_cat_all()], 'the All chip still counts the whole library').toBe(1);
		expect(byLabel[m.blocks_cat_data()], 'the Data chip still counts every data block').toBe(1);
		// AI drops to zero and, having no active state to preserve, hides itself — a dead "AI 0" chip
		// is the thing the existing `countFor(c.key) > 0` guard exists to prevent.
		expect(
			byLabel[m.blocks_cat_ai()] ?? 0,
			'the AI chip offers matches the search cannot deliver'
		).toBe(0);
	});

	it('⛔ THE INVARIANT: every visible chip renders exactly the number of rows its click produces', async () => {
		await render();
		// Walked across a no-term state, a broad term and a narrow one, so a count that is right only
		// when nothing is typed cannot pass.
		for (const term of ['', 'data', 'alpha', 'zzz-no-such-block']) {
			await search(term);
			const promised = visibleChips().map((c) => ({ label: c.label, count: c.count }));
			// Snapshot first: clicking mutates `activeCategory`, and a count that changed because a
			// chip was pressed would be a different defect hiding this one.
			for (const { label, count } of promised) {
				await clickChip(label);
				expect(
					rows(),
					`term "${term}": chip "${label}" reads ${count} but its grid shows ${rows()}`
				).toBe(count);
			}
			await clickChip(m.blocks_cat_all());
		}
	});

	it('⛔ THE OVER-CORRECTION GUARD: with no search term the counts are the full category totals', async () => {
		// Folding `activeCategory` into `countFor` would make every case above pass trivially (every
		// inactive chip reading 0) while destroying the only navigation out of a filter. Selecting
		// Data must not zero the AI chip.
		await render();
		await clickChip(m.blocks_cat_data());

		const byLabel = Object.fromEntries(visibleChips().map((c) => [c.label, c.count]));
		expect(byLabel[m.blocks_cat_all()], 'the All chip stopped counting the whole library').toBe(5);
		expect(byLabel[m.blocks_cat_data()]).toBe(3);
		expect(
			byLabel[m.blocks_cat_ai()],
			'selecting Data zeroed the AI chip — there is now no way back to it'
		).toBe(2);
	});

	it('the ACTIVE chip survives a search that empties its category', async () => {
		// A consequence of counting the search: a selected category can drop to 0 while it is still
		// the active filter. Hiding it there would delete the pressed chip out from under the reader
		// mid-keystroke, leaving nothing on screen saying which filter is still on.
		await render();
		await clickChip(m.blocks_cat_data());
		await search('delta'); // an AI block — no data block matches

		const active = host.querySelector('button.chip.active');
		expect(active, 'the active category chip vanished while it was still filtering the grid').toBeTruthy();
		expect(active?.textContent).toContain(m.blocks_cat_data());
		expect(rows(), 'the grid should be empty: an AI term under a Data filter').toBe(0);
	});
});
