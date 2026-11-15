// src/host/period.ts — the competition PERIOD vocabulary: week, month, quarter or year. Generalises
// host/iso-week.ts (which stays, as the week-only primitive this file builds on).
//
// Every period has a KIND, a KEY and a START instant:
//
//   kind   key          start (UTC)
//   week   '2026-W41'   Monday 00:00 of that ISO week
//   month  '2026-10'    the 1st 00:00
//   quarter '2026-Q4'   the 1st of the quarter's first month (Jan/Apr/Jul/Oct) 00:00
//   year   '2026'       1 January 00:00
//
// The four key shapes are disjoint, so a key alone names its kind (`periodFromKey`). That is what
// lets the legacy `week` text columns carry the key for every kind during the one release they stay.
//
// ⛔ ORDER BY `start`, NEVER BY KEY. `'2026-W41' < '2026-10'` is true as text and meaningless as
// time; the moment the cadence changes, the stream mixes kinds and any `<` / `max()` / `desc()` on
// the key silently reorders history. Every comparison goes through `start` (and the `period_start`
// column that mirrors it).
//
// ⛔ UTC ONLY. Boundaries are built with Date.UTC + integer arithmetic. No local-time Date mutation,
// so a DST transition anywhere can never move a boundary by an hour.
//
// ⚠️ NOTHING HERE MAY GROW A DEPENDENCY (same rule as iso-week.ts): the vote hot path imports it.
import { DAY, weekStart, weekString } from './iso-week';

export type PeriodKind = 'week' | 'month' | 'quarter' | 'year';
/** The platform setting `cycle.cadence`. `off` = no periods, no ticks, no winners. */
export type Cadence = PeriodKind | 'off';

export const PERIOD_KINDS: readonly PeriodKind[] = ['week', 'month', 'quarter', 'year'] as const;
export const CADENCES: readonly Cadence[] = ['off', 'week', 'month', 'quarter', 'year'] as const;

export function isPeriodKind(v: unknown): v is PeriodKind {
  return v === 'week' || v === 'month' || v === 'quarter' || v === 'year';
}
export function isCadence(v: unknown): v is Cadence {
  return v === 'off' || isPeriodKind(v);
}

export interface Period {
  kind: PeriodKind;
  key: string;
  /** First instant of the period (inclusive). */
  start: Date;
  /** First instant of the NEXT period (exclusive end) — `nextPeriodStart(kind, start)`. */
  end: Date;
}

export interface PhaseBoundaries {
  voting_ends_at: Date;
  solution_ends_at: Date;
  closes_at: Date;
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The first instant of the period AFTER the one starting at `start`. Replaces every `+7*DAY`. */
export function nextPeriodStart(kind: PeriodKind, start: Date): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  switch (kind) {
    case 'week':
      return new Date(start.getTime() + 7 * DAY);
    case 'month':
      return new Date(Date.UTC(y, m + 1, 1)); // Date.UTC normalises month 12 → next January
    case 'quarter':
      return new Date(Date.UTC(y, m + 3, 1)); // Q4 (month 9) + 3 → month 12 → next 1 January
    case 'year':
      return new Date(Date.UTC(y + 1, 0, 1));
  }
}

/** The period of `kind` that contains instant `d`. */
export function periodFor(kind: PeriodKind, d: Date): Period {
  let key: string;
  let start: Date;
  switch (kind) {
    case 'week':
      key = weekString(d);
      start = weekStart(key);
      break;
    case 'month':
      key = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`;
      start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      break;
    case 'quarter': {
      const q = Math.floor(d.getUTCMonth() / 3) + 1;
      key = `${d.getUTCFullYear()}-Q${q}`;
      start = new Date(Date.UTC(d.getUTCFullYear(), 3 * (q - 1), 1));
      break;
    }
    case 'year':
      key = String(d.getUTCFullYear());
      start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      break;
  }
  return { kind, key, start, end: nextPeriodStart(kind, start) };
}

/** The kind a key names, or null for anything that is not a well-formed period key (incl. ''). */
export function kindOfKey(key: string | null | undefined): PeriodKind | null {
  if (!key) return null;
  if (/^\d{4}-W\d{2}$/.test(key)) return 'week';
  if (/^\d{4}-\d{2}$/.test(key)) return 'month';
  if (/^\d{4}-Q[1-4]$/.test(key)) return 'quarter';
  if (/^\d{4}$/.test(key)) return 'year';
  return null;
}

/** Parse a period key. Throws on a malformed key, an ISO week that does not exist, or month 13. */
export function periodFromKey(key: string): Period {
  const kind = kindOfKey(key);
  if (!kind) throw new Error(`invalid period key '${key}' (expected YYYY-Www, YYYY-MM, YYYY-Qn or YYYY)`);
  let start: Date;
  if (kind === 'week') {
    start = weekStart(key);
    // weekStart happily computes W54 / W00 as a date in another week; round-trip to reject them.
    if (weekString(start) !== key) throw new Error(`invalid period key '${key}' (no such ISO week)`);
  } else if (kind === 'month') {
    const [y, m] = key.split('-').map((s) => Number.parseInt(s, 10)) as [number, number];
    if (m < 1 || m > 12) throw new Error(`invalid period key '${key}' (month out of range)`);
    start = new Date(Date.UTC(y, m - 1, 1));
  } else if (kind === 'quarter') {
    const y = Number.parseInt(key.slice(0, 4), 10);
    const q = Number.parseInt(key.slice(6), 10);
    start = new Date(Date.UTC(y, 3 * (q - 1), 1));
  } else {
    start = new Date(Date.UTC(Number.parseInt(key, 10), 0, 1));
  }
  return { kind, key, start, end: nextPeriodStart(kind, start) };
}

/** The period immediately after `p`, of the same kind. */
export function nextPeriod(p: Pick<Period, 'kind' | 'start'>): Period {
  return periodFor(p.kind, nextPeriodStart(p.kind, p.start));
}

/** Voting length of a week period, in days. The rest of the week is the building phase. */
export const WEEK_VOTING_DAYS = 4;
/** Voting length of a month period, in days: the 1st–21st vote, the 22nd onward builds. */
export const MONTH_VOTING_DAYS = 21;
/** A quarter votes its first two months; the third builds. Months into the quarter the build starts. */
export const QUARTER_BUILD_MONTH_OFFSET = 2;
/** A year votes January–November; December builds. Month index (0-based) the build phase starts. */
export const YEAR_BUILD_MONTH = 11;

/**
 * Phase boundaries per kind (replaces the old `votingDays + solutionDays = 7` env pair):
 *
 *   week   voting 4 days        building 3 days           closes at next Monday
 *   month  voting days 1–21     building 22nd – month end closes at the next 1st
 *   quarter voting months 1–2    building month 3          closes at the next quarter's 1st
 *   year   voting Jan–Nov       building December         closes at next 1 January
 *
 * `closes_at` is ALWAYS `nextPeriodStart`, so a close and the next period's open land on one tick.
 */
export function phaseBoundaries(p: Pick<Period, 'kind' | 'start'>): PhaseBoundaries {
  const closes = nextPeriodStart(p.kind, p.start);
  let votingEnds: Date;
  switch (p.kind) {
    case 'week':
      votingEnds = new Date(p.start.getTime() + WEEK_VOTING_DAYS * DAY);
      break;
    case 'month':
      votingEnds = new Date(p.start.getTime() + MONTH_VOTING_DAYS * DAY);
      break;
    case 'quarter':
      votingEnds = new Date(Date.UTC(p.start.getUTCFullYear(), p.start.getUTCMonth() + QUARTER_BUILD_MONTH_OFFSET, 1));
      break;
    case 'year':
      votingEnds = new Date(Date.UTC(p.start.getUTCFullYear(), YEAR_BUILD_MONTH, 1));
      break;
  }
  return { voting_ends_at: votingEnds, solution_ends_at: closes, closes_at: closes };
}

/**
 * The later of two periods for STAMPING a solution: the current period, unless the challenge it
 * answers was rolled into a period that starts AT OR AFTER the current one ENDS (a solution never
 * competes before its own challenge). That is a later period of the same kind, or — across a
 * pending cadence switch — the first period of the NEW kind (week→month: a Friday challenge rolls
 * into the month that starts where the last week ends).
 *
 * A challenge period that overlaps or precedes the current one never wins, whatever its kind: a
 * period of another kind left over from before a cadence change is in the past, and the current
 * period is the only live race. (Before 0107's switch semantics this compared kinds instead; that
 * refused the legitimate "next period is of the new kind" case and stamped the solution into a week
 * that closes before its own challenge is even voted on.)
 */
export function laterPeriod(current: Period, other: Period | null | undefined): Period {
  if (!other) return current;
  if (other.kind === current.kind) return other.start.getTime() > current.start.getTime() ? other : current;
  return other.start.getTime() >= current.end.getTime() ? other : current;
}

/**
 * The first boundary of `kind` at or after instant `t` — i.e. `t` itself when `t` is a period start,
 * else the start of the next period. A cadence switch takes effect here (never mid-period).
 */
export function firstBoundaryAtOrAfter(kind: PeriodKind, t: Date): Date {
  const p = periodFor(kind, t);
  return p.start.getTime() === t.getTime() ? p.start : p.end;
}

/**
 * ⛔ THE STRETCH RULE for a cadence switch pending at `switchAt` (a boundary of the NEW kind).
 *
 * The OLD cadence keeps running until `switchAt`. A period of the old kind that ends before
 * `switchAt` while the NEXT old-kind period would CROSS it is STRETCHED to end exactly at
 * `switchAt` — never truncated, so there is no one-day week and week→year in December keeps weekly
 * periods until 1 January. The extra time goes to the BUILDING phase: `voting_ends_at` is the
 * period's own (unstretched) value, `solution_ends_at = closes_at = ` the stretched end. Chosen over
 * scaling both phases because it is one number to move, the voting window members were told about
 * does not shift under them, and a stretch is at most one old-kind period long.
 *
 * Returns the period's natural end when no switch is pending, when another full old-kind period
 * still fits before the switch, or when the period already ends at the switch. A period that
 * STARTS before `switchAt` and naturally ends after it (only possible if periods were never
 * aligned to the switch, e.g. a row opened by hand) is clamped to `switchAt`.
 */
export function stretchedEnd(p: Pick<Period, 'kind' | 'start' | 'end'>, switchAt: Date | null | undefined): Date {
  if (!switchAt) return p.end;
  const at = switchAt.getTime();
  if (p.start.getTime() >= at) return p.end; // not an old-kind period at all
  if (p.end.getTime() >= at) return switchAt;
  return nextPeriodStart(p.kind, p.end).getTime() > at ? switchAt : p.end;
}

/** Safe parse for a stored key: the period, or null for '' / malformed legacy values. */
export function tryPeriodFromKey(key: string | null | undefined): Period | null {
  if (!kindOfKey(key)) return null;
  try {
    return periodFromKey(key!);
  } catch {
    return null;
  }
}
