// src/lib/i18n/block-node-label.ts — the ONE place a graph node becomes a NAME a reader can read.
//
// ⛔ THE DEFECT. `/build` — the product's PRIMARY authoring surface — titled every node on the
// canvas with its ENGLISH HYPHENATED SLUG: `BlockNode.svelte` rendered `{data.slug}`, so a Dutch
// author saw `read-claim-form`, `ai-summarize`, `group-and-count` sitting inches from the palette
// tile that had just called the same block "Claimformulier lezen". `BlockNodeData` has carried a
// `label` all along and nothing rendered it.
//
// ⛔ AND `{data.label}` WOULD HAVE BEEN A SECOND DEFECT, WHICH IS THE ONLY REASON THIS MODULE
// EXISTS RATHER THAN A ONE-WORD EDIT. There are two label sources and NEITHER re-localizes:
//   • a NEW node gets `label: entry.name` from the locale-resolved block API
//     (stores/builder.svelte.ts `addNode`) — correct at the moment it is dropped, and frozen after;
//   • a SAVED flow gets `label: n.label` read straight out of the persisted `flows.graph` JSON
//     (stores/builder-graph.ts `flowToCanvasNodes`, serialized back by `canvasToFlowGraph`) — i.e.
//     frozen in whatever locale its author happened to be using at SAVE time.
// So a flow saved by an English-speaking colleague renders English for ever, and switching the UI
// language does not change it back. The stored label is the WIRE/MACHINE half; the browser owns the
// words. Exactly the split `graph-issue-label.ts` and `flow-summary-label.ts` document at length.
//
// THE RESOLUTION ORDER, and why each rung is where it is:
//   1. `kind === 'foreach'` → the CATALOG string. A loop container is control flow: `newForeachNode`
//      stamps the literal slug `foreach` and the literal label `'For each row'`, the library has
//      never had a block by that name, and `canvasToFlowGraph` PERSISTS both. Localizing at
//      CREATION time would freeze one author's locale into the saved flow for ever, so the fix is
//      always at RENDER time. This arm has to come FIRST or the loop falls through to rung 3 and
//      prints the stored English. (No new message key: `foreach_palette_label` already names this
//      object on the palette tile that creates it, and reusing it is what stops the tile and the
//      node it makes from drifting apart — see `ForeachNode.svelte` for that argument in full.)
//   2. the CURRENT catalog name for the slug — the locale-resolved `name` from `GET /api/blocks`,
//      re-fetched on every language switch. This is the rung that repairs a stale saved label, and
//      it is the whole point of the module: the same node renders "Rijen filteren" in nl and
//      "Filter rows" in en without touching `flows.graph`.
//   3. the PERSISTED `label` — for a block that is not in the current catalog listing at all
//      (archived since the flow was saved, or a listing that has not arrived yet). A stale name is
//      strictly better than a slug: it is still the name a human wrote.
//   4. the SLUG — the last resort, and it is a rung, not a bug. `{''}` in `.cp-node-name` is a node
//      with NO TITLE, which is worse than an English identifier by every measure.
//
// ⚠️ RUNES-FREE ON PURPOSE, AND THE CATALOG ARRIVES AS AN ARGUMENT. Same split as
// `builder-graph.ts` (pure) vs `builder.svelte.ts` (the reactive wrapper): this file is the ORDER,
// unit-testable under the node-env vitest with a plain function as the catalog. The live,
// language-switch-reactive lookup is bound to it once in `$lib/stores/block-catalog.svelte`, which
// is what every render site actually imports.
import * as m from '$lib/paraglide/messages';

/**
 * The three fields a node's display name is resolved from.
 *
 * Structural rather than `BlockNodeData`, so both halves of the round-trip satisfy it: the canvas
 * node's `data` bag AND the persisted `FlowNode` off the wire. `label` is widened to
 * `string | null | undefined` because a graph row written by an older builder, or hand-edited, can
 * be missing it — `FlowNode.label` is declared required and the wire is not bound by a declaration.
 */
export interface NamedNode {
	slug: string;
	label?: string | null;
	kind?: 'block' | 'foreach';
}

/**
 * Is this a name, or an absence wearing a name's type?
 *
 * ⛔ `''` MUST NOT WIN A RUNG. A catalog row with a blank `name`, or a persisted `label: ''`, is
 * indistinguishable from "no value" to the reader — it renders as a node with no title — but it is
 * a perfectly truthy-looking `string` to `??`. Same reading as `has()` in `flow-summary-label.ts`.
 * Whitespace counts as blank for the same reason: `' '` is not a name either.
 */
function has(value: string | null | undefined): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * The reader's name for one graph node.
 *
 * `catalogName` answers `undefined` for "this slug is not in the catalog I currently hold" — which
 * covers three genuinely different situations that all take the same rung: the listing has not
 * arrived yet, the listing failed, or the block was archived between the save and this load. None
 * of them is an error here; each simply means the persisted label is the best name available.
 *
 * ⚠️ NEVER RETURNS THE EMPTY STRING for a node that carries a slug, and `block-node-label.test.ts`
 * asserts that directly rather than as a side effect of the rungs. The only input that can produce
 * `''` is a node with no slug, no label and no `kind` — a corrupt row that has no name to print in
 * any language.
 */
export function blockNodeLabel(
	node: NamedNode,
	catalogName: (slug: string) => string | undefined
): string {
	// Rung 1 — control flow, named by the catalog, never by the graph. See the header.
	if (node.kind === 'foreach') return m.foreach_palette_label();
	// Rung 2 — the CURRENT locale's name for this block, which is what makes a language switch
	// re-title an already-open canvas.
	const current = catalogName(node.slug);
	if (has(current)) return current;
	// Rung 3 — the name frozen into `flows.graph`. Possibly the wrong language; never the wrong node.
	if (has(node.label)) return node.label;
	// Rung 4 — the identifier. Ugly, and still a title.
	return node.slug;
}
