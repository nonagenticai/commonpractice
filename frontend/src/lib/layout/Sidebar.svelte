<script lang="ts">
	import { page } from '$app/state';
	import { sidebarNav, type NavItem } from './navConfig';
	import NavSection from './NavSection.svelte';
	import SettingsNavLink from './SettingsNavLink.svelte';
	import { cycleOnFor } from './cycle-nav';
	import { feedbackMailto } from './feedback-link';
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	// `open` only matters below 768px, where the sidebar is an off-canvas drawer (ShellLayout).
	// `collapsed` only matters at 768px and up, where it shrinks the column to an icon rail
	// (app.css `.app.sidebar-collapsed`); the drawer always shows full labels.
	let {
		open = false,
		collapsed = false,
		onToggleCollapse = () => {}
	}: { open?: boolean; collapsed?: boolean; onToggleCollapse?: () => void } = $props();

	// Resolve a Paraglide message by its key at render time (reactive via the
	// locale store's getLocale binding). Nav labels live as keys in navConfig.
	const msg = (key: string): string =>
		(m as unknown as Record<string, (i?: Record<string, unknown>) => string>)[key]();

	// Visibility is driven by the user's REAL realm role (no demo persona), resolved by
	// the pure `visibleNav` in navConfig.ts. It used to be a local `roleOk` closing over
	// the auth getters, which made the whole gate matrix untestable from node-env vitest —
	// and that is how the blanket super_admin gate on the `operate` group (which locked
	// every customer tenant_admin out of Datasets and Ontology) shipped unnoticed. The
	// raw `roles` array is passed straight through: `visibleNav` re-derives the same
	// composite (super_admin ⊇ tenant_admin ⊇ developer) the auth getters do.
	// Empty groups are dropped there, so no heading renders with nothing under it.
	// W2: the sidebar is `sidebarNav` — a short unlabelled main section, a collapsed Library, and
	// a gear standing in for every admin screen (/settings). `cycleOn` is the W5 hook: with the
	// voting cycle cadence OFF (/api/me `cycleCadence`) the cycle-only screens (Results) are dropped.
	const nav = $derived(sidebarNav(auth.user?.roles ?? [], { cycleOn: cycleOnFor(auth.user?.cycleCadence) }));
	const groups = $derived(nav.sections);

	const pathname = $derived(page.url.pathname);

	// Live sidebar counts (from /api/me); replaces the old hardcoded demo badges.
	const counts = $derived(auth.user?.counts);
	function badgeCount(item: NavItem): number | null {
		if (!item.badge) return null;
		const n = counts?.[item.badge.countKey];
		// Render only a real, positive count — no badge while counts load or when zero.
		return typeof n === 'number' && n > 0 ? n : null;
	}

	function isActive(href: string): boolean {
		return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
	}

	// Real identity from the Keycloak-authenticated user (via /api/me).
	const displayName = $derived(auth.user?.name || auth.user?.email || '—');
	const roleLabel = $derived(
		auth.isSuperAdmin
			? m.role_platform()
			: auth.isTenantAdmin
				? m.role_admin()
				: auth.isDeveloper
					? m.role_developer()
					: m.role_member()
	);
	const initials = $derived(toInitials(auth.user?.name, auth.user?.email));

	// "Feedback" opens the operator's support mailbox (backend SUPPORT_EMAIL via /api/me). Unset →
	// no link at all: an address is never guessed.
	const feedbackHref = $derived(feedbackMailto(auth.user?.supportEmail));

	function toInitials(name?: string, email?: string): string {
		const base = (name && name.trim()) || (email ? email.split('@')[0] : '');
		const parts = base.split(/[\s._-]+/).filter(Boolean);
		if (parts.length === 0) return '?';
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	}

	// Sign out → clears the local auth state and redirects to the Keycloak end-session
	// endpoint (auth.logout → kcLogout). The button below is the only UI hook for it.
	let signingOut = $state(false);
	async function handleLogout(): Promise<void> {
		if (signingOut) return;
		signingOut = true;
		await auth.logout();
	}
</script>

<aside class="sidebar" id="app-sidebar" class:open class:collapsed aria-label={m.shell_nav_label()}>
	<a class="brand" href="/" title={collapsed ? m.brand_name() : undefined}>
		<div class="brand-mark">
			<svg viewBox="0 0 36 36" fill="none">
				<rect x="2" y="2" width="32" height="32" rx="9" fill="var(--c-midnight-2)" />
				<path d="M11 18.5l4.5 4.5L25 13" stroke="var(--c-teal-mid)" stroke-width="2.6"
					stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</div>
		<div class="brand-text">
			<div class="brand-name">{m.brand_name()}</div>
			<!-- Shown to everyone: the product is in early access. Inline with the name, not a second
			     line (sidebar-brand.test.ts). -->
			<span class="brand-badge" data-testid="early-access-badge">{m.nav_early_access()}</span>
		</div>
	</a>

	{#each groups as group (group.section)}
		<NavSection section={group} {collapsed}>
			{#each group.items as item (item.id)}
				<!-- Collapsed to the icon rail, the label is visually hidden (still the link's accessible
				     name) and the native tooltip carries it for a pointer. -->
				<a
					class="nav-item"
					class:active={isActive(item.href)}
					href={item.href}
					title={collapsed ? msg(item.labelKey) : undefined}
				>
					<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
						{@html item.icon}
					</svg>
					<span class="nav-label">{msg(item.labelKey)}</span>
					{#if badgeCount(item) !== null}
						<span class="nav-badge" style={item.badge?.color ? `background:${item.badge.color}` : ''}>
							{num(badgeCount(item)!, locale.current)}
						</span>
					{/if}
				</a>
			{/each}
		</NavSection>
	{/each}

	<SettingsNavLink items={nav.settings} {collapsed} />
	{#if feedbackHref}
		<div class="nav-group sidebar-feedback">
			<a class="nav-item" href={feedbackHref} data-testid="nav-feedback"
				title={collapsed ? m.nav_feedback() : undefined}>
				<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
					stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="5" width="18" height="14" rx="2" />
					<polyline points="3 7 12 13 21 7" />
				</svg>
				<span class="nav-label">{m.nav_feedback()}</span>
			</a>
		</div>
	{/if}
	<div class="sidebar-foot">
		<div class="avatar" title={collapsed ? displayName : undefined}>{initials}</div>
		<div class="sidebar-foot-who">
			<div class="name">{displayName}</div>
			<div class="role">{roleLabel}</div>
		</div>
		<!-- Before sign-out, not after it: sign-out must stay the LAST focusable item of the phone
		     drawer's focus trap, and this toggle is `display: none` below 768px. -->
		<button
			type="button"
			class="sidebar-collapse"
			data-testid="sidebar-collapse"
			onclick={onToggleCollapse}
			title={collapsed ? m.shell_sidebar_expand() : m.shell_sidebar_collapse()}
			aria-label={collapsed ? m.shell_sidebar_expand() : m.shell_sidebar_collapse()}
		>
			<svg class="icon cp-dir-mirror" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<line x1="9" y1="4" x2="9" y2="20" />
				{#if collapsed}
					<polyline points="13 9 16 12 13 15" />
				{:else}
					<polyline points="16 9 13 12 16 15" />
				{/if}
			</svg>
		</button>
		<button
			type="button"
			class="sidebar-signout"
			onclick={handleLogout}
			disabled={signingOut}
			title={m.nav_sign_out()}
			aria-label={m.nav_sign_out()}
		>
			<!-- ⛔ MIRRORED IN RTL. This is the one genuinely DIRECTIONAL icon in the product: a door on
			     the inline start with an arrow leaving through it (`polyline` arrowhead at x=21,
			     `line` running 21 → 9). "Leaving" is drawn as rightward, which is outward in LTR and
			     INWARD — i.e. sign IN — for an Arabic or Hebrew reader. An `<svg>` does not mirror
			     under `dir="rtl"`; only an explicit transform flips it.
			     Decorative by construction: the accessible name is on the parent button
			     (`aria-label`), so `scaleX(-1)` here reverses no text — which is the one thing
			     `.cp-dir-mirror` must never be used on. An audit of all 46 icon graphics found every
			     other one neutral or brand; the search magnifier at `Topbar.svelte` is deliberately
			     NOT mirrored, per the usual RTL convention. -->
			<svg class="icon cp-dir-mirror" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
				<polyline points="16 17 21 12 16 7" />
				<line x1="21" y1="12" x2="9" y2="12" />
			</svg>
		</button>
	</div>
</aside>
