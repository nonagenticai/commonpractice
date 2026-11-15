// src/lib/i18n/ops-alert-label.plurals.test.ts — the two count-bearing messages on /it-dash are the
// only ones where the catalog can lie, so they get their own file. Same shape and same rules as
// `data-finding-label.plurals.test.ts`; read that header first, it states the doctrine.
//
// ⛔ A DECLARED-BUT-IDENTICAL CATEGORY IS WORSE THAN AN ABSENT ONE. It reads as a considered
// decision and is a trap for the next translator, who "fixes" one of the duplicates and silently
// changes the sentence for 2-4 but not for 22. Every category declared below is one the language
// genuinely distinguishes IN WRITING; everything else falls through to `other`/`*`, which is what
// CLDR fallback is for. The last test in this file is the machine-checkable form of that rule.
//
// ⚠️ CATEGORY ≠ NUMBER. The cases name the CLDR category each count selects in that locale
// (pl: 1=one, 2-4=few, 5+=many; ar: 1=one, 2=two, 3-10=few, 11+=many→other), so a reader can see
// WHY 5 and 25 are grouped and 22 is not.
//
// ⚠️ `count` here is a positive integer by construction: the backend emits `sandbox_error` only
// when `COUNT(*) > 0` and `block_errors` only when a block failed in `>= 2` runs. `zero` and the
// fraction branches are unreachable and are deliberately NOT declared anywhere.
import { describe, it, expect } from 'vitest';
import * as m from '$lib/paraglide/messages';

type Locale = 'en' | 'nl' | 'de' | 'fr' | 'es' | 'pl' | 'ar' | 'he';
const LOCALES: Locale[] = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'];

/** "N sandboxes in error" in `locale`. */
const sbx = (locale: Locale, count: number): string =>
	m.ops_alert_sandbox_error_title({ count }, { locale });
/** "N errored runs in the last 7 days…" in `locale`. */
const blk = (locale: Locale, count: number): string =>
	m.ops_alert_block_errors_detail({ count, days: 7 }, { locale });

describe('ops_alert_sandbox_error_title plurals', () => {
	it('pl: one / few / many are three DIFFERENT sentences', () => {
		// The noun's CASE changes, not just its ending — "piaskownica / piaskownice / piaskownic".
		expect(sbx('pl', 1)).toContain('1 piaskownica');
		expect(sbx('pl', 2)).toContain('2 piaskownice');
		expect(sbx('pl', 4)).toContain('4 piaskownice');
		expect(sbx('pl', 5)).toContain('5 piaskownic z');
		// 22 is `few` in Polish and 25 is `many` — the reason a single "2 vs many" split is wrong.
		expect(sbx('pl', 22)).toContain('22 piaskownice');
		expect(sbx('pl', 25)).toContain('25 piaskownic z');
		expect(new Set([sbx('pl', 1), sbx('pl', 2), sbx('pl', 5)]).size).toBe(3);
	});

	it('ar: one / two / few / other are four DIFFERENT sentences', () => {
		// 1 and 2 spell the number as a word and take the dual — Arabic does not write "2 X".
		expect(sbx('ar', 1)).toContain('واحدة');
		expect(sbx('ar', 1)).not.toContain('1');
		expect(sbx('ar', 2)).toContain('بيئتا');
		expect(sbx('ar', 2)).not.toContain('2');
		// 3-10 → the broken plural; 11+ → `many` is undeclared and falls through to `other`.
		expect(sbx('ar', 3)).toContain('3 بيئات');
		expect(sbx('ar', 10)).toContain('10 بيئات');
		expect(sbx('ar', 11)).toContain('11 بيئة');
		expect(sbx('ar', 100)).toContain('100 بيئة');
		expect(new Set([sbx('ar', 1), sbx('ar', 2), sbx('ar', 3), sbx('ar', 11)]).size).toBe(4);
		// …and 11 vs 100 really is ONE sentence, not a distinction being silently dropped.
		expect(sbx('ar', 11).replace('11', 'N')).toBe(sbx('ar', 100).replace('100', 'N'));
	});

	it('he: exactly two forms, and the catalog does not claim more', () => {
		expect(sbx('he', 1)).toContain('אחד');
		expect(sbx('he', 2)).toContain('2 ארגזי חול');
		// Hebrew has a dual, but not for this noun in writing — so `two` is NOT declared.
		expect(sbx('he', 2).replace('2', 'N')).toBe(sbx('he', 11).replace('11', 'N'));
	});
});

describe('ops_alert_block_errors_detail plurals', () => {
	it('pl: one / few / many are three DIFFERENT sentences, verb agreement included', () => {
		expect(blk('pl', 1)).toContain('1 nieudane uruchomienie');
		expect(blk('pl', 2)).toContain('2 nieudane uruchomienia');
		expect(blk('pl', 5)).toContain('5 nieudanych uruchomień');
		expect(new Set([blk('pl', 1), blk('pl', 2), blk('pl', 5)]).size).toBe(3);
	});

	it('ar: the dual is a different verb, not a different number', () => {
		expect(blk('ar', 2)).toContain('تشغيلان');
		expect(blk('ar', 3)).toContain('3 عمليات');
		expect(new Set([blk('ar', 1), blk('ar', 2), blk('ar', 3), blk('ar', 11)]).size).toBe(4);
	});

	it('interpolates the WINDOW it was given, in every locale', () => {
		// ⛔ `days` is the backend's `BLOCK_ERROR_WINDOW_DAYS`, not a literal baked into the copy —
		// that is the whole point of putting it on the wire. REVERT THAT TURNS THIS RED: write "7"
		// into any catalog value instead of `{days}`.
		for (const locale of LOCALES) {
			expect(m.ops_alert_block_errors_detail({ count: 3, days: 14 }, { locale }), locale).toContain(
				'14'
			);
		}
	});
});

describe('both messages, every locale', () => {
	it('distinguishes 1 from 2 — the distinction that always mattered', () => {
		for (const locale of LOCALES) {
			expect(sbx(locale, 1), `${locale} renders 1 and 2 identically (sandbox)`).not.toBe(
				sbx(locale, 2)
			);
			expect(blk(locale, 1), `${locale} renders 1 and 2 identically (block)`).not.toBe(
				blk(locale, 2)
			);
		}
	});

	it('⛔ declares NO two identical variants, and always mirrors `other` into the catch-all', () => {
		// ⛔ THE GUARD ITSELF, copied from `data-finding-label.plurals.test.ts`. Two variants with the
		// same string is a claim the language does not make. `other`/`*` is the one legitimate pair.
		//
		// REVERT THAT TURNS THIS RED: add `"countPlural=few"` to he.json with the same string as
		// `other` (the exact "helpful" edit this rule exists to stop).
		const { readFileSync } = require('node:fs') as typeof import('node:fs');
		const { resolve } = require('node:path') as typeof import('node:path');
		for (const key of ['ops_alert_sandbox_error_title', 'ops_alert_block_errors_detail']) {
			for (const locale of LOCALES) {
				const raw = readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8');
				const catalog = JSON.parse(raw) as Record<string, [{ match: Record<string, string> }]>;
				expect(catalog[key], `${locale} has no ${key}`).toBeDefined();
				const match = catalog[key]![0].match;
				const named = Object.entries(match).filter(([k]) => k !== 'countPlural=*');
				const values = named.map(([, v]) => v);
				expect(
					new Set(values).size,
					`${locale}/${key} declares two plural categories with the same sentence: ${named
						.map(([k]) => k)
						.join(', ')}`
				).toBe(values.length);
				expect(match['countPlural=*'], `${locale}/${key} has no catch-all`).toBe(
					match['countPlural=other']
				);
			}
		}
	});
});
