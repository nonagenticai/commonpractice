// @vitest-environment jsdom
//
// src/routes/settings/settings-page.voting-schedule.render.test.ts — W7: the workspace's voting
// schedule is offered under /settings → Organisation to a tenant_admin (and a super_admin), and
// to nobody else. Rendered, so removing the nav item (navConfig.ts `voting-schedule`) or its
// `requiresRole: 'tenant_admin'` gate turns a case red.
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
const { authState } = vi.hoisted(() => ({ authState: { user: { roles: [] as string[] } } }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: authState }));

import Page from './+page.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
function render(roles: string[]) {
	authState.user = { roles };
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	flushSync();
}
const link = () => host.querySelector<HTMLAnchorElement>('[data-testid="settings-link-voting-schedule"]');

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

describe('/settings · voting schedule', () => {
	it('tenant_admin: listed under Organisation, linking to /voting-schedule', () => {
		render(['tenant_admin']);
		const a = link();
		expect(a).not.toBeNull();
		expect(a!.getAttribute('href')).toBe('/voting-schedule');
		expect(a!.textContent).toContain('nav_voting_schedule');
		expect(a!.closest('section')?.querySelector('h2')?.textContent).toBe('settings_group_organisation');
	});

	it('super_admin: listed too (composite role)', () => {
		render(['super_admin']);
		expect(link()).not.toBeNull();
	});

	it('member and developer: not offered', () => {
		render(['member']);
		expect(link()).toBeNull();
		unmount(app!);
		app = undefined;
		host.remove();
		render(['developer']);
		expect(link()).toBeNull();
	});
});
