// src/lib/components/marketplace/cadence-day.test.ts — the home screen's "today" is the
// READER'S weekday, not the string 'WED' that used to be baked into the component's prop default.
//
// Dates are constructed with the local-time `new Date(y, m, d, h)` constructor on purpose:
// `cadenceDayKey` reads `getDay()`, which is local, and an ISO string ('2026-08-10T00:00:00Z')
// would be parsed as UTC and could land on the previous day for a reader west of Greenwich —
// making this suite pass or fail by the machine it runs on.
import { describe, it, expect } from 'vitest';
import { cadenceDayKey, cadenceDayLabel, CADENCE_DAYS } from './cadence-day';

// August 2026: the 10th is a Monday, so the 10th…16th walks Mon→Sun.
const AUG = 7; // month index (0-based)
const day = (dom: number, hour = 12) => new Date(2026, AUG, dom, hour);

describe('cadenceDayKey', () => {
	it('resolves every weekday to its own card', () => {
		expect(cadenceDayKey(day(10))).toBe('MON');
		expect(cadenceDayKey(day(11))).toBe('TUE');
		expect(cadenceDayKey(day(12))).toBe('WED');
		expect(cadenceDayKey(day(13))).toBe('THU');
		expect(cadenceDayKey(day(14))).toBe('FRI');
	});

	it('returns null on both weekend days — never a clamped Friday or Monday', () => {
		// The bug this guards is the "nearest weekday" reflex: highlighting FRI on a Saturday
		// tells the reader the guest talk is today. It is not.
		expect(cadenceDayKey(day(15))).toBeNull(); // Saturday
		expect(cadenceDayKey(day(16))).toBeNull(); // Sunday
	});

	it('never returns undefined — the out-of-bounds index is handled, not indexed', () => {
		// Sunday would be CADENCE_DAYS[-1] and Saturday CADENCE_DAYS[5] under a naive
		// `getDay() - 1` lookup; both are `undefined`, which is NOT the same value as `null`
		// and would have flowed into `[today]` as a phantom highlight key.
		for (let dom = 10; dom <= 16; dom++) {
			const key = cadenceDayKey(day(dom));
			expect(key === null || CADENCE_DAYS.includes(key)).toBe(true);
			expect(key).not.toBeUndefined();
		}
	});

	it('covers the full week with exactly the five strip cards', () => {
		const week = [10, 11, 12, 13, 14, 15, 16].map((d) => cadenceDayKey(day(d)));
		expect(week.filter((k) => k !== null)).toEqual([...CADENCE_DAYS]);
	});

	it('is time-of-day independent within a day', () => {
		expect(cadenceDayKey(day(12, 0))).toBe('WED');
		expect(cadenceDayKey(day(12, 23))).toBe('WED');
	});

	it('defaults to the current date when called with no argument', () => {
		// Not asserting WHICH day — that would be a clock-dependent test. Asserting only that the
		// no-arg call goes through the same total mapping and can never produce 'WED' by default.
		const key = cadenceDayKey();
		expect(key === null || CADENCE_DAYS.includes(key)).toBe(true);
		expect(key).toBe(cadenceDayKey(new Date()));
	});
});

// The eight SPEC §5B locales. Assertions below name the EXPECTED WORDS, not just "something
// non-English": a fallback that quietly served English in all eight — the exact bug being fixed —
// would otherwise pass a test that only checked the strings differ from the key.
describe('cadenceDayLabel', () => {
	it('labels every key in the reader’s language', () => {
		expect(CADENCE_DAYS.map((k) => cadenceDayLabel(k, 'en'))).toEqual([
			'Mon',
			'Tue',
			'Wed',
			'Thu',
			'Fri'
		]);
		expect(CADENCE_DAYS.map((k) => cadenceDayLabel(k, 'nl'))).toEqual([
			'ma',
			'di',
			'wo',
			'do',
			'vr'
		]);
		expect(CADENCE_DAYS.map((k) => cadenceDayLabel(k, 'de'))).toEqual([
			'Mo',
			'Di',
			'Mi',
			'Do',
			'Fr'
		]);
	});

	it('never leaks the raw ASCII key into a non-English locale', () => {
		// THE DEFECT, stated as an assertion: `.dk` used to render 'MON'…'FRI' verbatim in all
		// eight catalogs. `text-transform: uppercase` means the comparison has to be
		// case-insensitive to be meaningful.
		for (const loc of ['nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			for (const k of CADENCE_DAYS) {
				expect(cadenceDayLabel(k, loc).toUpperCase()).not.toBe(k);
			}
		}
	});

	it('produces RTL-script labels for ar and he, not Latin ones', () => {
		// The card head sits in an RTL line whose only other content ("· اليوم") was already
		// localized, so a Latin token there was a bidi reorder as well as an untranslated string.
		for (const loc of ['ar', 'he']) {
			for (const k of CADENCE_DAYS) {
				expect(cadenceDayLabel(k, loc)).not.toMatch(/[A-Za-z]/);
			}
		}
	});

	it('keeps the five labels distinct within every locale', () => {
		// Two cards captioned alike would make the highlight unreadable. `narrow` weekday names
		// collide in several of these languages (de M/D/M/D/F) — this is why the function asks
		// Intl for `short`.
		for (const loc of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			const labels = CADENCE_DAYS.map((k) => cadenceDayLabel(k, loc));
			expect(new Set(labels).size).toBe(5);
		}
	});

	it('is independent of the reader’s timezone', () => {
		// Both halves are pinned to UTC — the reference date is built with `Date.UTC` and the
		// formatter is given `timeZone: 'UTC'`. Drop EITHER half and a reader at UTC+14 or UTC-11
		// gets the neighbouring day: the WED card captioned "Thu". Driven through the two most
		// extreme offsets that exist rather than argued about.
		// ⛔ RESTORE BY ASSIGNING A ZONE, NEVER BY `delete process.env.TZ` ALONE — the identical
		// block in `utils/format.locale.test.ts` was a CI-only red for exactly this reason: when
		// `TZ` is unset in the environment, bun/JSC re-reads the zone on a `set` and NOT on a
		// `delete`, so the override survives the test and lands on a later one. Measured. This file
		// has been lucky (nothing after it here reads local time) — that is not a property to rely
		// on, and the guard after the finally makes the leak fail HERE if it ever returns.
		const originalTz = process.env.TZ;
		const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			for (const tz of ['Pacific/Kiritimati' /* UTC+14 */, 'Pacific/Midway' /* UTC-11 */]) {
				process.env.TZ = tz;
				expect(CADENCE_DAYS.map((k) => cadenceDayLabel(k, 'en'))).toEqual([
					'Mon',
					'Tue',
					'Wed',
					'Thu',
					'Fri'
				]);
			}
		} finally {
			process.env.TZ = originalZone;
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		}
		expect(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
			'the TZ override leaked out of this test'
		).toBe(originalZone);
	});

	it('falls back instead of throwing on a malformed locale tag', () => {
		// `new Intl.DateTimeFormat('not a tag')` throws a RangeError. On the home screen that would
		// take out the whole strip; a wrong-language weekday is the lesser failure.
		expect(() => cadenceDayLabel('MON', 'not a tag')).not.toThrow();
		expect(cadenceDayLabel('MON', 'not a tag')).toBeTruthy();
		// A regional variant of a supported language must still resolve to that language.
		expect(cadenceDayLabel('WED', 'nl-BE')).toBe('wo');
	});
});
