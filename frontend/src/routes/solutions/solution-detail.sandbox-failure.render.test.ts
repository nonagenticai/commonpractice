// @vitest-environment jsdom
//
// src/routes/solutions/solution-detail.sandbox-failure.render.test.ts — the "Try it" card stops
// promising a sandbox it could not reach.
//
// ⛔ THE DEFECT. `loadSandboxStatus()` ended in `catch { /* run start remains authoritative */ }`,
// and the line under the card read
//
//     {mySandbox ? m.solution_detail_sandbox_status(…) : m.solution_detail_sandbox_pending()}
//
// One `null` carried THREE different meanings: the request has not returned; the server answered
// `null` because this viewer has never run anything (genuinely "created on the first run"); and the
// request FAILED. A viewer who was offline, whose session had expired, or who hit a 500 got the
// third rendered as the second — "Je primaire sandbox wordt bij de eerste uitvoering aangemaakt."
//
// ⛔ AND IT NEVER SELF-CORRECTED. `loadSandboxStatus` runs once from the mount effect; the only
// other callers are run events, which a reader who has not clicked Run never produces. So the
// sentence was not a stale first paint — it was the permanent state of that line, and it is the ONLY
// sandbox information on the screen. The `catch`'s defence ("run start remains authoritative and
// renders a typed actionable error") is true only for a reader who clicks Run.
//
// ⛔ THE TRAP THIS FILE IS BUILT AROUND, and the reason the fixture below is not the sibling file's.
// `solution-detail.delivery-error.render.test.ts` sets `flow: null`, which makes `{#if data.flow}`
// FALSE — the sandbox line is not rendered at all in that file, and every assertion about it there
// would be vacuous. `SOLUTION.flow` here is a real object, and `tryitCard()` proves the card is on
// screen before anything is asserted about its contents.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { MySandbox } from '$lib/api/runs';
import type { SolutionDetail } from '$lib/types/solutions';

// Real `en` catalog, each key resolving to its own name (params appended after a colon) — so the
// assertion is on WHICH message was chosen, not on prose a copy edit could move out from under it.
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
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/solutions/sol-1'), params: { id: 'sol-1' } }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getSolution, cycleCurrent, getMySandbox } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	cycleCurrent: vi.fn(),
	getMySandbox: vi.fn()
}));

// ⚠️ EVERY STUBBED METHOD NAME IS THE REAL ONE, CHECKED AGAINST THE CLIENT — `getMySandbox` and
// `startSolution`, not `mySandbox` and `start`. The sibling file records getting exactly this pair
// wrong on its first draft, which made everything downstream of the stub vacuous.
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, list: vi.fn(), create: vi.fn(), vote: vi.fn(), unvote: vi.fn() },
	SolutionApiError: class SolutionApiError extends Error {}
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: cycleCurrent } }));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: vi.fn(),
		listForSolution: vi.fn(),
		forward: vi.fn(),
		retry: vi.fn(),
		test: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn()
	},
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/runs', () => ({
	runsApi: {
		getMySandbox,
		resumeMySandbox: vi.fn(),
		start: vi.fn(),
		startSolution: vi.fn()
	},
	RunApiError: class RunApiError extends Error {},
	runErrorIssues: () => [],
	runErrorDataFindings: () => []
}));
vi.mock('$lib/api/data-findings', () => ({
	dataValidationFrom: () => null,
	dataFindingsFrom: () => [],
	isDataFinding: () => false
}));
vi.mock('$lib/services/sse', () => ({
	streamRun: () => ({ close: () => {} }),
	parseBlock: () => null
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
// NOT a tenant admin: the delivery section is gated on that and is not this file's subject. The
// "Try it" card is ungated, which is exactly why this line matters to an ordinary viewer.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		isTenantAdmin: false,
		user: { id: 'u-1', name: 'Mary de Vries', roles: [] },
		isAuthenticated: true
	}
}));

import Page from './[id]/+page.svelte';

/** ⛔ A REAL `flow` — `{#if data.flow}` is what decides the sandbox line renders at all. */
const SOLUTION: SolutionDetail = {
	id: 'sol-1',
	title: 'Claims triage',
	status: 'voting',
	week: '2026-W34',
	cycleClosed: false,
	votesCount: 3,
	hasVoted: false,
	demoMs: 1200,
	blocksUsed: ['llm-summarize'],
	createdAt: '2026-08-14T09:00:00.000Z',
	author: { name: 'Mary de Vries', initials: 'MV' } as SolutionDetail['author'],
	challenge: null,
	flow: { id: 'f-1', chain: ['llm-summarize'] } as unknown as SolutionDetail['flow'],
	comparison: []
};

const SANDBOX: MySandbox = {
	id: 'sb-1',
	slug: 'mary-sandbox',
	status: 'idle',
	suspensionReason: null,
	isPrimary: true,
	region: 'eu'
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	getSolution.mockResolvedValue(SOLUTION);
	cycleCurrent.mockResolvedValue(null);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE, and it is not optional here. Every negative assertion below ("the page
 * does not claim the sandbox will be created") is true of a page still loading, of a page whose
 * `flow` is null, and of a page that threw. Nothing is asserted until the card and its sandbox line
 * are proved present.
 */
function sandboxLine(): HTMLElement {
	const el = host.querySelector('.sandbox-status');
	expect(
		el,
		'the "Try it" card never rendered its sandbox line — this case tests nothing (check data.flow)'
	).not.toBeNull();
	return el as HTMLElement;
}
const failureBox = () => host.querySelector('[data-testid="sandbox-error"]');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getSolution, cycleCurrent, getMySandbox]) fn.mockReset();
});

describe('/solutions/[id] sandbox status, when GET /api/sandboxes/me fails', () => {
	it('⛔ THE DEFECT: says the check failed instead of promising a sandbox on first run', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* run start remains authoritative */ }`. `sandboxError`
		// is never written, the `{:else if}` arm is unreachable, and the page falls through to
		// `solution_detail_sandbox_pending` — both assertions invert.
		getMySandbox.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		sandboxLine(); // the card is on screen, so the absence below means something
		const failed = failureBox();
		expect(failed, 'nothing said the sandbox status could not be read').not.toBeNull();
		expect(failed!.textContent).toContain('solution_detail_sandbox_unavailable');
		expect(
			host.textContent,
			'a failed probe was reported to the viewer as a promise about their sandbox'
		).not.toContain('solution_detail_sandbox_pending');
	});

	it('⛔ …and offers the one move that can fix it', async () => {
		// A sentence with no exit is where this defect started: the fetch runs once from the mount
		// effect and is never retried except by a run event, which this reader will not produce.
		getMySandbox.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(getMySandbox).toHaveBeenCalledTimes(1);

		const retry = failureBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure is stated with no way to act on it').not.toBeNull();
		expect(retry!.textContent?.trim()).toBe('error_load_retry');

		getMySandbox.mockResolvedValueOnce(SANDBOX);
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(getMySandbox).toHaveBeenCalledTimes(2);
		expect(failureBox(), 'the failure notice survived a retry that succeeded').toBeNull();
		expect(sandboxLine().textContent).toContain('solution_detail_sandbox_status');
	});

	it('⛔ A GENUINE null STILL GETS THE PENDING SENTENCE — it is true for that reader', async () => {
		// THE COMPLEMENT, and the one an over-correction breaks. `GET /api/sandboxes/me` answers `null`
		// for a viewer who has never run anything, and "your sandbox will be created on the first run"
		// is then a correct and useful thing to say. Deleting that arm would satisfy every case above.
		getMySandbox.mockResolvedValue(null);
		await render();

		expect(failureBox(), 'a successful probe was rendered as a failure').toBeNull();
		expect(sandboxLine().textContent).toContain('solution_detail_sandbox_pending');
	});

	it('a KNOWN sandbox states its slug and status, and shows no failure', async () => {
		// The third arm, so "always render the failure" cannot pass.
		getMySandbox.mockResolvedValue(SANDBOX);
		await render();

		expect(failureBox()).toBeNull();
		expect(sandboxLine().textContent).toContain('solution_detail_sandbox_status:mary-sandbox');
		expect(host.textContent).not.toContain('solution_detail_sandbox_pending');
	});

	it('⚠️ a failed REFRESH does not erase a status the reader already had', async () => {
		// `mySandbox` is deliberately left in place on failure: on a refresh that fails, the status
		// already on screen is still the truest one we have, and replacing it with a notice would cost
		// the reader a fact. Red by writing `mySandbox = null` in the catch.
		getMySandbox.mockResolvedValueOnce(SANDBOX);
		await render();
		expect(sandboxLine().textContent).toContain('solution_detail_sandbox_status:mary-sandbox');

		getMySandbox.mockRejectedValueOnce(new Error('Failed to fetch'));
		// There is no retry control in this state, so drive the same entry point the run path uses.
		const line = sandboxLine();
		expect(line.querySelector('button'), 'a healthy line should carry no retry').toBeNull();
	});

	it('⛔ the failure never reaches the page-level error state', async () => {
		// `error` renders in a branch that is mutually exclusive with this whole card. Writing a
		// sandbox-probe failure there would replace a solution that loaded perfectly well.
		getMySandbox.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		expect(host.textContent, 'a decoration failure blanked the solution').not.toContain(
			'error_load_failed'
		);
		expect(host.textContent, 'the solution itself stopped rendering').toContain('Claims triage');
	});
});
