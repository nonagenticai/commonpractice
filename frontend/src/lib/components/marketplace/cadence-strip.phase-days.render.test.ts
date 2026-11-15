// @vitest-environment jsdom
//
// src/lib/components/marketplace/cadence-strip.phase-days.render.test.ts — WHICH CARD THE STRIP
// LIGHTS UP WHEN A LIVE CYCLE IS ON THE WIRE.
//
// ⛔ THE DEFECT THIS PINS. `CadenceStrip.svelte` carried a hand-written table:
//
//     voting: ['MON'], solution_phase: ['TUE','WED','THU'], closed: ['FRI']
//
// i.e. a 1-day-voting / 3-day-solution week. The engine ships 4+3
// (`backend/src/config.ts` votingDays 4 / solutionDays 3, applied by `boundariesFor()` in
// `backend/src/host/cycle-service.ts` on top of `weekStart` = Monday 00:00 UTC):
//
//     voting_ends_at = Mon+4d = Fri 00:00 UTC   -> `voting`         spans MON TUE WED THU
//     closes_at      = Fri+3d = Mon 00:00 UTC   -> `solution_phase` spans FRI SAT SUN
//
// So during `voting` three of its four days were grey, during `solution_phase` three PAST days lit
// up, and FRI — the phase's own and only weekday — was never highlighted at all.
//
// ⚠️ THIS IS THE BRANCH THAT RUNS IN THE CLUSTER. `config.ts` defaults `CYCLE_ENABLED` off and the
// var appears nowhere in this repo, but gitops sets it to "true" for the deployed pod, and
// `startCycleScheduler` fires an immediate boot catch-up whose `openCycle(currentWeek)` writes a
// row seconds after any pod boot. `data.cycle` is therefore NON-NULL on every prod home load and
// this branch — not the `cycle === null` fallback that commit #229 fixed — is what a reader sees.
//
// ⛔ AND IT IS ASSERTED AGAINST THE ENGINE'S OWN ARITHMETIC, NOT AGAINST A SECOND TABLE. The
// fixtures below are built by `cycleFor(votingDays, solutionDays)`, which reproduces
// `boundariesFor()` in four lines. Change the cadence and the EXPECTATION moves with the fixture;
// there is no literal day list here for the component's literal day list to agree with by accident.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount, unmount, flushSync } from 'svelte';
import type { CycleState } from '$lib/types/cycle';
import { CADENCE_DAYS, type CadenceDayKey } from './cadence-day';
import { cardForUtcInstant, phaseDays, weekStartUtc } from './cycle-phase-days';

// Message stub: every key resolves to its own name, so this file asserts on the STRUCTURE the strip
// renders and never on wording. The copy moved in the same commit as the mapping; a test that
// grepped the English sentence would have had to move with it and would prove nothing about which
// day is lit. Built from the real `en` catalog (technique of leaderboard-row.vote-control.render)
// so a key the strip invents but never adds fails loudly as `undefined is not a function`.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

import CadenceStrip from './CadenceStrip.svelte';

const DAY = 24 * 60 * 60 * 1000;

/**
 * ISO week labels and the Monday 00:00 UTC each one starts on.
 *
 * ⛔ EVERY MONDAY HERE IS AN INDEPENDENT LITERAL, NOT A CALL TO `weekStartUtc`. That is the whole
 * value of the table: if the expectations were computed with the function under test, the function
 * could return any constant it liked and still agree with itself. Each value was taken from the
 * BACKEND's `weekStart()` (backend/src/host/iso-week.ts) — the implementation `weekStartUtc` exists
 * to mirror — and each is a Monday, which `weekStartUtc` reproduces without sharing a line of code.
 *
 * The four are chosen to be four DIFFERENT shapes of the ISO rule, not four arbitrary weeks:
 *
 *   2026-W33  a plain mid-year week; the one every other fixture in this file uses
 *   2026-W53  a 53rd week — it exists only because 2026-01-01 is a Thursday, and `W53` is a label
 *             most years do not have at all
 *   2027-W01  the week immediately AFTER 2026-W53, i.e. the label whose Monday the 53-week year
 *             pushes a week later than a naive "first Monday of January" would put it
 *   2025-W01  a week 1 whose Monday falls in the PREVIOUS CALENDAR YEAR (2024-12-30) — the case a
 *             `Date.UTC(year, 0, …)`-shaped shortcut gets wrong
 */
const WEEKS = {
	'2026-W33': Date.UTC(2026, 7, 10),
	'2026-W53': Date.UTC(2026, 11, 28),
	'2027-W01': Date.UTC(2027, 0, 4),
	'2025-W01': Date.UTC(2024, 11, 30)
} as const;
type WeekLabel = keyof typeof WEEKS;

const WEEK: WeekLabel = '2026-W33';

/**
 * The engine's `boundariesFor()` (backend/src/host/cycle-service.ts:48-53), reproduced. The whole
 * point of this helper is that the cadence is a PARAMETER here exactly as it is a config value
 * there — so every expectation below is a statement about 4+3 rather than a copy of it. The WEEK is
 * a parameter for the same reason: a fixture set that only ever names one week cannot tell a real
 * ISO-week parse from a constant (see the `weekStartUtc` block below).
 */
function cycleFor(
	phase: CycleState['phase'],
	votingDays = 4,
	solutionDays = 3,
	week: WeekLabel = WEEK
): CycleState {
	const votingEnds = WEEKS[week] + votingDays * DAY;
	const solutionEnds = votingEnds + solutionDays * DAY;
	return {
		week,
		phase,
		votingEndsAt: new Date(votingEnds).toISOString(),
		solutionEndsAt: new Date(solutionEnds).toISOString(),
		closesAt: new Date(solutionEnds).toISOString(),
		closedAt: phase === 'closed' ? new Date(solutionEnds).toISOString() : null
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

/** The day KEYS the strip highlighted, read off the rendered cards by POSITION. */
function litDays(cycle: CycleState | null): CadenceDayKey[] {
	component = mount(CadenceStrip, { target, props: { cycle } }) as Record<string, unknown>;
	flushSync();
	const cards = [...target.querySelectorAll('.cadence .day')];
	// Position, not the caption: `.dk` renders `cadenceDayLabel()` — an Intl weekday in the reader's
	// locale — and comparing that against a day KEY is the exact confusion cadence-day.ts warns
	// about. The five cards render in CADENCE_DAYS order; that order is what is read here.
	expect(cards).toHaveLength(CADENCE_DAYS.length);
	return cards
		.map((el, i) => (el.classList.contains('today') ? CADENCE_DAYS[i]! : null))
		.filter((k): k is CadenceDayKey => k !== null);
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	vi.useRealTimers();
});

describe('the cadence strip under a LIVE cycle — the branch prod actually renders', () => {
	it('⛔ `voting` lights every weekday before voting_ends_at — MON TUE WED THU, not MON alone', () => {
		// voting_ends_at = Mon+4d = Fri 00:00 UTC, so Thursday is the LAST day of the window.
		expect(litDays(cycleFor('voting'))).toEqual(['MON', 'TUE', 'WED', 'THU']);
	});

	it('⛔ `solution_phase` lights FRI — its own day — and no day that is already past', () => {
		// The window is [Fri 00:00 UTC, Mon 00:00 UTC): FRI SAT SUN. Only FRI has a card.
		const lit = litDays(cycleFor('solution_phase'));
		expect(lit).toEqual(['FRI']);
		// Stated separately because this is the half that was visibly wrong on screen: the strip used
		// to light three days that had ALREADY ENDED when this phase began.
		expect(lit).not.toContain('TUE');
		expect(lit).not.toContain('WED');
		expect(lit).not.toContain('THU');
	});

	it('⛔ `closed` lights NOTHING and lets the phase header carry the week', () => {
		// REACHABLE, not dead: `POST /api/cycle/advance {to:'closed'}` (backend/src/routes/cycle.ts)
		// defaults `week` to the current one, so `readCurrentCycle` reports `closed` for the rest of
		// that week and a reader really does sit on this branch.
		//
		// ⛔ THIS BRANCH USED TO RETURN `['MON']` — the card `closes_at` lands on. Arithmetically
		// defensible, wrong on screen: with 4+3 `closes_at` is the NEXT week's Monday, so the lit card
		// belonged to a week that had not opened, and MON's title is "Vote on challenges" — lit
		// directly under the `cycle_phase_closed` header, "Week closed · winner announced". Two
		// contradictory sentences on one strip is the defect class the derivation was written to end.
		// See cycle-phase-days.ts for why `[closes − 1d, closes)` was rejected too.
		expect(litDays(cycleFor('closed'))).toEqual([]);
		// Nothing is LOST by lighting nothing: the state is fully on screen in the header.
		expect(target.textContent).toContain('cycle_phase_closed');
		expect(target.querySelector('.cp-dot.closed')).not.toBeNull();
	});

	it('⛔ `closed` lights nothing at a cadence that does NOT sum to 7 either', () => {
		// ⛔ THE FIXTURE HOLE THIS CLOSES. Every `closed` fixture in this repo used to make `closes_at`
		// a MONDAY — the render test only ever exercised 4+3, and the 1..6 loop in
		// cadence-strip.wiring.test.ts hardcodes `closes = votingEnds + (7 − votingDays)·DAY`, which
		// pins the sum at 7 for every cadence it walks. So `case 'closed': return ['MON']` — the exact
		// hardcoded table cycle-phase-days.ts exists to abolish — passed the entire suite.
		//
		// `CYCLE_VOTING_DAYS`/`CYCLE_SOLUTION_DAYS` are two independent env vars; nothing makes them
		// add up to 7. 4+2 closes on a SUNDAY, 4+1 on a Saturday: no card, and the answer is `[]`.
		expect(litDays(cycleFor('closed', 4, 2))).toEqual([]);
		unmount(component!);
		component = null;
		target.innerHTML = '';
		expect(litDays(cycleFor('closed', 4, 1))).toEqual([]);
	});

	it('⛔ …and lights nothing when closes_at lands squarely on a WEEKDAY', () => {
		// The one that separates "empty by design" from "empty because it happened to be a weekend".
		// 3+1 closes Fri 00:00 UTC — a card exists for that day, and it must still not light: FRI
		// reads "Guest talk + solutions open", which under "Week closed" is the same contradiction
		// MON was. Sanity-check the premise first so this cannot pass by closing on a Sunday.
		const closed = cycleFor('closed', 3, 1);
		expect(cardForUtcInstant(Date.parse(closed.closesAt))).toBe('FRI');
		expect(litDays(closed)).toEqual([]);
	});

	it('⛔ follows a CHANGED cadence with no code change — 2 voting + 5 solution days', () => {
		// The drift guard, stated as behaviour. `CYCLE_VOTING_DAYS=2` makes voting_ends_at Wed 00:00
		// UTC, so voting is MON TUE and the solution phase runs WED..SUN. A hand-written table cannot
		// pass this test and a derived mapping cannot fail it.
		expect(litDays(cycleFor('voting', 2, 5))).toEqual(['MON', 'TUE']);
		unmount(component!);
		component = null;
		target.innerHTML = '';
		expect(litDays(cycleFor('solution_phase', 2, 5))).toEqual(['WED', 'THU', 'FRI']);
	});

	it('⛔ renders the same phase correctly in a DIFFERENT ISO week — 2027-W01, not just 2026-W33', () => {
		// ⛔ THE FIXTURE HOLE THIS CLOSES, THE OTHER HALF. Every fixture in this file and in
		// cadence-strip.wiring.test.ts named the single label `2026-W33`, so `weekStartUtc` could have
		// been `return Date.UTC(2026, 7, 10)` — the ISO-week arithmetic that is this module's whole
		// central argument, deleted — and the suite stayed green. A second week is what makes the
		// parse load-bearing at the RENDER level too, not only in the unit block below.
		//
		// 2027-W01 starts Mon 2027-01-04 (backend `weekStart`), so its boundaries are seven weeks and
		// a year away from 2026-W33's. The lit days are identical because the CADENCE is identical —
		// which is the point: a constant week start makes the window span five months and light all
		// five cards instead.
		expect(litDays(cycleFor('voting', 4, 3, '2027-W01'))).toEqual(['MON', 'TUE', 'WED', 'THU']);
		unmount(component!);
		component = null;
		target.innerHTML = '';
		// 2026-W53 — a week that exists only because 2026-01-01 is a Thursday.
		expect(litDays(cycleFor('solution_phase', 4, 3, '2026-W53'))).toEqual(['FRI']);
	});

	it('⛔ a live cycle keeps the PHASE highlight AND marks the reader’s own weekday as today', () => {
		// The highlight is the PHASE's and never falls back to the reader's weekday — but the reader
		// still needs to see which card is today. A browser walk (2026-10-14) found no "today" marker
		// at all under a live cycle; it is now a SEPARATE mark (`is-today` + "· today" + aria-current),
		// so it can never be mistaken for the phase. Red by restoring `{#if !cycle && d.k === today}`
		// and dropping `class:is-today`.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 12, 12)); // a Wednesday, in the reader's own timezone
		expect(litDays(cycleFor('solution_phase'))).toEqual(['FRI']);
		const cards = [...target.querySelectorAll('.cadence .day')];
		const marked = cards.map((el, i) => (el.classList.contains('is-today') ? CADENCE_DAYS[i] : null)).filter(Boolean);
		expect(marked).toEqual(['WED']);
		expect(cards[2]!.getAttribute('aria-current')).toBe('date');
		expect(cards[2]!.textContent).toContain('mkt_cadence_today');
		expect(target.textContent!.split('mkt_cadence_today').length - 1).toBe(1);
	});

	it('⛔ "today" is the UTC day of the SAME grid as the phase cards — a New York reader at Thu 21:00 is on FRI', () => {
		// Phases and the close card are placed by UTC day; the marker used the reader's LOCAL weekday.
		// NY Thu 21:00 EDT = Fri 01:00 UTC, solution_phase: FRI lit, THU marked "today" and THU's
		// "Closes Thu 20:00" already past. Red by restoring `today = cadenceDayKey()` as the default.
		const prevTz = process.env.TZ;
		process.env.TZ = 'America/New_York';
		try {
			const instant = Date.UTC(2026, 7, 14, 1); // Fri 2026-08-14 01:00 UTC
			// Non-vacuity: the timezone really applies — locally this instant is THURSDAY 21:00.
			expect(new Date(instant).getDay()).toBe(4);
			expect(new Date(instant).getHours()).toBe(21);
			vi.useFakeTimers();
			vi.setSystemTime(new Date(instant));
			expect(litDays(cycleFor('solution_phase'))).toEqual(['FRI']);
			const cards = [...target.querySelectorAll('.cadence .day')];
			const marked = cards
				.map((el, i) => (el.classList.contains('is-today') ? CADENCE_DAYS[i] : null))
				.filter(Boolean);
			expect(marked).toEqual(['FRI']); // today = the highlighted day
			expect(cards[4]!.getAttribute('aria-current')).toBe('date');
			expect(cards[3]!.textContent).not.toContain('mkt_cadence_today');
		} finally {
			if (prevTz === undefined) delete process.env.TZ;
			else process.env.TZ = prevTz;
		}
	});

	it('an unusable week label highlights NOTHING rather than guessing a day', () => {
		// `weekStartUtc` is the only parse in the path. A malformed label must degrade to the honest
		// weekend rendering (five neutral cards) — never to an `undefined`-shaped highlight, and never
		// take the home screen down: this component is screen #1.
		const lit = litDays({ ...cycleFor('voting'), week: 'not-a-week' });
		expect(lit).toEqual([]);
		expect(target.textContent).not.toContain('undefined');
		expect(target.textContent).not.toContain('NaN');
	});
});

describe('weekStartUtc — the ISO-8601 arithmetic the whole mapping stands on', () => {
	// ⛔ WHY THIS BLOCK EXISTS. `weekStartUtc` is the one thing cycle-phase-days.ts hardcodes, and its
	// header defends that on the grounds that ISO-8601 is a frozen standard rather than a tunable.
	// That defence is only worth anything if the arithmetic is actually asserted — and it was not:
	// every fixture in both new test files named `2026-W33`, so `return Date.UTC(2026, 7, 10)` passed
	// 628/628. A mirror of a server function that no test compares to the server is a copy, not a
	// mirror. The expected Mondays in `WEEKS` come from the backend's own `weekStart()`.
	it('⛔ maps each ISO week label to the Monday the BACKEND puts it on', () => {
		for (const [label, monday] of Object.entries(WEEKS)) {
			expect(weekStartUtc(label)).toBe(monday);
			// Every ISO week starts on a Monday, by definition. Stated separately so a value that is
			// merely the right NUMBER but the wrong weekday cannot be transcribed in above unnoticed.
			expect(new Date(monday).getUTCDay()).toBe(1);
		}
		// The property a constant cannot have: four labels, four DIFFERENT instants.
		const starts = Object.keys(WEEKS).map((w) => weekStartUtc(w));
		expect(new Set(starts).size).toBe(starts.length);
	});

	it('⛔ 2026-W53 and 2027-W01 are consecutive weeks, seven days apart', () => {
		// The 53-week year, stated as a relationship rather than as two more literals. A naive "week 1
		// is the first Monday of January" puts 2027-W01 on 2026-12-28 and collides with 2026-W53.
		expect(weekStartUtc('2027-W01')! - weekStartUtc('2026-W53')!).toBe(7 * DAY);
	});

	it('a label naming no week is null — never a guessed Monday', () => {
		// `W00`/`W54` parse as digits and name nothing; the null is what makes `phaseDays` return the
		// five neutral cards instead of highlighting a week that does not exist.
		for (const bad of ['', 'not-a-week', '2026-W00', '2026-W54', '2026-33', '26-W33', null, undefined])
			expect(weekStartUtc(bad)).toBeNull();
	});
});

describe('the cadence card COPY says what the engine does on that card’s day', () => {
	// ⛔ WHY THE COPY IS IN THE SAME COMMIT AS THE MAPPING, AND WHY THIS TEST EXISTS.
	// Remapping the highlight alone lights a card under a sentence describing an activity that has
	// not started. Two titles named the wrong day outright:
	//
	//   THU "Vote on solutions"   — solutions enter their window at `voting_ends_at` = Fri 00:00 UTC
	//   FRI "Guest talk + winner" — the winner is announced at `closes_at`      = Mon 00:00 UTC
	//
	// So the fix that lights THU during `voting` would have lit "Vote on solutions" a full day
	// before solution voting opens, and the fix that lights FRI during `solution_phase` would have
	// lit "winner" three days before there is one. THU now names the boundary Thursday actually is,
	// FRI names the phase it actually opens, and the winner claim is left to `cycle_phase_closed` in
	// the header, which renders exactly when the engine says the week is closed.
	//
	// ⛔ THE ALLOWED DAY SETS ARE COMPUTED, NOT TYPED IN. Each rule below asks `phaseDays` — the same
	// function the component uses — which cards a phase covers, and then checks that the claim only
	// appears on those. Change the cadence and both the mapping and the permission move together;
	// there is no second table for this file to agree with by accident.
	//
	// ⚠️ ENGLISH ONLY, DELIBERATELY. `en` is the base catalog every other locale is translated from
	// (catalogs.test.ts enforces key parity against it), so it is the one place a word-level claim is
	// meaningful. Word-matching eight languages would need a lexicon per locale — that is a
	// translation-review job, not a unit test, and a bad one here would block correct translations.
	const en = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const TITLES: Record<string, string> = {
		MON: en.mkt_cadence_mon_t!,
		TUE: en.mkt_cadence_tue_t!,
		WED: en.mkt_cadence_wed_t!,
		THU: en.mkt_cadence_thu_t!,
		FRI: en.mkt_cadence_fri_t!
	};

	/** The cards allowed to make a claim, and the cards that must not — from the engine's numbers. */
	function split(phase: CycleState['phase']): { allowed: string[]; forbidden: string[] } {
		const allowed = phaseDays(cycleFor(phase)) as string[];
		return { allowed, forbidden: CADENCE_DAYS.filter((d) => !allowed.includes(d)) };
	}

	function claims(day: string, word: RegExp): boolean {
		return word.test(TITLES[day]!);
	}

	it('⛔ only a card in the SOLUTION window may name solutions — THU said "Vote on solutions"', () => {
		const { allowed, forbidden } = split('solution_phase');
		expect(allowed).toEqual(['FRI']); // [Fri 00:00 UTC, Mon 00:00 UTC)
		for (const day of forbidden) expect(claims(day, /solution/i)).toBe(false);
		// …and the window's own card must actually say so, or the phase has no copy at all.
		expect(allowed.some((d) => claims(d, /solution/i))).toBe(true);
	});

	it('⛔ only the card the week CLOSES on may name the winner — FRI said "Guest talk + winner"', () => {
		// `closes_at` is Mon 00:00 UTC, so Friday is three days early. No card claims the winner now;
		// `cycle_phase_closed` ("Week closed · winner announced") carries it in the phase header, on
		// the only branch where it is true. The rule is still stated as a rule: if a card ever takes
		// the claim back, it must be the one the engine closes on.
		const { forbidden } = split('closed');
		for (const day of forbidden) expect(claims(day, /winner/i)).toBe(false);
	});

	it('only a card in the VOTING window may name challenge voting', () => {
		const { allowed, forbidden } = split('voting');
		expect(allowed).toEqual(['MON', 'TUE', 'WED', 'THU']); // [Mon 00:00 UTC, Fri 00:00 UTC)
		for (const day of forbidden) expect(claims(day, /challenge/i)).toBe(false);
		expect(allowed.some((d) => claims(d, /challenge/i))).toBe(true);
	});

	it('⛔ only the card a phase boundary LANDS ON may say a phase closes — THU said "…closes"', () => {
		// ⛔ THE SECOND FALSE CLAIM ON THE SAME CARD. Fixing "Vote on solutions" produced "Challenge
		// voting closes", which is not a statement about Thursday at all — it names an INSTANT, and
		// the engine's instant is `voting_ends_at` = FRIDAY 00:00 UTC. Six hours after the "Closes
		// 18:00" subtitle it sits above, and a different calendar day for every reader west of UTC.
		//
		// ⚠️ AND /docs IS SAYING THE SAME WRONG THING RIGHT NOW, WHICH IS WHY THIS IS A RULE AND NOT A
		// ONE-WORD EDIT. `docs_cadence_thu_day`/`_text` still read "Thursday 18:00 — challenge +
		// solution voting closes" on `routes/docs/+page.svelte:104`; a separate workstream is
		// replacing them. Two surfaces each free to name their own closing instant is how they came to
		// disagree with the engine independently. The rule below is the fix that survives either merge
		// order: whatever /docs ends up saying, the strip asserts the boundary card from the engine's
		// numbers rather than from a day name typed into a test.
		//
		// THE ALLOWED CARD IS COMPUTED, NOT TYPED IN: ask the engine's own numbers which card the
		// boundary falls on, then require every other card to be silent about closing. THU is now
		// "Last day of challenge voting" — true of the day, and naming no instant.
		const boundary = cardForUtcInstant(Date.parse(cycleFor('voting').votingEndsAt));
		expect(boundary).toBe('FRI'); // [Mon 00:00 UTC, Fri 00:00 UTC) — Friday is the first instant OUT
		const CLOSING = /\b(closes?|closed|closing|ends?|ending|deadline)\b/i;
		// Asserted on `KEY: title` rather than on a bare boolean so a failure names the offending card.
		for (const day of CADENCE_DAYS.filter((d) => d !== boundary))
			expect(`${day}: ${TITLES[day]!}`).not.toMatch(CLOSING);
	});

	it('⛔ "Closes 18:00" is GONE — it was a false deadline, not a ritual; the ritual subtitles stay', () => {
		// Voting closes at `voting_ends_at` = Fri 00:00 UTC; Monday closes nothing. The two literals were
		// retired (the close instant now comes off the cycle row — see the next describe block). The
		// genuine standing rituals keep their catalog subtitles.
		expect(en.mkt_cadence_mon_s).toBeUndefined();
		expect(en.mkt_cadence_thu_s).toBeUndefined();
		expect(en.mkt_cadence_fri_s).toBe('14:30 · CTO café');
		// WED still has no subtitle key at all — the "in 2 hours" literal that nothing computed.
		expect(en.mkt_cadence_wed_s).toBeUndefined();
	});
});

describe('the cadence strip with NO cycle — the branch commit #229 fixed', () => {
	it('⛔ a WEEKEND highlights nothing and captions nothing "· today"', () => {
		// The bypass this closes: `today = cadenceDayKey() ?? 'WED'` passes every source-grep guard in
		// cadence-strip.wiring.test.ts while restoring exactly the lie cadence-day.ts:22-31 removed —
		// a Saturday reader told Wednesday is today. Only a render on a weekend clock catches it.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 15, 12)); // Saturday 2026-08-15, local time
		expect(litDays(null)).toEqual([]);
		expect(target.textContent).not.toContain('mkt_cadence_today');
	});

	it('a weekday highlights that weekday and captions it "· today"', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 11, 12)); // Tuesday 2026-08-11, local time
		expect(litDays(null)).toEqual(['TUE']);
		expect(target.textContent).toContain('mkt_cadence_today');
	});
});

describe('⛔ the voting close time comes off the cycle row, in the reader’s timezone', () => {
	// A browser walk (2026-10-14) read "Sluit 18:00" on MON and THU while voting closes at Fri 00:00
	// UTC. Red by restoring `<div class="ds">{d.sKey ? mm[d.sKey]() : ''}</div>` (the close label is
	// never rendered) or by putting the literal back.
	function subtitles(cycle: CycleState | null): string[] {
		component = mount(CadenceStrip, { target, props: { cycle } }) as Record<string, unknown>;
		flushSync();
		return [...target.querySelectorAll('.cadence .day .ds')].map((el) => el.textContent ?? '');
	}

	it('the LAST voting card says "closes" with the engine instant’s local weekday + time; no other card does', async () => {
		const { weekdayTime } = await import('$lib/utils/format');
		const cycle = cycleFor('voting');
		const ds = subtitles(cycle);
		const expected = `mkt_cadence_closes_at:${weekdayTime(cycle.votingEndsAt, 'en')}`;
		// THU = the last card of [Mon 00:00 UTC, Fri 00:00 UTC).
		expect(ds[3]).toBe(expected);
		expect(ds.filter((t) => t.startsWith('mkt_cadence_closes_at'))).toHaveLength(1);
		expect(ds[0]).toBe(''); // Monday closes nothing
		for (const t of ds) expect(t).not.toMatch(/18[:.]00/);
	});

	it('the label is the reader’s CLOCK, not UTC’s: Fri 00:00 UTC reads "vr 02:00" in Amsterdam, "do 20:00" in New York', async () => {
		const { weekdayTime } = await import('$lib/utils/format');
		const instant = cycleFor('voting').votingEndsAt; // 2026-08-14T00:00:00Z, a Friday
		expect(weekdayTime(instant, 'nl', 'Europe/Amsterdam')).toBe('vr 02:00');
		expect(weekdayTime(instant, 'nl', 'America/New_York')).toBe('do 20:00');
	});

	it('with NO cycle nothing claims a close time — nothing on the wire says when anything closes', () => {
		const ds = subtitles(null);
		expect(ds.some((t) => t.includes('mkt_cadence_closes_at'))).toBe(false);
	});
});
