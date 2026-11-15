<script lang="ts">
	// The synthetic cursor overlay (SPEC §5A Layer 3, Session 7). A fixed-position,
	// pointer-events:none pointer the agent driver animates while it puppeteers the
	// builder. Purely cosmetic — driven entirely by cursor.svelte.ts state. Mounted
	// once on the build page, above the config overlay (z-index 5).
	import { cursor } from './cursor.svelte';
</script>

{#if cursor.visible}
	<div
		class="agent-cursor"
		class:pressed={cursor.pressed}
		style="transform: translate({cursor.x}px, {cursor.y}px)"
		aria-hidden="true"
	>
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
			<path
				d="M5 3l14 7-6 1.6L9.7 18 5 3z"
				fill="var(--c-midnight, #0f172a)"
				stroke="#fff"
				stroke-width="1.4"
				stroke-linejoin="round"
			/>
		</svg>
		<span class="ring"></span>
	</div>
{/if}

<style>
	.agent-cursor {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 50;
		pointer-events: none;
		will-change: transform;
		/* keep the hotspot at the tip; SVG arrow points up-left */
		margin-left: -3px;
		margin-top: -2px;
		transition: filter 0.1s ease;
		filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.28));
	}
	.ring {
		position: absolute;
		top: 2px;
		left: 1px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid var(--c-teal, #0d9488);
		opacity: 0;
		transform: scale(0.4);
	}
	.agent-cursor.pressed .ring {
		animation: cursor-press 0.32s ease-out;
	}
	@keyframes cursor-press {
		0% {
			opacity: 0.7;
			transform: scale(0.4);
		}
		100% {
			opacity: 0;
			transform: scale(1.4);
		}
	}
</style>
