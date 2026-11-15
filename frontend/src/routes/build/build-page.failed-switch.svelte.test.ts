// @vitest-environment jsdom
//
// src/routes/build/build-page.failed-switch.svelte.test.ts — when the flow behind `?id=` cannot be
// loaded, /build must STOP BEING A BUILDER for it. It must not keep the previous flow on the canvas
// under the new flow's id.
//
// THE DEFECT, and it is a silent data-loss one. `openFlow`'s `catch` was exactly
// `bootError = errorText(...)`: it painted a pill and changed nothing else. But the URL has ALREADY
// moved by then — `selectFlow` only calls `goto()`, and the fetch is the `?id=` `$effect` REACTING
// to that — so after a failed switch the picker reads flow B while `builder.flow`, `builder.nodes`
// and `builder.edges` are still flow A's, and `builder.hydrated` is still true. The autosave
// `$effect` gates on exactly `hydrated && flow`, both of which still point at A, and `doSave` writes
// `flowsApi.save(builder.flow.id, …)`. The only thing holding it back is the unchanged-snapshot
// check — so the reader's FIRST edit, made in the belief they are editing flow B, is persisted into
// flow A 800 ms later. Nothing on screen contradicts them: the title says "Flow A" but the picker
// says "Flow B", and people read the picker they just used.
//
// ⛔ THE GET REALLY FAILS. `backend/src/routes/flows.ts` answers `404 flow_not_found` for a flow
// that is not the caller's — which is what a topbar **Share** permalink hands to anyone who is not
// the owner — and the same `catch` swallows a restart mid-session, a 402 licence trip, and a 500.
//
// It is a `.svelte.test.ts` (note the infix) so vite-plugin-svelte compiles it as a rune module:
// `?id=` is read through `page.url`, so only a `$state`-backed mock re-fires the load `$effect`,
// which is the whole causal chain this file is about. Driving `goto` would prove nothing — the page
// never reloads on `goto`, it reloads on the URL it produces.
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

// The reactive URL. Built INSIDE the factory rather than in a `vi.hoisted` block: `vi.hoisted` runs
// before this module's imports are initialized, and `$state` compiles to a call into the Svelte
// client runtime, so building it there dies on its own import. The factory runs on first import of
// `$app/state`, which is late enough — and the test reads the very same proxy back through the
// static import below.
vi.mock('$app/state', () => {
	const page = $state({ url: new URL('http://localhost/build?id=f1') });
	return { page };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getFlow, saveFlow, listFlows, listBlocks, getChallenge } = vi.hoisted(() => ({
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn(),
	getChallenge: vi.fn()
}));

vi.mock('$lib/api/runs', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, runsApi: { start: vi.fn(), startSolution: vi.fn(), get: vi.fn() } };
});
vi.mock('$lib/services/sse', () => ({ streamRun: () => ({ close: () => {} }) }));
vi.mock('$lib/api/flows', () => ({
	flowsApi: { get: getFlow, save: saveFlow, list: listFlows, create: vi.fn() }
}));
// Partial: `$lib/api/solutions` re-exports `ApiError` from here, so a bare factory breaks its import.
vi.mock('$lib/api/blocks', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		blocksApi: { list: listBlocks, get: vi.fn().mockRejectedValue(new Error('no block detail')) }
	};
});
vi.mock('$lib/api/challenges', () => ({ challengesApi: { get: getChallenge, list: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (e: unknown, fallback: string) => (e as Error)?.message ?? fallback
}));

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

import { page as navPage } from '$app/state';
import Page from './+page.svelte';

/** The mocked `page` above, typed for writing — this is the address bar. */
const nav = navPage as unknown as { url: URL };

/** A flow with two nodes, so "the canvas still holds A's graph" is visible as a node COUNT. */
function flowFixture(id: string, name: string) {
	const node = (n: string) => ({
		id: n,
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: 'load-dataset',
		label: 'Load dataset',
		category: 'data',
		config: {},
		position: { x: 0, y: 0 }
	});
	return {
		id,
		name,
		owner_id: 'u1',
		status: 'draft',
		version: '1',
		solution_id: null,
		last_saved_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		graph: { nodes: [node('n1'), node('n2')], edges: [] }
	};
}

/** A challenge that is OPEN — so nothing but the missing flow can be shutting Submit. */
function openChallenge() {
	return {
		id: 'ch-open',
		code: 'CH-284',
		title: 'Claims intake',
		description: '',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W21',
		tags: [],
		metrics: {},
		votesCount: 284,
		hasVoted: false,
		submitter: { name: 'S', initials: 'S' },
		createdAt: '2026-05-20T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		cycleClosed: false,
		solutions: [],
		similar: []
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;


/** The node count on the canvas, from the topbar's `data-node-count` (the visible "N blocks" is gone). */
function nodeCount(): string | undefined {
	return (target.querySelector('.path') as HTMLElement | null)?.dataset.nodeCount;
}

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Let the 800 ms autosave debounce elapse — the window the silent cross-flow write lands in. */
async function autosaveWindow() {
	await new Promise((r) => setTimeout(r, 900));
	await settle();
}

const picker = () => target.querySelector('select.picker') as HTMLSelectElement;
const titleInput = () => target.querySelector('input.title') as HTMLInputElement;

/**
 * Mount /build on flow A.
 *
 * ⛔ THE POSITIVE MARKER. /build mounts a dozen modules; one unstubbed import and the page renders
 * nothing, every `querySelector` answers null, and assertions phrased as "A's title is gone" pass
 * against an empty DOM. So the topbar is asserted to have rendered flow A before anything else.
 */
async function mountOnFlowA() {
	listBlocks.mockResolvedValue({ items: [] });
	listFlows.mockResolvedValue({
		items: [
			{ id: 'f1', name: 'Flow A', node_count: 2 },
			{ id: 'f2', name: 'Flow B', node_count: 0 }
		]
	});
	saveFlow.mockImplementation(async () => flowFixture('f1', 'Flow A'));
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	expect(titleInput(), 'the Build topbar never rendered — this file would test nothing').toBeTruthy();
	expect(titleInput().value).toBe('Flow A');
	expect(picker().value).toBe('f1');
}

/**
 * The switch the user makes in the picker: `selectFlow` only `goto`s, so this IS the switch.
 * Only `?id=` moves — `builderBootUrl` deliberately carries every other parameter across, and
 * `?challenge=` surviving a flow switch is the point of the Submit case below.
 */
async function switchTo(id: string) {
	const url = new URL(nav.url);
	url.searchParams.set('id', id);
	nav.url = url;
	flushSync();
	await settle();
}

/** Type a new name and blur — the topbar commits on `change`, and `+page.svelte` renames
 *  `builder.flow`, which is what arms the autosave effect. */
async function renameTo(name: string) {
	const input = titleInput();
	input.value = name;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

beforeEach(() => {
	nav.url = new URL('http://localhost/build?id=f1');
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const fn of [getFlow, saveFlow, listFlows, listBlocks, getChallenge]) fn.mockReset();
});

/** The Submit button, found by its three possible labels rather than by position. */
function submitButton(): HTMLButtonElement {
	const btn = [...target.querySelectorAll('button.btn-primary')].find((b) =>
		['build_submit_solution', 'build_submitting', 'build_submitted'].includes(
			b.textContent?.trim() ?? ''
		)
	) as HTMLButtonElement | undefined;
	expect(btn, 'the Build topbar never rendered its Submit button').toBeDefined();
	return btn!;
}

/** The topbar Undo control, found by its aria-label (the icon buttons carry no text). */
function undoButton(): HTMLButtonElement {
	const btn = [...target.querySelectorAll('button.btn-icon')].find(
		(b) => b.getAttribute('aria-label') === 'build_undo'
	) as HTMLButtonElement | undefined;
	expect(btn, 'the Build topbar never rendered its Undo button').toBeDefined();
	return btn!;
}

describe('/build after a flow load that FAILED', () => {
	it('⛔ the user’s next edit is NOT written into the flow they navigated away from', async () => {
		// f1 loads; f2 answers 404 (a Share permalink opened by a non-owner, a restart mid-session,
		// a licence trip — the `catch` cannot tell them apart and does not need to).
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			throw new Error('flow_not_found');
		});
		await mountOnFlowA();
		await switchTo('f2');
		saveFlow.mockClear();

		// The reader is looking at a picker that says "Flow B" and names their new flow.
		await renameTo('My Flow B name');
		await autosaveWindow();

		expect(
			saveFlow.mock.calls,
			'a failed switch left the autosave armed on the PREVIOUS flow: the edit the reader made ' +
				'believing they were in flow B was persisted into flow A, overwriting it.'
		).toEqual([]);
	});

	it('⛔ the topbar stops claiming to be the old flow, and the canvas stops holding its graph', async () => {
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			throw new Error('flow_not_found');
		});
		await mountOnFlowA();
		expect(nodeCount(), 'precondition: flow A is on the canvas').toBe('2');

		await switchTo('f2');

		// The picker moved because the URL moved — that is not in dispute and is asserted here only
		// so the mismatch below is a mismatch and not two agreeing nulls.
		expect(picker().value).toBe('f2');
		expect(
			titleInput().value,
			'the title still names the flow the reader left, under the id of the one they went to'
		).not.toBe('Flow A');
		expect(
			nodeCount(),
			'the canvas still holds the previous flow’s nodes under the new flow’s id'
		).toBe('0');
		// And it says so.
		expect(target.querySelector('.boot-error')?.textContent).toContain('build_boot_error');
	});

	it('the error pill CLEARS once a load succeeds — one blip must not pin it for the session', async () => {
		// `bootError` had exactly two writers, both assignments of a message: nothing ever put it
		// back to null. So a single failed switch left a coral pill over the canvas for the rest of
		// the session, including after the reader switched back to a flow that loads perfectly — at
		// which point it has stopped being a signal and become furniture.
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			throw new Error('flow_not_found');
		});
		await mountOnFlowA();
		await switchTo('f2');
		expect(target.querySelector('.boot-error'), 'precondition: the failure is on screen').toBeTruthy();

		await switchTo('f1');

		expect(titleInput().value, 'the recovery load did not happen').toBe('Flow A');
		expect(
			target.querySelector('.boot-error'),
			'the pill survived a successful load, so it no longer means anything'
		).toBeNull();
	});

	it('⛔ Submit is DEAD, not live-and-eaten — the teardown must not buy a new dead control', async () => {
		// ⛔ THE COST OF THE FIX ABOVE, IF IT STOPS HALF WAY. With no flow loaded the page passes the
		// topbar its fallbacks — `'…'`, `'draft'`, `0` — and every OTHER term of the Submit gate is
		// then false: the challenge is open, the status is not `submitted`, and `'…'` is not one of
		// the eight default flow names so even the name gate opens. Submit therefore rendered LIVE
		// over an empty canvas, and `submitSolution` opens with `if (!builder.flow) return`, so the
		// click was silently eaten. Trading a lying title for a dead button is not a fix.
		nav.url = new URL('http://localhost/build?id=f1&challenge=ch-open');
		getChallenge.mockResolvedValue(openChallenge());
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			throw new Error('flow_not_found');
		});
		await mountOnFlowA();
		// The positive marker: on a loaded flow with an open challenge this button IS live, so the
		// assertion below cannot be satisfied by a gate that is simply shut for everyone.
		expect(
			submitButton().disabled,
			'precondition: Submit is live on a loaded flow with an open challenge'
		).toBe(false);

		await switchTo('f2');

		expect(
			submitButton().disabled,
			'Submit is live with no flow behind it — the click reaches `submitSolution` and is eaten ' +
				'by its own `if (!builder.flow) return`'
		).toBe(true);
	});

	it('⛔ Undo does not resurrect the previous flow’s graph under the new flow’s id', async () => {
		// The undo stack is per-FLOW. Left standing across a failed switch, `canUndo` stays true, the
		// topbar Undo stays live, and one press repaints flow A's nodes onto a canvas whose picker
		// names flow B — re-creating precisely the two-flows-at-once confusion this file exists to
		// kill, and re-arming the autosave onto it. Hence `resetHistory()` in the teardown.
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			throw new Error('flow_not_found');
		});
		await mountOnFlowA();

		// Build one real history step on flow A, so the stack is genuinely non-empty. The loop tile
		// is in the palette unconditionally (it needs no block library), and activating it is now a
		// plain click. The recorder is debounced at 350 ms and only pushes on a real graph change.
		const foreachTile = target.querySelector('[data-foreach-tile]') as HTMLElement | null;
		expect(foreachTile, 'no loop tile in the palette to make an edit with').toBeTruthy();
		foreachTile!.click();
		await new Promise((r) => setTimeout(r, 450));
		await settle();
		expect(nodeCount(), 'the edit did not land on the canvas').toBe('3');
		expect(undoButton().disabled, 'precondition: an edit on flow A armed Undo').toBe(false);

		await switchTo('f2');

		expect(
			undoButton().disabled,
			'Undo is live after a failed switch and will repaint flow A’s graph under flow B’s id'
		).toBe(true);
	});

	it('⛔ a SUPERSEDED load’s failure does not tear down the flow that overtook it', async () => {
		// The teardown above makes a late rejection destructive in a way the old bare `bootError =`
		// was not, so the `seq` guard is load-bearing rather than tidy. The sequence is ordinary:
		// pick B, it hangs, pick C before it answers, B 404s afterwards. Without the guard that
		// answer blanks a perfectly loaded C — the canvas empties, the title goes to '…' and a coral
		// pill appears, all describing a flow the reader has already left. Same reading as the
		// `if (seq !== loadSeq) return` already guarding the SUCCESS path.
		let failB: (e: Error) => void = () => {};
		getFlow.mockImplementation(async (id: string) => {
			if (id === 'f1') return flowFixture('f1', 'Flow A');
			if (id === 'f3') return flowFixture('f3', 'Flow C');
			return new Promise((_res, rej) => (failB = rej));
		});
		await mountOnFlowA();
		await switchTo('f2'); // hangs
		await switchTo('f3'); // overtakes it and lands
		expect(titleInput().value, 'precondition: flow C is loaded').toBe('Flow C');

		failB(new Error('flow_not_found'));
		await settle();

		expect(titleInput().value, 'a stale 404 blanked the flow that superseded it').toBe('Flow C');
		expect(nodeCount()).toBe('2');
		expect(target.querySelector('.boot-error')).toBeNull();
	});

	it('⛔ THE MIRROR — a switch that SUCCEEDS still autosaves, into the flow now on screen', async () => {
		// Without this, `hydrated = false` in the catch could be reached by simply never hydrating,
		// and the autosave — the entire point of the builder — would be dead for everyone.
		getFlow.mockImplementation(async (id: string) => flowFixture(id, id === 'f1' ? 'Flow A' : 'Flow B'));
		await mountOnFlowA();
		await switchTo('f2');
		expect(titleInput().value).toBe('Flow B');
		saveFlow.mockClear();
		saveFlow.mockImplementation(async () => flowFixture('f2', 'Renamed B'));

		await renameTo('Renamed B');
		await autosaveWindow();

		expect(saveFlow).toHaveBeenCalledTimes(1);
		expect(saveFlow.mock.calls[0][0]).toBe('f2');
		expect((saveFlow.mock.calls[0][1] as { name: string }).name).toBe('Renamed B');
	});
});
