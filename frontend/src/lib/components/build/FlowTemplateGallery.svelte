<!--
  FlowTemplateGallery — the "Pick a template" modal on /build. Two sections: platform STARTERS and the
  organisation's own templates. "Use" asks the backend for a NEW draft flow copied from the template
  (`POST /api/flow-templates/:id/use`) and hands its id to the page, which navigates to it.

  A template whose blocks this reader cannot use is shown but disabled, with the reason, rather than
  hidden: it tells the reader the template exists and why it is not for them.

  Accessible like ConfirmDialog: role=dialog, focus moves in on open and back on close, Tab is trapped,
  Escape and a backdrop click close it.
-->
<script lang="ts">
	import { flowTemplatesApi } from '$lib/api/flow-templates';
	import type { FlowTemplateSummary, UseFlowTemplateResult } from '$lib/types/flow-templates';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		open,
		onClose,
		onUsed,
		intoFlowId = null
	}: {
		open: boolean;
		onClose: () => void;
		onUsed: (result: UseFlowTemplateResult) => void;
		/** The empty draft on the canvas, if any: the template is written into it (no second flow). */
		intoFlowId?: string | null;
	} = $props();

	let items = $state<FlowTemplateSummary[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busyId = $state('');

	let modalEl = $state<HTMLDivElement | null>(null);
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let prevFocus: HTMLElement | null = null;

	const starters = $derived(items.filter((t) => t.scope === 'global'));
	const own = $derived(items.filter((t) => t.scope === 'tenant'));

	$effect(() => {
		if (open) {
			prevFocus = document.activeElement as HTMLElement | null;
			void load();
			queueMicrotask(() => closeBtn?.focus());
		} else if (prevFocus) {
			prevFocus.focus();
			prevFocus = null;
		}
	});

	async function load() {
		loading = true;
		error = null;
		try {
			items = await flowTemplatesApi.list();
		} catch (e) {
			error = errorText(e, m.error_load_failed());
			items = [];
		} finally {
			loading = false;
		}
	}

	/** A starter's category key has copy; an organisation's own category is shown as typed. */
	function categoryLabel(c: string): string {
		if (c === 'claims') return m.build_tpl_cat_claims();
		if (c === 'requests') return m.build_tpl_cat_requests();
		if (c === 'reporting') return m.build_tpl_cat_reporting();
		return c;
	}

	async function use(t: FlowTemplateSummary) {
		if (busyId || !t.available) return;
		busyId = t.id;
		error = null;
		try {
			const result = await flowTemplatesApi.use(t.id, { into: intoFlowId });
			onUsed(result);
		} catch (e) {
			error = writeErrorText(e, m.error_load_failed());
		} finally {
			busyId = '';
		}
	}

	async function remove(t: FlowTemplateSummary) {
		if (busyId) return;
		const ok = await confirmDialog({ message: m.build_tpl_remove_q(), confirmLabel: m.build_tpl_remove() });
		if (!ok) return;
		busyId = t.id;
		error = null;
		try {
			await flowTemplatesApi.archive(t.id);
			items = items.filter((x) => x.id !== t.id);
		} catch (e) {
			error = writeErrorText(e, m.error_delete_failed());
		} finally {
			busyId = '';
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Tab' && modalEl) {
			const f = Array.from(modalEl.querySelectorAll<HTMLElement>('button:not([disabled])'));
			if (!f.length) return;
			const first = f[0]!;
			const last = f[f.length - 1]!;
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet card(t: FlowTemplateSummary)}
	<li class="tcard" class:off={!t.available} data-testid="flow-tpl-card">
		<div class="tc-head">
			<span class="tc-name">{t.name}</span>
			{#if t.category}<span class="tc-cat">{categoryLabel(t.category)}</span>{/if}
		</div>
		{#if t.description}<p class="tc-desc">{t.description}</p>{/if}
		<div class="tc-foot">
			<span class="tc-count">{m.build_block_count({ count: num(t.blockCount, locale.current) })}</span>
			<span class="tc-actions">
				{#if t.canArchive}
					<button type="button" class="tc-remove" disabled={!!busyId} onclick={() => remove(t)}>
						{m.build_tpl_remove()}
					</button>
				{/if}
				<button
					type="button"
					class="tc-use"
					disabled={!t.available || !!busyId}
					aria-describedby={t.available ? undefined : `tpl-off-${t.id}`}
					onclick={() => use(t)}
				>
					{busyId === t.id ? m.build_tpl_opening() : m.build_tpl_use()}
				</button>
			</span>
		</div>
		{#if !t.available}
			<p class="tc-off" id={`tpl-off-${t.id}`}>{m.build_tpl_unavailable()}</p>
		{/if}
	</li>
{/snippet}

{#if open}
	<div
		class="ftg-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div
			class="ftg-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="ftg-title"
			data-testid="flow-template-gallery"
			bind:this={modalEl}
		>
			<div class="ftg-head">
				<h2 id="ftg-title">{m.build_tpl_title()}</h2>
				<button type="button" class="ftg-close" bind:this={closeBtn} aria-label={m.build_tpl_close()} onclick={onClose}>✕</button>
			</div>
			{#if error}<div class="ftg-error" role="alert">{error}</div>{/if}
			{#if loading}
				<p class="ftg-muted" aria-busy="true">{m.build_tpl_opening()}</p>
			{:else if !items.length}
				{#if !error}<p class="ftg-muted">{m.build_tpl_empty()}</p>{/if}
			{:else}
				{#if starters.length}
					<section aria-labelledby="ftg-starters">
						<h3 id="ftg-starters">{m.build_tpl_starters()}</h3>
						<ul class="cards">{#each starters as t (t.id)}{@render card(t)}{/each}</ul>
					</section>
				{/if}
				{#if own.length}
					<section aria-labelledby="ftg-own">
						<h3 id="ftg-own">{m.build_tpl_org()}</h3>
						<ul class="cards">{#each own as t (t.id)}{@render card(t)}{/each}</ul>
					</section>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.ftg-backdrop {
		position: fixed;
		inset: 0;
		z-index: 900;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		background: rgba(20, 25, 40, 0.45);
	}
	.ftg-modal {
		width: 100%;
		max-width: 760px;
		max-height: calc(100vh - 32px);
		overflow-y: auto;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 20px 22px 22px;
	}
	.ftg-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 6px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0;
	}
	h3 {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--c-muted);
		margin: 16px 0 8px;
	}
	.ftg-close {
		font-size: 14px;
		color: var(--c-muted);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		padding: 4px 8px;
		cursor: pointer;
	}
	.ftg-close:hover,
	.ftg-close:focus-visible {
		border-color: var(--c-border);
		color: var(--c-ink);
	}
	.ftg-error {
		font-size: 12.5px;
		padding: 8px 11px;
		border-radius: var(--r-sm);
		background: var(--c-coral-pale);
		color: var(--c-coral-dark);
		border: 1px solid var(--c-coral-light);
		margin: 8px 0;
	}
	.ftg-muted {
		font-size: 13px;
		color: var(--c-muted);
		margin: 12px 0 0;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
		gap: 10px;
	}
	.tcard {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 13px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		background: var(--c-white);
		min-width: 0;
	}
	.tcard:hover {
		border-color: var(--c-teal-mid);
	}
	.tcard.off {
		background: var(--c-surface);
	}
	.tc-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.tc-name {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--c-midnight);
		overflow-wrap: anywhere;
	}
	.tc-cat {
		flex-shrink: 0;
		font-size: 10.5px;
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		padding: 1px 7px;
		border-radius: 999px;
	}
	.tc-desc {
		font-size: 12px;
		line-height: 1.45;
		color: var(--c-muted);
		margin: 0;
		flex: 1;
	}
	.tc-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}
	.tc-count {
		font-size: 11.5px;
		color: var(--c-faint);
	}
	.tc-actions {
		display: flex;
		gap: 6px;
		margin-inline-start: auto;
	}
	.tc-use {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-white);
		background: var(--c-teal);
		border: none;
		padding: 6px 14px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.tc-use:hover:not(:disabled) {
		background: var(--c-teal-dark);
	}
	.tc-remove {
		font-size: 12px;
		color: var(--c-muted);
		background: transparent;
		border: 1px solid var(--c-border);
		padding: 5px 10px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.tc-remove:hover:not(:disabled) {
		color: var(--c-coral-dark);
		border-color: var(--c-coral-light);
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.tc-off {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		margin: 0;
	}
</style>
