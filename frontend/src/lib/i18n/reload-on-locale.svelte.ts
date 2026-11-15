// src/lib/i18n/reload-on-locale.svelte.ts — re-fetch locale-dependent API content
// when the user switches language. The topbar switcher updates the UI chrome
// reactively (Paraglide m.*), but API-fetched user content (challenge/solution
// titles, ontology labels — localized server-side via Accept-Language, see
// auth-fetch.ts) is loaded once in onMount and would otherwise stay in the old
// language until the next navigation. Call this from a page's <script> top level,
// alongside the existing onMount(load): it re-runs `load` on every locale CHANGE
// (the initial mount is skipped — onMount already covers that).
import { locale } from '$lib/stores/locale.svelte';

export function reloadOnLocaleChange(load: () => void): void {
	let first = true;
	$effect(() => {
		// Track the reactive locale rune.
		void locale.current;
		if (first) {
			first = false;
			return;
		}
		load();
	});
}
