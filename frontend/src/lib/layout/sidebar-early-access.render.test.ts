// @vitest-environment jsdom
//
// src/lib/layout/sidebar-early-access.render.test.ts — the app shell's "Early access" badge and the
// "Feedback" link.
//
//   • the badge renders for every role (it is not a nav item, so no role gate can drop it);
//   • Feedback is a `mailto:` to the backend's SUPPORT_EMAIL (/api/me `supportEmail`), and it is NOT
//     rendered at all when that is unset — an address is never guessed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { feedbackMailto } from './feedback-link';

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
		user: {
			roles: ['member'] as string[],
			name: 'Mo Member',
			email: 'mo@x.test',
			counts: {},
			supportEmail: null as string | null | undefined
		},
		isSuperAdmin: false,
		isTenantAdmin: false,
		isDeveloper: false,
		logout: () => {}
	}
}));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: authState }));

import Sidebar from './Sidebar.svelte';

let host: HTMLElement | undefined;
let app: Record<string, unknown> | undefined;
function render(props: Record<string, unknown> = {}) {
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Sidebar, { target: host, props }) as Record<string, unknown>;
	flushSync();
	return host;
}
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
	authState.user.supportEmail = null;
	authState.user.roles = ['member'];
	authState.isSuperAdmin = false;
});

describe('sidebar · early access badge', () => {
	it('renders next to the product name, for a member and for a super_admin', () => {
		for (const [roles, superAdmin] of [[['member'], false], [['super_admin'], true]] as const) {
			authState.user.roles = [...roles];
			authState.isSuperAdmin = superAdmin;
			const h = render();
			const badge = h.querySelector('[data-testid="early-access-badge"]');
			expect(badge, `roles=${roles.join(',')}`).not.toBeNull();
			expect(badge!.textContent?.trim()).toBe('nav_early_access');
			expect(badge!.closest('.brand'), 'inside the brand (logo) block').not.toBeNull();
			unmount(app!);
			app = undefined;
			h.remove();
		}
	});
});

describe('sidebar · Feedback link', () => {
	it('⛔ SUPPORT_EMAIL unset (null / absent / empty): no Feedback link at all', () => {
		for (const v of [null, undefined, '', '   ']) {
			authState.user.supportEmail = v;
			const h = render();
			expect(h.querySelector('a[href="/challenges"]'), 'the sidebar rendered at all').not.toBeNull();
			expect(h.querySelector('[data-testid="nav-feedback"]'), `supportEmail=${JSON.stringify(v)}`).toBeNull();
			expect(h.querySelector('a[href^="mailto:"]')).toBeNull();
			unmount(app!);
			app = undefined;
			h.remove();
		}
	});

	it('SUPPORT_EMAIL set: a Feedback link with exactly that mailto', () => {
		authState.user.supportEmail = 'help@example.test';
		const h = render();
		const a = h.querySelector<HTMLAnchorElement>('[data-testid="nav-feedback"]');
		expect(a).not.toBeNull();
		expect(a!.getAttribute('href')).toBe('mailto:help@example.test');
		expect(a!.textContent?.trim()).toBe('nav_feedback');
	});

	it('collapsed rail: the link keeps its name as a tooltip', () => {
		authState.user.supportEmail = 'help@example.test';
		const h = render({ collapsed: true });
		expect(h.querySelector('[data-testid="nav-feedback"]')!.getAttribute('title')).toBe('nav_feedback');
	});
});

describe('feedbackMailto', () => {
	it('builds a mailto only from a plain address', () => {
		expect(feedbackMailto(' help@example.test ')).toBe('mailto:help@example.test');
		for (const bad of [null, undefined, '', 'nobody', 'a@b', 'x@y.z?subject=hi', 'a b@c.de', 'javascript:x@y.de']) {
			expect(feedbackMailto(bad), JSON.stringify(bad)).toBeNull();
		}
	});
});
