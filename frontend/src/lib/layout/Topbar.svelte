<script lang="ts">
	// Topbar shell: global search (challenges/solutions/blocks), the §5B locale
	// switcher, and Help / What's new (→ docs). Search hits GET /api/search, debounced,
	// with a grouped results dropdown; ⌘K / Ctrl+K focuses the box.
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { locale, LOCALES, LOCALE_LABELS } from '$lib/stores/locale.svelte';
	import { searchApi, type SearchResults } from '$lib/api/search';
	import { errorText } from '$lib/api/error-message';
	import { shouldCommitTopHit } from '$lib/layout/topbar-search';
	import NotificationBell from '$lib/layout/NotificationBell.svelte';

	// The phone-width menu button (hidden ≥768px by app.css) that opens the sidebar drawer.
	let {
		menuOpen = false,
		onMenu,
		menuButton = $bindable(null)
	}: { menuOpen?: boolean; onMenu?: () => void; menuButton?: HTMLButtonElement | null } = $props();

	let inputEl = $state<HTMLInputElement | null>(null);
	let q = $state('');
	let open = $state(false);
	let loading = $state(false);
	let results = $state<SearchResults | null>(null);
	let activeIndex = $state(-1);
	// The reader's sentence when the search FAILED, whatever the reason. `null` means the last
	// attempt succeeded.
	//
	// ⚠️ CORRECTED, AND THE OLD COMMENT IS QUOTED BECAUSE HALF OF IT WAS RIGHT. It read: "Set only
	// when search fails for a licence/permission reason. Every other failure keeps the existing
	// silent 'no results' behaviour — a network blip should not shout at the user, but a 403
	// rendered as 'no results' is a lie about why the box is empty." The second clause is exactly
	// the principle; the first clause broke it for every failure that is NOT a 402/403/409-seat/
	// known-503, because `licenseOrPermissionMessage` returns `null` for all of those
	// (api/error-message.ts:1370) — a 500, a dead backend, a DNS failure, an offline laptop. The
	// catch then wrote an EMPTY result set, so the dropdown fell through to `search_no_results` and
	// this chrome — present on all 24 screens — told the reader "Geen resultaten voor “schade”".
	// That is not silence. It is a false factual claim about the contents of their workspace, made
	// by the one component they cannot navigate away from, and it is the same lie the 403 clause was
	// written to stop telling.
	//
	// ⛔ THE "DO NOT SHOUT AT A NETWORK BLIP" INTENT IS KEPT, and it is kept where it belongs — in
	// the PRESENTATION, not in the truth value. The failure renders as the same quiet `.search-msg`
	// line the dropdown already uses for "Zoeken…" and "Geen resultaten": no toast, no banner, no
	// modal, and it clears the moment a later keystroke succeeds. Staying silent was never on the
	// menu — the dropdown is already open and already renders a sentence. The only choice was WHICH
	// sentence, and one of the two was untrue.
	let searchDenied = $state<string | null>(null);

	let debounce: ReturnType<typeof setTimeout> | null = null;
	let inflight: AbortController | null = null;

	// Flat, ordered list of navigable hits — drives keyboard selection + Enter.
	interface Hit {
		href: string;
		label: string;
	}
	const hits = $derived<Hit[]>(
		results
			? [
					...results.challenges.map((c) => ({ href: `/challenges/${c.id}`, label: c.title })),
					...results.solutions.map((s) => ({ href: `/solutions/${s.id}`, label: s.title })),
					...results.blocks.map((b) => ({ href: `/block-edit?slug=${encodeURIComponent(b.slug)}`, label: b.name }))
				]
			: []
	);
	const hasResults = $derived(hits.length > 0);

	function runSearch(term: string) {
		if (debounce) clearTimeout(debounce);
		const trimmed = term.trim();
		if (trimmed.length < 2) {
			inflight?.abort();
			results = null;
			loading = false;
			open = false; // too short to search — keep the dropdown closed
			return;
		}
		loading = true;
		open = true;
		debounce = setTimeout(async () => {
			inflight?.abort();
			const ctrl = new AbortController();
			inflight = ctrl;
			try {
				const res = await searchApi.query(trimmed, ctrl.signal);
				if (ctrl.signal.aborted) return;
				results = res;
				searchDenied = null;
				activeIndex = -1;
			} catch (e) {
				if (!ctrl.signal.aborted) {
					// `errorText`, not `licenseOrPermissionMessage`: the same localized licence/permission
					// copy when the error is one, and the generic load-failure sentence when it is not —
					// the idiom ~25 other catch blocks in this app already use. It cannot return `null`.
					searchDenied = errorText(e, m.error_load_failed());
					// ⛔ `null` — AND WHAT THAT ACTUALLY BUYS, MEASURED RATHER THAN ASSUMED.
					//
					// ⚠️ IT IS NOT THE DIFFERENCE AGAINST THE FABRICATED `{ q, challenges: [], solutions:
					// [], blocks: [] }` THIS REPLACED. `searchDenied` can no longer be null here, and the
					// markup checks `{:else if searchDenied}` BEFORE `{:else if results && !hasResults}`,
					// so both spellings render byte-identical DOM and leave `hits` empty either way. An
					// adversarial verifier swapped them back and every case stayed green. That is a true
					// report about this line, recorded here rather than argued with.
					//
					// What it buys is the difference against DELETING it — the edit a reader who notices
					// that equivalence is most likely to make next. `results` would then keep the LAST
					// SUCCESSFUL search's payload: `hits` stays non-empty while the box says the search
					// failed, `open` is still true, and `onKeydown`'s second branch navigates Enter to a
					// hit for a query the reader has already typed past. Pinned by "a failure clears the
					// stale hits" in topbar-search.failure.render.test.ts, which reds on the deletion.
					results = null;
				}
			} finally {
				if (!ctrl.signal.aborted) loading = false;
			}
		}, 200);
	}

	function onInput(e: Event) {
		q = (e.currentTarget as HTMLInputElement).value;
		runSearch(q);
	}

	function navigate(href: string) {
		open = false;
		q = '';
		results = null;
		inputEl?.blur();
		goto(href);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			open = false;
			inputEl?.blur();
			return;
		}
		if (!open || !hasResults) {
			// Enter-to-jump-to-top-hit only when the user is actually typing in the search box.
			// Guards against a blurred/closed search being committed by a stray Enter that
			// originated elsewhere (e.g. confirming the locale <select>) — see A7.
			const focused = typeof document !== 'undefined' && document.activeElement === inputEl;
			if (shouldCommitTopHit(e.key, focused, hits.length)) navigate(hits[0].href);
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = activeIndex <= 0 ? hits.length - 1 : activeIndex - 1;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			navigate(hits[activeIndex >= 0 ? activeIndex : 0].href);
		}
	}

	// ⌘K / Ctrl+K focuses the search from anywhere.
	onMount(() => {
		const onGlobalKey = async (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault();
				await tick();
				inputEl?.focus();
				if (q.trim().length >= 2) open = true;
			}
		};
		window.addEventListener('keydown', onGlobalKey);
		return () => window.removeEventListener('keydown', onGlobalKey);
	});
</script>

<header class="topbar">
	{#if onMenu}
		<button type="button" class="icon-btn menu-btn" data-testid="nav-menu-button" bind:this={menuButton}
			aria-controls="app-sidebar" aria-expanded={menuOpen}
			aria-label={menuOpen ? m.shell_menu_close() : m.shell_menu_open()} onclick={onMenu}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
				stroke-linecap="round" aria-hidden="true">
				<path d="M4 6h16M4 12h16M4 18h16" />
			</svg>
		</button>
	{/if}
	<div class="search" class:open>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2">
			<circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
		</svg>
		<input
			bind:this={inputEl}
			value={q}
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={() => { if (q.trim().length >= 2) open = true; }}
			onblur={() => setTimeout(() => (open = false), 150)}
			placeholder={m.topbar_search_placeholder()}
			role="combobox"
			aria-expanded={open}
			aria-controls="topbar-search-results"
			aria-label={m.topbar_search_placeholder()}
			autocomplete="off"
		/>
		<span class="kbd">⌘K</span>

		{#if open}
			<div class="results" id="topbar-search-results" role="listbox">
				{#if loading}
					<div class="search-msg">{m.search_searching()}</div>
				{:else if searchDenied}
					<!-- role="alert" for the same reason NotificationBell.svelte:97 carries one: without
					     it a "no results" line and a failure line are announced identically, as a silent
					     paragraph swap. -->
					<div class="search-msg" role="alert">{searchDenied}</div>
				{:else if results && !hasResults}
					<div class="search-msg">{m.search_no_results({ q: results.q })}</div>
				{:else if results}
					{#if results.challenges.length}
						<div class="group-label">{m.search_group_challenges()}</div>
						{#each results.challenges as c (c.id)}
							{@const idx = hits.findIndex((h) => h.href === `/challenges/${c.id}`)}
							<button type="button" class="result" class:active={idx === activeIndex}
								onmousedown={(e) => { e.preventDefault(); navigate(`/challenges/${c.id}`); }}>
								{c.title}{#if c.code}<span class="meta">{c.code}</span>{/if}
							</button>
						{/each}
					{/if}
					{#if results.solutions.length}
						<div class="group-label">{m.search_group_solutions()}</div>
						{#each results.solutions as s (s.id)}
							{@const idx = hits.findIndex((h) => h.href === `/solutions/${s.id}`)}
							<button type="button" class="result" class:active={idx === activeIndex}
								onmousedown={(e) => { e.preventDefault(); navigate(`/solutions/${s.id}`); }}>
								{s.title}
							</button>
						{/each}
					{/if}
					{#if results.blocks.length}
						<div class="group-label">{m.search_group_blocks()}</div>
						{#each results.blocks as b (b.slug)}
							{@const href = `/block-edit?slug=${encodeURIComponent(b.slug)}`}
							{@const idx = hits.findIndex((h) => h.href === href)}
							<button type="button" class="result" class:active={idx === activeIndex}
								onmousedown={(e) => { e.preventDefault(); navigate(href); }}>
								{b.name}<span class="meta">{b.slug}</span>
							</button>
						{/each}
					{/if}
				{/if}
			</div>
		{/if}
	</div>
	<div class="topbar-spacer"></div>
	<label class="lang-switch">
		<span class="sr-only">{m.topbar_language()}</span>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
			<circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 010 20a15 15 0 010-20" />
		</svg>
		<select
			value={locale.current}
			onchange={(e) => { open = false; q = ''; results = null; locale.set(e.currentTarget.value); }}
			aria-label={m.topbar_language()}
		>
			{#each LOCALES as l (l)}
				<option value={l}>{LOCALE_LABELS[l]}</option>
			{/each}
		</select>
	</label>
	<NotificationBell />
	<a class="icon-btn" href="/docs" title={m.topbar_help()} aria-label={m.topbar_help()}>
		<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
			<circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12" y2="17" />
		</svg>
	</a>
</header>

<style>
	.search {
		position: relative;
	}
	.results {
		position: absolute;
		top: calc(100% + 6px);
		inset-inline-start: 0;
		min-width: 340px;
		max-width: 460px;
		max-height: 60vh;
		overflow-y: auto;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
		padding: 6px;
		z-index: 50;
	}
	.group-label {
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
		padding: 8px 10px 4px;
	}
	.result {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		text-align: start;
		border: none;
		background: transparent;
		font: inherit;
		font-size: 13px;
		color: var(--c-ink);
		padding: 8px 10px;
		border-radius: var(--r-sm, 6px);
		cursor: pointer;
	}
	.result:hover,
	.result.active {
		background: var(--c-surface);
	}
	.result .meta {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-faint);
		white-space: nowrap;
	}
	.search-msg {
		font-size: 12.5px;
		color: var(--c-muted);
		padding: 12px 10px;
	}
	.lang-switch {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--c-muted);
		padding-inline: 8px;
		height: 34px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-white);
	}
	.lang-switch select {
		border: none;
		background: transparent;
		font: inherit;
		font-size: 12.5px;
		color: var(--c-ink);
		cursor: pointer;
		padding-inline-end: 2px;
	}
	.lang-switch select:focus {
		outline: none;
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
</style>
