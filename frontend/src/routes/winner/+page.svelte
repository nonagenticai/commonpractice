<script lang="ts">
	// Weekly winner (`winner`). Announcement + production timeline (REAL — derived
	// from the winning solution's live pipeline card, see stepDetail below) +
	// honorable mentions + the week in numbers. /api/winner.
	import { onMount } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { marketplaceApi } from '$lib/api/marketplace';
	import type { WeeklyWinner } from '$lib/types/marketplace';
	import { demoDuration, num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { stageLabel } from '$lib/i18n/stage-label';
	import { errorText } from '$lib/api/error-message';
	import { periodKeyName } from '$lib/challenges/challenge-state';
	// 0107: with the voting cycle OFF there are no winners. The sidebar hides this screen; a direct
	// visit says so instead of showing the last winner from before the cycle was switched off.
	import { auth } from '$lib/stores/auth.svelte';

	let data = $state<WeeklyWinner | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// ⛔ `!= null`, NOT truthiness — everywhere `stats` is read below.
	//
	// A genuine ZERO is data. The first real weekly winner won a week in which 0 total votes
	// were cast, and every one of these checks read that fact as "we have no figure": the hero
	// silently dropped from 4 tiles to 3, and "The week in numbers" rendered its heading over
	// an empty list. `0` is the answer, not the absence of one; only `undefined` is the absence.
	// ⛔ TWO CLAUSES, NOT FOUR. `firstTimeBuilders` and `crossDomain` were here and rendered below.
	// Nothing in the product can compute either (migration 0064:184-191); their only writer is the
	// seeders' `fabricate` branch, so every non-production database showed two invented numbers in
	// the same list, same typography, as the two measured ones. See lib/types/marketplace.ts for why
	// they survive in the DATABASE — they are migration 0064's forensic marker — and only here.
	const hasNumbers = $derived(
		data != null &&
			(data.stats.totalVotesCast != null || data.stats.solutionsSubmitted != null)
	);

	// Session 6: the production timeline is REAL — derived from the winning solution's
	// live pipeline card (/api/winner → pipeline). Each stage carries its done/active
	// state; the active stage shows extra detail (hardening day N/X, staging canary %).
	function stepDetail(key: string): string {
		const p = data?.pipeline;
		if (!p) return '';
		if (key === p.stage) {
			if (key === 'hardening' && p.progress?.ofDays) return m.winner_step_hardening({ day: p.progress.day ?? 0, ofDays: p.progress.ofDays ?? 0 });
			if (key === 'staging') return m.winner_step_staging({ pct: p.rolloutPct });
			if (key === 'production' && p.live) return m.winner_step_live();
			return m.winner_step_in_progress();
		}
		return '';
	}

	async function load() {
		loading = true;
		error = null;
		try {
			data = await marketplaceApi.winner();
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);
	reloadOnLocaleChange(load);
</script>

<div class="page">
	{#if auth.user?.cycleCadence === 'off'}
		<div class="notice" data-testid="winner-cycle-off">
			<strong>{m.winner_cycle_off_title()}</strong>
			<span>{m.winner_cycle_off_text()}</span>
		</div>
	{:else if loading && !data}
		<div class="notice">{m.winner_loading()}</div>
	{:else if error}
		<div class="notice error" role="alert">
			<span>{error}</span>
			<!-- ⛔ THE COPY NAMES AN ACTION; THIS IS THE CONTROL THAT PERFORMS IT. `error_load_failed`
			     reads "We couldn't load that. Please try again." and this arm replaces the whole page,
			     so a failed first load was a dead end with no exit but F5. Same sentence-plus-button
			     shape as the profile-error row in +layout.svelte, except this one re-runs the page's own
			     loader rather than reloading the app. -->
			<button class="retry" onclick={load}>{m.error_load_retry()}</button>
		</div>
	{:else if data && data.winner}
		<section class="hero">
			<!-- Two MESSAGES, not one message with an empty argument. Interpolating `''` into
			     "Common Practice · {week}" printed the separator with nothing after it —
			     "COMMON PRACTICE ·" — which reads as a truncated string, not as "no week". -->
			<div class="hero-eyebrow">
				{#if data.week}{m.winner_hero_eyebrow({ week: periodKeyName(data.week) })}{:else}{m.winner_hero_eyebrow_no_week()}{/if}
			</div>
			<h1>{m.winner_hero_title({ name: data.winner.solution.author.name })}</h1>
			<!-- ⛔ WINNING IS NOT TOPPING THE VOTE, AND THE HERO MAY NOT IMPLY IT IS. `winner_hero_title`
			     stays exactly as it was — the solution DID win the week — but two of the three ways
			     /api/winner derives a winner are vote-independent, so the row underneath can genuinely
			     out-poll it. The honourable-mentions list below now prints TRUE positions, which means a
			     "#1" can appear beneath the hero; this note is what stops that reading as a contradiction.
			     Three states, and the two silent ones are silent on purpose:
			       rank === 1  → nothing. The hero already says it, and there is no "#1" badge in this
			                     hero to gate — the title IS the badge.
			       rank  > 1   → this note, naming the real position.
			       rank == null → nothing. The winner has no position on this week's leaderboard (it was
			                     derived from a solution that never competed in it); a rendered "#—" or a
			                     guessed 1 would be the fabrication this whole change removes. -->
			{#if data.winner.rank != null && data.winner.rank > 1}
				<!-- `num(...)`, like every other figure on this page: a rank is a number the reader
				     reads, and `icu-number-params.sites.test.ts` requires each one be grouped in the
				     reader's own locale rather than handed to ICU raw. -->
				<p class="hero-rank-note">{m.winner_hero_rank_note({ rank: num(data.winner.rank, locale.current) })}</p>
			{/if}
			<div class="solution-name">{data.winner.solution.title}</div>
			{#if data.winner.challenge}
				<p class="sub">{m.winner_solution_to_pre()}<b>{data.winner.challenge.title}</b>{m.winner_solution_to_by({ submitter: data.winner.challenge.submitter })}</p>
			{/if}
			<div class="winner-stats">
				<div><span class="ws-val">{num(data.winner.solution.votesCount, locale.current)}</span><span class="ws-lbl">{m.winner_stat_votes_received()}</span></div>
				{#if data.stats.totalVotesCast != null}<div><span class="ws-val">{num(data.stats.totalVotesCast, locale.current)}</span><span class="ws-lbl">{m.winner_stat_total_votes()}</span></div>{/if}
				<!-- ⛔ CONDITIONAL, AND THE SAME `!= null` RULE AS EVERY OTHER TILE HERE — read the
				     `hasNumbers` note at the top of this file. This slot used to hold BUILD TIME,
				     rendered unconditionally through a helper that returned the literal '—' for null,
				     and null is what it always was: `solutions.build_time_minutes` was NULL for every
				     solution created through Build → Submit, so the demo's payoff screen led with an
				     em dash where its headline figure should be. The concept has no honest source and
				     was removed from the product, not hidden — see the comment on the column in
				     backend/src/db/schema.ts for what a real one would have to be.
				     What replaces it is MEASURED: the winner's most recent successful demo run
				     (`flow_runs.solution_id`, migration 0065). A `0` here would be data and would
				     render; only absence is absence, and absence is NO TILE rather than a dash. -->
				{#if data.winner.solution.demoMs != null}<div><span class="ws-val">{demoDuration(data.winner.solution.demoMs, locale.current)}</span><span class="ws-lbl">{m.winner_stat_demo_time()}</span></div>{/if}
				<div><span class="ws-val">{num(data.winner.solution.blocksUsed.length, locale.current)}</span><span class="ws-lbl">{m.winner_stat_blocks_used()}</span></div>
			</div>
			<div class="hero-actions">
				<a class="btn-coral" href={`/solutions/${data.winner.solution.id}`}>{m.winner_view_solution()}</a>
			</div>
		</section>

		{#if data.pipeline}
			<section class="timeline-section">
				<h2>{m.winner_timeline_title()}</h2>
				<!-- `stageLabel(...)`, never `step.label` / `data.pipeline.stage`. The backend still
				     sends `label` for one more deploy window (an old frontend needs it), but nothing
				     here may read it: it is English, and this sentence used to read
				     "deze kaart staat nu in hardening" — the raw enum — in a Dutch UI. -->
				<p class="seeded-note">{m.winner_timeline_note_pre()}<b>{stageLabel(data.pipeline.stage)}</b>{m.winner_timeline_note_after()}</p>
				<div class="pipeline">
					{#each data.pipeline.steps as step (step.key)}
						<div class="step {step.state}">
							<span class="step-dot">{step.state === 'done' ? '✓' : step.state === 'active' ? '●' : '○'}</span>
							<div class="step-label">{stageLabel(step.key)}</div>
							<div class="step-detail">{stepDetail(step.key)}</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<div class="grid">
			<div class="card">
				<h2>{m.winner_mentions_title()}</h2>
				{#if data.honorableMentions.length === 0}
					<p class="empty">{m.winner_mentions_empty()}</p>
				{:else}
					<ul class="mentions">
						{#each data.honorableMentions as mention (mention.id)}
							<li>
								<span class="m-rank">#{mention.rank}</span>
								<a class="m-title" href={`/solutions/${mention.id}`}>{mention.title}</a>
								<span class="m-author">{mention.author.name}</span>
								<span class="m-votes">{num(mention.votesCount, locale.current)} ▲</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="card">
				<h2>{m.winner_numbers_title()}</h2>
				<!-- An empty state, NOT a hidden card. This card shares a two-column `.grid` with
				     Honorable mentions; dropping it collapses the layout asymmetrically and leaves
				     the reader with no explanation for a section that was there last week. Mirrors
				     the sibling card's `.empty` paragraph exactly.
				     ⛔ Never filled with plausible figures — see marketplace-summary.ts:4-7. -->
				{#if !hasNumbers}
					<p class="empty">{m.winner_numbers_empty()}</p>
				{:else}
				<ul class="numbers">
					{#if data.stats.totalVotesCast != null}<li><a class="num-link" href="/solutions"><span>{m.winner_num_total_votes()}</span><b>{num(data.stats.totalVotesCast, locale.current)} <span class="cp-dir-mirror" aria-hidden="true">→</span></b></a></li>{/if}
					{#if data.stats.solutionsSubmitted != null}<li><a class="num-link" href="/solutions"><span>{m.winner_num_solutions_submitted()}</span><b>{num(data.stats.solutionsSubmitted, locale.current)} <span class="cp-dir-mirror" aria-hidden="true">→</span></b></a></li>{/if}
				</ul>
				{/if}
			</div>
		</div>
	{:else if data}
		<div class="notice">{m.winner_none()}</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1080px;
	}
	.hero {
		background: linear-gradient(135deg, var(--c-midnight), var(--c-navy));
		border-radius: var(--r-xl);
		padding: 40px;
		color: #fff;
		margin-bottom: 26px;
	}
	.hero-rank-note {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		opacity: 0.75;
	}
	.hero-eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-amber);
		margin-bottom: 14px;
	}
	.hero h1 {
		font-family: var(--font-display);
		font-size: 46px;
		margin: 0 0 6px;
		line-height: 1.05;
	}
	.solution-name {
		font-family: var(--font-display);
		font-style: italic;
		font-size: 20px;
		color: var(--c-amber);
		margin-bottom: 10px;
	}
	.hero .sub {
		font-size: 14px;
		color: rgba(255, 255, 255, 0.8);
		margin: 0 0 22px;
	}
	.winner-stats {
		display: grid;
		grid-template-columns: repeat(4, auto);
		gap: 28px;
		margin-bottom: 22px;
	}
	.winner-stats > div {
		display: flex;
		flex-direction: column;
	}
	.ws-val {
		font-family: var(--font-display);
		font-size: 26px;
		color: #fff;
	}
	.ws-lbl {
		font-size: 11.5px;
		color: rgba(255, 255, 255, 0.6);
	}
	.btn-coral {
		background: var(--c-coral);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 10px 18px;
		border-radius: var(--r);
		text-decoration: none;
	}
	.timeline-section {
		margin-bottom: 26px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 20px;
		margin: 0 0 6px;
		color: var(--c-midnight);
	}
	.seeded-note {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 0 0 16px;
	}
	.pipeline {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 12px;
	}
	.step {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 14px;
	}
	.step-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		font-size: 12px;
		background: var(--c-surface);
		color: var(--c-muted);
		margin-bottom: 8px;
	}
	.step.done .step-dot {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.step.active .step-dot {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.step-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.step-detail {
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 2px;
	}
	.grid {
		display: grid;
		grid-template-columns: 1.3fr 1fr;
		gap: 20px;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 18px 20px;
	}
	.card h2 {
		font-size: 18px;
		margin-bottom: 14px;
	}
	.mentions,
	.numbers {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.mentions li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 13.5px;
	}
	.mentions li:last-child {
		border-bottom: none;
	}
	.m-rank {
		font-family: var(--font-display);
		font-weight: 600;
		color: var(--c-coral-dark);
		width: 28px;
	}
	.m-title {
		flex: 1;
		color: var(--c-ink);
		text-decoration: none;
		font-weight: 500;
	}
	.m-title:hover {
		color: var(--c-coral-dark);
	}
	.m-author {
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.m-votes {
		color: var(--c-coral-dark);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.numbers li {
		display: flex;
		justify-content: space-between;
		padding: 9px 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 13.5px;
		color: var(--c-ink);
	}
	.numbers li:last-child {
		border-bottom: none;
	}
	.numbers b {
		font-variant-numeric: tabular-nums;
	}
	.num-link {
		display: flex;
		justify-content: space-between;
		flex: 1;
		text-decoration: none;
		color: inherit;
	}
	.num-link:hover {
		color: var(--c-teal-dark);
	}
	.num-link b {
		font-variant-numeric: tabular-nums;
	}
	.empty {
		color: var(--c-muted);
		font-size: 13px;
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
	/* The load-failure notice's retry control — see the button in the `{:else if error}` arm above.
	   Same tones as the profile-error row in +layout.svelte, which is where this shape comes from. */
	.notice.error .retry {
		margin-inline-start: 10px;
		border: 1px solid var(--c-coral-light);
		background: var(--c-white);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
	}
	@media (max-width: 860px) {
		.winner-stats {
			grid-template-columns: repeat(2, 1fr);
			gap: 18px;
		}
		.pipeline {
			grid-template-columns: 1fr 1fr;
		}
		.grid {
			grid-template-columns: 1fr;
		}
		.hero h1 {
			font-size: 34px;
		}
	}
</style>
