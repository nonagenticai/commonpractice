<script lang="ts">
	// One business-impact metric (challenge-detail). Big value + label + a small
	// qualifier ("per claims associate").
	let { label, value, sub = '' }: { label: string; value: string; sub?: string } = $props();
</script>

<div class="tile">
	<div class="val">{value}</div>
	<div class="lbl">{label}</div>
	{#if sub}<div class="sub">{sub}</div>{/if}
</div>

<style>
	.tile {
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 16px;
		text-align: center;
	}
	.val {
		font-family: var(--font-display);
		font-size: 26px;
		color: var(--c-teal-dark);
		line-height: 1.1;
	}
	.lbl {
		font-size: 12px;
		color: var(--c-ink);
		font-weight: 600;
		margin-top: 6px;
	}
	.sub {
		font-size: 11px;
		color: var(--c-muted);
		margin-top: 2px;
	}
</style>
