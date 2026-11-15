// src/lib/i18n/license-copy.test.ts — the licence taxonomy has FOUR outcomes and every one of them
// is a different claim about the customer. Getting it wrong is not a cosmetic defect: two of the
// four accuse a paid-up workspace of not paying.
import { describe, it, expect } from 'vitest';
import { readSource } from '$lib/test/source-scan';
import { licenseCopy } from './license-copy';
import * as m from '$lib/paraglide/messages';

// ⛔ `readSource`, NOT `readFileSync`. It STRIPS COMMENTS. Both consumer files now name
// `licenseCopy` in their header prose, so a raw-source `toContain('licenseCopy')` anchor would be
// satisfied by a COMMENT while the code had gone back to its own ternary — the exact evasion
// `source-scan.ts:4-16` was written to close ("put the OLD GOOD CALL in a comment → 922/922
// green"). Caught by adversarial review; the first version of this file reintroduced it.
const src = (p: string) => readSource(p);

describe('licenseCopy', () => {
	it('an unreachable licences service is not an expiry, and renewing cannot fix it', () => {
		const c = licenseCopy('outage', 'unknown');
		expect(c.heading).toBe(m.license_blocked_heading_unavailable());
		expect(c.body).toBe(m.license_blocked_body_unavailable());
		expect(c.renewIsPointless).toBe(true);
	});

	it('a licence we cannot read is not a licence never bought', () => {
		const c = licenseCopy('unreadable', 'unknown');
		expect(c.heading).toBe(m.license_blocked_heading_unreadable());
		expect(c.body).toBe(m.license_blocked_body_unreadable());
		expect(c.renewIsPointless).toBe(true);
	});

	it('an expiry says so, and renewing is exactly the right action', () => {
		const c = licenseCopy('terminal', 'expired');
		expect(c.heading).toBe(m.license_blocked_heading_expired());
		expect(c.body).toBe(m.error_license_expired());
		expect(c.renewIsPointless).toBe(false);
	});

	it('no WORKSPACE is not a licence verdict — never "expired"/"none", and renewing cannot help', () => {
		const c = licenseCopy(null, 'no_workspace');
		expect(c.heading).toBe(m.no_workspace_heading());
		expect(c.body).toBe(m.no_workspace_body());
		expect(c.renewIsPointless).toBe(true);
	});

	it('a seat BEING SET UP says so — not "ask for a seat", not renewal', () => {
		const c = licenseCopy('setup', 'seat_pending');
		expect(c.heading).toBe(m.license_blocked_heading_setup());
		expect(c.body).toBe(m.license_blocked_body_setup());
		expect(c.heading).not.toBe(m.license_blocked_heading_seat());
		expect(c.renewIsPointless).toBe(true);
	});

	it('no licence at all says so', () => {
		const c = licenseCopy('terminal', 'none');
		expect(c.heading).toBe(m.license_blocked_heading_none());
		expect(c.body).toBe(m.error_license_required());
		expect(c.renewIsPointless).toBe(false);
	});

	// ⛔ THE REGRESSION THIS FILE EXISTS FOR. `/license-upgrade` read `state` ALONE:
	//     state === 'expired' ? heading_expired : heading_none
	// During an outage and during a decrypt failure alike, `state` is `'unknown'` — so BOTH landed
	// on "No active license". `blockReason` is the only thing that separates them, which is why
	// `licenseCopy` refuses to be callable without it.
	it('⛔ state alone cannot distinguish an outage from an unreadable licence — the reason must decide', () => {
		const outage = licenseCopy('outage', 'unknown');
		const unreadable = licenseCopy('unreadable', 'unknown');
		const bare = licenseCopy(null, 'unknown');

		// Same `state`, three different answers. If any two of these collapse together, the taxonomy
		// has silently narrowed back to what it was before #252/#255/#258.
		expect(new Set([outage.heading, unreadable.heading, bare.heading]).size).toBe(3);
		// And neither non-commercial reason may be rendered as "you have no licence".
		expect(outage.heading).not.toBe(m.license_blocked_heading_none());
		expect(unreadable.heading).not.toBe(m.license_blocked_heading_none());
		expect(outage.body).not.toBe(m.error_license_required());
		expect(unreadable.body).not.toBe(m.error_license_required());
	});

	// ⛔⛔ THE ENTITLED CASE — the one the first version of this file MISSED entirely, and the only
	// one reachable from a button on a healthy screen. `LicenseExpiringBanner` offers "Renew licence"
	// for `expiring_soon` with NO block reason; it navigates here. Before this branch existed the
	// reader was told "License expired". Adversarial review found it by rendering every (reason,
	// state) pair instead of the four this file originally covered — which is the lesson: a table
	// test proves only the rows someone thought to write.
	it('⛔ an ENTITLED customer is never told their licence expired or is missing', () => {
		for (const state of ['active', 'expiring_soon'] as const) {
			const c = licenseCopy(null, state, 5);
			expect(c.heading, `${state} heading`).not.toBe(m.license_blocked_heading_expired());
			expect(c.heading, `${state} heading`).not.toBe(m.license_blocked_heading_none());
			expect(c.body, `${state} body`).not.toBe(m.error_license_expired());
			expect(c.body, `${state} body`).not.toBe(m.error_license_required());
			expect(c.renewIsPointless).toBe(false);
		}
	});

	it('names the days when it has them, and stays vague when it does not', () => {
		expect(licenseCopy(null, 'expiring_soon', 5).body).toBe(m.license_expiring_days({ days: 5 }));
		expect(licenseCopy(null, 'expiring_soon').body).toBe(m.license_expiring_soon());
		// `0` is a real remaining-days figure, not an absence — the `!= null` rule this repo already
		// applies to every stats tile.
		expect(licenseCopy(null, 'expiring_soon', 0).body).toBe(m.license_expiring_days({ days: 0 }));
	});

	// ⚠️ A BLOCK REASON STILL WINS. An entitled poll answer racing a live 402 must not clear the
	// block — the same precedence rule that keeps `unknown` from dismissing an outage screen.
	it('a recorded block reason outranks an entitled state', () => {
		expect(licenseCopy('terminal', 'active').heading).toBe(m.license_blocked_heading_expired());
		expect(licenseCopy('outage', 'expiring_soon').heading).toBe(m.license_blocked_heading_unavailable());
	});

	// ⚠️ `unreadable` OUTRANKS `outage`, mirroring licenseGate.svelte.ts:75-115. A tenant firing
	// parallel requests during a key rotation will see one of them time out and report
	// `license_unavailable`; without the precedence the standing fault would be relabelled as a
	// transient one and offered a "Try again" that can never succeed.
	it('unreadable outranks outage when both could apply', () => {
		expect(licenseCopy('unreadable', 'expired').heading).toBe(m.license_blocked_heading_unreadable());
		expect(licenseCopy('outage', 'expired').heading).toBe(m.license_blocked_heading_unavailable());
	});

	// ⛔ THE POINT OF THE MODULE, NOT OF THE FUNCTION. Two screens answer this question and they
	// drifted for three PRs. A behavioural test on `licenseCopy` cannot catch a screen that stops
	// calling it, so assert the call sites by source — the same technique the repo already uses in
	// icu-number-params.sites.test.ts. Both files must import it and neither may keep a local
	// heading/body ternary over `licenseGate.state`.
	const CONSUMERS = [
		'lib/components/LicenseBlocked.svelte',
		'routes/license-upgrade/+page.svelte',
	] as const;

	for (const file of CONSUMERS) {
		it(`${file} derives its copy from licenseCopy, not its own ternary`, () => {
			const s = src(file);
			expect(s, `${file} no longer imports licenseCopy`).toContain('licenseCopy');
			// The exact shape of the old defect: branching on the gate's `state` to pick a heading or
			// body message directly. `renewIsPointless` and the action `{:else if isOutage}` branches
			// may still read the store — it is the COPY decision that must be centralised.
			expect(
				/licenseGate\.state\s*===\s*'(expired|none)'\s*\?/.test(s),
				`${file} still picks copy from licenseGate.state directly`,
			).toBe(false);
		});
	}
});
