// src/lib/i18n/rtl-arrow-direction.test.ts — a directional arrow in an RTL catalog must point the
// OPPOSITE way to its English counterpart.
//
// ⛔ THE DEFECT. `→` (U+2192) is not a bidi-mirrored character. Unlike `(` or `<`, it is rendered
// with the same glyph no matter the paragraph direction — the bidi algorithm moves it, it does not
// flip it. So an arrow copied unchanged from English into `ar.json` or `he.json` still points
// right, and in a right-to-left reading order "right" is BACKWARD. Measured before this guard:
// 19 keys in each of ar and he carried English's arrow direction, including every pagination
// control (`pager_next` = "التالي →", pointing back the way the reader came), every back link
// (`challenge_detail_back` = "← كل التحديات", pointing forward), `home_see_all`, and the
// `Open in Build` / `Open your sandbox` calls to action.
//
// ⚠️ THE RULE WAS ALREADY WRITTEN DOWN AND WAS SIMPLY NOT APPLIED. `$lib/i18n/notification-label.ts`
// states it outright — the connector "belongs to each catalog, because ar and he set it
// right-to-left" — and 6 keys DID follow it (`tenant_status_changed`, `ops_event_run_finished`, the
// budget how-to family). So the catalogs held both the correct convention and 19 violations of it
// at once, with nothing comparing them. A documented rule with no test is a rule for whoever
// happens to have read that file.
//
// ⛔ THIS GUARD DELIBERATELY HAS NO EXCEPTION LIST, and that is what makes it a rule rather than a
// snapshot. Every one of the 25 arrow-bearing keys is directional in the same sense — a navigation
// affordance ("next", "back", "see all") or a "maps to" connector ("{name} → {status}",
// "connect {source} → {target}"). Both classes must mirror. If a future key needs an arrow that
// must NOT flip — a literal inside a code sample, a wire value the reader has to copy verbatim —
// it does not belong in a translated string at all; it belongs in markup, where
// `.cp-dir-mirror`/`app.css` decides visually. Adding an exception here would be the wrong repair.
import { describe, it, expect } from 'vitest';
import en from '../../../messages/en.json';
import ar from '../../../messages/ar.json';
import he from '../../../messages/he.json';

const RTL_CATALOGS: Record<string, Record<string, unknown>> = { ar, he };

const LTR_ARROW = '→';
const RTL_ARROW = '←';

/** Which arrow a string carries, or null when it carries none. Mixed strings are reported as-is. */
function arrowOf(value: string): '→' | '←' | 'both' | null {
	const hasR = value.includes(LTR_ARROW);
	const hasL = value.includes(RTL_ARROW);
	if (hasR && hasL) return 'both';
	if (hasR) return LTR_ARROW;
	if (hasL) return RTL_ARROW;
	return null;
}

/** Every English key whose value carries exactly one direction of arrow. */
const DIRECTIONAL_KEYS = Object.entries(en)
	.filter(([, v]) => typeof v === 'string' && (arrowOf(v as string) === LTR_ARROW || arrowOf(v as string) === RTL_ARROW))
	.map(([k]) => k);

describe('RTL catalogs mirror English arrow direction', () => {
	// ⛔ NON-VACUITY FIRST. If a refactor moved these arrows out of the catalogs and into markup,
	// DIRECTIONAL_KEYS would go empty and every assertion below would pass by having nothing to
	// check — the failure mode where a guard reports success because it lost its subject.
	it('there are directional arrows in the catalogs to check', () => {
		expect(DIRECTIONAL_KEYS.length).toBeGreaterThanOrEqual(20);
	});

	for (const locale of Object.keys(RTL_CATALOGS)) {
		it(`${locale} points every directional arrow the other way`, () => {
			const wrong: string[] = [];
			const missing: string[] = [];
			for (const key of DIRECTIONAL_KEYS) {
				const translated = RTL_CATALOGS[locale][key];
				if (typeof translated !== 'string') continue;
				const expected = arrowOf(en[key as keyof typeof en] as string) === LTR_ARROW ? RTL_ARROW : LTR_ARROW;
				const actual = arrowOf(translated);
				if (actual === null) missing.push(key);
				else if (actual !== expected) wrong.push(`${key}: expected ${expected}, got ${translated}`);
			}
			expect(
				wrong,
				`${locale} copies English's arrow direction on these keys. U+2192 does not bidi-mirror, ` +
					`so a right-pointing arrow reads as BACKWARD to a ${locale} reader — a "next" control ` +
					`pointing back the way they came.`
			).toEqual([]);
			expect(
				missing,
				`${locale} dropped the arrow entirely on these keys — the affordance is gone, not mirrored.`
			).toEqual([]);
		});
	}
});
