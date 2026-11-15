// @vitest-environment jsdom
//
// src/routes/build/build-page.readonly.render.test.ts — /build must not offer a canvas it cannot
// save.
//
// ⛔ THE DEFECT, END TO END. `GET /api/flows/:id` answers `readOnly: true` when the caller is not
// the owner and is seeing the flow only because it backs a published solution — which is exactly
// what "Open in Build" on a solution page does, and exactly what the permalink `BuildTopbar`'s
// Share button hands out. The frontend read none of it: `flowsApi.get` did not type the field and
// no component in `src/routes` mentioned it. So a visitor got a live palette, a draggable canvas, a
// live copilot and a live Submit; the first edit armed the 800 ms autosave; `PATCH /api/flows/:id`
// went through `loadOwnedFlow` and answered 404; "Opslaan mislukt" pinned itself in the breadcrumb
// for the rest of the session, and everything they had built was gone on reload.
//
// ⛔ THE ASSERTION THAT MATTERS IS `PATCH` COUNT, NOT THE BANNER. Every affordance below (a disabled
// button, a non-draggable tile, a `readonly` title) can be worked around — a keyboard activation, a
// stale debounce armed before the load resolved, the AI panel. The property is that NOTHING the
// reader does reaches the wire, so the drive here deliberately BYPASSES the affordance: the title
// input is `readonly` in the DOM and this test dispatches a `change` on it anyway, which is
// precisely what a keyboard user, an autofill extension or a future refactor would produce. That
// call path — `rename()` → `builder.flow.name = …` → the autosave `$effect` → `doSave()` — is the
// one `doSave`'s own guard has to stop.
//
// ⚠️ THE OWNER CASE IS DRIVEN IDENTICALLY, AND IT IS NOT A COURTESY. "Zero PATCHes" is what a page
// that never boots also reports. The same gesture against `readOnly: false` must produce exactly
// one PATCH, or the read-only assertion is measuring a dead harness rather than a working gate.
//
// ⚠️ REAL TIMERS, NOT `vi.useFakeTimers()`. /build runs a 1 s `setInterval` for the "saved N s ago"
// clock, a 350 ms history debounce and the 800 ms autosave, and the SvelteFlow mount schedules its
// own work; faking the clock here means choosing which of those to advance and getting it wrong
// silently. One 900 ms wait per case is cheaper than that risk.
//
// Harness copied from `build-page.palette-load-failure.render.test.ts` — same `authFetch`-only
// stub, same jsdom shims, same `settle()`.
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
	readOnlyReply = true;
	blockDetailFails = false;
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

/** The bypass drive: rename through the DOM event a `readonly` input cannot raise on its own. */
async function driveRename(to: string) {
	const input = title()!;
	input.value = to;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
	await pastAutosave();
}

describe('/build over a flow the reader does not own', () => {
	it('⛔ THE DEFECT: an edit reaches `PATCH /api/flows` and is lost', async () => {
		await mountBuild();
		await driveRename('Renamed by a visitor');

		expect(
			writes.filter((w) => w.startsWith('PATCH /api/flows')),
			'a visitor’s edit was put on the wire, where `loadOwnedFlow` throws it away'
		).toEqual([]);
		// Nothing else wrote either — no run start, no solution.
		expect(writes, 'the page wrote to the API on a flow it may not change').toEqual([]);
	});

	it('…and the same gesture on the reader’s OWN flow DOES save', async () => {
		// ⛔ THE NON-VACUITY HALF. Without it, deleting the whole page would pass the case above.
		readOnlyReply = false;
		await mountBuild();
		expect(notice(), 'the owner was told the flow is not theirs').toBeNull();
		await driveRename('Renamed by its owner');

		expect(
			writes.filter((w) => w === 'PATCH /api/flows/f1'),
			'the autosave never fired even for the owner — the read-only case proves nothing'
		).toHaveLength(1);
	});

	it('the banner names the situation, once, in the pill stack', async () => {
		await mountBuild();
		const el = notice();
		expect(el, 'a read-only canvas said nothing about being read-only').toBeTruthy();
		expect(el!.textContent).toContain(m.build_readonly_notice());
		// `role="status"`, not `alert`: the flow loaded perfectly; the only news is who owns it.
		expect(el!.getAttribute('role')).toBe('status');
		expect(target.querySelectorAll('[data-testid="readonly-notice"]')).toHaveLength(1);
	});

	it('the breadcrumb stops promising a save that cannot happen', async () => {
		await mountBuild();
		expect(topbar()!.textContent, 'the save indicator still narrated an autosave').toContain(
			m.build_save_readonly()
		);
		expect(topbar()!.textContent).not.toContain(m.build_save_unsaved());
		expect(topbar()!.textContent).not.toContain(m.build_save_failed());
	});

	it('Submit, Test run, Undo and Redo are disabled; Share and New flow are not', async () => {
		await mountBuild();
		expect(button(m.build_submit_solution())?.disabled, 'Submit was live').toBe(true);
		expect(button(m.build_test_run())?.disabled, 'Test run was live').toBe(true);
		expect(
			[...topbar()!.querySelectorAll<HTMLButtonElement>('.btn-icon')].map((b) => b.disabled)
		).toEqual([true, true]);

		// ⚠️ THE WAY OUT STAYS OPEN, DELIBERATELY. A visitor's repair is to start their own flow, and
		// the permalink is exactly what they were handed. Disabling these would leave a dead topbar.
		expect(button(m.build_share())?.disabled, 'Share was withdrawn from a visitor').toBe(false);
		expect(button(m.build_new_flow())?.disabled, '"New flow" was withdrawn from a visitor').toBe(
			false
		);
	});

	it('the title is readable and copyable but not writable', async () => {
		await mountBuild();
		// `readonly`, not `disabled`: a disabled input greys its own text and leaves the tab order,
		// hiding the one thing a visitor came to read.
		expect(title()!.readOnly, 'the title accepted edits').toBe(true);
		expect(title()!.disabled, 'the title was disabled rather than made read-only').toBe(false);
		expect(title()!.value).toBe('Claim summariser');
	});

	it('the palette still LISTS the library but no longer offers to add from it', async () => {
		await mountBuild();
		const tile = target.querySelector(`[data-block-slug="${SLUG}"]`) as HTMLElement | null;
		expect(tile, 'the palette was emptied instead of made inert').toBeTruthy();
		expect(tile!.textContent, 'the block name went with it').toContain('Load dataset');
		expect(tile!.getAttribute('draggable')).toBe('false');
		expect(tile!.getAttribute('aria-disabled')).toBe('true');

		// Both non-drag entry points are refused: the click and the keyboard activation. A tile that
		// dropped only `draggable` would leave these two live — the mirror of the WCAG defect
		// `BlockPalette`'s own `activate` comment records.
		const before = blockDetailCalls;
		tile!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		tile!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		await pastAutosave();
		expect(blockDetailCalls, 'a tile activation started an add on a read-only canvas').toBe(before);
		expect(writes).toEqual([]);
	});

	/**
	 * Put ONE undo step on a read-only canvas's history stack, the way a real visit does.
	 *
	 * ⛔ THE STACKS ARE NOT EMPTY ON A READ-ONLY VISIT, WHICH IS THE WHOLE REACHABILITY ARGUMENT.
	 * `BuilderStore.resolveSlug` is deliberately ungated — a descriptor arriving late repairs the
	 * RENDER of a node already on screen, and gating it would leave that node permanently portless.
	 * So it reassigns `builder.nodes`, /build's recorder `$effect` snapshots that like any other
	 * change, and `undoStack` now holds the PORTLESS graph. The topbar comment that used to claim
	 * "nothing can have been edited, so both stacks are empty for the whole visit" was wrong here.
	 *
	 * Leaves the canvas resolved (ports `in` + `out`) with exactly one step to undo.
	 */
	async function armOneUndoStep() {
		blockDetailFails = true;
		await mountBuild();
		expect(pill(), 'the unresolved-blocks pill never rendered — there is no retry to click').toBeTruthy();
		expect(portNames(), 'precondition: the node resolved anyway, so nothing will change').toEqual([]);

		blockDetailFails = false;
		pill()!.querySelector('button')!.click();
		await settle();
		await settle();
		expect(portNames(), 'the retry resolved nothing — there is no history step to undo').toEqual([
			'in',
			'out'
		]);
		// Past the 350 ms history debounce, so the recorder has committed the portless snapshot.
		await pastAutosave();
	}

	it('⛔ D1: ⌘Z / ⌘⇧Z do not mutate a canvas the banner calls read-only', async () => {
		// The topbar's Undo/Redo buttons are `disabled` here — and `onKeydown` is wired to
		// `<svelte:window>` and reads neither them nor `builder.readOnly`. Before the fix, `undo()`
		// assigned `builder.nodes` straight from the history stack, so this keypress rolled the node
		// back to its portless state in front of a reader who is told they cannot change anything.
		await armOneUndoStep();

		press('z');
		await settle();
		expect(portNames(), 'a keyboard undo rewrote a read-only graph').toEqual(['in', 'out']);

		// Redo and its `Ctrl+Y` alias, asserted separately: pressing them AFTER the undo assertion
		// matters, because on the ungated code a redo would put the graph back and hide the defect.
		press('z', { shiftKey: true });
		press('y');
		await settle();
		expect(portNames(), 'a keyboard redo rewrote a read-only graph').toEqual(['in', 'out']);

		expect(writes, 'a keyboard undo/redo reached the wire').toEqual([]);
	});

	it('…and the OWNER’s ⌘Z / ⌘⇧Z still work — the gate must not freeze the canvas', async () => {
		// ⛔ THE CONTROL THAT FLIPS. "The graph did not change" is also what a dead keyboard handler,
		// an empty undo stack and a page that never booted all report. The identical drive against a
		// flow the caller OWNS has to move the canvas in BOTH directions, or the case above is
		// measuring nothing. A gate that freezes the owner is worse than the bug it closes.
		readOnlyReply = false;
		await armOneUndoStep();

		press('z');
		await settle();
		expect(portNames(), 'the owner’s ⌘Z did nothing — the read-only case above proves nothing').toEqual(
			[]
		);

		press('z', { shiftKey: true });
		await settle();
		expect(portNames(), 'the owner’s ⌘⇧Z did not restore the graph undo had just taken away').toEqual([
			'in',
			'out'
		]);
	});

	it('D2: the canvas offers the reader no handle to start a connection from', async () => {
		// ⚠️ THE AFFORDANCE HALF ONLY. `nodesConnectable={false}` is what stops the drag, and it is
		// the reason `onconnect` cannot be raised through the DOM here — which is also why the
		// STORE-level rule it stands in for is asserted in `builder.readonly.test.ts`
		// (`adoptConnection` takes the appended edge back out). This case exists so the prop cannot
		// be dropped silently; that file is where the invariant lives.
		await mountBuild();
		const handles = [...target.querySelectorAll('.svelte-flow__handle')];
		expect(handles.length, 'the node drew no handles at all — this assertion is vacuous').toBeGreaterThan(0);
		expect(
			handles.filter((h) => h.classList.contains('connectable')),
			'a read-only canvas offered connectable handles'
		).toHaveLength(0);
	});

	it('the copilot composer is closed — its every tool-call would be refused', async () => {
		await mountBuild();
		const composer = target.querySelector('.chat .compose') as HTMLElement | null;
		expect(composer, 'the chat panel never rendered').toBeTruthy();
		expect((composer!.querySelector('input') as HTMLInputElement).disabled).toBe(true);
		expect((composer!.querySelector('button.send') as HTMLButtonElement).disabled).toBe(true);
	});
});
