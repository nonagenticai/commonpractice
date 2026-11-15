// src/lib/utils/format.duration-text.test.ts — "~2 hrs" on a Dutch challenge page (live walk,
// 2026-10-15). Challenge metrics are free text and the seed wrote English units; `durationText`
// re-renders a parsable "<number> <unit>" in the reader's locale and leaves anything else alone.
//
// en/nl/de literals were measured on Node 25 / ICU 78 and are stable CLDR forms; ar/he plural forms
// (dual "ساعتان", "שעתיים") vary by ICU build, so for those only the English unit's absence is asserted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { durationText } from './format';

describe('durationText', () => {
	it('localises an approximate hour figure', () => {
		expect(durationText('~2 hrs', 'nl')).toBe('~2 uur');
		expect(durationText('~2 hrs', 'en')).toBe('~2 hours');
		expect(durationText('~2 hrs', 'de')).toBe('~2 Stunden');
		expect(durationText('~3 hrs', 'fr')).toMatch(/^~3\sheures$/); // fr puts a no-break space before the unit
	});

	it('handles decimals, other unit spellings and no approx marker', () => {
		expect(durationText('1,5 uur', 'nl')).toBe('1,5 uur');
		expect(durationText('1.5 hours', 'nl')).toBe('1,5 uur');
		expect(durationText('30 min', 'en')).toBe('30 minutes');
		expect(durationText('2 days', 'nl')).toBe('2 dagen');
	});

	it('never leaves the English unit in any of the 8 locales', () => {
		for (const loc of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			const out = durationText('~2 hrs', loc);
			expect(out, loc).not.toContain('hrs');
			expect(out.startsWith('~'), loc).toBe(true);
		}
	});

	it('the challenge impact tile renders the figure through durationText (call site)', () => {
		// The helper being right proves nothing if the page prints the raw value; this is the line
		// that showed "~2 hrs" in nl.
		const src = readFileSync(resolve(process.cwd(), 'src/routes/challenges/[id]/+page.svelte'), 'utf8');
		expect(src.length).toBeGreaterThan(1000);
		expect(src).toContain('value={durationText(data.metrics.timeSavedPerWeek, locale.current)}');
		expect(src).not.toContain('value={data.metrics.timeSavedPerWeek}');
	});

	it('never throws on prototype-member "units" and returns them unchanged', () => {
		// A plain-object unit table resolved these to Object.prototype members → Intl RangeError, and
		// the fallback constructor threw again, blanking the challenge page for every viewer.
		for (const raw of ['2 constructor', '__proto__ hrs', '2 __proto__', '3 toString', '1 hasOwnProperty', '2 valueOf']) {
			expect(() => durationText(raw, 'nl'), raw).not.toThrow();
			expect(durationText(raw, 'nl'), raw).toBe(raw);
		}
	});

	it('never throws on a bad locale tag', () => {
		expect(() => durationText('~2 hrs', 'not a locale!!')).not.toThrow();
	});

	it('leaves ambiguous separators as typed, and reads an unambiguous decimal comma', () => {
		expect(durationText('1,000 hrs', 'nl')).toBe('1,000 hrs');
		expect(durationText('1.000 hrs', 'nl')).toBe('1.000 hrs');
		expect(durationText('1.000,5 uur', 'nl')).toBe('1.000,5 uur');
		expect(durationText('1,5 uur', 'nl')).toBe('1,5 uur');
		expect(durationText('1,5 uur', 'en')).toBe('1.5 hours');
		expect(durationText('2 hrs', 'nl')).toBe('2 uur');
	});

	it('returns text it cannot parse unchanged', () => {
		for (const raw of ['', 'about two hours', 'lorem ipsum dolor', '~3 hrs/week', '2 weeks', '12%', '28']) {
			expect(durationText(raw, 'nl')).toBe(raw);
		}
	});
});
