// src/lib/utils/format.demo-duration.test.ts — the unit `demoDuration()` picks, asserted as WHICH
// CATALOG KEY WITH WHICH PARAMS, never as rendered English.
//
// ⛔ WHY THIS FILE EXISTS AT ALL. It did not, and an adversarial review proved the hole: widening
// the seconds/minutes boundary from `tenths < 600` to `tenths < 6000` left the ENTIRE frontend suite
// green (662/662). A 90-second demo would have rendered "90.0s" instead of "1m 30s", and
// `demo_dur_min_sec` — shipped in all 8 catalogs — would never have rendered anywhere, ever.
// Dropping the negative clamp was equally invisible. `demoDuration`'s own header spends twenty lines
// arguing that its rounding ORDER is load-bearing; nothing held it there.
//
// ⛔ ASSERTIONS ARE ON KEY IDENTITY, NOT ON STRINGS, for the reason the sibling
// `format.duration.test.ts` states: asserting on "3.4s" would pass just as happily if the code
// concatenated a Latin "s" in the template, which is the untranslatable, bidi-ambiguous construction
// this function exists to avoid.
//
// ⛔ THE ROUNDING-ORDER CASES ARE THE POINT. Each bucket must test the value it is about to PRINT,
// never the raw one. Round in the wrong order and the formatter emits "1000ms", "60.0s" or
// "1m 60s" — each the NEXT bucket's answer wearing this bucket's unit. Those three impossible
// outputs are asserted against directly.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	demo_dur_ms: ({ count }: { count: number }) => `DEMO_MS:${count}`,
	demo_dur_sec: ({ count }: { count: string }) => `DEMO_SEC:${count}`,
	demo_dur_min_sec: ({ mins, secs }: { mins: number; secs: number }) => `DEMO_MINSEC:${mins}:${secs}`,
	// Same module, compiled alongside; unused here.
	pipeline_dur_min: () => 'min',
	pipeline_dur_hour: () => 'hour',
	pipeline_dur_day: () => 'day',
	timeago_sec: () => 'sec',
	timeago_min: () => 'min',
	timeago_hour: () => 'hour',
	timeago_hour_min: () => 'hourmin',
	timeago_day: () => 'day',
	timeago_day_hour: () => 'dayhour'
}));

const { demoDuration } = await import('./format');

describe('demoDuration() — the bucket boundaries', () => {
	it('renders sub-second runs in milliseconds', () => {
		// A 2-block flow really does finish in a few hundred ms. This bucket is why the wire carries
		// MILLISECONDS: shipping whole seconds would deliver 0 and the board would hide a real run.
		expect(demoDuration(1, 'en')).toBe('DEMO_MS:1');
		expect(demoDuration(400, 'en')).toBe('DEMO_MS:400');
		expect(demoDuration(999, 'en')).toBe('DEMO_MS:999');
	});

	it('⛔ 0 ms is DATA, and renders — it is not absence', () => {
		// Absence is `demoMs == null` and is handled by the CALLERS, which omit the clause entirely.
		// A function that returned '—' or '' here would put the em-dash back on the payoff screen.
		expect(demoDuration(0, 'en')).toBe('DEMO_MS:0');
	});

	it('crosses into seconds at 1000 ms and never prints "1000ms"', () => {
		// ⛔ NON-VACUITY: round BEFORE choosing the bucket (`Math.round(safe/100)` first) and 999.5
		// prints `DEMO_MS:1000` — the seconds bucket's answer wearing the ms unit.
		expect(demoDuration(999.5, 'en')).toBe('DEMO_SEC:1.0');
		expect(demoDuration(1000, 'en')).toBe('DEMO_SEC:1.0');
		expect(demoDuration(3400, 'en')).toBe('DEMO_SEC:3.4');
	});

	it('⛔ crosses into minutes at 60 s and never prints "60.0s" — the boundary NOTHING held', () => {
		// ⛔ NON-VACUITY, AND THE WHOLE REASON THIS FILE EXISTS: change `tenths < 600` to any larger
		// number and this is the assertion that reds. Before it, the mutation was invisible.
		expect(demoDuration(59_949, 'en')).toBe('DEMO_SEC:59.9');
		expect(demoDuration(59_950, 'en')).toBe('DEMO_MINSEC:1:0');
		expect(demoDuration(60_000, 'en')).toBe('DEMO_MINSEC:1:0');
		expect(demoDuration(90_000, 'en')).toBe('DEMO_MINSEC:1:30');
	});

	it('never emits a seconds part of 60 — rounded once, then split', () => {
		// ⛔ NON-VACUITY: split before rounding (`Math.floor(whole/60000)` + `Math.round(...)`) and
		// 119_600 ms prints `1:60`.
		for (const ms of [59_950, 60_000, 119_600, 119_999, 120_000, 3_599_600]) {
			const out = demoDuration(ms, 'en');
			expect(out, `${ms} ms produced a 60-second remainder`).not.toMatch(/:60$/);
		}
	});

	it('⛔ clamps the impossible rather than rendering it', () => {
		// A negative or non-finite duration is a bug upstream, but "-3.4s" beside a solution is a
		// claim about time travel. ⛔ NON-VACUITY: drop `Math.max(0, …)` and the first reds; drop
		// `Number.isFinite` and the rest do.
		expect(demoDuration(-1, 'en')).toBe('DEMO_MS:0');
		expect(demoDuration(Number.NaN, 'en')).toBe('DEMO_MS:0');
		expect(demoDuration(Number.POSITIVE_INFINITY, 'en')).toBe('DEMO_MS:0');
		expect(demoDuration(Number.NEGATIVE_INFINITY, 'en')).toBe('DEMO_MS:0');
	});

	it('every bucket is reachable, so no catalog key ships unrenderable', () => {
		// The failure this guards is the one the review found: a boundary mutation orphaned
		// `demo_dur_min_sec` in all 8 catalogs with nothing to notice.
		const keys = new Set([400, 3400, 90_000].map((ms) => demoDuration(ms, 'en').split(':')[0]));
		expect(keys).toEqual(new Set(['DEMO_MS', 'DEMO_SEC', 'DEMO_MINSEC']));
	});
});

describe('demoDuration() — the DECIMAL SEPARATOR belongs to the reader', () => {
	// ⛔ THE DEFECT. The seconds bucket built its figure with `(tenths / 10).toFixed(1)`, and
	// `toFixed` writes a '.' in every language there is. In nl and de that character is the
	// THOUSANDS separator, so the payoff screen told a Dutch reader their demo took "3.4s" — the
	// same inversion `num()` was fixed for, on the one figure in this module that has a fraction.
	//
	// ⚠️ ONLY the seconds bucket can carry this defect, which is why only it is driven here: the
	// other two keys interpolate integers under a thousand, and no locale punctuates those.

	it('THE DUTCH CASE: 3400 ms is "3,4", and the English "3.4" is not what it renders', () => {
		expect(demoDuration(3400, 'nl')).toBe('DEMO_SEC:3,4');
		// The assertion that inverts on a revert to `.toFixed(1)`: that expression yields '3.4' for
		// every locale, so this line is the one that reds.
		expect(demoDuration(3400, 'nl')).not.toBe('DEMO_SEC:3.4');
	});

	it('renders the seconds figure in all eight locales, each with its own separator', () => {
		// Measured against this repo's own ICU, not written from memory. ar and he resolve to Latin
		// digits with a '.' — the same finding `format.locale.test.ts` already records for `num`.
		const table: Record<string, string> = {
			en: 'DEMO_SEC:3.4',
			nl: 'DEMO_SEC:3,4',
			pl: 'DEMO_SEC:3,4',
			fr: 'DEMO_SEC:3,4',
			es: 'DEMO_SEC:3,4',
			de: 'DEMO_SEC:3,4',
			ar: 'DEMO_SEC:3.4',
			he: 'DEMO_SEC:3.4'
		};
		for (const [l, expected] of Object.entries(table))
			expect(demoDuration(3400, l), `locale ${l}`).toBe(expected);
		// Non-vacuity: a helper that ignored its argument could not produce two different forms.
		expect(new Set(Object.keys(table).map((l) => demoDuration(3400, l))).size).toBe(2);
	});

	it('⛔ keeps the trailing zero — 1.0s must not collapse to "1"', () => {
		// `num()` would have been the wrong helper here: its default `maximumFractionDigits` is 3
		// and its minimum is 0, so a round tenth prints as "1" and `demoDuration`'s own argument
		// that "1.2 s and 1.9 s are visibly different demos" quietly stops holding at every whole
		// second. ⛔ NON-VACUITY: swap `decimal1` for `num` and both of these red.
		expect(demoDuration(1000, 'en')).toBe('DEMO_SEC:1.0');
		expect(demoDuration(1000, 'nl')).toBe('DEMO_SEC:1,0');
	});

	it('falls back instead of throwing on a malformed locale tag', () => {
		// Same reasoning as `num`/`dayMonth`: an `Intl` RangeError here would unmount the /winner
		// hero over a bad tag, and a comma in the wrong place is the smaller failure by far.
		expect(() => demoDuration(3400, 'not a tag')).not.toThrow();
		expect(demoDuration(3400, 'not a tag')).toMatch(/^DEMO_SEC:3\.4$/);
	});
});
