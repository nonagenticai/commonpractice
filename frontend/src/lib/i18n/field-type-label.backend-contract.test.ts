// src/lib/i18n/field-type-label.backend-contract.test.ts — the enum the BACKEND owns, the union
// the BROWSER mirrors, and the switch that translates it still agree.
//
// THE DEFECT THIS PINS is the one that only appears later. `fieldTypeLabel` degrades an
// unrecognised value to the raw enum on purpose, which means an EIGHTH field type added
// server-side ships silently: every port badge of that type renders "geojson" on the /build
// canvas, every frontend unit test stays green (they enumerate the list this repo wrote, not the
// one the backend has), and nothing in CI says a word. The badge simply goes back to being
// English. This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `dataset-label.backend-contract.test.ts` does, this walks BACKEND SOURCE
// TEXT on disk with plain `fs` and diffs the sets.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// The repo's own comment stripper — `catalogs.test.ts` uses it for the same reason this file needs
// it: `block-types.ts` documents its `dataset` member in a comment containing both an apostrophe
// and a semicolon ("the dataset's slug (a string);"), which ends a naive union slice six members in.
import { stripComments } from '$lib/test/source-scan';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const DESCRIPTOR = join(BACKEND, 'src', 'blocks', 'descriptor-schema.ts');
const BLOCK_TYPES = join(BACKEND, 'src', 'db', 'block-types.ts');

const descriptorSrc = readFileSync(DESCRIPTOR, 'utf8');
const blockTypesSrc = readFileSync(BLOCK_TYPES, 'utf8');
const labelSrc = readFileSync(new URL('./field-type-label.ts', import.meta.url), 'utf8');
const frontendTypesSrc = readFileSync(new URL('../types/blocks.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- readers

/** The members of the `fieldTypeSchema` zod enum — the declaration the API actually VALIDATES. */
function zodEnum(): string[] {
	const at = descriptorSrc.indexOf('export const fieldTypeSchema = z.enum([');
	if (at === -1) throw new Error('fieldTypeSchema not found in backend/src/blocks/descriptor-schema.ts');
	// ⚠️ `])`, not `]`. One MEMBER of this enum is spelled `string[]`, so the first `]` after the
	// declaration is inside a value and slicing to it silently returns four of the seven — which is
	// exactly the vacuous parse the block above exists to catch, and which it did catch.
	const body = descriptorSrc.slice(at, descriptorSrc.indexOf('])', at));
	return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The `FieldType` union out of a TS source file — the backend's and the frontend's mirror it. */
function union(src: string, where: string): string[] {
	const m = stripComments(src).match(/export type FieldType =([\s\S]*?);/);
	if (!m) throw new Error(`FieldType union not found in ${where}`);
	return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The `case 'x':` labels inside `fieldTypeLabel`. */
function switchCases(): string[] {
	const at = labelSrc.indexOf('export function fieldTypeLabel(');
	if (at === -1) throw new Error('fieldTypeLabel not found in field-type-label.ts');
	const end = labelSrc.indexOf('\n}', at);
	return [...labelSrc.slice(at, end).matchAll(/case '([^']+)':/g)].map((x) => x[1]!);
}

/** The `m.<key>()` calls inside `fieldTypeLabel` — the keys the catalog has to carry. */
function messageKeys(): string[] {
	const at = labelSrc.indexOf('export function fieldTypeLabel(');
	const end = labelSrc.indexOf('\n}', at);
	return [...labelSrc.slice(at, end).matchAll(/m\.(\w+)\(\)/g)].map((x) => x[1]!);
}

describe('the parse itself is not vacuous', () => {
	it('reads the seven members out of the zod enum', () => {
		// Pinned exactly, not to a floor: if this regex ever starts returning `[]` every set
		// comparison below passes for free, which is the failure mode this file exists to avoid.
		expect(zodEnum()).toEqual([
			'string',
			'number',
			'boolean',
			'json',
			'string[]',
			'enum',
			'dataset'
		]);
	});

	it('reads seven members out of each FieldType union too', () => {
		// The same trap, twice over: a truncated slice returns a SUBSET, and a subset compared
		// against a subset agrees. Both readers are pinned to a count before anything is diffed.
		expect(union(blockTypesSrc, 'backend/src/db/block-types.ts')).toHaveLength(7);
		expect(union(frontendTypesSrc, 'src/lib/types/blocks.ts')).toHaveLength(7);
	});

	it('reads seven cases and seven message keys out of the switch', () => {
		expect(switchCases()).toHaveLength(7);
		expect(messageKeys()).toHaveLength(7);
	});
});

describe('the FieldType vocabulary is the same in all four places', () => {
	it('the zod schema and the backend union agree', () => {
		expect(union(blockTypesSrc, 'backend/src/db/block-types.ts')).toEqual(zodEnum());
	});

	it('the frontend mirror agrees with the backend', () => {
		expect(union(frontendTypesSrc, 'src/lib/types/blocks.ts')).toEqual(zodEnum());
	});

	it('⛔ the labeller has a case for every backend member, and invents none', () => {
		// An eighth type added server-side reds HERE rather than shipping an English token onto the
		// /build canvas via the `default:` arm.
		expect([...switchCases()].sort()).toEqual([...zodEnum()].sort());
	});
});

describe('every key the labeller names is really in the base catalog', () => {
	it('en.json carries all seven', () => {
		expect(messageKeys().filter((k) => typeof enCatalog[k] !== 'string')).toEqual([]);
	});
});
