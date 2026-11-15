// src/lib/blocks/descriptor-rows.test.ts — the block editor's save round-trip keeps every property.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromRows, toRows } from './descriptor-rows';

describe('block editor rows round-trip', () => {
	it('keeps the author port label through load → save', () => {
		const inputs = {
			force_ocr: { type: 'boolean' as const, label: 'Always use OCR' },
			file: { type: 'string' as const, required: true }
		};
		const saved = fromRows(toRows(inputs));
		expect(saved.force_ocr).toEqual({ type: 'boolean', label: 'Always use OCR' });
		expect(saved.file).toEqual({ type: 'string', required: true });
	});

	it('keeps the label when the row is renamed or retyped in the editor', () => {
		const rows = toRows({ force_ocr: { type: 'boolean', label: 'Always use OCR' } });
		rows[0]!.name = 'always_ocr';
		expect(fromRows(rows).always_ocr?.label).toBe('Always use OCR');
	});

	it('round-trips enum, pii and required as before', () => {
		const rec = { tone: { type: 'enum' as const, enum: ['short', 'long'], pii: true, required: true } };
		expect(fromRows(toRows(rec))).toEqual(rec);
	});

	it('the block editor page uses these helpers, not a private copy', () => {
		const src = readFileSync(resolve(process.cwd(), 'src/routes/block-edit/+page.svelte'), 'utf8');
		expect(src.length).toBeGreaterThan(1000);
		expect(src).toContain("from '$lib/blocks/descriptor-rows'");
		expect(src).not.toMatch(/function (toRows|fromRows)\(/);
	});
});
