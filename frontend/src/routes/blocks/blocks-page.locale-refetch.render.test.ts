// @vitest-environment jsdom
//
// src/routes/blocks/blocks-page.locale-refetch.render.test.ts — THE DEFECT, at the surface it
// happens on: a Dutch reader opens the block catalogue and it stays in English.
//
// ⛔ WHAT WAS BROKEN. `/api/blocks` localizes `name` and `description` server-side from
// `content_translations` (backend/src/routes/blocks.ts:286-370, keyed per blocks/i18n-key.ts) and
// picks the language off `Accept-Language`, which `authFetch` fills from the live locale rune. So
// the WIRE was always capable of answering in Dutch. What was missing was the second request:
// `/blocks` fetched once, from an `$effect` that tracks `sort` and nothing else, and there was no
// `reloadOnLocaleChange` on the page at all. Switching language in the topbar therefore relocalized
// every `m.*()` label around the grid — the title, the chips, the sort options — and left the forty
// block NAMES and DESCRIPTIONS inside it in whatever language they were first fetched in. Half a
// screen, on the page a demo opens first.
//
// ⚠️ WHY THE `$effect` DID NOT ALREADY COVER IT, since that is the obvious "surely this works"
// objection. `load()` calls `blocksApi.list()`, which calls `authFetch`, which reads `getLocale()`
// — but only AFTER `await ensureFreshToken(30)` (api/auth-fetch.ts:57-64). The read happens in a
// later microtask, outside the effect's synchronous tracking window, so the effect never took a
// dependency on the locale rune. The locale is on the wire; it was never a reload trigger.
//
// ⛔ THE ANTI-VACUITY RULE. Every case asserts BOTH halves: the Dutch copy is on screen AND the
// English copy is gone. "Something rendered" is satisfied by a page that re-rendered the same list,
// and "the English is gone" is satisfied by a page that crashed and rendered nothing — so the grid
// is asserted to exist, with the right number of cards, in the same breath. The two fixtures share
// no substring in either direction (checked in the first case) so neither assertion can be
// satisfied by the other language's text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockListItem } from '$lib/types/blocks';
import { locale } from '$lib/stores/locale.svelte';

// Real `en` catalog, each key resolving to its own name — see the sibling render tests. The chrome
// is deliberately NOT the subject here: this file is about the API-fetched user content inside the
// grid, which no message catalog can reach.
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
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the page imports and silently does nothing.
vi.mock('$lib/api/blocks', () => ({ blocksApi: { list } }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/**
 * ⛔ THE TWO LANGUAGES SHARE NO SUBSTRING, IN EITHER DIRECTION. Every assertion below is of the
 * form "the Dutch is present AND the English is absent"; overlapping words (a shared "parser", a
 * shared slug fragment) would let one half be satisfied by the other language's text. Pinned by
 * the first case rather than trusted.
 */
const EN = {
	name: 'Invoice parser',
	description: 'Reads a supplier document and returns typed lines.'
};
const NL = {
	name: 'Factuurverwerker',
	description: 'Leest een leveranciersbestand en geeft getypeerde regels terug.'
};

function block(over: { name: string; description: string }): BlockListItem {
	return {
		slug: 'invoice-parser',
		name: over.name,
		description: over.description,
		category: 'data',
		owner: 'tenant',
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

const LIBRARY_EN = { items: [block(EN)], total: 1 };
const LIBRARY_NL = { items: [block(NL)], total: 1 };

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function cards(): HTMLElement[] {
	return [...host.querySelectorAll('.block-card:not(.skeleton)')] as HTMLElement[];
}
function gridText(): string {
	return host.querySelector('.blocks-grid')?.textContent ?? '';
}

/**
 * Drive a REAL locale change, the way the topbar switcher does — minus the network.
 *
 * ⚠️ ASSIGNED DIRECTLY, NEVER VIA `locale.set()`: that method fires an `authFetch` PATCH to
 * `/api/me/locale`, which is unmocked here and would either hit the network or throw inside the
 * store. `set()`'s only other job is `pgSetLocale` + `<html lang>`, neither of which any assertion
 * below reads. The rune assignment IS the trigger the page reacts to — `reloadOnLocaleChange`
 * tracks `locale.current` and nothing else.
 */
async function switchToDutch() {
	locale.current = 'nl';
	flushSync();
	await settle();
}

async function render() {
	window.history.replaceState({}, '', '/blocks');
	list.mockResolvedValue(LIBRARY_EN);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ THE POSITIVE MARKER. Without it, "the English is gone" passes against a page that never
	// rendered.
	expect(
		host.querySelector('select.sort'),
		'the blocks page never rendered, so this file tests nothing'
	).not.toBeNull();
	expect(cards(), 'the English library never reached the grid').toHaveLength(1);
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	locale.current = initialLocale;
	flushSync();
	list.mockReset();
	goto.mockReset();
});

describe('/blocks relocalizes its catalogue when the reader switches language', () => {
	it('the two fixtures really are different, and neither contains the other', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. If these overlapped, "the Dutch name is present" could
		// be satisfied by the English one still sitting there.
		expect(NL.name).not.toBe(EN.name);
		expect(NL.description).not.toBe(EN.description);
		for (const [a, b] of [
			[EN.name, NL.name],
			[NL.name, EN.name],
			[EN.description, NL.description],
			[NL.description, EN.description]
		]) {
			expect(a!.includes(b!), `"${a}" must not contain "${b}"`).toBe(false);
		}
	});

	it('⛔ a locale switch re-requests the library and the grid is Dutch, with no English left', async () => {
		await render();
		// The English is genuinely on screen first — otherwise the "absent" half below proves nothing.
		expect(gridText()).toContain(EN.name);
		expect(gridText()).toContain(EN.description);
		expect(gridText()).not.toContain(NL.name);

		list.mockResolvedValue(LIBRARY_NL);
		await switchToDutch();

		// The request really was re-issued. (The locale rides on `Accept-Language`, not on the
		// argument, so the argument is unchanged — the COUNT is the observable.)
		expect(list, 'the locale switch did not refetch the library').toHaveBeenCalledTimes(2);

		// The grid still exists and still holds the card — not a blank page, not a skeleton.
		expect(cards(), 'the grid was torn down instead of re-rendered').toHaveLength(1);
		expect(gridText()).toContain(NL.name);
		expect(gridText()).toContain(NL.description);
		// …and the English is GONE. Red by deleting `reloadOnLocaleChange` from the page.
		expect(gridText()).not.toContain(EN.name);
		expect(gridText()).not.toContain(EN.description);
	});

	it('⛔ …and a sort change AFTER the switch is still ONE request, not two', async () => {
		// ⛔ THE TRAP IN THE SHARED IDIOM. `reloadOnLocaleChange` calls `load()` from inside its own
		// `$effect`, and `load()` reads `sort` synchronously (`blocksApi.list({ sort })`). Svelte
		// re-collects an effect's dependencies on every run, so the FIRST locale switch makes the
		// locale effect a second subscriber to `sort` — and from then on every sort change fires both
		// it and the page's own sort effect: two identical requests, on the heaviest page in the app,
		// which is the exact defect blocks-page.single-load.render.test.ts was written about.
		// `untrack` in +page.svelte is what keeps this at one.
		await render();
		list.mockResolvedValue(LIBRARY_NL);
		await switchToDutch();
		expect(list).toHaveBeenCalledTimes(2);

		const select = host.querySelector('select.sort') as HTMLSelectElement;
		select.value = 'recent';
		// `bubbles: true` — Svelte 5 delegates `change` to the mount root.
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(list, 'the sort change fired twice').toHaveBeenCalledTimes(3);
		expect(list).toHaveBeenLastCalledWith({ sort: 'recent' });
	});

	it('the mount itself is still a single request — the reload must not double the first fetch', async () => {
		// Guards the OVER-fix: `reloadOnLocaleChange` deliberately skips its first run because
		// `onMount`/the sort effect already covers it. Pinned separately by
		// blocks-page.single-load.render.test.ts; asserted here too so a variant that "just uses a
		// plain $effect" reds in the file that introduced it.
		await render();
		expect(list).toHaveBeenCalledTimes(1);
	});
});
