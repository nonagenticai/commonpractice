<script lang="ts">
	// Block editor / designer — the `block-edit` screen (demo.html:3693–3890).
	// Keyed by ?slug=. No slug → create-new form. Drafts are editable; published
	// versions are read-only (view via the version-history sidebar).
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { blocksApi, ApiError } from '$lib/api/blocks';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { templatesApi } from '$lib/api/templates';
	import { toTemplateBody } from '$lib/blocks/save-as-template';
	import { toRows, fromRows, type FieldRow } from '$lib/blocks/descriptor-rows';
	import { ontologyApi } from '$lib/api/ontology';
	import { auth } from '$lib/stores/auth.svelte';
	import { canReachNav } from '$lib/layout/navConfig';
	import type { MatrixData, OntologyEntity } from '$lib/types/ontology';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import BlockTesting from '$lib/components/block-edit/BlockTesting.svelte';
	import BlockSimulate from '$lib/components/block-edit/BlockSimulate.svelte';
	import BlockUsageTrend from '$lib/components/block-edit/BlockUsageTrend.svelte';
	import EntityDeriveBrowser from '$lib/components/build/EntityDeriveBrowser.svelte';
	import TemplateGallery from '$lib/components/build/TemplateGallery.svelte';
	import ExistingBlockPicker from '$lib/components/build/ExistingBlockPicker.svelte';
	import BlockAuthorAssistant from '$lib/components/build/BlockAuthorAssistant.svelte';
	import BlockFixAssistant from '$lib/components/block-edit/BlockFixAssistant.svelte';
	import type { BlockDraftProposal } from '$lib/agent/block-author-driver';
	import type { BlockFixContext } from '$lib/agent/block-fix-driver';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import type { TemplateDetail } from '$lib/types/templates';
	import {
		CATEGORY_META,
		categoryLabel,
		type BlockCategory,
		type BlockDetail,
		type BlockVersion,
		type FieldType,
		type LintFinding
	} from '$lib/types/blocks';
	import * as m from '$lib/paraglide/messages';
	import { industryLabel, departmentLabel } from '$lib/i18n/ontology-axis-label';
	// ⛔ THE SAME HELPER THE CANVAS USES, NOT A SECOND VOCABULARY. The I/O editor's type
	// `<select>` printed `{ft}` raw — "string[]", "json" — while /build's port badges and this
	// page's own Simulate/Testing panes (BlockSimulate.svelte, BlockTesting.svelte) render
	// `fieldTypeLabel(spec.type)` for the identical values. One block, two names per type,
	// depending which pane you were looking at. See $lib/i18n/field-type-label.ts.
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';
	// The scanner's English `message` is the FALLBACK, not the render — see the module header.
	import { scanFindingLabel } from '$lib/i18n/scan-finding-label';
	// `cost_class` is a bare `text` column seeded `low`/`medium` on every block — the one value in
	// the Details list that is an enum rather than a name. See $lib/i18n/block-cost-label.ts.
	import { costClassLabel } from '$lib/i18n/block-cost-label';
	import { num, fullDate } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';

	// Maps the TABS logic keys to their localized display labels.
	const TAB_LABEL_KEYS: Record<string, string> = {
		Documentation: 'blockedit_tab_documentation',
		Implementation: 'blockedit_tab_implementation',
		Testing: 'blockedit_tab_testing',
		Simulate: 'blockedit_tab_simulate',
		Examples: 'blockedit_tab_examples',
		'Permissions & data': 'blockedit_tab_permissions',
		'Usage stats': 'blockedit_tab_usage'
	};
	// Maps a version status enum to its localized display label.
	const STATUS_LABEL_KEYS: Record<string, string> = {
		draft: 'blockedit_status_draft',
		stable: 'blockedit_status_stable',
		beta: 'blockedit_status_beta'
	};
	const mr = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'json', 'string[]', 'enum', 'dataset'];
	const CATEGORIES: BlockCategory[] = ['data', 'ai', 'logic', 'output', 'ui'];
	const TABS = ['Documentation', 'Implementation', 'Testing', 'Simulate', 'Examples', 'Permissions & data', 'Usage stats'] as const;
	type Tab = (typeof TABS)[number];

	const slug = $derived(page.url.searchParams.get('slug'));

	let detail = $state<BlockDetail | null>(null);
	let selectedVersionId = $state<string | null>(null);
	let activeTab = $state<Tab>('Documentation');
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	// Save/publish status
	let saving = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let findings = $state<LintFinding[]>([]);
	// Live type-check / lint of the unsaved editor buffer (Implementation tab).
	let lintFindings = $state<LintFinding[]>([]);
	let linting = $state(false);
	/**
	 * ⛔ WHETHER THE ANSWER ON SCREEN WAS EARNED. `lintFindings.length === 0` is TWO states wearing
	 * one face: "the type-checker ran and found nothing" and "the type-checker never ran". The badge
	 * used to read the array alone and paint the second one teal — `blockedit_lint_clean`, on a
	 * buffer nothing had checked. Three ways in, all ordinary:
	 *   · the POST failed. `backend/src/blocks/lint.ts` shells out to the real `tsc`, so a 5xx (or a
	 *     dropped connection) is a normal outcome, and `runLint`'s catch swallowed it silently;
	 *   · the reader cannot author. The debounce `$effect` below is gated on `editable`, so on a
	 *     PUBLISHED version — or for anyone the API would refuse — the lint never runs at all;
	 *   · the 700 ms debounce. Every re-arm of the timer leaves the previous answer describing a
	 *     buffer that has already moved on.
	 *
	 * ⚠️ IT IS A FALSE ASSURANCE, NOT A SECURITY HOLE, and the fix is sized to that. Publish re-lints
	 * server-side (`backend/src/routes/blocks.ts:599`) and refuses `lint_failed`, so no unchecked
	 * source ships past a green badge; what shipped was an author's belief that the editor had
	 * checked their code. Hence a display state, not a gate.
	 *
	 * `'idle'` = not checked (yet, or not by this screen) → NEUTRAL. `'error'` = we asked and could
	 * not get an answer → shown only to someone who can do something about it (see the badge markup;
	 * a reader never reaches `'error'` because the lint never fires for them).
	 */
	let lintState = $state<'idle' | 'ok' | 'error'>('idle');
	let lintTimer: ReturnType<typeof setTimeout> | undefined;
	// CodeEditor instance — so a lint finding can scroll the editor to its line.
	let editorRef = $state<ReturnType<typeof CodeEditor>>();
	// Local mirror of the selected version's tests_passing (updated after a test run).
	let testsPassingOverride = $state<boolean | null>(null);
	// Bumped to force the Testing tab to reload (e.g. after the publish gate ran tests).
	let testReloadSignal = $state(0);

	// ---- editable form (rebuilt when a version is selected) ----
	// FieldRow / toRows / fromRows: $lib/blocks/descriptor-rows (unit-tested save round-trip).
	let docsMd = $state('');
	let sourceTs = $state('');
	/**
	 * ⛔ EVERY CAPABILITY BIT MUST APPEAR HERE. `buildDescriptor()` rebuilds `capabilities` from THIS
	 * object alone, so any key missing here is SILENTLY DROPPED the next time anyone saves — a block
	 * that may read the tenant's datasets would come back from the editor unable to call
	 * `ctx.dataset` at all.
	 *
	 * ⛔ `dataset` IS NOW ALSO AUTHORABLE (Permissions & data), AND IT HAD TO BECOME SO. It was
	 * round-tripped but hidden, on the reasoning that the two bits "are not peers to an author" —
	 * which is true of what they MEAN and false of what an author has to do. `mockData` is a claim
	 * about the output (and the only bit the "Simulated" badge reads); `dataset` is an access grant.
	 * With no control for the grant, the sole reachable way to author a new `ctx.dataset()` block was
	 * to tick `mockData` — re-creating the exact overload the split removed and re-earning the false
	 * badge. Hiding the bit did not prevent the swap; it FORCED it. The separation is now carried by
	 * the two toggles' copy (`blockedit_cap_dataset{,_sub}` vs `blockedit_cap_mock{,_sub}`), which is
	 * where a distinction an author must act on belongs.
	 */
	let caps = $state({ network: false, llm: false, mockData: false, dataset: false });
	let inputs = $state<FieldRow[]>([]);
	let outputs = $state<FieldRow[]>([]);
	let examplesText = $state('[]');

	const selected = $derived(
		detail?.versions.find((v) => v.id === selectedVersionId) ?? null
	);
	const isDraft = $derived(selected?.status === 'draft');
	/**
	 * ⛔ THE DEFECT: this screen had NO role gate at all. `editable` was `!slug || isDraft` —
	 * DRAFT STATE, not permission — so a plain member who typed the URL (or clicked a card in
	 * /blocks, which navigates here) got the whole authoring surface: name/slug inputs, a live code
	 * editor, capability toggles, I/O rows, Create / New draft / Save draft / Publish. Every one of
	 * them 403s: `POST /api/blocks` is `requireBlockAuthor` (routes/blocks.ts:561) and every
	 * per-block write goes through `authorizeBlockWrite` (:258).
	 *
	 * `canAuthor` mirrors that guard EXACTLY, and deliberately in two halves, because the backend's
	 * is in two halves:
	 *  • an existing block → `authorizeBlockWrite`: a GLOBAL (platform) block is super_admin-only,
	 *    a tenant block is a developer's. That is the expression `canDelete` already carried; it is
	 *    now shared rather than duplicated, since delete is just one of these writes.
	 *  • create-new (no block loaded yet) → `requireBlockAuthor` == `isDeveloper`, which is the same
	 *    fact the nav table states about this href (navConfig.ts:130). Read it from `canReachNav`
	 *    rather than spelling the role again — see that function's docstring.
	 *
	 * ⚠️ NOT a whole-page denial. `GET /api/blocks/:slug` is bare `validateAuth` (:412): the backend
	 * deliberately lets any authenticated user READ a block, and /blocks is the catalog that links
	 * here. Refusing the page would take away a read the server grants. What the member loses is
	 * only the controls the server would refuse.
	 */
	const canAuthor = $derived(
		detail
			? detail.owner === 'global'
				? auth.isSuperAdmin
				: auth.isDeveloper
			: canReachNav('/block-edit', auth.user?.roles ?? [])
	);
	// A brand-new (unsaved) block is editable; an existing block only while a draft — and, either
	// way, only for someone the server would let write.
	const editable = $derived(canAuthor && (!slug || isDraft));
	// Phase 4: the AI-fix loop applies to an existing, editable DRAFT (it patches source_ts).
	// (!!slug == "not a brand-new block" == the template's isNew negated.)
	const canFix = $derived(canAuthor && !!slug && isDraft && !!detail && !!selected);
	// The active "Fix with AI" session context (lint finding / failed test / simulate error).
	let fixContext = $state<BlockFixContext | null>(null);

	function openFix(ctx: BlockFixContext) {
		if (!canFix) return;
		fixContext = ctx;
		activeTab = 'Implementation';
	}
	// Apply the agent's reviewed patch into the editor buffer (developer still Saves the draft).
	function applyFix(src: string) {
		sourceTs = src;
	}

	// ---- delete (platform-block cleanup path) ----
	// A global/platform block is super_admin-only; a tenant block is for a developer/admin of that
	// tenant (the server enforces both — this gate is UX only). Without this, NULL-tenant global
	// blocks have no in-app delete path (RLS covers only the tenant case). Delete goes through the
	// same `authorizeBlockWrite` as every other write here, so it reads the same `canAuthor`.
	let confirmDelete = $state(false);
	let deleting = $state(false);
	const canDelete = $derived(!!detail && canAuthor);

	async function deleteBlock() {
		if (!detail) return;
		deleting = true;
		banner = null;
		try {
			await blocksApi.remove(detail.slug);
			void goto('/blocks');
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_delete_failed()) };
			deleting = false;
			confirmDelete = false;
		}
	}

	// ---- create-new mode (single-page: identity is authored inline alongside docs/code/I/O) ----
	const DEFAULT_SOURCE =
		'export default {\n  descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },\n  async run(inputs, ctx) {\n    return {};\n  }\n};\n';
	// Tabs available before the block is persisted (Testing/Examples/Usage need a saved version).
	const NEW_TABS: readonly Tab[] = ['Documentation', 'Implementation', 'Permissions & data'];
	// Simulate is a WRITE tab end to end — `POST …/simulate` and the "Save as test" it offers are
	// both `authorizeBlockWrite` (routes/blocks.ts:935, :725) — so for a reader who cannot author it
	// is a tab whose every control 403s. The others render read-only and stay. Drops the selection
	// back to Documentation if the tab disappears under it (a role can change mid-session).
	const visibleTabs: readonly Tab[] = $derived(
		canAuthor ? TABS : TABS.filter((t) => t !== 'Simulate')
	);
	$effect(() => {
		if (!visibleTabs.includes(activeTab)) activeTab = 'Documentation';
	});
	let createForm = $state({ slug: '', name: '', description: '', category: 'logic' as BlockCategory });
	let creating = $state(false);
	// 'blank' = author from scratch · 'entity' = derive a typed data block from an ontology entity
	// (data only) · 'template' = start from a seeded starter template (any category) · 'existing' =
	// fork an existing block as a scaffold (Phase 5C) · 'assistant' = describe the block and let the
	// AI copilot draft it (grounded in ontology + test data).
	let startMode = $state<'blank' | 'entity' | 'template' | 'existing' | 'assistant'>('blank');
	// The slug auto-derives from the name until the user edits it directly.
	let slugTouched = $state(false);

	function slugify(s: string): string {
		return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
	}
	function onNameInput() {
		if (!slugTouched) createForm.slug = slugify(createForm.name);
	}
	// Reset the inline authoring buffers when entering create mode (slug → null).
	function resetNewBlock() {
		createForm = { slug: '', name: '', description: '', category: 'logic' };
		slugTouched = false;
		startMode = 'blank';
		docsMd = '';
		sourceTs = DEFAULT_SOURCE;
		caps = { network: false, llm: false, mockData: false, dataset: false };
		inputs = [];
		outputs = [];
		examplesText = '[]';
		activeTab = 'Documentation';
		ontoIndustry = '';
		ontoDept = '';
		ontoEntities = [];
		ontoEntityId = '';
		banner = null;
	}

	// Apply a picked starter template (startMode='template'): pre-fill the create buffers from the
	// template's scaffold, then drop the author into the normal editor tabs to customize + create.
	function applyTemplate(t: TemplateDetail) {
		if (!createForm.name.trim()) createForm.name = t.label;
		createForm.description = t.description;
		createForm.category = t.category;
		if (!slugTouched) createForm.slug = slugify(createForm.name);
		docsMd = t.docs_md;
		sourceTs = t.source_ts || DEFAULT_SOURCE;
		caps = {
			network: t.descriptor.capabilities.network ?? false,
			llm: t.descriptor.capabilities.llm ?? false,
			mockData: t.descriptor.capabilities.mockData ?? false,
			dataset: t.descriptor.capabilities.dataset ?? false
		};
		inputs = toRows(t.descriptor.inputs);
		outputs = toRows(t.descriptor.outputs);
		examplesText = '[]';
		startMode = 'blank';
		activeTab = 'Implementation';
		banner = { kind: 'ok', text: m.blockedit_template_applied({ name: t.label }) };
	}

	// Phase 5C — fork an existing block (startMode='existing'): prefill the create buffers from the
	// block's current (or latest) version, renamed with a " (copy)" suffix so the slug/name don't
	// collide, then drop into the normal editor tabs to modify + create a new block.
	function applyExistingBlock(b: BlockDetail) {
		const v = b.versions.find((x) => x.id === b.current_version_id) ?? b.versions[0];
		if (!v) {
			banner = { kind: 'error', text: m.blockedit_existing_none() };
			return;
		}
		createForm.name = `${b.name} (copy)`;
		createForm.description = b.description;
		createForm.category = b.category;
		createForm.slug = slugify(createForm.name);
		slugTouched = false;
		docsMd = v.docs_md;
		sourceTs = v.source_ts || DEFAULT_SOURCE;
		caps = {
			network: v.descriptor.capabilities.network ?? false,
			llm: v.descriptor.capabilities.llm ?? false,
			mockData: v.descriptor.capabilities.mockData ?? false,
			dataset: v.descriptor.capabilities.dataset ?? false
		};
		inputs = toRows(v.descriptor.inputs);
		outputs = toRows(v.descriptor.outputs);
		examplesText = '[]';
		startMode = 'blank';
		activeTab = 'Implementation';
		banner = { kind: 'ok', text: m.blockedit_existing_applied({ name: b.name }) };
	}

	// Apply an AI-proposed draft (startMode='assistant'): the copilot calls propose_block_draft and
	// the BlockAuthorDriver routes it here. Same prefill contract as applyTemplate — fill the create
	// buffers, then leave the chat visible so the developer can keep refining before they Create.
	function applyProposal(d: BlockDraftProposal) {
		if (d.name?.trim()) {
			createForm.name = d.name.trim();
			if (!slugTouched) createForm.slug = slugify(createForm.name);
		}
		if (d.slug?.trim()) {
			createForm.slug = slugify(d.slug);
			slugTouched = true;
		}
		if (d.category) createForm.category = d.category;
		if (d.description !== undefined) createForm.description = d.description;
		if (d.docs_md !== undefined) docsMd = d.docs_md;
		if (d.source_ts !== undefined) sourceTs = d.source_ts || DEFAULT_SOURCE;
		if (d.descriptor) {
			caps = {
				network: d.descriptor.capabilities?.network ?? false,
				llm: d.descriptor.capabilities?.llm ?? false,
				mockData: d.descriptor.capabilities?.mockData ?? false,
				dataset: d.descriptor.capabilities?.dataset ?? false
			};
			inputs = toRows(d.descriptor.inputs ?? {});
			outputs = toRows(d.descriptor.outputs ?? {});
		}
		if (Array.isArray(d.examples)) examplesText = JSON.stringify(d.examples, null, 2);
		banner = { kind: 'ok', text: m.blockauthor_draft_ready() };
	}

	// Guard: the ontology path is data-only — leaving the data category drops back to blank.
	$effect(() => {
		if (!slug && startMode === 'entity' && createForm.category !== 'data') startMode = 'blank';
	});

	function selectVersion(v: BlockVersion) {
		selectedVersionId = v.id;
		docsMd = v.docs_md;
		sourceTs = v.source_ts;
		caps = {
			network: v.descriptor.capabilities.network ?? false,
			llm: v.descriptor.capabilities.llm ?? false,
			mockData: v.descriptor.capabilities.mockData ?? false,
			dataset: v.descriptor.capabilities.dataset ?? false
		};
		inputs = toRows(v.descriptor.inputs);
		outputs = toRows(v.descriptor.outputs);
		examplesText = JSON.stringify(v.examples ?? [], null, 2);
		findings = [];
		lintFindings = [];
		// The buffer just became another version's source. Whatever the last lint said, it said it
		// about the OLD text — and on a published version nothing will re-check this one.
		lintState = 'idle';
		testsPassingOverride = null;
		banner = null;
	}

	async function runLint() {
		if (!detail || !selected) return;
		linting = true;
		try {
			const res = await blocksApi.lint(detail.slug, selected.version, sourceTs);
			lintFindings = res.findings;
			lintState = 'ok';
		} catch {
			// The lint is advisory, so the failure is not escalated — but it is not hidden either.
			// Keeping the previous `lintFindings` would leave findings (or an empty list read as
			// "clean") attributed to an answer we never got.
			lintFindings = [];
			lintState = 'error';
		} finally {
			linting = false;
		}
	}

	// Debounced live lint of the editor buffer while editing a draft's Implementation.
	// `editable`, not `isDraft`: `POST …/lint` is `authorizeBlockWrite` (routes/blocks.ts:922), so
	// for a reader who cannot author, this timer only ever produced a 403 the catch above swallows.
	$effect(() => {
		const src = sourceTs;
		if (!editable || activeTab !== 'Implementation') return;
		if (lintTimer) clearTimeout(lintTimer);
		// ⛔ THE DEBOUNCE WINDOW IS PART OF THE CLAIM. From here until `runLint` answers, the badge
		// would otherwise still be showing the verdict on the PREVIOUS buffer. Neutral, not teal.
		lintState = 'idle';
		lintTimer = setTimeout(runLint, 700);
		return () => {
			if (lintTimer) clearTimeout(lintTimer);
		};
		void src;
	});

	const testsPassing = $derived(testsPassingOverride ?? selected?.tests_passing ?? false);

	async function loadDetail(s: string) {
		loading = true;
		loadError = null;
		try {
			const d = await blocksApi.get(s);
			detail = d;
			// Prefer a draft, else the current/published version, else newest.
			const draft = d.versions.find((v) => v.status === 'draft');
			const current = d.versions.find((v) => v.id === d.current_version_id);
			selectVersion(draft ?? current ?? d.versions[0]!);
		} catch (e) {
			loadError = errorText(e, m.error_load_failed());
			detail = null;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const s = slug;
		if (s) loadDetail(s);
		else {
			detail = null;
			resetNewBlock();
		}
	});

	/**
	 * ⛔ THE LOCALE SWITCH RE-FETCHES THE DISPLAY METADATA ONLY — IT MUST NEVER CALL `loadDetail`.
	 *
	 * `GET /api/blocks/:slug` localizes `name`, `description` and the CURRENT version's `docs_md`
	 * server-side off `Accept-Language` (routes/blocks.ts:441-550), and the effect above tracks
	 * `slug` and nothing else, so before this the `<h1>` stayed in whichever language the page was
	 * opened in while every `m.*()` label around it switched. Every other page in this app fixes that
	 * with the one-liner `reloadOnLocaleChange(load)`.
	 *
	 * ⛔ THAT ONE-LINER IS A DATA-LOSS BUG HERE, and it is why this is a bespoke function instead.
	 * `loadDetail` ends in `selectVersion()`, whose whole job is to OVERWRITE the editor buffers:
	 * `docsMd`, `sourceTs`, `caps`, `inputs`, `outputs`, `examplesText` — plus `findings`,
	 * `lintFindings`, `lintState`, `testsPassingOverride` and `banner`. An author half-way through a
	 * draft who reached for the language switcher would have had their unsaved work silently replaced
	 * by the server's copy. There is no autosave and no undo on this screen: the draft is simply gone.
	 * Relocalizing a heading is not worth a lost draft, so only `name`/`description` are re-applied
	 * and every editable buffer is left exactly as the author left it.
	 *
	 * `docs_md` is the one localized field that is ALSO an editable buffer, so it gets a guard rather
	 * than a rule: it is re-applied only when `!editable`, which is precisely the state in which
	 * `MarkdownEditor` is `readonly={!editable}` and the buffer therefore provably holds no
	 * keystrokes of the reader's. (Selecting a published version from the history sidebar already
	 * discards the draft buffer through `selectVersion`, so "not editable" really does mean "nothing
	 * unsaved here".) `category` needs nothing: `categoryLabel()` is a Paraglide message and is
	 * already reactive.
	 *
	 * Pinned by block-edit.locale-refetch.render.test.ts — including the case that types into the
	 * docs editor and demands the text survive the switch.
	 */
	let relocalizeSeq = 0;
	async function relocalizeDetail(s: string) {
		// ⚠️ A TICKET, because two quick switches (nl → fr) can land out of order and leave the page
		// showing the language the reader moved AWAY from, with nothing on screen to say so.
		const ticket = ++relocalizeSeq;
		try {
			const d = await blocksApi.get(s);
			// Navigated to another block, or switched again, while this was in flight.
			if (ticket !== relocalizeSeq || !detail || detail.slug !== d.slug) return;
			detail = { ...detail, name: d.name, description: d.description };
			if (!editable) {
				const v = d.versions.find((x) => x.id === selectedVersionId);
				if (v) docsMd = v.docs_md;
			}
		} catch {
			// Deliberately swallowed, and deliberately NOT `loadError`. This is a cosmetic refresh of
			// copy that is already on screen; turning a failed one into the load-error branch would
			// replace a working editor (and an unsaved draft) with an error message.
		}
	}
	reloadOnLocaleChange(() => {
		// ⛔ `untrack`, AND WITHOUT IT THIS IS AN INFINITE FETCH LOOP. `reloadOnLocaleChange` calls
		// this synchronously inside its `$effect`, so every `$state`/`$derived` read here becomes a
		// DEPENDENCY of that effect — including `detail`, which `relocalizeDetail` then assigns.
		// Effect → fetch → assign `detail` → effect → … Measured: the block-edit specs stopped
		// terminating. The locale rune is the only trigger this may ever have.
		untrack(() => {
			const s = slug;
			// No slug → the create form, which holds no server content at all: its every label is an
			// `m.*()` call and its every value is the author's own typing.
			if (s && detail) void relocalizeDetail(s);
		});
	});

	function buildDescriptor() {
		return {
			inputs: fromRows(inputs),
			outputs: fromRows(outputs),
			capabilities: {
				...(caps.network ? { network: true } : { network: false }),
				...(caps.llm ? { llm: true } : {}),
				...(caps.mockData ? { mockData: true } : {}),
				// ⛔ THIS OBJECT IS THE SAVED `capabilities` — omitting the key here does not "leave it
				// unchanged", it DELETES it from the descriptor on the next save, and a data block that
				// lost its `dataset` grant fails at run time with `capability_missing_dataset`. It is
				// now authored by its own toggle (Permissions & data) rather than only inherited, so
				// this line is what carries a NEW dataset block's grant to the server — see the `caps`
				// declaration for why the grant needed a control of its own.
				...(caps.dataset ? { dataset: true } : {})
			}
		};
	}

	// ---- Phase 5D: save the current block as a reusable tenant template ----
	// Developer-only; snapshots what the developer is looking at (the editor buffers: descriptor +
	// source + docs) into a tenant-scoped template that then appears in the "From template" gallery.
	let saveTplOpen = $state(false);
	let savingTpl = $state(false);
	// tplForm also carries the optional PKO/PDDL formal structure (preconditions / postconditions /
	// steps) the template can ground future blocks in. Save-from-block starts them empty; the developer
	// authors them here. Blank rows are dropped on save.
	let tplForm = $state<{
		label: string;
		name: string;
		domain: string;
		tags: string;
		preconditions: string[];
		postconditions: string[];
		steps: { label: string; detail: string }[];
	}>({ label: '', name: '', domain: '', tags: '', preconditions: [], postconditions: [], steps: [] });
	const canSaveTemplate = $derived(!!slug && !!detail && !!selected && auth.isDeveloper);

	function openSaveTemplate() {
		if (!detail) return;
		tplForm = { label: detail.name, name: detail.slug, domain: '', tags: '', preconditions: [], postconditions: [], steps: [] };
		saveTplOpen = true;
		banner = null;
	}

	// PKO/PDDL row helpers for the save-as-template form (mirror addRow/removeRow for inputs/outputs).
	function addCondition(which: 'preconditions' | 'postconditions') {
		tplForm[which] = [...tplForm[which], ''];
	}
	function removeCondition(which: 'preconditions' | 'postconditions', i: number) {
		tplForm[which] = tplForm[which].filter((_, j) => j !== i);
	}
	function addStep() {
		tplForm.steps = [...tplForm.steps, { label: '', detail: '' }];
	}
	function removeStep(i: number) {
		tplForm.steps = tplForm.steps.filter((_, j) => j !== i);
	}

	async function saveAsTemplate() {
		if (!detail) return;
		const label = tplForm.label.trim();
		if (!label) {
			banner = { kind: 'error', text: m.blockedit_savetpl_label_required() };
			return;
		}
		savingTpl = true;
		banner = null;
		try {
			await templatesApi.create(
				toTemplateBody(tplForm, {
					category: detail.category,
					description: detail.description,
					descriptor: buildDescriptor() as never,
					source_ts: sourceTs || DEFAULT_SOURCE,
					docs_md: docsMd
				})
			);
			saveTplOpen = false;
			banner = { kind: 'ok', text: m.blockedit_savetpl_ok({ label }) };
		} catch (e) {
			const dup = e instanceof ApiError && e.status === 409;
			banner = { kind: 'error', text: dup ? m.blockedit_savetpl_dup() : writeErrorText(e, m.error_create_failed()) };
		} finally {
			savingTpl = false;
		}
	}

	function parseExamples(): unknown[] | null {
		try {
			const v = JSON.parse(examplesText || '[]');
			return Array.isArray(v) ? v : null;
		} catch {
			return null;
		}
	}

	/**
	 * Persist the open draft. Returns whether the edits actually reached the server.
	 *
	 * ⛔ THE RETURN VALUE IS THE WHOLE POINT, AND IT IS WHY THIS IS NOT `void` ANY MORE. `publish()`
	 * did `await saveDraft()` and then carried on regardless. `saveDraft` reports failure only by
	 * writing `banner`, and `publish()`'s success path OVERWRITES `banner` — so a save that 409'd
	 * flashed a red banner for one tick and was then replaced by a green "v3 published", while what
	 * shipped was the PREVIOUSLY saved source. The author was told their unsaved work was live.
	 * Both failure exits (the examples JSON bail and the write error) must therefore be visible to
	 * the caller, not just to the reader who was not looking.
	 */
	async function saveDraft(): Promise<boolean> {
		// Nothing is open to save. Unreachable from `publish()`, which carries the identical guard and
		// has already returned; `false` is the honest answer either way — nothing was persisted.
		if (!detail || !selected || !isDraft) return false;
		const examples = parseExamples();
		if (examples === null) {
			banner = { kind: 'error', text: m.blockedit_err_examples_json() };
			return false;
		}
		saving = true;
		banner = null;
		try {
			const updated = await blocksApi.saveVersion(detail.slug, selected.version, {
				docs_md: docsMd,
				source_ts: sourceTs,
				descriptor: buildDescriptor() as never,
				examples: examples as never
			});
			// merge back
			detail.versions = detail.versions.map((v) => (v.id === updated.id ? updated : v));
			banner = { kind: 'ok', text: m.blockedit_saved_draft({ version: updated.version }) };
			return true;
		} catch (e) {
			// ⛔ THE SAME 422 THE PUBLISH GATE THROWS NOW REACHES THIS PATH TOO, so it must be read the
			// same way. The block-source gate refuses a banned source at SAVE time as well as at publish,
			// and `writeErrorText` would surface the backend's English fallback sentence ("Block failed
			// lint") verbatim on a Dutch screen — the exact defect class this session exists to remove.
			// `findings` carries a CLOSED rule vocabulary that `scanFindingLabel` already localizes, so
			// render that instead and let the panel show which rule tripped.
			if (e instanceof ApiError && (e.code === 'lint_failed' || e.code === 'static_scan_failed') && e.findings) {
				findings = e.findings as LintFinding[];
				banner = { kind: 'error', text: m.blockedit_err_source_refused() };
			} else {
				banner = { kind: 'error', text: writeErrorText(e, m.error_save_failed()) };
			}
			return false;
		} finally {
			saving = false;
		}
	}

	async function publish() {
		if (!detail || !selected || !isDraft) return;
		// ⛔ THE OUTCOME IS READ. Publishing a version whose save just failed ships the LAST PERSISTED
		// source and then reports success over the top of the save's own error banner — the author is
		// told the code in front of them is live when it never left the browser. The save's banner is
		// already on screen and says what went wrong, so this returns silently rather than adding a
		// second sentence about it.
		if (!(await saveDraft())) return;
		saving = true;
		findings = [];
		try {
			const pub = await blocksApi.publish(detail.slug, selected.version, 'stable');
			// ⛔ THE RELOAD FIRST, THE BANNER SECOND — AND THE ORDER IS THE WHOLE MESSAGE.
			// `loadDetail()` ends in `selectVersion()`, whose last statement is `banner = null` (it has
			// to be: a version click at the sidebar must not leave "v3 published" hanging over v4). So
			// writing the green line BEFORE the reload gave it a lifetime of exactly one in-flight GET,
			// and publish — the one irreversible action on this screen — was the only outcome the editor
			// reported with silence. Every failure branch below shouts, because none of them reload.
			// `newDraft()` twenty-odd lines down already had this ordering; this is the same fix.
			await loadDetail(detail.slug);
			banner = { kind: 'ok', text: m.blockedit_published({ version: pub.version }) };
		} catch (e) {
			if (e instanceof ApiError && (e.code === 'lint_failed' || e.code === 'static_scan_failed') && e.findings) {
				findings = e.findings as LintFinding[];
				banner = { kind: 'error', text: m.blockedit_err_lint() };
			} else if (e instanceof ApiError && e.code === 'tests_required') {
				banner = { kind: 'error', text: m.blockedit_err_tests_required() };
				activeTab = 'Testing';
				testReloadSignal++;
			} else if (e instanceof ApiError && e.code === 'tests_failing') {
				banner = { kind: 'error', text: m.blockedit_err_tests_failing() };
				activeTab = 'Testing';
				testReloadSignal++;
			} else {
				banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
			}
		} finally {
			saving = false;
		}
	}

	async function newDraft() {
		if (!detail) return;
		saving = true;
		banner = null;
		try {
			const draft = await blocksApi.createVersion(detail.slug, {});
			await loadDetail(detail.slug);
			const v = detail?.versions.find((x) => x.id === draft.id);
			if (v) selectVersion(v);
			banner = { kind: 'ok', text: m.blockedit_created_draft({ version: draft.version }) };
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_create_failed()) };
		} finally {
			saving = false;
		}
	}

	async function createBlock() {
		if (!createForm.name.trim()) {
			banner = { kind: 'error', text: m.blockedit_err_slug_name_required() };
			return;
		}
		const finalSlug = createForm.slug.trim() || slugify(createForm.name);
		if (!finalSlug) {
			banner = { kind: 'error', text: m.blockedit_err_slug_name_required() };
			return;
		}
		const examples = parseExamples();
		if (examples === null) {
			banner = { kind: 'error', text: m.blockedit_err_examples_json() };
			return;
		}
		creating = true;
		banner = null;
		try {
			// Persist everything authored on this one screen (docs, code, I/O) in a single call.
			const res = await blocksApi.create({
				slug: finalSlug,
				name: createForm.name.trim(),
				description: createForm.description,
				category: createForm.category,
				docs_md: docsMd,
				source_ts: sourceTs || DEFAULT_SOURCE,
				descriptor: buildDescriptor() as never
			});
			// Stay on the same screen — swap the unsaved buffer for the persisted draft in place.
			await goto(`/block-edit?slug=${encodeURIComponent(res.block.slug)}`, { replaceState: true });
		} catch (e) {
			// Same reasoning as `saveDraft()`: the source gate refuses a banned source at CREATE time too,
			// and the raw backend fallback ("Block failed lint") is English. Measured in a browser on the
			// Dutch UI before this branch existed — the refusal was correct and the sentence was not.
			// Switch to the Implementation tab as well: the findings panel lives there, so a refusal that
			// only changed the banner left the reader looking at Documentation with no idea which rule
			// tripped.
			if (e instanceof ApiError && (e.code === 'lint_failed' || e.code === 'static_scan_failed') && e.findings) {
				findings = e.findings as LintFinding[];
				banner = { kind: 'error', text: m.blockedit_err_source_refused() };
				activeTab = 'Implementation';
			} else {
				banner = { kind: 'error', text: writeErrorText(e, m.error_create_failed()) };
			}
		} finally {
			creating = false;
		}
	}

	function addRow(which: 'in' | 'out') {
		const row: FieldRow = { name: '', type: 'string', required: false, pii: false, enumText: '' };
		if (which === 'in') inputs = [...inputs, row];
		else outputs = [...outputs, row];
	}
	function removeRow(which: 'in' | 'out', i: number) {
		if (which === 'in') inputs = inputs.filter((_, idx) => idx !== i);
		else outputs = outputs.filter((_, idx) => idx !== i);
	}

	// ---- ontology I/O picker: import an entity's attributes as typed output ports ----
	// Mirrors the backend compileDataBlock derivation so a hand-authored block's descriptor matches
	// what create_data_block_from_entity produces (one port per attribute + rows/count).
	let ontoOpen = $state(false);
	let ontoMatrix = $state<MatrixData | null>(null);
	let ontoIndustry = $state('');
	let ontoDept = $state('');
	let ontoEntities = $state<OntologyEntity[]>([]);
	let ontoEntityId = $state('');
	let ontoBusy = $state(false);
	let ontoError = $state<string | null>(null);

	/** Ontology attribute type → block FieldType (mirror of backend mapOntologyType). */
	function mapOntologyType(type: string): FieldType {
		switch (type.trim().toLowerCase()) {
			case 'string': case 'text': case 'date': case 'datetime': case 'timestamp':
			case 'enum': case 'email': case 'phone': case 'url': case 'uuid':
				return 'string';
			case 'number': case 'integer': case 'int': case 'float': case 'decimal': case 'currency':
				return 'number';
			case 'boolean': case 'bool':
				return 'boolean';
			case 'string[]': case 'text[]':
				return 'string[]';
			default:
				return 'json';
		}
	}

	async function loadOntoMatrix() {
		if (ontoMatrix) return;
		try {
			ontoMatrix = await ontologyApi.matrix();
		} catch (e) {
			ontoError = errorText(e, m.error_load_failed());
		}
	}
	async function openOntoPicker() {
		ontoOpen = true;
		ontoError = null;
		await loadOntoMatrix();
	}
	async function loadOntoEntities() {
		ontoEntityId = '';
		if (!ontoIndustry || !ontoDept) {
			ontoEntities = [];
			return;
		}
		ontoBusy = true;
		ontoError = null;
		try {
			const g = await ontologyApi.get(ontoIndustry, ontoDept);
			ontoEntities = g.entities;
		} catch (e) {
			ontoError = errorText(e, m.error_load_failed());
			ontoEntities = [];
		} finally {
			ontoBusy = false;
		}
	}
	function importOntoEntity() {
		const ent = ontoEntities.find((e) => e.id === ontoEntityId);
		if (!ent) return;
		const seen = new Set(outputs.map((r) => r.name));
		const added: FieldRow[] = [];
		for (const a of ent.attributes) {
			if (seen.has(a.name)) continue;
			seen.add(a.name);
			added.push({ name: a.name, type: mapOntologyType(a.type), required: false, pii: a.pii, enumText: '' });
		}
		if (!seen.has('rows')) added.push({ name: 'rows', type: 'json', required: false, pii: false, enumText: '' });
		if (!seen.has('count')) added.push({ name: 'count', type: 'number', required: false, pii: false, enumText: '' });
		outputs = [...outputs, ...added];
		ontoOpen = false;
		banner = { kind: 'ok', text: m.blockedit_import_ontology_done({ count: num(added.length, locale.current), entity: ent.label }) };
	}

	// ⛔ `fmtDate()` IS GONE — it was `new Date(iso).toLocaleDateString(undefined, …)`, the third
	// spelling of one defect (`[]` and a bare call are the other two): `undefined` means the
	// RUNTIME's locale, so a Dutch reader on an English machine got "Aug 7, 2026" under a Dutch
	// label. Its three call sites now use `fullDate(iso, locale.current)` from utils/format, which
	// also owns the null → '—' branch. Reading `locale.current` IN THE MARKUP is what re-renders
	// these on a locale switch, so do not re-wrap it in a helper that reads the store itself.
	function versionBadge(v: BlockVersion): string {
		if (v.status === 'draft') return 'amber';
		if (v.id === detail?.current_version_id) return 'teal';
		return 'outline';
	}
	const lineCount = $derived(sourceTs.split('\n').length);
</script>

<div class="page">
	{#if slug && loadError}
		<div class="notice error">{loadError} <a href="/blocks">{m.blockedit_back_to_library()}</a></div>
	{:else if slug && (loading || !(detail && selected))}
		<div class="load-skeleton" aria-busy="true" aria-label={m.blockedit_loading({ slug })}>
			<div class="ls-head">
				<Skeleton width="180px" height="22px" />
				<Skeleton width="120px" height="13px" />
			</div>
			<div class="ls-tabs">
				{#each Array(5) as _, i (i)}<Skeleton width="78px" height="13px" />{/each}
			</div>
			<div class="ls-body">
				<Skeleton width="100%" height="14px" />
				<Skeleton width="92%" height="14px" />
				<Skeleton width="74%" height="14px" />
				<Skeleton width="100%" height="180px" radius="var(--r)" />
			</div>
		</div>
	{:else if !slug && !canAuthor}
		<!--
			CREATE-NEW mode with no authoring right. There is nothing to read here — with no ?slug this
			screen IS the form for `POST /api/blocks` (`requireBlockAuthor`, routes/blocks.ts:561) — so
			the honest render is the refusal the server would give, plus the way back to the catalog.
			This is the same fact the nav table already states about this href (navConfig.ts:130); the
			sidebar hides it, and this is what remains for someone who arrives by URL or by history.
		-->
		<div class="notice error">
			{m.error_developer_required()} <a href="/blocks">{m.blockedit_back_to_library()}</a>
		</div>
	{:else}
		{@const isNew = !slug}
		<header class="edit-head">
			<div class="head-id">
				<a class="back" href="/blocks">{m.blockedit_back_building_blocks()}</a>
				{#if isNew}
					<input
						class="name-input"
						placeholder={m.blockedit_ph_name()}
						aria-label={m.blockedit_label_name()}
						bind:value={createForm.name}
						oninput={onNameInput}
					/>
					<div class="id-row">
						<span class="id-field">
							<span class="id-tag">{m.blockedit_label_category()}</span>
							<select bind:value={createForm.category}>
								{#each CATEGORIES as c (c)}<option value={c}>{categoryLabel(c)}</option>{/each}
							</select>
						</span>
						<span class="id-field grow">
							<span class="id-tag">{m.blockedit_label_slug()}</span>
							<input
								class="slug-input"
								placeholder={m.blockedit_ph_slug()}
								bind:value={createForm.slug}
								oninput={() => (slugTouched = true)}
							/>
						</span>
					</div>
				{:else}
					<h1>{detail!.name}</h1>
					<div class="head-meta">
						<span class="badge {CATEGORY_META[detail!.category].badge}">{categoryLabel(detail!.category)}</span>
						<span class="mono">v{selected!.version}</span>
						<span class="status-dot {selected!.status}">{mr[STATUS_LABEL_KEYS[selected!.status]]?.() ?? selected!.status}</span>
						{#if !isDraft}<span class="ro-note">{m.blockedit_readonly_note()}</span>{/if}
					</div>
				{/if}
			</div>
			<div class="head-actions">
				{#if isNew}
					<button class="btn-ghost" onclick={() => goto('/blocks')}>{m.blockedit_cancel()}</button>
					<button class="btn-primary" disabled={creating || !createForm.name.trim()} onclick={createBlock}>
						{creating ? m.blockedit_creating() : m.blockedit_create_block()}
					</button>
				{:else if confirmDelete}
					<span class="del-confirm-q">{m.blockedit_delete_confirm_q()}</span>
					<button class="btn-ghost" disabled={deleting} onclick={() => (confirmDelete = false)}>{m.blockedit_cancel()}</button>
					<button class="btn-danger" disabled={deleting} onclick={deleteBlock}>
						{deleting ? m.blockedit_deleting() : m.blockedit_delete_confirm()}
					</button>
				{:else if canAuthor}
					<button class="btn-ghost" disabled={saving} onclick={newDraft}>{m.blockedit_new_draft()}</button>
					<button class="btn-ghost" disabled={!isDraft || saving} onclick={saveDraft}>
						{saving ? m.blockedit_saving() : m.blockedit_save_draft()}
					</button>
					{#if canSaveTemplate}
						<button class="btn-ghost" disabled={saving || savingTpl} onclick={openSaveTemplate}>{m.blockedit_save_as_template()}</button>
					{/if}
					<button class="btn-primary" disabled={!isDraft || saving} onclick={publish}>{m.blockedit_publish()}</button>
					{#if canDelete}
						<button class="btn-danger" disabled={saving} onclick={() => (confirmDelete = true)}>{m.blockedit_delete()}</button>
					{/if}
				{/if}
			</div>
		</header>

		{#if isNew}
			<p class="nb-sub">{m.blockedit_new_sub()}</p>
			<div class="start-mode" role="tablist" aria-label={m.blockedit_new_title()}>
				<button class="sm-btn" class:active={startMode === 'blank'} role="tab" aria-selected={startMode === 'blank'} onclick={() => (startMode = 'blank')}>{m.blockedit_start_mode_blank()}</button>
				<button class="sm-btn" class:active={startMode === 'assistant'} role="tab" aria-selected={startMode === 'assistant'} onclick={() => (startMode = 'assistant')}>{m.blockedit_start_mode_assistant()}</button>
				<button class="sm-btn" class:active={startMode === 'template'} role="tab" aria-selected={startMode === 'template'} onclick={() => (startMode = 'template')}>{m.blockedit_start_mode_template()}</button>
				<button class="sm-btn" class:active={startMode === 'existing'} role="tab" aria-selected={startMode === 'existing'} onclick={() => (startMode = 'existing')}>{m.blockedit_start_mode_existing()}</button>
				{#if createForm.category === 'data'}
					<button class="sm-btn" class:active={startMode === 'entity'} role="tab" aria-selected={startMode === 'entity'} onclick={() => (startMode = 'entity')}>{m.blockedit_start_mode_entity()}</button>
				{/if}
			</div>
		{/if}

		{#if !isNew && saveTplOpen}
			<div class="savetpl">
				<div class="st-head">
					<strong>{m.blockedit_savetpl_title()}</strong>
					<button class="st-x" aria-label={m.blockedit_savetpl_cancel()} onclick={() => (saveTplOpen = false)}>×</button>
				</div>
				<p class="st-hint">{m.blockedit_savetpl_hint()}</p>
				<div class="st-grid">
					<label class="st-field">
						<span>{m.blockedit_savetpl_label_label()}</span>
						<input bind:value={tplForm.label} placeholder={m.blockedit_savetpl_label_ph()} />
					</label>
					<label class="st-field">
						<span>{m.blockedit_savetpl_name_label()}</span>
						<input bind:value={tplForm.name} />
					</label>
					<label class="st-field">
						<span>{m.blockedit_savetpl_domain_label()}</span>
						<input bind:value={tplForm.domain} placeholder={m.blockedit_savetpl_domain_ph()} />
					</label>
					<label class="st-field">
						<span>{m.blockedit_savetpl_tags_label()}</span>
						<input bind:value={tplForm.tags} />
					</label>
				</div>
				<div class="st-formal">
					<p class="st-formal-hint">{m.blockedit_savetpl_formal_hint()}</p>
					<div class="st-cond">
						<div class="st-cond-head">
							<span>{m.blockedit_savetpl_pre_label()}</span>
							<button class="btn-mini" onclick={() => addCondition('preconditions')}>{m.blockedit_savetpl_add_condition()}</button>
						</div>
						{#each tplForm.preconditions as _, i (i)}
							<div class="st-cond-row">
								<input bind:value={tplForm.preconditions[i]} placeholder={m.blockedit_savetpl_pre_ph()} />
								<button class="io-del" aria-label={m.blockedit_savetpl_remove_row()} onclick={() => removeCondition('preconditions', i)}>×</button>
							</div>
						{/each}
					</div>
					<div class="st-cond">
						<div class="st-cond-head">
							<span>{m.blockedit_savetpl_post_label()}</span>
							<button class="btn-mini" onclick={() => addCondition('postconditions')}>{m.blockedit_savetpl_add_condition()}</button>
						</div>
						{#each tplForm.postconditions as _, i (i)}
							<div class="st-cond-row">
								<input bind:value={tplForm.postconditions[i]} placeholder={m.blockedit_savetpl_post_ph()} />
								<button class="io-del" aria-label={m.blockedit_savetpl_remove_row()} onclick={() => removeCondition('postconditions', i)}>×</button>
							</div>
						{/each}
					</div>
					<div class="st-cond">
						<div class="st-cond-head">
							<span>{m.blockedit_savetpl_steps_label()}</span>
							<button class="btn-mini" onclick={addStep}>{m.blockedit_savetpl_add_step()}</button>
						</div>
						{#each tplForm.steps as _, i (i)}
							<div class="st-step-row">
								<input class="st-step-label" bind:value={tplForm.steps[i].label} placeholder={m.blockedit_savetpl_step_label_ph()} />
								<input class="st-step-detail" bind:value={tplForm.steps[i].detail} placeholder={m.blockedit_savetpl_step_detail_ph()} />
								<button class="io-del" aria-label={m.blockedit_savetpl_remove_row()} onclick={() => removeStep(i)}>×</button>
							</div>
						{/each}
					</div>
				</div>
				<div class="st-actions">
					<button class="btn-ghost" disabled={savingTpl} onclick={() => (saveTplOpen = false)}>{m.blockedit_savetpl_cancel()}</button>
					<button class="btn-primary" disabled={savingTpl || !tplForm.label.trim()} onclick={saveAsTemplate}>
						{savingTpl ? m.blockedit_savetpl_saving() : m.blockedit_savetpl_save()}
					</button>
				</div>
			</div>
		{/if}

		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}
		<!--
			⚠️ `dir="ltr"` MIRRORS THE LIVE-LINT LIST BELOW, and is not decoration: every row is
			anchored by a rule token and a line number, both latin identifiers. The SENTENCE inside is
			`<bdi>`-isolated so an ar/he translation still gets its own RTL base direction (bdi is
			`dir="auto"`) instead of inheriting the container's — and so the module specifier it
			interpolates cannot reorder the prose around it.
		-->
		<!--
			⛔ `!isNew` USED TO GATE THIS, AND THAT PREDATES THE SOURCE GATE. When the only producer of
			`findings` was the publish button, a block being created could not have any, so hiding the
			panel cost nothing. Now `createBlock()` also populates it: a banned source is refused AT
			CREATE, and measured in a real browser the author got "Geblokkeerd: de broncode is gezakt
			voor de sandboxscan." with nothing anywhere on screen saying WHICH rule tripped — a refusal
			the reader cannot act on. The list is what makes it actionable, so it renders in both modes.
		-->
		{#if findings.length}
			<div class="findings" dir="ltr">
				<strong>{m.blockedit_findings_title()}</strong>
				<ul>
					{#each findings as f, i (i)}
						<li><code>{f.rule}</code> <bdi>{scanFindingLabel(f)}</bdi>{#if f.line} <span class="ln">{m.blockedit_finding_line({ line: f.line })}</span>{/if}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if isNew && startMode === 'entity'}
			<!-- derive a typed data block from an ontology entity (visual entity browser) -->
			<EntityDeriveBrowser
				onDerived={(s) => goto(`/block-edit?slug=${encodeURIComponent(s)}`, { replaceState: true })}
			/>
		{:else if isNew && startMode === 'template'}
			<!-- start from a seeded starter template (pre-fills the editor buffers) -->
			<TemplateGallery category={createForm.category} onPick={applyTemplate} />
		{:else if isNew && startMode === 'existing'}
			<!-- fork an existing block as a scaffold (pre-fills the editor buffers, renamed) -->
			<ExistingBlockPicker category={createForm.category} onPick={applyExistingBlock} />
		{:else}
			<div class="layout" class:solo={isNew && startMode !== 'assistant'} class:assist={isNew && startMode === 'assistant'}>
				<div class="main">
					<div class="tabs">
						{#each isNew ? NEW_TABS : visibleTabs as tab (tab)}
							<button class="tab" class:active={activeTab === tab} onclick={() => (activeTab = tab)}>{mr[TAB_LABEL_KEYS[tab]]()}</button>
						{/each}
					</div>

					<div class="tab-body">
					{#if activeTab === 'Documentation'}
						<MarkdownEditor bind:value={docsMd} readonly={!editable} />
					{:else if activeTab === 'Implementation'}
						<div class="impl-head">
							<span>{m.blockedit_impl_head({ count: lineCount })}</span>
							{#if !isNew}
								<span class="impl-badges">
									<!-- ⛔ THE TEAL BADGE IS EARNED, NOT DEFAULTED. It renders on `lintState === 'ok'`
									     — a lint that ran and answered — never on an empty `lintFindings`, which is
									     also what "never checked" looks like. See `lintState`'s doc comment.
									     ⚠️ `outline` (muted) for idle and `amber` for a failed check, deliberately:
									     a READER only ever sees the idle one, because the debounce effect is gated
									     on `editable` and never fires for them. Coral here would report a failure
									     to someone who has nothing to fix and no way to retry. -->
									{#if linting}<span class="lint-state">{m.blockedit_lint_checking()}</span>
									{:else if lintState === 'idle'}<span class="badge outline">{m.blockedit_lint_unknown()}</span>
									{:else if lintState === 'error'}<span class="badge amber">{m.blockedit_lint_failed()}</span>
									{:else if lintFindings.length === 0}<span class="badge teal">{m.blockedit_lint_clean()}</span>
									{:else}<span class="badge coral">{m.blockedit_lint_issues({ count: num(lintFindings.length, locale.current) })}</span>{/if}
									{#if testsPassing}<span class="badge teal">{m.blockedit_tests_passing()}</span>{/if}
								</span>
							{/if}
						</div>
						{#if fixContext && canFix}
							<div class="fix-panel">
								<BlockFixAssistant
									slug={detail!.slug}
									version={selected!.version}
									{sourceTs}
									descriptor={selected!.descriptor}
									context={fixContext}
									onApply={applyFix}
									onClose={() => (fixContext = null)}
								/>
							</div>
						{/if}
						<CodeEditor bind:this={editorRef} bind:value={sourceTs} readonly={!editable} />
						{#if lintFindings.length}
							<div class="findings" dir="ltr">
								<div class="findings-head">
									<strong>{m.blockedit_lint_title()}</strong>
									{#if canFix && !fixContext}
										<button type="button" class="lnk" onclick={() => openFix({ origin: 'lint', lint: lintFindings })}>{m.blockfix_cta()}</button>
									{/if}
								</div>
								<ul>
									{#each lintFindings as f, i (i)}
										<li>
											<span class="src-tag {f.source}">{f.source === 'type' ? m.blockedit_lint_src_type() : m.blockedit_lint_src_scan()}</span>
											<code>{f.rule}</code> <bdi>{scanFindingLabel(f)}</bdi>{#if f.line} <button type="button" class="ln ln-jump" onclick={() => editorRef?.scrollToLine(f.line!)} title={m.blockedit_jump_to_line()}>{m.blockedit_finding_line({ line: f.line })}{#if f.col}:{f.col}{/if}</button>{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{:else if !isNew && activeTab === 'Testing'}
						<BlockTesting
							slug={detail!.slug}
							version={selected!.version}
							descriptor={selected!.descriptor}
							{isDraft}
							{canAuthor}
							reloadSignal={testReloadSignal}
							onTestsPassing={(p) => (testsPassingOverride = p)}
							onFixWithAI={canFix ? openFix : undefined}
						/>
					{:else if !isNew && activeTab === 'Simulate'}
						<BlockSimulate
							slug={detail!.slug}
							version={selected!.version}
							descriptor={selected!.descriptor}
							examples={selected!.examples}
							onSaved={() => testReloadSignal++}
							onViewTests={() => (activeTab = 'Testing')}
							onFixWithAI={canFix ? openFix : undefined}
						/>
					{:else if !isNew && activeTab === 'Examples'}
						<p class="hint">{m.blockedit_examples_hint_before()} <code>{'{ name, inputs, expectedOutputs }'}</code> {m.blockedit_examples_hint_after()}</p>
						<!-- `editable`, not `isDraft`: the examples ride along on `saveVersion`, which is
						     `authorizeBlockWrite` — a reader who cannot save must not be given a live buffer. -->
						<textarea class="json-area" bind:value={examplesText} readonly={!editable} spellcheck="false"></textarea>
					{:else if activeTab === 'Permissions & data'}
						<div class="perms">
							<!-- ⛔ THE FIELD STAYS, THE CONTROL GOES — AND THAT ASYMMETRY IS THE WHOLE FIX.
							     THERE IS NO `ctx.fetch`. `exec/sdk.ts`'s `BlockContext` exposes `llm`,
							     `mockData`, `dataset`, `log` and `signal` and nothing else, and
							     `exec/static-scan.ts` refuses `fetch`/`XMLHttpRequest` at SAVE time. So a
							     block cannot make an outbound call whether this bit is set or not.
							     WHAT THE BIT ACTUALLY DOES is worse than nothing: `host/run-policy.ts` is
							     its ONLY reader, and it uses `capabilities.network` to REFUSE the run. An
							     author who ticked the box marked "Netwerktoegang" bought no capability and
							     acquired a flow that will not execute — a control that reads as a grant and
							     behaves as a self-inflicted ban.
							     ⛔ AND `network` IS NOT HARDCODED FALSE ON SAVE (see `buildDescriptor`).
							     `caps.network` still round-trips from the loaded descriptor, so a legacy
							     `network:true` row is not silently downgraded by a developer who opens the
							     tab and clicks Save, and `run-policy` keeps meaning exactly what it meant.
							     Removing the CONTROL closes the way to author a new one; rewriting the
							     FIELD would be this repo editing history it does not own.
							     ⚠️ MEASURED before the change: NO row in `block_versions` carries
							     `network:true` — every one spells it `"network": false` explicitly. The
							     property, not a headcount: a row count typed into a comment is stale the
							     next time somebody publishes a block, and this repo has already been
							     bitten by hand-typed totals rotting into false claims. Re-measure with
							     `select count(*) from block_versions where descriptor->'capabilities'->>'network' = 'true'`
							     if you need today's number. So no live block is affected; the round-trip
							     is for the row that is not there yet, and for the archive.
							     Rendered as a plain row rather than a `disabled` toggle: a greyed-out
							     switch says "not yet" / "not for you", which invites the author to go
							     looking for the permission that unlocks it. There is none. -->
							<div class="toggle-row">
								<div><div class="t-label">{m.blockedit_cap_network()}</div><div class="t-sub">{m.blockedit_cap_network_sub()}</div></div>
								<div class="t-unavailable" data-testid="cap-network-unavailable">{m.blockedit_cap_network_unavailable()}</div>
							</div>
							<div class="toggle-row">
								<div><div class="t-label">{m.blockedit_cap_llm()}</div><div class="t-sub">{m.blockedit_cap_llm_sub()}</div></div>
								<button class="toggle" class:on={caps.llm} disabled={!editable} aria-label={m.blockedit_cap_llm()} onclick={() => (caps.llm = !caps.llm)}></button>
							</div>
							<div class="toggle-row">
								<div><div class="t-label">{m.blockedit_cap_mock()}</div><div class="t-sub">{m.blockedit_cap_mock_sub()}</div></div>
								<button class="toggle" class:on={caps.mockData} disabled={!editable} aria-label={m.blockedit_cap_mock()} onclick={() => (caps.mockData = !caps.mockData)}></button>
							</div>
							<!-- ⛔ THE THIRD TOGGLE IS NOT A SECOND SPELLING OF THE ONE ABOVE IT, AND THE ORDER
							     MATTERS: they sit adjacent precisely so an author reads the two sub-labels
							     against each other. `mockData` is a CLAIM ABOUT THE OUTPUT — the single bit
							     every "Simulated" badge renders from (BlockNode.svelte:32, BlockPalette,
							     BlockResultView, the /blocks card). `dataset` is an ACCESS GRANT: it opens
							     `ctx.dataset()` onto the workspace's REAL uploaded rows and says nothing about
							     whether the output is invented.
							     ⛔ WHAT ITS ABSENCE COST, because that is why it is here. `capabilities.dataset`
							     was already round-tripped through `caps` and `buildDescriptor()`, so an EXISTING
							     dataset block kept its grant across a save — but nothing could GRANT it. An
							     author writing a NEW block calling `ctx.dataset()` had exactly one reachable
							     option: tick "mock data", the legacy gate opener, which then stamped
							     "Gesimuleerd" on a block returning the customer's own rows. A capability nobody
							     can set does not exist for new work, so the split was only half-shipped until
							     this control landed. The two copies must keep the bits apart in WORDS — the
							     toggles themselves look identical. -->
							<div class="toggle-row">
								<div><div class="t-label">{m.blockedit_cap_dataset()}</div><div class="t-sub">{m.blockedit_cap_dataset_sub()}</div></div>
								<button class="toggle" class:on={caps.dataset} disabled={!editable} aria-label={m.blockedit_cap_dataset()} onclick={() => (caps.dataset = !caps.dataset)}></button>
							</div>
						</div>

						<div class="io">
							{#each [{ key: 'in', label: 'blockedit_io_inputs', rows: inputs }, { key: 'out', label: 'blockedit_io_outputs', rows: outputs }] as grp (grp.key)}
								<div class="io-col">
									<div class="io-head">
										<span>{mr[grp.label]()}</span>
										<span class="io-head-actions">
											{#if editable && grp.key === 'out'}<button class="btn-mini" onclick={openOntoPicker}>{m.blockedit_import_ontology()}</button>{/if}
											{#if editable}<button class="btn-mini" onclick={() => addRow(grp.key as 'in' | 'out')}>{m.blockedit_add_field()}</button>{/if}
										</span>
									</div>
									{#each grp.rows as row, i (i)}
										<div class="io-row">
											<input class="io-name" placeholder={m.blockedit_ph_field_name()} bind:value={row.name} disabled={!editable} />
											<select bind:value={row.type} disabled={!editable}>
												<!-- ⛔ `value={ft}` STAYS CANONICAL. The value is the wire key `row.type` binds
												     to and the backend's `fieldTypeSchema` validates; only the LABEL is the
												     reader's. Localizing the value would send "Lijst" where the descriptor
												     schema demands "string[]". Label and key are two different things — the
												     same split $lib/i18n/field-type-label.ts documents. -->
												{#each FIELD_TYPES as ft (ft)}<option value={ft}>{fieldTypeLabel(ft)}</option>{/each}
											</select>
											<label class="io-flag"><input type="checkbox" bind:checked={row.required} disabled={!editable} />{m.blockedit_flag_req()}</label>
											<label class="io-flag"><input type="checkbox" bind:checked={row.pii} disabled={!editable} />{m.blockedit_flag_pii()}</label>
											{#if editable}<button class="io-del" aria-label={m.blockedit_remove_field_aria()} onclick={() => removeRow(grp.key as 'in' | 'out', i)}>×</button>{/if}
										</div>
										{#if row.type === 'enum'}
											<input class="io-enum" placeholder={m.blockedit_ph_enum()} bind:value={row.enumText} disabled={!editable} />
										{/if}
									{/each}
									{#if grp.rows.length === 0}<div class="io-empty">{m.blockedit_io_none()}</div>{/if}
								</div>
							{/each}
						</div>

						{#if ontoOpen}
							<div class="onto-picker">
								<div class="onto-head">
									<strong>{m.blockedit_import_ontology_title()}</strong>
									<button class="onto-close" onclick={() => (ontoOpen = false)} aria-label={m.blockedit_cancel()}>×</button>
								</div>
								{#if ontoError}<div class="banner error">{ontoError}</div>{/if}
								<div class="onto-row">
									<select bind:value={ontoIndustry} onchange={loadOntoEntities}>
										<option value="">{m.blockedit_import_ontology_industry()}</option>
										{#each ontoMatrix?.industries ?? [] as ind (ind)}<option value={ind}>{industryLabel(ind)}</option>{/each}
									</select>
									<select bind:value={ontoDept} onchange={loadOntoEntities}>
										<option value="">{m.blockedit_import_ontology_department()}</option>
										{#each ontoMatrix?.departments ?? [] as d (d)}<option value={d}>{departmentLabel(d)}</option>{/each}
									</select>
								</div>
								{#if ontoBusy}
									<div class="io-empty">{m.blockedit_import_ontology_loading()}</div>
								{:else if ontoEntities.length}
									<div class="onto-row">
										<select bind:value={ontoEntityId}>
											<option value="">{m.blockedit_import_ontology_entity()}</option>
											{#each ontoEntities as e (e.id)}<option value={e.id}>{e.label} ({num(e.attributes.length, locale.current)})</option>{/each}
										</select>
										<button class="btn-mini" disabled={!ontoEntityId} onclick={importOntoEntity}>{m.blockedit_import_ontology_confirm()}</button>
									</div>
								{:else if ontoIndustry && ontoDept}
									<div class="io-empty">{m.blockedit_io_none()}</div>
								{/if}
							</div>
						{/if}
					{:else if !isNew && activeTab === 'Usage stats'}
						<div class="usage">
							<!-- Block-scoped real RUNS, from the same flow-run traces as the sparkline below.
							     `usage_count` used to be read straight off the selected VERSION row, which is a
							     seed literal nothing ever increments — so this tile read "4,821 total uses"
							     directly above a 30-day trend showing 2 runs. `usageCount` is the honest field;
							     the version fallback is only for a backend still on the previous build (which
							     now also serves the real number under the old field name).

							     The label says "total runs", not "total uses". The number's grain is a RUN:
							     a block invoked twice inside one execution counts once, deliberately, because
							     the alternative — counting node_success events — is the foreach multiplication
							     this whole change exists to remove, and would print 400 here directly above a
							     sparkline whose own axis says "runs" and shows 1. Every string on this tab now
							     uses the same unit. -->
							<div class="stat"><div class="stat-n">{num(detail!.usageCount ?? selected!.usage_count, locale.current)}</div><div class="stat-l">{m.blockedit_stat_total_uses()}</div></div>
							<div class="stat"><div class="stat-n">{num(detail!.versions.length, locale.current)}</div><div class="stat-l">{m.blockedit_stat_versions()}</div></div>
							<div class="stat"><div class="stat-n">{fullDate(selected!.published_at, locale.current)}</div><div class="stat-l">{m.blockedit_stat_published()}</div></div>
						</div>
						{#if detail!.usageTrend && detail!.usageTrend.length > 0}
							<BlockUsageTrend points={detail!.usageTrend} />
						{/if}
						<div class="consumers">
							<div class="consumers-head">{m.blockedit_usage_consumers_title()}</div>
							{#if !detail!.consumers || detail!.consumers.length === 0}
								<p class="consumers-empty">{m.blockedit_usage_consumers_empty()}</p>
							{:else}
								<ul class="consumers-list">
									{#each detail!.consumers as c (c.flowId)}
										<li>
											<a class="consumer-name" href={c.solutionId ? `/solutions/${c.solutionId}` : `/build?id=${c.flowId}`}>
												{c.solutionTitle ?? c.flowName}
											</a>
											<span class="consumer-runs">{m.blockedit_usage_consumers_runs({ count: num(c.runs, locale.current) })}</span>
										</li>
									{/each}
								</ul>
								<!-- ⛔ THE CAP IS DISCLOSED, IN THE SHAPE `datasets_picker_capped` ALREADY USES
								     (BlockSimulate.svelte:225-233). The list is `ORDER BY r.runs DESC … LIMIT 6`
								     and said nothing about it — so a maintainer weighing a breaking change read
								     a complete-looking inventory of the blast radius that was quietly truncated
								     at six. `role="status"`, not `alert`: nothing failed, the list is merely
								     incomplete.
								     ⚠️ THE CONDITION IS `consumersTotal > consumers.length`, NOT
								     `consumers.length === 6`. A backend one deploy behind sends the rows and no
								     total, and deriving the cap from the row count would announce a truncation
								     on a block that has exactly six consumers and is not truncated at all.
								     `num(…, locale.current)` on BOTH figures — `icu-number-params.sites.test.ts`
								     requires it, and a bare 1207 beside a grouped 1.207 on one screen is a
								     defect this repo has shipped before. -->
								{#if (detail!.consumersTotal ?? 0) > detail!.consumers.length}
									<div class="consumers-capped" role="status" data-testid="consumers-capped">
										{m.blockedit_usage_consumers_capped({
											shown: num(detail!.consumers.length, locale.current),
											total: num(detail!.consumersTotal!, locale.current)
										})}
									</div>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
			</div>

			{#if isNew && startMode === 'assistant'}
				<!-- Build with AI: describe the block, refine in chat; proposals pre-fill the buffers above -->
				<BlockAuthorAssistant category={createForm.category} onProposal={applyProposal} />
			{/if}

			{#if !isNew && detail}
				<aside class="side">
					<div class="card">
						<div class="card-head">{m.blockedit_meta_title()}</div>
					<dl class="meta">
						<dt>{m.blockedit_meta_maintainer()}</dt><dd>{detail.maintainer?.name ?? m.blockedit_meta_platform()}</dd>
						<dt>{m.blockedit_meta_created()}</dt><dd>{fullDate(detail.created_at, locale.current)}</dd>
						<dt>{m.blockedit_meta_license()}</dt><dd>{detail.license ?? '—'}</dd>
						<dt>{m.blockedit_meta_region()}</dt><dd>{detail.region ?? '—'}</dd>
						<dt>{m.blockedit_meta_cost_class()}</dt><dd>{detail.cost_class ? costClassLabel(detail.cost_class) : '—'}</dd>
					</dl>
				</div>
				<div class="card">
					<div class="card-head">{m.blockedit_version_history()}</div>
					<div class="versions">
						{#each detail.versions as v (v.id)}
							<button class="ver" class:sel={v.id === selectedVersionId} onclick={() => selectVersion(v)}>
								<span class="ver-top">
									<span class="badge {versionBadge(v)}">{v.status === 'draft' ? m.blockedit_ver_draft() : v.id === detail.current_version_id ? m.blockedit_ver_live() : m.blockedit_ver_past()}</span>
									<span class="mono">v{v.version}</span>
									<span class="ver-date">{fullDate(v.published_at ?? v.created_at, locale.current)}</span>
								</span>
								{#if v.author}<span class="ver-author">{m.blockedit_ver_by({ name: v.author.name })}</span>{/if}
								{#if v.changelog?.trim()}<span class="ver-changelog">{v.changelog}</span>{/if}
							</button>
						{/each}
					</div>
				</div>
			</aside>
			{/if}
		</div>
		{/if}
	{/if}
</div>

<style>
	.page { max-width: 1180px; }
	h1 { font-family: var(--font-display); font-size: 26px; margin: 4px 0; color: var(--c-midnight); }
	.back { font-size: 12.5px; color: var(--c-teal-dark); font-weight: 500; }
	.edit-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
	.head-meta { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
	.head-actions { display: flex; gap: 8px; flex-shrink: 0; }
	.savetpl { border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); padding: 14px 16px; margin-bottom: 12px; box-shadow: var(--sh-sm); }
	.st-head { display: flex; align-items: center; justify-content: space-between; }
	.st-head strong { font-size: 13.5px; color: var(--c-midnight); }
	.st-x { font-size: 18px; line-height: 1; color: var(--c-faint); padding: 0 4px; background: none; border: none; cursor: pointer; }
	.st-hint { font-size: 12px; color: var(--c-muted); margin: 6px 0 12px; }
	.st-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
	.st-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--c-muted); }
	.st-field input { font-size: 12.5px; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.st-formal { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--c-border); display: flex; flex-direction: column; gap: 12px; }
	.st-formal-hint { font-size: 11.5px; color: var(--c-faint); margin: 0; }
	.st-cond-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-faint); margin-bottom: 6px; }
	.st-cond-row, .st-step-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
	.st-cond-row input, .st-step-row input { flex: 1; min-width: 0; font-size: 12px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.st-step-label { flex: 0 0 30% !important; }
	.st-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
	.mono { font-family: var(--font-mono); font-size: 12.5px; color: var(--c-muted); }
	.status-dot { font-size: 11px; font-weight: 600; text-transform: capitalize; color: var(--c-muted); }
	.status-dot.draft { color: #92400e; }
	.status-dot.stable { color: var(--c-teal-dark); }
	.status-dot.beta { color: var(--c-coral-dark); }
	.ro-note { font-size: 11.5px; color: var(--c-faint); }

	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 8px 15px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn-ghost { background: var(--c-white); color: var(--c-ink); border: 1px solid var(--c-border); font-weight: 500; font-size: 13px; padding: 8px 14px; border-radius: var(--r); }
	.btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn-danger { background: var(--c-coral-dark); color: #fff; border: none; font-weight: 600; font-size: 13px; padding: 8px 15px; border-radius: var(--r); cursor: pointer; }
	.btn-danger:disabled { opacity: 0.45; cursor: not-allowed; }
	.del-confirm-q { font-size: 13px; color: var(--c-coral-dark); font-weight: 500; align-self: center; max-width: 360px; }
	.btn-mini { font-size: 11.5px; color: var(--c-teal-dark); font-weight: 600; }

	.layout { display: grid; grid-template-columns: 1fr 280px; gap: 20px; align-items: start; }
	.main { min-width: 0; }
	.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--c-border); }
	.tab { padding: 10px 14px; font-size: 13px; color: var(--c-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 500; }
	.tab.active { color: var(--c-midnight); border-bottom-color: var(--c-teal); }
	.tab:hover:not(.active) { color: var(--c-ink); }
	.tab-body { padding-top: 18px; }

	.impl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 12.5px; color: var(--c-muted); font-family: var(--font-mono); }
	.impl-badges { display: flex; align-items: center; gap: 6px; }
	.lint-state { font-size: 11.5px; color: var(--c-muted); }
	.src-tag { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 999px; margin-inline-end: 4px; }
	.src-tag.type { background: var(--c-violet-light); color: #5b21b6; }
	.src-tag.scan { background: var(--c-amber-light); color: #92400e; }
	.json-area { width: 100%; min-height: 320px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; padding: 14px 16px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-surface); color: var(--c-ink); resize: vertical; }
	.hint { font-size: 12.5px; color: var(--c-muted); margin: 0 0 10px; }
	.hint code, li code { font-family: var(--font-mono); font-size: 11.5px; background: var(--c-surface-2); padding: 1px 5px; border-radius: var(--r-sm); }

	.perms { display: flex; flex-direction: column; gap: 4px; margin-bottom: 22px; }
	.toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--c-border); }
	.t-label { font-size: 13px; font-weight: 500; color: var(--c-ink); }
	.t-sub { font-size: 11.5px; color: var(--c-muted); margin-top: 1px; }
	.toggle { width: 36px; height: 20px; background: var(--c-border-strong); border-radius: 10px; position: relative; transition: background 0.15s; flex-shrink: 0; }
	.toggle::after { content: ''; position: absolute; top: 2px; inset-inline-start: 2px; width: 16px; height: 16px; background: #fff; border-radius: 50%; box-shadow: var(--sh-sm); transition: transform 0.15s; }
	.toggle.on { background: var(--c-teal); }
	.toggle.on::after { transform: translateX(16px); }
	/* The knob's start edge is logical (inset-inline-start), so in RTL a positive
	   translateX slid it off the outside of the track. Negate X under RTL. */
	:global([dir='rtl']) .toggle.on::after { transform: translateX(-16px); }
	.toggle:disabled { opacity: 0.5; cursor: not-allowed; }
	/* The static replacement for the network toggle. Muted and unboxed on purpose: it must not read
	   as a control in any state — not "off", not "disabled", not "locked". */
	.t-unavailable { font-size: 11.5px; color: var(--c-faint); font-style: italic; text-align: end; flex-shrink: 0; max-width: 220px; }

	.io { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
	.io-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-faint); margin-bottom: 8px; }
	.io-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
	.io-name { flex: 1; min-width: 0; }
	.io-enum { width: 100%; margin: 0 0 8px; }
	.io input, .io select, .json-area, .name-input, .slug-input, .id-field select { font-family: inherit; }
	.io-name, .io select, .io-enum { font-size: 12px; padding: 5px 8px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.io-flag { font-size: 11px; color: var(--c-muted); display: inline-flex; align-items: center; gap: 3px; }
	.io-del { color: var(--c-rose); font-size: 16px; line-height: 1; padding: 0 4px; }
	.io-empty { font-size: 12px; color: var(--c-faint); }
	.io-head-actions { display: inline-flex; gap: 10px; }
	.onto-picker { margin-top: 16px; padding: 14px; border: 1px solid var(--c-teal-light); border-radius: var(--r-lg); background: var(--c-teal-pale); }
	.onto-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; color: var(--c-teal-dark); }
	.onto-close { font-size: 18px; line-height: 1; color: var(--c-muted); padding: 0 4px; }
	.onto-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
	.onto-row select { font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }

	.usage { display: flex; gap: 28px; }
	.stat-n { font-family: var(--font-display); font-size: 24px; color: var(--c-midnight); }
	.stat-l { font-size: 11.5px; color: var(--c-muted); margin-top: 2px; }
	.consumers { margin-top: 24px; border-top: 1px solid var(--c-border); padding-top: 16px; }
	.consumers-head { font-size: 12px; font-weight: 600; color: var(--c-ink); margin-bottom: 10px; }
	.consumers-empty { font-size: 12.5px; color: var(--c-muted); margin: 0; }
	.consumers-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
	.consumers-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; margin: 0 -10px; border-radius: var(--r); }
	.consumers-list li:hover { background: var(--c-surface); }
	.consumer-name { font-size: 13px; color: var(--c-ink); text-decoration: none; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.consumer-name:hover { color: var(--c-teal-dark); }
	.consumer-runs { font-size: 12px; color: var(--c-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.consumers-capped { font-size: 11.5px; color: var(--c-muted); margin-top: 10px; }

	.side { display: flex; flex-direction: column; gap: 16px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.card-head { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-faint); padding: 12px 14px; border-bottom: 1px solid var(--c-border); }
	.meta { display: grid; grid-template-columns: 90px 1fr; gap: 6px 8px; padding: 14px; margin: 0; font-size: 12.5px; }
	.meta dt { color: var(--c-muted); }
	.meta dd { margin: 0; color: var(--c-ink); }
	.versions { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
	.ver { display: flex; flex-direction: column; gap: 3px; padding: 8px 8px; border-radius: var(--r); text-align: start; width: 100%; }
	.ver:hover { background: var(--c-surface); }
	.ver.sel { background: var(--c-teal-pale); }
	.ver-top { display: flex; align-items: center; gap: 8px; }
	.ver-date { margin-inline-start: auto; font-size: 11px; color: var(--c-faint); }
	.ver-author { font-size: 11px; color: var(--c-muted); }
	.ver-changelog { font-size: 11.5px; color: var(--c-ink); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.badge { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
	.badge.teal { background: var(--c-teal-light); color: var(--c-teal-dark); }
	.badge.violet { background: var(--c-violet-light); color: #5b21b6; }
	.badge.amber { background: var(--c-amber-light); color: #92400e; }
	.badge.coral { background: var(--c-coral-light); color: var(--c-coral-dark); }
	.badge.outline { background: transparent; color: var(--c-muted); border: 1px solid var(--c-border-strong); }

	.banner { padding: 10px 14px; border-radius: var(--r); font-size: 13px; margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); color: var(--c-teal-dark); border: 1px solid var(--c-teal-light); }
	.banner.error { background: var(--c-coral-pale); color: var(--c-coral-dark); border: 1px solid var(--c-coral-light); }
	.fix-panel { margin-bottom: 14px; }
	.findings { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); border-radius: var(--r-lg); padding: 12px 16px; margin-bottom: 14px; font-size: 13px; color: var(--c-coral-dark); }
	.findings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.findings-head .lnk { font-size: 12.5px; font-weight: 600; color: var(--c-midnight); }
	.findings ul { margin: 8px 0 0; padding-inline-start: 18px; }
	.findings li { margin-bottom: 4px; }
	.findings .ln { color: var(--c-muted); }
	.ln-jump { font: inherit; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
	.ln-jump:hover { color: var(--c-teal-dark); }

	.notice { padding: 28px; text-align: center; color: var(--c-muted); font-size: 13.5px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	.load-skeleton { display: flex; flex-direction: column; gap: 22px; padding: 4px 2px; }
	.ls-head { display: flex; flex-direction: column; gap: 10px; }
	.ls-tabs { display: flex; gap: 16px; }
	.ls-body { display: flex; flex-direction: column; gap: 12px; margin-top: 6px; }

	/* ---- single-page builder: inline editable identity header ---- */
	.head-id { min-width: 0; flex: 1; }
	.name-input { font-family: var(--font-display); font-size: 26px; color: var(--c-midnight); border: none; border-bottom: 2px solid var(--c-border); background: transparent; padding: 2px 0; width: 100%; max-width: 560px; margin: 4px 0 12px; }
	.name-input::placeholder { color: var(--c-faint); }
	.name-input:focus { outline: none; border-bottom-color: var(--c-teal); }
	.id-row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
	.id-field { display: flex; flex-direction: column; gap: 4px; }
	.id-field.grow { flex: 1; min-width: 220px; }
	.id-tag { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--c-faint); }
	.id-field select, .slug-input { font-size: 13px; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: var(--r); background: var(--c-white); color: var(--c-ink); }
	.slug-input { width: 100%; font-family: var(--font-mono); }

	.nb-sub { color: var(--c-muted); font-size: 13px; margin: 0 0 14px; }
	.start-mode { display: inline-flex; gap: 2px; padding: 3px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); margin-bottom: 18px; }
	.sm-btn { font-size: 12.5px; font-weight: 500; color: var(--c-muted); padding: 6px 14px; border-radius: var(--r); }
	.sm-btn.active { background: var(--c-white); color: var(--c-midnight); font-weight: 600; box-shadow: var(--sh-sm); }
	.layout.solo { grid-template-columns: 1fr; }
	/* Build-with-AI: editor buffers on the left, the copilot pane on the right. */
	.layout.assist { grid-template-columns: 1fr minmax(360px, 460px); }
	@media (max-width: 900px) { .layout.assist { grid-template-columns: 1fr; } }
</style>
