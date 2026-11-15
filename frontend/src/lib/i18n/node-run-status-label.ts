// src/lib/i18n/node-run-status-label.ts — the ONE place a CANVAS NODE's live run status becomes a
// word a reader can read.
//
// ⛔ THE DEFECT. `BlockNode.svelte` rendered the enum itself into the status dot's tooltip:
//
//     <span class="cp-node-status {data.runtimeStatus}" title={data.runtimeStatus}></span>
//
// so on /build — the product's PRIMARY authoring surface — a Dutch reader hovering the dot on a
// node mid-run got `running` / `ok` / `error` / `skipped`, on a canvas whose port badges two lines
// below were already going through `fieldTypeLabel` and whose header was already going through
// `nodeDisplayName`. The dot has no text of its own, so that tooltip is the ONLY thing on screen
// that says what the colour means.
//
// ⛔⛔ THIS IS NOT `run-status-label.ts` AND MUST NOT BE FOLDED INTO IT — that module says so in its
// own header, about this exact class of merge, and the two enums genuinely differ:
//
//     flow_run_status (run-status-label.ts)   running | ok | partial | failed
//     NodeRuntimeStatus (builder-graph.ts:93) running | ok | error   | skipped
//
// They share `running` and `ok` and disagree on the rest. Routing the node dot through
// `runStatusLabel` would return the RAW enum for `error` and `skipped` — the exact defect — and
// "fixing" that by adding two arms to `runStatusLabel` would put two members into a labeller for a
// vocabulary that has neither, which is the coercion its header rejects. A second enum gets a
// second vocabulary.
//
// ⚠️ AND THE WORDS ARE DELIBERATELY NOT THE `run_status_*` WORDS EVEN WHERE THEY OVERLAP. Those are
// terse lower-case chips for a table cell ("bezig", "ok"); this is a full tooltip on a bare dot,
// where a sentence-case word is what a reader expects. `field-type-label.ts` documents the same
// decision for the same reason: independent backend vocabularies are free to diverge, so they get
// independent keys even when today's value happens to be the same idea.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE: paraglide compiles ONE function per message key
// and tree-shakes on the import graph, so `m[`node_status_${s}`]()` does not resolve — there is no
// runtime object to index. Spelled out at length in `stage-label.ts`, which this mirrors.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a canvas node's live run status.
 *
 * Takes `string`, not the union, and an unrecognised value returns THE RAW ENUM — which is exactly
 * what the tooltip rendered before this change. `runtimeStatus` is written from
 * `runTrace.byNode[n.id]?.status`, i.e. from a trace stream the browser does not own, so a fifth
 * status added server-side and deployed one roll ahead ships an ugly token rather than an EMPTY
 * tooltip. An empty `title` on a bare dot is worse than an ugly one: it removes the only
 * explanation the dot has.
 */
export function nodeRunStatusLabel(status: string): string {
	switch (status) {
		case 'running':
			return m.node_status_running();
		case 'ok':
			return m.node_status_ok();
		case 'error':
			return m.node_status_error();
		case 'skipped':
			return m.node_status_skipped();
		default:
			return status;
	}
}
