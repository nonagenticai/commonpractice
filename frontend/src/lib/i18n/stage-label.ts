// src/lib/i18n/stage-label.ts — the ONE place a pipeline stage becomes words a reader can read.
//
// ⛔ THE DEFECT. Four render sites printed backend-authored ENGLISH into a Dutch UI:
//   • winner/+page.svelte      {step.label}          → "Won vote · Code review · Hardening · …"
//   • winner/+page.svelte      {data.pipeline.stage} → the raw enum: "…staat nu in hardening"
//   • ops/KanbanColumn.svelte  {column.title}        → "In review / Staging · canary / Production"
//   • pipeline/+page.svelte    stage: to             → "…verplaatst → hardening"
// Three of those are hard-coded string maps in the backend (host/pipeline-service.ts,
// routes/pipeline.ts) and the fourth is the database enum. None of them can ever be Dutch: the
// server does not know, and must not know, who is reading. The wire carries the ENUM; the
// browser owns the words.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE. Paraglide compiles ONE function per message
// key and tree-shakes on the import graph, so `m[`pipeline_stage_${key}`]()` does not resolve —
// there is no runtime object to index. An explicit switch is the established idiom in this
// codebase, not a workaround: see `statusLabel` in routes/connectors/+page.svelte and
// `phaseLabel` in components/marketplace/CadenceStrip.svelte.
//
// ⛔ NO `?? step.label` / `?? column.title` FALLBACK AT ANY CALL SITE. Those fields still exist
// on the wire (deliberately — they are deleted one deploy after this one, so an OLD frontend
// against a NEW backend keeps rendering), and reading them "just in case" resurrects the exact
// English this file removes, on the exact card being fixed.
import * as m from '$lib/paraglide/messages';

/** The five timeline steps: the four `pipeline_items.stage` values plus the synthetic `won`
 *  step the winner timeline prepends. */
export type StageKey = 'won' | 'review' | 'hardening' | 'staging' | 'production';

/**
 * The reader's word for a pipeline stage.
 *
 * Takes `string`, not `StageKey`, because two of the four call sites read a field the server
 * typed loosely (`PipelineTimeline.steps[].key`). An unrecognised value returns the RAW KEY —
 * which is what `{data.pipeline.stage}` already rendered before this change, so a stage added
 * server-side ships an ugly word rather than a blank card, and never an English sentence.
 */
export function stageLabel(key: string): string {
	switch (key) {
		case 'won':
			return m.pipeline_stage_won();
		case 'review':
			return m.pipeline_stage_review();
		case 'hardening':
			return m.pipeline_stage_hardening();
		case 'staging':
			return m.pipeline_stage_staging();
		case 'production':
			return m.pipeline_stage_production();
		default:
			return key;
	}
}
