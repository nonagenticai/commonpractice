// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.lifecycle.render.test.ts — the four-step lifecycle
// card must reach step 4.
//
// ⛔ WHY THIS FILE EXISTS. The card's markup could only ever colour two of its four steps:
//
//   :352  <li class="done">                                            Submitted   — a literal
//   :353  <li class={data.status === 'voting' ? 'active' : 'done'}>    In voting
//   :354  <li class={data.status === 'solution_phase' ? 'active' : ''}> Solution phase — never 'done'
//   :355  <li>                                                          Winner      — NO class, EVER
//
// and a classless `<li>` leaves `.dot` on its base `--c-border-strong`, which is the grey that means
// "has not happened". `challenge_status` is `('voting','solution_phase','closed')` and `closed`
// dominates the live board, so the common case drew its last TWO steps as never-happened. Nothing
// watched this: `challenge-state.test.ts` covers the pill and the vote note, and the card is not
// reachable from either.
//
// The unit suite (`$lib/challenges/challenge-lifecycle.test.ts`) proves the truth table. THIS file
// proves the page is wired to it — that the classes actually land on the four `<li>` and that the
// state is on screen as a word, not only as a dot colour.
//
// ⛔ VACUITY TRAPS THIS FILE IS BUILT AGAINST:
//   (a) `load()` awaits `challengesApi.get`, `challengesApi.comments` AND `cycleApi.current`, and
//       `startEditData` reaches for `$lib/api/datasets`. A single unstubbed module rejects the
//       Promise.all, the page never leaves its `{#if loading && !data}` branch, `host.querySelectorAll`
//       returns EMPTY, and every `expect([]).not.toContain(…)` style assertion passes for free. So
//       `steps()` asserts a POSITIVE MARKER first: exactly four `<li>` under `.timeline`, and the
//       lifecycle heading present.
//   (b) An sr-only span is invisible by construction, so its absence is invisible too. Asserted
//       explicitly per case.
//
// Conventions copied from `routes/solutions/[id]/solution-detail.vote-control.render.test.ts:24-75`:
// the REAL `en` catalog with every key resolving to its own name (a reworded translation cannot red
// these, and a resurrected hardcoded English label cannot pass them), and ALIAS module ids in every
// `vi.mock`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail, ChallengeStatus } from '$lib/types/challenges';
import type { SolutionStatus } from '$lib/types/solutions';

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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'ch-detail-1' }, url: new URL('http://localhost/challenges/ch-detail-1') }
}));
const CH_ID = 'ch-detail-1';
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
// ⛔ TRAP (a), SECOND THIRD. `cycleApi.current()` is inside the same `Promise.all` as the challenge
// fetch. It carries `.catch(() => null)` on the call site, so an unstubbed module would NOT reject
// the load — it would throw at IMPORT time instead. Stub it and answer `null`, which is what prod
// answers today (no `marketplace_cycles` row for the running week).
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
// ⛔ TRAP (a), FINAL THIRD. Not on the load path — it is reached by `startEditData` — but it is a
// module-scope import of the component under test.
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

/** One solution row, with only the field the lifecycle reads varying. */
function solution(status: SolutionStatus, n: number) {
	return {
		id: `sol-${n}`,
		title: `Solution ${n}`,
		status,
		votesCount: 3,
		rank: n,
		demoSeconds: null,
		blocksUsed: [],
		hasVoted: false,
		author: { name: 'Ava Author', initials: 'AA' }
	};
}

/**
 * ⛔ `week` IS A PAST WEEK AND `cycleApi.current` ANSWERS `null` IN EVERY CASE. The lifecycle card
 * must not move when the clock does — `challengeState` (the pill, the vote note) is the module that
 * consults the cycle, and holding the cycle fixed here keeps these four cases about `status` and
 * `solutions[].status` alone.
 */
function detail(status: ChallengeStatus, solutions: SolutionStatus[]): ChallengeDetail {
	return {
		id: CH_ID,
		code: 'CH-101',
		title: 'Claims intake takes four days',
		description: 'A description.',
		businessImpact: '',
		workArea: 'Claims',
		status,
		week: '2026-W23',
		tags: [],
		metrics: {},
		votesCount: 12,
		hasVoted: false,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-06-01T00:00:00.000Z',
		commentCount: 0,
		datasets: [],
		canEditDatasets: false,
		involves: [],
		solutions: solutions.map((s, i) => solution(s, i + 1)),
		similar: []
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(status: ChallengeStatus, solutions: SolutionStatus[]) {
	getChallenge.mockResolvedValue(detail(status, solutions));
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * The four step classes, in document order — AFTER proving the card is actually on screen.
 *
 * ⛔ THE POSITIVE MARKER IS THE WHOLE POINT (trap (a)). If `load()` rejects, the page stays in its
 * loading branch and this returns `[]`; `expect([]).toEqual([…])` would red, but the class-CONTENT
 * assertions elsewhere ("not grey", "no empty class") would all pass vacuously. Failing loudly here
 * means no later assertion can be interpreted as evidence about an unmounted page.
 */
function steps(): string[] {
	const heading = [...host.querySelectorAll('h3')].some(
		(h) => h.textContent?.trim() === 'challenge_detail_lifecycle'
	);
	expect(heading, 'the lifecycle card never rendered — the page is still loading, so this test is vacuous').toBe(true);
	const li = [...host.querySelectorAll('.timeline li')];
	expect(li, 'the timeline must draw exactly four steps').toHaveLength(4);
	// ⛔ STRIP THE `svelte-<hash>` SCOPING TOKEN, and strip ONLY that. The compiler stamps it on every
	// element a scoped rule can match, so it is present even on an `<li>` the author gave no class —
	// which means a naive `getAttribute('class')` would read `'svelte-abc123'` for the ORIGINAL bug
	// and never equal `''`. Filtering it back out is what keeps "no step is ever classless" a real
	// assertion. The hash changes with the component's CSS, so it is matched by prefix, never pinned.
	return li.map((el) =>
		(el.getAttribute('class') ?? '')
			.split(/\s+/)
			.filter((t) => t && !t.startsWith('svelte-'))
			.join(' ')
	);
}

/** All sr-only state words on the card, in document order. */
function stateWords(): string[] {
	return [...host.querySelectorAll('.timeline .sr-only')].map((el) => el.textContent?.trim() ?? '');
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

describe('the lifecycle card on the challenge detail page', () => {
	it('⛔ CLOSED with a SHIPPING solution — all four steps done, INCLUDING the last one', async () => {
		// THE HEADLINE CASE. Red by restoring `:355` to a classless `<li><span class="dot">…` — the
		// class list becomes `done,done,done,` and the final `''` fails. Also red by restoring `:354`
		// (`status === 'solution_phase' ? 'active' : ''`), which empties the third entry too.
		await render('closed', ['voting', 'shipping']);
		expect(steps()).toEqual(['done', 'done', 'done', 'done']);
		// ⛔ TRAP (b): the state must also be READABLE, not only teal. Red by deleting the
		// `<span class="sr-only">` from any of the four `<li>`.
		expect(stateWords()).toEqual([
			'challenge_lc_state_done',
			'challenge_lc_state_done',
			'challenge_lc_state_done',
			'challenge_lc_state_done'
		]);
		// And the sub-label under step 4 reports a RELEASE, not the neutral "IT reviews…" promise.
		// Red by: `lifecycleWinnerSubLabel` returning `m.challenge_detail_lc_winner_sub()` for 'done'.
		expect(host.textContent).toContain('challenge_detail_lc_winner_sub_shipped');
	});

	it('⛔ CLOSED with NOTHING shipped — step 4 is TERMINAL, neither teal nor the pending grey', async () => {
		// The dominant live state, and the one both rejected designs get wrong. Red by restoring
		// `:355` (→ `done,done,done,`), and separately by collapsing `not_reached_terminal → 'pending'`
		// in `lifecycleStepClass` (→ `done,done,done,pending`, the original grey under a new name).
		await render('closed', ['voting', 'voting', 'archived', 'draft']);
		expect(steps()).toEqual(['done', 'done', 'done', 'terminal']);
		// ⛔ `draft` and `archived` in the fixture are the negative-predicate trap: a
		// `status !== 'voting'` reading of `hasShippingSolution` would tick this step. Red by that edit.
		expect(steps()[3]).not.toBe('done');
		expect(stateWords()[3]).toBe('challenge_lc_state_not_reached');
		// ⛔ THE COPY MUST NOT SAY "won" — `hasShippingSolution` means "reached production", which is a
		// weaker claim than winning a week (`enqueueWinner` has a super_admin manual caller at
		// backend/src/routes/pipeline.ts:561, rollback returns a genuine winner to 'voting' at :399/:524,
		// and `data.solutions[]` spans weeks). Red by pointing the terminal arm at any key whose `en`
		// value names a winner.
		expect(host.textContent).toContain('challenge_detail_lc_winner_sub_none');
		expect(host.textContent).not.toContain('challenge_detail_lc_winner_sub_shipped');
	});

	it('VOTING — one active step, and the two ahead of it are PENDING rather than classless', async () => {
		// Red by restoring `:354`+`:355`: the list becomes `done,active,,` — the two empty strings are
		// exactly the implicit third state this change removes.
		await render('voting', []);
		expect(steps()).toEqual(['done', 'active', 'pending', 'pending']);
		expect(steps()).not.toContain('');
		expect(stateWords()).toEqual([
			'challenge_lc_state_done',
			'challenge_lc_state_active',
			'challenge_lc_state_pending',
			'challenge_lc_state_pending'
		]);
		// An OPEN challenge never announces an outcome. Both outcome keys are excluded by name — the
		// neutral key is a PREFIX of both, so `toContain('…winner_sub')` alone proves nothing.
		expect(host.textContent).toContain('challenge_detail_lc_winner_sub');
		expect(host.textContent).not.toContain('challenge_detail_lc_winner_sub_none');
		expect(host.textContent).not.toContain('challenge_detail_lc_winner_sub_shipped');
	});

	it('⛔ VOTING with a SHIPPING solution — step 4 stays PENDING; an open challenge has not finished', async () => {
		// A solution can be shipping under an open parent (the manual super_admin enqueue; a
		// multi-week `solutions[]`). Red by letting `shipped` decide step 4 outside the closed branch.
		await render('voting', ['shipping']);
		expect(steps()).toEqual(['done', 'active', 'pending', 'pending']);
		expect(host.textContent).not.toContain('challenge_detail_lc_winner_sub_shipped');
	});

	it('SOLUTION_PHASE — step 2 is DONE, which the old markup could produce, and step 3 is active', async () => {
		// Red by restoring `:354` (third entry becomes 'active' still — so this case ALONE does not
		// catch the old bug, which is exactly why the closed cases above exist) and `:355` (fourth
		// becomes '').
		await render('solution_phase', ['voting']);
		expect(steps()).toEqual(['done', 'done', 'active', 'pending']);
		expect(stateWords()[2]).toBe('challenge_lc_state_active');
		expect(stateWords()[3]).toBe('challenge_lc_state_pending');
	});

	it('⛔ no step is EVER classless, across every status the enum has', async () => {
		// The single property the original markup violated in every state. Red by restoring `:355`
		// alone: the fourth entry is `''` in all three sweeps.
		for (const status of ['voting', 'solution_phase', 'closed'] as const) {
			await render(status, []);
			const cls = steps();
			expect(cls, `status=${status}`).toHaveLength(4);
			for (const c of cls) expect(c, `status=${status} produced a classless step`).not.toBe('');
			expect(stateWords(), `status=${status}`).toHaveLength(4);
			if (app) unmount(app);
			app = null;
			host.innerHTML = '';
			vi.clearAllMocks();
		}
	});
});

describe('⛔ cadence OFF: no winners, so no "IT reviews the winning solution" step', () => {
	// Found by a browser walk on 2026-10-14: with the cycle off, the panel still promised a winner
	// review that the engine will never run. Red by removing the `{#if lifecycleShowsWinnerStep(…)}`
	// wrapper around step 4 in +page.svelte: the fourth `<li>` and its pending sentence come back.
	afterEach(async () => {
		const { auth } = await import('$lib/stores/auth.svelte');
		auth.user = null;
	});

	async function asCadence(cadence: 'off' | 'week') {
		const { auth } = await import('$lib/stores/auth.svelte');
		auth.user = { cycleCadence: cadence } as typeof auth.user;
	}

	it('off + still open: three steps, and the winner sentence is nowhere on the page', async () => {
		await asCadence('off');
		await render('voting', ['voting']);
		expect(host.querySelector('.timeline'), 'the lifecycle card never rendered').not.toBeNull();
		expect(host.querySelectorAll('.timeline li')).toHaveLength(3);
		expect(host.textContent).not.toContain('challenge_detail_lc_winner_sub');
		expect(host.textContent).not.toContain('challenge_detail_lc_winner');
	});

	it('off + a solution in production: the step stays — shipping is a fact, not a cycle claim', async () => {
		await asCadence('off');
		await render('closed', ['shipping']);
		expect(host.querySelectorAll('.timeline li')).toHaveLength(4);
		expect(host.textContent).toContain('challenge_detail_lc_winner_sub_shipped');
	});

	it('week (control): the step is drawn as before', async () => {
		await asCadence('week');
		await render('voting', ['voting']);
		expect(host.querySelectorAll('.timeline li')).toHaveLength(4);
		expect(host.textContent).toContain('challenge_detail_lc_winner_sub');
	});
});
