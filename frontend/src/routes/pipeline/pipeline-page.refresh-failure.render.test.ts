// @vitest-environment jsdom
//
// src/routes/pipeline/pipeline-page.refresh-failure.render.test.ts — after an action succeeds and
// the re-read fails, the board must not go on quietly showing the state before the action.
//
// ⛔ THE DEFECT, AND IT IS A CONTRADICTION RATHER THAN AN OMISSION. `move()`, `toggleReview()` and
// `rollback()` each `flash('ok', …)` and then `await load()`. `load()`'s catch wrote `error`, and
// the only branch that renders `error` was `{:else if error && !board}` — unreachable with a board
// in hand. So a 500 on the re-read produced: a green "'X' moved → Staging" toast, a kanban still
// drawn from the PRE-action payload, and nothing anywhere saying the two disagreed. The screen
// affirmatively asserted a state the server does not have, to an operator whose next act is to read
// the board and decide what to promote.
//
// ⛔ AND THE FIX IS NOT THE ONE PR #265 REMOVED. Letting the failure into the blanking chain would
// destroy the board to report a failed refresh of it — the defect that PR fixed across eight
// screens, and the reason `!board` gating is CORRECT for first paint and wrong for everything
// after. Section 3 below is the guard on that: every failure case asserts the CARDS ARE STILL ON
// SCREEN as well as the notice, so a page that rendered nothing cannot satisfy this file.
//
// ⚠️ 401/403 IS COVERED TOO, for audit's measured reason: `denied` renders OUTSIDE the chain and
// replaces the WHOLE page, so a session expiring on the `load()` that follows a successful move
// would take the board, the stats and every card with it, leaving one sentence and no control to
// retry with. Section 4.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PipelineBoard, PipelineCard, Stage } from '$lib/types/pipeline';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any), so a
// reworded translation cannot red this file and a resurrected hardcoded English string cannot pass.
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

// ⛔ `ApiError` MUST BE A REAL CLASS declared in `vi.hoisted`: `load()` does `e instanceof ApiError`
// to split 401/403 off from an ordinary failure, and two lookalike classes would make that false
// and silently reroute the refusal.
const { board, move, rollback, ApiErrorMock } = vi.hoisted(() => ({
	board: vi.fn(),
	move: vi.fn(),
	rollback: vi.fn(),
	ApiErrorMock: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/pipeline', () => ({
	ApiError: ApiErrorMock,
	pipelineApi: { board, move, rollback, enqueue: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
// The rollback path goes through a confirm dialog; auto-accept so the case under test is the
// re-read, not the dialog.
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

function card(id: string, title: string, stage: Stage = 'review'): PipelineCard {
	return {
		id,
		title,
		solutionId: null,
		challengeCode: null,
		challengeId: null,
		author: { name: 'Sam', initials: 'S' },
		stage,
		week: '2026-W32',
		rolloutPct: 0,
		progress: null,
		reviewed: false,
		reviewerCount: 0,
		reviewers: [],
		myReview: false,
		isAuthor: false,
		featured: false,
		live: stage === 'production',
		position: 1
	};
}

/** A board whose REVIEW column holds the named cards — the card titles are how each case proves
 *  the board is still on screen, so they are unique per fixture. */
function boardOf(...titles: string[]): PipelineBoard {
	const stages: Stage[] = ['review', 'hardening', 'staging', 'production'];
	return {
		columns: stages.map((stage) => ({
			stage,
			title: stage,
			count: stage === 'review' ? titles.length : 0,
			items: stage === 'review' ? titles.map((t, i) => card(`c${i}`, t)) : []
		})),
		metrics: {
			inPipeline: titles.length,
			inProduction: 0,
			rolledBack: 0,
			avgTimeToLiveDays: 0,
			liveCount: 0,
			avgTimeToLiveMs: null
		},
		policy: { mandatoryReview: true, requiredReviewers: 1 }
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function mountPage(first: PipelineBoard) {
	board.mockResolvedValueOnce(first);
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	expect(
		target.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('pipeline_loading');
}

/** The Approve button on the first card — the cheapest of the three action paths, and the one that
 *  differs from the others only in which API call precedes the re-read. */
function approveBtn(): HTMLButtonElement | undefined {
	return [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'ops_kancard_review_add'
	);
}

async function clickApprove() {
	const btn = approveBtn();
	expect(btn, 'the Approve button is not on screen, so this case tests nothing').toBeDefined();
	// ⛔ `bubbles: true` — Svelte 5 DELEGATES DOM events to the mount root, so a non-bubbling
	// synthetic click silently skips the handler and every assertion below passes for free.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

const notice = () => target.querySelector('[data-testid="pipeline-refresh-error"]');
const cardTitles = () =>
	[...target.querySelectorAll('.kan-card .kan-card-title')].map((n) => n.textContent?.trim());

/**
 * ⛔ THE POSITIVE HALF, ASSERTED IN EVERY FAILURE CASE. `expect(x).not.toBeNull()` over a page that
 * unmounted itself is not a proof of anything, so each case also reads the cards BY NAME and pins
 * the count. This is the assertion that reds if the "fix" ever becomes "blank the board".
 */
function assertBoardStillOnScreen(titles: string[], why: string) {
	expect(cardTitles(), why).toEqual(titles);
	expect(target.querySelector('.kanban'), why).not.toBeNull();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	board.mockReset();
	move.mockReset();
	rollback.mockReset();
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	vi.clearAllMocks();
});

describe('1 · a first paint that fails still blanks — the `!board` gate is CORRECT there', () => {
	it('nothing has ever loaded: the whole-page failure sentence is the whole truth', async () => {
		board.mockReset();
		board.mockRejectedValueOnce(new Error('boom'));
		component = mount(Page, { target }) as Record<string, unknown>;
		await settle();

		expect(target.textContent).toContain('pipeline_load_failed');
		// …and the refresh notice is NOT used here: there is no board to keep, so a second sentence
		// about a stale board would be a claim about content that does not exist.
		expect(notice()).toBeNull();
		expect(target.querySelector('.kanban')).toBeNull();
	});

	it('the happy path is clean: a loaded board carries no notice at all', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. Without this, "always show the notice" passes every other
		// case in this file.
		await mountPage(boardOf('Claims summariser'));
		expect(notice()).toBeNull();
		assertBoardStillOnScreen(['Claims summariser'], 'the fixture did not render');
	});
});

describe('2 · the action succeeded and the RE-READ failed', () => {
	it('THE DEFECT: the board stays, and it now says it could not be refreshed', async () => {
		await mountPage(boardOf('Claims summariser', 'Policy checker'));
		move.mockResolvedValueOnce(card('c0', 'Claims summariser'));
		board.mockRejectedValueOnce(new Error('500'));

		await clickApprove();

		// The action's own toast is still true — the review WAS recorded.
		expect(target.querySelector('.banner')?.textContent).toContain('pipeline_flash_reviewed');
		// …and the board no longer passes itself off as current.
		expect(notice()?.textContent, 'a failed re-read left the board silently stale').toContain(
			'pipeline_refresh_failed'
		);
		// ⛔ …WITHOUT DESTROYING THE BOARD. This is the #265 half.
		assertBoardStillOnScreen(
			['Claims summariser', 'Policy checker'],
			'the failed refresh blanked the board — that is the defect #265 removed, reintroduced'
		);
	});

	it('a recovered board stops apologising', async () => {
		await mountPage(boardOf('Claims summariser'));
		move.mockResolvedValueOnce(card('c0', 'Claims summariser'));
		board.mockRejectedValueOnce(new Error('500'));
		await clickApprove();
		expect(notice()).not.toBeNull();

		// Second attempt, this time the re-read lands.
		move.mockResolvedValueOnce(card('c0', 'Claims summariser'));
		board.mockResolvedValueOnce(boardOf('Claims summariser', 'Policy checker'));
		await clickApprove();

		expect(notice(), 'a stale-board caption survived the refresh that fixed it').toBeNull();
		assertBoardStillOnScreen(['Claims summariser', 'Policy checker'], 'the re-read did not land');
	});
});

describe('3 · the ACTION failing is a different thing and is unchanged', () => {
	it('a 422 governance block flashes the policy reason, and the re-sync carries no notice', async () => {
		await mountPage(boardOf('Claims summariser'));
		move.mockRejectedValueOnce(new ApiErrorMock(422, 'review_blocked', 'nope'));
		board.mockResolvedValueOnce(boardOf('Claims summariser'));

		await clickApprove();

		expect(target.querySelector('.banner')?.textContent).toContain('error_action_failed');
		// The re-sync SUCCEEDED, so there is nothing stale to caption.
		expect(notice()).toBeNull();
		assertBoardStillOnScreen(['Claims summariser'], 'the re-sync did not land');
	});
});

describe('4 · a session that expires on the re-read does not take the board with it', () => {
	it('a 403 after a successful action is reported as a failed refresh, not as a locked door', async () => {
		await mountPage(boardOf('Claims summariser'));
		move.mockResolvedValueOnce(card('c0', 'Claims summariser'));
		board.mockRejectedValueOnce(new ApiErrorMock(403, 'forbidden', 'no'));

		await clickApprove();

		expect(notice()?.textContent).toContain('pipeline_refresh_failed');
		// …and it names the refusal INSIDE that sentence rather than as the page.
		expect(notice()?.textContent).toContain('pipeline_denied');
		assertBoardStillOnScreen(
			['Claims summariser'],
			'a mid-session 403 replaced the whole page — board, stats and every card'
		);
	});

	it('but a 403 on FIRST paint is still the whole page: there is no board to keep', async () => {
		board.mockReset();
		board.mockRejectedValueOnce(new ApiErrorMock(401, 'unauthorized', 'no'));
		component = mount(Page, { target }) as Record<string, unknown>;
		await settle();

		expect(target.textContent).toContain('pipeline_denied');
		expect(notice()).toBeNull();
	});
});
