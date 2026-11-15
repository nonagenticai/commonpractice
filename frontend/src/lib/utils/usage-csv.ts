// src/lib/utils/usage-csv.ts — the CSV behind /usage's Export button.
//
// EXTRACTED FROM THE COMPONENT ON PURPOSE. This used to be the body of `exportCsv()` inside
// (tenant)/usage/+page.svelte, tangled up with Blob/anchor/revokeObjectURL plumbing, which made
// it the one artefact on the page that LEAVES THE PRODUCT and the one with no test at all. A file
// a tenant-admin downloads, forwards to finance and pastes into a chargeback spreadsheet deserves
// at least as much scrutiny as the pixels it was copied from. The handler that remains is now
// only blob → click.
//
// It also had a bug that only a test would ever have caught: the per-model rows wrote an EMPTY
// Calls cell. `ModelUsage.calls` exists on the DTO, is rendered NOWHERE in the UI (the BarRows
// are drawn on spend), and was discarded here too — so the one number describing how OFTEN a
// model is used existed in the payload and reached no human anywhere. Fixed below.
//
// ⛔ WHAT THIS FILE IS NOT RESPONSIBLE FOR. Whether platform background work appears in these
// rows at all is decided at the SOURCE, in backend/src/host/usage-metrics.ts (migration 0063):
// all four aggregates exclude `platform_actor` rows, so `data` and `members` are already
// human-only by the time they get here. That matters historically — this exporter is where the
// defect was worst, writing `"member","<a real person's name>","608+n","0.0000"` into a file that
// left the building. Do NOT re-add a filter here: two places deciding the same thing is how they
// come to disagree.
//
// The header row is hard-coded English on purpose. i18n'ing it is an 8-catalogue change
// (catalogs.test.ts enforces exact key-set equality) for a machine-readable artefact whose column
// names are consumed by spreadsheets, not read as prose — a separate decision, not this one.
import type { MemberUsage, TenantUsage } from '$lib/types/admin';

/** RFC4180-ish: quote everything, double any embedded quote. Applied to EVERY cell, including
 *  numbers, so a name containing a comma or a quote can never shift a column. */
const esc = (v: unknown): string => `"${String(v).replace(/"/g, '""')}"`;

/**
 * Build the CSV for one /usage range: a summary row, one row per model, one row per member.
 *
 * `members` is passed in rather than read off `data.byMember` because the table is sorted
 * CLIENT-SIDE and the export must match what the admin is looking at — exporting a different
 * order from the one on screen is how a reader concludes the file is of something else.
 */
export function buildUsageCsv(
	data: TenantUsage,
	members: MemberUsage[],
	rangeDays: number
): string {
	const rows: string[] = [['Section', 'Name', 'Calls', 'Spend (USD)'].map(esc).join(',')];
	rows.push(
		['summary', `Total (${rangeDays}d)`, data.stats.calls, data.stats.spendUsd.toFixed(4)]
			.map(esc)
			.join(',')
	);
	for (const mdl of data.byModel) {
		// `mdl.calls` — was `''`. See the note at the top of this file: it is on the DTO, rendered
		// nowhere in the UI, and this export is the only place it can reach a human.
		rows.push(['model', mdl.model, mdl.calls, mdl.spendUsd.toFixed(4)].map(esc).join(','));
	}
	for (const mem of members) {
		rows.push(['member', mem.name, mem.calls, mem.spendUsd.toFixed(4)].map(esc).join(','));
	}
	return rows.join('\n');
}

/** The download filename for a range, dated. Kept beside the builder so the two cannot drift. */
export function usageCsvFilename(rangeDays: number, now = new Date()): string {
	return `commonpractice-usage-${rangeDays}d-${now.toISOString().slice(0, 10)}.csv`;
}
