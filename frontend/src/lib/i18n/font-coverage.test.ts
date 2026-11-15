// src/lib/i18n/font-coverage.test.ts — every webfont the stylesheet NAMES must actually be
// REQUESTED, and the RTL scripts must have a brand face at all.
//
// ⛔ THE DEFECT. `app.css` asked for `'IBM Plex Sans'` and `'Fraunces'`; `app.html` requested
// exactly those from Google Fonts. Both are Latin-script families — measured against what Google
// serves, `IBM Plex Sans` covers latin/latin-ext/cyrillic/cyrillic-ext/greek/vietnamese and
// `Fraunces` covers latin/latin-ext/vietnamese. Neither carries a single Arabic or Hebrew glyph.
// So for two PRIMARY markets the entire product rendered in system fallbacks: body text in
// whatever `-apple-system`/`sans-serif` resolves to per OS, and headings past `Georgia` — also
// Latin-only — into a generic `serif`. Two unrelated faces, neither of them the brand.
//
// ⚠️ WHY IT NEEDED A TEST RATHER THAN A LOOK. A missing font is the quietest failure in a browser:
// there is no error, no console warning, no failed request. The glyphs simply render in something
// else, and they render in something PLAUSIBLE, so the page looks intentional to anyone who does
// not know what it should have looked like. Nobody reading `--font-sans` can see the absence
// either — the family name is right there and looks complete. Only comparing the declared stack
// against the requested families exposes it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf-8');
const appCss = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf-8');
const tokensCss = readFileSync(resolve(process.cwd(), 'src/lib/styles/tokens.css'), 'utf-8');

/**
 * EVERY source that defines the font tokens. There are two, and that is the whole problem.
 *
 * ⛔ THE FIRST VERSION OF THIS FILE CHECKED `app.css` ALONE AND PASSED WHILE PRODUCTION WAS BROKEN.
 * `app.css` does `@import 'tailwindcss'`, so its `@theme` block compiles into `@layer theme`;
 * `tokens.css` declares the same tokens in an UNLAYERED `:root`. Unlayered beats layered whatever
 * the order, so the `@theme` copy never resolved. Measured on the deployed stylesheet with
 * Chrome's `getPlatformFontsForNode`: Arabic rendered in Geeza Pro, Hebrew in Lucida Grande, and no
 * Arabic/Hebrew woff2 was requested at all. The old assertion — "the CSS names the family" — was
 * true of the losing declaration, which is exactly how a green test coexists with a broken page.
 */
const CSS_SOURCES: Array<[string, string]> = [
	['src/app.css', appCss],
	['src/lib/styles/tokens.css', tokensCss],
];
const css = appCss + '\n' + tokensCss;

/** Families requested from Google Fonts, e.g. `IBM+Plex+Sans+Arabic` -> `IBM Plex Sans Arabic`. */
const requested = [...html.matchAll(/family=([^&:"']+)/g)].map((m) => m[1].replaceAll('+', ' '));

/** Quoted family names in the `@theme` font stacks — the ones that must come from somewhere. */
const declared = [...css.matchAll(/--font-(?:sans|display|mono):([^;]+);/g)]
	.flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]))
	.filter((f, i, a) => a.indexOf(f) === i);

describe('webfont coverage', () => {
	// Non-vacuity: a regex that silently stopped matching would make every assertion below trivial.
	it('parsed both the requested and the declared families', () => {
		expect(requested.length, 'no family= found in app.html').toBeGreaterThanOrEqual(3);
		expect(declared.length, 'no quoted families found in app.css').toBeGreaterThanOrEqual(3);
	});

	it('every family the CSS names is actually requested', () => {
		const orphans = declared.filter((f) => !requested.includes(f));
		expect(
			orphans,
			'app.css names a webfont that app.html never requests. It will silently render as a ' +
				'system fallback — no error, no warning, just the wrong typeface.'
		).toEqual([]);
	});

	// ⛔ THE ONE THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Arabic and Hebrew are primary markets, so
	// the RTL scripts must be covered by a real family and not by whatever the OS supplies.
	it.each([
		['Arabic', 'IBM Plex Sans Arabic'],
		['Hebrew', 'IBM Plex Sans Hebrew']
	])('%s has a brand face in EVERY --font-sans declaration', (script, family) => {
		expect(
			requested,
			`${script} is a primary market with no requested webfont — every ${script} glyph falls back to a system face.`
		).toContain(family);
		// ⛔ EVERY declaration, in every source. One of them wins the cascade and it is not
		// necessarily the one you edited.
		for (const [file, source] of CSS_SOURCES) {
			for (const decl of source.match(/--font-sans:[^;]+;/g) ?? []) {
				expect(
					decl,
					`${file} declares --font-sans without ${family}. If this is the declaration that ` +
						`wins the cascade, every ${script} glyph silently falls back to a system face — ` +
						`no error, no warning, no failed request.`
				).toContain(family);
			}
		}
	});

	// Headings too: `Fraunces` is Latin-only, so without an RTL entry every ar/he heading falls
	// through Georgia (also Latin-only) to a generic serif — a different classification from the body.
	it('every --font-display declaration keeps RTL headings off a generic serif', () => {
		for (const [file, source] of CSS_SOURCES) {
			for (const decl of source.match(/--font-display:[^;]+;/g) ?? []) {
				expect(decl, `${file}: RTL headings fall through Georgia to a generic serif`).toContain(
					'IBM Plex Sans Arabic',
				);
				expect(decl, `${file}: RTL headings fall through Georgia to a generic serif`).toContain(
					'IBM Plex Sans Hebrew',
				);
			}
		}
	});

	// Non-vacuity for the loops above: if a refactor moved these tokens somewhere this file does not
	// read, the `for` bodies would never execute and the test would pass having checked nothing.
	it('actually found font declarations in both sources', () => {
		for (const [file, source] of CSS_SOURCES) {
			expect((source.match(/--font-sans:[^;]+;/g) ?? []).length, `${file} declares no --font-sans`)
				.toBeGreaterThan(0);
		}
	});
});
