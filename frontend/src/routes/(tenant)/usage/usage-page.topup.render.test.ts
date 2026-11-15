// @vitest-environment jsdom
//
// The /usage TOP-UP flow on the real page: the idempotency key is one per INTENT (a retry of the same
// amount resends it; a new amount gets a new one), a confirmed top-up re-reads the bill and the
// credit so the screen never keeps the pre-top-up balance, and a success whose balance billing could
// not report says so instead of claiming a figure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { currentTenant, usage, tenantBudget, topUp, preview, invoices, ApiErrorMock } = vi.hoisted(() => ({
	currentTenant: vi.fn(),
	usage: vi.fn(),
	tenantBudget: vi.fn(),
	topUp: vi.fn(),
	preview: vi.fn(),
	invoices: vi.fn(),
	ApiErrorMock: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/admin', () => ({
	adminApi: { currentTenant, usage, tenantBudget, topUp },
	ApiError: ApiErrorMock
}));
vi.mock('$lib/api/billing', () => ({
	billingApi: { preview, invoices },
	billingUnavailable: (p: { status?: string } | null) => (p && p.status === 'unavailable' ? p : null)
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (_e: unknown, f: string) => f
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

const usagePayload = {
	rangeDays: 30,
	stats: { spendUsd: 0, calls: 0, models: 0, members: 0, pricing: { provider: 0, table: 0, flat: 0, legacy: 0 } },
	byModel: [],
	byDay: [],
	byMember: []
};
const credit = (remainingUsd: number) => ({ grantedUsd: 100, drawnUsd: 100 - remainingUsd, remainingUsd, settledThrough: null });

beforeEach(() => {
	sessionStorage.clear();
	host = document.createElement('div');
	document.body.appendChild(host);
	locale.current = 'en';
	currentTenant.mockResolvedValue({ tenant: { id: 't-1', name: 'Acme', slug: 'acme' } });
	usage.mockResolvedValue(usagePayload);
	tenantBudget.mockResolvedValue({ budget: null, budgetState: 'none', credit: credit(10), creditState: 'ok', seats: {} });
	preview.mockResolvedValue({ status: 'ok', tenantId: 't-1', period: '2026-10', currency: 'USD', totalUsd: 0, lines: [], prepaidCreditRemainingUsd: 10 });
	invoices.mockResolvedValue({ status: 'ok', invoices: [] });
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.clearAllMocks();
});

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
async function mountPage() {
	const { default: UsagePage } = await import('./+page.svelte');
	app = mount(UsagePage, { target: host, props: {} }) as Record<string, unknown>;
	await settle();
	await settle();
}
async function submitTopUp(amount: string) {
	const input = host.querySelector<HTMLInputElement>('[data-testid="money-topup-amount"]')!;
	input.value = amount;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	host.querySelector<HTMLButtonElement>('[data-testid="money-topup-submit"]')!.click();
	await settle();
	await settle();
}
const sentKeys = () => topUp.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);

describe('/usage top-up', () => {
	it('⛔ a RETRY of the same intent resends the SAME key; a changed amount sends a NEW key', async () => {
		topUp.mockRejectedValueOnce(new ApiErrorMock(502, 'billing_unavailable')); // lost response
		topUp.mockRejectedValueOnce(new ApiErrorMock(502, 'billing_unavailable'));
		topUp.mockRejectedValueOnce(new ApiErrorMock(502, 'billing_unavailable'));
		await mountPage();
		await submitTopUp('50');
		await submitTopUp('50'); // the reader retries the same purchase
		await submitTopUp('75'); // a different purchase
		const keys = sentKeys();
		expect(keys).toHaveLength(3);
		expect(keys[1]).toBe(keys[0]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it('after a confirmed top-up the bill and the credit are RE-READ (no stale balance), and the next purchase is a new key', async () => {
		topUp.mockResolvedValue({ credit: credit(60), replayed: false, balanceKnown: true });
		await mountPage();
		const previewsBefore = preview.mock.calls.length;
		const budgetsBefore = tenantBudget.mock.calls.length;
		preview.mockResolvedValue({ status: 'ok', tenantId: 't-1', period: '2026-10', currency: 'USD', totalUsd: 0, lines: [], prepaidCreditRemainingUsd: 60 });
		await submitTopUp('50');
		expect(preview.mock.calls.length).toBeGreaterThan(previewsBefore);
		expect(tenantBudget.mock.calls.length).toBeGreaterThan(budgetsBefore);
		expect(host.querySelector('[data-testid="money-credit-live"]')?.textContent).toContain('$60.00');
		await submitTopUp('50');
		const keys = sentKeys();
		expect(keys[1]).not.toBe(keys[0]); // confirmed → a new intent
	});

	it('a success whose balance billing could not report says so (balanceKnown: false)', async () => {
		topUp.mockResolvedValue({ credit: null, replayed: false, balanceKnown: false });
		await mountPage();
		await submitTopUp('50');
		expect(host.querySelector('[data-testid="money-topup-message"]')?.textContent).toContain(
			'usage_topup_done_balance_unknown'
		);
	});
});
