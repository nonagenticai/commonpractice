// src/lib/i18n/flow-arrow.test.ts — the arrows CSS cannot reach.
//
// ⛔ TWO SHAPES `.cp-dir-mirror` CANNOT FIX, both of which carried a hardcoded `→`:
//   · a plain-text ATTRIBUTE — `title="{col} → {attr}"` has no element to transform;
//   · a JS template string — `` `${from} → ${to}` `` is composed in a `.map()` before it is ever
//     a DOM node.
// U+2192 is not bidi-mirrored, so in both shapes a right-pointing arrow survives into an RTL
// sentence pointing backwards, and no stylesheet can correct it. `flowArrow(locale)` is the seam.
import { describe, it, expect } from 'vitest';
import { flowArrow } from './direction';
import { locales } from '$lib/paraglide/runtime';

describe('flowArrow points with the reading direction', () => {
	it('is ← for the RTL locales', () => {
		expect(flowArrow('ar')).toBe('←');
		expect(flowArrow('he')).toBe('←');
	});

	it('is → for every LTR locale', () => {
		for (const l of ['en', 'nl', 'pl', 'fr', 'es', 'de']) {
			expect(flowArrow(l), `${l} should read left-to-right`).toBe('→');
		}
	});

	// Non-vacuity + drift: every shipped locale must get a definite arrow, so a ninth locale
	// cannot silently inherit the LTR default without someone deciding.
	it('returns a definite arrow for every shipped locale', () => {
		expect(locales.length).toBe(8);
		for (const l of locales) expect(['→', '←']).toContain(flowArrow(l));
	});

	it('falls back to → on absent or unknown input rather than throwing', () => {
		expect(flowArrow(null)).toBe('→');
		expect(flowArrow(undefined)).toBe('→');
		expect(flowArrow('')).toBe('→');
		expect(flowArrow('xx')).toBe('→');
	});
});
