// @vitest-environment jsdom
//
// src/lib/layout/shell-nav-drawer.render.test.ts — the phone-width navigation drawer.
//
// ⛔ THE DEFECT. The 248px sidebar was a fixed grid column with no breakpoint at all, so at 390px
// it left 142px for the page and every screen scrolled sideways (scrollWidth 541). Below 768px it
// is now an off-canvas drawer: a menu button in the topbar opens it (aria-expanded, aria-controls),
// focus moves into it, and it closes on navigation, on Escape (focus back on the button) and on a
// tap outside it. The CSS half (the breakpoint itself) is pinned at the bottom of this file, since
// jsdom does not evaluate media queries.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

const { navCallbacks } = vi.hoisted(() => ({ navCallbacks: [] as Array<() => void> }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	afterNavigate: (fn: () => void) => {
		navCallbacks.push(fn);
	}
}));
// Kit 3 replaced `$app/stores` with the reactive `$app/state` object.
vi.mock('$app/state', async () => {
	return { page: { url: new URL('http://localhost/tenants') } };
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
vi.mock('$lib/stores/activeTenant.svelte', () => ({ activeTenant: { current: null, clear: vi.fn() } }));

import ShellLayout from './ShellLayout.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	navCallbacks.length = 0;
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(ShellLayout, {
		target: host,
		props: { children: createRawSnippet(() => ({ render: () => '<p>page</p>' })) }
	}) as Record<string, unknown>;
	flushSync();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

const button = () => host.querySelector<HTMLButtonElement>('[data-testid="nav-menu-button"]')!;
const sidebar = () => host.querySelector<HTMLElement>('#app-sidebar')!;
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

describe('the phone-width navigation drawer', () => {
	it('a menu button controls the sidebar, closed by default', () => {
		expect(button(), 'no menu button in the topbar').not.toBeNull();
		expect(button().getAttribute('aria-controls')).toBe('app-sidebar');
		expect(button().getAttribute('aria-expanded')).toBe('false');
		expect(button().getAttribute('aria-label')).toBe('shell_menu_open');
		expect(sidebar().classList.contains('open')).toBe(false);
	});

	it('opens on the button, moves focus into the drawer, and Escape closes it with focus back on the button', async () => {
		button().click();
		await settle();
		expect(button().getAttribute('aria-expanded')).toBe('true');
		expect(button().getAttribute('aria-label')).toBe('shell_menu_close');
		expect(sidebar().classList.contains('open')).toBe(true);
		expect(sidebar().contains(document.activeElement), 'focus did not move into the drawer').toBe(true);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(sidebar().classList.contains('open')).toBe(false);
		expect(document.activeElement).toBe(button());
	});

	it('⛔ traps focus while open: Tab from the last item wraps to the first, Shift+Tab from the first to the last', async () => {
		button().click();
		await settle();
		const items = [...sidebar().querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
		expect(items.length, 'the drawer has nothing focusable — the trap would be vacuous').toBeGreaterThan(2);
		const first = items[0]!;
		const last = items[items.length - 1]!;

		last.focus();
		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		window.dispatchEvent(tab);
		expect(tab.defaultPrevented, 'Tab from the last item walked out of the drawer').toBe(true);
		expect(document.activeElement).toBe(first);

		const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
		window.dispatchEvent(back);
		expect(document.activeElement).toBe(last);

		// Focus that escaped to the page (behind the backdrop) is pulled back in.
		button().focus();
		const stray = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		window.dispatchEvent(stray);
		expect(document.activeElement).toBe(first);

		// A Tab in the middle is left to the browser.
		items[1]!.focus();
		const mid = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		window.dispatchEvent(mid);
		expect(mid.defaultPrevented).toBe(false);

		// Closed: no trap at all.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(document.activeElement).toBe(button());
		last.focus();
		const closedTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		window.dispatchEvent(closedTab);
		expect(closedTab.defaultPrevented).toBe(false);
	});

	it('closes on navigation and on a tap outside it', async () => {
		button().click();
		await settle();
		expect(navCallbacks.length, 'the shell registered no afterNavigate').toBeGreaterThan(0);
		navCallbacks.forEach((fn) => fn());
		await settle();
		expect(sidebar().classList.contains('open')).toBe(false);

		button().click();
		await settle();
		host.querySelector<HTMLElement>('[data-testid="nav-backdrop"]')!.click();
		await settle();
		expect(sidebar().classList.contains('open')).toBe(false);
	});
});

describe('the breakpoint (app.css)', () => {
	it('below 768px the grid is one column, the closed drawer is hidden, and the menu button shows', () => {
		const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');
		const block = css.slice(css.indexOf('@media (max-width: 767.98px)'));
		expect(block.length, 'no phone-width breakpoint in app.css').toBeGreaterThan(30);
		expect(block).toMatch(/\.app\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
		expect(block).toMatch(/\.sidebar\s*\{[^}]*position:\s*fixed[^}]*visibility:\s*hidden/);
		expect(block).toMatch(/\.sidebar\.open\s*\{[^}]*visibility:\s*visible/);
		// ⛔ OPENING must make it visible INSTANTLY: with `visibility 0.2s` the drawer was still hidden
		// when `openNav()` called focus(), so focus never moved inside (a real-browser walk showed it).
		expect(block).toMatch(/\.sidebar\.open\s*\{[^}]*transition:[^};]*visibility\s+0s/);
		expect(block).toMatch(/\.menu-btn\s*\{\s*display:\s*flex/);
		// Outside the breakpoint the button is hidden — desktop keeps its fixed sidebar.
		expect(css).toMatch(/^\.menu-btn \{ display: none; \}/m);
	});
});

describe('⌘\\ / Ctrl+\\ sidebar shortcut', () => {
	const collapsed = () => host.querySelector('.app')!.classList.contains('sidebar-collapsed');
	function press(target: EventTarget) {
		target.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true }));
		flushSync();
	}

	it('toggles from the page, and ⛔ does nothing while the reader types in a field, a chat box or an editor', () => {
		const before = collapsed();
		press(window);
		expect(collapsed(), 'the shortcut did nothing from the page — the cases below prove nothing').toBe(!before);
		press(window); // back to where it was
		expect(collapsed()).toBe(before);

		const input = document.createElement('input');
		const textarea = document.createElement('textarea');
		const editor = document.createElement('div');
		editor.setAttribute('contenteditable', 'true');
		const editorLine = document.createElement('span');
		editor.appendChild(editorLine);
		for (const el of [input, textarea, editor]) host.appendChild(el);
		for (const el of [input, textarea, editorLine]) {
			press(el);
			expect(collapsed(), `⌘\\ inside <${el.tagName.toLowerCase()}> collapsed the sidebar`).toBe(before);
		}
	});
});
