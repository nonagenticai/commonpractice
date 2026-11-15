// src/lib/api/data-findings.test.ts — the guard that keeps everything that is NOT a data-contract
// finding out of the rendered list.
//
// ⛔ WHY A STRUCTURAL GUARD AT ALL. `details.findings` is literally whatever the backend put in the
// body, and `RunApiError.details` is a bag three different backend branches write to. The same
// error class carries `{ issues }` from a `flow_invalid` 422 AND from `route()`'s ZodError branch
// (backend/src/utils/http.ts) — and `unwrap()` in `./runs` SPREADS the whole body into `details`,
// so a stray top-level key lands there too. `raw as DataValidationFinding[]` would be a claim about
// data nothing inspected; one malformed entry then renders as `undefined.undefined → undefined`.
//
// The payloads below are deliberately MIXED rather than one-shape-per-case: the question is not
// "does a good finding pass" (trivially yes) but "does a good finding survive being in the same
// array as a Zod issue", which is the shape a `.strict()` schema rejection actually produces.
import { describe, it, expect } from 'vitest';
import { isDataFinding, dataFindingsFrom, dataValidationFrom } from './data-findings';

/** Verbatim shape of a backend `pii_uncovered` finding. */
const PII = {
	rule: 'pii_uncovered',
	dataset: 'claims-2026',
	column: 'ssn_col',
	attribute: 'ssn',
	message:
		"Attribute 'ssn' is PII but dataset column 'ssn_col' is not flagged PII, so its values would be injected unredacted."
};

/** Verbatim shape of a backend `type_mismatch` finding, WITH the new machine fields. */
const TYPE = {
	rule: 'type_mismatch',
	dataset: 'claims-2026',
	column: 'amount',
	attribute: 'amount',
	message: "Column 'amount' has 3 value(s) that don't match attribute 'amount' type 'number'.",
	count: 3,
	expected: 'number'
};

/** A Zod issue as `route()` emits it — `code`/`path`, no `dataset`. */
const ZOD_ISSUE = { code: 'unrecognized_keys', path: ['body'], message: 'Unrecognized key' };

/** A GraphIssue — has `rule` and `message`, which is exactly why the guard cannot stop at those. */
const GRAPH_ISSUE = { rule: 'missing-required-input', message: 'Input "rows" is required.', ref: 'n1' };

describe('isDataFinding', () => {
	it('accepts both real rules, with and without the optional machine fields', () => {
		expect(isDataFinding(PII)).toBe(true);
		expect(isDataFinding(TYPE)).toBe(true);
	});

	it('accepts a rule the backend shipped FIRST — it must degrade, never vanish', () => {
		// The single most important case in this file. Re-declaring `rule` as the backend's
		// two-value union would fail this, and a new rule would silently disappear from the UI —
		// the exact silence this module exists to end.
		expect(isDataFinding({ ...PII, rule: 'cardinality_violation' })).toBe(true);
	});

	it('rejects a Zod issue and a GraphIssue', () => {
		expect(isDataFinding(ZOD_ISSUE)).toBe(false);
		// `rule` + `message` alone are NOT enough: a GraphIssue has both and names a node, not a
		// column. This is why the guard requires the three addressing fields.
		expect(isDataFinding(GRAPH_ISSUE)).toBe(false);
	});

	it('rejects a finding missing any addressing field', () => {
		for (const k of ['rule', 'dataset', 'column', 'attribute', 'message'] as const) {
			const partial: Record<string, unknown> = { ...PII };
			delete partial[k];
			expect(isDataFinding(partial)).toBe(false);
		}
	});

	it('rejects wrong types on the OPTIONAL fields rather than passing them through', () => {
		// `count` reaches an ICU plural selector and `expected` reaches a template. A string count
		// would pick the wrong plural category in every locale that has more than two.
		expect(isDataFinding({ ...TYPE, count: '3' })).toBe(false);
		expect(isDataFinding({ ...TYPE, expected: 42 })).toBe(false);
		// …but ABSENT is fine on both — that is an old backend, not a malformed one.
		expect(isDataFinding({ ...PII, count: undefined, expected: undefined })).toBe(true);
	});

	it('rejects non-objects', () => {
		for (const v of [null, undefined, 'x', 3, []]) expect(isDataFinding(v)).toBe(false);
	});
});

describe('dataFindingsFrom', () => {
	it('keeps ONLY the findings out of a mixed payload', () => {
		const kept = dataFindingsFrom({ findings: [ZOD_ISSUE, PII, GRAPH_ISSUE, TYPE, null, 'x'] });
		expect(kept).toEqual([PII, TYPE]);
	});

	it('is empty for a details bag with no findings, a non-array, or nothing at all', () => {
		expect(dataFindingsFrom({ issues: [GRAPH_ISSUE] })).toEqual([]);
		expect(dataFindingsFrom({ findings: 'nope' as unknown })).toEqual([]);
		expect(dataFindingsFrom(undefined)).toEqual([]);
	});
});

describe('dataValidationFrom', () => {
	it('lifts the envelope off a warn-mode 201', () => {
		const report = dataValidationFrom({
			runId: 'r1',
			status: 'running',
			sandboxId: 's1',
			dataValidation: { mode: 'warn', findings: [PII, TYPE] }
		});
		expect(report).not.toBeNull();
		expect(report!.mode).toBe('warn');
		expect(report!.findings).toEqual([PII, TYPE]);
	});

	it('is null for a CLEAN run — the key is absent, not empty', () => {
		// The contract behind the backend's conditional spread: a clean body must stay byte-for-byte
		// what it was, so the caller's test is `!== null` and never a length compare.
		expect(dataValidationFrom({ runId: 'r1', status: 'running', sandboxId: 's1' })).toBeNull();
	});

	it('is null when the envelope carries nothing renderable', () => {
		// A pill announcing a violation it cannot name is worse than no pill.
		expect(dataValidationFrom({ dataValidation: { mode: 'warn', findings: [ZOD_ISSUE] } })).toBeNull();
		expect(dataValidationFrom({ dataValidation: { mode: 'warn' } })).toBeNull();
	});

	it('reads an unknown mode as `warn` — the run is on the SUCCESS path either way', () => {
		const report = dataValidationFrom({ dataValidation: { mode: 'shout', findings: [PII] } });
		expect(report!.mode).toBe('warn');
	});

	it('survives junk instead of a body', () => {
		for (const v of [null, undefined, 'x', 3]) expect(dataValidationFrom(v)).toBeNull();
	});
});
