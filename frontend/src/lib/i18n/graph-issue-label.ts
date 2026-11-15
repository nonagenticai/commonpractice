// src/lib/i18n/graph-issue-label.ts — the ONE place a graph-validation refusal becomes words a
// reader can read.
//
// ⛔ THE DEFECT. `GraphIssue.message` is authored in backend/src/exec/flow-validate.ts as an ENGLISH
// sentence — "Node 'llm-summarize' requires input 'prompt'". The server does not know, and must not
// know, who is reading, so that sentence can never be Dutch. Until this module existed the /build
// issue list rendered `{issue.message}` verbatim in all EIGHT locales, at the exact moment a demo
// goes wrong: the flow was refused, and the only text explaining why was in the wrong language.
// The wire carries the RULE plus the machine fields (`detail`: slugs, handle names, FieldType
// tokens); the browser owns the words. Same split as `data-finding-label.ts` and `stage-label.ts`.
//
// ⛔ THE ENGLISH `message` STAYS ON THE WIRE, BYTE FOR BYTE. It is not dead weight: it is the
// fallback below, and it is the correct output for the reader that is NOT a browser —
// backend/src/ai/mcp/tools.ts renders the same `GraphIssue[]` to an MCP/LLM client, where English
// is right and this module is never involved.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[`graph_issue_${rule}`]()` does not resolve — there is no
// runtime object to index. The explicit switch is the house idiom (`data-finding-label.ts`,
// `stage-label.ts`, `run-status-label.ts`), not a workaround.
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
// The two containers share a pod, but the browser reaches the API through the SERVICE, which
// load-balances across old and new pods for the length of a rolling deploy (`maxSurge: 1`,
// `maxUnavailable: 0` — a NEW bundle really is answered by an OLD pod). `detail` arrived WITH this
// change, so `detail === undefined` on a KNOWN rule is a REAL wire shape, not a hypothetical:
//   rule known + its `detail` fields present → the catalog sentence          (the normal path)
//   rule known, `detail` fields MISSING      → `issue.message`               (old backend, mid-roll)
//   rule absent or UNRECOGNISED              → `issue.message`               (backend-first rule)
// Interpolating anyway would render `Edge undefined: 'undefined.undefined'` — a localized sentence
// that says strictly LESS than the English one it replaced. An empty string is the same absence
// wearing a different hat: `“” has no output “”` is worse than the English, so `has()` rejects it.
//
// ⚠️ DELIBERATE DIVERGENCE FROM `complianceLabel`, WHICH RETURNS THE RAW KEY FOR AN UNKNOWN KEY.
// There the panel is a fixed four-row display, so an unknown key can only be a build defect. Here
// the rule already established by api/graph-issues.ts applies: a rule shipped backend-first must
// degrade to its own message, NEVER vanish and never become a bare `nested-foreach` token. The
// English sentence is a worse read than a translated one and an infinitely better read than nothing.
import * as m from '$lib/paraglide/messages';
import type { GraphIssue, GraphIssueDetail } from '$lib/types/flows';

/**
 * True when `detail` carries every one of `keys` as a NON-EMPTY string.
 *
 * Three absences collapse into one test on purpose, because all three produce the same bad
 * sentence: the whole bag missing (mid-roll), the individual field missing (a rule that grew a
 * field), and the field present but `''` (an empty quoted name reads as a product bug). The type
 * predicate is what lets the call sites pass `d.node` to paraglide without a `!`.
 */
function has<K extends keyof GraphIssueDetail>(
	d: GraphIssueDetail | undefined,
	...keys: K[]
): d is GraphIssueDetail & Required<Pick<GraphIssueDetail, K>> {
	return !!d && keys.every((k) => typeof d[k] === 'string' && d[k] !== '');
}

/**
 * Wrap ONE READABLE TOKEN in a Unicode bidi ISOLATE, so `ar`/`he` cannot reorder it into nonsense.
 *
 * ⛔⛔ THE UNIT IS THE TOKEN THE READER SEES, NOT THE FIELD THE BACKEND SENT — and getting that
 * backwards is an ACTIVE REGRESSION, not a missed optimisation. `graph_issue_incompatible_handle_type`
 * is the only sentence whose pattern joins two fields into one compound, `“{sourceNode}.{sourceHandle}”`.
 * Isolating each field SEPARATELY leaves the `.` and the quotes OUTSIDE both isolates; per UAX#9 an
 * isolate collapses to a single neutral, so `« ⁨…⁩ . ⁨…⁩ »` is an all-neutral run between two RTL
 * runs, resolves to the RTL base level, and THE TWO HALVES SWAP. Measured on the real `ar`/`he`
 * catalog strings, two independent ways (bidi-js reordering, and per-character
 * `Range.getBoundingClientRect()` in Chromium under `<html dir="rtl">`):
 *
 *     no isolate    → “… »http-fetch.rows«”      correct
 *     per FIELD     → “… »rows.http-fetch«”      REVERSED — the bug this comment exists to stop
 *     whole COMPOUND→ “… »http-fetch.rows«”      correct
 *
 * So the catalog now names the compound as ONE placeholder (`{source}` / `{target}`) and this module
 * joins the dot before isolating. `graph-issue-label.bidi.test.ts` asserts the ORDER, not a count of
 * isolate characters — the presence count that used to guard this passed the reversed string.
 *
 * ⚠️ AND THE HONEST HALF: on the other ELEVEN rules this call is measurably a NO-OP. Every one of
 * their sentences puts each identifier alone between two RTL runs, where isolation changes nothing —
 * rendering all twelve `ar`/`he` sentences with and without `iso` gives byte-identical visual order
 * for latin slugs, handle names and `FieldType` tokens. It is kept there for ONE measured reason:
 * `slug` is `z.string().min(1)` on the wire (backend/src/routes/flows.ts), so a node slug MAY itself
 * mix direction — and for a value like `llm عربي` the eleven no-ops become real: without isolation
 * the sentence renders `«عربي llm»`, with it `«llm عربي»`. Cheap, zero-width, LTR-invisible
 * insurance on a value the product does not constrain — but it is insurance, not the load-bearing
 * part, and only the compound above is a live defect.
 *
 * ⛔ CHARACTERS, NOT `<bdi>` MARKUP, AND THAT IS THE POINT. This function returns a plain string
 * that Svelte escapes into a text node; emitting `<bdi>` would require `{@html}` at the render
 * site, which would inject backend-supplied slugs and node names into the DOM as HTML. U+2068/U+2069
 * (FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE) are precisely what `<bdi>` compiles down to, are
 * zero-width, and change nothing in the five LTR locales.
 */
export const bidiIsolate = (v: string): string => `⁨${v}⁩`;
/** Local alias — every call site in this module reads better as `iso`. */
const iso = bidiIsolate;

/**
 * The reader's sentence for one graph-validation issue.
 *
 * Takes `string` for `rule` (via the issue), not the backend's 12-value union, for the reason in
 * `isGraphIssue`. `issue.message` is the guaranteed fallback: the backend has always shipped it and
 * keeps shipping it byte-identical, precisely so this function always has something to return.
 */
export function graphIssueLabel(issue: GraphIssue): string {
	const d = issue.detail;
	switch (issue.rule) {
		case 'cycle':
			// The only rule with NO parameters at all, so it has no mid-roll shape: an old pod's
			// `cycle` issue is already complete. Never falls back.
			return m.graph_issue_cycle();

		case 'duplicate-node-id':
			// Guards `ref`, not `detail`: the duplicated id IS the ref, and `ref` predates this
			// change — so this rule reads correctly from an old pod too.
			if (!issue.ref) return issue.message;
			return m.graph_issue_duplicate_node_id({ ref: iso(issue.ref) });

		case 'duplicate-edge-id':
			if (!issue.ref) return issue.message;
			return m.graph_issue_duplicate_edge_id({ ref: iso(issue.ref) });

		case 'edge-missing-source':
			// ⚠️ `sourceNode` here is the edge's raw endpoint ID, not a slug — the node it names is
			// gone from the graph, so there is no slug to take. Same value the English quotes.
			if (!has(d, 'sourceNode')) return issue.message;
			return m.graph_issue_edge_missing_source({ sourceNode: iso(d.sourceNode) });

		case 'edge-missing-target':
			if (!has(d, 'targetNode')) return issue.message;
			return m.graph_issue_edge_missing_target({ targetNode: iso(d.targetNode) });

		case 'unknown-source-handle':
			if (!has(d, 'sourceNode', 'sourceHandle')) return issue.message;
			return m.graph_issue_unknown_source_handle({
				sourceNode: iso(d.sourceNode),
				sourceHandle: iso(d.sourceHandle)
			});

		case 'unknown-target-handle':
			if (!has(d, 'targetNode', 'targetHandle')) return issue.message;
			return m.graph_issue_unknown_target_handle({
				targetNode: iso(d.targetNode),
				targetHandle: iso(d.targetHandle)
			});

		case 'incompatible-handle-type':
			// Six fields, and the sentence is meaningless without any one of them — "gives , but
			// expects " names no problem at all. All six or the English.
			if (
				!has(d, 'sourceNode', 'sourceHandle', 'sourceType', 'targetNode', 'targetHandle', 'targetType')
			)
				return issue.message;
			// ⛔ THE COMPOUND IS ONE ISOLATE, DOT INCLUDED. `“{source}”` is a single placeholder in
			// every catalog precisely so the `.` sits INSIDE the FSI…PDI. Wrapping `sourceNode` and
			// `sourceHandle` separately — which is what this did until the bidi measurement above —
			// renders `»rows.http-fetch«` to an Arabic reader.
			return m.graph_issue_incompatible_handle_type({
				source: iso(`${d.sourceNode}.${d.sourceHandle}`),
				sourceType: iso(d.sourceType),
				target: iso(`${d.targetNode}.${d.targetHandle}`),
				targetType: iso(d.targetType)
			});

		case 'missing-required-input':
			if (!has(d, 'node', 'handle')) return issue.message;
			return m.graph_issue_missing_required_input({ node: iso(d.node), handle: iso(d.handle) });

		case 'missing-descriptor':
			if (!has(d, 'node', 'blockVersion')) return issue.message;
			return m.graph_issue_missing_descriptor({
				node: iso(d.node),
				blockVersion: iso(d.blockVersion)
			});

		case 'nested-foreach':
			if (!has(d, 'node', 'parent')) return issue.message;
			return m.graph_issue_nested_foreach({ node: iso(d.node), parent: iso(d.parent) });

		case 'orphan-loop-body':
			if (!has(d, 'node', 'parent')) return issue.message;
			return m.graph_issue_orphan_loop_body({ node: iso(d.node), parent: iso(d.parent) });

		default:
			return issue.message;
	}
}
