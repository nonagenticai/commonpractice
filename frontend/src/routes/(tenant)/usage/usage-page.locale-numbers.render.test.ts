// @vitest-environment jsdom
//
// src/routes/(tenant)/usage/usage-page.locale-numbers.render.test.ts — /usage counts and dates
// itself in the APP's locale, not the browser's.
//
// ⛔ TWO DEFECTS ON ONE SCREEN, and this page is where both were most expensive because it is the
// one a tenant admin reads to decide what they are spending.
//   · the stat cards ran `num()` = `n.toLocaleString()` — the RUNTIME's locale. In a Dutch UI on an
//     English machine 1234567 calls read "1,234,567" where Dutch reads "1.234.567"; ',' is the
//     Dutch DECIMAL separator, so the grouping is not merely foreign, it is misleading.
//   · the calls/day chart tooltip ran `toLocaleDateString([], { …, timeZone: 'UTC' })`. The UTC
//     half was already right and stayed right; `[]` is not "no preference", it is the runtime
//     again, so the tooltip said "Aug 7" over an otherwise Dutch card.
//
// ⚠️ THE REAL LOCALE STORE, NOT A STUB. A stubbed `{ current: 'nl' }` would prove the page passes
// SOMETHING; what needs pinning is that it passes the rune paraglide's `getLocale()` is bound to,
// which is what keeps a figure and the label above it in one reactive graph.
//
// ⚠️ NON-VACUITY. This runtime's locale is neither Dutch nor anything that groups with '.', so the
// pre-fix expression yields '1,234,567' and 'Aug 7' here — exactly the strings asserted ABSENT
// below. The fixture figures are all ≥ 1000 for the same reason: no locale inserts a separator
// under that, so a smaller number would let this file pass against its own defect.
//
// ⚠️ THE UTC BEHAVIOUR IS NOT RE-DRIVEN HERE. This machine sits at a positive UTC offset, so
// dropping `timeZone: 'UTC'` would still print the 7th and any assertion about it would be
// vacuous. It is driven properly, through a real negative offset, in
// $lib/utils/format.locale.test.ts — the right place for a timezone claim.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TenantUsage } from '$lib/types/admin';
import { locale } from '$lib/stores/locale.svelte';

// Message stub built from the real `en` catalog: every key resolves to its own name, so nothing
// asserts on wording and a key the page invents but never adds fails loudly as
// "undefined is not a function". Same technique as cadence-strip.phase-days.render.test.ts.
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

const { currentTenant, usage } = vi.hoisted(() => ({
	currentTenant: vi.fn(),
	usage: vi.fn()
}));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the page imports and silently does nothing.
vi.mock('$lib/api/admin', () => ({
	adminApi: { currentTenant, usage },
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	currentTenant.mockResolvedValue({ tenant: { id: 't-1', name: 'Acme', slug: 'acme' } });
	// jsdom lays nothing out, so every rect is 0×0 and `(clientX - left) / width` is NaN — the
	// hover index would be NaN and the tooltip would never render, quietly turning the chart half
	// of this file into no assertion at all. A 100px-wide box is the smallest honest fix.
	Element.prototype.getBoundingClientRect = function () {
		return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0 } as DOMRect;
	};
});
afterEach(() => {
	Element.prototype.getBoundingClientRect = realRect;
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// ⚠️ Assigned directly, never through `locale.set()`: that method fires an authFetch PATCH to
	// /api/me/locale, which the fail-loud fetch stub in lib/test/setup.ts would name.
	locale.current = initialLocale;
	vi.clearAllMocks();
});

/** All four figures are ≥ 1000 so that every locale in the catalogue actually groups them. */
function payload(): TenantUsage {
	return {
		rangeDays: 30,
		stats: {
			spendUsd: 12.5,
			calls: 1234567,
			models: 1207,
			members: 1207,
			// No flat and no legacy rows → `estimated` is false, so the spend figures are not hedged
			// and the "legacy pricing" notice stays off. Neither is what this file is about.
			pricing: { provider: 3, table: 0, flat: 0, legacy: 0 }
		},
		byModel: [],
		// Two buckets: `dayPoints` needs ≥ 2 to render a polyline, and the hover index is derived
		// from the pointer position across them.
		byDay: [
			{ day: '2026-08-07T00:00:00.000Z', calls: 1207, spendUsd: 6.0 },
			{ day: '2026-08-08T00:00:00.000Z', calls: 400, spendUsd: 6.5 }
		],
		byMember: [{ userId: 'u-1', name: 'Sam', calls: 1207, spendUsd: 12.5 }]
	};
}

async function render() {
	usage.mockResolvedValue(payload());
	const { default: UsagePage } = await import('./+page.svelte');
	app = mount(UsagePage, { target: host, props: {} });
	// Two awaited calls in `load()`; drain until the loading notice clears rather than counting
	// ticks — a fixed number of awaits leaves the page on `admin_loading` and every assertion
	// below becomes vacuous.
	for (let i = 0; i < 20 && host.textContent?.includes('admin_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(host.textContent, 'the page never left its loading state').not.toContain('admin_loading');
	return host;
}

/** Move the pointer to the LEFT edge of the calls/day chart → bucket 0, the 7th of August. */
function hoverFirstBucket(el: HTMLElement) {
	const wrap = el.querySelector('.spark-wrap') as HTMLElement;
	expect(wrap, 'the calls/day chart did not render — the fixture never reached it').toBeTruthy();
	wrap.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, bubbles: true }));
	flushSync();
}

const statValues = (el: HTMLElement) =>
	[...el.querySelectorAll('.stats .stat-value')].map((n) => n.textContent);

describe('/usage counts in the reader’s language', () => {
	it('THE DUTCH CASE: the stat cards group with "." and the English form is nowhere on the page', async () => {
		locale.current = 'nl';
		const el = await render();

		// Card 1 is spend (`usdMaybe`, its own formatter and its own tests); cards 2–4 are `num()`.
		expect(statValues(el).slice(1)).toEqual(['1.234.567', '1.207', '1.207']);
		// ⛔ The assertion that inverts on a revert to `n.toLocaleString()`.
		expect(el.textContent).not.toContain('1,234,567');
		expect(el.textContent).not.toContain('1,207');
		// The by-member table is the same figure through the same helper, not a second code path
		// someone forgot.
		expect(el.querySelector('.trow')!.textContent).toContain('1.207');
	});

	it('the same payload in English groups with "," — the helper reads the tag, it does not hard-code one', async () => {
		locale.current = 'en';
		const el = await render();
		expect(statValues(el).slice(1)).toEqual(['1,234,567', '1,207', '1,207']);
		expect(el.textContent).not.toContain('1.234.567');
	});
});

describe('the calls/day tooltip dates itself in the reader’s language', () => {
	it('THE DUTCH CASE: "7 aug", not "Aug 7" — day and month on the other side', async () => {
		locale.current = 'nl';
		const el = await render();
		hoverFirstBucket(el);

		const tip = el.querySelector('.tip');
		expect(tip, 'the tooltip did not open — the hover never resolved to a bucket').toBeTruthy();
		expect(tip!.querySelector('.tip-time')!.textContent).toBe('7 aug');
		// ⛔ Not merely different words: a different ORDER. This is the string the pre-fix
		// `toLocaleDateString([], …)` produced on this runtime.
		expect(el.textContent).not.toContain('Aug 7');
		// …and the calls figure inside the same tooltip is grouped the Dutch way.
		expect(tip!.textContent).toContain('1.207');
	});

	it('…and "Aug 7" in English', async () => {
		locale.current = 'en';
		const el = await render();
		hoverFirstBucket(el);
		expect(el.querySelector('.tip .tip-time')!.textContent).toBe('Aug 7');
	});

	it('re-formats ON THE SWITCH, without a refetch', async () => {
		// ⛔ WHY THE HELPERS TAKE AN ARGUMENT READ IN THE MARKUP RATHER THAN IMPORTING THE STORE.
		// `locale.current` is the rune paraglide's `getLocale()` is rebound onto
		// (stores/locale.svelte.ts:125); reading it at the call site puts these figures in the same
		// reactive graph as the labels beside them. Nothing refetches here — `usage` is asserted to
		// have been called once — so re-evaluation of the formatters is the only thing that can
		// have changed the DOM.
		locale.current = 'en';
		const el = await render();
		hoverFirstBucket(el);
		expect(statValues(el).slice(1)).toEqual(['1,234,567', '1,207', '1,207']);
		expect(el.querySelector('.tip .tip-time')!.textContent).toBe('Aug 7');

		locale.current = 'nl';
		flushSync();

		expect(statValues(el).slice(1)).toEqual(['1.234.567', '1.207', '1.207']);
		expect(el.querySelector('.tip .tip-time')!.textContent).toBe('7 aug');
		expect(usage, 'the page re-formatted, it did not reload').toHaveBeenCalledTimes(1);
	});
});
