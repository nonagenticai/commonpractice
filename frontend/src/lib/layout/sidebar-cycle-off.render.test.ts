// @vitest-environment jsdom
//
// src/lib/layout/sidebar-cycle-off.render.test.ts — the sidebar hides the winner screen when the
// voting cycle cadence is OFF (backend `cycle.cadence`, 0107, carried on /api/me as `cycleCadence`).
//
// Rendered, not grepped: the defect this pins lives at the CALL SITE (Sidebar.svelte must pass the
// cadence into W2's `sidebarNav(roles, { cycleOn })` hook), so a unit test of `cycleOnFor` alone
// could stay green with the wiring removed. Restoring the original line —
// `sidebarNav(auth.user?.roles ?? [])` with no context — turns the first case red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { cycleOnFor } from './cycle-nav';
import { sidebarNav, settingsGroups } from './navConfig';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});
// Kit 3 replaced `$app/stores` with the reactive `$app/state` object.
vi.mock('$app/state', async () => {
	return { page: { url: new URL('http://localhost/') } };
});
const { authState } = vi.hoisted(() => ({
	authState: {
		user: { roles: ['employee'], name: 'Mo Member', email: 'mo@x.test', counts: {}, cycleCadence: 'off' as string | undefined },
		isSuperAdmin: false,
		isTenantAdmin: false,
		isDeveloper: false,
		logout: () => {}
	}
}));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: authState }));

import Sidebar from './Sidebar.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
function render() {
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Sidebar, { target: host, props: {} }) as Record<string, unknown>;
	flushSync();
}
const hasWinnerLink = () => !!host.querySelector('a[href="/winner"]');

beforeEach(() => {
	authState.user.cycleCadence = 'off';
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

describe('sidebar · voting cycle off', () => {
	it('⛔ OFF: no link to the winner screen', () => {
		render();
		expect(host.querySelector('a[href="/challenges"]'), 'the sidebar rendered at all').not.toBeNull();
		expect(hasWinnerLink()).toBe(false);
	});

	it('week / month / year, and an older backend with no cadence: the winner link stays', () => {
		for (const c of ['week', 'month', 'year', undefined]) {
			authState.user.cycleCadence = c;
			render();
			expect(hasWinnerLink(), `cadence=${String(c)}`).toBe(true);
			unmount(app!);
			app = undefined;
			host.remove();
		}
	});
});

describe('cycleOnFor → sidebarNav', () => {
	it('drops only cycle-only items, and only when off', () => {
		const ids = (cadence: string | undefined) =>
			sidebarNav(['super_admin'], { cycleOn: cycleOnFor(cadence) }).sections.flatMap((s) => s.items.map((i) => i.id));
		expect(ids('week')).toContain('winner');
		expect(ids('off')).not.toContain('winner');
		expect(ids('off').length).toBe(ids('week').length - 1);
		expect(ids('month')).toEqual(ids('week'));
		expect(ids('year')).toEqual(ids('week'));
		expect(ids(undefined)).toEqual(ids('week'));
		expect([cycleOnFor('off'), cycleOnFor(null), cycleOnFor(undefined)]).toEqual([false, true, true]);
	});

	it('the cadence control (Governance → Voting cycle) stays reachable from /settings for super_admin, cycle off included', () => {
		// Turning the cycle OFF must never hide the switch that turns it back on.
		const platform = settingsGroups(['super_admin']).find((g) => g.key === 'platform');
		expect(platform?.items.map((i) => i.href)).toContain('/governance');
		for (const c of ['off', 'week', 'month', 'year']) {
			const settings = sidebarNav(['super_admin'], { cycleOn: cycleOnFor(c) }).settings;
			expect(settings.map((i) => i.href), `cadence=${c}`).toContain('/governance');
		}
		expect(settingsGroups(['tenant_admin']).flatMap((g) => g.items).map((i) => i.href)).not.toContain('/governance');
	});
});
