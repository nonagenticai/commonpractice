<script lang="ts">
	// One step's output on the Result panel, in words: a row count plus the first rows, a value, or
	// label → value lines. Never the raw text — that is under Details, for developers and above.
	// See `run-output.ts` for the parsing rules.
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { plainValue, type FieldValue, type OutputFormat, type OutputView } from './run-output';

	let { view, label }: { view: OutputView; label: (key: string) => string } = $props();

	const fmt: OutputFormat = {
		num: (n) => num(n, locale.current),
		bool: (b) => (b ? m.build_output_yes() : m.build_output_no())
	};

	function countText(count: number, atLeast: boolean): string {
		return atLeast
			? m.build_output_rows_at_least({ count: num(count, locale.current) })
			: m.build_output_rows({ count });
	}
	function fieldText(v: FieldValue): string {
		if (v.kind === 'count') return countText(v.count, v.atLeast);
		if (v.kind === 'rowsCut') return m.build_output_rows_cut();
		return v.text;
	}
</script>

<svelte:boundary>
	<div class="out">
		{#if view.rowsCut}
			<span class="out-count">{m.build_output_rows_cut()}</span>
		{/if}
		{#if view.text !== null}
			<span class="out-text">{view.text}</span>
		{/if}
		{#if view.fields.length > 0}
			<dl class="out-fields">
				{#each view.fields as f, i (i)}
					<div class="out-field">
						<dt>{label(f.key)}</dt>
						<dd>{fieldText(f.value)}</dd>
					</div>
				{/each}
			</dl>
		{/if}
		{#if view.table}
			{@const t = view.table}
			{#if view.fields.length === 0}
				<span class="out-count">{countText(t.count, t.atLeast)}</span>
			{/if}
			<div class="out-table-wrap">
				<table class="out-table">
					<thead>
						<tr>
							{#each t.columns as c, ci (ci)}
								<th>{label(c)}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each t.rows as r, ri (ri)}
							<tr>
								{#each t.columns as c, ci (ci)}
									<td>{plainValue(r[c], fmt)}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				{#if t.hiddenColumns > 0}
					<div class="out-more">{m.build_output_more_columns({ count: num(t.hiddenColumns, locale.current) })}</div>
				{/if}
			</div>
		{/if}
	</div>
	{#snippet failed()}{/snippet}
</svelte:boundary>

<style>
	.out {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.out-count {
		color: var(--c-muted);
	}
	.out-fields {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.out-field {
		display: flex;
		gap: 6px;
	}
	.out-field dt {
		color: var(--c-muted);
	}
	.out-field dt::after {
		content: ':';
	}
	.out-field dd {
		margin: 0;
		color: var(--c-ink);
		overflow-wrap: anywhere;
	}
	/* Same look as DatasetPreviewTable's sample table. */
	.out-table-wrap {
		overflow-x: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		max-width: 100%;
	}
	.out-table {
		font-size: 11.5px;
		border-collapse: collapse;
		width: 100%;
		color: var(--c-ink);
	}
	.out-table th,
	.out-table td {
		padding: 6px 10px;
		white-space: nowrap;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: start;
	}
	.out-table th {
		font-weight: 600;
	}
	.out-more {
		font-size: 11px;
		color: var(--c-faint);
		padding: 8px 10px;
	}
</style>
