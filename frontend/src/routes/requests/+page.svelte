<script lang="ts">
	// /requests (W8/P5) — the approval queue for members' requests about a challenge's information:
	// "missing information" and uploaded example records. Under /settings → Organisation, for
	// tenant_admin and developer (super_admin passes too).
	//
	// ⛔ APPROVING WRITES NOTHING BUT THE DECISION. It then opens the EXISTING screen — /ontology's
	// create-entity form or /datasets' create drawer — prefilled from the request, and the approver
	// creates the entity / dataset there, through the same gated calls as always.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { auth } from '$lib/stores/auth.svelte';
	import {
		informationRequestsApi,
		ApiError,
		type InformationRequest,
		type InformationRequestDetail
	} from '$lib/api/information-requests';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import { num, timeAgo } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';

	let filter = $state<'pending' | 'all'>('pending');
	let items = $state<InformationRequest[]>([]);
	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let open = $state<string | null>(null);
	let detail = $state<InformationRequestDetail | null>(null);
	let detailError = $state<string | null>(null);
	let rejecting = $state<string | null>(null);
	let note = $state('');
	let busy = $state(false);
	let actionError = $state<string | null>(null);

	async function load() {
		// The server refuses a non-reviewer anyway (403); do not ask.
		if (!auth.isDeveloper) {
			loading = false;
			return;
		}
		loadError = null;
		denied = false;
		loading = true;
		try {
			const r = await informationRequestsApi.list(filter);
			items = r.items;
			// Keep the sidebar badge in step with what this page just counted.
			if (auth.user?.counts) auth.user.counts = { ...auth.user.counts, requests: r.pendingCount };
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.challenge_request_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);
	reloadOnLocaleChange(load);

	function setFilter(f: 'pending' | 'all') {
		filter = f;
		open = null;
		void load();
	}

	async function toggle(id: string) {
		if (open === id) {
			open = null;
			return;
		}
		open = id;
		detail = null;
		detailError = null;
		rejecting = null;
		actionError = null;
		try {
			const d = await informationRequestsApi.get(id);
			if (open === id) detail = d;
		} catch (e) {
			if (open === id) detailError = errorText(e, m.challenge_request_load_failed());
		}
	}

	async function approve(r: InformationRequest) {
		if (busy) return;
		busy = true;
		actionError = null;
		try {
			const res = await informationRequestsApi.approve(r.id);
			// The decision is recorded; the entity / dataset is created on the existing screen.
			await goto(res.next.href);
		} catch (e) {
			actionError = writeErrorText(e, m.requests_action_failed());
			await load();
		} finally {
			busy = false;
		}
	}

	async function reject(r: InformationRequest) {
		if (busy || !note.trim()) return;
		busy = true;
		actionError = null;
		try {
			await informationRequestsApi.reject(r.id, note.trim());
			rejecting = null;
			note = '';
			open = null;
			await load();
		} catch (e) {
			actionError = writeErrorText(e, m.requests_action_failed());
		} finally {
			busy = false;
		}
	}

	function statusLabel(s: InformationRequest['status']): string {
		return s === 'approved'
			? m.challenge_request_status_approved()
			: s === 'rejected'
				? m.challenge_request_status_rejected()
				: m.challenge_request_status_pending();
	}
</script>

<div class="page">
	<h1>{m.requests_title()}</h1>
	<p class="intro">{m.requests_intro()}</p>

	{#if !auth.isDeveloper || denied}
		<p class="notice">{m.requests_denied()}</p>
	{:else}
		<div class="chips" role="group">
			<button class="chip" class:active={filter === 'pending'} onclick={() => setFilter('pending')}>{m.challenge_request_status_pending()}</button>
			<button class="chip" class:active={filter === 'all'} onclick={() => setFilter('all')}>{m.requests_filter_all()}</button>
		</div>

		{#if loadError}
			<p class="error" role="alert">{loadError} <button class="link" onclick={load}>{m.error_load_retry()}</button></p>
		{:else if loading && !items.length}
			<p class="muted">…</p>
		{:else if items.length === 0}
			<p class="notice" data-testid="requests-empty">{m.requests_empty()}</p>
		{:else}
			<ul class="list" data-testid="requests-list">
				{#each items as r (r.id)}
					<li class="item" data-request-id={r.id}>
						<button class="row" onclick={() => toggle(r.id)} aria-expanded={open === r.id}>
							<span class="name">{r.name}</span>
							<span class="kind">{r.kind === 'missing_information' ? m.challenge_request_kind_missing() : m.challenge_request_kind_records()}</span>
							<span class="status st-{r.status}">{statusLabel(r.status)}</span>
						</button>
						<div class="meta">
							{m.requests_from({ name: r.createdByName ?? '—', challenge: r.challengeTitle ?? '—' })} · {timeAgo(r.createdAt)}
						</div>
						{#if open === r.id}
							<div class="detail">
								{#if detailError}
									<p class="error" role="alert">{detailError}</p>
								{:else if detail && detail.id === r.id}
									{#if detail.description}<p>{detail.description}</p>{/if}
									{#if detail.fieldNames.length}
										<p class="muted">{m.requests_fields()}: {detail.fieldNames.join(', ')}</p>
									{/if}
									{#if detail.kind === 'example_records'}
										<p class="muted">{detail.fileName} · {num(detail.rowCount ?? 0, locale.current)} {m.connectors_rows_word()}</p>
										<DatasetPreviewTable
											columns={detail.columns.map((c) => ({ name: c.name, type: c.type as never }))}
											rows={detail.rows}
											maxRows={20}
											totalRows={detail.rowCount ?? detail.rows.length}
										/>
									{/if}
									{#if detail.reviewNote}<p class="muted">{m.challenge_request_note({ note: detail.reviewNote })}</p>{/if}
									{#if detail.status === 'pending'}
										{#if rejecting === r.id}
											<label class="field">
												<span>{m.requests_reject_note()}</span>
												<textarea rows="3" maxlength="2000" bind:value={note} data-testid="reject-note"></textarea>
											</label>
											<div class="actions">
												<button class="btn-ghost" onclick={() => (rejecting = null)}>{m.challenge_data_cancel()}</button>
												<button class="btn-danger" disabled={busy || !note.trim()} onclick={() => reject(r)} data-testid="reject-confirm">{m.requests_reject()}</button>
											</div>
										{:else}
											<div class="actions">
												<button class="btn-ghost" onclick={() => { rejecting = r.id; note = ''; }} data-testid="reject">{m.requests_reject()}</button>
												<button class="btn-primary" disabled={busy} onclick={() => approve(r)} data-testid="approve">{m.requests_approve()}</button>
											</div>
											<p class="muted small">{r.kind === 'missing_information' ? m.requests_approve_hint_entity() : m.requests_approve_hint_dataset()}</p>
										{/if}
									{/if}
									{#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
								{:else}
									<p class="muted">…</p>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.page {
		max-width: 880px;
	}
	h1 {
		font-size: 28px;
		margin: 0 0 6px;
		color: var(--c-midnight);
	}
	.intro {
		color: var(--c-muted);
		margin: 0 0 18px;
		font-size: 14px;
	}
	.chips {
		display: flex;
		gap: 6px;
		margin-bottom: 14px;
	}
	.chip {
		font-size: 12.5px;
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--c-border);
		background: var(--c-white);
		cursor: pointer;
	}
	.chip.active {
		border-color: var(--c-teal-mid);
		color: var(--c-teal-dark);
		background: var(--c-teal-pale, var(--c-surface));
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.item {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 12px 16px;
	}
	.row {
		display: flex;
		gap: 10px;
		align-items: center;
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: start;
		font: inherit;
	}
	.name {
		font-weight: 600;
		color: var(--c-ink);
		flex: 1;
	}
	.kind {
		font-size: 12px;
		color: var(--c-muted);
	}
	.status {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--c-surface);
		color: var(--c-muted);
	}
	.st-approved {
		color: var(--c-teal-dark);
	}
	.st-rejected {
		color: var(--c-coral-dark, #b42318);
	}
	.meta {
		font-size: 12px;
		color: var(--c-faint);
		margin-top: 4px;
	}
	.detail {
		margin-top: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
	}
	.detail p {
		margin: 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
	}
	.field textarea {
		font: inherit;
		padding: 6px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
	}
	.actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	.btn-ghost,
	.btn-primary,
	.btn-danger {
		font-size: 12.5px;
		padding: 7px 14px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.btn-ghost {
		background: none;
		border: 1px solid var(--c-border);
		color: var(--c-ink);
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		border: none;
		font-weight: 600;
	}
	.btn-danger {
		background: var(--c-coral, #d92d20);
		color: #fff;
		border: none;
		font-weight: 600;
	}
	.btn-primary:disabled,
	.btn-danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.muted {
		color: var(--c-muted);
	}
	.small {
		font-size: 12px;
	}
	.error {
		color: var(--c-coral-dark, #b42318);
		font-size: 13px;
	}
	.link {
		background: none;
		border: none;
		color: var(--c-teal-dark);
		cursor: pointer;
		text-decoration: underline;
	}
	.notice {
		padding: 24px;
		color: var(--c-muted);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
</style>
