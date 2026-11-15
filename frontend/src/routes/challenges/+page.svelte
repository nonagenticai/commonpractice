<script lang="ts">
	// the Challenge leaderboard — the challenge leaderboard (demo `challenges`). Domain chips + sort,
	// votable rows, pagination. Voting toggles optimistically against the API.
	import { onMount } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { challengesApi } from '$lib/api/challenges';
	import { cycleApi } from '$lib/api/cycle';
	import type { ChallengeList, ChallengeRow, ChallengeSort } from '$lib/types/challenges';
	import type { CycleState } from '$lib/types/cycle';
	import LeaderboardRow from '$lib/components/marketplace/LeaderboardRow.svelte';
	import * as m from '$lib/paraglide/messages';
	import { WORK_AREAS, workAreaLabel } from '$lib/i18n/work-area-label';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { errorText } from '$lib/api/error-message';

	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	// ⛔ THE THIRD COPY OF THE WORK-AREA VOCABULARY, DELETED. This table listed the same eight
	// values against the same eight `domain_*` keys that `$lib/i18n/work-area-label.ts` owns —
	// and it was the copy that mattered most, because `LeaderboardRow` renders `workAreaLabel`
	// for every row an inch BELOW these chips. Repointing one `labelKey` here (Ops → domain_it)
	// put two different words for one value in a single viewport with the whole suite green.
	//
	// ⚠️ THE SENTINEL IS WHY THIS IS A LOCAL COMPOSITION AND NOT A BARE `workAreaLabel` CALL.
	// `'All domains'` is this screen's filter sentinel — it is not a work area, is never sent as
	// one, and `workAreaLabel` deliberately refuses it a case (see the ⛔ note at the bottom of
	// that file) so nobody widens the enum by one non-value. So the sentinel keeps its own key
	// here and every REAL work area delegates. The values still come from `WORK_AREAS`, so a
	// ninth work area added in the backend appears on this filter without touching this file.
	const DOMAIN_ALL = 'All domains';
	const DOMAINS: string[] = [DOMAIN_ALL, ...WORK_AREAS];
	/** The chip's visible text. The sentinel is this screen's own word; the rest are the product's. */
	function domainLabel(v: string): string {
		return v === DOMAIN_ALL ? m.domain_all() : workAreaLabel(v);
	}
	const SORTS: { k: ChallengeSort; labelKey: string }[] = [
		{ k: 'top', labelKey: 'challenges_sort_top' },
		{ k: 'newest', labelKey: 'challenges_sort_newest' },
		{ k: 'trending', labelKey: 'challenges_sort_trending' },
		{ k: 'closing', labelKey: 'challenges_sort_closing' }
	];

	let list = $state<ChallengeList | null>(null);
	// The live weekly cycle, handed down to every row so a challenge's status pill can be dated
	// against a real clock instead of the fixed "closes Thu 18:00" the catalog used to carry. Null
	// is a NORMAL value, not a failure: `/api/cycle/current` returns null whenever the engine has
	// not opened a row for the current ISO week, which is what prod answers today.
	let cycle = $state<CycleState | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let domain = $state('All domains');
	/**
	 * ⛔ THE BOARD DEFAULTS TO THE CHALLENGES THAT ARE STILL ACCEPTING WORK. Measured on the default
	 * board before this: rows 1-5 all read "Voting week finished" (284/241/203/178/162 all-time
	 * votes), the only live challenge was row SIX, and the chip row offered domains only — no status
	 * filter existed anywhere. Sorting by `top` is sorting by ALL-TIME votes, so the dead back
	 * catalogue permanently outranks the week that is actually open, and the first thing a visitor
	 * can act on is below the fold.
	 *
	 * The route's own default stays "everything" and must (the back catalogue is a real history, and
	 * `open` as a route default empties every 2026-W21 fixture in the backend suite). This is the
	 * BOARD's default, opted in per request, with an "All" chip that drops it — an explicit product
	 * decision.
	 */
	let openOnly = $state(true);
	/**
	 * How many rows the SAME board would hold with the liveness filter dropped — measured, not
	 * assumed, and `null` until it has been.
	 *
	 * ⛔ WHY A SECOND REQUEST AND NOT `list.counts.all`. `counts` is computed by the route UNDER the
	 * active filter (backend/src/routes/challenges.ts: the `open` predicate is applied to the counts
	 * query as well as the rows query, deliberately, so the chips always sum to `total`). On the
	 * empty live board `counts.all` is therefore ZERO — it is the open total wearing the word "all".
	 * Rendering it would put a hard "(0)" next to an offer to show seven challenges.
	 *
	 * ⛔ AND IT IS NOT A CONSTANT. Measured in prod: all seven `fr-test` challenges are
	 * `status='closed'` with a newest week of `2026-W33` against a live cycle of `2026-W35`, so the
	 * live board is empty and the back catalogue is seven. Next week it is eight. A figure typed
	 * into the catalog would be wrong on its second Monday.
	 *
	 * ⚠️ ONLY FETCHED WHEN IT CAN BE RENDERED — the open board came back empty and no search term is
	 * narrowing it (a no-match search is a different, older empty state and wins the `{#if}` chain
	 * above). Every other load leaves this `null` and costs nothing.
	 */
	let allBoardTotal = $state<number | null>(null);
	let sort = $state<ChallengeSort>('top');
	let page = $state(1);
	let q = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let voteBusy = $state<Set<string>>(new Set());
	// A REFUSED vote, kept separate from `error` (the load error). `error` renders inside an
	// `{:else if}` chain, so writing a vote failure there would blank the whole board on the list
	// pages and never render at all on the detail pages (guarded by `&& !data`). This one renders
	// above the content and leaves it in place.
	let voteError = $state<string | null>(null);

	const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);

	// Any domain present in the counts that isn't one of the canonical chips (legacy/off-list
	// work_area, e.g. CH-243). Render it as its own chip so the per-domain chips always sum to
	// the "All domains" total — the count can never silently disappear into "All".
	const KNOWN_DOMAINS = new Set(DOMAINS);
	const extraDomains = $derived(
		list
			? Object.keys(list.counts)
					.filter((k) => k !== 'all' && !KNOWN_DOMAINS.has(k) && (list!.counts[k] ?? 0) > 0)
					.sort()
			: []
	);

	function countFor(d: string): number {
		if (!list) return 0;
		return d === 'All domains' ? (list.counts.all ?? 0) : (list.counts[d] ?? 0);
	}

	/**
	 * Monotonic request generation. Captured at the top of every `load()`; any result whose token is
	 * no longer the current one is DISCARDED rather than written to state.
	 *
	 * ⛔ WHY, MEASURED. An adversarial verifier forced this interleave: the board loads empty for
	 * `workArea=Claims`, its "how much is hidden" probe is issued but still in flight, the reader
	 * clicks a different domain chip (`domain` flips synchronously and a NEW load starts), and then
	 * the STALE Claims probe resolves and sets `allBoardTotal`. The notice then offered "toon alle
	 * (N)" where N was counted under Claims while the active chip read something else — and clicking
	 * it fetched the NEW domain. The number and the click disagreed.
	 *
	 * ⛔ AND IT GUARDS `list`, NOT JUST THE PROBE. Two concurrent loads racing into `list` is the
	 * older, larger half of the same bug — whichever settles last wins, so a slow-then-fast pair
	 * leaves the earlier response on screen. `load-error-retry.render.test.ts` documents that hazard
	 * in its own comment and pins the retry path against it; this closes the domain/sort/page paths
	 * it could not reach. Guarding only the probe would have fixed the symptom the verifier happened
	 * to reproduce and left the cause.
	 */
	let loadToken = 0;

	async function load() {
		const token = ++loadToken;
		loading = true;
		error = null;
		try {
			// ⛔ THE CYCLE IS NOT ALLOWED TO TAKE THE BOARD DOWN WITH IT. `.catch(() => null)` inside
			// the Promise.all, not around it: the cycle only decorates the rows (countdown / week
			// staleness), so a 500 or a network blip there must degrade to the plain status labels —
			// exactly the same path a legitimately null cycle takes — and never into the page's
			// `error` state, which replaces the whole leaderboard.
			const [nextList, nextCycle] = await Promise.all([
				challengesApi.list({ workArea: domain === 'All domains' ? undefined : domain, sort, page, q: q.trim() || undefined, open: openOnly || undefined }),
				cycleApi.current().catch(() => null)
			]);
			if (token !== loadToken) return; // superseded — a newer load owns the screen
			[list, cycle] = [nextList, nextCycle];
			// ⛔ THE EMPTY-STATE FIGURE IS MEASURED HERE, ON THE ONE PATH THAT CAN RENDER IT. The
			// notice below offers to widen the filter and says how much is behind it; that number has
			// to be the number the reader will actually get after clicking, so it is the SAME query
			// with `open` dropped — same work area, same sort, page 1 (the notice replaces the pager).
			//
			// ⛔ AND IT DECIDES *WHETHER* THE NOTICE RENDERS AT ALL, not just what it says. A board
			// that is empty on BOTH sides has nothing hidden, and "show all (0)" would be the product
			// inventing content to apologise for. Zero falls through to the generic empty state.
			//
			// ⚠️ `.catch(() => null)` for the same reason the cycle has one: this is decoration on an
			// already-successful load. A failed probe must degrade to the generic empty state, never
			// blank the page through `error`.
			allBoardTotal = null;
			if (openOnly && nextList.items.length === 0 && !q.trim()) {
				const hidden = await challengesApi
					.list({ workArea: domain === 'All domains' ? undefined : domain, sort, page: 1 })
					.then((r) => r.total)
					.catch(() => null);
				if (token !== loadToken) return; // the chip moved while we were counting — drop it
				allBoardTotal = hidden;
			}
		} catch (e) {
			// A superseded load's failure is not this screen's failure — dropping it stops an older,
			// slower request from painting an error over rows a newer one already delivered.
			if (token !== loadToken) return;
			error = errorText(e, m.error_load_failed());
		} finally {
			// ⚠️ Only the load that still owns the screen may clear the spinner. A superseded load
			// returning here would switch it off while its successor is still in flight.
			if (token === loadToken) loading = false;
		}
	}

	function setDomain(d: string) {
		domain = d;
		page = 1;
		load();
	}
	/** The live/all toggle. `page = 1` for the same reason every other filter resets it: the pager's
	 *  page 4 does not exist in a set five rows long. */
	function setOpenOnly(v: boolean) {
		if (openOnly === v) return;
		openOnly = v;
		page = 1;
		load();
	}
	function setSort(s: ChallengeSort) {
		sort = s;
		page = 1;
		load();
	}
	function goPage(p: number) {
		page = Math.min(Math.max(1, p), totalPages);
		load();
	}
	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			load();
		}, 250);
	}

	async function vote(row: ChallengeRow) {
		if (voteBusy.has(row.id) || !list) return;
		voteBusy = new Set(voteBusy).add(row.id);
		voteError = null;
		// optimistic
		const next = !row.hasVoted;
		const wasVoted = row.hasVoted;
		const wasCount = row.votesCount;
		list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: next, votesCount: r.votesCount + (next ? 1 : -1) } : r)) };
		try {
			const res = next ? await challengesApi.vote(row.id) : await challengesApi.unvote(row.id);
			list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: res.voted, votesCount: res.count } : r)) };
		} catch (e) {
			// Say why. A rejected vote (403 self_vote_not_allowed is the common one) used to revert
			// the optimistic count with no message and no console line, which reads as a dead button.
			// Deliberately NOT the page's `error` state: that one is the LOAD error and sits in an
			// `{:else if}` chain, so reusing it would either blank the whole board or (on the detail
			// pages, guarded by `&& !data`) never render at all.
			// ⛔ REVERT THE OPTIMISTIC ROW *BEFORE* RECONCILING. This is the defect commit 670a567
			// fixed in `lib/stores/notifications.svelte.ts`, one file over: the sole repair for a
			// failed write was a call to the loader, and the loader's OWN catch writes only `error` —
			// it never touches `list`. So on the failure that actually happens in the field (offline,
			// or a session that expired mid-click, where the vote POST and the follow-up list GET fail
			// together) the phantom `votesCount + 1` SURVIVED, under a banner saying the vote was
			// refused. A reader who is told "that did not work" and shown a count that says it did
			// believes the count. `await load()` is kept — the server is still the authority, and the
			// POST may have succeeded with only its response lost — but it runs AFTER the local
			// revert, never INSTEAD of it.
			//
			// ⚠️ A CAPTURE, NOT A RECOMPUTATION. `wasVoted`/`wasCount` are read before the optimistic
			// write; undoing by `-(next ? 1 : -1)` would re-derive a number from whatever the field
			// holds now, and a concurrent reconcile landing inside the in-flight window makes that
			// number an invention. `row` is never mutated (the map builds new objects), so the capture
			// is stable.
			//
			// ⚠️ THE ROW, NOT THE WHOLE LIST. Several rows can be in `voteBusy` at once; restoring a
			// snapshot of `list` would also roll back a sibling vote that is still in flight or has
			// already landed.
			if (list) list = { ...list, items: list.items.map((r) => (r.id === row.id ? { ...r, hasVoted: wasVoted, votesCount: wasCount } : r)) };
			voteError = errorText(e, m.error_action_failed());
			await load(); // reconcile on failure — the revert above is what holds when this fails too
		} finally {
			const s = new Set(voteBusy);
			s.delete(row.id);
			voteBusy = s;
		}
	}

	onMount(() => {
		// Honor ?work_area= / ?sort= / ?q= / ?open= deep-links (e.g. from a challenge's work-area chip).
		const sp = new URLSearchParams(window.location.search);
		const wa = sp.get('work_area');
		if (wa && DOMAINS.includes(wa)) domain = wa;
		// ⛔ ONLY THE "All" SIDE IS DEEP-LINKABLE, and the asymmetry is on purpose: live is the
		// DEFAULT, so `?open=true` is a no-op and an absent param must never be read as "show me the
		// dead ones". Three spellings because this is the escape hatch a human types by hand, and a
		// `?open=false` that silently did nothing would be the product ignoring an instruction.
		const openParam = sp.get('open');
		if (openParam === 'all' || openParam === 'false' || openParam === '0') openOnly = false;
		const srt = sp.get('sort');
		if (srt && SORTS.some((s) => s.k === srt)) sort = srt as ChallengeSort;
		const term = sp.get('q');
		if (term) q = term;
		load();
	});
	reloadOnLocaleChange(load);
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.challenges_eyebrow()}</div>
			<h1>{m.challenges_title()}</h1>
			<p>{m.challenges_lede()}</p>
		</div>
		<div class="head-actions">
			<a class="btn-primary" href="/submit">{m.challenges_submit()}</a>
			<a class="btn-ghost" href="/docs">{m.challenges_how_voting()}</a>
		</div>
	</header>

	<div class="filter-bar">
		<!-- The liveness filter, in its OWN chip group. Same `.chip` / `.chip.active` markup as the
		     domain chips below — no new CSS, because there is no shared chip primitive to extend and
		     inventing a second visual language for a second filter is how a filter bar stops reading
		     as one control. Two groups rather than nine+two in one row: these are a different AXIS
		     (is it open) from the domains (what is it about), and mixing them makes "Open" look like
		     a tenth domain. ⛔ NO `.chip-count` here — `counts` is computed under whichever filter is
		     active, so an "All" count next to an active "Open" chip would be the open total wearing
		     the wrong label. -->
		<div class="chips">
			<button class="chip" class:active={openOnly} onclick={() => setOpenOnly(true)}>
				{m.challenges_filter_open()}
			</button>
			<button class="chip" class:active={!openOnly} onclick={() => setOpenOnly(false)}>
				{m.challenges_filter_all()}
			</button>
		</div>
		<div class="chips">
			<!-- The chip VALUE stays the enum: `setDomain` writes it to `?work_area=` and
			     `countFor` keys `list.counts[…]` off the same literals. Only the text is a word. -->
			{#each DOMAINS as d (d)}
				<button class="chip" class:active={domain === d} onclick={() => setDomain(d)}>
					{domainLabel(d)} <span class="chip-count">{num(countFor(d), locale.current)}</span>
				</button>
			{/each}
			<!-- ⚠️ `extra`, NOT `d`. Both loops used to bind `d`, and once the canonical chip stopped
			     saying `d.v` the two rows became BYTE-IDENTICAL markup — which collapsed two entries
			     in icu-number-params.sites.test.ts onto one string and cost that guard its ability to
			     say which chip it had verified. An off-list domain also has no catalog key by
			     definition (that is what makes it off-list), so it renders raw on purpose. -->
			{#each extraDomains as extra (extra)}
				<button class="chip" class:active={domain === extra} onclick={() => setDomain(extra)}>
					{extra} <span class="chip-count">{num(countFor(extra), locale.current)}</span>
				</button>
			{/each}
		</div>
		<div class="filter-right">
			<input class="search" type="search" placeholder={m.challenges_search_placeholder()} bind:value={q} oninput={onSearch} aria-label={m.challenges_search_placeholder()} />
			<select class="sort" bind:value={sort} onchange={() => setSort(sort)} aria-label={m.challenges_sort_label()}>
				{#each SORTS as s (s.k)}<option value={s.k}>{m.challenges_sort_prefix({ label: mm[s.labelKey]() })}</option>{/each}
			</select>
		</div>
	</div>

	{#if voteError}
		<div class="notice error">{voteError}</div>
	{/if}

	{#if loading && !list}
		<div class="notice">{m.challenges_loading()}</div>
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
	{:else if list && list.items.length === 0 && q.trim()}
		<!-- A no-match SEARCH is not an empty board. The single empty state below told a searcher
		     "no challenges in this view yet" while the domain chip beside them counted 40 — the same
		     defect `/solutions` fixed with `solutions_no_match`. -->
		<div class="notice">{m.challenges_no_match()}</div>
	{:else if list && list.items.length === 0 && openOnly && (allBoardTotal ?? 0) > 0}
		<!-- ⛔ THE THIRD EMPTY STATE, AND IT IS THE COMMON ONE — not a corner. The live board shows
		     exactly ONE row on a fresh dev seed, and can show ZERO in prod too: `openOnly` filters to
		     `status <> 'closed'`, and a tenant whose whole catalogue is still legacy `closed` rows —
		     written before this codebase stopped closing challenges on the calendar — lands here with
		     an empty open board and a nonzero back catalogue behind it (that is what `allBoardTotal`
		     below is measuring). The generic `challenges_empty` ("No challenges in this view yet") would
		     be the product lying
		     for the third time on this screen: there are forty, and this reader has just been shown
		     none of them by a filter that is on BY DEFAULT and that they never chose.
		     So: name the reason, offer the two real moves — start one, or widen the filter — and make
		     the second of them the All chip's own handler rather than a description of where to click.

		     ⛔ AND THE OFFER CARRIES ITS OWN SIZE. "Show all challenges" is an offer with no stated
		     value: a reader who has just been shown nothing has no reason to believe a second click
		     shows anything either, and the honest answer to "why is this page blank" is the count that
		     is being withheld. `allBoardTotal` is a real second query (see load()), never `counts.all`
		     — which is computed under this very filter and reads 0 here — and the branch condition
		     above is what guarantees the figure is greater than zero before it is offered. -->
		<div class="notice">
			{m.challenges_empty_open()}
			<a href="/submit">{m.challenges_submit()}</a>
			<button class="chip" onclick={() => setOpenOnly(false)}>{m.challenges_empty_open_all({ count: num(allBoardTotal ?? 0, locale.current) })}</button>
		</div>
	{:else if list && list.items.length === 0}
		<div class="notice">{m.challenges_empty()}</div>
	{:else if list}
		<div class="board" class:dim={loading}>
			{#each list.items as row (row.id)}
				<LeaderboardRow {row} busy={voteBusy.has(row.id)} {cycle} onVote={vote} />
			{/each}
		</div>
		{#if totalPages > 1}
			<div class="pager">
				<span>{m.challenges_pager_showing({ shown: num(list.items.length, locale.current), total: num(list.total, locale.current) })}</span>
				<div class="pager-btns">
					<button class="btn-sm" disabled={page <= 1} onclick={() => goPage(page - 1)}>{m.challenges_pager_prev()}</button>
					<span>{m.challenges_pager_page({ page, totalPages })}</span>
					<button class="btn-sm" disabled={page >= totalPages} onclick={() => goPage(page + 1)}>{m.challenges_pager_next()}</button>
				</div>
			</div>
		{/if}
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
		margin-bottom: 20px;
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
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		white-space: nowrap;
		text-decoration: none;
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
	.filter-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}
	.chips {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.chip {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-muted);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 6px 12px;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.chip.active {
		background: var(--c-midnight);
		color: #fff;
		border-color: var(--c-midnight);
	}
	.chip-count {
		font-size: 11px;
		opacity: 0.7;
	}
	.filter-right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.search {
		font-size: 12.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
		min-width: 200px;
	}
	.search::placeholder {
		color: var(--c-muted);
	}
	.sort {
		font-size: 12.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
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
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.pager-btns {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.btn-sm {
		font-size: 12px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 5px 11px;
		border-radius: var(--r);
	}
	.btn-sm:disabled {
		opacity: 0.45;
		cursor: not-allowed;
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
	@media (max-width: 720px) {
		.page-head {
			flex-direction: column;
		}
	}
</style>
