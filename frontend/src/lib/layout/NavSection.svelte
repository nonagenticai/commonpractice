<script lang="ts">
	// One sidebar section (W2). The unlabelled `main` section renders its items as-is; the
	// `library` section is a disclosure, CLOSED by default, and opens on its own whenever the
	// current page is one of its items — so a reader who arrived on /datasets is never shown a
	// sidebar that hides where they are.
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { isNavActive, type SidebarSection } from './navConfig';

	// `collapsed` = the desktop icon rail (W1). The toggle keeps working there: its label is visually
	// hidden by app.css, so it carries a tooltip, drops the chevron, and the opened group shows its
	// items' icons un-indented (each item link has its own tooltip, set in Sidebar.svelte).
	let {
		section,
		children,
		collapsed = false
	}: { section: SidebarSection; children: Snippet; collapsed?: boolean } = $props();

	const msg = (key: string): string =>
		(m as unknown as Record<string, (i?: Record<string, unknown>) => string>)[key]();

	const pathname = $derived(page.url.pathname);
	const hasActive = $derived(section.items.some((i) => isNavActive(i.href, pathname)));
	// null = the reader has not touched the toggle: open exactly when the current page is inside.
	// ⛔ ONCE THEY HAVE, THEIR CHOICE WINS. This was `toggled || hasActive`, so on /datasets the
	// toggle flipped `toggled` and `hasActive` kept the section open regardless — a button that
	// announced `aria-expanded="true"` before and after every click and did nothing.
	let choice = $state<boolean | null>(null);
	const expanded = $derived(!section.collapsible || (choice ?? hasActive));
	const panelId = $derived(`nav-section-${section.section}`);
</script>

<div class="nav-group" class:nav-group-main={!section.labelKey}>
	{#if section.collapsible && section.labelKey}
		<button
			type="button"
			class="nav-item nav-section-toggle"
			aria-expanded={expanded}
			aria-controls={panelId}
			data-testid={`nav-section-toggle-${section.section}`}
			title={collapsed ? msg(section.labelKey) : undefined}
			onclick={() => (choice = !expanded)}
		>
			<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
				<path d="M4 5h4v14H4zM10 5h4v14h-4z" /><path d="M16 5.5l3.8-1 3 13.5-3.8 1z" />
			</svg>
			<span class="nav-label">{msg(section.labelKey)}</span>
			{#if !collapsed}
			<svg class="chev" class:open={expanded} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<polyline points="9 6 15 12 9 18" />
			</svg>
			{/if}
		</button>
		{#if expanded}
			<div class="nav-section-items" class:rail={collapsed} id={panelId}>{@render children()}</div>
		{/if}
	{:else}
		{@render children()}
	{/if}
</div>

<style>
	.nav-group-main {
		padding-top: 12px;
	}
	.nav-section-toggle {
		background: none;
		border: 0;
		font: inherit;
		font-size: 13.5px;
	}
	.chev {
		width: 14px;
		height: 14px;
		margin-inline-start: auto;
		opacity: 0.6;
		transition: transform 0.15s ease;
		transform: scaleX(var(--cp-dir-flip, 1));
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.nav-section-items {
		padding-inline-start: 12px;
	}
	.nav-section-items.rail {
		padding-inline-start: 0;
	}
</style>
