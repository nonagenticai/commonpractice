// locale.storage-failure.test.ts — importing the locale store must never throw.
//
// ⛔ WHAT THIS PINS. `locale.svelte.ts` resolves the initial locale at MODULE TOP LEVEL, and
// Paraglide's `resolveLocaleWithStrategies` reads `localStorage` directly. So the read happens at
// IMPORT time: every component that imports this store inherits it, and a throw means the importing
// component never evaluates and the page renders nothing.
//
// The locale work widened that seam from ONE importer (CadenceStrip) to fifteen. Measured before
// the guard landed: ten render-test files died at import with
// `TypeError: localStorage.getItem is not a function`. The same shape occurs in production in a
// sandboxed iframe without `allow-same-origin` and under some privacy configurations, where
// touching `localStorage` throws `SecurityError`.
//
// ⛔⛔ WHY THIS FILE MOCKS `getLocale` AND DOES **NOT** STUB `localStorage`. THIS IS THE WHOLE POINT,
// AND AN EARLIER DRAFT OF THIS FILE GOT IT WRONG IN A WAY THAT MATTERS.
//
// The obvious spelling is to replace `globalThis.localStorage` with a hostile object and assert the
// store survives. That spelling is **ORDER-DEPENDENT AND CAN BE SILENTLY VACUOUS**: Paraglide
// MEMOISES the strategy-resolved locale on first read, so if anything in the same worker already
// resolved it, `getLocale()` returns the cached value and never touches storage at all. The stub is
// then never reached, nothing throws, and the test passes **whether or not the guard exists**.
//
// That was measured, not theorised, and in BOTH directions:
//   • the stubbed happy-path case passed in one worktree and failed in another (`expected 'en' to
//     be 'nl'`) purely on import order;
//   • with the guard deleted, the stubbed "THE DEFECT" case still passed — i.e. the proof of
//     non-vacuity was itself vacuous.
//
// Mocking the runtime's `getLocale` states the contract `resolveInitialLocale` actually owns —
// *whatever the resolver does, the module must come up with a usable locale* — with no dependence
// on memoisation or file ordering. The localStorage story above is the MOTIVATION for that contract;
// the render suite passing is its integration evidence.
//
// ⚠️ Do not "restore" a localStorage-stub version of these cases. It looks more realistic and proves
// less.
import { describe, it, expect, vi } from 'vitest';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'];

/**
 * Re-import the store with `getLocale` replaced. A FRESH module is mandatory: the defect is at
 * module top level, so a cached module has already resolved (or already thrown) under whatever the
 * previous case installed.
 */
async function importWithResolver(getLocale: () => string) {
	vi.resetModules();
	vi.doMock('$lib/paraglide/runtime', async () => {
		const actual = await vi.importActual<Record<string, unknown>>('$lib/paraglide/runtime');
		return { ...actual, getLocale };
	});
	try {
		return await import('./locale.svelte');
	} finally {
		vi.doUnmock('$lib/paraglide/runtime');
		vi.resetModules();
	}
}

describe('locale store — resolving the initial locale must not be able to take the module down', () => {
	it('THE DEFECT — the resolver THROWS (SecurityError, as a sandboxed iframe produces)', async () => {
		const mod = await importWithResolver(() => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		});
		expect(mod.locale.current).toBe('en');
	});

	it('THE DEFECT — the resolver throws the exact shape ten render specs hit', async () => {
		// `localStorage.getItem is not a function`: the global exists but is not a Storage.
		const mod = await importWithResolver(() => {
			throw new TypeError('localStorage.getItem is not a function');
		});
		expect(mod.locale.current).toBe('en');
	});

	it('the resolver returns something the catalogs do not carry', async () => {
		const mod = await importWithResolver(() => 'kl');
		// Not merely "some string": an unsupported locale would degrade every m.*() call.
		expect(mod.locale.current).toBe('en');
		expect(LOCALES).toContain(mod.locale.current);
	});

	it('a WORKING resolver is still honoured — the guard is a fallback, not a replacement', async () => {
		// ⛔ NON-VACUITY, and it is load-bearing. Without this, replacing the whole function body with
		// `return 'en'` would keep every case above green while silently discarding each reader's
		// remembered language on every page load.
		const mod = await importWithResolver(() => 'nl');
		expect(mod.locale.current).toBe('nl');
	});
});
