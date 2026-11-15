<script lang="ts">
	// Phase 3.0 (Pillar A): the typed-schema + sample-rows preview table, extracted from
	// the datasets-screen drawer so the same view is reused on the datasets screen, the
	// builder node config (inline preview), the challenge submit/detail screens, and the
	// builder "Challenge data" panel. Pure/presentational: it renders the columns + rows
	// it is given (with a PII badge), caps display at maxRows, and owns no data loading.
	import type { DatasetColumn } from '$lib/types/datasets';
	import * as m from '$lib/paraglide/messages';
	// The column-type chip is the ONE word in this header that came off the wire as an enum. Five
	// screens mount this component (/datasets, /submit, /challenges/[id], the builder node config
	// and the builder "Challenge data" panel), so localising it here localises all five at once.
	import { datasetColumnTypeLabel } from '$lib/i18n/dataset-label';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { MASKED_CELL } from '$lib/datasets/masked';

	let {
		columns,
		rows,
		maxRows,
		totalRows,
		maskedColumns = []
	}: {
		columns: DatasetColumn[];
		rows: Record<string, unknown>[];
		maxRows?: number;
		/**
		 * How many rows the DATASET has — not how many were fetched.
		 *
		 * ⛔ WITHOUT THIS THE TRUNCATION NOTICE BELOW IS UNREACHABLE, AND WAS. Its condition was
		 * `rows.length > maxRows`, i.e. "the array I was handed is longer than what I display". But
		 * `GET /api/datasets/:slug?limit=` caps the array SERVER-side (`readRows(d.id, limit,
		 * offset)`, backend/src/routes/datasets.ts), so every caller that fetches `limit: N` and
		 * passes `maxRows={N}` is asking whether `N > N`. On /datasets that is `50 > 50`; on the four
		 * `maxRows={5}` sites it is `5 > 5`. The notice could not fire ANYWHERE, and the reader got a
		 * table that stopped at row 50 under a header saying "12.480 rijen", with nothing in between
		 * to say why.
		 *
		 * The comparison the reader actually needs is against the dataset's own size, which only the
		 * caller holds (`DatasetDetail.rowCount`). Omitted, it falls back to `rows.length` — the old
		 * behaviour exactly, so a caller that has no total is no worse off than before.
		 */
		totalRows?: number;
		/**
		 * Columns whose values this reader may not see (W8/P7). The backend has already blanked them;
		 * this only decides how a blanked cell LOOKS: "•••" with a "Hidden personal data" tooltip,
		 * instead of the server's placeholder text. Optional — an older backend sends no list.
		 */
		maskedColumns?: string[];
	} = $props();

	const masked = $derived(new Set(maskedColumns));

	const shown = $derived(maxRows != null ? rows.slice(0, maxRows) : rows);
	/** The dataset's size when the caller knows it; otherwise all we can see is the page we got. */
	const total = $derived(totalRows ?? rows.length);

	function cell(v: unknown): string {
		if (v === null || v === undefined) return '';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}
</script>

<!--
⛔ THE BOUNDARY IS THE FIRST ONE IN `frontend/src`, AND IT EARNS ITS PLACE HERE SPECIFICALLY.
This component is mounted on FIVE screens (/datasets, /submit, /challenges/[id], the builder
node-config panel and the builder "Challenge data" panel), and it renders WHOLLY UNVALIDATED
tenant data: column names and cell values that came off a spreadsheet somebody uploaded. Anything
that throws inside it is uncaught — and an uncaught error in a Svelte 5 render takes down the whole
component tree it sits in, not just this table, so one malformed row blanked an entire page.
`cell()` alone can throw on a value `JSON.stringify` refuses (a cycle, a BigInt), and the keyed
`{#each}`s below used to throw `each_key_duplicate` on a repeated column name.
The backend now guarantees unique names and the keys below no longer depend on them — this is the
third layer, for the data nobody has thought of yet. It degrades to one line of text instead of a
white page, which is the whole ask: a bad row must never cost the reader the screen.
-->
<svelte:boundary>
	<div class="sample-wrap">
		<table class="sample">
			<thead>
				<tr>
					<!--
					⛔ KEYED BY INDEX. DO NOT "RESTORE" `(c.name)`. Two columns with the same name made
					Svelte throw `each_key_duplicate` — NOT dev-only
					(svelte/internal/client/dom/blocks/each.js) — and it is the exact mechanism that
					blanked /governance (PR #233) and that /it-dash's alert list documents at
					+page.svelte:178. Ingest now keeps names unique, but ⛔ NOTHING REPAIRED THE ROWS
					ALREADY WRITTEN — migration `0069` was withdrawn before it ever merged (it could
					wedge the pod boot, and the population it targeted measured ZERO in prod, dev and
					the union DB on 2026-08-19), so this keying is the ONLY thing standing between a
					legacy duplicate-name dataset and a blank screen. This component also renders
					datasets fetched from an OLDER backend during a rolling deploy, and `columns` is a
					plain positional list whose
					index IS its identity — there is nothing a name-key buys here that the index does
					not. Guarded by `dataset-preview.duplicate-columns.render.test.ts`.
					-->
					{#each columns as c, ci (ci)}
						<th>
							<span class="col-name">{c.name}</span>
							<span class="col-type">{datasetColumnTypeLabel(c.type)}</span>
							{#if c.pii}<span class="pii" title={m.datasets_col_pii()}>{m.datasets_col_pii()}</span>{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each shown as r, ri (ri)}
					<tr>
						<!-- Same reason as the header row — and the cell still READS by name, so a
						     duplicate name shows the same value twice rather than dropping a column. -->
						{#each columns as c, ci (ci)}
							{#if masked.has(c.name)}
								<td><span class="masked" title={m.dataset_preview_masked()} aria-label={m.dataset_preview_masked()}>{MASKED_CELL}</span></td>
							{:else}
								<td>{cell(r[c.name])}</td>
							{/if}
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
		{#if rows.length === 0}
			<div class="sample-empty">{m.dataset_preview_no_rows()}</div>
		{:else if total > shown.length}
			<!-- ⛔ `total > shown.length`, NOT `rows.length > maxRows`. The old condition compared the
			     fetched array against the display cap, and the server caps the array to exactly that
			     number — so it read `50 > 50` on /datasets and `5 > 5` on the four inline previews,
			     and this notice never rendered once in the product's life. See the `totalRows` prop.
			     `shown.length`, not `maxRows`: they are equal whenever this branch is reached, and the
			     rendered count must be the number of `<tr>`s above it rather than a cap that might
			     exceed them. -->
			<div class="sample-more">{m.dataset_preview_more({ shown: num(shown.length, locale.current), total: num(total, locale.current) })}</div>
		{/if}
	</div>

	{#snippet failed()}
		<!-- ⚠️ NOT `dataset_preview_load_failed`. That key says the preview could not be LOADED, which
		     is a different and here untrue statement: the data arrived fine and the RENDER failed. -->
		<div class="sample-wrap">
			<div class="sample-error">{m.dataset_preview_render_failed()}</div>
		</div>
	{/snippet}
</svelte:boundary>

<style>
	.sample-wrap {
		overflow-x: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
	}
	table.sample {
		font-size: 11.5px;
		border-collapse: collapse;
		width: 100%;
	}
	table.sample th,
	table.sample td {
		padding: 6px 10px;
		white-space: nowrap;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: start;
	}
	.col-name {
		font-family: var(--font-mono);
	}
	.col-type {
		font-size: 9.5px;
		color: var(--c-faint);
		margin-inline-start: 5px;
		font-family: var(--font-mono);
	}
	.pii {
		font-size: 9px;
		font-weight: 600;
		color: var(--c-rose);
		border: 1px solid var(--c-rose);
		border-radius: var(--r-sm);
		padding: 0 4px;
		margin-inline-start: 5px;
		text-transform: uppercase;
	}
	.masked {
		color: var(--c-faint);
		letter-spacing: 1px;
		cursor: help;
	}
	.sample-empty,
	.sample-more,
	.sample-error {
		font-size: 11px;
		color: var(--c-faint);
		padding: 8px 10px;
	}
</style>
