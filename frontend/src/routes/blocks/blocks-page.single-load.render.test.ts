// @vitest-environment jsdom
//
// src/routes/blocks/blocks-page.single-load.render.test.ts — /blocks must fetch its library ONCE.
//
// ⛔ THE REGRESSION. The page had TWO independent load triggers that both fire in the same
// post-mount flush: `$effect(() => { void sort; load(); })` and `onMount(… load())`. Every visit
// issued two identical `GET /api/blocks?sort=usage` — 590 ms and then 446 ms, on the heaviest page
// in the app. The `onMount` call is the redundant one; the effect runs on mount too.
//
// Test 2 is the guard on OVER-deleting: whatever the implementation, changing the sort must still
// refetch, with the new sort. Be honest about its limit — it drives the change through the DOM, so
// it CANNOT distinguish the `$effect` from a hand-attached `onchange` on that one <select>. That
// distinction is not observable from outside the component (`sort` is private `$state`), and the
// reason to keep the `$effect` is therefore an argument, not an assertion: the effect reloads on
// ANY `sort` change, an `onchange` only on that element's user-driven one, and it is strictly more
// code for strictly less coverage. The comment in +page.svelte carries that argument.
//
// ⛔ AND THE OTHER WRONG FIX, which is why test 3 exists. `load()` reads ONLY `sort`
// (`blocksApi.list({ sort })`); `activeCategory` and `q` are client-side filters over the full
// list. So the URL restore in `onMount` does NOT need to happen before the fetch, and moving
// `load()` behind a `urlReady` gate to "be safe" would reintroduce a second request. Test 3 mounts
// with both params in the URL and demands ONE request with both values restored.
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
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

function block(slug: string, category: BlockListItem['category']): BlockListItem {
	return {
		slug,
		name: slug,
		description: 'foo bar',
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

const LIBRARY = { items: [block('a-block', 'data'), block('foo-block', 'ai')], total: 2 };

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(search = '') {
	window.history.replaceState({}, '', `/blocks${search}`);
	list.mockResolvedValue(LIBRARY);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(
		host.querySelector('select.sort'),
		'the blocks page never rendered, so this file tests nothing'
	).not.toBeNull();
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

describe('/blocks issues exactly one list request per sort', () => {
	it('mounting fetches the library ONCE', async () => {
		await render();
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledWith({ sort: 'usage' });
	});

	it('changing the sort still refetches — do not delete the reload along with the duplicate', async () => {
		await render();
		const select = host.querySelector('select.sort') as HTMLSelectElement;
		select.value = 'recent';
		// `bubbles: true` — real browser change events bubble, and Svelte 5 DELEGATES `change` to
		// the mount root. A non-bubbling synthetic event reaches `bind:value`'s own direct listener
		// but never a delegated `onchange`, which would make this test pass or fail on an artifact
		// of the harness rather than on behaviour.
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(list).toHaveBeenCalledTimes(2);
		expect(list).toHaveBeenLastCalledWith({ sort: 'recent' });
	});

	it('restores category + q from the URL and STILL fetches once', async () => {
		await render('?category=ai&q=foo');
		expect(list).toHaveBeenCalledTimes(1);
		// Neither value is a query parameter of the fetch — both are client-side filters, which is
		// precisely why the fetch does not have to wait for the restore.
		expect(list).toHaveBeenCalledWith({ sort: 'usage' });
		const active = host.querySelector('button.chip.active');
		expect(active?.textContent).toContain('blocks_cat_ai');
		expect((host.querySelector('input.search') as HTMLInputElement).value).toBe('foo');
	});
});
