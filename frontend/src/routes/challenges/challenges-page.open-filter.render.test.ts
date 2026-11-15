// @vitest-environment jsdom
//
// src/routes/challenges/challenges-page.open-filter.render.test.ts — the board leads with the
// challenges a reader can still act on.
//
// ⛔ WHAT THE DEFAULT BOARD ACTUALLY SHOWED, MEASURED. Rows 1-5 all read "Voting week finished"
// (284 / 241 / 203 / 178 / 162 all-time votes); the ONLY live challenge was row SIX, last; and the
// chip row offered domains only — `All domains 6 · Claims 2 · Sales 1 · …` — with no status or
// liveness filter anywhere on the screen. `sort: 'top'` ranks by ALL-TIME votes, so the dead back
// catalogue permanently outranks the week that is actually open, and the one thing a visitor could
// act on sat below everything they could not.
//
// The route's own default stays "everything" and must: the back catalogue is a real history, and
// `open` as a ROUTE default empties every 2026-W21 fixture in the backend suite. This is the
// BOARD's default — `?open=true` sent per request, with an "All" chip that drops it.
//
// ⛔ THE EMPTY STATE IS THE LOAD-BEARING PART, NOT A CORNER. The live board shows exactly ONE row on
// a fresh dev seed, and in prod it shows ZERO from Monday 03:00 UTC every week, when `closeCycle`
// sweeps the running challenge closed before the next one opens. The generic "No challenges in this
// view yet" would be the product lying for the third time on this screen — there are forty, and the
// reader has just been shown none of them by a filter that is on by default and that they never
// chose.
//
// ⛔ VACUITY TRAPS: the page's `load()` awaits `challengesApi.list` AND `cycleApi.current`, so an
// unstubbed module leaves it in `{#if loading && !list}` forever and every "the chip is not active"
// assertion passes against an empty DOM. `chips()` asserts a POSITIVE MARKER (the two liveness chips
// are on screen) and `listCall()` asserts the request was actually made.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeList, ChallengeRow } from '$lib/types/challenges';

// Real `en` catalog, each key resolving to its own name.
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
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { listChallenges, currentCycle } = vi.hoisted(() => ({
	listChallenges: vi.fn(),
	currentCycle: vi.fn()
}));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: { list: listChallenges, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

function row(id: string, cycleClosed: boolean): ChallengeRow {
	return {
		id,
		code: `CH-${id}`,
		title: `Challenge ${id}`,
		workArea: 'Claims',
		status: 'voting',
		week: cycleClosed ? '2026-W21' : '2026-W24',
		cycleClosed,
		tags: [],
		votesCount: 284,
		rank: 1,
		hasVoted: false,
		solutionsCount: 0,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-05-20T00:00:00.000Z'
	};
}

function list(items: ChallengeRow[]): ChallengeList {
	return {
		items,
		total: items.length,
		page: 1,
		pageSize: 20,
		counts: { all: items.length, Claims: items.length },
		sort: 'top'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** `onMount` reads `window.location.search` directly, not `$app/state`. */
function setSearch(search: string) {
	window.history.replaceState({}, '', `/challenges${search}`);
}

async function render(items: ChallengeRow[], search = '') {
	setSearch(search);
	listChallenges.mockResolvedValue(list(items));
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * A board whose two SIDES hold different rows — which is the only board the hidden-count notice can
 * be measured on, and which `render()` above structurally cannot express.
 *
 * ⛔ WHY THE MOCK BRANCHES ON `open` RATHER THAN COUNTING CALLS. `mockResolvedValueOnce` chains pin
 * an ORDER, and the page now issues a SECOND `list` call on the empty-live path (the probe for the
 * unfiltered total) whose position in the sequence is exactly what a future edit might move. A mock
 * keyed on the request's own `open` param answers correctly whatever the order, so these specs fail
 * for the reason they are about instead of for a shifted index.
 *
 * ⛔ AND `counts.all` IS DELIBERATELY THE OPEN-SIDE FIGURE ON THE OPEN-SIDE RESPONSE. That is what
 * the route really sends — the `open` predicate is applied to the counts query as well as the rows
 * query — so a fix that reached for `list.counts.all` instead of a real second request renders
 * "(0)" here and reds, which no fixture built from a single `list()` could ever show.
 */
function renderTwoSided(openItems: ChallengeRow[], allItems: ChallengeRow[], search = '') {
	setSearch(search);
	listChallenges.mockImplementation((p?: Record<string, unknown>) =>
		Promise.resolve(list(p?.open ? openItems : allItems))
	);
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	return settle();
}

/**
 * The two liveness chips, by label — AFTER proving they exist.
 *
 * ⛔ THE POSITIVE MARKER. Before this change the board had NO liveness filter at all, so an
 * assertion phrased as "the All chip is not active" is true of a screen that never rendered one.
 */
function livenessChips(): HTMLButtonElement[] {
	const chips = [...host.querySelectorAll('button.chip')].filter((c) => {
		const t = c.textContent?.trim() ?? '';
		return t === 'challenges_filter_open' || t === 'challenges_filter_all';
	}) as HTMLButtonElement[];
	expect(
		chips.map((c) => c.textContent?.trim()),
		'the liveness chips are not on screen — either the page is still loading (making every ' +
			'assertion here vacuous) or the toggle was never rendered'
	).toEqual(['challenges_filter_open', 'challenges_filter_all']);
	return chips;
}
function activeChipLabel(): string | undefined {
	return livenessChips()
		.find((c) => c.classList.contains('active'))
		?.textContent?.trim();
}
/**
 * The "show all" affordance inside the empty-live notice, matched on its KEY PREFIX.
 *
 * ⚠️ A PREFIX, because the key now carries a parameter and the mock catalog renders it as
 * `challenges_empty_open_all:7`. An equality match on the bare key would go silently undefined the
 * moment the figure arrives — i.e. it would fail on the fix and pass on the defect.
 */
function noticeShowAll(): HTMLButtonElement | undefined {
	return [...host.querySelectorAll('.notice button')].find((b) =>
		b.textContent?.trim().startsWith('challenges_empty_open_all')
	) as HTMLButtonElement | undefined;
}
/** The params of the Nth `challengesApi.list` call (0-based), asserting it happened at all. */
function listCall(n = 0): Record<string, unknown> {
	expect(listChallenges.mock.calls.length, `challengesApi.list was never called ${n + 1} time(s)`).toBeGreaterThan(n);
	return listChallenges.mock.calls[n]![0] as Record<string, unknown>;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.clearAllMocks();
});

describe('the challenge board defaults to the challenges still accepting work', () => {
	it('⛔ sends open=true on the FIRST load, with the Open chip active', async () => {
		// Red by dropping `open: openOnly || undefined` from the load() call, or by initialising
		// `openOnly = false`.
		await render([row('a', false)]);
		expect(
			listCall().open,
			'the board still asks for every challenge, so rows 1-5 are "Voting week finished" again and ' +
				'the only live one is last'
		).toBe(true);
		expect(activeChipLabel()).toBe('challenges_filter_open');
	});

	it('the All chip DROPS the filter, and the request says so', async () => {
		await render([row('a', false)]);
		const [, all] = livenessChips();
		all!.click();
		await settle();

		// `open` must be ABSENT, not `false`: the client only sets the param when truthy, and the
		// route reads `open === 'true' || open === '1'`.
		expect(listCall(1).open, 'the All chip still filters the board').toBeUndefined();
		expect(activeChipLabel()).toBe('challenges_filter_all');
	});

	it('and switching back re-applies it — the toggle is a toggle, not a one-way door', async () => {
		await render([row('a', false)]);
		const [open, all] = livenessChips();
		all!.click();
		await settle();
		open!.click();
		await settle();
		expect(listCall(2).open).toBe(true);
		expect(activeChipLabel()).toBe('challenges_filter_open');
	});

	it('clicking the ACTIVE chip does not re-fetch', async () => {
		await render([row('a', false)]);
		livenessChips()[0]!.click();
		await settle();
		expect(listChallenges.mock.calls).toHaveLength(1);
	});

	it('⚠️ deep-link: ?open=all / false / 0 lands on the All side', async () => {
		// The escape hatch a human types by hand. A `?open=false` that silently did nothing would be
		// the product ignoring an instruction.
		for (const value of ['all', 'false', '0']) {
			await render([row('a', true)], `?open=${value}`);
			expect(listCall().open, `?open=${value}`).toBeUndefined();
			expect(activeChipLabel(), `?open=${value}`).toBe('challenges_filter_all');
			if (app) unmount(app);
			app = null;
			host.innerHTML = '';
			vi.clearAllMocks();
		}
	});

	it('⛔ an ABSENT ?open= is NOT "show me the dead ones" — live stays the default', async () => {
		// The asymmetry, pinned: only the All side is deep-linkable, because live is the default. Red
		// by reading the param as a plain boolean (`openOnly = sp.get('open') === 'true'`).
		await render([row('a', true)]);
		expect(listCall().open).toBe(true);
		expect(activeChipLabel()).toBe('challenges_filter_open');
	});

	it('keeps the existing ?work_area= deep-link working alongside it', async () => {
		await render([row('a', false)], '?work_area=Claims');
		expect(listCall().workArea).toBe('Claims');
		expect(listCall().open).toBe(true);
	});
});

describe('the empty LIVE board is its own state, not the generic "no challenges"', () => {
	it('⛔ names the reason, offers /submit, and points at the All chip', async () => {
		// THE MONDAY-03:00-UTC STATE, every week, in prod. Red by deleting the third `{:else if}`
		// branch: the generic `challenges_empty` takes over and tells a reader looking at a board of
		// forty challenges that there are none.
		await renderTwoSided([], [row('a', true), row('b', true)]);

		expect(
			host.textContent,
			'the live board is empty and the page says "No challenges in this view yet" — there are ' +
				'forty, hidden by a default filter this reader never chose'
		).toContain('challenges_empty_open');

		const submit = [...host.querySelectorAll('.notice a')].find(
			(a) => a.getAttribute('href') === '/submit'
		);
		expect(submit, 'the empty live board offers no way to start a challenge').toBeTruthy();

		// The pointer at the All chip is the chip's own handler, not a description of where to click.
		const showAll = noticeShowAll();
		expect(showAll, 'the empty live board does not point at the All chip').toBeTruthy();
		showAll!.click();
		await settle();
		expect(listCall(2).open).toBeUndefined();
		expect(activeChipLabel()).toBe('challenges_filter_all');
	});

	it('⛔⛔ SAYS HOW MANY ARE HIDDEN, AND THE FIGURE IS MEASURED', async () => {
		// THE DEFECT, IN PROD: seven `fr-test` challenges, every one `status='closed'` at 2026-W33,
		// against a live cycle of 2026-W35. A Dutch tester opening /challenges got a blank board and
		// an offer — "show all challenges" — with nothing to say whether all was seven or nought.
		//
		// ⛔ RED THREE WAYS, AND THE THIRD IS THE ONE THAT MATTERS:
		//   1. drop `{ count: … }` from the call            → the button reads bare, no figure
		//   2. hard-code a number in the catalog             → the mock catalog interpolates params
		//      only, so the figure would stop tracking this fixture's seven
		//   3. reach for `list.counts.all` or `list.total`   → the OPEN-side response is what those
		//      fields come from and it holds ZERO here (see `renderTwoSided`), so the notice would
		//      offer to show nothing. This is the reason the page issues a second request at all.
		const back = Array.from({ length: 7 }, (_, i) => row(`old-${i}`, true));
		await renderTwoSided([], back);

		// The probe is the SAME board with the liveness filter dropped — same work area, page 1 —
		// because the number has to be what the reader gets after clicking, not a different query.
		expect(listChallenges.mock.calls.length, 'the page never measured the hidden set').toBe(2);
		expect(listCall(1).open, 'the probe kept the filter it exists to look past').toBeUndefined();
		expect(listCall(1).page).toBe(1);

		expect(
			noticeShowAll()?.textContent?.trim(),
			'the offer to widen the filter does not say how much is behind it'
		).toBe('challenges_empty_open_all:7');
	});

	it('⛔ …and when NOTHING is hidden it does not pretend otherwise', async () => {
		// The other half, and the one an eager fix breaks: a workspace whose board is empty on BOTH
		// sides has no back catalogue to offer. "Show all challenges (0)" would be the product
		// inventing content to apologise for. Red by dropping `(allBoardTotal ?? 0) > 0` from the
		// branch condition.
		await renderTwoSided([], []);
		expect(host.textContent, 'the page offered to reveal a back catalogue that does not exist')
			.not.toContain('challenges_empty_open');
		expect(host.textContent).toContain('challenges_empty');
	});

	it('⚠️ a probe that FAILS degrades to the generic empty state, not to a blank page', async () => {
		// The probe decorates an already-successful load. Letting its rejection reach the page's
		// `error` state would replace a board that loaded fine with "we couldn't load that".
		setSearch('');
		listChallenges.mockImplementation((p?: Record<string, unknown>) =>
			p?.open ? Promise.resolve(list([])) : Promise.reject(new Error('probe down'))
		);
		currentCycle.mockResolvedValue(null);
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.textContent).toContain('challenges_empty');
		expect(host.textContent).not.toContain('challenges_empty_open');
		expect(host.textContent, 'a failed decoration blanked the board').not.toContain('error_load_failed');
	});

	it('⛔ the generic empty state is still reachable — on the ALL board', async () => {
		// TRAP: without this, replacing `challenges_empty` outright would pass. An All board with no
		// rows really is an empty board, and that sentence is then true.
		await render([], '?open=all');
		expect(host.textContent).toContain('challenges_empty');
		expect(host.textContent).not.toContain('challenges_empty_open');
		// ⚠️ AND NO PROBE FIRES. The All board is already unfiltered; asking the server the same
		// question twice to fill in a notice it will not render is a wasted round-trip on the state
		// that is empty for the ordinary reason.
		expect(listChallenges.mock.calls).toHaveLength(1);
	});

	it('a NO-MATCH SEARCH still wins over both — it is a third, older distinction', async () => {
		// `challenges_no_match` predates this change and must not be swallowed: a searcher with no
		// hits has not discovered anything about the board's liveness.
		await renderTwoSided([], [row('a', true)]);
		const search = host.querySelector('input.search') as HTMLInputElement;
		search.value = 'zzzz';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		await settle();
		expect(host.textContent).toContain('challenges_no_match');
		expect(host.textContent).not.toContain('challenges_empty_open');
	});

	it('⚠️ neither empty state appears when the board HAS rows', async () => {
		// The mirror. Without it, rendering the empty notice unconditionally passes every case above.
		await render([row('a', false)]);
		expect(host.textContent).not.toContain('challenges_empty');
		expect(host.querySelector('.board')).not.toBeNull();
	});

	/**
	 * ⛔ A PROBE THAT ANSWERS AFTER THE READER HAS MOVED ON MUST NOT PAINT ITS FIGURE.
	 *
	 * Reproduced by an adversarial verifier before this was guarded: the board loads empty for one
	 * domain, its hidden-count probe is issued and left IN FLIGHT, the reader clicks a different
	 * domain chip (`domain` flips synchronously and a NEW load starts), and only then does the stale
	 * probe resolve. The notice offered "toon alle (N)" with N counted under the domain the reader
	 * had already left — and clicking it fetched the new one. The number and the click disagreed.
	 *
	 * ⚠️ Only the FIRST probe is deferred. A fixture that defers every probe deadlocks on itself —
	 * the second load's probe awaits the same unresolved promise — which is exactly how the first
	 * version of this case hung instead of failing.
	 */
	it('⛔ a superseded hidden-count probe does not paint its figure', async () => {
		setSearch('');
		currentCycle.mockResolvedValue(null);

		const isProbe = (a: Record<string, unknown> | undefined) =>
			!!a && typeof a === 'object' && !('open' in a);

		let resolveStale!: (v: ChallengeList) => void;
		const stale = new Promise<ChallengeList>((r) => (resolveStale = r));
		let probes = 0;
		let boards = 0;
		listChallenges.mockImplementation((a: Record<string, unknown>) => {
			if (isProbe(a)) {
				probes += 1;
				return probes === 1 ? stale : Promise.resolve({ ...list([]), total: 7 } as ChallengeList);
			}
			boards += 1;
			// ⛔ BOTH boards are EMPTY. The notice only renders on an empty board, so a non-empty
			// second board hides the very element this case inspects — and the mutant survives
			// against a screen that simply has nothing to paint. The discriminator is the FIGURE:
			// the live probe answers 7, the abandoned one answers 4242.
			return Promise.resolve(list([]));
		});

		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(probes, 'the empty live board never issued its hidden-count probe').toBe(1);

		// ⚠️ The chips render CATALOG KEYS under the message mock (`domain_claims`), not the raw
		// work-area name — a selector on "Claims" finds nothing and the case dies in its arrange step.
		const chip = [...host.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('domain_claims')
		);
		expect(chip, 'no domain chip to move to').toBeTruthy();
		chip!.click();
		await settle();

		resolveStale(({ ...list([]), total: 4242 }) as ChallengeList);
		await settle();

		// The CURRENT probe's figure is what the reader must see...
		expect(
			host.textContent,
			'the live hidden-count never reached the screen'
		).toContain('7');
		// ...and the abandoned one must never overwrite it.
		expect(
			host.textContent,
			'a superseded probe painted its count onto the board the reader is actually looking at'
		).not.toContain('4242');
	});
});
