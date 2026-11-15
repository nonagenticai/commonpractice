<script lang="ts">
	// Building blocks library — the `blocks` screen (demo.html:3406–3688).
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { blocksApi } from '$lib/api/blocks';
	import { CATEGORY_META, categoryLabel, blockStatusLabel, type BlockCategory, type BlockListItem } from '$lib/types/blocks';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import { errorText } from '$lib/api/error-message';
	import { canReachNav } from '$lib/layout/navConfig';
	import { auth } from '$lib/stores/auth.svelte';
	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	// ⛔ THE LIBRARY OFFERED "New block" TO EVERY MEMBER. `/block-edit` with no ?slug IS the
	// create-new form, and `POST /api/blocks` is `requireBlockAuthor` (routes/blocks.ts:561) — so a
	// member who took the offer landed on a form whose only button 403s. The nav table ALREADY
	// refuses that href to a member (navConfig.ts:130, with the reasoning spelled out beside it),
	// which means this screen was defeating a gate the product had deliberately set.
	// ⚠️ `canReachNav`, not `auth.isDeveloper`: spelling the role here would put the same fact in a
	// second place, and the next time /block-edit's guard moves one of the two would be left behind.
	// Same argument as the home page's pipeline StatCard — see the canReachNav docstring.
	const canAuthorBlocks = $derived(canReachNav('/block-edit', auth.user?.roles ?? []));

	let items = $state<BlockListItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	type Filter = BlockCategory | 'all';
	let activeCategory = $state<Filter>('all');
	let sort = $state<'usage' | 'recent' | 'alpha'>('usage');
	let q = $state('');

	const CATEGORIES: { key: Filter; labelKey: string }[] = [
		{ key: 'all', labelKey: 'blocks_cat_all' },
		{ key: 'data', labelKey: 'blocks_cat_data' },
		{ key: 'ai', labelKey: 'blocks_cat_ai' },
		{ key: 'logic', labelKey: 'blocks_cat_logic' },
		{ key: 'output', labelKey: 'blocks_cat_output' },
		{ key: 'ui', labelKey: 'blocks_cat_ui' }
	];

	function matchesTerm(i: BlockListItem, term: string): boolean {
		return (
			!term ||
			i.name.toLowerCase().includes(term) ||
			i.slug.toLowerCase().includes(term) ||
			(i.description ?? '').toLowerCase().includes(term)
		);
	}

	// ⛔ THE CHIPS AND THE GRID MUST COUNT THE SAME ROWS. `countFor` used to count over the raw
	// `items` while `filtered` applied BOTH the category AND the search term, and `load()` sends
	// only `sort` — `q` never reaches the server, so nothing else narrowed `items`. Type `zzz` and
	// the grid emptied while the chips went on reading "All 40 · Data 12", and clicking the chip
	// that promised 12 landed on `blocks_no_match`. A count is a promise about what a click will
	// show; these two disagreed on the same screen.
	//
	// ⚠️ THE SEARCH TERM IS APPLIED HERE, THE CATEGORY IS NOT, and that asymmetry is the whole
	// point — not an oversight to "finish". Each chip must answer "how many of MY category survive
	// the current search", which is a different question per chip; folding `activeCategory` in as
	// well would make every inactive chip read 0 and destroy the only navigation out of a filter.
	// `/challenges` reaches the same answer server-side by passing `q` to its counts query
	// (backend/src/routes/challenges.ts:365) — same idiom, and it is the one that was right.
	//
	// Client-side on purpose: the library is small and `load()` deliberately fetches it whole (see
	// the onMount block below), so no API call changes.
	const searched = $derived.by(() => {
		const term = q.trim().toLowerCase();
		return items.filter((i) => matchesTerm(i, term));
	});

	function countFor(key: Filter): number {
		if (key === 'all') return searched.length;
		return searched.filter((i) => i.category === key).length;
	}

	const filtered = $derived(
		searched.filter((i) => activeCategory === 'all' || i.category === activeCategory)
	);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await blocksApi.list({ sort });
			items = res.items;
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	// Re-fetch when sort changes (server-sorted); category filter is client-side.
	$effect(() => {
		void sort;
		load();
	});

	// ⛔ AND RE-FETCH WHEN THE READER SWITCHES LANGUAGE. `name` and `description` on every card are
	// USER CONTENT localized SERVER-side (`content_translations`, routes/blocks.ts:286-370) off the
	// `Accept-Language` header — they are not `m.*()` calls and no amount of Paraglide reactivity can
	// touch them. Without this line a Dutch reader who switched language on the catalogue — the first
	// page a demo opens — got a Dutch title, Dutch chips and Dutch sort options wrapped around forty
	// English block names.
	//
	// ⚠️ THE `$effect` ABOVE DOES NOT ALREADY COVER THIS, which is the plausible reason to delete this
	// line. `load()` → `blocksApi.list()` → `authFetch`, and `authFetch` reads `getLocale()` only
	// AFTER `await ensureFreshToken(30)` (api/auth-fetch.ts:57-64) — a later microtask, outside the
	// effect's synchronous tracking window. The effect therefore never took a dependency on the locale
	// rune. The locale is on the wire; it was never a reload trigger.
	//
	// `reloadOnLocaleChange` skips its own first run, so this does NOT reintroduce the duplicate mount
	// fetch that blocks-page.single-load.render.test.ts exists to forbid. Pinned by
	// blocks-page.locale-refetch.render.test.ts (both halves: Dutch present, English absent).
	//
	// ⛔ `untrack`, AND IT IS NOT DECORATION — the bare `reloadOnLocaleChange(load)` the other pages
	// use costs this one a DUPLICATE FETCH PER SORT CHANGE. `load()` runs synchronously inside the
	// helper's `$effect` and reads `sort` (`blocksApi.list({ sort })`); Svelte re-collects an effect's
	// dependencies on every run, so the first locale switch silently subscribes the locale effect to
	// `sort` as well, and from then on each sort change fires BOTH it and the sort effect above.
	// Measured: 4 requests where there should be 3. That is the very defect the ⛔ block on the
	// `onMount` below was written about, arriving by a new door. Pinned by the sort-after-switch case
	// in blocks-page.locale-refetch.render.test.ts.
	reloadOnLocaleChange(() => void untrack(load));

	// Keep the category + search in the URL so a filtered view is shareable/bookmarkable
	// and survives reload. Filtering itself stays client-side (instant category counts over
	// the full list — the library is small; server-side filtering would lose the counts).
	let urlReady = $state(false);
	$effect(() => {
		const cat = activeCategory;
		const term = q;
		if (!urlReady) return;
		untrack(() => {
			const params = new URLSearchParams();
			if (cat !== 'all') params.set('category', cat);
			if (term.trim()) params.set('q', term.trim());
			const qs = params.toString();
			// kit 3 replaced `keepFocus` + `noScroll` with `reset: false` — leave the reader's
			// scroll position and focus alone across this URL-only rewrite.
			goto(qs ? `?${qs}` : location.pathname, { replaceState: true, reset: false });
		});
	});

	// ⛔ THIS onMount DOES NOT — AND MUST NOT — CALL `load()`. It restores the URL state, nothing
	// more. The `$effect` above already runs in the same post-mount flush, so a `load()` here made
	// every visit issue two identical `GET /api/blocks?sort=usage` (measured 590 ms then 446 ms on
	// the heaviest page in the app).
	//
	// It is safe for three reasons the code does not make obvious, so that the next reader does not
	// "restore" the missing call:
	//   1. Sort changes still reload. The `$effect` is the ONLY thing that ever depended on `sort`
	//      and it is untouched — deleting it and hanging an `onchange` off the <select> instead
	//      would lose the reload for any PROGRAMMATIC sort change.
	//   2. `load()` reads ONLY `sort` (`blocksApi.list({ sort })`). `activeCategory` and `q` are
	//      client-side filters over the full list, so the ORDER of the restore and the fetch is
	//      irrelevant — the fetch does not depend on either.
	//   3. `urlReady` gates only the URL *writer* effect above, which never calls `load()`. Moving
	//      a fetch behind that gate would just reinstate the second request.
	// Pinned by blocks-page.single-load.render.test.ts.
	onMount(() => {
		const sp = new URLSearchParams(window.location.search);
		const cat = sp.get('category');
		if (cat && CATEGORIES.some((c) => c.key === cat)) activeCategory = cat as Filter;
		const term = sp.get('q');
		if (term) q = term;
		urlReady = true;
	});

	function badgeClass(category: BlockCategory): string {
		return `badge ${CATEGORY_META[category].badge}`;
	}
	function iconStyle(category: BlockCategory): string {
		const map: Record<BlockCategory, [string, string]> = {
			data: ['var(--c-teal-light)', 'var(--c-teal-dark)'],
			ai: ['var(--c-violet-light)', '#5B21B6'],
			logic: ['var(--c-amber-light)', '#92400E'],
			output: ['var(--c-coral-light)', 'var(--c-coral-dark)'],
			ui: ['var(--c-teal-light)', 'var(--c-teal-dark)']
		};
		const [bg, fg] = map[category];
		return `background:${bg};color:${fg}`;
	}
	function open(slug: string) {
		goto(`/block-edit?slug=${encodeURIComponent(slug)}`);
	}
</script>

<div class="page">
	<header class="page-head">
		<div>
			<h1>{m.blocks_title()}</h1>
			<p>{m.blocks_subtitle()}</p>
		</div>
		{#if canAuthorBlocks}
			<button class="btn-primary" onclick={() => goto('/block-edit')}>{m.blocks_new_block()}</button>
		{/if}
	</header>

	<div class="filter-bar">
		<div class="chips">
			{#each CATEGORIES as c (c.key)}
				<!-- Hide empty categories (count 0) so we don't show dead "UI 0" chips; always keep "All".
				     ⚠️ …and always keep the ACTIVE one. Now that the counts respect the search term, a
				     category can drop to 0 WHILE it is selected (pick "Data", then type a term no data
				     block matches) — hiding it there would delete the pressed chip out from under the
				     reader mid-keystroke, leaving no visible indication of which filter is still on. -->
				{#if c.key === 'all' || activeCategory === c.key || countFor(c.key) > 0}
					<button
						class="chip"
						class:active={activeCategory === c.key}
						onclick={() => (activeCategory = c.key)}
					>
						{mm[c.labelKey]()} <span class="chip-count">{num(countFor(c.key), locale.current)}</span>
					</button>
				{/if}
			{/each}
		</div>
		<div class="filter-right">
			<input class="search" type="search" placeholder={m.blocks_search_placeholder()} bind:value={q} aria-label={m.blocks_search_placeholder()} />
			<select class="sort" bind:value={sort} aria-label={m.blocks_sort_label()}>
				<option value="usage">{m.blocks_sort_usage()}</option>
				<option value="recent">{m.blocks_sort_recent()}</option>
				<option value="alpha">{m.blocks_sort_alpha()}</option>
			</select>
		</div>
	</div>

	{#if loading}
		<div class="blocks-grid">
			{#each Array(8) as _, i (i)}
				<div class="block-card skeleton"></div>
			{/each}
		</div>
	{:else if error}
		<div class="notice error">{m.blocks_load_failed({ error })}</div>
	{:else if filtered.length === 0 && (q.trim() || activeCategory !== 'all') && items.length > 0}
		<!-- A no-match SEARCH/FILTER is not an empty library. The single empty state below told a
		     searcher "no blocks in this category yet — create one" while the library held forty of
		     them, and offered a "New block" button as the way out of a typo. Same shape and same
		     reasoning as /solutions (routes/solutions/+page.svelte). `items.length > 0` keeps the
		     genuinely-empty library on the empty state even while a filter is active. -->
		<div class="notice">{m.blocks_no_match()}</div>
	{:else if filtered.length === 0}
		<div class="notice empty-cta">
			<span>{m.blocks_empty()}</span>
			{#if canAuthorBlocks}
				<button class="btn-primary" onclick={() => goto('/block-edit')}>{m.blocks_new_block()}</button>
			{/if}
		</div>
	{:else}
		<div class="blocks-grid">
			{#each filtered as b (b.slug)}
				<button class="block-card" onclick={() => open(b.slug)}>
					<div class="block-card-head">
						<div class="block-card-icon" style={iconStyle(b.category)}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<rect x="3" y="3" width="8" height="8" rx="1" />
								<rect x="13" y="3" width="8" height="8" rx="1" />
								<rect x="3" y="13" width="8" height="8" rx="1" />
							</svg>
						</div>
						<div class="block-card-title">
							<div class="block-card-name">{b.name}</div>
							<!-- Version numbers and entity keys are for block authors; a member reads the status. -->
							<div class="block-card-ver">{#if canAuthorBlocks}v{b.version ?? '—'} · {/if}{blockStatusLabel(b.status)}</div>
						</div>
						<span class={badgeClass(b.category)}>{categoryLabel(b.category)}</span>
						{#if b.owner === 'tenant'}
							<span class="owner-badge">{m.block_owner_tenant()}</span>
						{/if}
						<!-- ⛔ THE CARD MUST SAY WHAT A RUN OF THIS BLOCK WILL ACTUALLY RETURN.
						     `mock_data` is the backend's projection of `descriptor.capabilities.mockData`
						     (routes/blocks.ts) — the block answers from `ctx.mockData()`, a deterministic
						     fixture inside the runner. `ocr-scan` declared it, advertised "Tesseract+Claude
						     hybrid OCR", and returned "Lorem ipsum dolor sit amet" while nothing on any
						     screen called it a simulation.
						     This is one of FOUR surfaces carrying the same badge off the same bit (this card ·
						     the build palette · the canvas node · the run output). A badge on one of them is
						     the failure mode this repo keeps hitting, so they move together.
						     `?? false` because the field is absent from a backend mid-rolling-deploy — see
						     `BlockListItem.mock_data` for why that direction is the safe one. -->
						{#if b.mock_data ?? false}
							<span class="sim-badge" title={m.build_example_data()} aria-label={m.build_example_data()}
								><span class="sr-only">{m.block_simulated_badge()}</span></span
							>
						{/if}
					</div>
					<div class="block-card-desc">{b.description}</div>
					{#if canAuthorBlocks && b.source_entity_key}
						<div class="block-card-derived">
							{m.blocks_derived_from({ entity: b.source_entity_key.split(':').pop() ?? b.source_entity_key })}
						</div>
					{/if}
					<div class="block-card-foot">
						<!-- `usage_count` is the backend's trace-derived RUN count (routes/blocks.ts
						     realUsageBySlug), not `block_versions.usage_count`, which is a frozen seed
						     literal. The string is "{count} runs", not "Used {count}×": one execution that
						     invokes the block many times inside a foreach counts once, and the multiplied
						     figure is the defect this replaced (prod showed "1.240× gebruikt" against 113
						     flow_runs in the whole database). -->
						<span>{m.blocks_used_count({ count: num(b.usage_count, locale.current) })}</span>
						{#if b.maintainer}
							<span class="maint"><span class="avatar">{b.maintainer.initials}</span>{b.maintainer.name}</span>
						{:else}
							<span class="maint"><span class="avatar">CP</span>{m.blocks_maintainer_platform()}</span>
						{/if}
					</div>
				</button>
			{/each}
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
		margin-bottom: 20px;
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
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.filter-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
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
	.chip:hover {
		border-color: var(--c-border-strong);
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
		padding: 7px 12px;
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
		padding: 7px 12px;
		border-radius: var(--r);
	}
	.blocks-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 14px;
	}
	.block-card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 16px;
		text-align: start;
		cursor: pointer;
		transition: border-color 0.12s, box-shadow 0.12s;
		display: flex;
		flex-direction: column;
	}
	.block-card:hover {
		border-color: var(--c-border-strong);
		box-shadow: var(--sh);
	}
	.block-card.skeleton {
		height: 150px;
		background: var(--c-surface);
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
	}
	.block-card-head {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-bottom: 10px;
	}
	.block-card-icon {
		width: 32px;
		height: 32px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.block-card-title {
		flex: 1;
		min-width: 0;
	}
	.block-card-name {
		font-weight: 600;
		font-size: 14px;
		color: var(--c-midnight);
		line-height: 1.3;
		font-family: var(--font-mono);
	}
	.block-card-ver {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-muted);
		margin-top: 2px;
	}
	.block-card-desc {
		font-size: 12.5px;
		color: var(--c-muted);
		line-height: 1.4;
		margin-bottom: 12px;
		min-height: 36px;
		flex: 1;
	}
	.block-card-derived {
		font-size: 11px;
		color: var(--c-violet);
		margin: -6px 0 10px;
	}
	.block-card-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 11.5px;
		color: var(--c-muted);
		padding-top: 12px;
		border-top: 1px solid var(--c-border);
	}
	.maint {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.avatar {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--c-midnight);
		color: #fff;
		font-size: 9px;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	/* Category badges (demo.html:379–386) */
	.badge {
		font-size: 10.5px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.owner-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 7px;
		border-radius: 999px;
		white-space: nowrap;
		color: var(--c-violet);
		background: color-mix(in srgb, var(--c-violet) 12%, transparent);
	}
	/* "Simulated" — amber, deliberately NOT the coral/rose error palette: a fixture-backed block is
	   working exactly as designed, it is just not producing a real result. */
	/* The example-data dot: same amber dot as BlockNode/BlockPalette; the word stays for screen readers. */
	.sim-badge {
		flex-shrink: 0;
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-amber);
		cursor: help;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.violet {
		background: var(--c-violet-light);
		color: #5b21b6;
	}
	.badge.amber {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.badge.coral {
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
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
	.empty-cta {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
	}
	.notice.error {
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
</style>
