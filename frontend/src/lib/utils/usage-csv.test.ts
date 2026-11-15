// src/lib/utils/usage-csv.test.ts — the /usage export is the one artefact on that page that
// LEAVES THE PRODUCT. It used to be an inline closure in +page.svelte with no test, and it
// carried a defect that only a test could see: every `model` row wrote an EMPTY Calls cell.
// `ModelUsage.calls` is on the DTO, is rendered NOWHERE in the UI (the BarRows are drawn on
// spend), and was discarded here too — so the one number saying how OFTEN a model is used
// reached no human anywhere in the product.
//
// The other half of the story is upstream: before migration 0063 the `member` rows fused a real
// person's calls with 608 platform translation calls into one integer, and this exporter wrote
// `"member","<their name>","608+n","0.0000"` to disk. That is fixed at the SOURCE
// (backend/src/host/usage-metrics.ts excludes `platform_actor` rows from all four aggregates), so
// what this file asserts is that the exporter faithfully renders whatever the backend hands it —
// deliberately NOT that it re-filters. Two places deciding the same thing is how they come to
// disagree.
import { describe, it, expect } from 'vitest';
import { buildUsageCsv, usageCsvFilename } from './usage-csv';
import type { TenantUsage } from '$lib/types/admin';

function usage(over: Partial<TenantUsage> = {}): TenantUsage {
	return {
		rangeDays: 30,
		stats: {
			spendUsd: 1.5,
			calls: 4,
			models: 2,
			members: 2,
			pricing: { provider: 4, table: 0, flat: 0, legacy: 0 }
		},
		byModel: [
			{ model: 'claude-sonnet-4-6', provider: 'anthropic', calls: 3, spendUsd: 1.25, estimated: false },
			{ model: 'demo-model', provider: 'mock', calls: 1, spendUsd: 0.25, estimated: false }
		],
		byDay: [],
		byMember: [],
		...over
	};
}

/** Parse a row back into its cells (every cell is quoted by the builder). */
const cells = (line: string): string[] =>
	(line.match(/"(?:[^"]|"")*"/g) ?? []).map((c) => c.slice(1, -1).replace(/""/g, '"'));

describe('buildUsageCsv', () => {
	it('writes a non-empty NUMERIC Calls cell on every model row', () => {
		// REVERT THAT TURNS THIS RED: restore the original `''` in place of `mdl.calls` in
		// usage-csv.ts — every model row's Calls cell goes back to empty.
		const lines = buildUsageCsv(usage(), [], 30).split('\n');
		const modelRows = lines.filter((l) => l.startsWith('"model"'));
		expect(modelRows).toHaveLength(2);
		for (const row of modelRows) {
			const calls = cells(row)[2]!;
			expect(calls, 'ModelUsage.calls is on the DTO and rendered nowhere else in the UI').not.toBe('');
			expect(calls).toMatch(/^\d+$/);
		}
		expect(cells(modelRows[0]!)).toEqual(['model', 'claude-sonnet-4-6', '3', '1.2500']);
		expect(cells(modelRows[1]!)).toEqual(['model', 'demo-model', '1', '0.2500']);
	});

	it('writes member rows with the HUMAN call count the backend supplied', () => {
		// The backend already excludes platform rows (migration 0063), so a member's `calls` here
		// is that person's own work. This asserts the exporter passes it through unaltered — it
		// must not re-derive, re-filter or "correct" a number it did not compute.
		const members = [
			{ userId: 'u1', name: 'Dana Okafor', calls: 2, spendUsd: 1.25 },
			{ userId: 'u2', name: 'Sam Reyes', calls: 2, spendUsd: 0.25 }
		];
		const lines = buildUsageCsv(usage(), members, 30).split('\n');
		const memberRows = lines.filter((l) => l.startsWith('"member"'));
		expect(memberRows).toHaveLength(2);
		expect(cells(memberRows[0]!)).toEqual(['member', 'Dana Okafor', '2', '1.2500']);
		expect(cells(memberRows[1]!)).toEqual(['member', 'Sam Reyes', '2', '0.2500']);
	});

	it('exports members in the order given, which is the order on screen', () => {
		// The table is sorted client-side; exporting a different order from the one the admin is
		// looking at is how a reader concludes the file is of something else.
		const members = [
			{ userId: 'u2', name: 'Sam Reyes', calls: 2, spendUsd: 0.25 },
			{ userId: 'u1', name: 'Dana Okafor', calls: 2, spendUsd: 1.25 }
		];
		const names = buildUsageCsv(usage(), members, 30)
			.split('\n')
			.filter((l) => l.startsWith('"member"'))
			.map((l) => cells(l)[1]);
		expect(names).toEqual(['Sam Reyes', 'Dana Okafor']);
	});

	it('leads with the header and the range summary', () => {
		const lines = buildUsageCsv(usage(), [], 7).split('\n');
		expect(cells(lines[0]!)).toEqual(['Section', 'Name', 'Calls', 'Spend (USD)']);
		expect(cells(lines[1]!)).toEqual(['summary', 'Total (7d)', '4', '1.5000']);
	});

	it('quotes and escapes a name containing a comma or a quote', () => {
		// A person's name is user data and lands in a file finance opens in a spreadsheet. An
		// unescaped comma shifts every column after it, silently.
		const members = [{ userId: 'u1', name: 'Okafor, D. "Dana"', calls: 1, spendUsd: 0 }];
		const row = buildUsageCsv(usage(), members, 30)
			.split('\n')
			.find((l) => l.startsWith('"member"'))!;
		expect(row).toContain('"Okafor, D. ""Dana"""');
		expect(cells(row)).toEqual(['member', 'Okafor, D. "Dana"', '1', '0.0000']);
	});
});

describe('usageCsvFilename', () => {
	it('names the file by range and date', () => {
		expect(usageCsvFilename(90, new Date('2026-08-07T22:00:00Z'))).toBe(
			'commonpractice-usage-90d-2026-08-07.csv'
		);
	});
});
