// @vitest-environment jsdom
//
// src/lib/layout/sidebar.declutter.render.test.ts — the RENDERED sidebar is the short one (W2).
// navConfig.test.ts pins `sidebarNav`; this pins that Sidebar.svelte actually renders from it, so
// switching the component back to the old all-groups `visibleNav` loop reds here.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});
const { pageStore } = vi.hoisted(() => ({ pageStore: { url: new URL('http://localhost/') } }));
vi.mock('$app/state', async () => {
	// Read on access, so a test can set the current path before it mounts. Kit 3 replaced the
	// `$app/stores` readable with the reactive `$app/state` object.
	return { page: { get url() { return pageStore.url; } } };
});
const { user } = vi.hoisted(() => ({ user: { roles: ['member'] as string[], name: 'Pat', email: 'p@x.test', counts: {} } }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: {
		get user() {
			return user;
		},
		get isSuperAdmin() {
			return user.roles.includes('super_admin');
		},
		isTenantAdmin: false,
		isDeveloper: false,
		logout: vi.fn()
	}
}));

import Sidebar from './Sidebar.svelte';

let app: Record<string, unknown> | undefined;
let host: HTMLElement;
function render(roles: string[]) {
	user.roles = roles;
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Sidebar, { target: host }) as Record<string, unknown>;
	flushSync();
}
afterEach(() => {
	pageStore.url = new URL('http://localhost/');
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

const hrefs = () => [...host.querySelectorAll<HTMLAnchorElement>('a.nav-item')].map((a) => a.getAttribute('href'));

describe('the rendered sidebar (W2)', () => {
	it('a member gets 5 links and a CLOSED Library toggle — nothing else', () => {
		render(['member']);
		expect(hrefs()).toEqual(['/', '/challenges', '/solutions', '/build', '/winner']);
		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="nav-section-toggle-library"]')!;
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(host.querySelector('[data-testid="nav-settings"]')).toBeNull();
	});

	it('opening the Library reveals Building blocks and Sample data — nothing more for a member', () => {
		render(['member']);
		host.querySelector<HTMLButtonElement>('[data-testid="nav-section-toggle-library"]')!.click();
		flushSync();
		expect(hrefs()).toEqual(['/', '/challenges', '/solutions', '/build', '/winner', '/blocks', '/datasets']);
	});

	it('a developer’s Library also offers Connectors and Ontology', () => {
		render(['member', 'developer']);
		host.querySelector<HTMLButtonElement>('[data-testid="nav-section-toggle-library"]')!.click();
		flushSync();
		expect(hrefs()).toEqual(['/', '/challenges', '/solutions', '/build', '/winner', '/blocks', '/datasets', '/connectors', '/ontology', '/settings']);
	});

	it('a super_admin gets the same short sidebar plus one gear to /settings', () => {
		render(['member', 'super_admin']);
		expect(hrefs()).toEqual(['/', '/challenges', '/solutions', '/build', '/winner', '/settings']);
	});

	it('⛔ on a Library page the toggle still works: open by default, and the reader can close it', () => {
		// The defect: `expanded = toggled || hasActive`, so on /datasets `hasActive` held the section
		// open and the toggle did nothing at all.
		pageStore.url = new URL('http://localhost/datasets');
		render(['member']);
		const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="nav-section-toggle-library"]')!;
		expect(toggle().getAttribute('aria-expanded'), 'the active section was not opened by default').toBe('true');
		expect(hrefs()).toContain('/datasets');

		toggle().click();
		flushSync();
		expect(toggle().getAttribute('aria-expanded'), 'the toggle did nothing on a Library page').toBe('false');
		expect(hrefs()).not.toContain('/datasets');

		toggle().click();
		flushSync();
		expect(toggle().getAttribute('aria-expanded')).toBe('true');
		expect(hrefs()).toContain('/datasets');
	});
});
