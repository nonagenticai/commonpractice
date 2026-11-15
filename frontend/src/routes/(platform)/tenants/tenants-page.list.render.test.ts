// @vitest-environment jsdom
//
// src/routes/(platform)/tenants/tenants-page.list.render.test.ts — the compact all-tenants list.
// Pins the three things a prod walk found wrong with the old wide row:
//   · the seed SYSTEM tenant (nil UUID) read "Licensed" while its editor warned that licences holds
//     no licence, and the editor opened although PATCH/offboard answer 409 `system_tenant`;
//   · a long name (raisemytickets) ran over the plan chip — it must truncate and carry `title`;
//   · editing lives on /tenants/<id>: every row links there, and no in-row editor exists any more.
// Messages are mocked key-returns-its-own-name from the real en.json, so nothing depends on wording.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlatformTenant } from '$lib/types/admin';

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

const { allTenants, plans } = vi.hoisted(() => ({ allTenants: vi.fn(), plans: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: { allTenants, plans, createTenant: vi.fn() }
}));

const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';
const LONG = 'raisemytickets-enterprise-support-workspace-for-the-entire-benelux-region';

function tenant(over: Partial<PlatformTenant> = {}): PlatformTenant {
	return {
		id: 't-1',
		name: 'Acme BV',
		slug: 'acme-bv',
		status: 'active',
		createdAt: '2026-01-05T00:00:00.000Z',
		memberCount: 2,
		maxMembers: 5,
		licensed: true,
		licenseState: 'active',
		licenseHasToken: true,
		offboardedAt: null,
		planCode: 'standard',
		licenceExpiresAt: null,
		isSystemTenant: false,
		...over
	};
}

let rows: PlatformTenant[];
let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	rows = [
		tenant(),
		tenant({ id: 't-2', name: LONG, slug: 'raisemytickets' }),
		tenant({
			id: SYSTEM_ID,
			name: 'Dev User',
			slug: `u-${SYSTEM_ID.replace(/-/g, '')}`,
			maxMembers: null,
			memberCount: 1,
			isSystemTenant: true
		})
	];
	allTenants.mockImplementation(async () => ({ tenants: rows, total: rows.length }));
	plans.mockImplementation(async () => ({
		app: 'commonpractice',
		defaultPlanCode: 'standard',
		plans: [],
		capabilities: { canRetire: true }
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
	// Anti-vacuity: every `toBeNull()` below would pass against a page stuck loading.
	expect(host.querySelectorAll('[data-testid="tenant-row"]').length, 'the rows never rendered').toBe(rows.length);
}

const row = (id: string) =>
	[...host.querySelectorAll<HTMLAnchorElement>('[data-testid="tenant-row"]')].find((a) =>
		a.getAttribute('href')?.endsWith(`/tenants/${id}`)
	) ?? null;

describe('the system tenant', () => {
	it('⛔ is labelled "System workspace", never "Licensed"', async () => {
		await render();
		const sys = row(SYSTEM_ID);
		expect(sys, 'the system row does not link to its page').not.toBeNull();
		expect(sys!.querySelector('[data-testid="tenant-system-badge"]')?.textContent).toContain('admin_tenants_system');
		expect(sys!.textContent, 'the system row claims a licence verdict').not.toContain('admin_tenants_license_ok');
		expect(sys!.textContent).not.toContain('admin_tenants_license_missing');
		// Over-correction guard: an ordinary tenant is NOT a system workspace.
		expect(row('t-1')!.querySelector('[data-testid="tenant-system-badge"]')).toBeNull();
	});

	it('⛔ says "System workspace" ONCE — the subtitle no longer repeats the badge', async () => {
		await render();
		const text = row(SYSTEM_ID)!.textContent ?? '';
		expect(text.split('admin_tenants_system').length - 1).toBe(1);
		// …and no plan: Plans does not count the system tenant, so its row names none.
		expect(row(SYSTEM_ID)!.querySelector('[data-testid="tenant-plan-chip"]')?.textContent?.trim() ?? '').toBe('');
	});
});

describe('the New workspace toggle', () => {
	it('is the primary button while closed and a secondary (ghost) "Cancel" while open', async () => {
		await render();
		const btn = host.querySelector<HTMLButtonElement>('[data-testid="tenant-new"]')!;
		expect(btn.classList.contains('btn-primary')).toBe(true);
		btn.click();
		flushSync();
		expect(btn.textContent).toContain('common_cancel');
		expect(btn.classList.contains('btn-ghost')).toBe(true);
		expect(btn.classList.contains('btn-primary')).toBe(false);
	});
});

describe('long names', () => {
	it('⛔ carry the full name in `title`, in a cell that truncates instead of overlapping', async () => {
		await render();
		const name = row('t-2')!.querySelector<HTMLElement>('[data-testid="tenant-name"]');
		expect(name?.textContent?.trim()).toBe(LONG);
		expect(name?.getAttribute('title'), 'a truncated name with no way to read it whole').toBe(LONG);
		expect(name?.classList.contains('name')).toBe(true);
	});

	it('⛔ the stylesheet truncates `.name` (ellipsis + nowrap + hidden overflow), and its cell may shrink', () => {
		// jsdom has no layout, so the rule itself is pinned: drop any one of the three and a long name
		// either wraps over the next line or runs under the plan cell again.
		const src = readFileSync(resolve(process.cwd(), 'src/routes/(platform)/tenants/+page.svelte'), 'utf8');
		const style = src.slice(src.indexOf('<style>'));
		expect(style.length, 'no <style> block found').toBeGreaterThan(100);
		const rule = /\.name, \.slug, \.plan \{([^}]*)\}/.exec(style)?.[1] ?? '';
		expect(rule).toContain('overflow: hidden');
		expect(rule).toContain('text-overflow: ellipsis');
		expect(rule).toContain('white-space: nowrap');
		expect(style).toMatch(/\.cell \{ min-width: 0; \}/);
	});
});

describe('the list is a list; editing lives on /tenants/<id>', () => {
	it('every row links to its tenant page and carries name, status, plan and seats', async () => {
		await render();
		const r = row('t-1')!;
		expect(r.getAttribute('href')).toBe('/tenants/t-1');
		expect(r.querySelector('.status.active')).not.toBeNull();
		expect(r.querySelector('[data-testid="tenant-plan-chip"]')?.textContent).toContain('admin_licence_chip_perpetual:standard');
		expect(r.textContent).toContain('admin_tenants_seats_used:2,5');
		expect(row(SYSTEM_ID)!.textContent).toContain('admin_tenants_seats_used_unlimited:1');
	});

	it('⛔ no in-row editor, offboard or suspend control is left on the list', async () => {
		await render();
		for (const id of ['tenant-edit-licence', 'tenant-licence-editor', 'tenant-offboard', 'tenant-toggle-status']) {
			expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
		}
	});

	it('a licence nobody can use is still loud on the list', async () => {
		rows = [tenant({ licenseState: 'none', licenseHasToken: false, licensed: false })];
		await render();
		expect(host.querySelector('[data-testid="tenant-licence-chip"]')?.textContent).toContain('admin_tenants_license_missing');
	});
});
