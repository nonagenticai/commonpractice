// @vitest-environment jsdom
//
// src/routes/solutions/solution-detail.delivery-error.render.test.ts — the failure line of one row
// in /solutions/[id]'s "delivery history".
//
// ⛔ THE DEFECT. The line read
//
//     <span class="delivery-rowerr" title={d.error ?? ''}>{d.error ?? ''}</span>
//
// and `d.error` is `solution_deliveries.error` — an ENGLISH SENTENCE authored in the adapter
// (`backend/src/host/delivery/azure-devops.ts:253` → "Azure DevOps request timed out — verify in
// Azure DevOps before retrying") and persisted verbatim. The two sibling branches on that same
// `{#if d.status === 'failed'}` block are localized (`m.delivery_forward_ticket_exists()`,
// `m.delivery_forward_retry()`), so the English sat between two Dutch sentences.
//
// ⛔⛔ THE MACHINE CODE EXISTED THE WHOLE TIME and was discarded at the write. All three typed
// failure classes carry a stable `code`; the route now persists it (`response._cp_code`, an
// existing jsonb column — NO migration) and ships it as `errorCode`.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, and where the proof lives instead: that the backend really
// persists the code is `backend/tests/delivery-forward.test.ts` ("a failed row carries the MACHINE
// CODE"), against real Postgres. A mocked client here returns whatever this file hands it.
//
// ⚠️ AND THE ROWS ALREADY IN THE TABLE HOLD ONLY ENGLISH. They are NOT migrated — deliberately, and
// the third case below is the pin on that: `errorCode: null` must keep rendering the stored
// sentence rather than blanking the cell or printing a bare token. The same branch covers a
// mid-roll pod and a code shipped backend-first.
//
// ⚠️ CONTRADICTS THE BRIEF: this screen is NOT ungated. `loadDelivery()` returns at its first line
// unless `auth.isTenantAdmin`, and the whole delivery section is inside `{#if auth.isTenantAdmin}`
// — which is why the auth store is mocked to an admin below. The English was real; the audience
// for it was tenant admins, not every visitor.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Delivery } from '$lib/api/delivery';
import type { SolutionDetail } from '$lib/types/solutions';

// Real `en` catalog, each key resolving to its own name (params appended after a colon) — so the
// assertion is on WHICH message was chosen and with WHAT arguments, not on English prose a copy
// edit could move out from under this file.
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

const { getSolution, cycleCurrent, listTargets, listForSolution } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	cycleCurrent: vi.fn(),
	listTargets: vi.fn(),
	listForSolution: vi.fn()
}));

// ⚠️ EVERY STUBBED METHOD NAME BELOW IS THE REAL ONE, CHECKED AGAINST THE CLIENT. A sibling lane
// found `datasets-page.*.render.test.ts` stubbing `saveMapping` for a client that only ever had
// `saveMappings` — the page's call hit `undefined`, its own catch swallowed the TypeError, and
// every assertion downstream of that stub was vacuous. This file's first draft made the same
// mistake twice (`runsApi.mySandbox` / `runsApi.start` for `getMySandbox` / `startSolution`).
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, list: vi.fn(), create: vi.fn(), vote: vi.fn(), unvote: vi.fn() },
	SolutionApiError: class SolutionApiError extends Error {}
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: cycleCurrent } }));
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: listTargets,
		listForSolution,
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
		getMySandbox: vi.fn().mockResolvedValue(null),
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
// ⛔ THE GATE. Without `isTenantAdmin` the delivery section never renders and every assertion in
// this file would be about an empty DOM — which is why `assertHistoryRendered()` exists too.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		isTenantAdmin: true,
		user: { id: 'u-1', name: 'Mary de Vries', roles: ['tenant_admin'] },
		isAuthenticated: true
	}
}));

import Page from './[id]/+page.svelte';

const SOLUTION: SolutionDetail = {
	id: 'sol-1',
	title: 'Claims triage',
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

/** A failed attempt. `error` always carries the adapter's REAL English — see the header. */
function delivery(over: Partial<Delivery>): Delivery {
	return {
		id: 'd-1',
		targetId: 't-1',
		targetKind: 'azure_devops',
		status: 'failed',
		externalRef: null,
		externalUrl: null,
		error: 'Azure DevOps request timed out — verify in Azure DevOps before retrying',
		errorCode: null,
		errorStatus: null,
		createdAt: '2026-08-14T09:05:00.000Z',
		updatedAt: '2026-08-14T09:05:00.000Z',
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(deliveries: Delivery[]) {
	getSolution.mockResolvedValue(SOLUTION);
	cycleCurrent.mockResolvedValue(null);
	listTargets.mockResolvedValue([]);
	listForSolution.mockResolvedValue(deliveries);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** ⛔ NON-VACUITY. The section is behind `{#if auth.isTenantAdmin}` AND `{#if deliveries.length}`,
 *  and the page has a loading branch in front of both — three ways to render nothing and satisfy
 *  every "the English is gone" assertion for free. */
function assertHistoryRendered() {
	expect(listForSolution, 'the deliveries feed was never requested').toHaveBeenCalled();
	const row = host.querySelector('.delivery-rowerr');
	expect(row, 'the delivery history did not render — this case tests nothing').not.toBeNull();
	return row!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getSolution, cycleCurrent, listTargets, listForSolution]) fn.mockReset();
});

describe('/solutions/[id] renders a delivery failure from its CODE, not the stored English', () => {
	it('⛔ a timeout renders the catalog sentence — the adapter’s English is off the screen', async () => {
		await render([delivery({ errorCode: 'timeout' })]);
		const row = assertHistoryRendered();
		// The tool name resolves through the catalog too (`delivery_kind_azure_devops`), which is the
		// point: the sentence AND the product name inside it are both the reader's, not the server's.
		expect(row.textContent).toBe('delivery_error_timeout:delivery_kind_azure_devops');
		expect(host.textContent).not.toContain('verify in Azure DevOps before retrying');
	});

	it('⛔ the raw sentence survives in the TOOLTIP — localized for the reader, intact for support', async () => {
		// Deliberate: the visible text is the reader's, the `title=` is the operator's. A driver
		// message or a remote body fragment is worth keeping one hover away, and dropping it would
		// have traded one information loss for another.
		await render([delivery({ errorCode: 'timeout' })]);
		const row = assertHistoryRendered();
		expect(row.getAttribute('title')).toBe(
			'Azure DevOps request timed out — verify in Azure DevOps before retrying'
		);
	});

	it('⛔ an HTTP failure interpolates the STATUS the target answered with', async () => {
		await render([
			delivery({ errorCode: 'target_http_error', errorStatus: 503, error: 'Azure DevOps returned HTTP 503' })
		]);
		const row = assertHistoryRendered();
		expect(row.textContent).toBe('delivery_error_target_http:delivery_kind_azure_devops,503');
	});

	it('⛔ HISTORY IS NOT MIGRATED — `errorCode: null` still renders the stored English', async () => {
		// The stated limitation, and the branch that also covers a mid-roll pod and a code shipped
		// backend-first. Blanking the cell would be strictly worse than the defect being fixed.
		await render([delivery({ errorCode: null })]);
		const row = assertHistoryRendered();
		expect(row.textContent).toBe(
			'Azure DevOps request timed out — verify in Azure DevOps before retrying'
		);
	});

	it('⛔ a code this build has never heard of falls back too — never a bare token, never blank', async () => {
		await render([delivery({ errorCode: 'some_future_adapter_code' })]);
		const row = assertHistoryRendered();
		expect(row.textContent).toBe(
			'Azure DevOps request timed out — verify in Azure DevOps before retrying'
		);
		expect(row.textContent).not.toContain('some_future_adapter_code');
	});

	it('⚠️ the sibling branch is untouched — a failure WITH a ticket still says the ticket exists', async () => {
		// The `d.externalUrl` arm renders `m.delivery_forward_ticket_exists()` instead of the error
		// span, and it was already localized. It is asserted here so a change to the error branch
		// cannot quietly swallow it.
		await render([
			delivery({ errorCode: 'delivery_ledger_update_failed', externalRef: 'DEL-500', externalUrl: 'https://ado.test/DEL-500' })
		]);
		expect(host.querySelector('.delivery-rowerr')!.textContent).toBe(
			'delivery_forward_ticket_exists'
		);
	});
});
