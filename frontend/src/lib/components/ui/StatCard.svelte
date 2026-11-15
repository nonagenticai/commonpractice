<script lang="ts">
	// demo.html stat card (it-dash). `sub` is an honest sub-label, not a fabricated
	// week-over-week delta; `tone='warn'` colours it (e.g. P95 over target).
	// `hint` renders a native tooltip on the value — used to mark a figure as an estimate
	// (spend is priced from one flat per-token rate and will not match a provider invoice).
	let {
		label,
		value,
		sub = '',
		tone = 'ok',
		href = undefined,
		hint = undefined
	}: {
		label: string;
		value: string;
		sub?: string;
		tone?: 'ok' | 'warn';
		href?: string;
		hint?: string;
	} = $props();
</script>

<svelte:element this={href ? 'a' : 'div'} class="stat" class:linked={href} {href}>
	<div class="stat-label">{label}</div>
	<div class="stat-value" title={hint}>{value}</div>
	{#if sub}<div class="stat-delta" class:down={tone === 'warn'}>{sub}</div>{/if}
	{#if href}<span class="stat-go cp-dir-mirror" aria-hidden="true">→</span>{/if}
</svelte:element>

<style>
	.stat {
		display: block;
		position: relative;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 16px 18px;
	}
	a.stat {
		text-decoration: none;
		color: inherit;
		transition:
			border-color 0.12s ease,
			box-shadow 0.12s ease,
			transform 0.12s ease;
	}
	a.stat:hover {
		border-color: var(--c-teal);
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
	}
	/* The arrow rests 4px INWARD and slides out to its home corner on hover.
	   `.cp-dir-mirror` (app.css) would set `transform: scaleX(-1)` in RTL, but this
	   rule owns `transform` at higher specificity — so compose both here instead of
	   letting one clobber the other. Order matters: translateX is listed FIRST, so
	   it is applied in the PARENT's coordinate system and is not re-signed by the
	   scaleX that follows; the direction of the slide is carried explicitly by
	   `--cp-dir-flip` instead. LTR resolves to translateX(-4px) scaleX(1) — the
	   pre-existing rendering, unchanged. `inset-inline-end` (identical to the old
	   `right: 14px` in LTR) puts the arrow in the inline-END corner in RTL too, so
	   "slides outward" stays true in both directions. */
	a.stat:hover .stat-go {
		opacity: 1;
		transform: translateX(0) scaleX(var(--cp-dir-flip, 1));
	}
	.stat-go {
		position: absolute;
		top: 14px;
		inset-inline-end: 14px;
		font-size: 14px;
		color: var(--c-teal);
		opacity: 0;
		transform: translateX(calc(-4px * var(--cp-dir-flip, 1))) scaleX(var(--cp-dir-flip, 1));
		transition:
			opacity 0.12s ease,
			transform 0.12s ease;
	}
	.stat-label {
		font-size: 11.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
	}
	.stat-value {
		font-family: var(--font-display);
		font-size: 28px;
		color: var(--c-midnight);
		margin: 6px 0 4px;
		line-height: 1.1;
	}
	.stat-delta {
		font-size: 11.5px;
		color: var(--c-emerald);
		font-weight: 500;
	}
	.stat-delta.down {
		color: var(--c-rose);
	}
</style>
