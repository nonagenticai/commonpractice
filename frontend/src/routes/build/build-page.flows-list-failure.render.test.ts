// @vitest-environment jsdom
//
// src/routes/build/build-page.flows-list-failure.render.test.ts — a failed LOAD must not be
// reported as a failed CREATE.
//
// ⛔ THE DEFECT, one word wide and two screens deep. /build's boot sequence is three loads and at
// most one create, all inside one `try`, and its single `catch` read:
//
//     bootError = writeErrorText(e, m.error_create_failed());
//
// `error_create_failed` is "We konden dat niet aanmaken. Probeer het opnieuw." — so a builder whose
// `GET /api/flows` (or `GET /api/blocks`) 503'd was told something could not be CREATED, wrapped in
// `build_boot_error`. That is the OVERWHELMINGLY common failure on this path: the create arm runs
// only for a workspace with zero flows AND no `?id=` in the URL. The reader goes looking for a name
// collision or a quota, for a request that was a plain read.
//
// ⛔ AND THE ONE-WORD FIX IS THE MIRROR-IMAGE DEFECT, WHICH IS WHY THIS FILE HAS TWO CASES.
// Swapping the fallback to `error_load_failed` outright makes a genuinely failed `POST /api/flows`
// report "We couldn't load that" — and `build-page.palette-load-failure.render.test.ts`'s
// over-correction guard names the create copy as legitimately covering `flowsApi.create`. The stage
// the sequence is in is the fact both sentences depend on, so that is what the page records, and
// both directions are driven below.
//
// ⚠️ WHY THE ASSERTION IS ON THE PILL AND NOT ON A VARIABLE. `writeErrorText`'s FALLBACK only
// surfaces when the error carries no localizable code — which a bare 503 with no body does not.
// That is the exact shape the network produces on an outage, and the boot pill is where the reader
// meets it.
//
// Harness copied from `build-page.palette-load-failure.render.test.ts`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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

// ⛔ NO `?id=`. With an id in the URL the boot sequence never reaches the flows-list branch that
// decides between "open the first flow" and "create one", and neither case below can arise.
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/services/sse', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, streamRun: () => ({ close: () => {} }) };
});

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

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

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** How the two GETs behave this run. `list` is `GET /api/flows`; `create` is `POST /api/flows`. */
let listStatus = 503;
let createStatus = 201;

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const pill = () => target.querySelector('.boot-error') as HTMLElement | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	listStatus = 503;
	createStatus = 201;
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		// ⚠️ THE PALETTE IS HEALTHY IN BOTH CASES, DELIBERATELY. `loadPalette` owns its own error
		// state and never rejects out of `Promise.all` (that is what
		// `build-page.palette-load-failure.render.test.ts` exists for), so leaving it 200 keeps the
		// boot pill's text attributable to `GET /api/flows` and nothing else.
		if (method === 'GET' && url.startsWith('/api/blocks?')) return json({ items: [], total: 0 });
		if (method === 'POST' && url.startsWith('/api/flows'))
			return createStatus >= 400
				? new Response('', { status: createStatus })
				: json({ id: 'f-new' }, 201);
		if (method === 'GET' && url.startsWith('/api/flows'))
			return listStatus >= 400
				? // A bare status with NO body: the shape an outage produces, and the only shape where
					// `writeErrorText` reaches its fallback rather than a coded catalog sentence.
					new Response('', { status: listStatus })
				: json({ items: [], total: 0 });
		return json({ items: [], total: 0 });
	});
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	authFetch.mockReset();
});

async function mountBuild() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	await settle();
	expect(target.querySelector('.build-page'), 'the builder never rendered').toBeTruthy();
}

describe('/build names the boot step that actually failed', () => {
	it('⛔ THE DEFECT: a failed flows LIST reports "create failed"', async () => {
		await mountBuild();
		const el = pill();
		expect(el, 'a 503 on GET /api/flows produced no boot pill at all').toBeTruthy();
		expect(
			el!.textContent,
			'a failed READ of the flow list told the builder something could not be CREATED'
		).toBe(m.build_boot_error({ error: m.error_load_failed() }));
		expect(el!.textContent).not.toContain(m.error_create_failed());
	});

	it('…and a genuinely failed CREATE still says "create failed"', async () => {
		// ⛔ THE OVER-CORRECTION GUARD, and it is the half a one-word swap fails. The list loads
		// EMPTY — which is what sends a brand-new workspace into the create arm — and the create is
		// the request that dies.
		listStatus = 200;
		createStatus = 500;
		await mountBuild();
		const el = pill();
		expect(el, 'a failed POST /api/flows produced no boot pill at all').toBeTruthy();
		expect(
			el!.textContent,
			'the fallback was swapped wholesale, so a failed create now reports a failed load'
		).toBe(m.build_boot_error({ error: m.error_create_failed() }));
	});

	it('a healthy boot paints no pill at all', async () => {
		// NON-VACUITY for both cases above: `.boot-error` is genuinely absent when nothing failed, so
		// "the pill says X" is never being read off furniture that is always there.
		listStatus = 200;
		await mountBuild();
		expect(pill(), 'the boot pill is painted even on a successful boot').toBeNull();
	});
});
