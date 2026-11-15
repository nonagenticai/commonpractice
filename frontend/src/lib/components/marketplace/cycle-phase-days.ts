// src/lib/components/marketplace/cycle-phase-days.ts — which cadence cards a LIVE cycle's phase
// covers, derived from that cycle's own boundary instants.
//
// ⛔ THE DEFECT THIS REPLACES. `CadenceStrip.svelte` carried a hand-written table:
//
//     const PHASE_DAYS = { voting: ['MON'], solution_phase: ['TUE','WED','THU'], closed: ['FRI'] }
//
// i.e. a 1-day-voting / 3-day-solution week. The engine ships 4+3 (`config.cycle.votingDays` 4 /
// `solutionDays` 3, applied by `boundariesFor()` in backend/src/host/cycle-service.ts on top of
// `weekStart` = Monday 00:00 UTC):
//
//     voting_ends_at = Mon+4d = Fri 00:00 UTC   ->  `voting`         spans MON TUE WED THU
//     closes_at      = Fri+3d = Mon 00:00 UTC   ->  `solution_phase` spans FRI SAT SUN
//
// So during `voting` three of its four days were grey; during `solution_phase` three days that had
// ALREADY ENDED lit up while FRI — the phase's own and only weekday — was never highlighted at all.
// Commit #229 fixed the `cycle === null` fallback and left this branch alone, and this is the branch
// prod renders: gitops sets `CYCLE_ENABLED=true`, and `startCycleScheduler`'s boot catch-up calls
// `openCycle(currentWeek)`, so a cycle row exists seconds after any pod boot and `data.cycle` is
// non-null on every home load. Locally it is null, which is why the table looked fine.
//
// ⛔ WHY THIS IS DERIVED AND NOT A SECOND, CORRECTED TABLE. The cadence is CONFIGURATION
// (`CYCLE_VOTING_DAYS` / `CYCLE_SOLUTION_DAYS`), not a constant. Any table written here — however
// right today — is a copy of a value that lives in another process's environment, so it is wrong the
// first time an operator changes it and nothing in this repo can tell. The frontend cannot import
// `backend/src/config.ts`, but it does not need to: the cadence is already ON THE WIRE, because the
// cycle row stores the boundaries `boundariesFor()` computed FROM that config.
// `votingEndsAt`/`closesAt` are shipped by both surfaces that feed this strip — `cycleDto()` in
// backend/src/routes/cycle.ts and the `cycle` fold in backend/src/routes/marketplace-summary.ts
// (:304-310) — alongside `week`. Reading them is reading the engine's own arithmetic.
//
// ⚠️ THE ONE THING HARDCODED HERE IS ISO-8601 ITSELF, AND THAT IS THE POINT. `weekStartUtc` mirrors
// `weekStart` in backend/src/host/iso-week.ts. That mirror is safe precisely because it encodes a
// FROZEN INTERNATIONAL STANDARD — "the Monday of the week containing Jan 4" has no environment
// variable and cannot be reconfigured — whereas the old table encoded a tunable. Everything that can
// actually change (how many days voting runs, how many the solution phase runs, therefore which
// cards light up) is read from the payload and nothing about it is restated here.
//
// Paraglide-free and dependency-free on purpose, exactly like `cadence-day.ts` beside it and
// `host/iso-week.ts` on the server: the strip's day arithmetic must be assertable without mounting
// a component, and `parseIsoWeek` — the one existing frontend parse of this token — lives in
// `$lib/challenges/challenge-state.ts`, which imports `$lib/paraglide/messages`. Importing it would
// drag the message runtime into a pure date calculation to reuse one regex; the server drew this
// same line when it lifted `iso-week.ts` out of `cycle-service.ts` rather than let the vote path
// pull the closer in behind it.
import type { CycleState } from '$lib/types/cycle';
import { CADENCE_DAYS, type CadenceDayKey } from './cadence-day';

/** One day in ms. All arithmetic here is integer UTC — never local-time `Date` mutation, which
 *  shifts by an hour twice a year. Same constant, same reason, as `DAY` in host/iso-week.ts. */
const DAY = 24 * 60 * 60 * 1000;

/** `2026-W23` — the shape `weekString()` writes and `POST /api/cycle/advance` validates. */
const ISO_WEEK = /^(\d{4})-W(\d{2})$/;

/**
 * The Monday 00:00:00 UTC that starts a `YYYY-Www` ISO week, or `null` on a label this cannot use.
 *
 * ⚠️ NULL WHERE THE SERVER THROWS — DEFENSIVE DESIGN, NOT A FIX FOR A LIVE DEFECT. An earlier
 * version of this comment claimed the server's throwing `weekStart` would blank the home page. IT
 * WOULD NOT, and the claim is retracted here rather than quietly deleted, because an invented
 * failure mode is the same defect class as an invented deadline. `GET /api/home/summary` — the only
 * route that feeds this component — never calls `weekStart` at all: it calls `readCurrentCycle(new
 * Date())` (backend/src/routes/marketplace-summary.ts:299), which looks a row up by
 * `weekString(now)` and returns it or null. All three `weekStart` call sites live in
 * backend/src/host/cycle-service.ts (:48 `boundariesFor`, :84 `challengeWeekFor`, :399 `nextWeek`)
 * and every one of them receives either a label `weekString()` just produced or the `week` field of
 * `POST /api/cycle/advance`, whose zod guard `/^\d{4}-W\d{2}$/` is character-for-character
 * `weekStart`'s own check. There is no path on which a malformed label reaches it.
 *
 * The null is still the right answer HERE, for the reason that does hold: this runs on screen #1
 * inside a `$derived`, where an exception is a blank page rather than a failed job, and the frontend
 * does not get to assume the shape of JSON it did not write. A week label we cannot parse means we
 * do not know which cards the phase covers, and the honest rendering of "we don't know" is the five
 * neutral cards with nothing highlighted, which is what `phaseDays` returns from a null. Same
 * judgement `parseIsoWeek` in $lib/challenges/challenge-state.ts already made for the week badge.
 */
export function weekStartUtc(week: string | null | undefined): number | null {
	const match = ISO_WEEK.exec(week ?? '');
	if (!match) return null;
	const year = Number(match[1]);
	const wk = Number(match[2]);
	// ISO week-years run to 52 or 53 weeks; `W00` and `W54` parse as digits but name no week.
	if (wk < 1 || wk > 53) return null;
	// Week 1 is the week containing Jan 4th — shift Jan 4 back to its own Monday, then step weeks.
	const jan4 = Date.UTC(year, 0, 4);
	const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
	return jan4 - jan4Dow * DAY + (wk - 1) * 7 * DAY;
}

/**
 * The cadence card a UTC instant falls on, or `null` for a weekend.
 *
 * Exported because the COPY rule needs the same answer the mapping does: a card may name a phase
 * BOUNDARY ("voting closes") only if it is the card that boundary instant actually lands on, and
 * cadence-strip.phase-days.render.test.ts asks that question of the engine's own numbers rather
 * than typing a day name into a test.
 *
 * ⚠️ THE UTC/LOCAL SPLIT IS DELIBERATE AND THIS IS THE SEAM. `cadenceDayKey()` in `cadence-day.ts`
 * asks the same question with `getDay()` — the READER's timezone — because "is it my Saturday" is a
 * question about the reader. Everything in this file is `getUTCDay()`, because every boundary the
 * engine writes is UTC (`weekStart` is Monday 00:00 UTC and `boundariesFor` adds whole UTC days to
 * it). Mixing them would put a reader in UTC+13 one card off the phase they are actually in. The two
 * never meet: `phaseDays` is used only when a cycle exists, `cadenceDayKey` only when one does not.
 *
 * The weekend answer is `null`, never a clamp to FRI or MON — the same rule, and the same reason, as
 * `cadenceDayKey`: the Mon–Fri strip has no card for a Saturday, and picking the nearest one would
 * assert an activity happens on a day it does not.
 */
export function cardForUtcInstant(ms: number): CadenceDayKey | null {
	const dow = new Date(ms).getUTCDay(); // 0 = Sunday … 6 = Saturday
	return dow >= 1 && dow <= 5 ? CADENCE_DAYS[dow - 1]! : null;
}

/** How many UTC days one window may be walked. Two full weeks covers every card twice over, so this
 *  bounds a misconfigured cadence (or a corrupt boundary) without narrowing any real one. */
const MAX_WINDOW_DAYS = 14;

/**
 * Every cadence card touched by the half-open UTC window `[start, end)`, in chronological order.
 *
 * The walk starts at the UTC midnight of `start`'s day and stops at the first midnight `>= end`, so
 * a window that ends exactly ON a midnight does NOT claim that day — which is the whole difference
 * between the right answer and an off-by-one here. `voting_ends_at` is Fri 00:00 UTC: Friday is the
 * first instant OUTSIDE voting, not its last day. Days with no card (Sat/Sun) drop out; duplicates
 * cannot repeat a card if a cadence ever runs past seven days.
 */
function cardsInWindow(start: number, end: number): CadenceDayKey[] {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
	const out: CadenceDayKey[] = [];
	// `Math.floor` (not a truncating `|0`) so pre-1970 instants still land on the day they belong to.
	const firstMidnight = Math.floor(start / DAY) * DAY;
	for (let i = 0, t = firstMidnight; t < end && i < MAX_WINDOW_DAYS; i++, t += DAY) {
		const card = cardForUtcInstant(t);
		if (card && !out.includes(card)) out.push(card);
	}
	return out;
}

/**
 * The cadence cards a live cycle's CURRENT phase covers.
 *
 * The two windows, each stated as the engine states it, plus the phase that has none:
 *
 *   voting          [weekStart,     votingEndsAt)   challenge voting is open
 *   solution_phase  [votingEndsAt,  closesAt)       solutions are submitted + voted
 *   closed          —                               the week is over; nothing is running
 *
 * ⛔ `closed` HIGHLIGHTS NOTHING, AND THAT IS A DECISION, NOT A GAP. It is not dead code either:
 * `POST /api/cycle/advance {to:'closed'}` (backend/src/routes/cycle.ts:70,76-78) defaults `week` to
 * the CURRENT one — the manual/demo path — and afterwards `readCurrentCycle` reports `closed` for
 * the rest of that week, so a reader really does sit on this branch.
 *
 * This branch used to return the card `closes_at` lands on, which with the 4+3 cadence is MON. That
 * is arithmetically defensible and WRONG ON SCREEN, twice over:
 *
 *   1. `closes_at` is the instant the week ENDS. With 4+3 it is the NEXT week's Monday 00:00 UTC,
 *      so the lit card was not a day of the cycle being described at all — the strip claimed a day
 *      belonging to a week that has not opened.
 *   2. The cards carry COPY, and this commit's own rule is that a title is an engine claim that must
 *      move with the mapping. MON reads "Vote on challenges". Lighting it under the
 *      `cycle_phase_closed` header — "Week closed · winner announced" — puts two contradictory
 *      statements on one strip, which is the exact defect class the derivation was written to end.
 *
 * `[closes − 1d, closes)` — "the day the week ran out on" — was the other candidate. It is a real
 * day of the cycle, but it does not fix (2): at 4+3 it is a Sunday and yields `[]` anyway, while at
 * e.g. 3+1 it is Friday and would light "Guest talk + solutions open" under "Week closed". A window
 * that is only non-contradictory because it usually lands on a weekend is not a rule.
 *
 * So: no window. The `closed` state is fully on screen already — `cycle_phase_closed` and
 * `.cp-dot.closed` in the `.cycle-phase` header render exactly when the engine says the week is
 * closed, and they say the one true thing there is to say. Five neutral cards under that header is
 * the honest picture: none of the week's five activities is running, because the week is over. This
 * holds for every cadence, which is more than any window here could promise.
 *
 * Returns `[]` — highlight nothing — for any payload it cannot reason about too (unparseable week
 * label, unparseable boundary, a phase outside the three). Never a partial or guessed answer: this
 * is the home screen, and one grey strip is recoverable where a confidently wrong one is not.
 */
export function phaseDays(cycle: CycleState): CadenceDayKey[] {
	const weekStart = weekStartUtc(cycle.week);
	if (weekStart === null) return [];
	const votingEnds = Date.parse(cycle.votingEndsAt);
	const closes = Date.parse(cycle.closesAt);

	switch (cycle.phase) {
		case 'voting':
			return cardsInWindow(weekStart, votingEnds);
		case 'solution_phase':
			return cardsInWindow(votingEnds, closes);
		case 'closed':
			// No window — see the header above. The week is over; the `.cycle-phase` header carries it.
			return [];
		default:
			// A phase the DTO grew that this build has never heard of. Unreachable through the typed
			// path; reachable through JSON, which is where `cycle` actually comes from.
			return [];
	}
}

/**
 * The card that carries the "closes {time}" subtitle: the LAST card inside the voting window
 * `[weekStart, votingEndsAt)` — THU for the 4+3 week. The time itself is the engine's
 * `votingEndsAt`, rendered in the reader's own timezone with its weekday (`weekdayTime`), so it is
 * true on this card whichever side of UTC the reader is on ("Closes Fri 02:00" in CEST).
 *
 * ⛔ IT REPLACES THE CATALOG LITERAL "Closes 18:00" on MON and THU. Nothing closes at 18:00: voting
 * closes at `voting_ends_at` = Fri 00:00 UTC, and Monday closes nothing at all. `null` when the week
 * label or the boundary cannot be read — no subtitle beats an invented one.
 */
export function votingCloseCard(cycle: CycleState): CadenceDayKey | null {
	const weekStart = weekStartUtc(cycle.week);
	if (weekStart === null) return null;
	return cardsInWindow(weekStart, Date.parse(cycle.votingEndsAt)).at(-1) ?? null;
}
