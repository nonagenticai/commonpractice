<!--
  LicenseExpiringBanner — non-blocking top banner shown when the license is valid but expiring
  within the warning window. Dismissible for the session; the app stays fully usable. Rendered by
  the root +layout above the shell. Styling uses the Common Practice design tokens, not tailwind.
-->
<script lang="ts">
	import { licenseGate, navigateToRenew } from '$lib/stores/licenseGate.svelte';
	import * as m from '$lib/paraglide/messages';

	let dismissed = $state(false);

	const show = $derived(licenseGate.isExpiringSoon && !dismissed);

	const message = $derived(
		licenseGate.daysRemaining != null
			? m.license_expiring_days({ days: licenseGate.daysRemaining })
			: m.license_expiring_soon()
	);
</script>

{#if show}
	<div class="leb" role="status">
		<span class="leb-msg">⚠ {message}</span>
		<span class="leb-actions">
			<button type="button" class="leb-renew" onclick={navigateToRenew}>
				{m.license_blocked_renew()}
			</button>
			<button
				type="button"
				class="leb-dismiss"
				onclick={() => (dismissed = true)}
				aria-label={m.common_dismiss()}
			>
				✕
			</button>
		</span>
	</div>
{/if}

<style>
	.leb {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 8px 16px;
		font-size: 13px;
		background: var(--c-amber-light);
		color: var(--c-coral-dark);
		border-bottom: 1px solid var(--c-amber);
	}
	.leb-msg {
		font-weight: 500;
	}
	.leb-actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.leb-renew {
		background: none;
		border: none;
		padding: 0;
		font-size: 13px;
		font-weight: 700;
		color: var(--c-coral-dark);
		text-decoration: underline;
		cursor: pointer;
	}
	.leb-renew:hover {
		opacity: 0.8;
	}
	.leb-dismiss {
		background: none;
		border: none;
		padding: 0;
		color: var(--c-coral-dark);
		opacity: 0.7;
		cursor: pointer;
		font-size: 13px;
	}
	.leb-dismiss:hover {
		opacity: 1;
	}
</style>
