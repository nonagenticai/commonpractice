// src/host/iso-week.ts — the ISO-8601 week vocabulary the marketplace is built on, and NOTHING
// else. Pure, dependency-free, deterministic: no db, no config, no audit, no pipeline.
//
// ⛔ WHY THIS IS ITS OWN FILE. These three functions lived in `host/cycle-service.ts` — the weekly
// ENGINE, which imports `config`, `recordAudit`, `enqueueWinner` and the whole `db/client` surface.
// That was fine while only the engine and its routes needed to name a week. It stopped being fine
// when `host/vote-service.ts` — the hot path behind every single upvote click — needed
// `weekString(now)` to ask "has this solution's own cycle closed?". Importing it from cycle-service
// would have dragged the closer's entire module graph onto the vote path to answer a question that
// is three lines of date arithmetic.
//
// This is the same discipline `host/cycle-eligibility.ts` already enforces on the read path (see
// its IMPORT DISCIPLINE header): a *reader* must not have to pull the *closer* in behind it. The
// engine re-exports all three from `cycle-service.ts`, so every existing importer is untouched and
// there is exactly one implementation.
//
// ⚠️ NOTHING HERE MAY GROW A DEPENDENCY. The moment this file imports `../db/client` or `../config`
// it stops being liftable and the vote path is back where it started.

/** One day in ms. The whole ISO week calendar is built from this and integer arithmetic — never
 *  from local-time Date mutation, which would shift by an hour twice a year. */
export const DAY = 24 * 60 * 60 * 1000;

/** Pad a number to 2 digits. */
function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The ISO-8601 week label for a date, 'YYYY-Www' (e.g. '2026-W24'). The year is the
 * ISO week-year (the year of that week's Thursday), so the boundary days of a year are
 * labelled correctly. Pure + deterministic — unit-tested.
 */
export function weekString(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift to the Thursday of this week — its year decides the ISO week-year.
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // Week 1 is the week containing Jan 4th; find its Thursday.
  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  const w1DayNum = (week1Thursday.getUTCDay() + 6) % 7;
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() - w1DayNum + 3);
  const week = 1 + Math.round((date.getTime() - week1Thursday.getTime()) / (7 * DAY));
  return `${isoYear}-W${p2(week)}`;
}

/** The later of two ISO week strings. `YYYY-Www` is fixed-width and zero-padded, so lexicographic
 *  order IS chronological order and a plain `>` is the whole comparison — no parsing needed. An
 *  empty/absent week (the pre-0047 default, and what a legacy row still carries) loses to any real
 *  one rather than winning by accident. */
export function laterWeek(a: string, b: string | null | undefined): string {
  return b && b > a ? b : a;
}

/** The Monday 00:00:00 UTC that starts a 'YYYY-Www' ISO week. Throws on a bad label. */
export function weekStart(week: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`invalid week label '${week}' (expected YYYY-Www)`);
  const year = Number.parseInt(m[1]!, 10);
  const wk = Number.parseInt(m[2]!, 10);
  // Monday of ISO week 1 = Jan 4th shifted back to its Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // Mon=0
  const week1Monday = new Date(jan4.getTime() - jan4Day * DAY);
  return new Date(week1Monday.getTime() + (wk - 1) * 7 * DAY);
}
