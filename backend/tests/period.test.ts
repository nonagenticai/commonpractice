// tests/period.test.ts — host/period.ts, the week/month/quarter/year period vocabulary. Pure; no DB.
import { describe, test, expect } from 'bun:test';
import {
  CADENCES,
  firstBoundaryAtOrAfter,
  isCadence,
  kindOfKey,
  laterPeriod,
  nextPeriod,
  nextPeriodStart,
  periodFor,
  periodFromKey,
  phaseBoundaries,
  stretchedEnd,
  tryPeriodFromKey,
  PERIOD_KINDS,
  type PeriodKind,
} from '../src/host/period';
import { weekString } from '../src/host/iso-week';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();

describe('periodFor', () => {
  test('week: key, Monday start, +7d end', () => {
    const p = periodFor('week', new Date('2026-10-14T12:00:00Z'));
    expect(p.key).toBe('2026-W42');
    expect(iso(p.start)).toBe('2026-10-12T00:00:00.000Z');
    expect(iso(p.end)).toBe('2026-10-19T00:00:00.000Z');
  });

  test('month: key, 1st start, next 1st end', () => {
    const p = periodFor('month', new Date('2026-10-14T12:00:00Z'));
    expect(p.key).toBe('2026-10');
    expect(iso(p.start)).toBe('2026-10-01T00:00:00.000Z');
    expect(iso(p.end)).toBe('2026-11-01T00:00:00.000Z');
  });

  test('year: key, Jan 1 start, next Jan 1 end', () => {
    const p = periodFor('year', new Date('2026-10-14T12:00:00Z'));
    expect(p.key).toBe('2026');
    expect(iso(p.start)).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(p.end)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('quarter: key YYYY-Qn, start the 1st of Jan/Apr/Jul/Oct, end +3 months', () => {
    const p = periodFor('quarter', new Date('2026-10-14T12:00:00Z'));
    expect(p.key).toBe('2026-Q4');
    expect(iso(p.start)).toBe('2026-10-01T00:00:00.000Z');
    expect(iso(p.end)).toBe('2027-01-01T00:00:00.000Z');
    const cases: [string, string, string, string][] = [
      ['2026-01-01T00:00:00Z', '2026-Q1', '2026-01-01', '2026-04-01'],
      ['2026-03-31T23:59:59.999Z', '2026-Q1', '2026-01-01', '2026-04-01'],
      ['2026-04-01T00:00:00Z', '2026-Q2', '2026-04-01', '2026-07-01'],
      ['2026-09-30T12:00:00Z', '2026-Q3', '2026-07-01', '2026-10-01'],
    ];
    for (const [at, key, start, end] of cases) {
      const q = periodFor('quarter', new Date(at));
      expect(q.key).toBe(key);
      expect(iso(q.start)).toBe(`${start}T00:00:00.000Z`);
      expect(iso(q.end)).toBe(`${end}T00:00:00.000Z`);
    }
  });

  test('December rolls the month end into next January', () => {
    const p = periodFor('month', new Date('2026-12-31T23:59:59.999Z'));
    expect(p.key).toBe('2026-12');
    expect(iso(p.end)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('February in a leap year and a common year', () => {
    expect(iso(periodFor('month', new Date('2028-02-10T00:00:00Z')).end)).toBe('2028-03-01T00:00:00.000Z');
    expect(iso(periodFor('month', new Date('2027-02-10T00:00:00Z')).end)).toBe('2027-03-01T00:00:00.000Z');
  });

  test('ISO week 53 exists in 2026 and belongs to ISO-year 2026 even on 2027-01-03', () => {
    const p = periodFor('week', new Date('2027-01-03T23:00:00Z'));
    expect(p.key).toBe('2026-W53');
    expect(iso(p.start)).toBe('2026-12-28T00:00:00.000Z');
    expect(iso(p.end)).toBe('2027-01-04T00:00:00.000Z');
    // …while the month/year of the same instant are 2027's.
    expect(periodFor('month', new Date('2027-01-03T23:00:00Z')).key).toBe('2027-01');
    expect(periodFor('year', new Date('2027-01-03T23:00:00Z')).key).toBe('2027');
  });

  test('ISO week 1 can start in the previous calendar year (2024-12-30 is 2025-W01)', () => {
    const p = periodFor('week', new Date('2024-12-31T12:00:00Z'));
    expect(p.key).toBe('2025-W01');
    expect(iso(p.start)).toBe('2024-12-30T00:00:00.000Z');
  });

  test('boundaries are half-open: the first instant of the next period is not in this one', () => {
    for (const kind of PERIOD_KINDS) {
      const p = periodFor(kind, new Date('2026-06-15T00:00:00Z'));
      expect(periodFor(kind, p.start).key).toBe(p.key);
      expect(periodFor(kind, new Date(p.end.getTime() - 1)).key).toBe(p.key);
      expect(periodFor(kind, p.end).key).not.toBe(p.key);
    }
  });

  test('DST transitions do not move any boundary (UTC arithmetic only)', () => {
    // EU DST 2026: 29 March and 25 October; US: 8 March and 1 November.
    for (const at of ['2026-03-29T01:30:00Z', '2026-10-25T01:30:00Z', '2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']) {
      for (const kind of PERIOD_KINDS) {
        const p = periodFor(kind, new Date(at));
        expect(p.start.getUTCHours()).toBe(0);
        expect(p.start.getUTCMinutes()).toBe(0);
        expect(p.end.getUTCHours()).toBe(0);
      }
      const w = periodFor('week', new Date(at));
      expect(w.end.getTime() - w.start.getTime()).toBe(7 * DAY);
    }
  });
});

describe('keys', () => {
  test('kindOfKey discriminates the three disjoint shapes and rejects the rest', () => {
    expect(kindOfKey('2026-W41')).toBe('week');
    expect(kindOfKey('2026-10')).toBe('month');
    expect(kindOfKey('2026')).toBe('year');
    expect(kindOfKey('2026-Q1')).toBe('quarter');
    expect(kindOfKey('2026-Q4')).toBe('quarter');
    for (const bad of ['', null, undefined, '2026-W4', '26-10', '2026-1', 'W41', '2026-W41x', '2026-Q0', '2026-Q5', '2026-q2', '2026-Q12', 'Q3']) {
      expect(kindOfKey(bad as string)).toBeNull();
    }
  });

  test('every kind is enumerated, quarter included', () => {
    expect([...PERIOD_KINDS]).toEqual(['week', 'month', 'quarter', 'year']);
  });

  test('periodFromKey round-trips periodFor for every kind across 15 years', () => {
    const from = Date.UTC(2020, 0, 1);
    const to = Date.UTC(2035, 0, 1);
    for (const kind of PERIOD_KINDS) {
      for (let t = from; t < to; t += 3 * DAY + 3_600_000) {
        const p = periodFor(kind, new Date(t));
        const q = periodFromKey(p.key);
        expect(q.kind).toBe(kind);
        expect(q.start.getTime()).toBe(p.start.getTime());
        expect(q.end.getTime()).toBe(p.end.getTime());
      }
    }
  });

  test('periodFromKey rejects weeks that do not exist and months out of range', () => {
    expect(() => periodFromKey('2027-W53')).toThrow(); // 2027 has 52 ISO weeks
    expect(() => periodFromKey('2026-W00')).toThrow();
    expect(() => periodFromKey('2026-13')).toThrow();
    expect(() => periodFromKey('2026-00')).toThrow();
    expect(() => periodFromKey('')).toThrow();
    expect(() => periodFromKey('2026-Q5')).toThrow();
    expect(periodFromKey('2026-Q3').start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(tryPeriodFromKey('2026-Q0')).toBeNull();
    expect(periodFromKey('2026-W53').start.toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(tryPeriodFromKey('')).toBeNull();
    expect(tryPeriodFromKey('2027-W53')).toBeNull();
    expect(tryPeriodFromKey('2026-W53')?.kind).toBe('week');
  });

  test('week keys agree with iso-week.ts weekString (no second ISO calendar)', () => {
    for (let t = Date.UTC(2020, 0, 1); t < Date.UTC(2031, 0, 1); t += 13 * 3_600_000) {
      expect(periodFor('week', new Date(t)).key).toBe(weekString(new Date(t)));
    }
  });
});

describe('nextPeriodStart / nextPeriod', () => {
  test('consecutive periods tile time with no gap and no overlap', () => {
    for (const kind of PERIOD_KINDS) {
      let p = periodFor(kind, new Date('2025-11-20T00:00:00Z'));
      for (let i = 0; i < 60; i++) {
        const n = nextPeriod(p);
        expect(n.start.getTime()).toBe(p.end.getTime());
        expect(nextPeriodStart(kind, p.start).getTime()).toBe(n.start.getTime());
        expect(n.key).not.toBe(p.key);
        p = n;
      }
    }
  });

  test('week 52 → week 53 → week 1 across the 2026/27 boundary', () => {
    const w52 = periodFromKey('2026-W52');
    const w53 = nextPeriod(w52);
    expect(w53.key).toBe('2026-W53');
    expect(nextPeriod(w53).key).toBe('2027-W01');
    // and 2027 has no week 53
    expect(nextPeriod(periodFromKey('2027-W52')).key).toBe('2028-W01');
  });

  test('quarter Q4 → next year Q1, and Q1 → Q2 → Q3 → Q4 in order', () => {
    const q4 = periodFromKey('2026-Q4');
    expect(iso(nextPeriodStart('quarter', q4.start))).toBe('2027-01-01T00:00:00.000Z');
    const n = nextPeriod(q4);
    expect(n.key).toBe('2027-Q1');
    expect(iso(n.end)).toBe('2027-04-01T00:00:00.000Z');
    expect([nextPeriod(n), nextPeriod(nextPeriod(n)), nextPeriod(nextPeriod(nextPeriod(n)))].map((p) => p.key)).toEqual([
      '2027-Q2',
      '2027-Q3',
      '2027-Q4',
    ]);
  });
});

describe('phaseBoundaries', () => {
  test('week = 4 days voting + 3 days building, close at next Monday', () => {
    const b = phaseBoundaries(periodFromKey('2026-W42'));
    expect(iso(b.voting_ends_at)).toBe('2026-10-16T00:00:00.000Z'); // Friday
    expect(iso(b.closes_at)).toBe('2026-10-19T00:00:00.000Z');
    expect(b.solution_ends_at.getTime()).toBe(b.closes_at.getTime());
  });

  test('month = days 1–21 voting, the 22nd onward building', () => {
    const b = phaseBoundaries(periodFromKey('2026-02'));
    expect(iso(b.voting_ends_at)).toBe('2026-02-22T00:00:00.000Z');
    expect(iso(b.closes_at)).toBe('2026-03-01T00:00:00.000Z');
    const dec = phaseBoundaries(periodFromKey('2026-12'));
    expect(iso(dec.voting_ends_at)).toBe('2026-12-22T00:00:00.000Z');
    expect(iso(dec.closes_at)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('year = January–November voting, December building', () => {
    const b = phaseBoundaries(periodFromKey('2026'));
    expect(iso(b.voting_ends_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(b.closes_at)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('quarter = its first two months voting, the third building', () => {
    const q1 = phaseBoundaries(periodFromKey('2026-Q1'));
    expect(iso(q1.voting_ends_at)).toBe('2026-03-01T00:00:00.000Z');
    expect(iso(q1.closes_at)).toBe('2026-04-01T00:00:00.000Z');
    const q4 = phaseBoundaries(periodFromKey('2026-Q4'));
    expect(iso(q4.voting_ends_at)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(q4.closes_at)).toBe('2027-01-01T00:00:00.000Z');
    expect(q4.solution_ends_at.getTime()).toBe(q4.closes_at.getTime());
  });

  test('every kind: start < voting end < close == next period start', () => {
    for (const kind of PERIOD_KINDS as PeriodKind[]) {
      for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2029, 0, 1); t += 11 * DAY) {
        const p = periodFor(kind, new Date(t));
        const b = phaseBoundaries(p);
        expect(b.voting_ends_at.getTime()).toBeGreaterThan(p.start.getTime());
        expect(b.closes_at.getTime()).toBeGreaterThan(b.voting_ends_at.getTime());
        expect(b.closes_at.getTime()).toBe(p.end.getTime());
      }
    }
  });
});

describe('laterPeriod / cadences', () => {
  test('a later period wins; another kind wins only when it starts after the current one ENDS', () => {
    const cur = periodFromKey('2026-W42');
    expect(laterPeriod(cur, periodFromKey('2026-W43')).key).toBe('2026-W43');
    expect(laterPeriod(cur, periodFromKey('2026-W41')).key).toBe('2026-W42');
    // '2026-W42' < '2026-10' as TEXT; by time the month started earlier and overlaps: current wins.
    expect(laterPeriod(cur, periodFromKey('2026-10')).key).toBe('2026-W42');
    // ⛔ Across a pending week→month switch the challenge's period is the coming MONTH: the solution
    // must follow it, not compete in a week that closes before its challenge is even voted on.
    expect(laterPeriod(cur, periodFromKey('2026-11')).key).toBe('2026-11');
    // A stretched current period (W42 running to Nov 1) still sees the month as later.
    expect(laterPeriod({ ...cur, end: new Date('2026-11-01T00:00:00Z') }, periodFromKey('2026-11')).key).toBe('2026-11');
    expect(laterPeriod(cur, null).key).toBe('2026-W42');
  });

  test('firstBoundaryAtOrAfter: a boundary is its own answer, anything else rolls to the next', () => {
    expect(firstBoundaryAtOrAfter('month', new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(firstBoundaryAtOrAfter('month', new Date('2026-10-19T00:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(firstBoundaryAtOrAfter('week', new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(firstBoundaryAtOrAfter('year', new Date('2026-12-28T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('stretchedEnd: the old period that the NEXT one would cross runs on to the switch; none is truncated', () => {
    const at = new Date('2026-11-01T00:00:00Z'); // week→month, Sunday the 1st
    const w = (k: string) => periodFromKey(k);
    expect(stretchedEnd(w('2026-W42'), at)).toEqual(w('2026-W42').end); // W43 still fits
    expect(stretchedEnd(w('2026-W43'), at)).toEqual(at); // W44 would cross → W43 runs Oct 19 → Nov 1
    expect(stretchedEnd(w('2026-W43'), null)).toEqual(w('2026-W43').end);
    // A period that already ends exactly at the switch is left alone.
    expect(stretchedEnd(w('2026-W44'), w('2026-W44').end)).toEqual(w('2026-W44').end);
  });

  test('stretch quarter→month: a quarter already ends on a month boundary, so nothing stretches', () => {
    const q = periodFromKey('2026-Q4');
    const at = firstBoundaryAtOrAfter('month', q.end);
    expect(iso(at)).toBe('2027-01-01T00:00:00.000Z');
    expect(stretchedEnd(q, at)).toEqual(q.end);
  });

  test('stretch week→quarter: the last week that fits runs on to the quarter start', () => {
    // A switch decided in W40 2026 (ends Mon Oct 5): the quarter boundary at or after that is 2027-01-01.
    const at = firstBoundaryAtOrAfter('quarter', periodFromKey('2026-W40').end);
    expect(iso(at)).toBe('2027-01-01T00:00:00.000Z');
    // W52 2026 = Dec 21 → 28; W53 = Dec 28 → Jan 4 would cross Jan 1, so W52 is stretched to Jan 1
    // (no 4-day W53). W51 still has a full W52 after it and is left alone.
    expect(stretchedEnd(periodFromKey('2026-W52'), at)).toEqual(at);
    expect(stretchedEnd(periodFromKey('2026-W51'), at)).toEqual(periodFromKey('2026-W51').end);
    // A week that ends before the switch while the NEXT week would cross is stretched to the switch:
    // switching to quarter at 2027-04-01 (Thursday) — W12 2027 ends Mon Mar 29, W13 would end Apr 5.
    const q2 = periodFromKey('2027-Q2').start;
    expect(stretchedEnd(periodFromKey('2027-W12'), q2)).toEqual(q2);
    expect(stretchedEnd(periodFromKey('2027-W11'), q2)).toEqual(periodFromKey('2027-W11').end);
  });

  test('stretch quarter→week and quarter→year, month→quarter', () => {
    // quarter→week: Q4 2026 ends Fri 2027-01-01; the first week boundary at or after is Mon Jan 4.
    const q = periodFromKey('2026-Q4');
    const wk = firstBoundaryAtOrAfter('week', q.end);
    expect(iso(wk)).toBe('2027-01-04T00:00:00.000Z');
    expect(stretchedEnd(q, wk)).toEqual(wk); // Q4 stretched by three days of building
    // quarter→year from Q2: Q3 still fits before Jan 1, Q4 ends exactly at it.
    const yr = firstBoundaryAtOrAfter('year', periodFromKey('2026-Q2').end);
    expect(iso(yr)).toBe('2027-01-01T00:00:00.000Z');
    expect(stretchedEnd(periodFromKey('2026-Q3'), yr)).toEqual(periodFromKey('2026-Q3').end);
    expect(stretchedEnd(periodFromKey('2026-Q4'), yr)).toEqual(yr);
    // month→quarter from November: the switch lands on Jan 1 and December ends exactly there.
    const qb = firstBoundaryAtOrAfter('quarter', periodFromKey('2026-11').end);
    expect(iso(qb)).toBe('2027-01-01T00:00:00.000Z');
    expect(stretchedEnd(periodFromKey('2026-11'), qb)).toEqual(periodFromKey('2026-11').end);
  });

  test('cadence vocabulary', () => {
    expect([...CADENCES]).toEqual(['off', 'week', 'month', 'quarter', 'year']);
    expect(isCadence('quarter')).toBe(true);
    expect(isCadence('off')).toBe(true);
    expect(isCadence('day')).toBe(false);
  });
});
