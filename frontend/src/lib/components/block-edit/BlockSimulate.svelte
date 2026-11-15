<script lang="ts">
	// Phase 2 Simulate tab — run a SAVED block version ONCE with sample or custom
	// inputs and read the result (outputs, ctx.log, a friendly classified error).
	// Nothing is persisted; this is the developer's "try it" before pinning a test.
	// Runs against the saved version (same as the Testing tab) — save the draft first
	// to simulate fresh edits.
	import { blocksApi, ApiError } from '$lib/api/blocks';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	import type {
		AssertMode,
		BlockDescriptor,
		BlockExample,
		SimulateResult
	} from '$lib/types/blocks';
	import type { DatasetRow } from '$lib/types/datasets';
	import { simulateResultToTestBody, hasPinnableOutput } from '$lib/blocks/save-as-test';
	import type { BlockFixContext } from '$lib/agent/block-fix-driver';
	import BlockResultView from './BlockResultView.svelte';
	import * as m from '$lib/paraglide/messages';
	import { enumOptionLabel } from '$lib/i18n/enum-option-label';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';
	// ⛔ THE LABELLER ALREADY EXISTED, AND THIS FILE WAS ITS LAST HOLDOUT. `RunConsole`,
	// `BlockResultView` and `i18n/block-test-error-label.ts` all render an `ErrorKind` through
	// `errorKindLabel`; the note below interpolated the raw wire token into a Dutch sentence.
	import { errorKindLabel } from '$lib/i18n/error-kind-label';

	let {
		slug,
		version,
		descriptor,
		examples = [],
		onSaved,
		onViewTests,
		onFixWithAI = undefined
	}: {
		slug: string;
		version: string;
		descriptor: BlockDescriptor;
		examples?: BlockExample[];
		/** Called after a run is saved as a test, so the parent can reload the Testing tab. */
		onSaved?: () => void;
		/** Called to switch the editor to the Testing tab (from the saved banner). */
		onViewTests?: () => void;
		/** Phase 4: open the fix copilot with a simulate error's context (editable drafts only). */
		onFixWithAI?: ((ctx: BlockFixContext) => void) | undefined;
	} = $props();

	let inputs = $state<Record<string, unknown>>(blankInputs());
	let datasets = $state<DatasetRow[]>([]);
	// ⚠️ `listAll()` RESOLVES AN OBJECT, NOT AN ARRAY. `items` alone cannot say "there are more
	// datasets than these": `total` is the SERVER's count for the query, `capped` is the walk
	// admitting it stopped at `MAX_DATASET_PAGES` with rows still outstanding.
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);
	// ⛔ NOT `datasets = []` ON FAILURE — see `loadDatasets`. Same fix as the /build inspector
	// (NodeConfigPanel), /submit and the Testing tab, which had the identical swallow.
	let datasetsError = $state<string | null>(null);
	let running = $state(false);
	let error = $state<string | null>(null);
	let result = $state<SimulateResult | null>(null);

	// ---- "Save this run as a test" (Phase 3) ----
	let saveOpen = $state(false);
	let saveName = $state('');
	let saveDesc = $state('');
	let saveAssert = $state<AssertMode>('subset');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let savedName = $state<string | null>(null);

	const canPin = $derived(result ? hasPinnableOutput(result) : false);

	function resetSave() {
		saveOpen = false;
		saving = false;
		saveError = null;
		savedName = null;
		saveName = '';
		saveDesc = '';
		saveAssert = 'subset';
	}

	function openSave() {
		saveError = null;
		savedName = null;
		saveName = '';
		saveDesc = '';
		saveAssert = 'subset';
		saveOpen = true;
	}

	async function submitSave() {
		if (!result || saving) return;
		if (!saveName.trim()) {
			saveError = m.blockedit_test_err_name();
			return;
		}
		saving = true;
		saveError = null;
		try {
			const body = simulateResultToTestBody(result, {
				name: saveName,
				description: saveDesc,
				assertMode: saveAssert
			});
			await blocksApi.createTest(slug, body);
			savedName = body.name;
			saveOpen = false;
			onSaved?.();
		} catch (e) {
			saveError =
				e instanceof ApiError && e.status === 409
					? m.blocksim_save_err_conflict()
					: writeErrorText(e, m.error_save_failed());
		} finally {
			saving = false;
		}
	}

	const inputEntries = $derived(Object.entries(descriptor.inputs));
	/** Does this block have anything the dataset list feeds? Gates the two notices below. */
	const hasDatasetInput = $derived(inputEntries.some(([, spec]) => spec.type === 'dataset'));
	const hasSample = $derived(Boolean(examples?.[0]?.inputs));

	function blankInputs(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [name, spec] of Object.entries(descriptor.inputs)) {
			if (spec.type === 'boolean') out[name] = false;
			else if (spec.type === 'number') out[name] = 0;
			else out[name] = '';
		}
		return out;
	}

	// Rebuild the form when the block/version changes.
	$effect(() => {
		void slug;
		void version;
		inputs = blankInputs();
		result = null;
		error = null;
		resetSave();
	});

	/**
	 * Every dataset this workspace has — not page one of twelve.
	 *
	 * ⛔ WAS `datasetsApi.list()`: PAGE ONE of a 12-per-page endpoint
	 * (backend/src/routes/datasets.ts's `PAGE_SIZE`) poured into a `<select>` with no pager, so a
	 * developer's thirteenth dataset could not be simulated against at all and nothing said so.
	 *
	 * ⛔ AND THE `catch` BLANKED THE LIST, which is how this form says "you have no datasets yet".
	 * A 500 or a dropped connection was therefore reported as a FACT ABOUT THE WORKSPACE. `datasets`
	 * is now LEFT AS IT WAS and the failure gets its own line. `errorText`, not `writeErrorText`:
	 * this is a READ.
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

	function fillFromSample() {
		const sample = examples?.[0]?.inputs;
		if (sample) inputs = { ...blankInputs(), ...sample };
	}

	async function run() {
		if (running) return;
		running = true;
		error = null;
		resetSave();
		// Drop empty-string fields so the backend can auto-fill them from the
		// version's examples / descriptor defaults.
		const payload: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(inputs)) {
			if (v !== '') payload[k] = v;
		}
		try {
			result = await blocksApi.simulate(slug, version, payload);
		} catch (e) {
			error = errorText(e, m.error_action_failed());
		} finally {
			running = false;
		}
	}

	function fmtVal(v: unknown): string {
		if (typeof v === 'string') return v;
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}
</script>

<div class="simulate">
	<p class="intro">{m.blocksim_intro()}</p>

	<div class="form">
		<div class="form-head">
			<span class="form-title">{m.blocksim_inputs_title()}</span>
			{#if hasSample}
				<button class="lnk" onclick={fillFromSample}>{m.blocksim_fill_sample()}</button>
			{/if}
		</div>
		<!-- ⚠️ GATED ON `hasDatasetInput`: a block with no dataset-typed input renders no dropdown,
		     so the state of a list it never offers is not news the reader has a stake in. -->
		{#if datasetsError && hasDatasetInput}
			<div class="banner error" role="alert" data-testid="datasets-error">
				<span>{datasetsError}</span>
				<button type="button" class="lnk" onclick={loadDatasets}>{m.error_load_retry()}</button>
			</div>
		{/if}
		<!-- `role="status"`, not `alert`: nothing failed, the list is merely incomplete. -->
		{#if datasetsCapped && hasDatasetInput}
			<div class="muted small" role="status" data-testid="datasets-capped">
				{m.datasets_picker_capped({
					shown: num(datasets.length, locale.current),
					total: num(datasetsTotal, locale.current)
				})}
				<a href="/datasets">{m.nav_datasets()}</a>
			</div>
		{/if}
		{#if inputEntries.length === 0}
			<div class="muted small">{m.blocksim_no_inputs()}</div>
		{:else}
			{#each inputEntries as [name, spec] (name)}
				<label class="fld inline">
					<span class="in-name">{name}{#if spec.required}<span class="req">*</span>{/if} <span class="in-type">{fieldTypeLabel(spec.type)}</span></span>
					{#if spec.type === 'dataset'}
						<select bind:value={inputs[name]}>
							<option value="">{m.blocksim_pick_dataset()}</option>
							{#each datasets as d (d.slug)}<option value={d.slug}>{d.name} ({d.slug})</option>{/each}
						</select>
						<!-- ⛔ SUPPRESSED WHILE `datasetsError` IS SET: an empty dropdown and a failed fetch
						     look identical, and only one of them means "you have no datasets". -->
						{#if datasets.length === 0 && !datasetsError}
							<span class="muted small" data-testid="datasets-empty-hint">{m.nodecfg_no_datasets()}</span>
						{/if}
					{:else if spec.type === 'boolean'}
						<input type="checkbox" checked={Boolean(inputs[name])} onchange={(e) => (inputs[name] = e.currentTarget.checked)} />
					{:else if spec.type === 'number'}
						<input type="number" value={Number(inputs[name] ?? 0)} oninput={(e) => (inputs[name] = Number(e.currentTarget.value))} />
					{:else if spec.type === 'enum'}
						<select bind:value={inputs[name]}>
							<option value="">{m.blocksim_pick_enum()}</option>
							{#each spec.enum ?? [] as opt (opt)}<option value={opt}>{enumOptionLabel(opt)}</option>{/each}
						</select>
					{:else}
						<input value={fmtVal(inputs[name] ?? '')} oninput={(e) => (inputs[name] = e.currentTarget.value)} />
					{/if}
				</label>
			{/each}
		{/if}
	</div>

	<div class="actions">
		<button class="btn-primary" disabled={running} onclick={run}>
			{running ? m.blocksim_running() : m.blocksim_run()}
		</button>
		{#if result}<span class="meta">{m.blocksim_duration({ ms: num(result.durationMs, locale.current) })}</span>{/if}
	</div>

	{#if error}<div class="banner error">{error}</div>{/if}

	{#if result}
		<div class="result-wrap" class:ok={result.status === 'ok'}>
			<BlockResultView
				status={result.status}
				errorKind={result.error?.kind ?? null}
				errorMessage={result.error?.message ?? null}
				errorRule={result.error?.rule ?? null}
				errorDetail={result.error?.detail ?? null}
				outputs={result.outputs}
				logs={result.logs}
				simulated={descriptor.capabilities?.mockData === true}
				onFixWithAI={result.status === 'error' && onFixWithAI
					? () => onFixWithAI({ origin: 'simulate', errorKind: result!.error?.kind ?? null, errorMessage: result!.error?.message ?? null })
					: undefined}
			/>

			<div class="save-foot">
				{#if savedName}
					<div class="saved">
						<span>{m.blocksim_saved({ name: savedName })}</span>
						{#if onViewTests}
							<button class="lnk" onclick={() => onViewTests?.()}>{m.blocksim_view_tests()}</button>
						{/if}
					</div>
				{:else if saveOpen}
					<div class="save-form">
						<span class="form-title">{m.blocksim_save_title()}</span>
						<label class="fld">
							<span>{m.blocksim_save_name()}<span class="req">*</span></span>
							<input bind:value={saveName} placeholder={m.blocksim_save_name_ph()} />
						</label>
						<label class="fld">
							<span>{m.blocksim_save_desc()}</span>
							<input bind:value={saveDesc} />
						</label>
						{#if result.status === 'error'}
							<!-- ⛔ THE WORD, NOT THE WIRE TOKEN. This read "…die deze fout verwacht (block_throw)."
							     — a fully Dutch sentence with an English enum member in its parentheses, on the
							     one screen where the reader is being asked to CONFIRM what the saved test will
							     assert. `errorKindLabel` is the same function the result pane three elements
							     above already uses for the same value, so the pill and this note can no longer
							     disagree. No new keys: the nine `console_error_kind_*` short names are the
							     family a parenthetical takes (the `blockresult_errkind_*` family is paragraphs).
							     ⚠️ THE `?? 'error'` LITERAL IS GONE, NOT CAST. `errorKindLabel` takes an
							     `ErrorKind`, and 'error' is not one; casting it would reach the `default:` arm
							     by accident rather than by intent. `result.error` is nullable on the type even
							     inside this branch, so the absence gets the labeller's OWN unknown word. -->
							<p class="note">{m.blocksim_save_expect_error_note({ kind: result.error ? errorKindLabel(result.error.kind) : m.console_error_kind_unknown() })}</p>
						{:else if canPin}
							<label class="fld">
								<span>{m.blockedit_test_assert_mode()}</span>
								<select bind:value={saveAssert}>
									<option value="subset">{m.blockedit_test_assert_subset()}</option>
									<option value="exact">{m.blockedit_test_assert_exact()}</option>
								</select>
							</label>
						{:else}
							<p class="note">{m.blocksim_save_smoke_note()}</p>
						{/if}
						{#if saveError}<div class="banner error">{saveError}</div>{/if}
						<div class="save-actions">
							<button class="btn-primary sm" disabled={saving} onclick={submitSave}>
								{m.blocksim_save_submit()}
							</button>
							<button class="lnk" disabled={saving} onclick={() => (saveOpen = false)}>{m.blocksim_save_cancel()}</button>
						</div>
					</div>
				{:else}
					<button class="lnk" onclick={openSave}>{m.blocksim_save_as_test()}</button>
				{/if}
			</div>
		</div>
	{:else if !running}
		<div class="empty">{m.blocksim_empty()}</div>
	{/if}
</div>

<style>
	.simulate { display: flex; flex-direction: column; gap: 12px; }
	.intro { font-size: 12.5px; color: var(--c-muted); margin: 0; }
	.form { border: 1px solid var(--c-border); border-radius: var(--r); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--c-white); }
	.form-head { display: flex; align-items: center; justify-content: space-between; }
	.form-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-faint); }
	.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--c-ink); }
	.fld.inline { flex-direction: row; align-items: center; gap: 10px; }
	.fld.inline .in-name { width: 180px; flex-shrink: 0; font-weight: 400; }
	.fld input, .fld select { font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); font-family: inherit; }
	.fld.inline input:not([type='checkbox']), .fld.inline select { flex: 1; }
	.in-type { color: var(--c-faint); font-size: 11px; font-family: var(--font-mono); }
	.req { color: var(--c-rose); }
	.lnk { font-size: 12px; color: var(--c-teal-dark); font-weight: 500; }
	.actions { display: flex; align-items: center; gap: 12px; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 7px 14px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
	.meta { font-size: 11.5px; color: var(--c-muted); font-family: var(--font-mono); }
	.muted { color: var(--c-muted); }
	.small { font-size: 12px; }
	.empty { padding: 22px; text-align: center; color: var(--c-muted); font-size: 13px; background: var(--c-surface); border: 1px dashed var(--c-border-strong); border-radius: var(--r-lg); }
	.result-wrap { border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); padding: 12px; }
	.result-wrap.ok { border-color: var(--c-teal-light); }
	.banner.error { background: var(--c-coral-pale); color: var(--c-coral-dark); border: 1px solid var(--c-coral-light); padding: 8px 12px; border-radius: var(--r); font-size: 12.5px; }
	.save-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--c-border); }
	.saved { display: flex; align-items: center; gap: 12px; font-size: 12.5px; color: var(--c-teal-dark); font-weight: 500; }
	.save-form { display: flex; flex-direction: column; gap: 8px; }
	.save-form .fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--c-ink); }
	.save-form .fld span { font-weight: 400; color: var(--c-muted); }
	.save-form input, .save-form select { font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); font-family: inherit; }
	.note { font-size: 12px; color: var(--c-muted); margin: 0; }
	.save-actions { display: flex; align-items: center; gap: 12px; margin-top: 2px; }
	.btn-primary.sm { padding: 6px 12px; font-size: 12.5px; }
	.lnk:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
