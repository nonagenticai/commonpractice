// src/lib/i18n/icon-mirroring.test.ts — the directional icon stays mirrored, and the icons that
// must NOT mirror stay un-mirrored.
//
// ⛔ WHY THIS IS A TWO-SIDED GUARD. An audit of all 46 icon graphics under `src/` found exactly ONE
// that is genuinely directional: the sidebar sign-out door, whose arrow leaves rightward. Rightward
// is "out" in LTR and "in" for an Arabic or Hebrew reader, and an `<svg>` does not mirror under
// `dir="rtl"` — only an explicit transform flips it. Arabic and Hebrew are primary markets, and
// this icon sits in the sidebar of every authenticated route.
//
// ⚠️ THE SECOND HALF MATTERS AS MUCH AS THE FIRST, and is the half a one-sided test would miss.
// "Mirror the icons for RTL" is exactly the instruction that gets over-applied on the next pass:
// the search magnifier is conventionally NOT mirrored in RTL (Material and Apple both leave it),
// and the vertical upload arrow, the symmetric `< >` code glyph and the chart sparklines must not
// flip either. So this asserts the magnifier is CLEAN as explicitly as it asserts the door is
// MIRRORED. Without that, the obvious "fix" for a bug that does not exist passes review.
//
// Source-level rather than a render test on purpose: `Sidebar.svelte` pulls the auth store and the
// nav config, so rendering it costs a pile of mocks to assert one attribute — and the attribute,
// not the rendering, is the thing that regresses in a refactor.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');

/**
 * The opening `<svg …>` tag of the icon whose body contains `marker` — and ONLY that tag.
 *
 * ⛔ THIS IS NARROW ON PURPOSE, BECAUSE THE WIDE VERSION DOES NOT WORK. The first draft matched
 * `/<svg[^>]*>[\s\S]*?<marker>/`, which starts at the FIRST `<svg` in the file and runs forward to
 * the marker — so it also swallowed everything in between, including the comment above the icon
 * explaining why it is mirrored. That comment contains the string `cp-dir-mirror`, so
 * `.toContain('cp-dir-mirror')` passed on the PROSE. Mutation-tested and caught: deleting the class
 * from the element left the test green. Splitting on `<svg` and taking the tag of the chunk that
 * owns the marker means the assertion can only ever see that element's own attributes.
 */
function svgTagContaining(source: string, marker: string): string {
	const chunk = source.split('<svg').find((c) => c.includes(marker));
	if (chunk === undefined) return '';
	const end = chunk.indexOf('>');
	return end === -1 ? '' : chunk.slice(0, end);
}

describe('RTL icon mirroring', () => {
	it('the sign-out door is mirrored', () => {
		// Anchored on the icon's own path data — the arrowhead leaving the door — not on line position.
		const tag = svgTagContaining(read('src/lib/layout/Sidebar.svelte'), 'polyline points="16 17 21 12 16 7"');
		expect(tag, 'the sign-out icon was not found — did its path data change?').not.toBe('');
		expect(
			tag,
			'the sign-out arrow lost .cp-dir-mirror. It points OUT in LTR and IN for an ar/he reader.'
		).toContain('cp-dir-mirror');
	});

	it('the search magnifier is NOT mirrored', () => {
		const tag = svgTagContaining(read('src/lib/layout/Topbar.svelte'), 'M21 21l-4.3-4.3');
		expect(tag, 'the search magnifier was not found — did its path data change?').not.toBe('');
		expect(
			tag,
			'the magnifier must NOT be mirrored: RTL convention leaves it alone, and flipping it is ' +
				'the classic over-correction once someone starts mirroring icons.'
		).not.toContain('cp-dir-mirror');
	});

	// The mechanism itself must exist, or both assertions above are checking a class that does nothing.
	it('.cp-dir-mirror is actually defined', () => {
		const css = read('src/app.css');
		expect(css).toContain('.cp-dir-mirror');
		expect(css).toContain('--cp-dir-flip');
	});
});
