<script lang="ts">
	// Phase 2-B Testing tab — per-block, dataset-backed tests that gate publish.
	// Lists the block's tests with their last result for the selected version, lets a
	// platform dev add/edit/delete tests (inputs typed from the descriptor; dataset
	// inputs pick from the Datasets screen), and runs the suite through the real
	// runner over SSE, showing per-test pass/fail + an actual-vs-expected diff.
	import { blocksApi } from '$lib/api/blocks';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	import BlockResultView from './BlockResultView.svelte';
	import type {
		BlockDescriptor,
		BlockTest,
		BlockTestOutcome,
		CreateBlockTestBody,
		AssertMode
	} from '$lib/types/blocks';
	import type { BlockFixContext } from '$lib/agent/block-fix-driver';
	import type { DatasetRow } from '$lib/types/datasets';
	import * as m from '$lib/paraglide/messages';
	import { enumOptionLabel } from '$lib/i18n/enum-option-label';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';

	let {
		slug,
		version,
		descriptor,
		isDraft,
		canAuthor,
		onTestsPassing,
		reloadSignal = 0,
		onFixWithAI = undefined
	}: {
		slug: string;
		version: string;
		descriptor: BlockDescriptor;
		isDraft: boolean;
		/**
		 * May this reader WRITE this block? Listing the suite is `validateAuth` (routes/blocks.ts:683)
		 * — any member may read a block's tests and their last results — but every control below
		 * (add/edit/enable/delete, and the run itself) goes through `authorizeBlockWrite` (:258).
		 * `isDraft` alone was the gate, which is version state, not permission: a member looking at a
		 * draft got the full add/edit/delete row, and "Run all" was never gated at all.
		 */
		canAuthor: boolean;
		onTestsPassing?: (passing: boolean) => void;
		/** Bump from the parent to force a reload (e.g. after a publish gate run). */
		reloadSignal?: number;
		/** Phase 4: open the fix copilot with a failed test's context (only on editable drafts). */
		onFixWithAI?: ((ctx: BlockFixContext) => void) | undefined;
	} = $props();

	let tests = $state<BlockTest[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	// ⛔ SEPARATE FROM `error`, DELIBERATELY. A run's terminal handler ends with `load()`, and
	// `load()` starts by clearing `error` — so a failed run that (correctly) reaches `onEnd` would
	// wipe its own explanation off the screen a moment after showing it, leaving the author with a
	// re-enabled button and no reason. The run's failure and the list's failure are two different
	// failures with two different lifetimes; only the list's is invalidated by a successful reload.
	let runError = $state<string | null>(null);
	let running = $state(false);
	// Live per-test outcomes keyed by testId (override last_result while a run streams).
	let liveResults = $state<Record<string, BlockTestOutcome>>({});
	let datasets = $state<DatasetRow[]>([]);
	// ⚠️ `listAll()` RESOLVES AN OBJECT, NOT AN ARRAY — these two fields are why. `items` alone
	// cannot say "there are more datasets than these": `total` is the SERVER's own count and
	// `capped` is the walk admitting it stopped at `MAX_DATASET_PAGES` with rows still outstanding.
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);
	// ⛔ NOT `datasets = []` ON FAILURE — see `loadDatasets` below. Same fix as the /build inspector
	// (NodeConfigPanel) and /submit, which had the identical swallow against the identical list.
	let datasetsError = $state<string | null>(null);

	const datasetInputs = $derived(
		Object.entries(descriptor.inputs).filter(([, s]) => s.type === 'dataset')
	);

	async function load() {
		if (!slug || !version) return;
		loading = true;
		error = null;
		try {
			const res = await blocksApi.listTests(slug, version);
			tests = res.items;
			liveResults = {};
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		// re-load when the block or version changes, or the parent bumps reloadSignal
		void slug;
		void version;
		void reloadSignal;
		load();
	});

	/**
	 * Every dataset this workspace has — not page one of twelve.
	 *
	 * ⛔ WAS `datasetsApi.list()`, i.e. PAGE ONE of a 12-per-page endpoint
	 * (backend/src/routes/datasets.ts's `PAGE_SIZE`) poured into a `<select>` with no pager. A test
	 * author with thirteen datasets could not pin a test against the thirteenth: it was not an
	 * option at all, and nothing on screen said the list was short.
	 *
	 * ⛔ AND THE `catch` BLANKED THE LIST. An empty dropdown is how this tab says "you have no
	 * datasets yet" — so a 500 or a dropped connection was reported to the author as a FACT ABOUT
	 * THEIR WORKSPACE, pointing them at an action (go create a dataset) they had already taken.
	 * `datasets` is now LEFT AS IT WAS: on a first load it is already `[]`; on a failed RETRY the
	 * previously loaded list is still the best option set we have.
	 *
	 * `errorText`, not `writeErrorText`: this is a READ, and `writeErrorText` only prefers the
	 * backend's own sentence on the 400/422/409 a rejected WRITE produces.
	 */
	async function loadDatasets() {
		datasetsError = null;
		try {
			const all: AllDatasets = await datasetsApi.listAll();
			datasets = all.items;
			datasetsTotal = all.total;
			datasetsCapped = all.capped;
		} catch (e) {
			datasetsError = errorText(e, m.challenge_data_load_failed());
		}
	}

	$effect(() => {
		void loadDatasets();
	});

	function statusOf(t: BlockTest): 'pass' | 'fail' | 'error' | 'none' {
		const live = liveResults[t.id];
		if (live) return live.status;
		return t.last_result?.status ?? 'none';
	}
	/**
	 * The outcome to render under a test row: this session's streamed one, else the PERSISTED one.
	 *
	 * ⛔ THE `last_result` HALF IS NEW, AND WITHOUT IT MIGRATION 0072 WOULD BE A COLUMN NOTHING
	 * READS. Measured on main: `last_result` is fetched, typed, shipped in the list DTO, and its
	 * only consumer is `statusOf`'s coloured dot — `error` reached no renderer in the entire
	 * frontend (`grep -rn last_result src/` finds exactly two live uses, both above). So reloading
	 * /block-edit after a failed run showed a red dot and NO explanation at all, and the
	 * localization this component just gained would have applied only to the seconds during which a
	 * run was streaming.
	 *
	 * ⚠️ `diffs` IS `[]` ON THIS PATH AND THAT IS HONEST, NOT A STUB. `block_test_results` has no
	 * diffs column — the expected-vs-actual table is a live-run artifact and always has been. The
	 * panel renders the failure SENTENCE, which is the part that survives; a fabricated empty diff
	 * row would claim the comparison found nothing, which is a different and wrong statement.
	 */
	function outcomeOf(t: BlockTest): BlockTestOutcome | null {
		const live = liveResults[t.id];
		if (live) return live;
		const last = t.last_result;
		if (!last) return null;
		return {
			testId: t.id,
			name: t.name,
			status: last.status,
			actual: last.actual,
			error: last.error,
			errorRule: last.error_rule,
			errorDetail: last.error_detail,
			diffs: [],
			durationMs: last.duration_ms
		};
	}

	function runAll(testId?: string) {
		if (running) return;
		running = true;
		runError = null;
		if (!testId) liveResults = {};
		blocksApi.streamTests(
			slug,
			version,
			{
				onResult: (o) => {
					liveResults = { ...liveResults, [o.testId]: o };
				},
				onSummary: (s) => {
					onTestsPassing?.(s.testsPassing);
				},
				onError: (msg) => {
					runError = msg;
				},
				// The ONLY place `running` is cleared. `streamTests` guarantees this fires exactly
				// once on every terminal outcome — success, non-2xx, dropped connection, abort — so
				// there is no second site here that could fall out of sync with it (see its doc
				// comment for why that guarantee lives in the client and not in this component).
				onEnd: () => {
					running = false;
					void load(); // refresh persisted last_result + re-derive
				}
			},
			testId
		);
	}

	// ---- add / edit drawer ----
	interface FormState {
		id: string | null;
		name: string;
		description: string;
		inputs: Record<string, unknown>;
		extraDatasets: string;
		expectedText: string;
		assert_mode: AssertMode;
		expect_error: boolean;
		expected_error_kind: string;
	}
	let editing = $state<FormState | null>(null);
	let formError = $state<string | null>(null);
	let savingForm = $state(false);

	function blankInputs(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [name, spec] of Object.entries(descriptor.inputs)) {
			if (spec.type === 'boolean') out[name] = false;
			else if (spec.type === 'number') out[name] = 0;
			else out[name] = '';
		}
		return out;
	}

	function openNew() {
		editing = {
			id: null,
			name: '',
			description: '',
			inputs: blankInputs(),
			extraDatasets: '',
			expectedText: '{\n}',
			assert_mode: 'subset',
			expect_error: false,
			expected_error_kind: ''
		};
		formError = null;
	}

	function openEdit(t: BlockTest) {
		editing = {
			id: t.id,
			name: t.name,
			description: t.description ?? '',
			inputs: { ...blankInputs(), ...t.inputs },
			extraDatasets: (t.datasets ?? []).join(', '),
			expectedText: JSON.stringify(t.expected ?? {}, null, 2),
			assert_mode: t.assert_mode,
			expect_error: t.expect_error,
			expected_error_kind: t.expected_error_kind ?? ''
		};
		formError = null;
	}

	function closeForm() {
		editing = null;
		formError = null;
	}

	async function saveForm() {
		if (!editing) return;
		if (!editing.name.trim()) {
			formError = m.blockedit_test_err_name();
			return;
		}
		let expected: Record<string, unknown> | null = null;
		if (!editing.expect_error) {
			try {
				const v = JSON.parse(editing.expectedText || '{}');
				if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
				expected = v;
			} catch {
				formError = m.blockedit_test_err_expected_json();
				return;
			}
		}
		const extras = editing.extraDatasets
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const body: CreateBlockTestBody = {
			name: editing.name.trim(),
			description: editing.description.trim() || undefined,
			inputs: editing.inputs,
			datasets: extras,
			expected: editing.expect_error ? null : expected,
			assert_mode: editing.assert_mode,
			expect_error: editing.expect_error,
			expected_error_kind: editing.expect_error
				? editing.expected_error_kind.trim() || null
				: null
		};
		savingForm = true;
		formError = null;
		try {
			if (editing.id) await blocksApi.patchTest(slug, editing.id, body);
			else await blocksApi.createTest(slug, body);
			closeForm();
			await load();
		} catch (e) {
			formError = writeErrorText(e, m.error_save_failed());
		} finally {
			savingForm = false;
		}
	}

	async function removeTest(t: BlockTest) {
		try {
			await blocksApi.deleteTest(slug, t.id);
			await load();
		} catch (e) {
			error = writeErrorText(e, m.error_delete_failed());
		}
	}

	async function toggleEnabled(t: BlockTest) {
		try {
			await blocksApi.patchTest(slug, t.id, { enabled: !t.enabled });
			await load();
		} catch (e) {
			error = writeErrorText(e, m.error_save_failed());
		}
	}

	const passCount: number = $derived(tests.filter((t) => statusOf(t) === 'pass').length);
	const enabledCount = $derived(tests.filter((t) => t.enabled).length);

	function fmtVal(v: unknown): string {
		if (typeof v === 'string') return v;
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}
</script>

<div class="testing">
	<div class="bar">
		<div class="summary">
			{#if tests.length}
				<span class="count">{m.blockedit_test_passing_count({ pass: num(passCount, locale.current), total: num(tests.length, locale.current) })}</span>
				{#if enabledCount === 0}<span class="warn">{m.blockedit_test_none_enabled()}</span>{/if}
			{:else}
				<span class="muted">{m.blockedit_test_empty()}</span>
			{/if}
		</div>
		<div class="actions">
			{#if isDraft && canAuthor}<button class="btn-ghost" onclick={openNew}>{m.blockedit_test_add()}</button>{/if}
			{#if canAuthor}
				<button class="btn-primary" disabled={running || tests.length === 0} onclick={() => runAll()}>
					{running ? m.blockedit_test_running() : m.blockedit_test_run_all()}
				</button>
			{/if}
		</div>
	</div>

	{#if error}<div class="banner error">{error}</div>{/if}
	{#if runError}<div class="banner error">{runError}</div>{/if}
	{#if loading}
		<div class="muted pad">{m.blockedit_test_loading()}</div>
	{:else if tests.length === 0}
		<div class="empty">{m.blockedit_test_empty_hint()}</div>
	{:else}
		<div class="list">
			{#each tests as t (t.id)}
				{@const st = statusOf(t)}
				{@const oc = outcomeOf(t)}
				<div class="test" class:disabled={!t.enabled}>
					<div class="test-head">
						<span class="dot {st}"></span>
						<div class="test-meta">
							<div class="test-name">
								{t.name}
								{#if t.expect_error}<span class="tag">{m.blockedit_test_tag_expecterror()}</span>{/if}
								{#if !t.enabled}<span class="tag muted">{m.blockedit_test_tag_disabled()}</span>{/if}
							</div>
							{#if t.description}<div class="test-desc">{t.description}</div>{/if}
						</div>
						<div class="test-actions">
							<span class="st-label {st}">{m[`blockedit_test_status_${st}` as 'blockedit_test_status_pass']()}</span>
							{#if isDraft && canAuthor}
								<button class="lnk" onclick={() => toggleEnabled(t)}>{t.enabled ? m.blockedit_test_disable() : m.blockedit_test_enable()}</button>
								<button class="lnk" onclick={() => openEdit(t)}>{m.blockedit_test_edit()}</button>
								<button class="lnk danger" onclick={() => removeTest(t)}>{m.blockedit_test_delete()}</button>
							{/if}
						</div>
					</div>
					{#if oc && oc.status !== 'pass'}
						<div class="result-detail">
							<!-- ⛔ `errorMessage` STAYS THE BACKEND'S ENGLISH and is what `onFixWithAI` still
							     carries: that value ends up in an LLM prompt (BlockFixAssistant), where English
							     is correct. The reader's sentence is composed from `errorRule` + `errorDetail`
							     inside BlockResultView, so one string serves both audiences. -->
							<BlockResultView
								status={oc.status}
								errorMessage={oc.error}
								errorRule={oc.errorRule ?? null}
								errorDetail={oc.errorDetail ?? null}
								diffs={oc.diffs}
								simulated={descriptor.capabilities?.mockData === true}
								onFixWithAI={onFixWithAI
									? () => onFixWithAI({ origin: 'test', errorMessage: oc.error, diffs: oc.diffs, testName: oc.name })
									: undefined}
							/>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if editing}
		<div class="drawer">
			<div class="drawer-head">
				<strong>{editing.id ? m.blockedit_test_edit_title() : m.blockedit_test_new_title()}</strong>
				<button class="lnk" onclick={closeForm}>{m.blockedit_test_close()}</button>
			</div>
			{#if formError}<div class="banner error">{formError}</div>{/if}
			<label class="fld">{m.blockedit_test_field_name()}<input bind:value={editing.name} /></label>
			<label class="fld">{m.blockedit_test_field_desc()}<input bind:value={editing.description} /></label>

			<div class="fld-group">
				<div class="fld-group-title">{m.blockedit_test_field_inputs()}</div>
				{#if Object.keys(descriptor.inputs).length === 0}
					<div class="muted small">{m.blockedit_test_no_inputs()}</div>
				{/if}
				<!-- ⚠️ GATED ON `datasetInputs.length`: a block with no dataset-typed input renders no
				     dataset dropdown, so neither the failure of that list nor its completeness is news
				     the author has any stake in here. -->
				{#if datasetsError && datasetInputs.length > 0}
					<div class="banner error" role="alert" data-testid="datasets-error">
						<span>{datasetsError}</span>
						<button type="button" class="lnk" onclick={loadDatasets}>{m.error_load_retry()}</button>
					</div>
				{/if}
				<!-- ⚠️ `role="status"`, not `alert`: nothing failed. The list arrived and is merely
				     incomplete, and the way out is the screen that pages the whole of it. -->
				{#if datasetsCapped && datasetInputs.length > 0}
					<div class="muted small" role="status" data-testid="datasets-capped">
						{m.datasets_picker_capped({
							shown: num(datasets.length, locale.current),
							total: num(datasetsTotal, locale.current)
						})}
						<a href="/datasets">{m.nav_datasets()}</a>
					</div>
				{/if}
				{#each Object.entries(descriptor.inputs) as [name, spec] (name)}
					<label class="fld inline">
						<span class="in-name">{name}{#if spec.required}<span class="req">*</span>{/if} <span class="in-type">{fieldTypeLabel(spec.type)}</span></span>
						{#if spec.type === 'dataset'}
							<select bind:value={editing.inputs[name]}>
								<option value="">{m.blockedit_test_pick_dataset()}</option>
								{#each datasets as d (d.slug)}<option value={d.slug}>{d.name} ({d.slug})</option>{/each}
							</select>
							<!-- ⛔ SUPPRESSED WHILE `datasetsError` IS SET. An empty dropdown and a failed
							     fetch look identical to the author; only one of them means "you have no
							     datasets", and stating the wrong one sends them off to create a dataset
							     they already own. -->
							{#if datasets.length === 0 && !datasetsError}
								<span class="muted small" data-testid="datasets-empty-hint">{m.nodecfg_no_datasets()}</span>
							{/if}
						{:else if spec.type === 'boolean'}
							<input type="checkbox" checked={Boolean(editing.inputs[name])} onchange={(e) => (editing!.inputs[name] = e.currentTarget.checked)} />
						{:else if spec.type === 'number'}
							<input type="number" value={Number(editing.inputs[name] ?? 0)} oninput={(e) => (editing!.inputs[name] = Number(e.currentTarget.value))} />
						{:else if spec.type === 'enum'}
							<select bind:value={editing.inputs[name]}>
								{#each spec.enum ?? [] as opt (opt)}<option value={opt}>{enumOptionLabel(opt)}</option>{/each}
							</select>
						{:else}
							<input value={fmtVal(editing.inputs[name] ?? '')} oninput={(e) => (editing!.inputs[name] = e.currentTarget.value)} />
						{/if}
					</label>
				{/each}
				{#if datasetInputs.length === 0}
					<label class="fld">{m.blockedit_test_field_extra_datasets()}<input bind:value={editing.extraDatasets} placeholder={m.blockedit_test_extra_datasets_ph()} /></label>
				{/if}
			</div>

			<label class="fld toggle-fld">
				<input type="checkbox" bind:checked={editing.expect_error} />
				{m.blockedit_test_expect_error()}
			</label>
			{#if editing.expect_error}
				<label class="fld">{m.blockedit_test_error_kind()}<input bind:value={editing.expected_error_kind} placeholder="validation" /></label>
			{:else}
				<label class="fld">
					{m.blockedit_test_field_expected()}
					<textarea class="json" bind:value={editing.expectedText} spellcheck="false" dir="ltr"></textarea>
				</label>
				<label class="fld">{m.blockedit_test_assert_mode()}
					<select bind:value={editing.assert_mode}>
						<option value="subset">{m.blockedit_test_assert_subset()}</option>
						<option value="exact">{m.blockedit_test_assert_exact()}</option>
					</select>
				</label>
			{/if}

			<div class="drawer-actions">
				<button class="btn-ghost" onclick={closeForm}>{m.blockedit_test_cancel()}</button>
				<button class="btn-primary" disabled={savingForm} onclick={saveForm}>
					{savingForm ? m.blockedit_test_saving() : m.blockedit_test_save()}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.testing { display: flex; flex-direction: column; gap: 12px; }
	.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.summary { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
	.count { font-weight: 600; color: var(--c-ink); }
	.muted { color: var(--c-muted); }
	.small { font-size: 12px; }
	.warn { color: var(--c-coral-dark); font-size: 12px; }
	.pad { padding: 12px 0; }
	.actions { display: flex; gap: 8px; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 7px 14px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn-ghost { background: var(--c-white); color: var(--c-ink); border: 1px solid var(--c-border); font-weight: 500; font-size: 13px; padding: 7px 13px; border-radius: var(--r); }

	.empty { padding: 22px; text-align: center; color: var(--c-muted); font-size: 13px; background: var(--c-surface); border: 1px dashed var(--c-border-strong); border-radius: var(--r-lg); }

	.list { display: flex; flex-direction: column; gap: 8px; }
	.test { border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); padding: 10px 12px; }
	.test.disabled { opacity: 0.6; }
	.test-head { display: flex; align-items: center; gap: 10px; }
	.test-meta { flex: 1; min-width: 0; }
	.test-name { font-size: 13px; font-weight: 500; color: var(--c-ink); display: flex; align-items: center; gap: 6px; }
	.test-desc { font-size: 11.5px; color: var(--c-muted); margin-top: 1px; }
	.test-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-border-strong); flex-shrink: 0; }
	.dot.pass { background: var(--c-teal); }
	.dot.fail { background: var(--c-rose); }
	.dot.error { background: var(--c-coral-dark); }
	.st-label { font-size: 11.5px; font-weight: 600; text-transform: capitalize; color: var(--c-muted); }
	.st-label.pass { color: var(--c-teal-dark); }
	.st-label.fail { color: var(--c-rose); }
	.st-label.error { color: var(--c-coral-dark); }
	.lnk { font-size: 12px; color: var(--c-teal-dark); font-weight: 500; }
	.lnk.danger { color: var(--c-rose); }
	.tag { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px; background: var(--c-amber-light); color: #92400e; }
	.tag.muted { background: var(--c-surface-2); color: var(--c-muted); }

	.result-detail { margin-top: 8px; border-top: 1px dashed var(--c-border); padding-top: 8px; }

	.drawer { border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-surface); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
	.drawer-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
	.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--c-ink); }
	.fld input, .fld select, .fld textarea { font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); font-family: inherit; }
	.fld.inline { flex-direction: row; align-items: center; gap: 10px; }
	.fld.inline .in-name { width: 180px; flex-shrink: 0; font-weight: 400; }
	.fld.inline input:not([type='checkbox']), .fld.inline select { flex: 1; }
	.in-type { color: var(--c-faint); font-size: 11px; font-family: var(--font-mono); }
	.req { color: var(--c-rose); }
	.fld-group { border: 1px solid var(--c-border); border-radius: var(--r); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--c-white); }
	.fld-group-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-faint); }
	.toggle-fld { flex-direction: row; align-items: center; gap: 8px; }
	.json { min-height: 120px; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; resize: vertical; }
	.drawer-actions { display: flex; gap: 10px; justify-content: flex-end; }
	.banner.error { background: var(--c-coral-pale); color: var(--c-coral-dark); border: 1px solid var(--c-coral-light); padding: 8px 12px; border-radius: var(--r); font-size: 12.5px; }
</style>
