// Unit test for the re-auth redirect guard in keycloak.ts. authFetch calls
// ensureFreshToken on every request, so a dead refresh token would otherwise fire one
// keycloak.login() per in-flight request — racing authorize requests overwrite each
// other's auth session/PKCE state and Keycloak shows "login again through your
// application". The exported login() funnels through the same guard, so we assert it
// collapses concurrent callers into a single redirect and strips the volatile OIDC
// `#state=…` fragment from the redirectUri. resetModules() gives a fresh guard flag +
// keycloak instance per test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('re-auth redirect guard', () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('collapses concurrent re-auth redirects into a single keycloak.login()', async () => {
		const mod = await import('./keycloak');
		const spy = vi.spyOn(mod.keycloak, 'login').mockImplementation(() => Promise.resolve());
		mod.login();
		mod.login();
		mod.login();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('redirects to a fragment-free returnUrl (drops the OIDC #state=… callback)', async () => {
		vi.stubGlobal('window', {
			location: {
				origin: 'https://commonpractice-app.nonagentic.ai',
				pathname: '/block-edit',
				search: '?slug=tezt',
				hash: '#state=abc&code=xyz'
			}
		});
		const mod = await import('./keycloak');
		const spy = vi.spyOn(mod.keycloak, 'login').mockImplementation(() => Promise.resolve());
		mod.login();
		const opts = spy.mock.calls[0]?.[0] as { redirectUri?: string } | undefined;
		expect(opts?.redirectUri).toBe('https://commonpractice-app.nonagentic.ai/block-edit?slug=tezt');
		expect(opts?.redirectUri).not.toContain('#');
	});
});
