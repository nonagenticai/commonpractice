// @vitest-environment jsdom
//
// The /usage money budget: the prepaid-credit balance, the Top up control, and the honest
// "not available yet" state when billing has no money budget for the workspace (or the feature is
// off). Props only — the page owns the requests.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MoneyBudgetPanel from './MoneyBudgetPanel.svelte';

let host: HTMLElement | undefined;
let app: Record<string, unknown> | undefined;

function render(props: Record<string, unknown>) {
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(MoneyBudgetPanel, { target: host, props: { locale: 'en', ...props } });
	flushSync();
	return host;
}

afterEach(() => {
	if (app) unmount(app);
	host?.remove();
	app = undefined;
	host = undefined;
});

const budget = { amount: 100, currency: 'EUR', consumed: 40, remaining: 60, thresholdsCrossed: [] };
const credit = { grantedUsd: 150, drawnUsd: 12.34, remainingUsd: 137.66, settledThrough: '2026-09' };

describe('MoneyBudgetPanel', () => {
	it('shows the prepaid credit in USD, separately from the money-budget cap, and tops up the typed whole amount', async () => {
		const onTopUp = vi.fn(async () => {});
		const h = render({ budget, budgetState: 'ok', credit, creditState: 'ok', onTopUp });
		expect(h.querySelector('[data-testid="money-credit-remaining"]')?.textContent).toContain('$137.66');
		expect(h.querySelector('[data-testid="money-budget-remaining"]')?.textContent).toContain('60');
		const input = h.querySelector('[data-testid="money-topup-amount"]') as HTMLInputElement;
		input.value = '25';
		input.dispatchEvent(new Event('input'));
		flushSync();
		(h.querySelector('[data-testid="money-topup-submit"]') as HTMLButtonElement).click();
		flushSync();
		expect(onTopUp).toHaveBeenCalledWith(25);
	});

	it('shows the LIVE credit remaining (preview, incl. this month’s usage) instead of the closed-months ledger figure', () => {
		const h = render({ credit, creditState: 'ok', liveRemainingUsd: 117.66, onTopUp: vi.fn() });
		expect(h.querySelector('[data-testid="money-credit-live"]')?.textContent).toContain('$117.66');
		expect(h.querySelector('[data-testid="money-credit-remaining"]')).toBeNull();
	});

	it('⛔ a NEGATIVE remaining from billing is shown as $0.00, never as a debt', () => {
		const h = render({ credit: { ...credit, remainingUsd: -4.2 }, creditState: 'ok', liveRemainingUsd: -12.5, onTopUp: vi.fn() });
		expect(h.querySelector('[data-testid="money-credit-live"]')?.textContent).toContain('$0.00');
		expect(h.textContent).not.toContain('-$');
		expect(h.textContent).not.toContain('−$');
	});

	it('refuses a non-whole amount (billing takes whole currency units)', () => {
		const onTopUp = vi.fn(async () => {});
		const h = render({ budget, budgetState: 'ok', onTopUp });
		const input = h.querySelector('[data-testid="money-topup-amount"]') as HTMLInputElement;
		input.value = '10.5';
		input.dispatchEvent(new Event('input'));
		flushSync();
		expect((h.querySelector('[data-testid="money-topup-submit"]') as HTMLButtonElement).disabled).toBe(true);
	});

	it('credit needs NO money budget: with none, the Top up control is still offered', () => {
		const h = render({ budget: null, budgetState: 'none', creditState: 'none', onTopUp: vi.fn() });
		expect(h.querySelector('[data-testid="money-credit-none"]')).not.toBeNull();
		expect(h.querySelector('[data-testid="money-topup-submit"]')).not.toBeNull();
		expect(h.querySelector('[data-testid="money-topup-unavailable"]')).toBeNull();
	});

	it('says top-up is not available yet after billing answered 404 (flag off) — no dead button', () => {
		const h = render({ budget, budgetState: 'ok', onTopUp: vi.fn(), topupUnavailable: true });
		expect(h.querySelector('[data-testid="money-topup-unavailable"]')).not.toBeNull();
		expect(h.querySelector('[data-testid="money-topup-submit"]')).toBeNull();
	});
});
