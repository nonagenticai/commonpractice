// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.param-change.svelte.test.ts — /challenges/A →
// /challenges/B must move the WHOLE page, not just the address bar.
//
// ⛔ THE DEFECT, and it is a silent cross-challenge WRITE. `+page.svelte` reads the route param
// reactively (`const id = $derived(page.params.id ?? '')`) but fetched with `onMount(load)`.
// SvelteKit reuses this component across a param change — `onMount` runs exactly once — so after a
// click on any row under "Vergelijkbare uitdagingen" (the sidebar card that renders whenever the
// backend returns siblings) `id` is B and every rendered field is still A's. From there:
//
//   vote()       POSTs /api/challenges/B/vote      while incrementing A's counter on screen
//   postReply()  POSTs /api/challenges/B/comments  and appends the reply to A's thread
//   saveData()   PATCHes /api/challenges/B         with A's dataset slugs — the destructive one:
//                the PATCH body REPLACES the link set, so B's applicable datasets are silently
//                overwritten with A's, and nothing on screen ever said "B".
//
// Nothing watched it: the three existing render tests for this route each mount ONCE and never
// touch the param, so the reused-component path was never executed. The sibling route
// `routes/solutions/[id]/+page.svelte:306-328` already carries the `$effect` that fixes exactly
// this, and its comment names the failure mode.
//
// ⛔ WHAT MAKES THESE ASSERTIONS NON-VACUOUS. "The title updated" is the weak half. The load-bearing
// assertion in every write case below is TWO-SIDED: the id the request went to, read out of the
// mock, must be the id of the challenge whose title is on screen at that moment. Under the defect
// the request id is already 'ch-b' — asserting the request id ALONE passes while the page lies. It
// is the agreement between the wire and the viewport that pins the bug.
//
// ⛔ POSITIVE MARKERS FIRST, in every case. `load()` awaits `challengesApi.get`, `.comments` AND
// `cycleApi.current` in one `Promise.all`; a single unstubbed module leaves the page in its
// `{#if loading && !data}` branch, every `querySelector` answers null, and assertions phrased as
// "A's title is gone" pass against an empty DOM. So each case asserts A is fully on screen before
// it navigates.
//
// It is a `.svelte.test.ts` (note the infix) so vite-plugin-svelte compiles it as a rune module:
// the param is read through `page.params`, so only a `$state`-backed mock re-fires the derived and
// the effect under test. Idiom copied from `routes/build/build-page.failed-switch.svelte.test.ts`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail } from '$lib/types/challenges';
import type { DatasetRow } from '$lib/types/datasets';
import type { AllDatasets } from '$lib/api/datasets';

// Real `en` catalog, each key resolving to its own name: a reworded translation cannot red these,
// and a resurrected hardcoded English label cannot pass them.
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

// The reactive route param — the address bar. Built INSIDE the factory rather than in a
// `vi.hoisted` block: `vi.hoisted` runs before this module's imports are initialized and `$state`
// compiles to a call into the Svelte client runtime, so building it there dies on its own import.
vi.mock('$app/state', () => {
	const page = $state({
		params: { id: 'ch-a' },
		url: new URL('http://localhost/challenges/ch-a')
	});
	return { page };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getChallenge, getComments, currentCycle, voteApi, unvoteApi, postComment, updateDatasets, listDatasets, listAll } =
	vi.hoisted(() => ({
		getChallenge: vi.fn(),
		getComments: vi.fn(),
		currentCycle: vi.fn(),
		voteApi: vi.fn(),
		unvoteApi: vi.fn(),
		postComment: vi.fn(),
		updateDatasets: vi.fn(),
		listDatasets: vi.fn(),
		listAll: vi.fn()
	}));

// The page imports `ApiError` as a VALUE from this module; a mock that omits it fails at import
// time rather than at assert time, which at least is loud.
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: {
		get: getChallenge,
		comments: getComments,
		vote: voteApi,
		unvote: unvoteApi,
		updateDatasets,
		postComment
	}
}));
// `cycleApi.current()` sits in the same `Promise.all` as the challenge fetch, behind a
// `.catch(() => null)` — so leaving it unstubbed throws at IMPORT time, not at assert time. It
// answers `null`, which is what prod answers today (no `marketplace_cycles` row for the week).
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
// ⚠️ `startEditData()` (+page.svelte:165) now calls `listAll`, so a factory without it does not fail
// an assertion — the `TypeError` is swallowed by that function's own `catch`, the editor never opens,
// and the dataset case below reads as "the editor did not survive the navigation" when nothing was
// ever tested. `list` stays mocked and callable for the reason the three
// `lib/components/build/*.render.test.ts` specs record: a revert must red on an assertion, not on
// `datasetsApi.list is not a function`.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: listDatasets, listAll, get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import { page as navPage } from '$app/state';
import Page from './+page.svelte';

/** The mocked `page` above, typed for writing — this is the address bar. */
const nav = navPage as unknown as { params: { id: string }; url: URL };

/** What `datasetsApi.listAll` resolves — `{items,total,capped}`, NOT a bare `DatasetRow[]`. Written
 * once per file, the same one-liner the three `lib/components/build/*.render.test.ts` specs use. */
const allDatasets = (items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets => ({
	items,
	total: items.length,
	capped: false,
	...extra
});

/** The two challenges. Every field a case reads differs between them, ON PURPOSE. */
function detail(over: Partial<ChallengeDetail> & { id: string; title: string }): ChallengeDetail {
	return {
		code: 'CH-1',
		description: `Beschrijving van ${over.id}.`,
		businessImpact: '',
		workArea: 'Claims',
		// `voting`, never `closed`: `challengeState().canVote` is exactly the backend's predicate
		// (`status !== 'closed'`), and a blocked VoteButton is `disabled`, so a closed fixture would
		// make the vote case unclickable and quietly vacuous.
		status: 'voting',
		week: '2026-W23',
		tags: [],
		metrics: {},
		hasVoted: false,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-06-01T00:00:00.000Z',
		canEditDatasets: true,
		involves: [],
		solutions: [],
		votesCount: 0,
		commentCount: 0,
		datasets: [],
		similar: [],
		...over
	} as ChallengeDetail;
}

const TITLE_A = 'Facturen matchen kost vier dagen';
const TITLE_B = 'Offertes belanden in de verkeerde map';

const CHALLENGES: Record<string, ChallengeDetail> = {
	'ch-a': detail({
		id: 'ch-a',
		title: TITLE_A,
		votesCount: 12,
		commentCount: 1,
		datasets: [{ slug: 'facturen', name: 'Facturen', columns: [], rowCount: 40, note: '' }],
		similar: [{ id: 'ch-b', title: TITLE_B, workArea: 'Sales', votesCount: 40 }]
	}),
	'ch-b': detail({
		id: 'ch-b',
		title: TITLE_B,
		votesCount: 40,
		commentCount: 1,
		datasets: [{ slug: 'offertes', name: 'Offertes', columns: [], rowCount: 90, note: '' }],
		similar: [{ id: 'ch-a', title: TITLE_A, workArea: 'Claims', votesCount: 12 }]
	})
};

const COMMENTS: Record<string, { id: string; body: string; createdAt: string; author: { name: string; initials: string } }[]> =
	{
		'ch-a': [
			{
				id: 'c-a',
				body: 'Dit speelt bij ons elke maandag.',
				createdAt: '2026-06-02T00:00:00.000Z',
				author: { name: 'Ann', initials: 'AN' }
			}
		],
		'ch-b': [
			{
				id: 'c-b',
				body: 'De map heet bij ons anders.',
				createdAt: '2026-06-02T00:00:00.000Z',
				author: { name: 'Bo', initials: 'BO' }
			}
		]
	};

/** Which challenge is the reader LOOKING at, resolved from the DOM alone. */
function idOnScreen(): string | null {
	const h1 = host.querySelector('h1')?.textContent?.trim() ?? '';
	if (h1 === TITLE_A) return 'ch-a';
	if (h1 === TITLE_B) return 'ch-b';
	return null;
}

const voteButton = () => host.querySelector('.vote-card button.vote') as HTMLButtonElement | null;
const voteCount = () => host.querySelector('.vote-card button.vote .num')?.textContent?.trim() ?? null;
const threadBodies = () => [...host.querySelectorAll('.thread li .body p')].map((p) => p.textContent?.trim() ?? '');
const editButton = () =>
	[...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'challenge_data_edit') ?? null;
const saveButton = () =>
	[...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'challenge_data_save') ?? null;
const replyBox = () => host.querySelector('.thread .reply textarea') as HTMLTextAreaElement | null;
const replyPost = () => host.querySelector('.thread .reply button') as HTMLButtonElement | null;

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * Mount on /challenges/ch-a and PROVE the page is fully rendered before any case navigates.
 * Without this every "A is gone" assertion below would pass against a page stuck on its loading
 * notice.
 */
async function mountOnA() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(idOnScreen(), 'the detail page never rendered — this file would test nothing').toBe('ch-a');
	expect(voteCount()).toBe('12');
	expect(threadBodies()).toEqual(['Dit speelt bij ons elke maandag.']);
}

/**
 * The navigation itself. `+page.svelte:445-449` renders each `similar` row as a plain
 * `<a href="/challenges/{s.id}">`, so the real click is a client-side route change that moves the
 * param and NOTHING else — which is exactly this assignment. The link is asserted to be present
 * first, so the case stays tied to a path a reader can actually take.
 */
async function navigateToSibling(id: string) {
	const link = [...host.querySelectorAll('.similar a')].find(
		(a) => (a as HTMLAnchorElement).getAttribute('href') === `/challenges/${id}`
	);
	expect(link, `"Vergelijkbare uitdagingen" offers no route to ${id} — the defect is unreachable`).toBeTruthy();
	nav.params.id = id;
	nav.url = new URL(`http://localhost/challenges/${id}`);
	flushSync();
	await settle();
}

beforeEach(() => {
	nav.params.id = 'ch-a';
	nav.url = new URL('http://localhost/challenges/ch-a');
	host = document.createElement('div');
	document.body.appendChild(host);
	getChallenge.mockImplementation(async (id: string) => CHALLENGES[id] ?? Promise.reject(new Error('404')));
	getComments.mockImplementation(async (id: string) => ({ items: COMMENTS[id] ?? [], total: 0 }));
	currentCycle.mockResolvedValue(null);
	listDatasets.mockResolvedValue({ items: [] });
	listAll.mockResolvedValue(allDatasets([]));
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getChallenge, getComments, currentCycle, voteApi, unvoteApi, postComment, updateDatasets, listDatasets, listAll])
		fn.mockReset();
});

describe('/challenges/[id] across a sibling navigation', () => {
	it('⛔ the whole page follows the param — title, votes and thread', async () => {
		await mountOnA();
		await navigateToSibling('ch-b');

		expect(idOnScreen(), 'the page is still showing challenge A under /challenges/ch-b').toBe('ch-b');
		// A's TITLE is legitimately still on screen — B's own "Vergelijkbare uitdagingen" links back
		// to it. A's BODY is not, and that is the string that proves the payload swapped.
		expect(host.textContent, "A's description survived the navigation").not.toContain(
			'Beschrijving van ch-a.'
		);
		expect(host.textContent, "B's description never rendered").toContain('Beschrijving van ch-b.');
		expect(voteCount(), "A's vote count survived the navigation").toBe('40');
		expect(threadBodies(), "A's discussion survived the navigation").toEqual(['De map heet bij ons anders.']);
		// The load really ran for B — not just a lucky re-render.
		expect(getChallenge.mock.calls.map((c) => c[0])).toEqual(['ch-a', 'ch-b']);
	});

	it('⛔ a vote after the navigation counts against the challenge ON SCREEN', async () => {
		// THE HEADLINE CASE. Under the defect the POST already goes to 'ch-b' while the pill shows
		// A's 12 → 13, so asserting the request id alone proves nothing. The agreement is the test.
		await mountOnA();
		await navigateToSibling('ch-b');

		voteApi.mockResolvedValue({ voted: true, count: 41 });
		voteButton()?.click();
		await settle();

		expect(voteApi, 'the vote never left the page').toHaveBeenCalledTimes(1);
		const target = voteApi.mock.calls[0][0] as string;
		expect(
			idOnScreen(),
			`the vote was POSTed to ${target} while the reader was looking at a different challenge`
		).toBe(target);
		expect(voteCount(), "the counter moved off A's baseline, not B's").toBe('41');
	});

	it('⛔ a reply after the navigation is appended to the thread ON SCREEN', async () => {
		await mountOnA();
		await navigateToSibling('ch-b');

		postComment.mockResolvedValue({
			id: 'c-new',
			body: 'Bij ons ook.',
			createdAt: '2026-06-03T00:00:00.000Z',
			author: { name: 'Cor', initials: 'CO' }
		});
		const box = replyBox();
		expect(box, 'the reply box never rendered').toBeTruthy();
		box!.value = 'Bij ons ook.';
		box!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		replyPost()?.click();
		await settle();

		expect(postComment, 'the reply never left the page').toHaveBeenCalledTimes(1);
		const target = postComment.mock.calls[0][0] as string;
		expect(
			idOnScreen(),
			`the reply was POSTed to ${target} while the reader was looking at a different challenge`
		).toBe(target);
		// And it landed in B's thread, under B's existing comment — never under A's.
		expect(threadBodies()).toEqual(['De map heet bij ons anders.', 'Bij ons ook.']);
	});

	it("⛔ the dataset editor must not carry A's slugs into a PATCH against B", async () => {
		// THE DESTRUCTIVE ONE. `PATCH /api/challenges/:id` REPLACES the dataset link set, so a save
		// left open across the navigation overwrites B's applicable datasets with A's — a data loss
		// the reader never asked for and never saw named.
		await mountOnA();
		editButton()?.click();
		await settle();
		expect(saveButton(), 'the dataset editor never opened — this case would test nothing').toBeTruthy();

		await navigateToSibling('ch-b');

		// B's own datasets are on screen, and the card is back in its read state.
		expect(host.textContent, "B's dataset card never rendered").toContain('Offertes');
		// If the editor DID survive, press the button the reader would press and let the poisoned
		// call name itself in the assertion below.
		saveButton()?.click();
		await settle();
		expect(
			updateDatasets.mock.calls,
			'a dataset PATCH was issued across the navigation — the ids/slugs above are the cross-challenge write'
		).toEqual([]);
		expect(saveButton(), "the dataset editor survived the navigation still holding A's slugs").toBeNull();
	});

	it('⛔ a SLOW load for A that lands after the navigation must not repaint B', async () => {
		// The stale-response race the `solutions/[id]` pattern does NOT guard: the effect fires a
		// fresh `load()` per id, but the OLD id's `Promise.all` is still in flight and its `data = d`
		// has no idea the reader has moved. Reproduced by holding A's fetch open across the nav.
		let releaseA: (v: ChallengeDetail) => void = () => {};
		getChallenge.mockImplementation((id: string) => {
			if (id === 'ch-a') return new Promise<ChallengeDetail>((resolve) => (releaseA = resolve));
			return Promise.resolve(CHALLENGES[id]);
		});

		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(idOnScreen(), 'A must still be loading — the race needs an in-flight request').toBeNull();

		// The reader gives up and uses the sidebar of… nothing. So drive the param directly; the
		// "similar" card is not on screen while the first load hangs.
		nav.params.id = 'ch-b';
		nav.url = new URL('http://localhost/challenges/ch-b');
		flushSync();
		await settle();
		expect(idOnScreen(), 'B never loaded — the race has nothing to overwrite').toBe('ch-b');

		releaseA(CHALLENGES['ch-a']);
		await settle();

		expect(idOnScreen(), "A's late response repainted the page under /challenges/ch-b").toBe('ch-b');
		expect(voteCount()).toBe('40');
	});
});
