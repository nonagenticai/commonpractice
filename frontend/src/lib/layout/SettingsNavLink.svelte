<script lang="ts">
	// The gear at the foot of the sidebar (W2). Every tenant_admin / super_admin screen lives
	// behind it instead of in the sidebar. Rendered only when this role can open at least one of
	// them, and highlighted on /settings AND on every screen it leads to.
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { isNavActive, type NavItem } from './navConfig';
	import { auth } from '$lib/stores/auth.svelte';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	// `collapsed` = the desktop icon rail (W1): the label is visually hidden, so the gear carries a tooltip.
	let { items, collapsed = false }: { items: NavItem[]; collapsed?: boolean } = $props();

	const pathname = $derived(page.url.pathname);
	// W8/P5: the gear carries the sum of its screens' live counts (today: pending requests), so a
	// reviewer sees there is something to review without opening /settings.
	const badge = $derived(
		items.reduce((sum, i) => {
			const n = i.badge ? auth.user?.counts?.[i.badge.countKey] : undefined;
			return sum + (typeof n === 'number' && n > 0 ? n : 0);
		}, 0)
	);
	const active = $derived(
		isNavActive('/settings', pathname) || items.some((i) => isNavActive(i.href, pathname))
	);
</script>

{#if items.length > 0}
	<div class="nav-group nav-settings">
		<a class="nav-item" class:active href="/settings" data-testid="nav-settings"
			title={collapsed ? m.nav_settings() : undefined}>
			<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
			</svg>
			<span class="nav-label">{m.nav_settings()}</span>
			{#if badge > 0}<span class="nav-badge" style="background:var(--c-amber)" data-testid="nav-settings-badge">{num(badge, locale.current)}</span>{/if}
		</a>
	</div>
{/if}

<style>
	/* Pinned to the bottom, directly above the identity footer. The footer's own `margin-top: auto`
	   would otherwise split the free space with this block's, floating the gear mid-column. */
	.nav-settings {
		margin-top: auto;
		padding-bottom: 8px;
	}
	:global(.nav-settings + .sidebar-foot) {
		margin-top: 0;
	}
</style>
