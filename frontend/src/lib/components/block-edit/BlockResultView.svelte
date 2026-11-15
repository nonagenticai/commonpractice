<script lang="ts">
	// Phase 2 — shared renderer for a block run result (a saved test outcome OR a
	// one-off simulate). Extracted from BlockTesting so the error message + diff
	// table live in one place; enriched with a plain-language explanation per
	// ErrorKind, plus optional outputs + ctx.log rendering for the Simulate tab.
	import type { BlockTestDiff } from '$lib/types/blocks';
	import type { BlockErrorDetail, ErrorKind, LogLevel } from '$lib/types/trace';
	import * as m from '$lib/paraglide/messages';
	import { llmSettingsPath } from '$lib/i18n/llm-settings-path';
	import { locale } from '$lib/stores/locale.svelte';
	// ⚠️ TWO KEY FAMILIES, BOTH NEEDED. `errorKindLabel` gives the SHORT NAME in the pill
	// (`console_error_kind_*`, shared with the run console — one value, one mechanism); `kindHint`
	// below gives the PARAGRAPH under it (`blockresult_errkind_*`). Folding either into the other
	// puts a sentence in a 10.5px badge, or a badge where an explanation belongs.
	import { errorKindLabel } from '$lib/i18n/error-kind-label';
	// ⛔ THE THIRD KEY FAMILY, AND IT IS THE ONE THAT SAYS WHAT IS WRONG. The pill (short name) and
	// the paragraph (per-kind explanation) were already localized; `{errorMessage}` — the sentence
	// naming the actual field, port or value — was rendered raw in all eight locales. See that
	// module's header for why the English stays on the wire and why an ABSENT `errorRule` means the
	// text is the block author's own and must NOT be translated.
	import { blockTestErrorLabel } from '$lib/i18n/block-test-error-label';

	let {
		status,
		errorKind = null,
		errorMessage = null,
		errorRule = null,
		errorDetail = null,
		diffs = null,
		outputs = undefined,
		logs = null,
		simulated = false,
		onFixWithAI = undefined
	}: {
		status: 'ok' | 'pass' | 'fail' | 'error';
		/** Classified kind (simulate sets it) → drives the friendly explanation. */
		errorKind?: ErrorKind | null;
		/**
		 * The BACKEND'S ENGLISH (test outcome or simulate).
		 *
		 * ⛔ STILL RAW ON THE WIRE, DELIBERATELY, AND STILL THE STRING "Fix with AI" USES. The parent
		 * passes this same value into `onFixWithAI({ errorMessage })`, which
		 * `BlockFixAssistant.svelte` puts into an LLM PROMPT — so this prop is simultaneously
		 * browser-facing and machine-facing. Localizing it at the source would have degraded the fix
		 * copilot; localizing it HERE, at the render site, does not.
		 */
		errorMessage?: string | null;
		/** The product rule behind `errorMessage`. NULL ⇒ the block author wrote it; render raw. */
		errorRule?: string | null;
		/** Machine tokens for `errorRule`'s sentence. */
		errorDetail?: BlockErrorDetail | null;
		diffs?: BlockTestDiff[] | null;
		/** Present only when the caller wants outputs rendered (Simulate). undefined = hide. */
		outputs?: Record<string, unknown> | null | undefined;
		logs?: { level: LogLevel; msg: string }[] | null;
		/**
		 * ⛔ THE LAST OF THE FOUR "SIMULATED" SURFACES, AND THE ONE THAT MATTERS MOST.
		 *
		 * The catalogue card, the build palette and the canvas node all label a block BEFORE it is
		 * run. This labels the RESULT — the moment a reader is holding an actual value and deciding
		 * whether to believe it. `ocr-scan` advertised "Tesseract+Claude hybrid OCR" and this panel
		 * rendered `{"text": "Scanned document text (sample 412). Lorem ipsum dolor sit amet."}`
		 * under the heading "Outputs", with nothing anywhere saying the runner had invented it.
		 *
		 * Set from the block's own `descriptor.capabilities.mockData` by the caller (both callers
		 * already hold the descriptor). Defaults FALSE so a caller that does not pass it renders
		 * exactly what it rendered before — the badge is additive, and its absence is never a claim
		 * that a result is real.
		 */
		simulated?: boolean;
		/** Phase 4: when provided, render a "Fix with AI" button on a failure → opens the fix copilot. */
		onFixWithAI?: (() => void) | undefined;
	} = $props();

	const hasFailure = $derived(Boolean(errorKind || errorMessage || diffs?.length));

	const mr = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	// A finite allow-list so a stray kind can't index a missing message key.
	const KNOWN_KINDS: ErrorKind[] = [
		'timeout',
		'validation',
		'block_throw',
		'network_blocked',
		'llm_capped',
		'model_not_allowed',
		'budget_exhausted',
		'flow_error',
		'internal'
	];
	const kindHint = $derived(
		errorKind && KNOWN_KINDS.includes(errorKind) ? mr[`blockresult_errkind_${errorKind}`]({ path: llmSettingsPath() }) : null
	);

	// `locale.current` is read INSIDE the $derived so a language switch re-renders the sentence —
	// `Intl.ListFormat` and the catalog both depend on it, and `reload-on-locale` does not remount
	// this panel.
	const errorText = $derived(
		errorMessage === null || errorMessage === undefined
			? null
			: blockTestErrorLabel(
					{ rule: errorRule, message: errorMessage, detail: errorDetail },
					locale.current
				)
	);

	const showOutputs = $derived(outputs !== undefined);

	function fmtVal(v: unknown): string {
		if (typeof v === 'string') return v;
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}
	function pretty(v: unknown): string {
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}
</script>

<div class="result">
	<!-- ⚠️ AT THE TOP OF THE PANEL, NOT INSIDE `{#if showOutputs}`. The Testing tab renders this
	     component WITHOUT `outputs` (it shows the error + diff table only), so a badge nested in the
	     outputs section would be invisible on exactly the tab where a fixture-backed block's
	     "expected" values were pinned from fixture data in the first place. One placement, both
	     tabs, every status. -->
	{#if simulated}
		<div class="sim-note">
			<span class="sim-badge" title={m.build_example_data()} aria-label={m.build_example_data()}
				><span class="sr-only">{m.block_simulated_badge()}</span></span
			>
			<span class="sim-text">{m.block_simulated_badge_title()}</span>
		</div>
	{/if}
	{#if errorKind || errorMessage}
		<div class="err">
			{#if errorKind}
				<div class="err-head">
					<span class="kind">{errorKindLabel(errorKind)}</span>
					<span class="err-title">{m.blockresult_error_title()}</span>
				</div>
				{#if kindHint}<div class="err-hint">{kindHint}</div>{/if}
			{/if}
			<!-- ⛔ `dir` IS NOW `auto`, NOT `ltr`. The old hard-coded `ltr` was right when this could
			     only ever hold English prose. It now holds a CATALOG SENTENCE, which in `ar`/`he` is
			     RTL — pinning `ltr` would push its punctuation to the wrong end of every line. `auto`
			     keeps the first-strong behaviour that made `ltr` correct for a raw author message
			     (an English stack-trace fragment still renders LTR) while letting a translated
			     sentence follow its own direction. -->
			{#if errorText}<div class="err-msg" dir="auto">{errorText}</div>{/if}
		</div>
	{/if}

	{#if diffs?.length}
		<table class="diff" dir="ltr">
			<thead>
				<tr>
					<th>{m.blockedit_test_diff_path()}</th>
					<th>{m.blockedit_test_diff_expected()}</th>
					<th>{m.blockedit_test_diff_actual()}</th>
				</tr>
			</thead>
			<tbody>
				{#each diffs as d (d.path)}
					<tr>
						<td class="mono">{d.path}</td>
						<td class="mono">{d.kind === 'unexpected' ? '—' : fmtVal(d.expected)}</td>
						<td class="mono">{d.kind === 'missing' ? '—' : fmtVal(d.actual)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if hasFailure && onFixWithAI}
		<div class="fix-row">
			<button class="fix-btn" onclick={() => onFixWithAI?.()}>{m.blockfix_cta()}</button>
		</div>
	{/if}

	{#if showOutputs}
		<div class="section">
			<div class="section-title">{m.blockresult_outputs_title()}</div>
			{#if outputs && Object.keys(outputs).length}
				<pre class="json" dir="ltr">{pretty(outputs)}</pre>
			{:else}
				<div class="muted small">{m.blockresult_no_output()}</div>
			{/if}
		</div>
	{/if}

	{#if logs?.length}
		<div class="section">
			<div class="section-title">{m.blockresult_logs_title()}</div>
			<ul class="logs" dir="ltr">
				{#each logs as l, i (i)}
					<li class="log {l.level}"><span class="lvl">{l.level}</span> {l.msg}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.result { display: flex; flex-direction: column; gap: 10px; }
	/* Amber, matching the catalogue card / palette / canvas node, so one badge reads as one concept
	   across every screen a block appears on. Never the coral error palette: a fixture-backed run
	   has not failed. */
	.sim-note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.sim-badge { flex-shrink: 0; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--c-amber); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.sim-text { font-size: 12px; color: var(--c-muted); }
	.err { border: 1px solid var(--c-coral-light); background: var(--c-coral-pale); border-radius: var(--r); padding: 9px 11px; }
	.err-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
	.kind { font-family: var(--font-mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: var(--c-coral-dark); padding: 1px 7px; border-radius: 999px; }
	.err-title { font-size: 12px; font-weight: 600; color: var(--c-coral-dark); }
	.err-hint { font-size: 12.5px; color: var(--c-ink); line-height: 1.45; }
	.err-msg { font-size: 11.5px; color: var(--c-coral-dark); font-family: var(--font-mono); margin-top: 4px; word-break: break-word; }
	.fix-row { display: flex; }
	.fix-btn { font-size: 12.5px; font-weight: 600; color: #fff; background: var(--c-midnight); padding: 6px 12px; border-radius: var(--r); }

	.diff { width: 100%; border-collapse: collapse; font-size: 11.5px; }
	.diff th { text-align: start; color: var(--c-faint); font-weight: 600; padding: 2px 6px; border-bottom: 1px solid var(--c-border); }
	.diff td { padding: 3px 6px; border-bottom: 1px solid var(--c-surface-2); vertical-align: top; }
	.mono { font-family: var(--font-mono); }

	.section { display: flex; flex-direction: column; gap: 4px; }
	.section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-faint); }
	.json { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-sm); padding: 8px 10px; overflow: auto; white-space: pre; }
	.muted { color: var(--c-muted); }
	.small { font-size: 12px; }

	.logs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
	.log { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-ink); }
	.log .lvl { display: inline-block; min-width: 38px; font-weight: 700; font-size: 10px; text-transform: uppercase; color: var(--c-faint); }
	.log.warn .lvl { color: var(--c-coral-dark); }
	.log.error .lvl { color: var(--c-rose); }
</style>
