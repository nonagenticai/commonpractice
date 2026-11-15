<script lang="ts">
	// Platform Ops "All sandboxes" — the `sandboxes` screen (demo.html:3177–3401).
	// Lists every user's persistent sandbox with derived cost/usage. Pause/Resume
	// (in the inspect drawer) are the governable lever: a suspended sandbox blocks
	// that user's Test runs (enforced in the backend run path).
	import { onMount } from 'svelte';
	import { sandboxesApi, ApiError } from '$lib/api/sandboxes';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { SandboxList, SandboxDetail, SandboxStatus } from '$lib/types/sandboxes';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import DotStatus from '$lib/components/ui/DotStatus.svelte';
	// The run-history drawer speaks `flow_run_status`, a DIFFERENT enum from the `SandboxStatus`
	// DotStatus renders — see the header of run-status-label.ts for why the two are not merged.
	import { runStatusLabel } from '$lib/i18n/run-status-label';
	// usdEstimated, not usd: these figures come from `usage_counters.spend_usd`, a running
	// per-user/day scalar that carries no per-call `price_source`, so — unlike /usage — there is no
	// way to tell whether any part of the total was flat-estimated. Rendering them as a bare `$`
	// claimed a precision the number does not have; hedging is the only honest option until
	// usage_counters itself carries provenance.
	import { usdEstimated, gb, timeAgo, num, ms } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	// The nav table is the single fact about who may reach this screen — see the `canProvision`
	// comment below for why the header action reads it instead of spelling 'super_admin' again.
	import { canReachNav } from '$lib/layout/navConfig';
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';
	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	let list = $state<SandboxList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// A failed ACTION (inspect/pause/resume/provision), kept separate from `error` (the LOAD error).
	// `error` renders inside the `{#if loading}…{:else if error}` chain below, which is mutually
	// exclusive with the sandbox table — so writing a button failure there replaced the whole page
	// the message was supposed to explain. This one renders ABOVE the outer `{#if denied}` and
	// leaves the table in place. NOT folded into `flash`: that one is success-coloured and
	// auto-clears after 4s. Same pattern as `voteError` on the challenge pages (#210).
	let actionError = $state<string | null>(null);
	let denied = $state(false);
	// ⛔ "Provision sandbox" lives in the page HEAD, which renders ABOVE the `{#if denied}` arm — so
	// the one control that WRITES stayed on screen, at full opacity, for exactly the reader the
	// server had just refused, and answered a 403 on click. `POST /api/sandboxes` is
	// `requireSuperAdmin` (routes/sandboxes.ts:312), the same gate the nav item carries, so the
	// button asks `canReachNav` rather than spelling 'super_admin' a second time (navConfig.ts).
	// `!denied` is ANDed in so a server that refuses us for a reason the token does not show
	// (an unprovisioned tenant, a revoked role) also takes the button away.
	const canProvision = $derived(!denied && canReachNav('/sandboxes', auth.user?.roles ?? []));
	// Transient success confirmation (e.g. after provisioning), auto-dismissed.
	let flash = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	function showFlash(text: string) {
		flash = text;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 4000);
	}

	let activeStatus = $state<SandboxStatus | 'all'>('all');
	let q = $state('');
	let page = $state(1);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// Client-side column sort over the loaded page (server paginates; sorting the
	// current set is enough and mirrors the audit/usage sort affordance).
	type SortKey = 'user' | 'project' | 'status' | 'started' | 'mem' | 'llm' | 'spend';
	let sortKey = $state<SortKey | null>(null);
	let sortDir = $state<'asc' | 'desc'>('asc');
	function toggleSort(k: SortKey) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			sortDir = 'asc';
		}
	}
	const sortedItems = $derived.by(() => {
		const items = list?.items ?? [];
		if (!sortKey) return items;
		const dir = sortDir === 'asc' ? 1 : -1;
		const val = (s: (typeof items)[number]) => {
			switch (sortKey) {
				case 'user':
					return s.owner.name.toLowerCase();
				case 'project':
					return (s.project ?? '').toLowerCase();
				case 'status':
					return s.status;
				case 'started':
					return Date.parse(s.startedAt ?? '') || 0;
				case 'mem':
					return s.memCapMb;
				case 'llm':
					return s.llmCallsToday;
				case 'spend':
					return s.costTodayUsd;
			}
		};
		return [...items].sort((a, b) => {
			const av = val(a)!;
			const bv = val(b)!;
			return av < bv ? -dir : av > bv ? dir : 0;
		});
	});
	const sortIcon = (k: SortKey) => (sortKey !== k ? '' : sortDir === 'asc' ? ' ↑' : ' ↓');

	// Inspect drawer.
	let selected = $state<SandboxDetail | null>(null);
	let drawerLoading = $state(false);
	let actionBusy = $state(false);

	const TABS: { key: SandboxStatus | 'all'; labelKey: string }[] = [
		{ key: 'all', labelKey: 'sandboxes_tab_all' },
		{ key: 'running', labelKey: 'sandboxes_tab_running' },
		{ key: 'idle', labelKey: 'sandboxes_tab_idle' },
		{ key: 'suspended', labelKey: 'sandboxes_tab_suspended' },
		{ key: 'error', labelKey: 'sandboxes_tab_error' }
	];
	function tabCount(key: SandboxStatus | 'all'): number {
		if (!list) return 0;
		return key === 'all' ? list.counts.all : list.counts[key];
	}

	const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			list = await sandboxesApi.list({ status: activeStatus, q: q.trim() || undefined, page });
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	function setStatus(key: SandboxStatus | 'all') {
		activeStatus = key;
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
	function goPage(p: number) {
		page = Math.min(Math.max(1, p), totalPages);
		load();
	}

	function actionLabel(status: SandboxStatus): string {
		if (status === 'suspended') return m.sandboxes_action_resume();
		if (status === 'error') return m.sandboxes_action_debug();
		return m.sandboxes_action_inspect();
	}

	async function inspect(id: string) {
		actionError = null;
		drawerLoading = true;
		selected = null;
		try {
			selected = await sandboxesApi.get(id);
		} catch (e) {
			actionError = errorText(e, m.error_load_failed());
		} finally {
			drawerLoading = false;
		}
	}
	function closeDrawer() {
		selected = null;
	}

	async function pause() {
		if (!selected) return;
		actionError = null;
		actionBusy = true;
		try {
			await sandboxesApi.pause(selected.id);
			await Promise.all([inspect(selected.id), load()]);
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		} finally {
			actionBusy = false;
		}
	}
	async function resume() {
		if (!selected) return;
		actionError = null;
		actionBusy = true;
		try {
			await sandboxesApi.resume(selected.id);
			await Promise.all([inspect(selected.id), load()]);
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		} finally {
			actionBusy = false;
		}
	}
	async function provision() {
		actionError = null;
		actionBusy = true;
		try {
			await sandboxesApi.provision();
			page = 1;
			await load();
			showFlash(m.sandboxes_provisioned());
		} catch (e) {
			actionError = writeErrorText(e, m.error_action_failed());
		} finally {
			actionBusy = false;
		}
	}

	onMount(() => {
		// Honor a ?status= deep-link (from it-dash alerts, pipeline, etc.).
		const urlStatus = new URLSearchParams(window.location.search).get('status');
		const valid: (SandboxStatus | 'all')[] = ['all', 'running', 'idle', 'suspended', 'error'];
		if (urlStatus && (valid as string[]).includes(urlStatus)) {
			activeStatus = urlStatus as SandboxStatus | 'all';
		}
		load();
	});
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.sandboxes_eyebrow()}</div>
			<h1>{m.sandboxes_title()}</h1>
			<p>{m.sandboxes_subtitle()}</p>
		</div>
		<div class="head-actions">
			{#if canProvision}
				<button class="btn-primary" onclick={provision} disabled={actionBusy}>{m.sandboxes_provision()}</button>
			{/if}
		</div>
	</header>

	{#if flash}
		<div class="flash-ok">{flash}</div>
	{/if}

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.sandboxes_denied()}</div>
	{:else}
		<div class="filter-bar">
			<div class="chips">
				{#each TABS as t (t.key)}
					<button class="chip" class:active={activeStatus === t.key} onclick={() => setStatus(t.key)}>
						{mm[t.labelKey]()} <span class="chip-count">{num(tabCount(t.key), locale.current)}</span>
					</button>
				{/each}
			</div>
			<input class="search" placeholder={m.sandboxes_search_placeholder()} bind:value={q} oninput={onSearch} />
		</div>

		{#if loading && !list}
			<div class="notice">{m.sandboxes_loading()}</div>
		{:else if error}
			<div class="notice error">{error}</div>
		{:else if list && list.items.length === 0}
			<div class="notice">{m.sandboxes_empty()}</div>
		{:else if list}
			<div class="table-wrap" class:dim={loading}>
				<table>
					<thead>
						<tr>
							<th><button class="th-sort" onclick={() => toggleSort('user')}>{m.sandboxes_col_user()}{sortIcon('user')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('project')}>{m.sandboxes_col_project()}{sortIcon('project')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('status')}>{m.sandboxes_col_status()}{sortIcon('status')}</button></th>
							<th><button class="th-sort" onclick={() => toggleSort('started')}>{m.sandboxes_col_started()}{sortIcon('started')}</button></th>
							<th class="num"><button class="th-sort num" onclick={() => toggleSort('mem')}>{m.sandboxes_col_mem()}{sortIcon('mem')}</button></th>
							<th class="num"><button class="th-sort num" onclick={() => toggleSort('llm')}>{m.sandboxes_col_llm_calls()}{sortIcon('llm')}</button></th>
							<th class="num" title={m.spend_estimate_hint()}><button class="th-sort num" onclick={() => toggleSort('spend')}>{m.sandboxes_col_spend_today()}{sortIcon('spend')}</button></th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each sortedItems as s (s.id)}
							<tr>
								<td>
									<div class="user-cell">
										<Avatar initials={s.owner.initials} size={26} />
										<div>
											<div class="user-name">{s.owner.name}</div>
											<div class="sb-slug">{s.slug}</div>
										</div>
									</div>
								</td>
								<td>{#if s.project}<span class="badge teal">{s.project}</span>{:else}<span class="muted">—</span>{/if}</td>
								<td><DotStatus status={s.status} /></td>
								<td class="muted">{timeAgo(s.startedAt)}</td>
								<td class="num muted">{gb(s.memCapMb, locale.current)}</td>
								<td class="num">{num(s.llmCallsToday, locale.current)}</td>
								<td class="num">{usdEstimated(s.costTodayUsd, locale.current)}</td>
								<td class="num">
									<button class="btn-sm" class:danger={s.status === 'error'} onclick={() => inspect(s.id)}>
										{actionLabel(s.status)}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="pager">
				<span class="pager-info">{m.sandboxes_pager_showing({ shown: num(list.items.length, locale.current), total: num(list.total, locale.current) })}</span>
				<div class="pager-btns">
					<button class="btn-sm" disabled={page <= 1} onclick={() => goPage(page - 1)}>{m.sandboxes_pager_prev()}</button>
					<span class="pager-page">{m.sandboxes_pager_page({ page, totalPages })}</span>
					<button class="btn-sm" disabled={page >= totalPages} onclick={() => goPage(page + 1)}>{m.sandboxes_pager_next()}</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Inspect drawer -->
{#if selected || drawerLoading}
	<div
		class="scrim"
		role="button"
		tabindex="0"
		aria-label={m.sandboxes_close_inspector()}
		onclick={closeDrawer}
		onkeydown={(e) => e.key === 'Escape' && closeDrawer()}
	></div>
	<aside class="drawer">
		{#if drawerLoading || !selected}
			<div class="drawer-pad">{m.sandboxes_drawer_loading()}</div>
		{:else}
			<header class="drawer-head">
				<div class="user-cell">
					<Avatar initials={selected.owner.initials} size={34} />
					<div>
						<div class="drawer-name">{selected.owner.name}</div>
						<div class="sb-slug">{selected.slug}</div>
					</div>
				</div>
				<button class="icon-x" onclick={closeDrawer} aria-label={m.sandboxes_close()}>✕</button>
			</header>

			<div class="drawer-meta">
				<div><span class="k">{m.sandboxes_meta_status()}</span><DotStatus status={selected.status} /></div>
				<div><span class="k">{m.sandboxes_meta_project()}</span><span>{selected.project ?? '—'}</span></div>
				<div><span class="k">{m.sandboxes_meta_region()}</span><span>{selected.region}</span></div>
				<div><span class="k">{m.sandboxes_meta_mem_cap()}</span><span>{gb(selected.memCapMb, locale.current)}</span></div>
				<div><span class="k">{m.sandboxes_meta_llm_calls_today()}</span><span>{num(selected.llmCallsToday, locale.current)}</span></div>
				<div><span class="k">{m.sandboxes_meta_spend_today()}</span><span>{usdEstimated(selected.costTodayUsd, locale.current)}</span></div>
			</div>

			<div class="drawer-actions">
				{#if selected.status === 'suspended' || selected.status === 'error'}
					<button class="btn-primary" onclick={resume} disabled={actionBusy}>{m.sandboxes_resume_sandbox()}</button>
				{:else}
					<button class="btn-danger" onclick={pause} disabled={actionBusy}>{m.sandboxes_pause_sandbox()}</button>
				{/if}
				<span class="action-note">
					{#if selected.status === 'suspended'}{m.sandboxes_note_suspended()}{:else}{m.sandboxes_note_pausing()}{/if}
				</span>
			</div>

			<div class="drawer-section">{m.sandboxes_recent_runs()}</div>
			{#if selected.recentRuns.length === 0}
				<p class="empty drawer-pad">{m.sandboxes_no_runs()}</p>
			{:else}
				<ul class="runs">
					{#each selected.recentRuns as r (r.id)}
						<li>
							<div class="run-main">
								<span class="run-flow">{r.flowName}</span>
								<!-- The class stays the RAW enum (it selects the colour); only the text is
								     localized. -->
								<span class="run-status {r.status}">{runStatusLabel(r.status)}</span>
							</div>
							<!-- `llm` was a hard-coded English unit sitting inside an otherwise localized
								     meta line. It is a COUNT of brokered model calls.
								     ⛔ DELIBERATELY "LLM calls: {count}", NOT "{count} LLM calls". An earlier
								     version used the latter with no plural machinery at all, so a one-call run
								     rendered "1 LLM calls" / "1 LLM-aanroepen" in the five Latin locales — a
								     NEW grammatical error introduced by a fix. The label:value form is
								     count-agnostic in every language and is what pl/ar/he already did.
								     ⚠️ CORRECTED: the version of this comment that shipped alongside the ICU
								     number fix claimed there is "not a single ICU plural anywhere in these
								     catalogs (`grep -c 'plural,' messages/en.json` → 0)". That grep counts the
								     MessageFormat-1 spelling, which inlang does not use; there are TEN real
								     plural messages here, each declaring `local countPlural = count: plural`
								     (see lib/i18n/icu-number-params.test.ts). Converting this key to a plural is
								     therefore available — a copy decision, not a blocked one.
								     This key stays PLAIN, which is why its count takes `num()` at the call site
								     (mechanism A) instead of a `countNum` local in the catalog.
								     ⛔ AND IT IS WHY IT IS WRAPPED AT ALL: the table at :289 and the detail
								     pane at :344 on THIS SCREEN already render `num(s.llmCallsToday,
								     locale.current)`. Left raw, one Dutch page showed "1.207" in the table and
								     "LLM-aanroepen: 1207" in the run list — two spellings of one quantity, which
								     is the same self-contradiction connectors/+page.svelte shipped. -->
							<div class="run-meta">{ms(r.totalMs, locale.current)} · {usdEstimated(r.costUsd, locale.current)} · {m.sandboxes_run_llm_calls({ count: num(r.llmCalls, locale.current) })} · {timeAgo(r.finishedAt ?? r.startedAt)}</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</aside>
{/if}

<style>
	.page {
		max-width: 1180px;
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
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
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
	.search {
		font-size: 12.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
		width: 280px;
		max-width: 100%;
	}
	.table-wrap {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		overflow: hidden;
		transition: opacity 0.12s;
	}
	.table-wrap.dim {
		opacity: 0.6;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th {
		text-align: start;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		padding: 12px 16px;
		border-bottom: 1px solid var(--c-border);
		background: var(--c-surface);
	}
	.th-sort {
		all: unset;
		cursor: pointer;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
		white-space: nowrap;
	}
	.th-sort:hover {
		color: var(--c-ink);
	}
	.th-sort.num {
		display: block;
		text-align: end;
	}
	td {
		padding: 12px 16px;
		font-size: 13px;
		color: var(--c-ink);
		border-bottom: 1px solid var(--c-border);
		vertical-align: middle;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	tbody tr:hover {
		background: var(--c-surface);
	}
	.num {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}
	.muted {
		color: var(--c-muted);
	}
	.user-cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.user-name {
		font-weight: 500;
		color: var(--c-ink);
	}
	.sb-slug {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-muted);
		margin-top: 1px;
	}
	.badge {
		font-size: 11px;
		font-weight: 500;
		padding: 3px 9px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
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
	.btn-sm:hover:not(:disabled) {
		border-color: var(--c-border-strong);
	}
	.btn-sm:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn-sm.danger {
		color: var(--c-rose);
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
	.pager-page {
		font-variant-numeric: tabular-nums;
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
	.flash-ok {
		margin-bottom: 14px;
		padding: 10px 14px;
		font-size: 13px;
		border-radius: var(--r);
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
	}
	.empty {
		color: var(--c-muted);
		font-size: 12.5px;
	}

	/* Drawer */
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(11, 20, 55, 0.32);
		z-index: 40;
	}
	.drawer {
		position: fixed;
		top: 0;
		inset-inline-end: 0;
		bottom: 0;
		width: 420px;
		max-width: 92vw;
		background: var(--c-white);
		border-inline-start: 1px solid var(--c-border);
		box-shadow: var(--sh-lg);
		z-index: 41;
		overflow-y: auto;
		padding: 20px 22px;
	}
	.drawer-pad {
		color: var(--c-muted);
		font-size: 13px;
		padding: 12px 0;
	}
	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 18px;
	}
	.drawer-name {
		font-weight: 600;
		font-size: 15px;
		color: var(--c-midnight);
	}
	.icon-x {
		background: none;
		border: none;
		font-size: 16px;
		color: var(--c-muted);
		cursor: pointer;
		padding: 4px;
	}
	.drawer-meta {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px 16px;
		padding: 14px 0;
		border-top: 1px solid var(--c-border);
		border-bottom: 1px solid var(--c-border);
	}
	.drawer-meta > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 13px;
		color: var(--c-ink);
	}
	.drawer-meta .k {
		font-size: 11px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
	}
	.drawer-actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px 0;
	}
	.btn-danger {
		background: var(--c-rose);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		border: none;
	}
	.btn-danger:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.action-note {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.drawer-section {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 6px 0 8px;
	}
	.runs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.runs li {
		padding: 10px 0;
		border-bottom: 1px solid var(--c-border);
	}
	.runs li:last-child {
		border-bottom: none;
	}
	.run-main {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.run-flow {
		font-size: 13px;
		color: var(--c-ink);
		font-weight: 500;
	}
	.run-status {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.run-status.ok {
		color: var(--c-emerald);
	}
	.run-status.partial {
		color: var(--c-amber);
	}
	.run-status.failed {
		color: var(--c-rose);
	}
	.run-status.running {
		color: var(--c-teal);
	}
	.run-meta {
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 3px;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 720px) {
		.num.muted,
		th.num:nth-child(5) {
			display: none;
		}
	}
</style>
