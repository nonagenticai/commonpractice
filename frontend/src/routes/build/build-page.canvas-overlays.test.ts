// src/routes/build/build-page.canvas-overlays.test.ts — the sample-data panel is not a canvas overlay.
//
// ⛔ THE HISTORY. The sample-data panel was an absolutely-positioned `.data-overlay` over the left
// 270px of the canvas, opened by a `.data-fab` pill that once sat ON xyflow's zoom-out control
// (browser walk, 2026-10-14). It is now the "Sample data" tab of the side pane, so neither exists.
// The render-level half of this (the panel mounts inside `#side-panel-data`) is in
// build-page.locale-refetch.render.test.ts; this file pins the source so neither class comes back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/routes/build/+page.svelte'), 'utf8');

describe('the sample-data panel is a side-pane tab', () => {
	it('non-vacuity: the page source was read', () => {
		expect(page.length).toBeGreaterThan(1000);
		expect(page).toContain('<ChallengeDataPanel');
	});

	it('⛔ no overlay and no floating button on the canvas', () => {
		expect(page).not.toMatch(/data-overlay/);
		expect(page).not.toMatch(/data-fab/);
	});

	it('the panel is mounted inside the side-pane tabpanel', () => {
		const tab = page.indexOf('id="side-panel-data"');
		const mountAt = page.indexOf('<ChallengeDataPanel');
		expect(tab, 'no sample-data tabpanel').toBeGreaterThan(-1);
		expect(mountAt).toBeGreaterThan(tab);
		expect(page.indexOf('id="side-panel-assistant"')).toBeGreaterThan(mountAt);
	});
});

describe('the sample-data tab and the example-result dot are two words', () => {
	// ⛔ THE CLASH (browser walk, nl): the button that opened the panel and the amber dot's tooltip
	// both read "Voorbeelddata", for two different things — the challenge's datasets vs. a block that
	// invents its output. Every locale must keep them apart.
	const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'];
	it.each(LOCALES)('%s', (loc) => {
		const file = resolve(process.cwd(), 'messages', `${loc}.json`);
		const cat = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
		const tab = cat.build_data_browse;
		const dot = cat.build_example_data;
		expect(tab, 'tab label missing').toBeTruthy();
		expect(dot, 'dot tooltip missing').toBeTruthy();
		expect(dot!.toLowerCase()).not.toBe(tab!.toLowerCase());
	});
});

describe('member walk: the empty canvas and the inspector', () => {
	const canvas = readFileSync(resolve(process.cwd(), 'src/lib/components/build/FlowCanvas.svelte'), 'utf8');

	it('⛔ the drag hint is hidden while the start cards are shown (they were drawn over it)', () => {
		expect(canvas.length).toBeGreaterThan(1000);
		expect(canvas).toMatch(/\{#if builder\.nodes\.length === 0 && !hideEmptyHint\}/);
		expect(page).toMatch(/<FlowCanvas [^>]*hideEmptyHint=\{showStart\}/);
		expect(page).toMatch(/\{#if showStart\}\s*<div class="start" data-testid="build-start">/);
	});

	it('the inspector and the run console get the reader’s role, not a default', () => {
		expect(page).toMatch(/<NodeConfigPanel \{builder\} \{canMapData\} \/>/);
		expect(page).toMatch(/<RunConsole [^>]*\{showInternalErrors\}/);
	});
});
