// src/lib/admin/parse-money.test.ts
//
// ⛔⛔ THE ONLY PLACE IN THE LOCALE CHANGE WHERE A DISPLAY FIX CAN DESTROY DATA.
//
// `/tenants` renders a budget chip and, one click away, a free-text input that grants or tops up
// that budget for real — `commitTopUp` calls OpenRouter and writes an audit row. While the chip
// rendered `$1,234.56`, `parseMoney`'s `t.replace(/[$,\s]/g, '')` was safe: the comma really was a
// thousands separator. Localizing the chip makes a German operator read **`1.234,56 $`** and type
// it back, and stripping the comma yields `"1.23456"` → `parseFloat` → **1.23456**. A 1000×
// under-grant that passes `n > 0` and is never questioned.
//
// So the parser is tested here as its own unit, ahead of the screen, because the failure is silent
// and financial rather than visual.
//
// ⚠️ THE RULE IS *REJECT*, NOT *GUESS*. `1.234` is 1.234 in en and 1234 in de/nl and nothing in the
// string says which. Coercing it either way moves three orders of magnitude of someone's money on a
// coin flip; `null` makes the caller say "enter a valid amount" and costs the operator one retype.
import { describe, it, expect } from 'vitest';

import { parseMoney } from './parse-money';

describe('parseMoney', () => {
	it('blank is "no value", not an error', () => {
		expect(parseMoney('')).toBeUndefined();
		expect(parseMoney('   ')).toBeUndefined();
	});

	it('accepts a plain integer and a plain en decimal', () => {
		expect(parseMoney('1234')).toBe(1234);
		expect(parseMoney('1234.56')).toBe(1234.56);
		expect(parseMoney('$1234.56')).toBe(1234.56);
	});

	// ⛔ THE WHOLE POINT. Each of these is what the localized chip now shows a reader, typed back.
	it('⛔ round-trips what each locale actually renders', () => {
		expect(parseMoney('1,234.56'), 'en').toBe(1234.56); // $1,234.56
		expect(parseMoney('1.234,56'), 'de/nl').toBe(1234.56); // 1.234,56 $
		expect(parseMoney('1234,56'), 'es/pl single-separator').toBe(1234.56);
		expect(parseMoney('1.234.567,89'), 'de grouped').toBe(1234567.89);
		expect(parseMoney('1,234,567.89'), 'en grouped').toBe(1234567.89);
	});

	// ⛔⛔ THE REGRESSION, AS ITS OWN TEST. The old parser returned 1.23456 here — a 1000×
	// under-grant that passed every downstream check. It must now be either 1234.56 or a refusal,
	// and it is 1234.56 because the trailing group of two digits can only be a decimal part.
	it('⛔ "1.234,56" is never 1.23456 — the 1000x under-grant', () => {
		expect(parseMoney('1.234,56')).not.toBe(1.23456);
		expect(parseMoney('1.234,56')).toBe(1234.56);
	});

	// ⛔ AMBIGUOUS INPUT IS REFUSED, NOT GUESSED. `1.234` is the one shape no algorithm can resolve.
	// ⛔ THE REGRESSION ADVERSARIAL REVIEW FOUND — AND THE HALF OF IT I DISAGREED WITH.
	// The review reported that refusing `1,000`, `50,000`, `1,000,000` and `1.234.567` was a
	// regression against main. Measured under `bun -e`, only half of that holds:
	//
	//   TWO separators, same character  →  grouping. No locale writes two decimal points, so
	//   `1,000,000` and `1.234.567` carry no ambiguity at all. Refusing them WAS a regression and
	//   is fixed here. (main returned 1 for `1.000.000` — worse than refusing.)
	//
	//   ONE separator, three trailing digits  →  genuinely ambiguous, and refusing it is the
	//   POINT. `Intl.NumberFormat('de').format(1000)` is `"1.000"`, so `50,000` reads as FIFTY in
	//   de/nl and FIFTY THOUSAND in en — the same five characters, two readings a thousandfold
	//   apart, on a field that grants real money. main accepted it and picked en. One retype is
	//   the cheaper failure.
	it('⛔ accepts grouped integers — two separators are grouping, never a decimal', () => {
		expect(parseMoney('1,000,000')).toBe(1000000);
		expect(parseMoney('1.234.567')).toBe(1234567);
		expect(parseMoney('100,000,000')).toBe(100000000);
		expect(parseMoney('1 000 000')).toBe(1000000);
		expect(parseMoney('$1,234,567.89')).toBe(1234567.89);
	});

	it('⛔ refuses the one genuinely ambiguous shape, however common it looks', () => {
		// Every one of these is fifty-ish in de/nl and thousands-ish in en.
		for (const amb of ['1.234', '1,234', '1,000', '50,000', '12.500']) {
			expect(parseMoney(amb), `guessed at ${amb}`).toBeNull();
		}
	});

	it('refuses malformed grouping and non-money text', () => {
		for (const bad of ['1,23.45', '1.2,345', 'abc', '12abc', '1..2', '1,,2', '-5', '1.2345']) {
			expect(parseMoney(bad), `accepted ${bad}`).toBeNull();
		}
	});

	it('refuses zero and negatives — a budget grant must be positive', () => {
		expect(parseMoney('0')).toBeNull();
		expect(parseMoney('0.00')).toBeNull();
	});

	// The localized strings carry NBSP/NNBSP between figure and glyph, and the RTL ones carry an RLM.
	// An operator copying a rendered chip brings those with them.
	it('tolerates the whitespace and bidi marks a copied chip carries', () => {
		expect(parseMoney('1.234,56 $')).toBe(1234.56);
		expect(parseMoney('1 234 567,89 $')).toBe(1234567.89);
		expect(parseMoney('‏1,234.50 US$')).toBe(1234.5);
	});
});
