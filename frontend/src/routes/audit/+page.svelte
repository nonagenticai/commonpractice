<script lang="ts">
	// Platform Audit log — the append-only feed (demo.html `audit`). Every mutating
	// action across the app writes a row via recordAudit; this is the filterable feed.
	import { onMount } from 'svelte';
	import { auditApi, ApiError } from '$lib/api/audit';
	import { errorText } from '$lib/api/error-message';
	import { AUDIT_CATEGORIES, type AuditFeed, type AuditItem } from '$lib/types/audit';
	import AuditRow from '$lib/components/ops/AuditRow.svelte';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	// The SAME adapter `AuditRow` renders the Result cell with — see `sortVal`'s `result` arm.
	import { auditResultLabel } from '$lib/i18n/audit-result-label';
	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	let feed = $state<AuditFeed | null>(null);
	// Accumulated rows across "Load more" pages — the server returns one page window per
	// request, so we append rather than replace (otherwise Load more would discard prior rows).
	let items = $state<AuditItem[]>([]);
	let loading = $state(true);
	// The FIRST-LOAD error, and only that. It renders inside the `{#if loading}…{:else if error}`
	// chain below, which is mutually exclusive with the table — which is correct ONLY while there is
	// no table: a first load that failed has nothing to show, so the chain has nothing to destroy.
	let error = $state<string | null>(null);
	// A failed ACTION (the CSV export), kept separate from `error` (the LOAD error). `error` renders
	// inside the `{#if loading}…{:else if error}` chain below, which is mutually exclusive with the
	// audit table — so a failed export replaced the very log the user was exporting. This one renders
	// ABOVE the outer `{#if denied}` and leaves the table in place. Same pattern as #210's `voteError`.
	let actionError = $state<string | null>(null);
	// ⛔ A failed REFRESH / APPEND on a feed that is ALREADY on screen — the third slot, and the one
	// this page was missing. Writing that failure into `error` sent it into the `{:else if}` chain,
	// whose sibling branch holds the whole table: a transient 500 on "Load more" or on a chip click
	// REMOVED the 25 rows the reader was reading. `items` and `feed` were never cleared — the data
	// was still in memory, the chain simply refused to render it. So the failure goes here, ABOVE
	// the chain, exactly like `actionError`, and the table stays up.
	// ⚠️ It is worded as STALENESS, not as a bare failure, because a filter click has already moved
	// the chips: the rows below belong to the PREVIOUS query, and saying only "that failed" would
	// leave the reader to assume the table beneath the new active chip matches it.
	let refreshError = $state<string | null>(null);
	// ⛔ Set ONLY when the FIRST load was refused — see the 401/403 branch in `load()`.
	let denied = $state(false);

	let category = $state<string>('');
	let range = $state('7d');
	let from = $state('');
	let to = $state('');
	let q = $state('');
	let page = $state(1);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// ──────────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ TWO REQUESTS CAN BE IN FLIGHT AT ONCE, AND BOTH OF THEM CAN SUCCEED.
	//
	// "Load more" is outstanding and the reader clicks a chip, or types one character into the search
	// box (250 ms debounce) — ordinary, unremarkable, and it overlaps two requests. Nothing about that
	// involves a failure, and it is the reason the state below is a GENERATION TOKEN and a QUERY KEY
	// rather than a page-number rollback:
	//
	//   · `reqSeq` — every request takes a ticket before it awaits and checks it afterwards. A
	//     response whose ticket is no longer the newest belongs to a query the reader has LEFT, and is
	//     dropped whole: its rows, its error, its `loading = false`, and — critically — the `page`
	//     advance its caller would otherwise have written over the `page = 1` a filter handler had
	//     already set. A rollback of `page` cannot express any of this: `page` is one number and it
	//     cannot say WHICH query it counts windows of.
	//   · `loadedKey` — the query the rows ON SCREEN belong to, as a value. `items` is the
	//     concatenation of windows 1…`page` of THAT query. When it differs from the live filters the
	//     rows are the previous query's, so "Load more" would fetch window 2 of the NEW query and
	//     staple it onto the OLD rows — one table spliced out of two filters, with a header count from
	//     a third. The pager therefore renders only while the two agree, which covers a failed page-1
	//     load, an in-flight one, and an unsubmitted search keystroke with one rule instead of three.
	// ──────────────────────────────────────────────────────────────────────────────────────────────
	let reqSeq = 0;
	/** Everything the server filters on EXCEPT the window. */
	function currentQueryKey(): string {
		return JSON.stringify([
			category,
			range,
			range === 'custom' ? from : '',
			range === 'custom' ? to : '',
			q.trim()
		]);
	}
	const queryKey = $derived(currentQueryKey());
	let loadedKey = $state<string | null>(null);

	// Client-side column sort over the loaded set.
	type SortKey = 'time' | 'actor' | 'event' | 'target' | 'result';
	let sortKey = $state<SortKey>('time');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function sortVal(it: AuditItem, key: SortKey): string {
		switch (key) {
			case 'time': return it.createdAt;
			// `actor` is `null` for a row no human wrote. Sorting on the LOCALIZED word is deliberate:
			// the column sorts by what the reader can see, so "Systeem" files under S for a Dutch
			// reader and "Système" under S for a French one — which is the only ordering that matches
			// the screen. (An old pod still sends `{ name: 'System' }`; that branch is unchanged.)
			case 'actor': return (it.actor ? it.actor.name : m.audit_actor_system()).toLowerCase();
			case 'event': return `${it.category} ${it.action}`.toLowerCase();
			case 'target': return `${it.targetType} ${it.targetId ?? ''}`.toLowerCase();
			// ⛔ THE LOCALIZED LABEL, FOR THE REASON THE `actor` ARM ABOVE ALREADY GIVES. `AuditRow`
			// renders this cell through `auditResultLabel`, so a coded row reads "Handmatig
			// checkpoint" to a Dutch reader while `it.result` still holds "Manual checkpoint".
			// Sorting on `it.result` filed that row under M — the table ordered by a string that is
			// nowhere on screen, which reads as a broken sort rather than as a translation bug. This
			// column had no such defect before the Result cell was localized; the fix created it, and
			// calling the SAME adapter the row calls is what stops it coming back.
			//
			// ⚠️ LEGACY ROWS ARE BIT-FOR-BIT UNCHANGED. `audit_log` is append-only with no backfill,
			// so most of this feed has no `resultCode`; `flowSummaryLabel` returns their `summary`
			// verbatim, which is `it.result` — the exact key this arm used to build.
			case 'result': return auditResultLabel(it, locale.current).toLowerCase();
		}
	}
	const sortedItems = $derived.by(() => {
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...items].sort((a, b) => {
			const av = sortVal(a, sortKey);
			const bv = sortVal(b, sortKey);
			return av < bv ? -dir : av > bv ? dir : 0;
		});
	});
	function toggleSort(key: SortKey) {
		if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else { sortKey = key; sortDir = key === 'time' ? 'desc' : 'asc'; }
	}
	function sortIndicator(key: SortKey): string {
		if (sortKey !== key) return '';
		return sortDir === 'asc' ? ' ↑' : ' ↓';
	}

	// Derived from AUDIT_CATEGORIES rather than re-listed here: the hand-written list is how the
	// feed came to render five chips for an eight-category log, with "All events" summing all
	// eight beside them. `''` is the all-chip and has no category of its own.
	// The `audit_chip_<key>` message keys are resolved through `mm` (the namespace-import escape
	// hatch this page already uses for its chip labels); each key exists in all eight catalogs.
	const CHIPS: { key: string; labelKey: string }[] = [
		{ key: '', labelKey: 'audit_chip_all_events' },
		...AUDIT_CATEGORIES.map((key) => ({ key: key as string, labelKey: `audit_chip_${key}` }))
	];

	/**
	 * Fetch one page window.
	 *
	 * ⛔ `target` IS AN ARGUMENT, NOT `page`. `loadMore` used to do `page += 1; load();` and never put
	 * it back when the fetch failed — so after ONE failed "Load more" the counter sat at 3, and the
	 * next successful click fetched page 4 and appended it to page 1. Twenty-five events silently
	 * missing, from an APPEND-ONLY AUDIT LOG, with nothing on screen saying so. `page` is advanced by
	 * the caller and only when this resolves true, so a failure cannot skip a window.
	 *
	 * ⛔ AND NOTHING IS WRITTEN UNTIL THE TICKET IS CHECKED. Moving `page`'s write after the await is
	 * what made the generation token necessary rather than optional: a late response's `page = next`
	 * would otherwise land on top of the `page = 1` a chip click had already written and skip a
	 * window with two 200s and no failure anywhere. See the block by `reqSeq` above.
	 *
	 * ⛔ NOTHING IS CLEARED BEFORE THE AWAIT EITHER. `refreshError` used to be reset on entry, so
	 * during a retry the reader saw the previous query's rows under the new chips with no caveat, no
	 * spinner (`{#if loading && !feed}` is false once `feed` is set) and no pager — a screen quietly
	 * asserting those rows are the answer. The caveat is true until a load SUCCEEDS, so success is
	 * where it is cleared.
	 *
	 * Returns whether the fetch landed AND is still the response the reader is waiting for.
	 */
	async function load(target: number = page): Promise<boolean> {
		const generation = ++reqSeq;
		const key = currentQueryKey();
		loading = true;
		try {
			const resp = await auditApi.list({
				category: category || undefined,
				range,
				from: range === 'custom' && from ? from : undefined,
				to: range === 'custom' && to ? to : undefined,
				q: q.trim() || undefined,
				page: target
			});
			if (generation !== reqSeq) return false; // superseded — this is somebody else's screen now
			feed = resp;
			// Page 1 (any filter change) replaces; subsequent pages append.
			// ⚠️ THE APPEND DE-DUPLICATES BY ID, and the reason is the server, not the client. The feed
			// is append-only and paged by OFFSET, so rows written between the two requests shift the
			// window and window 2 legitimately re-serves a row window 1 already had. The `{#each}` below
			// is keyed on `item.id`; handing Svelte the same key twice throws `each_key_duplicate` and
			// takes the whole board down over the server being correct.
			const known = new Set(items.map((i) => i.id));
			items = target === 1 ? resp.items : [...items, ...resp.items.filter((i) => !known.has(i.id))];
			loadedKey = key;
			// A recovered feed must stop apologising — for either kind of failure, and for a refusal.
			error = null;
			refreshError = null;
			denied = false;
			return true;
		} catch (e) {
			if (generation !== reqSeq) return false; // a query nobody is on cannot caption this screen
			const refused = e instanceof ApiError && (e.status === 401 || e.status === 403);
			if (feed) {
				// ⛔ INCLUDING A 401/403. `denied` renders OUTSIDE the loading/error chain and replaces
				// the ENTIRE page — measured mid-session: 0 rows, 0 chips, no range select, no search
				// box, no export button, one sentence and no control left to retry with. A session that
				// expires during "Load more" is the likeliest way this is ever reached, and it took the
				// twenty-five events the reader was reading with it. A refusal on a loaded feed is still
				// just a failed refresh, so it is reported like one, with its own sentence inside.
				refreshError = m.audit_refresh_failed({
					error: refused ? m.audit_denied() : errorText(e, m.error_load_failed())
				});
			} else if (refused) {
				// Nothing has ever loaded, so the whole-page sentence IS the whole truth here.
				denied = true;
			} else error = errorText(e, m.error_load_failed());
			return false;
		} finally {
			if (generation === reqSeq) loading = false;
		}
	}
	onMount(() => {
		// Honor a ?category= deep-link (e.g. from the it-dash P95 stat card).
		const urlCat = new URLSearchParams(window.location.search).get('category');
		if (urlCat && CHIPS.some((c) => c.key === urlCat)) category = urlCat;
		load();
	});

	function setCategory(key: string) {
		category = key;
		page = 1;
		load();
	}
	function setRange(e: Event) {
		range = (e.target as HTMLSelectElement).value;
		page = 1;
		load();
	}
	function setCustomDates() {
		page = 1;
		load();
	}
	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			load();
		}, 250);
	}
	// ⛔ `page` IS ADVANCED ONLY AFTER THE WINDOW IS IN HAND. The old body was `page += 1; load();`
	// with no rollback, so a single failed click left the counter one ahead of the rows for the rest
	// of the session and the next successful click skipped a whole 25-event window of an append-only
	// log — the one kind of gap this page exists to make impossible. `load()` returns false for a
	// SUPERSEDED response as well as a failed one, so a chip clicked mid-flight cannot have its
	// `page = 1` overwritten from here.
	async function loadMore() {
		// The button is hidden in this state; the guard is here because a stale click, a keyboard
		// activation or a future caller must not be able to append window 2 of one query to the rows
		// of another.
		if (loadedKey !== queryKey) return;
		const next = page + 1;
		if (await load(next)) page = next;
	}

	let exporting = $state(false);
	async function exportCsv() {
		if (exporting) return;
		actionError = null;
		exporting = true;
		try {
			const csv = await auditApi.exportCsv({
				category: category || undefined,
				range,
				from: range === 'custom' && from ? from : undefined,
				to: range === 'custom' && to ? to : undefined,
				q: q.trim() || undefined
			});
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (e) {
			// `errorText`, not `writeErrorText` — the export is a GET (a READ of the same feed the
			// table shows), so there is no 400/422/409 backend message worth preferring. The fallback
			// moves from `error_load_failed` to `error_action_failed`: the user pressed Export, and
			// "Could not load" describes a page that in fact loaded fine.
			actionError = errorText(e, m.error_action_failed());
		} finally {
			exporting = false;
		}
	}

	const countFor = (key: string) => feed?.counts?.[key === '' ? 'all' : key] ?? 0;
	const totalPages = $derived(feed ? Math.max(1, Math.ceil(feed.total / feed.pageSize)) : 1);
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.audit_eyebrow()}</div>
			<h1>{m.audit_title()}</h1>
			<p>{m.audit_subtitle()}</p>
		</div>
		{#if !denied}
			<button class="btn-export" onclick={exportCsv} disabled={exporting || !feed || items.length === 0}>
				{exporting ? m.audit_exporting() : m.audit_export_csv()}
			</button>
		{/if}
	</header>

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	<!-- ⛔ ABOVE THE `{#if denied}` / loading / error CHAIN, DELIBERATELY, and not one branch of it.
	     Inside the chain this message would be mutually exclusive with the table it is a caveat ON,
	     which is the whole defect: the reader would lose the rows in order to be told the refresh of
	     those rows failed. `role="alert"` because it appears without the reader moving focus. -->
	{#if refreshError}
		<div class="notice error" role="alert" data-testid="audit-refresh-error">{refreshError}</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.audit_denied()}</div>
	{:else}
		<div class="filters">
			<div class="chips">
				{#each CHIPS as chip (chip.key)}
					<button class="chip" class:active={category === chip.key} onclick={() => setCategory(chip.key)}>
						{mm[chip.labelKey]()}
						<span class="chip-n">{num(countFor(chip.key), locale.current)}</span>
					</button>
				{/each}
			</div>
			<div class="filter-right">
				<select class="select" value={range} onchange={setRange}>
					<option value="today">{m.audit_range_today()}</option>
					<option value="7d">{m.audit_range_7d()}</option>
					<option value="30d">{m.audit_range_30d()}</option>
					<option value="all">{m.audit_range_all()}</option>
					<option value="custom">{m.audit_range_custom()}</option>
				</select>
				{#if range === 'custom'}
					<input class="select" type="date" aria-label={m.audit_custom_from()} bind:value={from} max={to || undefined} onchange={setCustomDates} />
					<input class="select" type="date" aria-label={m.audit_custom_to()} bind:value={to} min={from || undefined} onchange={setCustomDates} />
				{/if}
				<input class="input" placeholder={m.audit_filter_placeholder()} bind:value={q} oninput={onSearch} />
			</div>
		</div>

		<!-- ⚠️ `error` HERE IS THE FIRST-LOAD ERROR AND NOTHING ELSE — see its declaration. This branch
		     is mutually exclusive with the table below it, which is only defensible because a feed
		     that never loaded has no table to take away. Every LATER failure goes to `refreshError`,
		     rendered above this block. -->
		{#if loading && !feed}
			<div class="notice">{m.audit_loading()}</div>
		{:else if error}
			<div class="notice error">{error}</div>
		{:else if feed && items.length === 0}
			<div class="notice">{m.audit_empty()}</div>
		{:else if feed}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th><button class="th-sort" onclick={() => toggleSort('time')} aria-label={m.audit_col_time()}>{m.audit_col_time()}{sortIndicator('time')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('actor')} aria-label={m.audit_col_actor()}>{m.audit_col_actor()}{sortIndicator('actor')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('event')} aria-label={m.audit_col_event()}>{m.audit_col_event()}{sortIndicator('event')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('target')} aria-label={m.audit_col_target()}>{m.audit_col_target()}{sortIndicator('target')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('result')} aria-label={m.audit_col_result()}>{m.audit_col_result()}{sortIndicator('result')}</button></th>
						</tr>
					</thead>
					<tbody>
						{#each sortedItems as item (item.id)}
							<AuditRow {item} />
						{/each}
					</tbody>
				</table>
			</div>
			<div class="foot">
				<span class="count">{m.audit_event_count({ count: feed.total })}</span>
				<!-- ⛔ `loadedKey === queryKey`, NOT a "did the last load fail" flag. The rows must belong
				     to the query the filters currently describe before this button can extend them —
				     which is false after a failed page-1 load, while one is in flight, and while a search
				     keystroke is still inside its debounce. All three would otherwise splice window 2 of
				     the new query onto the old rows. -->
				{#if page < totalPages && loadedKey === queryKey}
					<button class="btn-ghost" onclick={loadMore} disabled={loading}>{m.audit_load_more()}</button>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.page {
		max-width: 1180px;
	}
	.page-head {
		margin-bottom: 20px;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.btn-export {
		flex-shrink: 0;
		border: 1px solid var(--c-border-strong);
		background: var(--c-white);
		border-radius: var(--r);
		padding: 8px 14px;
		font-size: 13px;
		font-weight: 500;
		color: var(--c-ink);
		cursor: pointer;
		font-family: inherit;
		white-space: nowrap;
	}
	.btn-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal);
		margin-bottom: 6px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		color: var(--c-midnight);
		margin: 0 0 4px;
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
	}
	.filters {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}
	.chips {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.chip {
		padding: 5px 12px;
		border-radius: 6px;
		border: 1px solid var(--c-border);
		background: var(--c-white);
		font-size: 12.5px;
		color: var(--c-ink);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: inherit;
	}
	.chip.active {
		background: var(--c-teal);
		border-color: var(--c-teal);
		color: #fff;
	}
	.chip-n {
		font-size: 10.5px;
		opacity: 0.8;
		font-variant-numeric: tabular-nums;
	}
	.filter-right {
		display: flex;
		gap: 8px;
	}
	.select,
	.input {
		border: 1px solid var(--c-border-strong);
		border-radius: var(--r);
		padding: 7px 10px;
		font-size: 13px;
		font-family: inherit;
		color: var(--c-ink);
		background: var(--c-white);
	}
	.input {
		width: 200px;
	}
	.table-wrap {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		overflow: hidden;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	thead th {
		text-align: start;
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		padding: 0;
		border-bottom: 1px solid var(--c-border);
		background: var(--c-surface);
	}
	.th-sort {
		width: 100%;
		text-align: start;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
		background: none;
		border: none;
		padding: 11px 12px;
		cursor: pointer;
		white-space: nowrap;
	}
	.th-sort:hover {
		color: var(--c-ink);
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 14px;
	}
	.count {
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.btn-ghost {
		border: 1px solid var(--c-border-strong);
		background: var(--c-white);
		border-radius: var(--r);
		padding: 7px 14px;
		font-size: 13px;
		color: var(--c-ink);
		cursor: pointer;
		font-family: inherit;
	}
	.btn-ghost:disabled {
		opacity: 0.5;
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
</style>
