// src/lib/i18n/connection-test-label.fr-license.test.ts — the four fr Gate-2 refusals, on the
// screen that renders them: /(tenant)/delivery's **Testen** strip.
//
// ⛔ THE DEFECT. `assertFrLicense` (backend/src/services/fr-license.ts) distinguishes FOUR reasons —
// inactive / app_mismatch / tenant_mismatch / introspect_unavailable — and gave every one of them
// the same code, `fr_license_required`, with the difference carried ONLY in an English sentence.
// `routes/delivery.ts:256` answers **HTTP 200** `{ok:false, code, detail}`, so nothing throws, so
// `errorText` never runs; `connectionTestLabel` had no case for the code, hit its `default`, and
// rendered `detail` — the English sentence — to a Dutch tenant_admin.
//
// Four codes, one sentence each, parameterless. Parameterless ON PURPOSE: the only fact the old
// prose carried that the code does not is the `app.key` in the app_mismatch case, and that is a
// licensing-server token ("commonpractice") the reader cannot act on. Carrying it would reintroduce
// the `params` plumbing four codes exist to avoid — see the ⛔ block in the backend file.
//
// Drives the REAL compiled catalog through `overwriteGetLocale`, the seam the app itself runs on —
// same technique as `ontology-changes-copy.test.ts`. A key that is in `en.json` and in the switch
// but never compiled is a hard `TypeError: m.fr_license_inactive is not a function` at runtime, and
// only the real catalog can see that.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionTestLabel } from './connection-test-label';
import { overwriteGetLocale, getLocale } from '$lib/paraglide/runtime';

const original = getLocale();
afterAll(() => overwriteGetLocale(() => original as never));

const catalog = (locale: string): Record<string, string> =>
	JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8'));

/** The four codes, each paired with the ENGLISH sentence the backend still sends as `detail`. */
const CASES = [
	['fr_license_inactive', 'The tenant’s fr license is not active'],
	['fr_license_app_mismatch', 'The fr license is for app "commonpractice", not an fr-bridge app'],
	['fr_license_tenant_mismatch', 'The fr license belongs to a different tenant'],
	['fr_license_unavailable', 'The fr license could not be verified: HTTP 503']
] as const;

const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'] as const;

describe('the four fr Gate-2 refusals reach the reader in the reader’s language', () => {
	for (const [code, englishDetail] of CASES) {
		it(`${code} renders the Dutch sentence, not the English \`detail\``, () => {
			overwriteGetLocale(() => 'nl' as never);
			const out = connectionTestLabel({ ok: false, code, detail: englishDetail }, 'nl');

			// The exact catalog entry — read from nl.json, so a reword here fails loudly rather than
			// silently weakening the assertion to "some non-English string".
			expect(out).toBe(catalog('nl')[code]);
			// ⛔ THE HALF THAT ACTUALLY PINS THE DEFECT. Before the fix this switch had no case, so
			// `out` WAS `englishDetail`. Asserting only "out is the Dutch string" would also pass if
			// the fallback happened to be Dutch; asserting the English is GONE is what proves the
			// `default` arm is no longer the one being taken.
			expect(out).not.toBe(englishDetail);
			expect(out).not.toContain('fr license');
		});
	}

	it('every one of the four resolves a REAL compiled message in all 8 locales', () => {
		// A key present in `en.json` and in the switch but absent from the compiled paraglide output
		// throws `TypeError: m.<key> is not a function`. Only the real catalog can catch that, and it
		// is the failure a stubbed-catalog spec is structurally blind to.
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale as never);
			const cat = catalog(locale);
			for (const [code, englishDetail] of CASES) {
				const out = connectionTestLabel({ ok: false, code, detail: englishDetail }, locale);
				expect(out, `${locale}/${code}`).toBe(cat[code]);
				expect(out.length, `${locale}/${code} rendered empty`).toBeGreaterThan(10);
				// Parameterless by design — an unreplaced ICU placeholder would mean the opposite.
				expect(out, `${locale}/${code} carries a placeholder`).not.toMatch(/[{}]/);
			}
		}
	});

	it('⚠️ MID-ROLL — an old pod still sends `fr_license_required`, which must fall back, not blank', () => {
		// The backend half and this bundle do not deploy atomically. For the length of the roll a new
		// SPA is answered by a pod that still emits the single old code. It has no case and must land
		// in the documented `default` → `detail`. An English sentence is a worse read than a Dutch one
		// and an infinitely better read than nothing.
		overwriteGetLocale(() => 'nl' as never);
		const detail = 'The tenant’s fr license is not active';
		expect(connectionTestLabel({ ok: false, code: 'fr_license_required', detail }, 'nl')).toBe(detail);
	});
});
