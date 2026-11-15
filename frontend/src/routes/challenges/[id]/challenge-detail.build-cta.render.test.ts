// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.build-cta.render.test.ts — the challenge page must
// not offer a build it knows the server will refuse.
//
// ⛔ WHY THIS FILE EXISTS — MEASURED IN A REAL BROWSER, NOT INFERRED. On `/challenges/<a 2026-W21
// challenge>` the unfixed page rendered, in ONE viewport:
//
//   • a muted badge reading                     "Voting week finished"
//   • a sidebar line reading                    "This challenge belongs to week 21 of 2026, which
//                                                is already finished."
//   • and BETWEEN THEM, a live link             "Build a solution" → /build?challenge=<that id>
//
// Following that link and submitting returned HTTP 201. The solution was stamped with the CURRENT
// week and competed in a live cycle under a May parent — which is why nine consecutive cycles
// crowned nobody. The backend now answers 422 `challenge_closed`; this file is about the product no
// longer OFFERING it, and about the refusal being a sentence the reader can act on.
//
// The unit suite (`$lib/challenges/challenge-state.test.ts`) proves the `submittable` truth table.
// THIS file proves the page is wired to it — that the two CTA sites moved off `data.status`, which
// is the column that lied.
//
// ⛔ VACUITY TRAPS THIS FILE IS BUILT AGAINST — read `challenge-detail.lifecycle.render.test.ts:23-33`:
//   (a) `load()` awaits `challengesApi.get`, `challengesApi.comments` AND `cycleApi.current`, and
//       `startEditData` reaches for `$lib/api/datasets`. One unstubbed module and the page never
//       leaves its `{#if loading && !data}` branch — `querySelectorAll` returns EMPTY and EVERY
//       negative assertion in this file ("no .build-cta") passes for free. So `solutionsCard()`
//       asserts a POSITIVE MARKER first and every case goes through it.
//   (b) The mirror case is not optional. Without "open ⇒ the CTA IS there", deleting the link
//       outright would pass every other test here.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail, ChallengeStatus } from '$lib/types/challenges';
import type { CycleState } from '$lib/types/cycle';

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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'ch-cta-1' }, url: new URL('http://localhost/challenges/ch-cta-1') }
}));
const CH_ID = 'ch-cta-1';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getChallenge, getComments, currentCycle } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getComments: vi.fn(),
	currentCycle: vi.fn()
}));
// ⛔ TRAP (a), FIRST THIRD. The page imports `ApiError` as a VALUE from this module; a mock that
// omits it fails at import time rather than at assert time, which at least is loud.
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: {
		get: getChallenge,
		comments: getComments,
		vote: vi.fn(),
		unvote: vi.fn(),
		updateDatasets: vi.fn(),
		postComment: vi.fn()
	}
}));
// ⛔ TRAP (a), SECOND THIRD. Inside the same `Promise.all` as the challenge fetch.
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
// ⛔ TRAP (a), FINAL THIRD. Not on the load path — reached by `startEditData` — but a module-scope
// import of the component under test.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/** The week the measured row carried. */
const DEAD_WEEK = '2026-W21';
/** The running cycle's week in every case that supplies one. */
const LIVE_WEEK = '2026-W24';

function liveCycle(): CycleState {
	return {
		week: LIVE_WEEK,
		phase: 'voting',
		votingEndsAt: '2026-06-11T16:00:00.000Z',
		solutionEndsAt: '2026-06-12T16:00:00.000Z',
		closesAt: '2026-06-12T18:00:00.000Z',
		closedAt: null
	};
}

interface Fixture {
	status?: ChallengeStatus;
	week?: string;
	cycleClosed?: boolean;
	/** `solutions[]` — empty by default, so the EMPTY-STATE CTA site is in frame in every case. */
	solutions?: ChallengeDetail['solutions'];
}

function detail(f: Fixture): ChallengeDetail {
	const base: ChallengeDetail = {
		id: CH_ID,
		code: 'CH-284',
		title: 'Claims intake takes four days',
		description: 'A description.',
		businessImpact: '',
		workArea: 'Claims',
		status: f.status ?? 'voting',
		week: f.week ?? DEAD_WEEK,
		tags: [],
		metrics: {},
		votesCount: 284,
		hasVoted: false,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-05-20T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		solutions: f.solutions ?? [],
		similar: []
	};
	// Assigned rather than spread with `undefined`, so the MID-ROLL case genuinely OMITS the key
	// instead of carrying an explicit `undefined` — `'cycleClosed' in challenge` is not what the
	// module reads, but a fixture that quietly differs from the wire is how a mid-roll test lies.
	if (f.cycleClosed !== undefined) base.cycleClosed = f.cycleClosed;
	return base;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(f: Fixture, cycle: CycleState | null = liveCycle()) {
	getChallenge.mockResolvedValue(detail(f));
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(cycle);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	return solutionsCard();
}

/**
 * The solutions card, AFTER proving it is actually on screen.
 *
 * ⛔ TRAP (a), THE POSITIVE MARKER — the whole reason this helper exists. On an unmounted page every
 * `expect(host.querySelector('.build-cta')).toBeNull()` below passes without the fix existing. The
 * card's own heading is keyed on the solutions COUNT, so this also proves the fixture reached the
 * component rather than some other branch rendering an empty card.
 */
function solutionsCard(): HTMLElement {
	const heading = [...host.querySelectorAll('h2')].find((h) =>
		h.textContent?.trim().startsWith('challenge_detail_solutions_title')
	);
	expect(
		heading,
		'the solutions card never rendered — the page is still in its loading branch, so every ' +
			'"no CTA" assertion in this file is vacuous'
	).toBeTruthy();
	const card = heading!.closest('.card') as HTMLElement | null;
	expect(card, 'the solutions heading is not inside a .card').not.toBeNull();
	return card!;
}

function buildCta(card: HTMLElement): HTMLAnchorElement | null {
	return card.querySelector('a.build-cta');
}
/** Every anchor in the card that points into the builder — the head CTA AND the empty-state link. */
function builderLinks(card: HTMLElement): string[] {
	return [...card.querySelectorAll('a')]
		.map((a) => a.getAttribute('href') ?? '')
		.filter((h) => h.startsWith('/build'));
}
function reason(card: HTMLElement): HTMLElement | null {
	return card.querySelector('.build-blocked');
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

describe('the "Build a solution" CTA on the challenge detail page', () => {
	it('⛔ status:voting + cycleClosed:true — NO CTA anywhere, and the reason IS on screen', async () => {
		// THE MEASURED CASE, exactly as the browser showed it: the row's `status` column still says
		// `voting` (nothing maintains it on stale rows — sixteen prod challenges sat there for seven
		// weeks), and its cycle has been over since May.
		//
		// Red by reverting either CTA site to `data.status !== 'closed'`.
		const card = await render({ status: 'voting', cycleClosed: true });

		expect(
			buildCta(card),
			'"Build a solution" is still offered on a challenge whose cycle is over. Following it and ' +
				'submitting used to return 201 and file the work into the CURRENT week under a May parent.'
		).toBeNull();
		expect(
			builderLinks(card),
			'a /build link survives somewhere in the card — the empty-state "open your sandbox" link is ' +
				'the second CTA site and it is gated separately'
		).toEqual([]);

		// ⛔ THE REFUSAL IS NOT SILENCE. A CTA that simply vanishes leaves the reader looking for a
		// button that is not there; the page must say why, and name the week it is talking about.
		const why = reason(card);
		expect(why, 'the CTA is gone and nothing explains it').not.toBeNull();
		expect(why!.textContent).toContain('challenge_build_blocked_period:challenge_period_week:21,2026');

		// …and it is the way OUT (the BuildTopbar.svelte:206-212 pattern), not a dead end.
		const out = why!.querySelector('a');
		expect(out, 'the refusal names no way out').not.toBeNull();
		expect(out!.getAttribute('href')).toBe('/challenges');
		expect(out!.textContent).toContain('challenge_build_blocked_cta');
	});

	it('⛔ THE MIRROR — an OPEN challenge still gets the CTA, and no refusal', async () => {
		// TRAP (b). Without this case, deleting the CTA from the component passes every other test in
		// this file. Same fixture, one field flipped.
		const card = await render({ status: 'voting', week: LIVE_WEEK, cycleClosed: false });

		const cta = buildCta(card);
		expect(cta, 'the CTA is gone from a LIVE challenge — the fix withdrew the product').not.toBeNull();
		expect(cta!.getAttribute('href')).toBe(`/build?challenge=${CH_ID}`);
		expect(cta!.textContent).toContain('challenge_detail_build_solution');

		// The empty-state site is live too — both CTAs move together.
		expect(builderLinks(card)).toEqual([`/build?challenge=${CH_ID}`, `/build?challenge=${CH_ID}`]);
		expect(reason(card), 'a live challenge is telling the reader it takes no new solutions').toBeNull();
		expect(card.textContent).toContain('challenge_detail_solutions_empty_link');
	});

	it('⚠️ THE MONDAY WINDOW — a PAST week the server still reports OPEN keeps its CTA', async () => {
		// `weekClosedSql` reports a past week whose cycle row still says `voting` as OPEN on purpose
		// (the ~3h Monday gap, a stalled scheduler, backfillMissedCycles). The server accepts that
		// POST, so refusing it here would cost the author a completed build for a rule that does not
		// exist. Red by and-ing the wire flag with the client-side week comparison.
		const card = await render({ status: 'voting', week: DEAD_WEEK, cycleClosed: false });
		expect(buildCta(card)).not.toBeNull();
		expect(reason(card)).toBeNull();
	});

	it('MID-ROLL: no cycleClosed on the wire — the week comparison still withdraws the CTA', async () => {
		// An older server, a partial payload. `challengeState` falls back to the same comparison the
		// `past_cycle` badge already makes. Red by defaulting a missing field to "open".
		const card = await render({ status: 'voting', week: DEAD_WEEK });
		expect(buildCta(card)).toBeNull();
		expect(reason(card)!.textContent).toContain('challenge_build_blocked_period:challenge_period_week:21,2026');
	});

	it('MID-ROLL with NO CYCLE either — the CTA STAYS, because we genuinely cannot tell', async () => {
		// ⛔ THE DELIBERATE ASYMMETRY, PINNED. `/api/cycle/current` returns null whenever the engine
		// has not opened the running week, which is what prod answers today. With no wire flag and no
		// cycle there is nothing but `status`, and the honest floor is OPEN: the server guard is total
		// and its 422 explains itself, whereas a wrongly-withdrawn CTA costs a build that can never be
		// filed. Red by making an unknown state block.
		const card = await render({ status: 'voting', week: DEAD_WEEK }, null);
		expect(buildCta(card)).not.toBeNull();
		expect(reason(card)).toBeNull();
	});

	it('status:closed — still no CTA, with the un-dated refusal when the week does not parse', async () => {
		// The authoritative close, and the arm that survives from the ORIGINAL gate. The empty `week`
		// is the "Week undefined · NaN" trap: `parseIsoWeek` returns null and the unparameterised
		// message covers it.
		const card = await render({ status: 'closed', week: '', cycleClosed: true });
		expect(buildCta(card)).toBeNull();
		const why = reason(card)!;
		expect(why.textContent).toContain('challenge_build_blocked');
		expect(why.textContent).not.toContain('undefined');
		expect(why.textContent).not.toContain('NaN');
	});

	it('⛔ the refusal appears ONCE, not once per withdrawn CTA', async () => {
		// Both CTA sites live in this one card. Two copies of the same sentence a paragraph apart is
		// the noise version of honesty — and this page already carries the same fact twice (the muted
		// badge and the sidebar note).
		const card = await render({ status: 'voting', cycleClosed: true });
		expect(card.querySelectorAll('.build-blocked')).toHaveLength(1);
	});
});
