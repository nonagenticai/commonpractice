// src/lib/stores/auth.licence-race.test.ts — a brand-new invitee must not inherit a licence wall
// that was read while CP had not seated them yet.
//
// ⛔ THE INCIDENT (prod 2026-10-13). A freshly created workspace's first admin set their password,
// accepted the invite (seated as tenant_admin; workspace licence and seat both active), clicked
// "Open app" and got the full-page "No active license". Three links, one test per layer below:
//   1. `initialize()` published `isAuthenticated = true` BEFORE /api/me answered. With `user` null,
//      `needsWorkspace` read false and +layout's licence `$effect` fired for an unseated person.
//   2. The backend answered that unseated read with `'none'` — a BLOCKED state — and the store
//      cached it. (Now `'no_workspace'`, which does not block, and the answer names its tenant.)
//   3. Accepting called `auth.refresh()`, which re-read /api/me but never the licence gate; the
//      layout only loads while `status` is null, so the stale wall is what "Open app" rendered.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readSource } from '$lib/test/source-scan';

const { initKeycloak, routes, statusCalls } = vi.hoisted(() => ({
	initKeycloak: vi.fn(async () => true),
	routes: new Map<string, () => Promise<Response>>(),
	statusCalls: { n: 0 }
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
vi.mock('$lib/api/auth-fetch', () => ({
	authFetch: vi.fn(async (url: string) => {
		const path = url.split('?')[0]!;
		if (path === '/api/license/status') statusCalls.n++;
		const handler = routes.get(path);
		return handler ? handler() : new Response('{}', { status: 200 });
	})
}));
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import { auth } from './auth.svelte';
import { licenseGate } from './licenseGate.svelte';
import { activeTenant } from './activeTenant.svelte';

const T = 'aaaaaaaa-0000-4000-8000-00000000c0de';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const unseated = {
	id: 'u1',
	email: 'new.admin@acme.test',
	name: 'New Admin',
	roles: [],
	tenantId: null,
	hasWorkspace: false,
	pendingInvites: [{ id: 'i1' }]
};
const seated = { ...unseated, roles: ['tenant_admin'], tenantId: T, tenantRole: 'tenant_admin', hasWorkspace: true, pendingInvites: [] };
const status = (state: string, tenantId: string | null | undefined) => ({
	appKey: 'commonpractice',
	gateEnabled: true,
	hasLicense: state === 'active',
	state,
	expiresAt: null,
	daysRemaining: null,
	planCode: null,
	...(tenantId === undefined ? {} : { tenantId })
});

beforeEach(() => {
	routes.clear();
	statusCalls.n = 0;
	activeTenant.current = null;
	licenseGate.reset();
	auth.isAuthenticated = false;
	auth.user = null;
	auth.error = null;
});

describe('layer 1 — isAuthenticated is never true while the profile is still unknown', () => {
	it('stays false until /api/me has answered, then flips with the user already set', async () => {
		let releaseMe!: (r: Response) => void;
		routes.set('/api/me', () => new Promise<Response>((r) => (releaseMe = r)));
		const done = auth.initialize();
		await vi.waitFor(() => expect(releaseMe).toBeTypeOf('function'));
		// The window the licence `$effect` used to fire in: Keycloak said yes, /api/me has not.
		expect(auth.isAuthenticated).toBe(false);
		expect(auth.user).toBeNull();
		releaseMe(json(unseated));
		await done;
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.user?.email).toBe(unseated.email);
		expect(auth.needsWorkspace).toBe(true);
	});

	it('a failed /api/me is still a SIGNED-IN user with an error (the profile banner), not signed out', async () => {
		routes.set('/api/me', async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await auth.initialize();
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.user).toBeNull();
		expect(auth.error).not.toBeNull();
	});

	it("+layout's licence $effect also refuses to load without a profile", () => {
		const src = readSource('routes/+layout.svelte');
		expect(src.length, 'the scan returned an empty layout').toBeGreaterThan(0);
		const effects = src.split('$effect(').slice(1);
		const loader = effects.filter((e) => e.slice(0, 400).includes('licenseGate.load()'));
		expect(loader, 'exactly one $effect loads the licence gate').toHaveLength(1);
		const cond = loader[0]!.slice(0, loader[0]!.indexOf('licenseGate.load()'));
		expect(cond).toContain('auth.user !== null');
	});
});

describe('the incident sequence: status read while unseated → accept → refresh', () => {
	// Layers 2 + 3: the new backend answers `no_workspace` (not blocked) naming tenant null, and
	// refresh re-reads because the tenant changed.
	it('new backend: unseated read is not a wall, and seating triggers a second status read', async () => {
		routes.set('/api/me', async () => json(unseated));
		routes.set('/api/license/status', async () => json(status('no_workspace', null)));
		await auth.initialize();
		await licenseGate.load(); // what the pre-fix $effect did in the race window
		expect(licenseGate.isBlocked).toBe(false);
		expect(statusCalls.n).toBe(1);

		// Accept (server side seats them) → the accept page calls auth.refresh().
		routes.set('/api/me', async () => json(seated));
		routes.set('/api/license/status', async () => json(status('active', T)));
		await auth.refresh();
		await vi.waitFor(() => expect(licenseGate.status?.tenantId).toBe(T));

		expect(statusCalls.n).toBe(2);
		expect(auth.needsWorkspace).toBe(false);
		expect(licenseGate.state).toBe('active');
		expect(licenseGate.isBlocked).toBe(false);
	});

	// Layer 3 on its own: even a BLOCKED cached answer (an old backend's `none`, no tenantId) must not
	// survive seating. This is the exact state prod was in.
	it('old backend: a cached `none` wall is dropped and re-read once the user is seated', async () => {
		routes.set('/api/me', async () => json(unseated));
		routes.set('/api/license/status', async () => json(status('none', undefined)));
		await auth.initialize();
		await licenseGate.load();
		expect(licenseGate.isBlocked).toBe(true); // the wall prod showed

		routes.set('/api/me', async () => json(seated));
		routes.set('/api/license/status', async () => json(status('active', undefined)));
		await auth.refresh();
		await vi.waitFor(() => expect(licenseGate.state).toBe('active'));

		expect(statusCalls.n).toBe(2);
		expect(licenseGate.isBlocked).toBe(false);
	});

	it('control: a refresh that does NOT change the tenant does not re-read', async () => {
		routes.set('/api/me', async () => json(seated));
		routes.set('/api/license/status', async () => json(status('active', T)));
		await auth.initialize();
		await licenseGate.load();
		await auth.refresh();
		expect(statusCalls.n).toBe(1);
	});
});
