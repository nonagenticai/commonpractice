// src/lib/admin/parse-money.ts — a pure parser, in its own module for the same reason
// `license-chip.ts` is: it must be testable under vitest's node env, without a Svelte component
// around it, because what it gets wrong is money rather than markup.

/**
 * Parse a free-text money field. Returns undefined for blank, null for invalid.
 *
 * ⛔⛔ THIS IS THE HALF OF THE LOCALE CHANGE THAT CAN DESTROY DATA, AND IT IS WHY THE DISPLAY FIX
 * COULD NOT SHIP ALONE.
 *
 * The old body was `Number.parseFloat(t.replace(/[$,\s]/g, ''))` — strip `$`, strip EVERY comma,
 * parse. That was safe only while the chip beside this input rendered `$1,234.56`, where the
 * comma really is a thousands separator. Localizing the display makes a German operator read
 * **`1.234,56 $`** and type it back. Stripping the comma then yields `"1.23456"`, and
 * `parseFloat` returns **1.23456** — a 1000× UNDER-GRANT that passes `n > 0`, hits a real
 * OpenRouter top-up and writes an audit row. The display change MANUFACTURES the misreading.
 *
 * ⚠️ SO THE RULE IS: NEVER COERCE AN AMBIGUOUS STRING. `1.234` is one-point-two-three-four in en
 * and one-thousand-two-hundred-thirty-four in de/nl, and nothing in the string says which. The
 * parser now REJECTS (returns null → the caller shows "enter a valid amount") rather than
 * silently picking one reading and moving three orders of magnitude of someone's budget.
 *
 * Accepted, unambiguously:
 *   · digits with ONE separator used as a DECIMAL point, in either convention: `1234.56`,
 *     `1234,56` — decided by the group of 1-2 trailing digits, which no thousands group can have.
 *   · digits with grouping that is internally consistent: `1,234.56` / `1.234,56` — the LAST
 *     separator is the decimal one and the others must sit in strict groups of three.
 *   · plain integers, with or without grouping: `1234`, `1,234`, `1.234` → the last two are
 *     REJECTED as ambiguous rather than guessed (see above).
 * Rejected: anything else, including two different separators in an impossible order.
 */
export function parseMoney(raw: string): number | undefined | null {
	// ⚠️ STRIP THE CURRENCY TOKEN EXPLICITLY, at either end, not "any non-digit". `usd()` renders
	// `US$` in `ar` (CLDR has no narrow USD form there), so a chip copied from that locale arrives
	// as `‏1,234.50 US$`. A blanket "drop everything that is not a digit" would go too far the other
	// way and silently accept `12abc` as 12.
	// Also removed: NBSP / NNBSP (what ICU puts between figure and glyph) and the RTL marks the two
	// RTL locales embed — all invisible, and all carried along by a copy.
	const t = raw
		.trim()
		.replace(/^(?:US\$|\$)|(?:US\$|\$)$/g, '')
		.replace(/[\s\u00a0\u202f\u200e\u200f\u061c]/g, '');
	if (!t) return undefined;
	if (!/^\d[\d.,]*$/.test(t)) return null;

	const seps = t.match(/[.,]/g) ?? [];
	if (seps.length === 0) return finite(t);

	const distinct = new Set(seps);
	const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
	const intPart = t.slice(0, last);
	const fracPart = t.slice(last + 1);

	if (distinct.size === 1) {
		const sep = seps[0]!;
		// ⛔ TWO OR MORE OF THE SAME SEPARATOR IS GROUPING, AND REFUSING IT WAS A REGRESSION.
		// My first version sent `1,000,000` and `1.234.567` down the ambiguity path and returned
		// null — while the identical `1 000 000` was accepted. An operator typing `50,000` into the
		// top-up field got "enter a valid amount"; on `main` it was 50000. Found by adversarial
		// review, which diffed this function against main across a table of real inputs.
		// No locale writes two decimal separators, so this shape carries no ambiguity at all.
		if (seps.length >= 2) {
			return groupedOnly(t, sep) ? finite(t.split(sep).join('')) : null;
		}
		// ⛔ ONE SEPARATOR, THREE TRAILING DIGITS: THE ONE SHAPE NOBODY CAN RESOLVE. `1.234` is
		// 1.234 in en and 1234 in de/nl and nothing in the string says which. Coercing it either way
		// moves three orders of magnitude of someone's budget on a coin flip; `null` costs one
		// retype. This is the ONLY case that is refused for ambiguity rather than for malformity.
		if (fracPart.length === 3) return null;
		// 1–2 trailing digits can only be a decimal part: no locale groups in ones or twos.
		if (fracPart.length === 0 || fracPart.length > 2) return null;
		return finite(`${intPart}.${fracPart}`);
	}

	// Mixed separators: the LAST one is the decimal point, everything before it must be grouped by
	// the other character in strict threes. `1,23.45` and `1.2,345` are not money in any locale.
	const decimalSep = t[last]!;
	const otherSep = decimalSep === '.' ? ',' : '.';
	if (intPart.includes(decimalSep)) return null;
	if (!groupedOnly(intPart, otherSep)) return null;
	if (fracPart.length === 0 || fracPart.length > 2) return null;
	return finite(`${intPart.split(otherSep).join('')}.${fracPart}`);
}

/** `1.234.567` / `1,234,567` — a leading group of 1-3 digits then strict groups of exactly 3. */
function groupedOnly(s: string, sep: string): boolean {
	const esc = sep === '.' ? '\\.' : ',';
	return new RegExp(`^\\d{1,3}(?:${esc}\\d{3})+$`).test(s);
}

/** A budget grant must be a positive finite number; everything else is a refusal. */
function finite(s: string): number | null {
	const n = Number.parseFloat(s);
	return Number.isFinite(n) && n > 0 ? n : null;
}
