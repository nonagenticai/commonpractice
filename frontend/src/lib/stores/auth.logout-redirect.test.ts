// src/lib/stores/auth.logout-redirect.test.ts — `auth.logout(redirectUri)` must reach Keycloak.
//
// The invite accept page's "Switch account" passes its full URL so the `?token=` survives the
// re-login (routes/invite/accept/invite-accept.switch-account.render.test.ts pins the page half).
// This pins the store half: `logout()` took no parameter and called `kcLogout()` bare, so any URL a
// caller handed it was silently dropped and Keycloak returned everyone to the app origin.
import { describe, it, expect, vi } from 'vitest';

const { kcLogout } = vi.hoisted(() => ({ kcLogout: vi.fn() }));
// Every name auth.svelte.ts imports from the service must exist here (an omitted ESM named import
// fails the whole module load) — same factory shape as workspace-suspended.render.test.ts.
vi.mock('$lib/services/keycloak', () => ({
	keycloak: null,
	initKeycloak: vi.fn(async () => false),
	KeycloakConfigError: class KeycloakConfigError extends Error {},
	login: vi.fn(),
	logout: kcLogout,
	ensureFreshToken: vi.fn(async () => undefined)
}));
vi.mock('$lib/api/auth-fetch', () => ({
	authFetch: vi.fn(async () => new Response('{}', { status: 500 }))
}));
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import { auth } from './auth.svelte';

describe('auth.logout', () => {
	it('⛔ forwards the redirect URI to Keycloak (the invite token rides on it)', () => {
		const url = 'https://cp.example/invite/accept?token=tok-123';
		auth.logout(url);
		expect(kcLogout).toHaveBeenCalledWith(url);
	});

	it('without one, Keycloak picks its default (the app origin)', () => {
		kcLogout.mockClear();
		auth.logout();
		expect(kcLogout).toHaveBeenCalledWith(undefined);
	});
});
