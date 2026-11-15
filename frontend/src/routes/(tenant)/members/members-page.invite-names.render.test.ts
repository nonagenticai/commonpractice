// @vitest-environment jsdom
//
// src/routes/(tenant)/members/members-page.invite-names.render.test.ts — an invite carries the
// invitee's first AND last name.
//
// ⛔ The portal realm REQUIRES both names. An identity minted without them is stopped at Keycloak's
// VERIFY_PROFILE form on its first sign-in — an extra, unexplained screen between a brand-new
// invitee and the workspace (2026-10-13). The name field used to be a single optional "Name".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { inviteMember } = vi.hoisted(() => ({ inviteMember: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {},
	adminApi: {
		members: vi.fn(async () => ({ members: [] })),
		currentTenant: vi.fn(async () => ({
			tenant: { id: 't-1', name: 'Nonagentic BV', slug: 'nonagentic', status: 'active' }
		})),
		tenantBudget: vi.fn(async () => ({ seats: null })),
		setMemberRole: vi.fn(),
		inviteMember,
		tenantInvites: vi.fn(async () => ({ invites: [] })),
		resendInvite: vi.fn(),
		revokeInvite: vi.fn(),
		deleteTenantUser: vi.fn()
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (_e: unknown, f: string) => f
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { user: { id: 'someone-else', roles: [] } } }));

import Page from './+page.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	inviteMember.mockReset();
	inviteMember.mockResolvedValue({
		invite: { id: 'i1', email: 'new@acme.test', role: 'member', emailDelivery: 'keycloak_actions', inviteUrl: 'x' }
	});
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function settle(ticks = 20): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

function type(sel: string, value: string) {
	const el = host.querySelector<HTMLInputElement>(sel);
	expect(el, `${sel} is not on the page`).not.toBeNull();
	el!.value = value;
	el!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

const inviteButton = () => host.querySelector<HTMLButtonElement>('form.add button[type="submit"]')!;

describe('members invite form', () => {
	it('requires first AND last name, and sends them as separate fields', async () => {
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.querySelector('label[for="add-first-name"]')?.textContent).toBe('admin_members_first_name_label');
		expect(host.querySelector('label[for="add-last-name"]')?.textContent).toBe('admin_members_last_name_label');

		type('#add-email', 'new@acme.test');
		type('#add-first-name', 'Jan');
		expect(inviteButton().disabled, 'invite enabled without a last name').toBe(true);
		type('#add-last-name', 'van der Berg');
		expect(inviteButton().disabled).toBe(false);

		host.querySelector<HTMLFormElement>('form.add')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(inviteMember).toHaveBeenCalledTimes(1);
		expect(inviteMember.mock.calls[0]![1]).toEqual({
			email: 'new@acme.test',
			role: 'member',
			firstName: 'Jan',
			lastName: 'van der Berg'
		});
	});
});
