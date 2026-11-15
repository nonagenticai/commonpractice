// Unit test for the auth-fetch license-gate interceptor: a 402 carrying a `license_*` enforcement
// code trips licenseGate.handleForbidden() so a mid-session expiry blocks immediately. keycloak +
// paraglide runtime are mocked (no real browser), and the license gate store is mocked to a spy so
// we assert the WIRING (clone+parse+path-guard+call), not the rune store itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handleForbiddenSpy, handleSuspendedSpy, handleNoWorkspaceSpy } = vi.hoisted(() => ({
	handleForbiddenSpy: vi.fn(),
	handleSuspendedSpy: vi.fn(),
	handleNoWorkspaceSpy: vi.fn()
}));

vi.mock('$lib/services/keycloak', () => ({ ensureFreshToken: async () => undefined }));
vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => 'en' }));
vi.mock('$lib/stores/licenseGate.svelte', () => ({
	licenseGate: { handleForbidden: handleForbiddenSpy },
	// the real, tiny predicate (also unit-tested in licenseGate.test.ts)
	isLicenseBlockResponse: (status: number, code: string | undefined) =>
		status === 402 &&
		code != null &&
		new Set(['license_required', 'license_inactive', 'license_expired', 'license_unavailable']).has(code)
}));
vi.mock('$lib/stores/workspaceGate.svelte', () => ({
	workspaceGate: { handleSuspended: handleSuspendedSpy, handleNoWorkspace: handleNoWorkspaceSpy },
	// the real, tiny predicate (also unit-tested in workspaceGate.svelte.test.ts) — kept literal here
	// rather than re-exported from the real module so this file asserts the WIRING only.
	isSuspendedResponse: (status: number, code: string | undefined) =>
		status === 403 && code === 'tenant_suspended',
	isNoWorkspaceResponse: (status: number, code: string | undefined) =>
		status === 403 && code === 'no_workspace',
	TENANT_SUSPENDED_CODE: 'tenant_suspended'
}));

import { authFetch } from './auth-fetch';

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('authFetch license-gate interceptor', () => {
	beforeEach(() => {
		handleForbiddenSpy.mockReset();
		handleSuspendedSpy.mockReset();
	});

	it('trips the gate on a 402 license_expired', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'license_expired' }, 402)));
		const res = await authFetch('/api/flows');
		expect(handleForbiddenSpy).toHaveBeenCalledTimes(1);
		// the caller still receives an unconsumed body (we cloned to inspect)
		await expect(res.json()).resolves.toEqual({ error: 'license_expired' });
	});

	it('⛔ FORWARDS THE CODE — the interceptor is where an outage becomes distinguishable', async () => {
		// The render tests for LicenseBlocked call `handleForbidden(code)` directly, so they stay green
		// even if this call site drops the argument. This is the seam that would silently un-fix the
		// bug: without the code, `license_unavailable` collapses back into the terminal "your licence
		// expired" wall shown to a paid-up customer.
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'license_unavailable' }, 402)));
		await authFetch('/api/solutions');
		expect(handleForbiddenSpy).toHaveBeenCalledTimes(1);
		expect(handleForbiddenSpy).toHaveBeenCalledWith('license_unavailable');
	});

	it('forwards a TERMINAL code unchanged too, so the genuine expiry path is unaffected', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'license_expired' }, 402)));
		await authFetch('/api/solutions');
		expect(handleForbiddenSpy).toHaveBeenCalledWith('license_expired');
	});

	it('does NOT trip on a 200', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true }, 200)));
		await authFetch('/api/flows');
		expect(handleForbiddenSpy).not.toHaveBeenCalled();
	});

	it('does NOT trip on a 402 that is not a license code', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'quota_exceeded' }, 402)));
		await authFetch('/api/flows');
		expect(handleForbiddenSpy).not.toHaveBeenCalled();
	});

	it('does NOT trip on the status endpoint itself (no loop)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'license_required' }, 402)));
		await authFetch('/api/license/status');
		expect(handleForbiddenSpy).not.toHaveBeenCalled();
	});

	it('tolerates a 402 with a non-JSON body without throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 402 })));
		await expect(authFetch('/api/flows')).resolves.toBeInstanceOf(Response);
		expect(handleForbiddenSpy).not.toHaveBeenCalled();
	});
});

// The tenant-lifecycle sibling of the block above. Same shape (clone + parse + predicate + call),
// different status and a much narrower code, and it must not disturb the licence path.
describe('authFetch workspace-suspension interceptor', () => {
	beforeEach(() => {
		handleForbiddenSpy.mockReset();
		handleSuspendedSpy.mockReset();
	});

	it('trips the gate on a 403 tenant_suspended', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'tenant_suspended' }, 403)));
		await authFetch('/api/flows');
		expect(handleSuspendedSpy).toHaveBeenCalledTimes(1);
	});

	it('⛔ LEAVES THE BODY READABLE — this is the res.clone() regression', async () => {
		// The interceptor has to read the body to see the code. Reading it off the ORIGINAL response
		// consumes the single-use stream, so every caller downstream gets "Body is already used" on a
		// response that looks, from the outside, perfectly normal. Cloning is the whole contract; this
		// assertion is what fails if someone "simplifies" the `.clone()` away.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({ error: 'tenant_suspended', detail: 'by operator' }, 403))
		);
		const res = await authFetch('/api/flows');
		expect(res.bodyUsed).toBe(false);
		await expect(res.json()).resolves.toEqual({
			error: 'tenant_suspended',
			detail: 'by operator'
		});
	});

	it('⛔ does NOT trip on a 403 with a DIFFERENT code — ordinary permission denials stay ordinary', async () => {
		// Without this, every role/ownership rejection in the product becomes a full-screen
		// "your workspace is suspended" wall.
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'insufficient_role' }, 403)));
		const res = await authFetch('/api/flows');
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
		// …and that caller still gets its body, so the normal error path can render the real reason.
		await expect(res.json()).resolves.toEqual({ error: 'insufficient_role' });
	});

	it('does NOT trip on the 503 tenant_status_unavailable sibling', async () => {
		// Fails closed server-side, but it means "could not read the status", not "an operator
		// suspended you". Latching the block here would accuse an active customer.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({ error: 'tenant_status_unavailable' }, 503))
		);
		await authFetch('/api/flows');
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
	});

	it('does NOT trip on a 200', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true }, 200)));
		await authFetch('/api/flows');
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
	});

	it('tolerates a 403 with a non-JSON body without throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));
		await expect(authFetch('/api/flows')).resolves.toBeInstanceOf(Response);
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
	});

	it('the two gates do not cross-fire', async () => {
		// One request cannot be both a 402 and a 403, and neither interceptor may claim the other's
		// response. Pins that adding the second interceptor did not widen the first.
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'tenant_suspended' }, 403)));
		await authFetch('/api/flows');
		expect(handleForbiddenSpy).not.toHaveBeenCalled();

		handleSuspendedSpy.mockReset();
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'license_expired' }, 402)));
		await authFetch('/api/flows');
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
	});
});

describe('authFetch no-workspace interceptor', () => {
	beforeEach(() => {
		handleSuspendedSpy.mockReset();
		handleNoWorkspaceSpy.mockReset();
		vi.stubGlobal('fetch', vi.fn());
	});

	it('latches on 403 no_workspace and leaves the suspension gate alone', async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse({ error: 'no_workspace', message: 'x' }, 403)
		);
		const res = await authFetch('/api/challenges');
		expect(handleNoWorkspaceSpy).toHaveBeenCalledTimes(1);
		expect(handleSuspendedSpy).not.toHaveBeenCalled();
		// the caller still gets an unconsumed body
		expect(await res.json()).toMatchObject({ error: 'no_workspace' });
	});

	it('does not latch on an ordinary 403', async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse({ error: 'tenant_admin_required', message: 'x' }, 403)
		);
		await authFetch('/api/challenges');
		expect(handleNoWorkspaceSpy).not.toHaveBeenCalled();
	});
});
