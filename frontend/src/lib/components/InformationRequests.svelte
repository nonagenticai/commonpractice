<script lang="ts">
	// W8/P5 on the challenge page: a member asks for missing information or adds a few example
	// records, and sees their own requests with each one's status. An admin or developer reviews them
	// on /requests. Nothing here writes the ontology or a dataset — a request is only a request.
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import { informationRequestsApi, type InformationRequest } from '$lib/api/information-requests';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	let { challengeId }: { challengeId: string } = $props();

	let items = $state<InformationRequest[]>([]);
	let loadError = $state<string | null>(null);
	let mode = $state<'missing' | 'upload' | null>(null);
	let busy = $state(false);
	let sendError = $state<string | null>(null);
	let sent = $state(false);

	// The "missing information" form.
	let name = $state('');
	let description = $state('');
	let fields = $state('');
	// The example-records form.
	let file = $state<File | null>(null);
	let fileName = $state('');

	async function load() {
		try {
			items = (await informationRequestsApi.forChallenge(challengeId)).items;
			loadError = null;
		} catch (e) {
			loadError = errorText(e, m.challenge_request_load_failed());
		}
	}
	onMount(load);

	function open(next: 'missing' | 'upload') {
		mode = next;
		sendError = null;
		sent = false;
		name = '';
		description = '';
		fields = '';
		file = null;
		fileName = '';
	}

	async function send() {
		if (busy) return;
		busy = true;
		sendError = null;
		try {
			if (mode === 'missing') {
				if (!name.trim()) return;
				const fieldNames = fields
					.split(',')
					.map((f) => f.trim())
					.filter(Boolean);
				await informationRequestsApi.requestMissing(challengeId, {
					name: name.trim(),
					...(description.trim() ? { description: description.trim() } : {}),
					...(fieldNames.length ? { fieldNames } : {})
				});
			} else if (mode === 'upload') {
				if (!file) return;
				await informationRequestsApi.uploadRecords(challengeId, file, fileName.trim() || undefined);
			}
			mode = null;
			sent = true;
			await load();
		} catch (e) {
			sendError = writeErrorText(e, m.challenge_request_failed());
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

<div class="card" data-testid="requests-card">
	<h2>{m.challenge_request_title()}</h2>
	<p class="hint">{m.challenge_request_help()}</p>
	{#if mode === null}
		<div class="req-actions">
			<button type="button" class="btn-ghost" data-testid="request-missing" onclick={() => open('missing')}>{m.challenge_request_missing()}</button>
			<button type="button" class="btn-ghost" data-testid="request-upload" onclick={() => open('upload')}>{m.challenge_request_upload()}</button>
		</div>
		{#if sent}<p class="req-sent" role="status" data-testid="request-sent">{m.challenge_request_sent()}</p>{/if}
	{:else}
		<form
			class="req-form"
			data-testid={mode === 'missing' ? 'request-missing-form' : 'request-upload-form'}
			onsubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			{#if mode === 'missing'}
				<label class="field">
					<span>{m.challenge_request_name()}</span>
					<input type="text" maxlength="120" bind:value={name} required data-testid="request-name" />
				</label>
				<label class="field">
					<span>{m.challenge_request_description()}</span>
					<textarea rows="3" maxlength="2000" bind:value={description} data-testid="request-description"></textarea>
				</label>
				<label class="field">
					<span>{m.challenge_request_fields()}</span>
					<input type="text" bind:value={fields} data-testid="request-fields" />
				</label>
			{:else}
				<p class="req-warn">{m.challenge_request_upload_hint()}</p>
				<label class="field">
					<span>{m.challenge_request_file()}</span>
					<input
						type="file"
						accept=".csv,.xlsx,.xls"
						data-testid="request-file"
						onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
					/>
				</label>
				<label class="field">
					<span>{m.challenge_request_name()}</span>
					<input type="text" maxlength="120" bind:value={fileName} data-testid="request-file-name" />
				</label>
			{/if}
			<div class="req-actions">
				<button type="button" class="btn-ghost" onclick={() => (mode = null)}>{m.challenge_data_cancel()}</button>
				<button
					type="submit"
					class="btn-primary"
					data-testid="request-send"
					disabled={busy || (mode === 'missing' ? !name.trim() : !file)}
				>{busy ? m.challenge_request_sending() : m.challenge_request_send()}</button>
			</div>
		</form>
	{/if}
	{#if sendError}<p class="req-error" role="alert">{sendError}</p>{/if}

	{#if loadError}
		<p class="req-error" role="alert">{loadError}</p>
	{:else if items.length}
		<ul class="req-list" data-testid="request-list">
			{#each items as r (r.id)}
				<li class="req-item" data-request-id={r.id}>
					<div class="req-row">
						<span class="req-name">{r.name}</span>
						<span class="req-status req-{r.status}" data-testid="request-status">{statusLabel(r.status)}</span>
					</div>
					<div class="req-meta">
						{r.kind === 'missing_information' ? m.challenge_request_kind_missing() : m.challenge_request_kind_records()}
						{#if r.kind === 'example_records' && r.rowCount !== null}· {num(r.rowCount, locale.current)} {m.connectors_rows_word()}{/if}
					</div>
					{#if r.reviewNote}<p class="req-note">{m.challenge_request_note({ note: r.reviewNote })}</p>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	/* The challenge page's card + button look, restated: its styles are scoped to the page. */
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 18px 20px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		margin: 0 0 8px;
		color: var(--c-midnight);
	}
	.btn-ghost {
		font-size: 12.5px;
		color: var(--c-teal-dark);
		background: none;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 6px 12px;
		cursor: pointer;
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 12.5px;
		padding: 7px 14px;
		border-radius: var(--r);
		border: none;
		cursor: pointer;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.hint {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0 0 10px;
	}
	.req-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.req-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		color: var(--c-ink);
	}
	.field input[type='text'],
	.field textarea {
		font: inherit;
		padding: 6px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
	}
	.req-warn {
		margin: 0;
		font-size: 12.5px;
		color: var(--c-amber-dark, var(--c-ink));
	}
	.req-sent {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--c-teal-dark);
	}
	.req-error {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--c-coral-dark, #b42318);
	}
	.req-list {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.req-item {
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		padding: 8px 10px;
	}
	.req-row {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
	}
	.req-name {
		font-weight: 600;
		font-size: 13px;
	}
	.req-status {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--c-surface);
		color: var(--c-muted);
	}
	.req-approved {
		color: var(--c-teal-dark);
	}
	.req-rejected {
		color: var(--c-coral-dark, #b42318);
	}
	.req-meta {
		font-size: 11.5px;
		color: var(--c-faint);
		margin-top: 2px;
	}
	.req-note {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--c-ink);
	}
</style>
