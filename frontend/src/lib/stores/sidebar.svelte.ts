// src/lib/stores/sidebar.svelte.ts — desktop collapse state of the app sidebar.
//
// Two facts, kept apart on purpose:
//   - `preference`: what the reader chose with the footer toggle or ⌘\ / Ctrl+\. Persisted.
//   - `override`:   what a ROUTE asks for while it is on screen (/build collapses the sidebar to
//                   give the canvas the width). Never persisted.
//
// ⛔ THE OVERRIDE MUST NOT WRITE THE PREFERENCE. If /build simply set "collapsed" and saved it, a
// reader who keeps the sidebar open everywhere would find it collapsed on every page after their
// first visit to the builder. Toggling while an override is active changes only the override, so
// expanding the sidebar inside /build lasts until the reader leaves /build, and then their own
// choice comes back untouched.
//
// Storage is injected so the logic is testable without a DOM; every access is wrapped because
// `localStorage` throws in sandboxed iframes and some privacy modes (see locale.svelte.ts).

export const SIDEBAR_STORAGE_KEY = 'cp.sidebar.collapsed';

export type SidebarStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): SidebarStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readCollapsedPreference(storage: SidebarStorage | null): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(SIDEBAR_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export function writeCollapsedPreference(storage: SidebarStorage | null, collapsed: boolean): void {
	if (!storage) return;
	try {
		storage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
	} catch {
		// Not remembered across reloads; the toggle still works for this page view.
	}
}

export class SidebarStore {
	preference = $state(false);
	override = $state<boolean | null>(null);
	readonly #storage: SidebarStorage | null;

	constructor(storage: SidebarStorage | null = defaultStorage()) {
		this.#storage = storage;
		this.preference = readCollapsedPreference(storage);
	}

	/** What the sidebar shows right now. */
	get collapsed(): boolean {
		return this.override ?? this.preference;
	}

	toggle(): void {
		if (this.override !== null) {
			this.override = !this.override;
			return;
		}
		this.preference = !this.preference;
		writeCollapsedPreference(this.#storage, this.preference);
	}

	/** A route asks for a state while it is mounted. Returns the release function. */
	setOverride(collapsed: boolean): () => void {
		this.override = collapsed;
		return () => this.clearOverride();
	}

	clearOverride(): void {
		this.override = null;
	}
}

export const sidebar = new SidebarStore();
