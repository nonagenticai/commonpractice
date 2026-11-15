// src/lib/challenges/vote-surface-copy.test.ts — the vote surfaces may not nail a clock time OR A
// DURATION into the message catalog.
//
// WHY A CATALOG TEST. Every defect this pins was a STRING, not a branch: catalog entries across the
// challenge and solution screens announced "Thursday 18:00" as each item's own deadline, and no
// code path produced any of them. A render test asserts the page picked the right key; only this
// asserts the key does not carry a fiction.
//
// ⛔ TWO WAYS THE FIRST VERSION OF THIS FILE WAS DECORATIVE, both found by adversarial review, both
// fixed below. It is worth reading before touching either constant.
//
//  1. THE PATTERN WAS TOO NARROW. It tested `\d{1,2}:\d{2}` only. `"Voting closes Thursday 18.00
//     uur."` sailed through — and the dotted form is how Dutch and German write times AT LEAST as
//     often as the colon. So did `"Thu 6pm"`. The colon is the one form the offending strings
//     happened to use; it was never the thing being tested for.
//
//  2. THE KEY LIST WAS HAND-WRITTEN. `challenge_detail_lc_solution_phase_sub` ("Fri (if top-5)")
//     was a per-item weekday claim that simply was not on it, so `"Fri 18:00 (if top-5)"` passed a
//     guard whose whole purpose is that sentence. A list maintained by hand drifts the moment
//     someone adds a key, and nothing reminds them. So the watched set is now DERIVED two ways
//     (families + the state modules' own imports) and the hand-written part is gone.
//
//  3. ⛔ A THIRD HOLE, FOUND LATER: IT ONLY EVER LOOKED FOR A CLOCK. `challenge_detail_lc_winner_sub`
//     read `"~3 weken (gebruikelijk)"` and `solution_detail_wins_days` read `"17 dagen"` — two
//     fabricated statements of the SAME quantity (how long a winner takes to reach production),
//     disagreeing with each other by four days, one click apart. Neither is a time of day, so every
//     `TIME_FORMS` pattern passed them, and this file went green over both for as long as it has
//     existed. A duration is exactly the same species of claim as a deadline: a number nothing
//     computes, presented as a fact about the item in front of the reader. `DURATION_FORM` below
//     closes the family. Note the fossil this left: `'~3 weeks (typical)'` used to sit in the
//     `shouldNotMatch` list of the final test — the guard was pinned to IGNORE the very string it
//     should have caught. It has moved to `shouldMatch`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;
const dir = resolve(process.cwd(), 'messages');
const src = resolve(process.cwd(), 'src');

/**
 * DERIVATION 1 — naming families. Every message that makes a claim about ONE challenge or ONE
 * solution lives under one of these prefixes, and a key added to any of them is watched from the
 * moment it exists. This is the part that does not drift: a future
 * `challenge_detail_lc_whatever_sub` is covered without anyone remembering this file.
 *
 * ⛔ THE PRODUCT-CADENCE COPY IS OUTSIDE THESE FAMILIES ON PURPOSE, not by omission.
 * `mkt_cadence_*`, `docs_cadence_*` and `challenges_lede` may legitimately describe the company's
 * weekly rhythm — a real product fact — rather than promising a deadline for the row in front of
 * the reader. They render on the marketing strip, in the docs, and as a generic lede that names no
 * item and carries no clock.
 *
 * ⚠️ `submit_next_body` WAS ON THAT LIST TOO, AND IT WAS WRONG FOR THE SAME REASON
 * `solution_detail_wins_*` was. It read "Your challenge … if it lands in the top 5 by Thursday
 * 18:00 …" and renders inside the `<aside>` of `/submit`, in a `.notice teal` immediately below
 * the LIVE PREVIEW CARD of the reader's own challenge — their title, their domain, their tags,
 * their `0 ▲`. Second person, scoped to one item, naming the same clock two retired keys were
 * deleted for. Worse, this file used to ASSERT the exemption (`expect(WATCHED).not.toContain(...)`),
 * so the guard was configured never to catch it and a fixer would have had to delete an assertion
 * claiming the exemption was right. It is watched now.
 *
 * ⚠️ `solution_detail_wins_*` USED TO BE ON THAT EXEMPTION LIST, AND THE EXEMPTION WAS WRONG.
 * The rationale given was "product cadence" — but the exemption is not decided by what a sentence
 * is ABOUT, it is decided by WHERE IT RENDERS. These keys render in the right-hand rail of
 * `/solutions/[id]`, directly beneath that solution's own vote button, under a heading a reader
 * scopes to the solution they are looking at. That is a per-item claim whatever it says, which is
 * how `"…the most votes on Thursday 18:00…"` and `"17 days"` survived here for as long as they did.
 * The family is watched now. `solution_detail_wins_days` is gone entirely (see RETIRED_KEYS).
 */
const CLAIM_FAMILIES = [
	'submit_next_',
	'challenge_state_',
	'challenge_vote_note_',
	'challenge_period_week',
	'challenge_period_quarter',
	'challenge_build_blocked_period',
	'challenge_detail_status_',
	'challenge_detail_vote_note_',
	'challenge_detail_lc_',
	// ⛔ ONE PREFIX TO THE LEFT OF `challenge_detail_lc_`, AND IT ESCAPED THIS GUARD.
	// The lifecycle rework added six keys; two kept the `challenge_detail_lc_` prefix above and were
	// covered automatically — exactly as this file's header promises. The other four are the sr-only
	// STATE WORDS, and they were named `challenge_lc_state_*`. An adversarial review proved the gap
	// with a matched pair: injecting "…about 3 weeks from Thursday 18:00" into
	// `challenge_lc_state_pending` left the guard 21/21 GREEN, while the identical injection into
	// `challenge_detail_lc_winner_sub_shipped` reddened it.
	// These render inside the same four `<li>` as the covered keys — per-item copy by the WHERE rule
	// this file exists to enforce, not by what they are about.
	'challenge_lc_state_',
	'mkt_status_',
	'solution_state_',
	'solution_vote_note_',
	'solution_detail_status_',
	'solution_detail_vote_note_',
	'solution_detail_wins_'
] as const;

/**
 * DERIVATION 2 — whatever the two state modules actually resolve. They are the single funnel every
 * per-item status pill and vote note now passes through, so their `m.*` references ARE the render
 * surface. Catches a key that escapes the families above (a borrowed `error_*`, say) without anyone
 * updating a list.
 *
 * Comments are stripped first: this file's own siblings quote `m.week_word()` inside prose to
 * explain why fragment-gluing is banned, and a scraper that believed it would demand a key that
 * deliberately does not exist.
 */
function keysUsedByStateModules(): string[] {
	// ⛔ `challenge-lifecycle.ts` IS THE THIRD FUNNEL AND MUST BE LISTED. It is a SIBLING of
	// `challenge-state.ts` (see its header), so it is not reached transitively by scraping that file,
	// and its `lifecycleWinnerSubLabel` / `lifecycleStateLabel` are the same shape of per-item claim:
	// resolved per row, rendered inside one item's card. Omitting it is how the four state-word keys
	// escaped BOTH derivations at once — the prefix list and this scrape.
	const files = [
		'lib/challenges/challenge-state.ts',
		'lib/challenges/challenge-lifecycle.ts',
		'lib/solutions/solution-state.ts'
	];
	const found = new Set<string>();
	for (const file of files) {
		const code = readFileSync(resolve(src, file), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		for (const match of code.matchAll(/\bm\.([a-z0-9_]+)\s*\(/g)) found.add(match[1]!);
	}
	return [...found];
}

function catalog(locale: string): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8')) as Record<string, unknown>;
}

const EN = catalog('en');

/** The union of both derivations, resolved against the real catalog. */
const WATCHED = [
	...new Set([
		...Object.keys(EN).filter((k) => CLAIM_FAMILIES.some((f) => k.startsWith(f))),
		...keysUsedByStateModules()
	])
].sort();

/**
 * Time-of-day, in the forms these eight locales actually write it.
 *
 * ⛔ NOT A WEEKDAY WORD LIST — `do`/`Do`/`jeu.`/`czw.`/`الخميس`/`ה׳` share nothing, and a table of
 * them would be one more hand-maintained thing to drift. The clock is what makes a weekday into a
 * deadline, and it is close to locale-independent once you cover the separators each language uses.
 *
 * A REAL deadline reaches these screens as the `{time}` placeholder, computed from
 * `marketplace_cycles` — a placeholder contains no digits, so the honest path passes by
 * construction and the invented one cannot.
 */
const TIME_FORMS: { name: string; re: RegExp }[] = [
	// 18:00 — and the Arabic-Indic digits ar/he catalogs may use.
	{ name: '18:00', re: /[\d٠-٩]{1,2}\s*:\s*[\d٠-٩]{2}/ },
	// 18.00 / 18,00 — the nl + de house style, and what slipped past the first version of this file.
	{ name: '18.00 / 18,00', re: /\b\d{1,2}[.,]\d{2}\b/ },
	// 18h00 / 18 h — fr.
	{ name: '18h00', re: /\b\d{1,2}\s?h(\s?\d{2})?\b/i },
	// 6pm / 6 p.m.
	{ name: '6pm', re: /\b\d{1,2}\s?[ap]\.?\s?m\.?\b/i },
	// 18 uur / 18 Uhr / 18 hs / godz. 18 — the spelled-out hour marker.
	{ name: '18 uur / Uhr / hs / godz', re: /\b\d{1,2}\s?(uur|uhr|hs|godz)\b/i },
	{ name: 'godz. 18', re: /\bgodz\.?\s?\d{1,2}\b/i },
	DURATION_FORM()
];

/**
 * ⚠️ WHAT THIS PATTERN DOES AND DOES NOT COVER — read before widening it.
 *
 * It matches NOTHING in the watched set today: no watched key contains a digit any more. That is
 * intentional — a tripwire for a future edit, not a description of current copy — but it means its
 * FALSE-POSITIVE behaviour has never met live copy.
 *
 * It DOES fire on truthful time-WINDOW labels ("Last 7 days", "Laatste 30 dagen",
 * "Letzte 30 Tage"). None is watched today, but the watched set is DERIVED from naming families,
 * so the day someone writes a legitimate "over the last 7 days" under `challenge_detail_lc_*` or
 * `solution_state_*`, this reddens main on a TRUE sentence. If that happens, move the window label
 * out of the claim family rather than weakening this.
 *
 * It does NOT catch abbreviations or spelled-out forms — `~3wk`, `21d`, `P3W`, `17 werkdagen`,
 * `drie weken`, `three weeks`. Chasing those produces a regex that false-positives on ordinary
 * prose, which is worse than the hole. The backstop for them is the one that caught the two this
 * file exists for: someone reading the screen.
 */
/**
 * A DURATION — "~3 weeks", "17 days" — in the forms these eight locales write it.
 *
 * ⛔ WHY THIS BELONGS IN THE SAME FAMILY AS THE CLOCK, AND NOT IN A SEPARATE, SOFTER TEST. The two
 * defects are one defect. "Voting closes Thursday 18:00" and "~3 weeks (typical)" are both a number
 * nothing computes, stated about the item on screen. The catalog carried BOTH forms of the same
 * quantity at once — `challenge_detail_lc_winner_sub` said 3 weeks, `solution_detail_wins_days` said
 * 17 days, one click apart, for how long a winner takes to reach production. A guard that catches
 * only the colon form leaves the second half of its own subject matter uncovered.
 *
 * SHAPE: a digit, then the unit word, with `(?!\p{L})` closing the tail so `"3 mes"` cannot match
 * inside `"3 mensajes"`. `\b` is deliberately NOT used at the tail — it is meaningless against
 * Arabic and Hebrew letters, which is half of the catalog set.
 *
 * ⛔ THE HOUR UNITS ARE ABSENT ON PURPOSE, not by oversight: `uur` / `Uhr` / `godz` / `hs` / `h` are
 * already covered above, and duplicating them here would give two patterns the same job and make a
 * failure message ambiguous about which rule fired.
 *
 * A REAL duration still has a route to the reader: `duration()` in $lib/utils/format formats
 * `avgTimeToLiveMs` off the wire, and lands in the DOM, never in a catalog string.
 */
function DURATION_FORM(): { name: string; re: RegExp } {
	const UNITS = [
		// en
		'days?', 'weeks?', 'months?',
		// nl
		'dag(?:en)?', 'we(?:e)?k(?:en)?', 'maand(?:en)?',
		// de
		'tage?n?', 'wochen?', 'monate?n?',
		// fr
		'jours?', 'semaines?', 'mois',
		// es
		'd[ií]as?', 'semanas?', 'mes(?:es)?',
		// pl
		'dni', 'dzie[nń]', 'dnia', 'tygodni(?:e|a)?', 'tydzie[nń]', 'miesi[ąa]c(?:e|y)?',
		// ar
		'يوم(?:ًا|ا)?', 'أيام', 'أسبوع(?:ًا|ا)?', 'أسابيع', 'شهر(?:ًا|ا)?', 'أشهر', 'شهور',
		// he
		'ימים', 'יום', 'שבועות', 'שבוע', 'חודשים', 'חודש'
	].join('|');
	return {
		name: '~3 weeks / 17 days',
		// `[\d٠-٩]` mirrors the clock patterns: the ar/he catalogs may use Arabic-Indic digits.
		re: new RegExp(String.raw`[\d٠-٩]\s*(?:${UNITS})(?!\p{L})`, 'iu')
	};
}

/** Keys retired because they carried an invented number. They must not come back. */
const RETIRED_KEYS = [
	// The week-only period copy (0107: a period is a week, month or year). Replaced by the by-kind
	// `challenge_period_week` + `challenge_{vote_note_earlier,build_blocked}_period`.
	'challenge_week_badge',
	'challenge_vote_note_earlier_week',
	'challenge_build_blocked_week',
	'challenge_detail_status_voting', // "In voting · closes Thu 18:00"
	'challenge_detail_status_solution_phase',
	'challenge_detail_status_closed',
	'solution_detail_vote_note_open', // "Voting closes Thursday 18:00."
	// "17 days" — a hard-coded average time from win → live, in a `<b>` glued onto the end of
	// `solution_detail_wins_body_pre`. `/pipeline` computes the real quantity (`avgTimeToLiveMs`),
	// behind `requireSuperAdmin`, and it is a fleet-wide average that does not belong under a
	// per-solution heading anyway — see the comment at the render site.
	'solution_detail_wins_days',
	// The `_pre` half of the same sentence. Retired rather than reworded because the name only made
	// sense as "the part before the bold number": with the number gone, a `_pre` with no sibling is
	// an invitation to glue a new fragment on. Replaced by the whole sentence `solution_detail_wins_body`.
	'solution_detail_wins_body_pre'
] as const;

describe('vote-surface copy', () => {
	it('watches a non-trivial set, derived rather than hand-listed', () => {
		// A refactor that renames the families would otherwise silently empty this file and stay green.
		expect(WATCHED.length).toBeGreaterThan(20);
		// Both derivations must actually contribute: families reach keys the modules never import
		// (the lifecycle subtitles are rendered inline in Svelte — hole #2 above), and the modules
		// reach keys outside the families.
		expect(WATCHED).toContain('challenge_detail_lc_solution_phase_sub');
		expect(WATCHED).toContain('challenge_detail_lc_in_voting_sub');
		expect(WATCHED).toContain('challenge_period_week');
		// ⚠️ RENAMED, NOT DROPPED. This was `solution_vote_note_parent_unavailable` — the "your view
		// of the parent challenge is what blocks the vote" copy, retired along with the rule itself
		// when a solution's votability moved onto its OWN competing cycle. Same family, same
		// derivation, same guard; only the fact it states changed.
		expect(WATCHED).toContain('solution_vote_note_votability_unknown');
		expect(WATCHED).toContain('solution_vote_note_cycle_closed');
		// The "What wins" rail is IN, reversing an exemption that was justified as "product cadence"
		// and was wrong: the sentence renders under this solution's own vote button, so its scope is
		// the item, not the company's week. See the note on CLAIM_FAMILIES.
		expect(WATCHED).toContain('solution_detail_wins_body');
		// The submit funnel's "what happens next" is IN, reversing the same wrong exemption: it
		// renders directly under the reader's own live preview card and opens in the second person.
		expect(WATCHED).toContain('submit_next_body');
		// …and the genuinely-cadence copy must stay OUT, or the guard starts demanding rewrites of
		// sentences that are not wrong. `challenges_lede` names no item and carries no clock.
		expect(WATCHED).not.toContain('challenges_lede');
	});

	for (const locale of LOCALES) {
		const messages = catalog(locale);

		it(`${locale}: no per-item claim writes a time of day, in any notation`, () => {
			for (const key of WATCHED) {
				const value = messages[key];
				// A missing key is a failure too: silently dropping one would empty this guard.
				expect(typeof value, `${key} is missing from ${locale}.json`).toBe('string');
				for (const form of TIME_FORMS) {
					expect(
						form.re.test(value as string),
						`${key} in ${locale}.json writes a time of day (${form.name} form): ${String(value)}`
					).toBe(false);
				}
			}
		});

		it(`${locale}: the retired deadline keys stay retired`, () => {
			for (const key of RETIRED_KEYS) {
				expect(key in messages, `${key} is back in ${locale}.json`).toBe(false);
			}
		});
	}

	it('the countdown messages carry a placeholder, so a real deadline still has somewhere to go', () => {
		// The point is not "no times ever" — it is "no time the backend did not produce". These are how
		// a genuine `votingEndsAt` / `solutionEndsAt` / `closesAt` reaches the reader.
		for (const key of [
			'challenge_state_voting_countdown',
			'challenge_state_solution_countdown',
			'challenge_vote_note_countdown',
			'solution_state_voting_countdown',
			'solution_vote_note_countdown'
		]) {
			expect(EN[key], key).toContain('{time}');
		}
	});

	it('the patterns actually match the fictions they were written for', () => {
		// ⛔ A guard whose regexes match nothing passes forever. These are the exact strings that got
		// past earlier versions of this file, plus the originals it was written to stop.
		const shouldMatch = [
			'Voting closes Thursday 18.00 uur.', // the dotted nl/de form — passed before
			'Voting closed Thu 6pm', // the am/pm form — passed before
			'Fri 18:00 (if top-5)', // matched, but its key was unwatched — passed before
			'In voting · closes Thu 18:00',
			'Stemming · sluit do 18:00',
			'De stemming sluit donderdag 18.00 uur.',
			'Die Abstimmung endet Donnerstag 18 Uhr.',
			'Le vote se clôture jeudi à 18h00.',
			'Głosowanie zamyka się w czwartek o godz. 18.'
		];
		for (const s of shouldMatch) {
			expect(TIME_FORMS.some((f) => f.re.test(s)), `no pattern caught: ${s}`).toBe(true);
		}
		// …and do not fire on the honest copy, or the guard becomes something people delete.
		const shouldNotMatch = [
			'In voting · closes in {time}',
			'Voting closes in {time}.',
			'Week {week} · {year}',
			'Colleagues vote on this challenge',
			'IT reviews the winning solution and releases it',
			'Votes rank the solutions for this challenge.',
			'Collega’s bouwen er oplossingen voor'
		];
		for (const s of shouldNotMatch) {
			expect(TIME_FORMS.some((f) => f.re.test(s)), `false positive on: ${s}`).toBe(false);
		}
	});

	it('the duration form catches all three of the fabricated-number strings this change removed', () => {
		// ⛔ THE PROOF THAT WIDENING THE FAMILY WAS NOT COSMETIC. `'~3 weeks (typical)'` was sitting
		// in the `shouldNotMatch` list above until this change — the guard was explicitly pinned to
		// ignore a per-item claim that no code path produced. All three strings below rendered on
		// screen, in eight locales, in two places that disagreed with each other about the same
		// quantity.
		const REMOVED = [
			// #3 — challenge_detail_lc_winner_sub, the lifecycle rail's third step.
			'~3 weeks (typical)',
			'~3 weken (gebruikelijk)',
			'~3 Wochen (üblich)',
			'~3 semaines (typique)',
			'~3 semanas (habitual)',
			'~3 tygodnie (typowo)',
			'~3 أسابيع (نموذجيًا)',
			'~3 שבועות (טיפוסי)',
			// #2 — solution_detail_wins_days, the bold number in the "What wins" rail.
			'17 days',
			'17 dagen',
			'17 Tage',
			'17 jours',
			'17 días',
			'17 dni',
			'17 يومًا',
			'17 ימים',
			// #2 again — the clock half of the same sentence, which TIME_FORMS already caught. Kept
			// here so the third string is proven by the same list, not assumed.
			'The solution with the most votes by Thursday 18:00 enters IT’s production pipeline.',
			'De oplossing met de meeste stemmen op donderdag 18:00 gaat de productiepijplijn van IT in.'
		];
		for (const s of REMOVED) {
			expect(TIME_FORMS.some((f) => f.re.test(s)), `no pattern caught: ${s}`).toBe(true);
		}

		// …and the replacements the eight catalogs now carry pass, or the guard would have forced a
		// rewrite that says nothing. These are the exact live values.
		const REPLACEMENTS = [
			'IT reviews the winning solution and releases it',
			'IT beoordeelt de winnende oplossing en zet die live',
			'Die IT prüft die Gewinnerlösung und stellt sie live',
			"L'informatique examine la solution gagnante et la met en ligne",
			'TI revisa la solución ganadora y la publica',
			'Dział IT sprawdza zwycięskie rozwiązanie i wdraża je',
			'تراجع تقنية المعلومات الحل الفائز ثم تنشره',
			'צוות ה-IT בודק את הפתרון הזוכה ומעלה אותו לאוויר'
		];
		for (const s of REPLACEMENTS) {
			expect(TIME_FORMS.some((f) => f.re.test(s)), `false positive on: ${s}`).toBe(false);
		}
	});

	it('the duration pattern does not fire on a number that is not a duration', () => {
		// The unit word is what makes a digit a duration claim. Vote counts, week numbers, ranks and
		// percentages are facts the server computes and the reader can check, and none of them may
		// be collateral damage here.
		const duration = TIME_FORMS.find((f) => f.name === '~3 weeks / 17 days')!;
		for (const s of [
			'Week 23 · 2026',
			'1.240 stemmen',
			'#3 van 40',
			'12 oplossingen',
			'3 mensajes nuevos', // `mes` inside a longer word — the reason for the (?!\p{L}) tail
			'{count} solutions'
		]) {
			expect(duration.re.test(s), `false positive on: ${s}`).toBe(false);
		}
	});
});
