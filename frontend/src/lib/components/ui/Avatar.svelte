<script lang="ts">
	let { initials, size = 28 }: { initials: string; size?: number } = $props();
</script>

<span
	class="avatar"
	style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.34)}px">{initials}</span>

<style>
	.avatar {
		border-radius: 50%;
		background: var(--c-midnight);
		color: #fff;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
</style>
