<script lang="ts">
	// Test console (demo.html:2723–2733) — the bottom run-output surface. Session 3
	// streams a real per-node execution trace (SSE) into it: one line per
	// TraceEvent, coloured by kind. Empty-state mirrors the old shell.
	import type { TraceEvent, RunStatus, CostDelta } from '$lib/types/trace';
	import * as m from '$lib/paraglide/messages';
	import { runStatusLabel } from '$lib/i18n/run-status-label';
	import { errorKindLabel } from '$lib/i18n/error-kind-label';
	import { blockTestErrorLabel } from '$lib/i18n/block-test-error-label';
	import { hostFailureText } from './run-error-visibility';
	import { ms, num, usd } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';

	import { isStepNode, runSteps, shortSummary, type RunStep, type StepState } from './run-steps';
	import { safeOutputView, hasOutput, type OutputFormat } from './run-output';
	import { portLabel } from '$lib/i18n/port-label';
	import StepOutput from './StepOutput.svelte';

	let {
		events,
		status,
		nodeCount,
		stepName = (_nodeId: string, slug: string) => slug,
		outputLabel = (_nodeId: string, key: string) => portLabel(key),
		showCost = false,
		showInternalErrors = false
	}: {
		events: TraceEvent[];
		status: 'idle' | RunStatus;
		nodeCount: number;
		/** The block's display name for a step row (/build passes the canvas node's name). */
		stepName?: (nodeId: string, slug: string) => string;
		/** The reader's word for an output key ("rows" → "Rows"); /build passes the block's port label. */
		outputLabel?: (nodeId: string, key: string) => string;
		/**
		 * The trace's LLM calls · tokens · USD suffix. An administrator's number, so the same gate
		 * as the assistant's session cost (`canSeeSessionCost`: tenant_admin and above). Default
		 * FALSE: a mount site that passes nothing shows no spend.
		 */
		showCost?: boolean;
		/**
		 * The raw text of a host failure (unruled `internal` / `timeout`) under Details. Developer
		 * and above (`canSeeInternalErrors`). Default FALSE: everyone else reads the plain message.
		 * The Result view always shows the plain message — the raw text is never a result.
		 *
		 * The same gate decides the rest of what is for block authors only: under Details a developer
		 * reads block identifiers, the blocks' own `[info]` log lines (written in the author's
		 * language, usually English) and each step's raw output text; a member reads block names and
		 * none of the three.
		 */
		showInternalErrors?: boolean;
	} = $props();

	// ⭐ THE DEFAULT VIEW IS "RESULT": one plain-language row per step (block name, done/failed, a
	// short output summary). The raw trace below is unchanged and sits behind "Details".
	const steps = $derived(runSteps(events));
	// A failure the host reports with no step attached (the test environment never started, or the
	// run was lost): `runSteps` gives it no row, so it is stated under the outcome instead.
	const runError = $derived(
		events.find(
			(ev): ev is Extract<TraceEvent, { type: 'node_error' }> => ev.type === 'node_error' && !isStepNode(ev.nodeId)
		) ?? null
	);
	const outcome = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const ev = events[i];
			if (ev.type === 'run_complete') return ev.status;
		}
		return null;
	});
	const STEP_LABEL: Record<StepState, () => string> = {
		running: () => m.build_step_running(),
		done: () => m.build_step_done(),
		failed: () => m.build_step_failed(),
		skipped: () => m.build_step_skipped()
	};
	function outcomeText(st: RunStatus): string {
		if (st === 'ok') return m.build_result_ok();
		if (st === 'partial') return m.build_result_partial();
		if (st === 'failed') return m.build_result_failed();
		return m.build_step_running();
	}
	type NodeError = Extract<TraceEvent, { type: 'node_error' }>;
	/** `raw` false: a host failure reads as the plain message, whatever text the wire carried. A ruled
	 *  error (incl. a ruled `internal` one) is its catalog sentence either way. */
	function errorText(ev: NodeError, raw: boolean): string {
		const plain = hostFailureText(ev);
		if (plain !== null && !raw) return plain;
		return blockTestErrorLabel({ rule: ev.rule, message: ev.error, detail: ev.detail }, locale.current);
	}
	/** A failed step's one-line reason. A finished step's output renders as `StepOutput`, never as text. */
	function stepSummary(s: RunStep): string {
		if (s.error) return shortSummary(errorText(s.error, false));
		return '';
	}
	const fmt: OutputFormat = {
		num: (n) => num(n, locale.current),
		bool: (b) => (b ? m.build_output_yes() : m.build_output_no())
	};

	// Details names a step by its block name for a member, by its identifier for a developer.
	const developer = $derived(showInternalErrors);
	function nodeName(nodeId: string, slug: string): string {
		return developer ? slug : stepName(nodeId, slug);
	}
	/** An upstream block arrives as a slug only; a member reads the name of the step that has it. */
	function slugName(slug: string): string {
		if (developer) return slug;
		const s = steps.find((x) => x.slug === slug);
		return s ? stepName(s.nodeId, slug) : slug;
	}

	let scroller = $state<HTMLDivElement | null>(null);
	// Auto-scroll to the newest line as events arrive.
	$effect(() => {
		void events.length;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	// ⛔ THE DEFECT THIS BLOCK FIXES. The four lines below used to read
	//     ● run ok · 1240ms · 3 llm · 812+204 tok · $0.0041
	//     ✗ fetch-claims · block_throw: Cannot read property 'id' of undefined
	// under a console whose empty-state, run-start and node-start lines were already translated —
	// English words ("run", "llm", "tok") plus TWO raw enums (`run_complete.status`,
	// `node_error.kind`) inside a Dutch surface.
	//
	// ⚠️ WHAT IS DELIBERATELY *NOT* ROUTED THROUGH A MESSAGE KEY:
	//   • `ev.slug` — a block identifier. Translating it breaks the match to the canvas node. It is
	//     printed only for a developer (`nodeName`); a member reads the block's display name
	//     (`stepName`), because a member walk (nl) read `load-dataset` in an otherwise Dutch log.
	//   • `ev.error` WHEN `ev.rule` IS ABSENT — the block author's own message. Still verbatim,
	//     still knowingly. ⛔ BUT THE SENTENCE THAT USED TO SIT HERE WAS TRUE OF ONLY HALF THE
	//     TRAFFIC AND THAT COST SEVEN LOCALES A YEAR OF ENGLISH. It read "arbitrary text the backend
	//     cannot classify. There is no code to localise it from", and `classify()`
	//     (flow-executor.ts:110) funnels the RUNNER'S OWN refusals through the identical field:
	//     "block 'x' lacks the llm capability", "foreach input 'in' must be an array", "no source
	//     for block version …", the two budget messages, and two `.join('; ')` validation sites.
	//     Those ARE composed at known sites from known tokens. They now arrive with `ev.rule` +
	//     `ev.detail` and go through `blockTestErrorLabel`; `ev.rule` ABSENT is what still means
	//     "the author's words" — and it means it soundly, because `kind` does not (`block_throw` is
	//     `classify`'s DEFAULT arm, so it means "unclassified") while `rule` is attached only by a
	//     factory a transpiled block cannot reach.
	//   • the `✓ {slug} · {duration}` frame — it contains no WORDS, only an identifier, a value
	//     and a separator. A message key whose eight values are byte-identical claims a
	//     translation decision nobody made; `data-finding-label.plurals.test.ts` states that rule
	//     for plural categories and it holds here too.
	// The DURATION goes through `ms()` — the same formatter /it-dash uses — rather than a
	// hand-built `${n}ms`, so unit selection happens in one place for the whole app. `ms()` takes
	// `locale.current`: its seconds branch was `(n / 1000).toFixed(2)`, so this console rendered a
	// Dutch reader "1.207 LLM-aanroepen … · 3.46s" — grouped Dutch and English punctuation in ONE
	// sentence.
	//
	// ⛔ THE COST FIGURE IS NOW PUNCTUATED FOR THE READER, AND THE COMMENT THAT USED TO SIT HERE IS
	// WORTH RECORDING BECAUSE IT MISLED. It ended: "Pinned as the single permitted `.toFixed(` in
	// `$lib/utils/format.ts` by icu-number-params.sites.test.ts, so a FOURTH one cannot slip in."
	// Read literally that clause is TRUE — it describes format.ts — but it sat directly above a
	// `.toFixed(4)` in THIS file, which that assertion never read. A dangling referent, not a lie,
	// and a reader who trusted it stopped looking. The guard now scans the whole `src/` tree.
	//
	// ⚠️ FOUR DECIMALS, VIA `usd`'s `digits` PARAMETER. A single cheap-model call rounds to $0.00 at
	// two places, which is the defect 0edaad5 ("Local inference priced $0.00, so the ceiling that
	// guards spend could never fire") already cost this repo once.

	// ⛔ `errorKindLabel` USED TO BE A PRIVATE FUNCTION HERE and is now `$lib/i18n/error-kind-label`.
	// It was moved, not rewritten: `BlockResultView.svelte` renders the same `ErrorKind` on
	// /block-edit and had no mechanism at all — it printed `{errorKind}` into a CSS-uppercased pill,
	// so the same value read "blokfout" in this console and "BLOCK_THROW" one screen over. Two
	// mechanisms for one word is the defect; see that module's header.

	/**
	 * Why a node was skipped.
	 *
	 * Three branches, and the middle one is load-bearing: `flow_runs.trace` is an ARCHIVE, so a
	 * run recorded before `reasonCode` existed replays through this component with `reason` only.
	 * That is not a rolling-deploy window — it lasts as long as the retained history does.
	 */
	function skipReason(ev: Extract<TraceEvent, { type: 'node_skipped' }>): string {
		// `=== undefined`, not truthiness — `upstreamSlug` is a string and '' is a legal slug shape
		// on the wire even though the graph should never produce one.
		if (ev.reasonCode === 'upstream_no_output' && ev.upstreamSlug !== undefined)
			return m.console_trace_reason_upstream_no_output({ slug: slugName(ev.upstreamSlug) });
		return ev.reason;
	}

	function fmtCost(c: CostDelta | undefined): string {
		// `c` is absent when the server stripped it for a member (run-cost-visibility.ts).
		if (!showCost || !c?.llmCalls) return '';
		return ` · ${m.console_trace_cost({
			calls: num(c.llmCalls, locale.current),
			tokensIn: num(c.tokensIn, locale.current),
			tokensOut: num(c.tokensOut, locale.current),
			cost: usd(c.usd, locale.current, 4)
		})}`;
	}

	interface Line {
		cls: string;
		text: string;
	}
	/**
	 * The Details lines. A member gets no `log` lines (a block author's own words, not the product's)
	 * and no raw output; a developer gets both, the output as one line under the step that made it.
	 */
	const lines = $derived.by(() => {
		const out: Line[] = [];
		for (const ev of events) {
			if (ev.type === 'log' && !developer) continue;
			out.push(lineFor(ev));
			if (ev.type === 'node_success' && developer && ev.outputPreview) {
				out.push({ cls: 'dim raw', text: `    ${ev.outputPreview}` });
			}
		}
		return out;
	});
	function lineFor(ev: TraceEvent): Line {
		switch (ev.type) {
			case 'run_start':
				return { cls: 'label', text: `▷ ${m.console_trace_run_started({ count: ev.nodeCount })}` };
			case 'node_start':
				return { cls: 'muted', text: `  → ${m.console_trace_node_running({ slug: nodeName(ev.nodeId, ev.slug) })}` };
			case 'log':
				return { cls: ev.level === 'error' ? 'err' : ev.level === 'warn' ? 'warn' : 'dim', text: `    [${ev.level}] ${ev.msg}` };
			case 'node_success':
				return { cls: 'ok', text: `  ✓ ${nodeName(ev.nodeId, ev.slug)} · ${ms(ev.durationMs, locale.current)}${fmtCost(ev.cost)}` };
			case 'node_error':
				return {
					cls: 'err',
					text: `  ✗ ${nodeName(ev.nodeId, ev.slug)} · ${errorKindLabel(ev.kind)}: ${errorText(ev, showInternalErrors)}`
				};
			case 'node_skipped':
				return { cls: 'warn', text: `  ⊘ ${m.console_trace_node_skipped({ slug: nodeName(ev.nodeId, ev.slug), reason: skipReason(ev) })}` };
			case 'run_complete': {
				const cls = ev.status === 'ok' ? 'ok' : ev.status === 'partial' ? 'warn' : 'err';
				// ⛔ REUSES `runStatusLabel` — `run_complete.status` is the same
				// running|ok|partial|failed vocabulary the /sandboxes run drawer already catalogues.
				return { cls, text: `● ${m.console_trace_run_complete({ status: runStatusLabel(ev.status), duration: ms(ev.totalMs, locale.current) })}${fmtCost(ev.totals)}` };
			}
		}
	}
</script>

<div class="result">
	{#if events.length === 0}
		<p class="idle">{nodeCount === 0 ? m.build_result_idle_empty() : m.build_result_idle()}</p>
	{:else}
		{#if outcome}
			<p class="outcome {outcome}" role="status">{outcomeText(outcome)}</p>
		{/if}
		{#if runError}
			<p class="run-error">{shortSummary(errorText(runError, false))}</p>
		{/if}
		<ol class="steps">
			{#each steps as s (s.nodeId)}
				<li class="step {s.state}">
					<span class="mark" aria-hidden="true"></span>
					<span class="step-name">{stepName(s.nodeId, s.slug)}</span>
					<span class="step-state">{STEP_LABEL[s.state]()}</span>
					{#if stepSummary(s)}<span class="step-summary">{stepSummary(s)}</span>{/if}
					{#if s.state === 'done'}
						{@const view = safeOutputView(s.preview, fmt)}
						{#if hasOutput(view)}
							<div class="step-output"><StepOutput {view} label={(key) => outputLabel(s.nodeId, key)} /></div>
						{/if}
					{/if}
				</li>
			{/each}
		</ol>
		<details class="trace">
			<summary>{m.build_result_details()}</summary>
			<div class="console" bind:this={scroller}>
				{#each lines as l, i (i)}
					<div class="line {l.cls}">{l.text}</div>
				{/each}
				{#if status === 'running'}
					<div class="line dim">  …</div>
				{/if}
			</div>
		</details>
	{/if}
</div>

<style>
	.result {
		height: 100%;
		overflow: auto;
		padding: 12px 18px;
		font-size: 13px;
		color: var(--c-ink);
		background: var(--c-white);
	}
	.idle {
		margin: 0;
		color: var(--c-muted);
	}
	.outcome {
		margin: 0 0 8px;
		font-weight: 600;
	}
	.outcome.ok {
		color: var(--c-emerald);
	}
	.outcome.partial {
		color: #92400e;
	}
	.outcome.failed {
		color: var(--c-rose);
	}
	.run-error {
		margin: 0 0 8px;
		color: var(--c-muted);
		overflow-wrap: anywhere;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.step {
		display: grid;
		grid-template-columns: 10px auto 1fr;
		column-gap: 8px;
		align-items: baseline;
	}
	.mark {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--c-faint);
		align-self: center;
	}
	.step.done .mark {
		background: var(--c-emerald);
	}
	.step.failed .mark {
		background: var(--c-rose);
	}
	.step.running .mark {
		background: var(--c-amber);
	}
	.step-name {
		font-weight: 600;
	}
	.step-state {
		color: var(--c-muted);
	}
	.step.failed .step-state {
		color: var(--c-rose);
	}
	.step-summary {
		grid-column: 2 / -1;
		color: var(--c-muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.step-output {
		grid-column: 2 / -1;
		font-size: 12px;
		min-width: 0;
	}
	.trace {
		margin-top: 10px;
	}
	.trace summary {
		cursor: pointer;
		font-size: 12px;
		color: var(--c-muted);
	}
	.console {
		margin-top: 6px;
		border-radius: var(--r);
		max-height: 240px;
		background: var(--c-midnight);
		color: #cbd5e1;
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 12px 18px;
		overflow: auto;
		min-height: 0;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.line {
		line-height: 1.7;
	}
	.line.muted,
	.line.dim {
		color: #6b7280;
	}
	.label {
		color: #6b7280;
	}
	.ok {
		color: #5eead4;
	}
	.warn {
		color: #fbbf24;
	}
	.err {
		color: #fca5a5;
	}
</style>
