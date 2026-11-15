// @vitest-environment jsdom
//
// src/routes/blocks/blocks-page.simulated-badge.render.test.ts — the catalogue card is the FIRST
// place a reader meets a block, so it is the first place that has to say whether running it will
// produce a real result.
//
// ⛔ THE DEFECT. `ocr-scan` sat in this grid describing itself as "Tesseract+Claude hybrid OCR for
// messy scans" while its `run()` was a single `ctx.mockData("scan", …)` returning "Scanned document
// text (sample N). Lorem ipsum dolor sit amet." The card could not have said otherwise even if
// someone had wanted it to: `GET /api/blocks` served no descriptor at all, so
// `capabilities.mockData` — the bit that already existed and already meant exactly this — never
// reached the browser. `routes/blocks.ts` now projects it onto the card row as `mock_data`, and
// this file pins that the card renders it.
//
// ⛔ BOTH DIRECTIONS. Asserting only "mock_data ⇒ badge" passes on a `{#if true}` mutant, which
// would stamp "Gesimuleerd" on every real block in the library and make the badge worthless. The
// grid below therefore mixes a fixture-backed block with a pure one and asserts the badge lands on
// exactly one card — and on WHICH one, so a mutant that badges the wrong row also dies.
//
// ⚠️ The catalog mock resolves the real `messages/nl.json` and the assertion is the Dutch word, not
// a key name: the reader-visible failure is that the card said nothing, and a key-name mock cannot
// distinguish a localized badge from a raw key. Sibling surfaces (build palette, canvas node, run
// output) are swept together in
// src/lib/components/block-simulated-badge.surfaces.render.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
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
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length
				? `${catalog[key]} ${Object.values(params).join(',')}`
				: catalog[key];
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

import Page from './+page.svelte';

/** `messages/nl.json` → `block_simulated_badge`. */
const BADGE_NL = 'Gesimuleerd';

function block(slug: string, mockData: boolean | undefined): BlockListItem {
	return {
		slug,
		name: slug,
		description: `${slug} summary`,
		category: 'data',
		owner: 'global',
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		...(mockData === undefined ? {} : { mock_data: mockData }),
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const cards = () => [...host.querySelectorAll('.blocks-grid .block-card')];

/** The slugs whose card carries the badge — the name, not just a count, so a mutant that badges
 *  the WRONG card cannot pass by badging the right NUMBER of cards. */
function badgedSlugs(): string[] {
	return cards()
		.filter((c) => c.querySelector('.sim-badge'))
		.map((c) => c.querySelector('.block-card-name')?.textContent?.trim() ?? '');
}

async function render(items: BlockListItem[]) {
	window.history.replaceState({}, '', '/blocks');
	list.mockResolvedValue({ items, total: items.length });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE MARKER — without it every `toEqual([])` below passes against a page that never
	// rendered a single card.
	expect(
		host.querySelector('input.search'),
		'the blocks page never rendered, so this file tests nothing'
	).not.toBeNull();
	expect(cards(), 'the library never reached the grid').toHaveLength(items.length);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockReset();
	goto.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

describe('the /blocks catalogue card says when a block returns sample data', () => {
	it('⛔ the badge lands on the fixture-backed card and ONLY on it', async () => {
		await render([block('ocr-scan', true), block('format-output', false)]);
		expect(badgedSlugs()).toEqual(['ocr-scan']);
		// The word itself, in Dutch — not a raw key, not English.
		expect(host.querySelector('.sim-badge')?.textContent?.trim()).toBe(BADGE_NL);
	});

	it('⛔ a library of pure blocks carries NO badge (the badge-always-on mutant dies here)', async () => {
		await render([block('format-output', false), block('if-else', false)]);
		expect(badgedSlugs()).toEqual([]);
	});

	it('⛔⛔ the dataset-reading block is UNBADGED next to a genuinely simulated one', async () => {
		// ⛔⛔ THE INVERSE DEFECT, AND THE ONE A CUSTOMER ACTS ON. Every other case here guards a
		// fixture-backed block staying silent; this guards a REAL one being called fake.
		// `load-dataset` returns the tenant's OWN uploaded rows — its `run()` is a single
		// `ctx.dataset(inputs.source)`. It used to declare `capabilities.mockData` only because the
		// executor gated `ctx.dataset` on that bit, and the backend projects `mock_data` from exactly
		// that bit, so this card was one deploy away from telling a customer their data was invented.
		//
		// The backend now projects `mock_data: false` for it (`capabilities.mockData === true` is what
		// `routes/blocks.ts` reads, and the descriptor declares `dataset` instead). Rendered beside a
		// truly simulated card so the assertion discriminates: "badge nothing" fails the first half of
		// the expectation, "badge everything" fails the second.
		await render([block('ocr-scan', true), block('load-dataset', false)]);
		expect(badgedSlugs()).toEqual(['ocr-scan']);
	});

	it('⛔ a card from a backend too old to send the field is UNBADGED, not crashed', async () => {
		// `mock_data` is optional on the wire (see BlockListItem): mid-rolling-deploy the browser can
		// hold a payload that predates it. Absent must render as "no badge" — and it must never be
		// read as proof the block is real, which is why the corrected PROSE ships alongside.
		await render([block('ocr-scan', undefined)]);
		expect(badgedSlugs()).toEqual([]);
	});
});
