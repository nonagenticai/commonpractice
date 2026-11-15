<script lang="ts">
	import '../app.css';
	import { onMount, onDestroy } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { updated, page } from '$app/state';
	import ShellLayout from '$lib/layout/ShellLayout.svelte';
	import SettingsSubnav from '$lib/layout/SettingsSubnav.svelte';
	import LicenseBlocked from '$lib/components/LicenseBlocked.svelte';
	import LicenseExpiringBanner from '$lib/components/LicenseExpiringBanner.svelte';
	import WorkspaceSuspended from '$lib/components/WorkspaceSuspended.svelte';
	import NoWorkspace from '$lib/components/NoWorkspace.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EarlyAccessFooter from '$lib/early-access/EarlyAccessFooter.svelte';
	import { isPublicPath } from '$lib/early-access/notice';
	import { auth } from '$lib/stores/auth.svelte';
	import { licenseGate } from '$lib/stores/licenseGate.svelte';
	import { workspaceGate } from '$lib/stores/workspaceGate.svelte';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let { children } = $props();

	// Authenticated-but-license-gated destination the gate must NOT bounce — the in-app renew page
	// stays reachable even when the license is blocked.
	const licenseRoutes = ['/license-upgrade'];
	// The invite-accept page is how a person WITHOUT a workspace gets one, so it renders bare
	// (no shell, no gates) for any signed-in user.
	const isInviteAccept = $derived(page.url.pathname.startsWith('/invite/accept'));
	// The early-access notice (/early-access) is PUBLIC: rendered bare, before any auth branch, for
	// signed-in and signed-out readers alike.
	const isPublic = $derived(isPublicPath(page.url.pathname));

	// SPA chunk-load resilience across a deploy. A hashed JS chunk that 404s after a new build
	// shipped (stale chunk graph in a long-lived tab, sometimes edge-negative-cached) fires Vite's
	// `vite:preloadError`. A full reload fetches the fresh no-cache shell with the NEW chunk hashes
	// and recovers (it never re-requests the dead hash). Guard against a reload loop: if we already
	// reloaded once and still fail, stop and let the error surface rather than thrash.
	const PRELOAD_RELOAD_KEY = 'cp:chunk-reloaded';
	function onPreloadError(e: Event) {
		e.preventDefault(); // suppress Vite's default re-throw; we drive recovery
		let already = false;
		try {
			already = sessionStorage.getItem(PRELOAD_RELOAD_KEY) === '1';
		} catch {
			/* sessionStorage unavailable (private mode) — best-effort */
		}
		if (already) return;
		try {
			sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1');
		} catch {
			/* ignore */
		}
		location.reload();
	}

	// Refresh the authoritative license gate on a cadence + when the tab regains focus, so an expiry
	// that lands while the app is open is caught even without an API call triggering the 402 path.
	let licenseRefreshTimer: ReturnType<typeof setInterval> | null = null;
	function onVisibility() {
		if (typeof document !== 'undefined' && document.visibilityState === 'visible' && auth.isAuthenticated) {
			void licenseGate.load();
		}
	}

	onMount(async () => {
		// Apply <html lang/dir> from the strategy-resolved locale immediately to
		// avoid an RTL flash, then re-seed from the user's stored preference once
		// auth resolves (user pref wins).
		locale.init();
		// ⛔ A page that OPENED on a public path must not start Keycloak: `initKeycloak` uses
		// `onLoad: 'login-required'`, which would send an anonymous reader to the sign-in screen. The
		// public page's "back" link is a full page load, so the app initialises normally from there.
		if (isPublicPath(page.url.pathname)) return;
		await auth.initialize();
		locale.init(auth.user?.locale);
		// The license gate also loads reactively the moment auth flips authenticated (see the $effect
		// below); this interval covers an expiry that lands during a long-lived open session.
		licenseRefreshTimer = setInterval(() => {
			if (auth.isAuthenticated) void licenseGate.load();
		}, 15 * 60 * 1000);
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', onVisibility);
		}
		if (typeof window !== 'undefined') {
			window.addEventListener('vite:preloadError', onPreloadError);
			// We mounted → chunks loaded fine → clear any prior reload stamp so a future
			// deploy is allowed its own one-shot recovery reload.
			try {
				sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
			} catch {
				/* ignore */
			}
		}
	});

	// Load the authoritative license gate as soon as the user is authenticated (and only once until
	// cleared) — so a newly-logged-in user never sees an unblocked shell before the first status lands.
	// ⛔ `auth.user !== null` is load-bearing: without a profile `needsWorkspace` reads false, so an
	// unseated person's status (about NO tenant) was fetched and cached as a licence wall that
	// survived their accepting the invite (2026-10-13). The licence question needs the profile first.
	$effect(() => {
		if (
			auth.isAuthenticated &&
			auth.user !== null &&
			!auth.needsWorkspace &&
			!licenseGate.status &&
			!licenseGate.isLoading
		) {
			void licenseGate.load();
		}
	});

	onDestroy(() => {
		if (licenseRefreshTimer) clearInterval(licenseRefreshTimer);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibility);
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('vite:preloadError', onPreloadError);
		}
	});

	// If a new build shipped while this tab was open (detected by the version poll
	// in vite.config.ts), force a full-page load on the next navigation so the
	// fresh hashed-chunk graph is fetched. The server's no-cache on the shell only
	// covers brand-new page loads; this covers long-lived SPA sessions.
	beforeNavigate((nav) => {
		if (updated.current && nav.to?.url && !nav.willUnload) {
			nav.cancel();
			location.href = nav.to.url.href;
		}
	});
</script>

{#if isPublic}
	{@render children()}
{:else if auth.isLoading}
	<div class="boot">{m.boot_loading()}</div>
{:else if auth.isAuthenticated && isInviteAccept}
	{@render children()}
{:else if auth.isAuthenticated && workspaceGate.isSuspended}
	<!-- ⛔ SUSPENSION IS TESTED BEFORE THE LICENCE BLOCK, AND THE ORDER IS THE DECISION.
	     Both flags can be set at once (a suspended workspace's licence can also lapse, and a
	     suspended tenant's requests 403 before anything has a chance to confirm the licence), so
	     exactly one of these two screens has to win. Suspension wins because it is the ACCURATE
	     cause: an operator has switched this workspace off, and no licence action reverses that.
	     Rendering LicenseBlocked instead would show a "Renew your licence" CTA pointing at
	     /license-upgrade — a false explanation and a payment funnel that cannot unlock them.
	     The reverse mistake is merely a less precise message; this one takes money for nothing.

	     NOTE this sits INSIDE the authenticated arm: an unauthenticated visitor still falls through
	     to the sign-in branch below, so a suspended tenant can always sign out and back in as
	     someone else. And there is no route allowlist here (no `licenseRoutes` equivalent), because
	     unlike the renew page there is no in-app destination that helps a suspended tenant — every
	     route would 403 anyway. -->
	<WorkspaceSuspended />
{:else if auth.needsWorkspace}
	<!-- Signed in, not a super_admin, and CP has seated them in no workspace. Before the licence
	     block: with no workspace there is no licence to renew, so that screen would be false. -->
	<NoWorkspace />
{:else if auth.isAuthenticated && licenseGate.isBlocked && !licenseRoutes.includes(page.url.pathname)}
	<!-- License missing/expired (or a live 402 license_* code): full-screen hard block. The renew
	     route is excluded so the in-app renew page stays reachable. -->
	<LicenseBlocked />
{:else if auth.isAuthenticated}
	<ShellLayout>
		<LicenseExpiringBanner />
		{#if auth.error}
			<!-- The profile (and with it the ROLE set that gates every nav item) failed to load.
			     Without this the shell renders as a stripped-down member view with no explanation —
			     indistinguishable from having had permissions removed. -->
			<div class="profile-error" role="alert">
				<span>{m.auth_profile_load_failed({ error: auth.error })}</span>
				<button onclick={() => location.reload()}>{m.auth_profile_retry()}</button>
			</div>
		{/if}
		<SettingsSubnav />
		{@render children()}
	</ShellLayout>
{:else}
	<div class="boot">
		<p>{m.boot_not_signed_in()}</p>
		<button class="signin" onclick={() => auth.login()}>{m.boot_sign_in()}</button>
		<EarlyAccessFooter />
	</div>
{/if}

<!-- App-root confirm modal; renders only when confirmDialog() has an active request. -->
<ConfirmDialog />

<style>
	.profile-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin: 0 0 14px;
		padding: 10px 14px;
		border: 1px solid var(--c-coral-light);
		background: var(--c-coral-pale);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		font-size: 12.5px;
	}
	.profile-error button {
		flex: none;
		border: 1px solid var(--c-coral-light);
		background: var(--c-white);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.boot {
		height: 100vh; display: flex; flex-direction: column; gap: 12px;
		align-items: center; justify-content: center; color: var(--c-muted);
		font-size: 14px;
	}
	.signin {
		background: var(--c-teal); color: #fff; padding: 8px 18px;
		border-radius: var(--r); font-weight: 600; font-size: 13px;
	}
</style>
