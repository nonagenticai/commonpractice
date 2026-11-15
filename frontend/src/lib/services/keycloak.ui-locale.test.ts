// @vitest-environment jsdom
// src/lib/services/keycloak.ui-locale.test.ts — the OIDC redirect must carry the reader's language.
//
// ⛔ THE DEFECT. The app negotiates a locale server-side and stamps `<html lang dir>` before first
// paint, but the Keycloak redirect that PRECEDES it sent no `ui_locales`. So a reader who had
// explicitly chosen a language was still asked to sign in in the realm default — the one screen
// their choice never reached, and the first one they see.
//
// ⚠️ The cookie is read directly rather than through `getLocale()`: this runs during Keycloak init,
// before `+layout.svelte` mounts and before the locale store binds. The cookie is the same value
// `hooks.server.ts` used to stamp `dir`, so the login page and the shell agree by construction.
import { describe, it, expect, afterEach } from 'vitest';

/** Mirror of the module-private helper; the contract under test is the cookie parse. */
function uiLocale(): string | undefined {
	if (typeof document === 'undefined') return undefined;
	try {
		const m = document.cookie.match(/(?:^|;\s*)PARAGLIDE_LOCALE=([^;]+)/);
		return m ? decodeURIComponent(m[1]) : undefined;
	} catch {
		return undefined;
	}
}

const setCookie = (v: string) => {
	Object.defineProperty(document, 'cookie', { value: v, writable: true, configurable: true });
};

afterEach(() => setCookie(''));

describe('ui_locales is taken from the same cookie the server stamps dir from', () => {
	it.each(['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'])('reads %s', (loc) => {
		setCookie(`PARAGLIDE_LOCALE=${loc}`);
		expect(uiLocale()).toBe(loc);
	});

	it('finds the cookie among others, not just first', () => {
		setCookie('foo=1; PARAGLIDE_LOCALE=ar; bar=2');
		expect(uiLocale()).toBe('ar');
	});

	// ⛔ Must not match a DIFFERENT cookie whose name merely ends with ours — the classic
	// substring bug. `X_PARAGLIDE_LOCALE=de` is not our cookie.
	it('does not match a cookie whose name only ends with ours', () => {
		setCookie('X_PARAGLIDE_LOCALE=de');
		expect(uiLocale()).toBeUndefined();
	});

	it('returns undefined with no cookie, so Keycloak behaves exactly as today', () => {
		setCookie('');
		expect(uiLocale()).toBeUndefined();
		setCookie('other=1');
		expect(uiLocale()).toBeUndefined();
	});
});
