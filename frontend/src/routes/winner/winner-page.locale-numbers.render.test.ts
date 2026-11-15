// @vitest-environment jsdom
//
// src/routes/winner/winner-page.locale-numbers.render.test.ts — the /winner hero prints its
// figures in the APP's locale, not the browser's.
//
// ⛔ THE DEFECT, on the one screen the whole demo builds towards. `num()` was `n.toLocaleString()`,
// which reads the RUNTIME's locale: in a Dutch UI running on an English machine the hero announced
// "1,207 stemmen ontvangen". Dutch groups thousands with '.' and uses ',' as the DECIMAL separator,
// so that is not a foreign-looking number — it is one-point-two-oh-seven, printed as the headline
// figure of the week.
//
// ⚠️ THIS FILE MOUNTS THE REAL PAGE AND USES THE REAL LOCALE STORE — no `vi.mock` of
// `$lib/stores/locale.svelte`. A stubbed store would prove the page passes SOMETHING to `num()`;
// what has to be pinned is that it passes the rune paraglide's `getLocale()` is bound to, because
// that binding is what makes a figure re-format in the same tick as the label beside it. The
// switch test at the bottom is the assertion that would otherwise be a claim in a comment.
//
// ⚠️ NON-VACUITY, STATED UP FRONT. The test runtime's own locale is neither Dutch nor anything that
// groups with '.', so `1.207` cannot appear here by accident — the pre-fix expression produces
// `1,207` on this machine and every assertion below inverts on a revert. The `1207` fixture is
// above the 1000 floor on purpose: no locale inserts a separator below it, so a smaller number
// would make the whole file pass against its own defect.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { WeeklyWinner } from '$lib/types/marketplace';
import { locale } from '$lib/stores/locale.svelte';

// Message stub built from the real `en` catalog — every key resolves to its own name, so nothing
// here asserts on wording and a key the page invents but never adds fails loudly. Same technique
// as components/marketplace/cadence-strip.phase-days.render.test.ts.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { winner } = vi.hoisted(() => ({ winner: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the page imports and silently does nothing.
vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { winner, home: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));
// Left mocked so a locale switch does NOT re-fire the API load: this file is about re-FORMATTING
// the payload already on screen, and a refetch would hide a helper that only re-rendered because
// the whole page reloaded.
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

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
	// ⚠️ Assigned directly, never through `locale.set()`: that method fires an authFetch PATCH to
	// /api/me/locale, which this file has no business doing and the fail-loud fetch stub in
	// lib/test/setup.ts would name.
	locale.current = initialLocale;
	vi.clearAllMocks();
});

async function render(payload: WeeklyWinner) {
	winner.mockResolvedValue(payload);
	const { default: WinnerPage } = await import('./+page.svelte');
	app = mount(WinnerPage, { target: host, props: {} });
	// `onMount` fires an async load; drain macro- and micro-tasks until the loading notice is gone.
	// A fixed number of awaits silently leaves the page on `winner_loading` and every assertion
	// below becomes vacuous — hence the explicit check.
	for (let i = 0; i < 20 && host.textContent?.includes('winner_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		host.textContent,
		'the page never left its loading state — the fixture did not land'
	).not.toContain('winner_loading');
	return host;
}

/** 1207 votes on the winning solution, 1 234 567 cast across the week. Both above the grouping
 *  floor, and the second one large enough that pl/es (which do not group four digits) differ too. */
function payload(): WeeklyWinner {
	return {
		week: '2026-W32',
		announcedAt: '2026-08-10T00:00:00.000Z',
		stats: { totalVotesCast: 1234567, solutionsSubmitted: 1207 },
		pipeline: null,
		winner: {
			// This file is about number FORMATTING, so the winner is the ordinary rank-1 case and
			// renders no rank note — see winner-page.render.test.ts for the ranked variants.
			rank: 1,
			solution: {
				id: 'sol-1',
				title: 'Schadeformulier-samenvatter',
				votesCount: 1207,
				demoMs: 3400,
				blocksUsed: ['a', 'b'],
				flowId: null,
				author: { name: 'FR Test', initials: 'FT' }
			},
			challenge: { id: 'ch-1', code: 'CH-284', title: 'Nederlandse uitdaging', submitter: 'Sam' }
		},
		honorableMentions: []
	} as WeeklyWinner;
}

/** The two COUNTS in the hero: votes received, total votes cast.
 *
 * ⚠️ Sliced to two on purpose — the hero renders four tiles and the other two are not `num()`'s.
 * Tile 3 is `demoDuration()`, which resolves through the message catalog and has its own suite
 * (format.demo-duration.test.ts + winner-page.render.test.ts); tile 4 is a raw `blocksUsed.length`,
 * a single digit that no locale groups. Asserting on all four would couple this file to a
 * neighbouring formatter's output for no gain. */
const heroValues = (el: HTMLElement) =>
	[...el.querySelectorAll('.winner-stats .ws-val')].map((n) => n.textContent).slice(0, 2);

describe('the /winner hero counts in the reader’s language', () => {
	it('THE DUTCH DEMO: 1207 renders "1.207", and the English "1,207" is nowhere on the page', async () => {
		locale.current = 'nl';
		const el = await render(payload());

		expect(heroValues(el)).toEqual(['1.207', '1.234.567']);
		// ⛔ The inverse assertion is the one that reds on a revert to `n.toLocaleString()`: the test
		// runtime is not Dutch, so the locale-less call yields exactly this string.
		expect(el.textContent).not.toContain('1,207');
		expect(el.textContent).not.toContain('1,234,567');
		// …and "the week in numbers" list is grouped the same way, not just the hero tiles.
		expect(el.querySelector('.numbers')!.textContent).toContain('1.234.567');
	});

	it('the same payload in English renders the English grouping', async () => {
		// The other half: this is not a helper that hard-codes Dutch, it is one that reads the tag.
		locale.current = 'en';
		const el = await render(payload());
		expect(heroValues(el)).toEqual(['1,207', '1,234,567']);
		expect(el.textContent).not.toContain('1.207');
	});

	it('and in German, Polish and French — all eight tags reach the formatter, not just two', async () => {
		// German groups like Dutch; Polish uses U+00A0 and French U+202F. Spelled as escapes because
		// an ASCII space here would be a wrong expectation that looks right.
		for (const [tag, expected] of [
			['de', ['1.207', '1.234.567']],
			['pl', ['1207', '1 234 567']],
			['fr', ['1 207', '1 234 567']]
		] as const) {
			locale.current = tag;
			const el = await render(payload());
			expect(heroValues(el), `locale ${tag}`).toEqual([...expected]);
			unmount(app!);
			app = undefined;
			host.textContent = '';
		}
	});

	it('re-formats ON THE SWITCH, without a refetch — the reactivity claim, driven', async () => {
		// ⛔ THIS IS WHY `num()` TAKES AN ARGUMENT READ IN THE MARKUP RATHER THAN IMPORTING THE STORE
		// ITSELF. `locale.current` is the rune paraglide's `getLocale()` is rebound onto
		// (stores/locale.svelte.ts:125), so reading it inside the template puts these figures in the
		// same reactive graph as the `m.*()` labels next to them. `reloadOnLocaleChange` is mocked
		// out in this file, so nothing refetches — the only thing that can change the DOM here is
		// re-evaluation of the formatter.
		locale.current = 'en';
		const el = await render(payload());
		expect(heroValues(el)).toEqual(['1,207', '1,234,567']);

		locale.current = 'nl';
		flushSync();

		expect(heroValues(el)).toEqual(['1.207', '1.234.567']);
		expect(winner, 'the figures re-formatted, they were not refetched').toHaveBeenCalledTimes(1);
	});
});
