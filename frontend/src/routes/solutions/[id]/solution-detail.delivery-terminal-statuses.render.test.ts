// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.delivery-terminal-statuses.render.test.ts — the two
// delivery statuses this page could not render.
//
// ⛔ THE DEFECT, IN THREE PLACES ON ONE ROW.
// `DeliveryStatus` has EIGHT members — `$lib/api/delivery.ts`, mirroring
// `backend/src/db/delivery-types.ts` and the `delivery_status` pg enum created in migration 0032.
// The delivery-history row handled five of them:
//
//   1. `statusLabel()` mapped created/failed/pending+sent/draft_created/promoted and ended
//      `return s`. An `approved` row therefore rendered the bare wire token `approved` — an
//      English enum member inside otherwise-Dutch copy, on the same card whose 409 refusal and
//      whose `delivery-rowerr` span had each already been fixed for exactly that.
//   2. The external-link branch is a WHITELIST of statuses (`created|draft_created|promoted`),
//      not a test for `externalUrl`. An `approved` row with a live ticket URL matched neither arm
//      and rendered a chip with nothing beside it — the one control that reaches the ticket, gone.
//   3. Retry lived in a `failed`-ONLY arm, while `backend/src/routes/delivery.ts:739` refuses only
//      `status !== 'failed' && status !== 'rejected'`, `LIVE_DELIVERY_STATUSES` (:66-75) excludes
//      both precisely so both are re-sendable, and the refusal's own user-visible copy says so:
//      `error_delivery_not_retriable` = "Only a failed or rejected delivery can be retried." A
//      rejected delivery was an inert row: no way forward from the UI, against a backend that
//      would have accepted the retry.
//
// ⚠️ HOW REACHABLE THIS IS TODAY, STATED HONESTLY RATHER THAN OVERSOLD. Nothing in this repo
// currently WRITES `approved` or `rejected`: `POST /api/delivery/fr-feedback` (delivery.ts:850)
// flips `draft_created → promoted` and that is the only external status writer. So (1) and (2) are
// LATENT — they fire the moment fr's approval step posts an intermediate state, which is what the
// enum, the wire type and the live-status list all exist for. (3) is NOT latent in the same way:
// the copy promising a rejected retry ships in all eight catalogs today. Latency is a reason to
// state the exposure precisely, not a reason to leave a screen that cannot render its own contract.
//
// ⛔ NOTHING IN THE MESSAGE LAYER IS MOCKED — same construction, and the same reason, as
// `solution-detail.dutch-delivery-conflict.render.test.ts` beside it. The sibling specs in this
// directory stub `$lib/paraglide/messages` to key NAMES, which is right for them (they assert WHICH
// key) and would be fatal here: the defect is that a raw English enum member reached a Dutch
// screen, so a stub that returns key names would make `not.toContain('approved')` pass over a page
// rendering `delivery_forward_status_approved`. `overwriteGetLocale` is the lever
// `$lib/stores/locale.svelte.ts` pulls in the running app.
//
// NEGATIVE CONTROL, by name — this is today's code, and each half reds separately:
//   · drop `if (s === 'approved')` from `statusLabel` → "⛔ an approved delivery is localized…"
//     reds with the page showing the bare token `approved`;
//   · drop `|| d.status === 'approved'` from the link whitelist → the same case reds on the
//     missing <a class="delivery-link">;
//   · narrow the retry arm back to `d.status === 'failed'` → "⛔ a rejected delivery can be
//     retried…" reds with no button in the row.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionDetail } from '$lib/types/solutions';
import type { Delivery, DeliveryTarget, DeliveryStatus } from '$lib/api/delivery';

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'sol-term-4' }, url: new URL('http://localhost/solutions/sol-term-4') }
}));
const SOL_ID = 'sol-term-4';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getSolution, deliveryList, listForSolution, retryMock } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	deliveryList: vi.fn(),
	listForSolution: vi.fn(),
	retryMock: vi.fn()
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: vi.fn().mockResolvedValue(null) } }));
// PARTIAL — only the network call is replaced; the real types/ApiError stay.
vi.mock('$lib/api/delivery', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		deliveryApi: {
			list: deliveryList,
			listForSolution,
			forward: vi.fn(),
			retry: retryMock
		}
	};
});
vi.mock('$lib/api/runs', () => ({
	RunApiError: class RunApiError extends Error {},
	runErrorDataFindings: () => [],
	runsApi: {
		getMySandbox: vi.fn().mockResolvedValue(null),
		startSolution: vi.fn(),
		resumeMySandbox: vi.fn()
	}
}));
// ⛔ THE WHOLE DELIVERY CARD IS BEHIND THIS FLAG. `false` and every assertion here is vacuous.
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isTenantAdmin: true } }));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));

import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

const TICKET_URL = 'https://jira.example.test/browse/CLAIM-4021';
const TICKET_REF = 'CLAIM-4021';

function detail(): SolutionDetail {
	return {
		id: SOL_ID,
		title: 'Schadeclaim in drie blokken',
		status: 'voting',
		week: '2026-W33',
		cycleClosed: false,
		votesCount: 3,
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

function connector(): DeliveryTarget {
	return {
		id: 't1',
		name: 'Jira · Claims',
		kind: 'jira',
		enabled: true,
		config: {},
		createdAt: '2026-08-01T00:00:00.000Z'
	} as DeliveryTarget;
}

function delivery(status: DeliveryStatus, over: Partial<Delivery> = {}): Delivery {
	return {
		id: `d-${status}`,
		targetId: 't1',
		targetKind: 'jira',
		status,
		externalRef: TICKET_REF,
		externalUrl: TICKET_URL,
		error: null,
		errorCode: null,
		createdAt: '2026-08-11T00:00:00.000Z',
		updatedAt: '2026-08-11T00:00:00.000Z',
		...over
	} as Delivery;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * Mount /solutions/[id] with a given delivery history and hand back the ONE history row.
 *
 * ⛔ POSITIVE MARKERS BEFORE ANY ASSERTION. The card sits behind `{#if data}` → `{#if
 * auth.isTenantAdmin}` → `{#if backlogTargets.length}` → `{#if deliveries.length}`. If
 * `solutionsApi.get` had rejected, or the connector list were empty, the document would contain
 * neither the localized chip nor the raw token, and every `not.toContain` below would pass against
 * a blank page.
 */
async function rowFor(d: Delivery): Promise<HTMLElement> {
	getSolution.mockResolvedValue(detail());
	deliveryList.mockResolvedValue([connector()]);
	listForSolution.mockResolvedValue([d]);

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const h1 = target.querySelector('h1');
	expect(h1, 'the solution page rendered no header — this file would test nothing').not.toBeNull();
	expect(h1!.textContent).toContain('Schadeclaim in drie blokken');

	const card = target.querySelector('.delivery-card') as HTMLElement | null;
	expect(card, 'the delivery card never rendered — this file would test nothing').not.toBeNull();

	const rows = card!.querySelectorAll('.delivery-row');
	expect(rows.length, 'the delivery history rendered no rows').toBe(1);
	return rows[0] as HTMLElement;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	for (const fn of [getSolution, deliveryList, listForSolution, retryMock]) fn.mockReset();
});

describe('a Dutch tenant admin reads an approved / rejected delivery', () => {
	it('the fixture really is Dutch, and the two new keys really differ from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every case below asserts "the row contains the nl
		// string" and "the row does NOT contain the raw enum token". If `overwriteGetLocale` stopped
		// working, `m.*()` would return "Approved"/"Rejected" — which are not the tokens `approved`/
		// `rejected` either, so the negative half would STILL pass while the screen was English.
		overwriteGetLocale(() => 'nl');
		const nlApproved = m.delivery_forward_status_approved();
		const nlRejected = m.delivery_forward_status_rejected();
		overwriteGetLocale(() => 'en');
		expect(nlApproved).not.toBe(m.delivery_forward_status_approved());
		expect(nlRejected).not.toBe(m.delivery_forward_status_rejected());
		// …and neither Dutch value is the wire token in disguise.
		expect(nlApproved.toLowerCase()).not.toContain('approved');
		expect(nlRejected.toLowerCase()).not.toContain('rejected');
	});

	it('⛔ an approved delivery is localized and keeps its link to the ticket', async () => {
		const row = await rowFor(delivery('approved'));
		const text = row.textContent ?? '';

		overwriteGetLocale(() => 'nl');
		// (1) PRESENT — the localized chip.
		const chip = row.querySelector('.delivery-chip') as HTMLElement | null;
		expect(chip, 'no status chip rendered').not.toBeNull();
		expect(chip!.textContent!.trim()).toBe(m.delivery_forward_status_approved());
		// ABSENT — the bare wire token a Dutch reader used to get from `return s`.
		expect(text, 'the raw enum member is still on the Dutch screen').not.toContain('approved');

		// (2) PRESENT — the external link. The whitelist, not `externalUrl`, is what used to drop it.
		const link = row.querySelector('a.delivery-link') as HTMLAnchorElement | null;
		expect(link, 'an approved row lost its link to the live ticket').not.toBeNull();
		expect(link!.getAttribute('href')).toBe(TICKET_URL);
		expect(link!.textContent).toContain(TICKET_REF);

		// ⚠️ AND NOT THE FAILURE FURNITURE. `approved` is a success state: no retry, no error
		// sentence. A "fix" that widened the failed arm to cover it would satisfy the two halves
		// above and be wrong.
		expect(row.querySelector('button.delivery-retry')).toBeNull();
		expect(row.querySelector('.delivery-rowerr')).toBeNull();
	});

	it('⛔ a rejected delivery is localized and CAN be retried, which the backend has always allowed', async () => {
		const row = await rowFor(delivery('rejected', { externalRef: null, externalUrl: null }));
		const text = row.textContent ?? '';

		overwriteGetLocale(() => 'nl');
		const chip = row.querySelector('.delivery-chip') as HTMLElement | null;
		expect(chip, 'no status chip rendered').not.toBeNull();
		expect(chip!.textContent!.trim()).toBe(m.delivery_forward_status_rejected());
		expect(text, 'the raw enum member is still on the Dutch screen').not.toContain('rejected');

		// (3) THE BUTTON. `routes/delivery.ts:739` accepts `failed || rejected`; the page rendered
		// this arm for `failed` only, so the row was inert.
		const retry = row.querySelector('button.delivery-retry') as HTMLButtonElement | null;
		expect(retry, 'a rejected delivery has no Retry button — the row is inert').not.toBeNull();
		expect(retry!.disabled, 'Retry rendered disabled').toBe(false);
		expect(retry!.textContent!.trim()).toBe(m.delivery_forward_retry());

		// …and it really posts. A rendered-but-unwired button is the same inert row with a new look.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(retryMock, 'Retry was clicked but nothing was posted').toHaveBeenCalledWith(
			SOL_ID,
			'd-rejected'
		);

		// ⚠️ AND WITHOUT THE FAILURE SENTENCES. A rejected row has no `error` — nothing failed, a
		// human said no — and `delivery_forward_ticket_exists` is the #174 partial-dispatch note,
		// which is a statement about a FAILURE. Widening the arm must not widen what it says.
		expect(row.querySelector('.delivery-rowerr')).toBeNull();
		expect(text).not.toContain(m.delivery_forward_ticket_exists());
	});

	it('a rejected delivery that still has a ticket shows the link, and still no failure note', async () => {
		const row = await rowFor(delivery('rejected'));
		const link = row.querySelector('a.delivery-link') as HTMLAnchorElement | null;
		expect(link, 'the ticket exists at the target but the row does not reach it').not.toBeNull();
		expect(link!.getAttribute('href')).toBe(TICKET_URL);
		expect(row.querySelector('button.delivery-retry')).not.toBeNull();

		overwriteGetLocale(() => 'nl');
		expect(row.textContent).not.toContain(m.delivery_forward_ticket_exists());
	});

	it('the `failed` row is unchanged — the widening is not collateral', async () => {
		// ⛔ THE COMPLEMENT. Every edit here touched a branch `failed` also flows through, so the
		// pre-existing behaviour is re-asserted rather than assumed: the localized error label, the
		// retry button, and (with a url) the "ticket already exists" note.
		const row = await rowFor(
			delivery('failed', {
				externalRef: null,
				externalUrl: null,
				error: 'Jira request timed out',
				errorCode: 'delivery_dispatch_timeout'
			})
		);
		overwriteGetLocale(() => 'nl');
		const chip = row.querySelector('.delivery-chip') as HTMLElement | null;
		expect(chip!.textContent!.trim()).toBe(m.delivery_forward_status_failed());
		expect(row.querySelector('.delivery-rowerr'), 'the failed row lost its error text').not.toBeNull();
		expect(row.querySelector('button.delivery-retry')).not.toBeNull();
	});

	it('a failed row WITH a ticket still shows the "already exists" note', async () => {
		const row = await rowFor(delivery('failed', { error: 'ledger update failed' }));
		overwriteGetLocale(() => 'nl');
		expect(row.textContent).toContain(m.delivery_forward_ticket_exists());
		expect(row.querySelector('button.delivery-retry')).not.toBeNull();
	});
});
