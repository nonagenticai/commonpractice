<script lang="ts">
	import { isTypingTarget } from './typing-target';
	import { tick } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import Sidebar from './Sidebar.svelte';
	import Topbar from './Topbar.svelte';
	import EarlyAccessFooter from '$lib/early-access/EarlyAccessFooter.svelte';
	import { activeTenant } from '$lib/stores/activeTenant.svelte';
	import { actAsReasonText } from '$lib/admin/act-as-refusal';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import * as m from '$lib/paraglide/messages';

	let { children } = $props();

	// ⛔ PHONE WIDTH. The 248px sidebar is a fixed grid column, so at 390px it left 142px for the
	// page and EVERY screen scrolled sideways. Below 768px (app.css) the sidebar is an off-canvas
	// drawer instead: the topbar's menu button opens it, and it closes on navigation, on Escape and
	// on a tap outside it. At desktop width `navOpen` changes nothing — the CSS ignores `.open`.
	let navOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);

	async function openNav() {
		navOpen = true;
		await tick();
		// Focus moves INTO the drawer, so a keyboard user lands on the first nav link.
		document.querySelector<HTMLElement>('#app-sidebar a, #app-sidebar button')?.focus();
	}

	function closeNav(returnFocus: boolean) {
		navOpen = false;
		if (returnFocus) menuButton?.focus();
	}

	/** While the drawer is open (a modal over the page), Tab and Shift+Tab wrap inside it instead of
	 *  walking into the page underneath the backdrop. */
	function trapFocus(e: KeyboardEvent) {
		const items = [
			...document.querySelectorAll<HTMLElement>(
				'#app-sidebar a[href], #app-sidebar button:not([disabled]), #app-sidebar [tabindex]:not([tabindex="-1"])'
			)
		];
		if (items.length === 0) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		const active = document.activeElement as HTMLElement | null;
		const inside = active != null && items.includes(active);
		if (e.shiftKey && (active === first || !inside)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !inside)) {
			e.preventDefault();
			first.focus();
		}
	}

	// A nav link (or any navigation) closes the drawer; focus follows the new page, not the button.
	afterNavigate(() => {
		navOpen = false;
	});
</script>

<svelte:window
	onkeydown={(e) => {
		// ⌘\ / Ctrl+\ collapses or expands the desktop sidebar (below 768px the CSS ignores it).
		// ⛔ NOT WHILE TYPING. Inside a field, a chat box or a code editor (CodeMirror is
		// contenteditable) the keystroke belongs to the text, and stealing it collapsed the sidebar
		// under the reader's cursor and swallowed the backslash.
		if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\' && !isTypingTarget(e.target)) {
			e.preventDefault();
			sidebar.toggle();
			return;
		}
		if (!navOpen) return;
		if (e.key === 'Escape') closeNav(true);
		else if (e.key === 'Tab') trapFocus(e);
	}}
/>

<div class="app" class:nav-open={navOpen} class:sidebar-collapsed={sidebar.collapsed}>
	<Sidebar open={navOpen} collapsed={sidebar.collapsed} onToggleCollapse={() => sidebar.toggle()} />
	{#if navOpen}
		<!-- The tap-outside target on a phone; hidden at desktop width (app.css). -->
		<div class="nav-backdrop" data-testid="nav-backdrop" aria-hidden="true" onclick={() => closeNav(true)}></div>
	{/if}
	<main class="main">
		<Topbar
			menuOpen={navOpen}
			onMenu={() => (navOpen ? closeNav(true) : openNav())}
			bind:menuButton
		/>
		{#if activeTenant.current}
			<div class="acting-banner" role="status">
				<span>{m.shell_acting_as({ name: activeTenant.current.name })}</span>
				<button onclick={() => activeTenant.clear()}>{m.shell_return_tenant()}</button>
			</div>
		{:else if activeTenant.dropped}
			<!-- ⛔ NEVER A SILENT DROP (George 2026-10-27): the backend refused the acting workspace and
			     the app came back in the operator's own one. Say so, and why. -->
			<div class="acting-banner dropped" role="alert" data-testid="acting-dropped">
				<span>{m.shell_act_as_dropped({ name: activeTenant.dropped.name, reason: actAsReasonText(activeTenant.dropped.code) })}</span>
				<button onclick={() => activeTenant.dismissDropped()}>{m.common_dismiss()}</button>
			</div>
		{/if}
		<div class="screens">
			{@render children()}
			<EarlyAccessFooter />
		</div>
	</main>
</div>

<style>
	.acting-banner {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 12px;
		padding: 8px 16px;
		background: var(--c-amber-light, #fef3c7);
		color: #92400e;
		font-size: 12.5px;
		font-weight: 600;
		border-bottom: 1px solid var(--c-border);
	}
	.acting-banner button {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r, 6px);
		padding: 3px 10px;
		cursor: pointer;
	}
</style>
