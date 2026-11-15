<script lang="ts">
	// The four stat cards at the top of /pipeline.
	//
	// Extracted out of `+page.svelte` so this row can be render-tested. `+page.svelte` runs
	// `onMount(load)` and immediately calls the API, so it cannot be mounted cleanly in jsdom — and
	// the property that broke here is a RENDERING decision, which a source grep can only approximate.
	// See `pipeline-stats.render.test.ts`.
	//
	// ⛔ THE DEFECT THIS FILE EXISTS TO PREVENT. The "avg time to live" card used to read:
	//     value = metrics.avgTimeToLiveDays > 0 ? `${metrics.avgTimeToLiveDays}d` : '—'
	//     sub   = metrics.avgTimeToLiveDays > 0 ? m.pipeline_stat_across_shipped() : m.pipeline_stat_no_live_yet()
	// i.e. it used the MAGNITUDE of a duration as a test for whether any data exists. In production
	// that rendered "AVG TIME TO LIVE — / none live yet" directly beside "IN PRODUCTION 1 / live now",
	// because the one card that shipped did so in 41 minutes and the server rounded to whole days.
	// A duration of zero is not the same statement as "nothing has shipped". Branch on `liveCount`.
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { num, duration } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import type { PipelineMetrics } from '$lib/types/pipeline';
	import * as m from '$lib/paraglide/messages';

	let { metrics }: { metrics: PipelineMetrics } = $props();

	// `liveCount` is OPTIONAL on the type: backend and frontend are separate images and a new
	// frontend talks to an old backend for the length of every deploy. Two ABSENCES, two meanings:
	//   undefined → the backend cannot answer "how many shipped" at all → reproduce the old
	//               expression VERBATIM, warts included, so the roll window degrades to exactly the
	//               behaviour that was already shipped rather than to something new and untested;
	//   null      → a new backend saying nothing has shipped (`liveCount === 0`).
	const hasLiveFact = $derived(metrics.liveCount !== undefined);
	const anyLive = $derived(hasLiveFact ? metrics.liveCount! > 0 : metrics.avgTimeToLiveDays > 0);
	const avgValue = $derived(
		!anyLive
			? '—'
			: hasLiveFact
				? duration(metrics.avgTimeToLiveMs ?? 0)
				: // Old-backend fallback: the pre-fix template literal, unchanged. Untranslatable and
					// bidi-ambiguous, which is why the new path puts the unit in the catalog — but this
					// branch must not invent behaviour a rolled-back backend cannot support.
					`${metrics.avgTimeToLiveDays}d`
	);
</script>

<section class="stats">
	<StatCard
		label={m.pipeline_stat_in_pipeline()}
		value={num(metrics.inPipeline, locale.current)}
		sub={m.pipeline_stat_not_yet_live()}
	/>
	<StatCard
		label={m.pipeline_stat_avg_time_to_live()}
		value={avgValue}
		sub={anyLive ? m.pipeline_stat_across_shipped() : m.pipeline_stat_no_live_yet()}
	/>
	<StatCard
		label={m.pipeline_stat_in_production()}
		value={num(metrics.inProduction, locale.current)}
		sub={m.pipeline_stat_live_now()}
	/>
	<StatCard
		label={m.pipeline_stat_rolled_back()}
		value={num(metrics.rolledBack, locale.current)}
		sub={m.pipeline_stat_this_quarter()}
	/>
</section>

<style>
	/* Moved verbatim from `+page.svelte` (Svelte styles are component-scoped, so the rule had to
	   travel with the markup or the row would have lost its grid). */
	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
		margin-bottom: 16px;
	}
	@media (max-width: 1000px) {
		.stats {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
