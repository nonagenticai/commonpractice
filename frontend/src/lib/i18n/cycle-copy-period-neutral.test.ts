// src/lib/i18n/cycle-copy-period-neutral.test.ts — cycle copy names no WEEK (0107).
//
// The voting cycle runs weekly, monthly or yearly (backend `cycle.cadence`). Every member-facing
// string about the cycle — its phases, the winner, the cadence section, the docs schedule and the
// errors a closed round produces — must therefore read true under all three. "Week closed · winner
// announced" on a monthly cycle is a false statement, not a style slip.
//
// Exempt on purpose: `cadence_title_month` / `_year` (they render only for that kind),
// `policy_option_cadence_week` ("Weekly" is the option's own name), and placeholders such as
// `{week}` — a placeholder carries the period's real key, and is stripped before matching.
// `challenge_period_week` names a WEEK period by design (it renders only for kind = week); the
// earlier-round notes it is spliced into (`challenge_*_period`) are watched below. The legacy
// `challenge_week_badge` / `challenge_{vote_note_earlier,build_blocked}_week` keys are deleted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

/** One word for "week" per locale (stems, so plurals and inflections match too). */
const WEEK: Record<(typeof LOCALES)[number], RegExp> = {
	en: /\bweek/i,
	nl: /week/i,
	pl: /tydzie|tygodni/i,
	fr: /semaine|hebdo/i,
	es: /semana/i,
	de: /woche/i,
	ar: /أسبوع|اسبوع/,
	he: /שבוע/
};

/** The cycle-copy families, by key prefix, plus single keys outside any family. */
const PREFIXES = ['cycle_', 'cadence_', 'home_cadence_', 'docs_cadence_', 'mkt_cadence_', 'winner_', 'error_challenge_'];
const KEYS = [
	'nav_winner',
	'home_hero_title',
	'challenges_lede',
	'challenges_empty_open',
	'challenge_state_earlier_week',
	'challenge_vote_note_earlier_period',
	'challenge_build_blocked_period',
	'solution_vote_note_cycle_closed'
];

function catalog(locale: string): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(process.cwd(), 'messages', `${locale}.json`), 'utf8'));
}

function watched(cat: Record<string, unknown>): [string, string][] {
	return Object.entries(cat).filter(
		(e): e is [string, string] =>
			typeof e[1] === 'string' && (KEYS.includes(e[0]) || PREFIXES.some((p) => e[0].startsWith(p)))
	);
}

describe('cycle copy is period-neutral', () => {
	it('the en catalog is non-empty and the watched set is non-trivial (or this file proves nothing)', () => {
		const en = catalog('en');
		expect(Object.keys(en).length).toBeGreaterThan(1000);
		expect(watched(en).length).toBeGreaterThanOrEqual(30);
		for (const k of KEYS) expect(Object.keys(en), k).toContain(k);
	});

	for (const locale of LOCALES) {
		it(`${locale}: no cycle string says "week"`, () => {
			const offenders = watched(catalog(locale))
				.filter(([, v]) => WEEK[locale].test(v.replace(/\{[^}]*\}/g, '')))
				.map(([k, v]) => `${k}: ${v}`);
			expect(offenders).toEqual([]);
		});
	}
});
