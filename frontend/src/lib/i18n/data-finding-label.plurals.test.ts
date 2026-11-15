// src/lib/i18n/data-finding-label.plurals.test.ts — `data_finding_type_mismatch` is the only
// count-bearing message in the data-contract surface, and the only one where the catalog can lie.
//
// ⛔ WHAT THIS FILE IS FOR. A plural catalog can claim a distinction it does not make. Before this
// change every locale distinguished only two forms (1 vs 2), but three of them DECLARED more
// categories than that, and where they did the extra ones were WRONG:
//   • `pl` declared few ≡ many ≡ other, so `count: 2` rendered the 5+ genitive "niezgodnych" where
//     Polish wants the accusative plural "niezgodne";
//   • `ar` declared SIX categories with five of them byte-identical, so `count: 2` rendered
//     "2 قيمة" where the dual wants "قيمتان", and `count: 3` wanted the plural "قيم";
//   • `he` declared two ≡ many ≡ other — with a DIGIT the Hebrew is "יש 2 ערכים" either way, so
//     the extra categories were pure noise a translator would eventually "fix" in one place only.
// A declared-but-identical category is worse than an absent one: it reads as a considered decision
// and is a trap for the next translator. Every category still declared below is now a category the
// language actually distinguishes IN WRITING; everything else falls through to `other`/`*`, which
// is what CLDR fallback is for.
//
// ⚠️ CATEGORY ≠ NUMBER. The cases below name the CLDR category each count selects in that locale
// (pl: 1=one, 2-4=few, 5+=many→other; ar: 1=one, 2=two, 3-10=few, 11+=many→other), so a reader can
// see WHY 5 and 11 are grouped with 100. `count` reaching this message is always a positive integer
// — the backend emits `type_mismatch` only when `bad > 0` — so `zero` and the fraction branches are
// unreachable and are deliberately NOT declared anywhere.
import { describe, it, expect } from 'vitest';
import * as m from '$lib/paraglide/messages';

const ARGS = { column: 'amt', attribute: 'amount', expected: 'number' };

/** The sentence a locale renders for `count`. */
function say(locale: 'en' | 'nl' | 'de' | 'fr' | 'es' | 'pl' | 'ar' | 'he', count: number): string {
	return m.data_finding_type_mismatch({ ...ARGS, count }, { locale });
}

describe('data_finding_type_mismatch plurals', () => {
	it('pl: one / few / many are three DIFFERENT sentences', () => {
		// 1 → accusative singular "wartość niezgodną"
		expect(say('pl', 1)).toContain('1 wartość niezgodną');
		// ⛔ 2-4 → `few` → accusative plural "wartości niezgodne". RED BEFORE: "niezgodnych".
		expect(say('pl', 2)).toContain('2 wartości niezgodne z');
		expect(say('pl', 4)).toContain('4 wartości niezgodne z');
		// 5+ → `many`, which is not declared and falls through to `other`: genitive plural.
		expect(say('pl', 5)).toContain('5 wartości niezgodnych');
		expect(say('pl', 22)).toContain('22 wartości niezgodne z'); // 22 is `few` in Polish
		expect(say('pl', 25)).toContain('25 wartości niezgodnych'); // 25 is `many`

		expect(new Set([say('pl', 1), say('pl', 2), say('pl', 5)]).size).toBe(3);
	});

	it('ar: one / two / few / other are four DIFFERENT sentences', () => {
		// 1 → "قيمة واحدة", no numeral (the catalog spells the word out, as Arabic does).
		expect(say('ar', 1)).toContain('قيمة واحدة');
		// ⛔ 2 → the DUAL "قيمتان" with the dual verb, and NO numeral. RED BEFORE: "2 قيمة".
		expect(say('ar', 2)).toContain('قيمتان لا تطابقان');
		expect(say('ar', 2)).not.toContain('2 قيمة');
		// ⛔ 3-10 → the broken plural "قيم". RED BEFORE: "3 قيمة".
		expect(say('ar', 3)).toContain('3 قيم ');
		expect(say('ar', 10)).toContain('10 قيم ');
		// 11+ → `many`, undeclared, falls through to `other`: the written singular "قيمة" — which is
		// also what 100+ takes. Those two categories differ only in a case ending Arabic does not
		// write, which is exactly why only one of them is declared.
		expect(say('ar', 11)).toContain('11 قيمة');
		expect(say('ar', 100)).toContain('100 قيمة');

		expect(new Set([say('ar', 1), say('ar', 2), say('ar', 3), say('ar', 11)]).size).toBe(4);
		// …and 11 vs 100 really is one sentence, not a distinction being silently dropped.
		expect(say('ar', 11).replace('11', 'N')).toBe(say('ar', 100).replace('100', 'N'));
	});

	it('he: exactly two forms, and the catalog no longer claims more', () => {
		expect(say('he', 1)).toContain('ערך אחד');
		expect(say('he', 2)).toContain('2 ערכים');
		// The `two` and `many` categories used to be declared with this same string.
		expect(say('he', 2).replace('2', 'N')).toBe(say('he', 11).replace('11', 'N'));
	});

	it('every locale still distinguishes 1 from 2 — the distinction that always mattered', () => {
		for (const locale of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const) {
			expect(say(locale, 1), `${locale} renders 1 and 2 identically`).not.toBe(say(locale, 2));
		}
	});

	it('the catalogs declare NO two identical variants for this message', () => {
		// ⛔ THE GUARD ITSELF. Two variants with the same string is a claim the language does not
		// make; `other`/`*` is the one legitimate pair (`*` is the required catch-all and every
		// locale in this catalog mirrors `other` into it).
		const { readFileSync } = require('node:fs') as typeof import('node:fs');
		const { resolve } = require('node:path') as typeof import('node:path');
		for (const locale of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const) {
			const catalog = JSON.parse(
				readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')
			) as Record<string, [{ match: Record<string, string> }]>;
			const match = catalog.data_finding_type_mismatch[0].match;
			const named = Object.entries(match).filter(([k]) => k !== 'countPlural=*');
			const values = named.map(([, v]) => v);
			expect(
				new Set(values).size,
				`${locale} declares two plural categories with the same sentence: ${named
					.map(([k]) => k)
					.join(', ')}`
			).toBe(values.length);
			// The catch-all must exist and must mirror `other`, or an unlisted category renders a
			// different sentence than the fallback the catalog was written against.
			expect(match['countPlural=*'], `${locale} has no catch-all`).toBe(match['countPlural=other']);
		}
	});
});
