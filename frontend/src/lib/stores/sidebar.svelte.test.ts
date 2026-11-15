// src/lib/stores/sidebar.svelte.test.ts — the desktop sidebar collapse state.
//
// ⛔ The property that matters: /build collapses the sidebar while it is on screen, and that must
// NOT become the reader's saved preference. Otherwise one visit to the builder collapses the
// sidebar on every page for good.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SidebarStore, SIDEBAR_STORAGE_KEY, type SidebarStorage } from './sidebar.svelte';

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	const writes: Array<[string, string]> = [];
	const storage: SidebarStorage = {
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => {
			writes.push([k, v]);
			data.set(k, v);
		}
	};
	return { storage, data, writes };
}

describe('the saved preference', () => {
	it('defaults to expanded when nothing is stored', () => {
		const { storage } = memoryStorage();
		expect(new SidebarStore(storage).collapsed).toBe(false);
	});

	it('reads a stored collapsed choice on start', () => {
		const { storage } = memoryStorage({ [SIDEBAR_STORAGE_KEY]: '1' });
		expect(new SidebarStore(storage).collapsed).toBe(true);
	});

	it('a toggle outside any override flips AND persists the preference', () => {
		const { storage, data } = memoryStorage();
		const s = new SidebarStore(storage);
		s.toggle();
		expect(s.collapsed).toBe(true);
		expect(data.get(SIDEBAR_STORAGE_KEY)).toBe('1');
		s.toggle();
		expect(s.collapsed).toBe(false);
		expect(data.get(SIDEBAR_STORAGE_KEY)).toBe('0');
		// …and a fresh store (a reload) sees the last choice.
		expect(new SidebarStore(storage).collapsed).toBe(false);
	});
});

describe('the /build override', () => {
	it('collapses the sidebar without writing the preference', () => {
		const { storage, writes } = memoryStorage();
		const s = new SidebarStore(storage);
		const release = s.setOverride(true);
		expect(s.collapsed).toBe(true);
		expect(s.preference).toBe(false);
		expect(writes, 'entering /build wrote the saved preference').toEqual([]);
		release();
		expect(s.collapsed, 'leaving /build did not restore the expanded sidebar').toBe(false);
	});

	it('⛔ a toggle INSIDE /build changes the override only; leaving restores the saved choice', () => {
		const { storage, writes } = memoryStorage({ [SIDEBAR_STORAGE_KEY]: '0' });
		const s = new SidebarStore(storage);
		const release = s.setOverride(true);
		s.toggle(); // the reader expands it inside the builder
		expect(s.collapsed).toBe(false);
		s.toggle(); // and collapses it again
		expect(s.collapsed).toBe(true);
		expect(writes, 'a toggle inside /build overwrote the saved preference').toEqual([]);
		release();
		expect(s.collapsed).toBe(false);
		expect(new SidebarStore(storage).collapsed).toBe(false);
	});

	it('keeps a reader who prefers collapsed collapsed after leaving', () => {
		const { storage } = memoryStorage({ [SIDEBAR_STORAGE_KEY]: '1' });
		const s = new SidebarStore(storage);
		const release = s.setOverride(true);
		s.toggle();
		release();
		expect(s.collapsed).toBe(true);
	});
});

describe('storage that throws (sandboxed iframe, privacy mode)', () => {
	it('falls back to expanded and still toggles for the page view', () => {
		const throwing: SidebarStorage = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('SecurityError');
			}
		};
		const s = new SidebarStore(throwing);
		expect(s.collapsed).toBe(false);
		expect(() => s.toggle()).not.toThrow();
		expect(s.collapsed).toBe(true);
	});

	it('works with no storage at all', () => {
		const s = new SidebarStore(null);
		s.toggle();
		expect(s.collapsed).toBe(true);
	});
});

describe('the wiring', () => {
	const read = (rel: string) => {
		const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
		expect(src.length, `${rel} is empty — every assertion below would pass vacuously`).toBeGreaterThan(100);
		return src;
	};

	it('/build asks for the override (never sets the preference directly)', () => {
		const page = read('src/routes/build/+page.svelte');
		expect(page).toMatch(/sidebar\.setOverride\(true\)/);
		expect(page).not.toMatch(/sidebar\.toggle\(|sidebar\.preference\s*=/);
	});

	it('the shell drives the grid column from --sidebar-w and the collapsed class', () => {
		const shell = read('src/lib/layout/ShellLayout.svelte');
		expect(shell).toMatch(/class:sidebar-collapsed=\{sidebar\.collapsed\}/);
		const css = read('src/app.css');
		expect(css).toMatch(/grid-template-columns:\s*var\(--sidebar-w\)\s+1fr/);
		expect(css).toMatch(/\.app\.sidebar-collapsed\s*\{\s*--sidebar-w:\s*64px/);
	});
});
