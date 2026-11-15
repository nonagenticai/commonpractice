// src/lib/i18n/dataset-label.test.ts — the two dataset enums resolve to catalog copy, and an
// unknown value degrades to itself rather than to nothing.
//
// ⛔ WHAT THE `default:` ARM IS FOR, AND WHY IT IS TESTED HARDER THAN THE MAPPED VALUES. The mapped
// eight-and-five are the easy half. The arm that matters is the one nobody exercises until a deploy
// is half-rolled or an ontology attribute carries a type nobody enumerated: it must return the RAW
// value, because `{''}` inside `<span class="badge teal">` is a coloured rectangle with nothing in
// it — a dataset that appears to have no source at all — which is strictly worse than the English
// token this module exists to remove.
import { describe, it, expect, vi } from 'vitest';

// Real `en` catalog, each key resolving to its own name. The point of this file is WHICH key each
// enum member reaches, never the wording of the translation.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => key;
	}
	return mod;
});

import { datasetSourceLabel, datasetColumnTypeLabel } from './dataset-label';

const SOURCES = ['csv', 'xlsx', 'sql', 'text', 'json', 'postgres', 'storage', 'http'];
const COLUMN_TYPES = ['string', 'number', 'boolean', 'date', 'json'];

describe('datasetSourceLabel', () => {
	it.each(SOURCES)('`%s` resolves to its own catalog key', (t) => {
		expect(datasetSourceLabel(t)).toBe(`dataset_source_${t}`);
	});

	it('covers the whole enum — all eight, no gaps', () => {
		// ⛔ A count, not a spot check: `it.each` over a list I wrote is satisfied by a list that is
		// missing a member. The backend-contract file beside this one is what pins the list ITSELF
		// against `backend/src/db/dataset-types.ts`.
		expect(SOURCES).toHaveLength(8);
		expect(new Set(SOURCES.map(datasetSourceLabel)).size).toBe(8);
	});

	it('AN UNKNOWN SOURCE DEGRADES TO ITSELF — never to empty', () => {
		expect(datasetSourceLabel('s3_glacier')).toBe('s3_glacier');
		// The empty string is the failure this arm prevents, stated as its own assertion.
		expect(datasetSourceLabel('s3_glacier')).not.toBe('');
	});

	it('…and it is not silently prefixing an absent key', () => {
		// A `default:` that returned `dataset_source_${t}` would look identical under the mock above
		// for the mapped values and produce a DANGLING key name for an unmapped one.
		expect(datasetSourceLabel('s3_glacier')).not.toContain('dataset_source_');
	});
});

describe('datasetColumnTypeLabel', () => {
	it.each(COLUMN_TYPES)('`%s` resolves to its own catalog key', (t) => {
		expect(datasetColumnTypeLabel(t)).toBe(`dataset_coltype_${t}`);
	});

	it('covers the whole enum — all five, no gaps', () => {
		expect(COLUMN_TYPES).toHaveLength(5);
		expect(new Set(COLUMN_TYPES.map(datasetColumnTypeLabel)).size).toBe(5);
	});

	it('AN UNKNOWN TYPE DEGRADES TO ITSELF — the ontology needs this, not just a deploy window', () => {
		// `ontology_attributes.type` is a bare `text` column (backend/src/db/schema.ts), so this arm
		// is a live path there rather than a deploy-skew safety net.
		expect(datasetColumnTypeLabel('geopoint')).toBe('geopoint');
		expect(datasetColumnTypeLabel('geopoint')).not.toBe('');
	});

	it('the two enums do NOT share a key: "json" means different things in each', () => {
		// ⛔ Both enums have a member spelled `json`, and folding them onto one key would be the
		// `DotStatus` coercion `run-status-label.ts` documents: a SOURCE of JSON (an uploaded file)
		// and a COLUMN of JSON (a nested value) are different sentences in every locale that
		// inflects, and the two catalogs must stay free to differ.
		expect(datasetSourceLabel('json')).not.toBe(datasetColumnTypeLabel('json'));
	});
});
