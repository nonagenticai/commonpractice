<script lang="ts">
	// the Solution leaderboard — the solution leaderboard (demo `solutions`). A challenge selector
	// scopes the board to one challenge; rows are coral and votable.
	import { onMount } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { page } from '$app/state';
	import { solutionsApi } from '$lib/api/solutions';
	import { challengesApi } from '$lib/api/challenges';
	import type { SolutionList, SolutionRow } from '$lib/types/solutions';
	import type { ChallengeRow } from '$lib/types/challenges';
	import { solutionState, solutionVoteBlockedReason } from '$lib/solutions/solution-state';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Pager from '$lib/components/ui/Pager.svelte';
	import RankBadge from '$lib/components/marketplace/RankBadge.svelte';
	import VoteButton from '$lib/components/marketplace/VoteButton.svelte';
	import * as m from '$lib/paraglide/messages';
	import { demoDuration, num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { errorText } from '$lib/api/error-message';
	import { loadAllChoices, MAX_CHOICE_PAGES } from './choices';

	let challengeChoices = $state<ChallengeRow[]>([]);
	/** The server's real challenge total, and whether the selector had to stop short of it. */
	let choicesTotal = $state(0);
	let choicesCapped = $state(false);
	let selectedChallenge = $state('');
	let list = $state<SolutionList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let voteBusy = $state<Set<string>>(new Set());
	// A REFUSED vote, kept separate from `error` (the load error). `error` renders inside an
	// `{:else if}` chain, so writing a vote failure there would blank the whole board on the list
	// pages and never render at all on the detail pages (guarded by `&& !data`). This one renders
	// above the content and leaves it in place.
	let voteError = $state<string | null>(null);
	let q = $state('');
	let boardPage = $state(1);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);

	/**
	 * The "built with …" fragment for one row, in the READER'S language.
	 *
	 * ⛔ THE DEFECT: this was `row.blocksUsed.slice(0, 3).join(' · ')`, i.e. English hyphenated slugs
	 * (`read-claim-form · ai-summarize`) interpolated into a fully localized sentence, on the board a
	 * Dutch demo opens on. The names are resolved server-side against the block catalogue and the
	 * negotiated locale (`blocksUsedNames`, backend/src/blocks/block-display-names.ts) — the browser
	 * cannot do it here, because the SPA's slug→name store is published only by `/build`'s palette
	 * fetch and is empty on this route.
	 *
	 * ⚠️ `?? `, NOT `||`, AND THE FALLBACK IS THE MID-ROLL WINDOW. An API one roll behind omits
	 * `blocksUsedNames` entirely and this renders the slugs — exactly what it rendered before. An
	 * EMPTY array is a real answer (a solution built with no blocks) and must not fall through, which
	 * is what `||` would do; the `{#if}` at the render site is what decides whether to show the line.
	 */
	function builtWith(row: SolutionRow): string {
		return (row.blocksUsedNames ?? row.blocksUsed).slice(0, 3).join(' · ');
	}

	/**
	 * Why this row's vote pill is inert, or null when it is live.
	 *
	 * ⛔ NO CYCLE IS FETCHED FOR THIS BOARD, DELIBERATELY. `solutionState` can produce a countdown,
	 * but only from the week the SOLUTION competes in — and `SolutionRow` carries no `week` (the
	 * list DTO never had one). So the cycle could not change a single pixel here, and requesting it
	 * would be a round-trip per board load bought for nothing. `''` + `null` therefore lands on the
	 * no-time-claim branch by construction, which is the honest result rather than a placeholder.
	 *
	 * ⛔ THE ONE QUESTION THIS BOARD ASKS — will a vote land? — IS ANSWERED BY `cycleClosed`, NOT BY
	 * `challengeStatus`. It used to read the parent challenge's status, which is a fact about a
	 * different row in a different week: `healOrphanedChallenges` closed any challenge whose own week
	 * was over, so a live entry answering an older challenge rendered an INERT pill while the server
	 * would happily have taken the vote — and, the other way round, an entry in a closed week whose
	 * parent still said `voting` rendered a LIVE pill that 409s. `cycleClosed` is the server's own
	 * gate (`weekClosedSql`), computed per row, so the pill and the endpoint cannot disagree.
	 */
	function voteBlockedFor(row: SolutionRow): string | null {
		return solutionVoteBlockedReason(solutionState(row.status, '', row.cycleClosed, null));
	}

	/**
	 * Generation counter for the choice walk. A locale switch re-runs `loadChoices()` while the
	 * previous walk may still have pages in flight; without this the older walk's `applyChoices`
	 * would land LAST and repaint the selector in the language the reader just left.
	 */
	let choicesRun = 0;

	const fetchChoicePage = (p: number) => challengesApi.list({ sort: 'top', page: p });

	function applyChoices(
		c: { items: ChallengeRow[]; total: number; capped: boolean },
		/**
		 * True for the page-1-only apply below, which carries at most `PAGE_SIZE` of the list. A
		 * PARTIAL list is not evidence that a challenge is gone, so it may not move a selection the
		 * reader made — it may only supply one where there is none. The full walk, arriving as a
		 * second (non-partial) call, is the one allowed to conclude that a selection has vanished.
		 */
		{ partial = false }: { partial?: boolean } = {}
	) {
		challengeChoices = c.items;
		choicesTotal = c.total;
		choicesCapped = c.capped;

		// ⚠️ PRESERVE THE SELECTION ACROSS A RE-LOAD. This unconditionally assigned
		// `fromUrl || items[0].id`, which is right on first mount and wrong on every later call:
		// a locale switch while reading challenge #5 silently pointed the `<select>` at challenge
		// #1 while the table still showed #5's rows — a dropdown and a board naming different
		// challenges. Challenge IDs are stable across locales; only the labels are localized.
		//
		// ⛔ …AND `kept` ALONE WAS NOT ENOUGH, BECAUSE THE LIST ARRIVES IN TWO PIECES. The re-load
		// applies page 1 first (ten rows, so the board can start without waiting for the walk) and
		// the full set second. A reader parked on the eleventh challenge or beyond is absent from
		// that first piece, so `kept` came out `''` and the selection fell to `items[0]` — and
		// `loadBoard()` is awaited on that clobbered value, so a foreign board was fetched. By the
		// time the full list landed, `previous` was already `items[0]`, so nothing could put it
		// back: the reader switched language and silently changed which challenge they were reading.
		// ⚠️ Invisible on the local dev DB, which has six challenges — it needs more than ten.
		// First mount is unaffected: `previous` is `''`, so the `!previous` arm still supplies one.
		const previous = selectedChallenge;
		const kept = c.items.some((i) => i.id === previous) ? previous : '';
		if (kept) selectedChallenge = kept;
		else if (!partial || !previous)
			selectedChallenge = page.url.searchParams.get('challenge_id') || c.items[0]?.id || '';

		// The board a page number belongs to is the CHALLENGE. If the selection actually moved
		// (first load, or the old challenge vanished from the list) a `boardPage` of 3 carried over
		// from the previous board is meaningless and can land on an empty page — and `Pager` renders
		// AFTER the empty-state arms, so there would be no control left to page back with. Pinned
		// at the one place that can move the selection, not at each of its callers.
		if (selectedChallenge !== previous) boardPage = 1;
	}

	async function loadChoices() {
		const run = ++choicesRun;
		try {
			// ⚠️ PAGE THE WHOLE SET. This used to be one `challengesApi.list({sort:'top'})`, and that
			// route pages at ten — so with sixteen challenges six leaderboards could not be selected
			// at all. `loadAllChoices` walks the pages and, if it hits its cap, says so (rendered
			// below): silently showing a truncated list is the defect, not the workaround.
			//
			// …but the BOARD must not wait for that walk. The walk is serial and capped at 20
			// requests, so a 200-challenge corpus meant twenty blocking round-trips before the board
			// request was even issued — several seconds of `solutions_loading` on a page that only
			// needs `items[0].id` to start. Page 1 is awaited (it carries the default selection);
			// the remaining pages are folded in behind the reader's back.
			const first = await fetchChoicePage(1);
			if (run !== choicesRun) return;
			// `capped: false` while the walk is still running — the note names a SHORTFALL, and
			// flashing "the selector lists 10 of 16" at every reader with eleven challenges would be
			// crying wolf about a list that is one round-trip from complete.
			applyChoices({ items: first.items, total: first.total, capped: false }, { partial: true });

			void (async () => {
				try {
					const rest = await loadAllChoices(fetchChoicePage, MAX_CHOICE_PAGES, first);
					// A newer load (locale switch) superseded this walk — its result is stale copy.
					if (run !== choicesRun) return;
					applyChoices(rest);
				} catch (e) {
					// A failure HERE must not blank a board that already rendered — it only means the
					// selector is short, which is precisely what the note exists to say. Silently
					// keeping `capped: false` would restore the truncated-and-says-nothing selector.
					console.warn('[solutions] challenge selector could not be fully paged', e);
					if (run !== choicesRun) return;
					choicesCapped = challengeChoices.length < choicesTotal;
				}
			})();
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		}
	}

	async function loadBoard() {
		if (!selectedChallenge) {
			list = { items: [], total: 0, page: 1, pageSize: 10, challenge: null };
			loading = false;
			return;
		}
		loading = true;
		error = null;
		try {
			// `page` and `q` both go to the SERVER. The search used to be a client-side `.filter()`
			// over the ten rows already loaded, so a builder at rank 14 was reported as "no match" by
			// a box that had never seen their row.
			list = await solutionsApi.list({
				challengeId: selectedChallenge,
				q: q.trim() || undefined,
				page: boardPage
			});
			// A page past the end of the board (rows deleted under the reader, or a `boardPage`
			// carried across a reload) renders the EMPTY state — and `Pager` sits after the
			// empty-state arms in the markup, so the reader is left on a blank board with no control
			// to page back with. Clamp once and re-ask; `boardPage` is 1 on the retry, so this can
			// never recurse further.
			if (list.items.length === 0 && boardPage > 1) {
				boardPage = 1;
				await loadBoard();
				return;
			}
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	function onSelect() {
		boardPage = 1;
		loadBoard();
	}

	function goPage(p: number) {
		boardPage = Math.min(Math.max(1, p), totalPages);
		loadBoard();
	}

	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			boardPage = 1;
			loadBoard();
		}, 250);
	}

	async function vote(row: SolutionRow) {
		if (voteBusy.has(row.id) || !list) return;
		voteBusy = new Set(voteBusy).add(row.id);
		voteError = null;
		const next = !row.hasVoted;
		const wasVoted = row.hasVoted;
		const wasCount = row.votesCount;
		list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: next, votesCount: r.votesCount + (next ? 1 : -1) } : r)) };
		try {
			const res = next ? await solutionsApi.vote(row.id) : await solutionsApi.unvote(row.id);
			list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: res.voted, votesCount: res.count } : r)) };
		} catch (e) {
			// ⛔ REVERT FIRST, RECONCILE SECOND — see the long note on `vote()` in
			// routes/challenges/+page.svelte. The loader's own catch writes only `error`, so
			// delegating the repair to it leaves the phantom count on screen for exactly the outage
			// that fails both calls. Captured values, not a recomputation; the row, not the list.
			if (list) list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: wasVoted, votesCount: wasCount } : r)) };
			// See challenges/+page.svelte: a silently-reverted vote reads as a dead button, and the
			// page's `error` state is the LOAD error — reusing it blanks the content.
			voteError = errorText(e, m.error_action_failed());
			await loadBoard();
		} finally {
			const s = new Set(voteBusy);
			s.delete(row.id);
			voteBusy = s;
		}
	}

	/** The page's whole load path, in order. Mount, the locale switch and the retry control all go
	 *  through it, so the button in the error notice re-runs exactly what failed. */
	async function reload() {
		// ⛔ CLEARED HERE, AT THE TOP OF THE PATH, and not inside either step. `loadChoices` never
		// clears it and `loadBoard` clears it only AFTER its `if (!selectedChallenge) return` — so a
		// recovered load that finds no challenges left the previous failure sitting over a board that
		// had just been fetched successfully. Clearing it inside `loadBoard`'s early return instead
		// would erase a live `loadChoices` failure, which is the one message that path must keep.
		error = null;
		await loadChoices();
		await loadBoard();
	}

	onMount(reload);
	// Re-fetch localized content (board titles + selector labels) on locale switch.
	//
	// ⚠️ SEQUENCED, NOT FIRE-AND-FORGET. These were two bare `void` calls, so `loadBoard()` raced
	// `loadChoices()` and usually won — the board was re-fetched for whatever `selectedChallenge`
	// held BEFORE the selector had been rebuilt, and then nothing re-fired it once the selector
	// settled. Combined with the old unconditional `selectedChallenge = items[0].id` that left the
	// dropdown and the table naming different challenges. `loadChoices` now resolves the selection
	// first (preserving it where it still exists, resetting `boardPage` where it does not) and the
	// board is fetched against the settled value.
	reloadOnLocaleChange(() => {
		void reload();
	});
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow coral">{m.solutions_eyebrow()}</div>
			<h1>{m.solutions_title()}</h1>
			<p>{m.solutions_lede()}</p>
		</div>
		<div class="head-actions">
			<a class="btn-coral" href="/build">{m.solutions_start()}</a>
			<a class="btn-ghost" href="/winner">{m.solutions_past_winners()}</a>
		</div>
	</header>

	<div class="selector">
		<label for="ch">{m.solutions_selector_label()}</label>
		<select id="ch" bind:value={selectedChallenge} onchange={onSelect}>
			{#each challengeChoices as c (c.id)}
				<option value={c.id}>{c.code ? `${c.code} — ` : ''}{c.title} ({c.submitter.name})</option>
			{/each}
		</select>
		<input class="search" type="search" placeholder={m.solutions_search_placeholder()} bind:value={q} oninput={onSearch} aria-label={m.solutions_search_placeholder()} />
	</div>

	{#if choicesCapped}
		<!-- The selector stopped short of the full set. Name the real total and point at the page
		     that can reach the rest — a truncated list that says nothing is the bug being fixed. -->
		<div class="notice capped" role="status">
			{m.solutions_selector_capped({ shown: num(challengeChoices.length, locale.current), total: num(choicesTotal, locale.current) })}
			<a href="/challenges">{m.nav_challenges()}</a>
		</div>
	{/if}

	{#if voteError}
		<div class="notice error">{voteError}</div>
	{/if}

	{#if loading && !list}
		<div class="notice">{m.solutions_loading()}</div>
	{:else if error}
		<div class="notice error" role="alert">
			<span>{error}</span>
			<!-- ⛔ THE COPY NAMES AN ACTION; THIS IS THE CONTROL THAT PERFORMS IT. `error_load_failed`
			     reads "We couldn't load that. Please try again." and this arm replaces the whole page,
			     so a failed first load was a dead end with no exit but F5. Same sentence-plus-button
			     shape as the profile-error row in +layout.svelte, except this one re-runs the page's own
			     loader rather than reloading the app. -->
			<button class="retry" onclick={reload}>{m.error_load_retry()}</button>
		</div>
	{:else if list && list.items.length === 0 && q.trim()}
		<!-- A no-match SEARCH is not an empty board. The single empty state below told a searcher
		     "no solutions yet — go build one" while the challenge had fourteen of them. -->
		<div class="notice">{m.solutions_no_match()}</div>
	{:else if list && list.items.length === 0}
		<div class="notice">{m.solutions_empty_pre()}<a href="/build">{m.solutions_empty_link()}</a>{m.solutions_empty_after()}</div>
	{:else if list}
		<div class="board" class:dim={loading}>
			{#each list.items as row (row.id)}
				<div class="sol-row">
					<a class="sol-main" href={`/solutions/${row.id}`}>
						<RankBadge rank={row.rank} variant="coral" />
						<div class="sol-body">
							<div class="sol-title">{row.title}</div>
							<div class="sol-meta">
								<span>{row.author.name}</span>
								<!-- ⛔ `!= null`, NOT TRUTHINESS. This was `{#if row.demoSeconds}`, which is false for
								     THREE different facts and shows the row for none of them: a null (the value
								     for every solution a real person submitted, because the column was a seeded
								     constant), a genuine 0, and the absence of the field entirely. `demoMs` is a
								     measured duration — a sub-millisecond run is a real answer and gets rendered.
								     The unit is picked here, not on the wire; see `demoDuration`. -->
								{#if row.demoMs != null}<span>·</span><span>{m.solutions_live_demo({ duration: demoDuration(row.demoMs, locale.current) })}</span>{/if}
								<!-- The GUARD reads `blocksUsed` (always present); the TEXT reads the resolved
								     names — see `builtWith`. -->
								{#if row.blocksUsed.length}<span>·</span><span class="built">{m.solutions_built_with({ blocks: builtWith(row) })}</span>{/if}
							</div>
						</div>
					</a>
					<div class="sol-side">
						<Avatar initials={row.author.initials} size={28} />
<!-- The SERVER'S OWN VOTE GATE rides on the row (`cycleClosed`, added to the list DTO for
						     exactly this): has the cycle THIS SOLUTION competes in closed?
						     ⛔ DO NOT swap it for `row.status`: `closeCycle` leaves every non-winning solution
						     at `voting` forever, so the row's own column marks the losers of every closed week
						     as still open.
						     ⛔ DO NOT swap it back for `row.challengeStatus` either — that was the rule until
						     this change, and it is a fact about a different row in a different week. It made
						     the only entry in prod's live 2026-W33 week render inert (its 2026-W23 parent had
						     been healed shut), which is how nine consecutive weeks closed with no winner.
						     A missing `cycleClosed` (mid-roll) answers "unknown" — an inert pill that says so,
						     never a live one on an unverified row. -->
						<VoteButton variant="coral" size="sm" count={row.votesCount} voted={row.hasVoted} busy={voteBusy.has(row.id)} blockedReason={voteBlockedFor(row)} onToggle={() => vote(row)} />
					</div>
				</div>
			{/each}
		</div>

		<Pager page={boardPage} {totalPages} shown={list.items.length} total={list.total} onPage={goPage} />

		<div class="cta">
			<div>
				<b>{m.solutions_cta_title()}</b>
				<p>{m.solutions_cta_body()}</p>
			</div>
			<a class="btn-coral" href="/build">{m.solutions_cta_link()}</a>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1100px;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal-dark);
		margin-bottom: 8px;
	}
	.eyebrow.coral {
		color: var(--c-coral-dark);
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		margin: 0 0 6px;
		color: var(--c-midnight);
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
		max-width: 620px;
	}
	.head-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}
	.btn-coral {
		background: var(--c-coral);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		white-space: nowrap;
		text-decoration: none;
		border: none;
	}
	.btn-ghost {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		color: var(--c-ink);
		font-weight: 500;
		font-size: 13px;
		padding: 9px 14px;
		border-radius: var(--r);
		white-space: nowrap;
		text-decoration: none;
	}
	.selector {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 16px;
	}
	.selector label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.selector select {
		font-size: 13px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
		max-width: 520px;
		flex: 1;
	}
	.selector .search {
		font-size: 13px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
		min-width: 180px;
	}
	.selector .search::placeholder {
		color: var(--c-muted);
	}
	.board {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		overflow: hidden;
		transition: opacity 0.12s;
	}
	.board.dim {
		opacity: 0.6;
	}
	.sol-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--c-border);
	}
	.sol-row:last-child {
		border-bottom: none;
	}
	.sol-main {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: inherit;
	}
	.sol-body {
		min-width: 0;
	}
	.sol-title {
		font-size: 14.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.sol-main:hover .sol-title {
		color: var(--c-coral-dark);
	}
	.sol-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 12px;
		color: var(--c-muted);
		margin-top: 4px;
	}
	.built {
		font-family: var(--font-mono);
		font-size: 11px;
	}
	.sol-side {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}
	.cta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-lg);
		padding: 18px 22px;
		margin-top: 18px;
	}
	.cta b {
		font-size: 15px;
		color: var(--c-coral-dark);
		font-family: var(--font-display);
	}
	.cta p {
		font-size: 12.5px;
		color: var(--c-ink);
		margin: 4px 0 0;
		max-width: 560px;
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
	.notice a {
		color: var(--c-coral-dark);
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
	.notice.capped {
		padding: 10px 14px;
		text-align: start;
		font-size: 12.5px;
		margin-bottom: 12px;
	}
	.notice.capped a {
		margin-inline-start: 6px;
	}
	@media (max-width: 720px) {
		.page-head {
			flex-direction: column;
		}
		.sol-side :global(.avatar) {
			display: none;
		}
		/* the selector row wraps: a 180px search beside a select overflowed a 390px screen */
		.selector { flex-wrap: wrap; }
		.selector select, .selector .search { min-width: 0; width: 100%; max-width: none; flex: 1 1 100%; }
	}
</style>
