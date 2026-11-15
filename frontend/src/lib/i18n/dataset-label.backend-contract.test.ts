// src/lib/i18n/dataset-label.backend-contract.test.ts — the enum the BACKEND owns and the switch
// the BROWSER writes still agree.
//
// THE DEFECT THIS PINS is the one that only appears later. `datasetSourceLabel` degrades an
// unrecognised value to the raw enum on purpose, which means a NINTH source kind added server-side
// ships silently: the roster renders "sftp", every frontend unit test stays green (they enumerate
// the list this repo wrote, not the one the backend has), and nothing in CI says a word. The badge
// simply goes back to being English. This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `policy-label.backend-contract.test.ts` and
// `notification-label.backend-contract.test.ts` do, this walks BACKEND SOURCE TEXT on disk with
// plain `fs` and diffs the sets.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const TYPES = join(BACKEND, 'src', 'db', 'dataset-types.ts');
const SCHEMA = join(BACKEND, 'src', 'db', 'schema.ts');

const typesSrc = readFileSync(TYPES, 'utf8');
const schemaSrc = readFileSync(SCHEMA, 'utf8');
const labelSrc = readFileSync(new URL('./dataset-label.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- backend readers

/** The members of a `export const X = [...] as const` array in dataset-types.ts. */
function constArray(name: string): string[] {
	const m = typesSrc.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`));
	if (!m) throw new Error(`${name} not found in backend/src/db/dataset-types.ts`);
	return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The `dataset_source_type` pg enum — the OTHER declaration of the same set, and the one the
 *  database actually enforces. Both are read, because they can drift from each other. */
function pgSourceEnum(): string[] {
	const at = schemaSrc.indexOf("pgEnum('dataset_source_type', [");
	if (at === -1) throw new Error('dataset_source_type pgEnum not found in backend/src/db/schema.ts');
	const body = schemaSrc.slice(at, schemaSrc.indexOf(']', at));
	return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!).filter((s) => s !== 'dataset_source_type');
}

/** The `DatasetColumnType` union. */
function columnTypes(): string[] {
	const m = typesSrc.match(/export type DatasetColumnType = ([^;]+);/);
	if (!m) throw new Error('DatasetColumnType not found in backend/src/db/dataset-types.ts');
	return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The `case 'x':` labels inside one exported function of dataset-label.ts. */
function switchCases(fn: string): string[] {
	const at = labelSrc.indexOf(`export function ${fn}(`);
	if (at === -1) throw new Error(`${fn} not found in dataset-label.ts`);
	const end = labelSrc.indexOf('\n}', at);
	return [...labelSrc.slice(at, end).matchAll(/case '([^']+)':/g)].map((x) => x[1]!);
}

describe('the parse itself is not vacuous', () => {
	it('reads the five upload kinds and the three connector kinds', () => {
		// Pinned exactly, not to a floor: if this regex ever starts returning `[]` every set
		// comparison below passes for free, which is the failure mode this file exists to avoid.
		expect(constArray('DATASET_SOURCE_TYPES')).toEqual(['csv', 'xlsx', 'sql', 'text', 'json']);
		expect(constArray('CONNECTOR_SOURCE_TYPES')).toEqual(['postgres', 'storage', 'http']);
	});

	it('reads the five column types', () => {
		expect(columnTypes()).toEqual(['string', 'number', 'boolean', 'date', 'json']);
	});

	it('reads eight cases out of each switch', () => {
		expect(switchCases('datasetSourceLabel')).toHaveLength(8);
		expect(switchCases('datasetColumnTypeLabel')).toHaveLength(5);
	});
});

describe('every dataset source kind the backend can serve has a word in the browser', () => {
	const backend = [...constArray('DATASET_SOURCE_TYPES'), ...constArray('CONNECTOR_SOURCE_TYPES')];

	it('the TS constant and the pg enum are the same set — the backend does not disagree with itself', () => {
		expect(pgSourceEnum().sort()).toEqual(backend.sort());
	});

	it('the switch covers exactly the backend set — no missing member, and no invented one', () => {
		expect(switchCases('datasetSourceLabel').sort()).toEqual([...backend].sort());
	});

	it.each(backend)('`dataset_source_%s` exists in the en catalog', (t) => {
		// The switch naming a key the catalog does not carry is how a badge renders blank.
		expect(Object.keys(enCatalog)).toContain(`dataset_source_${t}`);
	});
});

describe('every column type the backend can infer has a word in the browser', () => {
	const backend = columnTypes();

	it('the switch covers exactly the backend union', () => {
		expect(switchCases('datasetColumnTypeLabel').sort()).toEqual([...backend].sort());
	});

	it.each(backend)('`dataset_coltype_%s` exists in the en catalog', (t) => {
		expect(Object.keys(enCatalog)).toContain(`dataset_coltype_${t}`);
	});
});
