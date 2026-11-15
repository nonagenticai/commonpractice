// src/lib/i18n/work-area-label.test.ts — the work-area vocabulary resolves from the ENUM, and the
// enum it resolves is the one the backend actually sends.
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about copy a translator may legitimately reword. (Same technique as
// stage-label.test.ts and ops/pipeline-stats.render.test.ts.)
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/paraglide/messages', () => ({
	domain_claims: () => 'M_CLAIMS',
	domain_sales: () => 'M_SALES',
	domain_service: () => 'M_SERVICE',
	domain_legal: () => 'M_LEGAL',
	domain_marketing: () => 'M_MARKETING',
	domain_risk: () => 'M_RISK',
	domain_ops: () => 'M_OPS',
	domain_it: () => 'M_IT'
}));

const { workAreaLabel } = await import('./work-area-label');

describe('workAreaLabel', () => {
	it('resolves every work area the backend can send', () => {
		expect(workAreaLabel('Claims')).toBe('M_CLAIMS');
		expect(workAreaLabel('Sales')).toBe('M_SALES');
		expect(workAreaLabel('Service')).toBe('M_SERVICE');
		expect(workAreaLabel('Legal')).toBe('M_LEGAL');
		expect(workAreaLabel('Marketing')).toBe('M_MARKETING');
		expect(workAreaLabel('Risk')).toBe('M_RISK');
		expect(workAreaLabel('Ops')).toBe('M_OPS');
		expect(workAreaLabel('IT')).toBe('M_IT');
	});

	it('covers the backend enum exactly — derived from the backend source, not hand-listed', () => {
		// ⛔ THE NON-VACUITY POINT OF THIS FILE. A hand-written list of eight strings proves only
		// that someone typed eight strings. `WORK_AREAS` lives in the backend and a ninth value can
		// be added there without anyone opening this directory; scraping it means the switch's
		// default branch cannot silently become the common case.
		const src = readFileSync(
			resolve(process.cwd(), '../backend/src/routes/challenges.ts'),
			'utf8'
		);
		const decl = /export const WORK_AREAS = \[([^\]]+)\]/.exec(src);
		expect(decl, 'WORK_AREAS moved or was renamed in backend/src/routes/challenges.ts').not.toBeNull();
		const areas = [...decl![1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]!);
		expect(areas).toHaveLength(8);

		const labels = areas.map(workAreaLabel);
		// Every one resolved to a message, i.e. none fell through to the raw-value default.
		for (const [i, label] of labels.entries()) {
			expect(label, `${areas[i]} has no catalog key — it fell through to the raw value`).toMatch(/^M_/);
		}
		// …and no two work areas collapse onto one message, which would make two chips indistinguishable.
		expect(new Set(labels).size).toBe(areas.length);
	});

	it('every key it reaches exists in all eight catalogs', () => {
		// The mock above would happily resolve a key that is not in any catalog. Paraglide fails the
		// BUILD on that — but only for the locale that is missing it, and only once someone compiles.
		const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'];
		const KEYS = [
			'domain_claims',
			'domain_sales',
			'domain_service',
			'domain_legal',
			'domain_marketing',
			'domain_risk',
			'domain_ops',
			'domain_it'
		];
		for (const locale of LOCALES) {
			const catalog = JSON.parse(
				readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')
			) as Record<string, unknown>;
			for (const key of KEYS) {
				expect(typeof catalog[key], `${key} is missing from ${locale}.json`).toBe('string');
			}
		}
	});

	it('returns the RAW VALUE for an unknown work area — never an English sentence', () => {
		// Rows seeded before `z.enum(WORK_AREAS)` landed carry off-list values (this is why
		// /challenges renders `extraDomains` chips at all). The default branch must ship the ugly
		// word, never a translated guess and never a fallback sentence.
		expect(workAreaLabel('Facilities')).toBe('Facilities');
		expect(workAreaLabel('claims')).toBe('claims'); // case-sensitive: the enum is capitalised
		expect(workAreaLabel('All domains')).toBe('All domains'); // the filter sentinel is NOT a work area
		expect(workAreaLabel('')).toBe('');
	});
});
