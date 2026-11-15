<script lang="ts">
	// Getting started (demo `docs`). Onboarding prose in a 3-column docs shell. Each
	// nav item links to its own section anchor; a scroll-spy highlights the section
	// currently in view.
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';

	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	// Each nav item carries the anchor of the section it scrolls to.
	const NAV: { groupKey: string; items: { key: string; anchor: string }[] }[] = [
		{
			groupKey: 'docs_nav_group_start',
			items: [
				{ key: 'docs_nav_what', anchor: 'what' },
				{ key: 'docs_nav_two_leaderboards', anchor: 'leaderboards' },
				{ key: 'docs_nav_first20', anchor: 'first20' }
			]
		},
		{
			groupKey: 'docs_nav_group_voters',
			items: [
				{ key: 'docs_nav_how_voting', anchor: 'how-voting' },
				{ key: 'docs_nav_good_vote', anchor: 'good-vote' },
				{ key: 'docs_nav_voting_cadence', anchor: 'cadence' }
			]
		},
		{
			groupKey: 'docs_nav_group_submitters',
			items: [
				{ key: 'docs_nav_writing_challenge', anchor: 'writing-challenge' },
				{ key: 'docs_nav_sample_policy', anchor: 'sample-policy' },
				{ key: 'docs_nav_after_voting', anchor: 'after-voting' }
			]
		},
		{
			groupKey: 'docs_nav_group_builders',
			items: [
				{ key: 'docs_nav_sandbox', anchor: 'sandbox' },
				{ key: 'docs_nav_building_blocks', anchor: 'building-blocks' },
				{ key: 'docs_nav_vibe_coding', anchor: 'vibe-coding' },
				{ key: 'docs_nav_submitting', anchor: 'submitting' }
			]
		}
	];

	let activeAnchor = $state('what');

	// Scroll-spy: highlight the nav item whose section is nearest the top of the view.
	onMount(() => {
		const headings = Array.from(document.querySelectorAll('.docs-body [id]')) as HTMLElement[];
		const obs = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible[0]) activeAnchor = visible[0].target.id;
			},
			{ rootMargin: '0px 0px -70% 0px', threshold: 0 }
		);
		headings.forEach((h) => obs.observe(h));
		return () => obs.disconnect();
	});
</script>

<div class="docs-shell">
	<nav class="docs-nav">
		{#each NAV as g (g.groupKey)}
			<div class="nav-group">
				<div class="nav-group-label">{mm[g.groupKey]()}</div>
				{#each g.items as item (item.key)}<a class="nav-item" class:active={item.anchor === activeAnchor} href={`#${item.anchor}`}>{mm[item.key]()}</a>{/each}
			</div>
		{/each}
	</nav>

	<article class="docs-body">
		<div class="eyebrow">{m.docs_eyebrow()}</div>
		<h1 id="what">{m.docs_title()}</h1>
		<p class="lede">{m.docs_lede()}</p>

		<h2 id="leaderboards">{m.docs_leaderboards_title()}</h2>
		<p>{m.docs_leaderboards_p1()}<b>{m.docs_leaderboards_challenge()}</b>{m.docs_leaderboards_p2()}<b>{m.docs_leaderboards_solution()}</b>{m.docs_leaderboards_p3()}</p>

		<h2 id="first20">{m.docs_first20_title()}</h2>
		<ol>
			<li>{m.docs_first20_1_pre()}<a href="/challenges">{m.docs_first20_1_link()}</a>{m.docs_first20_1_after()}</li>
			<li><a href="/submit">{m.docs_first20_2_link()}</a>{m.docs_first20_2_after()}</li>
			<li>{m.docs_first20_3_pre()}<a href="/build">{m.docs_first20_3_link()}</a>{m.docs_first20_3_after()}</li>
			<li>{m.docs_first20_4()}</li>
		</ol>

		<h2 id="how-voting">{m.docs_howvoting_title()}</h2>
		<p>{m.docs_howvoting_p1()}</p>
		<p>{m.docs_howvoting_p2()}</p>

		<h2 id="good-vote">{m.docs_goodvote_title()}</h2>
		<p>{m.docs_goodvote_p1()}</p>
		<p>{m.docs_goodvote_p2()}</p>

		<h2 id="cadence">{m.docs_cadence_title()}</h2>
		<ul>
			<li><b>{m.docs_cadence_mon_day()}</b>{m.docs_cadence_mon_text()}</li>
			<li><b>{m.docs_cadence_tuewed_day()}</b>{m.docs_cadence_tuewed_text()}</li>
			<li><b>{m.docs_cadence_close_day()}</b>{m.docs_cadence_close_text()}</li>
			<li><b>{m.docs_cadence_fri_day()}</b>{m.docs_cadence_fri_text()}</li>
		</ul>

		<h2 id="writing-challenge">{m.docs_writingchallenge_title()}</h2>
		<p>{m.docs_writingchallenge_p1()}</p>
		<p>{m.docs_writingchallenge_p2()}</p>

		<h2 id="sample-policy">{m.docs_samplepolicy_title()}</h2>
		<p>{m.docs_samplepolicy_p1()}</p>
		<p>{m.docs_samplepolicy_p2()}</p>

		<h2 id="after-voting">{m.docs_aftervoting_title()}</h2>
		<p>{m.docs_aftervoting_p1()}</p>
		<p>{m.docs_aftervoting_p2()}</p>

		<h2 id="sandbox">{m.docs_sandbox_title()}</h2>
		<p>{m.docs_sandbox_p1()}</p>
		<p>{m.docs_sandbox_p2()}</p>

		<h2 id="building-blocks">{m.docs_buildingblocks_title()}</h2>
		<p>{m.docs_buildingblocks_p1()}</p>
		<p>{m.docs_buildingblocks_p2()}</p>

		<h2 id="vibe-coding">{m.docs_vibecoding_title()}</h2>
		<p>{m.docs_vibecoding_p1()}</p>
		<p>{m.docs_vibecoding_p2()}</p>

		<h2 id="submitting">{m.docs_submitting_title()}</h2>
		<p>{m.docs_submitting_p1()}</p>
		<p>{m.docs_submitting_p2()}</p>

		<h2 id="never">{m.docs_never_title()}</h2>
		<ul>
			<li>{m.docs_never_1()}</li>
			<li>{m.docs_never_2()}</li>
			<li>{m.docs_never_3()}</li>
			<li>{m.docs_never_4()}</li>
		</ul>
	</article>

	<aside class="docs-toc">
		<div class="toc-label">{m.docs_toc_label()}</div>
		<a href="#what">{m.docs_nav_what()}</a>
		<a href="#leaderboards">{m.docs_nav_two_leaderboards()}</a>
		<a href="#first20">{m.docs_nav_first20()}</a>
		<a href="#cadence">{m.docs_cadence_title()}</a>
		<a href="#never">{m.docs_toc_never()}</a>
		<div class="toc-help">
			<div class="toc-help-label">{m.docs_help_label()}</div>
			<p>{m.docs_help_body()}</p>
		</div>
	</aside>
</div>

<style>
	.docs-shell {
		display: grid;
		grid-template-columns: 220px 1fr 220px;
		gap: 28px;
		max-width: 1180px;
		align-items: start;
	}
	.docs-nav {
		position: sticky;
		top: 20px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.nav-group-label {
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 700;
		color: var(--c-muted);
		margin-bottom: 6px;
	}
	.nav-item {
		display: block;
		font-size: 13px;
		color: var(--c-ink);
		text-decoration: none;
		padding: 4px 0;
	}
	.nav-item:hover {
		color: var(--c-teal-dark);
	}
	.nav-item.active {
		color: var(--c-teal-dark);
		font-weight: 600;
	}
	.docs-body {
		min-width: 0;
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
		font-size: 32px;
		margin: 0 0 12px;
		color: var(--c-midnight);
		scroll-margin-top: 20px;
	}
	.lede {
		font-size: 16px;
		line-height: 1.6;
		color: var(--c-ink);
		margin: 0 0 24px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 20px;
		margin: 26px 0 10px;
		color: var(--c-midnight);
		scroll-margin-top: 20px;
	}
	p,
	li {
		font-size: 14px;
		line-height: 1.65;
		color: var(--c-ink);
	}
	ol,
	ul {
		padding-inline-start: 20px;
		margin: 0 0 12px;
	}
	li {
		margin-bottom: 4px;
	}
	a {
		color: var(--c-teal-dark);
	}
	.docs-toc {
		position: sticky;
		top: 20px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.toc-label {
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 700;
		color: var(--c-muted);
		margin-bottom: 4px;
	}
	.docs-toc > a {
		font-size: 12.5px;
		color: var(--c-muted);
		text-decoration: none;
		padding: 3px 0;
	}
	.docs-toc > a:hover {
		color: var(--c-teal-dark);
	}
	.toc-help {
		margin-top: 16px;
		border-top: 1px solid var(--c-border);
		padding-top: 14px;
	}
	.toc-help-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.toc-help p {
		font-size: 12px;
		color: var(--c-muted);
		margin: 6px 0 0;
	}
	@media (max-width: 980px) {
		.docs-shell {
			grid-template-columns: 1fr;
		}
		.docs-nav,
		.docs-toc {
			display: none;
		}
	}
</style>
