// src/lib/components/build/run-output.test.ts — a cut or unreadable output preview still reads as
// something, and never as more than it is.
//
// The runner sends `JSON.stringify(output)` cut at 2048 characters plus `…` (backend
// exec/flow-executor.ts `truncatePreview`). ⛔ THE DEFECT the audit of #458 found: a cut that lands
// INSIDE A STRING — the normal case for an AI block's long text — parsed to nothing and the member
// saw an empty row, where the old panel showed the first 140 characters. And a cut inside a row
// showed that half row as if it were complete.
import { describe, it, expect } from 'vitest';
import { outputView, parsePreview, safeOutputView, plainExcerpt, type OutputView } from './run-output';

const BUDGET = 2048;
/** What the runner sends for `value`. */
function wire(value: unknown): string {
	const s = JSON.stringify(value);
	return s.length > BUDGET ? `${s.slice(0, BUDGET)}…` : s;
}
const LONG = 'De claim van mevrouw Jansen betreft waterschade in de keuken. '.repeat(60);
const fieldText = (v: OutputView, key: string) => {
	const f = v.fields.find((x) => x.key === key);
	return f && f.value.kind === 'text' ? f.value.text : undefined;
};

describe('a cut inside a string', () => {
	it('a top-level long string renders as its clipped text', () => {
		const preview = wire(LONG);
		expect(preview.endsWith('…'), 'precondition: the preview is cut').toBe(true);
		// Read as the string itself, not merely rescued by the excerpt fallback.
		expect(parsePreview(preview)).toEqual({ value: expect.stringMatching(/^De claim.*…$/), cut: true });
		const v = outputView(preview);
		expect(v.text).toMatch(/^De claim van mevrouw Jansen/);
		expect(v.text!.endsWith('…')).toBe(true);
		expect(v.text).not.toContain('"');
	});

	it('{summary: long} renders the summary, clipped', () => {
		const v = outputView(wire({ summary: LONG }));
		expect(fieldText(v, 'summary')).toMatch(/^De claim van mevrouw Jansen.*…$/);
	});

	it('{count: 3, summary: long} keeps the count and clips the summary', () => {
		const v = outputView(wire({ count: 3, summary: LONG }));
		expect(fieldText(v, 'count')).toBe('3');
		expect(fieldText(v, 'summary')).toMatch(/^De claim van mevrouw Jansen.*…$/);
	});
});

describe('a cut inside a row', () => {
	const rows = Array.from({ length: 60 }, (_, i) => ({ id: `value-${i + 1}`, name: `Naam ${i + 1}`, note: 'x'.repeat(20) }));
	const preview = wire({ rows });

	it('drops the half row and counts "at least"', () => {
		const parsed = parsePreview(preview);
		expect(parsed?.cut).toBe(true);
		const got = (parsed!.value as { rows: typeof rows }).rows;
		// Every row that survives is a complete, identical copy of a sent row.
		expect(got.length).toBeGreaterThan(0);
		got.forEach((r, i) => expect(r).toEqual(rows[i]));
		const v = outputView(preview);
		expect(v.table?.atLeast).toBe(true);
		expect(v.table?.count).toBe(got.length);
	});

	it('a cut in the middle of a row value does not keep that row', () => {
		// Cut inside the `name` of row 2: row 2 must not appear as {id: 'value-2', name: 'Na…'}.
		const text = JSON.stringify({ rows: rows.slice(0, 3) });
		const at = text.indexOf('Naam 2') + 2;
		const parsed = parsePreview(`${text.slice(0, at)}…`);
		expect((parsed!.value as { rows: unknown[] }).rows).toEqual([rows[0]]);
	});
});

describe('never empty when a preview exists', () => {
	it('malformed text falls back to its words, without JSON punctuation', () => {
		const v = outputView('{"a": 1, "b": oops}');
		expect(v.text).toBeTruthy();
		expect(v.text).not.toMatch(/[{}"]/);
		expect(v.text).toContain('oops');
	});

	it("'[redacted]' reads as its word", () => {
		expect(outputView('[redacted]').text).toBe('redacted');
	});

	it('plainExcerpt strips brackets and quotes', () => {
		expect(plainExcerpt('{"rows":[{"id":"value-1"')).toBe('rows: id: value-1');
	});

	it('safeOutputView degrades a throw to the excerpt instead of throwing', () => {
		const boom = { num: () => { throw new Error('formatter broke'); }, bool: String };
		expect(() => outputView('{"total": 3}', boom)).toThrow();
		expect(safeOutputView('{"total": 3}', boom).text).toBe('total: 3');
	});
});

// ⛔ Re-audit of #458: a cut INSIDE A JSON ESCAPE (`\`, `\u00`, `\u00e`) made the closed string
// invalid, the repair backed up to the last comma, and the whole text field vanished — about 4.5%
// of realistic AI summaries. Every offset in a window around the runner's budget is tried.
describe('a cut inside an escape, at every offset', () => {
	const para = 'Schade aan de voorruit na "steenslag" op de A2.\nVolgende stap: offerte opvragen — café\u0001 \\ klaar.\n';
	const text = para.repeat(40);
	const window = Array.from({ length: 160 }, (_, i) => BUDGET - 80 + i);
	const cutAt = (s: string, n: number) => `${s.slice(0, n)}…`;

	it('precondition: the window really crosses escapes', () => {
		const s = JSON.stringify({ count: 3, summary: text });
		const ends = window.map((n) => s.slice(0, n));
		expect(ends.some((e) => /[^\\]\\$/.test(e))).toBe(true);
		expect(ends.some((e) => /\\u0{1,3}$/.test(e))).toBe(true);
	});

	it('{count: 3, summary} keeps the summary at every offset', () => {
		const s = JSON.stringify({ count: 3, summary: text });
		for (const n of window) {
			const v = outputView(cutAt(s, n));
			expect(fieldText(v, 'count'), `offset ${n}`).toBe('3');
			expect(fieldText(v, 'summary'), `offset ${n}: summary dropped`).toMatch(/^Schade aan de voorruit.*…$/);
		}
	});

	it('{summary} keeps the summary at every offset', () => {
		const s = JSON.stringify({ summary: text });
		for (const n of window) {
			expect(fieldText(outputView(cutAt(s, n)), 'summary'), `offset ${n}`).toMatch(/^Schade aan de voorruit.*…$/);
		}
	});

	it('a top-level text is read as the string at every offset', () => {
		const s = JSON.stringify(text);
		for (const n of window) {
			const parsed = parsePreview(cutAt(s, n));
			expect(typeof parsed?.value, `offset ${n}`).toBe('string');
			expect(parsed!.value as string, `offset ${n}`).toMatch(/^Schade[\s\S]*…$/);
		}
	});
});

describe('plainExcerpt decodes JSON escapes', () => {
	it('newlines, quotes and \\u escapes read as text; a trailing half escape is dropped', () => {
		const e = plainExcerpt('{"note":"regel 1\\nregel \\"2\\" caf\\u00e9 \\u00…');
		expect(e).toBe('note: regel 1 regel 2 café…');
		expect(e).not.toContain('\\');
	});
});

describe('a rows array the cut emptied', () => {
	it('is marked instead of silently skipped', () => {
		const v = outputView('{"count":3,"rows":[{"id":"va…');
		expect(fieldText(v, 'count')).toBe('3');
		expect(v.fields.find((f) => f.key === 'rows')?.value).toEqual({ kind: 'rowsCut' });
	});

	it('a top-level rows array cut inside its first row is marked too', () => {
		expect(outputView('[{"id":"va…').rowsCut).toBe(true);
	});

	it('a complete empty array is not marked', () => {
		expect(outputView('{"count":0,"rows":[]}').fields.find((f) => f.key === 'rows')).toBeUndefined();
	});
});
