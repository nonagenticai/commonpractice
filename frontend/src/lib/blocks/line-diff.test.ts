// src/lib/blocks/line-diff.test.ts — the unified line diff used by the AI-fix review.
import { describe, it, expect } from 'vitest';
import { diffLines, diffStat } from './line-diff';

describe('diffLines', () => {
	it('marks unchanged lines as context with both line numbers', () => {
		const rows = diffLines('a\nb\nc', 'a\nb\nc');
		expect(rows.every((r) => r.type === 'context')).toBe(true);
		expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c']);
		expect(rows[1]).toMatchObject({ oldLine: 2, newLine: 2 });
	});

	it('detects a single changed line as a remove + add pair', () => {
		const rows = diffLines('a\nb\nc', 'a\nB\nc');
		expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual([
			'context:a',
			'remove:b',
			'add:B',
			'context:c'
		]);
	});

	it('handles a pure insertion', () => {
		const rows = diffLines('a\nc', 'a\nb\nc');
		expect(rows.filter((r) => r.type === 'add').map((r) => r.text)).toEqual(['b']);
		expect(rows.filter((r) => r.type === 'remove')).toHaveLength(0);
	});

	it('handles a pure deletion', () => {
		const rows = diffLines('a\nb\nc', 'a\nc');
		expect(rows.filter((r) => r.type === 'remove').map((r) => r.text)).toEqual(['b']);
		expect(rows.filter((r) => r.type === 'add')).toHaveLength(0);
	});

	it('diffStat counts adds and removes', () => {
		const rows = diffLines('a\nb\nc', 'a\nB\nc\nd');
		expect(diffStat(rows)).toEqual({ added: 2, removed: 1 }); // B + d added, b removed
	});
});
