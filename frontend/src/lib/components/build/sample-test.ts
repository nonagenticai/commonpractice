// src/lib/components/build/sample-test.ts — W8/P4 "Test with this challenge's sample data".
//
// `POST /api/runs { flowId, sampleChallengeId }` answers with `sampleTest.binding` (which step read
// which sample data) and, as for any run, the data-contract findings. This module turns both into
// words a business reader can act on — "Amount is not a number in 3 rows" — instead of the raw
// `dataset.column → attribute` reference, which stays available behind "Details".
import * as m from '$lib/paraglide/messages';
import type { DataValidationFinding } from '$lib/types/flows';
import { dataFindingLabel } from '$lib/i18n/data-finding-label';
import { blockTestErrorLabel } from '$lib/i18n/block-test-error-label';
import type { TraceEvent } from '$lib/types/trace';
import { isStepNode, runSteps } from './run-steps';
import { hostFailureText } from './run-error-visibility';

export interface SampleBinding {
	nodeId: string;
	input: string;
	slug: string;
	source: 'challenge' | 'already' | 'entity_block';
}

/** The `sampleTest` envelope off a run's success body, structurally checked — or null. */
export function sampleBindingFrom(body: unknown): SampleBinding | null {
	if (typeof body !== 'object' || body === null) return null;
	const st = (body as Record<string, unknown>).sampleTest;
	if (typeof st !== 'object' || st === null) return null;
	const b = (st as Record<string, unknown>).binding;
	if (typeof b !== 'object' || b === null) return null;
	const o = b as Record<string, unknown>;
	if (typeof o.nodeId !== 'string' || typeof o.input !== 'string' || typeof o.slug !== 'string') return null;
	const source = o.source === 'already' || o.source === 'entity_block' ? o.source : 'challenge';
	return { nodeId: o.nodeId, input: o.input, slug: o.slug, source };
}

/** An attribute key as a reader would write it: `claimAmount` / `claim_amount` → "Claim amount". */
export function fieldLabel(attribute: string): string {
	const spaced = attribute
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_\-.]+/g, ' ')
		.trim()
		.toLowerCase();
	return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : attribute;
}

/** The expected kind of value, in words. */
function expectedLabel(expected: string): string {
	switch (expected) {
		case 'number':
			return m.build_sample_expected_number();
		case 'string':
			return m.build_sample_expected_text();
		case 'boolean':
			return m.build_sample_expected_boolean();
		case 'date':
			return m.build_sample_expected_date();
		default:
			return m.build_sample_expected_other();
	}
}

/** One finding as a plain sentence. Unknown rules (or an older backend without `count`) fall back
 *  to the general finding label, so nothing is ever silently dropped. */
export function friendlyFinding(f: DataValidationFinding): string {
	const field = fieldLabel(f.attribute);
	if (f.rule === 'type_mismatch' && f.count && f.expected !== undefined) {
		return m.build_sample_finding_type({ field, count: f.count, expected: expectedLabel(f.expected) });
	}
	if (f.rule === 'pii_uncovered') return m.build_sample_finding_pii({ field });
	return dataFindingLabel(f);
}

export interface StepNode {
	id: string;
	label: string;
	/** The dataset slugs the node's config points at. */
	datasets: string[];
}

export interface FriendlyFinding {
	/** The step the finding is about (by its canvas name), when one can be named. */
	step: string | null;
	text: string;
}

/** Each finding with the step that reads its dataset. The bound step wins for its own dataset. */
export function friendlyFindings(
	findings: DataValidationFinding[],
	steps: StepNode[],
	binding: SampleBinding | null
): FriendlyFinding[] {
	const stepFor = (dataset: string): string | null => {
		if (binding && binding.slug === dataset) {
			const bound = steps.find((s) => s.id === binding.nodeId);
			if (bound) return bound.label;
		}
		return steps.find((s) => s.datasets.includes(dataset))?.label ?? null;
	};
	return findings.map((f) => ({ step: stepFor(f.dataset), text: friendlyFinding(f) }));
}

/** What the "Test with this challenge's sample data" area shows. */
export type SampleTestView =
	| { state: 'running' }
	| {
			state: 'done';
			binding: SampleBinding | null;
			findings: DataValidationFinding[];
			/** The run the test started — its OUTCOME decides between "it fits" and the failure. */
			runId?: string | null;
	  }
	| { state: 'none_linked' }
	| { state: 'no_input'; dataBlock: { slug: string; name: string } | null };

/** The 422 a sample test answers when there is nothing to test with or nowhere to put it, as a
 *  view — or null for any other failure (which the page reports in its normal run error). */
export function sampleRefusalView(code: string, details: Record<string, unknown> | undefined): SampleTestView | null {
	if (code === 'sample_none_linked') return { state: 'none_linked' };
	if (code === 'sample_no_data_input') {
		const b = details?.dataBlock;
		const ok =
			typeof b === 'object' && b !== null &&
			typeof (b as Record<string, unknown>).slug === 'string' &&
			typeof (b as Record<string, unknown>).name === 'string';
		return { state: 'no_input', dataBlock: ok ? (b as { slug: string; name: string }) : null };
	}
	return null;
}

/** The live run the page is streaming, as the panel needs it. */
export interface SampleRunState {
	runId: string | null;
	events: readonly TraceEvent[];
	/** The page is still streaming this run. */
	active: boolean;
}

export type SampleRunOutcome =
	| { state: 'running' }
	| { state: 'passed' }
	| { state: 'failed'; failures: FriendlyFinding[] }
	/** No trace for this run (another run replaced it, or the stream broke before the end): say
	 *  nothing rather than guess — the page's own run error covers a broken stream. */
	| { state: 'unknown' };

/**
 * What the sample test's RUN actually did. ⛔ THE SUCCESS LINE ("the sample data matches what each
 * step expects") MAY ONLY COME FROM `passed`. It used to render as soon as the start request
 * answered with no data-contract findings — i.e. before the run had executed — so a member saw
 * "fits every step" right above "Claim data · Failed: 'amount' must be a number".
 */
export function sampleRunOutcome(
	runId: string | null | undefined,
	run: SampleRunState | null | undefined,
	steps: StepNode[],
	locale: string
): SampleRunOutcome {
	if (!runId || !run || run.runId !== runId) return { state: 'unknown' };
	let complete: Extract<TraceEvent, { type: 'run_complete' }> | null = null;
	for (const ev of run.events) if (ev.type === 'run_complete') complete = ev;
	if (!complete) return run.active ? { state: 'running' } : { state: 'unknown' };
	type NodeError = Extract<TraceEvent, { type: 'node_error' }>;
	// ⛔ A HOST FAILURE (unruled `internal` / `timeout`) carries pod/kubectl/watchdog text. The reader
	// gets the plain message, as in RunConsole's Result view; a ruled error keeps its catalog sentence.
	const text = (ev: NodeError) =>
		hostFailureText(ev) ?? blockTestErrorLabel({ rule: ev.rule, message: ev.error, detail: ev.detail }, locale);
	const failures: FriendlyFinding[] = [
		...runSteps(run.events)
			.filter((st) => st.state === 'failed' && st.error)
			.map((st) => ({ step: steps.find((n) => n.id === st.nodeId)?.label ?? null, text: text(st.error!) })),
		// A failure the host reports against no step (`runSteps` gives it no row).
		...run.events
			.filter((ev): ev is NodeError => ev.type === 'node_error' && !isStepNode(ev.nodeId))
			.map((ev) => ({ step: null, text: text(ev) }))
	];
	if (complete.status === 'ok' && failures.length === 0) return { state: 'passed' };
	return { state: 'failed', failures };
}
