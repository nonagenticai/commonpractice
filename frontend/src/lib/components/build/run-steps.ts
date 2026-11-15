// src/lib/components/build/run-steps.ts — a run trace folded into one row per step, for the
// plain-language "Result" view. The raw trace stays available behind "Details" in RunConsole.
import type { TraceEvent } from '$lib/types/trace';

export type StepState = 'running' | 'done' | 'failed' | 'skipped';

export interface RunStep {
	nodeId: string;
	slug: string;
	state: StepState;
	/** A short one-line form of the output preview (done). Empty when there is nothing. */
	summary: string;
	/** The runner's output preview as sent (JSON text, possibly cut). RunConsole shows it in words
	 *  (`run-output.ts`) and the raw text only to developers and above. */
	preview?: string;
	error?: Extract<TraceEvent, { type: 'node_error' }>;
}

/** Longest summary shown inline; the full value is in Details. */
export const SUMMARY_MAX = 140;

export function shortSummary(text: string, max = SUMMARY_MAX): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Does this node id name a step on the canvas? The host reports a failure that belongs to no step
 * (the test environment never started, a lost run) with `nodeId` '-' or ''. Such an event gets no
 * row: a step named "-" means nothing to the reader, and RunConsole states it under the outcome.
 */
export function isStepNode(nodeId: string): boolean {
	return nodeId !== '' && nodeId !== '-';
}

/** One row per node, in the order the nodes first appeared in the trace. */
export function runSteps(events: readonly TraceEvent[]): RunStep[] {
	const byNode = new Map<string, RunStep>();
	for (const ev of events) {
		switch (ev.type) {
			case 'node_start':
				byNode.set(ev.nodeId, { nodeId: ev.nodeId, slug: ev.slug, state: 'running', summary: '' });
				break;
			case 'node_success':
				byNode.set(ev.nodeId, {
					nodeId: ev.nodeId,
					slug: ev.slug,
					state: 'done',
					summary: shortSummary(ev.outputPreview ?? ''),
					preview: ev.outputPreview ?? ''
				});
				break;
			case 'node_error':
				if (!isStepNode(ev.nodeId)) break;
				byNode.set(ev.nodeId, { nodeId: ev.nodeId, slug: ev.slug, state: 'failed', summary: '', error: ev });
				break;
			case 'node_skipped':
				byNode.set(ev.nodeId, { nodeId: ev.nodeId, slug: ev.slug, state: 'skipped', summary: '' });
				break;
		}
	}
	return [...byNode.values()];
}
