// @vitest-environment jsdom
//
// src/routes/load-error-retry.render.test.ts — "Please try again" must come with something to try.
//
// ⛔ THE DEFECT, MEASURED LIVE. A failed FIRST load collapsed seven screens to a single sentence —
// `error_load_failed`, "We konden dat niet laden. Probeer het opnieuw." — inside a `{:else if error}`
// arm that is mutually exclusive with the whole page. The copy names an action and the page offered
// no control to perform it: the reader's only exit was F5, which on /ontology also happened to be the
// only way out of the `denied` latch (see ontology-page.denied-latch.render.test.ts).
//
// The repo already had the pattern. `+layout.svelte:125` renders the profile-load failure as a
// sentence PLUS a button (`auth_profile_retry`), and that button is the difference between an
// explained degraded state and a dead end. These seven arms are the same shape and now reuse it,
// except that the button re-runs the PAGE'S OWN loader rather than reloading the app.
//
// ⛔ WHAT IS ASSERTED IS THE RE-INVOCATION, NOT THE BUTTON. A control that exists and does nothing is
// the defect wearing a fix's clothes, so every case:
//   1. proves the page really reached its load-error arm (not a still-loading page, whose selectors
//      would answer empty for free),
//   2. finds the retry control,
//   3. makes the API healthy, clicks, and asserts the LOADER WAS CALLED AGAIN,
//   4. asserts the error sentence is gone and the page's real content rendered.
// Step 4 alone would pass on a control that merely hid the notice; step 3 alone would pass on a
// button wired to a loader whose result the page ignores.
//
// ⚠️ ONE FILE, SEVEN PAGES, ONE SET OF MODULE MOCKS. `vi.mock` is per-module-record and hoisted, so
// the union of every API these pages import is mocked once here. That is also why `$app/state`
// carries BOTH a `params.id` and a `url`: the two detail pages read the first, /solutions reads the
// second.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync, type Component } from 'svelte';

// Real `en` catalog, each key resolving to its own name — so an assertion names a MESSAGE KEY and no
// reworded translation can red this file.
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

// ⚠️ Literals inside the factory: `vi.mock` hoists above every top-level const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'ret-1' }, url: new URL('http://localhost/solutions') }
}));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const api = vi.hoisted(() => ({
	home: vi.fn(),
	winner: vi.fn(),
	listChallenges: vi.fn(),
	getChallenge: vi.fn(),
	comments: vi.fn(),
	listSolutions: vi.fn(),
	getSolution: vi.fn(),
	currentCycle: vi.fn(),
	matrix: vi.fn(),
	getOntology: vi.fn(),
	recentChanges: vi.fn(),
	FakeApiError: class FakeApiError extends Error {
		constructor(
			public status: number,
			public code = 'error'
		) {
			super(code);
		}
	}
}));

vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { home: api.home, winner: api.winner } }));
// Home also reads the reader's draft flows (the "Continue building" step); none here.
vi.mock('$lib/api/flows', () => ({ flowsApi: { list: () => Promise.resolve({ items: [], total: 0 }) } }));
vi.mock('$lib/api/challenges', () => ({
	ApiError: api.FakeApiError,
	challengesApi: {
		list: api.listChallenges,
		get: api.getChallenge,
		comments: api.comments,
		vote: vi.fn(),
		unvote: vi.fn(),
		postComment: vi.fn(),
		attachDataset: vi.fn(),
		detachDataset: vi.fn()
	}
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { list: api.listSolutions, get: api.getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: api.currentCycle } }));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/ontology', () => ({
	ApiError: api.FakeApiError,
	ontologyApi: {
		matrix: api.matrix,
		get: api.getOntology,
		recentChanges: api.recentChanges,
		createEntity: vi.fn(),
		updateEntity: vi.fn(),
		deleteEntity: vi.fn(),
		createRelation: vi.fn(),
		deleteRelation: vi.fn(),
		hideEntity: vi.fn(),
		unhideEntity: vi.fn(),
		translations: vi.fn(),
		saveTranslations: vi.fn(),
		samples: vi.fn(),
		saveSample: vi.fn(),
		deleteSample: vi.fn()
	}
}));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: { list: vi.fn().mockResolvedValue([]), listForSolution: vi.fn().mockResolvedValue([]), forward: vi.fn(), retry: vi.fn() }
}));
// ⛔ `RunApiError` must be a real class — solutions/[id] does `e instanceof RunApiError`.
vi.mock('$lib/api/runs', () => ({
	RunApiError: class RunApiError extends Error {},
	runErrorDataFindings: () => [],
	runsApi: { getMySandbox: vi.fn().mockResolvedValue(null), startSolution: vi.fn(), resumeMySandbox: vi.fn() }
}));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { id: 'u1', email: 'u@t', name: 'U', roles: ['employee'] }, isTenantAdmin: false }
}));

import Home from './+page.svelte';
import Winner from './winner/+page.svelte';
import Challenges from './challenges/+page.svelte';
import ChallengeDetail from './challenges/[id]/+page.svelte';
import Solutions from './solutions/+page.svelte';
import SolutionDetail from './solutions/[id]/+page.svelte';
import Ontology from './ontology/+page.svelte';

// ── fixtures, kept to the shape each load path actually reads ───────────────────────────────────
const homeSummary = () => ({
	stats: { activeChallenges: 1, solutionsInVoting: 0, activeBuilders: 0, liveInProduction: 0 },
	trending: [],
	cycle: null,
	yourActivity: { submitted: [], submittedTotal: 0, votedOn: [], votedOnTotal: 0 }
});
const weeklyWinner = () => ({ week: null, winner: null, stats: null, timeline: [], mentions: [] });
const challengeList = () => ({ items: [], total: 0, page: 1, pageSize: 10, counts: { all: 0 } });
const challengeDetail = () => ({
	id: 'ret-1',
	code: 'CH-1',
	title: 'A challenge',
	description: 'A description.',
	businessImpact: '',
	workArea: 'Claims',
	status: 'open',
	week: '2026-W23',
	tags: [],
	metrics: {},
	votesCount: 0,
	hasVoted: false,
	submitter: { name: 'Sam Submitter', initials: 'SS' },
	createdAt: '2026-08-14T09:00:00.000Z',
	commentCount: 0,
	datasets: [],
	canEditDatasets: false,
	involves: [],
	solutions: [],
	similar: []
});
const solutionList = () => ({ items: [], total: 0, page: 1, pageSize: 10, challenge: null });
const solutionDetail = () => ({
	id: 'ret-1',
	title: 'A solution',
	status: 'voting',
	week: '2026-W33',
	cycleClosed: false,
	votesCount: 0,
	hasVoted: false,
	demoMs: 0,
	blocksUsed: [],
	createdAt: '2026-08-14T09:00:00.000Z',
	author: { name: 'Bea Builder', initials: 'BB' },
	challenge: null,
	flow: null,
	comparison: []
});
const ontologyMatrix = () => ({
	industries: ['Insurance'],
	departments: ['Claims'],
	cells: [{ industry: 'Insurance', department: 'Claims', hasSpecialization: true }],
	canManage: false
});
const compiledOntology = () => ({
	industry: 'Insurance',
	department: 'Claims',
	entities: [],
	relations: [],
	hidden: [],
	canManage: false
});

/**
 * One screen under test: how to break its first load, how to heal it, which mock IS the loader
 * (so "it ran again" is a fact about the network and not about a spy the page could ignore), and a
 * message key that only renders once the page has real content.
 */
interface Screen {
	name: string;
	page: Component;
	loader: () => ReturnType<typeof vi.fn>;
	fail: () => void;
	heal: () => void;
	/** A key the page renders ONLY in its loaded state. */
	loaded: string;
	/**
	 * Narrows the "re-ran exactly once" count to the page's PRIMARY load when the screen legitimately
	 * issues more than one query through the same mock. Omitted, every call counts — which is the
	 * right default and must stay it, so a screen only opts out by naming why (see `/challenges`).
	 */
	primaryCall?: (args: unknown) => boolean;
}

const SCREENS: Screen[] = [
	{
		name: '/',
		page: Home as unknown as Component,
		loader: () => api.home,
		fail: () => api.home.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.home.mockResolvedValue(homeSummary()),
		loaded: 'home_stat_active_challenges'
	},
	{
		name: '/winner',
		page: Winner as unknown as Component,
		loader: () => api.winner,
		fail: () => api.winner.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.winner.mockResolvedValue(weeklyWinner()),
		loaded: 'winner_none'
	},
	{
		name: '/challenges',
		page: Challenges as unknown as Component,
		loader: () => api.listChallenges,
		fail: () => api.listChallenges.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.listChallenges.mockResolvedValue(challengeList()),
		loaded: 'challenges_eyebrow',
		// ⛔ THIS SCREEN ISSUES A SECOND, DIFFERENT QUERY ON A SUCCESSFUL-BUT-EMPTY LOAD, and the
		// "exactly once" count below must not read it as a double load. When the live board comes
		// back empty the page probes the SAME board with the liveness filter dropped, so the empty
		// state can say how many challenges are behind the filter instead of rendering a bare void.
		// `challengeList()` is `{ items: [], total: 0 }` — i.e. this fixture IS that case.
		//
		// ⚠️ The probe is NOT the hazard this test guards. That hazard is two concurrent loads of the
		// SAME query racing into `list`, where the slower-settling one wins and puts stale rows on
		// screen. The probe is a different query whose result lands in `allBoardTotal` and never in
		// `list`. Distinguished by argument shape rather than by call count: only the board query
		// carries `open`.
		primaryCall: (args: unknown) =>
			typeof args === 'object' && args !== null && 'open' in (args as Record<string, unknown>)
	},
	{
		name: '/challenges/[id]',
		page: ChallengeDetail as unknown as Component,
		loader: () => api.getChallenge,
		fail: () => api.getChallenge.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.getChallenge.mockResolvedValue(challengeDetail()),
		loaded: 'challenge_detail_lifecycle'
	},
	{
		name: '/solutions',
		page: Solutions as unknown as Component,
		loader: () => api.listChallenges,
		fail: () => api.listChallenges.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.listChallenges.mockResolvedValue(challengeList()),
		loaded: 'solutions_eyebrow'
	},
	{
		name: '/solutions/[id]',
		page: SolutionDetail as unknown as Component,
		loader: () => api.getSolution,
		fail: () => api.getSolution.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.getSolution.mockResolvedValue(solutionDetail()),
		loaded: 'solution_detail_tryit_title'
	},
	{
		name: '/ontology',
		page: Ontology as unknown as Component,
		loader: () => api.matrix,
		fail: () => api.matrix.mockRejectedValue(new Error('Failed to fetch')),
		heal: () => api.matrix.mockResolvedValue(ontologyMatrix()),
		loaded: 'ontology_select_industry'
	}
];

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** The retry control inside the load-error notice, or null. */
function retryButton(): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>('.notice.error button');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	// Healthy defaults for everything a page fetches BESIDES the one call each case breaks.
	api.currentCycle.mockResolvedValue(null);
	api.comments.mockResolvedValue({ items: [] });
	api.listSolutions.mockResolvedValue(solutionList());
	api.getOntology.mockResolvedValue(compiledOntology());
	api.recentChanges.mockResolvedValue({ items: [], unattributed: 0 });
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of Object.values(api)) if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe('a failed first load offers the control its own copy promises', () => {
	for (const screen of SCREENS) {
		it(`⛔ ${screen.name} renders a retry control that re-runs its loader`, async () => {
			screen.fail();
			app = mount(screen.page, { target: host }) as Record<string, unknown>;
			await settle();

			// (1) The page really reached its load-error arm. Without this, every selector below
			// answers empty on a page that never mounted and the case proves nothing.
			expect(host.textContent, `${screen.name} did not render its load failure`).toContain('error_load_failed');
			const primaryCalls = () =>
				screen
					.loader()
					.mock.calls.filter((c: unknown[]) => (screen.primaryCall ? screen.primaryCall(c[0]) : true)).length;
			const callsBefore = primaryCalls();
			expect(callsBefore, `${screen.name} never called its loader`).toBeGreaterThan(0);

			// (2) The control exists, inside the notice that names the failure, and says "try again".
			const button = retryButton();
			expect(button, `${screen.name} is a dead end — the copy says "try again" and there is no control`).not.toBeNull();
			expect(button!.textContent).toContain('error_load_retry');

			// (3) It re-runs the loader EXACTLY ONCE. ⛔ `toBeGreaterThan` was not enough: an
			// `onclick={() => { void load(); void load(); }}` passes it, and a retry that fires two
			// concurrent loads is a real hazard on these pages — whichever settles last wins, so a
			// slow-then-fast pair can leave the older response on screen.
			screen.heal();
			button!.click();
			await settle();
			expect(
				primaryCalls(),
				`${screen.name}'s retry control did not re-run the load exactly once`
			).toBe(callsBefore + 1);

			// (4) …and the page recovers into its real content, not into a blank frame.
			expect(host.textContent, `${screen.name} still shows the failure after a successful retry`).not.toContain('error_load_failed');
			expect(host.textContent, `${screen.name} recovered into nothing`).toContain(screen.loaded);
		});

		it(`${screen.name} shows no retry control once it has loaded`, async () => {
			// ⛔ THE COMPLEMENT. A retry button rendered unconditionally would satisfy every assertion
			// above while putting "Try again" under a page that loaded perfectly well.
			screen.heal();
			app = mount(screen.page, { target: host }) as Record<string, unknown>;
			await settle();
			expect(host.textContent, `${screen.name} did not reach its loaded state`).toContain(screen.loaded);
			expect(host.textContent).not.toContain('error_load_failed');
			expect(retryButton(), `${screen.name} offers a retry control on a healthy page`).toBeNull();
		});
	}
});
