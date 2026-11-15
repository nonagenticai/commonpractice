<script lang="ts">
	// (tenant) route group — tenant_admin (super_admin passes too, composite). Mirrors
	// the backend `requireTenantScope` role gate. Server-side authz on every /api/*
	// call is the real boundary; this guard only keeps the shell from flashing.
	import { auth } from '$lib/stores/auth.svelte';
	import { hasTenantAdmin } from '$lib/utils/auth-guards';
	import * as m from '$lib/paraglide/messages';

	let { children } = $props();
</script>

{#if hasTenantAdmin(auth.user)}
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
