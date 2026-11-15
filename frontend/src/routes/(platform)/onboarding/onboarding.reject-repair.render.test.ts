// @vitest-environment jsdom
//
// src/routes/(platform)/onboarding/onboarding.reject-repair.render.test.ts — rejected signups whose
// cleanup has not finished (backend 0122 `reject_repair`, `?status=needs_repair`).
//
// A reject whose cleanup failed used to be unreachable from this screen: it lists only PENDING rows,
// so the "reject again repairs it" path existed nowhere a super_admin could click. The screen now
// lists those rows — `pending` (retried automatically, last error shown) and `blocked` (the workspace
// is in use, the blockers named) — each with a Retry that calls reject again.
//
// Messages are mocked key-returns-its-own-name from the real en.json.
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

const BASE = {
	keycloak_sub: null,
	name: null,
	status: 'rejected',
	matched_tenant_id: null,
	assigned_tenant_id: null,
	requested_role: 'member',
	note: null,
	company: null,
	source: 'web',
	created_at: '2026-10-19T08:00:00.000Z',
	decided_at: '2026-10-19T09:00:00.000Z',
	decided_by: null
};
const PENDING_REPAIR = {
	...BASE,
	id: 'r-1',
	email: 'ann@globex.test',
	reject_repair: {
		state: 'pending',
		tenantId: 't-1',
		attempts: 2,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastError: 'revoke tenant license: licences down'
	}
};
const BLOCKED_REPAIR = {
	...BASE,
	id: 'r-2',
	email: 'bob@initech.test',
	reject_repair: {
		state: 'blocked',
		tenantId: 't-2',
		attempts: 1,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastError: null,
		blockers: ['other_members:1', 'data:flows']
	},
	// the offboard never ran: the requester keeps the workspace, seat, licence and login
	reject_repair_leaves_live_access: true
};

const FAILED_REPAIR = {
	...BASE,
	id: 'r-3',
	email: 'cy@hooli.test',
	reject_repair: {
		state: 'failed',
		tenantId: null,
		attempts: 10,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastError: 'central archive not attempted: owner_unknown; identity: failed: 500',
		lastErrorCodes: ['owner_unknown', 'identity_failed', 'some_future_code']
	},
	reject_repair_leaves_live_access: true
};
/** Failed on the registry archive alone: nothing of the requester's is live. */
const REGISTRY_ONLY_REPAIR = {
	...BASE,
	id: 'r-4',
	email: 'dee@umbrella.test',
	reject_repair: {
		state: 'failed',
		tenantId: 't-4',
		attempts: 10,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastError: 'central archive not attempted: owner_unknown',
		lastErrorCodes: ['owner_unknown']
	},
	reject_repair_leaves_live_access: false
};

/** The state the reject (Retry) answers with: `done`, or still `pending` (in progress elsewhere). */
let retryAnswer: 'done' | 'pending' = 'done';
const listCalls: Array<string | undefined> = [];
const rejectCalls: string[] = [];
const resolveCalls: Array<{ id: string; note: string; ack?: boolean }> = [];
let repairList: Array<Record<string, unknown>> = [];
let failRepairList = false;

vi.mock('$lib/api/admin', () => ({
	ApiError: class ApiError extends Error {
		status = 500;
	},
	adminApi: {
		signupApprovals: async (status?: string) => {
			listCalls.push(status);
			if (status === 'needs_repair') {
				if (failRepairList) throw new Error('older backend');
				return { approvals: repairList };
			}
			return { approvals: [] };
		},
		allTenants: async () => ({ tenants: [{ id: 't-2', name: 'Initech Workspace' }] }),
		emailDomains: async () => ({ domains: [] }),
		signupStats: async () => ({ stats: { pending: 0, approved: 0, rejected: 2, total: 2 } }),
		resolveSignupRepair: async (id: string, note: string, ack?: boolean) => {
			resolveCalls.push(ack ? { id, note, ack } : { id, note });
			repairList = repairList.filter((a) => a.id !== id);
			return { approval: { ...FAILED_REPAIR, reject_repair: { ...FAILED_REPAIR.reject_repair, state: 'resolved_manually' } } };
		},
		rejectSignup: async (id: string) => {
			rejectCalls.push(id);
			if (retryAnswer === 'done') repairList = repairList.filter((a) => a.id !== id);
			return { approval: { ...PENDING_REPAIR, reject_repair: { ...PENDING_REPAIR.reject_repair, state: retryAnswer } } };
		}
	}
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listCalls.length = 0;
	rejectCalls.length = 0;
	resolveCalls.length = 0;
	failRepairList = false;
	retryAnswer = 'done';
	repairList = [{ ...PENDING_REPAIR }, { ...BLOCKED_REPAIR }, { ...FAILED_REPAIR }, { ...REGISTRY_ONLY_REPAIR }];
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
}
async function mountPage(): Promise<void> {
	const { default: Onboarding } = await import('./+page.svelte');
	app = mount(Onboarding, { target: host });
	await settle();
}
const row = (id: string) => host.querySelector<HTMLElement>(`[data-testid="signup-repair-${id}"]`);

describe('Onboarding — rejected signups whose cleanup is not finished', () => {
	it('lists pending (with the last error) and blocked (with the blockers) rows, from ?status=needs_repair', async () => {
		await mountPage();
		expect(listCalls).toContain('needs_repair');
		expect(host.querySelector('[data-testid="signup-repairs-title"]')).not.toBeNull();
		const p = row('r-1')!;
		expect(p.textContent).toContain('ann@globex.test');
		expect(p.querySelector('[data-testid="signup-repair-state"]')!.textContent).toBe(
			'admin_onboarding_repair_pending:revoke tenant license: licences down'
		);
		const b = row('r-2')!;
		const state = b.querySelector('[data-testid="signup-repair-state"]')!;
		expect(state.textContent).toBe('admin_onboarding_repair_blocked:other_members:1, data:flows');
		expect(state.classList.contains('warn')).toBe(true);
	});

	it('Retry calls reject for THAT row, reloads, and the finished row leaves the list', async () => {
		await mountPage();
		row('r-1')!.querySelector<HTMLButtonElement>('[data-testid="signup-repair-retry"]')!.click();
		await settle();
		expect(rejectCalls).toEqual(['r-1']);
		expect(row('r-1')).toBeNull();
		expect(row('r-2')).not.toBeNull();
		expect(host.querySelector('.banner.ok')?.textContent).toBe('admin_onboarding_repair_done');
	});

	it('a FAILED row (the automatic retries gave up) is listed with its attempts + last error and a Retry', async () => {
		await mountPage();
		const f = row('r-3')!;
		const state = f.querySelector('[data-testid="signup-repair-state"]')!;
		expect(state.textContent).toBe(
			'admin_onboarding_repair_failed:10,central archive not attempted: owner_unknown; identity: failed: 500'
		);
		expect(state.classList.contains('warn')).toBe(true);
		f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-retry"]')!.click();
		await settle();
		expect(rejectCalls).toEqual(['r-3']);
	});

	it('a Retry the backend answers while the cleanup is still under way says so — never "Cleanup finished."', async () => {
		retryAnswer = 'pending';
		await mountPage();
		row('r-1')!.querySelector<HTMLButtonElement>('[data-testid="signup-repair-retry"]')!.click();
		await settle();
		expect(rejectCalls).toEqual(['r-1']);
		expect(row('r-1')).not.toBeNull();
		expect(host.querySelector('.banner.warn')?.textContent).toBe('admin_onboarding_repair_in_progress');
		expect(host.textContent).not.toContain('admin_onboarding_repair_done');
	});

	it('no section when nothing needs repair, when the backend ignores the filter, or when the read fails', async () => {
		repairList = [];
		await mountPage();
		expect(host.querySelector('[data-testid="signup-repairs-title"]')).toBeNull();
		unmount(app!);
		app = undefined;

		// An older backend ignores `needs_repair` and answers rows of every status: none of them shows.
		repairList = [{ ...BASE, id: 'x-1', email: 'x@y.test', status: 'approved' }, { ...BASE, id: 'x-2', email: 'z@y.test', reject_repair: null }];
		await mountPage();
		expect(host.querySelector('[data-testid="signup-repairs-title"]')).toBeNull();
		unmount(app!);
		app = undefined;

		failRepairList = true;
		await mountPage();
		expect(host.querySelector('[data-testid="signup-repairs-title"]')).toBeNull();
		expect(host.textContent).not.toContain('admin_load_failed');
	});

	it('a FAILED row shows each error code with its guidance (unknown code → the generic line); a pending one without codes shows none', async () => {
		await mountPage();
		const f = row('r-3')!;
		expect(f.querySelector('[data-testid="signup-repair-code-owner_unknown"]')!.textContent).toBe(
			'owner_unknown admin_onboarding_repair_code_owner_unknown'
		);
		expect(f.querySelector('[data-testid="signup-repair-code-identity_failed"]')!.textContent).toBe(
			'identity_failed admin_onboarding_repair_code_identity_failed'
		);
		expect(f.querySelector('[data-testid="signup-repair-code-some_future_code"]')!.textContent).toBe(
			'some_future_code admin_onboarding_repair_code_unknown'
		);
		expect(row('r-1')!.querySelector('[data-testid="signup-repair-codes"]')).toBeNull();
	});

	it('Resolve manually: only on failed / blocked rows; needs a note; sends it for THAT row and the row leaves the list', async () => {
		await mountPage();
		expect(row('r-1')!.querySelector('[data-testid="signup-repair-resolve"]')).toBeNull(); // pending: the tick owns it
		expect(row('r-2')!.querySelector('[data-testid="signup-repair-resolve"]')).not.toBeNull(); // blocked
		const f = row('r-4')!; // registry-only failure: no live access, no confirmation needed
		f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve"]')!.click();
		await settle();
		const confirm = f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve-confirm"]')!;
		expect(confirm.disabled).toBe(true);
		const note = f.querySelector<HTMLTextAreaElement>('[data-testid="signup-repair-resolve-note"]')!;
		note.value = '   ';
		note.dispatchEvent(new Event('input'));
		await settle();
		expect(confirm.disabled).toBe(true);
		note.value = '  Registry has no owner; archived by hand. ';
		note.dispatchEvent(new Event('input'));
		await settle();
		expect(confirm.disabled).toBe(false);
		confirm.click();
		await settle();
		expect(f.querySelector('[data-testid="signup-repair-resolve-live-warning"]')).toBeNull();
		expect(resolveCalls).toEqual([{ id: 'r-4', note: 'Registry has no owner; archived by hand.' }]);
		expect(rejectCalls).toEqual([]);
		expect(row('r-4')).toBeNull();
		expect(row('r-1')).not.toBeNull();
		expect(host.querySelector('.banner.ok')?.textContent).toBe('admin_onboarding_repair_resolved');
	});

	it('⛔ a resolve that leaves access LIVE names who keeps what, and stays disabled until explicitly confirmed', async () => {
		await mountPage();
		const b = row('r-2')!;
		b.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve"]')!.click();
		await settle();
		expect(b.querySelector('[data-testid="signup-repair-resolve-live-warning"]')!.textContent).toBe(
			'admin_onboarding_repair_resolve_live_warning:bob@initech.test,Initech Workspace'
		);
		const confirm = b.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve-confirm"]')!;
		const note = b.querySelector<HTMLTextAreaElement>('[data-testid="signup-repair-resolve-note"]')!;
		note.value = 'Customer keeps it.';
		note.dispatchEvent(new Event('input'));
		await settle();
		// a note alone is not enough
		expect(confirm.disabled).toBe(true);
		confirm.click();
		await settle();
		expect(resolveCalls).toEqual([]);
		const ack = b.querySelector<HTMLInputElement>('[data-testid="signup-repair-resolve-live-ack"]')!;
		ack.checked = true;
		ack.dispatchEvent(new Event('change'));
		await settle();
		expect(confirm.disabled).toBe(false);
		confirm.click();
		await settle();
		expect(resolveCalls).toEqual([{ id: 'r-2', note: 'Customer keeps it.', ack: true }]);
		expect(row('r-2')).toBeNull();
	});

	it('a FAILED row on identity_failed warns too; reopening the form starts unconfirmed', async () => {
		await mountPage();
		const f = row('r-3')!;
		f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve"]')!.click();
		await settle();
		expect(f.querySelector('[data-testid="signup-repair-resolve-live-warning"]')!.textContent).toBe(
			'admin_onboarding_repair_resolve_live_warning:cy@hooli.test,—'
		);
		const ack = f.querySelector<HTMLInputElement>('[data-testid="signup-repair-resolve-live-ack"]')!;
		ack.checked = true;
		ack.dispatchEvent(new Event('change'));
		await settle();
		f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve-cancel"]')!.click();
		await settle();
		f.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve"]')!.click();
		await settle();
		expect(f.querySelector<HTMLInputElement>('[data-testid="signup-repair-resolve-live-ack"]')!.checked).toBe(false);
	});

	it('Cancel closes the note form without calling the backend', async () => {
		await mountPage();
		const b = row('r-2')!;
		b.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve"]')!.click();
		await settle();
		b.querySelector<HTMLButtonElement>('[data-testid="signup-repair-resolve-cancel"]')!.click();
		await settle();
		expect(b.querySelector('[data-testid="signup-repair-resolve-form"]')).toBeNull();
		expect(resolveCalls).toEqual([]);
	});
});
