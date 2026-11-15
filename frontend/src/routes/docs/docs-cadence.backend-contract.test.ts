// src/routes/docs/docs-cadence.backend-contract.test.ts — the docs cadence list may describe the
// company's weekly rhythm, but it may not attribute the ENGINE'S BEHAVIOUR to an instant the
// engine does not produce.
//
// ⛔ WHAT THIS FILE ACTUALLY TESTS, AND WHAT IT DOES NOT. Read this before trusting it. It carries
// TWO per-locale assertions and they have different reach:
//
//   (A) THE CLOCK ASSERTION — "no cadence string names a clock the engine does not produce".
//       Complete in all eight locales, because it needs no vocabulary: it matches CLOCK FORMS
//       (digits and separators), which every locale writes the same way.
//   (B) THE ATTRIBUTION ASSERTION — "no cadence bullet puts the winner announcement anywhere but an
//       engine instant". Needs one word per locale (`ANNOUNCE_TERMS`), and so is only as good as
//       that table — which is why the table is anchored to live catalog text by its own test.
//
// (B) EXISTS BECAUSE (A) ALONE WAS A CLOCK GUARD WEARING A MECHANISM LABEL. Everything below talks
// about MECHANISM vs RITUAL, but until (B) the only per-locale filter was `namesAClock(v)` — so a
// false mechanism claim carrying NO CLOCK was invisible in all eight locales. That was not a
// hypothetical: `docs_cadence_fri_text` shipped as " — guest talk + winner announcement." next to
// the ritual "Friday 14:30", and the engine writes `weekly_winners` + `enqueueWinner` inside
// `closeCycle` at `closes_at` — MONDAY 00:00 UTC. A mutation test confirmed the hole: a flagrant
// mechanism lie planted in a `_text` value left the suite 12/12 GREEN.
//
// ⚠️ STILL OUT OF REACH, do not read this file as covering it: a wrong DAY at a right clock. "en
// states the two real closing instants" pins the day words in ENGLISH ONLY; the seven other
// locales could say Tuesday 00:00 UTC and both assertions would pass, because a day name is
// vocabulary too and `do`/`Do`/`jeu.`/`czw.`/`الخميس`/`ה׳` share nothing to match on. Closing that
// needs a per-locale weekday table, which is a bigger table than `ANNOUNCE_TERMS` and was not
// taken here.
//
// THE DEFECT this pins: `docs_cadence_thu_day` read "Thursday 18:00" and `docs_cadence_thu_text`
// read " — challenge + solution voting closes." Both halves were wrong, and not by a rounding
// error — the sentence named a mechanism the engine contradicts, in all eight locales:
//
//   * `backend/src/host/iso-week.ts` `weekStart()` returns MONDAY 00:00:00 UTC.
//   * `backend/src/host/cycle-service.ts` `boundariesFor()` derives every boundary from it by
//     adding WHOLE DAYS: `votingEnds = weekStart + votingDays*DAY`,
//     `solutionEnds = votingEnds + solutionDays*DAY`.
//   * `backend/src/host/period.ts` fixes those at 4 and 3 for a week period (0107).
//
//   => challenge voting closes FRIDAY 00:00 UTC; solution voting (and the week) closes MONDAY
//      00:00 UTC. Neither instant is a Thursday and neither is 18:00 — and they are two DIFFERENT
//      instants three days apart, so no single bullet could ever have carried both.
//
// ⛔ WHY THIS IS A SEPARATE GUARD FROM `lib/challenges/vote-surface-copy.test.ts`, AND NOT A
// WIDENING OF IT. That file bans a clock in any PER-ITEM claim, and it exempts `docs_cadence_*` /
// `mkt_cadence_*` IN WRITING and on purpose: those keys "may legitimately describe the company's
// weekly rhythm — a real product fact — rather than promising a deadline for the row in front of
// the reader." That exemption is correct and stays. A guest talk at 14:30 is a real recurring
// meeting; the CadenceStrip's bare "Closes 18:00" is ritual copy that commit #229 explicitly
// DECIDED to keep. None of that is what broke here.
//
// The distinction this file draws is MECHANISM vs RITUAL, which is a different axis from the one
// vote-surface-copy tests:
//
//   * A RITUAL is a human calendar event — people meet, someone talks. It is true because the
//     company says so, no code computes it, and no code can contradict it.
//   * A MECHANISM is a claim about what the ENGINE does at an instant — "voting closes". That is
//     falsifiable against `cycle-service.ts`, and it was false.
//
// So the invariant is narrow and derived rather than a list of banned sentences: because every
// boundary is `weekStart + <whole days>`, EVERY instant the engine produces lands at 00:00 UTC.
// A clock in the cadence family that is not 00:00 therefore cannot be describing the engine — it
// is either a ritual (and must be declared as one below) or it is an invented deadline.
//
// Like `lib/types/audit-categories.backend-contract.test.ts` and
// `lib/api/error-message.backend-contract.test.ts`, this reads BACKEND SOURCE TEXT off disk with
// plain `fs`. backend/ and frontend/ are two separate Bun projects — no workspaces, no shared
// package, no codegen — so there is no import to make instead, and the cadence numbers would
// otherwise be duplicated here as magic constants that drift the moment someone retunes the cycle.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;
const messages = resolve(process.cwd(), 'messages');
const BACKEND_SRC = fileURLToPath(new URL('../../../../backend/src', import.meta.url));

function catalog(locale: string): Record<string, string> {
	return JSON.parse(readFileSync(resolve(messages, `${locale}.json`), 'utf8')) as Record<
		string,
		string
	>;
}

/** Every `docs_cadence_*` entry in a locale, as [key, value] pairs. */
function cadenceEntries(locale: string): [string, string][] {
	return Object.entries(catalog(locale)).filter(
		([k, v]) => k.startsWith('docs_cadence_') && typeof v === 'string'
	);
}

/**
 * The cadence family regrouped into BULLETS — the unit the reader actually sees.
 *
 * ⛔ WHY NOT PER KEY. `/docs` renders each bullet as one `<li>`:
 * `<b>{m.docs_cadence_<slug>_day()}</b>{m.docs_cadence_<slug>_text()}` (routes/docs/+page.svelte).
 * The CLOCK lives in `_day` and the CLAIM ABOUT IT lives in `_text`, so a per-key assertion can
 * never relate the two — it sees "Friday 14:30" with no claim, and "winner announcement" with no
 * time, and finds nothing wrong with either. That split is exactly how the false claim survived.
 * Every attribution check below therefore runs on the JOINED bullet.
 *
 * Derived from the key names rather than listed, so renaming or adding a bullet needs no edit here
 * (`docs_cadence_title` has neither suffix and drops out).
 */
function cadenceBullets(locale: string): { slug: string; text: string }[] {
	const bySlug = new Map<string, string[]>();
	for (const [k, v] of cadenceEntries(locale)) {
		const m = /^docs_cadence_(.+)_(?:day|text)$/.exec(k);
		if (!m) continue;
		const slug = m[1]!;
		bySlug.set(slug, [...(bySlug.get(slug) ?? []), v]);
	}
	return [...bySlug].map(([slug, parts]) => ({ slug, text: parts.join(' ') }));
}

/**
 * The week cadence, read from `backend/src/host/period.ts` rather than restated here.
 *
 * Since 0107 the phase lengths are code constants per period kind (week 4 + 3 days), not the
 * `CYCLE_VOTING_DAYS` / `CYCLE_SOLUTION_DAYS` env pair — so the gitops-only retune this comment
 * used to warn about can no longer move the boundary behind this guard's back. (Prod's Deployment
 * may still carry those two env vars; nothing reads them any more.)
 */
function cadenceDays(): { votingDays: number; solutionDays: number } {
	// 0107: the week phases are no longer env-configurable. `host/period.ts` holds them per kind:
	// `WEEK_VOTING_DAYS` voting days, and the week CLOSES at the next Monday (`nextPeriodStart`), so
	// the building phase is the rest of the 7 days. Read off disk, never restated.
	const src = readFileSync(resolve(BACKEND_SRC, 'host', 'period.ts'), 'utf8');
	const m = /export const WEEK_VOTING_DAYS = (\d+);/.exec(src);
	if (!m) throw new Error('could not read WEEK_VOTING_DAYS from backend/src/host/period.ts');
	const votingDays = Number.parseInt(m[1]!, 10);
	if (!/case 'week':\s*return new Date\(start\.getTime\(\) \+ 7 \* DAY\);/.test(src)) {
		throw new Error('backend/src/host/period.ts no longer closes a week 7 days after it starts');
	}
	return { votingDays, solutionDays: 7 - votingDays };
}

/** `weekStart()` semantics, re-derived: the Monday 00:00:00 UTC that starts an ISO week. */
const MONDAY = new Date(Date.UTC(2026, 7, 10)); // 2026-08-10 is a Monday.
const DAY = 24 * 60 * 60 * 1000;

const DAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
] as const;

function instant(offsetDays: number): { day: string; clock: string } {
	const d = new Date(MONDAY.getTime() + offsetDays * DAY);
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	return { day: DAY_NAMES[d.getUTCDay()]!, clock: `${hh}:${mm}` };
}

/**
 * The clock forms these eight locales write, borrowed from `vote-surface-copy.test.ts` so the two
 * guards cannot disagree about what "names a time" means. Deliberately NOT a weekday word list —
 * `do`/`Do`/`jeu.`/`czw.`/`الخميس`/`ה׳` share nothing and a table of them would drift.
 */
const CLOCK_FORMS: { name: string; re: RegExp }[] = [
	{ name: '18:00', re: /[\d٠-٩]{1,2}\s*:\s*[\d٠-٩]{2}/ },
	{ name: '18.00 / 18,00', re: /\b\d{1,2}[.,]\d{2}\b/ },
	{ name: '18h00', re: /\b\d{1,2}\s?h(\s?\d{2})?\b/i },
	{ name: '6pm', re: /\b\d{1,2}\s?[ap]\.?\s?m\.?\b/i },
	{ name: '18 uur / Uhr / hs / godz', re: /\b\d{1,2}\s?(uur|uhr|hs|godz)\b/i },
	{ name: 'godz. 18', re: /\bgodz\.?\s?\d{1,2}\b/i }
];

function namesAClock(value: string): boolean {
	return CLOCK_FORMS.some((f) => f.re.test(value));
}

/** 00:00 in the forms these catalogs write it. The ONLY clock the engine can be talking about. */
const ENGINE_CLOCK = /\b00\s*[:.,]\s*00\b/;

/** Names a time, and it is not one of the engine's. */
function namesNonEngineClock(value: string): boolean {
	return namesAClock(value) && !ENGINE_CLOCK.test(value);
}

/**
 * The word each locale uses for ANNOUNCING THE WINNER — the one engine act the cadence list kept
 * mis-attributing.
 *
 * ⛔ THIS TABLE IS THE WEAK POINT OF ASSERTION (B) AND IS ANCHORED ON PURPOSE. A hand-written
 * vocabulary table rots: someone retranslates a locale, the term stops matching, and the assertion
 * silently passes on everything forever — a green guard that tests nothing, which is worse than no
 * guard. So the test below it requires every entry to still match that locale's
 * `docs_aftervoting_p1`, which is where the announcement is legitimately described ("When a round
 * closes, the winning solution is announced …"). If a retranslation moves the word, the anchor test
 * reds and names the locale, forcing this table forward with the copy.
 *
 * Stems, not whole words, because these are inflected: nl bekendmaking/bekendgemaakt,
 * de Bekanntgabe/bekannt gegeben, pl ogłoszenie/ogłoszone, ar إعلان/يُعلن (the alif appears in the
 * noun and not the verb), he הכרזת/מוכרז.
 */
const ANNOUNCE_TERMS: Record<(typeof LOCALES)[number], RegExp> = {
	en: /announc/i,
	nl: /bekendma|bekendgemaakt/i,
	pl: /ogłosz/i,
	fr: /annonc/i,
	es: /anunci/i,
	de: /bekanntgabe|bekannt\s?gegeben/i,
	ar: /عل[اٱ]?ن/,
	he: /כרז/
};

/**
 * ⛔ THE RITUAL ALLOWLIST — the ONLY escape hatch, and it is deliberately tiny and keyed, not
 * pattern-matched. A key belongs here when its clock is a HUMAN CALENDAR EVENT that no code
 * computes and no code can contradict.
 *
 * `docs_cadence_fri_day` is "Friday 14:30" — a guest talk plus the human announcement of the
 * winner. The engine picks the winner at the Monday 00:00 UTC close; a person reading it out on
 * Friday afternoon is a meeting, not a mechanism, and the two do not contradict each other.
 *
 * ⚠️ DO NOT ADD A KEY HERE TO SILENCE A FAILURE. If the sentence says something CLOSES, OPENS or
 * IS DECIDED at that clock, it is a mechanism claim and the fix is to correct it against
 * `cycle-service.ts`, not to declare it ritual. That is exactly the move that put "Thursday 18:00
 * — challenge + solution voting closes" in front of readers in eight languages.
 */
const RITUAL_KEYS = new Set(['docs_cadence_fri_day']);

describe('docs cadence copy vs the cycle engine', () => {
	it('every engine boundary lands at 00:00 UTC, which is what makes the guard below valid', () => {
		const { votingDays, solutionDays } = cadenceDays();
		// Whole days only — a fractional day would put a boundary at a real clock time and this
		// file's central assumption (any non-00:00 clock is not the engine) would stop holding.
		expect(Number.isInteger(votingDays)).toBe(true);
		expect(Number.isInteger(solutionDays)).toBe(true);
		// `boundariesFor()` comments this invariant: the cadence sums to a week so each close flows
		// into the next week's open on the same tick.
		expect(votingDays + solutionDays).toBe(7);

		expect(instant(votingDays)).toEqual({ day: 'Friday', clock: '00:00' });
		expect(instant(votingDays + solutionDays)).toEqual({ day: 'Monday', clock: '00:00' });
	});

	it('the cadence family is non-trivial, so a rename cannot silently empty this file', () => {
		expect(cadenceEntries('en').length).toBeGreaterThanOrEqual(8);
	});

	it('the announcement vocabulary still matches live copy, or assertion (B) is vacuous', () => {
		// The anchor described on ANNOUNCE_TERMS. `docs_aftervoting_p1` is the paragraph that owns
		// the announcement ("When a round closes, the winning solution is announced …"), so the term
		// MUST match there in every locale. If this reds, a retranslation moved the word: update
		// ANNOUNCE_TERMS. Do NOT delete this test — without it the table can rot into a no-op and
		// every `${locale}: no cadence bullet …` below goes green on anything.
		const unanchored = LOCALES.filter((l) => {
			const p1 = catalog(l)['docs_aftervoting_p1'];
			return typeof p1 !== 'string' || !ANNOUNCE_TERMS[l].test(p1);
		});
		expect(unanchored).toEqual([]);
	});

	for (const locale of LOCALES) {
		it(`${locale}: no cadence string names a clock the engine does not produce`, () => {
			const offenders = cadenceEntries(locale)
				.filter(([k]) => !RITUAL_KEYS.has(k))
				// 00:00 IS an engine instant, so a bullet may state it.
				.filter(([, v]) => namesNonEngineClock(v));
			expect(offenders).toEqual([]);
		});

		it(`${locale}: no cadence bullet puts the winner announcement at a non-engine instant`, () => {
			// ⛔ RITUAL_KEYS IS DELIBERATELY NOT CONSULTED HERE. That allowlist excuses a CLOCK from
			// assertion (A) — a 14:30 guest talk is a real meeting. It has never excused a claim about
			// what the ENGINE does, and if it did, the one-line fix for a failure here would be to add
			// a key to it, which is the precise move this whole file exists to prevent.
			//
			// The engine announces the winner inside `closeCycle` at `closes_at`, and every boundary
			// it produces lands at 00:00 UTC (asserted at the top of this describe). So a bullet that
			// mentions the announcement must name 00:00 and must not hang it on any other clock. A
			// bullet may still SAY the word `winner` freely — "the previous week's winner is read
			// out" is a ritual retelling of a decision made elsewhere, and names no instant at all.
			const term = ANNOUNCE_TERMS[locale];
			const offenders = cadenceBullets(locale)
				.filter((b) => term.test(b.text))
				.filter((b) => !ENGINE_CLOCK.test(b.text) || namesNonEngineClock(b.text));
			expect(offenders).toEqual([]);
		});
	}

	it('the keys that carried the invented deadline stay retired', () => {
		// Renamed, not reworded. `docs_cadence_thu_*` only ever made sense as "the Thursday bullet";
		// with the close on Friday, a key called `_thu_` holding "Friday 00:00 UTC" is a fossil that
		// invites the next editor to put Thursday back. `_close_` is named for the ROLE, so a future
		// cadence retune moves the value without re-lying in the key.
		const en = catalog('en');
		for (const retired of ['docs_cadence_thu_day', 'docs_cadence_thu_text']) {
			expect(Object.keys(en)).not.toContain(retired);
		}
	});

	// 0107: the cycle runs weekly, monthly or yearly, so the schedule names no WEEKDAY at all — only
	// the engine's clock (every boundary of every kind is 00:00 UTC). Naming Friday/Monday would be
	// false for a month or year cycle.
	it('en states the engine instant (00:00 UTC) with no weekday, and no longer the invented one', () => {
		const en = catalog('en');
		const closing = cadenceEntries('en')
			.filter(([k]) => !RITUAL_KEYS.has(k))
			.map(([, v]) => v)
			.join(' ');

		// The engine's two instants, both named, both attributed to the right day.
		expect(closing).toMatch(/00:00 UTC/);
		expect(closing).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);

		// The retired claim, in the exact shape it shipped in. `challenge + solution voting closes`
		// hung both instants on one day; nothing may re-hang them.
		const all = Object.entries(en)
			.filter(([k]) => k.startsWith('docs_cadence_'))
			.map(([, v]) => v)
			.join(' ');
		expect(all).not.toMatch(/Thursday/i);
		expect(all).not.toMatch(/18\s*[:.]\s*00/);
		expect(all).not.toMatch(/challenge \+ solution voting closes/i);
	});

	/**
	 * ⛔ THE SPLICE, IN ALL EIGHT LOCALES — the one thing a browser could NOT check here.
	 *
	 * `/docs` renders each bullet as `<b>{..._day()}</b>{..._text()}` with NOTHING between them, so
	 * the separator has to live at the head of `_text` and nowhere else. Two ways that breaks and
	 * both are invisible to every other test in this file: a `_text` that lost its leading " — "
	 * runs the day straight into the sentence ("Friday 00:00 UTCthe week moves…"), and a `_day`
	 * that gained a trailing dash renders it twice.
	 *
	 * This was found the hard way. A browser pass against production could not reach `/docs` at all
	 * — the whole shell is gated on `auth.isAuthenticated` (routes/+layout.svelte) and the prod
	 * account is GitHub-IdP-only, so there is no scriptable login and the rendered list has never
	 * been seen by a test. Asserting the STRING INVARIANT the splice depends on covers all 8
	 * locales instead of the 3 a browser would have managed, and it runs in 9s on every commit.
	 */
	it('every cadence bullet splices cleanly: exactly one leading separator, none on the day', () => {
		const rows: string[] = [];
		for (const locale of LOCALES) {
			const cat = catalog(locale);
			for (const slug of ['mon', 'tuewed', 'close', 'fri']) {
				const day = cat[`docs_cadence_${slug}_day`];
				const text = cat[`docs_cadence_${slug}_text`];
				// NON-VACUITY: both halves must exist, or the loop would assert nothing at all.
				expect(typeof day, `${locale}/${slug} _day`).toBe('string');
				expect(typeof text, `${locale}/${slug} _text`).toBe('string');
				if (!text.startsWith(' — ')) rows.push(`${locale}/${slug}: _text lost its separator`);
				if ((text.match(/ — /g) ?? []).length !== 1)
					rows.push(`${locale}/${slug}: _text has ${(text.match(/ — /g) ?? []).length} separators`);
				if (/[—–-]\s*$/.test(day)) rows.push(`${locale}/${slug}: _day ends in a dash — would double`);
			}
		}
		expect(rows).toEqual([]);
	});
});
