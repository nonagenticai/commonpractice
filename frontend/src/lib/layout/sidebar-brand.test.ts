// src/lib/layout/sidebar-brand.test.ts — the sidebar logo carries the product name and nothing else.
//
// ⛔ THE DEFECT (live walk). Under "Common Practice" every reader saw "RANGLIJSTEN" / "LEADERBOARDS":
// `brand_sub`, a label left from the first build (2026-06-06), when the product was the two
// leaderboards. It is one section of the product now, so the subtitle named the wrong thing on
// every page. It was removed rather than reworded: the logo needs no second line.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('sidebar brand', () => {
	const sidebar = readFileSync(resolve(process.cwd(), 'src/lib/layout/Sidebar.svelte'), 'utf8');

	it('non-vacuity: the source was read', () => {
		expect(sidebar).toContain('m.brand_name()');
	});

	it('⛔ no subtitle under the product name', () => {
		expect(sidebar).not.toMatch(/brand-sub|brand_sub/);
	});

	it.each(['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'])('%s: no `brand_sub` key', (loc) => {
		const cat = JSON.parse(readFileSync(resolve(process.cwd(), 'messages', `${loc}.json`), 'utf8'));
		expect(cat.brand_name, 'wrong catalog shape').toBeTruthy();
		expect(cat).not.toHaveProperty('brand_sub');
	});
});
