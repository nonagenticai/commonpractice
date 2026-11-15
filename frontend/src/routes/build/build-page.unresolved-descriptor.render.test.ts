// @vitest-environment jsdom
//
// src/routes/build/build-page.unresolved-descriptor.render.test.ts — a node whose descriptor never
// arrived must say its ports are UNKNOWN, not draw itself as a block that has none.
//
// ⛔ THE DEFECT. `openFlow` prefetches every referenced block with
// `ensureBlock(s).catch(() => null)` — deliberately swallowing, because one archived block must not
// abort the whole load — and `resolveDescriptor` then answered the resulting `blockCache` MISS with
// `EMPTY_DESC`, `{inputs:{}, outputs:{}, capabilities:{}}`. That is the exact shape of a block that
// genuinely declares no ports. So a 500, a block archived since the flow was saved, or a dropped
// connection loaded that node with NO PORTS, silently, forever, while the flow reported a clean load.
//
// ⛔ AND THE CONSEQUENCE IS DATA LOSS THE READER PERFORMS, WHICH IS WHY IT NEVER READ AS A BUG.
// Verified against `@xyflow/svelte@1.6.0`: SvelteFlow does NOT prune edges. `edges = $bindable([])`
// is a pass-through accessor pair (`container/SvelteFlow/SvelteFlow.svelte:73–94`); the
// handle-driven filtering happens only in the `$derived` `getLayoutedEdges`
// (`store/visibleElements.js:9–70`), which omits the edge from the RENDERED map and never writes
// back to `signals.edges`. Its complaint — error 008 — goes to `devWarn`, gated on
// `NODE_ENV === 'development'`, i.e. invisible in production. The edge STILL SAVES and simply
// VANISHES FROM THE SCREEN; the author, seeing a disconnected node, re-draws or deletes it.
// Case (c) below is the executable form of that finding, and it is GREEN by design.
//
// ⛔ THE `.catch` STAYS. This file must never be "fixed" by letting the rejection through: the outer
// catch in `openFlow` deliberately tears the builder down (`hydrated = false`, `flow = null`) to
// prevent a cross-flow write, so one archived block would take the entire builder with it. Case (b)
// is the guard — the flow, and the block that DID resolve, must still be fully there.
//
// ⛔ REAL `$lib/api/blocks`, REAL `Response`. Only `$lib/api/auth-fetch` is mocked (same harness as
// `build-page.add-block-failure.render.test.ts`): a hand-built rejection proves nothing about the
// shape the product actually throws — see `src/lib/api/error-message.wire.test.ts`.
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

const OK = 'ok-block';
const GONE = 'gone-block';
/** The isolate the page wraps a slug in before interpolation — see graph-issue-label.ts's `iso`. */
const ISO = (v: string) => `⁨${v}⁩`;

/** `GET /api/blocks/gone-block`. Flipped to 200 by the retry case. */
let goneReply: { status: number; body: unknown } = { status: 500, body: null };
let goneCalls = 0;
/** Every `PATCH /api/flows/f1` body the autosave sent. */
let savedGraphs: { nodes: unknown[]; edges: { id: string; source: string; target: string }[] }[] = [];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function paletteItem(slug: string) {
	return {
		slug,
		name: slug,
		description: 'A block',
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

/** A block detail whose current version declares exactly the ports named here. */
function blockDetail(slug: string, inputs: string[], outputs: string[]) {
	const ports = (names: string[]) =>
		Object.fromEntries(names.map((n) => [n, { type: 'json' }])) as Record<
			string,
			{ type: string }
		>;
	return {
		id: `b_${slug}`,
		slug,
		name: slug,
		description: 'A block',
		category: 'data',
		current_version_id: `v_${slug}`,
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
				id: `v_${slug}`,
				block_id: `b_${slug}`,
				version: '1.0.0',
				status: 'stable',
				language: 'typescript',
				docs_md: '',
				source_ts: '',
				descriptor: { inputs: ports(inputs), outputs: ports(outputs), capabilities: {} },
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

/** ok-block → gone-block. One edge, and it is the one the reader loses. */
function twoNodeFlow() {
	const node = (id: string, slug: string, x: number) => ({
		id,
		blockId: `b_${slug}`,
		blockVersionId: `v_${slug}`,
		slug,
		label: slug,
		category: 'data',
		config: {},
		position: { x, y: 100 }
	});
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
		graph: {
			nodes: [node('n_ok', OK, 100), node('n_gone', GONE, 420)],
			edges: [
				{ id: 'e_ok_gone', source: 'n_ok', sourceHandle: 'summary', target: 'n_gone', targetHandle: 'rows' }
			]
		}
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** The rendered canvas node whose header names this slug. */
function canvasNode(slug: string): HTMLElement | null {
	return (
		([...target.querySelectorAll('.svelte-flow__node')] as HTMLElement[]).find(
			(n) => n.querySelector('.cp-node-name')?.textContent?.trim() === slug
		) ?? null
	);
}
/** The port NAMES that node draws (the `.pname` spans), i.e. what the reader can wire to. */
function portNames(slug: string): string[] {
	const node = canvasNode(slug);
	expect(node, `no canvas node for “${slug}” — this assertion would test nothing`).toBeTruthy();
	return ([...node!.querySelectorAll('.pname')] as HTMLElement[]).map((e) => e.dataset.port ?? '');
}
const pill = () =>
	target.querySelector('[data-testid="descriptor-unavailable"]') as HTMLElement | null;

/** The node count the BUILDER sees, read off the topbar's `data-node-count`. */
function nodeCountText(): string {
	const path = target.querySelector('.path') as HTMLElement | null;
	expect(path, 'the Build topbar never rendered — this file would test nothing').toBeTruthy();
	// The visible "N blocks" text is gone from the topbar; the count rides on `data-node-count`.
	const n = path!.dataset.nodeCount;
	expect(n, 'the topbar carries no node count').toMatch(/^\d+$/);
	return `nodes:${n}`;
}

/** A real `drop` on the canvas — the cheapest genuine reader EDIT, which is what arms the autosave. */
function dropTile(slug: string) {
	const canvas = target.querySelector('[data-cp-canvas]') as HTMLElement | null;
	expect(canvas, 'the canvas never rendered').toBeTruthy();
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
	goneCalls = 0;
	savedGraphs = [];
	goneReply = { status: 500, body: { error: 'internal_error' } };
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		if (method === 'GET' && url === `/api/blocks/${OK}`)
			return json(blockDetail(OK, ['rows'], ['summary']));
		if (method === 'GET' && url === `/api/blocks/${GONE}`) {
			goneCalls++;
			return json(goneReply.body ?? blockDetail(GONE, ['rows'], ['result']), goneReply.status);
		}
		if (method === 'GET' && url.startsWith('/api/blocks?'))
			return json({ items: [paletteItem(OK), paletteItem(GONE)], total: 2 });
		if (method === 'GET' && url.startsWith('/api/flows/f1')) return json(twoNodeFlow());
		if (method === 'GET' && url.startsWith('/api/flows'))
			return json({ items: [{ id: 'f1', name: 'Claim summariser', node_count: 2 }], total: 2 });
		if (method === 'PATCH' && url.startsWith('/api/flows/f1')) {
			const body = JSON.parse(String(init.body ?? '{}')) as { graph?: (typeof savedGraphs)[number] };
			if (body.graph) savedGraphs.push(body.graph);
			return json({ ...twoNodeFlow(), graph: body.graph });
		}
		if (method === 'PATCH' || method === 'PUT') return json(twoNodeFlow());
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
	// ⛔ POSITIVE MARKERS. /build mounts a dozen modules; without these, "the ports are missing" and
	// "no pill is shown" both pass against a DOM that never rendered anything at all.
	expect(nodeCountText(), 'the two-node flow never reached the canvas').toBe('nodes:2');
	expect(goneCalls, 'the prefetch never asked for the failing block').toBe(1);
}

/** The sentence the pill must carry, built exactly the way the page builds it. */
const EXPECTED_PILL = () =>
	m.build_descriptors_unavailable({ count: 1, slugs: ISO(GONE) });

describe('/build admits when a node’s descriptor could not be loaded', () => {
	it('⛔ THE DEFECT (a): a 500 on one block loads a portless node and says nothing', async () => {
		await mountBuild();

		// The pill exists and NAMES the block, bidi-isolated, with a retry the reader can press.
		expect(pill(), 'a block loaded with unknown ports and the canvas said nothing').toBeTruthy();
		expect(pill()!.textContent).toContain(EXPECTED_PILL());
		expect(pill()!.textContent, 'the pill does not name the block that failed').toContain(GONE);
		expect(
			pill()!.querySelector('button')?.textContent?.trim(),
			'the notice offers no way back — `loadPalette`’s precedent is a retry, not a page reload'
		).toBe(m.error_load_retry());

	});

	it('⛔ THE DEFECT (a2): and the NODE draws the `—` that means “this block has no ports”', async () => {
		// Its own case, not an assertion tacked onto (a), because these are two separate lies and a
		// fix could plausibly land only one of them: the pill is the NOTICE, this is the node itself
		// telling the author — on the canvas they are actually looking at — that a block whose
		// descriptor never arrived declares no inputs and no outputs.
		//
		// Zero `<Handle>`s is CORRECT and is NOT what this asserts: there are genuinely none to draw,
		// and inventing handles for ports we do not know the names of would fabricate a graph. What
		// has to change is the CLAIM.
		await mountBuild();

		const gone = canvasNode(GONE);
		expect(gone, 'the failing node never rendered — this case would test nothing').toBeTruthy();
		expect(gone!.textContent, 'the node says nothing about its ports being unknown').toContain(
			m.build_node_ports_unavailable()
		);
		expect(
			gone!.querySelector('.port.empty.unresolved')?.getAttribute('title'),
			'the short label has to fit a 190px node, so the explanation lives in its title'
		).toBe(m.build_node_ports_unavailable_title());
		expect(
			[...gone!.querySelectorAll('.port.empty')].map((e) => e.textContent!.trim()),
			'the node still renders the “no ports” dash — the statement that was false'
		).not.toContain('—');
		// …and the placeholder is still the honest one for a block that really declares no ports:
		// nothing here may turn every portless block on every canvas amber.
		expect(canvasNode(OK)!.querySelector('.port.empty.unresolved')).toBeNull();
	});

	it('(b) POSITIVE CONTROL: the block that DID resolve is fully drawn', async () => {
		// ⛔ THE `.catch` MUST SURVIVE THE FIX. Removing it so the rejection propagates would send
		// `openFlow` into its outer catch, which sets `hydrated = false` and `flow = null` — one
		// archived block would take the whole builder down. If that regression lands, this case goes
		// red first: there would be no canvas nodes and no ports at all.
		await mountBuild();

		expect(portNames(OK).sort(), 'the healthy block lost its ports too — the load simply failed').toEqual(
			['rows', 'summary']
		);
		expect(canvasNode(OK)!.textContent).not.toContain(m.build_node_ports_unavailable());
		expect(target.textContent, 'the whole load was reported as failed').not.toContain(
			'build_boot_error'
		);
	});

	it('(c) CHARACTERIZATION LOCK: the edge is still SAVED — xyflow un-draws, it does not prune', async () => {
		// ⛔ GREEN TODAY, BY DESIGN, AND IT IS THE POINT OF THE WHOLE FILE. This is the executable
		// form of the `@xyflow/svelte@1.6.0` finding: `bind:edges` is a pass-through, the
		// handle-driven filter lives in the `$derived` `getLayoutedEdges` and writes back nothing, so
		// the edge whose target handle no longer exists stays in `signals.edges` and therefore in
		// every autosave. That is precisely why the defect is invisible AND destructive: the reader
		// sees a disconnected node over a graph that is perfectly intact, and repairs it by hand.
		//
		// ⚠️ IF THIS GOES RED ON AN `@xyflow/svelte` UPGRADE, DO NOT DELETE IT. It means the library
		// has started pruning, the loss moved from the reader's hands into the autosave, and the
		// `descriptorUnavailable` notice is no longer sufficient — the page would have to stop
		// saving while a descriptor is unresolved.
		await mountBuild();

		// An ordinary edit while the descriptor is still missing: drop another block. This is what
		// arms the 800 ms autosave — a flow that is merely OPEN never writes.
		dropTile(OK);
		await settle();
		expect(nodeCountText(), 'the edit never landed — nothing would trigger an autosave').toBe(
			'nodes:3'
		);

		// Let the real 800 ms debounce elapse.
		await new Promise((r) => setTimeout(r, 900));
		await settle();

		expect(savedGraphs.length, 'the autosave never fired — this case asserts nothing').toBeGreaterThan(0);
		const saved = savedGraphs.at(-1)!;
		expect(
			saved.edges.map((e) => e.id),
			'the edge touching the unresolved node was dropped from the SAVED graph'
		).toContain('e_ok_gone');
		expect(saved.edges.find((e) => e.id === 'e_ok_gone')).toMatchObject({
			source: 'n_ok',
			target: 'n_gone'
		});
		// …and the flag itself never reaches the wire.
		expect(JSON.stringify(saved)).not.toContain('descriptorUnavailable');
	});

	it('(d) RETRY patches the canvas in place: the ports appear and the pill goes', async () => {
		await mountBuild();
		expect(pill()).toBeTruthy();
		expect(portNames(GONE), 'precondition: the failing node has no ports to show').toEqual([]);

		// An in-session edit the reader has NOT saved yet — the thing a re-`load` would destroy.
		dropTile(OK);
		await settle();
		expect(nodeCountText(), 'the edit never landed — the reload guard below would be vacuous').toBe(
			'nodes:3'
		);

		// The block is reachable again.
		goneReply = { status: 200, body: null };
		pill()!.querySelector('button')!.click();
		await settle();
		await settle();

		expect(goneCalls, 'the retry never re-asked for the block').toBe(2);
		expect(portNames(GONE).sort(), 'the retry resolved nothing on the canvas').toEqual([
			'result',
			'rows'
		]);
		expect(canvasNode(GONE)!.textContent).not.toContain(m.build_node_ports_unavailable());
		expect(pill(), 'the notice outlived the failure it describes').toBeNull();
		// ⛔ AND THE READER'S GRAPH IS STILL THERE. A retry implemented as a re-`load` would refetch
		// the persisted flow and throw away every edit made since — a worse loss than the one the
		// notice exists to prevent. The healthy node is untouched and the edge is still on the canvas.
		expect(
			nodeCountText(),
			'the retry re-loaded the flow and discarded the reader’s unsaved edit'
		).toBe('nodes:3');
		expect(portNames(OK).sort()).toEqual(['rows', 'summary']);
	});
});
