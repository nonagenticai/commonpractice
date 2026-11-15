// src/lib/home/next-step.ts — which of the four Kaizen steps is THIS reader's next one (W4).
//
// Home teaches the loop as a 4-step strip (report → prioritise → build → put into practice) and
// highlights one step. Pure so the rule is unit-testable: a `$derived` inside the page could not
// be driven from node-env vitest, and "which step is lit" is the whole point of the strip.
//
// Precedence, first match wins:
//   1. a draft flow with blocks on it  → step 3, "Continue building" (unfinished work beats new work)
//   2. nothing submitted yet           → step 1, "Submit a challenge"
//   3. open challenges not yet voted on → step 2, "Review challenges"
//   4. open challenges, all voted on   → step 3, "Build a solution"
//   5. nothing open                    → step 4, the solutions
import type { HomeSummary } from '$lib/types/marketplace';
import type { FlowListItem } from '$lib/types/flows';

export type StepId = 'report' | 'prioritise' | 'build' | 'practice';
export type StepAction = 'submit' | 'vote' | 'continue' | 'build' | 'results';

export interface NextStep {
	step: StepId;
	action: StepAction;
	href: string;
}

export interface NextStepInput {
	submittedTotal: number;
	/** Open challenges shown on Home that this reader has NOT voted on. */
	unvotedOpen: number;
	/** Open challenges shown on Home at all. */
	open: number;
	/** The reader's most recent draft flow that has at least one block, or null. */
	draftFlowId: string | null;
}

/** The four steps in order, each with the page it links to when it is not the highlighted one. */
export const STEPS: ReadonlyArray<{ id: StepId; href: string }> = [
	{ id: 'report', href: '/submit' },
	{ id: 'prioritise', href: '/challenges' },
	{ id: 'build', href: '/build' },
	{ id: 'practice', href: '/solutions' }
];

export function nextStep(input: NextStepInput): NextStep {
	if (input.draftFlowId) {
		return { step: 'build', action: 'continue', href: `/build?id=${encodeURIComponent(input.draftFlowId)}` };
	}
	if (input.submittedTotal <= 0) return { step: 'report', action: 'submit', href: '/submit' };
	if (input.unvotedOpen > 0) return { step: 'prioritise', action: 'vote', href: '/challenges' };
	if (input.open > 0) return { step: 'build', action: 'build', href: '/build' };
	return { step: 'practice', action: 'results', href: '/solutions' };
}

/** The newest draft with blocks on it. `/build` creates an empty "Untitled" draft on first visit,
 *  so an EMPTY draft is not unfinished work and must not claim the reader's next step. */
export function latestDraftWithWork(items: readonly FlowListItem[]): string | null {
	const drafts = items
		.filter((f) => f.status === 'draft' && f.node_count > 0)
		.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
	return drafts[0]?.id ?? null;
}

/** Derive the input from the home payload. `submittedTotal` falls back to the slice length for an
 *  old backend mid-roll — the same fallback the page itself uses. */
export function nextStepInput(data: HomeSummary, draftFlowId: string | null): NextStepInput {
	return {
		submittedTotal: data.yourActivity.submittedTotal ?? data.yourActivity.submitted.length,
		unvotedOpen: data.trending.filter((r) => !r.hasVoted).length,
		open: data.trending.length,
		draftFlowId
	};
}
