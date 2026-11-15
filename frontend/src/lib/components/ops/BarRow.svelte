<script lang="ts">
	let {
		label,
		value,
		pct,
		color,
		href = undefined
	}: { label: string; value: string; pct: number; color: string; href?: string } = $props();
</script>

<svelte:element this={href ? 'a' : 'div'} class="bar-row" class:linked={href} {href}>
	<span class="bar-label">{label}</span>
	<span class="bar-track"><span class="bar-fill" style="width:{pct}%;background:{color}"></span></span>
	<span class="bar-val">{value}</span>
	{#if href}<span class="bar-go cp-dir-mirror" aria-hidden="true">→</span>{/if}
</svelte:element>

<style>
	.bar-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 7px 0;
	}
	a.bar-row {
		text-decoration: none;
		border-radius: var(--r);
		margin: 0 -8px;
		padding: 7px 8px;
		transition: background 0.12s ease;
	}
	a.bar-row:hover {
		background: var(--c-surface);
	}
	a.bar-row:hover .bar-label {
		color: var(--c-teal-dark);
	}
	.bar-go {
		width: 12px;
		flex-shrink: 0;
		text-align: end;
		font-size: 12px;
		color: var(--c-teal);
		opacity: 0;
		transition: opacity 0.12s ease;
	}
	a.bar-row:hover .bar-go {
		opacity: 1;
	}
	.bar-label {
		width: 130px;
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--c-ink);
	}
	.bar-track {
		flex: 1;
		height: 6px;
		background: var(--c-surface-2);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
	}
	.bar-val {
		width: 40px;
		text-align: end;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--c-muted);
	}
</style>
