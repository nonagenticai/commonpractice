// @vitest-environment jsdom
//
// src/routes/solutions/solution-detail.refusal-reset.svelte.test.ts — a refusal about solution A,
// left sitting on solution B.
//
// ⛔ THE DEFECT. SvelteKit reuses this component across /solutions/A → /solutions/B, so the page has
// a route-param `$effect` that resets its state. It resets `data`, `runError`, `runCanResume`,
// `dataFindings`, `runTrace`, `selectedTargetId`, `deliveries` and `backlogTargets` — and NOT
// `voteError` or `forwardError`. `voteError` renders ABOVE the loading/error gates, so it survives
// the navigation and sits over solution B's skeleton, described as B's.
//
// ⛔ `deliveryError` IS DELIBERATELY NOT PART OF THIS. It already has a writer that clears it —
// `loadDelivery()`'s first line — and the effect calls `loadDelivery()`. A second reset would be a
// duplicate writer on state that is already correct; the last case here drives that path to show the
// existing one is sufficient, so nobody adds one later "for symmetry".
//
// ⛔ IT IS A `.svelte.test.ts` (note the infix) so vite-plugin-svelte compiles it as a rune module.
// `id` is `$derived(page.params.id)`, so only a `$state`-backed `$app/state` mock re-fires the
// route effect — which IS the mechanism under test. Same technique as
// `routes/build/build-page.failed-switch.svelte.test.ts`.
//
// ⛔ AND THE REFUSALS ARE REAL. `$lib/api/solutions` and `$lib/api/delivery` are not mocked; only
// `$lib/api/auth-fetch` is, answering real `Response` objects, so `voteError` and `forwardError` are
// filled from the errors those clients actually throw.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionDetail } from '$lib/types/solutions';

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
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

// The reactive route. Built INSIDE the factory: `vi.hoisted` runs before this module's imports are
// initialized and `$state` compiles to a call into the Svelte client runtime, so it cannot live
// there. The test reads the same proxy back through the static import below.
vi.mock('$app/state', () => {
	const page = $state({
		url: new URL('http://localhost/solutions/sol-a'),
		params: { id: 'sol-a' }
	});
	return { page };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/services/sse', () => ({ streamRun: () => ({ close: () => {} }), parseBlock: () => null }));
// ⛔ THE GATE. The delivery card is inside `{#if auth.isTenantAdmin}` and `loadDelivery()` returns
// at its first line without it — the forward half of this file would test an absent DOM.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		isTenantAdmin: true,
		isSuperAdmin: false,
		isDeveloper: false,
		user: { id: 'u-1', name: 'Mary de Vries', roles: ['tenant_admin'] }
	}
}));

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { page } from '$app/state';
import * as m from '$lib/paraglide/messages';
/** The same `$state` proxy the factory returned, re-typed: SvelteKit's `page.url` carries a literal
 *  `pathname` union that only the real router can satisfy, and this file only ever writes it. */
const route = page as unknown as { url: URL; params: { id: string } };
import Page from './[id]/+page.svelte';

const A = 'sol-a';
const B = 'sol-b';

/** Per-solution replies, so a navigation really does change what the API answers. */
let voteStatus = 500;
let targetsStatus = 200;
let forwardStatus = 500;
let wire: string[] = [];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function solution(id: string, title: string): SolutionDetail {
	return {
		id,
		title,
		status: 'voting',
		week: '2026-W34',
		cycleClosed: false,
		votesCount: 3,
		hasVoted: false,
		demoMs: 1200,
		blocksUsed: [],
		createdAt: '2026-08-14T09:00:00.000Z',
		author: { name: 'Mary de Vries', initials: 'MV' } as SolutionDetail['author'],
		challenge: null,
		flow: null,
		comparison: []
	};
}
const TARGET = {
	id: 't-1',
	name: 'Backlog',
	kind: 'jira',
	enabled: true,
	config: {},
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-01T00:00:00.000Z'
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const voteButton = () => host.querySelector('button.vote') as HTMLButtonElement | null;
const forwardButton = () => host.querySelector('button.btn-forward') as HTMLButtonElement | null;
const title = () => host.querySelector('h1')?.textContent?.trim() ?? null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	wire = [];
	voteStatus = 500;
	targetsStatus = 200;
	forwardStatus = 500;
	route.url = new URL(`http://localhost/solutions/${A}`);
	route.params = { id: A };
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		wire.push(`${method} ${url}`);
		if (url.endsWith('/vote')) return json({ error: 'vote_failed' }, voteStatus);
		if (url.endsWith('/forward')) return json({ error: 'forward_failed' }, forwardStatus);
		if (url === `/api/solutions/${A}`) return json(solution(A, 'Claims triage'));
		if (url === `/api/solutions/${B}`) return json(solution(B, 'Invoice matcher'));
		if (url.endsWith('/deliveries')) return json({ deliveries: [] });
		if (url === '/api/delivery-targets')
			return json(
				targetsStatus === 200 ? { targets: [TARGET] } : { error: 'internal_error' },
				targetsStatus
			);
		if (url === '/api/cycle/current') return json(null);
		if (url === '/api/sandboxes/me') return json(null);
		return json({ items: [], total: 0 });
	});
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	authFetch.mockReset();
});

/** Mount on solution A and wait for the detail to render. */
async function mountOnA() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	// ⛔ POSITIVE ANCHOR. A page still on its skeleton answers every "…is gone" for free.
	expect(title(), 'solution A never loaded').toBe('Claims triage');
}

/** The SvelteKit navigation this component survives: same instance, new route param. */
async function navigateToB() {
	route.url = new URL(`http://localhost/solutions/${B}`);
	route.params = { id: B };
	await settle();
	await settle();
}

describe('/solutions/[id] does not carry one solution’s refusal onto the next', () => {
	it('⛔ THE DEFECT: a failed vote on A is still on screen on B', async () => {
		await mountOnA();
		const btn = voteButton();
		expect(btn, 'the vote control never rendered').toBeTruthy();
		expect(btn!.disabled, 'the vote control is blocked — this case tests nothing').toBe(false);
		click(btn!);
		await settle();
		expect(
			wire.some((c) => c === `POST /api/solutions/${A}/vote`),
			'no vote was attempted'
		).toBe(true);
		expect(host.textContent, 'the failed vote produced no refusal at all').toContain(
			m.error_action_failed()
		);

		await navigateToB();

		expect(title(), 'the route change did not reload the page').toBe('Invoice matcher');
		expect(
			host.textContent,
			'solution A’s vote refusal is on solution B’s screen, above its own content'
		).not.toContain(m.error_action_failed());
	});

	it('⛔ …and so is a failed forward, in the delivery card of a different solution', async () => {
		await mountOnA();
		const fwd = forwardButton();
		expect(fwd, 'the forward control never rendered — the connector list is empty').toBeTruthy();
		expect(fwd!.disabled, 'the forward control is disabled').toBe(false);
		click(fwd!);
		await settle();
		await settle();
		expect(
			wire.some((c) => c === `POST /api/solutions/${A}/forward`),
			'no forward was attempted'
		).toBe(true);
		expect(host.textContent, 'the failed forward produced no refusal at all').toContain(
			m.delivery_forward_error({ error: m.error_action_failed() })
		);

		await navigateToB();

		expect(title()).toBe('Invoice matcher');
		expect(
			host.textContent,
			'solution A’s forward refusal is in solution B’s delivery card'
		).not.toContain(m.delivery_forward_error({ error: m.error_action_failed() }));
	});

	it('THE REFUSAL STILL APPEARS: clearing on navigation did not disable it', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. `voteError = null` written somewhere that also runs after the
		// vote passes both cases above and removes the message entirely.
		await mountOnA();
		click(voteButton()!);
		await settle();
		expect(host.textContent).toContain(m.error_action_failed());
		// …and it is still there a tick later, with no navigation in between.
		await settle();
		expect(host.textContent, 'the vote refusal cleared itself without a navigation').toContain(
			m.error_action_failed()
		);
	});

	it('`deliveryError` needs NO reset in the effect — `loadDelivery` already clears it', async () => {
		// ⛔ THE PIN ON THE CONSTRAINT. This claim was refuted once and could be re-introduced as a
		// "missing" reset; driving it proves the existing writer is the only one needed. A second one
		// in the effect would be a duplicate writer on state that is already correct.
		targetsStatus = 500;
		await mountOnA();
		const notice = host.querySelector('[data-testid="delivery-load-error"]');
		expect(notice, 'the connector list failed and the card said nothing').toBeTruthy();

		targetsStatus = 200;
		await navigateToB();

		expect(title()).toBe('Invoice matcher');
		expect(
			host.querySelector('[data-testid="delivery-load-error"]'),
			'the delivery load error survived a navigation whose loadDelivery succeeded'
		).toBeNull();
	});
});
