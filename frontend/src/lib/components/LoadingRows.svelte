<script lang="ts">
	// A list/table-shaped shimmer placeholder for slow content fetches. Replaces a bare
	// "Loading…" text notice so the in-shell wait reads as "content arriving" rather than a
	// blank panel (A1: /connectors and /onboarding both had ~3–5s bare-text loading states).
	import Skeleton from './Skeleton.svelte';
	let { rows = 5 }: { rows?: number } = $props();
</script>

<div class="loading-rows" role="status" aria-busy="true">
	{#each Array(rows) as _, i (i)}
		<div class="lr-row">
			<Skeleton width="42%" height="13px" />
			<Skeleton width="16%" height="13px" />
			<Skeleton width="20%" height="13px" />
		</div>
	{/each}
</div>

<style>
	.loading-rows {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		margin-top: 12px;
	}
	.lr-row {
		display: flex;
		align-items: center;
		gap: 16px;
	}
</style>
