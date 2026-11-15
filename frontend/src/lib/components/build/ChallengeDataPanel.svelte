<script lang="ts">
	// Phase 3.1 (Pillar A): the build-canvas data surface. In challenge mode it lists the
	// challenge's applicable datasets (creator notes + preview) and one-click wires a slug
	// into the selected node's dataset-typed input via builder.updateConfig (the same
	// mutation a manual pick makes). In browse mode it lists all the builder's datasets so
	// they can explore test data outside a specific challenge. Preview rows are lazy-loaded.
	import { onMount } from 'svelte';
	import type { BuilderStore } from '$lib/stores/builder.svelte';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	import type { DatasetColumn, DatasetRow } from '$lib/types/datasets';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import { errorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	import { dataFindingLabel, dataFindingRef } from '$lib/i18n/data-finding-label';
	import { nodeDisplayName } from '$lib/stores/block-catalog.svelte';
	import {
		friendlyFindings,
		sampleRunOutcome,
		type SampleRunState,
		type SampleTestView,
		type StepNode
	} from './sample-test';

	let {
		builder,
		onClose,
		sample = null,
		sampleRun = null,
		onSampleTest,
		onAddBlock
	}: {
		builder: BuilderStore;
		/** Optional: /build shows this panel as a side-pane tab, which the pane itself hides. */
		onClose?: () => void;
		/** W8/P4: the state of "Test with this challenge's sample data" (owned by the page, which runs it). */
		sample?: SampleTestView | null;
		/** The live run the page streams — the sample test's OUTCOME is read from it, never assumed. */
		sampleRun?: SampleRunState | null;
		onSampleTest?: () => void;
		/** Drop an existing block (by slug) onto the canvas — the data block a developer already
		 *  derived for this challenge's information, offered when the flow has no step that reads data. */
		onAddBlock?: (slug: string) => void;
	} = $props();

	// ---- W8/P4: the sample test's result, in plain words ----
	const steps = $derived<StepNode[]>(
		builder.nodes.map((n) => ({
			id: n.id,
			label: nodeDisplayName(n.data),
			datasets: Object.values(n.data.config ?? {}).filter((v): v is string => typeof v === 'string')
		}))
	);
	const sampleDone = $derived(sample?.state === 'done' ? sample : null);
	const friendly = $derived(sampleDone ? friendlyFindings(sampleDone.findings, steps, sampleDone.binding) : []);
	// ⛔ "It fits every step" only from a run that FINISHED ok — see `sampleRunOutcome`.
	const outcome = $derived(sampleDone ? sampleRunOutcome(sampleDone.runId, sampleRun, steps, locale.current) : null);
	/** "Tested with “Claims April” in step “Load claims”." — only when both names are known. */
	const usedLine = $derived.by(() => {
		const b = sampleDone?.binding;
		if (!b) return null;
		const dataset = ctx?.datasets.find((d) => d.slug === b.slug)?.name;
		const step = steps.find((s) => s.id === b.nodeId)?.label;
		return dataset && step ? m.build_sample_used({ dataset, step }) : null;
	});
	const sampleDisabled = $derived(
		sample?.state === 'running' || outcome?.state === 'running' || builder.readOnly || builder.nodes.length === 0
	);

	const ctx = $derived(builder.challengeContext);
	// In challenge mode show the challenge's datasets; otherwise browse all of the builder's.
	let browseAll = $state<DatasetRow[]>([]);
	// ⚠️ `listAll()` RESOLVES `{items,total,capped}`, NOT A BARE ARRAY, and these two fields are why.
	// `total` is the server's own count for the query and `capped` says the walk stopped at
	// `MAX_DATASET_PAGES` with rows still outstanding — the only way this panel can tell the builder
	// that the list under it is short. Discarding them re-creates the page-1 defect further out.
	let browseTotal = $state(0);
	let browseCapped = $state(false);
	const browsing = $derived(!ctx);

	type Item = { slug: string; name: string; rowCount: number; note: string };
	const items = $derived<Item[]>(
		ctx
			? ctx.datasets.map((d) => ({ slug: d.slug, name: d.name, rowCount: d.rowCount, note: d.note }))
			: browseAll.map((d) => ({ slug: d.slug, name: d.name, rowCount: d.rowCount, note: '' }))
	);

	let previews = $state<Record<string, { columns: DatasetColumn[]; rows: Record<string, unknown>[]; maskedColumns?: string[] }>>({});
	let open = $state<Set<string>>(new Set());

	// ⛔ THE BROWSE LIST'S FAILURE, WHICH USED TO BE RENDERED AS "you have no datasets".
	// `catch { browseAll = []; }` collapsed a 500 / a dropped connection into the same empty array an
	// account with no test data produces, and the `{#if items.length === 0}` branch below then printed
	// `challenge_data_empty` — "Je hebt nog geen datasets." That is a FALSE FACT about the reader's
	// workspace, and the move it implies (go to /datasets and make one) is the wrong move. Identical
	// swallow, identical fix, as `/submit` (+page.svelte) and `/challenges/[id]` (`startEditData`).
	//
	// ⚠️ SCOPED TO BROWSE MODE. In challenge mode `items` comes from `builder.challengeContext`, which
	// arrived with the flow — no fetch, so `build_data_empty` ("no datasets are linked to this
	// challenge") is a true statement there and stays untouched.
	//
	// `errorText`, not `writeErrorText`: a GET has no 400/422/409 sentence of its own to prefer.
	let browseError = $state<string | null>(null);
	async function loadBrowse() {
		browseError = null;
		try {
			// `listAll()`, not `list({ page: 1 })`: the endpoint pages at 12 and this panel has no pager,
			// so page one was silently presented as "all the builder's datasets".
			const all: AllDatasets = await datasetsApi.listAll();
			browseAll = all.items;
			browseTotal = all.total;
			browseCapped = all.capped;
		} catch (e) {
			// `browseAll` left as-is: on a failed RETRY the list already on screen is still the truest
			// set we have, and blanking it would turn a transient failure into a lost panel.
			browseError = errorText(e, m.challenge_data_load_failed());
		}
	}
	onMount(() => {
		if (browsing) void loadBrowse();
	});

	// Per-slug preview failures. ⛔ NOT one shared string: each row is its own request behind its own
	// toggle, and one dataset's 500 must not caption the dataset beside it.
	let previewErrors = $state<Record<string, string>>({});

	/** Returns whether the preview is now in hand. */
	async function loadPreview(slug: string): Promise<boolean> {
		if (previews[slug]) return true;
		try {
			const d = await datasetsApi.get(slug, { limit: 5 });
			previews = { ...previews, [slug]: { columns: d.columns, rows: d.rows, maskedColumns: d.maskedColumns } };
			const { [slug]: _gone, ...rest } = previewErrors;
			previewErrors = rest;
			return true;
		} catch (e) {
			// ⛔ WAS `catch { /* no preview */ }`. Invisible on its own — but `togglePreview` had ALREADY
			// added the slug to `open` before awaiting, and the button's label is
			// `open.has(slug) ? build_data_hide : build_data_preview`. So a failed fetch left a control
			// reading "Verbergen" over a row where nothing was ever shown, and pressing it hid nothing.
			// Same defect, same fix, as `/challenges/[id]` — see the comment on its `togglePreview`.
			previewErrors = { ...previewErrors, [slug]: errorText(e, m.dataset_preview_load_failed()) };
			return false;
		}
	}
	async function togglePreview(slug: string) {
		const next = new Set(open);
		if (next.has(slug)) {
			next.delete(slug);
			open = next;
			return;
		}
		// Opened OPTIMISTICALLY so the row does not sit inert while the fetch is in flight…
		next.add(slug);
		open = next;
		// …and rolled back out if the fetch failed. A button that says "Hide" over an empty row is the
		// same lie one verb further on: there is nothing to hide. The failure is reported by
		// `previewErrors` instead, which renders whether or not the row is open.
		if (!(await loadPreview(slug))) {
			const back = new Set(open);
			back.delete(slug);
			open = back;
		}
	}

	// The first dataset-typed input on the selected node, if any — the wire-in target.
	const datasetInput = $derived.by(() => {
		const node = builder.selectedNode;
		if (!node) return null;
		const inputs = Object.entries(node.data.descriptor?.inputs ?? {});
		const found = inputs.find(([, spec]) => spec.type === 'dataset');
		return found ? { nodeId: node.id, handle: found[0] } : null;
	});

	// Why "Use" is inert: no block selected, or the selected block has no dataset input. Saying
	// "select a block first" while one IS selected sent the reader looking for a step they had done.
	const gateText = $derived(builder.selectedNode ? m.build_data_node_no_dataset() : m.build_data_select_node_first());

	function useInNode(slug: string) {
		if (!datasetInput) return;
		builder.updateConfig(datasetInput.nodeId, datasetInput.handle, slug);
	}
</script>

<div class="data-panel">
	<!-- In the side pane the tab is the heading ("Sample data"); a second, different heading inside
	     it ("Challenge data") read as a different thing. Only a standalone mount (with onClose) has one. -->
	{#if onClose}
		<header>
			<div class="dp-title">
				{#if ctx}{m.build_data_panel_title()}{:else}{m.build_data_browser_title()}{/if}
			</div>
			{#if onClose}
				<button class="dp-x" onclick={onClose} aria-label={m.challenge_data_cancel()}>✕</button>
			{/if}
		</header>
	{/if}

	{#if ctx}
		<div class="dp-challenge">{ctx.title}</div>
		{#if ctx.involves.length}
			<div class="dp-involves">
				<span class="dp-involves-label">{m.challenge_involves_label()}</span>
				{#each ctx.involves as ent (ent)}<span class="dp-chip">{ent}</span>{/each}
			</div>
		{/if}
	{/if}

	{#if ctx && onSampleTest}
		<!-- W8/P4: one click runs the flow on this challenge's sample data — the server binds it to the
		     first step that reads data, and masks it the way this reader's preview is masked. -->
		<div class="dp-sample" data-testid="sample-test">
			<button type="button" class="dp-sample-btn" data-testid="sample-test-run" disabled={sampleDisabled} onclick={onSampleTest}>
				{sample?.state === 'running' || outcome?.state === 'running' ? m.build_sample_testing() : m.build_sample_test()}
			</button>
			{#if sample?.state === 'none_linked'}
				<p class="dp-sample-note" role="status" data-testid="sample-none-linked">
					{m.build_sample_none_linked()}
					{#if ctx.canEditDatasets}<a href={`/challenges/${ctx.id}`} data-testid="sample-link">{m.build_sample_link()}</a>{/if}
				</p>
			{:else if sample?.state === 'no_input'}
				<p class="dp-sample-note" role="status" data-testid="sample-no-input">{m.build_sample_no_input()}</p>
				{#if sample.dataBlock && onAddBlock}
					{@const blk = sample.dataBlock}
					<button type="button" class="dp-link" data-testid="sample-add-block" onclick={() => onAddBlock(blk.slug)}>
						{m.build_sample_add_block({ name: blk.name })}
					</button>
				{/if}
			{:else if sampleDone}
				{#if usedLine}<p class="dp-sample-note" data-testid="sample-used">{usedLine}</p>{/if}
				{#if outcome?.state === 'failed'}
					<p class="dp-sample-fail" role="alert" data-testid="sample-failed">{m.build_sample_failed()}</p>
					{#if outcome.failures.length}
						<ul class="dp-findings" data-testid="sample-failures">
							{#each outcome.failures as f, i (i)}
								<li>{#if f.step}<span class="dp-step">{f.step}</span> {/if}{f.text}</li>
							{/each}
						</ul>
					{/if}
				{/if}
				{#if friendly.length}
					<ul class="dp-findings" data-testid="sample-findings">
						{#each friendly as f, i (i)}
							<li>{#if f.step}<span class="dp-step">{f.step}</span> {/if}{f.text}</li>
						{/each}
					</ul>
					<details class="dp-details" data-testid="sample-details">
						<summary>{m.build_sample_details()}</summary>
						<ul>
							{#each sampleDone.findings as f, i (i)}
								<li><span class="dp-ref">{dataFindingRef(f)}</span> {dataFindingLabel(f)}</li>
							{/each}
						</ul>
					</details>
				{:else if outcome?.state === 'passed'}
					<p class="dp-sample-note" role="status" data-testid="sample-ok">{m.build_sample_ok()}</p>
				{/if}
			{/if}
		</div>
	{/if}

	{#if browseError}
		<p class="dp-error" role="alert" data-testid="browse-error">
			<span>{browseError}</span>
			<button type="button" class="dp-retry" onclick={loadBrowse}>{m.error_load_retry()}</button>
		</p>
	{/if}

	<!-- The walk hit its ceiling with datasets still outstanding. The list below is then a SAMPLE of
	     the builder's test data, and a sample presented as a library is the same lie as page one
	     presented as the whole list — so name the server's real total and point at the screen that can
	     reach the rest. ⚠️ `browseCapped` is only ever written by `loadBrowse`, which only runs in
	     browse mode, so challenge mode cannot reach this line. ⚠️ `role="status"`, not `"alert"`:
	     nothing failed, the list is simply short. -->
	{#if browseCapped}
		<p class="dp-capped" role="status" data-testid="datasets-capped">
			{m.datasets_picker_capped({
				shown: num(browseAll.length, locale.current),
				total: num(browseTotal, locale.current)
			})}
			<a href="/datasets">{m.nav_datasets()}</a>
		</p>
	{/if}

	<!-- ⛔ THE EMPTY LINE IS GATED ON `!browseError`, NOT CHAINED AFTER IT. Rendered together, "Je hebt
	     nog geen datasets." would sit on screen contradicting the failure notice — the exact sentence
	     this fix exists to stop showing. But the LIST still renders when it holds rows: a retry that
	     fails leaves `browseAll` intact on purpose, and hiding data we already have behind an error
	     about the attempt to refresh it would make the retry button cost the reader something. -->
	<!-- ⛔ THE KEYBOARD-REACHABLE HALF OF THE REASON. Every "Gebruiken" button below is inert
	     until a node with a dataset input is selected on the canvas, and until now the only
	     explanation lived in a `title` on a disabled button — i.e. nowhere. Stated ONCE above the
	     list rather than per row: it is one fact about the canvas selection, not about any
	     dataset. `role="status"`, not `"alert"`: nothing failed. -->
	{#if items.length > 0 && !datasetInput}
		<p class="dp-gate" role="status" data-testid="use-gate">{gateText}</p>
	{/if}
	{#if items.length > 0}
		<ul class="dp-list">
			{#each items as it (it.slug)}
				<li>
					<div class="dp-row">
						<span class="dp-name">{it.name}</span>
						<span class="dp-meta">{num(it.rowCount, locale.current)}</span>
					</div>
					{#if it.note}<p class="dp-note">{it.note}</p>{/if}
					<div class="dp-actions">
						<button class="dp-link" onclick={() => togglePreview(it.slug)}>{open.has(it.slug) ? m.build_data_hide() : m.build_data_preview()}</button>
						<!-- ⛔ THE `title` MOVED ONTO A WRAPPER, AND THAT IS NOT COSMETIC: A DISABLED BUTTON FIRES
						     NO POINTER EVENTS, so a `title` on the button itself NEVER surfaces a tooltip. The one
						     sentence explaining why this control is inert was therefore unreachable by every reader,
						     by every means — it existed only in the source. `VoteButton.svelte` states this rule for
						     this codebase in writing; this site predated it.
						     ⚠️ AND A TOOLTIP IS NOT KEYBOARD-REACHABLE EITHER, which is why the same fact is now on
						     screen once, above the list (see `.dp-gate`). The wrapper is the supplement; the line is
						     the answer. `display: contents` keeps the row's flex layout exactly as it was. -->
						<span class="gate-wrap" title={datasetInput ? undefined : gateText}>
							<button
								class="dp-use"
								disabled={!datasetInput}
								aria-disabled={!datasetInput}
								onclick={() => useInNode(it.slug)}
							>{m.build_data_use()}</button>
						</span>
					</div>
					{#if open.has(it.slug) && previews[it.slug]}
						<!-- ⛔ `totalRows`, AND IT COSTS NOTHING HERE. The preview fetch is `{ limit: 5 }` and
						     the server caps the array in SQL, so `DatasetPreviewTable`'s notice was asking
						     `5 > 5` and could not fire on this panel — a five-row window onto a 12 480-row
						     sheet, presented as the whole thing. `it.rowCount` is the SAME figure the row
						     directly above already prints through `num()`; there is no second request and
						     nothing to invent. -->
						<DatasetPreviewTable columns={previews[it.slug].columns} rows={previews[it.slug].rows} maxRows={5} totalRows={it.rowCount} maskedColumns={previews[it.slug].maskedColumns} />
					{:else if previewErrors[it.slug]}
						<!-- The box that used to be nothing at all. Without it, "the preview failed" and "the
						     request is still in flight" render identically, and the reader waits for a table
						     that is never coming. Rendered whether or not the row is open, because the toggle
						     has by then rolled back to "Preview" and the reason must survive that. -->
						<p class="dp-preview-error" role="alert" data-testid={`preview-error-${it.slug}`}>{previewErrors[it.slug]}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if !browseError}
		<p class="dp-empty">
			{ctx ? m.build_data_empty() : m.challenge_data_empty()}
			<!-- W8/P4: nothing linked → point the people who MAY link (creator, admins — F1) at the place. -->
			{#if ctx?.canEditDatasets}<a href={`/challenges/${ctx.id}`} data-testid="empty-link">{m.build_sample_link()}</a>{/if}
		</p>
	{/if}
</div>

<style>
	.dp-sample {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-surface);
	}
	.dp-sample-btn {
		align-self: flex-start;
		font-size: 12.5px;
		font-weight: 600;
		padding: 6px 10px;
		border-radius: var(--r-sm);
		border: 1px solid var(--c-teal-mid);
		background: var(--c-white);
		color: var(--c-teal-dark);
		cursor: pointer;
	}
	.dp-sample-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.dp-sample-note {
		margin: 0;
		font-size: 12px;
		color: var(--c-ink);
	}
	.dp-sample-note a,
	.dp-empty a {
		margin-inline-start: 4px;
	}
	.dp-sample-fail {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--c-coral-dark);
	}
	.dp-findings {
		margin: 0;
		padding-inline-start: 16px;
		font-size: 12px;
		color: var(--c-ink);
	}
	.dp-step {
		font-weight: 600;
	}
	.dp-details {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.dp-details ul {
		margin: 4px 0 0;
		padding-inline-start: 16px;
	}
	.dp-ref {
		font-family: var(--font-mono);
	}
	.data-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		height: 100%;
		overflow-y: auto;
		padding: 14px;
		box-sizing: border-box;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.dp-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.dp-x {
		background: none;
		border: none;
		color: var(--c-muted);
		cursor: pointer;
		font-size: 13px;
	}
	.dp-challenge {
		font-size: 12.5px;
		color: var(--c-ink);
		font-weight: 500;
	}
	.dp-involves {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		align-items: center;
	}
	.dp-involves-label {
		font-size: 11px;
		color: var(--c-muted);
	}
	.dp-chip {
		font-size: 10.5px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--c-teal-pale);
		color: var(--c-teal-dark);
		border: 1px solid var(--c-teal-light);
	}
	.dp-empty {
		font-size: 12px;
		color: var(--c-faint);
	}
	/* The same coral failure treatment as `/submit`'s `.ds-preview-error` — a failed read looks the
	   same everywhere in this app, so the reader learns the colour once. */
	.dp-error,
	.dp-preview-error {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-sm);
		padding: 6px 9px;
		margin: 0;
		line-height: 1.45;
	}
	.dp-error {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.dp-retry {
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
	/* The completeness disclosure. ⛔ NOT the coral `.dp-error` treatment: nothing failed here, so it
	   takes the muted `.dp-empty` tone. Same choice as `/submit`'s `.ds-capped`. */
	.dp-capped {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 0;
		line-height: 1.5;
	}
	.dp-capped a {
		color: var(--c-teal-dark);
		margin-inline-start: 4px;
	}
	.dp-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.dp-list li {
		display: flex;
		flex-direction: column;
		gap: 5px;
		border-bottom: 1px solid var(--c-border);
		padding-bottom: 10px;
	}
	.dp-list li:last-child {
		border-bottom: none;
	}
	.dp-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.dp-name {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.dp-meta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-faint);
		margin-inline-start: auto;
	}
	.dp-note {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 0;
		line-height: 1.45;
	}
	.dp-actions {
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.dp-link {
		font-size: 11.5px;
		color: var(--c-teal-dark);
		background: none;
		border: none;
		cursor: pointer;
		font-weight: 500;
	}
	.dp-use {
		margin-inline-start: auto;
		font-size: 11.5px;
		font-weight: 600;
		color: #fff;
		background: var(--c-teal);
		border: none;
		border-radius: var(--r-sm);
		padding: 4px 10px;
		cursor: pointer;
	}
	.dp-use:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	/* Holds the `title` a disabled button cannot fire. `display: contents` removes the box but not
	   the tooltip — the title still resolves from the child — so the actions row is spaced as before. */
	.gate-wrap {
		display: contents;
	}
	.dp-gate {
		margin: 0 0 8px;
		font-size: 11.5px;
		color: var(--c-faint);
	}
</style>
