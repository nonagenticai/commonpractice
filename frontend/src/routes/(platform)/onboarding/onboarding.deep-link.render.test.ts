// @vitest-environment jsdom
//
// src/routes/(platform)/onboarding/onboarding.deep-link.render.test.ts — the Telegram deep link.
//
// The early-access signup notification's Approve / Reject buttons open
// `/onboarding?signup=<id>&action=approve|reject`. This screen must then focus THAT signup in a
// confirm dialog with the decision prefilled — and decide nothing until the super_admin confirms.
// A link for a signup that is no longer pending says so instead of opening an empty dialog.
//
// Messages are mocked key-returns-its-own-name from the real en.json, so no assertion depends on
// wording.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

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
	errorText: () => 'ERR',
	writeErrorText: () => 'WRITE_ERR'
}));

const SIGNUP = {
	id: 's-1',
	keycloak_sub: null,
	email: 'ann@globex.test',
	name: 'Ann Early',
	status: 'pending',
	matched_tenant_id: null,
	assigned_tenant_id: null,
	requested_role: 'member',
	note: null,
	company: 'Globex',
	source: 'web',
	suggested_tenant_name: 'Globex',
	created_at: '2026-10-14T08:00:00.000Z',
	decided_at: null,
	decided_by: null
};

const approveCalls: Array<[string, Record<string, unknown>]> = [];
const rejectCalls: string[] = [];
let pendingList: Array<Record<string, unknown>> = [];

vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		signupApprovals: async () => ({ approvals: pendingList }),
		allTenants: async () => ({ tenants: [] }),
		emailDomains: async () => ({ domains: [] }),
		signupStats: async () => ({ stats: { pending: pendingList.length, approved: 0, rejected: 0, total: pendingList.length } }),
		approveSignup: async (id: string, body: Record<string, unknown>) => {
			approveCalls.push([id, body]);
			pendingList = [];
			return { approval: { ...SIGNUP, status: 'approved' }, tenantId: 't-new', role: 'tenant_admin', invite: null };
		},
		rejectSignup: async (id: string) => {
			rejectCalls.push(id);
			pendingList = [];
			return { approval: { ...SIGNUP, status: 'rejected' } };
		}
	}
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	approveCalls.length = 0;
	rejectCalls.length = 0;
	pendingList = [{ ...SIGNUP }];
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	window.history.replaceState(null, '', '/');
});

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function mountAt(url: string): Promise<void> {
	window.history.replaceState(null, '', url);
	const { default: Onboarding } = await import('./+page.svelte');
	app = mount(Onboarding, { target: host });
	await settle();
}

const dialog = () => host.querySelector<HTMLElement>('[data-testid="signup-focus"]');
const confirmBtn = () => host.querySelector<HTMLButtonElement>('[data-testid="signup-focus-confirm"]');

describe('Onboarding — the Telegram deep link focuses one signup', () => {
	it('?action=approve opens the approve dialog with the suggested name prefilled; nothing is sent until confirm', async () => {
		await mountAt('/onboarding?signup=s-1&action=approve');
		const d = dialog();
		expect(d).not.toBeNull();
		expect(d!.textContent).toContain('admin_onboarding_focus_approve_title');
		expect(d!.textContent).toContain('ann@globex.test');
		expect(d!.textContent).toContain('Globex');
		expect(d!.textContent).toContain('admin_onboarding_source_web');
		const name = host.querySelector<HTMLInputElement>('#signup-focus-name');
		expect(name?.value).toBe('Globex');
		expect(host.querySelector('#signup-s-1')?.classList.contains('focused')).toBe(true);
		expect(approveCalls).toEqual([]);

		confirmBtn()!.click();
		await settle();
		expect(approveCalls).toEqual([['s-1', { mode: 'new_tenant', tenantName: 'Globex' }]]);
		expect(dialog()).toBeNull();
		// The deep link is dropped so a reload does not reopen a decided signup.
		expect(window.location.search).toBe('');
	});

	it('an emptied name sends NO tenantName (the server default applies)', async () => {
		await mountAt('/onboarding?signup=s-1&action=approve');
		const name = host.querySelector<HTMLInputElement>('#signup-focus-name')!;
		name.value = '';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		confirmBtn()!.click();
		await settle();
		expect(approveCalls).toEqual([['s-1', { mode: 'new_tenant' }]]);
	});

	it('?action=reject opens the reject dialog; confirm rejects exactly that signup', async () => {
		await mountAt('/onboarding?signup=s-1&action=reject');
		expect(dialog()!.textContent).toContain('admin_onboarding_focus_reject_title');
		expect(host.querySelector('#signup-focus-name')).toBeNull();
		expect(rejectCalls).toEqual([]);
		confirmBtn()!.click();
		await settle();
		expect(rejectCalls).toEqual(['s-1']);
		expect(approveCalls).toEqual([]);
	});

	it('cancel closes the dialog and decides nothing', async () => {
		await mountAt('/onboarding?signup=s-1&action=approve');
		[...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.includes('admin_onboarding_focus_cancel'))!.click();
		await settle();
		expect(dialog()).toBeNull();
		expect(approveCalls).toEqual([]);
		expect(rejectCalls).toEqual([]);
	});

	it('a link for a signup that is no longer pending says so — no dialog', async () => {
		await mountAt('/onboarding?signup=gone&action=approve');
		expect(dialog()).toBeNull();
		expect(host.querySelector('[data-testid="signup-focus-missing"]')).not.toBeNull();
	});

	it('without a deep link the page is unchanged: no dialog', async () => {
		await mountAt('/onboarding');
		expect(dialog()).toBeNull();
		expect(host.querySelector('[data-testid="signup-focus-missing"]')).toBeNull();
	});
});

describe('Onboarding — the applicant’s message', () => {
	const MSG = 'Hi,\nwe run <b>3</b> clinics.';

	it('is shown as plain text with its line breaks, in the row and in the dialog', async () => {
		pendingList = [{ ...SIGNUP, message: MSG }];
		await mountAt('/onboarding?signup=s-1&action=approve');
		const row = host.querySelector<HTMLElement>('[data-testid="signup-message"]')!;
		const focus = host.querySelector<HTMLElement>('[data-testid="signup-focus-message"]')!;
		for (const el of [row, focus]) {
			expect(el.textContent).toBe(MSG); // the \n survives as text …
			expect(el.querySelector('b')).toBeNull(); // … and markup is not interpreted
		}
		expect(dialog()!.textContent).toContain('admin_onboarding_message');
	});

	it('renders nothing when the backend sends no message (older backend mid-rollout)', async () => {
		await mountAt('/onboarding?signup=s-1&action=approve');
		expect(host.querySelector('[data-testid="signup-message"]')).toBeNull();
		expect(host.querySelector('[data-testid="signup-focus-message"]')).toBeNull();
		expect(dialog()!.textContent).not.toContain('admin_onboarding_message');
	});
});
