// @vitest-environment jsdom
//
// src/routes/(tenant)/members/members-page.seats-full-renew.render.test.ts — at the seat cap, the
// invite form must still renew an invite that is already PENDING for the typed address.
//
// Seats count members + pending invites (services/seat-limit.ts `claimSeatInTx`), so a tenant whose
// only free seat is held by an open invite reads "full". `createInvite` renews + resends an existing
// pending invite instead of creating one — it takes no new seat — so the backend allows that call;
// the form used to disable it on `seatsFull` alone. A NEW address at the cap stays disabled (the
// backend would 409 `seat_limit_reached`).
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
		tenantBudget: vi.fn(async () => ({ seats: { used: 2, max: 2, remaining: 0 } })),
		setMemberRole: vi.fn(),
		inviteMember,
		tenantInvites: vi.fn(async () => ({
			invites: [
				{ id: 'inv-1', email: 'Pending@Acme.test', role: 'tenant_admin', status: 'pending', expiresAt: '2026-10-20T00:00:00Z', createdAt: '2026-10-13T00:00:00Z', invitedBy: null }
			]
		})),
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

describe('members invite form at the seat cap', () => {
	it('⛔ a NEW address is refused, but the address with a pending invite (any case) can be re-invited', async () => {
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		type('#add-first-name', 'Jan');
		type('#add-last-name', 'Jansen');
		type('#add-email', 'someone-new@acme.test');
		expect(inviteButton().disabled, 'a new invite at the cap would 409').toBe(true);
		expect(inviteButton().title).toBe('admin_members_seats_full');
		type('#add-email', '  pending@acme.TEST ');
		expect(inviteButton().disabled, 'renewing the pending invite takes no new seat').toBe(false);

		host.querySelector<HTMLFormElement>('form.add')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(inviteMember).toHaveBeenCalledTimes(1);
	});
});
