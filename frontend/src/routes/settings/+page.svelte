<script lang="ts">
	// /settings (W2) — the index behind the sidebar gear. Every tenant_admin / super_admin screen
	// left the sidebar and is listed here instead, grouped by audience. The screens themselves did
	// NOT move: each link goes to the route it always had, gated by the same `requiresRole` the
	// sidebar used (via `settingsGroups` → `sidebarNav` → `visibleNav`).
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';
	import { settingsGroups, type NavItem } from '$lib/layout/navConfig';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	const msg = (key: string): string =>
		(m as unknown as Record<string, (i?: Record<string, unknown>) => string>)[key]();

	const groups = $derived(settingsGroups(auth.user?.roles ?? []));
	// A live count on a link (W8/P5: pending requests) — only a real, positive number.
	function badgeCount(item: NavItem): number | null {
		const n = item.badge ? auth.user?.counts?.[item.badge.countKey] : undefined;
		return typeof n === 'number' && n > 0 ? n : null;
	}
</script>

<div class="page">
	<h1>{m.settings_title()}</h1>
	{#if groups.length === 0}
		<p class="notice">{m.admin_denied()}</p>
	{:else}
		{#each groups as g (g.key)}
			<section class="group">
				<h2>{msg(g.labelKey)}</h2>
				<ul class="links">
					{#each g.items as item (item.id)}
						<li>
							<a href={item.href} data-testid={`settings-link-${item.id}`}>
								<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
									{@html item.icon}
								</svg>
								<span>{msg(item.labelKey)}</span>
								{#if badgeCount(item) !== null}
									<span class="count" data-testid={`settings-badge-${item.id}`}>{num(badgeCount(item)!, locale.current)}</span>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>

<style>
	.page {
		max-width: 880px;
	}
	h1 {
		font-size: 28px;
		margin: 0 0 24px;
		color: var(--c-midnight);
	}
	.group + .group {
		margin-top: 28px;
	}
	h2 {
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-family: inherit;
		font-weight: 600;
		margin: 0 0 10px;
	}
	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 10px;
	}
	.links a {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 16px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		color: var(--c-ink);
		text-decoration: none;
		font-size: 14px;
		font-weight: 500;
	}
	.links a:hover {
		border-color: var(--c-teal-mid);
		color: var(--c-teal-dark);
	}
	.count {
		margin-inline-start: auto;
		font-size: 11.5px;
		font-weight: 600;
		min-width: 20px;
		padding: 1px 7px;
		border-radius: 999px;
		text-align: center;
		color: #fff;
		background: var(--c-amber);
	}
	.icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--c-teal-dark);
	}
	.notice {
		padding: 24px;
		color: var(--c-muted);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
</style>
