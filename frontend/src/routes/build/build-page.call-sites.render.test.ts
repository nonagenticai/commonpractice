// @vitest-environment jsdom
//
// src/routes/build/build-page.call-sites.render.test.ts — /build's own call sites: what the PAGE
// passes to its components and to the shell, which component-level tests cannot see.
//
//   · the assistant's session cost is shown from the role GATE, not a hard-coded `showCost={true}`;
//   · the app sidebar is collapsed by an OVERRIDE while /build is mounted, and released on leave;
//   · below 1024px the WHOLE builder is read-only (the store's `locked`), not just the canvas —
//     the assistant composer, the title, Submit, Undo/Redo and the Details panel included — while
//     Test run stays available (it runs the saved graph and writes nothing to the flow).
//
// Harness copied from `build-page.readonly.render.test.ts` (same stubs, same `settle()`), with the
// auth store mocked so the role is the test's to choose, and the flow OWNED by the reader.
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

vi.mock('$app/state', () => ({
	// `?challenge=` is carried so the Submit gate's OTHER terms are all satisfied: with no challenge
	// in context Submit is disabled anyway and asserting it is disabled here would prove nothing.
	page: { url: new URL('http://localhost/build?id=f1&challenge=c1') }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
// The cost line is hidden at $0 (platform-paid local inference), so the real store starts with a
// non-zero session spend here; otherwise the admin case below could never show the line.
vi.mock('$lib/stores/agent-chat.svelte', async (importOriginal) => {
	const actual = (await importOriginal()) as { AgentChatStore: new (...a: never[]) => { costUsd: number } };
	class WithSpend extends actual.AgentChatStore {
		constructor(...a: never[]) {
			super(...a);
			this.costUsd = 0.0041;
		}
	}
	return { ...actual, AgentChatStore: WithSpend };
});
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

const { roles } = vi.hoisted(() => ({ roles: { current: ['member'] as string[] } }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		get user() {
			return { roles: roles.current, name: 'Pat', email: 'p@x.test', counts: {} };
		},
		get isSuperAdmin() {
			return roles.current.includes('super_admin');
		},
		get isDeveloper() {
			return roles.current.includes('developer');
		},
		isTenantAdmin: false
	}
}));

import * as m from '$lib/paraglide/messages';
import { sidebar } from '$lib/stores/sidebar.svelte';
import Page from './+page.svelte';

const SLUG = 'load-dataset';
const DESCRIPTOR = { inputs: { in: { type: 'json' } }, outputs: { out: { type: 'json' } }, capabilities: {} };

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
				descriptor: DESCRIPTOR,
				examples: [],
				changelog: '',
				tests_passing: true,
				usage_count: 3,
				published_by: null,
				published_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z'
			}
		]
	};
}

/** ⛔ NOT AN EMPTY GRAPH. "Test run" is disabled by `nodeCount === 0` on ANY flow, so asserting it
 *  is disabled over an empty canvas would be true on the defect too. One real node makes the button
 *  live for an owner, which is what turns the read-only assertion into evidence. */
function flowBody(readOnly: boolean) {
	return {
		id: 'f1',
		name: 'Claim summariser',
		description: '',
		owner_id: readOnly ? 'u-other' : 'u1',
		status: 'draft',
		version: '1',
		solution_id: readOnly ? 's1' : null,
		last_saved_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		graph: {
			nodes: [
				{
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: SLUG,
					label: 'Load dataset',
					category: 'data',
					config: {},
					position: { x: 120, y: 120 }
				}
			],
			edges: []
		},
		readOnly
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
/** Every write the page attempted, by method + path. The whole point of the file. */
let writes: string[] = [];
let blockDetailCalls = 0;
let readOnlyReply = true;
/** When true, `GET /api/blocks/:slug` 500s — the state the unresolved-blocks pill exists for. */
let blockDetailFails = false;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Longer than the 800 ms autosave debounce and the 350 ms history debounce. */
async function pastAutosave() {
	await new Promise((r) => setTimeout(r, 900));
	await settle();
	await settle();
}

const topbar = () => target.querySelector('.topbar') as HTMLElement | null;
const button = (label: string) =>
	[...(topbar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
		(b) => b.textContent?.trim() === label
	);
const title = () => topbar()?.querySelector('input.title') as HTMLInputElement | null;
const notice = () => target.querySelector('[data-testid="readonly-notice"]');
/** The unresolved-blocks pill, whose button is `retryUnresolved`. */
const pill = () => target.querySelector('[data-testid="descriptor-unavailable"]') as HTMLElement | null;
/** The port NAMES the flow's single canvas node draws. `[]` while its descriptor is unresolved.
 *  This is the graph read through the product's own rendering, which is the only channel /build
 *  gives a test — the page owns its `BuilderStore` and exports nothing. */
function portNames(): string[] {
	const node = target.querySelector('.svelte-flow__node') as HTMLElement | null;
	expect(node, 'the flow’s node never reached the canvas — this assertion would test nothing').toBeTruthy();
	return ([...node!.querySelectorAll('.pname')] as HTMLElement[]).map((e) => e.dataset.port ?? '').sort();
}
/** A window-level keydown, exactly what `<svelte:window onkeydown={onKeydown}>` receives. Dispatched
 *  on `window` so its target has no tagName — i.e. the reader is NOT in a text field, which is the
 *  only case `onKeydown` bows out of. */
function press(key: string, extra: KeyboardEventInit = {}) {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, ...extra }));
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	writes = [];
	blockDetailCalls = 0;
	readOnlyReply = false;
	blockDetailFails = false;
	roles.current = ['member'];
	setWidth(1440);
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		if (method !== 'GET') writes.push(`${method} ${url.split('?')[0]}`);
		if (method === 'GET' && url.startsWith('/api/blocks?')) return json({ items: [paletteItem()], total: 1 });
		if (method === 'GET' && url.startsWith(`/api/blocks/${SLUG}`)) {
			blockDetailCalls++;
			if (blockDetailFails) return json({ error: 'internal_error' }, 500);
			return json(blockDetail());
		}
		if (method === 'GET' && url.startsWith('/api/challenges/c1'))
			return json({ id: 'c1', title: 'Claims', datasets: [], involves: [], cycleClosed: false });
		if (method === 'GET' && url.startsWith('/api/flows/f1')) return json(flowBody(readOnlyReply));
		if (method === 'GET' && url.startsWith('/api/flows'))
			return json({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }], total: 1 });
		if (method === 'PATCH' || method === 'PUT') return json(flowBody(readOnlyReply));
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
	await settle();
	// ⛔ POSITIVE MARKERS. /build mounts a dozen modules; one unstubbed import and every
	// `querySelector` answers null, at which point "no PATCH was issued" is true of a blank page.
	expect(topbar(), 'the topbar never rendered — this file would test nothing').toBeTruthy();
	expect(target.querySelector('.build-page'), 'the builder never booted').toBeTruthy();
	expect(blockDetailCalls, 'the flow’s node never resolved its descriptor').toBeGreaterThan(0);
}

function setWidth(px: number) {
	Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}
const composer = () => target.querySelector('#side-panel-assistant .compose input') as HTMLInputElement | null;
const quota = () => target.querySelector('#side-panel-assistant .quota');

describe('/build call sites', () => {
	it('⛔ the session cost follows the role gate: hidden for a member…', async () => {
		roles.current = ['member'];
		await mountBuild();
		expect(target.querySelector('#side-panel-assistant'), 'the assistant panel never rendered').toBeTruthy();
		expect(quota(), 'a member was shown the LLM spend — showCost is not coming from the gate').toBeNull();
	});

	it('…and shown for a tenant admin (non-vacuity: the cost line really renders)', async () => {
		roles.current = ['member', 'tenant_admin'];
		await mountBuild();
		expect(quota(), 'the cost line never rendered even for an admin — the member case proves nothing').toBeTruthy();
	});

	it('⛔ the app sidebar is collapsed by an override while /build is mounted, and released on leave', async () => {
		sidebar.clearOverride();
		await mountBuild();
		expect(sidebar.override, '/build did not ask the shell for the width').toBe(true);
		unmount(component!);
		component = null;
		flushSync();
		expect(sidebar.override, 'leaving /build left the sidebar override behind on every other page').toBeNull();
	});
});

describe('/build below 1024px is read-only everywhere, not only on the canvas', () => {
	it('⛔ the assistant, the title, Submit and Undo/Redo are closed at 900px on the reader’s OWN flow; Test run is not', async () => {
		setWidth(900);
		await mountBuild();
		expect(target.querySelector('[data-testid="narrow-note"]'), 'the page never went narrow').toBeTruthy();
		expect(composer(), 'no assistant composer rendered').toBeTruthy();
		expect(composer()!.disabled, 'the assistant could still apply changes at narrow width').toBe(true);
		expect(title()!.readOnly, 'the title was editable at narrow width').toBe(true);
		expect(button(m.build_submit_solution())?.disabled, 'Submit was live at narrow width').toBe(true);
		expect(
			[...topbar()!.querySelectorAll<HTMLButtonElement>('.btn-icon')].map((b) => b.disabled)
		).toEqual([true, true]);
		// Allowed on purpose: a test run executes the SAVED graph and writes nothing to the flow.
		expect(button(m.build_test_run())?.disabled, 'Test run was taken away at narrow width').toBe(false);
	});

	it('⛔ nothing saves at 900px, even through a bypass of the readonly title', async () => {
		setWidth(900);
		await mountBuild();
		const input = title()!;
		input.value = 'Renamed on a phone';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		await pastAutosave();
		expect(writes.filter((w) => w.startsWith('PATCH')), 'a narrow-screen edit reached the wire').toEqual([]);
	});

	it('…while the same flow at 1440px is fully editable (non-vacuity)', async () => {
		await mountBuild();
		expect(target.querySelector('[data-testid="narrow-note"]')).toBeNull();
		expect(composer()!.disabled).toBe(false);
		expect(title()!.readOnly).toBe(false);
		const input = title()!;
		input.value = 'Renamed at a desk';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		await pastAutosave();
		expect(writes.filter((w) => w === 'PATCH /api/flows/f1')).toHaveLength(1);
	});
});

describe('/build palette clicks place each new block on its own spot', () => {
	it('⛔ two quick clicks on a tile do not stack the two new blocks on one coordinate', async () => {
		await mountBuild();
		const tile = target.querySelector(`[data-block-slug="${SLUG}"]`) as HTMLElement | null;
		expect(tile, 'no palette tile to click').toBeTruthy();
		// Both clicks land before the first block fetch resolves — the position used to be computed
		// at CLICK time from `nodes.length`, so both read the same count and the same coordinate.
		tile!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		tile!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		await settle();
		const nodes = [...target.querySelectorAll<HTMLElement>('.svelte-flow__node')];
		expect(nodes, 'the two clicks did not both add a block').toHaveLength(3);
		const spots = new Set(nodes.map((n) => n.style.transform));
		expect(spots.size, `blocks share a position: ${[...spots].join(' | ')}`).toBe(3);
	});
});
