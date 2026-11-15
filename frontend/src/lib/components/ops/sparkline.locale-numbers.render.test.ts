// @vitest-environment jsdom
//
// src/lib/components/ops/sparkline.locale-numbers.render.test.ts — the /it-dash health sparkline
// spells its y-axis peak the same way as the tooltip that explains it.
//
// ⛔ THE DEFECT, AND IT WAS VISIBLE ON ONE PANEL AT ONCE. `max` is an un-annotated
// `$derived(Math.max(1, …))`, which is a shape `$lib/test/number-sites` could not see at all, so
// the axis label `{max}` was never classified and never grouped. Thirteen lines below it, the hover
// tooltip printed the SAME two figures through `num()`. On the live Dutch /it-dash with a 4-digit
// peak the axis read "1207" while the tooltip immediately under it read "1.207" — one panel, two
// spellings of one number, in the popup whose whole job is to explain that axis.
//
// ⚠️ A RENDER SPEC, NOT A SOURCE-TEXT PIN. The site guard in `$lib/i18n/icu-number-params.sites`
// pins the mustache as a string, which reds on a revert but proves nothing about what a reader
// sees; `dataset-preview.locale-numbers.render.test.ts` records why that is not enough ("THE REAL
// COMPILED MESSAGES, NOT THE KEY-NAME STUB"). This file mounts the component and reads the DOM.
//
// ⚠️ NON-VACUITY. The fixture peak is 1207 — four digits, above the grouping floor in every locale
// — and this runtime's own locale is neither Dutch nor German, so "1.207" cannot appear by
// accident: the pre-fix expression renders exactly "1207" and every assertion below inverts on a
// revert. The axis and the tooltip are compared to EACH OTHER as well as to a literal, because
// "both wrong in the same way" is the one failure a single-sided assertion would call a pass.
//
// ⚠️ `ForeachNode.svelte`'s badge — the third site of this fix — has no spec here and cannot get
// one: mounting it standalone throws `Handle must be used within a Custom Node component`, because
// @xyflow/svelte's `Handle` reads a node context that only the flow renderer provides. That is a
// real limitation of the library, not a gap in the fix; that site is held by the call-site pin in
// `icu-number-params.sites.test.ts`, which reds by name on a revert.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { HealthBucket } from '$lib/types/ops';
import type { BlockUsagePoint } from '$lib/types/blocks';
import { locale } from '$lib/stores/locale.svelte';
import Sparkline from './Sparkline.svelte';
import BlockUsageTrend from '$lib/components/block-edit/BlockUsageTrend.svelte';

/** Two hours of a busy platform. The peak is the figure the axis must label. */
const PEAK = 1207;
const buckets: HealthBucket[] = [
	{ hourTs: '2026-08-15T09:00:00.000Z', activeRuns: 640, llmCalls: 88 },
	{ hourTs: '2026-08-15T10:00:00.000Z', activeRuns: PEAK, llmCalls: 42 }
];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never via `locale.set()`: that PATCHes /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name. Same reason as the dataset-preview spec.
	locale.current = initialLocale;
});

function render(data: HealthBucket[] = buckets) {
	app = mount(Sparkline, { target: host, props: { buckets: data } });
	flushSync();
	const axis = host.querySelector('.axis-max');
	expect(axis, 'the axis label did not render — the fixture never reached it').toBeTruthy();
	return axis as HTMLElement;
}

/**
 * Hover the middle of the chart and return the tooltip's two figures.
 *
 * jsdom gives every element a zero-size box, so `onMove`'s `getBoundingClientRect()` would make the
 * hovered index NaN and no tooltip would ever open. The rect is stubbed to a real 100px-wide strip
 * — the ONLY thing faked here; the component's own arithmetic then picks the bucket.
 */
function hoverLastBucket(): string[] {
	const wrap = host.querySelector('.spark-wrap') as HTMLElement;
	wrap.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	wrap.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, bubbles: true }));
	flushSync();
	const tip = host.querySelector('.tip');
	expect(tip, 'the hover tooltip did not open — the rect stub or the bucket maths changed').toBeTruthy();
	return [...tip!.querySelectorAll('.tip-row b')].map((b) => b.textContent ?? '');
}

describe('the it-dash sparkline labels its axis in the reader’s language', () => {
	it('⛔ THE DUTCH CASE: the axis reads "1.207" and the raw "1207" is nowhere in it', () => {
		locale.current = 'nl';
		const axis = render();

		expect(axis.textContent).toBe('1.207');
		// The assertion that reds on a revert to `{max}`: the un-fixed component prints exactly this.
		expect(axis.textContent).not.toBe('1207');
	});

	it('⛔ THE AXIS AND THE TOOLTIP AGREE — the defect was that they did not', () => {
		locale.current = 'nl';
		const axis = render();
		const [runs] = hoverLastBucket();

		// Both sides of the contradiction, in one assertion. Before the fix the axis said "1207"
		// and this tooltip row said "1.207", thirteen lines apart in the same component.
		expect(runs).toBe('1.207');
		expect(axis.textContent).toBe(runs);
	});

	it('English groups the same peak with "," — the site reads the tag, it does not hard-code one', () => {
		locale.current = 'en';
		expect(render().textContent).toBe('1,207');
	});

	it('re-groups ON THE SWITCH — the axis is in the same reactive graph as the tooltip', () => {
		// `locale.current` is read in the markup, not inside a helper that imports the store, which
		// is what puts the figure in paraglide's reactive graph. This component fetches nothing, so
		// nothing but re-evaluation can have changed the text.
		locale.current = 'en';
		const axis = render();
		expect(axis.textContent).toBe('1,207');

		locale.current = 'nl';
		flushSync();

		expect(axis.textContent).toBe('1.207');
	});

	it('the degenerate inputs still render — `num()` did not introduce a crash', () => {
		// ⛔ `Math.max(1, ...[])` IS THE FLOOR, NOT `-Infinity`, and the axis must survive an empty
		// 24h window: /it-dash renders this panel before the first bucket exists.
		locale.current = 'nl';
		expect(render([]).textContent).toBe('1');
		unmount(app!);
		app = undefined;
		host.textContent = '';

		// A NaN peak reads "NaN" — unchanged from the raw `{max}` it replaced. Pinned so that
		// `num()`'s null/undefined branch is never quietly widened into swallowing a bad figure as
		// an em dash, which would hide a broken payload instead of showing it.
		const broken: HealthBucket[] = [{ hourTs: '2026-08-15T09:00:00.000Z', activeRuns: NaN, llmCalls: 3 }];
		expect(render(broken).textContent).toBe('NaN');
	});
});

describe('the block-edit usage trend labels its axis the same way — the twin of the same defect', () => {
	// `BlockUsageTrend.svelte` says in its own header that it is modelled on `ops/Sparkline.svelte`,
	// and it inherited the raw axis verbatim. It is a separate component on a different screen
	// (block-edit → Usage stats), so it gets its own mount rather than sharing the fixture above.
	it('⛔ the axis and the grouped tooltip agree in Dutch', () => {
		locale.current = 'nl';
		const points: BlockUsagePoint[] = [
			{ day: '2026-08-14', runs: 12 },
			{ day: '2026-08-15', runs: PEAK }
		];
		app = mount(BlockUsageTrend, { target: host, props: { points } });
		flushSync();

		const axis = host.querySelector('.axis-max');
		expect(axis, 'the trend did not render — `total === 0` short-circuits the whole chart').toBeTruthy();
		expect(axis!.textContent).toBe('1.207');

		// The tooltip beside it, through the same hover path, reading the grouped ICU message.
		const wrap = host.querySelector('.spark-wrap') as HTMLElement;
		wrap.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		wrap.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, bubbles: true }));
		flushSync();

		expect(host.querySelector('.tip-row')?.textContent).toContain('1.207');
	});
});
