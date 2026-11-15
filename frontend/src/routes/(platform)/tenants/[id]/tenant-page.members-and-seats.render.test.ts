// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/[id]/tenant-page.members-and-seats.render.test.ts — two defects from
// the prod browser E2E of 2026-10-14 on tenant Netcare:
//   · the seat counter read "0 / unlimited" with a tenant_admin invite pending, while the copy right
//     above it says pending invitations count (and the backend enforces the cap that way);
//   · "Open members" reloaded THIS page instead of opening /members: it called `activeTenant.set()`
//     (which reloads) and then `goto('/members')`, and the reload won.
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
	writeErrorText: (_e: unknown, f: string) => f
}));

const { activeTenant, goto, platformTenant, tenantLicence, actAsCheck } = vi.hoisted(() => ({
	activeTenant: { current: null as { id: string; name: string } | null, set: vi.fn() },
	goto: vi.fn(),
	platformTenant: vi.fn(),
	tenantLicence: vi.fn(),
	actAsCheck: vi.fn()
}));
vi.mock('$lib/stores/activeTenant.svelte', () => ({ activeTenant }));
vi.mock('$app/state', () => ({ page: { params: { id: 't-1' }, url: new URL('http://localhost/tenants/t-1') } }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		platformTenant,
		tenantLicence,
		actAsCheck,
		plans: vi.fn(async () => ({ app: 'commonpractice', defaultPlanCode: 'standard', plans: [], capabilities: { canRetire: true } })),
		tenantProvisioning: vi.fn(() => new Promise(() => {})),
		tenantTerms: vi.fn(async () => ({ tenantId: 't-1', terms: null, configured: false })),
		rateCard: vi.fn(async () => ({ rateCard: null })),
		patchTenant: vi.fn(),
		issueLicense: vi.fn()
	}
}));

const NETCARE: PlatformTenant = {
	id: 't-1',
	name: 'Netcare',
	slug: 'netcare',
	status: 'active',
	createdAt: '2026-10-13T00:00:00.000Z',
	memberCount: 0,
	pendingInviteCount: 1,
	seatsUsed: 1,
	maxMembers: null,
	licensed: true,
	offboardedAt: null
} as PlatformTenant;

const LICENCE = {
	tenantId: 't-1',
	planCode: 'standard',
	startsAt: null,
	expiresAt: null,
	status: 'active',
	tenantStatus: 'active',
	licensed: true,
	licenceId: 'lic-1',
	byoMode: 'byo_required',
	licencesName: 'netcare',
	centralLink: 'registered',
	centralConfigured: true,
	live: null,
	liveError: null
} as unknown as TenantLicence;

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	activeTenant.current = null;
	platformTenant.mockResolvedValue(NETCARE);
	tenantLicence.mockResolvedValue(LICENCE);
	actAsCheck.mockResolvedValue(null);
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
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

async function render() {
	const { default: Page } = await import('./+page.svelte');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(host.querySelectorAll('[data-testid="tenant-header"]').length, 'no tenant rendered').toBe(1);
}

describe('seat counter', () => {
	it('⛔ counts the pending invite, as the copy promises — "1 / unlimited", not "0 / unlimited"', async () => {
		await render();
		const text = host.textContent ?? '';
		expect(text).toContain('admin_tenants_seats_used_unlimited:1');
		expect(text).not.toContain('admin_tenants_seats_used_unlimited:0');
	});

	it('an older backend without seatsUsed still renders the member count', async () => {
		platformTenant.mockResolvedValue({ ...NETCARE, memberCount: 3, seatsUsed: undefined, pendingInviteCount: undefined });
		await render();
		expect(host.textContent ?? '').toContain('admin_tenants_seats_used_unlimited:3');
	});
});

describe('Open members', () => {
	it('⛔ acting as a DIFFERENT tenant: switches scope AND navigates to /members in one full load', async () => {
		activeTenant.current = { id: 't-other', name: 'Other' };
		await render();
		host.querySelector<HTMLButtonElement>('[data-testid="tenant-members-link"]')!.click();
		await settle();
		expect(actAsCheck).toHaveBeenCalledWith('t-1');
		expect(activeTenant.set).toHaveBeenCalledWith('t-1', 'Netcare', { navigateTo: '/members' });
		// A goto after a reloading set() is exactly the race that landed back on this page.
		expect(goto).not.toHaveBeenCalled();
	});

	it('already acting as this tenant: a plain client-side goto, no scope switch', async () => {
		activeTenant.current = { id: 't-1', name: 'Netcare' };
		await render();
		host.querySelector<HTMLButtonElement>('[data-testid="tenant-members-link"]')!.click();
		flushSync();
		expect(goto).toHaveBeenCalledWith('/members');
		expect(activeTenant.set).not.toHaveBeenCalled();
	});
});

// ⛔ THE BUG (2026-10-27). "Act as" on a workspace with no active licence switched, reloaded, and
// /api/me refused the acting tenant — the SPA dropped the choice and the operator was silently back
// in their own workspace. The backend gates a scope-switched super_admin on the acting tenant's
// licence (every tenant-admin route runs `validateAuth` → Gate 2), so the switch is now refused UP
// FRONT, with the reason, after asking the backend the same question (`adminApi.actAsCheck`).
describe('Act as — refused up front, never a silent drop', () => {
	const actAsButton = () => host.querySelector<HTMLButtonElement>('[data-testid="tenant-act-as"]')!;

	it('⛔ an unlicensed workspace: NO switch, and the refusal names the workspace and the licence reason', async () => {
		actAsCheck.mockResolvedValue('license_required');
		await render();
		actAsButton().click();
		await settle();
		expect(actAsCheck).toHaveBeenCalledWith('t-1');
		expect(activeTenant.set).not.toHaveBeenCalled();
		const text = host.textContent ?? '';
		expect(text).toContain('tenant_act_as_refused:Netcare,act_as_reason_licence');
	});

	it('⛔ "Open members" on an unlicensed workspace is refused the same way (it is an act-as too)', async () => {
		actAsCheck.mockResolvedValue('license_inactive');
		await render();
		host.querySelector<HTMLButtonElement>('[data-testid="tenant-members-link"]')!.click();
		await settle();
		expect(activeTenant.set).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
		expect(host.textContent ?? '').toContain('tenant_act_as_refused:Netcare,act_as_reason_licence');
	});

	it('a suspended workspace: refused with the suspension reason', async () => {
		actAsCheck.mockResolvedValue('tenant_suspended');
		await render();
		actAsButton().click();
		await settle();
		expect(activeTenant.set).not.toHaveBeenCalled();
		expect(host.textContent ?? '').toContain('tenant_act_as_refused:Netcare,act_as_reason_suspended');
	});

	it('an admitted workspace: switches (full reload, no navigation target)', async () => {
		await render();
		actAsButton().click();
		await settle();
		expect(activeTenant.set).toHaveBeenCalledWith('t-1', 'Netcare', {});
	});

	it('the check itself fails (outage): an error, and NO switch — never a guess', async () => {
		actAsCheck.mockRejectedValue(new Error('licences down'));
		await render();
		actAsButton().click();
		await settle();
		expect(activeTenant.set).not.toHaveBeenCalled();
		expect(host.textContent ?? '').toContain('error_action_failed');
	});
});
