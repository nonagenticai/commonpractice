<script lang="ts">
	// Two-series sparkline for the it-dash "System health · 24h" panel, built from
	// real hourly buckets (runs/hr teal, llm-calls/hr coral). Scaled via viewBox;
	// non-scaling strokes keep line weight crisp at any width. Hovering reveals the
	// exact bucket (hour + both values) with a guide line and point markers, and the
	// y-axis max is labelled so the line has a readable scale.
	import type { HealthBucket } from '$lib/types/ops';
	import * as m from '$lib/paraglide/messages';
	import { hourMinute, num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	let { buckets }: { buckets: HealthBucket[] } = $props();

	const W = 100;
	const H = 40;
	const max = $derived(Math.max(1, ...buckets.flatMap((b) => [b.activeRuns, b.llmCalls])));
	function points(key: 'activeRuns' | 'llmCalls'): string {
		const n = buckets.length;
		if (n < 2) return '';
		return buckets.map((b, i) => `${(i / (n - 1)) * W},${H - (b[key] / max) * H}`).join(' ');
	}
	const runsPts = $derived(points('activeRuns'));
	const callsPts = $derived(points('llmCalls'));
	const runsArea = $derived(runsPts ? `${runsPts} ${W},${H} 0,${H}` : '');

	let hovered = $state<number | null>(null);
	const n = $derived(buckets.length);
	const xPct = $derived(hovered == null || n < 2 ? 0 : (hovered / (n - 1)) * 100);
	const topPct = (v: number) => (1 - v / max) * 100;

	function onMove(e: MouseEvent) {
		if (n < 2) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		hovered = Math.round(frac * (n - 1));
	}
</script>

<div
	class="spark-wrap"
	role="img"
	aria-label={m.ops_sparkline_aria()}
	onmousemove={onMove}
	onmouseleave={() => (hovered = null)}
>
	<svg class="spark" viewBox="0 0 {W} {H}" preserveAspectRatio="none">
		{#if runsArea}<polygon class="runs-area" points={runsArea} />{/if}
		{#if runsPts}<polyline class="runs" points={runsPts} />{/if}
		{#if callsPts}<polyline class="calls" points={callsPts} />{/if}
	</svg>

	<!-- ⛔ THE AXIS LABEL IS THE SAME FIGURE AS THE TOOLTIP THIRTEEN LINES BELOW. `max` is the peak of
	     `activeRuns`/`llmCalls`, which the tooltip already prints through `num()`; leaving the axis
	     raw meant a busy hour read "1207" on the scale and "1.207" in the popup that explains the
	     scale — one panel, two spellings, on /it-dash "System health · 24h". -->
	<span class="axis-max">{num(max, locale.current)}</span>
	<span class="axis-min">0</span>

	{#if hovered != null && buckets[hovered]}
		<div class="guide" style="left:{xPct}%"></div>
		<div class="dot runs" style="left:{xPct}%; top:{topPct(buckets[hovered].activeRuns)}%"></div>
		<div class="dot calls" style="left:{xPct}%; top:{topPct(buckets[hovered].llmCalls)}%"></div>
		<div class="tip" class:right={xPct > 60} style="left:{xPct}%">
			<!-- ⛔ Was `hourLabel()` → `toLocaleTimeString([], …)`. `[]` is not "no preference", it is
			     the RUNTIME's locale, so this read the browser's clock convention on a panel whose
			     every other word came from the app's catalog — "02:30 PM" next to "Runs per hour" in a
			     Dutch UI. Reading `locale.current` HERE is also what re-formats it on a locale switch. -->
			<div class="tip-time">{hourMinute(buckets[hovered].hourTs, locale.current)}</div>
			<div class="tip-row"><span class="sw teal"></span>{m.itdash_legend_runs_per_hour()}<b>{num(buckets[hovered].activeRuns, locale.current)}</b></div>
			<div class="tip-row"><span class="sw coral"></span>{m.itdash_legend_llm_calls_per_hour()}<b>{num(buckets[hovered].llmCalls, locale.current)}</b></div>
		</div>
	{/if}
</div>

<style>
	.spark-wrap {
		position: relative;
		width: 100%;
		height: 180px;
	}
	.spark {
		width: 100%;
		height: 100%;
		display: block;
	}
	.runs {
		fill: none;
		stroke: var(--c-teal);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	.runs-area {
		fill: var(--c-teal-pale);
		stroke: none;
	}
	.calls {
		fill: none;
		stroke: var(--c-coral-mid);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	.axis-max,
	.axis-min {
		position: absolute;
		left: 2px;
		font-size: 10px;
		color: var(--c-faint);
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}
	.axis-max {
		top: 0;
	}
	.axis-min {
		bottom: 0;
	}
	.guide {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--c-border);
		transform: translateX(-0.5px);
		pointer-events: none;
	}
	.dot {
		position: absolute;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		border: 2px solid var(--c-white);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.dot.runs {
		background: var(--c-teal);
	}
	.dot.calls {
		background: var(--c-coral-mid);
	}
	.tip {
		position: absolute;
		top: 8px;
		transform: translateX(-50%);
		background: var(--c-midnight);
		color: #fff;
		border-radius: var(--r);
		padding: 7px 10px;
		font-size: 11px;
		white-space: nowrap;
		pointer-events: none;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
		z-index: 2;
	}
	.tip.right {
		transform: translateX(-100%);
	}
	.tip-time {
		font-weight: 600;
		margin-bottom: 4px;
		color: rgba(255, 255, 255, 0.85);
	}
	.tip-row {
		display: flex;
		align-items: center;
		gap: 6px;
		color: rgba(255, 255, 255, 0.85);
	}
	.tip-row b {
		margin-inline-start: auto;
		padding-inline-start: 12px;
		color: #fff;
		font-variant-numeric: tabular-nums;
	}
	.sw {
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}
	.sw.teal {
		background: var(--c-teal);
	}
	.sw.coral {
		background: var(--c-coral-mid);
	}
</style>
