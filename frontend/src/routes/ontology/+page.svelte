<script lang="ts">
	// Platform "Ontology" (Phase 3.2 browse; 3.5 per-tenant authoring). Browse the industry
	// × department matrix and view the compiled effective entity-relation graph (the
	// SvelteFlow we already own), localized + overlaid with this org's overrides. An org
	// admin (canManage) may add custom entities/relations and override/edit/delete their own
	// — edits happen in a side modal, the canvas stays read-only. RTL-safe chrome (graph is
	// forced LTR). Strings localized via paraglide.
	import { onMount } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { ontologyApi, ApiError } from '$lib/api/ontology';
	import { informationRequestsApi } from '$lib/api/information-requests';
	import { entityPrefill, fromRequestParam } from '$lib/requests/prefill';
	import { datasetsApi } from '$lib/api/datasets';
	// ⛔ NO `auditApi` IMPORT HERE, DELIBERATELY. This page used to read the PLATFORM audit feed for
	// its "Recent changes" panel and thereby showed a super_admin every other workspace's ontology
	// history — see `loadChanges`. `/audit` is the only correct caller of `auditApi.list`.
	import type { AuditItem } from '$lib/types/audit';
	import { timeAgo, num } from '$lib/utils/format';
	import { ontologyActionLabel, ontologyTargetLabel } from '$lib/i18n/ontology-action-label';
	import { industryLabel, departmentLabel, ontologyScopeLabel } from '$lib/i18n/ontology-axis-label';
	// The detail panel's attribute types are the same vocabulary the graph nodes render — one
	// labeller for both, or the two halves of this screen disagree. See $lib/i18n/dataset-label.ts.
	import { datasetColumnTypeLabel } from '$lib/i18n/dataset-label';
	// The relation row is the SAME vocabulary the graph edge renders — one helper for both, or the
	// two halves of this screen disagree about what a relation is called. See the module's header
	// for why `||` (not `??`) and why the keys stay on `predicate`.
	import {
		ontologyRelationLabel,
		ontologyRelationEndLabel,
		entitiesByName
	} from '$lib/i18n/ontology-relation-label';
	// The relation row's THIRD chip. The two above localize the ends and the predicate; this one
	// was the raw `cardinality` column sitting between them. See the module header for why its
	// value set is open and why an unknown value must render as itself.
	import { ontologyCardinalityLabel } from '$lib/i18n/ontology-cardinality-label';
	import OntologyGraph from '$lib/components/ontology/OntologyGraph.svelte';
	import DatasetPicker from '$lib/components/DatasetPicker.svelte';
	import * as m from '$lib/paraglide/messages';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import type {
		CompiledOntology,
		MatrixData,
		OntologyEntity,
		OntologyScope,
		OntologyAttribute,
		EntityTranslations,
		EntitySample
	} from '$lib/types/ontology';
	import type { DatasetRow } from '$lib/types/datasets';
	// `LOCALE_LABELS` — the SAME table the topbar's language switcher renders. The translations
	// picker below is the only other place in the app that lists locales to a reader, and it was
	// listing raw BCP-47 codes. See the note at its `{#each}`.
	import { locale, LOCALE_LABELS } from '$lib/stores/locale.svelte';
	import { auth } from '$lib/stores/auth.svelte';

	// The 7 non-en editions a tenant entity can be localized into (3.7).
	const TX_LOCALES = ['nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

	let matrix = $state<MatrixData | null>(null);
	let industry = $state<string | null>(null);
	let department = $state<string | null>(null);
	let ontology = $state<CompiledOntology | null>(null);
	let selectedEntity = $state<OntologyEntity | null>(null);
	let canManage = $state(false);

	// `CompiledRelation.from`/`.to` are canonical entity NAMES; every other site on this screen
	// prints `entity.label`. One index, rebuilt only when the compiled graph changes, so the
	// relation list can print the same words as the card it sits beside.
	const relationEntities = $derived(entitiesByName(ontology ?? { entities: [] }));

	// ---- entity test-data bindings (ontology-data-blocks Phase 1) ----
	let samples = $state<EntitySample[]>([]);
	let allDatasets = $state<DatasetRow[]>([]);
	/** The server's real dataset total, and whether the walk had to stop short of it. */
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);
	let samplesBusy = $state(false);
	let samplesError = $state<string | null>(null);

	// Load the selected entity's test-data bindings (managers only). Re-runs on selection change.
	$effect(() => {
		const ent = selectedEntity;
		deriveMsg = null;
		if (ent && canManage) void loadSamples(ent.id);
		else samples = [];
	});

	async function loadSamples(entityId: string) {
		samplesBusy = true;
		samplesError = null;
		try {
			samples = await ontologyApi.listSamples(entityId);
			if (allDatasets.length === 0) {
				// ⛔ `datasetsApi.list()` — ONE PAGE OF TWELVE — WAS THE DEFECT, AND THIS SCREEN WAS ITS
				// WORST VICTIM. `bindableDatasets` below subtracts the rows already bound to this entity
				// from whatever this call returned, so with thirteen datasets the thirteenth could never be
				// bound, and once the first twelve WERE bound the picker emptied and disappeared entirely
				// (`{#if bindableDatasets.length}`) — a workspace with datasets left to offer rendering as
				// one that has none. `listAll` walks the pages and reports its own ceiling; `datasetsCapped`
				// is rendered next to the picker, because a short list that says nothing is the bug.
				const all = await datasetsApi.listAll();
				allDatasets = all.items;
				datasetsTotal = all.total;
				datasetsCapped = all.capped;
			}
		} catch (e) {
			samplesError = errorText(e, m.error_load_failed());
			samples = [];
		} finally {
			samplesBusy = false;
		}
	}

	// Datasets not yet bound to this entity (candidates for the picker).
	const bindableDatasets = $derived(
		allDatasets.filter((d) => !samples.some((s) => s.datasetSlug === d.slug))
	);

	async function bindSampleBySlug(slug: string) {
		const ent = selectedEntity;
		const ds = allDatasets.find((d) => d.slug === slug);
		if (!ent || !ds) return;
		samplesBusy = true;
		samplesError = null;
		try {
			// First binding becomes primary automatically.
			await ontologyApi.bindSample(ent.id, { datasetId: ds.id, isPrimary: samples.length === 0 });
			samples = await ontologyApi.listSamples(ent.id);
		} catch (e) {
			samplesError = writeErrorText(e, m.error_save_failed());
		} finally {
			samplesBusy = false;
		}
	}

	async function makeSamplePrimary(s: EntitySample) {
		const ent = selectedEntity;
		if (!ent || s.isPrimary) return;
		samplesBusy = true;
		samplesError = null;
		try {
			await ontologyApi.bindSample(ent.id, {
				datasetId: s.datasetId,
				mappingId: s.mappingId,
				isPrimary: true
			});
			samples = await ontologyApi.listSamples(ent.id);
		} catch (e) {
			samplesError = writeErrorText(e, m.error_save_failed());
		} finally {
			samplesBusy = false;
		}
	}

	async function unbindSample(s: EntitySample) {
		const ent = selectedEntity;
		if (!ent) return;
		samplesBusy = true;
		samplesError = null;
		try {
			await ontologyApi.unbindSample(s.id);
			samples = await ontologyApi.listSamples(ent.id);
		} catch (e) {
			samplesError = writeErrorText(e, m.error_delete_failed());
		} finally {
			samplesBusy = false;
		}
	}

	// ---- derive a data block from the entity + its primary sample (Phase 3) ----
	let deriveBusy = $state(false);
	let deriveMsg = $state<string | null>(null);

	async function deriveBlock() {
		const ent = selectedEntity;
		if (!ent) return;
		deriveBusy = true;
		deriveMsg = null;
		samplesError = null;
		try {
			const res = await ontologyApi.deriveBlock(ent.id);
			deriveMsg = m.ontology_derive_block_done({ name: res.block.name, version: res.version.version });
		} catch (e) {
			samplesError = writeErrorText(e, m.error_action_failed());
		} finally {
			deriveBusy = false;
		}
	}

	let loading = $state(true);
	let graphLoading = $state(false);
	let denied = $state(false);
	let error = $state<string | null>(null);
	// A failed ACTION (delete/hide/unhide an entity, delete a relation), kept separate from `error`
	// (the LOAD error). `error` renders inside the `{#if denied}…{:else if error}` chain below, which
	// is mutually exclusive with the graph — so writing a button failure there replaced the whole
	// page the message was supposed to explain. This one renders ABOVE the chain and leaves the
	// graph in place. `load()`/`loadGraph()` deliberately keep writing to `error`: the graph IS the
	// content, so blanking it on a graph-load failure is correct. Same pattern as #210's `voteError`.
	let actionError = $state<string | null>(null);

	// ---- editor state (3.5) ----
	interface AttrForm { name: string; type: string; pii: boolean; synonyms: string }
	interface EntityForm {
		mode: 'create' | 'edit' | 'override';
		id?: string;
		scope: OntologyScope;
		industry: string | null;
		department: string | null;
		name: string;
		label: string;
		description: string;
		synonyms: string;
		attributes: AttrForm[];
	}
	interface RelForm { fromEntityId: string; toEntityId: string; predicate: string; label: string; cardinality: string }
	let editor = $state<EntityForm | null>(null);
	let relEditor = $state<RelForm | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	// ---- translations editor (3.7) — only for a tenant-owned entity being edited ----
	let translations = $state<EntityTranslations>({});
	let txLocale = $state<(typeof TX_LOCALES)[number]>('nl');
	let txSaving = $state(false);
	let txMsg = $state<string | null>(null);
	/**
	 * ⛔ WHETHER `translations` HOLDS THIS ENTITY'S REAL STORED VALUES, AND WHY SAVE DEPENDS ON IT.
	 * `openEditEntity` used to swallow a failed `GET …/translations` into an empty `catch` commented
	 * "keep empty", leaving `translations[loc] = {}`. `saveTranslation` then PUT `label: t.label ?? ''` and
	 * `description: t.description ?? ''` — both keys present, both empty — and said "Saved".
	 *
	 * The receiving end makes that WORSE, not safer. `PUT …/translations` is sparse BY KEY PRESENCE
	 * on purpose (backend/src/routes/ontology.ts:271-279, its own comment explains why), and
	 * `setEntityTranslations` (backend/src/ontology/ontology-service.ts:1053-1060) sends a falsy
	 * TRIMMED value to `deleteTranslation`. So one blipped GET turned Save into ERASE, answered 200,
	 * and the screen reported success over a delete of the author's Dutch label and description.
	 *
	 * ⚠️ AND DROPPING THE `?? ''` WOULD NOT HAVE FIXED IT. A failed GET would then make Save a silent
	 * no-op — the same lie, quieter. `''` also has to STAY sendable: an intentional clear is that
	 * endpoint's documented way to remove a translation. The only honest split is "did the read
	 * succeed", which is what this flag is.
	 */
	let txLoaded = $state(false);
	let txLoadError = $state<string | null>(null);
	/**
	 * ⛔ THE READ FOR THE ENTITY NOW ON SCREEN IS STILL IN FLIGHT — and before this the panel simply
	 * showed the PREVIOUS entity's text while it was. `editor` (with `id`) is assigned synchronously,
	 * so the block's gate `editor.mode === 'edit' && editor.id` is true immediately, and
	 * `{#if translations[txLocale]}` was true too because `translations` still held the last entity's
	 * fully-keyed map. Result: entity A's Dutch label and description, under entity B's name, with a
	 * live Save that would have written them to B's id.
	 *
	 * ⚠️ IT IS PAIRED WITH THE DISABLE ON PURPOSE. Hoisting `translations` above the await empties the
	 * boxes for the length of the fetch, and empty boxes over a live Save is precisely the erase path
	 * `txLoaded` exists to close (a blank PUT resolves to `deleteTranslation` server-side). The fields
	 * are shown, inert, so the reader can see the panel is B's and not yet filled.
	 */
	let txLoading = $state(false);

	function hasSpec(ind: string, dept: string): boolean {
		return !!matrix?.cells.find((c) => c.industry === ind && c.department === dept)?.hasSpecialization;
	}

	async function loadGraph() {
		if (!industry || !department) return;
		graphLoading = true;
		// ⛔ BOTH FLAGS, HERE TOO, AND THE SECOND LINE IS THE STRUCTURAL HALF. This function's own
		// `catch` sets `denied = true` (below) and used to clear only `error` — it recovered purely
		// because `{#if denied}` replaces the arm holding the industry/department chips, so nothing
		// could re-enter `loadGraph` while denied was set. That is a render-chain ACCIDENT, not a
		// guarantee: add a retry to the denied arm (which this commit does), or move the chips, and
		// the entry point becomes reachable with a latch behind it. A function that can set a flag
		// resets it itself.
		error = null;
		denied = false;
		selectedEntity = null;
		try {
			ontology = await ontologyApi.get(industry, department);
			canManage = ontology.canManage ?? canManage;
			loadChanges();
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			graphLoading = false;
		}
	}

	function selectIndustry(ind: string) {
		if (industry === ind) return;
		industry = ind;
		loadGraph();
	}
	function selectDepartment(dept: string) {
		if (department === dept) return;
		department = dept;
		loadGraph();
	}

	// ---- editor helpers (3.5) ----
	const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

	/** Parse "scope:industry:department:name" → its parts (industry/department empty → null). */
	function parseKey(key: string): { scope: OntologyScope; industry: string | null; department: string | null; name: string } {
		const parts = key.split(':');
		return {
			scope: (parts[0] ?? 'industry_dept') as OntologyScope,
			industry: parts[1] || null,
			department: parts[2] || null,
			name: parts.slice(3).join(':')
		};
	}

	const attrToForm = (a: OntologyAttribute): AttrForm => ({
		name: a.name,
		type: a.type,
		pii: a.pii,
		synonyms: a.synonyms.join(', ')
	});

	function openAddEntity() {
		saveError = null;
		editor = {
			mode: 'create',
			scope: 'industry_dept',
			industry,
			department,
			name: '',
			label: '',
			description: '',
			synonyms: '',
			attributes: []
		};
	}

	async function openEditEntity(e: OntologyEntity) {
		saveError = null;
		txMsg = null;
		txLocale = 'nl';
		const k = parseKey(e.key);
		editor = {
			mode: 'edit',
			id: e.id,
			scope: e.scope,
			industry: k.industry,
			department: k.department,
			name: e.name,
			label: e.label,
			description: e.description ?? '',
			synonyms: e.synonyms.join(', '),
			attributes: e.attributes.map(attrToForm)
		};
		// Load the entity's authored translations (normalize so every locale key exists for bind).
		//
		// ⛔ THE BIND IS REPOINTED BEFORE THE AWAIT, NOT AFTER IT. `translations = base` used to be the
		// last statement of this function, which left the panel bound to the PREVIOUS entity's map for
		// the whole round-trip — see `txLoading`. Empty-but-this-entity's is the only honest thing to
		// show while the read is outstanding.
		const base: EntityTranslations = {};
		for (const loc of TX_LOCALES) base[loc] = {};
		translations = base;
		txLoaded = false;
		txLoadError = null;
		txLoading = true;
		try {
			const fetched = await ontologyApi.getTranslations(e.id);
			// ⛔ STALE-RESPONSE GUARD. Two entities opened in quick succession answer in whatever order
			// the network chooses; without this, a slow reply for A lands on B's open panel — A's text
			// under B's name, `txLoaded` true beside it, and the next Save writes it to B's id.
			if (editor?.id !== e.id) return;
			const merged: EntityTranslations = {};
			for (const loc of TX_LOCALES) merged[loc] = {};
			for (const [loc, v] of Object.entries(fetched)) merged[loc] = { ...v };
			translations = merged;
			txLoaded = true;
		} catch {
			if (editor?.id !== e.id) return;
			// ⛔ NOT "keep empty — authoring still works". Empty boxes here are indistinguishable from
			// "this entity has no translation yet", and Save turns that indistinguishability into a
			// DELETE (see `txLoaded`). The panel says so and Save is switched off.
			// ⚠️ The catalog sentence, not the server's: what the author needs is the CONSEQUENCE
			// ("saving is off, reopen to retry"), which no backend message carries.
			txLoadError = m.ontology_translations_load_failed();
		} finally {
			// Only the fetch that still owns the panel may clear its spinner.
			if (editor?.id === e.id) txLoading = false;
		}
	}

	function openOverride(e: OntologyEntity) {
		saveError = null;
		const k = parseKey(e.key);
		editor = {
			mode: 'override',
			scope: k.scope,
			industry: k.industry,
			department: k.department,
			name: e.name,
			label: e.label,
			description: e.description ?? '',
			synonyms: e.synonyms.join(', '),
			attributes: e.attributes.map(attrToForm)
		};
	}

	function addAttrRow() {
		editor?.attributes.push({ name: '', type: 'string', pii: false, synonyms: '' });
	}
	function removeAttrRow(i: number) {
		if (editor) editor.attributes.splice(i, 1);
	}

	async function saveEntity() {
		if (!editor) return;
		const form = editor;
		if (!form.name.trim() || !form.label.trim()) {
			saveError = m.ontology_name_label_required();
			return;
		}
		saving = true;
		saveError = null;
		const attributes: OntologyAttribute[] = form.attributes
			.filter((a) => a.name.trim())
			.map((a) => ({
				name: a.name.trim(),
				type: a.type.trim() || 'string',
				pii: a.pii,
				synonyms: splitList(a.synonyms),
				description: null
			}));
		const synonyms = splitList(form.synonyms);
		const description = form.description.trim() ? form.description.trim() : null;
		try {
			if (form.mode === 'edit' && form.id) {
				await ontologyApi.updateEntity(form.id, { label: form.label.trim(), description, synonyms, attributes });
			} else {
				await ontologyApi.createEntity({
					scope: form.scope,
					industry: form.industry,
					department: form.department,
					name: form.name.trim(),
					label: form.label.trim(),
					description,
					synonyms,
					attributes
				});
			}
			editor = null;
			await loadGraph();
		} catch (e) {
			saveError = writeErrorText(e, m.error_save_failed());
		} finally {
			saving = false;
		}
	}

	async function deleteEntity(e: OntologyEntity) {
		if (!(await confirmDialog({ message: m.ontology_delete_entity_confirm({ name: e.label }) }))) return;
		actionError = null;
		try {
			await ontologyApi.deleteEntity(e.id);
			await loadGraph();
		} catch (err) {
			actionError = writeErrorText(err, m.error_delete_failed());
		}
	}

	// ---- tombstoning (3.7): hide/unhide a GLOBAL entity for this org ----
	async function hideEntity(e: OntologyEntity) {
		actionError = null;
		try {
			await ontologyApi.hideEntity(e.id);
			selectedEntity = null;
			await loadGraph();
		} catch (err) {
			actionError = writeErrorText(err, m.error_action_failed());
		}
	}
	async function unhideEntity(id: string) {
		actionError = null;
		try {
			await ontologyApi.unhideEntity(id);
			await loadGraph();
		} catch (err) {
			actionError = writeErrorText(err, m.error_action_failed());
		}
	}

	// ---- save a tenant entity's translation for the selected locale (3.7) ----
	async function saveTranslation() {
		// ⛔ THE GUARD, NOT ONLY THE `disabled` ATTRIBUTE. `disabled` is what the author sees; this is
		// what makes the erase unreachable from any other caller. See `txLoaded`.
		if (!editor?.id || !txLoaded) return;
		txSaving = true;
		txMsg = null;
		saveError = null;
		const t = translations[txLocale] ?? {};
		try {
			await ontologyApi.setTranslations(editor.id, txLocale, {
				label: t.label ?? '',
				description: t.description ?? ''
			});
			txMsg = m.ontology_translation_saved();
		} catch (e) {
			saveError = writeErrorText(e, m.error_save_failed());
		} finally {
			txSaving = false;
		}
	}

	function openAddRelation() {
		saveError = null;
		const first = ontology?.entities[0]?.id ?? '';
		const second = ontology?.entities[1]?.id ?? first;
		relEditor = { fromEntityId: first, toEntityId: second, predicate: '', label: '', cardinality: '' };
	}

	async function saveRelation() {
		if (!relEditor) return;
		const f = relEditor;
		if (!f.predicate.trim() || f.fromEntityId === f.toEntityId) {
			saveError = m.ontology_relation_invalid();
			return;
		}
		saving = true;
		saveError = null;
		try {
			await ontologyApi.createRelation({
				fromEntityId: f.fromEntityId,
				toEntityId: f.toEntityId,
				predicate: f.predicate.trim(),
				label: f.label.trim() || f.predicate.trim(),
				cardinality: f.cardinality.trim()
			});
			relEditor = null;
			await loadGraph();
		} catch (e) {
			saveError = writeErrorText(e, m.error_save_failed());
		} finally {
			saving = false;
		}
	}

	async function deleteRelation(id: string) {
		actionError = null;
		try {
			await ontologyApi.deleteRelation(id);
			await loadGraph();
		} catch (err) {
			actionError = writeErrorText(err, m.error_delete_failed());
		}
	}

	// Recent ontology edits IN THIS WORKSPACE — every entity/relation/sample mutation records an
	// `ontology.*` row under category `data`. Read-only; best-effort.
	//
	// ⛔ THIS USED TO READ THE PLATFORM AUDIT FEED, AND THAT IS THE DEFECT THE ROUTE NOW FIXES:
	//
	//     const feed = await auditApi.list({ category: 'data', q: 'ontology', range: '30d' });
	//
	// `GET /api/audit` is the same endpoint /audit renders, and it has NO tenant predicate — nor can
	// it have one: `audit_log` carries no `tenant_id` column and sits outside RLS by design
	// (migration 0028), because being the one cross-tenant record is its job. So a super_admin
	// opening this page — including one scope-switched into a customer's workspace via
	// `X-Active-Tenant-Id` — read EVERY other tenant's ontology history in a panel captioned
	// "Recent changes", directly beneath a graph that is tenant-scoped. Measured before the fix: an
	// operator acting into the demo tenant saw another tenant's "Custom entity
	// 'rival_margin_secret'" as the top row.
	//
	// ⛔⛔ AND FILTERING THESE ROWS HERE CANNOT WORK, which is why the fix is a server route and not
	// three lines below. `ontology` is ONE compiled cell of the graph (industry × department) with
	// the GLOBAL ontology merged in, so a browser-side "is this target in my graph?" test both drops
	// the workspace's own edits in other cells and accepts `entity_hide` rows naming a global entity
	// that any tenant could have written. And the feed is paginated at 25 while this panel shows 8:
	// 25 foreign rows push the reader's own ninth-newest change off a page the browser never sees.
	let recentChanges = $state<AuditItem[]>([]);
	// Rows that are `ontology.*` in the window but belong to no resolvable workspace (a delete whose
	// target is gone, a hide whose target is global, anything written before audit rows carried
	// their tenant). They MIGHT be this workspace's, so they are neither rendered as its own nor
	// dropped in silence — the panel says how many there are.
	let changesUnattributed = $state(0);
	// ⛔ NOT EVERY FAILURE HERE IS A FAILURE THE READER SHOULD HEAR ABOUT — see `loadChanges`.
	let changesError = $state<string | null>(null);
	async function loadChanges() {
		// ⛔ ONLY A SUPER_ADMIN ASKS. The route is `requireSuperAdmin` (same gate, same reason as the
		// note in the catch below), so for every other reader the request could only ever answer 403:
		// four console errors per visit for a member, for a panel they cannot have. Not asking is the
		// same silent rendering the 403 branch produces, without the failed requests.
		if (!auth.isSuperAdmin) {
			recentChanges = [];
			changesUnattributed = 0;
			changesError = null;
			return;
		}
		try {
			const feed = await ontologyApi.recentChanges();
			recentChanges = feed.items;
			changesUnattributed = feed.unattributed;
			changesError = null;
		} catch (e) {
			// ⛔ WAS `catch { recentChanges = []; }`, and the panel is behind `{#if recentChanges.length}`
			// — so a 500 on the audit feed made the whole "Recent changes" block VANISH, which on this
			// screen is indistinguishable from "this ontology has not been edited in 30 days".
			//
			// ⚠️ BUT THE 401/403 IS NOT A FAILURE HERE, IT IS THE EXPECTED ANSWER. The route is still
			// `requireSuperAdmin` (backend/src/routes/ontology.ts — its rows come from the platform
			// audit log, and scoping the ANSWER to a workspace is not a reason to widen who may read
			// that table) while /ontology is nav-open to any
			// member (lib/layout/navConfig.ts:122), so for most readers of this page the audit feed is
			// simply not theirs to read. Shouting "could not be loaded" at them would report the
			// product working as designed as a fault, every visit. Same discrimination as
			// `routes/audit/+page.svelte`'s `denied` flag — except that page's whole subject is the
			// feed, so it says so out loud; here the panel is a footnote and silence is the honest
			// rendering. Anything else — a 500, a dropped connection — is a real failure and is named.
			recentChanges = [];
			changesUnattributed = 0;
			changesError =
				e instanceof ApiError && (e.status === 401 || e.status === 403)
					? null
					: errorText(e, m.ontology_recent_changes_failed());
		}
	}

	async function load() {
		loading = true;
		// ⛔ RESET BOTH FLAGS, at the TOP, before anything can fail again. `denied` was set in two
		// places and cleared in none, so a single 403 on the first load latched the page to
		// "you have no access" for the whole SPA session — the role came back, `load()` re-ran on a
		// locale switch and succeeded, and the page still refused. Only F5 cleared it.
		// `error` latched the same way whenever the recovered load has no cell to draw: `loadGraph()`
		// clears it, but only AFTER its `if (!industry || !department) return`.
		// Same two lines as every sibling screen — connectors, pipeline, sandboxes, it-dash,
		// datasets, usage, sso, llm-settings, mcp-keys, delivery.
		error = null;
		denied = false;
		try {
			matrix = await ontologyApi.matrix();
			canManage = matrix.canManage ?? false;
			loadChanges();
			// Default to the first specialization cell, else the first industry/department.
			const spec = matrix.cells.find((c) => c.hasSpecialization);
			industry = spec?.industry ?? matrix.industries[0] ?? null;
			department = spec?.department ?? matrix.departments[0] ?? null;
			await loadGraph();
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	// W8/P5: `?fromRequest=<id>` — an approver arrives here from /requests after approving a "missing
	// information" request. Open the EXISTING create-entity form prefilled from it; saving goes through
	// the same gated POST as any other new entity. Only for a reader who may author (`canManage`).
	let fromRequestNote = $state(false);
	async function prefillFromRequest() {
		const id = fromRequestParam();
		if (!id || !canManage) return;
		try {
			const req = await informationRequestsApi.get(id);
			if (req.kind !== 'missing_information') return;
			openAddEntity();
			if (!editor) return;
			const pre = entityPrefill(req);
			editor.name = pre.name;
			editor.label = pre.label;
			editor.description = pre.description;
			editor.attributes = pre.attributes;
			fromRequestNote = true;
		} catch {
			// The page itself is fine; the request is gone or not readable — the form simply stays closed.
		}
	}
	onMount(async () => {
		await load();
		await prefillFromRequest();
	});
	// ⛔ CORRECTED — THIS LINE USED TO CLAIM SOMETHING IT CANNOT DO. It read:
	//
	//     // Relocalize matrix axis labels + entity/relation graph on locale switch.
	//
	// The second half is true and is why the call stays: `load()` ends in `loadGraph()`, and
	// `GET /api/ontology` IS locale-negotiated (backend/src/routes/ontology.ts:65), so a language
	// switch really does re-fetch the entity/relation graph in the new language.
	//
	// The FIRST half was never true. `GET /api/ontology/matrix` takes no locale — not because the
	// call was forgotten, but because there is no translation to negotiate: the axes are
	// `ontology_entities.industry` / `.department` column values with no `content_translations`
	// namespace behind them (see the header of $lib/i18n/ontology-axis-label.ts). Re-fetching it
	// returns identical bytes in all eight locales, so for two releases this comment described the
	// mechanism by which the chips above the graph STAYED English while the graph translated
	// underneath them. The axis words are now resolved in the browser by `industryLabel` /
	// `departmentLabel`, which re-render from the paraglide rune with no fetch at all — this call
	// is not, and never was, what localizes them.
	reloadOnLocaleChange(load);
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.ontology_eyebrow()}</div>
			<h1>{m.ontology_title()}</h1>
			<p>{m.ontology_subtitle()}</p>
		</div>
	</header>

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	{#if denied}
		<div class="notice error" role="alert">
			<span>{m.ontology_denied()}</span>
			<!-- ⛔ THE DENIED ARM NEEDS THE EXIT MORE THAN THE ERROR ARM DOES, not less. A refusal used
			     to LATCH: `denied` was set and never cleared, so once a 403 landed the page stayed
			     "no access" even after the grant was restored and the API answered 200 again — a
			     locale switch re-ran `load()` and it still said no. `load()` now clears both flags, so
			     this button IS the recovery, and it is the only one: this arm replaces the whole page
			     including the chips, so there is nothing else left to click. Deliberately NOT hidden
			     on 403 — "retrying cannot help" is true only while the refusal stands, and the case
			     worth serving is precisely the one where it no longer does. -->
			<button class="retry" onclick={load}>{m.error_load_retry()}</button>
		</div>
	{:else if loading}
		<div class="notice">{m.ontology_loading()}</div>
	{:else if error}
		<div class="notice error" role="alert">
			<span>{error}</span>
			<!-- ⛔ THE COPY NAMES AN ACTION; THIS IS THE CONTROL THAT PERFORMS IT. `error_load_failed`
			     reads "We couldn't load that. Please try again." and this arm replaces the whole page,
			     so a failed first load was a dead end with no exit but F5. Same sentence-plus-button
			     shape as the profile-error row in +layout.svelte, except this one re-runs the page's own
			     loader rather than reloading the app. -->
			<button class="retry" onclick={load}>{m.error_load_retry()}</button>
		</div>
	{:else if matrix}
		<div class="selectors">
			<div class="selector">
				<span class="selector-label">{m.ontology_select_industry()}</span>
				<div class="chips">
					<!-- ⛔ THE CHIP'S TEXT IS A WORD; `ind` STAYS THE VALUE. `selectIndustry` stores the
					     raw slug and `loadGraph` sends it as `?industry=` to be matched against the
					     `ontology_entities.industry` COLUMN — passing the label would translate the
					     chips and empty the graph. Same split as the work-area chip on a challenge. -->
					{#each matrix.industries as ind (ind)}
						<button class="chip" class:active={industry === ind} onclick={() => selectIndustry(ind)}>{industryLabel(ind)}</button>
					{/each}
				</div>
			</div>
			<div class="selector">
				<span class="selector-label">{m.ontology_select_department()}</span>
				<div class="chips">
					{#each matrix.departments as dept (dept)}
						<button class="chip" class:active={department === dept} onclick={() => selectDepartment(dept)}>
							{departmentLabel(dept)}{#if industry && hasSpec(industry, dept)}<span class="spec-dot" title={m.ontology_specialized()}>●</span>{/if}
						</button>
					{/each}
				</div>
			</div>
		</div>

		<div class="graph-area">
			<div class="graph-col">
				{#if ontology}
					<div class="graph-meta">
						<!-- The graph header named the cell in the seed's language — `insurance × Claims`
						     directly above entities reading "Schadeclaim" and "Polis". Each side is
						     guarded rather than passed through the label fn, because both are
						     `string | null` before the first cell resolves and `{null}` already
						     rendered as nothing here. -->
						<span class="meta-cell">{industry ? industryLabel(industry) : ''} × {department ? departmentLabel(department) : ''}</span>
						{#if industry && department && hasSpec(industry, department)}
							<span class="badge amber">{m.ontology_specialized()}</span>
						{/if}
						<span class="meta-count">{m.ontology_entities_count({ count: num(ontology.entities.length, locale.current) })}</span>
						<span class="meta-count">{m.ontology_relations_count({ count: num(ontology.relations.length, locale.current) })}</span>
						{#if canManage}
							<span class="manage-tools">
								<button class="btn-sm" onclick={openAddEntity}>{m.ontology_add_entity()}</button>
								<button class="btn-sm" onclick={openAddRelation} disabled={ontology.entities.length < 2}>{m.ontology_add_relation()}</button>
							</span>
						{/if}
					</div>
					<div class="graph-frame" class:dim={graphLoading}>
						{#if ontology.entities.length === 0}
							<div class="notice subtle">{m.ontology_empty()}</div>
						{:else}
							{#key `${industry}:${department}`}
								<OntologyGraph {ontology} onselect={(e) => (selectedEntity = e)} />
							{/key}
						{/if}
					</div>
					<p class="graph-hint">{m.ontology_click_entity()}</p>

					<!-- Three states, not two. The panel is ABSENT when the feed came back empty (there is
					     genuinely nothing to report, and an empty box saying so is noise) and absent when
					     the reader lacks the super-admin role the audit route requires — but a panel that
					     could not be LOADED says so, instead of disappearing and letting its absence be
					     read as "nothing has changed here in 30 days".

					     ⛔ AND A FOURTH: rows the route HID. `changesUnattributed > 0` opens the panel on
					     its own, with no list. Gating the whole block on `recentChanges.length` would put
					     the disclosure inside a box that only renders when there is nothing to disclose —
					     a workspace whose only recent ontology work was a delete would see the panel
					     vanish and read that as "nothing has changed", which is the same
					     absent-collapsed-into-empty failure the error line above exists to prevent. -->
					{#if changesError}
						<div class="changes">
							<div class="changes-head">{m.ontology_recent_changes()}</div>
							<p class="changes-error" role="alert" data-testid="changes-error">{changesError}</p>
						</div>
					{:else if recentChanges.length > 0 || changesUnattributed > 0}
						<div class="changes">
							<div class="changes-head">{m.ontology_recent_changes()}</div>
							<ul>
								<!-- ⛔ THIS LINE USED TO READ "Mary de Vries · entity create · 3f1c…-a8b2 · 2u geleden".
								     `c.action` is the backend audit enum and `.replace('ontology.','').replace(/_/g,' ')`
								     is not a translation — it is English with the punctuation taken out, in a Dutch
								     UI. `c.targetId` is a row UUID for ten of the eleven ontology actions, sitting
								     where a reader expects a name. Both decisions now live in
								     $lib/i18n/ontology-action-label.ts, with the reasoning for omitting rather than
								     truncating or resolving the id. -->
								{#each recentChanges as c (c.id)}
									{@const target = ontologyTargetLabel(c.targetId)}
									<li>
										<!-- ⛔ `{c.actor.name}` USED TO PRINT THE LITERAL "System" HERE. Every other span on
										     this line is localized (`ontologyActionLabel`, `timeAgo`), so an unattributed
										     change read "System · Aangepaste entiteit aangemaakt · 2u geleden" to a Dutch
										     reader — one English word, manufactured server-side, in the slot the eye scans
										     for a name. The backend now ships `actor: null` for "no human wrote this" and
										     the word is chosen here. -->
										<span class="ch-actor">{c.actor ? c.actor.name : m.audit_actor_system()}</span>
										<span class="ch-action">{ontologyActionLabel(c.action)}</span>
										{#if target}<span class="ch-target" dir="ltr">{target}</span>{/if}
										<span class="ch-time">{timeAgo(c.createdAt)}</span>
									</li>
								{/each}
							</ul>
							<!-- ⛔ THE HIDING IS SAID OUT LOUD. Rows that resolve to ANOTHER workspace are
							     simply absent and that is correct scoping — they were never this reader's.
							     Rows that resolve to NO workspace are different: they might be this one's,
							     and dropping them without a word is exactly the "absent collapsed into
							     empty" this codebase keeps shipping. It drains toward zero as pre-fix
							     history ages out of the window.

							     ⚠️ AND THE COPY HAS TO NAME THE SCOPE, WHICH IS WHY IT IS TWO SENTENCES.
							     The count has NO tenant predicate and cannot have one — the defining
							     property of these rows is that no workspace can be derived for them (see
							     backend/src/ontology/ontology-changes.ts). Measured: five unattributable
							     rows written by another workspace raised this one's number by exactly 5.
							     This comment used to claim the number was "an upper bound and the copy
							     says so" while all eight catalogs said only "{n} changes … could not be
							     linked to a workspace and are not shown" — no hedge at all, a cross-tenant
							     volume figure rendered in the first person under a caption about the
							     reader's own workspace. The catalogs now state the platform scope and the
							     at-most reading; `ontology-changes-copy.test.ts` is what keeps them from
							     drifting back. Note the asymmetry the sentence has to survive: the list
							     above is this workspace's 8 most recent, the count is 30 days of every
							     workspace's. -->
							{#if changesUnattributed > 0}
								<p class="changes-note" data-testid="changes-unattributed">
									{m.ontology_recent_changes_unattributed({ count: changesUnattributed })}
								</p>
							{/if}
						</div>
					{/if}

					{#if canManage && ontology.hidden.length > 0}
						<div class="hidden-bar">
							<span class="hidden-label">{m.ontology_hidden_heading()}</span>
							{#each ontology.hidden as h (h.id)}
								<span class="hidden-chip">
									{h.label}
									<button class="hidden-unhide" onclick={() => unhideEntity(h.id)}>{m.ontology_unhide()}</button>
								</span>
							{/each}
						</div>
					{/if}
				{/if}
			</div>

			{#if selectedEntity}
				<aside class="detail">
					<header class="detail-head">
						<div>
							<div class="detail-name">
								{selectedEntity.label}
								{#if selectedEntity.tenantOwned}<span class="custom-tag">{m.ontology_custom()}</span>{/if}
							</div>
							<!-- `name` stays canonical — it is the agent-facing concept id ("BrokerNote"),
							     the same reason predicates and attribute names are never localized.
							     `scope` is not: it is a closed tri-state whose three words were already
							     in all eight catalogs for the add-entity form, and this panel was the
							     one place that printed the enum instead. -->
							<div class="detail-sub">{selectedEntity.name} · {ontologyScopeLabel(selectedEntity.scope)}</div>
						</div>
						<button class="icon-x" onclick={() => (selectedEntity = null)} aria-label={m.ontology_close()}>✕</button>
					</header>

					{#if canManage}
						<div class="detail-actions">
							{#if selectedEntity.tenantOwned}
								<button class="btn-sm" onclick={() => openEditEntity(selectedEntity!)}>{m.ontology_edit()}</button>
								<button class="btn-sm danger" onclick={() => deleteEntity(selectedEntity!)}>{m.ontology_delete()}</button>
							{:else}
								<button class="btn-sm" onclick={() => openOverride(selectedEntity!)}>{m.ontology_override()}</button>
								<button class="btn-sm danger" onclick={() => hideEntity(selectedEntity!)}>{m.ontology_hide()}</button>
							{/if}
						</div>
					{/if}

					{#if selectedEntity.description}
						<p class="detail-desc">{selectedEntity.description}</p>
					{/if}

					{#if selectedEntity.synonyms.length}
						<div class="detail-section">{m.ontology_synonyms()}</div>
						<div class="syn-list">
							{#each selectedEntity.synonyms as s (s)}<span class="syn">{s}</span>{/each}
						</div>
					{/if}

					<div class="detail-section">{m.ontology_attributes()}</div>
					<div class="attr-list">
						{#each selectedEntity.attributes as a (a.name)}
							<div class="attr-row">
								<span class="attr-name">{a.name}</span>
								<span class="attr-type">{datasetColumnTypeLabel(a.type)}</span>
								{#if a.pii}<span class="attr-pii">{m.ontology_pii()}</span>{/if}
							</div>
							{#if a.synonyms.length}
								<div class="attr-syn">{a.synonyms.join(', ')}</div>
							{/if}
						{/each}
						{#if selectedEntity.attributes.length === 0}<div class="attr-row empty">—</div>{/if}
					</div>

					{#if canManage}
						<div class="detail-section">{m.ontology_testdata()}</div>
						<p class="testdata-help">{m.ontology_testdata_help()}</p>
						{#if samplesError}<div class="notice error sm">{samplesError}</div>{/if}
						<div class="sample-list">
							{#each samples as s (s.id)}
								<div class="sample-row">
									<span class="sample-name">{s.datasetName}</span>
									<span class="sample-rows">{num(s.rowCount, locale.current)} {m.ontology_testdata_rows()}</span>
									{#if s.isPrimary}
										<span class="sample-primary">{m.ontology_testdata_primary()}</span>
									{:else}
										<button class="btn-sm" disabled={samplesBusy} onclick={() => makeSamplePrimary(s)}>
											{m.ontology_testdata_make_primary()}
										</button>
									{/if}
									<button
										class="sample-del"
										disabled={samplesBusy}
										onclick={() => unbindSample(s)}
										aria-label={m.ontology_testdata_remove()}>✕</button>
								</div>
							{/each}
							{#if samples.length === 0 && !samplesBusy}
								<div class="sample-row empty">{m.ontology_testdata_empty()}</div>
							{/if}
						</div>
						<!-- ⚠️ OUTSIDE the `bindableDatasets.length` test below, on purpose. The one state that
						     most needs this sentence is the one where the picker is ABSENT: a truncated walk
						     whose rows are all already bound renders no picker at all, and without this line
						     that is indistinguishable from "there is nothing left to bind". Names the real
						     total and points at the screen that can reach the rest. -->
						{#if datasetsCapped}
							<p class="sample-capped" role="status" data-testid="datasets-capped">
								{m.datasets_picker_capped({
									shown: num(allDatasets.length, locale.current),
									total: num(datasetsTotal, locale.current)
								})}
								<a href="/datasets">{m.nav_datasets()}</a>
							</p>
						{/if}
						{#if bindableDatasets.length}
							<div class="sample-add">
								<DatasetPicker
									datasets={bindableDatasets}
									selected={[]}
									placeholder={m.ontology_testdata_add()}
									emptyHint={m.ontology_testdata_none()}
									onchange={(slugs) => slugs[0] && bindSampleBySlug(slugs[0])}
								/>
							</div>
						{/if}

						<div class="derive-row">
							<!-- ⛔ THE `title` MOVED ONTO A WRAPPER. A DISABLED BUTTON FIRES NO POINTER EVENTS, so a
							     `title` on the button itself never surfaces — the one sentence saying why "Datablok
							     afleiden" is inert was unreachable by every reader, by every means. `VoteButton.svelte`
							     states the rule for this codebase; this site predated it.
							     ⚠️ AND ONLY THE SAMPLE GATE GETS A REASON. `deriveBusy` is transient and already visible
							     as the control being mid-flight; captioning it would put a standing explanation on a
							     state that lasts a second. -->
							<span class="gate-wrap" title={samples.length === 0 ? m.ontology_derive_block_no_sample() : undefined}>
								<button
									class="btn-sm derive-btn"
									disabled={deriveBusy || samples.length === 0}
									aria-disabled={deriveBusy || samples.length === 0}
									onclick={deriveBlock}>
									{m.ontology_derive_block()}
								</button>
							</span>
							<!-- The keyboard-reachable half: a tooltip is not announced reliably and cannot be reached
							     without a pointer, so the same sentence is on screen whenever the gate is closed. -->
							{#if samples.length === 0}
								<span class="derive-gate" data-testid="derive-gate">{m.ontology_derive_block_no_sample()}</span>
							{/if}
							{#if deriveMsg}
								<span class="derive-msg">{deriveMsg} · <a href="/blocks">{m.ontology_derive_block_view()}</a></span>
							{/if}
						</div>
					{/if}

					{#if ontology}
						{@const rels = ontology.relations.filter((r) => r.from === selectedEntity!.name || r.to === selectedEntity!.name)}
						{#if rels.length}
							<div class="detail-section">{m.ontology_relations()}</div>
							<div class="rel-list">
								{#each rels as r (`${r.from}.${r.predicate}.${r.to}`)}
									<div class="rel-row">
										<span class="rel-edge">
											{ontologyRelationEndLabel(r.from, relationEntities)} <span class="rel-pred">{ontologyRelationLabel(r)}</span> {ontologyRelationEndLabel(r.to, relationEntities)}
											{#if r.tenantOwned}<span class="custom-tag sm">{m.ontology_custom()}</span>{/if}
										</span>
										<span class="rel-meta">
											<!-- ⛔ THE THIRD CHIP ON A ROW WHOSE OTHER TWO WERE ALREADY LOCALIZED. The ends go
											     through `ontologyRelationEndLabel` and the predicate through
											     `ontologyRelationLabel`; this printed the column verbatim, so a Dutch reader
											     clicking an entity read "Schadeclaim ingediend onder Polis  many-to-one".
											     The `{#if}` stays: an empty cardinality is the ORDINARY value (the column is
											     `NOT NULL DEFAULT ''`), and the labeller must never be handed it. -->
											{#if r.cardinality}<span class="rel-card">{ontologyCardinalityLabel(r.cardinality)}</span>{/if}
											{#if canManage && r.tenantOwned}
												<button class="rel-del" onclick={() => deleteRelation(r.id)} aria-label={m.ontology_delete()}>✕</button>
											{/if}
										</span>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
				</aside>
			{/if}
		</div>
	{/if}
</div>

{#if editor}
	<div class="modal-overlay" role="presentation" onclick={() => (editor = null)} onkeydown={(e) => e.key === 'Escape' && (editor = null)}>
		<div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			<header class="modal-head">
				<h2>
					{editor.mode === 'edit'
						? m.ontology_edit_entity_title()
						: editor.mode === 'override'
							? m.ontology_override_entity_title()
							: m.ontology_add_entity_title()}
				</h2>
				<button class="icon-x" onclick={() => (editor = null)} aria-label={m.ontology_close()}>✕</button>
			</header>
			<div class="modal-body">
				{#if fromRequestNote && editor.mode === 'create'}<p class="from-request" data-testid="from-request">{m.requests_prefilled()}</p>{/if}
				<label class="field">
					<span>{m.ontology_field_name()}</span>
					<input bind:value={editor.name} disabled={editor.mode !== 'create'} placeholder="BrokerNote" />
				</label>
				<label class="field">
					<span>{m.ontology_field_label()}</span>
					<input bind:value={editor.label} placeholder={m.ontology_field_label_placeholder()} />
				</label>
				<label class="field">
					<span>{m.ontology_field_description()}</span>
					<textarea bind:value={editor.description} rows="2"></textarea>
				</label>
				<label class="field">
					<span>{m.ontology_field_synonyms()}</span>
					<input bind:value={editor.synonyms} placeholder="broker_memo, intermediary_note" />
				</label>

				<div class="field">
					<span class="attr-head">
						{m.ontology_attributes()}
						<button class="btn-sm" onclick={addAttrRow}>{m.ontology_add_attribute()}</button>
					</span>
					<div class="attr-form-list">
						{#each editor.attributes as a, i (i)}
							<div class="attr-form-row">
								<input class="a-name" bind:value={a.name} placeholder={m.ontology_field_name()} />
								<input class="a-type" bind:value={a.type} placeholder="string" />
								<label class="a-pii"><input type="checkbox" bind:checked={a.pii} />{m.ontology_pii()}</label>
								<button class="rel-del" onclick={() => removeAttrRow(i)} aria-label={m.ontology_delete()}>✕</button>
							</div>
						{/each}
						{#if editor.attributes.length === 0}<div class="attr-empty">—</div>{/if}
					</div>
				</div>

				{#if editor.mode === 'edit' && editor.id}
					<div class="field tx-block">
						<span class="attr-head">
							{m.ontology_translations()}
							<select class="tx-locale" bind:value={txLocale}>
								<!-- ⛔ THE READER'S NAME FOR THE LANGUAGE, NOT ITS TAG. This printed `nl / pl / fr / es /
							     de / ar / he` — BCP-47 codes — in a picker whose whole job is to ask an author which
							     LANGUAGE they are writing, on a screen that is otherwise fully localized. The topbar's
							     switcher two rows up already renders `LOCALE_LABELS[l]` for the same values, so one
							     screen offered "Nederlands" in one control and "nl" in another.
							     ⚠️ THE OPTION VALUE STAYS THE TAG. `txLocale` keys `translations[txLocale]` and goes on
							     the wire to `PUT …/translations`; only the TEXT is a word. And the index is total by
							     construction — every member of `TX_LOCALES` is a member of `LOCALES`, which is what
							     `LOCALE_LABELS` is keyed by — so there is no fallback branch to get wrong. -->
							{#each TX_LOCALES as loc (loc)}<option value={loc}>{LOCALE_LABELS[loc]}</option>{/each}
							</select>
						</span>
						<p class="tx-hint">{m.ontology_translations_hint()}</p>
						<!-- ⛔ THE FAILURE REPLACES THE FIELDS. Left beside them, two empty boxes over a
						     disabled Save read as "this entity has no Dutch translation yet" — the very
						     reading that made Save an erase. See `txLoaded`. -->
						{#if txLoadError}
							<p class="tx-error" role="alert" data-testid="tx-load-error">{txLoadError}</p>
						{:else if translations[txLocale]}
							<!-- ⚠️ INERT WHILE THE READ IS OUTSTANDING, not hidden. `translations` is repointed
							     at THIS entity before the await (see `txLoading`), so these are empty rather
							     than the previous entity's text — and an empty box the author can type into,
							     over a live Save, is the erase path again. -->
							<input
								class="tx-input"
								bind:value={translations[txLocale].label}
								placeholder={m.ontology_field_label()}
								disabled={txLoading}
							/>
							<textarea
								class="tx-input"
								rows="2"
								bind:value={translations[txLocale].description}
								placeholder={m.ontology_field_description()}
								disabled={txLoading}
							></textarea>
						{/if}
						{#if txLoading}
							<p class="tx-hint" data-testid="tx-loading">{m.ontology_translations_loading()}</p>
						{/if}
						<div class="tx-actions">
							<button
								class="btn-sm"
								onclick={saveTranslation}
								disabled={txSaving || txLoading || !txLoaded}
							>
								{m.ontology_save_translation()}
							</button>
							{#if txMsg}<span class="tx-msg">{txMsg}</span>{/if}
						</div>
					</div>
				{/if}

				{#if saveError}<div class="notice error">{saveError}</div>{/if}
			</div>
			<footer class="modal-foot">
				<button class="btn ghost" onclick={() => (editor = null)}>{m.ontology_cancel()}</button>
				<button class="btn primary" onclick={saveEntity} disabled={saving}>{m.ontology_save()}</button>
			</footer>
		</div>
	</div>
{/if}

{#if relEditor && ontology}
	<div class="modal-overlay" role="presentation" onclick={() => (relEditor = null)} onkeydown={(e) => e.key === 'Escape' && (relEditor = null)}>
		<div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
			<header class="modal-head">
				<h2>{m.ontology_add_relation_title()}</h2>
				<button class="icon-x" onclick={() => (relEditor = null)} aria-label={m.ontology_close()}>✕</button>
			</header>
			<div class="modal-body">
				<label class="field">
					<span>{m.ontology_field_from()}</span>
					<select bind:value={relEditor.fromEntityId}>
						{#each ontology.entities as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
					</select>
				</label>
				<label class="field">
					<span>{m.ontology_field_predicate()}</span>
					<input bind:value={relEditor.predicate} placeholder="annotates" />
				</label>
				<label class="field">
					<span>{m.ontology_field_to()}</span>
					<select bind:value={relEditor.toEntityId}>
						{#each ontology.entities as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
					</select>
				</label>
				<label class="field">
					<span>{m.ontology_field_cardinality()}</span>
					<input bind:value={relEditor.cardinality} placeholder="many-to-one" />
				</label>
				{#if saveError}<div class="notice error">{saveError}</div>{/if}
			</div>
			<footer class="modal-foot">
				<button class="btn ghost" onclick={() => (relEditor = null)}>{m.ontology_cancel()}</button>
				<button class="btn primary" onclick={saveRelation} disabled={saving}>{m.ontology_save()}</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.from-request {
		margin: 0 0 10px;
		font-size: 12.5px;
		color: var(--c-teal-dark);
	}
	.page {
		max-width: 1280px;
	}
	.page-head {
		margin-bottom: 18px;
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
		max-width: 680px;
	}
	.selectors {
		display: flex;
		flex-wrap: wrap;
		gap: 18px 32px;
		margin-bottom: 16px;
	}
	.selector-label {
		display: block;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		margin-bottom: 8px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 6px 12px;
		border-radius: 999px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.chip:hover {
		border-color: var(--c-teal);
	}
	.chip.active {
		background: var(--c-teal);
		border-color: var(--c-teal);
		color: #fff;
	}
	.spec-dot {
		font-size: 7px;
		color: var(--c-amber, #f59e0b);
		line-height: 1;
	}
	.chip.active .spec-dot {
		color: #fff;
	}
	.graph-area {
		display: flex;
		gap: 16px;
		align-items: stretch;
	}
	.graph-col {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.graph-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
		font-size: 12.5px;
	}
	.meta-cell {
		font-weight: 600;
		color: var(--c-midnight);
	}
	.meta-count {
		color: var(--c-muted);
		font-size: 12px;
	}
	.graph-frame {
		height: 68vh;
		min-height: 420px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		overflow: hidden;
		transition: opacity 0.12s;
	}
	.graph-frame.dim {
		opacity: 0.6;
	}
	.graph-hint {
		font-size: 12px;
		color: var(--c-faint);
		margin: 8px 2px 0;
	}
	.changes {
		margin-top: 16px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 12px 14px;
	}
	.changes-head {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
		color: var(--c-muted);
		margin-bottom: 8px;
	}
	.changes-error {
		font-size: 12.5px;
		color: var(--c-coral-dark);
		margin: 0;
		line-height: 1.5;
	}
	/* The "some rows are not shown" disclosure. Muted, not coral: nothing is BROKEN — the panel is
	   telling the reader the truth about its own completeness. */
	.changes-note {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 8px 0 0;
		line-height: 1.5;
	}
	.changes ul:empty + .changes-note {
		margin-top: 0;
	}
	.changes ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.changes li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--c-ink);
	}
	.ch-actor {
		font-weight: 600;
	}
	.ch-action {
		color: var(--c-muted);
	}
	.ch-target {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ch-time {
		margin-inline-start: auto;
		font-size: 11px;
		color: var(--c-faint);
		white-space: nowrap;
	}
	.detail {
		width: 320px;
		flex-shrink: 0;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 16px;
		align-self: flex-start;
		max-height: calc(68vh + 26px);
		overflow-y: auto;
	}
	.detail-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}
	.detail-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.detail-sub {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-faint);
		margin-top: 2px;
	}
	.icon-x {
		background: none;
		border: none;
		font-size: 15px;
		color: var(--c-muted);
		cursor: pointer;
		line-height: 1;
	}
	.detail-desc {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0 0 12px;
		line-height: 1.5;
	}
	.detail-section {
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
		margin: 14px 0 6px;
	}
	.syn-list {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.syn {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-ink);
		background: var(--c-surface);
		padding: 2px 7px;
		border-radius: 999px;
	}
	.attr-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.attr-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 11.5px;
	}
	.attr-name {
		color: var(--c-ink);
	}
	.attr-type {
		color: var(--c-faint);
		margin-inline-start: auto;
	}
	.attr-pii {
		font-family: var(--font-sans);
		font-size: 8.5px;
		font-weight: 700;
		color: var(--c-coral-dark);
		background: var(--c-coral-light);
		padding: 0 4px;
		border-radius: 4px;
	}
	.attr-syn {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--c-faint);
		margin: 0 0 4px 0;
	}
	.attr-row.empty {
		color: var(--c-faint);
	}
	/* ---- test-data bindings (ontology-data-blocks Phase 1) ---- */
	.testdata-help {
		font-size: 11px;
		color: var(--c-faint);
		margin: 0 0 8px 0;
	}
	.sample-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.sample-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
	}
	.sample-name {
		color: var(--c-ink);
		font-weight: 500;
	}
	.sample-rows {
		color: var(--c-faint);
		font-family: var(--font-mono);
		font-size: 10.5px;
		margin-inline-start: auto;
	}
	.sample-primary {
		font-size: 8.5px;
		font-weight: 700;
		color: var(--c-teal-dark, var(--c-teal-mid));
		background: var(--c-teal-light, rgba(0, 0, 0, 0.05));
		padding: 0 5px;
		border-radius: 4px;
	}
	.sample-del {
		color: var(--c-faint);
		font-size: 12px;
		line-height: 1;
		padding: 2px 4px;
	}
	.sample-del:hover:not(:disabled) {
		color: var(--c-coral-dark);
	}
	.sample-row.empty {
		color: var(--c-faint);
	}
	.sample-add {
		margin-top: 8px;
	}
	/* The "the picker does not list all of them" disclosure. Muted, not coral: nothing is BROKEN —
	   the panel is telling the reader the truth about its own completeness. Same tone as
	   `.changes-note` above and as /solutions' `.notice.capped`. */
	.sample-capped {
		font-size: 11px;
		color: var(--c-muted);
		margin: 8px 0 0;
		line-height: 1.5;
	}
	.sample-capped a {
		margin-inline-start: 4px;
	}
	.derive-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.derive-msg {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.notice.error.sm {
		font-size: 11px;
		padding: 4px 8px;
		margin: 0 0 6px 0;
	}
	.rel-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rel-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.rel-edge {
		font-size: 11.5px;
		color: var(--c-ink);
	}
	.rel-pred {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--c-teal-dark);
		padding: 0 3px;
	}
	.rel-card {
		font-size: 10px;
		color: var(--c-faint);
	}
	.notice {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 14px 16px;
		font-size: 13px;
		color: var(--c-muted);
	}
	.notice.subtle {
		border: none;
		background: transparent;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
	}
	.notice.error {
		color: var(--c-coral-dark);
		border-color: var(--c-coral);
	}
	/* The load-failure notice's retry control — see the button in the `{:else if error}` arm above.
	   Same tones as the profile-error row in +layout.svelte, which is where this shape comes from. */
	.notice.error .retry {
		margin-inline-start: 10px;
		border: 1px solid var(--c-coral-light);
		background: var(--c-white);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
	}
	.badge.amber {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #92400e;
		background: var(--c-amber-light, #fef3c7);
		padding: 2px 8px;
		border-radius: 999px;
	}
	@media (max-width: 920px) {
		.graph-area {
			flex-direction: column;
		}
		.detail {
			width: auto;
			max-height: none;
		}
	}

	/* ---- 3.5 authoring UI ---- */
	.manage-tools {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-inline-start: auto;
	}
	.btn-sm {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-light);
		border: 1px solid transparent;
		padding: 4px 10px;
		border-radius: 999px;
		cursor: pointer;
	}
	.btn-sm:hover {
		border-color: var(--c-teal);
	}
	.btn-sm:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-sm.danger {
		color: var(--c-coral-dark);
		background: var(--c-coral-light);
	}
	.detail-actions {
		display: flex;
		gap: 6px;
		margin-bottom: 10px;
	}

	/* ---- 3.7 hidden bar + translations editor ---- */
	.hidden-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		padding: 8px 10px;
		background: var(--c-surface);
		border: 1px dashed var(--c-border);
		border-radius: var(--r);
	}
	.hidden-label {
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
	}
	.hidden-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--c-faint);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		padding: 2px 4px 2px 9px;
		border-radius: 999px;
	}
	.hidden-unhide {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-teal-light);
		border: none;
		padding: 2px 8px;
		border-radius: 999px;
		cursor: pointer;
	}
	.tx-block {
		border-top: 1px solid var(--c-border);
		padding-top: 12px;
	}
	.tx-locale {
		font-size: 12px;
		padding: 3px 6px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-white);
		color: var(--c-ink);
	}
	.tx-hint {
		font-size: 11px;
		color: var(--c-faint);
		margin: 0 0 8px;
	}
	.tx-input {
		font-size: 13px;
		padding: 7px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		font-family: inherit;
		color: var(--c-ink);
		background: var(--c-white);
		margin-bottom: 6px;
		width: 100%;
		box-sizing: border-box;
	}
	.tx-error {
		font-size: 12px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
		padding: 8px 10px;
		margin: 0 0 8px;
	}
	.tx-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.tx-msg {
		font-size: 11.5px;
		color: var(--c-teal-dark);
		font-weight: 600;
	}
	.custom-tag {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		font-weight: 700;
		color: #5b21b6;
		background: var(--c-violet-light, #ede9fe);
		padding: 1px 6px;
		border-radius: 999px;
		vertical-align: middle;
	}
	.custom-tag.sm {
		font-size: 8px;
		padding: 0 4px;
	}
	.rel-meta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.rel-del {
		background: none;
		border: none;
		color: var(--c-coral-dark);
		cursor: pointer;
		font-size: 11px;
		line-height: 1;
		padding: 0 2px;
	}
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		z-index: 50;
	}
	.modal {
		background: var(--c-white);
		border-radius: var(--r-lg);
		width: 460px;
		max-width: 100%;
		max-height: 88vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 60px rgba(15, 23, 42, 0.3);
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 18px;
		border-bottom: 1px solid var(--c-border);
	}
	.modal-head h2 {
		font-size: 15px;
		margin: 0;
		color: var(--c-midnight);
	}
	.modal-body {
		padding: 16px 18px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field > span {
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--c-muted);
		font-weight: 600;
	}
	.field input,
	.field textarea,
	.field select {
		font-size: 13px;
		padding: 7px 9px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		font-family: inherit;
		color: var(--c-ink);
		background: var(--c-white);
	}
	.field input:disabled {
		background: var(--c-surface);
		color: var(--c-faint);
	}
	.attr-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.attr-form-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.attr-form-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.attr-form-row .a-name {
		flex: 1;
	}
	.attr-form-row .a-type {
		width: 90px;
	}
	.attr-form-row .a-pii {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		color: var(--c-muted);
		white-space: nowrap;
	}
	.attr-empty {
		color: var(--c-faint);
		font-size: 12px;
	}
	.modal-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 14px 18px;
		border-top: 1px solid var(--c-border);
	}
	.btn {
		font-size: 13px;
		font-weight: 600;
		padding: 8px 16px;
		border-radius: var(--r);
		cursor: pointer;
		border: 1px solid transparent;
	}
	.btn.ghost {
		background: var(--c-white);
		border-color: var(--c-border);
		color: var(--c-ink);
	}
	.btn.primary {
		background: var(--c-teal);
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	/* Holds the `title` a disabled button cannot fire; `display: contents` leaves the row's layout
	   untouched. `.derive-gate` is the same sentence, on screen, for readers with no pointer. */
	.gate-wrap {
		display: contents;
	}
	.derive-gate {
		font-size: 11.5px;
		color: var(--c-faint);
	}
</style>
