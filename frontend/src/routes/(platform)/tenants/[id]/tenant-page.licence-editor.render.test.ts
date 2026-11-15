// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/[id]/tenant-page.licence-editor.render.test.ts — the per-tenant
// licence editor (A2 §4), which moved from an in-row drawer on /tenants to its own page
// /tenants/<id>. What it must get right:
//   · it loads from GET /api/tenants/:id/licence and shows status + plan + expiry;
//   · it sends ONLY what changed — a re-sent planCode or date re-mints the tenant's licence, so a
//     "save" that echoed the whole form would re-issue a live customer's licence on every click;
//   · clearing the expiry sends `expiresAt: null` (perpetual), not an omitted key;
//   · `seats_below_usage` names the numbers instead of a generic refusal;
//   · licences drift is shown, and an unreachable licences is "could not check", never drift;
//   · every option says what it means — the BYO help follows the SELECTED value;
//   · the system tenant gets no editor at all (PATCH answers 409 `system_tenant`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PlatformTenant, TenantLicence } from '$lib/types/admin';

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
vi.mock('$lib/stores/activeTenant.svelte', () => ({
	activeTenant: { current: null, set: vi.fn() }
}));
vi.mock('$app/state', () => ({ page: { params: { id: 't-1' }, url: new URL('http://localhost/tenants/t-1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { platformTenant, patchTenant, tenantLicence, plans, FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			readonly details?: Record<string, unknown>
		) {
			super(code);
		}
	}
	return {
		platformTenant: vi.fn(),
		patchTenant: vi.fn(),
		tenantLicence: vi.fn(),
		plans: vi.fn(),
		FakeApiError
	};
});
vi.mock('$lib/api/admin', () => ({
	ApiError: FakeApiError,
	adminApi: {
		platformTenant,
		patchTenant,
		tenantLicence,
		plans,
		createTenant: vi.fn(),
		offboardTenant: vi.fn(),
		grantBudget: vi.fn(),
		issueLicense: vi.fn()
	}
}));

const EXPIRES = new Date(2027, 0, 15).toISOString();

function tenant(over: Partial<PlatformTenant> = {}): PlatformTenant {
	return {
		id: 't-1',
		name: 'Acme BV',
		slug: 'acme-bv',
		status: 'active',
		createdAt: '2026-01-05T00:00:00.000Z',
		memberCount: 4,
		maxMembers: 10,
		licensed: true,
		offboardedAt: null,
		planCode: 'standard',
		licenceExpiresAt: EXPIRES,
		...over
	};
}

function licence(over: Partial<TenantLicence> = {}): TenantLicence {
	return {
		tenantId: 't-1',
		planCode: 'standard',
		startsAt: null,
		expiresAt: EXPIRES,
		status: 'active',
		tenantStatus: 'active',
		licensed: true,
		licenceId: 'lic-1',
		byoMode: 'byo_required',
		licencesName: 'acme-bv',
		centralLink: 'registered',
		centralConfigured: true,
		live: {
			active: true,
			licenceId: 'lic-1',
			planCode: 'standard',
			expiresAt: EXPIRES,
			status: 'active',
			subjectId: 's',
			candidateCount: 1
		},
		liveError: null,
		...over
	};
}

const okPatch = (over: Record<string, unknown> = {}) => ({
	tenant: { id: 't-1', name: 'Acme BV', slug: 'acme-bv', licencesName: 'acme-bv' },
	seatFailures: [],
	licence: null,
	...over
});

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	platformTenant.mockImplementation(async () => tenant());
	const limits = { durationDays: null, rateLimitBurst: null, quotaMonthly: null, tokenBudgetMonthly: null };
	plans.mockImplementation(async () => ({
		app: 'commonpractice',
		defaultPlanCode: 'standard',
		plans: [
			{ id: 'p1', code: 'standard', name: 'Standard', revoked: false, isDefault: true, tenantCount: 1, ...limits, rateLimitRpm: 60 },
			{ id: 'p2', code: 'pro', name: 'Local LLM', revoked: false, isDefault: false, tenantCount: 0, ...limits, rateLimitRpm: 600 }
		],
		capabilities: { canRetire: true }
	}));
	tenantLicence.mockImplementation(async () => licence());
	patchTenant.mockImplementation(async () => okPatch());
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

async function openEditor() {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// The page IS the editor now — no drawer to open. It loads the row by the route's id.
	expect(platformTenant).toHaveBeenCalledWith('t-1');
	expect(tenantLicence).toHaveBeenCalledWith('t-1');
	expect(host.querySelector('[data-testid="tenant-licence-editor"] form'), 'the editor form did not render').not.toBeNull();
}

function set(testid: string, value: string) {
	const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-testid="${testid}"]`);
	expect(el, `${testid} is not on the page`).not.toBeNull();
	el!.value = value;
	el!.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
	flushSync();
}

async function save() {
	host.querySelector<HTMLFormElement>('[data-testid="tenant-licence-editor"] form')!
		.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
}

describe('tenant licence editor', () => {
	it('shows the status chip with plan and expiry, and no drift when licences agrees', async () => {
		await openEditor();
		expect(host.querySelector('[data-testid="tenant-licence-status"]')?.textContent).toContain('admin_licence_status_active');
		expect(host.querySelector('[data-testid="tenant-header"]')?.textContent).toContain('admin_licence_chip:Standard,');
		expect(host.querySelector('[data-testid="tenant-licence-drift"]')).toBeNull();
		expect(host.querySelector<HTMLSelectElement>('[data-testid="licence-plan"]')!.value).toBe('standard');
		expect(host.querySelector<HTMLInputElement>('[data-testid="licence-expires"]')!.value).toBe('2027-01-15');
	});

	it('⛔ saving an untouched form sends NOTHING (a re-sent plan would re-mint the licence)', async () => {
		await openEditor();
		await save();
		expect(patchTenant).not.toHaveBeenCalled();
		expect(host.querySelector('[data-testid="tenant-licence-error"]')?.textContent).toContain('admin_licence_no_changes');
	});

	it('a plan change sends ONLY planCode, and reports the re-mint', async () => {
		patchTenant.mockResolvedValue(
			okPatch({
				licence: {
					changed: true,
					before: {},
					after: {},
					reminted: true,
					oldLicenceRevoked: true,
					membersReissued: 4,
					memberFailures: []
				}
			})
		);
		await openEditor();
		set('licence-plan', 'pro');
		await save();
		expect(patchTenant).toHaveBeenCalledWith('t-1', { planCode: 'pro' });
		const banner = host.querySelector('.banner.ok');
		expect(banner?.textContent).toContain('admin_licence_saved:Acme BV');
		expect(banner?.textContent).toContain('admin_licence_reminted:4');
		// The page re-reads what the backend now holds, so a second save diffs against the NEW terms.
		expect(tenantLicence).toHaveBeenCalledTimes(2);
		expect(platformTenant).toHaveBeenCalledTimes(2);
	});

	it('clearing the expiry sends `expiresAt: null` (perpetual), not an omitted key', async () => {
		await openEditor();
		host.querySelector<HTMLButtonElement>('[data-testid="licence-expires-clear"]')!.click();
		flushSync();
		await save();
		expect(patchTenant).toHaveBeenCalledWith('t-1', { expiresAt: null });
	});

	it('an old licence that could not be revoked is a WARNING, not a plain success', async () => {
		patchTenant.mockResolvedValue(
			okPatch({
				licence: {
					changed: true,
					before: {},
					after: {},
					reminted: true,
					oldLicenceRevoked: false,
					membersReissued: 0,
					memberFailures: [{ userId: 'u', email: 'x@y', message: 'boom' }]
				}
			})
		);
		await openEditor();
		set('licence-plan', 'pro');
		await save();
		const banner = host.querySelector('.banner.warn');
		expect(banner?.textContent).toContain('admin_licence_old_unrevoked');
		expect(banner?.textContent).toContain('admin_licence_seats_pending:1');
	});

	it('⛔ seats_below_usage names the numbers', async () => {
		patchTenant.mockRejectedValue(
			new FakeApiError(409, 'seats_below_usage', { members: 4, pending: 2, used: 6, requested: 3 })
		);
		await openEditor();
		set('licence-seats', '3');
		await save();
		expect(patchTenant).toHaveBeenCalledWith('t-1', { maxMembers: 3 });
		expect(host.querySelector('[data-testid="tenant-licence-error"]')?.textContent).toContain(
			'admin_licence_seats_below_usage:6,4,2,3'
		);
		// The editor stays open with the operator's input, so they can correct it.
		expect(host.querySelector<HTMLInputElement>('[data-testid="licence-seats"]')!.value).toBe('3');
	});

	it('every other refusal goes through the localized error catalogue', async () => {
		patchTenant.mockRejectedValue(new FakeApiError(422, 'plan_retired'));
		await openEditor();
		set('licence-plan', 'pro');
		await save();
		expect(host.querySelector('[data-testid="tenant-licence-error"]')?.textContent).toContain('[plan_retired]');
	});

	it('⛔ a plan that FIXES the LLM access shows it as text — no (disabled) select, one non-repeating hint', async () => {
		// It used to be a disabled <select> plus "Set by the plan: <mode>." — a dropdown that does
		// not open, followed by a hint repeating it.
		const limits = { durationDays: null, rateLimitBurst: null, quotaMonthly: null, tokenBudgetMonthly: null };
		plans.mockImplementation(async () => ({
			app: 'commonpractice',
			defaultPlanCode: 'standard',
			plans: [
				{ id: 'p1', code: 'standard', name: 'Standard', revoked: false, isDefault: true, tenantCount: 1, ...limits, rateLimitRpm: 60 },
				{ id: 'p3', code: 'local-llm', name: 'Local LLM', revoked: false, isDefault: false, tenantCount: 0, ...limits, rateLimitRpm: 600 }
			],
			capabilities: { canRetire: true }
		}));
		await openEditor();
		expect(host.querySelector('select[data-testid="licence-byo"]'), 'the editable select is missing for a non-fixing plan').not.toBeNull();
		set('licence-plan', 'local-llm');
		await settle();
		const field = host.querySelector('[data-testid="licence-byo-help"]')!.closest('.field')!;
		expect(field.querySelector('select'), 'a select is rendered for a plan-fixed LLM access').toBeNull();
		expect(host.querySelector('[data-testid="licence-byo"]')).toBeNull();
		const value = host.querySelector('[data-testid="licence-byo-value"]');
		expect(value?.textContent?.trim()).toBe('admin_tenants_byo_local_allowed');
		expect(field.querySelector('label[for]')).toBeNull();
		const labelId = value!.getAttribute('aria-labelledby')!;
		expect(document.getElementById(labelId)?.textContent).toBe('admin_tenants_byo_label');
		const fixed = host.querySelectorAll('[data-testid="licence-byo-fixed"]');
		expect(fixed.length).toBe(1);
		expect(fixed[0]!.textContent).toBe('admin_tenants_byo_fixed_by_plan');
		expect(host.querySelector('[data-testid="licence-byo-help"]')?.textContent?.trim()).toBe('admin_tenants_byo_help_local_allowed');
		// What is sent is unchanged: the plan's mode, because it differs from the stored one.
		await save();
		expect(patchTenant).toHaveBeenCalledWith('t-1', { planCode: 'local-llm', byoMode: 'local_allowed' });
	});

	it('BYO, status and name are sent when changed', async () => {
		await openEditor();
		set('licence-byo', 'local_allowed');
		set('licence-status', 'suspended');
		set('licence-name', 'Acme Group');
		await save();
		expect(patchTenant).toHaveBeenCalledWith('t-1', {
			name: 'Acme Group',
			byoMode: 'local_allowed',
			status: 'suspended'
		});
	});

	it('shows drift when licences holds another plan / expiry', async () => {
		tenantLicence.mockResolvedValue(
			licence({
				live: {
					active: true,
					licenceId: 'lic-0',
					planCode: 'legacy',
					expiresAt: null,
					status: 'active',
					subjectId: 's',
					candidateCount: 1
				}
			})
		);
		await openEditor();
		const drift = host.querySelector('[data-testid="tenant-licence-drift"]');
		expect(drift?.textContent).toContain('admin_licence_drift_plan:legacy');
		expect(drift?.textContent).toContain('admin_licence_drift_expiry:admin_licence_no_end');
	});

	it('⛔ an unreachable licences is "could not check", never drift', async () => {
		tenantLicence.mockResolvedValue(licence({ live: null, liveError: 'connect ECONNREFUSED' }));
		await openEditor();
		expect(host.querySelector('[data-testid="tenant-licence-live-error"]')?.textContent).toContain('ECONNREFUSED');
		expect(host.querySelector('[data-testid="tenant-licence-drift"]')).toBeNull();
	});

	it('after a save the editor diffs against the RELOADED terms, so re-saving sends nothing', async () => {
		await openEditor();
		set('licence-plan', 'pro');
		tenantLicence.mockResolvedValue(licence({ planCode: 'pro' }));
		await save();
		expect(patchTenant).toHaveBeenCalledTimes(1);
		expect(host.querySelector<HTMLSelectElement>('[data-testid="licence-plan"]')!.value).toBe('pro');
		await save();
		expect(patchTenant, 'a second save re-sent the plan and would re-mint again').toHaveBeenCalledTimes(1);
		expect(host.querySelector('[data-testid="tenant-licence-error"]')?.textContent).toContain('admin_licence_no_changes');
	});

	it('the selected plan’s limits are shown under the plan select and follow the selection', async () => {
		await openEditor();
		const limits = () => host.querySelector('[data-testid="licence-plan-limits"]')?.textContent ?? '';
		expect(limits()).toMatch(/admin_plans_rpm,60(?!\d)/);
		set('licence-plan', 'pro');
		expect(limits()).toContain('admin_plans_rpm,600');
	});
});

describe('every option says what it means', () => {
	it('⛔ the BYO help text follows the SELECTED mode, one explanation per value', async () => {
		await openEditor();
		const help = () => host.querySelector('[data-testid="licence-byo-help"]')?.textContent?.trim();
		expect(help()).toBe('admin_tenants_byo_help_byo_required');
		set('licence-byo', 'local_allowed');
		expect(help()).toBe('admin_tenants_byo_help_local_allowed');
		set('licence-byo', 'platform_only');
		expect(help()).toBe('admin_tenants_byo_help_platform_only');
		// Picking a mode only changes the text; nothing is sent until Save.
		expect(patchTenant).not.toHaveBeenCalled();
	});

	it('an unreadable BYO posture says so, and the help says leaving it changes nothing', async () => {
		tenantLicence.mockResolvedValue(licence({ byoMode: null }));
		await openEditor();
		expect(host.querySelector('[data-testid="licence-byo-help"]')?.textContent?.trim()).toBe('admin_tenants_byo_help_unknown');
	});

	it('the seats, dates, status and plan fields each carry their explanation', async () => {
		await openEditor();
		const text = host.querySelector('[data-testid="tenant-licence-editor"]')?.textContent ?? '';
		for (const key of [
			'admin_tenants_seats_help',
			'admin_tenants_starts_help',
			'admin_tenants_expires_help',
			'admin_tenants_status_help',
			'admin_tenants_plan_change_help',
			'admin_licence_name_hint'
		]) {
			expect(text, key).toContain(key);
		}
	});
});

describe('the system tenant is read-only', () => {
	it('⛔ no editor, no suspend/offboard, and it says why — never an editor PATCH can only 409', async () => {
		platformTenant.mockResolvedValue(
			tenant({ id: '00000000-0000-0000-0000-000000000000', name: 'Dev User', slug: 'u-00000000000000000000000000000000', isSystemTenant: true })
		);
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.querySelector('[data-testid="tenant-header"]'), 'the page never rendered').not.toBeNull();
		expect(host.querySelector('[data-testid="tenant-system-notice"]')?.textContent).toContain('admin_tenants_system_hint');
		expect(host.querySelector('[data-testid="tenant-system-badge"]')).not.toBeNull();
		// ⛔ ONCE in the header: the subtitle used to repeat the badge ("System workspace" twice).
		const head = host.querySelector('[data-testid="tenant-header"]')!.textContent ?? '';
		expect(head.split('admin_tenants_system').length - 1).toBe(1);
		// ⛔ No plan chip: the system tenant holds no licence and Plans does not count it, so a
		// "Standard · until …" here contradicted both.
		expect(host.querySelector('[data-testid="tenant-plan-chip"]')).toBeNull();
		expect(host.querySelector('[data-testid="tenant-licence-editor"]'), 'an editor for a tenant PATCH refuses').toBeNull();
		expect(host.querySelector('input, select'), 'an editable field on the system tenant').toBeNull();
		expect(host.querySelector('[data-testid="tenant-toggle-status"]')).toBeNull();
		expect(host.querySelector('[data-testid="tenant-offboard"]')).toBeNull();
		expect(host.querySelector('[data-testid="tenant-licence-action"]')).toBeNull();
		// Its licence is never even read: there is nothing to edit.
		expect(tenantLicence).not.toHaveBeenCalled();
	});

	it('a tenant that does not exist is a "not found", not an empty editor', async () => {
		platformTenant.mockResolvedValue(null);
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.querySelector('[data-testid="tenant-not-found"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="tenant-licence-editor"]')).toBeNull();
	});
});
