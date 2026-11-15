// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.delivery-load-failure.render.test.ts — the forward card
// must not tell a tenant admin they have no connectors when it simply failed to ask.
//
// ⛔ THE DEFECT, AND ITS COMMENT WAS ITS OWN DISPROOF. `loadDelivery()` ended in
//
//     } catch {
//         // A non-admin (or a transient error) simply gets no delivery section.
//     }
//
// The `if (!auth.isTenantAdmin) return;` one line ABOVE has already returned for the non-admin, so
// that catch only ever sees a real failure — and what it produced was not "no delivery section".
// `backlogTargets` stayed `[]`, which is the card's EMPTY STATE: a tenant admin whose
// `GET /api/delivery` 500'd was told "no Jira connector has been configured yet" and handed a link
// to /delivery to go and configure the connector they already have. A failed fetch reported to the
// reader as a fact about their workspace, plus a wrong next action — the same class as the
// DatasetPicker `emptyHint` defect this repo already documented twice on /submit and /challenges.
//
// ⛔ EVERY CASE ASSERTS BOTH HALVES: the failure sentence is PRESENT and the "you have none" copy is
// ABSENT. Absence alone is satisfied by a page that never mounted, which is why `deliveryCard()`
// pins a positive marker first and every case goes through it.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionDetail } from '$lib/types/solutions';
import type { DeliveryTarget } from '$lib/api/delivery';

// Real `en` catalog, each key resolving to its own name.
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

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'sol-del-1' }, url: new URL('http://localhost/solutions/sol-del-1') }
}));
const SOL_ID = 'sol-del-1';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getSolution, deliveryList, listForSolution } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	deliveryList: vi.fn(),
	listForSolution: vi.fn()
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: vi.fn().mockResolvedValue(null) } }));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: deliveryList,
		listForSolution,
		forward: vi.fn(),
		retry: vi.fn()
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
// ⛔ `RunApiError` must be a real class — the page does `e instanceof RunApiError`.
vi.mock('$lib/api/runs', () => ({
	RunApiError: class RunApiError extends Error {},
	runErrorDataFindings: () => [],
	runsApi: {
		getMySandbox: vi.fn().mockResolvedValue(null),
		startSolution: vi.fn(),
		resumeMySandbox: vi.fn()
	}
}));
// ⛔ THE WHOLE CARD IS BEHIND THIS FLAG. `false` and every assertion in this file is vacuous — the
// card is not in the document at all — which is exactly the reading the deleted comment offered.
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isTenantAdmin: true } }));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));

import Page from './+page.svelte';

function detail(): SolutionDetail {
	return {
		id: SOL_ID,
		title: 'Claim summary in three blocks',
		status: 'voting',
		week: '2026-W33',
		cycleClosed: false,
		votesCount: 7,
		hasVoted: false,
		demoMs: 0,
		blocksUsed: [],
		createdAt: '2026-08-10T00:00:00.000Z',
		author: { name: 'Bea Builder', initials: 'BB' },
		challenge: null,
		flow: { id: 'f1', name: 'Triage flow', chain: ['load-dataset'] },
		comparison: []
	};
}

function target_(id: string, name: string): DeliveryTarget {
	return {
		id,
		name,
		kind: 'jira',
		enabled: true,
		config: {},
		createdAt: '2026-08-01T00:00:00.000Z'
	} as DeliveryTarget;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The forward card sits inside `{#if data}` → `{#if auth.isTenantAdmin}`.
 * If `solutionsApi.get` had not resolved, the document would contain neither the failure sentence
 * NOR the empty-state copy, and "the empty-state copy is absent" would pass while proving nothing.
 */
function deliveryCard(): HTMLElement {
	const card = target.querySelector('.delivery-card');
	expect(card, 'the forward card never rendered — this case tests nothing').not.toBeNull();
	expect(card!.textContent).toContain('delivery_forward_title');
	return card as HTMLElement;
}

async function mountPage() {
	getSolution.mockResolvedValue(detail());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const fn of [getSolution, deliveryList, listForSolution]) fn.mockReset();
});

describe('/solutions/[id] forward card, when the connector list cannot be fetched', () => {
	it('⛔ says the connectors could not be loaded — and NOT "you have none yet"', async () => {
		// REVERT THAT TURNS THIS RED: put the bare `catch {}` back. `backlogTargets` stays `[]`, the
		// card falls into its empty branch, and BOTH assertions below invert at once.
		deliveryList.mockRejectedValue(new Error('Failed to fetch'));
		listForSolution.mockResolvedValue([]);
		await mountPage();
		const card = deliveryCard();

		// PRESENT…
		const err = card.querySelector('[data-testid="delivery-load-error"]');
		expect(err, 'nothing on screen said the connector list failed to load').not.toBeNull();
		expect(err!.textContent).toContain('delivery_forward_load_failed');
		expect(err!.getAttribute('role')).toBe('alert');
		// …and ABSENT: the sentence that was a lie, plus the wrong next action it carried.
		expect(
			card.textContent,
			'the admin was still told they have no connector configured'
		).not.toContain('delivery_forward_none');
		expect(card.querySelector('a[href="/delivery"]'), 'the go-configure-one CTA survived').toBeNull();
	});

	it('⛔ a failure on the OTHER half of the Promise.all is reported too', async () => {
		// `loadDelivery` awaits `list` and `listForSolution` together, so a 500 on the delivery HISTORY
		// rejects the same await and used to be swallowed by the same catch — with connectors that
		// loaded perfectly. The card must not present itself as fully loaded.
		deliveryList.mockResolvedValue([target_('t1', 'Jira · Claims')]);
		listForSolution.mockRejectedValue(new Error('Failed to fetch'));
		await mountPage();
		const card = deliveryCard();

		expect(card.querySelector('[data-testid="delivery-load-error"]')).not.toBeNull();
		expect(card.textContent).not.toContain('delivery_forward_none');
	});

	it('still says "no connector configured yet" when the fetch SUCCEEDS and there really is none', async () => {
		// ⛔ THE COMPLEMENT, AND THE REASON THE FIX IS A NEW BRANCH RATHER THAN DELETING THE EMPTY
		// STATE. A brand-new workspace genuinely has no connector, and that sentence plus its link is
		// the correct, useful thing to say. A "fix" that reported a load failure to every new admin
		// would be a worse bug than the one being fixed.
		deliveryList.mockResolvedValue([]);
		listForSolution.mockResolvedValue([]);
		await mountPage();
		const card = deliveryCard();

		expect(card.textContent).toContain('delivery_forward_none');
		expect(card.querySelector('a[href="/delivery"]')).not.toBeNull();
		expect(card.querySelector('[data-testid="delivery-load-error"]')).toBeNull();
	});

	it('renders the connector picker — and no failure line — on a healthy load', async () => {
		// The third state, so "always show the error" cannot pass this file.
		deliveryList.mockResolvedValue([target_('t1', 'Jira · Claims')]);
		listForSolution.mockResolvedValue([]);
		await mountPage();
		const card = deliveryCard();

		expect(card.querySelector('select'), 'the connector picker is missing').not.toBeNull();
		expect(card.textContent).toContain('Jira · Claims');
		expect(card.querySelector('[data-testid="delivery-load-error"]')).toBeNull();
		expect(card.textContent).not.toContain('delivery_forward_none');
	});
});
