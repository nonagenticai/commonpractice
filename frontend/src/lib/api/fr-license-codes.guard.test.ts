// src/lib/api/fr-license-codes.guard.test.ts — the four fr Gate-2 codes, and the RECORDED DECISION
// about where they must NOT go.
//
// ⛔ WHY THIS FILE EXISTS AT ALL. `error-message.backend-contract.test.ts` is what normally ties the
// backend's 402 codes to the SPA: it scrapes `paymentRequired('<literal>')` out of backend source
// and asserts every hit both BLOCKS (`LICENSE_BLOCK_CODES`) and SPEAKS (`KNOWN_LICENSE_CODES`).
// That scraper is TEXTUAL, so it is blind to `routes/delivery.ts:437`'s
// `paymentRequired(err.code, err.message)` — a dynamic read of `FrLicenseError.code`. These four
// codes therefore travel to the browser through a hole in the contract test.
//
// ⛔⛔ AND THE HOLE IS LOAD-BEARING, WHICH IS THE PART THAT NEEDS WRITING DOWN. Making the call site
// literal would CLOSE the hole and, in the same motion, red that scrape assertion — because these
// four are deliberately NOT in `LICENSE_BLOCK_CODES`. The obvious repair for that red is to add
// them to the set, and THAT is the change that would put an entire workspace behind the whole-app
// renewal wall because ONE delivery connector is misconfigured.
//
// These are connector MISCONFIGURATION, not an absent workspace licence. `licenseGate.svelte.ts:50-53`
// already records the identical distinction for `license_app_mismatch` / `license_tenant_mismatch`,
// which are 403 for exactly this reason and are deliberately kept out of the block set.
//
// So the decision is pinned HERE, positively, instead of being left to whoever next sees that red.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LICENSE_BLOCK_CODES } from '$lib/stores/licenseGate.svelte';
import { stripComments } from '$lib/test/source-scan';
import { connectionTestLabel } from '$lib/i18n/connection-test-label';
import { licenseOrPermissionMessage } from './error-message';
import * as m from '$lib/paraglide/messages';

const BACKEND_SRC = fileURLToPath(new URL('../../../../backend/src', import.meta.url));

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...listTsFiles(p));
		else if (entry.endsWith('.ts')) out.push(p);
	}
	return out;
}

const FR_LICENSE_SRC = join(BACKEND_SRC, 'services/fr-license.ts');
const CODES = [
	'fr_license_inactive',
	'fr_license_app_mismatch',
	'fr_license_tenant_mismatch',
	'fr_license_unavailable'
] as const;

describe('the four fr Gate-2 codes', () => {
	it('are minted in backend/src/services/fr-license.ts, one per reason', () => {
		const src = stripComments(readFileSync(FR_LICENSE_SRC, 'utf-8'));
		// Non-vacuity: an unreadable/renamed file must fail loudly, not pass by finding nothing.
		expect(src.length, 'fr-license.ts read as empty — this whole file proves nothing').toBeGreaterThan(500);
		for (const code of CODES) expect(src, `${code} is not minted`).toContain(code);
		// Four REASONS, four CODES — a fifth reason sharing a code is the defect this replaced.
		expect(new Set(CODES).size).toBe(4);
		for (const reason of ['inactive', 'app_mismatch', 'tenant_mismatch', 'introspect_unavailable'])
			expect(src, `reason ${reason} is gone`).toContain(reason);
	});

	it("⛔ are ABSENT from LICENSE_BLOCK_CODES — adding one blanks the whole SPA for the workspace", () => {
		// ⛔⛔ DO NOT 'FIX' A RED CONTRACT SCRAPE BY ADDING A CODE HERE. `LICENSE_BLOCK_CODES` drives
		// `isLicenseBlockResponse` (licenseGate.svelte.ts:55-72), which the auth-fetch interceptor
		// uses to raise the whole-app renewal wall. A member of this set means "this workspace has no
		// usable Common Practice licence" — every screen replaced by a block page.
		//
		// An fr Gate-2 refusal means "ONE delivery connector's stored fr token is inactive / for
		// another app / for another workspace / momentarily unverifiable". Promoting it to a block
		// code would take a workspace whose CP licence is perfectly valid entirely offline because a
		// tenant admin pasted the wrong token into one connector form. Same category as
		// `license_app_mismatch`/`license_tenant_mismatch`, which are 403 and excluded for this reason.
		for (const code of CODES)
			expect(
				LICENSE_BLOCK_CODES.has(code),
				`${code} is in LICENSE_BLOCK_CODES — ONE misconfigured delivery connector now blanks ` +
					`every screen in the workspace behind the renewal wall. These are connector ` +
					`misconfiguration, not an absent workspace licence. Remove it; if a scrape test went ` +
					`red, the answer is to keep paymentRequired(err.code, …) dynamic, NOT to add it here.`
			).toBe(false);
		// Non-vacuity: the set must be the real one, or the four absences prove nothing.
		expect(LICENSE_BLOCK_CODES.has('license_required')).toBe(true);
		expect(LICENSE_BLOCK_CODES.size).toBeGreaterThanOrEqual(5);
	});

	it('are each answered by BOTH the 200-OK label switch AND the thrown-402 message map', () => {
		// The two paths a Gate-2 refusal can take out of `precheckTarget` — caught+200 at
		// routes/delivery.ts:249, and escaping as a 402 at :696/:816. A code answered by only one of
		// them is half-fixed, and the half that is missing is invisible from the other's tests.
		const english = 'The fr license belongs to a different tenant';
		for (const code of CODES) {
			const label = connectionTestLabel({ ok: false, code, detail: english }, 'nl');
			expect(label, `${code}: connection-test-label.ts has no case`).not.toBe(english);
			expect(label, `${code}: connection-test-label.ts rendered the bare token`).not.toBe(code);

			const msg = licenseOrPermissionMessage({ status: 402, code });
			expect(msg, `${code}: error-message.ts has no entry`).not.toBeNull();
			expect(
				msg,
				`${code}: error-message.ts fell through to the generic workspace-licence copy, which ` +
					`accuses the reader of an expired CP licence they do not have`
			).not.toBe(m.error_license_required());
		}
	});

	it("⛔ 'fr_license_required' is gone from backend/src outside comments", () => {
		// The old single code. Any surviving CODE occurrence means a path still collapses the four
		// reasons — the defect. Comments legitimately still name it (the file explains the history).
		const offenders: string[] = [];
		let scanned = 0;
		for (const file of listTsFiles(BACKEND_SRC)) {
			const text = stripComments(readFileSync(file, 'utf-8'));
			scanned += text.length;
			if (text.includes('fr_license_required')) offenders.push(file.slice(BACKEND_SRC.length + 1));
		}
		expect(
			offenders,
			offenders.length
				? `these backend files still emit the collapsed code 'fr_license_required' outside a ` +
					`comment: ${offenders.join(', ')}. Each of the four reasons has its own code now ` +
					`(FR_LICENSE_CODE in services/fr-license.ts); a surviving literal means that path ` +
					`still hands the browser one code for four different sentences.`
				: undefined
		).toEqual([]);
		// Non-vacuity: stripComments returning empty would make the grep above prove nothing.
		expect(scanned, 'backend/src scanned as (almost) empty').toBeGreaterThan(100_000);
	});
});
