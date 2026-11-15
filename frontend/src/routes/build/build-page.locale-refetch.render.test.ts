// @vitest-environment jsdom
//
// src/routes/build/build-page.locale-refetch.render.test.ts — the builder must relocalize its
// server-localized copy when the reader switches language, WITHOUT reloading the flow they are
// editing.
//
// ⛔ WHAT WAS BROKEN. `/build` carried no `reloadOnLocaleChange` at all — it was the last screen
// holding the defect PR #318 fixed on `/blocks` and `/block-edit`. Two of its loads are localized
// SERVER-side off `Accept-Language` (`authFetch` fills that header from the live locale rune):
//   • `blocksApi.list()` in `loadPalette()` — EVERY tile name in the block palette
//     (BlockPalette.svelte:197), fetched once from `onMount`;
//   • `challengesApi.get(cid)` — the challenge title in the data panel
//     (ChallengeDataPanel.svelte:139), fetched from an `$effect` that tracks `?challenge=`.
// Switching language therefore relocalized every `m.*()` label around the canvas and left the whole
// palette and the challenge context in whatever language the builder happened to be opened in.
//
// ⚠️ WHY THE EXISTING `$effect`s DID NOT ALREADY COVER IT, since that is the "surely this works"
// objection. `authFetch` reads `getLocale()` only AFTER `await ensureFreshToken(30)`
// (auth-fetch.ts:57-64) — a later microtask, outside any effect's synchronous tracking window. No
// effect on this page ever took a dependency on the locale rune. The locale was on the wire; it was
// never a trigger.
//
// ⛔ AND THE WRONG FIX, WHICH IS WHY THE THIRD CASE EXISTS. `/build` is an EDITOR. `openFlow()` →
// `builder.load()` REPLACES `nodes`/`edges` with the server's copy, so hanging the page's whole
// load off the locale rune would silently discard every unsaved edit on the canvas — a cosmetic
// refresh turned into data loss. `/block-edit` refused the one-liner for exactly this reason. So
// the last case demands `GET /api/flows/f1` is NOT re-issued by a language switch, and it is the
// case that reds on the lazy fix rather than on the defect.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';

// Real `en` catalog, each key resolving to its own name. The CHROME is deliberately not the subject
// here — this file is about the API-fetched content no message catalog can reach.
//
// ⚠️ WITH A KEY-NAME FALLBACK FOR KEYS THE CATALOG DOES NOT YET CARRY, and that is not laxity.
// `messages/*.json` is merged on its own cadence, so a key added by an in-flight change lands in
// the components before it lands in `en.json` — and a catalog-only mock answers `undefined`, which
// crashes /build at mount (`SvelteFlowProvider` reads `flowControlsAria()` during construction).
// That failure says nothing about locales; it just makes this file red for someone else's reason.
// Every key still resolves to its own NAME either way, so no assertion below can be satisfied by a
// coincidence of English prose.
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
	// ⛔ `then`, `default` and every symbol MUST fall through untouched. A blanket trap makes the
	// module namespace look THENABLE, and `await import()` then calls the fabricated `then()` and
	// hangs forever — the suite never terminates, with no failure to read. Measured here.
	const passthrough = new Set(['then', 'default', '__esModule']);
	// ⚠️ `has` too: vitest validates every named import against the mock's OWN keys before any `get`
	// runs, so a `get`-only trap still fails with "No <key> export is defined on the mock".
	return new Proxy(mod, {
		get: (t, k) =>
			typeof k === 'string' && !passthrough.has(k) ? (t[k] ?? (() => k)) : Reflect.get(t, k),
		has: (t, k) => (typeof k === 'string' && !passthrough.has(k) ? true : Reflect.has(t, k))
	});
});

// ⚠️ BOTH parameters are in the mocked URL: `?id=` gives the page a flow to edit (the thing that
// must NOT be reloaded) and `?challenge=` gives it the second localized fetch.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/build?id=f1&challenge=ch-1') }
}));
const CH_ID = 'ch-1';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// ⛔ `$lib/i18n/reload-on-locale.svelte` IS **NOT** MOCKED HERE, unlike every sibling /build render
// test. That helper is the subject; stubbing it to a no-op — which is what the siblings do so their
// own fetch counts stay stable — would make every assertion below vacuous.

const { getChallenge, getFlow, saveFlow, listFlows, listBlocks } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getFlow: vi.fn(),
	saveFlow: vi.fn(),
	listFlows: vi.fn(),
	listBlocks: vi.fn()
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

import Page from './+page.svelte';

/**
 * ⛔ THE TWO LANGUAGES SHARE NO SUBSTRING, IN EITHER DIRECTION — pinned by the first case rather
 * than trusted. Every assertion below is "the Dutch is present AND the English is gone"; an overlap
 * would let one half be satisfied by the other language's text.
 */
const EN = { block: 'Invoice parser', challenge: 'Claims intake' };
const NL = { block: 'Factuurverwerker', challenge: 'Schadeafhandeling' };

/** Which language the (mocked) server is answering in — the stand-in for `Accept-Language`. */
let serverLang: 'en' | 'nl' = 'en';
const copy = () => (serverLang === 'en' ? EN : NL);

function paletteItem() {
	return {
		slug: 'invoice-parser',
		name: copy().block,
		description: 'Reads a supplier document',
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

/** A one-node flow — the graph that must survive a language switch untouched. */
function flowFixture() {
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
			nodes: [
				{
					id: 'n1',
					blockId: 'b1',
					blockVersionId: 'v1',
					slug: 'invoice-parser',
					label: 'Invoice parser',
					category: 'data',
					config: {},
					position: { x: 0, y: 0 }
				}
			],
			edges: []
		}
	};
}

function challengeFixture() {
	return {
		id: CH_ID,
		code: 'CH-284',
		title: copy().challenge,
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
		solutions: [],
		similar: [],
		cycleClosed: false
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const palette = () => target.querySelector('aside.palette') as HTMLElement | null;
const paletteText = () => palette()?.textContent ?? '';
const panelText = () => target.querySelector('.data-panel')?.textContent ?? '';

/**
 * Drive a REAL locale change, the way the topbar switcher does — minus the network.
 *
 * ⚠️ ASSIGNED DIRECTLY, NEVER VIA `locale.set()`: that method PATCHes `/api/me/locale` through an
 * unmocked `authFetch`. The rune assignment IS the trigger the page reacts to —
 * `reloadOnLocaleChange` tracks `locale.current` and nothing else.
 */
async function switchToDutch() {
	serverLang = 'nl';
	locale.current = 'nl';
	flushSync();
	await settle();
	await settle();
}

/** Mount /build and prove it actually rendered before anything is asserted about its content. */
async function mountBuild() {
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	await settle();
	// ⛔ POSITIVE MARKERS. /build mounts a dozen modules; one unstubbed import and the page renders
	// nothing, every `querySelector` answers null, and "the English is gone" passes on an empty DOM.
	expect(palette(), 'the palette never rendered — this file would test nothing').toBeTruthy();
	expect(paletteText(), 'the English palette never reached the screen').toContain(EN.block);
	expect(panelText(), 'the English challenge title never reached the screen').toContain(
		EN.challenge
	);
	expect(getFlow, 'the flow was never loaded, so "not reloaded" would prove nothing').toHaveBeenCalledTimes(1);
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	serverLang = 'en';
	listBlocks.mockImplementation(async () => ({ items: [paletteItem()], total: 1 }));
	listFlows.mockImplementation(async () => ({
		items: [{ id: 'f1', name: 'Claim summariser', node_count: 1 }],
		total: 1
	}));
	getFlow.mockImplementation(async () => flowFixture());
	saveFlow.mockImplementation(async () => flowFixture());
	getChallenge.mockImplementation(async () => challengeFixture());
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	locale.current = initialLocale;
	flushSync();
	vi.clearAllMocks();
});

describe('/build relocalizes its server-localized copy on a language switch', () => {
	it('the two fixtures really are different, and neither contains the other', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. If these overlapped, "the Dutch is present" could be
		// satisfied by the English text still sitting there.
		for (const [a, b] of [
			[EN.block, NL.block],
			[NL.block, EN.block],
			[EN.challenge, NL.challenge],
			[NL.challenge, EN.challenge]
		]) {
			expect(a === b, `"${a}" and "${b}" are the same string`).toBe(false);
			expect(a.includes(b), `"${a}" must not contain "${b}"`).toBe(false);
		}
	});

	it('⛔ THE DEFECT: the block palette stays in the old language forever', async () => {
		await mountBuild();
		expect(listBlocks).toHaveBeenCalledTimes(1);

		await switchToDutch();

		// The request really was re-issued. (The locale rides on `Accept-Language`, not on the
		// argument, so the argument is unchanged — the COUNT is the observable.)
		expect(listBlocks, 'the locale switch did not refetch the block library').toHaveBeenCalledTimes(2);
		// …and it reached the screen. Both halves: the palette still exists and holds the Dutch tile,
		// and the English name is gone.
		expect(palette(), 'the palette was torn down instead of re-rendered').toBeTruthy();
		expect(paletteText(), 'the Dutch tile name never rendered').toContain(NL.block);
		expect(paletteText(), 'the English tile name survived the switch').not.toContain(EN.block);
	});

	it('⛔ …and so does the challenge title in the data panel', async () => {
		await mountBuild();
		expect(getChallenge).toHaveBeenCalledTimes(1);

		await switchToDutch();

		expect(getChallenge, 'the locale switch did not refetch the challenge').toHaveBeenCalledTimes(2);
		expect(getChallenge).toHaveBeenLastCalledWith(CH_ID);
		expect(panelText(), 'the Dutch challenge title never rendered').toContain(NL.challenge);
		expect(panelText(), 'the English challenge title survived the switch').not.toContain(
			EN.challenge
		);
	});

	it('⛔ THE FLOW GRAPH IS NOT REFETCHED — a language switch must never reload the editor', async () => {
		// The case that reds on the LAZY fix rather than on the defect. `reloadOnLocaleChange(load)`
		// or anything that re-runs `openFlow` would re-issue `GET /api/flows/:id` and hand
		// `builder.load()` the SERVER's graph, discarding whatever the builder has on the canvas but
		// has not saved. `/block-edit` wrote a bespoke `relocalizeDetail` for exactly this reason.
		await mountBuild();
		const flowCallsBefore = getFlow.mock.calls.length;
		const listFlowsBefore = listFlows.mock.calls.length;

		await switchToDutch();

		// The palette DID refetch — so this is not passing because nothing happened at all.
		expect(listBlocks, 'nothing refetched, so this case proves nothing').toHaveBeenCalledTimes(2);
		expect(
			getFlow.mock.calls.length,
			'a language switch reloaded the flow — unsaved canvas edits would be discarded'
		).toBe(flowCallsBefore);
		expect(
			listFlows.mock.calls.length,
			'a language switch re-listed the flows; the list holds no server-localized copy'
		).toBe(listFlowsBefore);
		// The flow the builder was editing is still the one on screen.
		expect(target.querySelector('.build-page'), 'the whole builder was torn down').toBeTruthy();
	});

	it('⛔ the sample-data tab is NOT re-selected by a language switch', async () => {
		// The challenge fetch selects the sample-data tab when the challenge ARRIVES — right on load,
		// wrong on a relocalize: a reader who moved to another tab and then switched language would
		// be pulled back to it. `loadChallengeContext` takes `openPanel` for this.
		await mountBuild();
		const dataPanel = () => target.querySelector('#side-panel-data') as HTMLElement | null;
		expect(dataPanel()?.hidden, 'the sample-data tab never opened, so "stays closed" proves nothing').toBe(false);
		const assistantTab = target.querySelector('#side-tab-assistant') as HTMLButtonElement | null;
		expect(assistantTab, 'no assistant tab').toBeTruthy();
		assistantTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(dataPanel()?.hidden, 'the tab click did nothing').toBe(true);

		await switchToDutch();

		expect(getChallenge, 'the challenge was not refetched, so this case proves nothing').toHaveBeenCalledTimes(2);
		expect(dataPanel()?.hidden, 'a language switch re-selected the sample-data tab').toBe(true);
	});

	it('⛔ the sample-data panel lives in the side pane, not over the canvas', async () => {
		// The panel used to be an absolutely-positioned `.data-overlay` inside the canvas area,
		// covering the left 270px of the flow. It is now the middle tab of the side pane.
		await mountBuild();
		const panel = target.querySelector('.data-panel');
		expect(panel, 'the data panel never rendered').toBeTruthy();
		expect(panel!.closest('#side-panel-data'), 'the panel is not in the side-pane tab').toBeTruthy();
		const canvas = target.querySelector('.area.canvas');
		expect(canvas, 'no canvas area').toBeTruthy();
		expect(canvas!.querySelector('.data-panel, .data-overlay, .data-fab')).toBeNull();
		const tabs = [...target.querySelectorAll('.side-tabs [role="tab"]')].map((t) => t.id);
		expect(tabs).toEqual(['side-tab-details', 'side-tab-data', 'side-tab-assistant']);
	});
});
