// @vitest-environment jsdom
//
// src/routes/(tenant)/usage/billing-panel.unknown-not-zero.render.test.ts — the /usage Billing panel.
//
// ⛔ THE DEFECT THIS PROVES FIXED, AND IT IS THE REASON THE WIRE FORMAT HAS THE SHAPE IT HAS.
// A billing outage answers HTTP 200 with `{ status: 'unavailable', reason }` and NO money fields —
// `backend/src/routes/billing-view.ts` chose that over `{ totalUsd: 0 }` because **$0.00 is a
// legitimate bill** for a tenant on a free trial, so a zeroed failure is indistinguishable from a
// real answer and the customer is told they owe nothing by a system that does not know what they
// owe. That guarantee is only half a guarantee: the backend can refuse to send a number, but the
// SPA is free to render `?? 0` and put the fabrication back. This file is the other half.
//
// ⛔ WHAT IS ASSERTED IS THE DIFFERENCE, NOT THE ABSENCE. "The unknown state shows no dollar figure"
// passes trivially on a component that renders nothing at all, so every unknown case is paired with
// a CONTROL that renders a genuine ZERO bill through the same component and asserts `$0.00` really
// does appear. Only the two together say what this panel must do: a zero bill and an unknown bill
// never render the same.
//
// ⚠️ REAL COMPILED MESSAGES, NOT A KEY-NAME STUB — same technique as
// `routes/error-page.status-branch.render.test.ts`. A stub returning `"billing_unknown_heading"`
// cannot tell the real sentence from one that renders the wrong variable, and the entire property
// here is about what the sentence SAYS.
//
// ⚠️ `$lib/api/auth-fetch` IS MOCKED BECAUSE OF WHAT IT DRAGS IN, not because this panel fetches
// anything — it does not. The component imports `billingUnavailable` from `$lib/api/billing`, which
// imports `unwrap` from `$lib/api/admin`, which imports `auth-fetch`, which imports `keycloak-js`
// and three gate stores. Mocked by its `$lib` ALIAS id, never by the relative specifier the
// importers actually write (see `src/lib/test/setup.ts`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';

vi.mock('$lib/api/auth-fetch', () => ({
	authFetch: vi.fn(async () => {
		throw new Error('[test] BillingPanel must not fetch — every state arrives as a prop');
	})
}));

import BillingPanel from './BillingPanel.svelte';
import type { BillingPreviewResponse, BillingInvoicesResponse } from '$lib/api/billing';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

/** A REAL bill that genuinely totals zero — a tenant on a free trial. Not an error. */
const zeroBill = (): BillingPreviewResponse => ({
	status: 'ok',
	tenantId: 't-1',
	period: '2026-09',
	currency: 'USD',
	totalUsd: 0,
	lines: [{ kind: 'platform_fee', label: 'Platform fee', amountUsd: 0 }]
});

const realBill = (): BillingPreviewResponse => ({
	status: 'ok',
	tenantId: 't-1',
	period: '2026-09',
	currency: 'USD',
	totalUsd: 1256.5,
	lines: [
		{ kind: 'platform_fee', label: 'Platform fee', amountUsd: 500 },
		{ kind: 'seats', label: 'Seats', amountUsd: 720, quantity: 12 },
		{ kind: 'byo_markup', label: 'BYO markup', amountUsd: 36.5, ratePct: 15 }
	]
});

const outage = (reason: 'not_configured' | 'upstream_error'): BillingPreviewResponse => ({
	status: 'unavailable',
	reason,
	message: 'ignored — the SPA renders its own localized sentence, never the backend English',
	period: '2026-09'
});

const noInvoices = (): BillingInvoicesResponse => ({ status: 'ok', invoices: [] });

function render(props: Record<string, unknown>) {
	app = mount(BillingPanel, { target: host, props: { locale: locale.current, ...props } }) as Record<
		string,
		unknown
	>;
	flushSync();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never through `locale.set()` — that method fires an authFetch PATCH to
	// /api/me/locale, which this file never stubs (the rule every locale render spec here follows).
	locale.current = initialLocale;
});

describe('an unknown bill and a zero bill never render the same', () => {
	it('⛔ THE UNAVAILABLE STATE RENDERS AS UNKNOWN, WITH NO MONEY FIGURE AT ALL', () => {
		// REVERT THAT TURNS THIS RED — the MUTATION TARGET is `BillingPanel.svelte`'s
		// `{:else if previewOut}` arm: delete it, so an unavailable payload falls through to the ok
		// branch and `usd(previewOk.totalUsd, …)` renders `undefined` — or, in the form this actually
		// shipped as elsewhere, change the total to `usd(preview?.totalUsd ?? 0, locale)`. Either way
		// an outage starts rendering a number, and both assertions below go red.
		locale.current = 'en';
		render({ preview: outage('not_configured'), invoices: noInvoices() });

		const panel = host.querySelector('[data-testid="billing-preview-unknown"]');
		expect(panel, 'the outage did not reach the unknown branch at all').not.toBeNull();
		expect(panel!.textContent).toContain('Amount due unknown');
		// The reason half: a config gap is an operator's job, and the sentence has to say so rather
		// than inviting the reader to wait for a recovery that will never come.
		expect(panel!.textContent).toContain('configuration gap');

		// ⛔ THE LOAD-BEARING ASSERTION. No currency glyph anywhere in the panel — not `$0.00`, not
		// `$—`, not a total row. A number on this panel is a claim about what the customer owes.
		expect(host.textContent, 'an unknown bill rendered a money figure').not.toMatch(/\$/);
		expect(host.querySelector('[data-testid="billing-preview-total"]')).toBeNull();
	});

	it('⛔ THE CONTROL: a genuine $0.00 bill DOES render its zero — so the assertion above is not vacuous', () => {
		// Without this case, "the unknown state shows no `$`" would also pass on a panel that renders
		// nothing, on one that crashed, and on one that dropped the total row for every payload.
		locale.current = 'en';
		render({ preview: zeroBill(), invoices: noInvoices() });

		const total = host.querySelector('[data-testid="billing-preview-total"]');
		expect(total, 'a real bill rendered no total — the unknown-state assertion proves nothing').not.toBeNull();
		expect(total!.textContent).toContain('$0.00');
		// …and it is emphatically NOT captioned as unknown.
		expect(host.querySelector('[data-testid="billing-preview-unknown"]')).toBeNull();
		expect(host.textContent).not.toContain('Amount due unknown');
	});

	it('an upstream outage says INCIDENT, not configuration — the two reasons are different repairs', () => {
		locale.current = 'en';
		render({ preview: outage('upstream_error'), invoices: noInvoices() });

		const panel = host.querySelector('[data-testid="billing-preview-unknown"]');
		expect(panel!.textContent).toContain('could not be reached');
		// Collapsing the two would send an operator to edit gitops over a blip, or to wait out a
		// config gap that no amount of waiting fixes.
		expect(panel!.textContent).not.toContain('configuration gap');
		expect(host.textContent).not.toMatch(/\$/);
	});

	it('renders every line billing issued, with its seat count and markup rate', () => {
		// ⛔ NOT a fixed platform-fee/seats/markup triple: billing owns the price book and a fourth
		// line kind must not be dropped from a total the customer is charged.
		locale.current = 'en';
		render({ preview: realBill(), invoices: noInvoices() });

		expect(host.textContent).toContain('Platform fee');
		expect(host.textContent).toContain('$500.00');
		expect(host.textContent).toContain('Seats');
		expect(host.textContent).toContain('12'); // the seat COUNT, off `quantity`
		expect(host.textContent).toContain('BYO markup');
		expect(host.textContent).toContain('15%'); // `ratePct`, through Intl rather than a glued '%'
		expect(host.querySelector('[data-testid="billing-preview-total"]')!.textContent).toContain(
			'$1,256.50'
		);
	});

	it('an invoice billing could not read is listed as "details unavailable" — no amount, and the others still show', () => {
		locale.current = 'en';
		render({
			preview: realBill(),
			invoices: {
				status: 'ok',
				invoices: [
					{ id: 'inv-ok', tenantId: 't-1', period: '2026-08', status: 'paid', currency: 'USD', totalUsd: 90, lines: [] },
					{ id: 'inv-bad', tenantId: 't-1', period: '2026-07', status: 'issued', currency: 'USD', totalUsd: null as unknown as number, lines: [], detailsUnavailable: true }
				]
			}
		});
		expect(host.querySelector('[data-testid="billing-invoice-unavailable"]')).not.toBeNull();
		expect(host.textContent).toContain('$90.00');
		expect(host.textContent).not.toContain('NaN');
		expect(host.textContent).not.toMatch(/\$0\.00/);
	});

	it('lines CP itemised from billing are labelled in the reader’s language by KIND', () => {
		locale.current = 'nl';
		render({
			preview: {
				status: 'ok', tenantId: 't-1', period: '2026-10', currency: 'USD', totalUsd: 140,
				lines: [
					{ kind: 'access_charge', label: 'Access charges', amountUsd: 100 },
					{ kind: 'usage_other', label: 'Usage and markup', amountUsd: 40 }
				]
			},
			invoices: noInvoices()
		});
		expect(host.textContent).toContain('Toegangskosten');
		expect(host.textContent).toContain('Gebruik en opslag');
		expect(host.textContent).not.toContain('Usage and markup');
	});

	it('prepaid credit already deducted from the total is shown as its own line, on the preview and on an invoice', () => {
		locale.current = 'en';
		render({
			preview: { ...(realBill() as object), totalUsd: 1236.5, prepaidCreditAppliedUsd: 20 },
			invoices: {
				status: 'ok',
				invoices: [
					{ id: 'inv-1', tenantId: 't-1', period: '2026-08', status: 'paid', currency: 'USD', totalUsd: 90, lines: [], prepaidCreditAppliedUsd: 10 }
				]
			}
		});
		expect(host.querySelector('[data-testid="billing-preview-credit-applied"]')!.textContent).toContain('$20.00');
		expect(host.querySelector('[data-testid="billing-invoice-credit-applied"]')!.textContent).toContain('$10.00');
	});

	it('⛔ "no invoices yet" and "we could not ask" are different screens', () => {
		// The list-shaped spelling of the same defect: an outage that renders an empty list tells a
		// customer they have never been billed.
		locale.current = 'en';
		render({ preview: zeroBill(), invoices: noInvoices() });
		expect(host.querySelector('[data-testid="billing-invoices-empty"]')).not.toBeNull();
		expect(host.textContent).toContain('No invoices have been issued for this workspace yet.');
		expect(host.querySelector('[data-testid="billing-invoices-unknown"]')).toBeNull();

		unmount(app!);
		app = undefined;
		host.innerHTML = '';

		render({
			preview: zeroBill(),
			invoices: { status: 'unavailable', reason: 'upstream_error', message: 'x' }
		});
		expect(host.querySelector('[data-testid="billing-invoices-unknown"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="billing-invoices-empty"]')).toBeNull();
		expect(host.textContent).not.toContain('No invoices have been issued');
	});

	it('the loading state is neither of the other two', () => {
		locale.current = 'en';
		render({ loading: true, preview: null, invoices: null });
		expect(host.querySelector('[data-testid="billing-preview-loading"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="billing-preview-unknown"]')).toBeNull();
		expect(host.querySelector('[data-testid="billing-invoices-empty"]')).toBeNull();
		expect(host.textContent).not.toMatch(/\$/);
	});

	it('the unknown state reaches a Dutch reader in Dutch — the panel reads the tag', () => {
		// The backend's `message` field is English prose. Rendering it would put one English sentence
		// on an otherwise Dutch screen, which is why the panel renders its own catalog copy instead.
		locale.current = 'nl';
		render({ preview: outage('not_configured'), invoices: noInvoices() });

		const panel = host.querySelector('[data-testid="billing-preview-unknown"]');
		expect(panel!.textContent).toContain('Openstaand bedrag onbekend');
		expect(panel!.textContent).not.toContain('Amount due unknown');
		// ⛔ And the backend's English is nowhere on screen.
		expect(host.textContent).not.toContain('the SPA renders its own localized sentence');
	});
});
