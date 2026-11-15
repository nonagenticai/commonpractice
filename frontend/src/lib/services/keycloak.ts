// src/lib/services/keycloak.ts — trimmed from fr/frontend. Single-flight init,
// ensureFreshToken on every request, dev bypass gated on DEV so it can't leak
// to production builds.
import Keycloak from 'keycloak-js';

const keycloakConfig = {
	url: import.meta.env.VITE_KEYCLOAK_URL,
	realm: import.meta.env.VITE_KEYCLOAK_REALM,
	clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID
};

/**
 * ⛔ A MISSING BUILD VAR USED TO END IN AN INFINITE REDIRECT, NOT AN ERROR — observed, not theorised.
 *
 * With `VITE_KEYCLOAK_URL` unset, `keycloak-js` builds its authorize URL from `undefined`, which
 * makes it RELATIVE. The browser resolves it against the app's own origin, the app boots again,
 * redirects again, and the path GROWS each time:
 *
 *   /undefined/protocol/openid-connect/auth?client_id=undefined&redirect_uri=…
 *   /undefined/protocol/openid-connect/undefined/protocol/openid-connect/auth?…
 *   …fifteen more, each one longer…
 *   → HTTP ERROR 431 (Request Header Fields Too Large), "This page isn't working"
 *
 * There is no console message, no network error a user could report, and no way out but clearing
 * the tab. A dropped key in the deployment's env — one line of a ConfigMap — takes the whole SPA
 * down in a way that looks like a browser fault rather than a configuration one.
 *
 * `import.meta.env` is inlined by Vite at BUILD time, so this cannot be caught by a server-side
 * check and cannot be fixed by restarting a pod: it is baked into the bundle. Failing loudly here is
 * the only place it can be caught at all.
 *
 * Reported, deliberately, in ENGLISH and outside the i18n catalog: at this point in boot the
 * paraglide runtime and the user's locale preference (which arrives with the user, who cannot load)
 * are not yet available, and an operator reading a deployment's env is the only audience that can
 * act on it.
 */
export function missingKeycloakConfig(): string[] {
	const required = {
		VITE_KEYCLOAK_URL: keycloakConfig.url,
		VITE_KEYCLOAK_REALM: keycloakConfig.realm,
		VITE_KEYCLOAK_CLIENT_ID: keycloakConfig.clientId
	};
	return Object.entries(required)
		.filter(([, v]) => typeof v !== 'string' || v.trim() === '' || v === 'undefined')
		.map(([k]) => k);
}

/** Thrown instead of redirecting into the loop above. `initKeycloak` rejects with it. */
export class KeycloakConfigError extends Error {
	constructor(readonly missing: string[]) {
		super(
			`Authentication is not configured for this deployment: ${missing.join(', ')} ` +
				`${missing.length === 1 ? 'is' : 'are'} missing from the frontend build. ` +
				`These are baked in at build time, so restarting will not fix it — rebuild the image ` +
				`with the values set.`
		);
		this.name = 'KeycloakConfigError';
	}
}

export const keycloak = new Keycloak(keycloakConfig);

function bypassEnabled(): boolean {
	return import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS === 'true';
}

// Keycloak IdP aliases are `entra-<slug>` where slug ∈ [a-z0-9-] (backend aliasForSlug).
const ALIAS_RE = /^[a-z0-9-]+$/;

/**
 * Resolve a `kc_idp_hint` from a login URL's query string so a tenant-branded entry link
 * lands a user straight on their tenant's Entra IdP, skipping Keycloak's provider picker
 * (spec Part 8.3, the CP-side complement to the home-IdP-discovery authenticator).
 *
 * `?idp=<alias>` wins (the literal alias the SSO screen shows); else `?tenant=<slug>`
 * derives `entra-<slug>` (mirrors the backend alias convention). Returns a
 * charset-validated alias or null — anything malformed is ignored (no hint), so a junk
 * param can never inject into the auth URL or route to a wrong IdP.
 *
 * NOTE: `?slug=` is deliberately NOT a tenant hint. It is owned by in-app routes (the
 * block editor uses `?slug=<block>`); treating it as a tenant alias would both strip the
 * route param (see stripHintParam) and mis-route login to a bogus `entra-<blockslug>` IdP.
 * Tenant entry links use `?idp=` (canonical, tenantSignInUrl) or `?tenant=`.
 */
export function idpHintFromQuery(search: string): string | null {
	const params = new URLSearchParams(search);
	const idp = params.get('idp')?.trim();
	if (idp) return ALIAS_RE.test(idp) ? idp : null;
	const slug = params.get('tenant')?.trim();
	if (slug && ALIAS_RE.test(slug)) return `entra-${slug}`;
	return null;
}

/** Build the shareable tenant sign-in link for a given IdP alias. */
export function tenantSignInUrl(origin: string, alias: string): string {
	return `${origin}/?idp=${encodeURIComponent(alias)}`;
}

/** The invitation accept route — the ONLY page whose `login_hint` param is honoured. */
const INVITE_ACCEPT_PATH = '/invite/accept';

/**
 * The invited address to pre-fill on Keycloak's login form, or null.
 *
 * ⛔ WITHOUT THIS, THE WRONG ACCOUNT ACCEPTS. Measured in prod 2026-10-13: Keycloak's set-password
 * (action-token) flow creates NO session, so its redirect to `/invite/accept?token=…` hit the
 * `login-required` init with an EMPTY username field, Chrome autofilled a different saved account,
 * and the accept answered 403 `invite_email_mismatch` — twice. The backend puts the invited address
 * on the accept link as `login_hint`; this forwards it as keycloak-js `loginHint`.
 *
 * Only on the accept route (a hint on any other URL is ignored, so an arbitrary link cannot pre-fill
 * the login form), and only something shaped like one address (no whitespace, one `@`, ≤ 254). The
 * value is NOT stripped from the URL and NOT stored: it stays in the accept link so the mismatch
 * screen's logout → return-to-this-URL re-login is pre-filled too.
 */
export function inviteLoginHintFromUrl(pathname: string, search: string): string | null {
	if (pathname.replace(/\/+$/, '') !== INVITE_ACCEPT_PATH) return null;
	const hint = new URLSearchParams(search).get('login_hint')?.trim();
	if (!hint || hint.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(hint)) return null;
	return hint;
}

/** Drop the idp/tenant hint params from the current URL once consumed (mirrors the state= strip).
 *  `slug` is intentionally excluded — it is an in-app route param (e.g. block-edit), not a hint. */
function stripHintParam(): void {
	if (typeof window === 'undefined') return;
	const url = new URL(window.location.href);
	let changed = false;
	for (const k of ['idp', 'tenant']) {
		if (url.searchParams.has(k)) {
			url.searchParams.delete(k);
			changed = true;
		}
	}
	if (changed) {
		window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
	}
}

/**
 * The locale to hand Keycloak as `ui_locales`, or `undefined` to let it decide.
 *
 * ⛔ WITHOUT THIS, THE LOGIN PAGE IS THE ONE SCREEN THE READER'S LANGUAGE NEVER REACHES. The app
 * itself negotiates a locale on the server and stamps `<html lang dir>` before first paint, but the
 * OIDC redirect that precedes it carried no `ui_locales`, so Keycloak fell back to its own
 * negotiation and served the realm default. A reader who has explicitly chosen a language in this
 * product was still asked to sign in in English.
 *
 * ⚠️ READS THE PARAGLIDE COOKIE DIRECTLY, on purpose. This runs during Keycloak init — before
 * `+layout.svelte` mounts and before the locale store is initialised — so `getLocale()` is not
 * reliably bound yet. The cookie is the same value the SERVER used to stamp `dir` in
 * `hooks.server.ts`, which is exactly the agreement we want: the login page and the shell the user
 * lands back on speak the same language. Never throws: a missing or unreadable cookie simply
 * yields `undefined` and Keycloak behaves as it does today.
 *
 * ⚠️ NOT EVERY APP LOCALE IS A REALM LOCALE. `ui_locales` is a HINT — Keycloak ignores a value that
 * is not in the realm's `supportedLocales` and falls back to its default, so sending `he` (which
 * Keycloak 26.1.5 ships no message bundle for) is harmless rather than broken. We therefore send
 * whatever the reader chose and let the realm decide, instead of maintaining a second allow-list
 * here that would silently drift from the realm's.
 */
function uiLocale(): string | undefined {
	if (typeof document === 'undefined') return undefined;
	try {
		const m = document.cookie.match(/(?:^|;\s*)PARAGLIDE_LOCALE=([^;]+)/);
		return m ? decodeURIComponent(m[1]) : undefined;
	} catch {
		return undefined;
	}
}

// Hint captured at init time so the explicit re-login button (login()) forwards it too.
let capturedIdpHint: string | null = null;
// The invitee's address on /invite/accept (see `inviteLoginHintFromUrl`). In memory only.
let capturedLoginHint: string | null = null;

let initPromise: Promise<boolean> | undefined;

export async function initKeycloak(): Promise<boolean> {
	if (initPromise) return initPromise;

	initPromise = (async () => {
		if (bypassEnabled()) {
			console.warn('[AUTH BYPASS] Keycloak disabled — using mock dev user');
			(keycloak as unknown as Record<string, unknown>).authenticated = true;
			(keycloak as unknown as Record<string, unknown>).token = 'dev-bypass-token';
			(keycloak as unknown as Record<string, unknown>).tokenParsed = {
				sub: '00000000-0000-0000-0000-000000000000',
				email: 'dev@localhost',
				name: 'Dev User',
				preferred_username: 'dev'
				// No tenant/role claims: the SPA reads tenant and roles from GET /api/me only, and
				// the backend's AUTH_BYPASS_ROLES env decides what that answers in dev.
			};
			return true;
		}

		// Before ANY redirect: a missing build var makes keycloak-js emit a relative authorize URL,
		// which loops against our own origin until the browser dies with a 431. See
		// `missingKeycloakConfig` above. Refuse here, loudly, instead.
		const missing = missingKeycloakConfig();
		if (missing.length > 0) {
			const err = new KeycloakConfigError(missing);
			console.error(err.message);
			throw err;
		}

		try {
			// A tenant-branded entry link (?idp=entra-<slug> | ?tenant=<slug>) routes login straight
			// to that tenant's Entra. keycloak-js's onLoad:'login-required' auto-login forwards only
			// prompt+locale (never idpHint, per keycloak-js #processInit), so when a hint is present
			// we init WITHOUT onLoad and drive login({ idpHint }) ourselves. No hint → unchanged.
			capturedIdpHint =
				typeof window !== 'undefined' ? idpHintFromQuery(window.location.search) : null;
			// Same reason for the invitee's `login_hint` (onLoad's auto-login drops `loginHint` too).
			// An SSO tenant's idpHint WINS: that login never shows Keycloak's username form at all.
			capturedLoginHint =
				!capturedIdpHint && typeof window !== 'undefined'
					? inviteLoginHintFromUrl(window.location.pathname, window.location.search)
					: null;
			const drivesOwnLogin = capturedIdpHint !== null || capturedLoginHint !== null;

			const kcLocale = uiLocale();
			const authenticated = await keycloak.init({
				...(drivesOwnLogin ? {} : { onLoad: 'login-required' as const }),
				// keycloak-js forwards `locale` (as ui_locales) through its onLoad auto-login — it is
				// one of the two options #processInit passes on, alongside `prompt`.
				...(kcLocale ? { locale: kcLocale } : {}),
				pkceMethod: 'S256',
				checkLoginIframe: false,
				silentCheckSsoFallback: false
			});
			if (typeof window !== 'undefined' && window.location.hash.includes('state=')) {
				window.history.replaceState(
					window.history.state,
					'',
					window.location.pathname + window.location.search
				);
			}
			// Drop the hint param once consumed (also cleans login()'s default redirectUri below).
			if (capturedIdpHint) stripHintParam();
			if (!authenticated && capturedIdpHint) {
				await keycloak.login({ idpHint: capturedIdpHint, ...(kcLocale ? { locale: kcLocale } : {}) });
				return false; // login() redirects away; never actually returns
			}
			if (!authenticated && capturedLoginHint) {
				// Back to THIS url (fragment-free): its `?token=` is the invitation.
				const returnUrl = cleanReturnUrl();
				await keycloak.login({
					loginHint: capturedLoginHint,
					...(returnUrl ? { redirectUri: returnUrl } : {}),
					...(kcLocale ? { locale: kcLocale } : {})
				});
				return false; // login() redirects away; never actually returns
			}
			return authenticated;
		} catch (error) {
			console.error('Failed to initialize Keycloak:', error);
			throw error;
		}
	})();

	return initPromise;
}

// Current location stripped to origin+path+query, dropping the volatile OIDC `#state=…`
// callback fragment. keycloak.login() defaults redirectUri to window.location.href, so
// after a callback that href still carries the stale fragment — feeding it back into a new
// authorize request is what makes the re-auth land malformed. App query (e.g. ?slug=) is
// kept so the user returns to the same view; the callback `code` arrives in the fragment
// and makes init authenticated, so the kept query never re-triggers idp routing.
function cleanReturnUrl(): string | undefined {
	if (typeof window === 'undefined') return undefined;
	const { origin, pathname, search } = window.location;
	return origin + pathname + search;
}

// Single funnel for every re-auth redirect. authFetch calls ensureFreshToken on EVERY
// request, so a dead refresh token rejects updateToken for all in-flight calls at once —
// ungated, each would fire its own keycloak.login(), and the racing authorize requests
// overwrite each other's auth session + PKCE state, leaving the submitted login page
// mismatched → Keycloak's "login again through your application" dead-end. This flag
// collapses them into exactly one redirect.
let redirecting = false;

function redirectToLogin(): Promise<void> | undefined {
	if (redirecting) return undefined;
	redirecting = true;
	const options: { idpHint?: string; loginHint?: string; redirectUri?: string; locale?: string } = {};
	if (capturedIdpHint) options.idpHint = capturedIdpHint;
	else if (capturedLoginHint) options.loginHint = capturedLoginHint;
	// The re-login path (session expiry, explicit login()) must carry the language too, or a reader
	// who was bounced mid-session gets an English login page they did not get on first entry.
	const reLocale = uiLocale();
	if (reLocale) options.locale = reLocale;
	const returnUrl = cleanReturnUrl();
	if (returnUrl) options.redirectUri = returnUrl;
	return keycloak.login(options);
}

export async function ensureFreshToken(minValidity = 30): Promise<string | undefined> {
	if (bypassEnabled()) return keycloak.token;
	if (initPromise) await initPromise;
	else await initKeycloak();
	if (!keycloak.authenticated) return undefined;
	try {
		await keycloak.updateToken(minValidity);
	} catch {
		// updateToken rejects on a genuinely dead session AND on a transient blip at the
		// token endpoint. Retry once: a transient failure rides out, a dead refresh token
		// fails fast again and we redirect (guarded → single redirect) rather than bounce
		// the user out on a network hiccup.
		try {
			await keycloak.updateToken(minValidity);
		} catch {
			redirectToLogin();
			return undefined;
		}
	}
	return keycloak.token;
}

export function login() {
	return redirectToLogin();
}

export function logout(redirectUri?: string) {
	const target =
		redirectUri ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
	return keycloak.logout(target ? { redirectUri: target } : undefined);
}
