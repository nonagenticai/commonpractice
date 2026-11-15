// src/lib/i18n/port-label.test.ts — ports read as words, not as wire keys.
import { describe, it, expect } from 'vitest';
import { applyPortLabels, humanizeFieldName, portLabel } from './port-label';
import type { BlockDetail } from '$lib/types/blocks';

describe('humanizeFieldName', () => {
	it.each([
		['force_ocr', 'Force OCR'],
		['ocr_used', 'OCR used'],
		['claim_id', 'Claim ID'],
		['source_pdf', 'Source PDF'],
		['callback_url', 'Callback URL'],
		['ai_summary', 'AI summary'],
		['api_key', 'API key'],
		['export_csv', 'Export CSV'],
		['userId', 'User ID'],
		['policyNumber', 'Policy number'],
		['claim-ids', 'Claim IDs'],
		['text', 'Text'],
		['reden', 'Reden'],
		['p0', 'P0']
	])('%s → %s', (input, expected) => {
		expect(humanizeFieldName(input)).toBe(expected);
	});

	it('is sentence case: only the first word is capitalised', () => {
		expect(humanizeFieldName('MAX_ROWS_PER_PAGE')).toBe('Max rows per page');
	});

	it('does not invent an acronym from a longer word that merely starts with one', () => {
		// "identifier" starts with "id", "aim" with "ai" — neither is the acronym.
		expect(humanizeFieldName('identifier')).toBe('Identifier');
		expect(humanizeFieldName('aim')).toBe('Aim');
	});

	it('returns the input unchanged when there is nothing to split', () => {
		expect(humanizeFieldName('')).toBe('');
		expect(humanizeFieldName('__')).toBe('__');
	});
});

describe('portLabel', () => {
	it('prefers the block metadata label', () => {
		expect(portLabel('force_ocr', { label: 'Read scanned pages' })).toBe('Read scanned pages');
	});

	it('falls back to the humanised key when there is no usable label', () => {
		expect(portLabel('force_ocr')).toBe('Force OCR');
		expect(portLabel('force_ocr', null)).toBe('Force OCR');
		expect(portLabel('force_ocr', { label: '   ' })).toBe('Force OCR');
		expect(portLabel('force_ocr', { label: 42 })).toBe('Force OCR');
	});
});

describe('applyPortLabels', () => {
	const detail = (portLabels?: BlockDetail['portLabels']) =>
		({
			slug: 'read-claim-form',
			versions: [
				{
					id: 'v1',
					descriptor: {
						inputs: { file: { type: 'string' }, force_ocr: { type: 'boolean' } },
						outputs: { text: { type: 'string' }, ocr_used: { type: 'boolean' } },
						capabilities: {}
					}
				}
			],
			...(portLabels ? { portLabels } : {})
		}) as unknown as BlockDetail;

	it('puts the resolved locale label on each field, so portLabel renders it instead of the key', () => {
		const d = applyPortLabels(
			detail({ inputs: { force_ocr: 'Altijd OCR gebruiken' }, outputs: { ocr_used: 'OCR gebruikt' } })
		);
		const desc = d.versions[0]!.descriptor;
		expect(portLabel('force_ocr', desc.inputs.force_ocr)).toBe('Altijd OCR gebruiken');
		expect(portLabel('ocr_used', desc.outputs.ocr_used)).toBe('OCR gebruikt');
		// A port the backend sent no label for falls back to the humanised key.
		expect(portLabel('file', desc.inputs.file)).toBe('File');
		expect(desc.inputs.file).not.toHaveProperty('label');
	});

	it('keeps an input and an output with the same key apart', () => {
		const d = applyPortLabels(detail({ inputs: { text: 'Invoer' }, outputs: { text: 'Uitvoer' } }));
		// `text` is only an output here; the input map's `text` must not leak onto it.
		expect(d.versions[0]!.descriptor.outputs.text.label).toBe('Uitvoer');
	});

	it('does not mutate the detail it was given (the block editor may hold the same object)', () => {
		const original = detail({ inputs: { force_ocr: 'Altijd OCR gebruiken' }, outputs: {} });
		applyPortLabels(original);
		expect(original.versions[0]!.descriptor.inputs.force_ocr).not.toHaveProperty('label');
	});

	it('returns a detail from an older backend (no portLabels) unchanged', () => {
		const d = detail();
		expect(applyPortLabels(d)).toBe(d);
	});
});

describe('/build wiring', () => {
	it('the canvas block cache is filled through applyPortLabels', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(process.cwd(), 'src/routes/build/+page.svelte'), 'utf8');
		expect(src.length).toBeGreaterThan(1000);
		// Without this the localized labels arrive on the wire and every port still shows its key.
		expect(src).toMatch(/applyPortLabels\(await blocksApi\.get\(slug\)\)/);
	});
});
