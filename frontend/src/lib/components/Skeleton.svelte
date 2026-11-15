<script lang="ts">
	// Reusable shimmer placeholder for async loads (palette, block-edit detail, …).
	// Replaces bare "Loading…" text so loading states read as content arriving rather
	// than an empty panel. Sized via props; defaults to a single full-width line.
	let {
		width = '100%',
		height = '14px',
		radius = 'var(--r-sm)'
	}: { width?: string; height?: string; radius?: string } = $props();
</script>

<span
	class="skeleton"
	style="width:{width};height:{height};border-radius:{radius}"
	aria-hidden="true"
></span>

<style>
	.skeleton {
		display: block;
		background: linear-gradient(
			90deg,
			var(--c-surface) 25%,
			color-mix(in srgb, var(--c-border) 55%, var(--c-surface)) 37%,
			var(--c-surface) 63%
		);
		background-size: 400% 100%;
		animation: skeleton-shimmer 1.4s ease infinite;
	}
	@keyframes skeleton-shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: 0 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
		}
	}
</style>
