// src/lib/i18n/nl-runs-untranslated.test.ts — "{count} runs" was English on three Dutch screens.
//
// ⛔ THE THREE KEYS, AND WHY THEY ARE NAMED ONE BY ONE RATHER THAN DERIVED. `blocks_used_count`,
// `blockedit_usage_consumers_runs` and `blockedit_usage_trend_runs` all read `"{count} runs"` in
// `nl.json` — byte-identical to `en.json` — while `de` has "Läufe", `fr` "exécutions", `es`
// "ejecuciones" and `pl` "uruchomień". They render on `/blocks` (`+page.svelte:304`), on
// `/block-edit` (`:1363`) and in `BlockUsageTrend.svelte:74`.
//
// ⛔⛔ AND WHY THIS FILE MUST NOT BECOME A SWEEP — the most important thing on this page. A sweep
// for "keys where nl == en while ≥3 of de/fr/es/pl differ" finds 56, and 53 of them are CORRECT
// DUTCH: Help, Governance, Model, HR, Open, Tags, Data, AI, Platform, Datasets, Schema, Type,
// Sandbox, Onboarding, Label, Connector, Logs, Metadata, Live, console, staging, Code review,
// Single sign-on… Dutch BORROWS those words; the other four Romance/Germanic/Slavic catalogs
// translating them says nothing about Dutch. Generalising this test into that sweep would fail on
// 53 correct strings and pressure a future author into "fixing" them, which would make the Dutch
// UI worse, not better. The measured decision is: these THREE, by name, and nothing else.
//
// ⛔⛔ AND WHY THE SCOPE IS "THE FAMILY", NOT "THE THREE COUNTERS" — THE MISTAKE THIS FILE MADE
// FIRST TIME. Translating only the three `{count} runs` keys left
// `BlockUsageTrend.svelte` contradicting ITSELF six lines apart: `:50` rendered the heading
// `blockedit_usage_trend_title` → "Runs · laatste 30 dagen" directly above `:74`'s
// "12 uitvoeringen", and `:53`'s aria-label said "blok-runs". A reader sees one component using
// two words for one noun and reads it as a bug — which it was, and one we introduced.
//
// That is NOT a retreat from the paragraph above. The 53 lookalikes are words Dutch genuinely
// borrows ACROSS THE PRODUCT; this is one component disagreeing with itself in adjacent lines.
// The dividing line is the SURFACE, so the assertion below is scoped to the surface: every
// `blockedit_usage_*` / `blocks_used_*` key, which is exactly the two panels and the /blocks
// column, and nothing else in the catalog.
//
// So this file pins a FACT about one screen's vocabulary, not a rule about a catalog. It is
// deliberately not clever.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (locale: string) =>
	JSON.parse(readFileSync(`${root}/messages/${locale}.json`, 'utf8')) as Record<string, string>;

/** The three counters — the keys whose `nl` was byte-identical to `en`. */
const KEYS = [
	'blocks_used_count',
	'blockedit_usage_consumers_runs',
	'blockedit_usage_trend_runs'
] as const;

/**
 * The four NEIGHBOURS on the same two panels, whose `nl` said "runs" in Dutch prose. Translating
 * the counters without these is what split the terminology inside one component.
 */
const NEIGHBOURS = [
	'blockedit_usage_trend_title',
	'blockedit_usage_trend_aria',
	'blockedit_usage_trend_none',
	'blockedit_usage_consumers_empty'
] as const;

describe('the run-count label is Dutch on the Dutch screens', () => {
	const nl = load('nl');
	const en = load('en');

	it('the fixture is real — en still says "runs", so the comparison has a subject', () => {
		// NON-VACUITY: if `en` were reworded, "nl differs from en" would be satisfied by the rewording
		// alone and this file would stop testing anything about Dutch.
		for (const key of KEYS) {
			expect(en[key], `${key} missing from en.json`).toBeDefined();
			expect(en[key], `${key}: en.json no longer reads "{count} runs"`).toBe('{count} runs');
		}
	});

	it('⛔ nl translates it, and keeps the {count} placeholder', () => {
		for (const key of KEYS) {
			expect(nl[key], `${key} missing from nl.json`).toBeDefined();
			expect(nl[key], `${key}: nl.json still ships the English "{count} runs"`).not.toBe(
				en[key]
			);
			// The placeholder must survive the translation — `placeholder-parity.test.ts` owns this
			// property catalog-wide, but a local assertion names the key when it breaks here.
			expect(nl[key], `${key}: nl.json lost the {count} placeholder`).toContain('{count}');
			expect(nl[key], `${key}: nl.json still contains the English noun`).not.toContain('runs');
		}
	});

	it('⛔ the WHOLE usage family speaks one language — no "Runs" heading over "12 uitvoeringen"', () => {
		// ⛔ DERIVED, NOT LISTED, and this is the one place in this file where that is right. A
		// hand-written list is satisfied by whatever was on screen the day it was typed; the defect
		// here is a NEW key joining these panels still saying "runs", which only a derived sweep
		// sees. The derivation is bounded to the two panels' own key prefixes, so it cannot drift
		// into the 53-lookalike sweep the header rules out.
		const family = Object.keys(en).filter(
			(k) => k.startsWith('blockedit_usage') || k.startsWith('blocks_used')
		);
		// NON-VACUITY: the prefixes must actually select the panels. Nine keys today.
		expect(family.length, 'the usage-panel key prefixes select nothing').toBeGreaterThanOrEqual(9);
		expect(family, 'the sweep does not cover the keys this file names').toEqual(
			expect.arrayContaining([...KEYS, ...NEIGHBOURS])
		);

		const english = family.filter((k) => /\bruns?\b/i.test(nl[k]!));
		expect(
			english,
			'these usage-panel keys still say "run(s)" in Dutch, so the panel uses two words for ' +
				'one noun — see BlockUsageTrend.svelte :50 vs :74'
		).toEqual([]);
	});

	it('the four neighbours are translated, and did not lose their meaning', () => {
		// Named individually as well, so a red says WHICH key rather than only that the sweep failed.
		for (const key of NEIGHBOURS) {
			expect(nl[key], `${key} missing from nl.json`).toBeDefined();
			expect(nl[key], `${key}: still English "runs"`).not.toMatch(/\bruns?\b/i);
			// ⚠️ LOWERCASED — `blockedit_usage_trend_title` is a HEADING and reads "Uitvoeringen · …".
			// A case-sensitive `toContain('uitvoering')` fails on it, which it did on first run.
			expect(nl[key]!.toLowerCase(), `${key}: does not use the agreed noun`).toContain(
				'uitvoering'
			);
			// The English still says "run(s)" — otherwise "nl no longer says runs" is vacuous.
			expect(en[key], `${key}: en.json no longer says "run"`).toMatch(/\bruns?\b/i);
		}
	});

	it('and the other five catalogs are untouched by this change', () => {
		// Scope, asserted. This edit was to `nl.json` alone; the four that already translated the
		// noun must still say what they said, so a careless sweep across catalogs reds here.
		const expected: Record<string, string> = {
			de: '{count} Läufe',
			fr: '{count} exécutions',
			es: '{count} ejecuciones',
			pl: '{count} uruchomień'
		};
		for (const [locale, value] of Object.entries(expected)) {
			const cat = load(locale);
			for (const key of KEYS) expect(cat[key], `${locale}.${key}`).toBe(value);
		}
	});
});
