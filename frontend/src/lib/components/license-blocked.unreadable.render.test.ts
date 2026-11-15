// license-blocked.unreadable.render.test.ts — a PERMANENT fault must not be rendered as a TRANSIENT one.
//
// ⛔ THE DEFECT THIS PINS.
// `middleware/license-gate.ts` used to answer `402 license_unavailable` for BOTH of these:
//
//   (a) the licences service could not be reached          — transient; the next poll may well fix it
//   (b) the tenant's stored licence blob would not decrypt  — standing, until an operator repairs
//                                                             `CP_SECRET_KEY`
//
// and this screen renders that code with `license_blocked_body_unavailable`, whose last sentence in
// all 8 catalogs is a PROMISE: "Access resumes automatically as soon as it succeeds." For (b) that
// promise is false and can never come true — and because a wrong/rotated master key breaks EVERY
// tenant's blob at once, the whole customer base sits behind "hang on, this fixes itself" while
// nobody is even looking for a fault. The backend now emits `license_unreadable`, and this file is
// the frontend half of that commit.
//
// ⚠️ AND THE FRONTEND HALF IS NOT COSMETIC. A 402 code the SPA does not know falls through
// `licenseOrPermissionMessage`'s `default` to `error_license_required` — "your workspace doesn't
// have an active licence, contact your administrator" — i.e. shipping the backend code alone would
// have been WORSE than the bug it fixes, restoring the exact accusation #252 removed. The first
// assertion below is that regression, not a style preference.
//
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import LicenseBlocked from './LicenseBlocked.svelte';
import { licenseGate } from '$lib/stores/licenseGate.svelte';
import { activeTenant } from '$lib/stores/activeTenant.svelte';
import { locale } from '$lib/stores/locale.svelte';

vi.mock('$lib/api/auth-fetch', () => ({
	authFetch: vi.fn(async () => new Response('{}', { status: 500 }))
}));

let host: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
	licenseGate.clear();
	activeTenant.current = null; // NOT clear() — that calls location.reload()
	locale.current = 'en';
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	vi.clearAllMocks();
});

function screen(): string {
	app = mount(LicenseBlocked, { target: host, props: {} });
	flushSync();
	return host.textContent ?? '';
}

function buttons(): string[] {
	return [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
}

describe('LicenseBlocked — a licence we cannot READ is neither an outage nor an expiry', () => {
	it('THE DEFECT — it must not promise that access resumes automatically', () => {
		licenseGate.handleForbidden('license_unreadable');
		const text = screen();

		// The outage promise, verbatim from `license_blocked_body_unavailable` (en). This is the
		// sentence that was false for a standing fault.
		expect(text).not.toContain('Access resumes automatically');
		expect(text).not.toContain('License check unavailable');
		// …and it must not fall back to accusing a paying customer of not having a licence.
		expect(text).not.toContain('doesn’t have an active Common Practice license');

		// What it says instead.
		expect(text).toContain('License check needs an administrator');
		expect(text).toContain('cannot be read');
	});

	it('offers NO action that cannot help — no Renew, no Try again', () => {
		// Renewing cannot repair a blob we cannot decrypt (the licence upstream is fine); retrying
		// cannot either (the master key is what is wrong). Offering either is the same false promise
		// wearing a button. The only honest control left is Log out.
		licenseGate.handleForbidden('license_unreadable');
		screen();
		expect(buttons()).toEqual(['Log out']);
	});

	it('⛔ NON-VACUITY — a real outage and a real expiry are UNCHANGED', () => {
		// Rendering the unreadable copy unconditionally would satisfy both tests above while
		// destroying the two states this screen already got right.
		licenseGate.handleForbidden('license_unavailable');
		const outage = screen();
		expect(outage).toContain('License check unavailable');
		expect(outage).toContain('Access resumes automatically');
		expect(buttons()).toEqual(['Try again', 'Log out']);

		if (app) unmount(app);
		app = undefined;
		host.innerHTML = '';
		licenseGate.clear();

		licenseGate.handleForbidden('license_expired');
		const expired = screen();
		expect(expired).toContain('License expired');
		expect(buttons()).toEqual(['Renew license', 'Log out']);
	});

	it('⛔ A LATER TRANSPORT BLIP MUST NOT RELABEL IT "try again"', () => {
		// Gate 2 runs on every request. During a key rotation a dozen requests report
		// `license_unreadable`; one of them can still time out against the licences service and
		// report `license_unavailable` instead. If that blip won, the standing fault would be
		// dressed back up as the self-healing one — this bug, restored by a race.
		licenseGate.handleForbidden('license_unreadable');
		licenseGate.handleForbidden('license_unavailable');

		expect(licenseGate.blockedByUnreadable).toBe(true);
		expect(licenseGate.blockedByOutage).toBe(false);
		expect(screen()).toContain('License check needs an administrator');
	});

	it('⛔ …but an AUTHORITATIVE commercial verdict still outranks it', () => {
		// The mirror of the rule above, and the reason `blockReason` is ranked rather than
		// last-write-wins: an answer that came FROM the licences service is the one answer we know is
		// about the customer rather than about us.
		licenseGate.handleForbidden('license_unreadable');
		licenseGate.handleForbidden('license_expired');

		expect(licenseGate.blockedByUnreadable).toBe(false);
		const text = screen();
		expect(text).toContain('License expired');
		expect(text).not.toContain('License check needs an administrator');
	});

	it('the block itself is NOT relaxed — this changes the words, never the wall', () => {
		// The backend denies either way; letting the user into the shell would just produce a page of
		// failing requests.
		licenseGate.handleForbidden('license_unreadable');
		expect(licenseGate.isBlocked).toBe(true);
	});
});
