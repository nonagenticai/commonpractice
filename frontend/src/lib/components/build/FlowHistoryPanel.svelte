<script lang="ts">
	// §3-H flow history drawer. Slides over the Build canvas; lists flow_snapshots
	// newest-first (AI edits + manual checkpoints + restores), lets the owner save a
	// checkpoint of the current graph and restore any prior snapshot. Restore is
	// gated by the readOnly flag the list endpoint returns (a solution-viewer can
	// look but not roll back). RTL-safe via logical properties.
	import { flowsApi } from '$lib/api/flows';
	import type { FlowSnapshotSummary } from '$lib/types/flows';
	import * as m from '$lib/paraglide/messages';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { flowSummaryLabel } from '$lib/i18n/flow-summary-label';

	let {
		flowId,
		open,
		onClose,
		onRestored,
		locked = false
	}: {
		flowId: string | null;
		open: boolean;
		onClose: () => void;
		onRestored: () => void;
		/** /build's effective read-only (`BuilderStore.locked`): a screen too narrow to edit on also
		 *  takes away checkpoint and restore, which write the flow as surely as an edit does. */
		locked?: boolean;
	} = $props();

	let items = $state<FlowSnapshotSummary[]>([]);
	let apiReadOnly = $state(false);
	const readOnly = $derived(apiReadOnly || locked);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let summaryInput = $state('');
	let loadedFor = $state<string | null>(null);

	async function load() {
		if (!flowId) return;
		loading = true;
		loadError = null;
		try {
			const res = await flowsApi.listSnapshots(flowId);
			items = res.items;
			apiReadOnly = res.readOnly;
			loadedFor = flowId;
		} catch (e) {
			loadError =
				errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	// Lazily (re)load whenever the drawer opens or the flow changes.
	$effect(() => {
		if (open && flowId && flowId !== loadedFor) void load();
	});

	async function checkpoint() {
		if (!flowId || busy || readOnly) return;
		busy = true;
		loadError = null;
		try {
			await flowsApi.checkpoint(flowId, summaryInput.trim() || undefined);
			summaryInput = '';
			await load();
		} catch (e) {
			loadError = writeErrorText(e, m.error_save_failed());
		} finally {
			busy = false;
		}
	}

	async function restore(s: FlowSnapshotSummary) {
		if (!flowId || busy || readOnly) return;
		if (!(await confirmDialog({ message: m.flow_history_restore_confirm() }))) return;
		busy = true;
		loadError = null;
		try {
			await flowsApi.restoreSnapshot(flowId, s.id);
			await load();
			onRestored();
		} catch (e) {
			loadError = writeErrorText(e, m.error_action_failed());
		} finally {
			busy = false;
		}
	}

	function fmtAgo(iso: string): string {
		const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
		if (secs < 60) return m.flow_history_ago_now();
		const mins = Math.round(secs / 60);
		if (mins < 60) return m.flow_history_ago_min({ count: mins });
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return m.flow_history_ago_hour({ count: hrs });
		return m.flow_history_ago_day({ count: Math.round(hrs / 24) });
	}
</script>

{#if open}
	<aside class="history" aria-label={m.flow_history_title()}>
		<header class="head">
			<span class="ttl">{m.flow_history_title()}</span>
			<button class="x" onclick={onClose} aria-label={m.flow_history_close()}>×</button>
		</header>

		{#if !readOnly}
			<div class="checkpoint">
				<input
					class="ck-input"
					placeholder={m.flow_history_checkpoint_placeholder()}
					bind:value={summaryInput}
					disabled={busy}
					maxlength="280"
				/>
				<button class="btn-primary" onclick={checkpoint} disabled={busy || !flowId}>
					{m.flow_history_checkpoint()}
				</button>
			</div>
		{/if}

		{#if loadError}
			<div class="err">{m.flow_history_load_failed({ error: loadError })}</div>
		{/if}

		<div class="list">
			{#if loading}
				<div class="muted">…</div>
			{:else if items.length === 0}
				<div class="muted">{m.flow_history_empty()}</div>
			{:else}
				{#each items as s (s.id)}
					<!-- `{@const}` must be an immediate child of the `{#each}`, so the label is bound here
					     and used twice below. -->
					{@const label = flowSummaryLabel(s, locale.current)}
					<div class="row">
						<div class="meta">
							<div class="top">
								<span class="badge {s.source === 'ai' ? 'ai' : 'manual'}">
									{s.source === 'ai' ? m.flow_history_source_ai() : m.flow_history_source_manual()}
								</span>
								<!--
									⛔ BOTH THE BODY AND THE TOOLTIP, FROM ONE `label`. `title=` used to render
									`s.summary` too, so the English leaked twice per row — and the tooltip is the
									copy a reader hovers precisely because the truncated body (`.sum` is
									`text-overflow: ellipsis`) cut the sentence off. Localizing only the visible half
									would have left the FULL English sentence one hover away, on the same element.
									One binding rather than two calls so the two halves cannot drift apart.
								-->
								<span class="sum" title={label}>{label}</span>
							</div>
							<div class="sub">
								{fmtAgo(s.created_at)} · {m.flow_history_nodes({
									nodes: num(s.node_count, locale.current),
									edges: num(s.edge_count, locale.current)
								})}
							</div>
						</div>
						{#if !readOnly}
							<button class="btn-ghost" onclick={() => restore(s)} disabled={busy}>
								{m.flow_history_restore()}
							</button>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</aside>
{/if}

<style>
	.history {
		position: absolute;
		top: 12px;
		inset-inline-end: 12px;
		bottom: 12px;
		width: 300px;
		display: flex;
		flex-direction: column;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-md);
		z-index: 6;
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 14px;
		border-bottom: 1px solid var(--c-border);
	}
	.ttl {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.x {
		font-size: 18px;
		line-height: 1;
		color: var(--c-muted);
		padding: 0 4px;
	}
	.checkpoint {
		display: flex;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--c-border);
	}
	.ck-input {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		padding: 6px 8px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
		color: var(--c-ink);
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.muted {
		font-size: 12.5px;
		color: var(--c-muted);
		padding: 18px 8px;
		text-align: center;
	}
	.err {
		font-size: 12px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-bottom: 1px solid var(--c-coral-light);
		padding: 8px 14px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 8px;
		border-radius: var(--r);
	}
	.row:hover {
		background: var(--c-surface);
	}
	.meta {
		flex: 1;
		min-width: 0;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.badge {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.badge.ai {
		background: var(--c-amber-light);
		color: #92400e;
	}
	.badge.manual {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.sum {
		font-size: 12.5px;
		color: var(--c-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 11px;
		color: var(--c-muted);
		margin-block-start: 2px;
	}
	.btn-ghost {
		font-size: 12px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		font-weight: 500;
		padding: 5px 10px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-ghost:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-primary {
		font-size: 12px;
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		padding: 6px 11px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
