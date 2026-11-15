// src/lib/i18n/audit-result-label.ts — the ONE place an /audit row's Result cell becomes words, for
// the ROW and for the COLUMN SORT alike.
//
// ⛔ WHY THIS FILE EXISTS AT ALL, GIVEN `flow-summary-label.ts` ALREADY DOES THE WORK. Because the
// Result cell has TWO consumers and they must never disagree about what the cell says:
//
//   • `components/ops/AuditRow.svelte` renders it;
//   • `routes/audit/+page.svelte`'s `sortVal()` orders the table by it.
//
// When `result` was raw English both read the same field and could not drift. The moment the ROW
// started rendering `flowSummaryLabel(...)` and the SORT kept reading `it.result`, the column
// rendered "Handmatig checkpoint" and filed it under M — a table sorted by a string that is not on
// screen, which reads as a broken sort rather than as a localization bug. That divergence was
// introduced by the fix for the /build↔/audit contradiction, and it is exactly the drift a second
// copy of the mapping would keep re-introducing. Hence one function, two call sites, no copy.
//
// The convention it enforces is the one `sortVal`'s `actor` arm already argued for out loud: the
// column sorts by WHAT THE READER CAN SEE, so "Systeem" files under S for a Dutch reader.
//
// ⛔ THIS ADDS NO VOCABULARY AND NO FALLBACK OF ITS OWN. Every decision about which words to use
// lives in `flow-summary-label.ts` and is documented there at length — in particular the three-tier
// fallback that returns `summary` verbatim for a row with no code, an unrecognised code, or missing
// params. `audit_log` is APPEND-ONLY with no backfill, so that branch is how most of the feed
// renders, forever; this adapter must not add a fourth behaviour on top of it.
import { flowSummaryLabel } from './flow-summary-label';
import type { AuditItem } from '$lib/types/audit';

/**
 * The words in `locale` for one audit row's Result cell. `''` when the row has no result at all —
 * the same falsy value both call sites already treat as "nothing to show", so `{#if}` and the sort
 * key agree without either of them special-casing `null`.
 *
 * Takes a `Pick` so a caller cannot hand it half of one row and half of another, and an explicit
 * `locale` because `flowSummaryLabel` formats a date and cannot read the store from a module.
 */
export function auditResultLabel(
	it: Pick<AuditItem, 'result' | 'resultCode' | 'resultParams'>,
	locale: string
): string {
	if (it.result === null || it.result === undefined) return '';
	return flowSummaryLabel(
		{ summary: it.result, summary_code: it.resultCode, summary_params: it.resultParams },
		locale
	);
}
