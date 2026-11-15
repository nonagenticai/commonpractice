// src/lib/i18n/compliance-label.test.ts — the compliance panel names its rows from the KEY the
// backend now ships, never from the English prose it ships beside it.
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about English copy a translator may legitimately reword. Same
// technique as i18n/stage-label.test.ts.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	compliance_label_iso27001: () => 'M_ISO',
	compliance_label_gdpr: () => 'M_GDPR',
	compliance_label_dora: () => 'M_DORA',
	compliance_label_eu_ai_act: () => 'M_AI_ACT',
	compliance_status_passing: () => 'M_PASSING',
	compliance_status_documented: () => 'M_DOCUMENTED',
	compliance_status_reassess: () => 'M_REASSESS'
}));

const { complianceLabel, complianceStatusLabel } = await import('./compliance-label');

describe('complianceLabel', () => {
	it('resolves all four rows of the panel', () => {
		expect(complianceLabel('iso27001')).toBe('M_ISO');
		expect(complianceLabel('gdpr')).toBe('M_GDPR');
		expect(complianceLabel('dora')).toBe('M_DORA');
		expect(complianceLabel('eu_ai_act')).toBe('M_AI_ACT');
	});

	it('maps no two rows onto the same message', () => {
		// ⚠️ Arrow, not a bare reference: these take an optional SECOND argument (the legacy prose
		// fallback), and `.map` would pass the index into it.
		const labels = ['iso27001', 'gdpr', 'dora', 'eu_ai_act'].map((k) => complianceLabel(k));
		expect(new Set(labels).size).toBe(4);
	});

	it('returns the RAW KEY for a row added server-side — never an English sentence', () => {
		expect(complianceLabel('nis2')).toBe('nis2');
		// '' and undefined are the OLD-BACKEND sentinels: with no legacy prose passed they are
		// empty, and with prose they return it (covered by the render test).
		expect(complianceLabel('')).toBe('');
		expect(complianceLabel(undefined, 'ISO 27001 controls')).toBe('ISO 27001 controls');
	});
});

describe('complianceStatusLabel', () => {
	it('resolves the three status keys', () => {
		expect(complianceStatusLabel('passing')).toBe('M_PASSING');
		expect(complianceStatusLabel('documented')).toBe('M_DOCUMENTED');
		expect(complianceStatusLabel('reassess')).toBe('M_REASSESS');
	});

	it('gives the two `passing` rows the SAME word', () => {
		// ISO 27001 and DORA both read "Passing" in English and must read one Dutch word between
		// them. This is why the status is its own key rather than being folded into the row key:
		// four rows, three statuses.
		// Not `f(x) === f(x)` — that is `a === a` for a pure function and cannot go red. Assert the
		// two rows land on the SAME message and that four rows collapse to three distinct words.
		expect(complianceStatusLabel('passing')).toBe('M_PASSING');
		const words = ['passing', 'documented', 'reassess', 'passing'].map((k) => complianceStatusLabel(k));
		expect(words[0]).toBe(words[3]);
		expect(new Set(words).size).toBe(3);
	});

	it('returns the RAW KEY for a status added server-side', () => {
		expect(complianceStatusLabel('failing')).toBe('failing');
		expect(complianceStatusLabel('')).toBe('');
	});
});
