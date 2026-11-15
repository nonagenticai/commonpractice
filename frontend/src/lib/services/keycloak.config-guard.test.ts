// Unit test for the missing-build-var guard in keycloak.ts.
//
// ⛔ WHAT THIS PINS — observed in a real browser, not theorised. With `VITE_KEYCLOAK_URL` unset,
// keycloak-js builds its authorize URL out of `undefined`, which makes it RELATIVE. The browser
// resolves it against the app's own origin, the app boots again, redirects again, and the path
// grows on every hop:
//
//   /undefined/protocol/openid-connect/auth?client_id=undefined&redirect_uri=…
//   /undefined/protocol/openid-connect/undefined/protocol/openid-connect/auth?…
//   …sixteen navigations…
//   → HTTP ERROR 431 (Request Header Fields Too Large), blank "This page isn't working"
//
// No console message, no reportable network error, no way out but closing the tab. `import.meta.env`
// is inlined by Vite at BUILD time, so a dropped line in a ConfigMap cannot be fixed by restarting a
// pod — the wrong value is baked into the bundle.
//
// ⛔ THE LOAD-BEARING ASSERTION IS NOT "IT THROWS" — it is "IT DID NOT REDIRECT". A guard that threw
// *after* calling `keycloak.init()` would still ship the loop (init() is what navigates), and would
// pass every "rejects" assertion. So keycloak-js is mocked to a constructor whose `init` and `login`
// are spies, and every rejection case asserts BOTH spies stayed at zero calls. That pair of
// assertions is the only thing that can tell a real guard from a cosmetic one.
//
// `vi.resetModules()` + a re-import per case is NOT boilerplate here, for two independent reasons
// read off keycloak.ts: (1) `keycloakConfig` snapshots `import.meta.env` at MODULE LOAD (line 6-10),
// so a later `vi.stubEnv` is invisible to an already-loaded instance; (2) `initPromise` memoises
// single-flight init, so a second `initKeycloak()` in the same instance returns the FIRST promise and
// the case would assert nothing. Under vitest, `import.meta.env` is a live Proxy over `process.env`
// (vite-node `createImportMetaEnvProxy`), which is what makes `vi.stubEnv` reach the module at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spies live outside the factory so they survive resetModules and can be inspected after the
// re-imported module has constructed its own `new Keycloak(...)`.
const { initSpy, loginSpy } = vi.hoisted(() => ({
	initSpy: vi.fn(),
	loginSpy: vi.fn()
}));

vi.mock('keycloak-js', () => ({
	default: class KeycloakMock {
		authenticated = false;
		token: string | undefined = undefined;
		tokenParsed: Record<string, unknown> | undefined = undefined;
		init = initSpy;
		login = loginSpy;
		updateToken = vi.fn(async () => true);
		logout = vi.fn(async () => undefined);
		constructor(readonly config: unknown) {}
	}
}));

const REQUIRED = ['VITE_KEYCLOAK_URL', 'VITE_KEYCLOAK_REALM', 'VITE_KEYCLOAK_CLIENT_ID'] as const;
type RequiredVar = (typeof REQUIRED)[number];

// A deployment that IS configured — the baseline every rejection case removes exactly one key from.
const CONFIGURED: Record<RequiredVar, string> = {
	VITE_KEYCLOAK_URL: 'https://auth.nonagentic.ai',
	VITE_KEYCLOAK_REALM: 'portal-realm',
	VITE_KEYCLOAK_CLIENT_ID: 'commonpractice-frontend'
};

/** The three shapes a dropped Vite var actually arrives in. `undefined` = the key never reached the
 *  build; `''` = the ConfigMap key exists but is empty; `'undefined'` = the value was interpolated
 *  from a JS `undefined` by a wrapper script and inlined as the literal five-letter string. All three
 *  produce the same relative-URL loop, so the guard has to treat all three as missing. */
const MISSING_FORMS: Array<[label: string, value: string | undefined]> = [
	['absent from the build', undefined],
	['present but empty', ''],
	['the literal string "undefined"', 'undefined'],
	['whitespace only', '   ']
];

function stubEnvironment(overrides: Partial<Record<RequiredVar, string | undefined>> = {}): void {
	// Bypass off by default: these cases are a production build, and the bypass short-circuit sits
	// ABOVE the guard, so leaving it ambient would make every rejection case pass vacuously.
	vi.stubEnv('VITE_AUTH_BYPASS', undefined);
	for (const key of REQUIRED) vi.stubEnv(key, CONFIGURED[key]);
	for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value as string | undefined);
}

/** Awaits a rejection and hands back the error. A resolve is a test failure with a message that says
 *  what actually went wrong, rather than an opaque `undefined is not an instance of`. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('initKeycloak() RESOLVED — the config guard did not fire at all');
		},
		(error: unknown) => error
	);
}

describe('keycloak config guard — a missing build var must refuse, not redirect', () => {
	beforeEach(() => {
		vi.resetModules();
		initSpy.mockReset();
		initSpy.mockResolvedValue(true);
		loginSpy.mockReset();
		loginSpy.mockResolvedValue(undefined);
		// The guard console.error()s the operator message; silence it so a passing run is quiet, but
		// keep the spy so one case can assert the operator actually gets it somewhere visible.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	// ── 1. Per-variable coverage. Removing ANY ONE of the three has to be caught; a guard that only
	//    fired when all three were gone would still ship the loop for the single-dropped-key case,
	//    which is the case that actually happened.
	for (const missingVar of REQUIRED) {
		for (const [formLabel, formValue] of MISSING_FORMS) {
			it(`⛔ DOES NOT REDIRECT when ${missingVar} is ${formLabel} — init/login never called`, async () => {
				stubEnvironment({ [missingVar]: formValue });
				const mod = await import('./keycloak');

				const error = await rejectionOf(mod.initKeycloak());

				// The redirect assertion. keycloak.init() is what navigates to the authorize URL, so
				// "zero calls" IS "no redirect happened". A guard placed one line lower — after init —
				// would still reject, still be an instance of KeycloakConfigError, and still loop the
				// browser to a 431. Only these two expectations separate the two implementations.
				expect(initSpy).not.toHaveBeenCalled();
				expect(loginSpy).not.toHaveBeenCalled();

				// KeycloakConfigError is re-created on every resetModules, so it must be read off the
				// freshly imported module — a top-level import would give a stale class and instanceof
				// would be false for the right reason and the wrong test.
				expect(error).toBeInstanceOf(mod.KeycloakConfigError);
				expect((error as InstanceType<typeof mod.KeycloakConfigError>).missing).toEqual([
					missingVar
				]);
			});
		}
	}

	// ── 2. The message has to name the variable. An operator reading a deployment's env is the only
	//    person who can act on this; a generic "authentication failed" sends them to look at the user,
	//    the token and the IdP, none of which are broken.
	it('names the ONE missing variable in the message, and does not name the healthy ones', async () => {
		stubEnvironment({ VITE_KEYCLOAK_URL: undefined });
		const mod = await import('./keycloak');

		const error = (await rejectionOf(mod.initKeycloak())) as Error;

		expect(error.message).toContain('VITE_KEYCLOAK_URL');
		expect(error.message).not.toContain('VITE_KEYCLOAK_REALM');
		expect(error.message).not.toContain('VITE_KEYCLOAK_CLIENT_ID');
		// Singular/plural, and the actionable half: restarting the pod is the wrong instinct because
		// the value is inlined at build time.
		expect(error.message).toContain('is missing');
		expect(error.message).toContain('rebuild');
		expect(error.name).toBe('KeycloakConfigError');
	});

	it('names ALL missing variables when the whole auth block was dropped', async () => {
		stubEnvironment({
			VITE_KEYCLOAK_URL: undefined,
			VITE_KEYCLOAK_REALM: '',
			VITE_KEYCLOAK_CLIENT_ID: 'undefined'
		});
		const mod = await import('./keycloak');

		const error = (await rejectionOf(mod.initKeycloak())) as Error & { missing: string[] };

		expect(error.missing).toEqual([...REQUIRED]);
		for (const key of REQUIRED) expect(error.message).toContain(key);
		expect(error.message).toContain('are missing');
		expect(initSpy).not.toHaveBeenCalled();
		expect(loginSpy).not.toHaveBeenCalled();
	});

	it('puts the operator message on the console too (the browser tab shows nothing)', async () => {
		// The 431 dead-end had no console output at all. Whatever else happens, the reason has to be
		// readable in devtools, because that is where whoever is debugging the blank page is looking.
		stubEnvironment({ VITE_KEYCLOAK_REALM: undefined });
		const mod = await import('./keycloak');

		await rejectionOf(mod.initKeycloak());

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('VITE_KEYCLOAK_REALM'));
	});

	// ── 3. The exported predicate, direct. Cheap, and it pins the trim()/'undefined' rules that the
	//    cases above only exercise through initKeycloak.
	it('missingKeycloakConfig() reports nothing when all three are real values', async () => {
		stubEnvironment();
		const mod = await import('./keycloak');
		expect(mod.missingKeycloakConfig()).toEqual([]);
	});

	// ── 4. ⛔ NON-VACUITY. Without this, a guard that rejected unconditionally — say, a typo that
	//    inverted the length check — would pass every assertion above while taking the whole app down
	//    on a CORRECTLY configured deployment. This is the case that proves the guard discriminates.
	it('⛔ NON-VACUITY: with all three present, initKeycloak reaches keycloak.init()', async () => {
		stubEnvironment();
		const mod = await import('./keycloak');

		await expect(mod.initKeycloak()).resolves.toBe(true);

		expect(initSpy).toHaveBeenCalledTimes(1);
		// The real init options, so a future change that drops PKCE fails here rather than in prod.
		expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ pkceMethod: 'S256' }));
		// authenticated:true and no idp hint → no explicit login() redirect.
		expect(loginSpy).not.toHaveBeenCalled();
	});

	// ── 5. The bypass has to keep winning. Local dev runs with no Keycloak vars at all; if the guard
	//    sat above bypassEnabled(), `VITE_AUTH_BYPASS=true` would stop booting on every dev machine.
	it('DEV + VITE_AUTH_BYPASS=true short-circuits ABOVE the guard: resolves true, never throws', async () => {
		vi.stubEnv('DEV', true);
		vi.stubEnv('VITE_AUTH_BYPASS', 'true');
		for (const key of REQUIRED) vi.stubEnv(key, undefined);
		const mod = await import('./keycloak');

		await expect(mod.initKeycloak()).resolves.toBe(true);

		expect(initSpy).not.toHaveBeenCalled();
		expect(loginSpy).not.toHaveBeenCalled();
		// The bypass really ran (rather than the guard silently swallowing) — the mock user is set.
		expect(mod.keycloak.authenticated).toBe(true);
		expect(mod.keycloak.token).toBe('dev-bypass-token');
	});

	it('the bypass cannot rescue a PRODUCTION build: DEV=false still refuses', async () => {
		// VITE_AUTH_BYPASS is a build var too, so a stray `true` can reach a production image. DEV is
		// what keeps it inert there; if that gate ever weakened, a misconfigured prod build would boot
		// every visitor as a fabricated super_admin instead of failing loudly.
		vi.stubEnv('DEV', false);
		vi.stubEnv('VITE_AUTH_BYPASS', 'true');
		for (const key of REQUIRED) vi.stubEnv(key, undefined);
		const mod = await import('./keycloak');

		const error = await rejectionOf(mod.initKeycloak());

		expect(error).toBeInstanceOf(mod.KeycloakConfigError);
		expect(initSpy).not.toHaveBeenCalled();
		expect(loginSpy).not.toHaveBeenCalled();
	});
});
