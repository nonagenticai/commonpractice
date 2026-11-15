// @vitest-environment jsdom
//
// src/routes/invite/accept/invite-accept.setup-pending.render.test.ts — a successful accept goes
// STRAIGHT into the app, with or without `setupPending`.
//
// Fewest screens (George 2026-10-19): the page shows only "Setting up your workspace…" while the
// accept runs (~5 s: seat + licence setup), then navigates to `/` with `replaceState` — no
// "Access granted" screen, no "Open Common Practice" button. `setupPending: true` (seated, licence
// still being set up) goes in too: the app itself shows the "access is being set up" state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/invite/accept?token=tok-9') }));
vi.mock('$app/state', () => ({ page: pageState }));

const { acceptInvite } = vi.hoisted(() => ({ acceptInvite: vi.fn() }));
vi.mock('$lib/api/admin', () => ({ adminApi: { acceptInvite } }));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));
const { goto } = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { email: 'ivy@example.com' }, logout: vi.fn(), refresh }
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
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

describe('invite accept — straight into the app', () => {
	async function mountPage() {
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
	}

	it('while the accept runs: only the "Setting up your workspace…" status, with a progress indicator', async () => {
		acceptInvite.mockReturnValue(new Promise(() => {})); // never settles
		await mountPage();
		await settle();
		const working = host.querySelector('[data-testid="invite-accept-working"]');
		expect(working?.getAttribute('role')).toBe('status');
		expect(working?.textContent).toContain('invite_accept_setting_up');
		expect(working?.querySelector('.ia-spinner')?.getAttribute('aria-hidden')).toBe('true');
		expect(goto).not.toHaveBeenCalled();
	});

	it('setupPending → refreshes /api/me, then goto("/", {replaceState}) — no in-between screen', async () => {
		acceptInvite.mockResolvedValue({ tenantId: 't', role: 'member', setupPending: true });
		await mountPage();
		await settle();
		expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok-9' });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith('/', { replaceState: true });
		expect(refresh.mock.invocationCallOrder[0]!).toBeLessThan(goto.mock.invocationCallOrder[0]!);
		for (const gone of ['invite_accept_done_heading', 'invite_accept_setup_pending_body', 'invite_accept_open_app']) {
			expect(host.textContent).not.toContain(gone);
		}
		expect(host.textContent).not.toContain('invite_accept_error_heading');
	});

	it('a finished setup goes in the same way', async () => {
		acceptInvite.mockResolvedValue({ tenantId: 't', role: 'member' });
		await mountPage();
		await settle();
		expect(goto).toHaveBeenCalledWith('/', { replaceState: true });
		expect(host.textContent).not.toContain('invite_accept_done_heading');
		expect(host.querySelector('a[href="/"]')).toBeNull();
	});

	it('a failed /api/me refresh still goes in (the app re-reads it)', async () => {
		acceptInvite.mockResolvedValue({ tenantId: 't', role: 'member' });
		refresh.mockRejectedValueOnce(new Error('me down'));
		await mountPage();
		await settle();
		expect(goto).toHaveBeenCalledWith('/', { replaceState: true });
	});

	it('(control) a refusal never navigates: the error view renders', async () => {
		acceptInvite.mockRejectedValue(Object.assign(new Error('x'), { code: 'invite_expired' }));
		await mountPage();
		await settle();
		expect(goto).not.toHaveBeenCalled();
		expect(host.textContent).toContain('invite_accept_error_heading');
		expect(host.querySelector('[data-testid="invite-accept-error"]')?.textContent).toBe('invite_accept_expired');
	});
});
