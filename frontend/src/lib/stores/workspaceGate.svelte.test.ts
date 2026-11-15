// Unit test for the workspace-suspension gate: the pure `isSuspendedResponse` predicate and the
// sticky `WorkspaceGate` latch. No DOM and no network — the store deliberately imports nothing, so
// this runs in the default node environment with no mocks at all.
//
// ⛔ THE PREDICATE IS TESTED IN BOTH DIRECTIONS ON PURPOSE.
// Each half of `status === 403 && code === 'tenant_suspended'` guards a distinct, expensive failure:
//   - drop the CODE check and every ordinary permission denial in the product (role checks,
//     ownership checks — all plain 403s) turns into a full-screen "your workspace is suspended"
//     wall for a perfectly active customer;
//   - drop the STATUS check and any other response that happens to carry this string can flip the
//     SPA into that same wall.
// A one-sided test (only the true case) passes against BOTH mutants, so the false cases below are
// the ones actually doing the work.
import { describe, it, expect } from 'vitest';
import {
	WorkspaceGate,
	isSuspendedResponse,
	isSuspendedApiError,
	TENANT_SUSPENDED_CODE
} from './workspaceGate.svelte';

describe('isSuspendedResponse', () => {
	it('is TRUE for 403 + tenant_suspended — the one shape the backend gate emits', () => {
		expect(isSuspendedResponse(403, 'tenant_suspended')).toBe(true);
	});

	it('uses the same literal the interceptor imports', () => {
		// Guards against the predicate and the exported constant drifting apart (e.g. someone fixes a
		// typo in one place only). The interceptor test asserts against this constant too.
		expect(isSuspendedResponse(403, TENANT_SUSPENDED_CODE)).toBe(true);
	});

	it('⛔ is FALSE for a 403 carrying ANY OTHER code — ordinary permission denials must not block', () => {
		// 403 is this app's normal "you may not do that" answer. If the status alone were enough,
		// every role/ownership rejection would replace the app with the suspension screen.
		expect(isSuspendedResponse(403, 'forbidden')).toBe(false);
		expect(isSuspendedResponse(403, 'insufficient_role')).toBe(false);
		expect(isSuspendedResponse(403, 'license_tenant_mismatch')).toBe(false);
		// Near-misses: a substring and a prefix of the real code must not match either.
		expect(isSuspendedResponse(403, 'tenant')).toBe(false);
		expect(isSuspendedResponse(403, 'tenant_suspended_at')).toBe(false);
	});

	it('⛔ is FALSE for 402 + tenant_suspended — the STATUS is load-bearing, not decoration', () => {
		expect(isSuspendedResponse(402, 'tenant_suspended')).toBe(false);
	});

	it('is FALSE for the 503 tenant_status_unavailable sibling', () => {
		// The gate could not READ the status. Fails closed like `license_unavailable`, but latching
		// the suspension screen on it would accuse an active customer of being switched off — a claim
		// no reload can clear while the outage lasts.
		expect(isSuspendedResponse(503, 'tenant_status_unavailable')).toBe(false);
		// …and not even when a 503 somehow carries the suspended code.
		expect(isSuspendedResponse(503, 'tenant_suspended')).toBe(false);
	});

	it('is FALSE when the code is missing entirely', () => {
		// A 403 with a non-JSON or empty body reaches the predicate as `undefined`. `undefined` must
		// never compare equal to the code.
		expect(isSuspendedResponse(403, undefined)).toBe(false);
	});

	it('is FALSE for a plain success', () => {
		expect(isSuspendedResponse(200, undefined)).toBe(false);
		expect(isSuspendedResponse(200, 'tenant_suspended')).toBe(false);
	});
});

describe('isSuspendedApiError — an EXPLAINED state is not a failure', () => {
	// ⛔ WHY THIS PREDICATE EXISTS, AND WHAT REGRESSES WITHOUT IT.
	// `/api/me` is a gated call, so a suspended workspace makes AuthState.initialize() throw. That
	// catch used to do two wrong things for a state the product fully understands and is already
	// explaining on screen: console.error("[auth] initialize failed") — noise that fires for every
	// suspended user and sends a reader hunting a broken token — and set `auth.error` to "we could
	// not load your profile", which is FALSE. Nobody sees that string today only because
	// routes/+layout.svelte evaluates the suspension branch first; reorder those two branches and a
	// suspended customer is told their profile failed to load instead of the truth.
	// Found by driving a real browser against a live suspended tenant. The suite was green.
	it('is TRUE for the ApiError shape the gate produces (403 + tenant_suspended)', () => {
		expect(isSuspendedApiError({ status: 403, code: TENANT_SUSPENDED_CODE })).toBe(true);
	});

	it('⛔ is FALSE for a 403 carrying any OTHER code — a real profile failure must still be reported', () => {
		for (const code of ['tenant_not_provisioned', 'tenant_admin_required', 'license_app_mismatch']) {
			expect(isSuspendedApiError({ status: 403, code }), code).toBe(false);
		}
	});

	it('⛔ is FALSE for the 503 sibling — a lookup outage is NOT a suspension', () => {
		expect(isSuspendedApiError({ status: 503, code: 'tenant_status_unavailable' })).toBe(false);
	});

	it('is FALSE for values that are not errors at all', () => {
		for (const v of [null, undefined, 'tenant_suspended', 42, {}, { code: TENANT_SUSPENDED_CODE }]) {
			expect(isSuspendedApiError(v)).toBe(false);
		}
	});
});

describe('WorkspaceGate latch', () => {
	it('starts unsuspended', () => {
		expect(new WorkspaceGate().isSuspended).toBe(false);
	});

	it('flips when tripped', () => {
		const gate = new WorkspaceGate();
		gate.handleSuspended();
		expect(gate.isSuspended).toBe(true);
	});

	it('⛔ STAYS flipped — the latch is one-way, and that is what stops the block flickering', () => {
		// The app fires many requests in parallel and several hit endpoints the tenant gate exempts.
		// A success arriving after a 403 must NOT lower the block, or the next gated request raises it
		// again: a flap loop that renders the app as a strobing half-shell. Nothing but a reload or a
		// sign-out clears this, so there is deliberately no "handleOk" to call here — the proof is
		// that repeated trips are idempotent and no other method exists to lower it.
		const gate = new WorkspaceGate();
		gate.handleSuspended();
		gate.handleSuspended();
		gate.handleSuspended();
		expect(gate.isSuspended).toBe(true);
	});

	it('clear() resets it (sign-out / test teardown only — no response handler calls this)', () => {
		const gate = new WorkspaceGate();
		gate.handleSuspended();
		gate.clear();
		expect(gate.isSuspended).toBe(false);
	});

	it('two gates are independent — the flag is instance state, not module state', () => {
		const a = new WorkspaceGate();
		const b = new WorkspaceGate();
		a.handleSuspended();
		expect(b.isSuspended).toBe(false);
	});
});
