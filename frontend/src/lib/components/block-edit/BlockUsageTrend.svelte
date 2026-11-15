<script lang="ts">
	// Single-series usage sparkline for the block-edit "Usage stats" tab — daily run
	// counts over the last 30 days, from real node_success trace events (backend
	// `usageTrend`). Modeled on ops/Sparkline.svelte (viewBox scaling + non-scaling
	// stroke + hover guide/dot/tooltip) but deliberately a separate, generic
	// single-series variant rather than force-fitting the two-series health sparkline.
	import type { BlockUsagePoint } from '$lib/types/blocks';
	import * as m from '$lib/paraglide/messages';
	import { num, dayMonth } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';

	let { points }: { points: BlockUsagePoint[] } = $props();

	const W = 100;
	const H = 40;
	const max = $derived(Math.max(1, ...points.map((p) => p.runs)));
	const total = $derived(points.reduce((s, p) => s + p.runs, 0));
	const linePts = $derived.by(() => {
		const len = points.length;
		if (len < 2) return '';
		return points.map((p, i) => `${(i / (len - 1)) * W},${H - (p.runs / max) * H}`).join(' ');
	});
	const areaPts = $derived(linePts ? `${linePts} ${W},${H} 0,${H}` : '');

	let hovered = $state<number | null>(null);
	const n = $derived(points.length);
	const xPct = $derived(hovered == null || n < 2 ? 0 : (hovered / (n - 1)) * 100);
	const topPct = (v: number) => (1 - v / max) * 100;
	// ⚠️ NO `timeZone` HERE, DELIBERATELY — and that is the opposite of /usage's chart. `day` is a
	// bare `YYYY-MM-DD`, which `new Date()` parses as LOCAL midnight; pinning the formatter to UTC
	// would then shift every label a day for readers east of Greenwich. /usage receives a real
	// `…T00:00:00.000Z` instant and therefore MUST pass 'UTC'. Same helper, opposite argument,
	// because the two payloads are different shapes.
	const dayLabel = (day: string, loc: string) => dayMonth(`${day}T00:00:00`, loc);

	function onMove(e: MouseEvent) {
		if (n < 2) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		hovered = Math.round(frac * (n - 1));
	}
</script>

{#if total === 0}
	<p class="trend-none">{m.blockedit_usage_trend_none()}</p>
{:else}
	<div class="trend">
		<div class="trend-head">{m.blockedit_usage_trend_title()}</div>
		<div
			class="spark-wrap"
			role="img"
			aria-label={m.blockedit_usage_trend_aria()}
			onmousemove={onMove}
			onmouseleave={() => (hovered = null)}
		>
			<svg class="spark" viewBox="0 0 {W} {H}" preserveAspectRatio="none">
				{#if areaPts}<polygon class="runs-area" points={areaPts} />{/if}
				{#if linePts}<polyline class="runs" points={linePts} />{/if}
			</svg>

			<!-- Same figure as the tooltip below, which is already grouped — see ops/Sparkline.svelte,
			     the component this one is modelled on, for the defect this spelling caused. -->
			<span class="axis-max">{num(max, locale.current)}</span>
			<span class="axis-min">0</span>

			{#if hovered != null && points[hovered]}
				<div class="guide" style="left:{xPct}%"></div>
				<div class="dot runs" style="left:{xPct}%; top:{topPct(points[hovered].runs)}%"></div>
				<div class="tip" class:right={xPct > 60} style="left:{xPct}%">
					<div class="tip-time">{dayLabel(points[hovered].day, locale.current)}</div>
					<div class="tip-row">
						{m.blockedit_usage_trend_runs({ count: num(points[hovered].runs, locale.current) })}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.trend {
		margin-top: 18px;
	}
	.trend-head {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-ink);
		margin-bottom: 8px;
	}
	.trend-none {
		margin: 14px 0 0;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.spark-wrap {
		position: relative;
		width: 100%;
		height: 96px;
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
		color: #fff;
		font-variant-numeric: tabular-nums;
	}
</style>
