// src/lib/i18n/field-type-label.test.ts — the block-port type enum resolves to catalog copy, and
// an unknown value degrades to itself rather than to nothing.
//
// ⛔ WHAT THE `default:` ARM IS FOR, AND WHY IT IS TESTED HARDER THAN THE MAPPED VALUES. The mapped
// seven are the easy half. The arm that matters is the one nobody exercises until a deploy is
// half-rolled: it must return the RAW value, because `{''}` inside `<span class="ptype">` is a
// tinted rectangle with nothing in it — a port that appears to have no type at all — which is
// strictly worse than the English token this module exists to remove.
//
// The RENDERED Dutch words are asserted next door, in
// `components/build/block-node.port-types.render.test.ts`. This file is about WHICH key each member
// reaches, never about the wording.
import { describe, it, expect, vi } from 'vitest';

// Real `en` catalog, each key resolving to its own name.
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

import { fieldTypeLabel } from './field-type-label';
import { datasetColumnTypeLabel } from './dataset-label';

/** type → the key it must reach. `string[]` is the one member whose key is not its own spelling. */
const KEYS: [string, string][] = [
	['string', 'fieldtype_string'],
	['number', 'fieldtype_number'],
	['boolean', 'fieldtype_boolean'],
	['json', 'fieldtype_json'],
	['string[]', 'fieldtype_string_array'],
	['enum', 'fieldtype_enum'],
	['dataset', 'fieldtype_dataset']
];

describe('fieldTypeLabel', () => {
	it.each(KEYS)('`%s` resolves to `%s`', (type, key) => {
		expect(fieldTypeLabel(type)).toBe(key);
	});

	it('covers the whole enum — all seven, no gaps', () => {
		// ⛔ A count, not a spot check: `it.each` over a list I wrote is satisfied by a list that is
		// missing a member. The backend-contract file beside this one is what pins the list ITSELF
		// against `backend/src/blocks/descriptor-schema.ts`.
		expect(KEYS).toHaveLength(7);
		expect(new Set(KEYS.map(([t]) => fieldTypeLabel(t))).size).toBe(7);
	});

	it('⛔ AN UNKNOWN TYPE DEGRADES TO ITSELF — never to empty', () => {
		expect(fieldTypeLabel('geojson')).toBe('geojson');
		// The empty string is the failure this arm prevents, stated as its own assertion.
		expect(fieldTypeLabel('geojson')).not.toBe('');
	});

	it('…and it is not silently prefixing an absent key', () => {
		// A `default:` that returned `fieldtype_${t}` would look identical under the mock above for
		// the mapped values and produce a DANGLING key name for an unmapped one.
		expect(fieldTypeLabel('geojson')).not.toContain('fieldtype_');
	});

	it('does NOT borrow the dataset column-type keys, however alike the words are', () => {
		// ⛔ The catalogs deliberately repeat the WORDS ("Tekst", "Getal", "Ja/nee", "JSON") so the
		// product speaks one Dutch vocabulary. The KEYS stay separate, for the reason
		// `dataset-label.ts` documents about its own two enums: `FieldType` and `DatasetColumnType`
		// are independent backend vocabularies — `FieldType` has no `date` and `DatasetColumnType`
		// has no `enum`/`dataset`/`string[]` — and a locale that inflects must stay free to say
		// "a column of text" and "a port carrying text" differently.
		for (const shared of ['string', 'number', 'boolean', 'json']) {
			expect(fieldTypeLabel(shared)).not.toBe(datasetColumnTypeLabel(shared));
		}
	});

	it('`date` is NOT a field type — it belongs to the other vocabulary', () => {
		// The nearest wrong fix is pointing the badge at `datasetColumnTypeLabel`, which would map
		// four of the seven and translate a member `FieldType` does not have.
		expect(fieldTypeLabel('date')).toBe('date');
	});
});

describe('the catalog carries every key the switch names', () => {
	it('all seven keys exist in en.json', async () => {
		// The mock above turns a MISSING key into `undefined`, not into a throw, so a typo'd key
		// would render blank in the browser and pass every assertion above.
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const en = JSON.parse(
			readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
		) as Record<string, unknown>;
		expect(KEYS.filter(([, k]) => typeof en[k] !== 'string').map(([, k]) => k)).toEqual([]);
	});
});
