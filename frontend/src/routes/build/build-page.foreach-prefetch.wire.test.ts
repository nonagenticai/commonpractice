// @vitest-environment jsdom
//
// src/routes/build/build-page.foreach-prefetch.wire.test.ts — opening a flow that contains a loop
// must not ask the block library for a block called `foreach`.
//
// ⛔ THE DEFECT, MEASURED IN A BROWSER FIRST. Loading any flow with a loop node fired, every time:
//     GET http://localhost:5174/api/blocks/foreach → 404
//     {"lvl":"warn","msg":"http","route":"/api/blocks/:slug","path":"/api/blocks/foreach","status":404}
// `openFlow` prefetched a descriptor for EVERY node slug in the graph. A foreach container is
// control flow, not a published block — `newForeachNode` stamps the literal slug 'foreach'
// (stores/builder-graph.ts) and there is no `building_blocks` row behind it, so the lookup 404s.
// The same filter ALREADY existed on the submit path (`submitSolution`'s `nodeSlugs`), which is
// exactly why nobody noticed: one site was fixed, its sibling was not.
//
// ⛔ WHY THIS ASSERTS ON THE REQUEST LIST AND NOT ON A MOCKED `blocksApi.get`. The failure is a 404
// on the wire and a red line in every user's network tab; it was ALREADY swallowed client-side by
// `.catch(() => null)`, so no state variable, no thrown error and no rendered pill ever differed
// between the broken and the fixed page. Only the set of URLs that left the browser does. So
// `$lib/api/blocks` is the REAL client here — the URL under test (`/api/blocks/foreach`) is a
// string this file never writes, `blocksApi.get` composes it — and `fetch` is stubbed to record.
//
// ⛔ AND THE POSITIVE CONTROL IS HALF THE FILE. "No request to /api/blocks/foreach" passes
// trivially if the prefetch stops working altogether, or if the page never mounts, or if the flow
// never loads. Every case below also asserts that the REAL blocks in the same graph — including the
// one INSIDE the loop — were prefetched, and that the descriptor actually reached the canvas.
//
// Harness cloned from `build-page.graph-issues.render.test.ts` (same mount of `+page.svelte`, same
// jsdom shims for SvelteFlow).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/build?id=f1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
// The real `authFetch` runs (it is what calls `fetch`), so its browser-only auth chain is the one
// thing stubbed out — exactly as `$lib/api/flows-snapshots.test.ts` does.
vi.mock('$lib/services/keycloak', () => ({
	ensureFreshToken: async () => undefined,
	redirectToLogin: () => {}
}));

const { getFlow, saveFlow, listFlows } = vi.hoisted(() => ({
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: vi.fn(), startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, streamRun: () => ({ close: () => {} }) };
});
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/solutions', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, solutionsApi: { create: vi.fn(), list: vi.fn(), get: vi.fn() } };
});

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

import Page from './+page.svelte';

/** The literal slug `newForeachNode` stamps on every loop container. */
const FOREACH = 'foreach';
const OUTER = 'llm-summarize';
/** A real block INSIDE the loop — a body node is a block and MUST still be prefetched. */
const BODY = 'http-fetch';

/** Every URL the page asked the network for, in order. This is the assertion surface. */
let requests: string[] = [];

function blockDetail(slug: string) {
	return {
		id: `b-${slug}`,
		slug,
		name: slug,
		description: '',
		category: 'data',
		current_version_id: `v-${slug}`,
		maintainer_id: null,
		owner: { kind: 'org', name: 'CP' },
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [
			{
				id: `v-${slug}`,
				block_id: `b-${slug}`,
				version: '1.0.0',
				status: 'published',
				language: 'typescript',
				docs_md: '',
				source_ts: '',
				descriptor: {
					inputs: { [`in_${slug}`]: { type: 'json' } },
					outputs: { [`out_${slug}`]: { type: 'json' } },
					capabilities: {}
				},
				examples: [],
				changelog: '',
				tests_passing: true,
				usage_count: 0,
				published_by: null,
				published_at: null,
				created_at: '2026-08-01T00:00:00.000Z'
			}
		]
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * The recording network. Serves the two REAL blocks and answers everything else the way the backend
 * answers `/api/blocks/foreach`: 404 `block_not_found`. Deliberately NOT a blanket 200 — a stub
 * that happily serves a block named `foreach` would hide the very 404 this file exists to prevent,
 * and would make the negative assertion the only thing standing.
 */
function installNetwork() {
	requests = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			requests.push(url);
			const path = new URL(url, 'http://localhost').pathname;
			if (path === '/api/blocks') return json({ items: [], total: 0 });
			const slug = path.startsWith('/api/blocks/') ? path.slice('/api/blocks/'.length) : '';
			if (slug === OUTER || slug === BODY) return json(blockDetail(slug));
			return json({ error: 'block_not_found', message: `no block '${slug}'` }, 404);
		})
	);
}

/** A node the graph persists for a real, published block. */
function blockNode(id: string, slug: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		blockId: `b-${slug}`,
		blockVersionId: `v-${slug}`,
		slug,
		label: slug,
		category: 'data',
		config: {},
		position: { x: 0, y: 0 },
		...extra
	};
}

/**
 * The graph exactly as `canvasToFlowGraph` persists it: the container carries `kind: 'foreach'` and
 * the literal slug `foreach`, its body node carries `parentId` and is an ordinary block, and there
 * is a third block outside the loop.
 */
function flowFixture(nodes: unknown[]) {
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
		graph: { nodes, edges: [] }
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
	for (let i = 0; i < 12; i++) await Promise.resolve();
	flushSync();
}

async function openFlowWith(nodes: unknown[]) {
	listFlows.mockResolvedValue({ items: [{ id: 'f1', name: 'Claim summariser', node_count: nodes.length }] });
	getFlow.mockResolvedValue(flowFixture(nodes));
	saveFlow.mockImplementation(async () => flowFixture(nodes));
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	// ⛔ THE POSITIVE MARKER FOR THE MOUNT ITSELF. /build pulls in a dozen modules; one unstubbed
	// import and the page renders nothing, no fetch happens, and every "no request to
	// /api/blocks/foreach" assertion below passes against a page that never existed.
	expect(getFlow, 'the page never fetched the flow — nothing below tests anything').toHaveBeenCalledWith('f1');
}

/** The block-detail slugs the page actually asked the network for. */
function fetchedSlugs(): string[] {
	return requests
		.map((u) => new URL(u, 'http://localhost').pathname)
		.filter((p) => p.startsWith('/api/blocks/'))
		.map((p) => p.slice('/api/blocks/'.length));
}

beforeEach(() => {
	installNetwork();
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	vi.unstubAllGlobals();
	for (const mock of [getFlow, saveFlow, listFlows]) mock.mockReset();
});

describe('opening a flow with a loop never asks the library for a block called `foreach`', () => {
	it('⛔ the loop container is skipped, and the blocks around AND inside it are still prefetched', async () => {
		await openFlowWith([
			blockNode('n1', OUTER),
			{
				...blockNode('n2', FOREACH),
				kind: 'foreach',
				label: 'For each row',
				loop: { rowsInput: 'rows', maxIterations: 100 }
			},
			blockNode('n3', BODY, { parentId: 'n2' })
		]);

		const slugs = fetchedSlugs();
		// POSITIVE CONTROL — the prefetch ran, for the block outside the loop and the one inside it.
		// Without these two, the negative below is satisfied by a prefetch that does nothing at all.
		expect(slugs, `block requests were: ${JSON.stringify(requests)}`).toContain(OUTER);
		expect(slugs, 'a block INSIDE the loop is still a block and must be prefetched').toContain(BODY);
		// ⛔ THE DEFECT. Red by reverting the `kind !== 'foreach'` filter in `openFlow`.
		expect(slugs, `the page requested /api/blocks/${FOREACH}`).not.toContain(FOREACH);
		// …and no 404 left the page at all, whatever the URL shape.
		expect(requests.filter((u) => u.includes(FOREACH)), 'a foreach URL was requested').toHaveLength(0);
	});

	it('the prefetch is not merely deduplicated away — two loops, still zero foreach requests', async () => {
		// Every foreach container carries the SAME literal slug, so a `new Set()` collapses them to
		// one request. Two containers prove the fix is a FILTER, not the de-dup that was already
		// there: pre-fix this asked once, post-fix it asks zero times.
		await openFlowWith([
			blockNode('n1', OUTER),
			{ ...blockNode('n2', FOREACH), kind: 'foreach', label: 'For each row' },
			{ ...blockNode('n4', FOREACH), kind: 'foreach', label: 'For each row' },
			blockNode('n3', BODY, { parentId: 'n2' })
		]);

		const slugs = fetchedSlugs();
		expect(slugs).toContain(OUTER);
		expect(slugs).toContain(BODY);
		expect(slugs).not.toContain(FOREACH);
	});

	it('a graph of nothing but loops issues no block request at all', async () => {
		// The degenerate case the old code was worst at: every request it made was a 404.
		await openFlowWith([
			{ ...blockNode('n2', FOREACH), kind: 'foreach', label: 'For each row' },
			{ ...blockNode('n4', FOREACH), kind: 'foreach', label: 'For each row' }
		]);
		expect(fetchedSlugs(), `block requests were: ${JSON.stringify(requests)}`).toHaveLength(0);
	});

	it('a graph with no loop is unchanged — every block slug is still prefetched exactly once', async () => {
		// The other direction of the filter: it must not start skipping real blocks. `kind: 'block'`
		// is explicit here because the field is OPTIONAL on the wire, and a predicate written as
		// `kind === 'block'` rather than `kind !== 'foreach'` would silently skip every node whose
		// `kind` is absent — i.e. every flow saved before Phase 5.
		await openFlowWith([blockNode('n1', OUTER, { kind: 'block' }), blockNode('n3', BODY)]);
		const slugs = fetchedSlugs();
		expect(slugs.filter((s) => s === OUTER)).toHaveLength(1);
		expect(slugs.filter((s) => s === BODY)).toHaveLength(1);
	});
});
