import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';

// The `sveltekit()` plugin lets vitest compile Svelte 5 rune modules (`*.svelte.ts`, e.g. the
// license gate store) and resolves the `$lib` / `$app` aliases. Pure-TS specs (no runes, e.g.
// builder-graph) are unaffected. Mirrors fr's frontend vitest config.
export default defineConfig({
	// Kit 3 removed the built-in `$lib` alias; the app restores it in `vite.config.ts`
	// (documented `module_removed_lib` compatibility path) and vitest builds its own
	// plugin instance, so the same alias has to be declared here too.
	// Paraglide 3 compiles `src/lib/paraglide/messages.js` to re-exports of a
	// `virtual:paraglide/*` module supplied by its Vite plugin — without the plugin here,
	// every test that imports the REAL message catalog fails to resolve it.
	plugins: [
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['localStorage', 'cookie', 'preferredLanguage', 'baseLocale'],
			cookieName: 'PARAGLIDE_LOCALE'
		}),
		sveltekit({ alias: { $lib: 'src/lib' } })
	],
	// Shim for a version skew that makes it impossible to mount ANY `.svelte` component with a
	// `<style>` block under vitest: vitest 2.1 bundles its own vite 5.4 (no `environments` field),
	// but @sveltejs/vite-plugin-svelte's style preprocessor calls the HOISTED vite 6.4's
	// `preprocessCSS`, which does `new PartialEnvironment('client', config)` →
	// `new Proxy(config.environments.client, …)` → "Cannot create proxy with a non-object as
	// target". Declaring the key gives the proxy an object to wrap; every real lookup then falls
	// through to the top-level config, so this changes nothing else. Delete when vitest is on v3+.
	environments: { client: {} },
	resolve: {
		// Svelte's package exports route `default` to the server runtime; tests that touch the client
		// runtime need the `browser` export condition. Pure-logic tests are unaffected.
		conditions: ['browser']
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// Fail-loud stub for the real network, so a `vi.mock()` that does not apply names itself
		// instead of surfacing as `TypeError: fetch() URL is invalid`. See the file's own comment.
		setupFiles: ['./src/lib/test/setup.ts']
	}
});
