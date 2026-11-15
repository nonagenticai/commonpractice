// T9 — the licence chip decision on the platform /tenants screen (lib/admin/license-chip.ts).
//
// vitest runs with `environment: 'node'`, so this exercises the extracted PURE function rather than
// mounting the page. The branch that matters most is the last one: `licenseState === undefined` is
// the mixed-deploy guard (new frontend ↔ old backend, or any deployment with the licence gate off),
// and it is exactly the branch nobody would notice breaking.
import { describe, it, expect } from 'vitest';
import { licenseChipFor, type LicenseChipInput } from './license-chip';

const row = (over: Partial<LicenseChipInput> = {}): LicenseChipInput => ({
	licensed: true,
	...over
});

describe('licenseChipFor', () => {
	it('active ⇒ quiet grey chip, existing copy, click force-reissues', () => {
		expect(licenseChipFor(row({ licenseState: 'active', licenseHasToken: true }))).toEqual({
			tone: 'ok',
			label: 'ok',
			action: 'force'
		});
	});

	it('none + no token ⇒ loud coral "No licence", click issues', () => {
		expect(licenseChipFor(row({ licensed: false, licenseState: 'none', licenseHasToken: false }))).toEqual(
			{ tone: 'missing', label: 'missing', action: 'issue' }
		);
	});

	it('none + a STORED token ⇒ loud coral "Licence not active", click goes straight to FORCE', () => {
		// The 13 stranded prod tenants. A plain issue call reports `alreadyLicensed` and repairs
		// nothing, which is why `hasToken` is carried next to `state` at all.
		expect(licenseChipFor(row({ licensed: true, licenseState: 'none', licenseHasToken: true }))).toEqual({
			tone: 'missing',
			label: 'not_active',
			action: 'force'
		});
	});

	it('expired ⇒ loud coral "Licence not active", click goes straight to FORCE', () => {
		expect(licenseChipFor(row({ licenseState: 'expired', licenseHasToken: true }))).toEqual({
			tone: 'missing',
			label: 'not_active',
			action: 'force'
		});
	});

	it('unknown ⇒ MUTED (never coral) "Can\'t verify", and non-actionable', () => {
		const chip = licenseChipFor(row({ licenseState: 'unknown', licenseHasToken: true }));
		expect(chip).toEqual({ tone: 'muted', label: 'cannot_verify', action: null });
		expect(chip.tone).not.toBe('missing'); // a licences outage must not paint the estate coral
		expect(chip.action).toBeNull(); // …nor invite 19 needless force-reissues
	});

	// ---- the mixed-deploy guard ----

	it('licenseState undefined ⇒ EXACTLY today\'s legacy behaviour, both ways', () => {
		// REVERT THAT REDDENS THIS: drop the `licenseState === undefined` fallback (e.g. let it fall
		// into the `unknown`/default arm) — a new frontend against an old backend would then render
		// "Can't verify" for every tenant and offer no repair at all.
		expect(licenseChipFor({ licensed: true })).toEqual({ tone: 'ok', label: 'ok', action: 'force' });
		expect(licenseChipFor({ licensed: false })).toEqual({
			tone: 'missing',
			label: 'missing',
			action: 'issue'
		});
	});

	it('licenseHasToken is irrelevant when licenseState is absent (an old backend sends neither)', () => {
		expect(licenseChipFor({ licensed: true, licenseHasToken: undefined }).label).toBe('ok');
		expect(licenseChipFor({ licensed: false, licenseHasToken: undefined }).label).toBe('missing');
	});

	it('an unrecognised state from a NEWER backend says so, rather than guessing from `licensed`', () => {
		// Distinct from the `undefined` branch on purpose: "a state I do not understand" is not the
		// same claim as "this backend does not send states". Keeping them apart is also what makes
		// the test above falsifiable — otherwise deleting the guard would quietly land here.
		const future = { licensed: true, licenseState: 'suspended' } as unknown as LicenseChipInput;
		expect(licenseChipFor(future)).toEqual({ tone: 'muted', label: 'cannot_verify', action: null });
	});

	it('every label the chip can produce has a message key wired on the page', async () => {
		// Guards the Record<LicenseChipLabel, …> maps in tenants/+page.svelte against a new label
		// being added here and silently rendering `undefined`.
		const labels = new Set(
			(
				[
					{ licensed: true, licenseState: 'active' },
					{ licensed: false, licenseState: 'none', licenseHasToken: false },
					{ licensed: true, licenseState: 'none', licenseHasToken: true },
					{ licensed: true, licenseState: 'expired' },
					{ licensed: true, licenseState: 'unknown' }
				] as LicenseChipInput[]
			).map((t) => licenseChipFor(t).label)
		);
		expect([...labels].sort()).toEqual(['cannot_verify', 'missing', 'not_active', 'ok']);
	});
});
