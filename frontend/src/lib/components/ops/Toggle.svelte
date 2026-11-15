<script lang="ts">
	// The demo .toggle switch (teal when on). Controlled — emits the new value.
	let {
		checked,
		disabled = false,
		label = 'toggle',
		onchange
	}: { checked: boolean; disabled?: boolean; label?: string; onchange?: (v: boolean) => void } = $props();
</script>

<button
	type="button"
	class="toggle"
	class:on={checked}
	{disabled}
	aria-pressed={checked}
	aria-label={label}
	onclick={() => onchange?.(!checked)}
></button>

<style>
	.toggle {
		width: 36px;
		height: 20px;
		background: var(--c-border-strong);
		border: none;
		border-radius: 10px;
		position: relative;
		cursor: pointer;
		transition: background 0.15s;
		padding: 0;
		flex-shrink: 0;
	}
	.toggle::after {
		content: '';
		position: absolute;
		top: 2px;
		inset-inline-start: 2px;
		width: 16px;
		height: 16px;
		background: #fff;
		border-radius: 50%;
		box-shadow: var(--sh-sm);
		transition: transform 0.15s;
	}
	.toggle.on {
		background: var(--c-teal);
	}
	.toggle.on::after {
		transform: translateX(16px);
	}
	/* The knob's start edge is logical (inset-inline-start), so in RTL a positive
	   translateX slid it off the outside of the track. Negate X under RTL. */
	:global([dir='rtl']) .toggle.on::after {
		transform: translateX(-16px);
	}
	.toggle:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
