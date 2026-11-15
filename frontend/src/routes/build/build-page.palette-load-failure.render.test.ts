// @vitest-environment jsdom
//
// src/routes/build/build-page.palette-load-failure.render.test.ts — a failed block library must not
// render as an empty one.
//
// ⛔ THE DEFECT. `loadPalette()` had a `finally` and no `catch`, so a failed `GET /api/blocks`
// rejected out of `Promise.all` into `onMount`'s catch — and left `paletteItems` at `[]`. The
// palette then rendered its search box and, the moment the builder typed anything into it,
// `blocks_no_match` — "No blocks match your search." That is an EMPTY STATE FOR A FAILURE: it tells
// a builder whose library did not load that their search was too narrow. The same class was already
// fixed one screen over, in `solutions/[id]/+page.svelte:509`, where the delivery failure branch
// REPLACES `delivery_forward_none` rather than sitting beside it.
//
// ⚠️ WHAT IS **NOT** THE DEFECT, AND MUST NOT BE "FIXED": the outer boot pill. `build_boot_error` is
// "Couldn't load the builder: {error}" — accurate, and it is the frame that stays. The lie is inside
// the palette, and there was NO WAY BACK: `loadPalette` is called from `onMount` and nowhere else,
// so the only retry was a full page reload.
//
// ⛔ THE FAILURE IS A REAL `Response` THROUGH THE REAL CLIENT. `$lib/api/blocks` is not mocked; only
// `$lib/api/auth-fetch` is, and it answers 503 with a real body, so the rejection is the one
// `blocksApi.list`'s own `unwrap` produces. A hand-built rejection cannot discover that the product
// never builds that shape — the lesson of `src/lib/api/error-message.wire.test.ts`.
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
vi.mock('$lib/services/sse', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, streamRun: () => ({ close: () => {} }) };
});

// ⛔ The ALIAS id. Every typed client in `$lib/api` reaches the network through exactly this
// function, so stubbing it — and nothing else — leaves every `unwrap` in the chain intact.
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

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

import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

const SLUG = 'load-dataset';

/** How many times `GET /api/blocks` has been answered, and with what. */
let blocksListCalls = 0;
let blocksListReply: { status: number; body: unknown } = { status: 200, body: { items: [], total: 0 } };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
const OK_LIST = { items: [paletteItem()], total: 1 };

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

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const palette = () => target.querySelector('aside.palette') as HTMLElement | null;
const paletteText = () => palette()?.textContent ?? '';
const search = () => palette()?.querySelector('input.palette-search') as HTMLInputElement | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	blocksListCalls = 0;
	blocksListReply = { status: 503, body: { error: 'upstream_unavailable' } };
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		if (method === 'GET' && url.startsWith('/api/blocks?')) {
			blocksListCalls++;
			return json(blocksListReply.body, blocksListReply.status);
		}
		if (method === 'GET' && url.startsWith('/api/flows/f1')) return json(emptyFlow());
		if (method === 'GET' && url.startsWith('/api/flows'))
			return json({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 0 }], total: 1 });
		if (method === 'PATCH' || method === 'PUT') return json(emptyFlow());
		return json({ items: [], total: 0 });
	});
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	authFetch.mockReset();
});

/** Mount /build and wait for the boot sequence to finish. */
async function mountBuild() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	await settle();
	// ⛔ POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
	// nothing, every `querySelector` answers null, and "…does not say no-match" passes on an empty
	// DOM. The palette must actually be there.
	expect(palette(), 'the palette never rendered — this file would test nothing').toBeTruthy();
	expect(blocksListCalls, 'GET /api/blocks was never issued').toBeGreaterThan(0);
}

describe('/build tells the truth when the block library fails to load', () => {
	it('⛔ THE DEFECT: a 503 library renders "no blocks match" instead of a failure', async () => {
		await mountBuild();
		// ⚠️ THE TYPING IS CONDITIONAL, AND THAT IS THE ASSERTION, NOT A DODGE. `blocks_no_match` only
		// appears once a builder types — which is exactly what someone staring at an empty palette
		// does next. On the defect the search box is there, the query goes in, and the sentence
		// arrives. The fix REPLACES the whole panel, so there is no box to type into and the empty
		// state is structurally unreachable; both outcomes are checked below, and the positive
		// `palette_load_error` assertion is what stops this passing on a blank DOM.
		const box = search();
		if (box) {
			box.value = 'dataset';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			await settle();
		}

		expect(paletteText(), 'the palette says nothing about the failure').toContain(
			m.palette_load_error()
		);
		expect(
			paletteText(),
			'a failed library load tells the builder their SEARCH found nothing'
		).not.toContain(m.blocks_no_match());
		expect(
			search(),
			'the search box survives the failure, so the empty state is one keystroke away'
		).toBeNull();
	});

	it('⛔ …and there is a way back: retry re-issues the request and fills the palette', async () => {
		await mountBuild();
		expect(paletteText()).toContain(m.palette_load_error());
		const before = blocksListCalls;

		const retry = [...palette()!.querySelectorAll<HTMLButtonElement>('button')].find(
			(b) => b.textContent?.trim() === m.error_load_retry()
		);
		expect(retry, '"Try again" names an action the screen does not offer').toBeTruthy();

		// The library comes back. A control that exists and does nothing is the defect in a fix's
		// clothes, so this asserts the RE-REQUEST and the rendered result, not merely the button.
		blocksListReply = { status: 200, body: OK_LIST };
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		await settle();

		expect(blocksListCalls, 'the retry button re-issued no request').toBe(before + 1);
		expect(paletteText(), 'the failure notice survived a successful retry').not.toContain(
			m.palette_load_error()
		);
		expect(
			palette()!.querySelector(`[data-block-slug="${SLUG}"]`),
			'the retry succeeded and the palette stayed empty'
		).toBeTruthy();
	});

	it('the OUTER boot pill is left alone — it was already accurate', async () => {
		// ⛔ THE OVER-CORRECTION GUARD, AND THE ONE THAT WAS NEARLY GOT WRONG. `build_boot_error`
		// ("Couldn't load the builder: {error}") is a true sentence about a boot that failed, and
		// `error_create_failed` inside `onMount`'s catch legitimately covers `flowsApi.create`.
		// Relabelling either would mis-describe a real create failure.
		// ⚠️ That `catch` no longer uses ONE fallback for the whole boot sequence — it names the
		// stage (load vs create), because a failed `GET /api/flows` was reported as a failed CREATE.
		// The create half is unchanged and is pinned by
		// `build-page.flows-list-failure.render.test.ts`'s over-correction case.
		await mountBuild();
		expect(
			target.textContent,
			'the palette failure was promoted into the boot pill, which is about the whole builder'
		).not.toContain(m.build_boot_error({ error: m.palette_load_error() }));
		// The builder itself still booted: the canvas is there and usable.
		expect(target.querySelector('.build-page'), 'the whole builder was torn down').toBeTruthy();
	});

	it('THE EMPTY STATE SURVIVES: a healthy library with a no-hit search still says so', async () => {
		// ⛔ Deleting `blocks_no_match` outright passes the first case forever; this is the half that
		// reds on it.
		blocksListReply = { status: 200, body: OK_LIST };
		await mountBuild();
		expect(paletteText()).not.toContain(m.palette_load_error());

		const box = search()!;
		box.value = 'zzzz-no-such-block';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(paletteText(), 'a genuine no-hit search lost its empty state').toContain(
			m.blocks_no_match()
		);
	});
});
