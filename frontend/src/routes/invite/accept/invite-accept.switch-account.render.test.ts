// @vitest-environment jsdom
//
// src/routes/invite/accept/invite-accept.switch-account.render.test.ts — "Switch account" on the
// invite accept page must come BACK to the accept URL, token included.
//
// ⛔ THE DEFECT. The button called `auth.logout()` with no argument, so Keycloak's post-logout
// redirect went to the app ORIGIN. The invitee signed in as the right person and landed on `/` —
// with no `?token=`, i.e. no invitation — and had to dig the email out again. The accept page is the
// only place that knows the token, so it must hand its full URL to the logout.
//
// Two halves, both pinned: the page passes `window.location.href`, and `auth.logout` threads it to
// `kcLogout` (the store used to drop any argument on the floor).
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

const ACCEPT_PATH = '/invite/accept?token=tok-123&login_hint=invitee%2Bcp%40example.com&x=1';
const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/') }));
vi.mock('$app/state', () => ({ page: pageState }));

const { acceptInvite, logout } = vi.hoisted(() => ({ acceptInvite: vi.fn(), logout: vi.fn() }));
vi.mock('$lib/api/admin', () => ({ adminApi: { acceptInvite } }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));
const { goto } = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { email: 'wrong@example.com' }, logout, refresh: vi.fn(async () => {}) }
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	window.history.replaceState(null, '', ACCEPT_PATH);
	pageState.url = new URL(window.location.href);
	acceptInvite.mockRejectedValue(
		Object.assign(new Error('mismatch'), {
			code: 'invite_email_mismatch',
			details: { invitedEmail: 'i••••••••@example.com' }
		})
	);
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

describe('invite accept — Switch account', () => {
	it('⛔ logs out with the FULL accept URL as the redirect, so the token survives the re-login', async () => {
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok-123' });
		expect(goto, 'a refusal must stay on the page, never auto-navigate into the app').not.toHaveBeenCalled();
		const btn = host.querySelector<HTMLButtonElement>('[data-testid="invite-switch-account"]');
		expect(btn, 'no Switch account button on a wrong-account refusal').not.toBeNull();
		btn!.click();
		expect(logout).toHaveBeenCalledTimes(1);
		const [redirect] = logout.mock.calls[0]!;
		expect(redirect).toBe(window.location.href);
		expect(new URL(redirect as string).searchParams.get('token')).toBe('tok-123');
		expect(new URL(redirect as string).pathname).toBe('/invite/accept');
		// …and the hint rides along, so the re-login form opens pre-filled with the INVITED address.
		expect(new URL(redirect as string).searchParams.get('login_hint')).toBe('invitee+cp@example.com');
	});

	it('shows the MASKED invited address and the "no password yet" way out', async () => {
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		const who = host.querySelector('[data-testid="invite-accept-invited-email"]');
		expect(who, 'the mismatch screen must say which address the invite is for').not.toBeNull();
		expect(who!.textContent).toContain('invite_accept_invited_for');
		expect(who!.textContent).toContain('i••••••••@example.com');
		expect(host.querySelector('[data-testid="invite-accept-no-password"]')?.textContent).toContain(
			'invite_accept_no_password_hint'
		);
	});

	it('control: an older backend with no masked address renders neither line (never a blank address)', async () => {
		acceptInvite.mockRejectedValue(Object.assign(new Error('mismatch'), { code: 'invite_email_mismatch' }));
		const { default: Page } = await import('./+page.svelte');
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		expect(host.querySelector('[data-testid="invite-switch-account"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="invite-accept-invited-email"]')).toBeNull();
		expect(host.querySelector('[data-testid="invite-accept-no-password"]')).toBeNull();
	});
});
