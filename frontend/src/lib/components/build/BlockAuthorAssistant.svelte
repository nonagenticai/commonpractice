<script lang="ts">
	// BlockAuthorAssistant — the "Build with AI" start mode of the block editor (Phase 1).
	// A structured "Describe this block" form seeds the first message; the developer then refines
	// conversationally with the block-authoring copilot. The agent grounds itself in the company
	// ontology + test data and calls `propose_block_draft`, which the BlockAuthorDriver hands to
	// `onProposal` so the editor pre-fills its buffers — the developer reviews and clicks Create.
	import { onDestroy } from 'svelte';
	import ChatPanel from './ChatPanel.svelte';
	import { AgentChatStore } from '$lib/stores/agent-chat.svelte';
	import {
		BlockAuthorDriver,
		describeBlockEdit,
		type BlockDraftProposal
	} from '$lib/agent/block-author-driver';
	import { ontologyApi } from '$lib/api/ontology';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	// `categoryLabel` — the SAME helper the palette (BlockPalette.svelte) and the block library
	// (/blocks) resolve a category with. The seed message was the one site still pasting the slug.
	import { categoryLabel, type BlockCategory } from '$lib/types/blocks';
	import { errorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { industryLabel, departmentLabel } from '$lib/i18n/ontology-axis-label';

	let { category, onProposal }: { category: BlockCategory; onProposal: (d: BlockDraftProposal) => void } =
		$props();

	let intent = $state('');
	let industry = $state('');
	let department = $state('');
	let datasetSlug = $state('');
	let started = $state(false);

	let industries = $state<string[]>([]);
	let departments = $state<string[]>([]);
	let datasets = $state<{ slug: string; name: string }[]>([]);
	// ⚠️ `listAll()` RESOLVES `{items,total,capped}`. The two extra fields are what let this select say
	// it is offering a SAMPLE of the developer's test data rather than their library — the same reason
	// the walk reports its own ceiling instead of silently returning the first 240 rows.
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);

	const chat = new AgentChatStore({
		driver: new BlockAuthorDriver((d) => onProposal(d)),
		mode: 'block',
		intro: () => [{ kind: 'assistant', text: m.blockauthor_intro() }],
		describe: (name) => describeBlockEdit(name)
	});

	// This panel is unmounted whenever the parent's {#if isNew && startMode === 'assistant'}
	// flips (Create finishes, mode switches back to manual) or the route changes — without
	// this the SSE fetch kept running and still metered real LLM spend, invisibly.
	onDestroy(() => chat.stop());

	// ⛔ THE DATASET GROUNDING'S FAILURE, WHICH USED TO RENDER AS "you have no test data".
	// `catch { /* optional grounding */ }` left `datasets` at `[]`, and an `<option>`-less select whose
	// only entry is "Geen" is indistinguishable from an account that genuinely owns no datasets. The
	// developer's reasonable reading — "I have nothing to ground this block in, so I will skip it" — is
	// wrong, and it costs them the exact feature this form exists to offer. The call remains OPTIONAL
	// (the form still submits without it); what changes is that its failure is now a stated fact rather
	// than a silently downgraded product.
	//
	// ⚠️ THE ONTOLOGY CALL WAS DELIBERATELY LEFT SWALLOWED BY THE DATASET LANE — "Named, not fixed",
	// because it was a separate finding and a separate sentence to translate. THIS COMMIT IS THAT
	// SEPARATE LANE; see `ontologyError` and `loadMatrix` below.
	//
	// `errorText`, not `writeErrorText`: this is a READ, and `writeErrorText` only prefers the backend's
	// own sentence on the 400/422/409 a rejected WRITE produces.
	let datasetsError = $state<string | null>(null);

	async function loadDatasets() {
		datasetsError = null;
		try {
			// `listAll()`, not `list()`: `GET /api/datasets` pages at 12 and this select has no pager, so
			// page one was being offered as the developer's whole library of test data.
			const all: AllDatasets = await datasetsApi.listAll();
			datasets = all.items.map((d) => ({ slug: d.slug, name: d.name }));
			datasetsTotal = all.total;
			datasetsCapped = all.capped;
		} catch (e) {
			datasetsError = errorText(e, m.challenge_data_load_failed());
		}
	}

	/**
	 * Why the Branche/Afdeling pickers are empty, or `null` when they are not.
	 *
	 * ⛔ THE SECOND HALF OF THE SWALLOW THE DATASET LANE NAMED. `catch { /* optional grounding *​/ }`
	 * left `industries` and `departments` at `[]`, and a `<select>` whose only entry is "Geen" is
	 * indistinguishable from a tenant whose ontology matrix genuinely has no cells. The developer's
	 * reasonable reading — "there is nothing to ground this block in, so I will skip it" — is wrong,
	 * and it costs them exactly the feature this form exists to offer. Worse than the dataset half:
	 * `start()` only appends `blockauthor_seed_cell` when `industry` is set, so the ontology
	 * grounding drops out of the AGENT'S PROMPT too, silently.
	 *
	 * The call stays OPTIONAL — the form still submits without a cell, and the agent can ask for one
	 * in chat. What changes is that its failure is a stated fact rather than a downgraded product.
	 *
	 * ⚠️ ONE notice for BOTH selects: a single `ontologyApi.matrix()` populates them, so a failure is
	 * one fact about one request. Two would be two copies of one sentence, and two retries for one
	 * call.
	 *
	 * `errorText`, not `writeErrorText`: this is a READ, and `writeErrorText` only prefers the
	 * backend's own sentence on the 400/422/409 a rejected WRITE produces.
	 */
	let ontologyError = $state<string | null>(null);

	async function loadMatrix() {
		ontologyError = null;
		try {
			const mx = await ontologyApi.matrix();
			industries = mx.industries;
			departments = mx.departments;
		} catch (e) {
			// `industries`/`departments` left as they were: on a failed RETRY the options already on
			// screen are still the best set we have, and blanking them would turn a transient failure
			// into a lost picker. Same reasoning as `loadDatasets` above.
			ontologyError = errorText(e, m.blockauthor_ontology_load_failed());
		}
	}

	// Grounding pickers load once on mount. Both stay best-effort: the form still works without
	// either, because the agent can ask the developer for the cell in chat.
	$effect(() => {
		void (async () => {
			await loadMatrix();
			await loadDatasets();
		})();
	});

	/**
	 * An axis value as the READER's word, keeping the CANONICAL key beside it when the two differ.
	 *
	 * ⛔ THE PARENTHETICAL IS NOT DECORATION — IT IS THE HALF THAT KEEPS THE COPILOT WORKING. The
	 * seed message is BOTH the user's own chat bubble AND the prompt sent to the agent
	 * (`chat.send(msg)`; `AgentChatStore.send` takes one string and uses it for both). `industry`
	 * and `department` are ROUTING VALUES, not prose: the agent's `get_ontology` tool takes
	 * `industry` (backend/src/ai/mcp/tools.ts, documented "e.g. insurance") and hands it to
	 * `compileEffective`, which matches it against the `ontology_entities.industry` COLUMN. Seed the
	 * prompt with "Branche: Verzekeringen" alone and a model that passes it through calls
	 * `get_ontology(industry="Verzekeringen")`, which matches no row — silently emptying the exact
	 * ontology grounding this form exists to provide. That is a worse defect than the English one
	 * being fixed here, and it is the hazard `$lib/i18n/ontology-axis-label.ts` documents at length
	 * for a value that is a word AND a key. So the reader gets their word and the agent keeps its
	 * key.
	 *
	 * ⚠️ ONLY WHEN THEY DIFFER, CASE-FOLDED. In `en` the label IS the value bar its capitalization
	 * ("Insurance"/"insurance", "Claims"/"Claims"), and "Insurance (insurance)" is noise in every
	 * English bubble in the product.
	 */
	function axisSeed(label: string, value: string): string {
		return label.toLowerCase() === value.toLowerCase() ? label : `${label} (${value})`;
	}

	function start() {
		const goal = intent.trim();
		if (!goal || chat.busy) return;
		// ⛔ `categoryLabel(category)`, NOT THE BARE SLUG. This rendered "Maak een logic-blok" in a
		// Dutch bubble while the palette three panels away calls the same value "Logica". Unlike the
		// two axis values below it needs NO canonical escort: `category` is not an agent INPUT — the
		// agent's own `propose_block_draft` schema constrains its category OUTPUT to the
		// `BLOCK_CATEGORIES` enum, so the canonical value is enforced on the way back regardless of
		// which word seeded the request.
		let msg: string = m.blockauthor_seed_goal({ category: categoryLabel(category), goal });
		if (industry)
			msg +=
				' ' +
				m.blockauthor_seed_cell({
					industry: axisSeed(industryLabel(industry), industry),
					department: department ? axisSeed(departmentLabel(department), department) : '—'
				});
		if (datasetSlug) msg += ' ' + m.blockauthor_seed_dataset({ slug: datasetSlug });
		started = true;
		void chat.send(msg);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			start();
		}
	}
</script>

{#if !started}
	<div class="ba-form">
		<h3>{m.blockauthor_form_title()}</h3>
		<p class="hint">{m.blockauthor_form_hint()}</p>

		<label class="fld">
			<span>{m.blockauthor_intent_label()}</span>
			<textarea
				bind:value={intent}
				onkeydown={onKey}
				rows="3"
				placeholder={m.blockauthor_intent_ph()}
			></textarea>
		</label>

		<div class="grid">
			<label class="fld">
				<span>{m.blockauthor_industry_label()}</span>
				<select bind:value={industry}>
					<option value="">{m.blockauthor_none()}</option>
					{#each industries as ind (ind)}<option value={ind}>{industryLabel(ind)}</option>{/each}
				</select>
			</label>
			<label class="fld">
				<span>{m.blockauthor_department_label()}</span>
				<select bind:value={department}>
					<option value="">{m.blockauthor_none()}</option>
					{#each departments as dep (dep)}<option value={dep}>{departmentLabel(dep)}</option>{/each}
				</select>
			</label>
			<div class="fld">
				<!-- ⛔ A `<div>`, NOT A `<label>`. The retry below is a real control, and a button inside a
				     label forwards its click to the labelled `<select>` as well — so pressing "Opnieuw
				     proberen" would also pop the dropdown open over the notice explaining why it is empty.
				     The label association is kept explicitly via `for`/`id` instead. -->
				<label class="fld-label" for="ba-dataset">{m.blockauthor_dataset_label()}</label>
				<select id="ba-dataset" bind:value={datasetSlug}>
					<option value="">{m.blockauthor_none()}</option>
					{#each datasets as d (d.slug)}<option value={d.slug}>{d.name}</option>{/each}
				</select>
				{#if datasetsError}
					<!-- Under the select, not instead of it: "None" is still a legitimate choice, and this form
					     is submittable without test data. What the notice removes is the reader's only other
					     available reading of an empty dropdown — that they own no datasets. -->
					<p class="fld-error" role="alert" data-testid="datasets-error">
						<span>{datasetsError}</span>
						<button type="button" class="fld-retry" onclick={loadDatasets}>{m.error_load_retry()}</button>
					</p>
				{/if}
				<!-- The walk stopped at its ceiling. Under the select for the same reason the failure
				     notice is: the dropdown still holds real choices and the form still submits — what the
				     line removes is the developer's reading that these ARE all their datasets, which costs
				     them the grounding this form exists to offer exactly as an outright failure would.
				     ⚠️ `role="status"`, not `"alert"`: the load succeeded, it just did not reach the end. -->
				{#if datasetsCapped}
					<p class="fld-capped" role="status" data-testid="datasets-capped">
						{m.datasets_picker_capped({
							shown: num(datasets.length, locale.current),
							total: num(datasetsTotal, locale.current)
						})}
						<a href="/datasets">{m.nav_datasets()}</a>
					</p>
				{/if}
			</div>
		</div>

		<!-- ⛔ UNDER THE GRID, NOT INSIDE EITHER CELL, AND FOR TWO REASONS. One: a single
		     `ontologyApi.matrix()` populates BOTH selects, so a failure is one fact about one
		     request — a per-cell notice would be two copies of one sentence and two retries for one
		     call. Two: the retry is a real control, and a `<button>` inside a `<label>` forwards its
		     click to the labelled `<select>` as well — pressing "Opnieuw proberen" would pop the
		     dropdown open over the notice explaining why it is empty. That hazard is documented on
		     the dataset cell above, which had to become a `<div>` for it; keeping this notice outside
		     the grid leaves both `<label>` wrappers untouched.
		     ⚠️ AFTER the selects, not instead of them: "Geen" is still a legitimate choice and this
		     form is submittable without a cell. What the notice removes is the developer's only other
		     available reading of two empty dropdowns — that their workspace has no ontology. -->
		{#if ontologyError}
			<p class="fld-error grid-error" role="alert" data-testid="ontology-error">
				<span>{ontologyError}</span>
				<button type="button" class="fld-retry" onclick={loadMatrix}>{m.error_load_retry()}</button>
			</p>
		{/if}

		<button class="btn-primary" disabled={!intent.trim()} onclick={start}>
			{m.blockauthor_start()}
		</button>
	</div>
{:else}
	<div class="ba-chat">
		<ChatPanel {chat} />
	</div>
{/if}

<style>
	.ba-form {
		max-width: 720px;
		padding: 8px 4px 24px;
	}
	.ba-form h3 {
		margin: 0 0 4px;
		font-size: 15px;
		color: var(--c-ink);
	}
	.hint {
		margin: 0 0 16px;
		font-size: 12.5px;
		color: var(--c-faint);
		line-height: 1.5;
	}
	.fld {
		display: block;
		margin-bottom: 14px;
	}
	/* `.fld-label` is the same heading as `.fld > span`, on the one field whose wrapper had to stop
	   being a `<label>` (see the comment at that field). Kept in one rule so the two cannot drift. */
	.fld > span,
	.fld-label {
		display: block;
		font-size: 11.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--c-faint);
		margin-bottom: 5px;
	}
	/* Same coral failure treatment as `/submit`'s `.ds-preview-error`. */
	.fld-error {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 6px 0 0;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-sm);
		padding: 6px 9px;
	}
	.fld-retry {
		margin-inline-start: auto;
		flex: none;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--c-coral-dark);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	/* The completeness disclosure. ⛔ NOT the coral `.fld-error` treatment — nothing failed, so it
	   takes the muted `.hint` tone. Same choice as `/submit`'s `.ds-capped`. */
	.fld-capped {
		margin: 6px 0 0;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--c-muted);
	}
	.fld-capped a {
		color: var(--c-teal-dark);
		margin-inline-start: 4px;
	}
	.fld textarea,
	.fld select {
		width: 100%;
		font-size: 13px;
		padding: 9px 11px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
		color: var(--c-ink);
	}
	.fld textarea {
		resize: vertical;
		font-family: inherit;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
	.btn-primary {
		margin-top: 6px;
		padding: 9px 18px;
		border-radius: var(--r);
		background: var(--c-midnight);
		color: #fff;
		font-size: 13px;
		font-weight: 500;
	}
	.btn-primary:disabled {
		opacity: 0.5;
	}
	/* Give the embedded chat a workable height in the editor's solo layout. */
	.ba-chat {
		height: min(60vh, 560px);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		overflow: hidden;
		display: flex;
	}
	.ba-chat :global(.chat) {
		flex: 1;
		border-inline-start: none;
	}
	/* The matrix failure sits under the whole three-column grid, not inside a cell — see the note at
	   its markup. Same coral `.fld-error` treatment as the dataset cell's, with the grid's own
	   bottom margin restored. */
	.grid-error {
		margin: -8px 0 16px;
	}
</style>
