// src/lib/i18n/flow-summary-label.ts — the ONE place a flow-history entry becomes words a reader
// can read.
//
// ⛔ THE DEFECT. `flow_snapshots.summary` is authored in backend/src/ai/flow-edit-service.ts and
// backend/src/routes/flows.ts as an ENGLISH sentence — "connected n1.text → n2.text", "Manual
// checkpoint", "Restored snapshot from 2026-08-07T09:12:44.031Z". The server does not know, and
// must not know, who is reading, so that sentence can never be Dutch. Until this module existed
// `FlowHistoryPanel.svelte` rendered `{s.summary}` verbatim in all EIGHT locales — TWICE per row,
// as the body and again as the `title=` tooltip — inside a panel where every other string is
// `m.flow_history_*`. /build is the product's PRIMARY authoring surface, so this was English prose
// in the middle of a Dutch demo, on the screen the demo spends the most time on.
//
// The wire carries the CODE plus the MACHINE FIELDS (`summary_code`, `summary_params`: slugs, node
// ids, edge ids, config keys, a raw ISO instant); the browser owns the words. Same split as
// `graph-issue-label.ts`, `notification-label.ts` and `data-finding-label.ts`, and the recipe is
// documented at length in the first of those — read it before changing this one.
//
// ⛔ THE ENGLISH `summary` STAYS ON THE WIRE, BYTE FOR BYTE. It is not dead weight: it is the
// fallback below, and it is the correct output for the reader that is NOT a browser —
// backend/src/ai/mcp/tools.ts returns the same `EditResult.summary` to an MCP/LLM client at seven
// call sites, where English is right and this module is never involved. That is why 0071 added
// columns instead of replacing one, and why `EditResult` was not widened.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[code]()` does not resolve — there is no runtime object to
// index. The explicit switch is the house idiom (`graph-issue-label.ts`, `data-finding-label.ts`,
// `stage-label.ts`), not a workaround.
//
// ⛔⛔ THE FALLBACK IS PERMANENT, NOT TRANSITIONAL, AND DELETING IT BLANKS REAL ROWS TODAY.
// This is the ONE place this module differs from `graph-issue-label.ts`, and the difference is the
// whole reason this comment is long. A `GraphIssue` is RECOMPUTED on every validate, so its
// mid-roll fallback drains to zero within one deploy and could, in principle, be retired later.
// A SNAPSHOT IS A STORED ROW. 0071 ships NO BACKFILL — and cannot: `connected
// ${source}.${sourceHandle} → ${target}.${targetHandle}` is not re-splittable into four fields
// unambiguously (a node id may itself contain a dot). So:
//
//   • every snapshot written before 0071 has `summary_code === null` FOREVER;
//   • `SNAPSHOT_KEEP = 50` (backend/src/ai/flow-edit-service.ts) only ages those rows out on a flow
//     that keeps being edited — a flow checkpointed twice a year keeps its pre-0071 history until
//     the flow itself is deleted;
//   • and one branch is not a legacy branch at all: a manual checkpoint whose text the USER TYPED
//     is deliberately written with NO code (backend/src/routes/flows.ts), because their own words
//     must come back to them verbatim, in whatever language they typed. That branch produces new
//     code-less rows every day, indefinitely.
//
// So the third branch is how a large and permanent share of the timeline renders. It is not
// scaffolding, it does not "drain", and a future reader who deletes it as dead code turns those
// rows into blanks in all eight locales.
//
// THE THREE BRANCHES:
//   code known + its params present → the catalog sentence                     (the normal path)
//   code known, params MISSING      → `summary`   (old pod mid-roll; a template that grew a field)
//   code absent or UNRECOGNISED     → `summary`   (pre-0071 row; user-typed checkpoint; a code
//                                                  shipped backend-first)
// Interpolating anyway would render "connected undefined.undefined → undefined.undefined" — a
// localized sentence that says strictly LESS than the English one it replaced. An empty string is
// the same absence wearing a different hat, so `has()` rejects `''` too.
import * as m from '$lib/paraglide/messages';
import { fullDate } from '$lib/utils/format';
import type { FlowSnapshotSummary } from '$lib/types/flows';

/**
 * True when `params` carries every one of `keys` as a NON-EMPTY string.
 *
 * Three absences collapse into one test on purpose, because all three produce the same bad
 * sentence: the whole bag missing (pre-0071 row, or an old pod mid-roll), the individual field
 * missing (a template that grew a field), and the field present but `''`. The type predicate is
 * what lets the call sites pass `p.slug` to paraglide without a `!`.
 */
type Params = Record<string, unknown>;
function has<K extends string>(
	p: Params | null | undefined,
	...keys: K[]
): p is Params & Record<K, string> {
	return !!p && keys.every((k) => typeof p[k] === 'string' && p[k] !== '');
}

/**
 * Wrap ONE READABLE TOKEN in a Unicode bidi ISOLATE, so `ar`/`he` cannot reorder it into nonsense.
 *
 * ⛔⛔ THE UNIT IS THE TOKEN THE READER SEES, NOT THE FIELD THE BACKEND SENT. This is the measured
 * defect `graph-issue-label.ts` documents in full, and TWO of the nine sentences here have exactly
 * its shape: `connected {sourceRef} → {targetRef}` (each ref is `node.handle`) and `configured
 * {nodeRef}` (`node.key`). Isolating each FIELD separately would leave the `.` OUTSIDE both
 * isolates; per UAX#9 an isolate collapses to a single neutral, so `⁨…⁩ . ⁨…⁩` is an all-neutral run
 * inside an RTL sentence, resolves to the RTL base level, and THE TWO HALVES SWAP — an Arabic
 * reader sees `text.n1` where the graph says `n1.text`. So the catalogs name the COMPOUND as one
 * placeholder (`{sourceRef}`, `{targetRef}`, `{nodeRef}`) and this module joins the dot BEFORE
 * isolating. Three tests hold that down, and none of them is a COUNT of isolate characters — a
 * presence count PASSES the reversed string, which is the measured way this guard fails silently:
 *   • `flow-summary-label.bidi.test.ts` drives the REAL compiled `ar`/`he` catalogs through
 *     `overwriteGetLocale` and asserts the required shape (`⁨n_4f1a.text⁩`), the forbidden one
 *     (`⁩.⁨`), and the logical order with the isolates stripped;
 *   • `components/build/flow-history-panel.i18n.render.test.ts` asserts the same on the rendered
 *     row, so a fix that bypasses this module is caught too;
 *   • `flow-summary-label.backend-contract.test.ts` asserts all EIGHT catalogs name the compound
 *     and never the raw halves — a translator cannot re-split it in one locale where no LTR render
 *     test would ever look.
 *
 * ⚠️ `inserted {slug} into edge {edgeId}` deliberately does NOT get that treatment, and the reason
 * is the rule rather than the field count: its two operands are separated by real WORDS in every
 * catalog ("into edge", "في الحافة", "לקשת"), and a strong directional run between two isolates
 * fixes their order. The compound rule is about fields joined by a NEUTRAL, not about how many
 * fields a sentence has.
 *
 * ⚠️ AND THE HONEST HALF: on the sentences that interpolate ONE identifier alone between two RTL
 * runs (`added`, `disconnected`, `removed`, `moved`), isolation is a visual no-op for a latin slug.
 * It is kept for the reason `graph-issue-label.ts` gives: a block `slug` is `z.string().min(1)` on
 * the wire and a node id is generated but a slug is not constrained to latin, so for a value like
 * `llm عربي` the no-op becomes real. Cheap, zero-width, LTR-invisible insurance.
 *
 * ⛔ CHARACTERS, NOT `<bdi>` MARKUP, AND THAT IS THE POINT. This returns a plain string that Svelte
 * escapes into a text node; emitting `<bdi>` would need `{@html}` at the render site, injecting
 * backend-supplied slugs into the DOM as HTML. U+2068/U+2069 (FIRST STRONG ISOLATE / POP
 * DIRECTIONAL ISOLATE) are exactly what `<bdi>` compiles down to, and change nothing in the five
 * LTR locales. It also matters HERE more than elsewhere: this string is used as a `title=`
 * attribute too, where markup is not an option at all.
 */
const iso = (v: string): string => `⁨${v}⁩`;

/**
 * The reader's sentence for one flow-history row.
 *
 * `locale` is required because ONE of the nine sentences carries a date (`flow_summary_restored`),
 * and `fullDate` cannot read the store from a module. Takes the whole row rather than
 * `(code, params, summary)` so a call site cannot accidentally pass the summary of one row with the
 * code of another.
 *
 * ⚠️ `summary_code` is typed `string | null | undefined`, not the backend's nine-value union, for
 * the reason `isGraphIssue` spells out: a code shipped backend-first must degrade to its own
 * English sentence, never vanish and never render a bare `flow_summary_forked` token.
 */
export function flowSummaryLabel(
	s: Pick<FlowSnapshotSummary, 'summary' | 'summary_code' | 'summary_params'>,
	locale: string
): string {
	const p = s.summary_params;
	switch (s.summary_code) {
		case 'flow_summary_added':
			if (!has(p, 'slug')) return s.summary;
			return m.flow_summary_added({ slug: iso(p.slug) });

		case 'flow_summary_connected':
			// All four or the English: "connected  → n2.text" names no edge at all.
			if (!has(p, 'source', 'sourceHandle', 'target', 'targetHandle')) return s.summary;
			// ⛔ THE COMPOUND IS ONE ISOLATE, DOT INCLUDED — see `iso` above. The `→` is NOT here: it
			// is punctuation inside a sentence that has to mirror, so the CATALOGS own it and ar/he
			// spell it `←`. That is the whole point of putting it in the catalog rather than
			// concatenating it in this file.
			return m.flow_summary_connected({
				sourceRef: iso(`${p.source}.${p.sourceHandle}`),
				targetRef: iso(`${p.target}.${p.targetHandle}`)
			});

		case 'flow_summary_disconnected':
			if (!has(p, 'edgeId')) return s.summary;
			return m.flow_summary_disconnected({ edgeId: iso(p.edgeId) });

		case 'flow_summary_removed':
			if (!has(p, 'nodeId')) return s.summary;
			return m.flow_summary_removed({ nodeId: iso(p.nodeId) });

		case 'flow_summary_configured':
			if (!has(p, 'nodeId', 'key')) return s.summary;
			// One compound, same rule as `connected`.
			return m.flow_summary_configured({ nodeRef: iso(`${p.nodeId}.${p.key}`) });

		case 'flow_summary_moved':
			if (!has(p, 'nodeId')) return s.summary;
			return m.flow_summary_moved({ nodeId: iso(p.nodeId) });

		case 'flow_summary_inserted':
			if (!has(p, 'slug', 'edgeId')) return s.summary;
			// Two SEPARATE isolates, deliberately — see the note in `iso`.
			return m.flow_summary_inserted({ slug: iso(p.slug), edgeId: iso(p.edgeId) });

		case 'flow_summary_manual_checkpoint':
			// The only code with NO parameters, so it has no mid-roll shape and never falls back —
			// the same exception `graph_issue_cycle` is. The backend persists `summary_params = NULL`
			// for it on purpose.
			//
			// ⛔ AND IT IS NOT THE SAME THING AS THE STRING "Manual checkpoint". This code is written
			// ONLY on the `|| default` branch of POST /api/flows/:id/snapshots. A user who types the
			// words "Manual checkpoint" into the checkpoint box gets `summary_code = null` and lands
			// in `default:` below, where their own text is returned verbatim. Matching on the English
			// prose instead of the code would silently translate a user's own words.
			return m.flow_summary_manual_checkpoint();

		case 'flow_summary_restored':
			if (!has(p, 'at')) return s.summary;
			// ⛔ THE WIRE CARRIES THE RAW ISO AND THE FORMATTING HAPPENS HERE. `fullDate` is the
			// repo's shared dated-fact formatter — "Aug 7, 2026" (en) · "7 aug 2026" (nl) · "7
			// באוג׳ 2026" (he) — so this date is punctuated the same way as every other date in the
			// product instead of as a bare ISO string in the middle of a Dutch sentence.
			//
			// ⚠️ DATE ONLY, NO CLOCK TIME, AND THAT IS A DELIBERATE PAIRING WITH THE ROW ITSELF.
			// `FlowHistoryPanel`'s `fmtAgo()` already renders this row's OWN timestamp as a relative
			// "2 min geleden" directly underneath. Formatting the restored-FROM instant as a second
			// absolute clock time would put two timestamps of near-identical shape two lines apart,
			// one meaning "when the restore happened" and the other "what it rolled back to" —
			// reliably misread as one of them being wrong. Relative-when above, absolute-what below,
			// at different granularities, reads as two different facts. The exact instant is not
			// lost: `summary_params.at` keeps it, and the English `summary` still spells the full
			// ISO for the MCP reader.
			return m.flow_summary_restored({ at: fullDate(p.at, locale) });

		default:
			// Pre-0071 row · user-typed checkpoint text · a tenth code shipped backend-first.
			// See the ⛔⛔ block at the top: this branch is permanent.
			return s.summary;
	}
}
