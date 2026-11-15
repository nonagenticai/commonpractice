// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/[id]/tenant-page.setup.render.test.ts — the workspace page's "Setup"
// section: what each creation step did (backend 0101), and Retry on the steps that did not land.
//
// ⛔ WHY. Creating "Netcare" (prod 2026-10-13) reported success while billing had refused its terms,
// and the terms were simply lost — no record, no retry, nothing on this page to say so. Now every
// step has a record; a failed/pending one shows its cause and a Retry that re-runs it with the
// inputs held since create (nothing is re-typed), and a pre-record workspace says it has no record.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PlatformTenant, ProvisioningView } from '$lib/types/admin';

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
vi.mock('$lib/stores/activeTenant.svelte', () => ({ activeTenant: { current: null, set: vi.fn() } }));
vi.mock('$app/state', () => ({ page: { params: { id: 't-1' }, url: new URL('http://localhost/tenants/t-1') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { platformTenant, tenantProvisioning, retryProvisioning, tenantTerms } = vi.hoisted(() => ({
	platformTenant: vi.fn(),
	tenantProvisioning: vi.fn(),
	retryProvisioning: vi.fn(),
	tenantTerms: vi.fn()
}));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		platformTenant,
		tenantProvisioning,
		retryProvisioning,
		tenantTerms,
		rateCard: vi.fn(async () => ({ rateCard: null })),
		tenantLicence: vi.fn(() => new Promise(() => {})),
		plans: vi.fn(async () => ({ app: 'commonpractice', defaultPlanCode: 'standard', plans: [], capabilities: { canRetire: true } })),
		patchTenant: vi.fn(),
		issueLicense: vi.fn()
	}
}));

const TENANT: PlatformTenant = {
	id: 't-1',
	name: 'Netcare',
	slug: 'netcare',
	status: 'active',
	createdAt: '2026-10-13T00:00:00.000Z',
	memberCount: 0,
	maxMembers: null,
	licensed: true,
	licenseState: 'active',
	licenseHasToken: true,
	offboardedAt: null
} as PlatformTenant;

const rec = (status: 'ok' | 'failed' | 'pending' | 'skipped', over: Record<string, unknown> = {}) => ({
	status,
	code: null,
	message: null,
	attempts: 1,
	lastAttemptAt: '2026-10-13T10:00:00.000Z',
	nextAttemptAt: null,
	...over
});

const PENDING: ProvisioningView = {
	recorded: true,
	termsHeld: true,
	firstAdminHeld: false,
	steps: {
		licences_tenant: rec('ok'),
		licence: rec('ok'),
		billing_terms: rec('pending', {
			code: 'billing_tenant_not_registered',
			message: 'write commercial terms failed: HTTP 422',
			nextAttemptAt: '2026-10-13T10:05:00.000Z'
		}),
		ir_licence: rec('skipped', { attempts: 0 }),
		first_invite: rec('ok')
	}
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	platformTenant.mockResolvedValue(TENANT);
	tenantTerms.mockResolvedValue({ tenantId: 't-1', terms: null, configured: false });
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
	expect(host.querySelectorAll('[data-testid="tenant-header"]').length, 'no tenant rendered').toBe(1);
}

const q = (sel: string) => host.querySelector<HTMLElement>(sel);

describe('workspace page — Setup', () => {
	it('shows every recorded step with its state; only the unfinished one offers Retry, with its cause', async () => {
		tenantProvisioning.mockResolvedValue({ tenantId: 't-1', provisioning: PENDING });
		await render();
		expect(tenantProvisioning).toHaveBeenCalledWith('t-1');
		const billing = q('[data-testid="tenant-setup-step-billing_terms"]');
		expect(billing?.textContent).toContain('admin_tenant_setup_status_pending');
		expect(billing?.textContent).toContain('write commercial terms failed: HTTP 422');
		expect(billing?.textContent).toContain('admin_tenant_setup_terms_held');
		expect(q('[data-testid="tenant-setup-step-licence"]')?.textContent).toContain('admin_tenant_setup_status_ok');
		expect(q('[data-testid="tenant-setup-step-ir_licence"]')?.textContent).toContain('admin_tenant_setup_status_skipped');
		expect(q('[data-testid="tenant-setup-retry-billing_terms"]')).not.toBeNull();
		expect(q('[data-testid="tenant-setup-retry-licence"]')).toBeNull();
	});

	it('Retry re-runs that step and shows the new state', async () => {
		tenantProvisioning.mockResolvedValue({ tenantId: 't-1', provisioning: PENDING });
		retryProvisioning.mockResolvedValue({
			tenantId: 't-1',
			step: 'billing_terms',
			record: rec('ok', { attempts: 2 }),
			provisioning: { ...PENDING, termsHeld: false, steps: { ...PENDING.steps, billing_terms: rec('ok', { attempts: 2 }) } }
		});
		await render();
		(q('[data-testid="tenant-setup-retry-billing_terms"]') as HTMLButtonElement).click();
		await settle();
		expect(retryProvisioning).toHaveBeenCalledWith('t-1', 'billing_terms');
		expect(q('[data-testid="tenant-setup-step-billing_terms"]')?.textContent).toContain('admin_tenant_setup_status_ok');
		expect(q('[data-testid="tenant-setup-retry-billing_terms"]')).toBeNull();
		expect(host.textContent).toContain('admin_tenant_setup_retry_done');
	});

	it('an INTERRUPTED step (create died mid-flight) explains itself in the catalog and offers Retry', async () => {
		tenantProvisioning.mockResolvedValue({
			tenantId: 't-1',
			provisioning: {
				...PENDING,
				steps: {
					...PENDING.steps,
					billing_terms: rec('ok'),
					first_invite: rec('failed', { code: 'interrupted', message: 'raw english detail', attempts: 0 })
				}
			}
		});
		await render();
		const step = q('[data-testid="tenant-setup-step-first_invite"]');
		expect(step?.textContent).toContain('admin_tenant_setup_status_failed');
		expect(q('[data-testid="tenant-setup-interrupted-first_invite"]')?.textContent).toContain(
			'admin_tenant_setup_interrupted'
		);
		expect(step?.textContent).not.toContain('raw english detail');
		expect(q('[data-testid="tenant-setup-retry-first_invite"]')).not.toBeNull();
	});

	it('a workspace created before the record says it has none (never an invented "done")', async () => {
		tenantProvisioning.mockResolvedValue({
			tenantId: 't-1',
			provisioning: { recorded: false, steps: {}, termsHeld: false, firstAdminHeld: false }
		});
		await render();
		expect(q('[data-testid="tenant-setup-none"]')).not.toBeNull();
		expect(host.textContent).not.toContain('admin_tenant_setup_status_ok');
	});
});
