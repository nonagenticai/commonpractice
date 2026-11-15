// src/lib/utils/format.locale.test.ts — every figure and date on screen is formatted in the APP's
// locale, which is not the same value as the browser's.
//
// ⛔ THE DEFECT. `num()` was `n.toLocaleString()`; the chart labels were `toLocaleDateString([], …)`,
// `toLocaleTimeString([], …)` and `toLocaleDateString(undefined, …)`. A bare call, `[]` and
// `undefined` are three spellings of the SAME thing — the RUNTIME's locale — and the app's locale
// is a different value the moment a reader picks one in the Topbar. A Dutch UI on an en-US machine
// printed "1,207" where Dutch reads "1.207" (the thousands and decimal separators are SWAPPED
// between those two languages, so this is not a typographic nicety) and "Aug 7" where the rest of
// the sentence was Dutch.
//
// ⚠️ EVERY EXPECTATION IS A MEASURED CLDR STRING, NOT A GUESS. Each was read out of this repo's own
// Node/ICU before being written down. Asserting "the nl form differs from the en form" would pass
// against a helper that returned the runtime default for both on any machine whose locale is
// neither — the point is WHICH string, per locale.
//
// ⛔ …AND "MEASURED" IS NOT THE SAME AS "STABLE", WHICH IS WHAT THIS FILE LEARNED THE HARD WAY.
// Eight of the ten reds in the first CI run that ever executed this suite were ar rows: the
// DEFAULT NUMBERING SYSTEM for the generic `ar` tag is `latn` on ICU 78 and `arab` on the runner's
// older ICU, so every ar literal here was a measurement of ONE BOX wearing the clothes of a CLDR
// fact. The fix was in the PRODUCT, not here — `format.ts` pins `numberingSystem: 'latn'` on every
// formatter it builds, and the catalogs pin the same on the numbers inside ICU messages. These
// literals are therefore assertions about a decision the app makes, and they hold on any ICU.
// Do not "repair" a future ar red by deriving the expectation from `Intl` — that would assert the
// runtime agrees with itself, which is the vacuity the paragraph above rules out.
//
// ⚠️ SHAPE MIRRORS components/marketplace/cadence-day.test.ts, the file that already pins an
// explicit-locale Intl helper across the same eight SPEC §5B tags, including its malformed-tag and
// regional-variant cases. The parallel is deliberate: these are the same class of bug and should
// be read together.
//
// ⛔ DATES BUILT WITH THE LOCAL-TIME CONSTRUCTOR `new Date(y, m, d, h, min)` WHEREVER THE HELPER
// FORMATS IN LOCAL TIME. An ISO string is parsed as UTC and would make these assertions pass or
// fail by the timezone of the machine running them. The one block that formats in UTC states so by
// passing 'UTC' explicitly, and drives the TZ to prove it.
import { describe, it, expect } from 'vitest';
import { num, exact, ms, hourMinute, dayMonth, fullDate } from './format';

/** The eight SPEC §5B locales, in the order stores/locale.svelte lists them. */
const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

// U+00A0 NO-BREAK SPACE (pl) and U+202F NARROW NO-BREAK SPACE (fr) — spelled as escapes because an
// invisible difference between two space characters is exactly the kind of thing a reviewer's eye
// repairs silently, and `'1 234 567'` with an ASCII space would be a wrong expectation that LOOKS
// right.
const NBSP = ' ';
const NNBSP = ' ';

describe('num — grouped in the reader’s language', () => {
	it('THE STATED CASE: 1207 is "1,207" in English and "1.207" in Dutch', () => {
		// The exact figure from the bug report. In nl the '.' groups thousands and the ',' is the
		// DECIMAL separator, so the pre-fix output was not merely foreign — to a Dutch reader
		// "1,207" is one-point-two-oh-seven.
		expect(num(1207, 'en')).toBe('1,207');
		expect(num(1207, 'nl')).toBe('1.207');
		expect(num(1207, 'de')).toBe('1.207');
	});

	it('⚠️ …and 1207 is NOT a sufficient fixture on its own — pl and es do not group it at all', () => {
		// THE TRAP THIS TEST EXISTS TO NAME. CLDR sets `minimumGroupingDigits: 2` for Polish and
		// Spanish, so a four-digit number is printed ungrouped in both. A suite whose only fixture
		// were 1207 (or anything under 1000, where NO locale groups) would assert equality with the
		// runtime default in six of eight locales and prove nothing about whether the argument was
		// read. That is why the table below uses a seven-digit figure.
		expect(num(1207, 'pl')).toBe('1207');
		expect(num(1207, 'es')).toBe('1207');
		// Under 1000 there is no separator anywhere: all eight agree, so no assertion on 999 can
		// distinguish a locale-aware helper from a locale-less one.
		expect(new Set(LOCALES.map((l) => num(999, l))).size).toBe(1);
	});

	it('renders 1234567 in all eight locales, each in its own grouping', () => {
		const table: Record<(typeof LOCALES)[number], string> = {
			en: '1,234,567',
			nl: '1.234.567',
			pl: `1${NBSP}234${NBSP}567`,
			fr: `1${NNBSP}234${NNBSP}567`,
			es: '1.234.567',
			de: '1.234.567',
			// ⛔ LATIN DIGITS FOR ar AND he BECAUSE THE PRODUCT PINS THEM, NOT BECAUSE CLDR HAPPENS
			// TO AGREE TODAY. This row used to read "modern CLDR resolves the generic `ar` tag to
			// latn" — a claim that is true of ICU 78 and FALSE of the CI runner's older ICU, where
			// the same call returns '١٬٢٣٤٬٥٦٧'. It was a MEASUREMENT OF ONE BOX written down as a
			// property of the language, and it red this suite the first time the gate actually ran.
			// `format.ts` now passes `numberingSystem: 'latn'` explicitly (see the LATN block at the
			// top of that file for why latn and not arab), so this literal is a statement about the
			// product and holds on every ICU build.
			ar: '1,234,567',
			he: '1,234,567'
		};
		for (const l of LOCALES) expect(num(1234567, l), `locale ${l}`).toBe(table[l]);
	});

	it('the eight renderings are not one string wearing eight names', () => {
		// Non-vacuity: at least three genuinely different forms come out, so a helper that ignored
		// its argument and returned the runtime default could not satisfy the table above.
		expect(new Set(LOCALES.map((l) => num(1234567, l))).size).toBeGreaterThanOrEqual(3);
	});

	it('resolves a regional variant to its language', () => {
		expect(num(1234567, 'nl-BE')).toBe('1.234.567');
	});

	it('falls back instead of throwing on a malformed locale tag', () => {
		// `(1).toLocaleString('not a tag')` throws a RangeError; on /it-dash that would take the
		// whole dashboard down over a bad tag. A wrongly-grouped figure is the smaller failure.
		expect(() => num(1234567, 'not a tag')).not.toThrow();
		expect(num(1234567, 'not a tag')).toBeTruthy();
	});

	describe('⛔ …and the fallback actually falls back, which for a NON-NUMBER it did not', () => {
		// THE MEASURED HOLE. The `catch` calls `n.toLocaleString()` on THE SAME VALUE, so it only
		// ever rescues a bad TAG. Handed a bad VALUE it re-threw out of the catch block:
		//   num(undefined, 'nl') → TypeError: Cannot read properties of undefined
		// …and an uncaught throw inside a `$derived` unmounts the screen — precisely what the
		// try/catch's own comment says it exists to prevent.
		//
		// ⚠️ NOT REACHABLE FROM ANY CALL SITE TODAY: all 18 wrapped values are typed `number` and the
		// two most exposed are `notNull` in the schema. This is hardening ahead of the first
		// `number | null` field, not a live defect — stated plainly so the next reader does not go
		// hunting for a broken screen.
		it('undefined and null return the “no figure” sentinel instead of throwing', () => {
			const bad = undefined as unknown as number;
			expect(() => num(bad, 'nl')).not.toThrow();
			expect(num(bad, 'nl')).toBe('—');
			expect(num(null as unknown as number, 'nl')).toBe('—');
			// '—' is the sentinel `ms()`, `timeAgo()` and `fullDate()` in this module already use.
			expect(ms(null, 'nl')).toBe('—');
		});

		it('⛔ NaN and Infinity still go through Intl — they are numbers, and Intl TRANSLATES them', () => {
			// Short-circuiting these to `String(n)` would put an English "NaN"/"Infinity" on an Arabic
			// screen. `icu-number-params.test.ts` asserts on the Arabic NaN string to prove the plural
			// trap, so this is load-bearing rather than trivia.
			expect(num(Number.NaN, 'en')).toBe('NaN');
			// ⛔ THE REFERENCE CARRIES THE SAME PIN THE PRODUCT DOES. An UNPINNED
			// `Number.NaN.toLocaleString('ar')` was the first spelling here, and it passed on this
			// machine and failed on the runner: `expected 'ليس رقمًا' to be 'ليس رقم'`. Older CLDR
			// gives `ar` and `ar-u-nu-latn` DIFFERENT not-a-number symbols, so comparing a pinned
			// formatter against an unpinned reference measures the gap between two locales rather
			// than anything about `num()`.
			const arNaN = Number.NaN.toLocaleString('ar', { numberingSystem: 'latn' });
			expect(num(Number.NaN, 'ar')).toBe(arNaN);
			// ⚠️ The line above shares the product's options, so on its own it could not fail. These
			// two carry the actual claim — that `num` did NOT short-circuit to `String(n)` and put an
			// English "NaN" on an Arabic screen — and neither depends on the ICU build.
			expect(num(Number.NaN, 'ar')).not.toBe('NaN');
			expect(num(Number.NaN, 'ar')).toMatch(/\p{Script=Arabic}/u);
			expect(num(Number.POSITIVE_INFINITY, 'nl')).toBe('∞');
		});
	});
});

describe('exact — the reader’s punctuation on a figure that must NOT be rounded', () => {
	// ⛔ WHY THIS FORMATTER EXISTS, AND IT IS A DEFECT THAT SHIPPED INSIDE THE FIX FOR ANOTHER ONE.
	// /llm-settings printed its temperature with `String(temperature)` — the en-US decimal point in a
	// Dutch panel — and that was corrected to `num()`. `num()` is `toLocaleString`, whose default
	// `maximumFractionDigits` is 3, so the panel then rounded a value it exists to ECHO:
	//
	//     0.0001 → "0"       a set value reported as unset
	//     0.999999 → "1"     a saved value reported as a different one
	//
	// Both are accepted by `backend/src/routes/llm-settings.ts` (`z.number().min(0).max(2)`, no
	// decimal bound) and both were visible in the `<input>` beside the panel at the same moment.

	it('THE TWO MEASURED CASES: 0.0001 and 0.999999 survive, where num() destroys them', () => {
		// The inequality is the assertion. Writing only `expect(exact(...)).toBe('0,0001')` would pass
		// against a formatter that happened to agree with `num()` on some other value.
		expect(num(0.0001, 'nl')).toBe('0');
		expect(exact(0.0001, 'nl')).toBe('0,0001');
		expect(num(0.999999, 'nl')).toBe('1');
		expect(exact(0.999999, 'nl')).toBe('0,999999');
		expect(exact(0.0001, 'en')).toBe('0.0001');
		expect(exact(0.999999, 'en')).toBe('0.999999');
	});

	it('⛔ AND NOT `maximumFractionDigits: 20`, WHICH WAS THE OBVIOUS FIX — it still yields "0"', () => {
		// Measured, and the reason `exact()` counts SIGNIFICANT digits instead. 20 is the ceiling
		// `Intl` allows for fraction digits and a `real` column plus a `type="number"` input can both
		// carry a value below it. A formatter that answers "0" for a nonzero setting is the defect
		// this whole file is about, one magnitude further down.
		expect(new Intl.NumberFormat('nl', { maximumFractionDigits: 20 }).format(1e-40)).toBe('0');
		expect(exact(1e-40, 'nl')).not.toBe('0');
		expect(exact(1e-40, 'nl')).toContain('1');
	});

	it('⛔ THE OVER-CORRECTION GUARD: no trailing zeros are invented', () => {
		// The other half of the same requirement, and the reason `decimal1()` was rejected at the call
		// site: a status row answering "1,0" to a field reading "1" is the same defect wearing a nicer
		// sentence — the panel reporting something other than the setting it confirms.
		expect(exact(1, 'nl')).toBe('1');
		expect(exact(0, 'nl')).toBe('0');
		expect(exact(2, 'nl')).toBe('2');
		expect(exact(0.1, 'nl')).toBe('0,1');
		expect(exact(0.05, 'nl')).toBe('0,05');
	});

	it('is locale-aware in all eight, and not one string wearing eight names', () => {
		const table: Record<(typeof LOCALES)[number], string> = {
			en: '0.0001',
			nl: '0,0001',
			pl: '0,0001',
			fr: '0,0001',
			es: '0,0001',
			de: '0,0001',
			ar: '0.0001',
			he: '0.0001'
		};
		for (const l of LOCALES) expect(exact(0.0001, l), `locale ${l}`).toBe(table[l]);
		// Non-vacuity: a helper ignoring its argument could not produce two forms.
		expect(new Set(LOCALES.map((l) => exact(0.0001, l))).size).toBeGreaterThanOrEqual(2);
	});

	it('same guards as num(): a bad tag falls back, a bad VALUE returns the sentinel', () => {
		expect(() => exact(0.1, 'not a tag')).not.toThrow();
		expect(exact(0.1, 'not a tag')).toBeTruthy();
		expect(exact(undefined as unknown as number, 'nl')).toBe('—');
		expect(exact(null as unknown as number, 'nl')).toBe('—');
		// NaN/Infinity keep going through Intl, so they stay TRANSLATED — see num()'s block above.
		expect(exact(Number.NaN, 'ar')).not.toBe('NaN');
		expect(exact(Number.POSITIVE_INFINITY, 'nl')).toBe('∞');
	});
});

describe('ms — a latency, punctuated for the reader', () => {
	// ⛔ THE DEFECT, AND IT SHIPPED INSIDE THE FIX FOR ITS SIBLINGS. `ms()` was
	// `` `${(n / 1000).toFixed(2)}s` `` — the same hard-coded '.' decimal separator `decimal1` was
	// added to remove from `demoDuration`, in the same module, imported on the same line of
	// RunConsole.svelte that the ICU fix edited. Dutch therefore read, in ONE component:
	//     1.207 LLM-aanroepen · 1.234.567+98.765 tokens   ← grouped, Dutch
	//     uitvoering geslaagd · 3.46s                     ← this function, English
	// Before the fix that component was uniformly (wrongly) English-punctuated; after it, two
	// conventions sat in one sentence.
	it('THE STATED CASE: 3460 ms is "3,46s" in Dutch and "3.46s" in English', () => {
		expect(ms(3460, 'en')).toBe('3.46s');
		expect(ms(3460, 'nl')).toBe('3,46s');
		// The assertion that inverts on a revert to `.toFixed(2)`: that produces the en form always.
		expect(ms(3460, 'nl')).not.toBe('3.46s');
	});

	it('the P95 pair from ops_alert_high_latency_detail, in all eight locales', () => {
		// 2474 ms against a 2000 ms target — the real /it-dash figures. BOTH numbers in that sentence
		// carry a decimal, so a half-fix punctuates one and not the other.
		const table: Record<(typeof LOCALES)[number], [string, string]> = {
			en: ['2.47s', '2.00s'],
			nl: ['2,47s', '2,00s'],
			pl: ['2,47s', '2,00s'],
			fr: ['2,47s', '2,00s'],
			es: ['2,47s', '2,00s'],
			de: ['2,47s', '2,00s'],
			ar: ['2.47s', '2.00s'],
			he: ['2.47s', '2.00s']
		};
		for (const l of LOCALES) {
			expect(ms(2474, l), `locale ${l} p95`).toBe(table[l][0]);
			expect(ms(2000, l), `locale ${l} threshold`).toBe(table[l][1]);
		}
		// Non-vacuity: a hard-coded separator could not produce two forms.
		expect(new Set(LOCALES.map((l) => ms(2474, l))).size).toBe(2);
	});

	it('BOTH bounds are pinned, so a round figure keeps its trailing zeros', () => {
		// `num()` would print "2" here (its default maximumFractionDigits is 3, minimum 0), and a P95
		// that reads "2s" next to a "2.00s" target is a different claim about the measurement.
		expect(ms(2000, 'en')).toBe('2.00s');
		expect(ms(1000, 'nl')).toBe('1,00s');
	});

	it('under a second: whole milliseconds, and no separator is possible below 1000', () => {
		expect(ms(420, 'nl')).toBe('420ms');
		expect(ms(0, 'nl')).toBe('0ms');
		// Rounds, matching demoDuration's ms bucket — a fractional millisecond would re-introduce the
		// hard-coded '.' one order of magnitude down.
		expect(ms(123.4, 'nl')).toBe('123ms');
	});

	it('⛔ EACH BUCKET TESTS THE VALUE IT IS ABOUT TO PRINT — 999.6 is not "1.000ms"', () => {
		// `demoDuration`'s stated rule, which this function was breaking: it bucketed on the RAW value
		// and rounded afterwards, so 999.6 printed the SECONDS bucket's answer in the MILLISECONDS
		// bucket's unit. Grouping made it visibly worse — Dutch read "1.000ms", a thousands separator
		// inside the one bucket that is guaranteed to be under a thousand.
		expect(ms(999.6, 'nl')).toBe('1,00s');
		expect(ms(999.6, 'en')).toBe('1.00s');
		expect(ms(999.4, 'nl')).toBe('999ms');
		// The whole point: no figure in the ms bucket can ever carry a group separator.
		for (const l of LOCALES) expect(ms(999.4, l), `locale ${l}`).toBe('999ms');
	});

	it('null is the “no figure” sentinel, and a malformed tag does not throw', () => {
		expect(ms(null, 'nl')).toBe('—');
		expect(() => ms(2474, 'not a tag')).not.toThrow();
		expect(ms(2474, 'not a tag')).toBeTruthy();
	});
});

describe('dayMonth — a chart’s day label', () => {
	// Local noon on 2026-08-07, so no timezone can move it off the 7th.
	const local = new Date(2026, 7, 7, 12);

	it('names the month in the reader’s language, in the reader’s order', () => {
		const table: Record<(typeof LOCALES)[number], string> = {
			en: 'Aug 7',
			nl: '7 aug',
			pl: '7 sie',
			fr: '7 août',
			es: '7 ago',
			de: '7. Aug.',
			ar: '7 أغسطس',
			he: '7 באוג׳'
		};
		for (const l of LOCALES) expect(dayMonth(local, l), `locale ${l}`).toBe(table[l]);
	});

	it('THE DEFECT, as an assertion: en and nl put the day and the month on opposite sides', () => {
		// Not just different words — a different ORDER. "Aug 7" in a Dutch tooltip is wrong twice.
		expect(dayMonth(local, 'en')).toBe('Aug 7');
		expect(dayMonth(local, 'nl')).toBe('7 aug');
	});

	it('produces non-Latin labels for ar and he rather than quietly serving English', () => {
		// The fallback failure mode this guards: a helper that swallowed an unknown tag and returned
		// the runtime default would print "Aug 7" here and pass any test that only checked for
		// "something other than the input".
		for (const l of ['ar', 'he'] as const) {
			expect(dayMonth(local, l)).not.toMatch(/[A-Za-z]/);
		}
	});

	it('honours an explicit UTC timeZone — the /usage chart’s case', () => {
		// /usage buckets on `date_trunc('day', …)` in the DB's UTC session and ships
		// `…T00:00:00.000Z`. Formatted in local time from a negative offset that instant is the
		// PREVIOUS day, which is the bug the `timeZone: 'UTC'` argument already prevented before
		// this change — this asserts the locale fix did not drop it. Driven through a real offset
		// rather than argued about.
		const utcMidnight = '2026-08-07T00:00:00.000Z';
		// ⛔ RESTORE BY ASSIGNING A ZONE, NEVER BY `delete process.env.TZ` — MEASURED, AND THIS
		// EXACT LINE WAS A CI-ONLY RED. When `TZ` is unset in the environment (which it is on the
		// runner, and on any Mac that never exported it), the obvious `if (original === undefined)
		// delete process.env.TZ` is a NO-OP for the engine: bun/JSC re-reads the zone on a `set`
		// of `process.env.TZ` and NOT on a `delete`, so the override SURVIVES the test:
		//     bun, TZ unset: set Pacific/Midway → 01:30 · after "restore" → 01:30   ← still Midway
		//     bun, TZ=UTC:   set Pacific/Midway → 03:30 · after restore   → 14:30   ← fine
		// The leak then landed on `hourMinute` two describes below, whose 14:30 fixture is the one
		// value in this file a timezone CAN move: 14:30 UTC read at UTC-11 is 03:30, which is
		// precisely what CI reported ("expected '03:30' to be '14:30'") while this box — where the
		// suite happens to run under node, which honours the delete — stayed green.
		// Reading the RESOLVED zone and assigning it back is the spelling that works on both, and
		// it is also the only one that can be asserted afterwards.
		const originalTz = process.env.TZ;
		const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			process.env.TZ = 'Pacific/Midway'; // UTC-11
			expect(dayMonth(utcMidnight, 'en', 'UTC')).toBe('Aug 7');
			expect(dayMonth(utcMidnight, 'nl', 'UTC')).toBe('7 aug');
			// …and WITHOUT the argument it really does slip a day, so the assertion above is not
			// passing for some unrelated reason.
			expect(dayMonth(utcMidnight, 'en')).toBe('Aug 6');
		} finally {
			process.env.TZ = originalZone;
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		}
		// THE GUARD THAT WOULD HAVE CAUGHT IT. A test that drives a process-wide setting owes the
		// rest of the file proof that it gave it back; without this line the leak is invisible here
		// and surfaces as an unrelated failure in another describe.
		expect(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
			'the Pacific/Midway override leaked out of this test'
		).toBe(originalZone);
	});

	it('renders a bare YYYY-MM-DD as that calendar day — block-edit’s case', () => {
		// The usage-trend payload is a bare date string, which `new Date()` parses as LOCAL
		// midnight; that call site therefore must NOT pass 'UTC' or every label shifts for readers
		// east of Greenwich. Same helper, opposite argument, because the two payloads differ.
		expect(dayMonth('2026-08-07T00:00:00', 'nl')).toBe('7 aug');
	});
});

describe('hourMinute — the it-dash sparkline’s hour', () => {
	// ⛔ BUILT INSIDE EACH TEST, NOT ONCE IN THE DESCRIBE BODY. A describe body runs at COLLECTION
	// time; a test runs later. `new Date(y, m, d, h, min)` resolves against the timezone in force
	// when it is CONSTRUCTED and `hourMinute` formats against the one in force when it is CALLED,
	// so a `const` up here silently assumes those two are the same zone. They were not: the UTC
	// test in the `dayMonth` describe above leaked `Pacific/Midway` on the runner (see its comment)
	// and 14:30 came out '03:30'. The leak is fixed at its source; constructing here as well means
	// this fixture cannot be moved by ANY zone change, from this file or a future one.
	const local = () => new Date(2026, 7, 7, 14, 30);

	it('is 24-hour in the locales that use one, and AM/PM only in the ones that do', () => {
		expect(hourMinute(local(), 'nl')).toBe('14:30');
		expect(hourMinute(local(), 'de')).toBe('14:30');
		expect(hourMinute(local(), 'fr')).toBe('14:30');
		expect(hourMinute(local(), 'pl')).toBe('14:30');
		expect(hourMinute(local(), 'es')).toBe('14:30');
		expect(hourMinute(local(), 'he')).toBe('14:30');
		// ⚠️ THESE TWO ARE CORRECT, NOT LEFTOVER. English and Arabic use a 12-hour clock in CLDR.
		// The defect was showing AM/PM to EVERYONE because the runtime was asked; forcing
		// `hour12: false` on all eight would be the same mistake pointed the other way.
		expect(hourMinute(local(), 'en')).toBe('02:30 PM');
		expect(hourMinute(local(), 'ar')).toBe('02:30 م');
	});

	it('every locale renders a label, and they are not all the same one', () => {
		for (const l of LOCALES) expect(hourMinute(local(), l), `locale ${l}`).toBeTruthy();
		expect(new Set(LOCALES.map((l) => hourMinute(local(), l))).size).toBeGreaterThan(1);
	});
});

describe('fullDate — a dated fact in prose', () => {
	const local = new Date(2026, 7, 7, 12);

	it('renders the year in the reader’s language and order', () => {
		const table: Record<(typeof LOCALES)[number], string> = {
			en: 'Aug 7, 2026',
			nl: '7 aug 2026',
			pl: '7 sie 2026',
			fr: '7 août 2026',
			es: '7 ago 2026',
			de: '7. Aug. 2026',
			ar: '7 أغسطس 2026',
			he: '7 באוג׳ 2026'
		};
		for (const l of LOCALES) expect(fullDate(local, l), `locale ${l}`).toBe(table[l]);
	});

	it('answers “—” for an absent date, in every locale', () => {
		// block-edit's `fmtDate` used to own this branch (`if (!iso) return '—'`); it moved in here
		// with the rest of the helper and must not have been dropped on the way.
		for (const l of LOCALES) expect(fullDate(null, l), `locale ${l}`).toBe('—');
	});
});

describe('a value that is not a date does not take the screen down', () => {
	it('answers “—” instead of throwing — the behaviour change the Intl swap forced', () => {
		// ⛔ THIS IS NOT DEFENSIVE PADDING, IT IS A REAL SEMANTIC DIFFERENCE THAT HAD TO BE HANDLED.
		// `new Date('nope').toLocaleDateString()` — what these call sites used to run — returns the
		// harmless string "Invalid Date". `new Intl.DateTimeFormat('en').format(new Date('nope'))`
		// THROWS `RangeError: Invalid time value`. Swapping one for the other without the guard in
		// `dateParts` would have converted an ugly tooltip into an unmounted page.
		expect(() => dayMonth('nope', 'nl')).not.toThrow();
		expect(dayMonth('nope', 'nl')).toBe('—');
		expect(hourMinute('nope', 'nl')).toBe('—');
		expect(fullDate('nope', 'nl')).toBe('—');
		expect(fullDate('', 'nl')).toBe('—');
	});

	it('falls back instead of throwing on a malformed locale tag', () => {
		for (const bad of ['not a tag', '']) {
			expect(() => dayMonth(new Date(2026, 7, 7), bad)).not.toThrow();
			expect(dayMonth(new Date(2026, 7, 7), bad)).toBeTruthy();
		}
	});
});
