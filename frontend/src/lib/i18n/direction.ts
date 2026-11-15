// src/lib/i18n/direction.ts — which locales are right-to-left, and the `dir` value each locale
// needs. Deliberately SIDE-EFFECT FREE so both sides of the render can import it.
//
// ⛔ WHY THIS IS ITS OWN MODULE AND NOT A CONST IN THE STORE. `RTL` used to live in
// `$lib/stores/locale.svelte.ts`, which performs a browser-only `localStorage` read at module top
// level (see the long comment there). `src/hooks.server.ts` runs in Node, where that read has no
// business executing, so a server import of the store would either throw or drag a DOM shim into
// the server bundle. The alternative — the server keeping its own `['ar','he']` — is the drift
// this repo has been bitten by before: two lists, one updated, no test that compares them. One
// module with no imports of its own is the only shape that lets the SERVER and the BROWSER agree
// on direction by construction.
import { locales } from '$lib/paraglide/runtime';

/**
 * The right-to-left locales among the eight this product ships.
 *
 * Not derived from `Intl.Locale#textInfo` on purpose: that API is unavailable in the Node version
 * the frontend server runs on and is still uneven across browsers, and the locale set here is
 * fixed and small enough that a hardcoded set is both correct and inspectable. `direction.test.ts`
 * pins it against the compiled paraglide locale list so adding a ninth locale cannot silently
 * default it to LTR.
 */
export const RTL_LOCALES: ReadonlySet<string> = new Set(['ar', 'he']);

/** True when `locale` is written right-to-left. Unknown locales are LTR, matching `baseLocale`. */
export function isRtl(locale: string | null | undefined): boolean {
	return !!locale && RTL_LOCALES.has(locale);
}

/** The `dir` attribute value for `locale` — exactly what `<html dir>` must carry. */
export function dirFor(locale: string | null | undefined): 'rtl' | 'ltr' {
	return isRtl(locale) ? 'rtl' : 'ltr';
}

/** Narrowing guard against the compiled paraglide locale list — the only supported-locale source. */
export function isSupportedLocale(locale: string | null | undefined): boolean {
	return !!locale && (locales as readonly string[]).includes(locale);
}

/**
 * The arrow to use for a "flows to" / "maps to" relation, for a reader of `locale`.
 *
 * ⛔ FOR THE PLACES CSS CANNOT REACH. Decorative arrows in markup are flipped visually by
 * `.cp-dir-mirror` (see `app.css`), which is the right tool when the glyph is an element. It is
 * useless for the two shapes that also carry arrows:
 *   · a plain-text ATTRIBUTE — `title="{col} → {attr}"` has no element to transform;
 *   · a JS template string built before it reaches the DOM — `` `${from} → ${to}` `` is composed in
 *     a `.map()` and then handed to a message or a text node.
 * U+2192 is not bidi-mirrored, so in those two shapes a right-pointing arrow survives into an RTL
 * sentence pointing backwards, and no stylesheet can correct it.
 *
 * ⚠️ THIS IS NOT A LICENCE TO BUILD SENTENCES IN CODE. It exists for a bare connector between two
 * interpolated IDENTIFIERS (a column name, a block slug) — values that must not be translated and
 * therefore cannot live inside a catalog message. Prose stays in the catalogs, where a translator
 * owns the whole sentence including its arrow; `rtl-arrow-direction.test.ts` guards those.
 */
export function flowArrow(locale: string | null | undefined): '→' | '←' {
	return isRtl(locale) ? '←' : '→';
}
