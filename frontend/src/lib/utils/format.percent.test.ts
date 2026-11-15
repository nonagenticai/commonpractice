// src/lib/utils/format.percent.test.ts — the percent sign is locale data, not a character you append.
//
// ⛔ THE DEFECT `pct()` EXISTS FOR. `/datasets` rendered a mapping-confidence chip as
// `{Math.round(pick.confidence * 100)}%` — the only Intl bypass on the demo journey, in a file
// where every other user-facing number already goes through `num(x, locale.current)`. Gluing '%'
// into a template hard-codes the ENGLISH answer for eight locales.
//
// ⚠️ EVERY EXPECTATION IS A MEASURED CLDR STRING, NOT A GUESS — the doctrine `format.locale.test.ts`
// spells out at length, and its reasoning applies verbatim here. Each literal below was read out of
// this repo's Node/ICU (25.x / ICU 78) before being written down. Deriving them from `Intl` at test
// time would assert that the runtime agrees with itself, which is vacuous; asserting merely "the fr
// form differs from the en form" would pass against a helper that returned the runtime default for
// both. The codepoints are named because they are invisible and a future reader will otherwise
// "clean up" what looks like a stray space.
//
// ⛔ AND THESE LITERALS ARE STABLE ACROSS ICU BUILDS ONLY BECAUSE THE PRODUCT PINS THE NUMBERING
// SYSTEM. `format.ts` puts `numberingSystem: 'latn'` on every formatter it builds — without it the
// `ar` rows here would be a measurement of ONE BOX (ICU 78 gives `latn` for the generic `ar` tag,
// the CI runner's older ICU gives `arab`), which is the exact trap that reddened eight rows the
// first time `format.locale.test.ts` ran in CI. `pct` inherits that pin via `LATN`.
import { describe, it, expect } from 'vitest';
import { pct } from './format';

/** The eight SPEC §5B locales, in the order `stores/locale.svelte` lists them. */
const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

// ⛔ ESCAPES, NOT THE LITERAL CHARACTERS. Both of these are INVISIBLE in an editor, and a
// sibling render test was written with a plain ASCII space here by accident — it failed with
// `expected '86 %' to be '86 %'`, two strings that print identically. Never paste them raw.
const NBSP = '\u00A0'; // NO-BREAK SPACE — what de/fr/es put before the sign
const LRM = '\u200E'; // LEFT-TO-RIGHT MARK — what ar wraps the sign in

/**
 * `0.855` at zero fraction digits, measured per locale. The value is deliberately one that rounds
 * (85.5 → 86) so a helper that truncated would be visible here too.
 */
const AT_855: Record<(typeof LOCALES)[number], string> = {
	en: '86%',
	nl: '86%',
	pl: '86%',
	fr: `86${NBSP}%`,
	es: `86${NBSP}%`,
	de: `86${NBSP}%`,
	ar: `86${LRM}%${LRM}`,
	he: '86%'
};

describe('pct() renders a fraction as the reader’s percentage', () => {
	it('⛔ every locale, measured', () => {
		for (const l of LOCALES) expect(pct(0.855, l), l).toBe(AT_855[l]);
	});

	it('⛔ and four of the eight DIFFER from the naive `Math.round(x*100) + "%"`', () => {
		// THE POINT OF THE HELPER, STATED AS A LIST RATHER THAN AS A FEELING. `de`, `fr` and `es`
		// gain a NO-BREAK SPACE; `ar` gains LEFT-TO-RIGHT MARKs bracketing the sign — without those
		// the '%' is a NEUTRAL between a Latin digit run and Arabic text, so UAX#9 resolves it to
		// the RTL base level and renders it on the WRONG SIDE of the number. Same class of defect
		// as an unisolated slug; Intl is the thing that already knows the answer.
		const naive = `${Math.round(0.855 * 100)}%`;
		expect(naive).toBe('86%');
		const differs = LOCALES.filter((l) => pct(0.855, l) !== naive);
		expect([...differs].sort()).toEqual(['ar', 'de', 'es', 'fr']);
		// ⚠️ AND THE OTHER FOUR ARE IDENTICAL TO IT, SAID OUT LOUD. `en`, `nl`, `he` and `pl` render
		// exactly the naive string, so this fix is invisible on the Dutch screen — a reader who
		// expected `nl` to change (the inherited brief offered "ar or nl") should stop looking.
		const same = LOCALES.filter((l) => pct(0.855, l) === naive);
		expect([...same].sort()).toEqual(['en', 'he', 'nl', 'pl']);
	});

	it('takes a FRACTION — 1 is "100%", not "1%"', () => {
		// The 100x trap `style: 'percent'` sets for anyone who hands it an already-scaled value.
		expect(pct(1, 'en')).toBe('100%');
		expect(pct(0, 'en')).toBe('0%');
		expect(pct(0.07, 'en')).toBe('7%');
	});

	it('honours an explicit digit count, keeping the trailing zero', () => {
		// BOTH bounds pinned, which is why `num()` was not enough: its `maximumFractionDigits`
		// default is 3 and its minimum 0, so a round tenth would silently lose its decimal.
		expect(pct(0.9, 'en', 1)).toBe('90.0%');
		expect(pct(0.9, 'nl', 1)).toBe('90,0%');
		expect(pct(0.8567, 'en', 2)).toBe('85.67%');
	});

	it('a malformed locale tag falls back instead of unmounting the screen', () => {
		// `Intl` raises `RangeError` on a bad tag, and an uncaught throw inside a `$derived` takes
		// the whole screen down — the reason every helper in this module carries the same try/catch.
		expect(() => pct(0.5, 'not a tag')).not.toThrow();
		expect(pct(0.5, 'not a tag')).toContain('50');
	});

	it('a non-number renders the module’s em-dash sentinel, and does not re-throw', () => {
		// Same measured reason as `num()`: the catch would call Intl on the same bad value and
		// throw out of the catch block, so the guard has to come first.
		expect(pct(null as unknown as number, 'en')).toBe('—');
		expect(pct(undefined as unknown as number, 'en')).toBe('—');
	});
});
