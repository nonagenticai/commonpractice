// @vitest-environment jsdom
//
// src/lib/services/keycloak.login-hint.test.ts — the invitee's login form must open PRE-FILLED.
//
// ⛔ THE DEFECT (prod, 2026-10-13). Keycloak's set-password (action-token) flow creates NO session, so
// its redirect to `/invite/accept?token=…` hit `onLoad: 'login-required'` with an EMPTY username
// field. Chrome autofilled a DIFFERENT saved account, the user submitted, and the accept answered
// 403 `invite_email_mismatch` — twice. keycloak-js's onLoad auto-login forwards only prompt+locale,
// so the hint has to be driven through `keycloak.login({ loginHint })` ourselves, exactly like the
// existing idpHint path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inviteLoginHintFromUrl } from './keycloak';

describe('inviteLoginHintFromUrl', () => {
	it('reads an encoded address (a `+` arrives as %2B) on /invite/accept', () => {
		expect(inviteLoginHintFromUrl('/invite/accept', '?token=t&login_hint=a%2Bb%40x.test')).toBe('a+b@x.test');
		expect(inviteLoginHintFromUrl('/invite/accept/', '?login_hint=g%40x.test')).toBe('g@x.test');
	});

	it('is ignored on any other route — an arbitrary link cannot pre-fill the login form', () => {
		expect(inviteLoginHintFromUrl('/', '?login_hint=g%40x.test')).toBeNull();
		expect(inviteLoginHintFromUrl('/invite/accept-other', '?login_hint=g%40x.test')).toBeNull();
	});

	it('rejects anything not shaped like one address', () => {
		expect(inviteLoginHintFromUrl('/invite/accept', '?token=t')).toBeNull();
		expect(inviteLoginHintFromUrl('/invite/accept', '?login_hint=')).toBeNull();
		expect(inviteLoginHintFromUrl('/invite/accept', '?login_hint=no-at-sign')).toBeNull();
		expect(inviteLoginHintFromUrl('/invite/accept', '?login_hint=a%20b%40x.test')).toBeNull();
		expect(inviteLoginHintFromUrl('/invite/accept', `?login_hint=${'a'.repeat(250)}%40x.test`)).toBeNull();
	});
});

describe('initKeycloak on /invite/accept', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv('VITE_KEYCLOAK_URL', 'https://kc.test');
		vi.stubEnv('VITE_KEYCLOAK_REALM', 'portal');
		vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', 'cp');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		window.history.replaceState(null, '', '/');
	});

	async function boot(path: string) {
		window.history.replaceState(null, '', path);
		const mod = await import('./keycloak');
		const init = vi.spyOn(mod.keycloak, 'init').mockResolvedValue(false);
		const login = vi.spyOn(mod.keycloak, 'login').mockResolvedValue(undefined);
		const result = await mod.initKeycloak();
		return { init, login, result };
	}

	it('⛔ no session + login_hint → login({ loginHint }) back to the SAME url, token included (not onLoad)', async () => {
		const { init, login, result } = await boot('/invite/accept?token=tok-1&login_hint=new%2Btag%40x.test');
		expect(result).toBe(false);
		expect(init.mock.calls[0]![0]).not.toHaveProperty('onLoad');
		expect(login).toHaveBeenCalledTimes(1);
		const opts = login.mock.calls[0]![0] as { loginHint?: string; redirectUri?: string; idpHint?: string };
		expect(opts.loginHint).toBe('new+tag@x.test');
		expect(opts.idpHint).toBeUndefined();
		const back = new URL(opts.redirectUri!);
		expect(back.pathname).toBe('/invite/accept');
		expect(back.searchParams.get('token')).toBe('tok-1');
		// Not stripped: the mismatch screen's logout returns here, and that re-login needs it too.
		expect(window.location.search).toContain('login_hint=');
	});

	it('an SSO idpHint WINS over the login_hint', async () => {
		const { login } = await boot('/invite/accept?token=tok-1&login_hint=g%40x.test&idp=entra-acme');
		expect(login).toHaveBeenCalledTimes(1);
		const opts = login.mock.calls[0]![0] as { loginHint?: string; idpHint?: string };
		expect(opts.idpHint).toBe('entra-acme');
		expect(opts.loginHint).toBeUndefined();
	});

	it('control: no hint → the unchanged onLoad login-required path, no manual login()', async () => {
		const { init, login } = await boot('/invite/accept?token=tok-1');
		expect(init.mock.calls[0]![0]).toMatchObject({ onLoad: 'login-required' });
		expect(login).not.toHaveBeenCalled();
	});

	it('an authenticated return from Keycloak does not log in again', async () => {
		window.history.replaceState(null, '', '/invite/accept?token=tok-1&login_hint=g%40x.test');
		const mod = await import('./keycloak');
		vi.spyOn(mod.keycloak, 'init').mockResolvedValue(true);
		const login = vi.spyOn(mod.keycloak, 'login').mockResolvedValue(undefined);
		expect(await mod.initKeycloak()).toBe(true);
		expect(login).not.toHaveBeenCalled();
	});
});
