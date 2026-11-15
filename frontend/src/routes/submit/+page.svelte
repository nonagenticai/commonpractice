<script lang="ts">
	// Submit a challenge (demo `submit`). Form + live preview. POSTs to /api/challenges
	// and redirects to the new challenge's detail page.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { challengesApi } from '$lib/api/challenges';
	import { datasetsApi } from '$lib/api/datasets';
	import type { DatasetRow } from '$lib/types/datasets';
	import DatasetPicker from '$lib/components/DatasetPicker.svelte';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import InformationPicker from '$lib/components/InformationPicker.svelte';
	import type { InformationCard, InformationOption } from '$lib/types/challenges';
	import * as m from '$lib/paraglide/messages';
	import { WORK_AREAS, workAreaLabel } from '$lib/i18n/work-area-label';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	// ⛔ THE SECOND COPY OF THE WORK-AREA VOCABULARY, DELETED. This file used to carry its own
	// `DOMAINS: { v, labelKey }[]` — the same eight values against the same eight `domain_*` keys
	// that `$lib/i18n/work-area-label.ts` already owns, resolved through a
	// `const mm = m as unknown as Record<string, () => string>` cast that also defeated paraglide's
	// tree-shake for the whole messages namespace. Two copies of one enum is how the values and the
	// words drift apart; the guard in work-area-label.test.ts scrapes `WORK_AREAS` out of the
	// backend source, and only the module it guards was ever covered by it. The `v`/`labelKey` pair
	// is still exactly what the markup needs — the VALUE keeps going on the wire (`work_area` is
	// validated with `z.enum(WORK_AREAS)`), the LABEL is only ever a text node.
	//
	// `mm` went with it: these were its only two call sites.
	// ⛔ NO `FREQ` / `frequency` HERE ANY MORE. "How often do you hit this?" was a bound `$state`
	// select, translated into all eight catalogs, that `submit()` never read — and could not have:
	// `createChallengeSchema` ends in `.strict()` (backend/src/routes/challenges.ts:65), so sending
	// the field would have been a 422, and there is no column behind it. A control that collects an
	// answer and drops it is worse than no control: it asks the reader to think, and then tells the
	// reviewer nothing. Deleted with its five message keys rather than wired up, because wiring it
	// up means a migration, a schema field and a render site nobody asked for.

	let title = $state('');
	let frustration = $state('');
	let impact = $state('');
	// ⛔ NO PRESELECTED WORK AREA. This was `'Claims'`, so every new challenge started as
	// "Schadeclaims" — the demo insurer's department, shown to a brand-new external org on its first
	// challenge (prod walk 2026-10-16) as if it were the obvious answer. The reader picks; Submit and
	// "Suggest" wait until they have. Pinned by submit-page.information.render.test.ts ("no preselected work area").
	let domain = $state('');
	let tags = $state<string[]>([]);
	let tagDraft = $state('');
	let acknowledged = $state(false);

	let submitting = $state(false);
	let error = $state<string | null>(null);

	// Phase 3.0: the test data this challenge is about. Multi-pick from the creator's own
	// datasets + an optional per-dataset note ("the amount column is what matters").
	let availableDatasets = $state<DatasetRow[]>([]);
	let dataSlugs = $state<string[]>([]);
	let dataNotes = $state<Record<string, string>>({});
	const pickedDatasets = $derived(availableDatasets.filter((d) => dataSlugs.includes(d.slug)));
	let dataPreviews = $state<Record<string, { columns: DatasetRow['columns']; rows: Record<string, unknown>[]; maskedColumns?: string[] }>>({});
	// A failed dataset LIST, kept out of `error` — which is the SUBMIT error, rendered next to the
	// submit button and cleared on every attempt. Same separation as `actionError` vs `error` on
	// /connectors: a message about a side panel must not sit where the reader looks for the verdict
	// on their form, and must not be wiped by an unrelated retry.
	let dataError = $state<string | null>(null);
	/** The server's real dataset total, and whether the walk had to stop short of it. */
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);

	onMount(async () => {
		try {
			// ⛔ WAS `datasetsApi.list({ page: 1 })` — ONE PAGE OF TWELVE, with `total` thrown away.
			// `GET /api/datasets` pages at twelve (backend/src/routes/datasets.ts's `PAGE_SIZE`), so a
			// workspace with thirteen datasets could not attach the thirteenth to a new challenge, and
			// the picker said nothing: it renders every row it is handed, so a short list is
			// indistinguishable from a complete one. `listAll` walks to the end and reports its own
			// ceiling — see `datasetsCapped` below for what happens when even that is not enough.
			const all = await datasetsApi.listAll();
			availableDatasets = all.items;
			datasetsTotal = all.total;
			datasetsCapped = all.capped;
		} catch (e) {
			// ⛔ NOT a bare `availableDatasets = []`. An empty list makes DatasetPicker render its
			// `emptyHint` — "Je hebt nog geen datasets." — so a 500 or a dropped connection was
			// reported to the reader as a FACT ABOUT THEIR ACCOUNT, and the action it implies (go
			// create one) is the wrong action. `errorText`, not `writeErrorText`: this is a READ, and
			// `writeErrorText` only prefers the backend's own sentence on the 400/422/409 a rejected
			// WRITE produces.
			dataError = errorText(e, m.challenge_data_load_failed());
		}
	});

	// W8/P2 "Information involved": the types of information this challenge is about, picked from the
	// workspace's information for the chosen work area. Sent as `entities` on submit; the backend
	// links them to the challenge only (never edits the information itself).
	let infoOptions = $state<InformationOption[]>([]);
	let infoIds = $state<string[]>([]);
	// Names of everything offered so far, so a choice made under one work area keeps its chip after
	// the reader switches to another.
	let infoKnown = $state<InformationCard[]>([]);
	let infoError = $state<string | null>(null);
	let infoGen = 0;
	async function loadInfoOptions(area: string) {
		const gen = ++infoGen;
		try {
			const r = await challengesApi.entityOptions(area);
			if (gen !== infoGen) return;
			infoOptions = r.items;
			const seen = new Set(infoKnown.map((k) => k.id));
			infoKnown = [...infoKnown, ...r.items.filter((o) => !seen.has(o.id))];
			infoError = null;
		} catch (e) {
			if (gen !== infoGen) return;
			infoOptions = [];
			// A READ, so `errorText`. Replaces the picker: an empty list would read as "none exist".
			infoError = errorText(e, m.challenge_info_options_failed());
		}
	}
	// W8/P3: AI suggestions from the title + description. Only those three fields go to the server
	// (and from there, to the AI) — never the picked sample data. The reader adds each one; nothing
	// is chosen for them. A failure is silent: no suggestions, and the picker still works.
	let suggestions = $state<InformationCard[]>([]);
	let suggesting = $state(false);
	let suggested = $state(false);
	const canSuggest = $derived(
		!suggesting && domain !== '' && (title.trim().length > 0 || frustration.trim().length > 0)
	);
	async function suggestInfo() {
		if (!canSuggest) return;
		suggesting = true;
		try {
			const r = await challengesApi.suggestEntities({
				title: title.trim(),
				description: frustration.trim(),
				work_area: domain
			});
			suggestions = r.items.filter((i) => !infoIds.includes(i.id));
			const seen = new Set(infoKnown.map((k) => k.id));
			infoKnown = [...infoKnown, ...r.items.filter((i) => !seen.has(i.id))];
		} catch {
			// Deliberately silent (owner decision W8/P3): the result is just "no suggestions".
			suggestions = [];
		} finally {
			suggesting = false;
			suggested = true;
		}
	}
	function acceptSuggestion(id: string) {
		if (!infoIds.includes(id)) infoIds = [...infoIds, id];
		suggestions = suggestions.filter((s) => s.id !== id);
	}

	// The options follow the work area. Tracks `domain` only; the writes happen after an await.
	// No work area yet = nothing to offer (and nothing to ask the server about).
	$effect(() => {
		if (domain) void loadInfoOptions(domain);
		else {
			infoGen++;
			infoOptions = [];
		}
	});

	// Per-slug preview failures. ⛔ NOT one shared string: each picked dataset is its own request and
	// its own box, and one 500 must not caption the dataset next to it.
	let previewErrors = $state<Record<string, string>>({});

	async function loadPreview(slug: string) {
		if (!slug || dataPreviews[slug]) return;
		try {
			const d = await datasetsApi.get(slug, { limit: 5 });
			dataPreviews = { ...dataPreviews, [slug]: { columns: d.columns, rows: d.rows, maskedColumns: d.maskedColumns } };
			const { [slug]: _gone, ...rest } = previewErrors;
			previewErrors = rest;
		} catch (e) {
			// ⛔ WAS `catch { /* no preview */ }`. The picked dataset kept its heading and its note box
			// and simply never grew a table — which is pixel-for-pixel what "still loading" looks like,
			// so the reader waits for something that is never coming and picks their test data blind.
			// Same rule as the `dataError` branch below: this is a READ, so `errorText`.
			previewErrors = { ...previewErrors, [slug]: errorText(e, m.dataset_preview_load_failed()) };
		}
	}
	function onPick(slugs: string[]) {
		dataSlugs = slugs;
		for (const s of slugs) void loadPreview(s);
	}

	const canSubmit = $derived(
		title.trim().length > 0 && frustration.trim().length > 0 && domain !== '' && acknowledged && !submitting
	);

	// The cap, named once. It is now also IN THE HINT (`submit_field_tags_hint` takes `{max}`) —
	// a limit the reader only discovers by hitting it is a limit that reads as a broken key.
	const TAG_MAX = 12;
	// Why the last Enter added nothing. Cleared by the next successful add and by editing the box.
	let tagError = $state<string | null>(null);

	function addTag(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const t = tagDraft.trim();
		// ⛔ `tagDraft = ''` USED TO BE UNCONDITIONAL, below a single `if` that silently dropped BOTH
		// rejections. Typing a tag you already have, or the thirteenth tag, emptied the box and added
		// no chip and said nothing — the reader's own text disappeared and the only available reading
		// was that the field is broken. A rejected tag now STAYS in the box (it is the reader's text,
		// and it is what they need in order to edit it) and the reason is on screen.
		if (!t) {
			// Enter on an empty / whitespace-only box: nothing was typed, so there is nothing to say
			// and nothing to keep.
			tagDraft = '';
			tagError = null;
			return;
		}
		if (tags.includes(t)) {
			tagError = m.submit_tag_duplicate({ tag: t });
			return;
		}
		if (tags.length >= TAG_MAX) {
			tagError = m.submit_tag_max({ max: num(TAG_MAX, locale.current) });
			return;
		}
		tags = [...tags, t];
		tagDraft = '';
		tagError = null;
	}
	function removeTag(t: string) {
		tags = tags.filter((x) => x !== t);
		// Removing a chip is exactly the action a "cap reached" message asks for, and it can also make
		// a "duplicate" true no longer — either way the standing complaint is out of date.
		tagError = null;
	}

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		error = null;
		try {
			const { id } = await challengesApi.create({
				title: title.trim(),
				description: frustration.trim(),
				business_impact: impact.trim() || undefined,
				work_area: domain,
				tags: tags.length ? tags : undefined,
				datasets: dataSlugs.length
					? dataSlugs.map((slug) => ({ slug, note: dataNotes[slug]?.trim() || undefined }))
					: undefined,
				entities: infoIds.length ? infoIds : undefined
			});
			await goto(`/challenges/${id}`);
		} catch (e) {
			error = writeErrorText(e, m.error_create_failed());
			submitting = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.submit_eyebrow()}</div>
		<h1>{m.submit_title()}</h1>
		<p>{m.submit_lede()}</p>
	</header>

	<div class="layout">
		<form class="card" onsubmit={(e) => { e.preventDefault(); submit(); }}>
			<div class="field">
				<label for="title">{m.submit_field_title_label()} <span class="req">*</span></label>
				<input id="title" bind:value={title} placeholder={m.submit_field_title_placeholder()} maxlength="140" />
				<div class="hint">{m.submit_field_title_hint()}</div>
			</div>

			<div class="field">
				<label for="frustration">{m.submit_field_frustration_label()} <span class="req">*</span></label>
				<textarea id="frustration" bind:value={frustration} rows="5" placeholder={m.submit_field_frustration_placeholder()}></textarea>
			</div>

			<div class="field">
				<label for="impact">{m.submit_field_impact_label()}</label>
				<textarea id="impact" bind:value={impact} rows="3" placeholder={m.submit_field_impact_placeholder()}></textarea>
			</div>

			<!-- Domain is on its own row now that the dead frequency select is gone. Left inside `.row`
			     (a 2-column grid) it would have kept its half-width column beside an empty cell. -->
			<div class="field">
				<label for="domain">{m.submit_field_domain_label()} <span class="req">*</span></label>
				<select id="domain" bind:value={domain} required>
					<option value="" disabled>{m.submit_field_domain_placeholder()}</option>
					{#each WORK_AREAS as d (d)}<option value={d}>{workAreaLabel(d)}</option>{/each}
				</select>
			</div>

			<div class="field">
				<label for="tags">{m.submit_field_tags_label()}</label>
				<div class="tag-input">
					{#each [...new Set(tags)] as t (t)}<span class="tag">{t}<button type="button" onclick={() => removeTag(t)} aria-label={m.submit_tag_remove()}>×</button></span>{/each}
					<input id="tags" bind:value={tagDraft} onkeydown={addTag} placeholder={m.submit_field_tags_placeholder()} oninput={() => (tagError = null)} />
				</div>
				<div class="hint">{m.submit_field_tags_hint({ max: num(TAG_MAX, locale.current) })}</div>
				{#if tagError}<div class="field-note" role="alert" data-testid="tag-error">{tagError}</div>{/if}
			</div>

			<div class="field" data-testid="submit-information">
				<span class="field-label">{m.challenge_info_title()}</span>
				<div class="hint">{m.challenge_info_help()}</div>
				{#if infoError}
					<div class="form-error">{infoError}</div>
				{:else}
					<InformationPicker options={infoOptions} selected={infoIds} known={infoKnown} onchange={(ids) => (infoIds = ids)} />
				{/if}
				<div class="suggest">
					<button type="button" class="suggest-btn" onclick={suggestInfo} disabled={!canSuggest} data-testid="info-suggest">
						{suggesting ? m.submit_info_suggesting() : m.submit_info_suggest()}
					</button>
					{#if suggestions.length}
						<span class="suggest-label">{m.submit_info_suggested()}</span>
						{#each suggestions as sg (sg.id)}
							<span class="suggestion" data-testid="info-suggestion">
								{sg.label}
								<button type="button" onclick={() => acceptSuggestion(sg.id)}>{m.submit_info_add()}</button>
							</span>
						{/each}
					{:else if suggested && !suggesting}
						<span class="suggest-label">{m.submit_info_no_suggestions()}</span>
					{/if}
				</div>
			</div>

			<div class="field">
				<span class="field-label">{m.challenge_data_title()}</span>
				<div class="hint">{m.challenge_data_help()}</div>
				{#if dataError}
					<!-- The notice REPLACES the picker rather than sitting above it. Rendered alongside, the
					     picker's own empty hint ("Je hebt nog geen datasets.") would still be on screen
					     contradicting it, which is the exact sentence this branch exists to stop showing. -->
					<div class="form-error">{dataError}</div>
				{:else}
					<DatasetPicker
						datasets={availableDatasets}
						selected={dataSlugs}
						multiple
						emptyHint={m.challenge_data_empty()}
						onchange={onPick}
					/>
					<!-- The walk hit its ceiling. Name the real total and point at the screen that can reach
					     the rest — a picker that is short and says nothing is the defect being fixed. Inside
					     the `{:else}` because the `dataError` arm above REPLACES the picker: a completeness
					     note about a list that is not on screen is noise. -->
					{#if datasetsCapped}
						<div class="ds-capped" role="status" data-testid="datasets-capped">
							{m.datasets_picker_capped({
								shown: num(availableDatasets.length, locale.current),
								total: num(datasetsTotal, locale.current)
							})}
							<a href="/datasets">{m.nav_datasets()}</a>
						</div>
					{/if}
				{/if}
				{#each pickedDatasets as ds (ds.slug)}
					<!-- `data-slug`: the block's identity for tests, now that the slug is not printed. -->
					<div class="ds-pick" data-slug={ds.slug}>
						<div class="ds-pick-head">{ds.name} <span class="ds-pick-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span></div>
						<input
							class="ds-note"
							value={dataNotes[ds.slug] ?? ''}
							placeholder={m.challenge_data_note_placeholder()}
							oninput={(e) => (dataNotes = { ...dataNotes, [ds.slug]: e.currentTarget.value })}
						/>
						{#if dataPreviews[ds.slug]}
							<!-- ⛔ `totalRows` — the five-row fetch made the truncation notice's `5 > 5` test
							     unreachable here too. `ds` comes from `pickedDatasets`, which is a filter over
							     `availableDatasets: DatasetRow[]`, so `rowCount` is structurally present (a
							     dataset can only be picked because it is in that list) and is the same number
							     the `.ds-pick-meta` line above already groups. -->
							<DatasetPreviewTable columns={dataPreviews[ds.slug].columns} rows={dataPreviews[ds.slug].rows} maxRows={5} totalRows={ds.rowCount} maskedColumns={dataPreviews[ds.slug].maskedColumns} />
						{:else if previewErrors[ds.slug]}
							<!-- The box that used to be empty. Without it this branch and "the request is still
							     in flight" are the same rendering, and the reader picks their test data blind. -->
							<p class="ds-preview-error" role="alert" data-testid={`preview-error-${ds.slug}`}>{previewErrors[ds.slug]}</p>
						{/if}
					</div>
				{/each}
			</div>

			<label class="ack">
				<input type="checkbox" bind:checked={acknowledged} />
				<span>{m.submit_ack()}</span>
			</label>

			{#if error}<div class="form-error">{error}</div>{/if}

			<div class="actions">
				<button class="btn-primary" type="submit" disabled={!canSubmit}>{submitting ? m.submit_btn_submitting() : m.submit_btn_submit()}</button>
			</div>
		</form>

		<aside class="preview">
			<div class="preview-label">{m.submit_preview_label()}</div>
			<div class="card preview-card">
				<span class="badge teal">{m.submit_preview_badge()}</span>
				<div class="pv-title">{title.trim() || m.submit_preview_title_placeholder()}</div>
				<!-- No `?? 'domain_claims'` fallback any more: `workAreaLabel` returns the raw value for
				     anything off-list, so an unrecognised `domain` shows ITSELF rather than silently
				     previewing the challenge as "Schadeclaims". -->
				<div class="pv-meta">{m.submit_preview_meta({ domain: domain ? workAreaLabel(domain) : '—' })}</div>
				<p class="pv-desc">{frustration.trim() || m.submit_preview_desc_placeholder()}</p>
				<div class="pv-foot">
					<div class="pv-tags">{#each [...new Set(tags)] as t (t)}<span class="tag sm">{t}</span>{/each}</div>
					<span class="pv-votes">0 ▲</span>
				</div>
			</div>
			<div class="notice teal">
				<b>{m.submit_next_title()}</b>
				<p>{m.submit_next_body()}</p>
			</div>
		</aside>
	</div>
</div>

<style>
	.suggest {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
	}
	.suggest-btn {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r);
		padding: 4px 10px;
		cursor: pointer;
	}
	.suggest-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.suggest-label {
		font-size: 12px;
		color: var(--c-muted);
	}
	.suggestion {
		font-size: 12px;
		padding: 2px 4px 2px 10px;
		border-radius: 999px;
		border: 1px dashed var(--c-teal);
		color: var(--c-teal-dark);
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.suggestion button {
		font-size: 11.5px;
		font-weight: 600;
		background: none;
		border: none;
		color: var(--c-teal-dark);
		cursor: pointer;
	}
	.page {
		max-width: 1080px;
	}
	.page-head {
		margin-bottom: 22px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal-dark);
		margin-bottom: 8px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		margin: 0 0 6px;
		color: var(--c-midnight);
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
		max-width: 620px;
	}
	.layout {
		display: grid;
		grid-template-columns: 1fr 340px;
		gap: 22px;
		align-items: start;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 20px 22px;
	}
	.field {
		margin-bottom: 16px;
		display: flex;
		flex-direction: column;
	}
	label,
	.field-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		margin-bottom: 6px;
	}
	.req {
		color: var(--c-coral);
	}
	input,
	textarea,
	select {
		font-family: var(--font-sans);
		font-size: 13.5px;
		color: var(--c-ink);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 9px 12px;
		width: 100%;
		box-sizing: border-box;
		background: var(--c-white);
	}
	textarea {
		resize: vertical;
	}
	.hint {
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 5px;
	}
	/* `.row` (the 2-column grid) went with the frequency select — domain was its only other
	   occupant. Svelte prunes unused selectors with a warning, so it is deleted rather than left. */
	.tag-input {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 6px 8px;
	}
	.tag-input input {
		border: none;
		padding: 4px;
		flex: 1;
		min-width: 140px;
	}
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--c-teal-pale);
		color: var(--c-teal-dark);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r-sm);
		padding: 2px 4px 2px 8px;
	}
	.tag.sm {
		padding: 2px 7px;
	}
	.tag button {
		background: none;
		border: none;
		color: var(--c-teal-dark);
		cursor: pointer;
		font-size: 13px;
		line-height: 1;
		padding: 0;
	}
	.ds-pick {
		margin-top: 10px;
		padding: 10px 12px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ds-pick-head {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.ds-pick-meta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-faint);
		font-weight: 400;
		margin-inline-start: 6px;
	}
	.ds-note {
		font-size: 12.5px;
	}
	.ds-preview-error {
		font-size: 12px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
		padding: 6px 9px;
		margin: 0;
		line-height: 1.5;
	}
	.field-note {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		margin-top: 5px;
	}
	/* The "the picker does not list all of them" disclosure. ⛔ NOT `.field-note`, which is coral: this
	   is not a rejection and nothing has failed — the picker is telling the reader the truth about its
	   own completeness, so it takes the muted `.hint` tone instead. */
	.ds-capped {
		font-size: 11.5px;
		color: var(--c-muted);
		margin-top: 6px;
		line-height: 1.5;
	}
	.ds-capped a {
		color: var(--c-teal-dark);
		margin-inline-start: 4px;
	}
	.ack {
		display: flex;
		gap: 9px;
		align-items: flex-start;
		font-size: 12.5px;
		font-weight: 400;
		color: var(--c-muted);
		line-height: 1.5;
		margin: 6px 0 16px;
	}
	.ack input {
		width: auto;
		margin-top: 2px;
	}
	.form-error {
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		color: var(--c-coral-dark);
		font-size: 12.5px;
		padding: 10px 12px;
		border-radius: var(--r);
		margin-bottom: 14px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 10px 18px;
		border-radius: var(--r);
		border: none;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.preview {
		display: flex;
		flex-direction: column;
		gap: 14px;
		position: sticky;
		top: 20px;
	}
	.preview-label {
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
	}
	.badge.teal {
		display: inline-block;
		font-size: 10.5px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 999px;
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
		margin-bottom: 10px;
	}
	.pv-title {
		font-family: var(--font-display);
		font-size: 18px;
		color: var(--c-midnight);
	}
	.pv-meta {
		font-size: 12px;
		color: var(--c-muted);
		margin: 4px 0 10px;
	}
	.pv-desc {
		font-size: 13px;
		color: var(--c-ink);
		line-height: 1.55;
		margin: 0 0 12px;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.pv-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.pv-tags {
		display: flex;
		gap: 5px;
		flex-wrap: wrap;
	}
	.pv-votes {
		font-size: 12.5px;
		color: var(--c-muted);
		font-weight: 600;
	}
	.notice.teal {
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r-lg);
		padding: 14px 16px;
	}
	.notice.teal b {
		font-size: 13px;
		color: var(--c-teal-dark);
	}
	.notice.teal p {
		font-size: 12.5px;
		color: var(--c-ink);
		line-height: 1.55;
		margin: 6px 0 0;
	}
	@media (max-width: 820px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.preview {
			position: static;
		}
	}
</style>
