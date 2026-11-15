// src/lib/i18n/icu-number-params.test.ts — the numbers INSIDE an ICU message are grouped in the
// reader's language, and the plural category is still selected from the raw number.
//
// ⛔ THE DEFECT THIS FILE PINS. Paraglide compiles a message parameter RAW: `{count} events` became
// `` `${i?.count} events` ``, with no `Intl` anywhere in the emitted function. The `num()` fix
// (PR #247) reached ~35 DIRECT-render sites and never reached this path, so a Dutch reader saw
// "10000 gebeurtenissen" beside a "10.000" in the very same table — `routes/connectors/+page.svelte`
// shipped both spellings of the same figure in ONE file.
//
// ⛔⛔ AND WHY THE FIX FOR THESE TEN KEYS IS NOT `num()`. These messages are inlang VARIANT
// messages: the compiled function calls `registry.plural(locale, i?.count)`, which runs
// `Number(input)`. Hand it a GROUPED STRING and the selector reads a different number than the
// author wrote:
//   · de/nl — `num(1000)` is "1.000"; `Number("1.000")` is 1 → the "one" branch → "1.000 Ereignis",
//     singular, for a thousand events.
//   · ar/pl — `num(1207)` is "1,207"/"1 207"; `Number(…)` is NaN → `Intl.PluralRules.select(NaN)`
//     answers "other", so Arabic's `few`/`many` forms become unreachable — and, once the fix below
//     is in place, the NaN reaches `Intl.NumberFormat` too and Arabic prints the literal
//     "ليس رقمًا" ("not a number") where the count should be.
// Both are driven as assertions at the bottom of this file, against the real compiled messages, so
// that the next person who reaches for `num({ count })` here reds a test that explains itself.
//
// THE FIX, applied in the catalogs rather than at the call sites: each of these ten messages
// declares a SECOND local off the same input —
//     "local countPlural = count: plural"   ← selects the grammatical form, from the RAW number
//     "local countNum   = count: number numberingSystem=latn"   ← formats the digits, in the
//                                                                  message's own locale
// — and the patterns interpolate `{countNum}`. The call sites keep passing a plain `number` and
// therefore did not change at all.
//
// ⚠️ THE REAL COMPILED MESSAGES, NOT A STUB. Every render spec in this repo mocks
// `$lib/paraglide/messages` with key-name functions; such a stub bypasses the compiled body
// entirely and could not tell this fix from its absence. This file must therefore never mock it.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as m from '$lib/paraglide/messages';
import { overwriteGetLocale, getLocale } from '$lib/paraglide/runtime';

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;

// U+00A0 NO-BREAK SPACE (pl) and U+202F NARROW NO-BREAK SPACE (fr) — spelled as escapes for the
// reason `$lib/utils/format.locale.test.ts` spells them out: an ASCII space here would be a wrong
// expectation that looks character-for-character right on screen.
const NBSP = ' ';
const NNBSP = ' ';

/**
 * EVERY plural message in these catalogs — all ten of them — driven with the parameters its one
 * call site passes.
 *
 * ⛔ ALL TEN, NOT "THE ONES THAT CAN EXCEED 999". The first pass fixed five and left five
 * (`build_block_count`, `challenge_detail_discussion`, `console_ready`,
 * `console_trace_run_started`, `mkt_solutions_count`) on the argument that their counts are small.
 * That argument is both unfalsifiable and unnecessary:
 *   · unfalsifiable — every one of the five is `something.length` off the wire, with no cap in the
 *     schema or the API. "A flow will not have 1000 blocks" is a guess about someone else's data.
 *   · unnecessary — mechanism B is a CATALOG-ONLY change. The call sites do not move, the plural
 *     selector still reads the raw number, and the same 40 patterns were already proven correct
 *     across pl's `few`/`many`, ar's six categories and he's `one`/`two`/`many` in this file.
 *   · and leaving them split re-created the exact self-contradiction the whole change exists to
 *     remove: `mkt_solutions_count` renders on the leaderboard row DIRECTLY BESIDE
 *     `num(row.votesCount, locale.current)`, and `console_ready` sits in the same console as the
 *     grouped `console_trace_cost`.
 * Ten out of ten is also the only version of this that a guard can state without a maintained
 * exception list — see `the catalogs declare a countNum on EVERY plural message` below.
 */
const FIXED = [
	'audit_event_count',
	'blockedit_impl_head',
	'data_finding_type_mismatch',
	'ops_alert_sandbox_error_title',
	'ops_alert_block_errors_detail',
	'build_block_count',
	'challenge_detail_discussion',
	'console_trace_run_started',
	// A step's output row count on the Result panel (StepOutput.svelte).
	'build_output_rows',
	'mkt_solutions_count',
	// The /ontology "Recent changes" disclosure: how many rows in the window belong to no
	// resolvable workspace and are therefore NOT shown. It joins this guard because it is a plural
	// message with a count off the wire — the completeness-test below reds if it does not.
	'ontology_recent_changes_unattributed',
	// The Plans page's "In use by N workspaces" (Delete tooltip + the 409 plan_in_use banner). It
	// read "In use by 1 workspaces" as a plain `{count}` message; it is a plural now.
	'admin_plans_in_use',
	// W8/P4: "Amount is not a number in 3 rows." — the plain-words sample-test finding on /build.
	'build_sample_finding_type'
] as const;

/**
 * How to render each of them with a real count. The extra parameters are the ones its call site
 * genuinely passes; `days: 7` is a compile-time constant and is deliberately NOT grouped (see the
 * exclusion test).
 */
const DRIVE: Record<(typeof FIXED)[number], (count: number) => string> = {
	audit_event_count: (count) => m.audit_event_count({ count }),
	blockedit_impl_head: (count) => m.blockedit_impl_head({ count }),
	data_finding_type_mismatch: (count) =>
		m.data_finding_type_mismatch({
			count,
			column: 'bedrag',
			attribute: 'amount',
			expected: 'number'
		}),
	ops_alert_sandbox_error_title: (count) => m.ops_alert_sandbox_error_title({ count }),
	ops_alert_block_errors_detail: (count) => m.ops_alert_block_errors_detail({ count, days: 7 }),
	build_block_count: (count) => m.build_block_count({ count }),
	challenge_detail_discussion: (count) => m.challenge_detail_discussion({ count }),
	console_trace_run_started: (count) => m.console_trace_run_started({ count }),
	build_output_rows: (count) => m.build_output_rows({ count }),
	mkt_solutions_count: (count) => m.mkt_solutions_count({ count }),
	ontology_recent_changes_unattributed: (count) => m.ontology_recent_changes_unattributed({ count }),
	admin_plans_in_use: (count) => m.admin_plans_in_use({ count }),
	build_sample_finding_type: (count) => m.build_sample_finding_type({ count, field: 'Amount', expected: 'a number' })
};

// ⚠️ Drive the locale through paraglide's own hook rather than a `{ locale }` option argument: the
// vite plugin and the CLI emit DIFFERENT module shapes for this project (locale-modules vs
// message-modules) and only one of them takes that option. `overwriteGetLocale` is the seam
// `stores/locale.svelte.ts:125` itself uses, so this is also the mechanism the app runs on.
let current: string = getLocale();
overwriteGetLocale(() => current as never);
const at = <T>(locale: string, fn: () => T): T => {
	const previous = current;
	current = locale;
	try {
		return fn();
	} finally {
		current = previous;
	}
};
afterAll(() => overwriteGetLocale(() => current as never));

describe('the counts inside an ICU message are grouped for the reader', () => {
	it('THE DUTCH CASE: 11774 queued translations read "11.774", never "11774"', () => {
		// The catalogue is 1682 keys × 7 target locales — the figure /translations really shows.
		expect(at('nl', () => m.audit_event_count({ count: 11774 }))).toContain('11.774');
		// ⛔ The assertion that inverts the moment `{countNum}` is put back to `{count}`: the raw
		// template interpolation produces exactly this.
		expect(at('nl', () => m.audit_event_count({ count: 11774 }))).not.toContain('11774');
	});

	it('renders 1234567 in all eight locales, each in its own grouping', () => {
		// Same measured CLDR table as $lib/utils/format.locale.test.ts, so the two paths cannot
		// drift apart. U+00A0 (pl) and U+202F (fr) are spelled as escapes because an ASCII space
		// here would be a wrong expectation that looks right.
		const table: Record<(typeof LOCALES)[number], string> = {
			en: '1,234,567',
			nl: '1.234.567',
			pl: '1 234 567',
			fr: '1 234 567',
			es: '1.234.567',
			de: '1.234.567',
			// ⛔ ar/he WERE DERIVED FROM `Intl` HERE, AND ARE NOW MEASURED LITERALS LIKE THE OTHER
			// SIX. The derivation was a workaround for a PRODUCT defect: the default numbering
			// system for the generic `ar` tag is `latn` on ICU 78 and `arab` on the CI runner's
			// older ICU, so the app rendered `1,234,567` on one box and `١٬٢٣٤٬٥٦٧` on another
			// — in the reader's BROWSER, which is a third ICU nobody controls. All eight catalogs
			// now declare `numberingSystem=latn` on the `countNum` local (and `utils/format.ts`
			// pins the same on its own formatters), so both paths are build-independent and this
			// row can state WHICH string, which is the whole point of the table.
			ar: '1,234,567',
			he: '1,234,567'
		};
		for (const l of LOCALES)
			expect(at(l, () => m.audit_event_count({ count: 1234567 })), `locale ${l}`).toContain(
				table[l]
			);
		// Non-vacuity: a compiled body that ignored the locale could not produce three forms.
		expect(new Set(LOCALES.map((l) => at(l, () => m.audit_event_count({ count: 1234567 })))).size)
			.toBeGreaterThanOrEqual(3);
	});

	// ⛔⛔ EVERY MESSAGE × EVERY LOCALE — AND THE "× EVERY LOCALE" HALF IS NOT PADDING.
	// This loop used to drive `nl` ONLY, and the catalog half of the guard checks DECLARATIONS
	// plus a `not.toContain('{count}')` on each pattern. Measured against that pair: in
	// `de.json/blockedit_impl_head`, keep both declarations and simply DELETE `{countNum}` from
	// every pattern — `icu-number-params.test.ts`, `icu-number-params.sites.test.ts` and
	// `catalogs.test.ts` all reported GREEN, 59/59. German then rendered
	//
	//     Implementierung · TypeScript · Zeilen
	//
	// with NO FIGURE AT ALL on a header whose entire job is to state a line count. Nothing could
	// see it: `not.toContain('{count}')` is satisfied by a pattern that interpolates nothing, and
	// `catalogs.test.ts` compares key SETS with no placeholder parity. The render half only ever
	// looked at Dutch, and Dutch was fine.
	//
	// A translator round-trip through an inlang editor drops a placeholder far more easily than it
	// drops a declaration, so this is the likelier of the two failures — and it was the unguarded
	// one. Rendering all eight is the only assertion that sees a number GO MISSING.
	describe('every plural message carries the grouping, in every one of the eight locales', () => {
		// 11774 = the catalogue's 1682 keys × 7 target locales, the figure /translations really shows.
		// It groups in all eight (pl and es set `minimumGroupingDigits: 2`, which a 4-digit fixture
		// would have silently skipped), and in ar/he it selects a category whose pattern carries the
		// placeholder — their `zero`/`one`/`two` forms spell the number as a WORD and interpolate
		// nothing, which is why the count matters as much as the locale.
		const GROUPED_11774: Record<(typeof LOCALES)[number], string> = {
			en: '11,774',
			nl: '11.774',
			pl: `11${NBSP}774`,
			fr: `11${NNBSP}774`,
			es: '11.774',
			de: '11.774',
			// Measured literals for the same reason as the table above — the catalogs pin latn.
			ar: '11,774',
			he: '11,774'
		};

		for (const locale of LOCALES) {
			it(`${locale} — all ${FIXED.length} messages`, () => {
				for (const key of FIXED) {
					const rendered = at(locale, () => DRIVE[key](11774));
					expect(rendered, `${locale}/${key} did not group its count`).toContain(
						GROUPED_11774[locale]
					);
					// The assertion that inverts the moment `{countNum}` goes back to `{count}`.
					expect(rendered, `${locale}/${key} interpolates the raw count`).not.toContain('11774');
				}
			});
		}

		it('⛔ non-vacuity: the grouped forms are not one string wearing eight names', () => {
			// A compiled body that ignored the locale could not produce four distinct spellings, and
			// this assertion is what stops the table above from being satisfied by a helper that
			// returned the runtime default everywhere.
			const forms = new Set(LOCALES.map((l) => at(l, () => DRIVE.audit_event_count(11774))));
			expect(forms.size).toBeGreaterThanOrEqual(3);
			expect(new Set(Object.values(GROUPED_11774)).size).toBe(4);
		});
	});

	it('⛔ `days` is NOT grouped — it is a constant of 7, and 4-digit years/versions read wrong grouped', () => {
		// The same exclusion the `num()` sweep observed for `year`, `version`, `line` and `page`:
		// a number that is an IDENTIFIER or an ordinal must never acquire a thousands separator.
		// `ops_alert_block_errors_detail` carries both kinds in one sentence, so it is the honest
		// place to pin the distinction.
		const out = at('nl', () => m.ops_alert_block_errors_detail({ count: 11774, days: 1207 }));
		expect(out).toContain('11.774');
		expect(out, 'days acquired a thousands separator').toContain('1207');
		expect(out).not.toContain('1.207');
	});
});

describe('the plural category is still chosen from the RAW number', () => {
	it('⛔ THE GERMAN THOUSAND: 1000 is grouped AND plural — the two jobs do not collide', () => {
		// THE measurement this whole mechanism exists for. German selects "one" for exactly 1, so a
		// grouped STRING passed as `count` would have made `Number("1.000") === 1` and printed the
		// SINGULAR noun over a four-digit figure.
		expect(at('de', () => m.audit_event_count({ count: 1000 }))).toBe('1.000 Ereignisse');
		expect(at('nl', () => m.audit_event_count({ count: 1000 }))).toBe('1.000 gebeurtenissen');
		expect(at('en', () => m.audit_event_count({ count: 1000 }))).toBe('1,000 events');
	});

	it('…and 1 still selects the singular, in the same locales', () => {
		// The other half: this is not a message that lost its plural machinery, it is one where the
		// two locals do different jobs off the same input.
		expect(at('de', () => m.audit_event_count({ count: 1 }))).toBe('1 Ereignis');
		expect(at('nl', () => m.audit_event_count({ count: 1 }))).toBe('1 gebeurtenis');
		expect(at('en', () => m.audit_event_count({ count: 1 }))).toBe('1 event');
	});

	it('Polish keeps its four categories and Arabic its six, at figures above the grouping floor', () => {
		// pl: 1207 → "few" is 2–4; 1207 % 100 = 7 → "many". ar: 1207 % 100 = 7 → "few".
		// Both are reachable ONLY while the selector sees a real number, which is the property the
		// trap block below destroys.
		expect(at('pl', () => m.audit_event_count({ count: 1207 }))).toBe('1207 zdarzeń');
		expect(at('pl', () => m.audit_event_count({ count: 1234567 }))).toContain('zdarzeń');
		// Both halves are literals now: the digits because the catalog pins `numberingSystem=latn`
		// (they used to be derived from `Intl`, which asserted only that the runtime agreed with
		// itself), and the plural FORM because that is the half this case exists to pin.
		expect(at('ar', () => m.audit_event_count({ count: 1207 }))).toBe('1,207 أحداث');
		// The `other` form is a DIFFERENT Arabic word, so the two are genuinely distinguished.
		expect(at('ar', () => m.audit_event_count({ count: 1000 }))).toBe('1,000 حدث');
	});
});

describe('⛔ THE TRAP: never wrap these params in num()', () => {
	// This block asserts the BROKEN behaviour on purpose. It is the executable form of the comment
	// above the ten catalog entries: if a future change routes `num()` into one of these call
	// sites, these expectations still pass — but the ones above it stop passing, and this block is
	// where the reason is written down.

	it('a grouped de/nl string collapses the plural to the SINGULAR', () => {
		const grouped = (1000).toLocaleString('de'); // "1.000"
		expect(Number(grouped)).toBe(1);
		expect(at('de', () => m.audit_event_count({ count: grouped }))).toBe('1 Ereignis');
	});

	it('a grouped ar/pl string is NaN — the category collapses and the digits are lost', () => {
		// Pinned to latn, matching what `num()` now produces — the trap this block models is a
		// future change routing `num()` into one of these call sites, so the string it hands over
		// must be the one `num()` would actually build.
		const arGrouped = (1207).toLocaleString('ar', { numberingSystem: 'latn' }); // "1,207"
		expect(Number(arGrouped)).toBeNaN();
		const out = at('ar', () => m.audit_event_count({ count: arGrouped }));
		// `few` ("أحداث", the correct form for 1207) is unreachable, and `Intl.NumberFormat` renders
		// the NaN as words: the reader is told, in Arabic, "not a number events".
		expect(out).not.toContain('أحداث');
		// ⚠️ Taken FROM Intl rather than typed out: the CLDR string for NaN in Arabic separates its
		// two words with U+00A0, and a hand-written ASCII space here fails an assertion that looks
		// character-for-character correct on screen. Measured, not guessed.
		expect(out).toContain(Number.NaN.toLocaleString('ar'));
	});
});

type Variant = { declarations: string[]; selectors: string[]; match: Record<string, string> };
const catalogOf = (locale: string) =>
	JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')) as Record<
		string,
		Variant[] | string
	>;

describe('the catalogs keep the two locals, in all eight languages', () => {
	// A translator round-trip through an inlang editor is the realistic way `local countNum` gets
	// dropped from one catalog — and a single missing local is invisible on every screen but one.
	for (const locale of LOCALES) {
		it(`${locale}.json declares both locals on all ${FIXED.length} plural messages`, () => {
			const catalog = catalogOf(locale);
			for (const key of FIXED) {
				const variant = (catalog[key] as Variant[])[0];
				expect(variant.declarations, `${locale}/${key}`).toContain(
					'local countPlural = count: plural'
				);
				// ⛔ THE `numberingSystem=latn` HALF IS LOAD-BEARING, NOT DECORATION. Without it the
				// digits inside these eleven messages follow whichever numbering system the
				// reader's ICU defaults to for the tag, which for `ar` is `latn` on ICU 78 and
				// `arab` on older builds — so one Arabic reader sees `11,774` and the next sees
				// `١١٬٧٧٤`, and neither matches the Latin figures around it. `utils/format.ts`
				// pins the same value on the direct-render path; the two must not drift apart or
				// one sentence carries both spellings. Asserting the exact declaration string is
				// what stops an inlang round-trip from dropping the option silently.
				expect(variant.declarations, `${locale}/${key}`).toContain(
					'local countNum = count: number numberingSystem=latn'
				);
				// …and no pattern interpolates the raw input any more. (Some ar/he forms spell the
				// number as a word and interpolate neither, which is why this is `not.toContain`
				// rather than a positive check — and why the RENDER loop above, which drives a count
				// those forms cannot claim, is the half that catches a placeholder going missing.)
				for (const pattern of Object.values(variant.match))
					expect(pattern, `${locale}/${key} still interpolates {count}`).not.toContain('{count}');
			}
		});
	}

	it('⛔ FIXED is EVERY plural message — a new one cannot be added without joining this guard', () => {
		// The list above is the only thing standing between a new `{count} things` message and the
		// German "1 Ereignis for a thousand" defect, so it must not be a list someone remembers to
		// update. Derived from the base catalog instead: any message declaring a `plural` local and
		// not named here reds this, with the key in the message.
		const catalog = catalogOf('en');
		const plurals = Object.entries(catalog)
			.filter(
				([, v]) =>
					Array.isArray(v) && v[0].declarations.some((d) => d.endsWith('= count: plural'))
			)
			.map(([k]) => k)
			.sort();
		expect(plurals, 'a plural message exists that no test drives — add it to FIXED and DRIVE').toEqual(
			[...FIXED].sort()
		);
		// And DRIVE covers all of them, so the render loop cannot silently skip one.
		expect(Object.keys(DRIVE).sort()).toEqual([...FIXED].sort());
	});
});

describe('admin_plans_in_use agrees with its count', () => {
	// ⛔ The Plans Delete tooltip read "In use by 1 workspaces" — a plain `{count}` message.
	it('1 is singular and 2 is plural, in en, de and pl', () => {
		expect(at('en', () => m.admin_plans_in_use({ count: 1 }))).toContain('1 workspace,');
		expect(at('en', () => m.admin_plans_in_use({ count: 2 }))).toContain('2 workspaces,');
		expect(at('de', () => m.admin_plans_in_use({ count: 1 }))).toContain('1 Arbeitsbereich genutzt');
		expect(at('pl', () => m.admin_plans_in_use({ count: 3 }))).toContain('3 obszary robocze');
		expect(at('pl', () => m.admin_plans_in_use({ count: 5 }))).toContain('5 obszarów roboczych');
	});
});
