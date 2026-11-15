// @vitest-environment jsdom
// src/routes/license-upgrade/license-upgrade.render.test.ts
//
// ⛔ WHAT THIS PROVES, AND WHY A UNIT TEST ON `licenseCopy` IS NOT ENOUGH.
// The defect was never in the mapping — it was that THIS PAGE did not use it. `/license-upgrade`
// kept a two-branch ternary over `licenseGate.state` while `LicenseBlocked.svelte` was widened to
// four outcomes across #252/#255/#258. So the assertion has to be made against the RENDERED PAGE
// with the store in each state, not against a pure function the page might not be calling.
//
// THE JOURNEY THAT MAKES THIS REACHABLE. This page is the target of `LICENSE_RENEW_URL`
// (licenseGate.svelte.ts:289-290). During a licences-service outage a super-admin acting as another
// tenant still gets the Renew button — `LicenseBlocked.svelte` gates it only on
// `!copy.renewIsPointless` inside the `activeTenant.current` branch. Renew is a client-side `goto`,
// so the store (and therefore `blockReason`) survives the navigation. Before this change the reader
// went from an honest "we can't complete the licence check right now" to "your workspace has no
// active licence" in one click.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockReason, LicenseGateState } from '$lib/stores/licenseGate.svelte';

// The real catalog is not needed — identity keys make an assertion failure name the message that
// was picked, which is exactly what this test is about. Same technique as winner-page.render.test.
vi.mock('$lib/paraglide/messages', () => ({
	license_blocked_heading_unavailable: () => 'HEADING_UNAVAILABLE',
	license_blocked_body_unavailable: () => 'BODY_UNAVAILABLE',
	license_blocked_heading_unreadable: () => 'HEADING_UNREADABLE',
	license_blocked_body_unreadable: () => 'BODY_UNREADABLE',
	license_blocked_heading_expired: () => 'HEADING_EXPIRED',
	error_license_expired: () => 'BODY_EXPIRED',
	license_blocked_heading_none: () => 'HEADING_NONE',
	// Not exercised by a case below today, but this mock REPLACES the module wholesale: an omitted
	// export is `undefined`, so the first seat-reason render added here would die on a TypeError
	// rather than on the assertion it was written to make.
	license_blocked_heading_seat: () => 'HEADING_SEAT',
	error_license_seat_required: () => 'BODY_SEAT',
	license_blocked_renew: () => 'RENEW',
	license_expiring_days: (a: { days: number }) => `EXPIRING_DAYS(${a.days})`,
	license_expiring_soon: () => 'EXPIRING_SOON',
	error_license_required: () => 'BODY_REQUIRED',
}));

const gate = { blockReason: null as BlockReason, state: 'unknown' as LicenseGateState, daysRemaining: null as number | null };
vi.mock('$lib/stores/licenseGate.svelte', () => ({ licenseGate: gate }));

let host: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

afterEach(() => {
	if (app) unmount(app);
	host?.remove();
	app = null;
	host = null;
});

async function render(reason: BlockReason, state: LicenseGateState, daysRemaining: number | null = null) {
	gate.blockReason = reason;
	gate.state = state;
	gate.daysRemaining = daysRemaining;
	const Page = (await import('./+page.svelte')).default;
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	flushSync();
	return host;
}

const text = (el: HTMLElement) => el.textContent ?? '';

describe('/license-upgrade renders the precise licence state', () => {
	it('⛔ an OUTAGE must not be reported as "you have no licence"', async () => {
		const el = await render('outage', 'unknown');
		expect(text(el)).toContain('HEADING_UNAVAILABLE');
		expect(text(el)).toContain('BODY_UNAVAILABLE');
		// The regression, stated as its own assertion so a failure names it.
		expect(text(el)).not.toContain('HEADING_NONE');
		expect(text(el)).not.toContain('BODY_REQUIRED');
	});

	it('⛔ an UNREADABLE licence must not be reported as "you have no licence"', async () => {
		const el = await render('unreadable', 'unknown');
		expect(text(el)).toContain('HEADING_UNREADABLE');
		expect(text(el)).toContain('BODY_UNREADABLE');
		expect(text(el)).not.toContain('HEADING_NONE');
		expect(text(el)).not.toContain('BODY_REQUIRED');
	});

	it('an expiry still says expired — the fix must not flatten the terminal states', async () => {
		const el = await render('terminal', 'expired');
		expect(text(el)).toContain('HEADING_EXPIRED');
		expect(text(el)).toContain('BODY_EXPIRED');
	});

	it('a genuinely unlicensed workspace still says so', async () => {
		const el = await render('terminal', 'none');
		expect(text(el)).toContain('HEADING_NONE');
		expect(text(el)).toContain('BODY_REQUIRED');
	});

	// ⛔ THE TERMINAL DEFAULT IS *EXPIRED*, AND THIS PINS WHY — I inverted it once and
	// license-blocked.outage.render.test.ts:73 caught it. `handleForbidden` flattens every
	// commercial 402 into `'terminal'` and the status poll has not landed when the screen first
	// paints, so `state` is `'unknown'`. A workspace whose 402 said `license_expired` must not be
	// told it never had a licence. Only `state === 'none'` is positive evidence of that.
	it('a terminal block before the status poll lands says EXPIRED, not "never bought"', async () => {
		const el = await render('terminal', 'unknown');
		expect(text(el)).toContain('HEADING_EXPIRED');
		expect(text(el)).not.toContain('HEADING_NONE');
	});

	// Arriving with NO recorded reason at all is the direct-navigation case (nothing 402'd, so the
	// gate learned nothing). It follows the same default as any other non-`none` state.
	it('direct navigation with no recorded block reason still renders a terminal screen', async () => {
		const el = await render(null, 'unknown');
		expect(text(el)).toContain('HEADING_EXPIRED');
	});

	// ⛔⛔ THE REACHABLE ONE. `LicenseExpiringBanner` offers Renew for `expiring_soon` with no block
	// reason and navigates here, so this is a paying customer with days left on the clock.
	it('⛔ a customer whose licence is merely EXPIRING is not told it expired', async () => {
		const el = await render(null, 'expiring_soon', 5);
		expect(text(el)).not.toContain('HEADING_EXPIRED');
		expect(text(el)).not.toContain('BODY_EXPIRED');
		expect(text(el)).not.toContain('HEADING_NONE');
		expect(text(el)).toContain('EXPIRING_DAYS(5)');
	});

	it('⛔ nor is an ACTIVE one', async () => {
		const el = await render(null, 'active');
		expect(text(el)).not.toContain('HEADING_EXPIRED');
		expect(text(el)).not.toContain('HEADING_NONE');
	});

	// ⛔ SALES CANNOT FIX EITHER NON-COMMERCIAL CAUSE. Offering a sales mailto for an unreachable
	// service or an undecryptable blob is the same false promise as the Renew button that brought
	// the reader here.
	it('hides the sales contact exactly when renewing cannot help', async () => {
		for (const reason of ['outage', 'unreadable'] as const) {
			const el = await render(reason, 'unknown');
			expect(el.querySelector('.lu-contact'), `${reason} still offers a sales contact`).toBeNull();
			if (app) unmount(app);
			host?.remove();
			app = null;
			host = null;
		}
		const terminal = await render('terminal', 'expired');
		expect(terminal.querySelector('.lu-contact')).not.toBeNull();
	});
});
