// src/lib/api/auth-fetch.ts — attaches a fresh Bearer + the current locale on every
// request. Mirrors fr; trimmed of the multi-tenant X-Active-Tenant header (single-
// tenant app). Same-origin: /api/* is proxied to the backend by Vite (dev)/server.js.
// Accept-Language carries the live UI locale so backend content overlays (§5B,
// negotiateLocale) localize user-generated content — getLocale() is rebound to the
// reactive locale rune (stores/locale.svelte.ts), so it tracks the topbar switcher.
import { ensureFreshToken } from '$lib/services/keycloak';
import { getLocale } from '$lib/paraglide/runtime';
import { licenseGate, isLicenseBlockResponse } from '$lib/stores/licenseGate.svelte';
import {
	workspaceGate,
	isSuspendedResponse,
	isNoWorkspaceResponse
} from '$lib/stores/workspaceGate.svelte';
import { activeTenant } from '$lib/stores/activeTenant.svelte';

/** Best-effort request path (for the self-call guard), tolerant of string | URL | Request inputs. */
function requestPath(input: RequestInfo | URL): string {
	try {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		return new URL(raw, 'http://x').pathname;
	} catch {
		return '';
	}
}

/**
 * Global license-gate interceptor: when ANY request comes back 402 with a `license_*` error code
 * (the CP Gate-2 enforcement shape — see backend middleware/license-gate.ts), flip the SPA into its
 * blocked state so a mid-session expiry is caught immediately, even before the next status poll.
 *
 * - Idempotent: handleForbidden() just sets a flag + kicks a status refresh, so repeated 402s are
 *   harmless.
 * - No loop: the status endpoint (/api/license/status) is gate-exempt and never 402s a license code,
 *   and we skip it explicitly so its own load() can't re-trigger the interceptor.
 * - The response body is read from a CLONE so the caller still gets an unconsumed Response.
 */
async function maybeTripLicenseGate(res: Response, path: string): Promise<void> {
	if (res.status !== 402) return;
	if (path === '/api/license/status') return;
	let code: string | undefined;
	try {
		const body = (await res.clone().json()) as { error?: unknown };
		code = typeof body?.error === 'string' ? body.error : undefined;
	} catch {
		return; // non-JSON / empty 402 body — not a recognised license rejection
	}
	if (isLicenseBlockResponse(res.status, code)) {
		// ⚠️ THE CODE IS PASSED ON, AND IT MATTERS. `license_unavailable` means the licences service
		// was unreachable — the backend fails closed (middleware/license-gate.ts) so the request is
		// still denied, but the customer's licence is NOT expired and must not be described that way.
		// Without this argument every code collapsed into one terminal "your licence expired" wall.
		licenseGate.handleForbidden(code);
	}
}

/**
 * Global workspace-suspension interceptor — the sibling of `maybeTripLicenseGate` above, for the
 * tenant-lifecycle gate. When ANY request comes back 403 with the error code `tenant_suspended` (a
 * platform operator has suspended the caller's workspace), latch the SPA into its suspended state so
 * the root layout renders a full-screen explanation instead of a permission toast on a half-built
 * shell.
 *
 * ⛔ THE STATUS ALONE IS NOT THE SIGNAL. 403 is this app's ordinary "you may not do that" answer for
 * role and ownership checks, so this deliberately reads the body and requires the exact code
 * (`isSuspendedResponse` asserts both halves). Tripping on bare 403s would replace every permission
 * error in the product with a "your workspace is suspended" wall.
 *
 * - Idempotent: handleSuspended() sets one boolean and starts nothing, so the dozen parallel
 *   requests that all 403 in the same tick cost nothing after the first.
 * - No loop, and no self-call guard needed: unlike the licence gate there is no status endpoint to
 *   exempt, because this store never calls the API at all. The block is a render branch, never a
 *   navigation, so it cannot bounce the user anywhere.
 * - The response body is read from a CLONE so the caller still gets an unconsumed Response — the
 *   caller's own `res.json()` must still work after we have looked at the body.
 * - The 503 sibling code `tenant_status_unavailable` is intentionally NOT handled here; see
 *   TENANT_SUSPENDED_CODE in the store for why an unreadable status must not be rendered as an
 *   operator suspension.
 */
async function maybeTripWorkspaceGate(res: Response): Promise<void> {
	if (res.status !== 403) return;
	let code: string | undefined;
	try {
		const body = (await res.clone().json()) as { error?: unknown };
		code = typeof body?.error === 'string' ? body.error : undefined;
	} catch {
		return; // non-JSON / empty 403 body — an ordinary permission denial, not this gate
	}
	if (isSuspendedResponse(res.status, code)) {
		workspaceGate.handleSuspended();
	}
	// The signed-in person has no CP workspace — the root layout swaps to the invite screen.
	if (isNoWorkspaceResponse(res.status, code)) {
		workspaceGate.handleNoWorkspace();
	}
}

export async function authFetch(
	input: RequestInfo | URL,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	const token = await ensureFreshToken(30);
	if (token && !headers.has('Authorization')) {
		headers.set('Authorization', `Bearer ${token}`);
	}
	if (!headers.has('Accept-Language')) {
		try {
			headers.set('Accept-Language', getLocale());
		} catch {
			/* locale runtime not ready (very early boot) — backend falls back to en */
		}
	}
	// Super-admin scope-switch: when acting into another tenant, attach X-Active-Tenant-Id so
	// every tenant-scoped read/write runs under it. Backend honours it for super_admins only
	// (inert otherwise). An explicit per-call header (admin.ts withActiveTenant) still wins.
	if (!headers.has('X-Active-Tenant-Id') && activeTenant.id) {
		headers.set('X-Active-Tenant-Id', activeTenant.id);
	}
	const res = await fetch(input, { ...init, headers });
	await maybeTripLicenseGate(res, requestPath(input));
	await maybeTripWorkspaceGate(res);
	return res;
}
