// @vitest-environment jsdom
//
// src/routes/(platform)/plans/plans-page.render.test.ts — the plan catalogue page (A2 §5).
//   · delete is DISABLED while workspaces use the plan (and `plan_in_use` still maps if licences
//     refuses for a reference CP cannot see);
//   · retire is HIDDEN once licences has said it cannot retire (`capabilities.canRetire === false`),
//     and a 501 `retire_unsupported` hides it from then on;
//   · create sends the code + only the limits that were filled in; edit sends only what changed and
//     never the code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { LicencePlan } from '$lib/types/admin';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const stub = (key: string) => (params?: Record<string, unknown>) =>
		params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = stub(key);
	return mod;
});
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (e: unknown, f: string) => `${f}[${(e as { code?: string })?.code ?? ''}]`
}));
const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog }));

const { plans, createPlan, updatePlan, deletePlan, FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			readonly details?: Record<string, unknown>
		) {
			super(code);
		}
	}
	return { plans: vi.fn(), createPlan: vi.fn(), updatePlan: vi.fn(), deletePlan: vi.fn(), FakeApiError };
});
vi.mock('$lib/api/admin', () => ({
	ApiError: FakeApiError,
	adminApi: { plans, createPlan, updatePlan, deletePlan }
}));

function plan(over: Partial<LicencePlan> = {}): LicencePlan {
	return {
		id: 'p-std',
		code: 'standard',
		name: 'Standard',
		description: null,
		durationDays: 365,
		rateLimitRpm: 60,
		rateLimitBurst: null,
		quotaMonthly: null,
		tokenBudgetMonthly: null,
		revoked: false,
		tenantCount: 3,
		isDefault: true,
		...over
	};
}

let canRetire: boolean | null;
let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	canRetire = true;
	plans.mockImplementation(async () => ({
		app: 'commonpractice',
		defaultPlanCode: 'standard',
		plans: [plan(), plan({ id: 'p-trial', code: 'trial', name: 'Trial', tenantCount: 0, isDefault: false })],
		capabilities: { canRetire }
	}));
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.clearAllMocks();
});

async function settle() {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

async function render() {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(host.querySelectorAll('[data-testid="plan-row"]').length, 'plan rows').toBe(2);
}

const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="plan-row"]')];
const btn = (row: HTMLElement, id: string) => row.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

function type(sel: string, value: string) {
	const el = host.querySelector<HTMLInputElement>(sel);
	expect(el, `${sel} is not on the page`).not.toBeNull();
	el!.value = value;
	el!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('plans page', () => {
	it('lists the plans with their workspace counts; asks for the retired ones only when toggled', async () => {
		await render();
		expect(plans).toHaveBeenLastCalledWith({ includeRevoked: false });
		expect(rows()[0]!.querySelector('[data-testid="plan-tenant-count"]')?.textContent).toContain('admin_plans_tenant_count:3');
		host.querySelector<HTMLInputElement>('[data-testid="plans-show-retired"]')!.click();
		await settle();
		expect(plans).toHaveBeenLastCalledWith({ includeRevoked: true });
	});

	it('⛔ delete is disabled while workspaces use the plan, enabled when none do', async () => {
		await render();
		expect(btn(rows()[0]!, 'plan-delete')!.disabled).toBe(true);
		expect(btn(rows()[1]!, 'plan-delete')!.disabled).toBe(false);
	});

	it('⛔ a disabled delete SAYS WHY in its tooltip (the in-use count); an enabled one carries none', async () => {
		await render();
		expect(btn(rows()[0]!, 'plan-delete')!.getAttribute('title')).toBe('admin_plans_in_use:3');
		expect(btn(rows()[1]!, 'plan-delete')!.hasAttribute('title')).toBe(false);
	});

	it('a delete licences refuses (`plan_in_use`) is said in words, with the count', async () => {
		deletePlan.mockRejectedValue(new FakeApiError(409, 'plan_in_use', { tenantCount: 2 }));
		await render();
		btn(rows()[1]!, 'plan-delete')!.click();
		await settle();
		expect(deletePlan).toHaveBeenCalledWith('p-trial');
		expect(host.querySelector('[data-testid="plans-banner"]')?.textContent).toContain('admin_plans_in_use:2');
	});

	it('⛔ retire is hidden when licences cannot retire', async () => {
		canRetire = false;
		await render();
		expect(btn(rows()[0]!, 'plan-retire')).toBeNull();
	});

	it('⛔ a 501 retire_unsupported hides retire from then on', async () => {
		updatePlan.mockRejectedValue(new FakeApiError(501, 'retire_unsupported', { fieldsApplied: false }));
		await render();
		btn(rows()[1]!, 'plan-retire')!.click();
		await settle();
		expect(updatePlan).toHaveBeenCalledWith('p-trial', { revoked: true });
		expect(host.querySelector('[data-testid="plans-banner"]')?.textContent).toContain('admin_plans_retire_unsupported');
		expect(btn(rows()[0]!, 'plan-retire')).toBeNull();
	});

	it('create sends the code and only the limits that were filled in', async () => {
		createPlan.mockResolvedValue({ plan: plan({ id: 'p-new', code: 'local-llm', name: 'Local LLM' }) });
		await render();
		type('#pcode', 'local-llm');
		type('#pname', 'Local LLM');
		type('#pnew-rateLimitRpm', '120');
		host.querySelector<HTMLFormElement>('#pcode')!.closest('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createPlan).toHaveBeenCalledWith({ code: 'local-llm', name: 'Local LLM', rateLimitRpm: 120 });
	});

	it('an invalid code is refused locally', async () => {
		await render();
		type('#pcode', 'Local LLM');
		type('#pname', 'Local');
		host.querySelector<HTMLFormElement>('#pcode')!.closest('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createPlan).not.toHaveBeenCalled();
		expect(host.querySelector('[data-testid="plans-banner"]')?.textContent).toContain('admin_plans_code_invalid');
	});

	it('edit sends only what changed — never the code; clearing a limit sends null', async () => {
		updatePlan.mockResolvedValue({ plan: plan({ name: 'Standard 2' }) });
		await render();
		rows()[0]!.querySelector<HTMLButtonElement>('.btn-ghost')!.click();
		flushSync();
		type('[data-testid="plan-edit-name"]', 'Standard 2');
		type('#prateLimitRpm-p-std', '');
		host.querySelector<HTMLButtonElement>('[data-testid="plan-edit-save"]')!.click();
		await settle();
		expect(updatePlan).toHaveBeenCalledWith('p-std', { name: 'Standard 2', rateLimitRpm: null });
	});
});
