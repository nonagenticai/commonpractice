// paraglide-strategy-parity.test.ts — CI must not test a locale runtime production never ships.
//
// ⛔ THE DEFECT THIS PINS. `src/lib/paraglide/` is GENERATED and gitignored, and it was generated
// TWICE from two different configurations:
//
//   * `vite.config.ts` (`paraglideVitePlugin`) declares
//     `['localStorage','cookie','preferredLanguage','baseLocale']`. That is the runtime `bun run
//     build` emits, and it is what `frontend/Dockerfile` bakes into the shipped image.
//   * `package.json`'s `prepare` and `check` scripts ran `paraglide-js compile` with NO
//     `--strategy`, so the CLI default `['cookie','globalVariable','baseLocale']` applied.
//
// CI runs `bun install` (→ `prepare`), then `bun run check`, then vitest — all three against the
// DEFAULT runtime — and only afterwards `bun run build`, which overwrites the outdir with the real
// one. So every type-check and every test in CI ran against a locale runtime that is not the one in
// the image.
//
// ⛔ AND IT IS NOT A COSMETIC DIFFERENCE — `paraglide` TREE-SHAKES ON THE STRATEGY LIST. Measured
// on 2026-08-28 by compiling the same project both ways:
//
//      const                                        no --strategy   explicit --strategy
//      TREE_SHAKE_LOCAL_STORAGE_STRATEGY_USED           false              true
//      TREE_SHAKE_PREFERRED_LANGUAGE_STRATEGY_USED      false              true
//      TREE_SHAKE_GLOBAL_VARIABLE_STRATEGY_USED          true              false
//
// `getLocale()` guards each branch on its flag, so under CI's build the `localStorage.getItem(...)`
// line was COMPILED OUT of the runtime entirely. Any test that stubs a hostile `localStorage` to
// prove the store survives it is therefore vacuous in CI and live in production — the exact
// direction a guard must never fail in. (`stores/locale.storage-failure.test.ts` is immune because
// it mocks `getLocale` itself rather than stubbing storage, which its own header explains at
// length; that immunity is luck for THIS bug, not a reason to leave the runtimes divergent.)
//
// ⛔ WHAT IS *NOT* TRUE, because the inherited write-up of this bug said it was and it matters for
// whoever reads this next: `getLocale()` does NOT throw in the `node` test environment under the
// localStorage strategy. `runtime.js` computes `isServer = typeof window === 'undefined'` and every
// client strategy branch is gated on `!isServer`, so with no `window` the resolver falls straight
// through to `baseLocale` and returns `'en'` under BOTH strategy lists. Measured directly, with a
// `localStorage` whose every access throws `SecurityError`: still `'en'`, no throw. The divergence
// is real; that particular symptom of it is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strategy } from '$lib/paraglide/runtime.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The single declaration everything else must agree with: production's own vite plugin config,
 * read as TEXT rather than imported. Importing `vite.config.ts` would drag in the sveltekit and
 * tailwind plugins for a string comparison; the array is a literal and reading it is enough.
 */
function strategyFromViteConfig(): string[] {
	const src = readFileSync(`${root}/vite.config.ts`, 'utf8');
	const m = /strategy:\s*\[([^\]]*)\]/.exec(src);
	// NON-VACUITY: if the plugin config is ever reshaped (a variable, a spread, a different key),
	// this regex silently yields nothing and every assertion below would compare [] to [] and pass.
	expect(m, 'could not find a literal `strategy: [...]` in vite.config.ts — this guard is blind').not.toBeNull();
	const parsed = [...m![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
	expect(parsed.length, 'vite.config.ts declares an EMPTY strategy list — parse failed').toBeGreaterThan(0);
	return parsed;
}

describe('the compiled paraglide runtime matches the runtime production ships', () => {
	it('⛔ the generated `strategy` array equals vite.config.ts, in order', () => {
		// ORDER IS SEMANTIC, not cosmetic: `getLocale()` walks the list and takes the first strategy
		// that resolves. `['cookie','localStorage',…]` and `['localStorage','cookie',…]` disagree for
		// every reader who has both set, so this is `toEqual` on the array and not a set comparison.
		expect(strategy).toEqual(strategyFromViteConfig());
	});

	it('⛔ package.json compiles with an EXPLICIT --strategy in both prepare and check', () => {
		// The assertion above only holds for whoever last ran a compile. CI's ordering is
		// install (`prepare`) → `check` → vitest → `build`, so the runtime vitest sees is the one
		// `prepare`/`check` wrote — and with no `--strategy` the CLI default silently wins. Pinning
		// the flag in the scripts is what makes the parity above true in CI rather than locally.
		const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
			scripts: Record<string, string>;
		};
		const expected = `--strategy ${strategyFromViteConfig().join(' ')}`;
		for (const name of ['prepare', 'check']) {
			const script = pkg.scripts[name];
			expect(script, `package.json has no "${name}" script`).toBeDefined();
			expect(script!, `"${name}" runs paraglide-js compile`).toContain('paraglide-js compile');
			expect(
				script!,
				`"${name}" compiles paraglide with no explicit --strategy, so the CLI default ` +
					'["cookie","globalVariable","baseLocale"] applies and CI tests a runtime the image ' +
					'does not contain',
			).toContain(expected);
		}
	});
});
