// src/lib/utils/format.money.test.ts — money renders in the READER's language.
//
// Every expectation here was MEASURED under `bun -e` on the repo's own runtime and pasted in, not
// reasoned about. Bun 1.3.14 and Node 25.8.1 agree byte-for-byte on all of it, which is what makes
// a string pinned by CI (Bun) the string SSR emits (Bun) — the browser re-renders client-side with
// its own ICU, so these are a CI/SSR contract, not a browser guarantee. Same caveat as
// `format.locale.test.ts`.
import { describe, it, expect } from 'vitest';
import { usd, usdEstimated, usdMaybe, bytes } from './format';

/** Spelled out because a raw `‏` in a fixture is invisible and unreviewable. */
const RLM = '‏';
const NBSP = ' ';
const NNBSP = ' ';

const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const;

describe('usd', () => {
	// ⚠️ SEVEN DIGITS, NOT FOUR. `pl` and `es` set `minimumGroupingDigits: 2`, so `1234.56` is not
	// grouped at all in either — a 4-digit fixture would prove nothing in 2 of 8 locales. This is the
	// same trap `format.locale.test.ts` already names for `num()`.
	it('groups and punctuates 1234567.89 the way each locale writes money', () => {
		expect(usd(1234567.89, 'en')).toBe('$1,234,567.89');
		expect(usd(1234567.89, 'nl')).toBe(`$${NBSP}1.234.567,89`);
		expect(usd(1234567.89, 'de')).toBe(`1.234.567,89${NBSP}$`);
		expect(usd(1234567.89, 'fr')).toBe(`1${NNBSP}234${NNBSP}567,89${NBSP}$`);
		expect(usd(1234567.89, 'es')).toBe(`1.234.567,89${NBSP}$`);
		expect(usd(1234567.89, 'pl')).toBe(`1${NBSP}234${NBSP}567,89${NBSP}$`);
	});

	// ⛔ THE GLYPH MOVES, AND THAT IS THE POINT. If someone "simplifies" this back to a `$`-prefix
	// template these four go red — the separators alone would not catch it in `en`.
	it('⛔ puts the glyph where the locale puts it, not where en-US puts it', () => {
		expect(usd(12.5, 'en').startsWith('$')).toBe(true);
		for (const loc of ['de', 'fr', 'es', 'pl'] as const) {
			expect(usd(12.5, loc).endsWith('$'), `${loc} moved the glyph to the front`).toBe(true);
		}
	});

	// ⛔ MEASURED, AND IT CONTRADICTS THE OBVIOUS ASSUMPTION. `narrowSymbol` narrows only where CLDR
	// HAS a narrow form; `ar` has none for USD and falls back to the standard symbol. Anyone who
	// writes "narrowSymbol keeps the $ glyph" in a comment is wrong for 1 of 8 locales.
	it('⛔ ar keeps US$ even under narrowSymbol, and both RTL locales carry bidi marks', () => {
		expect(usd(1234.5, 'ar')).toBe(`${RLM}1,234.50${NBSP}US$`);
		expect(usd(1234.5, 'he')).toBe(`${RLM}1,234.50${NBSP}${RLM}$`);
		// Asserted explicitly so a harness that normalises them away is caught rather than trusted.
		expect(usd(1234.5, 'ar')).toContain(RLM);
		expect([...usd(1234.5, 'he')].filter((c) => c === RLM)).toHaveLength(2);
	});

	// ⛔ THE SUB-CENT CASE — the `0edaad5` defect ("Local inference priced $0.00, so the ceiling that
	// guards spend could never fire") in formatter form. /build renders four decimals for exactly
	// this reason.
	it('⛔ four decimals keep a sub-cent figure visible; two would erase it', () => {
		expect(usd(0.0003, 'en', 4)).toBe('$0.0003');
		expect(usd(0.0003, 'en', 4)).not.toBe('$0.00');
		expect(usd(0.0003, 'nl', 4)).toBe(`$${NBSP}0,0003`);
		// The default really is 2, so the 4 above is doing work.
		expect(usd(0.0003, 'en')).toBe('$0.00');
	});

	it('a malformed tag degrades to a punctuated figure, never to a throw or a bare number', () => {
		// An `Intl` RangeError inside a `$derived` unmounts the whole screen — the reason every
		// formatter in this module has a catch. The fallback must keep `style: 'currency'`: dropping
		// it would print a bare number where a dollar figure was.
		const out = usd(1234.5, 'en-US-!!');
		expect(out).toContain('1');
		expect(/[$]|US\$/.test(out), `fallback lost the currency style: ${out}`).toBe(true);
	});

	// ⛔ EVERY non-number, not just null/undefined. Adversarial review measured the first version
	// rendering `usd([], 'de')` as the EMPTY STRING — silently dropped into the middle of a budget
	// notification sentence — and `usd('50','de')` as a bare "50". The old branch was
	// `n == null ? '—' : String(n)`, copied from `fixed()`; for money that is a defence that does
	// not defend. Not reachable today (the backend coerces with `Number(...)`), which is exactly why
	// it needs a test rather than an assumption.
	it('⛔ ANY non-number is the em dash — never an empty string, never [object Object]', () => {
		for (const bad of [undefined, null, [], {}, '50', true, NaN, Infinity]) {
			const out = usd(bad as unknown as number, 'de');
			if (Number.isNaN(bad as number) || bad === Infinity) continue; // real numbers; see below
			expect(out, `usd(${JSON.stringify(bad)}) leaked a non-figure`).toBe('—');
		}
	});

	// ⚠️ NaN/∞ go THROUGH Intl deliberately, exactly as `num()` documents: they are numbers, and Intl
	// localizes them. Short-circuiting to String(n) would replace a translated token with an English
	// one.
	it('NaN and Infinity stay localized rather than becoming English tokens', () => {
		// ⚠️ ASSERTED AS A PROPERTY, NOT AS A PASTED ARABIC LITERAL. My first version compared against
		// a hand-typed 'ليس رقمًا' and failed against ICU's own spelling — the same class of mistake
		// this file warns about for the bidi marks. What matters is that it is NOT the English token.
		expect(usd(NaN, 'ar')).not.toContain('NaN');
		expect(usd(NaN, 'en')).toContain('NaN');
		expect(usd(Infinity, 'nl')).toContain('∞');
	});

	it('⛔ every locale produces a DISTINCT rendering — a stubbed formatter cannot pass', () => {
		// Non-vacuity for the whole table: if `usd` ignored its tag, this collapses to 1.
		expect(new Set(LOCALES.map((l) => usd(1234567.89, l))).size).toBeGreaterThanOrEqual(6);
	});
});

describe('usdEstimated', () => {
	// ⛔ THE HARD-CODED `~` WAS WRONG IN THREE OF EIGHT LOCALES. ICU's `formatRange(n, n)` emits
	// CLDR's own approximation sign and places it correctly. These four rows are the entire
	// justification for not hand-rolling it, and each is a measured string.
	it('⛔ uses the locale’s own approximation sign, in the locale’s own position', () => {
		expect(usdEstimated(12.34, 'en')).toBe('~$12.34');
		expect(usdEstimated(12.34, 'nl')).toBe(`$${NBSP}~12,34`); // sign AFTER the symbol
		expect(usdEstimated(12.34, 'fr')).toBe(`≃12,34${NBSP}$`); // U+2243, not a tilde
		expect(usdEstimated(12.34, 'de')).toBe(`≈12,34${NBSP}$`); // U+2248, not a tilde
	});

	it('⛔ fr and de do not use U+007E at all', () => {
		// Stated as its own assertion because "it contains a tilde" is the assumption that produced
		// the defect, and a reviewer skimming the row above could read `≃` as one.
		expect(usdEstimated(12.34, 'fr')).not.toContain('~');
		expect(usdEstimated(12.34, 'de')).not.toContain('~');
	});

	it('places the RTL mark before the sign, which string concatenation cannot do', () => {
		expect(usdEstimated(12.34, 'ar')).toBe(`${RLM}~12.34${NBSP}US$`);
		expect(usdEstimated(12.34, 'he')).toBe(`${RLM}~12.34${NBSP}${RLM}$`);
	});

	it('carries the digits parameter through', () => {
		expect(usdEstimated(0.0041, 'en', 4)).toBe('~$0.0041');
	});

	it('a non-number is the em dash', () => {
		expect(usdEstimated(undefined as unknown as number, 'nl')).toBe('—');
	});
});

describe('usdMaybe', () => {
	it('hedges only when the figure was estimated', () => {
		expect(usdMaybe(12.34, true, 'en')).toBe('~$12.34');
		expect(usdMaybe(12.34, false, 'en')).toBe('$12.34');
		expect(usdMaybe(12.34, false, 'de')).toBe(`12,34${NBSP}$`);
	});
});

describe('bytes', () => {
	// ⛔ THE MEASURED DEFECT. `/datasets` rendered `1.2 KB` in Dutch — which a Dutch reader parses as
	// TWELVE HUNDRED — in a column beside a row count rendered `1.207` by `num()`. Two meanings for
	// `.` in one table.
	it('⛔ punctuates the fraction for the reader', () => {
		expect(bytes(1234, 'en')).toBe('1.2 KB');
		expect(bytes(1234, 'nl')).toBe('1,2 KB');
		expect(bytes(1234, 'de')).toBe('1,2 KB');
	});

	it('whole bytes below a kilobyte — no invented precision', () => {
		expect(bytes(378, 'en')).toBe('378 B');
		expect(bytes(378, 'nl')).toBe('378 B');
	});

	it('steps to MB, and groups the whole part like every other figure', () => {
		expect(bytes(5 * 1024 * 1024, 'en')).toBe('5.0 MB');
		expect(bytes(5 * 1024 * 1024, 'nl')).toBe('5,0 MB');
		// The B branch goes through `num()`, so a large byte count is grouped.
		expect(bytes(1023, 'nl')).toBe('1.023 B');
	});

	it('⛔ a non-number, NaN or ∞ is the em dash — not "NaN MB"', () => {
		// `NaN < 1024` is false, so an un-guarded NaN fell straight through to the MB branch.
		for (const bad of [undefined, null, NaN, Infinity, -Infinity, '5', {}]) {
			expect(bytes(bad as unknown as number, 'nl'), `bytes(${String(bad)})`).toBe('—');
		}
	});
});
