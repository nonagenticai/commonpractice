// @vitest-environment jsdom
//
// src/routes/winner/winner-page.cycle-off.render.test.ts — with the voting cycle OFF (0107) the
// winner screen says so instead of presenting the last winner from before the cycle was switched off.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const { winner, authState } = vi.hoisted(() => ({
	winner: vi.fn(),
	authState: { user: { roles: ['employee'], cycleCadence: 'off' as string | undefined } }
}));
vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { winner, home: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: authState }));
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import Page from './+page.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
async function render() {
	winner.mockResolvedValue({ week: null, announcedAt: null, stats: {}, pipeline: null, winner: null, honorableMentions: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

describe('/winner · voting cycle off', () => {
	it('⛔ OFF: states that the cycle is off', async () => {
		authState.user.cycleCadence = 'off';
		await render();
		const notice = host.querySelector('[data-testid="winner-cycle-off"]');
		expect(notice).not.toBeNull();
		expect(notice!.textContent).toContain('winner_cycle_off_title');
		expect(notice!.textContent).toContain('winner_cycle_off_text');
	});

	it('ON (or an older backend without the field): the normal page, no off notice', async () => {
		for (const c of ['week', undefined]) {
			authState.user.cycleCadence = c;
			await render();
			expect(host.querySelector('[data-testid="winner-cycle-off"]'), `cadence=${String(c)}`).toBeNull();
			unmount(app!);
			app = undefined;
			host.remove();
		}
	});
});
