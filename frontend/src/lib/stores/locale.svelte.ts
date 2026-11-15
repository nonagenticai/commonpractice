// src/lib/stores/locale.svelte.ts — Svelte 5 runes locale store (mirrors the
// persona store shape). Drives <html lang dir>, persists the choice, and makes
// Paraglide's compiled m.*() calls reactive by binding getLocale() to the rune.
//
// Paraglide resolves the initial locale from its strategies
// (localStorage → cookie → navigator → baseLocale). We capture that resolved
// value ONCE before rebinding getLocale to our rune, then let setLocale() handle
// persistence (cookie + localStorage) on every change — no full reload.
import {
	getLocale as pgGetLocale,
	setLocale as pgSetLocale,
	overwriteGetLocale,
	locales,
	type Locale
} from '$lib/paraglide/runtime';
import { authFetch } from '$lib/api/auth-fetch';
import { dirFor, isRtl as isRtlShared } from '$lib/i18n/direction';

export const LOCALES = locales as readonly Locale[];

export const LOCALE_LABELS: Record<Locale, string> = {
	en: 'English',
	nl: 'Nederlands',
	pl: 'Polski',
	fr: 'Français',
	es: 'Español',
	de: 'Deutsch',
	ar: 'العربية',
	he: 'עברית'
};

// ⛔ THE RTL SET LIVES IN `$lib/i18n/direction.ts`, NOT HERE. `src/hooks.server.ts` stamps
// `<html lang dir>` on the shell and needs the same answer this store gives, but it runs in Node
// and cannot import THIS module — the top-level `localStorage` read below is browser-only. Two
// hardcoded `['ar','he']` lists, one of them updated, is exactly the drift that ships a ninth
// locale silently left-to-right. `direction.ts` has no imports of its own so both sides can hold it.
export const isRtl = isRtlShared;

function isSupported(locale: string | null | undefined): locale is Locale {
	return !!locale && (LOCALES as readonly string[]).includes(locale);
}

/**
 * Capture the strategy-resolved locale BEFORE we rebind getLocale to the rune.
 *
 * ⛔ THIS RUNS AT MODULE TOP LEVEL, SO IT MUST NOT BE ABLE TO THROW. Paraglide's
 * `resolveLocaleWithStrategies` reads `localStorage` directly (`paraglide/runtime.js`, the
 * `strat === 'localStorage'` branch). A top-level call therefore performs a browser-only storage
 * read at IMPORT time — so anything that merely *imports this module* inherits that read, and if
 * it throws, the importing component never evaluates and the page renders nothing.
 *
 * That is not theoretical. `localStorage` access throws `SecurityError` in a sandboxed iframe
 * (no `allow-same-origin`) and under some privacy configurations, and in any non-DOM environment
 * the global is absent or a stub. Measured here: with the store imported by 15 components instead
 * of 1, ten render-test files died at import with
 * `TypeError: localStorage.getItem is not a function` — the same shape a hostile embed produces.
 *
 * The blast radius is what makes this load-bearing rather than tidy: this module is the seam every
 * locale-aware component now imports, so an unguarded read here is a single point of failure for
 * the whole localized surface. Falling back to 'en' costs a reader their remembered language for
 * one paint (`init()` re-resolves on mount and the userPref fetch corrects it again); throwing
 * costs them the page.
 *
 * ⛔ DO NOT "fix" this by rethrowing, or by deleting the guard because the happy path works in a
 * normal tab. And do not fix the symptom in the tests instead — pinning `@vitest-environment jsdom`
 * onto each affected spec would make the suite green while leaving the SecurityError hazard live in
 * production. `locale.storage-failure.test.ts` pins this.
 */
function resolveInitialLocale(): Locale {
	try {
		const resolved = pgGetLocale();
		return isSupported(resolved) ? resolved : 'en';
	} catch {
		// Deliberately swallowed: there is no caller to report to (module scope) and no recovery
		// other than the base locale. This is the one place in the store where a bare catch is right.
		return 'en';
	}
}

const initialLocale: Locale = resolveInitialLocale();

/**
 * Persist the locale to cookie + localStorage, and NEVER let that take the page down.
 *
 * ⛔ THE WRITE HALF OF `resolveInitialLocale`'s GUARD, AND IT WAS MISSING. That function has a long
 * comment above it explaining why READING the locale must not throw. The WRITE had no such guard:
 * `init()` and `set()` called `pgSetLocale` bare. Paraglide's `setLocale` does
 * `localStorage.setItem(...)` (`paraglide/runtime.js:502`) under the `localStorage` strategy, and
 * every reason the read can throw applies identically to the write — a sandboxed iframe without
 * `allow-same-origin`, or a privacy configuration, raises `SecurityError` on either.
 *
 * ⛔ AND THE WRITE IS THE WORSE ONE, WHICH IS WHY THE ASYMMETRY MATTERED. `resolveInitialLocale`
 * runs at module scope and falls back to 'en'. `init()` is called from `routes/+layout.svelte` ON
 * MOUNT — so an unguarded throw there does not cost a reader their remembered language, it
 * propagates out of the layout's mount and the app renders NOTHING. Same hazard, larger blast
 * radius, no guard.
 *
 * ⚠️ WHY IT WAS INVISIBLE UNTIL NOW, because this is the interesting part. `package.json` compiled
 * paraglide with no `--strategy`, so CI got the CLI default `['cookie','globalVariable',
 * 'baseLocale']` — under which `TREE_SHAKE_LOCAL_STORAGE_STRATEGY_USED` is `false` and the
 * `localStorage.setItem` line is COMPILED OUT. Production always shipped the `localStorage`
 * strategy (`vite.config.ts`), so this path was live for every real reader and unreachable for
 * every test. Fixing the compile flags is what surfaced it.
 *
 * ⛔ DO NOT "fix" a red here by stubbing `localStorage` in the failing spec. That is the symptom
 * fix `resolveInitialLocale`'s comment already forbids, and it would leave the SecurityError
 * hazard live in production.
 */
function persistLocale(next: Locale): void {
	try {
		// reload:false → persist to cookie+localStorage without a page reload.
		pgSetLocale(next, { reload: false });
	} catch {
		// Deliberately swallowed, exactly as the read is. The locale is already applied to the rune
		// and to <html>; all that is lost is REMEMBERING it across a reload, which is the strictly
		// better outcome than not rendering. There is no caller that could do anything with it.
	}
}

class LocaleState {
	current = $state<Locale>(initialLocale);
	dir = $derived<'rtl' | 'ltr'>(dirFor(this.current));

	/** Apply <html lang/dir> for the current locale. Safe to call repeatedly. */
	private applyDocument(): void {
		if (typeof document === 'undefined') return;
		document.documentElement.lang = this.current;
		document.documentElement.dir = dirFor(this.current);
	}

	/**
	 * Seed the store. Called on mount (no arg → strategy-resolved) and again once
	 * the authenticated user's stored preference is known (userPref wins).
	 */
	init(userPref?: string | null): void {
		const next = isSupported(userPref) ? userPref : this.current;
		this.current = next;
		persistLocale(next);
		// ⚠️ AFTER the persist, and reached even when it fails — `<html lang/dir>` is what makes the
		// page readable at all in an RTL locale, and it does not depend on storage having worked.
		this.applyDocument();
	}

	/** User-driven switch (topbar). Persists locally + to the backend profile. */
	set(next: string): void {
		if (!isSupported(next) || next === this.current) {
			if (isSupported(next)) this.applyDocument();
			return;
		}
		this.current = next;
		persistLocale(next);
		this.applyDocument();
		// Fire-and-forget; never block the UI on the profile write.
		authFetch('/api/me/locale', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ locale: next })
		}).catch(() => {});
	}
}

export const locale = new LocaleState();

// Make every compiled m.*() call reactive: getLocale() now reads the rune, so
// any markup that calls a message re-renders when locale.current changes.
overwriteGetLocale(() => locale.current);
