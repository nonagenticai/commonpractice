<script lang="ts">
	// Home (W4, 2026-10-14) — the page that teaches the platform. "Kaizen for knowledge work" +
	// one subline, a 4-step strip (report → prioritise → build → put into practice) with THIS
	// reader's next step highlighted (`$lib/home/next-step.ts`), the current round, a compact list
	// of open challenges, the reader's own items, and the old four stat cards reduced to one quiet
	// line. Data: one /api/home/summary load plus the reader's own draft flows (/api/flows).
	import { onMount } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { marketplaceApi } from '$lib/api/marketplace';
	import { flowsApi } from '$lib/api/flows';
	import { STEPS, nextStep, nextStepInput, latestDraftWithWork, type StepId, type StepAction } from '$lib/home/next-step';
	import type { HomeSummary } from '$lib/types/marketplace';
	import CadenceStrip from '$lib/components/marketplace/CadenceStrip.svelte';
	import { num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { errorText } from '$lib/api/error-message';

	let data = $state<HomeSummary | null>(null);
	// The period kind the cadence section draws: the live cycle row's, else the effective cadence's
	// (a month/quarter/year cadence whose period has not opened yet has no row). Undefined = an older backend.
	const periodKind = $derived(data?.cycle?.periodKind ?? data?.cadence?.effective);
	// ⛔ NO LIVE CYCLE ROW + A WEEKLY (or absent) CADENCE = NO SECTION. Without a cycle the strip has
	// nothing real to draw: it fell back to five fixed day cards ("1h vibe-coding", "Guest talk",
	// "14:30 · CTO café") lit by the reader's own weekday — the demo company's rituals, shown to a
	// brand-new org on its first login as if they were its own schedule (prod walk 2026-10-16). A
	// month/quarter/year cadence with no row keeps its neutral "not started yet" line: that sentence is
	// true and invents nothing. Pinned by home-page.cycle-cadence.render.test.ts.
	const showCadence = $derived(
		!!data &&
			data.cadence?.effective !== 'off' &&
			(!!data.cycle || periodKind === 'month' || periodKind === 'quarter' || periodKind === 'year')
	);
	// ⚠️ MID-ROLL FALLBACK — the `??` is load-bearing, do not "simplify" it away because the type
	// says these fields are required. Backend and frontend are SEPARATE IMAGES that roll
	// independently, so for the length of every roll a NEW frontend is answered by an OLD
	// backend. This repo already treats that as fact: backend/src/host/pipeline-service.ts:41-47
	// keeps a dead wire field alive for exactly one deploy window on that same reasoning.
	//
	// An old /api/home/summary carries NO `*Total` keys, and paraglide compiles the catalog to
	// raw interpolation with no nullish guard on the path — `You voted on (${i?.count})`, where
	// the `?.` guards the input OBJECT and never the FIELD. Reading a missing total straight into
	// the label therefore printed the literal word "undefined" on the product's first screen.
	//
	// Falling back to the slice length degrades to the OLD behaviour (a page size shown as a
	// count: wrong, but readable) instead of to a broken one. It also makes the truncation hints
	// below self-guarding: with no total on the wire, `total === list.length`, so `>` is false and
	// the hint cannot render a "Showing 8 of undefined". Pinned by
	// routes/home-page.stale-payload.render.test.ts.
	const submittedTotal = $derived(
		data?.yourActivity.submittedTotal ?? data?.yourActivity.submitted.length ?? 0
	);
	const votedOnTotal = $derived(
		data?.yourActivity.votedOnTotal ?? data?.yourActivity.votedOn.length ?? 0
	);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// The reader's newest draft flow with blocks on it — the "Continue building" signal. Its own
	// request, and BEST-EFFORT: a failure here must never cost the reader the page, so it degrades
	// to "no draft" (the strip then falls through to the next rule) instead of to an error.
	let draftFlowId = $state<string | null>(null);
	const next = $derived(data ? nextStep(nextStepInput(data, draftFlowId)) : null);

	async function loadDraft() {
		try {
			const res = await flowsApi.list({ status: 'draft' });
			draftFlowId = latestDraftWithWork(res.items ?? []);
		} catch {
			draftFlowId = null;
		}
	}

	const STEP_TEXT: Record<StepId, { title: () => string; body: () => string; icon: string }> = {
		report: {
			title: m.home_step_report_title,
			body: m.home_step_report_body,
			icon: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>'
		},
		prioritise: {
			title: m.home_step_prioritise_title,
			body: m.home_step_prioritise_body,
			icon: '<path d="M6 20v-6M12 20V9M18 20V4"/>'
		},
		build: {
			title: m.home_step_build_title,
			body: m.home_step_build_body,
			icon: '<path d="M14 6l8 8-2 2-8-8 2-2z"/><path d="M9 11L4 16l4 4 5-5"/>'
		},
		practice: {
			title: m.home_step_practice_title,
			body: m.home_step_practice_body,
			icon: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'
		}
	};
	const ACTION_TEXT: Record<StepAction, () => string> = {
		submit: m.home_hero_submit,
		vote: m.home_next_vote,
		continue: m.home_next_continue,
		build: m.home_next_build,
		results: m.home_next_results
	};

	async function load() {
		loading = true;
		error = null;
		try {
			const [home] = await Promise.all([marketplaceApi.home(), loadDraft()]);
			data = home;
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
	<section class="hero">
		<div class="hero-text">
			<h1>{m.home_hero_title()}</h1>
			<p>{m.home_hero_lede()}</p>
		</div>
		<a class="btn-primary" href="/submit" data-testid="home-submit">{m.home_hero_submit()}</a>
	</section>

	<!-- The loop, as four steps. Static links when the payload is not in yet; once it is, the
	     reader's next step is lit and its link becomes the action ("Continue building" goes to the
	     draft itself). -->
	<section class="steps" aria-labelledby="home-steps-title">
		<h2 id="home-steps-title" class="section-label">{m.home_steps_title()}</h2>
		<ol class="step-strip">
			{#each STEPS as s, i (s.id)}
				{@const isNext = next?.step === s.id}
				<li class="step" class:next={isNext}>
					<a
						href={isNext && next ? next.href : s.href}
						data-testid={`home-step-${s.id}`}
						aria-current={isNext ? 'step' : undefined}
					>
						<span class="step-top">
							<span class="step-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
									stroke-linecap="round" stroke-linejoin="round">{@html STEP_TEXT[s.id].icon}</svg>
							</span>
							<span class="step-num">{num(i + 1, locale.current)}</span>
						</span>
						<span class="step-title">{STEP_TEXT[s.id].title()}</span>
						<span class="step-body">{STEP_TEXT[s.id].body()}</span>
						{#if isNext && next}
							<span class="step-cta" data-testid="home-next-step">
								<span class="step-cta-label">{m.home_next_label()}</span>
								<span class="step-cta-action">{ACTION_TEXT[next.action]()} <span class="cp-dir-mirror" aria-hidden="true">→</span></span>
							</span>
						{/if}
					</a>
				</li>
			{/each}
		</ol>
	</section>

	{#if loading && !data}
		<div class="notice">{m.home_loading()}</div>
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
	{:else if data}
		<!-- Voting cycle OFF (0107), or no live cycle yet on a weekly cadence: nothing real to show — the
		     section is hidden (see `showCadence`). -->
		{#if showCadence}
			<section class="cadence-section">
				<!-- The kind comes from the cycle row when there is one, else from the effective cadence:
				     a month/quarter/year cadence with no row yet (the period has not opened) must not fall back
				     to the weekly title and day cards. -->
				<h2>
					{periodKind === 'month'
						? m.cadence_title_month()
						: periodKind === 'quarter'
							? m.cadence_title_quarter()
							: periodKind === 'year'
								? m.cadence_title_year()
								: m.home_cadence_title()}
				</h2>
				<CadenceStrip cycle={data.cycle} kind={periodKind} />
			</section>
		{/if}

		<div class="grid">
			<div class="card">
				<div class="card-head"><h2>{m.home_trending_title()}</h2><a class="more" href="/challenges">{m.home_see_all()}</a></div>
				{#if data.trending.length === 0}
					<p class="empty">{m.home_trending_empty_pre()}<a href="/submit">{m.home_trending_empty_link()}</a>.</p>
				{:else}
					<ul class="act-list">
						{#each data.trending as row (row.id)}
							<li>
								<a href={`/challenges/${row.id}`}>{row.title}</a>
								<span class="v" class:voted={row.hasVoted}>{num(row.votesCount, locale.current)} ▲</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="card">
				<h2>{m.home_activity_title()}</h2>
				<!-- ⚠️ Every NUMBER in this card comes from `*Total`, never from `list.length`.
				     Both lists are server-side LIMITed slices (5 and 8), so `.length` is a page
				     size: "You voted on (8)" was what a user with 30 votes saw, permanently.

				     The `showing_of` line renders ONLY when the slice actually hides something,
				     and it is PLAIN TEXT that states the count — it deliberately offers no
				     destination. It shipped as a link to /challenges labelled "see all", which
				     promised a retrieval the product cannot perform: GET /api/challenges accepts
				     exactly work_area / status / sort / q / page (backend/src/routes/
				     challenges.ts:248-290, mirrored in $lib/api/challenges.ts) — there is no
				     "mine" filter and no "voted-by-me" filter. "See all" therefore dropped the
				     reader on page 1 of a tenant-wide leaderboard (PAGE_SIZE 10, sort `top`)
				     with no way to isolate their own 30, and both hints pointed at that same
				     undifferentiated place.

				     ⛔ THE MISSING PIECE, so whoever adds it knows this copy can be upgraded:
				     a voted-by-me / submitted-by-me filter on GET /api/challenges. Once that
				     exists, this line can become a real link to the filtered view and the
				     catalog string can promise a destination again. -->
				<div class="act-block">
					<div class="act-label">{m.home_activity_submitted()}</div>
					{#if data.yourActivity.submitted.length === 0}
						<p class="empty sm">{m.home_activity_submitted_empty_pre()}<a href="/submit">{m.home_activity_submitted_empty_link()}</a>.</p>
					{:else}
						<ul class="act-list">
							{#each data.yourActivity.submitted as c (c.id)}
								<li><a href={`/challenges/${c.id}`}>{c.title}</a><span class="v">{num(c.votesCount, locale.current)} ▲</span></li>
							{/each}
						</ul>
						{#if submittedTotal > data.yourActivity.submitted.length}
							<p class="act-more">{m.home_activity_showing_of({ shown: num(data.yourActivity.submitted.length, locale.current), total: num(submittedTotal, locale.current) })}</p>
						{/if}
					{/if}
				</div>
				<div class="act-block">
					<div class="act-label">{m.home_activity_voted_on({ count: num(votedOnTotal, locale.current) })}</div>
					{#if data.yourActivity.votedOn.length === 0}
						<p class="empty sm">{m.home_activity_voted_empty()}</p>
					{:else}
						<ul class="act-list">
							{#each data.yourActivity.votedOn as c (c.id)}
								<li><a href={`/challenges/${c.id}`}>{c.title}</a><span class="v">{num(c.votesCount, locale.current)} ▲</span></li>
							{/each}
						</ul>
						{#if votedOnTotal > data.yourActivity.votedOn.length}
							<p class="act-more">{m.home_activity_showing_of({ shown: num(data.yourActivity.votedOn.length, locale.current), total: num(votedOnTotal, locale.current) })}</p>
						{/if}
					{/if}
				</div>
			</div>
		</div>

		<!-- The old four stat cards, reduced to one quiet line of context. -->
		<p class="stats-line" data-testid="home-stats-line">
			<span>{m.home_stat_active_challenges()} <b>{num(data.stats.activeChallenges, locale.current)}</b></span>
			<span>{m.home_stat_solutions_in_voting()} <b>{num(data.stats.solutionsInVoting, locale.current)}</b></span>
			<span>{m.home_stat_live_in_production()} <b>{num(data.stats.liveInProduction, locale.current)}</b></span>
		</p>
	{/if}
</div>

<style>
	.page {
		max-width: 1080px;
	}
	/* ---- hero: one line, one subline, one action. Calm, not a banner. ---- */
	.hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		flex-wrap: wrap;
		padding: 8px 0 28px;
		border-bottom: 1px solid var(--c-border);
		margin-bottom: 28px;
	}
	.hero-text {
		min-width: 0;
		flex: 1 1 360px;
	}
	.hero h1 {
		font-family: var(--font-display);
		font-size: clamp(26px, 4vw, 36px);
		line-height: 1.15;
		margin: 0 0 8px;
		color: var(--c-midnight);
	}
	.hero p {
		font-size: 14.5px;
		line-height: 1.55;
		color: var(--c-muted);
		max-width: 560px;
		margin: 0;
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13.5px;
		padding: 11px 20px;
		border-radius: var(--r);
		text-decoration: none;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.btn-primary:hover {
		background: var(--c-teal-dark);
	}

	/* ---- the 4-step strip ---- */
	.section-label {
		font-family: inherit;
		font-size: 11px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
		margin: 0 0 12px;
	}
	.steps {
		margin-bottom: 36px;
	}
	.step-strip {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.step a {
		display: flex;
		flex-direction: column;
		gap: 6px;
		height: 100%;
		box-sizing: border-box;
		padding: 16px 16px 18px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		color: var(--c-ink);
		text-decoration: none;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}
	.step a:hover {
		border-color: var(--c-teal-mid);
	}
	.step a:focus-visible {
		outline: 2px solid var(--c-teal);
		outline-offset: 2px;
	}
	.step.next a {
		border-color: var(--c-teal);
		background: var(--c-teal-pale);
		box-shadow: 0 0 0 1px var(--c-teal);
	}
	.step-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 4px;
	}
	.step-icon {
		width: 34px;
		height: 34px;
		border-radius: 10px;
		background: var(--c-surface);
		color: var(--c-teal-dark);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.step.next .step-icon {
		background: var(--c-teal);
		color: #fff;
	}
	.step-icon svg {
		width: 18px;
		height: 18px;
	}
	.step-num {
		font-family: var(--font-display);
		font-size: 22px;
		color: var(--c-border-strong);
		font-variant-numeric: tabular-nums;
	}
	.step.next .step-num {
		color: var(--c-teal);
	}
	.step-title {
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.step-body {
		font-size: 13px;
		line-height: 1.5;
		color: var(--c-muted);
	}
	.step-cta {
		margin-top: auto;
		padding-top: 10px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.step-cta-label {
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal-dark);
	}
	.step-cta-action {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
	}

	/* ---- below the strip ---- */
	.cadence-section {
		margin-bottom: 28px;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: 16px;
		margin-bottom: 20px;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 18px 20px;
		min-width: 0;
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 17px;
		margin: 0 0 12px;
		color: var(--c-midnight);
	}
	.more {
		font-size: 12.5px;
		color: var(--c-teal-dark);
		text-decoration: none;
		font-weight: 500;
		white-space: nowrap;
	}
	.act-block {
		margin-top: 14px;
	}
	.act-label {
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		margin-bottom: 6px;
	}
	.act-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.act-list li {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 7px 0;
		font-size: 13.5px;
		border-bottom: 1px solid var(--c-border);
	}
	.act-list li:last-child {
		border-bottom: none;
	}
	.act-list a {
		color: var(--c-ink);
		text-decoration: none;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.act-list a:hover {
		color: var(--c-teal-dark);
	}
	.act-list .v {
		color: var(--c-muted);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.act-list .v.voted {
		color: var(--c-teal-dark);
		font-weight: 600;
	}
	/* Plain caption, NOT a link — see the comment on the activity card. Styled as muted text
	   rather than in the teal link colour so it does not read as an affordance it is not. */
	.act-more {
		margin-top: 6px;
		font-size: 12px;
		color: var(--c-muted);
		font-weight: 500;
	}
	.stats-line {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 20px;
		margin: 4px 0 0;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.stats-line b {
		color: var(--c-ink);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		margin-inline-start: 4px;
	}
	.empty {
		color: var(--c-muted);
		font-size: 13px;
	}
	.empty.sm {
		font-size: 12.5px;
		margin: 0;
	}
	.empty a {
		color: var(--c-teal-dark);
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
	@media (max-width: 960px) {
		.step-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 520px) {
		.step-strip {
			grid-template-columns: minmax(0, 1fr);
		}
		.hero .btn-primary {
			width: 100%;
			text-align: center;
			box-sizing: border-box;
		}
	}
</style>
