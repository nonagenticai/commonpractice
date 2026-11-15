// src/lib/i18n/data-finding-label.test.ts — a data-contract finding is rendered from its RULE, and
// only ever falls back to the backend's English when there is nothing else to say.
//
// The messages module is mocked so each key returns its own name plus its arguments: the assertions
// are about WHICH MESSAGE is selected and WHAT IS INTERPOLATED, not about English copy a translator
// may legitimately reword. Same technique as `compliance-label.test.ts` and `stage-label.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import type { DataValidationFinding } from '$lib/types/flows';

vi.mock('$lib/paraglide/messages', () => ({
	data_finding_pii_uncovered: (p: Record<string, unknown>) =>
		`M_PII(${p.attribute},${p.column},${p.dataset})`,
	data_finding_type_mismatch: (p: Record<string, unknown>) =>
		`M_TYPE(${p.count},${p.column},${p.attribute},${p.expected})`
}));

const { dataFindingLabel, dataFindingRef } = await import('./data-finding-label');

const PROSE = 'BACKEND ENGLISH — must not be reached';

const PII: DataValidationFinding = {
	rule: 'pii_uncovered',
	dataset: 'claims-2026',
	column: 'ssn_col',
	attribute: 'ssn',
	message: PROSE
};
const TYPE: DataValidationFinding = {
	rule: 'type_mismatch',
	dataset: 'claims-2026',
	column: 'amount',
	attribute: 'amount',
	message: PROSE,
	count: 3,
	expected: 'number'
};

describe('dataFindingLabel', () => {
	it('renders BOTH known rules from the catalog, never the backend prose', () => {
		expect(dataFindingLabel(PII)).toBe('M_PII(ssn,ssn_col,claims-2026)');
		expect(dataFindingLabel(TYPE)).toBe('M_TYPE(3,amount,amount,number)');
	});

	it('never falls back for a known rule with its fields present', () => {
		// The assertion that would go red if someone "simplified" the switch into
		// `return finding.message`. Both sentences must be free of the backend's English.
		for (const f of [PII, TYPE]) expect(dataFindingLabel(f)).not.toContain(PROSE);
	});

	it('maps the two rules onto DIFFERENT messages', () => {
		expect(dataFindingLabel(PII)).not.toBe(dataFindingLabel(TYPE));
	});

	it('passes `count` through unchanged, so the ICU plural selector sees a real number', () => {
		// A stringified count picks the wrong plural category in pl/ar/he, which have more than two.
		// `1` and `3` must reach the message distinctly — a hard-coded plural would collapse them.
		expect(dataFindingLabel({ ...TYPE, count: 1 })).toBe('M_TYPE(1,amount,amount,number)');
		expect(dataFindingLabel({ ...TYPE, count: 42 })).toBe('M_TYPE(42,amount,amount,number)');
	});

	// ---------------------------------------------------------------- the fallback branches

	it('falls back to the backend prose for an UNRECOGNISED rule', () => {
		// ⛔ THE DELIBERATE DIVERGENCE FROM `complianceLabel`, which returns the raw key. A rule
		// shipped backend-first must still be READABLE — it may be PII heading into a sandbox, and
		// a bare `cardinality_violation` token tells the tester nothing they can act on.
		expect(dataFindingLabel({ ...PII, rule: 'cardinality_violation' })).toBe(PROSE);
	});

	it('falls back for an ABSENT rule', () => {
		expect(dataFindingLabel({ ...PII, rule: '' })).toBe(PROSE);
		expect(dataFindingLabel({ ...PII, rule: undefined as unknown as string })).toBe(PROSE);
	});

	it('falls back for a `type_mismatch` from an OLD BACKEND, mid-roll', () => {
		// ⛔ THE MIDDLE BRANCH. `count`/`expected` arrived with this change; the Service
		// load-balances a new frontend onto an old pod for the length of a rolling deploy, so a
		// `type_mismatch` with neither field is a REAL wire shape, not a hypothetical. Interpolating
		// anyway would print "has undefined values … (expected undefined)" — a localized sentence
		// that says less than the English it replaced.
		const { count, expected, ...old } = TYPE;
		expect(dataFindingLabel(old as DataValidationFinding)).toBe(PROSE);
		expect(dataFindingLabel({ ...TYPE, expected: undefined })).toBe(PROSE);
		expect(dataFindingLabel({ ...TYPE, count: undefined })).toBe(PROSE);
		// `0` is an absence too: the backend only emits this rule when `bad > 0`.
		expect(dataFindingLabel({ ...TYPE, count: 0 })).toBe(PROSE);
	});

	it('does NOT fall back for `pii_uncovered`, which has no machine fields to be missing', () => {
		// Guards against a copy-paste of the type_mismatch mid-roll check onto the other rule,
		// which would silently return English for the PII finding — the more urgent of the two.
		expect(dataFindingLabel({ ...PII, count: undefined, expected: undefined })).toBe(
			'M_PII(ssn,ssn_col,claims-2026)'
		);
	});
});

describe('dataFindingRef', () => {
	it('addresses the finding as dataset.column → attribute', () => {
		expect(dataFindingRef(PII)).toBe('claims-2026.ssn_col → ssn');
	});

	it('is NOT translated — it is an identifier', () => {
		// Same three fields for both rules, so it renders identically whichever rule fired.
		expect(dataFindingRef({ ...TYPE, dataset: 'd', column: 'c', attribute: 'a' })).toBe('d.c → a');
	});
});
