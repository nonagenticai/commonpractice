// src/lib/api/error-message.fr-license.test.ts — the OTHER fr Gate-2 path, and it was a
// misdiagnosis rather than a missing translation.
//
// ⛔ THE DEFECT. `precheckTarget` is called from three places in `backend/src/routes/delivery.ts`.
// At `:249` (the Test button) the `HttpError` is CAUGHT and answered as HTTP 200 — that path is
// `connection-test-label.ts`'s. At `:696` (forward) and `:816` (retry) it ESCAPES as a real 402, and
// this module is what turns it into words.
//
// `licenseOrPermissionMessage`'s 402 branch looked the code up in `LICENSE_MESSAGES`, missed, and
// returned the documented default: `m.error_license_required()` — "Your workspace doesn't have an
// active Common Practice license. Contact your administrator." That sentence is about the WORKSPACE'S
// CP licence. The refusal is about a CONNECTOR'S fr licence. A tenant_admin reading it goes to the
// billing screen, finds a perfectly valid CP licence, and has been sent to the wrong screen entirely
// by copy that was not merely untranslated but WRONG — the worse of the two failures, because a
// reader can tell English from Dutch and cannot tell a true sentence from a plausible false one.
//
// ⚠️ THESE FOUR ARE NOT BLOCK CODES. `isLicenseBlockResponse` (stores/licenseGate.svelte.ts:55-72)
// is an exact-match test against `LICENSE_BLOCK_CODES`; these are absent from it, so the 402 never
// trips the whole-app renewal wall — which is correct, and asserted in the backend guard spec. They
// are connector MISCONFIGURATION, the same category `licenseGate.svelte.ts:50-53` records for
// `license_app_mismatch`/`license_tenant_mismatch` (403, deliberately not block codes).
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as m from '$lib/paraglide/messages';
import { overwriteGetLocale, getLocale } from '$lib/paraglide/runtime';
import { licenseOrPermissionMessage } from './error-message';

const original = getLocale();
afterAll(() => overwriteGetLocale(() => original as never));

const catalog = (locale: string): Record<string, string> =>
	JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8'));

const CODES = [
	'fr_license_inactive',
	'fr_license_app_mismatch',
	'fr_license_tenant_mismatch',
	'fr_license_unavailable'
] as const;

/** The shape `licenseOrPermissionMessage` reads: `statusOf` + `codeOf`, both plain fields. */
const err = (code: string) => ({ status: 402, code });

describe('a forward/retry 402 for a CONNECTOR licence stops blaming the WORKSPACE licence', () => {
	for (const code of CODES) {
		it(`${code} is NOT answered with the generic workspace-licence copy`, () => {
			overwriteGetLocale(() => 'nl' as never);
			const out = licenseOrPermissionMessage(err(code));
			expect(out).not.toBeNull();
			// ⛔ THE ASSERTION THAT PINS THE MISDIAGNOSIS. Before the fix this was EXACTLY equal to
			// `m.error_license_required()`, in every locale, for all four codes.
			expect(out).not.toBe(m.error_license_required());
			expect(out).toBe(catalog('nl')[code]);
		});
	}

	it('answers all four in all 8 locales, never falling through to the generic default', () => {
		for (const locale of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			overwriteGetLocale(() => locale as never);
			const generic = m.error_license_required();
			const cat = catalog(locale);
			for (const code of CODES) {
				const out = licenseOrPermissionMessage(err(code));
				expect(out, `${locale}/${code}`).toBe(cat[code]);
				expect(out, `${locale}/${code} fell through to the generic copy`).not.toBe(generic);
			}
		}
	});

	it('⚠️ the CP licence codes are UNCHANGED — the new branch must not shadow LICENSE_MESSAGES', () => {
		// The fr record is consulted BEFORE `LICENSE_MESSAGES`. Two disjoint key spaces, but "before"
		// is a real ordering decision and this is what proves it did not capture the existing ones.
		overwriteGetLocale(() => 'nl' as never);
		expect(licenseOrPermissionMessage(err('license_inactive'))).toBe(m.error_license_inactive());
		expect(licenseOrPermissionMessage(err('license_expired'))).toBe(m.error_license_expired());
		expect(licenseOrPermissionMessage(err('license_unavailable'))).toBe(m.error_license_unavailable());
		expect(licenseOrPermissionMessage(err('license_unreadable'))).toBe(m.error_license_unreadable());
	});

	it('⚠️ MID-ROLL + the documented default — an unknown 402 still gets the generic copy', () => {
		overwriteGetLocale(() => 'nl' as never);
		// The old single code, still emitted by a pod mid-roll. It has no fr entry, so it keeps the
		// documented `default`. Wrong-but-generic beats blank; the fix is the roll finishing.
		expect(licenseOrPermissionMessage(err('fr_license_required'))).toBe(m.error_license_required());
		expect(licenseOrPermissionMessage(err('license_required'))).toBe(m.error_license_required());
		expect(licenseOrPermissionMessage({ status: 402 })).toBe(m.error_license_required());
	});
});
