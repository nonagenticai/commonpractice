// @vitest-environment jsdom
//
// src/routes/build/build-page.add-block-failure.render.test.ts — a drag that lands on nothing must
// say so.
//
// ⛔ THE DEFECT. `onDropBlock()` opened with a bare `await ensureBlock(slug)`. When that rejected the
// function rejected, and the DRAG path — `FlowCanvas`'s `ondrop`, which calls it without awaiting —
// had nowhere for the rejection to go: no node appeared, no message appeared, nothing at all. The
// click path (`onAddBlock`) was one notch better and still invisible: `console.warn`.
//
// ⛔ AND THE FETCH IS LIVE ON THE FIRST INTERACTION WITH EVERY TILE, which is what makes this
// ordinary rather than exotic. `ensureBlock` caches only what IT fetched; `paletteItems` comes from
// `blocksApi.list` (summaries) and never populates `blockCache`. So the first drop of any tile is a
// real `GET /api/blocks/:slug` — 5xx, a dropped connection, or a 404 because the block was archived
// between the palette listing and the drag.
//
// ⛔ THE FIX BELONGS IN `onDropBlock`, NOT `onAddBlock`, and this file is built to tell them apart:
// both entry points funnel through the drop handler, and only a fix inside it covers the drag. Case
// one drives a real `drop` event on the canvas — never the tile's click — so a `.catch()` bolted
// onto the click path alone stays red.
//
// ⛔ THE FAILURE IS A REAL `Response` THROUGH THE REAL CLIENT. `$lib/api/blocks` is not mocked; only
// `$lib/api/auth-fetch` is (see `src/lib/api/error-message.wire.test.ts` for why a hand-built
// rejection proves nothing about the shape the product actually throws).
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

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build?id=f1') } }));
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

const SLUG = 'load-dataset';
/** The isolate the page wraps a slug in before interpolation — see graph-issue-label.ts's `iso`. */
const ISO = (v: string) => `\u2068${v}\u2069`;

/** What `GET /api/blocks/:slug` answers. Swapped per case. */
let detailReply: { status: number; body: unknown } = { status: 200, body: null };
let detailCalls = 0;

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

function blockDetail() {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Load dataset',
		description: 'Reads a dataset',
		category: 'data',
		current_version_id: 'v1',
		maintainer_id: null,
		owner: 'global',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		maintainer: null,
		versions: [
			{
				id: 'v1',
				block_id: 'b1',
				version: '1.0.0',
				status: 'stable',
				language: 'typescript',
				docs_md: '',
				source_ts: '',
				descriptor: { inputs: {}, outputs: {}, capabilities: {} },
				examples: [],
				changelog: '',
				tests_passing: true,
				usage_count: 0,
				published_by: null,
				published_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z',
				author: null
			}
		]
	};
}

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

const blockTile = () => target.querySelector(`[data-block-slug="${SLUG}"]`) as HTMLElement | null;

/** The node count the BUILDER sees, read off the topbar's `data-node-count`. */
function nodeCountText(): string {
	const path = target.querySelector('.path') as HTMLElement | null;
	expect(path, 'the Build topbar never rendered — this file would test nothing').toBeTruthy();
	// The visible "N blocks" text is gone from the topbar; the count rides on `data-node-count`.
	const n = path!.dataset.nodeCount;
	expect(n, 'the topbar carries no node count').toMatch(/^\d+$/);
	return `nodes:${n}`;
}

/**
 * A real `drop` on the canvas carrying the palette's own drag payload.
 *
 * ⛔ THE DRAG PATH, NOT THE CLICK. `FlowCanvas.ondrop` calls `onDropBlock` WITHOUT awaiting it, so a
 * rejection there had no `.catch()` anywhere — this is the entry point where the failure was
 * completely silent, and the reason the fix has to live in `onDropBlock` itself.
 */
function dropTile(slug = SLUG) {
	const canvas = target.querySelector('[data-cp-canvas]') as HTMLElement | null;
	expect(canvas, 'the canvas never rendered — the drag path is unreachable').toBeTruthy();
	const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & {
		dataTransfer: unknown;
		clientX: number;
		clientY: number;
	};
	Object.defineProperties(ev, {
		clientX: { value: 320 },
		clientY: { value: 240 },
		dataTransfer: {
			value: {
				types: ['application/cp-block'],
				getData: (t: string) => (t === 'application/cp-block' ? slug : ''),
				dropEffect: 'move'
			}
		}
	});
	canvas!.dispatchEvent(ev);
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	detailCalls = 0;
	detailReply = { status: 200, body: blockDetail() };
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		if (method === 'GET' && url === `/api/blocks/${SLUG}`) {
			detailCalls++;
			return json(detailReply.body, detailReply.status);
		}
		if (method === 'GET' && url.startsWith('/api/blocks?'))
			return json({ items: [paletteItem()], total: 1 });
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

async function mountBuild() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	await settle();
	// ⛔ POSITIVE MARKERS. /build mounts a dozen modules; without these, "no error is shown" and
	// "the canvas did not change" both pass against a DOM that never rendered.
	expect(blockTile(), 'no block tile in the palette').toBeTruthy();
	expect(nodeCountText(), 'precondition: the canvas starts empty').toBe('nodes:0');
	expect(detailCalls, 'the block detail was fetched before any interaction').toBe(0);
}

/** The failure the fix must render, built the way the page builds it. */
const EXPECTED = () =>
	m.build_add_block_error({ slug: ISO(SLUG), error: m.error_load_failed() });

describe('/build surfaces a block that could not be added', () => {
	it('⛔ THE DEFECT, ON THE DRAG PATH: a 404 block drops into total silence', async () => {
		// The block was archived between the palette listing and the drag — an ordinary race, and the
		// only signal the builder got was that nothing happened.
		detailReply = { status: 404, body: { error: 'not_found', message: 'Block not found' } };
		await mountBuild();

		dropTile();
		await settle();
		await settle();

		// Non-vacuity: the drop really reached the page and the page really asked the API.
		expect(detailCalls, 'the drop never reached `onDropBlock` — this case tests nothing').toBe(1);
		expect(nodeCountText(), 'a failed lookup put a node on the canvas anyway').toBe(
			'nodes:0'
		);
		expect(
			target.textContent,
			'the drag failed and the builder was told nothing at all'
		).toContain(EXPECTED());
	});

	it('⛔ …and on the CLICK path, where it was a console.warn nobody reads', async () => {
		detailReply = { status: 500, body: { error: 'internal_error' } };
		await mountBuild();

		blockTile()!.click();
		await settle();
		await settle();

		expect(detailCalls, 'the tile never asked for the block').toBe(1);
		expect(nodeCountText()).toBe('nodes:0');
		expect(target.textContent, 'the click failed silently').toContain(EXPECTED());
	});

	it('THE HAPPY PATH SURVIVES, and the notice does not outlive the failure', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. A page that renders the notice unconditionally passes both
		// cases above forever, and a notice that never clears turns one transient 500 into a pill the
		// builder has to reload the page to be rid of.
		detailReply = { status: 500, body: { error: 'internal_error' } };
		await mountBuild();
		blockTile()!.click();
		await settle();
		await settle();
		expect(target.textContent).toContain(EXPECTED());

		detailReply = { status: 200, body: blockDetail() };
		dropTile();
		await settle();
		await settle();

		expect(nodeCountText(), 'the block that DID resolve never reached the canvas').toBe(
			'nodes:1'
		);
		expect(target.textContent, 'the stale failure notice survived a successful add').not.toContain(
			EXPECTED()
		);
	});
});
