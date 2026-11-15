// src/lib/i18n/ontology-changes-copy.test.ts — the /ontology "Recent changes" disclosure says what
// its number actually IS, in all eight catalogs.
//
// ⛔ THE DEFECT, AND IT WAS A FALSE CLAIM SHIPPED IN THE CODE. Two comments —
// `backend/src/ontology/ontology-changes.ts`'s header and `routes/ontology/+page.svelte` beside the
// call — both asserted that the count "is an UPPER BOUND … and it is stated on screen as such".
// It was not. All eight catalogs said exactly one thing:
//
//     "{countNum} changes in this period could not be linked to a workspace and are not shown."
//
// No hedge, no scope, in the first person, directly beneath a caption about the reader's OWN
// workspace and a list that really is theirs. Meanwhile the figure is platform-wide: the counting
// query has no tenant predicate and CANNOT have one, because the defining property of these rows is
// that no workspace can be derived for them. Measured on the backend: five unattributable rows
// written by another workspace's user raised this reader's number by exactly five (42 → 47), and
// that measurement is pinned in `backend/tests/ontology-changes-tenant-scope.test.ts`.
//
// ⛔⛔ WHY THE FIX IS THE COPY AND NOT THE QUERY. The alternative was "give the count a tenant
// predicate so it means what the caption says". There is nothing to predicate ON. An unattributable
// row is, by construction, one where `metadata.tenantId` is absent AND the target row is gone or
// was never tenant-owned; the two other candidate sources were rejected with reasons in the backend
// header (`users.tenant_id` on `actor_id` is retroactively wrong the moment a user moves; a
// `tenant_id` migration + backfill is a one-way door over unknowable history). A predicate that
// guessed would turn an honest over-count into a silent under-count — the strictly worse failure,
// because the reader would then be told nothing was hidden when something was. So the number stays
// what it is and the sentence has to say what it is.
//
// ⚠️ WHAT THIS FILE ASSERTS AND WHY IT ASSERTS PROSE. It drives the REAL compiled paraglide
// messages — the artifact `+page.svelte` calls — in all eight locales, and requires each rendering
// to carry two claims: the SCOPE (this count covers every workspace) and the BOUND (so at most that
// many were this reader's). Pinning translated phrases is brittle by design: a reword should make
// somebody re-read this decision, and the failure prints both strings. This is the same technique
// `icu-number-params.sites.test.ts` uses on source text, for the same reason.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as m from '$lib/paraglide/messages';
import { overwriteGetLocale, getLocale } from '$lib/paraglide/runtime';

const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const;
type Locale = (typeof LOCALES)[number];

const KEY = 'ontology_recent_changes_unattributed';

/**
 * The two claims, per locale. `scope` is the phrase that says the number covers every workspace;
 * `bound` is the phrase that says at most that many were the reader's.
 *
 * ⛔ TWO PHRASES, NOT ONE, and the pair is the point. "covers every workspace" alone is a scope
 * with no consequence — a reader still does not know what to do with the figure. "at most" alone is
 * an upper bound on nothing in particular, which is exactly the unfalsifiable hedge the old comment
 * claimed was already there.
 */
const CLAIMS: Record<Locale, { scope: string; bound: string }> = {
	en: { scope: 'covers every workspace', bound: 'at most' },
	nl: { scope: 'alle werkruimten', bound: 'hooguit' },
	de: { scope: 'umfasst alle Arbeitsbereiche', bound: 'höchstens' },
	fr: { scope: 'couvre tous les espaces de travail', bound: 'au plus' },
	es: { scope: 'abarca todos los espacios de trabajo', bound: 'como máximo' },
	pl: { scope: 'obejmuje wszystkie obszary robocze', bound: 'najwyżej' },
	ar: { scope: 'جميع مساحات العمل', bound: 'على الأكثر' },
	he: { scope: 'כל מרחבי העבודה', bound: 'לכל היותר' }
};

// ⚠️ Drive the locale through paraglide's own hook, not a `{ locale }` option — see the long note in
// `icu-number-params.test.ts`: the vite plugin and the CLI emit different module shapes and only
// one of them takes that argument. `overwriteGetLocale` is the seam the app itself runs on.
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

/**
 * Counts that reach a DIFFERENT plural category in at least one catalog:
 * 1 → one · 2 → he/ar `two` · 5 → pl `few`, ar `few` · 47 → pl `many`, ar `many` · 11774 → other.
 * The panel never renders at 0 (`{#if changesUnattributed > 0}`), so 0 is out of scope — ar's
 * `zero` form says "nothing is hidden" and correctly carries no caveat.
 */
const COUNTS = [1, 2, 5, 47, 11774];

describe('the "could not be linked" disclosure states what its number is', () => {
	for (const locale of LOCALES) {
		it(`${locale} names the platform scope AND the at-most reading, in every plural form`, () => {
			for (const count of COUNTS) {
				const text = at(locale, () => m.ontology_recent_changes_unattributed({ count }));
				expect(
					text,
					`${locale} @ ${count}: the sentence does not say the count covers every workspace. ` +
						`It is a PLATFORM figure with no tenant predicate — rendering it under a caption ` +
						`about the reader's own workspace with no scope is the defect this file exists for.\n` +
						`  got: ${text}`
				).toContain(CLAIMS[locale].scope);
				expect(
					text,
					`${locale} @ ${count}: the sentence states a count but not that it is an UPPER BOUND ` +
						`on what was hidden from THIS reader.\n  got: ${text}`
				).toContain(CLAIMS[locale].bound);
			}
		});
	}

	it('⛔ THE POSITIVE HALF: it is still a DISCLOSURE — the figure itself survives, grouped', () => {
		// A caveat that swallowed the number would satisfy every assertion above and be a worse
		// panel than the one that lied: the reader would know something was hidden and not how much.
		// Same grouped-11774 table as `icu-number-params.test.ts` so the two cannot drift.
		const GROUPED: Record<Locale, string> = {
			en: '11,774',
			nl: '11.774',
			de: '11.774',
			fr: '11 774',
			es: '11.774',
			pl: '11 774',
			ar: '11,774',
			he: '11,774'
		};
		for (const locale of LOCALES) {
			const text = at(locale, () => m.ontology_recent_changes_unattributed({ count: 11774 }));
			expect(text, `${locale}: the count went missing from its own disclosure`).toContain(
				GROUPED[locale]
			);
		}
		// Non-vacuity: a body that ignored the locale could not produce three spellings.
		expect(
			new Set(
				LOCALES.map((l) => at(l, () => m.ontology_recent_changes_unattributed({ count: 11774 })))
			).size
		).toBe(LOCALES.length);
	});

	it('⛔ THE CATALOGS, NOT JUST THE FORMS THESE COUNTS REACH', () => {
		// The render loop above drives five counts. A catalog can carry a plural form none of them
		// selects (a locale-specific `few`/`many` boundary, or a `*` fallback), and that form is
		// exactly where a half-done edit survives. This reads every pattern of the key out of every
		// catalog and requires the same two claims — with ONE stated exception.
		for (const locale of LOCALES) {
			const catalog = JSON.parse(
				readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')
			) as Record<string, [{ match: Record<string, string> }]>;
			const match = catalog[KEY]?.[0]?.match;
			expect(match, `${locale}.json lost ${KEY} entirely`).toBeTruthy();
			for (const [form, pattern] of Object.entries(match!)) {
				// ⛔ THE ONE EXCEPTION, STATED RATHER THAN SPECIAL-CASED AWAY. Arabic declares a `zero`
				// form and its text is "no changes are hidden in this period" — a sentence that asserts
				// NOTHING was withheld, so a caveat about an upper bound would be false there. It is
				// also unreachable: the panel gates on `changesUnattributed > 0`.
				if (locale === 'ar' && form === 'countPlural=zero') {
					expect(pattern, 'ar zero stopped saying that nothing is hidden').toContain('لا توجد');
					continue;
				}
				expect(pattern, `${locale} ${form}: no platform scope\n  got: ${pattern}`).toContain(
					CLAIMS[locale].scope
				);
				expect(pattern, `${locale} ${form}: no upper bound\n  got: ${pattern}`).toContain(
					CLAIMS[locale].bound
				);
			}
		}
	});
});
