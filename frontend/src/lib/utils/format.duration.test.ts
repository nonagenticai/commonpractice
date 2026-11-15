// src/lib/utils/format.duration.test.ts — the unit `duration()` picks, asserted as WHICH CATALOG
// KEY WITH WHICH PARAMS, never as English text.
//
// The defect this pins: /pipeline rendered "AVG TIME TO LIVE — / none live yet" next to "IN
// PRODUCTION 1 / live now". The one card that shipped did so in 41 minutes; the server rounded the
// interval to whole days (→ 0) and the page then treated that magnitude as "no data exists". The
// duration now arrives in milliseconds and this function chooses the unit.
//
// ⛔ THE ASSERTIONS ARE ON KEY IDENTITY, NOT ON RENDERED STRINGS. The messages module is mocked so
// each key returns its own name plus the params it was handed (the shape used by
// components/ops/kanban-card.review-control.render.test.ts). Asserting on "41m" would pass just as
// happily if the code concatenated a Latin "m" in the template — which is precisely the
// untranslatable, bidi-ambiguous construction being removed here.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	pipeline_dur_min: ({ count }: { count: number }) => `DUR_MIN:${count}`,
	pipeline_dur_hour: ({ count }: { count: number }) => `DUR_HOUR:${count}`,
	pipeline_dur_day: ({ count }: { count: number }) => `DUR_DAY:${count}`,
	// `timeAgo` lives in the same module and is compiled alongside; unused here.
	timeago_sec: () => 'sec',
	timeago_min: () => 'min',
	timeago_hour: () => 'hour',
	timeago_hour_min: () => 'hourmin',
	timeago_day: () => 'day',
	timeago_day_hour: () => 'dayhour'
}));

const { duration } = await import('./format');

describe('duration() — the unit is chosen in the browser and named by the catalog', () => {
	// T4. 2_460_000 ms = 41 minutes: the REAL production interval whose card rendered as "—".
	it('renders a 41-minute average through the MINUTES key with count 41', () => {
		const out = duration(2_460_000);
		expect(out).toBe('DUR_MIN:41');
		// The two things the old code produced for this exact input, named so a regression is
		// unmistakable rather than just "some other string".
		expect(out).not.toBe('—');
		expect(out).not.toBe('0d');
		expect(out).not.toContain('DUR_DAY');
	});

	it('keeps sub-hour intervals in minutes', () => {
		expect(duration(60_000)).toBe('DUR_MIN:1');
		expect(duration(59 * 60_000)).toBe('DUR_MIN:59');
	});

	it('switches to hours at an hour, and stays there up to 48 h', () => {
		expect(duration(60 * 60_000)).toBe('DUR_HOUR:1');
		// 30 hours must NOT collapse to "1d" — that is the same rounding lie in smaller print.
		expect(duration(30 * 3_600_000)).toBe('DUR_HOUR:30');
		expect(duration(47 * 3_600_000)).toBe('DUR_HOUR:47');
	});

	it('switches to days from 48 h', () => {
		expect(duration(48 * 3_600_000)).toBe('DUR_DAY:2');
		expect(duration(9 * 24 * 3_600_000)).toBe('DUR_DAY:9');
	});

	it('never renders "60m" — 59.7 minutes rounds up into the hour bucket', () => {
		expect(duration(59.7 * 60_000)).toBe('DUR_HOUR:1');
	});

	it('clamps corrupt input instead of printing a negative duration', () => {
		expect(duration(0)).toBe('DUR_MIN:0');
		expect(duration(-5000)).toBe('DUR_MIN:0');
		expect(duration(Number.NaN)).toBe('DUR_MIN:0');
	});

	it('passes the raw integer to the message, not a pre-formatted string', () => {
		// The count reaches the catalog as a NUMBER, so the translator can place it (and, in ar/he,
		// order it against the unit). A pre-formatted string here would also mix number conventions
		// with `num()` inside one stats row.
		expect(duration(2_460_000)).toBe(`DUR_MIN:${41}`);
	});
});
