<!--
  src/routes/+error.svelte — the ROOT error boundary. Until this file existed, any mistyped, stale
  or bookmarked URL dropped the reader on SvelteKit's bare default error page: English, unstyled, no
  app shell, no navigation, no way back — a hard stop on a Dutch demo.

  ⚠️ A ROOT `+error.svelte` INHERITS `+layout.svelte`, so the shell (Sidebar, Topbar,
  LicenseExpiringBanner) renders around this. No chrome to rebuild here.

  ⚠️ `m.*()` IS SAFE WITH NO GUARD. `resolveInitialLocale()` (stores/locale.svelte.ts) runs at module
  scope inside try/catch and cannot throw — it falls back to 'en' — and `overwriteGetLocale` is bound
  at module scope too. So a message call here resolves even if the layout above never got as far as
  `locale.init()`.

  ⚠️ ONLY 404s REACH THIS TODAY (zero `error()` throws anywhere in the route tree; `auth-guards.ts`'s
  403 throws are dormant), but `page.status`/`page.message` are read live rather than assuming 404 —
  a 403 or 500 reaching this page later must not be mislabelled "page not found".
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { locale } from '$lib/stores/locale.svelte';
	import { num } from '$lib/utils/format';
	import { NAV_ITEMS } from '$lib/layout/navConfig';

	// The app's own convention for "home", not a hard-coded '/' — navConfig.ts is the single source
	// the Sidebar itself reads, so this link and the sidebar's Home item can never disagree.
	const homeHref = NAV_ITEMS.find((i) => i.id === 'home')?.href ?? '/';

	// A 404 is a different PROPOSITION than any other status: "this page does not exist" versus
	// "something on our side went wrong". Papering both with one sentence tells a reader who typo'd a
	// URL that the app is broken, and tells a reader who hit a real 500 that they made a mistake.
	const isNotFound = $derived(page.status === 404);
</script>

<div class="err-page">
	<div class="notice error" role="alert">
		<h1 class="err-title">
			{isNotFound ? m.error_page_not_found_title() : m.error_page_generic_title()}
		</h1>
		<p class="err-body">
			{isNotFound ? m.error_page_not_found_body() : m.error_page_generic_body()}
		</p>
		<!-- The status code, for a demo operator reporting "it broke" — never the raw message or a
		     stack: `page.error?.message` can be an internal string nobody outside the team should see. -->
		<p class="err-status">{m.error_page_status({ status: num(page.status, locale.current) })}</p>
		<a class="retry" href={homeHref}>{m.error_page_home_link()}</a>
	</div>
</div>

<style>
	.err-page {
		max-width: 640px;
		margin: 48px auto;
	}
	/* Same shape as the load-failure notice on /challenges (routes/challenges/+page.svelte) and the
	   profile-error row in +layout.svelte: coral-pale background, coral-light border. */
	.notice.error {
		padding: 32px;
		text-align: center;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-lg);
	}
	.err-title {
		font-family: var(--font-display);
		font-size: 20px;
		font-weight: 600;
		margin: 0 0 8px;
		color: var(--c-ink);
	}
	.err-body {
		margin: 0 0 12px;
		font-size: 14px;
		line-height: 1.5;
	}
	.err-status {
		margin: 0 0 20px;
		font-size: 12px;
		color: var(--c-muted);
	}
	/* Same control as the retry button in the house notice pattern — a link here, not a button, since
	   its job is navigation rather than re-running a loader. */
	.retry {
		display: inline-block;
		border: 1px solid var(--c-coral-light);
		background: var(--c-white);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		text-decoration: none;
	}
</style>
