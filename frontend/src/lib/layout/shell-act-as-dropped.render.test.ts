// @vitest-environment jsdom
//
// src/lib/layout/shell-act-as-dropped.render.test.ts — when /api/me refuses the acting workspace,
// the shell SAYS so.
//
// ⛔ THE BUG (2026-10-27). A super_admin's "Act as" on a workspace without an active licence was
// dropped after the reload (`activeTenantRejected`), and the operator landed back in their own
// workspace with nothing on screen: no "acting as" bar, no reason. George: the UI must never
// silently diverge from what the backend does. The drop is recorded (`activeTenant.dropped`) and
// rendered here with the reason, until dismissed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const stub = (key: string) => (params?: Record<string, unknown>) =>
		params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = stub(key);
	return mod;
});
vi.mock('$app/navigation', () => ({ goto: vi.fn(), afterNavigate: () => {} }));
// Kit 3 replaced `$app/stores` with the reactive `$app/state` object.
vi.mock('$app/state', async () => {
	return { page: { url: new URL('http://localhost/') } };
});
vi.mock('$lib/api/search', () => ({ searchApi: { query: vi.fn() } }));
vi.mock('$lib/layout/NotificationBell.svelte', () => ({ default: function Noop() {} }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		user: { roles: ['super_admin'], name: 'Pat Admin', email: 'pat@x.test', counts: {} },
		isSuperAdmin: true,
		isTenantAdmin: true,
		isDeveloper: true,
		logout: vi.fn()
	}
}));

const { activeTenant } = vi.hoisted(() => ({
	activeTenant: {
		current: null as { id: string; name: string } | null,
		dropped: null as { name: string; code: string } | null,
		clear: () => {},
		dismissDropped: () => {}
	}
}));
vi.mock('$lib/stores/activeTenant.svelte', () => ({ activeTenant }));

import ShellLayout from './ShellLayout.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

function render() {
	app = mount(ShellLayout, {
		target: host,
		props: { children: createRawSnippet(() => ({ render: () => '<p>page</p>' })) }
	}) as Record<string, unknown>;
	flushSync();
}

beforeEach(() => {
	activeTenant.current = null;
	activeTenant.dropped = null;
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

const notice = () => host.querySelector<HTMLElement>('[data-testid="acting-dropped"]');

describe('a refused acting workspace is announced, not swallowed', () => {
	it('⛔ dropped for no licence: the notice names the workspace and the licence reason', () => {
		activeTenant.dropped = { name: 'Acme', code: 'license_required' };
		render();
		expect(notice(), 'the drop was silent').not.toBeNull();
		expect(notice()!.textContent).toContain('shell_act_as_dropped:Acme,act_as_reason_licence');
		expect(notice()!.getAttribute('role')).toBe('alert');
	});

	it('dismiss calls the store', () => {
		activeTenant.dropped = { name: 'Acme', code: 'tenant_suspended' };
		const spy = vi.spyOn(activeTenant, 'dismissDropped');
		render();
		notice()!.querySelector('button')!.click();
		expect(spy).toHaveBeenCalledOnce();
	});

	it('nothing dropped: no notice', () => {
		render();
		expect(notice()).toBeNull();
	});
});
