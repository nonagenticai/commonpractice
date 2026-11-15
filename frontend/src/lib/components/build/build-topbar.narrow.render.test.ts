// @vitest-environment jsdom
//
// src/lib/components/build/build-topbar.narrow.render.test.ts — the /build toolbar must fit a
// narrow bar without pushing Submit off it.
//
// ⛔ THE DEFECT (browser walk, 2026-10-14). 900px window with the app sidebar open: the bar was 652px
// wide and Submit's right edge sat at 978px — past the window, clipped by `.build-page`'s
// `overflow: hidden`. Every control on the bar was `flex-shrink: 0` except the title.
//
// ⚠️ jsdom does no layout and evaluates no container queries, so this file pins the two halves it
// CAN see: (1) the ⋯ menu really carries working copies of the picker and "New flow" (otherwise
// hiding the inline pair would remove them outright), and (2) the stylesheet really sizes the bar by
// its own width and hides the inline pair in a narrow bar. Measured fit is a browser check.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FlowListItem, FlowStatus } from '$lib/types/flows';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import BuildTopbar from './BuildTopbar.svelte';

const FLOWS: FlowListItem[] = ['flow-1', 'flow-2'].map((id) => ({
	id,
	name: id,
	description: '',
	status: 'draft',
	version: '1',
	node_count: 1,
	last_saved_at: null,
	updated_at: '2026-08-09T00:00:00Z'
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

function render(on: { onNew: () => void; onSelect: (id: string) => void }) {
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(BuildTopbar, {
		target: host,
		props: {
			name: 'Claim summariser',
			status: 'draft' as FlowStatus,
			nodeCount: 1,
			saveLabel: 'saved',
			saving: false,
			flows: FLOWS,
			currentId: 'flow-1',
			challengeId: 'ch-1',
			challengeClosed: false,
			flowLoaded: true,
			readOnly: false,
			chatBusy: false,
			submitting: false,
			running: false,
			historyOpen: false,
			canUndo: false,
			canRedo: false,
			onRename: () => {},
			onSelect: on.onSelect,
			onNew: on.onNew,
			onSubmit: () => {},
			onTestRun: () => {},
			onToggleHistory: () => {},
			onUndo: () => {},
			onRedo: () => {}
		}
	}) as Record<string, unknown>;
	flushSync();
}

describe('/build toolbar in a narrow bar', () => {
	it('the ⋯ menu carries a working flow picker and "New flow"', () => {
		const onNew = vi.fn();
		const onSelect = vi.fn();
		render({ onNew, onSelect });
		const panel = host.querySelector('#build-more-menu')!;
		const newFlow = panel.querySelector<HTMLButtonElement>('.menu-newflow');
		const picker = panel.querySelector<HTMLSelectElement>('.menu-picker');
		expect(newFlow?.textContent?.trim()).toBe('build_new_flow');
		expect(picker?.getAttribute('aria-label')).toBe('build_flow_picker_aria');
		expect([...picker!.options].map((o) => o.value)).toEqual(['flow-1', 'flow-2']);

		newFlow!.click();
		expect(onNew).toHaveBeenCalledTimes(1);
		picker!.value = 'flow-2';
		picker!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(onSelect).toHaveBeenCalledWith('flow-2');
	});

	it('⛔ the bar is sized by its own width and sheds "New flow" and the picker before Submit', () => {
		const src = readFileSync(resolve(process.cwd(), 'src/lib/components/build/BuildTopbar.svelte'), 'utf8');
		const css = src.slice(src.indexOf('<style>'));
		expect(css, 'the bar is not a size container — its queries would never fire').toMatch(
			/\.topbar\s*\{[^}]*container-type:\s*inline-size/
		);
		const tier1 = css.match(/@container \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n\t\}/);
		expect(tier1, 'no container query on the bar').toBeTruthy();
		// ⛔ 2026-10-14, measured live: a 900px window with the sidebar as /build leaves it (64px rail)
		// is an 836px bar = an 800px CONTENT box (container queries see the content box). With tier 1
		// at 760px, nl/fr/pl/es all pushed Submit past the window (nl ended at 923px). Tier 1 must
		// cover that bar, so the longest locales shed "New flow" there.
		expect(Number(tier1![1])).toBeGreaterThanOrEqual(800);
		expect(tier1![2]).toMatch(/\.newflow-inline\s*\{\s*display:\s*none/);
		expect(tier1![2]).toMatch(/\.menu-newflow\s*\{\s*display:\s*block/);
		// Submit is never the thing that gives way.
		expect(css).not.toMatch(/@container[\s\S]*\.(btn-primary|submit-wrap)\s*\{[^}]*display:\s*none/);
	});

	it('⛔ only the title gives up width: `.right` (Run, ⋯, Submit) never shrinks', () => {
		// Flex shrinks items in proportion to their basis, so a shrinkable `.right` was squeezed
		// ALONGSIDE the title long before the title reached its floor; its children are all
		// `flex-shrink: 0`, so Submit simply overflowed `.right` and was clipped (nl, 900px: title
		// still 220px wide, Submit ending at 923px).
		const src = readFileSync(resolve(process.cwd(), 'src/lib/components/build/BuildTopbar.svelte'), 'utf8');
		const css = src.slice(src.indexOf('<style>'));
		const rightRules = [...css.matchAll(/(?:^|\n)\t([^\n{}@]*\.right\b[^\n{}]*)\{([^}]*)\}/g)]
			.filter((r) => /(^|,\s*)\.right\s*$/m.test(r[1]!.trim()) || r[1]!.split(',').some((x) => x.trim() === '.right'))
			.map((r) => r[2]!)
			.join('\n');
		expect(rightRules, 'no rule for .right found').not.toBe('');
		expect(rightRules).toMatch(/flex-shrink:\s*0/);
		expect(rightRules).not.toMatch(/flex-shrink:\s*1/);
		expect(rightRules).not.toMatch(/min-width:\s*0/);
	});

	it('Submit carries a short label for a very narrow bar; the full label stays its text', () => {
		render({ onNew: () => {}, onSelect: () => {} });
		const submit = host.querySelector<HTMLButtonElement>('.submit-wrap .btn-primary')!;
		// The full label is the button's text, so its accessible name and every test that finds
		// Submit by text are unchanged; the short one is only a paint-time substitute.
		expect(submit.textContent?.trim()).toBe('build_submit_solution');
		expect(submit.dataset.short).toBe('build_submit_short');

		const src = readFileSync(resolve(process.cwd(), 'src/lib/components/build/BuildTopbar.svelte'), 'utf8');
		const css = src.slice(src.indexOf('<style>'));
		const tiers = [...css.matchAll(/@container \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n\t\}/g)];
		const shortTier = tiers.find((t) => /::after\s*\{[^}]*attr\(data-short\)/.test(t[2]!));
		expect(shortTier, 'no container query paints the short label').toBeTruthy();
		// A 768px window with the full sidebar opened by hand is a 484px content box; fr and pl
		// overflowed it by 2–6px with the full label.
		expect(Number(shortTier![1])).toBeGreaterThanOrEqual(484);
		// Empty alt text on the generated content, or the name would be read as "<full> <short>".
		expect(shortTier![2]).toMatch(/content:\s*attr\(data-short\)\s*\/\s*(''|"")/);
		// The full label is visually hidden there, never removed (`display: none` would drop it from
		// the accessible name).
		expect(shortTier![2]).not.toMatch(/\.submit-label\s*\{[^}]*display:\s*none/);
	});

	it('every locale has a short Submit label that is a word of its full label', () => {
		for (const loc of ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he']) {
			const cat = JSON.parse(readFileSync(resolve(process.cwd(), `messages/${loc}.json`), 'utf8')) as Record<string, string>;
			const short = cat.build_submit_short;
			expect(short, `${loc}: build_submit_short missing`).toBeTruthy();
			// WCAG 2.5.3: what is on screen must be part of the accessible name (the full label).
			expect(cat.build_submit_solution!.toLocaleLowerCase(loc), loc).toContain(short!.toLocaleLowerCase(loc));
			expect(short!.length, loc).toBeLessThan(cat.build_submit_solution!.length);
		}
	});
});
