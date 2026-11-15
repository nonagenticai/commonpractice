// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.open-in-build.render.test.ts — "Open in Build" must not
// hand the builder a challenge that will refuse the submission.
//
// ⛔ WHAT THIS LINK ACTUALLY DOES. `?challenge=` is what ARMS /build's Submit: with no challenge in
// context BuildTopbar disables the primary action and says so, and with one it is live. This anchor
// appended `&challenge=<parent id>` UNCONDITIONALLY — so opening any solution whose parent challenge
// had finished dropped the reader into a builder whose Submit looked available and could only
// answer `422 challenge_closed`. It is the challenge page's "Build a solution" defect, one screen
// further along, and it survives every fix made to that page.
//
// ⛔ THE ANCHOR ITSELF STAYS, IN BOTH CASES. Landing in /build with no challenge is the DESIGNED
// empty state, not a degradation: BuildTopbar.svelte:209-212 renders `build_submit_needs_challenge`
// as a LINK to the board, so the refusal names its own way out. Deleting the anchor instead would
// take away the flow the reader actually clicked for, to solve a problem about the parameter.
//
// ⛔ VACUITY TRAPS THIS FILE IS BUILT AGAINST — the scaffolding is copied from
// `../../challenges/[id]/challenge-detail.lifecycle.render.test.ts:23-33,65-93` and the sibling
// `solution-detail.vote-control.render.test.ts`:
//   (a) `load()` awaits `solutionsApi.get` and `cycleApi.current`, and the page imports the runs /
//       delivery / sse / auth modules at module scope (`RunApiError` is used with `instanceof`, so
//       it must be a real class). One unstubbed module and the page never leaves its loading branch,
//       `querySelector` returns null, and "the href has no challenge=" passes for free. Every case
//       goes through `openInBuild()`, which asserts the ANCHOR EXISTS first.
//   (b) The anchor is asserted present in BOTH directions, so "delete the link" cannot pass.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeStatus } from '$lib/types/challenges';
import type { SolutionDetail } from '$lib/types/solutions';

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
	page: { params: { id: 'sol-oib-1' }, url: new URL('http://localhost/solutions/sol-oib-1') }
}));
const SOL_ID = 'sol-oib-1';
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
// ⛔ TRAP (a). `RunApiError` must be a real class — the page does `e instanceof RunApiError`.
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
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isTenantAdmin: false } }));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));

import Page from './+page.svelte';

const CH_ID = '00000000-0000-4000-8000-0000000000c1';
const FLOW_ID = '00000000-0000-4000-8000-0000000000f1';

/**
 * ⛔ `flow` IS NON-NULL IN EVERY FIXTURE — the anchor lives inside `{#if data.flow}`, so a null flow
 * would remove it and make every case in this file vacuous in the other direction. And `challenge`
 * carries a week DIFFERENT from the solution's: they are facts about two different cycles, and this
 * link is about the PARENT's.
 */
function detail(parentClosed: boolean | undefined, challengeStatus: ChallengeStatus = 'voting'): SolutionDetail {
	const challenge: NonNullable<SolutionDetail['challenge']> = {
		id: CH_ID,
		code: 'CH-284',
		title: 'Claims intake',
		status: challengeStatus,
		week: '2026-W21'
	};
	// Assigned rather than spread as `undefined`, so the MID-ROLL case genuinely omits the key.
	if (parentClosed !== undefined) challenge.cycleClosed = parentClosed;
	return {
		id: SOL_ID,
		title: 'Claim summary in three blocks',
		status: 'voting',
		// The SOLUTION's own competing week — never the parent's. `cycleClosed` beside it is the VOTE
		// gate for this row and has nothing to do with the link under test.
		week: '2026-W33',
		cycleClosed: false,
		votesCount: 7,
		hasVoted: false,
		demoMs: 0,
		blocksUsed: [],
		createdAt: '2026-08-10T00:00:00.000Z',
		author: { name: 'Ava Author', initials: 'AA' },
		challenge,
		flow: { id: FLOW_ID, name: 'Claim summariser', chain: ['read-pdf', 'summarise'] },
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

async function render(parentClosed: boolean | undefined, challengeStatus: ChallengeStatus = 'voting') {
	getSolution.mockResolvedValue(detail(parentClosed, challengeStatus));
	currentCycle.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	return openInBuild();
}

/**
 * The "Open in Build" anchor — AFTER proving it is on screen.
 *
 * ⛔ TRAP (a)+(b), THE POSITIVE MARKER. On an unmounted page this returns null and
 * `expect(href).not.toContain('challenge=')` would pass with no fix at all; and a fix that simply
 * DELETED the anchor would pass the same way. Failing loudly here is what makes every href
 * assertion below evidence about a rendered link.
 */
function openInBuild(): HTMLAnchorElement {
	const a = host.querySelector('a.open-build') as HTMLAnchorElement | null;
	expect(
		a,
		'no "Open in Build" anchor on the page — either the page is still loading (every assertion ' +
			'in this file is then vacuous) or the link was removed, which takes away the flow the ' +
			'reader clicked for instead of the parameter that misfires'
	).not.toBeNull();
	expect(a!.textContent).toContain('solution_detail_open_in_build');
	return a!;
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

describe('"Open in Build" on the solution detail page', () => {
	it('⛔ parent cycle CLOSED — the link stays, the challenge= parameter is DROPPED', async () => {
		// The headline case, and note `status: 'voting'`: this is a parent the status column still
		// calls live. Red by restoring `data.challenge ? \`&challenge=${data.challenge.id}\` : ''`.
		const a = await render(true);
		const href = a.getAttribute('href')!;

		expect(
			href,
			'"Open in Build" still arms Submit with a challenge whose cycle is over. The reader ' +
				'finishes a build and the server answers 422 challenge_closed.'
		).not.toContain('challenge=');
		expect(href).not.toContain(CH_ID);
		// The flow — the thing actually being opened — is untouched.
		expect(href).toBe(`/build?id=${FLOW_ID}`);
	});

	it('⛔ THE MIRROR — parent cycle OPEN, the parameter IS carried', async () => {
		// Without this, deleting the parameter unconditionally passes the case above. `?challenge=` is
		// what makes /build's Submit reachable at all, so dropping it always would break the ONE flow
		// this whole workstream is trying to keep enterable.
		const a = await render(false);
		expect(a.getAttribute('href')).toBe(`/build?id=${FLOW_ID}&challenge=${CH_ID}`);
	});

	it('the anchor is present in BOTH cases — the refusal is a narrower link, not a missing one', async () => {
		// Asserted explicitly rather than as a side effect of `openInBuild()`, because "landing in
		// /build with no challenge" is a DESIGNED state: BuildTopbar renders
		// `build_submit_needs_challenge` there as a link to the board.
		for (const closed of [true, false]) {
			const a = await render(closed);
			expect(a.getAttribute('href'), `closed=${closed}`).toContain(`/build?id=${FLOW_ID}`);
			if (app) unmount(app);
			app = null;
			host.innerHTML = '';
			vi.clearAllMocks();
		}
	});

	it('MID-ROLL: no cycleClosed on the parent — the parameter is carried', async () => {
		// ⛔ THE SAME ASYMMETRY /build's fetch `catch` documents, and it must NOT be "fixed" to match
		// `solution-state.ts`'s unknown ⇒ blocked. An older server omitting the field must not strip a
		// working link: the cost of the wrong guess here is one honest 422 at the end, while the cost
		// of the other wrong guess is a Submit button that can never be armed.
		const a = await render(undefined);
		expect(a.getAttribute('href')).toBe(`/build?id=${FLOW_ID}&challenge=${CH_ID}`);
	});

	it('⚠️ reads cycleClosed and NOT the parent\'s status column — they disagree, both ways', async () => {
		// `status` lags the cycle by up to a tick: prod's CH-284 sat at 'voting' for eight hours after
		// its June cycle died. And the reverse — an authoritative `status: 'closed'` — is already
		// covered by `cycleClosed`, since the backend's `challengeClosedSql` ORs the two. A page wired
		// to `status` would get the first of these wrong.
		expect((await render(true, 'voting')).getAttribute('href')).not.toContain('challenge=');
		if (app) unmount(app);
		app = null;
		host.innerHTML = '';
		vi.clearAllMocks();
		expect((await render(false, 'solution_phase')).getAttribute('href')).toContain(`challenge=${CH_ID}`);
	});
});
