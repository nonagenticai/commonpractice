<script lang="ts">
	// Phase 3.0 (Pillar A): dataset chooser extracted from the builder NodeConfigPanel
	// dropdown so the challenge creator (multi-select) and the builder node config
	// (single-select) share one widget. Always emits the full new selection as a slug
	// array via onchange; single mode emits [] or [slug], multi mode toggles entries.
	// Presentational: caller supplies the available datasets + localized labels.
	import type { DatasetRow } from '$lib/types/datasets';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		datasets,
		selected = [],
		multiple = false,
		placeholder = '',
		emptyHint = '',
		disabled = false,
		onchange
	}: {
		datasets: DatasetRow[];
		selected?: string[];
		multiple?: boolean;
		placeholder?: string;
		emptyHint?: string;
		/** The caller's surface is read-only (e.g. /build's locked canvas). */
		disabled?: boolean;
		onchange: (slugs: string[]) => void;
	} = $props();

	function toggle(slug: string, on: boolean) {
		const set = new Set(selected);
		if (on) set.add(slug);
		else set.delete(slug);
		onchange([...set]);
	}

	// ⛔ THE SELECTED SLUG THAT IS NOT IN `datasets`, WHICH USED TO VANISH.
	// `<select value={selected[0]}>` can only settle on a value one of its `<option>`s carries. The
	// single-select branch below builds its options from `datasets` alone, so a slug that is not in
	// that array made the browser fall back to the FIRST option — the empty placeholder, "Kies een
	// dataset…". A node whose config genuinely holds `claims-2026` therefore rendered as an
	// unconfigured picker, and the panel contradicted the graph it was editing. Worse: the `<select>`
	// reports `value === ''` from that moment on, so the next `onchange` on any other control that
	// re-emits the selection would have written the emptiness back.
	//
	// The array is short by construction, not by accident: `GET /api/datasets` pages at 12
	// (backend/src/routes/datasets.ts), so the 13th dataset a builder owns is invisible here even on a
	// perfectly healthy load. The primary fix is upstream — callers now page to completion via
	// `datasetsApi.listAll()` — but this option is what keeps the widget honest whichever way the list
	// arrives short: a deleted dataset still referenced by an old flow, a failed fetch, a foreign-scope
	// slug. Labelled by the raw slug, which is the only fact we have about it; no new catalog key,
	// because inventing a sentence here would be inventing knowledge we do not have.
	//
	// ⚠️ SINGLE-SELECT ONLY. The multi branch renders checkboxes, and an unlisted slug there is a
	// different question (a row with no name, no size and a checked box) that no caller in this repo
	// currently reaches — `selected` is seeded from the same list it renders. Left alone deliberately.
	const unlisted = $derived(
		!multiple && selected[0] && !datasets.some((d) => d.slug === selected[0]) ? selected[0]! : null
	);
</script>

{#if multiple}
	<div class="picker-list" role="group">
		{#each datasets as ds (ds.id)}
			<!-- W8/F3: the row names the dataset by its friendly name + row count. The slug is an internal
			     key — kept only as `data-slug` so tests (and nothing a reader sees) can address the row. -->
			<label class="picker-item" data-slug={ds.slug}>
				<input
					type="checkbox"
					checked={selected.includes(ds.slug)}
					{disabled}
					onchange={(e) => toggle(ds.slug, e.currentTarget.checked)}
				/>
				<span class="picker-name">{ds.name}</span>
				<span class="picker-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span>
			</label>
		{/each}
		{#if datasets.length === 0 && emptyHint}<span class="picker-empty">{emptyHint}</span>{/if}
	</div>
{:else}
	<select
		value={selected[0] ?? ''}
		{disabled}
		onchange={(e) => onchange(e.currentTarget.value ? [e.currentTarget.value] : [])}
	>
		<option value="">{placeholder}</option>
		{#if unlisted}<option value={unlisted} data-testid="picker-unlisted">{unlisted}</option>{/if}
		{#each datasets as ds (ds.id)}<option value={ds.slug} data-slug={ds.slug}>{ds.name} ({num(ds.rowCount, locale.current)} {m.connectors_rows_word()})</option>{/each}
	</select>
	<!-- ⛔ `&& !unlisted`. The hint is a claim about the reader's account ("Nog geen datasets — maak er
	     een aan"), and it must not sit under a control that is at this moment displaying one of their
	     datasets. Empty list + a selected slug is not "you have none"; it is "the list came back short",
	     and the option above is the only true thing this widget can say about that. -->
	<!-- `&& emptyHint`: callers blank the hint when they are ALREADY saying something truer above it
	     (NodeConfigPanel does this when the list fetch failed). An empty `<span class="picker-empty">`
	     is invisible to a reader but not to a DOM assertion, so it must not render at all. -->
	{#if datasets.length === 0 && !unlisted && emptyHint}<span class="picker-empty">{emptyHint}</span>{/if}
{/if}

<style>
	.picker-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 220px;
		overflow-y: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		padding: 6px;
	}
	.picker-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 7px;
		border-radius: var(--r-sm);
		cursor: pointer;
	}
	.picker-item:hover {
		background: var(--c-surface);
	}
	.picker-name {
		font-size: 12.5px;
		color: var(--c-ink);
	}
	.picker-meta {
		font-size: 10.5px;
		color: var(--c-faint);
		margin-inline-start: auto;
	}
	select {
		font-size: 12.5px;
		padding: 6px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-white);
		font-family: inherit;
		width: 100%;
	}
	.picker-empty {
		font-size: 11px;
		color: var(--c-faint);
	}
</style>
