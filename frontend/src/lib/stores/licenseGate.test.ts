// Unit tests for the authoritative license gate store + the block-code predicate.
//
// We test the class directly (not the singleton) so each test gets a fresh instance. authFetch and
// $app/navigation are stubbed so handleForbidden()'s background load() never hits the network.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authFetchMock, gotoMock } = vi.hoisted(() => ({
	authFetchMock: vi.fn(),
	gotoMock: vi.fn()
}));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch: authFetchMock }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));

import {
	LicenseGate,
	isLicenseBlockResponse,
	LICENSE_BLOCK_CODES,
	type LicenseStatusResponse
} from './licenseGate.svelte';
import { activeTenant } from './activeTenant.svelte';

function resp(over: Partial<LicenseStatusResponse>): LicenseStatusResponse {
	return {
		appKey: 'commonpractice',
		gateEnabled: true,
		hasLicense: true,
		state: 'active',
		expiresAt: null,
		daysRemaining: null,
		planCode: null,
		...over
	};
}

describe('LicenseGate derivations', () => {
	let gate: LicenseGate;
	beforeEach(() => {
		gate = new LicenseGate();
		activeTenant.current = null; // not acting-as, unless a test says otherwise
		authFetchMock.mockReset();
		authFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
	});

	it('active ⇒ not blocked, not expiring, valid', () => {
		gate.status = resp({ state: 'active' });
		expect(gate.isBlocked).toBe(false);
		expect(gate.isExpiringSoon).toBe(false);
		expect(gate.isValid).toBe(true);
	});

	it('expiring_soon ⇒ banner, not blocked, still valid', () => {
		gate.status = resp({ state: 'expiring_soon', daysRemaining: 5, expiresAt: '2026-07-01T00:00:00Z' });
		expect(gate.isExpiringSoon).toBe(true);
		expect(gate.isBlocked).toBe(false);
		expect(gate.isValid).toBe(true);
		// The WORDS are the banner's job, not the store's: LicenseExpiringBanner.svelte reads
		// `daysRemaining` and renders `m.license_expiring_days({ days })`. See the no-prose guard.
		expect(gate.daysRemaining).toBe(5);
	});

	it.each(['expired', 'none'] as const)('%s ⇒ blocked', (state) => {
		gate.status = resp({ state, hasLicense: false });
		expect(gate.isBlocked).toBe(true);
		expect(gate.isValid).toBe(false);
	});

	it('expired ⇒ blocked, and the expiry instant is exposed as DATA for the component to format', () => {
		gate.status = resp({ state: 'expired', hasLicense: false, expiresAt: '2026-06-01T00:00:00Z' });
		expect(gate.isBlocked).toBe(true);
		// Raw ISO, untouched: nothing in this store decides how a date READS. See the no-prose guard.
		expect(gate.expiresAt).toBe('2026-06-01T00:00:00Z');
	});

	it('unknown (transient upstream error) ⇒ NOT blocked, treated as valid', () => {
		gate.status = resp({ state: 'unknown', hasLicense: false });
		expect(gate.isBlocked).toBe(false);
		expect(gate.isValid).toBe(true);
	});

	it('handleForbidden() blocks immediately (before any poll resolves)', () => {
		gate.status = resp({ state: 'active' });
		expect(gate.isBlocked).toBe(false);
		gate.handleForbidden();
		expect(gate.forcedBlocked).toBe(true);
		expect(gate.isBlocked).toBe(true);
	});

	it('a successful refresh to an entitled state clears a stale forced block', async () => {
		gate.handleForbidden(); // sets forcedBlocked + kicks a load()
		authFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(resp({ state: 'active' })), { status: 200 })
		);
		await gate.load();
		expect(gate.forcedBlocked).toBe(false);
		expect(gate.isBlocked).toBe(false);
	});

	it('load() never throws on network error and does not block', async () => {
		authFetchMock.mockRejectedValueOnce(new Error('network down'));
		gate.status = resp({ state: 'active' });
		await expect(gate.load()).resolves.toBeUndefined();
		expect(gate.isBlocked).toBe(false);
	});

	// ---- the acting-as exemption ----
	//
	// `state` comes from GET /api/license/status, which resolves the ACTING target. So for a
	// super_admin scope-switched into an unpaid tenant the poll raises the full-page overlay all by
	// itself — no 402 involved — and exempting the backend alone would leave the operator staring at
	// the same screen. The block exists to tell THE LICENSEE their workspace is unpaid; an operator
	// borrowing a tenant's scope is not that person.

	it.each(['expired', 'none'] as const)(
		'%s while ACTING AS another tenant ⇒ NOT blocked (per-screen 402s instead of a full-page wall)',
		(state) => {
			gate.status = resp({ state, hasLicense: false });
			expect(gate.isBlocked).toBe(true); // …when acting under your own tenant
			activeTenant.current = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Acme' };
			expect(gate.isBlocked).toBe(false);
		}
	);

	it('a live 402 (forcedBlocked) also does not wall the screen while acting-as', () => {
		activeTenant.current = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Acme' };
		gate.handleForbidden();
		expect(gate.forcedBlocked).toBe(true); // the signal is still recorded…
		expect(gate.isBlocked).toBe(false); // …it just does not take the whole app away
	});

	it('leaving the acting-as scope restores the block for the licensee', () => {
		gate.status = resp({ state: 'none', hasLicense: false });
		activeTenant.current = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Acme' };
		expect(gate.isBlocked).toBe(false);
		activeTenant.current = null;
		expect(gate.isBlocked).toBe(true);
	});

	// ⛔ 2026-10-13: a status about NO tenant was cached as a wall and survived the invite accept.
	it('no_workspace (no tenant resolved) ⇒ NOT blocked — it is not a licence verdict', () => {
		gate.status = resp({ state: 'no_workspace', hasLicense: false, tenantId: null });
		expect(gate.isBlocked).toBe(false);
	});

	it('load() of no_workspace does not label a block reason', async () => {
		authFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(resp({ state: 'no_workspace', hasLicense: false, tenantId: null })), {
				status: 200
			})
		);
		await gate.load();
		expect(gate.state).toBe('no_workspace');
		expect(gate.blockReason).toBeNull();
		expect(gate.isBlocked).toBe(false);
	});

	// ⛔ `peekEffectiveTenant` answers null on ANY auth error, so one auth blip mid-poll reads as
	// `no_workspace`. It must never be what unblocks an expired-licence user.
	describe('no_workspace never clears an existing block', () => {
		const noWorkspace = () =>
			new Response(JSON.stringify(resp({ state: 'no_workspace', hasLicense: false, tenantId: null })), {
				status: 200
			});

		it('blocked by a 402 (forced) → poll answers no_workspace → still blocked, reason kept', async () => {
			authFetchMock.mockResolvedValue(noWorkspace());
			gate.handleForbidden('license_expired');
			await vi.waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
			await gate.load();
			expect(gate.forcedBlocked).toBe(true);
			expect(gate.blockReason).toBe('terminal');
			expect(gate.isBlocked).toBe(true);
		});

		it('blocked by a terminal poll (expired) → next poll answers no_workspace → still blocked', async () => {
			authFetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(resp({ state: 'expired', hasLicense: false, tenantId: 'x' })), { status: 200 })
			);
			await gate.load();
			expect(gate.isBlocked).toBe(true);
			authFetchMock.mockResolvedValueOnce(noWorkspace());
			await gate.load();
			expect(gate.state).toBe('expired');
			expect(gate.blockReason).toBe('terminal');
			expect(gate.isBlocked).toBe(true);
		});

		it('fresh store + no_workspace → not blocked', async () => {
			authFetchMock.mockResolvedValueOnce(noWorkspace());
			await gate.load();
			expect(gate.state).toBe('no_workspace');
			expect(gate.forcedBlocked).toBe(false);
			expect(gate.isBlocked).toBe(false);
		});
	});

	describe('syncTenant (re-read when the status is about another tenant)', () => {
		const T = 'aaaaaaaa-0000-4000-8000-0000000000aa';
		const statusFor = (over: Partial<LicenseStatusResponse>) =>
			new Response(JSON.stringify(resp(over)), { status: 200 });

		it('cached status about NO tenant, user now seated ⇒ reset + a fresh read', async () => {
			gate.status = resp({ state: 'none', hasLicense: false, tenantId: null });
			authFetchMock.mockResolvedValueOnce(statusFor({ state: 'active', tenantId: T }));
			gate.syncTenant(T);
			expect(gate.status).toBeNull(); // the stale answer is gone at once, not after the round-trip
			await vi.waitFor(() => expect(gate.status?.tenantId).toBe(T));
			expect(authFetchMock).toHaveBeenCalledTimes(1);
			expect(gate.isBlocked).toBe(false);
		});

		it('same tenant (case-insensitively) ⇒ no request', () => {
			gate.status = resp({ state: 'active', tenantId: T.toUpperCase() });
			gate.syncTenant(T);
			expect(authFetchMock).not.toHaveBeenCalled();
		});

		it('a cached status WITHOUT tenantId (old backend mid-roll) is unknown ⇒ re-read, no crash', async () => {
			gate.status = resp({ state: 'none', hasLicense: false }); // no tenantId key at all
			authFetchMock.mockResolvedValueOnce(statusFor({ state: 'active' }));
			gate.syncTenant(T);
			await vi.waitFor(() => expect(gate.state).toBe('active'));
			expect(authFetchMock).toHaveBeenCalledTimes(1);
		});

		it('nothing cached and nothing in flight ⇒ nothing to do (the layout effect loads first)', () => {
			gate.syncTenant(T);
			expect(authFetchMock).not.toHaveBeenCalled();
		});

		it('an in-flight read from BEFORE the reset is dropped, not applied over the fresh one', async () => {
			let releaseStale!: (r: Response) => void;
			authFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (releaseStale = r)));
			const stale = gate.load(); // started while unseated
			authFetchMock.mockResolvedValueOnce(statusFor({ state: 'active', tenantId: T }));
			gate.syncTenant(T); // in flight ⇒ reset + reload
			await vi.waitFor(() => expect(gate.status?.tenantId).toBe(T));
			releaseStale(statusFor({ state: 'none', hasLicense: false, tenantId: null }));
			await stale;
			expect(gate.state).toBe('active');
			expect(gate.isBlocked).toBe(false);
			expect(gate.isLoading).toBe(false);
		});
	});

	it('clear() resets the gate', () => {
		gate.status = resp({ state: 'expired', hasLicense: false });
		gate.handleForbidden();
		gate.clear();
		expect(gate.status).toBeNull();
		expect(gate.forcedBlocked).toBe(false);
		expect(gate.state).toBe('unknown');
	});
});

describe('isLicenseBlockResponse (the 402 interceptor predicate)', () => {
	it('true only for a 402 carrying a license_* enforcement code', () => {
		for (const code of LICENSE_BLOCK_CODES) {
			expect(isLicenseBlockResponse(402, code)).toBe(true);
		}
		expect(isLicenseBlockResponse(402, 'license_required')).toBe(true);
		// ⛔ Named explicitly, not just via the set above: the loop is vacuously satisfied for a code
		// that is missing from LICENSE_BLOCK_CODES. Dropping `license_unreadable` from that set would
		// make the interceptor ignore the 402 entirely — no block, no message, just a page of failing
		// requests — which is how this code would silently become worse than the one it replaced.
		expect(isLicenseBlockResponse(402, 'license_unreadable')).toBe(true);
	});

	it('false for a non-402 status even with a license code', () => {
		expect(isLicenseBlockResponse(403, 'license_app_mismatch')).toBe(false);
		expect(isLicenseBlockResponse(200, 'license_required')).toBe(false);
		expect(isLicenseBlockResponse(500, 'license_expired')).toBe(false);
	});

	it('false for a 402 with no / an unrecognised code', () => {
		expect(isLicenseBlockResponse(402, undefined)).toBe(false);
		expect(isLicenseBlockResponse(402, 'some_other_payment_error')).toBe(false);
	});
});

describe('seat_pending — a seat being set up is blocked, labelled setup, never "ask for a seat"', () => {
	let gate: LicenseGate;
	beforeEach(() => {
		gate = new LicenseGate();
		activeTenant.current = null;
		authFetchMock.mockReset();
	});

	it('a polled seat_pending blocks with reason setup', async () => {
		authFetchMock.mockResolvedValue(
			new Response(JSON.stringify(resp({ state: 'seat_pending', hasLicense: false })), { status: 200 })
		);
		await gate.load();
		expect(gate.isBlocked).toBe(true);
		expect(gate.blockReason).toBe('setup');
	});

	it("a later 402 license_seat_required does NOT relabel it 'seat'", async () => {
		authFetchMock.mockResolvedValue(
			new Response(JSON.stringify(resp({ state: 'seat_pending', hasLicense: false })), { status: 200 })
		);
		await gate.load();
		gate.handleForbidden('license_seat_required');
		expect(gate.blockReason).toBe('setup');
	});

	it('the seat landing (an entitled poll) lifts the block', async () => {
		authFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(resp({ state: 'seat_pending', hasLicense: false })), { status: 200 })
		);
		await gate.load();
		authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resp({ state: 'active' })), { status: 200 }));
		await gate.load();
		expect(gate.isBlocked).toBe(false);
		expect(gate.blockReason).toBeNull();
	});
});
