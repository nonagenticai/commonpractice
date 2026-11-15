<script lang="ts">
	// W8/P2 — the "Information involved" picker, shared by /submit and the challenge page's edit mode.
	// Searchable by the LOCALIZED name and synonyms (information-search.ts); shows names and
	// descriptions only — never a key. Presentational: the caller supplies the options and owns the
	// selection; every change emits the whole new id list.
	import type { InformationCard, InformationOption } from '$lib/types/challenges';
	import { matchInformation } from '$lib/challenges/information-search';
	import * as m from '$lib/paraglide/messages';

	let {
		options,
		selected = [],
		known = [],
		onchange
	}: {
		options: InformationOption[];
		selected?: string[];
		/** Names for selected ids that are not among `options` (linked earlier, another work area). */
		known?: InformationCard[];
		onchange: (ids: string[]) => void;
	} = $props();

	let query = $state('');
	const shown = $derived(matchInformation(options, query));
	const nameOf = $derived(
		new Map([...known, ...options].map((o) => [o.id, o.label] as [string, string]))
	);

	function toggle(id: string, on: boolean) {
		const next = selected.filter((s) => s !== id);
		onchange(on ? [...next, id] : next);
	}
</script>

<div class="info-picker">
	{#if selected.length}
		<div class="chips">
			{#each selected as id (id)}
				{@const name = nameOf.get(id) ?? ''}
				<span class="chip">
					{name}
					<button type="button" onclick={() => toggle(id, false)} aria-label={m.challenge_info_remove({ name })}>×</button>
				</span>
			{/each}
		</div>
	{/if}
	{#if options.length === 0}
		<p class="muted" data-testid="info-options-empty">{m.challenge_info_options_empty()}</p>
	{:else}
		<input
			class="search"
			type="search"
			bind:value={query}
			placeholder={m.challenge_info_search()}
			aria-label={m.challenge_info_search()}
		/>
		{#if shown.length === 0}
			<p class="muted">{m.challenge_info_no_match()}</p>
		{:else}
			<ul class="options">
				{#each shown as o (o.id)}
					<li>
						<label>
							<input
								type="checkbox"
								checked={selected.includes(o.id)}
								onchange={(e) => toggle(o.id, e.currentTarget.checked)}
							/>
							<span class="opt-text">
								<span class="opt-name">{o.label}</span>
								{#if o.description}<span class="opt-desc">{o.description}</span>{/if}
							</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.info-picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		font-size: 12px;
		font-weight: 600;
		padding: 3px 4px 3px 10px;
		border-radius: 999px;
		background: var(--c-teal-pale);
		color: var(--c-teal-dark);
		border: 1px solid var(--c-teal-light);
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.chip button {
		background: none;
		border: none;
		cursor: pointer;
		color: inherit;
		font-size: 14px;
		line-height: 1;
		padding: 0 4px;
	}
	.search {
		width: 100%;
	}
	.options {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 240px;
		overflow-y: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
	}
	.options li + li {
		border-top: 1px solid var(--c-border);
	}
	.options label {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 7px 10px;
		cursor: pointer;
	}
	.opt-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.opt-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.opt-desc {
		font-size: 12px;
		color: var(--c-muted);
	}
	.muted {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0;
	}
</style>
