// @vitest-environment jsdom
//
// src/lib/stores/auth.active-tenant.test.ts — the "acting as" selection belongs to ONE signed-in
// super_admin, and a stale one must never stop the app from starting.
//
// ⛔ THE INCIDENT (prod browser E2E 2026-10-14). `cp.activeTenant` survived sign-out, so the next
// person on that browser sent `X-Active-Tenant-Id` with every request; and a super_admin acting as a
// tenant that was later offboarded got 402 from /api/me — `initialize` failed and the app offered no
// way out. Each test below names the layer it pins.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { initKeycloak, me } = vi.hoisted(() => ({
	initKeycloak: vi.fn(async () => true),
	me: { handler: (_acting: string | null): Response => new Response('{}', { status: 500 }) }
}));
// Every name auth.svelte.ts imports from the service must exist here (an omitted ESM named import
// fails the whole module load) — same factory shape as auth.logout-redirect.test.ts.
vi.mock('$lib/services/keycloak', () => ({
	keycloak: null,
	initKeycloak,
	KeycloakConfigError: class KeycloakConfigError extends Error {},
	login: vi.fn(),
	logout: vi.fn(),
	ensureFreshToken: vi.fn(async () => undefined)
}));
// The real authFetch attaches `X-Active-Tenant-Id` from the store; this fake answers /api/me based
// on the same store value AT CALL TIME, which is what the header would have carried.
vi.mock('$lib/api/auth-fetch', async () => {
	const { activeTenant } = await import('$lib/stores/activeTenant.svelte');
	return {
		authFetch: vi.fn(async (url: string) =>
			url === '/api/me' ? me.handler(activeTenant.id) : new Response('{}', { status: 200 })
		)
	};
});
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import { auth } from './auth.svelte';
import { activeTenant } from './activeTenant.svelte';
import { licenseGate } from './licenseGate.svelte';

const KEY = 'cp.activeTenant';
const HOME = 'aaaaaaaa-0000-4000-8000-00000000a0e1';
const GONE = 'aaaaaaaa-0000-4000-8000-00000000a0e2';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const superAdmin = (id = 'super-1', extra: Record<string, unknown> = {}) => ({
	id,
	email: `${id}@cp.test`,
	name: id,
	roles: ['super_admin'],
	isSuperAdmin: true,
	tenantId: HOME,
	hasWorkspace: true,
	...extra
});
const memberUser = { id: 'member-1', email: 'm@cp.test', name: 'M', roles: ['member'], isSuperAdmin: false, tenantId: HOME, hasWorkspace: true };

/** Put a selection in the store the way a previous page load would have left it. */
function seed(sel: { id: string; name: string; ownerId?: string }) {
	localStorage.setItem(KEY, JSON.stringify(sel));
	activeTenant.current = sel;
}

beforeEach(() => {
	localStorage.clear();
	activeTenant.current = null;
	activeTenant.dropped = null;
	licenseGate.reset();
	auth.isAuthenticated = false;
	auth.user = null;
	auth.error = null;
});

describe('sign-out', () => {
	it('⛔ drops the acting-as selection, so the next person on this browser does not inherit it', () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		auth.logout();
		expect(activeTenant.current).toBeNull();
		expect(localStorage.getItem(KEY)).toBeNull();
	});
});

describe('initialize — a stale selection cannot brick the app', () => {
	it('⛔ an OLD backend 402s /api/me under the stale tenant: drop it, retry once, start normally', async () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		me.handler = (acting) =>
			acting ? json({ error: 'license_inactive', message: 'x' }, 402) : json(superAdmin());
		await auth.initialize();
		expect(auth.error).toBeNull();
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.user?.id).toBe('super-1');
		expect(activeTenant.current).toBeNull();
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(licenseGate.isBlocked).toBe(false);
	});

	it('the backend says it refused the acting tenant (activeTenantRejected): drop it', async () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		me.handler = () => json(superAdmin('super-1', { activeTenantRejected: 'tenant_offboarded' }));
		await auth.initialize();
		expect(auth.error).toBeNull();
		expect(activeTenant.current).toBeNull();
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it.each([
		['402 license_unavailable (licences outage)', 402, 'license_unavailable'],
		['429 rate limited', 429, 'rate_limited'],
		['500', 500, 'internal'],
		['503 tenant_status_unavailable', 503, 'tenant_status_unavailable']
	])('⛔ a TRANSIENT failure (%s) keeps a valid selection: no drop, no retry, the error surfaces', async (_l, status, code) => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		let calls = 0;
		me.handler = () => {
			calls++;
			return json({ error: code, message: 'x' }, status);
		};
		await auth.initialize();
		expect(calls).toBe(1);
		expect(auth.error).not.toBeNull();
		expect(activeTenant.current).toEqual({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		expect(localStorage.getItem(KEY)).not.toBeNull();
	});

	it('a 401 is the token, not the scope: no retry, the selection is not touched by the error path', async () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		let calls = 0;
		me.handler = () => {
			calls++;
			return json({ error: 'unauthorized' }, 401);
		};
		await auth.initialize();
		expect(calls).toBe(1);
		expect(auth.error).not.toBeNull();
	});
});

describe('initialize — the selection belongs to whoever made it', () => {
	it('⛔ made by a DIFFERENT super_admin: dropped', async () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		me.handler = () => json(superAdmin('super-2'));
		await auth.initialize();
		expect(activeTenant.current).toBeNull();
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it('⛔ the signed-in user is not a super_admin: dropped (for them it is only a leftover)', async () => {
		seed({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		me.handler = () => json(memberUser);
		await auth.initialize();
		expect(activeTenant.current).toBeNull();
	});

	it('the same super_admin keeps it; an unstamped legacy entry is adopted and stamped', async () => {
		seed({ id: GONE, name: 'Netcare' });
		me.handler = () => json(superAdmin('super-1'));
		await auth.initialize();
		expect(activeTenant.current).toEqual({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
		expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ id: GONE, name: 'Netcare', ownerId: 'super-1' });
	});
});

// ⛔ NEVER A SILENT DROP (George 2026-10-27). Measured: Act-as on a workspace with no active licence
// reloaded, /api/me answered `activeTenantRejected: license_required`, the selection was dropped and
// the operator was back in their own workspace with NOTHING on screen saying so. The drop stays (the
// backend refuses every tenant-admin route there); what it may not be is silent.
describe('a refused selection is dropped VISIBLY', () => {
	const UNLICENSED = 'aaaaaaaa-0000-4000-8000-00000000a0e3';

	it('⛔ activeTenantRejected: license_required → dropped AND recorded with the name and the reason', async () => {
		seed({ id: UNLICENSED, name: 'Acme', ownerId: 'super-1' });
		me.handler = () => json(superAdmin('super-1', { activeTenantRejected: 'license_required' }));
		await auth.initialize();
		expect(activeTenant.current).toBeNull();
		expect(activeTenant.dropped).toEqual({ name: 'Acme', code: 'license_required' });
	});

	it('an OLD backend 402s /api/me under the acting tenant: the drop is recorded with that code', async () => {
		seed({ id: UNLICENSED, name: 'Acme', ownerId: 'super-1' });
		me.handler = (acting) =>
			acting ? json({ error: 'license_inactive', message: 'x' }, 402) : json(superAdmin());
		await auth.initialize();
		expect(activeTenant.current).toBeNull();
		expect(activeTenant.dropped).toEqual({ name: 'Acme', code: 'license_inactive' });
	});

	it('a leftover from ANOTHER user is not a refusal: dropped without a notice (nothing to explain to this person)', async () => {
		seed({ id: UNLICENSED, name: 'Acme', ownerId: 'super-1' });
		me.handler = () => json(superAdmin('super-2'));
		await auth.initialize();
		expect(activeTenant.current).toBeNull();
		expect(activeTenant.dropped).toBeNull();
	});

	it('an admitted selection records nothing', async () => {
		seed({ id: UNLICENSED, name: 'Acme', ownerId: 'super-1' });
		me.handler = () => json(superAdmin('super-1'));
		await auth.initialize();
		expect(activeTenant.current?.id).toBe(UNLICENSED);
		expect(activeTenant.dropped).toBeNull();
	});
});
