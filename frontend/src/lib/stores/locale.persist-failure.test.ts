// @vitest-environment jsdom
//
// ⚠️ jsdom IS REQUIRED HERE, AND IT IS NOT THE SYMPTOM FIX THE SIBLING FILE FORBIDS. That warning is
// about pinning jsdom onto a spec so a REAL `localStorage` makes the red go away. Nothing here
// depends on the environment's storage — `setLocale` is mocked in every case, so the hostile
// behaviour is supplied by the mock and would be identical under `node`. The one thing `node`
// cannot supply is `document`, and `applyDocument()` returns early without it, which would make the
// `<html lang/dir>` case below vacuously green rather than failing honestly.
//
// src/lib/stores/locale.persist-failure.test.ts — PERSISTING the locale must not take the page down.
//
// ⛔ THE SIBLING OF `locale.storage-failure.test.ts`, AND THE HALF THAT WAS MISSING. That file pins
// the READ (`resolveInitialLocale` → `getLocale`). This one pins the WRITE (`init`/`set` →
// `setLocale`), which had no guard at all: both methods called `pgSetLocale` bare.
//
// ⛔ AND THE WRITE IS THE WORSE ONE. The read runs at module scope and falls back to 'en' — the
// reader loses their remembered language for one paint. `init()` is called from
// `routes/+layout.svelte` ON MOUNT, so an unguarded throw there propagates out of the layout's
// mount and the app renders NOTHING. Paraglide's `setLocale` does `localStorage.setItem(...)`
// (`paraglide/runtime.js:502`) under the `localStorage` strategy, and every reason the read can
// throw — a sandboxed iframe without `allow-same-origin`, a privacy configuration — applies
// identically to the write.
//
// ⚠️ WHY NOBODY SAW IT. `package.json` compiled paraglide with no `--strategy`, so CI got the CLI
// default `['cookie','globalVariable','baseLocale']`, under which
// `TREE_SHAKE_LOCAL_STORAGE_STRATEGY_USED` is `false` and the `setItem` line is COMPILED OUT of the
// runtime. Production always shipped the `localStorage` strategy (`vite.config.ts`). So this path
// was live for every real reader and unreachable for every test, in both directions, until the
// compile flags were fixed. The first thing the corrected flags did was red nine cases in
// `routes/connectors/connectors-page.source-label-search.render.test.ts` with
// `TypeError: localStorage.setItem is not a function` — vitest 2.1's jsdom supplies a
// `localStorage` OBJECT whose methods are `undefined` (measured; real jsdom supplies working ones),
// which is the same hostile shape a SecurityError produces.
//
// ⛔⛔ MOCKS THE RUNTIME'S `setLocale`, AND DOES **NOT** STUB `localStorage` — the same decision
// `locale.storage-failure.test.ts` argues at length, for the same reason. A `localStorage` stub is
// ORDER-DEPENDENT and can be silently vacuous (paraglide memoises, and the strategy list decides
// whether the storage line exists in the build at all). Mocking the seam states the contract the
// store actually owns: *whatever the persistence layer does, the app must stay up*.
import { describe, it, expect, vi } from 'vitest';

/**
 * Re-import the store with `setLocale` replaced. A FRESH module is mandatory: `locale` is a
 * singleton created at module scope, so a cached one carries the previous case's mock.
 */
async function importWithSetter(setLocale: (...a: unknown[]) => void) {
	vi.resetModules();
	vi.doMock('$lib/paraglide/runtime', async () => {
		const actual = await vi.importActual<Record<string, unknown>>('$lib/paraglide/runtime');
		return { ...actual, setLocale };
	});
	try {
		return await import('./locale.svelte');
	} finally {
		vi.doUnmock('$lib/paraglide/runtime');
		vi.resetModules();
	}
}

const hostile = () => {
	throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('locale store — persisting the locale must not be able to take the page down', () => {
	it('⛔ THE DEFECT — `init()` when setLocale THROWS (a sandboxed iframe, a privacy config)', async () => {
		const { locale } = await importWithSetter(hostile);
		// Pre-fix this threw `SecurityError` straight out of `+layout.svelte`'s mount.
		expect(() => locale.init('nl')).not.toThrow();
		// …and the locale is still APPLIED. Surviving is not enough — a store that swallowed the
		// throw and also dropped the language would pass a bare `not.toThrow()` while leaving the
		// reader on the wrong language, which is the failure this guard is supposed to prevent.
		expect(locale.current).toBe('nl');
	});

	it('⛔ `set()` too — the topbar switch is the other caller', async () => {
		const { locale } = await importWithSetter(hostile);
		expect(() => locale.set('de')).not.toThrow();
		expect(locale.current).toBe('de');
	});

	it('⛔ `<html lang/dir>` is still applied when the persist fails', async () => {
		// THE ORDERING HALF, AND IT IS NOT DECORATIVE. `applyDocument()` runs AFTER the persist call.
		// A guard placed around only `pgSetLocale`'s statement — but leaving the throw to escape —
		// would skip `applyDocument()`, so an RTL reader would keep `dir="ltr"` and read a mirrored
		// page. Asserting `dir` is what distinguishes "swallowed correctly" from "returned early".
		const { locale } = await importWithSetter(hostile);
		locale.set('ar');
		expect(document.documentElement.lang).toBe('ar');
		expect(document.documentElement.dir).toBe('rtl');
	});

	it('NON-VACUITY — the mock really is the seam the store calls', async () => {
		// If `setLocale` were not the function `init`/`set` call, every case above would pass against
		// a store that never touched persistence at all, and this file would guard nothing.
		const calls: unknown[][] = [];
		const { locale } = await importWithSetter((...a: unknown[]) => {
			calls.push(a);
		});
		locale.init('fr');
		expect(calls.length, 'init() never called the runtime setLocale').toBeGreaterThan(0);
		expect(calls[0]![0], 'init() persisted a different locale than it applied').toBe('fr');
		// `reload:false` is load-bearing: the reload variant navigates, which in a test environment
		// is a jsdom "not implemented" error and in production is a page flash on every mount.
		expect(calls[0]![1]).toMatchObject({ reload: false });
	});

	it('the happy path is untouched — a working setter still persists', async () => {
		const seen: string[] = [];
		const { locale } = await importWithSetter((next: unknown) => {
			seen.push(next as string);
		});
		locale.init('nl');
		locale.set('pl');
		expect(seen).toEqual(['nl', 'pl']);
		expect(locale.current).toBe('pl');
	});
});
