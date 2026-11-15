// src/lib/i18n/timeago-abbreviation.test.ts — the `timeago_*` family renders a bare count next to a
// unit with NO plural categories. That is only safe while every locale's unit is an ABBREVIATION,
// because abbreviations do not inflect. This file pins that precondition.
//
// ⛔ THE DEFECT THAT MOTIVATED IT. `pl.json` shipped `timeago_day: "{count}dni temu"`. `dni` is not
// an abbreviation — it is the plural of `dzień` — so at `count = 1` a Polish reader was shown
// "1dni temu", i.e. "1 days ago". `timeago_day_hour` carried the same word and is reachable at
// `days = 1` (any interval from 24 h to 47 h with a remainder), so both were live in production.
// Seven locales abbreviated correctly (`s`, `min`, `h`, `T`, `j`, `ي`, `ש׳`); Polish alone spelled a
// unit out, and `format.ts` carried a comment asserting the family was safe *because* every locale
// abbreviates. The comment was load-bearing and false, which is why nobody re-checked it.
//
// ⚠️ WHAT THIS TEST IS, STATED HONESTLY: a CHANGE DETECTOR, not a correctness oracle. It cannot
// tell `dni` (inflects — wrong) from `godz` (a real abbreviation — fine); they are both short
// lowercase Latin tokens, so no length or shape rule separates them. Only a person who reads the
// language can. What this file guarantees is that such a change cannot land SILENTLY: editing any
// value below reds the suite with the reason attached, and whoever updates the pin has to re-assert
// "this unit does not inflect" for the locale they touched. That is the whole intent — the original
// bug was not a bad decision, it was a change nobody was asked about.
//
// ⛔ DO NOT "FIX" A RED HERE BY PASTING THE NEW VALUE IN. Read the failure message first: if the new
// value spells a unit out, the catalog is what is wrong, not this table.
import { describe, it, expect } from 'vitest';
import { locales } from '$lib/paraglide/runtime';
import en from '../../../messages/en.json';
import nl from '../../../messages/nl.json';
import pl from '../../../messages/pl.json';
import fr from '../../../messages/fr.json';
import es from '../../../messages/es.json';
import de from '../../../messages/de.json';
import ar from '../../../messages/ar.json';
import he from '../../../messages/he.json';

const CATALOGS: Record<string, Record<string, unknown>> = { en, nl, pl, fr, es, de, ar, he };

const KEYS = [
	'timeago_sec',
	'timeago_min',
	'timeago_hour',
	'timeago_hour_min',
	'timeago_day',
	'timeago_day_hour'
] as const;

/**
 * The exact rendered template for every `timeago_*` message in every locale.
 *
 * Each unit token here has been checked to be a non-inflecting abbreviation in its language:
 * en `s/m/h/d` · nl `s/m/u/d` · pl `s/m/godz/dn.` · fr `s/min/h/j` · es `s/min/h/d` ·
 * de `s/min/h/T` · ar `ث/د/س/ي` · he `ש׳/ד׳/י׳`.
 */
const PINNED: Record<string, Record<string, string>> = {
	en: {
		timeago_sec: '{count}s ago',
		timeago_min: '{count}m ago',
		timeago_hour: '{count}h ago',
		timeago_hour_min: '{hours}h {mins}m ago',
		timeago_day: '{count}d ago',
		timeago_day_hour: '{days}d {hours}h ago'
	},
	nl: {
		timeago_sec: '{count}s geleden',
		timeago_min: '{count}m geleden',
		timeago_hour: '{count}u geleden',
		timeago_hour_min: '{hours}u {mins}m geleden',
		timeago_day: '{count}d geleden',
		timeago_day_hour: '{days}d {hours}u geleden'
	},
	pl: {
		timeago_sec: '{count}s temu',
		timeago_min: '{count}m temu',
		timeago_hour: '{count}godz temu',
		timeago_hour_min: '{hours}godz {mins}m temu',
		// ⛔ `dn.`, NOT `dni`. See the header — `dni` inflects and renders "1dni temu" at count 1.
		timeago_day: '{count}dn. temu',
		timeago_day_hour: '{days}dn. {hours}godz temu'
	},
	fr: {
		timeago_sec: 'il y a {count}s',
		timeago_min: 'il y a {count}min',
		timeago_hour: 'il y a {count}h',
		timeago_hour_min: 'il y a {hours}h {mins}min',
		timeago_day: 'il y a {count}j',
		timeago_day_hour: 'il y a {days}j {hours}h'
	},
	es: {
		timeago_sec: 'hace {count}s',
		timeago_min: 'hace {count}min',
		timeago_hour: 'hace {count}h',
		timeago_hour_min: 'hace {hours}h {mins}min',
		timeago_day: 'hace {count}d',
		timeago_day_hour: 'hace {days}d {hours}h'
	},
	de: {
		timeago_sec: 'vor {count}s',
		timeago_min: 'vor {count}min',
		timeago_hour: 'vor {count}h',
		timeago_hour_min: 'vor {hours}h {mins}min',
		timeago_day: 'vor {count}T',
		timeago_day_hour: 'vor {days}T {hours}h'
	},
	ar: {
		timeago_sec: 'قبل {count}ث',
		timeago_min: 'قبل {count}د',
		timeago_hour: 'قبل {count}س',
		timeago_hour_min: 'قبل {hours}س {mins}د',
		timeago_day: 'قبل {count}ي',
		timeago_day_hour: 'قبل {days}ي {hours}س'
	},
	he: {
		// ⛔ `שנ׳` (שניות, seconds), NOT `ש׳` — `ש׳` is the abbreviation for שעות (hours) and is used
		// by `timeago_hour` below. Both keys shipped `לפני {count}ש׳`, byte-identical, so "לפני 5ש׳"
		// meant either 5 seconds or 5 hours and a Hebrew reader could not tell which. See the
		// distinctness test at the foot of this file, which is what now makes that unshippable.
		timeago_sec: 'לפני {count}שנ׳',
		timeago_min: 'לפני {count}ד׳',
		timeago_hour: 'לפני {count}ש׳',
		timeago_hour_min: 'לפני {hours}ש׳ {mins}ד׳',
		timeago_day: 'לפני {count}י׳',
		timeago_day_hour: 'לפני {days}י׳ {hours}ש׳'
	}
};

const WHY =
	'timeago_* has NO plural categories, so this unit must be an abbreviation that does not ' +
	'inflect. If the new value spells the unit out (the `dni` bug), fix the catalog, not this pin. ' +
	'If it is genuinely a non-inflecting abbreviation, update the pin and say so in the commit.';

describe('timeago_* units stay non-inflecting abbreviations', () => {
	// The pin itself. One assertion per locale/key so a failure names exactly which one moved.
	for (const locale of Object.keys(PINNED)) {
		for (const key of KEYS) {
			it(`${locale}.${key} is unchanged`, () => {
				expect(CATALOGS[locale][key], `${locale}.${key} changed. ${WHY}`).toBe(
					PINNED[locale][key]
				);
			});
		}
	}

	// ⛔ Completeness, so a locale cannot be added and quietly skip the pin above. This is the guard
	// that makes the table a rule rather than a sample: a ninth locale reds here until its units
	// have been read by someone who speaks it.
	it('every shipped locale is pinned', () => {
		expect(
			Object.keys(PINNED).sort(),
			'a locale ships that this pin does not cover — its timeago units are unreviewed'
		).toEqual([...(locales as readonly string[])].sort());
	});

	// And that the key list itself has not grown: a new timeago_* message inherits the same
	// no-plural constraint and must join the table.
	it('every timeago_* key in en.json is pinned', () => {
		const inCatalog = Object.keys(en).filter((k) => k.startsWith('timeago_'));
		expect(inCatalog.sort(), 'a timeago_* message exists that this pin does not cover').toEqual(
			[...KEYS].sort()
		);
	});
});

// ⛔ THE REAL INVARIANT, as opposed to the change-detector above. Four different magnitudes of time
// must not render the same string in the same language.
//
// Hebrew shipped `timeago_sec` and `timeago_hour` BOTH as `לפני {count}ש׳`, byte-identical, because
// שניות (seconds) and שעות (hours) share the abbreviation `ש׳`. "לפני 5ש׳" therefore meant either
// five seconds or five hours, with nothing in the string to tell them apart — on a surface whose
// entire job is to say how long ago something happened. It was invisible to every guard in the
// suite: the key sets matched, the placeholders matched, the values were "translated" and differed
// from English. The catalogs were complete AND wrong.
//
// ⚠️ THIS IS THE GUARD THE PIN CANNOT BE. A pin says "this value changed"; it cannot say "these two
// values collided", because the collision is a relationship BETWEEN keys and each value is
// individually plausible. Hebrew is a primary market, so a unit ambiguity here is a product defect,
// not a polish item.
describe('time units are mutually distinguishable within each locale', () => {
	// The four single-unit messages. The composite `*_hour_min` / `*_day_hour` forms are excluded:
	// they legitimately reuse these same abbreviations and are distinguished by having two numbers.
	const UNIT_KEYS = ['timeago_sec', 'timeago_min', 'timeago_hour', 'timeago_day'] as const;

	for (const locale of Object.keys(PINNED)) {
		it(`${locale} renders four distinct units`, () => {
			const rendered = UNIT_KEYS.map((k) => String(CATALOGS[locale][k]));
			const unique = new Set(rendered);
			expect(
				unique.size,
				`${locale}: two time units render identically — ` +
					UNIT_KEYS.map((k, i) => `${k}=${rendered[i]}`).join(' · ') +
					'. A reader cannot tell which magnitude they are being shown.'
			).toBe(UNIT_KEYS.length);
		});
	}
});
