<script lang="ts">
	// (platform) route group — super_admin only (SPEC-PHASE4 Part 7). Mirrors the
	// backend `requireSuperAdmin`; the server is always the real authority (every
	// /api/* still 403s on its own), this just keeps the platform shell from flashing
	// for a non-super_admin. Auth is already resolved here: the root +layout only
	// renders children once `auth.isAuthenticated`, so `auth.user` is populated.
	import { auth } from '$lib/stores/auth.svelte';
	import { hasSuperAdmin } from '$lib/utils/auth-guards';
	import * as m from '$lib/paraglide/messages';

	let { children } = $props();
</script>

{#if hasSuperAdmin(auth.user)}
	{@render children()}
{:else}
	<div class="denied">{m.admin_denied()}</div>
{/if}

<style>
	.denied {
		font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-coral-dark);
		background: var(--c-coral-pale); border: 1px solid var(--c-coral-light);
		border-radius: var(--r-lg); max-width: 1080px; margin-top: 8px;
	}
</style>
