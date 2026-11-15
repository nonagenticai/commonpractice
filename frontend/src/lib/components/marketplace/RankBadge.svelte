<script lang="ts">
	// Circular leaderboard rank badge. Rank 1 is gold; the rest are subtle.
	// `variant` tints the gold (teal = challenges, coral = solutions).
	let { rank, variant = 'teal' }: { rank: number; variant?: 'teal' | 'coral' } = $props();
	const top = $derived(rank === 1);
</script>

<span class="rank" class:top class:coral={variant === 'coral'}>{rank}</span>

<style>
	.rank {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		color: var(--c-muted);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		flex-shrink: 0;
	}
	.rank.top {
		color: #7c5e10;
		background: var(--c-amber-light);
		border-color: var(--c-amber);
	}
</style>
