<script lang="ts">
	// Inspector for the selected node — set literal config values for each
	// descriptor input. Inputs already fed by an incoming edge are marked
	// "from upstream" (config acts as a fallback/override). Beyond the static
	// demo, but Session 3's runner needs these literals.
	import { onMount } from 'svelte';
	import { type BuilderStore, HARD_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS } from '$lib/stores/builder.svelte';
	import type { FieldSpec } from '$lib/types/blocks';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	import type { DatasetColumn, DatasetRow, DatasetMapping } from '$lib/types/datasets';
	import DatasetPicker from '$lib/components/DatasetPicker.svelte';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import { errorText } from '$lib/api/error-message';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { flowArrow } from '$lib/i18n/direction';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';
	import { portLabel } from '$lib/i18n/port-label';
	import { enumOptionLabel } from '$lib/i18n/enum-option-label';
	import { fieldTypes } from '$lib/stores/field-types.svelte';
	import { nodeDisplayName } from '$lib/stores/block-catalog.svelte';

	let {
		builder,
		canMapData = false
	}: {
		builder: BuilderStore;
		/**
		 * May this reader map dataset columns (/datasets, developer+)? Only then does the "no field
		 * mapping" line tell them to go and do it; a member reads the fact without the instruction.
		 */
		canMapData?: boolean;
	} = $props();

	const node = $derived(builder.selectedNode);
	// The store's ONE effective read-only (someone else's flow, or a screen too narrow to edit on).
	// The store refuses the write either way; this keeps the panel from offering it.
	const locked = $derived(builder.locked);
	const inputs = $derived(
		node ? Object.entries(node.data.descriptor?.inputs ?? {}) : []
	);
	// Phase 5: foreach (loop) authoring.
	const isForeach = $derived(node?.data.kind === 'foreach');
	const loops = $derived(builder.nodes.filter((n) => n.data.kind === 'foreach'));

	function setMaxIter(raw: string) {
		if (!node) return;
		const n = Math.max(1, Math.min(HARD_MAX_ITERATIONS, Math.floor(Number(raw) || DEFAULT_MAX_ITERATIONS)));
		builder.setLoopConfig(node.id, { maxIterations: n });
	}

	// Available datasets for any dataset-typed input (Phase 2.0). The picker writes the dataset slug
	// as the node-config value (same as the agent's `configure_node`).
	//
	// ⛔ `listAll()`, NOT `list({ page: 1 })`. `GET /api/datasets` pages at 12
	// (backend/src/routes/datasets.ts), and this panel has no pager — so a builder with more than
	// twelve datasets could not configure a node with the thirteenth, and a node ALREADY configured
	// with it rendered as unconfigured (see the `unlisted` option in DatasetPicker). A dropdown that
	// silently shows page one of a paged endpoint is a dropdown that lies about the option set.
	let datasets = $state<DatasetRow[]>([]);
	// ⚠️ AND `listAll()` RESOLVES AN OBJECT, NOT AN ARRAY — these two fields are the reason why.
	// `items` on its own cannot say "there are more datasets than these": `total` is the SERVER's own
	// count for the query and `capped` is the walk admitting it stopped at `MAX_DATASET_PAGES` with
	// rows still outstanding. Thrown away, they leave a dropdown that is short and silent — the same
	// defect as the page-1 read this fix replaced, one order of magnitude further out.
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);
	// ⛔ NOT `datasets = []` ON FAILURE. An empty array makes DatasetPicker render its `emptyHint` —
	// "Nog geen datasets — maak er een aan op het scherm Datasets." — so a 500 or a dropped connection
	// was reported to the builder as a FACT ABOUT THEIR WORKSPACE, and the action it points at is one
	// they have already taken. Same fix as `/submit` (+page.svelte) and `/challenges/[id]`
	// (`startEditData`), which had the identical swallow against the identical picker.
	//
	// ONE error for the whole panel, not one per field: `datasets` is a single shared fetch, so a
	// failure is one fact about one request. Rendering it per dataset-typed input would repeat the
	// same sentence as many times as the block has dataset inputs.
	//
	// `errorText`, not `writeErrorText`: this is a READ. `writeErrorText` prefers the backend's own
	// sentence on the 400/422/409 a rejected WRITE produces, and a GET has none of those to offer.
	let datasetsError = $state<string | null>(null);
	async function loadDatasets() {
		datasetsError = null;
		try {
			const all: AllDatasets = await datasetsApi.listAll();
			datasets = all.items;
			datasetsTotal = all.total;
			datasetsCapped = all.capped;
		} catch (e) {
			// `datasets` is deliberately LEFT AS IT WAS. On a first load it is already `[]`; on a failed
			// RETRY the previously loaded list is still the best set of options we have, and blanking it
			// would turn a transient failure into a lost picker.
			datasetsError = errorText(e, m.challenge_data_load_failed());
		}
	}
	// `void`, not `onMount(loadDatasets)`: an async function returns a Promise, and onMount treats a
	// returned value as its cleanup callback.
	onMount(() => void loadDatasets());
	// Does the selected block have anything this list feeds? A block with no dataset-typed input never
	// renders a picker, so a banner about a dataset list it does not use would be noise about a request
	// the reader has no stake in.
	const hasDatasetInput = $derived(inputs.some(([, spec]) => spec.type === 'dataset'));

	// Phase 3.1: inline preview for a selected dataset-typed input — lazy-fetch a few
	// rows per slug and cache, so the builder sees the actual data on the node, not just
	// the slug. Best-effort: a load failure simply renders no preview.
	// ⛔ `rowCount` IS KEPT, AND DISCARDING IT WAS THE DEFECT. The response is a `DatasetDetail` and
	// has always carried the dataset's true size; this cache narrowed it to `{ columns, rows }`, so
	// the mount below had nothing to hand `DatasetPreviewTable` as `totalRows` and its truncation
	// notice asked `5 > 5` — unreachable, on a five-row window onto a sheet of any size.
	//
	// ⚠️ FROM THE RESPONSE, NOT FROM `datasets`. The obvious alternative —
	// `datasets.find((x) => x.slug === slug)?.rowCount` — has a hole this one does not: a node can
	// be configured with a dataset outside the walked list (that is what `DatasetPicker`'s
	// `unlisted` option exists for), and it would then silently be `undefined`. The response is the
	// authority on the dataset it just returned.
	let datasetPreviews = $state<Record<string, { columns: DatasetColumn[]; rows: Record<string, unknown>[]; rowCount: number; maskedColumns?: string[] }>>({});
	/**
	 * Per-slug preview failures.
	 *
	 * ⛔ `loadPreview` USED TO END IN A BARE `catch`, AND THE TABLE IS BEHIND `{#if preview}` — so a
	 * 500, a 403 or a dropped connection rendered PIXEL-FOR-PIXEL as a request still in flight: the
	 * picker, and then nothing. The builder waits for rows that are never coming, on the panel where
	 * they are choosing which data a block reads. `/submit`, `ChallengeDataPanel` and
	 * `/challenges/[id]` each closed this identical swallow against this identical component; the
	 * inspector was the fourth copy and the one that got missed.
	 *
	 * ⛔ PER SLUG, NOT ONE SHARED STRING — the same reason the three siblings give: each dataset is
	 * its own request, and one dataset's 500 must not caption the dataset beside it. (Contrast
	 * `datasetsError` above, which is ONE fact about ONE shared list fetch and is correctly shared.)
	 *
	 * ⚠️ `errorText`, not `writeErrorText`: a GET has no 400/422/409 sentence of its own to prefer.
	 */
	let datasetPreviewErrors = $state<Record<string, string>>({});
	async function loadPreview(slug: string) {
		if (!slug || datasetPreviews[slug]) return;
		try {
			const d = await datasetsApi.get(slug, { limit: 5 });
			datasetPreviews = { ...datasetPreviews, [slug]: { columns: d.columns, rows: d.rows, rowCount: d.rowCount, maskedColumns: d.maskedColumns } };
			// A retry that succeeds clears the notice: this is a fact about the LAST attempt for this
			// slug, not a sticky flag.
			const { [slug]: _gone, ...rest } = datasetPreviewErrors;
			datasetPreviewErrors = rest;
		} catch (e) {
			datasetPreviewErrors = { ...datasetPreviewErrors, [slug]: errorText(e, m.dataset_preview_load_failed()) };
		}
	}
	// Wave B1: surface the ontology mapping a dataset already carries, so the builder is
	// helped by the datasets+ontology work — the picked dataset shows WHICH entity its
	// columns map to (typed, PII-flagged), not just opaque rows. Lazy + cached; best-effort.
	// `null` = loaded-but-unmapped (distinct from "not yet loaded").
	let datasetMappings = $state<Record<string, DatasetMapping[] | null>>({});
	/**
	 * Per-slug mapping-fetch failures.
	 *
	 * ⛔ A FAILED READ USED TO BE REPORTED AS A FACT ABOUT THE DATASET. The catch wrote
	 * `datasetMappings[slug] = null`, and `null` is this map's value for "loaded, and there is no
	 * mapping" — which the panel renders as `nodecfg_ontology_none`: "Nog geen ontologiekoppeling —
	 * koppel de kolommen van deze dataset op het scherm Datasets…". So a 500 on
	 * `GET /api/datasets/:slug/mappings` sent a builder off to redo work that already exists, and the
	 * ontology grounding they were told to go and create was sitting there the whole time. Same
	 * species as the `datasets = []` swallow this file's own header documents, one field over.
	 *
	 * ⚠️ `datasetMappings[slug]` IS STILL SET TO `null` ON FAILURE, AND THAT IS DELIBERATE — it is
	 * what `loadMappings`' own `slug in datasetMappings` guard tests, and what the template's
	 * `{#if slug in datasetMappings}` uses to decide the card exists at all. Dropping it would make
	 * the `$effect` re-fetch on every tick. The error map is what tells the two `null`s apart.
	 */
	let datasetMappingErrors = $state<Record<string, string>>({});
	async function loadMappings(slug: string) {
		if (!slug || slug in datasetMappings) return;
		try {
			const res = await datasetsApi.listMappings(slug);
			datasetMappings = { ...datasetMappings, [slug]: res.mappings ?? [] };
			const { [slug]: _gone, ...rest } = datasetMappingErrors;
			datasetMappingErrors = rest;
		} catch (e) {
			datasetMappings = { ...datasetMappings, [slug]: null };
			datasetMappingErrors = { ...datasetMappingErrors, [slug]: errorText(e, m.nodecfg_ontology_load_failed()) };
		}
	}
	/** Re-run a failed mapping read. ⛔ The cache entry has to be EVICTED first — unlike `loadPreview`,
	 *  this loader writes `null` on failure, so its own guard would swallow the retry. */
	function retryMappings(slug: string) {
		const { [slug]: _gone, ...rest } = datasetMappings;
		datasetMappings = rest;
		void loadMappings(slug);
	}
	/** The best (most-confident, confirmed-first) mapping for a slug, or null. */
	function bestMapping(slug: string): DatasetMapping | null {
		const list = datasetMappings[slug];
		if (!list || list.length === 0) return null;
		return [...list].sort(
			(a, b) => Number(b.confirmed) - Number(a.confirmed) || b.confidence - a.confidence,
		)[0]!;
	}
	/**
	 * Is a dataset column PII — or do we not yet know?
	 *
	 * ⛔ `boolean | null`, AND THE THIRD STATE IS THE POINT. This returned `Boolean(...)`, so an
	 * ABSENT preview — the request still in flight, or failed — read as "not PII" for every column,
	 * and the PII badges simply did not render. A missing badge is indistinguishable from a column
	 * the ontology says is safe, on the one panel where a builder decides what data a block may see.
	 * `null` is what the caller renders `nodecfg_ontology_schema_unknown` for.
	 */
	function colIsPii(slug: string, col: string): boolean | null {
		const cols = datasetPreviews[slug]?.columns;
		if (!cols) return null;
		return Boolean(cols.find((c) => c.name === col)?.pii);
	}

	// Whenever the selected node's dataset inputs change, ensure their previews + mappings are loaded.
	$effect(() => {
		if (!node) return;
		for (const [name, spec] of inputs) {
			if (spec.type === 'dataset') {
				const v = node.data.config[name];
				if (typeof v === 'string' && v) {
					void loadPreview(v);
					void loadMappings(v);
				}
			}
		}
	});

	function setVal(name: string, spec: FieldSpec, raw: string | boolean) {
		if (!node) return;
		let value: unknown = raw;
		if (spec.type === 'number') value = raw === '' ? undefined : Number(raw);
		else if (spec.type === 'boolean') value = Boolean(raw);
		else if (spec.type === 'json' || spec.type === 'string[]') {
			try {
				value = raw === '' ? undefined : JSON.parse(raw as string);
			} catch {
				value = raw; // keep raw text; user is mid-edit
			}
		}
		builder.updateConfig(node.id, name, value);
	}
	function asText(v: unknown): string {
		if (v === undefined || v === null) return '';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}
</script>

<div class="cfg">
	{#if !node}
		<div class="cfg-empty">
			<p>{m.nodecfg_empty_title()}</p>
			<span>{m.nodecfg_empty_hint()}</span>
		</div>
	{:else}
		<div class="cfg-head">
			<!-- ⛔ THE CATALOG STRING FOR A LOOP, THE STORED LABEL FOR EVERYTHING ELSE. `newForeachNode`
			     (stores/builder-graph.ts) stamps `label: 'For each row'` and `toGraph()` PERSISTS it into
			     `flows.graph`, so the English is the wire/machine half and must stay there byte-for-byte —
			     localizing at creation time would freeze the creator's locale into the saved flow for ever.
			     `ForeachNode.svelte` already resolves the catalog string on the canvas; this header sits two
			     panels away from it, so leaving it raw made ONE node carry TWO names on ONE screen ("Lus
			     (voor elke rij)" on the canvas, "For each row" here).

			     ⚠️ AND THE `kind === 'foreach'` GUARD IS LOAD-BEARING HERE, unlike in `ForeachNode.svelte`
			     where the component itself is the discriminator. This sub-title renders for EVERY selected
			     node, and a block's `data.label` is that block's real author-facing name with no catalog
			     entry of its own — an unguarded swap would rename every block in the product to the loop's
			     title. Both directions are pinned by `node-config.foreach-label.i18n.render.test.ts`.

			     ⚠️ THAT GUARD NOW LIVES IN `nodeDisplayName`, WHICH IS WHY IT NO LONGER APPEARS HERE.
			     It is rung 1 of `$lib/i18n/block-node-label` and reads exactly as it did; what the shared
			     helper ADDS is the rung above `data.label` — the CURRENT catalog name for the slug. That
			     matters most on this panel, because a flow saved by an English-speaking colleague carries
			     English `label`s frozen into `flows.graph`, and the inspector was printing them verbatim
			     in all eight locales. The raw slug sits under it, for developers only (`.cfg-id`). -->
			<div class="cfg-title">{nodeDisplayName(node.data)}</div>
			<!-- The block's raw identifier is a developer's fact, shown with the field types (toolbar ⋯
			     menu) and nowhere else: a business reader names a step by its name, not `lookup-policy`. -->
			{#if fieldTypes.visible}<div class="cfg-id" data-testid="cfg-raw-id">{node.data.slug}</div>{/if}
		</div>
		<div class="cfg-body">
			{#if isForeach}
				<div class="loop-cfg">
					<label class="field">
						<div class="field-head">
							<span class="field-name">{m.nodecfg_foreach_max()}</span>
							<!-- ⛔ THE BOUND OF THE FIGURE ON THE CANVAS BADGE, AND THE SCAN CANNOT SEE IT.
							     `HARD_MAX_ITERATIONS` is `export const … = 1000` in builder-graph.ts — no
							     annotation, imported across a module boundary — so it is in neither the field
							     vocabulary nor this file's locals. It is exactly 1000, i.e. "1.000" in nl/de,
							     and it renders in the inspector while `ForeachNode`'s grouped `× tot 1.000`
							     badge sits on the selected node beside it. Grouping one and not the other is
							     the same one-screen contradiction, so both move together. -->
							<span class="field-type">≤ {num(HARD_MAX_ITERATIONS, locale.current)}</span>
						</div>
						<input
							type="number"
							min="1"
							max={HARD_MAX_ITERATIONS}
							value={node.data.loop?.maxIterations ?? DEFAULT_MAX_ITERATIONS}
							disabled={locked}
							onchange={(e) => setMaxIter(e.currentTarget.value)}
						/>
					</label>
					<div class="cfg-note">{m.nodecfg_foreach_rows_note()}</div>
				</div>
			{:else}
				{#if inputs.length === 0}
					<div class="cfg-note">{m.nodecfg_no_inputs()}</div>
				{/if}
				{#if datasetsError && hasDatasetInput}
					<!-- Rendered ABOVE the pickers rather than instead of them (which is what /submit does):
					     the node may already CARRY a configured slug, and that slug is the one thing the
					     builder most needs to see here. The picker keeps showing it via its `unlisted` option;
					     `emptyHint` is blanked below so the widget cannot contradict this line. -->
					<p class="cfg-error" role="alert" data-testid="datasets-error">
						<span>{datasetsError}</span>
						<button type="button" class="cfg-retry" onclick={loadDatasets}>{m.error_load_retry()}</button>
					</p>
				{/if}
				<!-- The walk stopped at its ceiling with datasets still outstanding. Name the SERVER's
				     total (not the number we managed to fetch) and point at the screen that can reach the
				     rest — a picker that is short and says nothing is precisely the defect this whole
				     change exists to close, and "the thirteenth dataset is missing" and "the 241st dataset
				     is missing" read identically to the builder configuring the node.

				     ⚠️ GATED ON `hasDatasetInput`, like the failure notice above: a block with no
				     dataset-typed input renders no picker, so the completeness of a list it never offers
				     is not news the reader has any stake in.
				     ⚠️ `role="status"`, not `role="alert"`: nothing failed. The list arrived, it is simply
				     not the whole of it, and the muted tone below says so. -->
				{#if datasetsCapped && hasDatasetInput}
					<p class="cfg-capped" role="status" data-testid="datasets-capped">
						{m.datasets_picker_capped({
							shown: num(datasets.length, locale.current),
							total: num(datasetsTotal, locale.current)
						})}
						<a href="/datasets">{m.nav_datasets()}</a>
					</p>
				{/if}
				{#each inputs as [name, spec] (name)}
				{@const connected = builder.isInputConnected(node.id, name)}
				<label class="field" data-field-name={name}>
					<div class="field-head">
						<span class="field-name" title={fieldTypes.visible ? undefined : name}>{fieldTypes.visible ? name : portLabel(name, spec)}</span>
						<!--
						⛔ `m.blockedit_flag_req()`, NOT THE LITERAL `'req'`. The type half of this badge
						went through `fieldTypeLabel` and the required half did not, so a Dutch reader
						got "Tekst ·req" — one chip, two languages, on EVERY required port of EVERY node
						on the product's primary authoring surface. The key already existed and was
						already rendering the same concept one screen away, on the /block-edit I/O
						editor's "verpl" checkbox (routes/block-edit/+page.svelte). Reusing it is what
						keeps the two screens saying the same word for the same flag; a new key here
						would have been a second vocabulary for one idea.
						⚠️ THE `·` STAYS OUTSIDE THE MESSAGE. It is a separator glyph, not a word — the
						catalogs carry "req"/"verpl", never " ·req", so no locale has to reproduce
						punctuation it does not own.
						-->
						{#if fieldTypes.visible}
							<span class="field-type">{fieldTypeLabel(spec.type)}{spec.required ? ` ·${m.blockedit_flag_req()}` : ''}</span>
						{:else if spec.required}
							<span class="field-req" title={m.build_field_required()} aria-label={m.build_field_required()}>*</span>
						{/if}
					</div>
					{#if connected}
						<div class="from-upstream"><span class="cp-dir-mirror" aria-hidden="true">←</span> {m.nodecfg_from_upstream()}</div>
					{:else if spec.type === 'boolean'}
						<input
							type="checkbox"
							checked={Boolean(node.data.config[name])}
							disabled={locked}
							onchange={(e) => setVal(name, spec, e.currentTarget.checked)}
						/>
					{:else if spec.type === 'enum'}
						<select
							value={asText(node.data.config[name])}
							disabled={locked}
							onchange={(e) => setVal(name, spec, e.currentTarget.value)}
						>
							<option value="">—</option>
							<!-- The stored value stays the option code (`gte`); only the shown text is a label. -->
							{#each spec.enum ?? [] as opt (opt)}<option value={opt}>{enumOptionLabel(opt)}</option>{/each}
						</select>
					{:else if spec.type === 'dataset'}
						{@const slug = asText(node.data.config[name])}
						<DatasetPicker
							{datasets}
							selected={slug ? [slug] : []}
							placeholder={m.nodecfg_pick_dataset()}
							emptyHint={datasetsError ? '' : m.nodecfg_no_datasets()}
							disabled={locked}
							onchange={(slugs) => setVal(name, spec, slugs[0] ?? '')}
						/>
						{#if slug}
							{@const preview = datasetPreviews[slug]}
							<!-- ⛔ THE FAILURE ARM. Without it a failed fetch and an in-flight one are the SAME PIXELS —
							     the picker, then nothing — and the reader waits for a table that is never coming. Same
							     shape, `data-testid` and `role="alert"` as the three sibling mount sites that fixed this
							     first, and the same `.cfg-error`/`.cfg-retry` treatment this panel already uses for its
							     list failure, so a reader learns the colour once.
							     ⚠️ The retry really re-requests: `loadPreview` writes NO cache entry on failure, so its
							     `datasetPreviews[slug]` guard cannot short-circuit the second attempt. -->
							{#if datasetPreviewErrors[slug]}
								<p class="cfg-error" role="alert" data-testid={`preview-error-${slug}`}>
									<span>{datasetPreviewErrors[slug]}</span>
									<button type="button" class="cfg-retry" onclick={() => loadPreview(slug)}>{m.error_load_retry()}</button>
								</p>
							{/if}
							{#if preview}
								<!-- ⛔ `totalRows` — see `loadPreview`. Without it the notice's `total > shown.length`
							     test is `5 > 5` and the inspector shows five rows of a 12 480-row dataset with
							     nothing to say so. -->
							<DatasetPreviewTable columns={preview.columns} rows={preview.rows} maxRows={5} totalRows={preview.rowCount} maskedColumns={preview.maskedColumns} />
							{/if}
							{@const mapping = bestMapping(slug)}
							{#if slug in datasetMappings}
								<div class="onto" class:onto-unmapped={!mapping && !datasetMappingErrors[slug]}>
									<div class="onto-head">{m.nodecfg_ontology_title()}</div>
									<!-- ⛔ THE FAILURE ARM COMES FIRST, BEFORE `{#if mapping}` — because the two states it
									     separates are BOTH `mapping === null`. A read that FAILED used to fall straight through to
									     `nodecfg_ontology_none` and tell the builder to go and map a dataset that may well be
									     mapped already: an instruction to redo existing work, derived from a 500. -->
									{#if datasetMappingErrors[slug]}
										<p class="cfg-error" role="alert" data-testid={`mapping-error-${slug}`}>
											<span>{datasetMappingErrors[slug]}</span>
											<button type="button" class="cfg-retry" onclick={() => retryMappings(slug)}>{m.error_load_retry()}</button>
										</p>
									{:else if mapping}
										{@const cols = Object.keys(mapping.columnMap)}
										<!-- ⛔ THE DENOMINATOR IS MEASURED OR IT IS NOT STATED. This read
										     `preview?.columns.length ?? cols.length` — so whenever the preview was
										     absent the fraction became `cols.length / cols.length` and the panel
										     announced "3 van 3 kolommen gekoppeld": a 100% coverage figure derived
										     from the mapped set counting ITSELF as the total. And absent is not a
										     corner. `loadPreview` and `loadMappings` are fired UN-AWAITED from the
										     same `$effect`, so every time the mappings win the race the reader sees
										     that sentence before it corrects — and if the preview 500s it never
										     corrects at all.
										     ⚠️ `?? cols.length` was not a typo but a fallback, which is why it
										     survived: it produces a plausible number rather than a crash. A wrong
										     figure that looks right is the harder defect, not the softer one. -->
										{#if preview}
											<div class="onto-cov">
												{m.nodecfg_ontology_coverage({ mapped: num(cols.length, locale.current), total: num(preview.columns.length, locale.current), entity: mapping.entityLabel })}
											</div>
										{:else}
											<!-- Says the two things the missing schema costs, in one sentence: the
											     coverage fraction below is unavailable, and the PII marking on the
											     chips is UNKNOWN rather than negative. -->
											<div class="onto-cov onto-cov-unknown" data-testid="onto-schema-unknown">
												{m.nodecfg_ontology_schema_unknown()}
											</div>
										{/if}
										<!-- The chips come from the MAPPING, not the preview, so they stay — losing
										     them would trade one silence for another. Only the PII claim waits for a
										     schema: `=== true`, never truthiness, so `null` cannot read as `false`. -->
										<div class="onto-chips">
											{#each cols as col (col)}
												<span class="onto-chip" class:pii={colIsPii(slug, col) === true} title="{col} {flowArrow(getLocale())} {mapping.columnMap[col]}">
													<span class="onto-col">{col}</span>
													<span class="onto-arrow cp-dir-mirror" aria-hidden="true">→</span>
													<span class="onto-attr">{mapping.columnMap[col]}</span>
													{#if colIsPii(slug, col) === true}<span class="onto-pii">{m.nodecfg_pii()}</span>{/if}
												</span>
											{/each}
										</div>
									{:else}
										<div class="onto-none">{canMapData ? m.nodecfg_ontology_none() : m.nodecfg_ontology_none_member()}</div>
									{/if}
								</div>
							{/if}
						{/if}
					{:else}
						<input
							type={spec.type === 'number' ? 'number' : 'text'}
							placeholder={spec.type === 'json' || spec.type === 'string[]' ? m.nodecfg_value_ph() : ''}
							value={asText(node.data.config[name])}
							disabled={locked}
							oninput={(e) => setVal(name, spec, e.currentTarget.value)}
						/>
					{/if}
				</label>
				{/each}

				{#if node.data.parentId}
					<button class="loop-btn" disabled={locked} onclick={() => builder.removeFromLoop(node.id)}>
						{m.nodecfg_remove_from_loop()}
					</button>
				{:else if loops.length}
					<label class="field">
						<div class="field-head"><span class="field-name">{m.nodecfg_add_to_loop()}</span></div>
						<select
							value=""
							disabled={locked}
							onchange={(e) => { if (e.currentTarget.value) builder.assignToLoop(node.id, e.currentTarget.value); }}
						>
							<option value="">{m.nodecfg_add_to_loop_ph()}</option>
							<!-- Same stored-vs-shown split as `.cfg-title` above: every row here is a loop
						     (`loops` filters on `kind === 'foreach'`), so this list was the second place one node
						     showed two names. The guard is redundant against TODAY's filter and kept anyway — the
						     filter is one edit away from widening, and a silent English leak is what that edit
						     would cost. It is kept by going
							     through `nodeDisplayName`, which carries that guard as rung 1 for every site at once —
							     and which additionally re-resolves a BLOCK row's name from the current catalog, should
							     the filter ever widen. -->
							{#each loops as fe (fe.id)}<option value={fe.id}>{nodeDisplayName(fe.data)}</option>{/each}
						</select>
					</label>
				{/if}
			{/if}
		</div>
		{#if !locked}
			<div class="cfg-foot">
				<button class="del" onclick={() => builder.removeNode(node.id)}>
					{m.nodecfg_remove_block()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.cfg {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.cfg-empty {
		padding: 22px 16px;
		text-align: center;
	}
	.cfg-empty p {
		font-size: 13px;
		color: var(--c-muted);
		margin: 0 0 4px;
		font-weight: 500;
	}
	.cfg-empty span {
		font-size: 11.5px;
		color: var(--c-faint);
	}
	.cfg-head {
		padding: 14px 16px;
		border-bottom: 1px solid var(--c-border);
	}
	.cfg-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.cfg-id {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 2px;
	}
	.cfg-body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-height: 0;
	}
	.cfg-note {
		font-size: 12px;
		color: var(--c-faint);
	}
	/* Same coral failure treatment as `/submit`'s `.ds-preview-error` — a failed read looks the same
	   everywhere in this app, so the reader learns the colour once. */
	.cfg-error {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11.5px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r-sm);
		padding: 6px 9px;
		margin: 0;
		line-height: 1.45;
	}
	.cfg-retry {
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
	/* The "this dropdown does not list all of them" disclosure. ⛔ NOT `.cfg-error`, which is coral:
	   nothing has failed here — the panel is telling the reader the truth about its own completeness,
	   so it takes the muted `.cfg-note` tone instead. Same treatment as `/submit`'s `.ds-capped`. */
	.cfg-capped {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 0;
		line-height: 1.5;
	}
	.cfg-capped a {
		color: var(--c-teal-dark);
		margin-inline-start: 4px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.field-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--c-ink);
	}
	.field-req {
		color: var(--c-coral);
		font-weight: 600;
		cursor: help;
	}
	.field-type {
		font-size: 10.5px;
		color: var(--c-faint);
		font-family: var(--font-mono);
	}
	.field input[type='text'],
	.field input[type='number'],
	.field select {
		font-size: 12.5px;
		padding: 6px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-white);
		font-family: inherit;
	}
	.from-upstream {
		font-size: 11.5px;
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r-sm);
		padding: 5px 9px;
	}
	.onto {
		border: 1px solid var(--c-teal-light);
		background: var(--c-teal-pale);
		border-radius: var(--r-sm);
		padding: 8px 9px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.onto-unmapped {
		border-color: var(--c-border);
		background: var(--c-surface);
	}
	.onto-head {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--c-teal-dark);
	}
	.onto-unmapped .onto-head {
		color: var(--c-muted);
	}
	.onto-cov {
		font-size: 11.5px;
		color: var(--c-ink);
	}
	.onto-none {
		font-size: 11.5px;
		color: var(--c-muted);
		line-height: 1.4;
	}
	.onto-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.onto-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-teal-light);
		border-radius: 4px;
		padding: 2px 6px;
	}
	.onto-chip.pii {
		border-color: var(--c-coral);
	}
	.onto-arrow {
		color: var(--c-faint);
	}
	.onto-attr {
		color: var(--c-teal-dark);
		font-weight: 600;
	}
	.onto-pii {
		font-size: 8.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--c-coral);
		background: color-mix(in srgb, var(--c-coral) 12%, transparent);
		border-radius: 3px;
		padding: 0 3px;
	}
	.cfg-foot {
		padding: 12px 16px;
		border-top: 1px solid var(--c-border);
	}
	.loop-btn {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r-sm);
		padding: 6px 10px;
		align-self: flex-start;
	}
	.loop-btn:hover {
		background: var(--c-teal-light);
	}
	.del {
		font-size: 12px;
		color: var(--c-rose);
		font-weight: 500;
	}
	.del:hover {
		text-decoration: underline;
	}
	/* The stand-in for a coverage fraction we cannot compute. Muted and italic so it does not read
	   as a figure. */
	.onto-cov-unknown {
		font-style: italic;
		color: var(--c-faint);
	}
</style>
