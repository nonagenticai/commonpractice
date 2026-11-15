// src/routes/build/build-page.topbar-wrapper.test.ts — the /build toolbar must get the whole bar.
//
// ⛔ THE DEFECT (live walk, prod, after #444, 1440 and 1920px). The flow title read "Naaml…" beside a
// screen of empty toolbar, and the flow picker had moved into ⋯ as if the window were narrow. Cause:
// the page wrapped <BuildTopbar> in `<div class="area topbar">`, and `.topbar` is a GLOBAL rule in
// app.css (the app shell's header: `display: flex`, 56px, padding). That made the wrapper a flex
// container, and the toolbar inside is `container-type: inline-size`, whose content width counts
// as zero — so as a flex item it collapsed to its own padding (measured in headless Chromium against
// the real component CSS: bar 36px, title 80px, every container query firing, at 1920px; after the
// rename: bar 1856px, title 560px, picker inline).
//
// ⚠️ jsdom does no layout, so this pins the cause rather than the pixels: no class on the wrapper
// around <BuildTopbar> may be one that app.css styles globally.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/routes/build/+page.svelte'), 'utf8');
const appCss = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every class named by a selector in app.css (global, unscoped). */
const globalClasses = new Set([...appCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

describe('/build topbar wrapper', () => {
	it('does not reuse a class that app.css styles globally', () => {
		expect(globalClasses.has('topbar'), 'app.css no longer has a global .topbar — this guard reads nothing').toBe(true);
		const at = page.indexOf('<BuildTopbar');
		expect(at, 'no <BuildTopbar> in the build page').toBeGreaterThan(0);
		const open = page.slice(0, at).match(/<div class="([^"]*)">\s*$/);
		expect(open, 'the element directly wrapping <BuildTopbar> is not a plain `<div class="…">`').not.toBeNull();
		const clashes = open![1].split(/\s+/).filter((c) => globalClasses.has(c));
		expect(
			clashes,
			`the toolbar wrapper carries global class(es) ${clashes.join(', ')}; app.css \`.topbar\` makes it ` +
				'a flex container and the inline-size toolbar inside collapses to ~36px ("Naaml…" at 1920px)'
		).toEqual([]);
	});

	it('the title column grows into the free space', () => {
		const src = readFileSync(resolve(process.cwd(), 'src/lib/components/build/BuildTopbar.svelte'), 'utf8');
		const mid = src.slice(src.indexOf('<style>')).match(/\n\t\.mid \{([\s\S]*?)\n\t\}/);
		expect(mid).not.toBeNull();
		const body = mid![1].replace(/\/\*[\s\S]*?\*\//g, '');
		expect(body).toMatch(/flex:\s*1 1 auto/);
		expect(body).toMatch(/min-width:\s*\d+px/);
	});
});
