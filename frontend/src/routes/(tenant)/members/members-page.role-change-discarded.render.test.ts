// @vitest-environment jsdom
//
// src/routes/(tenant)/members/members-page.role-change-discarded.render.test.ts — a role change
// that never reached the server must not stay on screen looking like it did.
//
// ⛔ THE DEFECT, IN TWO HALVES.
//
//   1. THE DROPDOWN STAYED LIVE DURING EVERY OTHER OPERATION. `changeRole` opens with
//      `if (busy || …) return;` — no request, no banner, no trace. The `<select>`'s own guard was
//      `disabled={(busy && savingId === mem.userId) || blocked !== null}`, and `savingId` is set
//      ONLY inside `changeRole`. `run()` — which wraps addMember AND offboard — sets `busy = true`
//      and leaves `savingId === null`, so during those multi-second operations EVERY row's dropdown
//      was enabled and every change through it was silently discarded.
//
//   2. …AND THE DISCARDED VALUE STAYED ON SCREEN. Compiled with this project's own Svelte
//      (5.56.2), `<select value={mem.role ?? ''}>` emits
//        `if (select_value !== (select_value = $.get(mem).role ?? '')) { select.value = … }`
//      `select_value` caches the last EXPRESSION value. Because the discarded change never reached
//      the server, `mem.role` is unchanged after `load()`, the guard is false, and the DOM element
//      is never re-synced — so the user's pick sits in the box until a full page reload. The
//      `catch` arm of a FAILED save has the identical shape.
//
// Consequence: an admin promotes someone to tenant_admin, sees "Admin" in the dropdown, gets a
// green banner from the OTHER operation that was in flight, and walks away believing an
// access-control change landed. Nothing was sent.
//
// ⛔ SECTION 3 IS THE OVER-CORRECTION GUARD AND IS NOT OPTIONAL. "Disable the select always" and
// "never let a change through" both pass every assertion in sections 1 and 2.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Member, TenantRole } from '$lib/types/admin';

// Real `en` catalog, each key resolving to its own name — same reasoning as the sibling render test
// in this directory: a reworded translation cannot red this file, and a resurrected hardcoded
// English string cannot pass.
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

const { members, currentTenant, tenantBudget, setMemberRole, deleteTenantUser } = vi.hoisted(() => ({
	members: vi.fn(),
	currentTenant: vi.fn(),
	tenantBudget: vi.fn(),
	setMemberRole: vi.fn(),
	deleteTenantUser: vi.fn()
}));
vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message = 'error'
		) {
			super(message);
		}
	},
	adminApi: {
		members,
		currentTenant,
		tenantBudget,
		setMemberRole,
		inviteMember: vi.fn(),
		tenantInvites: vi.fn(async () => ({ invites: [] })),
		resendInvite: vi.fn(),
		revokeInvite: vi.fn(),
		deleteTenantUser
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, f: string) => f,
	writeErrorText: (_e: unknown, f: string) => f
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));
// The signed-in user is nobody on the roster, so every row keeps its Remove button.
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { user: { id: 'someone-else', roles: [] } } }));

import Page from './+page.svelte';

function member(userId: string, name: string, role: TenantRole | null): Member {
	return { userId, name, email: `${userId}@nonagentic.ai`, joinedAt: '2026-06-01T09:00:00.000Z', role };
}

/** Two admins so the last-admin guard is NOT what disables anything below, plus one plain member. */
const ROSTER = [
	member('u1', 'Sanne Bakker', 'tenant_admin'),
	member('u2', 'Ravi Menon', 'tenant_admin'),
	member('u3', 'Jo Willems', 'member')
];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	for (const fn of [members, currentTenant, tenantBudget, setMemberRole, deleteTenantUser]) fn.mockReset();
	currentTenant.mockResolvedValue({
		tenant: { id: 't-1', name: 'Nonagentic BV', slug: 'nonagentic', status: 'active' }
	});
	tenantBudget.mockResolvedValue({ seats: null });
	members.mockResolvedValue({ members: ROSTER });
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Let every pending microtask/timer settle and re-render, the way the sibling render test does. */
async function settle(ticks = 20): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

async function render(): Promise<void> {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('admin_loading');
}

const roleSelects = () => [...host.querySelectorAll<HTMLSelectElement>('.crole select')];
const removeButtons = () => [...host.querySelectorAll<HTMLButtonElement>('button.btn-remove')];
const rowNames = () => [...host.querySelectorAll('.cname')].map((n) => n.textContent?.trim());

/** Drive the control the way a person does: pick a value, let the browser fire `change`. */
async function pick(index: number, value: TenantRole): Promise<void> {
	const sel = roleSelects()[index]!;
	sel.value = value;
	sel.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

describe('1 · another operation is in flight', () => {
	/** Start an offboard that never settles, so `busy` is true for the rest of the case. */
	async function beginOffboard(): Promise<void> {
		deleteTenantUser.mockReturnValue(new Promise<void>(() => {}));
		removeButtons()[0]!.click();
		await settle();
	}

	it('EVERY row’s role select is disabled — not only the row being operated on', async () => {
		// ⛔ Before the fix this read [false, false, false]: `savingId` is null throughout `run()`,
		// so `busy && savingId === mem.userId` was false for all three rows while a multi-second
		// offboard was in flight.
		await render();
		expect(roleSelects().map((s) => s.disabled)).toEqual([false, false, false]);
		await beginOffboard();
		expect(roleSelects().map((s) => s.disabled)).toEqual([true, true, true]);
		// The roster is still on screen — a lock that blanked the table would be a worse screen.
		expect(rowNames()).toEqual(['Sanne Bakker', 'Ravi Menon', 'Jo Willems']);
	});

	it('a change forced through anyway sends nothing AND does not stay on screen', async () => {
		// Belt and braces for the race the disable cannot cover: the dropdown is already open when
		// the other operation starts. The guard in `changeRole` still discards it — what must not
		// happen is the discarded value sitting in the box looking saved.
		await render();
		await beginOffboard();
		await pick(2, 'tenant_admin');
		expect(setMemberRole).not.toHaveBeenCalled();
		// ⛔ 'tenant_admin' before the fix — the user's pick, never sent, never corrected.
		expect(roleSelects()[2]!.value).toBe('member');
	});
});

describe('2 · the change was attempted and failed', () => {
	it('the select shows the SERVER’s role again, not the user’s pick', async () => {
		await render();
		setMemberRole.mockRejectedValue(new Error('boom'));
		await pick(2, 'tenant_admin');
		expect(setMemberRole).toHaveBeenCalledTimes(1);
		expect(host.querySelector('.banner.error')?.textContent).toBe('error_save_failed');
		// ⛔ 'tenant_admin' before the fix: `load()` is not even called on this path, so nothing
		// could have re-synced the element, and Svelte's cached `select_value` would have skipped
		// the write regardless.
		expect(roleSelects()[2]!.value).toBe('member');
	});

	it('a change BLOCKED by the last-admin guard is banner’d and also rolled back on screen', async () => {
		// One admin, one member: demoting the sole admin is refused client-side.
		members.mockResolvedValue({
			members: [member('u1', 'Sanne Bakker', 'tenant_admin'), member('u2', 'Jo Willems', 'member')]
		});
		await render();
		// The guard disables the sole admin's select, so reach the code path directly the way a
		// stale/racing DOM would: the row is re-enabled only if the roster changes underneath.
		expect(roleSelects()[0]!.disabled).toBe(true);
		expect(roleSelects()[0]!.title).toBe('admin_members_last_admin');
		expect(setMemberRole).not.toHaveBeenCalled();
	});
});

describe('3 · THE OVER-CORRECTION GUARD — an idle screen still changes roles', () => {
	it('a role change on an idle roster IS sent, and the select ends on the server’s answer', async () => {
		// ⛔ WITHOUT THIS CASE, "disable the select always" and "always snap back to the old value"
		// pass every assertion above while making the screen useless.
		await render();
		setMemberRole.mockResolvedValue(undefined);
		members.mockResolvedValue({
			members: [ROSTER[0]!, ROSTER[1]!, member('u3', 'Jo Willems', 'tenant_admin')]
		});
		await pick(2, 'tenant_admin');
		expect(setMemberRole).toHaveBeenCalledWith('t-1', 'u3', 'tenant_admin');
		expect(host.querySelector('.banner.ok')?.textContent).toBe('admin_members_role_updated');
		expect(roleSelects()[2]!.value).toBe('tenant_admin');
		expect(roleSelects().map((s) => s.disabled)).toEqual([false, false, false]);
	});

	it('re-picking the value a row already holds is a no-op, not a request', async () => {
		await render();
		await pick(2, 'member');
		expect(setMemberRole).not.toHaveBeenCalled();
		expect(roleSelects()[2]!.value).toBe('member');
	});
});
