<script lang="ts">
	// Platform Ops runtime overview — the `it-dash` screen (demo.html:3007–3172).
	// Every widget is wired to real aggregates from /api/ops/dashboard.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { opsApi, ApiError } from '$lib/api/ops';
	import { errorText } from '$lib/api/error-message';
	import type { Dashboard } from '$lib/types/ops';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import Sparkline from '$lib/components/ops/Sparkline.svelte';
	import BarRow from '$lib/components/ops/BarRow.svelte';
	import AlertItem from '$lib/components/ops/AlertItem.svelte';
	import FeedItem from '$lib/components/ops/FeedItem.svelte';
	import { usd, usdEstimated, ms, num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let data = $state<Dashboard | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let denied = $state(false);

	const BAR_COLOR: Record<string, string> = {
		data: 'var(--c-teal)',
		ai: 'var(--c-violet)',
		logic: 'var(--c-amber)',
		output: 'var(--c-coral)',
		ui: 'var(--c-teal-mid)'
	};
	const barColor = (cat: string | null) => BAR_COLOR[cat ?? 'data'] ?? 'var(--c-teal)';

	const p95Warn = $derived((data?.stats.p95LatencyMs ?? 0) > 2000);

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			data = await opsApi.dashboard();
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	// Runtime settings live on the Governance screen (the policies the broker + run-gate
	// read at runtime) — deep-link there rather than duplicate the editor here.
	function openRuntimeSettings() {
		goto('/governance');
	}

	// Export the current dashboard aggregates as a downloadable JSON snapshot.
	function exportReport() {
		if (!data) return;
		const stamp = new Date().toISOString();
		const payload = JSON.stringify({ exportedAt: stamp, dashboard: data }, null, 2);
		const blob = new Blob([payload], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `commonpractice-ops-${stamp.slice(0, 10)}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.itdash_eyebrow()}</div>
			<h1>{m.itdash_title()}</h1>
			<p>{m.itdash_subtitle()}</p>
		</div>
		<div class="head-actions">
			<button class="btn-ghost" onclick={openRuntimeSettings}>{m.itdash_runtime_settings()}</button>
			<button class="btn-ghost" onclick={exportReport} disabled={!data}>{m.itdash_export_report()}</button>
		</div>
	</header>

	{#if denied}
		<div class="notice error">{m.itdash_denied()}</div>
	{:else if loading}
		<div class="notice">{m.itdash_loading()}</div>
	{:else if error}
		<div class="notice error">{m.itdash_load_failed({ error })}</div>
	{:else if data}
		<section class="stats">
			<StatCard label={m.itdash_stat_active_sandboxes()} value={num(data.stats.activeSandboxes, locale.current)} sub={m.itdash_stat_live_now()} href="/sandboxes" />
			<!--
			⛔ THESE TWO CARDS DELIBERATELY HAVE NO `href`. DO NOT RE-ADD `href="/usage"`.

			They carried one, and `StatCard.svelte` renders any href as an `<a>` with a `→`, so the
			screen promised a drill-down into the figure above. /usage answers a DIFFERENT QUESTION,
			on four independent axes (see the comment table in backend/src/host/ops-metrics.ts):

			    this card        /usage
			    ALL tenants      ONE tenant
			    today            last 30 days (default)
			    human + platform human only (`NOT ue.platform_actor`)
			    usage_counters   the usage_events ledger

			⛔ THE SYMPTOM IS "UNRELATED", NOT "SMALLER". Thirty days of one tenant's human calls can
			easily EXCEED one day of fleet-wide calls, so the reader does not even get the cue of a
			number that shrank — they get a plausible different number and no reason to distrust it.

			⛔ AND IT IS NOT A REACHABILITY PROBLEM, so `canReachNav()` is the wrong tool here.
			`roleAllows` is composite (super_admin ⊇ tenant_admin) and /usage is gated `tenant_admin`,
			so the super_admin reading /it-dash reaches /usage perfectly well. The link is not
			forbidden; it is about something else.

			The sub-label carries the second half of the fix: `itdash_stat_today` said only "today",
			which left the population unstated — nothing on this screen told a super_admin that
			"Spend today" folds in platform background traffic across every tenant. It does now.

			The honest drill-down for these two figures is a fleet-wide usage screen that does not
			exist yet; /it-dash's own sparkline below is already the per-hour breakdown of the same
			calls.
			-->
			<StatCard label={m.itdash_stat_daily_llm_calls()} value={num(data.stats.dailyLlmCalls, locale.current)} sub={m.itdash_stat_today_all_tenants()} />
			<StatCard label={m.itdash_stat_spend_today()} value={usdEstimated(data.stats.spendTodayUsd, locale.current)} hint={m.spend_estimate_hint()} sub={m.itdash_stat_today_all_tenants()} />
			<StatCard
				label={m.itdash_stat_p95_latency()}
				value={ms(data.stats.p95LatencyMs, locale.current)}
				sub={data.stats.p95LatencyMs == null ? m.itdash_p95_too_few_runs() : p95Warn ? m.itdash_p95_investigating() : m.itdash_p95_within_target()}
				tone={p95Warn ? 'warn' : 'ok'}
				href="/audit?category=sandbox" />
		</section>

		<div class="grid">
			<div class="col">
				<div class="section-title">{m.itdash_section_system_health()}</div>
				<div class="card">
					{#if data.health.buckets.some((b) => b.activeRuns > 0 || b.llmCalls > 0)}
						<Sparkline buckets={data.health.buckets} />
						<div class="legend">
							<span><span class="swatch teal"></span>{m.itdash_legend_runs_per_hour()}</span>
							<span><span class="swatch coral"></span>{m.itdash_legend_llm_calls_per_hour()}</span>
						</div>
					{:else}
						<p class="empty">{m.itdash_empty_no_activity_24h()}</p>
					{/if}
				</div>

				<div class="section-title">{m.itdash_section_most_used_blocks()}</div>
				<div class="card">
					{#if data.topBlocks.length === 0}
						<p class="empty">{m.itdash_empty_no_block_runs()}</p>
					{:else}
						{#each data.topBlocks as b (b.slug)}
							<!-- The block's NAME, not its slug. `BarRow` styles the label `--font-mono`, which
							     is what a kebab-case identifier looked like it deserved. `?? b.slug` is
							     REQUIRED, not defensive: `getTopBlocks` derives these slugs from
							     `flow_runs.trace` events, so a deleted or renamed block yields a slug with no
							     `building_blocks` row and `name` comes back null (or absent, from an old pod
							     mid-roll). The href stays keyed by slug — that is /block-edit's lookup key. -->
							<BarRow label={b.name ?? b.slug} value={num(b.count, locale.current)} pct={b.pct} color={barColor(b.category)} href="/block-edit?slug={encodeURIComponent(b.slug)}" />
						{/each}
					{/if}
				</div>
			</div>

			<div class="col">
				<div class="section-title">{m.itdash_section_needs_attention()}</div>
				<div class="card">
					{#if data.attention.length === 0}
						<p class="empty">{m.itdash_empty_nothing_attention()}</p>
					{:else}
						<!--
						⛔ KEYED BY INDEX. DO NOT "IMPROVE" THIS. Both tempting alternatives throw
						`each_key_duplicate`, which is NOT dev-only (svelte/internal/client/dom/blocks/each.js)
						and — with no `<svelte:boundary>` anywhere in this tree — takes the WHOLE page down to
						an empty shell, not just this card. That is exactly how /governance blanked; see the
						second commit of PR #233.
						  • `(a.kind)` DUPLICATES. Two `block_errors` rows are ROUTINE — getAttention returns
						    up to THREE of them (`ORDER BY n DESC LIMIT 3`), one per failing block.
						  • `(a.slug)` is `undefined` on every alert from an OLD pod, and on `sandbox_error`
						    and `high_latency` even from a new one. All rows then key on `undefined`.
						The browser reaches the API through the k8s Service, which load-balances across old
						and new pods for the length of a rolling deploy, so the prose-only payload is a REAL
						wire shape. Guarded by `it-dash-page.i18n.render.test.ts` → "survives an OLD backend".
						-->
						{#each data.attention as a, i (i)}
							<AlertItem item={a} />
						{/each}
					{/if}
				</div>

				<div class="section-title">{m.itdash_section_recent_events()}</div>
				<div class="card">
					{#if data.events.length === 0}
						<p class="empty">{m.itdash_empty_no_activity()}</p>
					{:else}
						<!--
						⛔ KEYED BY INDEX, same rule as the attention list above. `(e.kind)` duplicates on
						sight — the feed is up to 6 `block_published` + 6 `run_finished` + 4
						`sandbox_suspended` rows merged and trimmed to 8 — and `(e.block)` / `(e.flow)` are
						`undefined` on an old pod's payload AND on every row of a different kind. Either
						throws `each_key_duplicate` and blanks the page. `e.ts` is not safe either: two
						events can share a timestamp.
						-->
						{#each data.events as e, i (i)}
							<FeedItem item={e} />
						{/each}
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1180px;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal-dark);
		margin-bottom: 8px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 28px;
		margin: 0 0 4px;
		color: var(--c-midnight);
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
		max-width: 640px;
	}
	.head-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}
	/* Phone width (the shell drawer breakpoint, app.css): nothing on this page may push the screen sideways. */
	@media (max-width: 767.98px) {
		.page-head { flex-wrap: wrap; }
		.head-actions { flex-wrap: wrap; flex-shrink: 1; }
	}
	.btn-ghost {
		font-size: 13px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 14px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-ghost:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
		margin-bottom: 26px;
	}
	.grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: 22px;
		align-items: start;
	}
	.col {
		min-width: 0;
	}
	.section-title {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 4px 0 10px;
	}
	.col > .section-title:not(:first-child) {
		margin-top: 24px;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 16px 18px;
	}
	.legend {
		display: flex;
		gap: 18px;
		margin-top: 12px;
		font-size: 12px;
		color: var(--c-muted);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.swatch {
		width: 10px;
		height: 3px;
		border-radius: 2px;
	}
	.swatch.teal {
		background: var(--c-teal);
	}
	.swatch.coral {
		background: var(--c-coral-mid);
	}
	.empty {
		color: var(--c-muted);
		font-size: 12.5px;
		margin: 4px 0;
	}
	.notice {
		padding: 28px;
		text-align: center;
		color: var(--c-muted);
		font-size: 13.5px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
	.notice.error {
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
	@media (max-width: 900px) {
		.stats {
			grid-template-columns: repeat(2, 1fr);
		}
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
