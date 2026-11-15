// src/lib/i18n/data-finding-label.ts — the ONE place a data-contract violation becomes words a
// reader can read.
//
// ⛔ THE DEFECT. `DataValidationFinding.message` is authored in backend/src/datasets/
// ontology-validation.ts as an ENGLISH sentence — "…so its values would be injected unredacted."
// The server does not know, and must not know, who is reading, so that sentence can never be Dutch.
// The wire carries the RULE plus the machine fields (dataset, column, attribute, and — new with
// this change — count/expected); the browser owns the words. Same split as `stage-label.ts`.
//
// EXHAUSTIVE SWITCH, NOT A LOOKUP TABLE. Paraglide compiles ONE function per message key and
// tree-shakes on the import graph, so `m[`data_finding_${rule}`]()` does not resolve — there is no
// runtime object to index. The explicit switch is the house idiom (`stage-label.ts`,
// `run-status-label.ts`, `compliance-label.ts`), not a workaround.
//
// ⛔ THE FALLBACK IS THREE-BRANCH, AND THE MIDDLE BRANCH IS LOAD-BEARING.
// The two containers share a pod, but the browser reaches the API through the SERVICE, which
// load-balances across old and new pods for the length of a rolling deploy — so a NEW frontend
// really is answered by an OLD backend. That exact hazard blanked /governance and was caught only
// at review in PR #233. Here it has TWO shapes, because the backend change was additive:
//   rule known + its machine fields present → the catalog message               (the normal path)
//   rule known, `count`/`expected` MISSING  → `finding.message`                 (old backend, mid-roll)
//   rule absent or UNRECOGNISED             → `finding.message`                 (backend-first rule)
//
// ⚠️ DELIBERATE DIVERGENCE FROM `complianceLabel`, WHICH RETURNS THE RAW KEY FOR AN UNKNOWN KEY.
// There, the panel is a fixed four-row display, so an unknown key can only be a build defect and a
// raw `nis2` is the honest way to show it. Here the opposite rule was already established for
// validator findings by api/graph-issues.ts (lines 34-42): a rule shipped backend-first must
// degrade to its own message, NEVER vanish and never become a bare `rule` token — because the
// finding it names may be PII heading into a sandbox in the clear, and a run that ships that
// silently is the whole defect this work exists to fix. The English sentence is a worse read than
// a translated one and an infinitely better read than nothing.
import * as m from '$lib/paraglide/messages';
import type { DataValidationFinding } from '$lib/types/flows';

/**
 * The reader's sentence for one data-contract finding.
 *
 * Takes `string` for `rule` (via the finding), not the backend's two-value union, for the reason in
 * `isDataFinding`. `finding.message` is the guaranteed fallback: the backend has always shipped it
 * and keeps shipping it byte-identical, precisely so this function always has something to return.
 */
export function dataFindingLabel(finding: DataValidationFinding): string {
	switch (finding.rule) {
		case 'pii_uncovered':
			// No machine fields beyond the three addressing ones, which the structural guard already
			// required — so this branch has no mid-roll shape to worry about.
			return m.data_finding_pii_uncovered({
				attribute: finding.attribute,
				column: finding.column,
				dataset: finding.dataset
			});
		case 'type_mismatch':
			// ⛔ THE MID-ROLL BRANCH. `count`/`expected` arrived WITH this change; a backend one
			// deploy behind ships a `type_mismatch` with neither. Interpolating them anyway would
			// print "has undefined values … (expected undefined)" — a localized sentence that says
			// less than the English one it replaced. `0` is a legitimate absence too: the backend
			// only emits this rule when `bad > 0`, so a zero here means the field is not real.
			if (!finding.count || finding.expected === undefined) return finding.message;
			return m.data_finding_type_mismatch({
				count: finding.count,
				column: finding.column,
				attribute: finding.attribute,
				expected: finding.expected
			});
		default:
			return finding.message;
	}
}

/**
 * The `dataset.column → attribute` address the finding is about, rendered beside the sentence.
 *
 * Separate from the sentence because it is the same three fields for BOTH rules and reads as an
 * identifier, not prose: it must not be translated, and it must not be re-derived per call site.
 */
export function dataFindingRef(finding: DataValidationFinding): string {
	return `${finding.dataset}.${finding.column} → ${finding.attribute}`;
}
