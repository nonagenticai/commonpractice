<script lang="ts">
	// The settings sub-nav (W2). The admin screens kept their routes (/members, /usage, /tenants,
	// /it-dash, …), so a /settings `+layout` could never wrap them. Instead the app shell renders
	// this strip above the page whenever the current route is one of THIS role's settings screens:
	// a way back to /settings plus every sibling, with the current one marked.
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { auth } from '$lib/stores/auth.svelte';
	import { isNavActive, settingsGroups } from './navConfig';

	const msg = (key: string): string =>
		(m as unknown as Record<string, (i?: Record<string, unknown>) => string>)[key]();

	const pathname = $derived(page.url.pathname);
	const items = $derived(settingsGroups(auth.user?.roles ?? []).flatMap((g) => g.items));
	const shown = $derived(items.some((i) => isNavActive(i.href, pathname)));
</script>

{#if shown}
	<nav class="settings-subnav" aria-label={m.settings_title()} data-testid="settings-subnav">
		<a class="back" href="/settings">{m.settings_title()}</a>
		<span class="sep" aria-hidden="true">/</span>
		{#each items as item (item.id)}
			<a
				href={item.href}
				class:current={isNavActive(item.href, pathname)}
				aria-current={isNavActive(item.href, pathname) ? 'page' : undefined}>{msg(item.labelKey)}</a
			>
		{/each}
	</nav>
{/if}

<style>
	.settings-subnav {
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		white-space: nowrap;
		margin: 0 0 18px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--c-border);
		font-size: 13px;
		scrollbar-width: thin;
	}
	a {
		color: var(--c-muted);
		text-decoration: none;
		padding: 5px 9px;
		border-radius: var(--r);
	}
	a:hover {
		color: var(--c-ink);
		background: var(--c-surface);
	}
	a.current {
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		font-weight: 600;
	}
	.back {
		color: var(--c-ink);
		font-weight: 600;
	}
	.sep {
		color: var(--c-faint);
	}
</style>
