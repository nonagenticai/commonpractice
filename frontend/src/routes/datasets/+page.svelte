<script lang="ts">
	// Platform "Datasets" — load developer test data (CSV/Excel/text/JSON), see it
	// typed + previewed, edit column types + toggle PII, and use it in a flow (the
	// node-config dataset picker reads the same list). Phase 2.0. RTL-safe (logical
	// CSS); strings localized (paraglide). Owner-scoped via the backend.
	import { onMount, untrack } from 'svelte';
	import { datasetsApi, ApiError } from '$lib/api/datasets';
	import { informationRequestsApi } from '$lib/api/information-requests';
	import { datasetPrefill, fromRequestParam } from '$lib/requests/prefill';
	import type {
		DatasetColumn,
		DatasetColumnType,
		DatasetDetail,
		DatasetList,
		DatasetRow
	} from '$lib/types/datasets';
	import { DATASET_COLUMN_TYPES } from '$lib/types/datasets';
	import type { ColumnRename } from '$lib/types/datasets';
	import FileUpload from '$lib/components/FileUpload.svelte';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import Toggle from '$lib/components/ops/Toggle.svelte';
	import { timeAgo, num, bytes, pct } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { flowArrow } from '$lib/i18n/direction';
	import { industryLabel, departmentLabel } from '$lib/i18n/ontology-axis-label';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { datasetSourceLabel, datasetColumnTypeLabel } from '$lib/i18n/dataset-label';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import { ontologyApi } from '$lib/api/ontology';
	import type { CompiledOntology, MatrixData } from '$lib/types/ontology';
	import type { DatasetMapping } from '$lib/types/datasets';

	let list = $state<DatasetList | null>(null);
	let loading = $state(true);
	// Phase 3.6: test data is the org's shared resource — only IT/admins (tenant_admin or
	// platform) may add/edit/delete it; every member browses. Gates the write affordances
	// (the server enforces it too). Defaults to false until the first list loads.
	const canManage = $derived(list?.canManage ?? false);
	let error = $state<string | null>(null);
	// A failed ACTION (inspect/save-schema/delete), kept separate from `error` (the LOAD error).
	// `error` renders inside the `{#if loading}…{:else if error}` chain below, which is mutually
	// exclusive with the dataset table — so writing a button failure there replaced the whole page
	// the message was supposed to explain. This one renders ABOVE the outer `{#if denied}` and
	// leaves the table in place. `createError`/`mapError` stay as they are — they are drawer- and
	// panel-scoped and already render next to their own controls. Same pattern as #210's `voteError`.
	let actionError = $state<string | null>(null);
	let denied = $state(false);

	let q = $state('');
	let page = $state(1);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// Create drawer.
	let creating = $state(false);
	let createMode = $state<'upload' | 'paste'>('upload');
	let createBusy = $state(false);
	let createError = $state<string | null>(null);
	let pasteName = $state('');
	let pasteType = $state<'csv' | 'json' | 'text' | 'sql'>('csv');
	let pasteContent = $state('');
	// Set by the upload/paste response when the ingest had to disambiguate a repeated header, and
	// shown in the preview drawer that opens straight afterwards. NEVER SILENT (SPEC §2.7's rule for
	// `truncated`, applied to the same class of event): the reader uploaded a sheet with two `Amount`
	// headers and has to be told which one is now `Amount_1`, or the schema they are looking at is
	// not the schema they think they uploaded.
	//
	// ⚠️ CARRIES THE SLUG IT DESCRIBES rather than being cleared by hand. `afterCreate` sets it and
	// then opens the drawer, and the drawer is ALSO opened by clicking any row in the table — so a
	// "clear it on close" rule leaves a stale notice sitting over the next dataset the reader
	// inspects if they never close it. Rendering on `renamedFor === selected.slug` makes the notice
	// structurally incapable of appearing over the wrong dataset; no clearing logic to forget.
	let renamedColumns = $state<ColumnRename[]>([]);
	let renamedFor = $state<string | null>(null);

	// Preview drawer.
	let selected = $state<DatasetDetail | null>(null);
	let drawerLoading = $state(false);
	let editCols = $state<DatasetColumn[]>([]);
	// Data managers only: columns the backend SUGGESTS as not personal. A hint — nothing changes for
	// members until a column is marked (`nonPersonal`, saved through the same PATCH as the schema).
	const suggested = $derived(new Set(selected?.suggestedNonPersonal ?? []));
	const pendingSuggestions = $derived(
		editCols.filter((c) => suggested.has(c.name) && !c.pii && !c.nonPersonal).map((c) => c.name)
	);
	let saveBusy = $state(false);
	let dirty = $state(false);

	// ---- Phase 3.3: ontology mapping (inside the preview drawer) ----
	// READ for every member, EDIT for a data manager only (since 2026-10-15). A confirmed mapping to
	// a non-PII attribute is what UNMASKS that column for members (backend datasets/member-view.ts),
	// so `PUT`/`DELETE /api/datasets/:slug/mappings` now go through `requireDataManager` and answer a
	// member 403. The editor (cell picker, suggest, picks, Save, Remove) is therefore rendered only
	// under the server-supplied `canManage` flag, which mirrors `requireDataManager`. The saved
	// mappings stay visible to everyone: the challenge detail, ChallengeDataPanel and NodeConfigPanel
	// read them too. ⛔ Do not gate this on `auth.isSuperAdmin` — that made the mapping unreachable
	// for every real tenant's data managers.
	type WorkingPick = {
		entityId: string;
		entityName: string;
		attribute: string;
		confidence: number;
		origin: 'heuristic' | 'llm' | 'human';
	};
	let matrix = $state<MatrixData | null>(null);
	let mapIndustry = $state<string | null>(null);
	let mapDepartment = $state<string | null>(null);
	let mapCell = $state<CompiledOntology | null>(null);
	let savedMappings = $state<DatasetMapping[]>([]);
	let mapThreshold = $state(0.7);
	let mapBusy = $state(false);
	let mapError = $state<string | null>(null);
	let useAi = $state(false);
	// column name → the picked entity attribute (the editable proposal set).
	let working = $state<Record<string, WorkingPick>>({});

	// ⛔ `e.label` IN THE TEXT, `e.id`/`a.name` IN THE VALUE — the split ontology-axis-label.ts states
	// as the rule for every `<select>` on the ontology vocabulary: "an `<option>`'s TEXT is what a
	// human reads, its `value` is what gets submitted and matched." `e.name` is the canonical English
	// concept noun off `ontology_entities.name`; `e.label` is the same row's reader-facing label,
	// resolved server-side per `Accept-Language` (ontology-service.ts `localizeEntityLabels`) and
	// already on this payload. /ontology renders `e.label` in the identical construction
	// (`<option value={e.id}>{e.label}</option>`, ontology/+page.svelte:1109), so a Dutch reader met
	// "Tussenpersoon-notitie" on one screen and "Broker Note" in this picker for the same row.
	//
	// ⚠️ `entityName` BELOW STAYS `e.name` AND MUST. It is not rendered anywhere — it rides in
	// `WorkingPick` into `saveMappings`, i.e. it is wire, and the same value/label hazard applies.
	// `a.name` likewise stays raw: it is the attribute key `columnMap` is written with, and
	// `OntologyAttribute` carries no label to localize it to.
	const attrOptions = $derived(
		(mapCell?.entities ?? []).flatMap((e) =>
			e.attributes.map((a) => ({
				value: `${e.id}::${a.name}`,
				label: `${e.label}.${a.name}`,
				entityId: e.id,
				entityName: e.name,
				attribute: a.name
			}))
		)
	);

	const totalPages = $derived(list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1);

	async function loadMappingState(slug: string) {
		mapError = null;
		mapCell = null;
		working = {};
		mapIndustry = null;
		mapDepartment = null;
		try {
			if (!matrix) matrix = await ontologyApi.matrix();
			savedMappings = (await datasetsApi.listMappings(slug)).mappings;
			// Default to the cell of an existing saved mapping, if any.
			const first = savedMappings[0];
			if (first) {
				mapIndustry = first.industry;
				mapDepartment = first.department;
				await loadCell();
			}
		} catch (e) {
			// The mapping section is best-effort; surface the failure inline rather than
			// blowing up the whole preview drawer.
			mapError = errorText(e, m.error_load_failed());
			savedMappings = [];
		}
	}

	async function loadCell() {
		if (!mapIndustry || !mapDepartment) return;
		mapBusy = true;
		mapError = null;
		try {
			mapCell = await ontologyApi.get(mapIndustry, mapDepartment);
			// Pre-fill the working set from saved mappings for this cell.
			const fromSaved: Record<string, WorkingPick> = {};
			for (const mp of savedMappings) {
				if (mp.industry !== mapIndustry || mp.department !== mapDepartment) continue;
				for (const [col, attr] of Object.entries(mp.columnMap)) {
					fromSaved[col] = {
						entityId: mp.entityId,
						entityName: mp.entityName,
						attribute: attr,
						confidence: mp.confidence,
						origin: 'human'
					};
				}
			}
			working = fromSaved;
		} catch (e) {
			mapError = errorText(e, m.error_load_failed());
		} finally {
			mapBusy = false;
		}
	}

	async function pickIndustry(ind: string) {
		mapIndustry = ind;
		mapCell = null;
		await loadCell();
	}
	async function pickDepartment(dept: string) {
		mapDepartment = dept;
		mapCell = null;
		await loadCell();
	}

	async function runSuggest() {
		if (!selected || !mapIndustry || !mapDepartment) return;
		mapBusy = true;
		mapError = null;
		try {
			const res = await datasetsApi.suggestMappings(selected.slug, {
				industry: mapIndustry,
				department: mapDepartment,
				useLlm: useAi
			});
			mapThreshold = res.threshold;
			const next: Record<string, WorkingPick> = { ...working };
			for (const s of res.suggestions) {
				for (const c of s.columns) {
					next[c.column] = {
						entityId: s.entityId,
						entityName: s.entityName,
						attribute: c.attribute,
						confidence: c.confidence,
						origin: c.origin
					};
				}
			}
			working = next;
		} catch (e) {
			mapError = errorText(e, m.error_action_failed());
		} finally {
			mapBusy = false;
		}
	}

	function setColMapping(column: string, value: string) {
		if (!value) {
			const next = { ...working };
			delete next[column];
			working = next;
			return;
		}
		const opt = attrOptions.find((o) => o.value === value);
		if (!opt) return;
		working = {
			...working,
			[column]: { entityId: opt.entityId, entityName: opt.entityName, attribute: opt.attribute, confidence: 1, origin: 'human' }
		};
	}

	async function saveMappings() {
		if (!selected || !mapIndustry || !mapDepartment) return;
		mapBusy = true;
		mapError = null;
		try {
			// Group the working picks by entity → one mapping per (dataset, entity).
			const byEntity = new Map<string, { columnMap: Record<string, string>; conf: number[] }>();
			for (const [col, pick] of Object.entries(working)) {
				const g = byEntity.get(pick.entityId) ?? { columnMap: {}, conf: [] };
				g.columnMap[col] = pick.attribute;
				g.conf.push(pick.confidence);
				byEntity.set(pick.entityId, g);
			}
			const mappings = [...byEntity.entries()].map(([entityId, g]) => ({
				entityId,
				industry: mapIndustry!,
				department: mapDepartment!,
				columnMap: g.columnMap,
				confidence: g.conf.reduce((s, c) => s + c, 0) / g.conf.length
			}));
			savedMappings = (await datasetsApi.saveMappings(selected.slug, mappings)).mappings;
		} catch (e) {
			mapError = writeErrorText(e, m.error_save_failed());
		} finally {
			mapBusy = false;
		}
	}

	async function removeMapping(entityId: string) {
		if (!selected) return;
		try {
			await datasetsApi.deleteMapping(selected.slug, entityId);
			savedMappings = (await datasetsApi.listMappings(selected.slug)).mappings;
		} catch (e) {
			mapError = writeErrorText(e, m.error_delete_failed());
		}
	}

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			list = await datasetsApi.list({ q: q.trim() || undefined, page });
			// A page past the end (rows deleted under the reader, or a `page` carried across a
			// reload) returns zero items with a non-zero total — and because `.pager` sits INSIDE
			// the table arm, after both empty-state arms, the reader is left being told the account
			// is empty with no control to page back with. Only a search or a full reload escapes.
			// Clamp once and re-ask; `page` is 1 on the retry, so this cannot recurse further.
			// Ported verbatim in shape from /solutions, which hit this first and documented it.
			if (list.items.length === 0 && page > 1) {
				page = 1;
				await load();
				return;
			}
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			load();
		}, 250);
	}
	function goPage(p: number) {
		page = Math.min(Math.max(1, p), totalPages);
		load();
	}

	function openCreate() {
		creating = true;
		createMode = 'upload';
		createError = null;
		pasteName = '';
		pasteType = 'csv';
		pasteContent = '';
	}
	function closeCreate() {
		creating = false;
	}

	async function afterCreate(slug: string, renamed?: ColumnRename[]) {
		// ⚠️ `?? []` IS LOAD-BEARING, not defensive noise. `renamedColumns` is absent from an OLD
		// backend's response for the length of a rolling deploy, and an `undefined` reaching the
		// `{#if renamedColumns.length}` below would throw inside the drawer.
		renamedColumns = renamed ?? [];
		renamedFor = renamedColumns.length ? slug : null;
		creating = false;
		page = 1;
		await load();
		await inspect(slug);
	}

	async function onFile(file: File) {
		if (createBusy) return;
		createBusy = true;
		createError = null;
		try {
			const ds = await datasetsApi.uploadFile(file);
			await afterCreate(ds.slug, ds.renamedColumns);
		} catch (e) {
			createError = writeErrorText(e, m.error_upload_failed());
		} finally {
			createBusy = false;
		}
	}
	async function submitPaste() {
		if (!pasteName.trim() || !pasteContent.trim()) return;
		createBusy = true;
		createError = null;
		try {
			const ds = await datasetsApi.paste({
				name: pasteName.trim(),
				sourceType: pasteType,
				content: pasteContent
			});
			await afterCreate(ds.slug, ds.renamedColumns);
		} catch (e) {
			createError = writeErrorText(e, m.error_create_failed());
		} finally {
			createBusy = false;
		}
	}

	/**
	 * Open (or refresh) the preview drawer for one dataset.
	 *
	 * ⛔ `keepMappingState` EXISTS BECAUSE "Schema opslaan" USED TO DESTROY UNSAVED WORK, SILENTLY.
	 * `saveSchema` refreshed the drawer with a plain `inspect(slug)`, and `loadMappingState` resets
	 * `mapCell`, `working`, `mapIndustry` and `mapDepartment` unconditionally. So a reader who ran
	 * "Voorstel doen", corrected a dozen picks by hand, then flipped one PII toggle and pressed Save
	 * — the exact order the drawer's own layout invites, the schema block sits ABOVE the mapping
	 * block — lost every one of those picks, with no prompt, no warning, and a green save banner.
	 * `working` is not persisted anywhere until `saveMappings` is pressed.
	 *
	 * ⛔ PRESERVING IS PROVABLY SAFE HERE, NOT A JUDGEMENT CALL — which is why this is not a
	 * confirm-before-discarding dialog. `working` is keyed by COLUMN NAME
	 * (`working[col.name]`, `setColMapping(col.name, …)`, and the same keys go over the wire to
	 * `suggestMappings`/`saveMappings`). And `PATCH /api/datasets/:slug` REFUSES a column-set change:
	 * `backend/src/routes/datasets.ts` compares the submitted names against the stored ones as SETS
	 * and throws `columns_mismatch` unless they are identical (and `duplicate_column` on a repeat).
	 * A save that returns 200 therefore cannot have added, removed or renamed a key — only retyped a
	 * column or flipped its PII flag, neither of which `WorkingPick` records. There is no state in
	 * the mapping panel that a successful schema save can invalidate, so discarding it buys nothing
	 * and costs the reader everything they had done.
	 *
	 * ⚠️ AND NOTHING ELSE IN THE PANEL GOES STALE EITHER. `savedMappings` comes from
	 * `dataset_mappings`, a different table that this PATCH does not write (it sets only `name`,
	 * `sandbox_id` and `columns`), so skipping the re-fetch is not trading one silent staleness for
	 * another. The FIRST open still loads it: the flag is passed only by `saveSchema`.
	 */
	async function inspect(slug: string, opts: { keepMappingState?: boolean } = {}) {
		actionError = null;
		drawerLoading = true;
		selected = null;
		dirty = false;
		try {
			selected = await datasetsApi.get(slug, { limit: 50 });
			editCols = selected.columns.map((c) => ({ ...c }));
			if (!opts.keepMappingState) void loadMappingState(slug);
		} catch (e) {
			actionError = errorText(e, m.error_load_failed());
		} finally {
			drawerLoading = false;
		}
	}
	function closeDrawer() {
		selected = null;
	}

	function setType(i: number, t: DatasetColumnType) {
		editCols[i] = { ...editCols[i]!, type: t };
		dirty = true;
	}
	function togglePii(i: number, v: boolean) {
		editCols[i] = { ...editCols[i]!, pii: v };
		dirty = true;
	}
	function toggleNonPersonal(i: number, v: boolean) {
		if (!canManage) return;
		editCols[i] = { ...editCols[i]!, nonPersonal: v };
		dirty = true;
	}
	/** One action: mark every suggested column not personal and save, through the same PATCH. */
	async function markSuggested() {
		if (!canManage || !pendingSuggestions.length) return;
		const pending = new Set(pendingSuggestions);
		editCols = editCols.map((c) => (pending.has(c.name) ? { ...c, nonPersonal: true } : c));
		dirty = true;
		await saveSchema();
	}

	async function saveSchema() {
		if (!selected) return;
		actionError = null;
		saveBusy = true;
		try {
			await datasetsApi.update(selected.slug, { columns: editCols });
			dirty = false;
			// ⛔ `keepMappingState`. The refresh is here for the COLUMNS the server just accepted;
			// re-running the mapping loader on the way past threw away every unsaved pick in the panel
			// below. See the long note on `inspect` for why keeping them is safe rather than hopeful.
			await Promise.all([inspect(selected.slug, { keepMappingState: true }), load()]);
		} catch (e) {
			actionError = writeErrorText(e, m.error_save_failed());
		} finally {
			saveBusy = false;
		}
	}
	async function remove(d: DatasetRow) {
		if (!(await confirmDialog({ message: m.datasets_confirm_delete() }))) return;
		actionError = null;
		try {
			await datasetsApi.remove(d.slug);
			if (selected?.slug === d.slug) selected = null;
			await load();
		} catch (e) {
			actionError = writeErrorText(e, m.error_delete_failed());
		}
	}

	// W8/P5: `?fromRequest=<id>` — an approver arrives here from /requests after approving uploaded
	// example records. Open the EXISTING create drawer on its paste tab, prefilled with the stored
	// records; creating the dataset goes through the same gated POST /api/datasets as always.
	let fromRequestNote = $state(false);
	async function prefillFromRequest() {
		const id = fromRequestParam();
		if (!id || !canManage) return;
		try {
			const pre = datasetPrefill(await informationRequestsApi.records(id));
			openCreate();
			createMode = 'paste';
			pasteName = pre.name;
			pasteType = 'json';
			pasteContent = pre.content;
			fromRequestNote = true;
		} catch {
			// The list itself is fine; the request is gone or not readable — the drawer stays closed.
		}
	}
	onMount(async () => {
		await load();
		await prefillFromRequest();
	});

	/**
	 * Re-resolve the mapping panel's SERVER-LOCALIZED prose after a language switch.
	 *
	 * ⛔ NOT `reloadOnLocaleChange(load)`, WHICH IS WHAT EVERY OTHER SCREEN ON THIS HELPER DOES.
	 * `load()` fetches `GET /api/datasets`, and that route calls no `negotiateLocale` at all
	 * (backend/src/routes/datasets.ts:320) — every field the roster renders is either the reader's
	 * own data (`d.name`, `d.slug`, `col.name`) or already relocalizes itself in the browser
	 * (`datasetSourceLabel`, `datasetColumnTypeLabel`, `industryLabel`, `departmentLabel`,
	 * `timeAgo`, every `m.*()`), all of which track the locale rune and re-render with no request.
	 * Re-running `load` here would be a round-trip that changes not one pixel.
	 *
	 * The two things on this screen that DO come down pre-localized are `mappings[].entityLabel`
	 * (datasets.ts:511, via `listMappings` → `localizeEntityLabels`) and the compiled cell's
	 * `entities[].label` (ontology.ts:125). Both are fetched once, when the drawer opens, so before
	 * this they stayed in the language the drawer was opened in.
	 *
	 * ⛔ AND NOT `loadMappingState(slug)`, WHICH WOULD BE A DATA-LOSS BUG. That function resets
	 * `working = {}`, `mapIndustry = null` and `mapDepartment = null` — a reader half-way through
	 * assigning columns who reaches for the language switcher would silently lose every unsaved
	 * pick, with no undo and no autosave on this screen. Same hazard, same shape, as the one
	 * block-edit.locale-refetch.render.test.ts pins for the docs editor. Only the display data is
	 * re-read; `working` and the picked cell are left exactly as the reader left them.
	 */
	async function relocalizeMappingPanel() {
		const slug = selected?.slug;
		if (!slug) return;
		try {
			savedMappings = (await datasetsApi.listMappings(slug)).mappings;
			if (mapIndustry && mapDepartment) mapCell = await ontologyApi.get(mapIndustry, mapDepartment);
		} catch (e) {
			mapError = errorText(e, m.error_load_failed());
		}
	}
	// ⛔ `untrack` IS LOAD-BEARING, AND THE COST IS MEASURED, NOT ASSERTED. `reloadOnLocaleChange`
	// runs its callback inside a `$effect` and Svelte re-collects dependencies on every run; the
	// first run returns early, so the SECOND is where a bare call would read `selected?.slug` inside
	// the tracking window and make this effect a permanent second subscriber to `selected`. From then
	// on every drawer open fires both `loadMappingState` and this: measured at 4 `listMappings`
	// requests where there should be 3, pinned by "the locale effect must not subscribe to
	// `selected`" in datasets-page.locale-refetch.render.test.ts.
	//
	// ⚠️ NARROWED — an earlier version of this comment also named `mapIndustry`/`mapDepartment`, and
	// that was wrong. Both are read AFTER the first `await`, i.e. in a later microtask and outside
	// the synchronous tracking window, so neither was ever subscribable. Same mechanism that makes a
	// plain `$effect` blind to the locale rune in the first place.
	//
	// ⚠️ KNOWN AND DELIBERATELY NOT FIXED HERE: this is unsequenced against an in-flight
	// `saveMappings()`. A locale switch that overlaps a save can let the older `listMappings`
	// response land last, leaving `savedMappings` one revision stale until the drawer is reopened.
	// Checked: it does NOT touch `working` and does NOT lose the write — the save's own PUT has
	// already been sent and the server is the record. Display-only staleness, so no generation token
	// or busy flag in this change; it is recorded rather than left for the next reader to rediscover.
	reloadOnLocaleChange(() => void untrack(relocalizeMappingPanel));
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.datasets_eyebrow()}</div>
			<h1>{m.datasets_title()}</h1>
			<p>{m.datasets_subtitle()}</p>
		</div>
		<div class="head-actions">
			{#if canManage}
				<button class="btn-primary" onclick={openCreate}>{m.datasets_new()}</button>
			{:else if list}
				<span class="managed-note">{m.datasets_managed_by_it()}</span>
			{/if}
		</div>
	</header>

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	{#if denied}
		<div class="notice error">{m.datasets_denied()}</div>
	{:else}
		<div class="filter-bar">
			<input class="search" placeholder={m.datasets_search_placeholder()} bind:value={q} oninput={onSearch} />
		</div>

		{#if loading && !list}
			<div class="notice">{m.datasets_loading()}</div>
		{:else if error}
			<div class="notice error">{error}</div>
		{:else if list && list.items.length === 0 && q.trim()}
			<!-- A no-match SEARCH is not an empty account. `q` is sent to the server (`load()` passes
			     it to `datasetsApi.list`), so `items.length === 0` conflates "you have no datasets"
			     with "no dataset matched what you typed" — and the single empty state below answered a
			     typo with "Nog geen datasets. Upload een CSV-/Excel-bestand…" plus a "Nieuwe dataset"
			     button, for an account holding dozens. Same defect, same shape of fix, as
			     `solutions_no_match` / `challenges_no_match` / `blocks_no_match` / `connectors_no_match`.
			     ⛔ NO CTA ON THIS ARM: offering "New dataset" to someone whose search missed pushes
			     them toward re-uploading a file they already have. -->
			<div class="notice">{m.datasets_no_match()}</div>
		{:else if list && list.items.length === 0}
			<div class="notice empty-cta">
				<span>{m.datasets_empty()}</span>
				{#if canManage}
					<button class="btn-primary" onclick={openCreate}>{m.datasets_new()}</button>
				{/if}
			</div>
		{:else if list}
			<div class="table-wrap" class:dim={loading}>
				<table>
					<thead>
						<tr>
							<th>{m.datasets_col_name()}</th>
							<th>{m.datasets_col_source()}</th>
							<th class="num">{m.datasets_col_columns()}</th>
							<th class="num">{m.datasets_col_rows()}</th>
							<th class="num">{m.datasets_col_size()}</th>
							<th>{m.datasets_col_updated()}</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each list.items as d (d.id)}
							<tr>
								<td>
									<div class="ds-name">{d.name}</div>
									<!-- The slug is an identifier a developer types into a block; a member reads the
									     name (round 2: no slugs or attribute keys on a member's Library screens). -->
									{#if canManage}<div class="ds-slug">{d.slug}</div>{/if}
								</td>
								<td>
									<!-- The ENUM stays on the wire and in `d.sourceType`; only the badge's TEXT is the
									     reader's. It sits beside `m.connector_test_source()`, which was already
									     localized — see $lib/i18n/dataset-label.ts. -->
									<span class="badge teal">{datasetSourceLabel(d.sourceType)}</span>
									{#if (['postgres', 'storage', 'http'] as string[]).includes(d.sourceType)}
										<span class="badge test-source" title={m.connector_governance_note()}>{m.connector_test_source()}</span>
									{/if}
								</td>
								<td class="num">{num(d.columns.length, locale.current)}</td>
								<td class="num">{num(d.rowCount, locale.current)}</td>
								<td class="num muted">{bytes(d.sizeBytes, locale.current)}</td>
								<td class="muted">{timeAgo(d.updatedAt)}</td>
								<td class="num row-actions">
									<button class="btn-sm" onclick={() => inspect(d.slug)}>{m.datasets_preview()}</button>
									{#if canManage}
										<button class="btn-sm danger" onclick={() => remove(d)}>{m.datasets_delete()}</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="pager">
				<span class="pager-info">{m.datasets_pager_showing({ shown: num(list.items.length, locale.current), total: num(list.total, locale.current) })}</span>
				<div class="pager-btns">
					<button class="btn-sm" disabled={page <= 1} onclick={() => goPage(page - 1)}>{m.datasets_pager_prev()}</button>
					<span class="pager-page">{m.datasets_pager_page({ page, totalPages })}</span>
					<button class="btn-sm" disabled={page >= totalPages} onclick={() => goPage(page + 1)}>{m.datasets_pager_next()}</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Create drawer -->
{#if creating}
	<div class="scrim" role="button" tabindex="0" aria-label={m.datasets_close()} onclick={closeCreate} onkeydown={(e) => e.key === 'Escape' && closeCreate()}></div>
	<aside class="drawer">
		<header class="drawer-head">
			<div class="drawer-name">{m.datasets_create_title()}</div>
			<button class="icon-x" onclick={closeCreate} aria-label={m.datasets_close()}>✕</button>
		</header>
		<div class="chips">
			<button class="chip" class:active={createMode === 'upload'} onclick={() => (createMode = 'upload')}>{m.datasets_mode_upload()}</button>
			<button class="chip" class:active={createMode === 'paste'} onclick={() => (createMode = 'paste')}>{m.datasets_mode_paste()}</button>
		</div>

		{#if fromRequestNote}<p class="drawer-pad from-request" data-testid="from-request">{m.requests_prefilled()}</p>{/if}
		{#if createMode === 'upload'}
			<div class="create-body">
				<FileUpload
					disabled={createBusy}
					onfile={onFile}
					onreject={(message) => {
						// The refused file never reaches the API, so the refusal has to land in the SAME notice
						// the reader already watches for an upload failure — otherwise a dropped PDF looks like
						// nothing happened at all, which is the silence this whole change is about.
						createBusy = false;
						createError = message;
					}}
				/>
			</div>
		{:else}
			<div class="create-body">
				<label class="field">
					<span class="field-label">{m.datasets_name_label()}</span>
					<input type="text" bind:value={pasteName} placeholder="my-claims" />
				</label>
				<label class="field">
					<span class="field-label">{m.datasets_paste_type()}</span>
					<select bind:value={pasteType}>
						<option value="csv">CSV</option>
						<option value="json">JSON</option>
						<option value="text">{m.datasets_paste_type_text()}</option>
						<option value="sql">{m.datasets_paste_type_sql()}</option>
					</select>
				</label>
				<label class="field">
					<span class="field-label">{m.datasets_paste_content()}</span>
					<textarea rows="9" bind:value={pasteContent} placeholder={m.datasets_paste_placeholder()}></textarea>
				</label>
				<button class="btn-primary" onclick={submitPaste} disabled={createBusy || !pasteName.trim() || !pasteContent.trim()}>
					{createBusy ? m.datasets_creating() : m.datasets_create_submit()}
				</button>
			</div>
		{/if}
		{#if createBusy && createMode === 'upload'}<p class="drawer-pad">{m.datasets_creating()}</p>{/if}
		{#if createError}<div class="notice error">{createError}</div>{/if}
	</aside>
{/if}

<!-- Preview / edit drawer -->
{#if selected || drawerLoading}
	<div class="scrim" role="button" tabindex="0" aria-label={m.datasets_close()} onclick={closeDrawer} onkeydown={(e) => e.key === 'Escape' && closeDrawer()}></div>
	<aside class="drawer wide">
		{#if drawerLoading || !selected}
			<div class="drawer-pad">{m.datasets_loading()}</div>
		{:else}
			<header class="drawer-head">
				<div>
					<div class="drawer-name">{selected.name}</div>
					<div class="ds-slug">{#if canManage}{selected.slug} · {/if}{num(selected.rowCount, locale.current)} {m.datasets_rows_word()}</div>
				</div>
				<button class="icon-x" onclick={closeDrawer} aria-label={m.datasets_close()}>✕</button>
			</header>

			{#if renamedColumns.length && renamedFor === selected.slug}
				<div class="notice renamed">
					{m.datasets_columns_renamed({
						renames: renamedColumns.map((r) => `${r.from} ${flowArrow(getLocale())} ${r.to}`).join(', ')
					})}
				</div>
			{/if}

			<div class="drawer-section">{m.datasets_schema()}</div>
			<div class="schema">
				<!-- ⛔ KEYED BY INDEX, NOT `(col.name)` — AND THIS SITE IS THE SHARPEST OF THE SIX. It is
				     the SCHEMA EDITOR: the one screen whose whole purpose is letting a data manager inspect
				     and correct a dataset’s columns. Keying it on the very name that is broken meant a
				     dataset with a repeated column name threw `each_key_duplicate` here and took the whole
				     /datasets page down with it (no `<svelte:boundary>` in this tree) — so the only tool for
				     looking at the problem was the thing the problem destroyed. `i` is already the identity
				     these rows are edited by: `setType(i, …)` and `togglePii(i, …)` both address positionally.
				     Guarded by `datasets-page.duplicate-columns.render.test.ts`. -->
				{#each editCols as col, i (i)}
					<div class="schema-row">
						<span class="col-name">{col.name}</span>
						<select value={col.type} disabled={!canManage} onchange={(e) => setType(i, e.currentTarget.value as DatasetColumnType)}>
							<!-- The OPTION VALUE stays the enum — it is what `updateColumns` PUTs. Only the
							     option's TEXT is the reader's, and it has to be, or the schema editor would
							     offer "string / number" in a drawer whose mapping rows two panels over now
							     read "tekst / getal" for the same five values. -->
							{#each DATASET_COLUMN_TYPES as t (t)}<option value={t}>{datasetColumnTypeLabel(t)}</option>{/each}
						</select>
						<span class="pii-cell">
							<span class="pii-label">{m.datasets_col_pii()}</span>
							<!-- `disabled` as well as the guarded handler: without it this switch rendered live
							     beside a `<select>` in the same row that already greys out, and answered a
							     member's press by silently doing nothing. The guard stays — it is what makes
							     the non-write true rather than merely unreachable. -->
							<Toggle checked={!!col.pii} disabled={!canManage} label={m.datasets_col_pii()} onchange={(v) => canManage && togglePii(i, v)} />
						</span>
						<!-- "Not personal": a data manager's explicit mark — members then see the column's
						     real values (backend datasets/member-view.ts). Data managers only; disabled while
						     the personal-data switch is on, which overrides it. The suggestion label is only
						     a hint (backend datasets/column-suggestions.ts) and changes nothing until marked. -->
						{#if canManage}
							<span class="np-cell">
								<span class="pii-label">{m.datasets_col_not_personal()}</span>
								<Toggle checked={!!col.nonPersonal} disabled={!!col.pii} label={m.datasets_col_not_personal()} onchange={(v) => toggleNonPersonal(i, v)} />
							</span>
							{#if !col.pii && !col.nonPersonal && suggested.has(col.name)}
								<span class="suggested" data-testid="suggested-not-personal">{m.datasets_col_suggested_not_personal()}</span>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
			{#if canManage}
				{#if pendingSuggestions.length}
					<div class="schema-actions">
						<button class="btn-ghost" data-testid="mark-suggested" onclick={markSuggested} disabled={saveBusy}>
							{m.datasets_mark_suggested_not_personal()}
						</button>
					</div>
				{/if}
				<div class="schema-actions">
					<button class="btn-primary" onclick={saveSchema} disabled={!dirty || saveBusy}>
						{saveBusy ? m.datasets_saving() : m.datasets_save()}
					</button>
				</div>
			{/if}

			<div class="drawer-section">{m.datasets_sample_rows()}</div>
			<!-- ⛔ BOTH PROPS, AND NEITHER IS OPTIONAL TO THE FIX. `inspect()` fetches
			     `{ limit: 50 }` and this passed NOTHING, so the table silently stopped at row 50 under
			     a drawer header that says "12.480 rijen". `maxRows` alone would not have helped: the
			     server caps the array at the limit, so the notice's old `rows.length > maxRows` test
			     was `50 > 50`. `totalRows` is the number the reader is being surprised by.
			     ⚠️ `selected.limit`, NOT a literal 50 — the response echoes the limit it actually
			     applied, and it clamps (backend/src/routes/datasets.ts), so a hard-coded 50 here would
			     drift the moment that ceiling moves. 50 is a deliberate page size and is NOT raised:
			     the defect was the silence, not the number. -->
			<DatasetPreviewTable
				columns={selected.columns}
				rows={selected.rows}
				maxRows={selected.limit}
				totalRows={selected.rowCount}
				maskedColumns={selected.maskedColumns}
			/>

			<!-- The ontology mapping is a developer's tool: a saved mapping reads "column → entity
			     attribute KEY". A member (no `canManage`) sees the sample rows above and nothing below. -->
			{#if canManage}
			<div class="drawer-section">{m.datasets_mapping_title()}</div>
			<p class="map-help">{m.datasets_mapping_help()}</p>

			{#if savedMappings.length}
				<div class="saved-maps">
					{#each savedMappings as mp (mp.id)}
						<div class="saved-map">
							<!-- `entityLabel`, not `entityName`: the mapping DTO carries BOTH, and the localized
							     half was arriving unread. See the note on `attrOptions`. -->
							<span class="saved-ent">{mp.entityLabel}</span>
							<span class="saved-cols">{Object.entries(mp.columnMap).map(([c, a]) => `${c} ${flowArrow(getLocale())} ${a}`).join(', ')}</span>
							{#if canManage}
								<button class="btn-sm danger" onclick={() => removeMapping(mp.entityId)}>{m.datasets_mapping_remove()}</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- The editor: data managers only — confirming a mapping unmasks a column for members. -->
			{#if matrix}
				<div class="map-cell-pick">
					<div class="map-chiprow">
						<!-- ⛔ THE SAME DEFECT AS /ontology, ON A SCREEN THAT IS ALSO NAV-OPEN TO EVERY
						     TENANT MEMBER (navConfig.ts:111, no role gate) — and it survived the first
						     pass because the guard for it only read the /ontology route. A translated
						     "Sector" label sat directly over a raw `insurance`, and "Afdeling" over a
						     raw `Claims`. The chip VALUE is untouched: `pickIndustry`/`pickDepartment`
						     feed `mapIndustry`/`mapDepartment`, which go on the wire to
						     `suggestMappings({ industry, department })` and are matched against the
						     ontology_entities columns. Text is a word; value stays the key. -->
						<span class="map-chip-label">{m.ontology_select_industry()}</span>
						{#each matrix.industries as ind (ind)}
							<button class="chip" class:active={mapIndustry === ind} onclick={() => pickIndustry(ind)}>{industryLabel(ind)}</button>
						{/each}
					</div>
					<div class="map-chiprow">
						<span class="map-chip-label">{m.ontology_select_department()}</span>
						{#each matrix.departments as dept (dept)}
							<button class="chip" class:active={mapDepartment === dept} onclick={() => pickDepartment(dept)}>{departmentLabel(dept)}</button>
						{/each}
					</div>
				</div>
			{/if}

			{#if mapCell}
				<div class="map-actions">
					<button class="btn-sm" onclick={runSuggest} disabled={mapBusy}>
						{mapBusy ? m.datasets_mapping_suggesting() : m.datasets_mapping_suggest()}
					</button>
					<label class="ai-toggle"><input type="checkbox" bind:checked={useAi} /> {m.datasets_mapping_use_ai()}</label>
				</div>
				<div class="map-rows">
					<!-- Index-keyed for the same reason as the schema editor above. The mapping VALUE still
					     keys by NAME (`working[col.name]`, `setColMapping(col.name, …)`) — that is the wire
					     contract with `suggestMappings` and must not change; only the render identity moves. -->
					{#each selected.columns as col, ci (ci)}
						{@const pick = working[col.name]}
						<div class="map-row">
							<span class="map-col">{col.name}<span class="map-coltype">{datasetColumnTypeLabel(col.type)}</span></span>
							<select value={pick ? `${pick.entityId}::${pick.attribute}` : ''} onchange={(e) => setColMapping(col.name, e.currentTarget.value)}>
								<option value="">{m.datasets_mapping_unmapped()}</option>
								{#each attrOptions as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
							</select>
							{#if pick}
								<span class="conf-chip" class:low={pick.confidence < mapThreshold}>{pct(pick.confidence, locale.current)}</span>
								{#if pick.origin === 'llm'}<span class="origin-chip ai">AI</span>{/if}
								{#if pick.confidence < mapThreshold}<span class="review-flag">{m.datasets_mapping_review()}</span>{/if}
							{/if}
						</div>
					{/each}
				</div>
				<div class="map-save">
					<button class="btn-primary" onclick={saveMappings} disabled={mapBusy || Object.keys(working).length === 0}>
						{m.datasets_mapping_save()}
					</button>
				</div>
			{:else}
				<p class="map-hint">{m.datasets_mapping_pick_cell()}</p>
			{/if}

			{/if}

			{#if mapError}<div class="notice error map-error">{mapError}</div>{/if}
		{/if}
	</aside>
{/if}

<style>
	.from-request {
		font-size: 12.5px;
		color: var(--c-teal-dark);
	}
	.page {
		max-width: 1180px;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 20px;
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
		font-size: 28px;
		margin: 0 0 4px;
		color: var(--c-midnight);
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
		max-width: 640px;
	}
	.btn-primary {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 13px;
		padding: 9px 16px;
		border-radius: var(--r);
		white-space: nowrap;
		border: none;
		cursor: pointer;
	}
	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.filter-bar {
		display: flex;
		gap: 16px;
		margin-bottom: 16px;
	}
	.search {
		font-size: 12.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 8px 12px;
		border-radius: var(--r);
		width: 280px;
		max-width: 100%;
	}
	.table-wrap {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		overflow: hidden;
		transition: opacity 0.12s;
	}
	.table-wrap.dim {
		opacity: 0.6;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th {
		text-align: start;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		padding: 12px 16px;
		border-bottom: 1px solid var(--c-border);
		background: var(--c-surface);
	}
	td {
		padding: 12px 16px;
		font-size: 13px;
		color: var(--c-ink);
		border-bottom: 1px solid var(--c-border);
		vertical-align: middle;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	tbody tr:hover {
		background: var(--c-surface);
	}
	.num {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}
	.muted {
		color: var(--c-muted);
	}
	.ds-name {
		font-weight: 500;
		color: var(--c-ink);
	}
	.ds-slug {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-muted);
		margin-top: 1px;
	}
	.badge {
		font-size: 11px;
		font-weight: 500;
		padding: 3px 9px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.test-source {
		background: var(--c-amber-light, #fef3c7);
		color: #92400e;
		margin-inline-start: 4px;
		font-weight: 600;
	}
	.row-actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}
	.btn-sm {
		font-size: 12px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 5px 11px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.btn-sm:hover:not(:disabled) {
		border-color: var(--c-border-strong);
	}
	.btn-sm:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn-sm.danger {
		color: var(--c-rose);
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.pager-btns {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.pager-page {
		font-variant-numeric: tabular-nums;
	}
	.notice {
		padding: 24px;
		text-align: center;
		color: var(--c-muted);
		font-size: 13.5px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		margin-top: 12px;
	}
	.empty-cta {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
	}
	.notice.error {
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
	/* Advisory, not an error: the upload SUCCEEDED and no data was lost — a coral panel would read
	   as a failure and send the reader looking for one. */
	.notice.renamed {
		text-align: start;
		padding: 10px 12px;
		background: var(--c-amber-pale);
		border-color: var(--c-amber-light);
	}

	/* Drawer */
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(11, 20, 55, 0.32);
		z-index: 40;
	}
	.drawer {
		position: fixed;
		top: 0;
		inset-inline-end: 0;
		bottom: 0;
		width: 420px;
		max-width: 92vw;
		background: var(--c-white);
		border-inline-start: 1px solid var(--c-border);
		box-shadow: var(--sh-lg);
		z-index: 41;
		overflow-y: auto;
		padding: 20px 22px;
	}
	.drawer.wide {
		width: 560px;
	}
	.drawer-pad {
		color: var(--c-muted);
		font-size: 13px;
		padding: 12px 0;
	}
	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	.drawer-name {
		font-weight: 600;
		font-size: 16px;
		color: var(--c-midnight);
	}
	.icon-x {
		background: none;
		border: none;
		font-size: 16px;
		color: var(--c-muted);
		cursor: pointer;
		padding: 4px;
	}
	.chips {
		display: flex;
		gap: 8px;
		margin-bottom: 14px;
	}
	.chip {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-muted);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 6px 12px;
		border-radius: 999px;
		cursor: pointer;
	}
	.chip.active {
		background: var(--c-midnight);
		color: #fff;
		border-color: var(--c-midnight);
	}
	.create-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field-label {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--c-muted);
	}
	.field input,
	.field select,
	.field textarea {
		font-size: 12.5px;
		padding: 7px 10px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-white);
		font-family: inherit;
		width: 100%;
		box-sizing: border-box;
	}
	.field textarea {
		font-family: var(--font-mono);
		resize: vertical;
	}
	.drawer-section {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 16px 0 8px;
	}
	.schema {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.schema-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.col-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--c-ink);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.schema-row select {
		font-size: 12px;
		padding: 5px 8px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		background: var(--c-white);
	}
	.pii-cell,
	.np-cell {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.suggested {
		font-size: 10.5px;
		color: var(--c-muted);
		white-space: nowrap;
	}
	.pii-label {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--c-faint);
	}
	.schema-actions {
		margin: 12px 0 4px;
	}
	/* ---- Phase 3.3: ontology mapping section (preview drawer) ---- */
	.map-help {
		font-size: 12px;
		color: var(--c-muted);
		margin: 0 0 12px;
		line-height: 1.5;
	}
	.saved-maps {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 14px;
	}
	.saved-map {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		background: var(--c-surface);
		border-radius: var(--r);
	}
	.saved-ent {
		font-weight: 600;
		font-size: 12.5px;
		color: var(--c-midnight);
		flex-shrink: 0;
	}
	.saved-cols {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.saved-map .btn-sm {
		margin-inline-start: auto;
		flex-shrink: 0;
	}
	.map-cell-pick {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 12px;
	}
	.map-chiprow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.map-chip-label {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--c-muted);
		font-weight: 600;
		margin-inline-end: 4px;
	}
	.map-actions {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 10px;
	}
	.ai-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--c-ink);
		cursor: pointer;
	}
	.map-rows {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}
	.map-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.map-col {
		display: flex;
		align-items: baseline;
		gap: 6px;
		width: 150px;
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--c-ink);
		overflow: hidden;
	}
	.map-coltype {
		font-size: 9.5px;
		color: var(--c-faint);
	}
	.map-row select {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		padding: 5px 8px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-white);
	}
	.conf-chip {
		font-size: 10px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-light);
		padding: 1px 6px;
		border-radius: 999px;
		flex-shrink: 0;
	}
	.conf-chip.low {
		color: #92400e;
		background: var(--c-amber-light, #fef3c7);
	}
	.origin-chip.ai {
		font-size: 9px;
		font-weight: 700;
		color: #5b21b6;
		background: var(--c-violet-light, #ede9fe);
		padding: 1px 5px;
		border-radius: 4px;
		flex-shrink: 0;
	}
	.review-flag {
		font-size: 10px;
		color: var(--c-coral-dark);
		flex-shrink: 0;
	}
	.map-save {
		margin-bottom: 8px;
	}
	.map-hint {
		font-size: 12px;
		color: var(--c-faint);
		margin: 4px 0 8px;
	}
	.map-error {
		margin-top: 8px;
	}
</style>
