// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.vote-control.render.test.ts — the SOLUTION DETAIL
// screen's vote surface must follow the SOLUTION'S OWN COMPETING CYCLE (`cycleClosed`), exactly as
// the board does.
//
// ⛔ WHY THIS FILE EXISTS: THE BOARD WAS COVERED AND THIS SCREEN WAS NOT. An adversarial review of
// the votability change reverted `+page.svelte`'s third `solutionState` argument from
// `data.cycleClosed ?? null` back to `data.challenge?.status === 'closed'` — the retired rule that
// produced nine consecutive winnerless weeks — and the frontend suite stayed at 65/65. The sibling
// `../solutions-page.vote-control.render.test.ts` reds four ways against the same revert on the
// board; this screen renders the same pill, from the same helper, off a DIFFERENT DTO
// (`SolutionDetail`, which carries a full `challenge` object the list DTO does not have), and
// nothing watched it.
//
// The decisive case is the one the parent-challenge rule cannot express: `challenge.status:
// 'closed'` together with `cycleClosed: false` must render a LIVE pill. That is prod's 2026-W33
// entry — filed into the running week, answering a 2026-W23 challenge that `healOrphanedChallenges`
// correctly closed hours later.
//
// Conventions copied from the board's render test: the real `en` catalog with each key resolving to
// its own name (so a reworded translation cannot red these and a resurrected English label cannot
// pass them), ALIAS module ids in every `vi.mock`, and `status: 'voting'` on every fixture so
// `cycleClosed` is the only thing that varies.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeStatus } from '$lib/types/challenges';
import type { SolutionDetail } from '$lib/types/solutions';

// Real `en` catalog, each key resolving to its own name — see the sibling board render test.
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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file,
// so referencing `SOL_ID` here throws "cannot access before initialization" at collect time.
vi.mock('$app/state', () => ({
	page: { params: { id: 'sol-detail-1' }, url: new URL('http://localhost/solutions/sol-detail-1') }
}));
const SOL_ID = 'sol-detail-1';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getSolution, currentCycle } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	currentCycle: vi.fn()
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
// The "Try it" pipeline and the delivery card are out of frame here, but the component imports them
// at module scope. `RunApiError` must be a real class — the page does `e instanceof RunApiError`.
vi.mock('$lib/api/runs', () => ({
	RunApiError: class RunApiError extends Error {},
	runsApi: {
		getMySandbox: vi.fn().mockResolvedValue(null),
		startSolution: vi.fn(),
		resumeMySandbox: vi.fn()
	}
}));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: vi.fn().mockResolvedValue([]),
		listForSolution: vi.fn().mockResolvedValue([]),
		forward: vi.fn(),
		retry: vi.fn()
	}
}));
// Not a tenant_admin: the delivery card is a different screen's subject.
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isTenantAdmin: false } }));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));

import Page from './+page.svelte';

const CH_ID = '00000000-0000-4000-8000-0000000000c1';
/** The solution's OWN competing week. Never equal to a live cycle's week in this file — the
 *  countdown is the board test's subject, and a fixed fixture week keeps these cases about the gate
 *  alone. */
const SOLUTION_WEEK = '2099-W60';

/**
 * ⛔ `challenge` HERE IS THE FULL OBJECT — `{id, code, title, status, week}` — which is exactly what
 * makes this screen a separate risk from the board. The list DTO carries the parent's status as a
 * flat per-row `challengeStatus`; the detail DTO nests a whole challenge, and `data.challenge.status`
 * is one keystroke away from being read as the vote gate again. Its `week` is deliberately a
 * DIFFERENT week from the solution's: they are facts about two different cycles.
 */
function detail(cycleClosed: boolean | null, challengeStatus: ChallengeStatus = 'closed'): SolutionDetail {
	return {
		id: SOL_ID,
		title: 'Claim summary in three blocks',
		// Always 'voting': `closeCycle` flips only the WINNER to 'shipping' and leaves every loser at
		// 'voting' forever, so this column can never carry the answer.
		status: 'voting',
		week: SOLUTION_WEEK,
		// `as never` only for the deliberate mid-roll case (`null`/omitted): the DTO types this as a
		// real boolean, and the point of that test is what the page does when the wire disagrees.
		cycleClosed: cycleClosed as never,
		votesCount: 7,
		hasVoted: false,
		// ⛔ `0`, NOT A POSITIVE NUMBER, AND NOT NULL. This fixture is the entire non-vacuity of the
		// demo-duration guard on the row: the board used to test `{#if row.demoSeconds}`, and a
		// truthiness check passes and fails identically to `!= null` for every value EXCEPT a genuine
		// zero. With `demoMs: 42` this file would go green against the reverted guard and prove
		// nothing. A run measured at 0 ms is data — an answer, not the absence of one.
		demoMs: 0,
		blocksUsed: [],
		createdAt: '2099-01-01T00:00:00.000Z',
		author: { name: 'Ava Author', initials: 'AA' },
		challenge: { id: CH_ID, code: 'CH-284', title: 'Claims intake', status: challengeStatus, week: '2098-W23' },
		flow: null,
		comparison: []
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(cycleClosed: boolean | null, challengeStatus: ChallengeStatus = 'closed') {
	getSolution.mockResolvedValue(detail(cycleClosed, challengeStatus));
	// No live cycle — prod's own answer today, and the branch that must not resurrect a deadline.
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	const pill = host.querySelector('button.vote') as HTMLButtonElement | null;
	expect(pill, 'the detail page rendered no vote pill, so this file tests nothing').not.toBeNull();
	return pill!;
}

const wrapTitle = () => host.querySelector('.vote-wrap')?.getAttribute('title') ?? null;
const badge = () => host.querySelector('.badges .badge.coral') as HTMLElement | null;
const voteNote = () => host.querySelector('.vote-note')?.textContent?.trim() ?? '';

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

describe('the vote control on the solution detail page', () => {
	it('⛔ a CLOSED PARENT with a LIVE CYCLE renders a LIVE pill — the row that broke nine weeks', async () => {
		// THE DECISIVE CASE, and the one the reverted wiring (`data.challenge?.status === 'closed'`)
		// gets backwards: an inert pill on the only entry in the open week is precisely how the tenth
		// consecutive winnerless week was guaranteed.
		const pill = await render(false, 'closed');
		expect(pill.disabled).toBe(false);
		expect(pill.className).not.toContain('blocked');
		expect(wrapTitle()).toBeNull();
		// The pill above it must agree: `muted` is driven off `votability`, so a coral badge over a
		// dead button (or a grey one over a live button) is the same defect in the other direction.
		expect(badge()?.className).not.toContain('muted');
		// …and the sentence under it describes what votes DO, rather than announcing a closure.
		expect(voteNote()).toBe('solution_detail_vote_note_ranking');
	});

	it('⛔ a CLOSED CYCLE makes the pill inert, though the solution still says `voting` and its parent is OPEN', async () => {
		// The mirror image. The parent is left at 'voting' on purpose: it is not what is being read,
		// in either direction.
		const pill = await render(true, 'voting');
		expect(pill.disabled).toBe(true);
		expect(pill.className).toContain('blocked');
		expect(badge()?.className).toContain('muted');
		// The reason names the WEEK. `solution_vote_note_parent_closed` is retired (it named the
		// challenge, which no longer decides this) and `solution_detail_vote_note_closed` would claim
		// the solution's own row closed, which is false — its status column still says `voting`.
		expect(wrapTitle()).toBe('solution_vote_note_cycle_closed');
		expect(voteNote()).toBe('solution_vote_note_cycle_closed');
	});

	it('⛔ a MISSING cycleClosed ALSO makes the pill inert, and says COULD NOT TELL — not "closed"', async () => {
		// The mid-roll shape: an older server answering without the field. The gate lives in
		// `marketplace_cycles` and no client query reaches it, so the page cannot fill the blank; a
		// live pill on an unverified row is the worst of the three outcomes. This is what the `?? null`
		// on the call site preserves.
		const pill = await render(null, 'voting');
		expect(pill.disabled).toBe(true);
		expect(pill.className).toContain('blocked');
		expect(wrapTitle()).toBe('solution_vote_note_votability_unknown');
		expect(wrapTitle()).not.toBe('solution_vote_note_cycle_closed');
	});

	it('the parent’s status alone moves NOTHING — every status, one live cycle gate', async () => {
		// The strongest form of "it is not reading `data.challenge.status`": hold the gate open and
		// sweep the parent across every status it can have.
		for (const parent of ['voting', 'solution_phase', 'closed'] as const) {
			const pill = await render(false, parent);
			expect(pill.disabled, `parent=${parent} must not block a live cycle`).toBe(false);
			expect(pill.className).not.toContain('blocked');
			expect(wrapTitle(), `parent=${parent} must leave the pill unexplained, because it is live`).toBeNull();
			if (app) unmount(app);
			app = null;
			host.innerHTML = '';
			vi.clearAllMocks();
		}
	});

	it('renders no invented deadline anywhere on the page', async () => {
		// #231's fiction, on the screen it was baked into: with no live cycle there is no boundary to
		// quote, and nothing may invent one.
		await render(false, 'voting');
		expect(host.textContent).not.toContain('18:00');
		expect(host.textContent).not.toContain('undefined');
		expect(host.textContent).not.toContain('NaN');
	});
});
