import adapter from '@sveltejs/adapter-node';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

declare const process: { env: Record<string, string | undefined> };

// Dev-only backend proxy. Production uses frontend/server.js which owns the same
// forwarding rule. Backend runs on 8790 (Session 0 port assignment).
const backend = process.env.CP_BACKEND_URL || 'http://localhost:8790';

export default defineConfig({
	plugins: [
		tailwindcss(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['localStorage', 'cookie', 'preferredLanguage', 'baseLocale'],
			cookieName: 'PARAGLIDE_LOCALE'
		}),
		// SvelteKit configuration lives here since kit 3 — `svelte.config.js` is no
		// longer supported (https://svelte.dev/e/kit/config_file_unsupported).
		sveltekit({
			// Kit 3 removed the built-in `$lib` alias; this is kit's own documented
			// compatibility path (`module_removed_lib`), avoiding a repo-wide rewrite
			// to `#lib` subpath imports.
			alias: { $lib: 'src/lib' },
			preprocess: vitePreprocess(),
			adapter: adapter({ out: 'build' }),
			// Poll /_app/version.json so a tab left open across a deploy learns a new
			// build shipped (drives the `updated` store; see +layout.svelte). The build
			// `version.name` defaults to a per-build timestamp, so it changes every deploy.
			version: { pollInterval: 60_000 }
		})
	],
	server: {
		port: 5174,
		strictPort: true,
		proxy: {
			'^/api/': {
				target: backend,
				changeOrigin: true,
				ws: true
			}
		}
	}
});
